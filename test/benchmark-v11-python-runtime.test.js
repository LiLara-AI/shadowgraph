// The reproducible Python runtime the container arms execute against.
//
// The competitor lock pins an image, and the wheel lock pins 227 packages by
// hash, but nothing put the second inside the first: the pinned image is a bare
// interpreter, so every Python arm would fail at import. This module renders the
// wheel lock into an installable requirement set and checks that a built runtime
// contains exactly what the lock names - no missing distribution, no version
// drift, and nothing extra that arrived from somewhere else.
//
// "Nothing extra" carries as much weight here as "nothing missing". A runtime
// with an unpinned package in it is a runtime whose behaviour is not described
// by the lock, and the whole reproducibility claim rests on the lock describing
// it completely.

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PYTHON_RUNTIME_BYTECODE_ENVIRONMENT,
  pythonRuntimePipInstallArguments,
  PYTHON_IMPORT_MODULES,
  PYTHON_RUNTIME_SCHEMA,
  LIST_DISTRIBUTIONS_SCRIPT,
  PYTHON_RUNTIME_VERSION,
  PythonRuntimeError,
  pythonRuntimeManifest,
  lockedDistributions,
  normalizeDistributionName,
  readPythonSiteDistributions,
  renderRequirements,
  verifyPythonRuntime
} from '../benchmark/lib/v11-python-runtime.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const execFileAsync = promisify(execFile);

/** The interpreter this machine has, or null. The script is Python, not JS. */
async function pythonInterpreter() {
  for (const candidate of ['python3', 'python']) {
    try {
      await execFileAsync(candidate, ['-c', 'import importlib.metadata']);
      return candidate;
    } catch {
      // try the next spelling
    }
  }
  return null;
}

const IMAGE = 'python@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f';
const LOCK_SHA256 = 'a'.repeat(64);

function wheelsLock() {
  return {
    schemaVersion: 1,
    pythonVersion: '3.12',
    wheels: [
      { name: 'graphiti-core==0.29.3', sha256: '1'.repeat(64) },
      { name: 'graphiti-core==0.29.3', sha256: '2'.repeat(64) },
      { name: 'httpx==0.28.1', sha256: '3'.repeat(64) },
      { name: 'Basic_Memory==0.23.2', sha256: '4'.repeat(64) }
    ]
  };
}

function manifest(overrides = {}) {
  return {
    schema: PYTHON_RUNTIME_SCHEMA,
    version: 1,
    builtAt: '2026-09-05T03:00:00.000Z',
    image: IMAGE,
    wheelsLockSha256: LOCK_SHA256,
    distributions: [
      { name: 'graphiti-core', version: '0.29.3' },
      { name: 'httpx', version: '0.28.1' },
      { name: 'basic-memory', version: '0.23.2' }
    ],
    ...overrides
  };
}

function verify(overrides = {}) {
  return verifyPythonRuntime({
    manifest: manifest(),
    wheelsLock: wheelsLock(),
    wheelsLockSha256: LOCK_SHA256,
    image: IMAGE,
    ...overrides
  });
}

test('distribution names are compared under PEP 503 normalization', () => {
  for (const [raw, expected] of [
    ['Basic_Memory', 'basic-memory'],
    ['opentelemetry.api', 'opentelemetry-api'],
    ['MEM0AI', 'mem0ai'],
    ['py--rust__stemmers', 'py-rust-stemmers']
  ]) {
    assert.equal(normalizeDistributionName(raw), expected);
  }
});

test('the lock reads as a name-to-version map, normalized', () => {
  const distributions = lockedDistributions(wheelsLock());
  assert.deepEqual([...distributions.entries()].sort(), [
    ['basic-memory', '0.23.2'],
    ['graphiti-core', '0.29.3'],
    ['httpx', '0.28.1']
  ]);
});

test('a lock entry that is not name==version is refused', () => {
  for (const name of ['graphiti-core', 'graphiti-core>=0.29.3', '==0.29.3', 'graphiti-core==']) {
    assert.throws(
      () => lockedDistributions({ wheels: [{ name, sha256: '1'.repeat(64) }] }),
      PythonRuntimeError,
      `${name} must not parse`
    );
  }
});

test('a package pinned at two versions is refused rather than resolved', () => {
  assert.throws(() => lockedDistributions({
    wheels: [
      { name: 'httpx==0.28.1', sha256: '1'.repeat(64) },
      { name: 'httpx==0.27.0', sha256: '2'.repeat(64) }
    ]
  }), PythonRuntimeError);
});

test('requirements carry every hash the lock records for a package, on one line each', () => {
  const rendered = renderRequirements(wheelsLock());
  const lines = rendered.trimEnd().split('\n');
  assert.equal(lines.length, 3, 'one line per distinct package');
  const graphiti = lines.find((line) => line.startsWith('graphiti-core=='));
  assert.equal(
    graphiti,
    `graphiti-core==0.29.3 --hash=sha256:${'1'.repeat(64)} --hash=sha256:${'2'.repeat(64)}`
  );
  // Continuation backslashes are how this was first written and how it first
  // broke: pip read the escaped newline as part of the version specifier.
  assert.ok(!rendered.includes('\\'), 'no line continuations');
});

test('runtime build commands fence bytecode before mounting the verified site', () => {
  assert.deepEqual(PYTHON_RUNTIME_BYTECODE_ENVIRONMENT, ['PYTHONDONTWRITEBYTECODE=1']);
  assert.deepEqual(
    pythonRuntimePipInstallArguments({ target: '/runtime/site', requirements: '/runtime/requirements.txt' }),
    [
      'python', '-m', 'pip', 'install', '--require-hashes', '--no-compile',
      '--no-cache-dir', '--no-warn-script-location', '--target', '/runtime/site',
      '-r', '/runtime/requirements.txt'
    ]
  );
});

test('runtime build commands reject unsafe container paths', () => {
  for (const input of [
    { target: 'relative/site', requirements: '/runtime/requirements.txt' },
    { target: '../site', requirements: '/runtime/requirements.txt' },
    { target: '/runtime/../site', requirements: '/runtime/requirements.txt' },
    { target: '/runtime//site', requirements: '/runtime/requirements.txt' },
    { target: '/runtime\\site', requirements: '/runtime/requirements.txt' },
    { target: '/runtime/\nsite', requirements: '/runtime/requirements.txt' },
    { target: '/runtime/site', requirements: '/runtime/\nrequirements.txt' }
  ]) {
    assert.throws(
      () => pythonRuntimePipInstallArguments(input),
      /absolute control-free target and requirements paths/u
    );
  }
});

test('a hash that is not a sha256 is refused', () => {
  for (const sha256 of ['', 'notahash', 'A'.repeat(64), '1'.repeat(63)]) {
    assert.throws(
      () => renderRequirements({ wheels: [{ name: 'httpx==0.28.1', sha256 }] }),
      PythonRuntimeError
    );
  }
});

test('an empty or malformed lock renders nothing', () => {
  for (const lock of [null, {}, { wheels: [] }, { wheels: 'httpx' }]) {
    assert.throws(() => renderRequirements(lock), PythonRuntimeError);
  }
});

test('a runtime containing exactly the locked set verifies', () => {
  const result = verify();
  assert.deepEqual(result.findings, []);
  assert.equal(result.valid, true);
});

test('a missing distribution is a finding', () => {
  const document = manifest();
  document.distributions = document.distributions.filter((entry) => entry.name !== 'httpx');
  const result = verify({ manifest: document });
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((finding) => (
    finding.code === 'DISTRIBUTION_ABSENT' && finding.distribution === 'httpx'
  )));
});

test('a version that drifted from the lock is a finding', () => {
  const document = manifest();
  document.distributions.find((entry) => entry.name === 'httpx').version = '0.27.0';
  const result = verify({ manifest: document });
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((finding) => (
    finding.code === 'DISTRIBUTION_VERSION_MISMATCH'
    && finding.distribution === 'httpx'
    && finding.locked === '0.28.1'
    && finding.installed === '0.27.0'
  )));
});

test('a distribution the lock does not pin is a finding, not a tolerated extra', () => {
  const document = manifest();
  document.distributions.push({ name: 'requests', version: '2.34.2' });
  const result = verify({ manifest: document });
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((finding) => (
    finding.code === 'DISTRIBUTION_UNDECLARED' && finding.distribution === 'requests'
  )));
});

test('a runtime built from a different image or a different lock is a finding', () => {
  const wrongImage = verify({ manifest: manifest({ image: 'python@sha256:' + 'b'.repeat(64) }) });
  assert.equal(wrongImage.valid, false);
  assert.ok(wrongImage.findings.some((finding) => finding.code === 'RUNTIME_IMAGE_MISMATCH'));

  const wrongLock = verify({ manifest: manifest({ wheelsLockSha256: 'c'.repeat(64) }) });
  assert.equal(wrongLock.valid, false);
  assert.ok(wrongLock.findings.some((finding) => finding.code === 'RUNTIME_WHEELS_LOCK_MISMATCH'));
});

test('an absent or malformed manifest verifies nothing', () => {
  for (const document of [
    null,
    undefined,
    {},
    manifest({ schema: 'something-else' }),
    manifest({ version: 2 }),
    manifest({ distributions: 'graphiti-core' }),
    manifest({ distributions: [] }),
    manifest({ distributions: [{ name: 'httpx' }] })
  ]) {
    const result = verify({ manifest: document });
    assert.equal(result.valid, false, `${JSON.stringify(document)} must not verify`);
    assert.ok(result.findings.length > 0);
  }
});

test('a recorded import probe that failed is a finding', () => {
  // A recorded probe outcome is held to, whatever produced it. What the probe
  // observes is the runtime build's business, not this verifier's.
  const failed = verify({
    manifest: manifest({
      importProbes: [
        { armId: 'graphiti', expected: '0.29.3', observed: null, outcome: 'FAIL' },
        { armId: 'cognee', expected: '1.5.3', observed: '1.5.3', outcome: 'PASS' }
      ]
    })
  });
  assert.equal(failed.valid, false);
  assert.ok(failed.findings.some((finding) => (
    finding.code === 'IMPORT_PROBE_FAILED' && finding.armId === 'graphiti'
  )));

  const passed = verify({
    manifest: manifest({
      importProbes: [{ armId: 'cognee', expected: '1.5.3', observed: '1.5.3', outcome: 'PASS' }]
    })
  });
  assert.deepEqual(passed.findings, []);
});

test('probes are optional, but a malformed probe list is not tolerated', () => {
  assert.equal(verify({ manifest: manifest() }).valid, true);
  for (const importProbes of ['graphiti', [{ expected: '1.0.0', outcome: 'PASS' }]]) {
    const result = verify({ manifest: manifest({ importProbes }) });
    assert.equal(result.valid, false);
    assert.ok(result.findings.some((finding) => finding.code === 'RUNTIME_MANIFEST_MALFORMED'));
  }
});

test('normalization applies to the installed side too, so basic_memory satisfies basic-memory', () => {
  const document = manifest();
  document.distributions.find((entry) => entry.name === 'basic-memory').name = 'Basic_Memory';
  const result = verify({ manifest: document });
  assert.deepEqual(result.findings, []);
  assert.equal(result.valid, true);
});

test('every pinned Python arm declares the module its distribution imports', async () => {
  // The lock's own importProbe reads distribution metadata, which resolves a
  // .dist-info directory without executing the package. It would report PASS for
  // exactly the failure the lock documents for Graphiti: a wheel that installed
  // httpx2 and no httpx, where the first clean import raised ModuleNotFoundError
  // while the metadata resolved perfectly. The probe therefore imports the
  // module too, and the mapping has to cover every arm that has a probe.
  const competitorLock = JSON.parse(await readFile(
    fileURLToPath(new URL('../benchmark/competitors.lock.json', import.meta.url)),
    'utf8'
  ));

  const probed = Object.entries(competitorLock.arms)
    .filter(([, entry]) => entry.type === 'pypi' && typeof entry.importProbe === 'string')
    .map(([armId]) => armId)
    .sort();

  assert.deepEqual(Object.keys(PYTHON_IMPORT_MODULES).sort(), probed);
  for (const armId of probed) {
    assert.match(PYTHON_IMPORT_MODULES[armId], /^[a-z][a-z0-9_]*$/u, `${armId} module name`);
  }
  // The two that differ from their distribution name are why this cannot be
  // derived: a mapping that could be computed would not need declaring.
  assert.equal(PYTHON_IMPORT_MODULES['mem0-oss'], 'mem0');
  assert.equal(PYTHON_IMPORT_MODULES.graphiti, 'graphiti_core');
});

test('the site is read from its own metadata, so an in-place upgrade is visible', async (t) => {
  // A manifest is a claim about a directory. Verifying the claim and never
  // opening the directory is what let `pip install --target <site> --upgrade
  // httpx` pass the run path's bind-time refusal - the one case that refusal was
  // written for.
  const site = await scratchDirectory(t, 'shadowgraph-v11-site-');
  const write = async (directory, metadata) => {
    await mkdir(path.join(site, directory), { recursive: true });
    await writeFile(path.join(site, directory, 'METADATA'), metadata, 'utf8');
  };
  await write('httpx-0.28.1.dist-info', 'Metadata-Version: 2.1\nName: httpx\nVersion: 0.28.1\n\nSummary: x\n');
  await write('mem0ai-2.0.19.dist-info', 'Metadata-Version: 2.1\nName: mem0ai\nVersion: 2.0.19\n');
  // A .dist-info with no METADATA names nothing, and guessing a version from the
  // directory would be inventing evidence.
  await mkdir(path.join(site, 'orphan-9.9.9.dist-info'), { recursive: true });
  // And an ordinary package directory is not a distribution.
  await mkdir(path.join(site, 'httpx'), { recursive: true });

  assert.deepEqual(await readPythonSiteDistributions(site), [
    { name: 'httpx', version: '0.28.1' },
    { name: 'mem0ai', version: '2.0.19' }
  ]);

  // The upgrade the review demonstrated: the directory renamed and METADATA
  // rewritten, with the manifest left untouched.
  await rm(path.join(site, 'httpx-0.28.1.dist-info'), { recursive: true });
  await write('httpx-9.9.9.dist-info', 'Metadata-Version: 2.1\nName: httpx\nVersion: 9.9.9\n');

  const upgraded = await readPythonSiteDistributions(site);
  assert.deepEqual(upgraded.find((each) => each.name === 'httpx'), { name: 'httpx', version: '9.9.9' });

  // And that is what the bind-time verification is handed, so it is what fails.
  const verification = verifyPythonRuntime({
    manifest: {
      schema: PYTHON_RUNTIME_SCHEMA,
      version: PYTHON_RUNTIME_VERSION,
      image: 'python@sha256:' + 'a'.repeat(64),
      wheelsLockSha256: 'b'.repeat(64),
      distributions: upgraded
    },
    wheelsLock: { wheels: [
      { name: 'httpx==0.28.1', sha256: 'c'.repeat(64) },
      { name: 'mem0ai==2.0.19', sha256: 'd'.repeat(64) }
    ] },
    wheelsLockSha256: 'b'.repeat(64),
    image: 'python@sha256:' + 'a'.repeat(64)
  });
  assert.equal(verification.valid, false);
  assert.deepEqual(
    verification.findings.filter((finding) => finding.distribution === 'httpx'),
    [{ code: 'DISTRIBUTION_VERSION_MISMATCH', distribution: 'httpx', locked: '0.28.1', installed: '9.9.9' }]
  );
});

test('a site that cannot be read is refused rather than reported as empty', async () => {
  // An empty list would verify as "every locked distribution absent", which is a
  // finding - but it would be the wrong finding, and a caller reading it would
  // look for a broken build rather than a wrong path.
  await assert.rejects(
    readPythonSiteDistributions(path.join(fileURLToPath(new URL('.', import.meta.url)), 'no-such-site-directory')),
    /site could not be read/u
  );
  await assert.rejects(readPythonSiteDistributions(''), /site path is required/u);
});

test('an in-place upgrade leaves two dist-info directories, and both are reported', async (t) => {
  // What `pip install --target <site> --upgrade` actually does: it writes the new
  // distribution and leaves the superseded `.dist-info` in place. Demonstrated in
  // the pinned image - installing httpx 0.28.1 then upgrading to 0.27.2 left both
  // directories, with the interpreter resolving 0.27.2.
  //
  // Collapsing them last-wins made the verdict depend on readdir order, and
  // reported valid for exactly the case this verification exists to catch.
  const site = await scratchDirectory(t, 'shadowgraph-v11-site-dup-');
  const write = async (directory, file, metadata) => {
    await mkdir(path.join(site, directory), { recursive: true });
    await writeFile(path.join(site, directory, file), metadata, 'utf8');
  };
  await write('httpx-0.28.1.dist-info', 'METADATA', 'Name: httpx\nVersion: 0.28.1\n');
  await write('httpx-0.27.2.dist-info', 'METADATA', 'Name: httpx\nVersion: 0.27.2\n');
  // And a distribution installed the other way, which `importlib.metadata` sees
  // and a `.dist-info`-only reader did not.
  await write('mem0ai-2.0.19.egg-info', 'PKG-INFO', 'Name: mem0ai\nVersion: 2.0.19\n');

  const distributions = await readPythonSiteDistributions(site);
  assert.deepEqual(
    distributions.map((each) => `${each.name}==${each.version}`).sort(),
    ['httpx==0.27.2', 'httpx==0.28.1', 'mem0ai==2.0.19']
  );

  const verification = verifyPythonRuntime({
    manifest: {
      schema: PYTHON_RUNTIME_SCHEMA,
      version: PYTHON_RUNTIME_VERSION,
      image: IMAGE,
      wheelsLockSha256: LOCK_SHA256,
      distributions
    },
    wheelsLock: { wheels: [
      { name: 'httpx==0.28.1', sha256: 'c'.repeat(64) },
      { name: 'mem0ai==2.0.19', sha256: 'd'.repeat(64) }
    ] },
    wheelsLockSha256: LOCK_SHA256,
    image: IMAGE
  });

  assert.equal(verification.valid, false, 'two versions of one distribution is not a pinned runtime');
  assert.deepEqual(
    verification.findings.filter((finding) => finding.code === 'DISTRIBUTION_DUPLICATED'),
    [{ code: 'DISTRIBUTION_DUPLICATED', distribution: 'httpx', versions: ['0.27.2', '0.28.1'] }]
  );
});

test('the header scan stops at the blank line, and a leading mark is not part of a name', async (t) => {
  // Two guards, each with a fixture that actually reaches it. The first version
  // of this test reached neither: it put the byte-order mark in front of
  // `Metadata-Version:`, a line the parser skips, and its CR was already removed
  // by the `.trim()` on the extracted value. Both guards could be deleted and it
  // passed.
  const site = await scratchDirectory(t, 'shadowgraph-v11-site-headers-');
  const write = async (directory, metadata) => {
    await mkdir(path.join(site, directory), { recursive: true });
    await writeFile(path.join(site, directory, 'METADATA'), metadata, 'utf8');
  };

  // A byte-order mark immediately before `Name:` - the only position where it can
  // hide the header - so the strip is what makes this distribution nameable.
  await write('httpx-0.28.1.dist-info', '\ufeffName: httpx\nVersion: 0.28.1\n\nSummary: x\n');

  // CRLF, and a description beginning with a line that looks like a header. The
  // scan must stop at the blank line: without `trimEnd()` the carriage return
  // keeps that line from comparing equal to empty, the scan runs on into the
  // body, and the reader reports prose as the installed version.
  await write(
    'mem0ai-2.0.19.dist-info',
    'Metadata-Version: 2.1\r\nName: mem0ai\r\n\r\nVersion: 9.9.9 is what the changelog says\r\n'
  );

  assert.deepEqual(
    await readPythonSiteDistributions(site),
    [{ name: 'httpx', version: '0.28.1' }],
    'the second names no version, and prose is not one'
  );
});

test('a build records what it built; a verification records nothing', async () => {
  // The rule that has now been wrong here in both directions. Writing the current
  // image and wheel-lock hash before checking them made two of
  // `verifyPythonRuntime`'s findings compare each value with itself; reading the
  // recorded manifest instead fixed that and left the *import probes* recorded,
  // so the command ran four fresh probes, printed a failing one, and reported
  // valid. What the site can be asked now is measured now.
  const distributions = [{ name: 'httpx', version: '0.28.1' }];
  const importProbes = [{ armId: 'graphiti', outcome: 'FAIL', observed: null }];

  const built = pythonRuntimeManifest({
    verifyOnly: false,
    image: IMAGE,
    wheelsLockSha256: LOCK_SHA256,
    distributions,
    importProbes,
    builtAt: '2026-09-05T03:00:00.000Z'
  });
  assert.deepEqual(built, {
    schema: PYTHON_RUNTIME_SCHEMA,
    version: PYTHON_RUNTIME_VERSION,
    builtAt: '2026-09-05T03:00:00.000Z',
    image: IMAGE,
    wheelsLockSha256: LOCK_SHA256,
    distributions,
    importProbes
  });

  // A verification keeps only what it cannot re-observe.
  const recorded = {
    schema: PYTHON_RUNTIME_SCHEMA,
    version: PYTHON_RUNTIME_VERSION,
    builtAt: '2026-08-01T00:00:00.000Z',
    image: 'python@sha256:' + '9'.repeat(64),
    wheelsLockSha256: '8'.repeat(64),
    distributions: [{ name: 'httpx', version: '0.27.2' }],
    importProbes: [{ armId: 'graphiti', outcome: 'PASS', observed: '0.29.3' }]
  };
  const verified = pythonRuntimeManifest({ recorded, verifyOnly: true, distributions, importProbes });

  assert.equal(verified.image, recorded.image, 'the image it was built against cannot be re-observed');
  assert.equal(verified.wheelsLockSha256, recorded.wheelsLockSha256, 'nor the lock it was built from');
  assert.equal(verified.builtAt, recorded.builtAt);
  assert.deepEqual(verified.distributions, distributions, 'what the site holds now');
  assert.deepEqual(verified.importProbes, importProbes, 'and what the probes did now');

  // And the refusals.
  assert.throws(() => pythonRuntimeManifest({ verifyOnly: true, distributions, importProbes }), /requires the manifest the build wrote/u);
  assert.throws(() => pythonRuntimeManifest({ verifyOnly: false, distributions, importProbes }), /records the image/u);
  assert.throws(() => pythonRuntimeManifest({ verifyOnly: true, recorded, importProbes }), /distributions and import probes/u);
  assert.throws(() => pythonRuntimeManifest({ verifyOnly: true, recorded, distributions }), /distributions and import probes/u);
  assert.throws(() => pythonRuntimeManifest(), /distributions and import probes/u);
});

test('the listing the build command runs reports two versions of one distribution', async (t) => {
  // Run, not read. This script is what produces the `distributions` array both
  // the build and `--verify only` hand to `verifyPythonRuntime`, and it used to
  // collapse duplicates into a dictionary keyed by name - so
  // DISTRIBUTION_DUPLICATED could never fire from the only command that builds a
  // manifest, and F15's fix closed the hole on the run path only.
  const python = await pythonInterpreter();
  if (python === null) {
    t.skip('no python3 interpreter on PATH');
    return;
  }

  const site = await scratchDirectory(t, 'shadowgraph-v11-listing-');
  for (const version of ['0.27.2', '0.28.1']) {
    await mkdir(path.join(site, `httpx-${version}.dist-info`), { recursive: true });
    await writeFile(
      path.join(site, `httpx-${version}.dist-info`, 'METADATA'),
      `Metadata-Version: 2.1\nName: httpx\nVersion: ${version}\n`,
      'utf8'
    );
  }

  const { stdout } = await execFileAsync(python, ['-c', LIST_DISTRIBUTIONS_SCRIPT, site]);
  assert.deepEqual(JSON.parse(stdout), [
    { name: 'httpx', version: '0.27.2' },
    { name: 'httpx', version: '0.28.1' }
  ]);
});

test('a distribution with no version does not take the listing down with it', async (t) => {
  // The sort is what makes the duplicate visible, and it compares versions. A
  // .dist-info with no Version line yields None, sorting None against a string
  // is a TypeError, and the command dies with no listing at all - on exactly
  // the site whose duplicate it existed to report.
  const python = await pythonInterpreter();
  if (python === null) {
    t.skip('no python3 interpreter on PATH');
    return;
  }

  const site = await scratchDirectory(t, 'shadowgraph-v11-listing-noversion-');
  await mkdir(path.join(site, 'broken-0.0.0.dist-info'), { recursive: true });
  await writeFile(
    path.join(site, 'broken-0.0.0.dist-info', 'METADATA'),
    'Metadata-Version: 2.1\nName: broken\n',
    'utf8'
  );
  for (const version of ['0.27.2', '0.28.1']) {
    await mkdir(path.join(site, `httpx-${version}.dist-info`), { recursive: true });
    await writeFile(
      path.join(site, `httpx-${version}.dist-info`, 'METADATA'),
      `Metadata-Version: 2.1\nName: httpx\nVersion: ${version}\n`,
      'utf8'
    );
  }

  const { stdout } = await execFileAsync(python, ['-c', LIST_DISTRIBUTIONS_SCRIPT, site]);
  // The unversioned one is dropped - a name with no version pins nothing, which
  // is the same rule `readPythonSiteDistributions` applies - and the duplicate
  // it would have hidden is still reported.
  assert.deepEqual(JSON.parse(stdout), [
    { name: 'httpx', version: '0.27.2' },
    { name: 'httpx', version: '0.28.1' }
  ]);
});
