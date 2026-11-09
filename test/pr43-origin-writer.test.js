// Origin writes follow the independently verified standalone reader floor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedRebuild, privilegedRecordCapture, privilegedRecordSelfEvent } from '../src/internal/snapshot.js';
import { DELETION_INTENT } from '../src/internal/deletion-knowledge.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { hardPurgeGapLedgerReport } from '../src/journal.js';
import { SELF_SIGNALS } from '../src/internal/capture-source.js';
const NOW = '2026-10-04T00:00:00.000Z';
const now = () => NOW;
const admission = { limits: { maxStoreBytes: 2 ** 30, maxQueueDepth: 100, maxItemBytes: 65536, maxItemsPerSession: 10 }, storeBytes: 0 };
const sort = values => [...values].sort((a, b) => String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)));
function parity(graph) {
  const snapshot = privilegedSnapshot(graph), report = privilegedRebuild(graph);
  assert.deepEqual(report.skipped, []);
  assert.equal(hardPurgeGapLedgerReport(snapshot.journal, { journalEpoch: snapshot.journalEpoch }).valid, true);
  for (const key of ['records', 'facts', 'relations', 'idempotency']) assert.deepEqual(sort(report.projection[key]), sort(snapshot[key]), key);
  validateRestorePayload(snapshot, { now });
  return snapshot;
}
function fixture() {
  const graph = createShadowGraph({ now });
  for (const owner of [{ originId: 'origin-a' }, { originId: 'origin-b' }, { project: 'p', originId: 'origin-a' }]) {
    const a = graph.addDecision({ ...owner, title: 'Synthetic title', chosen: 'Synthetic choice', idempotencyKey: 'retry' });
    const b = graph.addAttempt({ ...owner, solution: 'Synthetic solution', result: 'failed' });
    graph.addFact({ ...owner, key: 'synthetic-fact', value: 8 });
    graph.remember({ ...owner, memoryType: 'note', key: 'synthetic-memory', text: 'Synthetic memory' });
    graph.link({ ...owner, from: a.id, to: b.id, relation: 'depends_on' });
    const sessionId = owner.project ?? owner.originId;
    privilegedRecordCapture(graph, { ...owner, text: 'Synthetic raw', admission, source: { event: 'UserPromptSubmit', sessionId, role: 'user' } });
  }
  return graph;
}
for (const mode of ['logical', 'hard']) test(`${mode} origin purge removes only its explicitly unattributed material through the shared intent`, () => {
  const graph = fixture(), before = parity(graph);
  const removed = before.records.concat(before.facts).filter(x => x.attribution === 'unattributed' && x.originId === 'origin-a');
  const ids = new Set(removed.map(x => x.id));
  const expectedRecords = before.records.filter(x => !ids.has(x.id));
  const preview = graph.originSummary('origin-a');
  assert.equal(preview.originId, 'origin-a');
  assert.equal(preview.captures, 1);
  const result = graph.purgeOrigin('origin-a', { mode });
  assert.equal(result.removed, ids.size);
  assert.equal(result.backups, 'Earlier backups still contain the purged material.');
  const after = parity(graph);
  assert.deepEqual(after.records, expectedRecords);
  assert.deepEqual(after.facts, before.facts.filter(x => !ids.has(x.id)));
  assert.deepEqual(after.relations, before.relations.filter(x => !ids.has(x.from) && !ids.has(x.to)));
  assert.deepEqual(after.captureSessions.map(x => x.sessionId).sort(), ['origin-b', 'p']);
  assert.equal(after.captureContent.length, 2);
  const intent = after[DELETION_INTENT].at(-1);
  assert.equal(intent.tombstone.kind, 'origin');
  assert.equal(intent.tombstone.purgedOrigin, 'origin-a');
  assert.equal(Object.hasOwn(intent.tombstone, 'purgedProject'), false);
  assert.deepEqual(intent.tombstone.tokens.sort(), removed.map(x => x.erasureToken).sort());
  const marker = after.journal.at(-1);
  assert.equal(marker.type, 'origin.purged');
  assert.equal(marker.project, null);
  assert.deepEqual(Object.keys(marker.payload).sort(), ['mode', 'originId', 'removed', 'removedJournalSequences']);
  for (const id of ids) assert.equal(JSON.stringify(after).includes(id), false);
  const firstSequences = [...marker.payload.removedJournalSequences];
  graph.purgeOrigin('origin-a', { mode: 'hard' });
  const twice = parity(graph);
  assert.ok(firstSequences.every(seq => twice.journal.at(-1).payload.removedJournalSequences.includes(seq)));
  assert.deepEqual(twice.records, expectedRecords);
});

test('invalid origin selections and modes refuse atomically', () => {
  const graph = fixture(), before = privilegedSnapshot(graph);
  assert.equal(typeof graph.purgeOrigin, 'function');
  for (const origin of [null, undefined, '', ' ', 1, {}]) {
    assert.throws(() => graph.purgeOrigin(origin));
    assert.deepEqual(privilegedSnapshot(graph), before);
  }
  assert.throws(() => graph.purgeOrigin('origin-a', { mode: 'invalid' }));
  assert.deepEqual(privilegedSnapshot(graph), before);
});

test('origin purge reaches self-only sessions but preserves same-origin project sessions and access audit', () => {
  const graph = createShadowGraph({ now });
  for (const owner of [{ originId: 'origin-a' }, { originId: 'origin-b' }, { originId: 'origin-a', project: 'p' }]) {
    privilegedRecordSelfEvent(graph, { ...owner, signal: SELF_SIGNALS[0], source: { event: 'UserPromptSubmit', sessionId: owner.project ?? owner.originId } });
  }
  const snapshot = privilegedSnapshot(graph);
  snapshot.events = [
    { id: 'synthetic-owned', type: 'synthetic', attribution: 'unattributed', originId: 'origin-a', project: null, at: NOW },
    { id: 'synthetic-access', type: 'access.synthetic', attribution: 'unattributed', originId: 'origin-a', project: null, at: NOW },
    { id: 'synthetic-legacy', type: 'synthetic', project: null, at: NOW }
  ];
  graph.replaceData(snapshot);
  assert.equal(graph.originSummary('origin-a').captureSessions, 1);
  graph.purgeOrigin('origin-a');
  const after = privilegedSnapshot(graph);
  assert.deepEqual(after.captureSessions.map(x => x.sessionId).sort(), ['origin-b', 'p']);
  assert.deepEqual(after.events.map(x => x.id), ['synthetic-access', 'synthetic-legacy']);
});
