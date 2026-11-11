import type { WeatherPlace } from './weather.js';
import type { HelperAutoRule } from './helper.js';
import type { AutoApprove } from './auto-approve.js';
/** 'agent' is a Paseo session reporting back over its own channel credential, never a configured entry client. */
/** planner: the Router's own planning session (credential minted by the Router); router: turns the Router itself sends it. */
export type EntryKind = 'grokbot' | 'dot' | 'muse' | 'cli' | 'web' | 'agent' | 'planner' | 'router' | 'local';
export type DispatchMode = 'managed' | 'paused' | 'observe_only';
export type TaskState = 'queued' | 'sending' | 'accepted' | 'running' | 'waiting_permission' | 'delivery_unknown' | 'cancel_requested' | 'completed' | 'failed' | 'canceled';
export const TERMINAL: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'canceled']);
export const ACTIVE: ReadonlySet<TaskState> = new Set(['sending', 'accepted', 'running', 'waiting_permission', 'delivery_unknown', 'cancel_requested']);
export interface Principal {
    principalId: string;
    clientId: string;
    entryKind: EntryKind;
    scopes: string[];
    projects: string[];
    hosts: string[];
    authorizationRevision: number;
    /** Planner principals only: the toolset its session was created with; tools added in a later toolset stay hidden from it. */
    toolset?: number;
}
export interface ClientConfig extends Principal {
    tokenEnv: string;
    disabled?: boolean;
}
export interface HostConfig {
    id: string;
    label: string;
    /** Owner-written role of this machine (data, resources, purpose). Trusted text for planners; never a security control. */
    description?: string;
    tags?: string[];
    /** Owner-written constraints for planners, e.g. "no live orders here". Enforce real limits technically as well. */
    rules?: string[];
    /** Permission requests of sessions on this host can be answered only by an admin (the owner in the console), never by an
     * entry bot with the approve scope. Use it where a wrong command is costly, such as live trading hosts. */
    humanApproval?: boolean;
}
/** A permission request a session is waiting on, as shown to approvers. detail is the bounded command or tool input. */
export interface PermissionRequest {
    id: string;
    tool: string;
    title: string | null;
    description: string | null;
    detail: string | null;
    /** Where the request would run when the provider says (Codex sends a cwd per command). */
    cwd?: string | null;
}
/** One provider's login on one machine, as that daemon's diagnostic reports it: never a credential, an account or a path.
 * null where the diagnostic does not say (Codex reports no login at all, only that it is ready). */
export interface ProviderLogin {
    loggedIn: boolean | null;
    /** claude.ai, oauth_token, api_key … as the provider names it. */
    method: string | null;
    plan: string | null;
    /** When the login stops working and must be renewed (Claude's subscription logins). */
    expiresAt: number | null;
    version: string | null;
    /** The daemon's verdict on the provider, e.g. Ready. */
    status: string | null;
}
/** Who answered which permission request of a task; kept on the task as an audit trail. */
export interface PermissionDecision {
    requestId: string;
    decision: 'allow' | 'deny';
    by: string;
    at: number;
    tool: string;
    detail: string | null;
    /** Permission level of the request when it was answered (L0–L4). */
    level?: string;
    /** The Router answered it in code (by 'router'): the rule that decided. */
    rule?: string;
}
/** Owner edits from the console (admin): override config names/descriptions without editing files. */
export interface Annotation {
    displayName?: string | null;
    description?: string | null;
    tags?: string[] | null;
    rules?: string[] | null;
    updatedAt: number;
    by: string;
}
export interface Mapping {
    cwd: string;
    projectId: string;
    workspaceId: string;
    mutationDomainId: string;
    releasePolicy: 'manual' | 'on_turn_end';
    workerId?: string;
    /** A turn started outside the Router: 'pause' (default for explicit mappings) blocks dispatch until an explicit resume; 'wait' (default for autoMap) only waits for it to end. */
    externalTurns?: 'pause' | 'wait';
}
/** Opt-in mapping for discovered sessions whose cwd has no explicit mapping. The mutation domain is host + cwd. */
export interface AutoMapConfig {
    projectId: string;
    releasePolicy: 'manual' | 'on_turn_end';
    externalTurns?: 'pause' | 'wait';
}
/** observed (default without url): a local stdio tool whose calls the Router reads from the Paseo timeline, so the agent
 * needs no route back. http: the agent calls the Router MCP at url with its own scoped credential. */
export interface AgentChannelConfig {
    mode?: 'observed' | 'http';
    url?: string;
    /** http mode: lifetime of the per-session credential stored in the agent's Paseo config (default 30 days). */
    tokenTtlMs?: number;
    /** observed mode: Node executable on that host for the local tool (default "node"). */
    nodeCommand?: string;
}
/** What a created agent receives: the preapproved tools and either the Router MCP endpoint + credential or a local command. */
export type AgentChannel = {
    mode: 'http';
    url: string;
    token: string;
    tools: string[];
} | {
    mode: 'observed';
    command: string;
    tools: string[];
    /** Session role: an arbiter seat's local tool is psr_verdict instead of psr_post_message. */
    role?: SeatRole;
} | {
    /** The Router's planner: its tools are the Router's (MCP over HTTP with a planner credential), Claude's own tools are off. */
    mode: 'planner';
    url: string;
    token: string;
    tools: string[];
    systemPrompt: string;
    disallowedTools: string[];
};
/** A message a session sent to whoever assigned its task. Bounded and untrusted. */
export interface AgentMessage {
    id: string;
    seq: number;
    sessionRef: string;
    hostId: string;
    projectId: string | null;
    taskId: string | null;
    toClientId: string | null;
    kind: 'progress' | 'question' | 'result' | 'note';
    text: string;
    createdAt: number;
    /** Set when the planner writes to the front-end that handed it this goal. */
    goalId?: string | null;
}
/** Who wrote a forum post. Set by the Router from the caller's credential, never by the caller. */
/** A forum post's author. A local session (kind local) is named by its member id in sessionRef. */
export interface ForumAuthor { kind: 'agent' | 'planner' | 'owner' | 'local'; clientId: string; sessionRef: string | null; hostId: string | null }
/** One note on a mission's forum (論壇). forum = the mission key (a missionId; for planner work, the goal id). */
export interface ForumPost { id: string; seq: number; forum: string; author: ForumAuthor; taskId: string | null; text: string; at: number }
export interface ProbeConfig {
    command: string;
    args: string[];
    expectedValue: string;
    timeoutMs?: number;
    /** Directory sync reuses a probe result this long (default 60000; 0 = every tick). Dispatch always probes afresh. */
    cacheMs?: number;
}
export interface DaemonConfig {
    id: string;
    hostId: string;
    label: string;
    incarnation: string;
    adapter: 'demo' | 'paseo';
    url?: string;
    /** Env var holding the daemon's Paseo pairing link: connect through the Paseo relay with E2EE to the pinned daemon key
     * instead of a direct URL. The link grants owner access to that daemon, so it only ever lives in a secret. */
    pairingEnv?: string;
    passwordEnv?: string;
    authHeaderEnv?: string;
    identityProbe?: ProbeConfig;
    mappings: Mapping[];
    sdkModule?: string;
    autoMap?: AutoMapConfig;
    /** Sessions created from templates on this daemon get the Router MCP at this URL (as reachable from that host). */
    agentChannel?: AgentChannelConfig;
}
export interface Worker {
    id: string;
    projectId: string;
    alias: string;
    role: string;
    mode: DispatchMode;
    revision: number;
    sessionRefs: string[];
}
export interface Binding {
    id: string;
    workerId: string;
    projectId: string;
    workstreamId: string;
    sessionRef: string;
    revision: number;
}
export interface Session {
    id: string;
    daemonId: string;
    incarnation: string;
    hostId: string;
    nativeId: string;
    title: string;
    provider: string;
    providerSessionId: string | null;
    cwd: string | null;
    workspaceId: string | null;
    projectId: string | null;
    domainId: string | null;
    workerId: string | null;
    nativeStatus: string;
    activeTurnId: string | null;
    nativeParentId: string | null;
    observedAt: number;
    version: number;
    present: boolean;
    externalActivity: boolean;
    releasePolicy: 'manual' | 'on_turn_end';
    pendingPermissions: number;
    background: boolean;
    /** The provider permission mode Paseo reports for the agent (absent on older daemons). */
    modeId?: string | null;
}
export interface DaemonObservation {
    id: string;
    hostId: string;
    label: string;
    incarnation: string;
    connection: 'online' | 'offline' | 'identity_mismatch' | 'unverified';
    observedAt: number | null;
    reason: string | null;
    capabilities: {
        cancel: boolean;
        create: boolean;
        history: boolean;
        live: boolean;
    };
    version: number;
}
export interface NativeSession {
    id: string;
    title: string;
    cwd: string | null;
    provider: string;
    providerSessionId: string | null;
    workspaceId: string | null;
    status: string;
    activeTurnId: string | null;
    parentId: string | null;
    pendingPermissions: number;
    background: boolean;
    /** Paseo's record of the agent's last turn: set by a failed turn, cleared by a completed or cancelled one. */
    lastError?: string | null;
    /** The provider permission mode the agent runs in now (Paseo reports currentModeId). */
    modeId?: string | null;
}
export type NativeEvent = {
    id: string;
    sessionId: string;
    cursor: string | null;
    turnId: string | null;
    type: 'user_message' | 'assistant_message' | 'turn_started' | 'turn_completed' | 'turn_failed' | 'turn_canceled' | 'permission_requested' | 'permission_resolved' | 'gap' | 'agent_message' | 'tool_step' | 'router_call';
    text?: string;
    /** agent_message: the session's completed psr_post_message call, keyed by the provider call ID. */
    kind?: 'progress' | 'question' | 'result' | 'note';
    callId?: string;
    /** First native seq covered by this event. History rows may merge several live chunks (seqStart..cursor seq). */
    seqStart?: number;
    /** The Router concluded this turn end from the session's state because the native event never arrived. */
    inferred?: boolean;
    /** tool_step: one tool call of the turn as a short line (callId above), updated as it runs and finishes. */
    step?: { kind: TaskStep['kind']; text: string; status: TaskStep['status']; exitCode?: number | null };
    /** router_call: a completed call of a Router tool other than psr_post_message, read from the timeline (observed channel). */
    tool?: string;
    input?: unknown;
};
/** One thing an agent did in its turn, for the live view: a shell command, a file it read or changed, a search… Untrusted text,
 * truncated and with obvious secrets masked. */
export interface TaskStep {
    callId: string;
    kind: 'shell' | 'read' | 'edit' | 'write' | 'search' | 'fetch' | 'agent' | 'plan' | 'note' | 'tool';
    text: string;
    status: 'running' | 'completed' | 'failed' | 'canceled';
    exitCode?: number | null;
    at: number;
}
export interface PreparedObservation {
    cursor: string | null;
    release: () => void;
}
export interface Adapter {
    kind: string;
    /** An identity the transport itself proves (E2EE to a pinned daemon key); used when no identity probe is configured. */
    readonly pinnedIdentity?: string;
    capabilities: {
        cancel: boolean;
        create: boolean;
        history: boolean;
        live: boolean;
    };
    connect(): Promise<void>;
    identity(): Promise<string | null>;
    list(): Promise<NativeSession[]>;
    get(id: string): Promise<NativeSession | null>;
    prepare(id: string, onEvent: (e: NativeEvent) => void): Promise<PreparedObservation>;
    send(id: string, prompt: string): Promise<void>;
    history(id: string, cursor: string | null): Promise<NativeEvent[]>;
    cancel?(id: string, turnId: string): Promise<void>;
    create?(template: SessionTemplate, marker: string, channel?: AgentChannel): Promise<NativeSession>;
    /** Pending permission requests of one session, with the command or input each would run. */
    permissions?(id: string): Promise<PermissionRequest[]>;
    /** Answer one request once; never widens the session's standing permissions. */
    respondPermission?(id: string, requestId: string, allow: boolean, message?: string): Promise<void>;
    /** One file of a session's working directory (path relative to cwd; the daemon keeps it inside), at most maxBytes. */
    readFile?(cwd: string, path: string, maxBytes: number): Promise<Buffer>;
    /** A new UTF-8 text file there, with any folders it needs, at most 1 MiB encoded (Paseo's limit). Text only, so it works
     * with any daemon and client (the 0.12 client dropped contentEncoding): binary goes as base64 text. An existing file is never replaced
     * (FILE_EXISTS). Returns what it created (folders, then the file); when it fails it has removed those itself. */
    writeTextFile?(cwd: string, path: string, text: string): Promise<string[]>;
    /** Removes one entry the Router created there (a folder with what is in it). */
    deleteEntry?(cwd: string, path: string): Promise<void>;
    /** How one provider (claude, codex) is installed and logged in on that machine, as the daemon's own diagnostic reports it. */
    providerLogin?(provider: string): Promise<ProviderLogin>;
    close(): Promise<void>;
}
export interface RoutePayload {
    type: 'route';
    principalId: string;
    clientId: string;
    auth: string;
    target: string;
    fingerprint: string;
    bindingId: string | null;
    bindingRevision: number | null;
    workstreamId: string | null;
    exp: number;
    nonce: string;
}
export interface Artifact {
    kind: 'git' | 'host_path' | 'object';
    locator: string;
    hostId?: string;
    commit?: string;
    accessVerified?: boolean;
    evidence?: string;
}
export interface Task {
    id: string;
    state: TaskState;
    target: string;
    projectId: string | null;
    hostId: string;
    daemonId: string;
    domainId: string;
    targetFingerprint: string;
    workerId: string | null;
    workstreamId: string | null;
    /** Permission requests of this task's turns answered through the Router (who, what, when). */
    approvals?: PermissionDecision[];
    originClientId: string;
    originKind: EntryKind;
    principalId: string;
    prompt: string;
    idempotencyKey: string;
    payloadHash: string;
    marker: string;
    createdAt: number;
    updatedAt: number;
    version: number;
    turnId: string | null;
    dispatchCursor: string | null;
    observationPrepared: boolean;
    lastCursor: string | null;
    attempt: number;
    blocker: string | null;
    resultSummary: string | null;
    /** Assistant text by native seq range; resultSummary is their bounded concatenation. Absent on tasks stored by 0.3.0. */
    resultParts?: {
        start: number;
        end: number;
        text: string;
    }[];
    verification: Verification;
    notificationState: 'not_configured' | 'pending' | 'delivered';
    lockHeld: boolean;
    dependencyId: string | null;
    rootTaskId: string;
    depth: number;
    artifacts: Artifact[];
    completionEvidence: string | null;
    /** Still queued at this time → canceled without being sent. Absent on tasks stored by 0.3.0. */
    queueDeadline?: number | null;
    /** Follow-up created by psr_reply_task: queued behind this task on the same session. */
    replyToTaskId?: string | null;
    /** Append the source task's result (handoff dependency or replied-to task) when this task is sent. */
    includeSourceResult?: boolean;
    /** The user goal this task belongs to; tasks on different sessions share it. Handoffs and replies inherit it. */
    missionId?: string | null;
    /** Planner-given name of the mission, set on any of its tasks; the owner can rename it (annotation kind mission). */
    missionTitle?: string | null;
    /** A named part of the mission (e.g. 盤點, 升級): its tasks grow as one branch. Handoffs and replies inherit it. */
    missionPart?: string | null;
    /** A turn the Router itself sends (waking the planner); not user work, so consoles keep it out of the task garden. */
    system?: 'planner_feed' | null;
    /** Dangerous requests (L3 and above) of this task the Router allowed under the owner's auto-approval; capped per task. */
    autoDanger?: number;
    /** The helper request (helper.ts) this task carries out; a task sent again after a transient failure keeps it. */
    helperOf?: string | null;
    /** A turn the Router wrote and sent in a client's name: the answers of the services its session asked (ask_reply), or word
     * that a shared resource is now its (resource). It is not that client's own instruction. */
    relayed?: 'ask_reply' | 'resource' | null;
    /** When the task last started waiting for a permission answer (for the approval timeout). */
    waitingSince?: number | null;
    /** This task re-sends a task whose turn failed on a transient provider error without doing any work. */
    retryOf?: string | null;
    /** Why the Router asked to stop this turn (shown with the cancellation evidence). */
    cancelReason?: string | null;
    /** When the Router last started sending it (time caps on a turn count from here, not from queueing). */
    sentAt?: number | null;
    /** The tool calls of the task's turn, newest last (at most 40), for the live view. */
    steps?: TaskStep[];
    /** Independent acceptance asked for this task: after it completes, an arbiter seat checks it against these criteria. */
    verify?: VerifySpec | null;
    /** A turn the Router sends to one of its own seats (an arbiter checking another task, or a service answering an ask);
     * separate from system. */
    routerTurn?: 'arbiter' | 'service' | null;
    /** routerTurn 'arbiter': the task being checked, and the turn nonce the verdict must quote. */
    verifyOf?: string | null;
    nonce?: string | null;
    /** routerTurn 'service': the ask this turn answers. */
    askOf?: string | null;
}
/** What acceptance a task needs: an owner-defined arbiter profile and the criteria (written by whoever assigned the task). */
export interface VerifySpec {
    arbiterId: string;
    criteria: string[];
    /** Extra arguments for the profile's Router-run verifier, only if the profile allows them (argsPattern). */
    args?: string;
}
/** The result of acceptance. pending: the verifier or an arbiter turn is still working on it. */
export interface Verification {
    status: 'not_run' | 'pending' | 'passed' | 'failed';
    evidence?: string;
    verifier?: string;
    /** Where a pending check stands, and how many tries it has used. */
    stage?: 'verifier' | 'arbiter' | 'done';
    attempts?: number;
    /** The arbiter turn currently checking this task. */
    arbiterTaskId?: string;
    /** When the check started waiting for an arbiter seat (so a check with no seat does not wait forever). */
    waitingSince?: number;
    verifierExit?: number;
    verifierOutput?: string;
    /** same-family: the arbiter runs the same provider as the work; judgment-only: no mechanical verifier ran; unverified: no verdict came. */
    labels?: string[];
    /** Per-criterion verdict, in the order of the task's criteria. */
    criteria?: { criterion: string; pass: boolean; evidence: string }[];
    decidedAt?: number;
}
export type SeatRole = 'arbiter' | 'service';
/** An owner-defined service: seats of it answer other agents' psr_ask calls in Router turns. Who may call it, what the Router
 * approves on its turns, and how long callers wait all live in the policy, editable in the console. */
export interface Service {
    name: string;
    description: string;
    enabled: boolean;
    /** Hosts whose ordinary sessions may ask it ('*' = any). */
    callers: string[];
    /** Other services this service's seats may ask; the call graph is acyclic and at most 3 services deep. */
    mayCall: string[];
    /** What the Router approves in code on the seat's turns: none, L0 (reads and the exact commands), L1 (also edits inside the
     * seat's own checkout). Everything else waits for the owner. */
    autoAllow: 'none' | 'L0' | 'L1';
    /** Absolute directories the seat may read besides its own checkout. */
    reads: string[];
    /** Exact command lines the seat may run. */
    commands: string[];
    /** Asks waiting for a free seat; one more is refused at once (QUEUE_FULL). */
    queueMax: number;
    /** An ask's deadline, and how long an undelivered answer is kept. */
    ttlMin: number;
    /** Longest synchronous hold for Claude callers (Codex callers: at most 270 s). */
    waitSec: number;
}
export interface A2APolicy { services: Service[]; deliveryMax: number }
/** One psr_ask: an agent's request to a service, the Router turns that answer it, and how the answer reaches the caller
 * (inside the call, or later as the first message of its next turn). */
export interface Ask {
    id: string;
    service: string;
    request: string;
    topic: string | null;
    callerSession: string;
    callerTask: string;
    /** Whoever assigned the caller's turn; a queued answer comes back as a reply in its name. */
    callerClientId: string;
    parentAsk: string | null;
    path: string[];
    depth: number;
    state: 'queued' | 'running' | 'answered' | 'failed' | 'expired' | 'canceled';
    seatRef: string | null;
    turnTaskIds: string[];
    answer: { status: 'done' | 'failed' | 'timed_out' | 'canceled'; text: string; evidence?: string } | null;
    createdAt: number;
    deadlineAt: number;
    settledAt: number | null;
    delivery: 'held' | 'queued' | 'delivered' | 'dropped';
    deliveredAt: number | null;
    deliveredTaskId: string | null;
    dropReason: string | null;
    /** Sub-asks a service turn made whose answers have not reached the seat yet. */
    waitingSub: string[];
    updatedAt: number;
}
/** An owner-defined way of checking work: who checks (its seats), with what commands, and an optional Router-run verifier. */
export interface ArbiterProfile {
    id: string;
    note?: string;
    /** Exact command lines this profile's arbiter seats may run (for example 'node -v'); everything else is denied. */
    commands?: string[];
    /** A trusted check the Router itself runs before any arbiter turn: JSON on stdin, exit 0 pass, 1 fail, 2 malformed input. */
    verifier?: { command: string; args: string[]; timeoutMs: number };
    /** Anchored pattern VerifySpec.args must match; without it, args are not accepted. */
    argsPattern?: string;
}
export type GoalState = 'open' | 'awaiting_approval' | 'active' | 'done' | 'failed' | 'canceled';
export interface GoalMessage {
    at: number;
    from: 'frontend' | 'planner' | 'owner';
    clientId: string;
    kind: 'goal' | 'reply' | 'question' | 'update' | 'plan' | 'decision' | 'done' | 'failed' | 'canceled';
    text: string;
}
/** One goal a front-end hands the planner in the user's words. Its id is the missionId of every task the planner sends for it. */
export interface Goal {
    id: string;
    title: string;
    text: string;
    originClientId: string;
    originKind: EntryKind;
    idempotencyKey: string;
    state: GoalState;
    /** The planner's plan; nothing may change a machine (above L0) for this goal until a front-end or the owner approved it. */
    plan: { text: string; proposedAt: number; decision: { approve: boolean; by: string; at: number; note: string | null } | null } | null;
    messages: GoalMessage[];
    createdAt: number;
    updatedAt: number;
}
/** Something the planner should look at; it is woken with a short digest and reads these through psr_planner_inbox. */
export interface PlannerEvent {
    seq: number;
    kind: 'goal_new' | 'goal_reply' | 'plan_decided' | 'goal_canceled' | 'task_done' | 'task_failed' | 'task_canceled' | 'permission_waiting' | 'delivery_unknown' | 'agent_message' | 'task_verified';
    goalId: string | null;
    taskId: string | null;
    sessionRef: string | null;
    at: number;
}
export interface PlannerSettings {
    sessionRef: string | null;
    /** Creation key of the current planner session; its credential is valid only while this matches. */
    creation: string | null;
    templateId: string | null;
    enabled: boolean;
    /** Minimum gap between two wake-ups; events arriving meanwhile are batched into one turn. */
    batchMs: number;
    maxTurnsPerHour: number;
    lastFeedAt: number;
    fedUpTo: number;
    /** Toolset the current planner session was created with (its instructions and preapproved tools). */
    toolsetVersion?: number;
}
/** Owner policy edited in the console: who answers which permission level, extra rules, and front-end ceilings and grants. */
export interface PolicyState {
    approvers: Record<'L0' | 'L1' | 'L2' | 'L3' | 'L4', ('planner' | 'frontend')[]>;
    rules: { id: string; level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4'; pattern: string; note?: string }[];
    /** Built-in rule ids switched off. */
    disabled: string[];
    /** Owner-set upper bound of each front-end's scopes; unset means the configured scopes. */
    ceilings: Record<string, string[]>;
    /** Planner-set scopes of each front-end, always within the ceiling; unset means the whole ceiling. */
    grants: Record<string, string[]>;
    planner: PlannerSettings;
    /** A turn still waiting for a permission answer this long is cancelled (its request goes with it); 0 = never. */
    approvalTimeoutMs: number;
    /** Independent acceptance: arbiter profiles, and whether a goal may close while a check is still pending. */
    verification: { profiles: ArbiterProfile[]; requireForGoalDone: boolean };
    /** Agent as a service (psr_ask): the services and how many undelivered answers a caller session keeps. */
    a2a: A2APolicy;
    /** Helpers (helper.ts): the owner's standing rules, under which a covered request starts without waiting for a decision. */
    helpers: { auto: HelperAutoRule[] };
    /** Auto-approval (auto-approve.ts): the requests the Router allows by itself, by level and by where the task came from. */
    autoApprove: AutoApprove;
    updatedAt: number;
    by: string;
}
export interface FrontierCard {
    id: string;
    workspaceId: string;
    projectId: string;
    hostId: string;
    current: string;
    next: string;
    blockers: string[];
    ownerSessionRef: string | null;
    refs: string[];
    revision: number;
}
export interface FrontierWorkspace {
    workspaceId: string;
    projectId: string;
    hostId: string;
    revision: number;
    notes: Record<string, string>;
    cards: Record<string, FrontierCard>;
}
export interface SessionTemplate {
    id: string;
    daemonId: string;
    cwd: string;
    provider: string;
    title: string;
    workerId?: string;
    /** What sessions created from this template are for, so a planner can pick the right one. */
    description?: string;
    /** Provider permission mode for created sessions (Claude: plan, default, acceptEdits, auto, bypassPermissions). Omitted: Paseo's provider default. */
    modeId?: string;
    /** A seat template: only the owner instantiates it, with a role (arbiter or service), and only the Router sends its sessions work. */
    seat?: boolean;
}
export interface RouterConfig {
    mode: 'demo' | 'live';
    listen: string;
    /** Listening on anything but loopback must be asked for: whoever reaches that address can try every credential. Keep
     * it behind a VPN, a tailnet or an authenticating proxy (inside a container, bind the published port to 127.0.0.1). */
    listenBeyondLoopback?: boolean;
    /** The console's sky: a place's clock and seasons, and with coordinates its weather from Open-Meteo. Omitted: no outside
     * request at all, the viewer's own clock, no weather. */
    weather?: WeatherPlace;
    port: number;
    dataDir: string;
    publicOrigin?: string;
    allowedOrigins: string[];
    hosts: HostConfig[];
    daemons: DaemonConfig[];
    workers: Omit<Worker, 'revision' | 'sessionRefs'>[];
    clients: ClientConfig[];
    templates: SessionTemplate[];
    /** Where the planner session reaches the Router's MCP endpoint (default http://127.0.0.1:<port>/mcp). */
    planner?: { mcpUrl?: string };
    tickMs: number;
    limits: {
        activeTasks: number;
        receipts: number;
        receiptMs: number;
        outbox: number;
        outboxMs: number;
        sessions: number;
        handoffDepth: number;
        handoffTasks: number;
        ticketMs: number;
        freshnessMs: number;
    };
    frontierCommand?: {
        command: string;
        args: string[];
        timeoutMs: number;
    };
    artifactVerifier?: {
        command: string;
        args: string[];
        timeoutMs: number;
    };
}
export interface TopologyNode {
    id: string;
    kind: 'host' | 'daemon' | 'project' | 'workspace' | 'worker' | 'session' | 'task' | 'client';
    label: string;
    status: string;
    observedAt: number | null;
    freshness: 'fresh' | 'stale' | 'unknown';
    version: number;
    data: Record<string, unknown>;
    allowedActions: string[];
}
export interface TopologyEdge {
    id: string;
    kind: string;
    source: string;
    target: string;
    evidence: {
        source: 'router_record' | 'paseo_metadata' | 'explicit_binding';
        recordRef: string;
    };
}
