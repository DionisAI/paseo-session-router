import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { demoConfig, loadConfig, validateConfig, isLoopback } from './config.js';
import { DemoAdapter } from './demo-adapter.js';
import { PaseoAdapter } from './paseo-adapter.js';
import { Store } from './store.js';
import { Router } from './core.js';
import { startHttp } from './server.js';
import { ProcessGuard } from './guard.js';
import type { Adapter, Principal } from './types.js';
import { errorMessage } from './util.js';
const args = process.argv.slice(2);
const flag = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
async function main() {
    const demo = args.includes('--demo');
    const config = demo ? demoConfig(flag('--data') ?? '.state/demo') : loadConfig(flag('--config') ?? process.env.PSR_CONFIG ?? 'router.local.json');
    if (flag('--port'))
        config.port = Number(flag('--port'));
    validateConfig(config);
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    let tokens: Record<string, string> = {};
    if (demo) {
        const path = resolve(config.dataDir, 'demo-tokens.json');
        if (existsSync(path))
            tokens = JSON.parse(readFileSync(path, 'utf8'));
        for (const c of config.clients) {
            tokens[c.tokenEnv] ??= randomBytes(32).toString('base64url');
            process.env[c.tokenEnv] ??= tokens[c.tokenEnv];
        }
        writeFileSync(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
        chmodSync(path, 0o600);
    }
    const guard = new ProcessGuard(resolve(config.dataDir, 'controller-lock.sqlite'));
    const store = new Store(resolve(config.dataDir, 'router.sqlite'));
    const adapters = new Map<string, Adapter>(config.daemons.map(d => [d.id, d.adapter === 'demo' ? new DemoAdapter(d) : new PaseoAdapter(d)]));
    const router = new Router(config, store, adapters);
    await router.tick().catch(e => console.error(`[router] first tick failed: ${errorMessage(e)}`));
    if (demo && !store.meta('demoSeeded')) {
        const principal = (kind: string): Principal => { const { tokenEnv, disabled, ...p } = config.clients.find(c => c.clientId === kind)!; return p; };
        const sessions = router.listSessions(principal('web'), {}).sessions;
        const research = sessions.find(s => s.daemonId === 'gpu-research' && s.nativeId === 'agent-1')!;
        const backtest = sessions.find(s => s.daemonId === 'lab-test')!;
        router.bind(principal('web'), { workerId: 'eth-mm', sessionRef: research.id, workstreamId: 'maker-fill-validation', expectedRevision: 0 });
        const route = router.resolve(principal('grokbot'), { sessionRef: research.id });
        if (route.status === 'resolved') {
            const source = router.submit(principal('grokbot'), { routeTicket: route.routeTicket!, prompt: 'DEMO: Validate maker-fill assumptions and summarize the next experiment.', idempotencyKey: 'demo-seed-research-001' });
            const r2 = router.resolve(principal('muse'), { sessionRef: backtest.id });
            if (r2.status === 'resolved')
                await router.handoff(principal('muse'), { sourceTaskId: source.id, targetRouteTicket: r2.routeTicket!, idempotencyKey: 'demo-seed-handoff-001', objective: 'DEMO: Independently review the research summary', contextSummary: 'Simulated research output only; no live model or trading process.', artifactRefs: [], acceptanceCriteria: ['Return a simulated result'] });
        }
        store.setMeta('demoSeeded', '1');
    }
    const app = await startHttp(router);
    const interval = setInterval(() => { void router.tick().catch(e => console.error(`[router] tick failed: ${errorMessage(e)}`)); }, config.tickMs);
    console.log(`Paseo Session Router 0.3.0\nConsole: ${app.baseUrl}\nMode: ${config.mode}${demo ? ' — SIMULATED HOSTS. No provider or shell execution.' : ''}\nMCP: ${app.baseUrl}/mcp\nOpenAPI: ${app.baseUrl}/openapi.json (authenticated)`);
    if (!isLoopback(config.listen))
        console.warn(`WARNING: listening on ${config.listen}:${config.port}, beyond this machine. Anyone who reaches it can try credentials against the API; keep it behind a VPN, a tailnet or an authenticating proxy with TLS.`);
    if (demo)
        console.log(`Console token: ${process.env.PSR_WEB_TOKEN}\nSeparate entry credentials: ${resolve(config.dataDir, 'demo-tokens.json')}`);
    let closing = false;
    const shutdown = async () => { if (closing)
        return; closing = true; clearInterval(interval); await app.close(); await router.close(); store.close(); guard.close(); };
    process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
    process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
}
main().catch(e => { console.error(`Startup failed: ${errorMessage(e)}`); process.exit(1); });
