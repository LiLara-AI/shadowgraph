import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';
import { claimCapture, commitCapture } from '../src/internal/extraction-worker.js';
import { readLedger } from '../src/internal/deletion-knowledge.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
const now = () => '2026-10-04T00:00:00.000Z';
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const text = 'The fixture completed in staging.';
const admission = { limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 1000, maxItemBytes: 2 ** 20, maxItemsPerSession: 1000 }, storeBytes: 0 };
for (const type of ['json', 'sqlite']) for (const mode of ['logical', 'hard']) {
  test(`${type} ${mode} origin purge rejects an in-flight result without changing project provenance peers`, type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
    const root = await scratchDirectory(t, 'pr43-origin-race-');
    const options = { type, file: join(root, 'store'), env: { SHADOWGRAPH_HOME: join(root, 'home') }, originId: 'a', now };
    const graph = createShadowGraph({ now });
    const item = privilegedRecordCapture(graph, { originId: 'a', text, admission, source: { event: 'UserPromptSubmit', sessionId: 'origin' } });
    const peer = privilegedRecordCapture(graph, { project: 'p', originId: 'a', text, admission, source: { event: 'UserPromptSubmit', sessionId: 'project' } });
    const store = await createStorage(options); t.after(() => store.close());
    await store.save(privilegedSnapshot(graph));
    const claim = await claimCapture(options); assert.equal(claim.status, 'claimed'); assert.equal(claim.id, item.id);
    const fresh = createShadowGraph({ now }); fresh.importData(await store.load());
    fresh.purgeOrigin('a', { mode }); await store.save(privilegedSnapshot(fresh));
    const ledger = await readLedger(options.file);
    assert.ok(ledger.generationCounters.some(x => x.token === item.erasureToken && x.counter > 0));
    assert.equal(ledger.generationCounters.some(x => x.token === peer.erasureToken), false);
    const before = await store.load();
    const result = await commitCapture(options, claim, { status: 'success', value: { records: [{ kind: 'memory', fields: [{ name: 'text', text, sourceRef: item.id }] }] },
      receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' } });
    assert.equal(result.status, 'superseded_result');
    const after = await store.load();
    assert.equal(after.records.some(x => x.id === item.id || x.kind === 'memory'), false);
    assert.deepEqual(after.records.find(x => x.id === peer.id), before.records.find(x => x.id === peer.id));
    assert.equal((await claimCapture({ ...options, project: 'p', originId: undefined })).id, peer.id);
  });
}
