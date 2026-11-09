import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, principal, code, withServices, SERVICES } from './helpers.js';
import { execute, visibleTools } from '../src/tools.js';
import { plannerOffers, plannerPrincipal } from '../src/planner.js';
import type { RouterConfig } from '../src/types.js';

const withPlannerTemplate = (c: RouterConfig) => { c.templates.push({ id: 'planner-tpl', daemonId: 'dev-app', cwd: '/srv/router', provider: 'claude/demo', title: 'Planner', modeId: 'default' }); };
type Rec = { sessionRef?: string; createdBy?: unknown; createdAt?: number };

async function plannerOf(f: Awaited<ReturnType<typeof fixture>>, key: string) {
    const setup = await f.router.setupPlanner(principal(), { templateId: 'planner-tpl', idempotencyKey: key });
    const channel = [...f.demos.get('dev-app')!.channels.values()].at(-1)!;
    assert(channel.mode === 'planner');
    return { ref: setup.planner.sessionRef!, channel, planner: f.router.agentPrincipal(channel.token) };
}

test('trees: a creation record keeps who asked for the session, the planner with its own session', async (t) => {
    const f = await fixture(withPlannerTemplate); t.after(f.close);
    const rec = (ref: string) => f.store.rows<Rec>('creation').find(r => r.data.sessionRef === ref)!.data;
    const mine = await f.router.createSession(principal('muse'), { templateId: 'lab-codex', idempotencyKey: 'tree-muse-0001' });
    assert.deepEqual([rec(mine.id).createdBy, rec(mine.id).createdAt], [{ clientId: 'muse', kind: 'muse', sessionRef: null }, f.now()]);
    const { ref, planner } = await plannerOf(f, 'tree-planner-01');
    assert.deepEqual(rec(ref).createdBy, { clientId: 'web', kind: 'web', sessionRef: null });
    f.advance(1000);
    const made = await f.router.createSession(planner, { templateId: 'lab-codex', idempotencyKey: 'tree-plan-00001' });
    assert.deepEqual([rec(made.id).createdBy, rec(made.id).createdAt], [{ clientId: 'planner', kind: 'planner', sessionRef: ref }, f.now()]);
});

test('trees: sessions grow under whoever created them; seats, older records and found sessions have their own groups', async (t) => {
    const f = await fixture(c => { withServices(c); withPlannerTemplate(c); }); t.after(f.close);
    const owner = principal(), muse = principal('muse');
    f.router.setPolicy(owner, { a2a: { services: SERVICES } });
    const seat = await f.router.createSession(owner, { templateId: 'svc-fx', idempotencyKey: 'tree-seat-0001', role: 'service', service: 'fx' }); f.advance(1000);
    const mine = await f.router.createSession(muse, { templateId: 'lab-codex', idempotencyKey: 'tree-muse-0001' }); f.advance(1000);
    const first = await plannerOf(f, 'tree-planner-01'); f.advance(1000);
    const made = await f.router.createSession(first.planner, { templateId: 'lab-codex', idempotencyKey: 'tree-plan-00001' }); f.advance(1000);
    const old = await f.router.createSession(owner, { templateId: 'lab-codex', idempotencyKey: 'tree-old-000001' });
    // a record written before the Router kept who asked
    const r = f.store.rows<Rec>('creation').find(r => r.data.sessionRef === old.id)!, { createdBy, createdAt, ...kept } = r.data;
    f.store.put('creation', r.id, kept, r.projectId, r.hostId, f.now());
    const found = f.sessions().filter(s => ![seat.id, mine.id, first.ref, made.id, old.id].includes(s.id)).map(s => s.id).sort();

    const tree = f.router.tree(owner, { of: 'sessions' }), refs = (g: { children: { sessionRef: string }[] }) => g.children.map(n => n.sessionRef);
    assert.deepEqual(tree.groups.map(g => g.id), ['planner', 'client:muse', 'seats', 'unrecorded', 'found']);
    const [plannerGroup, museGroup, seats, unrecorded, foundGroup] = tree.groups;
    assert.deepEqual(plannerGroup.children.map(n => [n.sessionRef, n.role, n.children.map(c => [c.sessionRef, c.createdBy?.kind])]), [[first.ref, 'planner', [[made.id, 'planner']]]]);
    assert.deepEqual([museGroup.entryKind, refs(museGroup)], ['muse', [mine.id]]);
    assert.deepEqual(seats.children.map(n => [n.sessionRef, n.role, n.service, n.channel]), [[seat.id, 'service', 'fx', 'http']]);
    assert.deepEqual([refs(unrecorded), unrecorded.children[0].createdBy], [[old.id], null]);
    assert.deepEqual(refs(foundGroup).sort(), found);
    assert.deepEqual([tree.total, tree.hasMore], [found.length + 5, false]);
    assert.equal(museGroup.children[0].hostId, 'lab3'); assert.equal(museGroup.children[0].status, 'idle');

    // the current planner is the one the Router answers; an older one keeps the sessions it created
    f.advance(1000);
    const second = await plannerOf(f, 'tree-planner-02');
    const again = f.router.tree(owner, { of: 'sessions' }).groups[0];
    assert.deepEqual(again.children.map(n => [n.sessionRef, n.role, n.children.length]), [[first.ref, 'former_planner', 1], [second.ref, 'planner', 0]]);

    // what a session is on: its active task, and how many of the caller's tasks wait for it; another caller sees neither
    const a = f.submit('first', muse, mine.id); f.submit('second', muse, mine.id); await f.router.tick();
    const node = () => f.router.tree(owner, { of: 'sessions' }).groups.find(g => g.id === 'client:muse')!.children[0];
    assert.deepEqual([node().status, node().task?.id, node().task?.state, node().task?.missionKey, node().queued], ['running', a.id, 'running', a.id, 1]);
    const stranger = principal('grokbot', { principalId: 'someone-else', scopes: ['read'] });
    const theirs = f.router.tree(stranger, { of: 'sessions' }).groups.find(g => g.id === 'client:muse')!.children[0];
    assert.deepEqual([theirs.task, theirs.queued], [null, 0]);

    // one machine: a planner-made session whose planner is out of view sits in the planner group itself
    const lab = f.router.tree(owner, { of: 'sessions', hostId: 'lab3' });
    assert.ok(lab.groups.flatMap(g => g.children).every(n => n.hostId === 'lab3'));
    assert.deepEqual(lab.groups.find(g => g.id === 'planner')!.children.map(n => [n.sessionRef, n.role]), [[made.id, null]]);
    assert.throws(() => f.router.tree(owner, { of: 'sessions', missionId: 'x' }), code('INVALID_ARGUMENT'));
    assert.throws(() => f.router.tree(owner, { of: 'sessions', hostId: 'nowhere' }), code('INVALID_ARGUMENT'));
});

test('trees: tasks grow per mission, by part, each follow-up under the step it continues', async (t) => {
    const f = await fixture(); t.after(f.close);
    const muse = principal('muse', { scopes: ['read', 'submit', 'handoff', 'goal'] }), gpu = f.session(), lab = f.session('lab-test');
    const send = (prompt: string, ref: string, key: string, extra: Record<string, unknown> = {}) => { const task = f.router.submit(muse, { routeTicket: f.ticket(muse, ref), prompt, idempotencyKey: key, missionId: 'node-upgrade', ...extra }); f.advance(1000); return task; };
    const data = send('collect data', gpu.id, 'tree-data-0001', { missionTitle: 'Node 升級', missionPart: '盤點' });
    const live = send('check live side', lab.id, 'tree-live-0001', { missionPart: '盤點' });
    const up = send('upgrade node\nthen report', gpu.id, 'tree-up-00001', { missionPart: '升級' });
    const child = await f.router.handoff(muse, { sourceTaskId: data.id, targetRouteTicket: f.ticket(muse, lab.id), idempotencyKey: 'tree-hand-0001', objective: 'Review the data', contextSummary: 'none', artifactRefs: [], acceptanceCriteria: [] }); f.advance(1000);
    const reply = f.router.reply(muse, { taskId: live.id, prompt: 'and the services?', idempotencyKey: 'tree-reply-001' }); f.advance(1000);
    const loose = f.submit('no mission'); f.advance(1000);
    const goal = f.router.submitGoal(muse, { text: '升級 Node 到 22.20', title: 'Node 目標', idempotencyKey: 'tree-goal-0001' });

    const owner = principal(), tree = f.router.tree(owner, { of: 'tasks' });
    assert.deepEqual(tree.missions.map(m => m.key), [goal.id, loose.id, 'node-upgrade']);
    const [g, solo, mission] = tree.missions;
    assert.deepEqual([g.named, g.state, g.goal, g.parts], [true, 'empty', { id: goal.id, title: 'Node 目標', state: goal.state }, []]);
    assert.deepEqual([solo.named, solo.name, solo.parts.map(p => [p.part, p.steps.map(s => s.id)])], [false, null, [[null, [loose.id]]]]);
    assert.deepEqual([mission.named, mission.name, mission.state, mission.counts.total, mission.hosts.sort()], [true, 'Node 升級', 'queued', 5, ['gpu1', 'lab3']]);
    const shape = (s: { id: string; kind: string; children: any[] }): unknown => [s.id, s.kind, s.children.map(shape)];
    assert.deepEqual(mission.parts.map(p => [p.part, p.steps.map(shape)]), [['盤點', [[data.id, 'work', [[child.id, 'handoff', []]]], [live.id, 'work', [[reply.id, 'reply', []]]]]], ['升級', [[up.id, 'work', []]]]]);
    const steps = mission.parts.flatMap(p => p.steps), review = steps[0].children[0];
    assert.deepEqual([steps[0].title, review.title, mission.parts[1].steps[0].title, review.session, review.from], ['collect data', 'Review the data', 'upgrade node', lab.title, { clientId: 'muse', kind: 'muse' }]);

    await f.router.tick();
    assert.equal(f.router.tree(owner, { of: 'tasks', missionId: 'node-upgrade' }).missions[0].state, 'running');
    // narrowing: one mission, one machine, a limit; another caller sees only its own work
    assert.deepEqual(f.router.tree(owner, { of: 'tasks', missionId: 'node-upgrade' }).missions.map(m => m.key), ['node-upgrade']);
    assert.deepEqual(f.router.tree(owner, { of: 'tasks', hostId: 'lab3' }).missions.map(m => m.key), ['node-upgrade']);
    const one = f.router.tree(owner, { of: 'tasks', limit: 1 });
    assert.deepEqual([one.missions.length, one.total, one.hasMore], [1, 3, true]); assert.ok(one.nextAction);
    assert.deepEqual(f.router.tree(principal('grokbot', { principalId: 'someone-else', scopes: ['read'] }), { of: 'tasks' }).missions, []);
});

test('machines: each host says what its sessions are doing, and only the Router\'s own machine is measured', async (t) => {
    const f = await fixture(c => { c.daemons.find(d => d.id === 'dev-app')!.agentChannel = { url: 'http://127.0.0.1:8787/mcp' }; c.daemons.find(d => d.id === 'lab-test')!.agentChannel = { url: 'https://psr.example.ts.net/mcp' }; }); t.after(f.close);
    f.submit('busy'); await f.router.tick();
    const hosts = f.router.listHosts(principal()), host = (id: string) => hosts.hosts.find(h => h.id === id)!;
    const onGpu = f.sessions().filter(s => s.hostId === 'gpu1').length;
    assert.deepEqual(host('gpu1').sessions, { total: onGpu, running: 1, waitingPermission: 0, offline: 0 });
    assert.deepEqual([host('gpu1').routerHere, host('gpu1').machine, host('lab3').routerHere, host('dev2').routerHere], [false, null, false, true]);
    const m = host('dev2').machine!;
    assert.ok(m.cpus >= 1 && m.memory.totalMb > 0 && m.memory.availableMb <= m.memory.totalMb && m.load.length === 3);
    assert.deepEqual(Object.fromEntries(hosts.daemons.map(d => [d.id, d.channel])), { 'gpu-research': null, 'gpu-review': null, 'dev-app': 'http', 'lab-test': 'http' });
    f.demos.get('lab-test')!.online = false; await f.router.syncDirectory();
    const lab = f.router.listHosts(principal()).hosts.find(h => h.id === 'lab3')!;
    assert.deepEqual([lab.sessions.offline, lab.sessions.total], [lab.sessions.total, f.sessions().filter(s => s.hostId === 'lab3').length]);
    // several machines reach the Router at a loopback address: no machine is claimed
    const g = await fixture(withServices); t.after(g.close);
    assert.ok(g.router.listHosts(principal()).hosts.every(h => !h.routerHere && h.machine === null));
});

test('planner: a tool of a later toolset stays hidden from a planner created before it, so it never asks to use it', async (t) => {
    const f = await fixture(withPlannerTemplate); t.after(f.close);
    assert.deepEqual([plannerOffers('psr_get_tree', 5), plannerOffers('psr_get_tree', 6), plannerOffers('psr_list_hosts', 1)], [false, true, true]);
    const { channel, planner } = await plannerOf(f, 'tree-planner-01');
    assert(channel.mode === 'planner');
    assert.ok(channel.tools.includes('psr_list_sessions') && !channel.tools.includes('psr_get_tree'));
    assert.ok(!visibleTools(planner).some(x => x.name === 'psr_get_tree'));
    await assert.rejects(() => execute(f.router, planner, 'psr_get_tree', { of: 'sessions' }), code('TOOL_NOT_FOUND'));
    assert.ok(visibleTools(plannerPrincipal('owner', 6)).some(x => x.name === 'psr_get_tree'));
    assert.ok(visibleTools(principal('muse', { scopes: ['read'] })).some(x => x.name === 'psr_get_tree'));
    assert.equal((await execute(f.router, principal(), 'psr_get_tree', { of: 'tasks' }) as { of: string }).of, 'tasks');
});
