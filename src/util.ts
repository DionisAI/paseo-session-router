import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import type { Principal, Session } from './types.js';
export class Fault extends Error {
    constructor(public code: string, message: string, public status = 400, public details?: unknown) { super(message); this.name = 'Fault'; }
}
export function assert(value: unknown, code: string, message: string, status = 400): asserts value { if (!value)
    throw new Fault(code, message, status); }
export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
/** Mask what looks like a credential in a short line shown to people: NAME=value for key/token/secret/password names, bearer
 * and basic auth, passwords in URLs, signed tokens (JWT, the Router's own) and long opaque strings, except opaque strings the
 * same readers can already see (visible). A best-effort courtesy for display, not a security boundary. */
export function redact(text: string, visible = ''): string {
    const opaque = (m: string) => visible.includes(m) ? m : '…';
    // a relative folder path (some segment a plain lower-case word) is not a key, even when it is long and mixed-case
    const folder = (m: string) => m.includes('/') && m.split('/').some(seg => /^[a-z]{3,}$/.test(seg));
    return text.replace(/\b([A-Za-z0-9_]*(?:key|token|secret|passw(?:or)?d|passphrase|mnemonic|pwd|credential)[A-Za-z0-9_]*)("?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2…')
        .replace(/\b(bearer)\s+\S+/gi, '$1 …').replace(/\b([Bb]asic|BASIC)\s+(?=[A-Za-z0-9+/]*(?:[\d+/=]|[a-z][A-Z]))[A-Za-z0-9+/]{8,}={0,2}(?![\w+/=])/g, '$1 …')
        .replace(/(?<![\w+.-])([a-z][\w+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1…@').replace(/eyJ[\w-]{10,}\.[\w-]{10,}(?:\.[\w-]+)?/g, '…')
        .replace(/(?<![\w/.-])[A-Za-z0-9+_-]{32,}={0,2}(?![\w/.-])/g, opaque)
        .replace(/(?<![\w/+.-])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+][A-Za-z0-9+/]{31,}={0,2}(?![\w/+.-])/g, m => folder(m) ? m : opaque(m));
}
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function stable(x: unknown): string { if (Array.isArray(x))
    return `[${x.map(stable).join(',')}]`; if (x && typeof x === 'object')
    return `{${Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stable((x as Record<string, unknown>)[k])).join(',')}}`; return JSON.stringify(x) ?? 'null'; }
export const authFingerprint = (p: Principal) => hash(stable(p));
export const sessionFingerprint = (s: Session) => hash(stable({ id: s.id, daemon: s.daemonId, incarnation: s.incarnation, native: s.nativeId, cwd: s.cwd, domain: s.domainId, project: s.projectId }));
export function signed(secret: string, payload: object): string { const b = Buffer.from(JSON.stringify(payload)).toString('base64url'); return b + '.' + createHmac('sha256', secret).update(b).digest('base64url'); }
export function verifySigned<T>(secret: string, token: string): T { assert(typeof token === 'string' && token.length <= 16000, 'BAD_TICKET', 'Invalid signed token'); const [b, mac, ...rest] = token.split('.'); assert(b && mac && rest.length === 0, 'BAD_TICKET', 'Malformed signed token'); const expected = createHmac('sha256', secret).update(b).digest(); let given: Buffer; try {
    given = Buffer.from(mac, 'base64url');
}
catch {
    throw new Fault('BAD_TICKET', 'Malformed signature');
} assert(given.length === expected.length && timingSafeEqual(given, expected), 'BAD_TICKET', 'Invalid signature', 403); try {
    return JSON.parse(Buffer.from(b, 'base64url').toString('utf8')) as T;
}
catch {
    throw new Fault('BAD_TICKET', 'Malformed payload');
} }
export function canRead(p: Principal, project: string | null, host: string | null): boolean { return (p.projects.includes('*') || (project !== null && p.projects.includes(project))) && (host === null || p.hosts.includes('*') || p.hosts.includes(host)); }
export function requireScope(p: Principal, scope: string): void { assert(p.scopes.includes(scope) || p.scopes.includes('admin'), 'FORBIDDEN', `Missing scope: ${scope}`, 403); }
export function requireRead(p: Principal, project: string | null, host: string | null): void { requireScope(p, 'read'); assert(canRead(p, project, host), 'NOT_FOUND', 'Resource not found', 404); }
export function truncateBytes(s: string, max: number): string { if (Buffer.byteLength(s) <= max)
    return s; let result = Buffer.from(s).subarray(0, max).toString('utf8'); if (result.endsWith('\uFFFD'))
    result = result.slice(0, -1); return result; }
export function errorMessage(e: unknown): string { return e instanceof Error ? e.message : String(e); }
export async function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Fault('TIMEOUT', `${label} exceeded its observation deadline`, 503)), ms); })]);
}
finally {
    if (timer)
        clearTimeout(timer);
} }
/** Administrator-defined executable only. Inputs are JSON on stdin, never shell interpolation. */
export async function runJsonCommand(command: string, args: string[], input: unknown, timeoutMs = 5000, maxBytes = 128 * 1024): Promise<string> { return new Promise((resolve, reject) => { const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: process.env }); let out = Buffer.alloc(0), err = Buffer.alloc(0), settled = false; const fail = (e: Error) => { if (settled)
    return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); reject(e); }; const timer = setTimeout(() => fail(new Fault('TIMEOUT', 'Configured probe timed out', 503)), timeoutMs); child.on('error', fail); child.stdout.on('data', (b: Buffer) => { out = Buffer.concat([out, b]); if (out.length > maxBytes)
    fail(new Fault('PROBE_TOO_LARGE', 'Probe response exceeded limit', 503)); }); child.stderr.on('data', (b: Buffer) => { err = Buffer.concat([err, b]).subarray(0, 2048); }); child.on('close', code => { if (settled)
    return; settled = true; clearTimeout(timer); if (code !== 0)
    reject(new Fault('PROBE_FAILED', `Configured probe exited with status ${code}`, 503));
else
    resolve(out.toString('utf8').trim()); }); child.stdin.on('error', () => { }); child.stdin.end(JSON.stringify(input)); }); }
/** A trusted check the owner configured: JSON on stdin, no shell, only PATH/HOME/LANG in its environment (never the Router's
 * tokens). Exit 0 = pass, 1 = fail, 2 = malformed input, each with its output; anything else (or a timeout) is an error. */
export async function runVerifier(command: string, args: string[], input: unknown, timeoutMs: number, maxBytes = 16 * 1024): Promise<{ exitCode: 0 | 1 | 2; output: string }> { return new Promise((resolve, reject) => {
    const env: Record<string, string> = {}; for (const k of ['PATH', 'HOME', 'LANG']) if (process.env[k]) env[k] = process.env[k]!;
    const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env }); let out = Buffer.alloc(0), settled = false;
    const fail = (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); child.kill('SIGKILL'); reject(e); };
    const timer = setTimeout(() => fail(new Fault('TIMEOUT', 'Verifier timed out', 503)), timeoutMs);
    child.on('error', fail); child.stdout.on('data', (b: Buffer) => { out = Buffer.concat([out, b]).subarray(0, maxBytes); }); child.stderr.on('data', () => { });
    child.on('close', code => { if (settled) return; settled = true; clearTimeout(timer); if (code === 0 || code === 1 || code === 2) resolve({ exitCode: code, output: out.toString('utf8').trim() }); else reject(new Fault('VERIFIER_FAILED', `Verifier exited with status ${code}`, 503)); });
    child.stdin.on('error', () => { }); child.stdin.end(JSON.stringify(input));
}); }
export function strictObject(x: unknown): Record<string, unknown> { assert(!!x && typeof x === 'object' && !Array.isArray(x), 'INVALID_ARGUMENT', 'Expected an object'); return x as Record<string, unknown>; }
export function stringField(o: Record<string, unknown>, k: string, max = 4096, optional = false): string | undefined { const v = o[k]; if (optional && v === undefined)
    return; assert(typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= max, 'INVALID_ARGUMENT', `Invalid ${k}`); return v; }
/** A loopback URL: whoever uses it runs on the same machine as the server it names. */
export function isLoopback(url: string | undefined) { try { const h = new URL(url ?? '').hostname; return h === 'localhost' || h === '[::1]' || /^127\./.test(h); } catch { return false; } }
/** This machine now: CPUs, load averages and memory in MB (available is Linux's MemAvailable; elsewhere the OS's free
 * memory), and swap where /proc/meminfo exists. */
export function machineNow() {
    const mb = (bytes: number) => Math.round(bytes / 1048576);
    let swap: { totalMb: number; usedMb: number } | null = null;
    try {
        const m = readFileSync('/proc/meminfo', 'utf8'), kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(m)?.[1]);
        const total = kb('SwapTotal'), free = kb('SwapFree');
        if (Number.isFinite(total) && Number.isFinite(free)) swap = { totalMb: Math.round(total / 1024), usedMb: Math.round((total - free) / 1024) };
    }
    catch { /* not Linux: no swap figures */ }
    return { cpus: availableParallelism(), load: loadavg().map(x => Math.round(x * 100) / 100), memory: { totalMb: mb(totalmem()), availableMb: mb(freemem()) }, swap };
}
