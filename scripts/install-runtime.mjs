#!/usr/bin/env node
// The pinned runtime (programme plan revision 6 §5): the real host never runs a
// working tree. At an activation gate the gate commit's packed build is
// installed into `<SHADOWGRAPH_HOME or ~/.shadowgraph>/runtime/<commit>/`,
// exactly as `npm pack` builds it from that commit, with `runtime.json`
// naming the commit, its tree and the tarball's SHA-256, and the tarball kept
// beside it. `shadowgraph install-hooks --runtime <dir>` and
// `shadowgraph activate delivery --runtime <dir>` then name it.
//
// usage: node scripts/install-runtime.mjs [--commit <revision>] [--home <directory>]
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { pinnedRuntime, runtimeHookCommand } from '../src/host-hooks.js';
import { confirmOwnerAction } from '../src/internal/owner-confirmation.js';
import { canonicalPath, isScratchFile } from '../src/internal/owner-files.js';
import { tarEntries } from '../src/internal/tar.js';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

// Files and directories only, inside the target, a leading component dropped
// when asked (`package/` in an npm tarball).
async function extract(archive, target, strip = 0) {
  for (const { name, type, body } of tarEntries(archive)) {
    const parts = name.split('/').filter(Boolean).slice(strip);
    if (parts.length === 0 || parts.some((part) => part === '..')) continue;
    const path = resolve(target, ...parts);
    if (!path.startsWith(resolve(target) + sep)) continue;
    if (type === '5') await mkdir(path, { recursive: true });
    else if (type === '0') {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }
  }
}

function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  const found = candidates.find((candidate) => candidate && candidate.endsWith('.js') && existsSync(candidate));
  if (!found) throw new Error('npm_not_found');
  return found;
}

const args = process.argv.slice(2);
const options = {};
for (let at = 0; at < args.length; at += 2) {
  const name = { '--commit': 'commit', '--home': 'home' }[args[at]];
  if (!name || !args[at + 1] || Object.hasOwn(options, name)) throw new Error('Usage: node scripts/install-runtime.mjs [--commit <revision>] [--home <directory>]');
  options[name] = args[at + 1];
}
const home = options.home ?? process.env.SHADOWGRAPH_HOME ?? join(homedir(), '.shadowgraph');
if (!isAbsolute(home)) throw new Error('runtime_home_not_absolute');
const git = async (...gitArgs) => (await run('git', gitArgs, { cwd: root, maxBuffer: 1024 ** 3, encoding: 'buffer' })).stdout;
const commit = (await git('rev-parse', '--verify', `${options.commit ?? 'HEAD'}^{commit}`)).toString('utf8').trim();
const tree = (await git('rev-parse', '--verify', `${commit}^{tree}`)).toString('utf8').trim();
const runtime = await canonicalPath(join(home, 'runtime', commit));
if (!/shadowgraph/iu.test(runtime)) throw new Error(`runtime_path_must_name_shadowgraph (${runtime})`);
runtimeHookCommand(runtime);

let result;
if (existsSync(runtime)) {
  const installed = await pinnedRuntime(runtime);
  if (installed.commit !== commit || installed.tree !== tree) throw new Error(`runtime_directory_differs (${runtime})`);
  result = { ...installed, installed: false };
} else {
  if (!(await isScratchFile(join(runtime, 'runtime.json'))) && !await confirmOwnerAction('Install the pinned runtime', { runtime, commit, tree })) throw new Error(`runtime_requires_owner_confirmation (${runtime})`);
  const staging = await mkdtemp(join(tmpdir(), 'shadowgraph-runtime-'));
  try {
    const source = join(staging, 'source');
    await extract(await git('archive', '--format=tar', commit), source);
    const packed = JSON.parse((await run(process.execPath, [npmCli(), 'pack', '--ignore-scripts', '--json', '--pack-destination', staging], { cwd: source, maxBuffer: 64 * 1024 ** 2 })).stdout);
    const tarball = await readFile(join(staging, packed[0].filename));
    const partial = `${runtime}.partial-${randomUUID()}`;
    try {
      await extract(gunzipSync(tarball), partial, 1);
      await writeFile(join(partial, 'package.tgz'), tarball);
      await writeFile(join(partial, 'runtime.json'), `${JSON.stringify({ commit, tree, tarball: packed[0].filename, tarballSha256: createHash('sha256').update(tarball).digest('hex'), node: process.version }, null, 2)}\n`);
      await rename(partial, runtime);
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  result = { ...(await pinnedRuntime(runtime)), installed: true };
}
console.log(JSON.stringify({ ...result, command: runtimeHookCommand(result.path) }, null, 2));
