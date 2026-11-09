import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, principal, code, withServices, SERVICES } from './helpers.js';
import { execute, visibleTools } from '../src/tools.js';
import type { ForumPost, Principal, RouterConfig } from '../src/types.js';

const owner = principal(), grok = principal('grokbot');
type F = Awaited<ReturnType<typeof fixture>>;
const token = (f: F, nativeId: string) => { for (const d of f.demos.values()) { const c = d.channels.get(nativeId); if (c?.mode === 'http') return c.token; } throw new Error(`no http channel for ${nativeId}`); };
/** Every daemon on the http channel (withServices), plus an ordinary template on gpu1 next to lab-codex on lab3. */
const withForum = (c: RouterConfig) => { withServices(c); c.templates.push({ id: 'gpu-codex', daemonId: 'gpu-research', cwd: '/srv/hft-queue', provider: 'codex/demo', title: 'Queue helper' }); };
const withPlannerTemplate = (c: RouterConfig) => { c.templates.push({ id: 'planner-tpl', daemonId: 'dev-app', cwd: '/srv/router', provider: 'claude/demo', title: 'Planner', modeId: 'default' }); };
const HINT = '[Router] 論壇';
const forumTools = (p: Principal) => visibleTools(p).map(x => x.name).filter(n => n.startsWith('psr_forum'));
/** Two sessions created now (lab on lab3, gpu on gpu1), each in a running Router turn of mission m-forum assigned by Grokbot. */
async function setup(change?: (c: RouterConfig) => void) {
    const f = await fixture(c => { withForum(c); change?.(c); });
    const lab = await f.router.createSession(owner, { templateId: 'lab-codex', idempotencyKey: 'forum-lab-0001' });
    const gpu = await f.router.createSession(owner, { templateId: 'gpu-codex', idempotencyKey: 'forum-gpu-0001' });
    let n = 0;
    const send = (s: { id: string }, prompt: string, extra: { missionId?: string } = { missionId: 'm-forum' }) => f.router.submit(grok, { routeTicket: f.ticket(grok, s.id), prompt, idempotencyKey: `forum-task-${++n}`, ...extra });
    const a = send(lab, 'Lab half of the study'), b = send(gpu, 'GPU half of the study');
    await f.router.tick();
    assert.deepEqual([f.store.task(a.id)!.state, f.store.task(b.id)!.state], ['running', 'running']);
    const agentOf = (s: { nativeId: string }) => f.router.agentPrincipal(token(f, s.nativeId));
    const labDemo = f.demos.get('lab-test')!, gpuDemo = f.demos.get('gpu-research')!;
    const promptOf = (taskId: string) => [...labDemo.sends, ...gpuDemo.sends].find(x => x.turnId === f.store.task(taskId)!.turnId)!.prompt;
    return { f, lab, gpu, a, b, A: agentOf(lab), B: agentOf(gpu), agentOf, send, labDemo, gpuDemo, promptOf };
}
async function withPlanner(f: F) {
    await f.router.setupPlanner(owner, { templateId: 'planner-tpl', idempotencyKey: 'planner-setup-1' });
    const channel = [...f.demos.get('dev-app')!.channels.values()].at(-1)!; assert(channel.mode === 'planner');
    return { channel, planner: f.router.agentPrincipal(channel.token) };
}

test('forum: the sessions on a mission share one forum; a post wakes nobody', async (t) => {
    const { f, lab, A, B, labDemo, gpuDemo } = await setup(); t.after(f.close);
    const quiet = () => ({ planner: f.store.meta('plannerSeq') ?? null, tasks: f.store.tasks().length, sends: [labDemo.sends.length, gpuDemo.sends.length] }), before = quiet();
    const posted = f.router.postForum(A, { text: 'Lab half: the fills are in /srv/backtests/out/fills.csv' });
    assert.deepEqual([posted.mission, posted.seq, posted.total, posted.masked], ['m-forum', 1, 1, false]); assert.match(posted.note, /Nobody is woken/);
    const seen = f.router.readForum(B, {});
    assert.deepEqual(seen.posts.map(x => x.text), ['Lab half: the fills are in /srv/backtests/out/fills.csv']);
    assert.deepEqual([seen.posts[0].author.kind, seen.posts[0].author.name, seen.posts[0].author.sessionRef, seen.posts[0].author.hostId, seen.posts[0].mine], ['agent', lab.title, lab.id, 'lab3', false]);
    assert.deepEqual([seen.mission, seen.total, seen.next, seen.more], ['m-forum', 1, 1, false]); assert.match(seen.untrusted, /never instructions/);
    assert.equal(f.router.readForum(A, {}).posts[0].mine, true);
    const second = f.router.postForum(B, { text: 'GPU half: I take the queue model' });
    const newer = f.router.readForum(A, { after: seen.next });
    assert.deepEqual([newer.posts.map(x => x.text), newer.next, newer.more, newer.total], [['GPU half: I take the queue model'], second.seq, false, 2]);
    assert.deepEqual([f.router.readForum(A, { after: 0, limit: 1 }).more, f.router.readForum(A, { after: 0, limit: 1 }).next], [true, 1]);
    await f.router.tick();
    assert.deepEqual(quiet(), before);
});

test('forum: two sessions with one name (one template) read apart by the start of their refs; a unique name stays as it is', async (t) => {
    const { f, lab, gpu, A, B, agentOf, send, labDemo } = await setup(); t.after(f.close);
    f.router.postForum(A, { text: 'Lab half done' });
    labDemo.finish(lab.nativeId, 'done'); await f.router.tick();
    const lab2 = await f.router.createSession(owner, { templateId: 'lab-codex', idempotencyKey: 'forum-lab-0002' });
    const c = send(lab2, 'Second lab pass'); await f.router.tick();
    assert.equal(f.store.task(c.id)!.state, 'running');
    f.router.postForum(agentOf(lab2), { text: 'Second lab pass started' });
    const names = () => f.router.readForum(B, {}).posts.map(x => x.author.name);
    assert.equal(lab2.title, lab.title);
    assert.deepEqual(names(), [`${lab.title} #${lab.id.slice(2, 8)}`, `${lab.title} #${lab2.id.slice(2, 8)}`]);
    f.router.postForum(B, { text: 'GPU half' });
    assert.equal(names()[2], gpu.title);
    f.router.annotate(owner, { kind: 'session', id: lab2.id, displayName: 'Lab second pass' });
    assert.deepEqual(names(), [lab.title, 'Lab second pass', gpu.title]);
});

test('forum: each mission turn carries one Router line with the post count; turns without a mission or a forum channel carry none', async (t) => {
    const { f, lab, gpu, b, A, send, labDemo, gpuDemo, promptOf } = await setup(); t.after(f.close);
    for (const s of [labDemo.sends[0].prompt, gpuDemo.sends[0].prompt]) assert.match(s, /\n\n\[Router\] 論壇 · mission m-forum · 0 posts\. Other sessions on this mission/);
    f.router.postForum(A, { text: 'Found the fills' });
    labDemo.finish(lab.nativeId, 'done'); await f.router.tick();
    const next = send(lab, 'Next step of the study'); await f.router.tick();
    assert.equal(f.store.task(next.id)!.state, 'running');
    assert.match(promptOf(next.id), /\[Router\] 論壇 · mission m-forum · 1 post\. /);
    labDemo.finish(lab.nativeId, 'done'); await f.router.tick();
    const chore = send(lab, 'An unrelated chore', {}); await f.router.tick();
    assert.equal(f.store.task(chore.id)!.state, 'running'); assert.ok(!promptOf(chore.id).includes(HINT));
    // a session the Router did not create (no creation record, no forum tools) on the same mission
    const found = send(f.session('gpu-research', 'agent-1'), 'Discovered helper on the mission'); await f.router.tick();
    assert.equal(f.store.task(found.id)!.state, 'running'); assert.ok(!promptOf(found.id).includes(HINT));
    // a reply with the source result: the Router line comes first, the untrusted result stays last
    const reply = f.router.reply(grok, { taskId: b.id, prompt: 'Follow up on the queue model', idempotencyKey: 'forum-reply-0001', includeSourceResult: true });
    gpuDemo.finish(gpu.nativeId, 'Queue model result 7'); await f.router.tick(); await f.router.tick();
    assert.equal(f.store.task(reply.id)!.state, 'running');
    assert.match(promptOf(reply.id), /Follow up on the queue model\n\n\[Router\] 論壇 · mission m-forum · 1 post\. [^\n]*\n\nResult of source task [^\n]*\nQueue model result 7$/);
});

test('forum: refusals — another mission, bad text, the owner without or with an unknown key, no scope, the schema, no mission, no turn', async (t) => {
    const { f, lab, gpu, A, B, send, labDemo, gpuDemo } = await setup(); t.after(f.close);
    assert.throws(() => f.router.postForum(A, { mission: 'other', text: 'x' }), code('FORUM_DENIED'));
    assert.throws(() => f.router.readForum(A, { mission: 'other' }), code('FORUM_DENIED'));
    assert.equal(f.router.readForum(A, { mission: 'm-forum' }).mission, 'm-forum');
    for (const text of ['', '   ', 'x'.repeat(2001), '測'.repeat(700)]) assert.throws(() => f.router.postForum(A, { text }), code('INVALID_ARGUMENT'), text.slice(0, 4));
    assert.throws(() => f.router.readForum(owner, {}), code('INVALID_ARGUMENT'));
    assert.throws(() => f.router.readForum(owner, { mission: 'no-such-mission' }), code('NOT_FOUND'));
    assert.equal(f.router.readForum(owner, { mission: 'm-forum' }).total, 0);
    assert.throws(() => f.router.readForum(principal('grokbot', { scopes: ['read', 'submit'] }), { mission: 'm-forum' }), code('FORBIDDEN'));
    // a front-end whose configured scopes wrongly list forum is still not the owner
    assert.throws(() => f.router.readForum(principal('grokbot', { scopes: ['read', 'forum'] }), { mission: 'm-forum' }), code('FORBIDDEN'));
    await assert.rejects(() => execute(f.router, A, 'psr_forum_read', { limit: 101 }), code('INVALID_ARGUMENT'));
    await assert.rejects(() => execute(f.router, A, 'psr_forum_post', { text: 'x', kind: 'note' }), code('INVALID_ARGUMENT'));
    labDemo.finish(lab.nativeId, 'done'); await f.router.tick();
    send(lab, 'A chore without a mission', {}); await f.router.tick();
    assert.throws(() => f.router.readForum(A, {}), code('NO_FORUM')); assert.throws(() => f.router.postForum(A, { text: 'x' }), code('NO_FORUM'));
    labDemo.finish(lab.nativeId, 'done'); gpuDemo.finish(gpu.nativeId, 'done'); await f.router.tick();
    assert.throws(() => f.router.readForum(A, {}), code('NO_ACTIVE_TASK')); assert.throws(() => f.router.postForum(B, { text: 'too late' }), code('NO_ACTIVE_TASK'));
});

test('forum: a missionId never names a local forum (repo:, dir:, solo:); an older task that has one gets no forum', async (t) => {
    const { f, lab, a, A, send } = await setup(); t.after(f.close);
    const local = ['repo:org-app-main-1a2b3c4d', 'dir:paseo-session-router-8c3976d4', 'solo:lm_0123456789'];
    for (const missionId of local) {
        assert.throws(() => send(lab, 'Join the local forum', { missionId }), code('INVALID_ARGUMENT'), missionId);
        assert.throws(() => f.router.setMission(owner, { taskIds: [a.id], missionId }), code('INVALID_ARGUMENT'), missionId);
    }
    const tasks = f.store.tasks().length;
    for (const missionId of ['repository:x', 'Dir:x', 'm-dir:x', 'solo']) send(lab, `Queued under ${missionId}`, { missionId });
    assert.equal(f.store.tasks().length, tasks + 4);
    // a task stored before the check (or edited in the database) with such a key: no forum, no Router line, its posts go nowhere
    f.store.putTask({ ...f.store.task(a.id)!, missionId: local[1] });
    assert.throws(() => f.router.readForum(A, {}), code('NO_FORUM'));
    assert.throws(() => f.router.postForum(A, { text: 'into the local forum' }), code('NO_FORUM'));
    assert.equal(f.store.all<ForumPost>('forum_post').filter(p => p.forum === local[1]).length, 0);
    assert.throws(() => f.router.readForum(owner, { mission: local[1] }), code('NOT_FOUND'));
});

test('forum: on an owner-only host a session uses it, and gets the Router line, only while it asks before acting', async (t) => {
    const { f, lab, A, send, labDemo, promptOf } = await setup(); t.after(f.close);
    f.config.hosts.find(h => h.id === 'lab3')!.humanApproval = true;
    assert.throws(() => f.router.readForum(A, {}), code('FORUM_DENIED')); assert.throws(() => f.router.postForum(A, { text: 'x' }), code('FORUM_DENIED'));
    labDemo.finish(lab.nativeId, 'done'); await f.router.tick();
    const next = send(lab, 'A turn on the owner-only host'); await f.router.tick(); await f.router.tick();
    assert.equal(f.store.task(next.id)!.state, 'running'); assert.ok(!promptOf(next.id).includes(HINT));
    labDemo.sessions.get(lab.nativeId)!.modeId = 'default'; await f.router.syncDirectory();
    assert.equal(f.router.readForum(A, {}).mission, 'm-forum'); assert.equal(f.router.postForum(A, { text: 'asking first now' }).seq, 1);
});

test('forum: once a session\'s channel credential expires, its mission turns carry no Router line', async (t) => {
    const { f, lab, gpu, send, labDemo, gpuDemo, promptOf } = await setup(); t.after(f.close);
    // the creation record keeps the credential's own expiry, for ordinary sessions as for seats
    const minted = JSON.parse(Buffer.from(token(f, lab.nativeId).slice('psra_'.length).split('.')[0], 'base64url').toString()).exp;
    assert.deepEqual([f.store.rows<{ sessionRef?: string; tokenExp?: number }>('creation').find(r => r.data.sessionRef === lab.id)!.data.tokenExp, minted], [f.now() + 30 * 86400000, f.now() + 30 * 86400000]);
    labDemo.finish(lab.nativeId, 'done'); gpuDemo.finish(gpu.nativeId, 'done'); await f.router.tick();
    f.advance(30 * 86400000); await f.router.syncDirectory();
    assert.throws(() => f.router.agentPrincipal(token(f, lab.nativeId)), code('UNAUTHORIZED'));
    const next = send(lab, 'A turn after the credential expired'); await f.router.tick();
    assert.equal(f.store.task(next.id)!.state, 'running'); assert.ok(!promptOf(next.id).includes(HINT));
});

test('forum: who gets the tools — ordinary http sessions created now; not observed sessions, seats, older sessions or revoked channels', async (t) => {
    const { f, lab, gpu, A, send, labDemo, gpuDemo, promptOf } = await setup(); t.after(f.close);
    const all = ['psr_post_message', 'psr_ask', 'psr_forum_read', 'psr_forum_post', 'psr_resources', 'psr_take', 'psr_release', 'psr_send_file', 'psr_receive_file'];
    assert.deepEqual([labDemo.channels.get(lab.nativeId)!.tools, A.scopes, visibleTools(A).map(x => x.name)], [all, ['report', 'ask', 'forum', 'resource', 'transfer'], all]);
    assert.deepEqual([forumTools(owner), forumTools(principal('muse', { scopes: ['read'] }))], [['psr_forum_read', 'psr_forum_post'], []]);
    // a service seat asks; it has no forum
    f.router.setPolicy(owner, { a2a: { services: SERVICES } });
    const seat = await f.router.createSession(owner, { templateId: 'svc-md', idempotencyKey: 'forum-seat-0001', role: 'service', service: 'market-data' }), seatAgent = f.router.agentPrincipal(token(f, seat.nativeId));
    assert.deepEqual([gpuDemo.channels.get(seat.nativeId)!.tools, seatAgent.scopes, visibleTools(seatAgent).map(x => x.name)], [['psr_ask'], ['ask'], ['psr_ask']]);
    assert.throws(() => f.router.readForum(seatAgent, { mission: 'm-forum' }), code('FORBIDDEN'));
    // a session created before the forum: its creation record lists no tools
    const row = f.store.rows<{ sessionRef?: string; tools?: string[] }>('creation').find(r => r.data.sessionRef === lab.id)!;
    assert.deepEqual(row.data.tools, all);
    const { tools, ...older } = row.data; f.store.put('creation', row.id, older, row.projectId, row.hostId);
    const legacy = f.router.agentPrincipal(token(f, lab.nativeId));
    assert.deepEqual([legacy.scopes, visibleTools(legacy).map(x => x.name)], [['report', 'ask'], ['psr_post_message', 'psr_ask']]);
    assert.throws(() => f.router.readForum(legacy, {}), code('FORBIDDEN'));
    labDemo.finish(lab.nativeId, 'done'); await f.router.tick();
    const old = send(lab, 'A turn on the older session'); await f.router.tick();
    assert.equal(f.store.task(old.id)!.state, 'running'); assert.ok(!promptOf(old.id).includes(HINT));
    // a revoked channel: no Router line on its next turn
    f.router.revokeAgentChannel(owner, gpu.id);
    gpuDemo.finish(gpu.nativeId, 'done'); await f.router.tick();
    const revoked = send(gpu, 'A turn after the revocation'); await f.router.tick();
    assert.equal(f.store.task(revoked.id)!.state, 'running'); assert.ok(!promptOf(revoked.id).includes(HINT));
    // an observed channel: the session only reports, and a daemon switched to observed takes the http session's forum away
    f.config.daemons.find(d => d.id === 'lab-test')!.agentChannel = { mode: 'observed' };
    const plain = await f.router.createSession(owner, { templateId: 'lab-codex', idempotencyKey: 'forum-observed-01' });
    assert.deepEqual(labDemo.channels.get(plain.nativeId)!.tools, ['psr_post_message']);
    assert.equal(f.store.rows<{ sessionRef?: string; tools?: string[] }>('creation').find(r => r.data.sessionRef === plain.id)!.data.tools, undefined);
    f.store.put('creation', row.id, row.data, row.projectId, row.hostId);
    const observed = f.router.agentPrincipal(token(f, lab.nativeId));
    assert.deepEqual([observed.scopes, visibleTools(observed).map(x => x.name)], [['report'], ['psr_post_message']]);
});

test('forum: the planner reads and posts on open goals only (toolset 5); its posts add no planner event', async (t) => {
    const f = await fixture(withPlannerTemplate); t.after(f.close);
    const { channel, planner } = await withPlanner(f);
    assert.ok(channel.tools.includes('psr_forum_read') && channel.tools.includes('psr_forum_post'));
    assert.deepEqual([f.router.getPolicy(owner).planner.currentToolset, f.router.getPolicy(owner).planner.outdated], [5, false]);
    assert.ok(planner.scopes.includes('forum')); assert.deepEqual(forumTools(planner), ['psr_forum_read', 'psr_forum_post']);
    const goal = f.router.submitGoal(owner, { text: '盤點各機器的磁碟', title: '磁碟', idempotencyKey: 'forum-goal-0001' });
    assert.deepEqual([f.router.readForum(planner, { mission: goal.id }).posts, f.router.plannerInbox(planner, {}).openGoals[0].forum], [[], { posts: 0, lastSeq: 0 }]);
    const events = f.store.meta('plannerSeq'), tasks = f.store.tasks().length;
    const posted = f.router.postForum(planner, { mission: goal.id, text: 'gpu1 和 lab3 分頭盤點，結果各自放在 /srv/out' });
    assert.deepEqual([f.store.meta('plannerSeq'), f.store.tasks().length], [events, tasks]);
    assert.deepEqual(f.router.plannerInbox(planner, {}).openGoals.find(g => g.id === goal.id)!.forum, { posts: 1, lastSeq: posted.seq });
    assert.deepEqual(f.router.readForum(planner, { mission: goal.id }).posts.map(x => [x.author.kind, x.author.name, x.mine]), [['planner', 'planner', true]]);
    assert.deepEqual(f.router.readForum(owner, { mission: goal.id }).posts.map(x => [x.author.kind, x.mine]), [['planner', false]]);
    assert.throws(() => f.router.readForum(planner, {}), code('INVALID_ARGUMENT'));
    f.router.submit(owner, { routeTicket: f.ticket(), prompt: 'Work on a plain mission', idempotencyKey: 'forum-plain-0001', missionId: 'm-plain' });
    assert.equal(f.router.readForum(owner, { mission: 'm-plain' }).total, 0);
    assert.throws(() => f.router.readForum(planner, { mission: 'm-plain' }), code('NOT_FOUND'));
    f.router.cancelGoal(owner, { goalId: goal.id });
    assert.throws(() => f.router.readForum(planner, { mission: goal.id }), code('NOT_FOUND')); assert.throws(() => f.router.postForum(planner, { mission: goal.id, text: 'x' }), code('NOT_FOUND'));
    assert.equal(f.router.readForum(owner, { mission: goal.id }).total, 1);
    // a planner created with an older toolset has no forum until it is re-created
    const pol = f.store.get<{ planner: object }>('policy', 'main')!; f.store.put('policy', 'main', { ...pol, planner: { ...pol.planner, toolsetVersion: 4 } });
    const older = f.router.agentPrincipal(channel.token);
    assert.deepEqual([older.scopes.includes('forum'), forumTools(older), f.router.getPolicy(owner).planner.outdated], [false, [], true]);
});

test('forum: at most 20 posts an hour per session and for the planner; the owner has no hourly limit', async (t) => {
    const { f, A, B } = await setup(withPlannerTemplate); t.after(f.close);
    for (let i = 0; i < 20; i++) f.router.postForum(A, { text: `note ${i}` });
    assert.throws(() => f.router.postForum(A, { text: 'one too many' }), code('RATE_LIMIT'));
    assert.equal(f.router.postForum(B, { text: 'another session has its own limit' }).total, 21);
    f.advance(3600000);
    assert.equal(f.router.postForum(A, { text: 'an hour later' }).total, 22);
    const { planner } = await withPlanner(f), goal = f.router.submitGoal(owner, { text: 'A goal to plan', idempotencyKey: 'forum-goal-rate-1' });
    for (let i = 0; i < 20; i++) f.router.postForum(planner, { mission: goal.id, text: `plan note ${i}` });
    assert.throws(() => f.router.postForum(planner, { mission: goal.id, text: 'one too many' }), code('RATE_LIMIT'));
    for (let i = 0; i < 25; i++) f.router.postForum(owner, { mission: goal.id, text: `owner note ${i}` });
    assert.equal(f.router.readForum(owner, { mission: goal.id }).total, 45);
});

test('forum: 200 posts are kept per forum (the oldest goes); after and limit page through it', async (t) => {
    const { f, A } = await setup(); t.after(f.close);
    const author = { kind: 'owner', clientId: 'web', sessionRef: null, hostId: null }, id = (seq: number) => `fp_${String(seq).padStart(12, '0')}`;
    f.store.tx(() => { for (let seq = 1; seq <= 200; seq++) f.store.put('forum_post', id(seq), { id: id(seq), seq, forum: 'm-forum', author, taskId: null, text: `old ${seq}`, at: f.now() - 7200000 }); f.store.setMeta('forumSeq', '200'); });
    const posted = f.router.postForum(A, { text: 'the newest' });
    assert.deepEqual([posted.seq, posted.total, f.store.get('forum_post', id(1)), !!f.store.get('forum_post', id(2))], [201, 200, undefined, true]);
    const latest = f.router.readForum(A, {});
    assert.deepEqual([latest.posts.length, latest.posts[0].seq, latest.posts.at(-1)!.text, latest.next, latest.more, latest.total], [30, 172, 'the newest', 201, false, 200]);
    const page = f.router.readForum(A, { after: 100, limit: 5 });
    assert.deepEqual([page.posts.map(x => x.seq), page.next, page.more], [[101, 102, 103, 104, 105], 105, true]);
    const end = f.router.readForum(A, { after: 199, limit: 5 });
    assert.deepEqual([end.posts.map(x => x.seq), end.next, end.more], [[200, 201], 201, false]);
    const none = f.router.readForum(A, { after: 201 });
    assert.deepEqual([none.posts, none.next, none.more], [[], 201, false]);
    assert.equal(f.router.readForum(A, { limit: 100 }).posts.length, 100);
    assert.throws(() => f.router.readForum(A, { limit: 0 }), code('INVALID_ARGUMENT'));
});

test('forum: secrets are masked when a post is stored; the mission key stays', async (t) => {
    const f = await fixture(withPlannerTemplate); t.after(f.close);
    const { planner } = await withPlanner(f), goal = f.router.submitGoal(owner, { text: 'Find the build', idempotencyKey: 'forum-goal-mask-1' });
    const commit = '3f9a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a';
    const r = f.router.postForum(planner, { mission: goal.id, text: `  token=abc123secret built ${commit} for ${goal.id}  ` });
    const stored = f.store.get<ForumPost>('forum_post', `fp_${String(r.seq).padStart(12, '0')}`)!;
    assert.equal(stored.text, `token=… built … for ${goal.id}`); assert.deepEqual([r.text, r.masked], [stored.text, true]);
    assert.deepEqual([stored.author, stored.taskId, stored.forum], [{ kind: 'planner', clientId: 'planner', sessionRef: null, hostId: null }, null, goal.id]);
    assert.equal(f.router.postForum(planner, { mission: goal.id, text: ' nothing secret ' }).masked, false);
    // a mask can be longer than what it hides ('a' → '…'): the stored post is bounded after masking
    const grown = f.router.postForum(planner, { mission: goal.id, text: 'key=a '.repeat(333) }), kept = f.store.get<ForumPost>('forum_post', `fp_${String(grown.seq).padStart(12, '0')}`)!;
    assert.deepEqual([Buffer.byteLength(kept.text) <= 2000, kept.text.startsWith('key=… key=…'), grown.text === kept.text, grown.masked], [true, true, true, true]);
});

test('forum: posts stay under their mission key when tasks are regrouped, and go once the mission is over and they are old', async (t) => {
    const { f, lab, gpu, a, b, A, labDemo, gpuDemo } = await setup(); t.after(f.close);
    const post = f.router.postForum(A, { text: 'before the regroup' });
    assert.equal(f.router.readForum(A, {}).posts[0].seq, post.seq);
    assert.equal(f.store.get<ForumPost>('forum_post', `fp_${String(post.seq).padStart(12, '0')}`)!.taskId, a.id);
    f.router.setMission(grok, { taskIds: [a.id, b.id], missionId: 'm-new' });
    assert.deepEqual([f.router.readForum(A, {}).mission, f.router.readForum(A, {}).total], ['m-new', 0]);
    assert.deepEqual(f.router.readForum(owner, { mission: 'm-forum' }).posts.map(x => x.text), ['before the regroup']);
    const goal = f.router.submitGoal(owner, { text: 'A goal that stays open', idempotencyKey: 'forum-goal-keep-1' });
    f.router.postForum(owner, { mission: goal.id, text: 'an owner note on an open goal' });
    labDemo.finish(lab.nativeId, 'done'); gpuDemo.finish(gpu.nativeId, 'done'); await f.router.tick();
    // m-forum has no task any more, but its post is young: the forum check (every 10 minutes) keeps it
    const texts = () => f.store.all<ForumPost>('forum_post').map(x => x.text).sort();
    f.advance(600001); await f.router.tick();
    assert.deepEqual(texts(), ['an owner note on an open goal', 'before the regroup']);
    // just before the post is old the check runs again; once it is old, the next check is 10 minutes after that one
    f.advance(f.config.limits.receiptMs - 600001 - 1000); await f.router.tick();
    f.advance(2000); await f.router.tick(); await f.router.tick();
    assert.deepEqual([f.store.task(a.id), f.store.task(b.id), texts()], [undefined, undefined, ['an owner note on an open goal', 'before the regroup']]);
    f.advance(600000); await f.router.tick();
    assert.deepEqual(f.store.all<ForumPost>('forum_post').map(x => [x.forum, x.text]), [[goal.id, 'an owner note on an open goal']]);
    assert.throws(() => f.router.readForum(owner, { mission: 'm-forum' }), code('NOT_FOUND'));
});
