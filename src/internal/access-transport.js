import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { constants, readFileSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as privileged from './snapshot.js';
import { isCommittedRejection } from '../shadowgraph.js';
import { commandPath } from './owner-files.js';

const execute = promisify(execFile);

// Routes every request the kernel treats as an access request through the
// fenced save, so its audit commits with it: any presented readProvenance or
// access id. A present accessId or grantId key routes even when null, which the
// kernel reads as own scope; that delivery commits a revision and no audit, and
// is declared under the grant tier of CONTEXT_DELIVERY_BUDGET.
export const hasAccessReference = (input) => Boolean(input && (Object.hasOwn(input, 'accessId') || Object.hasOwn(input, 'grantId') || input.readProvenance !== undefined));

// git ends each answer with one newline; only that is removed, so a name that
// itself ends in whitespace keeps it and is never taken for another.
const gitAnswer = (text) => text.replace(process.platform === 'win32' ? /\r?\n$/u : /\n$/u, '');

// A caller on a deadline (host delivery) bounds each git call; 0 waits. A
// directory outside the work tree git names -- a `core.worktree` elsewhere, or
// a real path that does not lie in it -- is marked `outsideWorkTree`.
export async function discoverWorkspace(cwd = process.cwd(), { timeout = 0 } = {}) {
  const work = resolve(cwd);
  try {
    // The first line is the answer; the rest is the path, which may itself hold a newline.
    const git = commandPath('git');
    if (!git) throw new Error('git is not on PATH');
    const { stdout } = await execute(git, ['rev-parse', '--is-inside-work-tree', '--show-toplevel'], { cwd: work, timeout });
    const inside = stdout.slice(0, stdout.indexOf('\n')).trim();
    const root = resolve(gitAnswer(stdout.slice(stdout.indexOf('\n') + 1)));
    const { stdout: common } = await execute(git, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: work, timeout });
    const step = relative(root, realpathSync.native(work));
    const within = step !== '..' && !step.startsWith(`..${sep}`) && !isAbsolute(step);
    return { worktreeRoot: root, commonDir: resolve(gitAnswer(common)), ...(inside === 'true' && within ? {} : { outsideWorkTree: true }) };
  } catch { return { worktreeRoot: work, commonDir: null }; }
}

export function projectBindingFile(workspace, type) {
  if (type === 'worktree') return resolve(workspace.worktreeRoot, '.shadowgraph', 'project-binding.json');
  if (type === 'shared_repository' && workspace.commonDir) return resolve(workspace.commonDir, 'shadowgraph-project-binding.json');
  throw new Error('Binding requires an explicit worktree or available shared_repository mapping');
}

function resolveFileBinding(workspace, types = ['worktree', 'shared_repository']) {
  for (const type of types) {
    if (type === 'shared_repository' && !workspace.commonDir) continue;
    try {
      const binding = JSON.parse(readFileSync(projectBindingFile(workspace, type), 'utf8'));
      if (binding?.version !== 1 || binding.type !== type || binding.path !== (type === 'worktree' ? workspace.worktreeRoot : workspace.commonDir)
        || binding.confirmed !== true || typeof binding.project !== 'string' || !binding.project.trim()) return null;
      return { project: binding.project, confirmed: true };
    } catch (error) {
      if (error.code !== 'ENOENT') return null;
    }
  }
  return null;
}

// Explicit local action only. Persist the store audit first, then activate the
// local signal. A file failure leaves the former signal intact and rejects the
// command; the store entry is history, never a fallback selection signal.
export async function bindWorkspaceProject(graph, store, workspace, input) {
  if (typeof input?.project !== 'string' || !input.project.trim() || typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('Binding requires an explicit project and reason');
  const bindingFile = projectBindingFile(workspace, input.type);
  const mapping = { type: input.type, path: input.type === 'worktree' ? workspace.worktreeRoot : workspace.commonDir, project: input.project, reason: input.reason, surface: input.surface };
  const binding = await currentAccessOperation(graph, store, () => privileged.privilegedBindProject(graph, mapping));
  await mkdir(dirname(bindingFile), { recursive: true });
  const token = randomUUID();
  let backupFile = `${bindingFile}.backup-${token}`;
  try { await copyFile(bindingFile, backupFile, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'ENOENT') throw error; backupFile = null; }
  const temporary = `${bindingFile}.tmp-${token}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, ...binding }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, bindingFile);
  return { ...binding, bindingFile, backupFile };
}

// `confirmedByStore` (host delivery's hook path, PR-32): only a worktree binding
// counts, and only when the store has recorded the same one, so files a cloned
// repository ships choose nothing (FND-P5-07). A shared-repository binding is
// not honoured there: a `.git` file placed in any directory can name another
// repository's common directory. Nor is a directory outside the work tree git
// names, since a shipped `.git` can set `core.worktree` to the owner's.
export function accessContext(graph, args, surface, workspace, { confirmedByStore = false } = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const { binding: ignoredBinding, surface: ignoredSurface, ...input } = args;
  const found = confirmedByStore && workspace.outsideWorkTree ? null : resolveFileBinding(workspace, confirmedByStore ? ['worktree'] : undefined);
  const confirmed = !confirmedByStore || privileged.privilegedResolveProjectBinding(graph, { worktreeRoot: workspace.worktreeRoot, commonDir: null })?.project === found?.project;
  const binding = found && confirmed ? found : null;
  return { ...input, ...(binding ? { binding } : {}), surface };
}

// The save's existing destination fence and expected revision are the commit
// boundary. A conflict requires a fresh lookup and complete re-evaluation; no
// result produced against a stale permission is returned to the caller.
// `read`: a read verb's audit, whose save refuses while a deletion or restore
// record waits, as no read completes one (rev6:365; PR-37d review finding 2).
export async function currentAccessOperation(graph, store, operation, { read = false } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    graph.replaceData(await store.load());
    const before = privileged.privilegedSnapshot(graph);
    try {
      let result, rejection;
      try { result = await operation(); }
      catch (error) {
        // The kernel marks only a separately committed safe effect after
        // rolling back the rejected operation's canonical mutations.
        if (!isCommittedRejection(error)) throw error;
        rejection = error;
      }
      graph.setRevision(await store.save(privileged.privilegedSnapshot(graph), read ? { pending: 'read' } : undefined));
      if (rejection) throw rejection;
      return result;
    } catch (error) {
      try { graph.replaceData(await store.load()); }
      catch { graph.replaceData(before); }
      if (error.name === 'RevisionConflictError' && attempt < 3) continue;
      throw error;
    }
  }
}
