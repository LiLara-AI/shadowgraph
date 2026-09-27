import { historicalIds } from '../tools/historical-ids.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedValidate, privilegedRebuild } from '../src/internal/snapshot.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { rebuildProjection } from '../src/journal.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// Labels below refer to IDs returned by ordinary creation, never supplied IDs.
const fixtureIds = {};

const NOW = '2026-09-26T12:00:00.000Z';
const now = () => NOW;
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const ids = (items) => items.map((item) => item.id).sort();
const ordered = (items) => [...items].sort((a, b) => String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)));
function parity(graph) {
  const live = privilegedSnapshot(graph);
  assert.equal(privilegedValidate(graph).valid, true);
  const rebuilt = privilegedRebuild(graph);
  assert.deepEqual(rebuilt.skipped, []);
  for (const name of ['records', 'facts', 'relations', 'idempotency']) assert.deepEqual(ordered(rebuilt.projection[name]), ordered(live[name]), name);
  assert.doesNotThrow(() => validateRestorePayload(live, { now }));
  return live;
}
function graphOf(payload) { const graph = createShadowGraph({ now }); graph.importData(payload); return graph; }
async function persistRestore(t, backend, graph) {
  const dir = await scratchDirectory(t, 'attribution-purge-');
  const path = join(dir, backend === 'json' ? 'store.json' : 'store.db');
  const open = () => backend === 'json' ? createJsonFileStore(path) : createSqliteStore(path);
  let store = await open();
  await store.save({ ...privilegedSnapshot(graph), revision: 0 });
  await store.close();
  store = await open();
  t.after(() => store.close());
  const loaded = graphOf(await store.load());
  parity(loaded);
  const backup = join(dir, backend === 'json' ? 'backup.json' : 'backup.db');
  await backupFile(path, backup, { store });
  if (backend === 'json') await restoreFile(backup, path);
  else await store.restore(backup);
  const restored = graphOf(await store.load());
  parity(restored);
  const expected = privilegedSnapshot(loaded), actual = privilegedSnapshot(restored);
  for (const name of ['records', 'facts', 'relations', 'idempotency', 'events', 'journal']) assert.deepEqual(actual[name], expected[name], `${backend} restore ${name}`);
  return restored;
}
function movedFixture() {
  const graph = createShadowGraph({ now });
  fixtureIds['decision'] = graph.addDecision({ project: 'alpha', title: 'Synthetic', chosen: 'Synthetic' }).id;
  fixtureIds['attempt'] = graph.addAttempt({ project: 'alpha', solution: 'Synthetic', result: 'Synthetic' }).id;
  fixtureIds['relation'] = graph.link({ project: 'alpha', from: fixtureIds.decision, to: fixtureIds.attempt, relation: 'tried' }).id;
  const payload = privilegedSnapshot(graph);
  for (const entity of payload.records) {
    entity.project = 'beta';
    payload.journal.push({ id: `attribute-${entity.id}`, seq: ++payload.journalSeq, type: 'entity.attributed', at: NOW, project: 'beta', entityKind: entity.kind, entityId: entity.id, schemaVersion: 6, payload: { ...entity, attributionChange: { previousProject: 'alpha', previousAttribution: 'project', reason: 'user' } }, provenance: { actor: null, client: null, sessionId: null } });
  }
  return graphOf(payload);
}
function mixedFixture(variant) {
  let graph = createShadowGraph({ now });
  for (const name of ['real', 'legacy', 'missing', 'other', 'origin']) {
    const owner = name === 'origin' ? { originId: 'origin-exact' } : { project: name === 'other' ? 'other' : 'default' };
    fixtureIds[`d-${name}`] = graph.addDecision({ ...owner, title: name, chosen: name, idempotencyKey: name }).id;
    fixtureIds[`f-${name}`] = graph.addFact({ ...owner, key: name, value: name }).id;
    fixtureIds[`m-${name}`] = graph.remember({ ...owner, memoryType: 'note', key: name, text: name }).memory.id;
    fixtureIds[`r-${name}`] = graph.link({ ...owner, from: fixtureIds[`d-${name}`], to: fixtureIds[`f-${name}`], relation: 'supports' }).id;
  }
  const legacyNames = Object.fromEntries(['legacy', 'missing'].flatMap(name => ['d', 'f', 'm', 'r'].map(kind => { const label = `${kind}-${name}`; return [label, fixtureIds[label]]; })));
  const payload = historicalIds(privilegedSnapshot(graph), legacyNames, { now });
  const lower = (entity) => {
    if (!entity?.id || !['legacy', 'missing'].some((name) => entity.id.endsWith(name))) return;
    entity.schemaVersion = 5; delete entity.attribution; delete entity.originId;
    if (entity.id.endsWith('missing')) delete entity.project;
  };
  for (const entity of [...payload.records, ...payload.facts, ...payload.relations]) lower(entity);
  for (const item of payload.idempotency) lower(item.value);
  for (const item of payload.journal) {
    if (['legacy', 'missing'].some((name) => item.entityId?.endsWith(name))) { item.schemaVersion = 5; lower(item.payload); if (item.entityId.endsWith('missing')) item.project = null; }
  }
  if (variant === 'baseline') { payload.journal = []; payload.journalSeq = 0; payload.journalEpoch = null; }
  graph = graphOf(payload);
  if (variant === 'migrated') graph.migrateAttribution();
  return graph;
}

for (const backend of ['json', 'sqlite']) for (const mode of ['logical', 'hard']) {
  const options = backend === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {};
  test(`F18 ${backend} ${mode}: source purge preserves moved relation through restart and complete restore`, options, async (t) => {
    const graph = movedFixture(); parity(graph);
    graph.purgeProject('alpha', { mode });
    assert.deepEqual(ids(privilegedSnapshot(graph).relations), [fixtureIds.relation]);
    parity(graph);
    const restored = await persistRestore(t, backend, graph);
    restored.purgeProject('beta', { mode });
    assert.deepEqual(privilegedSnapshot(restored).relations, []); parity(restored);
  });
  for (const variant of ['unmigrated', 'migrated', 'baseline']) test(`F34 ${backend} ${mode} ${variant}: real default purge preserves legacy and origin ownership`, options, async (t) => {
    const graph = mixedFixture(variant), before = parity(graph);
    const summary = graph.projectSummary('default');
    assert.equal(summary.records, 2); assert.equal(summary.facts, 1); assert.equal(summary.relations, 1);
    graph.purgeProject('default', { mode });
    const after = parity(graph);
    for (const collection of ['records', 'facts', 'relations', 'idempotency']) {
      const keep = (item) => ![fixtureIds['d-real'], fixtureIds['f-real'], fixtureIds['m-real'], fixtureIds['r-real']].includes(item.id ?? item.value?.id);
      assert.deepEqual(ordered(after[collection]), ordered(before[collection].filter(keep)), collection);
    }
    for (const event of before.events.filter((event) => (event.recordId ?? event.factId ?? event.relationId ?? '').match(/(legacy|missing)$/))) assert.ok(after.events.some((item) => item.id === event.id));
    await persistRestore(t, backend, graph);
  });
}

test('attribution selects only the exact unattributed origin and preserves every provenance field', () => {
  const graph = createShadowGraph({ now });
  for (const [id, owner] of [['named', { originId: 'origin-one' }], ['other', { originId: 'origin-two' }], ['already', { project: 'alpha', originId: 'origin-one' }]]) fixtureIds[id] = graph.addDecision({ ...owner, title: id, chosen: id, actor: 'original-actor', client: 'original-client' }).id;
  const before = privilegedSnapshot(graph);
  assert.equal(typeof graph.attribute, 'function');
  graph.attribute({ originId: 'origin-one', targetProject: 'default', reason: 'Owner named the destination', surface: 'cli' });
  const after = parity(graph);
  assert.deepEqual(after.records.find((item) => item.id === fixtureIds.named), { ...before.records.find((item) => item.id === fixtureIds.named), project: 'default', attribution: 'project' });
  for (const id of ['other', 'already']) assert.deepEqual(after.records.find((item) => item.id === fixtureIds[id]), before.records.find((item) => item.id === fixtureIds[id]));
  const audit = after.events.find((event) => event.type === 'attribution.changed');
  assert.equal(audit.surface, 'cli'); assert.equal(audit.reason, 'Owner named the destination'); assert.equal(audit.at, NOW);
  assert.equal(after.journal.at(-1).type, 'entity.attributed'); assert.equal(after.journal.at(-1).payload.attributionChange.reason, 'user');
});

for (const backend of ['json', 'sqlite']) test(`attribution ${backend}: named material moves and reverses with retry/index parity`, backend === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async (t) => {
  const graph = createShadowGraph({ now });
  fixtureIds['d'] = graph.addDecision({ project: 'alpha', originId: 'origin-one', title: 'D', chosen: 'C', idempotencyKey: 'd' }).id;
  fixtureIds['f'] = graph.addFact({ project: 'alpha', key: 'key', value: 'F', idempotencyKey: 'f' }).id;
  fixtureIds['m'] = graph.remember({ project: 'alpha', memoryType: 'note', key: 'key', text: 'M', idempotencyKey: 'm' }).memory.id;
  const before = privilegedSnapshot(graph);
  assert.equal(typeof graph.attribute, 'function');
  graph.attribute({ ids: [fixtureIds.d, fixtureIds.f, fixtureIds.m], targetProject: 'beta', reason: 'Explicit move' }); parity(graph);
  assert.equal(graph.addDecision({ project: 'beta', idempotencyKey: 'd' }).id, fixtureIds.d);
  assert.equal(graph.addFact({ project: 'beta', key: 'key', value: 'ignored', idempotencyKey: 'f' }).id, fixtureIds.f);
  assert.equal(graph.remember({ project: 'beta', memoryType: 'note', key: 'key', text: 'ignored', idempotencyKey: 'm' }).memory.id, fixtureIds.m);
  const restored = await persistRestore(t, backend, graph);
  restored.attribute({ ids: [fixtureIds.d, fixtureIds.f, fixtureIds.m], targetProject: 'alpha', reason: 'Explicit reversal' });
  const reversed = parity(restored);
  for (const name of ['records', 'facts', 'idempotency']) assert.deepEqual(ordered(reversed[name]), ordered(before[name]));
  restored.addFact({ project: 'alpha', key: 'key', value: 'replacement' });
  assert.equal(privilegedSnapshot(restored).facts.find((item) => item.id === fixtureIds.f).status, 'superseded');
  restored.remember({ project: 'alpha', memoryType: 'note', key: 'key', text: 'replacement' });
  assert.equal(privilegedSnapshot(restored).records.find((item) => item.id === fixtureIds.m).status, 'superseded'); parity(restored);
});

test('attribution refuses ambiguous selectors, missing/future material, collisions, and overflow atomically', () => {
  const graph = createShadowGraph({ now });
  fixtureIds['a'] = graph.addFact({ project: 'alpha', key: 'collision', value: 'a' }).id;
  fixtureIds['b'] = graph.addFact({ project: 'beta', key: 'collision', value: 'b' }).id;
  assert.equal(typeof graph.attribute, 'function');
  for (const input of [
    { ids: [fixtureIds.a], targetProject: '', reason: 'x' }, { ids: [], targetProject: 'beta', reason: 'x' },
    { ids: [fixtureIds.a, 'absent'], targetProject: 'gamma', reason: 'x' }, { ids: [fixtureIds.a], originId: 'origin', targetProject: 'gamma', reason: 'x' },
    { originId: 'absent', targetProject: 'gamma', reason: 'x' }, { ids: [fixtureIds.a], targetProject: 'beta', reason: 'x' },
    { ids: [fixtureIds.a], targetProject: 'gamma', reason: '' }, { ids: [fixtureIds.a], targetProject: 'gamma', reason: 'x', grant: { accessId: 'forged' } }
  ]) { const before = privilegedSnapshot(graph); assert.throws(() => graph.attribute(input)); assert.deepEqual(privilegedSnapshot(graph), before); }
  const future = privilegedSnapshot(graph); future.facts.find((item) => item.id === fixtureIds.a).schemaVersion = 7;
  const futureGraph = graphOf(future), saved = privilegedSnapshot(futureGraph);
  assert.throws(() => futureGraph.attribute({ ids: [fixtureIds.a], targetProject: 'gamma', reason: 'x' }), /future|unsupported/i); assert.deepEqual(privilegedSnapshot(futureGraph), saved);
  const exhausted = privilegedSnapshot(graph); exhausted.journalSeq = Number.MAX_SAFE_INTEGER;
  const full = graphOf(exhausted), before = privilegedSnapshot(full);
  assert.throws(() => full.attribute({ ids: [fixtureIds.a], targetProject: 'gamma', reason: 'x' }), /sequence/i); assert.deepEqual(privilegedSnapshot(full), before);
});

test('F18 replay alone preserves relations whose endpoints survive the old project purge', () => {
  const payload = privilegedSnapshot(movedFixture());
  payload.journal.push({ id: 'marker', seq: ++payload.journalSeq, type: 'project.purged', at: NOW, project: 'alpha', entityKind: 'project', entityId: null, schemaVersion: 6, payload: { project: 'alpha', mode: 'logical', removed: 0, removedJournalSequences: [] }, provenance: { actor: null, client: null, sessionId: null } });
  assert.deepEqual(ids(rebuildProjection(payload.journal, { journalEpoch: payload.journalEpoch }).projection.relations), [fixtureIds.relation]);
});

test('attribution preserves supported unscoped legacy retry keys through replay normalization', () => {
  const seed = createShadowGraph({ now });
  fixtureIds['legacy-retry'] = seed.addDecision({ project: 'alpha', title: 'Legacy', chosen: 'Keep', idempotencyKey: 'retry' }).id;
  const payload = historicalIds(privilegedSnapshot(seed), { 'legacy-retry': fixtureIds['legacy-retry'] }, { now });
  payload.schemaVersion = 5;
  for (const entity of [payload.records[0], payload.idempotency[0].value, payload.journal[0].payload]) { entity.schemaVersion = 5; delete entity.attribution; }
  payload.journal[0].schemaVersion = 5;
  payload.journal[0].idempotencyKey = 'decision:retry';
  payload.idempotency[0].key = 'decision:retry';
  const graph = graphOf(payload); parity(graph);
  graph.attribute({ ids: ['legacy-retry'], targetProject: 'beta', reason: 'Explicit legacy reassignment' });
  parity(graph);
  assert.equal(graph.addDecision({ project: 'beta', idempotencyKey: 'retry' }).id, 'legacy-retry');
});
