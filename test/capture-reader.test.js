// Plan v1.4.4 §9.5 and plan rev6 §3.5 PR-33: the capture reader, landing alone
// before any writer. This build reads a capture item -- a `records[]` entry of
// kind 'capture' -- its four journal types and the two collections capture
// owns, and gives them no meaning: it carries them through load, save, rebuild,
// restore and conversion, purges them with their project, and shows them on no
// public read. Nothing here writes one. It is the floor every capture-writing
// build can be rolled back to.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { JOURNAL_ENTRY_TYPES, JOURNAL_TYPE_ENTITY_KIND, REPLAYABLE_ENTRY_TYPES, journalEntryPostconditionIssue, rebuildProjection, schema5PurgeArtifactIssue } from '../src/journal.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { restoreFile } from '../src/backup.js';
import { downgradeToSchema5, downgradeToSchema6 } from '../src/schema-conversion.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { privilegedRebuild, privilegedSnapshot, privilegedValidate } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { TRANSCRIPT_GAP_REASONS } from '../src/internal/transcript.js';
// The capture status's gaps as the limitation states them: what capture refused, then what the transcript cursor did
// not read (PR-36).
const refusedAndUnread = (gaps) => {
  const reasons = [...new Set(gaps.map((entry) => entry.reason))];
  const unread = reasons.filter((reason) => TRANSCRIPT_GAP_REASONS.includes(reason));
  const refused = reasons.filter((reason) => !unread.includes(reason));
  return [
    ...(refused.length ? [`Capture refused material (${refused.join(', ')}); what it refused is not here.`] : []),
    ...(unread.length ? [`Capture did not read part of a session's transcript (${unread.join(', ')}); what it did not read is not here.`] : [])
  ];
};


const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const root = fileURLToPath(new URL('..', import.meta.url));
const bytes = (value) => JSON.stringify(value);
const byId = (items) => [...items].sort((left, right) => String(left.id).localeCompare(String(right.id)));
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
    ...refusedAndUnread(block.gaps)
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
const CAPTURE_TYPES = ['capture.recorded', 'capture.state_changed', 'extraction.completed', 'extraction.failed'];
const STATES = ['pending', 'processing', 'extracted', 'failed', 'blocked'];
// The raw text a capture holds: it must never reach a public read, and a purge
// must take it out of the store's bytes.
const SENTINEL = `raw-capture-text-${randomUUID()}`;

// One capture item in the frozen v7 shape, every declared field present.
function captureItem(id, state, overrides = {}) {
  const project = Object.hasOwn(overrides, 'project') ? overrides.project : 'alpha';
  return {
    id, kind: 'capture', schemaVersion: 7,
    project, attribution: project === null ? 'unattributed' : 'project', originId: 'origin-a',
    state,
    source: { event: 'UserPromptSubmit', sessionId: 'session-1', role: 'user', hostEventId: null, toolCallId: null, turnIndex: null },
    observedAt: NOW, occurrenceSeq: 1, sourceIdentity: 'unattributed_observer',
    contentRef: `content_${id}`, contentHash: null,
    lease: state === 'processing' ? { leaseId: `lease_${id}`, ownerId: 'worker-1', ownerBootId: 'boot-1', leaseExpiresAt: '2026-01-01T00:05:00.000Z' } : null,
    attempts: ['extracted', 'failed'].includes(state) ? 1 : 0,
    lastError: state === 'failed' ? 'the extractor timed out' : null,
    blockedReason: state === 'blocked' ? 'usage_limit' : null,
    producedRecordIds: [], receipts: [], erasureToken: `tok_${id}`,
    cancelRequested: false, supersededResults: [], possibleDuplicateOf: null, expiresAt: null,
    createdAt: NOW, updatedAt: NOW,
    ...overrides
  };
}

function captureEntry(payload, type, seq, extra = {}) {
  return {
    id: `jentry_capture_${seq}`, seq, type, at: NOW, project: payload.project, entityKind: 'capture', entityId: payload.id,
    schemaVersion: 7, payload: structuredClone(payload), provenance: { actor: null, client: null, sessionId: null }, ...extra
  };
}

const typeFor = (previous, state) => (previous === null ? 'capture.recorded'
  : state === 'extracted' ? 'extraction.completed'
    : state === 'failed' ? 'extraction.failed' : 'capture.state_changed');
const captureKey = (item) => (item.attribution === 'unattributed' ? `capture@${JSON.stringify(item.originId)}:${item.id}` : `capture:${item.project}:${item.id}`);

// Each capture, the states its journal takes it through, and what it adds.
function plan(decisionId) {
  return [
    ['cap_pending', ['pending'], { occurrenceSeq: 1 }],
    ['cap_processing', ['pending', 'processing'], { occurrenceSeq: 2 }],
    ['cap_extracted', ['pending', 'processing', 'extracted'], { occurrenceSeq: 3, producedRecordIds: [decisionId] }],
    ['cap_failed', ['pending', 'processing', 'failed'], { occurrenceSeq: 4 }],
    ['cap_blocked', ['pending', 'blocked'], { occurrenceSeq: 5 }],
    ['cap_beta', ['pending'], { project: 'beta', source: { event: 'UserPromptSubmit', sessionId: 'session-2', role: 'user', hostEventId: 'host-7', toolCallId: null, turnIndex: 3 } }],
    ['cap_origin', ['pending'], { project: null, originId: 'origin-b' }]
  ];
}
const CAPTURE_IDS = ['cap_pending', 'cap_processing', 'cap_extracted', 'cap_failed', 'cap_blocked', 'cap_beta', 'cap_origin'];
const ALPHA_CAPTURE_IDS = CAPTURE_IDS.slice(0, 5);

function seeded() {
  const graph = createShadowGraph({ now });
  const decision = graph.addDecision({ project: 'alpha', title: 'Cache', chosen: 'redis' });
  graph.addDecision({ project: 'beta', title: 'Queue', chosen: 'sqs' });
  graph.addDecision({ originId: 'origin-b', title: 'Unattributed note', chosen: 'keep' });
  return { graph, decisionId: decision.id };
}

// A store a capture writer would leave: a capture in every state, the four
// journal types, capture retry values, and both capture collections.
function captureStore() {
  const { graph, decisionId } = seeded();
  const payload = structuredClone(privilegedSnapshot(graph));
  let seq = payload.journalSeq;
  const finals = [];
  for (const [id, states, overrides] of plan(decisionId)) {
    let previous = null;
    for (const state of states) {
      const item = captureItem(id, state, overrides);
      seq += 1;
      payload.journal.push(captureEntry(item, typeFor(previous, state), seq, previous === null ? { idempotencyKey: captureKey(item) } : {}));
      previous = state;
    }
    finals.push(captureItem(id, states.at(-1), overrides));
  }
  payload.records.push(...finals);
  payload.idempotency.push(...finals.map((item) => ({ key: captureKey(item), value: structuredClone(item) })));
  payload.journalSeq = seq;
  payload.captureContent = finals.map((item) => ({ contentRef: item.contentRef, project: item.project, attribution: item.attribution, originId: item.originId, text: `${SENTINEL} ${item.id}` }));
  payload.captureSessions = [
    { id: 'session_alpha', originId: 'origin-a', sessionId: 'session-1', project: 'alpha', attribution: 'project', occurrenceSeqHighWater: 5, cursor: null, selfEvents: {} },
    { id: 'session_beta', originId: 'origin-a', sessionId: 'session-2', project: 'beta', attribution: 'project', occurrenceSeqHighWater: 1, cursor: null, selfEvents: {} },
    { id: 'session_origin', originId: 'origin-b', sessionId: 'session-1', project: null, attribution: 'unattributed', occurrenceSeqHighWater: 1, cursor: null, selfEvents: {} }
  ];
  return { payload, decisionId };
}

// The same store with every trace of capture taken out.
function withoutCapture(payload) {
  const twin = structuredClone(payload);
  twin.records = twin.records.filter((item) => item.kind !== 'capture');
  twin.idempotency = twin.idempotency.filter((item) => item.value?.kind !== 'capture');
  twin.journal = twin.journal.filter((entry) => !CAPTURE_TYPES.includes(entry.type));
  delete twin.captureContent;
  delete twin.captureSessions;
  return twin;
}

const loaded = (payload) => {
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  return graph;
};
const capturesOf = (snapshot) => byId(snapshot.records.filter((item) => item.kind === 'capture'));
const LEAK = new RegExp([...CAPTURE_IDS, ...CAPTURE_TYPES.map((type) => type.replace('.', '\\.')), 'tok_cap_', 'content_cap_', SENTINEL].join('|'));

test('the reader adds exactly the four capture journal types, after every earlier one', () => {
  // 26 and 27 since PR-37a added restore.reapplied, after project.purged.
  assert.equal(REPLAYABLE_ENTRY_TYPES.length, 26);
  assert.equal(JOURNAL_ENTRY_TYPES.length, 27);
  assert.deepEqual(REPLAYABLE_ENTRY_TYPES.slice(-4), CAPTURE_TYPES);
  for (const type of CAPTURE_TYPES) assert.equal(JOURNAL_TYPE_ENTITY_KIND[type], 'capture', type);
});

test('a capture-bearing store loads, validates, rebuilds and passes restore validation', () => {
  const { payload } = captureStore();
  const graph = loaded(payload);
  const validation = privilegedValidate(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(validation.issues.filter((issue) => ['error', 'unsupported'].includes(issue.severity)).length, 0);
  const live = privilegedSnapshot(graph);
  assert.deepEqual(capturesOf(live), capturesOf(payload), 'every capture item is carried as it arrived');
  assert.deepEqual(STATES.map((state) => live.records.filter((item) => item.kind === 'capture' && item.state === state).length > 0), [true, true, true, true, true]);
  assert.equal(bytes(live.captureContent), bytes(payload.captureContent));
  assert.equal(bytes(live.captureSessions), bytes(payload.captureSessions));
  assert.deepEqual(live.idempotency.filter((item) => item.value.kind === 'capture').map((item) => item.key).sort(), capturesOf(payload).map(captureKey).sort());
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(rebuilt.skipped, []);
  assert.deepEqual(byId(rebuilt.projection.records), byId(live.records));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(payload), { now }));
});

test('each capture journal type folds to exactly its snapshot, and only in the states it may leave', () => {
  const allowed = {
    'capture.recorded': ['pending', 'blocked'],
    'capture.state_changed': ['pending', 'processing', 'blocked'],
    'extraction.completed': ['extracted'],
    'extraction.failed': ['pending', 'failed', 'blocked']
  };
  for (const type of CAPTURE_TYPES) {
    for (const state of STATES) {
      const first = captureItem('cap_x', 'pending');
      const last = captureItem('cap_x', state);
      const journal = type === 'capture.recorded'
        ? [captureEntry(last, type, 1)]
        : [captureEntry(first, 'capture.recorded', 1), captureEntry(last, type, 2)];
      const report = rebuildProjection(journal, { journalEpoch: 1 });
      const label = `${type} -> ${state}`;
      if (allowed[type].includes(state)) {
        assert.equal(report.rebuildable, true, `${label}: ${report.reason}`);
        assert.deepEqual(report.skipped, [], label);
        assert.deepEqual(report.projection.records, [last], label);
      } else {
        assert.equal(report.rebuildable, false, label);
        assert.equal(report.skipped.at(-1).why, 'type_payload_postcondition_mismatch', label);
        assert.equal(report.skipped.at(-1).type, type, label);
      }
    }
  }
  // A payload that is not a well-formed capture item is never folded.
  for (const [label, payload] of [
    ['a decision payload', { id: 'cap_x', kind: 'decision', project: 'alpha', title: 't', chosen: 'c' }],
    ['a capture with no token', (({ erasureToken, ...rest }) => rest)(captureItem('cap_x', 'pending'))],
    ['a capture carrying a generation', { ...captureItem('cap_x', 'pending'), generation: 1 }]
  ]) {
    const report = rebuildProjection([{ ...captureEntry(payload, 'capture.recorded', 1), entityKind: 'capture' }], { journalEpoch: 1 });
    assert.equal(report.rebuildable, false, label);
    assert.deepEqual(report.projection.records, [], label);
  }
});

test('import and restore refuse a capture item outside the frozen shape, naming its position', () => {
  const mutations = [
    ['state excluded (a self-event is never an item)', (item) => { item.state = 'excluded'; }],
    ['a generation field (VAR-18)', (item) => { item.generation = 0; }],
    ['no erasureToken', (item) => { delete item.erasureToken; }],
    ['failed without lastError', (item) => { item.state = 'failed'; item.lastError = null; }],
    ['blocked without blockedReason', (item) => { item.state = 'blocked'; item.blockedReason = null; }],
    ['a legacy attribution', (item) => { item.attribution = 'legacy_ambiguous'; }],
    ['unattributed with a project', (item) => { item.attribution = 'unattributed'; }],
    ['no originId', (item) => { delete item.originId; }],
    ['a negative occurrenceSeq', (item) => { item.occurrenceSeq = -1; }],
    ['a source with no sessionId', (item) => { delete item.source.sessionId; }],
    ['schema 6', (item) => { item.schemaVersion = 6; }],
    ['a lease with no ownerBootId', (item) => { item.state = 'processing'; item.lease = { leaseId: 'l', ownerId: 'o', leaseExpiresAt: NOW }; }],
    ['producedRecordIds not a list', (item) => { item.producedRecordIds = 'rec_1'; }],
    ['a contentHash that is not sha256', (item) => { item.contentHash = 'xyz'; }],
    ['cancelRequested not a boolean', (item) => { item.cancelRequested = 'yes'; }],
    ['an observedAt that is not an instant', (item) => { item.observedAt = 'yesterday'; }]
  ];
  for (const [label, mutate] of mutations) {
    const payload = { schemaVersion: 7, records: [captureItem('cap_bad', 'pending')] };
    mutate(payload.records[0]);
    assert.throws(() => createShadowGraph({ now }).importData(structuredClone(payload)), /records\[0\] is not a well-formed capture item/, label);
    assert.throws(() => validateRestorePayload(structuredClone(payload), { now }), /records\[0\] is not a well-formed capture item/, label);
  }
  // What a later writer may do is carried: a lease released or cleared while
  // processing, a lease with more to say, a session's first occurrence at 0.
  for (const [label, mutate] of [
    ['processing with no lease', (item) => { item.state = 'processing'; item.lease = null; }],
    ['a lease with a further field', (item) => { item.state = 'processing'; item.lease = { leaseId: 'l', ownerId: 'o', ownerBootId: 'b', leaseExpiresAt: NOW, claimedAt: NOW }; }],
    ['occurrenceSeq 0', (item) => { item.occurrenceSeq = 0; }],
    ['a field no build reads yet', (item) => { item.laterField = { kept: true }; }]
  ]) {
    const payload = { schemaVersion: 7, records: [captureItem('cap_ok', 'pending')] };
    mutate(payload.records[0]);
    const graph = createShadowGraph({ now });
    assert.doesNotThrow(() => graph.importData(structuredClone(payload)), label);
    assert.equal(bytes(privilegedSnapshot(graph).records[0]), bytes(payload.records[0]), label);
  }
  // A kind this build does not know is still refused.
  assert.throws(() => createShadowGraph().importData({ schemaVersion: 7, records: [{ ...captureItem('x', 'pending'), kind: 'unknown' }] }), /records\[0\] is malformed/);
  // A capture item is not a claim-bearing record: its own shape governs it.
  assert.doesNotThrow(() => createShadowGraph({ now }).importData({ schemaVersion: 7, records: [captureItem('cap_ok', 'pending')] }));
});

test('import refuses capture collections outside their frozen shape', () => {
  const content = (overrides = {}) => ({ contentRef: 'content_1', project: 'alpha', attribution: 'project', originId: 'origin-a', ...overrides });
  const session = (overrides = {}) => ({ id: 'session_1', originId: 'origin-a', sessionId: 'session-1', project: 'alpha', attribution: 'project', ...overrides });
  for (const [label, extra] of [
    ['content not a list', { captureContent: { content_1: content() } }],
    ['content with no contentRef', { captureContent: [content({ contentRef: '' })] }],
    ['a contentRef twice', { captureContent: [content(), content()] }],
    ['content owned by nobody', { captureContent: [content({ attribution: 'unattributed', originId: undefined, project: null })] }],
    ['sessions not a list', { captureSessions: session() }],
    ['a session with no sessionId', { captureSessions: [session({ sessionId: '' })] }],
    ['a session id twice', { captureSessions: [session(), session({ sessionId: 'session-2' })] }],
    ['one origin session twice', { captureSessions: [session(), session({ id: 'session_2' })] }],
    ['a session with a legacy attribution', { captureSessions: [session({ attribution: 'legacy_unattributed', project: null })] }]
  ]) {
    assert.throws(() => createShadowGraph({ now }).importData({ schemaVersion: 7, ...structuredClone(extra) }), /capture_collection_malformed/, label);
    assert.throws(() => validateRestorePayload({ schemaVersion: 7, ...structuredClone(extra) }, { now }), /capture_collection_malformed/, label);
  }
});

test('a capture item of a future schema is carried verbatim and blocks restore, as any future record does', () => {
  const { payload } = captureStore();
  const future = { ...captureItem('cap_future', 'queued'), schemaVersion: 8, somethingNew: { kept: true } };
  delete future.lease;
  payload.records.push(future);
  const graph = loaded(payload);
  assert.equal(bytes(privilegedSnapshot(graph).records.find((item) => item.id === 'cap_future')), bytes(future));
  assert.ok(privilegedValidate(graph).issues.some((issue) => issue.code === 'unsupported_record_schema_version' && issue.recordId === 'cap_future'));
  assert.throws(() => validateRestorePayload(structuredClone(payload), { now }), /unsupported_record_schema_version/);
});

test('JSON and SQLite: capture items, entries and collections survive load, save and reload byte-equal', async (t) => {
  const { payload } = captureStore();
  const directory = await scratchDirectory(t, 'shadowgraph-capture-reader-');
  const check = (reloaded, label) => {
    assert.deepEqual(capturesOf(reloaded).map(bytes), capturesOf(payload).map(bytes), `${label}: items`);
    assert.deepEqual(reloaded.journal.filter((entry) => CAPTURE_TYPES.includes(entry.type)).map(bytes), payload.journal.filter((entry) => CAPTURE_TYPES.includes(entry.type)).map(bytes), `${label}: entries`);
    assert.equal(bytes(reloaded.captureContent), bytes(payload.captureContent), `${label}: content`);
    assert.equal(bytes(reloaded.captureSessions), bytes(payload.captureSessions), `${label}: sessions`);
  };
  const file = join(directory, 'data.json');
  await writeFile(file, JSON.stringify(payload, null, 2));
  const store = createJsonFileStore(file);
  const graph = createShadowGraph({ now });
  graph.importData(await store.load());
  graph.addDecision({ project: 'alpha', title: 'After reload', chosen: 'yes' });
  await store.save(privilegedSnapshot(graph));
  const reloaded = JSON.parse(await readFile(file, 'utf8'));
  check(reloaded, 'JSON');
  const again = loaded(reloaded);
  assert.equal(bytes(privilegedSnapshot(again)), bytes(privilegedSnapshot(loaded(privilegedSnapshot(again)))), 'a second round trip changes nothing');

  try { await import('node:sqlite'); } catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return; }
  const sqliteFile = join(directory, 'data.db');
  const first = await createSqliteStore(sqliteFile);
  await first.save(structuredClone(payload));
  first.close();
  const reopened = await createSqliteStore(sqliteFile);
  const sqliteGraph = createShadowGraph({ now });
  sqliteGraph.importData(await reopened.load());
  sqliteGraph.addDecision({ project: 'alpha', title: 'After reopen', chosen: 'yes' });
  await reopened.save(privilegedSnapshot(sqliteGraph));
  reopened.close();
  const last = await createSqliteStore(sqliteFile);
  const sqliteReloaded = await last.load();
  last.close();
  check(sqliteReloaded, 'SQLite');
});

test('JSON and SQLite: a capture-bearing backup restores through the backend primitive and rebuilds', async (t) => {
  const { payload } = captureStore();
  const directory = await scratchDirectory(t, 'shadowgraph-capture-restore-');
  const check = (installed, live, label) => {
    assert.deepEqual(capturesOf(installed), capturesOf(payload), label);
    const rebuilt = privilegedRebuild(live);
    assert.equal(rebuilt.rebuildable, true, `${label}: ${rebuilt.reason}`);
    assert.deepEqual(byId(rebuilt.projection.records), byId(privilegedSnapshot(live).records), label);
    assert.equal(bytes(privilegedSnapshot(live).captureContent), bytes(payload.captureContent), label);
  };
  const source = join(directory, 'backup.json');
  const destination = join(directory, 'data.json');
  await writeFile(source, JSON.stringify(payload, null, 2));
  const live = createShadowGraph({ now });
  await restoreFile(source, destination, { afterReplace: (restored) => live.replaceData(restored) });
  check(JSON.parse(await readFile(destination, 'utf8')), live, 'JSON');

  try { await import('node:sqlite'); } catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return; }
  const sourceFile = join(directory, 'source.db');
  const sqliteSource = await createSqliteStore(sourceFile);
  await sqliteSource.save(structuredClone(payload));
  sqliteSource.close();
  const target = await createSqliteStore(join(directory, 'data.db'));
  const sqliteLive = createShadowGraph({ now });
  await target.restore(sourceFile, { afterReplace: (restored) => sqliteLive.replaceData(restored) });
  const installed = await target.load();
  target.close();
  check(installed, sqliteLive, 'SQLite');
});

// PC-14, PC-16(b): a capture item is never presented as stored experience.
// Every public read of a capture-bearing store answers exactly as the same
// store without capture does, and names no capture id, type, token or text.
test('no public read shows a capture item, entry or collection', () => {
  const { payload, decisionId } = captureStore();
  const graph = loaded(payload);
  const twin = loaded(withoutCapture(payload));
  const scopes = [{ project: 'alpha' }, { project: 'beta' }, { originId: 'origin-b' }, { originId: 'origin-a' }, {}];
  const reads = [
    ['search', (g, scope) => g.search('', scope)],
    ['search by kind', (g, scope) => g.search('', { ...scope, kind: 'capture' })],
    ['retrieve', (g, scope) => g.retrieve('prompt', scope)],
    ['recall', (g, scope) => g.recall('cache', scope)],
    ['context', (g, scope) => g.context(scope)],
    ['exportData', (g, scope) => g.exportData(scope)],
    ['redact', (g, scope) => g.redact(scope)],
    ['getJournal', (g, scope) => g.getJournal(scope)],
    ['stats', (g, scope) => g.stats(scope)],
    ['validate', (g, scope) => g.validate(scope)],
    ['rebuild', (g, scope) => g.rebuild(scope)],
    ['traverse from a record', (g, scope) => g.traverse({ ...scope, id: decisionId })]
  ];
  // A refusal is an answer too, and must be the same one.
  const answer = (read) => { try { return { value: read() }; } catch (error) { return { error: error.message }; } };
  for (const scope of scopes) {
    // The declaration counts the scope's own captures not yet understood, never another's (M-9).
    const block = captureBlock({ alpha: { pending: 1, processing: 1, failed: 1, blocked: 1 }, beta: { pending: 1 }, 'origin-b': { pending: 1 } }[scope.project ?? scope.originId]);
    for (const [name, read] of reads) {
      const label = `${name} ${JSON.stringify(scope)}`;
      const seen = answer(() => read(graph, scope));
      assert.doesNotMatch(JSON.stringify(seen), LEAK, label);
      assert.deepEqual(seen, withDeclaration(answer(() => read(twin, scope)), block), `${label}: answers as the store without capture does, with the scope's capture declared`);
    }
    // A capture id is an id nothing holds: the answer names only what was asked.
    for (const id of CAPTURE_IDS) assert.deepEqual(answer(() => graph.traverse({ ...scope, id })), withDeclaration(answer(() => twin.traverse({ ...scope, id })), block), `traverse ${id}`);
    assert.equal(twin.search('', scope).completeness.capture, undefined, 'a store without capture declares nothing');
  }
});

// AC-039 (part): purge reaches the capture kind and its collections on this
// build, in both modes, and leaves a store that still rebuilds and restores.
for (const mode of ['logical', 'hard']) {
  test(`a ${mode} purge removes the project's captures, their retry values, entries and collection entries`, () => {
    const { payload } = captureStore();
    const graph = loaded(payload);
    const alphaEntries = payload.journal.filter((entry) => CAPTURE_TYPES.includes(entry.type) && entry.project === 'alpha');
    const result = graph.purgeProject('alpha', { mode });
    assert.equal(result.removed, 1 + ALPHA_CAPTURE_IDS.length, 'removed counts the decision and the capture items');
    assert.equal(result.records, 1, 'records counts decisions, attempts and memories only');
    // The capture items, their content and the project's session, and nothing withheld (PR-37d design §6.1).
    assert.deepEqual([result.captures, result.captureContent, result.captureSessions, result.withheld], [ALPHA_CAPTURE_IDS.length, ALPHA_CAPTURE_IDS.length, 1, 0]);
    const after = privilegedSnapshot(graph);
    assert.deepEqual(capturesOf(after).map((item) => item.id), ['cap_beta', 'cap_origin']);
    assert.deepEqual(after.idempotency.filter((item) => item.value.kind === 'capture').map((item) => item.value.id).sort(), ['cap_beta', 'cap_origin']);
    assert.deepEqual(after.captureContent.map((item) => item.contentRef), ['content_cap_beta', 'content_cap_origin']);
    assert.deepEqual(after.captureSessions.map((item) => item.id), ['session_beta', 'session_origin']);
    const alphaSequences = new Set(alphaEntries.map((entry) => entry.seq));
    const left = after.journal.filter((entry) => alphaSequences.has(entry.seq));
    if (mode === 'hard') {
      assert.deepEqual(left, []);
      for (const seq of alphaSequences) assert.ok(result.removedJournalSequences.includes(seq), `hard purge declares ${seq}`);
    } else {
      assert.equal(left.length, alphaEntries.length);
      for (const entry of left) {
        assert.equal(entry.payload, null);
        assert.equal(entry.entityId, null);
        assert.equal(entry.redactedReason, 'project_purged');
      }
    }
    assert.doesNotMatch(JSON.stringify(after.journal), new RegExp(ALPHA_CAPTURE_IDS.join('|')));
    const rebuilt = privilegedRebuild(graph);
    // A hard purge of the journal's first entries leaves the declared gap it
    // always has; restore validation checks it against the purge's ledger.
    if (mode === 'logical') assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
    else assert.equal(rebuilt.reason, 'journal epoch is outside the available sequence range');
    assert.deepEqual(rebuilt.skipped, []);
    assert.deepEqual(byId(rebuilt.projection.records), byId(after.records));
    assert.doesNotThrow(() => validateRestorePayload(structuredClone(after), { now }));
    // The purged project's journal shows no capture skeleton either.
    assert.doesNotMatch(JSON.stringify(graph.getJournal({ project: 'alpha' })), LEAK);
    // An origin's capture belongs to no project a purge can name.
    graph.purgeProject('beta', { mode });
    assert.deepEqual(capturesOf(privilegedSnapshot(graph)).map((item) => item.id), ['cap_origin']);
    assert.deepEqual(privilegedSnapshot(graph).captureSessions.map((item) => item.id), ['session_origin']);
  });
}

test('a whole-store operation that fails leaves every capture as it was', () => {
  const { payload } = captureStore();
  const graph = loaded(payload);
  const before = bytes(privilegedSnapshot(graph));
  assert.throws(() => graph.purgeProject('alpha', { mode: 'partial' }), /Purge mode must be logical or hard/);
  assert.throws(() => graph.replaceData({ schemaVersion: 7, records: [{ ...captureItem('cap_bad', 'pending'), state: 'excluded' }] }), /Refusing to replace data/);
  assert.equal(bytes(privilegedSnapshot(graph)), before);
});

test('the last capture collection entries take the collection with them', () => {
  const { payload } = captureStore();
  payload.captureContent = payload.captureContent.filter((item) => item.project === 'alpha');
  payload.captureSessions = payload.captureSessions.filter((item) => item.project === 'alpha');
  // Content an alpha capture names is removed with it, whoever the entry says owns it.
  payload.captureContent[0].project = 'beta';
  const graph = loaded(payload);
  graph.purgeProject('alpha');
  const after = privilegedSnapshot(graph);
  assert.equal(Object.hasOwn(after, 'captureContent'), false);
  assert.equal(Object.hasOwn(after, 'captureSessions'), false);
});

test('SQLite physically erases a purged project\'s capture text', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const { payload } = captureStore();
  // Only alpha's captures carry the sentinel here, so none may survive.
  for (const item of payload.captureContent) if (item.project !== 'alpha') item.text = 'kept';
  const directory = await scratchDirectory(t, 'shadowgraph capture erasure ');
  const file = join(directory, 'capture store.db');
  const graph = loaded(payload);
  let store = await createSqliteStore(file);
  const revision = await store.save(privilegedSnapshot(graph));
  assert.equal((await readFile(file)).includes(Buffer.from(SENTINEL)), true, 'precondition: the text reached SQLite bytes');
  graph.purgeProject('alpha', { mode: 'logical' });
  await store.save({ ...privilegedSnapshot(graph), expectedRevision: revision });
  store.close();
  store = undefined;
  const inspector = new DatabaseSync(new URL(`${pathToFileURL(file).href}?immutable=1`), { readOnly: true });
  try {
    assert.equal(inspector.prepare('PRAGMA freelist_count').get().freelist_count, 0);
  } finally { inspector.close(); }
  for (const candidate of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    let held = null;
    try { held = await readFile(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (held) for (const value of [SENTINEL, 'tok_cap_pending', 'content_cap_failed']) assert.equal(held.includes(Buffer.from(value)), false, `${candidate} retained ${value}`);
  }
  // A purge that removes one collection entry and nothing else is a
  // destructive save too, so SQLite scrubs it: page reuse can hide the bytes,
  // so the save's own classification is what is checked.
  let base = graph;
  for (const [name, entry] of [
    ['captureContent', { contentRef: 'content_gamma', project: 'gamma', attribution: 'project', originId: 'origin-a', text: 'gamma' }],
    ['captureSessions', { id: 'session_gamma', originId: 'origin-g', sessionId: 'session-9', project: 'gamma', attribution: 'project' }]
  ]) {
    const held = privilegedSnapshot(base);
    const next = loaded({ ...held, [name]: [...(held[name] ?? []), entry] });
    base = next;
    const destructive = [];
    store = await createSqliteStore(file, { saveFault: (stage, context) => { if (stage === 'beforeCommit') destructive.push(context.destructive); } });
    const saved = await store.save({ ...privilegedSnapshot(next), expectedRevision: (await store.load()).revision });
    next.purgeProject('gamma');
    await store.save({ ...privilegedSnapshot(next), expectedRevision: saved });
    store.close();
    assert.deepEqual(destructive, [false, true], `${name}: only the removal is destructive`);
  }
});

test('a downgrade leaves every capture out, names each one, and counts the capture collections', () => {
  const { payload } = captureStore();
  const graph = loaded(payload);
  const { payload: six, report } = downgradeToSchema6(privilegedSnapshot(graph), { now });
  assert.equal(six.records.some((item) => item.kind === 'capture'), false);
  assert.equal(six.idempotency.some((item) => item.value.kind === 'capture'), false);
  assert.equal(JSON.stringify(six.journal).includes('"kind":"capture"'), false);
  assert.deepEqual(report.excluded.filter((item) => item.kind === 'capture').map((item) => item.id).sort(), [...CAPTURE_IDS].sort());
  for (const item of report.excluded.filter((entry) => entry.kind === 'capture')) assert.match(item.reason, /capture/);
  assert.deepEqual(report.excludedEntryCounts, { captureContent: 7, captureSessions: 3 });
  assert.equal(Object.hasOwn(six, 'captureContent') || Object.hasOwn(six, 'captureSessions'), false);
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(six), { now }), 'the schema-6 fork reloads');
  const five = downgradeToSchema5(six, { now });
  assert.equal(five.payload.records.some((item) => item.kind === 'capture'), false);
  // A store without capture converts exactly as before.
  const plain = downgradeToSchema6(privilegedSnapshot(loaded(withoutCapture(payload))), { now });
  assert.equal(plain.report.excluded.some((item) => item.kind === 'capture'), false);
  assert.deepEqual(plain.report.excludedEntryCounts, {});
});

test('a journal-less import of capture items writes each item the entry its state takes', () => {
  const { graph: base, decisionId } = seeded();
  const records = plan(decisionId).map(([id, states, overrides]) => captureItem(id, states.at(-1), overrides));
  // The first journal-less import into a store with no baseline writes one;
  // capture items ride in it as records do.
  const first = createShadowGraph({ now });
  first.importData({ schemaVersion: 7, records: structuredClone(records) });
  assert.deepEqual(capturesOf(privilegedSnapshot(first)), byId(records));
  assert.equal(privilegedRebuild(first).rebuildable, true);
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(privilegedSnapshot(first)), { now }));
  // Once one exists, each imported item gets its own entry.
  const graph = createShadowGraph({ now });
  graph.importData({ schemaVersion: 7, records: [structuredClone(privilegedSnapshot(base).records[0])] });
  assert.doesNotThrow(() => graph.importData({ schemaVersion: 7, records: structuredClone(records) }));
  const live = privilegedSnapshot(graph);
  const types = Object.fromEntries(live.journal.filter((entry) => entry.entityKind === 'capture').map((entry) => [entry.entityId, entry.type]));
  assert.deepEqual(types, {
    cap_pending: 'capture.recorded', cap_processing: 'capture.state_changed', cap_extracted: 'extraction.completed',
    cap_failed: 'extraction.failed', cap_blocked: 'capture.state_changed', cap_beta: 'capture.recorded', cap_origin: 'capture.recorded'
  });
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(byId(rebuilt.projection.records), byId(live.records));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(live), { now }));
  // A capture id is in the one entity namespace.
  assert.throws(() => graph.importData({ schemaVersion: 7, records: [{ ...structuredClone(live.records.find((item) => item.kind === 'decision')), id: 'cap_pending' }] }), /cannot change kind|already exists/);
});

test('a capture_deleted skeleton is canonical on a capture type and on no other', () => {
  const skeleton = (type, redactedReason) => ({
    id: `jentry_skeleton_${type}`, seq: 1, type, at: NOW, project: 'alpha', entityKind: JOURNAL_TYPE_ENTITY_KIND[type] ?? null, entityId: null,
    schemaVersion: 7, payload: null, provenance: { actor: null, client: null, sessionId: null }, redacted: true, redactedReason
  });
  for (const type of CAPTURE_TYPES) {
    assert.equal(schema5PurgeArtifactIssue(skeleton(type, 'capture_deleted'), 7), null, type);
    assert.equal(schema5PurgeArtifactIssue(skeleton(type, 'project_purged'), 7), null, type);
    const report = rebuildProjection([skeleton(type, 'capture_deleted')], { journalEpoch: 1 });
    assert.equal(report.rebuildable, true, `${type}: ${report.reason}`);
    assert.deepEqual(report.projection.records, [], type);
  }
  for (const type of REPLAYABLE_ENTRY_TYPES.filter((item) => !CAPTURE_TYPES.includes(item))) {
    assert.match(schema5PurgeArtifactIssue(skeleton(type, 'capture_deleted'), 7) ?? '', /noncanonical redactedReason/, type);
  }
});

test('an id a capture holds is never allocated again, nor taken as a relation endpoint', (t) => {
  const fixed = 1790000000000;
  const candidate = `decision_${fixed}_${(0.25).toString(36).slice(2, 8)}`;
  const graph = loaded({ schemaVersion: 7, records: [captureItem(candidate, 'pending')] });
  t.mock.method(Date, 'now', () => fixed);
  let n = 0;
  t.mock.method(Math, 'random', () => (n++ === 0 ? 0.25 : 0.5));
  assert.notEqual(graph.addDecision({ project: 'alpha', title: 'Allocated', chosen: 'A' }).id, candidate);
  t.mock.restoreAll();
  const { payload, decisionId } = captureStore();
  const relation = { id: 'rel_to_capture', from: decisionId, to: 'cap_pending', relation: 'related_to', project: 'alpha' };
  // Whether the capture is already held or arrives with the relation.
  assert.throws(() => loaded(payload).importData({ schemaVersion: 7, relations: [relation] }), /endpoints must exist/);
  assert.throws(() => createShadowGraph({ now }).importData({ ...structuredClone(payload), relations: [relation] }), /endpoints must exist/);
});

// This build attributes no capture material: moved apart from its captures, a
// record could be purged under one owner while a capture of another still
// names it.
test('attribution refuses an origin that holds a capture, and a record a capture produced', () => {
  const { payload, decisionId } = captureStore();
  const graph = loaded(payload);
  const before = bytes(privilegedSnapshot(graph));
  const refused = (error) => error.code === 'attribution_capture_unsupported';
  assert.throws(() => graph.attribute({ originId: 'origin-b', targetProject: 'gamma', reason: 'Owner named the destination' }), refused);
  assert.throws(() => graph.attribute({ ids: [decisionId], targetProject: 'gamma', reason: 'Explicit move' }), refused, 'cap_extracted produced it');
  assert.equal(bytes(privilegedSnapshot(graph)), before, 'nothing moved');
  // An origin holding captures only is refused for what it holds, not as empty.
  const capturesOnly = loaded({ schemaVersion: 7, records: [captureItem('cap_lone', 'pending', { project: null, originId: 'origin-c' })] });
  assert.throws(() => capturesOnly.attribute({ originId: 'origin-c', targetProject: 'gamma', reason: 'r' }), refused);
  // A record a capture names anywhere, not only as produced, stays too.
  for (const field of ['receipts', 'supersededResults']) {
    const named = captureStore();
    const betaDecision = named.payload.records.find((item) => item.kind === 'decision' && item.project === 'beta');
    const capture = named.payload.records.find((item) => item.id === 'cap_beta');
    capture[field] = [{ recordIds: [betaDecision.id] }];
    for (const entry of named.payload.journal) if (entry.entityId === 'cap_beta') entry.payload[field] = structuredClone(capture[field]);
    named.payload.idempotency.find((item) => item.value.id === 'cap_beta').value[field] = structuredClone(capture[field]);
    assert.throws(() => loaded(named.payload).attribute({ ids: [betaDecision.id], targetProject: 'gamma', reason: 'r' }), refused, field);
  }
  // So does a decision one of whose alternatives a capture names.
  const withAlternative = createShadowGraph({ now });
  const chosen = withAlternative.addDecision({ project: 'beta', title: 'Queue', chosen: 'sqs', alternatives: [{ label: 'kafka' }] });
  withAlternative.importData({ schemaVersion: 7, records: [captureItem('cap_alt', 'pending', { project: 'beta', receipts: [{ alternativeId: chosen.alternatives[0].id }] })] });
  assert.throws(() => withAlternative.attribute({ ids: [chosen.id], targetProject: 'gamma', reason: 'r' }), refused);
  // Material no capture touches still moves.
  const beta = privilegedSnapshot(graph).records.find((item) => item.kind === 'decision' && item.project === 'beta');
  graph.attribute({ ids: [beta.id], targetProject: 'gamma', reason: 'Explicit move' });
  assert.equal(privilegedSnapshot(graph).records.find((item) => item.id === beta.id).project, 'gamma');
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(privilegedSnapshot(graph)), { now }));
});

// The four types are named only where they are read (src/internal/capture.js,
// src/journal.js) and by the writer (PR-34: recordCapture names the recording;
// every move's type comes from capture.js). Apart from the writer, the only
// code that journals one is import's journal-less normalisation of an item it
// was given (snapshotType). The scan covers src/ and scripts/.
test('no production code emits a capture journal type outside the writer', async () => {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(path);
    }
  };
  await walk(join(root, 'src'));
  await walk(join(root, 'scripts'));
  const naming = [];
  const usingTypes = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const name = file.slice(root.length).replaceAll('\\', '/');
    if (/['"`](?:capture\.recorded|capture\.state_changed|extraction\.completed|extraction\.failed)['"`]/.test(text)) naming.push(name);
    if (/CAPTURE_(?:IMPORT_TYPE|ENTRY_STATES|ENTRY_TYPES)\b/.test(text)) usingTypes.push(name);
  }
  assert.deepEqual(naming.sort(), ['src/internal/capture.js', 'src/journal.js', 'src/shadowgraph.js']);
  assert.deepEqual(usingTypes.sort(), ['src/internal/capture.js', 'src/journal.js', 'src/shadowgraph.js']);
  const kernel = await readFile(join(root, 'src', 'shadowgraph.js'), 'utf8');
  assert.deepEqual(kernel.match(/['"`](?:capture\.recorded|capture\.state_changed|extraction\.completed|extraction\.failed)['"`]/g), ["'capture.recorded'"], 'the writer names only the recording');
  // The kernel reads the types to hide their entries, and picks one only for
  // an imported item's journal-less snapshot.
  // Line endings follow the checkout (CRLF on a Windows clone).
  const importTypeUses = kernel.split(/\r?\n/).filter((line) => /CAPTURE_IMPORT_TYPE/.test(line));
  assert.equal(importTypeUses.length, 2, 'the import line and the one use');
  assert.match(importTypeUses[1], /^\s+if \(item\.kind === CAPTURE_KIND\) return Object\.hasOwn\(CAPTURE_IMPORT_TYPE, item\.state\)/);
  const entryTypeUses = kernel.split(/\r?\n/).filter((line) => /CAPTURE_ENTRY_TYPES/.test(line));
  assert.equal(entryTypeUses.length, 2, 'the import line and the scoped journal filter');
  assert.match(entryTypeUses[1], /return false;$/);
});

// Review round (tests lens, appendices A and B; correctness and contract
// findings): what the floor must also hold.

test('a relation to a capture arriving in the same import is refused, and nothing merges', () => {
  const { graph, decisionId } = seeded();
  const before = bytes(privilegedSnapshot(graph));
  assert.throws(() => graph.importData({ schemaVersion: 7, records: [captureItem('cap_rel', 'pending')], relations: [{ id: 'rel_same_payload', from: decisionId, to: 'cap_rel', relation: 'related_to', project: 'alpha' }] }), /endpoints must exist/);
  assert.equal(bytes(privilegedSnapshot(graph)), before);
});

test('SQLite: dropping only a capture collection entry is a destructive save', async (t) => {
  try { await import('node:sqlite'); } catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const { payload } = captureStore();
  const directory = await scratchDirectory(t, 'shadowgraph-capture-scrub-');
  const verdicts = [];
  const store = await createSqliteStore(join(directory, 'data.db'), { saveFault: (stage, context) => { if (stage === 'beforeCommit') verdicts.push(context.destructive); } });
  let revision = await store.save(structuredClone(payload));
  const withoutContent = { ...structuredClone(payload), captureContent: payload.captureContent.slice(1) };
  revision = await store.save({ ...withoutContent, expectedRevision: revision });
  const withoutSession = { ...withoutContent, captureSessions: payload.captureSessions.slice(1) };
  await store.save({ ...withoutSession, expectedRevision: revision });
  store.close();
  assert.deepEqual(verdicts, [false, true, true]);
});

test('SQLite erases a large capture text removed only from captureContent', async (t) => {
  try { await import('node:sqlite'); } catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const { payload } = captureStore();
  const file = join(await scratchDirectory(t, 'shadowgraph-capture-large-'), 'p.db');
  const marker = `gamma-large-${randomUUID()}`;
  const big = `${marker} ${'x'.repeat(40000)} ${marker}`;
  const graph = loaded({ ...structuredClone(payload), captureContent: [...payload.captureContent, { contentRef: 'content_gamma', project: 'gamma', attribution: 'project', originId: 'origin-a', text: big }] });
  const store = await createSqliteStore(file);
  const revision = await store.save(privilegedSnapshot(graph));
  graph.purgeProject('gamma');
  await store.save({ ...privilegedSnapshot(graph), expectedRevision: revision });
  store.close();
  for (const candidate of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    let held = null;
    try { held = await readFile(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (held) assert.equal(held.includes(Buffer.from(marker)), false, `${candidate} retained the text`);
  }
});

test('replaceData drops captures the new data does not hold', () => {
  const { payload } = captureStore();
  const graph = loaded(payload);
  graph.replaceData(withoutCapture(payload));
  const after = privilegedSnapshot(graph);
  assert.deepEqual(capturesOf(after), []);
  assert.doesNotMatch(JSON.stringify(after.records), /cap_/);
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(after), { now }));
});

test('no two entities share a token when one is a capture', () => {
  const { payload } = captureStore();
  assert.throws(() => createShadowGraph({ now }).importData({ schemaVersion: 7, records: [captureItem('cap_a', 'pending', { erasureToken: 'tok_same' }), captureItem('cap_b', 'pending', { erasureToken: 'tok_same' })] }), /share an erasureToken/);
  assert.throws(() => loaded(payload).importData({ schemaVersion: 7, records: [captureItem('cap_new', 'pending', { erasureToken: 'tok_cap_pending' })] }), /would share an erasureToken with cap_pending/);
  const graph = loaded({ schemaVersion: 7, records: [captureItem('cap_tok', 'pending', { erasureToken: 'tok-collide' })] });
  const original = crypto.randomUUID;
  let calls = 0;
  crypto.randomUUID = () => (calls++ < 3 ? 'tok-collide' : original());
  syncBuiltinESMExports();
  try {
    const decision = graph.addDecision({ project: 'alpha', title: 'Fresh', chosen: 'yes' });
    assert.ok(calls > 0, 'precondition: the stub was reached');
    assert.notEqual(privilegedSnapshot(graph).records.find((item) => item.id === decision.id).erasureToken, 'tok-collide');
  } finally { crypto.randomUUID = original; syncBuiltinESMExports(); }
  assert.doesNotThrow(() => validateRestorePayload(privilegedSnapshot(graph), { now }));
});

test('every capture field check refuses its own malformation', () => {
  for (const [label, mutate] of [
    ['an empty erasureToken', (item) => { item.erasureToken = ''; }],
    ['negative attempts', (item) => { item.attempts = -1; }],
    ['a receipt that is not an object', (item) => { item.receipts = ['r']; }],
    ['a superseded result that is not an object', (item) => { item.supersededResults = [null]; }],
    ['a blank sourceIdentity', (item) => { item.sourceIdentity = ' '; }],
    ['a duplicate of itself', (item) => { item.possibleDuplicateOf = item.id; }],
    ['an empty source role', (item) => { item.source.role = ''; }],
    ['a negative turnIndex', (item) => { item.source.turnIndex = -1; }],
    ['a produced record twice', (item) => { item.producedRecordIds = ['rec_1', 'rec_1']; }],
    ['a project attribution with a blank project', (item) => { item.project = ' '; }],
    ['an empty contentRef', (item) => { item.contentRef = ''; }],
    ['a blank lastError', (item) => { item.state = 'failed'; item.lastError = ' '; }],
    ['an expiresAt that is not an instant', (item) => { item.expiresAt = 'soon'; }],
    ['an updatedAt that is not an instant', (item) => { item.updatedAt = null; }]
  ]) {
    const payload = { schemaVersion: 7, records: [captureItem('cap_bad', 'pending')] };
    mutate(payload.records[0]);
    assert.throws(() => createShadowGraph({ now }).importData(structuredClone(payload)), /records\[0\](?: is not a well-formed capture item|\.project must be a non-empty string or null)/, label);
  }
});

test('a future capture entry or item is never judged by this reader', () => {
  const futureItem = { ...captureItem('cap_f', 'queued'), schemaVersion: 8 };
  for (const [label, entry] of [
    ['future entry, current item', { ...captureEntry(captureItem('cap_f', 'extracted'), 'capture.recorded', 1), schemaVersion: 8 }],
    ['current entry, future item', captureEntry(futureItem, 'capture.recorded', 1)]
  ]) {
    assert.equal(journalEntryPostconditionIssue(entry), null, label);
    const report = rebuildProjection([entry], { journalEpoch: 1 });
    assert.equal(report.skipped.some((skip) => skip.why === 'type_payload_postcondition_mismatch'), false, `${label}: ${JSON.stringify(report.skipped)}`);
  }
  // Control: the same current entry with a current item is judged.
  assert.match(journalEntryPostconditionIssue(captureEntry(captureItem('cap_f', 'extracted'), 'capture.recorded', 1)) ?? '', /leaves an item pending or blocked, not extracted/);
});

test('a malformed capture inside a projection.baseline is refused', () => {
  const first = createShadowGraph({ now });
  first.importData({ schemaVersion: 7, records: [captureItem('cap_base', 'pending')] });
  const snapshot = structuredClone(privilegedSnapshot(first));
  const baseline = snapshot.journal.find((entry) => entry.type === 'projection.baseline');
  assert.ok(baseline.payload.records.some((item) => item.id === 'cap_base'), 'precondition: the baseline holds the capture');
  baseline.payload.records.find((item) => item.id === 'cap_base').state = 'excluded';
  assert.throws(() => createShadowGraph({ now }).importData(structuredClone(snapshot)), /projection\.baseline payload/);
  assert.throws(() => validateRestorePayload(structuredClone(snapshot), { now }), /projection\.baseline payload/);
});

test('a journal-less re-import of unchanged captures writes no entry', () => {
  const { graph: base, decisionId } = seeded();
  const records = plan(decisionId).map(([id, states, overrides]) => captureItem(id, states.at(-1), overrides));
  const graph = createShadowGraph({ now });
  graph.importData({ schemaVersion: 7, records: [structuredClone(privilegedSnapshot(base).records[0])] });
  graph.importData({ schemaVersion: 7, records: structuredClone(records) });
  const before = bytes(privilegedSnapshot(graph).journal);
  graph.importData({ schemaVersion: 7, records: structuredClone(records) });
  assert.equal(bytes(privilegedSnapshot(graph).journal), before);
});

test('no fact, relation or alternative may take a capture id', () => {
  const { payload } = captureStore();
  const donor = createShadowGraph({ now });
  const decision = donor.addDecision({ project: 'alpha', title: 'Alt', chosen: 'a', alternatives: [{ label: 'b' }] });
  const record = structuredClone(privilegedSnapshot(donor).records.find((item) => item.id === decision.id));
  record.alternatives[0].id = 'cap_pending';
  const graph = loaded(payload);
  const before = bytes(privilegedSnapshot(graph));
  assert.throws(() => graph.importData({ schemaVersion: 7, records: [record] }), /already exists: cap_pending/);
  const fact = donor.addFact({ project: 'alpha', key: 'k', value: 'v' });
  const factItem = { ...structuredClone(privilegedSnapshot(donor).facts.find((item) => item.id === fact.id)), id: 'cap_pending' };
  assert.throws(() => graph.importData({ schemaVersion: 7, facts: [factItem] }), /already exists: cap_pending/);
  const decisionId = privilegedSnapshot(graph).records.find((item) => item.kind === 'decision' && item.project === 'alpha').id;
  assert.throws(() => graph.importData({ schemaVersion: 7, relations: [{ id: 'cap_pending', from: decisionId, to: decisionId, relation: 'related_to', project: 'alpha' }] }), /already exists: cap_pending/);
  assert.equal(bytes(privilegedSnapshot(graph)), before);
});

test('a journal-less import into a capture-bearing store keeps captures in its baseline and retry map', () => {
  const { payload } = captureStore();
  const graph = loaded(payload);
  const retry = payload.idempotency.find((item) => item.value.kind === 'capture');
  assert.doesNotThrow(() => graph.importData({ schemaVersion: 7, idempotency: [structuredClone(retry)] }), 'a capture retry value alone merges');
  const donor = createShadowGraph({ now });
  donor.addDecision({ project: 'alpha', title: 'Imported later', chosen: 'x' });
  graph.importData({ schemaVersion: 7, records: structuredClone(privilegedSnapshot(donor).records) });
  const live = privilegedSnapshot(graph);
  const baseline = live.journal.findLast((entry) => entry.type === 'projection.baseline');
  assert.ok(baseline, 'precondition: the first journal-less import wrote a baseline');
  assert.deepEqual(byId(baseline.payload.records.filter((item) => item.kind === 'capture')), capturesOf(live));
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(byId(rebuilt.projection.records), byId(live.records));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(live), { now }));
});

test('by-id reads and writes treat a capture id as unknown', () => {
  const { payload, decisionId } = captureStore();
  const graph = loaded(payload);
  const twin = loaded(withoutCapture(payload));
  const answer = (read) => { try { return { value: read() }; } catch (error) { return { error: error.message }; } };
  const alpha = captureBlock({ pending: 1, processing: 1, failed: 1, blocked: 1 });
  for (const id of CAPTURE_IDS) {
    for (const [name, call] of [
      ['expand', (g) => g.expand({ recordId: id, project: 'alpha', digest: 'x' })],
      ['memoryHistory', (g) => g.memoryHistory({ id, project: 'alpha' })],
      ['attribute ids', (g) => g.attribute({ ids: [id], targetProject: 'gamma', reason: 'r' })],
      ['link', (g) => g.link({ from: decisionId, to: id, relation: 'related_to', project: 'alpha' })],
      ['status', (g) => g.updateDecisionStatus(id, 'validated', { project: 'alpha' })],
      ['outcome', (g) => g.setOutcome(id, 'successful', { project: 'alpha' })]
    ]) assert.deepEqual(answer(() => call(graph)), withDeclaration(answer(() => call(twin)), alpha), `${name} ${id}`);
  }
  for (const [name, call] of [
    ['review', (g) => g.review({ project: 'alpha' })],
    ['getReviewSignals', (g) => g.getReviewSignals({ project: 'alpha' })],
    ['repairPlan', (g) => g.repairPlan({ project: 'alpha' })],
    ['legacyAttributionReview', (g) => g.legacyAttributionReview({})]
  ]) {
    const seen = answer(() => call(graph));
    assert.doesNotMatch(JSON.stringify(seen), LEAK, name);
    assert.deepEqual(seen, withDeclaration(answer(() => call(twin)), alpha), name);
  }
});

test('a memory-only JSON restore keeps every capture and collection', async (t) => {
  const { payload } = captureStore();
  const directory = await scratchDirectory(t, 'shadowgraph-capture-memonly-');
  const source = join(directory, 'backup.json');
  const destination = join(directory, 'data.json');
  await writeFile(source, JSON.stringify(payload, null, 2));
  const live = createShadowGraph({ now });
  await restoreFile(source, destination, { memoryOnly: true, afterReplace: (restored) => live.replaceData(restored) });
  const installed = JSON.parse(await readFile(destination, 'utf8'));
  assert.deepEqual(capturesOf(installed), capturesOf(payload));
  assert.equal(bytes(installed.captureContent), bytes(payload.captureContent));
  assert.equal(bytes(installed.captureSessions), bytes(payload.captureSessions));
});

// A store in the shape the deletion PR-37 writes: one capture deleted, its
// entries left as capture_deleted skeletons, its item, retry value and text gone.
function deletedStore() {
  const { payload } = captureStore();
  for (const entry of payload.journal.filter((item) => item.entityId === 'cap_blocked')) {
    for (const key of Object.keys(entry)) if (!['id', 'seq', 'type', 'at', 'project', 'entityKind', 'schemaVersion'].includes(key)) delete entry[key];
    Object.assign(entry, { entityId: null, payload: null, redacted: true, redactedReason: 'capture_deleted', provenance: { actor: null, client: null, sessionId: null } });
  }
  payload.records = payload.records.filter((item) => item.id !== 'cap_blocked');
  payload.idempotency = payload.idempotency.filter((item) => item.value.id !== 'cap_blocked');
  payload.captureContent = payload.captureContent.filter((item) => item.contentRef !== 'content_cap_blocked');
  return payload;
}

test('a store holding capture_deleted skeletons loads, rebuilds, restores and keeps the reason through a purge', async (t) => {
  const payload = deletedStore();
  const graph = loaded(payload);
  assert.equal(privilegedValidate(graph).valid, true, JSON.stringify(privilegedValidate(graph).issues));
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(rebuilt.skipped, []);
  assert.deepEqual(byId(rebuilt.projection.records), byId(privilegedSnapshot(graph).records));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(payload), { now }));
  assert.doesNotMatch(JSON.stringify(graph.getJournal({ project: 'alpha' })), LEAK);
  // The reason stays a capture's own.
  const misused = structuredClone(payload);
  Object.assign(misused.journal.find((entry) => entry.type === 'decision.recorded'), { entityId: null, payload: null, redacted: true, redactedReason: 'capture_deleted', provenance: { actor: null, client: null, sessionId: null } });
  assert.throws(() => createShadowGraph({ now }).importData(misused), /noncanonical redactedReason/);
  // A logical purge of the project keeps the deleted capture's reason.
  const deletedSequences = payload.journal.filter((entry) => entry.redactedReason === 'capture_deleted').map((entry) => entry.seq);
  graph.purgeProject('alpha');
  const after = privilegedSnapshot(graph);
  assert.deepEqual(after.journal.filter((entry) => deletedSequences.includes(entry.seq)).map((entry) => entry.redactedReason), deletedSequences.map(() => 'capture_deleted'));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(after), { now }));
  try { await import('node:sqlite'); } catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return; }
  const file = join(await scratchDirectory(t, 'shadowgraph-capture-deleted-'), 'data.db');
  const store = await createSqliteStore(file);
  await store.save(structuredClone(payload));
  store.close();
  const reopened = await createSqliteStore(file);
  const reloaded = await reopened.load();
  reopened.close();
  assert.doesNotThrow(() => validateRestorePayload(reloaded, { now }));
});

// A capture's attribution is read as any entity's is (entity.attributed), so a
// later build that attributes one needs no further reader. This build writes none.
test('an entity.attributed entry moving a capture to a project folds, and stays out of every public read', () => {
  const { payload } = captureStore();
  const origin = payload.records.find((item) => item.id === 'cap_origin');
  const moved = { ...structuredClone(origin), project: 'gamma', attribution: 'project' };
  payload.journal.push({
    id: 'jentry_capture_attributed', seq: payload.journalSeq + 1, type: 'entity.attributed', at: NOW, project: 'gamma', entityKind: 'capture', entityId: 'cap_origin',
    schemaVersion: 7, payload: { ...structuredClone(moved), attributionChange: { previousProject: null, previousAttribution: 'unattributed', reason: 'user' } }, provenance: { actor: null, client: null, sessionId: null }
  });
  payload.journalSeq += 1;
  payload.records = payload.records.map((item) => (item.id === 'cap_origin' ? moved : item));
  const retry = payload.idempotency.find((item) => item.value.id === 'cap_origin');
  retry.key = 'capture:gamma:cap_origin';
  retry.value = structuredClone(moved);
  const graph = loaded(payload);
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(rebuilt.skipped, []);
  assert.deepEqual(byId(rebuilt.projection.records), byId(privilegedSnapshot(graph).records));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(payload), { now }));
  for (const read of [(g) => g.getJournal({ project: 'gamma' }), (g) => g.search('', { project: 'gamma' }), (g) => g.rebuild({ project: 'gamma' }), (g) => g.stats({ project: 'gamma' })]) assert.doesNotMatch(JSON.stringify(read(graph)), LEAK);
  graph.purgeProject('gamma');
  assert.equal(capturesOf(privilegedSnapshot(graph)).some((item) => item.id === 'cap_origin'), false, 'the moved capture goes with its project');
  // A malformed capture under the type is refused.
  const broken = structuredClone(payload);
  delete broken.journal.at(-1).payload.erasureToken;
  assert.throws(() => createShadowGraph({ now }).importData(broken), /entity\.attributed carries no well-formed capture item/);
});

// FND-P3-03: a future entity.attributed entry is carried, as a future
// entity.token_assigned entry is, whatever it names.
test('a future entity.attributed entry naming a kind this build does not know is carried, and blocks restore', () => {
  const { payload } = captureStore();
  const entry = {
    id: 'jentry_future_attributed', seq: payload.journalSeq + 1, type: 'entity.attributed', at: NOW, project: 'alpha', entityKind: 'insight', entityId: 'ins_1',
    schemaVersion: 8, payload: { id: 'ins_1', kind: 'insight', project: 'alpha', schemaVersion: 8, attributionChange: { reason: 'user' } }, provenance: { actor: null, client: null, sessionId: null }
  };
  payload.journal.push(entry);
  payload.journalSeq += 1;
  const graph = loaded(payload);
  assert.equal(bytes(privilegedSnapshot(graph).journal.at(-1)), bytes(entry), 'carried verbatim');
  assert.throws(() => validateRestorePayload(structuredClone(payload), { now }), /Refusing to restore data/);
});

test('a capture is carried only by a store that declares its schema, and only with a project or none', () => {
  for (const [label, source] of [
    ['a store with no schema', { records: [captureItem('cap_old', 'pending')] }],
    ['a bare array', [captureItem('cap_old', 'pending')]]
  ]) assert.throws(() => createShadowGraph({ now }).importData(structuredClone(source)), /records\[0\] is a capture item, which only a store that declares its schemaVersion carries/, label);
  // Even an item of a future schema must name its project as a string, or none.
  const future = { ...captureItem('cap_future', 'queued'), schemaVersion: 8, project: 42 };
  assert.throws(() => createShadowGraph({ now }).importData({ schemaVersion: 7, records: [future] }), /records\[0\]\.project must be a non-empty string or null/);
});

// A legacy envelope may carry capture: replay() imports a store's fold at its
// lowest entity version, which a relation written before schema 5 sets. Its
// migrations never rename a capture, and no relation may name one.
test('a legacy envelope renames no capture and lets no relation name one', () => {
  const legacyDecision = { id: 'cap_shared', kind: 'decision', schemaVersion: 3, project: 'alpha', title: 'A', chosen: 'x', status: 'active', createdAt: NOW, updatedAt: NOW };
  const graph = createShadowGraph({ now });
  graph.importData({ schemaVersion: 3, records: [captureItem('cap_shared', 'pending'), legacyDecision] });
  const live = privilegedSnapshot(graph);
  assert.equal(live.records.find((item) => item.id === 'cap_shared').kind, 'capture', 'the capture keeps its id');
  assert.equal(live.records.filter((item) => item.kind === 'decision').length, 1, 'the colliding legacy decision is renamed');
  const { payload } = captureStore();
  const decisionId = payload.records.find((item) => item.kind === 'decision' && item.project === 'alpha').id;
  const store = loaded(payload);
  const before = bytes(privilegedSnapshot(store));
  const relation = { id: 'rel_legacy', kind: 'relation', schemaVersion: 3, from: decisionId, to: 'cap_pending', relation: 'related_to', createdAt: NOW };
  assert.throws(() => store.importData({ schemaVersion: 3, relations: [relation] }), /a capture item is never one/);
  assert.throws(() => createShadowGraph({ now }).importData({ schemaVersion: 3, records: [captureItem('cap_pending', 'pending'), { ...legacyDecision, id: decisionId }], relations: [relation] }), /a capture item is never one/);
  assert.equal(bytes(privilegedSnapshot(store)), before);
  // Nor may a relation the store already holds come to name a capture.
  const dangling = createShadowGraph({ now });
  dangling.importData({ schemaVersion: 3, records: [{ ...legacyDecision, id: 'dec_z' }], relations: [{ ...relation, from: 'dec_z', to: 'cap_z' }] });
  const held = bytes(privilegedSnapshot(dangling));
  for (const schemaVersion of [7, 3]) assert.throws(() => dangling.importData({ schemaVersion, records: [captureItem('cap_z', 'pending')] }), /a capture item is never one/, `schema ${schemaVersion}`);
  assert.equal(bytes(privilegedSnapshot(dangling)), held);
});

test('a store holding pre-schema-5 material and a capture rebuilds and restores as its capture-free twin does', () => {
  // A relation as a schema-4 build wrote it, live and in the journal.
  const graph = createShadowGraph({ now });
  const a = graph.addDecision({ project: 'alpha', title: 'A', chosen: 'x' });
  const b = graph.addDecision({ project: 'alpha', title: 'B', chosen: 'y' });
  graph.link({ from: a.id, to: b.id, relation: 'related_to', project: 'alpha' });
  const base = structuredClone(privilegedSnapshot(graph));
  for (const relation of base.relations) relation.schemaVersion = 4;
  for (const entry of base.journal) if (entry.type === 'relation.created') entry.payload.schemaVersion = 4;
  const item = captureItem('cap_legacy', 'pending');
  const withCapture = structuredClone(base);
  withCapture.records.push(item);
  withCapture.journal.push(captureEntry(item, 'capture.recorded', withCapture.journalSeq + 1));
  withCapture.journalSeq += 1;
  // And a journal-less schema-3 store loaded here, then given a capture.
  const legacy = createShadowGraph({ now });
  legacy.importData({
    schemaVersion: 3,
    records: [
      { id: 'dec_a', kind: 'decision', schemaVersion: 3, project: 'alpha', title: 'A', chosen: 'x', status: 'active', createdAt: NOW, updatedAt: NOW },
      { id: 'dec_b', kind: 'decision', schemaVersion: 3, project: 'alpha', title: 'B', chosen: 'y', status: 'active', createdAt: NOW, updatedAt: NOW }
    ],
    relations: [{ id: 'rel_ab', kind: 'relation', schemaVersion: 3, from: 'dec_a', to: 'dec_b', relation: 'related_to', createdAt: NOW }]
  });
  const legacyTwin = loaded(privilegedSnapshot(legacy));
  legacy.importData({ schemaVersion: 7, records: [captureItem('cap_merged', 'pending')] });
  for (const [label, store, twin] of [['a schema-4 relation', loaded(withCapture), loaded(base)], ['a journal-less schema-3 store', legacy, legacyTwin]]) {
    const rebuilt = privilegedRebuild(store);
    assert.equal(rebuilt.rebuildable, true, `${label}: ${rebuilt.reason} ${JSON.stringify(rebuilt.skipped)}`);
    assert.deepEqual(byId(rebuilt.projection.records), byId(privilegedSnapshot(store).records), label);
    assert.doesNotThrow(() => validateRestorePayload(structuredClone(privilegedSnapshot(store)), { now }), label);
    assert.deepEqual(store.rebuild({ project: 'alpha' }), withDeclaration(twin.rebuild({ project: 'alpha' }), captureBlock({ pending: 1 })), `${label}: the public rebuild answers as the twin, with its capture declared`);
  }
});

// A capture changes owner only through entity.attributed. A purge of the
// project it left keeps its history, as it keeps a moved record's.
for (const mode of ['logical', 'hard']) {
  test(`a ${mode} purge of the project a capture left keeps the capture's history and a restorable store`, () => {
    const { payload } = captureStore();
    const pending = payload.records.find((item) => item.id === 'cap_pending');
    const moved = { ...structuredClone(pending), project: 'gamma' };
    payload.journal.push({
      id: 'jentry_capture_moved', seq: payload.journalSeq + 1, type: 'entity.attributed', at: NOW, project: 'gamma', entityKind: 'capture', entityId: 'cap_pending',
      schemaVersion: 7, payload: { ...structuredClone(moved), attributionChange: { previousProject: 'alpha', previousAttribution: 'project', reason: 'user' } }, provenance: { actor: null, client: null, sessionId: null }
    });
    payload.journalSeq += 1;
    payload.records = payload.records.map((item) => (item.id === 'cap_pending' ? moved : item));
    const retry = payload.idempotency.find((item) => item.value.id === 'cap_pending');
    retry.key = 'capture:gamma:cap_pending';
    retry.value = structuredClone(moved);
    const graph = loaded(payload);
    const history = payload.journal.filter((entry) => entry.entityId === 'cap_pending').map((entry) => entry.seq);
    graph.purgeProject('alpha', { mode });
    const after = privilegedSnapshot(graph);
    assert.equal(capturesOf(after).some((item) => item.id === 'cap_pending'), true);
    assert.deepEqual(after.journal.filter((entry) => entry.entityId === 'cap_pending').map((entry) => entry.seq), history, 'every entry of the moved capture is kept');
    assert.doesNotThrow(() => validateRestorePayload(structuredClone(after), { now }));
  });
}

test('a merge import joins capture collections by key and never drops another capture\'s text', () => {
  const { payload } = captureStore();
  const graph = loaded(payload);
  const added = { contentRef: 'content_new', project: 'alpha', attribution: 'project', originId: 'origin-a', text: 'new' };
  graph.importData({ schemaVersion: 7, captureContent: [added] });
  assert.deepEqual(privilegedSnapshot(graph).captureContent.map((item) => item.contentRef), [...payload.captureContent.map((item) => item.contentRef), 'content_new']);
  // A second session record for one origin session is refused, and nothing changes.
  const before = bytes(privilegedSnapshot(graph));
  assert.throws(() => graph.importData({ schemaVersion: 7, captureSessions: [{ ...payload.captureSessions[0], id: 'session_again' }] }), /capture_collection_malformed/);
  assert.equal(bytes(privilegedSnapshot(graph)), before);
  // The same key replaces its own entry, and never with another owner.
  graph.importData({ schemaVersion: 7, captureContent: [{ ...added, text: 'newer' }] });
  assert.equal(privilegedSnapshot(graph).captureContent.find((item) => item.contentRef === 'content_new').text, 'newer');
  const held = bytes(privilegedSnapshot(graph));
  for (const extra of [
    { captureContent: [{ ...added, project: 'gamma' }] },
    { captureContent: [{ ...added, attribution: 'unattributed', project: null }] },
    { captureContent: [{ ...added, originId: 'origin-z' }] },
    { captureSessions: [{ ...payload.captureSessions[0], project: 'gamma' }] },
    { captureSessions: [{ ...payload.captureSessions[0], sessionId: 'session-other' }] }
  ]) assert.throws(() => graph.importData({ schemaVersion: 7, ...extra }), /would change the owner of an entry the store holds/, JSON.stringify(extra));
  assert.equal(bytes(privilegedSnapshot(graph)), held);
});

test('a query naming a capture id is a query naming an entity, and leaves no runtime miss', () => {
  const { payload } = captureStore();
  const misses = (g) => privilegedSnapshot(g).runtimeMisses ?? [];
  const graph = loaded(payload);
  const twin = loaded(withoutCapture(payload));
  graph.context({ project: 'alpha', query: 'cap_pending' });
  twin.context({ project: 'alpha', query: 'cap_pending' });
  assert.ok(misses(twin).length > 0, 'control: where nothing holds the id, the query is an ordinary one');
  assert.equal(misses(graph).length, 0);
});

test('a journal-less import of a future capture in a state named like an object key journals it plainly', () => {
  const graph = createShadowGraph({ now });
  graph.importData({ schemaVersion: 7, records: [captureItem('cap_seed', 'pending')] });
  const odd = { ...captureItem('cap_odd', 'pending'), schemaVersion: 8, state: 'constructor' };
  assert.doesNotThrow(() => graph.importData({ schemaVersion: 7, records: [odd] }));
  assert.equal(privilegedSnapshot(graph).journal.at(-1).type, 'capture.state_changed');
});
