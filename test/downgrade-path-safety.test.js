import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { downgradeStore } from '../src/schema-conversion.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// P1A correction IR-03 (plan v1.4.4 §19.3.2 step 3): a downgrade never
// overwrites its preservation copy. The live store, the output, the
// preservation copy and the report are four different files, checked before
// anything is written; after a successful downgrade the preservation copy is
// still there and still has the hash the report records.

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function sqliteOrSkip(t) {
  try { await import('node:sqlite'); return true; }
  catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return false; }
}

function currentGraph() {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'Synthetic', chosen: 'keep' });
  graph.addDecision({ originId: 'origin_a', title: 'Captured', chosen: 'x' });
  return graph;
}

const BACKENDS = {
  json: {
    live: 'live.json',
    output: 'old.json',
    create: async (file, graph) => { await writeFile(file, JSON.stringify(privilegedSnapshot(graph), null, 2)); return createJsonFileStore(file); }
  },
  sqlite: {
    live: 'live.db',
    output: 'old.db',
    create: async (file, graph) => { const store = await createSqliteStore(file); graph.setRevision(await store.save(privilegedSnapshot(graph))); return store; }
  }
};

async function setup(t, backend, live = BACKENDS[backend].live) {
  const directory = await scratchDirectory(t, `shadowgraph-ir03-${backend}-`);
  const file = join(directory, live);
  const graph = currentGraph();
  const store = await BACKENDS[backend].create(file, graph);
  t.after(() => store.close?.());
  return { directory, file, graph, store, output: join(directory, BACKENDS[backend].output) };
}

// Every name in the directory with its hash: "nothing written" means exactly this is unchanged.
async function directoryState(directory) {
  const state = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isFile()) state[entry.name] = sha256(await readFile(join(directory, entry.name)));
  }
  return state;
}

for (const backend of Object.keys(BACKENDS)) {
  test(`a preservation copy at the report path is refused before anything is written (${backend})`, async (t) => {
    if (backend === 'sqlite' && !await sqliteOrSkip(t)) return;
    const { directory, file, graph, store, output } = await setup(t, backend);
    const before = await directoryState(directory);
    const preservationCopy = `${output}.report.json`;
    await assert.rejects(() => downgradeStore({ graph, store, file, storageType: backend, output, preservationCopy, now }), /distinct|same file/);
    assert.deepEqual(await directoryState(directory), before, 'live store unchanged; no output, no report, no preservation copy');
  });

  test(`the same file reached through a linked directory is still the same file (${backend})`, async (t) => {
    if (backend === 'sqlite' && !await sqliteOrSkip(t)) return;
    const { directory, file, graph, store, output } = await setup(t, backend);
    const alias = join(directory, 'alias');
    await symlink(directory, alias, 'junction');
    const before = await directoryState(directory);
    const preservationCopy = join(alias, `${BACKENDS[backend].output}.report.json`);
    await assert.rejects(() => downgradeStore({ graph, store, file, storageType: backend, output, preservationCopy, now }), /distinct|same file/);
    assert.deepEqual(await directoryState(directory), before, 'nothing written through the alias');
  });

  test(`every other overlap of live store, output, preservation copy and report is refused before any write (${backend})`, async (t) => {
    if (backend === 'sqlite' && !await sqliteOrSkip(t)) return;
    const { directory, file, graph, store, output } = await setup(t, backend);
    const collisions = [
      ['output is the live store', { output: file, preservationCopy: join(directory, 'copy-a') }],
      ['preservation copy is the live store', { output, preservationCopy: file }],
      ['preservation copy is the output', { output, preservationCopy: output }],
      ['preservation copy differs from the report only in letter case', { output, preservationCopy: `${output}.REPORT.json`, windowsOnly: true }]
    ];
    if (backend === 'sqlite') {
      collisions.push(['preservation copy is the output database\'s write-ahead log', { output, preservationCopy: `${output}-wal` }]);
      collisions.push(['preservation copy is the live database\'s rollback journal', { output, preservationCopy: `${file}-journal` }]);
    }
    for (const [label, { windowsOnly, ...paths }] of collisions) {
      if (windowsOnly && process.platform !== 'win32') continue;
      const before = await directoryState(directory);
      await assert.rejects(() => downgradeStore({ graph, store, file, storageType: backend, now, ...paths }), label);
      assert.deepEqual(await directoryState(directory), before, `${label}: nothing written`);
    }
    // The report of an output named after the live store would be the live store.
    const named = await setup(t, backend, `old${backend === 'json' ? '.json' : '.db'}.report.json`);
    const before = await directoryState(named.directory);
    await assert.rejects(() => downgradeStore({ graph: named.graph, store: named.store, file: named.file, storageType: backend, output: named.output, preservationCopy: join(named.directory, 'copy'), now }), 'report is the live store');
    assert.deepEqual(await directoryState(named.directory), before, 'report is the live store: nothing written');
  });

  test(`a successful downgrade keeps a distinct preservation copy whose hash the report records (${backend})`, async (t) => {
    if (backend === 'sqlite' && !await sqliteOrSkip(t)) return;
    const { directory, file, graph, store, output } = await setup(t, backend);
    const live = sha256(await readFile(file));
    const preservationCopy = join(directory, `preserved-${BACKENDS[backend].live}`);
    const result = await downgradeStore({ graph, store, file, storageType: backend, output, preservationCopy, now });
    assert.equal(result.status, 'complete');
    assert.notEqual(result.report, preservationCopy);
    const report = JSON.parse(await readFile(result.report, 'utf8'));
    assert.equal(report.status, 'complete');
    assert.equal(report.preservationCopy.path, preservationCopy);
    assert.equal(report.preservationCopy.verified, true);
    assert.equal(sha256(await readFile(preservationCopy)), report.preservationCopy.sha256, 'the copy the report names is the copy that was verified');
    assert.equal(report.outputSha256, sha256(await readFile(output)));
    assert.equal(sha256(await readFile(file)), live, 'the current-format store is unchanged');
  });
}

test('a downgrade that fails after the preservation copy leaves the copy intact and no "complete" report', async (t) => {
  const { directory, file, graph, store } = await setup(t, 'json');
  const live = sha256(await readFile(file));
  const preservationCopy = join(directory, 'preserved.json');
  const output = join(directory, 'missing-directory', 'old.json');
  await assert.rejects(() => downgradeStore({ graph, store, file, output, preservationCopy, now }));
  const copy = JSON.parse(await readFile(preservationCopy, 'utf8'));
  assert.equal(copy.schemaVersion, 6, 'the preservation copy is a complete current-format store');
  assert.equal(sha256(await readFile(file)), live);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.report.json')), [], 'no report claims a finished conversion');
});
