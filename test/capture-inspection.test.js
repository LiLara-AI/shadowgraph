// M-5/M-6/M-7: scoped metadata only; correction is derived, never enqueued.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { DELETION_INTENT, attachLedgerView } from '../src/internal/deletion-knowledge.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import * as kernel from '../src/internal/snapshot.js';

const START = '2026-10-01T00:00:00.000Z';
const ADMISSION = { limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 1000, maxItemBytes: 2 ** 20, maxItemsPerSession: 1000 }, storeBytes: 0 };
const lease = { leaseId: 'synthetic-lease', ownerId: 'worker', ownerBootId: 'boot', leaseExpiresAt: '2026-10-02T00:00:00.000Z' };
function fixture() {
  let at = START;
  const graph = createShadowGraph({ now: () => at });
  const record = (project = 'p', originId = 'origin-inspection') => kernel.privilegedRecordCapture(graph, { project, originId, text: 'synthetic private raw', admission: ADMISSION, source: { event: 'UserPromptSubmit', sessionId: 'session-' + (project ?? originId) } });
  return { graph, record, clock: (instant) => { at = instant; }, inspect: (input) => kernel.privilegedInspectCapture(graph, input), snapshot: () => kernel.privilegedSnapshot(graph) };
}

test('capture inspection selects only its owner, hides quarantine, returns no raw/erasure material and never writes', () => {
  const f = fixture();
  const item = f.record(); f.record('q'); const unattributed = f.record(null, 'origin-unowned');
  const held = f.record('held');
  const payload = f.snapshot();
  f.graph.replaceData(attachLedgerView(payload, { quarantine: [{ token: payload.records.find((r) => r.id === held.id).erasureToken, at: START }] }));
  const before = f.snapshot();
  assert.deepEqual(f.inspect({}).items, []);
  assert.deepEqual(f.inspect({ project: 'p' }).items.map((r) => r.id), [item.id]);
  assert.deepEqual(f.inspect({ originId: 'origin-unowned' }).items.map((r) => r.id), [unattributed.id]);
  assert.deepEqual(f.inspect({ project: 'held' }).items, []);
  const result = f.inspect({ project: 'p', id: item.id });
  assert.equal(result.items[0].source.event, 'UserPromptSubmit');
  assert.equal(result.items[0].state, 'pending');
  for (const secret of ['synthetic private raw', 'contentRef', 'contentHash', 'erasureToken']) assert.equal(JSON.stringify(result).includes(secret), false);
  for (const id of [held.id, 'not-held']) assert.throws(() => f.inspect({ project: 'p', id }), { code: 'capture_item_not_found' });
  assert.deepEqual(f.snapshot(), before);
});

test('capture inspection derives correction invalidation and raw availability without enqueueing or persisting derived state', () => {
  const f = fixture(); const item = f.record();
  const { memory } = f.graph.remember({ project: 'p', memoryType: 'note', key: 'choice', text: 'before correction' });
  kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'processing', lease });
  kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'extracted', producedRecordIds: [memory.id] });
  assert.equal(f.inspect({ project: 'p' }).items[0].reprocessable, false);
  f.clock('2026-10-01T01:00:00.000Z');
  f.graph.remember({ project: 'p', memoryType: 'note', key: 'choice', text: 'after correction' });
  const before = f.snapshot();
  const corrected = f.inspect({ project: 'p' }).items[0];
  assert.equal(corrected.derivedInvalidated, true);
  assert.equal(corrected.reprocessable, true);
  assert.equal(corrected.state, 'extracted');
  assert.equal(corrected.producedRecords[0].status, 'superseded');
  assert.deepEqual(f.snapshot(), before);
  f.clock('2026-10-08T00:00:00.000Z');
  const expired = f.inspect({ project: 'p' }).items[0];
  assert.equal(expired.derivedInvalidated, true);
  assert.equal(expired.reprocessable, false);
  assert.equal(expired.reprocessingUnavailableReason, 'raw_expired');
  assert.equal(f.snapshot().records.find((r) => r.id === item.id).state, 'extracted');
});

test('capture inspection derives correction of a cited record named in a receipt, without exposing the receipt', () => {
  const f = fixture(); const item = f.record();
  const decision = f.graph.addDecision({ project: 'p', title: 'synthetic referenced choice', chosen: 'before' });
  kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'processing', lease });
  kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'extracted', producedRecordIds: [] });
  const payload = f.snapshot();
  const cite = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.kind === 'capture') value.receipts = [{ sourceRecordId: decision.id, privateDetail: 'receipt-private' }];
    for (const child of Object.values(value)) cite(child);
  };
  cite(payload); f.graph.replaceData(payload);
  assert.equal(f.inspect({ project: 'p' }).items[0].derivedInvalidated, false);
  f.clock('2026-10-01T01:00:00.000Z');
  const replacement = f.graph.addDecision({ project: 'p', title: 'synthetic replacement', chosen: 'after' });
  f.graph.supersedeDecision({ project: 'p', decisionId: decision.id, replacementId: replacement.id });
  const before = f.snapshot();
  const inspection = f.inspect({ project: 'p' });
  assert.equal(inspection.items[0].derivedInvalidated, true);
  assert.equal(inspection.items[0].reprocessable, true);
  assert.equal(JSON.stringify(inspection).includes('receipt-private'), false);
  assert.deepEqual(f.snapshot(), before);
});

for (const state of ['pending', 'failed', 'blocked']) test(`capture cancellation ${state}: journaled terminal blocking, no content read or lease claim, replay remains valid`, () => {
  const f = fixture(); const item = f.record();
  if (state !== 'pending') {
    kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'processing', lease });
    kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'failed', lastError: 'synthetic failure' });
    if (state === 'blocked') kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'blocked', blockedReason: 'synthetic blocked' });
  }
  const result = kernel.privilegedCancelCapture(f.graph, { project: 'p', id: item.id });
  assert.equal(result.changed, true);
  const after = f.snapshot();
  const cancelled = after.records.find((r) => r.id === item.id);
  assert.equal(cancelled.state, 'blocked');
  assert.equal(cancelled.blockedReason, 'capture_cancelled');
  assert.equal(cancelled.lease, null);
  assert.throws(() => kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'processing', lease }), /Illegal capture transition/u);
  assert.equal(kernel.privilegedCancelCapture(f.graph, { project: 'p', id: item.id }).changed, false);
  assert.deepEqual(f.snapshot(), after);
  assert.doesNotThrow(() => validateRestorePayload(after));
  assert.equal(kernel.privilegedRebuild(f.graph).rebuildable, true);
});

test('capture cancellation refuses other owners, quarantined, unknown and extracted items without change', () => {
  const f = fixture(); const other = f.record('q'); const inflight = f.record();
  kernel.privilegedTransitionCapture(f.graph, { id: inflight.id, to: 'processing', lease });
  for (const id of [other.id, 'missing']) {
    const before = f.snapshot();
    assert.throws(() => kernel.privilegedCancelCapture(f.graph, { project: 'p', id }));
    assert.deepEqual(f.snapshot(), before);
  }
  kernel.privilegedTransitionCapture(f.graph, { id: inflight.id, to: 'extracted', producedRecordIds: [] });
  const before = f.snapshot();
  assert.throws(() => kernel.privilegedCancelCapture(f.graph, { project: 'p', id: inflight.id }), { code: 'capture_cancel_state_refused' });
  assert.deepEqual(f.snapshot(), before);
  f.graph.replaceData(attachLedgerView(before, { quarantine: [{ token: before.records.find((r) => r.id === other.id).erasureToken, at: START }] }));
  const held = f.snapshot();
  assert.throws(() => kernel.privilegedCancelCapture(f.graph, { project: 'q', id: other.id }), { code: 'capture_item_not_found' });
  assert.deepEqual(f.snapshot(), held);
});

test('capture deletion removes every item/raw/retry copy, leaves anonymous skeletons, preserves ordinals and cannot recapture delayed transcript material', () => {
  const f = fixture(); const item = f.record(); const duplicate = f.record();
  const result = kernel.privilegedDeleteCapture(f.graph, { project: 'p', id: item.id });
  assert.equal(result.removed, 1);
  const after = f.snapshot();
  assert.equal(JSON.stringify(after).includes(item.id), false);
  assert.equal(after.records.find((r) => r.id === duplicate.id).possibleDuplicateOf, null);
  const intent = after[DELETION_INTENT][0];
  assert.equal(intent.tombstone.kind, 'item');
  assert.deepEqual(Object.keys(intent.tombstone).sort(), ['at', 'kind', 'mode', 'moveIn', 'seq', 'tokens']);
  assert.equal(intent.tombstone.tokens.length, 1);
  assert.equal(JSON.stringify(intent.tombstone).includes(item.id), false);
  assert.ok(after.journal.some((entry) => entry.redactedReason === 'capture_deleted' && entry.payload === null && entry.entityId === null));
  assert.doesNotThrow(() => validateRestorePayload(after));
  assert.equal(kernel.privilegedRebuild(f.graph).rebuildable, true);
  assert.equal(f.record().occurrenceSeq, 3);
  kernel.privilegedDeleteCapture(f.graph, { project: 'p', id: duplicate.id });
  const last = f.snapshot().records.find((r) => r.kind === 'capture');
  kernel.privilegedDeleteCapture(f.graph, { project: 'p', id: last.id });
  f.clock('2027-10-01T00:00:00.000Z');
  kernel.privilegedExpireCapture(f.graph);
  const sessions = f.snapshot().captureSessions;
  assert.equal(sessions[0].occurrenceSeqHighWater, 3);
  assert.equal(sessions[0].cursor.blocked.reason, 'capture_deleted');
  kernel.privilegedRecordTranscript(f.graph, { project: 'p', originId: 'origin-inspection', sessionId: 'session-p', activatedAt: START, trigger: 'PreCompact', admission: ADMISSION, transcript: { ref: 'synthetic-ref', size: () => { assert.fail('deleted session must refuse before any byte access'); }, read: () => { assert.fail('deleted session must refuse before any byte access'); } } });
  assert.equal(f.record().occurrenceSeq, 4);
});

test('capture deletion requires a visible supported pending item and never widens scope or deletes extracted work', () => {
  const f = fixture(); const other = f.record('q'); const item = f.record();
  kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'processing', lease });
  for (const id of [other.id, item.id, 'missing']) {
    const before = f.snapshot();
    assert.throws(() => kernel.privilegedDeleteCapture(f.graph, { project: 'p', id }));
    assert.deepEqual(f.snapshot(), before);
  }
  kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'extracted', producedRecordIds: [] });
  assert.throws(() => kernel.privilegedDeleteCapture(f.graph, { project: 'p', id: item.id }), { code: 'capture_delete_state_refused' });
});
