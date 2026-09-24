import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph, SCHEMA_VERSION } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';

// The public export -- graph.exportData(), served by GET /records and the
// `list` verb -- is a supported read in its own right. The persistence callers
// moved to the privileged snapshot, so this file holds the public contract
// directly rather than inheriting coverage from them. Its content equals the
// privileged snapshot at this build; later change-sets narrow it.

const NOW = '2026-01-01T00:00:00.000Z';

function populated() {
  const graph = createShadowGraph({ now: () => NOW });
  const decision = graph.addDecision({ project: 'alpha', title: 'Cache', chosen: 'redis', idempotencyKey: 'retry-1' });
  const attempt = graph.addAttempt({ project: 'alpha', solution: 'warm-up script', result: 'worked' });
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'k', text: 'a note' });
  graph.addFact({ project: 'alpha', key: 'latency', value: 10 });
  graph.link({ project: 'alpha', from: decision.id, to: attempt.id, relation: 'tried' });
  return graph;
}

test('the public export keeps its documented envelope', () => {
  const exported = populated().exportData();
  assert.deepEqual(Object.keys(exported), ['schemaVersion', 'revision', 'records', 'facts', 'relations', 'reviewSignals', 'idempotency', 'events', 'journal', 'journalSeq', 'journalEpoch']);
  assert.equal(exported.schemaVersion, SCHEMA_VERSION);
  assert.equal(exported.records.length, 3);
  assert.equal(exported.facts.length, 1);
  assert.equal(exported.relations.length, 1);
});

test('the public export is plain JSON and detached from the graph', () => {
  const graph = populated();
  const exported = graph.exportData();
  assert.deepEqual(JSON.parse(JSON.stringify(exported)), exported);
  exported.records[0].title = 'mutated';
  exported.records.length = 0;
  assert.equal(graph.exportData().records.length, 3);
  assert.notEqual(graph.exportData().records[0].title, 'mutated');
});

test('the public export round-trips through importData', () => {
  const graph = populated();
  const restarted = createShadowGraph({ now: () => NOW });
  restarted.importData(graph.exportData());
  // Import normalises key order on some kinds, so the contract is semantic.
  assert.deepEqual(restarted.exportData(), graph.exportData());
});

test('at this build the public export equals the privileged snapshot', () => {
  const graph = populated();
  assert.equal(JSON.stringify(graph.exportData()), JSON.stringify(privilegedSnapshot(graph)));
});
