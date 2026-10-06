#!/usr/bin/env node
// The delivery-budget performance step (`npm run test:performance`; CI runs it
// once per required job, before the suite, PR #12). It runs the performance
// cases in their own process and fails unless the run exits cleanly, the TAP
// summary has no failure, cancellation, skip or todo, and every case the file
// declares reported `ok` exactly once. It prints the execution conditions
// first (content-free), so each run records what it ran on.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

export function runPerformance() {
  const conditions = { node: process.version, platform: process.platform, arch: process.arch, parallelism: availableParallelism(),
    loadAverage: loadavg().map((value) => Number(value.toFixed(2))), freeMemoryMb: Math.round(freemem() / 2 ** 20), totalMemoryMb: Math.round(totalmem() / 2 ** 20) };
  process.stdout.write(`performance step conditions ${JSON.stringify(conditions)}\n`);
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', '--import', './test/helpers/isolated-home.mjs', PERFORMANCE_FILE], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 2 ** 20
  });
  const stdout = result.stdout ?? '';
  if (stdout) process.stdout.write(stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  try {
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`performance process ended with signal ${result.signal}`);
    if (result.status !== 0) throw new Error(`performance process exited with ${result.status}`);
    assertTapSummary(stdout);
    assertDeclaredCasesPassed(stdout, declaredCases(readFileSync(resolve(ROOT, PERFORMANCE_FILE), 'utf8')));
  } catch (error) {
    process.stderr.write(`performance step failed: ${error.message}\n`);
    return 1;
  }
  return 0;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = runPerformance();
