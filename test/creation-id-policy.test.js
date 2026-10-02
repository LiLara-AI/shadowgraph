import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot as snap, privilegedValidate, privilegedRebuild } from '../src/internal/snapshot.js';
import { createStorage } from '../src/storage.js';
import { createShadowGraphServer } from '../src/server.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { assertCliOutcomeEqual } from '../tools/assert-cli-outcome.js';
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const backendOptions = backend => ({ skip: backend === 'sqlite' && !sqlite.available ? sqlite.reason : false });

const repo = fileURLToPath(new URL('../', import.meta.url));
const clock = () => '2026-09-01T00:00:00.000Z';
const target = 'historical-foreign-id';
const policy = error => error?.code === 'creation_id_not_allowed';
const arms = [
  ['decision', 'addDecision', 'decision', '/decisions', 'shadowgraph_record_decision', { title: 'Probe', chosen: 'A' }],
  ['alternative', 'addDecision', 'decision', '/decisions', 'shadowgraph_record_decision', { title: 'Probe', chosen: 'A', alternatives: [{ label: 'B' }] }],
  ['attempt', 'addAttempt', 'attempt', '/attempts', 'shadowgraph_record_attempt', { solution: 'Probe', result: 'failed' }],
  ['memory', 'remember', 'remember', '/memories', 'shadowgraph_remember', { memoryType: 'note', key: 'new', text: 'Probe' }],
  ['fact', 'addFact', 'fact', '/facts', 'shadowgraph_record_fact', { key: 'new', value: true }],
  ['relation', 'link', 'link', '/relationships', 'shadowgraph_link', { relation: 'supports' }],
  ['plan-add', 'applyMemoryPlan', 'remember', '/memories', 'shadowgraph_remember', { operations: [{ action: 'ADD', memoryType: 'note', key: 'plan', text: 'Probe' }] }],
  ['plan-update', 'applyMemoryPlan', 'remember', '/memories', 'shadowgraph_remember', { operations: [{ action: 'UPDATE', memoryType: 'note', key: 'existing', text: 'Updated' }] }]
];

// Administrative hydration models an already stored identity. It does not add
// a caller-ID option to any ordinary creation API.
function renameStoredIdentity(graph, oldId, newId) {
  function visit(value) {
    if (value === oldId) return newId;
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v)]));
    return value;
  }
  graph.replaceData(visit(snap(graph)));
}

function fixture(occupied, kind = 'memory', own = { project: 'alpha' }, foreign = { project: 'beta' }) {
  const graph = createShadowGraph({ now: clock });
  const from = graph.addDecision({ ...own, title: 'Own A', chosen: 'A' }).id;
  const to = graph.addDecision({ ...own, title: 'Own B', chosen: 'B' }).id;
  graph.remember({ ...own, memoryType: 'note', key: 'existing', text: 'Before' });
  if (occupied) {
    let id;
    if (kind === 'decision') id = graph.addDecision({ ...foreign, title: 'Foreign', chosen: 'B' }).id;
    if (kind === 'attempt') id = graph.addAttempt({ ...foreign, solution: 'Foreign', result: 'failed' }).id;
    if (kind === 'memory') id = graph.remember({ ...foreign, memoryType: 'note', key: 'foreign', text: 'Foreign' }).memory.id;
    if (kind === 'fact') id = graph.addFact({ ...foreign, key: 'foreign', value: true }).id;
    if (kind === 'alternative') id = graph.addDecision({ ...foreign, title: 'Foreign', chosen: 'B', alternatives: [{ label: 'Other' }] }).alternatives[0].id;
    if (kind === 'relation') {
      const a = graph.addDecision({ ...foreign, title: 'Foreign A', chosen: 'B' });
      const b = graph.addDecision({ ...foreign, title: 'Foreign B', chosen: 'C' });
      id = graph.link({ ...foreign, from: a.id, to: b.id, relation: 'supports' }).id;
    }
    renameStoredIdentity(graph, id, target);
  }
  assert.equal(privilegedValidate(graph).valid, true);
  assert.equal(privilegedRebuild(graph).rebuildable, true);
  return { graph, own, from, to };
}

function inputFor(arm, f, supplied = true) {
  const input = { ...f.own, ...structuredClone(arm[5]) };
  if (arm[0] === 'relation') Object.assign(input, { from: f.from, to: f.to });
  const creation = arm[0] === 'alternative' ? input.alternatives[0] : arm[0].startsWith('plan-') ? input.operations[0] : input;
  if (supplied) creation.id = target;
  return input;
}
function resultId(arm, value) {
  return arm[0] === 'alternative' ? value.alternatives[0].id : arm[0].startsWith('plan-') ? value.results[0].memory.id : arm[0] === 'memory' ? value.memory.id : value.id;
}

for (const arm of arms) for (const kind of ['decision', 'attempt', 'memory', 'fact', 'alternative', 'relation']) {
  test(`creation policy ${arm[0]} refuses occupied/absent ${kind} identically`, () => {
    const errors = [];
    for (const occupied of [true, false]) {
      const f = fixture(occupied, kind); const before = snap(f.graph);
      assert.throws(() => f.graph[arm[1]](inputFor(arm, f)), error => { errors.push({ code: error.code, message: error.message }); return policy(error); });
      assert.deepEqual(snap(f.graph), before);
      const id = resultId(arm, f.graph[arm[1]](inputFor(arm, f, false)));
      assert.equal(typeof id, 'string'); assert.ok(id); assert.notEqual(id, target);
    }
    assert.deepEqual(errors[0], errors[1]);
  });
}
for (const arm of arms) test(`creation policy ${arm[0]} also holds for origin ownership`, () => {
  for (const occupied of [true, false]) {
    const f = fixture(occupied, 'memory', { originId: 'origin-a' }, { originId: 'origin-b' });
    assert.throws(() => f.graph[arm[1]](inputFor(arm, f)), policy);
    assert.ok(resultId(arm, f.graph[arm[1]](inputFor(arm, f, false))));
  }
});

test('creation property presence is refused without reading its value, including inherited IDs', () => {
  const g = createShadowGraph();
  for (const value of [undefined, null, '', false, 0, {}, []]) {
    assert.throws(() => g.addDecision({ project: 'alpha', title: 'A', chosen: 'B', id: value }), policy);
  }
  const inherited = Object.assign(Object.create({ id: 'inherited' }), { project: 'alpha', title: 'A', chosen: 'B' });
  assert.throws(() => g.addDecision(inherited), policy);
  const getter = { project: 'alpha', title: 'A', chosen: 'B', get id() { assert.fail('ID value was read'); } };
  assert.throws(() => g.addDecision(getter), policy);
});

test('creation policy precedes retries, memory NOOP, index updates and late batch mutations', () => {
  const f = fixture(true), g = f.graph;
  for (const arm of arms.filter(a => ['decision', 'attempt', 'memory', 'fact'].includes(a[0]))) {
    const input = { ...inputFor(arm, f, false), idempotencyKey: `retry-${arm[0]}` };
    const first = g[arm[1]](input), before = snap(g);
    assert.throws(() => g[arm[1]]({ ...input, id: target }), policy);
    assert.deepEqual(snap(g), before);
    assert.equal(resultId(arm, g[arm[1]](input)), resultId(arm, first));
  }
  const before = snap(g);
  assert.throws(() => g.remember({ project: 'alpha', id: target, memoryType: 'note', key: 'existing', text: 'Before', embedding: [1, 0] }), policy);
  assert.throws(() => g.addDecision({ project: 'alpha', title: 'A', chosen: 'A', alternatives: [{ label: 'first' }, { label: 'last', id: target }] }), policy);
  assert.throws(() => g.applyMemoryPlan({ project: 'alpha', operations: [{ action: 'ADD', memoryType: 'note', key: 'first', text: 'Not committed' }, { action: 'UPDATE', memoryType: 'note', key: 'existing', text: 'Last', id: target }] }), policy);
  assert.deepEqual(snap(g), before);
});

test('generated allocation retries collisions, reserves alternatives, and has a bounded generic refusal', t => {
  const f = fixture(false), g = f.graph;
  const fixed = 1790000000000;
  const candidate = `decision_${fixed}_${(0.25).toString(36).slice(2, 8)}`;
  renameStoredIdentity(g, f.from, candidate);
  t.mock.method(Date, 'now', () => fixed);
  let n = 0;
  let random = () => n++ === 0 ? 0.25 : (n + 1) / 1000;
  t.mock.method(Math, 'random', () => random());
  const created = g.addDecision({ project: 'alpha', title: 'Allocated', chosen: 'A', alternatives: [{ label: 'B' }, { label: 'C' }] });
  assert.notEqual(created.id, candidate);
  assert.notEqual(created.alternatives[0].id, created.alternatives[1].id);
  const before = snap(g);
  random = () => 0.25;
  assert.throws(() => g.addDecision({ project: 'alpha', title: 'Exhausted', chosen: 'A' }), error => error.code === 'entity_id_allocation_failed' && !error.message.includes(candidate));
  assert.deepEqual(snap(g), before);
});

const envFor = (file, backend, compact = false) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^SHADOWGRAPH_|^NODE_OPTIONS$/i.test(key))), SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: backend, SHADOWGRAPH_MCP_COMPACT: compact ? '1' : '0', SHADOWGRAPH_HOME: process.env.SHADOWGRAPH_HOME });

// Its children resolve the deletion registry in this file's own home, never under an account home's ShadowGraph root,
// where a child given no SHADOWGRAPH_HOME falls back to (PR-37d review finding 3).
test("envFor gives its children this file's own SHADOWGRAPH_HOME, outside every account home's ShadowGraph root", () => {
  const home = envFor(join(tmpdir(), 'store.json'), 'json').SHADOWGRAPH_HOME;
  assert.ok(typeof home === 'string' && isAbsolute(home), String(home));
  assert.equal(home, process.env.SHADOWGRAPH_HOME);
  const folded = path => (process.platform === 'win32' ? path.toLowerCase() : path);
  for (const account of [homedir(), userInfo().homedir]) {
    const inside = relative(folded(join(account, '.shadowgraph')), folded(home));
    assert.ok(inside.startsWith('..') || isAbsolute(inside), `${home} lies under ${account}'s ShadowGraph root`);
  }
});

test('memory plan envelope and DELETE/NOOP IDs are unsupported, never target references', () => {
  for (const occupied of [true, false]) {
    const { graph } = fixture(occupied), before = snap(graph);
    assert.throws(() => graph.applyMemoryPlan({ project: 'alpha', id: target, operations: [] }), policy);
    for (const action of ['DELETE', 'NOOP']) assert.throws(() => graph.applyMemoryPlan({ project: 'alpha', operations: [
      { action: 'ADD', memoryType: 'note', key: 'early', text: 'No partial write' },
      { action, memoryType: 'note', key: 'existing', id: target }
    ] }), policy);
    assert.deepEqual(snap(graph), before);
  }
});

for (const kind of ['decision', 'attempt', 'memory', 'fact', 'alternative', 'relation']) test(`allocator retries a candidate occupied by a ${kind}`, t => {
  const { graph } = fixture(true, kind), fixed = 1790000000000;
  const candidate = `decision_${fixed}_${(0.25).toString(36).slice(2, 8)}`;
  renameStoredIdentity(graph, target, candidate);
  t.mock.method(Date, 'now', () => fixed);
  let n = 0; t.mock.method(Math, 'random', () => n++ === 0 ? 0.25 : 0.5);
  const decision = graph.addDecision({ project: 'alpha', title: 'Collision retry', chosen: 'A' });
  assert.notEqual(decision.id, candidate); assert.ok(n >= 2);
  assert.equal(privilegedValidate(graph).valid, true);
});

test('allocator reserves sibling alternatives and rolls back an exhausted late memory-plan allocation', t => {
  const { graph } = fixture(false), fixed = 1790000000000;
  const old = graph.remember({ project: 'beta', memoryType: 'note', key: 'occupied', text: 'Old' }).memory;
  renameStoredIdentity(graph, old.id, `memory_${fixed}_${(0.25).toString(36).slice(2, 8)}`);
  t.mock.method(Date, 'now', () => fixed);
  const sequence = [0.5, 0.25, 0.25, 0.75];
  let random = () => sequence.shift() ?? 0.8;
  t.mock.method(Math, 'random', () => random());
  const decision = graph.addDecision({ project: 'alpha', title: 'Sibling collision', chosen: 'A', alternatives: [{ label: 'B' }, { label: 'C' }] });
  assert.notEqual(decision.alternatives[0].id, decision.alternatives[1].id);
  const before = snap(graph); let n = 0;
  random = () => n++ === 0 ? 0.2 : 0.25;
  assert.throws(() => graph.applyMemoryPlan({ project: 'alpha', operations: [
    { action: 'ADD', memoryType: 'note', key: 'first', text: 'Must roll back' },
    { action: 'ADD', memoryType: 'note', key: 'second', text: 'Exhausted' }
  ] }), error => error.code === 'entity_id_allocation_failed');
  assert.deepEqual(snap(graph), before);
});
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

for (const backend of ['json', 'sqlite']) test(`creation policy ${backend} preflights the entire MCP batch before any member writes`, backendOptions(backend), async t => {
  const dir = await mkdtemp(join(tmpdir(), 'creation-batch-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const occupied of [true, false]) {
    const f = fixture(occupied), file = join(dir, `${occupied}.${backend === 'sqlite' ? 'db' : 'json'}`);
    const store = await createStorage({ type: backend, file }); await store.save(snap(f.graph)); const before = await store.load(); await store.close();
    const calls = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } },
      [
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'shadowgraph_record_decision', arguments: { project: 'alpha', title: 'Must not commit', chosen: 'A' } } },
        { jsonrpc: '2.0', method: 'tools/call', params: { name: 'shadowgraph_record_attempt', arguments: { project: 'alpha', solution: 'Notification must not commit', result: 'failed' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { _meta: meta, name: 'shadowgraph_remember', arguments: { project: 'alpha', operations: [{ action: 'ADD', memoryType: 'note', key: 'late', text: 'No', id: target }] } } }
      ]
    ];
    const run = spawnSync(process.execPath, [join(repo, 'src/mcp.js')], { cwd: dir, env: envFor(file, backend), input: calls.map(x => JSON.stringify(x)).join('\n') + '\n', encoding: 'utf8', timeout: 20000 });
    assert.ifError(run.error); assert.equal(run.status, 0, run.stderr);
    const reopened = await createStorage({ type: backend, file }); assert.deepEqual(await reopened.load(), before); await reopened.close();
    const replies = run.stdout.trim().split(/\r?\n/).map(JSON.parse)[1];
    assert.equal(replies.length, 2); assert.equal(replies[0].error.code, -32000); assert.equal(replies[1].result.isError, true);
    assert.match(replies[0].error.message, /Caller-supplied creation IDs/); assert.match(replies[1].result.content[0].text, /Caller-supplied creation IDs/);
  }
});
for (const backend of ['json', 'sqlite']) for (const surface of ['cli', 'http', 'mcp-legacy', 'mcp-modern', 'mcp-legacy-compact', 'mcp-modern-compact']) for (const arm of arms) {
  test(`creation policy ${backend}/${surface}/${arm[0]} paired refusal and ${surface.endsWith('-compact') && arm[0] === 'relation' ? 'catalog absence control' : 'generated success'}`, backendOptions(backend), async t => {
    const dir = await mkdtemp(join(tmpdir(), 'creation-policy-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const outcomes = [];
    for (const occupied of [true, false]) {
      const f = fixture(occupied), file = join(dir, `${occupied}.${backend === 'sqlite' ? 'db' : 'json'}`);
      const store = await createStorage({ type: backend, file }); await store.save(snap(f.graph)); const before = await store.load(); await store.close();
      const invoke = async input => {
        if (surface === 'http') {
          const live = await createStorage({ type: backend, file });
          const app = await createShadowGraphServer({ store: live, cwd: dir, apiToken: 'synthetic-policy-token', now: clock });
          await new Promise(done => app.server.listen(0, '127.0.0.1', done));
          try {
            const response = await fetch(`http://127.0.0.1:${app.server.address().port}${arm[3]}`, { method: 'POST', headers: { Authorization: 'Bearer synthetic-policy-token', 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
            return { failed: !response.ok, status: response.status, value: await response.json() };
          } finally { await new Promise(done => app.server.close(done)); await live.close(); }
        }
        const args = surface === 'cli' ? [join(repo, 'src/cli.js'), arm[2], JSON.stringify(input)] : [join(repo, 'src/mcp.js')];
        const messages = surface.startsWith('mcp-legacy') ? [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } }] : [];
        messages.push({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: arm[4], arguments: input, ...(surface.startsWith('mcp-modern') ? { _meta: meta } : {}) } });
        const run = spawnSync(process.execPath, args, { cwd: dir, env: envFor(file, backend, surface.endsWith('-compact')), input: surface === 'cli' ? undefined : messages.map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8', timeout: 20000 });
        assert.ifError(run.error);
        if (surface === 'cli') return {
          failed: run.status !== 0, status: run.status, value: run.status ? run.stderr.trim() : JSON.parse(run.stdout),
          cli: { status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr }
        };
        assert.equal(run.status, 0, run.stderr);
        const response = run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)).find(x => x.id === 2);
        assert.ok(response);
        return { failed: Boolean(response.error || response.result?.isError), value: response.error ?? (response.result?.isError ? response.result.content : response.result.structuredContent ?? JSON.parse(response.result.content[0].text)) };
      };
      const rejected = await invoke(inputFor(arm, f)); outcomes.push(rejected);
      if (surface.endsWith('-compact') && arm[0] === 'relation') {
        assert.equal(rejected.failed, true); assert.equal(rejected.value.message, 'Unknown tool');
        assert.deepEqual(await invoke(inputFor(arm, f, false)), rejected);
        const reopened = await createStorage({ type: backend, file }); assert.deepEqual(await reopened.load(), before); await reopened.close();
        continue;
      }
      assert.equal(rejected.failed, true); assert.match(JSON.stringify(rejected.value), /creation_id_not_allowed|Caller-supplied creation IDs are not supported/);
      const reopened = await createStorage({ type: backend, file }); assert.deepEqual(await reopened.load(), before); await reopened.close();
      const created = await invoke(inputFor(arm, f, false)); assert.equal(created.failed, false, JSON.stringify(created));
      const id = resultId(arm, created.value); assert.equal(typeof id, 'string'); assert.notEqual(id, target);
      const persisted = await createStorage({ type: backend, file }); const payload = await persisted.load(); await persisted.close();
      const restored = createShadowGraph({ now: clock }); restored.importData(payload);
      if (arm[0] === 'relation') assert.ok(restored.traverse({ project: 'alpha', id: f.from }).relations.some(r => r.id === id));
      else assert.ok(restored.traverse({ project: 'alpha', id }).nodes.length);
      assert.equal(privilegedValidate(restored).valid, true);
    }
    if (surface === 'cli') {
      t.diagnostic(`Raw CLI parity: ${JSON.stringify({ occupied: outcomes[0].cli, absent: outcomes[1].cli })}`);
      assertCliOutcomeEqual(outcomes[0].cli, outcomes[1].cli);
    } else assert.deepEqual(outcomes[0], outcomes[1]);
  });
}

for (const backend of ['json', 'sqlite']) test(`creation policy ${backend} preserves historical identities through backup/restore/replay`, backendOptions(backend), async t => {
  const dir = await mkdtemp(join(tmpdir(), 'creation-preserve-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixture(true, 'alternative'), g = f.graph;
  const input = { project: 'alpha', title: 'Retry', chosen: 'A', idempotencyKey: 'separate-operation' };
  const d = g.addDecision(input); g.link({ project: 'alpha', from: f.from, to: d.id, relation: 'supports' });
  const original = snap(g), file = join(dir, `store.${backend === 'sqlite' ? 'db' : 'json'}`), backup = join(dir, 'backup');
  const store = await createStorage({ type: backend, file }); await store.save(original); await backupFile(file, backup, { store });
  if (backend === 'sqlite') await store.restore(backup); else await restoreFile(backup, file);
  const restored = createShadowGraph({ now: clock }); restored.importData(await store.load()); await store.close();
  for (const collection of ['records', 'facts', 'relations', 'idempotency', 'journal']) assert.deepEqual(snap(restored)[collection], original[collection]);
  assert.equal(restored.addDecision(input).id, d.id); assert.notEqual(d.id, input.idempotencyKey);
  assert.equal(privilegedRebuild(restored).rebuildable, true);
});
