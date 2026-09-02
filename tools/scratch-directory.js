// One owner for every scratch directory a test creates.
//
// The suite used to call `mkdtemp(join(tmpdir(), prefix))` in 248 places and
// remove the result in 63 of them, so a full run left 286 entries behind and a
// harness that reruns the suite filled a 16 GB tmpfs. Removal is registered
// here at the moment of creation, and four further layers cover the deaths a
// test hook cannot see:
//
//   1. `t.after`            - pass, assertion failure, setup failure, timeout, abort
//   2. `process.on('exit')` - process.exit(), natural exit, whatever the hooks missed
//   3. signal handlers      - SIGINT/SIGTERM/SIGHUP, then the signal is re-delivered
//   4. an external supervisor - SIGKILL, a crash, or a group kill
//   5. the janitor          - a root whose owner died before its supervisor was armed
//
// Nothing here redirects TMPDIR or forces Node to exit: no call to
// `process.exit`, no `--test-force-exit`, and an interrupted process still dies
// by its own signal. Every fallback names what it removed, and a failure to
// remove is reported rather than swallowed.
//
// Two exceptions to "only ever deletes what it created", both deliberate. The
// supervisor is a separate process whose whole job is to remove one root and
// exit, and the janitor removes a root belonging to a process that is provably
// gone - the only path here that touches a directory this process did not make,
// guarded by the checks at `staleReason`.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Waiting is bounded twice over: `rm` retries at most five times with a linear
// backoff (750 ms per failing syscall), and the removal hook carries its own
// wall-clock timeout, so a wedged filesystem fails one hook instead of the run.
const REMOVE = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };
const SWEEP = { recursive: true, force: true, maxRetries: 0 };
const HOOK_TIMEOUT_MS = 10_000;
const SUPERVISOR_READY_TIMEOUT_MS = 5_000;
const STALE_ROOT_AGE_MS = 600_000;
const ROOT_PATTERN = /^shadowgraph-scratch-(\d+)-[A-Za-z0-9]{6}$/u;
const OWNER_MARKER = '.owner.json';
const SIGNALS = process.platform === 'win32' ? ['SIGINT'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
const SUPERVISOR = fileURLToPath(new URL('./scratch-supervisor.mjs', import.meta.url));

const pendingRoots = new Map();   // canonical temp root -> Promise<root path>
const rootPaths = new Set();      // every armed root this process owns
const created = new Set();        // every scratch directory this process created
let netsInstalled = false;

export async function scratchDirectory(t, prefix = 'shadowgraph-') {
  if (typeof t?.after !== 'function') {
    throw new TypeError('scratchDirectory(t, prefix): t must be a node:test TestContext');
  }
  if (typeof prefix !== 'string' || prefix.length === 0 || /[\\/\u0000]/u.test(prefix)) {
    throw new TypeError('scratchDirectory(t, prefix): prefix must be a non-empty string without path separators');
  }
  const root = await processRoot();
  const directory = await mkdtemp(join(root, prefix));
  created.add(directory);
  // Registered now, so ownership never depends on the test reaching its end.
  // The outer hook only appends the removal, which therefore runs after the
  // hooks the test body registers later - closing servers, killing children -
  // rather than before them, since hooks run in registration order.
  t.after(() => t.after(async () => {
    try {
      await removeScratchDirectory(directory);
    } catch (error) {
      const failure = new Error(
        `scratch directory was not removed: ${directory} (${error.code ?? error.message})`,
        { cause: error }
      );
      // A diagnostic is reported even when the body already failed, where a
      // hook's own error is discarded; the appended hook fails an otherwise
      // green test without starving the hooks registered before it.
      t.diagnostic(failure.message);
      t.after(() => { throw failure; });
    }
  }, { timeout: HOOK_TIMEOUT_MS }));
  return directory;
}

export async function removeScratchDirectory(directory) {
  if (!created.has(directory)) {
    throw new TypeError(`removeScratchDirectory: ${directory} was not created by scratchDirectory in this process`);
  }
  try {
    await rm(directory, REMOVE);
  } catch (error) {
    if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
    await restoreOwnerAccess(directory);
    await rm(directory, REMOVE);
  }
}

// A test that makes part of its own tree read-only still owns that tree; the
// parent is never touched, because it is not ours.
async function restoreOwnerAccess(directory) {
  await chmod(directory, 0o700).catch(() => {});
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await restoreOwnerAccess(join(directory, entry.name));
  }
}

// One root per canonical temp directory, not one per process: a test may point
// process.env.TMPDIR somewhere else and create again, and both roots are swept.
function processRoot() {
  const tempRoot = canonical(tmpdir());
  let pending = pendingRoots.get(tempRoot);
  if (pending === undefined) {
    pending = createRoot(tempRoot);
    pendingRoots.set(tempRoot, pending);
    pending.catch(() => pendingRoots.delete(tempRoot));
  }
  return pending;
}

async function createRoot(tempRoot) {
  janitor(tempRoot);
  const root = await mkdtemp(join(tempRoot, `shadowgraph-scratch-${process.pid}-`));
  const nonce = randomBytes(16).toString('hex');
  try {
    writeFileSync(join(root, OWNER_MARKER), `${JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      nonce,
      startedAt: Date.now(),
      file: process.argv[1] ?? null,
      node: process.version,
      startIdentity: startIdentity(process.pid)
    })}\n`, 'utf8');
    await armSupervisor(root, nonce, tempRoot);
  } catch (error) {
    try { rmSync(root, SWEEP); } catch { /* surfaced through the original error */ }
    throw error;
  }
  installNets();
  rootPaths.add(root);
  return root;
}

// spawn() resolving proves only that a process started. The supervisor answers
// once it has validated the root and armed its end-of-pipe handler, so a root
// is never handed out unprotected; any failure removes the root and rejects.
function armSupervisor(root, nonce, tempRoot) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const environment = { ...process.env };
      delete environment.NODE_TEST_CONTEXT;
      delete environment.NODE_TEST_WORKER_ID;
      child = spawn(process.execPath, [SUPERVISOR, root, String(process.pid), nonce, tempRoot], {
        detached: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'inherit'],
        env: environment
      });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let buffer = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners('data');
      if (error) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        reject(error);
        return;
      }
      // The pipe stays open for this process's whole life - its closing is the
      // signal the supervisor waits for - but it must not hold the event loop.
      child.stdin.on('error', () => {});
      child.stdin.unref();
      child.stdout.unref();
      child.unref();
      resolve(root);
    };
    const timer = setTimeout(() => {
      finish(new Error(`scratch supervisor did not report ready within ${SUPERVISOR_READY_TIMEOUT_MS} ms`));
    }, SUPERVISOR_READY_TIMEOUT_MS);
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      finish(new Error(`scratch supervisor exited before reporting ready (code ${code}, signal ${signal})`));
    });
    child.stdin.once('error', (error) => finish(error));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      if (line === `READY ${nonce}`) finish(null);
      else finish(new Error(`scratch supervisor sent an unexpected handshake: ${JSON.stringify(line)}`));
    });
  });
}

function installNets() {
  if (netsInstalled) return;
  netsInstalled = true;
  process.on('exit', () => sweep('exit'));
  // prependListener, so this runs before a module that handles the signal by
  // calling process.exit(); listenerCount then still sees that module's once()
  // listener, and this one defers to it.
  for (const signal of SIGNALS) process.prependListener(signal, onSignal);
}

function onSignal(signal) {
  sweep(signal);
  process.removeListener(signal, onSignal);
  // With no listener left the default disposition is back, so re-delivering the
  // signal kills the process exactly as it would have died without this module.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

// Synchronous and bounded by the residue it finds, which is normally none:
// removing a root removes every directory inside it, including one a late child
// recreated after its own test had already removed it.
function sweep(reason) {
  for (const root of rootPaths) {
    let leftovers = [];
    try {
      leftovers = readdirSync(root).filter((entry) => entry !== OWNER_MARKER);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
    }
    try {
      rmSync(root, SWEEP);
    } catch (error) {
      report(`${reason} sweep could not remove ${root}: ${error.code ?? error.message}`);
      process.exitCode = 1;
      continue;
    }
    if (leftovers.length > 0) {
      report(`${reason} sweep removed ${leftovers.length} scratch ${plural(leftovers.length)} left in ${root}`);
    }
  }
}

// A root whose owner died before its supervisor could be armed, or whose
// supervisor was itself killed. Only a root whose owning process is provably
// gone is ever removed.
function janitor(tempRoot) {
  let entries = [];
  try {
    entries = readdirSync(tempRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = ROOT_PATTERN.exec(entry);
    if (match === null) continue;
    const path = join(tempRoot, entry);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
    const reason = staleReason(path, Number(match[1]), stats);
    if (reason === null) continue;
    try {
      rmSync(path, SWEEP);
      report(`removed stale scratch root ${path} (owner pid ${match[1]}, ${reason})`);
    } catch (error) {
      report(`could not remove stale scratch root ${path}: ${error.code ?? error.message}`);
    }
  }
}

function staleReason(path, namePid, stats) {
  const state = pidState(namePid);
  let marker = null;
  try {
    marker = JSON.parse(readFileSync(join(path, OWNER_MARKER), 'utf8'));
  } catch {
    marker = null;
  }
  if (marker !== null && marker.pid === namePid) {
    if (state === 'dead') return 'owner is gone';
    if (state === 'alive' && marker.startIdentity != null) {
      const current = startIdentity(namePid);
      if (current != null && current !== marker.startIdentity) return 'owner pid was reused';
    }
    return null;
  }
  // Missing or unusable marker: age alone proves nothing, so the owning pid
  // must also be provably dead before anything is removed.
  if (state !== 'dead') return null;
  if (Date.now() - stats.mtimeMs < STALE_ROOT_AGE_MS) return null;
  return 'owner is gone and the marker is unusable';
}

// Liveness is answered in this process's own pid namespace. Where a temp
// directory is shared across namespaces - a container with /tmp bind-mounted
// from its host - a pid that is alive on the other side reads as gone here, so
// a root could be removed while its owner is still running.
function pidState(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

// Linux exposes a process's start time, which distinguishes a live owner from
// an unrelated process that inherited its pid. Elsewhere a live pid is simply
// left alone and the root is removed by a later run.
function startIdentity(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function canonical(directory) {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

function plural(count) {
  return count === 1 ? 'directory' : 'directories';
}

function report(message) {
  try {
    process.stderr.write(`scratch-directory: ${message}\n`);
  } catch { /* stderr is gone; nothing further to do */ }
}
