// The evidence index and review bundle.
//
// The property under test throughout is that a review verdict can be bound to
// exact bytes: the same inputs must always produce the same bundle digest, a
// changed artifact must change it, and a gap must be refused rather than
// shipped.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE_KINDS,
  EvidenceBundleError,
  buildEvidenceIndex,
  buildReviewBundle,
  bundleDigest,
  evidenceIndexDigest,
  verifyReviewBundle
} from '../benchmark/lib/v11-evidence-bundle.mjs';

const COMMIT = 'a'.repeat(40);
const SOURCE_HASHES = Object.freeze({
  preregistrationSha256: '738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac',
  amendment001Sha256: '2b209df6ca46a179e332acd4ed0b16a35a089f5c14575dd86353db0dc7249c4a',
  amendment002Sha256: '08e12eca3f93bd67cfeaf90a2064f91beb240e78a8fd63ed8645da78c0d88f1b'
});

function entry(overrides = {}) {
  return {
    path: 'benchmark/preregistration.json',
    kind: 'frozen-methodology',
    sha256: SOURCE_HASHES.preregistrationSha256,
    bytes: 4096,
    ...overrides
  };
}

function sampleEntries() {
  return [
    entry(),
    entry({
      path: 'benchmark/acceptance/definition.json',
      kind: 'acceptance-definition',
      sha256: 'b'.repeat(64),
      bytes: 2048
    }),
    entry({
      path: 'benchmark/results/attempt.raw.json',
      kind: 'raw-run',
      sha256: 'c'.repeat(64),
      bytes: 8192
    })
  ];
}

function bundleOf(entries, overrides = {}) {
  return buildReviewBundle({
    commit: COMMIT,
    implementationLockHash: '4'.repeat(64),
    environmentLockHash: '5'.repeat(64),
    sourceHashes: SOURCE_HASHES,
    scored: false,
    index: buildEvidenceIndex({ entries }),
    ...overrides
  });
}

test('the index is a function of its contents, not of collection order', () => {
  const forward = buildEvidenceIndex({ entries: sampleEntries() });
  const reversed = buildEvidenceIndex({ entries: [...sampleEntries()].reverse() });

  assert.deepEqual(forward, reversed);
  assert.equal(evidenceIndexDigest(forward), evidenceIndexDigest(reversed));
  assert.deepEqual(
    forward.entries.map((item) => item.path),
    [
      'benchmark/acceptance/definition.json',
      'benchmark/preregistration.json',
      'benchmark/results/attempt.raw.json'
    ]
  );
  assert.equal(forward.entryCount, 3);
});

test('the bundle is byte-identical across builds from the same inputs', () => {
  const first = bundleOf(sampleEntries());
  const second = bundleOf([...sampleEntries()].reverse());

  assert.equal(first.bytes, second.bytes);
  assert.equal(first.digest, second.digest);
  assert.equal(bundleDigest(first.bundle), first.digest);

  // A reviewer rebuilds the bundle and compares bytes, so the serialization has
  // to be stable down to key order - not merely equal as a parsed object.
  const keysInOrder = (value) => Object.keys(JSON.parse(value));
  assert.deepEqual(keysInOrder(first.bytes), [...keysInOrder(first.bytes)].sort());
  assert.equal(first.bytes.endsWith('\n'), true, 'bundle bytes must end with a newline');
  assert.equal(first.bytes.includes('\n', 0), true);
  assert.equal(first.bytes.trimEnd().includes('\n'), false, 'bundle bytes must be one line');
});

test('any change to any indexed artifact changes the bundle digest', () => {
  const baseline = bundleOf(sampleEntries()).digest;

  const changedDigest = bundleOf(sampleEntries().map((item) => (
    item.kind === 'raw-run' ? { ...item, sha256: 'd'.repeat(64) } : item
  ))).digest;
  assert.notEqual(changedDigest, baseline);

  const changedSize = bundleOf(sampleEntries().map((item) => (
    item.kind === 'raw-run' ? { ...item, bytes: 8193 } : item
  ))).digest;
  assert.notEqual(changedSize, baseline);

  const changedCommit = bundleOf(sampleEntries(), { commit: 'b'.repeat(40) }).digest;
  assert.notEqual(changedCommit, baseline);

  const changedLock = bundleOf(sampleEntries(), { implementationLockHash: '6'.repeat(64) }).digest;
  assert.notEqual(changedLock, baseline);
});

test('a fabricated or malformed digest is refused rather than indexed', () => {
  for (const bad of ['', 'not-a-digest', 'A'.repeat(64), 'a'.repeat(63), `sha256:${'a'.repeat(64)}`]) {
    assert.throws(
      () => buildEvidenceIndex({ entries: [entry({ sha256: bad })] }),
      (error) => error instanceof EvidenceBundleError && error.code === 'INVALID_DIGEST',
      `accepted ${JSON.stringify(bad)}`
    );
  }
});

test('the same path twice is a contradiction, not something to deduplicate', () => {
  assert.throws(
    () => buildEvidenceIndex({
      entries: [entry(), entry({ sha256: 'e'.repeat(64) })]
    }),
    (error) => error instanceof EvidenceBundleError && error.code === 'DUPLICATE_PATH'
  );
});

test('an escaping or absolute path is refused', () => {
  for (const bad of ['/etc/passwd', '../outside.json', 'benchmark/../../outside.json', 'a\\b.json']) {
    assert.throws(
      () => buildEvidenceIndex({ entries: [entry({ path: bad })] }),
      (error) => error instanceof EvidenceBundleError && error.code === 'UNSAFE_PATH',
      `accepted ${bad}`
    );
  }
});

test('an empty index is refused because it would attest to nothing', () => {
  assert.throws(
    () => buildEvidenceIndex({ entries: [] }),
    (error) => error instanceof EvidenceBundleError && error.code === 'EMPTY_INDEX'
  );
});

test('an unrecognised evidence kind is refused', () => {
  assert.throws(
    () => buildEvidenceIndex({ entries: [entry({ kind: 'vibes' })] }),
    (error) => error instanceof EvidenceBundleError && error.code === 'UNKNOWN_KIND'
  );
  // Every kind the module advertises is actually accepted.
  for (const kind of EVIDENCE_KINDS) {
    assert.doesNotThrow(() => buildEvidenceIndex({ entries: [entry({ kind })] }));
  }
});

test('a bundle missing required evidence is refused, not shipped with a gap', () => {
  assert.throws(
    () => bundleOf(sampleEntries(), {
      requiredCoverage: ['frozen-methodology', 'implementation-lock', 'provider-ledger']
    }),
    (error) => error instanceof EvidenceBundleError
      && error.code === 'INCOMPLETE_COVERAGE'
      && /implementation-lock, provider-ledger/u.test(error.message)
  );

  assert.doesNotThrow(() => bundleOf(sampleEntries(), {
    requiredCoverage: ['frozen-methodology', 'raw-run']
  }));
});

test('this candidate cannot bundle a scored run', () => {
  assert.throws(
    () => bundleOf(sampleEntries(), { scored: true }),
    (error) => error instanceof EvidenceBundleError && error.code === 'SCORED_BUNDLE'
  );
  assert.equal(bundleOf(sampleEntries()).bundle.scored, false);
});

test('a short or malformed commit id is refused', () => {
  for (const bad of ['a'.repeat(39), 'a'.repeat(41), 'HEAD', '']) {
    assert.throws(
      () => bundleOf(sampleEntries(), { commit: bad }),
      (error) => error instanceof EvidenceBundleError && error.code === 'INVALID_COMMIT',
      `accepted ${bad}`
    );
  }
});

test('verification confirms a matching tree and reports every discrepancy at once', () => {
  const { bundle, digest } = bundleOf(sampleEntries());
  const observed = Object.fromEntries(
    bundle.index.entries.map((item) => [item.path, item.sha256])
  );

  assert.deepEqual(
    verifyReviewBundle({ bundle, observed, expectedDigest: digest }),
    { verified: true, findings: [] }
  );

  const broken = { ...observed };
  broken['benchmark/results/attempt.raw.json'] = 'f'.repeat(64);
  delete broken['benchmark/preregistration.json'];
  broken['benchmark/unlisted.json'] = '0'.repeat(64);

  const result = verifyReviewBundle({ bundle, observed: broken, expectedDigest: digest });
  assert.equal(result.verified, false);
  assert.deepEqual(result.findings, [
    { code: 'ARTIFACT_DIGEST_MISMATCH', path: 'benchmark/results/attempt.raw.json' },
    { code: 'MISSING_ARTIFACT', path: 'benchmark/preregistration.json' },
    { code: 'UNINDEXED_ARTIFACT', path: 'benchmark/unlisted.json' }
  ]);
});

test('a bundle whose index was swapped after the fact does not verify', () => {
  const { bundle } = bundleOf(sampleEntries());
  const tampered = structuredClone(bundle);
  tampered.index.entries[0].sha256 = '9'.repeat(64);

  const observed = Object.fromEntries(
    tampered.index.entries.map((item) => [item.path, item.sha256])
  );
  const result = verifyReviewBundle({ bundle: tampered, observed });
  assert.equal(result.verified, false);
  assert.ok(result.findings.some((finding) => finding.code === 'INDEX_DIGEST_MISMATCH'));
});

test('a verdict bound to one digest does not carry to a different bundle', () => {
  const original = bundleOf(sampleEntries());
  const other = bundleOf(sampleEntries(), { commit: 'c'.repeat(40) });
  const observed = Object.fromEntries(
    other.bundle.index.entries.map((item) => [item.path, item.sha256])
  );

  const result = verifyReviewBundle({
    bundle: other.bundle,
    observed,
    expectedDigest: original.digest
  });
  assert.equal(result.verified, false);
  assert.ok(result.findings.some((finding) => finding.code === 'BUNDLE_DIGEST_MISMATCH'));
});
