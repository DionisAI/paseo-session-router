#!/usr/bin/env node
// psr-local: the stdio MCP server a local Claude Code or Codex session starts to reach the Paseo Session Router.
// It reads this machine's credential from ~/.config/psr (never from the agent's own config), tells the Router where the
// session works (its directory, repository and branch, worked out here because the agent's PWD can be wrong), keeps the
// session id the Router gave it, pings every 2 minutes, and says goodbye when the session ends. Besides forwarding what the
// session asks, it does one thing on its own: it puts messages other sessions sent this one (requests and replies, see the
// Router's psr_local_send) into the session between turns, never during one. Under Claude Code through the session's own
// inbox, which Claude Code gives its servers (only the owner's urgent ones land within the turn). Under a Codex thread on
// the shared Codex daemon (codex --remote unix://) through `codex queue`: Codex holds the message until the turn ends, and
// an idle thread starts a turn with it. Any other Codex (a plain codex, the ChatGPT app) has its hooks take its messages;
// for those the bridge only tells the Router which thread it serves. And when a deploy changes the Router's tool list, it
// tells the agent to read the list again (notifications/tools/list_changed), so a running session gets new tools without a
// restart (Claude Code does this; Codex only with its mcp_tool_list_changed feature). It starts at once from what the last
// session on this machine got from the Router (start.json, tools.json) and joins the Router in the background: an agent that
// starts its first turn while a server is still starting leaves that server out (Codex does), and a join takes a second or
// two over the network. Files a session sends or receives (psr_local_send_file, psr_local_receive_file) it moves itself,
// through the Router, with psr-xfer.mjs next to it. No dependencies; Node 18 or newer.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, renameSync, realpathSync, existsSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join, basename, dirname, resolve, sep } from 'node:path';

const VERSION = '7';
const dir = process.env.PSR_LOCAL_DIR || join(homedir(), '.config', 'psr');
const out = message => process.stdout.write(JSON.stringify(message) + '\n');
const warn = text => process.stderr.write(`psr-local: ${text}\n`);

let endpoint = null, token = null, notReady = null;
try {
    const conf = JSON.parse(readFileSync(join(dir, 'local.json'), 'utf8'));
    endpoint = new URL('/mcp', conf.url);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) throw new Error('the Router URL must use https (http only on loopback)');
    token = readFileSync(join(dir, 'local.token'), 'utf8').trim();
    if (!token.startsWith('psrl_')) throw new Error('local.token is not a machine credential');
} catch (e) { notReady = `psr-local is not set up on this machine (${e.message}); run integrations/local/install.sh`; warn(notReady); }

// Where this session works: the directory the agent started this server in, and its git repository and branch.
const cwd = process.cwd();
const git = (...args) => { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
let place = null, placeAt = 0;
function where() {
    if (place && Date.now() - placeAt < 60000) return place;
    // worktrees of one repository share its origin (or its common .git directory), so they land on one forum per branch;
    // symbolic-ref also names the branch of a repository without commits, and names none on a detached HEAD
    const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
    let repo = null, branch = null;
    if (common) {
        const origin = git('config', '--get', 'remote.origin.url');
        repo = (origin ? origin.replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '') : basename(dirname(common))) || null;
        branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
    }
    place = { cwd, repo, branch };
    placeAt = Date.now();
    return place;
}

// An agent's own home folder is no project (the ChatGPT app's Codex starts short background threads in ~/.codex and
// ~/.codex/memories): the bridge stays out of it and everything below it, offering no tools and sending nothing. Worktrees
// are projects: <home>/worktrees/<name> (the Codex app's) and a repository's own .claude/worktrees/<name> still join.
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
const below = (home, path) => { const rest = path === home ? [] : path.startsWith(home + sep) ? path.slice(home.length + 1).split(sep) : null; return rest !== null && !(rest[0] === 'worktrees' && rest.length >= 2); };
const agentHome = (() => {
    const parts = real(cwd).split(sep), i = parts.findIndex(x => x === '.codex' || x === '.claude');
    if (i >= 0 && below(parts.slice(0, i + 1).join(sep), parts.join(sep))) return true;
    return [process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR].some(h => h && below(real(h), real(cwd)));
})();
// Claude Code gives the servers of a session a socket to that session's own inbox; Codex gives none (its hooks deliver).
const inbox = process.env.CLAUDE_CODE_MESSAGING_SOCKET && process.env.CLAUDE_CODE_MESSAGING_TOKEN ? { path: process.env.CLAUDE_CODE_MESSAGING_SOCKET, token: process.env.CLAUDE_CODE_MESSAGING_TOKEN } : null;
/** The Codex thread this bridge serves: Codex starts one server per thread and names the thread in each tool call. */
let thread = null;
// Started by the shared Codex daemon (`codex app-server ... --managed-daemon`): its threads take queued messages from any
// process through `codex queue`, which goes through that daemon. The same codex binary queues (PSR_CODEX_BIN overrides it).
const daemonCodex = (() => {
    if (inbox) return null;
    let parent = '';
    try { parent = execFileSync('ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 3000 }).trim(); } catch { return null; }
    if (!/\s--managed-daemon(\s|$)/.test(parent)) return null;
    const own = parent.split(' app-server ')[0];
    return process.env.PSR_CODEX_BIN || (own && existsSync(own) ? own : 'codex');
})();
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let sid = null, protocol = null, init = null, clientName = 'unknown', closing = false;
// The Router names the version of the tool list on every answer (X-Psr-Tools). servedTag is the version of the list the agent
// last got: undefined before it asked for one, null when it got one of unknown version (from the cache, or from an older
// Router). A different version on any later answer means the list changed: the agent is told once per version.
// routerTag is the latest version the Router named (an answer without one keeps it).
let servedTag, notifiedTag = null, routerTag = null;
const listChanged = () => out({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
function seen(tag) {
    if (typeof tag === 'string' && tag) routerTag = tag;
    if (!routerTag || servedTag === undefined || routerTag === servedTag || routerTag === notifiedTag || closing) return;
    notifiedTag = routerTag;
    listChanged();
}
/** Why this session does not join (an agent home, or the Router refused it with 409): no tools, nothing sent. */
let refused = agentHome ? `${cwd} is an agent's own home folder, not a project; psr-local stays out here` : null;
function headers(extra = {}) {
    const p = where(), h = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': `${clientName} (psr-local/${VERSION})`, ...extra };
    if (p.cwd) h['x-psr-cwd'] = encodeURIComponent(p.cwd);
    if (p.repo) h['x-psr-repo'] = encodeURIComponent(p.repo);
    if (p.branch) h['x-psr-branch'] = encodeURIComponent(p.branch);
    if (sid) h['mcp-session-id'] = sid;
    if (protocol) h['mcp-protocol-version'] = protocol;
    if (thread) h['x-psr-thread'] = thread;
    return h;
}
/** POST one message. An event-stream answer is passed on as it arrives (progress notifications included); a JSON one is
 * returned. A Router refusal comes back as { status, error: { code, message } }. */
async function send(message, timeoutMs, onMessage = out) {
    const r = await fetch(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) });
    // a tools/list answer sets the version the agent has (forward); every other answer may say the list changed since
    const tag = r.headers.get('x-psr-tools');
    if (message.method !== 'tools/list') seen(tag);
    if (r.status === 202) return { status: 202, tag };
    if ((r.headers.get('content-type') ?? '').includes('text/event-stream') && r.body) {
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of r.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
                const data = buffer.slice(0, end).split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
                buffer = buffer.slice(end + 2);
                if (data) { try { onMessage(JSON.parse(data)); } catch { /* not JSON: skip */ } }
            }
        }
        return { status: r.status, streamed: true, tag };
    }
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    if (r.status !== 200 || !body || body.jsonrpc !== '2.0') return { status: r.status, tag, error: { code: body?.code ?? `HTTP_${r.status}`, message: body?.message ?? text.slice(0, 200) } };
    return { status: 200, body, tag, sid: r.headers.get('mcp-session-id') };
}
/** Join the Router as this session (again after it closed us, e.g. while the machine slept). What it answers is kept for
 * the next session's fast start. */
async function joinRouter() {
    const r = await send({ jsonrpc: '2.0', id: 'psr-local-initialize', method: 'initialize', params: init }, 15000);
    if (r.status === 200 && r.sid && r.body.result) {
        sid = r.sid; protocol = r.body.result.protocolVersion ?? null;
        const { protocolVersion, ...result } = r.body.result, asked = init?.protocolVersion;
        if (typeof protocolVersion === 'string' && typeof asked === 'string' && typeof result.instructions === 'string') saveStart(st => ({ ...st, result, versions: { ...st.versions, [asked]: protocolVersion } }));
        return r.body.result;
    }
    // 409: the Router will not take this session (a checkout its Paseo sessions use, an agent home); retrying cannot help
    if (r.status === 409 && r.error) { refused = r.error.message; return null; }
    throw new Error(r.error ? `${r.error.code}: ${r.error.message}` : `HTTP ${r.status}`);
}
/** One join at a time: a request that needs the Router waits for the join already under way. */
let joining = null;
const joinNow = () => joining ??= joinRouter().finally(() => { joining = null; });
const atomic = (file, data) => { try { writeFileSync(`${file}.${process.pid}.tmp`, data); renameSync(`${file}.${process.pid}.tmp`, file); } catch { /* caches are a convenience */ } };
const toolsCache = join(dir, 'tools.json');
function cachedTools() { try { const t = JSON.parse(readFileSync(toolsCache, 'utf8')); return Array.isArray(t) ? t : []; } catch { return []; } }
const cacheTools = tools => atomic(toolsCache, JSON.stringify(tools));
// start.json: the Router's initialize answer (instructions, capabilities, server info), the protocol it agreed for each version
// an agent asked for, and the version of the tool list last written to tools.json. Any bridge on the machine may rewrite it.
const startCache = join(dir, 'start.json');
function readStart() {
    try { const st = JSON.parse(readFileSync(startCache, 'utf8')); return st && typeof st.result?.instructions === 'string' && st.versions && typeof st.versions === 'object' ? st : null; }
    catch { return null; }
}
const saveStart = update => atomic(startCache, JSON.stringify(update(readStart() ?? { versions: {} })));
/** The start this session made from the caches (null when it waited for the Router): tools/list is answered from tools.json
 * until the join is done, with the version start.json names for it. */
let fastStart = null;
const localReply = (m, result) => out({ jsonrpc: '2.0', id: m.id, result });
/** No Router for this request: tool calls say so as a tool result (the model reads it), the tool list comes from the cache. */
function unavailable(m, why) {
    if (m.id === undefined) return;
    if (m.method === 'tools/list') { servedTag = refused || notReady ? null : readStart()?.tag ?? null; return localReply(m, { tools: refused || notReady ? [] : cachedTools() }); }
    if (m.method === 'ping') return localReply(m, {});
    const text = refused ? `Not connected: ${refused}` : notReady ?? `The Router is unreachable (${why}). Nothing was sent. Do not touch resources other sessions share until it is back.`;
    if (m.method === 'tools/call') return localReply(m, { content: [{ type: 'text', text }], isError: true });
    out({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: text } });
}
/** This bridge tells the agent when the tool list changes, whatever the Router itself says it can do. */
const listChanges = result => ({ ...result, capabilities: { ...result.capabilities, tools: { ...result.capabilities?.tools, listChanged: true } } });
async function onInitialize(m) {
    init = m.params ?? {};
    if (typeof init.clientInfo?.name === 'string') clientName = init.clientInfo.name.replace(/[^\x20-\x7e]/g, '').slice(0, 60) || 'unknown';
    if (!notReady && !refused) {
        // fast start: the last answer to an agent asking this protocol version, at once; the join follows in the background.
        // A Router that then refuses this session (409) gets the agent told that the list changed: it reads an empty one.
        const st = readStart(), agreed = typeof init.protocolVersion === 'string' ? st?.versions[init.protocolVersion] : undefined;
        if (typeof agreed === 'string') {
            fastStart = st;
            localReply(m, listChanges({ ...st.result, protocolVersion: agreed }));
            setImmediate(() => joinNow().then(() => { if (refused && servedTag !== undefined && !closing) listChanged(); }, e => warn(`Router unreachable at start (${e.message}); its tools say so until it is back`)));
            return;
        }
        try { const result = await joinNow(); if (result) return localReply(m, listChanges(result)); }
        catch (e) { warn(`Router unreachable at start (${e.message}); its tools say so until it is back`); }
    }
    // answered here: the session starts either way, and the tools tell it why nothing works
    const instructions = refused ? `Not connected: ${refused}.` : notReady ?? 'The Paseo Session Router is unreachable right now; its tools say so until it is back. Do not touch resources other sessions share meanwhile.';
    localReply(m, listChanges({ protocolVersion: init.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'psr-local', version: VERSION }, instructions }));
}
// Files for another session or machine (psr_local_send_file, psr_local_receive_file): this bridge reads and writes them on
// this machine, inside the session's project (its git repository, else its directory), and sends them through the Router
// with psr-xfer.mjs (next to this file). The bytes never pass through the agent.
const FILE_TOOLS = new Set(['psr_local_send_file', 'psr_local_receive_file']);
async function fileTool(m) {
    const reply = (body, isError = false) => localReply(m, { content: [{ type: 'text', text: JSON.stringify(body) }], isError });
    try {
        if (!sid) await joinNow().catch(() => {});
        const xfer = await import(new URL('./psr-xfer.mjs', import.meta.url).href);
        const root = git('rev-parse', '--show-toplevel') ?? cwd, a = m.params.arguments ?? {}, h = headers(), named = {};
        // the Router names the sender or receiver after this session
        for (const k of ['mcp-session-id', 'x-psr-cwd', 'x-psr-repo', 'x-psr-branch', 'x-psr-thread']) if (h[k]) named[k] = h[k];
        const conf = { url: endpoint, headers: { authorization: `Bearer ${token}` } };
        if (m.params.name === 'psr_local_send_file') reply(await xfer.send(conf, xfer.inside(root, a.path), named));
        else reply(await xfer.receive(conf, a.code, join(root, 'psr-inbox'), { inbox: true, extraHeaders: named }));
    } catch (e) { reply({ code: e.code ?? 'ERROR', message: e.message }, true); }
}
async function forward(m) {
    if (notReady || refused) return unavailable(m, 'not set up');
    if (m.method === 'tools/call' && FILE_TOOLS.has(m.params?.name) && m.id !== undefined) return fileTool(m);
    const turn = m.method === 'tools/call' ? m.params?._meta?.['x-codex-turn-metadata'] : null, named = turn?.thread_id ?? turn?.session_id;
    if (!thread && typeof named === 'string' && THREAD.test(named)) thread = named.toLowerCase();
    // a fast start answers the tool list from the cache until the join is done (the version check then tells the agent if it
    // changed); everything else waits for the join
    if (m.method === 'tools/list' && !sid && fastStart && m.id !== undefined) {
        const tools = cachedTools();
        if (tools.length) { servedTag = fastStart.tag ?? null; notifiedTag = null; localReply(m, { tools }); seen(null); return; }
    }
    try {
        if (!sid) { await joinNow(); if (refused) return unavailable(m, 'refused'); }
        const timeoutMs = m.method === 'tools/call' ? 15 * 60000 : 30000;
        let r = await send(m, timeoutMs);
        if (r.status === 404) { sid = null; await joinNow(); if (refused) return unavailable(m, 'refused'); r = await send(m, timeoutMs); }
        if (r.status === 202 || r.streamed) return;
        if (r.body) {
            if (m.method === 'tools/list' && Array.isArray(r.body.result?.tools)) {
                cacheTools(r.body.result.tools); saveStart(st => ({ ...st, tag: r.tag ?? null }));
                servedTag = r.tag ?? null; notifiedTag = null; if (r.tag) routerTag = r.tag;
            }
            return out(r.body);
        }
        unavailable(m, `${r.error.code}: ${r.error.message}`);
    }
    catch (e) { unavailable(m, e instanceof Error ? e.message : String(e)); }
}

let initialized = null;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.method !== 'string') return;
    if (m.method === 'initialize') { initialized = onInitialize(m); return; }
    // before initialize (Claude Code probes with server/discover first): nothing goes to the Router
    if (!initialized) { if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } }); return; }
    initialized.then(() => forward(m));
}).on('close', shutdown);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, shutdown);

// a ping every 2 minutes keeps the session live on the Router; one it closed (the machine slept) is joined again
let pings = 0;
setInterval(() => {
    if (!sid || closing) return;
    send({ jsonrpc: '2.0', id: `psr-local-ping-${++pings}`, method: 'ping' }, 10000, () => {}).then(r => { if (r.status === 404) { sid = null; joinNow().catch(() => {}); } }).catch(() => {});
}, 120000).unref();

// Messages for this session (Claude Code only): a long poll on the Router, each one put into the session's inbox with
// priority 'later' (taken when the current turn ends; 'next', within the turn, only for the owner's urgent ones), then a
// receipt for what went in. One that could not be put in comes again on the next poll; one put in but not acknowledged is
// acknowledged again, never put in twice.
const sleep = ms => new Promise(done => setTimeout(done, ms).unref());
async function post(path, body, timeoutMs) {
    const r = await fetch(new URL(path, endpoint), { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    seen(r.headers.get('x-psr-tools'));
    let data = null;
    try { data = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, data };
}
function tell(x) {
    return new Promise(done => {
        let settled = false;
        const finish = ok => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); done(ok); };
        const socket = createConnection(inbox.path), timer = setTimeout(() => finish(false), 5000);
        socket.on('error', () => finish(false));
        socket.on('connect', () => socket.end(`${JSON.stringify({ type: 'auth', token: inbox.token })}\n${JSON.stringify({ type: 'user', message: { role: 'user', content: x.text }, priority: x.urgent ? 'next' : 'later' })}\n`, () => finish(true)));
    });
}
/** Puts one message into a Codex thread on the daemon: queued behind its current turn, or starting a turn if it is idle.
 * Never with -c overrides (codex queue then refuses, or would write through a server that does not own the thread). */
function queueIt(x) {
    return new Promise(done => execFile(daemonCodex, ['queue', '--thread', thread, '--message', x.text], { timeout: 20000, maxBuffer: 65536 }, (e, stdout) => done(!e && /Queued message/.test(String(stdout)))));
}
const deliver = inbox ? tell : daemonCodex ? queueIt : null;
const told = new Set();
async function pushLoop() {
    while (!closing) {
        // a Codex thread is known from its first Router tool call; until then nothing can be queued for it
        if (!sid || refused || notReady || (daemonCodex && !thread)) { await sleep(1000); continue; }
        try {
            const r = await post('/local/push', { timeoutMs: 50000 }, 60000);
            if (r.status === 404) { sid = null; await joinNow().catch(() => {}); continue; }
            if (r.status !== 200 || !Array.isArray(r.data?.messages)) { await sleep(30000); continue; }
            const put = [];
            for (const x of r.data.messages) {
                if (told.has(x.messageId) || await deliver(x)) { told.add(x.messageId); put.push(x.messageId); }
                else { warn(`could not put a message into this session${daemonCodex ? ' (codex queue)' : '\'s inbox'}; trying again in 30 s`); break; }
            }
            if (put.length) {
                const a = await post('/local/push/ack', { messageIds: put }, 15000);
                if (a.status === 200) for (const id of put) told.delete(id);
                else await sleep(5000);
            }
            if (put.length < r.data.messages.length) await sleep(30000);
        }
        catch { await sleep(30000); }
    }
}
if (deliver && !notReady && !agentHome) pushLoop();

async function shutdown() {
    if (closing) return;
    closing = true;
    if (sid) { try { await fetch(endpoint, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(2000) }); } catch { /* the Router closes silent sessions itself */ } }
    process.exit(0);
}
