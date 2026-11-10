import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { fixture, principal, code } from './helpers.js';
import { execute, visibleTools, localToolsTag } from '../src/tools.js';
import { startHttp } from '../src/server.js';
import { localPlace, localName, LOCAL_SILENT_MS, LOCAL_CLOSED_KEEP_MS } from '../src/local.js';
import type { RouterConfig } from '../src/types.js';
import type { PeerMessage } from '../src/peer.js';

const owner = principal();
const LOCAL_TOOLS = ['psr_local_forum_post', 'psr_local_forum_read', 'psr_local_inbox', 'psr_local_message_status', 'psr_local_receive_file', 'psr_local_release', 'psr_local_reply', 'psr_local_resources', 'psr_local_send', 'psr_local_send_file', 'psr_local_status', 'psr_local_take', 'psr_local_wait', 'psr_local_who'];
const place = (cwd: string | null, repo: string | null = null, branch: string | null = null) => ({ cwd, repo, branch });
async function setup(change?: (c: RouterConfig) => void) {
    const f = await fixture(c => { c.hosts.find(h => h.id === 'dev2')!.humanApproval = true; change?.(c); });
    const cred = (hostId: string) => f.router.localPrincipal(f.router.issueLocalCredential(owner, { hostId }).token);
    const join = (c: ReturnType<typeof cred>, where: ReturnType<typeof place>, name = 'claude-code') => { const m = f.router.joinLocal(c, { place: where, client: { name, version: '2.1.316' } }); return { m, p: f.router.touchLocal(c, m.id, where) }; };
    return { f, cred, join };
}

test('local: the owner issues a machine credential per host; it is checked against its record on every use', async (t) => {
    const { f, cred } = await setup(); t.after(f.close);
    assert.throws(() => f.router.issueLocalCredential(principal('muse', { scopes: ['read', 'submit'] }), { hostId: 'lab3' }), code('FORBIDDEN'));
    assert.throws(() => f.router.issueLocalCredential(owner, { hostId: 'dev2' }), code('LOCAL_HOST'));
    assert.throws(() => f.router.issueLocalCredential(owner, { hostId: 'nowhere' }), code('NOT_FOUND'));
    const issued = f.router.issueLocalCredential(owner, { hostId: 'lab3' }), p = f.router.localPrincipal(issued.token);
    assert.deepEqual([p.entryKind, p.clientId, p.scopes, p.hosts], ['local', `localcred:${issued.credentialId}`, ['local'], ['lab3']]);
    assert.throws(() => f.router.localPrincipal(issued.token.slice(0, -2) + 'xx'), code('UNAUTHORIZED'));
    const m = f.router.joinLocal(p, { place: place('/home/me/app') });
    const r = f.router.revokeLocalCredential(owner, { credentialId: issued.credentialId });
    assert.deepEqual(r.closedSessions, [m.id]);
    assert.throws(() => f.router.localPrincipal(issued.token), code('UNAUTHORIZED'));
    const later = f.router.issueLocalCredential(owner, { hostId: 'gpu1' });
    f.advance(366 * 86400000);
    assert.throws(() => f.router.localPrincipal(later.token), code('UNAUTHORIZED'));
    assert.deepEqual(f.router.listHosts(owner).localCredentials!.map(c => [c.hostId, c.revoked]).sort(), [['gpu1', false], ['lab3', true]]);
    assert.equal(f.router.listHosts(principal('muse', { scopes: ['read'] })).localCredentials, undefined);
    assert.ok(cred);
});

test('local: a session joins once, carries its id after that, and is refused in a checkout the Router\'s Paseo sessions use', async (t) => {
    const { f, cred, join } = await setup(); t.after(f.close);
    const gpu = cred('gpu1'), lab = cred('lab3');
    assert.throws(() => f.router.joinLocal(gpu, { place: place('/srv/hft/src') }), code('MANAGED_CHECKOUT'));
    assert.throws(() => f.router.joinLocal(gpu, { place: place('/srv/hft') }), code('MANAGED_CHECKOUT'));
    // an agent's own home folder is no project (older bridges still ask from there); a project checked out below it is
    for (const home of ['/Users/me/.codex', '/Users/me/.claude/', '/home/u/.codex', '/Users/me/.codex/memories', '/Users/me/.codex/worktrees', '/Users/me/.claude/projects/x']) assert.throws(() => f.router.joinLocal(gpu, { place: place(home) }), code('AGENT_HOME'));
    for (const wt of ['/Users/me/.codex/worktrees/Moonfall', '/Users/me/.codex/worktrees/0089/casablanca/src', '/repo/app/.claude/worktrees/feat-x']) assert.equal(f.router.joinLocal(gpu, { place: place(wt) }).cwd, wt);
    const { m } = join(gpu, place('/srv/hft-other', 'Moonfall', 'codex/fixes'));
    assert.deepEqual([m.provider, m.client, m.forumName], ['claude', { name: 'claude-code', version: '2.1.316' }, 'Moonfall@codex/fixes']);
    assert.throws(() => f.router.touchLocal(lab, m.id, place(null)), code('SESSION_NOT_FOUND'));
    assert.throws(() => f.router.leaveLocal(lab, m.id), code('SESSION_NOT_FOUND'));
    assert.throws(() => f.router.joinLocal(owner, { place: place(null) }), code('FORBIDDEN'));
    f.router.leaveLocal(gpu, m.id);
    assert.throws(() => f.router.touchLocal(gpu, m.id, place(null)), code('SESSION_NOT_FOUND'));
    for (let i = 0; i < 64; i++) f.router.joinLocal(lab, { place: place(`/w/${i}`) });
    assert.throws(() => f.router.joinLocal(lab, { place: place('/w/x') }), code('CAPACITY_EXCEEDED'));
});

test('local: sessions on one repository and branch share a forum on any machine; they see who else is there and wake nobody', async (t) => {
    const { f, cred, join } = await setup(); t.after(f.close);
    const gpu = cred('gpu1'), lab = cred('lab3');
    const a = join(gpu, place('/work/Moonfall', 'Moonfall', 'codex/fixes')), b = join(lab, place('/other/Moonfall-wt', 'Moonfall', 'codex/fixes'), 'codex-mcp-client');
    const c = join(gpu, place('/work/Moonfall', 'Moonfall', 'main')), d = join(gpu, place('/tmp/scratch')), e = join(gpu, place('/tmp/other'));
    assert.equal(a.m.forum, b.m.forum);
    assert.notEqual(a.m.forum, c.m.forum);
    assert.notEqual(d.m.forum, e.m.forum);
    assert.match(a.m.forum, /^repo:Moonfall-codex-fixes-[0-9a-f]{8}$/); assert.match(d.m.forum, /^dir:scratch-[0-9a-f]{8}$/);
    // no directory ('/' is where a ChatGPT-app Codex thread without a folder starts the bridge): a forum of its own each
    assert.deepEqual([localPlace({ 'x-psr-cwd': '/' }).cwd, localPlace({ 'x-psr-cwd': '%2Fw%2Fa' }).cwd], [null, '/w/a']);
    const lost = [join(gpu, place(null)), join(gpu, place(null))];
    assert.deepEqual(lost.map(x => x.m.forum), lost.map(x => `solo:${x.m.id}`));
    assert.ok(localName(lost[0].m).startsWith('claude @ no project #'));

    // only local sessions see the local tools, and they see nothing else
    assert.deepEqual(visibleTools(a.p).map(x => x.name).sort(), LOCAL_TOOLS);
    assert.ok(!visibleTools(owner).some(x => x.name.startsWith('psr_local_')));
    await assert.rejects(() => execute(f.router, a.p, 'psr_list_hosts', {}), code('TOOL_NOT_FOUND'));
    await assert.rejects(() => execute(f.router, owner, 'psr_local_status', { text: 'x' }), code('TOOL_NOT_FOUND'));

    const before = f.store.tasks().length, events = f.store.meta('plannerSeq');
    await execute(f.router, b.p, 'psr_local_status', { text: 'checking stage 3 with TOKEN=' + 'abcd1234efgh5678ijkl' });
    const posted = await execute(f.router, a.p, 'psr_local_forum_post', { text: 'camera fix is in BP_Stage3, do not touch it' }) as { forumName: string; seq: number };
    assert.equal(posted.forumName, 'Moonfall@codex/fixes');
    const read = await execute(f.router, b.p, 'psr_local_forum_read', {}) as { posts: { author: { kind: string; name: string }; text: string; mine: boolean }[]; here: { name: string; status: string | null }[] };
    assert.deepEqual(read.posts.map(x => [x.author.kind, x.author.name, x.text, x.mine]), [['local', `claude @ Moonfall #${a.m.id.slice(3, 9)}`, 'camera fix is in BP_Stage3, do not touch it', false]]);
    assert.deepEqual(read.here.map(x => x.name), [`claude @ Moonfall #${a.m.id.slice(3, 9)}`]);
    const other = await execute(f.router, a.p, 'psr_local_forum_read', {}) as { here: { status: string | null }[]; posts: { mine: boolean }[] };
    assert.equal(other.posts[0].mine, true);
    assert.ok(other.here[0].status!.startsWith('checking stage 3 with TOKEN=') && !other.here[0].status!.includes('abcd1234efgh5678ijkl'));
    assert.equal(((await execute(f.router, c.p, 'psr_local_forum_read', {})) as { posts: unknown[] }).posts.length, 0);
    assert.deepEqual([f.store.tasks().length, f.store.meta('plannerSeq')], [before, events]);
    // the owner reads it by its key
    assert.equal(f.router.readForum(owner, { mission: a.m.forum }).posts.length, 1);
    await assert.rejects(() => execute(f.router, a.p, 'psr_local_status', { text: 'two\nlines' }), code('INVALID_ARGUMENT'));
    assert.deepEqual(await execute(f.router, b.p, 'psr_local_status', { text: '' }), { status: null, masked: false });

    // a branch switch moves the session to that branch's forum; posts are bounded per session
    f.router.touchLocal(gpu, a.m.id, place('/work/Moonfall', 'Moonfall', 'main'));
    assert.equal(((await execute(f.router, a.p, 'psr_local_forum_read', {})) as { forumName: string }).forumName, 'Moonfall@main');
    for (let i = 0; i < 19; i++) await execute(f.router, a.p, 'psr_local_forum_post', { text: `note ${i}` });
    await assert.rejects(() => execute(f.router, a.p, 'psr_local_forum_post', { text: 'one too many' }), code('RATE_LIMIT'));
});

test('local: silent sessions close, closed ones go after a day, and forums of open sessions outlive the post retention', async (t) => {
    const { f, cred, join } = await setup(c => { c.limits.receiptMs = 60000; }); t.after(f.close);
    const lab = cred('lab3'), a = join(lab, place('/w/app', 'app', 'main')), b = join(lab, place('/w/lib'));
    await execute(f.router, a.p, 'psr_local_forum_post', { text: 'keep me' });
    f.advance(LOCAL_SILENT_MS - 60000); f.router.touchLocal(lab, a.m.id, place('/w/app', 'app', 'main'));
    f.advance(120000); f.router.gc();
    const state = (id: string) => f.store.get<{ closedAt: number | null; closeReason: string | null }>('local_member', id);
    assert.deepEqual([state(a.m.id)!.closedAt, state(b.m.id)!.closeReason], [null, 'silent']);
    assert.equal(f.router.readForum(owner, { mission: a.m.forum }).posts.length, 1);
    const hosts = f.router.listHosts(owner).hosts.find(h => h.id === 'lab3')!;
    assert.deepEqual(hosts.localSessions, { open: 1, live: 1 });
    const tree = f.router.tree(owner, { of: 'sessions' }), group = tree.groups.find(g => g.kind === 'local')!;
    assert.deepEqual([group.id, group.members!.map(m => [m.memberId, m.forumName, m.live])], ['local:lab3', [[a.m.id, 'app@main', true]]]);
    assert.equal(f.router.tree(principal('muse', { scopes: ['read'], projects: ['hft'] }), { of: 'sessions' }).groups.find(g => g.kind === 'local'), undefined);
    f.router.leaveLocal(lab, a.m.id);
    f.advance(11 * 60000); f.router.gc();
    assert.throws(() => f.router.readForum(owner, { mission: a.m.forum }), code('NOT_FOUND'));
    f.advance(LOCAL_CLOSED_KEEP_MS); f.router.gc();
    assert.deepEqual([state(a.m.id), state(b.m.id)], [undefined, undefined]);
});

async function served(change?: (c: RouterConfig) => void) {
    const s = await setup(change);
    for (const c of s.f.config.clients) process.env[c.tokenEnv] = randomBytes(32).toString('hex');
    const http = await startHttp(s.f.router, { port: 0 });
    return { ...s, http, cleanup: async () => { await http.close(); await s.f.close(); } };
}
const rpc = (method: string, params: unknown = {}, id: number | null = 1) => ({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params });

test('local over HTTP: initialize returns the session id, every later request needs it, DELETE ends the session', async () => {
    const s = await served();
    try {
        const token = s.f.router.issueLocalCredential(owner, { hostId: 'lab3' }).token;
        const post = (body: unknown, extra: Record<string, string> = {}) => fetch(`${s.http.baseUrl}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-psr-cwd': encodeURIComponent('/w/月面 app'), 'x-psr-repo': 'app', 'x-psr-branch': encodeURIComponent('feat/x'), ...extra }, body: JSON.stringify(body) });
        const init = await post(rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '0.166.0' } }));
        const sid = init.headers.get('mcp-session-id')!, result = (await init.json()).result;
        assert.match(init.headers.get('x-psr-tools')!, /^[0-9a-f]{16}$/);
        assert.equal(init.headers.get('x-psr-tools'), localToolsTag());
        assert.match(sid, /^lm_[0-9a-f]{32}$/); assert.match(result.instructions, /Message another session only when you need something only it can give/);
        const m = s.f.store.get<{ cwd: string; branch: string; provider: string }>('local_member', sid)!;
        assert.deepEqual([m.cwd, m.branch, m.provider], ['/w/月面 app', 'feat/x', 'codex']);
        assert.equal((await post(rpc('tools/list'))).status, 400);
        assert.equal((await post(rpc('tools/list'), { 'mcp-session-id': 'lm_nope' })).status, 404);
        const tools = (await (await post(rpc('tools/list'), { 'mcp-session-id': sid })).json()).result.tools.map((x: { name: string }) => x.name).sort();
        assert.deepEqual(tools, LOCAL_TOOLS);
        const call = await (await post(rpc('tools/call', { name: 'psr_local_forum_post', arguments: { text: 'hello' } }), { 'mcp-session-id': sid })).json();
        assert.equal(JSON.parse(call.result.content[0].text).forumName, 'app@feat/x');
        assert.equal((await post(rpc('notifications/initialized', {}, null), { 'mcp-session-id': sid })).status, 202);
        const end = await fetch(`${s.http.baseUrl}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sid } });
        assert.equal(end.status, 200);
        assert.equal((await post(rpc('tools/list'), { 'mcp-session-id': sid })).status, 404);
        // a session id is no use with another machine's credential, nor a credential on the console's REST tools
        const other = s.f.router.issueLocalCredential(owner, { hostId: 'gpu1' }).token;
        const rest = await fetch(`${s.http.baseUrl}/v1/tools/psr_local_status`, { method: 'POST', headers: { authorization: `Bearer ${other}`, 'content-type': 'application/json' }, body: '{"text":"x"}' });
        assert.deepEqual([rest.status, rest.headers.get('x-psr-tools')], [403, localToolsTag()]);
        const console = await fetch(`${s.http.baseUrl}/v1/tools/psr_list_hosts`, { method: 'POST', headers: { authorization: `Bearer ${process.env[s.f.config.clients[0].tokenEnv]}`, 'content-type': 'application/json' }, body: '{}' });
        assert.deepEqual([console.status, console.headers.get('x-psr-tools')], [200, null]);
        assert.equal((await fetch(`${s.http.baseUrl}/integrations/local/psr-local.mjs`)).status, 200);
        assert.equal((await fetch(`${s.http.baseUrl}/integrations/local/psr-hook.mjs`)).status, 200);
    }
    finally { await s.cleanup(); }
});

const BRIDGE = resolve(dirname(fileURLToPath(import.meta.url)), '../../integrations/local/psr-local.mjs');
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const children: ReturnType<typeof spawn>[] = [];
/** The bridge as a session starts it: in the session's directory, talking newline-delimited JSON-RPC on stdio. */
function bridge(cwd: string, home: string, env: Record<string, string> = {}, launcher: string[] = []) {
    // never the messaging socket of the session running the tests: a bridge would put messages into it
    const { CLAUDE_CODE_MESSAGING_SOCKET: _socket, CLAUDE_CODE_MESSAGING_TOKEN: _token, ...inherited } = process.env;
    const child = spawn(process.execPath, [...launcher, BRIDGE], { cwd, env: { ...inherited, PSR_LOCAL_DIR: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    const waiting = new Map<number, (m: any) => void>(), lines = createInterface({ input: child.stdout! }), notes: string[] = [];
    lines.on('line', line => { const m = JSON.parse(line); if (m.id === undefined) { notes.push(m.method); return; } waiting.get(m.id)?.(m); waiting.delete(m.id); });
    let n = 0;
    const call = (method: string, params: unknown = {}) => new Promise<any>(done => { const id = ++n; waiting.set(id, done); child.stdin!.write(JSON.stringify(rpc(method, params, id)) + '\n'); });
    const notify = (method: string, params: unknown = {}) => child.stdin!.write(JSON.stringify(rpc(method, params, null)) + '\n');
    const exited = new Promise(done => child.once('exit', done));
    return { call, notify, notes, end: async () => { child.stdin!.end(); await exited; }, kill: () => child.kill('SIGTERM'), exited };
}

test('psr-local bridge: joins from the session\'s directory with its repository and branch, rejoins when closed, and says goodbye on SIGTERM', { skip: !hasGit && 'git is not installed' }, async () => {
    const s = await served();
    const tmp = mkdtempSync(join(tmpdir(), 'psr-local-')), home = join(tmp, 'conf'), repo = join(tmp, 'Demo-worktree');
    try {
        mkdirSync(home); mkdirSync(repo);
        const token = s.f.router.issueLocalCredential(owner, { hostId: 'lab3' }).token, cred = s.f.router.localPrincipal(token);
        writeFileSync(join(home, 'local.json'), JSON.stringify({ url: s.http.baseUrl }));
        writeFileSync(join(home, 'local.token'), token + '\n', { mode: 0o600 });
        const sh = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
        sh('init', '-q', '-b', 'feat/x'); sh('remote', 'add', 'origin', 'git@github.com:me/Demo.git');
        type M = { id: string; cwd: string; repo: string; branch: string; provider: string; startedAt: number; closedAt: number | null; closeReason: string | null };
        const members = () => s.f.store.all<M>('local_member').sort((a, b) => a.startedAt - b.startedAt || (a.closedAt === null ? 1 : -1));
        const b = bridge(repo, home);
        assert.equal((await b.call('server/discover')).error.code, -32601);
        const init = await b.call('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'claude-code', version: '2.1.316' } });
        assert.match(init.result.instructions, /psr_local_forum_read/);
        assert.equal(init.result.capabilities.tools.listChanged, true);
        b.notify('notifications/initialized');
        assert.equal((await b.call('tools/list')).result.tools.length, LOCAL_TOOLS.length);
        const posted = JSON.parse((await b.call('tools/call', { name: 'psr_local_forum_post', arguments: { text: 'from the bridge' } })).result.content[0].text);
        assert.equal(posted.forumName, 'Demo@feat/x');
        assert.deepEqual(b.notes, []);
        const [m] = members();
        assert.deepEqual([m.repo, m.branch, m.provider, m.cwd.endsWith('Demo-worktree')], ['Demo', 'feat/x', 'claude', true]);
        // the Router closed it meanwhile (as after the machine slept): the next request joins again on its own
        s.f.router.leaveLocal(cred, m.id);
        const again = await b.call('tools/call', { name: 'psr_local_status', arguments: { text: 'back' } });
        assert.equal(again.result.isError, false);
        assert.deepEqual(members().map(x => x.closedAt === null), [false, true]);
        // the session ends: Claude Code and Codex stop the server with a signal; the bridge closes its session first
        b.kill(); await b.exited;
        assert.ok(members().every(x => x.closedAt !== null) && members()[1].closeReason === 'closed');

        // no Router: the session still starts, the tools come from the last list and say what is wrong
        writeFileSync(join(home, 'local.json'), JSON.stringify({ url: 'http://127.0.0.1:9' }));
        const off = bridge(repo, home);
        assert.match((await off.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client' } })).result.instructions, /unreachable/);
        assert.equal((await off.call('tools/list')).result.tools.length, LOCAL_TOOLS.length);
        const failed = await off.call('tools/call', { name: 'psr_local_forum_read', arguments: {} });
        assert.deepEqual([failed.result.isError, /unreachable.*Do not touch resources/.test(failed.result.content[0].text)], [true, true]);
        await off.end();
        // the version Claude Code asked for before: the last answer from the caches, at once; the tools still say what is wrong
        const start = JSON.parse(readFileSync(join(home, 'start.json'), 'utf8'));
        assert.deepEqual([start.versions, typeof start.tag, /psr_local_forum_read/.test(start.result.instructions)], [{ '2025-11-25': '2025-06-18' }, 'string', true]);
        const fast = bridge(repo, home), fastInit = await fast.call('initialize', { protocolVersion: '2025-11-25', clientInfo: { name: 'claude-code' } });
        assert.deepEqual([fastInit.result.protocolVersion, /psr_local_forum_read/.test(fastInit.result.instructions), fastInit.result.capabilities.tools.listChanged], ['2025-06-18', true, true]);
        assert.equal((await fast.call('tools/list')).result.tools.length, LOCAL_TOOLS.length);
        assert.match((await fast.call('tools/call', { name: 'psr_local_forum_read', arguments: {} })).result.content[0].text, /unreachable/);
        await fast.end();
    }
    finally { for (const c of children) if (c.exitCode === null) c.kill('SIGKILL'); await s.cleanup(); rmSync(tmp, { recursive: true, force: true }); }
});

test('psr-local bridge: stays out of agent home folders without asking the Router, and takes a Router refusal as final', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'psr-local-')), home = join(tmp, 'conf'), codexDir = join(tmp, 'me', '.codex'), custom = join(tmp, 'codex-state'), managed = join(tmp, 'managed');
    for (const d of [home, codexDir, custom, managed]) mkdirSync(d, { recursive: true });
    const s = await served(c => c.daemons.find(d => d.id === 'lab-test')!.mappings.push({ cwd: realpathSync(managed), projectId: 'hft', workspaceId: 'psr-test-managed', mutationDomainId: 'psr-test-managed', releasePolicy: 'on_turn_end' }));
    try {
        writeFileSync(join(home, 'local.json'), JSON.stringify({ url: s.http.baseUrl }));
        writeFileSync(join(home, 'local.token'), s.f.router.issueLocalCredential(owner, { hostId: 'lab3' }).token + '\n', { mode: 0o600 });
        writeFileSync(join(home, 'tools.json'), JSON.stringify([{ name: 'psr_local_status' }]));
        const stays = async (b: ReturnType<typeof bridge>, why: RegExp) => {
            const init = await b.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client' } });
            assert.match(init.result.instructions, why);
            assert.deepEqual((await b.call('tools/list')).result.tools, []);
            const call = await b.call('tools/call', { name: 'psr_local_status', arguments: { text: 'x' } });
            assert.deepEqual([call.result.isError, call.result.content[0].text.startsWith('Not connected:')], [true, true]);
            b.kill(); await b.exited;
        };
        // ~/.codex by its name, and CODEX_HOME wherever it is: nothing reaches the Router
        await stays(bridge(codexDir, home), /agent's own home folder/);
        await stays(bridge(custom, home, { CODEX_HOME: custom }), /agent's own home folder/);
        // and everything below them (~/.codex/memories is a git repository of its own), except worktrees
        const memories = join(codexDir, 'memories'), state = join(custom, 'sessions'), worktree = join(codexDir, 'worktrees', 'Moonfall');
        for (const d of [memories, state, worktree]) mkdirSync(d, { recursive: true });
        await stays(bridge(memories, home), /agent's own home folder/);
        await stays(bridge(state, home, { CODEX_HOME: custom }), /agent's own home folder/);
        assert.equal(s.f.store.all('local_member').length, 0);
        // the Router refuses (409): the bridge does not keep asking, and lists no tools
        await stays(bridge(managed, home), /checkout the Router's Paseo sessions use/);
        assert.equal(s.f.store.all('local_member').length, 0);
        const wt = bridge(worktree, home);
        await wt.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client' } });
        assert.deepEqual(s.f.store.all<{ cwd: string }>('local_member').map(m => m.cwd), [realpathSync(worktree)]);
        await wt.end();
    }
    finally { for (const c of children) if (c.exitCode === null) c.kill('SIGKILL'); await s.cleanup(); rmSync(tmp, { recursive: true, force: true }); }
});

const until = async (ready: () => boolean, ms = 15000) => { const end = Date.now() + ms; while (!ready()) { assert.ok(Date.now() < end, 'timed out'); await new Promise(r => setTimeout(r, 50)); } };

test('psr-local bridge under Claude Code puts requests and replies into the session\'s own inbox after the turn (the owner\'s urgent ones within it); under Codex it names its thread', async () => {
    const s = await served();
    const tmp = mkdtempSync(join(tmpdir(), 'psr-local-')), home = join(tmp, 'conf'), work = join(tmp, 'work'), sock = join(tmp, 'inbox.sock');
    for (const d of [home, work]) mkdirSync(d);
    // a stand-in for the inbox socket Claude Code gives its servers: the lines each connection sent
    const frames: any[][] = [];
    const inbox = createServer(c => { const lines: any[] = []; frames.push(lines); createInterface({ input: c }).on('line', l => lines.push(JSON.parse(l))); });
    await new Promise<void>(done => inbox.listen(sock, done));
    try {
        const token = s.f.router.issueLocalCredential(owner, { hostId: 'lab3' }).token, cred = s.f.router.localPrincipal(token);
        writeFileSync(join(home, 'local.json'), JSON.stringify({ url: s.http.baseUrl }));
        writeFileSync(join(home, 'local.token'), token + '\n', { mode: 0o600 });
        const gpu = s.f.router.localPrincipal(s.f.router.issueLocalCredential(owner, { hostId: 'gpu1' }).token);
        const a = s.f.router.joinLocal(gpu, { place: place('/w/a'), client: { name: 'claude-code' } }), ap = s.f.router.touchLocal(gpu, a.id, place('/w/a'));
        const b = bridge(work, home, { CLAUDE_CODE_MESSAGING_SOCKET: sock, CLAUDE_CODE_MESSAGING_TOKEN: 'cc-test-token' });
        await b.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1.316' } });
        const me = s.f.store.all<{ id: string; credentialId: string }>('local_member').find(m => m.credentialId === cred.clientId.slice('localcred:'.length))!;
        const msg = (id: string) => s.f.store.get<PeerMessage>('peer_message', id)!;
        const q = s.f.router.localSend(ap, { to: me.id, kind: 'request', text: 'May I take the GPU after your run?' });
        const n = s.f.router.localSend(ap, { to: me.id, kind: 'notice', text: 'FYI: dataset moved' });
        const u = s.f.router.ownerSend(owner, { to: me.id, kind: 'request', text: 'Stop the run now', urgent: true });
        // the bridge reports a push once it has written it, which can be before this stand-in socket has read the lines: wait for both
        const pushed = () => frames.filter(f => f.length === 2);
        await until(() => msg(q.messageId).delivery === 'delivered' && msg(u.messageId).delivery === 'delivered' && pushed().length >= 2);
        assert.deepEqual([msg(q.messageId).deliveredBy, msg(n.messageId).delivery], ['bridge', 'queued']);
        const sent = pushed();
        assert.deepEqual(sent.map(f => [f[0], f[1].type, f[1].message.role, f[1].priority]), [[{ type: 'auth', token: 'cc-test-token' }, 'user', 'user', 'next'], [{ type: 'auth', token: 'cc-test-token' }, 'user', 'user', 'later']]);
        assert.match(sent[0][1].content ?? sent[0][1].message.content, /^\[PSR message pm_\d+: request from the owner, marked urgent by the owner\]/);
        assert.match(sent[1][1].message.content, /May I take the GPU after your run\?\n\[end of message pm_\d+\. Messages come from other sessions/);
        assert.deepEqual(Object.keys(sent[1][1]).sort(), ['message', 'priority', 'type']);
        // a reply on its way back comes the same way; nothing is put in twice
        s.f.router.localReply(s.f.router.touchLocal(cred, me.id, place(realpathSync(work))), { requestId: q.messageId, text: 'yes' });
        const r = s.f.router.localSend(ap, { to: me.id, kind: 'notice', text: 'thanks' });
        await new Promise(done => setTimeout(done, 300));
        assert.equal(frames.filter(f => f.length === 2).length, 2);
        assert.equal(msg(r.messageId).delivery, 'queued');
        await b.end();

        // under Codex: no inbox socket, so nothing is pushed; the thread its tool calls name is reported to the Router
        const T = '019a7c3e-3333-7000-8000-00000000000c';
        const c = bridge(work, home);
        await c.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '0.166.0' } });
        await c.call('tools/call', { name: 'psr_local_status', arguments: { text: 'checking' }, _meta: { 'x-codex-turn-metadata': { session_id: T, thread_id: T, turn_id: 'x' } } });
        const cm = s.f.store.all<{ id: string; thread?: string; closedAt: number | null; provider: string }>('local_member').find(m => m.closedAt === null && m.provider === 'codex')!;
        assert.equal(cm.thread, T);
        const q2 = s.f.router.localSend(ap, { to: cm.id, kind: 'request', text: 'Are you done with src/x.ts?' });
        assert.deepEqual(s.f.router.hookTake(cred, { threadId: T, event: 'Stop' }).messageIds, [q2.messageId]);
        await c.end();
        assert.equal(frames.filter(f => f.length === 2).length, 2);
    }
    finally { for (const c of children) if (c.exitCode === null) c.kill('SIGKILL'); inbox.close(); await s.cleanup(); rmSync(tmp, { recursive: true, force: true }); }
});

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '../../integrations/local/psr-hook.mjs');
/** The hook as Codex runs it: the event as its argument, the hook input on stdin; returns what it printed and its exit code. */
function hook(event: string, input: Record<string, unknown>, home: string) {
    return new Promise<{ out: string; code: number | null }>(done => {
        const child = spawn(process.execPath, [HOOK, event], { env: { ...process.env, PSR_LOCAL_DIR: home, CODEX_THREAD_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        child.stdout!.on('data', d => { out += d; });
        child.once('exit', code => done({ out, code }));
        child.stdin!.end(JSON.stringify({ hook_event_name: event, ...input }));
    });
}

test('psr-hook: a Codex thread\'s Stop, UserPromptSubmit and SessionStart hooks take its messages once, and otherwise say nothing', async () => {
    const s = await served();
    const tmp = mkdtempSync(join(tmpdir(), 'psr-hook-')), home = join(tmp, 'conf'), work = join(tmp, 'work'), codexHome = join(tmp, 'me', '.codex', 'memories');
    for (const d of [home, work, codexHome]) mkdirSync(d, { recursive: true });
    try {
        const token = s.f.router.issueLocalCredential(owner, { hostId: 'lab3' }).token, cred = s.f.router.localPrincipal(token);
        writeFileSync(join(home, 'local.json'), JSON.stringify({ url: s.http.baseUrl }));
        writeFileSync(join(home, 'local.token'), token + '\n', { mode: 0o600 });
        const T = '019a7c3e-4444-7000-8000-00000000000d', other = '019a7c3e-5555-7000-8000-00000000000e';
        const gpu = s.f.router.localPrincipal(s.f.router.issueLocalCredential(owner, { hostId: 'gpu1' }).token);
        const a = s.f.router.joinLocal(gpu, { place: place('/w/a'), client: { name: 'claude-code' } }), ap = s.f.router.touchLocal(gpu, a.id, place('/w/a'));
        const c = s.f.router.joinLocal(cred, { place: place(work), client: { name: 'codex-mcp-client' } });
        s.f.router.touchLocal(cred, c.id, place(work), T);
        const msg = (id: string) => s.f.store.get<PeerMessage>('peer_message', id)!;
        // nothing waiting, another thread, a tool-use event: nothing printed, exit 0
        assert.deepEqual(await hook('Stop', { session_id: T, cwd: work, stop_hook_active: false }, home), { out: '', code: 0 });
        const q = s.f.router.localSend(ap, { to: c.id, kind: 'request', text: 'Are you done with src/x.ts?' });
        assert.deepEqual(await hook('Stop', { session_id: other, cwd: work }, home), { out: '', code: 0 });
        assert.deepEqual(await hook('PostToolUse', { session_id: T, cwd: work }, home), { out: '', code: 0 });
        // an agent home: not even asked
        assert.deepEqual(await hook('Stop', { session_id: T, cwd: codexHome }, home), { out: '', code: 0 });
        assert.equal(msg(q.messageId).delivery, 'queued');
        // the end of a turn: the thread goes on with the message, once
        const stop = await hook('Stop', { session_id: T, cwd: work, stop_hook_active: false }, home);
        const out = JSON.parse(stop.out);
        assert.deepEqual([stop.code, out.decision, Object.keys(out).sort()], [0, 'block', ['decision', 'reason']]);
        assert.match(out.reason, /^\[PSR message pm_\d+: request from claude @ a #/);
        assert.match(out.reason, /Are you done with src\/x\.ts\?/);
        assert.deepEqual([msg(q.messageId).delivery, msg(q.messageId).deliveredBy], ['delivered', 'hook']);
        assert.deepEqual(await hook('Stop', { session_id: T, cwd: work, stop_hook_active: true }, home), { out: '', code: 0 });
        // the user's next prompt and a thread's start carry messages as added context
        const n1 = s.f.router.ownerSend(owner, { to: c.id, kind: 'request', text: 'Pause the GPU job at 15:00' });
        const prompt = JSON.parse((await hook('UserPromptSubmit', { session_id: T, cwd: work, prompt: 'go on' }, home)).out);
        assert.deepEqual([prompt.hookSpecificOutput.hookEventName, /Pause the GPU job/.test(prompt.hookSpecificOutput.additionalContext)], ['UserPromptSubmit', true]);
        s.f.router.localReply(s.f.router.touchLocal(cred, c.id, place(work)), { requestId: n1.messageId, text: 'ok' });
        s.f.router.ownerSend(owner, { to: c.id, kind: 'request', text: 'Welcome back' });
        const start = JSON.parse((await hook('SessionStart', { session_id: T.toUpperCase(), cwd: work, source: 'resume' }, home)).out);
        assert.deepEqual([start.hookSpecificOutput.hookEventName, /Welcome back/.test(start.hookSpecificOutput.additionalContext)], ['SessionStart', true]);
        // no Router: still nothing printed, exit 0, quickly
        writeFileSync(join(home, 'local.json'), JSON.stringify({ url: 'http://127.0.0.1:9' }));
        s.f.router.ownerSend(owner, { to: c.id, kind: 'request', text: 'later' });
        const t0 = Date.now();
        assert.deepEqual(await hook('Stop', { session_id: T, cwd: work }, home), { out: '', code: 0 });
        assert.ok(Date.now() - t0 < 4000);
        // not set up at all
        assert.deepEqual(await hook('Stop', { session_id: T, cwd: work }, join(tmp, 'nowhere')), { out: '', code: 0 });
    }
    finally { await s.cleanup(); rmSync(tmp, { recursive: true, force: true }); }
});

test('psr-local bridge under the Codex daemon puts a thread\'s messages in with codex queue, once each, and leaves nothing for its hooks', async () => {
    const s = await served();
    const tmp = mkdtempSync(join(tmpdir(), 'psr-local-')), home = join(tmp, 'conf'), work = join(tmp, 'work'), calls = join(tmp, 'queue-calls.jsonl');
    for (const d of [home, work]) mkdirSync(d);
    // stand-ins: a parent started like the daemon (--managed-daemon) that runs the bridge as its child, and a codex that
    // records what it was asked to queue (it refuses a message containing REFUSE, as codex queue does without a daemon)
    const daemon = join(tmp, 'fake-daemon.mjs'), codex = join(tmp, 'fake-codex.mjs');
    writeFileSync(daemon, "import { spawn } from 'node:child_process'; const c = spawn(process.execPath, [process.argv.at(-1)], { stdio: 'inherit' }); c.on('exit', code => process.exit(code ?? 0)); process.on('SIGTERM', () => c.kill('SIGTERM'));\n");
    writeFileSync(codex, `#!${process.execPath}\nimport { appendFileSync } from 'node:fs'; const a = process.argv.slice(2); appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + '\\n'); if (a.at(-1).includes('REFUSE')) { console.error('start a local daemon'); process.exit(1); } console.log('Queued message q-1 for thread ' + a[2] + '.');\n`, { mode: 0o755 });
    try {
        const token = s.f.router.issueLocalCredential(owner, { hostId: 'lab3' }).token, cred = s.f.router.localPrincipal(token);
        writeFileSync(join(home, 'local.json'), JSON.stringify({ url: s.http.baseUrl }));
        writeFileSync(join(home, 'local.token'), token + '\n', { mode: 0o600 });
        const gpu = s.f.router.localPrincipal(s.f.router.issueLocalCredential(owner, { hostId: 'gpu1' }).token);
        const a = s.f.router.joinLocal(gpu, { place: place('/w/a'), client: { name: 'claude-code' } }), ap = s.f.router.touchLocal(gpu, a.id, place('/w/a'));
        const msg = (id: string) => s.f.store.get<PeerMessage>('peer_message', id)!;
        const T = '019a7c3e-6666-7000-8000-00000000000f';
        const b = bridge(work, home, { PSR_CODEX_BIN: codex }, [daemon, '--managed-daemon']);
        await b.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'codex-mcp-client', version: '0.166.0' } });
        // before its first Router tool call the thread is unknown, so nothing can be queued for it yet
        const me = s.f.store.all<{ id: string; closedAt: number | null }>('local_member').find(m => m.closedAt === null && m.id !== a.id)!;
        const q = s.f.router.localSend(ap, { to: me.id, kind: 'request', text: 'Are you done with src/x.ts?' });
        await new Promise(r => setTimeout(r, 1500));
        assert.equal(msg(q.messageId).delivery, 'queued');
        await b.call('tools/call', { name: 'psr_local_status', arguments: { text: 'working' }, _meta: { 'x-codex-turn-metadata': { session_id: T, thread_id: T, turn_id: 'x' } } });
        await until(() => msg(q.messageId).delivery === 'delivered');
        assert.equal(msg(q.messageId).deliveredBy, 'bridge');
        const sent = () => readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l));
        assert.deepEqual(sent().map(c => c.slice(0, 4)), [['queue', '--thread', T, '--message']]);
        assert.match(sent()[0][4], /^\[PSR message pm_\d+: request from claude @ a #.*Are you done with src\/x\.ts\?/s);
        // its bridge delivers, so the thread's hooks get nothing
        assert.deepEqual(s.f.router.hookTake(cred, { threadId: T, event: 'Stop' }).messageIds, []);
        // codex queue refused: the message stays queued, to be tried again
        const r = s.f.router.localSend(ap, { to: me.id, kind: 'notice', text: 'x' }), u = s.f.router.ownerSend(owner, { to: me.id, kind: 'request', text: 'REFUSE this one' });
        await until(() => sent().length === 2);
        await new Promise(done => setTimeout(done, 500));
        assert.deepEqual([msg(u.messageId).delivery, msg(r.messageId).delivery, sent().length], ['queued', 'queued', 2]);
        await b.end();
    }
    finally { for (const c of children) if (c.exitCode === null) c.kill('SIGKILL'); await s.cleanup(); rmSync(tmp, { recursive: true, force: true }); }
});

/** A stand-in Router for the bridge: answers initialize, tools/list (one tool named after the current tag), tools/call and
 * ping, and puts the current tag in X-Psr-Tools; tag and port can change while the bridge runs. */
function fakeRouter() {
    const state = { tag: 'tag-1' as string | null, lists: 0, joinDelayMs: 0, refuse: false };
    const server = createHttpServer(async (req, res) => {
        let body = ''; for await (const c of req) body += c;
        if (state.tag) res.setHeader('x-psr-tools', state.tag);
        if (req.method === 'DELETE') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
        const m = JSON.parse(body);
        if (m.id === undefined) { res.writeHead(202); res.end(); return; }
        if (m.method === 'initialize' && state.joinDelayMs) await new Promise(r => setTimeout(r, state.joinDelayMs));
        if (m.method === 'initialize' && state.refuse) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'MANAGED_CHECKOUT', message: '/w is a checkout the Router\'s Paseo sessions use' })); return; }
        if (m.method === 'initialize') res.setHeader('mcp-session-id', 'lm_fake');
        if (m.method === 'tools/list') state.lists++;
        const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'fake', version: '1' }, instructions: 'fake' }
            : m.method === 'tools/list' ? { tools: [{ name: `tools-${state.tag}`, inputSchema: { type: 'object' } }] } : m.method === 'tools/call' ? { content: [{ type: 'text', text: '{}' }] } : {};
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
    return { state, server, listen: (port = 0) => new Promise<number>(done => server.listen(port, '127.0.0.1', () => done((server.address() as { port: number }).port))), close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}

test('psr-local bridge tells its agent to read the tool list again when the Router\'s list changes, once per change, never before the first list', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'psr-local-')), home = join(tmp, 'conf'), work = join(tmp, 'work');
    for (const d of [home, work]) mkdirSync(d);
    const fake = fakeRouter(), port = await fake.listen();
    try {
        writeFileSync(join(home, 'local.json'), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
        writeFileSync(join(home, 'local.token'), 'psrl_test\n', { mode: 0o600 });
        const call = (b: ReturnType<typeof bridge>) => b.call('tools/call', { name: 'x', arguments: {} });
        // nothing to say before the agent has a list, even if the version changes
        const early = bridge(work, home);
        assert.equal((await early.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } })).result.capabilities.tools.listChanged, true);
        fake.state.tag = 'tag-0'; await call(early);
        assert.deepEqual(early.notes, []);
        await early.end();
        fake.state.tag = 'tag-1';
        const b = bridge(work, home);
        await b.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
        assert.deepEqual((await b.call('tools/list')).result.tools.map((t: { name: string }) => t.name), ['tools-tag-1']);
        await call(b);
        assert.deepEqual(b.notes, []);
        // a deploy changed the list: told once, however many answers carry the new version
        fake.state.tag = 'tag-2';
        await call(b); await call(b);
        assert.deepEqual(b.notes, ['notifications/tools/list_changed']);
        assert.deepEqual((await b.call('tools/list')).result.tools.map((t: { name: string }) => t.name), ['tools-tag-2']);
        await call(b);
        assert.equal(b.notes.length, 1);
        // a Router that names no version (an older one) is no change; the next one that does is
        fake.state.tag = null; await call(b);
        fake.state.tag = 'tag-3'; await call(b);
        assert.equal(b.notes.length, 2);
        await b.end();
        // the agent started while the Router was away and got the cached list: told once the Router is back
        await fake.close();
        writeFileSync(join(home, 'tools.json'), JSON.stringify([{ name: 'cached' }]));
        const c = bridge(work, home);
        assert.equal((await c.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } })).result.instructions, 'fake');
        assert.deepEqual((await c.call('tools/list')).result.tools, [{ name: 'cached' }]);
        const again = fakeRouter(); again.state.tag = 'tag-3'; await again.listen(port);
        try {
            await call(c); await call(c);
            assert.deepEqual(c.notes, ['notifications/tools/list_changed']);
            assert.deepEqual((await c.call('tools/list')).result.tools.map((t: { name: string }) => t.name), ['tools-tag-3']);
            await c.end();
        }
        finally { await again.close(); }
    }
    finally { for (const x of children) if (x.exitCode === null) x.kill('SIGKILL'); await fake.close().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); }
});

test('psr-local bridge starts at once from the last session\'s answers and joins in the background; the agent learns of a changed list or a refusal', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'psr-local-')), home = join(tmp, 'conf'), work = join(tmp, 'work');
    for (const d of [home, work]) mkdirSync(d);
    const fake = fakeRouter(), port = await fake.listen();
    const names = (r: any) => r.result.tools.map((t: { name: string }) => t.name);
    const timed = async <T>(f: () => Promise<T>) => { const t = performance.now(); const v = await f(); return [v, performance.now() - t] as const; };
    try {
        writeFileSync(join(home, 'local.json'), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
        writeFileSync(join(home, 'local.token'), 'psrl_test\n', { mode: 0o600 });
        const start = (b: ReturnType<typeof bridge>, protocolVersion = '2025-06-18') => b.call('initialize', { protocolVersion, clientInfo: { name: 'codex-mcp-client' } });
        // nothing cached yet: it waits for the Router, then keeps what it answered
        const a = bridge(work, home);
        fake.state.joinDelayMs = 1500;
        const [, slow] = await timed(() => start(a));
        assert.ok(slow >= 1400, `first start waited for the Router (${slow.toFixed(0)} ms)`);
        assert.deepEqual(names(await a.call('tools/list')), ['tools-tag-1']);
        await a.end();
        assert.deepEqual(JSON.parse(readFileSync(join(home, 'start.json'), 'utf8')), { versions: { '2025-06-18': '2025-06-18' }, result: { capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'fake', version: '1' }, instructions: 'fake' }, tag: 'tag-1' });
        // cached: the answer and the tool list come at once, before the slow join is done; a tool call waits for the join
        fake.state.joinDelayMs = 4000;
        const b = bridge(work, home), lists = fake.state.lists;
        const [init, fast] = await timed(() => start(b));
        const [list, listed] = await timed(() => b.call('tools/list'));
        assert.ok(fast + listed < 3000, `answered from the caches (${fast.toFixed(0)} + ${listed.toFixed(0)} ms)`);
        assert.deepEqual([init.result.instructions, init.result.protocolVersion, init.result.capabilities.tools.listChanged, names(list), fake.state.lists], ['fake', '2025-06-18', true, ['tools-tag-1'], lists]);
        const [called, waited] = await timed(() => b.call('tools/call', { name: 'x', arguments: {} }));
        assert.ok(!called.result.isError && waited > 1000, `the call waited for the join (${waited.toFixed(0)} ms)`);
        assert.deepEqual(b.notes, []);
        await b.end();
        // a deploy changed the list since: the agent is told once the join answers, and reads the new list
        fake.state.joinDelayMs = 500; fake.state.tag = 'tag-2';
        const c = bridge(work, home);
        await start(c);
        assert.deepEqual(names(await c.call('tools/list')), ['tools-tag-1']);
        await until(() => c.notes.length > 0, 5000);
        assert.deepEqual(c.notes, ['notifications/tools/list_changed']);
        assert.deepEqual(names(await c.call('tools/list')), ['tools-tag-2']);
        await c.end();
        assert.equal(JSON.parse(readFileSync(join(home, 'start.json'), 'utf8')).tag, 'tag-2');
        // the Router refuses this session: the agent is told the list changed, reads an empty one, and calls say why
        fake.state.refuse = true;
        const d = bridge(work, home);
        await start(d);
        assert.deepEqual(names(await d.call('tools/list')), ['tools-tag-2']);
        await until(() => d.notes.length > 0, 5000);
        assert.deepEqual([d.notes, names(await d.call('tools/list'))], [['notifications/tools/list_changed'], []]);
        assert.match((await d.call('tools/call', { name: 'x', arguments: {} })).result.content[0].text, /^Not connected: .*checkout the Router's Paseo sessions use/);
        await d.end();
        // a protocol version no earlier session asked for: it waits for the Router, as without caches
        fake.state.refuse = false; fake.state.joinDelayMs = 1500;
        const e = bridge(work, home);
        const [, other] = await timed(() => start(e, '2099-01-01'));
        assert.ok(other >= 1400, `an unknown version waited for the Router (${other.toFixed(0)} ms)`);
        await e.end();
    }
    finally { for (const x of children) if (x.exitCode === null) x.kill('SIGKILL'); await fake.close().catch(() => {}); rmSync(tmp, { recursive: true, force: true }); }
});

test('local over HTTP: psr_local_wait is held as an event stream; a cancel gets no result and takes nothing; at its limit and at shutdown it answers arrived false', async () => {
    const s = await setup();
    for (const c of s.f.config.clients) process.env[c.tokenEnv] = randomBytes(32).toString('hex');
    const R = 'lab3/unreal-editor', http = await startHttp(s.f.router, { port: 0, progressMs: 40, waitHoldMs: 5000 }), short = await startHttp(s.f.router, { port: 0, progressMs: 40, waitHoldMs: 150 });
    let closed = false;
    try {
        s.f.router.setResource(owner, { resourceId: R });
        const token = s.f.router.issueLocalCredential(owner, { hostId: 'lab3' }).token, cred = s.f.router.localPrincipal(token);
        const post = (body: unknown, sid?: string, base = http.baseUrl, signal?: AbortSignal) => fetch(`${base}/mcp`, { method: 'POST', signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-psr-cwd': encodeURIComponent('/w/app'), ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
        const joined = async () => (await post(rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1.316' } }))).headers.get('mcp-session-id')!;
        const call = (sid: string, name: string, args: unknown = {}, id = 1, o: { token?: string; base?: string; signal?: AbortSignal } = {}) => post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(o.token ? { _meta: { progressToken: o.token } } : {}) } }, sid, o.base, o.signal);
        const tool = async (sid: string, name: string, args: unknown = {}) => JSON.parse((await (await call(sid, name, args)).json()).result.content[0].text);
        // event-stream blocks: JSON messages, and comment lines that only keep the connection alive
        const blocks = (text: string) => text.split('\n\n').filter(Boolean).map(e => e.includes('data: ') ? JSON.parse(e.slice(e.indexOf('data: ') + 6)) : e);
        const pushable = async (sid: string) => (await s.f.router.pushWait(s.f.router.touchLocal(cred, sid, place('/w/app')), { timeoutMs: 0 })).messages;
        const a = await joined(), b = await joined(), c = await joined();
        assert.equal((await tool(a, 'psr_local_take', { resource: R })).you, 'holding');
        assert.equal((await tool(b, 'psr_local_take', { resource: R })).you, 'waiting');
        // held with progress on the caller's token, then what arrived; once the answer went out whole the notice is read
        const held = await call(b, 'psr_local_wait', {}, 7, { token: 'tok-w' });
        assert.equal(held.status, 200); assert.match(held.headers.get('content-type')!, /^text\/event-stream/);
        assert.match(held.headers.get('x-psr-tools')!, /^[0-9a-f]{16}$/);
        await new Promise(r => setTimeout(r, 130));
        await tool(a, 'psr_local_release', { resource: R });
        const events = blocks(await held.text()), final = events.at(-1), body = JSON.parse(final.result.content[0].text);
        assert.ok(events.length >= 2 && events.slice(0, -1).every((e, i) => e.method === 'notifications/progress' && e.params.progressToken === 'tok-w' && e.params.progress === i + 1));
        assert.deepEqual([final.id, final.result.isError, body.arrived, body.holding.map((h: { resourceId: string }) => h.resourceId), body.messages.length], [7, false, true, [R], 1]);
        await until(() => s.f.store.all<PeerMessage>('peer_message').every(x => x.to.ref !== b || x.delivery === 'read'));
        assert.deepEqual(await pushable(b), []);
        // a cancel names the call by its request id, and only its own session's: no result, and nothing was taken
        const canceled = await call(c, 'psr_local_wait', {}, 9);
        const cancel = (sid: string, requestId: unknown) => post(rpc('notifications/cancelled', { requestId, reason: 'User interrupted' }, null), sid);
        assert.equal((await cancel(a, 9)).status, 202);
        assert.equal((await cancel(c, 10)).status, 202);
        await new Promise(r => setTimeout(r, 120));
        assert.equal((await cancel(c, 9)).status, 202);
        const quiet = blocks(await canceled.text());
        assert.ok(quiet.length >= 1 && quiet.every(e => typeof e === 'string' && e.startsWith(':')), 'no progress token: comment lines only, the other cancels ended nothing, and no result after its own cancel');
        s.f.router.ownerSend(owner, { to: c, kind: 'request', text: 'After the cancel?' });
        assert.equal((await pushable(c)).length, 1, 'pushes to the session go on as usual');
        assert.equal((await tool(c, 'psr_local_inbox')).messages.length, 1);
        // a client that goes away takes nothing either: what comes after is pushed as usual
        const gone = new AbortController(), dropped = await call(c, 'psr_local_wait', {}, 11, { signal: gone.signal });
        void dropped.text().catch(() => {});
        assert.deepEqual(await pushable(c), []);
        gone.abort();
        // (sent in the very tick of the abort, the answer would still be handed to the socket whole: let the server see the drop)
        await new Promise(r => setTimeout(r, 100));
        s.f.router.ownerSend(owner, { to: c, kind: 'request', text: 'After the drop?' });
        for (const end = Date.now() + 4000; (await pushable(c)).length !== 1;) { assert.ok(Date.now() < end, 'the dropped wait still holds pushes back'); await new Promise(r => setTimeout(r, 20)); }
        // at its limit: nothing yet, with where the session stands
        const d = await joined(), late = blocks(await (await call(d, 'psr_local_wait', {}, 12, { token: 'tok-l', base: short.baseUrl })).text()).at(-1);
        const said = JSON.parse(late.result.content[0].text);
        assert.equal(said.arrived, false); assert.match(said.note, /not in line for any resource/);
        // schema: no arguments
        assert.equal((await (await call(d, 'psr_local_wait', { seconds: 5 }, 13)).json()).result.isError, true);
        // a shutdown answers the held call at once
        const hanging = await call(d, 'psr_local_wait', {}, 14, { token: 'tok-s' }), started = Date.now();
        await http.close(); closed = true;
        const last = blocks(await hanging.text()).at(-1);
        assert.equal(JSON.parse(last.result.content[0].text).arrived, false);
        assert.ok(Date.now() - started < 3000);
    } finally { if (!closed) await http.close(); await short.close(); await s.f.close(); }
});

test('psr-local bridge: a held psr_local_wait passes through it, progress first, then what arrived; a cancel ends it without a result and takes nothing', async () => {
    const s = await setup();
    for (const c of s.f.config.clients) process.env[c.tokenEnv] = randomBytes(32).toString('hex');
    const R = 'lab3/unreal-editor', http = await startHttp(s.f.router, { port: 0, progressMs: 40, waitHoldMs: 5000 });
    const tmp = mkdtempSync(join(tmpdir(), 'psr-local-')), home = join(tmp, 'conf'), dir = join(tmp, 'proj');
    try {
        mkdirSync(home); mkdirSync(dir);
        s.f.router.setResource(owner, { resourceId: R });
        const token = s.f.router.issueLocalCredential(owner, { hostId: 'lab3' }).token, cred = s.f.router.localPrincipal(token);
        writeFileSync(join(home, 'local.json'), JSON.stringify({ url: http.baseUrl }));
        writeFileSync(join(home, 'local.token'), token + '\n', { mode: 0o600 });
        const b = bridge(dir, home), tool = async (name: string, args: unknown = {}) => JSON.parse((await b.call('tools/call', { name, arguments: args })).result.content[0].text);
        await b.call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1.316' } });   // call 1
        const holder = s.join(s.cred('gpu1'), place('/w/holder'));
        s.f.router.localTake(holder.p, { resource: R });
        assert.equal((await tool('psr_local_take', { resource: R })).you, 'waiting');   // call 2
        const me = s.f.store.all<{ id: string; cwd: string | null; closedAt: number | null }>('local_member').find(m => m.closedAt === null && !!m.cwd?.endsWith('/proj'))!;
        const pushable = async () => (await s.f.router.pushWait(s.f.router.touchLocal(cred, me.id, place(me.cwd)), { timeoutMs: 0 })).messages;
        // held: the agent sees progress on its token, then the answer of the same call
        const held = b.call('tools/call', { name: 'psr_local_wait', arguments: {}, _meta: { progressToken: 'tok-b' } });   // call 3
        await until(() => b.notes.includes('notifications/progress'));
        s.f.router.localRelease(holder.p, { resource: R });
        const got = JSON.parse((await held).result.content[0].text);
        assert.deepEqual([got.arrived, got.holding.map((h: { resourceId: string }) => h.resourceId), got.messages.length], [true, [R], 1]);
        await until(() => s.f.store.all<PeerMessage>('peer_message').every(x => x.to.ref !== me.id || x.delivery === 'read'));
        // the agent gives up on a held call (Esc): the bridge passes the cancel on, the call gets no result, pushes go on
        let answered = false;
        void b.call('tools/call', { name: 'psr_local_wait', arguments: {} }).then(() => { answered = true; });   // call 4
        await new Promise(r => setTimeout(r, 150));
        assert.deepEqual(await pushable(), [], 'waiting: nothing is pushed');
        b.notify('notifications/cancelled', { requestId: 4, reason: 'User interrupted' });
        await new Promise(r => setTimeout(r, 150));
        s.f.router.ownerSend(owner, { to: me.id, kind: 'request', text: 'After the cancel?' });
        for (const end = Date.now() + 4000; (await pushable()).length !== 1;) { assert.ok(Date.now() < end, 'the canceled wait still holds pushes back'); await new Promise(r => setTimeout(r, 20)); }
        assert.equal(answered, false);
        await b.end();
    } finally { await http.close(); await s.f.close(); rmSync(tmp, { recursive: true, force: true }); }
});
