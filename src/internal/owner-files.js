// Files the owner keeps outside every store: the host's settings (PR-31) and
// the per-user activation record (PR-32). Each path is resolved to the file it
// reaches; a change to one outside a scratch location needs the owner at a
// terminal (the callers ask); every write is a temporary file and a rename.
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// The program a bare command name runs, as an absolute path, so a workspace
// that holds its own git is never run in its place. On Windows, Node 20's
// process search tries the working directory before PATH and ignores
// NoDefaultCurrentDirectoryInExePath (Node 22 honours it); elsewhere an empty
// or relative PATH entry (`::`, a trailing `:`, `.`) names the working
// directory. Only absolute PATH entries are searched, for `name.exe` on
// Windows and an executable `name` elsewhere; a name found in none of them is
// null, and the caller treats it as the program missing.
export function commandPath(name, env = process.env) {
  const windows = process.platform === 'win32';
  const path = (windows ? Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] : env.PATH) ?? '';
  for (const entry of path.split(windows ? ';' : ':').map((part) => (windows ? part.trim().replace(/^"(.*)"$/u, '$1') : part))) {
    if (!entry || !isAbsolute(entry)) continue;
    const candidate = join(entry, windows ? `${name}.exe` : name);
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile() && (windows || executable(candidate))) return candidate;
  }
  return null;
}
const executable = (file) => {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
};

// The file a path reaches, whatever name reaches it: a short (8.3) name, a
// junction or a link resolves to the file's own path, through its nearest
// existing parent when the file does not exist yet. Checks and writes use it,
// so a link stays a link and its target is what changes.
export async function canonicalPath(path) {
  const missing = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(await realpath(at), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(at) === at) throw error;
      missing.push(basename(at));
    }
  }
}

// The git repository a path lies in, or null (§21.3, VAR-14): any directory
// above it holding a `.git` entry (a repository, or a worktree's pointer file),
// or a `.git` directory itself, walked from the path as the file system
// resolves it now, so a link or junction placed since activation is followed.
// No subprocess, so the hook can ask it on every event. A working tree whose
// git directory lies elsewhere (`core.worktree`, as dotfiles set-ups use)
// leaves no trace on this path and is not detected: a declared limit. The
// capture hook's store and the deletion registry's folder are checked with it
// (PR-37d design §7.2, V-7).
export async function repositoryOf(file) {
  for (let directory = dirname(await canonicalPath(file)); ; directory = dirname(directory)) {
    if (basename(directory) === '.git') return directory;
    // Only an entry that is not there is absent; any other answer (access
    // denied, a path too long) counts as one, so the check fails closed.
    if (await lstat(join(directory, '.git')).then(() => true, (error) => !['ENOENT', 'ENOTDIR'].includes(error.code))) return directory;
    if (dirname(directory) === directory) return null;
  }
}

// A scratch file: one under the system's temporary directory, in no `.claude`
// or `.shadowgraph` directory, and under no name Claude Code reads. Nothing is
// scratch when that temporary directory holds the user's own home (the
// account's, not HOME or USERPROFILE, which a caller can set). Any other file
// changes only after the owner confirms at a terminal. This guards against an
// accidental change; a process that can write the file itself is not stopped.
const inside = (parent, path) => {
  const step = relative(parent, path);
  return !step.startsWith('..') && !isAbsolute(step);
};
export async function isScratchFile(path) {
  const temporary = await realpath(tmpdir()).catch(() => null);
  const home = await Promise.resolve().then(() => realpath(userInfo().homedir)).catch(() => null);
  if (temporary === null || home === null || inside(temporary, home)) return false;
  return relative(temporary, path) !== '' && inside(temporary, path)
    && !path.split(/[\\/]/u).some((segment) => ['.claude', '.shadowgraph'].includes(segment.toLowerCase()))
    && !/^(?:\.claude|(?:managed-)?settings(?:\.[^.]+)?|hooks)\.json$/iu.test(basename(path));
}

export const readText = (path) => readFile(path, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

// A temporary file renamed over the target, with the file's permission bits
// where the platform keeps them (a new file's are the owner's only). A rename
// the host briefly blocks on Windows is tried a few times; a failed write
// leaves no temporary copy behind.
export async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const mode = await stat(path).then((found) => found.mode & 0o777, () => 0o600);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' });
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await delay(50 * attempt);
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
