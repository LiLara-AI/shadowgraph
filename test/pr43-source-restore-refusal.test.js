import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { ledgerPath, registryFile } from '../src/internal/deletion-knowledge.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
const now = () => '2026-10-04T00:00:00.000Z', sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const bytes = paths => Promise.all(paths.map(path => readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; })));
for (const type of ['json', 'sqlite']) for (const mode of ['logical', 'hard']) {
  test(`${type} ${mode} mixed-source restore refuses before primitive, generation or knowledge writes`, type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
    const root = await scratchDirectory(t, 'pr43-source-refusal-'), env = { SHADOWGRAPH_HOME: join(root, 'home') };
    const file = join(root, 'source'), destination = join(root, 'destination'), backup = join(root, 'backup');
    const graph = createShadowGraph({ now });
    const a = graph.addDecision({ project: 'a', title: 'Source A', chosen: 'A' });
    const b = graph.addDecision({ project: 'b', title: 'Source B', chosen: 'B' });
    const memory = graph.remember({ project: 'keep', memoryType: 'note', key: 'mixed', text: 'Accepted experience' }).memory;
    const payload = privilegedSnapshot(graph);
    const decorate = value => {
      if (!value || typeof value !== 'object') return;
      if (value.id === memory.id && value.kind === 'memory') value.causalClaim = {
        state: 'recorded', class: 'ambiguous', verifierVersion: 'fixture', readings: ['Mixed source reading'],
        evidence: [{ sourceRef: a.id, text: 'A evidence' }, { sourceRef: b.id, text: 'B evidence' }]
      };
      else for (const child of Object.values(value)) decorate(child);
    };
    decorate(payload);
    const store = await createStorage({ type, file, env });
    try { await store.save(payload); await backupFile(file, backup, { store, env }); } finally { store.close(); }
    const target = await createStorage({ type, file: destination, env }); t.after(() => target.close());
    await target.save(privilegedSnapshot(createShadowGraph({ now })));
    const tombstone = { kind: 'project', purgedProject: 'a', mode, at: now(), seq: 1,
      tokens: [payload.records.find(x => x.id === a.id).erasureToken], moveIn: 'none' };
    await writeFile(ledgerPath(destination), JSON.stringify({ version: 1, tombstones: [tombstone] }));
    const before = await target.load(); // initialize SQLite's normal WAL mode before comparing
    const paths = [destination, ledgerPath(destination), registryFile(env), backup, ledgerPath(backup)];
    const original = await bytes(paths);
    await assert.rejects(type === 'json' ? restoreFile(backup, destination, { env, now: now() }) : target.restore(backup, { now: now() }), /mixed.source/i);
    assert.deepEqual(await bytes(paths), original);
    assert.deepEqual(await target.load(), before);
  });
}
