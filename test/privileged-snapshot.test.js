import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createShadowGraphServer } from '../src/server.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { historicalRelation } from '../tools/historical-relation.js';

// Plan v1.4.4 §11: the privileged snapshot is the persistence primitive --
// complete, unscoped, side-effect free -- and it is internal. Nothing outside
// the repository reaches it by package name, and inside the repository only the
// modules listed here may import it.

const root = fileURLToPath(new URL('..', import.meta.url));
const NOW = '2026-01-01T00:00:00.000Z';
// The verified persistence, staging, rollback, restore-validation and
// measurement consumers (P1 reconciliation F-02). The public reads -- the
// `list` verb, GET /records and markdown push -- are deliberately absent.
const SNAPSHOT_IMPORTERS = [
  'src/shadowgraph.js', 'src/cli.js', 'src/server.js', 'src/mcp.js', 'src/markdown-workspace.js', 'src/restore-validation.js',
  'src/schema-conversion.js',
  'scripts/bench-journal.mjs', 'scripts/context-size.mjs'
];

function populated() {
  const graph = createShadowGraph({ now: () => NOW });
  const decision = graph.addDecision({
    project: 'alpha', title: 'Cache', chosen: 'redis', reviewAfter: '2025-01-01T00:00:00.000Z', idempotencyKey: 'retry-1',
    alternatives: [{ label: 'memcached', reopenWhen: ['latency'] }]
  });
  const attempt = graph.addAttempt({ project: 'beta', solution: 'warm-up script', result: 'failed' });
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'k', text: 'a note' });
  graph.addFact({ project: 'alpha', key: 'latency', value: 10 });
  // A relation across projects, kept as history (link() refuses one since
  // PR-09): the snapshot carries it like everything else.
  graph.importData(historicalRelation({ id: 'relation-alpha-beta', from: decision.id, to: attempt.id, relation: 'tried', project: 'alpha', seq: privilegedSnapshot(graph).journalSeq + 1, at: NOW }));
  graph.review({ project: 'alpha' });
  return graph;
}

test('the privileged snapshot is byte-equal to the exportData() output of this build', () => {
  const graph = populated();
  const snapshot = privilegedSnapshot(graph);
  for (const collection of ['records', 'facts', 'relations', 'reviewSignals', 'idempotency', 'events', 'journal']) {
    assert.ok(snapshot[collection].length > 0, `fixture must populate ${collection}`);
  }
  assert.equal(JSON.stringify(snapshot), JSON.stringify(graph.exportData()));
  const empty = createShadowGraph({ now: () => NOW });
  assert.equal(JSON.stringify(privilegedSnapshot(empty)), JSON.stringify(empty.exportData()));
});

test('the privileged snapshot is complete, unscoped, detached and side-effect free', () => {
  const graph = populated();
  const snapshot = privilegedSnapshot(graph);
  assert.deepEqual(Object.keys(snapshot), ['schemaVersion', 'revision', 'records', 'facts', 'relations', 'reviewSignals', 'idempotency', 'events', 'journal', 'journalSeq', 'journalEpoch']);
  assert.deepEqual([...new Set(snapshot.records.map((record) => record.project))].sort(), ['alpha', 'beta']);
  const before = JSON.stringify(privilegedSnapshot(graph));
  snapshot.records.length = 0;
  snapshot.journal.push({ forged: true });
  snapshot.revision = 99;
  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before);
  assert.equal(graph.stats().journal, JSON.parse(before).journal.length);
});

test('only a graph built by createShadowGraph has a privileged snapshot', () => {
  for (const candidate of [null, undefined, {}, { exportData: () => ({ records: [] }) }, 'graph']) {
    assert.throws(() => privilegedSnapshot(candidate), TypeError);
  }
});

test('the graph object carries no key, symbol or method exposing the snapshot', () => {
  const graph = populated();
  assert.deepEqual(Object.getOwnPropertySymbols(graph), []);
  assert.deepEqual(Object.keys(graph).filter((key) => /snapshot|privileged/i.test(key)), []);
});

test('the privileged snapshot is not reachable through any package entry point', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const target of Object.values(manifest.exports)) assert.doesNotMatch(target, /internal/);
  await assert.rejects(import(`${manifest.name}/src/internal/snapshot.js`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  for (const entry of Object.keys(manifest.exports)) {
    const specifier = entry === '.' ? manifest.name : `${manifest.name}/${entry.slice(2)}`;
    const namespace = await import(specifier);
    assert.deepEqual(Object.keys(namespace).filter((name) => /snapshot|privileged/i.test(name)), [], specifier);
  }
});

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (/\.(?:m?js|cjs|html)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test('only allowlisted repository modules import the privileged snapshot', async () => {
  const importers = [];
  for (const directory of ['src', 'scripts', 'tools', 'dashboard', 'integrations', 'benchmark']) {
    for (const path of await sourceFiles(directory)) {
      if (path.split(sep).join('/') === 'src/internal/snapshot.js') continue;
      if (/internal\/snapshot\.js/.test(await readFile(join(root, path), 'utf8'))) importers.push(relative(root, join(root, path)).split(sep).join('/'));
    }
  }
  assert.deepEqual(importers.sort(), [...SNAPSHOT_IMPORTERS].sort());
});

const sourceLines = async (path) => (await readFile(join(root, path), 'utf8')).split(/\r?\n/);

test('the public reads stay on the public export', async () => {
  const cliList = (await sourceLines('src/cli.js')).filter((line) => line.includes("command === 'list'"));
  assert.deepEqual(cliList.map((line) => line.trim()), ["else if (command === 'list') result = graph.exportData();"]);
  const records = (await sourceLines('src/server.js')).filter((line) => line.includes("path === '/records'"));
  assert.deepEqual(records.map((line) => line.trim()), ["if (method === 'GET' && path === '/records') return graph.exportData();"]);
  const markdown = (await readFile(join(root, 'src/markdown-workspace.js'), 'utf8'));
  const push = markdown.slice(markdown.indexOf('async function push('), markdown.indexOf('async function pull('));
  assert.match(push, /graph\.exportData\(\)\.records/);
  assert.doesNotMatch(push, /privilegedSnapshot/);
});

test('no transport dispatch arm hands the privileged snapshot to a caller', async () => {
  for (const line of (await sourceLines('src/server.js')).filter((text) => /path === '/.test(text))) {
    assert.doesNotMatch(line, /privilegedSnapshot/, line.trim());
  }
  for (const line of (await sourceLines('src/mcp.js')).filter((text) => /name === 'shadowgraph_|request\.method === '/.test(text))) {
    assert.doesNotMatch(line, /privilegedSnapshot/, line.trim());
  }
  // A CLI verb may persist the snapshot, never print it.
  for (const line of (await sourceLines('src/cli.js')).filter((text) => /command === '/.test(text))) {
    assert.doesNotMatch(line.replaceAll('store.save(privilegedSnapshot(graph))', ''), /privilegedSnapshot/, line.trim());
  }
});

test('store.save and persistence callbacks never receive the public export', async () => {
  for (const path of await sourceFiles('src')) {
    for (const [index, line] of (await sourceLines(path)).entries()) {
      assert.doesNotMatch(line, /\b(?:save|persist)\([^;]*exportData\(/, `${path}:${index + 1}`);
    }
  }
});

test('HTTP persists the privileged snapshot and serves GET /records from the public export', async (t) => {
  const saved = [];
  let revision = 0;
  const store = {
    async load() { return createShadowGraph().exportData(); },
    async save(data) { saved.push(data); revision += 1; return revision; }
  };
  const app = await createShadowGraphServer({ store });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  // Mark the public export, so any persistence path that used it would be seen.
  const marker = { publicExportMarker: true, records: [] };
  app.graph.exportData = () => marker;

  const written = await fetch(`${base}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'alpha', title: 'Cache', chosen: 'redis' }) });
  assert.equal(written.status, 200);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].publicExportMarker, undefined);
  assert.equal(saved[0].records.length, 1);
  assert.ok(saved[0].journal.length > 0);
  assert.deepEqual(await (await fetch(`${base}/records`)).json(), marker);
});
