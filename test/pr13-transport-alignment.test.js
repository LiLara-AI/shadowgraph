import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { createShadowGraphServer } from '../src/server.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { buildToolCatalog } from '../src/mcp-tools.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { assertCliOutcomeEqual } from '../tools/assert-cli-outcome.js';

const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mcpPath = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
const names = {
  outcome: ['outcome', '/outcomes', 'shadowgraph_record_outcome'],
  status: ['status', '/status', 'shadowgraph_update_status'],
  ack: ['ack', '/review-signals/ack', 'shadowgraph_ack_review'],
  validate: ['validate', '/validate', 'shadowgraph_validate'],
  repair: ['repair-plan', '/repair-plan', 'shadowgraph_repair_plan'],
  stats: ['stats', '/stats'],
  link: ['link', '/relationships', 'shadowgraph_link'],
  evidence: ['confidence-evidence', '/confidence-evidence', 'shadowgraph_confidence_evidence'],
  supersede: ['supersede', '/supersede', 'shadowgraph_supersede'],
  restore: ['restore', '/restore', 'shadowgraph_restore']
};

async function fixture(t, backend, { invalid = false, authority = false } = {}) {
  if (backend === 'sqlite' && !(await getRuntimeCapabilities()).nodeSqlite.available) { t.skip('node:sqlite is unavailable'); return null; }
  const directory = await scratchDirectory(t, 'pr13-transport-');
  const file = join(directory, backend === 'sqlite' ? 'store.db' : 'store.json');
  const graph = createShadowGraph();
  const owners = [{ project: 'alpha' }, { originId: 'origin-alpha' }, { project: 'beta' }];
  const records = owners.map((owner, index) => graph.addDecision({ ...owner, title: `decision-${index}`, chosen: 'A', reviewAfter: '2020-01-01T00:00:00.000Z' }));
  const replacements = owners.map((owner, index) => graph.addDecision({ ...owner, title: `replacement-${index}`, chosen: 'B' }));
  const signals = owners.map(owner => graph.review(owner).items[0].reviewSignalId);
  const payload = privilegedSnapshot(graph);
  if (invalid) for (const record of payload.records) record.status = 'invalid-status';
  if (authority) {
    payload.access = { lineageId: 'historical', entries: [] };
    payload.accessRevocations = { lineageId: 'historical', ledgerSeq: 0, entries: [] };
    payload.futureCollection = { preserved: ['carrier-receipt'] };
  }
  const store = await createStorage({ type: backend, file });
  await store.save(payload);
  store.close();
  return { directory, file, owners, records, replacements, signals, backend };
}

async function connect(t, fixture, surface, { modern = false } = {}) {
  const { file, directory, backend } = fixture;
  const environment = { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: backend, SHADOWGRAPH_API_TOKEN: '', SHADOWGRAPH_EMBEDDING_URL: '', SHADOWGRAPH_VERIFIER_CONFIG: '', SHADOWGRAPH_MCP_COMPACT: '0' };
  if (surface === 'cli') return async (operation, args) => {
    const rest = operation === 'restore' ? [args.source, ...(args.memoryOnly ? ['--memory-only'] : [])] : [JSON.stringify(args)];
    try {
      const { stdout, stderr } = await execute(process.execPath, [cliPath, names[operation][0], ...rest], { cwd: directory, env: environment });
      return { ok: true, value: JSON.parse(stdout), cli: { status: 0, signal: null, stdout, stderr } };
    } catch (error) {
      return { ok: false, error: error.stderr, cli: { status: error.code, signal: error.signal, stdout: error.stdout, stderr: error.stderr } };
    }
  };
  if (surface === 'http') {
    const app = await createShadowGraphServer({ file, storage: backend, cwd: directory, apiToken: '' });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    t.after(() => new Promise(resolve => app.server.close(resolve)));
    return async (operation, args) => {
      const get = ['stats', 'validate'].includes(operation);
      const path = names[operation][1] + (get ? `?${new URLSearchParams(args)}` : '');
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: get ? 'GET' : 'POST', ...(get ? {} : { body: JSON.stringify(args) }) });
      return { ok: response.ok, value: await response.json() };
    };
  }
  const child = spawn(process.execPath, [mcpPath], { cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let buffer = '', stderr = '', nextId = 0;
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffer += data;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) { const value = JSON.parse(line); const target = pending.get(value.id); if (target) { clearTimeout(target.timer); pending.delete(value.id); target.resolve(value); } }
  });
  child.on('exit', () => { for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(`MCP exited: ${stderr}`)); } pending.clear(); });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}; ${stderr}`)), 15000);
    pending.set(id, { resolve, reject, timer });
    const meta = modern && method !== 'initialize' ? { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } : {};
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, ...meta } })}\n`);
  });
  if (!modern) await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  const call = async (operation, args) => {
    const response = await rpc('tools/call', { name: names[operation][2], arguments: args });
    const ok = !response.error && response.result?.isError !== true;
    return { ok, ...(ok ? { value: JSON.parse(response.result.content[0].text) } : { error: response.error ?? response.result }) };
  };
  call.resource = async () => { const response = await rpc('resources/read', { uri: 'shadowgraph://context' }); assert.equal(response.error, undefined); return JSON.parse(response.result.contents[0].text); };
  return call;
}

for (const backend of ['json', 'sqlite']) for (const surface of ['cli', 'http', 'mcp']) {
  test(`PR13 F35 ${backend}/${surface}: explicit project and origin write scope reaches existing records`, async t => {
    const state = await fixture(t, backend); if (!state) return;
    const call = await connect(t, state, surface);
    for (const index of [0, 1]) {
      const owner = state.owners[index], decisionId = state.records[index].id;
      for (const [operation, args, verify] of [
        ['outcome', { decisionId, outcome: { status: 'successful' } }, value => assert.equal(value.outcome.status, 'successful')],
        ['status', { decisionId, status: 'planned' }, value => assert.equal(value.status, 'planned')],
        ['ack', { id: state.signals[index] }, value => assert.equal(value.status, 'acknowledged')],
        ['evidence', { decisionId, key: 'observed', reason: 'new evidence' }, value => assert.equal(value.id, decisionId)],
        ['link', { from: decisionId, to: state.replacements[index].id, relation: 'informs' }, value => assert.ok(value.id)],
        ['supersede', { decisionId, replacementId: state.replacements[index].id }, value => assert.equal(value.previous.status, 'superseded')]
      ]) {
        await t.test(`${index}/${operation}`, async () => {
          const result = await call(operation, { ...owner, ...args });
          assert.equal(result.ok, true, `${operation}: ${JSON.stringify(result)}`); verify(result.value);
        });
      }
      const outside = await call('status', { ...owner, decisionId: state.records[2].id, status: 'planned' });
      const absent = await call('status', { ...owner, decisionId: 'absent-reference', status: 'planned' });
      assert.equal(outside.ok, false);
      if (surface === 'cli') {
        t.diagnostic(`Raw CLI parity: ${JSON.stringify({ occupied: outside.cli, absent: absent.cli })}`);
        assertCliOutcomeEqual(outside.cli, absent.cli);
      } else assert.deepEqual(outside, absent);
    }
  });
  test(`PR13 F35 ${backend}/${surface}: ordinary diagnostics preserve caller scope`, async t => {
    const state = await fixture(t, backend, { invalid: true }); if (!state) return;
    const call = await connect(t, state, surface);
    for (const index of [0, 1]) {
      const owner = state.owners[index];
      await t.test(`${index}/validate`, async () => {
        const validation = await call('validate', owner);
        assert.equal(validation.ok, true); assert.equal(validation.value.issues.length, 2);
        assert.deepEqual(new Set(validation.value.issues.map(item => item.recordId)), new Set([state.records[index].id, state.replacements[index].id]));
      });
      await t.test(`${index}/repair`, async () => { const repair = await call('repair', owner); assert.equal(repair.ok, true); assert.equal(repair.value.actions.length, 2); });
      if (surface !== 'mcp') await t.test(`${index}/stats`, async () => { const stats = await call('stats', owner); assert.equal(stats.value.decisions, 2); });
    }
  });
}

for (const backend of ['json', 'sqlite']) for (const surface of ['http', 'mcp']) {
  test(`PR13 F20 ${backend}/${surface}: memory-only restore installs records without authority`, async t => {
    const state = await fixture(t, backend); if (!state) return;
    const backup = await fixture(t, backend, { authority: true });
    const call = await connect(t, state, surface);
    const result = await call('restore', { source: backup.file, memoryOnly: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    const store = await createStorage({ type: backend, file: state.file });
    const payload = await store.load(); store.close();
    assert.equal(Object.hasOwn(payload, 'access'), false); assert.equal(Object.hasOwn(payload, 'accessRevocations'), false);
    assert.deepEqual(payload.records.map(item => item.id), [...backup.records, ...backup.replacements].map(item => item.id));
    assert.deepEqual(payload.futureCollection, { preserved: ['carrier-receipt'] });
    const updated = await call('status', { project: 'alpha', decisionId: backup.records[0].id, status: 'planned' });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    const reopened = await createStorage({ type: backend, file: state.file });
    const saved = await reopened.load(); reopened.close();
    assert.deepEqual(saved.futureCollection, payload.futureCollection);
    assert.equal(Object.hasOwn(saved, 'access'), false); assert.equal(Object.hasOwn(saved, 'accessRevocations'), false);
    assert.equal(saved.schemaVersion, payload.schemaVersion);
  });
}

for (const modern of [false, true]) test(`PR13 F29 MCP ${modern ? 'modern' : 'legacy'} resource follows current confirmed workspace binding`, async t => {
  const state = await fixture(t, 'json');
  await mkdir(join(state.directory, '.shadowgraph'));
  const bindingPath = join(state.directory, '.shadowgraph', 'project-binding.json');
  const bind = project => writeFile(bindingPath, JSON.stringify({ version: 1, type: 'worktree', path: resolve(state.directory), project, confirmed: true }));
  await bind('alpha');
  const call = await connect(t, state, 'mcp', { modern });
  const alpha = await call.resource(); assert.equal(alpha.project, 'alpha'); assert.equal(alpha.activeDecisions.length, 2);
  await bind('beta');
  const beta = await call.resource(); assert.equal(beta.project, 'beta'); assert.equal(beta.activeDecisions.length, 2);
  assert.ok(beta.activeDecisions.every(item => item.project === 'beta'));
  await writeFile(bindingPath, JSON.stringify({ confirmed: false, project: 'alpha' }));
  const unknown = await call.resource(); assert.equal(unknown.project, null); assert.deepEqual(unknown.activeDecisions, []);
});

test('PR13 F28 existing context schema accepts unresolved project identity', () => {
  const schema = buildToolCatalog().find(tool => tool.name === 'shadowgraph_context').outputSchema;
  assert.ok(schema.properties.project.anyOf.some(branch => branch.type === 'null'));
  assert.equal(createShadowGraph().context().project, null);
});

test('PR13 F32/F35 schemas describe project and origin on scoped writes and reads', () => {
  const tools = new Map(buildToolCatalog({ verifier: true }).map(tool => [tool.name, tool]));
  for (const name of ['shadowgraph_record_outcome', 'shadowgraph_update_status', 'shadowgraph_ack_review', 'shadowgraph_confidence_evidence', 'shadowgraph_supersede', 'shadowgraph_link', 'shadowgraph_verify_fact', 'shadowgraph_validate', 'shadowgraph_repair_plan']) {
    assert.equal(tools.get(name).inputSchema.properties?.project?.type, 'string', name);
    assert.equal(tools.get(name).inputSchema.properties?.originId?.type, 'string', name);
  }
  assert.equal(tools.get('shadowgraph_restore').inputSchema.properties.memoryOnly.type, 'boolean');
  assert.doesNotMatch(tools.get('shadowgraph_traverse').inputSchema.properties.project.description, /not filtered|Defaults to/);
});

test('PR13 F33 schemas forbid canonical creation IDs while reference IDs remain advertised', () => {
  const tools = new Map(buildToolCatalog().map(tool => [tool.name, tool]));
  for (const name of ['shadowgraph_record_decision', 'shadowgraph_record_attempt', 'shadowgraph_record_fact', 'shadowgraph_link']) {
    const schema = tools.get(name).inputSchema;
    assert.equal(schema.properties.id, undefined, name); assert.deepEqual(schema.not, { required: ['id'] }, name);
  }
  const alternative = tools.get('shadowgraph_record_decision').inputSchema.properties.alternatives.items;
  assert.equal(alternative.properties.id, undefined); assert.deepEqual(alternative.not, { required: ['id'] });
  const remember = tools.get('shadowgraph_remember').inputSchema;
  assert.deepEqual(remember.not, { required: ['id'] });
  assert.deepEqual(remember.properties.operations.items.not, { required: ['id'] });
  assert.equal(tools.get('shadowgraph_traverse').inputSchema.properties.id.type, 'string');
  assert.equal(tools.get('shadowgraph_ack_review').inputSchema.properties.id.type, 'string');
});

test('PR13 dashboard forwards explicit project or origin to each same-origin read', async () => {
  const html = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  const elements = new Map(['token', 'project', 'origin', 'load', 'stats', 'signals', 'records'].map(id => [id, { value: '', replaceChildren() {} }]));
  const requested = [];
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: id => elements.get(id), createElement: () => ({}) }, URLSearchParams,
    fetch: async path => { requested.push(path); return { ok: true, json: async () => ({}) }; },
    alert: message => { throw new Error(message); }
  });
  elements.get('project').value = 'alpha & beta';
  await elements.get('load').onclick();
  assert.equal(requested.length, 3);
  assert.ok(requested.every(path => new URL(path, 'http://127.0.0.1').searchParams.get('project') === 'alpha & beta'));
  requested.length = 0; elements.get('project').value = ''; elements.get('origin').value = 'capture-a';
  await elements.get('load').onclick();
  assert.ok(requested.every(path => new URL(path, 'http://127.0.0.1').searchParams.get('originId') === 'capture-a'));
});
