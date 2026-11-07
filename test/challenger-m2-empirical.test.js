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
import {
  buildToolCatalog,
  selectTools,
  COMPACT_TOOL_NAMES,
  WORKFLOW_TOOL_NAMES
} from '../src/mcp-tools.js';

// ============================================================================
// SUITE 1: resolveRuleAliases Edge Cases & Matrix
// ============================================================================
test('Challenger M2: resolveRuleAliases handles non-object and null inputs gracefully', () => {
  assert.deepEqual(resolveRuleAliases(null), { key: undefined, value: undefined, hasValue: false });
  assert.deepEqual(resolveRuleAliases(undefined), { key: undefined, value: undefined, hasValue: false });
  assert.deepEqual(resolveRuleAliases([]), { key: undefined, value: undefined, hasValue: false });
  assert.deepEqual(resolveRuleAliases('string-rule'), { key: undefined, value: undefined, hasValue: false });
  assert.deepEqual(resolveRuleAliases(12345), { key: undefined, value: undefined, hasValue: false });
});

test('Challenger M2: resolveRuleAliases isolated target/key and expected/value combinations', () => {
  // 1. Only target, only expected
  const r1 = resolveRuleAliases({ target: 'service.latency', expected: 150 });
  assert.equal(r1.key, 'service.latency');
  assert.equal(r1.value, 150);
  assert.equal(r1.hasValue, true);

  // 2. Only key, only expected
  const r2 = resolveRuleAliases({ key: 'service.latency', expected: 150 });
  assert.equal(r2.key, 'service.latency');
  assert.equal(r2.value, 150);
  assert.equal(r2.hasValue, true);

  // 3. Only target, only value
  const r3 = resolveRuleAliases({ target: 'service.latency', value: 150 });
  assert.equal(r3.key, 'service.latency');
  assert.equal(r3.value, 150);
  assert.equal(r3.hasValue, true);

  // 4. Only key, only value
  const r4 = resolveRuleAliases({ key: 'service.latency', value: 150 });
  assert.equal(r4.key, 'service.latency');
  assert.equal(r4.value, 150);
  assert.equal(r4.hasValue, true);

  // 5. Only target, no value or expected
  const r5 = resolveRuleAliases({ target: 'service.latency' });
  assert.equal(r5.key, 'service.latency');
  assert.equal(r5.value, undefined);
  assert.equal(r5.hasValue, false);

  // 6. Only expected, no key or target
  const r6 = resolveRuleAliases({ expected: 200 });
  assert.equal(r6.key, undefined);
  assert.equal(r6.value, 200);
  assert.equal(r6.hasValue, true);
});

test('Challenger M2: resolveRuleAliases identical matching key/target and value/expected succeed', () => {
  // Matching strings
  const rStr = resolveRuleAliases({ key: 'queue_depth', target: 'queue_depth', value: 'high', expected: 'high' });
  assert.equal(rStr.key, 'queue_depth');
  assert.equal(rStr.value, 'high');

  // Matching numbers
  const rNum = resolveRuleAliases({ key: 'cpu', target: 'cpu', value: 99.5, expected: 99.5 });
  assert.equal(rNum.key, 'cpu');
  assert.equal(rNum.value, 99.5);

  // Matching booleans
  const rBool = resolveRuleAliases({ key: 'active', target: 'active', value: false, expected: false });
  assert.equal(rBool.key, 'active');
  assert.equal(rBool.value, false);

  // Matching nulls
  const rNull = resolveRuleAliases({ key: 'owner', target: 'owner', value: null, expected: null });
  assert.equal(rNull.key, 'owner');
  assert.equal(rNull.value, null);
  assert.equal(rNull.hasValue, true);

  // Matching zeros
  const rZero = resolveRuleAliases({ key: 'retries', target: 'retries', value: 0, expected: 0 });
  assert.equal(rZero.key, 'retries');
  assert.equal(rZero.value, 0);
  assert.equal(rZero.hasValue, true);

  // Matching empty strings
  const rEmpty = resolveRuleAliases({ key: 'prefix', target: 'prefix', value: '', expected: '' });
  assert.equal(rEmpty.key, 'prefix');
  assert.equal(rEmpty.value, '');
  assert.equal(rEmpty.hasValue, true);

  // Matching deep arrays
  const rArr = resolveRuleAliases({
    key: 'allowed_tiers',
    target: 'allowed_tiers',
    value: ['compact', 'workflow'],
    expected: ['compact', 'workflow']
  });
  assert.equal(rArr.key, 'allowed_tiers');
  assert.deepEqual(rArr.value, ['compact', 'workflow']);

  // Matching deep objects
  const rObj = resolveRuleAliases({
    key: 'spec',
    target: 'spec',
    value: { min: 1, max: 10 },
    expected: { min: 1, max: 10 }
  });
  assert.equal(rObj.key, 'spec');
  assert.deepEqual(rObj.value, { min: 1, max: 10 });
});

test('Challenger M2: resolveRuleAliases strictly rejects conflicting keys/targets', () => {
  // Distinct strings
  assert.throws(
    () => resolveRuleAliases({ key: 'disk_free', target: 'disk_total', expected: 100 }),
    /conflict/i
  );

  // Key and target with case differences
  assert.throws(
    () => resolveRuleAliases({ key: 'env', target: 'ENV', expected: 'prod' }),
    /conflict/i
  );

  // Key and target with whitespace differences
  assert.throws(
    () => resolveRuleAliases({ key: 'status', target: ' status ', expected: 'ok' }),
    /conflict/i
  );
});

test('Challenger M2: resolveRuleAliases strictly rejects conflicting values/expected across types', () => {
  // Number vs number
  assert.throws(
    () => resolveRuleAliases({ target: 'count', value: 10, expected: 20 }),
    /conflict/i
  );

  // String vs string
  assert.throws(
    () => resolveRuleAliases({ target: 'env', value: 'prod', expected: 'stage' }),
    /conflict/i
  );

  // Boolean vs boolean
  assert.throws(
    () => resolveRuleAliases({ target: 'flag', value: true, expected: false }),
    /conflict/i
  );

  // Number vs string coercion
  assert.throws(
    () => resolveRuleAliases({ target: 'port', value: 8080, expected: '8080' }),
    /conflict/i
  );

  // Zero vs false coercion
  assert.throws(
    () => resolveRuleAliases({ target: 'state', value: 0, expected: false }),
    /conflict/i
  );

  // Zero vs empty string coercion
  assert.throws(
    () => resolveRuleAliases({ target: 'state', value: 0, expected: '' }),
    /conflict/i
  );

  // Null vs 0
  assert.throws(
    () => resolveRuleAliases({ target: 'ptr', value: null, expected: 0 }),
    /conflict/i
  );

  // Null vs false
  assert.throws(
    () => resolveRuleAliases({ target: 'ptr', value: null, expected: false }),
    /conflict/i
  );

  // Null vs empty string
  assert.throws(
    () => resolveRuleAliases({ target: 'ptr', value: null, expected: '' }),
    /conflict/i
  );

  // Differing arrays
  assert.throws(
    () => resolveRuleAliases({ target: 'tags', value: ['a', 'b'], expected: ['a', 'c'] }),
    /conflict/i
  );

  // Array vs object
  assert.throws(
    () => resolveRuleAliases({ target: 'data', value: [1], expected: { 0: 1 } }),
    /conflict/i
  );
});

test('Challenger M2: resolveRuleAliases with explicit undefined does not trigger conflict', () => {
  // value present, expected undefined
  const r1 = resolveRuleAliases({ target: 'a', value: 10, expected: undefined });
  assert.equal(r1.key, 'a');
  assert.equal(r1.value, 10);
  assert.equal(r1.hasValue, true);

  // key present, target undefined
  const r2 = resolveRuleAliases({ key: 'b', target: undefined, value: 20 });
  assert.equal(r2.key, 'b');
  assert.equal(r2.value, 20);
});

// ============================================================================
// SUITE 2: ruleOperandIssue Validation
// ============================================================================
test('Challenger M2: ruleOperandIssue correctly reports missing vs valid falsy operands', () => {
  // Missing operand with target
  assert.match(ruleOperandIssue({ target: 'cpu', operator: '>=' }), /has no value/i);

  // Valid falsy values must NOT report operand issue
  assert.equal(ruleOperandIssue({ target: 'flag', operator: '==', expected: false }), null);
  assert.equal(ruleOperandIssue({ target: 'count', operator: '==', expected: 0 }), null);
  assert.equal(ruleOperandIssue({ target: 'prefix', operator: '==', expected: '' }), null);
  assert.equal(ruleOperandIssue({ target: 'fallback', operator: '==', expected: null }), null);

  // Operator in / not_in requires an array
  assert.match(
    ruleOperandIssue({ target: 'tier', operator: 'in', expected: 'single-string' }),
    /requires an array/i
  );
  assert.equal(
    ruleOperandIssue({ target: 'tier', operator: 'in', expected: ['a', 'b'] }),
    null
  );

  // Operator between requires 2 bounds
  assert.match(
    ruleOperandIssue({ target: 'temp', operator: 'between', expected: [10] }),
    /two-element/i
  );
  assert.match(
    ruleOperandIssue({ target: 'temp', operator: 'between', expected: [undefined, 20] }),
    /both bounds/i
  );
  assert.equal(
    ruleOperandIssue({ target: 'temp', operator: 'between', expected: [10, 20] }),
    null
  );
});

// ============================================================================
// SUITE 3: Symbolic Operators with Aliases (>=, <=, ==, !=, >, <)
// ============================================================================
test('Challenger M2: evaluateRule with >= and <= and > and < symbolic operators using target/expected', () => {
  // >= (gte)
  const gteRule = { target: 'load', operator: '>=', expected: 75 };
  assert.equal(evaluateRule(gteRule, 74).verdict, 'false');
  assert.equal(evaluateRule(gteRule, 75).verdict, 'true');
  assert.equal(evaluateRule(gteRule, 76).verdict, 'true');

  // <= (lte)
  const lteRule = { target: 'mem_avail', operator: '<=', expected: 20 };
  assert.equal(evaluateRule(lteRule, 21).verdict, 'false');
  assert.equal(evaluateRule(lteRule, 20).verdict, 'true');
  assert.equal(evaluateRule(lteRule, 19).verdict, 'true');

  // > (greater_than)
  const gtRule = { target: 'latency', operator: '>', expected: 100 };
  assert.equal(evaluateRule(gtRule, 99).verdict, 'false');
  assert.equal(evaluateRule(gtRule, 100).verdict, 'false');
  assert.equal(evaluateRule(gtRule, 101).verdict, 'true');

  // < (less_than)
  const ltRule = { target: 'inventory', operator: '<', expected: 5 };
  assert.equal(evaluateRule(ltRule, 6).verdict, 'false');
  assert.equal(evaluateRule(ltRule, 5).verdict, 'false');
  assert.equal(evaluateRule(ltRule, 4).verdict, 'true');

  // ==, ===, = (equals)
  const eqRule1 = { target: 'status', operator: '==', expected: 'healthy' };
  assert.equal(evaluateRule(eqRule1, 'healthy').verdict, 'true');
  assert.equal(evaluateRule(eqRule1, 'degraded').verdict, 'false');

  const eqRule2 = { target: 'status', operator: '===', expected: 'healthy' };
  assert.equal(evaluateRule(eqRule2, 'healthy').verdict, 'true');

  const eqRule3 = { target: 'status', operator: '=', expected: 'healthy' };
  assert.equal(evaluateRule(eqRule3, 'healthy').verdict, 'true');

  // !=, !==, <> (not_equals)
  const neqRule1 = { target: 'phase', operator: '!=', expected: 'maintenance' };
  assert.equal(evaluateRule(neqRule1, 'running').verdict, 'true');
  assert.equal(evaluateRule(neqRule1, 'maintenance').verdict, 'false');

  const neqRule2 = { target: 'phase', operator: '!==', expected: 'maintenance' };
  assert.equal(evaluateRule(neqRule2, 'running').verdict, 'true');

  const neqRule3 = { target: 'phase', operator: '<>', expected: 'maintenance' };
  assert.equal(evaluateRule(neqRule3, 'running').verdict, 'true');
});

test('Challenger M2: evaluateRule unit conversions and timestamps with aliases', () => {
  // Unit conversion: 5000ms >= 5s
  const unitRule = { target: 'timeout', operator: '>=', expected: 5, unit: 's' };
  assert.equal(evaluateRule(unitRule, '5000ms').verdict, 'true');
  assert.equal(evaluateRule(unitRule, '4999ms').verdict, 'false');
  assert.equal(evaluateRule(unitRule, '6s').verdict, 'true');

  // ISO timestamps:
  const timeRule = { target: 'deadline', operator: '<', expected: '2026-12-01T00:00:00Z' };
  assert.equal(evaluateRule(timeRule, '2026-11-01T00:00:00Z').verdict, 'true');
  assert.equal(evaluateRule(timeRule, '2026-12-02T00:00:00Z').verdict, 'false');
});

// ============================================================================
// SUITE 4: ShadowGraph State Machine & Lifecycle Stress Testing
// ============================================================================
test('Challenger M2: ShadowGraph Decision creation with target/expected and alternative reopenWhen', () => {
  const sg = createShadowGraph();

  // Decision with top-level reopenWhen and custom alternatives
  const dec1 = sg.addDecision({
    project: 'stress-proj',
    title: 'Database Engine Choice',
    chosen: 'Postgres',
    reopenWhen: [{ target: 'db.storage_remaining_pct', operator: '<=', expected: 15 }],
    alternatives: [
      {
        label: 'Switch to CockroachDB',
        reopenWhen: [{ target: 'cluster.nodes', operator: '>=', expected: 10 }]
      }
    ]
  });

  assert.ok(dec1.id);
  assert.equal(dec1.alternatives.length, 1);
  assert.equal(dec1.alternatives[0].reopenWhen[0].key, 'cluster.nodes');
  assert.equal(dec1.alternatives[0].reopenWhen[0].value, 10);
  assert.equal(dec1.alternatives[0].reopenWhen[0].operator, 'gte');

  // Verify stored decision top-level reopenWhen
  assert.ok(dec1.reopenWhen);
  assert.equal(dec1.reopenWhen[0].key, 'db.storage_remaining_pct');
  assert.equal(dec1.reopenWhen[0].value, 15);
  assert.equal(dec1.reopenWhen[0].operator, 'lte');

  // Conflicting top-level reopenWhen
  assert.throws(
    () => {
      sg.addDecision({
        project: 'stress-proj',
        title: 'Bad Decision 1',
        chosen: 'None',
        reopenWhen: [{ key: 'storage', target: 'disk', value: 10 }]
      });
    },
    /conflict/i
  );

  // Conflicting alternative reopenWhen
  assert.throws(
    () => {
      sg.addDecision({
        project: 'stress-proj',
        title: 'Bad Decision 2',
        chosen: 'None',
        alternatives: [
          {
            label: 'Alt',
            reopenWhen: [{ key: 'storage', value: 10, expected: 20 }]
          }
        ]
      });
    },
    /conflict/i
  );
});

test('Challenger M2: ShadowGraph Attempt creation with target/expected in reusableWhen and reusability evaluation', () => {
  const sg = createShadowGraph();

  const att = sg.addAttempt({
    project: 'stress-proj',
    solution: 'Scale workers to 20',
    result: 'Reduced queue latency under 100ms',
    resultClass: 'succeeded',
    reusableWhen: [
      { target: 'queue.size', operator: '>=', expected: 1000 },
      { target: 'worker.idle_count', operator: '==', expected: 0 }
    ]
  });

  assert.ok(att.id);
  assert.equal(att.reusableWhen.length, 2);
  assert.equal(att.reusableWhen[0].key, 'queue.size');
  assert.equal(att.reusableWhen[0].value, 1000);
  assert.equal(att.reusableWhen[0].operator, 'gte');
  assert.equal(att.reusableWhen[1].key, 'worker.idle_count');
  assert.equal(att.reusableWhen[1].value, 0);

  // Conflicting reusableWhen in attempt
  assert.throws(
    () => {
      sg.addAttempt({
        project: 'stress-proj',
        solution: 'Try caching',
        result: 'Failed',
        reusableWhen: [{ target: 'cache.engine', expected: 'redis', value: 'memcached' }]
      });
    },
    /conflict/i
  );
});

test('Challenger M2: End-to-end fact updates driving reopenWhen review() and reconsider() across lifecycles', () => {
  const sg = createShadowGraph();

  // Create decision with reopen condition: memory_usage_pct >= 90
  const dec = sg.addDecision({
    project: 'lifecycle-test',
    title: 'Monolithic Server Sizing',
    chosen: '16GB RAM',
    reopenWhen: [{ target: 'memory_usage_pct', operator: '>=', expected: 90 }]
  });

  // Step 1: Initial review before facts recorded -> no review due
  const rev1 = sg.review({ project: 'lifecycle-test' });
  assert.equal(rev1.items.length, 0);

  // Step 2: Record fact: memory_usage_pct = 75 -> condition false -> no review due
  sg.addFact({
    project: 'lifecycle-test',
    key: 'memory_usage_pct',
    value: 75
  });

  const rev2 = sg.review({ project: 'lifecycle-test' });
  assert.equal(rev2.items.length, 0);

  const recon2 = sg.reconsider({ project: 'lifecycle-test', decisionId: dec.id });
  assert.equal(recon2.verdict, 'unchanged');

  // Step 3: Record fact: memory_usage_pct = 95 -> condition true (95 >= 90) -> review triggered!
  sg.addFact({
    project: 'lifecycle-test',
    key: 'memory_usage_pct',
    value: 95
  });

  const rev3 = sg.review({ project: 'lifecycle-test' });
  assert.equal(rev3.items.length, 1);
  assert.equal(rev3.items[0].decisionId, dec.id);
  assert.ok(rev3.items[0].reason.includes('memory_usage_pct'));

  const recon3 = sg.reconsider({ project: 'lifecycle-test', decisionId: dec.id });
  assert.equal(recon3.verdict, 'review_recommended');
  assert.equal(recon3.decisions[0].triggeredRules[0].key, 'memory_usage_pct');

  // Step 4: Step down fact: memory_usage_pct = 80 -> condition false -> review no longer triggered
  sg.addFact({
    project: 'lifecycle-test',
    key: 'memory_usage_pct',
    value: 80
  });

  const rev4 = sg.review({ project: 'lifecycle-test' });
  assert.equal(rev4.items.length, 0);

  const recon4 = sg.reconsider({ project: 'lifecycle-test', decisionId: dec.id });
  assert.equal(recon4.verdict, 'unchanged');
});

test('Challenger M2: End-to-end fact updates driving reusableWhen context() across attempts', () => {
  const sg = createShadowGraph();

  // Create attempt with reusableWhen: db.connection_pool >= 50
  const att = sg.addAttempt({
    project: 'reuse-test',
    solution: 'Connection pooling tuning',
    result: 'Reduced timeout errors',
    resultClass: 'failed',
    reusableWhen: [{ target: 'db.connection_pool', operator: '>=', expected: 50 }]
  });

  // Step 1: context without facts -> reusability not established
  const ctx1 = sg.context({ project: 'reuse-test' });
  assert.equal(ctx1.reusableAttempts.length, 0);

  // Step 2: Record fact pool = 20 -> condition false
  sg.addFact({
    project: 'reuse-test',
    key: 'db.connection_pool',
    value: 20
  });

  const ctx2 = sg.context({ project: 'reuse-test' });
  assert.equal(ctx2.reusableAttempts.length, 0);

  // Step 3: Record fact pool = 60 -> condition true
  sg.addFact({
    project: 'reuse-test',
    key: 'db.connection_pool',
    value: 60
  });

  const ctx3 = sg.context({ project: 'reuse-test' });
  assert.equal(ctx3.reusableAttempts.length, 1);
  assert.equal(ctx3.reusableAttempts[0].attemptId, att.id);

  // Step 4: Verify caller-supplied fact override in context()
  const ctx4 = sg.context({
    project: 'reuse-test',
    facts: { 'db.connection_pool': 10 }
  });
  assert.equal(ctx4.reusableAttempts.length, 0);
});

// ============================================================================
// SUITE 5: Tool Description Character Limits & Content Verification
// ============================================================================
test('Challenger M2: Verify individual tool description length strictly <= 450 characters', () => {
  const catalog = buildToolCatalog({ verifier: true });
  for (const tool of catalog) {
    const description = tool.description ?? '';
    assert.ok(
      description.length <= 450,
      `Tool ${tool.name} description exceeds 450 characters (actual: ${description.length}): "${description}"`
    );
  }
});

test('Challenger M2: Verify profile aggregate character budgets', () => {
  const bareCatalog = buildToolCatalog({ verifier: false });
  const verifierCatalog = buildToolCatalog({ verifier: true });
  const compactCatalog = selectTools(bareCatalog, { compact: true });

  const fullTotal = bareCatalog.reduce((sum, t) => sum + (t.description?.length ?? 0), 0);
  const verifierTotal = verifierCatalog.reduce((sum, t) => sum + (t.description?.length ?? 0), 0);
  const compactTotal = compactCatalog.reduce((sum, t) => sum + (t.description?.length ?? 0), 0);

  assert.ok(fullTotal <= 11700, `Full profile total ${fullTotal} exceeds 11700 budget`);
  assert.ok(verifierTotal <= 12050, `Verifier profile total ${verifierTotal} exceeds 12050 budget`);
  assert.ok(compactTotal <= 7000, `Compact profile total ${compactTotal} exceeds 7000 budget`);
});

test('Challenger M2: Verify content alignment for search, retrieve, record_outcome, and condition syntax', () => {
  const catalog = buildToolCatalog({ verifier: false });

  const searchTool = catalog.find((t) => t.name === 'shadowgraph_search');
  assert.ok(searchTool, 'shadowgraph_search exists');
  assert.match(searchTool.describe.does, /Arabic stem/i, 'Search documents Arabic stemming');
  assert.match(searchTool.describe.route, /shadowgraph_recall ranks/i, 'Search documents recall routing');
  assert.match(searchTool.describe.returns, /3\+\s*terms fallback/i, 'Search documents 3+ term partial fallback');

  const retrieveTool = catalog.find((t) => t.name === 'shadowgraph_retrieve');
  assert.ok(retrieveTool, 'shadowgraph_retrieve exists');
  assert.match(retrieveTool.describe.does, /Arabic stem/i, 'Retrieve documents Arabic stemming');
  assert.match(retrieveTool.describe.route, /shadowgraph_recall ranks/i, 'Retrieve documents recall routing');
  assert.match(retrieveTool.describe.returns, /3\+\s*terms fallback/i, 'Retrieve documents 3+ term partial fallback');

  const outcomeTool = catalog.find((t) => t.name === 'shadowgraph_record_outcome');
  assert.ok(outcomeTool, 'shadowgraph_record_outcome exists');
  assert.match(
    outcomeTool.describe.effects,
    /does not change lifecycle status unless autoTransition or decisionStatus\/lifecycleStatus is supplied/i,
    'record_outcome documents lifecycle behavior'
  );

  const reviewTool = catalog.find((t) => t.name === 'shadowgraph_review');
  assert.ok(reviewTool, 'shadowgraph_review exists');
  const changedFactsDesc = reviewTool.inputSchema.properties.changedFacts.description;
  assert.match(changedFactsDesc, /Symbolic strings \("key >= value"\)/i, 'changedFacts documents symbolic strings');

  const decTool = catalog.find((t) => t.name === 'shadowgraph_record_decision');
  assert.ok(decTool, 'shadowgraph_record_decision exists');
  const reopenWhenDesc = decTool.inputSchema.properties.alternatives.items.properties.reopenWhen.description;
  assert.match(reopenWhenDesc, />=,\s*<=,\s*==,\s*!=,\s*>,\s*</i, 'reopenWhen documents symbolic operators');

  const attemptTool = catalog.find((t) => t.name === 'shadowgraph_record_attempt');
  assert.ok(attemptTool, 'shadowgraph_record_attempt exists');
  const reusableWhenDesc = attemptTool.inputSchema.properties.reusableWhen.description;
  assert.match(reusableWhenDesc, />=,\s*<=,\s*==,\s*!=,\s*>,\s*</i, 'reusableWhen documents symbolic operators');
});
