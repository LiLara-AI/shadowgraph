import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import {
  resolveRuleAliases,
  ruleOperandIssue,
  evaluateRule,
  formatRuleCompact,
  isSupportedOperator,
  normalizeOperator
} from '../src/condition-eval.js';

// Deterministic Pseudo-Random Generator (LCG)
function createRng(seed = 123456789) {
  let s = seed;
  return function next() {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const OPERATORS = [
  'equals', '==', '===', '=',
  'not_equals', '!=', '!==', '<>',
  'greater_than', '>',
  'less_than', '<',
  'gte', '>=',
  'lte', '<=',
  'in', 'not_in',
  'between', 'contains'
];

test('Fuzz: 500 random condition alias permutations and conflict invariants', () => {
  const rng = createRng(42);

  const sampleKeys = ['cluster.load', 'mem.usage', 'api.lat_ms', 'db.pool', 'env.name', 'sys.status', 'worker.count'];
  const sampleValues = [0, 1, 100, -50, 3.14159, true, false, 'active', 'degraded', null, [1, 2], { region: 'us' }];

  for (let i = 0; i < 500; i++) {
    const keyChoice = Math.floor(rng() * sampleKeys.length);
    const altKeyChoice = Math.floor(rng() * sampleKeys.length);
    const valChoice = Math.floor(rng() * sampleValues.length);
    const altValChoice = Math.floor(rng() * sampleValues.length);

    const baseKey = sampleKeys[keyChoice];
    const diffKey = sampleKeys[altKeyChoice];
    const baseVal = sampleValues[valChoice];
    const diffVal = sampleValues[altValChoice];

    const hasKey = rng() > 0.5;
    const hasTarget = rng() > 0.5 || !hasKey; // Ensure at least one key property
    const hasValue = rng() > 0.5;
    const hasExpected = rng() > 0.5 || !hasValue; // Ensure at least one value property

    // Subcase A: Non-conflicting
    const validRule = {};
    if (hasKey) validRule.key = baseKey;
    if (hasTarget) validRule.target = baseKey;
    if (hasValue) validRule.value = baseVal;
    if (hasExpected) validRule.expected = baseVal;

    const resolved = resolveRuleAliases(validRule);
    assert.equal(resolved.key, baseKey);
    assert.deepEqual(resolved.value, baseVal);
    assert.equal(resolved.hasValue, true);

    // Subcase B: Conflicting keys (if different keys chosen)
    if (baseKey !== diffKey) {
      const conflictKeyRule = {
        key: baseKey,
        target: diffKey,
        value: baseVal
      };
      assert.throws(
        () => resolveRuleAliases(conflictKeyRule),
        /conflict/i,
        `Expected conflict error for key=${baseKey} vs target=${diffKey}`
      );
    }

    // Subcase C: Conflicting values (if different values chosen)
    if (JSON.stringify(baseVal) !== JSON.stringify(diffVal)) {
      const conflictValRule = {
        key: baseKey,
        value: baseVal,
        expected: diffVal
      };
      assert.throws(
        () => resolveRuleAliases(conflictValRule),
        /conflict/i,
        `Expected conflict error for value=${JSON.stringify(baseVal)} vs expected=${JSON.stringify(diffVal)}`
      );
    }
  }
});

test('Stress: 100 Sequential ShadowGraph decisions with alias reopen rules and fact mutations', () => {
  const graph = createShadowGraph();
  const rng = createRng(999);
  const decisionIds = [];

  for (let i = 0; i < 100; i++) {
    const threshold = Math.floor(rng() * 100);
    const useTarget = rng() > 0.5;
    const useExpected = rng() > 0.5;

    const reopenRule = {};
    if (useTarget) reopenRule.target = `metric_${i}`;
    else reopenRule.key = `metric_${i}`;

    reopenRule.operator = '>';

    if (useExpected) reopenRule.expected = threshold;
    else reopenRule.value = threshold;

    const dec = graph.addDecision({
      project: 'stress-proj',
      title: `Decision ${i}`,
      chosen: `Choice ${i}`,
      reopenWhen: [reopenRule]
    });

    decisionIds.push({ id: dec.id, metric: `metric_${i}`, threshold });
  }

  // Initial review with zero facts: no decision should fire
  const initialReview = graph.review({ project: 'stress-proj' });
  assert.equal(initialReview.items.length, 0);

  // Now mutate facts: breach half of the decisions
  let expectedBreachedCount = 0;
  for (let i = 0; i < decisionIds.length; i++) {
    const { metric, threshold } = decisionIds[i];
    if (i % 2 === 0) {
      // Breach condition: metric > threshold
      graph.addFact({
        project: 'stress-proj',
        key: metric,
        value: threshold + 10
      });
      expectedBreachedCount++;
    } else {
      // Stay within condition: metric <= threshold
      graph.addFact({
        project: 'stress-proj',
        key: metric,
        value: threshold - 1
      });
    }
  }

  const reviewResult = graph.review({ project: 'stress-proj' });
  assert.equal(
    reviewResult.items.length,
    expectedBreachedCount,
    `Expected ${expectedBreachedCount} breached decisions to fire, got ${reviewResult.items.length}`
  );

  const breachedSet = new Set(reviewResult.items.map((it) => it.decisionId));
  for (let i = 0; i < decisionIds.length; i++) {
    if (i % 2 === 0) {
      assert.ok(breachedSet.has(decisionIds[i].id), `Decision ${i} should have breached`);
    } else {
      assert.ok(!breachedSet.has(decisionIds[i].id), `Decision ${i} should not have breached`);
    }
  }
});

test('Stress: 100 Sequential ShadowGraph attempts with reusableWhen aliases', () => {
  const graph = createShadowGraph();

  for (let i = 0; i < 100; i++) {
    const att = graph.addAttempt({
      project: 'stress-attempts',
      solution: `Solution ${i}`,
      result: `Result ${i}`,
      resultClass: i % 2 === 0 ? 'succeeded' : 'failed',
      reusableWhen: [
        {
          target: `dep.version_${i}`,
          operator: '==',
          expected: `v${i}.0`
        }
      ]
    });

    assert.ok(att.id);
    assert.equal(att.reusableWhen[0].key, `dep.version_${i}`);
    assert.equal(att.reusableWhen[0].value, `v${i}.0`);
  }

  const ctx = graph.context({ project: 'stress-attempts' });
  assert.ok(ctx);
});
