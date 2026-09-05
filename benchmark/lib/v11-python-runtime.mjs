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

// The one place this module touches a filesystem: `readPythonSiteDistributions`
// reads a built site's own metadata, because a manifest is a claim about a
// directory and verifying the claim is not verifying the directory.
import { readdir, readFile } from 'node:fs/promises';

const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([A-Za-z0-9][A-Za-z0-9._+!-]*)$/u;
const BARE_SHA256 = /^[a-f0-9]{64}$/u;

export const PYTHON_RUNTIME_SCHEMA = 'shadowgraph.v11.python-runtime';
export const PYTHON_RUNTIME_VERSION = 1;

// Where this runtime is mounted inside the pinned image is owned by
// python-container-runtime.mjs, which owns the whole in-container layout. It is
// deliberately not restated here: two spellings of one path is how a mount and
// the PYTHONPATH that is supposed to name it drift apart.

/**
 * The module each Python arm's distribution actually imports.
 *
 * The competitor lock's `importProbe` reads distribution *metadata*:
 * `importlib.metadata.version(...)` resolves a `.dist-info` directory and never
 * executes a line of the package. On its own it cannot observe the failure the
 * lock itself records for Graphiti - a wheel that installed `httpx2` and no
 * `httpx`, where the first clean import raised `ModuleNotFoundError` while the
 * metadata resolved perfectly.
 *
 * Distribution names and module names differ often enough that this cannot be
 * derived: `mem0ai` imports `mem0`, `graphiti-core` imports `graphiti_core`.
 * The mapping is stated here so it is reviewed in a diff rather than guessed at
 * runtime.
 */
export const PYTHON_IMPORT_MODULES = Object.freeze({
  'mem0-oss': 'mem0',
  graphiti: 'graphiti_core',
  'basic-memory': 'basic_memory',
  cognee: 'cognee'
});

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
    const name = normalizeDistributionName(distribution.name);
    const already = installed.get(name);
    if (already !== undefined && already !== distribution.version) {
      // `pip install --target <site> --upgrade` does not remove the superseded
      // `.dist-info`, so a site upgraded in place carries both. Collapsing them
      // last-wins made the verdict depend on directory order, and reported
      // valid for exactly the in-place upgrade this verification exists to
      // catch. Two versions of one distribution is not a runtime anything can
      // be pinned against - which of them an import resolves to is pip's
      // business, not the lock's.
      findings.push({
        code: 'DISTRIBUTION_DUPLICATED',
        distribution: name,
        versions: [already, distribution.version].sort()
      });
    }
    installed.set(name, distribution.version);
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

/**
 * The distributions a built site actually contains, read off the site.
 *
 * A manifest is a claim about a directory, and until this existed the run path
 * verified the claim and never opened the directory: upgrading `httpx` in place
 * inside the mounted site, leaving the manifest untouched, passed the bind-time
 * check while the arms imported the upgraded package. The one case the refusal
 * was written for was the one it did not cover.
 *
 * Read from each `*.dist-info/METADATA` and each `*.egg-info/PKG-INFO` rather
 * than from the directory name, because that is where `importlib.metadata` -
 * and therefore every arm's own `require_versions` - reads the version from.
 * Reading only `.dist-info` enumerated less than the interpreter does, so a
 * distribution installed the other way was invisible to the verification and
 * present to the arms. Nothing is imported and nothing is executed; this is a
 * directory listing and some header lines.
 *
 * Duplicates are returned rather than collapsed. A real in-place
 * `pip install --target ... --upgrade` leaves the superseded `.dist-info` in
 * place, so a site upgraded that way contains both versions, and whichever one
 * a reader kept decided the verdict. `verifyPythonRuntime` reports the pair.
 */
export async function readPythonSiteDistributions(sitePath, { readdirImpl = readdir, readFileImpl = readFile } = {}) {
  if (!isNonEmptyString(sitePath)) {
    throw new PythonRuntimeError('a Python site path is required');
  }
  let entries;
  try {
    entries = await readdirImpl(sitePath, { withFileTypes: true });
  } catch (error) {
    throw new PythonRuntimeError(`the pinned Python site could not be read: ${error?.message ?? error}`);
  }
  const distributions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metadataFile = entry.name.endsWith('.dist-info')
      ? 'METADATA'
      : entry.name.endsWith('.egg-info') ? 'PKG-INFO' : null;
    if (metadataFile === null) continue;
    let metadata;
    try {
      metadata = await readFileImpl(`${sitePath}/${entry.name}/${metadataFile}`, 'utf8');
    } catch {
      // A metadata directory without its metadata file is not a distribution
      // this can name, and guessing from the directory name would be inventing
      // evidence.
      continue;
    }
    let name = null;
    let version = null;
    // The headers end at the first blank line; a carriage return is stripped
    // with the rest of the whitespace, and a byte-order mark on the first line
    // is dropped so `Name:` is still recognised there.
    for (const raw of metadata.replace(/^\uFEFF/u, '').split(String.fromCharCode(10))) {
      const line = raw.trimEnd();
      if (line.length === 0) break;
      if (name === null && line.startsWith('Name:')) name = line.slice(5).trim();
      else if (version === null && line.startsWith('Version:')) version = line.slice(8).trim();
      if (name !== null && version !== null) break;
    }
    if (isNonEmptyString(name) && isNonEmptyString(version)) {
      distributions.push({ name, version });
    }
  }
  return distributions;
}

/**
 * Every distribution the interpreter can discover in a site, as JSON.
 *
 * Run inside the pinned image by the build command, and exported here so it can
 * be run against a directory a test controls. It reports a *list*, not a
 * dictionary keyed by name: a real `pip install --target <site> --upgrade`
 * leaves the superseded `.dist-info` in place, so an upgraded site holds two
 * versions of one distribution, and collapsing them last-discover-wins made the
 * verdict depend on discovery order. With that collapse,
 * `DISTRIBUTION_DUPLICATED` could never fire from the only command that builds a
 * manifest - which is where the manifest the run path trusts comes from.
 */
export const LIST_DISTRIBUTIONS_SCRIPT = [
  'import json, sys',
  'from importlib.metadata import Distribution, DistributionFinder',
  'context = DistributionFinder.Context(path=[sys.argv[1]])',
  'found = []',
  'for distribution in Distribution.discover(context=context):',
  '    name = distribution.metadata["Name"]',
  '    if name:',
  '        found.append({"name": name, "version": distribution.version})',
  'found.sort(key=lambda entry: (entry["name"], entry["version"]))',
  'print(json.dumps(found))'
].join(String.fromCharCode(10));

/**
 * The manifest a build writes, or the one a verification holds a site to.
 *
 * A build records what it built. A verification records nothing - it reads the
 * manifest the build wrote and replaces only what it can re-observe.
 *
 * Both used to write, and `--verify only` therefore stamped the current image
 * and wheel-lock hash onto the manifest before checking them, so two of
 * `verifyPythonRuntime`'s findings compared each value with itself. Reading
 * instead fixed that and opened the opposite hole: the command ran four fresh
 * import probes, printed a failing one, and verified the ones recorded at build
 * time. So the rule is stated once, here: **what the site can be asked now is
 * measured now; only what it cannot be asked comes from the record.**
 */
export function pythonRuntimeManifest(input) {
  const {
    recorded = null,
    verifyOnly = false,
    image,
    wheelsLockSha256,
    distributions,
    importProbes,
    builtAt
  } = input ?? {};
  if (!Array.isArray(distributions) || !Array.isArray(importProbes)) {
    throw new PythonRuntimeError('a runtime manifest needs the distributions and import probes just observed');
  }
  if (!verifyOnly) {
    if (!isNonEmptyString(image) || !isNonEmptyString(wheelsLockSha256) || !isNonEmptyString(builtAt)) {
      throw new PythonRuntimeError('a built runtime manifest records the image, the wheel lock hash and when it was built');
    }
    return {
      schema: PYTHON_RUNTIME_SCHEMA,
      version: PYTHON_RUNTIME_VERSION,
      builtAt,
      image,
      wheelsLockSha256,
      distributions,
      importProbes
    };
  }
  if (!isPlainRecord(recorded)) {
    throw new PythonRuntimeError('--verify only requires the manifest the build wrote');
  }
  // The image it was built against and the wheel lock it was built from are the
  // two things a verification cannot re-observe, so they are the two it keeps.
  return { ...recorded, distributions, importProbes };
}
