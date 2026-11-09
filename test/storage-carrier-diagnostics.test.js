import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';

async function sqlite(t) {
  try { return (await import('node:sqlite')).DatabaseSync; }
  catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return null; }
}

function addCarriers(DatabaseSync, file) {
  const database = new DatabaseSync(file);
  try {
    const insert = database.prepare('INSERT INTO shadowgraph_extra (collection, payload) VALUES (?, ?)');
    insert.run('records', 'PRIVATE-RESERVED-PAYLOAD-not-json');
    insert.run('expectedRevision', 'PRIVATE-CONTROL-PAYLOAD-not-json');
    insert.run('futureCollection', JSON.stringify({ secret: 'PRIVATE-FUTURE-PAYLOAD' }));
  } finally { database.close(); }
}

function carrierRows(DatabaseSync, file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try { return database.prepare('SELECT collection, payload FROM shadowgraph_extra ORDER BY collection').all(); }
  finally { database.close(); }
}

const expectedDiagnostics = {
  valid: false,
  issues: [
    { code: 'sqlite_extra_reserved_key', collection: 'expectedRevision' },
    { code: 'sqlite_extra_reserved_key', collection: 'records' }
  ]
};

test('SQLite carrier validation diagnoses reserved names without reading payloads or changing bytes', async (t) => {
  const DatabaseSync = await sqlite(t);
  if (!DatabaseSync) return;
  const directory = await scratchDirectory(t, 'carrier-validation-');
  const file = join(directory, 'store.sqlite');
  let validating = false;
  const opened = [];
  const store = await createSqliteStore(file, {
    openDatabase(path, options) {
      const database = options ? new DatabaseSync(path, options) : new DatabaseSync(path);
      if (validating) {
        opened.push(options);
        const prepare = database.prepare.bind(database);
        database.prepare = (sql) => {
          assert.doesNotMatch(sql, /payload/i, 'diagnostic must never read carrier payloads');
          return prepare(sql);
        };
        database.exec = () => { throw new Error('diagnostic must not execute schema or mutation statements'); };
      }
      return database;
    }
  });
  t.after(() => store.close());
  addCarriers(DatabaseSync, file);
  const beforeRows = carrierRows(DatabaseSync, file);
  const beforeBytes = await readFile(file);
  validating = true;
  assert.deepEqual(await store.validate(), expectedDiagnostics);
  validating = false;
  assert.deepEqual(opened, [{ readOnly: true }]);
  assert.deepEqual(await readFile(file), beforeBytes);
  assert.deepEqual(carrierRows(DatabaseSync, file), beforeRows);

  const loaded = await store.load();
  assert.deepEqual(loaded.records, [], 'reserved row must not overwrite native data');
  assert.equal(loaded.expectedRevision, undefined, 'control row must not become a save instruction');
  assert.deepEqual(loaded.futureCollection, { secret: 'PRIVATE-FUTURE-PAYLOAD' });
  await store.save(loaded);
  assert.deepEqual(await store.validate(), { valid: true, issues: [] });
  assert.deepEqual(carrierRows(DatabaseSync, file).map(row => row.collection), ['futureCollection']);
  assert.deepEqual((await store.load()).futureCollection, loaded.futureCollection);
});

test('doctor reports bounded storage diagnostics without payloads and preserves its clean storage shape', async (t) => {
  const DatabaseSync = await sqlite(t);
  if (!DatabaseSync) return;
  const directory = await scratchDirectory(t, 'carrier-doctor-');
  const file = join(directory, 'store.sqlite');
  const store = await createSqliteStore(file);
  t.after(() => store.close());
  const doctor = () => spawnSync(process.execPath, ['src/cli.js', 'doctor'], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, SHADOWGRAPH_STORAGE: 'sqlite', SHADOWGRAPH_FILE: file }
  });
  const clean = doctor();
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(JSON.parse(clean.stdout).storage, {
    type: 'sqlite', path: resolve(file), initialized: true, readable: true, writable: true
  });
  addCarriers(DatabaseSync, file);
  const beforeRows = carrierRows(DatabaseSync, file);
  const diagnosed = doctor();
  assert.equal(diagnosed.status, 1, diagnosed.stderr);
  const report = JSON.parse(diagnosed.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.storage.diagnostics, expectedDiagnostics);
  assert.doesNotMatch(diagnosed.stdout + diagnosed.stderr, /PRIVATE-|futureCollection/);
  assert.deepEqual(carrierRows(DatabaseSync, file), beforeRows);
});

test('SQLite carrier validation refuses a closed store', async (t) => {
  if (!await sqlite(t)) return;
  const directory = await scratchDirectory(t, 'carrier-closed-');
  const store = await createSqliteStore(join(directory, 'store.sqlite'));
  store.close();
  await assert.rejects(store.validate(), /SQLite storage is closed/);
});
