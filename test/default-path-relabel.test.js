// Plan v1.4.4 PR-19 (§13.4; E03 §2 and §4; PC-01(a)/(b), PC-17; AC-026,
// AC-045, AC-060): the default read carries every record under a name that
// states what it holds. failedAttemptsToAvoid is failedAttempts, openReviews is
// firedConditions, alternativesToReconsider is affectedAlternatives, and the one
// generated element, suggestedQuestions, gives way to the fact it was generated
// from: which decisions sit below the confidence policy threshold. The
// explicitly invoked reviewContext keeps the old shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';

const NOW = '2026-01-01T00:00:00.000Z';

// Two conditions on one alternative: one fires, one cannot be settled. A failed
// outcome moves confidence below the threshold, an attempt's recorded
// precondition now holds, and two equally applicable facts disagree.
function mixed() {
  const graph = createShadowGraph({ now: () => NOW });
  const cache = graph.addDecision({
    project: 'p', title: 'cache', chosen: 'redis', reviewAfter: '2027-01-01T00:00:00.000Z',
    alternatives: [{ label: 'memcached', reasonRejected: 'operational cost', reopenWhen: [{ key: 'latency', operator: 'greater_than', value: 10, unit: 'ms' }, { key: 'region', operator: 'equals', value: 'eu' }] }]
  });
  graph.addFact({ project: 'p', key: 'latency', value: '5ms' });
  graph.addFact({ project: 'p', key: 'latency', value: '30ms' });
  graph.setOutcome(cache.id, { status: 'failed', sourceClass: 'tool_observed' }, { project: 'p' });
  graph.addAttempt({ project: 'p', solution: 'bulk backfill', result: 'failed: quota', resultClass: 'failed', reusableWhen: [{ key: 'quota', operator: 'gte', value: 600 }] });
  graph.addFact({ project: 'p', key: 'quota', value: 1200 });
  graph.addDecision({ project: 'p', title: 'lag', chosen: 'a', alternatives: [{ label: 'b', reopenWhen: [{ key: 'lagProfile', operator: 'contains', value: 'spike' }] }] });
  graph.addFact({ project: 'p', key: 'lagProfile', value: ['spike'], validFrom: '2025-12-01T00:00:00.000Z' });
  const snapshot = privilegedSnapshot(graph);
  const lag = snapshot.facts.find((fact) => fact.key === 'lagProfile');
  snapshot.facts.push({ ...lag, id: 'fact:contested', value: ['calm'], erasureToken: 'tok_contested' });
  return snapshot;
}
// A condition that cannot be settled, and nothing else.
function partialOnly() {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({ project: 'p', title: 'region', chosen: 'us', alternatives: [{ label: 'eu', reopenWhen: [{ key: 'region', operator: 'equals', value: 'eu' }] }] });
  return privilegedSnapshot(graph);
}
// A decision with no conditions and no facts.
function unknown() {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({ project: 'p', title: 'plain', chosen: 'x' });
  return privilegedSnapshot(graph);
}
const load = (snapshot) => { const graph = createShadowGraph({ now: () => NOW }); graph.importData(structuredClone(snapshot)); return graph; };

// The old payload under the new names: what the default read must carry.
function renamed(legacy) {
  const names = { failedAttemptsToAvoid: 'failedAttempts', openReviews: 'firedConditions' };
  const view = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (key === 'suggestedQuestions') continue;
    if (key === 'openReviews') view.firedConditions = value.map((entry) => Object.fromEntries(Object.entries(entry).map(([name, item]) => [name === 'alternativesToReconsider' ? 'affectedAlternatives' : name, item])));
    else view[names[key] ?? key] = value;
  }
  const { suggestedQuestions: ignored, ...collections } = legacy.completeness.collections;
  view.completeness = { ...legacy.completeness, collections: Object.fromEntries(Object.entries(collections).map(([key, value]) => [names[key] ?? key, value])) };
  return view;
}
const withoutAdditions = ({ belowConfidenceThreshold, notice, ...view }) => {
  const { belowConfidenceThreshold: counted, ...collections } = view.completeness.collections;
  return { ...view, completeness: { ...view.completeness, collections } };
};

test('the default read keeps every record under factual names: a before/after diff loses nothing', () => {
  for (const [name, fixture] of Object.entries({ mixed, partialOnly, unknown })) {
    // Signals raised once first, so both reads report the same stored signals.
    const seeded = load(fixture());
    seeded.reviewContext({ project: 'p' });
    const snapshot = privilegedSnapshot(seeded);
    for (const limit of [undefined, 1]) {
      const input = limit === undefined ? { project: 'p' } : { project: 'p', limit };
      const after = load(snapshot).context(input);
      const before = load(snapshot).reviewContext(input);
      assert.deepEqual(withoutAdditions(after), renamed(before), `${name}, limit ${limit}`);
      assert.equal(after.completeness.complete, before.completeness.complete, `${name}: completeness is unchanged`);
    }
  }
});

test('partiality stays visible and no all-clear is produced when nothing fired', () => {
  const view = load(partialOnly()).context({ project: 'p' });
  assert.deepEqual(view.firedConditions, []);
  assert.equal(view.conditionDiagnostics.length, 1, 'the unsettled condition is still reported');
  assert.equal(view.conditionDiagnostics[0].conditions[0].verdict, 'unknown');
  const truncated = load(mixed()).context({ project: 'p', limit: 1 });
  assert.equal(truncated.completeness.complete, false);
});

test('the below-threshold fact survives for a decision of any status', () => {
  const graph = createShadowGraph({ now: () => NOW });
  const old = graph.addDecision({ project: 'p', title: 'old', chosen: 'a' });
  graph.setOutcome(old.id, { status: 'failed', sourceClass: 'tool_observed' }, { project: 'p' });
  const replacement = graph.addDecision({ project: 'p', title: 'new', chosen: 'b' });
  graph.supersedeDecision({ project: 'p', decisionId: old.id, replacementId: replacement.id });
  const view = graph.context({ project: 'p' });
  const stored = privilegedSnapshot(graph).records.find((record) => record.id === old.id);
  assert.equal(stored.status, 'superseded');
  assert.ok(stored.confidence.current < 0.5);
  assert.deepEqual(view.belowConfidenceThreshold, [{ decisionId: old.id, title: 'old', status: 'superseded', confidence: stored.confidence.current, threshold: 0.5 }]);
  assert.deepEqual(view.completeness.collections.belowConfidenceThreshold, { returned: 1, total: 1, hasMore: false, omitted: 0 });
  assert.equal(Object.hasOwn(view, 'suggestedQuestions'), false, 'the generated question is gone');
  assert.deepEqual(graph.reviewContext({ project: 'p' }).suggestedQuestions, ['What evidence could change the decision: old?']);
});

test('the review-named operation keeps the legacy shape', () => {
  const graph = load(mixed());
  const view = graph.reviewContext({ project: 'p' });
  for (const key of ['failedAttemptsToAvoid', 'openReviews', 'suggestedQuestions']) assert.ok(Object.hasOwn(view, key), key);
  for (const key of ['failedAttempts', 'firedConditions', 'belowConfidenceThreshold']) assert.equal(Object.hasOwn(view, key), false, key);
  assert.ok(Object.hasOwn(view.openReviews[0], 'alternativesToReconsider'));
  assert.ok(Object.hasOwn(view.completeness.collections, 'suggestedQuestions'));
});

// AC-045: the evaluator is not touched by the relabel.
test('reconsider verdicts are unchanged for triggered, unchanged, partial and mixed decisions', () => {
  const graph = createShadowGraph({ now: () => NOW });
  const triggered = graph.addDecision({ project: 't', title: 'triggered', chosen: 'a', alternatives: [{ label: 'b', reopenWhen: [{ key: 'load', operator: 'greater_than', value: 10 }] }] });
  graph.addFact({ project: 't', key: 'load', value: 20 });
  const unchanged = graph.addDecision({ project: 'u', title: 'unchanged', chosen: 'a', alternatives: [{ label: 'b', reopenWhen: [{ key: 'load', operator: 'greater_than', value: 10 }] }] });
  graph.addFact({ project: 'u', key: 'load', value: 5 });
  const partial = graph.addDecision({ project: 'm', title: 'partial', chosen: 'a', alternatives: [{ label: 'b', reopenWhen: [{ key: 'missing', operator: 'equals', value: 1 }] }] });
  const verdict = (project, id) => graph.reconsider({ project }).decisions.find((item) => item.decisionId === id);
  assert.deepEqual([verdict('t', triggered.id).verdict, verdict('t', triggered.id).evaluationCompleteness], ['review_recommended', 'complete']);
  assert.deepEqual([verdict('u', unchanged.id).verdict, verdict('u', unchanged.id).evaluationCompleteness], ['unchanged', 'complete']);
  assert.deepEqual([verdict('m', partial.id).verdict, verdict('m', partial.id).evaluationCompleteness], ['manual_review', 'partial']);
  const aggregate = load(mixed()).reconsider({ project: 'p' });
  assert.deepEqual([aggregate.verdict, aggregate.evaluationCompleteness], ['review_recommended', 'partial']);
});
