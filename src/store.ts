import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Fault, assert } from './util.js';
import type { Task } from './types.js';
export interface EntityRow<T = unknown> {
    kind: string;
    id: string;
    projectId: string | null;
    hostId: string | null;
    version: number;
    data: T;
}
export interface Change {
    seq: number;
    kind: string;
    entityId: string;
    projectId: string | null;
    hostId: string | null;
    version: number;
    at: number;
    operation: string;
}
/** All writes and invalidation events use the same synchronous transaction. No network awaits inside a transaction. */
export class Store {
    readonly db: DatabaseSync;
    private inTransaction = false;
    constructor(public path: string) {
        if (path !== ':memory:') {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        }
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,projectId TEXT,hostId TEXT,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,state TEXT NOT NULL,target TEXT NOT NULL,domainId TEXT NOT NULL,clientId TEXT NOT NULL,idempotencyKey TEXT NOT NULL,payloadHash TEXT NOT NULL,projectId TEXT,hostId TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(clientId,idempotencyKey));
 CREATE INDEX IF NOT EXISTS task_state ON tasks(state,createdAt);
 CREATE TABLE IF NOT EXISTS mutation_locks(domainId TEXT PRIMARY KEY,taskId TEXT UNIQUE NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,acquiredAt INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,entityId TEXT NOT NULL,projectId TEXT,hostId TEXT,version INTEGER NOT NULL,at INTEGER NOT NULL,operation TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS consumers(clientId TEXT PRIMARY KEY,seq INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
 `);
        if (path !== ':memory:')
            chmodSync(path, 0o600);
        if (!this.meta('signingSecret'))
            this.setMeta('signingSecret', randomBytes(32).toString('base64url'));
    }
    meta(key: string): string | undefined { return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {
        value: string;
    } | undefined)?.value; }
    setMeta(key: string, value: string) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
    tx<T>(f: () => T): T { if (this.inTransaction)
        return f(); this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true; try {
        const result = f();
        assert(!(result instanceof Promise), 'INTERNAL', 'Async transaction forbidden', 500);
        this.db.exec('COMMIT');
        return result;
    }
    catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
    }
    finally {
        this.inTransaction = false;
    } }
    get<T>(kind: string, id: string): T | undefined { const r = this.db.prepare('SELECT data FROM entities WHERE kind=? AND id=?').get(kind, id) as {
        data: string;
    } | undefined; return r ? JSON.parse(r.data) as T : undefined; }
    all<T>(kind: string): T[] { return (this.db.prepare('SELECT data FROM entities WHERE kind=? ORDER BY id').all(kind) as unknown as {
        data: string;
    }[]).map(r => JSON.parse(r.data) as T); }
    rows<T>(kind: string): EntityRow<T>[] { return (this.db.prepare('SELECT * FROM entities WHERE kind=? ORDER BY id').all(kind) as unknown as (Omit<EntityRow<T>, 'data'> & {
        data: string;
    })[]).map(r => ({ ...r, data: JSON.parse(r.data) })); }
    put<T extends object>(kind: string, id: string, data: T, projectId: string | null = null, hostId: string | null = null, at = Date.now()): T { return this.tx(() => { const old = this.db.prepare('SELECT version FROM entities WHERE kind=? AND id=?').get(kind, id) as {
        version: number;
    } | undefined; const version = (old?.version ?? 0) + 1; const value = { ...data, version }; this.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET projectId=excluded.projectId,hostId=excluded.hostId,version=excluded.version,data=excluded.data').run(kind, id, projectId, hostId, version, JSON.stringify(value)); this.emit(kind, id, projectId, hostId, version, at, 'upsert'); return value; }); }
    remove(kind: string, id: string, at = Date.now()): void { this.tx(() => { const row = this.db.prepare('SELECT * FROM entities WHERE kind=? AND id=?').get(kind, id) as EntityRow | undefined; if (!row)
        return; this.db.prepare('DELETE FROM entities WHERE kind=? AND id=?').run(kind, id); this.emit(kind, id, row.projectId, row.hostId, row.version + 1, at, 'remove'); }); }
    task(id: string): Task | undefined { const r = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id) as {
        data: string;
    } | undefined; return r ? JSON.parse(r.data) : undefined; }
    tasks(): Task[] { return (this.db.prepare('SELECT data FROM tasks ORDER BY createdAt,rowid').all() as unknown as {
        data: string;
    }[]).map(r => JSON.parse(r.data)); }
    byKey(clientId: string, key: string): Task | undefined { const r = this.db.prepare('SELECT data FROM tasks WHERE clientId=? AND idempotencyKey=?').get(clientId, key) as {
        data: string;
    } | undefined; return r ? JSON.parse(r.data) : undefined; }
    putTask(t: Task, at?: number): Task { return this.tx(() => { const old = this.task(t.id); const result = { ...t, version: (old?.version ?? 0) + 1 }; this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updatedAt=excluded.updatedAt,data=excluded.data').run(result.id, result.state, result.target, result.domainId, result.originClientId, result.idempotencyKey, result.payloadHash, result.projectId, result.hostId, result.createdAt, result.updatedAt, JSON.stringify(result)); this.emit('task', t.id, t.projectId, t.hostId, result.version, at ?? t.updatedAt, 'upsert'); return result; }); }
    removeTask(t: Task, at: number): void { this.tx(() => { assert(!this.lock(t.domainId) || this.lock(t.domainId) !== t.id, 'LOCK_HELD', 'Cannot delete a task holding a mutation lock'); this.db.prepare('DELETE FROM tasks WHERE id=?').run(t.id); this.emit('task', t.id, t.projectId, t.hostId, t.version + 1, at, 'remove'); }); }
    lock(domain: string): string | undefined { return (this.db.prepare('SELECT taskId FROM mutation_locks WHERE domainId=?').get(domain) as {
        taskId: string;
    } | undefined)?.taskId; }
    acquire(domain: string, taskId: string, at: number): boolean { const r = this.db.prepare('INSERT OR IGNORE INTO mutation_locks VALUES(?,?,?)').run(domain, taskId, at); return Number(r.changes) === 1; }
    release(domain: string, taskId: string) { this.db.prepare('DELETE FROM mutation_locks WHERE domainId=? AND taskId=?').run(domain, taskId); }
    emit(kind: string, entityId: string, projectId: string | null, hostId: string | null, version: number, at: number, operation: string) { this.db.prepare('INSERT INTO outbox(kind,entityId,projectId,hostId,version,at,operation) VALUES(?,?,?,?,?,?,?)').run(kind, entityId, projectId, hostId, version, at, operation); }
    watermark(): number { return Number((this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='outbox'").get() as {
        seq: number;
    } | undefined)?.seq ?? 0); }
    minSeq(): number { return Number((this.db.prepare('SELECT MIN(seq) AS seq FROM outbox').get() as {
        seq: number | null;
    }).seq ?? (this.watermark() + 1)); }
    events(after: number, limit: number): Change[] { return this.db.prepare('SELECT * FROM outbox WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit) as unknown as Change[]; }
    ack(clientId: string, seq: number, at: number) { this.db.prepare('INSERT INTO consumers VALUES(?,?,?) ON CONFLICT(clientId) DO UPDATE SET seq=MAX(seq,excluded.seq),updatedAt=excluded.updatedAt').run(clientId, seq, at); }
    offset(clientId: string): number { return Number((this.db.prepare('SELECT seq FROM consumers WHERE clientId=?').get(clientId) as {
        seq: number;
    } | undefined)?.seq ?? 0); }
    pruneOutbox(max: number, olderThan: number) { this.tx(() => { this.db.prepare('DELETE FROM outbox WHERE at<? OR seq<=?').run(olderThan, Math.max(0, this.watermark() - max)); }); }
    close() { this.db.close(); }
}
