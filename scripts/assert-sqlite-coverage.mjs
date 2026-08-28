#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SUMMARY_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const SQLITE_TEST_FILES = [
  'test/sqlite.test.js',
  'test/sqlite-migration.test.js',
  'test/sqlite-concurrency.test.js',
  'test/sqlite-restore-failure.test.js'
];
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parseTapSummary(tap) {
  if (!/^TAP version 13\r?\n/u.test(tap)) throw new Error('malformed TAP: missing version header');
  const summary = {};
  for (const line of tap.split(/\r?\n/u)) {
    const match = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (.+)$/u.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (!/^\d+$/u.test(rawValue) || !Number.isSafeInteger(Number(rawValue))) {
      throw new Error(`invalid TAP summary value for ${key}: ${rawValue}`);
    }

    const value = Number(rawValue);
    if (Object.hasOwn(summary, key)) {
      const duplicateKind = summary[key] === value ? 'duplicate' : 'conflicting';
      throw new Error(`${duplicateKind} TAP summary field: ${key}`);
    }
    summary[key] = value;
  }
  const missing = SUMMARY_KEYS.filter((key) => !Object.hasOwn(summary, key));
  if (missing.length > 0) throw new Error(`TAP summary missing: ${missing.join(', ')}`);
  return summary;
}

export function assertTapSummary(tap) {
  const summary = parseTapSummary(tap);
  if (summary.tests === 0) throw new Error('TAP summary has no tests');

  const nonPassTotal = summary.fail + summary.cancelled + summary.skipped + summary.todo;
  const componentTotal = summary.pass + nonPassTotal;
  if (summary.pass !== summary.tests && nonPassTotal === 0) {
    throw new Error(`TAP summary pass ${summary.pass} does not equal tests ${summary.tests}`);
  }
  if (componentTotal !== summary.tests) {
    throw new Error(`TAP summary component total ${componentTotal} does not equal tests ${summary.tests}`);
  }
  if (summary.fail > 0) throw new Error(`TAP summary has fail ${summary.fail}`);
  if (summary.cancelled > 0) throw new Error(`TAP summary has cancelled ${summary.cancelled}`);
  if (summary.skipped > 0) throw new Error(`TAP summary has skipped ${summary.skipped}`);
  if (summary.todo > 0) throw new Error(`TAP summary has todo ${summary.todo}`);
  if (summary.pass !== summary.tests) {
    throw new Error(`TAP summary pass ${summary.pass} does not equal tests ${summary.tests}`);
  }
  return summary;
}

export function sqliteCoverageExitCode(testStatus, assertionError) {
  if (testStatus !== 0) return Number.isInteger(testStatus) ? testStatus : 1;
  return assertionError ? 1 : 0;
}

export function runSqliteCoverage() {
  const result = spawnSync(process.execPath, [
    '--test',
    '--test-concurrency=1',
    '--test-reporter=tap',
    ...SQLITE_TEST_FILES
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  const stdout = result.stdout ?? '';
  if (stdout) process.stdout.write(stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  let assertionError = null;
  try {
    assertTapSummary(stdout);
  } catch (error) {
    assertionError = error;
    process.stderr.write(`SQLite TAP coverage assertion failed: ${error.message}\n`);
  }
  if (result.error) {
    assertionError ??= result.error;
    process.stderr.write(`SQLite test process failed: ${result.error.message}\n`);
  }
  if (result.signal) process.stderr.write(`SQLite test process ended with signal ${result.signal}\n`);
  return sqliteCoverageExitCode(result.status, assertionError);
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) process.exitCode = runSqliteCoverage();
