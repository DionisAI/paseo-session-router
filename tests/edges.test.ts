import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, principal, code } from './helpers.js';
import { execute } from '../src/tools.js';
const muse = principal('muse', { scopes: ['read', 'submit', 'cancel'] });
test('edges: a turn waiting for an answer can be cancelled, and one waiting past the approval timeout is cancelled by the Router', async (t) => {
    const f = await fixture(); t.after(f.close);
    const demo = f.demos.get('gpu-research')!, s = f.session();
    const stuck = f.submit('aws dynamodb list-tables', muse), behind = f.submit('next check', muse);
    await f.router.tick(); demo.permission('agent-1', { tool: 'Bash', detail: 'aws dynamodb delete-table --table-name x' }); await f.router.tick();
    assert.equal(f.store.task(stuck.id)!.state, 'waiting_permission'); assert.ok(f.store.task(stuck.id)!.waitingSince);
    assert.equal(f.store.task(behind.id)!.state, 'queued');
    f.router.setPolicy(principal(), { approvalTimeoutMs: 600000 });
    f.advance(500000); await f.router.tick(); assert.equal(f.store.task(stuck.id)!.state, 'waiting_permission');
    f.advance(100001); await f.router.tick();
    const expired = f.store.task(stuck.id)!;
    assert.equal(expired.state, 'canceled'); assert.match(expired.completionEvidence!, /審批等了超過 10 分鐘/);
    await f.router.tick(); await f.router.tick();
    assert.notEqual(f.store.task(behind.id)!.state, 'queued');
    // the assigning client cancels a waiting turn itself
    demo.permission('agent-1', { tool: 'Bash', detail: 'rm -rf /tmp/x' }); await f.router.tick();
    assert.equal(f.store.task(behind.id)!.state, 'waiting_permission');
    await f.router.cancel(muse, behind.id); await f.router.tick();
    assert.equal(f.store.task(behind.id)!.state, 'canceled'); assert.match(f.store.task(behind.id)!.completionEvidence!, /Canceled by muse/);
    assert.equal(s.id, f.store.task(behind.id)!.target);
    assert.throws(() => f.router.setPolicy(principal(), { approvalTimeoutMs: 5 }), code('INVALID_ARGUMENT'));
});
test('edges: a task that has not been sent moves to another session; running tasks, replies and other clients\' tasks do not', async (t) => {
    const f = await fixture(); t.after(f.close);
    const lab = f.session('lab-test');
    const running = f.submit('long job', muse), waiting = f.submit('quick check', muse);
    await f.router.tick();
    assert.equal(f.store.task(waiting.id)!.state, 'queued');
    assert.throws(() => f.router.moveTask(muse, { taskId: running.id, routeTicket: f.ticket(muse, lab.id) }), code('CONFLICT'));
    assert.throws(() => f.router.moveTask(principal('grokbot', { scopes: ['read', 'submit'] }), { taskId: waiting.id, routeTicket: f.ticket(principal('grokbot', { scopes: ['read', 'submit'] }), lab.id) }), code('FORBIDDEN'));
    const moved = f.router.moveTask(muse, { taskId: waiting.id, routeTicket: f.ticket(muse, lab.id) });
    assert.deepEqual([moved.target, moved.hostId, moved.state], [lab.id, 'lab3', 'queued']);
    await f.router.tick(); assert.equal(f.store.task(waiting.id)!.state, 'running');
    f.demos.get('gpu-research')!.finish('agent-1', 'done'); await f.router.tick(); await f.router.tick();
    const reply = f.router.reply(muse, { taskId: running.id, prompt: 'and then?', idempotencyKey: 'edge-reply-001' });
    assert.throws(() => f.router.moveTask(muse, { taskId: reply.id, routeTicket: f.ticket(muse, lab.id) }), code('CONFLICT'));
});
test('edges: a quota notice marks the session until a turn there completes, and dispatch to it carries a warning', async (t) => {
    const f = await fixture(); t.after(f.close);
    const demo = f.demos.get('gpu-research')!, s = f.session();
    const first = f.submit('check', muse); await f.router.tick();
    demo.finish('agent-1', "You've hit your weekly limit · resets Oct 29, 5am"); await f.router.tick();
    assert.equal(f.store.task(first.id)!.state, 'failed');
    assert.match(f.router.getSession(muse, s.id).providerLimit!.notice, /weekly limit/);
    await f.router.tick();
    const next = await execute(f.router, muse, 'psr_submit_task', { routeTicket: f.ticket(muse), prompt: 'try again', idempotencyKey: 'edge-quota-002' }) as { id: string; warning?: string };
    assert.match(next.warning!, /額度用完/);
    await f.router.tick(); demo.finish('agent-1', 'all good'); await f.router.tick();
    assert.equal(f.store.task(next.id)!.state, 'completed'); assert.equal(f.router.getSession(muse, s.id).providerLimit, null);
});
test('edges: a turn whose only reply is a transient provider error is sent once more, and only once', async (t) => {
    const f = await fixture(); t.after(f.close);
    const demo = f.demos.get('gpu-research')!;
    const task = f.router.submit(muse, { routeTicket: f.ticket(muse), prompt: 'inventory', idempotencyKey: 'edge-retry-001', missionId: 'm-1', missionPart: '盤點' });
    await f.router.tick();
    demo.finish('agent-1', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'); await f.router.tick();
    assert.equal(f.store.task(task.id)!.state, 'failed'); assert.match(f.store.task(task.id)!.completionEvidence!, /transient/);
    await f.router.tick();
    const retry = f.store.tasks().find(x => x.retryOf === task.id)!;
    assert.ok(retry); assert.deepEqual([retry.prompt, retry.missionId, retry.missionPart, retry.originClientId, retry.target], ['inventory', 'm-1', '盤點', 'muse', task.target]);
    await f.router.tick(); demo.finish('agent-1', 'API Error: 529 Overloaded'); await f.router.tick(); await f.router.tick(); await f.router.tick();
    assert.equal(f.store.task(retry.id)!.state, 'failed'); assert.equal(f.store.tasks().filter(x => x.retryOf).length, 1);
    // a real answer that mentions an error is not a transient failure
    const ok = f.submit('explain', muse); await f.router.tick(); await f.router.tick();
    demo.finish('agent-1', 'The deploy hit API Error: 500 yesterday; I fixed the handler and the tests pass now.'); await f.router.tick();
    assert.equal(f.store.task(ok.id)!.state, 'completed');
});
test('edges: a cancel whose turn_canceled event was lost settles once the session shows that turn is gone', async (t) => {
    const f = await fixture(); t.after(f.close);
    const demo = f.demos.get('gpu-research')!;
    // like Paseo: lifecycle events are not in the history, and this one is lost live
    const history = demo.history.bind(demo); demo.history = async (s, c) => (await history(s, c)).filter(e => !e.type.startsWith('turn_'));
    const task = f.submit('long check', muse); await f.router.tick();
    demo.dropLive = true;
    await f.router.cancel(muse, task.id); await f.router.tick();
    assert.equal(f.store.task(task.id)!.state, 'cancel_requested');
    await f.router.tick(); assert.equal(f.store.task(task.id)!.state, 'cancel_requested'); // seen inactive once: a late native event may still come
    f.advance(20001); await f.router.tick();
    const settled = f.store.task(task.id)!;
    assert.equal(settled.state, 'canceled'); assert.match(settled.completionEvidence!, /turn_canceled event was not received/);
    demo.dropLive = false; await f.router.tick(); await f.router.tick();
    assert.equal(f.store.task(task.id)!.lockHeld, false);
});
test('edges: a turn whose end event was lost ends as Paseo recorded it: completed with its recovered reply, or failed with Paseo\'s error', async (t) => {
    const f = await fixture(); t.after(f.close);
    const demo = f.demos.get('gpu-research')!, lab = f.demos.get('lab-test')!;
    for (const d of [demo, lab]) { const history = d.history.bind(d); d.history = async (s, c) => (await history(s, c)).filter(e => !e.type.startsWith('turn_')); }
    const ok = f.submit('inventory', muse), bad = f.submit('upgrade', muse, f.session('lab-test').id);
    await f.router.tick();
    demo.dropLive = true; lab.dropLive = true;
    demo.finish('agent-1', 'Node 22.20 on all hosts'); lab.finish('agent-1', 'starting'); lab.sessions.get('agent-1')!.lastError = 'Provider process exited with code 1';
    await f.router.tick(); await f.router.tick();
    assert.deepEqual([f.store.task(ok.id)!.state, f.store.task(bad.id)!.state], ['running', 'running']);
    f.advance(20001); await f.router.tick();
    const done = f.store.task(ok.id)!, failed = f.store.task(bad.id)!;
    assert.equal(done.state, 'completed'); assert.equal(done.resultSummary, 'Node 22.20 on all hosts'); assert.match(done.completionEvidence!, /Inferred turn_completed .* event was not received/);
    assert.equal(failed.state, 'failed'); assert.match(failed.completionEvidence!, /Paseo reports its error/); assert.match(failed.resultSummary!, /starting|exited with code 1/);
    // a native event that arrives before the second look wins
    demo.dropLive = false;
    const late = f.submit('one more', muse); await f.router.tick(); await f.router.tick();
    demo.dropLive = true; demo.finish('agent-1', 'late but real'); await f.router.tick();
    demo.dropLive = false; demo.emit('agent-1', 'turn_completed', f.store.task(late.id)!.turnId); await f.router.tick();
    assert.match(f.store.task(late.id)!.completionEvidence!, /^Native turn_completed/);
});
test('edges: the live view gets each tool call of the turn as one masked line, updated in place, and old tasks travel without them', async (t) => {
    const f = await fixture(); t.after(f.close);
    const demo = f.demos.get('gpu-research')!;
    const task = f.submit('check the logs', muse); await f.router.tick();
    const call = demo.step('agent-1', 'shell', 'tail -n 50 /var/log/auth.log', 'running');
    demo.step('agent-1', 'shell', 'export API_TOKEN=abcd1234 && curl -H "Authorization: Bearer xyz" https://x', 'running');
    demo.step('agent-1', 'shell', 'tail -n 50 /var/log/auth.log', 'completed', call);
    demo.step('agent-1', 'shell', 'tail -n 50 /var/log/auth.log', 'running', call); // a stale update never reopens it
    demo.step('agent-1', 'edit', 'src/login.js', 'completed');
    const steps = f.store.task(task.id)!.steps!;
    assert.deepEqual(steps.map(s => [s.kind, s.status]), [['shell', 'completed'], ['shell', 'running'], ['edit', 'completed']]);
    assert.equal(steps[0].text, 'tail -n 50 /var/log/auth.log'); assert.match(steps[1].text, /API_TOKEN=… .*Bearer …/); assert.doesNotMatch(steps[1].text, /abcd1234|xyz/);
    demo.finish('agent-1', 'fixed'); await f.router.tick();
    assert.equal(f.router.listTasks(muse).find(x => x.id === task.id)!.steps!.length, 3);
    f.advance(1800001);
    const old = f.router.listTasks(muse).find(x => x.id === task.id) as { steps?: unknown; stepCount?: number };
    assert.equal(old.steps, undefined); assert.equal(old.stepCount, 3); assert.equal(f.router.getTask(muse, task.id).steps!.length, 3);
});
