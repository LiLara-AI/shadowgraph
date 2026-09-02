import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJsonFileStore, createStorage } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

test('JSON storage assigns revisions and rejects stale expected revisions', async (t) => {
  const dir = await scratchDirectory(t, 'shadowgraph-revision-');
  const store = createJsonFileStore(join(dir, 'data.json'));
  const first = await store.load();
  await store.save({ ...first, expectedRevision: 0, records: [{ id: 'a', kind: 'decision' }] });
  const current = await store.load();
  assert.equal(current.revision, 1);
  await assert.rejects(store.save({ ...current, expectedRevision: 0 }), /revision conflict/);
  await store.save({ ...current, expectedRevision: 1, records: [{ id: 'b', kind: 'decision' }] });
  assert.equal((await store.load()).revision, 2);
});

test('JSON restore refuses SQLite-looking destinations', async (t) => {
  const { restoreFile } = await import('../src/backup.js');
  const dir = await scratchDirectory(t, 'shadowgraph-restore-');
  const source = join(dir, 'backup.json');
  await writeFile(source, JSON.stringify({ schemaVersion: 2, records: [] }));
  await assert.rejects(restoreFile(source, join(dir, 'graph.db'), { storage: 'sqlite' }), /SQLite database/);
});

test('direct JSON restore always validates domain data and preserves the destination on rejection', async (t) => {
  const { restoreFile } = await import('../src/backup.js');
  const dir = await scratchDirectory(t, 'shadowgraph-json-restore-validation-');
  const source = join(dir, 'source.json');
  const destination = join(dir, 'live.json');
  const oldPayload = { schemaVersion: 3, records: [{ id: 'OLD', kind: 'decision', project: 'default', status: 'active', title: 'OLD', chosen: 'OLD' }], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [], journal: [], journalSeq: 0, journalEpoch: null };
  await writeFile(destination, `${JSON.stringify(oldPayload)}\n`);
  const before = await readFile(destination, 'utf8');

  const rejected = [
    { label: 'malformed', payload: { ...oldPayload, records: [{ id: 'bad', kind: 'unknown' }] }, pattern: /records\[0\] is malformed/ },
    { label: 'unsupported', payload: { ...oldPayload, schemaVersion: 999 }, pattern: /Unsupported data schemaVersion 999/ }
  ];
  for (const item of rejected) {
    await writeFile(source, JSON.stringify(item.payload));
    await assert.rejects(restoreFile(source, destination), item.pattern, item.label);
    assert.equal(await readFile(destination, 'utf8'), before, `${item.label} source must not replace the old JSON store`);
  }
});

test('JSON and SQLite stores expose the same close interface', async (t) => {
  const dir = await scratchDirectory(t, 'shadowgraph-store-interface-');
  const json = createJsonFileStore(join(dir, 'nested', 'data.json'));
  assert.equal(typeof json.close, 'function');
  json.close();
  try {
    const sqlite = await createStorage({ type: 'sqlite', file: join(dir, 'nested-sqlite', 'data.db') });
    assert.equal(typeof sqlite.close, 'function');
    sqlite.close();
  } catch (error) {
    if (/requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
});
