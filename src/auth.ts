import { timingSafeEqual, createHash } from 'node:crypto';
import type { RouterConfig, Principal } from './types.js';
import type { Store } from './store.js';
import { Fault, assert } from './util.js';
function digest(s: string) { return createHash('sha256').update(s).digest(); }
export class Auth {
    /** agent verifies per-session channel credentials (psra_…), local machine credentials (psrl_…); configured entry tokens are checked below.
     * A status credential (psrs_…) is nobody: it is taken by POST /local/stat alone, before anything here. */
    constructor(private config: RouterConfig, private store: Store, private agent?: (token: string) => Principal, private local?: (token: string) => Principal) { const hashes = new Set<string>(); for (const c of config.clients) {
        if (c.disabled)
            continue;
        const token = process.env[c.tokenEnv];
        assert(token && Buffer.byteLength(token) >= 32, 'CONFIG', `Set a unique >=32 byte token in ${c.tokenEnv}`);
        const h = digest(token).toString('hex');
        assert(!hashes.has(h), 'CONFIG', 'Each entry must have a distinct token');
        hashes.add(h);
    } }
    authenticate(header: string | undefined): Principal { assert(header?.startsWith('Bearer '), 'UNAUTHORIZED', 'A bearer token is required', 401); const token = header!.slice(7); assert(token.length <= 512, 'UNAUTHORIZED', 'Invalid token', 401); if (token.startsWith('psra_') || token.startsWith('psrp_')) {
        assert(this.agent, 'UNAUTHORIZED', 'Agent channels are not enabled', 401);
        return this.agent(token);
    } if (token.startsWith('psrs_'))
        throw new Fault('UNAUTHORIZED', 'A status credential only reports machine status (POST /local/stat)', 401); if (token.startsWith('psrl_')) {
        assert(this.local, 'UNAUTHORIZED', 'Local sessions are not enabled', 401);
        return this.local(token);
    } const h = digest(token); for (const c of this.config.clients) {
        const candidate = process.env[c.tokenEnv];
        if (!candidate)
            continue;
        const match = timingSafeEqual(h, digest(candidate));
        if (!match)
            continue;
        const access = this.store.get<{
            revoked: boolean;
        }>('client_access', c.clientId);
        assert(!c.disabled && !access?.revoked, 'UNAUTHORIZED', 'This entry credential is revoked', 401);
        const { tokenEnv, disabled, ...p } = c;
        return { ...p };
    } throw new Fault('UNAUTHORIZED', 'Invalid entry credential', 401); }
    revoke(p: Principal, clientId: string) { assert(p.scopes.includes('admin'), 'FORBIDDEN', 'Admin scope required', 403); assert(this.config.clients.some(c => c.clientId === clientId), 'NOT_FOUND', 'Client not registered', 404); this.store.put('client_access', clientId, { revoked: true }); return { clientId, revoked: true, tasksCanceled: false }; }
}
