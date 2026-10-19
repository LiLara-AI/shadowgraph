// The delivery-budget performance step's logic (PR #12), apart from its entry
// script (performance/run.mjs) so tests can import it without running it. A
// run executes the performance cases in their own process, under a fresh
// ShadowGraph home of its own, and fails unless the run exits cleanly, the TAP
// summary has no failure, cancellation, skip or todo, and every case the file
// declares reported `ok` exactly once. Before the cases it writes out the
// file-system writes earlier steps left pending, and it prints the execution
// conditions first (content-free, that flush included), so each run records
// what it ran on.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, freemem, loadavg, tmpdir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTapSummary } from '../scripts/assert-sqlite-coverage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PERFORMANCE_FILE = 'performance/default-path-budget.perf.js';

// The cases the file declares: every top-level test('…') title.
export function declaredCases(source) {
  return [...source.matchAll(/^test\('((?:[^'\\]|\\.)+)'/gmu)].map(([, title]) => title.replaceAll("\\'", "'"));
}

// Fails unless each declared case reported a plain top-level `ok` exactly once.
export function assertDeclaredCasesPassed(tap, cases) {
  if (cases.length === 0) throw new Error('the performance file declares no cases');
  for (const title of cases) {
    const lines = tap.split(/\r?\n/u).filter((line) => /^(?:not )?ok \d+ - /u.test(line) && line.replace(/^(?:not )?ok \d+ - /u, '').startsWith(title));
    if (lines.length !== 1 || !lines[0].startsWith('ok ') || /#\s*(?:SKIP|TODO)/iu.test(lines[0])) {
      throw new Error(`performance case did not pass exactly once: ${title}`);
    }
  }
}

// Pending writes, in kB, where the system reports them (Linux); null elsewhere.
function systemDirtyKb() {
  try { return Number(readFileSync('/proc/meminfo', 'utf8').match(/^Dirty:\s+(\d+) kB$/mu)[1]); } catch { return null; }
}

// Writes out the file-system writes earlier steps left pending, before any
// case runs. On a GitHub Ubuntu runner the job's setup leaves up to about 1 GB
// of dirty pages, which the kernel writes out 30 s later, often during this
// step; its writeback throttling then holds a measured save's own write behind
// them: a rename over the store first writes out the new file's data (ext4
// auto_da_alloc), and slept in wbt_wait (traced on the runner). Every measured
// save still writes, renames and waits for its own I/O inside its delivery's
// time; this removes only the earlier steps' backlog. Windows has no
// system-wide flush, so nothing is run there. A flush that fails is recorded,
// and the cases still run and decide the step.
export function flushPendingWrites({ platform = process.platform, run = spawnSync, dirtyKb = systemDirtyKb } = {}) {
  if (platform === 'win32') return { flushed: false, reason: 'no_system_flush' };
  const dirtyKbBefore = dirtyKb(), started = performance.now();
  const result = run('sync', [], { stdio: 'ignore', windowsHide: true, timeout: 300_000 });
  const outcome = result.status === 0 ? { flushed: true } : { flushed: false, ...(result.error ? { error: String(result.error.code ?? result.error.message) } : { status: result.status }) };
  return { ...outcome, ms: Math.round(performance.now() - started), dirtyKbBefore, dirtyKbAfter: dirtyKb() };
}

// Whether ext4 is still zeroing inode tables in the background (the
// ext4lazyinit thread of a freshly provisioned disk), which writes throughout
// the step and is not pending writes a flush removes; null off Linux.
export function ext4LazyInitRunning(platform = process.platform) {
  if (platform !== 'linux') return null;
  const named = (pid) => { try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'ext4lazyinit'; } catch { return false; } };
  try { return readdirSync('/proc').some((pid) => /^\d+$/u.test(pid) && named(pid)); } catch { return null; }
}

// Returns the step's exit code: 0 only when every check above holds.
export function runPerformance(file = PERFORMANCE_FILE) {
  // Where the measured stores are created: in the job's own temporary directory
  // when CI gives one (RUNNER_TEMP; on GitHub's runners it is on the workspace
  // disk, where a project's .shadowgraph store lives), otherwise in the
  // system's. The workload and every file operation are the same either way.
  const job = process.env.RUNNER_TEMP;
  const scratch = job && isAbsolute(job) && existsSync(job) ? mkdtempSync(join(job, 'shadowgraph-performance-')) : null;
  const conditions = { node: process.version, platform: process.platform, arch: process.arch, parallelism: availableParallelism(),
    loadAverage: loadavg().map((value) => Number(value.toFixed(2))), freeMemoryMb: Math.round(freemem() / 2 ** 20), totalMemoryMb: Math.round(totalmem() / 2 ** 20),
    temporaryDirectory: scratch ? 'job (RUNNER_TEMP)' : 'system', pendingWrites: flushPendingWrites(), ext4LazyInit: ext4LazyInitRunning() };
  process.stdout.write(`performance step conditions ${JSON.stringify(conditions)}\n`);
  const home = mkdtempSync(join(scratch ?? tmpdir(), 'shadowgraph-performance-home-'));
  // A caller that is itself a test process marks its environment; the child
  // must not inherit that mark, or node would skip the files it was given.
  const { NODE_TEST_CONTEXT: _inheritedTestContext, ...env } = process.env;
  try {
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', '--import', './test/helpers/isolated-home.mjs', file], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 2 ** 20,
      env: { ...env, SHADOWGRAPH_HOME: home, ...(scratch ? { TMPDIR: scratch, TEMP: scratch, TMP: scratch } : {}) }
    });
    const stdout = result.stdout ?? '';
    if (stdout) process.stdout.write(stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`performance process ended with signal ${result.signal}`);
    if (result.status !== 0) throw new Error(`performance process exited with ${result.status}`);
    assertTapSummary(stdout);
    assertDeclaredCasesPassed(stdout, declaredCases(readFileSync(resolve(ROOT, file), 'utf8')));
    return 0;
  } catch (error) {
    process.stderr.write(`performance step failed: ${error.message}\n`);
    return 1;
  } finally {
    // Removing the temporary directories cannot change the result.
    for (const directory of [home, scratch].filter(Boolean)) {
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* left behind in the temporary directory */ }
    }
  }
}
