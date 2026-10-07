// The delivery-budget performance step's logic (PR #12), apart from its entry
// script (performance/run.mjs) so tests can import it without running it. A
// run executes the performance cases in their own process, under a fresh
// ShadowGraph home of its own, and fails unless the run exits cleanly, the TAP
// summary has no failure, cancellation, skip or todo, and every case the file
// declares reported `ok` exactly once. It prints the execution conditions
// first (content-free), so each run records what it ran on.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    temporaryDirectory: scratch ? 'job (RUNNER_TEMP)' : 'system' };
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
