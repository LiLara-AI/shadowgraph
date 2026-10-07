import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, open, readFile, stat, unlink, utimes } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
// deletion-knowledge.js imports nothing from here, so there is no import
// cycle (PR-37c design §3.1, check R3-4).
import { canonicalPath } from './internal/deletion-knowledge.js';

const heldDestinationFences = new AsyncLocalStorage();

export class RevisionConflictError extends Error {
  constructor(expected, actual) { super(`ShadowGraph revision conflict: expected ${expected}, found ${actual}`); this.name = 'RevisionConflictError'; this.expected = expected; this.actual = actual; }
}

export class RevisionOverflowError extends Error {
  constructor(highWaterMark) {
    super(`ShadowGraph revision overflow: no safe integer exists after ${highWaterMark}`);
    this.name = 'RevisionOverflowError';
    this.code = 'revision_overflow';
    this.highWaterMark = highWaterMark;
  }
}

export function currentRevision(payload, label = 'ShadowGraph') {
  const value = payload?.revision;
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} revision must be a non-negative safe integer`);
  return value;
}

export function nextRevisionAfter(...payloads) {
  const highWaterMark = Math.max(0, ...payloads.map((payload, index) => currentRevision(payload, `ShadowGraph revision source ${index + 1}`)));
  if (highWaterMark >= Number.MAX_SAFE_INTEGER) throw new RevisionOverflowError(highWaterMark);
  return highWaterMark + 1;
}

export function nextRevision(payload) { return { ...payload, revision: nextRevisionAfter(payload) }; }

export function assertRevision(payload, expected) {
  const actual = currentRevision(payload);
  if (expected !== undefined && expected !== actual) throw new RevisionConflictError(expected, actual);
  return actual;
}

export class DestinationFenceTimeoutError extends Error {
  constructor(lockPath, timeoutMs) {
    super(`ShadowGraph destination fence timed out after ${timeoutMs}ms: ${lockPath}`);
    this.name = 'DestinationFenceTimeoutError';
    this.code = 'storage_lock_timeout';
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
  }
}

export class DestinationFenceReentryError extends Error {
  constructor(lockPath) {
    super(`ShadowGraph destination fence is not reentrant: ${lockPath}`);
    this.name = 'DestinationFenceReentryError';
    this.code = 'storage_lock_reentrant';
    this.lockPath = lockPath;
  }
}

// Windows keeps a deleted-but-still-open file in a "delete pending" state, and every
// open of it fails with EPERM/EACCES instead of ENOENT until the last handle closes.
// A lock file is unlinked on release, so a writer that arrives during that window saw
// a hard EPERM and gave up, rather than waiting for the holder like an EEXIST wait.
// That surfaced as an external writer failing with EPERM instead of the documented
// revision conflict. These codes mean "the lock is busy right now", so they join
// EEXIST as contention and remain bounded by lockTimeoutMs; a genuine permission
// fault still fails, as an explicit fence timeout.
const LOCK_CONTENTION_CODES = new Set(
  process.platform === 'win32' ? ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'] : ['EEXIST']
);

// The one name of a store fence's lock file (PR-37c design §3.1, re-review
// NF-1): beside the store's canonical path, links followed, so every spelling
// of one store -- its 8.3 name, a link to it, a folder alias -- takes one
// fence, and a writer through another spelling can never commit inside a
// restore's hold. Every fence and every check of a fence's lock file uses it;
// the capture side-file list is the one allowed exception, its store path
// being canonical already (check R3-7). A hard link keeps its own name.
export async function fenceLockPath(file) {
  return `${await canonicalPath(file)}.lock`;
}

// A held lock path as the re-entry guard keys it: folded on win32, where a
// store not there yet keeps the case of the names it was given (check R3-4).
const heldKey = (lockPath) => (process.platform === 'win32' ? lockPath.toLowerCase() : lockPath);

export function createDestinationFence(filePath, options = {}) {
  const destination = resolve(filePath);
  const lockTimeoutMs = options.lockTimeoutMs ?? 5000;
  const staleLockMs = options.staleLockMs ?? 30000;
  const pollIntervalMs = options.lockPollIntervalMs ?? 25;
  if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 0) throw new Error('lockTimeoutMs must be a non-negative finite number');
  if (!Number.isFinite(staleLockMs) || staleLockMs <= 0) throw new Error('staleLockMs must be a positive finite number');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('lockPollIntervalMs must be a positive finite number');

  function ownerIsAlive(token) {
    const [pidText] = String(token).split(':');
    if (!/^\d+$/.test(pidText)) return false;
    try { process.kill(Number(pidText), 0); return true; }
    catch (error) { return error.code === 'EPERM'; }
  }

  async function acquire(lockPath, onWait) {
    const started = Date.now();
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    let waitingReported = false;
    // A directory it makes, and the lock, are owner-only (FND-P6-11; PR-37b).
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    while (true) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        try { await handle.writeFile(token, 'utf8'); }
        catch (error) { await handle.close().catch(() => {}); await unlink(lockPath).catch(() => {}); throw error; }
        const heartbeatMs = Math.max(10, Math.min(1000, Math.floor(staleLockMs / 3)));
        const heartbeat = setInterval(() => {
          const now = new Date();
          void utimes(lockPath, now, now).catch(() => {});
        }, heartbeatMs);
        heartbeat.unref?.();
        return async () => {
          clearInterval(heartbeat);
          await handle.close();
          try {
            if ((await readFile(lockPath, 'utf8')) === token) await unlink(lockPath);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        };
      } catch (error) {
        if (!LOCK_CONTENTION_CODES.has(error.code)) throw error;
        if (!waitingReported) {
          waitingReported = true;
          await onWait?.();
        }
        try {
          if (Date.now() - (await stat(lockPath)).mtimeMs > staleLockMs) {
            const observedToken = await readFile(lockPath, 'utf8');
            if (!ownerIsAlive(observedToken) && (await readFile(lockPath, 'utf8')) === observedToken) {
              await unlink(lockPath).catch((candidate) => { if (candidate.code !== 'ENOENT') throw candidate; });
              continue;
            }
          }
        } catch (candidate) {
          if (candidate.code === 'ENOENT') continue;
          // The same delete-pending window can also make the staleness probe fail.
          // Fall through to the timeout check and poll instead of retrying hot.
          if (!LOCK_CONTENTION_CODES.has(candidate.code)) throw candidate;
        }
        if (Date.now() - started >= lockTimeoutMs) throw new DestinationFenceTimeoutError(lockPath, lockTimeoutMs);
        await new Promise((resolveWait) => setTimeout(resolveWait, pollIntervalMs));
      }
    }
  }

  return {
    // The lock path is derived at every run, never cached (check R3-4):
    // canonicalPath falls back when realpath fails, and a value cached from
    // such a run would split the fence for the life of a long-lived store. A
    // run that misses costs that one operation.
    async run(operation, runOptions = {}) {
      const lockPath = await fenceLockPath(destination);
      const key = heldKey(lockPath);
      const inherited = heldDestinationFences.getStore();
      if (inherited?.has(key)) throw new DestinationFenceReentryError(lockPath);
      const release = await acquire(lockPath, runOptions.onWait);
      const held = new Set(inherited ?? []);
      held.add(key);
      try { return await heldDestinationFences.run(held, operation); }
      finally { await release(); }
    }
  };
}

// The restore lock (PR-37c design §3.1): a fence on `<canonical store>.restore`,
// so its lock file is `<canonical store>.restore.lock` however the store is
// spelled. The store's path is made canonical first, at every run: the
// `.restore` name never exists, so a fence on it alone would keep a short or
// linked final name. It is taken before the store fence, never while holding
// it (§3.2), with the store fence's timeouts, stale reclaim and re-entry rule.
export function restoreLock(file, options = {}) {
  return {
    async run(operation, runOptions) {
      return createDestinationFence(`${await canonicalPath(file)}.restore`, options).run(operation, runOptions);
    }
  };
}
