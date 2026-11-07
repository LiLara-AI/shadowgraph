import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import {
  resolveRuleAliases,
  ruleOperandIssue,
  evaluateRule,
  formatRuleCompact
} from '../src/condition-eval.js';

test('resolveRuleAliases extracts and normalizes aliases', () => {
  // target -> key
  const r1 = resolveRuleAliases({ target: 'sys.load', operator: '>', expected: 80 });
  assert.equal(r1.key, 'sys.load');
  assert.equal(r1.value, 80);
  assert.equal(r1.hasValue, true);

  // key and value
  const r2 = resolveRuleAliases({ key: 'sys.load', operator: '>', value: 80 });
  assert.equal(r2.key, 'sys.load');
  assert.equal(r2.value, 80);
  assert.equal(r2.hasValue, true);

  // Identical non-conflicting key and target
  const r3 = resolveRuleAliases({ key: 'sys.load', target: 'sys.load', value: 80, expected: 80 });
  assert.equal(r3.key, 'sys.load');
  assert.equal(r3.value, 80);

  // Falsy values
  const r4 = resolveRuleAliases({ target: 'enabled', expected: false });
  assert.equal(r4.key, 'enabled');
  assert.equal(r4.value, false);
  assert.equal(r4.hasValue, true);

  const r5 = resolveRuleAliases({ target: 'count', expected: 0 });
  assert.equal(r5.key, 'count');
  assert.equal(r5.value, 0);
  assert.equal(r5.hasValue, true);
});

test('resolveRuleAliases rejects conflicting aliases', () => {
  // Conflicting key and target
  assert.throws(
    () => resolveRuleAliases({ key: 'status', target: 'state', value: 1 }),
    /conflict/i
  );

  // Conflicting value and expected
  assert.throws(
    () => resolveRuleAliases({ key: 'status', value: 'active', expected: 'inactive' }),
    /conflict/i
  );

  // Conflicting arrays
  assert.throws(
    () => resolveRuleAliases({ target: 'status', value: [1, 2], expected: [1, 3] }),
    /conflict/i
  );

  // Both conflicting
  assert.throws(
    () => resolveRuleAliases({ key: 'a', target: 'b', value: 1, expected: 2 }),
    /conflict/i
  );
});

test('ruleOperandIssue validates rules using aliases', () => {
  // Missing operand with target
  const issue1 = ruleOperandIssue({ target: 'db.conn', operator: '==' });
  assert.match(issue1, /has no value/i);

  // Present operand with expected
  const issue2 = ruleOperandIssue({ target: 'db.conn', operator: '==', expected: 5 });
  assert.equal(issue2, null);

  // Conflicting aliases should propagate conflict error
  assert.throws(
    () => ruleOperandIssue({ key: 'a', target: 'b', operator: '==' }),
    /conflict/i
  );
});

test('evaluateRule evaluates conditions using aliases', () => {
  const rule = { target: 'cluster.nodes', operator: '>=', expected: 3 };
  assert.equal(evaluateRule(rule, 4).verdict, 'true');
  assert.equal(evaluateRule(rule, 2).verdict, 'false');

  // Strict inequality
  const neRule = { target: 'status', operator: '!=', expected: 'ok' };
  assert.equal(evaluateRule(neRule, 'degraded').verdict, 'true');
  assert.equal(evaluateRule(neRule, 'ok').verdict, 'false');

  // In collection
  const inRule = { target: 'region', operator: 'in', expected: ['us-east', 'eu-west'] };
  assert.equal(evaluateRule(inRule, 'us-east').verdict, 'true');
  assert.equal(evaluateRule(inRule, 'ap-south').verdict, 'false');
});

test('formatRuleCompact renders rule with target and expected aliases', () => {
  const formatted = formatRuleCompact({ target: 'db.status', operator: '==', expected: 'ready' });
  assert.equal(formatted, 'db.status == ready');
});

test('resolveRuleAliases converts aliases to canonical key and value', () => {
  const normalized = resolveRuleAliases({ target: 'api.rate', operator: '<=', expected: 100 });
  assert.equal(normalized.key, 'api.rate');
  assert.equal(normalized.value, 100);
});

test('ShadowGraph decision and attempt creation with aliases and conflict rejection', () => {
  const graph = createShadowGraph();

  // Create decision with target/expected
  const dec = graph.addDecision({
    project: 'm2-test',
    title: 'Deployment Strategy',
    chosen: 'Blue-Green',
    reopenWhen: [{ target: 'cluster.health', operator: '!=', expected: 'healthy' }]
  });
  assert.ok(dec && dec.id);
  assert.ok(dec.alternatives.length > 0);
  assert.equal(dec.alternatives[0].reopenWhen[0].key, 'cluster.health');
  assert.equal(dec.alternatives[0].reopenWhen[0].value, 'healthy');

  // Create attempt with target/expected reusableWhen
  const att = graph.addAttempt({
    project: 'm2-test',
    solution: 'Use canary deployment',
    result: 'Canary failed due to memory spike',
    resultClass: 'failed',
    reusableWhen: [{ target: 'memory.limit', operator: '>=', expected: '4Gi' }]
  });
  assert.ok(att && att.id);
  assert.equal(att.reusableWhen[0].key, 'memory.limit');
  assert.equal(att.reusableWhen[0].value, '4Gi');

  // Conflicting reopenWhen in decision creation rejected
  assert.throws(
    () => {
      graph.addDecision({
        project: 'm2-test',
        title: 'Conflict Decision',
        chosen: 'Opt',
        reopenWhen: [{ key: 'k1', target: 'k2', value: 'v1' }]
      });
    },
    /conflict/i
  );

  // Conflicting reusableWhen in attempt creation rejected
  assert.throws(
    () => {
      graph.addAttempt({
        project: 'm2-test',
        solution: 'Some solution',
        result: 'Some result',
        reusableWhen: [{ key: 'k1', target: 'k1', value: 'v1', expected: 'v2' }]
      });
    },
    /conflict/i
  );
});
