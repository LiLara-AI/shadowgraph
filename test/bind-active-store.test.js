import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDirectory } from '../tools/scratch-directory.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// A binding is honoured by the hooks only when the activated store records it. A `bind` run
// without SHADOWGRAPH_FILE once wrote to a new workspace-local store instead (run record 30).
async function fixture(t, capability) {
  const root = await scratchDirectory(t, 'shadowgraph-bind-store-');
  const home = join(root, 'home'), workspace = join(root, 'workspace'), activeStore = join(root, 'active', 'memory.json');
  await mkdir(home, { recursive: true }); await mkdir(workspace, { recursive: true });
  await writeFile(join(home, 'activation.json'), JSON.stringify({ version: 1, capabilities: { [capability]: {
    state: 'active', store: { file: activeStore, storage: 'json' }, originId: 'origin_2f65b6ad-d211-470a-93ff-85723279b709',
    coverage: { projects: 'all', exclude: [] }, limits: { maxStoreBytes: 16777216, maxQueueDepth: 2000, maxItemBytes: 65536, maxItemsPerSession: 1000 } } } }));
  const { SHADOWGRAPH_FILE: _inherited, ...base } = process.env;
  const bind = (env = {}) => spawnSync(process.execPath, [cli, 'bind', JSON.stringify({ project: 'alpha', reason: 'synthetic' })],
    { cwd: workspace, encoding: 'utf8', input: '', windowsHide: true, env: { ...base, SHADOWGRAPH_HOME: home, ...env } });
  return { workspace, activeStore, bind };
}

for (const capability of ['delivery', 'capture']) {
  test(`bind refuses, before opening any store, a store other than the active ${capability} store`, async (t) => {
    const s = await fixture(t, capability);
    const run = s.bind();
    assert.notEqual(run.status, 0);
    assert.match(run.stderr + run.stdout, /binding_store_not_active/u);
    assert.ok((run.stderr + run.stdout).includes(s.activeStore), 'names the active store to use');
    assert.equal(existsSync(join(s.workspace, '.shadowgraph')), false, 'no workspace-local store or binding file was created');
  });
}

test('doctor names the store the activated hooks read and whether it is the one it checked', async (t) => {
  const s = await fixture(t, 'capture');
  const { SHADOWGRAPH_FILE: _inherited, ...base } = process.env;
  const run = (args, file) => spawnSync(process.execPath, [cli, ...args], { cwd: s.workspace, encoding: 'utf8', windowsHide: true,
    env: { ...base, SHADOWGRAPH_HOME: join(s.activeStore, '..', '..', 'home'), ...(file ? { SHADOWGRAPH_FILE: file } : {}) } });
  assert.equal(run(['setup']).status, 0);
  const local = JSON.parse(run(['doctor']).stdout);
  assert.deepEqual(local.hooks, { activeStore: s.activeStore, sameStore: false });
  assert.equal(run(['setup'], s.activeStore).status, 0);
  assert.deepEqual(JSON.parse(run(['doctor'], s.activeStore).stdout).hooks, { activeStore: s.activeStore, sameStore: true });
});

test('bind with the active store named proceeds to the owner prompts and shows the store it writes', async (t) => {
  const s = await fixture(t, 'delivery');
  const run = s.bind({ SHADOWGRAPH_FILE: s.activeStore });
  assert.doesNotMatch(run.stderr + run.stdout, /binding_store_not_active/u);
  assert.ok(run.stdout.includes(`Store: ${s.activeStore}`), run.stdout);
  assert.match(run.stderr + run.stdout, /binding_requires_owner_confirmation/u, 'no terminal answered, so nothing is bound');
});
