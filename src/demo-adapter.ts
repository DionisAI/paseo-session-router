import type { Adapter, AgentChannel, NativeSession, NativeEvent, PreparedObservation, SessionTemplate, DaemonConfig, PermissionRequest, ProviderLogin } from './types.js';
import { id, Fault } from './util.js';
/** Deterministic simulated remote host. Never executes shell commands or calls a model. */
export class DemoAdapter implements Adapter {
    kind = 'demo';
    capabilities = { cancel: true, create: true, history: true, live: true };
    online = true;
    dropLive = false;
    identityValue: string;
    fault: 'none' | 'after_accept' | 'before_send' = 'none';
    autoCompleteMs: number | null = 1800;
    sessions = new Map<string, NativeSession>();
    events: NativeEvent[] = [];
    channels = new Map<string, AgentChannel>();
    sends: {
        id: string;
        prompt: string;
        turnId: string;
    }[] = [];
    private listeners = new Map<string, Set<(e: NativeEvent) => void>>();
    private timers = new Set<ReturnType<typeof setTimeout>>();
    private seq = 0;
    constructor(public config: DaemonConfig, seed = true) { this.identityValue = config.incarnation; if (seed) {
        config.mappings.forEach((m, i) => { this.sessions.set(`agent-${i + 1}`, { id: `agent-${i + 1}`, title: i === 0 ? 'Research session' : 'Queue validation', cwd: m.cwd, provider: i % 2 === 0 ? 'codex/demo' : 'claude/demo', providerSessionId: `provider-${config.id}-${i}`, workspaceId: m.workspaceId, status: 'idle', activeTurnId: null, parentId: null, pendingPermissions: 0, background: i > 0 }); });
    } }
    async connect() { this.check(); }
    async identity() { this.check(); return this.identityValue; }
    private check() { if (!this.online)
        throw new Fault('HOST_OFFLINE', 'Simulated host is offline', 503); }
    async list() { this.check(); return [...this.sessions.values()].map(s => structuredClone(s)); }
    async get(s: string) { this.check(); return structuredClone(this.sessions.get(s) ?? null); }
    async prepare(s: string, fn: (e: NativeEvent) => void): Promise<PreparedObservation> { this.check(); const set = this.listeners.get(s) ?? new Set(); set.add(fn); this.listeners.set(s, set); return { cursor: String(this.seq), release: () => set.delete(fn) }; }
    emit(sessionId: string, type: NativeEvent['type'], turnId: string | null, text?: string, extra: Partial<NativeEvent> = {}) { const cursor = String(++this.seq); const e: NativeEvent = { id: `demo-${cursor}`, cursor, sessionId, type, turnId, ...(text === undefined ? {} : { text }), ...extra }; this.events.push(e); if (this.events.length > 10000)
        this.events.shift(); if (this.online && !this.dropLive)
        for (const fn of this.listeners.get(sessionId) ?? [])
            fn(structuredClone(e)); return e; }
    async send(s: string, prompt: string) { this.check(); if (this.fault === 'before_send') {
        this.fault = 'none';
        throw new Error('Connection broke before acknowledgement; caller cannot know delivery outcome');
    } const agent = this.sessions.get(s); if (!agent)
        throw new Fault('NOT_FOUND', 'Simulated agent not found', 404); if (agent.activeTurnId)
        throw new Fault('BUSY', 'Simulated agent is busy', 409); const turnId = id('turn'); this.sends.push({ id: s, prompt, turnId }); agent.status = 'running'; agent.activeTurnId = turnId; this.emit(s, 'user_message', turnId, prompt); this.emit(s, 'turn_started', turnId); if (this.autoCompleteMs !== null) {
        // a short, believable turn for the live view: look around, read a file, then answer
        const ms = this.autoCompleteMs, at = (k: number, fn: () => void) => { const timer = setTimeout(() => { this.timers.delete(timer); if (agent.activeTurnId === turnId) fn(); }, ms * k); this.timers.add(timer); };
        at(0.15, () => this.step(s, 'shell', 'ls -la', 'running', `${turnId}-1`)); at(0.35, () => this.step(s, 'shell', 'ls -la', 'completed', `${turnId}-1`));
        at(0.45, () => this.step(s, 'read', 'README.md', 'running', `${turnId}-2`)); at(0.7, () => this.step(s, 'read', 'README.md', 'completed', `${turnId}-2`));
        const timer = setTimeout(() => { this.timers.delete(timer); if (agent.activeTurnId === turnId)
            this.finish(s, `[SIMULATED RESULT] ${prompt.split('\n').slice(1).join('\n').slice(0, 220)}\nNo code or model was executed.`, turnId); }, this.autoCompleteMs);
        this.timers.add(timer);
    } if (this.fault === 'after_accept') {
        this.fault = 'none';
        throw new Error('Simulated lost acknowledgement after remote acceptance');
    } }
    /** A simulated tool call of the current turn (running, then completed or failed), as Paseo reports it on the timeline. */
    step(s: string, kind: NonNullable<NativeEvent['step']>['kind'], text: string, status: NonNullable<NativeEvent['step']>['status'] = 'completed', callId = `call-${this.seq + 1}`) { const turn = this.sessions.get(s)!.activeTurnId; this.emit(s, 'tool_step', turn, undefined, { id: `demo-step-${callId}-${status}`, callId, step: { kind, text, status } }); return callId; }
    /** A completed Router tool call of the current turn as it appears on the timeline (observed channel), e.g. psr_verdict. */
    call(s: string, tool: string, input: unknown, callId = `call-${this.seq + 1}`) { const turn = this.sessions.get(s)!.activeTurnId; this.emit(s, 'router_call', turn, undefined, { id: `demo-call-${callId}`, callId, tool, input: structuredClone(input) }); return callId; }
    finish(s: string, text = 'Simulated task finished', turnId?: string) { const a = this.sessions.get(s)!; const turn = turnId ?? a.activeTurnId; if (!turn)
        return; this.emit(s, 'assistant_message', turn, text); a.status = 'idle'; a.activeTurnId = null; a.pendingPermissions = 0; this.emit(s, 'turn_completed', turn); }
    pending = new Map<string, PermissionRequest[]>();
    answers: { session: string; requestId: string; allow: boolean }[] = [];
    permission(s: string, request: Partial<PermissionRequest> = {}) { const a = this.sessions.get(s)!; const r: PermissionRequest = { id: request.id ?? id('perm'), tool: request.tool ?? 'Bash', title: request.title ?? null, description: request.description ?? null, detail: request.detail ?? 'echo simulated' }; this.pending.set(s, [...(this.pending.get(s) ?? []), r]); a.status = 'permission'; a.pendingPermissions = this.pending.get(s)!.length; this.emit(s, 'permission_requested', a.activeTurnId); return r; }
    async permissions(s: string) { this.check(); return structuredClone(this.pending.get(s) ?? []); }
    async respondPermission(s: string, requestId: string, allow: boolean) { this.check(); const list = this.pending.get(s) ?? []; if (!list.some(r => r.id === requestId))
        throw new Fault('NOT_FOUND', 'Simulated permission request not pending', 404); this.pending.set(s, list.filter(r => r.id !== requestId)); this.answers.push({ session: s, requestId, allow }); const a = this.sessions.get(s)!; a.pendingPermissions = this.pending.get(s)!.length; if (!a.pendingPermissions) a.status = a.activeTurnId ? 'running' : 'idle'; this.emit(s, 'permission_resolved', null); }
    async history(s: string, cursor: string | null) { this.check(); if (cursor !== null && this.events.length && Number(cursor) < Number(this.events[0].cursor) - 1)
        throw new Fault('HISTORY_GAP', 'Simulated history retention gap'); return this.events.filter(e => e.sessionId === s && Number(e.cursor) > Number(cursor ?? 0)).map(e => structuredClone(e)); }
    async cancel(s: string, turnId: string) { this.check(); const a = this.sessions.get(s); if (!a || a.activeTurnId !== turnId)
        throw new Fault('TURN_MISMATCH', 'Active turn changed', 409); a.status = 'idle'; a.activeTurnId = null; this.pending.delete(s); a.pendingPermissions = 0; this.emit(s, 'turn_canceled', turnId, 'Cancellation observed'); }
    async create(t: SessionTemplate, marker: string, channel?: AgentChannel) { this.check(); const s: NativeSession = { id: id('agent'), title: t.title, cwd: t.cwd, provider: t.provider, providerSessionId: id('provider'), workspaceId: t.cwd, status: 'idle', activeTurnId: null, parentId: null, pendingPermissions: 0, background: false }; this.sessions.set(s.id, s); if (channel)
        this.channels.set(s.id, channel); return structuredClone(s); }
    /** Simulated working-directory files and folders by `${cwd}/${path}`, with Paseo's limits: text only, 1 MiB per write,
     * never over a file. failWrite: a path ending this way fails after its file was created (as a refused write does). */
    files = new Map<string, Buffer>();
    dirs = new Set<string>();
    failWrite: string | null = null;
    async readFile(cwd: string, path: string, maxBytes: number) { this.check(); const b = this.files.get(`${cwd}/${path}`); if (!b)
        throw new Fault('FILE_UNREADABLE', `Could not read ${path}: no such file`, 409); if (b.length > maxBytes)
        throw new Fault('FILE_UNREADABLE', `Could not read ${path}: File is too large`, 409); return Buffer.from(b); }
    async writeTextFile(cwd: string, path: string, text: string) { this.check(); const key = `${cwd}/${path}`, created: string[] = [];
        const parts = path.split('/'), exists = (d: string) => this.dirs.has(`${cwd}/${d}`) || [...this.files.keys()].some(k => k.startsWith(`${cwd}/${d}/`));
        for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); if (!exists(d)) { this.dirs.add(`${cwd}/${d}`); created.push(d); } }
        const undo = async () => { for (const e of created.reverse()) await this.deleteEntry(cwd, e); };
        if (this.files.has(key)) { await undo(); throw new Fault('FILE_EXISTS', `Could not create ${path}: already exists`, 409); }
        this.files.set(key, Buffer.alloc(0)); created.push(path);
        if (Buffer.byteLength(text) > 1024 * 1024 || (this.failWrite && path.endsWith(this.failWrite))) { await undo(); throw new Fault('FILE_UNWRITABLE', `Could not write ${path}: File is too large to edit`, 409); }
        this.files.set(key, Buffer.from(text, 'utf8')); return created; }
    async deleteEntry(cwd: string, path: string) { this.check(); const key = `${cwd}/${path}`;
        for (const k of [...this.files.keys()]) if (k === key || k.startsWith(`${key}/`)) this.files.delete(k);
        for (const d of [...this.dirs]) if (d === key || d.startsWith(`${key}/`)) this.dirs.delete(d); }
    /** Simulated provider logins by provider; an Error is thrown as a failed diagnostic. Unset providers report a plain login. */
    logins = new Map<string, ProviderLogin | Error>();
    loginChecks: string[] = [];
    async providerLogin(provider: string): Promise<ProviderLogin> { this.check(); this.loginChecks.push(provider); const l = this.logins.get(provider); if (l instanceof Error)
        throw l; return structuredClone(l ?? { loggedIn: true, method: 'demo', plan: null, expiresAt: null, version: 'demo', status: 'Ready' }); }
    async close() { for (const timer of this.timers)
        clearTimeout(timer); this.timers.clear(); this.listeners.clear(); }
}
