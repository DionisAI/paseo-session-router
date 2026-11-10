/** Shared resources (資源): what only one session (or a few) should use at a time and the Router cannot see in use by
 * itself, such as an editor or a GPU. The owner registers each with its machine and number of slots (psr_set_resource).
 * A local session takes one before using it (psr_local_take) and releases it when done (psr_local_release). Sessions that
 * find it taken wait in line in order, and the line is the only order (no note, message or forum post reserves anything);
 * the Router tells the next one between its turns when it is theirs, so nobody polls or asks around. A session that must not
 * end its turn (a goal or a loop keeps it going) waits inside it with psr_local_wait instead of looking again and again. A message to resource:<id> goes to whoever holds it, so a session never needs to know which one that is.
 * Paseo sessions the Router dispatches take resources too (psr_take, during a Router turn): one that has to wait ends its
 * turn, and the Router later sends it a turn of its own in the name of whoever assigned the waiting task (a reply to it).
 * Advisory only: it replaces no lock the machine has. This module holds the types and bounds; core.ts applies them. */

/** <host>/<name>, e.g. mac/unreal-editor: the host is a configured one, the name lower case. */
export const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}\/[a-z0-9][a-z0-9._-]{0,59}$/;
/** How a resource is named in psr_local_send's to. */
export const RESOURCE_PREFIX = 'resource:';
export const RESOURCES_MAX = 50, RESOURCE_SLOTS_MAX = 16, RESOURCE_QUEUE_MAX = 32;
export const RESOURCE_NOTE_BYTES = 120, RESOURCE_DESCRIPTION_BYTES = 300;
/** A holding has no time limit: after this long holding a resource while others wait, the holder is reminded once and
 * keeps it. (Named holdMinutes before 2026-11-05, which read like a limit.) */
export const RESOURCE_REMIND_DEFAULT_MIN = 120, RESOURCE_REMIND_MIN = 5, RESOURCE_REMIND_MAX = 1440;
/** Ended claims stay this long, then go. */
export const RESOURCE_KEEP_MS = 86400000;
/** A Router turn owed to a Paseo session (its turn in line, a reminder, the owner taking a resource back) that cannot be sent for
 * this long is given up; a turn in line then passes to the next, so nobody waits on a session that cannot be reached. */
export const RESOURCE_TURN_WAIT_MS = 30 * 60000;
/** A claim's holder is a local session (lm_…) or a Paseo session (s_…). */
export const isPaseoHolder = (id: string) => id.startsWith('s_');

export interface Resource {
    id: string;
    hostId: string;
    slots: number;
    description: string | null;
    remindAfterMinutes: number;
    /** The same setting in records written before it was renamed. */
    holdMinutes?: number;
    createdAt: number;
    updatedAt: number;
    by: string;
}
/** When a holder others wait behind is reminded, for records of either name. */
export const remindAfter = (r: Partial<Pick<Resource, 'remindAfterMinutes' | 'holdMinutes'>>) => r.remindAfterMinutes ?? r.holdMinutes ?? RESOURCE_REMIND_DEFAULT_MIN;
export interface ResourceClaim {
    id: string;
    /** Order in line: claims are served by seq. */
    seq: number;
    resourceId: string;
    /** Who took it or waits for it: a local session (member, lm_…) or a Paseo session (its ref, s_…). */
    memberId: string;
    /** A Paseo session's claim: the Router task it was taken in, and who assigned that task (the Router's turns for the claim
     * reply to it in that client's name). */
    taskId?: string | null;
    clientId?: string | null;
    /** A Router turn owed to that Paseo session, and since when; turnTaskIds: the turns sent for this claim. */
    pendingTurn?: ResourceTurn | null;
    pendingSince?: number | null;
    turnTaskIds?: string[];
    /** What it is for, in the session's own words (one masked line). */
    note: string | null;
    state: 'holding' | 'waiting' | 'released';
    requestedAt: number;
    grantedAt: number | null;
    releasedAt: number | null;
    /** released: the session gave it back; closed / silent / revoked: its session ended; owner: the owner took it back;
     * removed: the owner removed the resource; undeliverable: its turn in line could not reach that Paseo session. */
    releaseReason: 'released' | 'closed' | 'silent' | 'revoked' | 'owner' | 'removed' | 'undeliverable' | null;
    remindedAt: number | null;
}

/** grant: it is the session's turn in line; remind: others wait behind a long hold; taken: the owner took it back; removed: the
 * owner removed the resource. */
export type ResourceTurn = 'grant' | 'remind' | 'taken' | 'removed';
/** The prompt of a Router turn about a resource for a Paseo session. */
export function resourceTurnPrompt(kind: ResourceTurn, r: Pick<Resource, 'id' | 'description'>, x: { taskId: string | null; waiting: number; heldMin: number }): string {
    const what = `${r.id}${r.description ? ` (${r.description})` : ''}`;
    if (kind === 'grant') return `[Router] The shared resource ${what} is yours now: it was your turn in line${x.taskId ? ` (you asked for it in task ${x.taskId})` : ''}. Continue the work that was waiting for it. Release it with psr_release (resource "${r.id}") as soon as you are done${x.waiting ? `; ${x.waiting} waiting after you` : ''}. If you no longer need it, release it now and say so.`;
    if (kind === 'remind') return `[Router] You have held the shared resource ${what} for ${x.heldMin} minutes and ${x.waiting} session${x.waiting === 1 ? ' is' : 's are'} waiting for it. If you are done with it, release it now with psr_release (resource "${r.id}"). If not, say in one line when you expect to be, and stop there: nobody takes it from you. Do nothing else in this turn.`;
    if (kind === 'taken') return `[Router] The owner took the shared resource ${what} back from you. Stop using it now, and say in one line what you stopped. Do nothing else in this turn.`;
    return `[Router] The owner removed the shared resource ${what}; you no longer hold it through the Router. Say in one line whether anything you were doing needs it. Do nothing else in this turn.`;
}
