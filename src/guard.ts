import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { Fault } from './util.js';
/** Separate OS-backed SQLite exclusive lock: automatically released after a real process crash.
 * Not a lease and not a distributed leader-election mechanism. Never put this on NFS.
 */
export class ProcessGuard {
    private db: DatabaseSync;
    constructor(path: string) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); this.db = new DatabaseSync(path); try {
        this.db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS guard(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');
        chmodSync(path, 0o600);
    }
    catch {
        this.db.close();
        throw new Fault('CONTROLLER_ALREADY_RUNNING', 'Another controller owns this local data directory. Do not run multiple active controllers.', 409);
    } }
    close() { this.db.exec('ROLLBACK'); this.db.close(); }
}
