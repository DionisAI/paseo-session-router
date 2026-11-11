/** Helpers (幫手): a local session asks for a Paseo session to do one task where it cannot go itself (another machine, another
 * folder there) and gets the result back. A request does nothing by itself: the owner sees it in the console (who asks, which
 * machine and folder, which model and permission mode, the whole task) and approves or rejects it. Approved, the Router
 * creates the session from the template the request names, in that template's folder or in the folder the request names
 * (where the daemon's autoMap covers it), and sends it the task as the owner's: so it queues, locks and asks for approvals
 * like any task of the owner. When the task ends the requester is told with a Router notice between its turns and reads the
 * whole result with psr_local_helper_result. A follow-up to the same helper session is a request again, approved again.
 * The owner may approve in advance: a standing rule (the policy's helpers.auto) names a template, the machine that asks and
 * the folders a request may choose, and a request it covers starts at once, as the owner who set the rule. Never on an
 * owner-only machine, and only so many a day from one machine; the rest wait for the owner as before.
 * Sessions the Router dispatches do not ask for helpers: they hand work on (psr_ask, the planner). This module holds the
 * types and bounds; core.ts applies them. */
import { basename } from 'node:path';
import { checkableCheckout } from './arbiter.js';
import { isAgentHome } from './local.js';
import { Fault } from './util.js';

/** The task as the helper gets it, the one line that says what it is for, the folder a request may name, the owner's word
 * with a decision. */
export const HELPER_TASK_BYTES = 8192, HELPER_PURPOSE_BYTES = 120, HELPER_CWD_BYTES = 1024, HELPER_NOTE_BYTES = 300;
/** Requests one session may have undecided, being started or running at once. */
export const HELPER_OPEN_PER_MEMBER = 2;
/** Requests the sessions of one machine (one machine credential) may make in an hour, and may have undecided at once. */
export const HELPER_PER_HOUR = 10, HELPER_PENDING_PER_MACHINE = 20;
/** An undecided request expires after this long. */
export const HELPER_PENDING_MS = 24 * 3600000;
/** A request the Router stopped in the middle of starting fails after this long. */
export const HELPER_START_MS = 120000;
/** Standing rules the owner may keep, and how many helpers the sessions of one machine may start under them in 24 hours; past
 * that a covered request waits for the owner like any other (a session caught in a loop cannot start helpers without end). */
export const HELPER_AUTO_RULES_MAX = 20, HELPER_AUTO_PER_DAY = 30, HELPER_RULE_FOLDERS_MAX = 10, HELPER_RULE_NOTE_BYTES = 200;
/** Settled requests stay this long (the result itself is the task's), then go. */
export const HELPER_KEEP_MS = 7 * 86400000;
/** How much of a result the notice to the requester carries; the whole of it is one call away. */
export const HELPER_EXCERPT_BYTES = 1200;

/** pending: waits for the owner; starting: approved, the session is being created; running: its task is with the session;
 * done / failed / canceled: how that task ended (failed also: it could not be started); rejected: the owner said no;
 * expired: nobody decided in time. */
export type HelperState = 'pending' | 'starting' | 'running' | 'done' | 'failed' | 'canceled' | 'rejected' | 'expired';
export const HELPER_OPEN: ReadonlySet<HelperState> = new Set(['pending', 'starting', 'running']);
export interface HelperRequest {
    id: string;
    seq: number;
    /** Who asked: a local session (its name as it was then, since closed members go after a day), its machine and credential. */
    memberId: string;
    memberName: string;
    fromHostId: string;
    credentialId: string;
    /** What kind of session and where: the template gives the machine, provider, model and mode (kept here as approved). */
    templateId: string;
    daemonId: string;
    hostId: string;
    provider: string;
    modeId: string | null;
    cwd: string;
    /** The request named this folder itself; it is not the template's. */
    customCwd: boolean;
    /** A follow-up: the first request of the helper session it goes to. */
    root: string | null;
    /** The helper session: set when it was created, or from the start for a follow-up. */
    sessionRef: string | null;
    taskId: string | null;
    task: string;
    purpose: string | null;
    state: HelperState;
    createdAt: number;
    expiresAt: number;
    decidedAt: number | null;
    decidedBy: string | null;
    decisionNote: string | null;
    finishedAt: number | null;
    error: string | null;
    /** The owner's standing rule that started it (decidedBy is then the client that set the rule); absent or null: the owner
     * decided this one. */
    rule?: string | null;
}
/** The owner's approval in advance. templateId: a template helpers may use on a machine that is not owner-only, or * for all
 * of those. from: the machine whose local sessions ask, or *. folders: where a request may also choose its own folder (that
 * folder or anything below it; * = anywhere a helper may work); the template's own folder is always covered. by: the admin
 * client that set it, in whose name a covered request starts. */
export interface HelperAutoRule { id: string; templateId: string; from: string; folders: string[]; note: string | null; by: string; at: number }

/** Why a request may not name this folder, or null: it must be absolute and plain (no empty, . or .. part, no trailing slash,
 * no control character), not inside a hidden folder (~/.ssh, a .git, a .venv: no project, and often secrets), narrow enough
 * to be one project's (not /, a top-level directory or a whole home directory) and not an agent's own home (~/.claude,
 * ~/.codex; a worktree below one is a project). */
export function helperFolderProblem(cwd: unknown): string | null {
    const shape = plainPathProblem(cwd);
    if (shape) return `cwd ${shape}`;
    return placeProblem(cwd as string);
}
/** Why this is no plain absolute path, or null. */
function plainPathProblem(path: unknown): string | null {
    if (typeof path !== 'string' || !path.startsWith('/')) return 'must be an absolute path';
    if (Buffer.byteLength(path) > HELPER_CWD_BYTES || /[\u0000-\u001f\u007f\u2028\u2029]/.test(path)) return `must be at most ${HELPER_CWD_BYTES} bytes with no control characters`;
    if (path !== '/' && path.slice(1).split('/').some(part => part === '' || part === '.' || part === '..')) return 'must be a plain path: no trailing slash and no empty, . or .. part';
    return null;
}
function placeProblem(cwd: string): string | null {
    const hidden = cwd.slice(1).split('/').find(part => part.startsWith('.') && part !== '.claude' && part !== '.codex');
    if (hidden) return `${cwd} is inside a hidden folder (${hidden}), not a project`;
    if (!checkableCheckout(cwd)) return `${cwd} is too wide to be one project's folder (/, a top-level directory or a whole home directory)`;
    if (isAgentHome(cwd)) return `${cwd} is an agent's own home folder, not a project`;
    return null;
}
/** Whether a rule's folders cover a folder a request chose: one of them, or anything below one; * covers every folder. */
export const ruleCoversFolder = (folders: readonly string[], cwd: string) => folders.includes('*') || folders.some(f => cwd === f || cwd.startsWith(`${f}/`));
/** The owner's standing rules as sent, checked field by field. ok.host says whether a machine is configured, ok.template why
 * a template cannot be named (or null). kept says a rule is one already stored, unchanged: such a rule is not checked against
 * the configuration again, so one that went stale (its template was removed, its machine became owner-only) starts nothing but
 * never stands in the way of editing the others or of removing it. by and at may be sent back as they were read; the Router
 * sets them. */
export function checkHelperRules(input: unknown, ok: { host: (id: string) => boolean; template: (id: string) => string | null }, kept?: (rule: Omit<HelperAutoRule, 'by' | 'at'>) => boolean): Omit<HelperAutoRule, 'by' | 'at'>[] {
    const bad = (why: string): never => { throw new Fault('INVALID_ARGUMENT', `helpers.auto: ${why}`); };
    if (!Array.isArray(input) || input.length > HELPER_AUTO_RULES_MAX) bad(`a list of at most ${HELPER_AUTO_RULES_MAX} rules {id, templateId, from, folders, note?}`);
    const ids = new Set<string>();
    return (input as unknown[]).map(raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('each rule is an object');
        const x = raw as Record<string, unknown>, extra = Object.keys(x).find(k => !['id', 'templateId', 'from', 'folders', 'note', 'by', 'at'].includes(k));
        if (extra) bad(`unknown field ${extra}`);
        const { id, templateId, from, folders, note } = x;
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id) || ids.has(id)) bad('id: 1–40 of a-z 0-9 -, each used once');
        ids.add(id as string);
        if (typeof templateId !== 'string' || !templateId || templateId.length > 80) bad(`${id}: templateId is a template id or *`);
        if (typeof from !== 'string' || !from || from.length > 80) bad(`${id}: from is a host id (the machine whose sessions ask) or *`);
        if (!Array.isArray(folders) || folders.length > HELPER_RULE_FOLDERS_MAX || !folders.every(f => f === '*' || (f !== '/' && plainPathProblem(f) === null))) bad(`${id}: folders is a list of at most ${HELPER_RULE_FOLDERS_MAX} absolute plain paths (not /), or * for any folder; empty means the template's own folder only`);
        if (note !== undefined && note !== null && (typeof note !== 'string' || Buffer.byteLength(note) > HELPER_RULE_NOTE_BYTES || /[\u0000-\u001f\u007f\u2028\u2029]/.test(note))) bad(`${id}: note is one line of at most ${HELPER_RULE_NOTE_BYTES} bytes`);
        const rule = { id: id as string, templateId: templateId as string, from: from as string, folders: [...new Set(folders as string[])], note: typeof note === 'string' && note.trim() ? note.trim() : null };
        if (!kept?.(rule)) {
            const why = rule.templateId === '*' ? null : ok.template(rule.templateId);
            if (why) bad(`${id}: template ${rule.templateId} ${why}`);
            if (rule.from !== '*' && !ok.host(rule.from)) bad(`${id}: from is a configured host id (the machine whose sessions ask) or *`);
        }
        return rule;
    });
}
/** The same folder, or one inside the other, whatever the letter case (a disk that ignores case treats them as one place). */
export const foldersOverlap = (a: string, b: string) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`); };
/** The title of a helper session: the template's in the template's folder, else one that says where it works. */
export const helperTitle = (templateTitle: string, provider: string, cwd: string, customCwd: boolean) => customCwd ? `Helper · ${basename(cwd)} (${provider.split('/')[0]})` : templateTitle;
/** A request in a few words: its id and what it is for (else how its task begins). */
export const helperLabel = (r: Pick<HelperRequest, 'id' | 'purpose' | 'task'>) => { const first = r.task.split('\n')[0].trim(); return `${r.id} (${r.purpose ?? (first.length > 60 ? `${first.slice(0, 59)}…` : first)})`; };
/** What the helper session is sent: where the task comes from and where its answer goes, then the task as it was approved. */
export const helperPrompt = (r: Pick<HelperRequest, 'memberName' | 'fromHostId' | 'task'>) => `[Router] A task from another session of the owner (${r.memberName} on ${r.fromHostId}), approved by the owner. Your final message goes back to that session as the result (at most 8 KB of it), so put the whole answer there.\n\n${r.task}`;
