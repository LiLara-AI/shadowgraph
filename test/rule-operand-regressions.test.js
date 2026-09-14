// Regressions protecting rule-operand handling: a structured rule that never
// states what it compares against must evaluate `unknown`, and a historical
// acknowledgement must not be reused unless its breach coverage is fully
// reconstructable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { evaluateRule, RULE_OPERATORS } from '../src/condition-eval.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NODE_SQLITE = (await getRuntimeCapabilities()).nodeSqlite;
const SQLITE_TEST_OPTIONS = NODE_SQLITE.available ? {} : { skip: NODE_SQLITE.reason };

// ---------------------------------------------------------------------------
// B -- a stored rule with no operand is unevaluable, not a verdict.
// ---------------------------------------------------------------------------

test('every operator reports unknown when the rule states no value to compare against', () => {
  for (const operator of RULE_OPERATORS) {
    const absent = evaluateRule({ key: 'lag', operator }, 500);
    const undef = evaluateRule({ key: 'lag', operator, value: undefined }, 500);
    assert.equal(absent.verdict, 'unknown', `${operator}: an absent value is not a verdict`);
    assert.equal(undef.verdict, 'unknown', `${operator}: an undefined value is not a verdict`);
    assert.match(absent.reason, /\S/, `${operator}: and the reason says why`);
  }
});

test('not_equals with no operand is unknown rather than a breach', () => {
  // 500 !== undefined is true in JavaScript, which used to read as a genuine
  // breach of a rule that never said what it compared against.
  const result = evaluateRule({ key: 'lag', operator: 'not_equals' }, 500);
  assert.equal(result.verdict, 'unknown');
});

test('equals and contains with no operand are unknown rather than a confident pass', () => {
  assert.equal(evaluateRule({ key: 'lag', operator: 'equals' }, 500).verdict, 'unknown');
  assert.equal(evaluateRule({ key: 'lag', operator: 'contains' }, 'abc').verdict, 'unknown');
});

test('a falsy operand is a real operand and still decides', () => {
  assert.equal(evaluateRule({ key: 'k', operator: 'equals', value: 0 }, 0).verdict, 'true');
  assert.equal(evaluateRule({ key: 'k', operator: 'equals', value: false }, false).verdict, 'true');
  assert.equal(evaluateRule({ key: 'k', operator: 'equals', value: '' }, '').verdict, 'true');
  assert.equal(evaluateRule({ key: 'k', operator: 'equals', value: null }, null).verdict, 'true');
  assert.equal(evaluateRule({ key: 'k', operator: 'not_equals', value: 0 }, 1).verdict, 'true');
  assert.equal(evaluateRule({ key: 'k', operator: 'contains', value: '' }, 'abc').verdict, 'true');
  assert.equal(evaluateRule({ key: 'k', operator: 'gte', value: 0 }, 5).verdict, 'true');
});

test('collection and range operators keep their existing operand messages', () => {
  assert.match(evaluateRule({ key: 'k', operator: 'in', value: 'nope' }, 1).reason, /requires an array of allowed values/);
  assert.match(evaluateRule({ key: 'k', operator: 'not_in', value: 'nope' }, 1).reason, /requires an array of allowed values/);
  assert.match(evaluateRule({ key: 'k', operator: 'between', value: [500] }, 600).reason, /two-element \[low, high\] range/);
  assert.equal(evaluateRule({ key: 'k', operator: 'between', value: [500, undefined] }, 600).verdict, 'unknown');
  assert.equal(evaluateRule({ key: 'k', operator: 'in', value: null }, 1).verdict, 'unknown');
});

test('a valid complete rule is unaffected', () => {
  assert.equal(evaluateRule({ key: 'k', operator: 'gte', value: 500 }, 600).verdict, 'true');
  assert.equal(evaluateRule({ key: 'k', operator: 'gte', value: 500 }, 400).verdict, 'false');
  assert.equal(evaluateRule({ key: 'k', operator: 'in', value: [1, 2] }, 2).verdict, 'true');
  assert.equal(evaluateRule({ key: 'k', operator: 'between', value: [1, 3] }, 2).verdict, 'true');
});

// A decision carrying one rule, imported so lenient storage keeps it verbatim.
function graphWithStoredRule(rule, factValue) {
  const seed = createShadowGraph();
  seed.addDecision({
    project: 'p', id: 'decision:d1', title: 't', chosen: 'c',
    alternatives: [{ id: 'alternative:a1', label: 'alt-1', reasonRejected: 'r', reopenWhen: [{ key: 'lag', operator: 'gte', value: 1 }] }]
  });
  const snapshot = seed.exportData();
  snapshot.records[0].alternatives[0].reopenWhen = [rule];
  const graph = createShadowGraph();
  graph.importData(snapshot);
  graph.addFact({ project: 'p', key: 'lag', value: factValue, id: 'fact:lag' });
  return graph;
}

test('an imported rule with no operand raises no review and is visible as a diagnostic', () => {
  const graph = graphWithStoredRule({ key: 'lag', operator: 'not_equals' }, 500);

  const view = graph.context({ project: 'p' });
  assert.equal(view.openReviews.length, 0, 'a rule that states no operand is not a breach');
  assert.equal(graph.getReviewSignals({ project: 'p' }).length, 0, 'and raises no signal');

  const condition = view.conditionDiagnostics.flatMap((item) => item.conditions)[0];
  assert.ok(condition, 'the unevaluable condition is reported');
  assert.equal(condition.verdict, 'unknown');
  assert.equal(condition.operator, 'not_equals', 'the stored rule is reported, not rewritten');
});

test('the stored rule is never rewritten by evaluating it', () => {
  const graph = graphWithStoredRule({ key: 'lag', operator: 'not_equals' }, 500);
  graph.context({ project: 'p' });
  graph.maintain({});
  const stored = graph.exportData().records[0].alternatives[0].reopenWhen[0];
  assert.deepEqual(stored, { key: 'lag', operator: 'not_equals' }, 'no operand was synthesised');
});

// ---------------------------------------------------------------------------
// A -- historical reconstruction must fail closed.
// ---------------------------------------------------------------------------

// One decision whose single alternative carries `rule`, plus a pre-coverage
// acknowledged signal whose recorded breach is `historical`.
function graphWithLegacySignal({ rule, historical, factValue }) {
  const seed = createShadowGraph();
  seed.addDecision({
    project: 'p', id: 'decision:d1', title: 't', chosen: 'c',
    // Seeded with a valid rule, then replaced in the snapshot: write-time
    // validation rejects an operandless rule, so only the lenient import path
    // can carry one.
    alternatives: [{ id: 'alternative:a1', label: 'alt-1', reasonRejected: 'r', reopenWhen: [{ key: 'lag', operator: 'gte', value: 1 }] }]
  });
  const snapshot = seed.exportData();
  snapshot.records[0].alternatives[0].reopenWhen = [rule];
  snapshot.reviewSignals = [{
    id: 'review:legacy',
    kind: 'review',
    decisionId: 'decision:d1',
    title: 't',
    reason: 'lag',
    alternativesToReconsider: ['alt-1'],
    violatedConditions: [{
      decisionId: 'decision:d1',
      alternativeId: 'alternative:a1',
      alternativeLabel: 'alt-1',
      key: 'lag',
      verdict: 'true',
      reason: 'historical',
      ...historical
    }],
    status: 'acknowledged',
    createdAt: '2026-01-01T00:00:00.000Z',
    acknowledgedAt: '2026-01-02T00:00:00.000Z'
  }];
  const graph = createShadowGraph();
  graph.importData(snapshot);
  graph.addFact({ project: 'p', key: 'lag', value: factValue, id: 'fact:lag' });
  return graph;
}

const reviewStatus = (graph) => graph.context({ project: 'p' }).openReviews[0]?.reviewSignalStatus ?? 'none';
const legacyOf = (graph) => graph.getReviewSignals({ project: 'p' }).find((item) => item.id === 'review:legacy');

test('a historical condition missing its expected operand is not reconstructable', () => {
  const graph = graphWithLegacySignal({
    rule: { key: 'lag', operator: 'gte', value: 500 },
    historical: { operator: 'gte' },
    factValue: 600
  });
  assert.equal(reviewStatus(graph), 'open', 'an unreconstructable history acknowledges nothing');
  assert.equal(legacyOf(graph).status, 'acknowledged', 'and the legacy signal is preserved');
  assert.equal(legacyOf(graph).coverage, undefined);
});

test('an undefined operand cannot be persisted at all, so it never reaches reconstruction', () => {
  // Stored state is plain JSON, and `undefined` is not. This is asserted so the
  // reconstruction guard is not mistaken for the only thing standing between an
  // undefined operand and a coverage identity.
  assert.throws(
    () => graphWithLegacySignal({
      rule: { key: 'lag', operator: 'gte', value: 500 },
      historical: { operator: 'gte', expected: undefined },
      factValue: 600
    }),
    /plain JSON data/
  );
});

// The exact missing-operand regression, end to end: the current rule states no
// operand, and the legacy acknowledged signal's historical condition states none
// either, so both sides truncate to the same shape once `undefined` is dropped
// by JSON.stringify.
test('a rule with no operand cannot inherit a legacy acknowledgement', () => {
  const graph = graphWithLegacySignal({
    rule: { key: 'lag', operator: 'not_equals' },
    historical: { operator: 'not_equals' },
    factValue: 500
  });

  assert.equal(graph.context({ project: 'p' }).openReviews.length, 0, 'a rule stating no operand is not a breach at all');
  assert.equal(reviewStatus(graph), 'none');
  const condition = graph.context({ project: 'p' }).conditionDiagnostics.flatMap((item) => item.conditions)[0];
  assert.equal(condition.verdict, 'unknown', 'it is reported as unevaluable');
  assert.equal(legacyOf(graph).status, 'acknowledged', 'and the legacy signal is untouched');
  assert.equal(legacyOf(graph).coverage, undefined);
});

test('an operandless rule does not poison export or context', () => {
  const graph = graphWithStoredRule({ key: 'lag', operator: 'not_equals' }, 500);
  // Writing `value: undefined` during import used to make every later clone()
  // of the record throw, taking exportData() and context() down with it.
  assert.doesNotThrow(() => graph.exportData());
  assert.doesNotThrow(() => graph.context({ project: 'p' }));
  assert.deepEqual(
    graph.exportData().records[0].alternatives[0].reopenWhen[0],
    { key: 'lag', operator: 'not_equals' },
    'and the rule round-trips exactly as stored'
  );
});

test('a caller cannot write a rule with no operand, and is told why', () => {
  const graph = createShadowGraph();
  assert.throws(
    () => graph.addDecision({
      project: 'p', title: 't', chosen: 'c',
      alternatives: [{ label: 'a', reasonRejected: 'r', reopenWhen: [{ key: 'lag', operator: 'not_equals' }] }]
    }),
    /A structured rule requires a value for operator not_equals/
  );
  assert.throws(
    () => graph.addAttempt({
      project: 'p', solution: 's', result: 'failed',
      reusableWhen: [{ key: 'lag', operator: 'equals' }]
    }),
    /A structured rule requires a value for operator equals/
  );
});

test('a historical collection operator with no collection is not reconstructable', () => {
  for (const historical of [{ operator: 'in' }, { operator: 'in', expected: null }, { operator: 'not_in', expected: 'nope' }]) {
    const graph = graphWithLegacySignal({
      rule: { key: 'lag', operator: 'in', value: [500] },
      historical,
      factValue: 500
    });
    assert.equal(reviewStatus(graph), 'open', `${JSON.stringify(historical)} must not acknowledge`);
    assert.equal(legacyOf(graph).status, 'acknowledged');
  }
});

test('a historical range missing a bound is not reconstructable', () => {
  for (const historical of [{ operator: 'between', expected: [500] }, { operator: 'between', expected: [500, 600, 700] }, { operator: 'between' }]) {
    const graph = graphWithLegacySignal({
      rule: { key: 'lag', operator: 'between', value: [500, 700] },
      historical,
      factValue: 600
    });
    assert.equal(reviewStatus(graph), 'open', `${JSON.stringify(historical)} must not acknowledge`);
  }
});

test('malformed historical operator metadata is not reconstructable', () => {
  for (const historical of [{ operator: { name: 'gte' }, expected: 500 }, { operator: 'nonsense', expected: 500 }, { expected: 500 }]) {
    const graph = graphWithLegacySignal({
      rule: { key: 'lag', operator: 'gte', value: 500 },
      historical,
      factValue: 600
    });
    assert.equal(reviewStatus(graph), 'open', `${JSON.stringify(historical)} must not acknowledge`);
    assert.equal(legacyOf(graph).status, 'acknowledged');
  }
});

test('a malformed historical unit is not reconstructable', () => {
  const graph = graphWithLegacySignal({
    rule: { key: 'lag', operator: 'gte', value: 500, unit: 'ms' },
    historical: { operator: 'gte', expected: 500, unit: { name: 'ms' } },
    factValue: 600
  });
  assert.equal(reviewStatus(graph), 'open');
});

test('an exact complete historical condition still preserves the acknowledgement', () => {
  const graph = graphWithLegacySignal({
    rule: { key: 'lag', operator: 'gte', value: 500 },
    historical: { operator: 'gte', expected: 500 },
    factValue: 600
  });
  assert.equal(reviewStatus(graph), 'acknowledged');
  assert.equal(graph.context({ project: 'p' }).openReviews[0].reviewSignalId, 'review:legacy');
});

test('a falsy historical operand is a real operand and still reconstructs', () => {
  const cases = [
    { operand: 0, fact: 0 },
    { operand: false, fact: false },
    { operand: '', fact: '' },
    { operand: null, fact: null }
  ];
  for (const { operand, fact } of cases) {
    const graph = graphWithLegacySignal({
      rule: { key: 'lag', operator: 'equals', value: operand },
      historical: { operator: 'equals', expected: operand },
      factValue: fact
    });
    assert.equal(reviewStatus(graph), 'acknowledged', `expected: ${JSON.stringify(operand)} must reconstruct`);
    assert.equal(graph.context({ project: 'p' }).openReviews[0].reviewSignalId, 'review:legacy');
  }
});

test('a historical unit is part of the reconstructed identity', () => {
  const matching = graphWithLegacySignal({
    rule: { key: 'lag', operator: 'gte', value: 500, unit: 'ms' },
    historical: { operator: 'gte', expected: 500, unit: 'ms' },
    factValue: 600
  });
  assert.equal(reviewStatus(matching), 'acknowledged', 'the same unit reconstructs');

  const mismatched = graphWithLegacySignal({
    rule: { key: 'lag', operator: 'gte', value: 500, unit: 'ms' },
    historical: { operator: 'gte', expected: 500 },
    factValue: 600
  });
  assert.equal(reviewStatus(mismatched), 'open', 'a dropped unit is a different condition');
});

// ---------------------------------------------------------------------------
// C -- compatibility.
// ---------------------------------------------------------------------------

test('an unreconstructable legacy signal survives a restart untouched', async (t) => {
  const directory = await scratchDirectory(t, 'operand-restart-');
  const store = createJsonFileStore(join(directory, 'graph.json'));
  const graph = graphWithLegacySignal({
    rule: { key: 'lag', operator: 'gte', value: 500 },
    historical: { operator: 'gte' },
    factValue: 600
  });
  assert.equal(reviewStatus(graph), 'open');
  await store.save(graph.exportData());

  const restored = createShadowGraph();
  restored.importData(await store.load());
  assert.equal(reviewStatus(restored), 'open', 'still open after a restart');
  const legacy = legacyOf(restored);
  assert.equal(legacy.status, 'acknowledged');
  assert.equal(legacy.acknowledgedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(legacy.coverage, undefined, 'and was never stamped');
});

test('operand handling is identical on JSON and SQLite', async (t) => {
  const directory = await scratchDirectory(t, 'operand-parity-');
  const source = graphWithLegacySignal({
    rule: { key: 'lag', operator: 'gte', value: 500 },
    historical: { operator: 'gte' },
    factValue: 600
  });
  const snapshot = source.exportData();
  const results = {};

  for (const backend of ['json', 'sqlite']) {
    await t.test(backend, backend === 'sqlite' ? SQLITE_TEST_OPTIONS : {}, async () => {
      const path = join(directory, backend === 'json' ? 'state.json' : 'state.db');
      let store = backend === 'json' ? createJsonFileStore(path) : await createSqliteStore(path);
      await store.save(snapshot);
      store.close?.();

      store = backend === 'json' ? createJsonFileStore(path) : await createSqliteStore(path);
      const durable = await store.load();
      store.close?.();

      const graph = createShadowGraph();
      graph.importData(durable);
      results[backend] = [reviewStatus(graph), legacyOf(graph).status, legacyOf(graph).coverage ?? 'absent'];
    });
  }

  if (results.json && results.sqlite) {
    assert.deepEqual(results.json, ['open', 'acknowledged', 'absent']);
    assert.deepEqual(results.sqlite, results.json, 'both stores agree');
  }
});

test('the compact list and acknowledge path settles the uncovered breach', () => {
  const graph = graphWithLegacySignal({
    rule: { key: 'lag', operator: 'gte', value: 500 },
    historical: { operator: 'gte' },
    factValue: 600
  });
  const listed = graph.context({ project: 'p' }).openReviews[0];
  assert.equal(listed.reviewSignalStatus, 'open');
  assert.notEqual(listed.reviewSignalId, 'review:legacy');

  graph.acknowledgeReview(listed.reviewSignalId);
  assert.equal(reviewStatus(graph), 'acknowledged');
  assert.equal(legacyOf(graph).acknowledgedAt, '2026-01-02T00:00:00.000Z', 'the historical record is untouched');
});
