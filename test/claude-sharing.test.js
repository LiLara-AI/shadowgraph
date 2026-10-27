// Sharing on the Claude hook path (2026-10-27), with the Codex route's meaning:
// each project's delivery reads its own project by default; the owner may share
// selected projects' memory, or every bound project's less those excluded, with
// every bound project, as one grant; changing back revokes it. Run through the real `deliver --hook` process. No model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { changeDeliverySharing } from '../src/activation.js';
import { privilegedBindProject, privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const CLI = resolve('src/cli.js');
const PROJECTS = ['alpha', 'beta', 'gamma'];
const CHOSEN = {
  alpha: 'Parse German hour cells with the comma-decimal regex parser',
  beta: 'Parse German overtime cells with the comma-decimal regex parser',
  gamma: 'Parse German bonus cells with the comma-decimal regex parser'
};

async function setup(t) {
  const root = await scratchDirectory(t, 'shadowgraph-claude-sharing-');
  const home = join(root, 'home'), sgHome = join(root, 'sg-home');
  const file = join(root, 'private', 'memory.json');
  await Promise.all([home, sgHome, dirname(file)].map((path) => mkdir(path, { recursive: true })));
  const graph = createShadowGraph();
  const cwd = {};
  for (const project of PROJECTS) {
    cwd[project] = join(root, project);
    await mkdir(join(cwd[project], '.shadowgraph'), { recursive: true });
    await writeFile(join(cwd[project], '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd[project]), project, confirmed: true }));
    privilegedBindProject(graph, { type: 'worktree', path: resolve(cwd[project]), project, reason: 'synthetic sharing test', surface: 'cli' });
    graph.addDecision({ project, title: `${project} parser`, chosen: CHOSEN[project] });
  }
  const store = await createStorage({ type: 'json', file });
  await store.save(privilegedSnapshot(graph));
  store.close?.();
  const activation = join(sgHome, 'activation.json');
  await writeFile(activation, JSON.stringify({ version: 1, capabilities: { delivery: { state: 'active', store: { file, storage: 'json' } } }, history: [] }));
  return { root, file, cwd, activation, env: { HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: sgHome } };
}

function deliver(s, project, prompt) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:SHADOWGRAPH_|CLAUDE|ANTHROPIC_)/i.test(name)));
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [CLI, 'deliver', '--hook'], { cwd: s.cwd[project], env: { ...base, ...s.env } });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', fail);
    child.on('close', () => settle(stdout));
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-1', cwd: s.cwd[project], prompt }));
  });
}
const seen = async (s, project) => {
  const out = await deliver(s, project, 'How should German comma-decimal cells be parsed with the regex parser?');
  const context = out ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
  return { projects: PROJECTS.filter((name) => context.includes(CHOSEN[name])), grant: context ? JSON.parse(context.split('\n').find((line) => line.startsWith('head: ')).slice(6)).scope.grant : null };
};

test('delivery reads the project alone by default; selected sharing adds the others; changing back revokes the grant', { timeout: 120_000 }, async (t) => {
  const s = await setup(t);
  assert.deepEqual((await seen(s, 'alpha')).projects, ['alpha'], 'project-only by default');
  const shared = await changeDeliverySharing({ env: s.env, mode: 'selected', projects: ['alpha', 'beta'] });
  assert.equal(shared.sharing.mode, 'selected');
  assert.match(shared.sharing.accessId, /^access_/u);
  const alpha = await seen(s, 'alpha');
  assert.deepEqual(alpha.projects, ['alpha', 'beta']);
  assert.equal(alpha.grant.accessId, shared.sharing.accessId);
  assert.deepEqual((await seen(s, 'beta')).projects, ['alpha', 'beta']);
  assert.deepEqual((await seen(s, 'gamma')).projects, ['alpha', 'beta', 'gamma'], 'a bound project outside the selection reads the shared memory too, as on the Codex route');
  const back = await changeDeliverySharing({ env: s.env, mode: 'project' });
  assert.equal(back.revoked, shared.sharing.accessId);
  assert.deepEqual((await seen(s, 'alpha')).projects, ['alpha'], 'revoked');
  // The grant itself is revoked in the store, not only forgotten by the record.
  const store = JSON.parse(await readFile(s.file, 'utf8'));
  assert.ok(JSON.stringify(store).includes(shared.sharing.accessId));
  const history = JSON.parse(await readFile(s.activation, 'utf8')).history.filter((entry) => entry.change === 'sharing');
  assert.deepEqual(history.map((entry) => [entry.mode, entry.revoked]), [['selected', null], ['project', shared.sharing.accessId]]);
});

test('all-permitted shares every bound project less those excluded; a revoked grant left in the record degrades to the project', { timeout: 120_000 }, async (t) => {
  const s = await setup(t);
  const all = await changeDeliverySharing({ env: s.env, mode: 'all-permitted', exclude: ['gamma'] });
  assert.deepEqual(all.sharing.projects, ['alpha', 'beta']);
  assert.deepEqual((await seen(s, 'beta')).projects, ['alpha', 'beta']);
  // Revoked through the general access verb, behind the record's back.
  const graph = createShadowGraph();
  const store = await createStorage({ type: 'json', file: s.file });
  graph.importData(await store.load());
  graph.revokeAccess({ accessId: all.sharing.accessId, surface: 'cli', reason: 'synthetic revocation' });
  await store.save(privilegedSnapshot(graph));
  store.close?.();
  const after = await seen(s, 'beta');
  assert.deepEqual(after.projects, ['beta']);
  assert.equal(after.grant, null);
});

test('sharing names only bound projects, at least one, and needs active delivery', async (t) => {
  const s = await setup(t);
  await assert.rejects(changeDeliverySharing({ env: s.env, mode: 'selected', projects: ['alpha', 'unknown'] }), /sharing_project_not_bound/u);
  await assert.rejects(changeDeliverySharing({ env: s.env, mode: 'selected', projects: [] }), /sharing_empty/u);
  await assert.rejects(changeDeliverySharing({ env: s.env, mode: 'all-permitted', exclude: PROJECTS }), /sharing_empty/u);
  await assert.rejects(changeDeliverySharing({ env: s.env, mode: 'everything' }), /sharing_mode_invalid/u);
  await writeFile(s.activation, JSON.stringify({ version: 1, capabilities: {} }));
  await assert.rejects(changeDeliverySharing({ env: s.env, mode: 'project' }), /sharing_requires_active_delivery/u);
});

// Review of the route (2026-10-27), finding 7: a record changed while the owner
// was confirming stops the change before any grant moves.
test('a sharing change that meets a changed activation record issues no grant', { timeout: 120_000 }, async (t) => {
  const s = await setup(t);
  await assert.rejects(changeDeliverySharing({ env: s.env, mode: 'selected', projects: ['alpha'], afterConfirmation: async () => {
    const record = JSON.parse(await readFile(s.activation, 'utf8'));
    await writeFile(s.activation, JSON.stringify({ ...record, history: [...record.history, { at: new Date().toISOString(), capability: 'capture', state: 'deactivated' }] }));
  } }), /activation_record_changed_while_confirming/u);
  assert.doesNotMatch(await readFile(s.file, 'utf8'), /access_[0-9a-f]{8}-/u, 'no grant was issued');
  assert.equal(JSON.parse(await readFile(s.activation, 'utf8')).capabilities.delivery.sharing, undefined);
});
