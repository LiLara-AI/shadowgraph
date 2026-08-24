import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonFileStore } from '../src/storage.js';
import { createShadowGraph } from '../src/shadowgraph.js';

test('facts are superseded per project, not globally', () => {
  const graph = createShadowGraph();
  graph.addFact({ project: 'a', key: 'mode', value: 'cloud' });
  graph.addFact({ project: 'b', key: 'mode', value: 'local' });
  graph.addFact({ project: 'a', key: 'mode', value: 'local' });
  assert.equal(graph.context({ project: 'a' }).staleAssumptions.length, 1);
  assert.equal(graph.context({ project: 'b' }).staleAssumptions.length, 0);
});

test('fact scope keys cannot collide across project and key delimiters', () => {
  const graph = createShadowGraph();
  graph.addFact({ project: 'a', key: 'b:c', value: 1 });
  graph.addFact({ project: 'a:b', key: 'c', value: 2 });
  graph.addFact({ project: 'a', key: 'b:c', value: 3 });
  assert.equal(graph.context({ project: 'a:b' }).staleAssumptions.length, 0);
  assert.equal(graph.context({ project: 'a' }).staleAssumptions.length, 1);
});

test('malformed JSON storage fails safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-bad-'));
  const store = createJsonFileStore(join(dir, 'data.json'));
  await writeFile(join(dir, 'data.json'), '{broken');
  await assert.rejects(store.load(), /storage is invalid or unreadable/);
});
