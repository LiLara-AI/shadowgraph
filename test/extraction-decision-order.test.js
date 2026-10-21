// Independent review of 945964e, R1: a supported typed decision survives a
// durable commit whichever order the model lists it and the whole-message
// memory of the same sentence in. Synthetic store, injected result, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';
import { createStorage } from '../src/storage.js';
import { claimCapture, commitCapture } from '../src/internal/extraction-worker.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const SOURCE = 'For the report exporter we will use the streaming CSV writer instead of the in-memory table builder, because the in-memory builder runs out of memory on large reports.';
const LIMITS = { maxStoreBytes: 2 ** 40, maxQueueDepth: 1000, maxItemBytes: 2 ** 20, maxItemsPerSession: 1000 };

async function persisted(t, order) {
  const root = await scratchDirectory(t), now = () => '2026-10-21T00:00:00.000Z';
  const options = { type: 'json', file: join(root, 'memory.json'), env: { SHADOWGRAPH_HOME: root }, now, project: 'synthetic-order', ownerId: 'fixture', ownerBootId: 'fixture', leaseMs: 60000 };
  const graph = createShadowGraph({ now });
  const item = privilegedRecordCapture(graph, { project: options.project, originId: 'synthetic-origin', text: SOURCE, admission: { limits: LIMITS, storeBytes: 0 },
    source: { event: 'UserPromptSubmit', role: 'user', sessionId: 'synthetic-session' } });
  const store = await createStorage(options);
  try { await store.save(privilegedSnapshot(graph)); } finally { store.close(); }
  const field = (name, text) => ({ name, text, sourceRef: item.id });
  const proposals = { decision: { kind: 'decision', fields: [field('chosen', 'streaming CSV writer')] }, memory: { kind: 'memory', fields: [field('text', SOURCE)] } };
  const claim = await claimCapture(options);
  assert.equal(claim.status, 'claimed');
  const committed = await commitCapture(options, claim, { status: 'success', value: { records: order.map(name => proposals[name]) }, receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' } });
  assert.equal(committed.status, 'committed');
  const again = await createStorage(options);
  try { return (await again.load()).records.filter(record => record.kind !== 'capture'); } finally { again.close(); }
}

test('a supported typed decision is committed and reloaded whichever order the model lists it in', async t => {
  for (const order of [['decision', 'memory'], ['memory', 'decision'], ['memory', 'memory', 'decision']]) {
    const records = await persisted(t, order);
    assert.deepEqual(records.map(record => record.kind), ['decision'], order.join(','));
    assert.equal(records[0].chosen, 'the streaming CSV writer');
    assert.deepEqual(records[0].alternatives.map(({ label, reasonRejected }) => ({ label, reasonRejected })),
      [{ label: 'the in-memory table builder', reasonRejected: 'the in-memory builder runs out of memory on large reports' }]);
    assert.equal(records[0].verificationStatus, 'unverified');
    assert.ok(records[0].claims.some(claim => claim.class === 'quoted' && claim.evidence === SOURCE.slice(0, -1)));
  }
  // The memory alone is still kept as it is said.
  assert.deepEqual((await persisted(t, ['memory'])).map(record => record.kind), ['memory']);
});
