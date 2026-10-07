// Per-user, content-free usage reservations. This is NOT backed up or restored
// with memory. Only explicit activation preparation initializes an absent file.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDestinationFence } from '../revision-store.js';
import { canonicalPath, repositoryOf } from './owner-files.js';

export const FROZEN_WORKER_BUDGETS = Object.freeze({ inputBytes: 65536, items: 4, wallMs: 240000, calls: 4,
  windowCalls: 12, windowMs: 3600000, retries: 1, backoffMs: 1000, journalEntriesPerSession: 128 });
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function usageFile(env = process.env) {
  const root = env.SHADOWGRAPH_HOME || join(homedir(), '.shadowgraph');
  if (!isAbsolute(root)) fail('worker_usage_location');
  return join(root, 'extraction-usage.json');
}
function budgetsOf(options) {
  const budgets = options.budgets ?? FROZEN_WORKER_BUDGETS;
  if (Object.keys(budgets).length !== Object.keys(FROZEN_WORKER_BUDGETS).length) fail('worker_budgets_invalid');
  for (const [key, ceiling] of Object.entries(FROZEN_WORKER_BUDGETS)) {
    if (!Number.isSafeInteger(budgets[key]) || budgets[key] <= 0 || budgets[key] > ceiling
      || (['windowMs', 'retries', 'backoffMs'].includes(key) && budgets[key] !== ceiling)) fail('worker_budgets_invalid');
  }
  return Object.freeze({ ...budgets });
}
async function checkedFile(options) {
  const file = usageFile(options.env);
  if (await repositoryOf(file)) fail('worker_usage_location');
  // Resolve parent aliases, but refuse aliasing the control file itself.
  const parent = await canonicalPath(dirname(file));
  return join(parent, 'extraction-usage.json');
}
async function load(file, allowMissing = false) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || resolve(await realpath(file)).toLowerCase() !== resolve(file).toLowerCase()) fail('worker_usage_unavailable');
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value?.version !== 1 || !Number.isSafeInteger(value.highWater) || value.highWater < 0 || !Array.isArray(value.calls)
      || value.calls.length > FROZEN_WORKER_BUDGETS.windowCalls || Object.keys(value).sort().join() !== 'calls,highWater,version'
      || value.calls.some((at, i) => !Number.isSafeInteger(at) || at < 0 || at > value.highWater || (i && at < value.calls[i - 1]))) fail('worker_usage_unavailable');
    return value;
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    fail('worker_usage_unavailable');
  }
}
async function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    // File fsync + atomic rename, matching the control ledger discipline.
    // Windows lacks portable directory fsync; no power-loss durability claim.
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
const instant = options => {
  const at = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(at) || at < 0) fail('worker_clock_invalid');
  return at;
};
export async function initializeUsage(options = {}) {
  budgetsOf(options); const file = await checkedFile(options);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  return createDestinationFence(file, { lockTimeoutMs: options.lockTimeoutMs ?? 0 }).run(async () => {
    const prior = await load(file, true);
    if (!prior) await save(file, { version: 1, highWater: instant(options), calls: [] });
  });
}
export async function withWorkerBudget(options, operation) {
  const budgets = budgetsOf(options), file = await checkedFile(options);
  const monotonic = options.monotonic ?? (() => performance.now()), started = monotonic();
  return createDestinationFence(file, { lockTimeoutMs: options.lockTimeoutMs ?? 0 }).run(async () => {
    await load(file); let calls = 0, items = 0;
    const check = () => { if (options.signal?.aborted) fail('drain_stopped'); if (monotonic() - started >= budgets.wallMs) fail('drain_time'); };
    return operation({ budgets, check,
      admit({ inputBytes, journalEntries }) {
        check();
        if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 || inputBytes > budgets.inputBytes) fail('input_bytes');
        if (!Number.isSafeInteger(journalEntries) || journalEntries < 0 || journalEntries > budgets.journalEntriesPerSession) fail('session_journal');
        if (items >= budgets.items) fail('drain_items');
        items += 1;
      },
      async reserve() {
        check(); if (calls >= budgets.calls) fail('drain_calls');
        const value = await load(file), at = Math.max(instant(options), value.highWater);
        const kept = value.calls.filter(time => time > at - budgets.windowMs);
        if (kept.length >= budgets.windowCalls) fail('window_calls');
        check(); await save(file, { version: 1, highWater: at, calls: [...kept, at] });
        calls += 1; check();
      }
    });
  });
}
