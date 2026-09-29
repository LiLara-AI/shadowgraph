import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { restoreFile } from '../src/backup.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { downgradeStore, downgradeToSchema5, downgradeToSchema6 } from '../src/schema-conversion.js';
import { RUNTIME_MISSES, runtimeMissLedgerIssue } from '../src/internal/miss-ledger.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { buildToolCatalog } from '../src/mcp-tools.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// Plan rev6 PR-28a (VAR-10, VAR-19; G-5 §6.3-§6.4): the runtime miss ledger's
// reader lands alone, before anything writes an entry. It freezes the entry
// shape, carries the ledger through every store path, keeps it out of every
// public read, reaches it with purge in both modes -- scrubbed from SQLite --
// and never hands it to a build below this floor, which could not purge it.
const NOW = '2026-03-01T00:00:00.000Z';
const now = () => NOW;
const digest = (character) => character.repeat(64);
const miss = (overrides = {}) => ({
  missId: 'miss_alpha_1', at: NOW, source: 'runtime', evidence: 'fallback_recovery',
  scope: { project: 'alpha', originId: null, requestState: 'project_selected' },
  queryDigest: digest('a'), recordId: 'decision_alpha', boundRevision: null, tier: 'T0', stage: 'not_ranked', rank: null,
  signals: { lexical: { available: true, matched: 0 }, semantic: { available: false, matched: 0 }, graph: { available: false, matched: 0 }, temporal: { available: false, matched: 0 } },
  reason: 'no_signal_match', ...overrides
});
const LEDGER = [
  miss(),
  miss({ missId: 'miss_alpha_2', stage: 'ranked_not_delivered', rank: 7, boundRevision: { recordId: 'decision_alpha', digest: digest('b') }, tier: 'T1', evidence: 'explicit_correction', reason: 'ranked_below_depth' }),
  miss({ missId: 'miss_beta_1', scope: { project: 'beta', originId: null, requestState: 'project_selected' }, queryDigest: digest('c'), recordId: 'decision_beta' })
];

function seeded() {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'alpha queue', chosen: 'outbox' });
  graph.addDecision({ project: 'beta', title: 'beta queue', chosen: 'kafka' });
  graph.importData({ [RUNTIME_MISSES]: structuredClone(LEDGER) });
  return graph;
}
const ledgerOf = (payload) => payload[RUNTIME_MISSES];

test('the ledger is carried through import, snapshot, JSON and SQLite, and replaced as a whole', async (t) => {
  const graph = seeded();
  assert.deepEqual(ledgerOf(privilegedSnapshot(graph)), LEDGER);
  const replaced = seeded();
  replaced.importData({ [RUNTIME_MISSES]: [structuredClone(LEDGER[2])] });
  assert.deepEqual(ledgerOf(privilegedSnapshot(replaced)), [LEDGER[2]], 'an imported ledger replaces the live one');
  const directory = await scratchDirectory(t, 'shadowgraph-miss-ledger-carriage-');
  const json = createJsonFileStore(join(directory, 'data.json'));
  await json.save(privilegedSnapshot(graph));
  assert.deepEqual(ledgerOf(await json.load()), LEDGER);
  const reloaded = createShadowGraph({ now });
  reloaded.replaceData(await json.load());
  assert.deepEqual(ledgerOf(privilegedSnapshot(reloaded)), LEDGER);
  try { await import('node:sqlite'); } catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const sqlite = await createSqliteStore(join(directory, 'data.db'));
  await sqlite.save(privilegedSnapshot(graph));
  assert.deepEqual(ledgerOf(await sqlite.load()), LEDGER);
  sqlite.close();
});

test('no public read carries the ledger', () => {
  const graph = seeded();
  const reads = [
    graph.exportData({ project: 'alpha' }), graph.redact({ project: 'alpha' }), graph.context({ project: 'alpha' }),
    graph.context({ project: 'alpha', query: 'zebra' }), graph.search('queue', { project: 'alpha' }), graph.getJournal({ project: 'alpha' }), graph.stats({ project: 'alpha' })
  ];
  for (const read of reads) {
    const text = JSON.stringify(read);
    assert.equal(text.includes(RUNTIME_MISSES), false);
    assert.equal(text.includes(digest('a')), false);
  }
});

test('the entry shape is frozen: import and restore refuse anything else, and name what is wrong', () => {
  const malformed = [
    ['not a list', { missId: 'x' }],
    ['a missing field', [(() => { const { reason, ...rest } = miss(); return rest; })()]],
    ['an unknown field', [miss({ query: 'the raw request text' })]],
    ['an empty id', [miss({ missId: '' })]],
    ['an id carrying text', [miss({ missId: 'miss_why did the retry fail' })]],
    ['an id not minted as a miss', [miss({ missId: 'alpha_1' })]],
    ['a bad instant', [miss({ at: 'yesterday' })]],
    ['an evaluation miss', [miss({ source: 'evaluation' })]],
    ['unknown evidence', [miss({ evidence: 'similarity' })]],
    ['a query digest that is not SHA-256', [miss({ queryDigest: 'the raw request text' })]],
    ['a query digest in upper case', [miss({ queryDigest: 'A'.repeat(64) })]],
    ['an empty record id', [miss({ recordId: '' })]],
    ['a rank of zero', [miss({ stage: 'ranked_not_delivered', rank: 0 })]],
    ['a fractional rank', [miss({ stage: 'ranked_not_delivered', rank: 1.5 })]],
    ['a rank for a record not ranked', [miss({ rank: 7 })]],
    ['no rank for a ranked record', [miss({ stage: 'ranked_not_delivered', rank: null })]],
    ['no rank for a delivered line', [miss({ stage: 'delivered_line_without_decisive_meaning', rank: null })]],
    ['an unknown tier', [miss({ tier: 'T3' })]],
    ['an unknown stage', [miss({ stage: 'lost' })]],
    ['a signal missing', [miss({ signals: { lexical: { available: true, matched: 0 } } })]],
    ['a malformed signal', [miss({ signals: { ...miss().signals, graph: { available: 'yes', matched: 0 } } })]],
    ['a fifth signal', [miss({ signals: { ...miss().signals, query: { available: true, matched: 0 } } })]],
    ['a signal with extra members', [miss({ signals: { ...miss().signals, lexical: { available: true, matched: 0, query: 'text' } } })]],
    ['a negative match count', [miss({ signals: { ...miss().signals, lexical: { available: true, matched: -1 } } })]],
    ['a fractional match count', [miss({ signals: { ...miss().signals, lexical: { available: true, matched: 0.5 } } })]],
    ['an unavailable signal that matched', [miss({ signals: { ...miss().signals, semantic: { available: false, matched: 5 } } })]],
    ['a malformed bound revision', [miss({ boundRevision: { recordId: 'decision_alpha', digest: 'x' } })]],
    ['a bound revision of another record', [miss({ boundRevision: { recordId: 'decision_other', digest: digest('b') } })]],
    ['a bound revision with no record', [miss({ boundRevision: { recordId: '', digest: digest('b') } })]],
    ['a bound revision with extra members', [miss({ boundRevision: { recordId: 'decision_alpha', digest: digest('b'), query: 'text' } })]],
    ['a malformed scope', [miss({ scope: { project: 'alpha', originId: null, requestState: 'all' } })]],
    ['a scope with extra members', [miss({ scope: { project: 'alpha', originId: null, requestState: 'project_selected', query: 'text' } })]],
    ['an empty project', [miss({ scope: { project: '', originId: null, requestState: 'project_selected' } })]],
    ['a blank project', [miss({ scope: { project: '   ', originId: null, requestState: 'project_selected' } })]],
    ['a selected request naming no project', [miss({ scope: { project: null, originId: null, requestState: 'project_selected' } })]],
    ['an unresolved request naming a project', [miss({ scope: { project: 'alpha', originId: null, requestState: 'project_unresolved' } })]],
    ['an empty origin', [miss({ scope: { project: 'alpha', originId: '', requestState: 'project_selected' } })]],
    ['a blank origin', [miss({ scope: { project: null, originId: '  ', requestState: 'project_unresolved' } })]],
    ['an empty reason', [miss({ reason: '' })]],
    ['a reason carrying text', [miss({ reason: 'why did the payment retry fail' })]],
    ['an overlong reason', [miss({ reason: 'x'.repeat(65) })]],
    ['a duplicate id', [miss(), miss()]]
  ];
  for (const [label, ledger] of malformed) {
    assert.notEqual(runtimeMissLedgerIssue(ledger), null, label);
    const graph = createShadowGraph({ now });
    assert.throws(() => graph.importData({ [RUNTIME_MISSES]: ledger }), (error) => error.code === 'runtime_miss_ledger_malformed', label);
    assert.throws(() => validateRestorePayload({ ...privilegedSnapshot(createShadowGraph({ now })), [RUNTIME_MISSES]: ledger }), /runtime miss ledger/i, label);
  }
  assert.equal(runtimeMissLedgerIssue(LEDGER), null);
  assert.equal(runtimeMissLedgerIssue([]), null);
  // What the frozen shape accepts, so no later reader may refuse it.
  const accepted = [
    miss({ missId: 'miss_unresolved', scope: { project: null, originId: 'origin_1', requestState: 'project_unresolved' } }),
    miss({ missId: 'miss_unresolved_anonymous', scope: { project: null, originId: null, requestState: 'project_unresolved' } }),
    miss({ missId: 'miss_selected_origin', scope: { project: 'alpha', originId: 'origin_1', requestState: 'project_selected' } }),
    miss({ missId: 'miss_delivered', tier: 'T1', stage: 'delivered_line_without_decisive_meaning', rank: 1, boundRevision: { recordId: 'decision_alpha', digest: digest('b') } }),
    miss({ missId: 'miss_matched', signals: { ...miss().signals, lexical: { available: true, matched: 3 }, semantic: { available: true, matched: 2 } } }),
    miss({ missId: 'miss_long_reason', reason: 'x'.repeat(64) }),
    miss({ missId: `miss_${'x'.repeat(64)}` }),
    // Project names and origins are not trimmed, and record ids are any strings.
    miss({ missId: 'miss_untrimmed', scope: { project: ' alpha ', originId: ' o1 ', requestState: 'project_selected' } }),
    miss({ missId: 'miss_any_record', recordId: 'legacy record #7 / x', boundRevision: { recordId: 'legacy record #7 / x', digest: digest('b') }, stage: 'ranked_not_delivered', rank: 2 })
  ];
  assert.equal(runtimeMissLedgerIssue(accepted), null);
  const graph = createShadowGraph({ now });
  graph.importData({ [RUNTIME_MISSES]: structuredClone(accepted) });
  assert.deepEqual(ledgerOf(privilegedSnapshot(graph)), accepted);
  // A refusal names positions, never an entry's values.
  const duplicate = runtimeMissLedgerIssue([miss({ missId: 'miss_secret' }), miss({ missId: 'miss_secret' })]);
  assert.match(duplicate, /entry 1: its missId repeats entry 0/);
  assert.equal(duplicate.includes('miss_secret'), false);
});

test('a purge removes the project\'s entries in both modes, counted in the preview and the result', () => {
  for (const mode of ['logical', 'hard']) {
    const graph = seeded();
    assert.equal(graph.projectSummary('alpha').runtimeMisses, 2);
    const result = graph.purgeProject('alpha', { mode });
    assert.equal(result.runtimeMisses, 2, mode);
    assert.deepEqual(ledgerOf(privilegedSnapshot(graph)).map((entry) => entry.missId), ['miss_beta_1'], mode);
    // The last entries of the ledger take the collection with them.
    assert.equal(graph.purgeProject('beta', { mode }).runtimeMisses, 1);
    assert.equal(Object.hasOwn(privilegedSnapshot(graph), RUNTIME_MISSES), false, mode);
  }
});

test('the purge and its preview declare the count they report', () => {
  const catalog = buildToolCatalog();
  for (const name of ['shadowgraph_purge', 'shadowgraph_purge_preview']) {
    const schema = catalog.find((entry) => entry.name === name).outputSchema;
    assert.equal(schema.required.includes(RUNTIME_MISSES), true, name);
    assert.equal(schema.properties[RUNTIME_MISSES].type, 'integer', name);
  }
});

test('a purge also reaches the entries naming its entities, whatever scope recorded them', () => {
  for (const mode of ['logical', 'hard']) {
    const graph = createShadowGraph({ now });
    const purged = graph.addDecision({ project: 'alpha', title: 'alpha queue', chosen: 'outbox', alternatives: [{ label: 'kafka cluster', reasonRejected: 'operational cost' }] });
    const kept = graph.addDecision({ project: 'beta', title: 'beta queue', chosen: 'kafka' });
    const attempt = graph.addAttempt({ project: 'alpha', solution: 'retry the queue', result: 'failed' });
    const relation = graph.link({ project: 'alpha', from: purged.id, to: attempt.id, relation: 'tried' });
    const beta = { project: 'beta', originId: null, requestState: 'project_selected' };
    const unresolved = { project: null, originId: 'origin_1', requestState: 'project_unresolved' };
    graph.importData({ [RUNTIME_MISSES]: [
      miss({ missId: 'miss_granted', scope: beta, recordId: purged.id, boundRevision: { recordId: purged.id, digest: digest('b') } }),
      miss({ missId: 'miss_origin', scope: unresolved, recordId: purged.id }),
      miss({ missId: 'miss_alternative', scope: beta, recordId: purged.alternatives[0].id }),
      miss({ missId: 'miss_relation', scope: beta, recordId: relation.id }),
      miss({ missId: 'miss_unrelated', scope: unresolved, recordId: kept.id }),
      miss({ missId: 'miss_beta', scope: beta, recordId: kept.id })
    ] });
    assert.equal(graph.projectSummary('alpha').runtimeMisses, 4, mode);
    assert.equal(graph.purgeProject('alpha', { mode }).runtimeMisses, 4, mode);
    assert.deepEqual(ledgerOf(privilegedSnapshot(graph)).map((entry) => entry.missId), ['miss_unrelated', 'miss_beta'], mode);
  }
  // A project name is matched exactly, untrimmed, as the read recorded it.
  const spaced = createShadowGraph({ now });
  spaced.importData({ [RUNTIME_MISSES]: [miss({ missId: 'miss_spaced', scope: { project: ' alpha ', originId: null, requestState: 'project_selected' } }), miss()] });
  assert.equal(spaced.purgeProject(' alpha ').runtimeMisses, 1);
  assert.deepEqual(ledgerOf(privilegedSnapshot(spaced)).map((entry) => entry.missId), ['miss_alpha_1']);
});

test('SQLite physically erases a purged project\'s entries while others remain', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const directory = await scratchDirectory(t, 'shadowgraph miss ledger erasure ');
  const file = join(directory, 'ledger store.db');
  const sentinel = randomUUID().replaceAll('-', '').padEnd(64, 'f').slice(0, 64);
  const crossScope = randomUUID().replaceAll('-', '').padEnd(64, 'e').slice(0, 64);
  const graph = createShadowGraph({ now });
  const purged = graph.addDecision({ project: 'alpha', title: 'alpha queue', chosen: 'outbox' });
  graph.importData({ [RUNTIME_MISSES]: [
    miss({ queryDigest: sentinel }),
    miss({ missId: 'miss_cross_scope', scope: { project: 'beta', originId: null, requestState: 'project_selected' }, queryDigest: crossScope, recordId: purged.id }),
    LEDGER[2]
  ] });
  let store = await createSqliteStore(file);
  const revision = await store.save(privilegedSnapshot(graph));
  for (const value of [sentinel, crossScope]) assert.equal((await readFile(file)).includes(Buffer.from(value)), true, 'precondition: the entry reached SQLite bytes');
  graph.purgeProject('alpha', { mode: 'logical' });
  await store.save({ ...privilegedSnapshot(graph), expectedRevision: revision });
  store.close();
  store = undefined;
  const inspector = new DatabaseSync(new URL(`${pathToFileURL(file).href}?immutable=1`), { readOnly: true });
  try {
    assert.equal(inspector.prepare('PRAGMA freelist_count').get().freelist_count, 0, 'a save that removes an entry leaves no free pages');
  } finally { inspector.close(); }
  for (const candidate of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    let bytes = null;
    try { bytes = await readFile(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const value of [sentinel, crossScope]) if (bytes) assert.equal(bytes.includes(Buffer.from(value)), false, `${candidate} retained a purged entry`);
  }
  const reopened = await createSqliteStore(file);
  assert.deepEqual(ledgerOf(await reopened.load()).map((entry) => entry.missId), ['miss_beta_1']);
  reopened.close();
});

test('restore installs the backup\'s ledger as memory, a memory-only restore included', async (t) => {
  const graph = seeded();
  const directory = await scratchDirectory(t, 'shadowgraph-miss-ledger-restore-');
  const source = join(directory, 'backup.json');
  await writeFile(source, JSON.stringify(privilegedSnapshot(graph)));
  for (const memoryOnly of [false, true]) {
    const destination = join(directory, `data-${memoryOnly}.json`);
    await writeFile(destination, JSON.stringify(privilegedSnapshot(createShadowGraph({ now }))));
    const live = createShadowGraph({ now });
    await restoreFile(source, destination, { memoryOnly, afterReplace: (payload) => live.replaceData(payload) });
    assert.deepEqual(ledgerOf(JSON.parse(await readFile(destination, 'utf8'))), LEDGER, `memoryOnly ${memoryOnly}`);
    assert.deepEqual(ledgerOf(privilegedSnapshot(live)), LEDGER);
  }
  try { await import('node:sqlite'); } catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const origin = await createSqliteStore(join(directory, 'origin.db'));
  await origin.save(privilegedSnapshot(graph));
  const backup = join(directory, 'backup.db');
  await origin.backup(backup);
  origin.close();
  for (const memoryOnly of [false, true]) {
    const destination = await createSqliteStore(join(directory, `data-${memoryOnly}.db`));
    await destination.save(privilegedSnapshot(createShadowGraph({ now })));
    const live = createShadowGraph({ now });
    await destination.restore(backup, { memoryOnly, afterReplace: (payload) => live.replaceData(payload) });
    assert.deepEqual(ledgerOf(await destination.load()), LEDGER, `SQLite memoryOnly ${memoryOnly}`);
    assert.deepEqual(ledgerOf(privilegedSnapshot(live)), LEDGER);
    destination.close();
  }
});

test('a stored malformed ledger is refused on load, in both backends', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-miss-ledger-load-');
  const payload = { ...privilegedSnapshot(createShadowGraph({ now })), [RUNTIME_MISSES]: [miss({ reason: 'why did the payment retry fail' })] };
  const refused = (error) => error.code === 'runtime_miss_ledger_malformed' && !error.message.includes('payment');
  const file = join(directory, 'data.json');
  await writeFile(file, JSON.stringify(payload));
  const json = await createJsonFileStore(file).load();
  assert.throws(() => createShadowGraph({ now }).importData(json), refused);
  assert.throws(() => createShadowGraph({ now }).replaceData(json), /runtime_miss_ledger_malformed/);
  try { await import('node:sqlite'); } catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const sqlite = await createSqliteStore(join(directory, 'data.db'));
  await sqlite.save(payload);
  const stored = await sqlite.load();
  sqlite.close();
  assert.throws(() => createShadowGraph({ now }).importData(stored), refused);
});

test('below this floor, conversion leaves the ledger out and reports only how many entries it held', () => {
  const snapshot = privilegedSnapshot(seeded());
  const six = downgradeToSchema6(snapshot, { now });
  assert.equal(Object.hasOwn(six.payload, RUNTIME_MISSES), false);
  assert.deepEqual(six.report.excludedCollections, [RUNTIME_MISSES]);
  assert.deepEqual(six.report.excludedEntryCounts, { [RUNTIME_MISSES]: 3 });
  assert.equal(six.report.carriedCollections.includes(RUNTIME_MISSES), false);
  assert.equal(JSON.stringify(six.report).includes(digest('a')), false, 'counts only');
  // A schema-6 store carrying a ledger is refused a place in schema 5 the same way.
  const five = downgradeToSchema5({ ...six.payload, [RUNTIME_MISSES]: structuredClone(LEDGER) }, { now });
  assert.equal(Object.hasOwn(five.payload, RUNTIME_MISSES), false);
  assert.deepEqual(five.report.excludedCollections, [RUNTIME_MISSES]);
  assert.deepEqual(five.report.excludedEntryCounts, { [RUNTIME_MISSES]: 3 });
  assert.equal(JSON.stringify(five.report).includes(digest('a')), false);
});

test('the store-level downgrade names the ledger once, counts it, and keeps it in the preservation copy', async (t) => {
  const graph = seeded();
  const directory = await scratchDirectory(t, 'shadowgraph-miss-ledger-downgrade-');
  const file = join(directory, 'data.json');
  const store = createJsonFileStore(file);
  await store.save(privilegedSnapshot(graph));
  const output = join(directory, 'five.json');
  const preservationCopy = join(directory, 'preserved.json');
  const result = await downgradeStore({ graph, store, file, output, preservationCopy, now });
  assert.equal(result.toSchemaVersion, 5);
  assert.equal(result.excludedCollections.filter((collection) => collection === RUNTIME_MISSES).length, 1);
  assert.deepEqual(result.excludedEntryCounts, { [RUNTIME_MISSES]: 3 });
  for (const written of [await readFile(output, 'utf8'), await readFile(result.report, 'utf8')]) {
    assert.equal(written.includes(digest('a')), false, 'counts only');
  }
  assert.equal(Object.hasOwn(JSON.parse(await readFile(output, 'utf8')), RUNTIME_MISSES), false);
  assert.deepEqual(ledgerOf(JSON.parse(await readFile(preservationCopy, 'utf8'))), LEDGER);
});

test('nothing writes an entry yet: reads, the relevance fallback and expansion leave no ledger', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'alpha queue', chosen: 'outbox' });
  graph.context({ project: 'alpha', query: 'zebra', compact: true });
  graph.context({ project: 'alpha', query: 'queue', compact: true });
  graph.recall('zebra', { project: 'alpha' });
  graph.expand({ recordId: 'decision:missing', digest: digest('d'), project: 'alpha' });
  assert.equal(Object.hasOwn(privilegedSnapshot(graph), RUNTIME_MISSES), false);
});

// The reader floor lands alone: only the modules that read, purge or convert the
// ledger, or declare the purge's count of it, name it, and the kernel only ever
// keeps what a purge leaves.
test('only the reader, purge, conversion and the purge schema name the ledger', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith('.js')) files.push(next);
    }
  };
  await walk(new URL('../src/', import.meta.url));
  const naming = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (text.includes('RUNTIME_MISSES') || text.includes("'runtimeMisses'")) naming.push(file.pathname.split('/src/')[1]);
  }
  assert.deepEqual(naming.sort(), ['internal/miss-ledger.js', 'mcp-tools.js', 'schema-conversion.js', 'shadowgraph.js', 'sqlite-storage.js']);
  const kernel = await readFile(new URL('../src/shadowgraph.js', import.meta.url), 'utf8');
  assert.deepEqual(kernel.match(/extras\.set\(RUNTIME_MISSES, [^)]*\)/g), ['extras.set(RUNTIME_MISSES, kept)']);
});
