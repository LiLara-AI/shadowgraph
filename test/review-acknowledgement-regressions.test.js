// Regressions protecting review acknowledgement scope: a legacy acknowledgement
// is never widened, every returned detail field is detached, and acknowledgement
// identity does not depend on the order rules happen to be stored in. Each block
// names the invariant it pins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NODE_SQLITE = (await getRuntimeCapabilities()).nodeSqlite;
const SQLITE_TEST_OPTIONS = NODE_SQLITE.available ? {} : { skip: NODE_SQLITE.reason };

// ---------------------------------------------------------------------------
// Shared fixture: one decision, two alternatives whose reopenWhen rules key on
// the same fact. Stable ids so a snapshot can be hand-built and reordered.
// ---------------------------------------------------------------------------

const LAG_LOW = { key: 'lag', operator: 'gte', value: 500 };
const LAG_HIGH = { key: 'lag', operator: 'gte', value: 1000 };

function seedGraph({ rules = [LAG_LOW, LAG_HIGH] } = {}) {
  const graph = createShadowGraph();
  graph.addDecision({
    project: 'p', id: 'decision:d1', title: 'Serve reads from the local replica', chosen: 'local-replica',
    alternatives: rules.map((rule, index) => ({
      id: `alternative:a${index + 1}`,
      label: `alt-${index + 1}`,
      reasonRejected: 'was acceptable',
      reopenWhen: [rule]
    }))
  });
  return graph;
}

// The historical coverage of the lag >= 500 breach, as a pre-coverage signal
// would have recorded it: the alternative that carried the rule, the rule's
// operator, and the value it compared against.
function legacyAcknowledgedSignal({ withConditions = true } = {}) {
  return {
    id: 'review:legacy',
    kind: 'review',
    decisionId: 'decision:d1',
    title: 'Serve reads from the local replica',
    reason: 'lag',
    alternativesToReconsider: ['alt-1'],
    ...(withConditions
      ? {
        violatedConditions: [{
          decisionId: 'decision:d1',
          alternativeId: 'alternative:a1',
          alternativeLabel: 'alt-1',
          key: 'lag',
          operator: 'gte',
          expected: 500,
          observed: 600,
          verdict: 'true',
          reason: 'Ordered comparison gte'
        }]
      }
      : {}),
    status: 'acknowledged',
    createdAt: '2026-01-01T00:00:00.000Z',
    acknowledgedAt: '2026-01-02T00:00:00.000Z'
  };
}

// Build a graph holding the legacy signal, then observe `lag`.
function graphWithLegacySignal({ withConditions = true, lag = 1200 } = {}) {
  const seed = seedGraph();
  const snapshot = seed.exportData();
  snapshot.reviewSignals = [legacyAcknowledgedSignal({ withConditions })];
  const graph = createShadowGraph();
  graph.importData(snapshot);
  graph.addFact({ project: 'p', key: 'lag', value: lag });
  return graph;
}

const openReview = (graph) => graph.context({ project: 'p' }).openReviews[0];

// ---------------------------------------------------------------------------
// HIGH 1 -- a legacy acknowledgement must never be widened to cover conditions
// nobody can show were acknowledged.
// ---------------------------------------------------------------------------

test('a legacy acknowledgement with no recorded conditions never covers a current breach', () => {
  const graph = graphWithLegacySignal({ withConditions: false });

  assert.equal(openReview(graph).reviewSignalStatus, 'open', 'unknown historical scope cannot acknowledge anything');
  const legacy = graph.getReviewSignals({ project: 'p' }).find((item) => item.id === 'review:legacy');
  assert.ok(legacy, 'the legacy signal is kept as historical data');
  assert.equal(legacy.status, 'acknowledged', 'and is not rewritten');
  assert.equal(legacy.coverage, undefined, 'and is not stamped with coverage it never had');
});

test('a legacy acknowledgement is not widened onto a broader current breach set', () => {
  const graph = graphWithLegacySignal({ lag: 1200 });

  assert.equal(openReview(graph).reviewSignalStatus, 'open', 'lag >= 1000 was never acknowledged');
  const legacy = graph.getReviewSignals({ project: 'p' }).find((item) => item.id === 'review:legacy');
  assert.equal(legacy.status, 'acknowledged', 'the legacy signal is preserved unchanged');
  assert.equal(legacy.coverage, undefined, 'and is never stamped with a wider coverage set');
});

test('a legacy acknowledgement still covers the exact breach it recorded', () => {
  const graph = graphWithLegacySignal({ lag: 600 });

  const review = openReview(graph);
  assert.equal(review.reviewSignalStatus, 'acknowledged', 'reconstructed historical coverage matches exactly');
  assert.equal(review.reviewSignalId, 'review:legacy', 'and the stored signal id is preserved');
});

test('a breach set that broadens then narrows returns to the legacy acknowledgement', () => {
  const graph = graphWithLegacySignal({ lag: 600 });
  assert.equal(openReview(graph).reviewSignalStatus, 'acknowledged');

  graph.addFact({ project: 'p', key: 'lag', value: 1200 });
  assert.equal(openReview(graph).reviewSignalStatus, 'open', 'the broader set is not covered');

  graph.addFact({ project: 'p', key: 'lag', value: 600 });
  const back = openReview(graph);
  assert.equal(back.reviewSignalStatus, 'acknowledged', 'and narrowing back returns to it');
  assert.equal(back.reviewSignalId, 'review:legacy');
});

test('legacy acknowledgement coverage survives export, import and restart', async (t) => {
  const directory = await scratchDirectory(t, 'legacy-ack-restart-');
  const store = createJsonFileStore(join(directory, 'graph.json'));
  const graph = graphWithLegacySignal({ lag: 600 });
  assert.equal(openReview(graph).reviewSignalStatus, 'acknowledged');
  await store.save(graph.exportData());

  const restored = createShadowGraph();
  restored.importData(await store.load());
  assert.equal(openReview(restored).reviewSignalStatus, 'acknowledged', 'still covered after a restart');

  restored.addFact({ project: 'p', key: 'lag', value: 1200 });
  assert.equal(openReview(restored).reviewSignalStatus, 'open', 'and a broader breach is still open after a restart');
});

test('legacy acknowledgement handling is identical on JSON and SQLite', async (t) => {
  const directory = await scratchDirectory(t, 'legacy-ack-parity-');
  const source = graphWithLegacySignal({ lag: 600 });
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
      const narrow = openReview(graph);
      graph.addFact({ project: 'p', key: 'lag', value: 1200, id: 'fact:broad' });
      const broad = openReview(graph);
      results[backend] = [narrow.reviewSignalId, narrow.reviewSignalStatus, broad.reviewSignalStatus];
    });
  }

  if (results.json && results.sqlite) {
    assert.deepEqual(results.json, ['review:legacy', 'acknowledged', 'open']);
    assert.deepEqual(results.sqlite, results.json, 'both stores agree');
  }
});

test('the compact list and acknowledge flow settles the new breach without touching the legacy signal', () => {
  const graph = graphWithLegacySignal({ lag: 1200 });

  // Compact clients list through context() and acknowledge by reviewSignalId.
  const listed = openReview(graph);
  assert.equal(listed.reviewSignalStatus, 'open');
  assert.notEqual(listed.reviewSignalId, 'review:legacy', 'the new breach set has its own signal');

  graph.acknowledgeReview(listed.reviewSignalId);
  assert.equal(openReview(graph).reviewSignalStatus, 'acknowledged', 'acknowledging it settles it');

  const legacy = graph.getReviewSignals({ project: 'p' }).find((item) => item.id === 'review:legacy');
  assert.equal(legacy.status, 'acknowledged');
  assert.equal(legacy.acknowledgedAt, '2026-01-02T00:00:00.000Z', 'the historical record is untouched');
});

// ---------------------------------------------------------------------------
// HIGH 2 -- lenient import accepts rule metadata that write-time validation
// would reject. Every field of a returned detail must still be detached.
// ---------------------------------------------------------------------------

// A rule whose `operator` and `unit` are objects rather than strings. Write-time
// validation rejects this; import preserves stored records verbatim, so a
// response can carry it and must not carry it by reference.
function graphWithObjectRuleMetadata() {
  const seed = createShadowGraph();
  seed.addDecision({
    project: 'p', id: 'decision:d1', title: 't', chosen: 'c',
    alternatives: [{ id: 'alternative:a1', label: 'alt-1', reasonRejected: 'r', reopenWhen: [{ key: 'lag', operator: 'gte', value: 500 }] }]
  });
  const snapshot = seed.exportData();
  snapshot.records[0].alternatives[0].reopenWhen = [{
    key: 'lag',
    operator: { name: ['gte'] },
    unit: { name: ['ms'] },
    value: { threshold: [500] }
  }];
  const graph = createShadowGraph();
  graph.importData(snapshot);
  graph.addFact({ project: 'p', key: 'lag', value: { observed: [600] } });
  return graph;
}

const objectOperatorCondition = (graph) => graph.context({ project: 'p' }).conditionDiagnostics
  .flatMap((item) => item.conditions)
  .find((item) => item.operator && typeof item.operator === 'object');

test('object-valued operator and unit from a lenient import are detached', () => {
  const graph = graphWithObjectRuleMetadata();
  graph.context({ project: 'p' });
  const before = JSON.stringify(graph.exportData());

  const condition = objectOperatorCondition(graph);
  assert.ok(condition, 'the unevaluable condition is reported');

  condition.operator.name.push('tampered');
  condition.unit.name.push('tampered');
  if (condition.expected && typeof condition.expected === 'object') condition.expected.threshold.push(-1);
  if (condition.observed && typeof condition.observed === 'object') condition.observed.observed.push(-1);
  if (condition.evidence) condition.evidence.value = { tampered: true };

  assert.equal(JSON.stringify(graph.exportData()), before, 'no canonical state moved');
  const again = objectOperatorCondition(graph);
  assert.deepEqual(again.operator, { name: ['gte'] }, 'a later response is unaffected');
  assert.deepEqual(again.unit, { name: ['ms'] });
});

test('a detached detail keeps a key whose value is undefined', () => {
  const graph = createShadowGraph();
  graph.addDecision({
    project: 'p', title: 't', chosen: 'c',
    alternatives: [{ label: 'alt', reasonRejected: 'r', reopenWhen: [{ key: 'absent', operator: 'gte', value: 1 }] }]
  });
  const condition = graph.context({ project: 'p' }).conditionDiagnostics[0].conditions[0];
  assert.ok('observed' in condition, 'the key survives detachment so "no evidence" stays reportable');
  assert.equal(condition.observed, undefined);
});

test('an object-valued attempt rule from a lenient import is detached', () => {
  const seed = createShadowGraph();
  seed.addAttempt({
    project: 'p', id: 'attempt:t1', solution: 's', result: 'failed', resultClass: 'failed',
    reusableWhen: [{ key: 'lag', operator: 'gte', value: 500 }]
  });
  const snapshot = seed.exportData();
  snapshot.records[0].reusableWhen = [{ key: 'lag', operator: { name: ['gte'] }, unit: { name: ['ms'] }, value: [500] }];
  const graph = createShadowGraph();
  graph.importData(snapshot);
  graph.addFact({ project: 'p', key: 'lag', value: [600] });
  graph.context({ project: 'p' });
  const before = JSON.stringify(graph.exportData());

  const condition = graph.context({ project: 'p' }).conditionDiagnostics
    .filter((item) => item.attemptId).flatMap((item) => item.conditions)[0];
  assert.ok(condition, 'the attempt condition is reported');
  condition.operator.name.push('tampered');
  condition.unit.name.push('tampered');
  condition.expected.push(-1);
  condition.observed.push(-1);

  assert.equal(JSON.stringify(graph.exportData()), before, 'no canonical state moved');
});

test('a tampered detail leaves the journal and a rebuild untouched', async (t) => {
  const directory = await scratchDirectory(t, 'detach-rebuild-');
  const store = createJsonFileStore(join(directory, 'graph.json'));
  const graph = graphWithObjectRuleMetadata();
  graph.context({ project: 'p' });
  const journalBefore = JSON.stringify(graph.exportData().journal);

  const condition = objectOperatorCondition(graph);
  condition.operator.name.push('tampered');
  condition.unit.name.push('tampered');

  assert.equal(JSON.stringify(graph.exportData().journal), journalBefore, 'the journal is unchanged');
  await store.save(graph.exportData());
  const restored = createShadowGraph();
  restored.importData(await store.load());
  const rebuilt = objectOperatorCondition(restored);
  assert.deepEqual(rebuilt.operator, { name: ['gte'] }, 'rebuild parity holds');
  assert.deepEqual(rebuilt.unit, { name: ['ms'] });
});

// ---------------------------------------------------------------------------
// MEDIUM 1 -- reordering rules must not change acknowledgement identity.
// ---------------------------------------------------------------------------

const TWO_KEY_RULES = [
  { key: 'lag', operator: 'gte', value: 500 },
  { key: 'load', operator: 'gte', value: 50 }
];

function acknowledgedTwoKeyGraph() {
  const graph = seedGraph({ rules: TWO_KEY_RULES });
  graph.addFact({ project: 'p', key: 'lag', value: 600 });
  graph.addFact({ project: 'p', key: 'load', value: 60 });
  const review = openReview(graph);
  assert.equal(review.reason, 'lag, load', 'both keys are named');
  graph.acknowledgeReview(review.reviewSignalId);
  return graph;
}

// Reverse the alternatives, which reverses the order the reasons are built in.
function reimportReversed(graph) {
  const snapshot = graph.exportData();
  const decision = snapshot.records.find((item) => item.kind === 'decision');
  decision.alternatives = [...decision.alternatives].reverse();
  const reopened = createShadowGraph();
  reopened.importData(snapshot);
  return reopened;
}

test('reordering rules on different keys does not reopen an acknowledged review', () => {
  const reordered = reimportReversed(acknowledgedTwoKeyGraph());
  const review = openReview(reordered);
  assert.equal(review.reason, 'load, lag', 'the reason follows the stored order and is not rewritten');
  assert.equal(review.reviewSignalStatus, 'acknowledged', 'but identity does not depend on that order');
  assert.equal(reordered.getReviewSignals({ project: 'p', status: 'open' }).length, 0, 'no duplicate signal appears');
});

test('reordering rules on the same key does not reopen an acknowledged review', () => {
  const graph = seedGraph({ rules: [LAG_LOW, LAG_HIGH] });
  graph.addFact({ project: 'p', key: 'lag', value: 1200 });
  graph.acknowledgeReview(openReview(graph).reviewSignalId);

  const reordered = reimportReversed(graph);
  assert.equal(openReview(reordered).reviewSignalStatus, 'acknowledged');
  assert.equal(reordered.getReviewSignals({ project: 'p', status: 'open' }).length, 0);
});

test('a genuinely changed breach set still opens a new signal after a reorder', () => {
  const graph = seedGraph({ rules: [LAG_LOW, LAG_HIGH] });
  graph.addFact({ project: 'p', key: 'lag', value: 600 });
  graph.acknowledgeReview(openReview(graph).reviewSignalId);

  const reordered = reimportReversed(graph);
  assert.equal(openReview(reordered).reviewSignalStatus, 'acknowledged', 'the same coverage stays acknowledged');
  reordered.addFact({ project: 'p', key: 'lag', value: 1200 });
  assert.equal(openReview(reordered).reviewSignalStatus, 'open', 'a real change still opens');
});

test('reorder stability holds across a restart on JSON and SQLite', async (t) => {
  const directory = await scratchDirectory(t, 'reorder-parity-');
  const snapshot = reimportReversed(acknowledgedTwoKeyGraph()).exportData();
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
      results[backend] = [openReview(graph).reviewSignalStatus, graph.getReviewSignals({ project: 'p', status: 'open' }).length];
    });
  }

  if (results.json && results.sqlite) {
    assert.deepEqual(results.json, ['acknowledged', 0]);
    assert.deepEqual(results.sqlite, results.json, 'both stores agree');
  }
});
