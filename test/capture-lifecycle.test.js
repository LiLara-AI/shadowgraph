// FINAL PR37 capture lifecycle: OD-2, including quarantined uncited raw.
// Synthetic fixtures only; no host activation or live data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { attachLedgerView } from '../src/internal/deletion-knowledge.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import * as kernel from '../src/internal/snapshot.js';

const START = '2026-10-01T00:00:00.000Z';
const END = '2026-10-08T00:00:00.000Z';
const ADMISSION = { limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 2 ** 30, maxItemBytes: 2 ** 40, maxItemsPerSession: 2 ** 30 }, storeBytes: 0 };
function fixture() {
  let instant = START;
  const graph = createShadowGraph({ now: () => instant });
  const snapshot = () => kernel.privilegedSnapshot(graph);
  const record = (event = 'UserPromptSubmit', fields = {}) => kernel.privilegedRecordCapture(graph, { project: 'p', originId: 'synthetic-origin', text: 'synthetic uncited raw', admission: ADMISSION, ...fields, source: { event, sessionId: 'synthetic-session', ...(fields.source ?? {}) } });
  return { graph, snapshot, record, clock: (value) => { instant = value; } };
}

test('capture lifecycle: stamp the configured deadline, expire at the boundary, scrub retry/history and preserve canonical experience', () => {
  const f = fixture();
  const first = f.record();
  const second = f.record();
  const canonical = f.graph.addDecision({ project: 'p', title: 'Synthetic experience', chosen: 'retain canonical experience' });
  assert.equal(first.expiresAt, END);
  assert.equal(second.possibleDuplicateOf, first.id);
  f.clock('2026-10-07T23:59:59.999Z');
  const before = f.snapshot();
  assert.equal(kernel.privilegedExpireCapture(f.graph).changed, false);
  assert.deepEqual(f.snapshot(), before);
  f.clock(END);
  const result = kernel.privilegedExpireCapture(f.graph);
  assert.equal(result.expired, 2);
  const after = f.snapshot();
  assert.equal(after.captureContent?.length ?? 0, 0);
  assert.equal(JSON.stringify(after).includes('synthetic uncited raw'), false);
  for (const item of after.records.filter((item) => item.kind === 'capture')) {
    assert.equal(item.state, 'blocked');
    assert.equal(item.blockedReason, 'raw_expired');
    assert.equal(item.contentRef, null);
    assert.equal(item.contentHash, null);
    assert.equal(item.possibleDuplicateOf, null);
  }
  assert.deepEqual(after.records.find((item) => item.id === canonical.id), before.records.find((item) => item.id === canonical.id));
  assert.equal(kernel.privilegedValidate(f.graph).valid, true);
  assert.equal(kernel.privilegedRebuild(f.graph).rebuildable, true);
  assert.doesNotThrow(() => validateRestorePayload(after));
  assert.equal(kernel.privilegedExpireCapture(f.graph).changed, false);
  assert.deepEqual(f.snapshot(), after, 'repeat sweep is a genuine no-op');
});

for (const withheld of [false, true]) test(`capture lifecycle: actual citation protects evidence while uncited raw expires (${withheld ? 'quarantined' : 'live'})`, () => {
  const f = fixture();
  const cited = f.record('Stop', { text: 'synthetic evidence required by canonical experience' });
  const uncited = f.record('Transcript', { source: { hostEventId: 'synthetic-uuid' } });
  const canonical = f.graph.addDecision({ project: 'p', title: 'Synthetic accepted experience', chosen: 'keep source context' });
  const payload = f.snapshot();
  // P7's typed citation, carried identically in projection and journal.
  const cite = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.id === canonical.id && value.kind === 'decision') value.captureRef = cited.id;
    for (const child of Object.values(value)) cite(child);
  };
  cite(payload);
  f.graph.replaceData(withheld ? attachLedgerView(payload, { quarantine: payload.records.filter((item) => [cited.id, uncited.id, canonical.id].includes(item.id)).map((item) => ({ token: item.erasureToken, at: START })) }) : payload);
  const before = f.snapshot();
  f.clock(END);
  const result = kernel.privilegedExpireCapture(f.graph);
  assert.equal(result.expired, 1);
  const after = f.snapshot();
  assert.deepEqual(after.captureContent, before.captureContent.filter((entry) => entry.contentRef === cited.contentRef));
  assert.deepEqual(after.records.filter((item) => item.kind !== 'capture'), before.records.filter((item) => item.kind !== 'capture'));
  assert.deepEqual(after.facts, before.facts);
  assert.deepEqual(after.relations, before.relations);
  if (withheld) assert.equal(f.graph.search('', { project: 'p' }).completeness.quarantined, 3, 'expiry never releases quarantine');
  assert.equal(kernel.privilegedValidate(f.graph).valid, true);
});

test('capture lifecycle: shorter policy applies to held raw; longer policy cannot revive a stamped deadline', () => {
  const f = fixture();
  f.graph.importData(attachLedgerView(f.snapshot(), { retentionOverrides: [{ project: 'p', days: 2 }] }));
  const item = f.record();
  assert.equal(item.expiresAt, '2026-10-03T00:00:00.000Z');
  f.graph.replaceData(attachLedgerView(f.snapshot(), { retentionOverrides: [{ project: 'p', days: 30 }] }));
  f.clock('2026-10-03T00:00:00.000Z');
  assert.equal(kernel.privilegedExpireCapture(f.graph).expired, 1);
});

test('capture lifecycle: bounded expiry and a stopped deadline leave unselected raw available for the next sweep', () => {
  const f = fixture();
  for (let i = 0; i < 3; i += 1) f.record();
  f.clock(END);
  const before = f.snapshot();
  assert.equal(kernel.privilegedExpireCapture(f.graph, { mayContinue: () => false }).changed, false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(kernel.privilegedExpireCapture(f.graph, { maxItems: 1 }).expired, 1);
  assert.equal(f.snapshot().captureContent.length, 2);
  assert.equal(kernel.privilegedExpireCapture(f.graph).expired, 2);
});

for (const state of ['pending', 'processing', 'failed', 'extracted', 'blocked']) test(`capture lifecycle: expiry keeps canonical replay valid for ${state} work`, () => {
  const f = fixture();
  const item = f.record();
  const canonical = f.graph.addDecision({ project: 'p', title: 'Synthetic output', chosen: 'retain output' });
  if (state !== 'pending') kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'processing', lease: { leaseId: 'l', ownerId: 'w', ownerBootId: 'b', leaseExpiresAt: '2026-10-20T00:00:00.000Z' } });
  if (['failed', 'blocked'].includes(state)) kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'failed', lastError: 'synthetic failure' });
  if (state === 'blocked') kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'blocked', blockedReason: 'synthetic_block' });
  if (state === 'extracted') kernel.privilegedTransitionCapture(f.graph, { id: item.id, to: 'extracted', producedRecordIds: [canonical.id] });
  const before = f.snapshot();
  f.clock(END);
  assert.equal(kernel.privilegedExpireCapture(f.graph).expired, 1);
  const after = f.snapshot();
  const current = after.records.find((entry) => entry.id === item.id);
  assert.equal(current.state, ['pending', 'failed'].includes(state) ? 'blocked' : state);
  assert.deepEqual(after.records.filter((entry) => entry.kind !== 'capture'), before.records.filter((entry) => entry.kind !== 'capture'));
  assert.equal(JSON.stringify(after).includes('synthetic uncited raw'), false);
  assert.doesNotThrow(() => validateRestorePayload(after));
});

for (const limit of ['maxQueueDepth', 'maxItemsPerSession']) test(`capture lifecycle: expiry closes ${limit} and admits fresh work without reusing an ordinal`, () => {
  const f = fixture();
  const admission = { ...ADMISSION, limits: { ...ADMISSION.limits, [limit]: 1 } };
  f.record('UserPromptSubmit', { admission });
  assert.equal(f.record('UserPromptSubmit', { admission }).refused.limit, limit);
  f.clock(END);
  kernel.privilegedExpireCapture(f.graph);
  const status = f.graph.search('', { project: 'p' }).completeness.capture;
  assert.equal(status.expired, 1);
  assert.equal(status.blocked, 0, 'expired raw is a gap, not extractable backlog');
  assert.equal(status.limited.length, 0);
  assert.equal(f.snapshot().captureSessions[0].limited?.since ?? null, null);
  const fresh = f.record('UserPromptSubmit', { admission });
  assert.equal(fresh.occurrenceSeq, 2);
});

test('capture lifecycle: orphan counters expire from last activity, legacy undated metadata is first stamped', () => {
  const f = fixture();
  const self = () => kernel.privilegedRecordSelfEvent(f.graph, { originId: 'synthetic-origin', signal: 'S-1', source: { event: 'PostToolUse', sessionId: 'self-only' } });
  self();
  f.clock('2026-10-07T00:00:00.000Z');
  self();
  f.clock(END);
  assert.equal(kernel.privilegedExpireCapture(f.graph).sessionsRemoved, 0);
  f.clock('2026-10-14T00:00:00.000Z');
  assert.equal(kernel.privilegedExpireCapture(f.graph).sessionsRemoved, 1);
  assert.equal(f.snapshot().captureSessions?.length ?? 0, 0);
  self();
  const legacy = f.snapshot();
  delete legacy.captureSessions[0].startedAt;
  delete legacy.captureSessions[0].updatedAt;
  f.graph.replaceData(legacy);
  assert.equal(kernel.privilegedExpireCapture(f.graph).sessionsRemoved, 0);
  assert.equal(f.snapshot().captureSessions[0].updatedAt, '2026-10-14T00:00:00.000Z');
});

test('capture lifecycle: recent orphan prefix cannot starve expired sessions in bounded sweeps', () => {
  const f = fixture();
  const touch = (i) => kernel.privilegedRecordSelfEvent(f.graph, { originId: 'synthetic-origin', signal: 'S-1', source: { event: 'PostToolUse', sessionId: `self-${i}` } });
  for (let i = 0; i < 130; i += 1) touch(i);
  f.clock('2026-10-09T00:00:00.000Z');
  for (let i = 0; i < 64; i += 1) touch(i);
  const first = kernel.privilegedExpireCapture(f.graph);
  assert.equal(first.sessionsRemoved, 64);
  assert.equal(first.more, true);
  const second = kernel.privilegedExpireCapture(f.graph);
  assert.equal(second.sessionsRemoved, 2);
  assert.equal(second.more, false);
  assert.equal(f.snapshot().captureSessions.length, 64);
  assert.equal(kernel.privilegedExpireCapture(f.graph).changed, false);
});

test('capture lifecycle: interrupted citation scan reports incomplete cleanup and changes nothing', () => {
  const f = fixture(); f.record();
  f.graph.addDecision({ project: 'p', title: 'Synthetic canonical', chosen: 'keep' });
  f.clock(END);
  const before = f.snapshot(); let checks = 0;
  const result = kernel.privilegedExpireCapture(f.graph, { mayContinue: () => ++checks === 1 });
  assert.equal(result.more, true);
  assert.equal(result.changed, false);
  assert.deepEqual(f.snapshot(), before);
});

for (const limit of ['maxQueueDepth', 'maxItemsPerSession']) test(`capture lifecycle: contentless expired capture closes ${limit} without a raw removal`, () => {
  const f = fixture(); const admission = { ...ADMISSION, limits: { ...ADMISSION.limits, [limit]: 1 } };
  const item = f.record('UserPromptSubmit', { admission, text: '-----END PRIVATE KEY-----' });
  assert.equal(item.blockedReason, 'credential_withheld');
  assert.equal(f.record('UserPromptSubmit', { admission }).refused.limit, limit);
  f.clock(END);
  const result = kernel.privilegedExpireCapture(f.graph);
  assert.equal(result.expired, 0);
  assert.equal(result.changed, true);
  const status = f.graph.search('', { project: 'p' }).completeness.capture;
  assert.equal(status.gaps.find((gap) => gap.reason === limit).to, END);
  assert.equal(f.snapshot().captureSessions[0].limited?.since ?? null, null);
  assert.equal(kernel.privilegedExpireCapture(f.graph).changed, false);
});

test('capture lifecycle: large positive retention windows stamp a valid schema-bounded deadline', () => {
  const f = fixture();
  f.graph.importData(attachLedgerView(f.snapshot(), { retentionOverrides: [{ project: 'p', days: Number.MAX_SAFE_INTEGER }] }));
  const item = f.record();
  assert.equal(item.expiresAt, '9999-12-31T23:59:59.999Z');
  assert.doesNotThrow(() => validateRestorePayload(f.snapshot()));
  f.clock('9999-12-31T23:59:59.999Z');
  assert.equal(kernel.privilegedExpireCapture(f.graph).expired, 1);
});

test('capture lifecycle: a typed claim sourceRef preserves the required full evidence entry', () => {
  const f = fixture();
  const item = f.record();
  const decision = f.graph.addDecision({ project: 'p', title: 'Synthetic claim', chosen: 'retain source' });
  const snapshot = f.snapshot();
  const cite = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.id === decision.id && value.kind === 'decision') {
      value.sourceRaw = 'synthetic uncited raw';
      value.claims = [{ class: 'quoted', text: 'synthetic', sourceRef: item.contentRef, verifierVersion: 'fixture', span: { start: 0, end: 9 } }];
    }
    for (const child of Object.values(value)) cite(child);
  };
  cite(snapshot);
  f.graph.replaceData(snapshot);
  const before = f.snapshot();
  f.clock(END);
  assert.equal(kernel.privilegedExpireCapture(f.graph).expired, 0);
  assert.deepEqual(f.snapshot(), before);
});

for (const reference of ['id', 'contentRef']) for (const held of [false, true]) test(`capture lifecycle: causal-only ${reference} citation protects raw (quarantined=${held})`, () => {
  const f = fixture(), item = f.record();
  const decision = f.graph.addDecision({ project: 'p', title: 'Synthetic causal experience', chosen: 'retain source' });
  const payload = f.snapshot();
  const cite = value => {
    if (!value || typeof value !== 'object') return;
    if (value.id === decision.id && value.kind === 'decision') value.causalClaim = {
      state: 'recorded', class: 'quoted', verifierVersion: 'fixture',
      evidence: [{ sourceRef: item[reference], text: 'synthetic uncited raw' }]
    };
    else for (const child of Object.values(value)) cite(child);
  };
  cite(payload);
  if (held) attachLedgerView(payload, { quarantine: [{ token: payload.records.find(x => x.id === decision.id).erasureToken, at: START }] });
  const graph = createShadowGraph({ now: () => END }); graph.importData(payload);
  if (held) assert.equal(kernel.privilegedLiveSnapshot(graph).records.some(x => x.id === decision.id), false, 'fixture is actually held');
  const before = kernel.privilegedSnapshot(graph);
  assert.equal(kernel.privilegedExpireCapture(graph).expired, 0);
  assert.deepEqual(kernel.privilegedSnapshot(graph), before);
  if (held) assert.equal(kernel.privilegedLiveSnapshot(graph).records.some(x => x.id === decision.id), false);
});

test('capture lifecycle: a cited capture identity protects a shared raw entry from another capture expiry', () => {
  const f = fixture(), item = f.record();
  const decision = f.graph.addDecision({ project: 'p', title: 'Shared raw citation', chosen: 'retain source' });
  const payload = f.snapshot(), peer = { ...structuredClone(item), id: 'shared-raw-peer', erasureToken: 'shared-raw-peer-token' };
  payload.records.push(peer);
  const cite = value => {
    if (!value || typeof value !== 'object') return;
    if (value.id === decision.id && value.kind === 'decision') value.claims = [{ class: 'quoted', verifierVersion: 'fixture', text: 'Accepted', sourceRef: peer.id }];
    else for (const child of Object.values(value)) cite(child);
  };
  cite(payload);
  const graph = createShadowGraph({ now: () => END }); graph.importData(payload);
  const before = kernel.privilegedSnapshot(graph);
  assert.equal(kernel.privilegedExpireCapture(graph).expired, 0);
  assert.deepEqual(kernel.privilegedSnapshot(graph), before);
});

for (const kind of ['unexpired', 'future-schema']) test(`capture lifecycle: shared raw survives while a ${kind} capture still retains it`, () => {
  const f = fixture(), item = f.record(), payload = f.snapshot();
  const peer = { ...structuredClone(item), id: 'shared-retained-peer', erasureToken: 'shared-retained-peer-token' };
  if (kind === 'unexpired') Object.assign(peer, { createdAt: END, updatedAt: END, observedAt: END, expiresAt: '2026-10-15T00:00:00.000Z' });
  else peer.schemaVersion += 1;
  payload.records.push(peer);
  const graph = createShadowGraph({ now: () => END }); graph.importData(payload);
  const before = kernel.privilegedSnapshot(graph), raw = before.captureContent;
  assert.equal(kernel.privilegedExpireCapture(graph).expired, 1);
  const after = kernel.privilegedSnapshot(graph);
  assert.deepEqual(after.captureContent, raw);
  assert.deepEqual(after.records.find(x => x.id === peer.id), before.records.find(x => x.id === peer.id));
  assert.equal(after.records.find(x => x.id === item.id).contentRef, null);
});

test('capture lifecycle: removing expired Stop raw cannot recapture a later transcript copy', () => {
  const f = fixture();
  const stop = f.record('Stop');
  f.clock(END);
  kernel.privilegedExpireCapture(f.graph);
  const after = f.snapshot();
  assert.equal(after.captureContent?.length ?? 0, 0);
  f.graph.replaceData(after);
  let reads = 0;
  const result = kernel.privilegedRecordTranscript(f.graph, { project: 'p', originId: stop.originId, sessionId: stop.source.sessionId, activatedAt: START, trigger: 'PreCompact', admission: ADMISSION, transcript: { ref: 'synthetic', size: () => { reads += 1; return 0; }, read: () => { reads += 1; return Buffer.alloc(0); } } });
  assert.equal(result.blocked, 'raw_expired');
  assert.equal(reads, 0);
  assert.equal(f.snapshot().records.filter((item) => item.source?.event === 'Transcript').length, 0);
});
