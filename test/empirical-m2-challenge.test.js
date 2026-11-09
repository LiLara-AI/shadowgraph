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
import { buildToolCatalog, selectTools } from '../src/mcp-tools.js';

// ============================================================================
// SUITE 1: Condition Alias Variations & Conflict Rejection
// ============================================================================
test('Condition aliases: target-only and expected-only variations', () => {
  // 1. Only target + only expected
  const r1 = resolveRuleAliases({ target: 'memory.free', operator: '>=', expected: 1024 });
  assert.equal(r1.key, 'memory.free');
  assert.equal(r1.value, 1024);
  assert.equal(r1.hasValue, true);

  // 2. Only target + only value
  const r2 = resolveRuleAliases({ target: 'memory.free', operator: '>=', value: 1024 });
  assert.equal(r2.key, 'memory.free');
  assert.equal(r2.value, 1024);
  assert.equal(r2.hasValue, true);

  // 3. Only key + only expected
  const r3 = resolveRuleAliases({ key: 'memory.free', operator: '>=', expected: 1024 });
  assert.equal(r3.key, 'memory.free');
  assert.equal(r3.value, 1024);
  assert.equal(r3.hasValue, true);

  // 4. Only key + only value
  const r4 = resolveRuleAliases({ key: 'memory.free', operator: '>=', value: 1024 });
  assert.equal(r4.key, 'memory.free');
  assert.equal(r4.value, 1024);
  assert.equal(r4.hasValue, true);

  // 5. Matching key and target (identical)
  const r5 = resolveRuleAliases({ key: 'db.pool', target: 'db.pool', value: 10, expected: 10 });
  assert.equal(r5.key, 'db.pool');
  assert.equal(r5.value, 10);
  assert.equal(r5.hasValue, true);

  // 6. Conflicting key and target
  assert.throws(
    () => resolveRuleAliases({ key: 'db.pool', target: 'db.conn', expected: 10 }),
    /conflict/i,
    'Conflicting key and target must throw error matching /conflict/i'
  );

  // 7. Conflicting value and expected
  assert.throws(
    () => resolveRuleAliases({ target: 'db.pool', value: 10, expected: 20 }),
    /conflict/i,
    'Conflicting value and expected must throw error matching /conflict/i'
  );

  // 8. Conflicting both key/target and value/expected
  assert.throws(
    () => resolveRuleAliases({ key: 'k1', target: 'k2', value: 1, expected: 2 }),
    /conflict/i,
    'Conflicting both key/target and value/expected must throw error matching /conflict/i'
  );
});

test('Condition aliases: falsy values and null edge cases', () => {
  // Value 0 vs Expected 0 (matching)
  const rZero = resolveRuleAliases({ target: 'retryCount', expected: 0, value: 0 });
  assert.equal(rZero.value, 0);

  // Value 0 vs Expected 1 (conflicting)
  assert.throws(() => resolveRuleAliases({ target: 'retryCount', value: 0, expected: 1 }), /conflict/i);

  // Value 0 vs Expected '0' (conflicting type)
  assert.throws(() => resolveRuleAliases({ target: 'retryCount', value: 0, expected: '0' }), /conflict/i);

  // False vs False (matching)
  const rFalse = resolveRuleAliases({ target: 'maintenance', expected: false, value: false });
  assert.equal(rFalse.value, false);

  // False vs True (conflicting)
  assert.throws(() => resolveRuleAliases({ target: 'maintenance', value: false, expected: true }), /conflict/i);

  // False vs 0 (conflicting type/identity)
  assert.throws(() => resolveRuleAliases({ target: 'maintenance', value: false, expected: 0 }), /conflict/i);

  // Empty string matching
  const rEmpty = resolveRuleAliases({ target: 'prefix', expected: '', value: '' });
  assert.equal(rEmpty.value, '');

  // Empty string conflicting
  assert.throws(() => resolveRuleAliases({ target: 'prefix', value: '', expected: ' ' }), /conflict/i);

  // Null matching
  const rNull = resolveRuleAliases({ target: 'lock', expected: null, value: null });
  assert.equal(rNull.value, null);

  // Null vs undefined (undefined is treated as absent)
  const rNullUndef = resolveRuleAliases({ target: 'lock', expected: null, value: undefined });
  assert.equal(rNullUndef.value, null);
  assert.equal(rNullUndef.hasValue, true);

  // Null vs false (conflicting)
  assert.throws(() => resolveRuleAliases({ target: 'lock', value: null, expected: false }), /conflict/i);
});

test('Condition aliases: nested arrays and objects conflict detection', () => {
  // Arrays matching
  const rArr = resolveRuleAliases({ target: 'zones', value: ['us-east', 'us-west'], expected: ['us-east', 'us-west'] });
  assert.deepEqual(rArr.value, ['us-east', 'us-west']);

  // Arrays conflicting
  assert.throws(
    () => resolveRuleAliases({ target: 'zones', value: ['us-east', 'us-west'], expected: ['us-east', 'eu-central'] }),
    /conflict/i
  );

  // Arrays different order (JSON representation differs)
  assert.throws(
    () => resolveRuleAliases({ target: 'zones', value: ['a', 'b'], expected: ['b', 'a'] }),
    /conflict/i
  );

  // Objects matching
  const rObj = resolveRuleAliases({ target: 'meta', value: { env: 'prod', v: 1 }, expected: { env: 'prod', v: 1 } });
  assert.deepEqual(rObj.value, { env: 'prod', v: 1 });

  // Objects conflicting
  assert.throws(
    () => resolveRuleAliases({ target: 'meta', value: { env: 'prod' }, expected: { env: 'stage' } }),
    /conflict/i
  );
});

test('Condition aliases: operand issues and non-structured inputs', () => {
  // Missing operand with target
  assert.match(ruleOperandIssue({ target: 'disk.free' }), /has no value/i);

  // Operand provided via expected
  assert.equal(ruleOperandIssue({ target: 'disk.free', expected: 50 }), null);

  // Array operand issue with `in` operator
  assert.match(ruleOperandIssue({ target: 'env', operator: 'in', expected: 'prod' }), /requires an array/i);
  assert.equal(ruleOperandIssue({ target: 'env', operator: 'in', expected: ['prod', 'stage'] }), null);

  // Range operand issue with `between` operator
  assert.match(ruleOperandIssue({ target: 'ratio', operator: 'between', expected: [1] }), /two-element/i);
  assert.equal(ruleOperandIssue({ target: 'ratio', operator: 'between', expected: [1, 10] }), null);

  // Non-object rules
  assert.equal(ruleOperandIssue(null), 'Rule is not a structured object');
  assert.equal(ruleOperandIssue('just a string'), 'Rule is not a structured object');
  assert.equal(ruleOperandIssue(['not', 'an', 'object']), 'Rule is not a structured object');
});

// ============================================================================
// SUITE 2: Complex Operators & Comparison Logic
// ============================================================================
test('Operators: >= (gte) comparisons', () => {
  const rule = { target: 'sys.load', operator: '>=', expected: 80 };
  assert.equal(evaluateRule(rule, 80).verdict, 'true', 'equal bound should be true');
  assert.equal(evaluateRule(rule, 81).verdict, 'true', 'greater should be true');
  assert.equal(evaluateRule(rule, 79).verdict, 'false', 'lesser should be false');

  // With units
  const durationRule = { target: 'elapsed', operator: '>=', expected: 5, unit: 's' };
  assert.equal(evaluateRule(durationRule, '5000ms').verdict, 'true');
  assert.equal(evaluateRule(durationRule, '5001ms').verdict, 'true');
  assert.equal(evaluateRule(durationRule, '4999ms').verdict, 'false');
});

test('Operators: <= (lte) comparisons', () => {
  const rule = { target: 'error.rate', operator: '<=', expected: 0.05 };
  assert.equal(evaluateRule(rule, 0.05).verdict, 'true', 'equal bound should be true');
  assert.equal(evaluateRule(rule, 0.04).verdict, 'true', 'lesser should be true');
  assert.equal(evaluateRule(rule, 0.06).verdict, 'false', 'greater should be false');

  // Percent unit
  const pctRule = { target: 'cache.misses', operator: '<=', expected: 10, unit: '%' };
  assert.equal(evaluateRule(pctRule, '10%').verdict, 'true');
  assert.equal(evaluateRule(pctRule, '5%').verdict, 'true');
  assert.equal(evaluateRule(pctRule, '15%').verdict, 'false');
});

test('Operators: ==, ===, = (equals) comparisons', () => {
  const rule1 = { target: 'status', operator: '==', expected: 'active' };
  assert.equal(evaluateRule(rule1, 'active').verdict, 'true');
  assert.equal(evaluateRule(rule1, 'inactive').verdict, 'false');

  const rule2 = { target: 'status', operator: '===', expected: 'active' };
  assert.equal(evaluateRule(rule2, 'active').verdict, 'true');

  const rule3 = { target: 'status', operator: '=', expected: 'active' };
  assert.equal(evaluateRule(rule3, 'active').verdict, 'true');

  // Strict equality test
  const numRule = { target: 'id', operator: '==', expected: 42 };
  assert.equal(evaluateRule(numRule, 42).verdict, 'true');
  assert.equal(evaluateRule(numRule, '42').verdict, 'false', 'Strict equality must distinguish number from string');
});

test('Operators: !=, !==, <> (not_equals) comparisons', () => {
  const rule1 = { target: 'state', operator: '!=', expected: 'healthy' };
  assert.equal(evaluateRule(rule1, 'degraded').verdict, 'true');
  assert.equal(evaluateRule(rule1, 'healthy').verdict, 'false');

  const rule2 = { target: 'state', operator: '!==', expected: 'healthy' };
  assert.equal(evaluateRule(rule2, 'degraded').verdict, 'true');

  const rule3 = { target: 'state', operator: '<>', expected: 'healthy' };
  assert.equal(evaluateRule(rule3, 'degraded').verdict, 'true');
  assert.equal(evaluateRule(rule3, 'healthy').verdict, 'false');
});

test('Operators: > (greater_than) and < (less_than) comparisons', () => {
  const gtRule = { target: 'queue.size', operator: '>', expected: 100 };
  assert.equal(evaluateRule(gtRule, 101).verdict, 'true');
  assert.equal(evaluateRule(gtRule, 100).verdict, 'false');
  assert.equal(evaluateRule(gtRule, 99).verdict, 'false');

  const ltRule = { target: 'battery', operator: '<', expected: 20 };
  assert.equal(evaluateRule(ltRule, 19).verdict, 'true');
  assert.equal(evaluateRule(ltRule, 20).verdict, 'false');
  assert.equal(evaluateRule(ltRule, 21).verdict, 'false');
});

test('Operators: ISO-8601 timestamps with ordered operators', () => {
  const timeRule = { target: 'certExpiry', operator: '<', expected: '2026-12-01T00:00:00Z' };
  assert.equal(evaluateRule(timeRule, '2026-11-01T00:00:00Z').verdict, 'true');
  assert.equal(evaluateRule(timeRule, '2026-12-01T00:00:00Z').verdict, 'false');
  assert.equal(evaluateRule(timeRule, '2026-12-15T00:00:00Z').verdict, 'false');

  // Incompatible types yields unknown
  assert.equal(evaluateRule(timeRule, 'not-a-timestamp').verdict, 'unknown');
});

test('Operators: parseConditionString with symbolic expressions', () => {
  const p1 = parseConditionString('cpu >= 90');
  assert.deepEqual(p1, { key: 'cpu', operator: 'gte', value: 90 });

  const p2 = parseConditionString('disk.usage <= 80%');
  assert.deepEqual(p2, { key: 'disk.usage', operator: 'lte', value: 80, unit: '%' });

  const p3 = parseConditionString('service == "active"');
  assert.deepEqual(p3, { key: 'service', operator: 'equals', value: 'active' });

  const p4 = parseConditionString('connected != false');
  assert.deepEqual(p4, { key: 'connected', operator: 'not_equals', value: false });

  const p5 = parseConditionString('latency > 250ms');
  assert.deepEqual(p5, { key: 'latency', operator: 'greater_than', value: 250, unit: 'ms' });
});

// ============================================================================
// SUITE 3: Reopen & Reusable Conditions Evaluation Across Changes
// ============================================================================
test('ShadowGraph: Decision reopenWhen evaluation with aliases across fact changes', () => {
  const graph = createShadowGraph();

  // Create initial decision with condition alias: target / expected
  const decision = graph.addDecision({
    project: 'arch-m2',
    title: 'Database Cluster Architecture',
    chosen: 'Distributed Spanner',
    reopenWhen: [
      { target: 'db.replicationLag', operator: '>=', expected: 500, unit: 'ms' }
    ]
  });

  assert.ok(decision && decision.id);
  // Verify normalized storage
  assert.equal(decision.reopenWhen[0].key, 'db.replicationLag');
  assert.equal(decision.reopenWhen[0].value, 500);

  // Record healthy fact
  graph.addFact({
    project: 'arch-m2',
    key: 'db.replicationLag',
    value: '100ms'
  });

  // Review should NOT flag decision as due
  const r1 = graph.review({ project: 'arch-m2' });
  const dueIds1 = (r1.items ?? []).map((item) => item.decisionId);
  assert.equal(dueIds1.includes(decision.id), false, 'Healthy lag should not trigger reopen');

  // Update fact to breach condition: 600ms >= 500ms
  graph.addFact({
    project: 'arch-m2',
    key: 'db.replicationLag',
    value: '600ms'
  });

  // Review should now flag decision as due
  const r2 = graph.review({ project: 'arch-m2' });
  const dueIds2 = (r2.items ?? []).map((item) => item.decisionId);
  assert.equal(dueIds2.includes(decision.id), true, 'Breached lag must trigger reopen');
});

test('ShadowGraph: Decision alternatives reopenWhen evaluation with aliases', () => {
  const graph = createShadowGraph();

  const decision = graph.addDecision({
    project: 'arch-m2',
    title: 'Cache Invalidation Strategy',
    chosen: 'TTL-Based',
    alternatives: [
      {
        label: 'Event-Driven CDC',
        reasonRejected: 'Too complex for initial release',
        reopenWhen: [
          { target: 'workload.qps', operator: '>', expected: 10000 }
        ]
      }
    ]
  });

  // Initial fact: low QPS
  graph.addFact({ project: 'arch-m2', key: 'workload.qps', value: 2000 });
  const r1 = graph.review({ project: 'arch-m2' });
  assert.equal((r1.items ?? []).some((item) => item.decisionId === decision.id), false);

  // High QPS triggers alternative reconsider condition
  graph.addFact({ project: 'arch-m2', key: 'workload.qps', value: 15000 });
  const r2 = graph.review({ project: 'arch-m2' });
  assert.equal((r2.items ?? []).some((item) => item.decisionId === decision.id), true, 'High QPS must trigger alternative reopen');
});

test('ShadowGraph: Decision plain string reopenWhen fires on changedFacts', () => {
  const graph = createShadowGraph();

  const decision = graph.addDecision({
    project: 'arch-m2',
    title: 'Cloud Provider',
    chosen: 'AWS',
    reopenWhen: ['budget_cut', 'compliance_change']
  });

  // Review with unrelated changed fact
  const r1 = graph.review({ project: 'arch-m2', changedFacts: ['team_growth'] });
  assert.equal((r1.items ?? []).some((item) => item.decisionId === decision.id), false);

  // Review with matching changed fact
  const r2 = graph.review({ project: 'arch-m2', changedFacts: ['budget_cut'] });
  assert.equal((r2.items ?? []).some((item) => item.decisionId === decision.id), true, 'Matching changedFact must trigger reopen');
});

test('ShadowGraph: Attempt reusableWhen normalization and context presence', () => {
  const graph = createShadowGraph();

  const attempt = graph.addAttempt({
    project: 'arch-m2',
    solution: 'Apply Redis caching layer',
    result: 'Reduced backend DB query load by 70%',
    resultClass: 'succeeded',
    reusableWhen: [
      { target: 'db.read_write_ratio', operator: '>=', expected: 5 }
    ]
  });

  assert.ok(attempt && attempt.id);
  assert.equal(attempt.reusableWhen[0].key, 'db.read_write_ratio');
  assert.equal(attempt.reusableWhen[0].value, 5);

  // Verify context query returns the attempt
  const ctx = graph.context({ project: 'arch-m2' });
  assert.ok(ctx);
});

test('ShadowGraph: Conflict rejection on decision and attempt writes', () => {
  const graph = createShadowGraph();

  // Decision top-level reopenWhen conflict key vs target
  assert.throws(
    () => {
      graph.addDecision({
        project: 'arch-m2',
        title: 'Conflict Decision 1',
        chosen: 'A',
        reopenWhen: [{ key: 'k1', target: 'k2', expected: 10 }]
      });
    },
    /conflict/i
  );

  // Decision top-level reopenWhen conflict value vs expected
  assert.throws(
    () => {
      graph.addDecision({
        project: 'arch-m2',
        title: 'Conflict Decision 2',
        chosen: 'A',
        reopenWhen: [{ target: 'k1', value: 10, expected: 20 }]
      });
    },
    /conflict/i
  );

  // Decision alternative reopenWhen conflict
  assert.throws(
    () => {
      graph.addDecision({
        project: 'arch-m2',
        title: 'Conflict Alternative',
        chosen: 'A',
        alternatives: [
          {
            label: 'Alt 1',
            reopenWhen: [{ key: 'status', target: 'state', value: 'ok' }]
          }
        ]
      });
    },
    /conflict/i
  );

  // Attempt reusableWhen conflict
  assert.throws(
    () => {
      graph.addAttempt({
        project: 'arch-m2',
        solution: 'sol',
        result: 'res',
        reusableWhen: [{ target: 'ver', value: '1.0', expected: '2.0' }]
      });
    },
    /conflict/i
  );
});

// ============================================================================
// SUITE 4: Description Constraints & Tool Metadata Limits
// ============================================================================
test('MCP Descriptions: <= 450 character cap on every tool in base catalog', () => {
  const full = buildToolCatalog({ verifier: false });
  const verifier = buildToolCatalog({ verifier: true });

  // 1. Full catalog tools (all 35 tools)
  for (const tool of full) {
    assert.ok(
      tool.description.length <= 450,
      `Full profile tool ${tool.name} description length ${tool.description.length} exceeds 450 char limit`
    );
  }

  // 2. Verifier catalog tools (all 36 tools)
  for (const tool of verifier) {
    assert.ok(
      tool.description.length <= 450,
      `Verifier profile tool ${tool.name} description length ${tool.description.length} exceeds 450 char limit`
    );
  }
});

test('MCP Descriptions: aggregate character budgets', () => {
  const full = buildToolCatalog({ verifier: false });
  const verifier = buildToolCatalog({ verifier: true });
  const compact = selectTools(full, { compact: true });

  const totalChars = (tools) => tools.reduce((sum, t) => sum + t.description.length, 0);

  const fullTotal = totalChars(full);
  const verifierTotal = totalChars(verifier);
  const compactTotal = totalChars(compact);

  assert.ok(fullTotal <= 11700, `Full total chars ${fullTotal} exceeds 11,700 budget`);
  assert.ok(verifierTotal <= 12050, `Verifier total chars ${verifierTotal} exceeds 12,050 budget`);
  assert.ok(compactTotal <= 7000, `Compact total chars ${compactTotal} exceeds 7,000 budget`);
});

test('MCP Descriptions: content alignment with search, retrieve, conditions, and outcome lifecycle', () => {
  const full = buildToolCatalog({ verifier: false });
  const find = (name) => full.find((t) => t.name === name);

  // 1. shadowgraph_search
  const search = find('shadowgraph_search');
  assert.ok(search);
  assert.match(search.description, /Arabic stem/i, 'search must document Arabic stemming');
  assert.match(search.description, /3\+\s*terms fallback/i, 'search must document 3+ terms fallback');
  assert.match(search.description, /recall ranks/i, 'search must document shadowgraph_recall role');

  // 2. shadowgraph_retrieve
  const retrieve = find('shadowgraph_retrieve');
  assert.ok(retrieve);
  assert.match(retrieve.description, /Arabic stem/i, 'retrieve must document Arabic stemming');
  assert.match(retrieve.description, /3\+\s*terms fallback/i, 'retrieve must document 3+ terms fallback');
  assert.match(retrieve.description, /recall ranks/i, 'retrieve must document shadowgraph_recall role');

  // 3. shadowgraph_record_outcome
  const outcome = find('shadowgraph_record_outcome');
  assert.ok(outcome);
  assert.match(
    outcome.describe.effects,
    /does not change lifecycle status unless autoTransition or decisionStatus\/lifecycleStatus/i,
    'record_outcome must document lifecycle status preservation unless autoTransition or decisionStatus/lifecycleStatus supplied'
  );

  // 4. Condition schema property descriptions in tools with alternatives.reopenWhen / reusableWhen
  const decTool = find('shadowgraph_record_decision');
  assert.ok(decTool);
  const altProp = decTool.inputSchema.properties.alternatives;
  assert.ok(altProp);
  const reopenProp = altProp.items?.properties?.reopenWhen;
  assert.ok(reopenProp);
  assert.match(reopenProp.description, />=.*<=.*==.*!=/i, 'reopenWhen schema must document symbolic operators');

  const attTool = find('shadowgraph_record_attempt');
  assert.ok(attTool);
  const reuseProp = attTool.inputSchema.properties.reusableWhen;
  assert.ok(reuseProp);
  assert.match(reuseProp.description, />=.*<=.*==.*!=/i, 'reusableWhen schema must document symbolic operators');

  // 5. changedFacts in shadowgraph_review
  const revTool = find('shadowgraph_review');
  assert.ok(revTool);
  const changedFactsProp = revTool.inputSchema.properties.changedFacts;
  assert.ok(changedFactsProp);
  assert.match(changedFactsProp.description, />=/i, 'changedFacts must document symbolic operators vs plain strings');
});
