import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, principal, code } from './helpers.js';
import { execute } from '../src/tools.js';
import { parseProviderDiagnostic } from '../src/paseo-adapter.js';
import { providerStopNotice, LOGIN_PROVIDERS } from '../src/core.js';

const DAY = 86400000;
const muse = principal('muse', { scopes: ['read', 'submit', 'cancel'] });
// Paseo 0.15's provider diagnostic, as a Linux server printed it (account fields replaced).
const CLAUDE_REPORT = `Claude Code
  Command source: default
  Configured command: claude
  Daemon PATH: /home/ubuntu/.local/bin:/usr/bin:/bin
  Daemon shell: /bin/bash
  PATH matches: /home/ubuntu/.local/bin/claude
    /usr/local/bin/claude
  which -a claude: /home/ubuntu/.local/bin/claude
  bash -lc type -a claude: claude is /home/ubuntu/.local/bin/claude
  Binary: claude
  Resolved path: /home/ubuntu/.local/bin/claude
  Version: 2.1.318 (Claude Code)
  Auth: {
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "configDirectory": "/home/ubuntu/.claude",
  "loginExpiresAt": "2026-12-03T12:26:18.174Z",
  "email": "someone@example.com",
  "orgId": "00000000-0000-0000-0000-000000000000",
  "orgName": "someone@example.com's Organization",
  "subscriptionType": "max"
}
  Models: 19
  Status: Ready`;
const CODEX_REPORT = `Codex
  Command source: default
  Configured command: codex
  Binary: codex
  Resolved path: /home/ubuntu/.local/bin/codex
  Version: codex-cli 0.167.0
  Models: 9
  Status: Ready`;

test('logins: the diagnostic parser keeps the login fields only, never the account or paths', () => {
    const c = parseProviderDiagnostic(CLAUDE_REPORT);
    assert.deepEqual(c, { loggedIn: true, method: 'claude.ai', plan: 'max', expiresAt: Date.parse('2026-12-03T12:26:18.174Z'), version: '2.1.318 (Claude Code)', status: 'Ready' });
    assert.doesNotMatch(JSON.stringify(c), /@|ubuntu|0000-0000/);
    assert.deepEqual(parseProviderDiagnostic(CODEX_REPORT), { loggedIn: null, method: null, plan: null, expiresAt: null, version: 'codex-cli 0.167.0', status: 'Ready' });
    assert.equal(parseProviderDiagnostic('Claude Code\n  Version: 2.1.1\n  Auth: Not logged in · Please run /login\n  Status: Ready').loggedIn, false);
    assert.deepEqual(parseProviderDiagnostic('garbage'), { loggedIn: null, method: null, plan: null, expiresAt: null, version: null, status: null });
});

test('logins: only the owner checks; each online daemon is asked for Claude and Codex; states are read against now', async (t) => {
    const f = await fixture(); t.after(f.close);
    const gpu = f.demos.get('gpu-research')!, dev = f.demos.get('dev-app')!, lab = f.demos.get('lab-test')!, review = f.demos.get('gpu-review')!;
    gpu.logins.set('claude', { loggedIn: true, method: 'claude.ai', plan: 'max', expiresAt: f.now() + 30 * DAY, version: '2.1.318', status: 'Ready' });
    gpu.logins.set('codex', { loggedIn: null, method: null, plan: null, expiresAt: null, version: 'codex-cli 0.167.0', status: 'Ready' });
    dev.logins.set('claude', { loggedIn: true, method: 'claude.ai', plan: 'max', expiresAt: f.now() + 2 * DAY, version: '2.1.318', status: 'Ready' });
    lab.logins.set('claude', new Error('diagnostic timed out'));
    lab.logins.set('codex', { loggedIn: false, method: null, plan: null, expiresAt: null, version: 'codex-cli 0.167.0', status: 'Ready' });
    review.online = false; await f.router.syncDirectory();
    const login = (host: string, daemon: string, provider: string) => f.router.listHosts(muse).hosts.find(h => h.id === host)!.logins.find(l => l.daemonId === daemon && l.provider === provider)!;
    assert.equal(login('gpu1', 'gpu-research', 'claude').state, 'unchecked');
    await assert.rejects(() => execute(f.router, muse, 'psr_check_logins', {}), code('FORBIDDEN'));
    await assert.rejects(() => f.router.checkLogins(principal(), { hostId: 'nowhere' }), code('NOT_FOUND'));
    assert.equal(gpu.loginChecks.length, 0);

    const r = await execute(f.router, principal(), 'psr_check_logins', {}) as { checked: number; hosts: { hostId: string; logins: { state: string }[] }[] };
    assert.equal(r.checked, 3, 'the offline daemon is not asked');
    assert.deepEqual(gpu.loginChecks, [...LOGIN_PROVIDERS]); assert.deepEqual(review.loginChecks, []);
    const a = login('gpu1', 'gpu-research', 'claude');
    assert.deepEqual([a.state, a.method, a.plan, a.expiresAt, a.checkedAt], ['ok', 'claude.ai', 'max', f.now() + 30 * DAY, f.now()]);
    assert.equal(login('gpu1', 'gpu-research', 'codex').state, 'unverified');
    assert.equal(login('dev2', 'dev-app', 'claude').state, 'expiring');
    assert.deepEqual([login('lab3', 'lab-test', 'claude').state, login('lab3', 'lab-test', 'claude').error], ['unknown', 'diagnostic timed out']);
    assert.equal(login('lab3', 'lab-test', 'codex').state, 'logged_out');
    assert.equal(login('gpu1', 'gpu-review', 'claude').state, 'unchecked');
    // read against now: the same check reads as expiring, then expired, as time passes
    f.advance(25 * DAY); assert.equal(login('gpu1', 'gpu-research', 'claude').state, 'expiring');
    f.advance(6 * DAY); assert.equal(login('gpu1', 'gpu-research', 'claude').state, 'expired');
    // one host only
    await f.router.checkLogins(principal(), { hostId: 'dev2' });
    assert.deepEqual(gpu.loginChecks, [...LOGIN_PROVIDERS]); assert.equal(dev.loginChecks.length, 4);
});

test('logins: a turn whose only reply is a login error fails, marks the login failed, and a check that finds it working clears it', async (t) => {
    const f = await fixture(); t.after(f.close);
    const gpu = f.demos.get('gpu-research')!, s = f.session('gpu-research', 'agent-2');
    assert.match(s.provider, /^claude\//);
    gpu.logins.set('claude', { loggedIn: true, method: 'claude.ai', plan: 'max', expiresAt: f.now() + 30 * DAY, version: '2.1.318', status: 'Ready' });
    await f.router.checkLogins(principal(), {});
    f.advance(1000);
    const first = f.submit('check', muse, s.id); await f.router.tick();
    gpu.finish('agent-2', 'Failed to authenticate: OAuth session expired and could not be refreshed'); await f.router.tick();
    const ft = f.store.task(first.id)!;
    assert.equal(ft.state, 'failed'); assert.match(ft.completionEvidence!, /a login error; no work was done/);
    assert.equal(f.router.getSession(muse, s.id).providerLimit!.kind, 'login');
    const claude = () => f.router.listHosts(muse).hosts.find(h => h.id === 'gpu1')!.logins.find(l => l.daemonId === 'gpu-research' && l.provider === 'claude')!;
    assert.equal(claude().state, 'failed'); assert.match(claude().lastFailure!.notice, /OAuth session expired/);
    await f.router.tick();
    const next = await execute(f.router, muse, 'psr_submit_task', { routeTicket: f.ticket(muse, s.id), prompt: 'again', idempotencyKey: 'login-002' }) as { warning?: string };
    assert.match(next.warning!, /登入失效/);
    // the owner logs in again on that machine and checks: the notice goes, and dispatch carries no warning
    f.advance(1000); await f.router.checkLogins(principal(), { hostId: 'gpu1' });
    assert.equal(claude().state, 'ok'); assert.equal(f.router.getSession(muse, s.id).providerLimit, null);
    await f.router.tick(); gpu.finish('agent-2', 'all good'); await f.router.tick();
    assert.equal(f.store.task((next as unknown as { id: string }).id)!.state, 'completed');
});

test('logins: every wording Claude Code uses for a login that stopped working is a stop notice', () => {
    for (const text of ['Failed to authenticate: OAuth session expired and could not be refreshed', 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate', 'Failed to authenticate: this login reached its time limit and cannot be renewed.', 'Not logged in · Please run /login'])
        assert.equal(providerStopNotice([{ start: 1, end: 1, text }]), text);
    assert.equal(providerStopNotice([{ start: 1, end: 1, text: 'I tried, but the exchange said: failed to authenticate the API key; I rotated it and the job passes now.' }]), null);
});
