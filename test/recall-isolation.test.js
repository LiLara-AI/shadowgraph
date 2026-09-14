import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { seedGraph, measureCoverage } from '../scripts/context-size.mjs';

// recall() ranks over live entities instead of a full exportData() clone, which
// removed about 70% of its cost. The property that made the wholesale clone safe
// -- a caller never holds a reference into live state -- has to hold anyway, so
// it is asserted here directly rather than inferred from the old implementation.

function graphWithMemory() {
  const graph = createShadowGraph();
  graph.addDecision({
    project: 'p', title: 'Serve reads from the regional cache', chosen: 'regional-cache',
    alternatives: [{ label: 'origin-only', reasonRejected: 'origin latency was too high' }]
  });
  graph.addAttempt({ project: 'p', solution: 'bulk backfill', result: 'failed: quota rejected', resultClass: 'failed' });
  graph.addFact({ project: 'p', key: 'region', value: 'eu-west', sourceClass: 'measured' });
  return graph;
}

test('a record returned by recall cannot be mutated back into live state', () => {
  const graph = graphWithMemory();
  const first = graph.recall('regional cache', { project: 'p' });
  assert.ok(first.items.length > 0, 'the corpus is actually reachable');

  const targetId = first.items[0].record.id;
  first.items[0].record.title = 'MUTATED';
  if (Array.isArray(first.items[0].record.alternatives)) first.items[0].record.alternatives.push({ label: 'injected' });

  const stored = graph.exportData().records.find((item) => item.id === targetId);
  assert.notEqual(stored.title, 'MUTATED', 'live state was not reachable through the result');
  assert.ok(!(stored.alternatives ?? []).some((item) => item.label === 'injected'));
});

test('a nested field of a recalled record is detached too, not shallow copied', () => {
  const graph = graphWithMemory();
  const result = graph.recall('regional cache', { project: 'p' });
  const decision = result.items.find((item) => item.record.kind === 'decision');
  assert.ok(decision, 'a decision came back');

  decision.record.alternatives[0].reasonRejected = 'MUTATED';
  const stored = graph.exportData().records.find((item) => item.id === decision.record.id);
  assert.notEqual(stored.alternatives[0].reasonRejected, 'MUTATED', 'the clone reaches nested objects');
});

test('records returned by context are detached as well', () => {
  const graph = graphWithMemory();
  const view = graph.context({ project: 'p' });
  const targetId = view.activeDecisions[0].id;
  view.activeDecisions[0].title = 'MUTATED';

  const stored = graph.exportData().records.find((item) => item.id === targetId);
  assert.notEqual(stored.title, 'MUTATED');
});

test('ranking over live entities did not change what recall returns', () => {
  const graph = graphWithMemory();
  const result = graph.recall('regional cache', { project: 'p' });
  // The envelope contract is unchanged, including the lossless-items claim.
  assert.equal(result.completeness.losslessItems, true);
  assert.equal(result.completeness.complete, true);
  assert.equal(result.page.total, result.items.length);
  assert.ok(result.signals.lexical, 'signals still describe why each hit matched');
  assert.equal(result.ranking.strategy, 'weighted_rrf');
  // A returned record is a full record, not a projection.
  const stored = graph.exportData().records.find((item) => item.id === result.items[0].record.id);
  assert.deepEqual(result.items[0].record, stored, 'items are full fidelity');
});

test('recall still refuses to cross a project boundary', () => {
  const graph = graphWithMemory();
  graph.addDecision({ project: 'other', title: 'Serve reads from the regional cache', chosen: 'elsewhere' });
  const result = graph.recall('regional cache', { project: 'p' });
  assert.ok(result.items.every((item) => item.record.project === 'p'), 'ranking over live entities kept the scope filter');
});

// The measurement script carries logic of its own, so it gets one runnable check
// rather than being trusted because it printed a number.
test('the coverage measurement counts grounded evidence, not returned items', () => {
  const { graph, expected } = seedGraph({ decisions: 6, attempts: 5, facts: 3 });
  const view = graph.context({ project: 'bench' });
  const coverage = measureCoverage(view, expected);

  assert.equal(coverage.expectedBreaches, expected.violatedKeys.length);
  assert.equal(coverage.breachesReported, expected.violatedKeys.length, 'every seeded breach is found');
  assert.equal(coverage.breachRecall, 1);
  assert.equal(coverage.groundedConditionRatio, 1, 'and every reported breach names the fact behind it');

  // A context stripped of its evidence must score worse, or the metric is
  // measuring nothing.
  const blinded = { ...view, openReviews: view.openReviews.map((item) => ({ ...item, violatedConditions: [] })) };
  const blindedCoverage = measureCoverage(blinded, expected);
  assert.equal(blindedCoverage.breachesReported, 0);
  assert.equal(blindedCoverage.breachRecall, 0);
});
