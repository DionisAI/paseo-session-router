import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, principal, code, withServices } from './helpers.js';
import { execute, visibleTools } from '../src/tools.js';
import { RESOURCE_KEEP_MS } from '../src/resources.js';
import { channelTools } from '../src/agent-channel.js';
import { mcp } from '../src/mcp.js';
import type { PeerMessage } from '../src/peer.js';
import type { Principal, RouterConfig } from '../src/types.js';
import type { ResourceClaim } from '../src/resources.js';

const owner = principal();
const R = 'lab3/unreal-editor', T1 = '019a7c3e-7777-7000-8000-000000000010';
async function setup() {
    const f = await fixture();
    const cred = (hostId: string) => f.router.localPrincipal(f.router.issueLocalCredential(owner, { hostId }).token);
    const gpu = cred('gpu1'), lab = cred('lab3');
    const join = (c: Principal, cwd: string, name = 'claude-code', thread: string | null = null) => {
        const m = f.router.joinLocal(c, { place: { cwd, repo: null, branch: null }, client: { name, version: '1' } });
        return { id: m.id, p: f.router.touchLocal(c, m.id, { cwd, repo: null, branch: null }, thread) };
    };
    /** What the bridge would put into a session now: the Router's notices are among it. */
    const pushed = async (p: Principal) => (await f.router.pushWait(p, { timeoutMs: 0 })).messages;
    const notices = () => f.store.all<PeerMessage>('peer_message').filter(x => x.from.kind === 'router');
    return { f, gpu, lab, join, pushed, notices };
}

test('resources: only the owner registers them; local sessions see the take and release tools', async (t) => {
    const { f, lab, join } = await setup(); t.after(f.close);
    const a = join(lab, '/w/a');
    for (const n of ['psr_local_resources', 'psr_local_take', 'psr_local_release']) assert.ok(visibleTools(a.p).some(x => x.name === n), n);
    const admin = visibleTools(owner).map(x => x.name), reader = visibleTools(principal('muse', { scopes: ['read', 'submit'] })).map(x => x.name);
    for (const n of ['psr_list_resources', 'psr_set_resource', 'psr_remove_resource', 'psr_release_resource']) { assert.ok(admin.includes(n), n); assert.ok(!reader.includes(n), n); }
    assert.throws(() => f.router.setResource(principal('muse', { scopes: ['read', 'submit'] }), { resourceId: R }), code('FORBIDDEN'));
    assert.throws(() => f.router.setResource(owner, { resourceId: 'unreal-editor' }), code('INVALID_ARGUMENT'));
    assert.throws(() => f.router.setResource(owner, { resourceId: 'lab3/Unreal Editor' }), code('INVALID_ARGUMENT'));
    assert.throws(() => f.router.setResource(owner, { resourceId: 'nowhere/editor' }), code('NOT_FOUND'));
    assert.throws(() => f.router.setResource(owner, { resourceId: R, slots: 0 }), code('INVALID_ARGUMENT'));
    const v = f.router.setResource(owner, { resourceId: R, description: 'Unreal Editor (one project open at a time)' });
    assert.deepEqual([v.hostId, v.slots, v.remindAfterMinutes, v.free, v.description], ['lab3', 1, 120, 1, 'Unreal Editor (one project open at a time)']);
    // a change keeps what it does not name; holdMinutes is still taken as the old name of remindAfterMinutes
    const w = f.router.setResource(owner, { resourceId: R, remindAfterMinutes: 30 });
    assert.deepEqual([w.description, w.remindAfterMinutes, f.router.listResources(owner).resources.length], ['Unreal Editor (one project open at a time)', 30, 1]);
    assert.equal(f.router.setResource(owner, { resourceId: R, holdMinutes: 40 }).remindAfterMinutes, 40);
    assert.equal(f.router.setResource(owner, { resourceId: R, slots: 1 }).remindAfterMinutes, 40);
    // a record stored before the rename reads the same, and a change rewrites it under the new name
    f.store.put('resource', 'lab3/old-gpu', { id: 'lab3/old-gpu', hostId: 'lab3', slots: 1, description: null, holdMinutes: 45, createdAt: f.now(), updatedAt: f.now(), by: 'web' });
    assert.equal(f.router.listResources(owner).resources.find(r => r.resourceId === 'lab3/old-gpu')!.remindAfterMinutes, 45);
    f.router.setResource(owner, { resourceId: 'lab3/old-gpu', description: 'GPU' });
    const stored = f.store.get<Record<string, unknown>>('resource', 'lab3/old-gpu')!;
    assert.deepEqual([stored.remindAfterMinutes, 'holdMinutes' in stored], [45, false]);
    f.router.removeResource(owner, { resourceId: 'lab3/old-gpu' });
    f.router.setResource(owner, { resourceId: R, remindAfterMinutes: 30 });
    // the session is told that holding has no limit and when it would be reminded
    const took = f.router.localTake(a.p, { resource: R });
    assert.match(took.note, /is yours, with no time limit: nobody takes it from you\..*reminds you once after 30 minutes/);
    assert.match(f.router.localResources(a.p).note, /no time limit.*remindAfterMinutes/);
    f.router.localRelease(a.p, { resource: R });
    assert.deepEqual(f.router.localResources(a.p).resources.map(r => [r.resourceId, r.free]), [[R, 1]]);
    await assert.rejects(execute(f.router, a.p, 'psr_local_take', { resource: R, note: 'x'.repeat(121) }), code('INVALID_ARGUMENT'));
    await assert.rejects(execute(f.router, a.p, 'psr_set_resource', { resourceId: R }), code('TOOL_NOT_FOUND'));
});

test('resources: the first to take holds it, the rest wait in order; on release the next is told between its turns', async (t) => {
    const { f, gpu, lab, join, pushed } = await setup(); t.after(f.close);
    f.router.setResource(owner, { resourceId: R, description: 'Unreal Editor' });
    const a = join(lab, '/w/a'), b = join(gpu, '/w/b'), c = join(lab, '/w/c', 'codex-mcp-client');
    assert.throws(() => f.router.localTake(a.p, { resource: 'lab3/nothing' }), code('NOT_FOUND'));
    const ta = f.router.localTake(a.p, { resource: R, note: 'packaging the demo level' });
    assert.deepEqual([ta.you, ta.position, ta.free], ['holding', null, 0]);
    const tb = f.router.localTake(b.p, { resource: R }), tc = f.router.localTake(c.p, { resource: R, note: 'lighting bake' });
    assert.deepEqual([tb.you, tb.position, tc.you, tc.position], ['waiting', 1, 'waiting', 2]);
    assert.match(tb.note, /in use \(claude @ a #.*number 1 in line.*do not poll.*resource:lab3\/unreal-editor/);
    // taking again changes nothing
    assert.equal(f.router.localTake(b.p, { resource: R }).position, 1);
    assert.deepEqual(f.router.localResources(c.p).resources[0].holders.map(h => [h.note, h.mine]), [['packaging the demo level', false]]);
    assert.deepEqual(f.router.localWho(b.p).sessions.find(x => x.memberId === a.id)!.holds, [R]);
    assert.throws(() => f.router.localRelease(a.p, { resource: 'lab3/nothing' }), code('NOT_FOUND'));
    // a leaves the line before its turn: nothing changes for the others
    const d = join(lab, '/w/d');
    f.router.localTake(d.p, { resource: R });
    assert.equal(f.router.localRelease(d.p, { resource: R }).note, 'You left the line.');
    assert.throws(() => f.router.localRelease(d.p, { resource: R }), code('NOT_HELD'));
    // the holder gives it back: b has it and is told, between its turns (the Router's notice is pushed); c moves up
    assert.deepEqual(await pushed(b.p), []);
    const ra = f.router.localRelease(a.p, { resource: R });
    assert.match(ra.note, /^Released; claude @ b #.* has it now/);
    const got = await pushed(b.p);
    assert.equal(got.length, 1);
    assert.match(got[0].text, /^\[PSR message pm_\d+: notice from the Router\] No answer is expected\.\nlab3\/unreal-editor \(Unreal Editor\) is yours now: it was your turn in line\..*psr_local_release.*1 waiting after you/s);
    assert.deepEqual(f.router.localResources(c.p).resources[0].waiting.map(w => [w.position, w.mine]), [[1, true]]);
    // the session gets it once
    f.router.pushAck(b.p, { messageIds: got.map(x => x.messageId) });
    assert.deepEqual(await pushed(b.p), []);
});

test('resources: a message to resource:<id> goes to whoever holds it', async (t) => {
    const { f, gpu, lab, join, pushed } = await setup(); t.after(f.close);
    f.router.setResource(owner, { resourceId: R });
    const a = join(lab, '/w/a'), b = join(gpu, '/w/b');
    assert.throws(() => f.router.localSend(b.p, { to: `resource:${R}`, kind: 'request', text: 'When will the editor be free?' }), code('RESOURCE_FREE'));
    assert.throws(() => f.router.localSend(b.p, { to: 'resource:lab3/nothing', kind: 'request', text: 'x' }), code('NOT_FOUND'));
    f.router.localTake(a.p, { resource: R });
    f.router.localTake(b.p, { resource: R });
    const sent = f.router.localSend(b.p, { to: `resource:${R}`, kind: 'request', text: 'When will the editor be free?' });
    assert.deepEqual([sent.via, sent.delivery], [R, 'queued']);
    assert.match(sent.to, /^claude @ a #/);
    const got = await pushed(a.p);
    assert.match(got[0].text, /^\[PSR message pm_\d+: request from claude @ b #\w+ to whoever holds lab3\/unreal-editor \(you do\)\]/);
    assert.throws(() => f.router.localSend(a.p, { to: `resource:${R}`, kind: 'notice', text: 'me?' }), code('INVALID_ARGUMENT'));
    // the usual bounds still hold between the two sessions
    assert.throws(() => f.router.localSend(b.p, { to: `resource:${R}`, kind: 'request', text: 'again?' }), code('REQUEST_OPEN'));
    assert.equal(f.router.ownerSend(owner, { to: `resource:${R}`, kind: 'notice', text: 'Close the editor before 18:00' }).via, R);
});

test('resources: a session that ends gives back what it held, and a Codex thread\'s new bridge keeps it', async (t) => {
    const { f, gpu, lab, join, pushed } = await setup(); t.after(f.close);
    f.router.setResource(owner, { resourceId: R });
    const a = join(lab, '/w/a', 'codex-mcp-client', T1), b = join(gpu, '/w/b'), c = join(lab, '/w/c');
    f.router.localTake(a.p, { resource: R }); f.router.localTake(b.p, { resource: R }); f.router.localTake(c.p, { resource: R });
    // the app restarts the thread's server: the new bridge holds it now, nobody else is told anything
    const a2 = join(lab, '/w/a', 'codex-mcp-client', T1);
    assert.deepEqual(f.router.localResources(b.p).resources[0].holders.map(h => h.memberId), [a2.id]);
    assert.deepEqual(await pushed(b.p), []);
    // the session ends: b has it
    f.router.leaveLocal(lab, a2.id);
    assert.deepEqual(f.router.localResources(c.p).resources[0].holders.map(h => h.memberId), [b.id]);
    assert.equal((await pushed(b.p)).length, 1);
    // a session that goes silent is closed by gc and gives it back too
    f.advance(31 * 60000);
    for (const x of [c]) f.router.touchLocal(lab, x.id, { cwd: '/w/c', repo: null, branch: null });
    f.router.gc();
    assert.deepEqual(f.router.listResources(owner).resources[0].holders.map(h => h.memberId), [c.id]);
    assert.equal(f.store.get<{ releaseReason: string }>('resource_claim', 'rc_00000002')!.releaseReason, 'silent');
    // revoking a machine's credential frees what its sessions held
    const cred = f.store.get<{ credentialId: string }>('local_member', c.id)!.credentialId;
    f.router.revokeLocalCredential(owner, { credentialId: cred });
    assert.equal(f.router.listResources(owner).resources[0].free, 1);
});

test('resources: the owner adds slots, takes a resource back, removes it; a long hold others wait behind is reminded once', async (t) => {
    const { f, gpu, lab, join, pushed, notices } = await setup(); t.after(f.close);
    f.router.setResource(owner, { resourceId: R, remindAfterMinutes: 5 });
    const a = join(lab, '/w/a'), b = join(gpu, '/w/b'), c = join(lab, '/w/c');
    f.router.localTake(a.p, { resource: R });
    // nobody waits: no reminder however long it is held
    f.advance(10 * 60000); f.router.gc();
    assert.equal(notices().length, 0);
    f.router.localTake(b.p, { resource: R });
    f.advance(60000); f.router.gc(); f.router.gc();
    const reminders = notices().filter(x => x.to.ref === a.id);
    assert.equal(reminders.length, 1);
    assert.match(reminders[0].text, /You have held lab3\/unreal-editor for 11 minutes and 1 session is waiting.*nobody takes it from you/);
    // a second slot goes to the line at once
    f.router.localTake(c.p, { resource: R });
    const two = f.router.setResource(owner, { resourceId: R, slots: 2 });
    assert.deepEqual([two.holders.map(h => h.memberId), two.waiting.map(w => w.memberId)], [[a.id, b.id], [c.id]]);
    // the owner takes it back from a: c has it, a is told
    assert.throws(() => f.router.releaseResource(owner, { resourceId: R, memberId: 'lm_nope' }), code('NOT_HELD'));
    const back = f.router.releaseResource(owner, { resourceId: R, memberId: a.id });
    assert.deepEqual(back.holders.map(h => h.memberId).sort(), [b.id, c.id].sort());
    assert.ok((await pushed(a.p)).some(x => /The owner took lab3\/unreal-editor back from you/.test(x.text)));
    // removed: its holders are told, and it is gone
    assert.deepEqual(f.router.removeResource(owner, { resourceId: R }), { removed: R, endedClaims: 2 });
    assert.ok((await pushed(c.p)).some(x => /The owner removed the resource lab3\/unreal-editor/.test(x.text)));
    assert.throws(() => f.router.localTake(a.p, { resource: R }), code('NOT_FOUND'));
    // ended claims go a day later
    f.advance(RESOURCE_KEEP_MS + 60000);
    for (const x of [a, b, c]) f.router.touchLocal(x === b ? gpu : lab, x.id, { cwd: x === a ? '/w/a' : x === b ? '/w/b' : '/w/c', repo: null, branch: null });
    f.router.gc();
    assert.equal(f.store.all('resource_claim').length, 0);
});

// ---------- Paseo sessions the Router dispatches ----------
const grok = principal('grokbot');
type F = Awaited<ReturnType<typeof fixture>>;
const channelToken = (f: F, nativeId: string) => { for (const d of f.demos.values()) { const c = d.channels.get(nativeId); if (c?.mode === 'http') return c.token; } throw new Error(`no http channel for ${nativeId}`); };
/** Two Paseo sessions created now on the http channel (lab on lab3, gpu on gpu1), each in a running Router turn assigned by
 * Grokbot; a local session on lab3; and the resource lab3/unreal-editor. */
async function paseo(change?: (c: RouterConfig) => void) {
    const f = await fixture(c => { withServices(c); c.templates.push({ id: 'gpu-codex', daemonId: 'gpu-research', cwd: '/srv/hft-queue', provider: 'codex/demo', title: 'Queue helper' }); change?.(c); });
    const lab = await f.router.createSession(owner, { templateId: 'lab-codex', idempotencyKey: 'res-lab-0001' });
    const gpu = await f.router.createSession(owner, { templateId: 'gpu-codex', idempotencyKey: 'res-gpu-0001' });
    let n = 0;
    const send = (sess: { id: string }, prompt: string) => f.router.submit(grok, { routeTicket: f.ticket(grok, sess.id), prompt, idempotencyKey: `res-task-${++n}`, missionId: 'm-res' });
    const a = send(lab, 'Package the demo level'), b = send(gpu, 'Bake the lighting');
    await f.router.tick();
    assert.deepEqual([f.store.task(a.id)!.state, f.store.task(b.id)!.state], ['running', 'running']);
    const agentOf = (sess: { nativeId: string }) => f.router.agentPrincipal(channelToken(f, sess.nativeId));
    const cred = f.router.localPrincipal(f.router.issueLocalCredential(owner, { hostId: 'lab3' }).token);
    const m = f.router.joinLocal(cred, { place: { cwd: '/w/local', repo: null, branch: null }, client: { name: 'claude-code', version: '1' } });
    const L = f.router.touchLocal(cred, m.id, { cwd: '/w/local', repo: null, branch: null });
    f.router.setResource(owner, { resourceId: R, description: 'Unreal Editor', remindAfterMinutes: 5 });
    const claim = (holder: string) => f.store.all<ResourceClaim>('resource_claim').filter(c => c.memberId === holder).sort((x, y) => x.seq - y.seq).at(-1)!;
    const labDemo = f.demos.get('lab-test')!, gpuDemo = f.demos.get('gpu-research')!;
    const turnsFor = (sess: { id: string }) => f.store.tasks().filter(t => t.target === sess.id).sort((x, y) => x.createdAt - y.createdAt);
    return { f, lab, gpu, a, b, A: agentOf(lab), B: agentOf(gpu), agentOf, send, cred, member: m, L, claim, labDemo, gpuDemo, turnsFor };
}

test('resources: Paseo sessions created now get psr_resources, psr_take and psr_release; older ones and seats do not', async (t) => {
    const { f, A, lab } = await paseo(); t.after(f.close);
    const names = (p: Principal) => visibleTools(p).map(x => x.name);
    for (const n of ['psr_resources', 'psr_take', 'psr_release']) { assert.ok(names(A).includes(n), n); assert.ok(!names(owner).includes(n), n); }
    assert.ok(!names(A).some(n => n.startsWith('psr_local_')));
    const init = await mcp(f.router, A, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) as { result: { instructions: string } };
    assert.match(init.result.instructions, /take it with psr_take, and release it with psr_release as soon as you are done\. If it is in use you wait in line/);
    assert.ok(f.store.rows<{ tools?: string[] }>('creation').some(r => r.data.tools?.includes('psr_take')));
    // a session created before (its preapproved tools lack them) does not see them
    const rec = f.store.rows<{ sessionRef?: string; tools?: string[] }>('creation').find(r => r.data.sessionRef === lab.id)!;
    f.store.put('creation', rec.id, { ...rec.data, tools: rec.data.tools!.filter(x => !['psr_resources', 'psr_take', 'psr_release'].includes(x)) }, rec.projectId, rec.hostId, f.now());
    const older = f.router.agentPrincipal(channelToken(f, lab.nativeId));
    assert.ok(!names(older).includes('psr_take'));
    assert.doesNotMatch(((await mcp(f.router, older, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as { result: { instructions: string } }).result.instructions, /psr_take/);
    await assert.rejects(execute(f.router, older, 'psr_take', { resource: R }), code('FORBIDDEN'));
    // Router seats get none
    assert.deepEqual([channelTools('service', 'http'), channelTools('arbiter', 'http'), channelTools(undefined, 'observed')], [['psr_ask'], ['psr_verdict'], ['psr_post_message']]);
});

test('resources: a Paseo session takes a free resource during its turn, keeps it after the turn, and gives it back any time', async (t) => {
    const { f, A, lab, labDemo, claim, cred, member } = await paseo(); t.after(f.close);
    const took = f.router.agentTake(A, { resource: R, note: 'packaging the demo level' });
    assert.deepEqual([took.you, took.position, took.holders.map(h => [h.kind, h.mine])], ['holding', null, [['paseo', true]]]);
    assert.match(took.note, /is yours, with no time limit.*You keep it after this turn/);
    assert.match(took.holders[0].name, /\(Paseo, lab3\)$/);
    assert.deepEqual([claim(lab.id).taskId, claim(lab.id).clientId], [f.store.tasks().find(x => x.target === lab.id)!.id, 'grokbot']);
    // the local session sees who holds it, and a message to the resource is refused: a dispatched session takes no messages
    const L = f.router.touchLocal(cred, member.id, { cwd: '/w/local', repo: null, branch: null });
    assert.match(f.router.localResources(L).resources[0].holders[0].name, /Paseo, lab3/);
    assert.throws(() => f.router.localSend(L, { to: `resource:${R}`, kind: 'request', text: 'When will the editor be free?' }), code('HOLDER_TAKES_NO_MESSAGES'));
    labDemo.finish(lab.nativeId, 'packaged'); await f.router.tick();
    assert.equal(claim(lab.id).state, 'holding');
    // outside a turn: no new take, but a release is fine
    assert.throws(() => f.router.agentTake(A, { resource: 'lab3/other' }), code('NOT_FOUND'));
    f.router.setResource(owner, { resourceId: 'lab3/other' });
    assert.throws(() => f.router.agentTake(A, { resource: 'lab3/other' }), code('NO_ACTIVE_TASK'));
    assert.equal(f.router.agentRelease(A, { resource: R }).note, 'Released.');
    assert.throws(() => f.router.agentRelease(A, { resource: R }), code('NOT_HELD'));
});

test('resources: a Paseo session in line gets a turn when the resource is its own, a reply to its waiting task in its assigner\'s name, never during a turn', async (t) => {
    const { f, gpu, b, B, L, claim, gpuDemo, turnsFor } = await paseo(); t.after(f.close);
    f.router.localTake(L, { resource: R, note: 'compiling shaders' });
    const wait = f.router.agentTake(B, { resource: R, note: 'bake the lighting' });
    assert.deepEqual([wait.you, wait.position], ['waiting', 1]);
    assert.match(wait.note, /number 1 in line\. Finish what does not need it.*end your turn: when it is yours the Router sends you a turn/);
    // the local holder gives it back while the Paseo session's turn still runs: it holds it, and is owed a turn
    assert.match(f.router.localRelease(L, { resource: R }).note, /Queue helper \(Paseo, gpu1\) has it now/);
    assert.deepEqual([claim(gpu.id).state, claim(gpu.id).pendingTurn], ['holding', 'grant']);
    assert.equal(f.router.listResources(owner).resources[0].holders[0].told, false);
    const sendsBefore = gpuDemo.sends.length;
    await f.router.tick();
    const turn = turnsFor(gpu).at(-1)!;
    assert.deepEqual([turn.replyToTaskId, turn.originClientId, turn.state, turn.missionId, gpuDemo.sends.length], [b.id, 'grokbot', 'queued', 'm-res', sendsBefore]);
    assert.match(turn.prompt, /^\[Router\] The shared resource lab3\/unreal-editor \(Unreal Editor\) is yours now: it was your turn in line \(you asked for it in task task_\w+\)\. Continue the work/);
    assert.deepEqual([claim(gpu.id).pendingTurn, claim(gpu.id).turnTaskIds], [null, [turn.id]]);
    // it runs once the waiting turn has ended, and only once
    gpuDemo.finish(gpu.nativeId, 'waiting for the editor'); await f.router.tick();
    assert.equal(f.store.task(turn.id)!.state, 'running');
    assert.match(gpuDemo.sends.at(-1)!.prompt, /is yours now/);
    await f.router.tick(); await f.router.tick();
    assert.equal(turnsFor(gpu).length, 2);
});

test('resources: a Paseo session that learns in its own turn that the resource is now its own gets no extra turn', async (t) => {
    const { f, gpu, B, L, claim, turnsFor } = await paseo(); t.after(f.close);
    f.router.localTake(L, { resource: R });
    f.router.agentTake(B, { resource: R });
    f.router.localRelease(L, { resource: R });
    assert.deepEqual([f.router.agentTake(B, { resource: R }).you, claim(gpu.id).pendingTurn], ['holding', null]);
    await f.router.tick();
    assert.equal(turnsFor(gpu).length, 1);
});

test('resources: a long Paseo hold others wait behind gets one short reminder turn; the owner taking it back or removing it is a turn too', async (t) => {
    const { f, lab, gpu, a, A, B, L, claim, labDemo, gpuDemo, turnsFor, send } = await paseo(); t.after(f.close);
    f.router.agentTake(A, { resource: R, note: 'packaging' });
    labDemo.finish(lab.nativeId, 'packaged, still holding the editor'); await f.router.tick();
    f.router.localTake(L, { resource: R });
    f.advance(6 * 60000); f.router.gc(); f.router.gc();
    assert.equal(claim(lab.id).pendingTurn, 'remind');
    await f.router.tick();
    const remind = turnsFor(lab).at(-1)!;
    assert.deepEqual([remind.replyToTaskId, remind.originClientId], [a.id, 'grokbot']);
    assert.match(remind.prompt, /^\[Router\] You have held the shared resource lab3\/unreal-editor \(Unreal Editor\) for 6 minutes and 1 session is waiting for it\. If you are done with it, release it now.*nobody takes it from you\. Do nothing else in this turn\./);
    f.advance(20 * 60000); f.router.gc(); await f.router.tick();
    assert.equal(turnsFor(lab).filter(x => /You have held/.test(x.prompt)).length, 1);
    // the owner takes it back: the local session in line gets it, the Paseo session gets one turn saying so
    labDemo.finish(lab.nativeId, 'still using it'); await f.router.tick();
    f.router.releaseResource(owner, { resourceId: R, memberId: lab.id });
    assert.deepEqual([claim(lab.id).releaseReason, claim(lab.id).pendingTurn], ['owner', 'taken']);
    await f.router.tick();
    assert.match(turnsFor(lab).at(-1)!.prompt, /^\[Router\] The owner took the shared resource lab3\/unreal-editor .* back from you\. Stop using it now/);
    // removed: a Paseo holder that was told is told; one waiting is not
    f.router.localRelease(L, { resource: R });
    const c = send(gpu, 'Second bake'); gpuDemo.finish(gpu.nativeId, 'first bake done'); await f.router.tick();
    assert.equal(f.store.task(c.id)!.state, 'running');
    f.router.agentTake(B, { resource: R });
    const before = turnsFor(gpu).length;
    f.router.removeResource(owner, { resourceId: R });
    assert.equal(claim(gpu.id).pendingTurn, 'removed');
    await f.router.tick();
    assert.equal(turnsFor(gpu).length, before + 1);
    assert.match(turnsFor(gpu).at(-1)!.prompt, /^\[Router\] The owner removed the shared resource lab3\/unreal-editor; you no longer hold it/);
});

test('resources: a Paseo session that is gone gives back what it held; a turn in line that cannot reach its session passes to the next', async (t) => {
    const { f, lab, gpu, A, B, L, claim, member, cred, gpuDemo, turnsFor } = await paseo(); t.after(f.close);
    f.router.agentTake(A, { resource: R });
    f.router.agentTake(B, { resource: R });
    const L2 = f.router.touchLocal(cred, member.id, { cwd: '/w/local', repo: null, branch: null });
    f.router.localTake(L2, { resource: R });
    // lab's session disappears from its daemon: gc ends its claim and the next in line (gpu) is owed its turn
    f.demos.get('lab-test')!.sessions.delete(lab.nativeId);
    await f.router.syncDirectory(); f.router.gc();
    assert.deepEqual([claim(lab.id).releaseReason, claim(gpu.id).state, claim(gpu.id).pendingTurn], ['closed', 'holding', 'grant']);
    // gpu's daemon goes offline: the turn cannot be sent, and after 30 minutes the resource passes to the local session
    gpuDemo.online = false;
    await f.router.tick();
    assert.equal(turnsFor(gpu).length, 1);
    f.advance(31 * 60000);
    f.router.touchLocal(cred, member.id, { cwd: '/w/local', repo: null, branch: null });
    await f.router.tick();
    assert.deepEqual([claim(gpu.id).releaseReason, f.router.listResources(owner).resources[0].holders.map(h => h.memberId)], ['undeliverable', [member.id]]);
    assert.equal(turnsFor(gpu).length, 1);
    assert.ok(L);
});

test('resources: a Paseo session on an owner-only host takes resources only while it asks before acting', async (t) => {
    const { f } = await paseo(c => { c.templates.push({ id: 'dev-plain', daemonId: 'dev-app', cwd: '/srv/router', provider: 'claude/demo', title: 'Dev helper', modeId: 'bypassPermissions' }); });
    t.after(f.close);
    const dev = await f.router.createSession(owner, { templateId: 'dev-plain', idempotencyKey: 'res-dev-0001' });
    const task = f.router.submit(owner, { routeTicket: f.ticket(owner, dev.id), prompt: 'Tidy the router checkout', idempotencyKey: 'res-dev-task-1', missionId: 'm-res' });
    await f.router.tick();
    assert.equal(f.store.task(task.id)!.state, 'running');
    const D = f.router.agentPrincipal(channelToken(f, dev.nativeId));
    assert.throws(() => f.router.agentTake(D, { resource: R }), code('RESOURCE_DENIED'));
});
