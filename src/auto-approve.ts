/** Auto-approval (自動批准): the owner's standing answer to permission requests, so that not every one waits in the console.
 * Sessions go on asking as before; on each tick the Router allows, in code, the requests the owner's setting covers and leaves
 * the rest to whoever answers them today (the owner, and the planner and front-ends at the levels the owner gave them).
 * Two reaches: an ordinary one for every task (at most L2), and a dangerous one (L3 or L4) only for tasks whose instruction
 * came from a source the owner trusts: a client (the console, the CLI, a front-end), or a machine whose local sessions ask
 * for helpers. Which source a task has is core.ts's to say: a helper's task is its asker's machine, never who approved its
 * start; a task the planner sends is nobody's (the planner reads every client's goals and every session's results), and so
 * is a turn the Router wrote in a client's name around another agent's words (the answers of a service, a resource's turn).
 * Never, whatever is set: on an owner-only machine; a turn the Router sends itself (arbiter, service: they have their own
 * rules); a request that is not the task's own turn's; a request shown cut short; a deny. A credential or key is allowed only
 * when the owner said so separately, and one task gets only so many dangerous requests allowed (a session caught in a loop
 * cannot restart a service without end).
 * This module holds the setting, its check and the decision on one request; core.ts applies them. */
import { isSecret, rank, SECRET_RULE, type Classification, type Level } from './policy.js';
import { Fault } from './util.js';

/** The ordinary reach stops at L2; dangerous is L3 and L4. */
export const AUTO_ALL_LEVELS: readonly Level[] = ['L0', 'L1', 'L2'], AUTO_TRUSTED_LEVELS: readonly Level[] = ['L3', 'L4'];
/** Dangerous requests (L3 and above) the Router allows by itself in one task; the rest of them wait for the owner. */
export const AUTO_DANGER_PER_TASK = 30;
export const AUTO_SOURCES_MAX = 40, AUTO_HOURS_MAX = 168;

/** all: every task's requests up to this level; trusted: a trusted source's tasks up to this one (both null: off).
 * sources: `client:<clientId>` or `helper:<hostId>`. secrets: a credential or key counts like any other L4 request.
 * until: when it ends by itself (null: it stays until changed). */
export interface AutoApprove { all: Level | null; trusted: Level | null; sources: string[]; secrets: boolean; until: number | null }
export const AUTO_OFF: AutoApprove = { all: null, trusted: null, sources: [], secrets: false, until: null };
export const autoActive = (a: AutoApprove, now: number) => (a.all !== null || a.trusted !== null) && (a.until === null || a.until > now);

/** The owner's setting as sent, field by field, on top of the stored one. hours: how long from now (null: no end); left out,
 * the end stays where it was. A source must be one the Router offers (choices), or one already stored: such a source may have
 * left the configuration since (it trusts nobody then) and never stands in the way of another change, or of removing it. */
export function checkAutoApprove(input: unknown, stored: AutoApprove, choices: readonly string[], now: number): AutoApprove {
    const bad = (why: string): never => { throw new Fault('INVALID_ARGUMENT', `autoApprove: ${why}`); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) bad('an object {all?, trusted?, sources?, secrets?, hours?}');
    const x = input as Record<string, unknown>, extra = Object.keys(x).find(k => !['all', 'trusted', 'sources', 'secrets', 'hours'].includes(k));
    if (extra) bad(`unknown field ${extra}`);
    const next = { ...stored, sources: [...stored.sources] };
    const level = (v: unknown, among: readonly Level[], name: string) => { if (v !== null && !among.includes(v as Level)) bad(`${name} is ${among.join(', ')} or null (off)`); return v as Level | null; };
    if (x.all !== undefined) next.all = level(x.all, AUTO_ALL_LEVELS, 'all (every task)');
    if (x.trusted !== undefined) next.trusted = level(x.trusted, AUTO_TRUSTED_LEVELS, 'trusted (tasks of the trusted sources)');
    if (x.sources !== undefined) {
        const s = x.sources;
        if (!Array.isArray(s) || s.length > AUTO_SOURCES_MAX || !s.every(v => typeof v === 'string' && (choices.includes(v) || stored.sources.includes(v)))) bad(`sources is a list of at most ${AUTO_SOURCES_MAX} of: ${choices.join(', ')}`);
        next.sources = [...new Set(s as string[])];
    }
    if (x.secrets !== undefined) { if (typeof x.secrets !== 'boolean') bad('secrets is true or false'); next.secrets = x.secrets as boolean; }
    if (x.hours !== undefined) {
        const h = x.hours;
        if (h !== null && !(typeof h === 'number' && Number.isFinite(h) && h > 0 && h <= AUTO_HOURS_MAX)) bad(`hours is a number of hours from now, at most ${AUTO_HOURS_MAX}, or null for no end`);
        next.until = h === null ? null : now + Math.round((h as number) * 3600000);
    }
    // off forgets who was trusted, the credentials flag and the period: a later partial change cannot bring them back unseen
    return next.all === null && next.trusted === null ? { ...AUTO_OFF, sources: [] } : next;
}

/** Why one request is not allowed by itself: source (its level is within the dangerous reach, but the task's source is not
 * trusted), level (above what is set), truncated (shown cut short: what was cut may be anything), secret (a credential or key,
 * and the owner did not include those), cap (this task already had its share of dangerous ones). null: allowed. */
export type AutoWhy = 'source' | 'level' | 'truncated' | 'secret' | 'cap';
export function autoDecision(c: Pick<Classification, 'level'>, a: AutoApprove, trusted: boolean, at: { truncated: boolean; secret: boolean; dangerUsed: number }): AutoWhy | null {
    const reach = trusted && a.trusted ? a.trusted : a.all;
    if (!reach || rank(c.level) > rank(reach)) return !trusted && a.trusted && rank(c.level) <= rank(a.trusted) ? 'source' : 'level';
    if (at.truncated) return 'truncated';
    if (at.secret && !(a.secrets && trusted && a.trusted === 'L4')) return 'secret';
    if (rank(c.level) >= rank('L3') && at.dangerUsed >= AUTO_DANGER_PER_TASK) return 'cap';
    return null;
}
/** Whether a request touches a credential or key: by the classification, and by the text itself, so that it holds when the
 * owner switched the built-in secret rule off (the request then ranks as any other, and is still not the Router's to allow). */
export const touchesSecret = (c: Pick<Classification, 'steps'>, detail: string | null | undefined) => c.steps.some(v => v.ruleId === SECRET_RULE.id) || isSecret(String(detail ?? ''));
/** Paseo cuts a request at 2000 characters for display and ends it with …: what was cut may name anything. */
export const cutShort = (detail: string | null | undefined) => String(detail ?? '').trim().endsWith('…');
/** What the record of an allowed request names: the ordinary reach where that covers it, else the trusted source. */
export const autoRule = (level: Level, a: AutoApprove, source: string | null) => `auto:${a.all && rank(level) <= rank(a.all) ? 'all' : source}`;
