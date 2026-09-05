// The observer that fills the environment lock.
//
// `buildEnvironmentLock` is already tested for refusal, but a validator only
// refuses what it is handed. This module is the thing that does the handing, so
// the class of defect it can introduce is the one the lock cannot see: an
// observation that was never made, written down as though it had been.
//
// Four of the ten fields are answers from other programs, and every plausible
// wrong implementation of this module fails in the same direction - it catches
// the failure and substitutes something. `unknown`, an empty string, the local
// interpreter's version instead of the container's, the tag half of a pinned
// image: each of those satisfies the field count and produces a lock that reads
// as authoritative about a machine nobody fully looked at. So the tests below
// spend most of their weight on refusals, and the one happy-path test that
// matters runs the real `buildEnvironmentLock` over the real output, because
// this observer exists for no other purpose than to satisfy that validator.
//
// No docker and no npm run here. The module takes an injected `runCommand`, and
// a fixture that answers three questions is a better test than a real daemon:
// it can fail one observation at a time, and it can be asked what argv it was
// given - which is how the "the pinned image is run, not inspected" property
// below is checked at all.

import assert from 'node:assert/strict';
import test from 'node:test';

import { isPlaceholder } from '../benchmark/lib/placeholder.mjs';
import {
  EnvironmentObservationError,
  observeEnvironment
} from '../benchmark/lib/v11-environment.mjs';
import {
  ENVIRONMENT_FIELDS,
  ENVIRONMENT_SHAPE,
  LockError,
  buildEnvironmentLock
} from '../benchmark/lib/v11-locks.mjs';

// The digest-pinned reference from `benchmark/competitors.lock.json`, spelled
// out here so the argv assertions can compare against the exact string a run
// would pass to docker - digest included.
const PYTHON_IMAGE =
  'python:3.12.11-slim@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f';

// Both executables are injected rather than defaulted, so the fixture can tell
// the two docker questions apart from the npm one on any platform. The real
// default for npm is platform-dependent (`npm.cmd` on Windows), and a test that
// depended on it would pass or fail for a reason that has nothing to do with
// this module.
const DOCKER = 'fixture-docker';
const NPM = 'fixture-npm';

const ANSWERS = Object.freeze({
  npm: '11.6.2\n',
  dockerVersion: 'Docker version 29.7.1, build fixture\n',
  dockerRun: 'Python 3.12.11\n'
});

/** Which of the three questions an argv is asking. */
function classify(executable, args) {
  if (executable === NPM && args[0] === '--version') return 'npm';
  if (executable === DOCKER && args[0] === '--version') return 'dockerVersion';
  if (executable === DOCKER && args[0] === 'run') return 'dockerRun';
  return `unexpected: ${executable} ${args.join(' ')}`;
}

/**
 * A `runCommand` that answers the three questions and records how it was asked.
 *
 * An `Error` in the script is thrown rather than returned, which is how a
 * missing program behaves; anything else is returned as stdout.
 */
function stubRunCommand(script) {
  const calls = [];
  const run = async (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    const kind = classify(executable, args);
    const answer = script[kind];
    if (answer === undefined) {
      throw new assert.AssertionError({ message: `the fixture was asked something else - ${kind}` });
    }
    if (answer instanceof Error) throw answer;
    return { stdout: answer, stderr: '' };
  };
  run.calls = calls;
  return run;
}

function harness(script = {}) {
  const runCommand = stubRunCommand({ ...ANSWERS, ...script });
  const observe = (overrides = {}) => observeEnvironment({
    pythonImage: PYTHON_IMAGE,
    dockerExecutable: DOCKER,
    npmExecutable: NPM,
    runCommand,
    ...overrides
  });
  return { runCommand, observe };
}

test('an image that is not digest-pinned is refused before anything is observed', async () => {
  // The Python version is read out of this image, so an unpinned reference does
  // not merely weaken the lock - it makes the recorded `pythonVersion` describe
  // whatever the tag pointed at on the day of the run. The refusal has to land
  // before any command runs, or a half-observed machine has already been paid
  // for by the time the argument is checked.
  // Half of these carry the literal '@sha256:'. They are the half that
  // matters: while this module tested for that substring rather than for a
  // digest, every one of them was accepted and run.
  for (const pythonImage of [
    undefined,
    null,
    '',
    'python:3.12.11-slim',
    'python@sha256',
    'python@sha256abcdef',
    `python:3.12.11-slim@sha512:${'a'.repeat(64)}`,
    '@sha256:',
    'python:3.12.11-slim@sha256:',
    `python:3.12.11-slim@sha256:${'a'.repeat(63)}`,
    `python:3.12.11-slim@sha256:${'a'.repeat(65)}`,
    `python:3.12.11-slim@sha256:${'Z'.repeat(64)}`,
    `not an image at all @sha256:${'a'.repeat(64)}`,
    `python:3.12.11-slim@sha256:${'a'.repeat(64)} --privileged`,
    42,
    {}
  ]) {
    const { runCommand, observe } = harness();
    await assert.rejects(
      observe({ pythonImage }),
      (error) => error instanceof EnvironmentObservationError
        && /digest-pinned/u.test(error.message),
      `${JSON.stringify(pythonImage)} was accepted as a pinned image`
    );
    assert.equal(
      runCommand.calls.length,
      0,
      `${JSON.stringify(pythonImage)} was refused only after commands had already run`
    );
  }
});

test('the observations it produces build a real environment lock', async () => {
  // The property that matters. Every other test here is a way of protecting
  // this one: the observer has no consumer except `buildEnvironmentLock`, so
  // "it returned an object" proves nothing and "the validator accepted it"
  // proves the module did its job.
  const { observe } = harness();
  const observations = await observe();

  const built = buildEnvironmentLock({ observations });
  assert.equal(built.lock.schema, 'shadowgraph.v11.environment-lock');
  assert.equal(built.lock.version, 1);
  assert.match(built.digest, /^[a-f0-9]{64}$/u);
  assert.ok(built.bytes.endsWith('\n'), 'the lock bytes must be newline-terminated');

  // The answers, not something derived from them: an implementation that ran
  // the commands and then recorded the local interpreter would still produce a
  // lock, and would still be wrong.
  assert.equal(built.lock.npmVersion, '11.6.2');
  assert.equal(built.lock.containerRuntimeVersion, 'Docker version 29.7.1, build fixture');
  assert.equal(built.lock.pythonVersion, 'Python 3.12.11');
  assert.equal(built.lock.nodeVersion, process.version);

  // Same machine, same answers, same bytes. A field that carried a timestamp or
  // any other per-run value would produce two digests for one machine and make
  // every comparison between two runs report a difference that is not one.
  const second = buildEnvironmentLock({ observations: await harness().observe() });
  assert.equal(second.digest, built.digest);
  assert.equal(second.bytes, built.bytes);
});

test('it observes exactly the ten fields the lock records, and nothing else', async () => {
  const { observe } = harness();
  const observations = await observe();

  assert.equal(ENVIRONMENT_FIELDS.length, 10, 'the shape this suite was written against changed');
  assert.deepEqual(
    Object.keys(observations).sort(),
    [...ENVIRONMENT_FIELDS].sort(),
    'the observed set must be exactly the recorded set'
  );
  assert.ok(Object.isFrozen(observations), 'an observation must not be edited after it is made');

  // Present is not enough; the lock is typed per field, and a count satisfied
  // by prose is the defect that got the shape typed in the first place.
  for (const field of ENVIRONMENT_FIELDS) {
    const value = observations[field];
    if (ENVIRONMENT_SHAPE[field] === 'count') {
      assert.ok(
        Number.isSafeInteger(value) && value > 0,
        `${field} must be a positive count, got ${JSON.stringify(value)}`
      );
    } else {
      assert.equal(typeof value, 'string', `${field} must be a description`);
      assert.ok(value.trim().length > 0, `${field} must not be empty`);
      assert.ok(!isPlaceholder(value), `${field} recorded a placeholder: ${JSON.stringify(value)}`);
    }
  }

  // The other half of "exactly": the lock refuses a field it does not record,
  // so an observer that helpfully added one - a docker context, a hostname -
  // would take down the run it was trying to describe.
  assert.throws(
    () => buildEnvironmentLock({ observations: { ...observations, dockerContext: 'default' } }),
    (error) => error instanceof LockError && error.code === 'UNKNOWN_ENVIRONMENT_FIELD',
    'an extra observed field must be refused by the lock'
  );
});

test('a command that fails is a refusal naming the observation it failed', async () => {
  // Why this is the centre of the suite: writing "unknown" into `npmVersion`
  // when `npm --version` fails would satisfy the field count and defeat the
  // lock. The lock refuses placeholders precisely so that a half-observed
  // machine cannot be recorded as a pinned one - but it can only refuse what
  // reaches it, and a substituted literal that is not on the placeholder
  // denylist ("", "0.0.0", the last known version) would sail straight through.
  // So the failure has to stop here, and it has to say which observation and
  // which command, or the operator is left to guess which of three programs
  // was missing.
  const cases = [
    { kind: 'npm', label: 'npmVersion', executable: NPM },
    { kind: 'dockerVersion', label: 'containerRuntimeVersion', executable: DOCKER },
    { kind: 'dockerRun', label: 'pythonVersion', executable: DOCKER }
  ];

  for (const { kind, label, executable } of cases) {
    const failure = new Error(`fixture: ${kind} is not installed`);
    const { observe } = harness({ [kind]: failure });

    await assert.rejects(
      observe(),
      (error) => {
        assert.ok(
          error instanceof EnvironmentObservationError,
          `a failing ${kind} produced ${error?.name} instead of a refusal`
        );
        assert.ok(error.message.includes(label), `the refusal did not name ${label}`);
        assert.ok(error.message.includes(executable), 'the refusal did not name the command');
        // The underlying failure is kept, not swallowed: "docker is not
        // installed" and "docker is installed and the daemon is down" are
        // different problems with the same refusal.
        assert.equal(error.cause, failure, 'the refusal dropped the cause');
        // One observation failed, so one observation is named. A lumped "some
        // observations failed" message sends the operator to check all three.
        for (const other of cases) {
          if (other.label === label) continue;
          assert.ok(
            !error.message.includes(other.label),
            `the refusal for ${label} also blamed ${other.label}`
          );
        }
        return true;
      },
      `a failing ${kind} was not a refusal`
    );
  }
});

test('a command that answers with nothing is a refusal, not an empty observation', async () => {
  // A program that exits 0 and prints nothing is the quiet version of the same
  // defect: there is no observation, and the field would be filled with "". The
  // lock would catch a bare "" - but only because it happens to check for it,
  // and it would report a missing field rather than the command that produced
  // nothing, which is the fact the operator needs.
  const labels = { npm: 'npmVersion', dockerVersion: 'containerRuntimeVersion', dockerRun: 'pythonVersion' };

  for (const kind of ['npm', 'dockerVersion', 'dockerRun']) {
    for (const stdout of ['', ' ', '   \t ', '\n', '\r\n', '\n\nPython 3.12.11\n']) {
      const { observe } = harness({ [kind]: stdout });
      await assert.rejects(
        observe(),
        (error) => error instanceof EnvironmentObservationError
          && error.message.includes('empty')
          && error.message.includes(labels[kind]),
        `${kind} answering ${JSON.stringify(stdout)} was accepted as an observation`
      );
    }
  }
});

test('only the first line of an answer is recorded, trimmed', async () => {
  // Both of these programs print more than the answer on a normal day: docker
  // adds deprecation and out-of-date warnings, npm adds an update notice. A
  // module that recorded the whole of stdout would put a warning banner inside
  // the lock, and the same machine would then produce two different digests
  // depending on whether the warning fired that day - a difference between two
  // runs that means nothing, reported by the artifact whose only job is to say
  // whether a difference means something.
  const { observe } = harness({
    npm: '  11.6.2  \r\nnpm notice a new version of npm is available\n',
    dockerVersion: 'Docker version 29.7.1, build fixture\r\nWARNING: daemon is out of date\n',
    dockerRun: 'Python 3.12.11\nPython 3.13.0\n'
  });
  const observations = await observe();

  assert.equal(observations.npmVersion, '11.6.2');
  assert.equal(observations.containerRuntimeVersion, 'Docker version 29.7.1, build fixture');
  assert.equal(observations.pythonVersion, 'Python 3.12.11');
  assert.ok(
    !observations.pythonVersion.includes('3.13.0'),
    'a second line is not part of the answer'
  );

  for (const field of ENVIRONMENT_FIELDS) {
    if (ENVIRONMENT_SHAPE[field] !== 'string') continue;
    assert.ok(
      !/[\r\n]/u.test(observations[field]),
      `${field} carried a line break into the lock: ${JSON.stringify(observations[field])}`
    );
  }

  // And the trimmed multi-line answers still build a lock, which is the point:
  // the trimming is not cosmetic, it is what keeps a noisy machine lockable.
  assert.match(buildEnvironmentLock({ observations }).digest, /^[a-f0-9]{64}$/u);
});

test('the Python version comes from running the pinned image, with the network off', async () => {
  // An image's labels describe what someone wrote about it; the interpreter
  // version a measured unit actually sees is what the interpreter says when it
  // is asked. `docker inspect` would answer instantly and could be wrong, and
  // nothing downstream could tell.
  //
  // `--network none` is why this can be an observation and not a side effect:
  // the container is started only to ask a question, so it is given no way to
  // reach a registry, a package index, or the Neo4j and Ollama services the
  // measured arms use. Without it, one mis-tagged image could pull or phone
  // home from inside the step whose whole purpose is to describe the machine
  // before the run begins.
  const { runCommand, observe } = harness({ dockerRun: 'Python 3.12.11 (fixture interpreter)\n' });
  const observations = await observe();

  assert.equal(runCommand.calls.length, 3, 'exactly three programs are asked exactly one question');

  const runCall = runCommand.calls.find((call) => call.args[0] === 'run');
  assert.ok(runCall, 'the Python version must be read by running the image');
  assert.equal(runCall.executable, DOCKER);

  // The exact pinned reference, digest and all. A repository name with the
  // digest stripped off runs whatever `latest` is, and the recorded version
  // would then belong to an image the lock does not name.
  assert.ok(
    runCall.args.includes(PYTHON_IMAGE),
    `the run did not name the pinned image: ${runCall.args.join(' ')}`
  );

  const networkAt = runCall.args.indexOf('--network');
  assert.notEqual(networkAt, -1, 'the observation container must be given no network');
  assert.equal(runCall.args[networkAt + 1], 'none');
  assert.ok(runCall.args.includes('--rm'), 'the observation must not leave a container behind');

  // The interpreter is asked; the image is not read about.
  assert.ok(runCall.args.includes('python'), 'the interpreter itself must be the program that answers');
  assert.ok(runCall.args.includes('--version'));
  for (const call of runCommand.calls) {
    for (const forbidden of ['inspect', 'image', 'pull']) {
      assert.ok(
        !call.args.includes(forbidden),
        `an observation used docker ${forbidden}: ${call.args.join(' ')}`
      );
    }
  }

  // And the run's answer is the field. An implementation that started the
  // container and then recorded a local `python --version` would pass every
  // assertion above and still measure the wrong interpreter.
  assert.equal(observations.pythonVersion, 'Python 3.12.11 (fixture interpreter)');
});

test('every observation is asked with a timeout and a bounded buffer', async () => {
  // A cold `docker run` is slow, and a docker daemon that is wedged is not
  // slow - it never answers. Without a timeout the acceptance run hangs before
  // it starts, with no output and no refusal, which is the worst of the three
  // outcomes because it looks like progress.
  const { runCommand, observe } = harness();
  await observe();

  assert.equal(runCommand.calls.length, 3);
  for (const call of runCommand.calls) {
    assert.ok(
      Number.isFinite(call.options?.timeout) && call.options.timeout > 0,
      `${call.executable} ${call.args.join(' ')} was asked without a timeout`
    );
    assert.ok(
      Number.isFinite(call.options?.maxBuffer) && call.options.maxBuffer > 0,
      `${call.executable} ${call.args.join(' ')} was asked without a buffer bound`
    );
  }
});

test('blanking any single observation makes the lock refuse it by name', async () => {
  // The two modules have to agree about what "complete" means. If the observer
  // decided a field was optional, or filled one in with a spelling the lock
  // reads as absent, the disagreement would surface as a failed run at the end
  // of an expensive setup instead of here.
  const { observe } = harness();
  const observations = await observe();

  for (const field of ENVIRONMENT_FIELDS) {
    const blanked = { ...observations };
    blanked[field] = ENVIRONMENT_SHAPE[field] === 'count' ? 0 : '   ';
    assert.throws(
      () => buildEnvironmentLock({ observations: blanked }),
      (error) => error instanceof LockError
        && error.code === 'INCOMPLETE_ENVIRONMENT'
        && error.message.includes(field),
      `a blanked ${field} still produced a lock`
    );

    // The same field carrying "unknown" - what a substituting observer would
    // have written - is refused for the same reason.
    assert.throws(
      () => buildEnvironmentLock({ observations: { ...observations, [field]: 'unknown' } }),
      (error) => error instanceof LockError && error.code === 'INCOMPLETE_ENVIRONMENT',
      `${field}="unknown" still produced a lock`
    );
  }
});
