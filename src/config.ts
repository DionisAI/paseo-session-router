import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RouterConfig, ClientConfig, EntryKind } from './types.js';
import { checkWeatherPlace } from './weather.js';
import { assert, strictObject } from './util.js';
import { checkableCheckout } from './arbiter.js';
export const limits: RouterConfig['limits'] = { activeTasks: 64, receipts: 200, receiptMs: 7 * 86400000, outbox: 10000, outboxMs: 86400000, sessions: 2000, handoffDepth: 3, handoffTasks: 16, ticketMs: 300000, freshnessMs: 15000 };
/** Provider modes in which an agent asks before acting; seats must use one, so every action passes the Router. */
export const SEAT_MODES = ['default', 'plan'];
/** Modes in which a session's permission requests go to a person, by provider (the part of the provider before any /). Claude
 * default and plan ask before every action that is not read-only. Codex auto and read-only send their approvals to the user
 * (auto runs commands without asking only inside its workspace sandbox, with no network). Not: Claude auto (a classifier
 * approves), acceptEdits, bypassPermissions; Codex auto-review (a reviewer subagent approves), full-access (never asks); any
 * other provider; an unknown mode. On an owner-only host that person is the owner. */
export const OWNER_APPROVAL_MODES: Readonly<Record<string, readonly string[]>> = { claude: ['default', 'plan'], codex: ['auto', 'read-only'] };
export const approvalsGoToPerson = (provider: string, modeId: string | null | undefined) => !!modeId && (OWNER_APPROVAL_MODES[provider.split('/')[0]] ?? []).includes(modeId);
export function demoConfig(dataDir: string): RouterConfig { const entries: EntryKind[] = ['web', 'grokbot', 'dot', 'muse', 'cli']; return { mode: 'demo', listen: '127.0.0.1', port: 8787, dataDir: resolve(dataDir), allowedOrigins: [], hosts: [{ id: 'gpu1', label: 'GPU · Research' }, { id: 'dev2', label: 'Dev · Applications' }, { id: 'lab3', label: 'Lab · Validation' }], daemons: [{ id: 'gpu-research', hostId: 'gpu1', label: 'research', incarnation: 'demo-v1', adapter: 'demo', mappings: [{ cwd: '/srv/hft', projectId: 'hft', workspaceId: 'hft-main', mutationDomainId: 'hft-shared', releasePolicy: 'on_turn_end', workerId: 'eth-mm' }, { cwd: '/srv/hft-queue', projectId: 'hft', workspaceId: 'hft-queue', mutationDomainId: 'queue-isolated', releasePolicy: 'on_turn_end', workerId: 'queue-model' }] }, { id: 'gpu-review', hostId: 'gpu1', label: 'review-account', incarnation: 'demo-v1', adapter: 'demo', mappings: [{ cwd: '/srv/hft', projectId: 'hft', workspaceId: 'hft-main', mutationDomainId: 'hft-shared', releasePolicy: 'on_turn_end', workerId: 'eth-mm' }] }, { id: 'dev-app', hostId: 'dev2', label: 'development', incarnation: 'demo-v1', adapter: 'demo', mappings: [{ cwd: '/srv/router', projectId: 'router', workspaceId: 'router-web', mutationDomainId: 'router-dev', releasePolicy: 'on_turn_end', workerId: 'frontend' }] }, { id: 'lab-test', hostId: 'lab3', label: 'validation', incarnation: 'demo-v1', adapter: 'demo', mappings: [{ cwd: '/srv/backtests', projectId: 'hft', workspaceId: 'backtest-lab', mutationDomainId: 'lab-backtest', releasePolicy: 'on_turn_end', workerId: 'backtest' }] }], workers: [{ id: 'eth-mm', projectId: 'hft', alias: 'eth-mm', role: 'Maker fill and adverse selection research', mode: 'managed' }, { id: 'queue-model', projectId: 'hft', alias: 'queue-model', role: 'Queue model validation', mode: 'managed' }, { id: 'backtest', projectId: 'hft', alias: 'backtest', role: 'Independent backtests', mode: 'managed' }, { id: 'frontend', projectId: 'router', alias: 'frontend', role: 'Router console development', mode: 'managed' }], clients: entries.map(kind => ({ principalId: 'owner', clientId: kind, entryKind: kind, scopes: ['read', 'submit', 'cancel', 'bind', 'handoff', 'create', 'frontier', 'admin'], projects: ['*'], hosts: ['*'], authorizationRevision: 1, tokenEnv: `PSR_${kind.toUpperCase()}_TOKEN` })), templates: [{ id: 'lab-codex', daemonId: 'lab-test', cwd: '/srv/backtests', provider: 'codex/demo', title: 'Backtest companion', workerId: 'backtest' }], tickMs: 500, limits: { ...limits } }; }
export function loadConfig(path: string): RouterConfig { const raw = JSON.parse(readFileSync(path, 'utf8')); const c = { ...raw, limits: { ...limits, ...raw.limits } } as RouterConfig; validateConfig(c); c.dataDir = resolve(c.dataDir); return c; }
/** Where a session reaches the Router's MCP endpoint: https, or http only on loopback (a tunnel), without credentials. */
const mcpUrl = (v: string) => { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && u.pathname.endsWith('/mcp') && !u.username && !u.password && (u.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)); };
/** 127.0.0.0/8, ::1 and localhost: only this machine reaches the Router. */
export const isLoopback = (address: string) => address === 'localhost' || address === '::1' || address === '[::1]' || /^127(\.\d{1,3}){3}$/.test(address);
export function validateConfig(c: RouterConfig) {
    assert(c.mode === 'live' || c.mode === 'demo', 'CONFIG', 'Invalid mode');
    assert(typeof c.listen === 'string' && Number.isInteger(c.port) && c.port >= 0 && c.port <= 65535, 'CONFIG', 'Invalid listen address/port');
    assert(c.listenBeyondLoopback === undefined || typeof c.listenBeyondLoopback === 'boolean', 'CONFIG', 'listenBeyondLoopback must be true or false');
    const weatherProblem = checkWeatherPlace(c.weather);
    assert(!weatherProblem, 'CONFIG', weatherProblem ?? '');
    assert(isLoopback(c.listen) || c.listenBeyondLoopback === true, 'CONFIG', `listen ${c.listen} is not a loopback address: set "listenBeyondLoopback": true to mean it, and keep the Router behind a VPN, a tailnet or an authenticating proxy (see SECURITY.md)`);
    assert(typeof c.dataDir === 'string' && c.dataDir.length > 0, 'CONFIG', 'dataDir required');
    for (const key of ['hosts', 'daemons', 'workers', 'clients', 'templates', 'allowedOrigins'] as const)
        assert(Array.isArray(c[key]), 'CONFIG', `${key} must be an array`);
    assert(c.hosts.length <= 128 && c.daemons.length <= 256 && c.clients.length <= 64 && c.workers.length <= 1024, 'CONFIG', 'Configuration quota exceeded');
    const unique = (items: {
        id: string;
    }[], label: string) => { const ids = new Set<string>(); for (const v of items) {
        assert(typeof v.id === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(v.id) && !ids.has(v.id), 'CONFIG', `Invalid/duplicate ${label} id`);
        ids.add(v.id);
    } };
    unique(c.hosts, 'host');
    const text = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max);
    const list = (v: unknown, items: number, max: number) => v === undefined || (Array.isArray(v) && v.length <= items && v.every(x => typeof x === 'string' && x.length <= max));
    for (const h of c.hosts)
        assert(typeof h.label === 'string' && text(h.description, 1000) && list(h.tags, 12, 40) && list(h.rules, 12, 300), 'CONFIG', 'Host label required; description ≤1000 chars, ≤12 tags ≤40 chars, ≤12 rules ≤300 chars');
    for (const h of c.hosts)
        assert(h.humanApproval === undefined || typeof h.humanApproval === 'boolean', 'CONFIG', 'Host humanApproval must be true or false');
    unique(c.daemons, 'daemon');
    unique(c.workers, 'worker');
    unique(c.templates, 'template');
    for (const d of c.daemons) {
        assert(c.hosts.some(h => h.id === d.hostId), 'CONFIG', 'Unknown daemon host');
        assert(typeof d.incarnation === 'string' && d.incarnation.length > 0, 'CONFIG', 'Explicit daemon incarnation required');
        assert(Array.isArray(d.mappings), 'CONFIG', 'mappings required');
        assert(d.adapter === 'demo' || d.adapter === 'paseo', 'CONFIG', 'Invalid adapter');
        assert(c.mode !== 'live' || d.adapter === 'paseo', 'CONFIG', 'Live configurations cannot contain simulated daemons');
        if (d.adapter === 'paseo' && d.pairingEnv) {
            assert(!d.url, 'CONFIG', 'A Paseo daemon uses either url (direct or SSH tunnel) or pairingEnv (Paseo relay), not both');
            assert(/^[A-Z_][A-Z0-9_]{0,63}$/.test(d.pairingEnv), 'CONFIG', 'pairingEnv must name an environment variable holding the pairing link');
        }
        else if (d.adapter === 'paseo') {
            assert(typeof d.url === 'string', 'CONFIG', 'A Paseo daemon needs url (direct or SSH tunnel) or pairingEnv (Paseo relay)');
            const u = new URL(d.url!);
            assert(['ws:', 'wss:'].includes(u.protocol) && !u.username && !u.password && u.pathname.endsWith('/ws'), 'CONFIG', 'Use a WebSocket endpoint ending /ws without embedded credentials');
            if (u.protocol === 'ws:')
                assert(['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname), 'CONFIG', 'Unencrypted WebSocket only allowed over a local trusted tunnel');
        }
        for (const m of d.mappings) {
            assert(m.cwd.startsWith('/') && m.mutationDomainId && m.projectId && m.workspaceId, 'CONFIG', 'Exact absolute cwd and explicit domain/project/workspace required');
            assert(['manual', 'on_turn_end'].includes(m.releasePolicy), 'CONFIG', 'releasePolicy required');
            assert(m.externalTurns === undefined || ['pause', 'wait'].includes(m.externalTurns), 'CONFIG', 'externalTurns must be pause or wait');
            assert(!m.mutationDomainId.startsWith('auto:'), 'CONFIG', 'The auto: mutation domain prefix is reserved for autoMap');
            if (m.workerId)
                assert(c.workers.some(w => w.id === m.workerId && w.projectId === m.projectId), 'CONFIG', 'Mapping worker/project mismatch');
        }
        if (d.autoMap)
            assert(typeof d.autoMap.projectId === 'string' && d.autoMap.projectId.length > 0 && ['manual', 'on_turn_end'].includes(d.autoMap.releasePolicy) && (d.autoMap.externalTurns === undefined || ['pause', 'wait'].includes(d.autoMap.externalTurns)), 'CONFIG', 'autoMap needs projectId, releasePolicy and an optional externalTurns of pause or wait');
        if (d.agentChannel) {
            const mode = d.agentChannel.mode ?? (d.agentChannel.url ? 'http' : 'observed');
            assert(mode === 'http' || mode === 'observed', 'CONFIG', 'agentChannel.mode must be observed or http');
            if (mode === 'http') {
                assert(typeof d.agentChannel.url === 'string', 'CONFIG', 'An http agentChannel needs url');
                assert(mcpUrl(d.agentChannel.url!), 'CONFIG', 'agentChannel.url must be an /mcp URL: https, or http only on loopback (a tunnel)');
            }
            assert(d.agentChannel.nodeCommand === undefined || (typeof d.agentChannel.nodeCommand === 'string' && d.agentChannel.nodeCommand.length > 0 && d.agentChannel.nodeCommand.length <= 1024), 'CONFIG', 'agentChannel.nodeCommand must be an executable name or path');
            assert(d.agentChannel.tokenTtlMs === undefined || (Number.isInteger(d.agentChannel.tokenTtlMs) && d.agentChannel.tokenTtlMs >= 60000 && d.agentChannel.tokenTtlMs <= 365 * 86400000), 'CONFIG', 'agentChannel.tokenTtlMs must be 60000..31536000000');
        }
        if (d.identityProbe)
            assert(d.identityProbe.command && Array.isArray(d.identityProbe.args) && d.identityProbe.expectedValue && (d.identityProbe.cacheMs === undefined || (Number.isInteger(d.identityProbe.cacheMs) && d.identityProbe.cacheMs >= 0 && d.identityProbe.cacheMs <= 3600000)), 'CONFIG', 'Invalid identity probe');
    }
    const aliases = new Set<string>();
    for (const w of c.workers) {
        assert(typeof w.projectId === 'string' && w.projectId.length > 0 && typeof w.alias === 'string' && w.alias.length > 0, 'CONFIG', 'Worker project/alias required');
        const k = w.projectId + '\0' + w.alias;
        assert(!aliases.has(k), 'CONFIG', 'Worker alias must be unique within a project');
        aliases.add(k);
        assert(['managed', 'paused', 'observe_only'].includes(w.mode), 'CONFIG', 'Invalid worker dispatch mode');
    }
    for (const d of c.daemons) {
        assert(new Set(d.mappings.map(m => m.cwd)).size === d.mappings.length, 'CONFIG', 'One cwd must not have multiple conflicting mappings in a daemon');
    }
    for (const t of c.templates) {
        const d = c.daemons.find(d => d.id === t.daemonId);
        assert(d?.mappings.some(m => m.cwd === t.cwd), 'CONFIG', 'Creation template must use a configured daemon and exact checkout');
        assert(typeof t.provider === 'string' && /^[a-z][a-z0-9-]*\/\S+$/.test(t.provider), 'CONFIG', 'Creation template provider must be "provider/model", for example claude/claude-sonnet-5-5');
        assert(text(t.description, 1000), 'CONFIG', 'Template description must be ≤1000 chars');
        assert(t.modeId === undefined || (typeof t.modeId === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,39}$/.test(t.modeId)), 'CONFIG', 'Template modeId must be a provider mode id such as default or plan');
        assert(t.seat === undefined || typeof t.seat === 'boolean', 'CONFIG', 'Template seat must be true or false');
        if (t.seat) {
            // A seat is the Router's own: its mode asks before acting (so the Router can answer in code), its checkout and
            // mutation domain belong to it alone, and it reports back through an agent channel.
            const m = d!.mappings.find(m => m.cwd === t.cwd)!;
            assert(SEAT_MODES.includes(t.modeId ?? ''), 'CONFIG', `Seat template ${t.id}: modeId must be one that asks before acting (${SEAT_MODES.join(' or ')})`);
            assert(m.releasePolicy === 'on_turn_end' && !m.workerId, 'CONFIG', `Seat template ${t.id}: its mapping needs releasePolicy on_turn_end and no workerId`);
            assert(c.daemons.every(x => x.mappings.every(o => o === m || o.mutationDomainId !== m.mutationDomainId)) && c.templates.every(o => o === t || o.daemonId !== t.daemonId || o.cwd !== t.cwd), 'CONFIG', `Seat template ${t.id}: its checkout and mutation domain must be used by no other mapping or template`);
            assert(!!d!.agentChannel, 'CONFIG', `Seat template ${t.id}: its daemon needs an agentChannel so the seat can report back`);
            // a seat reads its own directory by bare names and path-less calls (grep -r x): that must not be a whole home
            assert(!!checkableCheckout(t.cwd), 'CONFIG', `Seat template ${t.id}: its checkout must not be /, a top-level directory or a whole home directory`);
        }
    }
    assert(c.clients.length > 0 && new Set(c.clients.map(p => p.principalId)).size === 1, 'CONFIG', 'This release is single-owner; all entry clients must map to the same principalId');
    const clientIds = new Set<string>();
    for (const p of c.clients) {
        assert(p.clientId && !clientIds.has(p.clientId), 'CONFIG', 'Duplicate client');
        clientIds.add(p.clientId);
        assert(['grokbot', 'dot', 'muse', 'cli', 'web'].includes(p.entryKind), 'CONFIG', 'Unknown entry kind');
        assert(p.principalId && p.tokenEnv && Number.isInteger(p.authorizationRevision), 'CONFIG', 'Invalid client');
        for (const k of ['scopes', 'projects', 'hosts'] as const)
            assert(Array.isArray(p[k]) && p[k].every(v => typeof v === 'string'), 'CONFIG', 'Invalid authorization config');
    }
    for (const v of Object.values(c.limits))
        assert(Number.isSafeInteger(v) && v > 0, 'CONFIG', 'Positive integer quotas required');
    assert(c.tickMs >= 100 && c.tickMs <= 60000, 'CONFIG', 'tickMs must be 100..60000');
    if (c.planner?.mcpUrl !== undefined)
        assert(typeof c.planner.mcpUrl === 'string' && mcpUrl(c.planner.mcpUrl), 'CONFIG', 'planner.mcpUrl must be an /mcp URL: https, or http only on loopback (a tunnel)');
    if (c.publicOrigin) {
        const u = new URL(c.publicOrigin);
        assert(u.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname), 'CONFIG', 'Public origin must use HTTPS');
    }
}
