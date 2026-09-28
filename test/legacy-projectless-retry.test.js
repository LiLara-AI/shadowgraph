import { historicalIds } from '../tools/historical-ids.js';
const fixtureIds = {};
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph, rebuildProjection } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { privilegedRebuild, privilegedSnapshot, privilegedValidate } from '../src/internal/snapshot.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// F-26: a legacy entity stored with no project whose retry entry names
// "default" must mean one thing wherever it is read -- direct import, a
// rebuild from its own journal, restore validation, the schema-6 migration,
// JSON and SQLite. It stays legacy data stored without a project
// (legacy_unattributed once migrated), apart from the literal legacy "default"
// (legacy_ambiguous) and from the real project called "default"; no project is
// made up for it.

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const KINDS = ['decision', 'attempt', 'memory', 'fact'];

async function sqliteOrSkip(t) {
  try { await import('node:sqlite'); return true; }
  catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return false; }
}

// `key` is a memory's or fact's identity; decisions and attempts have none.
const WRITE = {
  decision: (graph, { key, ...input }) => graph.addDecision({ ...input, title: `Decision ${input.idempotencyKey}`, chosen: 'x' }),
  attempt: (graph, { key, ...input }) => graph.addAttempt({ ...input, solution: `Attempt ${input.idempotencyKey}`, result: 'worked' }),
  memory: (graph, input) => graph.remember({ ...input, memoryType: 'note', text: `Memory ${input.key}` }).memory,
  fact: (graph, input) => graph.addFact({ ...input, value: `fact ${input.key}` })
};

// A schema-5 store with, per kind, an `alpha` entity, a literal "default"
// entity and one entity stored with no project -- no project on its record or
// its journal entry -- each with a retry key. The projectless entity's retry
// value names "default"; with `exactRetry` it is an exact copy of the record,
// with no project either.
function legacyPayload({ kinds = KINDS, exactRetry = false } = {}) {
  const historical = {};
  const graph = createShadowGraph({ now });
  for (const kind of kinds) {
    for (const [project, suffix] of [['alpha', 'alpha'], ['default', 'literal'], ['default', 'projectless']]) {
      historical[`${kind}-${suffix}`] = WRITE[kind](graph, { project, key: `${kind}-${suffix}`, idempotencyKey: `retry-${kind}-${suffix}` }).id;
    }
  }
  const payload = historicalIds(privilegedSnapshot(graph), historical, { now });
  payload.schemaVersion = 5;
  const strip = (entity) => {
    if (!entity || typeof entity !== 'object') return;
    delete entity.attribution;
    delete entity.originId;
    // Schema 5 predates erasure tokens (schema 7).
    delete entity.erasureToken;
    if (entity.schemaVersion >= 6) entity.schemaVersion = 5;
  };
  for (const entity of [...payload.records, ...payload.facts, ...payload.relations]) strip(entity);
  for (const item of payload.idempotency) strip(item.value);
  for (const entry of payload.journal) { entry.schemaVersion = 5; strip(entry.payload); }
  for (const kind of kinds) {
    const id = `${kind}-projectless`;
    delete [...payload.records, ...payload.facts].find((entity) => entity.id === id).project;
    const entry = payload.journal.find((item) => item.entityId === id);
    delete entry.payload.project;
    entry.project = null;
    if (exactRetry) delete payload.idempotency.find((item) => item.value.id === id).value.project;
  }
  return payload;
}

const ids = (payload) => [...payload.records, ...payload.facts].map((entity) => entity.id).sort();
const retries = (payload) => payload.idempotency.map((item) => [item.key, item.value.id]).sort(([left], [right]) => left.localeCompare(right));
const owners = (payload) => Object.fromEntries([...payload.records, ...payload.facts].map((entity) => [entity.id, entity.attribution ?? null]));

// Import, validation, the journal rebuild and restore validation all read the
// same entities and the same retries.
function assertOneMeaning(graph, label) {
  const validation = privilegedValidate(graph);
  assert.equal(validation.valid, true, `${label}: ${JSON.stringify(validation.issues)}`);
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, `${label}: ${rebuilt.reason} ${JSON.stringify(rebuilt.skipped.at(-1) ?? null)}`);
  const live = privilegedSnapshot(graph);
  assert.deepEqual(ids(rebuilt.projection), ids(live), `${label}: the journal rebuilds every entity the store holds`);
  assert.deepEqual(retries(rebuilt.projection), retries(live), `${label}: and every retry, to the same entity`);
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(live), { now }), `${label}: restore validation accepts it`);
}

function expectedOwners(kinds = KINDS, real = false) {
  const expected = {};
  for (const kind of kinds) {
    expected[`${kind}-alpha`] = 'project';
    expected[`${kind}-literal`] = 'legacy_ambiguous';
    expected[`${kind}-projectless`] = 'legacy_unattributed';
    if (real) for (const suffix of ['literal', 'projectless']) expected[fixtureIds[`${kind}-real-${suffix}`]] = 'project';
  }
  return expected;
}

for (const kind of KINDS) {
  for (const [variant, options] of Object.entries({ 'retry value names "default"': {}, 'retry value is an exact copy': { exactRetry: true } })) {
    test(`${kind}: a legacy entity stored with no project and its retry read the same from the store and from its journal (${variant})`, () => {
      const graph = createShadowGraph({ now });
      graph.importData(legacyPayload({ kinds: [kind], ...options }));
      assertOneMeaning(graph, `${kind} (${variant})`);
      assert.equal(owners(privilegedSnapshot(graph))[`${kind}-projectless`], null, 'import attributes nothing');
      graph.migrateAttribution();
      assert.deepEqual(owners(privilegedSnapshot(graph)), expectedOwners([kind]));
      assertOneMeaning(graph, `${kind} (${variant}), migrated`);
    });
  }
}

test('the entity stored with no project stays apart from the literal legacy "default" and the real project "default"', () => {
  const payload = legacyPayload();
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(payload));
  // The real project "default", presenting the legacy retry keys and
  // identities, gets its own entities, and its own retries return them.
  for (const kind of KINDS) {
    for (const suffix of ['literal', 'projectless']) {
      const input = { project: 'default', key: `${kind}-${suffix}`, idempotencyKey: `retry-${kind}-${suffix}` };
      const created = WRITE[kind](graph, input);
      fixtureIds[`${kind}-real-${suffix}`] = created.id;
      assert.notEqual(created.id, `${kind}-${suffix}`, `${kind} ${suffix}: a new real-default entity`);
      assert.equal(WRITE[kind](graph, input).id, created.id, `${kind} ${suffix}: its retry returns it`);
    }
  }
  assertOneMeaning(graph, 'before migration');
  graph.migrateAttribution();
  assert.deepEqual(owners(privilegedSnapshot(graph)), expectedOwners(KINDS, true));
  assertOneMeaning(graph, 'after migration');

  // The journal keeps the absence too: its own replay, imported afresh,
  // migrates the projectless entities to legacy_unattributed, not
  // legacy_ambiguous.
  const replayed = rebuildProjection(payload.journal).projection;
  for (const kind of KINDS) assert.equal(Object.hasOwn(replayed.records.find((item) => item.id === `${kind}-projectless`) ?? replayed.facts.find((item) => item.id === `${kind}-projectless`), 'project'), false);
  const fromJournal = createShadowGraph({ now });
  fromJournal.importData({ schemaVersion: 5, records: replayed.records, facts: replayed.facts, relations: replayed.relations, idempotency: replayed.idempotency });
  fromJournal.migrateAttribution();
  assert.deepEqual(owners(privilegedSnapshot(fromJournal)), expectedOwners());
});

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

for (const backend of Object.keys(BACKENDS)) {
  test(`saved, restarted, retried and migrated in batches, the store keeps one meaning (${backend})`, async (t) => {
    if (backend === 'sqlite' && !await sqliteOrSkip(t)) return;
    const directory = await scratchDirectory(t, `shadowgraph-f26-${backend}-`);
    const file = join(directory, BACKENDS[backend].file);
    await BACKENDS[backend].seed(file, legacyPayload());
    const created = await session(backend, file, (graph) => {
      assertOneMeaning(graph, `${backend}: loaded`);
      return WRITE.decision(graph, { project: 'default', idempotencyKey: 'retry-decision-projectless' }).id;
    });
    await session(backend, file, (graph) => {
      assertOneMeaning(graph, `${backend}: restarted`);
      assert.equal(WRITE.decision(graph, { project: 'default', idempotencyKey: 'retry-decision-projectless' }).id, created, `${backend}: the real retry survives the restart`);
      assert.equal(graph.migrateAttribution({ limit: 5 }).complete, false);
    });
    await session(backend, file, (graph) => {
      assertOneMeaning(graph, `${backend}: part migrated`);
      assert.equal(graph.migrateAttribution().complete, true);
    });
    await session(backend, file, (graph) => {
      const expected = { ...expectedOwners(), [created]: 'project' };
      assert.deepEqual(owners(privilegedSnapshot(graph)), expected, `${backend}: three distinct legacy mappings and the real project`);
      assertOneMeaning(graph, `${backend}: migrated`);
    });
  });
}

// The value is now compared in its migrated form; owners are still compared
// strictly, by the same owner model the writes use.
test('a retry value never binds to an entity of another owner', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'default', title: 'Real default', chosen: 'r', idempotencyKey: 'retry-real' });
  const real = privilegedSnapshot(graph);
  for (const [label, forge] of Object.entries({
    'legacy form naming "default"': (value) => { delete value.attribution; },
    'legacy form with no project': (value) => { delete value.attribution; delete value.project; }
  })) {
    const forged = structuredClone(real);
    forge(forged.idempotency[0].value);
    assert.throws(() => createShadowGraph({ now }).importData(forged), /Idempotency entry identity does not match its entity/, `a real-default entity with a retry value in ${label}`);
  }
  for (const id of ['decision-literal', 'decision-projectless']) {
    const forged = legacyPayload({ kinds: ['decision'] });
    Object.assign(forged.idempotency.find((item) => item.value.id === id).value, { attribution: 'project', project: 'default', schemaVersion: 6 });
    assert.throws(() => createShadowGraph({ now }).importData(forged), /Idempotency entry identity does not match its entity/, `${id} with a real-default retry value`);
  }
  const named = legacyPayload({ kinds: ['decision'] });
  delete named.idempotency.find((item) => item.value.id === 'decision-alpha').value.project;
  assert.throws(() => createShadowGraph({ now }).importData(named), /Idempotency entry identity does not match its entity/, 'an alpha entity with a retry value that stores no project');
});
