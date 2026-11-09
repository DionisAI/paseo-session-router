import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as rawHttp } from 'node:http';
import { startHttp } from '../src/server.js';
import { fixture, principal, withServices, SERVICES } from './helpers.js';
import type { Ask, Principal } from '../src/types.js';
async function app() { const f = await fixture(c => { c.clients.push({ ...principal('readonly', { clientId: 'readonly', entryKind: 'cli', scopes: ['read'], projects: ['hft'], hosts: ['gpu1'] }), tokenEnv: 'PSR_TEST_READONLY_TOKEN' }); }); const tokens: Record<string, string> = {}; for (const c of f.config.clients) {
    tokens[c.clientId] = randomBytes(32).toString('hex');
    process.env[c.tokenEnv] = tokens[c.clientId];
} const http = await startHttp(f.router, { port: 0 }); const request = async (path: string, options: {
    kind?: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
} = {}) => { const r = await fetch(http.baseUrl + path, { method: options.method ?? (options.body === undefined ? 'GET' : 'POST'), headers: { ...(options.kind === 'none' ? {} : { authorization: `Bearer ${tokens[options.kind ?? 'web']}` }), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }); return { status: r.status, headers: r.headers, data: r.status === 202 || r.status === 204 ? null : await r.json() as any }; }; return { ...f, ...http, tokens, request, cleanup: async () => { await http.close(); await f.close(); } }; }
const post = (body: unknown) => ({ body });
test('HTTP: auth required; identity derives from the credential, not a body label', async () => { const a = await app(); try {
    assert.equal((await a.request('/v1/hosts', { kind: 'none' })).status, 401);
    assert.equal((await a.request('/v1/hosts', { headers: { authorization: 'Bearer invalid' } })).status, 401);
    assert.equal((await a.request('/v1/whoami', { kind: 'grokbot' })).data.clientId, 'grokbot');
    const r = await a.request('/v1/tools/psr_list_sessions', { body: { origin: 'admin' } });
    assert.equal(r.status, 400);
}
finally {
    await a.cleanup();
} });
test('HTTP: actual requests from three credentials share the same persistent task', async () => { const a = await app(); try {
    const resolved = await a.request('/v1/resolve-target', { kind: 'grokbot', body: { sessionRef: a.session().id } });
    assert.equal(resolved.data.status, 'resolved');
    const submit = await a.request('/v1/tasks', { kind: 'grokbot', body: { routeTicket: resolved.data.routeTicket, prompt: 'Shared interface test', idempotencyKey: 'cross-http-001' } });
    assert.equal(submit.status, 200);
    const id = submit.data.id;
    assert.equal(submit.data.originKind, 'grokbot');
    assert.equal(submit.data.marker, undefined);
    assert.equal((await a.request('/v1/tasks/' + id, { kind: 'dot' })).data.state, 'queued');
    const cancel = await a.request(`/v1/tasks/${id}/cancel`, { kind: 'muse', body: {} });
    assert.equal(cancel.data.state, 'canceled');
    assert.equal(a.store.task(id)!.originClientId, 'grokbot');
}
finally {
    await a.cleanup();
} });
test('HTTP: restricted client cannot see another project or submit work', async () => { const a = await app(); try {
    const sessions = await a.request('/v1/sessions', { kind: 'readonly' });
    assert.equal(sessions.status, 200);
    assert.ok(sessions.data.sessions.every((s: any) => s.projectId === 'hft' && s.hostId === 'gpu1'));
    const hidden = await a.request('/v1/sessions/' + a.session('dev-app').id, { kind: 'readonly' });
    assert.ok([403, 404].includes(hidden.status));
    const submit = await a.request('/v1/tasks', { kind: 'readonly', body: { routeTicket: 'irrelevant', prompt: 'do work', idempotencyKey: 'read-no-write' } });
    assert.equal(submit.status, 403);
    const topology = await a.request('/v1/topology', { kind: 'readonly' });
    assert.ok(topology.data.nodes.every((n: any) => n.data.projectId !== 'router'));
}
finally {
    await a.cleanup();
} });
test('HTTP: revoke one entry without canceling its running task or breaking other entries', async () => { const a = await app(); try {
    const route = (await a.request('/v1/resolve-target', { kind: 'grokbot', body: { sessionRef: a.session().id } })).data;
    const t = (await a.request('/v1/tasks', { kind: 'grokbot', body: { routeTicket: route.routeTicket, prompt: 'Revocation test', idempotencyKey: 'revoke-test-001' } })).data;
    await a.router.tick();
    const revoked = await a.request('/v1/admin/revoke-client', { body: { clientId: 'grokbot' } });
    assert.equal(revoked.data.tasksCanceled, false);
    assert.equal((await a.request('/v1/tasks/' + t.id, { kind: 'grokbot' })).status, 401);
    assert.equal((await a.request('/v1/tasks/' + t.id, { kind: 'dot' })).data.state, 'running');
    assert.equal((await a.request('/v1/tasks/' + t.id, { kind: 'muse' })).status, 200);
}
finally {
    await a.cleanup();
} });
test('HTTP: rejects hostile Origins, Host rebinding, token URL attempts and method confusion', async () => { const a = await app(); try {
    assert.equal((await a.request('/v1/hosts', { headers: { origin: 'https://attacker.invalid' } })).status, 403);
    const hostileHostStatus = await new Promise<number>((resolve, reject) => { const r = rawHttp(a.baseUrl + '/v1/hosts', { headers: { host: 'attacker.invalid', authorization: `Bearer ${a.tokens.web}` } }, res => { res.resume(); resolve(res.statusCode!); }); r.on('error', reject); r.end(); });
    assert.equal(hostileHostStatus, 403);
    assert.equal((await a.request('/v1/hosts?token=' + a.tokens.web, { kind: 'none' })).status, 400);
    assert.equal((await a.request('/v1/tasks', { method: 'DELETE' })).status, 404);
}
finally {
    await a.cleanup();
} });
test('HTTP: strict JSON schemas reject injection-shaped or unknown arguments', async () => { const a = await app(); try {
    const r = await a.request('/v1/tools/psr_resolve_target', { body: { sessionRef: a.session().id, command: 'rm -rf /' } });
    assert.equal(r.status, 400);
    const unknown = await a.request('/v1/tools/arbitrary_shell', { body: { command: 'whoami' } });
    assert.ok([400, 404].includes(unknown.status));
    const large = await a.request('/v1/tools/psr_list_sessions', { body: { query: 'x'.repeat(70000) } });
    assert.equal(large.status, 413);
    const malformed = await fetch(a.baseUrl + '/v1/tasks', { method: 'POST', headers: { authorization: `Bearer ${a.tokens.web}`, 'content-type': 'application/json' }, body: '{broken' });
    assert.equal(malformed.status, 400);
}
finally {
    await a.cleanup();
} });
test('HTTP: static console has CSP and only explicit assets can be fetched', async () => { const a = await app(); try {
    const page = await fetch(a.baseUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/);
    assert.match(await page.text(), /Session Router/);
    assert.equal((await fetch(a.baseUrl + '/package.json')).status, 401);
    assert.equal((await a.request('/package.json')).status, 404);
}
finally {
    await a.cleanup();
} });
test('HTTP: OpenAPI and tool catalog expose the same action schemas', async () => { const a = await app(); try {
    const schema = await a.request('/openapi.json');
    const tools = await a.request('/v1/tools');
    assert.equal(schema.data.openapi, '3.1.0');
    assert.ok(tools.data.tools.length >= 19);
    for (const tool of tools.data.tools) {
        assert.ok(schema.data.paths['/v1/tools/' + tool.name]);
        assert.equal(tool.inputSchema.additionalProperties, false);
    }
}
finally {
    await a.cleanup();
} });
test('HTTP: duplicate concurrent submits have one receipt through the actual server', async () => { const a = await app(); try {
    const route = (await a.request('/v1/resolve-target', { body: { sessionRef: a.session().id } })).data;
    const payload = { routeTicket: route.routeTicket, prompt: 'HTTP concurrency', idempotencyKey: 'http-parallel-001' };
    const replies = await Promise.all(Array.from({ length: 20 }, () => a.request('/v1/tasks', { body: payload })));
    assert.ok(replies.every(r => r.status === 200));
    assert.equal(new Set(replies.map(r => r.data.id)).size, 1);
    await a.router.tick();
    assert.equal(a.demos.get('gpu-research')!.sends.length, 1);
}
finally {
    await a.cleanup();
} });
test('MCP HTTP: initialize, list, call, notification and JSON response lifecycle', async () => { const a = await app(); const headers = { accept: 'application/json, text/event-stream' }; try {
    const init = await a.request('/mcp', { headers, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } } } });
    assert.equal(init.data.result.protocolVersion, '2025-06-18');
    assert.equal(init.data.result.serverInfo.name, 'paseo-session-router');
    assert.equal((await a.request('/mcp', { headers, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
    const list = await a.request('/mcp', { headers, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    assert.ok(list.data.result.tools.length >= 19);
    const call = await a.request('/mcp', { headers, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'psr_list_hosts', arguments: {} } } });
    assert.equal(call.data.result.isError, false);
    assert.equal(JSON.parse(call.data.result.content[0].text).hosts.length, 3);
    assert.equal((await a.request('/mcp', { headers, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'psr_submit_task', arguments: {} } } })).data.result.isError, true);
}
finally {
    await a.cleanup();
} });
test('MCP HTTP: validates transport headers and rejects unsupported methods safely', async () => { const a = await app(); try {
    assert.equal((await a.request('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 406);
    assert.equal((await a.request('/mcp')).status, 405);
    assert.equal((await a.request('/mcp', { headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': 'invented' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status, 400);
    const notification = await a.request('/mcp', { headers: { accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', method: 'tools/call', params: { name: 'psr_submit_task', arguments: {} } } });
    assert.equal(notification.status, 400);
    assert.equal(a.store.tasks().length, 0);
}
finally {
    await a.cleanup();
} });
test('MCP stdio bridge: a real child process speaks newline JSON-RPC via the authenticated API', async () => { const a = await app(); const child = spawn(process.execPath, ['dist/src/mcp-stdio.js'], { cwd: process.cwd(), env: { ...process.env, PSR_URL: a.baseUrl, PSR_TOKEN: a.tokens.cli }, stdio: ['pipe', 'pipe', 'pipe'] }); try {
    let data = '';
    const output = new Promise<any>((resolve, reject) => { child.stdout!.on('data', chunk => { data += chunk; if (data.includes('\n')) {
        try {
            resolve(JSON.parse(data.split('\n')[0]));
        }
        catch (e) {
            reject(e);
        }
    } }); child.on('error', reject); setTimeout(() => reject(new Error('stdio response timed out')), 5000).unref(); });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) + '\n');
    const answer = await output;
    assert.equal(answer.id, 7);
    assert.ok(answer.result.tools.some((t: any) => t.name === 'psr_submit_task'));
    assert.doesNotMatch(data, /Bearer|PSR_TOKEN/);
}
finally {
    const exit = once(child, 'exit');
    child.kill();
    await exit;
    await a.cleanup();
} });
test('SSE: snapshot watermark is accepted and a revoked credential loses its open stream', async () => { const a = await app(); const abort = new AbortController(); try {
    const topo = (await a.request('/v1/topology', { kind: 'dot' })).data;
    const response = await fetch(a.baseUrl + '/v1/events?after=' + encodeURIComponent(topo.streamCursor), { headers: { authorization: `Bearer ${a.tokens.dot}` }, signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let text = new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /event: changes/);
    await a.request('/v1/admin/revoke-client', { body: { clientId: 'dot' } });
    for (let i = 0; i < 4 && !text.includes('resync_required'); i++) {
        const chunk = await reader.read();
        if (chunk.done)
            break;
        text += new TextDecoder().decode(chunk.value);
    }
    assert.match(text, /resync_required/);
    assert.match(text, /UNAUTHORIZED/);
    await reader.cancel();
}
finally {
    abort.abort();
    await a.cleanup();
} });
test('CLI: a real child lists sessions through HTTP without direct Paseo credentials', async () => { const a = await app(); const child = spawn(process.execPath, ['dist/src/cli.js', 'sessions'], { cwd: process.cwd(), env: { ...process.env, PSR_URL: a.baseUrl, PSR_TOKEN: a.tokens.cli } }); try {
    let text = '';
    child.stdout!.on('data', c => text += c);
    const [exit] = await once(child, 'exit');
    assert.equal(exit, 0);
    assert.equal(JSON.parse(text).sessions.length, 5);
}
finally {
    child.kill();
    await a.cleanup();
} });
test('HTTP: wait and reply tools work over the real HTTP and MCP surfaces', async () => { const a = await app(); try {
    const task = a.submit(); await a.router.tick();
    const timed = await a.request('/v1/tools/psr_wait_task', { kind: 'grokbot', body: { taskId: task.id, timeoutMs: 30 } });
    assert.equal(timed.status, 200); assert.equal(timed.data.timedOut, true);
    const pending = a.request('/v1/tools/psr_wait_task', { kind: 'dot', body: { taskId: task.id, timeoutMs: 5000 } });
    await new Promise(r => setTimeout(r, 50)); a.demos.get('gpu-research')!.finish('agent-1', 'over http');
    const done = await pending; assert.equal(done.data.timedOut, false); assert.equal(done.data.task.resultSummary, 'over http');
    const reply = await a.request('/v1/tools/psr_reply_task', { kind: 'muse', body: { taskId: task.id, prompt: 'Follow up', idempotencyKey: 'http-reply-0001' } });
    assert.equal(reply.status, 200); assert.equal(reply.data.replyToTaskId, task.id);
    const list = await a.request('/mcp', { kind: 'grokbot', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { accept: 'application/json, text/event-stream' } });
    const names = list.data.result.tools.map((t: any) => t.name); for (const n of ['psr_wait_task', 'psr_reply_task', 'psr_resume_session']) assert.ok(names.includes(n), n);
}
finally {
    await a.cleanup();
} });
test('HTTP: a session posts over MCP with its own credential; the assigning bot reads it from its inbox', async () => { const a = await app(); try {
    a.config.daemons.find(d => d.id === 'lab-test')!.agentChannel = { url: 'http://127.0.0.1:8787/mcp' };
    const created = await a.request('/v1/tools/psr_create_session', { body: { templateId: 'lab-codex', idempotencyKey: 'http-channel-0001' } });
    const channel = a.demos.get('lab-test')!.channels.get(created.data.nativeId)!; assert(channel.mode === 'http'); const token = channel.token;
    const task = a.submit('Work', principal('grokbot'), created.data.id); await a.router.tick();
    const mcp = (body: unknown) => fetch(a.baseUrl + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: r.status === 202 ? null : await r.json() as any }));
    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '1' } } });
    assert.match(init.data.result.instructions, /You are a Paseo session/);
    assert.deepEqual((await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).data.result.tools.map((t: any) => t.name), ['psr_post_message', 'psr_ask', 'psr_forum_read', 'psr_forum_post', 'psr_resources', 'psr_take', 'psr_release', 'psr_send_file', 'psr_receive_file']);
    const call = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'psr_post_message', arguments: { text: 'Need a decision', kind: 'question' } } });
    assert.equal(call.data.result.isError, false);
    const denied = await fetch(a.baseUrl + '/v1/tools/psr_list_sessions', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    const inbox = await a.request('/v1/tools/psr_wait_messages', { kind: 'grokbot', body: { timeoutMs: 0 } });
    assert.deepEqual(inbox.data.messages.map((m: any) => [m.text, m.taskId]), [['Need a decision', task.id]]);
}
finally {
    await a.cleanup();
} });
test('HTTP: a session uses its mission forum over MCP; the owner reads it over REST; a read-only client cannot', async () => { const a = await app(); try {
    a.config.daemons.find(d => d.id === 'lab-test')!.agentChannel = { url: 'http://127.0.0.1:8787/mcp' };
    const created = await a.request('/v1/tools/psr_create_session', { body: { templateId: 'lab-codex', idempotencyKey: 'http-forum-0001' } });
    const channel = a.demos.get('lab-test')!.channels.get(created.data.nativeId)!; assert(channel.mode === 'http'); const token = channel.token;
    const grokbot = principal('grokbot');
    a.router.submit(grokbot, { routeTicket: a.ticket(grokbot, created.data.id), prompt: 'Work on the lab half', idempotencyKey: 'http-forum-task-1', missionId: 'm-http' }); await a.router.tick();
    const mcp = (body: unknown) => fetch(a.baseUrl + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, headers: r.headers, data: await r.json() as any }));
    const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '1' } } });
    assert.match(init.data.result.instructions, /psr_forum_read/);
    const call = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'psr_forum_post', arguments: { text: 'I take the lab half' } } });
    assert.match(call.headers.get('content-type')!, /application\/json/); assert.equal(call.data.result.isError, false);
    assert.deepEqual(JSON.parse(call.data.result.content[0].text).mission, 'm-http');
    const read = await a.request('/v1/tools/psr_forum_read', { body: { mission: 'm-http' } });
    assert.equal(read.status, 200); assert.deepEqual(read.data.posts.map((x: any) => [x.text, x.author.kind, x.author.hostId]), [['I take the lab half', 'agent', 'lab3']]);
    assert.equal((await a.request('/v1/tools/psr_forum_read', { kind: 'readonly', body: { mission: 'm-http' } })).status, 403);
}
finally {
    await a.cleanup();
} });
test('HTTP: the cloud-shell installer files are served without a credential and contain no secrets', async () => { const a = await app(); try {
    for (const [path, marker] of [['/integrations/cloud-shell/install.sh', 'Router token for this computer'], ['/integrations/cloud-shell/psr', '--proto =https'], ['/integrations/cloud-shell/AGENT.md', 'psr_inbox']]) {
        const r = await fetch(a.baseUrl + path); const text = await r.text();
        assert.equal(r.status, 200, path); assert.ok(text.includes(marker), path); assert.ok(!Object.values(a.tokens).some(t => text.includes(t)), path);
    }
    assert.equal((await fetch(a.baseUrl + '/integrations/cloud-shell/../../.env')).status, 401);
}
finally {
    await a.cleanup();
} });
test('HTTP: the park view assets and the vendored 3D engine are served; the engine is gzip-compressed and cacheable', async () => { const a = await app(); try {
    for (const path of ['/park.js', '/views.js', '/park.css']) { const r = await fetch(a.baseUrl + path); assert.equal(r.status, 200, path); assert.equal(r.headers.get('cache-control'), 'no-store'); }
    const r = await fetch(a.baseUrl + '/vendor/three-0.186.1/three.core.js', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(r.status, 200); assert.match(r.headers.get('cache-control')!, /immutable/); assert.ok((await r.text()).includes('REVISION'));
    const raw = await new Promise<{ status: number; encoding?: string }>(resolve => rawHttp(a.baseUrl + '/vendor/three-0.186.1/three.module.js', { headers: { 'accept-encoding': 'gzip' } }, res => { res.resume(); resolve({ status: res.statusCode!, encoding: res.headers['content-encoding'] }); }).end());
    assert.deepEqual(raw, { status: 200, encoding: 'gzip' });
    assert.equal((await fetch(a.baseUrl + '/vendor/three-0.186.1/LICENSE')).status, 401);
}
finally {
    await a.cleanup();
} });

/** A caller session (lab3, http channel) in a running turn, a market-data seat on gpu1, and a Router that streams psr_ask
 * progress every 40 ms. */
async function askApp() {
    const f = await fixture(withServices);
    for (const c of f.config.clients) process.env[c.tokenEnv] = randomBytes(32).toString('hex');
    const http = await startHttp(f.router, { port: 0, progressMs: 40, askHoldMs: 5000 });
    f.router.setPolicy(principal(), { a2a: { services: SERVICES } });
    const seat = await f.router.createSession(principal(), { templateId: 'svc-md', idempotencyKey: 'seat-md-0001', role: 'service', service: 'market-data' });
    const caller = await f.router.createSession(principal(), { templateId: 'lab-codex', idempotencyKey: 'caller-000001' });
    const channel = f.demos.get('lab-test')!.channels.get(caller.nativeId)!; assert(channel.mode === 'http');
    const work = f.submit('Work that needs a price', principal('grokbot'), caller.id); await f.router.tick();
    const headers = { authorization: `Bearer ${channel.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'claude-cli/2.1.311' };
    const call = (args: unknown, options: { progressToken?: string | number; signal?: AbortSignal; base?: string } = {}) => fetch((options.base ?? http.baseUrl) + '/mcp', { method: 'POST', headers, signal: options.signal, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'psr_ask', arguments: args, ...(options.progressToken ? { _meta: { progressToken: options.progressToken } } : {}) } }) });
    const rest = (args: unknown) => fetch(http.baseUrl + '/v1/tools/psr_ask', { method: 'POST', headers, body: JSON.stringify(args) });
    const seen = new Set<string>(), newest = () => { const x = f.store.all<Ask>('ask').find(x => !seen.has(x.id)); if (x) seen.add(x.id); return x!; }; // each ask once, in the order the test makes them
    const until = async (ok: () => boolean) => { for (const end = Date.now() + 4000; !ok();) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
    return { f, http, seat, caller, work, headers, call, rest, newest, until, gpu: f.demos.get('gpu-research')!, lab: f.demos.get('lab-test')!, cleanup: async () => { await http.close(); await f.close(); } };
}
test('MCP HTTP: psr_ask answers at once with an event stream, sends progress on the caller\'s token, and ends with the answer', async () => { const a = await askApp(); try {
    const refused = await a.call({ service: 'nope', request: 'x' });
    assert.match(refused.headers.get('content-type')!, /application\/json/);
    const body = await refused.json() as any;
    assert.equal(body.result.isError, true); assert.equal(JSON.parse(body.result.content[0].text).code, 'UNKNOWN_SERVICE');
    const r = await a.call({ service: 'market-data', request: 'EUR/USD now?' }, { progressToken: 'tok-1' });
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type')!, /^text\/event-stream/);
    const reader = r.body!.getReader(), decoder = new TextDecoder(); let text = '';
    const readUntil = async (re: RegExp) => { while (!re.test(text)) { const c = await reader.read(); if (c.done) break; text += decoder.decode(c.value); } };
    await a.f.router.tick();
    await readUntil(/is answering[\s\S]*is answering/);
    const ask = a.newest();
    assert.equal(a.f.store.get<Ask>('ask', ask.id)!.delivery, 'held');
    a.gpu.finish(a.seat.nativeId, 'EUR/USD 1.0842, from /srv/data/fx.csv'); await a.f.router.tick();
    await readUntil(/"id":9/);
    const events = text.split('\n\n').filter(Boolean).map(e => { assert.match(e, /^event: message\ndata: /); return JSON.parse(e.slice(e.indexOf('data: ') + 6)); });
    const progress = events.filter(e => e.method === 'notifications/progress'), final = events.at(-1);
    assert.ok(progress.length >= 2); assert.ok(progress.every((e, i) => e.params.progressToken === 'tok-1' && e.params.progress === i + 1));
    assert.match(progress[0].params.message, /^market-data is answering \(\d\d:\d\d\)$/);
    assert.equal(final.id, 9); assert.equal(final.result.isError, false);
    assert.deepEqual(JSON.parse(final.result.content[0].text), { status: 'answered', askId: ask.id, service: 'market-data', answer: 'EUR/USD 1.0842, from /srv/data/fx.csv' });
    assert.equal((await reader.read()).done, true);
    await a.until(() => a.f.store.get<Ask>('ask', ask.id)!.delivery === 'delivered');
    // REST: a short hold without progress, the same result
    const pending = a.rest({ service: 'market-data', request: 'And GBP?' });
    await a.until(() => a.f.store.all<Ask>('ask').some(x => x.id !== ask.id && x.state === 'running'));
    const second = a.newest();
    await a.f.router.tick(); a.gpu.finish(a.seat.nativeId, 'GBP/USD 1.27'); await a.f.router.tick();
    const plain = await pending;
    assert.match(plain.headers.get('content-type')!, /application\/json/);
    assert.deepEqual(await plain.json(), { status: 'answered', askId: second.id, service: 'market-data', answer: 'GBP/USD 1.27' });
    await a.until(() => a.f.store.get<Ask>('ask', second.id)!.delivery === 'delivered');
} finally { await a.cleanup(); } });
test('MCP HTTP: a psr_ask client that goes away mid-hold leaves the answer queued for its next turn; the hold limit answers queued', async () => { const a = await askApp(); try {
    const abort = new AbortController();
    const r = await a.call({ service: 'market-data', request: 'Slow question' }, { progressToken: 7, signal: abort.signal });
    assert.match(r.headers.get('content-type')!, /^text\/event-stream/);
    const ask = a.newest();
    abort.abort();
    await a.until(() => a.f.store.get<Ask>('ask', ask.id)!.delivery === 'queued');
    assert.equal(a.f.store.get<Ask>('ask', ask.id)!.settledAt, null);
    await a.f.router.tick(); a.gpu.finish(a.seat.nativeId, 'Answer after the caller left'); await a.f.router.tick();
    assert.deepEqual([a.f.store.get<Ask>('ask', ask.id)!.state, a.f.store.get<Ask>('ask', ask.id)!.delivery], ['answered', 'queued']);
    // past the hold limit the call ends with status queued, and so does the delivery
    const short = await startHttp(a.f.router, { port: 0, progressMs: 40, askHoldMs: 150 });
    try {
        const held = await a.call({ service: 'market-data', request: 'Another slow one' }, { progressToken: 'tok-3', base: short.baseUrl });
        const text = await held.text(), final = JSON.parse(text.split('\n\n').filter(Boolean).at(-1)!.split('data: ')[1]);
        const result = JSON.parse(final.result.content[0].text), queued = a.newest();
        assert.equal(final.result.isError, false, 'queued is an outcome, not an error to retry');
        assert.deepEqual(result, { status: 'queued', askId: queued.id, service: 'market-data', note: 'The answer will arrive as the first message of your next turn. Finish what does not depend on it, then end your turn.' });
        assert.equal(a.f.store.get<Ask>('ask', queued.id)!.delivery, 'queued');
    } finally { await short.close(); }
} finally { await a.cleanup(); } });

/** The SSE events of a psr_ask stream, parsed. */
const sse = (text: string) => text.split('\n\n').filter(Boolean).map(e => JSON.parse(e.slice(e.indexOf('data: ') + 6)));
test('MCP HTTP: a psr_ask call the client cancels (notifications/cancelled) gets no result, and its answer waits for the next turn', async () => { const a = await askApp(); try {
    const r = await a.call({ service: 'market-data', request: 'Slow question' }, { progressToken: 'tok-c' });
    const ask = a.newest();
    const cancel = (requestId: unknown, token = a.headers.authorization) => fetch(a.http.baseUrl + '/mcp', { method: 'POST', headers: { ...a.headers, authorization: token }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'User interrupted' } }) });
    assert.equal((await cancel(10)).status, 202); // another request id: nothing happens
    assert.equal(a.f.store.get<Ask>('ask', ask.id)!.delivery, 'held');
    assert.equal((await cancel(9)).status, 202);
    const events = sse(await r.text());
    assert.ok(events.every(e => e.method === 'notifications/progress'), 'no result after a cancel');
    assert.equal(a.f.store.get<Ask>('ask', ask.id)!.delivery, 'queued');
    await a.f.router.tick(); a.gpu.finish(a.seat.nativeId, 'Answer after the cancel'); await a.f.router.tick();
    assert.deepEqual([a.f.store.get<Ask>('ask', ask.id)!.state, a.f.store.get<Ask>('ask', ask.id)!.delivery], ['answered', 'queued']);
    a.lab.finish(a.caller.nativeId, 'Went on without it'); await a.f.router.tick();
    const reply = a.f.store.tasks().find(x => x.replyToTaskId === a.work.id)!;
    assert.match(reply.prompt, /^\[Router\] 服務回覆/); assert.match(reply.prompt, /│ Answer after the cancel/);
} finally { await a.cleanup(); } });
test('MCP HTTP: when the caller\'s turn ends while its psr_ask is held (no cancel sent), the answer goes to its queue, not into the dead call', async () => { const a = await askApp(); try {
    const r = await a.call({ service: 'market-data', request: 'Slow question' }, { progressToken: 'tok-d' });
    const ask = a.newest();
    await a.f.router.tick();
    await a.f.router.cancel(principal('grokbot'), a.work.id); await a.f.router.tick();
    assert.equal(a.f.store.task(a.work.id)!.state, 'canceled');
    assert.ok(sse(await r.text()).every(e => e.method === 'notifications/progress'));
    assert.equal(a.f.store.get<Ask>('ask', ask.id)!.delivery, 'queued');
    a.gpu.finish(a.seat.nativeId, 'Answer nobody held'); await a.f.router.tick();
    // the caller is idle now, so the answer goes out at once as its next turn, never as "delivered" into the dead call
    const settled = a.f.store.get<Ask>('ask', ask.id)!, reply = a.f.store.task(settled.deliveredTaskId!)!;
    assert.deepEqual([settled.state, settled.delivery, reply.replyToTaskId], ['answered', 'delivered', a.work.id]);
    assert.match(reply.prompt, /^\[Router\] 服務回覆/); assert.match(reply.prompt, /│ Answer nobody held/);
} finally { await a.cleanup(); } });
test('MCP HTTP: a Router shutdown ends held psr_ask calls with the queued result, on MCP and REST alike', async () => { const a = await askApp(); try {
    const short = await startHttp(a.f.router, { port: 0, progressMs: 40, askHoldMs: 5000 });
    const r = await a.call({ service: 'market-data', request: 'Held across a restart' }, { progressToken: 'tok-s', base: short.baseUrl });
    const mcpAsk = a.newest();
    const pending = fetch(short.baseUrl + '/v1/tools/psr_ask', { method: 'POST', headers: a.headers, body: JSON.stringify({ service: 'market-data', request: 'And over REST' }) });
    await a.until(() => a.f.store.all<Ask>('ask').length === 2);
    const restAsk = a.newest();
    await short.close();
    const final = sse(await r.text()).at(-1);
    assert.equal(final.id, 9); assert.equal(final.result.isError, false);
    assert.deepEqual(JSON.parse(final.result.content[0].text), { status: 'queued', askId: mcpAsk.id, service: 'market-data', note: 'The answer will arrive as the first message of your next turn. Finish what does not depend on it, then end your turn.' });
    const plain = await pending;
    assert.match(plain.headers.get('content-type')!, /application\/json/);
    assert.equal(((await plain.json()) as { status: string; askId: string }).status, 'queued');
    assert.deepEqual([mcpAsk, restAsk].map(x => a.f.store.get<Ask>('ask', x.id)!.delivery), ['queued', 'queued']);
} finally { await a.cleanup(); } });
test('REST: psr_ask under another spelling of its path (/v1/tools/psr%5Fask) holds the same way: a client that leaves gets the answer queued', async () => { const a = await askApp(); try {
    const abort = new AbortController();
    const pending = fetch(a.http.baseUrl + '/v1/tools/psr%5Fask', { method: 'POST', headers: a.headers, signal: abort.signal, body: JSON.stringify({ service: 'market-data', request: 'Encoded path' }) }).catch(e => e);
    await a.until(() => a.f.store.all<Ask>('ask').length === 1);
    const ask = a.newest();
    abort.abort(); await pending;
    await a.until(() => a.f.store.get<Ask>('ask', ask.id)!.delivery === 'queued');
    await a.f.router.tick(); a.gpu.finish(a.seat.nativeId, 'Answer after the client left'); await a.f.router.tick();
    assert.deepEqual([a.f.store.get<Ask>('ask', ask.id)!.state, a.f.store.get<Ask>('ask', ask.id)!.delivery], ['answered', 'queued']);
} finally { await a.cleanup(); } });
