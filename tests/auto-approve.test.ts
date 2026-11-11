import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, principal, code } from './helpers.js';
import { execute } from '../src/tools.js';
import { AUTO_DANGER_PER_TASK } from '../src/auto-approve.js';
import type { Principal, RouterConfig } from '../src/types.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const owner = principal();
const bot = (id: string) => principal(id, { scopes: ['read', 'goal', 'plan', 'submit', 'approve'] });
const grok = bot('grokbot'), muse = bot('muse');
const RESTART = 'sudo systemctl restart nginx';

/** One task of `p` on a session of the research machine, with these requests waiting, after the Router had a tick to answer. */
async function waiting(f: Fixture, p: Principal, requests: (string | { tool: string; detail: string })[], native = 'agent-1') {
    const demo = f.demos.get('gpu-research')!, task = f.submit('work', p, f.session('gpu-research', native).id);
    await f.router.tick();
    const reqs = requests.map(r => demo.permission(native, typeof r === 'string' ? { tool: 'Bash', detail: r } : r));
    await f.router.tick();
    return { task, demo, reqs, more: async (detail: string) => { const r = demo.permission(native, { tool: 'Bash', detail }); await f.router.tick(); return r; } };
}
/** Which of these requests the Router allowed, in order. */
const allowed = (demo: { answers: { requestId: string; allow: boolean }[] }, reqs: { id: string; detail: string | null }[]) => demo.answers.filter(a => a.allow && reqs.some(r => r.id === a.requestId)).map(a => reqs.find(r => r.id === a.requestId)!.detail);
/** Why a request still waits, as the console shows it once the Router has looked again (after one request of a session is
 * answered, its others are listed again from the next tick). */
const whyOf = async (f: Fixture, requestId: string) => { await f.router.tick(); return (await f.router.listPermissions(owner)).permissions.find(x => x.requestId === requestId)?.autoWhy; };
const auto = (f: Fixture, input: Record<string, unknown>) => f.router.setPolicy(owner, { autoApprove: input }).autoApprove;

test('auto-approve: off until the owner sets it; the policy lists the sources a setting may name', async (t) => {
    const f = await fixture(c => { c.hosts.find(h => h.id === 'dev2')!.humanApproval = true; }); t.after(f.close);
    const a = f.router.getPolicy(owner).autoApprove;
    assert.deepEqual([a.all, a.trusted, a.sources, a.secrets, a.until, a.active, a.perTask], [null, null, [], false, null, false, AUTO_DANGER_PER_TASK]);
    // every client that sends work, and every machine whose local sessions may ask for helpers (never an owner-only one)
    assert.deepEqual(a.sourceChoices.map(x => x.id), ['client:web', 'client:grokbot', 'client:dot', 'client:muse', 'client:cli', 'helper:gpu1', 'helper:lab3']);
    const { demo, reqs } = await waiting(f, owner, ['ls -la']);
    assert.deepEqual(demo.answers, []);
    assert.equal(await whyOf(f, reqs[0].id), null, 'nothing to explain while it is off');
});

test('auto-approve: a dangerous request is allowed only in a task of a trusted source, and the answer is kept on the task', async (t) => {
    const f = await fixture(); t.after(f.close);
    const set = auto(f, { trusted: 'L3', sources: ['client:grokbot'] });
    assert.deepEqual([set.trusted, set.sources, set.active], ['L3', ['client:grokbot'], true]);
    const mine = await waiting(f, grok, [RESTART, 'node --version']), theirs = await waiting(f, muse, [RESTART, 'node --version'], 'agent-2');
    assert.deepEqual(allowed(mine.demo, mine.reqs), [RESTART, 'node --version']);
    assert.deepEqual(f.store.task(mine.task.id)!.approvals!.map(x => [x.decision, x.by, x.detail, x.level, x.rule]), [['allow', 'router', RESTART, 'L3', 'auto:client:grokbot'], ['allow', 'router', 'node --version', 'L0', 'auto:client:grokbot']]);
    await f.router.tick();
    assert.equal(f.store.task(mine.task.id)!.state, 'running');
    // the same commands in another client's task wait as before: the level is within reach, the source is not trusted
    assert.deepEqual(allowed(theirs.demo, theirs.reqs), []);
    assert.equal(f.store.task(theirs.task.id)!.state, 'waiting_permission');
    assert.deepEqual([await whyOf(f, theirs.reqs[0].id), await whyOf(f, theirs.reqs[1].id)], ['source', 'source']);
    // never a deny, and the owner still answers by hand
    assert.ok(theirs.demo.answers.every(x => x.allow));
    assert.equal((await f.router.respondPermission(owner, { sessionRef: f.session('gpu-research', 'agent-2').id, requestId: theirs.reqs[0].id, decision: 'allow' })).by, 'web');
});

test('auto-approve: ordinary requests of every task are allowed up to the level the owner chose, whoever sent it', async (t) => {
    const f = await fixture(); t.after(f.close);
    auto(f, { all: 'L1' });
    const edit = { tool: 'Edit', detail: JSON.stringify({ file_path: '/srv/hft/model.py' }) };
    const { task, demo, reqs } = await waiting(f, muse, ['ls -la', edit, 'npm install left-pad', RESTART]);
    assert.deepEqual(allowed(demo, reqs), ['ls -la', edit.detail]);
    assert.deepEqual(f.store.task(task.id)!.approvals!.map(x => [x.level, x.rule]), [['L0', 'auto:all'], ['L1', 'auto:all']]);
    // nobody is trusted for more, so both are simply above the level
    assert.deepEqual([await whyOf(f, reqs[2].id), await whyOf(f, reqs[3].id)], ['level', 'level']);
    // a trusted source gets the higher level; what the ordinary level covers is recorded as that
    auto(f, { trusted: 'L3', sources: ['client:muse'] });
    await f.router.tick();
    assert.deepEqual(allowed(demo, reqs), ['ls -la', edit.detail, 'npm install left-pad', RESTART]);
    assert.deepEqual(f.store.task(task.id)!.approvals!.slice(2).map(x => [x.level, x.rule]), [['L2', 'auto:client:muse'], ['L3', 'auto:client:muse']]);
});

test('auto-approve: full access (L4) allows what the rules do not recognise, but a credential only when the owner said so', async (t) => {
    const f = await fixture(); t.after(f.close);
    auto(f, { trusted: 'L3', sources: ['client:grokbot'] });
    const { demo, reqs } = await waiting(f, grok, ['frobnicate --all', 'cat .env']);
    assert.deepEqual(allowed(demo, reqs), []);
    assert.deepEqual([await whyOf(f, reqs[0].id), await whyOf(f, reqs[1].id)], ['level', 'level']);
    auto(f, { trusted: 'L4' });
    await f.router.tick();
    assert.deepEqual(allowed(demo, reqs), ['frobnicate --all']);
    assert.equal(await whyOf(f, reqs[1].id), 'secret');
    assert.equal(auto(f, { secrets: true }).secrets, true);
    await f.router.tick();
    assert.deepEqual(allowed(demo, reqs), ['frobnicate --all', 'cat .env']);
});

test('auto-approve: never on an owner-only machine', async (t) => {
    const f = await fixture(c => { c.hosts.find(h => h.id === 'gpu1')!.humanApproval = true; }); t.after(f.close);
    auto(f, { all: 'L2', trusted: 'L4', sources: ['client:web', 'client:cli'], secrets: true });
    const { task, demo, reqs } = await waiting(f, owner, ['ls -la']);
    await f.router.tick();
    assert.deepEqual(demo.answers, []);
    assert.equal(f.store.task(task.id)!.state, 'waiting_permission');
    assert.equal(await whyOf(f, reqs[0].id), null, 'the request already says that only the owner answers there');
});

test('auto-approve: only a request of the task\'s own turn: not while its delivery is unknown, not while the session runs another turn', async (t) => {
    const f = await fixture(); t.after(f.close);
    auto(f, { all: 'L2', trusted: 'L4', sources: ['client:web'] });
    const demo = f.demos.get('gpu-research')!;
    // the Router cannot tell whether its prompt arrived: what the session asks now may be someone else's
    demo.fault = 'before_send';
    const lost = f.submit('work', owner);
    await f.router.tick();
    assert.equal(f.store.task(lost.id)!.state, 'delivery_unknown');
    const first = demo.permission('agent-1', { tool: 'Bash', detail: 'ls -la' });
    await f.router.tick();
    assert.equal(demo.answers.length, 0);
    assert.equal(await whyOf(f, first.id), null);
    // a task at work, but the session's active turn is not the task's (someone typed into the session directly)
    assert.equal(demo.fault, 'none');
    const mine = f.submit('work', owner, f.session('gpu-research', 'agent-2').id);
    await f.router.tick();
    assert.equal(f.store.task(mine.id)!.state, 'running');
    demo.sessions.get('agent-2')!.activeTurnId = 'typed-in-paseo';
    const other = demo.permission('agent-2', { tool: 'Bash', detail: 'ls -la' });
    await f.router.tick();
    assert.ok(!demo.answers.some(x => x.requestId === other.id));
    assert.equal(await whyOf(f, other.id), null);
});

/** As in the helper tests: the lab machine maps any folder; a local session is a joined member of a machine credential. */
async function withHelpers() {
    const f = await fixture((c: RouterConfig) => { const lab = c.daemons.find(d => d.id === 'lab-test')!; lab.autoMap = { projectId: 'lab', releasePolicy: 'on_turn_end' }; });
    const creds = new Map<string, string>();
    const join = (hostId: string, cwd: string) => {
        const issued = f.router.issueLocalCredential(owner, { hostId }), cred = f.router.localPrincipal(issued.token), place = { cwd, repo: null, branch: null };
        creds.set(hostId, issued.credentialId);
        return f.router.touchLocal(cred, f.router.joinLocal(cred, { place, client: { name: 'claude-code', version: '1' } }).id, place, null);
    };
    const lab = f.demos.get('lab-test')!;
    /** A helper the owner approved by hand, at work. */
    const start = async (asker: Principal, cwd: string) => {
        const r = f.router.localHelperRequest(asker, { template: 'lab-codex', cwd, task: 'Restart the thing.' });
        const v = await f.router.decideHelper(owner, { requestId: r.requestId, decision: 'approve' });
        await f.router.tick();
        return { requestId: r.requestId, taskId: v.taskId!, native: f.sessions().find(s => s.id === v.sessionRef)!.nativeId };
    };
    /** One dangerous request of that session, after the Router had a tick to answer. */
    const danger = async (native: string) => { const req = lab.permission(native, { tool: 'Bash', detail: RESTART }); await f.router.tick(); return req; };
    return { f, join, start, danger, lab, creds };
}
test('auto-approve: a helper\'s task comes from the machine whose local session asked, not from who approved its start', async (t) => {
    const { f, join, start, danger, lab } = await withHelpers(); t.after(f.close);
    // the owner's own console is trusted too: it approved both helpers, and that makes neither of them the console's task
    auto(f, { trusted: 'L3', sources: ['helper:gpu1', 'client:web'] });
    const mac = await start(join('gpu1', '/w/app'), '/srv/proj-a'), other = await start(join('lab3', '/w/else'), '/srv/proj-b');
    const mine = await danger(mac.native), theirs = await danger(other.native);
    assert.deepEqual(lab.answers.map(x => [x.requestId, x.allow]), [[mine.id, true]]);
    assert.deepEqual(f.store.task(mac.taskId)!.approvals!.map(x => [x.by, x.level, x.rule]), [['router', 'L3', 'auto:helper:gpu1']]);
    assert.equal(f.store.task(other.taskId)!.state, 'waiting_permission');
    assert.equal(await whyOf(f, theirs.id), 'source');
});

test('auto-approve: a helper\'s task sent again after a transient failure is still its asker\'s, not the client it is re-sent as', async (t) => {
    const { f, join, start, danger, lab } = await withHelpers(); t.after(f.close);
    auto(f, { trusted: 'L3', sources: ['client:web'] });
    const first = await start(join('lab3', '/w/else'), '/srv/proj-b');
    lab.finish(first.native, 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    await f.router.tick(); await f.router.tick();
    const retry = f.store.tasks().find(x => x.retryOf === first.taskId)!;
    assert.deepEqual([retry.originClientId, retry.helperOf], ['web', first.requestId]);
    await f.router.tick();
    const req = await danger(first.native);
    assert.equal(lab.answers.length, 0);
    assert.equal(await whyOf(f, req.id), 'source');
    auto(f, { sources: ['helper:lab3'] });
    await f.router.tick();
    assert.deepEqual(lab.answers.map(x => [x.requestId, x.allow]), [[req.id, true]]);
    assert.deepEqual(f.store.task(retry.id)!.approvals!.map(x => x.rule), ['auto:helper:lab3']);
});

const withPlanner = async () => {
    const f = await fixture(c => { c.templates.push({ id: 'planner-tpl', daemonId: 'dev-app', cwd: '/srv/router', provider: 'claude/demo', title: 'Planner', modeId: 'default' }); });
    const setup = await f.router.setupPlanner(owner, { templateId: 'planner-tpl', idempotencyKey: 'planner-setup-1' });
    const dev = f.demos.get('dev-app')!, channel = [...dev.channels.values()].at(-1)!;
    assert.equal(channel.mode, 'planner');
    return { f, dev, ref: setup.planner.sessionRef!, native: [...dev.channels.keys()].at(-1)!, planner: f.router.agentPrincipal(channel.mode === 'planner' ? channel.token : '') };
};
test('auto-approve: never the planner\'s own session, in its own turns or in a task sent to it', async (t) => {
    for (const how of ['feed', 'task'] as const) {
        const { f, dev, ref, native } = await withPlanner(); t.after(f.close);
        auto(f, { all: 'L2', trusted: 'L4', sources: ['client:web', 'client:grokbot'] });
        if (how === 'feed') f.router.submitGoal(grok, { text: '看一下研究機', idempotencyKey: 'goal-auto-planner-1' }); else f.submit('look around', owner, ref);
        await f.router.tick();
        const turn = f.store.tasks().find(x => x.target === ref)!;
        assert.equal(turn.system ?? null, how === 'feed' ? 'planner_feed' : null);
        const req = dev.permission(native, { tool: 'Bash', detail: 'ls -la' });
        await f.router.tick();
        assert.equal(dev.answers.length, 0, how);
        assert.equal(await whyOf(f, req.id), null, how);
    }
});

test('auto-approve: a task the planner sends is nobody\'s word, even for a trusted client\'s goal with an approved plan', async (t) => {
    const { f, planner } = await withPlanner(); t.after(f.close);
    const gpu = f.demos.get('gpu-research')!;
    auto(f, { all: 'L0', trusted: 'L3', sources: ['client:grokbot'] });
    const goal = f.router.submitGoal(grok, { text: '重啟研究機的 nginx', idempotencyKey: 'goal-auto-approve-1' });
    const task = f.router.submit(planner, { routeTicket: f.ticket(planner, f.session().id), prompt: 'restart nginx', idempotencyKey: 'planner-auto-work-1', missionId: goal.id });
    f.router.postGoal(planner, { goalId: goal.id, kind: 'plan', text: '重啟 nginx，然後核對狀態' });
    f.router.decidePlan(grok, { goalId: goal.id, decision: 'approve' });
    await f.router.tick();
    assert.equal(f.store.task(task.id)!.state, 'running');
    const danger = gpu.permission('agent-1', { tool: 'Bash', detail: RESTART }), read = gpu.permission('agent-1', { tool: 'Bash', detail: 'ls -la' });
    await f.router.tick();
    // the planner reads every client's goals and every session's results: what it writes gets the ordinary reach only
    assert.deepEqual(gpu.answers.map(x => [x.requestId, x.allow]), [[read.id, true]]);
    assert.equal(await whyOf(f, danger.id), 'source');
});

test('auto-approve: a helper source stops counting when its machine\'s credential is revoked, or the machine becomes owner-only', async (t) => {
    for (const how of ['revoked', 'owner-only'] as const) {
        const { f, join, start, danger, lab, creds } = await withHelpers(); t.after(f.close);
        auto(f, { trusted: 'L3', sources: ['helper:gpu1'] });
        const h = await start(join('gpu1', '/w/app'), '/srv/proj-a');
        const before = await danger(h.native);
        assert.deepEqual(lab.answers.map(x => [x.requestId, x.allow]), [[before.id, true]], how);
        if (how === 'revoked') f.router.revokeLocalCredential(owner, { credentialId: creds.get('gpu1')! }); else f.config.hosts.find(x => x.id === 'gpu1')!.humanApproval = true;
        const after = await danger(h.native);
        assert.equal(lab.answers.length, 1, how);
        assert.equal(await whyOf(f, after.id), 'source', how);
    }
});

test('auto-approve: switched off while the Router is asking a daemon, it allows nothing more', async (t) => {
    const f = await fixture(); t.after(f.close);
    auto(f, { trusted: 'L3', sources: ['client:grokbot'] });
    const demo = f.demos.get('gpu-research')!;
    f.submit('work', grok);
    await f.router.tick();
    demo.permission('agent-1', { tool: 'Bash', detail: RESTART });
    // the owner presses "off" in the moment between the Router's question to the daemon and its answer
    const lookup = demo.permissions.bind(demo);
    demo.permissions = async (id: string) => { const list = await lookup(id); auto(f, { all: null, trusted: null }); return list; };
    await f.router.tick();
    assert.equal(demo.answers.length, 0);
});

test('auto-approve: a credential stays the owner\'s even with the built-in secret rule switched off', async (t) => {
    const f = await fixture(); t.after(f.close);
    f.router.setPolicy(owner, { disabled: ['secret'] });
    auto(f, { all: 'L2' });
    const { demo, reqs } = await waiting(f, muse, ['cat .env', 'ls -la']);
    assert.deepEqual(allowed(demo, reqs), ['ls -la']);
    assert.equal(await whyOf(f, reqs[0].id), 'secret');
    assert.equal((await f.router.listPermissions(owner)).permissions.find(x => x.requestId === reqs[0].id)!.level, 'L0', 'without the rule a credential read ranks as any read');
    // and the credentials flag is for the dangerous reach of a trusted source, never for the ordinary one
    auto(f, { secrets: true });
    await f.router.tick();
    assert.deepEqual(allowed(demo, reqs), ['ls -la']);
});

test('auto-approve: a task sent again after a transient failure keeps what it used of its dangerous share', async (t) => {
    const f = await fixture(); t.after(f.close);
    auto(f, { trusted: 'L3', sources: ['client:grokbot'] });
    const { task, demo, reqs } = await waiting(f, grok, [RESTART]);
    assert.deepEqual(allowed(demo, reqs), [RESTART]);
    await f.router.tick();
    demo.finish('agent-1', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    await f.router.tick(); await f.router.tick();
    assert.equal(f.store.tasks().find(x => x.retryOf === task.id)!.autoDanger, 1);
});

test('auto-approve: it ends by itself when its time is up', async (t) => {
    const f = await fixture(); t.after(f.close);
    const set = auto(f, { all: 'L0', hours: 1 });
    assert.deepEqual([set.active, set.until], [true, f.now() + 3600000]);
    const { demo, reqs, more } = await waiting(f, muse, ['ls -la']);
    assert.deepEqual(allowed(demo, reqs), ['ls -la']);
    f.advance(3600001);
    const late = await more('pwd');
    assert.ok(!demo.answers.some(x => x.requestId === late.id));
    assert.equal(f.router.getPolicy(owner).autoApprove.active, false);
    assert.equal(await whyOf(f, late.id), null);
    // another change does not bring it back; a new period does
    assert.equal(auto(f, { all: 'L1' }).active, false);
    assert.equal(auto(f, { hours: null }).active, true);
    await f.router.tick();
    assert.ok(demo.answers.some(x => x.requestId === late.id && x.allow));
});

test('auto-approve: one task gets only so many dangerous requests allowed; ordinary ones go on', async (t) => {
    const f = await fixture(); t.after(f.close);
    auto(f, { trusted: 'L3', sources: ['client:grokbot'] });
    const kills = Array.from({ length: AUTO_DANGER_PER_TASK + 2 }, (_, i) => `kill ${1000 + i}`);
    const { task, demo, reqs, more } = await waiting(f, grok, kills);
    assert.equal(demo.answers.length, AUTO_DANGER_PER_TASK);
    assert.equal(f.store.task(task.id)!.autoDanger, AUTO_DANGER_PER_TASK);
    assert.equal(await whyOf(f, reqs.at(-1)!.id), 'cap');
    const read = await more('ls -la');
    assert.ok(demo.answers.some(x => x.requestId === read.id && x.allow));
    assert.equal(demo.answers.length, AUTO_DANGER_PER_TASK + 1);
});

test('auto-approve: a request shown cut short is the owner\'s to read', async (t) => {
    const f = await fixture(); t.after(f.close);
    auto(f, { all: 'L2', trusted: 'L4', sources: ['client:grokbot'] });
    const { demo, reqs } = await waiting(f, grok, [`ls ${'x'.repeat(60)}…`]);
    assert.deepEqual(demo.answers, []);
    assert.equal(await whyOf(f, reqs[0].id), 'truncated');
});

test('auto-approve: only the owner sets it, field by field; a partial change keeps the rest', async (t) => {
    const f = await fixture(c => { c.hosts.find(h => h.id === 'dev2')!.humanApproval = true; }); t.after(f.close);
    assert.throws(() => f.router.setPolicy(muse, { autoApprove: { all: 'L0' } }), code('FORBIDDEN'));
    const bad = (input: unknown) => assert.throws(() => f.router.setPolicy(owner, { autoApprove: input }), code('INVALID_ARGUMENT'), JSON.stringify(input));
    // ordinary means at most L2, dangerous means L3 or L4; a source is a client or a machine helpers are asked from
    for (const x of [null, [], { all: 'L3' }, { all: 'L9' }, { trusted: 'L2' }, { trusted: true }, { sources: 'client:web' }, { sources: ['client:nobody'] }, { sources: ['helper:dev2'] }, { sources: ['planner'] }, { sources: ['client:planner'] }, { secrets: 'yes' }, { hours: 0 }, { hours: 1000 }, { hours: '1' }, { until: 5 }, { everything: true }]) bad(x);
    assert.equal(f.router.getPolicy(owner).autoApprove.active, false);
    // through the tool layer, as the console sends it
    const first = (await execute(f.router, owner, 'psr_set_policy', { autoApprove: { trusted: 'L3', sources: ['client:grokbot', 'helper:gpu1', 'client:grokbot'] } }) as ReturnType<typeof f.router.getPolicy>).autoApprove;
    assert.deepEqual([first.all, first.trusted, first.sources, first.secrets, first.until], [null, 'L3', ['client:grokbot', 'helper:gpu1'], false, null]);
    const next = auto(f, { all: 'L1', hours: 8 });
    assert.deepEqual([next.all, next.trusted, next.sources, next.until], ['L1', 'L3', ['client:grokbot', 'helper:gpu1'], f.now() + 8 * 3600000]);
    // a source that left the configuration starts nothing and never stands in the way of another change, or of removing it
    f.config.clients.find(c => c.clientId === 'grokbot')!.disabled = true;
    assert.ok(!f.router.getPolicy(owner).autoApprove.sourceChoices.some(x => x.id === 'client:grokbot'));
    assert.deepEqual(auto(f, { sources: ['client:grokbot', 'client:muse'] }).sources, ['client:grokbot', 'client:muse']);
    assert.deepEqual(auto(f, { sources: ['client:muse'] }).sources, ['client:muse']);
    bad({ sources: ['client:grokbot'] });
    // off again
    // off forgets who was trusted, the credentials flag and the period: switching it on again later says all of it anew
    assert.equal(auto(f, { secrets: true }).secrets, true);
    const off = auto(f, { all: null, trusted: null });
    assert.deepEqual([off.all, off.trusted, off.sources, off.secrets, off.until, off.active], [null, null, [], false, null, false]);
    assert.deepEqual(auto(f, { trusted: 'L3' }).sources, [], 'a later partial change finds nobody trusted');
});
