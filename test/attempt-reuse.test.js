import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createShadowGraph, ATTEMPT_RESULT_CLASSES } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const failedIds = (graph, project = 'p') =>
  graph.context({ project }).failedAttemptsToAvoid.map((item) => item.id);

test('an explicit result class decides, and the wording heuristic only fills the gap', () => {
  const graph = createShadowGraph();
  // Legacy shape: no resultClass, and the wording is what classifies it.
  const legacy = graph.addAttempt({ project: 'p', solution: 'retry loop', result: 'failed after three attempts' });
  // Misleading wording: says "no error", but the attempt genuinely failed.
  const declaredFail = graph.addAttempt({ project: 'p', solution: 'cache warmer', result: 'no error, but the cache stayed cold', resultClass: 'failed' });
  // The opposite trap: the word "regression" appears, yet nothing failed.
  const declaredPass = graph.addAttempt({ project: 'p', solution: 'nightly job', result: 'regression suite passed clean', resultClass: 'succeeded' });

  const failing = failedIds(graph);
  assert.ok(failing.includes(legacy.id), 'legacy wording still classifies');
  assert.ok(failing.includes(declaredFail.id), 'a declared failure surfaces even when the words do not say so');
  assert.ok(!failing.includes(declaredPass.id), 'a declared success is not dragged in by the word regression');
});

test('a declared class is distinguishable from an inferred one', () => {
  const graph = createShadowGraph();
  graph.addAttempt({ project: 'p', solution: 'a', result: 'error while linking' });
  graph.addAttempt({ project: 'p', solution: 'b', result: 'quietly wrong', resultClass: 'failed' });

  const attempts = graph.context({ project: 'p' }).failedAttemptsToAvoid;
  const inferred = attempts.find((item) => item.solution === 'a');
  const declared = attempts.find((item) => item.solution === 'b');
  assert.equal(inferred.resultClass, undefined, 'an inferred classification is never written back as if declared');
  assert.equal(declared.resultClass, 'failed');
});

test('an unusable result class is rejected at the write', () => {
  const graph = createShadowGraph();
  assert.throws(
    () => graph.addAttempt({ project: 'p', solution: 'a', result: 'b', resultClass: 'catastrophe' }),
    /resultClass must be failed, succeeded, or inconclusive/
  );
  assert.deepEqual([...ATTEMPT_RESULT_CLASSES], ['failed', 'succeeded', 'inconclusive']);
});

test('reusableWhen only reports an attempt once every condition holds', () => {
  const graph = createShadowGraph();
  const attempt = graph.addAttempt({
    project: 'p',
    solution: 'parallel import',
    result: 'failed: the source API rate-limited us',
    resultClass: 'failed',
    reusableWhen: [
      { key: 'apiRateLimitPerMin', operator: 'gte', value: 600 },
      { key: 'importerVersion', operator: 'equals', value: '2.x' }
    ]
  });

  // Nothing known yet: not reusable, and the uncertainty is reported.
  let view = graph.context({ project: 'p' });
  assert.equal(view.reusableAttempts.length, 0);
  assert.ok(view.conditionDiagnostics.some((item) => item.attemptId === attempt.id));

  // One of two conditions holds. Combination is ALL, so still not reusable.
  graph.addFact({ project: 'p', key: 'apiRateLimitPerMin', value: 1200, sourceClass: 'measured' });
  view = graph.context({ project: 'p' });
  assert.equal(view.reusableAttempts.length, 0, 'a partially satisfied precondition is not permission');

  // Both hold.
  graph.addFact({ project: 'p', key: 'importerVersion', value: '2.x', sourceClass: 'human' });
  view = graph.context({ project: 'p' });
  assert.equal(view.reusableAttempts.length, 1);
  const [reusable] = view.reusableAttempts;
  assert.equal(reusable.attemptId, attempt.id);
  assert.equal(reusable.satisfiedConditions.length, 2);
  assert.ok(reusable.satisfiedConditions.every((item) => item.verdict === 'true'));
  assert.ok(reusable.satisfiedConditions.every((item) => item.evidence.factId));
});

test('retrying stays blocked while any condition is unresolved', () => {
  const graph = createShadowGraph();
  const attempt = graph.addAttempt({
    project: 'p',
    solution: 'parallel import',
    result: 'failed: rate limited',
    resultClass: 'failed',
    reusableWhen: [{ key: 'apiRateLimitPerMin', operator: 'gte', value: 600 }]
  });
  // Present but unreadable for an ordered comparison: unknown, never permission.
  graph.addFact({ project: 'p', key: 'apiRateLimitPerMin', value: 'plenty', sourceClass: 'human' });

  const view = graph.context({ project: 'p' });
  assert.equal(view.reusableAttempts.length, 0, 'unknown must not read as safe to retry');
  const diagnostic = view.conditionDiagnostics.find((item) => item.attemptId === attempt.id);
  assert.ok(diagnostic, 'and the reason is visible');
  assert.equal(diagnostic.conditions[0].verdict, 'unknown');
});

test('a reusable attempt keeps its recorded failure; it is not authorisation to retry', () => {
  const graph = createShadowGraph();
  const attempt = graph.addAttempt({
    project: 'p',
    solution: 'parallel import',
    result: 'failed: the source API rate-limited us',
    resultClass: 'failed',
    reusableWhen: [{ key: 'apiRateLimitPerMin', operator: 'gte', value: 600 }]
  });
  graph.addFact({ project: 'p', key: 'apiRateLimitPerMin', value: 1200, sourceClass: 'measured' });

  const view = graph.context({ project: 'p' });
  assert.equal(view.reusableAttempts.length, 1, 'it may be reconsidered');
  assert.ok(failedIds(graph).includes(attempt.id), 'and it is STILL listed as a failure to avoid');

  const stored = graph.exportData().records.find((item) => item.id === attempt.id);
  assert.equal(stored.resultClass, 'failed', 'the historical failure is untouched');
  assert.match(stored.result, /rate-limited/);
});

test('citing a failure is not the same as the recommendation being compatible with it', () => {
  const graph = createShadowGraph();
  const attempt = graph.addAttempt({
    project: 'p',
    solution: 'parallel import',
    result: 'failed: rate limited',
    resultClass: 'failed',
    reusableWhen: [{ key: 'apiRateLimitPerMin', operator: 'gte', value: 600 }]
  });
  // A decision that cites the attempt says nothing about whether conditions changed.
  graph.addDecision({ project: 'p', title: 'Import nightly instead', chosen: 'serial-import', failedAttempts: [attempt.id] });
  graph.addFact({ project: 'p', key: 'apiRateLimitPerMin', value: 100, sourceClass: 'measured' });

  const view = graph.context({ project: 'p' });
  assert.ok(failedIds(graph).includes(attempt.id), 'the failure is cited and available');
  assert.equal(view.reusableAttempts.length, 0, 'but conditions have NOT changed, so nothing claims it is retryable');
});

test('an attempt with no reusableWhen is never reported as reusable', () => {
  const graph = createShadowGraph();
  graph.addAttempt({ project: 'p', solution: 'a', result: 'failed hard' });
  graph.addFact({ project: 'p', key: 'anything', value: 1, sourceClass: 'measured' });
  const view = graph.context({ project: 'p' });
  assert.equal(view.reusableAttempts.length, 0);
  assert.equal(view.conditionDiagnostics.length, 0);
});

test('reuse evaluation is project scoped and declared by the completeness contract', () => {
  const graph = createShadowGraph();
  graph.addAttempt({ project: 'other', solution: 'x', result: 'failed', reusableWhen: [{ key: 'k', operator: 'equals', value: 1 }] });
  graph.addFact({ project: 'other', key: 'k', value: 1, sourceClass: 'measured' });

  const mine = graph.context({ project: 'p' });
  assert.equal(mine.reusableAttempts.length, 0, 'another project is not visible here');
  assert.ok(mine.completeness.collections.reusableAttempts, 'the collection declares its own counts');
  assert.equal(mine.completeness.collections.reusableAttempts.total, 0);

  const theirs = graph.context({ project: 'other' });
  assert.equal(theirs.reusableAttempts.length, 1);
});

test('resultClass and reusableWhen survive export, restart and journal rebuild', async (t) => {
  const directory = await scratchDirectory(t);
  const store = await createJsonFileStore(join(directory, 'memory.json'));

  const graph = createShadowGraph();
  const attempt = graph.addAttempt({
    project: 'p', solution: 'parallel import', result: 'no error, but nothing imported',
    resultClass: 'failed',
    reusableWhen: [{ key: 'apiRateLimitPerMin', operator: 'gte', value: 600 }]
  });
  graph.addFact({ project: 'p', key: 'apiRateLimitPerMin', value: 1200, sourceClass: 'measured' });
  await store.save(graph.exportData());

  const reopened = createShadowGraph();
  reopened.importData(await store.load());
  const stored = reopened.exportData().records.find((item) => item.id === attempt.id);
  assert.equal(stored.resultClass, 'failed');
  assert.equal(stored.reusableWhen[0].operator, 'gte');
  assert.ok(failedIds(reopened).includes(attempt.id), 'the declared failure still classifies after restart');
  assert.equal(reopened.context({ project: 'p' }).reusableAttempts.length, 1);

  // The journal projection must agree with the live graph.
  reopened.rebuild();
  const fromJournal = reopened.exportData().records.find((item) => item.id === attempt.id);
  assert.equal(fromJournal.resultClass, 'failed', 'rebuild preserves the declared class');
  assert.equal(fromJournal.reusableWhen[0].operator, 'gte');
});
