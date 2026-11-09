import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, link, utimes } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { FROZEN_WORKER_BUDGETS, initializeUsage, withWorkerBudget, usageFile } from '../src/internal/extraction-budget.js';

async function setup(t, budgets = {}) {
  const root = await scratchDirectory(t); let at = Date.parse('2026-10-01T00:00:00Z'), elapsed = 0;
  const options = { env: { SHADOWGRAPH_HOME: root }, budgets: { ...FROZEN_WORKER_BUDGETS, ...budgets }, now: () => at, monotonic: () => elapsed };
  await initializeUsage(options);
  return { options, file: usageFile(options.env), clock: n => { at += n; }, elapsed: n => { elapsed += n; } };
}
test('budgets: frozen values are finite and cannot be widened by a worker', async t => {
  assert.deepEqual(FROZEN_WORKER_BUDGETS, { inputBytes: 65536, items: 4, wallMs: 240000, calls: 4, windowCalls: 12, windowMs: 3600000, retries: 1, backoffMs: 1000, journalEntriesPerSession: 128 });
  const f = await setup(t);
  for (const key of ['inputBytes', 'items', 'wallMs', 'calls', 'windowCalls', 'journalEntriesPerSession']) {
    await assert.rejects(withWorkerBudget({ ...f.options, budgets: { ...f.options.budgets, [key]: FROZEN_WORKER_BUDGETS[key] + 1 } }, async () => {}), { code: 'worker_budgets_invalid' });
  }
});
test('budgets: durable call reservation survives a crash and a new drain', async t => {
  const f = await setup(t, { windowCalls: 1 });
  await assert.rejects(withWorkerBudget(f.options, async b => { await b.reserve(); throw new Error('simulated lost result'); }), /simulated/);
  assert.equal(JSON.parse(await readFile(f.file)).calls.length, 1);
  await assert.rejects(withWorkerBudget(f.options, b => b.reserve()), { code: 'window_calls' });
  await initializeUsage(f.options); // Re-activation must preserve consumption.
  await assert.rejects(withWorkerBudget(f.options, b => b.reserve()), { code: 'window_calls' });
});
test('budgets: missing or malformed usage refuses, never silently resets', async t => {
  const f = await setup(t); await unlink(f.file);
  await assert.rejects(withWorkerBudget(f.options, b => b.reserve()), { code: 'worker_usage_unavailable' });
  await writeFile(f.file, '{}');
  await assert.rejects(initializeUsage(f.options), { code: 'worker_usage_unavailable' });
  await assert.rejects(withWorkerBudget(f.options, b => b.reserve()), { code: 'worker_usage_unavailable' });
});
test('budgets: clock reversal never refunds; rolling window expiry permits a new call', async t => {
  const f = await setup(t, { windowCalls: 1 });
  await withWorkerBudget(f.options, b => b.reserve());
  f.clock(-3600000); await assert.rejects(withWorkerBudget(f.options, b => b.reserve()), { code: 'window_calls' });
  f.clock(7200000); await withWorkerBudget(f.options, b => b.reserve());
  assert.equal(JSON.parse(await readFile(f.file)).calls.length, 1);
});
test('budgets: one per-user worker excludes a concurrent drain', async t => {
  const f = await setup(t); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const held = withWorkerBudget(f.options, () => new Promise(resolve => { release = resolve; entered(); }));
  await ready;
  try { await assert.rejects(withWorkerBudget({ ...f.options, lockTimeoutMs: 0 }, async () => {}), /lock|fence/i); }
  finally { release(); await held; }
});
test('budgets: every independent ceiling stops before reservation and never widens', async t => {
  const f = await setup(t, { calls: 1, items: 1 });
  await withWorkerBudget(f.options, async b => {
    assert.throws(() => b.admit({ inputBytes: 65537, journalEntries: 0 }), { code: 'input_bytes' });
    assert.throws(() => b.admit({ inputBytes: 1, journalEntries: 129 }), { code: 'session_journal' });
    b.admit({ inputBytes: 1, journalEntries: 0 });
    assert.throws(() => b.admit({ inputBytes: 1, journalEntries: 0 }), { code: 'drain_items' });
    await b.reserve(); await assert.rejects(b.reserve(), { code: 'drain_calls' });
  });
  await withWorkerBudget(f.options, async b => { f.elapsed(240000); assert.throws(() => b.check(), { code: 'drain_time' }); await assert.rejects(b.reserve(), { code: 'drain_time' }); });
});
test('budgets: reservation bytes are content-free and rejected aliases leave original unchanged', async t => {
  const f = await setup(t); await withWorkerBudget(f.options, b => b.reserve());
  const data = JSON.parse(await readFile(f.file));
  assert.deepEqual(Object.keys(data).sort(), ['calls', 'highWater', 'version']); assert.equal(data.version, 1);
  assert.ok(data.calls.every(Number.isSafeInteger));
  const before = await readFile(f.file); await link(f.file, join(f.options.env.SHADOWGRAPH_HOME, 'alias.json'));
  await assert.rejects(withWorkerBudget(f.options, b => b.reserve()), { code: 'worker_usage_unavailable' });
  assert.deepEqual(await readFile(f.file), before);
});

test('budgets: killed worker retains reservation; another process and store cannot evade its user fence', async t => {
  const f = await setup(t, { windowCalls: 1 });
  const module = new URL('../src/internal/extraction-budget.js', import.meta.url).href;
  const options = { env: f.options.env, budgets: f.options.budgets, file: join(f.options.env.SHADOWGRAPH_HOME, 'store-a'), lockTimeoutMs: 0 };
  const prelude = `import {withWorkerBudget} from ${JSON.stringify(module)}; const options=${JSON.stringify(options)};`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `${prelude} await withWorkerBudget(options,async b=>{await b.reserve();process.stdout.write('reserved');await new Promise(()=>setInterval(()=>{},1000));});`], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  await Promise.race([once(child.stdout, 'data'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('child did not reserve')), 5000); timer.unref(); })]);
  const attempt = async () => {
    const next = spawn(process.execPath, ['--input-type=module', '-e', `${prelude} options.file='another-synthetic-store';try{await withWorkerBudget(options,b=>b.reserve());console.log('unexpected-call');}catch(e){console.log(e.code ?? e.name);}`], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = ''; next.stdout.on('data', x => { text += x; }); const [exit] = await once(next, 'exit'); assert.equal(exit, 0); return text.trim();
  };
  assert.match(await attempt(), /FENCE|Fence|fence|lock/i);
  const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
  await utimes(`${f.file}.lock`, new Date(0), new Date(0));
  assert.equal(await attempt(), 'window_calls');
  assert.equal(JSON.parse(await readFile(f.file)).calls.length, 1);
});
