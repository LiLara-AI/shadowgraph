import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertCliOutcomeEqual } from '../tools/assert-cli-outcome.js';

const header = 'ExperimentalWarning: SQLite is an experimental feature and might change at any time';
const hint = '(Use `node --trace-warnings ...` to show where the warning was created)';
const refusal = 'ShadowGraph decision failed: Caller-supplied creation IDs are not supported';
const warning = (pid, newline = '\n') => `(node:${pid}) ${header}${newline}${hint}${newline}`;
const outcome = (stderr, overrides = {}) => ({ status: 1, signal: null, stdout: '', stderr, ...overrides });

for (const newline of ['\n', '\r\n']) test(`CLI parity recognizes only the SQLite warning PID (${JSON.stringify(newline)}) and retains raw output`, () => {
  const actual = Object.freeze(outcome(warning(123, newline) + refusal + newline));
  const expected = Object.freeze(outcome(warning(456, newline) + refusal + newline));
  const before = JSON.stringify([actual, expected]);
  assertCliOutcomeEqual(actual, expected);
  assert.equal(JSON.stringify([actual, expected]), before);
  assert.ok(actual.stderr.includes('(node:123)'));
  assert.ok(expected.stderr.includes('(node:456)'));
});

test('CLI parity accepts identical outcomes with no warning', () => {
  assertCliOutcomeEqual(outcome(refusal), outcome(refusal));
});

for (const [name, left, right] of [
  ['exit status', outcome(refusal), outcome(refusal, { status: 2 })],
  ['termination signal', outcome(refusal), outcome(refusal, { signal: 'SIGTERM' })],
  ['stdout', outcome(refusal), outcome(refusal, { stdout: 'unexpected output' })],
  ['structured result', outcome('', { status: 0, stdout: '{"id":"foreign-id-123"}' }), outcome('', { status: 0, stdout: '{"id":"absent-id-456"}' })],
  ['domain error code', outcome('creation_id_not_allowed'), outcome('entity_id_allocation_failed')],
  ['domain error text', outcome(refusal), outcome('ShadowGraph decision failed: ID already exists')],
  ['foreign identifier in application diagnostic', outcome(`${warning(123)}ShadowGraph status failed: foreign-id-123`), outcome(`${warning(456)}ShadowGraph status failed: absent-id-456`)],
  ['application process-like identifier', outcome(`${warning(123)}ShadowGraph failed: (node:123)`), outcome(`${warning(456)}ShadowGraph failed: (node:456)`) ],
  ['project', outcome('ShadowGraph failed: project-alpha'), outcome('ShadowGraph failed: project-beta')],
  ['path', outcome('ShadowGraph failed: /private/123'), outcome('ShadowGraph failed: /private/456')],
  ['arbitrary number', outcome('ShadowGraph failed: 123'), outcome('ShadowGraph failed: 456')],
  ['unknown warning PID', outcome('(node:123) ExperimentalWarning: other feature\n' + refusal), outcome('(node:456) ExperimentalWarning: other feature\n' + refusal)],
  ['SQLite warning body', outcome(warning(123) + refusal), outcome(warning(456).replace('might change', 'will change') + refusal)],
  ['warning hint', outcome(warning(123) + refusal), outcome(warning(456).replace('where the warning', 'why the warning') + refusal)],
  ['prefixed warning-like application text', outcome(`ShadowGraph failed: (node:123) ${header}\n`), outcome(`ShadowGraph failed: (node:456) ${header}\n`)],
  ['warning-like line with trailing application text', outcome(`(node:123) ${header}; foreign-id-123\n`), outcome(`(node:456) ${header}; absent-id-456\n`)],
  ['warning header on stdout', outcome('', { stdout: warning(123) }), outcome('', { stdout: warning(456) })]
]) test(`CLI parity still rejects differing ${name}`, () => {
  assert.throws(() => assertCliOutcomeEqual(left, right), { code: 'ERR_ASSERTION' });
});

test('CLI parity failure diagnostics retain both original warning PIDs and application errors', () => {
  const actual = outcome(warning(123) + 'ShadowGraph failed: foreign-id-123');
  const expected = outcome(warning(456) + 'ShadowGraph failed: absent-id-456');
  assert.throws(() => assertCliOutcomeEqual(actual, expected), error => {
    assert.equal(error.code, 'ERR_ASSERTION');
    for (const text of ['(node:123)', '(node:456)', 'foreign-id-123', 'absent-id-456']) assert.ok(error.message.includes(text), text);
    return true;
  });
});

test('CLI parity handles real child PIDs from an explicit synthetic SQLite-warning fixture', () => {
  const source = `process.emitWarning(${JSON.stringify(header.slice('ExperimentalWarning: '.length))}, 'ExperimentalWarning'); process.stderr.write(${JSON.stringify(refusal + '\n')}); process.exitCode = 1;`;
  const run = () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /\(node:\d+\) ExperimentalWarning: SQLite/);
    return { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
  };
  const actual = run(), expected = run();
  assert.notEqual(actual.stderr, expected.stderr);
  assertCliOutcomeEqual(actual, expected);
});
