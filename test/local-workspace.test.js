// Tests for the external local workspace.
//
// Every path used here is built at runtime from a temporary directory, so no
// real user name, home directory or machine path exists in this file's tracked
// source, and no test ever writes outside the directory it created.
//
// The property under test throughout is the one the policy rests on: the
// workspace resolves outside the repository, initialization validates every
// path it would create before it creates anything, and the read-only commands
// stay read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { scratchDirectory } from '../tools/scratch-directory.js';
import {
  CATEGORIES,
  DEFAULT_WORKSPACE_NAME,
  WORKSPACE_ENV,
  canonicalize,
  initWorkspace,
  isInsideDirectory,
  resolveWorkspace,
  workspaceStatus
} from '../scripts/local-workspace.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceModule = fileURLToPath(new URL('../scripts/local-workspace.mjs', import.meta.url));
const hygieneModule = fileURLToPath(new URL('../scripts/check-public-hygiene.mjs', import.meta.url));

/** Options that pin the resolver to an explicit environment: no ambient value leaks in. */
const configured = (path, cwd = repositoryRoot) => ({ env: { [WORKSPACE_ENV]: path }, cwd, root: repositoryRoot });
const unconfigured = (cwd = repositoryRoot) => ({ env: {}, cwd, root: repositoryRoot });

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// --- resolution -------------------------------------------------------------

test('the default workspace resolves outside the repository, as its sibling', async () => {
  const resolved = await resolveWorkspace(unconfigured());
  const root = await canonicalize(repositoryRoot);
  assert.equal(resolved.source, 'default');
  assert.equal(resolved.configured, null);
  assert.equal(resolved.path, join(dirname(root), DEFAULT_WORKSPACE_NAME));
  assert.equal(isInsideDirectory(root, resolved.path), false, 'the default must not be inside the repository');
});

test('a configured external workspace is accepted and reported as configured', async (t) => {
  const external = await scratchDirectory(t, 'shadowgraph-local-external-');
  const resolved = await resolveWorkspace(configured(external));
  assert.equal(resolved.source, 'environment');
  assert.equal(resolved.path, await canonicalize(external));
  assert.equal(isInsideDirectory(resolved.repositoryRoot, resolved.path), false);
});

test('the repository root itself is rejected', async () => {
  await assert.rejects(resolveWorkspace(configured(repositoryRoot)), /must not be the repository root/u);
});

test('a workspace nested inside the repository is rejected, existing or not', async () => {
  for (const nested of [join(repositoryRoot, 'docs'), join(repositoryRoot, 'docs', 'handoff'), join(repositoryRoot, 'not-created-yet', 'deep')]) {
    await assert.rejects(resolveWorkspace(configured(nested)), /must resolve outside the repository/u, nested);
  }
});

test('a relative setting is resolved against the working directory', async (t) => {
  const elsewhere = await scratchDirectory(t, 'shadowgraph-local-cwd-');
  const resolved = await resolveWorkspace(configured(`.${sep}sibling-workspace`, elsewhere));
  assert.equal(resolved.path, join(await canonicalize(elsewhere), 'sibling-workspace'));

  // The same relative form, entered from the repository, lands inside it and is
  // refused -- which is the case a naive "is it absolute?" check would miss.
  await assert.rejects(resolveWorkspace(configured('local-scratch', repositoryRoot)), /must resolve outside the repository/u);
  await assert.rejects(resolveWorkspace(configured('.', repositoryRoot)), /must not be the repository root/u);
});

test('an empty or blank setting falls back to the default rather than the working directory', async () => {
  for (const blank of ['', '   ']) {
    const resolved = await resolveWorkspace({ env: { [WORKSPACE_ENV]: blank }, cwd: repositoryRoot, root: repositoryRoot });
    assert.equal(resolved.source, 'default');
  }
});

test('containment is decided by path semantics, not by string prefix', async () => {
  const root = await canonicalize(repositoryRoot);
  // A sibling whose name merely starts with the repository's own name shares
  // the prefix without being inside it. A `startsWith` check would reject it.
  const sibling = `${root}-local`;
  assert.equal(isInsideDirectory(root, sibling), false);
  const resolved = await resolveWorkspace(configured(sibling));
  assert.equal(resolved.path, sibling);

  assert.equal(isInsideDirectory(root, root), true, 'a directory contains itself');
  assert.equal(isInsideDirectory(root, join(root, 'src')), true);
  assert.equal(isInsideDirectory(root, join(root, '..')), false);
  assert.equal(isInsideDirectory(join(root, 'src'), root), false, 'a parent is not inside its child');
});

test('a symlink pointing back into the repository is rejected', async (t) => {
  const external = await scratchDirectory(t, 'shadowgraph-local-link-');
  const link = join(external, 'looks-external');
  try {
    await symlink(join(repositoryRoot, 'docs'), link, 'junction');
  } catch (error) {
    // Symlink creation is a privileged operation on some Windows configurations.
    t.skip(`symlinks unavailable: ${error.code ?? error.message}`);
    return;
  }
  await assert.rejects(resolveWorkspace(configured(link)), /must resolve outside the repository/u);
});

// --- init -------------------------------------------------------------------

test('init creates the external workspace and every category, and nothing else', async (t) => {
  const external = join(await scratchDirectory(t, 'shadowgraph-local-init-'), 'workspace');
  const result = await initWorkspace(configured(external));
  assert.equal(result.path, join(await canonicalize(dirname(external)), 'workspace'));
  for (const category of CATEGORIES) {
    assert.ok((await stat(join(result.path, category))).isDirectory(), `${category} must exist`);
  }
  assert.ok(result.readmeCreated);
  assert.match(await readFile(result.readmePath, 'utf8'), /OUTSIDE the Git repository/u);
  assert.equal(await exists(join(result.path, '.git')), false, 'init must not create a Git repository there');

  // The whole of what init creates: no manifest, no index, no state file.
  assert.deepEqual(
    (await readdir(result.path)).sort(),
    ['README.md', ...CATEGORIES].sort(),
    'init creates the categories and a README, and nothing else'
  );
});

test('the workspace structure is tool-neutral', async () => {
  // No per-assistant, per-vendor or per-editor directory: the workspace is
  // described by what the material is, never by which tool produced it.
  for (const category of CATEGORIES) {
    assert.match(category, /^[a-z][a-z-]*$/u, `${category} must be a plain lowercase directory name`);
    assert.doesNotMatch(
      category,
      /claude|codex|cursor|copilot|chatgpt|openai|gemini|anthropic|hermes|antigravity/iu,
      `${category} must not name a tool or vendor`
    );
  }
});

test('repeated initialization is idempotent and loses no data', async (t) => {
  const external = await scratchDirectory(t, 'shadowgraph-local-repeat-');
  await initWorkspace(configured(external));

  const kept = join(external, 'handoffs', 'raw-handoff.md');
  await writeFile(kept, 'raw operational detail\n', 'utf8');
  const editedReadme = 'my own notes\n';
  await writeFile(join(external, 'README.md'), editedReadme, 'utf8');

  const second = await initWorkspace(configured(external));
  assert.deepEqual(second.created, [], 'nothing already present is recreated');
  assert.equal(second.readmeCreated, false);
  assert.equal(await readFile(kept, 'utf8'), 'raw operational detail\n', 'material placed there survives');
  assert.equal(await readFile(join(external, 'README.md'), 'utf8'), editedReadme, 'an edited README is not overwritten');
});

test('init refuses a workspace inside the repository before creating anything', async () => {
  const inside = join(repositoryRoot, 'should-never-exist-local');
  await assert.rejects(initWorkspace(configured(inside)), /must resolve outside the repository/u);
  assert.equal(await exists(inside), false, 'a rejected workspace is never created');
});

// --- status -----------------------------------------------------------------

test('status is read-only and creates nothing, even for a missing workspace', async (t) => {
  const parent = await scratchDirectory(t, 'shadowgraph-local-status-');
  const external = join(parent, 'absent-workspace');

  const before = await workspaceStatus(configured(external));
  assert.equal(before.exists, false);
  assert.equal(before.outsideRepository, true);
  assert.deepEqual(before.categories.map((entry) => entry.name), [...CATEGORIES]);
  assert.ok(before.categories.every((entry) => entry.exists === false));
  assert.deepEqual(await readdir(parent), [], 'status created nothing');

  await initWorkspace(configured(external));
  const listing = await readdir(external);
  const after = await workspaceStatus(configured(external));
  assert.equal(after.exists, true);
  assert.ok(after.categories.every((entry) => entry.exists === true));
  assert.deepEqual(await readdir(external), listing, 'reporting on an existing workspace changes nothing');
});

// --- the write boundary below the workspace root ----------------------------
//
// Proving the workspace root is outside the repository proves nothing about the
// paths below it, and an earlier implementation compared those as unresolved
// strings: an alias planted at a category directory pointed real writes into
// the repository. The repository here is a scratch directory passed as `root`,
// so a regression corrupts a fixture rather than the checkout.

const TRACKED_BYTES = 'tracked repository content\n';

/** A workspace and a mock repository that are siblings, neither inside the other. */
async function aliasFixture(t, prefix) {
  const parent = await scratchDirectory(t, prefix);
  const repository = join(parent, 'mock-repository');
  const tracked = join(repository, 'tracked.md');
  const workspace = join(parent, 'workspace');
  await mkdir(repository, { recursive: true });
  await writeFile(tracked, TRACKED_BYTES, 'utf8');
  return { parent, repository, tracked, workspace, options: { env: { [WORKSPACE_ENV]: workspace }, cwd: parent, root: repository } };
}

test('a category directory aliased into the repository is refused before anything is written', async (t) => {
  // `junction` is the alias a Windows machine can always make; `dir` is the
  // plain symlink, which needs a privilege there and is the normal case
  // everywhere else. Whichever is available must be refused, and refused while
  // the workspace is still exactly as it was found.
  for (const type of ['junction', 'dir']) {
    const fixture = await aliasFixture(t, `shadowgraph-local-alias-${type}-`);
    await mkdir(fixture.workspace, { recursive: true });
    const inside = join(fixture.repository, 'docs');
    await mkdir(inside, { recursive: true });
    await writeFile(join(inside, 'public.md'), TRACKED_BYTES, 'utf8');
    try {
      await symlink(inside, join(fixture.workspace, CATEGORIES[0]), type);
    } catch (error) {
      t.diagnostic(`${type} links unavailable: ${error.code ?? error.message}`);
      continue;
    }
    const before = (await readdir(fixture.workspace)).sort();

    await assert.rejects(
      initWorkspace(fixture.options),
      /resolves outside the local workspace or inside the repository|is a symbolic link or junction/u,
      type
    );

    assert.deepEqual((await readdir(fixture.workspace)).sort(), before, `${type}: init created nothing before refusing`);
    assert.deepEqual(await readdir(inside), ['public.md'], `${type}: the repository gained no directory`);
    assert.equal(await readFile(join(inside, 'public.md'), 'utf8'), TRACKED_BYTES, `${type}: the tracked file is byte-identical`);
  }
});

test('init refuses an aliased README before creating any category directory', async (t) => {
  // Checking each target as it came up meant the README was refused only after
  // all eight category directories had been created, and a hardlinked README
  // was not refused at all: `wx` reports it as nothing worse than an existing
  // file. A configuration knowably invalid from the start must mutate nothing.
  for (const kind of ['symlink', 'hardlink']) {
    const fixture = await aliasFixture(t, `shadowgraph-local-init-readme-${kind}-`);
    await mkdir(fixture.workspace, { recursive: true });
    const readme = join(fixture.workspace, 'README.md');
    try {
      if (kind === 'symlink') await symlink(fixture.tracked, readme, 'file');
      else await link(fixture.tracked, readme);
    } catch (error) {
      t.diagnostic(`${kind} unavailable: ${error.code ?? error.message}`);
      continue;
    }
    const before = (await readdir(fixture.workspace)).sort();

    await assert.rejects(initWorkspace(fixture.options), /refusing to (use|create) the workspace README/u, kind);

    assert.deepEqual((await readdir(fixture.workspace)).sort(), before, `${kind}: init created nothing before refusing`);
    assert.equal(await readFile(fixture.tracked, 'utf8'), TRACKED_BYTES, `${kind}: the tracked file is byte-identical`);
  }
});

// --- no side effects, and nothing tracked records a local path --------------

test('importing the workspace module creates nothing', async (t) => {
  const parent = await scratchDirectory(t, 'shadowgraph-local-import-');
  const target = join(parent, 'workspace');
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(workspaceModule).href)});`],
    { env: { ...process.env, [WORKSPACE_ENV]: target } }
  );
  assert.equal(stdout.trim(), '', 'importing the module prints nothing');
  assert.equal(await exists(target), false, 'importing the module creates no directory');
  assert.deepEqual(await readdir(parent), [], 'importing the module writes nothing at all');
});

test('importing the hygiene checker creates nothing and scans nothing', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(hygieneModule).href)});`],
    { cwd: repositoryRoot }
  );
  assert.equal(stdout.trim(), '', 'a tree scan on import would print its result line');
});

test('the hygiene checker cannot modify anything: it never writes, moves or deletes', async () => {
  const source = await readFile(hygieneModule, 'utf8');

  const fsImport = /import \{([^}]*)\} from 'node:fs\/promises';/u.exec(source);
  assert.ok(fsImport, 'the checker imports from node:fs/promises');
  assert.deepEqual(
    fsImport[1].split(',').map((name) => name.trim()).filter(Boolean),
    ['readFile'],
    'reading is the only filesystem capability the checker imports'
  );

  for (const mutation of ['writeFile(', 'appendFile(', 'mkdir(', 'rm(', 'rmdir(', 'unlink(', 'rename(', 'copyFile(', 'truncate(', 'cp(']) {
    assert.equal(source.includes(mutation), false, `the checker must not call ${mutation}`);
  }

  // The only external process it runs is git, and only to read.
  const subcommands = [...source.matchAll(/git\(\['([a-z-]+)'/gu)].map((match) => match[1]);
  assert.ok(subcommands.length > 0);
  for (const subcommand of subcommands) {
    assert.ok(['ls-files', 'log'].includes(subcommand), `git ${subcommand} is not a read-only query`);
  }
});

test('running the hygiene check leaves the working tree exactly as it was', async () => {
  const state = async () => (await execFileAsync('git', ['status', '--porcelain'], { cwd: repositoryRoot })).stdout;
  const before = await state();
  // The checker exits non-zero when it finds something; that is a report, not a
  // change, so only the tree state is asserted here.
  await execFileAsync(process.execPath, [hygieneModule], { cwd: repositoryRoot }).catch(() => {});
  assert.equal(await state(), before, 'the hygiene check is read-only');
});

test('no tracked file records the resolved local workspace path or the checkout path', async () => {
  const resolved = await resolveWorkspace(unconfigured());
  for (const secret of [resolved.path, resolved.repositoryRoot]) {
    const found = await execFileAsync('git', ['grep', '-F', '-l', '-e', secret], { cwd: repositoryRoot })
      .then(({ stdout }) => stdout.trim())
      .catch((error) => {
        // `git grep` exits 1 with no output when nothing matches.
        if (error.code === 1 && !error.stdout) return '';
        throw error;
      });
    assert.equal(found, '', `a tracked file records a local machine path: ${found}`);
  }
});
