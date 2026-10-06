import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERFORMANCE_FILE, assertDeclaredCasesPassed, declaredCases } from '../performance/cases.mjs';
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
  assert.equal(await read('performance/run.mjs').then((source) => /process\.exitCode = runPerformance\(/u.test(source) && !/isMain|import\.meta\.url ===/u.test(source)), true, 'the entry script always runs the step');
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
