#!/usr/bin/env node
// Run both benchmark suites, report both, fail if either fails. F38.
//
// `benchmark:test` used to be `node --test <files> && npm run
// benchmark:test:python`. Under `&&` a red JS suite means the 139 Python tests
// never run and never appear in the output - so the command reported one
// failure while silently skipping a whole language's coverage, and a reader had
// no way to tell that from a JS-only failure.
//
// Neither suite is weakened here: both always run, both summaries are printed,
// and the exit status is non-zero if either one failed.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8')
);

/**
 * The JS file list lives in `benchmark:test:js`, so it stays a single source of
 * truth that a new test file is added to, exactly as before.
 */
const jsScript = packageJson.scripts['benchmark:test:js'];
if (typeof jsScript !== 'string' || !jsScript.startsWith('node --test ')) {
  console.error('benchmark:test:js must be a `node --test <files>` script');
  process.exit(1);
}
const jsFiles = jsScript.slice('node --test '.length).trim().split(/\s+/u);

console.log('--- benchmark suite: JavaScript ---');
const jsStatus = await run(process.execPath, ['--test', ...jsFiles]);

console.log('\n--- benchmark suite: Python ---');
const pythonStatus = await run('python3', [
  '-B', '-m', 'unittest', 'discover', '-s', 'benchmark/adapters', '-p', 'test_*.py'
]);

console.log('\n--- benchmark suite summary ---');
console.log(`  JavaScript: ${jsStatus === 0 ? 'pass' : `FAIL (exit ${jsStatus})`}`);
console.log(`  Python:     ${pythonStatus === 0 ? 'pass' : `FAIL (exit ${pythonStatus})`}`);

process.exit(jsStatus === 0 && pythonStatus === 0 ? 0 : 1);
