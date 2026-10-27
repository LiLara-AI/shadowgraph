// Started detached by the extraction trigger on Windows (extraction-trigger.js).
// It starts the worker through PowerShell's Start-Process and exits, so the
// host waits for this process alone, for about half a second. If PowerShell
// cannot start the worker, the worker is spawned directly, as elsewhere.
import { spawn } from 'node:child_process';

const { powershell, command, node, args, cwd } = JSON.parse(process.argv[2] ?? '{}');
const direct = () => spawn(node, args, { cwd, detached: true, shell: false, stdio: 'ignore', windowsHide: true }).unref();
const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, shell: false, stdio: 'ignore', windowsHide: true });
child.once('error', direct);
child.once('exit', (code) => { if (code !== 0) direct(); });
