// Plan v1.4.4 PR-34 (§9.5, §12.1.1, §12.5, §12.6; programme plan rev6 §3.5,
// briefs/brief-amendments-PR33.md): the privileged capture writer. It records
// a capture item in the shape the PR-33 floor froze and moves it along the
// §12.5 edges, each edge emitting exactly its journal type. occurrenceSeq is
// allocated inside the write from the session's own record, a host identifier
// makes a re-delivery one occurrence, raw text lives outside the journal under
// a random key, and nothing is registered to call it: no verb, hook or worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { privilegedRebuild, privilegedRecordCapture, privilegedSnapshot, privilegedTransitionCapture, privilegedValidate } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const root = fileURLToPath(new URL('..', import.meta.url));
const bytes = (value) => JSON.stringify(value);
const byId = (items) => [...items].sort((left, right) => String(left.id).localeCompare(String(right.id)));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const STATES = ['pending', 'processing', 'extracted', 'failed', 'blocked'];
const LEASE = { leaseId: 'lease-1', ownerId: 'worker-1', ownerBootId: 'boot-1', leaseExpiresAt: '2026-01-01T00:05:00.000Z' };

// Admission (PR-36b) is every capture's: limits no test here reaches.
const ADMISSION = Object.freeze({ limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 2 ** 30, maxItemBytes: 2 ** 40, maxItemsPerSession: 2 ** 30 }, storeBytes: 0 });
const record = (graph, overrides = {}) => privilegedRecordCapture(graph, {
  project: 'alpha', originId: 'origin-a', text: 'the prompt text', admission: ADMISSION,
  ...overrides,
  source: { event: 'UserPromptSubmit', sessionId: 'session-1', role: 'user', ...(overrides.source ?? {}) }
});
const move = (graph, id, to, fields = {}) => privilegedTransitionCapture(graph, { id, to, ...fields });
// A capture-bearing store's reads differ from its capture-free twin's in one
// declared way (M-9, PR-36b): each scoped completeness carries the scope's
// capture block, is incomplete while captured items wait in that scope, and
// says so -- and what capture refused -- in its limitation; a relevance head's
// processing is the block too. So the twin's answer with that declaration
// applied must be the answer, exactly.
function withDeclaration(value, block) {
  if (Array.isArray(value)) return value.map((entry) => withDeclaration(entry, block));
  if (value === null || typeof value !== 'object') return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withDeclaration(entry, block)]));
  if (copy.scope?.requestState === undefined) return copy;
  const backlog = block.pending + block.processing + block.failed + block.blocked;
  const said = [
    ...(backlog ? [`${backlog} captured ${backlog === 1 ? 'item is' : 'items are'} not yet understood in this scope: captured is not stored experience.`] : []),
    ...(block.limited.length ? [`Capture is at a limit (${block.limited.map((entry) => entry.limit).join(', ')}): new material is refused, and nothing accepted is removed.`] : []),
    ...(block.gaps.length ? [`Capture refused material (${[...new Set(block.gaps.map((entry) => entry.reason))].join(', ')}); what it refused is not here.`] : [])
  ];
  const result = { ...copy, capture: block, complete: copy.complete === true && backlog === 0 };
  if (said.length) {
    result.limitation = copy.limitation
      ? { ...copy.limitation, detail: [copy.limitation.detail, ...said].filter(Boolean).join(' ') }
      : { code: backlog ? 'capture_pending' : block.limited.length ? 'capture_limited' : 'capture_gap', detail: said.join(' ') };
  }
  if (Object.hasOwn(copy, 'processing')) result.processing = block;
  return result;
}
// A scope's capture block: its counts, the oldest pending at NOW, nothing refused.
const captureBlock = (counts = {}) => ({ pending: 0, processing: 0, failed: 0, blocked: 0, ...counts, oldestPendingAt: counts.pending ? NOW : null, extractionAvailable: false, limited: [], gaps: [] });
const capturesOf = (snapshot) => byId(snapshot.records.filter((item) => item.kind === 'capture'));
const entriesOf = (snapshot, id) => snapshot.journal.filter((entry) => entry.entityId === id);

// The legal §12.5 edges, what each needs, and the journal type it emits.
const EDGES = {
  'pending->processing': { type: 'capture.state_changed', fields: { lease: LEASE } },
  'processing->extracted': { type: 'extraction.completed', fields: { producedRecordIds: ['dec_produced'] } },
  'processing->failed': { type: 'extraction.failed', fields: { lastError: 'the extractor timed out' } },
  'failed->pending': { type: 'capture.state_changed', fields: {} },
  'failed->blocked': { type: 'capture.state_changed', fields: { blockedReason: 'retry ceiling reached' } }
};
// A path from pending to each state.
const PATHS = { pending: [], processing: ['processing'], extracted: ['processing', 'extracted'], failed: ['processing', 'failed'], blocked: ['processing', 'failed', 'blocked'] };
function inState(graph, state, overrides = {}) {
  let item = record(graph, overrides);
  let from = 'pending';
  for (const to of PATHS[state]) {
    item = move(graph, item.id, to, EDGES[`${from}->${to}`].fields);
    from = to;
  }
  return item;
}

test('a capture is recorded pending, its text outside the journal under a random key', () => {
  const graph = createShadowGraph({ now });
  const item = record(graph);
  assert.equal(item.kind, 'capture');
  assert.equal(item.state, 'pending');
  assert.equal(item.occurrenceSeq, 1);
  assert.equal(item.project, 'alpha');
  assert.equal(item.attribution, 'project');
  assert.equal(item.originId, 'origin-a');
  assert.match(item.contentRef, /^content_[0-9a-f-]{36}$/);
  assert.equal(item.contentHash, sha256('the prompt text'));
  assert.equal(typeof item.erasureToken, 'string');
  assert.equal(item.lease, null);
  assert.equal(item.attempts, 0);
  assert.deepEqual(item.producedRecordIds, []);
  assert.equal(item.sourceIdentity, 'unattributed_observer', 'no signal: captured, marked (plan §16.2)');
  assert.equal(Object.hasOwn(item, 'generation'), false, 'VAR-18');
  const snapshot = privilegedSnapshot(graph);
  assert.deepEqual(capturesOf(snapshot), [item]);
  assert.deepEqual(snapshot.captureContent, [{ contentRef: item.contentRef, project: 'alpha', attribution: 'project', originId: 'origin-a', text: 'the prompt text' }]);
  assert.equal(snapshot.captureSessions.length, 1);
  assert.deepEqual({ ...snapshot.captureSessions[0], id: undefined }, { id: undefined, originId: 'origin-a', sessionId: 'session-1', project: 'alpha', attribution: 'project', occurrenceSeqHighWater: 1 });
  const [entry] = entriesOf(snapshot, item.id);
  assert.equal(entry.type, 'capture.recorded');
  assert.deepEqual(entry.payload, item);
  assert.equal(JSON.stringify(snapshot.journal).includes('the prompt text'), false, 'raw text never enters the journal');
  assert.equal(privilegedValidate(graph).valid, true);
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(byId(rebuilt.projection.records), byId(snapshot.records));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(snapshot), { now }));
});

// F-11b: two genuine identical submissions with no host identifier are two
// occurrences. Their identity keys differ and carry no content.
test('two identical submissions with no host identifier are two items, n and n+1', () => {
  const graph = createShadowGraph({ now });
  const first = record(graph);
  const second = record(graph);
  assert.notEqual(first.id, second.id);
  assert.deepEqual([first.occurrenceSeq, second.occurrenceSeq], [1, 2]);
  assert.equal(first.contentHash, second.contentHash);
  assert.notEqual(first.contentRef, second.contentRef);
  const snapshot = privilegedSnapshot(graph);
  const keys = snapshot.idempotency.filter((item) => item.value.kind === 'capture').map((item) => item.key);
  assert.equal(new Set(keys).size, 2);
  for (const key of keys) {
    assert.ok(key.length <= 400, 'a key the store can hold');
    assert.equal(key.includes('the prompt text') || key.includes(first.contentHash), false, 'no content, and no content hash, in an identity key');
  }
  assert.equal(snapshot.captureSessions[0].occurrenceSeqHighWater, 2);
});

// F-11: a host re-delivery with an identifier is one occurrence.
test('a re-delivered host event is one item: the second call is a no-op', () => {
  for (const [label, source] of [
    ['hostEventId', { hostEventId: 'host-1' }],
    ['toolCallId', { event: 'PostToolUse', toolCallId: 'tool-7', role: 'tool' }],
    ['a numbered Stop turn', { event: 'Stop', turnIndex: 4, role: 'assistant' }]
  ]) {
    const graph = createShadowGraph({ now });
    const first = record(graph, { source });
    const before = bytes(privilegedSnapshot(graph));
    const again = record(graph, { source, text: 'the same event, delivered again' });
    assert.deepEqual(again, first, label);
    assert.equal(bytes(privilegedSnapshot(graph)), before, `${label}: nothing written, nothing allocated`);
    // Another identifier in the same session is another occurrence.
    const other = record(graph, { source: { ...source, ...(source.hostEventId ? { hostEventId: 'host-2' } : source.toolCallId ? { toolCallId: 'tool-8' } : { turnIndex: 5 }) } });
    assert.equal(other.occurrenceSeq, 2, label);
  }
});

// A session's owner is fixed at its first capture, so a binding change
// mid-session never splits it (brief-amendments-PR33 §4).
test('a session keeps the owner of its first capture, and another project\'s capture in it is refused', () => {
  const graph = createShadowGraph({ now });
  record(graph, { project: 'alpha' });
  const before = bytes(privilegedSnapshot(graph));
  assert.deepEqual(record(graph, { project: 'beta' }), { refused: { reason: 'session_in_another_project' }, changed: true }, 'never filed under the first project (PR-36b)');
  const after = privilegedSnapshot(graph);
  assert.equal(bytes({ ...after, events: after.events.filter((entry) => entry.type !== 'capture.refused') }), before, 'a refusal allocates nothing: its one write is the gap it declares to beta (D-6)');
  const later = record(graph, { project: 'alpha' });
  assert.equal(later.project, 'alpha');
  assert.equal(later.occurrenceSeq, 2);
  const elsewhere = record(graph, { project: 'beta', source: { sessionId: 'session-2' } });
  assert.equal(elsewhere.project, 'beta');
  assert.equal(elsewhere.occurrenceSeq, 1, 'each session counts its own occurrences');
  const origin = record(graph, { project: undefined, originId: 'origin-b', source: { sessionId: 'session-1' } });
  assert.deepEqual([origin.project, origin.attribution, origin.originId, origin.occurrenceSeq], [null, 'unattributed', 'origin-b', 1], 'another origin is another session');
  const snapshot = privilegedSnapshot(graph);
  assert.equal(snapshot.captureSessions.length, 3);
  assert.deepEqual(snapshot.captureContent.map((entry) => entry.project), ['alpha', 'alpha', 'beta', null], 'content is owned as its capture is');
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(snapshot), { now }));
});

test('a session whose record is gone keeps the owner and the count its captures have', () => {
  const graph = createShadowGraph({ now });
  record(graph, { project: 'alpha' });
  record(graph, { project: 'alpha' });
  const snapshot = privilegedSnapshot(graph);
  const orphaned = createShadowGraph({ now });
  orphaned.importData({ ...structuredClone(snapshot), captureSessions: undefined });
  assert.deepEqual(record(orphaned, { project: 'beta' }), { refused: { reason: 'session_in_another_project' }, changed: true }, 'its captures still name its owner');
  const next = record(orphaned, { project: 'alpha' });
  assert.deepEqual([next.project, next.occurrenceSeq], ['alpha', 3]);
});

test('a capture with no origin, no owner or no session is refused and nothing is written', () => {
  const graph = createShadowGraph({ now });
  const before = bytes(privilegedSnapshot(graph));
  for (const [label, input, pattern] of [
    ['no origin', { project: 'alpha', originId: undefined }, /originId/],
    ['no owner', { project: undefined, originId: undefined }, /originId|write_scope_unresolved/],
    ['no session', { source: { sessionId: '' } }, /sessionId/],
    ['no event', { source: { event: '' } }, /event/],
    ['text that is not a string', { text: 42 }, /text/],
    ['an observedAt that is not an instant', { observedAt: 'yesterday' }, /observedAt/],
    // What the frozen shape refuses, the writer refuses before it writes.
    ['an empty role', { source: { role: '' } }, /Capture refused: source\.role/],
    ['a negative turn number', { source: { event: 'Stop', turnIndex: -1 } }, /Capture refused: source\.turnIndex/],
    ['a blank sourceIdentity', { sourceIdentity: ' ' }, /Capture refused: sourceIdentity/]
  ]) {
    assert.throws(() => record(graph, input), pattern, label);
    assert.equal(bytes(privilegedSnapshot(graph)), before, `${label}: nothing written`);
  }
  // An event with no content of its own has no content entry.
  const flush = record(graph, { text: undefined, source: { event: 'PreCompact', role: undefined } });
  assert.deepEqual([flush.contentRef, flush.contentHash], [null, null]);
  assert.equal(privilegedSnapshot(graph).captureContent, undefined);
});

// §12.5: every legal edge emits exactly its journal type; every other edge,
// and every edge missing what it needs, throws and journals nothing.
test('each §12.5 edge emits exactly its type, and every other move is refused', () => {
  for (const from of STATES) {
    for (const to of [...STATES, 'excluded']) {
      const graph = createShadowGraph({ now });
      const item = inState(graph, from);
      const edge = EDGES[`${from}->${to}`];
      const before = bytes(privilegedSnapshot(graph));
      const label = `${from} -> ${to}`;
      if (!edge) {
        assert.throws(() => move(graph, item.id, to, { lease: LEASE, producedRecordIds: ['x'], lastError: 'e', blockedReason: 'b' }), /transition/, label);
        assert.equal(bytes(privilegedSnapshot(graph)), before, `${label}: nothing journalled`);
        continue;
      }
      for (const field of Object.keys(edge.fields)) {
        assert.throws(() => move(graph, item.id, to, { ...edge.fields, [field]: undefined }), new RegExp(field), `${label} without ${field}`);
        assert.equal(bytes(privilegedSnapshot(graph)), before, `${label} without ${field}: nothing journalled`);
      }
      const moved = move(graph, item.id, to, edge.fields);
      const after = privilegedSnapshot(graph);
      const entries = after.journal.slice(JSON.parse(before).journal.length);
      assert.deepEqual(entries.map((entry) => entry.type), [edge.type], label);
      assert.deepEqual(entries[0].payload, moved, label);
      assert.equal(moved.state, to, label);
      assert.equal(moved.occurrenceSeq, item.occurrenceSeq, `${label}: the ordinal never changes`);
    }
  }
  const graph = createShadowGraph({ now });
  assert.throws(() => move(graph, 'cap_missing', 'processing', { lease: LEASE }), /not found/);
});

test('what a move records: a claim holds its lease, a result or failure releases it and counts an attempt', () => {
  const graph = createShadowGraph({ now });
  const pending = record(graph);
  const processing = move(graph, pending.id, 'processing', { lease: LEASE });
  assert.deepEqual([processing.lease, processing.attempts], [LEASE, 0]);
  const failed = move(graph, pending.id, 'failed', { lastError: 'the extractor timed out' });
  assert.deepEqual([failed.lease, failed.attempts, failed.lastError], [null, 1, 'the extractor timed out']);
  const retried = move(graph, pending.id, 'pending');
  assert.deepEqual([retried.state, retried.lastError, retried.attempts], ['pending', 'the extractor timed out', 1], 'the last failure stays on record');
  move(graph, pending.id, 'processing', { lease: { ...LEASE, leaseId: 'lease-2' } });
  const extracted = move(graph, pending.id, 'extracted', { producedRecordIds: ['dec_1', 'dec_2'] });
  assert.deepEqual([extracted.lease, extracted.attempts, extracted.producedRecordIds], [null, 2, ['dec_1', 'dec_2']]);
  assert.throws(() => move(graph, pending.id, 'extracted', { producedRecordIds: ['dec_3'] }), /transition/, 'extracted is final');
  // Nothing about the occurrence or its text changes along the way.
  for (const field of ['id', 'originId', 'source', 'observedAt', 'occurrenceSeq', 'contentRef', 'contentHash', 'erasureToken', 'createdAt', 'project', 'attribution']) assert.deepEqual(extracted[field], pending[field], field);
});

test('a full lifecycle rebuilds with parity and survives a JSON and a SQLite restart', async (t) => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'Cache', chosen: 'redis' });
  const items = STATES.map((state) => inState(graph, state));
  inState(graph, 'extracted', { project: undefined, originId: 'origin-b', source: { sessionId: 'session-9', hostEventId: 'host-9' } });
  const snapshot = privilegedSnapshot(graph);
  assert.deepEqual(capturesOf(snapshot).map((item) => item.state).sort(), [...STATES, 'extracted'].sort());
  assert.equal(privilegedValidate(graph).valid, true, JSON.stringify(privilegedValidate(graph).issues));
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(rebuilt.skipped, []);
  assert.deepEqual(byId(rebuilt.projection.records), byId(snapshot.records));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(snapshot), { now }));
  const check = (payload, label) => {
    const reloaded = createShadowGraph({ now });
    reloaded.importData(payload);
    assert.deepEqual(capturesOf(privilegedSnapshot(reloaded)), capturesOf(snapshot), label);
    assert.equal(bytes(privilegedSnapshot(reloaded).captureContent), bytes(snapshot.captureContent), label);
    assert.equal(bytes(privilegedSnapshot(reloaded).captureSessions), bytes(snapshot.captureSessions), label);
    const again = privilegedRebuild(reloaded);
    assert.equal(again.rebuildable, true, `${label}: ${again.reason}`);
    assert.deepEqual(byId(again.projection.records), byId(privilegedSnapshot(reloaded).records), label);
    // The writer goes on counting where it stopped.
    assert.equal(record(reloaded).occurrenceSeq, items.length + 1, label);
  };
  const directory = await scratchDirectory(t, 'shadowgraph-capture-writer-');
  const json = createJsonFileStore(join(directory, 'data.json'));
  await json.save(structuredClone(snapshot));
  check(await json.load(), 'JSON');
  try { await import('node:sqlite'); } catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return; }
  const sqlite = await createSqliteStore(join(directory, 'data.db'));
  await sqlite.save(structuredClone(snapshot));
  const loaded = await sqlite.load();
  sqlite.close();
  check(loaded, 'SQLite');
});

// The ordinal is allocated inside the write: a write that never lands
// allocates nothing, and two writers racing through the revision fence end
// with n and n+1.
test('a lost write allocates nothing, and racing writers never share an ordinal', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-capture-race-');
  const store = createJsonFileStore(join(directory, 'data.json'));
  const seed = createShadowGraph({ now });
  record(seed);
  const base = await store.save(privilegedSnapshot(seed));
  const open = async () => { const graph = createShadowGraph({ now }); graph.importData(await store.load()); return graph; };
  // A write whose save never happens: the next process starts from the store.
  const lost = await open();
  assert.equal(record(lost).occurrenceSeq, 2);
  const retry = await open();
  assert.equal(record(retry).occurrenceSeq, 2, 'the lost write allocated nothing');
  // Two writers from the same revision.
  const first = await open();
  const second = await open();
  assert.equal(record(first).occurrenceSeq, 2);
  assert.equal(record(second).occurrenceSeq, 2);
  await store.save({ ...privilegedSnapshot(first), expectedRevision: base });
  await assert.rejects(store.save({ ...privilegedSnapshot(second), expectedRevision: base }), /revision/i);
  const reloaded = await open();
  assert.equal(record(reloaded).occurrenceSeq, 3, 'the loser reloads and takes the next ordinal');
});

// The session record holds the high-water mark, so nothing a capture does to
// its items moves the count back. A purge of the session's project removes
// the session with everything else it owns (a session record is identifying);
// the next capture there starts a count nothing left in the store shares.
test('the count never moves back while its session lives, and a purge takes the session with it', () => {
  const graph = createShadowGraph({ now });
  const first = inState(graph, 'extracted');
  inState(graph, 'blocked');
  assert.equal(record(graph).occurrenceSeq, 3);
  assert.equal(first.occurrenceSeq, 1);
  const origin = record(graph, { project: undefined, originId: 'origin-b' });
  graph.purgeProject('alpha', { mode: 'hard' });
  const after = privilegedSnapshot(graph);
  assert.deepEqual(capturesOf(after).map((item) => item.id), [origin.id]);
  assert.deepEqual(after.captureSessions.map((session) => session.originId), ['origin-b']);
  assert.equal(after.idempotency.some((item) => item.value.project === 'alpha'), false);
  const fresh = record(graph);
  assert.equal(fresh.occurrenceSeq, 1);
  assert.equal(record(graph, { project: undefined, originId: 'origin-b' }).occurrenceSeq, 2, 'an origin\'s session is untouched by a project purge');
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(privilegedSnapshot(graph)), { now }));
});

// A capture's retry value names one occurrence: import refuses one that names
// another under the same id, and a capture of a newer schema is never moved.
test('a retry value must name its capture\'s own occurrence, and a future capture is not moved', () => {
  const graph = createShadowGraph({ now });
  const item = move(graph, record(graph).id, 'processing', { lease: LEASE });
  const snapshot = privilegedSnapshot(graph);
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(snapshot), { now }), 'a state change since is not a mismatch');
  for (const [label, change] of [['occurrenceSeq', { occurrenceSeq: 9 }], ['source', { source: { ...item.source, sessionId: 'session-other' } }], ['observedAt', { observedAt: '2026-02-01T00:00:00.000Z' }], ['originId', { originId: 'origin-z' }]]) {
    const payload = structuredClone(snapshot);
    const retry = payload.idempotency.find((entry) => entry.value.kind === 'capture');
    Object.assign(retry.value, change);
    assert.throws(() => createShadowGraph({ now }).importData(payload), /semantic mismatch/, label);
  }
  const future = createShadowGraph({ now });
  future.importData({ schemaVersion: 7, records: [{ ...item, id: 'cap_future', erasureToken: 'tok_future', schemaVersion: 8, state: 'pending' }] });
  assert.throws(() => move(future, 'cap_future', 'processing', { lease: LEASE }), /future schema/);
});

// PC-14, PC-16(b): what the writer records is shown on no public read.
test('no public read shows what the writer records', () => {
  const writer = createShadowGraph({ now });
  writer.addDecision({ project: 'alpha', title: 'Cache', chosen: 'redis' });
  writer.addDecision({ originId: 'origin-b', title: 'Unattributed note', chosen: 'keep' });
  for (const state of STATES) inState(writer, state);
  inState(writer, 'pending', { project: undefined, originId: 'origin-b', source: { sessionId: 'session-b' } });
  const load = (payload) => { const graph = createShadowGraph({ now }); graph.importData(payload); return graph; };
  const written = privilegedSnapshot(writer);
  const graph = load(structuredClone(written));
  // The same store with every trace of capture taken out; its entries come
  // last, so nothing is left with a gap.
  const twin = load({
    ...structuredClone(written),
    records: written.records.filter((item) => item.kind !== 'capture'),
    idempotency: written.idempotency.filter((item) => item.value.kind !== 'capture'),
    journal: written.journal.filter((entry) => entry.entityKind !== 'capture'),
    captureContent: undefined, captureSessions: undefined
  });
  const ids = capturesOf(privilegedSnapshot(graph)).map((item) => item.id);
  const leak = new RegExp([...ids, 'capture\\.recorded', 'capture\\.state_changed', 'extraction\\.completed', 'extraction\\.failed', 'the prompt text', 'content_'].join('|'));
  const answer = (read) => { try { return { value: read() }; } catch (error) { return { error: error.message }; } };
  for (const scope of [{ project: 'alpha' }, { originId: 'origin-b' }, {}]) {
    // What the store declares (M-9, PR-36b): the scope's own captures not yet understood, never another's.
    const block = captureBlock(scope.project === 'alpha' ? { pending: 1, processing: 1, failed: 1, blocked: 1 } : scope.originId ? { pending: 1 } : {});
    for (const [name, read] of [
      ['search', (g) => g.search('', scope)], ['retrieve', (g) => g.retrieve('prompt', scope)], ['recall', (g) => g.recall('prompt', scope)],
      ['context', (g) => g.context(scope)], ['exportData', (g) => g.exportData(scope)], ['redact', (g) => g.redact(scope)],
      ['getJournal', (g) => g.getJournal(scope)], ['stats', (g) => g.stats(scope)], ['validate', (g) => g.validate(scope)], ['rebuild', (g) => g.rebuild(scope)]
    ]) {
      const seen = answer(() => read(graph));
      assert.doesNotMatch(JSON.stringify(seen), leak, `${name} ${JSON.stringify(scope)}`);
      if (name !== 'getJournal' && name !== 'rebuild') assert.deepEqual(seen, withDeclaration(answer(() => read(twin)), block), `${name} ${JSON.stringify(scope)}`);
    }
    assert.deepEqual(graph.search('', scope).completeness.capture, block, JSON.stringify(scope));
  }
});

// Only the writer emits the capture types: recordCapture the recording, and
// transitionCapture each edge's type from the one edge table.
test('the kernel emits capture types in two places only', async () => {
  const kernel = await readFile(join(root, 'src', 'shadowgraph.js'), 'utf8');
  const lines = kernel.split(/\r?\n/).filter((line) => !line.trim().startsWith('//'));
  assert.equal(lines.filter((line) => /'capture\.recorded'/.test(line)).length, 1, 'recordCapture');
  assert.equal(lines.filter((line) => /CAPTURE_TRANSITIONS/.test(line)).length, 2, 'the import and transitionCapture');
  const edges = await readFile(join(root, 'src', 'internal', 'capture.js'), 'utf8');
  for (const type of ['capture.state_changed', 'extraction.completed', 'extraction.failed']) assert.match(edges, new RegExp(`type: '${type.replace('.', '\\.')}'`), type);
  // Nor does anything call the self-event counter (PR-35) or the classifier, but the capture hook (PR-36c).
  const callers = { recordCapture: [], transitionCapture: [], recordSelfEvent: [], classifyCaptureSource: [] };
  for (const directory of ['src', 'scripts', 'bin', 'integrations']) {
    let names = [];
    try { names = (await readdir(join(root, directory), { recursive: true })).filter((name) => /\.(?:m?js|cjs|py)$/.test(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names) {
      const source = await readFile(join(root, directory, name), 'utf8');
      for (const verb of Object.keys(callers)) if (source.includes(verb)) callers[verb].push(`${directory}/${name.replaceAll('\\', '/')}`);
    }
  }
  const wrappers = ['src/internal/snapshot.js', 'src/shadowgraph.js'];
  for (const verb of Object.keys(callers)) callers[verb].sort();
  // The capture hook reaches the writer only through the privileged wrappers,
  // whose importers test/privileged-snapshot.test.js allows by name.
  assert.deepEqual(callers, { recordCapture: wrappers, transitionCapture: wrappers, recordSelfEvent: wrappers, classifyCaptureSource: ['src/capture-hook.js', 'src/internal/capture-source.js'] }, 'only the kernel and its privileged wrappers name the writer, and only the capture hook classifies an event');
});

// Review round (briefs/PR34-review.md).

// §12.1: the key is exactly a digest of origin, session, event and the
// identifier the event's row names, or the ordinal. Nothing else goes in.
test('the identity key is a digest of origin, session, event and the identifier or ordinal, and nothing else', () => {
  const graph = createShadowGraph({ now });
  const key = (parts) => `capture:alpha:${sha256(JSON.stringify(parts))}`;
  record(graph, { source: { hostEventId: 'host-1', toolCallId: 'ignored-for-a-prompt', turnIndex: 9 } });
  record(graph, { text: 'another text' });
  record(graph, { source: { event: 'PostToolUse', toolCallId: 'tool-1', hostEventId: 'ignored-for-a-tool', role: 'tool' } });
  record(graph, { source: { event: 'PostToolUseFailure', toolCallId: 'tool-2', role: 'tool' } });
  record(graph, { source: { event: 'Stop', turnIndex: 3, role: 'assistant' } });
  record(graph, { text: undefined, source: { event: 'PreCompact', role: undefined, hostEventId: 'ignored-for-a-flush', turnIndex: 9 } });
  record(graph, { text: undefined, source: { event: 'SessionEnd', role: undefined } });
  const keys = privilegedSnapshot(graph).idempotency.filter((entry) => entry.value.kind === 'capture').map((entry) => entry.key).sort();
  assert.deepEqual(keys, [
    key(['origin-a', 'session-1', 'UserPromptSubmit', 'hostEventId', 'host-1']),
    key(['origin-a', 'session-1', 'UserPromptSubmit', 'occurrence', 2]),
    key(['origin-a', 'session-1', 'PostToolUse', 'toolCallId', 'tool-1']),
    key(['origin-a', 'session-1', 'PostToolUseFailure', 'toolCallId', 'tool-2']),
    key(['origin-a', 'session-1', 'Stop', 'turnIndex', 3]),
    key(['origin-a', 'session-1', 'PreCompact', 'occurrence', 6]),
    key(['origin-a', 'session-1', 'SessionEnd', 'session'])
  ].sort());
  for (const entry of keys) assert.match(entry, /^capture:alpha:[0-9a-f]{64}$/, 'a caller-sized key: 64 hex characters');
});

test('one identifier in another session, origin or event is another occurrence; a SessionEnd is one per session', () => {
  const graph = createShadowGraph({ now });
  const first = record(graph, { source: { hostEventId: 'host-1' } });
  const ids = new Set([first.id]);
  for (const other of [
    record(graph, { source: { sessionId: 'session-2', hostEventId: 'host-1' } }),
    record(graph, { originId: 'origin-c', source: { hostEventId: 'host-1' } }),
    record(graph, { source: { event: 'PostToolUse', hostEventId: 'host-1', role: 'tool' } })
  ]) ids.add(other.id);
  assert.equal(ids.size, 4);
  const end = record(graph, { text: undefined, source: { event: 'SessionEnd', role: undefined } });
  const before = bytes(privilegedSnapshot(graph));
  assert.deepEqual(record(graph, { text: undefined, source: { event: 'SessionEnd', role: undefined } }), end);
  assert.equal(bytes(privilegedSnapshot(graph)), before, 'a second SessionEnd writes nothing');
});

test('an event the source contract does not cover is not captured', () => {
  const graph = createShadowGraph({ now });
  const before = bytes(privilegedSnapshot(graph));
  for (const event of ['stop', ' Stop', 'SessionStart', 'Notification', 'constructor']) {
    assert.throws(() => record(graph, { source: { event } }), /source contract/, event);
  }
  assert.equal(bytes(privilegedSnapshot(graph)), before);
});

// MAJ-1: the ordinal is past every one a live capture of the session holds,
// whatever the session record says.
test('a stale or damaged session record never hands an ordinal out twice', () => {
  const graph = createShadowGraph({ now });
  record(graph);
  record(graph);
  const early = privilegedSnapshot(graph).captureSessions[0];
  record(graph);
  graph.importData({ schemaVersion: 7, captureSessions: [{ ...early, occurrenceSeqHighWater: 1 }] });
  assert.equal(record(graph).occurrenceSeq, 4, 'a merged earlier copy moves nothing back');
  for (const mark of [undefined, null, 0, '5', 1.5, -3]) {
    const seeded = createShadowGraph({ now });
    record(seeded);
    record(seeded);
    const snapshot = privilegedSnapshot(seeded);
    const session = { ...snapshot.captureSessions[0] };
    if (mark === undefined) delete session.occurrenceSeqHighWater;
    else session.occurrenceSeqHighWater = mark;
    const damaged = createShadowGraph({ now });
    damaged.importData({ ...structuredClone(snapshot), captureSessions: [session] });
    assert.equal(record(damaged).occurrenceSeq, 3, `mark ${JSON.stringify(mark)}`);
  }
  // A slot another occurrence already holds is refused, never taken over.
  const held = createShadowGraph({ now });
  const other = record(held, { source: { sessionId: 'session-2' } });
  const snapshot = privilegedSnapshot(held);
  const slot = `capture:alpha:${sha256(JSON.stringify(['origin-a', 'session-1', 'UserPromptSubmit', 'occurrence', 1]))}`;
  snapshot.idempotency.push({ key: slot, value: structuredClone(snapshot.records.find((item) => item.id === other.id)) });
  const crafted = createShadowGraph({ now });
  crafted.importData(snapshot);
  const before = bytes(privilegedSnapshot(crafted));
  assert.throws(() => record(crafted), /already held/);
  assert.equal(bytes(privilegedSnapshot(crafted)), before);
});

test('a claim needs a lease, not a null one', () => {
  const graph = createShadowGraph({ now });
  const item = record(graph);
  const before = bytes(privilegedSnapshot(graph));
  assert.throws(() => move(graph, item.id, 'processing', { lease: null }), /lease/);
  const failing = move(graph, move(graph, item.id, 'processing', { lease: LEASE }).id, 'failed', { lastError: 'e' });
  assert.throws(() => move(graph, failing.id, 'blocked', { blockedReason: null }), /blockedReason/);
  assert.equal(JSON.parse(before).journal.length + 2, privilegedSnapshot(graph).journal.length, 'only the two real moves were journalled');
});

test('what the writer keeps: the observed instant, a creation instant that never moves, and the current item on a re-delivery', () => {
  let clock = '2026-01-01T00:00:00.000Z';
  const graph = createShadowGraph({ now: () => clock });
  const item = record(graph, { observedAt: '2025-12-31T23:59:00.000Z', source: { hostEventId: 'host-1' } });
  assert.deepEqual([item.observedAt, item.createdAt, item.updatedAt], ['2025-12-31T23:59:00.000Z', clock, clock]);
  clock = '2026-01-01T00:01:00.000Z';
  const claimed = move(graph, item.id, 'processing', { lease: LEASE });
  assert.deepEqual([claimed.createdAt, claimed.updatedAt], ['2026-01-01T00:00:00.000Z', clock]);
  assert.deepEqual(record(graph, { source: { hostEventId: 'host-1' } }), claimed, 'a re-delivery answers with the item as it is now');
  // A refusal inside a session that exists writes nothing.
  const before = bytes(privilegedSnapshot(graph));
  assert.throws(() => record(graph, { text: 7 }), /text/);
  // And one that fails only after the session and its ordinal are read.
  assert.throws(() => record(graph, { source: { role: '' } }), /role/);
  assert.equal(bytes(privilegedSnapshot(graph)), before);
  assert.equal(record(graph).occurrenceSeq, 2, 'no ordinal was lost to the refusals');
});
