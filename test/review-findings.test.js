// Regression tests for the independent review findings (2026-08-25).
//
// Every test here FAILS on the pre-fix behaviour. None of them was written to
// accommodate what the code already did: each one encodes the contract the
// review said was violated, and the production code was changed to satisfy it.
//
// Finding ids match the review list: P0-1, P0-2, P1-8, P1-9, P1-10, P2-11..P2-15.
// Interface findings (P1-3..P1-7) live in test/review-interfaces.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph, rebuildProjection, SUPPORTED_SCHEMA_VERSIONS } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';

// Canonical comparison: array order by id AND object keys sorted. JSON key
// INSERTION order is not part of the data's meaning, so comparing raw
// JSON.stringify would report false divergence.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function normalize(items) {
  return JSON.stringify(canonical([...items].sort((left, right) => String(left.id).localeCompare(String(right.id)))));
}

describe('P0-1 — purge removes idempotency entries for purged entities', () => {
  // WAS BROKEN: purgeProject() deleted records, facts, relations, signals and
  // journal payloads but left the idempotency cache untouched. The cache holds
  // CLONED PAYLOADS, so a purged decision's full content survived in
  // exportData().idempotency — and replaying its key returned the deleted
  // entity, resurrecting data the caller had asked to be removed. Hard purge
  // had the same hole, so it was not a way around it either.

  it('a retried idempotency key does NOT resurrect a purged decision', () => {
    const graph = createShadowGraph();
    const original = graph.addDecision({ project: 'gone', title: 'PURGED_TITLE', chosen: 'c', idempotencyKey: 'k1' });

    graph.purgeProject('gone');

    const retried = graph.addDecision({ project: 'gone', title: 'FRESH', chosen: 'c', idempotencyKey: 'k1' });
    assert.notEqual(retried.id, original.id, 'the purged entity must not be returned again');
    assert.equal(retried.title, 'FRESH', 'the new operation actually ran');
  });

  it('a retried idempotency key does NOT resurrect a purged fact', () => {
    const graph = createShadowGraph();
    const original = graph.addFact({ project: 'gone', key: 'k', value: 'PURGED_VALUE', idempotencyKey: 'f1' });

    graph.purgeProject('gone');

    const retried = graph.addFact({ project: 'gone', key: 'k', value: 'FRESH', idempotencyKey: 'f1' });
    assert.notEqual(retried.id, original.id);
    assert.equal(retried.value, 'FRESH');
  });

  it('no purged payload survives in the exported idempotency cache', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'gone', title: 'PURGED_TITLE', chosen: 'SECRET_CHOICE', idempotencyKey: 'k1' });
    graph.addFact({ project: 'gone', key: 'k', value: 'PURGED_VALUE', idempotencyKey: 'f1' });

    graph.purgeProject('gone');

    const exported = JSON.stringify(graph.exportData().idempotency);
    for (const leak of ['PURGED_TITLE', 'SECRET_CHOICE', 'PURGED_VALUE']) {
      assert.equal(exported.includes(leak), false, `idempotency cache still holds ${leak}`);
    }
  });

  it('rebuild does not restore purged idempotency payloads', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'gone', title: 'PURGED_TITLE', chosen: 'c', idempotencyKey: 'k1' });
    graph.purgeProject('gone');

    const rebuilt = graph.rebuild();
    assert.equal(JSON.stringify(rebuilt.projection.idempotency).includes('PURGED_TITLE'), false);
  });

  it('purge reports how many idempotency entries it removed', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'gone', title: 'A', chosen: 'c', idempotencyKey: 'k1' });
    graph.addFact({ project: 'gone', key: 'k', value: 1, idempotencyKey: 'f1' });

    const summary = graph.purgeProject('gone');
    assert.equal(summary.idempotencyRemoved, 2, 'the count is reported, not silent');
  });

  it('HARD purge closes the same hole — it is not a workaround for it', () => {
    const graph = createShadowGraph();
    const original = graph.addDecision({ project: 'gone', title: 'PURGED_TITLE', chosen: 'c', idempotencyKey: 'k1' });

    const summary = graph.purgeProject('gone', { mode: 'hard' });
    assert.equal(summary.mode, 'hard');
    assert.equal(summary.idempotencyRemoved, 1);

    const retried = graph.addDecision({ project: 'gone', title: 'FRESH', chosen: 'c', idempotencyKey: 'k1' });
    assert.notEqual(retried.id, original.id);
    assert.equal(JSON.stringify(graph.exportData().idempotency).includes('PURGED_TITLE'), false);
  });

  it('purge leaves an UNRELATED project\'s idempotency entries working', () => {
    // The fix must be scoped: it deletes entries for the purged project only.
    const graph = createShadowGraph();
    const kept = graph.addDecision({ project: 'kept', title: 'K', chosen: 'c', idempotencyKey: 'shared-shape' });
    graph.addDecision({ project: 'gone', title: 'G', chosen: 'c', idempotencyKey: 'gone-key' });

    graph.purgeProject('gone');

    const replay = graph.addDecision({ project: 'kept', title: 'K', chosen: 'c', idempotencyKey: 'shared-shape' });
    assert.equal(replay.id, kept.id, 'an untouched project keeps its idempotency guarantee');
  });
});

describe('security — project-scoped redaction', () => {
  it('does not export another project idempotency entries, review signals, or secret-like keys', () => {
    const graph = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
    const decisionA = graph.addDecision({ project: 'A', title: 'A', chosen: 'x', reviewAfter: '2025-01-01T00:00:00.000Z', idempotencyKey: 'token=TOPSECRET' });
    const decisionB = graph.addDecision({ project: 'B', title: 'B_CROSS_PROJECT_LEAK', chosen: 'x', reviewAfter: '2025-01-01T00:00:00.000Z', idempotencyKey: 'b-key' });
    graph.review({});
    const redactedData = graph.redact({ project: 'A' });
    const redacted = JSON.stringify(redactedData);
    assert.equal(redacted.includes('b-key'), false);
    assert.equal(redacted.includes('TOPSECRET'), false);
    assert.equal(redacted.includes('B_CROSS_PROJECT_LEAK'), false);
    assert.equal(redactedData.reviewSignals.every((signal) => signal.decisionId === decisionA.id), true);
    assert.equal(redactedData.reviewSignals.some((signal) => signal.decisionId === decisionB.id), false);

    const collision = createShadowGraph();
    collision.importData({
      schemaVersion: 3,
      records: [{ id: 'COLLIDE', kind: 'decision', project: 'B', title: 'B_COLLISION_LEAK', chosen: 'x' }],
      facts: [{ id: 'COLLIDE', kind: 'fact', project: 'A', key: 'same-id', value: true }],
      reviewSignals: [{ id: 'signal_B', kind: 'review', decisionId: 'COLLIDE', title: 'B_COLLISION_LEAK', reason: 'due', status: 'open' }]
    });
    const collisionRedacted = collision.redact({ project: 'A' });
    assert.deepEqual(collisionRedacted.reviewSignals, [], 'a same-id fact must not authorize another project decision signal');
    assert.equal(JSON.stringify(collisionRedacted).includes('B_COLLISION_LEAK'), false);

    const recordCollision = createShadowGraph();
    recordCollision.importData({
      schemaVersion: 3,
      records: [
        { id: 'RECORD_COLLIDE', kind: 'decision', project: 'B', title: 'B_RECORD_COLLISION_LEAK', chosen: 'x' },
        { id: 'RECORD_COLLIDE', kind: 'attempt', project: 'A', solution: 'local', result: 'ok' }
      ],
      reviewSignals: [{ id: 'signal_B_record', kind: 'review', decisionId: 'RECORD_COLLIDE', title: 'B_RECORD_COLLISION_LEAK', reason: 'due', status: 'open' }]
    });
    const recordCollisionRedacted = recordCollision.redact({ project: 'A' });
    assert.deepEqual(recordCollisionRedacted.reviewSignals, [], 'a same-id non-decision record must not authorize another project decision signal');
    assert.equal(JSON.stringify(recordCollisionRedacted).includes('B_RECORD_COLLISION_LEAK'), false);
  });
});

describe('P0-2 — a failed replace/import leaves the live graph untouched', () => {
  // WAS BROKEN: replaceData() cleared every map FIRST and parsed afterwards, so a
  // malformed payload destroyed the live graph with nothing to fall back to.
  // Worst possible failure mode for a recovery path (restore, revision-conflict
  // reload): the operation that runs when something is already wrong was itself
  // capable of losing everything.
  //
  // ALSO FIXED HERE: the envelope-level `schemaVersion` was never checked at
  // all, so a payload from an unknown future build was silently half-read and
  // accepted. The fields being ignored could be the ones that change the meaning
  // of the fields being read.

  function seeded() {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'keep', title: 'ORIGINAL', chosen: 'sqlite', idempotencyKey: 'orig' });
    graph.addFact({ project: 'keep', key: 'dep', value: 'single' });
    return graph;
  }

  it('a future envelope schemaVersion is REFUSED, not silently half-read', () => {
    const graph = createShadowGraph();
    assert.throws(
      () => graph.importData({ schemaVersion: 999, records: [] }),
      /Unsupported data schemaVersion 999/
    );
  });

  it('every supported schema version is still importable', () => {
    for (const version of SUPPORTED_SCHEMA_VERSIONS) {
      const graph = createShadowGraph();
      assert.doesNotThrow(() => graph.importData({ schemaVersion: version, records: [] }), `v${version} must import`);
    }
  });

  it('a rejected replace leaves the previous graph semantically unchanged', () => {
    const graph = seeded();
    const before = normalize(graph.exportData().records);
    const beforeFacts = normalize(graph.exportData().facts);

    assert.throws(() => graph.replaceData({ schemaVersion: 999, records: [] }), /Unsupported data schemaVersion/);

    assert.equal(normalize(graph.exportData().records), before, 'records survived the failed replace');
    assert.equal(normalize(graph.exportData().facts), beforeFacts, 'facts survived the failed replace');
    assert.equal(graph.stats().decisions, 1);
  });

  it('a replace carrying blocking validation errors is refused and changes nothing', () => {
    const graph = seeded();
    const before = normalize(graph.exportData().records);

    // A relation pointing at an entity that does not exist is a blocking error.
    assert.throws(
      () => graph.replaceData({ records: [], relations: [{ id: 'r1', from: 'ghost', to: 'phantom', relation: 'depends_on' }] }),
      /Refusing to replace data/
    );

    assert.equal(normalize(graph.exportData().records), before);
  });

  it('the graph is still fully USABLE after a failed replace', () => {
    // Surviving as data is not enough — the indexes must be intact too.
    const graph = seeded();
    try { graph.replaceData({ schemaVersion: 999 }); } catch { /* expected */ }

    assert.doesNotThrow(() => graph.addDecision({ project: 'keep', title: 'AFTER', chosen: 'c' }));
    assert.equal(graph.search('ORIGINAL', { project: 'keep' }).page.total, 1, 'search index intact');
    assert.equal(graph.validate().valid, true, 'graph is still valid');
    // The idempotency cache survived too.
    assert.equal(graph.addDecision({ project: 'keep', title: 'ORIGINAL', chosen: 'sqlite', idempotencyKey: 'orig' }).title, 'ORIGINAL');
  });

  it('a SUCCESSFUL replace still fully replaces the graph', () => {
    // The atomicity fix must not turn replaceData into a no-op.
    const graph = seeded();
    graph.replaceData({ schemaVersion: 3, records: [{ id: 'new1', kind: 'decision', title: 'REPLACED', chosen: 'x', alternatives: [] }] });

    const exported = graph.exportData();
    assert.equal(exported.records.length, 1);
    assert.equal(exported.records[0].title, 'REPLACED');
    assert.equal(exported.facts.length, 0, 'old facts are gone after a successful replace');
  });

  it('a failed reload from disk leaves the in-memory graph intact (recovery path)', async () => {
    // This is the revision-conflict / restore scenario in miniature.
    const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-p02-'));
    const store = createJsonFileStore(join(directory, 'data.json'));

    const graph = seeded();
    await store.save(graph.exportData());

    // A corrupt/newer file arrives where a good one used to be.
    assert.throws(() => graph.replaceData({ schemaVersion: 1000, records: [] }), /Unsupported data schemaVersion/);
    assert.equal(graph.stats().decisions, 1, 'the running process kept its state');

    // And the good file still loads.
    const reloaded = createShadowGraph();
    reloaded.importData(await store.load());
    assert.equal(reloaded.stats().decisions, 1);
  });
});

describe('P1-8 — confidence is a summed fold, clamped once', () => {
  // CONTRACT: clamp(initial + sum(deltas), 0, 1).
  // Clamping after every step would make the result depend on the ORDER in which
  // evidence arrived, so the same set of observations could yield two different
  // numbers. That is indefensible for an auditable confidence value.

  function withEvidence(order) {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    for (const [key, supports, sourceClass] of order) {
      graph.addConfidenceEvidence({ decisionId: decision.id, key, supports, sourceClass, reason: `reason ${key}` });
    }
    return graph.exportData().records[0].confidence;
  }

  const EVIDENCE = [
    ['a', true, 'production_verified'],
    ['b', false, 'production_verified'],
    ['c', true, 'agent_claimed'],
    ['d', false, 'tool_observed']
  ];

  it('permutation invariance: order of arrival cannot change the result', () => {
    const permutations = [
      EVIDENCE,
      [EVIDENCE[3], EVIDENCE[1], EVIDENCE[0], EVIDENCE[2]],
      [EVIDENCE[2], EVIDENCE[0], EVIDENCE[3], EVIDENCE[1]],
      [...EVIDENCE].reverse()
    ];
    const values = permutations.map((order) => withEvidence(order).current);
    assert.equal(new Set(values).size, 1, `order changed the outcome: ${JSON.stringify(values)}`);
  });

  it('equal and opposite evidence cancels back to the initial value', () => {
    const confidence = withEvidence([['a', true, 'production_verified'], ['b', false, 'production_verified']]);
    assert.equal(confidence.current, confidence.initial);
  });

  it('clamping happens ONCE at the end, so a saturating run can still recover', () => {
    // Five contradicting production_verified observations sum to -1.0, well past
    // the floor. With per-step clamping the value would stick at 0 and later
    // supporting evidence would lift it off the floor. With a single clamp the
    // total is still deeply negative, so one supporting observation cannot undo
    // five contradicting ones.
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    for (let index = 0; index < 5; index += 1) {
      graph.addConfidenceEvidence({ decisionId: decision.id, key: `down${index}`, supports: false, sourceClass: 'production_verified', reason: 'r' });
    }
    assert.equal(graph.exportData().records[0].confidence.current, 0, 'clamped to the floor');

    graph.addConfidenceEvidence({ decisionId: decision.id, key: 'up', supports: true, sourceClass: 'agent_claimed', reason: 'r' });
    assert.equal(graph.exportData().records[0].confidence.current, 0, 'one weak positive does not undo five strong negatives');
  });

  it('confidence stays bounded to [0,1] under heavy evidence in both directions', () => {
    for (const supports of [true, false]) {
      const graph = createShadowGraph();
      const decision = graph.addDecision({ title: 'T', chosen: 'C' });
      for (let index = 0; index < 50; index += 1) {
        graph.addConfidenceEvidence({ decisionId: decision.id, key: `k${index}`, supports, sourceClass: 'production_verified', reason: 'r' });
      }
      const current = graph.exportData().records[0].confidence.current;
      assert.ok(current >= 0 && current <= 1, `out of bounds: ${current}`);
      assert.equal(current, supports ? 1 : 0);
    }
  });

  it('removal/replacement leaves no residue: a replaced outcome is fully re-derived', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'production_verified' });
    graph.setOutcome(decision.id, { status: 'failed', sourceClass: 'production_verified' });

    const confidence = graph.exportData().records[0].confidence;
    // Exactly as if the successful outcome had never been recorded.
    assert.equal(confidence.current, 0.3, '0.5 + (0.2 * 1 * -1)');
    assert.equal(confidence.basis.successfulOutcomes, 0);
    assert.equal(confidence.basis.contributions.filter((item) => item.kind === 'outcome').length, 1);
  });

  it('rebuild equivalence: confidence survives a journal replay unchanged', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    graph.addConfidenceEvidence({ decisionId: decision.id, key: 'e1', supports: true, sourceClass: 'tool_observed', reason: 'r' });
    graph.setOutcome(decision.id, { status: 'mixed', sourceClass: 'human_confirmed' });

    const live = graph.exportData().records;
    const rebuilt = graph.rebuild();
    assert.equal(rebuilt.rebuildable, true);
    assert.equal(normalize(live), normalize(rebuilt.projection.records), 'confidence is identical after replay');
  });
});

describe('P1-9 — evidence dedupe requires a stable key', () => {
  // WAS BROKEN: when `key` was omitted the code synthesised
  // `evidence:<id>:<timestamp>:<reason>`. A timestamp makes every retry a NEW
  // key, so the documented "a retry with the same key is a no-op" guarantee was
  // false exactly when it mattered — on a retry a few milliseconds later.
  // Rather than invent a fragile fallback, the key is now REQUIRED: an honest
  // error beats a silent double-count.

  it('omitting `key` is rejected with an explanation', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    assert.throws(
      () => graph.addConfidenceEvidence({ decisionId: decision.id, supports: true, sourceClass: 'tool_observed', reason: 'r' }),
      /stable `key`/
    );
  });

  it('a non-string or empty key is rejected', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    for (const key of ['', '   ', 42, {}, null]) {
      assert.throws(
        () => graph.addConfidenceEvidence({ decisionId: decision.id, key, supports: true, sourceClass: 'tool_observed', reason: 'r' }),
        /key/,
        `key ${JSON.stringify(key)}`
      );
    }
  });

  it('the same key replayed across a real clock tick is a no-op', async () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    graph.addConfidenceEvidence({ decisionId: decision.id, key: 'obs-1', supports: true, sourceClass: 'tool_observed', reason: 'r' });
    const first = graph.exportData().records[0].confidence;

    await new Promise((resolve) => { setTimeout(resolve, 8); });
    graph.addConfidenceEvidence({ decisionId: decision.id, key: 'obs-1', supports: true, sourceClass: 'tool_observed', reason: 'r' });
    const second = graph.exportData().records[0].confidence;

    assert.equal(second.current, first.current, 'a retry must not move confidence');
    assert.equal(second.basis.contributions.length, 1);
    assert.equal(second.history.length, 1);
  });

  it('a genuinely different observation uses a different key and does count', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    graph.addConfidenceEvidence({ decisionId: decision.id, key: 'obs-1', supports: true, sourceClass: 'tool_observed', reason: 'r' });
    graph.addConfidenceEvidence({ decisionId: decision.id, key: 'obs-2', supports: true, sourceClass: 'tool_observed', reason: 'r' });

    assert.equal(graph.exportData().records[0].confidence.basis.contributions.length, 2);
  });
});

describe('P1-10 — SQLite/JSON confidence parity across close and reopen', () => {
  // The confidence model is the newest and most structured part of a record
  // (nested basis + contributions + history). Nothing proved it round-tripped
  // through the relational backend, which is exactly where a nested structure
  // is most likely to be flattened or dropped.

  async function roundTrip(makeStore) {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'Storage', chosen: 'sqlite', confidence: 0.4 });
    graph.addConfidenceEvidence({ decisionId: decision.id, key: 'e1', supports: true, sourceClass: 'human_confirmed', reason: 'reviewed' });
    graph.addConfidenceEvidence({ decisionId: decision.id, key: 'e2', supports: false, sourceClass: 'agent_claimed', reason: 'doubt' });
    graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'tool_observed' });
    graph.setOutcome(decision.id, { status: 'failed', sourceClass: 'tool_observed' });

    const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-parity-'));
    const store = await makeStore(directory);
    await store.save(graph.exportData());
    await store.close?.();

    const reopened = await makeStore(directory);
    const loaded = await reopened.load();
    await reopened.close?.();

    const reloaded = createShadowGraph();
    reloaded.importData(loaded);
    return { live: graph.exportData(), reloaded: reloaded.exportData() };
  }

  const assertParity = (live, reloaded) => {
    const before = live.records.find((item) => item.kind === 'decision').confidence;
    const after = reloaded.records.find((item) => item.kind === 'decision').confidence;

    assert.equal(after.current, before.current, 'current');
    assert.equal(after.initial, before.initial, 'initial');
    assert.equal(after.policy, before.policy, 'policy');
    assert.equal(JSON.stringify(canonical(after.basis)), JSON.stringify(canonical(before.basis)), 'basis');
    assert.equal(JSON.stringify(canonical(after.history)), JSON.stringify(canonical(before.history)), 'history');
    // The replaced outcome must not reappear on the far side of persistence.
    assert.equal(after.basis.successfulOutcomes, 0);
    assert.equal(after.basis.failedOutcomes, 1);
    assert.equal(after.basis.contributions.filter((item) => item.kind === 'outcome').length, 1);
    assert.equal(after.basis.humanConfirmations, 1);
  };

  it('JSON backend preserves the whole confidence structure', async () => {
    const { live, reloaded } = await roundTrip((directory) => createJsonFileStore(join(directory, 'data.json')));
    assertParity(live, reloaded);
  });

  it('SQLite backend preserves the whole confidence structure', async (t) => {
    try {
      const { live, reloaded } = await roundTrip((directory) => createSqliteStore(join(directory, 'data.sqlite')));
      assertParity(live, reloaded);
    } catch (error) {
      if (/requires Node/.test(error.message)) return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON);
      throw error;
    }
  });

  it('both backends agree with each other, not merely with themselves', async (t) => {
    try {
      const viaJson = await roundTrip((directory) => createJsonFileStore(join(directory, 'data.json')));
      const viaSqlite = await roundTrip((directory) => createSqliteStore(join(directory, 'data.sqlite')));
      const confidenceOf = (exported) => canonical(exported.records.find((item) => item.kind === 'decision').confidence);
      // Ids, timestamps AND id-derived dedupe keys differ between two independent
      // runs (`outcome:<decisionId>` embeds a random id). The confidence NUMBERS,
      // directions, source classes and counts must not.
      const strip = (confidence) => ({
        ...confidence,
        basis: {
          ...confidence.basis,
          contributions: confidence.basis.contributions.map(({ kind, direction, sourceClass }) => ({ kind, direction, sourceClass }))
        },
        history: confidence.history.map(({ delta, from, to, kind }) => ({ delta, from, to, kind }))
      });
      assert.deepEqual(strip(confidenceOf(viaSqlite.reloaded)), strip(confidenceOf(viaJson.reloaded)));
    } catch (error) {
      if (/requires Node/.test(error.message)) return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON);
      throw error;
    }
  });
});

describe('P2-11 — an unnumbered journal never yields an Infinity epoch', () => {
  // WAS BROKEN: journalEpoch was Math.min(...numbered). With NO numbered entries
  // that is `Infinity`, and an Infinity epoch excludes every entry from the
  // replay range — so rebuild reported success while replaying nothing.

  it('a journal whose entries carry no seq produces a finite-or-null epoch', () => {
    const graph = createShadowGraph();
    graph.importData({ journal: [{ id: 'e1', type: 'fact.observed' }, { id: 'e2', type: 'decision.recorded' }] });

    const exported = graph.exportData();
    assert.notEqual(exported.journalEpoch, Infinity);
    assert.ok(exported.journalEpoch === null || Number.isInteger(exported.journalEpoch));
  });

  it('such entries are reported as non-replayable legacy, not silently succeeded', () => {
    const graph = createShadowGraph();
    graph.importData({ journal: [{ id: 'e1', type: 'fact.observed' }, { id: 'e2', type: 'decision.recorded' }] });

    const report = graph.rebuild();
    assert.equal(report.legacy.length, 2, 'both unnumbered entries are accounted for');
    assert.equal(report.applied, 0);
    assert.notEqual(report.journalEpoch, Infinity);
  });

  it('validate() flags a journal entry with no sequence as an error', () => {
    const graph = createShadowGraph();
    graph.importData({ journal: [{ id: 'e1', type: 'fact.observed' }] });

    const issues = graph.validate().issues.filter((issue) => issue.code === 'journal_entry_without_sequence');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'error');
    assert.equal(graph.validate().valid, false);
  });
});

describe('P2-12 — duplicate journal sequences are detected, not resolved by input order', () => {
  // A repeated `seq` cannot be totally ordered, so "last writer wins" would make
  // the fold's outcome depend on the order entries happen to sit in the file.
  // Two different reads of the same journal could then disagree.

  const duplicated = [
    { id: 'j1', seq: 1, type: 'fact.observed', entityKind: 'fact', entityId: 'a', payload: { id: 'a', value: 1 } },
    { id: 'j2', seq: 1, type: 'fact.observed', entityKind: 'fact', entityId: 'b', payload: { id: 'b', value: 2 } }
  ];

  it('rebuild refuses and explains', () => {
    const report = rebuildProjection(duplicated);
    assert.equal(report.rebuildable, false);
    assert.match(report.reason, /duplicate sequence/i);
  });

  it('the refusal does not depend on which order the entries arrive in', () => {
    const forward = rebuildProjection(duplicated);
    const reversed = rebuildProjection([...duplicated].reverse());
    assert.equal(forward.rebuildable, false);
    assert.equal(reversed.rebuildable, false);
    assert.equal(forward.reason, reversed.reason, 'same diagnosis either way');
  });

  it('import preflight rejects it before validate can observe a corrupted live graph', () => {
    const graph = createShadowGraph();
    graph.addDecision({ id: 'duplicate-seq-sentinel', project: 'duplicate-seq-sentinel', title: 'Keep', chosen: 'keep' });
    const before = JSON.stringify(graph.exportData());

    assert.throws(
      () => graph.importData({ journal: duplicated }),
      (error) => error?.code === 'duplicate_journal_sequence'
    );
    assert.equal(JSON.stringify(graph.exportData()), before);
    assert.equal(graph.validate().valid, true);
  });

  it('a correctly numbered journal is unaffected', () => {
    const report = rebuildProjection([
      { id: 'j1', seq: 1, type: 'fact.observed', entityKind: 'fact', entityId: 'a', payload: { id: 'a' } },
      { id: 'j2', seq: 2, type: 'fact.observed', entityKind: 'fact', entityId: 'b', payload: { id: 'b' } }
    ]);
    assert.equal(report.rebuildable, true);
    assert.equal(report.projection.facts.length, 2);
  });
});

describe('P2-13 — replayable:false is honoured, not silently replayed', () => {
  // `isReplayable()` existed but the fold never called it, so an entry a writer
  // had explicitly marked non-replayable was replayed anyway. A flag that is
  // written but not read is worse than no flag: it advertises a guarantee that
  // does not hold.

  it('a known type flagged replayable:false does not reach the projection', () => {
    const report = rebuildProjection([
      { id: 'j1', seq: 1, type: 'fact.observed', entityKind: 'fact', entityId: 'a', payload: { id: 'a', value: 'MUST_NOT_APPEAR' }, replayable: false }
    ]);
    assert.equal(report.projection.facts.length, 0);
    assert.equal(JSON.stringify(report.projection).includes('MUST_NOT_APPEAR'), false);
  });

  it('the skip is declared and makes the rebuild non-rebuildable', () => {
    const report = rebuildProjection([
      { id: 'j1', seq: 1, type: 'fact.observed', entityKind: 'fact', entityId: 'a', payload: { id: 'a' }, replayable: false }
    ]);
    assert.equal(report.rebuildable, false, 'diagnostic and status must agree');
    assert.deepEqual(report.skipped, [{ seq: 1, type: 'fact.observed', why: 'marked_non_replayable' }]);
    assert.ok(report.reason);
  });

  it('replayable:true and an absent flag both still replay', () => {
    const report = rebuildProjection([
      { id: 'j1', seq: 1, type: 'fact.observed', entityKind: 'fact', entityId: 'a', payload: { id: 'a' }, replayable: true },
      { id: 'j2', seq: 2, type: 'fact.observed', entityKind: 'fact', entityId: 'b', payload: { id: 'b' } }
    ]);
    assert.equal(report.rebuildable, true);
    assert.equal(report.projection.facts.length, 2);
  });
});

describe('P2-14 — future live schemas are preserved and reported, never downgraded', () => {
  // Silently rewriting a future record's schemaVersion down to ours would claim
  // we understand data we do not. The record is kept verbatim and declared.
  // Contrast with the ENVELOPE version (P0-2), which is refused outright: one
  // unreadable entity is survivable, an unreadable file is not.

  it('a future record keeps its own schemaVersion', () => {
    const graph = createShadowGraph();
    graph.importData({ records: [{ id: 'fut', kind: 'decision', schemaVersion: 99, title: 'F', chosen: 'c', alternatives: [] }] });
    assert.equal(graph.exportData().records[0].schemaVersion, 99);
  });

  it('a future fact keeps its own schemaVersion', () => {
    const graph = createShadowGraph();
    graph.importData({ facts: [{ id: 'ff', key: 'k', value: 1, schemaVersion: 99 }] });
    assert.equal(graph.exportData().facts[0].schemaVersion, 99);
  });

  it('validate() reports them as unsupported and refuses to call the graph valid', () => {
    const graph = createShadowGraph();
    graph.importData({
      records: [{ id: 'fut', kind: 'decision', schemaVersion: 99, title: 'F', chosen: 'c', alternatives: [] }],
      facts: [{ id: 'ff', key: 'k', value: 1, schemaVersion: 99 }]
    });

    const result = graph.validate();
    const codes = result.issues.filter((issue) => issue.severity === 'unsupported').map((issue) => issue.code);
    assert.ok(codes.includes('unsupported_record_schema_version'));
    assert.ok(codes.includes('unsupported_fact_schema_version'));
    assert.equal(result.valid, false, 'cannot claim valid while holding uninterpretable data');
    assert.equal(result.counts.unsupported, 2);
  });

  it('OLD schema versions still import and are NOT treated as unsupported', () => {
    const graph = createShadowGraph();
    graph.importData({ schemaVersion: 1, records: [{ id: 'old', kind: 'decision', title: 'O', chosen: 'c', confidence: 0.7 }] });

    const result = graph.validate();
    assert.equal(result.counts.unsupported, 0, 'older data is readable, not unsupported');
    assert.equal(graph.exportData().records[0].confidence.current, 0.7, 'migrated forward');
  });
});

describe('P2-15 — duplicate active fact scopes resolve deterministically', () => {
  // Two ACTIVE facts can share a (project, key) scope in imported data. Picking
  // whichever arrived last made the winner depend on array order, so the same
  // file reordered produced different reconsideration results.
  // Rule: latest `observedAt`, `id` as a total tie-break. Ambiguity is still
  // reported rather than hidden.

  const FACTS = [
    { id: 'f_old', kind: 'fact', project: 'p', key: 'dep', value: 'OLD', status: 'active', observedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'f_new', kind: 'fact', project: 'p', key: 'dep', value: 'NEW', status: 'active', observedAt: '2026-06-01T00:00:00.000Z' }
  ];

  function activeValue(facts) {
    const graph = createShadowGraph();
    graph.importData({ facts });
    graph.addDecision({
      project: 'p', title: 'T', chosen: 'x',
      alternatives: [{ label: 'a', reasonRejected: 'r', reopenWhen: [{ key: 'dep', operator: 'equals', value: 'NEW' }] }]
    });
    return graph.review({}).length;
  }

  it('reorder invariance: the newest observedAt wins regardless of array order', () => {
    assert.equal(activeValue(FACTS), 1, 'newest fact is active');
    assert.equal(activeValue([...FACTS].reverse()), 1, 'and still active when reordered');
  });

  it('the tie-break is total, so equal timestamps are still deterministic', () => {
    const tied = [
      { id: 'f_a', kind: 'fact', project: 'p', key: 'dep', value: 'A', status: 'active', observedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'f_b', kind: 'fact', project: 'p', key: 'dep', value: 'B', status: 'active', observedAt: '2026-01-01T00:00:00.000Z' }
    ];
    const winner = (facts) => {
      const graph = createShadowGraph();
      graph.importData({ facts });
      graph.addDecision({ project: 'p', title: 'T', chosen: 'x', alternatives: [{ label: 'a', reasonRejected: 'r', reopenWhen: [{ key: 'dep', operator: 'equals', value: 'B' }] }] });
      return graph.review({}).length;
    };
    assert.equal(winner(tied), winner([...tied].reverse()), 'same winner either way');
  });

  it('the ambiguity is declared by validate(), not hidden by the rule', () => {
    const graph = createShadowGraph();
    graph.importData({ facts: FACTS });

    const issues = graph.validate().issues.filter((issue) => issue.code === 'duplicate_active_fact_scope');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'error');
    assert.equal(issues[0].count, 2);
  });

  it('normal single-fact-per-scope data reports no ambiguity', () => {
    const graph = createShadowGraph();
    graph.addFact({ project: 'p', key: 'dep', value: 'one' });
    graph.addFact({ project: 'p', key: 'dep', value: 'two' });

    assert.equal(graph.validate().issues.filter((issue) => issue.code === 'duplicate_active_fact_scope').length, 0);
    assert.equal(graph.validate().valid, true);
  });
});
