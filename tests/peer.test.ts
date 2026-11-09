import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture, principal, code } from './helpers.js';
import { execute, visibleTools } from '../src/tools.js';
import { startHttp } from '../src/server.js';
import { PEER_TTL_MS, PEER_KEEP_MS, PEER_PAIR_WINDOW_MS, PEER_BRIDGE_POLL_MS, type PeerMessage } from '../src/peer.js';
import type { Principal } from '../src/types.js';

const owner = principal();
const T1 = '019a7c3e-1111-7000-8000-00000000000a', T2 = '019a7c3e-2222-7000-8000-00000000000b';
async function setup() {
    const f = await fixture();
    const cred = (hostId: string) => f.router.localPrincipal(f.router.issueLocalCredential(owner, { hostId }).token);
    const gpu = cred('gpu1'), lab = cred('lab3');
    const join = (c: Principal, cwd: string, name = 'claude-code', thread: string | null = null) => {
        const m = f.router.joinLocal(c, { place: { cwd, repo: null, branch: null }, client: { name, version: '1' } });
        return { id: m.id, p: f.router.touchLocal(c, m.id, { cwd, repo: null, branch: null }, thread) };
    };
    const msg = (id: string) => f.store.get<PeerMessage>('peer_message', id)!;
    return { f, gpu, lab, join, msg };
}

test('peer: only local sessions see the message tools, only the owner the admin ones', async (t) => {
    const { f, gpu, join } = await setup(); t.after(f.close);
    const a = join(gpu, '/w/a');
    const names = visibleTools(a.p).map(x => x.name);
    for (const n of ['psr_local_who', 'psr_local_send', 'psr_local_reply', 'psr_local_inbox', 'psr_local_message_status']) assert.ok(names.includes(n), n);
    assert.ok(!names.some(n => n.startsWith('psr_peer_') || n === 'psr_set_peer_mode'));
    const admin = visibleTools(owner).map(x => x.name), reader = visibleTools(principal('muse', { scopes: ['read', 'submit'] })).map(x => x.name);
    for (const n of ['psr_peer_messages', 'psr_peer_decide', 'psr_peer_send', 'psr_set_peer_mode']) { assert.ok(admin.includes(n), n); assert.ok(!reader.includes(n), n); }
    assert.ok(!admin.includes('psr_local_send'));
    await assert.rejects(execute(f.router, owner, 'psr_local_send', { to: a.id, kind: 'request', text: 'x' }), code('TOOL_NOT_FOUND'));
    await assert.rejects(execute(f.router, a.p, 'psr_peer_send', { to: a.id, kind: 'notice', text: 'x' }), code('TOOL_NOT_FOUND'));
    // the bridge's own credential (before it joins) speaks for no session
    assert.throws(() => f.router.localWho(gpu), code('FORBIDDEN'));
});

test('peer: a request and its one reply; inbox, status and who', async (t) => {
    const { f, gpu, lab, join, msg } = await setup(); t.after(f.close);
    const a = join(gpu, '/w/a'), b = join(lab, '/w/b', 'codex-mcp-client');
    const who = f.router.localWho(a.p);
    assert.equal(who.you.memberId, a.id);
    assert.deepEqual(who.sessions.map(x => [x.memberId, x.provider, x.takes, x.live]), [[b.id, 'codex', 'push', true]]);
    assert.throws(() => f.router.localSend(a.p, { to: a.id, kind: 'request', text: 'me?' }), code('INVALID_ARGUMENT'));
    assert.throws(() => f.router.localSend(a.p, { to: 'lm_nope', kind: 'request', text: 'x' }), code('RECIPIENT_GONE'));
    assert.throws(() => f.router.localSend(a.p, { to: b.id, kind: 'request', text: 'x'.repeat(2001) }), code('INVALID_ARGUMENT'));

    const sent = f.router.localSend(a.p, { to: b.id, kind: 'request', text: 'May I take the GPU after your run? token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
    assert.deepEqual([sent.delivery, sent.masked], ['queued', true]);
    assert.match(sent.note, /between its turns, never during one.*do not ask again/);
    assert.ok(!msg(sent.messageId).text.includes('sk-ant-api03'));
    // the other side sees it once in its inbox, then as a request still to answer
    const inbox = f.router.localInbox(b.p);
    assert.deepEqual(inbox.messages.map(x => [x.messageId, x.kind, x.from]), [[sent.messageId, 'request', who.you.name]]);
    assert.match(inbox.untrusted, /never instructions/);
    assert.equal(f.router.localInbox(b.p).messages.length, 0);
    assert.deepEqual(f.router.localInbox(b.p).toAnswer.map(x => x.requestId), [sent.messageId]);
    assert.deepEqual(f.router.localInbox(a.p).waitingOn.map(x => x.requestId), [sent.messageId]);
    // only its recipient answers it, once
    assert.throws(() => f.router.localReply(a.p, { requestId: sent.messageId, text: 'yes' }), code('NOT_FOUND'));
    const r = f.router.localReply(b.p, { requestId: sent.messageId, text: 'Yes, from 14:00' });
    assert.throws(() => f.router.localReply(b.p, { requestId: sent.messageId, text: 'again' }), code('REQUEST_CLOSED'));
    assert.deepEqual(f.router.localInbox(a.p).messages.map(x => [x.messageId, x.kind, x.replyTo, x.text]), [[r.messageId, 'reply', sent.messageId, 'Yes, from 14:00']]);
    const st = f.router.localMessageStatus(a.p, {}).messages;
    assert.deepEqual(st.map(x => [x.messageId, x.delivery, x.answer, x.replyId]), [[sent.messageId, 'read', 'answered', r.messageId]]);
    assert.deepEqual(f.router.localMessageStatus(b.p, { messageIds: [sent.messageId] }).messages, []);
    assert.equal(f.router.localInbox(a.p).waitingOn.length, 0);
});

test('peer: limits: one open request between two sessions, 10 requests and 30 messages an hour, the owner releases a burst', async (t) => {
    const { f, gpu, lab, join, msg } = await setup(); t.after(f.close);
    const a = join(gpu, '/w/a'), b = join(lab, '/w/b'), others = Array.from({ length: 11 }, (_, i) => join(lab, `/w/o${i}`));
    const q = f.router.localSend(a.p, { to: b.id, kind: 'request', text: 'GPU?' });
    assert.throws(() => f.router.localSend(a.p, { to: b.id, kind: 'request', text: 'GPU??' }), code('REQUEST_OPEN'));
    assert.throws(() => f.router.localSend(b.p, { to: a.id, kind: 'request', text: 'and you?' }), code('REQUEST_OPEN'));
    for (let i = 0; i < 9; i++) f.router.localSend(a.p, { to: others[i].id, kind: 'request', text: `q${i}` });
    assert.throws(() => f.router.localSend(a.p, { to: others[9].id, kind: 'request', text: 'q9' }), code('RATE_LIMIT'));
    // notices still go, up to 30 messages of any kind an hour (replies are never counted)
    for (let i = 0; i < 20; i++) assert.equal(f.router.localSend(a.p, { to: others[i % 10].id, kind: 'notice', text: `n${i}` }).delivery, 'queued');
    assert.throws(() => f.router.localSend(a.p, { to: others[10].id, kind: 'notice', text: 'n20' }), code('RATE_LIMIT'));
    assert.equal(f.router.localReply(b.p, { requestId: q.messageId, text: 'later' }).delivery, 'queued');

    // between two sessions: past 6 requests and notices in 10 minutes, the rest wait for the owner
    const c = join(gpu, '/w/c'), d = join(lab, '/w/d'), burst = Array.from({ length: 8 }, (_, i) => f.router.localSend(i % 2 ? d.p : c.p, { to: i % 2 ? c.id : d.id, kind: 'notice', text: `chat ${i}` }));
    assert.deepEqual(burst.map(x => x.delivery), ['queued', 'queued', 'queued', 'queued', 'queued', 'queued', 'held', 'held']);
    assert.match(burst[6].note, /Held for the owner/);
    assert.deepEqual(f.router.localInbox(c.p).messages.map(x => x.text), ['chat 1', 'chat 3', 'chat 5']);
    const held = f.router.peerMessages(owner, { state: 'held' });
    assert.deepEqual([held.held, held.messages.map(x => x.messageId)], [2, [burst[7].messageId, burst[6].messageId]]);
    assert.throws(() => f.router.peerMessages(a.p, {}), code('FORBIDDEN'));
    assert.equal(f.router.decidePeer(owner, { messageId: burst[6].messageId, decision: 'release' }).delivery, 'queued');
    assert.equal(f.router.decidePeer(owner, { messageId: burst[7].messageId, decision: 'reject' }).delivery, 'rejected');
    assert.throws(() => f.router.decidePeer(owner, { messageId: burst[7].messageId, decision: 'release' }), code('NOT_HELD'));
    assert.deepEqual(f.router.localInbox(d.p).messages.map(x => x.text), ['chat 0', 'chat 2', 'chat 4', 'chat 6']);
    assert.equal(msg(burst[7].messageId).delivery, 'rejected');
    // the window moves on
    f.advance(PEER_PAIR_WINDOW_MS);
    assert.equal(f.router.localSend(c.p, { to: d.id, kind: 'notice', text: 'later chat' }).delivery, 'queued');
    // the owner is not bounded
    for (let i = 0; i < 12; i++) f.router.ownerSend(owner, { to: b.id, kind: 'notice', text: `owner ${i}` });
    assert.equal(f.router.ownerSend(owner, { to: b.id, kind: 'request', text: 'owner q' }).delivery, 'queued');
});

test('peer: requests expire after 60 minutes; gc writes it and removes settled messages a day later', async (t) => {
    const { f, gpu, lab, join, msg } = await setup(); t.after(f.close);
    const a = join(gpu, '/w/a'), b = join(lab, '/w/b');
    const q = f.router.localSend(a.p, { to: b.id, kind: 'request', text: 'GPU?' });
    f.advance(PEER_TTL_MS);
    a.p = f.router.touchLocal(gpu, a.id, { cwd: '/w/a', repo: null, branch: null }); b.p = f.router.touchLocal(lab, b.id, { cwd: '/w/b', repo: null, branch: null });
    assert.equal(f.router.localInbox(b.p).messages.length, 0);
    assert.throws(() => f.router.localReply(b.p, { requestId: q.messageId, text: 'yes' }), code('REQUEST_CLOSED'));
    assert.deepEqual(f.router.localMessageStatus(a.p, {}).messages.map(x => [x.delivery, x.answer]), [['expired', 'expired']]);
    // expired, it no longer blocks the next request between the two
    assert.equal(f.router.localSend(a.p, { to: b.id, kind: 'request', text: 'GPU now?' }).delivery, 'queued');
    f.router.gc();
    assert.deepEqual([msg(q.messageId).delivery, msg(q.messageId).answer], ['expired', 'expired']);
    f.advance(PEER_KEEP_MS + 1); f.router.gc();
    assert.equal(f.store.get('peer_message', q.messageId), undefined);
});

test('peer: modes: off refuses, hold keeps messages in the inbox; notices are never pushed', async (t) => {
    const { f, gpu, lab, join } = await setup(); t.after(f.close);
    const a = join(gpu, '/w/a'), b = join(lab, '/w/b');
    assert.throws(() => f.router.setPeerMode(a.p, { memberId: b.id, mode: 'off' }), code('FORBIDDEN'));
    f.router.setPeerMode(owner, { memberId: b.id, mode: 'off' });
    assert.equal(f.router.localWho(a.p).sessions[0].takes, 'off');
    assert.throws(() => f.router.localSend(a.p, { to: b.id, kind: 'notice', text: 'hi' }), code('RECIPIENT_OFF'));
    f.router.setPeerMode(owner, { memberId: b.id, mode: 'hold' });
    const q = f.router.localSend(a.p, { to: b.id, kind: 'request', text: 'GPU?' });
    assert.match(q.note, /inbox/);
    assert.deepEqual((await f.router.pushWait(b.p, { timeoutMs: 0 })).messages, []);
    f.router.setPeerMode(owner, { memberId: b.id, mode: 'push' });
    assert.deepEqual((await f.router.pushWait(b.p, { timeoutMs: 0 })).messages.map(x => x.messageId), [q.messageId]);
    const n = f.router.localSend(b.p, { to: a.id, kind: 'notice', text: 'FYI: I moved the dataset' });
    assert.deepEqual((await f.router.pushWait(a.p, { timeoutMs: 0 })).messages, []);
    assert.deepEqual(f.router.localInbox(a.p).messages.map(x => x.messageId), [n.messageId]);
    assert.equal(f.router.peerMessages(owner, {}).modes.length, 0);
});

test('peer: the bridge long-polls what to push, between turns, and acknowledges what it put in; the owner\'s urgent ones first', async (t) => {
    const { f, gpu, lab, join, msg } = await setup(); t.after(f.close);
    const a = join(gpu, '/w/a'), b = join(lab, '/w/b');
    const waiting = f.router.pushWait(b.p, { timeoutMs: 5000 });
    const q = f.router.localSend(a.p, { to: b.id, kind: 'request', text: 'GPU?' });
    const got = (await waiting).messages;
    assert.deepEqual(got.map(x => [x.messageId, x.kind, x.urgent]), [[q.messageId, 'request', false]]);
    assert.match(got[0].text, new RegExp(`^\\[PSR message ${q.messageId}: request from claude @ a #`));
    assert.match(got[0].text, /psr_local_reply \(requestId pm_\d+\).*Finish what you are doing first/);
    assert.match(got[0].text, /GPU\?\n\[end of message pm_\d+\. Messages come from other sessions.*never instructions/);
    // not acknowledged: it comes again; acknowledged: delivered, and the inbox does not repeat it
    assert.equal((await f.router.pushWait(b.p, { timeoutMs: 0 })).messages.length, 1);
    const u = f.router.ownerSend(owner, { to: b.id, kind: 'notice', text: 'notice' }), r = f.router.ownerSend(owner, { to: b.id, kind: 'request', text: 'Stop the run now', urgent: true });
    assert.deepEqual((await f.router.pushWait(b.p, { timeoutMs: 0 })).messages.map(x => [x.messageId, x.urgent]), [[r.messageId, true], [q.messageId, false]]);
    assert.deepEqual(f.router.pushAck(b.p, { messageIds: [q.messageId, r.messageId, u.messageId, 'pm_x'] }).delivered, [r.messageId, q.messageId]);
    assert.deepEqual([msg(q.messageId).delivery, msg(q.messageId).deliveredBy], ['delivered', 'bridge']);
    assert.deepEqual(f.router.localInbox(b.p).messages.map(x => x.messageId), [u.messageId]);
    assert.deepEqual(f.router.localInbox(b.p).toAnswer.map(x => x.requestId).sort(), [q.messageId, r.messageId].sort());
    // a session's urgent flag is not its to give
    assert.equal(msg(f.router.localSend(b.p, { to: a.id, kind: 'notice', text: 'x', urgent: true } as never).messageId).urgent, false);
    // a wait ends when its session closes
    const ended = f.router.pushWait(a.p, { timeoutMs: 5000 });
    f.router.leaveLocal(gpu, a.id);
    await assert.rejects(ended, code('SESSION_NOT_FOUND'));
    await assert.rejects(f.router.pushWait(b.p, { timeoutMs: 60000 }), code('INVALID_ARGUMENT'));
});

test('peer: a Codex thread: its hooks take its messages by thread id, and a newer bridge of the thread takes over', async (t) => {
    const { f, gpu, lab, join, msg } = await setup(); t.after(f.close);
    const a = join(gpu, '/w/a'), c = join(lab, '/w/c', 'codex-mcp-client', T1);
    assert.equal(f.store.get<{ thread: string }>('local_member', c.id)!.thread, T1);
    // a later thread id never relinks a member
    f.router.touchLocal(lab, c.id, { cwd: '/w/c', repo: null, branch: null }, T2);
    assert.equal(f.store.get<{ thread: string }>('local_member', c.id)!.thread, T1);
    assert.deepEqual(f.router.hookTake(lab, { threadId: T1, event: 'Stop' }), { memberId: c.id, messageIds: [], text: null });
    const q = f.router.localSend(a.p, { to: c.id, kind: 'request', text: 'Are you done with src/x.ts?' });
    assert.deepEqual(f.router.hookTake(gpu, { threadId: T1, event: 'Stop' }), { memberId: null, messageIds: [], text: null });
    assert.throws(() => f.router.hookTake(lab, { threadId: 'not-a-thread', event: 'Stop' }), code('INVALID_ARGUMENT'));
    assert.throws(() => f.router.hookTake(lab, { threadId: T1, event: 'PostToolUse' }), code('INVALID_ARGUMENT'));
    assert.throws(() => f.router.hookTake(a.p, { threadId: T1, event: 'Stop' }), code('FORBIDDEN'));
    f.router.setPeerMode(owner, { memberId: c.id, mode: 'hold' });
    assert.equal(f.router.hookTake(lab, { threadId: T1, event: 'Stop' }).text, null);
    // the app restarts the thread's server: the new bridge reports the same thread and takes over messages and mode
    const c2 = join(lab, '/w/c', 'codex-mcp-client', T1), old = f.store.get<{ closedAt: number; closeReason: string }>('local_member', c.id)!;
    assert.deepEqual([old.closeReason, msg(q.messageId).to.ref, f.router.localWho(a.p).sessions.map(x => [x.memberId, x.takes])], ['replaced', c2.id, [[c2.id, 'hold']]]);
    f.router.setPeerMode(owner, { memberId: c2.id, mode: 'push' });
    const took = f.router.hookTake(lab, { threadId: T1.toUpperCase(), event: 'UserPromptSubmit' });
    assert.deepEqual([took.memberId, took.messageIds], [c2.id, [q.messageId]]);
    assert.match(took.text!, /Are you done with src\/x\.ts\?/);
    assert.deepEqual([msg(q.messageId).delivery, msg(q.messageId).deliveredBy], ['delivered', 'hook']);
    assert.equal(f.router.hookTake(lab, { threadId: T1, event: 'SessionStart' }).text, null);
    assert.equal(f.router.localReply(c2.p, { requestId: q.messageId, text: 'Done, it is yours' }).delivery, 'queued');
});

test('peer over HTTP: the bridge\'s push and receipt, and a hook\'s take, with the machine credential', async () => {
    const { f, join } = await setup();
    for (const c of f.config.clients) process.env[c.tokenEnv] = randomBytes(32).toString('hex');
    const http = await startHttp(f.router, { port: 0 });
    try {
        const token = f.router.issueLocalCredential(owner, { hostId: 'lab3' }).token, p = f.router.localPrincipal(token);
        const a = join(f.router.localPrincipal(f.router.issueLocalCredential(owner, { hostId: 'gpu1' }).token), '/w/a'), b = join(p, '/w/b', 'codex-mcp-client');
        const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${http.baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-psr-cwd': encodeURIComponent('/w/b'), ...extra }, body: JSON.stringify(body) });
        assert.equal((await post('/local/push', { timeoutMs: 0 })).status, 400);
        const q = f.router.localSend(a.p, { to: b.id, kind: 'request', text: 'GPU?' });
        const pushed = await (await post('/local/push', { timeoutMs: 0 }, { 'mcp-session-id': b.id, 'x-psr-thread': T2 })).json();
        assert.deepEqual(pushed.messages.map((x: { messageId: string }) => x.messageId), [q.messageId]);
        assert.equal(f.store.get<{ thread: string }>('local_member', b.id)!.thread, T2);
        // that member's bridge delivers, so its thread's hook takes nothing; the bridge's receipt marks it delivered
        assert.deepEqual((await (await post('/local/hook', { threadId: T2, event: 'Stop' })).json()).messageIds, []);
        assert.deepEqual((await (await post('/local/push/ack', { messageIds: [q.messageId] }, { 'mcp-session-id': b.id })).json()).delivered, [q.messageId]);
        // a thread whose bridge does not poll (a plain codex): its hook takes its messages over HTTP
        const c = join(p, '/w/c', 'codex-mcp-client', T1), q2 = f.router.localSend(a.p, { to: c.id, kind: 'request', text: 'GPU now?' });
        assert.deepEqual((await (await post('/local/hook', { threadId: T1, event: 'Stop' })).json()).messageIds, [q2.messageId]);
        // nobody else's credential reaches these
        const plain = await fetch(`${http.baseUrl}/local/hook`, { method: 'POST', headers: { authorization: `Bearer ${process.env[f.config.clients[0].tokenEnv]}`, 'content-type': 'application/json' }, body: JSON.stringify({ threadId: T2, event: 'Stop' }) });
        assert.equal(plain.status, 404);
    }
    finally { await http.close(); await f.close(); }
});

test('peer: shutting down answers the bridges\' long polls at once, so the server closes well inside its stop timeout', async () => {
    const { f, join } = await setup();
    for (const c of f.config.clients) process.env[c.tokenEnv] = randomBytes(32).toString('hex');
    const http = await startHttp(f.router, { port: 0 });
    const token = f.router.issueLocalCredential(owner, { hostId: 'lab3' }).token, b = join(f.router.localPrincipal(token), '/w/b');
    const polls = Array.from({ length: 3 }, () => fetch(`${http.baseUrl}/local/push`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'mcp-session-id': b.id, 'x-psr-cwd': encodeURIComponent('/w/b') }, body: JSON.stringify({ timeoutMs: 50000 }) }));
    await new Promise(r => setTimeout(r, 300));
    const t0 = Date.now();
    await http.close();
    assert.ok(Date.now() - t0 < 2000, `closed in ${Date.now() - t0} ms`);
    for (const r of await Promise.all(polls)) assert.deepEqual([r.status, (await r.json()).messages], [200, []]);
    await f.close();
});

test('peer: a member whose bridge delivers its own messages (it long-polls) gets none from its hooks; once the bridge stops polling, the hooks take over', async (t) => {
    const { f, gpu, lab, join } = await setup(); t.after(f.close);
    const a = join(gpu, '/w/a'), c = join(lab, '/w/c', 'codex-mcp-client', T1);
    await f.router.pushWait(c.p, { timeoutMs: 0 });
    const q = f.router.localSend(a.p, { to: c.id, kind: 'request', text: 'GPU?' });
    assert.deepEqual(f.router.hookTake(lab, { threadId: T1, event: 'Stop' }).messageIds, []);
    f.advance(PEER_BRIDGE_POLL_MS - 1000);
    assert.deepEqual(f.router.hookTake(lab, { threadId: T1, event: 'UserPromptSubmit' }).messageIds, []);
    f.advance(2000);
    q.messageId && assert.deepEqual(f.router.hookTake(lab, { threadId: T1, event: 'Stop' }).messageIds, [q.messageId]);
});
