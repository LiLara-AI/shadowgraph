import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRule, isSupportedOperator, RULE_OPERATORS } from '../src/condition-eval.js';

const verdict = (rule, value) => evaluateRule(rule, value).verdict;

// Values here are deliberately NOT the deployment/multi-user pair used by the
// docs example, so a passing suite cannot be an artefact of one fixture.

test('legacy operators keep their exact semantics for valid inputs', () => {
  assert.equal(verdict({ key: 'region', operator: 'equals', value: 'eu-west' }, 'eu-west'), 'true');
  assert.equal(verdict({ key: 'region', operator: 'equals', value: 'eu-west' }, 'us-east'), 'false');
  assert.equal(verdict({ key: 'region', operator: 'not_equals', value: 'eu-west' }, 'us-east'), 'true');
  assert.equal(verdict({ key: 'tier', operator: 'contains', value: 'gold' }, 'gold-plus'), 'true');
  assert.equal(verdict({ key: 'tags', operator: 'contains', value: 'urgent' }, ['urgent', 'ops']), 'true');
  assert.equal(verdict({ key: 'tags', operator: 'contains', value: 'urgent' }, ['ops']), 'false');
  assert.equal(verdict({ key: 'replicas', operator: 'greater_than', value: 3 }, 7), 'true');
  assert.equal(verdict({ key: 'replicas', operator: 'greater_than', value: 3 }, 2), 'false');
  assert.equal(verdict({ key: 'replicas', operator: 'less_than', value: 3 }, 2), 'true');
});

test('an unsupported operator is unknown, not a silent false', () => {
  // Previously `return false`, so a typo meant the condition could never fire
  // and nothing reported it.
  const result = evaluateRule({ key: 'replicas', operator: 'greaterThan', value: 3 }, 9);
  assert.equal(result.verdict, 'unknown');
  assert.match(result.reason, /Unsupported operator/);
  assert.equal(isSupportedOperator('greaterThan'), false);
  assert.equal(isSupportedOperator('greater_than'), true);
});

test('a stored operator that was inert becomes evaluable, and that is a behaviour change', () => {
  // `gte` was not in the old operator list, so it fell through to `return false`
  // on every evaluation. It now evaluates. Recorded as an intentional change.
  assert.equal(verdict({ key: 'replicas', operator: 'gte', value: 3 }, 3), 'true');
  assert.equal(verdict({ key: 'replicas', operator: 'gte', value: 3 }, 2), 'false');
  assert.equal(verdict({ key: 'replicas', operator: 'lte', value: 3 }, 3), 'true');
});

test('a number carrying an unreadable unit is unknown rather than false', () => {
  // Number('250ms') is NaN and NaN > 200 is false, so the old evaluator called
  // this "no review needed".
  const bare = evaluateRule({ key: 'p99', operator: 'greater_than', value: 200 }, '250ms');
  assert.equal(bare.verdict, 'unknown');
  assert.match(bare.reason, /not comparable to the rule unit/);

  // With the rule declaring its unit, the same observation is decidable.
  assert.equal(verdict({ key: 'p99', operator: 'greater_than', value: 200, unit: 'ms' }, '250ms'), 'true');
  assert.equal(verdict({ key: 'p99', operator: 'greater_than', value: 200, unit: 'ms' }, '150ms'), 'false');
});

test('units convert within a dimension and refuse across dimensions', () => {
  assert.equal(verdict({ key: 'timeout', operator: 'greater_than', value: 500, unit: 'ms' }, '2s'), 'true');
  assert.equal(verdict({ key: 'timeout', operator: 'less_than', value: 2, unit: 's' }, '900ms'), 'true');
  // duration rule against a percent value: different dimension, never guessed.
  const crossed = evaluateRule({ key: 'timeout', operator: 'greater_than', value: 1, unit: 's' }, '40%');
  assert.equal(crossed.verdict, 'unknown');
  // an unrecognised unit on the rule itself
  assert.equal(verdict({ key: 'size', operator: 'greater_than', value: 1, unit: 'furlong' }, 5), 'unknown');
});

test('a bare number is read in the rule declared unit, and a united value against a unitless rule is refused', () => {
  // The rule states the unit of comparison. That is declaration, not inference.
  assert.equal(verdict({ key: 'budget', operator: 'greater_than', value: 1, unit: 'min' }, 2), 'true');
  // The reverse is inference, so it is refused.
  assert.equal(verdict({ key: 'budget', operator: 'greater_than', value: 1000 }, '30s'), 'unknown');
});

test('dates compare only as ISO instants, never as prose', () => {
  assert.equal(verdict({ key: 'certExpiry', operator: 'less_than', value: '2026-06-01T00:00:00Z' }, '2026-03-01T00:00:00Z'), 'true');
  assert.equal(verdict({ key: 'certExpiry', operator: 'greater_than', value: '2026-06-01T00:00:00Z' }, '2026-03-01T00:00:00Z'), 'false');
  const mixed = evaluateRule({ key: 'certExpiry', operator: 'less_than', value: '2026-06-01T00:00:00Z' }, 'next June');
  assert.equal(mixed.verdict, 'unknown');
  assert.match(mixed.reason, /timestamp/);
  assert.equal(verdict({ key: 'certExpiry', operator: 'less_than', value: 'soon' }, '2026-03-01T00:00:00Z'), 'unknown');
});

test('between is inclusive at both ends and says so', () => {
  const rule = { key: 'errorRate', operator: 'between', value: [2, 5] };
  assert.equal(verdict(rule, 2), 'true', 'low bound inclusive');
  assert.equal(verdict(rule, 5), 'true', 'high bound inclusive');
  assert.equal(verdict(rule, 3.5), 'true');
  assert.equal(verdict(rule, 1.999), 'false');
  assert.equal(verdict(rule, 5.001), 'false');
  assert.equal(verdict({ key: 'errorRate', operator: 'between', value: [2] }, 3), 'unknown');
  assert.equal(verdict({ key: 'errorRate', operator: 'between', value: 2 }, 3), 'unknown');
});

test('categorical membership is explicit and a non-array is unknown', () => {
  assert.equal(verdict({ key: 'provider', operator: 'in', value: ['aws', 'gcp'] }, 'gcp'), 'true');
  assert.equal(verdict({ key: 'provider', operator: 'in', value: ['aws', 'gcp'] }, 'azure'), 'false');
  assert.equal(verdict({ key: 'provider', operator: 'not_in', value: ['aws', 'gcp'] }, 'azure'), 'true');
  assert.equal(verdict({ key: 'provider', operator: 'in', value: 'aws' }, 'aws'), 'unknown');
});

test('null and empty observations are unknown for ordered operators, never false', () => {
  assert.equal(verdict({ key: 'replicas', operator: 'greater_than', value: 3 }, null), 'unknown');
  assert.equal(verdict({ key: 'replicas', operator: 'greater_than', value: 3 }, ''), 'unknown');
  assert.equal(verdict({ key: 'replicas', operator: 'greater_than', value: 3 }, undefined), 'unknown');
  assert.equal(verdict({ key: 'replicas', operator: 'greater_than', value: 3 }, {}), 'unknown');
  assert.equal(verdict({ key: 'replicas', operator: 'greater_than', value: 3 }, Number.NaN), 'unknown');
});

test('a verdict explains itself with the operator, expected value and observation', () => {
  const result = evaluateRule({ key: 'p99', operator: 'gte', value: 200, unit: 'ms' }, '350ms');
  assert.equal(result.verdict, 'true');
  assert.equal(result.key, 'p99');
  assert.equal(result.operator, 'gte');
  assert.equal(result.expected, 200);
  assert.equal(result.actual, '350ms');
  assert.equal(result.unit, 'ms');
  assert.ok(result.reason.length > 0);
});

test('a malformed rule is unknown and the legacy token form is preserved', () => {
  assert.equal(verdict(null, 'anything'), 'unknown');
  assert.equal(verdict([1, 2], 'anything'), 'unknown');
  // Token form: review() matches these against changedFacts, but the branch is
  // kept so behaviour does not change for any caller that reaches it.
  assert.equal(verdict('deployment', true), 'true');
  assert.equal(verdict('deployment', 'deployment'), 'true');
  assert.equal(verdict('deployment', 'other'), 'false');
});

test('every advertised operator has an evaluation path', () => {
  for (const operator of RULE_OPERATORS) {
    const value = operator === 'in' || operator === 'not_in' ? ['x'] : operator === 'between' ? [1, 2] : 1;
    const result = evaluateRule({ key: 'k', operator, value }, 1);
    assert.ok(!result.reason.includes('has no evaluation path'));
    assert.ok(['true', 'false', 'unknown'].includes(result.verdict));
  }
});
