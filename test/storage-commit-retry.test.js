// FND-P5-01 (PR-32): a rename that commits a JSON save, briefly blocked by a reader on Windows, is tried again; a
// rename that stays blocked fails the save as before and leaves no temporary file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const blocked = (code) => Object.assign(new Error('blocked'), { code });

test('a briefly blocked commit is retried, and one that stays blocked fails leaving no temporary file', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-commit-');
  const graph = createShadowGraph();
  graph.addDecision({ project: 'p', title: 'queue broker', chosen: 'kafka' });
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    let failures = 4;
    const store = createJsonFileStore(join(directory, `${code}.json`), { rename: async (from, to) => { if (failures-- > 0) throw blocked(code); return rename(from, to); } });
    assert.equal(await store.save(privilegedSnapshot(graph)), 1, code);
  }
  await assert.rejects(createJsonFileStore(join(directory, 'stuck.json'), { rename: async () => { throw blocked('EPERM'); } }).save(privilegedSnapshot(graph)), { code: 'EPERM' });
  let calls = 0;
  await assert.rejects(createJsonFileStore(join(directory, 'other.json'), { rename: async () => { calls += 1; throw blocked('ENOSPC'); } }).save(privilegedSnapshot(graph)), { code: 'ENOSPC' });
  assert.equal(calls, 1, 'any other error is not retried');
  assert.deepEqual((await readdir(directory)).sort(), ['EACCES.json', 'EBUSY.json', 'EPERM.json']);
});
