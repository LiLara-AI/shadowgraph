import test from 'node:test';
import assert from 'node:assert/strict';

import { assertTapSummary, sqliteCoverageExitCode } from '../scripts/assert-sqlite-coverage.mjs';

const GREEN_TAP = `TAP version 13
ok 1 - SQLite works
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1.25
`;

test('TAP summary assertion accepts one valid full summary', () => {
  assert.deepEqual(assertTapSummary(GREEN_TAP), {
    tests: 1,
    suites: 0,
    pass: 1,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0
  });
});

test('TAP summary assertion rejects cancelled tests', () => {
  const cancelledTap = GREEN_TAP
    .replace('# pass 1', '# pass 0')
    .replace('# cancelled 0', '# cancelled 1');
  assert.throws(() => assertTapSummary(cancelledTap), /cancelled 1/u);
});

test('TAP summary assertion rejects a pass undercount', () => {
  const undercountedTap = GREEN_TAP.replace('# pass 1', '# pass 0');
  assert.throws(
    () => assertTapSummary(undercountedTap),
    /pass 0 does not equal tests 1/u
  );
});

test('TAP summary assertion rejects a pass overcount', () => {
  const overcountedTap = GREEN_TAP.replace('# pass 1', '# pass 2');
  assert.throws(
    () => assertTapSummary(overcountedTap),
    /pass 2 does not equal tests 1/u
  );
});

test('TAP summary assertion rejects inconsistent component totals', () => {
  const inconsistentTap = GREEN_TAP
    .replace('# tests 1', '# tests 2')
    .replace('# cancelled 0', '# cancelled 2');
  assert.throws(
    () => assertTapSummary(inconsistentTap),
    /component total 3 does not equal tests 2/u
  );
});

test('TAP summary assertion rejects a duplicate summary field', () => {
  const duplicateTap = GREEN_TAP.replace('# pass 1\n', '# pass 1\n# pass 1\n');
  assert.throws(
    () => assertTapSummary(duplicateTap),
    /duplicate TAP summary field: pass/u
  );
});

test('TAP summary assertion rejects a conflicting summary field', () => {
  const conflictingTap = GREEN_TAP.replace('# pass 1\n', '# pass 0\n# pass 1\n');
  assert.throws(
    () => assertTapSummary(conflictingTap),
    /conflicting TAP summary field: pass/u
  );
});

test('TAP summary assertion rejects a negative summary value', () => {
  const negativeTap = GREEN_TAP.replace('# tests 1', '# tests -1');
  assert.throws(
    () => assertTapSummary(negativeTap),
    /invalid TAP summary value for tests: -1/u
  );
});

test('TAP summary assertion rejects a noninteger summary value', () => {
  const nonintegerTap = GREEN_TAP.replace('# tests 1', '# tests 1.5');
  assert.throws(
    () => assertTapSummary(nonintegerTap),
    /invalid TAP summary value for tests: 1\.5/u
  );
});

test('TAP summary assertion rejects skipped tests', () => {
  const skippedTap = GREEN_TAP
    .replace('# pass 1', '# pass 0')
    .replace('# skipped 0', '# skipped 1');
  assert.throws(() => assertTapSummary(skippedTap), /skipped 1/u);
});

test('TAP summary assertion rejects todo tests', () => {
  const todoTap = GREEN_TAP
    .replace('# pass 1', '# pass 0')
    .replace('# todo 0', '# todo 1');
  assert.throws(() => assertTapSummary(todoTap), /todo 1/u);
});

test('TAP summary assertion rejects failing tests', () => {
  const failingTap = GREEN_TAP
    .replace('ok 1 - SQLite works', 'not ok 1 - SQLite works')
    .replace('# pass 1', '# pass 0')
    .replace('# fail 0', '# fail 1');
  assert.throws(() => assertTapSummary(failingTap), /fail 1/u);
});

test('TAP summary assertion rejects a run with no tests', () => {
  const emptyTap = GREEN_TAP
    .replace('ok 1 - SQLite works\n', '')
    .replace('1..1', '1..0')
    .replace('# tests 1', '# tests 0')
    .replace('# pass 1', '# pass 0');
  assert.throws(() => assertTapSummary(emptyTap), /no tests/u);
});

test('TAP summary assertion rejects malformed TAP', () => {
  const malformedTap = GREEN_TAP.replace('TAP version 13\n', '');
  assert.throws(() => assertTapSummary(malformedTap), /malformed TAP/u);
});

test('TAP summary assertion rejects a missing summary field', () => {
  const truncatedTap = GREEN_TAP.replace('# skipped 0\n', '');
  assert.throws(() => assertTapSummary(truncatedTap), /TAP summary missing: skipped/u);
});

test('SQLite coverage exit code preserves a nonzero test exit status', () => {
  assert.equal(sqliteCoverageExitCode(7, new Error('TAP summary has fail 1')), 7);
});
