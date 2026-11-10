import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Router } from './core.js';
import { Auth } from './auth.js';
import { execute, visibleTools, openapi, startAsk, localToolsTag } from './tools.js';
import { mcp, MCP_VERSIONS, isAskCall, streamAsk, plainAsk, isWaitCall, streamWait } from './mcp.js';
import { PLAIN_HOLD_MS } from './services.js';
import { ASK_TOOL } from './agent-channel.js';
import { Fault, assert, authFingerprint } from './util.js';
import { localPlace, localThread } from './local.js';
import type { Principal } from './types.js';
import { weatherSource, type WeatherSource } from './weather.js';
export interface AppOptions {
    port?: number;
    listen?: string;
    webDir?: string;
    integrationDir?: string;
    /** the console's sky; defaults to the config's weather place (none: no outside request) */
    weather?: WeatherSource;
    /** psr_ask holds: progress notification interval (default 20 s) and a hold limit overriding the service's (tests only). */
    progressMs?: number;
    askHoldMs?: number;
    /** How long one psr_local_wait call holds (tests shorten it). */
    waitHoldMs?: number;
}
export async function startHttp(router: Router, options: AppOptions = {}) {
    const auth = new Auth(router.config, router.store, token => router.agentPrincipal(token), token => router.localPrincipal(token));
    const weather = options.weather ?? weatherSource({ place: router.config.weather ?? null });
    const webDir = options.webDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
    const integrationDir = options.integrationDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../integrations/cloud-shell');
    /** Third-party browser modules, versioned in the path so they can be cached for good; served gzip-compressed. */
    const vendorFiles = new Set(['/vendor/three-0.186.1/three.module.js', '/vendor/three-0.186.1/three.core.js']);
    const vendorCache = new Map<string, {
        raw: Buffer;
        gz: Buffer;
    }>();
    /** Installers for shell-only cloud agents and for local sessions (psr-local): public within the Router's network like the console assets; they contain no secrets. */
    const integrationFiles: Record<string, [
        string,
        string
    ]> = { '/integrations/cloud-shell/install.sh': ['install.sh', 'text/plain; charset=utf-8'], '/integrations/cloud-shell/psr': ['psr', 'text/plain; charset=utf-8'], '/integrations/cloud-shell/AGENT.md': ['AGENT.md', 'text/markdown; charset=utf-8'], '/integrations/local/install.sh': ['../local/install.sh', 'text/plain; charset=utf-8'], '/integrations/local/psr-local.mjs': ['../local/psr-local.mjs', 'text/plain; charset=utf-8'], '/integrations/local/psr-hook.mjs': ['../local/psr-hook.mjs', 'text/plain; charset=utf-8'], '/integrations/local/psr-xfer.mjs': ['../local/psr-xfer.mjs', 'text/plain; charset=utf-8'] };
    const buckets = new Map<string, {
        window: number;
        count: number;
    }>();
    let streamCount = 0;
    /** Open long responses and how each ends on shutdown: a held psr_ask answers queued (it is in the caller's queue), an event
     * stream just ends. */
    const streams = new Map<ServerResponse, () => void>();
    const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    async function body(req: IncomingMessage) { assert(!req.headers['content-length'] || Number(req.headers['content-length']) <= 65536, 'PAYLOAD_TOO_LARGE', 'Request exceeds 64 KiB', 413); assert(req.headers['content-type']?.split(';')[0] === 'application/json', 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json', 415); const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        assert(bytes <= 65536, 'PAYLOAD_TOO_LARGE', 'Request exceeds 64 KiB', 413);
        chunks.push(Buffer.from(chunk));
    } try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new Fault('INVALID_JSON', 'Malformed JSON');
    } }
    const server = createServer(async (req, res) => {
        const requestId = randomUUID();
        res.setHeader('x-content-type-options', 'nosniff');
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('x-frame-options', 'DENY');
        res.setHeader('x-request-id', requestId);
        res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
        try {
            const origin = req.headers.origin;
            const own = `http://${req.headers.host}`;
            const allowed = new Set([...(router.config.allowedOrigins ?? []), ...(router.config.publicOrigin ? [router.config.publicOrigin] : []), `http://127.0.0.1:${(server.address() as any)?.port}`, `http://localhost:${(server.address() as any)?.port}`]);
            const allowedHosts = new Set([...allowed].map(v => new URL(v).host));
            assert(typeof req.headers.host === 'string' && allowedHosts.has(req.headers.host), 'FORBIDDEN', 'Unrecognized Host header', 403);
            if (origin)
                assert(allowed.has(origin), 'FORBIDDEN', 'Origin is not allowed', 403);
            if (origin && origin !== own) {
                res.setHeader('access-control-allow-origin', origin);
                res.setHeader('vary', 'Origin');
                res.setHeader('access-control-allow-headers', 'Authorization, Content-Type, MCP-Protocol-Version, Accept');
                res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
            }
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                res.end();
                return;
            }
            const url = new URL(req.url ?? '/', own), path = url.pathname;
            if (path === '/healthz' && req.method === 'GET') {
                json(res, 200, { status: 'ok', version: '0.3.0' });
                return;
            }
            const staticFiles: Record<string, [
                string,
                string
            ]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/park.js': ['park.js', 'text/javascript; charset=utf-8'], '/views.js': ['views.js', 'text/javascript; charset=utf-8'], '/relations.js': ['relations.js', 'text/javascript; charset=utf-8'], '/park.css': ['park.css', 'text/css; charset=utf-8'] };
            if (req.method === 'GET' && staticFiles[path]) {
                const [name, type] = staticFiles[path];
                res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
                res.end(readFileSync(resolve(webDir, name)));
                return;
            }
            if (req.method === 'GET' && vendorFiles.has(path)) {
                let entry = vendorCache.get(path);
                if (!entry) {
                    const raw = readFileSync(resolve(webDir, path.slice(1)));
                    entry = { raw, gz: gzipSync(raw, { level: 9 }) };
                    vendorCache.set(path, entry);
                }
                const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
                res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable', vary: 'Accept-Encoding', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
                res.end(gzip ? entry.gz : entry.raw);
                return;
            }
            if (req.method === 'GET' && integrationFiles[path]) {
                const [name, type] = integrationFiles[path];
                res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
                res.end(readFileSync(resolve(integrationDir, name)));
                return;
            }
            assert(!url.searchParams.has('token') && !url.searchParams.has('access_token'), 'INVALID_ARGUMENT', 'Never put bearer tokens in URLs');
            // A front-end's scopes are the owner's ceiling narrowed by the planner's grant (both from the policy).
            const p = router.effective(auth.authenticate(req.headers.authorization));
            if (p.entryKind === 'local') res.setHeader('x-psr-tools', localToolsTag());
            const now = Date.now();
            const bucket = buckets.get(p.clientId);
            if (!bucket || now - bucket.window >= 60000)
                buckets.set(p.clientId, { window: now, count: 1 });
            else {
                bucket.count++;
                assert(bucket.count <= 600, 'RATE_LIMIT', 'Entry rate limit exceeded', 429);
            }
            if (path === '/v1/weather' && req.method === 'GET') {
                json(res, 200, await weather());
                return;
            }
            if (path === '/v1/whoami' && req.method === 'GET') {
                json(res, 200, { ...p, mode: router.config.mode, templates: router.config.templates.filter(t => { const d = router.config.daemons.find(d => d.id === t.daemonId)!; const m = d.mappings.find(m => m.cwd === t.cwd)!; return (p.projects.includes('*') || p.projects.includes(m.projectId)) && (p.hosts.includes('*') || p.hosts.includes(d.hostId)); }).filter(t => !t.seat || p.scopes.includes('admin')).map(t => ({ id: t.id, title: t.title, daemonId: t.daemonId, provider: t.provider, ...(t.seat ? { seat: true } : {}) })) });
                return;
            }
            if (path === '/openapi.json' && req.method === 'GET') {
                json(res, 200, openapi(router.config.publicOrigin ?? own));
                return;
            }
            if (path === '/v1/tools' && req.method === 'GET') {
                json(res, 200, { tools: visibleTools(p) });
                return;
            }
            // files between machines (psr-xfer, the psr-local bridge, the owner): the bytes stream to and from the Router's disk,
            // never through the 64 KiB JSON reader; a machine's bridge names its session with Mcp-Session-Id (a session the
            // Router closed meanwhile leaves the machine as the sender or receiver)
            const sessionOf = (): Principal => {
                const sid = req.headers['mcp-session-id'];
                if (p.entryKind !== 'local' || typeof sid !== 'string' || sid.length > 100) return p;
                try { return router.touchLocal(p, sid, localPlace(req.headers), localThread(req.headers)); } catch { return p; }
            };
            if (path === '/v1/transfers' && req.method === 'POST') {
                assert(req.headers['content-type']?.split(';')[0] === 'application/octet-stream', 'UNSUPPORTED_MEDIA_TYPE', 'Send the file as application/octet-stream', 415);
                const declared = req.headers['content-length'] ?? req.headers['x-psr-size'], size = declared === undefined ? null : Number(declared);
                assert(size === null || (Number.isSafeInteger(size) && size >= 0), 'INVALID_ARGUMENT', 'Content-Length or X-Psr-Size: the file size in bytes');
                const caller = sessionOf();
                json(res, 200, await router.uploadTransfer(caller, { name: url.searchParams.get('name'), size, body: req }));
                return;
            }
            const settle = req.method === 'POST' ? /^\/v1\/transfers\/([^/]{1,64})\/(received|release)$/.exec(path) : null;
            if (settle) {
                await body(req);
                const caller = sessionOf();
                json(res, 200, router.settleTransfer(caller, decodeURIComponent(settle[1]), settle[2] as 'received' | 'release'));
                return;
            }
            const transferCode = req.method === 'GET' ? /^\/v1\/transfers\/([^/]{1,64})$/.exec(path)?.[1] : undefined;
            if (transferCode !== undefined) {
                const caller = sessionOf();
                const { transfer: t, code } = router.openTransfer(caller, decodeURIComponent(transferCode));
                res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(t.size), 'cache-control': 'no-store', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(t.name)}`, 'x-psr-name': encodeURIComponent(t.name), 'x-psr-sha256': t.sha256, 'x-psr-code': code, 'x-psr-from': encodeURIComponent(t.from.name), 'x-psr-sent-at': String(t.createdAt) });
                // received once the receiver confirms it has the whole file (POST …/received); a download that breaks off
                // gives it back at once, one the receiver could not keep it gives back itself (…/release)
                let sent = false;
                res.once('finish', () => { sent = true; });
                res.once('close', () => { if (!sent) router.releaseTransfer(t); });
                const file = router.transfers.stream(t);
                file.once('error', () => res.destroy());
                file.pipe(res);
                return;
            }
            // route on the decoded name: /v1/tools/psr%5Fask is psr_ask too and must hold the same way
            const toolName = req.method === 'POST' && path.startsWith('/v1/tools/') ? decodeURIComponent(path.slice('/v1/tools/'.length)) : null;
            if (toolName === ASK_TOOL) {
                const ask = startAsk(router, p, await body(req));
                res.once('close', () => streams.delete(res));
                streams.set(res, plainAsk(router, ask, res, options.askHoldMs ?? PLAIN_HOLD_MS));
                return;
            }
            if (toolName !== null) {
                const result = await execute(router, p, toolName, await body(req));
                json(res, 200, result);
                return;
            }
            if (path === '/v1/admin/revoke-client' && req.method === 'POST') {
                const data = await body(req);
                assert(typeof data?.clientId === 'string' && Object.keys(data).length === 1, 'INVALID_ARGUMENT', 'Provide only clientId');
                json(res, 200, auth.revoke(p, data.clientId));
                return;
            }
            // the psr-local bridge's own calls (never tools a model sees): its long poll for messages to put into its session
            // between turns and the receipt for those it put in; a Codex hook of a thread takes that thread's messages
            if (p.entryKind === 'local' && req.method === 'POST' && (path === '/local/push' || path === '/local/push/ack' || path === '/local/hook')) {
                const data = await body(req) ?? {};
                assert(typeof data === 'object' && !Array.isArray(data), 'INVALID_ARGUMENT', 'Send a JSON object');
                if (path === '/local/hook') { json(res, 200, router.hookTake(p, data)); return; }
                const sid = req.headers['mcp-session-id'];
                assert(typeof sid === 'string' && sid.length <= 100, 'SESSION_REQUIRED', 'Mcp-Session-Id required', 400);
                const caller = router.touchLocal(p, sid, localPlace(req.headers), localThread(req.headers));
                json(res, 200, path === '/local/push' ? await router.pushWait(caller, data) : router.pushAck(caller, data));
                return;
            }
            if (path === '/mcp') {
                // a local session (psr-local bridge) ends with DELETE and its session id
                if (p.entryKind === 'local' && req.method === 'DELETE') {
                    const sid = req.headers['mcp-session-id'];
                    assert(typeof sid === 'string' && sid.length <= 100, 'SESSION_REQUIRED', 'Mcp-Session-Id required', 400);
                    json(res, 200, router.leaveLocal(p, sid));
                    return;
                }
                if (req.method === 'GET' || req.method === 'DELETE') {
                    res.setHeader('allow', 'POST');
                    json(res, 405, { message: 'Stateless MCP endpoint uses JSON POST; task updates are available through tools.' });
                    return;
                }
                assert(req.method === 'POST', 'METHOD_NOT_ALLOWED', 'Use POST', 405);
                assert(req.headers.accept?.includes('application/json') && req.headers.accept.includes('text/event-stream'), 'NOT_ACCEPTABLE', 'MCP clients must accept application/json and text/event-stream', 406);
                const version = req.headers['mcp-protocol-version'];
                if (version !== undefined)
                    assert(typeof version === 'string' && MCP_VERSIONS.includes(version), 'UNSUPPORTED_PROTOCOL', 'Unsupported MCP protocol version', 400);
                const input = await body(req);
                // an agent's psr_ask waits for its answer on this request (an event stream with progress)
                if (isAskCall(input) && p.entryKind === 'agent') {
                    res.once('close', () => streams.delete(res));
                    const stop = streamAsk(router, p, input, res, { userAgent: String(req.headers['user-agent'] ?? ''), progressMs: options.progressMs ?? 20000, holdMs: options.askHoldMs });
                    if (stop) streams.set(res, stop);
                    return;
                }
                // a local session joins with initialize (and gets its session id back); every later request carries that id
                let caller: Principal = p, joined: string | null = null;
                if (p.entryKind === 'local') {
                    const place = localPlace(req.headers), init = (input as { method?: unknown } | null)?.method === 'initialize';
                    if (init) { const m = router.joinLocal(p, { place, client: (input as { params?: { clientInfo?: { name?: unknown; version?: unknown } } }).params?.clientInfo }); joined = m.id; caller = { ...p, clientId: `local:${m.id}` }; }
                    else { const sid = req.headers['mcp-session-id']; assert(typeof sid === 'string' && sid.length <= 100, 'SESSION_REQUIRED', 'Initialize first: a local session sends its Mcp-Session-Id with every request', 400); caller = router.touchLocal(p, sid, place, localThread(req.headers)); }
                }
                // a local session's psr_local_wait waits on this request (an event stream) for what otherwise reaches it between turns
                if (p.entryKind === 'local' && !joined && isWaitCall(input)) {
                    res.once('close', () => streams.delete(res));
                    const stop = streamWait(router, caller, input, res, { progressMs: options.progressMs ?? 20000, holdMs: options.waitHoldMs });
                    if (stop) streams.set(res, stop);
                    return;
                }
                const result = await mcp(router, caller, input);
                if (joined) res.setHeader('mcp-session-id', joined);
                if (result === null) {
                    res.writeHead(202);
                    res.end();
                }
                else
                    json(res, 200, result);
                return;
            }
            const query = Object.fromEntries(url.searchParams);
            const filters = { ...(query.projectId ? { projectId: query.projectId } : {}), ...(query.hostId ? { hostId: query.hostId } : {}) };
            if (path === '/v1/events' && req.method === 'GET') {
                assert(Object.keys(query).every(k => ['after', 'projectId', 'hostId'].includes(k)), 'INVALID_ARGUMENT', 'Unknown event query');
                assert(streamCount < 32, 'CAPACITY_EXCEEDED', 'Too many event streams', 429);
                let cursor = query.after;
                let chunk = router.updates(p, cursor, 100, filters);
                res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive', 'x-accel-buffering': 'no' });
                streamCount++;
                streams.set(res, () => res.end());
                let busy = false, done = false;
                const send = (event: string, payload: unknown) => { if (!res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)) {
                    res.end();
                    return false;
                } return true; };
                send('changes', chunk);
                cursor = chunk.cursor;
                const timer = setInterval(() => { if (busy || done)
                    return; busy = true; try {
                    const current = router.effective(auth.authenticate(req.headers.authorization));
                    assert(authFingerprint(current) === authFingerprint(p), 'RESYNC_REQUIRED', 'Authorization changed', 409);
                    chunk = router.updates(current, cursor, 100, filters);
                    cursor = chunk.cursor;
                    if (chunk.events.length || chunk.hasMore)
                        send('changes', chunk);
                    else
                        res.write(': heartbeat\n\n');
                }
                catch (e) {
                    const f = e instanceof Fault ? e : new Fault('INTERNAL', 'Stream ended');
                    send('resync_required', { code: f.code, message: f.message });
                    res.end();
                }
                finally {
                    busy = false;
                } }, 1000);
                const cleanup = () => { if (done)
                    return; done = true; clearInterval(timer); streamCount--; streams.delete(res); };
                res.on('close', cleanup);
                return;
            }
            const route = async (name: string, args: unknown) => { json(res, 200, await execute(router, p, name, args)); };
            if (path === '/v1/hosts' && req.method === 'GET') {
                await route('psr_list_hosts', {});
                return;
            }
            if (path === '/v1/sessions' && req.method === 'GET') {
                await route('psr_list_sessions', { ...query, ...(query.limit ? { limit: Number(query.limit) } : {}) });
                return;
            }
            if (path === '/v1/resolve-target' && req.method === 'POST') {
                await route('psr_resolve_target', await body(req));
                return;
            }
            if (path === '/v1/tasks') {
                if (req.method === 'GET') {
                    await route('psr_list_tasks', query);
                    return;
                }
                if (req.method === 'POST') {
                    await route('psr_submit_task', await body(req));
                    return;
                }
            }
            if (path === '/v1/asks' && req.method === 'GET') {
                await route('psr_list_asks', { ...query, ...(query.limit ? { limit: Number(query.limit) } : {}) });
                return;
            }
            if (path === '/v1/topology' && req.method === 'GET') {
                await route('psr_get_topology', query);
                return;
            }
            if (path === '/v1/updates' && req.method === 'GET') {
                await route('psr_read_updates', { ...query, ...(query.limit ? { limit: Number(query.limit) } : {}) });
                return;
            }
            if (path === '/v1/handoffs' && req.method === 'POST') {
                await route('psr_handoff', await body(req));
                return;
            }
            let match = path.match(/^\/v1\/sessions\/([^/]+)$/);
            if (match && req.method === 'GET') {
                await route('psr_get_session', { sessionRef: decodeURIComponent(match[1]) });
                return;
            }
            match = path.match(/^\/v1\/tasks\/([^/]+)$/);
            if (match && req.method === 'GET') {
                await route('psr_get_task', { taskId: decodeURIComponent(match[1]) });
                return;
            }
            match = path.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
            if (match && req.method === 'POST') {
                const b = await body(req);
                assert(Object.keys(b).length === 0, 'INVALID_ARGUMENT', 'Cancel body must be {}');
                await route('psr_cancel_task', { taskId: decodeURIComponent(match[1]) });
                return;
            }
            throw new Fault('NOT_FOUND', 'Endpoint not found', 404);
        }
        catch (e) {
            const f = e instanceof Fault ? e : new Fault('INTERNAL', 'Unexpected server error', 500);
            if (f.status === 401)
                res.setHeader('www-authenticate', 'Bearer realm="paseo-session-router"');
            if (!res.headersSent)
                json(res, f.status, { code: f.code, message: f.message, requestId });
            else
                res.end();
        }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? router.config.port, options.listen ?? router.config.listen, () => resolve()); });
    const port = (server.address() as any).port as number;
    return { server, auth, port, baseUrl: `http://127.0.0.1:${port}`, close: async () => { for (const stop of [...streams.values()])
            stop(); router.releaseWaits(); server.closeIdleConnections();
        // the long polls answer now; their keep-alive connections go idle a moment later and are closed as they do. Whatever
        // still holds a connection after 3 s (a slow client) is cut, so a restart never outlasts its stop timeout.
        const idle = setInterval(() => server.closeIdleConnections(), 50), cut = setTimeout(() => server.closeAllConnections(), 3000);
        idle.unref(); cut.unref();
        await new Promise<void>(resolve => server.close(() => resolve())); clearInterval(idle); clearTimeout(cut); } };
}
