import { historicalIds } from '../tools/historical-ids.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { privilegedRebuild, privilegedSnapshot, privilegedValidate } from '../src/internal/snapshot.js';
import { downgradeToSchema5 } from '../src/schema-conversion.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// P1A correction IR-02 (F-23; owner decision OD-1): a legacy record in
// "default" is legacy_ambiguous, not the property of a real project that is
// also called "default", and a legacy record stored with no project belongs to
// no project at all. Neither may be returned to, merged with or superseded by
// a new project-owned write merely because the project fields read "default".
// Retries within one real owner, and the approved compatibility of an
// unambiguous legacy project, keep working.

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;

async function sqliteOrSkip(t) {
  try { await import('node:sqlite'); return true; }
  catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return false; }
}

// A schema-5 store whose "default" records carry retry keys, beside the same
// keys and identities in an explicit legacy project, and records stored with
// no project. With `projectlessRetry`, the projectless decision also has a
// retry entry naming "default" -- data a schema-5 build accepts on import,
// and which its own journal now rebuilds the same way (F-26).
function legacyPayload({ projectlessRetry = false } = {}) {
  const historical = {};
  const graph = createShadowGraph({ now });
  for (const [project, suffix] of [['default', 'legacy'], ['alpha', 'alpha']]) {
    historical[`decision-${suffix}`] = graph.addDecision({ project, title: `Legacy ${project} decision`, chosen: 'x', idempotencyKey: `retry-decision-${suffix}` }).id;
    historical[`attempt-${suffix}`] = graph.addAttempt({ project, solution: `Legacy ${project} attempt`, result: 'worked', idempotencyKey: `retry-attempt-${suffix}` }).id;
    historical[`memory-${suffix}`] = graph.remember({ project, memoryType: 'note', key: 'same-key', text: `Legacy ${project} memory`, idempotencyKey: `retry-memory-${suffix}` }).memory.id;
    historical[`fact-${suffix}`] = graph.addFact({ project, key: 'same-key', value: `legacy ${project}`, idempotencyKey: `retry-fact-${suffix}` }).id;
  }
  historical['decision-projectless'] = graph.addDecision({ project: 'default', title: 'Stored without a project', chosen: 'y', ...(projectlessRetry ? { idempotencyKey: 'retry-projectless' } : {}) }).id;
  historical['memory-projectless'] = graph.remember({ project: 'default', memoryType: 'note', key: 'projectless-key', text: 'Stored without a project' }).memory.id;
  historical['fact-projectless'] = graph.addFact({ project: 'default', key: 'projectless-key', value: 'stored without a project' }).id;
  const payload = historicalIds(privilegedSnapshot(graph), historical, { now });
  payload.schemaVersion = 5;
  const strip = (entity) => {
    if (!entity || typeof entity !== 'object') return;
    delete entity.attribution;
    delete entity.originId;
    if (entity.schemaVersion === 6) entity.schemaVersion = 5;
  };
  for (const entity of [...payload.records, ...payload.facts, ...payload.relations]) strip(entity);
  for (const item of payload.idempotency) strip(item.value);
  for (const entry of payload.journal) { entry.schemaVersion = 5; strip(entry.payload); }
  for (const id of ['decision-projectless', 'memory-projectless', 'fact-projectless']) {
    delete [...payload.records, ...payload.facts].find((entity) => entity.id === id).project;
    const entry = payload.journal.find((item) => item.entityId === id);
    delete entry.payload.project;
    entry.project = null;
  }
  return payload;
}

const STAGES = {
  'before migration': (options) => {
    const graph = createShadowGraph({ now });
    graph.importData(legacyPayload(options));
    return graph;
  },
  'after migration': (options) => {
    const graph = createShadowGraph({ now });
    graph.importData(legacyPayload(options));
    graph.migrateAttribution();
    return graph;
  },
  'after migration, save and reload': (options) => {
    const graph = createShadowGraph({ now });
    graph.importData(legacyPayload(options));
    graph.migrateAttribution();
    const reloaded = createShadowGraph({ now });
    reloaded.importData(JSON.parse(JSON.stringify(privilegedSnapshot(graph))));
    return reloaded;
  }
};

const entity = (graph, id) => {
  const snapshot = privilegedSnapshot(graph);
  return structuredClone([...snapshot.records, ...snapshot.facts].find((item) => item.id === id));
};

function assertHealthy(graph, label) {
  const validation = privilegedValidate(graph);
  assert.equal(validation.valid, true, `${label}: ${JSON.stringify(validation.issues)}`);
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, `${label}: ${rebuilt.reason}`);
  const reloaded = createShadowGraph({ now });
  reloaded.importData(JSON.parse(JSON.stringify(privilegedSnapshot(graph))));
  assert.equal(privilegedValidate(reloaded).valid, true, `${label}: reloaded`);
  return reloaded;
}

for (const [stage, open] of Object.entries(STAGES)) {
  test(`decision: an explicit "default" write with a legacy retry key gets its own record (${stage})`, () => {
    const graph = open();
    const legacy = entity(graph, 'decision-legacy');
    const input = { project: 'default', title: 'New real-default decision', chosen: 'n', idempotencyKey: 'retry-decision-legacy' };
    const created = graph.addDecision(input);
    assert.notEqual(created.id, 'decision-legacy');
    assert.deepEqual([created.project, created.attribution], ['default', 'project']);
    assert.deepEqual(entity(graph, 'decision-legacy'), legacy, 'the legacy record is untouched');
    assert.equal(graph.addDecision(input).id, created.id, 'the real owner\'s own retry deduplicates');
    assert.throws(() => graph.supersedeDecision({ project: 'default', decisionId: 'decision-legacy', replacementId: created.id }), /Supersession requires two existing decisions/, 'a real "default" decision cannot supersede a legacy one, which it cannot even tell exists');
    const reloaded = assertHealthy(graph, stage);
    assert.equal(reloaded.addDecision(input).id, created.id, 'the retry survives a reload');
    assert.deepEqual(entity(reloaded, 'decision-legacy'), legacy);
  });

  test(`attempt: an explicit "default" write with a legacy retry key gets its own record (${stage})`, () => {
    const graph = open();
    const legacy = entity(graph, 'attempt-legacy');
    const input = { project: 'default', solution: 'New real-default attempt', result: 'new', idempotencyKey: 'retry-attempt-legacy' };
    const created = graph.addAttempt(input);
    assert.notEqual(created.id, 'attempt-legacy');
    assert.deepEqual([created.project, created.attribution], ['default', 'project']);
    assert.deepEqual(entity(graph, 'attempt-legacy'), legacy);
    assert.equal(graph.addAttempt(input).id, created.id);
    const reloaded = assertHealthy(graph, stage);
    assert.equal(reloaded.addAttempt(input).id, created.id);
    assert.deepEqual(entity(reloaded, 'attempt-legacy'), legacy);
  });

  test(`memory: an explicit "default" write with a legacy identity neither returns nor supersedes it (${stage})`, () => {
    const graph = open();
    const legacy = entity(graph, 'memory-legacy');
    const input = { project: 'default', memoryType: 'note', key: 'same-key', text: 'New real-default memory', idempotencyKey: 'retry-memory-legacy' };
    const added = graph.remember(input);
    assert.equal(added.operation, 'ADD');
    assert.notEqual(added.memory.id, 'memory-legacy');
    assert.deepEqual([added.memory.project, added.memory.attribution], ['default', 'project']);
    assert.deepEqual(entity(graph, 'memory-legacy'), legacy, 'still active, not superseded');
    const retry = graph.remember(input);
    assert.deepEqual([retry.operation, retry.memory.id], ['NOOP', added.memory.id]);
    // Later writes to the same identity supersede the real owner's memory only.
    const updated = graph.remember({ project: 'default', memoryType: 'note', key: 'same-key', text: 'Second real-default memory' });
    assert.deepEqual([updated.operation, updated.previous.id], ['UPDATE', added.memory.id]);
    const plan = graph.applyMemoryPlan({ project: 'default', operations: [{ action: 'DELETE', memoryType: 'note', key: 'same-key' }] });
    assert.equal(plan.results[0].memory.id, updated.memory.id, 'a DELETE reaches the real owner\'s memory, not the legacy one');
    assert.deepEqual(entity(graph, 'memory-legacy'), legacy);
    // A projectless legacy memory is no more a "default" memory than the ambiguous one.
    const projectless = entity(graph, 'memory-projectless');
    assert.equal(graph.remember({ project: 'default', memoryType: 'note', key: 'projectless-key', text: 'Real default' }).operation, 'ADD');
    assert.deepEqual(entity(graph, 'memory-projectless'), projectless);
    for (const [project, suffix] of [['alpha', 'alpha'], ['default', 'legacy']]) {
      assert.equal(entity(graph, `memory-${suffix}`).status, 'active', `${project}: untouched by the other owner`);
    }
    const reloaded = assertHealthy(graph, stage);
    assert.deepEqual(entity(reloaded, 'memory-legacy'), legacy);
  });

  test(`fact: an explicit "default" write with a legacy key neither returns nor supersedes it (${stage})`, () => {
    const graph = open();
    const legacy = entity(graph, 'fact-legacy');
    const input = { project: 'default', key: 'same-key', value: 'new real default', idempotencyKey: 'retry-fact-legacy' };
    const created = graph.addFact(input);
    assert.notEqual(created.id, 'fact-legacy');
    assert.deepEqual([created.project, created.attribution], ['default', 'project']);
    assert.deepEqual(entity(graph, 'fact-legacy'), legacy, 'still active, not superseded');
    assert.equal(graph.addFact(input).id, created.id);
    graph.addFact({ project: 'default', key: 'same-key', value: 'newer real default' });
    assert.equal(entity(graph, created.id).status, 'superseded', 'the real owner\'s fact is the one superseded');
    assert.deepEqual(entity(graph, 'fact-legacy'), legacy);
    const projectless = entity(graph, 'fact-projectless');
    graph.addFact({ project: 'default', key: 'projectless-key', value: 'real default' });
    assert.deepEqual(entity(graph, 'fact-projectless'), projectless, 'nor a fact stored without a project');
    const reloaded = assertHealthy(graph, stage);
    assert.deepEqual(entity(reloaded, 'fact-legacy'), legacy);
  });

  test(`a record stored without a project matches no named project's retry (${stage})`, () => {
    const graph = open({ projectlessRetry: true });
    const legacy = entity(graph, 'decision-projectless');
    for (const project of ['default', 'beta']) {
      const created = graph.addDecision({ project, title: `Real ${project}`, chosen: 'n', idempotencyKey: 'retry-projectless' });
      assert.notEqual(created.id, 'decision-projectless', project);
    }
    assert.deepEqual(entity(graph, 'decision-projectless'), legacy);
    assertHealthy(graph, stage);
  });

  test(`an unambiguous legacy project keeps its retries and its identities (${stage})`, () => {
    const graph = open();
    assert.equal(graph.addDecision({ project: 'alpha', title: 'Legacy alpha decision', chosen: 'x', idempotencyKey: 'retry-decision-alpha' }).id, 'decision-alpha');
    assert.equal(graph.addAttempt({ project: 'alpha', solution: 'Legacy alpha attempt', result: 'worked', idempotencyKey: 'retry-attempt-alpha' }).id, 'attempt-alpha');
    const memory = graph.remember({ project: 'alpha', memoryType: 'note', key: 'same-key', text: 'Legacy alpha memory', idempotencyKey: 'retry-memory-alpha' });
    assert.deepEqual([memory.operation, memory.memory.id], ['NOOP', 'memory-alpha']);
    assert.equal(graph.addFact({ project: 'alpha', key: 'same-key', value: 'legacy alpha', idempotencyKey: 'retry-fact-alpha' }).id, 'fact-alpha');
    const update = graph.remember({ project: 'alpha', memoryType: 'note', key: 'same-key', text: 'Alpha, updated' });
    assert.deepEqual([update.operation, update.previous.id], ['UPDATE', 'memory-alpha'], 'the same owner supersedes as before');
    graph.addFact({ project: 'alpha', key: 'same-key', value: 'alpha, updated' });
    assert.equal(entity(graph, 'fact-alpha').status, 'superseded');
    assertHealthy(graph, stage);
  });

  test(`origins never match a legacy key or each other (${stage})`, () => {
    const graph = open();
    const first = graph.addAttempt({ originId: 'origin_a', solution: 'Captured', result: 'r', idempotencyKey: 'retry-attempt-legacy' });
    assert.notEqual(first.id, 'attempt-legacy');
    assert.equal(graph.addAttempt({ originId: 'origin_a', solution: 'Captured', result: 'r', idempotencyKey: 'retry-attempt-legacy' }).id, first.id);
    assert.notEqual(graph.addAttempt({ originId: 'origin_b', solution: 'Captured', result: 'r', idempotencyKey: 'retry-attempt-legacy' }).id, first.id);
    assert.notEqual(graph.addAttempt({ project: 'default', solution: 'Captured', result: 'r', idempotencyKey: 'retry-attempt-legacy' }).id, first.id);
    assertHealthy(graph, stage);
  });
}

test('a real "default" project keeps ordinary retry idempotency in a store with no legacy data', () => {
  const graph = createShadowGraph({ now });
  const first = graph.addAttempt({ project: 'default', solution: 'x', result: 'y', idempotencyKey: 'new-key' });
  assert.equal(graph.addAttempt({ project: 'default', solution: 'x', result: 'y', idempotencyKey: 'new-key' }).id, first.id);
  const memory = graph.remember({ project: 'default', memoryType: 'note', key: 'k', text: 't', idempotencyKey: 'mk' });
  assert.equal(graph.remember({ project: 'default', memoryType: 'note', key: 'k', text: 't', idempotencyKey: 'mk' }).memory.id, memory.memory.id);
  const fact = graph.addFact({ project: 'default', key: 'k', value: 1, idempotencyKey: 'fk' });
  assert.equal(graph.addFact({ project: 'default', key: 'k', value: 1, idempotencyKey: 'fk' }).id, fact.id);
});

test('a downgrade leaves out, and names, the real "default" memories and facts that share a legacy identity', () => {
  const graph = STAGES['after migration']();
  const memory = graph.remember({ project: 'default', memoryType: 'note', key: 'same-key', text: 'Real default memory' }).memory;
  const fact = graph.addFact({ project: 'default', key: 'same-key', value: 'real default' });
  const attempt = graph.addAttempt({ project: 'default', solution: 'Real default', result: 'r', idempotencyKey: 'retry-attempt-legacy' });
  const untwinned = graph.remember({ project: 'default', memoryType: 'note', key: 'only-real-default', text: 'No legacy twin' }).memory;
  const { payload, report } = downgradeToSchema5(privilegedSnapshot(graph), { now });
  assert.deepEqual(report.excluded.filter((item) => item.project === 'default').map((item) => item.id).sort(), [memory.id, fact.id].sort());
  const kept = new Set([...payload.records, ...payload.facts].map((item) => item.id));
  for (const id of ['memory-legacy', 'fact-legacy', 'memory-alpha', 'fact-alpha', attempt.id, untwinned.id]) assert.ok(kept.has(id), id);
  assert.doesNotThrow(() => validateRestorePayload(payload, { now }), 'the schema-5 fork is a valid store');
});

test('the separation survives a JSON and a SQLite save, a restart and a rebuild', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-ir02-persist-');
  const backends = [['json', join(directory, 'data.json')]];
  if (await sqliteOrSkip(t)) backends.push(['sqlite', join(directory, 'data.db')]);
  for (const [backend, file] of backends) {
    const open = async () => (backend === 'json' ? createJsonFileStore(file) : createSqliteStore(file));
    if (backend === 'json') await writeFile(file, JSON.stringify(legacyPayload()));
    else { const store = await open(); await store.save(legacyPayload()); store.close(); }
    let store = await open();
    const graph = createShadowGraph({ now });
    graph.importData(await store.load());
    graph.migrateAttribution({ limit: 3 });
    const created = graph.addAttempt({ project: 'default', solution: 'Real default', result: 'r', idempotencyKey: 'retry-attempt-legacy' });
    const memory = graph.remember({ project: 'default', memoryType: 'note', key: 'same-key', text: 'Real default memory', idempotencyKey: 'retry-memory-legacy' });
    graph.setRevision(await store.save(privilegedSnapshot(graph)));
    store.close?.();

    store = await open();
    const restarted = createShadowGraph({ now });
    restarted.importData(await store.load());
    restarted.migrateAttribution();
    assert.equal(restarted.addAttempt({ project: 'default', solution: 'Real default', result: 'r', idempotencyKey: 'retry-attempt-legacy' }).id, created.id, backend);
    assert.equal(restarted.remember({ project: 'default', memoryType: 'note', key: 'same-key', text: 'Real default memory', idempotencyKey: 'retry-memory-legacy' }).memory.id, memory.memory.id, backend);
    assert.equal(entity(restarted, 'memory-legacy').status, 'active', backend);
    assert.equal(entity(restarted, 'memory-legacy').attribution, 'legacy_ambiguous', backend);
    restarted.setRevision(await store.save(privilegedSnapshot(restarted)));
    store.close?.();
    const rebuilt = privilegedRebuild(restarted);
    assert.equal(rebuilt.rebuildable, true, `${backend}: ${rebuilt.reason}`);
    const byId = Object.fromEntries([...rebuilt.projection.records, ...rebuilt.projection.facts].map((item) => [item.id, item]));
    assert.equal(byId['memory-legacy'].status, 'active');
    assert.equal(byId[memory.memory.id].status, 'active');
    assert.equal(byId[created.id].attribution, 'project');
    assert.equal(privilegedValidate(restarted).valid, true, `${backend}: ${JSON.stringify(privilegedValidate(restarted).issues)}`);
  }
});
