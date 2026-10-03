// The pinned runtime (programme plan revision 6 §5): scripts/install-runtime.mjs installs a commit's packed build
// under a scratch ShadowGraph home, and the hook command and the activation record name it. HOME, USERPROFILE,
// SHADOWGRAPH_HOME, LOCALAPPDATA, APPDATA and npm's cache point into the scratch directory for every run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { runtimeHookCommand } from '../src/host-hooks.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function run(file, args, { home, stdin = '', env = {} }) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: home, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: join(home, 'shadowgraph-home'), SHADOWGRAPH_FILE: '', LOCALAPPDATA: join(home, 'local'), APPDATA: join(home, 'roaming'), npm_config_cache: join(home, 'npm-cache'), ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(stdin);
    child.on('close', (code) => settle({ code, stdout, stderr }));
  });
}
const install = (home, extra = []) => run(resolve('scripts/install-runtime.mjs'), extra, { home });
const cli = (home, args) => run(resolve('src/cli.js'), args, { home });

test('the pinned runtime is the commit\'s packed build, named by commit, tree and tarball digest, and the hooks and the record name it', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-runtime-');
  const installed = await install(home);
  assert.equal(installed.code, 0, installed.stderr);
  const result = JSON.parse(installed.stdout);
  assert.deepEqual([result.commit, result.tree, result.installed], [git('rev-parse', 'HEAD'), git('rev-parse', 'HEAD^{tree}'), true]);
  const runtimeJson = JSON.parse(await readFile(join(result.path, 'runtime.json'), 'utf8'));
  assert.equal(runtimeJson.tarballSha256, createHash('sha256').update(await readFile(join(result.path, 'package.tgz'))).digest('hex'));
  assert.equal(result.tarballSha256, runtimeJson.tarballSha256);
  assert.equal(result.command, runtimeHookCommand(result.path));
  for (const file of ['package.json', join('src', 'cli.js'), join('integrations', 'claude-code.hooks.json')]) assert.ok(existsSync(join(result.path, file)), file);
  // The runtime runs, and without an activation record its hook is inert.
  const inert = await run(join(result.path, 'src', 'cli.js'), ['deliver', '--hook'], { home, stdin: JSON.stringify({ hook_event_name: 'SessionStart' }) });
  assert.deepEqual([inert.code, inert.stdout, inert.stderr], [0, '', '']);
  // A second install of the same commit changes nothing.
  const stamp = statSync(join(result.path, 'runtime.json')).mtimeMs;
  const again = await install(home);
  assert.equal(JSON.parse(again.stdout).installed, false);
  assert.equal(statSync(join(result.path, 'runtime.json')).mtimeMs, stamp);

  // The hooks run the pinned runtime, and uninstall recognises that handler as ShadowGraph's.
  const settings = join(home, 'settings-fixture.json');
  await writeFile(settings, `${JSON.stringify({ model: 'opus' }, null, 2)}\n`);
  const hooked = await cli(home, ['install-hooks', '--settings', settings, '--runtime', result.path]);
  assert.equal(hooked.code, 0, hooked.stderr);
  const commands = Object.values(JSON.parse(await readFile(settings, 'utf8')).hooks).flat().flatMap((group) => group.hooks.map((handler) => handler.command));
  assert.deepEqual(commands, [result.command, result.command]);
  const store = join(home, 'memory.json');
  await writeFile(store, '{}');
  const activated = await cli(home, ['activate', 'delivery', '--evidence', 'receipt-test', '--store', store, '--host-version', '0.0.0', '--settings', settings, '--runtime', result.path]);
  assert.equal(activated.code, 0, activated.stderr);
  // Whether it can capture is whether its build ships the capture hook template (FND-P6-10).
  const shipsCapture = (() => { try { git('cat-file', '-e', `${result.commit}:integrations/claude-code.capture-hooks.json`); return true; } catch { return false; } })();
  const retentionReader = existsSync(join(result.path, 'src', 'internal', 'capture-retention.js'));
  const captureLifecycle = retentionReader && existsSync(join(result.path, 'src', 'capture-lifecycle-capability.json'));
  assert.deepEqual(JSON.parse(activated.stdout).record.capabilities.delivery.runtime, { path: result.path, commit: result.commit, tree: result.tree, tarballSha256: result.tarballSha256, captures: shipsCapture, retentionReader, captureLifecycle });
  assert.deepEqual(JSON.parse((await cli(home, ['uninstall-hooks', '--settings', settings])).stdout).removed, 2);
  // With hooks that run another command, activation naming the runtime is refused.
  assert.equal((await cli(home, ['install-hooks', '--settings', settings])).code, 0);
  const mismatched = await cli(home, ['activate', 'delivery', '--evidence', 'receipt-test', '--store', store, '--host-version', '0.0.0', '--settings', settings, '--runtime', result.path]);
  assert.equal(mismatched.code, 1);
  assert.match(mismatched.stderr, /activation_hooks_run_another_runtime/u);
  assert.equal(JSON.parse((await cli(home, ['uninstall-hooks', '--settings', settings])).stdout).removed, 2);

  // A runtime whose files no longer match its tarball is refused: one edited, one added.
  const worker = join(result.path, 'src', 'delivery.js');
  const original = await readFile(worker);
  await appendFile(worker, '\n// edited after install\n');
  assert.match((await cli(home, ['install-hooks', '--settings', settings, '--runtime', result.path])).stderr, /runtime_not_verified/u);
  await writeFile(worker, original);
  await writeFile(join(result.path, 'src', 'extra.js'), 'export {};\n');
  assert.match((await cli(home, ['install-hooks', '--settings', settings, '--runtime', result.path])).stderr, /runtime_not_verified/u);
  await rm(join(result.path, 'src', 'extra.js'));
  assert.equal((await cli(home, ['install-hooks', '--settings', settings, '--runtime', result.path])).code, 0, 'restored, it is accepted again');

  // A runtime directory that says it holds another commit is not taken for this one.
  const manifestFile = join(result.path, 'runtime.json');
  const manifestText = await readFile(manifestFile, 'utf8');
  await writeFile(manifestFile, manifestText.replace(result.commit, 'f'.repeat(40)));
  const differs = await install(home);
  assert.notEqual(differs.code, 0);
  assert.match(differs.stderr, /runtime_directory_differs/u);
  await writeFile(manifestFile, manifestText);

  // A runtime whose tarball no longer matches its digest is refused: one holding the same files, compressed again,
  // and one with a byte added.
  const tarball = join(result.path, 'package.tgz');
  const packedBytes = await readFile(tarball);
  const recompressed = gzipSync(gunzipSync(packedBytes), { level: 1 });
  assert.notEqual(createHash('sha256').update(recompressed).digest('hex'), result.tarballSha256);
  await writeFile(tarball, recompressed);
  assert.match((await cli(home, ['install-hooks', '--settings', settings, '--runtime', result.path])).stderr, /runtime_not_verified/u);
  await writeFile(tarball, packedBytes);
  await appendFile(tarball, 'x');
  const tampered = await cli(home, ['install-hooks', '--settings', settings, '--runtime', result.path]);
  assert.equal(tampered.code, 1);
  assert.match(tampered.stderr, /runtime_not_verified/u);
  // So is a tarball that is not one, recorded under its own digest.
  const bogus = Buffer.from('not a tarball');
  await writeFile(join(result.path, 'package.tgz'), bogus);
  await writeFile(manifestFile, JSON.stringify({ ...JSON.parse(manifestText), tarballSha256: createHash('sha256').update(bogus).digest('hex') }));
  assert.match((await cli(home, ['install-hooks', '--settings', settings, '--runtime', result.path])).stderr, /runtime_not_verified/u);
});

test('a runtime path either shell would expand is refused for a hook command', () => {
  for (const unsafe of ['C:/x/shadowgraph $(touch x)', 'C:/x/shadowgraph `id`', 'C:/x/shadowgraph %PATH%', 'C:/x/shadowgraph "q"', 'C:/x/shadowgraph !x!']) {
    assert.throws(() => runtimeHookCommand(unsafe), /runtime_path_unsafe_in_a_command/u, unsafe);
  }
  assert.match(runtimeHookCommand('C:/Program Files/shadowgraph/runtime/abc', 'C:/Program Files/nodejs/node.exe'), /^"C:\/Program Files\/nodejs\/node\.exe" "C:\/Program Files\/shadowgraph\/runtime\/abc\/src\/cli\.js" deliver --hook$/u);
});

test('installing a runtime outside a scratch location asks the owner at a terminal', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-runtime-');
  const temporary = join(home, 'temporary');
  await mkdir(temporary);
  const refused = await run(resolve('scripts/install-runtime.mjs'), [], { home, env: { TMP: temporary, TEMP: temporary, TMPDIR: temporary } });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /runtime_requires_owner_confirmation/u);
  assert.equal(existsSync(join(home, 'shadowgraph-home', 'runtime')), false);
});

test('a runtime is only installed under a path that names ShadowGraph and that a hook command can name', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-runtime-');
  // Every scratch path, and a test runner's temporary directory, may name ShadowGraph, so this is a path at the drive's
  // root that is never created while the rule holds.
  const unnamed = join(parse(tmpdir()).root, `sgx-${randomUUID()}`);
  const refused = await run(resolve('scripts/install-runtime.mjs'), ['--home', unnamed], { home });
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /runtime_path_must_name_shadowgraph/u);
  assert.equal(existsSync(unnamed), false);
  // Nor under one a hook command could not name safely: refused before anything is built.
  const unsafe = join(home, 'shadowgraph-100%');
  const expanded = await run(resolve('scripts/install-runtime.mjs'), ['--home', unsafe], { home });
  assert.notEqual(expanded.code, 0);
  assert.match(expanded.stderr, /runtime_path_unsafe_in_a_command/u);
  assert.equal(existsSync(unsafe), false);
});
