import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createShadowGraphServer } from '../src/server.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { RUNTIME_MISSES, RUNTIME_MISS_CAP, RUNTIME_MISS_ENTRY_BYTES, RUNTIME_MISSES_PER_READ, runtimeMissLedgerIssue, withFallbackMisses } from '../src/internal/miss-ledger.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// Plan rev6 PR-28 (VAR-10; G-5 §6.2(a), §9, G5-8): a read the §9 fallback
// answers records what it recovered as runtime misses. The read itself saves
// nothing (PR-17's budget); the process's next save writes them. Bounded,
// scoped, a digest of the query and never its text, and reached by purge.
const NOW = '2026-03-01T00:00:00.000Z';
const now = () => NOW;
const digest = (text) => createHash('sha256').update(text).digest('hex');
const ledgerOf = (graph) => privilegedSnapshot(graph)[RUNTIME_MISSES];

function seeded() {
  const graph = createShadowGraph({ now });
  const queue = graph.addDecision({ project: 'alpha', title: 'Process uploads through a background queue', chosen: 'background-queue' });
  graph.addDecision({ project: 'alpha', title: 'Serve product reads from a regional cache', chosen: 'regional-cache' });
  graph.addDecision({ project: 'alpha', title: 'Publish events through an outbox table', chosen: 'outbox' });
  graph.addDecision({ project: 'beta', title: 'Beta keeps its own queue', chosen: 'kafka' });
  return { graph, queue };
}

test('G5-8: when no signal ranks a record, the fallback delivers the working set and records what it recovered', () => {
  const { graph } = seeded();
  const query = 'zebra crossing plans';
  const read = graph.context({ project: 'alpha', query, compact: true });
  assert.equal(read.relevant.relevance.established, false);
  assert.deepEqual(read.relevant.fallback, { used: true, reason: 'relevance_not_established' });
  const delivered = read.relevant.items.map((item) => item.record.id);
  assert.equal(delivered.length, 3, 'the fallback delivered the working set');

  const ledger = ledgerOf(graph);
  assert.equal(runtimeMissLedgerIssue(ledger), null, 'every entry is one the reader accepts');
  assert.deepEqual(ledger.map((entry) => entry.recordId), delivered.slice(0, RUNTIME_MISSES_PER_READ), 'the first records the fallback delivered');
  for (const { missId, recordId, ...entry } of ledger) {
    assert.match(missId, /^miss_/);
    assert.deepEqual(entry, {
      at: NOW, source: 'runtime', evidence: 'fallback_recovery',
      scope: { project: 'alpha', originId: null, requestState: 'project_selected' },
      queryDigest: digest(query), boundRevision: null, tier: 'T0', stage: 'not_ranked', rank: null,
      signals: read.relevant.relevance.signals, reason: 'relevance_not_established'
    });
  }
  assert.equal(JSON.stringify(privilegedSnapshot(graph)).includes(query), false, 'the query text is never kept');
  const text = JSON.stringify(read);
  assert.equal(text.includes(RUNTIME_MISSES) || text.includes(digest(query)), false, 'the read returns no ledger');
});

test('only a fallback read with a query records: an established, focal, plain or review read does not', () => {
  const { graph, queue } = seeded();
  assert.equal(graph.context({ project: 'alpha', query: 'background queue', compact: true }).relevant.relevance.established, true);
  // A focal read the fallback answers keeps nothing: its only query is an
  // entity id, whose digest would outlive the entity's purge.
  assert.equal(graph.context({ project: 'alpha', focalId: queue.id }).relevant.fallback.used, true);
  graph.context({ project: 'alpha' });
  graph.reviewContext({ project: 'alpha' });
  graph.recall('zebra', { project: 'alpha' });
  graph.search('zebra', { project: 'alpha' });
  assert.equal(Object.hasOwn(privilegedSnapshot(graph), RUNTIME_MISSES), false);
});

test('a bounded number per read; a repeat goes on to what it has not recorded; each record once per query, scope and record', () => {
  const { graph } = seeded();
  const delivered = graph.context({ project: 'alpha', query: 'zebra' }).relevant.items.map((item) => item.record.id);
  assert.equal(ledgerOf(graph).length, RUNTIME_MISSES_PER_READ);
  for (let read = 1; read < Math.ceil(delivered.length / RUNTIME_MISSES_PER_READ); read += 1) graph.context({ project: 'alpha', query: 'zebra' });
  assert.deepEqual(ledgerOf(graph).map((entry) => entry.recordId), delivered, 'repeats record every delivered record, in delivery order');
  graph.context({ project: 'alpha', query: 'zebra' });
  assert.equal(ledgerOf(graph).length, delivered.length, 'and then nothing more');
  graph.context({ project: 'alpha', originId: 'origin_1', query: 'zebra' });
  assert.equal(ledgerOf(graph).length, delivered.length + RUNTIME_MISSES_PER_READ, 'another scope is another miss');
  assert.deepEqual(ledgerOf(graph).at(-1).scope, { project: 'alpha', originId: 'origin_1', requestState: 'project_selected' });
});

test('only what was delivered is recorded, in delivery order', () => {
  const { graph } = seeded();
  const delivered = graph.context({ project: 'alpha', query: 'zebra' }).relevant.items.map((item) => item.record.id);
  const fresh = seeded().graph;
  fresh.context({ project: 'alpha', query: 'zebra', limit: 1 });
  assert.equal(ledgerOf(fresh).length, 1, 'a limit of one delivers, and records, one');
  fresh.context({ project: 'alpha', query: 'zebra', limit: 1 });
  assert.equal(ledgerOf(fresh).length, 1, 'a repeat records nothing it did not deliver');
  assert.deepEqual(ledgerOf(graph).map((entry) => entry.recordId), delivered.slice(0, RUNTIME_MISSES_PER_READ));
});

test('past the cap only the newest three quarters stay', () => {
  const { graph } = seeded();
  for (let index = 0; index < RUNTIME_MISS_CAP / RUNTIME_MISSES_PER_READ; index += 1) graph.context({ project: 'alpha', query: `nomatch${index}x` });
  assert.equal(ledgerOf(graph).length, RUNTIME_MISS_CAP);
  graph.context({ project: 'alpha', query: 'lastnomatch', limit: 1 });
  const ledger = ledgerOf(graph);
  assert.equal(ledger.length, RUNTIME_MISS_CAP * 3 / 4);
  assert.equal(ledger.at(-1).queryDigest, digest('lastnomatch'));
  assert.equal(ledger.some((entry) => entry.queryDigest === digest('nomatch0x')), false, 'the oldest went first');
  assert.equal(runtimeMissLedgerIssue(ledger), null);
});

test('an unresolved read records its origin scope, and the store still loads', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ originId: 'o1', title: 'Unattributed queue', chosen: 'kafka' });
  graph.context({ originId: 'o1', query: 'zebra' });
  assert.deepEqual(ledgerOf(graph).map((entry) => entry.scope), [{ project: null, originId: 'o1', requestState: 'project_unresolved' }]);
  assert.equal(runtimeMissLedgerIssue(ledgerOf(graph)), null);
  createShadowGraph({ now }).importData(privilegedSnapshot(graph));
});

test('nothing is recorded for a line delivered in full, a blank query, or an empty working set', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'short retention', chosen: 'x' });
  graph.addDecision({ project: 'alpha', title: `retention ${'window '.repeat(90)}`, chosen: 'thirty days' });
  assert.equal(graph.context({ project: 'alpha', query: 'retention', compact: true }).relevant.fallback.reason, 'decisive_meaning_omitted');
  for (const query of ['', '   ']) assert.equal(graph.context({ project: 'alpha', query }).relevant.fallback.used, true);
  assert.equal(graph.context({ project: 'empty', query: 'zebra' }).relevant.items.length, 0);
  assert.equal(Object.hasOwn(privilegedSnapshot(graph), RUNTIME_MISSES), false);
});

test('an entry keeps the read time, the exact query and its own copy of the signals', () => {
  const { graph } = seeded();
  const read = graph.context({ project: 'alpha', query: '  Zebra ', asOf: '2026-02-01T00:00:00.000Z' });
  read.relevant.relevance.signals.lexical.matched = 99;
  const [entry] = ledgerOf(graph);
  assert.equal(entry.at, NOW);
  assert.equal(entry.queryDigest, digest('  Zebra '));
  assert.equal(entry.signals.lexical.matched, 0);
});

test('an entry over the byte bound, which only a very long name or origin makes, is not recorded', () => {
  const graph = createShadowGraph({ now });
  const long = 'p'.repeat(RUNTIME_MISS_ENTRY_BYTES);
  graph.addDecision({ project: long, title: 'A queue', chosen: 'x' });
  graph.addDecision({ project: 'alpha', title: 'A cache', chosen: 'y' });
  graph.context({ project: long, query: 'zebra' });
  graph.context({ project: 'alpha', originId: `origin_${'o'.repeat(RUNTIME_MISS_ENTRY_BYTES)}`, query: 'zebra' });
  assert.equal(Object.hasOwn(privilegedSnapshot(graph), RUNTIME_MISSES), false);
  const medium = 'm'.repeat(300);
  graph.addDecision({ project: medium, title: 'A table', chosen: 'z' });
  graph.context({ project: medium, query: 'zebra' });
  assert.equal(ledgerOf(graph).length, 1);
  assert.ok(ledgerOf(graph).every((entry) => Buffer.byteLength(JSON.stringify(entry)) <= RUNTIME_MISS_ENTRY_BYTES));
});

test('a read whose query names a stored entity records none: exact, padded, re-cased or among other words', () => {
  const { graph, queue } = seeded();
  const gamma = graph.addDecision({ project: 'gamma', title: 'Gamma cache', chosen: 'redis', alternatives: [{ label: 'memcached', reasonRejected: 'no persistence' }] });
  const fact = graph.addFact({ project: 'gamma', key: 'region', value: 'eu' });
  const attempt = graph.addAttempt({ project: 'alpha', solution: 'retry the upload', result: 'failed' });
  const relation = graph.link({ project: 'alpha', from: queue.id, to: attempt.id, relation: 'tried' });
  graph.importData({ records: [
    { id: 'ADR/0001', kind: 'decision', project: 'gamma', title: 'Legacy record', chosen: 'x' },
    { id: 'my decision', kind: 'decision', project: 'gamma', title: 'Legacy record', chosen: 'y' },
    { id: 'D-Zeta', kind: 'decision', project: 'gamma', title: 'Legacy record', chosen: 'z' }
  ] });
  const queries = [
    gamma.id, ` ${gamma.id}\n`, gamma.id.toUpperCase(), `why did ${gamma.id} fail`, `re ${gamma.id}: why`, `id:${gamma.id}`, `urn:sg:${gamma.id}`,
    `${gamma.id}-related`, gamma.alternatives[0].id, `alt:${gamma.alternatives[0].id}`, fact.id, relation.id,
    'see adr/0001.', ' my decision ', 'd-zeta'
  ];
  for (const query of queries) assert.equal(graph.context({ project: 'alpha', query }).relevant.fallback.used, true, query);
  assert.equal(Object.hasOwn(privilegedSnapshot(graph), RUNTIME_MISSES), false, 'no digest of an entity id outlives it');
  // An ordinary query still records, so the check is not simply refusing everything.
  graph.context({ project: 'alpha', query: 'zebra crossing' });
  assert.equal(ledgerOf(graph).length, RUNTIME_MISSES_PER_READ);
});

test('the byte bound is exact: an entry of 1 KB is recorded, one byte more is not', () => {
  const signals = { lexical: { available: true, matched: 0 }, semantic: { available: false, matched: 0 }, graph: { available: false, matched: 0 }, temporal: { available: false, matched: 0 } };
  const recorded = (project) => withFallbackMisses([], { query: 'zebra', scope: { project, originId: null, state: 'project_selected' }, signals, recordIds: ['decision_x'], at: NOW });
  const size = Buffer.byteLength(JSON.stringify(recorded('p')[0]));
  const fits = 'p'.repeat(1 + RUNTIME_MISS_ENTRY_BYTES - size);
  assert.equal(Buffer.byteLength(JSON.stringify(recorded(fits)[0])), RUNTIME_MISS_ENTRY_BYTES);
  assert.deepEqual(recorded(`${fits}p`), []);
});

test('a purge of the project takes what its reads recorded with it', () => {
  for (const mode of ['logical', 'hard']) {
    const { graph } = seeded();
    graph.context({ project: 'alpha', query: 'zebra' });
    graph.context({ project: 'beta', query: 'zebra' });
    assert.equal(graph.purgeProject('alpha', { mode }).runtimeMisses, RUNTIME_MISSES_PER_READ, mode);
    assert.deepEqual(ledgerOf(graph).map((entry) => entry.scope.project), ['beta'], mode);
  }
});

test('an own-scope read saves nothing; the next save writes what it recorded', async (t) => {
  const { graph } = seeded();
  const directory = await scratchDirectory(t, 'shadowgraph-runtime-miss-');
  const file = join(directory, 'store.json');
  const store = createJsonFileStore(file);
  await store.save(privilegedSnapshot(graph));
  const app = await createShadowGraphServer({ store, now, cwd: directory, apiToken: '' });
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.ok, true, text);
    return JSON.parse(text);
  };
  const before = await readFile(file, 'utf8');
  assert.equal((await post('/context', { project: 'alpha', query: 'zebra crossing' })).relevant.fallback.used, true);
  assert.equal(await readFile(file, 'utf8'), before, 'the read itself wrote nothing');
  await post('/decisions', { project: 'alpha', title: 'Paint the crossing', chosen: 'paint' });
  const saved = JSON.parse(await readFile(file, 'utf8'))[RUNTIME_MISSES];
  assert.equal(saved.length, RUNTIME_MISSES_PER_READ, 'the next save wrote the recorded misses');
  assert.equal(runtimeMissLedgerIssue(saved), null);
});
