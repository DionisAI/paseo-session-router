import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fixture, principal } from './helpers.js';
import { runJsonCommand } from '../src/util.js';
test('external Frontier: configured bridge is authoritative, with no shadow Frontier in SQLite', async () => { const f = await fixture(c => { c.frontierCommand = { command: 'python3', args: [resolve('scripts/frontier-file-bridge.py'), '--root', c.dataDir + '/frontier'], timeoutMs: 3000 }; }); try {
    const s = f.session();
    const got = await f.router.getFrontier(principal(), s.workspaceId!);
    assert.equal(got.revision, 0);
    await f.router.patchFrontier(principal(), { workspaceId: s.workspaceId!, expectedRevision: 0, card: { id: 'work', current: 'Now', next: 'Then', blockers: [], ownerSessionRef: s.id, refs: [] } });
    assert.equal((await f.router.getFrontier(principal(), s.workspaceId!)).cards.work.current, 'Now');
    assert.equal(f.store.get('frontier', s.workspaceId!), undefined);
    assert.ok(f.store.get('frontier_signal', s.workspaceId!));
}
finally {
    await f.close();
} });
test('external Frontier: actual concurrent CAS commands accept one writer, not both', async () => { const f = await fixture(); try {
    const args = [resolve('scripts/frontier-file-bridge.py'), '--root', f.dir + '/bridge'];
    const request = { operation: 'compare_and_swap', workspaceId: 'workspace-test', expectedRevision: 0, next: { workspaceId: 'workspace-test', projectId: 'hft', hostId: 'gpu1', revision: 1, cards: {}, notes: {} } };
    const results = await Promise.allSettled([runJsonCommand('python3', args, request, 3000), runJsonCommand('python3', args, request, 3000)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter(r => r.status === 'rejected').length, 1);
}
finally {
    await f.close();
} });
test('external Frontier: fourth historical note is rejected by the primary store itself', async () => { const f = await fixture(); try {
    const req = { operation: 'compare_and_swap', workspaceId: 'workspace-test', expectedRevision: 0, next: { workspaceId: 'workspace-test', projectId: 'hft', hostId: 'gpu1', revision: 1, cards: {}, notes: { '4': 'invalid' } } };
    await assert.rejects(() => runJsonCommand('python3', [resolve('scripts/frontier-file-bridge.py'), '--root', f.dir + '/bridge'], req, 3000));
}
finally {
    await f.close();
} });
