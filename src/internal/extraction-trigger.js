// Capture only requests a separate one-shot CLI process. No executor import,
// model call, listener, store access, or wait for extraction occurs in the hook.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeExtraction } from './extraction-state.js';
import { canonicalPath } from './owner-files.js';
import { usageFile } from './extraction-budget.js';
const ELIGIBLE = new Set(['written', 'nothing_new', 'already_held', 'transcript', 'refused']);
export async function triggerExtraction({ event, outcome, deadline, env = process.env, spawnProcess = spawn,
  runtimeDirectory = dirname(dirname(dirname(fileURLToPath(import.meta.url)))) } = {}) {
  const inert = { status: 'inert' };
  if (!['Stop', 'SessionEnd'].includes(event) || !ELIGIBLE.has(outcome) || !Number.isFinite(deadline) || Date.now() >= deadline) return inert;
  try {
    const activation = await activeExtraction(env);
    if (!activation || await canonicalPath(runtimeDirectory) !== activation.runtime.path || Date.now() >= deadline) return inert;
    const child = spawnProcess(process.execPath, [join(activation.runtime.path, 'src', 'cli.js'), 'extract', '--automatic'], {
      cwd: dirname(usageFile(env)), env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' }, detached: true, shell: false, stdio: 'ignore', windowsHide: true
    });
    child.once('error', () => {}); child.unref();
    return { status: 'requested' }; // Actual detached survival is host evidence.
  } catch { return inert; }
}
