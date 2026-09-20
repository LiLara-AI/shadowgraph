// Verified precondition evidence: the input by which a declared isolation
// precondition may be treated as met.
//
// The precondition this exists for is Cognee's. Its native user ACL is real,
// but using it is conditional on a pinned backend access-control configuration,
// and until now the only way to say that condition held was a command-line
// flag. A flag is an assertion. These tests fix what a proof has to contain
// instead, and every one of them is paired: a record that establishes the
// precondition, and the same record with one part removed, which does not.
//
// The demanding rule is the required-step set. A demonstration that recorded
// only a refusal would pass a naive check while proving almost nothing - a
// broken store refuses too. The record must carry the positive control, the
// refusal, and the grant that turns the refusal into a success, or it
// establishes nothing.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRECONDITION_EVIDENCE_MAX_AGE_MS,
  PRECONDITION_EVIDENCE_SCHEMA,
  REQUIRED_DEMONSTRATION_STEPS,
  verifyPreconditionEvidence
} from '../benchmark/lib/v11-precondition-evidence.mjs';

const NOW = Date.parse('2026-09-05T06:00:00.000Z');
const OBSERVED_AT = '2026-09-05T05:55:00.000Z';
const PRECONDITION = 'pinned backend access-control configuration';

function declaredPreconditions() {
  return { cognee: PRECONDITION, 'mem0-oss': null, graphiti: null };
}

function pinnedPackages() {
  return { cognee: { name: 'cognee', version: '1.5.3' }, graphiti: { name: 'graphiti-core', version: '0.29.3' } };
}

function steps(overrides = {}) {
  return REQUIRED_DEMONSTRATION_STEPS.cognee.map((name) => ({
    step: name,
    outcome: overrides[name] ?? 'PASS',
    detail: `${name} detail`
  }));
}

function evidence(overrides = {}) {
  return {
    schema: PRECONDITION_EVIDENCE_SCHEMA,
    version: 1,
    armId: 'cognee',
    precondition: PRECONDITION,
    observedAt: OBSERVED_AT,
    package: { name: 'cognee', version: '1.5.3' },
    outcome: 'PASS',
    backendAccessControlEnabled: true,
    steps: steps(),
    ...overrides
  };
}

function verify(overrides = {}) {
  return verifyPreconditionEvidence({
    evidence: evidence(),
    declaredPreconditions: declaredPreconditions(),
    pinnedPackages: pinnedPackages(),
    now: NOW,
    ...overrides
  });
}

test('the required demonstration is a paired structure, not a bare refusal', () => {
  // If this list ever shrinks to just the refusal, the proof stops being one.
  for (const required of [
    'positive-control-own-dataset',
    'cross-user-read-refused',
    'grant',
    'cross-user-read-allowed-after-grant'
  ]) {
    assert.ok(
      REQUIRED_DEMONSTRATION_STEPS.cognee.includes(required),
      `${required} must be required`
    );
  }
});

test('a complete, fresh demonstration establishes its precondition', () => {
  const result = verify();
  assert.deepEqual(result.findings, []);
  assert.deepEqual([...result.satisfiedPreconditions], [PRECONDITION]);
});

test('absent evidence establishes nothing and is not an error', () => {
  for (const missing of [null, undefined]) {
    const result = verify({ evidence: missing });
    assert.deepEqual([...result.satisfiedPreconditions], []);
    assert.deepEqual(result.findings.map((finding) => finding.code), ['PRECONDITION_EVIDENCE_ABSENT']);
  }
});

test('a record that is not this schema establishes nothing', () => {
  for (const document of [
    {},
    evidence({ schema: 'shadowgraph.v11.something-else' }),
    evidence({ version: 2 }),
    evidence({ steps: 'posture' }),
    evidence({ steps: [] })
  ]) {
    const result = verify({ evidence: document });
    assert.deepEqual([...result.satisfiedPreconditions], []);
    assert.ok(result.findings.length > 0);
  }
});

test('a fatal probe record remains a declared failed demonstration before its first required step', () => {
  const result = verify({ evidence: evidence({
    outcome: 'FAIL',
    fatal: true,
    steps: []
  }) });
  assert.deepEqual([...result.satisfiedPreconditions], []);
  assert.ok(result.findings.some((finding) => finding.code === 'DEMONSTRATION_FAILED'));
  assert.equal(result.findings.some((finding) => finding.code === 'PRECONDITION_EVIDENCE_MALFORMED'), false);
});

test('a demonstration whose overall outcome is not PASS establishes nothing', () => {
  const result = verify({ evidence: evidence({ outcome: 'FAIL' }) });
  assert.deepEqual([...result.satisfiedPreconditions], []);
  assert.ok(result.findings.some((finding) => finding.code === 'DEMONSTRATION_FAILED'));
});

test('every required step must be present, and a missing one is named', () => {
  for (const omitted of REQUIRED_DEMONSTRATION_STEPS.cognee) {
    const document = evidence({ steps: steps().filter((entry) => entry.step !== omitted) });
    const result = verify({ evidence: document });
    assert.deepEqual([...result.satisfiedPreconditions], [], `omitting ${omitted} must establish nothing`);
    assert.ok(result.findings.some((finding) => (
      finding.code === 'DEMONSTRATION_STEP_MISSING' && finding.demonstrationStep === omitted
    )));
  }
});

test('a required step that ran and failed establishes nothing', () => {
  const document = evidence({ steps: steps({ 'cross-user-read-refused': 'FAIL' }) });
  const result = verify({ evidence: document });
  assert.deepEqual([...result.satisfiedPreconditions], []);
  assert.ok(result.findings.some((finding) => (
    finding.code === 'DEMONSTRATION_STEP_FAILED' && finding.demonstrationStep === 'cross-user-read-refused'
  )));
});

test('evidence outside the freshness window, or dated ahead, establishes nothing', () => {
  const stale = verify({ now: NOW + PRECONDITION_EVIDENCE_MAX_AGE_MS });
  assert.deepEqual([...stale.satisfiedPreconditions], []);
  assert.ok(stale.findings.some((finding) => finding.code === 'PRECONDITION_EVIDENCE_STALE'));

  const ahead = verify({ now: Date.parse(OBSERVED_AT) - 1 });
  assert.deepEqual([...ahead.satisfiedPreconditions], []);
  assert.ok(ahead.findings.some((finding) => finding.code === 'PRECONDITION_EVIDENCE_FUTURE_DATED'));
});

test('the precondition string must be the one the registry declares, exactly', () => {
  for (const claimed of [
    'pinned backend access control configuration',
    'PINNED BACKEND ACCESS-CONTROL CONFIGURATION',
    'pinned backend access-control configuration ',
    'some other precondition'
  ]) {
    const result = verify({ evidence: evidence({ precondition: claimed }) });
    assert.deepEqual([...result.satisfiedPreconditions], [], `${claimed} must not establish the precondition`);
    assert.ok(result.findings.some((finding) => finding.code === 'PRECONDITION_MISMATCH'));
  }
});

test('an arm the registry declares no precondition for cannot be satisfied', () => {
  const result = verify({ evidence: evidence({ armId: 'graphiti' }) });
  assert.deepEqual([...result.satisfiedPreconditions], []);
  assert.ok(result.findings.some((finding) => finding.code === 'PRECONDITION_ARM_UNDECLARED'));

  const unknown = verify({ evidence: evidence({ armId: 'not-an-arm' }) });
  assert.ok(unknown.findings.some((finding) => finding.code === 'PRECONDITION_ARM_UNDECLARED'));
});

test('the demonstrated package must be the version the competitor lock pins', () => {
  for (const pkg of [
    { name: 'cognee', version: '1.5.2' },
    { name: 'cognee-core', version: '1.5.3' },
    { name: 'cognee' },
    'cognee'
  ]) {
    const result = verify({ evidence: evidence({ package: pkg }) });
    assert.deepEqual([...result.satisfiedPreconditions], [], `${JSON.stringify(pkg)} must not establish it`);
    assert.ok(result.findings.some((finding) => (
      finding.code === 'PRECONDITION_PACKAGE_MISMATCH' || finding.code === 'PRECONDITION_EVIDENCE_MALFORMED'
    )));
  }
});

test('a demonstration recorded with access control disabled establishes nothing', () => {
  // The precondition IS the posture. A record that proves an ACL boundary while
  // reporting the posture off is describing some other configuration.
  const result = verify({ evidence: evidence({ backendAccessControlEnabled: false }) });
  assert.deepEqual([...result.satisfiedPreconditions], []);
  assert.ok(result.findings.some((finding) => finding.code === 'PRECONDITION_POSTURE_NOT_ENABLED'));
});

test('the baseline is required, and without it nothing is established', () => {
  for (const input of [
    { declaredPreconditions: null },
    { declaredPreconditions: {} },
    { pinnedPackages: null },
    { pinnedPackages: {} },
    { now: Number.NaN }
  ]) {
    const result = verify(input);
    assert.deepEqual([...result.satisfiedPreconditions], []);
    assert.ok(result.findings.length > 0);
  }
});

test('the result records what this verification cannot establish', () => {
  const result = verify();
  assert.match(result.note, /cannot establish/iu);
});

test('a step recorded twice cannot shadow its own failure', () => {
  // Found by attacking this module. A record could carry a genuine
  // cross-user-read-refused FAIL and then a duplicate PASS; the later entry
  // overwrote the earlier one, every required step was present and passing, and
  // the precondition was satisfied with an empty findings list. That is the
  // worst shape a gate can have: silently satisfied.
  const document = evidence({
    steps: [
      { step: 'cross-user-read-refused', outcome: 'FAIL', detail: 'the boundary did not hold' },
      ...steps()
    ]
  });

  const result = verify({ evidence: document });
  assert.deepEqual([...result.satisfiedPreconditions], []);
  assert.ok(result.findings.some((finding) => (
    finding.code === 'DEMONSTRATION_STEP_DUPLICATED'
    && finding.demonstrationStep === 'cross-user-read-refused'
  )));
});

test('two identical passing records of one step are still refused', () => {
  const document = evidence({ steps: [...steps(), { step: 'grant', outcome: 'PASS', detail: 'again' }] });
  const result = verify({ evidence: document });
  assert.deepEqual([...result.satisfiedPreconditions], []);
  assert.ok(result.findings.some((finding) => finding.code === 'DEMONSTRATION_STEP_DUPLICATED'));
});

test('an arm id that resolves through the prototype chain is refused, not thrown on', () => {
  // `constructor` and `toString` are truthy on any plain object, so indexing the
  // declared matrix with one used to yield a function that sailed past the null
  // check and was then iterated as a step list.
  for (const armId of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    let result;
    assert.doesNotThrow(() => { result = verify({ evidence: evidence({ armId }) }); }, `${armId} must not throw`);
    assert.deepEqual([...result.satisfiedPreconditions], [], `${armId} must establish nothing`);
    assert.ok(result.findings.some((finding) => finding.code === 'PRECONDITION_ARM_UNDECLARED'));
  }
});

test('the freshness boundary is measured from the record, and expires at the window', () => {
  // As in the service gate: the earlier test advanced `now` by the whole window
  // from NOW while the record was stamped five minutes earlier, so it asserted
  // an age of window+5min and held under both > and >=.
  const observedAt = Date.parse(OBSERVED_AT);

  const atWindow = verify({ now: observedAt + PRECONDITION_EVIDENCE_MAX_AGE_MS });
  assert.deepEqual([...atWindow.satisfiedPreconditions], []);
  assert.ok(atWindow.findings.some((finding) => finding.code === 'PRECONDITION_EVIDENCE_STALE'));

  const justInside = verify({ now: observedAt + PRECONDITION_EVIDENCE_MAX_AGE_MS - 1 });
  assert.deepEqual([...justInside.satisfiedPreconditions], [PRECONDITION]);
  assert.deepEqual(justInside.findings, []);
});
