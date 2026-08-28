import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';

const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'];

async function readIfPresent(path) {
  try { return await readFile(path); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

test('normal SQLite save physically erases bytes removed by a graph hard purge', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }

  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph sqlite normal save erasure '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'live state with spaces.db');
  const sentinel = `SQLITE-NORMAL-SAVE-PURGE-${randomUUID()}-${'secret'.repeat(15)}`;
  const graph = createShadowGraph({ now: () => '2026-08-28T00:00:00.000Z' });
  graph.addDecision({
    id: `decision-${sentinel}`,
    project: 'private-project',
    title: sentinel,
    chosen: sentinel,
    idempotencyKey: `retry-${sentinel}`
  });
  graph.addDecision({ id: 'kept-decision', project: 'kept-project', title: 'Keep', chosen: 'safe' });

  let store = await createSqliteStore(file);
  const firstRevision = await store.save(graph.exportData());
  assert.equal((await readFile(file)).includes(Buffer.from(sentinel)), true, 'precondition: secret sentinel reached SQLite bytes');

  const purge = graph.purgeProject('private-project', { mode: 'hard' });
  assert.equal(purge.mode, 'hard');
  const purged = graph.exportData();
  assert.equal(JSON.stringify(purged).includes(sentinel), false, 'graph hard purge removes the sentinel logically');
  const secondRevision = await store.save({ ...purged, expectedRevision: firstRevision });
  assert.equal(secondRevision, firstRevision + 1);
  store.close();
  store = undefined;

  const inspector = new DatabaseSync(new URL(`${pathToFileURL(file).href}?immutable=1`), { readOnly: true });
  try {
    assert.equal(inspector.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(inspector.prepare('PRAGMA freelist_count').get().freelist_count, 0, 'destructive save must leave no retained free pages');
  } finally {
    inspector.close();
  }

  const candidates = [file, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${file}${suffix}`)];
  for (const candidate of candidates) {
    const bytes = await readIfPresent(candidate);
    if (bytes) assert.equal(bytes.includes(Buffer.from(sentinel)), false, `${candidate} retained the purged sentinel`);
  }
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    assert.equal(await readIfPresent(`${file}${suffix}`), null, `closed destructive save must not retain ${suffix}`);
  }
});

function secretGraph(sentinel, privateProject = 'private-project') {
  const graph = createShadowGraph({ now: () => '2026-08-28T00:00:00.000Z' });
  graph.addDecision({
    id: `decision-${sentinel}`,
    project: privateProject,
    title: sentinel,
    chosen: sentinel,
    idempotencyKey: `retry-${sentinel}`
  });
  graph.addDecision({ id: 'kept-decision', project: 'kept-project', title: 'Keep', chosen: 'safe' });
  return graph;
}

async function assertClosedDatabaseErased(DatabaseSync, file, sentinel, label) {
  const inspector = new DatabaseSync(new URL(`${pathToFileURL(file).href}?immutable=1`), { readOnly: true });
  try {
    assert.equal(inspector.prepare('PRAGMA integrity_check').get().integrity_check, 'ok', `${label} integrity`);
    assert.equal(inspector.prepare('PRAGMA freelist_count').get().freelist_count, 0, `${label} freelist`);
  } finally {
    inspector.close();
  }
  for (const candidate of [file, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${file}${suffix}`)]) {
    const bytes = await readIfPresent(candidate);
    if (bytes) assert.equal(bytes.includes(Buffer.from(sentinel)), false, `${label}: ${candidate} retained the sentinel`);
  }
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    assert.equal(await readIfPresent(`${file}${suffix}`), null, `${label} retained ${suffix}`);
  }
}

test('normal SQLite save physically erases bytes removed by a graph logical purge', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph sqlite logical erasure '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'logical live.db');
  const sentinel = `SQLITE-LOGICAL-PURGE-${randomUUID()}-${'private'.repeat(12)}`;
  const graph = secretGraph(sentinel);
  const store = await createSqliteStore(file);
  const firstRevision = await store.save(graph.exportData());
  assert.equal((await readFile(file)).includes(Buffer.from(sentinel)), true);
  const purge = graph.purgeProject('private-project', { mode: 'logical' });
  assert.ok(purge.journalEntriesRedacted > 0);
  const purged = graph.exportData();
  assert.equal(JSON.stringify(purged).includes(sentinel), false);
  assert.equal(await store.save({ ...purged, expectedRevision: firstRevision }), firstRevision + 1);
  store.close();
  await assertClosedDatabaseErased(DatabaseSync, file, sentinel, 'logical purge save');
});

test('destructive SQLite save rolls back before COMMIT and reconciles an injected error after COMMIT', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph sqlite save faults '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'fault live.db');
  const sentinel = `SQLITE-SAVE-FAULT-${randomUUID()}-${'secret'.repeat(12)}`;
  const graph = secretGraph(sentinel);
  let injectedStage = null;
  let injectionEnabled = false;
  const store = await createSqliteStore(file, {
    saveFault(stage, context) {
      assert.equal(typeof context.destructive, 'boolean');
      if (injectionEnabled && stage === injectedStage) throw new Error(`injected ${stage}`);
    }
  });
  const firstRevision = await store.save(graph.exportData());
  graph.purgeProject('private-project', { mode: 'hard' });
  const purged = graph.exportData();

  injectedStage = 'beforeCommit';
  injectionEnabled = true;
  await assert.rejects(
    store.save({ ...purged, expectedRevision: firstRevision }),
    /injected beforeCommit/
  );
  const rolledBack = await store.load();
  assert.equal(rolledBack.revision, firstRevision, 'pre-commit failure preserves revision');
  assert.equal(JSON.stringify(rolledBack).includes(sentinel), true, 'pre-commit failure preserves old logical state');
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    assert.equal(await readIfPresent(`${file}${suffix}`), null, `rolled-back save retained ${suffix}`);
  }

  injectedStage = 'afterCommit';
  assert.equal(
    await store.save({ ...purged, expectedRevision: firstRevision }),
    firstRevision + 1,
    'a verified committed write is acknowledged instead of reported as a false rollback'
  );
  injectionEnabled = false;
  store.close();
  await assertClosedDatabaseErased(DatabaseSync, file, sentinel, 'post-commit reconciliation');

  const reopened = await createSqliteStore(file);
  try {
    const durable = await reopened.load();
    assert.equal(durable.revision, firstRevision + 1);
    assert.equal(JSON.stringify(durable).includes(sentinel), false);
  } finally {
    reopened.close();
  }
  await assertClosedDatabaseErased(DatabaseSync, file, sentinel, 'fresh reopen');
});

test('append-only SQLite saves do not pay the destructive VACUUM path', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph sqlite append only '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'append live.db');
  const statements = [];
  const store = await createSqliteStore(file, {
    openDatabase(path, options) {
      const database = options ? new DatabaseSync(path, options) : new DatabaseSync(path);
      return new Proxy(database, {
        get(target, property) {
          if (property === 'exec') return (sql) => { statements.push(String(sql)); return target.exec(sql); };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    }
  });
  const graph = createShadowGraph({ now: () => '2026-08-28T00:00:00.000Z' });
  graph.addDecision({ id: 'append-one', project: 'append', title: 'One', chosen: 'one' });
  const firstRevision = await store.save(graph.exportData());
  graph.addDecision({ id: 'append-two', project: 'append', title: 'Two', chosen: 'two' });
  assert.equal(await store.save({ ...graph.exportData(), expectedRevision: firstRevision }), firstRevision + 1);
  store.close();
  assert.equal(statements.some((sql) => /\bVACUUM\b/i.test(sql)), false, 'append-only saves must skip compaction');
});

test('destructive save serializes across idle stores and rejects the stale writer', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph sqlite destructive concurrency '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'concurrent live.db');
  const sentinel = `SQLITE-CONCURRENT-PURGE-${randomUUID()}-${'secret'.repeat(10)}`;
  const graph = secretGraph(sentinel);
  const first = await createSqliteStore(file);
  const firstRevision = await first.save(graph.exportData());
  const second = await createSqliteStore(file);
  const stale = await second.load();
  graph.purgeProject('private-project', { mode: 'hard' });
  const purged = graph.exportData();
  assert.equal(await first.save({ ...purged, expectedRevision: firstRevision }), firstRevision + 1);
  await assert.rejects(
    second.save({ ...stale, records: [...stale.records, { id: 'stale', kind: 'decision' }], expectedRevision: firstRevision }),
    /revision conflict/i
  );
  first.close();
  second.close();
  await assertClosedDatabaseErased(DatabaseSync, file, sentinel, 'concurrent destructive save');
});

test('destructive save fences a separate stale writer process', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph sqlite destructive process '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'process live.db');
  const sentinel = `SQLITE-PROCESS-PURGE-${randomUUID()}-${'secret'.repeat(10)}`;
  const graph = secretGraph(sentinel);
  const store = await createSqliteStore(file);
  const firstRevision = await store.save(graph.exportData());

  const moduleUrl = new URL('../src/sqlite-storage.js', import.meta.url).href;
  const childCode = `
    const { createSqliteStore } = await import(${JSON.stringify(moduleUrl)});
    const store = await createSqliteStore(process.env.SHADOWGRAPH_TEST_FILE);
    const stale = await store.load();
    process.stdout.write(JSON.stringify({ phase: 'loaded', revision: stale.revision }) + '\\n');
    process.stdin.once('data', async () => {
      try {
        const revision = await store.save({
          ...stale,
          records: [...stale.records, { id: 'stale-process-write', kind: 'decision', project: 'stale' }],
          expectedRevision: stale.revision
        });
        process.stdout.write(JSON.stringify({ phase: 'saved', revision }) + '\\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ phase: 'rejected', name: error.name, message: error.message }) + '\\n');
      } finally {
        store.close();
      }
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childCode], {
    env: { ...process.env, SHADOWGRAPH_TEST_FILE: file },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let buffered = '';
  const messages = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines.filter(Boolean)) messages.push(JSON.parse(line));
  });
  for (let attempt = 0; attempt < 200 && messages.length < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(messages[0], { phase: 'loaded', revision: firstRevision });

  graph.purgeProject('private-project', { mode: 'hard' });
  assert.equal(await store.save({ ...graph.exportData(), expectedRevision: firstRevision }), firstRevision + 1);
  child.stdin.end('save');
  await once(child, 'exit');
  assert.equal(messages[1]?.phase, 'rejected');
  assert.equal(messages[1]?.name, 'RevisionConflictError');
  assert.match(messages[1]?.message ?? '', /revision conflict/i);
  store.close();
  await assertClosedDatabaseErased(DatabaseSync, file, sentinel, 'cross-process destructive save');
});

test('normal destructive save stays erased through SQLite backup and restore', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph sqlite purge backup restore '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const live = join(directory, 'live source.db');
  const backup = join(directory, 'purged backup.db');
  const restored = join(directory, 'restored destination.db');
  const sentinel = `SQLITE-BACKUP-RESTORE-PURGE-${randomUUID()}-${'secret'.repeat(10)}`;
  const graph = secretGraph(sentinel);
  const sourceStore = await createSqliteStore(live);
  const firstRevision = await sourceStore.save(graph.exportData());
  graph.purgeProject('private-project', { mode: 'hard' });
  assert.equal(await sourceStore.save({ ...graph.exportData(), expectedRevision: firstRevision }), firstRevision + 1);
  await sourceStore.backup(backup);
  sourceStore.close();

  const destinationStore = await createSqliteStore(restored);
  await destinationStore.save(secretGraph('destination-old-secret').exportData());
  await destinationStore.restore(backup);
  const restoredPayload = await destinationStore.load();
  assert.equal(restoredPayload.revision, firstRevision + 2, 'restore revision remains monotonic');
  destinationStore.close();
  for (const [path, label] of [[live, 'live'], [backup, 'backup'], [restored, 'restored']]) {
    await assertClosedDatabaseErased(DatabaseSync, path, sentinel, label);
  }
});
