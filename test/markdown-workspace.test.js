import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { parseMemoryMarkdown, syncMarkdownWorkspace } from '../src/markdown-workspace.js';

test('Markdown push and pull round-trip scoped Unicode memory through validated graph operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T12:00:00.000Z' });
  const original = graph.remember({
    project: 'travel',
    scope: { userId: 'alice' },
    memoryType: 'preference',
    key: 'lodging',
    text: 'تفضّل الفنادق الهادئة 🏨',
    tags: ['travel', 'هدوء'],
    metadata: { priority: 2, private: false },
    validFrom: '2026-08-01T00:00:00.000Z'
  }).memory;

  const pushed = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  assert.equal(pushed.written, 1);
  assert.equal(pushed.conflicts.length, 0);
  assert.equal(pushed.files.length, 1);
  const path = pushed.files[0].path;
  const markdown = await readFile(path, 'utf8');
  const parsed = parseMemoryMarkdown(markdown);
  assert.equal(parsed.id, original.id);
  assert.equal(parsed.project, 'travel');
  assert.deepEqual(parsed.scope, { userId: 'alice', agentId: null, runId: null });
  assert.deepEqual(parsed.tags, ['travel', 'هدوء']);
  assert.deepEqual(parsed.metadata, { priority: 2, private: false });
  assert.equal(parsed.text, 'تفضّل الفنادق الهادئة 🏨');

  const edited = markdown.replace('تفضّل الفنادق الهادئة 🏨', 'تفضّل الفنادق الصغيرة والهادئة 🏨');
  await writeFile(path, edited, 'utf8');
  const pulled = await syncMarkdownWorkspace({ graph, directory, mode: 'pull' });
  assert.equal(pulled.imported, 1);
  assert.equal(pulled.conflicts.length, 0);
  assert.equal(pulled.results[0].operation, 'UPDATE');
  assert.equal(pulled.results[0].memory.client, 'markdown-sync');
  assert.equal(pulled.results[0].memory.sourceClass, 'tool_observed');

  const history = graph.memoryHistory({
    project: 'travel', scope: { userId: 'alice' }, memoryType: 'preference', key: 'lodging'
  });
  assert.equal(history.items.length, 2);
  assert.equal(history.items[0].text, 'تفضّل الفنادق الهادئة 🏨');
  assert.equal(history.items[1].text, 'تفضّل الفنادق الصغيرة والهادئة 🏨');
});

test('Markdown sync reports a two-sided conflict and changes neither side', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-conflict-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T13:00:00.000Z' });
  graph.remember({
    project: 'app', scope: { userId: 'alice' }, memoryType: 'preference', key: 'theme', text: 'Dark mode'
  });
  const first = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  const path = first.files[0].path;
  const originalFile = await readFile(path, 'utf8');

  graph.remember({
    project: 'app', scope: { userId: 'alice' }, memoryType: 'preference', key: 'theme', text: 'System theme'
  });
  await writeFile(path, originalFile.replace('Dark mode', 'Light mode'), 'utf8');
  const graphBefore = graph.exportData();
  const fileBefore = await readFile(path, 'utf8');

  const conflict = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  assert.equal(conflict.written, 0);
  assert.deepEqual(conflict.conflicts.map((item) => item.reason), ['both_file_and_memory_changed']);
  assert.deepEqual(graph.exportData(), graphBefore);
  assert.equal(await readFile(path, 'utf8'), fileBefore);
});

test('Markdown sync bounds user-controlled path segments while retaining stable identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-long-key-'));
  const graph = createShadowGraph();
  graph.remember({
    project: 'project/'.repeat(30), memoryType: 'note', key: 'x'.repeat(500), text: 'Long identity'
  });
  const pushed = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  assert.equal(pushed.written, 1);
  assert.equal(basename(pushed.files[0].path).length <= 120, true);
  assert.match(await readFile(pushed.files[0].path, 'utf8'), /Long identity/);
});

test('Markdown pull refuses identity edits instead of duplicating the canonical memory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-identity-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T14:00:00.000Z' });
  graph.remember({ project: 'app', scope: { userId: 'alice' }, memoryType: 'preference', key: 'theme', text: 'Dark' });
  const pushed = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  const path = pushed.files[0].path;
  const markdown = await readFile(path, 'utf8');
  await writeFile(path, markdown.replace('key: "theme"', 'key: "other-theme"'), 'utf8');
  const before = graph.exportData();

  const pulled = await syncMarkdownWorkspace({ graph, directory, mode: 'pull' });
  assert.equal(pulled.imported, 0);
  assert.deepEqual(pulled.conflicts.map((item) => item.reason), ['identity_changed']);
  assert.deepEqual(graph.exportData(), before);
});

test('Markdown pull refuses shadowgraph_id edits as immutable identity changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-id-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T14:00:00.000Z' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'identity', text: 'Original' });
  const pushed = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  const path = pushed.files[0].path;
  const markdown = await readFile(path, 'utf8');
  await writeFile(path, markdown.replace(/shadowgraph_id: "[^"]+"/, 'shadowgraph_id: "forged-id"'), 'utf8');
  const before = graph.exportData();

  const pulled = await syncMarkdownWorkspace({ graph, directory, mode: 'pull' });
  assert.equal(pulled.imported, 0);
  assert.deepEqual(pulled.conflicts.map((item) => item.reason), ['identity_changed']);
  assert.deepEqual(graph.exportData(), before);
});

test('Markdown pull refuses status edits instead of marking divergent state synchronized', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-status-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T14:00:00.000Z' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'status', text: 'Original' });
  const pushed = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  const path = pushed.files[0].path;
  const markdown = await readFile(path, 'utf8');
  await writeFile(path, markdown.replace('status: "active"', 'status: "invalidated"'), 'utf8');
  const before = graph.exportData();

  const pulled = await syncMarkdownWorkspace({ graph, directory, mode: 'pull' });
  assert.equal(pulled.imported, 0);
  assert.deepEqual(pulled.conflicts.map((item) => item.reason), ['unsupported_status_edit']);
  assert.deepEqual(graph.exportData(), before);
});

test('Markdown pull cannot resurrect a purged canonical memory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-purge-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T15:00:00.000Z' });
  graph.remember({ project: 'private', memoryType: 'profile', key: 'email', text: 'old@example.test' });
  const pushed = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  const path = pushed.files[0].path;
  const markdown = await readFile(path, 'utf8');
  graph.purgeProject('private');
  await writeFile(path, markdown.replace('old@example.test', 'resurrect@example.test'), 'utf8');

  const pulled = await syncMarkdownWorkspace({ graph, directory, mode: 'pull' });
  assert.equal(pulled.imported, 0);
  assert.deepEqual(pulled.conflicts.map((item) => item.reason), ['canonical_memory_missing']);
  assert.equal(graph.exportData().records.some((record) => record.project === 'private'), false);
});

test('Markdown pull validates every file before committing any graph mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-batch-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T15:00:00.000Z' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'first', text: 'First' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'second', text: 'Second' });
  const pushed = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  const firstPath = pushed.files.find((file) => file.path.includes('first-')).path;
  const secondPath = pushed.files.find((file) => file.path.includes('second-')).path;
  await writeFile(firstPath, (await readFile(firstPath, 'utf8')).replace('\nFirst\n', '\nFirst updated\n'), 'utf8');
  await writeFile(secondPath, (await readFile(secondPath, 'utf8')).replace('valid_to: null', 'valid_to: "2026-01-01T00:00:00.000Z"'), 'utf8');
  const before = graph.exportData();

  await assert.rejects(() => syncMarkdownWorkspace({ graph, directory, mode: 'pull' }), /Memory validTo must be later than validFrom/);
  assert.deepEqual(graph.exportData(), before);
});

test('Markdown parse conflicts roll back otherwise valid edits in the same pull batch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-parse-conflict-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T15:00:00.000Z' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'a-first', text: 'First' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'z-last', text: 'Last' });
  const pushed = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  const firstPath = pushed.files.find((file) => file.path.includes('a-first-')).path;
  const lastPath = pushed.files.find((file) => file.path.includes('z-last-')).path;
  await writeFile(firstPath, (await readFile(firstPath, 'utf8')).replace('\nFirst\n', '\nFirst updated\n'), 'utf8');
  await writeFile(lastPath, (await readFile(lastPath, 'utf8')).replace(/^---/, 'broken'), 'utf8');
  const before = graph.exportData();

  const result = await syncMarkdownWorkspace({ graph, directory, mode: 'pull' });
  assert.equal(result.imported, 0);
  assert.deepEqual(result.conflicts.map((item) => item.reason), ['invalid_markdown']);
  assert.equal(result.rolledBack, true);
  assert.deepEqual(graph.exportData(), before);
});

test('Markdown pull advances sync state only after canonical persistence succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-persist-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T15:00:00.000Z' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'persist', text: 'Before' });
  const pushed = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  const path = pushed.files[0].path;
  await writeFile(path, (await readFile(path, 'utf8')).replace('\nBefore\n', '\nAfter\n'), 'utf8');
  const graphBefore = graph.exportData();
  const statePath = join(directory, '.shadowgraph-sync.json');
  const stateBefore = await readFile(statePath, 'utf8');

  await assert.rejects(() => syncMarkdownWorkspace({
    graph, directory, mode: 'pull',
    persist: async () => { throw new Error('canonical persistence failed'); },
    loadPersisted: async () => structuredClone(graphBefore)
  }), /canonical persistence failed/);
  assert.deepEqual(graph.exportData(), graphBefore);
  assert.equal(await readFile(statePath, 'utf8'), stateBefore);
});

test('Markdown pull reloads durable state when persistence commits and then throws', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-post-commit-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T15:00:00.000Z' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'post-commit', text: 'Before' });
  const pushed = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  const path = pushed.files[0].path;
  await writeFile(path, (await readFile(path, 'utf8')).replace('\nBefore\n', '\nAfter\n'), 'utf8');
  let durable = graph.exportData();

  await assert.rejects(() => syncMarkdownWorkspace({
    graph, directory, mode: 'pull',
    persist: async (data) => {
      durable = structuredClone(data);
      throw new Error('post-commit acknowledgement failed');
    },
    loadPersisted: async () => structuredClone(durable)
  }), /post-commit acknowledgement failed/);

  assert.equal(graph.recall('', { project: 'app' }).items[0].record.text, 'After');
});

test('Markdown pull requires a durable read-back when a persistence callback is supplied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-persist-contract-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T15:00:00.000Z' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'contract', text: 'Before' });
  const pushed = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  await writeFile(pushed.files[0].path, (await readFile(pushed.files[0].path, 'utf8')).replace('\nBefore\n', '\nAfter\n'), 'utf8');
  const before = graph.exportData();
  await assert.rejects(() => syncMarkdownWorkspace({
    graph, directory, mode: 'pull', persist: async () => {}
  }), /persist requires loadPersisted/);
  assert.deepEqual(graph.exportData(), before);
});

test('Markdown pull does not misclassify an unchanged file after a graph-only update', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-graph-only-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T15:00:00.000Z' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'graph-only', text: 'Before' });
  await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'graph-only', text: 'After' });
  const before = graph.exportData();

  const pulled = await syncMarkdownWorkspace({ graph, directory, mode: 'pull' });
  assert.equal(pulled.conflicts.length, 0);
  assert.equal(pulled.unchanged, 1);
  assert.deepEqual(graph.exportData(), before);
});

test('Markdown state-write failure after canonical persistence does not roll live state behind durable state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-markdown-state-fail-'));
  const graph = createShadowGraph({ now: () => '2026-08-27T15:00:00.000Z' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'state-fail', text: 'Before' });
  const pushed = await syncMarkdownWorkspace({ graph, directory, mode: 'push' });
  const path = pushed.files[0].path;
  await writeFile(path, (await readFile(path, 'utf8')).replace('\nBefore\n', '\nAfter\n'), 'utf8');
  const statePath = join(directory, '.shadowgraph-sync.json');
  let durable = null;

  await assert.rejects(() => syncMarkdownWorkspace({
    graph,
    directory,
    mode: 'pull',
    persist: async (data) => {
      durable = { ...structuredClone(data), revision: (data.revision ?? 0) + 1 };
      await unlink(statePath);
      await mkdir(statePath);
    },
    loadPersisted: async () => structuredClone(durable)
  }), /rename|directory|EPERM|EISDIR/i);

  const liveText = graph.recall('', { project: 'app' }).items[0].record.text;
  const durableText = durable.records.find((record) => record.status === 'active').text;
  assert.equal(liveText, 'After');
  assert.equal(durableText, 'After');
  assert.equal(graph.exportData().revision, durable.revision);
});
