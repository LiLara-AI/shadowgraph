// Capture only requests a separate one-shot CLI process. No executor import,
// model call, listener, store access, or wait for extraction occurs in the hook.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeExtraction } from './extraction-state.js';
import { canonicalPath } from './owner-files.js';
import { usageFile } from './extraction-budget.js';
const ELIGIBLE = new Set(['written', 'nothing_new', 'already_held', 'transcript', 'refused']);
// The worker gets what the executor passes to its own child, plus ShadowGraph's
// configuration, never the host session's environment: a desktop host sets its
// own provider route (ANTHROPIC_BASE_URL) and session tokens in every hook, and
// the executor refuses any provider variable it is handed.
const WORKER_ENV = new Set(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']);
export const workerEnvironment = env => Object.fromEntries(Object.entries(env)
  .filter(([name, value]) => typeof value === 'string' && (WORKER_ENV.has(name.toUpperCase()) || /^SHADOWGRAPH_/iu.test(name))));
export async function triggerExtraction({ event, outcome, deadline, env = process.env, spawnProcess = spawn,
  runtimeDirectory = dirname(dirname(dirname(fileURLToPath(import.meta.url)))) } = {}) {
  const inert = { status: 'inert' };
  if (!['Stop', 'SessionEnd'].includes(event) || !ELIGIBLE.has(outcome) || !Number.isFinite(deadline) || Date.now() >= deadline) return inert;
  try {
    const activation = await activeExtraction(env);
    if (!activation || await canonicalPath(runtimeDirectory) !== activation.runtime.path || Date.now() >= deadline) return inert;
    const child = spawnProcess(process.execPath, [join(activation.runtime.path, 'src', 'cli.js'), 'extract', '--automatic'], {
      cwd: dirname(usageFile(env)), env: { ...workerEnvironment(env), NoDefaultCurrentDirectoryInExePath: '1' }, detached: true, shell: false, stdio: 'ignore', windowsHide: true
    });
    child.once('error', () => {}); child.unref();
    return { status: 'requested' }; // Actual detached survival is host evidence.
  } catch { return inert; }
}
