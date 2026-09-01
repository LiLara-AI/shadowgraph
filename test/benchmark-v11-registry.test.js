import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  NATIVE_ISOLATION,
  RegistryError,
  V11_ARM_IDS,
  createV11Registry
} from '../benchmark/lib/v11-registry.mjs';

const IMAGE = 'python@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f';
const PHASES = [
  'RESET', 'A', 'B', 'C', 'D_TRUE', 'D_FALSE_0', 'D_FALSE_1', 'D_FALSE_2',
  'E', 'ISOLATION_PROJECT', 'ISOLATION_USER'
];

async function realLock() {
  return JSON.parse(await readFile(
    fileURLToPath(new URL('../benchmark/competitors.lock.json', import.meta.url)),
    'utf8'
  ));
}

async function registry() {
  return createV11Registry({ competitorLock: await realLock(), containerImage: IMAGE });
}

function applicability(overrides = {}) {
  const declared = {};
  for (const armId of V11_ARM_IDS) {
    declared[armId] = {
      userIsolation: { status: 'NOT_APPLICABLE', reason: 'default' },
      persistence: { status: 'SUPPORTED', reason: null }
    };
  }
  for (const [armId, status] of Object.entries(overrides)) {
    declared[armId] = {
      userIsolation: { status, reason: status === 'SUPPORTED' ? null : 'declared' },
      persistence: { status: 'SUPPORTED', reason: null }
    };
  }
  return declared;
}

function codes(result) {
  return result.findings.map((finding) => finding.code);
}

test('the registry binds every frozen arm to a runtime from the real competitor lock', async () => {
  const built = await registry();
  assert.deepEqual(built.armIds, V11_ARM_IDS);
  assert.equal(built.descriptors.length, 7);

  assert.equal(built.descriptorFor('no-memory').kind, 'control');
  assert.equal(built.descriptorFor('shadowgraph-full').kind, 'node-mcp');
  assert.equal(built.descriptorFor('shadowgraph-compact').mode, 'compact');
  for (const armId of ['mem0-oss', 'graphiti', 'basic-memory', 'cognee']) {
    const descriptor = built.descriptorFor(armId);
    assert.equal(descriptor.kind, 'python-container', armId);
    assert.equal(descriptor.containerImage, IMAGE, armId);
  }
  assert.throws(() => built.descriptorFor('nope'), RegistryError);
});

test('a lock that disagrees with the adapter spec version is refused', async () => {
  // The lock is the authority on which version runs. If the executor spec
  // pinned a different one, the harness would meter software the lock does not
  // describe.
  const lock = await realLock();
  lock.arms['mem0-oss'].version = '2.0.20';
  assert.throws(
    () => createV11Registry({ competitorLock: lock, containerImage: IMAGE }),
    /version disagrees/u
  );
});

test('the frozen arm set is closed in both directions', async () => {
  const missing = await realLock();
  delete missing.arms.graphiti;
  assert.throws(
    () => createV11Registry({ competitorLock: missing, containerImage: IMAGE }),
    /missing frozen arm graphiti/u
  );

  const extra = await realLock();
  extra.arms['some-other-product'] = { type: 'pypi', package: 'x', version: '1' };
  assert.throws(
    () => createV11Registry({ competitorLock: extra, containerImage: IMAGE }),
    /outside the frozen set/u
  );
});

test('only a digest-pinned runtime image is accepted', async () => {
  const lock = await realLock();
  for (const containerImage of ['python:3.12.11-slim', '', null]) {
    assert.throws(
      () => createV11Registry({ competitorLock: lock, containerImage }),
      RegistryError
    );
  }
});

test('isolation is recorded from what each product exposes, never manufactured', () => {
  // Arms with a project scope but no user scope must report null rather than
  // synthesising a user namespace by folding a user id into the project.
  for (const armId of ['shadowgraph-full', 'shadowgraph-compact', 'graphiti', 'basic-memory']) {
    assert.equal(NATIVE_ISOLATION[armId].userNamespace, null, armId);
    assert.notEqual(NATIVE_ISOLATION[armId].projectNamespace, null, armId);
  }
  assert.equal(NATIVE_ISOLATION['no-memory'].projectNamespace, null);

  // Mem0 carries two genuinely independent native scopes.
  assert.equal(NATIVE_ISOLATION['mem0-oss'].projectNamespace, 'agent_id');
  assert.equal(NATIVE_ISOLATION['mem0-oss'].userNamespace, 'user_id');
  assert.notEqual(
    NATIVE_ISOLATION['mem0-oss'].projectNamespace,
    NATIVE_ISOLATION['mem0-oss'].userNamespace
  );

  // Cognee has the capability but it is only usable once pinned.
  assert.equal(NATIVE_ISOLATION.cognee.userNamespace, 'user');
  assert.equal(
    NATIVE_ISOLATION.cognee.userNamespacePrecondition,
    'pinned backend access-control configuration'
  );
});

test('a declared isolation the product cannot provide is reported, not resolved', async () => {
  const built = await registry();

  // This is the recorded Amendment 002 position for graphiti. The probe found
  // no user scope at the pinned version, so the declaration cannot stand.
  const result = built.verifyApplicability(applicability({ graphiti: 'SUPPORTED' }));
  assert.equal(result.status, 'INCONSISTENT');
  const finding = result.findings.find((entry) => entry.armId === 'graphiti');
  assert.equal(finding.code, 'DECLARED_ISOLATION_UNAVAILABLE');
  assert.equal(finding.observed, 'no native user namespace');

  // The registry reports; it does not silently rewrite the matrix.
  assert.equal(NATIVE_ISOLATION.graphiti.userNamespace, null);
});

test('a present capability still fails while its precondition is unpinned', async () => {
  const built = await registry();

  // mem0-oss is declared SUPPORTED here too, so cognee's precondition is the
  // only thing left to report.
  const declared = applicability({ 'mem0-oss': 'SUPPORTED', cognee: 'SUPPORTED' });

  const unpinned = built.verifyApplicability(declared);
  assert.deepEqual(codes(unpinned), ['DECLARED_ISOLATION_PRECONDITION_UNMET']);
  assert.equal(unpinned.findings[0].armId, 'cognee');

  const pinned = built.verifyApplicability(
    declared,
    ['pinned backend access-control configuration']
  );
  assert.equal(pinned.status, 'CONSISTENT');
});

test('a capability the matrix omits is reported as an adapter gap', async () => {
  const built = await registry();
  // Mem0 has native user isolation; declaring it NOT_APPLICABLE understates it.
  const result = built.verifyApplicability(applicability());
  assert.ok(codes(result).includes('UNDECLARED_ISOLATION_AVAILABLE'));
  assert.ok(result.findings.some((entry) => entry.armId === 'mem0-oss'));
});

test('a fully truthful matrix is consistent', async () => {
  const built = await registry();
  const result = built.verifyApplicability(
    applicability({ 'mem0-oss': 'SUPPORTED', cognee: 'SUPPORTED' }),
    ['pinned backend access-control configuration']
  );
  assert.equal(result.status, 'CONSISTENT');
  assert.deepEqual(result.findings, []);
});

test('expected counts are derived from the matrix in force, not restated', async () => {
  const built = await registry();
  const shape = { scenarios: 2, repetitions: 2, phases: PHASES };

  // Amendment 002 as declared: mem0-oss, graphiti and cognee SUPPORTED.
  assert.deepEqual(built.expectedCounts({
    ...shape,
    declared: applicability({ 'mem0-oss': 'SUPPORTED', graphiti: 'SUPPORTED', cognee: 'SUPPORTED' })
  }), {
    totalUnits: 308,
    excludedUnits: 16,
    measuredUnits: 292,
    resetUnits: 28,
    outerDecisionCalls: 264
  });

  // With graphiti corrected to NOT_APPLICABLE and cognee retained, its four
  // ISOLATION_USER units move from measured to excluded.
  assert.deepEqual(built.expectedCounts({
    ...shape,
    declared: applicability({ 'mem0-oss': 'SUPPORTED', cognee: 'SUPPORTED' })
  }), {
    totalUnits: 308,
    excludedUnits: 20,
    measuredUnits: 288,
    resetUnits: 28,
    outerDecisionCalls: 260
  });
});

test('count derivation refuses malformed shapes', async () => {
  const built = await registry();
  const declared = applicability();
  assert.throws(() => built.expectedCounts({
    scenarios: 0, repetitions: 2, phases: PHASES, declared
  }), RegistryError);
  assert.throws(() => built.expectedCounts({
    scenarios: 2, repetitions: 2, phases: [], declared
  }), RegistryError);
  assert.throws(() => built.expectedCounts({
    scenarios: 2, repetitions: 2, phases: PHASES, declared: null
  }), RegistryError);
});
