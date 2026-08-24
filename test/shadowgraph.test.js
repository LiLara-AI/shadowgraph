import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';

test('stores one decision and reopens it when facts change', () => {
  const graph = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
  const decision = graph.addDecision({ title: 'Choose a database', chosen: 'PostgreSQL', assumptions: ['many-concurrent-writes'], alternatives: [{ label: 'SQLite', reasonRejected: 'Concurrency risk', reopenWhen: ['local-single-user'] }] });
  assert.equal(decision.alternatives[0].status, 'rejected');
  const reviews = graph.review({ changedFacts: ['local-single-user'] });
  assert.equal(reviews[0].decisionId, decision.id);
});

test('keeps attempts searchable and exportable', () => {
  const graph = createShadowGraph();
  graph.addAttempt({ solution: 'Rewrite everything', result: 'Regression', reason: 'Too broad' });
  assert.equal(graph.search('regression')[0].record.result, 'Regression');
  assert.equal(graph.stats().attempts, 1);
});

test('persists records in a portable JSON file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-'));
  const store = createJsonFileStore(join(directory, 'data.json'));
  const graph = createShadowGraph();
  graph.addDecision({ title: 'Use tests', chosen: 'Yes' });
  await store.save(graph.exportData());
  const loaded = await store.load();
  assert.equal(loaded.records.length, 1);
  assert.equal(JSON.parse(await readFile(join(directory, 'data.json'), 'utf8')).schemaVersion, 2);
});
