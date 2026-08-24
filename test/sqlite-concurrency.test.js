import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createSqliteStore } from '../src/sqlite-storage.js';

function worker(file, id) {
  return new Promise((resolve, reject) => {
    const code = `import { createSqliteStore } from ${JSON.stringify(new URL('../src/sqlite-storage.js', import.meta.url).href)}; const s=await createSqliteStore(process.argv[1]); const p=await s.load(); try { await s.save({...p, expectedRevision: 1, records:[...p.records,{id:process.argv[2],kind:'decision'}]}); process.stdout.write('saved'); } catch(e) { process.stdout.write(e.name); } finally { s.close(); }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, file, id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject); child.on('close', (status) => status === 0 ? resolve(output) : reject(new Error(`worker exited ${status}`)));
  });
}

test('SQLite concurrent processes preserve a valid relational database and reject stale writers', async (t) => {
  let store;
  try {
    const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-sqlite-concurrency-'));
    const file = join(dir, 'graph.db'); store = await createSqliteStore(file);
    await store.save({ schemaVersion: 2, records: [], facts: [], relations: [], events: [] }); store.close(); store = null;
    const results = await Promise.all([worker(file, 'p1'), worker(file, 'p2')]);
    assert.equal(results.filter((value) => value === 'saved').length, 1);
    assert.equal(results.filter((value) => value.includes('RevisionConflict')).length, 1);
    store = await createSqliteStore(file); const loaded = await store.load(); assert.equal(loaded.revision, 2); assert.equal(loaded.records.length, 1);
  } catch (error) { if (/requires Node/.test(error.message)) return t.skip(error.message); throw error; }
  finally { store?.close(); }
});
