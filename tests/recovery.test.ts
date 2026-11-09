import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Router } from '../src/core.js';
import { Store } from '../src/store.js';
import { ProcessGuard } from '../src/guard.js';
import { fixture, principal, code } from './helpers.js';
for (const lostAck of [false, true])
    test(`restart: ${lostAck ? 'lost acknowledgement' : 'running turn'} is recovered without redispatch`, async () => {
        const f = await fixture();
        let store: Store | undefined;
        let restarted: Router | undefined;
        try {
            const a = f.demos.get('gpu-research')!;
            a.dropLive = lostAck;
            if (lostAck)
                a.fault = 'after_accept';
            const t = f.submit();
            await f.router.tick();
            const before = f.store.task(t.id)!;
            assert.equal(a.sends.length, 1);
            assert.equal(before.state, lostAck ? 'delivery_unknown' : 'running');
            assert.equal(before.observationPrepared, true);
            await f.router.close();
            f.store.close();
            a.dropLive = false;
            a.finish('agent-1');
            store = new Store(join(f.dir, 'router.sqlite'));
            restarted = new Router(f.config, store, f.adapters, f.now);
            await restarted.tick();
            assert.equal(store.task(t.id)!.state, 'completed');
            assert.equal(a.sends.length, 1);
            assert.equal(store.task(t.id)!.lockHeld, false);
            assert.ok(store.task(t.id)!.completionEvidence?.includes('turn_completed'));
        }
        finally {
            await restarted?.close();
            store?.close();
            rmSync(f.dir, { recursive: true, force: true });
        }
    });
test('restart: a task persisted as sending becomes unknown and retains its mutation lock', async () => { const f = await fixture(); let reopened: Store | undefined; let r: Router | undefined; try {
    const t = f.submit();
    f.store.tx(() => { f.store.acquire(t.domainId, t.id, f.now()); f.store.putTask({ ...t, state: 'sending', lockHeld: true, attempt: 1 }); });
    await f.router.close();
    f.store.close();
    reopened = new Store(join(f.dir, 'router.sqlite'));
    r = new Router(f.config, reopened, f.adapters, f.now);
    await r.tick();
    assert.equal(reopened.task(t.id)!.state, 'delivery_unknown');
    assert.equal(reopened.lock(t.domainId), t.id);
    assert.equal(f.demos.get('gpu-research')!.sends.length, 0);
}
finally {
    await r?.close();
    reopened?.close();
    rmSync(f.dir, { recursive: true, force: true });
} });
test('restart: queued immutable target survives alias rebind and persistence', async () => { const f = await fixture(); let s: Store | undefined; let r: Router | undefined; try {
    const t = f.submit();
    const w = f.store.get<any>('worker', 'eth-mm');
    f.router.bind(principal(), { workerId: 'eth-mm', workstreamId: 'new-binding', sessionRef: f.session('gpu-review').id, expectedRevision: 0 });
    await f.router.close();
    f.store.close();
    s = new Store(join(f.dir, 'router.sqlite'));
    r = new Router(f.config, s, f.adapters, f.now);
    await r.tick();
    assert.equal(s.task(t.id)!.target, t.target);
    assert.equal(f.demos.get('gpu-research')!.sends.length, 1);
    assert.equal(f.demos.get('gpu-review')!.sends.length, 0);
}
finally {
    await r?.close();
    s?.close();
    rmSync(f.dir, { recursive: true, force: true });
} });
test('process guard: a second controller cannot acquire the same local directory', () => { const dir = mkdtempSync(join(tmpdir(), 'psr-guard-')); const g = new ProcessGuard(join(dir, 'guard.sqlite')); try {
    assert.throws(() => new ProcessGuard(join(dir, 'guard.sqlite')), code('CONTROLLER_ALREADY_RUNNING'));
}
finally {
    g.close();
    rmSync(dir, { recursive: true, force: true });
} });
test('process guard: OS releases the exclusive lock after actual SIGKILL', async () => { const dir = mkdtempSync(join(tmpdir(), 'psr-crash-')); const path = join(dir, 'guard.sqlite'); const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `import {ProcessGuard} from ${JSON.stringify(new URL('../src/guard.js', import.meta.url).href)};globalThis.__processGuard=new ProcessGuard(${JSON.stringify(path)});console.log('READY');setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] }); try {
    // Wait for the exact post-lock sentinel, not arbitrary first stdout bytes.
    await new Promise<void>((resolve, reject) => { let output='';const timer=setTimeout(()=>reject(new Error('Child lock timed out')),5000);child.stdout!.on('data',chunk=>{output+=chunk.toString();if(output.includes('READY\n')){clearTimeout(timer);resolve();}});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Child exited before lock-ready confirmation'));}); });
    assert.throws(() => new ProcessGuard(path), code('CONTROLLER_ALREADY_RUNNING'));
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    const next = new ProcessGuard(path);
    next.close();
}
finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
} });
test('storage: event sequence and signing key survive reopening SQLite', async () => { const f = await fixture(); let s: Store | undefined; try {
    const seq = f.store.watermark(), secret = f.router.secret;
    await f.router.close();
    f.store.close();
    s = new Store(join(f.dir, 'router.sqlite'));
    assert.equal(s.meta('signingSecret'), secret);
    s.put('test', 'test', { value: 1 });
    assert.ok(s.watermark() > seq);
}
finally {
    s?.close();
    rmSync(f.dir, { recursive: true, force: true });
} });
