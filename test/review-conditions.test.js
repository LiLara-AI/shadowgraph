import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// A decision whose rejected alternative reopens on a machine-checkable threshold.
function decisionWithThreshold(graph, rule, project = 'p') {
  return graph.addDecision({
    project,
    title: 'Serve reads from the local replica',
    chosen: 'local-replica',
    alternatives: [{ label: 'primary-only', reasonRejected: 'replica latency was acceptable', reopenWhen: [rule] }]
  });
}

const conditionsFor = (graph, decisionId, project = 'p') => {
  const entry = graph.context({ project }).conditionDiagnostics.find((item) => item.decisionId === decisionId);
  return entry ? entry.conditions : [];
};

test('a condition with no recorded evidence is visible as unresolved, not a silent pass', () => {
  const graph = createShadowGraph();
  const decision = decisionWithThreshold(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500 });

  const view = graph.context({ project: 'p' });
  assert.equal(view.openReviews.length, 0, 'no evidence is not a breach');
  assert.equal(graph.getReviewSignals({ project: 'p' }).length, 0, 'and raises no review signal');

  const conditions = conditionsFor(graph, decision.id);
  assert.equal(conditions.length, 1, 'but the uncertainty is reported');
  assert.equal(conditions[0].verdict, 'unknown');
  assert.equal(conditions[0].key, 'replicaLagMs');
  assert.match(conditions[0].reason, /No fact recorded/);
});

test('an unreadable observation is unresolved rather than a confident no-review', () => {
  const graph = createShadowGraph();
  const decision = decisionWithThreshold(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500 });
  // Number('900ms') is NaN, and NaN > 500 is false. Before, this read as "fine".
  graph.addFact({ project: 'p', key: 'replicaLagMs', value: '900ms', sourceClass: 'measured' });

  assert.equal(graph.context({ project: 'p' }).openReviews.length, 0);
  const conditions = conditionsFor(graph, decision.id);
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0].verdict, 'unknown');
  assert.equal(conditions[0].observed, '900ms');
  assert.equal(conditions[0].evidence.source, 'stored_fact');
  assert.ok(conditions[0].evidence.factId, 'the unresolved condition still names its evidence');
});

test('a declared unit makes the same observation decidable and reports the breach in full', () => {
  const graph = createShadowGraph();
  const decision = decisionWithThreshold(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500, unit: 'ms' });
  const fact = graph.addFact({ project: 'p', key: 'replicaLagMs', value: '900ms', sourceClass: 'measured' });

  const view = graph.context({ project: 'p' });
  assert.equal(view.openReviews.length, 1);
  const [open] = view.openReviews;
  assert.equal(open.decisionId, decision.id);
  assert.deepEqual(open.alternativesToReconsider, ['primary-only']);

  assert.equal(open.violatedConditions.length, 1);
  const violated = open.violatedConditions[0];
  assert.equal(violated.key, 'replicaLagMs');
  assert.equal(violated.operator, 'greater_than');
  assert.equal(violated.expected, 500);
  assert.equal(violated.observed, '900ms');
  assert.equal(violated.unit, 'ms');
  assert.equal(violated.verdict, 'true');
  assert.equal(violated.evidence.factId, fact.id, 'the breach names the fact it was computed from');
  assert.equal(violated.evidence.observedAt, fact.observedAt);
});

test('an irrelevant change stays negative and raises nothing', () => {
  const graph = createShadowGraph();
  const decision = decisionWithThreshold(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500, unit: 'ms' });
  graph.addFact({ project: 'p', key: 'replicaLagMs', value: '20ms', sourceClass: 'measured' });
  graph.addFact({ project: 'p', key: 'officeWifiSsid', value: 'guest', sourceClass: 'human' });

  const view = graph.context({ project: 'p' });
  assert.equal(view.openReviews.length, 0);
  assert.equal(conditionsFor(graph, decision.id).length, 0, 'a settled false needs no diagnostic');
});

test('a pass resting on facts that disagree is reported as contested', () => {
  const graph = createShadowGraph();
  const decision = decisionWithThreshold(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500, unit: 'ms' });
  graph.addFact({ project: 'p', key: 'replicaLagMs', value: '20ms', sourceClass: 'measured', validFrom: '2026-03-01T00:00:00Z' });

  // A second, equally applicable observation of the same key that disagrees.
  const snapshot = graph.exportData();
  const original = snapshot.facts[0];
  snapshot.facts = [...snapshot.facts, { ...original, id: 'fact:contested', value: '900ms' }];
  const contested = createShadowGraph();
  contested.importData(snapshot);

  const conditions = conditionsFor(contested, decision.id);
  assert.equal(conditions.length, 1, 'the contested key is surfaced');
  assert.ok(Array.isArray(conditions[0].conflictingEvidence));
  assert.equal(conditions[0].conflictingEvidence.length, 2);
  const values = conditions[0].conflictingEvidence.map((item) => item.value).sort();
  assert.deepEqual(values, ['20ms', '900ms'], 'both disagreeing observations stay visible');
});

test('diagnostics are project scoped and never leak across projects', () => {
  const graph = createShadowGraph();
  const mine = decisionWithThreshold(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500 }, 'p');
  const theirs = decisionWithThreshold(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500 }, 'other');

  const view = graph.context({ project: 'p' });
  const ids = view.conditionDiagnostics.map((item) => item.decisionId);
  assert.ok(ids.includes(mine.id));
  assert.ok(!ids.includes(theirs.id), 'another project decision is not reported here');
});

test('diagnostics are bounded by the same completeness contract as every other collection', () => {
  const graph = createShadowGraph();
  for (let index = 0; index < 5; index += 1) {
    decisionWithThreshold(graph, { key: `missingKey${index}`, operator: 'greater_than', value: 1 });
  }
  const view = graph.context({ project: 'p', limit: 2 });
  const declared = view.completeness.collections.conditionDiagnostics;
  assert.equal(view.conditionDiagnostics.length, 2, 'the collection is bounded');
  assert.equal(declared.returned, 2);
  assert.equal(declared.total, 5);
  assert.equal(declared.hasMore, true);
  assert.equal(declared.omitted, 3, 'and declares exactly what it omitted');
  assert.equal(view.completeness.complete, false, 'an incomplete collection makes the whole view incomplete');
});

test('an acknowledged breach stays acknowledged, but a new distinct breach is not suppressed', () => {
  const graph = createShadowGraph();
  graph.addDecision({
    project: 'p',
    title: 'Serve reads from the local replica',
    chosen: 'local-replica',
    alternatives: [{
      label: 'primary-only',
      reasonRejected: 'replica latency was acceptable',
      reopenWhen: [
        { key: 'replicaLagMs', operator: 'greater_than', value: 500, unit: 'ms' },
        { key: 'region', operator: 'equals', value: 'eu-west' }
      ]
    }]
  });
  graph.addFact({ project: 'p', key: 'replicaLagMs', value: '900ms', sourceClass: 'measured' });

  graph.review({ project: 'p' });
  const [first] = graph.getReviewSignals({ project: 'p', status: 'open' });
  assert.ok(first, 'the first breach raised a signal');
  graph.acknowledgeReview(first.id);

  // Re-evaluating unchanged evidence must not resurrect the acknowledged signal.
  graph.review({ project: 'p' });
  assert.equal(graph.getReviewSignals({ project: 'p', status: 'open' }).length, 0, 'unchanged evidence stays acknowledged');

  // A genuinely new applicable breach is a different reason, so it is not
  // permanently suppressed by the earlier acknowledgement.
  graph.addFact({ project: 'p', key: 'region', value: 'eu-west', sourceClass: 'human' });
  graph.review({ project: 'p' });
  const open = graph.getReviewSignals({ project: 'p', status: 'open' });
  assert.equal(open.length, 1, 'the new breach raises its own signal');
  assert.match(open[0].reason, /region/);
});

test('a caller write rejects an unusable operator or unit instead of storing a condition that can never fire', () => {
  const graph = createShadowGraph();
  assert.throws(() => decisionWithThreshold(graph, { key: 'replicaLagMs', operator: 'greaterThan', value: 500 }), /Unsupported rule operator/);
  assert.throws(() => decisionWithThreshold(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500, unit: 'furlong' }), /Unsupported rule unit/);
  assert.throws(() => decisionWithThreshold(graph, { key: '', operator: 'greater_than', value: 500 }), /non-empty key/);
  // Legacy free-text conditions remain valid and are not rejected.
  assert.ok(decisionWithThreshold(graph, 'deployment').id);
});

test('a stored rule whose operator this build did not recognise is preserved, not rewritten', () => {
  const seeded = createShadowGraph();
  const decision = decisionWithThreshold(seeded, { key: 'replicaLagMs', operator: 'greater_than', value: 500 });
  const snapshot = seeded.exportData();
  // Simulate a record written by a build with an operator vocabulary we do not share.
  snapshot.records[0].alternatives[0].reopenWhen = [{ key: 'replicaLagMs', operator: 'within_stddev', value: 2 }];

  const graph = createShadowGraph();
  graph.importData(snapshot);
  const stored = graph.exportData().records[0].alternatives[0].reopenWhen[0];
  assert.equal(stored.operator, 'within_stddev', 'the original rule survives import verbatim');

  graph.addFact({ project: 'p', key: 'replicaLagMs', value: 3, sourceClass: 'measured' });
  const conditions = conditionsFor(graph, decision.id);
  assert.equal(conditions.length, 1);
  assert.equal(conditions[0].verdict, 'unknown');
  assert.match(conditions[0].reason, /Unsupported operator/);
});

test('a declared unit survives persistence and restart', async (t) => {
  const directory = await scratchDirectory(t);
  const file = join(directory, 'memory.json');
  const store = await createJsonFileStore(file);

  const graph = createShadowGraph();
  decisionWithThreshold(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500, unit: 'ms' });
  graph.addFact({ project: 'p', key: 'replicaLagMs', value: '900ms', sourceClass: 'measured' });
  await store.save(graph.exportData());

  const reopened = createShadowGraph();
  reopened.importData(await store.load());
  const rule = reopened.exportData().records[0].alternatives[0].reopenWhen[0];
  assert.equal(rule.unit, 'ms', 'the unit was not dropped on the way to storage');

  const view = reopened.context({ project: 'p' });
  assert.equal(view.openReviews.length, 1, 'and the condition still evaluates after restart');
  assert.equal(view.openReviews[0].violatedConditions[0].unit, 'ms');
});
