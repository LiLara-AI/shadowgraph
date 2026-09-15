// External local workspace for raw, internal development material.
//
// The public repository must not carry raw handoffs, session state, backups,
// debugging logs or private benchmark working material. Deleting that material
// is not the answer either: it is useful, and a hygiene gate that destroyed it
// would be worse than the leak it prevents. So the policy is: preserve
// locally, sanitize publicly, block accidental publication. The raw copy lives
// OUTSIDE the Git repository -- an ignored directory inside the repository is a
// fallback protection, not the storage architecture.
//
// Two subcommands, separated by what they are allowed to touch:
//
//   node scripts/local-workspace.mjs init
//       Creates the external workspace and its category directories. Repeating
//       it creates nothing that already exists and overwrites nothing.
//
//   node scripts/local-workspace.mjs status
//       READ-ONLY. Reports where the workspace resolves, whether it exists, and
//       which categories are present. Creates nothing.
//
// Putting material into the workspace is manual: copy it there yourself.
// Nothing in this repository copies, moves, deletes or rewrites raw material.
//
// Proving the workspace root is outside the repository proves nothing about the
// paths below it. A category directory or the README can itself be a symlink, a
// Windows junction or a hardlink to a tracked file, so every path init would
// create is resolved and checked against the workspace and the repository
// before anything is created -- a configuration knowably invalid from the start
// is refused without the workspace being modified at all.
//
// Zero runtime dependencies, and no side effects on import: every path is
// resolved and every directory created inside an exported function, so
// importing this module from a test creates nothing.
//
// The resolved workspace path is printed, never written into a tracked file.

import { lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WORKSPACE_ENV = 'SHADOWGRAPH_LOCAL_WORKSPACE';

// A fixed sibling name rather than one derived from the checkout directory: the
// checkout name is a machine detail, and a stable name keeps documentation and
// tooling identical on every machine.
export const DEFAULT_WORKSPACE_NAME = 'shadowgraph-local';

// What raw material is kept apart by. Categories are directories, nothing more:
// no index, no schema, no lifecycle.
export const CATEGORIES = Object.freeze([
  'handoffs',
  'backups',
  'sessions',
  'logs',
  'raw-evidence',
  'benchmark-private',
  'agent-work',
  'machine-notes'
]);

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));

const README = `# ShadowGraph local workspace

Raw and internal development material for the ShadowGraph repository. This
directory is deliberately OUTSIDE the Git repository and is not a Git product
artifact. Nothing here is published.

Keep here: raw handoffs, full operational notes, backups, agent and session
working data, debugging logs, raw benchmark evidence, private benchmark working
material, machine-specific notes, local paths and configuration details, and
temporary investigation artifacts.

Raw material is preserved at full fidelity. Only a sanitized public copy belongs
in the tracked repository, and sanitizing the public copy never justifies
destroying the raw one.

Placing material here is manual. No repository tooling copies, moves, deletes or
rewrites anything in this directory.
`;

export class WorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/**
 * True when `candidate` is `parent` itself or lies beneath it.
 *
 * Deliberately not a string-prefix test: a sibling named `<repo>-local` shares
 * the repository root's prefix without being inside it, and on Windows the same
 * directory can be spelled in several cases. `relative()` answers with the
 * platform's own path semantics, and both sides are canonicalized before they
 * reach here, so a symlink cannot smuggle a path back into the repository.
 */
export function isInsideDirectory(parent, candidate) {
  const rel = relative(parent, candidate);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Absolute, symlink-resolved form of a path that need not exist yet.
 *
 * `realpath` fails on a path with missing segments, which is the normal case
 * before `init` has run, so the deepest existing ancestor is resolved and the
 * missing tail appended.
 */
export async function canonicalize(path) {
  const absolute = resolve(path);
  const tail = [];
  let current = absolute;
  for (;;) {
    try {
      return join(await realpath(current), ...tail);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Where the local workspace is, and why.
 *
 * Configured through `SHADOWGRAPH_LOCAL_WORKSPACE`; a relative value is
 * resolved against the working directory. With nothing configured it is the
 * repository's sibling `shadowgraph-local`, which is outside the repository on
 * every platform without needing a home directory or any other machine fact.
 *
 * Creates nothing. A workspace that is the repository root, or anywhere inside
 * it, is refused here, so every caller downstream can assume containment.
 */
export async function resolveWorkspace({ env = process.env, cwd = process.cwd(), root = defaultRoot } = {}) {
  const repositoryRoot = await canonicalize(root);
  const raw = typeof env?.[WORKSPACE_ENV] === 'string' ? env[WORKSPACE_ENV].trim() : '';
  const requested = raw ? resolve(cwd, raw) : join(dirname(repositoryRoot), DEFAULT_WORKSPACE_NAME);
  const path = await canonicalize(requested);
  if (path === repositoryRoot) {
    throw new WorkspaceError(`${WORKSPACE_ENV} must not be the repository root itself; the local workspace exists to keep raw material outside the repository`);
  }
  if (isInsideDirectory(repositoryRoot, path)) {
    throw new WorkspaceError(`${WORKSPACE_ENV} must resolve outside the repository; a path inside it would publish raw material on the next commit`);
  }
  return { source: raw ? 'environment' : 'default', configured: raw || null, path, repositoryRoot };
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

/**
 * Proves one path init would create resolves inside the workspace and outside
 * the repository.
 *
 * `resolveWorkspace` proves this for the workspace root, and that proof does
 * not extend downward: a category directory, an intermediate component or the
 * README can itself be a symlink or a Windows junction pointing anywhere, and
 * comparing unresolved strings cannot see it. `canonicalize` resolves every
 * existing component and appends whatever tail does not exist yet, so a target
 * that has still to be created is checked on the same terms as one that
 * already is.
 */
async function assertWorkspaceWriteTarget(workspace, target, what) {
  const resolved = await canonicalize(target);
  if (!isInsideDirectory(workspace.path, resolved) || isInsideDirectory(workspace.repositoryRoot, resolved)) {
    throw new WorkspaceError(`refusing to ${what}: ${target} resolves outside the local workspace or inside the repository`);
  }
  return resolved;
}

/**
 * Refuses a path that already exists as something we must not write through.
 *
 * Resolution catches a symlink or a junction by where it points; it cannot
 * catch a hardlink, which has no path of its own to resolve and is
 * indistinguishable from the file it aliases, so the link count is inspected
 * too. `lstat` reads metadata only: nothing is created, opened for writing or
 * truncated, and a path this refuses is left exactly as it was found -- never
 * replaced, never removed.
 */
async function assertNoUnsafeAlias(path, label, kind) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new WorkspaceError(`refusing to use ${label}: ${path} is a symbolic link or junction`);
  }
  if (kind === 'directory' && !info.isDirectory()) {
    throw new WorkspaceError(`refusing to use ${label}: ${path} is not a directory`);
  }
  if (kind === 'file') {
    if (!info.isFile()) throw new WorkspaceError(`refusing to use ${label}: ${path} is not a regular file`);
    if (info.nlink > 1) throw new WorkspaceError(`refusing to use ${label}: ${path} is a hardlink to another file`);
  }
}

/** Creates the workspace and its categories. Idempotent: nothing existing is touched. */
export async function initWorkspace(options = {}) {
  const workspace = await resolveWorkspace(options);
  const directories = [workspace.path, ...CATEGORIES.map((name) => join(workspace.path, name))];
  const readmePath = join(workspace.path, 'README.md');

  // One pass that inspects, then one that creates. Checking each target as it
  // came up meant a README already standing as an alias was refused only after
  // all eight category directories had been created: a configuration knowably
  // invalid from the start still mutated the workspace. Everything init can
  // determine is unsafe is now determined while the workspace is exactly as it
  // was found, so a refusal creates nothing and changes nothing.
  for (const directory of directories) {
    await assertWorkspaceWriteTarget(workspace, directory, 'create a workspace directory');
    await assertNoUnsafeAlias(directory, 'a workspace directory', 'directory');
  }
  await assertWorkspaceWriteTarget(workspace, readmePath, 'create the workspace README');
  await assertNoUnsafeAlias(readmePath, 'the workspace README', 'file');

  const created = [];
  for (const directory of directories) {
    if (await mkdir(directory, { recursive: true }) !== undefined) created.push(directory);
  }
  // `wx` rather than a plain write: a repeated init must never discard an edit
  // someone made to their own workspace notes. `O_CREAT|O_EXCL` also refuses a
  // symlink outright, so the preflight above is a second line rather than the
  // only one -- but it is the line that catches a hardlink, which `wx` reports
  // as nothing worse than an existing file.
  let readmeCreated = false;
  try {
    await writeFile(readmePath, README, { encoding: 'utf8', flag: 'wx' });
    readmeCreated = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return { ...workspace, created, readmePath, readmeCreated };
}

/** Read-only report. Touches nothing, creates nothing, and returns plain data. */
export async function workspaceStatus(options = {}) {
  const workspace = await resolveWorkspace(options);
  const categories = [];
  for (const name of CATEGORIES) {
    categories.push({ name, exists: await directoryExists(join(workspace.path, name)) });
  }
  return {
    ...workspace,
    exists: await directoryExists(workspace.path),
    // True by construction: `resolveWorkspace` refuses anything else.
    outsideRepository: !isInsideDirectory(workspace.repositoryRoot, workspace.path),
    categories
  };
}

// --- command line -----------------------------------------------------------

function reportStatus(status) {
  const origin = status.source === 'environment'
    ? `${WORKSPACE_ENV}=${status.configured}`
    : `default (repository sibling ${DEFAULT_WORKSPACE_NAME})`;
  console.log(`local workspace: ${status.path}`);
  console.log(`  configured by:       ${origin}`);
  console.log(`  exists:              ${status.exists ? 'yes' : 'no (run: npm run local:workspace:init)'}`);
  console.log(`  outside repository:  ${status.outsideRepository ? 'yes' : 'no'}`);
  console.log(`  categories:          ${status.categories.map((entry) => `${entry.name}${entry.exists ? '' : ' (missing)'}`).join(', ')}`);
  console.log('status is read-only: nothing was created, moved or removed.');
}

async function main(argv) {
  const [command] = argv;
  if (command === 'init') {
    const result = await initWorkspace();
    const count = result.created.length;
    console.log(`local workspace ready: ${result.path}`);
    console.log(`  created this run:    ${count} director${count === 1 ? 'y' : 'ies'}${result.readmeCreated ? ' and README.md' : ''}`);
    console.log(`  categories:          ${CATEGORIES.join(', ')}`);
    console.log('nothing existing was overwritten, and no Git repository was created there.');
    console.log('copy raw material into the categories yourself: nothing here moves or deletes it.');
    return;
  }
  if (command === 'status') {
    reportStatus(await workspaceStatus());
    return;
  }
  throw new WorkspaceError(`unknown command ${JSON.stringify(command ?? '')}; expected init or status`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`local-workspace: ${error instanceof WorkspaceError ? error.message : (error.message ?? 'unexpected failure')}`);
    process.exitCode = 1;
  }
}
