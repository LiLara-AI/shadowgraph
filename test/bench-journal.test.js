import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  NODE_SQLITE_NOT_APPLICABLE_REASON,
  getRuntimeCapabilities
} from '../src/runtime-capabilities.js';
import { validateJournalBenchmark } from '../benchmark/lib/journal-validation.mjs';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

function syntheticJournalOutput(node, sqlite) {
  return {
    schemaVersion: 2,
    environment: { node },
    requestedSizes: [10],
    results: [{
      status: 'MEASURED',
      requestedEntries: 10,
      actualEntries: 10,
      validation: { requestedCountSatisfied: true, rebuildEquivalent: true },
      backends: {
        json: { status: 'MEASURED', actualEntries: 10, roundTripEquivalent: true },
        sqlite
      }
    }]
  };
}

function syntheticNotApplicableSqlite() {
  return {
    status: 'NOT_APPLICABLE',
    reason: NODE_SQLITE_NOT_APPLICABLE_REASON
  };
}

test('journal benchmark records reproducible counts, parity, system, timing, size, and honest RSS metrics', async () => {
  const run = await execFileAsync(process.execPath, [
    'scripts/bench-journal.mjs', '--sizes', '10', '--runs', '2', '--json'
  ], { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(run.stderr, '');
  const output = JSON.parse(run.stdout);
  assert.deepEqual(output.requestedSizes, [10]);
  assert.equal(output.environment.node, process.version);
  assert.equal(typeof output.environment.os.type, 'string');
  assert.equal(typeof output.environment.cpu.model, 'string');
  assert.equal(output.results.length, 1);
  const result = output.results[0];
  assert.equal(result.requestedEntries, 10);
  assert.equal(result.actualEntries, 10);
  assert.equal(result.wallTimeMs >= 0, true);
  assert.equal(result.rebuild.runs, 2);
  for (const name of ['p50Ms', 'p95Ms', 'minMs', 'maxMs']) assert.equal(Number.isFinite(result.rebuild[name]), true);
  assert.equal(result.validation.rebuildEquivalent, true);
  assert.equal(result.validation.requestedCountSatisfied, true);
  assert.equal(result.backends.json.actualEntries, 10);
  assert.equal(result.backends.json.roundTripEquivalent, true);
  const capabilities = await getRuntimeCapabilities();
  if (capabilities.nodeSqlite.available) {
    assert.equal(result.backends.sqlite.actualEntries, 10);
    assert.equal(result.backends.sqlite.roundTripEquivalent, true);
  } else {
    assert.equal(result.backends.sqlite.status, 'NOT_APPLICABLE');
    assert.equal(result.backends.sqlite.reason, NODE_SQLITE_NOT_APPLICABLE_REASON);
    assert.equal(result.backends.sqlite.actualEntries, null);
    assert.equal(result.backends.sqlite.roundTripEquivalent, null);
  }
  for (const backend of Object.values(result.backends).filter((item) => item.status === 'MEASURED')) {
    assert.equal(Number.isFinite(backend.saveMs), true);
    assert.equal(Number.isFinite(backend.loadMs), true);
    assert.equal(Number.isInteger(backend.fileBytes), true);
    assert.equal(Array.isArray(backend.storageFiles), true);
    assert.equal(backend.storageFiles.some((file) => file.role === 'main'), true);
    assert.equal(backend.storageFiles.reduce((total, file) => total + file.bytes, 0), backend.fileBytes);
  }
  assert.equal(result.memory.metric, 'sampled-process-rss-bytes');
  assert.equal(Number.isInteger(result.memory.peakSampledBytes), true);
  assert.equal(Number.isInteger(result.memory.currentBytes), true);
  assert.equal(output.validation.valid, true);
});

test('journal benchmark defaults include preregistered 1k, 10k, and 100k sizes with size-specific runs', async () => {
  const run = await execFileAsync(process.execPath, [
    'scripts/bench-journal.mjs', '--describe'
  ], { cwd: root, timeout: 10_000 });
  const description = JSON.parse(run.stdout);
  assert.deepEqual(description.sizes, [1000, 10000, 100000]);
  assert.deepEqual(description.runsBySize, { '1000': 5, '10000': 5, '100000': 3 });
  assert.equal(description.freshProcessPerSize, true);
});

test('journal validator accepts SQLite NOT_APPLICABLE on stable supported Node releases before 22.5', () => {
  for (const version of [
    'v20.0.0',
    'v20.19.5',
    'v21.0.0',
    'v21.7.3',
    'v22.0.0',
    'v22.4.1'
  ]) {
    const validation = validateJournalBenchmark(
      syntheticJournalOutput(version, syntheticNotApplicableSqlite())
    );
    assert.equal(validation.valid, true, `${version}: ${validation.errors.join('; ')}`);
  }
});

test('journal validator requires SQLite MEASURED at Node 22.5+ and fails closed for prerelease or malformed environment versions', () => {
  for (const version of ['v22.5.0', 'v22.5.1', 'v23.0.0', 'v24.18.0']) {
    const validation = validateJournalBenchmark(
      syntheticJournalOutput(version, syntheticNotApplicableSqlite())
    );
    assert.equal(validation.valid, false, `${version} must reject SQLite NOT_APPLICABLE`);
    assert.match(validation.errors.join('; '), /sqlite at 10.*NOT_APPLICABLE/iu);

    const measuredValidation = validateJournalBenchmark(syntheticJournalOutput(version, {
      status: 'MEASURED',
      actualEntries: 10,
      roundTripEquivalent: true
    }));
    assert.equal(measuredValidation.valid, true, `${version}: ${measuredValidation.errors.join('; ')}`);
  }

  for (const version of [
    'v20.19.0-rc.1',
    'v22.4.0+build.1',
    '20.19.0',
    'v20.19',
    'v20.x.0',
    'not-a-node-version',
    '',
    null
  ]) {
    const validation = validateJournalBenchmark(
      syntheticJournalOutput(version, syntheticNotApplicableSqlite())
    );
    assert.equal(validation.valid, false, `${String(version)} must fail closed`);
    assert.match(validation.errors.join('; '), /sqlite at 10.*NOT_APPLICABLE/iu);
  }
});

test('journal benchmark makes SQLite explicitly not applicable when node:sqlite is unavailable without invalidating other evidence', async () => {
  const run = await execFileAsync(process.execPath, [
    'scripts/bench-journal.mjs', '--sizes', '10', '--runs', '2', '--json'
  ], { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
    .then((result) => ({ ...result, code: 0 }))
    .catch((error) => ({ ...error, code: error.code }));
  const output = JSON.parse(run.stdout);
  const result = output.results[0];
  const capabilities = await getRuntimeCapabilities();

  if (capabilities.nodeSqlite.available) {
    assert.equal(run.code, 0);
    assert.equal(result.backends.sqlite.status, 'MEASURED');
    assert.equal(result.backends.sqlite.roundTripEquivalent, true);
    assert.equal(result.validation.sqliteRoundTripEquivalent, true);
    assert.equal(output.validation.valid, true);
    return;
  }

  assert.equal(run.code, 0, run.stderr);
  assert.equal(result.status, 'MEASURED');
  assert.equal(result.backends.json.status, 'MEASURED');
  assert.equal(result.backends.json.roundTripEquivalent, true);
  assert.equal(result.validation.rebuildEquivalent, true);
  assert.equal(result.backends.sqlite.status, 'NOT_APPLICABLE');
  assert.equal(result.backends.sqlite.reason, NODE_SQLITE_NOT_APPLICABLE_REASON);
  assert.equal(result.validation.sqliteRoundTripEquivalent, null);
  assert.equal(output.validation.valid, true);
  assert.equal(output.validation.errors.length, 0);
  assert.equal(output.verdict.breaches.some((breach) => /sqlite/i.test(breach)), false);

  const human = await execFileAsync(process.execPath, [
    'scripts/bench-journal.mjs', '--sizes', '10', '--runs', '1'
  ], { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(human.stderr, '');
  assert.match(human.stdout, /sqlite\s+NOT_APPLICABLE.*SQLite not measured: requires Node 22\.5\+ with node:sqlite\./is);
  assert.match(human.stdout, /VALIDATION: PASS/);
});

test('journal benchmark treats projection collection order as non-semantic at 1k', async () => {
  const run = await execFileAsync(process.execPath, [
    'scripts/bench-journal.mjs', '--sizes', '1000', '--runs', '1', '--json'
  ], { cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }).catch((error) => error);
  const output = JSON.parse(run.stdout);
  assert.equal(output.results[0].validation.rebuildEquivalent, true);
  assert.deepEqual(output.results[0].validation.rebuildComponentsEquivalent, {
    records: true,
    facts: true,
    relations: true
  });
  assert.equal(output.validation.valid, true);
});