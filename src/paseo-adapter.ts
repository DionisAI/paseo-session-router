import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Adapter, AgentChannel, NativeEvent, NativeSession, DaemonConfig, SessionTemplate, PermissionRequest, ProviderLogin } from './types.js';
import { assert, Fault, runJsonCommand, stable, hash, deadline } from './util.js';
import { isPostMessageTool, routerToolName, observedStubSource, SEAT_DISALLOWED_TOOLS, VERDICT_TOOL } from './agent-channel.js';
/** Structural boundary, not a claim that the optional SDK was installed in the offline build environment.
 * Runtime parsing rejects missing fields instead of guessing IDs or completion. Only public SDK methods are used.
 */
export interface SdkLike {
    connect(): Promise<void>;
    close(): Promise<void>;
    agents: {
        list(options?: unknown): Promise<unknown>;
        ref(id: string): SdkHandle;
        create(options: unknown): Promise<SdkHandle>;
    };
    /** Interrupts the agent's current run only (Paseo cancelAgentRun: interrupt, wait to settle, else turn_canceled); the agent stays. */
    cancelAgent?(agentId: string): Promise<void>;
    /** The daemon's workspace files (its file explorer), each scoped by the daemon to the cwd it is given. */
    readFile?(cwd: string, path: string, requestId: string | undefined, maxBytes: number, timeoutMs: number): Promise<{ bytes: Uint8Array; size: number }>;
    requestFileExplorer?(cwd: string, path: string, mode: 'list' | 'file', requestId: string): Promise<any>;
    createFileEntry?(input: { cwd: string; parentPath: string; name: string; kind: 'file' | 'directory' }): Promise<any>;
    /** content is written as UTF-8 text: the Router sends no contentEncoding (added in Paseo 0.13; the 0.12 client stripped it). */
    writeFile?(input: { cwd: string; path: string; content: string; expectedModifiedAt: string; expectedRevision?: string }): Promise<any>;
    deleteFileEntry?(input: { cwd: string; path: string }): Promise<any>;
    /** The daemon's report on one provider: { provider, diagnostic } where diagnostic is a text report (Paseo 0.15). */
    getProviderDiagnostic?(provider: string): Promise<any>;
}
export interface SdkHandle {
    id: string;
    current(): unknown;
    refresh(): Promise<unknown>;
    send(text: string): Promise<void>;
    respondToPermission?(options: { requestId: string; response: unknown }): Promise<void>;
    timeline: {
        subscribe(fn: (e: unknown) => void): {
            (): void;
            ready: Promise<void>;
        };
        refetch(options?: unknown): Promise<unknown>;
    };
}
function obj(x: unknown): Record<string, any> { assert(x !== null && typeof x === 'object' && !Array.isArray(x), 'SDK_CONTRACT', 'Unexpected Paseo response shape', 503); return x as Record<string, any>; }
export function parseAgent(value: unknown, workspace?: unknown): NativeSession { const a = obj(value), w = workspace && typeof workspace === 'object' ? obj(workspace) : {}; assert(typeof a.id === 'string' && typeof a.status === 'string', 'SDK_CONTRACT', 'Paseo agent id/status missing', 503); assert(a.cwd === null || a.cwd === undefined || typeof a.cwd === 'string', 'SDK_CONTRACT', 'Invalid cwd', 503); return { id: a.id, title: typeof a.title === 'string' ? a.title : a.id, cwd: typeof a.cwd === 'string' ? a.cwd : null, provider: typeof a.provider === 'string' ? a.provider : typeof a.runtimeInfo?.provider === 'string' ? a.runtimeInfo.provider : 'unknown', providerSessionId: typeof a.runtimeInfo?.sessionId === 'string' ? a.runtimeInfo.sessionId : null, workspaceId: typeof a.workspaceId === 'string' ? a.workspaceId : null, status: a.status, activeTurnId: typeof a.activeTurn?.turnId === 'string' ? a.activeTurn.turnId : null, parentId: typeof a.parentAgentId === 'string' ? a.parentAgentId : null, pendingPermissions: Array.isArray(a.pendingPermissions) ? a.pendingPermissions.length : 0, background: w.background === true, lastError: typeof a.lastError === 'string' && a.lastError ? a.lastError : null, modeId: typeof a.currentModeId === 'string' ? a.currentModeId : null }; }
/** Lifecycle evidence must carry an explicit turn ID. Absence is preserved, never filled with the latest active turn. */
/** A tool call as one short line for the live view; Paseo already sorts calls into shell, read, edit, write, search, fetch … */
export function toolStep(item: Record<string, any>): NonNullable<NativeEvent['step']> {
    const d = item.detail && typeof item.detail === 'object' ? item.detail as Record<string, any> : {}, line = (v: unknown) => String(v ?? '').split('\n').map(x => x.trim()).find(Boolean) ?? '';
    const status = ['running', 'completed', 'failed', 'canceled'].includes(item.status) ? item.status : item.error ? 'failed' : 'running';
    const [kind, text]: [NonNullable<NativeEvent['step']>['kind'], string] =
        d.type === 'shell' ? ['shell', line(d.command)] : d.type === 'read' ? ['read', line(d.filePath)] : d.type === 'edit' ? ['edit', line(d.filePath)] : d.type === 'write' ? ['write', line(d.filePath)]
        : d.type === 'search' ? ['search', line(d.query)] : d.type === 'fetch' ? ['fetch', line(d.url)] : d.type === 'sub_agent' ? ['agent', line(d.description ?? d.subAgentType)] : d.type === 'plan' ? ['plan', line(d.text)]
        : d.type === 'plain_text' ? ['note', line(d.label ?? d.text)] : ['tool', line(item.name)];
    return { kind, text: text || line(item.name), status, ...(d.type === 'shell' && typeof d.exitCode === 'number' ? { exitCode: d.exitCode } : {}) };
}
export function parseNativeEvent(input: unknown, agentId: string, fallbackId: string): NativeEvent | null { const root = obj(input), e = root.event ? obj(root.event) : root; const turnId = typeof e.turnId === 'string' ? e.turnId : typeof root.turnId === 'string' ? root.turnId : null; let cursor: string | null = null; if (typeof root.epoch === 'string' && typeof root.seq === 'number')
    cursor = JSON.stringify({ epoch: root.epoch, seq: root.seq }); const base = { id: typeof root.id === 'string' ? root.id : fallbackId, sessionId: agentId, cursor, turnId }; if (e.type === 'subscription_restored' || e.type === 'replacement' || e.type === 'error')
    return { ...base, type: 'gap', text: e.type }; if (e.type === 'timeline') {
    const item = obj(e.item);
    if (item.type === 'user_message' || item.type === 'assistant_message')
        return { ...base, type: item.type, text: typeof item.text === 'string' ? item.text : '' };
    // Observed agent channel: a completed psr_post_message call carries the message in its input.
    if (item.type === 'tool_call' && typeof item.name === 'string' && isPostMessageTool(item.name) && item.status === 'completed' && typeof item.callId === 'string') {
        const input = item.detail && typeof item.detail === 'object' ? item.detail.input : undefined;
        if (input && typeof input === 'object' && typeof input.text === 'string')
            return { ...base, id: `tool-${agentId}-${item.callId}`, type: 'agent_message', text: input.text, kind: ['progress', 'question', 'result', 'note'].includes(input.kind) ? input.kind : 'note', callId: item.callId };
    }
    // Any other Router tool (an arbiter's psr_verdict): its name and input, checked by the Router when applied.
    const routerTool = item.type === 'tool_call' && typeof item.name === 'string' ? routerToolName(item.name) : null;
    if (routerTool && !isPostMessageTool(item.name) && item.status === 'completed' && typeof item.callId === 'string') {
        const input = item.detail && typeof item.detail === 'object' ? item.detail.input : undefined;
        if (input && typeof input === 'object')
            return { ...base, id: `tool-${agentId}-${item.callId}`, type: 'router_call', tool: routerTool, input, callId: item.callId };
    }
    if (item.type === 'tool_call' && typeof item.callId === 'string' && typeof item.name === 'string' && !routerToolName(item.name)) {
        const step = toolStep(item);
        return { ...base, id: `step-${agentId}-${item.callId}-${step.status}`, type: 'tool_step', callId: item.callId, step };
    }
    return null;
} if (['turn_started', 'turn_completed', 'turn_failed', 'turn_canceled', 'permission_requested', 'permission_resolved'].includes(e.type))
    return { ...base, type: e.type, text: typeof e.error === 'string' ? e.error : typeof e.reason === 'string' ? e.reason : undefined }; return null; }
/** A Paseo pairing link (https://app.paseo.sh/#offer=<base64url JSON>, offer v2), as printed by `paseo pair`. */
export interface PairingOffer {
    serverId: string;
    daemonPublicKeyB64: string;
    relay: {
        endpoint: string;
        useTls: boolean;
    };
}
/** Parsed here rather than by the SDK so the pinned key is known before connecting and unknown versions fail closed. */
export function parsePairingOffer(link: string): PairingOffer {
    const at = link.indexOf('#offer=');
    assert(at >= 0, 'CONFIG', 'Not a Paseo pairing link (expected …#offer=…); run `paseo pair` on that machine');
    let o: any;
    try {
        o = JSON.parse(Buffer.from(link.slice(at + '#offer='.length).trim(), 'base64url').toString('utf8'));
    }
    catch {
        throw new Fault('CONFIG', 'Malformed Paseo pairing link');
    }
    assert(o?.v === 2, 'CONFIG', 'Unsupported Paseo pairing offer version; update the Router');
    assert(typeof o.serverId === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(o.serverId) && typeof o.daemonPublicKeyB64 === 'string' && o.daemonPublicKeyB64.length > 0 && typeof o.relay?.endpoint === 'string' && /^(\[[^\]\s]+\]|[^:\s/]+):\d{1,5}$/.test(o.relay.endpoint) && (o.relay.useTls === undefined || typeof o.relay.useTls === 'boolean'), 'CONFIG', 'Incomplete Paseo pairing offer');
    return { serverId: o.serverId, daemonPublicKeyB64: o.daemonPublicKeyB64, relay: { endpoint: o.relay.endpoint, useTls: o.relay.useTls ?? o.relay.endpoint.endsWith(':443') } };
}
/** Same URL Paseo clients use to reach a daemon through its relay (protocol v2, client role). */
export function relayClientUrl(o: PairingOffer): string { const u = new URL(`${o.relay.useTls ? 'wss' : 'ws'}://${o.relay.endpoint}/ws`); u.searchParams.set('serverId', o.serverId); u.searchParams.set('role', 'client'); u.searchParams.set('v', '2'); return u.toString(); }
/** Only the daemon holding the private key for the pinned public key can complete the E2EE handshake. */
export const pairingIdentity = (o: PairingOffer) => `e2ee:${o.serverId}:${hash(o.daemonPublicKeyB64).slice(0, 16)}`;
/** The command or input a permission request would run, bounded for display to an approver. */
export function parsePermission(raw: unknown): PermissionRequest {
    const r = (raw ?? {}) as Record<string, any>, input = (r.input && typeof r.input === 'object' ? r.input : {}) as Record<string, unknown>, cmd = input.command ?? input.cmd ?? r.detail?.command;
    const text = Array.isArray(cmd) ? cmd.map(String).join(' ') : typeof cmd === 'string' ? cmd : Object.keys(input).length ? JSON.stringify(input) : r.detail ? JSON.stringify(r.detail) : null;
    assert(typeof r.id === 'string' && r.id.length > 0, 'SDK_CONTRACT', 'Permission request without an id');
    return { id: r.id, tool: String(r.name ?? r.kind ?? 'tool'), title: typeof r.title === 'string' ? r.title : null, description: typeof r.description === 'string' ? r.description : null, detail: text === null ? null : text.length > 2000 ? text.slice(0, 2000) + '…' : text, ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}) };
}
/** The login part of Paseo's provider diagnostic (0.15): a text report of "  Field: value" lines, a value running on until the
 * next field. Its Auth field is the provider's own `auth status` JSON (Claude Code; Codex has none). Only the login fields are
 * kept; the report's paths, account email and organization are dropped here. */
export function parseProviderDiagnostic(text: string): ProviderLogin {
    const fields = new Map<string, string>();
    let key: string | null = null;
    for (const line of text.split('\n')) {
        const m = /^ {2}([A-Z][A-Za-z ()-]{0,40}):(?: (.*))?$/.exec(line);
        if (m) { key = m[1]; fields.set(key, m[2] ?? ''); }
        else if (key) fields.set(key, `${fields.get(key)}\n${line}`);
    }
    const authText = (fields.get('Auth') ?? '').trim();
    let auth: Record<string, unknown> | null = null;
    try { const a = JSON.parse(authText); if (a && typeof a === 'object' && !Array.isArray(a)) auth = a; } catch { /* no auth report, or plain text */ }
    const word = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().split('\n')[0].slice(0, max) : null;
    const expires = typeof auth?.loginExpiresAt === 'string' ? Date.parse(auth.loginExpiresAt) : NaN;
    return {
        loggedIn: typeof auth?.loggedIn === 'boolean' ? auth.loggedIn : !auth && /not logged in/i.test(authText) ? false : null,
        method: word(auth?.authMethod, 40), plan: word(auth?.subscriptionType, 40), expiresAt: Number.isFinite(expires) ? expires : null,
        version: word(fields.get('Version'), 60), status: word(fields.get('Status'), 60),
    };
}
export class PaseoAdapter implements Adapter {
    kind = 'paseo';
    capabilities = { cancel: true, create: true, history: true, live: true };
    private client?: SdkLike;
    private connected = false;
    private streamCounter = 0;
    private offer?: PairingOffer;
    constructor(readonly config: DaemonConfig, private injected?: SdkLike) { }
    private pairing(): PairingOffer | undefined {
        if (!this.config.pairingEnv)
            return undefined;
        if (!this.offer) {
            const link = process.env[this.config.pairingEnv];
            assert(link, 'CONFIG', `Set ${this.config.pairingEnv} to this daemon's pairing link (paseo pair on that machine)`);
            this.offer = parsePairingOffer(link);
        }
        return this.offer;
    }
    get pinnedIdentity() { const o = this.pairing(); return o ? pairingIdentity(o) : undefined; }
    /** Direct URL (local or SSH tunnel) or the Paseo relay with E2EE to the pinned daemon key. */
    clientOptions() {
        const o = this.pairing();
        return { url: o ? relayClientUrl(o) : this.config.url, ...(o ? { e2ee: { enabled: true, daemonPublicKeyB64: o.daemonPublicKeyB64 } } : {}), connectTimeoutMs: o ? 12000 : 5000, password: this.config.passwordEnv ? process.env[this.config.passwordEnv] : undefined, authHeader: this.config.authHeaderEnv ? process.env[this.config.authHeaderEnv] : undefined, reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 15000 } };
    }
    async connect() {
        if (this.connected)
            return;
        if (!this.client) {
            if (this.injected)
                this.client = this.injected;
            else {
                const modulePath = this.config.sdkModule ?? resolve('integrations/paseo/node_modules/@getpaseo/client/dist/index.js');
                let mod: any;
                try {
                    mod = await import(pathToFileURL(modulePath).href);
                }
                catch {
                    throw new Fault('SDK_NOT_INSTALLED', 'Install the pinned Paseo integration with npm run install:paseo, then run the live smoke test.', 503);
                }
                assert(typeof mod.createPaseoClient === 'function', 'SDK_CONTRACT', 'createPaseoClient export missing', 503);
                // Built the way createPaseoClient builds it, keeping the daemon client for the one call the public API lacks:
                // cancelling the current turn, and the file explorer (the package's daemon-client entry; pinned SDK 0.15.2,
                // checked live against Paseo 0.15.2 on 2026-11-08; 0.12.0 before).
                let daemonMod: any = null;
                try { daemonMod = await import(pathToFileURL(resolve(dirname(modulePath), 'daemon-client.js')).href); } catch { /* fall back without cancel */ }
                if (typeof daemonMod?.DaemonClient === 'function' && typeof mod.createPaseoApi === 'function') {
                    const daemon = new daemonMod.DaemonClient({ ...this.clientOptions(), clientId: `psr-router-${randomUUID()}`, clientType: 'cli' }), api = mod.createPaseoApi(daemon);
                    this.client = { ...api, connect: () => daemon.connect(), close: async () => { try { await api.dispose?.(); } finally { await daemon.close(); } }, cancelAgent: (id: string) => daemon.cancelAgent(id),
                        // the file explorer's calls, for files handed between sessions (psr_send_file, psr_receive_file)
                        readFile: (...a: unknown[]) => daemon.readFile(...a), requestFileExplorer: (...a: unknown[]) => daemon.requestFileExplorer(...a), createFileEntry: (x: unknown) => daemon.createFileEntry(x), writeFile: (x: unknown) => daemon.writeFile(x), deleteFileEntry: (x: unknown) => daemon.deleteFileEntry(x),
                        // the provider's own diagnostic, for its login (psr_check_logins); read-only on the daemon
                        getProviderDiagnostic: (provider: string) => daemon.getProviderDiagnostic(provider) } as SdkLike;
                }
                else this.client = mod.createPaseoClient(this.clientOptions()) as SdkLike;
            }
        }
        try {
            await deadline(this.client!.connect(), this.config.pairingEnv ? 14000 : 6000, 'Paseo connection');
            this.connected = true;
        }
        catch (e) {
            this.connected = false;
            throw e;
        }
    }
    async identity(): Promise<string | null> { const p = this.config.identityProbe; if (p)
        return runJsonCommand(p.command, p.args, { operation: 'identity', daemonId: this.config.id }, p.timeoutMs ?? 5000, 4096); const pinned = this.pinnedIdentity; if (!pinned)
        return null; await this.connect(); return pinned; }
    async list(): Promise<NativeSession[]> { await this.connect(); const results: NativeSession[] = []; let cursor: string | undefined; const seen = new Set<string>(); do {
        const page = obj(await this.client!.agents.list({ filter: { includeArchived: false, includeBackground: true }, page: { limit: 100, ...(cursor ? { cursor } : {}) } }));
        assert(Array.isArray(page.entries), 'SDK_CONTRACT', 'Paseo directory entries missing', 503);
        for (const raw of page.entries) {
            const entry = obj(raw);
            results.push(parseAgent(entry.agent, entry.workspace));
        }
        const info = obj(page.pageInfo);
        assert(info.nextCursor === null || info.nextCursor === undefined || typeof info.nextCursor === 'string', 'SDK_CONTRACT', 'Invalid page cursor', 503);
        cursor = info.nextCursor ?? undefined;
        if (cursor) {
            assert(!seen.has(cursor), 'SDK_CONTRACT', 'Paseo repeated a pagination cursor', 503);
            seen.add(cursor);
        }
        assert(results.length <= 10000, 'CAPACITY_EXCEEDED', 'Remote directory exceeds adapter safety limit', 503);
    } while (cursor); assert(new Set(results.map(s => s.id)).size === results.length, 'SDK_CONTRACT', 'Directory changed during pagination; duplicate ID, retry snapshot', 503); return results; }
    private handle(id: string) { assert(this.client, 'HOST_OFFLINE', 'Paseo client is not connected', 503); return this.client.agents.ref(id); }
    async get(id: string) { await this.connect(); const h = this.handle(id); const result = await h.refresh(); return result === null ? null : parseAgent(h.current()); }
    async prepare(id: string, onEvent: (e: NativeEvent) => void) { await this.connect(); const h = this.handle(id); const unsub = h.timeline.subscribe(raw => { try {
        const event = parseNativeEvent(raw, id, `live-${++this.streamCounter}`);
        if (event)
            onEvent(event);
    }
    catch {
        onEvent({ id: `contract-${++this.streamCounter}`, sessionId: id, cursor: null, turnId: null, type: 'gap', text: 'Unexpected SDK event; reconciliation required' });
    } }); try {
        await deadline(unsub.ready, 5000, 'Paseo timeline subscription');
        const page = obj(await h.timeline.refetch({ direction: 'before', limit: 1, projection: 'projected' }));
        const cursor = page.endCursor ? JSON.stringify(page.endCursor) : null;
        return { cursor, release: () => unsub() };
    }
    catch (e) {
        unsub();
        throw e;
    } }
    async send(id: string, prompt: string) { await this.handle(id).send(prompt); }
    /** Stop the current turn of this agent, and only if it is still the turn the Router dispatched. */
    async cancel(id: string, turnId: string) {
        await this.connect();
        assert(this.client?.cancelAgent, 'CAPABILITY_UNAVAILABLE', 'This Paseo SDK cannot cancel a turn', 409);
        const current = await this.get(id);
        assert(current?.activeTurnId === turnId, 'TURN_MISMATCH', 'The remote active turn is no longer the one to cancel', 409);
        await deadline(this.client.cancelAgent(id), 20000, 'Paseo turn cancellation');
    }
    /** Reads one file through the daemon's file explorer (binary transfer frames); the daemon refuses a path outside cwd. */
    async readFile(cwd: string, path: string, maxBytes: number): Promise<Buffer> {
        await this.connect();
        assert(this.client?.readFile, 'CAPABILITY_UNAVAILABLE', 'This Paseo SDK cannot read workspace files', 409);
        let r: { bytes: Uint8Array; size: number };
        try { r = await this.client.readFile(cwd, path, undefined, maxBytes, 300000); }
        catch (e) { throw new Fault('FILE_UNREADABLE', `Could not read ${path}: ${e instanceof Error ? e.message : String(e)}`, 409); }
        const bytes = Buffer.from(r.bytes);
        assert(bytes.length === r.size, 'FILE_UNREADABLE', `Could not read ${path}: the daemon sent ${bytes.length} of ${r.size} bytes`, 502);
        return bytes;
    }
    /** Creates the folders and the file (empty), then writes the text once against the empty file's version: never over
     * another file. Whatever it created is removed again when a step fails. */
    async writeTextFile(cwd: string, path: string, text: string): Promise<string[]> {
        await this.connect();
        const c = this.client;
        assert(c?.createFileEntry && c.requestFileExplorer && c.writeFile && c.deleteFileEntry, 'CAPABILITY_UNAVAILABLE', 'This Paseo SDK cannot write workspace files', 409);
        const parts = path.split('/'), name = parts.pop()!, created: string[] = [];
        const create = async (parentPath: string, entry: string, kind: 'file' | 'directory') => {
            const full = parentPath === '.' ? entry : `${parentPath}/${entry}`;
            const r = await c.createFileEntry!({ cwd, parentPath, name: entry, kind });
            if (r?.success) { created.push(full); return; }
            const error = String(r?.error ?? 'no answer');
            if (kind === 'directory' && /already exists/.test(error)) return;
            throw new Fault(/already exists/.test(error) ? 'FILE_EXISTS' : 'FILE_UNWRITABLE', `Could not create ${full}: ${error}`, 409);
        };
        try {
            let parent = '.';
            for (const dir of parts) { await create(parent, dir, 'directory'); parent = parent === '.' ? dir : `${parent}/${dir}`; }
            await create(parent, name, 'file');
            const v = await c.requestFileExplorer!(cwd, path, 'file', randomUUID());
            assert(!v?.error && typeof v?.file?.modifiedAt === 'string', 'FILE_UNWRITABLE', `Could not write ${path}: ${v?.error ?? 'the new file is not readable'}`, 409);
            const w = await c.writeFile!({ cwd, path, content: text, expectedModifiedAt: v.file.modifiedAt, ...(typeof v.file.revision === 'string' ? { expectedRevision: v.file.revision } : {}) });
            assert(w?.status === 'written' && w.size === Buffer.byteLength(text), 'FILE_UNWRITABLE', `Could not write ${path}: ${w?.error ?? w?.status ?? 'no answer'}`, 409);
            return created;
        } catch (e) {
            for (const entry of created.reverse()) { try { await this.deleteEntry(cwd, entry); } catch { /* best effort: it was empty or ours */ } }
            throw e;
        }
    }
    async deleteEntry(cwd: string, path: string): Promise<void> {
        await this.connect();
        assert(this.client?.deleteFileEntry, 'CAPABILITY_UNAVAILABLE', 'This Paseo SDK cannot delete workspace files', 409);
        const r = await this.client.deleteFileEntry({ cwd, path });
        assert(r?.success !== false || /no longer exists/.test(String(r?.error)), 'FILE_UNWRITABLE', `Could not remove ${path}: ${r?.error ?? 'no answer'}`, 409);
    }
    /** The provider's login as the daemon's diagnostic reports it; nothing is changed on the daemon. */
    async providerLogin(provider: string): Promise<ProviderLogin> {
        await this.connect();
        assert(this.client?.getProviderDiagnostic, 'CAPABILITY_UNAVAILABLE', 'This Paseo SDK cannot read provider diagnostics', 409);
        const r = await deadline(this.client.getProviderDiagnostic(provider), 60000, 'Paseo provider diagnostic');
        assert(typeof r?.diagnostic === 'string', 'SDK_CONTRACT', 'Provider diagnostic text missing', 503);
        return parseProviderDiagnostic(r.diagnostic);
    }
    async permissions(id: string): Promise<PermissionRequest[]> { const h = this.handle(id); await h.refresh(); const pending = (h.current() as { pendingPermissions?: unknown } | null)?.pendingPermissions; return Array.isArray(pending) ? pending.map(parsePermission) : []; }
    async respondPermission(id: string, requestId: string, allow: boolean, message?: string) { const h = this.handle(id); assert(h.respondToPermission, 'SDK_CONTRACT', 'Paseo SDK cannot answer permission requests', 501); await h.respondToPermission({ requestId, response: allow ? { behavior: 'allow' } : { behavior: 'deny', message: message ?? 'Denied through the Router', interrupt: false } }); }
    async history(id: string, cursor: string | null): Promise<NativeEvent[]> {
        const h = this.handle(id);
        let next = cursor ? JSON.parse(cursor) : undefined;
        const result: NativeEvent[] = [];
        const seen = new Set<string>();
        for (let pages = 0; pages < 50; pages++) {
            const p = obj(await h.timeline.refetch({ direction: next ? 'after' : 'before', ...(next ? { cursor: next } : {}), limit: 100, projection: 'projected' }));
            assert(Array.isArray(p.entries), 'SDK_CONTRACT', 'Timeline entries missing', 503);
            for (const raw of p.entries) {
                const r = obj(raw), item = r.item;
                const c = typeof r.epoch === 'string' ? { epoch: r.epoch, seq: r.seqEnd } : typeof p.endCursor?.epoch === 'string' ? { epoch: p.endCursor.epoch, seq: r.seqEnd } : null;
                const parsed = parseNativeEvent(r.event ? { event: r.event, turnId: r.turnId } : { event: { type: 'timeline', item, turnId: r.turnId } }, id, `history-${hash(stable({ agent: id, cursor: c, item, event: r.event }))}`);
                if (parsed) {
                    if (c && typeof c.seq === 'number') {
                        parsed.cursor = JSON.stringify(c);
                        // The daemon always serves projected history: consecutive assistant chunks arrive as one merged row.
                        if (typeof r.seqStart === 'number' && r.seqStart <= c.seq)
                            parsed.seqStart = r.seqStart;
                    }
                    result.push(parsed);
                }
            }
            if (!p.hasNewer)
                return result;
            assert(p.endCursor, 'SDK_CONTRACT', 'hasNewer without endCursor', 503);
            const key = JSON.stringify(p.endCursor);
            assert(!seen.has(key), 'SDK_CONTRACT', 'Repeated timeline cursor', 503);
            seen.add(key);
            next = p.endCursor;
        }
        throw new Fault('HISTORY_GAP', 'Timeline backfill exceeds safety bound', 503);
    }
    /** A channel becomes a per-agent MCP server named psr with preapproved tools: the Router MCP with the credential in a header
     * (http), or the local stdio stub whose calls the Router reads from the timeline (observed). Never anything in the prompt. */
    async create(template: SessionTemplate, marker: string, channel?: AgentChannel) { await this.connect(); const psr = channel?.mode === 'http' || channel?.mode === 'planner' ? { type: 'http', url: channel.url, headers: { Authorization: `Bearer ${channel.token}` } } : channel?.mode === 'observed' ? { type: 'stdio', command: channel.command, args: ['-e', observedStubSource(channel.role)] } : undefined;
        // The planner also gets its instructions and loses Claude's built-in tools (no shell, files or web); a Claude arbiter seat
        // loses the tools that write, browse or delegate.
        const planner = channel?.mode === 'planner' ? { systemPrompt: channel.systemPrompt, providerOptions: { disallowedTools: channel.disallowedTools } } : channel?.tools.includes(VERDICT_TOOL) && template.provider.startsWith('claude/') ? { providerOptions: { disallowedTools: SEAT_DISALLOWED_TOOLS } } : {};
        const config = { provider: template.provider, ...(template.modeId ? { modeId: template.modeId } : {}), ...planner, ...(channel && psr ? { mcpServers: { psr }, toolPolicy: { preapproved: channel.tools.map(tool => ({ kind: 'mcp', server: 'psr', tool })) } } : {}) }; const h = await this.client!.agents.create({ config, cwd: template.cwd, title: template.title, labels: { 'psr-creation': marker } }); await h.refresh(); return parseAgent(h.current()); }
    async close() { if (this.client)
        await this.client.close(); this.client = undefined; this.connected = false; }
}
