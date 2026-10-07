// Plan v1.4.4 PR-23 (§9.4, §14.5, PC-04): an attempt's cause is a claim of its
// own. A reason recorded now is attributed apart from the observation it
// explains; a reason an earlier build stored is legacy free text, never classed
// and never evidenced; no reason is "not recorded"; and "cause unknown" stays
// unknown. The four states are told apart in every view, and the reason itself
// is kept verbatim, where search and the frozen benchmark adapter read it.
//
// Nothing derived is stored: the legacy state is derived on the way out, so a
// store this build writes to stays restorable by the builds before it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { rebuildProjection } from '../src/journal.js';
import { buildToolCatalog } from '../src/mcp-tools.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { downgradeToSchema6 } from '../src/schema-conversion.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const mcp = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
const RECORDED = { state: 'recorded', sourceClass: 'agent_claimed', evidence: [] };
const LEGACY_REASON = '  Because the  lock\ttimed out  ';
// A store an earlier build wrote: attempts with and without a reason.
const LEGACY = {
  records: [
    { id: 'attempt-reasoned', kind: 'attempt', project: 'alpha', solution: 'retry', result: 'failed again', resultClass: 'failed', reason: LEGACY_REASON, createdAt: NOW },
    { id: 'attempt-silent', kind: 'attempt', project: 'alpha', solution: 'wait', result: 'failed', resultClass: 'failed', reason: '', createdAt: NOW }
  ]
};
const EXPECTED = { retry: 'legacy_freetext', wait: 'not_recorded', fresh: 'recorded', bare: 'not_recorded', mystery: 'unknown' };
const statesOf = (items) => Object.fromEntries(items.filter((item) => item?.kind === 'attempt').map((item) => [item.solution, item.causalClaim?.state]));
const shown = (graph) => graph.exportData({ project: 'alpha' }).records;
const copiesOf = (payload, id) => [...payload.records, ...payload.idempotency.map((item) => item.value), ...payload.journal.map((entry) => entry.payload)].filter((entity) => entity?.id === id);

// One graph holding all four states: legacy free text and not recorded from an
// earlier build's store, recorded and not recorded from this build, and unknown
// as only an extractor will write it (here, through import).
function mixedGraph() {
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(LEGACY));
  graph.addAttempt({ project: 'alpha', solution: 'fresh', result: 'failed', resultClass: 'failed', sourceClass: 'tool_observed', reason: 'the cache was cold' });
  graph.addAttempt({ project: 'alpha', solution: 'bare', result: 'failed', resultClass: 'failed' });
  const unknown = graph.addAttempt({ project: 'alpha', solution: 'mystery', result: 'failed', resultClass: 'failed', idempotencyKey: 'mystery' });
  const payload = privilegedSnapshot(graph);
  for (const entity of copiesOf(payload, unknown.id)) entity.causalClaim = { state: 'unknown' };
  const loaded = createShadowGraph({ now });
  loaded.importData(payload);
  return loaded;
}

// A schema-7 store a build before this one wrote: its attempt has no cause.
function beforeCauses() {
  const graph = createShadowGraph({ now });
  const attempt = graph.addAttempt({ project: 'alpha', solution: 'earlier', result: 'failed', resultClass: 'failed', reason: 'the lock timed out', idempotencyKey: 'earlier' });
  const payload = privilegedSnapshot(graph);
  for (const entity of copiesOf(payload, attempt.id)) delete entity.causalClaim;
  return payload;
}

test('a recorded reason is the caller\'s claim, attributed apart from the observation it explains', () => {
  const graph = createShadowGraph({ now });
  const attempt = graph.addAttempt({ project: 'alpha', solution: 's', result: 'the job failed', resultClass: 'failed', sourceClass: 'tool_observed', reason: 'the lock timed out' });
  assert.equal(attempt.sourceClass, 'tool_observed', 'the observation keeps its own class');
  assert.deepEqual(attempt.causalClaim, RECORDED, 'the explanation does not inherit it');
  assert.equal(attempt.reason, 'the lock timed out');
  assert.deepEqual(graph.addAttempt({ project: 'alpha', solution: 's2', result: 'r', resultClass: 'failed' }).causalClaim, { state: 'not_recorded' });
  assert.deepEqual(graph.addAttempt({ project: 'alpha', solution: 's3', result: 'r', resultClass: 'failed', reason: ' \n ' }).causalClaim, { state: 'not_recorded' });
  // A reason that is not a string is stored as given, and so is its cause; null is no reason.
  for (const [reason, stored, cause] of [[null, '', { state: 'not_recorded' }], [0, 0, RECORDED], [false, false, RECORDED], [404, 404, RECORDED], [['disk full'], ['disk full'], RECORDED], [{ why: 'x' }, { why: 'x' }, RECORDED]]) {
    const given = graph.addAttempt({ project: 'alpha', solution: `s-${JSON.stringify(reason)}`, result: 'r', resultClass: 'failed', reason });
    assert.deepEqual({ reason: given.reason, cause: given.causalClaim }, { reason: stored, cause }, JSON.stringify(reason));
  }
  // A caller declares a reason, never the cause's class, statement, source or evidence.
  const declared = graph.addAttempt({ project: 'alpha', solution: 's4', result: 'r', resultClass: 'failed', reason: 'x', causalClaim: { statement: 'y', state: 'unknown', class: 'quoted', sourceClass: 'tool_observed', evidence: [{ sourceRef: 'capture:c1' }] } });
  assert.deepEqual(declared.causalClaim, RECORDED);
  assert.equal(graph.validate().valid, true);
  const outputSchema = buildToolCatalog().find((tool) => tool.name === 'shadowgraph_record_attempt').outputSchema;
  assert.equal(outputSchema.properties.causalClaim.type, 'object', 'the MCP output schema documents it');
  for (const word of ['recorded', 'agent_claimed', 'unknown', 'not_recorded', 'legacy_freetext']) assert.ok(outputSchema.properties.causalClaim.description.includes(word), word);
});

test('a reason an earlier build stored is legacy free text, verbatim, with no class and no evidence, and nothing is stored for it', () => {
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(LEGACY));
  const byId = Object.fromEntries(shown(graph).map((record) => [record.id, record]));
  assert.deepEqual(byId['attempt-reasoned'].causalClaim, { state: 'legacy_freetext' });
  assert.equal(byId['attempt-reasoned'].reason, LEGACY_REASON, 'byte for byte');
  assert.deepEqual(byId['attempt-silent'].causalClaim, { state: 'not_recorded' });
  assert.equal(byId['attempt-silent'].reason, '');
  assert.equal(privilegedSnapshot(graph).records.some((record) => Object.hasOwn(record, 'causalClaim')), false, 'the store keeps what the earlier build wrote');
  // A schema-7 attempt an earlier schema-7 build wrote reads the same way.
  const earlier = createShadowGraph({ now });
  earlier.importData(beforeCauses());
  assert.deepEqual(shown(earlier)[0].causalClaim, { state: 'legacy_freetext' });
  for (const view of [shown(earlier), earlier.search('lock', { project: 'alpha' }).items, earlier.context({ project: 'alpha' }).failedAttempts]) {
    assert.equal(JSON.stringify(view).includes('erasureToken'), false, 'the token stays internal where the cause is derived');
  }
  // Any reason a legacy record holds, of any type, is legacy free text; none,
  // null or blank is not recorded. A record missing a field is still a record.
  const edges = createShadowGraph({ now });
  edges.importData({ records: [
    { id: 'a-blank', kind: 'attempt', project: 'alpha', solution: 'blank', result: 'failed', reason: '  \n ', createdAt: NOW },
    { id: 'a-number', kind: 'attempt', project: 'alpha', solution: 'number', result: 'failed', reason: 42, createdAt: NOW },
    { id: 'a-list', kind: 'attempt', project: 'alpha', solution: 'list', result: 'failed', reason: ['disk full'], createdAt: NOW },
    { id: 'a-null', kind: 'attempt', project: 'alpha', solution: 'null', result: 'failed', reason: null, createdAt: NOW },
    { id: 'a-none', kind: 'attempt', project: 'alpha', solution: 'none', result: 'failed', createdAt: NOW },
    { id: 'a-nosolution', kind: 'attempt', project: 'alpha', result: 'failed', reason: 'why', createdAt: NOW }
  ] });
  assert.deepEqual(Object.fromEntries(shown(edges).map((record) => [record.id, record.causalClaim?.state])), {
    'a-blank': 'not_recorded', 'a-number': 'legacy_freetext', 'a-list': 'legacy_freetext', 'a-null': 'not_recorded', 'a-none': 'not_recorded', 'a-nosolution': 'legacy_freetext'
  });
  // A stored cause is shown as stored, whatever its state.
  assert.deepEqual(statesOf(shown(mixedGraph())), EXPECTED);
});

// An older build restores a store only if its journal replays to the live
// records without this build's help. So a write after loading an earlier
// store leaves every earlier attempt equal to its own journal entry, and the
// raw replay -- what an older reader compares -- still matches the live store.
test('a store an earlier build wrote stays restorable by that build after this one writes to it', () => {
  for (const [label, payload, write] of [
    ['a schema-7 store', beforeCauses(), (graph) => graph.addDecision({ project: 'alpha', title: 'Later', chosen: 'x' })],
    ['a legacy store and its token backfill', structuredClone(LEGACY), (graph) => graph.backfillErasureTokens()]
  ]) {
    const graph = createShadowGraph({ now });
    graph.importData(payload);
    write(graph);
    const saved = privilegedSnapshot(graph);
    const replayed = new Map(rebuildProjection(structuredClone(saved.journal), { journalEpoch: saved.journalEpoch }).projection.records.map((record) => [record.id, record]));
    for (const record of saved.records.filter((item) => item.kind === 'attempt')) {
      assert.equal(Object.hasOwn(record, 'causalClaim'), false, `${label}: nothing derived is stored`);
      assert.deepEqual(replayed.get(record.id), record, `${label}: the raw replay is the live record`);
    }
    assert.doesNotThrow(() => validateRestorePayload(structuredClone(saved), { now }), label);
  }
});

test('the four states are told apart in every view, after restore, and after JSON and SQLite save and reload', async (t) => {
  const graph = mixedGraph();
  const scope = { project: 'alpha' };
  const ids = shown(graph).map((record) => record.id);
  const views = {
    search: graph.search('', { ...scope, limit: 50 }).items.map((item) => item.record),
    retrieve: graph.retrieve('failed', { ...scope, limit: 50 }).items.map((item) => item.record),
    recall: graph.recall('failed', { ...scope, limit: 50 }).items.map((item) => item.record),
    context: graph.context(scope).failedAttempts,
    export: graph.exportData(scope).records,
    redact: graph.redact(scope).records,
    rebuild: graph.rebuild(scope).projection.records,
    traverse: ids.flatMap((id) => graph.traverse({ ...scope, id }).nodes)
  };
  for (const [name, items] of Object.entries(views)) assert.deepEqual(statesOf(items), EXPECTED, name);

  const snapshot = privilegedSnapshot(graph);
  const restored = createShadowGraph({ now });
  restored.replaceData(validateRestorePayload(structuredClone(snapshot), { now }));
  assert.deepEqual(statesOf(shown(restored)), EXPECTED, 'restore');

  const directory = await scratchDirectory(t, 'shadowgraph-causal-');
  const store = createJsonFileStore(join(directory, 'data.json'));
  await store.save(structuredClone(snapshot));
  const fromJson = createShadowGraph({ now });
  fromJson.importData(await store.load());
  assert.deepEqual(statesOf(shown(fromJson)), EXPECTED, 'JSON');
  try { await import('node:sqlite'); } catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return; }
  const sqlite = await createSqliteStore(join(directory, 'data.db'));
  await sqlite.save(structuredClone(snapshot));
  const loaded = await sqlite.load();
  sqlite.close();
  const fromSqlite = createShadowGraph({ now });
  fromSqlite.importData(loaded);
  assert.deepEqual(statesOf(shown(fromSqlite)), EXPECTED, 'SQLite');
});

test('a journal entry is shown as it was written, and a future attempt is given no meaning', () => {
  const earlier = createShadowGraph({ now });
  earlier.importData(beforeCauses());
  const [entry] = earlier.getJournal({ project: 'alpha', limit: 100 }).items.filter((item) => item.type === 'attempt.recorded');
  assert.equal(Object.hasOwn(entry.payload, 'causalClaim'), false, 'the journal entry is not rewritten');
  assert.deepEqual(shown(earlier)[0].causalClaim, { state: 'legacy_freetext' }, 'while the record is shown with its cause');
  const payload = beforeCauses();
  for (const entity of copiesOf(payload, payload.records[0].id)) entity.schemaVersion = 8;
  const future = createShadowGraph({ now });
  future.importData(payload);
  const [record] = future.exportData({ project: 'alpha' }).records;
  assert.equal(record?.schemaVersion, 8);
  assert.equal(Object.hasOwn(record, 'causalClaim'), false, 'carried as it arrived');
});

test('the reason stays searchable and round-trips unchanged through MCP record and search', async (t) => {
  const graph = mixedGraph();
  const hits = graph.search('lock', { project: 'alpha' }).items;
  assert.deepEqual(hits.map((item) => [item.record.reason, item.matched, item.record.causalClaim]), [[LEGACY_REASON, ['attempt reason'], { state: 'legacy_freetext' }]]);

  const directory = await scratchDirectory(t, 'shadowgraph-causal-mcp-');
  const file = join(directory, 'mcp.json');
  await writeFile(file, JSON.stringify(privilegedSnapshot(createShadowGraph({ now }))));
  const child = spawn(process.execPath, [mcp], { env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  const replies = new Map();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines.filter((item) => item.trim())) { const message = JSON.parse(line); replies.get(message.id)?.(message); }
  });
  const rpc = (id, method, params) => new Promise((resolve) => {
    replies.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  }).then((message) => { assert.equal(message.error, undefined, JSON.stringify(message.error)); return message.result; });
  const call = (id, name, args) => rpc(id, 'tools/call', { name, arguments: args }).then((result) => result.structuredContent);
  await rpc(0, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'causal-carrier', version: '1.0.0' } });
  const encoded = 'sgx1:eyJpZCI6InJlY29yZC0xIn0=\n  trailing  ';
  const recorded = await call(1, 'shadowgraph_record_attempt', { project: 'bench', solution: 'approach-1', result: 'failed', reason: encoded, environment: 'scenario-1' });
  assert.equal(recorded.reason, encoded);
  assert.deepEqual(recorded.causalClaim, RECORDED);
  const page = await call(2, 'shadowgraph_search', { query: 'scenario-1', project: 'bench', kind: 'attempt', offset: 0, limit: 10 });
  assert.deepEqual(page.items.map((item) => [item.record.reason, item.record.causalClaim]), [[encoded, RECORDED]]);
});

test('AC-028: a historical decision and attempt carry actor, time, status and owner; the cause\'s attribution is its own', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'Use a queue', chosen: 'queue', actor: 'sam', sourceClass: 'human_confirmed' });
  graph.addAttempt({ project: 'alpha', solution: 'sync calls', result: 'timed out', resultClass: 'failed', actor: 'sam', sourceClass: 'tool_observed', reason: 'the upstream was slow' });
  const view = graph.context({ project: 'alpha' });
  const [decision] = view.activeDecisions;
  const [attempt] = view.failedAttempts;
  for (const [label, item] of [['decision', decision], ['attempt', attempt]]) {
    assert.deepEqual({ actor: item.actor, createdAt: item.createdAt, project: item.project, attribution: item.attribution }, { actor: 'sam', createdAt: NOW, project: 'alpha', attribution: 'project' }, label);
  }
  assert.equal(typeof decision.status, 'string');
  assert.equal(attempt.resultClass, 'failed');
  assert.deepEqual({ observation: attempt.sourceClass, cause: attempt.causalClaim.sourceClass }, { observation: 'tool_observed', cause: 'agent_claimed' });
});

test('downgrade to schema 6 removes every stored cause and says so; the reason brings it back as legacy free text', () => {
  const graph = mixedGraph();
  const { payload, report } = downgradeToSchema6(privilegedSnapshot(graph), { now });
  assert.equal(payload.records.some((record) => Object.hasOwn(record, 'causalClaim')), false);
  const solutions = new Map(privilegedSnapshot(graph).records.map((record) => [record.id, record.solution]));
  const removed = report.removedFields.filter((item) => item.fields.includes('causalClaim')).map((item) => solutions.get(item.id)).sort();
  assert.deepEqual(removed, ['bare', 'fresh', 'mystery'], 'every stored cause is named; a legacy attempt had none stored');
  const again = createShadowGraph({ now });
  again.importData(payload);
  assert.deepEqual(statesOf(shown(again)), { retry: 'legacy_freetext', wait: 'not_recorded', fresh: 'legacy_freetext', bare: 'not_recorded', mystery: 'not_recorded' });
});

test('a classed cause names the verifier that classified it', () => {
  const graph = createShadowGraph({ now });
  const attempt = graph.addAttempt({ project: 'alpha', solution: 's', result: 'r', resultClass: 'failed', reason: 'x', idempotencyKey: 'a1' });
  const withCause = (causalClaim) => {
    const payload = privilegedSnapshot(graph);
    for (const entity of copiesOf(payload, attempt.id)) entity.causalClaim = structuredClone(causalClaim);
    return payload;
  };
  const verified = [
    { statement: 'the lock timed out', class: 'quoted', sourceClass: 'agent_claimed', evidence: [{ sourceRef: 'capture:c1' }], state: 'recorded' },
    { statement: 'the lock timed out', class: 'ambiguous', state: 'unknown' }
  ];
  for (const classed of [...verified, { class: 'ambiguous', state: 'legacy_freetext' }, { class: 'ambiguous', state: 'not_recorded' }]) {
    for (const verifierVersion of [undefined, '', '  ']) {
      const cause = verifierVersion === undefined ? classed : { ...classed, verifierVersion };
      assert.throws(() => createShadowGraph({ now }).importData(withCause(cause)), /causalClaim.*verifierVersion/, `${classed.state} ${classed.class} ${JSON.stringify(verifierVersion)}`);
    }
  }
  for (const classed of verified) assert.doesNotThrow(() => createShadowGraph({ now }).importData(withCause({ ...classed, verifierVersion: 'claim-verifier-v1' })));
});

test('a caller\'s own JSON is shown as stored, even when it looks like an attempt', () => {
  const graph = createShadowGraph({ now });
  const attempt = graph.addAttempt({ project: 'alpha', solution: 's', result: 'failed', resultClass: 'failed', reason: 'disk full' });
  const lookalike = { kind: 'attempt', id: attempt.id, result: 'failed', reason: 'disk full' };
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'n1', text: 'see attempt', metadata: { lastFailure: lookalike } });
  graph.addFact({ project: 'alpha', key: 'last', value: lookalike });
  const view = graph.exportData({ project: 'alpha' });
  assert.deepEqual(view.records.find((record) => record.kind === 'memory').metadata.lastFailure, lookalike, 'memory metadata');
  assert.deepEqual(view.facts[0].value, lookalike, 'a fact value');
  // A legacy fact may carry no kind: it is still a record, and its content is its writer's.
  const legacy = createShadowGraph({ now });
  legacy.importData({ facts: [{ id: 'fact-kindless', key: 'last', value: lookalike, source: lookalike, project: 'alpha' }] });
  const [kindless] = legacy.exportData({ project: 'alpha' }).facts;
  assert.deepEqual({ value: kindless.value, source: kindless.source }, { value: lookalike, source: lookalike });
});

test('a merged future attempt keeps the cause it arrived with', () => {
  const graph = createShadowGraph({ now });
  graph.importData(beforeCauses());
  const [live] = privilegedSnapshot(graph).records;
  graph.importData({ schemaVersion: 7, records: [{ ...live, schemaVersion: 8, causalClaim: { state: 'legacy_freetext' } }] });
  const [stored] = privilegedSnapshot(graph).records;
  assert.deepEqual({ schemaVersion: stored.schemaVersion, causalClaim: stored.causalClaim }, { schemaVersion: 8, causalClaim: { state: 'legacy_freetext' } });
});

test('a public read merged back, or given as a retry value, stores nothing it only showed', () => {
  const graph = createShadowGraph({ now });
  graph.importData(beforeCauses());
  const before = privilegedSnapshot(graph);
  const [record] = shown(graph);
  assert.deepEqual(record.causalClaim, { state: 'legacy_freetext' });
  graph.importData({ schemaVersion: 7, records: [record] });
  assert.deepEqual(privilegedSnapshot(graph), before, 'merging it back is a no-op');
  graph.importData({ schemaVersion: 7, idempotency: [{ key: before.idempotency[0].key, value: record }] });
  assert.deepEqual(privilegedSnapshot(graph), before, 'and so is giving it as its own retry value');
});
