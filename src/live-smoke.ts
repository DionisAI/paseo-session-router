import { loadConfig } from './config.js';
import { PaseoAdapter } from './paseo-adapter.js';
import { errorMessage } from './util.js';
/** Read-only live acceptance check. It never sends a prompt, creates a session or cancels work. */
async function main() { const c = loadConfig(process.argv[2] ?? process.env.PSR_CONFIG ?? 'router.local.json'); const results = []; for (const d of c.daemons) {
    const a = new PaseoAdapter(d);
    try {
        await a.connect();
        const identity = await a.identity();
        const sessions = await a.list();
        let readBack = false;
        if (sessions.length)
            readBack = (await a.get(sessions[0].id))?.id === sessions[0].id;
        results.push({ daemonId: d.id, read: 'passed', identity: identity !== null && identity === (d.identityProbe?.expectedValue ?? a.pinnedIdentity) ? 'verified' : 'unverified', transport: d.pairingEnv ? 'paseo-relay-e2ee' : 'direct', sessionCount: sessions.length, readBack, send: 'not_tested', cancel: 'unavailable', vendorClients: 'not_tested' });
    }
    catch (e) {
        results.push({ daemonId: d.id, read: 'failed', error: errorMessage(e), send: 'not_tested' });
    }
    finally {
        await a.close();
    }
} console.log(JSON.stringify({ testedAt: new Date().toISOString(), results }, null, 2)); if (results.some(r => r.read !== 'passed' || r.identity !== 'verified'))
    process.exitCode = 1; }
main().catch(e => { console.error(errorMessage(e)); process.exitCode = 1; });
