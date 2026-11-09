import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, principal } from './helpers.js';

const owner = principal();

test('directory sync writes a session or daemon only when it changed, or once a minute; freshness comes from memory', async (t) => {
    const f = await fixture(); t.after(f.close);
    const writes = (after: number) => f.store.events(after, 10000).filter(e => e.kind === 'session' || e.kind === 'daemon');
    const sessionsNow = f.sessions().length, daemons = f.config.daemons.length;
    // an unchanged fleet, synced every 2 s for 40 s (well past the 15 s freshness window): no writes, still fresh
    const w0 = f.store.watermark();
    for (let i = 0; i < 20; i++) { f.advance(2000); await f.router.syncDirectory(); }
    assert.deepEqual(writes(w0), []);
    const s = f.session();
    assert.equal(s.freshness, 'fresh');
    assert.equal(s.observedAt, f.now());
    assert.equal(f.router.getSession(owner, s.id).observedAt, f.now());
    assert.ok(f.router.listHosts(owner).daemons.every(d => d.observedAt === f.now()));
    // a minute after the last write each record is written once, with its observedAt
    const w1 = f.store.watermark();
    for (let i = 0; i < 12; i++) { f.advance(2000); await f.router.syncDirectory(); }
    assert.equal(writes(w1).length, sessionsNow + daemons);
    // a real change is written at the next sync
    const w2 = f.store.watermark();
    f.demos.get('gpu-research')!.sessions.get('agent-1')!.title = 'Renamed';
    f.advance(2000); await f.router.syncDirectory();
    assert.deepEqual(writes(w2).map(e => e.entityId), [f.session().id]);
    assert.equal(f.session().title, 'Renamed');
    // a daemon that stops answering goes stale at once
    f.demos.get('gpu-research')!.online = false;
    f.advance(2000); await f.router.syncDirectory();
    assert.equal(f.session().freshness, 'stale');
});
