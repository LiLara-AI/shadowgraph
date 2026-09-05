// The ten observations the environment lock will accept.
//
// `buildEnvironmentLock` refuses a missing field, a non-positive count, an empty
// string and any placeholder spelling - "unknown", "n/a", "tbd" and the rest.
// That refusal is the whole value of the lock, because an environment lock with
// a gap is worse than no lock: it implies the machine was pinned when part of it
// was not, and the gap is exactly where an unexplained difference between two
// runs would hide.
//
// Nothing here has a fallback. Six of the ten come from `node:os` and cannot
// fail; the other four are answers from other programs, and a program that does
// not answer produces a refusal rather than a literal. Writing "unknown" into
// `npmVersion` when `npm --version` fails would satisfy the field count and
// defeat the check, so the failure is surfaced with the command that produced
// it and the run does not start.
//
// The Python version is read from inside the pinned image rather than from a
// local interpreter, because the local one measures nothing that a measured unit
// runs on: every Python arm executes in that container.

import { execFile } from 'node:child_process';
import {
  arch as osArch,
  cpus,
  totalmem,
  type as osType,
  release as osRelease
} from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Long enough for a cold `docker run`, short enough that a hang is not a hang. */
const OBSERVATION_TIMEOUT_MS = 120_000;

export class EnvironmentObservationError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'EnvironmentObservationError';
    if (cause !== undefined) this.cause = cause;
  }
}

function firstLine(value) {
  return String(value).split('\n')[0].trim();
}

/**
 * Ask one program one question, and refuse an answer that is not one.
 *
 * A command that fails, times out, or answers with nothing is reported by name.
 * The alternative - catching and substituting - is how a lock ends up recording
 * a machine nobody was on.
 */
async function ask(executable, args, label, runCommand) {
  let stdout;
  try {
    ({ stdout } = await runCommand(executable, args, {
      encoding: 'utf8',
      timeout: OBSERVATION_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024
    }));
  } catch (error) {
    throw new EnvironmentObservationError(
      `the environment observation for ${label} failed: ${executable} ${args.join(' ')}`,
      error
    );
  }
  const observed = firstLine(stdout);
  if (observed.length === 0) {
    throw new EnvironmentObservationError(
      `the environment observation for ${label} was empty: ${executable} ${args.join(' ')}`
    );
  }
  return observed;
}

/**
 * Observe the machine a run is about to execute on.
 *
 * `pythonImage` is the digest-pinned image from the competitor lock. It is run,
 * not inspected: an image's labels describe what someone wrote about it, and the
 * interpreter version a measured unit will actually see is what the interpreter
 * says when it is asked.
 */
export async function observeEnvironment(options = {}) {
  const {
    pythonImage,
    dockerExecutable = 'docker',
    npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm',
    runCommand = execFileAsync
  } = options;

  if (typeof pythonImage !== 'string' || !pythonImage.includes('@sha256:')) {
    throw new EnvironmentObservationError(
      'observing the environment requires the digest-pinned Python image'
    );
  }

  const processors = cpus();
  const cpuModel = firstLine(processors[0]?.model ?? '');
  if (cpuModel.length === 0) {
    throw new EnvironmentObservationError('the operating system reported no CPU model');
  }

  const [npmVersion, containerRuntimeVersion, pythonVersion] = await Promise.all([
    ask(npmExecutable, ['--version'], 'npmVersion', runCommand),
    ask(dockerExecutable, ['--version'], 'containerRuntimeVersion', runCommand),
    ask(
      dockerExecutable,
      ['run', '--rm', '--network', 'none', pythonImage, 'python', '--version'],
      'pythonVersion',
      runCommand
    )
  ]);

  return Object.freeze({
    osType: osType(),
    osRelease: osRelease(),
    arch: osArch(),
    cpuModel,
    cpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    nodeVersion: process.version,
    npmVersion,
    pythonVersion,
    containerRuntimeVersion
  });
}
