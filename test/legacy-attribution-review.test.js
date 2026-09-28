import { historicalIds } from '../tools/historical-ids.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { REQUEST_STATES } from '../src/scope.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// Labels below refer to IDs returned by ordinary creation, never supplied IDs.
const fixtureIds = {};

// P1 finding F-27 (owner decision OD-1, option B; plan v1.4.4 §10.3): legacy
// data whose owner is uncertain -- the literal "default" of a store written
// before schema 6 (legacy_ambiguous) and data stored with no project at all
// (legacy_unattributed) -- is in no project's read, so it needs one explicit
// place where a person can inspect it before choosing where it belongs. That
// place is an administrative view, not a project: it lists only those
// records, before and after the attribution migration, classified from what
// is durably stored and never from content, and it writes nothing.
//
// Every fixture below is synthetic.

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;

async function sqliteOrSkip(t) {
  try { await import('node:sqlite'); return true; }
  catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return false; }
}

// Cases 1 and 2: a store written before schema 6. One record of every kind
// in the literal "default", one of every kind stored with no project (the
// fact with an explicit null, the others with the field absent), and a
// record of the explicit project alpha, which keeps its project (WS-11
// mapping i) and is therefore not legacy-uncertain.
const LITERAL_DEFAULT = ['decision-default', 'attempt-default', 'memory-default', 'fact-default'];
const PROJECTLESS = ['decision-projectless', 'attempt-projectless', 'memory-projectless', 'fact-projectless'];

function legacyPayload() {
  const historical = {};
  const writer = createShadowGraph({ now });
  historical['decision-default'] = writer.addDecision({ project: 'default', title: 'Legacy MARKER default decision', chosen: 'x' }).id;
  historical['attempt-default'] = writer.addAttempt({ project: 'default', solution: 'legacy MARKER default attempt', result: 'failed' }).id;
  historical['memory-default'] = writer.remember({ project: 'default', memoryType: 'note', key: 'legacy-default', text: 'MEMORY-MARKER legacy default' }).memory.id;
  historical['fact-default'] = writer.addFact({ project: 'default', key: 'legacy-default-latency', value: 10 }).id;
  historical['decision-projectless'] = writer.addDecision({ project: 'default', title: 'Legacy MARKER projectless decision', chosen: 'y' }).id;
  historical['attempt-projectless'] = writer.addAttempt({ project: 'default', solution: 'legacy MARKER projectless attempt', result: 'failed' }).id;
  historical['memory-projectless'] = writer.remember({ project: 'default', memoryType: 'note', key: 'legacy-projectless', text: 'MEMORY-MARKER legacy projectless' }).memory.id;
  historical['fact-projectless'] = writer.addFact({ project: 'default', key: 'legacy-projectless-latency', value: 20 }).id;
  historical['decision-legacy-alpha'] = writer.addDecision({ project: 'alpha', title: 'Legacy MARKER alpha decision', chosen: 'z' }).id;
  const payload = historicalIds(privilegedSnapshot(writer), historical, { now });
  payload.schemaVersion = 5;
  const strip = (entity) => {
    if (!entity || typeof entity !== 'object') return;
    delete entity.attribution;
    delete entity.originId;
    if (entity.schemaVersion === 6) entity.schemaVersion = 5;
  };
  for (const entity of [...payload.records, ...payload.facts]) strip(entity);
  for (const entry of payload.journal) { entry.schemaVersion = 5; strip(entry.payload); }
  for (const entity of [...payload.records, ...payload.facts]) {
    if (!PROJECTLESS.includes(entity.id)) continue;
    if (entity.kind === 'fact') entity.project = null;
    else delete entity.project;
  }
  for (const entry of payload.journal) {
    if (!PROJECTLESS.includes(entry.entityId)) continue;
    delete entry.payload.project;
    entry.project = null;
  }
  return payload;
}

// Cases 5, 6 and 7 are written by this build: the real project named
// "default", ordinary projects alpha and beta, and records owned by a capture
// origin with no project.
const REAL_DEFAULT = () => [fixtureIds['real-default-decision'], fixtureIds['real-default-memory'], fixtureIds['real-default-fact']].sort();
const NAMED = () => [fixtureIds['alpha-decision'], fixtureIds['alpha-memory'], fixtureIds['alpha-fact'], fixtureIds['beta-decision'], fixtureIds['beta-memory'], 'decision-legacy-alpha'].sort();
const ORIGIN = () => [fixtureIds['origin-decision'], fixtureIds['origin-memory'], fixtureIds['origin-fact']].sort();

function writeCurrent(graph) {
  fixtureIds['real-default-decision'] = graph.addDecision({ project: 'default', title: 'Real default MARKER decision', chosen: 'x' }).id;
  fixtureIds['real-default-memory'] = graph.remember({ project: 'default', memoryType: 'note', key: 'legacy-default', text: 'MEMORY-MARKER real default' }).memory.id;
  fixtureIds['real-default-fact'] = graph.addFact({ project: 'default', key: 'legacy-default-latency', value: 30 }).id;
  for (const project of ['alpha', 'beta']) {
    fixtureIds[`${project}-decision`] = graph.addDecision({ project, title: `${project} MARKER decision`, chosen: 'x' }).id;
    fixtureIds[`${project}-memory`] = graph.remember({ project, memoryType: 'note', key: 'note', text: `MEMORY-MARKER ${project}` }).memory.id;
  }
  fixtureIds['alpha-fact'] = graph.addFact({ project: 'alpha', key: 'latency', value: 40 }).id;
  fixtureIds['origin-decision'] = graph.addDecision({ originId: 'origin_synthetic', title: 'Origin MARKER decision', chosen: 'x' }).id;
  fixtureIds['origin-memory'] = graph.remember({ originId: 'origin_synthetic', memoryType: 'note', key: 'note', text: 'MEMORY-MARKER origin' }).memory.id;
  fixtureIds['origin-fact'] = graph.addFact({ originId: 'origin_synthetic', key: 'latency', value: 50 }).id;
  return graph;
}

function fixture() {
  const graph = createShadowGraph({ now });
  graph.importData(legacyPayload());
  return writeCurrent(graph);
}

// What the approved mapping says each legacy record is (WS-11 ii, iii).
const EXPECTED = Object.fromEntries([
  ...LITERAL_DEFAULT.map((id) => [id, 'legacy_ambiguous']),
  ...PROJECTLESS.map((id) => [id, 'legacy_unattributed'])
]);
// The order the attribution migration takes the unattributed records in: by
// kind, then id. The explicit-alpha record is among them.
const MIGRATION_ORDER = [
  'decision-default', 'decision-legacy-alpha', 'decision-projectless', 'attempt-default', 'attempt-projectless',
  'memory-default', 'memory-projectless', 'fact-default', 'fact-projectless'
];

const everything = (graph) => graph.legacyAttributionReview({ limit: 1000 });
const classification = (view) => Object.fromEntries(view.items.map((item) => [item.id, item.attribution]));
const canonicalById = (graph) => {
  const snapshot = privilegedSnapshot(graph);
  return new Map([...snapshot.records, ...snapshot.facts].map((entity) => [entity.id, entity]));
};

test('only legacy_ambiguous and legacy_unattributed records appear, before the attribution migration and after it', () => {
  const graph = fixture();
  const before = everything(graph);
  assert.deepEqual(classification(before), EXPECTED, 'unmigrated: the literal "default" and the projectless records only');
  assert.ok(before.items.every((item) => item.migrated === false), 'nothing is migrated yet');

  // Cases 3 and 4: the decisions migrate first, so a partial run leaves
  // migrated and unmigrated legacy records side by side.
  assert.equal(graph.migrateAttribution({ limit: 3 }).migrated, 3);
  const partial = everything(graph);
  assert.deepEqual(classification(partial), EXPECTED, 'the same classification mid-migration');
  assert.deepEqual(partial.items.filter((item) => item.migrated).map((item) => item.id).sort(), ['decision-default', 'decision-projectless']);

  graph.migrateAttribution();
  const after = everything(graph);
  assert.deepEqual(classification(after), EXPECTED, 'the same classification once every record is attributed');
  assert.ok(after.items.every((item) => item.migrated === true));
  // What the view showed before the migration is exactly what the migration then stored.
  const stored = canonicalById(graph);
  for (const [id, attribution] of Object.entries(EXPECTED)) assert.equal(stored.get(id).attribution, attribution, id);
});

test('the real project "default", named projects, a legacy record of an explicit project and origin-owned records never appear', () => {
  const graph = fixture();
  for (const run of [() => null, () => graph.migrateAttribution()]) {
    run();
    const listed = new Set(everything(graph).items.map((item) => item.id));
    for (const id of [...REAL_DEFAULT(), ...NAMED(), ...ORIGIN()]) assert.equal(listed.has(id), false, id);
  }
  // A store holding only data this build wrote has nothing legacy to review.
  const current = writeCurrent(createShadowGraph({ now }));
  assert.deepEqual(current.legacyAttributionReview().items, []);
  assert.equal(current.legacyAttributionReview().page.total, 0);
});

test('each entry names the record, its kind and its legacy state, carries the canonical record, and infers no project', () => {
  const graph = fixture();
  graph.migrateAttribution({ limit: 3 });
  const stored = canonicalById(graph);
  const view = everything(graph);
  for (const item of view.items) {
    assert.deepEqual(Object.keys(item).sort(), ['assignedProject', 'attribution', 'entity', 'id', 'kind', 'migrated']);
    assert.equal(item.assignedProject, null, `${item.id}: no project is inferred`);
    assert.equal(item.kind, stored.get(item.id).kind);
    assert.deepEqual(item.entity, stored.get(item.id), `${item.id}: the canonical record, unsummarised`);
  }
  // Detached: editing what the view returned changes nothing stored.
  view.items[0].entity.title = 'edited by the caller';
  view.items[0].entity.project = 'alpha';
  assert.deepEqual(canonicalById(graph), stored);
  assert.deepEqual(view.completeness.scope, { view: 'legacy_attribution' });
});

test('reading the view twice writes nothing: no record, journal entry, event, review signal or revision changes', () => {
  const graph = fixture();
  graph.migrateAttribution({ limit: 3 });
  graph.setRevision(7);
  const before = privilegedSnapshot(graph);
  const first = everything(graph);
  const second = everything(graph);
  assert.deepEqual(second, first, 'the same answer twice');
  assert.deepEqual(privilegedSnapshot(graph), before, 'canonical state, journal, events, review signals, idempotency and revision unchanged');
  // The next write gets the journal sequence it would have got anyway.
  const seq = before.journalSeq;
  graph.addDecision({ project: 'alpha', title: 'after', chosen: 'x' });
  assert.equal(privilegedSnapshot(graph).journalSeq, seq + 1);
});

test('the view is paginated with its total and never truncates silently', () => {
  const graph = fixture();
  const total = Object.keys(EXPECTED).length;
  const first = graph.legacyAttributionReview({ limit: 3 });
  assert.equal(first.items.length, 3);
  assert.deepEqual(first.page, { offset: 0, limit: 3, total, hasMore: true });
  assert.equal(first.completeness.returned, 3);
  assert.equal(first.completeness.total, total);
  assert.equal(first.completeness.complete, false);
  assert.equal(first.completeness.omitted, total - 3);
  const pages = [];
  for (let offset = 0; offset < total; offset += 3) pages.push(...graph.legacyAttributionReview({ limit: 3, offset }).items.map((item) => item.id));
  assert.deepEqual(pages, everything(graph).items.map((item) => item.id), 'pages concatenate to the whole list in one stable order');
  assert.equal(new Set(pages).size, total);
  const last = graph.legacyAttributionReview({ limit: 3, offset: 6 });
  assert.equal(last.page.hasMore, false);
  const byDefault = graph.legacyAttributionReview();
  assert.equal(byDefault.page.total, total);
  assert.equal(byDefault.completeness.complete, true);
  for (const bad of [{ limit: 0 }, { limit: 1001 }, { offset: -1 }, { limit: 1.5 }]) {
    assert.throws(() => graph.legacyAttributionReview(bad), /Page (limit|offset)/);
  }
});

test('collections this build does not interpret and store internals never appear in the view', () => {
  const payload = legacyPayload();
  // A top-level collection a later build might add, shaped like records.
  payload.access = [{ id: 'access-looking', kind: 'decision', project: 'default', title: 'not a record' }];
  const graph = createShadowGraph({ now });
  graph.importData(payload);
  const view = everything(graph);
  assert.deepEqual(Object.keys(view).sort(), ['completeness', 'items', 'page']);
  assert.equal(view.items.some((item) => item.id === 'access-looking'), false);
  assert.equal(JSON.stringify(view).includes('storedWithoutProject'), false, 'the recorded absence classifies; it is not listed');
  assert.deepEqual(classification(view), EXPECTED);
});

test('the legacy states are not projects, origins or request states, and ordinary reads never return legacy records', () => {
  const graph = fixture();
  const legacyIds = Object.keys(EXPECTED);
  assert.deepEqual([...REQUEST_STATES], ['project_selected', 'project_unresolved'], 'still two request states');
  const reads = (options) => [
    ...graph.search('', options).items,
    ...graph.search('MARKER', options).items,
    ...graph.retrieve('MARKER', options).items,
    ...graph.recall('', options).items,
    ...graph.recall('MEMORY-MARKER', options).items
  ].map((item) => item.record.id);
  const contextIds = (options) => {
    const context = graph.context(options);
    return [...context.activeDecisions, ...context.staleAssumptions, ...context.failedAttempts, ...context.reusableAttempts].map((item) => item.id ?? item.attemptId);
  };
  for (const migrate of [false, true]) {
    if (migrate) graph.migrateAttribution();
    for (const options of [
      {}, { project: 'default' }, { project: 'alpha' }, { project: 'beta' },
      { project: 'legacy' }, { project: 'legacy_ambiguous' }, { project: 'legacy_unattributed' },
      { originId: 'origin_synthetic' }, { originId: 'legacy' }, { originId: 'legacy_ambiguous' }
    ]) {
      const seen = [...reads(options), ...contextIds(options)];
      for (const id of legacyIds) assert.equal(seen.includes(id), false, `${JSON.stringify(options)} ${migrate ? 'after' : 'before'} migration returned ${id}`);
    }
    // The inspection path is the view, and only the view.
    assert.deepEqual(classification(everything(graph)), EXPECTED);
  }
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

// One process lifetime: load, work, save, close.
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
  test(`the classification survives save and reload, and an interrupted migration, on ${backend}`, async (t) => {
    if (backend === 'sqlite' && !await sqliteOrSkip(t)) return;
    const directory = await scratchDirectory(t, `shadowgraph-f27-${backend}-`);
    const total = MIGRATION_ORDER.length;
    // 0: saved and reloaded before any migration. 1, 4, 7: interrupted part
    // way, with a projectless record still pending. total: finished.
    for (const cut of [0, 1, 4, 7, total]) {
      await t.test(`restart after ${cut} of ${total} records migrated`, async () => {
        const file = join(directory, `${cut}-${BACKENDS[backend].file}`);
        const seed = createShadowGraph({ now });
        seed.importData(legacyPayload());
        writeCurrent(seed);
        await BACKENDS[backend].seed(file, privilegedSnapshot(seed));
        const beforeRestart = await session(backend, file, (graph) => {
          if (cut) assert.equal(graph.migrateAttribution({ limit: cut }).migrated, cut);
          return everything(graph);
        });
        assert.deepEqual(classification(beforeRestart), EXPECTED);
        // A fresh process reads the store back: the same classification, and
        // the same migrated flags, from durable data alone.
        const afterRestart = await session(backend, file, (graph) => everything(graph));
        assert.deepEqual(afterRestart, beforeRestart, 'identical after reload');
        assert.deepEqual(
          afterRestart.items.filter((item) => item.migrated).map((item) => item.id).sort(),
          MIGRATION_ORDER.slice(0, cut).filter((id) => Object.hasOwn(EXPECTED, id)).sort()
        );
        // And after another.
        assert.deepEqual(await session(backend, file, (graph) => everything(graph)), beforeRestart);
        // Finishing the migration in yet another process keeps every state.
        await session(backend, file, (graph) => graph.migrateAttribution());
        const finished = await session(backend, file, (graph) => everything(graph));
        assert.deepEqual(classification(finished), EXPECTED);
        assert.ok(finished.items.every((item) => item.migrated));
        for (const id of [...REAL_DEFAULT(), ...NAMED(), ...ORIGIN()]) assert.equal(finished.items.some((item) => item.id === id), false, id);
      });
    }
  });
}
