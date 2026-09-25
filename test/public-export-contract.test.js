import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph, SCHEMA_VERSION } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';

// The public export -- graph.exportData(), served by GET /records and the
// `list` verb -- is a supported read in its own right. The persistence callers
// moved to the privileged snapshot (plan PR-05), so this file holds the public
// contract directly rather than inheriting coverage from them. Since plan
// PR-10 it is a scoped read (P1 reconciliation F-01): one project's, or one
// origin's, records, facts, relations, review signals and breadcrumbs, marked
// `public_scoped`, never the store itself, and never accepted as one.

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
  const exported = populated().exportData({ project: 'alpha' });
  assert.deepEqual(Object.keys(exported), ['exportKind', 'schemaVersion', 'records', 'facts', 'relations', 'reviewSignals', 'events', 'completeness']);
  assert.equal(exported.exportKind, 'public_scoped');
  assert.equal(exported.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(exported.completeness.scope, { project: 'alpha' });
  assert.equal(exported.completeness.limitation.code, 'scoped_coverage');
  assert.equal(exported.records.length, 3);
  assert.equal(exported.facts.length, 1);
  assert.equal(exported.relations.length, 1);
});

test('the public export is plain JSON and detached from the graph', () => {
  const graph = populated();
  const exported = graph.exportData({ project: 'alpha' });
  assert.deepEqual(JSON.parse(JSON.stringify(exported)), exported);
  exported.records[0].title = 'mutated';
  exported.records.length = 0;
  assert.equal(graph.exportData({ project: 'alpha' }).records.length, 3);
  assert.notEqual(graph.exportData({ project: 'alpha' }).records[0].title, 'mutated');
});

test('the public export is never taken for a store; the privileged snapshot is what round-trips', () => {
  const graph = populated();
  const restarted = createShadowGraph({ now: () => NOW });
  assert.throws(() => restarted.importData(graph.exportData({ project: 'alpha' })), { code: 'public_export_not_a_store' });
  restarted.importData(privilegedSnapshot(graph));
  // Import normalises key order on some kinds, so the contract is semantic.
  assert.deepEqual(restarted.exportData({ project: 'alpha' }), graph.exportData({ project: 'alpha' }));
});

test('the public export is a scoped read, not the privileged snapshot', () => {
  const graph = populated();
  assert.deepEqual(graph.exportData().records, [], 'no project, no origin: nothing');
  assert.notEqual(JSON.stringify(graph.exportData({ project: 'alpha' })), JSON.stringify(privilegedSnapshot(graph)));
  assert.deepEqual(graph.exportData({ project: 'alpha' }).records, privilegedSnapshot(graph).records);
  assert.deepEqual(graph.exportData({ project: 'beta' }).records, []);
});
