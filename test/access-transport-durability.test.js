import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { createShadowGraphServer } from '../src/server.js';
import { privilegedSnapshot, privilegedIssueAccess, privilegedBindProject } from '../src/internal/snapshot.js';
import { accessContext, bindWorkspaceProject, currentAccessOperation, discoverWorkspace } from '../src/internal/access-transport.js';
import { createFactAttestation } from '../src/verification.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const bounds = { scope: { projects: ['beta'] }, surfaces: ['cli', 'mcp', 'http'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'synthetic transport durability' };
const projects = (value) => value.items.map((hit) => hit.record.project).sort();

async function fixture(t, backend, type = 'grant') {
  if (backend === 'sqlite') {
    try { await import('node:sqlite'); } catch { t.skip('node:sqlite unavailable on this runtime'); return null; }
  }
  const directory = await scratchDirectory(t, 'access-durable-');
  const file = join(directory, backend === 'sqlite' ? 'data.db' : 'data.json');
  const store = await createStorage({ type: backend, file, staleLockMs: 1 });
  t.after(() => store.close());
  const graph = createShadowGraph();
  graph.addDecision({ project: 'alpha', title: 'marker own', chosen: 'a' });
  graph.addDecision({ project: 'beta', title: 'marker foreign', chosen: 'b' });
  const issued = privilegedIssueAccess(graph, { ...bounds, type, issuanceLimit: 2, surface: 'cli' });
  await store.save(privilegedSnapshot(graph));
  return { directory, file, store, graph, accessId: issued.entry.accessId };
}

function startMcp(t, file, backend, extraEnv = {}, cwd = root) {
  const child = spawn(process.execPath, [join(root, 'src/mcp.js')], { cwd, env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: backend, SHADOWGRAPH_MCP_COMPACT: '0', SHADOWGRAPH_EMBEDDING_URL: '', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '', stderr = '', nextId = 1;
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const response = JSON.parse(line);
      pending.get(response.id)?.resolve(response);
      pending.delete(response.id);
    }
  });
  const rejectAll = (error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  child.on('error', rejectAll);
  child.on('exit', (code) => rejectAll(new Error(`MCP exited ${code}: ${stderr}`)));
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${stderr}`)); }, 10_000);
    pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function toolValue(response) {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return JSON.parse(response.result.content[0].text);
}

test('PR12 MCP bind writes a local confirmed signal and explicit attribution preserves material', async (t) => {
  const f = await fixture(t, 'json');
  const rpc = startMcp(t, f.file, 'json', {}, f.directory);
  const call = async (name, args) => toolValue(await rpc('tools/call', { name, arguments: args }));
  const first = await call('shadowgraph_bind', { type: 'worktree', project: 'alpha', reason: 'explicit synthetic mapping', path: '/ignored-caller-path' });
  const file = join(f.directory, '.shadowgraph', 'project-binding.json');
  assert.equal(first.bindingFile, file);
  const before = await readFile(file, 'utf8');
  assert.equal(JSON.parse(before).project, 'alpha');
  assert.deepEqual(projects(await call('shadowgraph_retrieve', { query: 'marker' })), ['alpha']);
  const changed = await call('shadowgraph_bind', { type: 'worktree', project: 'beta', reason: 'explicit synthetic rebind' });
  assert.equal(await readFile(changed.backupFile, 'utf8'), before);
  assert.deepEqual(projects(await call('shadowgraph_retrieve', { query: 'marker' })), ['beta']);
  const durable = await f.store.load();
  const confirmation = durable.events.find((event) => event.type === 'project.bound');
  assert.equal(confirmation.surface, 'mcp');
  assert.equal(confirmation.mode, 'confirmation');
  assert.equal(confirmation.activationSignal, 'local_binding_file');
  const selected = durable.records.find((record) => record.project === 'beta');
  await call('shadowgraph_attribute', { ids: [selected.id], targetProject: 'gamma', reason: 'explicit synthetic reassignment' });
  const after = await f.store.load();
  const attributed = after.records.find((record) => record.id === selected.id);
  assert.equal(attributed.project, 'gamma');
  for (const field of ['title', 'chosen', 'sourceClass', 'createdAt']) assert.deepEqual(attributed[field], selected[field]);
  assert.ok((await rpc('tools/call', { name: 'shadowgraph_attribute', arguments: { ids: [selected.id], targetProject: 'alpha', reason: 'not grant-authorized', accessId: f.accessId } })).error);
});

test('PR12 binding files resolve worktree before shared mapping and fail closed on malformed local signal', async (t) => {
  const f = await fixture(t, 'json');
  const workspace = { worktreeRoot: f.directory, commonDir: join(f.directory, 'synthetic-common') };
  const context = () => accessContext(f.graph, { binding: { project: 'forged', confirmed: true }, surface: 'forged' }, 'mcp', workspace);
  assert.deepEqual(context(), { surface: 'mcp' });
  await assert.rejects(stat(join(f.directory, '.shadowgraph')), { code: 'ENOENT' });
  await bindWorkspaceProject(f.graph, f.store, workspace, { type: 'shared_repository', project: 'shared', reason: 'explicit shared fixture', surface: 'cli' });
  assert.equal(context().binding.project, 'shared');
  const local = await bindWorkspaceProject(f.graph, f.store, workspace, { type: 'worktree', project: 'individual', reason: 'explicit local fixture', surface: 'cli' });
  assert.equal(context().binding.project, 'individual');
  await writeFile(local.bindingFile, '{');
  assert.equal(context().binding, undefined, 'malformed local signal cannot fall back to wider repository binding');
  await unlink(local.bindingFile);
  assert.equal(context().binding.project, 'shared');
});

test('PR12 failed binding file activation leaves only an explicit confirmation audit', async (t) => {
  const f = await fixture(t, 'json');
  const occupied = join(f.directory, 'occupied-workspace');
  await writeFile(occupied, 'existing synthetic file');
  const workspace = { worktreeRoot: occupied, commonDir: null };
  await assert.rejects(bindWorkspaceProject(f.graph, f.store, workspace, { type: 'worktree', project: 'inactive', reason: 'synthetic activation failure', surface: 'mcp' }));
  assert.equal(await readFile(occupied, 'utf8'), 'existing synthetic file');
  assert.equal(accessContext(f.graph, {}, 'mcp', workspace).binding, undefined);
  const confirmation = (await f.store.load()).events.find((event) => event.type === 'project.bound');
  assert.equal(confirmation.mode, 'confirmation');
  assert.equal(confirmation.boundProject, 'inactive');
  assert.equal(confirmation.surface, 'mcp');
});

test('PR12 MCP binding activation failure saves confirmation once and leaves the call queue usable', async (t) => {
  const f = await fixture(t, 'json');
  await writeFile(join(f.directory, '.shadowgraph'), 'synthetic occupied configuration path');
  const before = await f.store.load();
  const rpc = startMcp(t, f.file, 'json', {}, f.directory);
  const refused = await rpc('tools/call', { name: 'shadowgraph_bind', arguments: { type: 'worktree', project: 'alpha', reason: 'synthetic activation failure' } });
  assert.ok(refused.error);
  const after = await f.store.load();
  assert.equal(after.revision, before.revision + 1, 'only the confirmation save commits');
  assert.equal(after.events.filter((event) => event.type === 'project.bound').length, 1);
  const unbound = toolValue(await rpc('tools/call', { name: 'shadowgraph_retrieve', arguments: { query: 'marker' } }));
  assert.deepEqual(unbound.items, []);
  const own = toolValue(await rpc('tools/call', { name: 'shadowgraph_retrieve', arguments: { project: 'alpha', query: 'marker' } }));
  assert.deepEqual(projects(own), ['alpha']);
  assert.equal((await f.store.load()).revision, after.revision);
});

for (const backend of ['json', 'sqlite']) {
  test(`PR12 long-lived MCP reloads external revocation and does not accept caller surface or binding (${backend})`, async (t) => {
    const f = await fixture(t, backend);
    if (!f) return;
    const rpc = startMcp(t, f.file, backend);
    const call = (name, args) => rpc('tools/call', { name, arguments: args });
    await rpc('tools/list');
    const forged = toolValue(await call('shadowgraph_retrieve', { query: 'marker', binding: { confirmed: true, project: 'beta' } }));
    assert.deepEqual(forged.items, []);
    const widened = toolValue(await call('shadowgraph_retrieve', { query: 'marker', project: 'alpha', grantId: f.accessId }));
    assert.deepEqual(projects(widened), ['alpha', 'beta']);
    assert.equal((await f.store.load()).events.find((event) => event.type === 'access.used').surface, 'mcp');
    const revoked = spawnSync(process.execPath, [join(root, 'src/cli.js'), 'revoke-access', JSON.stringify({ accessId: f.accessId })], { cwd: root, env: { ...process.env, SHADOWGRAPH_FILE: f.file, SHADOWGRAPH_STORAGE: backend }, encoding: 'utf8' });
    assert.equal(revoked.status, 0, revoked.stderr);
    const narrowed = toolValue(await call('shadowgraph_retrieve', { query: 'marker', readProvenance: widened.readProvenance, surface: 'cli' }));
    assert.deepEqual(projects(narrowed), ['alpha']);
    assert.equal(narrowed.completeness.scope.grant, null);
    const refused = (await f.store.load()).events.find((event) => event.type === 'access.refused');
    assert.equal(refused.surface, 'mcp');
    for (const name of ['shadowgraph_issue_access', 'shadowgraph_delegate_access', 'shadowgraph_import']) {
      assert.ok((await call(name, { ...bounds, ownerConfirmation: true })).error);
    }
    assert.equal((await f.store.load()).events.find((event) => event.reason === 'issuance_surface_unavailable').count, 3);
  });

  test(`PR12 long-lived MCP expires inherited grant provenance on the next operation (${backend})`, async (t) => {
    const f = await fixture(t, backend);
    if (!f) return;
    const clockFile = join(f.directory, 'clock.txt');
    await writeFile(clockFile, '2098-12-31T23:59:59.000Z');
    const rpc = startMcp(t, f.file, backend, { NODE_ENV: 'test', SHADOWGRAPH_TEST_CLOCK_FILE: clockFile });
    const read = (args) => rpc('tools/call', { name: 'shadowgraph_retrieve', arguments: { query: 'marker', ...args } });
    const first = toolValue(await read({ project: 'alpha', grantId: f.accessId }));
    assert.deepEqual(projects(first), ['alpha', 'beta']);
    await writeFile(clockFile, bounds.expiresAt);
    const expired = toolValue(await read({ readProvenance: first.readProvenance }));
    assert.deepEqual(projects(expired), ['alpha']);
    assert.equal(expired.completeness.scope.grant, null);
    assert.equal((await f.store.load()).events.find((event) => event.type === 'access.refused').reason, 'grant_expired');
  });

  test(`PR12 MCP delivers no grant read before the audit commits and reloads after save failure (${backend})`, async (t) => {
    const f = await fixture(t, backend);
    if (!f) return;
    const before = await f.store.load();
    const faultFile = join(f.directory, 'fault.txt');
    await writeFile(faultFile, 'beforeCommit');
    const rpc = startMcp(t, f.file, backend, { NODE_ENV: 'test', SHADOWGRAPH_TEST_SAVE_FAULT_FILE: faultFile });
    const params = { name: 'shadowgraph_retrieve', arguments: { query: 'marker', project: 'alpha', accessId: f.accessId } };
    const failed = await rpc('tools/call', params);
    assert.ok(failed.error);
    assert.equal(failed.result, undefined);
    assert.deepEqual(await f.store.load(), before);
    assert.deepEqual(projects(toolValue(await rpc('tools/call', params))), ['alpha', 'beta']);
    assert.equal((await f.store.load()).events.find((event) => event.type === 'access.used').count, 1);
  });

  test(`PR12 HTTP delivers no grant read before the audit commits and rechecks revocation after rollback (${backend})`, async (t) => {
    const f = await fixture(t, backend);
    if (!f) return;
    const before = await f.store.load();
    let fail = true;
    const failing = await createStorage({ type: backend, file: f.file, saveFault(stage) { if (fail && stage === 'beforeCommit') throw new Error('synthetic audit commit failure'); } });
    t.after(() => failing.close());
    const app = await createShadowGraphServer({ store: failing });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => app.server.close(resolve)));
    const endpoint = `http://127.0.0.1:${app.server.address().port}/retrieve`;
    const read = () => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'marker', project: 'alpha', accessId: f.accessId }) });
    const response = await read();
    assert.notEqual(response.status, 200);
    assert.equal(JSON.stringify(await response.json()).includes('marker foreign'), false);
    assert.deepEqual(await f.store.load(), before);
    await currentAccessOperation(f.graph, f.store, () => f.graph.revokeAccess({ accessId: f.accessId }));
    fail = false;
    const next = await read();
    assert.equal(next.status, 200);
    assert.deepEqual(projects(await next.json()), ['alpha']);
  });

  test(`PR12 delegated issuance rolls back before commit and retains consumed budget after uncertain commit (${backend})`, async (t) => {
    const f = await fixture(t, backend, 'delegation');
    if (!f) return;
    const input = { ...bounds, delegationId: f.accessId, idempotencyKey: 'durable-retry', surface: 'cli' };
    const before = await f.store.load();
    for (const stage of ['beforeCommit', 'afterCommit']) {
      const failing = await createStorage({ type: backend, file: f.file, saveFault(at) { if (at === stage) throw new Error(`synthetic ${stage}`); } });
      try { await assert.rejects(currentAccessOperation(f.graph, failing, () => f.graph.issueAccess(input)), new RegExp(stage)); }
      finally { failing.close(); }
      const durable = await f.store.load();
      assert.deepEqual(privilegedSnapshot(f.graph), durable);
      if (stage === 'beforeCommit') assert.deepEqual(durable, before);
      else {
        assert.equal(durable.access.entries.filter((entry) => entry.type === 'grant').length, 1);
        assert.equal(durable.access.entries.find((entry) => entry.type === 'delegation').issuanceConsumed, 1);
      }
    }
    const retried = await currentAccessOperation(f.graph, f.store, () => f.graph.issueAccess(input));
    assert.equal(retried.replayed, true);
    assert.equal((await f.store.load()).access.entries.find((entry) => entry.type === 'delegation').issuanceConsumed, 1);
  });

  test(`PR12 a revocation winning the read-save race forces a fresh bounded result (${backend})`, async (t) => {
    const f = await fixture(t, backend);
    if (!f) return;
    const revoker = createShadowGraph();
    const other = await createStorage({ type: backend, file: f.file });
    t.after(() => other.close());
    let conflicted = false;
    const racing = { load: () => f.store.load(), async save(payload) {
      if (!conflicted) {
        conflicted = true;
        await currentAccessOperation(revoker, other, () => revoker.revokeAccess({ accessId: f.accessId }));
      }
      return f.store.save(payload);
    } };
    const result = await currentAccessOperation(f.graph, racing, () => f.graph.retrieve('marker', { project: 'alpha', accessId: f.accessId, surface: 'http' }));
    assert.equal(conflicted, true);
    assert.deepEqual(projects(result), ['alpha']);
    const durable = await f.store.load();
    assert.equal(durable.events.filter((event) => event.type === 'access.used').length, 0, 'the losing read was never delivered or counted');
    assert.equal(durable.events.find((event) => event.type === 'access.refused').count, 1);
  });

  test(`PR12 failed grant-bearing by-ID reads durably audit refusal on CLI HTTP and MCP (${backend})`, async (t) => {
    const f = await fixture(t, backend);
    if (!f) return;
    const before = await f.store.load();
    const args = { project: 'alpha', accessId: 'absent-access', decisionId: before.records.find((record) => record.project === 'beta').id };
    const cli = spawnSync(process.execPath, [join(root, 'src/cli.js'), 'reconsider', JSON.stringify(args)], { cwd: root, env: { ...process.env, SHADOWGRAPH_FILE: f.file, SHADOWGRAPH_STORAGE: backend }, encoding: 'utf8' });
    assert.notEqual(cli.status, 0);
    const rpc = startMcp(t, f.file, backend);
    assert.ok((await rpc('tools/call', { name: 'shadowgraph_reconsider', arguments: args })).error);
    const app = await createShadowGraphServer({ store: f.store });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => app.server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/reconsider`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
    assert.equal(response.status, 404);
    const durable = await f.store.load();
    const refusals = durable.events.filter((event) => event.type === 'access.refused');
    assert.deepEqual(refusals.map((event) => event.surface).sort(), ['cli', 'http', 'mcp']);
    assert.ok(refusals.every((event) => event.count === 1 && event.recordsReturnedTotal === 0));
    for (const key of ['records', 'facts', 'relations', 'reviewSignals', 'journal', 'access', 'accessRevocations']) assert.deepEqual(durable[key], before[key], key);
    assert.equal(durable.revision, before.revision + 3);
  });

  test(`PR12 a process exit before delegated commit leaves neither grant nor budget consumption (${backend})`, async (t) => {
    const f = await fixture(t, backend, 'delegation');
    if (!f) return;
    const before = await f.store.load();
    const script = `
      import { createStorage } from ${JSON.stringify(new URL('../src/storage.js', import.meta.url).href)};
      import { createShadowGraph } from ${JSON.stringify(new URL('../src/shadowgraph.js', import.meta.url).href)};
      import { currentAccessOperation } from ${JSON.stringify(new URL('../src/internal/access-transport.js', import.meta.url).href)};
      const [backend, file, raw] = process.argv.slice(1);
      const store = await createStorage({ type: backend, file, saveFault(stage, { payload }) {
        if (stage !== 'beforeCommit') return;
        const grant = payload.access.entries.find(entry => entry.type === 'grant');
        const parent = payload.access.entries.find(entry => entry.type === 'delegation');
        if (!grant || parent.issuanceConsumed !== 1 || !payload.events.some(event => event.id === grant.issuanceEventId)) process.exit(78);
        process.exit(77);
      } });
      const graph = createShadowGraph();
      await currentAccessOperation(graph, store, () => graph.issueAccess(JSON.parse(raw)));
    `;
    const input = { ...bounds, delegationId: f.accessId, surface: 'cli', idempotencyKey: 'crash-retry' };
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script, backend, f.file, JSON.stringify(input)], { encoding: 'utf8' });
    assert.equal(crashed.status, 77, crashed.stderr);
    assert.deepEqual(await f.store.load(), before);
    const retry = await currentAccessOperation(f.graph, f.store, () => f.graph.issueAccess(input));
    assert.equal(retry.ok, true);
    const durable = await f.store.load();
    assert.equal(durable.access.entries.filter((entry) => entry.type === 'grant').length, 1);
    assert.equal(durable.access.entries.find((entry) => entry.type === 'delegation').issuanceConsumed, 1);
  });
}

test('PR12 HTTP and MCP scope-aware writes use the runtime confirmed mapping', async (t) => {
  const f = await fixture(t, 'json');
  const workspace = await discoverWorkspace(f.directory);
  await bindWorkspaceProject(f.graph, f.store, workspace, { type: 'worktree', project: 'alpha', reason: 'explicit fixture' });
  const value = { title: 'bound write', chosen: 'a', binding: { confirmed: true, project: 'spoofed' }, surface: 'cli' };
  const app = await createShadowGraphServer({ store: f.store, cwd: f.directory });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).project, 'alpha');
  const rpc = startMcp(t, f.file, 'json', {}, f.directory);
  assert.equal(toolValue(await rpc('tools/call', { name: 'shadowgraph_record_decision', arguments: value })).project, 'alpha');
});

test('PR12 MCP verification receives only its strict input plus the confirmed project binding', async (t) => {
  const f = await fixture(t, 'json');
  const workspace = await discoverWorkspace(f.directory);
  let fact;
  await currentAccessOperation(f.graph, f.store, () => {
    privilegedBindProject(f.graph, { type: 'worktree', path: workspace.worktreeRoot, project: 'alpha' });
    fact = f.graph.addFact({ project: 'alpha', key: 'bound-verification', value: true });
  });
  await bindWorkspaceProject(f.graph, f.store, workspace, { type: 'worktree', project: 'alpha', reason: 'explicit fixture' });
  const keys = generateKeyPairSync('ed25519');
  const configPath = join(f.directory, 'verifier.json');
  const evidencePath = join(f.directory, 'signed.json');
  await writeFile(configPath, JSON.stringify({ allowedEvidenceRoot: f.directory, trustedVerifiers: { approver: keys.publicKey.export({ type: 'spki', format: 'pem' }) } }));
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({ fact, verifierIdentity: 'approver', evidenceReference: 'synthetic:binding', verifiedAt: new Date().toISOString(), privateKey: keys.privateKey })));
  const rpc = startMcp(t, f.file, 'json', { SHADOWGRAPH_VERIFIER_CONFIG: configPath }, f.directory);
  const response = toolValue(await rpc('tools/call', { name: 'shadowgraph_verify_fact', arguments: { factId: fact.id, evidencePath, binding: { confirmed: true, project: 'beta' }, surface: 'cli' } }));
  assert.equal(response.operation, 'VERIFIED');
  assert.equal(response.fact.project, 'alpha');
});
