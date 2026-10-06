import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PERFORMANCE_FILE, assertDeclaredCasesPassed, declaredCases } from '../performance/run.mjs';

// The delivery-budget performance cases run in their own mandatory CI step
// (PR #12). This suite test keeps that step from going missing, optional or
// behind the suite, keeps the runner failing on a skipped, missing, repeated or
// failed case, and keeps the performance file out of the suite's discovery.
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const CASES = [
  'repeated and replayed deliveries on the HTTP transport stay within the declared budget',
  'a relevance read stays within the declared budget and writes nothing in its own scope',
  'a fallback read records runtime misses inside the same frozen budget',
  'a fallback read by a long or escaped project name or origin stays inside the same growth ceiling',
  'the budget check fails each category it measures rather than adjusting'
];

test('every required job runs the performance step, mandatory and before the suite', async () => {
  const workflow = (await read('.github/workflows/ci.yml')).replace(/\r\n/gu, '\n');
  const steps = workflow.split(/\n(?=      - )/u);
  const index = (pattern) => steps.findIndex((step) => pattern.test(step));
  const [check, performance, suite] = [index(/run: npm run check(?:\n|$)/u), index(/\n        id: performance(?:\n|$)/u), index(/run: npm test(?:\n|$)/u)];
  assert.ok(check >= 0 && check < performance && performance < suite, 'npm run check, then the performance step, then the suite');
  assert.match(steps[performance], /\n        run: npm run test:performance(?:\n|$)/u);
  assert.doesNotMatch(steps[performance], /\n        if:/u, 'the performance step runs in every job');
  assert.match(steps[suite], /\n        if: \$\{\{ success\(\) \|\| \(failure\(\) && steps\.performance\.outcome == 'failure'\) \}\}\n/u);
  assert.doesNotMatch(workflow, /continue-on-error/u, 'no step may fail without failing the job');
  assert.match(workflow, /name: \$\{\{ matrix\.os \}\} \/ Node \$\{\{ matrix\.node-version \}\}/u);
  assert.equal(JSON.parse(await read('package.json')).scripts['test:performance'], 'node performance/run.mjs');
});

test('the performance file declares exactly the measured cases and is not one the suite discovers', async () => {
  assert.deepEqual(declaredCases(await read(PERFORMANCE_FILE)), CASES);
  const [folder, name] = PERFORMANCE_FILE.split('/');
  assert.notEqual(folder, 'test');
  assert.doesNotMatch(name, /^test(?:-.*)?\.[cm]?js$|[.\-_]test\.[cm]?js$/u, 'node --test would find it');
  const suite = await read('test/default-path-budget.test.js');
  for (const title of CASES) assert.equal(suite.includes(title), false, `not also in the suite: ${title}`);
});

test('the performance step fails unless every declared case passed exactly once', () => {
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
