import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

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
  assert.equal(result.backends.sqlite.actualEntries, 10);
  assert.equal(result.backends.json.roundTripEquivalent, true);
  assert.equal(result.backends.sqlite.roundTripEquivalent, true);
  for (const backend of Object.values(result.backends)) {
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