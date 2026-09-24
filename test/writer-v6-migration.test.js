import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph, SCHEMA_VERSION } from '../src/shadowgraph.js';
import { createShadowGraphServer } from '../src/server.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { downgradeStore, downgradeToSchema5 } from '../src/schema-conversion.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// PR-07 (plan v1.4.4 §9.3, §9.6, §10.3, §19.3.2; P1 reconciliation F-03, F-13;
// owner decision OD-1 = option B, legacy_ambiguous): the writer writes schema 6
// with attribution, refuses a write that has no owner, and migrates legacy
// records resumably, journalled, without inferring or rewriting any project.

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'src', 'cli.js');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const runCli = (args, file, storage = 'json') => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: storage }, encoding: 'utf8' });

async function sqliteOrSkip(t) {
  try { await import('node:sqlite'); return true; }
  catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return false; }
}

const WRITES = {
  addDecision: { title: 'Cache', chosen: 'redis' },
  addAttempt: { solution: 'warm-up script', result: 'worked' },
  remember: { memoryType: 'note', key: 'k', text: 'a note' },
  applyMemoryPlan: { operations: [{ action: 'ADD', memoryType: 'note', key: 'plan', text: 'planned note' }] },
  addFact: { key: 'latency', value: 10 }
};
const recordOf = (method, result) => (method === 'remember' ? result.memory : method === 'applyMemoryPlan' ? result.results[0].memory : result);

test('the writer writes schema 6 and says whose each record is', () => {
  assert.equal(SCHEMA_VERSION, 6);
  const graph = createShadowGraph({ now });
  for (const [method, input] of Object.entries(WRITES)) {
    const record = recordOf(method, graph[method]({ ...input, project: 'alpha' }));
    assert.deepEqual({ schemaVersion: record.schemaVersion, project: record.project, attribution: record.attribution, originId: record.originId }, { schemaVersion: 6, project: 'alpha', attribution: 'project', originId: undefined }, method);
  }
  // "default" is an ordinary project name (OD-1): a new write to it is a real project.
  assert.equal(graph.addDecision({ project: 'default', title: 'Explicit', chosen: 'x' }).attribution, 'project');
  // An origin given alongside a project is kept as provenance.
  assert.equal(graph.addDecision({ project: 'alpha', originId: 'origin_a', title: 'With origin', chosen: 'x' }).originId, 'origin_a');
  const snapshot = privilegedSnapshot(graph);
  assert.equal(snapshot.schemaVersion, 6);
  assert.deepEqual([...new Set(snapshot.journal.map((entry) => entry.schemaVersion))], [6]);
  assert.equal(graph.stats().schemaVersion, 6);
  assert.equal(graph.validate().valid, true);
});

test('a write with neither a project nor an origin is refused, and nothing is stored (F-03)', () => {
  for (const [method, input] of Object.entries(WRITES)) {
    for (const originId of [undefined, null, '', '   ']) {
      const graph = createShadowGraph({ now });
      const before = JSON.stringify(privilegedSnapshot(graph));
      assert.throws(() => graph[method]({ ...input, ...(originId === undefined ? {} : { originId }) }), (error) => error.code === 'write_scope_unresolved' && error.reason === 'no_project_and_no_origin', `${method} ${JSON.stringify(originId)}`);
      assert.equal(JSON.stringify(privilegedSnapshot(graph)), before, `${method}: no record, journal entry or event`);
    }
  }
  // What is wrong with the content is still reported first.
  assert.throws(() => createShadowGraph().addDecision({}), /requires non-empty title and chosen/);
  assert.throws(() => createShadowGraph().addFact({ key: 'k', verificationStatus: 'verified' }), /cannot set fact verificationStatus to verified/);
  assert.throws(() => createShadowGraph().addDecision({ project: '', title: 'T', chosen: 'C' }), /project must be a non-empty string/);
});

test('an origin with no project owns its records alone: unattributed, isolated retries, no cross-origin supersession', () => {
  const graph = createShadowGraph({ now });
  for (const [method, input] of Object.entries(WRITES)) {
    const record = recordOf(method, graph[method]({ ...input, originId: 'origin_a' }));
    assert.deepEqual({ project: record.project, attribution: record.attribution, originId: record.originId }, { project: null, attribution: 'unattributed', originId: 'origin_a' }, method);
  }
  const first = graph.addDecision({ originId: 'origin_a', title: 'Retry', chosen: 'x', idempotencyKey: 'same' });
  assert.equal(graph.addDecision({ originId: 'origin_a', title: 'Retry again', chosen: 'y', idempotencyKey: 'same' }).id, first.id, 'a retry within the origin returns the first result');
  assert.notEqual(graph.addDecision({ originId: 'origin_b', title: 'Other origin', chosen: 'x', idempotencyKey: 'same' }).id, first.id, 'another origin never matches');
  assert.notEqual(graph.addDecision({ project: 'default', title: 'A project', chosen: 'x', idempotencyKey: 'same' }).id, first.id, 'a project never matches an origin');
  const journalled = graph.getJournal({ limit: 1000 }).items.find((entry) => entry.entityId === first.id);
  assert.equal(journalled.project, null);
  assert.equal(journalled.idempotencyKey, 'decision@"origin_a":same');

  const mine = graph.addDecision({ originId: 'origin_a', title: 'Mine', chosen: 'x' });
  const theirs = graph.addDecision({ originId: 'origin_b', title: 'Theirs', chosen: 'x' });
  assert.throws(() => graph.supersedeDecision({ decisionId: mine.id, replacementId: theirs.id }), /same project/, 'project null on both sides is not a shared owner');
  const mineToo = graph.addDecision({ originId: 'origin_a', title: 'Mine too', chosen: 'y' });
  assert.equal(graph.supersedeDecision({ decisionId: mine.id, replacementId: mineToo.id }).previous.status, 'superseded');

  // The same memory identity under two origins and under "default" stays three memories.
  graph.remember({ originId: 'origin_b', memoryType: 'note', key: 'k', text: 'b note' });
  graph.remember({ project: 'default', memoryType: 'note', key: 'k', text: 'default note' });
  const notes = privilegedSnapshot(graph).records.filter((record) => record.kind === 'memory' && record.key === 'k' && record.status === 'active');
  assert.equal(notes.length, 3);
  assert.equal(graph.validate().valid, true, JSON.stringify(graph.validate().issues));
  const reloaded = createShadowGraph({ now });
  reloaded.importData(privilegedSnapshot(graph));
  assert.equal(reloaded.validate().valid, true);
  assert.doesNotThrow(() => validateRestorePayload(privilegedSnapshot(graph), { now }));
});

test('HTTP and the CLI refuse an ownerless write and accept an origin', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v6-transport-');
  const app = await createShadowGraphServer({ file: join(directory, 'http.json') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  const post = (body) => fetch(`http://127.0.0.1:${app.server.address().port}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const refused = await post({ title: 'T', chosen: 'C' });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).code, 'write_scope_unresolved');
  const accepted = await post({ originId: 'origin_http', title: 'T', chosen: 'C' });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).attribution, 'unattributed');

  const file = join(directory, 'cli.json');
  const cliRefused = runCli(['decision', JSON.stringify({ title: 'T', chosen: 'C' })], file);
  assert.notEqual(cliRefused.status, 0);
  assert.match(cliRefused.stderr, /write_scope_unresolved/);
  const cliAccepted = runCli(['decision', JSON.stringify({ project: 'alpha', title: 'T', chosen: 'C' })], file);
  assert.equal(cliAccepted.status, 0, cliAccepted.stderr);
  assert.equal(JSON.parse(cliAccepted.stdout).attribution, 'project');
});

// A store as a schema-5 build left it: an explicit project, the shared
// "default" bucket (one record whose text names another project, to show no
// inference), and records stored with no project at all.
function legacyStore() {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', id: 'decision-alpha', title: 'Alpha cache', chosen: 'redis' });
  graph.addDecision({ project: 'default', id: 'decision-default', title: 'DataPulse ingestion for the datapulse project', chosen: 'kafka' });
  graph.addAttempt({ project: 'default', id: 'attempt-default', solution: 'retry', result: 'worked' });
  graph.remember({ project: 'default', id: 'memory-default', memoryType: 'note', key: 'n', text: 'a note' });
  graph.addFact({ project: 'default', id: 'fact-default', key: 'latency', value: 10 });
  graph.addDecision({ project: 'alpha', id: 'decision-retry', title: 'Retry', chosen: 'x', idempotencyKey: 'retry' });
  graph.addAttempt({ project: 'default', id: 'attempt-retry', solution: 'again', result: 'worked', idempotencyKey: 'retry' });
  const payload = privilegedSnapshot(graph);
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
  // Stored with no project at all (an early record that was never re-saved),
  // with the journal entry that recorded it.
  const projectless = { id: 'decision-projectless', kind: 'decision', schemaVersion: 5, title: 'Ownerless', chosen: 'y', status: 'proposed', confidence: { initial: 0.5, current: 0.5, history: [], policy: 'evidence_weighted_bounded_v1' }, alternatives: [], evidence: [], assumptions: [], createdAt: NOW, updatedAt: NOW };
  payload.records.push(projectless);
  payload.journalSeq += 1;
  payload.journal.push({ id: 'jentry-projectless', seq: payload.journalSeq, type: 'decision.recorded', at: NOW, project: null, entityKind: 'decision', entityId: projectless.id, schemaVersion: 5, payload: structuredClone(projectless), provenance: { actor: null, client: null, sessionId: null } });
  return payload;
}
const EXPECTED = {
  'decision-alpha': ['alpha', 'project'],
  'decision-retry': ['alpha', 'project'],
  'decision-default': ['default', 'legacy_ambiguous'],
  'attempt-default': ['default', 'legacy_ambiguous'],
  'attempt-retry': ['default', 'legacy_ambiguous'],
  'memory-default': ['default', 'legacy_ambiguous'],
  'fact-default': ['default', 'legacy_ambiguous'],
  'decision-projectless': ['default', 'legacy_unattributed']
};
const owners = (payload) => Object.fromEntries([...payload.records, ...payload.facts].map((entity) => [entity.id, [entity.project, entity.attribution]]));

test('the attribution migration maps legacy records by OD-1, journals each change, and infers nothing (WS-11)', () => {
  const graph = createShadowGraph({ now });
  graph.importData(legacyStore());
  const before = privilegedSnapshot(graph);
  assert.deepEqual([...new Set([...before.records, ...before.facts].map((entity) => entity.schemaVersion))], [5], 'import keeps legacy entities at schema 5');
  assert.equal([...before.records, ...before.facts].some((entity) => Object.hasOwn(entity, 'attribution')), false);

  const result = graph.migrateAttribution();
  assert.deepEqual({ migrated: result.migrated, remaining: result.remaining, complete: result.complete }, { migrated: 8, remaining: 0, complete: true });
  assert.deepEqual(result.attributions, { project: 2, legacy_ambiguous: 5, legacy_unattributed: 1 });
  const after = privilegedSnapshot(graph);
  assert.deepEqual(owners(after), EXPECTED, 'no project is rewritten or inferred; "default" becomes legacy_ambiguous');
  assert.deepEqual([...new Set([...after.records, ...after.facts].map((entity) => entity.schemaVersion))], [6]);
  const entries = after.journal.filter((entry) => entry.type === 'entity.attributed');
  assert.equal(entries.length, 8);
  assert.ok(entries.every((entry) => entry.payload.attributionChange.reason === 'migration' && entry.payload.attributionChange.previousAttribution === null));
  assert.equal(entries.find((entry) => entry.entityId === 'decision-default').payload.attributionChange.previousProject, 'default');
  assert.equal(result.highWaterMark, entries.at(-1).entityId);
  assert.equal(graph.validate().valid, true, JSON.stringify(graph.validate().issues));
  const rebuilt = graph.rebuild();
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.deepEqual(owners(rebuilt.projection), EXPECTED, 'a rebuild reproduces the attribution');
  assert.doesNotThrow(() => validateRestorePayload(after, { now }));
  // An unambiguous legacy project keeps its retries under the legacy keys. A
  // legacy "default" record is legacy_ambiguous, so the real project named
  // "default" does not inherit its retry key (OD-1; P1A correction IR-02).
  assert.equal(graph.addDecision({ project: 'alpha', title: 'Retry', chosen: 'x', idempotencyKey: 'retry' }).id, 'decision-retry');
  const realDefault = graph.addAttempt({ project: 'default', solution: 'again', result: 'worked', idempotencyKey: 'retry' });
  assert.notEqual(realDefault.id, 'attempt-retry');
  assert.equal(realDefault.attribution, 'project');
  // Idempotent: a second run changes nothing.
  const again = graph.migrateAttribution();
  assert.deepEqual({ migrated: again.migrated, complete: again.complete }, { migrated: 0, complete: true });
});

async function interruptedThenResumed(t, open) {
  const legacy = legacyStore();
  const reference = createShadowGraph({ now });
  reference.importData(legacy);
  reference.migrateAttribution();
  const expected = owners(privilegedSnapshot(reference));

  const first = await open(legacy);
  const graph = createShadowGraph({ now });
  graph.importData(await first.load());
  for (let batch = 0; batch < 2; batch += 1) {
    const step = graph.migrateAttribution({ limit: 1 });
    graph.setRevision(await first.save(privilegedSnapshot(graph)));
    assert.equal(step.migrated, 1);
  }
  first.close?.();
  // The process stops here, before the projectless record's turn. The partly
  // migrated store is valid and readable.
  const second = await open();
  const resumed = createShadowGraph({ now });
  resumed.importData(await second.load());
  assert.equal(resumed.validate().valid, true, JSON.stringify(resumed.validate().issues));
  const partial = privilegedSnapshot(resumed);
  assert.equal([...partial.records, ...partial.facts].filter((entity) => entity.attribution).length, 2);
  assert.equal(partial.records.find((entity) => entity.id === 'decision-projectless').attribution, undefined);
  const rest = resumed.migrateAttribution({ limit: 2 });
  assert.equal(rest.remaining, 4);
  resumed.setRevision(await second.save(privilegedSnapshot(resumed)));
  const finish = resumed.migrateAttribution();
  assert.equal(finish.complete, true);
  await second.save(privilegedSnapshot(resumed));
  second.close?.();

  const third = await open();
  const final = createShadowGraph({ now });
  final.importData(await third.load());
  third.close?.();
  const snapshot = privilegedSnapshot(final);
  // The projectless record migrates only after the restart. Its absent project
  // was recorded in the saved store (P1A correction IR-01), so the resumed
  // result is exactly the uninterrupted one.
  assert.deepEqual(owners(snapshot), expected);
  assert.equal(snapshot.journal.filter((entry) => entry.type === 'entity.attributed').length, 8, 'each entity attributed exactly once');
  assert.equal(final.validate().valid, true);
  assert.equal(final.rebuild().rebuildable, true);
  assert.doesNotThrow(() => validateRestorePayload(snapshot, { now }));
}

test('an interrupted migration leaves a readable store and resumes to the same result (JSON)', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v6-resume-json-');
  const file = join(directory, 'data.json');
  await interruptedThenResumed(t, async (initial) => {
    if (initial) await writeFile(file, JSON.stringify(initial, null, 2));
    return createJsonFileStore(file);
  });
});

test('an interrupted migration leaves a readable store and resumes to the same result (SQLite)', async (t) => {
  if (!await sqliteOrSkip(t)) return;
  const directory = await scratchDirectory(t, 'shadowgraph-v6-resume-sqlite-');
  const file = join(directory, 'data.db');
  await interruptedThenResumed(t, async (initial) => {
    const store = await createSqliteStore(file);
    if (initial) await store.save(initial);
    return store;
  });
});

test('the CLI migrates in batches after writing a verified preservation copy, and a rerun is a no-op', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v6-cli-migrate-');
  const file = join(directory, 'data.json');
  await writeFile(file, JSON.stringify(legacyStore(), null, 2));
  const original = await readFile(file);
  const copy = join(directory, 'preserved.json');
  const run = runCli(['migrate', JSON.stringify({ batchSize: 3, preservationCopy: copy })], file);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.deepEqual({ migrated: report.migrated, batches: report.batches, complete: report.complete }, { migrated: 8, batches: 3, complete: true });
  assert.equal(report.preservationCopy.verified, true);
  assert.equal(report.preservationCopy.sha256, sha256(await readFile(copy)));
  assert.equal(sha256(await readFile(copy)), sha256(original), 'the copy is the pre-migration store, byte for byte');
  const migrated = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(migrated.schemaVersion, 6);
  assert.deepEqual(owners(migrated), EXPECTED);
  const rerun = runCli(['migrate', JSON.stringify({ preservationCopy: join(directory, 'preserved-2.json') })], file);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.equal(JSON.parse(rerun.stdout).migrated, 0);
  const clash = runCli(['migrate', JSON.stringify({ preservationCopy: copy })], file);
  assert.notEqual(clash.status, 0, 'an existing file is never overwritten by a preservation copy');
});

function currentStore() {
  const graph = createShadowGraph({ now });
  graph.importData(legacyStore());
  graph.migrateAttribution();
  graph.addDecision({ originId: 'origin_a', id: 'decision-captured', title: 'Captured', chosen: 'x', alternatives: [{ id: 'alt-captured', label: 'y' }] });
  graph.addAttempt({ originId: 'origin_a', id: 'attempt-captured', solution: 's', result: 'r' });
  graph.link({ originId: 'origin_a', from: 'decision-captured', to: 'attempt-captured', relation: 'tried' });
  graph.addDecision({ project: 'beta', originId: 'origin_a', id: 'decision-beta', title: 'Beta', chosen: 'z' });
  return { graph, payload: { ...privilegedSnapshot(graph), futureCollection: { kept: true } } };
}

test('downgradeToSchema5 keeps what schema 5 can hold and names everything it cannot', () => {
  const { payload } = currentStore();
  const { payload: v5, report } = downgradeToSchema5(payload, { now });
  assert.equal(v5.schemaVersion, 5);
  assert.equal([...v5.records, ...v5.facts].some((entity) => Object.hasOwn(entity, 'attribution') || Object.hasOwn(entity, 'originId') || entity.schemaVersion === 6), false);
  assert.deepEqual(report.excluded.filter((item) => item.collection === 'records').map((item) => item.id).sort(), ['attempt-captured', 'decision-captured']);
  assert.ok(report.excluded.some((item) => item.collection === 'relations'));
  assert.deepEqual(report.excludedCollections, ['futureCollection']);
  assert.ok(report.removedFields.some((item) => item.id === 'decision-beta' && item.fields.includes('originId')));
  assert.equal(report.journal.replacedEntries, payload.journal.length);
  assert.equal(v5.journal.length, 1);
  assert.equal(v5.journal[0].type, 'projection.baseline');
  assert.doesNotThrow(() => validateRestorePayload(v5, { now }));
  const reloaded = createShadowGraph({ now });
  reloaded.importData(v5);
  assert.deepEqual(owners(privilegedSnapshot(reloaded))['decision-default'], ['default', undefined]);
});

test('downgrade writes a separate schema-5 file after a verified preservation copy and leaves the store untouched (JSON, CLI)', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v6-downgrade-json-');
  const file = join(directory, 'data.json');
  const { payload } = currentStore();
  await writeFile(file, JSON.stringify(payload, null, 2));
  const before = await readFile(file);
  const output = join(directory, 'schema5.json');
  const copy = join(directory, 'preserved.json');
  const run = runCli(['downgrade', JSON.stringify({ output, preservationCopy: copy })], file);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(sha256(await readFile(file)), sha256(before), 'the current store is left inert');
  assert.equal(sha256(await readFile(copy)), sha256(before));
  const written = JSON.parse(await readFile(`${output}.report.json`, 'utf8'));
  assert.equal(written.status, 'complete');
  assert.equal(written.preservationCopy.sha256, sha256(before));
  assert.equal(written.outputSha256, sha256(await readFile(output)));
  const v5 = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(v5.schemaVersion, 5);
  assert.equal(v5.records.some((record) => record.id === 'decision-captured'), false);
  for (const refused of [{ output: file }, { output }]) {
    assert.notEqual(runCli(['downgrade', JSON.stringify({ ...refused, preservationCopy: join(directory, `other-${Math.random()}.json`) })], file).status, 0, `refused ${refused.output}`);
  }
});

test('downgrade works on a SQLite store and v5 -> v6 -> v5 keeps every schema-5 record', async (t) => {
  if (!await sqliteOrSkip(t)) return;
  const directory = await scratchDirectory(t, 'shadowgraph-v6-downgrade-sqlite-');
  const file = join(directory, 'data.db');
  const legacy = legacyStore();
  const store = await createSqliteStore(file);
  await store.save(legacy);
  const graph = createShadowGraph({ now });
  graph.importData(await store.load());
  const imported = privilegedSnapshot(graph);
  graph.migrateAttribution();
  graph.setRevision(await store.save(privilegedSnapshot(graph)));
  const output = join(directory, 'schema5.db');
  const result = await downgradeStore({ graph, store, file, storageType: 'sqlite', output, preservationCopy: join(directory, 'preserved.db'), now });
  assert.equal(result.status, 'complete');
  assert.equal(result.preservationCopy.verified, true);
  const downgraded = await (await createSqliteStore(output)).load();
  assert.equal(downgraded.schemaVersion, 5);
  const strip = ({ attribution, originId, schemaVersion, ...rest }) => rest;
  const byId = (items) => Object.fromEntries(items.map((item) => [item.id, strip(item)]));
  // Every record comes back as the schema-5 build held it.
  assert.deepEqual(byId([...downgraded.records, ...downgraded.facts]), byId([...imported.records, ...imported.facts]));
  store.close();
});
