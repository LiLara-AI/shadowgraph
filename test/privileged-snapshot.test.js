import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';

// Plan v1.4.4 §11: the privileged snapshot is the persistence primitive --
// complete, unscoped, side-effect free -- and it is internal. Nothing outside
// the repository reaches it by package name, and inside the repository only the
// modules listed here may import it.

const root = fileURLToPath(new URL('..', import.meta.url));
const NOW = '2026-01-01T00:00:00.000Z';
const SNAPSHOT_IMPORTERS = ['src/shadowgraph.js'];

function populated() {
  const graph = createShadowGraph({ now: () => NOW });
  const decision = graph.addDecision({
    project: 'alpha', title: 'Cache', chosen: 'redis', reviewAfter: '2025-01-01T00:00:00.000Z', idempotencyKey: 'retry-1',
    alternatives: [{ label: 'memcached', reopenWhen: ['latency'] }]
  });
  const attempt = graph.addAttempt({ project: 'beta', solution: 'warm-up script', result: 'failed' });
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'k', text: 'a note' });
  graph.addFact({ project: 'alpha', key: 'latency', value: 10 });
  graph.link({ from: decision.id, to: attempt.id, relation: 'tried' });
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
