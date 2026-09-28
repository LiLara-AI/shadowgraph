// Plan v1.4.4 PR-20 (§9.2, §9.4, §9.6 step 1; plan rev6 §3.2): the reader is
// widened to schema 7 and ships before any writer produces it, so this build is
// the floor every later P3 build can fall back to. It accepts the v7 envelope,
// entities and journal entries; enforces the claim model's closed vocabularies
// and cross-field rules at import and restore; carries every other v7 field
// verbatim; replays entity.token_assigned only when it adds a token to a
// tokenless entity; never returns an entity's erasureToken from a public read;
// and keeps an unrecognised top-level collection byte-equal. The writer stays at
// schema 6.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenFree } from '../tools/token-free.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph, SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS } from '../src/shadowgraph.js';
import { JOURNAL_SCHEMA_VERSION, READABLE_JOURNAL_SCHEMA_VERSION, REPLAYABLE_ENTRY_TYPES } from '../src/journal.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { restoreFile } from '../src/backup.js';
import { downgradeStore, downgradeToSchema5, downgradeToSchema6 } from '../src/schema-conversion.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { privilegedIssueAccess, privilegedRebuild, privilegedSnapshot, privilegedValidate } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const src = fileURLToPath(new URL('../src', import.meta.url));
const FUTURE = { opaque: [{ id: 'f1', nested: { values: [1, 'two', null, true] } }], note: 'a collection this build does not know' };
const bytes = (value) => JSON.stringify(value);
const byId = (items) => [...items].sort((left, right) => String(left.id).localeCompare(String(right.id)));

// Every §9.4 field on one attempt, including the optional shape PR-22's
// verifier records (rule, readings, span, checks, verifierVersion) and a field
// this build does not know, which it must carry through untouched.
const V7_ATTEMPT_FIELDS = Object.freeze({
  claims: [
    { text: 'the migration did not complete', class: 'quoted', sourceRef: 'capture:c1', span: { start: 0, end: 30 }, checks: { quantifier: 'consistent', polarity: 'consistent', actor: 'consistent', time: 'consistent', scope: 'consistent', modality: 'consistent' }, verifierVersion: 'verifier-v1', futureField: { kept: true } },
    { text: 'the lock timed out before the migration completed', class: 'entailed', rule: 'temporal-precedence-v1', sourceRef: 'capture:c1', checks: {}, verifierVersion: 'verifier-v1' },
    { text: 'the job stopped', class: 'ambiguous', readings: ['stopped by the user', 'stopped by a crash'], sourceRef: 'capture:c1', verifierVersion: 'verifier-v1' }
  ],
  causalClaim: { statement: 'the lock timed out', class: 'entailed', sourceClass: 'tool_observed', evidence: [{ sourceRef: 'capture:c1' }], state: 'recorded' },
  captureRef: 'capture:c1',
  outcomeEvidence: { state: 'observed', source: 'exit_status', exitStatus: 1 },
  erasureToken: 'tok_attempt_1'
});

function seeded() {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'Cache', chosen: 'redis' });
  graph.addAttempt({ project: 'alpha', solution: 'online migration', result: 'failed: lock timeout', resultClass: 'failed', idempotencyKey: 'attempt-1' });
  graph.addFact({ project: 'alpha', key: 'latency', value: 10 });
  graph.addDecision({ project: 'beta', title: 'Wider', chosen: 'x' });
  return graph;
}

// A store a schema-7 writer produced: schema 7 throughout, the v7 fields on the
// attempt everywhere it appears (live record, idempotency value, journal
// payloads), and a token on every entity.
function v7Store(fields = V7_ATTEMPT_FIELDS) {
  const payload = structuredClone(privilegedSnapshot(seeded()));
  payload.schemaVersion = 7;
  const attemptId = payload.records.find((record) => record.kind === 'attempt').id;
  const upgrade = (entity) => {
    if (!entity || !['decision', 'attempt', 'memory', 'fact'].includes(entity.kind)) return;
    entity.schemaVersion = 7;
    entity.erasureToken ??= `tok_${entity.id}`;
    if (entity.id === attemptId) Object.assign(entity, structuredClone(fields));
  };
  for (const entity of [...payload.records, ...payload.facts]) upgrade(entity);
  for (const item of payload.idempotency) upgrade(item.value);
  for (const entry of payload.journal) { entry.schemaVersion = 7; upgrade(entry.payload); }
  return { payload, attemptId };
}
const attemptCopies = (payload) => [...payload.records, ...payload.idempotency.map((item) => item.value), ...payload.journal.map((entry) => entry.payload)].filter((entity) => entity?.kind === 'attempt');

// PR-20 read schema 7 while it wrote 6; PR-21 raised the writer to meet it.
test('the reader reads schema 7, which the writer now writes', () => {
  assert.equal(SCHEMA_VERSION, 7);
  assert.deepEqual(SUPPORTED_SCHEMA_VERSIONS, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(JOURNAL_SCHEMA_VERSION, 7);
  assert.equal(READABLE_JOURNAL_SCHEMA_VERSION, 7);
  assert.ok(REPLAYABLE_ENTRY_TYPES.includes('entity.token_assigned'));
  const snapshot = privilegedSnapshot(seeded());
  assert.equal(snapshot.schemaVersion, 7);
  assert.deepEqual([...new Set([...snapshot.records, ...snapshot.facts, ...snapshot.journal].map((item) => item.schemaVersion))], [7]);
  assert.equal([...snapshot.records, ...snapshot.facts].every((entity) => typeof entity.erasureToken === 'string'), true, 'every entity it writes carries a token');
});

test('a schema-7 store loads, validates, rebuilds and restores, and keeps every v7 field', () => {
  const { payload, attemptId } = v7Store();
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  const validation = privilegedValidate(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(validation.counts.unsupported, 0);
  const live = privilegedSnapshot(graph);
  const attempt = live.records.find((record) => record.id === attemptId);
  for (const [key, value] of Object.entries(V7_ATTEMPT_FIELDS)) assert.equal(bytes(attempt[key]), bytes(value), key);
  assert.equal(attempt.schemaVersion, 7, 'never downgraded');
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(rebuilt.skipped, []);
  assert.deepEqual(byId(rebuilt.projection.records), byId(live.records));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(payload), { now }));
});

test('JSON and SQLite: v7 fields and an unrecognised collection survive load, save and reload byte-equal', async (t) => {
  const { payload, attemptId } = v7Store();
  const directory = await scratchDirectory(t, 'shadowgraph-v7-');
  const file = join(directory, 'data.json');
  await writeFile(file, JSON.stringify({ ...payload, futureCollection: FUTURE }, null, 2));
  const store = createJsonFileStore(file);
  const graph = createShadowGraph({ now });
  graph.importData(await store.load());
  graph.addDecision({ project: 'alpha', title: 'After reload', chosen: 'yes' });
  await store.save(privilegedSnapshot(graph));
  const reloaded = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(bytes(reloaded.futureCollection), bytes(FUTURE));
  const attempt = reloaded.records.find((record) => record.id === attemptId);
  for (const [key, value] of Object.entries(V7_ATTEMPT_FIELDS)) assert.equal(bytes(attempt[key]), bytes(value), `JSON: ${key}`);

  const run = spawnSync(process.execPath, [cli, 'decision', JSON.stringify({ project: 'alpha', title: 'Through the CLI', chosen: 'yes' })], { env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const afterCli = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(bytes(afterCli.futureCollection), bytes(FUTURE), 'CLI save');
  assert.equal(bytes(afterCli.records.find((record) => record.id === attemptId).claims), bytes(V7_ATTEMPT_FIELDS.claims), 'CLI save');

  try { await import('node:sqlite'); } catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return; }
  const sqliteFile = join(directory, 'data.db');
  const first = await createSqliteStore(sqliteFile);
  await first.save({ ...payload, futureCollection: FUTURE });
  first.close();
  const reopened = await createSqliteStore(sqliteFile);
  const sqliteGraph = createShadowGraph({ now });
  sqliteGraph.importData(await reopened.load());
  sqliteGraph.addDecision({ project: 'alpha', title: 'After reopen', chosen: 'yes' });
  await reopened.save(privilegedSnapshot(sqliteGraph));
  reopened.close();
  const again = await createSqliteStore(sqliteFile);
  const loaded = await again.load();
  again.close();
  assert.equal(bytes(loaded.futureCollection), bytes(FUTURE));
  const sqliteAttempt = loaded.records.find((record) => record.id === attemptId);
  for (const [key, value] of Object.entries(V7_ATTEMPT_FIELDS)) assert.equal(bytes(sqliteAttempt[key]), bytes(value), `SQLite: ${key}`);
});

// The real restore primitives of both backends install a v7 backup unchanged
// and activate a graph that rebuilds to it.
test('JSON and SQLite: a v7 backup restores through the backend primitive with every v7 field intact', async (t) => {
  const { payload, attemptId } = v7Store();
  const directory = await scratchDirectory(t, 'shadowgraph-v7-restore-');
  const check = (installed, live, label) => {
    const attempt = installed.records.find((record) => record.id === attemptId);
    assert.equal(attempt.schemaVersion, 7, label);
    for (const [key, value] of Object.entries(V7_ATTEMPT_FIELDS)) assert.equal(bytes(attempt[key]), bytes(value), `${label}: ${key}`);
    const rebuilt = privilegedRebuild(live);
    assert.equal(rebuilt.rebuildable, true, `${label}: ${rebuilt.reason}`);
    assert.deepEqual(byId(rebuilt.projection.records), byId(privilegedSnapshot(live).records), label);
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

test('a schema-8 envelope is refused; a schema-8 entity loads verbatim but its store cannot be restored', () => {
  assert.throws(() => createShadowGraph().importData({ schemaVersion: 8, records: [] }), (error) => error.code === 'unsupported_schema_version');
  const { payload, attemptId } = v7Store();
  // A vocabulary this build does not know: a future entity is carried, never judged.
  const futureClaims = [{ text: 'x', class: 'inferred_v8' }];
  for (const entity of attemptCopies(payload)) Object.assign(entity, { schemaVersion: 8, claims: structuredClone(futureClaims) });
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  const kept = privilegedSnapshot(graph).records.find((record) => record.id === attemptId);
  assert.equal(kept.schemaVersion, 8, 'preserved verbatim');
  assert.equal(bytes(kept.claims), bytes(futureClaims), 'future claims preserved verbatim');
  assert.ok(privilegedValidate(graph).issues.some((issue) => issue.code === 'unsupported_record_schema_version' && issue.severity === 'unsupported'));
  assert.throws(() => validateRestorePayload(structuredClone(payload), { now }), /Refusing to restore data: .*unsupported_record_schema_version/);

  // A future entry is future by its own version even when its payload has none.
  const entryOnly = v7Store().payload;
  const entry = entryOnly.journal.find((item) => item.payload?.kind === 'attempt');
  entry.schemaVersion = 8;
  delete entry.payload.schemaVersion;
  entry.payload.claims = structuredClone(futureClaims);
  assert.doesNotThrow(() => createShadowGraph({ now }).importData(entryOnly));
});

// Future data is carried wherever it sits: a fact, an entity inside a baseline,
// a whole baseline entry, and a future entity.token_assigned entry naming a kind
// or a shape this build does not know.
test('future data is carried verbatim in every position, never judged by the v7 rules', () => {
  const futureClaims = [{ text: 'x', class: 'inferred_v8' }];
  const cases = [
    ['a fact', (payload) => {
      const factId = payload.facts[0].id;
      const copies = [payload.facts[0], ...payload.idempotency.map((item) => item.value), ...payload.journal.map((item) => item.payload)].filter((entity) => entity?.id === factId);
      for (const entity of copies) Object.assign(entity, { schemaVersion: 8, claims: structuredClone(futureClaims) });
    }],
    ['an entity inside a baseline', (payload) => {
      Object.assign(payload, v7BaselineStore());
      Object.assign(payload.journal[0].payload.records.find((record) => record.kind === 'attempt'), { schemaVersion: 8, claims: structuredClone(futureClaims) });
    }],
    ['a whole baseline entry', (payload) => {
      Object.assign(payload, v7BaselineStore());
      payload.journal[0].schemaVersion = 8;
      payload.journal[0].payload.records.find((record) => record.kind === 'attempt').claims = structuredClone(futureClaims);
    }],
    ['a future token assignment naming an unknown kind', (payload) => {
      payload.journal.push({ id: 'jentry_future_token', seq: payload.journalSeq + 1, type: 'entity.token_assigned', at: NOW, project: 'alpha', entityKind: 'capture', entityId: 'capture_1', schemaVersion: 8, payload: { id: 'capture_1', kind: 'capture', project: 'alpha', erasureToken: 'tok_capture' }, provenance: { actor: null, client: null, sessionId: null } });
      payload.journalSeq += 1;
    }],
    ['a future token assignment with a kind-less payload', (payload) => {
      payload.journal.push({ id: 'jentry_future_token', seq: payload.journalSeq + 1, type: 'entity.token_assigned', at: NOW, project: 'alpha', entityKind: null, entityId: 'item_1', schemaVersion: 8, payload: { id: 'item_1', project: 'alpha', erasureToken: 'tok_item' }, provenance: { actor: null, client: null, sessionId: null } });
      payload.journalSeq += 1;
    }]
  ];
  for (const [label, mutate] of cases) {
    const { payload } = v7Store();
    mutate(payload);
    const graph = createShadowGraph({ now });
    assert.doesNotThrow(() => graph.importData(structuredClone(payload)), label);
    assert.equal(bytes(privilegedSnapshot(graph).journal), bytes(payload.journal), `${label}: the journal is kept verbatim`);
  }
});

// §9.4 and §14: closed vocabularies and the cross-field rules. Only these are
// checked; every other v7 field is carried verbatim for PR-22..PR-24 to refine.
test('malformed claim data is refused at import and at restore', () => {
  const cases = [
    ['an unknown claim class', { claims: [{ text: 'x', class: 'extracted' }] }],
    ['an unsupported claim on a record', { claims: [{ text: 'x', class: 'unsupported' }] }],
    ['claims that are not a list', { claims: { text: 'x', class: 'quoted' } }],
    ['an unknown causal state', { causalClaim: { statement: 'x', state: 'maybe' } }],
    ['an unsupported causal class', { causalClaim: { statement: 'x', class: 'unsupported', state: 'recorded' } }],
    ['legacy free text marked quoted', { causalClaim: { statement: 'x', class: 'quoted', state: 'legacy_freetext' } }],
    ['legacy free text marked entailed', { causalClaim: { statement: 'x', class: 'entailed', state: 'legacy_freetext' } }],
    ['legacy free text with evidence', { causalClaim: { statement: 'x', state: 'legacy_freetext', evidence: [{ sourceRef: 'capture:c1' }] } }],
    ['an unknown outcome evidence state', { outcomeEvidence: { state: 'inferred' } }],
    ['absent outcome evidence with a result class', { outcomeEvidence: { state: 'absent' } }],
    ['not-applicable outcome evidence with a result class', { outcomeEvidence: { state: 'not_applicable' } }],
    ['observed outcome evidence without a result class', { outcomeEvidence: { state: 'observed', exitStatus: 0 } }, (entity) => { delete entity.resultClass; }],
    ['observed outcome evidence with a null result class', { outcomeEvidence: { state: 'observed', exitStatus: 0 } }, (entity) => { entity.resultClass = null; }],
    ['observed outcome evidence with an unknown result class', { outcomeEvidence: { state: 'observed', exitStatus: 0 } }, (entity) => { entity.resultClass = 'crashed'; }]
  ];
  for (const [label, override, adjust] of cases) {
    const { payload } = v7Store({ ...structuredClone(V7_ATTEMPT_FIELDS), ...override });
    if (adjust) for (const entity of attemptCopies(payload)) adjust(entity);
    assert.throws(() => createShadowGraph({ now }).importData(structuredClone(payload)), /claim model/, `import: ${label}`);
    assert.throws(() => validateRestorePayload(structuredClone(payload), { now }), /claim model/, `restore: ${label}`);
  }
  const legacyFreeText = v7Store({ causalClaim: { statement: 'kept verbatim', state: 'legacy_freetext' } });
  assert.doesNotThrow(() => createShadowGraph({ now }).importData(legacyFreeText.payload), 'legacy free text with no class and no evidence is valid');
  for (const resultClass of [undefined, null]) {
    const absent = v7Store({ outcomeEvidence: { state: 'absent' } });
    for (const entity of attemptCopies(absent.payload)) if (resultClass === undefined) delete entity.resultClass; else entity.resultClass = resultClass;
    assert.doesNotThrow(() => createShadowGraph({ now }).importData(absent.payload), `absent outcome evidence with resultClass ${resultClass} is valid`);
  }
});

// Every position a stored entity sits in is checked on its own: the live fact,
// a journal payload, a retry value, and an entity inside a projection baseline.
function v7BaselineStore() {
  const { payload } = v7Store();
  const seq = payload.journalSeq;
  payload.journal = [{
    id: 'jentry_v7_baseline', seq, type: 'projection.baseline', at: NOW, project: null, entityKind: null, entityId: null, schemaVersion: 7,
    payload: { records: structuredClone(payload.records), facts: structuredClone(payload.facts), relations: structuredClone(payload.relations), idempotency: structuredClone(payload.idempotency) },
    provenance: { actor: null, client: null, sessionId: null }
  }];
  payload.journalEpoch = seq;
  return payload;
}

test('a claim violation is refused wherever it is stored, not only on a live record', () => {
  const bad = [{ text: 'x', class: 'extracted' }];
  const baseline = v7BaselineStore();
  assert.doesNotThrow(() => createShadowGraph({ now }).importData(structuredClone(baseline)), 'the baseline store itself is valid');
  const cases = [
    ['the live fact', /facts\[0\] violates the claim model/, (payload) => { payload.facts[0].claims = bad; }],
    ['only a journal payload', /journal\[\d+\] payload violates the claim model/, (payload) => { payload.journal.find((entry) => entry.payload?.kind === 'attempt').payload.claims = bad; }],
    ['only a retry value', /idempotency\[\d+\]\.value violates the claim model/, (payload) => { payload.idempotency.find((item) => item.value.kind === 'attempt').value.claims = bad; }],
    ['only an entity in a projection baseline', /projection\.baseline payload violates the claim model/, (payload) => { Object.assign(payload, structuredClone(baseline)); payload.journal[0].payload.records.find((record) => record.kind === 'attempt').claims = bad; }]
  ];
  for (const [label, message, mutate] of cases) {
    const { payload } = v7Store();
    mutate(payload);
    assert.throws(() => createShadowGraph({ now }).importData(structuredClone(payload)), message, `import: ${label}`);
    assert.throws(() => validateRestorePayload(structuredClone(payload), { now }), /claim model/, `restore: ${label}`);
  }
});

// The token is a non-empty string on a decision, attempt, memory or fact that
// names its kind and id, and no two entities share one. The refusal never
// repeats the token.
test('a malformed, misplaced or shared erasureToken is refused at import and at restore', () => {
  const cases = [
    ['an empty token', /non-empty string/, (payload) => { payload.records[0].erasureToken = ''; }],
    ['a numeric token', /non-empty string/, (payload) => { payload.records[0].erasureToken = 42; }],
    ['an object token', /non-empty string/, (payload) => { payload.records[0].erasureToken = { secret: 'tok_object' }; }],
    ['a fact that does not name its kind', /names its kind and id/, (payload) => { delete payload.facts[0].kind; }],
    ['a journal payload that does not name its id', /names its kind and id/, (payload) => { delete payload.journal.find((entry) => entry.type === 'decision.recorded').payload.id; }],
    ['a journal payload that does not name its kind', /names its kind and id/, (payload) => { delete payload.journal.find((entry) => entry.type === 'decision.recorded').payload.kind; }],
    ['a relation', /names its kind and id/, (payload) => {
      const [from, to] = payload.records.filter((record) => record.kind === 'decision' && record.project === 'alpha').concat(payload.records.filter((record) => record.kind === 'attempt')).map((record) => record.id);
      payload.relations.push({ id: 'relation_tokened', kind: 'relation', schemaVersion: 6, project: 'alpha', attribution: 'project', from, to, relation: 'related_to', createdAt: NOW, erasureToken: 'tok_relation' });
    }],
    ['two entities in two projects sharing one token', /share an erasureToken/, (payload) => {
      const [alpha, beta] = ['alpha', 'beta'].map((project) => payload.records.find((record) => record.kind === 'decision' && record.project === project));
      beta.erasureToken = alpha.erasureToken;
    }]
  ];
  for (const [label, message, mutate] of cases) {
    const { payload } = v7Store();
    mutate(payload);
    for (const [where, run] of [['import', () => createShadowGraph({ now }).importData(structuredClone(payload))], ['restore', () => validateRestorePayload(structuredClone(payload), { now })]]) {
      assert.throws(run, (error) => message.test(error.message) && !error.message.includes('tok_'), `${where}: ${label}`);
    }
  }
});

test('a schema-7 entity in a grant scope is read through the grant; a schema-8 entity is not', () => {
  const { payload } = v7Store();
  const beta = payload.records.find((record) => record.project === 'beta');
  payload.records.push({ ...structuredClone(beta), id: 'decision_future', title: 'Wider future', schemaVersion: 8 });
  const graph = createShadowGraph({ now });
  graph.importData(payload);
  const grant = privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'synthetic v7 grant' }).entry;
  const found = graph.search('Wider', { project: 'alpha', accessId: grant.accessId }).items.map((item) => item.record.id);
  assert.ok(found.includes(beta.id), 'the schema-7 entity is read through the grant');
  assert.equal(found.includes('decision_future'), false, 'the schema-8 entity is not');
});

// Plan rev6 §3.2: the token is internal. This build writes none, but it is the
// floor for builds that do, so no public result may carry one.
test('no public read or write result returns an entity erasureToken; the privileged snapshot keeps it', () => {
  const { payload, attemptId } = v7Store();
  const graph = createShadowGraph({ now });
  graph.importData(payload);
  const decision = privilegedSnapshot(graph).records.find((record) => record.kind === 'decision' && record.project === 'alpha');
  const scope = { project: 'alpha' };
  const results = {
    search: graph.search('', scope), retrieve: graph.retrieve('migration', scope), recall: graph.recall('migration', scope),
    context: graph.context(scope), reviewContext: graph.reviewContext(scope), review: graph.review(scope), reconsider: graph.reconsider(scope),
    exportData: graph.exportData(scope), redact: graph.redact(scope), getJournal: graph.getJournal({ ...scope, limit: 100 }), rebuild: graph.rebuild(scope),
    // Caller rules that turn every entity's kind into a non-string still see no token.
    redactKind: graph.redact({ ...scope, patterns: ['^kind$'], replacement: 0 }),
    traverse: graph.traverse({ ...scope, id: decision.id }), validate: graph.validate(scope), stats: graph.stats(scope),
    status: graph.updateDecisionStatus(decision.id, 'planned', scope)
  };
  for (const [name, value] of Object.entries(results)) {
    const json = JSON.stringify(value);
    assert.equal(json.includes('erasureToken') || json.includes('tok_'), false, `${name} returns a token`);
  }
  assert.equal(privilegedSnapshot(graph).records.find((record) => record.id === attemptId).erasureToken, V7_ATTEMPT_FIELDS.erasureToken);
});

// Plan rev6 §3.2: one new replayable type. It may only add a token to an entity
// that has none, and must change nothing else.
function withTokenAssignment(mutate = () => {}) {
  const payload = tokenFree(privilegedSnapshot(seeded()));
  const decision = payload.records.find((record) => record.kind === 'decision' && record.project === 'alpha');
  const entry = {
    id: 'jentry_token_1', seq: payload.journalSeq + 1, type: 'entity.token_assigned', at: NOW, project: decision.project,
    entityKind: 'decision', entityId: decision.id, schemaVersion: 7, payload: { ...structuredClone(decision), erasureToken: 'tok_backfilled' },
    provenance: { actor: null, client: null, sessionId: null }
  };
  mutate(entry, payload);
  payload.journal.push(entry);
  payload.journalSeq = entry.seq;
  Object.assign(payload.records.find((record) => record.id === decision.id), { erasureToken: 'tok_backfilled' });
  return { payload, decision };
}

test('entity.token_assigned replays to the live state when it only adds a token to a tokenless entity', () => {
  // The payload's key order is not part of what it changes.
  const reordered = (entry) => { entry.payload = Object.fromEntries(Object.entries(entry.payload).reverse()); };
  for (const mutate of [undefined, reordered]) {
    const { payload, decision } = withTokenAssignment(mutate);
    const graph = createShadowGraph({ now });
    graph.importData(payload);
    const rebuilt = privilegedRebuild(graph);
    assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
    assert.deepEqual(byId(rebuilt.projection.records), byId(privilegedSnapshot(graph).records));
    assert.equal(rebuilt.projection.records.find((record) => record.id === decision.id).erasureToken, 'tok_backfilled');
  }
});

test('an entity.token_assigned entry must carry a decision, attempt, memory or fact', () => {
  const { payload } = withTokenAssignment((entry) => {
    entry.entityKind = null;
    delete entry.payload.kind;
    delete entry.payload.erasureToken;
  });
  assert.throws(() => createShadowGraph({ now }).importData(payload), /postcondition failed: entity\.token_assigned cannot carry a kind-less entity/);
});

// Retry values follow the entity they repeat, as they do for attribution. An
// attempt compares its whole entity, token included, so a backfilled attempt
// that has a retry key must still load, rebuild and restore.
test('entity.token_assigned on an attempt with a retry key moves its retry value and keeps rebuild parity', () => {
  const payload = tokenFree(privilegedSnapshot(seeded()));
  const attempt = payload.records.find((record) => record.kind === 'attempt');
  const retry = payload.idempotency.find((item) => item.value.id === attempt.id);
  assert.ok(retry, 'the seeded attempt has a retry key');
  const seq = payload.journalSeq + 1;
  payload.journal.push({
    id: 'jentry_token_attempt', seq, type: 'entity.token_assigned', at: NOW, project: attempt.project,
    entityKind: 'attempt', entityId: attempt.id, schemaVersion: 7, payload: { ...structuredClone(attempt), erasureToken: 'tok_attempt_backfilled' },
    provenance: { actor: null, client: null, sessionId: null }
  });
  payload.journalSeq = seq;
  attempt.erasureToken = 'tok_attempt_backfilled';
  retry.value = structuredClone(attempt);
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, `${rebuilt.reason} ${JSON.stringify(rebuilt.skipped)}`);
  const live = privilegedSnapshot(graph);
  assert.deepEqual(byId(rebuilt.projection.records), byId(live.records));
  assert.equal(bytes(rebuilt.projection.idempotency.find((item) => item.value.id === attempt.id)), bytes(live.idempotency.find((item) => item.value.id === attempt.id)));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(payload), { now }));
});

test('entity.token_assigned is not replayed when it changes anything else, re-tokens, or names no entity', () => {
  const cases = [
    ['a changed title', (entry) => { entry.payload.title = 'rewritten'; }],
    ['no token', (entry) => { delete entry.payload.erasureToken; }],
    ['an unknown entity', (entry) => { entry.entityId = 'decision_missing'; entry.payload.id = 'decision_missing'; }],
    ['an entity that already has a token', (entry, payload) => {
      payload.journal.find((item) => item.entityId === entry.entityId && item.type === 'decision.recorded').payload.erasureToken = 'tok_first';
    }]
  ];
  for (const [label, mutate] of cases) {
    const { payload } = withTokenAssignment(mutate);
    const graph = createShadowGraph({ now });
    graph.importData(payload);
    const rebuilt = privilegedRebuild(graph);
    assert.equal(rebuilt.rebuildable, false, label);
    assert.ok(rebuilt.skipped.some((item) => item.type === 'entity.token_assigned' && item.why === 'invalid_token_assignment'), `${label}: ${JSON.stringify(rebuilt.skipped)}`);
  }
});

// Readable is not writable until the writer catches up. The writer bound moved
// to 7 with PR-21: a schema-7 entity is attributed, reviewed and migrated like
// any other, keeping its v7 fields and its token; a schema-8 entity is not.
test('the writer bound follows the writer: schema 7 is attributed, reviewed and migrated; schema 8 is not', () => {
  const { payload } = v7Store();
  const beta = payload.records.find((record) => record.kind === 'decision' && record.project === 'beta');
  const legacy = { ...structuredClone(beta), id: 'decision_v7_default', project: 'default', erasureToken: 'tok_v7_default' };
  delete legacy.attribution;
  payload.records.push(legacy, { ...structuredClone(beta), id: 'decision_v8', title: 'Future', schemaVersion: 8, erasureToken: 'tok_v8' });
  const graph = createShadowGraph({ now });
  graph.importData(payload);
  graph.attribute({ ids: [beta.id], targetProject: 'alpha', reason: 'x' });
  const moved = privilegedSnapshot(graph).records.find((record) => record.id === beta.id);
  assert.deepEqual({ project: moved.project, schemaVersion: moved.schemaVersion, erasureToken: moved.erasureToken }, { project: 'alpha', schemaVersion: 7, erasureToken: beta.erasureToken });
  assert.equal(graph.legacyAttributionReview({ limit: 1000 }).items.some((item) => item.id === legacy.id), true, 'the review lists it');
  graph.migrateAttribution();
  const migrated = privilegedSnapshot(graph).records.find((record) => record.id === legacy.id);
  assert.deepEqual({ attribution: migrated.attribution, erasureToken: migrated.erasureToken }, { attribution: 'legacy_ambiguous', erasureToken: 'tok_v7_default' });
  const before = privilegedSnapshot(graph);
  assert.throws(() => graph.attribute({ ids: ['decision_v8'], targetProject: 'alpha', reason: 'x' }), /future schema this build does not write/);
  assert.deepEqual(privilegedSnapshot(graph), before, 'a refused attribution writes nothing');
});

// §19.3.2: the schema-5 step converts schema-6 data only, so schema-7 data and
// tokens reach it only through the schema-6 step. A store holding what a newer
// writer than this one produced is refused before any file is written.
test('the schema-5 step refuses schema-7 data and tokens; a store newer than the writer is refused before any file is written', async (t) => {
  const { payload } = v7Store();
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  assert.throws(() => downgradeToSchema5(privilegedSnapshot(graph), { now }), /schema-6 data only; this store holds schema-7 data/);
  // A schema-7 journal entry alone, or a token alone on a schema-6 entity, is enough.
  const six = () => downgradeToSchema6(privilegedSnapshot(seeded()), { now }).payload;
  const journalOnly = six();
  journalOnly.journal.at(-1).schemaVersion = 7;
  assert.throws(() => downgradeToSchema5(journalOnly, { now }), /schema-6 data only; this store holds schema-7 data/);
  const tokenOnly = six();
  tokenOnly.records[0].erasureToken = 'tok_backfilled';
  assert.throws(() => downgradeToSchema5(tokenOnly, { now }), /schema-6 data only; this store holds erasure tokens/);
  assert.doesNotThrow(() => downgradeToSchema5(six(), { now }), 'a schema-6 store still downgrades');
  const future = structuredClone(payload);
  future.records.push({ ...structuredClone(future.records[0]), id: 'decision_v8', schemaVersion: 8, erasureToken: 'tok_v8' });
  const futureGraph = createShadowGraph({ now });
  futureGraph.importData(structuredClone(future));
  const directory = await scratchDirectory(t, 'shadowgraph-v7-downgrade-');
  const file = join(directory, 'data.json');
  await writeFile(file, JSON.stringify(future, null, 2));
  const output = join(directory, 'downgraded.json');
  const preservationCopy = join(directory, 'preserved.json');
  await assert.rejects(downgradeStore({ graph: futureGraph, store: createJsonFileStore(file), file, output, preservationCopy, now }), /schema-8 data a newer build wrote/);
  for (const path of [output, preservationCopy, `${output}.report.json`]) assert.equal(existsSync(path), false, path);
});

// Reader first: PR-20 read the type before any module wrote it; PR-21's
// backfill is its one writer.
test('the token backfill is the one writer of entity.token_assigned', async () => {
  const emitters = [];
  for (const name of await readdir(src)) {
    if (!name.endsWith('.js')) continue;
    const matches = (await readFile(join(src, name), 'utf8')).match(/type:\s*'entity\.token_assigned'/g);
    if (matches) emitters.push([name, matches.length]);
  }
  assert.deepEqual(emitters, [['shadowgraph.js', 1]]);
});
