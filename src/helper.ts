/** Helpers (幫手): a local session asks for a Paseo session to do one task where it cannot go itself (another machine, another
 * folder there) and gets the result back. A request does nothing by itself: the owner sees it in the console (who asks, which
 * machine and folder, which model and permission mode, the whole task) and approves or rejects it. Approved, the Router
 * creates the session from the template the request names, in that template's folder or in the folder the request names
 * (where the daemon's autoMap covers it), and sends it the task as the owner's: so it queues, locks and asks for approvals
 * like any task of the owner. When the task ends the requester is told with a Router notice between its turns and reads the
 * whole result with psr_local_helper_result. A follow-up to the same helper session is a request again, approved again.
 * Sessions the Router dispatches do not ask for helpers: they hand work on (psr_ask, the planner). This module holds the
 * types and bounds; core.ts applies them. */
import { basename } from 'node:path';
import { checkableCheckout } from './arbiter.js';
import { isAgentHome } from './local.js';

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
}

/** Why a request may not name this folder, or null: it must be absolute and plain (no empty, . or .. part, no trailing slash,
 * no control character), not inside a hidden folder (~/.ssh, a .git, a .venv: no project, and often secrets), narrow enough
 * to be one project's (not /, a top-level directory or a whole home directory) and not an agent's own home (~/.claude,
 * ~/.codex; a worktree below one is a project). */
export function helperFolderProblem(cwd: unknown): string | null {
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) return 'cwd must be an absolute path';
    if (Buffer.byteLength(cwd) > HELPER_CWD_BYTES || /[\u0000-\u001f\u007f\u2028\u2029]/.test(cwd)) return `cwd: at most ${HELPER_CWD_BYTES} bytes and no control characters`;
    if (cwd !== '/' && cwd.slice(1).split('/').some(part => part === '' || part === '.' || part === '..')) return 'cwd must be a plain path: no trailing slash and no empty, . or .. part';
    const hidden = cwd.slice(1).split('/').find(part => part.startsWith('.') && part !== '.claude' && part !== '.codex');
    if (hidden) return `${cwd} is inside a hidden folder (${hidden}), not a project`;
    if (!checkableCheckout(cwd)) return `${cwd} is too wide to be one project's folder (/, a top-level directory or a whole home directory)`;
    if (isAgentHome(cwd)) return `${cwd} is an agent's own home folder, not a project`;
    return null;
}
/** The same folder, or one inside the other, whatever the letter case (a disk that ignores case treats them as one place). */
export const foldersOverlap = (a: string, b: string) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`); };
/** The title of a helper session: the template's in the template's folder, else one that says where it works. */
export const helperTitle = (templateTitle: string, provider: string, cwd: string, customCwd: boolean) => customCwd ? `Helper · ${basename(cwd)} (${provider.split('/')[0]})` : templateTitle;
/** A request in a few words: its id and what it is for (else how its task begins). */
export const helperLabel = (r: Pick<HelperRequest, 'id' | 'purpose' | 'task'>) => { const first = r.task.split('\n')[0].trim(); return `${r.id} (${r.purpose ?? (first.length > 60 ? `${first.slice(0, 59)}…` : first)})`; };
/** What the helper session is sent: where the task comes from and where its answer goes, then the task as it was approved. */
export const helperPrompt = (r: Pick<HelperRequest, 'memberName' | 'fromHostId' | 'task'>) => `[Router] A task from another session of the owner (${r.memberName} on ${r.fromHostId}), approved by the owner. Your final message goes back to that session as the result (at most 8 KB of it), so put the whole answer there.\n\n${r.task}`;
