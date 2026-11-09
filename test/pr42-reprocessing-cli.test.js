import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';
import { CAPTURE_LIMITS } from '../src/capture-hook.js';
import { ledgerPath } from '../src/internal/deletion-knowledge.js';
import { claimCapture, commitCapture } from '../src/internal/extraction-worker.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
async function fixture(t) {
  const root = await scratchDirectory(t, 'shadowgraph-pr42-cli-'), home = join(root, 'home');
  await mkdir(home);
  const file = join(root, 'capture.json'), manual = join(root, 'manual.json');
  await writeFile(manual, 'untouched manual store');
  const env = { ...process.env, SHADOWGRAPH_HOME: home, SHADOWGRAPH_FILE: manual, HOME: home, USERPROFILE: home };
  const graph = createShadowGraph();
  const item = privilegedRecordCapture(graph, { project: 'p', originId: 'synthetic', text: 'Private fixture content.', admission: { limits: CAPTURE_LIMITS, storeBytes: 0 }, source: { event: 'Stop', sessionId: 'synthetic-session' } });
  const store = await createStorage({ type: 'json', file, env });
  await store.save(privilegedSnapshot(graph)); store.close();
  const activation = join(home, 'activation.json');
  await writeFile(activation, JSON.stringify({ version: 1, capabilities: { capture: { state: 'deactivated', changedAt: new Date().toISOString(), store: { file, storage: 'json' }, originId: 'synthetic', coverage: { projects: 'all', exclude: [] }, limits: CAPTURE_LIMITS } }, history: [] }));
  const run = args => promisify(execFile)(process.execPath, [CLI, 'extract', ...args], { cwd: root, env, timeout: 10000 });
  return { run, file, manual, activation, item, root, env };
}

test('PR42 CLI: status uses the pinned capture store, is scoped and starts no extraction', async t => {
  const f = await fixture(t), paths = [f.file, f.manual, f.activation];
  const before = await Promise.all(paths.map(p => readFile(p)));
  const response = await f.run(['--status', '--project', 'p']);
  const status = JSON.parse(response.stdout);
  assert.equal(status.items.length, 1);
  assert.equal(status.items[0].id, f.item.id);
  assert.equal(status.items[0].state, 'pending');
  assert.equal(response.stdout.includes('Private fixture content.'), false);
  assert.equal(JSON.parse((await f.run(['--status', '--project', 'q'])).stdout).items.length, 0);
  assert.equal(JSON.parse((await f.run(['--status'])).stdout).items.length, 0);
  assert.deepEqual(await Promise.all(paths.map(p => readFile(p))), before);
});

test('PR42 CLI: reprocessing requires owner terminal confirmation and rejects automatic/status combinations', async t => {
  const f = await fixture(t), options = { type: 'json', file: f.file, env: f.env, project: 'p' };
  assert.equal((await commitCapture(options, await claimCapture(options), { status: 'success', receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' },
    value: { records: [{ kind: 'memory', fields: [{ name: 'text', text: 'Private fixture content.', sourceRef: f.item.id }] }] } })).status, 'committed');
  const before = await readFile(f.file);
  await assert.rejects(f.run(['--reprocess', f.item.id, '--project', 'p']), /owner_confirmation_required/);
  for (const flags of [['--automatic', '--reprocess', f.item.id], ['--status', '--reprocess', f.item.id], ['--status', '--automatic'], ['--status', '--status']]) {
    await assert.rejects(f.run(flags), /Usage|duplicate/);
  }
  assert.deepEqual(await readFile(f.file), before);
  await writeFile(ledgerPath(f.file), JSON.stringify({ version: 1, pending: [{ kind: 'purge' }] }));
  await assert.rejects(f.run(['--status', '--project', 'p']), /deletion_pending_unsupported_at_this_build/);
  assert.deepEqual(await readFile(f.file), before);
});

test('PR42 CLI: real owner PTY confirms exact scope before queuing, without invoking extraction', {
  skip: process.platform === 'win32' ? 'Real PTY coverage runs on Ubuntu WSL; Python pty is unavailable on Windows' : false
}, async t => {
  const f = await fixture(t), options = { type: 'json', file: f.file, env: f.env, project: 'p' };
  await commitCapture(options, await claimCapture(options), { status: 'success', receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' },
    value: { records: [{ kind: 'memory', fields: [{ name: 'text', text: 'Private fixture content.', sourceRef: f.item.id }] }] } });
  const before = await readFile(f.file);
  const run = answer => {
    const helper = fileURLToPath(new URL('./helpers/access-cli-pty.py', import.meta.url));
    const process = spawnSync('python3', [helper, JSON.stringify({ command: [globalThis.process.execPath, CLI, 'extract', '--project', 'p', '--reprocess', f.item.id],
      cwd: f.root, env: f.env, answers: [{ prompt: 'Type confirm', answer }] })], { encoding: 'utf8', timeout: 15000 });
    assert.equal(process.status, 0, process.stderr);
    return JSON.parse(process.stdout);
  };
  assert.notEqual(run('decline').status, 0);
  assert.deepEqual(await readFile(f.file), before);
  const confirmed = run('confirm');
  assert.equal(confirmed.status, 0, confirmed.output);
  assert.ok(confirmed.answered[0].display.includes(f.file));
  assert.ok(confirmed.answered[0].display.includes(f.item.id));
  assert.equal(confirmed.answered[0].display.includes('Private fixture content.'), false);
  const store = await createStorage(options);
  try {
    const data = await store.load(), item = data.records.find(x => x.id === f.item.id);
    assert.equal(item.state, 'pending');
    assert.equal(item.reprocessRequest.surface, 'cli');
    assert.equal(item.receipts.length, 1, 'queuing cannot invoke the executor');
    assert.equal(item.producedRecordIds.length, 1);
  } finally { store.close(); }
  assert.equal(await readFile(f.manual, 'utf8'), 'untouched manual store');
});
