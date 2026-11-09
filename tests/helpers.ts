import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoConfig } from '../src/config.js';
import { DemoAdapter } from '../src/demo-adapter.js';
import { Store } from '../src/store.js';
import { Router } from '../src/core.js';
import type { Adapter, Principal, RouterConfig, Task } from '../src/types.js';
import { Fault } from '../src/util.js';
export function principal(kind = 'web', overrides: Partial<Principal> = {}): Principal { return { principalId: 'owner', clientId: kind, entryKind: kind as Principal['entryKind'], scopes: ['read', 'submit', 'cancel', 'bind', 'handoff', 'create', 'frontier', 'admin'], projects: ['*'], hosts: ['*'], authorizationRevision: 1, ...overrides }; }
export async function fixture(change?: (c: RouterConfig) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'psr-test-'));
    const config = demoConfig(dir);
    change?.(config);
    let clock = Date.now();
    const now = () => clock;
    const store = new Store(join(dir, 'router.sqlite'));
    const demos = new Map(config.daemons.map(d => { const a = new DemoAdapter(d); a.autoCompleteMs = null; return [d.id, a]; }));
    const adapters = new Map<string, Adapter>(demos);
    const router = new Router(config, store, adapters, now);
    await router.syncDirectory();
    const sessions = () => router.listSessions(principal()).sessions;
    const session = (daemon = 'gpu-research', native = 'agent-1') => sessions().find(s => s.daemonId === daemon && s.nativeId === native)!;
    const ticket = (p = principal(), ref = session().id) => { const r = router.resolve(p, { sessionRef: ref }); if (r.status !== 'resolved')
        throw new Error('Fixture route failed'); return r.routeTicket!; };
    const submit = (prompt = 'Test instruction', p = principal(), ref = session().id, key = `test-key-${Math.random()}`) => router.submit(p, { routeTicket: ticket(p, ref), prompt, idempotencyKey: key });
    return { dir, config, store, router, demos, adapters, now, sessions, session, ticket, submit, advance: (ms: number) => { clock += ms; }, close: async () => { await router.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export const code = (name: string) => (e: unknown) => e instanceof Fault && e.code === name;
/** Service seat templates (agent as a service): three on gpu1 and one on dev2, which is made owner-only; every daemon used
 * gets the http channel so seats and callers can call psr_ask. */
export const withServices = (c: RouterConfig) => {
    const gpu = c.daemons.find(d => d.id === 'gpu-research')!, lab = c.daemons.find(d => d.id === 'lab-test')!, dev = c.daemons.find(d => d.id === 'dev-app')!;
    for (const [d, name] of [[gpu, 'md'], [gpu, 'fx'], [gpu, 'x'], [dev, 'dev']] as const) {
        d.mappings.push({ cwd: `/srv/svc-${name}`, projectId: d === dev ? 'router' : 'hft', workspaceId: `svc-${name}`, mutationDomainId: `svc-${name}`, releasePolicy: 'on_turn_end' });
        c.templates.push({ id: `svc-${name}`, daemonId: d.id, cwd: `/srv/svc-${name}`, provider: 'claude/claude-opus-5-5', title: `Service seat ${name}`, modeId: 'default', seat: true });
    }
    for (const d of [gpu, lab, dev]) d.agentChannel = { url: 'http://127.0.0.1:8787/mcp' };
    c.hosts.find(h => h.id === 'dev2')!.humanApproval = true;
};
export const SERVICES = [
    { name: 'market-data', description: 'Prices and fills kept on the GPU box', callers: ['lab3'], mayCall: ['fx'], autoAllow: 'L0', reads: ['/srv/data'], commands: ['node -v'] },
    { name: 'fx', description: 'FX rates', callers: ['lab3'], mayCall: [], autoAllow: 'none' },
    { name: 'extra', description: 'A third service', callers: ['lab3'], mayCall: [] },
];
