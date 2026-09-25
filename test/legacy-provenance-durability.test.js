import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { privilegedRebuild, privilegedSnapshot, privilegedValidate } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// P1A correction IR-01 (F-22; plan v1.4.4 WS-11 mapping iii): a legacy entity
// stored with no project must still be recognisable as legacy_unattributed
// after any save and restart that happens before its attribution migration,
// on JSON and on SQLite, whatever batch the interruption falls in.

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const src = (name) => new URL(`../src/${name}`, import.meta.url).href;

async function sqliteOrSkip(t) {
  try { await import('node:sqlite'); return true; }
  catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return false; }
}

const PROJECTLESS = ['decision-z-projectless', 'attempt-z-projectless', 'memory-z-projectless', 'fact-z-projectless'];

// A schema-5 store: an explicit project, several literal "default" records,
// and one record of every kind stored with no project, each sorted last in
// its kind so the migration reaches it after the others -- the projectless
// fact last of all.
function legacyPayload({ defaults = 3 } = {}) {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', id: 'decision-alpha', title: 'Alpha', chosen: 'x' });
  for (let index = 1; index <= defaults; index += 1) graph.addDecision({ project: 'default', id: `decision-default-${String(index).padStart(2, '0')}`, title: `Default ${index}`, chosen: 'y' });
  graph.addDecision({ project: 'default', id: 'decision-z-projectless', title: 'Stored without a project', chosen: 'z' });
  graph.addAttempt({ project: 'default', id: 'attempt-default', solution: 's', result: 'r' });
  graph.addAttempt({ project: 'default', id: 'attempt-z-projectless', solution: 's2', result: 'r2' });
  graph.remember({ project: 'default', id: 'memory-default', memoryType: 'note', key: 'kept', text: 'default note' });
  graph.remember({ project: 'default', id: 'memory-z-projectless', memoryType: 'note', key: 'other', text: 'projectless note' });
  graph.addFact({ project: 'default', id: 'fact-default', key: 'latency', value: 10 });
  graph.addFact({ project: 'default', id: 'fact-z-projectless', key: 'throughput', value: 5 });
  const payload = privilegedSnapshot(graph);
  payload.schemaVersion = 5;
  const strip = (entity) => {
    if (!entity || typeof entity !== 'object') return;
    delete entity.attribution;
    delete entity.originId;
    if (entity.schemaVersion === 6) entity.schemaVersion = 5;
  };
  for (const entity of [...payload.records, ...payload.facts, ...payload.relations]) strip(entity);
  for (const entry of payload.journal) { entry.schemaVersion = 5; strip(entry.payload); }
  for (const entity of [...payload.records, ...payload.facts]) if (PROJECTLESS.includes(entity.id)) delete entity.project;
  for (const entry of payload.journal) if (PROJECTLESS.includes(entry.entityId)) { delete entry.payload.project; entry.project = null; }
  return payload;
}

function expectedOwners(defaults = 3) {
  const expected = { 'decision-alpha': ['alpha', 'project'] };
  for (let index = 1; index <= defaults; index += 1) expected[`decision-default-${String(index).padStart(2, '0')}`] = ['default', 'legacy_ambiguous'];
  for (const id of ['attempt-default', 'memory-default', 'fact-default']) expected[id] = ['default', 'legacy_ambiguous'];
  for (const id of PROJECTLESS) expected[id] = ['default', 'legacy_unattributed'];
  return expected;
}
const owners = (payload) => Object.fromEntries([...payload.records, ...payload.facts].map((entity) => [entity.id, [entity.project, entity.attribution]]));
const attributed = (payload) => payload.journal.filter((entry) => entry.type === 'entity.attributed');
const TOTAL = Object.keys(expectedOwners()).length;

const BACKENDS = {
  json: {
    file: 'data.json',
    open: async (file) => createJsonFileStore(file),
    seed: (file, payload) => writeFile(file, JSON.stringify(payload, null, 2))
  },
  sqlite: {
    file: 'data.db',
    open: (file) => createSqliteStore(file),
    seed: async (file, payload) => { const store = await createSqliteStore(file); try { await store.save(payload); } finally { store.close(); } }
  }
};

// One process lifetime: load the store, do some work, save, close.
async function session(backend, file, work = () => {}) {
  const store = await BACKENDS[backend].open(file);
  try {
    const graph = createShadowGraph({ now });
    graph.importData(await store.load());
    const result = work(graph);
    graph.setRevision(await store.save(privilegedSnapshot(graph)));
    return result;
  } finally { store.close?.(); }
}

async function finalState(backend, file) {
  const store = await BACKENDS[backend].open(file);
  try {
    const graph = createShadowGraph({ now });
    graph.importData(await store.load());
    return { graph, snapshot: privilegedSnapshot(graph) };
  } finally { store.close?.(); }
}

function uninterrupted(defaults = 3) {
  const graph = createShadowGraph({ now });
  graph.importData(legacyPayload({ defaults }));
  graph.migrateAttribution();
  return privilegedSnapshot(graph);
}

const canonicalEntities = (snapshot) => [...snapshot.records, ...snapshot.facts].sort((left, right) => left.id.localeCompare(right.id));
const attributionLog = (snapshot) => attributed(snapshot).map((entry) => ({ entityId: entry.entityId, project: entry.project, payload: entry.payload }));

function assertMatchesUninterrupted(graph, snapshot, reference, defaults, label) {
  assert.deepEqual(owners(snapshot), expectedOwners(defaults), `${label}: three distinct mappings, none collapsed`);
  assert.deepEqual(canonicalEntities(snapshot), canonicalEntities(reference), `${label}: the same canonical entities as an uninterrupted run`);
  assert.deepEqual(attributionLog(snapshot), attributionLog(reference), `${label}: the same attribution journal as an uninterrupted run`);
  const ids = attributed(snapshot).map((entry) => entry.entityId);
  assert.equal(ids.length, new Set(ids).size, `${label}: no entity attributed twice`);
  for (const entry of attributed(snapshot)) {
    const previous = PROJECTLESS.includes(entry.entityId) ? null : entry.entityId === 'decision-alpha' ? 'alpha' : 'default';
    assert.equal(entry.payload.attributionChange.previousProject, previous, `${label}: ${entry.entityId} audit records what was stored`);
  }
  const validation = privilegedValidate(graph);
  assert.equal(validation.valid, true, `${label}: ${JSON.stringify(validation.issues)}`);
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, `${label}: ${rebuilt.reason}`);
  assert.deepEqual(owners(rebuilt.projection), expectedOwners(defaults), `${label}: a rebuild reproduces the attribution`);
}

for (const backend of Object.keys(BACKENDS)) {
  test(`every batch cut: save and restart before the projectless entities migrate still yields legacy_unattributed (${backend})`, async (t) => {
    if (backend === 'sqlite' && !await sqliteOrSkip(t)) return;
    const directory = await scratchDirectory(t, `shadowgraph-ir01-cuts-${backend}-`);
    const reference = uninterrupted();
    // Cut 0 restarts before any migration; cut 10 stops with only the last
    // projectless entity still pending.
    for (let cut = 0; cut < TOTAL; cut += 1) {
      await t.test(`restart after ${cut} of ${TOTAL} migrated`, async () => {
        const file = join(directory, `${cut}-${BACKENDS[backend].file}`);
        await BACKENDS[backend].seed(file, legacyPayload());
        const first = await session(backend, file, (graph) => (cut ? graph.migrateAttribution({ limit: cut }) : null));
        if (first) assert.equal(first.migrated, cut);
        const pending = owners((await finalState(backend, file)).snapshot);
        assert.ok(PROJECTLESS.some((id) => pending[id][1] === undefined), 'the restart happens while a projectless entity is still unmigrated');
        const rest = await session(backend, file, (graph) => graph.migrateAttribution());
        assert.deepEqual({ migrated: rest.migrated, complete: rest.complete }, { migrated: TOTAL - cut, complete: true });
        const { graph, snapshot } = await finalState(backend, file);
        assertMatchesUninterrupted(graph, snapshot, reference, 3, `cut ${cut}`);
      });
    }
  });

  test(`repeated interruption: batch size 1 and 4 with a restart after every batch, and restarts before any migration (${backend})`, async (t) => {
    if (backend === 'sqlite' && !await sqliteOrSkip(t)) return;
    const directory = await scratchDirectory(t, `shadowgraph-ir01-cycles-${backend}-`);
    const defaults = 12;
    const reference = uninterrupted(defaults);
    const total = Object.keys(expectedOwners(defaults)).length;
    for (const batchSize of [1, 4]) {
      const file = join(directory, `batch-${batchSize}-${BACKENDS[backend].file}`);
      await BACKENDS[backend].seed(file, legacyPayload({ defaults }));
      // Two restarts before any migration at all.
      await session(backend, file);
      await session(backend, file);
      let cycles = 0;
      for (;;) {
        const batch = await session(backend, file, (graph) => graph.migrateAttribution({ limit: batchSize }));
        cycles += 1;
        if (batch.complete) break;
      }
      assert.equal(cycles, Math.ceil(total / batchSize));
      const { graph, snapshot } = await finalState(backend, file);
      assertMatchesUninterrupted(graph, snapshot, reference, defaults, `batch size ${batchSize}`);
    }
  });

  test(`separate OS processes: save before migration, migrate part, stop, and finish in a new process (${backend})`, async (t) => {
    if (backend === 'sqlite' && !await sqliteOrSkip(t)) return;
    const directory = await scratchDirectory(t, `shadowgraph-ir01-process-${backend}-`);
    const file = join(directory, BACKENDS[backend].file);
    await BACKENDS[backend].seed(file, legacyPayload());
    const step = (limit) => {
      const script = `
        const { createShadowGraph } = await import(${JSON.stringify(src('shadowgraph.js'))});
        const { createStorage } = await import(${JSON.stringify(src('storage.js'))});
        const { privilegedSnapshot } = await import(${JSON.stringify(src('internal/snapshot.js'))});
        const store = await createStorage({ type: ${JSON.stringify(backend)}, file: ${JSON.stringify(file)} });
        const graph = createShadowGraph({ now: () => ${JSON.stringify(NOW)} });
        graph.importData(await store.load());
        const result = ${limit} ? graph.migrateAttribution({ limit: ${limit} }) : null;
        await store.save(privilegedSnapshot(graph));
        store.close?.();
        process.stdout.write(JSON.stringify(result));`;
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout);
    };
    assert.equal(step(0), null, 'first process: load and save, no migration');
    assert.equal(step(2).migrated, 2, 'second process: two entities, neither projectless');
    assert.equal(step(Number.MAX_SAFE_INTEGER).complete, true, 'third process: the rest');
    const { graph, snapshot } = await finalState(backend, file);
    assertMatchesUninterrupted(graph, snapshot, uninterrupted(), 3, 'three processes');
  });
}

test('replaceData and a JSON backup/restore taken before migration keep the absence', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-ir01-restore-');
  const live = join(directory, 'live.json');
  await BACKENDS.json.seed(live, legacyPayload());
  await session('json', live);
  const backup = join(directory, 'backup.json');
  await backupFile(live, backup);
  const restored = join(directory, 'restored.json');
  await restoreFile(backup, restored);
  await session('json', restored, (graph) => graph.migrateAttribution());
  const fromRestore = await finalState('json', restored);
  assertMatchesUninterrupted(fromRestore.graph, fromRestore.snapshot, uninterrupted(), 3, 'restored');

  const staged = createShadowGraph({ now });
  staged.importData(legacyPayload());
  const replaced = createShadowGraph({ now });
  replaced.addDecision({ project: 'beta', title: 'Discarded by the replacement', chosen: 'x' });
  replaced.replaceData(privilegedSnapshot(staged));
  const resumed = createShadowGraph({ now });
  resumed.importData(JSON.parse(JSON.stringify(privilegedSnapshot(replaced))));
  resumed.migrateAttribution();
  assert.deepEqual(owners(privilegedSnapshot(resumed)), expectedOwners());
});

test('a replaceData that fails after clearing the live graph rolls the absence back with the records', () => {
  const payload = legacyPayload();
  // A stored fact verification that is still valid when the staging graph
  // checks it and has expired when the live graph re-imports it.
  payload.facts.find((fact) => fact.id === 'fact-default').verification = { synthetic: true };
  let calls = 0;
  let failFrom = Infinity;
  const verifier = { verify() {}, validateStored() { calls += 1; return calls < failFrom; } };
  const graph = createShadowGraph({ now, verifier });
  graph.importData(structuredClone(payload));
  const before = privilegedSnapshot(graph);
  assert.deepEqual(before.storedWithoutProject, [...PROJECTLESS].sort());
  failFrom = calls + 2;
  assert.throws(() => graph.replaceData(structuredClone(payload)), /verification is invalid or expired/);
  assert.deepEqual(privilegedSnapshot(graph), before, 'the failed replacement leaves the graph, the list included, as it was');
  graph.migrateAttribution();
  for (const id of PROJECTLESS) assert.equal(owners(privilegedSnapshot(graph))[id][1], 'legacy_unattributed', id);
});

test('the recorded absence lists exactly the pending projectless entities, never demotes an explicit project, and leaves once they migrate', () => {
  const payload = legacyPayload();
  // A list naming an entity that has a real project is not believed.
  payload.storedWithoutProject = ['decision-alpha'];
  const graph = createShadowGraph({ now });
  graph.importData(payload);
  assert.deepEqual(privilegedSnapshot(graph).storedWithoutProject, [...PROJECTLESS].sort(), 'a stored "default" is not listed, nor a claim about "alpha"');
  assert.equal(Object.hasOwn(graph.exportData(), 'storedWithoutProject'), false, 'never part of a public read');
  graph.migrateAttribution({ limit: 6 });
  assert.deepEqual(privilegedSnapshot(graph).storedWithoutProject, ['attempt-z-projectless', 'fact-z-projectless', 'memory-z-projectless'], 'a migrated entity is no longer listed');
  graph.migrateAttribution();
  const after = privilegedSnapshot(graph);
  assert.equal(Object.hasOwn(after, 'storedWithoutProject'), false, 'nothing is listed once every entity is attributed');
  assert.deepEqual(owners(after)['decision-alpha'], ['alpha', 'project']);
  assert.deepEqual(owners(after)['decision-default-01'], ['default', 'legacy_ambiguous']);
  assert.throws(() => createShadowGraph({ now }).importData({ ...legacyPayload(), storedWithoutProject: [''] }), /storedWithoutProject must be an array of entity ids/);
});
