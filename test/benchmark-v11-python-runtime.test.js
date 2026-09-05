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
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PYTHON_IMPORT_MODULES,
  PYTHON_RUNTIME_SCHEMA,
  PythonRuntimeError,
  lockedDistributions,
  normalizeDistributionName,
  renderRequirements,
  verifyPythonRuntime
} from '../benchmark/lib/v11-python-runtime.mjs';

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
