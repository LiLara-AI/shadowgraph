import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createStorage } from '../src/storage.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';
import { claimCapture, commitCapture } from '../src/internal/extraction-worker.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

test('Codex drains only fresh matching provenance; legacy, foreign accounts and prior setups remain untouched', async t => {
  const root = await scratchDirectory(t), binding = { provider: 'codex', accountFingerprint: 'a'.repeat(64), setupId: '12ab5678-1234-1234-1234-123456789012' };
  const options = { type: 'json', file: join(root, 'memory.json'), env: { SHADOWGRAPH_HOME: root }, project: 'fixture', provider: 'codex', extractionBinding: binding };
  const graph = createShadowGraph(), items = [];
  for (const provenance of [undefined, { ...binding, provider: 'claude' }, { ...binding, accountFingerprint: 'b'.repeat(64) }, { ...binding, setupId: '22ab5678-1234-1234-1234-123456789012' }, binding]) {
    items.push(privilegedRecordCapture(graph, { project: 'fixture', originId: 'fixture-origin', text: 'The fixture completed in staging.',
      source: { event: 'UserPromptSubmit', sessionId: `session-${items.length}` },
      observation: { host: 'codex-cli', hostVersion: '0.161.0', toolName: null, cwd: null, outcome: null, ...(provenance ? { extractionBinding: provenance } : {}) },
      admission: { limits: { maxStoreBytes: 2 ** 24, maxQueueDepth: 100, maxItemBytes: 65536, maxItemsPerSession: 100 }, storeBytes: 0 } }));
  }
  const store = await createStorage(options); await store.save(privilegedSnapshot(graph)); store.close();
  await assert.rejects(claimCapture({ ...options, extractionBinding: undefined }), { code: 'capture_provenance_required' });
  const claim = await claimCapture(options);
  assert.equal(claim.id, items[4].id);
  const result = await commitCapture(options, claim, { status: 'success', receipt: { invocationStarted: true, provider: 'codex', model: 'gpt-6.1-sol' },
    value: { records: [{ kind: 'memory', fields: [{ name: 'text', text: 'The fixture completed in staging.', sourceRef: claim.id }] }] } });
  assert.equal(result.status, 'committed');
  assert.equal((await claimCapture(options)).status, 'idle');
  const saved = await createStorage(options); const data = await saved.load(); saved.close();
  for (const item of items.slice(0, 4)) assert.deepEqual(data.records.find(row => row.id === item.id), item);
  const accepted = data.records.find(row => row.id === claim.id);
  assert.equal(accepted.receipts.at(-1).provider, 'codex');
  assert.equal(accepted.receipts.at(-1).model, 'gpt-6.1-sol');
});
