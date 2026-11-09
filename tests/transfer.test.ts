import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { request as rawRequest } from 'node:http';
import { fixture, principal, code, withServices } from './helpers.js';
import { execute, visibleTools } from '../src/tools.js';
import { startHttp } from '../src/server.js';
import { newCode, normalizeCode, secretPath, workspacePath, tarRefusal, TRANSFER_MAX_BYTES, TRANSFER_B64_PART_BYTES, TRANSFER_TEXT_BYTES } from '../src/transfers.js';
import type { RouterConfig } from '../src/types.js';

const owner = principal(), grok = principal('grokbot');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type F = Awaited<ReturnType<typeof fixture>>;
const token = (f: F, nativeId: string) => { for (const d of f.demos.values()) { const c = d.channels.get(nativeId); if (c?.mode === 'http') return c.token; } throw new Error(`no http channel for ${nativeId}`); };
/** Two sessions created now on the http channel (lab on lab3 in /srv/backtests, gpu on gpu1 in /srv/hft-queue), each in a
 * running Router turn of mission m-xfer. */
async function setup(change?: (c: RouterConfig) => void) {
    const f = await fixture(c => { withServices(c); c.templates.push({ id: 'gpu-codex', daemonId: 'gpu-research', cwd: '/srv/hft-queue', provider: 'codex/demo', title: 'Queue helper' }); change?.(c); });
    const lab = await f.router.createSession(owner, { templateId: 'lab-codex', idempotencyKey: 'xfer-lab-0001' });
    const gpu = await f.router.createSession(owner, { templateId: 'gpu-codex', idempotencyKey: 'xfer-gpu-0001' });
    let n = 0;
    const send = (s: { id: string }, prompt = 'Work', extra: { missionId?: string } = { missionId: 'm-xfer' }) => f.router.submit(grok, { routeTicket: f.ticket(grok, s.id), prompt, idempotencyKey: `xfer-task-${++n}`, ...extra });
    send(lab, 'Lab half'); send(gpu, 'GPU half');
    await f.router.tick();
    const agentOf = (s: { nativeId: string }) => f.router.agentPrincipal(token(f, s.nativeId));
    return { f, lab, gpu, A: agentOf(lab), B: agentOf(gpu), agentOf, send, labDemo: f.demos.get('lab-test')!, gpuDemo: f.demos.get('gpu-research')! };
}
const call = async (f: F, p: Parameters<typeof execute>[1], name: string, args: unknown) => await execute(f.router, p, name, args) as any;

test('files: codes are xfer-XXXX-XXXX-XXXX, typed any way; paths stay in the working directory; credential paths are named', () => {
    const c = newCode();
    assert.match(c, /^xfer-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(normalizeCode(c.toLowerCase()), c);
    assert.equal(normalizeCode(c.slice(5).replace(/-/g, ' ')), c);
    assert.equal(normalizeCode('xfer-7K2M-9QX4-AB3O'), 'xfer-7K2M-9QX4-AB30');
    for (const bad of ['', 'xfer-123', 'xfer-7K2M-9QX4-AB3U', 'hello world']) assert.equal(normalizeCode(bad), null, bad);
    assert.equal(workspacePath('/srv/w', '/srv/w/out/r.md'), 'out/r.md');
    assert.equal(workspacePath('/srv/w/', './out//r.md'), 'out/r.md');
    for (const bad of ['../x', '/srv/other/x', '/srv/w', 'a/../../x', '']) assert.throws(() => workspacePath('/srv/w', bad), code('INVALID_ARGUMENT'), bad);
    for (const p of ['.env', 'app/.env.local', 'id_ed25519', 'certs/server.pem', '.ssh/config', 'x/.config/psr/local.token', '.claude/settings.json']) assert.ok(secretPath(p), p);
    for (const p of ['.env.example', 'id_ed25519.pub', 'report.md', 'keys.csv', 'env/notes.txt']) assert.equal(secretPath(p), null, p);
});

test('files: a Paseo session sends a file for a one-time code; another takes it into psr-inbox/<code>/, once', async (t) => {
    const { f, lab, gpu, A, B, labDemo, gpuDemo } = await setup(); t.after(f.close);
    const body = Buffer.from('# Fills\nmaker fills look fine; details in fills.csv\n');
    labDemo.files.set('/srv/backtests/out/report.md', body);
    const sent = await call(f, A, 'psr_send_file', { path: '/srv/backtests/out/report.md' });
    assert.deepEqual([sent.name, sent.size, sent.sha256], ['report.md', body.length, sha(body)]);
    assert.match(sent.code, /^xfer-/); assert.match(sent.note, /works once/);
    const got = await call(f, B, 'psr_receive_file', { code: sent.code.toLowerCase() });
    assert.deepEqual([got.saved, got.size, got.sha256, got.parts, got.workingDirectory], [`psr-inbox/${sent.code}/report.md`, body.length, sha(body), undefined, '/srv/hft-queue']);
    assert.deepEqual(gpuDemo.files.get(`/srv/hft-queue/psr-inbox/${sent.code}/report.md`), body);
    await assert.rejects(call(f, B, 'psr_receive_file', { code: sent.code }), code('ALREADY_RECEIVED'));
    // the record says who sent and who took it, under which mission; never the code. The bytes are gone.
    const [rec] = f.router.listTransfers(owner).transfers as any[];
    assert.deepEqual([rec.state, rec.from.ref, rec.receivedBy.ref, rec.missionId, 'codeHash' in rec], ['received', lab.id, gpu.id, 'm-xfer', false]);
    assert.deepEqual(readdirSync(f.router.transfers.dir), []);
    assert.throws(() => f.router.listTransfers(principal('muse', { scopes: ['read', 'submit'] })), code('FORBIDDEN'));
});

test('files: a text file up to 1 MB reaches a Paseo session as it is; anything else as base64 parts its join command turns back into the bytes', async (t) => {
    const { f, A, B, labDemo, gpuDemo } = await setup(); t.after(f.close);
    const work = mkdtempSync(join(tmpdir(), 'psr-xfer-join-')); t.after(() => rmSync(work, { recursive: true, force: true }));
    const report = Buffer.from('# 報告\n成交 1,204 筆；細節見 fills.csv\r\n'), pack = randomBytes(2 * TRANSFER_B64_PART_BYTES + 12345), tiny = Buffer.from([0x50, 0x4b, 0, 3, 0xff, 0xfe]);
    const big = Buffer.from('x'.repeat(TRANSFER_TEXT_BYTES + 1)), latin = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    for (const [name, body] of [['report.md', report], ['pack.bin', pack], ['tiny.zip', tiny], ['big.log', big], ['latin1.txt', latin]] as const) labDemo.files.set(`/srv/backtests/${name}`, body);
    const take = async (name: string) => { const sent = await call(f, A, 'psr_send_file', { path: name }); return { code: sent.code, got: await call(f, B, 'psr_receive_file', { code: sent.code }) }; };
    const under = (code: string) => [...gpuDemo.files.keys()].filter(k => k.startsWith(`/srv/hft-queue/psr-inbox/${code}/`)).sort();
    // a report (valid UTF-8, CRLF kept) goes as it is, byte for byte
    const r = await take('report.md');
    assert.deepEqual([r.got.saved, r.got.join, under(r.code)], [`psr-inbox/${r.code}/report.md`, undefined, [`/srv/hft-queue/psr-inbox/${r.code}/report.md`]]);
    assert.deepEqual(gpuDemo.files.get(`/srv/hft-queue/psr-inbox/${r.code}/report.md`), report);
    // binary, a text file over 1 MB and text that is not UTF-8: base64 parts of at most 1,024,000 characters each
    for (const [name, body, count] of [['pack.bin', pack, 3], ['tiny.zip', tiny, 1], ['big.log', big, 2], ['latin1.txt', latin, 1]] as const) {
        const { code: xc, got } = await take(name), keys = under(xc);
        assert.deepEqual(keys, Array.from({ length: count }, (_, i) => `/srv/hft-queue/psr-inbox/${xc}/${name}.b64.part-00${i + 1}`), name);
        assert.ok(keys.every(k => gpuDemo.files.get(k)!.length <= 1_024_000 && /^[A-Za-z0-9+/=]*$/.test(gpuDemo.files.get(k)!.toString('latin1'))), name);
        assert.equal(got.parts, count); assert.match(got.check, new RegExp(sha(body)));
        assert.equal(got.join, `cat 'psr-inbox/${xc}/${name}.b64.part-'* | base64 -d > 'psr-inbox/${xc}/${name}' && rm 'psr-inbox/${xc}/${name}.b64.part-'*`);
        // the join command, run as the session would in its working directory, gives back the very bytes and leaves no parts
        for (const k of keys) { const rel = k.slice('/srv/hft-queue/'.length); mkdirSync(dirname(join(work, rel)), { recursive: true }); writeFileSync(join(work, rel), gpuDemo.files.get(k)!); }
        execFileSync('sh', ['-c', got.join], { cwd: work });
        assert.equal(sha(readFileSync(join(work, `psr-inbox/${xc}/${name}`))), sha(body), name);
        assert.deepEqual(readdirSync(join(work, `psr-inbox/${xc}`)), [name]);
    }
});

test('files: a receive that fails part way removes what it wrote, and the code works again into the same folder', async (t) => {
    const { f, A, B, labDemo, gpuDemo } = await setup(); t.after(f.close);
    const body = randomBytes(2 * TRANSFER_B64_PART_BYTES + 1);
    labDemo.files.set('/srv/backtests/pack.bin', body);
    const sent = await call(f, A, 'psr_send_file', { path: 'pack.bin' });
    gpuDemo.failWrite = '.b64.part-002';
    await assert.rejects(call(f, B, 'psr_receive_file', { code: sent.code }), code('FILE_UNWRITABLE'));
    assert.deepEqual([[...gpuDemo.files.keys()].filter(k => k.includes('psr-inbox')), [...gpuDemo.dirs].filter(d => d.includes('psr-inbox'))], [[], []]);
    assert.equal((f.router.listTransfers(owner).transfers as any[])[0].state, 'pending');
    gpuDemo.failWrite = null;
    const got = await call(f, B, 'psr_receive_file', { code: sent.code });
    assert.equal(got.saved, `psr-inbox/${sent.code}/pack.bin.b64.part-001 … part-003`);
    // a folder somebody else left with that name is kept: the file goes to <code>-2
    labDemo.files.set('/srv/backtests/r.md', Buffer.from('r'));
    const again = await call(f, A, 'psr_send_file', { path: 'r.md' });
    gpuDemo.files.set(`/srv/hft-queue/psr-inbox/${again.code}/r.md`, Buffer.from('theirs'));
    assert.equal((await call(f, B, 'psr_receive_file', { code: again.code })).saved, `psr-inbox/${again.code}-2/r.md`);
    assert.equal(gpuDemo.files.get(`/srv/hft-queue/psr-inbox/${again.code}/r.md`)!.toString(), 'theirs');
});

test('files: refusals — outside the working directory, credentials by name or content, missing files, unknown codes', async (t) => {
    const { f, A, B, labDemo } = await setup(); t.after(f.close);
    labDemo.files.set('/srv/backtests/.env', Buffer.from('X=1\n'));
    labDemo.files.set('/srv/backtests/ssh/id_ed25519', Buffer.from('k'));
    labDemo.files.set('/srv/backtests/notes.txt', Buffer.from('see\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n'));
    labDemo.files.set('/srv/backtests/ci.md', Buffer.from(`deploy with\nGITHUB_TOKEN=ghp_${'a'.repeat(36)}\n`));
    labDemo.files.set('/srv/backtests/.env.example', Buffer.from('API_KEY=\n'));
    for (const path of ['../etc/passwd', '/etc/passwd', '/srv/backtests']) await assert.rejects(call(f, A, 'psr_send_file', { path }), code('INVALID_ARGUMENT'), path);
    for (const path of ['.env', 'ssh/id_ed25519', 'notes.txt', 'ci.md']) await assert.rejects(call(f, A, 'psr_send_file', { path }), code('SECRET_REFUSED'), path);
    await assert.rejects(call(f, A, 'psr_send_file', { path: 'missing.csv' }), code('FILE_UNREADABLE'));
    assert.match((await call(f, A, 'psr_send_file', { path: '.env.example' })).code, /^xfer-/);
    await assert.rejects(call(f, B, 'psr_receive_file', { code: 'not-a-code' }), code('INVALID_ARGUMENT'));
    await assert.rejects(call(f, B, 'psr_receive_file', { code: newCode() }), code('NOT_FOUND'));
    // nothing of a refused file stays on the Router
    assert.equal(readdirSync(f.router.transfers.dir).length, 1);
});

test('files: who may — only during a Router turn, only sessions created with the tools, on an owner-only host only while asking first', async (t) => {
    const { f, lab, A, labDemo } = await setup(); t.after(f.close);
    labDemo.files.set('/srv/backtests/r.md', Buffer.from('r'));
    assert.ok(visibleTools(A).some(x => x.name === 'psr_send_file'));
    for (const p of [owner, principal('muse', { scopes: ['read', 'submit', 'create'] })]) assert.ok(!visibleTools(p).some(x => x.name === 'psr_send_file' || x.name === 'psr_receive_file'));
    f.config.hosts.find(h => h.id === 'lab3')!.humanApproval = true;
    await assert.rejects(call(f, A, 'psr_send_file', { path: 'r.md' }), code('TRANSFER_DENIED'));
    labDemo.sessions.get(lab.nativeId)!.modeId = 'default'; await f.router.syncDirectory();
    assert.match((await call(f, A, 'psr_send_file', { path: 'r.md' })).code, /^xfer-/);
    labDemo.finish(lab.nativeId, 'done'); await f.router.tick();
    await assert.rejects(call(f, A, 'psr_send_file', { path: 'r.md' }), code('NO_ACTIVE_TASK'));
    // a session created before the file tools: its creation record lists none, so it has no transfer scope
    const row = f.store.rows<{ sessionRef?: string; tools?: string[] }>('creation').find(r => r.data.sessionRef === lab.id)!;
    f.store.put('creation', row.id, { ...row.data, tools: row.data.tools!.filter(x => !x.endsWith('_file')) }, row.projectId, row.hostId);
    const older = f.router.agentPrincipal(token(f, lab.nativeId));
    assert.ok(!older.scopes.includes('transfer') && !visibleTools(older).some(x => x.name === 'psr_send_file'));
    await assert.rejects(execute(f.router, older, 'psr_send_file', { path: 'r.md' }), code('FORBIDDEN'));
});

test('files: a code expires after 60 minutes and its bytes go; one receiver at a time; a broken take leaves the code working', async (t) => {
    const { f, A, labDemo } = await setup(); t.after(f.close);
    labDemo.files.set('/srv/backtests/a.md', Buffer.from('a')); labDemo.files.set('/srv/backtests/b.md', Buffer.from('b'));
    const a = await call(f, A, 'psr_send_file', { path: 'a.md' }), b = await call(f, A, 'psr_send_file', { path: 'b.md' });
    const held = f.router.openTransfer(owner, b.code);
    assert.throws(() => f.router.openTransfer(owner, b.code), code('TRANSFER_BUSY'));
    f.router.releaseTransfer(held.transfer);
    const again = f.router.openTransfer(owner, b.code);
    f.router.receivedTransfer(again.transfer, again.by);
    f.advance(61 * 60000); f.router.gc();
    assert.throws(() => f.router.openTransfer(owner, a.code), code('EXPIRED'));
    assert.deepEqual((f.router.listTransfers(owner).transfers as any[]).map(x => [x.name, x.state]).sort(), [['a.md', 'expired'], ['b.md', 'received']]);
    assert.deepEqual(readdirSync(f.router.transfers.dir), []);
    f.advance(86400000 + 60000); f.router.gc();
    assert.deepEqual(f.router.listTransfers(owner).transfers, []);
    assert.throws(() => f.router.openTransfer(owner, a.code), code('NOT_FOUND'));
});

test('files: archives are checked entry by entry (names and contents), packed by tar with or without gzip', async (t) => {
    const work = mkdtempSync(join(tmpdir(), 'psr-xfer-tar-')); t.after(() => rmSync(work, { recursive: true, force: true }));
    const pack = (name: string, files: Record<string, string>, z = true) => {
        const dir = join(work, name); for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text); }
        const out = join(work, `${name}.${z ? 'tgz' : 'tar'}`); execFileSync('tar', [z ? 'czf' : 'cf', out, '-C', work, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } }); return out;
    };
    const check = (file: string) => tarRefusal(file.endsWith('.tgz') ? createReadStream(file).pipe(createGunzip()) : createReadStream(file));
    assert.equal(await check(pack('clean', { 'a.md': '# A', 'deep/b.csv': 'x,y\n1,2\n', [`${'long-'.repeat(30)}name.txt`]: 'long names too' })), null);
    assert.equal(await check(pack('plain', { 'a.md': '# A' }, false)), null);
    assert.match((await check(pack('named', { 'app/.env': 'X=1' })))!, /\.env/);
    assert.match((await check(pack('inner', { 'notes.txt': `token sk-${'x'.repeat(30)}` })))!, /API key .* in inner\/notes\.txt \(in the archive\)/);
});

/** A Router on HTTP and a machine credential for lab3 in a psr-local config folder, plus psr-xfer's functions. */
async function overHttp(t: { after: (fn: () => unknown) => void }) {
    const f = await fixture(); t.after(f.close);
    for (const c of f.config.clients) process.env[c.tokenEnv] = randomBytes(32).toString('hex');
    const http = await startHttp(f.router, { port: 0 }); t.after(http.close);
    const home = mkdtempSync(join(tmpdir(), 'psr-xfer-home-')), work = mkdtempSync(join(tmpdir(), 'psr-xfer-work-'));
    t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
    const issued = f.router.issueLocalCredential(owner, { hostId: 'lab3' });
    writeFileSync(join(home, 'local.json'), JSON.stringify({ url: http.baseUrl })); writeFileSync(join(home, 'local.token'), `${issued.token}\n`);
    const xfer = await import(pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../integrations/local/psr-xfer.mjs')).href);
    return { f, http, home, work, issued, xfer, conf: xfer.machine(home) };
}

test('psr-xfer: a machine sends a file and a folder (.tgz) over HTTP; another receives each once, checked by sha256', async (t) => {
    const { f, work, xfer, conf } = await overHttp(t);
    const out = join(work, 'out'), report = Buffer.from('# Report\nall fills reconciled\n');
    mkdirSync(join(work, 'pack/sub'), { recursive: true }); writeFileSync(join(work, 'report.md'), report);
    writeFileSync(join(work, 'pack/a.txt'), 'A'); writeFileSync(join(work, 'pack/sub/b.csv'), 'x,y\n');
    const sent = await xfer.send(conf, join(work, 'report.md'));
    assert.deepEqual([sent.name, sent.size, sent.sha256], ['report.md', report.length, sha(report)]);
    const got = await xfer.receive(conf, sent.code, out);
    assert.deepEqual([got.saved, readFileSync(got.saved), got.from], [join(out, 'report.md'), report, 'lab3 (psr-xfer)']);
    await assert.rejects(xfer.receive(conf, sent.code, join(work, 'again')), (e: any) => e.code === 'ALREADY_RECEIVED');
    const packed = await xfer.send(conf, join(work, 'pack'));
    assert.equal(packed.name, 'pack.tgz'); assert.match(packed.packed, /pack\/ was packed as pack\.tgz/);
    const box = join(work, 'box'), tgz = await xfer.receive(conf, packed.code, box, { inbox: true });
    assert.equal(tgz.saved, join(box, packed.code, 'pack.tgz'));
    execFileSync('tar', ['xzf', tgz.saved, '-C', join(box, packed.code)]);
    assert.deepEqual([readFileSync(join(box, packed.code, 'pack/a.txt'), 'utf8'), readFileSync(join(box, packed.code, 'pack/sub/b.csv'), 'utf8')], ['A', 'x,y\n']);
    const rec = (f.router.listTransfers(owner).transfers as any[]).find(x => x.name === 'pack.tgz');
    assert.deepEqual([rec.from.kind, rec.from.hostId, rec.receivedBy.kind], ['machine', 'lab3', 'machine']);
});

test('psr-xfer: refusals over HTTP — a folder with a credential, too big, no credential; an existing file is never replaced', async (t) => {
    const { f, http, work, xfer, conf } = await overHttp(t);
    mkdirSync(join(work, 'leaky/app'), { recursive: true }); writeFileSync(join(work, 'leaky/app/.env'), 'DB_PASSWORD=hunter2hunter2\n');
    await assert.rejects(xfer.send(conf, join(work, 'leaky')), (e: any) => e.code === 'SECRET_REFUSED' && /\.env/.test(e.message));
    // a file announced bigger than 100 MB is refused before any byte of it is read
    const big = await new Promise<{ status: number; body: any }>((ok, fail) => {
        const req = rawRequest(`${http.baseUrl}/v1/transfers?name=x.bin`, { method: 'POST', headers: { ...conf.headers, 'content-type': 'application/octet-stream', 'content-length': String(TRANSFER_MAX_BYTES + 1) } }, res => { let text = ''; res.on('data', c => text += c); res.on('end', () => { ok({ status: res.statusCode!, body: JSON.parse(text) }); req.destroy(); }); });
        req.on('error', e => { if (!(e as NodeJS.ErrnoException).code?.startsWith('ECONN')) fail(e); });
        req.write('x');
    });
    assert.deepEqual([big.status, big.body.code], [413, 'TOO_LARGE']);
    assert.equal((await fetch(`${http.baseUrl}/v1/transfers/${newCode()}`)).status, 401);
    assert.deepEqual(readdirSync(f.router.transfers.dir), []);
    writeFileSync(join(work, 'r.md'), 'new');
    const sent = await xfer.send(conf, join(work, 'r.md'));
    await assert.rejects(xfer.receive(conf, sent.code, work), (e: any) => e.code === 'FILE_EXISTS');
    assert.equal(readFileSync(join(work, 'r.md'), 'utf8'), 'new');
    // the receiver gave it back: the code works again at once
    const got = await xfer.receive(conf, sent.code, join(work, 'elsewhere'));
    assert.equal(readFileSync(got.saved, 'utf8'), 'new');
    // downloaded but never confirmed: nobody else takes it meanwhile, and after 10 minutes the code works again
    writeFileSync(join(work, 's.md'), 'slow');
    const slow = await xfer.send(conf, join(work, 's.md')), url = `${http.baseUrl}/v1/transfers/${slow.code}`;
    const first = await fetch(url, { headers: conf.headers });
    assert.deepEqual([first.status, await first.text()], [200, 'slow']);
    const busy = await fetch(url, { headers: conf.headers });
    assert.deepEqual([busy.status, (await busy.json()).code], [409, 'TRANSFER_BUSY']);
    f.advance(11 * 60000);
    const later = await xfer.receive(conf, slow.code, join(work, 'later'));
    assert.equal(readFileSync(later.saved, 'utf8'), 'slow');
    assert.equal((await fetch(url, { headers: conf.headers })).status, 410);
});

test('psr-local bridge: psr_local_send_file and psr_local_receive_file move files of the session\'s project, named after the session', async (t) => {
    const { f, home, work, issued } = await overHttp(t);
    const project = join(work, 'project'); mkdirSync(join(project, 'docs'), { recursive: true }); writeFileSync(join(project, 'docs/plan.md'), '# Plan\n');
    writeFileSync(join(work, 'outside.txt'), 'not yours'); symlinkSync(join(work, 'outside.txt'), join(project, 'link.txt'));
    const { CLAUDE_CODE_MESSAGING_SOCKET: _s, CLAUDE_CODE_MESSAGING_TOKEN: _t, CODEX_HOME: _c, CLAUDE_CONFIG_DIR: _d, ...env } = process.env;
    const child = spawn(process.execPath, [resolve(dirname(fileURLToPath(import.meta.url)), '../../integrations/local/psr-local.mjs')], { cwd: project, env: { ...env, PSR_LOCAL_DIR: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { child.kill('SIGKILL'); });
    const waiting = new Map<number, (m: any) => void>(); let n = 0;
    createInterface({ input: child.stdout! }).on('line', l => { let m: any; try { m = JSON.parse(l); } catch { return; } if (typeof m.id === 'number') waiting.get(m.id)?.(m); });
    const rpc = (method: string, params: unknown = {}) => new Promise<any>(ok => { const id = ++n; waiting.set(id, ok); child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code', version: '2.1.316' }, capabilities: {} });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tool = async (name: string, args: unknown) => { const r = await rpc('tools/call', { name, arguments: args }); return { error: r.result.isError, body: JSON.parse(r.result.content[0].text) }; };
    const sent = await tool('psr_local_send_file', { path: 'docs/plan.md' });
    assert.equal(sent.error, false, JSON.stringify(sent.body)); assert.equal(sent.body.name, 'plan.md');
    // outside the project, by a path or through a symlink inside it
    for (const path of ['../outside.txt', 'link.txt']) assert.equal((await tool('psr_local_send_file', { path })).body.code, 'NOT_IN_PROJECT', path);
    assert.equal((await tool('psr_local_send_file', { path: 'docs/missing.md' })).body.code, 'NOT_FOUND');
    const got = await tool('psr_local_receive_file', { code: sent.body.code });
    assert.equal(got.error, false, JSON.stringify(got.body));
    assert.equal(got.body.saved, join(realpathSync(project), 'psr-inbox', sent.body.code, 'plan.md'));
    assert.equal(readFileSync(got.body.saved, 'utf8'), '# Plan\n');
    const rec = (f.router.listTransfers(owner).transfers as any[])[0];
    assert.deepEqual([rec.from.kind, rec.from.hostId, rec.receivedBy.kind], ['local', 'lab3', 'local']);
    assert.match(rec.from.name, /^claude @ project #/);
    assert.ok(issued.credentialId);
});
