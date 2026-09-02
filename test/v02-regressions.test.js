import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJsonFileStore } from '../src/storage.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

test('superseding a fact exposes the old fact as stale context', () => {
  const graph = createShadowGraph();
  graph.addFact({ key: 'mode', value: 'cloud' });
  graph.addFact({ key: 'mode', value: 'local' });
  assert.equal(graph.context().staleAssumptions.length, 1);
  assert.equal(graph.context().staleAssumptions[0].value, 'cloud');
});

test('review returns only alternatives whose rules matched', () => {
  const graph = createShadowGraph();
  graph.addDecision({ title: 'Architecture', chosen: 'A', alternatives: [
    { label: 'B', reopenWhen: ['local'] },
    { label: 'C', reopenWhen: ['cloud'] }
  ] });
  assert.deepEqual(graph.review({ changedFacts: ['local'] })[0].alternativesToReconsider, ['B']);
});

test('loads a v0.1 array file through the storage boundary', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-migration-');
  const file = join(directory, 'data.json');
  await writeFile(file, JSON.stringify([{ id: 'legacy', kind: 'decision', title: 'Legacy', chosen: 'A', confidence: 0.7, alternatives: [] }]));
  const store = createJsonFileStore(file);
  const graph = createShadowGraph();
  graph.importData(await store.load());
  assert.equal(graph.exportData().records[0].confidence.current, 0.7);
});
