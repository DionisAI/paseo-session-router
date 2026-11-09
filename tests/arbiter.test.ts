import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, principal, code } from './helpers.js';
import { arbiterAnswer, checkProfiles, checkableCheckout } from '../src/arbiter.js';
import { classifyRequest } from '../src/policy.js';
import { plannerPrincipal } from '../src/planner.js';
import { visibleTools } from '../src/tools.js';
import { redact, runVerifier } from '../src/util.js';
import type { RouterConfig, Task } from '../src/types.js';

/** Two arbiter seat templates: one on gpu1 (observed channel), one on lab3 (http channel), each with its own checkout. */
const withSeats = (c: RouterConfig) => {
    const gpu = c.daemons.find(d => d.id === 'gpu-research')!, lab = c.daemons.find(d => d.id === 'lab-test')!;
    gpu.mappings.push({ cwd: '/srv/judge', projectId: 'hft', workspaceId: 'judge-gpu', mutationDomainId: 'judge-gpu', releasePolicy: 'on_turn_end' });
    lab.mappings.push({ cwd: '/srv/judge-lab', projectId: 'hft', workspaceId: 'judge-lab', mutationDomainId: 'judge-lab', releasePolicy: 'on_turn_end' });
    gpu.agentChannel = { mode: 'observed' };
    lab.agentChannel = { url: 'http://127.0.0.1:8787/mcp', tokenTtlMs: 3600000 };
    c.templates.push({ id: 'judge-gpu', daemonId: 'gpu-research', cwd: '/srv/judge', provider: 'claude/claude-opus-5-5', title: 'Arbiter gpu1', modeId: 'default', seat: true });
    c.templates.push({ id: 'judge-lab', daemonId: 'lab-test', cwd: '/srv/judge-lab', provider: 'claude/claude-opus-5-5', title: 'Arbiter lab3', modeId: 'default', seat: true });
};
const owner = principal();
const criteria = ['node -v prints v22.20.0'];
const evidence = 'Ran node -v in the checkout on this host; it printed v22.20.0, which is the version the criterion asks for.';
async function verifiedSetup(profile: Record<string, unknown> = { id: 'node-check', commands: ['node -v'] }) {
    const f = await fixture(withSeats);
    f.router.setPolicy(owner, { verification: { profiles: [profile] } });
    const seat = await f.router.createSession(owner, { templateId: 'judge-gpu', idempotencyKey: 'seat-gpu-0001', role: 'arbiter', profileId: profile.id as string });
    const goal = f.router.submitGoal(owner, { text: '把研究機的 Node 升到 22.20', idempotencyKey: 'goal-verify-0001' });
    return { f, seat, goal, demo: f.demos.get('gpu-research')! };
}
const arbiterTurn = (f: Awaited<ReturnType<typeof fixture>>, of: string) => f.store.tasks().find(t => t.routerTurn === 'arbiter' && t.verifyOf === of);
const until = async (ok: () => boolean, ms = 4000) => { for (const end = Date.now() + ms; !ok();) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };

test('arbiter: auto-answers allow reads inside the checked checkout and the exact profile commands, and deny everything else', () => {
    const profile = { id: 'node-check', commands: ['node -v'] }, at = { cwd: '/srv/judge', checkout: '/srv/hft' };
    const bash = (detail: string) => arbiterAnswer({ tool: 'Bash', detail }, profile, at).allow, tool = (name: string, input: unknown) => arbiterAnswer({ tool: name, detail: typeof input === 'string' ? input : JSON.stringify(input) }, profile, at);
    for (const cmd of ["awk '{print $1}' x", 'sed -n 1p x', 'rg --pre cat x y', 'sort -o out x', 'cat a | head', 'nohup ls', 'ls &', 'node -v && rm -rf x', 'node -v; ls', 'npm install left-pad', 'cat .env', 'ls ~/.ssh', 'cat $(echo x)', 'cat `x`', 'grep -r foo . > out',
        // places outside the checked checkout, however they are written
        'cat /srv/other/notes.txt', "cat '/srv/other/notes.txt'", 'tail -n 50 log/app.log', 'ls ..', 'grep -r token /', 'grep -ri token /home/ubuntu', 'cat /srv/judge/../hft/../etc/passwd', 'cat /srv/hft/../hft-queue/x', 'cat /proc/1234/environ', 'cat /home/u/.codex/auth.json', 'cat /home/u/.paseo/daemon-keypair.json', 'grep -f/etc/passwd x', 'wc --files0-from=/etc/passwd', 'ls .'])
        assert.equal(bash(cmd), false, cmd);
    for (const cmd of ['cat README.md', 'ls -la', "grep -n 'a b' file.txt", 'node -v', "bash -lc 'node -v'", 'df -h', 'tail -n 50 /srv/hft/log/app.log', 'ls /srv/hft', 'grep -rn TODO /srv/hft/src', 'grep PSR-PILOT-OK /srv/hft/hello.txt', 'wc -c /srv/hft/hello.txt', 'grep --include=x -r a /srv/hft', "cat '/srv/hft/a b.txt'"])
        assert.equal(bash(cmd), true, cmd);
    assert.equal(tool('Read', { file_path: '/srv/hft/README.md' }).allow, true);
    assert.deepEqual(tool('Read', { file_path: '/srv/other/README.md' }), { allow: false, rule: 'outside-checkout' });
    assert.equal(tool('Read', { file_path: '/srv/hft/.env' }).allow, false);
    assert.equal(tool('Read', { file_path: '/proc/1234/environ' }).allow, false);
    assert.equal(tool('Read', '/srv/hft/README.md').allow, false); // not the JSON input Paseo reports
    assert.equal(tool('Read', JSON.stringify({ file_path: '/srv/hft/' + 'x'.repeat(2000) }).slice(0, 2000) + '…').allow, false); // truncated
    assert.equal(tool('Glob', { pattern: '**/*.ts' }).allow, true); // the seat's own directory
    assert.equal(tool('Glob', { pattern: '/srv/hft/**/*.ts' }).allow, true);
    assert.equal(tool('Glob', { pattern: '/srv/**/*.json' }).allow, false);
    assert.equal(tool('Glob', { pattern: '**/*', path: '/home/u' }).allow, false);
    assert.equal(tool('Grep', { pattern: 'a/b', path: '/srv/hft', glob: '*.ts' }).allow, true);
    assert.equal(tool('Grep', { pattern: 'token', path: '/etc' }).allow, false);
    assert.equal(tool('Edit', { file_path: '/srv/hft/a.ts' }).allow, false);
    assert.deepEqual(tool('mcp__rube__REMOTE_BASH_TOOL', 'cat /srv/hft/a.txt'), { allow: false, rule: 'not-a-read' }); // only real shell tools
    assert.equal(arbiterAnswer({ tool: 'Read', detail: JSON.stringify({ file_path: '/srv/hft/README.md' }) }, profile, { cwd: '/srv/judge', checkout: null }).allow, false); // checked session gone
    assert.equal(bash('node --version'), false); // exact lines only
    assert.throws(() => checkProfiles([{ id: 'Bad Id' }]), code('INVALID_ARGUMENT'));
    assert.throws(() => checkProfiles([{ id: 'x', verifier: { command: 'relative/path', args: [], timeoutMs: 60000 } }]), code('INVALID_ARGUMENT'));
    assert.throws(() => checkProfiles([{ id: 'x', argsPattern: 'unanchored' }]), code('INVALID_ARGUMENT'));
    assert.throws(() => checkProfiles([{ id: 'x' }, { id: 'x' }]), code('INVALID_ARGUMENT'));
});

test('arbiter: seats are the owner\'s and take work only from the Router', async (t) => {
    const f = await fixture(withSeats); t.after(f.close);
    f.router.setPolicy(owner, { verification: { profiles: [{ id: 'node-check', commands: ['node -v'] }] } });
    await assert.rejects(() => f.router.createSession(principal('muse', { scopes: ['read', 'create'] }), { templateId: 'judge-gpu', idempotencyKey: 'seat-x-0001', role: 'arbiter', profileId: 'node-check' }), code('SEAT_TEMPLATE'));
    await assert.rejects(() => f.router.createSession(owner, { templateId: 'judge-gpu', idempotencyKey: 'seat-x-0002' }), code('SEAT_TEMPLATE'));
    await assert.rejects(() => f.router.createSession(owner, { templateId: 'lab-codex', idempotencyKey: 'seat-x-0003', role: 'arbiter', profileId: 'node-check' }), code('INVALID_ARGUMENT'));
    await assert.rejects(() => f.router.createSession(owner, { templateId: 'judge-gpu', idempotencyKey: 'seat-x-0004', role: 'arbiter', profileId: 'no-such-profile' }), code('INVALID_ARGUMENT'));
    const seat = await f.router.createSession(owner, { templateId: 'judge-gpu', idempotencyKey: 'seat-gpu-0001', role: 'arbiter', profileId: 'node-check' });
    assert.deepEqual(f.demos.get('gpu-research')!.channels.get(seat.nativeId), { mode: 'observed', command: 'node', tools: ['psr_verdict'], role: 'arbiter' });
    assert.deepEqual(seat.seat, { role: 'arbiter', profileId: 'node-check' });
    const planner = plannerPrincipal('owner'), goal = f.router.submitGoal(owner, { text: 'x', idempotencyKey: 'goal-seat-0001' });
    for (const p of [owner, principal('muse', { scopes: ['read', 'submit'] })]) assert.throws(() => f.submit('do something', p, seat.id), code('SEAT_ROUTER_ONLY'));
    assert.throws(() => f.router.submit(planner, { routeTicket: f.ticket(planner, seat.id), prompt: 'x', idempotencyKey: 'planner-seat-001', missionId: goal.id }), code('SEAT_ROUTER_ONLY'));
    const queued = f.submit('work', owner); f.submit('more', owner);
    const second = f.store.tasks().find(x => x.prompt === 'more')!;
    assert.throws(() => f.router.moveTask(owner, { taskId: second.id, routeTicket: f.ticket(owner, seat.id) }), code('SEAT_ROUTER_ONLY'));
    assert.ok(queued);
    // the arbiter's channel credential carries only its verdict tool
    const lab = await f.router.createSession(owner, { templateId: 'judge-lab', idempotencyKey: 'seat-lab-0001', role: 'arbiter', profileId: 'node-check' });
    const channel = f.demos.get('lab-test')!.channels.get(lab.nativeId)!; assert(channel.mode === 'http');
    const agent = f.router.agentPrincipal(channel.token);
    assert.deepEqual(agent.scopes, ['arbitrate']); assert.deepEqual(visibleTools(agent).map(x => x.name), ['psr_verdict']);
    assert.throws(() => f.router.postMessage(agent, { text: 'hi' }), code('FORBIDDEN'));
    assert.throws(() => f.router.verdict(agent, { turn: 'abc', decision: 'pass', reasonCode: 'ok', note: 'n', criteria: [] }), code('NO_ACTIVE_TASK'));
});

test('arbiter: a finished task is checked by a seat on its own machine, which answers with a verdict the Router checks', async (t) => {
    const { f, seat, goal, demo } = await verifiedSetup(); t.after(f.close);
    const work = f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'Upgrade Node to 22.20', idempotencyKey: 'v-work-0001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    assert.throws(() => f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'x', idempotencyKey: 'v-nogoal-01', verify: { arbiterId: 'node-check', criteria } }), code('INVALID_ARGUMENT'));
    assert.throws(() => f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'x', idempotencyKey: 'v-noprof-01', missionId: goal.id, verify: { arbiterId: 'nope', criteria } }), code('INVALID_ARGUMENT'));
    await f.router.tick(); demo.finish('agent-1', 'Node upgraded: v22.20.0'); await f.router.tick(); await f.router.tick();
    const turn = arbiterTurn(f, work.id)!;
    assert.ok(turn); assert.equal(turn.target, seat.id); assert.equal(turn.missionId, goal.id); assert.equal(turn.originClientId, 'router');
    assert.equal(f.store.task(work.id)!.verification.status, 'pending');
    assert.match(turn.prompt, new RegExp(`Turn nonce: ${turn.nonce}`)); assert.match(turn.prompt, /0\. node -v prints v22\.20\.0/); assert.match(turn.prompt, /untrusted claim[\s\S]*Node upgraded: v22\.20\.0/);
    // the Router's turns are the owner's and the planner's to see
    assert.throws(() => f.router.getTask(principal('muse', { scopes: ['read', 'submit'] }), turn.id), code('NOT_FOUND'));
    assert.ok(!f.router.listTasks(principal('muse', { scopes: ['read', 'submit'] })).some(x => x.id === turn.id));
    assert.equal(f.router.getTask(plannerPrincipal('owner'), turn.id).id, turn.id); assert.equal(f.router.getTask(owner, turn.id).id, turn.id);
    // its permission requests are answered by the Router in code
    const ok = demo.permission(seat.nativeId, { tool: 'Bash', detail: 'node -v' }); await f.router.tick();
    const no = demo.permission(seat.nativeId, { tool: 'Bash', detail: 'npm install node@22' }); await f.router.tick();
    assert.deepEqual(demo.answers.map(a => [a.requestId, a.allow]), [[ok.id, true], [no.id, false]]);
    assert.deepEqual(f.store.task(turn.id)!.approvals!.map(a => [a.by, a.decision, a.rule]), [['router', 'allow', 'profile-command'], ['router', 'deny', 'not-allowed']]);
    assert.equal((await f.router.listPermissions(plannerPrincipal('owner'))).permissions.length, 0);
    // verdicts that do not count change nothing
    const verdict = { turn: turn.nonce!, decision: 'pass', reasonCode: 'ok', note: 'Checked on the host.', criteria: [{ index: 0, pass: true, evidence }] };
    demo.call(seat.nativeId, 'psr_verdict', { ...verdict, turn: 'deadbeef0000' }, 'bad-nonce');
    demo.call(seat.nativeId, 'psr_verdict', { ...verdict, criteria: [] }, 'no-criteria');
    demo.call(seat.nativeId, 'psr_verdict', { ...verdict, decision: 'pass', criteria: [{ index: 0, pass: false, evidence }] }, 'inconsistent');
    demo.call(seat.nativeId, 'psr_verdict', { ...verdict, criteria: [{ index: 0, pass: true, evidence: 'looks fine' }] }, 'thin-evidence');
    assert.equal(f.store.task(work.id)!.verification.status, 'pending');
    assert.deepEqual(f.store.rows<{ outcome: string }>('router_call').map(r => r.data.outcome).sort(), ['INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'INVALID_ARGUMENT']);
    demo.call(seat.nativeId, 'psr_verdict', verdict, 'good');
    demo.call(seat.nativeId, 'psr_verdict', verdict, 'good'); // replayed from history: applied once
    demo.call(seat.nativeId, 'psr_verdict', { ...verdict, decision: 'fail', criteria: [{ index: 0, pass: false, evidence }] }, 'second-opinion');
    const v = f.store.task(work.id)!.verification;
    assert.equal(v.status, 'passed'); assert.equal(v.stage, 'done'); assert.match(v.verifier!, /^arbiter:.*claude\/claude-opus-5-5/);
    assert.deepEqual(v.labels, ['judgment-only']); assert.deepEqual(v.criteria!.map(c => c.pass), [true]);
    assert.deepEqual(f.store.rows<{ outcome: string }>('router_call').map(r => r.data.outcome).filter(o => o !== 'INVALID_ARGUMENT').sort(), ['CONFLICT', 'ok']);
    const kinds = f.store.all<{ kind: string; taskId: string | null }>('planner_event');
    assert.ok(kinds.some(e => e.kind === 'task_verified' && e.taskId === work.id));
    demo.finish(seat.nativeId, 'Verdict given.'); await f.router.tick(); await f.router.tick();
    assert.ok(!f.store.all<{ kind: string; taskId: string | null }>('planner_event').some(e => e.taskId === turn.id), 'the Router\'s own turns raise no planner events');
    assert.equal(f.router.getGoal(owner, goal.id).tasks.length, 1);
});

test('arbiter: only a seat on the task\'s own machine checks it; failed work is not checked; no verdict leaves it unverified', async (t) => {
    const { f, goal, demo } = await verifiedSetup(); t.after(f.close);
    assert.throws(() => f.router.submit(owner, { routeTicket: f.ticket(owner, f.session('lab-test').id), prompt: 'lab work', idempotencyKey: 'v-lab-00000', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } }), code('NO_ARBITER_SEAT'));
    const labSeat = await f.router.createSession(owner, { templateId: 'judge-lab', idempotencyKey: 'seat-lab-0001', role: 'arbiter', profileId: 'node-check' });
    const lab = f.demos.get('lab-test')!, onLab = f.router.submit(owner, { routeTicket: f.ticket(owner, f.session('lab-test').id), prompt: 'lab work', idempotencyKey: 'v-lab-00001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    const failing = f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'gpu work', idempotencyKey: 'v-gpu-00001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    await f.router.tick(); lab.finish('agent-1', 'done'); demo.emit('agent-1', 'turn_failed', f.store.task(failing.id)!.turnId, 'crashed'); demo.sessions.get('agent-1')!.activeTurnId = null; demo.sessions.get('agent-1')!.status = 'idle';
    await f.router.tick(); await f.router.tick();
    assert.equal(arbiterTurn(f, onLab.id)!.target, labSeat.id);
    assert.deepEqual([f.store.task(failing.id)!.verification.status, f.store.task(failing.id)!.verification.stage], ['not_run', 'done']);
    assert.equal(arbiterTurn(f, failing.id), undefined);
    // two arbiter turns that end without a valid verdict leave the task unverified, for good
    lab.finish(labSeat.nativeId, 'I could not decide.'); await f.router.tick(); await f.router.tick(); await f.router.tick();
    const second = f.store.tasks().filter(x => x.verifyOf === onLab.id);
    assert.equal(second.length, 2);
    lab.finish(labSeat.nativeId, 'Still nothing.'); await f.router.tick(); await f.router.tick(); await f.router.tick();
    const v = f.store.task(onLab.id)!.verification;
    assert.deepEqual([v.status, v.stage, v.labels], ['not_run', 'done', ['unverified']]);
    assert.equal(f.store.tasks().filter(x => x.verifyOf === onLab.id).length, 2);
});

test('arbiter: the owner\'s verifier runs first: a fail is final without an arbiter turn, a pass goes to the arbiter with its output', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'psr-verifier-')), script = join(dir, 'verify.js');
    writeFileSync(script, `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s);console.log(JSON.stringify({checks:[{name:'version',pass:/GOOD/.test(i.result)}],env:Object.keys(process.env).filter(k=>k.startsWith('PSR_'))}));process.exit(/GOOD/.test(i.result)?0:1)})`);
    const { f, goal, demo } = await verifiedSetup({ id: 'node-check', commands: ['node -v'], verifier: { command: process.execPath, args: [script], timeoutMs: 20000 } }); t.after(f.close);
    process.env.PSR_TEST_SECRET = 'never-in-a-verifier';
    const direct = await runVerifier(process.execPath, [script], { result: 'BAD' }, 20000);
    assert.equal(direct.exitCode, 1); assert.deepEqual(JSON.parse(direct.output).env, []);
    const bad = f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'one', idempotencyKey: 'v-bad-00001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    await f.router.tick(); demo.finish('agent-1', 'BAD result'); await f.router.tick(); await f.router.tick();
    await until(() => f.store.task(bad.id)!.verification.stage === 'done');
    assert.deepEqual([f.store.task(bad.id)!.verification.status, f.store.task(bad.id)!.verification.verifierExit], ['failed', 1]);
    assert.equal(arbiterTurn(f, bad.id), undefined);
    const good = f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'two', idempotencyKey: 'v-good-0001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    await f.router.tick(); await f.router.tick(); demo.finish('agent-1', 'GOOD result'); await f.router.tick(); await f.router.tick();
    await until(() => f.store.task(good.id)!.verification.stage === 'arbiter');
    await f.router.tick();
    const turn = arbiterTurn(f, good.id)!;
    assert.match(turn.prompt, /Trusted verifier \(run by the Router\): exit 0[\s\S]*"pass":true/);
    delete process.env.PSR_TEST_SECRET;
});

test('arbiter: the done gate waits only for checks still running, and is off by default', async (t) => {
    const { f, seat, goal, demo } = await verifiedSetup(); t.after(f.close);
    const work = f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'work', idempotencyKey: 'v-gate-0001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    await f.router.tick(); demo.finish('agent-1', 'done'); await f.router.tick(); await f.router.tick();
    assert.equal(f.router.getPolicy(owner).verification.requireForGoalDone, false);
    f.router.setPolicy(owner, { verification: { requireForGoalDone: true } });
    assert.deepEqual(f.router.getPolicy(owner).verification.profiles.map(x => x.id), ['node-check']); // a partial update keeps the profiles
    assert.throws(() => f.router.postGoal(owner, { goalId: goal.id, kind: 'done', text: 'all done' }), code('VERIFICATION_PENDING'));
    const turn = arbiterTurn(f, work.id)!;
    // replayed from Paseo's projected history, where tool rows usually carry no turn ID: the nonce binds it
    demo.emit(seat.nativeId, 'router_call', null, undefined, { id: 'history-v1', callId: 'v1', tool: 'psr_verdict', input: { turn: turn.nonce, decision: 'fail', reasonCode: 'wrong', note: 'Still on v20.', criteria: [{ index: 0, pass: false, evidence: 'node -v printed v20.11.1 on this host, not v22.20.0 as the criterion requires.' }] } });
    assert.equal(f.store.task(work.id)!.verification.status, 'failed');
    assert.equal(f.router.postGoal(owner, { goalId: goal.id, kind: 'done', text: 'closing with a failed check' }).state, 'done');
});

test('hardening: a revoked observed channel is not delivered; creation records go only once their session is gone for good', async (t) => {
    const f = await fixture(c => { c.daemons.find(d => d.id === 'lab-test')!.agentChannel = { mode: 'observed' }; }); t.after(f.close);
    const s = await f.router.createSession(owner, { templateId: 'lab-codex', idempotencyKey: 'create-observed-0001' });
    const live = await f.router.createSession(owner, { templateId: 'lab-codex', idempotencyKey: 'create-observed-0002' });
    const gone = await f.router.createSession(owner, { templateId: 'lab-codex', idempotencyKey: 'create-observed-0003' });
    const a = f.demos.get('lab-test')!, task = f.submit('Work', principal('grokbot'), s.id); await f.router.tick();
    f.router.revokeAgentChannel(owner, s.id);
    a.emit(s.nativeId, 'agent_message', f.store.task(task.id)!.turnId, 'still talking', { kind: 'note', callId: 'call-after-revoke' });
    assert.equal((await f.router.waitMessages(principal('grokbot'), { timeoutMs: 0 })).messages.length, 0);
    a.finish(s.nativeId, 'done'); await f.router.tick();
    a.sessions.delete(s.nativeId); a.sessions.delete(gone.nativeId); await f.router.syncDirectory();
    const records = () => f.store.rows<{ sessionRef?: string }>('creation').map(r => r.data.sessionRef);
    f.advance(6 * 86400000); f.router.gc(); assert.ok(records().includes(gone.id));
    f.advance(40 * 86400000); f.router.gc();
    assert.ok(!records().includes(gone.id), 'an ordinary record goes once its session row is gone and it is past every credential lifetime');
    assert.ok(records().includes(s.id), 'a revocation is kept: the session may come back');
    assert.ok(records().includes(live.id));
});
test('arbiter: a seat switched to a mode that does not ask first gets no Router turn', async (t) => {
    const { f, seat, goal, demo } = await verifiedSetup(); t.after(f.close);
    const work = f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'work', idempotencyKey: 'v-mode-0001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    await f.router.tick(); demo.finish('agent-1', 'done');
    demo.sessions.get(seat.nativeId)!.modeId = 'bypassPermissions';
    await f.router.tick(); await f.router.tick();
    const turn = arbiterTurn(f, work.id)!;
    assert.equal(turn.state, 'queued'); assert.match(turn.blocker!, /mode bypassPermissions/);
    demo.sessions.get(seat.nativeId)!.modeId = 'default'; await f.router.tick();
    assert.notEqual(f.store.task(turn.id)!.state, 'queued');
});

test('review fixes: a verifier removed mid-check hands over to the arbiter; caps count from sending; retries and canceled goals behave', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'psr-verifier-')), script = join(dir, 'slow.js');
    writeFileSync(script, `setTimeout(()=>process.exit(0),200)`);
    const withVerifier = { id: 'node-check', commands: ['node -v'], verifier: { command: process.execPath, args: [script], timeoutMs: 20000 } };
    const { f, seat, goal, demo } = await verifiedSetup(withVerifier); t.after(f.close);
    const a = f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'one', idempotencyKey: 'v-rm-000001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    await f.router.tick(); demo.finish('agent-1', 'done'); await f.router.tick();
    assert.equal(f.store.task(a.id)!.verification.stage, 'verifier');
    f.router.setPolicy(owner, { verification: { profiles: [{ id: 'node-check', commands: ['node -v'] }] } });
    await f.router.tick(); await f.router.tick(); // must not throw
    assert.equal(f.store.task(a.id)!.verification.stage, 'arbiter');
    const turn = arbiterTurn(f, a.id)!; assert.ok(turn);
    // a same-key retry finds its task even after the only seat was retired
    const again = () => f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'one', idempotencyKey: 'v-rm-000001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    f.router.revokeAgentChannel(owner, seat.id);
    assert.equal(again().id, a.id);
    // the turn cap counts from when the turn was sent, not from when it was queued
    f.advance(25 * 60000); await f.router.tick();
    assert.equal(f.store.task(turn.id)!.state, 'running');
    // nobody but the owner stops the Router's turns
    await assert.rejects(() => f.router.cancel(principal('muse', { scopes: ['read', 'submit', 'cancel'] }), turn.id), code('NOT_FOUND'));
    await assert.rejects(() => f.router.cancel(plannerPrincipal('owner'), turn.id), code('FORBIDDEN'));
    // a canceled goal: the turn finishes, and no new one is queued
    f.router.cancelGoal(owner, { goalId: goal.id });
    demo.finish(seat.nativeId, 'no verdict'); await f.router.tick(); await f.router.tick();
    const v = f.store.task(a.id)!.verification;
    assert.deepEqual([v.status, v.stage], ['not_run', 'done']); assert.match(v.evidence!, /goal was canceled/);
    assert.equal(f.store.tasks().filter(x => x.verifyOf === a.id).length, 1);
});

test('review fixes: seats stay out of workers, searches and front-end template lists; an unseen arbiter turn is closed', async (t) => {
    const { f, seat, goal, demo } = await verifiedSetup(); t.after(f.close);
    assert.throws(() => f.router.bind(owner, { workerId: 'eth-mm', sessionRef: seat.id, workstreamId: 'ws-seat', expectedRevision: 0 }), code('SEAT_ROUTER_ONLY'));
    assert.ok(!f.router.listTemplates(principal('muse', { scopes: ['read', 'create'] })).templates.some(x => x.id === 'judge-gpu'));
    assert.ok(f.router.listTemplates(owner).templates.find(x => x.id === 'judge-gpu')!.seat);
    assert.ok(!f.router.getSession(owner, seat.id).allowedActions.includes('submit'));
    const found = f.router.resolve(principal('muse', { scopes: ['read', 'submit'] }), { hostId: 'gpu1', query: 'arbiter gpu1' });
    assert.equal(found.status, 'unavailable');
    const work = f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'work', idempotencyKey: 'v-unseen-001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    await f.router.tick(); demo.finish('agent-1', 'done'); await f.router.tick(); await f.router.tick();
    const turn = arbiterTurn(f, work.id)!;
    // as if the Router had restarted mid-send: the turn's delivery is unknown and its seat idle
    f.store.putTask({ ...f.store.task(turn.id)!, state: 'delivery_unknown', turnId: null });
    const s = demo.sessions.get(seat.nativeId)!; s.activeTurnId = null; s.status = 'idle';
    f.advance(31 * 60000); await f.router.tick(); await f.router.tick();
    assert.equal(f.store.task(turn.id)!.state, 'failed'); assert.equal(f.store.task(turn.id)!.lockHeld, false);
    assert.equal(f.store.tasks().filter(x => x.verifyOf === work.id).length, 2, 'the next attempt follows');
});

test('review fixes: the observed arbiter tool tells the arbiter what is wrong with a verdict before it ends its turn', async () => {
    const { spawn } = await import('node:child_process');
    const { observedStubSource } = await import('../src/agent-channel.js');
    const call = (args: unknown) => new Promise<{ isError: boolean; text: string }>((resolve) => {
        const child = spawn(process.execPath, ['-e', observedStubSource('arbiter')]); let out = '';
        child.stdout.on('data', d => { out += d; const line = out.split('\n').find(l => l.includes('"id":7')); if (line) { const r = JSON.parse(line).result; child.kill(); resolve({ isError: r.isError, text: r.content[0].text }); } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'psr_verdict', arguments: args } }) + '\n');
    });
    const good = { turn: '0123456789ab', decision: 'pass', reasonCode: 'ok', note: 'checked', criteria: [{ index: 0, pass: true, evidence }] };
    assert.equal((await call(good)).isError, false);
    assert.match((await call({ ...good, criteria: [{ index: 0, pass: true, evidence: 'v22 ok' }] })).text, /evidence 40-500 bytes/);
    assert.match((await call({ ...good, decision: 'fail' })).text, /decision/);
    assert.match((await call({ ...good, turn: 'nonce' })).text, /nonce/);
    assert.match((await call({ ...good, criteria: [{ index: 0, pass: true, evidence }, { index: 0, pass: true, evidence }] })).text, /each index once/);
});

test('guard: the Router reads with the checked task\'s checkout, masks secrets in verdicts, gives the host\'s rules, and never sends a check to another machine', async (t) => {
    const f = await fixture(c => { withSeats(c); c.hosts.find(h => h.id === 'gpu1')!.rules = ['只做 paper trading']; }); t.after(f.close);
    f.router.setPolicy(owner, { verification: { profiles: [{ id: 'node-check' }] } });
    const seat = await f.router.createSession(owner, { templateId: 'judge-gpu', idempotencyKey: 'seat-gpu-0001', role: 'arbiter', profileId: 'node-check' });
    await f.router.createSession(owner, { templateId: 'judge-lab', idempotencyKey: 'seat-lab-0001', role: 'arbiter', profileId: 'node-check' });
    const goal = f.router.submitGoal(owner, { text: 'guard', idempotencyKey: 'goal-guard-0001' }), demo = f.demos.get('gpu-research')!;
    const work = f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'write it', idempotencyKey: 'v-guard-0001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    await f.router.tick(); demo.finish('agent-1', 'done'); await f.router.tick(); await f.router.tick();
    const turn = arbiterTurn(f, work.id)!;
    assert.equal(turn.target, seat.id);
    assert.match(turn.prompt, /Rules of host gpu1: 只做 paper trading/); assert.match(turn.prompt, /Never copy secret values/); assert.match(turn.prompt, /only inside that checkout/);
    assert.match(turn.prompt, /A plain read command is one command per call: ls, cat, .*; any other shape is denied\./);
    const inside = demo.permission(seat.nativeId, { tool: 'Read', detail: JSON.stringify({ file_path: '/srv/hft/README.md' }) }); await f.router.tick();
    const outside = demo.permission(seat.nativeId, { tool: 'Read', detail: JSON.stringify({ file_path: '/home/u/.paseo/agents/x.json' }) }); await f.router.tick();
    assert.deepEqual(demo.answers.map(a => [a.requestId, a.allow]), [[inside.id, true], [outside.id, false]]);
    assert.deepEqual(f.store.task(turn.id)!.approvals!.map(a => a.rule), ['read-tool', 'outside-checkout']);
    const leak = 'The config line reads api_key = "sk-live-abcdefghijklmnopqrstuvwxyz0123456789" and node -v printed v22.20.0 as required.';
    demo.call(seat.nativeId, 'psr_verdict', { turn: turn.nonce, decision: 'pass', reasonCode: 'ok', note: 'token: abc123secretvalue', criteria: [{ index: 0, pass: true, evidence: leak }] }, 'leaky');
    const v = f.store.task(work.id)!.verification;
    assert.equal(v.status, 'passed');
    assert.ok(!/sk-live|abc123secretvalue/.test(JSON.stringify(v)), JSON.stringify(v));
    assert.match(v.criteria![0].evidence, /api_key = …/);
    // the gpu seat goes away mid-check: the lab seat (another machine, cannot see /srv/hft) never gets it
    const again = f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'again', idempotencyKey: 'v-guard-0002', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    demo.finish(seat.nativeId, 'Verdict given.'); await f.router.tick(); await f.router.tick(); demo.finish('agent-1', 'done again');
    f.router.revokeAgentChannel(owner, seat.id);
    await f.router.tick(); await f.router.tick(); await f.router.tick();
    assert.equal(arbiterTurn(f, again.id), undefined);
    assert.deepEqual([f.store.task(again.id)!.verification.status, f.store.task(again.id)!.verification.labels], ['not_run', ['unverified']]);
    assert.match(f.store.task(again.id)!.verification.evidence!, /on host gpu1/);
});

test('guard review: read limits allow real in-checkout calls and still refuse the rest', () => {
    const profile = { id: 'read-check' }, at = { cwd: '/home/u/psr-judge', checkout: '/home/u/psr-joint' };
    const ask = (tool: string, input: unknown, cwd?: string) => arbiterAnswer({ tool, detail: typeof input === 'string' ? input : JSON.stringify(input), ...(cwd ? { cwd } : {}) }, profile, at).allow;
    // Glob patterns count from their path; LS ignore lists and grep patterns are text, not places
    assert.equal(ask('Glob', { pattern: 'src/**/*.ts', path: '/home/u/psr-joint' }), true);
    assert.equal(ask('Glob', { pattern: '../**/*', path: '/home/u/psr-joint' }), false);
    assert.equal(ask('LS', { path: '/home/u/psr-joint', ignore: ['node_modules/', '**/dist/**'] }), true);
    // with a numeric context or count (-A 3, -C2, -m 5) the first operand is still the pattern: searched for, never read
    for (const cmd of ["grep -c 'https://api.example.com' /home/u/psr-joint/config.yaml", "grep -n '.*ERROR' /home/u/psr-joint/log/app.log", "grep -rn 'src/' /home/u/psr-joint/src", "grep -E '.*OK$' /home/u/psr-joint/pilot/hello.txt",
        'grep -A 3 /etc/passwd /home/u/psr-joint/a', "grep -n -C2 'docs/setup.md' /home/u/psr-joint/README.md"])
        assert.equal(ask('Bash', cmd), true, cmd);
    for (const cmd of ['grep /etc/passwd -e ^', 'grep -iex /etc/passwd', 'grep -f /etc/passwd /home/u/psr-joint/a', 'grep -A 3 x /etc/passwd', 'grep -A /etc/passwd x /home/u/psr-joint/a', 'grep -m 5 x /etc/passwd'])
        assert.equal(ask('Bash', cmd), false, cmd);
    // a command that says where it runs (Codex) is judged there
    assert.equal(ask('Bash', 'grep -ri token', '/home/u'), false);
    assert.equal(ask('Bash', 'cat passwd', '/etc'), false);
    assert.equal(ask('Bash', 'cat pilot/hello.txt', '/home/u/psr-joint'), true);
    // the directory it runs in can name the secret (below the checkout; the checkout's own name is the owner's)
    for (const cwd of ['/home/u/psr-joint/.aws', '/home/u/psr-joint/k8s/secrets', '/home/u/psr-joint/.ssh'])
        assert.deepEqual(arbiterAnswer({ tool: 'Bash', detail: 'cat config', cwd }, profile, at), { allow: false, rule: 'secret' }, cwd);
    assert.equal(ask('Bash', 'cat hello.txt', '/home/u/psr-joint/pilot'), true);
    assert.equal(arbiterAnswer({ tool: 'Bash', detail: 'cat src/a.ts', cwd: '/srv/secrets-sync' }, profile, { cwd: '/home/u/psr-judge', checkout: '/srv/secrets-sync' }).allow, true);
    // secret files by name, wherever they sit
    for (const cmd of ['cat /home/u/psr-joint/config/prod.env', 'cat /home/u/psr-joint/binance_keys.json', 'cat /home/u/psr-joint/token.json', 'cat /home/u/psr-joint/.pgpass', "grep -r = /home/u/psr-joint '--include=*.env'"])
        assert.equal(ask('Bash', cmd), false, cmd);
    // a checkout as wide as / or a whole home is no checkout
    assert.deepEqual(['/', '/srv', '/home/u', '/Users/x', '/var/root', '/home/u/psr-joint', '/srv/hft/'].map(checkableCheckout), [null, null, null, null, null, '/home/u/psr-joint', '/srv/hft']);
    // the wider secret rule leaves ordinary code alone for workers
    const level = (cmd: string) => classifyRequest({ tool: 'Bash', detail: cmd }, '/home/u/psr-joint', { rules: [] }).level;
    assert.deepEqual(['grep -rn generateKeyPairSync src/', 'cat src/crypto/keypair.rs', 'node -p process.env.HOME', 'cat /home/u/.paseo/daemon-keypair.json', 'cat config/prod.env'].map(level), ['L0', 'L0', 'L2', 'L4', 'L4']);
});

test('guard review: moves, home-directory targets and lost seat creations cannot get around the seat rules; verdicts are checked and masked', async (t) => {
    const { f, seat, goal, demo } = await verifiedSetup({ id: 'node-check' }); t.after(f.close);
    // a checked task cannot move to a machine with no seat of its profile
    const queuedBehind = f.submit('busy', owner);
    const moving = f.router.submit(owner, { routeTicket: f.ticket(owner), prompt: 'checked work', idempotencyKey: 'v-move-00001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria } });
    assert.ok(queuedBehind);
    assert.throws(() => f.router.moveTask(owner, { taskId: moving.id, routeTicket: f.ticket(owner, f.session('lab-test').id) }), code('NO_ARBITER_SEAT'));
    await f.router.cancel(owner, moving.id);
    // a session started in the seat's checkout without a creation record is still the Router's
    demo.sessions.set('stray', { id: 'stray', title: 'Arbiter gpu1', cwd: '/srv/judge', provider: 'claude/claude-opus-5-5', providerSessionId: 'p-stray', workspaceId: '/srv/judge', status: 'idle', activeTurnId: null, parentId: null, pendingPermissions: 0, background: false });
    await f.router.tick();
    const stray = f.store.all<{ id: string; nativeId: string }>('session').find(s => s.nativeId === 'stray')!;
    assert.ok(stray);
    assert.throws(() => f.submit('use the stray', owner, stray.id), code('SEAT_ROUTER_ONLY'));
    // reason codes are checked; secrets are masked but what the task already shows stays readable
    const hashInCriteria = '3f2a9c1e5b7d4a6f8e0c2b1d3a5f7e9c1b3d5f7a';
    const work = f.router.submit(owner, { routeTicket: f.ticket(owner, f.session('gpu-research').id), prompt: 'tag it', idempotencyKey: 'v-mask-00001', missionId: goal.id, verify: { arbiterId: 'node-check', criteria: [`HEAD is ${hashInCriteria}`] } });
    for (let i = 0; i < 6 && !arbiterTurn(f, work.id); i++) { const run = f.store.tasks().find(x => x.state === 'running' && !x.routerTurn); if (run) demo.finish(f.store.get<{ nativeId: string }>('session', run.target)!.nativeId, 'done'); await f.router.tick(); }
    await f.router.tick();
    const turn = arbiterTurn(f, work.id)!;
    assert.ok(turn, 'arbiter turn queued'); assert.equal(f.store.task(turn.id)!.state, 'running');
    const evidence = `git rev-parse HEAD printed ${hashInCriteria}; the deploy token eyJhbGciOiJIUzI1NiJ9.eyJ${''}zdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I3PlFUP0THsR8U was in the log, and postgres://trader:Hunter2Pass@db.internal/live too.`;
    demo.call(seat.nativeId, 'psr_verdict', { turn: turn.nonce, decision: 'pass', reasonCode: 'sk_' + 'live_51HxQabcdefghijklmnopqrstuv', note: 'ok', criteria: [{ index: 0, pass: true, evidence }] }, 'bad-reason');
    assert.equal(f.store.task(work.id)!.verification.status, 'pending');
    demo.call(seat.nativeId, 'psr_verdict', { turn: turn.nonce, decision: 'pass', reasonCode: 'ok', note: 'Basic dHJhZGVyOmh1bnRlcjI= was sent', criteria: [{ index: 0, pass: true, evidence }] }, 'good');
    const v = f.store.task(work.id)!.verification, shown = JSON.stringify(v);
    assert.equal(v.status, 'passed');
    assert.ok(shown.includes(hashInCriteria), 'a hash the task already shows stays');
    for (const secret of ['eyJhbGci', 'Hunter2Pass', 'dHJhZGVy', 'sk_live']) assert.ok(!shown.includes(secret), secret);
});

test('guard review 2: Glob stays in its directory, masking is fast and leaves ordinary text, secret names miss code that reads env vars', () => {
    const profile = { id: 'read-check' }, at = { cwd: '/home/u/psr-judge', checkout: '/home/u/psr-joint' };
    const glob = (input: unknown) => arbiterAnswer({ tool: 'Glob', detail: JSON.stringify(input) }, profile, at).allow;
    assert.deepEqual([{ pattern: '/home/u/psr-joint*/**' }, { pattern: '/home/u/psr-joint[-_]prod/**' }, { pattern: '/home/u/psr-joint' }, { pattern: '/home/u/psr-joint/' }].map(glob), [false, false, false, false]);
    assert.deepEqual([{ pattern: '/home/u/psr-joint/**/*.txt' }, { pattern: '/home/u/psr-joint/pilot/hello.txt' }, { pattern: '**/*.{ts,tsx}', path: '/home/u/psr-joint' }].map(glob), [true, true, true]);
    // masking: linear on huge one-word input; ordinary words, URLs and folders stay; credentials go
    const started = Date.now(); redact('cast send --create 0x' + 'ab'.repeat(50000) + ' --rpc-url x'); redact('w'.repeat(100000));
    assert.ok(Date.now() - started < 300, `redact took ${Date.now() - started} ms`);
    for (const text of ['Ran the basic health check and the basic smoke suite', 'curl -s http://localhost:5173/@vite/client', 'ls apps/WebConsole/src/v2/components2025Release']) assert.equal(redact(text), text);
    for (const [text, secret] of [['Authorization: Basic dHJhZGVyOmh1bnRlcjI=', 'dHJhZGVy'], ['postgres://trader:Hunter2Pass@db/live', 'Hunter2Pass'], ['key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY here', 'wJalrXUtnFEMI']]) assert.ok(!redact(text).includes(secret), text);
    const sha = '9c1e5d7a4b3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d';
    assert.ok(redact(`prints ${sha}, matching`, `Committed the fix as ${sha}.`).includes(sha));
    // worker levels: reading env vars in code is not a secret; env, token, service-account and state files are
    const level = (cmd: string) => classifyRequest({ tool: 'Bash', detail: cmd }, '/home/u/proj', { rules: [] }).level;
    assert.deepEqual(['grep -rn "process.env" src/', 'rg import.meta.env src', 'cat public/locales/en/auth.json', 'cat src/theme/tokens.json', 'cat models/tokenizer.json'].map(level), ['L0', 'L0', 'L0', 'L0', 'L0']);
    assert.deepEqual(['cat prod.env', 'cat config/app.prod.env', 'cat access_token.json', 'cat .dev.vars', 'cat .envrc', 'cat gcp-service-account.json', 'cat terraform.tfstate', 'cat /home/u/.codex/auth.json'].map(level), ['L4', 'L4', 'L4', 'L4', 'L4', 'L4', 'L4', 'L4']);
});
