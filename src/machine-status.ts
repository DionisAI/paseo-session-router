/** Machine status (機器狀態): what each machine says about itself, for the console and for planners: CPUs and how busy they
 * are, load, memory, swap, the space on its disks, how long it has been up.
 * The Router has no shell on any machine and the Paseo daemon reports none of this, so each machine runs a small reporter
 * (integrations/status/psr-stat.py) that sends these figures once a minute to POST /local/stat. It speaks with a status
 * credential (psrs_…): bound to one machine, good for that one call and nothing else. It opens no tool, no MCP session, no
 * event stream, and the Router sends nothing back through it. So a machine only the owner approves on may have one too: it
 * lets figures out and nothing in.
 * A report is data from a machine: every field is checked (unknown fields refused, numbers bounded, a mount point a plain
 * absolute path), since people and agents read it. The Router keeps the last report of each machine in memory only; a report
 * older than three minutes is shown as stale, and after a day the machine is as one that never reported.
 * This module holds the report's shape, its check and what counts as a problem; core.ts applies them. */
import { Fault } from './util.js';

export const STAT_TOKEN_PREFIX = 'psrs_';
export const STAT_CREDENTIAL_DAYS = 365;
/** A machine's reports closer together than this are refused; the reporter sends one a minute. */
export const STAT_MIN_INTERVAL_MS = 10000;
/** No report for this long: the last one is shown as stale. After STAT_FORGET_MS it is dropped. */
export const STAT_STALE_MS = 180000, STAT_FORGET_MS = 86400000;
/** One report as sent, and how many disks it may name. */
export const STAT_REPORT_BYTES = 8192, STAT_DISKS_MAX = 16;
/** A mount point: an absolute path of plain characters (letters, digits, _ . -), no empty, . or .. part, and short, as mount
 * points are: it is the one piece of text a machine can put before the people and agents who read its figures. */
const MOUNT = /^\/(?:[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)?$/, MOUNT_BYTES = 64;
/** Used space of a disk, memory still available (both in percent) and the 5-minute load for each CPU from which a machine
 * is shown as needing a look (warn) or in trouble (danger). */
export const STAT_LIMITS = { diskWarn: 85, diskDanger: 95, memoryWarn: 10, memoryDanger: 5, loadWarn: 1.5, loadDanger: 3 } as const;

export interface StatCredential { id: string; hostId: string; createdAt: number; exp: number; by: string }
export interface MachineDisk { mount: string; totalMb: number; availableMb: number }
/** v: the report's format (1). cpuPct: how busy the CPUs were since the last report, in percent. load: 1, 5 and 15 minutes.
 * null: this machine cannot tell. */
export interface MachineReport {
    v: 1;
    cpus: number;
    cpuPct: number | null;
    load: [number, number, number];
    memory: { totalMb: number; availableMb: number };
    swap: { totalMb: number; usedMb: number } | null;
    disks: MachineDisk[];
    uptimeSec: number | null;
}
export type MachineAlert = { kind: 'disk'; level: 'warn' | 'danger'; mount: string; pct: number } | { kind: 'memory'; level: 'warn' | 'danger'; pct: number } | { kind: 'load'; level: 'warn' | 'danger'; perCpu: number };

const bad = (why: string): never => { throw new Fault('INVALID_ARGUMENT', `machine report: ${why}`, 400); };
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const fields = (x: Record<string, unknown>, names: readonly string[], where: string) => {
    const extra = Object.keys(x).find(k => !names.includes(k)), missing = names.find(k => !(k in x));
    if (extra) bad(`unknown field ${where}${extra.slice(0, 40)}`);
    if (missing) bad(`${where}${missing} is missing`);
};
const int = (v: unknown, min: number, max: number, name: string) => { if (!(typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max)) bad(`${name} is a whole number ${min}..${max}`); return v as number; };
const num = (v: unknown, min: number, max: number, name: string) => { if (!(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max)) bad(`${name} is a number ${min}..${max}`); return v as number; };
/** Megabytes up to an exabyte: more than any machine has, small enough to stay an exact number. */
const MB_MAX = 1e12;

/** One report as a machine sent it, field by field; what comes back holds nothing else. */
export function checkMachineReport(input: unknown): MachineReport {
    if (!isObject(input)) bad('a JSON object {v, cpus, cpuPct, load, memory, swap, disks, uptimeSec}');
    const x = input as Record<string, unknown>;
    fields(x, ['v', 'cpus', 'cpuPct', 'load', 'memory', 'swap', 'disks', 'uptimeSec'], '');
    if (x.v !== 1) bad('v is 1 (this Router reads format 1)');
    const cpus = int(x.cpus, 1, 4096, 'cpus'), cpuPct = x.cpuPct === null ? null : num(x.cpuPct, 0, 100, 'cpuPct');
    if (!Array.isArray(x.load) || x.load.length !== 3) bad('load is three numbers (1, 5 and 15 minutes)');
    const load = (x.load as unknown[]).map(v => num(v, 0, 1e6, 'load')) as [number, number, number];
    if (!isObject(x.memory)) bad('memory is {totalMb, availableMb}');
    const mem = x.memory as Record<string, unknown>; fields(mem, ['totalMb', 'availableMb'], 'memory.');
    const memory = { totalMb: int(mem.totalMb, 1, MB_MAX, 'memory.totalMb'), availableMb: int(mem.availableMb, 0, MB_MAX, 'memory.availableMb') };
    if (memory.availableMb > memory.totalMb) bad('memory.availableMb is at most memory.totalMb');
    let swap: MachineReport['swap'] = null;
    if (x.swap !== null) {
        if (!isObject(x.swap)) bad('swap is {totalMb, usedMb} or null');
        const s = x.swap as Record<string, unknown>; fields(s, ['totalMb', 'usedMb'], 'swap.');
        swap = { totalMb: int(s.totalMb, 0, MB_MAX, 'swap.totalMb'), usedMb: int(s.usedMb, 0, MB_MAX, 'swap.usedMb') };
        if (swap.usedMb > swap.totalMb) bad('swap.usedMb is at most swap.totalMb');
    }
    if (!Array.isArray(x.disks) || x.disks.length > STAT_DISKS_MAX) bad(`disks is a list of at most ${STAT_DISKS_MAX} {mount, totalMb, availableMb}`);
    const seen = new Set<string>();
    const disks = (x.disks as unknown[]).map(raw => {
        if (!isObject(raw)) bad('each disk is {mount, totalMb, availableMb}');
        const d = raw as Record<string, unknown>; fields(d, ['mount', 'totalMb', 'availableMb'], 'disk.');
        const mount = d.mount;
        if (typeof mount !== 'string' || mount.length > MOUNT_BYTES || !MOUNT.test(mount) || mount.split('/').some(part => part === '.' || part === '..')) bad('disk.mount is a plain absolute path: letters, digits, _ . - and /, at most 64 characters');
        if (seen.has(mount as string)) bad('each mount is named once');
        seen.add(mount as string);
        const disk = { mount: mount as string, totalMb: int(d.totalMb, 1, MB_MAX, 'disk.totalMb'), availableMb: int(d.availableMb, 0, MB_MAX, 'disk.availableMb') };
        if (disk.availableMb > disk.totalMb) bad('disk.availableMb is at most disk.totalMb');
        return disk;
    });
    const uptimeSec = x.uptimeSec === null ? null : int(x.uptimeSec, 0, 1e10, 'uptimeSec');
    return { v: 1, cpus, cpuPct, load, memory, swap, disks, uptimeSec };
}

/** Used space of a disk in whole percent, a part of a percent counting as a whole one: what df shows. */
export const diskUsedPct = (d: Pick<MachineDisk, 'totalMb' | 'availableMb'>) => Math.ceil((d.totalMb - d.availableMb) * 100 / d.totalMb);
/** What needs a look on a machine, disks first, and the worst of it as the machine's state. Judged on the whole percent that
 * is shown, so a bar that reads 85% is also the one that warns. CPU use and swap are shown, never an alert. judge.memory false:
 * the memory figure is not one to judge (see where the Router measures its own machine). */
export function machineAlerts(m: Pick<MachineReport, 'cpus' | 'load' | 'memory'> & { disks?: readonly MachineDisk[] }, judge: { memory: boolean } = { memory: true }): { state: 'ok' | 'warn' | 'danger'; alerts: MachineAlert[] } {
    const L = STAT_LIMITS, alerts: MachineAlert[] = [];
    for (const d of m.disks ?? []) { const pct = diskUsedPct(d); if (pct >= L.diskWarn) alerts.push({ kind: 'disk', level: pct >= L.diskDanger ? 'danger' : 'warn', mount: d.mount, pct }); }
    const free = Math.round(m.memory.availableMb / m.memory.totalMb * 100);
    if (judge.memory && free <= L.memoryWarn) alerts.push({ kind: 'memory', level: free <= L.memoryDanger ? 'danger' : 'warn', pct: free });
    const perCpu = Math.round(m.load[1] / m.cpus * 100) / 100;
    if (perCpu >= L.loadWarn) alerts.push({ kind: 'load', level: perCpu >= L.loadDanger ? 'danger' : 'warn', perCpu });
    return { state: alerts.some(a => a.level === 'danger') ? 'danger' : alerts.length ? 'warn' : 'ok', alerts };
}
