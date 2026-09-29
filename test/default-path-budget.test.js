// Plan v1.4.4 PR-17 (§13.1, §13.3; PC-25(b); AC-059 clauses 2-3): the default
// context delivery stays inside its declared write budget. The budget is a
// frozen constant beside the catalog; this file measures against it and never
// adjusts it. Exceeding it fails the phase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { CONTEXT_DELIVERY_BUDGET } from '../src/mcp-tools.js';
import { checkWriteBudget, measureWrites } from '../scripts/context-size.mjs';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createShadowGraphServer } from '../src/server.js';
import { createJsonFileStore } from '../src/storage.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { RUNTIME_MISSES_PER_READ } from '../src/internal/miss-ledger.js';

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

test('repeated and replayed deliveries on the HTTP transport stay within the declared budget', async () => {
  const report = await measureWrites({ deliveries: 3 });
  assert.deepEqual(checkWriteBudget(report), []);

  const own = report.ownScope;
  assert.equal(own.relevant, null, 'a plain delivery carries no relevant block');
  assert.equal(own.deliveries, 4, 'three reads a minute apart and a replay');
  assert.equal(own.saves, 0);
  assert.equal(own.bytesWritten, 0);
  assert.equal(own.revisionDelta, 0);
  assert.equal(own.journalDelta, 0);
  assert.equal(own.storeChanged, false);
  assert.deepEqual(own.changedKeys, []);
  assert.equal(own.replayIdentical, true, 'an identical delivery at the same instant returns the same payload and writes nothing');

  const grant = report.grant;
  assert.equal(grant.deliveries, 4, 'three deliveries a minute apart and one on the next UTC day');
  assert.equal(grant.saves, 4);
  assert.equal(grant.maxSavesPerDelivery, 1);
  assert.equal(grant.revisionDelta, 4);
  assert.equal(grant.journalDelta, 0);
  assert.equal(grant.canonicalWrites, 0, 'canonical values, non-audit events included, are unchanged');
  assert.deepEqual(grant.changedKeys, ['accessAudit', 'revision'], 'only the declared audit and the store revision change');
  assert.deepEqual(grant.accessUsed, { aggregates: 2, count: 4, days: 2, maxPerDay: 1 }, 'one aggregate per grant, surface, outcome and UTC day');
  assert.equal(grant.rewrite, 'whole_store');

  const nullReference = report.nullReference;
  assert.equal(nullReference.maxSavesPerDelivery, 1, 'a null access key takes the fenced path');
  assert.equal(nullReference.canonicalWrites, 0);
  assert.deepEqual(nullReference.changedKeys, ['revision'], 'and commits a revision with no audit');
});

// PR-26: a relevance read -- ranked, delivered as lines -- is the same
// default-path read, inside the same frozen budget.
test('a relevance read stays within the declared budget and writes nothing in its own scope', async () => {
  const report = await measureWrites({ deliveries: 2, request: { query: 'cache region deploy', compact: true } });
  assert.deepEqual(checkWriteBudget(report), []);
  const own = report.ownScope;
  assert.deepEqual(own.relevant, { established: true, tiers: ['T1'] }, 'the measured delivery is a relevance read, delivered as lines');
  assert.deepEqual([own.saves, own.bytesWritten, own.revisionDelta, own.journalDelta, own.storeChanged], [0, 0, 0, 0, false]);
  assert.equal(own.replayIdentical, true, 'the same relevance read at the same instant returns the same bytes');
  assert.equal(report.grant.canonicalWrites, 0);
  assert.deepEqual(report.grant.changedKeys, ['accessAudit', 'revision'], 'a granted relevance read changes only the declared audit');
});

// PR-28: a read the fallback answers records runtime misses. In its own scope
// it still writes nothing -- the misses wait in memory for the next save -- and
// a granted one carries them in the save it already makes, inside the same
// frozen budget. The ledger is declared operational data, not canonical truth.
test('a fallback read records runtime misses inside the same frozen budget', async () => {
  const report = await measureWrites({ deliveries: 2, request: { query: 'zebra crossing', compact: true } });
  assert.deepEqual(checkWriteBudget(report), []);
  const own = report.ownScope;
  assert.deepEqual(own.relevant, { established: false, tiers: ['T2'] }, 'the measured delivery is answered by the fallback');
  assert.deepEqual([own.saves, own.bytesWritten, own.revisionDelta, own.journalDelta, own.storeChanged, own.runtimeMissesAdded], [0, 0, 0, 0, false, 0]);
  assert.equal(own.replayIdentical, true);
  assert.equal(report.grant.canonicalWrites, 0);
  assert.deepEqual(report.grant.changedKeys, ['accessAudit', 'revision', 'runtimeMisses'], 'a granted fallback read changes only the declared audit and the ledger');
  assert.equal(report.grant.runtimeMissesAdded, RUNTIME_MISSES_PER_READ * report.grant.deliveries, 'a bounded number per delivery, each repeat going on to what it has not recorded');
});

// An entry carries the project and origin verbatim, so the writer bounds its
// bytes and records one per read: a long or escaped name or origin, which the
// audit aggregate carries too, still leaves a granted delivery inside the ceiling.
test('a fallback read by a long or escaped project name or origin stays inside the same growth ceiling', async () => {
  const control = String.fromCharCode(1);
  const cases = [
    ['a 300-character project', { project: 'p'.repeat(300) }],
    ['a 300-character Arabic project', { project: 'مشروع'.repeat(60) }],
    ['a long origin', { originId: `origin_${'o'.repeat(700)}` }],
    ['escaped quotes in both labels', { project: '"'.repeat(128), originId: '"'.repeat(128) }],
    ['a recorded entry beside escaped labels', { project: '"'.repeat(128), originId: '"'.repeat(60) }],
    ['escaped labels with an entry at the bound', { project: '"'.repeat(128), originId: '"'.repeat(78) }],
    ['control characters in both labels', { project: control.repeat(128), originId: control.repeat(128) }],
    ['control characters with an entry near the bound', { project: control.repeat(128), originId: control.repeat(60) }]
  ];
  for (const [label, { project, originId }] of cases) {
    const report = await measureWrites({ deliveries: 1, ...(project ? { project } : {}), request: { query: 'zebra crossing', compact: true, ...(originId ? { originId } : {}) } });
    assert.deepEqual(checkWriteBudget(report), [], label);
    assert.equal(report.grant.canonicalWrites, 0, label);
  }
});

test('the budget check fails each category it measures rather than adjusting', async () => {
  const report = await measureWrites({ deliveries: 1 });
  assert.deepEqual(checkWriteBudget(report), []);
  const { ownScope, grant } = CONTEXT_DELIVERY_BUDGET;
  const cases = [];
  for (const [tier, declared] of [['ownScope', ownScope], ['grant', grant], ['nullReference', grant]]) {
    const deliveries = report[tier].deliveries;
    cases.push(
      [tier, 'canonicalWrites', declared.canonicalWrites + 1, `${tier}.canonicalWrites`],
      [tier, 'journalDelta', (declared.journalEntries + 1) * deliveries, `${tier}.journalEntries`],
      [tier, 'revisionDelta', (declared.revisions + 1) * deliveries, `${tier}.revisions`],
      [tier, 'maxSavesPerDelivery', declared.saves + 1, `${tier}.saves`],
      [tier, 'addedMsMax', declared.addedMs + 1, `${tier}.addedMs`]);
  }
  cases.push(['ownScope', 'bytesWritten', ownScope.bytesWritten + 1, 'ownScope.bytesWritten']);
  for (const tier of ['grant', 'nullReference']) {
    cases.push([tier, 'maxGrowthBytes', grant.growthBytes + 1, `${tier}.growthBytes`]);
    cases.push([tier, 'accessUsed.maxPerDay', grant.newAuditAggregatesPerKeyDay + 1, `${tier}.audit aggregates`]);
  }
  assert.equal(cases.length, 20);
  for (const [tier, field, value, label] of cases) {
    const over = structuredClone(report);
    const path = field.split('.');
    path.slice(0, -1).reduce((node, key) => node[key], over[tier])[path.at(-1)] = value;
    const violations = checkWriteBudget(over);
    assert.equal(violations.length, 1, `${tier}.${field}: ${violations.join('; ')}`);
    assert.ok(violations[0].startsWith(label), violations[0]);
  }
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
