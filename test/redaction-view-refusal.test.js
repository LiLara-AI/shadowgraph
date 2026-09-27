import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// Labels below refer to IDs returned by ordinary creation, never supplied IDs.
const fixtureIds = {};

// P1 finding F-36 (PR-10 targeted correction): a scoped redaction is a read of
// one scope, like the public export. Taken for a store it would replace every
// other project with nothing, so every redaction result says what it is --
// exportKind 'scoped_redaction', stamped after redaction has run, so no
// pattern or replacement text can remove or alter it -- and every import,
// replace, save and restore refuses it before touching the destination. The
// complete store still saves, backs up and restores whole. Every fixture is
// synthetic.

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const FUTURE = { opaque: [{ id: 'f1', nested: { values: [1, 'two', null, true] } }], note: 'a collection this build does not know' };
const ACCESS = { lineageId: 'lineage-test', entries: [{ accessId: 'grant-1', type: 'grant', state: 'active' }] };
const OWNERS = () => [fixtureIds['alpha-decision'], fixtureIds['beta-decision'], fixtureIds['real-dflt-decision'], fixtureIds['origin-a-decision']].sort();

// Two projects, the real "default", an origin, a relation, a secret, and a
// collection this build does not know plus an authority collection.
function fixture() {
  const writer = createShadowGraph({ now });
  fixtureIds['alpha-decision'] = writer.addDecision({ project: 'alpha', title: 'Alpha cache', chosen: 'redis' }).id;
  fixtureIds['alpha-attempt'] = writer.addAttempt({ project: 'alpha', solution: 'alpha warm-up', result: 'worked' }).id;
  fixtureIds['relation-alpha'] = writer.link({ project: 'alpha', from: fixtureIds['alpha-decision'], to: fixtureIds['alpha-attempt'], relation: 'tried' }).id;
  fixtureIds['alpha-memory'] = writer.remember({ project: 'alpha', memoryType: 'note', key: 'note', text: 'Alpha note, header Bearer alpha-view-token' }).memory.id;
  fixtureIds['alpha-fact'] = writer.addFact({ project: 'alpha', key: 'latency', value: 10 }).id;
  fixtureIds['beta-decision'] = writer.addDecision({ project: 'beta', title: 'Beta cache', chosen: 'memcached' }).id;
  fixtureIds['beta-fact'] = writer.addFact({ project: 'beta', key: 'latency', value: 99 }).id;
  fixtureIds['real-dflt-decision'] = writer.addDecision({ project: 'default', title: 'Real default', chosen: 'x' }).id;
  fixtureIds['origin-a-decision'] = writer.addDecision({ originId: 'origin_a', title: 'Origin a', chosen: 'x' }).id;
  const graph = createShadowGraph({ now });
  graph.importData({ ...privilegedSnapshot(writer), futureCollection: FUTURE, access: ACCESS });
  return graph;
}

// Every scoped view this build emits, raw and after a JSON round trip.
function views(graph) {
  const emitted = {
    'redact alpha': graph.redact({ project: 'alpha' }),
    'redact beta': graph.redact({ project: 'beta' }),
    'redact unresolved': graph.redact({}),
    'redact origin_a': graph.redact({ originId: 'origin_a' }),
    'redact alpha, no patterns': graph.redact({ project: 'alpha', patterns: [] }),
    'redact alpha, project labels masked': graph.redact({ project: 'alpha', patterns: ['^project$'] }),
    'public export alpha': graph.exportData({ project: 'alpha' })
  };
  for (const [label, view] of Object.entries(emitted)) emitted[`${label} (JSON)`] = JSON.parse(JSON.stringify(view));
  return emitted;
}

const refused = { code: 'public_export_not_a_store' };

test('every scoped redaction says it is a view, whatever the patterns and replacement', () => {
  const graph = fixture();
  const options = [
    {},
    { patterns: [] },
    { patterns: ['exportKind', 'kind', 'scoped_redaction', 'redaction'] },
    { patterns: ['.'], replacement: 'public_scoped' },
    { replacement: 'scoped_redaction' },
    { patterns: ['export'], replacement: '' }
  ];
  for (const scope of [{ project: 'alpha' }, { project: 'beta' }, {}, { originId: 'origin_a' }]) {
    for (const option of options) {
      const label = JSON.stringify({ ...scope, ...option });
      const view = graph.redact({ ...scope, ...option });
      assert.equal(view.exportKind, 'scoped_redaction', label);
      assert.equal(JSON.parse(JSON.stringify(view)).exportKind, 'scoped_redaction', `${label} after JSON`);
    }
  }
  // The redaction itself is unchanged: alpha's secret is still redacted.
  assert.equal(JSON.stringify(graph.redact({ project: 'alpha' })).includes('alpha-view-token'), false);
  // The complete store never carries a view kind.
  assert.equal(Object.hasOwn(privilegedSnapshot(graph), 'exportKind'), false);
});

test('import, merge and replace refuse every scoped view and leave the graph unchanged', () => {
  const graph = fixture();
  const before = JSON.stringify(privilegedSnapshot(graph));
  for (const [label, view] of Object.entries(views(graph))) {
    assert.throws(() => createShadowGraph({ now }).importData(view), refused, `${label}: import into an empty graph`);
    assert.throws(() => graph.importData(view), refused, `${label}: merge into the live graph`);
    assert.throws(() => graph.replaceData(view), refused, `${label}: replace`);
    assert.throws(() => validateRestorePayload(view), refused, `${label}: restore validation`);
    assert.equal(JSON.stringify(privilegedSnapshot(graph)), before, `${label}: nothing changed`);
  }
  // Still usable.
  fixtureIds['beta-after'] = graph.addDecision({ project: 'beta', title: 'After', chosen: 'y' }).id;
  assert.ok(privilegedSnapshot(graph).records.some((record) => record.id === fixtureIds['beta-after']));
});

test('JSON and SQLite stores refuse to save a scoped view over an existing two-project store', async (t) => {
  const graph = fixture();
  const directory = await scratchDirectory(t, 'shadowgraph-view-save-');
  for (const type of ['json', 'sqlite']) {
    const file = join(directory, `live.${type === 'json' ? 'json' : 'db'}`);
    const store = await createStorage({ type, file });
    try {
      await store.save(privilegedSnapshot(graph));
      const saved = await store.load();
      const bytes = type === 'json' ? await readFile(file) : null;
      // The views come from a graph holding the store's current revision, as a
      // running server's does, so no revision conflict can refuse them first.
      const current = createShadowGraph({ now });
      current.importData(saved);
      for (const [label, view] of Object.entries(views(current))) {
        assert.equal(view.revision ?? saved.revision, saved.revision, `${type} ${label}: the view is at the store's revision`);
        await assert.rejects(store.save(view), refused, `${type} ${label}`);
        assert.deepEqual(await store.load(), saved, `${type} ${label}: store unchanged`);
        if (bytes) assert.deepEqual(await readFile(file), bytes, `${type} ${label}: bytes unchanged`);
      }
      assert.equal(saved.revision, (await store.load()).revision);
      assert.deepEqual(saved.futureCollection, FUTURE);
      assert.deepEqual(saved.access, ACCESS);
      // The destination is still a working store.
      const reopened = createShadowGraph({ now });
      reopened.importData(await store.load());
      fixtureIds[`alpha-after-${type}`] = reopened.addDecision({ project: 'alpha', title: 'After', chosen: 'y' }).id;
      await store.save(privilegedSnapshot(reopened));
      const after = await store.load();
      for (const id of [...OWNERS(), fixtureIds[`alpha-after-${type}`]]) assert.ok(after.records.some((record) => record.id === id), `${type} keeps ${id}`);
    } finally { store.close?.(); }
  }
});

test('restore refuses a scoped view and leaves an existing destination whole (JSON and SQLite)', async (t) => {
  const graph = fixture();
  const directory = await scratchDirectory(t, 'shadowgraph-view-restore-');

  // JSON: the supported restore installs a JSON file over the live store.
  const destination = join(directory, 'destination.json');
  const destinationStore = await createStorage({ type: 'json', file: destination });
  await destinationStore.save(privilegedSnapshot(graph));
  const destinationBytes = await readFile(destination);
  for (const [label, view] of Object.entries(views(graph))) {
    const source = join(directory, `view-${label.replace(/[^a-z0-9]+/gi, '-')}.json`);
    await writeFile(source, JSON.stringify(view));
    await assert.rejects(restoreFile(source, destination, {}), /public_export_not_a_store/, `json ${label}`);
    assert.deepEqual(await readFile(destination), destinationBytes, `json ${label}: destination bytes unchanged`);
  }
  const loaded = await destinationStore.load();
  for (const id of OWNERS()) assert.ok(loaded.records.some((record) => record.id === id), `json keeps ${id}`);

  // SQLite: the supported restore installs another database. A view can reach
  // one only through a build without this guard, which keeps a key it does not
  // know as an extra collection; that database is built the same way here.
  const { DatabaseSync } = await import('node:sqlite');
  const live = await createStorage({ type: 'sqlite', file: join(directory, 'destination.db') });
  try {
    await live.save(privilegedSnapshot(graph));
    const before = await live.load();
    for (const [label, view] of Object.entries(views(graph))) {
      const sourceFile = join(directory, `view-${label.replace(/[^a-z0-9]+/gi, '-')}.db`);
      const { exportKind, ...body } = view;
      const sourceStore = await createStorage({ type: 'sqlite', file: sourceFile });
      await sourceStore.save({ ...body, revision: 0 });
      sourceStore.close();
      const database = new DatabaseSync(sourceFile);
      database.prepare('INSERT INTO shadowgraph_extra (collection, payload) VALUES (?, ?)').run('exportKind', JSON.stringify(exportKind));
      database.close();
      const check = await createStorage({ type: 'sqlite', file: sourceFile });
      assert.equal((await check.load()).exportKind, exportKind, `sqlite ${label}: the source holds the view`);
      check.close();
      await assert.rejects(live.restore(sourceFile), /public_export_not_a_store/, `sqlite ${label}`);
      assert.deepEqual(await live.load(), before, `sqlite ${label}: destination unchanged`);
    }
    for (const id of OWNERS()) assert.ok(before.records.some((record) => record.id === id), `sqlite keeps ${id}`);
  } finally { live.close(); }
});

test('a caller-supplied restore validator cannot let a scoped view in (JSON and SQLite)', async (t) => {
  const graph = fixture();
  const directory = await scratchDirectory(t, 'shadowgraph-view-validator-');
  const permissive = async (payload) => payload;
  const view = graph.redact({ project: 'alpha' });

  const destination = join(directory, 'destination.json');
  const jsonStore = await createStorage({ type: 'json', file: destination, restoreValidator: permissive });
  await jsonStore.save(privilegedSnapshot(graph));
  const bytes = await readFile(destination);
  const source = join(directory, 'view.json');
  await writeFile(source, JSON.stringify(view));
  await assert.rejects(restoreFile(source, destination, { validate: permissive }), /public_export_not_a_store/);
  assert.deepEqual(await readFile(destination), bytes);

  const { DatabaseSync } = await import('node:sqlite');
  const sourceFile = join(directory, 'view.db');
  const { exportKind, ...body } = view;
  const sourceStore = await createStorage({ type: 'sqlite', file: sourceFile });
  await sourceStore.save({ ...body, revision: 0 });
  sourceStore.close();
  const database = new DatabaseSync(sourceFile);
  database.prepare('INSERT INTO shadowgraph_extra (collection, payload) VALUES (?, ?)').run('exportKind', JSON.stringify(exportKind));
  database.close();
  const live = await createStorage({ type: 'sqlite', file: join(directory, 'destination.db'), restoreValidator: permissive });
  try {
    await live.save(privilegedSnapshot(graph));
    const before = await live.load();
    await assert.rejects(live.restore(sourceFile, { validate: permissive }), /public_export_not_a_store/);
    assert.deepEqual(await live.load(), before);
  } finally { live.close(); }
});

test('the complete store still saves, backs up and restores whole (JSON and SQLite)', async (t) => {
  const graph = fixture();
  // A backup that carries authority is refused by restore unless memory only
  // is asked for (R16 rev 2), so the backup here is the memory store.
  const complete = privilegedSnapshot(graph);
  delete complete.access;
  const directory = await scratchDirectory(t, 'shadowgraph-view-complete-');
  for (const type of ['json', 'sqlite']) {
    const extension = type === 'json' ? 'json' : 'db';
    const liveFile = join(directory, `live.${extension}`);
    const backup = join(directory, `backup.${extension}`);
    const destination = join(directory, `destination.${extension}`);
    const liveStore = await createStorage({ type, file: liveFile });
    await liveStore.save(complete);
    await backupFile(liveFile, backup, { store: liveStore });
    liveStore.close?.();
    const destinationStore = await createStorage({ type, file: destination });
    const other = createShadowGraph({ now });
    fixtureIds[`gamma-${type}`] = other.addDecision({ project: 'gamma', title: 'Replaced by the restore', chosen: 'x' }).id;
    await destinationStore.save(privilegedSnapshot(other));
    if (type === 'sqlite') await destinationStore.restore(backup);
    else { destinationStore.close?.(); await restoreFile(backup, destination, {}); }
    const reopened = await createStorage({ type, file: destination });
    const restored = await reopened.load();
    reopened.close?.();
    if (type === 'sqlite') destinationStore.close();
    for (const id of OWNERS()) assert.ok(restored.records.some((record) => record.id === id), `${type} restores ${id}`);
    assert.deepEqual(restored.futureCollection, FUTURE, `${type} keeps the unknown collection`);
    const reloaded = createShadowGraph({ now });
    reloaded.importData(restored);
    assert.deepEqual(reloaded.exportData({ project: 'beta' }).records.map((record) => record.id), [fixtureIds['beta-decision']]);
  }
});
