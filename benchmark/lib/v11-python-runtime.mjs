// The reproducible Python runtime the container arms execute against.
//
// `competitors.lock.json` pins an interpreter image by digest and
// `python-wheels.lock.json` pins 227 packages by hash, but nothing ever put the
// second inside the first. The pinned image is a bare interpreter, the adapter
// executor sets `PYTHONPATH` empty, and no step installs anything, so every
// Python arm would fail at import before it reached its first request. That gap
// is what this module closes.
//
// The runtime is built *beside* the image rather than baked into a derived one.
// A derived image would have a local id and no registry digest, so it could not
// satisfy the digest-pinned reference the container runtime requires, and it
// would quietly replace the interpreter the competitor lock names. Installing
// the locked wheels into a directory that is mounted read-only keeps the image
// exactly what the lock pins and makes the runtime's contents separately
// attestable.
//
// Verification is symmetric on purpose. A runtime missing a locked distribution
// is broken in an obvious way; a runtime carrying one the lock does not pin is
// broken in a way that is easy to miss and worse, because the reproducibility
// claim is that the lock describes the runtime completely. Both are findings.

const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9._+!-]*)$/u;
const BARE_SHA256 = /^[a-f0-9]{64}$/u;

export const PYTHON_RUNTIME_SCHEMA = 'shadowgraph.v11.python-runtime';
export const PYTHON_RUNTIME_VERSION = 1;

// Where this runtime is mounted inside the pinned image is owned by
// python-container-runtime.mjs, which owns the whole in-container layout. It is
// deliberately not restated here: two spellings of one path is how a mount and
// the PYTHONPATH that is supposed to name it drift apart.

export class PythonRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PythonRuntimeError';
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * PEP 503 name normalization.
 *
 * The lock spells a package the way its author does and `importlib.metadata`
 * reports it the way the installed distribution does, and those disagree often
 * enough to matter - `Basic_Memory` and `basic-memory` are one package. Without
 * this, verification would report an absent distribution and an undeclared one
 * for the same thing.
 */
export function normalizeDistributionName(name) {
  if (!isNonEmptyString(name)) {
    throw new PythonRuntimeError('a distribution name must be a non-empty string');
  }
  return name.replace(/[-_.]+/gu, '-').toLowerCase();
}

function wheelEntries(wheelsLock) {
  if (!isPlainRecord(wheelsLock)
    || !Array.isArray(wheelsLock.wheels)
    || wheelsLock.wheels.length === 0) {
    throw new PythonRuntimeError('the wheel lock must carry a non-empty wheels array');
  }
  return wheelsLock.wheels;
}

/**
 * Read the wheel lock as normalized name to pinned version.
 *
 * A package pinned at two versions is refused rather than resolved. Choosing
 * between them here would mean the runtime contains a version no single line of
 * the lock names, which is exactly the drift the lock exists to prevent.
 */
export function lockedDistributions(wheelsLock) {
  const versions = new Map();
  for (const wheel of wheelEntries(wheelsLock)) {
    if (!isPlainRecord(wheel) || !isNonEmptyString(wheel.name)) {
      throw new PythonRuntimeError('every wheel entry needs a name');
    }
    const match = REQUIREMENT.exec(wheel.name);
    if (match === null) {
      throw new PythonRuntimeError(`wheel entry ${wheel.name} is not name==version`);
    }
    const name = normalizeDistributionName(match[1]);
    const version = match[2];
    const existing = versions.get(name);
    if (existing !== undefined && existing !== version) {
      throw new PythonRuntimeError(`the wheel lock pins ${name} at both ${existing} and ${version}`);
    }
    versions.set(name, version);
  }
  return versions;
}

/**
 * Render the wheel lock as a hash-pinned requirement set.
 *
 * One package per line with all of its hashes on that line. The obvious
 * alternative - a backslash continuation per hash, the way `pip freeze` writes
 * them - is what this was written as first, and pip read the escaped newline as
 * part of the version specifier and refused the whole file.
 */
export function renderRequirements(wheelsLock) {
  const hashes = new Map();
  for (const wheel of wheelEntries(wheelsLock)) {
    if (!isPlainRecord(wheel) || !isNonEmptyString(wheel.name)) {
      throw new PythonRuntimeError('every wheel entry needs a name');
    }
    if (REQUIREMENT.exec(wheel.name) === null) {
      throw new PythonRuntimeError(`wheel entry ${wheel.name} is not name==version`);
    }
    if (!isNonEmptyString(wheel.sha256) || !BARE_SHA256.test(wheel.sha256)) {
      throw new PythonRuntimeError(`wheel entry ${wheel.name} has no usable sha256`);
    }
    if (!hashes.has(wheel.name)) hashes.set(wheel.name, []);
    hashes.get(wheel.name).push(wheel.sha256);
  }

  const lines = [];
  for (const [name, entries] of hashes) {
    lines.push([name, ...entries.map((entry) => `--hash=sha256:${entry}`)].join(' '));
  }
  return `${lines.join('\n')}\n`;
}

function manifestFindings(manifest) {
  if (!isPlainRecord(manifest)
    || manifest.schema !== PYTHON_RUNTIME_SCHEMA
    || manifest.version !== PYTHON_RUNTIME_VERSION) {
    return [{
      code: 'RUNTIME_MANIFEST_MALFORMED',
      detail: `the manifest must declare schema ${PYTHON_RUNTIME_SCHEMA} version ${PYTHON_RUNTIME_VERSION}`
    }];
  }
  if (!Array.isArray(manifest.distributions) || manifest.distributions.length === 0) {
    return [{
      code: 'RUNTIME_MANIFEST_MALFORMED',
      detail: 'the manifest must list the distributions the runtime contains'
    }];
  }
  for (const distribution of manifest.distributions) {
    if (!isPlainRecord(distribution)
      || !isNonEmptyString(distribution.name)
      || !isNonEmptyString(distribution.version)) {
      return [{
        code: 'RUNTIME_MANIFEST_MALFORMED',
        detail: 'every distribution needs a name and a version'
      }];
    }
  }
  return [];
}

/**
 * Check that a built runtime contains exactly what the wheel lock pins.
 *
 * `image` and `wheelsLockSha256` are the inputs the runtime is claimed to have
 * been built from; a manifest that names different ones describes a runtime
 * built from something else, whatever its contents.
 */
export function verifyPythonRuntime(input) {
  const { manifest, wheelsLock, wheelsLockSha256, image } = input ?? {};
  const refuse = (findings) => Object.freeze({ valid: false, findings: Object.freeze(findings) });

  const malformed = manifestFindings(manifest);
  if (malformed.length > 0) return refuse(malformed);

  const findings = [];
  if (manifest.image !== image) {
    findings.push({ code: 'RUNTIME_IMAGE_MISMATCH', declared: manifest.image, pinned: image });
  }
  if (manifest.wheelsLockSha256 !== wheelsLockSha256) {
    findings.push({
      code: 'RUNTIME_WHEELS_LOCK_MISMATCH',
      declared: manifest.wheelsLockSha256,
      actual: wheelsLockSha256
    });
  }

  const locked = lockedDistributions(wheelsLock);
  const installed = new Map();
  for (const distribution of manifest.distributions) {
    installed.set(normalizeDistributionName(distribution.name), distribution.version);
  }

  for (const [name, version] of locked) {
    const present = installed.get(name);
    if (present === undefined) findings.push({ code: 'DISTRIBUTION_ABSENT', distribution: name });
    else if (present !== version) {
      findings.push({
        code: 'DISTRIBUTION_VERSION_MISMATCH',
        distribution: name,
        locked: version,
        installed: present
      });
    }
  }
  for (const name of installed.keys()) {
    if (!locked.has(name)) findings.push({ code: 'DISTRIBUTION_UNDECLARED', distribution: name });
  }

  // Import probes are optional, because a manifest may be verified before any
  // arm has one. When they are recorded they are held to: a runtime whose own
  // recorded probe failed is not a runtime an arm can execute against, and the
  // Graphiti case is exactly why - its wheel installs a package it does not
  // import, so a present distribution does not imply a working import.
  if (manifest.importProbes !== undefined) {
    if (!Array.isArray(manifest.importProbes)) {
      findings.push({ code: 'RUNTIME_MANIFEST_MALFORMED', detail: 'importProbes must be an array' });
    } else {
      for (const probe of manifest.importProbes) {
        if (!isPlainRecord(probe) || !isNonEmptyString(probe.armId)) {
          findings.push({ code: 'RUNTIME_MANIFEST_MALFORMED', detail: 'every import probe needs an armId' });
        } else if (probe.outcome !== 'PASS') {
          findings.push({
            code: 'IMPORT_PROBE_FAILED',
            armId: probe.armId,
            expected: probe.expected ?? null,
            observed: probe.observed ?? null
          });
        }
      }
    }
  }

  return Object.freeze({ valid: findings.length === 0, findings: Object.freeze(findings) });
}
