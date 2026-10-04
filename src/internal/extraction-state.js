// Read-only operational state. Safe for hooks/delivery: no executor import,
// store writes, process probes, credential reads, or automatic initialization.
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createDestinationFence, fenceLockPath } from '../revision-store.js';
import { FROZEN_WORKER_BUDGETS, usageFile } from './extraction-budget.js';
import { canonicalPath, repositoryOf, writeJsonAtomically } from './owner-files.js';

export const workerFenceFile = (env = process.env) => join(dirname(usageFile(env)), 'extraction-worker');
export const settlementFile = env => `${workerFenceFile(env)}.settlement.json`;
export function validExecutorReceipt(value) {
  return value?.ok === true && typeof value.executable === 'string' && isAbsolute(value.executable)
    && /^[0-9a-f]{64}$/.test(value.binarySha256 ?? '') && value.hostVersion === '2.1.288'
    && value.model === 'claude-opus-5[1m]' && Array.from({ length: 10 }, (_, i) => `E-${i + 1}`).every(key => value.restrictions?.[key] === true);
}
const sameStore = (a, b) => a?.file === b?.file && a?.storage === b?.storage;
const sameRuntime = (a, b) => a?.path === b?.path && a?.commit === b?.commit;
export async function activeExtraction(env = process.env) {
  try {
    const file = join(dirname(usageFile(env)), 'activation.json'), stat = await lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const record = JSON.parse(await readFile(file, 'utf8')), value = record?.capabilities?.extraction;
    if (record.version !== 1 || value?.state !== 'active' || !/^[0-9a-f-]{36}$/.test(value.activationId ?? '')
      || value.noOverageConfirmed !== true || !isDeepStrictEqual(value.budgets, FROZEN_WORKER_BUDGETS)
      || value.model !== 'claude-opus-5[1m]' || !validExecutorReceipt(value.executor)
      || typeof value.store?.file !== 'string' || !isAbsolute(value.store.file) || !['json', 'sqlite'].includes(value.store.storage)
      || value.runtime?.extraction !== true || typeof value.runtime.path !== 'string' || !isAbsolute(value.runtime.path)
      || !/^[0-9a-f]{40}$/.test(value.runtime.commit ?? '')) return null;
    // Capture enrollment is the automatic writer's scope, never a read grant.
    const capture = record.capabilities.capture;
    if (capture?.state !== 'active' || !sameStore(capture.store, value.store) || !sameRuntime(capture.runtime, value.runtime)) return null;
    const delivery = record.capabilities.delivery;
    if (delivery?.state === 'active' && (!sameStore(delivery.store, value.store) || !sameRuntime(delivery.runtime, value.runtime))) return null;
    return value;
  } catch { return null; }
}
export async function workerFence(env, timeoutMs = 0) {
  const file = workerFenceFile(env);
  if (await repositoryOf(file)) throw new Error('extraction_worker_inside_repository');
  return createDestinationFence(await canonicalPath(file), { lockTimeoutMs: timeoutMs, staleLockMs: 2000 });
}
export async function workerSettlement(env = process.env) {
  let markerFound = false;
  try {
    const file = workerFenceFile(env), stat = await lstat(file); markerFound = true;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) return 'unconfirmed';
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value?.version !== 1) return 'unconfirmed';
    if (value.state === 'stopped') return 'clear';
    if (value.state === 'preparing' && Number.isSafeInteger(value.pid) && value.pid > 0) {
      try { process.kill(value.pid, 0); } catch (error) { if (error.code === 'ESRCH') return 'clear'; }
    }
    if (typeof value.invocationId === 'string') {
      const receiptFile = settlementFile(env), stat = await lstat(receiptFile);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) return 'unconfirmed';
      const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
      if (receipt?.version === 1 && receipt.invocationId === value.invocationId && receipt.localChildStopped === true) return 'clear';
    }
    return 'unconfirmed';
  } catch (error) {
    if (!markerFound && error.code === 'ENOENT') return 'clear';
    return 'unconfirmed';
  }
}
export async function recordWorkerSettlement(env, state, activationId) {
  let identity = {};
  if (state === 'unconfirmed') {
    const previous = JSON.parse(await readFile(workerFenceFile(env), 'utf8'));
    if (previous.activationId === activationId && previous.pid === process.pid && previous.invocationId) identity = { invocationId: previous.invocationId, supervisorPid: previous.supervisorPid };
  }
  await writeJsonAtomically(workerFenceFile(env), { version: 1, state, activationId, pid: process.pid, ...identity, at: new Date().toISOString() });
}
export async function waitForExtractionStop({ env = process.env, cleanupTimeoutMs = 2000 } = {}) {
  try {
    const timeout = Number.isFinite(cleanupTimeoutMs) ? Math.max(0, Math.min(cleanupTimeoutMs, 5000)) : 2000;
    const lock = await fenceLockPath(await canonicalPath(workerFenceFile(env)));
    if (await lstat(lock).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) await (await workerFence(env, timeout)).run(async () => {});
    if (await workerSettlement(env) !== 'clear') throw new Error('worker_settlement_unconfirmed');
    return { status: 'complete', localWorkerStopped: true, remoteCancellationClaimed: false };
  } catch { return { status: 'deferred', reason: 'worker_stop_unconfirmed', localWorkerStopped: false, remoteCancellationClaimed: false }; }
}
