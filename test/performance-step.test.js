import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERFORMANCE_FILE, assertDeclaredCasesPassed, declaredCases, flushPendingWrites, waitForExt4LazyInit } from '../performance/cases.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

// The delivery-budget performance cases run in their own mandatory CI step
// (PR #12). This suite test keeps that step from going missing, optional or
// behind the suite, keeps the step failing on a skipped, missing, repeated,
// failed or crashed case, and keeps the performance file out of the suite's
// discovery. It runs the step's entry script only on small stand-in files.
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const CASES = [
  'repeated and replayed deliveries on the HTTP transport stay within the declared budget',
  'a relevance read stays within the declared budget and writes nothing in its own scope',
  'a fallback read records runtime misses inside the same frozen budget',
  'a fallback read by a long or escaped project name or origin stays inside the same growth ceiling',
  'the budget check fails each category it measures rather than adjusting'
];
// The two steps, exactly, comments aside: any condition, added key or other
// command on either fails here.
const PERFORMANCE_STEP = [
  '      - name: Delivery-budget performance (dedicated, before the suite)',
  '        id: performance',
  '        run: npm run test:performance'
].join('\n');
const SUITE_STEP = [
  '      - name: Test suite',
  "        if: ${{ success() || (failure() && steps.performance.outcome == 'failure') }}",
  '        run: npm test'
].join('\n');

test('every required job runs the performance step, mandatory and before the suite', async () => {
  const workflow = (await read('.github/workflows/ci.yml')).replace(/\r\n/gu, '\n');
  const steps = workflow.split(/\n(?=      - )/u).map((step) => step.split('\n').filter((line) => !/^\s*#/u.test(line)).join('\n').trimEnd());
  const check = steps.indexOf('      - run: npm run check'), performance = steps.indexOf(PERFORMANCE_STEP), suite = steps.indexOf(SUITE_STEP);
  assert.ok(check >= 0 && performance === check + 1 && suite === performance + 1, 'npm run check, then the performance step, then the suite, each exactly as pinned');
  assert.equal(steps.filter((step) => /test:performance|id: performance/u.test(step)).length, 1, 'one performance step');
  assert.doesNotMatch(workflow, /continue-on-error/u, 'no step may fail without failing the job');
  assert.match(workflow, /\n    name: \$\{\{ matrix\.os \}\} \/ Node \$\{\{ matrix\.node-version \}\}\n/u);
  const { scripts } = JSON.parse(await read('package.json'));
  assert.equal(scripts['test:performance'], 'node performance/run.mjs');
  const entry = await read('performance/run.mjs');
  assert.match(entry, /^process\.exitCode = runPerformance\(process\.argv\[2\] \?\? PERFORMANCE_FILE\);$/mu, 'the entry script always runs the step, on the performance file unless told otherwise');
  assert.doesNotMatch(entry, /isMain|import\.meta\.url ===/u);
  assert.equal(PERFORMANCE_FILE, 'performance/default-path-budget.perf.js');
});

test('the performance file declares exactly the measured cases and is not one the suite discovers', async () => {
  assert.deepEqual(declaredCases(await read(PERFORMANCE_FILE)), CASES);
  const [folder, name] = PERFORMANCE_FILE.split('/');
  assert.notEqual(folder, 'test');
  assert.doesNotMatch(name, /^test(?:-.*)?\.[cm]?js$|[.\-_]test\.[cm]?js$/u, 'node --test would find it');
  const suite = await read('test/default-path-budget.test.js');
  for (const title of CASES) assert.equal(suite.includes(title), false, `not also in the suite: ${title}`);
});

test('the step requires every declared case to pass exactly once', () => {
  const tap = (lines) => ['TAP version 13', ...lines].join('\n');
  const passed = CASES.map((title, at) => `ok ${at + 1} - ${title}`);
  assertDeclaredCasesPassed(tap(passed), CASES);
  for (const broken of [
    passed.slice(1),
    [...passed, passed[0]],
    passed.map((line, at) => (at === 2 ? line.replace(/^ok/u, 'not ok') : line)),
    passed.map((line, at) => (at === 3 ? `${line} # SKIP not measured` : line)),
    passed.map((line, at) => (at === 4 ? `${line} # TODO later` : line))
  ]) assert.throws(() => assertDeclaredCasesPassed(tap(broken), CASES), /did not pass exactly once/u);
  assert.throws(() => assertDeclaredCasesPassed(tap(passed), []), /declares no cases/u);
});

test('the step entry script exits non-zero unless every declared case of its file passed', async (t) => {
  const root = await scratchDirectory(t), entry = fileURLToPath(new URL('../performance/run.mjs', import.meta.url));
  const header = "import test from 'node:test';\n";
  const files = {
    passing: `${header}test('a', () => {});\ntest('b', () => {});\n`,
    failing: `${header}test('a', () => {});\ntest('b', () => { throw new Error('over budget'); });\n`,
    skipped: `${header}test('a', () => {});\ntest('b', { skip: 'not measured' }, () => {});\n`,
    crashed: `${header}test('a', () => {});\nthrow new Error('crashed while loading');\n`,
    empty: `${header}\n`,
    unregistered: `${header}test('a', () => {});\nif (false) {\ntest('b', () => {});\n}\n`
  };
  const status = {};
  for (const [name, source] of Object.entries(files)) {
    const file = join(root, `${name}.perf.js`);
    await writeFile(file, source);
    status[name] = spawnSync(process.execPath, [entry, file], { encoding: 'utf8', windowsHide: true }).status;
  }
  assert.deepEqual(status, { passing: 0, failing: 1, skipped: 1, crashed: 1, empty: 1, unregistered: 1 });
});

// The step writes out the file-system writes earlier steps left pending (up to
// about 1 GB on a runner) before it measures, so the kernel's flush of them
// cannot throttle a measured save's own writes. Before that it waits, within a
// bound, for ext4 to finish initialising a fresh disk in the background. It
// records both.
test('the step writes out pending file-system writes before it measures, and records it', async (t) => {
  const root = await scratchDirectory(t), entry = fileURLToPath(new URL('../performance/run.mjs', import.meta.url));
  const file = join(root, 'flush.perf.js');
  await writeFile(file, "import test from 'node:test';\ntest('a', () => {});\n");
  const run = spawnSync(process.execPath, [entry, file], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const conditions = JSON.parse(run.stdout.match(/^performance step conditions (\{.*\})$/mu)[1]);
  assert.ok(run.stdout.indexOf('performance step conditions') < run.stdout.indexOf('TAP version'), 'flushed and recorded before any case runs');
  if (process.platform === 'win32') {
    assert.deepEqual(conditions.pendingWrites, { flushed: false, reason: 'no_system_flush' });
  } else {
    const { flushed, ms, dirtyKbBefore, dirtyKbAfter } = conditions.pendingWrites;
    assert.equal(flushed, true);
    assert.ok(ms >= 0);
    if (process.platform === 'linux') assert.ok(Number.isInteger(dirtyKbBefore) && Number.isInteger(dirtyKbAfter), JSON.stringify(conditions.pendingWrites));
  }
  if (process.platform === 'linux') assert.equal(typeof conditions.ext4LazyInit.runningAtStart, 'boolean', JSON.stringify(conditions.ext4LazyInit));
  else assert.equal(conditions.ext4LazyInit, null);
});

// ext4lazyinit zeroes a fresh runner disk's inode tables: about 3 GB over one
// to three minutes after boot, on some runners. The step waits for it, within a
// bound, polling once a second; past the bound it records that it is still
// running, and the cases still run and decide the step.
test('the step waits, within a bound, for ext4 to finish initialising the disk, and records it', () => {
  const clock = { at: 0 }, sleeps = [];
  const run = (states, boundMs) => {
    clock.at = 0; sleeps.length = 0;
    const queue = [...states];
    return waitForExt4LazyInit({ running: () => queue.shift(), sleep: (ms) => { sleeps.push(ms); clock.at += ms; }, now: () => clock.at, boundMs });
  };
  assert.equal(run([null], 5000), null, 'nothing to wait for off Linux');
  assert.deepEqual(run([false], 5000), { runningAtStart: false });
  assert.deepEqual(sleeps, []);
  assert.deepEqual(run([true, true, true, false], 5000), { runningAtStart: true, finished: true, waitedMs: 3000 });
  assert.deepEqual(sleeps, [1000, 1000, 1000], 'polls once a second');
  assert.deepEqual(run(Array(20).fill(true), 5000), { runningAtStart: true, finished: false, waitedMs: 5000 }, 'gives up at the bound');
  assert.deepEqual(run([true, null], 5000), { runningAtStart: true, finished: true, waitedMs: 1000 }, 'a check that can no longer read /proc ends the wait');
});

test('the flush is one system-wide sync, and one that fails or cannot start is recorded as not flushed', () => {
  const calls = [];
  const flushed = flushPendingWrites({ platform: 'linux', run: (command, args) => { calls.push([command, ...args]); return { status: 0 }; }, dirtyKb: () => 0 });
  assert.deepEqual([calls, { ...flushed, ms: 0 }], [[['sync']], { flushed: true, ms: 0, dirtyKbBefore: 0, dirtyKbAfter: 0 }], 'the system-wide flush, once');
  const failed = flushPendingWrites({ platform: 'linux', run: () => ({ status: 1 }), dirtyKb: () => 7 });
  assert.deepEqual({ ...failed, ms: 0 }, { flushed: false, status: 1, ms: 0, dirtyKbBefore: 7, dirtyKbAfter: 7 });
  const missing = flushPendingWrites({ platform: 'darwin', run: () => ({ status: null, error: Object.assign(new Error('spawn sync ENOENT'), { code: 'ENOENT' }) }), dirtyKb: () => null });
  assert.deepEqual({ ...missing, ms: 0 }, { flushed: false, error: 'ENOENT', ms: 0, dirtyKbBefore: null, dirtyKbAfter: null });
  assert.deepEqual(flushPendingWrites({ platform: 'win32', run: () => assert.fail('no flush is run on Windows') }), { flushed: false, reason: 'no_system_flush' });
});

test('the step creates the measured stores in the job temporary directory when CI gives one', async (t) => {
  const root = await scratchDirectory(t), job = join(root, 'job-temp'), entry = fileURLToPath(new URL('../performance/run.mjs', import.meta.url));
  await mkdir(job);
  const file = join(root, 'where.perf.js');
  await writeFile(file, "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { tmpdir } from 'node:os';\ntest('a', () => { assert.ok(tmpdir().startsWith(process.env.EXPECTED_JOB_TEMP), tmpdir()); });\n");
  const run = spawnSync(process.execPath, [entry, file], { encoding: 'utf8', windowsHide: true, env: { ...process.env, RUNNER_TEMP: job, EXPECTED_JOB_TEMP: job } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /"temporaryDirectory":"job \(RUNNER_TEMP\)"/u);
  assert.deepEqual(await readdir(job), [], 'the step removes what it created there');
});
