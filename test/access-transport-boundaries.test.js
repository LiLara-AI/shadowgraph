import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { buildToolCatalog } from '../src/mcp-tools.js';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore, createStorage } from '../src/storage.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import * as privileged from '../src/internal/snapshot.js';
import { bindWorkspaceProject, currentAccessOperation, hasAccessReference } from '../src/internal/access-transport.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'src', 'cli.js');
const bounds = { scope: { projects: ['beta'], originIds: [], legacyAttributions: [] }, surfaces: ['cli', 'mcp', 'http'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'synthetic boundary test' };
const runCli = (file, command, value, extraEnv = {}, cwd = root) => spawnSync(process.execPath, [cli, command, JSON.stringify(value)], {
  cwd, encoding: 'utf8', env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json', ...extraEnv }, input: 'yes\n'
});
const runCliAsync = (file, backend, command, value) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli, command, JSON.stringify(value)], { cwd: root, env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: backend }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  child.once('error', reject);
  child.once('exit', (status) => resolve({ status, stdout, stderr }));
  child.stdin.end();
});
const runPtyCli = (file, cwd, command, value, answers, streams = {}) => {
  const helper = fileURLToPath(new URL('./helpers/access-cli-pty.py', import.meta.url));
  const run = spawnSync('python3', [helper, JSON.stringify({ command: [process.execPath, cli, ...(Array.isArray(command) ? command : [command]), ...(value === undefined ? [] : [JSON.stringify(value)])], cwd, env: { SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' }, answers, ...streams })], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
};

test('PR12 CLI non-TTY issuance cannot be approved by input, flags, environment or owner booleans', async (t) => {
  const directory = await scratchDirectory(t, 'access-cli-');
  const file = join(directory, 'data.json');
  for (const command of ['issue-access', 'delegate-access']) {
    const result = runCli(file, command, { ...bounds, issuanceLimit: 2, ownerConfirmation: true, confirmed: true, yes: true }, { SHADOWGRAPH_OWNER_CONFIRMED: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /grant_requires_owner_confirmation/);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    assert.equal((stored.access?.entries ?? []).some((entry) => ['grant', 'delegation'].includes(entry.type)), false);
    assert.ok(stored.events.some((event) => event.type === 'access.refused'));
    for (const malformed of [null, [], 1]) {
      const rejected = runCli(file, command, malformed);
      assert.notEqual(rejected.status, 0);
    }
    assert.equal(JSON.parse(await readFile(file, 'utf8')).events.find((event) => event.reason === 'grant_bounds_invalid')?.count, 3 * (command === 'issue-access' ? 1 : 2));
  }
});

test('PR12 real CLI refuses partial TTY, decline, EOF, invalid expiry and over-broad request issuance', { skip: process.platform === 'win32' ? 'Real PTY coverage runs on Ubuntu WSL; Python pty is unavailable on Windows' : false }, async (t) => {
  const directory = await scratchDirectory(t, 'access-negative-pty-');
  for (const command of ['issue-access', 'delegate-access']) {
    for (const [inputTty, outputTty, answer] of [[true, true, 'no'], [true, true, null], [false, true, 'confirm'], [true, false, 'confirm'], [false, false, 'confirm']]) {
      const file = join(directory, `${command}-${inputTty}-${outputTty}-${answer}.json`);
      const run = runPtyCli(file, directory, command, { ...bounds, issuanceLimit: 1, yes: true, confirmed: true }, inputTty && outputTty ? [{ prompt: 'Type confirm', answer }] : [], { inputTty, outputTty });
      assert.notEqual(run.status, 0, run.output);
      const durable = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(durable.access?.entries?.length ?? 0, 0);
      assert.ok(durable.events.some((event) => event.type === 'access.refused'), run.output);
    }
  }
  for (const expiresAt of [undefined, '2000-01-01T00:00:00.000Z', 'invalid']) {
    const run = runPtyCli(join(directory, 'invalid.json'), directory, 'issue-access', { ...bounds, expiresAt }, []);
    assert.notEqual(run.status, 0, run.output);
    assert.equal(run.answered.length, 0);
  }
  const invalidAudit = JSON.parse(await readFile(join(directory, 'invalid.json'), 'utf8'));
  assert.equal(invalidAudit.events.find((event) => event.reason === 'grant_bounds_invalid').count, 3);
  const file = join(directory, 'proposal.json');
  const request = JSON.parse(runCli(file, 'request-access', bounds).stdout);
  const run = runPtyCli(file, directory, 'issue-access', { ...bounds, requestId: request.accessId, scope: { projects: ['beta', 'gamma'] } }, [{ prompt: 'Type confirm', answer: 'confirm' }]);
  assert.notEqual(run.status, 0, run.output);
  assert.match(run.output, /request_bounds_exceeded/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).access.entries.length, 1);
});

test('PR12 CLI strips caller binding on writes and uses only its confirmed workspace mapping', async (t) => {
  const directory = await scratchDirectory(t, 'access-write-binding-');
  const file = join(directory, 'data.json');
  const value = { title: 'binding write', chosen: 'kept', binding: { confirmed: true, project: 'spoofed' }, surface: 'mcp' };
  const rejected = runCli(file, 'decision', value, {}, directory);
  assert.notEqual(rejected.status, 0, rejected.stdout);
  const graph = createShadowGraph();
  const { discoverWorkspace } = await import('../src/internal/access-transport.js');
  const workspace = await discoverWorkspace(directory);
  privileged.privilegedBindProject(graph, { type: 'worktree', path: workspace.worktreeRoot, project: 'alpha' });
  await createJsonFileStore(file).save(privilegedSnapshot(graph));
  assert.notEqual(runCli(file, 'decision', value, {}, directory).status, 0, 'store-only mapping is not a selection signal');
  await bindWorkspaceProject(graph, createJsonFileStore(file), workspace, { type: 'worktree', project: 'alpha', reason: 'explicit fixture' });
  const saved = runCli(file, 'decision', value, {}, directory);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).project, 'alpha');
});

test('PR12 grantId is recognized as a grant-bearing transport reference', () => {
  assert.equal(hasAccessReference({ grantId: 'example' }), true);
  assert.equal(hasAccessReference({ grantId: null }), true);
});

test('PR12 documented CLI grant request and access discard aliases retain the same confirmation gate', { skip: process.platform === 'win32' ? 'Real PTY coverage runs on Ubuntu WSL; Python pty is unavailable on Windows' : false }, async (t) => {
  const directory = await scratchDirectory(t, 'access-alias-');
  const file = join(directory, 'data.json');
  const request = JSON.parse(runCli(file, 'request-access', bounds).stdout);
  const run = runPtyCli(file, directory, ['grant', '--request', request.accessId], undefined, [{ prompt: 'Type confirm', answer: 'confirm' }]);
  assert.equal(run.status, 0, run.output);
  assert.match(run.answered[0].display, /beta/);
  const grant = JSON.parse(await readFile(file, 'utf8')).access.entries.find((entry) => entry.type === 'grant');
  assert.equal(grant.derivedFrom, request.accessId);
  const discarded = spawnSync(process.execPath, [cli, 'access', 'discard', grant.accessId], { cwd: root, env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' }, encoding: 'utf8' });
  assert.equal(discarded.status, 0, discarded.stderr);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).access.entries.find((entry) => entry.accessId === grant.accessId).state, 'discarded');
  assert.notEqual(runCli(file, 'grant', { ...bounds, confirmed: true }).status, 0);
  assert.notEqual(runCli(file, 'delegate', { ...bounds, issuanceLimit: 1, confirmed: true }).status, 0);
});

test('PR12 MCP advertises proposal and narrowing operations but never an issuer or authority import', () => {
  const catalog = buildToolCatalog();
  for (const name of ['shadowgraph_request_wider_access', 'shadowgraph_revoke_grant', 'shadowgraph_discard_access']) {
    const tool = catalog.find((item) => item.name === name);
    assert.ok(tool, name);
    assert.equal(tool.persists, true);
    assert.equal(tool.annotations.readOnlyHint, false);
  }
  assert.deepEqual(catalog.filter((tool) => /issue|delegate|import|owner_confirmation/.test(tool.name)), []);
});

test('PR12 HTTP proposal is durable, remains unusable, and cannot smuggle owner issuance', async (t) => {
  const directory = await scratchDirectory(t, 'access-http-');
  const file = join(directory, 'data.json');
  const app = await createShadowGraphServer({ file, storage: 'json' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const proposal = await post('/access-requests', { ...bounds, type: 'grant', state: 'active', ownerConfirmation: true, surface: 'cli', binding: { confirmed: true, project: 'beta' } });
  assert.equal(proposal.status, 200);
  const entry = await proposal.json();
  assert.equal(entry.type, 'request');
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.access.entries.length, 1);
  assert.equal(persisted.access.entries[0].type, 'request');
  for (const path of ['/access-grants', '/access-grants/issue', '/access-delegations', '/import']) {
    const refused = await post(path, { ...bounds, ownerConfirmation: true, access: { entries: [{ ...bounds, type: 'grant', state: 'active' }] } });
    assert.equal(refused.status, 404, path);
  }
  assert.equal(JSON.parse(await readFile(file, 'utf8')).events.find((event) => event.reason === 'issuance_surface_unavailable').count, 4);
  const beforeUnknown = JSON.parse(await readFile(file, 'utf8'));
  const unsupported = await fetch(url + '/stats', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessId: entry.accessId }) });
  assert.equal(unsupported.status, 404);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), beforeUnknown, 'an unsupported method does not execute or persist a grant read');
});

test('PR12 owner confirmation checks actual streams and reads confirmation after displaying bounds', { skip: process.platform === 'win32' ? 'Real PTY coverage runs on Ubuntu WSL; Python pty is unavailable on Windows' : false }, () => {
  const helper = fileURLToPath(new URL('./helpers/access-owner-pty.py', import.meta.url));
  const module = new URL('../src/internal/owner-confirmation.js', import.meta.url).href;
  for (const [inputTty, outputTty, answer, allowed] of [[true, true, 'confirm', true], [true, true, 'no', false], [true, true, null, false], [false, true, 'confirm', false], [true, false, 'confirm', false], [false, false, 'confirm', false]]) {
    const run = spawnSync('python3', [helper, process.execPath, module, JSON.stringify({ inputTty, outputTty, answer })], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout);
    assert.equal(result.allowed, allowed, JSON.stringify({ inputTty, outputTty, answer, result }));
    if (inputTty && outputTty) {
      assert.equal(result.displayedBeforeAnswer, true);
      assert.match(result.output, /beta/);
      assert.match(result.output, /2099-01-01/);
    }
  }
});

test('PR12 access operation reloads concurrent revisions and never loses the winning writer', async (t) => {
  const directory = await scratchDirectory(t, 'access-revision-');
  const file = join(directory, 'data.json');
  const firstStore = createJsonFileStore(file);
  const secondStore = createJsonFileStore(file);
  const first = createShadowGraph();
  const second = createShadowGraph();
  const results = await Promise.all([
    currentAccessOperation(first, firstStore, () => first.remember({ project: 'alpha', memoryType: 'note', key: 'a', text: 'first' })),
    currentAccessOperation(second, secondStore, () => second.remember({ project: 'alpha', memoryType: 'note', key: 'b', text: 'second' }))
  ]);
  assert.equal(results.length, 2);
  const durable = await firstStore.load();
  assert.deepEqual(durable.records.map((record) => record.key).sort(), ['a', 'b']);
  assert.equal(durable.revision, 2);
});

test('PR12 access operation returns no result when its audited payload cannot commit', async (t) => {
  const directory = await scratchDirectory(t, 'access-save-');
  const file = join(directory, 'data.json');
  const durableStore = createJsonFileStore(file);
  const graph = createShadowGraph();
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'kept', text: 'existing' });
  await durableStore.save(privilegedSnapshot(graph));
  const before = await durableStore.load();
  const failingStore = createJsonFileStore(file, { saveFault(stage) { if (stage === 'beforeCommit') throw new Error('synthetic failed commit'); } });
  await assert.rejects(currentAccessOperation(graph, failingStore, () => graph.remember({ project: 'alpha', memoryType: 'note', key: 'lost', text: 'must not escape' })), /synthetic failed commit/);
  assert.deepEqual(await durableStore.load(), before);
  assert.deepEqual(privilegedSnapshot(graph), before);
});

test('PR12 long-lived HTTP reads recheck CLI revocation and never trust a caller surface or binding', async (t) => {
  const directory = await scratchDirectory(t, 'access-current-');
  const file = join(directory, 'data.json');
  const graph = createShadowGraph();
  graph.addDecision({ project: 'alpha', title: 'marker own', chosen: 'a' });
  graph.addDecision({ project: 'beta', title: 'marker foreign', chosen: 'b' });
  assert.equal(typeof privileged.privilegedIssueAccess, 'function', 'missing owner issuance capability');
  const issued = privileged.privilegedIssueAccess(graph, { ...bounds, type: 'grant', surface: 'cli' });
  const cliOnly = privileged.privilegedIssueAccess(graph, { ...bounds, type: 'grant', surfaces: ['cli'], surface: 'cli' });
  await createJsonFileStore(file).save(privilegedSnapshot(graph));
  const app = await createShadowGraphServer({ file, storage: 'json' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const endpoint = `http://127.0.0.1:${app.server.address().port}/retrieve`;
  const read = async (input) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'marker', ...input }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual((await read({ project: 'alpha', accessId: cliOnly.entry.accessId, surface: 'cli' })).items.map((hit) => hit.record.project), ['alpha']);
  assert.deepEqual((await read({ binding: { confirmed: true, project: 'beta' } })).items, []);
  const widened = await read({ project: 'alpha', accessId: issued.entry.accessId });
  assert.deepEqual(widened.items.map((hit) => hit.record.project).sort(), ['alpha', 'beta']);
  const storedAfterUse = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(storedAfterUse.events.some((event) => event.type === 'access.used'));
  const revoked = runCli(file, 'revoke-access', { accessId: issued.entry.accessId });
  assert.equal(revoked.status, 0, revoked.stderr);
  const result = await read({ readProvenance: widened.readProvenance });
  assert.deepEqual(result.items.map((hit) => hit.record.project), ['alpha']);
  assert.equal(result.completeness.scope.grant, null);
});

for (const backend of ['json', 'sqlite']) test(`PR12 delegated CLI issuance consumes exactly its budget under concurrent processes (${backend})`, async (t) => {
  if (backend === 'sqlite') {
    try { await import('node:sqlite'); } catch { t.skip('node:sqlite unavailable on this runtime'); return; }
  }
  const directory = await scratchDirectory(t, 'access-delegation-');
  const file = join(directory, backend === 'sqlite' ? 'data.db' : 'data.json');
  const store = await createStorage({ type: backend, file });
  t.after(() => store.close());
  const graph = createShadowGraph();
  const delegation = privileged.privilegedIssueAccess(graph, { ...bounds, type: 'delegation', issuanceLimit: 2, surface: 'cli' });
  await store.save(privilegedSnapshot(graph));
  const attempts = [0, 1, 2].map((index) => ({ ...bounds, delegationId: delegation.entry.accessId, idempotencyKey: `concurrent-${index}` }));
  const results = await Promise.all(attempts.map((input) => runCliAsync(file, backend, 'issue-access', input)));
  assert.equal(results.filter((result) => result.status === 0).length, 2, JSON.stringify(results));
  const durable = await store.load();
  assert.equal(durable.access.entries.filter((entry) => entry.type === 'grant').length, 2);
  const parent = durable.access.entries.find((entry) => entry.type === 'delegation');
  assert.equal(parent.issuanceConsumed, 2);
  assert.equal(parent.state, 'exhausted');
  const winner = results.findIndex((result) => result.status === 0);
  const retry = await runCliAsync(file, backend, 'issue-access', attempts[winner]);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).entry.accessId, JSON.parse(results[winner].stdout).entry.accessId);
  const afterRetry = await store.load();
  assert.equal(afterRetry.access.entries.find((entry) => entry.type === 'delegation').issuanceConsumed, 2);
  assert.equal(afterRetry.access.entries.filter((entry) => entry.type === 'grant').length, 2);
});

test('PR12 real CLI TTY issuance displays normalized bounds before creating an owner witness', { skip: process.platform === 'win32' ? 'Real PTY coverage runs on Ubuntu WSL; Python pty is unavailable on Windows' : false }, async (t) => {
  const directory = await scratchDirectory(t, 'access-issue-pty-');
  const file = join(directory, 'data.json');
  const run = runPtyCli(file, directory, 'delegate-access', { ...bounds, scope: { projects: ['beta', 'alpha', 'beta'] }, issuanceLimit: 2 }, [{ prompt: 'Type confirm', answer: 'confirm' }]);
  assert.equal(run.status, 0, run.output);
  assert.match(run.answered[0].display, /"issuanceLimit": 2/);
  assert.match(run.answered[0].display, /2099-01-01/);
  const durable = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(durable.access.entries.length, 1);
  const entry = durable.access.entries[0];
  assert.equal(entry.type, 'delegation');
  assert.equal(entry.issuedBy, 'owner_confirmation');
  assert.deepEqual(entry.scope.projects, ['alpha', 'beta']);
  assert.equal(durable.events.find((event) => event.id === entry.issuanceEventId).type, 'access.issued');
});

test('PR12 bind requires displayed choice and confirmation and does not infer ownership from opening a workspace', { skip: process.platform === 'win32' ? 'Real PTY coverage runs on Ubuntu WSL; Python pty is unavailable on Windows' : false }, async (t) => {
  const directory = await scratchDirectory(t, 'access-binding-');
  const file = join(directory, 'data.json');
  const git = spawnSync('git', ['init', '--quiet', directory], { encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const graph = createShadowGraph();
  graph.addDecision({ project: 'alpha', title: 'binding marker', chosen: 'kept' });
  await createJsonFileStore(file).save(privilegedSnapshot(graph));
  const before = spawnSync(process.execPath, [cli, 'search', JSON.stringify({ query: 'binding' })], { cwd: directory, env: { ...process.env, SHADOWGRAPH_FILE: file }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(before.stdout).items, []);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(file, 'utf8')), 'projectBindings'), false);
  const run = runPtyCli(file, directory, 'bind', { project: 'alpha', reason: 'explicit synthetic binding' }, [{ prompt: 'Select worktree', answer: 'worktree' }, { prompt: 'Type confirm', answer: 'confirm' }]);
  assert.equal(run.status, 0, run.output);
  assert.match(run.answered[0].display, /Worktree mapping:/);
  assert.match(run.answered[0].display, /Shared repository mapping:/);
  assert.match(run.answered[1].display, /"project": "alpha"/);
  assert.equal(JSON.parse(await readFile(join(directory, '.shadowgraph', 'project-binding.json'), 'utf8')).project, 'alpha');
  const after = spawnSync(process.execPath, [cli, 'search', JSON.stringify({ query: 'binding' })], { cwd: directory, env: { ...process.env, SHADOWGRAPH_FILE: file }, encoding: 'utf8' });
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(JSON.parse(after.stdout).items.map((hit) => hit.record.project), ['alpha']);
  const shared = runPtyCli(file, directory, 'bind', { project: 'alpha', reason: 'explicit synthetic shared binding' }, [{ prompt: 'Select worktree', answer: 'shared_repository' }, { prompt: 'Type confirm', answer: 'confirm' }]);
  assert.equal(shared.status, 0, shared.output);
  assert.match(shared.answered[1].display, /"type": "shared_repository"/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).projectBindings.entries.map((entry) => entry.type).sort(), ['shared_repository', 'worktree']);
});

test('PR12 real CLI attribution confirms explicit material and target while preserving its provenance', { skip: process.platform === 'win32' ? 'Real PTY coverage runs on Ubuntu WSL; Python pty is unavailable on Windows' : false }, async (t) => {
  const directory = await scratchDirectory(t, 'access-attribute-pty-');
  const file = join(directory, 'data.json');
  const graph = createShadowGraph();
  const original = graph.addDecision({ originId: 'synthetic-origin', title: 'unassigned', chosen: 'kept', sourceClass: 'tool_observed' });
  await createJsonFileStore(file).save(privilegedSnapshot(graph));
  const refused = runCli(file, 'attribute', { ids: [original.id], targetProject: 'alpha', reason: 'synthetic', confirmed: true });
  assert.notEqual(refused.status, 0);
  const run = runPtyCli(file, directory, 'attribute', { ids: [original.id], targetProject: 'alpha', reason: 'synthetic' }, [{ prompt: 'Type confirm', answer: 'confirm' }]);
  assert.equal(run.status, 0, run.output);
  assert.ok(run.answered[0].display.includes(original.id));
  assert.match(run.answered[0].display, /"targetProject": "alpha"/);
  const durable = JSON.parse(await readFile(file, 'utf8'));
  const attributed = durable.records.find((record) => record.id === original.id);
  assert.equal(attributed.project, 'alpha');
  for (const field of ['originId', 'title', 'chosen', 'createdAt', 'sourceClass']) assert.deepEqual(attributed[field], original[field]);
  assert.ok(durable.journal.some((entry) => entry.type === 'entity.attributed'));
  for (const extra of [{ accessId: 'not-write-authority' }, { originId: original.originId }]) {
    const invalid = runPtyCli(file, directory, 'attribute', { ids: [original.id], targetProject: 'beta', reason: 'invalid synthetic request', ...extra }, [{ prompt: 'Type confirm', answer: 'confirm' }]);
    assert.notEqual(invalid.status, 0, invalid.output);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).records, durable.records);
  }
});
