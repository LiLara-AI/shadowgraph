import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph, SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS } from '../src/shadowgraph.js';
import { JOURNAL_ENTRY_TYPES, JOURNAL_SCHEMA_VERSION, READABLE_JOURNAL_SCHEMA_VERSION, REPLAYABLE_ENTRY_TYPES } from '../src/journal.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { restoreFile } from '../src/backup.js';
import { AUTHORITY_RESTORE_UNSUPPORTED, requiresLegacyPurgeMigration, validateRestorePayload } from '../src/restore-validation.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// PR-06 (plan v1.4.4 §9.2, §10.9.8; R16 rev 2 §7; P1 reconciliation F-13,
// F-14, F-15): the reader widens to schema 6 while the writer stays at 5, what
// this build does not understand survives load, save and restore in both
// backends, an authority-bearing restore is refused unless memory only was
// asked for, and entity.attributed is readable before anything writes it.

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'src', 'cli.js');
const FUTURE = { opaque: [{ id: 'f1', nested: { values: [1, 'two', null, true] } }], note: 'a collection this build does not know' };
const ACCESS = { lineageId: 'lineage-test', entries: [{ accessId: 'grant-1', type: 'grant', state: 'active' }] };
const REVOCATIONS = { lineageId: 'lineage-test', ledgerSeq: 1, entries: [{ accessId: 'grant-0', revokedAt: NOW }] };
const MEMORY_COLLECTIONS = ['records', 'facts', 'relations', 'reviewSignals', 'idempotency', 'events', 'journal'];
const bytes = (value) => JSON.stringify(value);
const byId = (items) => [...items].sort((left, right) => String(left.id).localeCompare(String(right.id)));

async function sqliteOrSkip(t) {
  try { return (await import('node:sqlite')).DatabaseSync; }
  catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return null; }
}

function seeded({ link = true } = {}) {
  const graph = createShadowGraph({ now });
  const decision = graph.addDecision({ project: 'alpha', title: 'Cache', chosen: 'redis' });
  const attempt = graph.addAttempt({ project: 'alpha', solution: 'warm-up script', result: 'worked' });
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'note', text: 'an alpha note' });
  graph.remember({ project: 'default', memoryType: 'note', key: 'legacy', text: 'a note from before attribution' });
  graph.addFact({ project: 'alpha', key: 'latency', value: 10 });
  graph.addDecision({ project: 'pending', title: 'Captured choice', chosen: 'queue', idempotencyKey: 'retry-1' });
  if (link) graph.link({ from: decision.id, to: attempt.id, relation: 'tried' });
  return graph;
}

const entityOf = (payload, predicate) => [...payload.records, ...payload.facts].find(predicate);

// What a schema-5 build wrote: no attribution, no origin, schema 5 throughout.
function asSchema5(payload) {
  const v5 = structuredClone(payload);
  v5.schemaVersion = 5;
  const strip = (entity) => {
    if (!entity || typeof entity !== 'object') return;
    delete entity.attribution;
    delete entity.originId;
    if (entity.schemaVersion === 6) entity.schemaVersion = 5;
  };
  for (const entity of [...v5.records, ...v5.facts, ...v5.relations]) strip(entity);
  for (const item of v5.idempotency) strip(item.value);
  for (const entry of v5.journal) { entry.schemaVersion = 5; strip(entry.payload); }
  return v5;
}

// Rewrite a schema-5 snapshot into the shape a schema-6 writer produces: schema 6
// throughout, every entity carrying its attribution. `owners` maps an entity id
// to { project, attribution, originId } -- or to null to leave that entity as a
// legacy schema-5 entity with no attribution. Idempotency keys and journal
// entries follow their entity, so the journal still reproduces the live state.
function toV6(payload, owners = {}) {
  const v6 = structuredClone(payload);
  v6.schemaVersion = 6;
  const ownerOf = (entity) => (Object.hasOwn(owners, entity.id) ? owners[entity.id] : { project: entity.project, attribution: 'project' });
  const upgrade = (entity) => {
    if (!entity || !['decision', 'attempt', 'memory', 'fact'].includes(entity.kind)) return;
    const owner = ownerOf(entity);
    if (owner === null) return;
    Object.assign(entity, { schemaVersion: 6, project: owner.project, attribution: owner.attribution });
    if (owner.originId) entity.originId = owner.originId;
  };
  const rekey = (key, entity) => {
    const owner = entity && ownerOf(entity);
    if (!owner || owner.attribution !== 'unattributed' || typeof key !== 'string') return key;
    return key.replace(`${entity.kind}:${entity.project}:`, `${entity.kind}@${JSON.stringify(owner.originId)}:`);
  };
  for (const item of v6.idempotency) { item.key = rekey(item.key, item.value); upgrade(item.value); }
  for (const entry of v6.journal) {
    entry.schemaVersion = 6;
    if (!entry.payload || typeof entry.payload !== 'object') continue;
    if (entry.idempotencyKey) entry.idempotencyKey = rekey(entry.idempotencyKey, entry.payload);
    const owner = entry.payload.id && ['decision', 'attempt', 'memory', 'fact'].includes(entry.payload.kind) ? ownerOf(entry.payload) : undefined;
    upgrade(entry.payload);
    if (owner) entry.project = owner.project;
  }
  for (const entity of [...v6.records, ...v6.facts]) upgrade(entity);
  for (const item of v6.events) {
    const target = entityOf(v6, (entity) => entity.id === (item.recordId ?? item.factId));
    if (target?.attribution === 'unattributed') delete item.project;
  }
  return v6;
}

function v6Store(options) {
  const snapshot = asSchema5(privilegedSnapshot(seeded(options)));
  const captured = entityOf(snapshot, (entity) => entity.project === 'pending');
  const legacy = entityOf(snapshot, (entity) => entity.project === 'default');
  return toV6(snapshot, {
    [captured.id]: { project: null, attribution: 'unattributed', originId: 'origin_a' },
    [legacy.id]: null
  });
}

test('the writer writes only what the reader already reads, on every versioned axis', () => {
  assert.equal(SCHEMA_VERSION, 6);
  assert.deepEqual(SUPPORTED_SCHEMA_VERSIONS, [1, 2, 3, 4, 5, 6]);
  assert.equal(JOURNAL_SCHEMA_VERSION, 6);
  assert.equal(READABLE_JOURNAL_SCHEMA_VERSION, 6);
  assert.ok(JOURNAL_SCHEMA_VERSION <= READABLE_JOURNAL_SCHEMA_VERSION && SUPPORTED_SCHEMA_VERSIONS.includes(SCHEMA_VERSION));
  const graph = seeded();
  const snapshot = privilegedSnapshot(graph);
  assert.equal(snapshot.schemaVersion, 6);
  assert.deepEqual([...new Set([...snapshot.records, ...snapshot.facts, ...snapshot.journal].map((item) => item.schemaVersion))], [6]);
  assert.equal([...snapshot.records, ...snapshot.facts].every((entity) => entity.attribution === 'project'), true);
});

test('a schema-6 store loads, validates, rebuilds and restores without being downgraded', () => {
  const payload = v6Store();
  const graph = createShadowGraph({ now });
  graph.importData(payload);
  const validation = graph.validate();
  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(validation.counts.unsupported, 0);
  const live = privilegedSnapshot(graph);
  const captured = live.records.find((record) => record.attribution === 'unattributed');
  assert.deepEqual({ project: captured.project, originId: captured.originId, schemaVersion: captured.schemaVersion }, { project: null, originId: 'origin_a', schemaVersion: 6 });
  const legacy = live.records.find((record) => record.project === 'default');
  assert.equal(Object.hasOwn(legacy, 'attribution'), false);
  const rebuilt = graph.rebuild();
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(byId(rebuilt.projection.records), byId(live.records));
  assert.doesNotThrow(() => validateRestorePayload(payload, { now }));
});

test('a schema-7 envelope is refused; a schema-7 entity loads but its store cannot be restored (F-14)', () => {
  assert.throws(() => createShadowGraph().importData({ schemaVersion: 7, records: [] }), (error) => error.code === 'unsupported_schema_version');
  const payload = v6Store();
  const future = payload.records.find((record) => record.kind === 'attempt');
  future.schemaVersion = 7;
  for (const entry of payload.journal) if (entry.entityId === future.id) entry.payload.schemaVersion = 7;
  const graph = createShadowGraph({ now });
  graph.importData(payload);
  assert.equal(privilegedSnapshot(graph).records.find((record) => record.id === future.id).schemaVersion, 7, 'preserved verbatim, never downgraded');
  assert.ok(graph.validate().issues.some((issue) => issue.code === 'unsupported_record_schema_version' && issue.severity === 'unsupported'));
  assert.throws(() => validateRestorePayload(payload, { now }), /Refusing to restore data: .*unsupported_record_schema_version/);
});

test('an unattributed entity never shares an owner with a project or with another origin', () => {
  const graph = createShadowGraph({ now });
  const base = privilegedSnapshot(seeded());
  const fact = base.facts[0];
  const memory = base.records.find((record) => record.kind === 'memory' && record.project === 'alpha');
  const owned = (entity, id, owner) => ({ ...structuredClone(entity), id, schemaVersion: 6, ...owner });
  graph.importData({
    schemaVersion: 6,
    facts: [
      owned(fact, 'fact-default', { project: 'default', attribution: 'project' }),
      owned(fact, 'fact-origin-a', { project: null, attribution: 'unattributed', originId: 'origin_a' }),
      owned(fact, 'fact-origin-b', { project: null, attribution: 'unattributed', originId: 'origin_b' })
    ],
    records: [
      owned(memory, 'memory-default', { project: 'default', attribution: 'project' }),
      owned(memory, 'memory-origin-a', { project: null, attribution: 'unattributed', originId: 'origin_a' }),
      owned(memory, 'memory-origin-b', { project: null, attribution: 'unattributed', originId: 'origin_b' })
    ]
  });
  const validation = graph.validate();
  assert.equal(validation.issues.some((issue) => /duplicate_active_(fact|memory)_scope/.test(issue.code)), false, JSON.stringify(validation.issues));
  const live = privilegedSnapshot(graph);
  assert.deepEqual(live.facts.filter((item) => item.status === 'active').map((item) => item.id).sort(), ['fact-default', 'fact-origin-a', 'fact-origin-b']);
  assert.equal(live.records.find((item) => item.id === 'memory-origin-a').project, null);

  // Absent origins never match each other either: two invalid unattributed
  // memories with no origin are reported, never merged into one bucket.
  const orphans = createShadowGraph({ now });
  orphans.importData({ schemaVersion: 6, records: [
    owned(memory, 'memory-orphan-1', { project: null, attribution: 'unattributed' }),
    owned(memory, 'memory-orphan-2', { project: null, attribution: 'unattributed' })
  ] });
  const orphanIssues = orphans.validate().issues;
  assert.equal(orphanIssues.filter((issue) => issue.code === 'invalid_attribution').length, 2);
  assert.equal(orphanIssues.some((issue) => issue.code === 'duplicate_active_memory_scope'), false);
});

test('an unattributed entity keeps its idempotency keys under its origin', () => {
  const payload = v6Store();
  const captured = payload.records.find((record) => record.attribution === 'unattributed');
  assert.deepEqual(payload.idempotency.map((item) => item.key), ['decision@"origin_a":retry-1']);
  assert.doesNotThrow(() => createShadowGraph({ now }).importData(payload));
  const forged = structuredClone(payload);
  forged.idempotency[0].key = 'decision:null:retry-1';
  assert.throws(() => createShadowGraph({ now }).importData(forged), /Idempotency entry identity does not match its entity/);
  const crossed = structuredClone(payload);
  crossed.idempotency[0].key = 'decision@"origin_b":retry-1';
  assert.throws(() => createShadowGraph({ now }).importData(crossed), /Idempotency entry identity does not match its entity/);
  const originless = structuredClone(payload);
  for (const entity of [originless.records.find((record) => record.attribution === 'unattributed'), originless.idempotency[0].value]) delete entity.originId;
  originless.idempotency[0].key = 'decision@null:retry-1';
  assert.throws(() => createShadowGraph({ now }).importData(originless), /Idempotency entry identity does not match its entity/, 'an absent origin owns no retry key');
  assert.equal(captured.project, null);
});

test('malformed attribution is declared as an error, not trusted', () => {
  for (const [label, owner] of [
    ['unattributed without an origin', { project: null, attribution: 'unattributed' }],
    ['unattributed inside a project', { project: 'alpha', attribution: 'unattributed', originId: 'origin_a' }],
    ['an unknown attribution', { project: 'alpha', attribution: 'somebody' }],
    ['a project attribution with no project', { project: null, attribution: 'project' }],
    ['a blank origin', { project: 'alpha', attribution: 'project', originId: '  ' }]
  ]) {
    const graph = createShadowGraph({ now });
    graph.importData({ schemaVersion: 6, records: [{ id: 'd1', kind: 'decision', title: 'T', chosen: 'C', schemaVersion: 6, ...owner }] });
    assert.ok(graph.validate().issues.some((issue) => issue.code === 'invalid_attribution' && issue.severity === 'error'), label);
  }
});

test('an unrecognised top-level collection is carried by the privileged snapshot and kept out of public reads', () => {
  const graph = createShadowGraph({ now });
  graph.importData({ ...privilegedSnapshot(seeded()), futureCollection: FUTURE, access: ACCESS, accessRevocations: REVOCATIONS, expectedRevision: 4 });
  const snapshot = privilegedSnapshot(graph);
  assert.equal(bytes(snapshot.futureCollection), bytes(FUTURE));
  assert.equal(bytes(snapshot.access), bytes(ACCESS));
  assert.equal(bytes(snapshot.accessRevocations), bytes(REVOCATIONS));
  assert.equal(Object.hasOwn(snapshot, 'expectedRevision'), false, 'a save instruction is not a collection');
  for (const [label, read] of [['exportData', graph.exportData()], ['redact', graph.redact({})], ['redact(project)', graph.redact({ project: 'alpha' })]]) {
    for (const key of ['futureCollection', 'access', 'accessRevocations']) assert.equal(Object.hasOwn(read, key), false, `${label} must not expose ${key}`);
  }
  // Replacing the graph replaces them too; a rejected replace keeps them.
  assert.throws(() => graph.replaceData({ schemaVersion: 99 }));
  assert.equal(bytes(privilegedSnapshot(graph).futureCollection), bytes(FUTURE));
  graph.replaceData(privilegedSnapshot(seeded()));
  assert.equal(Object.hasOwn(privilegedSnapshot(graph), 'futureCollection'), false);
});

test('JSON: an unrecognised collection survives load, save and reload byte-equal, through the kernel and the CLI', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v6-json-');
  const file = join(directory, 'data.json');
  await writeFile(file, JSON.stringify({ ...toV6(privilegedSnapshot(seeded())), futureCollection: FUTURE, access: ACCESS, accessRevocations: REVOCATIONS }, null, 2));
  const store = createJsonFileStore(file);
  const graph = createShadowGraph({ now });
  graph.importData(await store.load());
  graph.addDecision({ project: 'alpha', title: 'After reload', chosen: 'yes' });
  await store.save(privilegedSnapshot(graph));
  const reloaded = JSON.parse(await readFile(file, 'utf8'));
  for (const [key, value] of [['futureCollection', FUTURE], ['access', ACCESS], ['accessRevocations', REVOCATIONS]]) assert.equal(bytes(reloaded[key]), bytes(value), key);

  const run = spawnSync(process.execPath, [cli, 'decision', JSON.stringify({ project: 'alpha', title: 'Through the CLI', chosen: 'yes' })], { env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const afterCli = JSON.parse(await readFile(file, 'utf8'));
  for (const [key, value] of [['futureCollection', FUTURE], ['access', ACCESS], ['accessRevocations', REVOCATIONS]]) assert.equal(bytes(afterCli[key]), bytes(value), `CLI save: ${key}`);
  assert.ok(afterCli.records.some((record) => record.title === 'Through the CLI'));
});

async function restoreLoadSaveReload(t, backup) {
  const directory = await scratchDirectory(t, 'shadowgraph-v6-json-restore-');
  const source = join(directory, 'backup.json');
  const destination = join(directory, 'data.json');
  await writeFile(source, JSON.stringify(backup, null, 2));
  const live = createShadowGraph({ now });
  await restoreFile(source, destination, { afterReplace: (payload) => live.replaceData(payload) });
  const installed = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(bytes(installed.futureCollection), bytes(FUTURE), 'restore installs it');
  assert.equal(bytes(privilegedSnapshot(live).futureCollection), bytes(FUTURE), 'the activated graph holds it');
  const store = createJsonFileStore(destination);
  const graph = createShadowGraph({ now });
  graph.importData(await store.load());
  graph.addDecision({ project: 'alpha', title: 'After restore', chosen: 'yes' });
  await store.save(privilegedSnapshot(graph));
  const reloaded = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(bytes(reloaded.futureCollection), bytes(FUTURE), 'restore -> load -> save -> reload');
}

test('JSON restore keeps an unrecognised collection through restore, load, save and reload (raw branch, F-15)', async (t) => {
  const backup = { ...privilegedSnapshot(seeded()), futureCollection: FUTURE };
  assert.equal(requiresLegacyPurgeMigration(backup), false);
  await restoreLoadSaveReload(t, backup);
});

test('JSON restore keeps an unrecognised collection through the legacy-purge normalised branch (F-15)', async (t) => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'keep', title: 'Kept', chosen: 'x' });
  const backup = privilegedSnapshot(graph);
  backup.schemaVersion = 4;
  for (const entry of backup.journal) entry.schemaVersion = 4;
  backup.journal.push({
    id: 'legacy-purge-marker', seq: backup.journalSeq + 1, type: 'project.purged', at: NOW, project: 'gone',
    entityKind: 'project', entityId: null, schemaVersion: 4,
    payload: { project: 'gone', mode: 'logical', removed: 0, purgedEntityIds: [] },
    provenance: { actor: null, client: null, sessionId: null }
  });
  backup.journalSeq += 1;
  backup.futureCollection = FUTURE;
  assert.equal(requiresLegacyPurgeMigration(backup), true);
  await restoreLoadSaveReload(t, backup);
});

test('SQLite: the generic carrier round-trips unrecognised collections across reopen and save', async (t) => {
  const DatabaseSync = await sqliteOrSkip(t);
  if (!DatabaseSync) return;
  const directory = await scratchDirectory(t, 'shadowgraph-v6-sqlite-');
  const file = join(directory, 'data.db');
  const first = await createSqliteStore(file);
  await first.save({ ...toV6(privilegedSnapshot(seeded())), futureCollection: FUTURE, access: ACCESS, accessRevocations: REVOCATIONS });
  first.close();
  const reopened = await createSqliteStore(file);
  const loaded = await reopened.load();
  for (const [key, value] of [['futureCollection', FUTURE], ['access', ACCESS], ['accessRevocations', REVOCATIONS]]) assert.equal(bytes(loaded[key]), bytes(value), key);
  const graph = createShadowGraph({ now });
  graph.importData(loaded);
  graph.addDecision({ project: 'alpha', title: 'After reopen', chosen: 'yes' });
  await reopened.save(privilegedSnapshot(graph));
  const again = await (await createSqliteStore(file)).load();
  for (const [key, value] of [['futureCollection', FUTURE], ['access', ACCESS], ['accessRevocations', REVOCATIONS]]) assert.equal(bytes(again[key]), bytes(value), `after save: ${key}`);
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(database.prepare('SELECT collection FROM shadowgraph_extra ORDER BY rowid').all().map((row) => row.collection), ['futureCollection', 'access', 'accessRevocations']);
  } finally { database.close(); }
  // A carrier row named after a native key never overwrites real data.
  const writable = new DatabaseSync(file);
  try { writable.prepare('INSERT INTO shadowgraph_extra (collection, payload) VALUES (?, ?)').run('records', '[]'); } finally { writable.close(); }
  assert.ok((await (await createSqliteStore(file)).load()).records.length > 0);
});

test('SQLite restore keeps an unrecognised collection through restore, open, save and reopen; a pre-carrier snapshot still restores', async (t) => {
  const DatabaseSync = await sqliteOrSkip(t);
  if (!DatabaseSync) return;
  const directory = await scratchDirectory(t, 'shadowgraph-v6-sqlite-restore-');
  const sourceFile = join(directory, 'source.db');
  const source = await createSqliteStore(sourceFile);
  await source.save({ ...privilegedSnapshot(seeded()), futureCollection: FUTURE });
  source.close();
  const destinationFile = join(directory, 'data.db');
  const destination = await createSqliteStore(destinationFile);
  const live = createShadowGraph({ now });
  await destination.restore(sourceFile, { afterReplace: (payload) => live.replaceData(payload) });
  assert.equal(bytes(privilegedSnapshot(live).futureCollection), bytes(FUTURE));
  const graph = createShadowGraph({ now });
  graph.importData(await destination.load());
  graph.addDecision({ project: 'alpha', title: 'After restore', chosen: 'yes' });
  await destination.save(privilegedSnapshot(graph));
  assert.equal(bytes((await (await createSqliteStore(destinationFile)).load()).futureCollection), bytes(FUTURE));

  // A snapshot written before the carrier existed has no shadowgraph_extra table.
  const oldFile = join(directory, 'old.db');
  const old = await createSqliteStore(oldFile);
  await old.save(privilegedSnapshot(seeded()));
  old.close();
  const database = new DatabaseSync(oldFile);
  try { database.exec('DROP TABLE shadowgraph_extra'); } finally { database.close(); }
  const target = await createSqliteStore(join(directory, 'target.db'));
  await target.restore(oldFile);
  assert.equal((await target.load()).records.length, privilegedSnapshot(seeded()).records.length);
});

test('an authority-bearing restore is refused at this build (JSON, SQLite and restore validation)', async (t) => {
  const backup = { ...privilegedSnapshot(seeded()), access: ACCESS, accessRevocations: REVOCATIONS };
  assert.throws(() => validateRestorePayload(backup, { now }), (error) => error.code === AUTHORITY_RESTORE_UNSUPPORTED);
  for (const key of ['access', 'accessRevocations']) {
    const one = { ...privilegedSnapshot(seeded()), [key]: key === 'access' ? ACCESS : REVOCATIONS };
    assert.throws(() => validateRestorePayload(one, { now }), (error) => error.code === AUTHORITY_RESTORE_UNSUPPORTED && error.collections.join() === key);
  }
  const directory = await scratchDirectory(t, 'shadowgraph-v6-authority-');
  const source = join(directory, 'backup.json');
  const destination = join(directory, 'data.json');
  await writeFile(source, JSON.stringify(backup));
  const before = JSON.stringify(privilegedSnapshot(seeded()));
  await writeFile(destination, before);
  await assert.rejects(restoreFile(source, destination), (error) => error.code === AUTHORITY_RESTORE_UNSUPPORTED);
  assert.equal(await readFile(destination, 'utf8'), before, 'the destination is untouched');

  const DatabaseSync = await sqliteOrSkip(t);
  if (!DatabaseSync) return;
  const sqliteSource = join(directory, 'backup.db');
  const store = await createSqliteStore(sqliteSource);
  await store.save(backup);
  store.close();
  const target = await createSqliteStore(join(directory, 'data.db'));
  await target.save(privilegedSnapshot(seeded()));
  const targetBefore = bytes(await target.load());
  await assert.rejects(target.restore(sqliteSource), (error) => error.code === AUTHORITY_RESTORE_UNSUPPORTED);
  assert.equal(bytes(await target.load()), targetBefore, 'the SQLite destination is untouched');
});

test('a memory-only restore strips the authority collections and restores every memory collection (JSON, SQLite, CLI)', async (t) => {
  const memory = { ...privilegedSnapshot(seeded()), futureCollection: FUTURE };
  const backup = { ...memory, access: ACCESS, accessRevocations: REVOCATIONS };
  const directory = await scratchDirectory(t, 'shadowgraph-v6-memory-only-');
  const source = join(directory, 'backup.json');
  await writeFile(source, JSON.stringify(backup));

  const destination = join(directory, 'data.json');
  const live = createShadowGraph({ now });
  await restoreFile(source, destination, { memoryOnly: true, afterReplace: (payload) => live.replaceData(payload) });
  const installed = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(Object.hasOwn(installed, 'access') || Object.hasOwn(installed, 'accessRevocations'), false);
  for (const key of [...MEMORY_COLLECTIONS, 'futureCollection']) assert.equal(bytes(installed[key]), bytes(memory[key]), `JSON ${key}`);
  assert.equal(Object.hasOwn(privilegedSnapshot(live), 'access'), false, 'nothing to reactivate later');

  const cliDestination = join(directory, 'cli.json');
  const refused = spawnSync(process.execPath, [cli, 'restore', source], { env: { ...process.env, SHADOWGRAPH_FILE: cliDestination, SHADOWGRAPH_STORAGE: 'json' }, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing to restore authority collections/);
  const accepted = spawnSync(process.execPath, [cli, 'restore', source, '--memory-only'], { env: { ...process.env, SHADOWGRAPH_FILE: cliDestination, SHADOWGRAPH_STORAGE: 'json' }, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  const cliInstalled = JSON.parse(await readFile(cliDestination, 'utf8'));
  assert.equal(Object.hasOwn(cliInstalled, 'access'), false);
  assert.equal(bytes(cliInstalled.records), bytes(memory.records));

  const DatabaseSync = await sqliteOrSkip(t);
  if (!DatabaseSync) return;
  const sqliteSource = join(directory, 'backup.db');
  const store = await createSqliteStore(sqliteSource);
  await store.save(backup);
  store.close();
  const target = await createSqliteStore(join(directory, 'data.db'));
  const sqliteLive = createShadowGraph({ now });
  await target.restore(sqliteSource, { memoryOnly: true, afterReplace: (payload) => sqliteLive.replaceData(payload) });
  const restored = await target.load();
  assert.equal(Object.hasOwn(restored, 'access') || Object.hasOwn(restored, 'accessRevocations'), false);
  for (const key of [...MEMORY_COLLECTIONS, 'futureCollection']) assert.equal(bytes(restored[key]), bytes(memory[key]), `SQLite ${key}`);
  const database = new DatabaseSync(join(directory, 'data.db'), { readOnly: true });
  try {
    assert.deepEqual(database.prepare('SELECT collection FROM shadowgraph_extra ORDER BY rowid').all().map((row) => row.collection), ['futureCollection']);
  } finally { database.close(); }
});

test('entity.attributed is in the replay vocabulary, and only the attribution migration writes it', async () => {
  assert.equal(REPLAYABLE_ENTRY_TYPES.length, 20);
  assert.equal(JOURNAL_ENTRY_TYPES.length, 21);
  assert.equal(REPLAYABLE_ENTRY_TYPES.at(-1), 'entity.attributed');
  assert.deepEqual([...JOURNAL_ENTRY_TYPES], [...REPLAYABLE_ENTRY_TYPES, 'legacy_metadata_event']);
  const emitters = [];
  for (const name of await readdir(join(root, 'src'))) {
    if (!name.endsWith('.js')) continue;
    if (/type:\s*'entity\.attributed'/.test(await readFile(join(root, 'src', name), 'utf8'))) emitters.push(name);
  }
  // The reader landed first with no writer; the schema-6 writer adds exactly one
  // (migrateAttribution, reason `migration`). User re-attribution is later work.
  assert.deepEqual(emitters, ['shadowgraph.js']);
  const kernel = await readFile(join(root, 'src', 'shadowgraph.js'), 'utf8');
  assert.equal(kernel.match(/type:\s*'entity\.attributed'/g).length, 1);
  assert.match(kernel, /reason: 'migration'/);
  assert.doesNotMatch(kernel, /reason: 'user'/);
});

// Append one entity.attributed entry carrying `next` (the post-change entity),
// and make it the live entity, exactly as a writer would.
function attribute(payload, next, change) {
  const collection = next.kind === 'fact' ? payload.facts : payload.records;
  collection[collection.findIndex((item) => item.id === next.id)] = next;
  payload.journalSeq += 1;
  payload.journal.push({
    id: `attributed-${next.id}`, seq: payload.journalSeq, type: 'entity.attributed', at: NOW,
    project: next.project, entityKind: next.kind, entityId: next.id, schemaVersion: 6,
    payload: { ...next, attributionChange: change }, provenance: { actor: null, client: null, sessionId: null }
  });
  return payload;
}

function reattributedStore(options) {
  const payload = v6Store(options);
  const pick = (predicate) => structuredClone(entityOf(payload, predicate));
  const decision = pick((entity) => entity.kind === 'decision' && entity.project === 'alpha');
  const attempt = pick((entity) => entity.kind === 'attempt');
  const fact = pick((entity) => entity.kind === 'fact');
  const legacy = pick((entity) => entity.project === 'default');
  attribute(payload, { ...decision, project: 'beta' }, { previousProject: 'alpha', previousAttribution: 'project', reason: 'user' });
  attribute(payload, { ...attempt, project: 'beta' }, { previousProject: 'alpha', previousAttribution: 'project', reason: 'user' });
  attribute(payload, { ...fact, project: 'beta' }, { previousProject: 'alpha', previousAttribution: 'project', reason: 'user' });
  attribute(payload, { ...legacy, schemaVersion: 6, attribution: 'legacy_ambiguous' }, { previousProject: 'default', previousAttribution: null, reason: 'migration' });
  return { payload, ids: { decision: decision.id, attempt: attempt.id, fact: fact.id, legacy: legacy.id } };
}

test('entity.attributed replays to the re-attributed entity: rebuild parity and restore parity (F-13)', () => {
  const { payload, ids } = reattributedStore();
  const graph = createShadowGraph({ now });
  graph.importData(payload);
  assert.equal(graph.validate().valid, true, JSON.stringify(graph.validate().issues));
  const live = privilegedSnapshot(graph);
  const rebuilt = graph.rebuild();
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(byId(rebuilt.projection.records), byId(live.records));
  assert.deepEqual(byId(rebuilt.projection.facts), byId(live.facts));
  const find = (items, id) => items.find((item) => item.id === id);
  for (const id of [ids.decision, ids.attempt]) assert.equal(find(rebuilt.projection.records, id).project, 'beta');
  assert.equal(find(rebuilt.projection.facts, ids.fact).project, 'beta');
  assert.equal(find(rebuilt.projection.records, ids.legacy).attribution, 'legacy_ambiguous');
  assert.equal(JSON.stringify(rebuilt.projection).includes('attributionChange'), false, 'the audit object never enters an entity');
  assert.doesNotThrow(() => validateRestorePayload(payload, { now }));
});

// Entities only: a relation.created entry keeps the project label of its source
// at creation, so purging that project after both endpoints moved scrubs the
// entry while the live relation survives. That is purge behaviour, not reading,
// and it only arises once something writes a user re-attribution; it is
// recorded for the change-set that does.
test('purging the source project after re-attribution keeps the re-attributed records and a clean rebuild (F-13)', () => {
  for (const mode of ['logical', 'hard']) {
    const { payload, ids } = reattributedStore({ link: false });
    const graph = createShadowGraph({ now });
    graph.importData(payload);
    graph.purgeProject('alpha', { mode });
    const live = privilegedSnapshot(graph);
    for (const id of [ids.decision, ids.attempt]) assert.equal(live.records.find((record) => record.id === id)?.project, 'beta', `${mode}: ${id}`);
    assert.equal(live.facts.find((fact) => fact.id === ids.fact)?.project, 'beta');
    assert.equal(live.records.some((record) => record.project === 'alpha'), false);
    assert.equal(graph.validate().valid, true, `${mode}: ${JSON.stringify(graph.validate().issues)}`);
    const rebuilt = graph.rebuild();
    // A hard purge that removes the leading entries leaves a declared leading
    // gap; that is the existing contract, accepted by restore validation
    // through the purge ledger. Nothing else may stop the rebuild.
    if (mode === 'hard' && !rebuilt.rebuildable) assert.equal(rebuilt.reason, 'journal epoch is outside the available sequence range');
    else assert.equal(rebuilt.rebuildable, true, `${mode}: ${rebuilt.reason}`);
    assert.deepEqual(byId(rebuilt.projection.records), byId(live.records), mode);
    assert.deepEqual(byId(rebuilt.projection.facts), byId(live.facts), mode);
    assert.doesNotThrow(() => validateRestorePayload(live, { now }), mode);
  }
});

test('entity.attributed cannot change a fact lifecycle, or arrive without its kind and reason', () => {
  const change = { previousProject: 'alpha', previousAttribution: 'project', reason: 'user' };
  // A superseded fact carried as active: the journal alone claims a revival.
  const graph = seeded();
  graph.addFact({ project: 'alpha', key: 'latency', value: 12 });
  const revived = toV6(privilegedSnapshot(graph));
  const superseded = structuredClone(revived.facts.find((fact) => fact.status === 'superseded'));
  revived.journalSeq += 1;
  revived.journal.push({
    id: 'attributed-revival', seq: revived.journalSeq, type: 'entity.attributed', at: NOW, project: 'beta',
    entityKind: 'fact', entityId: superseded.id, schemaVersion: 6,
    payload: { ...superseded, project: 'beta', status: 'active', attributionChange: change },
    provenance: { actor: null, client: null, sessionId: null }
  });
  assert.throws(() => createShadowGraph({ now }).importData(revived), /non-monotonic/, 'terminal fact revived through attribution');

  const variants = [
    ['a fact verified through attribution', (fact) => ({ next: { ...fact, verificationStatus: 'verified', verification: { verifierIdentity: 'nobody' } }, attributionChange: change }), /non-monotonic/],
    ['no attributionChange', (fact) => ({ next: fact, attributionChange: undefined }), /attributionChange/],
    ['an unknown reason', (fact) => ({ next: fact, attributionChange: { reason: 'guess' } }), /attributionChange/]
  ];
  for (const [label, variant, pattern] of variants) {
    const payload = v6Store();
    const { next, attributionChange } = variant(structuredClone(payload.facts[0]));
    attribute(payload, next, attributionChange);
    if (attributionChange === undefined) delete payload.journal.at(-1).payload.attributionChange;
    assert.throws(() => createShadowGraph({ now }).importData(payload), pattern, label);
  }
  const payload = v6Store();
  attribute(payload, structuredClone(payload.facts[0]), change);
  payload.journal.at(-1).entityKind = 'relation';
  assert.throws(() => createShadowGraph({ now }).importData(payload), /entity\.attributed requires entityKind/);
});
