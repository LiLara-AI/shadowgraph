import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { constants, readFileSync } from 'node:fs';
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as privileged from './snapshot.js';
import { isCommittedRejection } from '../shadowgraph.js';

const execute = promisify(execFile);

export const hasAccessReference = (input) => Boolean(input && (Object.hasOwn(input, 'accessId') || Object.hasOwn(input, 'grantId') || input.readProvenance?.accessId));

export async function discoverWorkspace(cwd = process.cwd()) {
  const work = resolve(cwd);
  try {
    const { stdout: root } = await execute('git', ['rev-parse', '--show-toplevel'], { cwd: work });
    const { stdout: common } = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: work });
    return { worktreeRoot: resolve(root.trim()), commonDir: resolve(common.trim()) };
  } catch { return { worktreeRoot: work, commonDir: null }; }
}

export function projectBindingFile(workspace, type) {
  if (type === 'worktree') return resolve(workspace.worktreeRoot, '.shadowgraph', 'project-binding.json');
  if (type === 'shared_repository' && workspace.commonDir) return resolve(workspace.commonDir, 'shadowgraph-project-binding.json');
  throw new Error('Binding requires an explicit worktree or available shared_repository mapping');
}

function resolveFileBinding(workspace) {
  for (const type of ['worktree', 'shared_repository']) {
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

export function accessContext(graph, args, surface, workspace) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const { binding: ignoredBinding, surface: ignoredSurface, ...input } = args;
  const binding = resolveFileBinding(workspace);
  return { ...input, ...(binding ? { binding } : {}), surface };
}

// The save's existing destination fence and expected revision are the commit
// boundary. A conflict requires a fresh lookup and complete re-evaluation; no
// result produced against a stale permission is returned to the caller.
export async function currentAccessOperation(graph, store, operation) {
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
      graph.setRevision(await store.save(privileged.privilegedSnapshot(graph)));
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
