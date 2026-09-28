// Plan v1.4.4 PR-21 (§9.6 steps 2-3, §19.3.2, §28 P3; plan rev6 §3.2): the
// writer writes schema 7. Every new decision, attempt, memory and fact gets a
// random, content-free erasureToken, and so does a tokenless one on its first
// write, on that write's own journal entry. Nothing else assigns one -- not a
// load, a read, an import or a restore -- except migrate, which backfills in
// bounded, resumable entity.token_assigned batches. The token stays internal.
// downgrade {toSchemaVersion: 6} forks a schema-6 copy; the default still
// reaches schema 5, through 6.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph, SCHEMA_VERSION } from '../src/shadowgraph.js';
import { JOURNAL_SCHEMA_VERSION } from '../src/journal.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { restoreFile } from '../src/backup.js';
import { tokenFree } from '../tools/token-free.js';
import { downgradeStore, downgradeToSchema5, downgradeToSchema6 } from '../src/schema-conversion.js';
import { privilegedIssueAccess, privilegedRebuild, privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const FUTURE = { opaque: [{ id: 'f1', nested: { values: [1, 'two', null, true] } }], note: 'a collection this build does not know' };
const V7_FIELDS = ['claims', 'causalClaim', 'captureRef', 'outcomeEvidence', 'erasureToken'];
const bytes = (value) => JSON.stringify(value);
// By value: import puts a legacy entity's schemaVersion and project first.
const same = (value) => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item));
const byId = (items) => [...items].sort((left, right) => String(left.id).localeCompare(String(right.id)));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const runCli = (args, file, storage = 'json') => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: storage }, encoding: 'utf8' });
const entitiesOf = (snapshot) => [...snapshot.records, ...snapshot.facts];

async function sqliteOrSkip(t) {
  try { await import('node:sqlite'); return true; }
  catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return false; }
}

function seeded() {
  const graph = createShadowGraph({ now });
  const decision = graph.addDecision({ project: 'alpha', title: 'Cache', chosen: 'redis', idempotencyKey: 'decision-1' });
  const replacement = graph.addDecision({ project: 'alpha', title: 'Cache v2', chosen: 'valkey' });
  graph.addAttempt({ project: 'alpha', solution: 'online migration', result: 'failed: lock timeout', resultClass: 'failed', idempotencyKey: 'attempt-1' });
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'k', text: 'a note' });
  graph.addFact({ project: 'alpha', key: 'latency', value: 10 });
  graph.link({ project: 'alpha', from: replacement.id, to: decision.id, relation: 'related_to' });
  graph.addDecision({ project: 'beta', title: 'Wider', chosen: 'x' });
  return graph;
}

// A store a schema-6 build wrote: schema 6 throughout, and no token or
// attempt cause anywhere.
function asSchema6(snapshot) {
  const payload = structuredClone(snapshot);
  payload.schemaVersion = 6;
  const lower = (item) => {
    if (!item || typeof item !== 'object') return;
    if (item.schemaVersion === 7) item.schemaVersion = 6;
    delete item.erasureToken;
    delete item.causalClaim;
  };
  for (const item of [...payload.records, ...payload.facts, ...payload.relations]) lower(item);
  for (const item of payload.idempotency) lower(item.value);
  for (const entry of payload.journal) { lower(entry); lower(entry.payload); }
  return payload;
}
const v6Store = () => asSchema6(privilegedSnapshot(seeded()));

test('the writer writes schema 7 and gives every new entity its own random erasure token', () => {
  assert.equal(SCHEMA_VERSION, 7);
  assert.equal(JOURNAL_SCHEMA_VERSION, 7);
  const graph = seeded();
  const snapshot = privilegedSnapshot(graph);
  assert.equal(snapshot.schemaVersion, 7);
  assert.deepEqual([...new Set([...entitiesOf(snapshot), ...snapshot.relations, ...snapshot.journal].map((item) => item.schemaVersion))], [7]);
  assert.equal(graph.stats({ project: 'alpha' }).schemaVersion, 7);
  const tokens = entitiesOf(snapshot).map((entity) => entity.erasureToken);
  assert.ok(tokens.every((token) => typeof token === 'string' && token.length >= 16), 'every decision, attempt, memory and fact has one');
  assert.equal(new Set(tokens).size, tokens.length, 'no two share one');
  assert.equal(snapshot.relations.some((relation) => Object.hasOwn(relation, 'erasureToken')), false, 'a relation has none');
  for (const entity of entitiesOf(snapshot)) {
    // Content-free: nothing of the entity is in it.
    for (const value of [entity.id, entity.title, entity.key, entity.text, entity.solution].filter(Boolean)) assert.equal(entity.erasureToken.includes(value), false);
    const created = snapshot.journal.find((entry) => entry.entityId === entity.id);
    assert.equal(created.payload.erasureToken, entity.erasureToken, `${entity.id}: the creating entry carries it`);
  }
  for (const item of snapshot.idempotency) {
    assert.equal(item.value.erasureToken, entitiesOf(snapshot).find((entity) => entity.id === item.value.id).erasureToken, `${item.key}: the retry value carries it`);
  }
  const again = privilegedSnapshot(seeded());
  assert.equal(entitiesOf(again).some((entity) => tokens.includes(entity.erasureToken)), false, 'random, not derived from the input');
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(byId(rebuilt.projection.records), byId(snapshot.records));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(snapshot), { now }));
  assert.equal(graph.validate().valid, true);
});

test('no load, read, import or restore gives a token; the first write to a tokenless entity does, once, on its own entry', async (t) => {
  const payload = v6Store();
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  const scope = { project: 'alpha' };
  graph.search('', scope); graph.retrieve('migration', scope); graph.context(scope); graph.exportData(scope); graph.getJournal({ ...scope, limit: 100 });
  graph.rebuild(scope); graph.validate(scope); graph.stats(scope); graph.legacyAttributionReview();
  validateRestorePayload(privilegedSnapshot(graph), { now });
  assert.equal(entitiesOf(privilegedSnapshot(graph)).some((entity) => Object.hasOwn(entity, 'erasureToken')), false, 'import and reads');

  const directory = await scratchDirectory(t, 'shadowgraph-v7-token-');
  const file = join(directory, 'data.json');
  await writeFile(file, JSON.stringify(payload, null, 2));
  const store = createJsonFileStore(file);
  const loaded = createShadowGraph({ now });
  loaded.importData(await store.load());
  await store.save(privilegedSnapshot(loaded));
  assert.equal(entitiesOf(JSON.parse(await readFile(file, 'utf8'))).some((entity) => Object.hasOwn(entity, 'erasureToken')), false, 'load and save');
  // Nor the R16 restore primitive, nor the graph it activates.
  const restored = createShadowGraph({ now });
  await restoreFile(file, join(directory, 'restored.json'), { afterReplace: (data) => restored.replaceData(data) });
  assert.equal(entitiesOf(JSON.parse(await readFile(join(directory, 'restored.json'), 'utf8'))).some((entity) => Object.hasOwn(entity, 'erasureToken')), false, 'restore');
  assert.equal(entitiesOf(privilegedSnapshot(restored)).some((entity) => Object.hasOwn(entity, 'erasureToken')), false, 'replaceData');
  if (await sqliteOrSkip(t)) {
    const source = await createSqliteStore(join(directory, 'source.db'));
    await source.save(structuredClone(payload));
    source.close();
    const target = await createSqliteStore(join(directory, 'restored.db'));
    const sqliteLive = createShadowGraph({ now });
    await target.restore(join(directory, 'source.db'), { afterReplace: (data) => sqliteLive.replaceData(data) });
    const installed = await target.load();
    target.close();
    assert.equal(entitiesOf(installed).some((entity) => Object.hasOwn(entity, 'erasureToken')), false, 'SQLite restore');
    assert.equal(entitiesOf(privilegedSnapshot(sqliteLive)).some((entity) => Object.hasOwn(entity, 'erasureToken')), false, 'SQLite replaceData');
  }

  const decision = payload.records.find((record) => record.kind === 'decision' && record.title === 'Cache');
  graph.updateDecisionStatus(decision.id, 'planned', scope);
  let live = privilegedSnapshot(graph);
  const token = live.records.find((record) => record.id === decision.id).erasureToken;
  assert.equal(typeof token, 'string');
  const entry = live.journal.at(-1);
  assert.equal(entry.type, 'decision.status_changed');
  assert.equal(entry.payload.erasureToken, token, 'the write\'s own entry carries it');
  assert.equal(live.journal.some((item) => item.type === 'entity.token_assigned'), false, 'no separate entry');
  graph.updateDecisionStatus(decision.id, 'in_progress', scope);
  live = privilegedSnapshot(graph);
  assert.equal(live.records.find((record) => record.id === decision.id).erasureToken, token, 'never replaced');
  // A write that supersedes an older version tokens the version it closes, too.
  graph.addFact({ project: 'alpha', key: 'latency', value: 12 });
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'k', text: 'a newer note' });
  live = privilegedSnapshot(graph);
  const closed = entitiesOf(live).filter((item) => item.status === 'superseded');
  assert.equal(closed.length, 2);
  for (const entity of closed) assert.equal(typeof entity.erasureToken, 'string', `${entity.id} superseded`);
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(byId([...rebuilt.projection.records, ...rebuilt.projection.facts]), byId(entitiesOf(live)));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(live), { now }));
});

test('backfill tokens every entity in bounded, resumable entity.token_assigned batches and skips a fact that names no kind', () => {
  const payload = v6Store();
  const legacyFact = { ...structuredClone(payload.facts[0]), id: 'fact_legacy_kindless', key: 'legacy-key' };
  delete legacyFact.kind;
  payload.facts.push(legacyFact);
  payload.journalSeq += 1;
  payload.journal.push({ id: 'jentry_legacy_kindless', seq: payload.journalSeq, type: 'fact.observed', at: NOW, project: legacyFact.project, entityKind: 'fact', entityId: legacyFact.id, schemaVersion: 6, payload: structuredClone(legacyFact), provenance: { actor: null, client: null, sessionId: null } });
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  const tokenable = entitiesOf(payload).length - 1;
  const first = graph.backfillErasureTokens({ limit: 2 });
  assert.deepEqual({ assigned: first.assigned, remaining: first.remaining, complete: first.complete }, { assigned: 2, remaining: tokenable - 2, complete: false });
  let total = first.assigned;
  for (;;) {
    const batch = graph.backfillErasureTokens({ limit: 2 });
    total += batch.assigned;
    if (batch.complete) {
      assert.deepEqual(batch.skipped, [{ id: 'fact_legacy_kindless', reason: 'fact_without_kind' }]);
      break;
    }
  }
  assert.equal(total, tokenable);
  const done = graph.backfillErasureTokens();
  assert.deepEqual({ assigned: done.assigned, complete: done.complete }, { assigned: 0, complete: true }, 'idempotent once done');
  const live = privilegedSnapshot(graph);
  const assignments = live.journal.filter((entry) => entry.type === 'entity.token_assigned');
  assert.equal(assignments.length, tokenable);
  for (const entity of entitiesOf(live)) {
    if (entity.id === 'fact_legacy_kindless') { assert.equal(Object.hasOwn(entity, 'erasureToken'), false); continue; }
    const before = entitiesOf(payload).find((item) => item.id === entity.id);
    assert.equal(entity.schemaVersion, before.schemaVersion, `${entity.id}: its schema version is unchanged`);
    const { erasureToken, ...rest } = entity;
    assert.equal(same(rest), same(before), `${entity.id}: nothing else changes`);
    assert.equal(assignments.find((entry) => entry.entityId === entity.id).payload.erasureToken, erasureToken);
  }
  const attempt = live.records.find((record) => record.kind === 'attempt');
  assert.equal(live.idempotency.find((item) => item.value.id === attempt.id).value.erasureToken, attempt.erasureToken, 'the retry value moves with it');
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, `${rebuilt.reason} ${JSON.stringify(rebuilt.skipped)}`);
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(live), { now }));
  assert.throws(() => graph.backfillErasureTokens({ limit: 0 }), /positive integer/);
});

test('migrate backfills tokens after attribution, batch by batch, behind a verified preservation copy', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v7-migrate-');
  const file = join(directory, 'data.json');
  const payload = v6Store();
  await writeFile(file, JSON.stringify(payload, null, 2));
  const run = runCli(['migrate', JSON.stringify({ batchSize: 3, preservationCopy: join(directory, 'preserved.json') })], file);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.tokens.assigned, entitiesOf(payload).length);
  assert.ok(result.tokens.batches >= 2);
  assert.equal(result.complete, true);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(entitiesOf(stored).every((entity) => typeof entity.erasureToken === 'string'));
  for (const entity of entitiesOf(stored)) assert.equal(run.stdout.includes(entity.erasureToken), false, 'the report names no token');
  assert.doesNotThrow(() => validateRestorePayload(stored, { now }));
  const preserved = JSON.parse(await readFile(join(directory, 'preserved.json'), 'utf8'));
  assert.equal(entitiesOf(preserved).some((entity) => Object.hasOwn(entity, 'erasureToken')), false, 'the preservation copy is the store as it was');
});

// What a schema-6 writer left: a legacy decision whose last journal snapshot is
// not what loading it now makes of it (its confidence basis is recomputed on load).
function reshapedLegacyStore() {
  const graph = createShadowGraph({ now });
  graph.importData({ schemaVersion: 2, records: [{ id: 'd_legacy_num', kind: 'decision', project: 'alpha', title: 'Legacy', chosen: 'x', status: 'active', confidence: 0.7, evidence: ['doc'], createdAt: '2025-01-01T00:00:00.000Z' }] });
  graph.migrateAttribution();
  graph.addConfidenceEvidence({ project: 'alpha', decisionId: 'd_legacy_num', reason: 'r', key: 'e2' });
  return asSchema6(privilegedSnapshot(graph));
}

test('backfill assigns onto the snapshot a reader replays, even when loading reshaped the live entity; migrate validates each batch before saving it', async (t) => {
  const payload = reshapedLegacyStore();
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  const live = privilegedSnapshot(graph).records.find((record) => record.id === 'd_legacy_num');
  const snapshot = payload.journal.filter((entry) => entry.entityId === 'd_legacy_num').at(-1).payload;
  assert.notEqual(same(live), same(snapshot), 'the fixture reshapes on load');
  assert.equal(graph.backfillErasureTokens().assigned, 1);
  const assignment = privilegedSnapshot(graph).journal.at(-1);
  const { erasureToken, ...rest } = assignment.payload;
  assert.equal(same(rest), same(snapshot), 'the entry is the journal snapshot with the token added');
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, `${rebuilt.reason} ${JSON.stringify(rebuilt.skipped)}`);
  assert.doesNotThrow(() => validateRestorePayload(privilegedSnapshot(graph), { now }));
  const directory = await scratchDirectory(t, 'shadowgraph-v7-reshaped-');
  const file = join(directory, 'data.json');
  await writeFile(file, JSON.stringify(payload, null, 2));
  const run = runCli(['migrate', JSON.stringify({ batchSize: 1, preservationCopy: join(directory, 'preserved.json') })], file);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotThrow(() => validateRestorePayload(JSON.parse(readFileSync(file, 'utf8')), { now }));
});

// A store with both kinds of tokenless record: legacy ones the attribution
// migration reaches, and schema-6 ones only the backfill does.
function mixedStore() {
  const payload = v6Store();
  const legacy = payload.records.filter((record) => record.project === 'alpha' && record.kind === 'decision').map((record) => record.id);
  for (const entity of [...payload.records, ...payload.idempotency.map((item) => item.value), ...payload.journal.map((entry) => entry.payload)]) {
    if (!legacy.includes(entity?.id)) continue;
    delete entity.attribution;
    entity.schemaVersion = 5;
  }
  return { payload, legacy };
}

test('migrate gives every token after attribution, reports them all, and a rerun is a no-op', async (t) => {
  const { payload, legacy } = mixedStore();
  const directory = await scratchDirectory(t, 'shadowgraph-v7-mixed-');
  const file = join(directory, 'data.json');
  await writeFile(file, JSON.stringify(payload, null, 2));
  const first = runCli(['migrate', JSON.stringify({ batchSize: 2, preservationCopy: join(directory, 'first.json') })], file);
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.migrated, legacy.length);
  assert.deepEqual({ assigned: report.tokens.assigned, backfilled: report.tokens.backfilled }, { assigned: entitiesOf(payload).length, backfilled: entitiesOf(payload).length - legacy.length }, 'the attribution entries carry the legacy tokens');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const types = stored.journal.map((entry) => entry.type);
  assert.ok(types.lastIndexOf('entity.attributed') < types.indexOf('entity.token_assigned'), 'attribution first, then the backfill');
  const again = runCli(['migrate', JSON.stringify({ batchSize: 2, preservationCopy: join(directory, 'second.json') })], file);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual({ migrated: JSON.parse(again.stdout).migrated, assigned: JSON.parse(again.stdout).tokens.assigned }, { migrated: 0, assigned: 0 });
});

test('a direct backfill leaves a record the attribution migration has not reached to its attribution entry', () => {
  const { payload, legacy } = mixedStore();
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  const result = graph.backfillErasureTokens();
  assert.deepEqual(result.skipped.map((item) => [item.id, item.reason]).sort(), legacy.map((id) => [id, 'not_attributed']).sort());
  assert.equal(privilegedRebuild(graph).rebuildable, true);
  assert.doesNotThrow(() => validateRestorePayload(privilegedSnapshot(graph), { now }));
  graph.migrateAttribution();
  assert.ok(entitiesOf(privilegedSnapshot(graph)).every((entity) => typeof entity.erasureToken === 'string'), 'the attribution entries give the rest');
});

test('an interrupted backfill resumes under migrate; a store a reader would refuse is refused before migrate writes anything', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v7-resume-');
  const file = join(directory, 'data.json');
  const payload = v6Store();
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  graph.backfillErasureTokens({ limit: 2 });
  await writeFile(file, JSON.stringify(privilegedSnapshot(graph), null, 2));
  const run = runCli(['migrate', JSON.stringify({ batchSize: 2, preservationCopy: join(directory, 'preserved.json') })], file);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual({ assigned: report.tokens.assigned, skipped: report.tokens.skipped }, { assigned: entitiesOf(payload).length - 2, skipped: [] });
  assert.equal(typeof report.tokens.highWaterMark, 'string');
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(entitiesOf(stored).every((entity) => typeof entity.erasureToken === 'string'));
  // A second assignment to a tokened record: the journal no longer rebuilds.
  const broken = structuredClone(stored);
  const target = broken.records[0];
  broken.journalSeq += 1;
  broken.journal.push({ id: 'jentry_second_token', seq: broken.journalSeq, type: 'entity.token_assigned', at: NOW, project: target.project, entityKind: target.kind, entityId: target.id, schemaVersion: 7, payload: structuredClone(target), provenance: { actor: null, client: null, sessionId: null } });
  const brokenFile = join(directory, 'broken.json');
  await writeFile(brokenFile, JSON.stringify(broken, null, 2));
  const before = sha256(await readFile(brokenFile));
  const refused = runCli(['migrate', JSON.stringify({ preservationCopy: join(directory, 'never.json') })], brokenFile);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /invalid_token_assignment/);
  assert.equal(sha256(await readFile(brokenFile)), before, 'the store is untouched');
  assert.equal(existsSync(join(directory, 'never.json')), false, 'no preservation copy either');
});

test('verifying a tokenless fact is its first write: the fact and its fact.verified entry get the token', async () => {
  const payload = v6Store();
  const graph = createShadowGraph({ now, verifier: { verify: async () => ({ verifierIdentity: 'test' }), validateStored: () => true } });
  graph.importData(structuredClone(payload));
  const fact = payload.facts[0];
  await graph.verifyFact({ project: 'alpha', factId: fact.id, evidencePath: 'evidence.txt' });
  const live = privilegedSnapshot(graph);
  const token = live.facts.find((item) => item.id === fact.id).erasureToken;
  assert.equal(typeof token, 'string');
  assert.deepEqual([live.journal.at(-1).type, live.journal.at(-1).payload.erasureToken], ['fact.verified', token]);
  assert.equal(privilegedRebuild(graph).rebuildable, true);
});

test('a merge never gives two live entities one token, and a retry value built from a public result takes its entity\'s', () => {
  const graph = seeded();
  const [first] = privilegedSnapshot(graph).records.filter((record) => record.kind === 'decision');
  const copy = { ...tokenFree(first), id: 'decision_copy', erasureToken: first.erasureToken };
  assert.throws(() => graph.importData({ schemaVersion: 7, records: [copy] }), (error) => /would share an erasureToken/.test(error.message) && !error.message.includes(first.erasureToken));
  const attempt = graph.addAttempt({ project: 'alpha', solution: 'merge me', result: 'r', idempotencyKey: 'merge-attempt' });
  const retry = privilegedSnapshot(graph).idempotency.find((item) => item.value.id === attempt.id);
  const before = privilegedSnapshot(graph);
  graph.importData({ schemaVersion: 7, records: [attempt], idempotency: [{ key: retry.key, value: attempt }] });
  assert.deepEqual(privilegedSnapshot(graph), before, 'merging an attempt and its retry back from public results is a no-op');
});

test('JSON and SQLite: a schema-6 store saved by this build becomes envelope 7 and is otherwise unchanged', async (t) => {
  const graph = seeded();
  privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'synthetic grant' });
  const payload = { ...asSchema6(privilegedSnapshot(graph)), futureCollection: FUTURE };
  const unchanged = (saved, label) => {
    assert.equal(saved.schemaVersion, 7, label);
    for (const key of ['records', 'facts', 'relations', 'idempotency', 'journal', 'access', 'accessRevocations', 'futureCollection']) assert.equal(same(saved[key]), same(payload[key]), `${label}: ${key}`);
  };
  const directory = await scratchDirectory(t, 'shadowgraph-v7-envelope-');
  const file = join(directory, 'data.json');
  await writeFile(file, JSON.stringify(payload, null, 2));
  const store = createJsonFileStore(file);
  const loaded = createShadowGraph({ now });
  loaded.importData(await store.load());
  await store.save(privilegedSnapshot(loaded));
  unchanged(JSON.parse(await readFile(file, 'utf8')), 'JSON');
  if (!await sqliteOrSkip(t)) return;
  const sqliteFile = join(directory, 'data.db');
  const first = await createSqliteStore(sqliteFile);
  await first.save(structuredClone(payload));
  first.close();
  const reopened = await createSqliteStore(sqliteFile);
  const sqliteGraph = createShadowGraph({ now });
  sqliteGraph.importData(await reopened.load());
  await reopened.save(privilegedSnapshot(sqliteGraph));
  const saved = await reopened.load();
  reopened.close();
  unchanged(saved, 'SQLite');
});

// A schema-7 store holding every v7 field: claims on an attempt, and a captured
// attempt whose outcome evidence is absent, which a schema-6 reader would
// re-read from its prose.
function v7Fixture() {
  const graph = seeded();
  graph.addAttempt({ project: 'alpha', solution: 'captured run', result: 'unknown', idempotencyKey: 'captured-1' });
  privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'synthetic grant' });
  const payload = { ...privilegedSnapshot(graph), futureCollection: FUTURE };
  const [claimed, captured] = payload.records.filter((record) => record.kind === 'attempt');
  const copies = (id) => [...payload.records, ...payload.idempotency.map((item) => item.value), ...payload.journal.map((entry) => entry.payload)].filter((entity) => entity?.id === id);
  for (const entity of copies(claimed.id)) Object.assign(entity, { claims: [{ text: 'the lock timed out', class: 'quoted', sourceRef: 'capture:c1', verifierVersion: 'claim-verifier-v1' }], causalClaim: { statement: 'the lock timed out', state: 'recorded', class: 'quoted', verifierVersion: 'claim-verifier-v1' }, outcomeEvidence: { state: 'observed', source: 'exit_status', exitStatus: 1 } });
  for (const entity of copies(captured.id)) Object.assign(entity, { captureRef: 'capture:c2', outcomeEvidence: { state: 'absent' } });
  return { payload, claimed, captured };
}

test('downgradeToSchema6 strips and names the v7 fields, excludes a captured attempt without a result class, and carries unknown and access collections', () => {
  const { payload, claimed, captured } = v7Fixture();
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  const { payload: output, report } = downgradeToSchema6(privilegedSnapshot(graph), { now });
  assert.deepEqual({ from: report.fromSchemaVersion, to: report.toSchemaVersion }, { from: 7, to: 6 });
  assert.equal(output.schemaVersion, 6);
  const everything = [...output.records, ...output.facts, ...output.relations, ...output.idempotency.map((item) => item.value), ...output.journal, ...output.journal.flatMap((entry) => [...(entry.payload?.records ?? []), ...(entry.payload?.facts ?? [])])];
  assert.ok(everything.every((item) => !(item.schemaVersion > 6)), 'nothing above 6');
  assert.equal(V7_FIELDS.some((field) => everything.some((item) => Object.hasOwn(item, field))), false, 'no v7 field survives');
  for (const entity of entitiesOf(payload)) assert.equal(bytes(output).includes(entity.erasureToken), false, 'no token survives');
  assert.deepEqual(report.removedFields.find((item) => item.id === claimed.id).fields.sort(), ['causalClaim', 'claims', 'erasureToken', 'outcomeEvidence']);
  for (const entity of entitiesOf(payload).filter((item) => item.id !== captured.id)) {
    assert.ok(report.removedFields.find((item) => item.id === entity.id)?.fields.includes('erasureToken'), `${entity.id}: its token is named`);
  }
  assert.deepEqual(report.carriedCollections.sort(), ['access', 'accessRevocations', 'futureCollection'], 'the carried collections are named, the grants among them');
  assert.equal(output.records.some((record) => record.id === captured.id), false);
  assert.ok(report.excluded.some((item) => item.id === captured.id && /result class/.test(item.reason)));
  assert.equal(output.idempotency.some((item) => item.value.id === captured.id), false, 'nor its retry value');
  assert.deepEqual(output.journal.map((entry) => [entry.type, entry.schemaVersion]), [['projection.baseline', 6]]);
  assert.equal(bytes(output.futureCollection), bytes(FUTURE));
  assert.equal(bytes(output.access), bytes(payload.access));
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(output), { now }));
  assert.throws(() => downgradeToSchema6(downgradeToSchema5(output, { now }).payload, { now }), /schema-7/, 'it converts schema-7 data only');
});

for (const backend of ['json', 'sqlite']) {
  test(`downgrade {toSchemaVersion: 6} on ${backend}: preservation copy first, a separate output, the v7 store untouched`, async (t) => {
    if (backend === 'sqlite' && !await sqliteOrSkip(t)) return;
    const directory = await scratchDirectory(t, `shadowgraph-v7-downgrade-${backend}-`);
    const { payload } = v7Fixture();
    const extension = backend === 'sqlite' ? 'db' : 'json';
    const file = join(directory, `data.${extension}`);
    if (backend === 'sqlite') { const store = await createSqliteStore(file); await store.save(structuredClone(payload)); store.close(); }
    else await writeFile(file, JSON.stringify(payload, null, 2));
    const before = sha256(await readFile(file));
    const output = join(directory, `downgraded.${extension}`);
    const preservationCopy = join(directory, `preserved.${extension}`);
    const run = runCli(['downgrade', JSON.stringify({ output, preservationCopy, toSchemaVersion: 6 })], file, backend);
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, 'complete');
    assert.equal(result.toSchemaVersion, 6);
    assert.equal(result.preservationCopy.verified, true);
    assert.equal(sha256(await readFile(preservationCopy)), result.preservationCopy.sha256);
    assert.equal(sha256(await readFile(file)), before, 'the v7 store is byte-identical');
    for (const entity of entitiesOf(payload)) assert.equal(run.stdout.includes(entity.erasureToken), false, 'the report names no token');
    const store = backend === 'sqlite' ? await createSqliteStore(output) : createJsonFileStore(output);
    const downgraded = await store.load();
    store.close?.();
    assert.equal(downgraded.schemaVersion, 6);
    assert.doesNotThrow(() => validateRestorePayload(downgraded, { now }));
    const overlap = runCli(['downgrade', JSON.stringify({ output: file, preservationCopy: join(directory, 'other.json'), toSchemaVersion: 6 })], file, backend);
    assert.notEqual(overlap.status, 0, 'overlapping paths are refused');
    assert.equal(sha256(await readFile(file)), before);
    const unknown = runCli(['downgrade', JSON.stringify({ output: join(directory, 'x.json'), preservationCopy: join(directory, 'y.json'), toSchemaVersion: 4 })], file, backend);
    assert.notEqual(unknown.status, 0, 'only 5 and 6 are targets');
    assert.equal(sha256(await readFile(file)), before);
    for (const name of ['other.json', 'x.json', 'x.json.report.json', 'y.json']) assert.equal(existsSync(join(directory, name)), false, `${name}: a refusal writes nothing`);
  });
}

test('the default downgrade from a schema-7 store still reaches schema 5, through 6, with one report', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v7-downgrade-chain-');
  const { payload, captured } = v7Fixture();
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  graph.addDecision({ originId: 'origin_a', title: 'Unowned', chosen: 'x' });
  const file = join(directory, 'data.json');
  await writeFile(file, JSON.stringify(privilegedSnapshot(graph), null, 2));
  const output = join(directory, 'downgraded.json');
  const result = await downgradeStore({ graph, store: createJsonFileStore(file), file, output, preservationCopy: join(directory, 'preserved.json'), now });
  assert.deepEqual({ status: result.status, from: result.fromSchemaVersion, to: result.toSchemaVersion }, { status: 'complete', from: 7, to: 5 });
  assert.ok(result.removedFields.some((item) => item.fields.includes('erasureToken')), 'the 7-to-6 step is reported');
  assert.ok(result.removedFields.some((item) => item.fields.includes('attribution')), 'and the 6-to-5 step');
  assert.ok(result.excluded.some((item) => item.id === captured.id));
  assert.ok(result.excluded.some((item) => /unattributed/.test(item.reason)));
  assert.ok(result.excludedCollections.includes('futureCollection'));
  const downgraded = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(downgraded.schemaVersion, 5);
  assert.doesNotThrow(() => validateRestorePayload(downgraded, { now }));
});

test('a schema 6 -> 7 -> 6 -> 7 round trip keeps every schema-6 field and the unknown collection, through JSON and SQLite files', async (t) => {
  const start = { ...v6Store(), futureCollection: FUTURE };
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(start));
  const decision = start.records.find((record) => record.kind === 'decision' && record.title === 'Cache');
  graph.updateDecisionStatus(decision.id, 'planned', { project: 'alpha' });
  graph.addDecision({ project: 'alpha', title: 'Written at 7', chosen: 'yes' });
  const first = privilegedSnapshot(graph);
  // What schema 6 can hold of the schema-7 store: everything but the token.
  const representable = (items) => byId(items.map(({ erasureToken, ...rest }) => ({ ...rest, ...(rest.schemaVersion === 7 ? { schemaVersion: 6 } : {}) })));
  const down = downgradeToSchema6(first, { now }).payload;
  const again = createShadowGraph({ now });
  again.importData(structuredClone(down));
  const second = privilegedSnapshot(again);
  for (const snapshot of [first, down, second]) assert.equal(bytes(snapshot.futureCollection), bytes(FUTURE));
  for (const key of ['records', 'facts', 'relations']) {
    assert.equal(bytes(byId(down[key])), bytes(representable(first[key])), `${key} after the fork`);
    assert.equal(bytes(byId(second[key])), bytes(byId(down[key])), `${key} after the round trip`);
  }
  assert.equal(entitiesOf(second).some((entity) => Object.hasOwn(entity, 'erasureToken')), false, 'reading it back gives none');
  // The schema-6 fork as a file each backend saves, reloads and a schema-7 graph reads.
  const directory = await scratchDirectory(t, 'shadowgraph-v7-roundtrip-');
  const backends = [['JSON', createJsonFileStore(join(directory, 'fork.json'))]];
  if (await sqliteOrSkip(t)) backends.push(['SQLite', await createSqliteStore(join(directory, 'fork.db'))]);
  for (const [label, store] of backends) {
    await store.save(structuredClone(down));
    const reloaded = createShadowGraph({ now });
    reloaded.importData(await store.load());
    store.close?.();
    const third = privilegedSnapshot(reloaded);
    assert.equal(bytes(third.futureCollection), bytes(FUTURE), label);
    for (const key of ['records', 'facts', 'relations']) assert.equal(same(byId(third[key])), same(byId(down[key])), `${label}: ${key}`);
  }
});

test('a merged entity that names no token keeps its own; a merge never changes or drops one', () => {
  const graph = createShadowGraph({ now });
  const decision = graph.addDecision({ project: 'alpha', title: 'Merge', chosen: 'a' });
  assert.equal(Object.hasOwn(decision, 'erasureToken'), false, 'the public result carries none');
  const before = privilegedSnapshot(graph);
  graph.importData({ schemaVersion: 5, records: [decision] });
  assert.deepEqual(privilegedSnapshot(graph), before, 'merging the public result back is a no-op');
  assert.throws(() => graph.importData({ schemaVersion: 7, records: [{ ...decision, erasureToken: 'tok_other' }] }), (error) => /cannot change or drop its erasureToken/.test(error.message) && !error.message.includes(before.records[0].erasureToken));
  const withJournal = createShadowGraph({ now });
  withJournal.importData(structuredClone(before));
  assert.deepEqual(privilegedSnapshot(withJournal).records, before.records, 'a full import keeps every token');
});

test('no transport returns a token: CLI writes and reads print none', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v7-cli-');
  const file = join(directory, 'data.json');
  const written = runCli(['decision', JSON.stringify({ project: 'alpha', title: 'Through the CLI', chosen: 'yes' })], file);
  assert.equal(written.status, 0, written.stderr);
  const listed = runCli(['list', JSON.stringify({ project: 'alpha' })], file);
  assert.equal(listed.status, 0, listed.stderr);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  const token = stored.records[0].erasureToken;
  assert.equal(typeof token, 'string');
  for (const run of [written, listed]) assert.equal(run.stdout.includes('erasureToken') || run.stdout.includes(token), false);
});
