import { historicalIds } from '../tools/historical-ids.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph, SCHEMA_VERSION } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { privilegedSnapshot, privilegedValidate } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// The legacy attribution review (P1 finding F-27) shows legacy data whose
// owner is uncertain. An entity written by a newer build is not that: this
// build cannot interpret it, keeps it as it arrived, skips it in the
// attribution migration and reports it as unsupported. The view must not
// give it a legacy meaning -- not from its stored "default", not from a
// missing project, and not from an attribution value this build happens to
// recognise. Every fixture is synthetic.

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const FUTURE = SCHEMA_VERSION + 1;

async function sqliteOrSkip(t) {
  try { await import('node:sqlite'); return true; }
  catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return false; }
}

// Known kinds a newer build wrote: in the literal "default" with no
// attribution; with no project stored at all; and one carrying an
// attribution value this build recognises.
const FUTURE_IDS = ['future-default-decision', 'future-projectless-memory', 'future-projectless-fact', 'future-attributed-attempt'];
const PROJECTLESS = ['legacy-projectless-decision', 'future-projectless-memory', 'future-projectless-fact'];
// Genuine legacy data beside them, which the view must still show.
const LEGACY = { 'legacy-default-decision': 'legacy_ambiguous', 'legacy-projectless-decision': 'legacy_unattributed' };

function payload() {
  const historical = {};
  const writer = createShadowGraph({ now });
  historical['legacy-default-decision'] = writer.addDecision({ project: 'default', title: 'Legacy default', chosen: 'x' }).id;
  historical['legacy-projectless-decision'] = writer.addDecision({ project: 'default', title: 'Legacy projectless', chosen: 'x' }).id;
  historical['future-default-decision'] = writer.addDecision({ project: 'default', title: 'Future default', chosen: 'x' }).id;
  historical['future-projectless-memory'] = writer.remember({ project: 'default', memoryType: 'note', key: 'future', text: 'Future projectless' }).memory.id;
  historical['future-projectless-fact'] = writer.addFact({ project: 'default', key: 'future-key', value: 1 }).id;
  historical['future-attributed-attempt'] = writer.addAttempt({ project: 'default', solution: 'future solution', result: 'future result' }).id;
  historical['alpha-decision'] = writer.addDecision({ project: 'alpha', title: 'Alpha', chosen: 'x' }).id;
  const data = historicalIds(privilegedSnapshot(writer), historical, { now });
  data.schemaVersion = 5;
  const shape = (entity) => {
    if (!entity || typeof entity !== 'object' || entity.id === 'alpha-decision') return;
    delete entity.originId;
    if (FUTURE_IDS.includes(entity.id)) {
      entity.schemaVersion = FUTURE;
      entity.futureField = { kept: true };
    } else entity.schemaVersion = 5;
    if (entity.id === 'future-attributed-attempt') entity.attribution = 'legacy_ambiguous';
    else delete entity.attribution;
    if (PROJECTLESS.includes(entity.id)) delete entity.project;
  };
  for (const entity of [...data.records, ...data.facts]) shape(entity);
  for (const entry of data.journal) {
    entry.schemaVersion = 5;
    shape(entry.payload);
    if (PROJECTLESS.includes(entry.entityId)) entry.project = null;
  }
  return data;
}

function fixture() {
  const graph = createShadowGraph({ now });
  graph.importData(payload());
  return graph;
}

const listed = (graph) => Object.fromEntries(graph.legacyAttributionReview({ limit: 1000 }).items.map((item) => [item.id, item.attribution]));
const stored = (graph) => {
  const snapshot = privilegedSnapshot(graph);
  return Object.fromEntries([...snapshot.records, ...snapshot.facts].filter((entity) => FUTURE_IDS.includes(entity.id)).map((entity) => [entity.id, JSON.stringify(entity)]));
};

test('a record from a newer schema is not given a legacy meaning, whatever it stores', () => {
  const graph = fixture();
  for (const migrate of [false, true]) {
    if (migrate) assert.equal(graph.migrateAttribution().migrated, 2, 'only the two genuine legacy records migrate');
    const view = listed(graph);
    assert.equal(Object.hasOwn(view, 'future-default-decision'), false, 'no legacy_ambiguous from a stored "default"');
    assert.equal(Object.hasOwn(view, 'future-projectless-memory'), false, 'no legacy_unattributed from a missing project');
    assert.equal(Object.hasOwn(view, 'future-projectless-fact'), false, 'no legacy_unattributed for a fact either');
    assert.equal(Object.hasOwn(view, 'future-attributed-attempt'), false, 'a recognised attribution value is not promoted');
    assert.deepEqual(view, LEGACY, `${migrate ? 'after' : 'before'} migration: exactly the genuine legacy records`);
  }
});

test('the compatibility path keeps a newer-schema record as it arrived, and validate still reports it unsupported', () => {
  const graph = fixture();
  const snapshot = privilegedSnapshot(graph);
  for (const id of FUTURE_IDS) {
    const entity = [...snapshot.records, ...snapshot.facts].find((item) => item.id === id);
    assert.equal(entity.schemaVersion, FUTURE, `${id} keeps its own schema version`);
    assert.deepEqual(entity.futureField, { kept: true }, `${id} keeps the field this build does not know`);
    assert.equal(entity.attribution, id === 'future-attributed-attempt' ? 'legacy_ambiguous' : undefined, `${id} keeps its attribution, or its lack of one`);
  }
  const unsupported = privilegedValidate(graph).issues.filter((issue) => issue.severity === 'unsupported');
  assert.deepEqual(unsupported.map((issue) => [issue.code, issue.recordId, issue.schemaVersion]).sort(), [
    ['unsupported_fact_schema_version', 'future-projectless-fact', FUTURE],
    ['unsupported_record_schema_version', 'future-attributed-attempt', FUTURE],
    ['unsupported_record_schema_version', 'future-default-decision', FUTURE],
    ['unsupported_record_schema_version', 'future-projectless-memory', FUTURE]
  ]);
  // Neither reading the view nor the attribution migration touches them.
  const before = stored(graph);
  graph.legacyAttributionReview();
  graph.migrateAttribution();
  graph.legacyAttributionReview({ limit: 1 });
  assert.deepEqual(stored(graph), before);
});

test('reading the view writes nothing while newer-schema records are present', () => {
  const graph = fixture();
  graph.setRevision(3);
  const before = privilegedSnapshot(graph);
  const first = graph.legacyAttributionReview();
  assert.deepEqual(graph.legacyAttributionReview(), first);
  assert.deepEqual(privilegedSnapshot(graph), before);
});

const BACKENDS = {
  json: { file: 'data.json', open: async (file) => createJsonFileStore(file) },
  sqlite: { file: 'data.db', open: (file) => createSqliteStore(file) }
};

for (const backend of Object.keys(BACKENDS)) {
  test(`a newer-schema record survives save and reload unchanged and stays out of the view, on ${backend}`, async (t) => {
    if (backend === 'sqlite' && !await sqliteOrSkip(t)) return;
    const directory = await scratchDirectory(t, `shadowgraph-f27-future-${backend}-`);
    const graph = fixture();
    const before = stored(graph);
    for (const migrate of [false, true]) {
      if (migrate) graph.migrateAttribution();
      const file = join(directory, `${migrate ? 'migrated' : 'unmigrated'}-${BACKENDS[backend].file}`);
      const store = await BACKENDS[backend].open(file);
      try { await store.save(privilegedSnapshot(graph)); } finally { store.close?.(); }
      const reopened = await BACKENDS[backend].open(file);
      const reloaded = createShadowGraph({ now });
      try { reloaded.importData(await reopened.load()); } finally { reopened.close?.(); }
      assert.deepEqual(stored(reloaded), before, 'byte for byte after the round trip');
      assert.deepEqual(listed(reloaded), LEGACY, 'only the genuine legacy records are listed');
    }
  });
}
