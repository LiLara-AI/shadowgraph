// Plan v1.4.4 PR-17 (§13.1, §13.3; PC-25(b); AC-059 clauses 2-3): the default
// context delivery stays inside its declared write budget. The budget is a
// frozen constant beside the catalog; this file measures against it and never
// adjusts it. Exceeding it fails the phase.
// The measuring cases run in their own CI step: performance/default-path-budget.perf.js
// (`npm run test:performance`, PR #12); the rest stay in the suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { CONTEXT_DELIVERY_BUDGET } from '../src/mcp-tools.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createShadowGraphServer } from '../src/server.js';
import { createJsonFileStore } from '../src/storage.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';


const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const runCli = (file, cwd, command, value) => spawnSync(process.execPath, [cliPath, command, JSON.stringify(value)], {
  cwd, encoding: 'utf8', env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' }
});

async function dueStore(t, prefix) {
  const directory = await scratchDirectory(t, prefix);
  const file = join(directory, 'store.json');
  const seed = createShadowGraph();
  seed.addDecision({ project: 'app', title: 'due', chosen: 'A', reviewAfter: '2020-01-01T00:00:00.000Z' });
  await createJsonFileStore(file).save(privilegedSnapshot(seed));
  return { directory, file };
}

// A live, fresh lock owned by this process: a fenced save waits on it and times
// out, and staleness recovery does not reclaim it.
async function holdLock(file) {
  const token = `${process.pid}:${Date.now()}:held-by-test`;
  await writeFile(`${file}.lock`, token);
  return token;
}

test('the declared delivery budget is frozen and states every §13.3 category', () => {
  assert.equal(Object.isFrozen(CONTEXT_DELIVERY_BUDGET), true);
  assert.equal(Object.isFrozen(CONTEXT_DELIVERY_BUDGET.ownScope), true);
  assert.equal(Object.isFrozen(CONTEXT_DELIVERY_BUDGET.grant), true);
  assert.deepEqual(CONTEXT_DELIVERY_BUDGET.ownScope, { canonicalWrites: 0, journalEntries: 0, revisions: 0, saves: 0, bytesWritten: 0, addedMs: 0 });
  assert.deepEqual(CONTEXT_DELIVERY_BUDGET.grant, { canonicalWrites: 0, journalEntries: 0, revisions: 1, saves: 1, rewrite: 'whole_store', newAuditAggregatesPerKeyDay: 1, growthBytes: 4096, addedMs: 250 });
});

test('an own-scope CLI context takes no fence: it completes while the store lock is held', async (t) => {
  const { directory, file } = await dueStore(t, 'budget-cli-');
  const before = await readFile(file);
  const token = await holdLock(file);
  const read = runCli(file, directory, 'context', { project: 'app' });
  assert.equal(read.status, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout).firedConditions.length, 1);
  assert.deepEqual(await readFile(file), before, 'the read saved nothing');
  assert.equal(await readFile(`${file}.lock`, 'utf8'), token, 'the held lock is untouched');
  // Control: the persisting verb needs the fence, so the same held lock stops it.
  const evaluated = runCli(file, directory, 'review-context', { project: 'app' });
  assert.notEqual(evaluated.status, 0);
  assert.match(evaluated.stderr, /fence timed out/);
  assert.deepEqual(await readFile(file), before);
});

test('an own-scope HTTP context takes no fence: it answers while the store lock is held', async (t) => {
  const { directory, file } = await dueStore(t, 'budget-http-');
  const app = await createShadowGraphServer({ file, storage: 'json', cwd: directory, apiToken: '' });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const before = await readFile(file);
  const token = await holdLock(file);
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/context`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'app' })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).firedConditions.length, 1);
  assert.deepEqual(await readFile(file), before, 'the read saved nothing');
  assert.equal(await readFile(`${file}.lock`, 'utf8'), token, 'the held lock is untouched');
});
