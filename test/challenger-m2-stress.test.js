import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import {
  resolveRuleAliases,
  ruleOperandIssue,
  evaluateRule,
  formatRuleCompact,
  parseConditionString,
  normalizeOperator
} from '../src/condition-eval.js';
import {
  buildToolCatalog,
  selectTools
} from '../src/mcp-tools.js';

test('Challenger M2 Stress: Null-prototype rule objects and prototype pollution resistance', () => {
  // Null prototype object with target and expected
  const nullProtoRule = Object.create(null);
  nullProtoRule.target = 'load';
  nullProtoRule.operator = '>';
  nullProtoRule.expected = 50;

  const res = resolveRuleAliases(nullProtoRule);
  assert.equal(res.key, 'load');
  assert.equal(res.value, 50);
  assert.equal(res.hasValue, true);
  assert.equal(ruleOperandIssue(nullProtoRule), null);
  assert.equal(evaluateRule(nullProtoRule, 60).verdict, 'true');

  // Object with inherited prototype properties
  const proto = { key: 'protoKey', value: 999 };
  const inheritedRule = Object.create(proto);
  inheritedRule.target = 'realTarget';
  inheritedRule.expected = 123;

  // Object.hasOwn ignores inherited properties!
  const resInherited = resolveRuleAliases(inheritedRule);
  assert.equal(resInherited.key, 'realTarget');
  assert.equal(resInherited.value, 123);
});

test('Challenger M2 Stress: Whitespace and case-sensitivity boundary checks', () => {
  // Key and target differing by whitespace
  assert.throws(
    () => resolveRuleAliases({ key: 'metric', target: 'metric ', expected: 1 }),
    /conflict/i
  );

  // Key and target differing by case
  assert.throws(
    () => resolveRuleAliases({ key: 'metric', target: 'METRIC', expected: 1 }),
    /conflict/i
  );

  // Value and expected differing by case in strings
  assert.throws(
    () => resolveRuleAliases({ target: 'env', value: 'Production', expected: 'production' }),
    /conflict/i
  );
});

test('Challenger M2 Stress: Strict rejection of empty strings and invalid types in normalizeRules', () => {
  const sg = createShadowGraph();

  // Empty string key/target
  assert.throws(
    () => sg.addDecision({
      project: 'p',
      title: 'T',
      chosen: 'C',
      reopenWhen: [{ target: '', expected: 10 }]
    }),
    /non-empty key/i
  );

  assert.throws(
    () => sg.addDecision({
      project: 'p',
      title: 'T',
      chosen: 'C',
      reopenWhen: [{ target: '   ', expected: 10 }]
    }),
    /non-empty key/i
  );

  // Missing key/target entirely
  assert.throws(
    () => sg.addDecision({
      project: 'p',
      title: 'T',
      chosen: 'C',
      reopenWhen: [{ operator: '>', expected: 10 }]
    }),
    /non-empty key/i
  );

  // Missing operand (neither value nor expected)
  assert.throws(
    () => sg.addDecision({
      project: 'p',
      title: 'T',
      chosen: 'C',
      reopenWhen: [{ target: 'cpu', operator: '>' }]
    }),
    /requires a value/i
  );

  // Unsupported operator
  assert.throws(
    () => sg.addDecision({
      project: 'p',
      title: 'T',
      chosen: 'C',
      reopenWhen: [{ target: 'cpu', operator: 'like', expected: '%fast%' }]
    }),
    /unsupported rule operator/i
  );

  // Unsupported unit
  assert.throws(
    () => sg.addDecision({
      project: 'p',
      title: 'T',
      chosen: 'C',
      reopenWhen: [{ target: 'cpu', operator: '>', expected: 10, unit: 'lightyears' }]
    }),
    /unsupported rule unit/i
  );
});

test('Challenger M2 Stress: Mixed strings, symbolic condition strings, and object rules in reopenWhen', () => {
  const sg = createShadowGraph();

  const dec = sg.addDecision({
    project: 'mixed-proj',
    title: 'Mixed Rule Decision',
    chosen: 'OptionA',
    reopenWhen: [
      'budget_reallocated',
      { target: 'error_rate', operator: '>=', expected: 0.05 },
      { key: 'latency', operator: '>', expected: 200 }
    ]
  });

  assert.ok(dec.id);
  assert.equal(dec.alternatives[0].reopenWhen.length, 3);
  assert.equal(dec.alternatives[0].reopenWhen[0], 'budget_reallocated');
  assert.equal(dec.alternatives[0].reopenWhen[1].key, 'error_rate');
  assert.equal(dec.alternatives[0].reopenWhen[1].operator, 'gte');
  assert.equal(dec.alternatives[0].reopenWhen[1].value, 0.05);
  assert.equal(dec.alternatives[0].reopenWhen[2].key, 'latency');
  assert.equal(dec.alternatives[0].reopenWhen[2].operator, 'greater_than');
  assert.equal(dec.alternatives[0].reopenWhen[2].value, 200);

  // Test firing plain string token via changedFacts
  const revToken = sg.review({
    project: 'mixed-proj',
    changedFacts: ['budget_reallocated']
  });
  assert.equal(revToken.items.length, 1);
  assert.ok(revToken.items[0].reason.includes('budget_reallocated'));

  // Test firing structured rule via durable fact
  sg.addFact({
    project: 'mixed-proj',
    key: 'error_rate',
    value: 0.08
  });
  const revFact = sg.review({ project: 'mixed-proj' });
  assert.equal(revFact.items.length, 1);
  assert.ok(revFact.items[0].reason.includes('error_rate'));
});

test('Challenger M2 Stress: Compact representation formatting for all operators with target/expected', () => {
  assert.equal(formatRuleCompact({ target: 'cpu', operator: '>=', expected: 90 }), 'cpu >= 90');
  assert.equal(formatRuleCompact({ target: 'mem', operator: '<=', expected: 50 }), 'mem <= 50');
  assert.equal(formatRuleCompact({ target: 'status', operator: '==', expected: 'ok' }), 'status == ok');
  assert.equal(formatRuleCompact({ target: 'status', operator: '!=', expected: 'down' }), 'status != down');
  assert.equal(formatRuleCompact({ target: 'time', operator: '>', expected: 10, unit: 's' }), 'time > 10s');
  assert.equal(formatRuleCompact({ target: 'queue', operator: '<', expected: 5 }), 'queue < 5');
  assert.equal(formatRuleCompact({ target: 'env', operator: 'in', expected: ['prod', 'qa'] }), 'env in ["prod","qa"]');
});

test('Challenger M2 Stress: Verify ALL 36 tools in verifierCatalog strictly obey character and structure limits', () => {
  const verifierCatalog = buildToolCatalog({ verifier: true });
  assert.equal(verifierCatalog.length, 36, 'Catalog with verifier contains exactly 36 tools');

  for (const tool of verifierCatalog) {
    const desc = tool.description;
    assert.ok(desc, `Tool ${tool.name} has description`);
    assert.ok(
      desc.length <= 450,
      `Tool ${tool.name} exceeds 450 characters (length: ${desc.length})`
    );
    assert.equal(desc.includes('\n'), false, `Tool ${tool.name} has newline in description`);
    assert.equal(desc.includes('\r'), false, `Tool ${tool.name} has CR in description`);
    assert.equal(desc.includes('  '), false, `Tool ${tool.name} has double space in description`);
    assert.equal(desc.trim(), desc, `Tool ${tool.name} has untrimmed description`);

    // Verify describe structure
    if (tool.describe) {
      assert.ok(tool.describe.does, `Tool ${tool.name} has describe.does`);
      assert.ok(tool.describe.route, `Tool ${tool.name} has describe.route`);
      if (!tool.annotations?.readOnlyHint) {
        assert.ok(tool.describe.effects, `Writing tool ${tool.name} has describe.effects`);
      }
    }
  }
});

test('Challenger M2 Stress: Verify selectTools workflow profile preserves descriptions and constraints', () => {
  const bareCatalog = buildToolCatalog({ verifier: false });
  const workflowCatalog = selectTools(bareCatalog, { profile: 'workflow' });

  assert.equal(workflowCatalog.length, 20, 'Workflow catalog contains exactly 20 tools');
  for (const tool of workflowCatalog) {
    assert.ok(
      tool.description.length <= 550, // SelectTools may qualify descriptions with full mode guidance
      `Workflow tool ${tool.name} description exceeds budget: ${tool.description.length}`
    );
  }
});
