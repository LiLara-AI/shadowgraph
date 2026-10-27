// Capture only requests a separate one-shot CLI process. No executor import,
// model call, listener, store access, or wait for extraction occurs in the hook.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeExtraction, requestFile } from './extraction-state.js';
import { canonicalPath } from './owner-files.js';
import { usageFile } from './extraction-budget.js';
import { accountEmailDigest } from './extraction-contract.js';
import { sessionProfileSelected } from './extraction-provenance.js';
const ELIGIBLE = new Set(['written', 'nothing_new', 'already_held', 'transcript', 'refused']);
// The worker gets what the executor passes to its own child, plus ShadowGraph's
// configuration, never the host session's environment: a desktop host sets its
// own provider route (ANTHROPIC_BASE_URL) and session tokens in every hook, and
// the executor refuses any provider variable it is handed.
const WORKER_ENV = new Set(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'SYSTEMDRIVE', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']);
export const workerEnvironment = env => Object.fromEntries(Object.entries(env)
  .filter(([name, value]) => typeof value === 'string' && (WORKER_ENV.has(name.toUpperCase()) || /^SHADOWGRAPH_/iu.test(name))));
// On Windows the Claude Code CLI waits, on exit, for every process its hooks
// started, detached or not (live probe X3, 2026-10-27: `claude -p` exited only
// when a detached 25 s child of its Stop hook had). The worker is therefore
// started through PowerShell's Start-Process, which starts it by ShellExecute
// and hands it none of the hook's handles. PowerShell itself returns at once;
// it is not detached, since Windows PowerShell given no console exits at once.
const psQuote = value => `'${String(value).replace(/'/gu, "''")}'`;
export function workerLaunch({ node, args, cwd, env, platform = process.platform }) {
  const options = { cwd, env, detached: platform !== 'win32', shell: false, stdio: 'ignore', windowsHide: true };
  if (platform !== 'win32') return [node, args, options];
  const systemRoot = Object.entries(env).find(([name]) => name.toUpperCase() === 'SYSTEMROOT')?.[1] || 'C:\\Windows';
  const command = `Start-Process -FilePath ${psQuote(node)} -ArgumentList ${args.map(arg => psQuote(`"${arg}"`)).join(',')} -WorkingDirectory ${psQuote(cwd)} -WindowStyle Hidden`;
  return [join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], options];
}
// A session under another profile or a session token may be another account.
// The worker would run under the default profile's account, so such a session
// never starts it, as before the worker's environment was filtered. A desktop
// host names its session's account (CLAUDE_CODE_USER_EMAIL); one that is not the
// bound account does not start it either.
export async function triggerExtraction({ event, outcome, deadline, env = process.env, spawnProcess = spawn, platform = process.platform,
  runtimeDirectory = dirname(dirname(dirname(fileURLToPath(import.meta.url)))) } = {}) {
  const inert = { status: 'inert' };
  if (!['Stop', 'SessionEnd'].includes(event) || !ELIGIBLE.has(outcome) || !Number.isFinite(deadline) || Date.now() >= deadline) return inert;
  try {
    const activation = await activeExtraction(env);
    if (!activation || await canonicalPath(runtimeDirectory) !== activation.runtime.path || Date.now() >= deadline) return inert;
    if (sessionProfileSelected(env)) return { status: 'refused', reason: 'session_profile_selected' };
    const sessionEmail = Object.entries(env).find(([name]) => name.toUpperCase() === 'CLAUDE_CODE_USER_EMAIL')?.[1];
    const bound = activation.executor.accountEmailFingerprint;
    if (typeof sessionEmail === 'string' && sessionEmail.trim() && (!bound || accountEmailDigest(activation.executor.accountSalt, sessionEmail) !== bound)) return { status: 'refused', reason: 'session_account_differs' };
    await writeFile(requestFile(env), `${new Date().toISOString()}\n`, { mode: 0o600 }).catch(() => {});
    const child = spawnProcess(...workerLaunch({ node: process.execPath, args: [join(activation.runtime.path, 'src', 'cli.js'), 'extract', '--automatic'],
      cwd: dirname(usageFile(env)), env: { ...workerEnvironment(env), NoDefaultCurrentDirectoryInExePath: '1' }, platform }));
    child.once('error', () => {}); child.unref();
    return { status: 'requested' }; // Actual detached survival is host evidence.
  } catch { return inert; }
}
