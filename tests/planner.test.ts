import test from 'node:test';
import assert from 'node:assert/strict';
import { demoConfig, validateConfig } from '../src/config.js';
import { fixture, principal, code } from './helpers.js';
import { Router } from '../src/core.js';
const withPlannerTemplate = (c: any) => { c.templates.push({ id: 'planner-tpl', daemonId: 'dev-app', cwd: '/srv/router', provider: 'claude/demo', title: 'Planner', modeId: 'default' }); };
test('planner: the Router creates it with its own tools and credential, wakes it once per batch, and checks goals, plans and levels in code', async (t) => {
    const f = await fixture(withPlannerTemplate); t.after(f.close);
    const owner = principal();
    await assert.rejects(() => f.router.setupPlanner(owner, { templateId: 'lab-codex', idempotencyKey: 'planner-setup-0' }), code('INVALID_ARGUMENT'));
    await assert.rejects(() => f.router.setupPlanner(principal('muse', { scopes: ['read', 'create'] }), { templateId: 'planner-tpl', idempotencyKey: 'planner-setup-x' }), code('FORBIDDEN'));
    const setup = await f.router.setupPlanner(owner, { templateId: 'planner-tpl', idempotencyKey: 'planner-setup-1' });
    const plannerRef = setup.planner.sessionRef!, demo = f.demos.get('dev-app')!, channel = [...demo.channels.values()].at(-1)!;
    assert.equal(channel.mode, 'planner');
    if (channel.mode !== 'planner') return;
    assert.ok(channel.disallowedTools.includes('Bash') && channel.disallowedTools.includes('WebFetch'));
    assert.ok(channel.tools.includes('psr_planner_inbox') && channel.tools.includes('psr_respond_permission') && !channel.tools.includes('psr_set_policy') && !channel.tools.includes('psr_decide_plan'));
    assert.match(channel.systemPrompt, /untrusted data/);
    const planner = f.router.agentPrincipal(channel.token);
    assert.equal(planner.clientId, 'planner'); assert.equal(planner.entryKind, 'planner');

    // front-ends: the owner's ceiling, narrowed by the planner, never widened by it
    f.router.setPolicy(owner, { ceilings: { muse: ['read', 'goal', 'plan'] } });
    const muse = f.router.effective(principal('muse'));
    assert.deepEqual(muse.scopes, ['read', 'goal', 'plan']);
    assert.throws(() => f.router.submit(muse, { routeTicket: 'x', prompt: 'direct', idempotencyKey: 'muse-direct-01' }), code('FORBIDDEN'));
    assert.throws(() => f.router.setAccess(planner, { clientId: 'muse', scopes: ['read', 'goal', 'submit'] }), code('FORBIDDEN'));
    assert.deepEqual(f.router.setAccess(planner, { clientId: 'muse', scopes: ['read', 'goal'] }).effective, ['read', 'goal']);
    assert.throws(() => f.router.decidePlan(f.router.effective(principal('muse')), { goalId: 'goal_x', decision: 'approve' }), code('FORBIDDEN'));
    f.router.setAccess(planner, { clientId: 'muse', scopes: ['read', 'goal', 'plan'] });

    // a goal wakes the planner with one short turn; a second tick does not stack another
    const goal = f.router.submitGoal(muse, { text: '把研究機的 Node 升到 22.20，先盤點', title: 'Node 升級', idempotencyKey: 'goal-node-0001' });
    assert.equal(f.router.submitGoal(muse, { text: 'retry', idempotencyKey: 'goal-node-0001' }).id, goal.id);
    await f.router.tick();
    const feed = f.store.tasks().filter(x => x.system === 'planner_feed');
    assert.equal(feed.length, 1); assert.equal(feed[0].target, plannerRef); assert.match(feed[0].prompt, /goal_new×1.*psr_planner_inbox/);
    await f.router.tick(); assert.equal(f.store.tasks().filter(x => x.system === 'planner_feed').length, 1);
    const inbox = f.router.plannerInbox(planner, {});
    assert.deepEqual(inbox.events.map(e => e.kind), ['goal_new']); assert.equal(inbox.events[0].goal!.title, 'Node 升級'); assert.equal(inbox.openGoals[0].id, goal.id);
    f.router.plannerInbox(planner, { ack: inbox.ackUpTo });
    assert.equal(f.router.plannerInbox(planner, {}).events.length, 0);

    // the planner works only for open goals
    const gpu = f.session();
    assert.throws(() => f.router.submit(planner, { routeTicket: f.ticket(planner, gpu.id), prompt: 'look around', idempotencyKey: 'planner-loose-01' }), code('INVALID_ARGUMENT'));
    const work = f.router.submit(planner, { routeTicket: f.ticket(planner, gpu.id), prompt: '盤點 Node', idempotencyKey: 'planner-work-001', missionId: goal.id, missionPart: '盤點' });
    assert.equal(f.router.getTask(owner, work.id).missionName, 'Node 升級');
    await f.router.tick();
    const g = f.demos.get('gpu-research')!;
    g.permission('agent-1', { tool: 'Bash', detail: 'node --version' }); g.permission('agent-1', { tool: 'Bash', detail: 'nvm install 22.20' }); g.permission('agent-1', { tool: 'Bash', detail: 'sudo systemctl restart nginx' });
    await f.router.tick();
    const byCmd = async () => Object.fromEntries((await f.router.listPermissions(planner)).permissions.map(x => [x.detail, x]));
    let perms = await byCmd();
    assert.deepEqual([perms['node --version'].level, perms['nvm install 22.20'].level, perms['sudo systemctl restart nginx'].level], ['L0', 'L2', 'L3']);
    assert.equal(perms['node --version'].canRespond, true);
    assert.equal(perms['nvm install 22.20'].canRespond, false); assert.match(perms['nvm install 22.20'].reason!, /方案還沒批准/);
    assert.ok(f.router.plannerInbox(planner, {}).events.some(e => e.kind === 'permission_waiting' && e.taskId === work.id));

    // the plan goes to the front-end's inbox; only a front-end or the owner approves it
    f.router.postGoal(planner, { goalId: goal.id, kind: 'plan', text: '研究機 nvm install 22.20，裝完核對版本' });
    const note = (await f.router.waitMessages(muse, { timeoutMs: 0 })).messages.find(m => m.goalId === goal.id)!;
    assert.match(note.text, /方案待批/); assert.equal(note.toClientId, 'muse');
    assert.throws(() => f.router.decidePlan(planner, { goalId: goal.id, decision: 'approve' }), code('FORBIDDEN'));
    f.router.decidePlan(muse, { goalId: goal.id, decision: 'approve', note: '可以' });
    assert.equal(f.router.getGoal(muse, goal.id).state, 'active');
    perms = await byCmd();
    assert.equal(perms['nvm install 22.20'].canRespond, true);
    assert.equal(perms['sudo systemctl restart nginx'].canRespond, false);
    await assert.rejects(() => f.router.respondPermission(planner, { sessionRef: gpu.id, requestId: perms['sudo systemctl restart nginx'].requestId, decision: 'allow' }), code('FORBIDDEN'));
    const r = await f.router.respondPermission(planner, { sessionRef: gpu.id, requestId: perms['nvm install 22.20'].requestId, decision: 'allow' });
    assert.deepEqual([r.by, r.level], ['planner', 'L2']);

    // never its own session
    demo.permission([...demo.channels.keys()].at(-1)!, { tool: 'Bash', detail: 'ls' });
    await f.router.tick();
    const own = (await f.router.listPermissions(planner)).permissions.find(x => x.plannerSession)!;
    assert.equal(own.canRespond, false); assert.match(own.reason!, /自己/);
    assert.equal((await f.router.listPermissions(owner)).permissions.find(x => x.plannerSession)!.canRespond, true);

    // done closes the goal; a replaced planner's credential stops working
    f.router.postGoal(planner, { goalId: goal.id, kind: 'done', text: '研究機已是 22.20' });
    assert.equal(f.router.getGoal(owner, goal.id).state, 'done');
    assert.throws(() => f.router.submit(planner, { routeTicket: f.ticket(planner, gpu.id), prompt: 'more', idempotencyKey: 'planner-late-001', missionId: goal.id }), code('INVALID_ARGUMENT'));
    await f.router.setupPlanner(owner, { templateId: 'planner-tpl', idempotencyKey: 'planner-setup-2' });
    assert.throws(() => f.router.agentPrincipal(channel.token), code('UNAUTHORIZED'));
});
test('planner: goals are private to their front-end; canceling stops queued work; the owner policy is validated', async (t) => {
    const f = await fixture(withPlannerTemplate); t.after(f.close);
    const owner = principal();
    f.router.setPolicy(owner, { ceilings: { muse: ['read', 'goal', 'plan'], grokbot: ['read', 'goal'] } });
    const muse = f.router.effective(principal('muse')), grok = f.router.effective(principal('grokbot'));
    const goal = f.router.submitGoal(muse, { text: '整理上週成交', idempotencyKey: 'goal-private-01' });
    assert.throws(() => f.router.getGoal(grok, goal.id), code('NOT_FOUND'));
    assert.equal(f.router.listGoals(grok).goals.length, 0); assert.equal(f.router.listGoals(owner).goals.length, 1);
    assert.throws(() => f.router.replyGoal(grok, { goalId: goal.id, text: 'mine now' }), code('NOT_FOUND'));
    f.router.replyGoal(muse, { goalId: goal.id, text: '只要 BTC' });
    assert.deepEqual(f.router.getGoal(owner, goal.id).messages.map(m => m.kind), ['goal', 'reply']);
    f.router.cancelGoal(muse, { goalId: goal.id, reason: '不做了' });
    assert.equal(f.router.getGoal(muse, goal.id).state, 'canceled');
    assert.throws(() => f.router.replyGoal(muse, { goalId: goal.id, text: 'again' }), code('CONFLICT'));
    f.router.setPolicy(owner, { ceilings: { dot: ['read'] } });
    assert.throws(() => f.router.submitGoal(f.router.effective(principal('dot')), { text: 'x', idempotencyKey: 'goal-dot-0001' }), code('FORBIDDEN'));

    const pol = f.router.setPolicy(owner, { approvers: { L2: [], L4: ['planner'] }, rules: [{ id: 'strategy', level: 'L4', pattern: '^python3 /home/ubuntu/strategy/' }], disabled: ['trading'] });
    assert.deepEqual(pol.levels.find(l => l.id === 'L2')!.approvers, []); assert.deepEqual(pol.levels.find(l => l.id === 'L4')!.approvers, []);
    assert.equal(pol.builtinRules.find(r => r.id === 'trading')!.enabled, false);
    assert.equal(f.router.classifyPermission(owner, { tool: 'Bash', detail: 'python3 /home/ubuntu/strategy/run.py' }).level, 'L4');
    assert.equal(f.router.classifyPermission(owner, { tool: 'Bash', detail: 'touch notes.md', sessionRef: f.session().id }).level, 'L1');
    for (const bad of [{ rules: [{ id: 'x', level: 'L1', pattern: '(' }] }, { approvers: { L9: [] } }, { approvers: { L1: ['everyone'] } }, { disabled: ['no-such-rule'] }, { ceilings: { web: ['read'] } }, { ceilings: { muse: ['admin'] } }, { planner: { enabled: true } }, { planner: { batchMs: 5 } }])
        assert.throws(() => f.router.setPolicy(owner, bad as any), code('INVALID_ARGUMENT'), JSON.stringify(bad));
    assert.throws(() => f.router.setPolicy(muse, { approvers: { L2: ['frontend'] } }), code('FORBIDDEN'));
});
test('planner: its creation record says planner, written at creation and stamped on an older record at the first start', async (t) => {
    const f = await fixture(withPlannerTemplate); t.after(f.close);
    const setup = await f.router.setupPlanner(principal(), { templateId: 'planner-tpl', idempotencyKey: 'planner-setup-1' });
    const rec = () => f.store.rows<{ sessionRef?: string; channel?: string }>('creation').find(r => r.data.sessionRef === setup.planner.sessionRef)!;
    assert.equal(rec().data.channel, 'planner');
    const { channel, ...old } = rec().data; f.store.put('creation', rec().id, old, rec().projectId, rec().hostId, f.now());
    f.store.setMeta('creationChannelBackfill', '');
    new Router(f.config, f.store, f.adapters, f.now);
    assert.equal(rec().data.channel, 'planner');
});
test('planner: only templates whose daemon reaches the Router at the planner URL can host it; with none, any Claude template', async (t) => {
    const owner = principal(), loopback = 'http://127.0.0.1:8787/mcp', tailnet = 'https://router.example.ts.net/mcp';
    const more = (c: any) => {
        withPlannerTemplate(c);
        const gpu = c.daemons.find((d: any) => d.id === 'gpu-research');
        gpu.mappings.push({ cwd: '/srv/seat-p', projectId: 'hft', workspaceId: 'seat-p', mutationDomainId: 'seat-p', releasePolicy: 'on_turn_end' });
        c.templates.push({ id: 'gpu-claude', daemonId: 'gpu-research', cwd: '/srv/hft', provider: 'claude/demo', title: 'GPU Claude' }, { id: 'seat-p', daemonId: 'gpu-research', cwd: '/srv/seat-p', provider: 'claude/demo', title: 'Seat', modeId: 'default', seat: true });
    };
    const ids = (f: any) => f.router.getPolicy(owner).planner.templates.map((x: any) => x.id);
    const open = await fixture(more); t.after(open.close);
    assert.deepEqual(ids(open), ['planner-tpl', 'gpu-claude']);
    await assert.rejects(() => open.router.setupPlanner(owner, { templateId: 'seat-p', idempotencyKey: 'planner-seat-1' }), code('INVALID_ARGUMENT'));

    const local = await fixture(c => { more(c); c.daemons.find(d => d.id === 'dev-app')!.agentChannel = { mode: 'http', url: loopback }; c.daemons.find(d => d.id === 'lab-test')!.agentChannel = { mode: 'http', url: tailnet }; }); t.after(local.close);
    assert.deepEqual(ids(local), ['planner-tpl']);
    local.router.annotate(owner, { kind: 'template', id: 'planner-tpl', displayName: '規劃者' });
    assert.deepEqual(local.router.getPolicy(owner).planner.templates, [{ id: 'planner-tpl', title: '規劃者', provider: 'claude/demo', hostId: 'dev2' }]);
    await assert.rejects(() => local.router.setupPlanner(owner, { templateId: 'gpu-claude', idempotencyKey: 'planner-gpu-1' }), (e: Error) => code('INVALID_ARGUMENT')(e) && e.message.includes(loopback));
    await local.router.setupPlanner(owner, { templateId: 'planner-tpl', idempotencyKey: 'planner-local-1' });
    const channel = [...local.demos.get('dev-app')!.channels.values()].at(-1)!;
    assert.equal(channel.mode, 'planner'); assert.equal(channel.mode === 'planner' && channel.url, loopback);

    const remote = await fixture(c => { more(c); c.planner = { mcpUrl: tailnet }; c.daemons.find(d => d.id === 'dev-app')!.agentChannel = { mode: 'http', url: loopback }; c.daemons.find(d => d.id === 'gpu-research')!.agentChannel = { url: 'https://ROUTER.example.ts.net:443/mcp' }; }); t.after(remote.close);
    assert.deepEqual(ids(remote), ['gpu-claude']);

    for (const bad of ['http://10.0.0.5:8787/mcp', 'https://router.example.ts.net/api', 'https://u:p@router.example.ts.net/mcp']) {
        const c = demoConfig('/tmp/not-used'); c.planner = { mcpUrl: bad };
        assert.throws(() => validateConfig(c), (e: Error) => /planner\.mcpUrl must be an \/mcp URL/.test(e.message), bad);
    }
    const fine = demoConfig('/tmp/not-used'); fine.planner = { mcpUrl: tailnet }; validateConfig(fine);
});
