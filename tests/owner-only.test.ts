import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, principal, code } from './helpers.js';
import { approvalsGoToPerson } from '../src/config.js';
import type { Principal } from '../src/types.js';

/** The owner (admin) and a front-end with submit but no admin, as Muse and Grokbot are. */
const owner = principal(), bot = principal('muse', { scopes: ['read', 'submit'] });
/** gpu1 made owner-only; on it agent-1 is a Codex session and agent-2 a Claude session (demo daemon gpu-research). The
 * configured muse client loses admin too: a queued task is judged by its client's configured scopes when it is sent. */
async function setup() {
    const f = await fixture(c => { c.hosts.find(h => h.id === 'gpu1')!.humanApproval = true; c.clients.find(x => x.clientId === 'muse')!.scopes = ['read', 'submit']; });
    const demo = f.demos.get('gpu-research')!, codex = f.session('gpu-research', 'agent-1'), claude = f.session('gpu-research', 'agent-2');
    const mode = async (s: { nativeId: string }, m: string | null, d = demo) => { d.sessions.get(s.nativeId)!.modeId = m; await f.router.syncDirectory(); };
    const send = (p: Principal, s: { id: string }, key: string) => f.router.submit(p, { routeTicket: f.ticket(p, s.id), prompt: 'Summarize the fills', idempotencyKey: key });
    return { f, demo, codex, claude, mode, send };
}

test('owner-only hosts: which modes send a session\'s approvals to a person', () => {
    for (const [provider, m] of [['claude', 'default'], ['claude/claude-sonnet-5-5', 'plan'], ['codex', 'auto'], ['codex/gpt-6.1-sol', 'read-only']] as const) assert.ok(approvalsGoToPerson(provider, m), `${provider} ${m}`);
    for (const [provider, m] of [['claude', 'auto'], ['claude', 'acceptEdits'], ['claude', 'bypassPermissions'], ['codex', 'auto-review'], ['codex', 'full-access'], ['codex', 'default'], ['opencode', 'default'], ['claude', null], ['codex', undefined]] as const) assert.ok(!approvalsGoToPerson(provider, m), `${provider} ${m}`);
});

test('owner-only hosts: only the owner sends work to a session whose actions the owner does not approve', async (t) => {
    const { f, codex, claude, mode, send } = await setup(); t.after(f.close);
    // an unknown mode (an older daemon), Codex auto-review, Claude auto: refused for anyone but the owner, also as a reply
    assert.throws(() => send(bot, codex, 'oo-bot-0001'), code('OWNER_ONLY_TARGET'));
    await mode(codex, 'auto-review'); assert.throws(() => send(bot, codex, 'oo-bot-0002'), (e: any) => e.code === 'OWNER_ONLY_TARGET' && /gpu1 is owner-only .* auto-review/.test(e.message));
    await mode(claude, 'auto'); assert.throws(() => send(bot, claude, 'oo-bot-0003'), code('OWNER_ONLY_TARGET'));
    assert.equal(send(owner, codex, 'oo-owner-0001').state, 'queued');
    // modes whose requests reach the owner take anyone's work
    await mode(codex, 'auto');
    const sent = send(bot, codex, 'oo-bot-0004');
    assert.equal(sent.state, 'queued');
    await mode(claude, 'default'); assert.equal(send(bot, claude, 'oo-bot-0005').state, 'queued');
    // a retry with the same key finds its task whatever the mode is now; a reply is a new task and is checked
    await mode(codex, 'auto-review');
    assert.equal(send(bot, codex, 'oo-bot-0004').id, sent.id);
    assert.throws(() => f.router.reply(bot, { taskId: sent.id, prompt: 'And the rest', idempotencyKey: 'oo-bot-reply-0001' }), code('OWNER_ONLY_TARGET'));
    // a host that is not owner-only takes anyone's work in any mode
    const lab = f.session('lab-test', 'agent-1');
    await mode(lab, 'auto-review', f.demos.get('lab-test')!);
    assert.equal(send(bot, lab, 'oo-bot-0006').state, 'queued');
});

test('owner-only hosts: a queued turn waits while its session runs in a mode the owner does not approve; the owner\'s goes', async (t) => {
    const { f, demo, codex, claude, mode, send } = await setup(); t.after(f.close);
    await mode(codex, 'auto'); await mode(claude, 'auto');
    const queued = send(bot, codex, 'oo-q-bot-0001');
    await mode(codex, 'auto-review'); await f.router.tick();
    const waiting = f.store.task(queued.id)!;
    assert.deepEqual([waiting.state, demo.sends.length], ['queued', 0]);
    assert.match(waiting.blocker!, /owner-only .* auto-review/);
    // the owner's turn to a session in Claude auto on the same host is sent
    const mine = send(owner, claude, 'oo-q-owner-0001');
    await f.router.tick();
    assert.equal(f.store.task(mine.id)!.state, 'running');
    // back in a mode whose requests reach the owner, the waiting turn goes
    await mode(codex, 'auto'); await f.router.tick();
    assert.equal(f.store.task(queued.id)!.state, 'running');
    assert.equal(demo.sends.length, 2);
});
