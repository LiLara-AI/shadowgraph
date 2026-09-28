// Regressions protecting review-response safety: caller-visible condition
// details stay detached from canonical state, legacy free-text reuse conditions
// are never silently dropped, an acknowledgement covers only the breach set it
// acknowledged, and expiry is applied at read time. Each block names the
// invariant it pins so a later reader knows what breaks if it is deleted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';

const NODE_SQLITE = (await getRuntimeCapabilities()).nodeSqlite;
const SQLITE_TEST_OPTIONS = NODE_SQLITE.available ? {} : { skip: NODE_SQLITE.reason };

// A fixed clock, so expiry boundaries are exact rather than raced.
const clockFrom = (start) => {
  let at = start;
  return { now: () => at, set: (value) => { at = value; } };
};

// ---------------------------------------------------------------------------
// Finding 1 -- caller-visible condition details must be detached from canonical
// storage. Mutating anything a response hands back must not edit a fact, a rule,
// or a future response, and must not slip past the journal.
// ---------------------------------------------------------------------------

// Two equally applicable facts for one key. addFact() supersedes same-key facts,
// so a genuine disagreement is staged the way review-conditions.test.js stages
// it: duplicate the fact through the import path.
function graphWithObjectEvidence() {
  const seed = createShadowGraph();
  const decision = seed.addDecision({
    project: 'p',
    title: 'Serve reads from the local replica',
    chosen: 'local-replica',
    alternatives: [{
      label: 'primary-only',
      reasonRejected: 'replica lag was acceptable',
      reopenWhen: [{ key: 'lagProfile', operator: 'contains', value: 'spike' }]
    }]
  });
  seed.addFact({ project: 'p', key: 'lagProfile', value: ['spike'], validFrom: '2026-01-02T00:00:00.000Z' });
  const snapshot = privilegedSnapshot(seed);
  const original = snapshot.facts[0];
  snapshot.facts = [...snapshot.facts, { ...original, id: 'fact:contested', value: ['spike', 'extra'] }];
  const graph = createShadowGraph();
  graph.importData(snapshot);
  return { graph, decision };
}

test('mutating a returned violatedConditions value cannot reach canonical state', () => {
  // Both the read and the persisting operation; reviewContext also stores the
  // signal the returned value must not alias.
  for (const method of ['context', 'reviewContext']) {
    const { graph } = graphWithObjectEvidence();
    // Snapshot AFTER the first call: reviewContext() raises the review signal as
    // a documented side effect, and this test is about mutation, not that.
    graph[method]({ project: 'p' });
    const before = JSON.stringify(privilegedSnapshot(graph));
    if (method === 'reviewContext') assert.equal(privilegedSnapshot(graph).reviewSignals.length, 1, 'the signal is stored');

    const breach = graph[method]({ project: 'p' }).openReviews
      .flatMap((item) => item.violatedConditions ?? [])
      .find((item) => Array.isArray(item.observed));
    assert.ok(breach, 'a breach carrying an array value is reported');
    const observed = JSON.parse(JSON.stringify(breach.observed));

    breach.observed.push('tampered');
    if (breach.evidence) breach.evidence.value = { tampered: true };
    for (const reference of breach.conflictingEvidence ?? []) reference.value = { tampered: true };

    assert.equal(JSON.stringify(privilegedSnapshot(graph)), before, `${method}: no canonical state moved`);
    const again = graph[method]({ project: 'p' }).openReviews
      .flatMap((item) => item.violatedConditions ?? [])
      .find((item) => Array.isArray(item.observed));
    assert.deepEqual(again.observed, observed, 'a later response is unaffected');
    assert.equal(again.expected, 'spike', 'the stored rule is unaffected');
  }
});

test('mutating a returned conditionDiagnostics value cannot reach canonical state', () => {
  const { graph, decision } = graphWithObjectEvidence();
  graph.context({ project: 'p' });
  const before = JSON.stringify(privilegedSnapshot(graph));

  const entry = graph.context({ project: 'p' }).conditionDiagnostics.find((item) => item.decisionId === decision.id);
  assert.ok(entry, 'the contested condition is reported as a diagnostic');
  for (const condition of entry.conditions) {
    if (Array.isArray(condition.observed)) condition.observed.push('tampered');
    if (condition.evidence) condition.evidence.value = null;
    for (const reference of condition.conflictingEvidence ?? []) reference.value = null;
  }

  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before, 'no canonical state moved');
});

test('mutating a returned attempt condition detail cannot reach canonical state', () => {
  const graph = createShadowGraph();
  graph.addAttempt({
    project: 'p', solution: 'parallel import', result: 'failed: rate limited', resultClass: 'failed',
    // An ordered operator against an array is unevaluable, so the detail lands
    // in diagnostics carrying the array it could not read.
    reusableWhen: [{ key: 'limits', operator: 'gte', value: 600 }]
  });
  graph.addFact({ project: 'p', key: 'limits', value: ['raised', 'audited'] });
  const before = JSON.stringify(privilegedSnapshot(graph));

  const condition = graph.context({ project: 'p' }).conditionDiagnostics
    .filter((item) => item.attemptId).flatMap((item) => item.conditions)
    .find((item) => Array.isArray(item.observed));
  assert.ok(condition, 'the attempt condition detail is reported');
  condition.observed.push('tampered');
  if (condition.evidence) condition.evidence.value = null;

  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before, 'no canonical state moved');
  const again = graph.context({ project: 'p' }).conditionDiagnostics
    .filter((item) => item.attemptId).flatMap((item) => item.conditions)
    .find((item) => Array.isArray(item.observed));
  assert.deepEqual(again.observed, ['raised', 'audited'], 'a later response is unaffected');
});

test('a satisfied reusable attempt hands back detached condition details', () => {
  const graph = createShadowGraph();
  graph.addAttempt({
    project: 'p', solution: 'parallel import', result: 'failed: rate limited', resultClass: 'failed',
    reusableWhen: [{ key: 'limits', operator: 'contains', value: 'raised' }]
  });
  graph.addFact({ project: 'p', key: 'limits', value: ['raised', 'audited'] });
  const before = JSON.stringify(privilegedSnapshot(graph));

  const reusable = graph.context({ project: 'p' }).reusableAttempts[0];
  assert.ok(reusable, 'the attempt is reported reusable');
  reusable.satisfiedConditions[0].observed.push('tampered');
  if (reusable.satisfiedConditions[0].evidence) reusable.satisfiedConditions[0].evidence.value = null;

  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before, 'no canonical state moved');
  assert.deepEqual(
    graph.context({ project: 'p' }).reusableAttempts[0].satisfiedConditions[0].observed,
    ['raised', 'audited'],
    'a later response is unaffected'
  );
});

test('a tampered response leaves the persisted rebuild identical', async (t) => {
  const directory = await scratchDirectory(t, 'review-detach-');
  const store = createJsonFileStore(join(directory, 'graph.json'));
  const graph = createShadowGraph();
  graph.addDecision({
    project: 'p', title: 'd', chosen: 'a',
    alternatives: [{ label: 'b', reasonRejected: 'r', reopenWhen: [{ key: 'shape', operator: 'contains', value: 'n' }] }]
  });
  graph.addFact({ project: 'p', key: 'shape', value: ['n', 'm'] });

  // Tamper BEFORE the snapshot, so a leak would be carried into what is saved.
  const breach = graph.context({ project: 'p' }).openReviews[0].violatedConditions[0];
  breach.observed.push('tampered');
  await store.save(privilegedSnapshot(graph));

  const restored = createShadowGraph();
  restored.importData(await store.load());
  const rebuilt = restored.context({ project: 'p' }).openReviews[0].violatedConditions[0];
  assert.deepEqual(rebuilt.observed, ['n', 'm'], 'rebuild restores nothing, because nothing changed');
});

// ---------------------------------------------------------------------------
// Finding 2 -- a legacy free-text reusableWhen condition is not evaluable, and
// an evaluator that cannot prove it must say unknown rather than drop it.
// ---------------------------------------------------------------------------

test('a legacy string reusableWhen condition blocks reuse instead of vanishing', () => {
  const graph = createShadowGraph();
  const attempt = graph.addAttempt({
    project: 'p', solution: 'ship it', result: 'failed: not signed off', resultClass: 'failed',
    reusableWhen: ['approval required', { key: 'ready', operator: 'equals', value: true }]
  });
  assert.deepEqual(
    attempt.reusableWhen,
    ['approval required', { key: 'ready', operator: 'equals', value: true }],
    'the legacy condition is stored exactly as written'
  );

  graph.addFact({ project: 'p', key: 'ready', value: true });
  const view = graph.context({ project: 'p' });
  assert.equal(view.reusableAttempts.length, 0, 'an unprovable condition is not permission to retry');

  const diagnostic = view.conditionDiagnostics.find((item) => item.attemptId === attempt.id);
  assert.ok(diagnostic, 'the unresolved legacy condition is visible');
  const legacy = diagnostic.conditions.find((condition) => condition.expected === 'approval required');
  assert.ok(legacy, 'the unresolved text is reported verbatim');
  assert.equal(legacy.verdict, 'unknown');
});

test('an attempt whose conditions are all structured and true is still reusable', () => {
  const graph = createShadowGraph();
  graph.addAttempt({
    project: 'p', solution: 'retry', result: 'failed: rate limited', resultClass: 'failed',
    reusableWhen: [{ key: 'ready', operator: 'equals', value: true }]
  });
  graph.addFact({ project: 'p', key: 'ready', value: true });
  assert.equal(graph.context({ project: 'p' }).reusableAttempts.length, 1);
});

// ---------------------------------------------------------------------------
// Finding 3 -- an acknowledgement covers exactly the breach set it acknowledged.
// ---------------------------------------------------------------------------

function twoThresholdDecision(graph) {
  return graph.addDecision({
    project: 'p',
    title: 'Serve reads from the local replica',
    chosen: 'local-replica',
    alternatives: [
      { label: 'primary-only', reasonRejected: 'lag was acceptable', reopenWhen: [{ key: 'lag', operator: 'gte', value: 500 }] },
      { label: 'dual-write', reasonRejected: 'lag was well under budget', reopenWhen: [{ key: 'lag', operator: 'gte', value: 1000 }] }
    ]
  });
}

test('a second threshold on the same key does not inherit the first acknowledgement', () => {
  const graph = createShadowGraph();
  const decision = twoThresholdDecision(graph);

  graph.addFact({ project: 'p', key: 'lag', value: 600 });
  const first = graph.reviewContext({ project: 'p' }).openReviews[0];
  assert.equal(first.reviewSignalStatus, 'open');
  graph.acknowledgeReview(first.reviewSignalId, { project: 'p' });
  assert.equal(graph.reviewContext({ project: 'p' }).openReviews[0].reviewSignalStatus, 'acknowledged', 'an unchanged breach stays acknowledged');

  graph.addFact({ project: 'p', key: 'lag', value: 1200 });
  const broadened = graph.reviewContext({ project: 'p' }).openReviews.find((item) => item.decisionId === decision.id);
  assert.equal(broadened.reviewSignalStatus, 'open', 'the newly breached alternative is not covered by the old acknowledgement');
  assert.equal(
    graph.getReviewSignals({ project: 'p', status: 'open' }).items.length, 1,
    'and it is reachable as an open signal'
  );
});

test('narrowing back to the acknowledged breach set restores the acknowledgement', () => {
  const graph = createShadowGraph();
  twoThresholdDecision(graph);
  graph.addFact({ project: 'p', key: 'lag', value: 600 });
  graph.acknowledgeReview(graph.reviewContext({ project: 'p' }).openReviews[0].reviewSignalId, { project: 'p' });
  graph.addFact({ project: 'p', key: 'lag', value: 1200 });
  assert.equal(graph.reviewContext({ project: 'p' }).openReviews[0].reviewSignalStatus, 'open');

  graph.addFact({ project: 'p', key: 'lag', value: 600 });
  assert.equal(
    graph.reviewContext({ project: 'p' }).openReviews[0].reviewSignalStatus, 'acknowledged',
    'the original coverage is unchanged and stays acknowledged'
  );
});

test('an acknowledgement survives a restart', async (t) => {
  const directory = await scratchDirectory(t, 'review-ack-restart-');
  const store = createJsonFileStore(join(directory, 'graph.json'));
  const graph = createShadowGraph();
  twoThresholdDecision(graph);
  graph.addFact({ project: 'p', key: 'lag', value: 600 });
  graph.acknowledgeReview(graph.reviewContext({ project: 'p' }).openReviews[0].reviewSignalId, { project: 'p' });
  await store.save(privilegedSnapshot(graph));

  const restored = createShadowGraph();
  restored.importData(await store.load());
  assert.equal(restored.reviewContext({ project: 'p' }).openReviews[0].reviewSignalStatus, 'acknowledged');

  restored.addFact({ project: 'p', key: 'lag', value: 1200 });
  assert.equal(restored.reviewContext({ project: 'p' }).openReviews[0].reviewSignalStatus, 'open', 'a broader breach is still open after a restart');
});

test('acknowledgement coverage behaves identically on JSON and SQLite', async (t) => {
  const directory = await scratchDirectory(t, 'review-ack-parity-');

  // One snapshot, with generated identifiers, feeds both backends. An earlier
  // version built a graph per backend, so each got freshly generated alternative
  // ids; coverage sorts on those ids, and masking them afterwards left two
  // correct-but-differently-ordered arrays. That made the test fail about half
  // the time for a reason that had nothing to do with the two stores.
  // Fixed clocks too, so the only value minted per backend is the new signal's
  // random id.
  const source = createShadowGraph({ now: () => '2026-02-01T00:00:00.000Z' });
  twoThresholdDecision(source);
  source.addFact({ project: 'p', key: 'lag', value: 600 });
  source.acknowledgeReview(source.reviewContext({ project: 'p' }).openReviews[0].reviewSignalId, { project: 'p' });
  const snapshot = privilegedSnapshot(source);

  const snapshots = {};
  for (const backend of ['json', 'sqlite']) {
    await t.test(backend, backend === 'sqlite' ? SQLITE_TEST_OPTIONS : {}, async () => {
      const path = join(directory, backend === 'json' ? 'state.json' : 'state.db');
      let store = backend === 'json' ? createJsonFileStore(path) : await createSqliteStore(path);
      await store.save(snapshot);
      store.close?.();

      store = backend === 'json' ? createJsonFileStore(path) : await createSqliteStore(path);
      const durable = await store.load();
      store.close?.();

      const restarted = createShadowGraph({ now: () => '2026-02-02T00:00:00.000Z' });
      restarted.importData(durable);
      assert.equal(restarted.reviewContext({ project: 'p' }).openReviews[0].reviewSignalStatus, 'acknowledged', `${backend}: the acknowledgement survives`);

      const broad = restarted.addFact({ project: 'p', key: 'lag', value: 1200 });
      assert.equal(restarted.reviewContext({ project: 'p' }).openReviews[0].reviewSignalStatus, 'open', `${backend}: the broadened breach is open`);

      // Both backends import the same generated identities. Normalize only
      // the new fact and signal IDs each backend generated independently. Coverage now sorts on identical
      // alternative ids, so its order is deterministic too.
      snapshots[backend] = JSON.stringify(
        restarted.getReviewSignals({ project: 'p' }).items.sort((left, right) => left.status.localeCompare(right.status))
      ).replaceAll(broad.id, 'fact_MINTED').replace(/review_\d+_[a-z0-9]+/g, 'review_MINTED');
    });
  }

  if (snapshots.json && snapshots.sqlite) {
    assert.equal(snapshots.sqlite, snapshots.json, 'both stores produce identical review signals');
    assert.match(snapshots.json, /"coverage":\[/, 'and coverage really is being compared');
  }
});

// ---------------------------------------------------------------------------
// Finding 4 -- read-time evaluation must not treat already-expired evidence as
// current merely because maintain() has not run yet.
// ---------------------------------------------------------------------------

function expiringReuseGraph(clock) {
  const graph = createShadowGraph({ now: clock.now });
  graph.addAttempt({
    project: 'p', solution: 'retry', result: 'failed: quota', resultClass: 'failed',
    reusableWhen: [{ key: 'quotaRaised', operator: 'equals', value: true }]
  });
  graph.addFact({
    project: 'p', key: 'quotaRaised', value: true,
    observedAt: '2025-12-01T00:00:00.000Z', validFrom: '2025-12-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:00:00.000Z'
  });
  return graph;
}

test('expired evidence stops satisfying reusableWhen at the boundary, before maintain runs', () => {
  const clock = clockFrom('2025-12-31T23:59:59.000Z');
  const graph = expiringReuseGraph(clock);
  assert.equal(graph.context({ project: 'p' }).reusableAttempts.length, 1, 'valid just before expiry');

  clock.set('2026-01-01T00:00:00.000Z');
  const atBoundary = graph.context({ project: 'p' });
  assert.equal(atBoundary.reusableAttempts.length, 0, 'the boundary instant is already expired');
  const diagnostic = atBoundary.conditionDiagnostics.find((item) => item.attemptId);
  assert.ok(diagnostic, 'and the missing evidence is visible');
  assert.equal(diagnostic.conditions[0].verdict, 'unknown');

  clock.set('2026-01-01T00:00:01.000Z');
  assert.equal(graph.context({ project: 'p' }).reusableAttempts.length, 0, 'and after it');
});

test('maintain changes housekeeping, not the semantic answer', () => {
  const clock = clockFrom('2026-01-02T00:00:00.000Z');
  const graph = expiringReuseGraph(clock);
  const before = graph.context({ project: 'p' });
  graph.maintain({ project: 'p' });
  const after = graph.context({ project: 'p' });
  assert.deepEqual(after.reusableAttempts, before.reusableAttempts);
  assert.deepEqual(after.conditionDiagnostics, before.conditionDiagnostics);
  assert.equal(after.reusableAttempts.length, 0);
});

test('a validTo boundary expires read-time evidence the same way expiresAt does', () => {
  const clock = clockFrom('2025-12-31T23:59:59.000Z');
  const graph = createShadowGraph({ now: clock.now });
  graph.addAttempt({
    project: 'p', solution: 'retry', result: 'failed: quota', resultClass: 'failed',
    reusableWhen: [{ key: 'quotaRaised', operator: 'equals', value: true }]
  });
  graph.addFact({ project: 'p', key: 'quotaRaised', value: true, validTo: '2026-01-01T00:00:00.000Z' });
  assert.equal(graph.context({ project: 'p' }).reusableAttempts.length, 1);
  clock.set('2026-01-01T00:00:00.000Z');
  assert.equal(graph.context({ project: 'p' }).reusableAttempts.length, 0);
});

test('an expired candidate drops out of conflicting evidence rather than contesting it', () => {
  const clock = clockFrom('2025-12-31T23:59:59.000Z');
  const seed = createShadowGraph({ now: clock.now });
  seed.addDecision({
    project: 'p', title: 'd', chosen: 'a',
    alternatives: [{ label: 'b', reasonRejected: 'r', reopenWhen: [{ key: 'lag', operator: 'gte', value: 500 }] }]
  });
  // The surviving observation says no breach; the expiring one disagrees.
  seed.addFact({ project: 'p', key: 'lag', value: 100, validFrom: '2025-12-01T00:00:00.000Z' });
  const snapshot = privilegedSnapshot(seed);
  const original = snapshot.facts[0];
  snapshot.facts = [...snapshot.facts, {
    ...original, id: 'fact:expiring', value: 600,
    expiresAt: '2026-01-01T00:00:00.000Z',
    validityPolicy: { declaredExpiresAt: '2026-01-01T00:00:00.000Z', declaredValidTo: null, effectiveExpirationBoundary: '2026-01-01T00:00:00.000Z' }
  }];
  const graph = createShadowGraph({ now: clock.now });
  graph.importData(snapshot);

  const contested = graph.context({ project: 'p' }).conditionDiagnostics
    .flatMap((item) => item.conditions).find((condition) => condition.conflictingEvidence);
  assert.ok(contested, 'while both are live the disagreement is reported');

  clock.set('2026-01-01T00:00:01.000Z');
  const settled = graph.context({ project: 'p' }).conditionDiagnostics
    .flatMap((item) => item.conditions).find((condition) => condition.conflictingEvidence);
  assert.equal(settled, undefined, 'once the older fact expires nothing contests the survivor');
});
