// Reconsideration: reconsider() as a projection of the ONE canonical pass.
//
// What breaks if this file is deleted: nothing would prove that review() and
// reconsider() agree about whether a stored rule fires, does not fire, or
// cannot be evaluated. That agreement is the whole point of the design. A
// second operator table on the reconsideration side would let a rule using an
// operator only one side understood report `unchanged` with complete
// confidence while review() reported a breach -- which is exactly the failure
// the three-valued evaluator exists to prevent.
//
// The operator sweep below derives its cases from the canonical RULE_OPERATORS
// export rather than restating them, so a new operator is covered the day it is
// added instead of the day someone remembers to update this list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { RULE_OPERATORS, evaluateRule } from '../src/condition-eval.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NODE_SQLITE = (await getRuntimeCapabilities()).nodeSqlite;
const SQLITE_TEST_OPTIONS = NODE_SQLITE.available ? {} : { skip: NODE_SQLITE.reason };

// A decision whose rejected alternative reopens on one machine-checkable rule.
function decisionWith(graph, rule, project = 'p') {
  return graph.addDecision({
    project,
    title: 'Serve reads from the local replica',
    chosen: 'local-replica',
    alternatives: [{ label: 'primary-only', reasonRejected: 'replica latency was acceptable', reopenWhen: [rule] }]
  });
}

const only = (result) => {
  assert.equal(result.decisions.length, 1, 'these fixtures hold exactly one decision');
  return result.decisions[0];
};

// Every condition reconsider() reports, whatever bucket it landed in. Used to
// prove a verdict travelled intact rather than to look one up by bucket.
const allConditions = (entry) => [
  ...entry.triggeredRules, ...entry.groundedConditions, ...entry.rulesNotEvaluated, ...entry.contestedConditions
];

// --- A/B/C/D: the four contracted verdict and completeness combinations ----

test('a structured rule that fires recommends review, and says which alternative to reconsider', () => {
  const graph = createShadowGraph();
  const decision = decisionWith(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500 });
  graph.addFact({ project: 'p', key: 'replicaLagMs', value: 900, sourceClass: 'tool_observed' });

  const result = graph.reconsider({ project: 'p' });
  assert.equal(result.verdict, 'review_recommended');
  assert.equal(result.evaluationCompleteness, 'complete', 'nothing was left unevaluated');

  const entry = only(result);
  assert.equal(entry.decisionId, decision.id);
  assert.equal(entry.triggeredRules.length, 1);
  assert.equal(entry.triggeredRules[0].verdict, 'true');
  assert.equal(entry.triggeredRules[0].observed, 900, 'the breach names the observation behind it');
  assert.deepEqual(entry.affectedAlternatives, ['primary-only']);
  assert.equal(entry.factsConsidered.length, 1, 'and the fact it was computed from');
  assert.equal(entry.factsConsidered[0].key, 'replicaLagMs');
});

test('a structured rule that is genuinely false is unchanged and complete, resting on stated evidence', () => {
  const graph = createShadowGraph();
  decisionWith(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500 });
  graph.addFact({ project: 'p', key: 'replicaLagMs', value: 120, sourceClass: 'tool_observed' });

  const result = graph.reconsider({ project: 'p' });
  assert.equal(result.verdict, 'unchanged');
  assert.equal(result.evaluationCompleteness, 'complete');

  const entry = only(result);
  assert.equal(entry.rulesNotEvaluated.length, 0);
  // The grounded negative is the point: an empty result would prove nothing
  // about whether the rule was checked at all.
  assert.equal(entry.groundedConditions.length, 1, 'unchanged is shown to rest on a checked condition');
  assert.equal(entry.groundedConditions[0].verdict, 'false');
  assert.equal(entry.groundedConditions[0].observed, 120);
});

test('a condition that cannot be evaluated is manual_review and partial, never a pass', () => {
  const graph = createShadowGraph();
  decisionWith(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500 });

  const result = graph.reconsider({ project: 'p' });
  assert.equal(result.verdict, 'manual_review', 'no evidence is not a clean pass');
  assert.equal(result.evaluationCompleteness, 'partial');

  const entry = only(result);
  assert.equal(entry.triggeredRules.length, 0);
  assert.equal(entry.rulesNotEvaluated.length, 1);
  assert.equal(entry.rulesNotEvaluated[0].verdict, 'unknown');
  assert.match(entry.rulesNotEvaluated[0].reason, /No fact recorded/);
  assert.equal(graph.getReviewSignals({ project: 'p' }).length, 0, 'and it raises no review signal');
});

test('one rule firing while another is unevaluable recommends review AND reports partial', () => {
  const graph = createShadowGraph();
  graph.addDecision({
    project: 'p',
    title: 'Serve reads from the local replica',
    chosen: 'local-replica',
    alternatives: [
      { label: 'primary-only', reasonRejected: 'latency was fine', reopenWhen: [{ key: 'replicaLagMs', operator: 'gte', value: 500 }] },
      { label: 'managed-service', reasonRejected: 'cost was too high', reopenWhen: [{ key: 'monthlyCostUsd', operator: 'lte', value: 200 }] }
    ]
  });
  graph.addFact({ project: 'p', key: 'replicaLagMs', value: 900, sourceClass: 'tool_observed' });

  const result = graph.reconsider({ project: 'p' });
  // Neither outcome is allowed to hide the other.
  assert.equal(result.verdict, 'review_recommended', 'a definite trigger outranks uncertainty');
  assert.equal(result.evaluationCompleteness, 'partial', 'but the uncertainty is still declared');

  const entry = only(result);
  assert.equal(entry.triggeredRules.length, 1, 'the breach evidence is visible');
  assert.equal(entry.triggeredRules[0].key, 'replicaLagMs');
  assert.equal(entry.rulesNotEvaluated.length, 1, 'and so is the unevaluated condition');
  assert.equal(entry.rulesNotEvaluated[0].key, 'monthlyCostUsd');
});

// --- E: one evaluator, proven operator by operator -------------------------

test('every operator the evaluator advertises reaches reconsideration with the same verdict', () => {
  // Derived from the canonical export, never restated here: a new operator is
  // covered the day it is added to RULE_OPERATORS.
  const ruleValueFor = (operator) => {
    if (operator === 'in' || operator === 'not_in') return [5];
    if (operator === 'between') return [1, 10];
    return 5;
  };

  for (const operator of RULE_OPERATORS) {
    const rule = { key: 'metric', operator, value: ruleValueFor(operator) };
    const graph = createShadowGraph();
    decisionWith(graph, rule);
    graph.addFact({ project: 'p', key: 'metric', value: 5, sourceClass: 'tool_observed' });

    const expected = evaluateRule(rule, 5).verdict;
    const entry = only(graph.reconsider({ project: 'p' }));
    const reported = allConditions(entry).find((condition) => condition.key === 'metric');

    assert.ok(reported, `${operator}: the condition must be reported in some bucket`);
    assert.equal(reported.verdict, expected, `${operator}: reconsideration must not re-decide the verdict`);

    // And the decision-level reading has to follow from that same verdict.
    const due = graph.review({ project: 'p' });
    assert.equal(due.length, expected === 'true' ? 1 : 0, `${operator}: review() must agree about firing`);
    assert.equal(
      entry.verdict,
      expected === 'true' ? 'review_recommended' : expected === 'unknown' ? 'manual_review' : 'unchanged',
      `${operator}: the decision verdict must follow the condition verdict`
    );
    assert.equal(entry.evaluationCompleteness, expected === 'unknown' ? 'partial' : 'complete', `${operator}: completeness must follow too`);
  }
});

// --- F: unit conversion is the evaluator's, not a second copy --------------

test('a declared unit converts identically for review and for reconsideration', () => {
  const graph = createShadowGraph();
  decisionWith(graph, { key: 'replicaLag', operator: 'gte', value: 1, unit: 's' });
  // Same quantity, expressed in the other unit the rule can read.
  graph.addFact({ project: 'p', key: 'replicaLag', value: '1500ms', sourceClass: 'tool_observed' });

  assert.equal(graph.review({ project: 'p' }).length, 1, 'review converts and fires');
  const entry = only(graph.reconsider({ project: 'p' }));
  assert.equal(entry.verdict, 'review_recommended', 'and reconsideration reaches the same answer');
  assert.equal(entry.triggeredRules[0].unit, 's', 'the rule unit travels with the breach');

  // A unit outside the rule's dimension is refused rather than guessed at, on
  // both routes.
  const other = createShadowGraph();
  decisionWith(other, { key: 'replicaLag', operator: 'gte', value: 1, unit: 's' });
  other.addFact({ project: 'p', key: 'replicaLag', value: '40%', sourceClass: 'tool_observed' });
  assert.equal(other.review({ project: 'p' }).length, 0);
  const refused = only(other.reconsider({ project: 'p' }));
  assert.equal(refused.verdict, 'manual_review');
  assert.equal(refused.evaluationCompleteness, 'partial');
  assert.equal(refused.rulesNotEvaluated[0].verdict, 'unknown');
});

// --- G: matching stays literal --------------------------------------------

test('a key that differs only in spelling does not match, and no meaning is inferred', () => {
  const graph = createShadowGraph();
  decisionWith(graph, { key: 'replicaLagMs', operator: 'greater_than', value: 500 });
  graph.addFact({ project: 'p', key: 'replica_lag_ms', value: 900, sourceClass: 'tool_observed' });

  const entry = only(graph.reconsider({ project: 'p' }));
  assert.equal(entry.verdict, 'manual_review', 'a near-miss key is not evidence');
  assert.equal(entry.rulesNotEvaluated.length, 1);
  assert.match(entry.rulesNotEvaluated[0].reason, /No fact recorded/);

  // The exact key does fire, which proves this is literal matching rather than
  // an inability to match at all.
  graph.addFact({ project: 'p', key: 'replicaLagMs', value: 900, sourceClass: 'tool_observed' });
  assert.equal(only(graph.reconsider({ project: 'p' })).verdict, 'review_recommended');
});

// --- H: the legacy string form stays legacy, and says so -------------------

test('a stored string rule with nothing supplied is reported unevaluated, not passed', () => {
  const graph = createShadowGraph();
  decisionWith(graph, 'deployment model changed');

  const entry = only(graph.reconsider({ project: 'p' }));
  assert.equal(entry.verdict, 'manual_review');
  assert.equal(entry.evaluationCompleteness, 'partial');
  assert.equal(entry.rulesNotEvaluated.length, 1);
  // The text is preserved exactly and never interpreted.
  assert.equal(entry.rulesNotEvaluated[0].expected, 'deployment model changed');
  assert.equal(entry.rulesNotEvaluated[0].key, null);
  assert.match(entry.rulesNotEvaluated[0].reason, /cannot settle from stored facts/);
  assert.equal(graph.getReviewSignals({ project: 'p' }).length, 0, 'an unevaluated condition raises nothing');
});

test('the legacy string form still matches changedFacts, unchanged, on both routes', () => {
  const graph = createShadowGraph();
  decisionWith(graph, 'deployment model changed');

  assert.equal(graph.review({ project: 'p', changedFacts: ['deployment model changed'] }).length, 1);
  const entry = only(graph.reconsider({ project: 'p', changedFacts: ['deployment model changed'] }));
  assert.equal(entry.verdict, 'review_recommended');
  assert.equal(entry.evaluationCompleteness, 'complete', 'a matched token is settled, not uncertain');
  assert.deepEqual(entry.triggeredBy.map((cause) => cause.cause), ['deployment model changed']);
});

// --- contested evidence ----------------------------------------------------

test('a verdict resting on facts that disagree is reported apart, and withholds completeness', () => {
  const seed = createShadowGraph();
  decisionWith(seed, { key: 'replicaLagMs', operator: 'greater_than', value: 500, unit: 'ms' });
  seed.addFact({ project: 'p', key: 'replicaLagMs', value: '20ms', sourceClass: 'measured', validFrom: '2026-03-01T00:00:00Z' });

  // A second, equally applicable observation of the same key that disagrees.
  // Imported rather than written, because a second write of the same key
  // supersedes the first instead of contesting it.
  const snapshot = seed.exportData();
  snapshot.facts = [...snapshot.facts, { ...snapshot.facts[0], id: 'fact:contested', value: '900ms' }];
  const graph = createShadowGraph();
  graph.importData(snapshot);

  const entry = only(graph.reconsider({ project: 'p' }));
  assert.equal(entry.rulesNotEvaluated.length, 0, 'the evaluator did reach a verdict, so this is not unevaluated');
  assert.equal(entry.contestedConditions.length, 1, 'but the disagreement is named');
  assert.equal(entry.contestedConditions[0].conflictingEvidence.length, 2, 'both observations stay visible');
  assert.equal(entry.evaluationCompleteness, 'partial', 'a verdict on contested facts is not a settled one');
  // Which observation wins is deterministic but not the point; what must never
  // happen is a contested result being reported as a clean pass.
  assert.notEqual(entry.verdict, 'unchanged', 'contested evidence can never read as unchanged');
  assert.ok(entry.factsConsidered.length >= 2, 'every disagreeing observation is part of what was considered');
});

test('a contested false condition is contested, not a grounded negative', () => {
  // Both observations sit below the threshold, so the verdict is definitely
  // `false` and the evidence is definitely contested. That combination is the
  // one that must not be double-counted: listing it as grounded would describe
  // disputed evidence as "we checked, and this is fine", while it is
  // simultaneously reported as something we cannot settle. It is one or the
  // other, never both.
  const seed = createShadowGraph();
  decisionWith(seed, { key: 'replicaLagMs', operator: 'greater_than', value: 500, unit: 'ms' });
  seed.addFact({ project: 'p', key: 'replicaLagMs', value: '20ms', sourceClass: 'measured', validFrom: '2026-03-01T00:00:00Z' });
  const snapshot = seed.exportData();
  snapshot.facts = [...snapshot.facts, { ...snapshot.facts[0], id: 'fact:contested', value: '30ms' }];
  const graph = createShadowGraph();
  graph.importData(snapshot);

  const entry = only(graph.reconsider({ project: 'p' }));

  assert.equal(entry.contestedConditions.length, 1, 'the contested condition is reported as contested');
  assert.equal(entry.contestedConditions[0].verdict, 'false', 'and the evaluator did decide it');
  assert.deepEqual(entry.groundedConditions, [], 'it must NOT also count as a grounded negative');
  assert.ok(
    !entry.groundedConditions.some((condition) => condition.conflictingEvidence),
    'no grounded condition may carry conflicting evidence'
  );

  assert.equal(entry.evaluationCompleteness, 'partial', 'contested evidence withholds completeness');
  assert.equal(entry.verdict, 'manual_review', 'with no definite trigger, a human has to look');
  // The pairing the contract promises, stated as the thing that must never happen.
  assert.ok(
    !(entry.verdict === 'unchanged' && entry.evaluationCompleteness === 'complete'),
    'a contested condition can never produce unchanged + complete'
  );
});

// --- I: project isolation --------------------------------------------------

test('reconsideration is project scoped, and the guard is scoping rather than a failure to match', () => {
  const graph = createShadowGraph();
  decisionWith(graph, { key: 'deployment', operator: 'equals', value: 'multi-user' }, 'project-b');
  // Matching key AND value, but recorded against another project.
  graph.addFact({ project: 'project-a', key: 'deployment', value: 'multi-user', sourceClass: 'tool_observed' });

  let entry = only(graph.reconsider({ project: 'project-b' }));
  assert.equal(entry.verdict, 'manual_review', 'a fact in another project is not evidence here');
  assert.equal(entry.rulesNotEvaluated.length, 1);
  assert.equal(graph.reconsider({ project: 'project-a' }).decisions.length, 0, 'and that project holds no decision');

  graph.addFact({ project: 'project-b', key: 'deployment', value: 'multi-user', sourceClass: 'tool_observed' });
  entry = only(graph.reconsider({ project: 'project-b' }));
  assert.equal(entry.verdict, 'review_recommended', 'the same fact in its own project does fire');
});

// --- J2: focused scoping fails closed --------------------------------------

test('an unaddressable decision is an error, never an empty unchanged result', () => {
  const graph = createShadowGraph();
  const mine = decisionWith(graph, { key: 'lag', operator: 'gte', value: 500 }, 'p');
  decisionWith(graph, { key: 'lag', operator: 'gte', value: 1 }, 'other');

  // An empty `unchanged` + `complete` here would read exactly like "checked,
  // and this decision is fine", which is the confusion the whole contract
  // exists to prevent.
  assert.throws(() => graph.reconsider({ project: 'p', decisionId: 'decision_does_not_exist' }), /Decision not found/);
  assert.throws(() => graph.reconsider({ project: 'other', decisionId: mine.id }), /not accessible in this project/);
  assert.throws(() => graph.reconsider({ project: 'p', decisionId: '' }), /decisionId must be a non-empty string/);

  // An id that exists but is closed is equally not a grounded negative.
  graph.updateDecisionStatus(mine.id, 'archived');
  assert.throws(() => graph.reconsider({ project: 'p', decisionId: mine.id }), /not open for reconsideration/);
});

test('a focused reconsideration evaluates only its decision and raises no signal for a sibling', () => {
  const graph = createShadowGraph();
  const focused = decisionWith(graph, { key: 'lag', operator: 'gte', value: 500 }, 'p');
  const sibling = graph.addDecision({
    project: 'p', title: 'Sibling', chosen: 'c',
    alternatives: [{ label: 'other', reasonRejected: 'r', reopenWhen: [{ key: 'lag', operator: 'gte', value: 1 }] }]
  });
  graph.addFact({ project: 'p', key: 'lag', value: 900, sourceClass: 'tool_observed' });

  const result = graph.reconsider({ project: 'p', decisionId: focused.id });
  assert.equal(result.decisions.length, 1, 'only the decision asked about is evaluated');
  assert.equal(result.scope.decisionId, focused.id);
  assert.equal(result.scope.project, 'p');

  const signals = graph.getReviewSignals({ project: 'p' });
  assert.equal(signals.length, 1, 'and only that decision raises a signal');
  assert.equal(signals[0].decisionId, focused.id);
  assert.ok(!signals.some((item) => item.decisionId === sibling.id), 'the sibling was never evaluated');
});

// --- K: idempotency and review-signal behaviour ----------------------------

test('reconsidering twice settles on one signal, and an acknowledgement survives the next call', () => {
  const graph = createShadowGraph();
  decisionWith(graph, { key: 'replicaLagMs', operator: 'gte', value: 500 });
  graph.addFact({ project: 'p', key: 'replicaLagMs', value: 900, sourceClass: 'tool_observed' });

  const first = only(graph.reconsider({ project: 'p' }));
  const second = only(graph.reconsider({ project: 'p' }));
  assert.equal(graph.getReviewSignals({ project: 'p' }).length, 1, 'the identity is the one review() already uses');
  assert.equal(second.reviewSignalId, first.reviewSignalId);
  assert.equal(second.reviewSignalStatus, 'open');

  graph.acknowledgeReview(first.reviewSignalId);
  const third = only(graph.reconsider({ project: 'p' }));
  assert.equal(third.reviewSignalId, first.reviewSignalId, 'no second signal for the same breach');
  assert.equal(third.reviewSignalStatus, 'acknowledged');
  assert.equal(third.verdict, 'review_recommended', 'an acknowledgement settles the signal, not the evidence');

  // review() raises nothing new either, which is what shared identity means.
  graph.review({ project: 'p' });
  assert.equal(graph.getReviewSignals({ project: 'p' }).length, 1);
});

test('reconsideration never moves decision status, confidence or lifecycle state', () => {
  const graph = createShadowGraph();
  const decision = decisionWith(graph, { key: 'replicaLagMs', operator: 'gte', value: 500 });
  graph.addFact({ project: 'p', key: 'replicaLagMs', value: 900, sourceClass: 'tool_observed' });
  const before = graph.exportData().records.find((item) => item.id === decision.id);

  graph.reconsider({ project: 'p' });

  const after = graph.exportData().records.find((item) => item.id === decision.id);
  assert.equal(after.status, before.status, 'status is untouched');
  assert.deepEqual(after.confidence, before.confidence, 'confidence is untouched');
  assert.deepEqual(after.alternatives, before.alternatives, 'the stored rule is never rewritten by evaluating it');
});

// --- L: review() keeps its public contract ---------------------------------

test('review() returns exactly what it returned before reconsideration existed', () => {
  const graph = createShadowGraph();
  decisionWith(graph, { key: 'replicaLagMs', operator: 'gte', value: 500 });
  graph.addFact({ project: 'p', key: 'replicaLagMs', value: 900, sourceClass: 'tool_observed' });

  const due = graph.review({ project: 'p' });
  assert.ok(Array.isArray(due), 'still a bare array of due decisions');
  assert.deepEqual(Object.keys(due[0]).sort(), [
    'alternativesToReconsider', 'decisionId', 'reason', 'reviewSignalId', 'reviewSignalStatus', 'title', 'violatedConditions'
  ], 'no reconsideration field leaked onto the review entry');

  // Calling reconsider() first must not change what review() then reports, so
  // the same graph is asked twice with a reconsideration in between. Only the
  // generated ids differ between runs, and here there are none to differ.
  graph.reconsider({ project: 'p' });
  assert.deepEqual(graph.review({ project: 'p' }), due, 'reconsidering first changes nothing review() reports');
});

test('a decision with no reopen rules is unchanged and complete, with nothing invented', () => {
  const graph = createShadowGraph();
  graph.addDecision({ project: 'p', title: 'No rules', chosen: 'c', alternatives: [{ label: 'a', reasonRejected: 'r' }] });

  const entry = only(graph.reconsider({ project: 'p' }));
  assert.equal(entry.verdict, 'unchanged');
  assert.equal(entry.evaluationCompleteness, 'complete', 'zero rules were all evaluated');
  assert.deepEqual(entry.groundedConditions, []);
  assert.deepEqual(entry.factsConsidered, [], 'no evidence is claimed that does not exist');
});

// --- J: it works from persisted state, after a restart ---------------------

test('reconsideration survives a restart and is derived purely from stored state', async (t) => {
  const directory = await scratchDirectory(t, 'reconsider-restart-');
  const store = createJsonFileStore(join(directory, 'graph.json'));

  const original = createShadowGraph();
  decisionWith(original, { key: 'replicaLagMs', operator: 'gte', value: 500 });
  original.addFact({ project: 'p', key: 'replicaLagMs', value: 900, sourceClass: 'tool_observed' });
  await store.save(original.exportData());

  // A brand new graph, state loaded from disk only. The new session does not
  // know which facts changed and supplies nothing.
  const reloaded = createShadowGraph();
  reloaded.importData(await store.load());

  const entry = only(reloaded.reconsider({ project: 'p' }));
  assert.equal(entry.verdict, 'review_recommended', 'the verdict comes from persisted facts');
  assert.equal(entry.triggeredRules[0].evidence.source, 'stored_fact');
});

test('reconsideration reads the same answer from JSON and from SQLite', async (t) => {
  const directory = await scratchDirectory(t, 'reconsider-parity-');
  const source = createShadowGraph();
  decisionWith(source, { key: 'replicaLagMs', operator: 'gte', value: 500 });
  source.addFact({ project: 'p', key: 'replicaLagMs', value: 900, sourceClass: 'tool_observed' });
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
      const entry = only(graph.reconsider({ project: 'p' }));
      results[backend] = [entry.verdict, entry.evaluationCompleteness, entry.triggeredRules.length];
    });
  }

  if (results.json && results.sqlite) {
    assert.deepEqual(results.json, ['review_recommended', 'complete', 1]);
    assert.deepEqual(results.sqlite, results.json, 'both stores agree');
  }
});
