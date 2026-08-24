import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonFileStore } from '../src/storage.js';

test('JSON storage assigns revisions and rejects stale expected revisions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-revision-'));
  const store = createJsonFileStore(join(dir, 'data.json'));
  const first = await store.load();
  await store.save({ ...first, expectedRevision: 0, records: [{ id: 'a', kind: 'decision' }] });
  const current = await store.load();
  assert.equal(current.revision, 1);
  await assert.rejects(store.save({ ...current, expectedRevision: 0 }), /revision conflict/);
  await store.save({ ...current, expectedRevision: 1, records: [{ id: 'b', kind: 'decision' }] });
  assert.equal((await store.load()).revision, 2);
});

test('JSON restore refuses SQLite-looking destinations', async () => {
  const { restoreFile } = await import('../src/backup.js');
  const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-restore-'));
  const source = join(dir, 'backup.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(source, JSON.stringify({ schemaVersion: 2, records: [] }));
  await assert.rejects(restoreFile(source, join(dir, 'graph.db'), { storage: 'sqlite' }), /SQLite database/);
});
