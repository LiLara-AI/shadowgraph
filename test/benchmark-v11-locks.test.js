// Environment, service and model locks.
//
// The property under test throughout is refusal. A lock exists so a reader can
// tell whether two runs are comparable; one built from partial evidence answers
// that wrongly and looks authoritative doing it. Every test below is either "it
// refuses incomplete evidence" or "the same inputs always produce the same
// bytes".

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENVIRONMENT_FIELDS,
  ENVIRONMENT_SHAPE,
  LockError,
  buildEnvironmentLock,
  buildModelLock,
  buildServiceLock,
  verifyLock
} from '../benchmark/lib/v11-locks.mjs';

function environment(overrides = {}) {
  return {
    osType: 'Linux',
    osRelease: '6.6.87.2-microsoft-standard-WSL2',
    arch: 'x64',
    cpuModel: 'Fixture CPU @ 3.00GHz',
    cpuCount: 8,
    totalMemoryBytes: 16_000_000_000,
    nodeVersion: 'v24.18.1',
    npmVersion: '11.0.0',
    pythonVersion: 'Python 3.12.11',
    containerRuntimeVersion: 'Docker 29.7.1',
    ...overrides
  };
}

const SERVICE = Object.freeze({
  name: 'neo4j',
  armId: 'graphiti',
  image: `neo4j@sha256:${'a'.repeat(64)}`
});

const MODEL = Object.freeze({
  modelId: 'fixture-outer-model',
  requestClass: 'outer_decision_llm',
  digestKind: 'model_weights',
  weightsDigest: `sha256:${'b'.repeat(64)}`
});

test('an environment lock records every field or refuses to exist', () => {
  const built = buildEnvironmentLock({ observations: environment() });
  assert.equal(built.lock.schema, 'shadowgraph.v11.environment-lock');
  assert.match(built.digest, /^[a-f0-9]{64}$/u);

  for (const field of ENVIRONMENT_FIELDS) {
    const partial = environment();
    delete partial[field];
    assert.throws(
      () => buildEnvironmentLock({ observations: partial }),
      (error) => error instanceof LockError
        && error.code === 'INCOMPLETE_ENVIRONMENT'
        && error.message.includes(field),
      `a missing ${field} was accepted`
    );
  }
});

test('a placeholder in a numeric field is not an observation', () => {
  // The first version of this builder accepted any non-empty string OR any
  // positive number for every field, so a count could be satisfied by prose.
  // "unknown" recorded in cpuCount is precisely the gap the module header says
  // an unexplained difference between two runs would hide - written by the
  // builder that exists to refuse it. Independent review found it.
  const counts = ENVIRONMENT_FIELDS.filter((field) => ENVIRONMENT_SHAPE[field] === 'count');
  assert.ok(counts.length >= 2, 'the fixture must exercise more than one numeric field');

  for (const field of counts) {
    for (const placeholder of ['unknown', 'N/A', '-', '8', '  ', 8.5, Number.NaN, Infinity]) {
      assert.throws(
        () => buildEnvironmentLock({ observations: environment({ [field]: placeholder }) }),
        (error) => error instanceof LockError && error.code === 'INCOMPLETE_ENVIRONMENT',
        `${field}=${JSON.stringify(placeholder)} was accepted as a count`
      );
    }
  }

  // And the converse: a number is not a description.
  const strings = ENVIRONMENT_FIELDS.filter((field) => ENVIRONMENT_SHAPE[field] === 'string');
  for (const field of strings) {
    assert.throws(
      () => buildEnvironmentLock({ observations: environment({ [field]: 12345 }) }),
      (error) => error instanceof LockError && error.code === 'INCOMPLETE_ENVIRONMENT',
      `${field}=12345 was accepted as a description`
    );
  }
});

test('a service image and its recorded digest cannot disagree', () => {
  // Two '@' sections destructured the first digest while the recorded image
  // kept the whole string including the second, so image and digest named
  // different things inside a lock whose purpose is that they agree.
  const doubled = `neo4j@sha256:${'a'.repeat(64)}@sha256:${'b'.repeat(64)}`;
  assert.throws(
    () => buildServiceLock({ services: [{ ...SERVICE, image: doubled }] }),
    (error) => error instanceof LockError
      && error.code === 'UNPINNED_SERVICE'
      && /more than one digest/u.test(error.message)
  );

  // What is recorded round-trips: repository + '@' + digest reconstructs image.
  const { lock } = buildServiceLock({ services: [SERVICE] });
  const [entry] = lock.services;
  assert.equal(`${entry.repository}@${entry.digest}`, entry.image);
});

test('an empty or zero environment value is missing evidence, not evidence', () => {
  for (const [field, bad] of [['cpuModel', '   '], ['cpuCount', 0], ['totalMemoryBytes', -1]]) {
    assert.throws(
      () => buildEnvironmentLock({ observations: environment({ [field]: bad }) }),
      (error) => error instanceof LockError && error.code === 'INCOMPLETE_ENVIRONMENT',
      `${field}=${JSON.stringify(bad)} was accepted`
    );
  }
});

test('an environment fact the lock does not record is refused, not dropped', () => {
  // Silently ignoring an extra observation would let a caller believe something
  // was pinned when the lock never carried it.
  assert.throws(
    () => buildEnvironmentLock({ observations: environment({ gpuModel: 'Fixture GPU' }) }),
    (error) => error instanceof LockError
      && error.code === 'UNKNOWN_ENVIRONMENT_FIELD'
      && error.message.includes('gpuModel')
  );
});

test('a service pinned by tag is not pinned', () => {
  for (const image of ['neo4j:5.20', 'neo4j', 'neo4j:latest']) {
    assert.throws(
      () => buildServiceLock({ services: [{ ...SERVICE, image }] }),
      (error) => error instanceof LockError && error.code === 'UNPINNED_SERVICE',
      `${image} was accepted as pinned`
    );
  }
});

test('a malformed service digest is refused', () => {
  for (const digest of ['sha256:short', `sha256:${'A'.repeat(64)}`, 'md5:abc', `${'a'.repeat(64)}`]) {
    assert.throws(
      () => buildServiceLock({ services: [{ ...SERVICE, image: `neo4j@${digest}` }] }),
      (error) => error instanceof LockError && error.code === 'INVALID_SERVICE_DIGEST',
      `${digest} was accepted`
    );
  }
});

test('a service lock is sorted, deduplicated by refusal, and never empty', () => {
  const second = { name: 'ollama', armId: 'cognee', image: `ollama@sha256:${'c'.repeat(64)}` };
  const forward = buildServiceLock({ services: [SERVICE, second] });
  const reversed = buildServiceLock({ services: [second, SERVICE] });
  assert.equal(forward.bytes, reversed.bytes);
  assert.equal(forward.digest, reversed.digest);
  assert.deepEqual(forward.lock.services.map((service) => service.name), ['neo4j', 'ollama']);
  assert.equal(forward.lock.serviceCount, 2);

  assert.throws(
    () => buildServiceLock({ services: [SERVICE, { ...SERVICE, image: `neo4j@sha256:${'d'.repeat(64)}` }] }),
    (error) => error instanceof LockError && error.code === 'DUPLICATE_SERVICE'
  );
  assert.throws(
    () => buildServiceLock({ services: [] }),
    (error) => error instanceof LockError && error.code === 'EMPTY_SERVICE_LOCK'
  );
});

test('a short model identifier cannot pin weights — this is blocker B1 in code', () => {
  // MISSING-EVIDENCE.md records that only short Ollama ids were captured. A
  // short id cannot distinguish two weight sets a registry labelled the same
  // way, so the builder refuses rather than producing a lock that reads as
  // authoritative. Passing one is exactly what this candidate could do today.
  for (const weightsDigest of ['a1b2c3d4e5f6', 'sha256:a1b2c3d4e5f6', 'llama3.1:8b', '', null]) {
    assert.throws(
      () => buildModelLock({ models: [{ ...MODEL, weightsDigest }] }),
      (error) => error instanceof LockError && error.code === 'UNPINNED_MODEL',
      `${JSON.stringify(weightsDigest)} was accepted as a weights digest`
    );
  }
  // The bare form is not enough either: a weights digest is prefixed.
  assert.throws(
    () => buildModelLock({ models: [{ ...MODEL, weightsDigest: 'b'.repeat(64) }] }),
    (error) => error instanceof LockError && error.code === 'UNPINNED_MODEL'
  );
});

test('a digest of something other than weights is refused', () => {
  for (const digestKind of ['manifest', 'image', undefined, null]) {
    assert.throws(
      () => buildModelLock({ models: [{ ...MODEL, digestKind }] }),
      (error) => error instanceof LockError && error.code === 'WRONG_DIGEST_KIND',
      `digestKind ${String(digestKind)} was accepted`
    );
  }
});

test('a model lock is sorted, refuses duplicates, and is never empty', () => {
  const second = {
    modelId: 'fixture-embedding-model',
    requestClass: 'embedding',
    digestKind: 'model_weights',
    weightsDigest: `sha256:${'e'.repeat(64)}`
  };
  const forward = buildModelLock({ models: [MODEL, second] });
  const reversed = buildModelLock({ models: [second, MODEL] });
  assert.equal(forward.bytes, reversed.bytes);
  assert.equal(forward.digest, reversed.digest);
  assert.deepEqual(
    forward.lock.models.map((model) => model.modelId),
    ['fixture-embedding-model', 'fixture-outer-model']
  );

  assert.throws(
    () => buildModelLock({ models: [MODEL, { ...MODEL, weightsDigest: `sha256:${'f'.repeat(64)}` }] }),
    (error) => error instanceof LockError && error.code === 'DUPLICATE_MODEL'
  );
  assert.throws(
    () => buildModelLock({ models: [] }),
    (error) => error instanceof LockError && error.code === 'EMPTY_MODEL_LOCK'
  );
});

test('any change to any locked fact changes the digest', () => {
  const baseline = buildEnvironmentLock({ observations: environment() }).digest;
  for (const field of ENVIRONMENT_FIELDS) {
    const changed = environment({
      [field]: typeof environment()[field] === 'number' ? 99 : 'changed'
    });
    assert.notEqual(
      buildEnvironmentLock({ observations: changed }).digest,
      baseline,
      `${field} does not affect the digest`
    );
  }
});

test('verification requires the digest it is checking against', () => {
  const { lock, digest } = buildEnvironmentLock({ observations: environment() });
  assert.deepEqual(
    verifyLock({ lock, expectedDigest: digest }),
    { verified: true, kind: 'environment', digest, findings: [] }
  );

  for (const bad of [undefined, null, '', 'not-a-digest']) {
    assert.throws(
      () => verifyLock({ lock, expectedDigest: bad }),
      (error) => error instanceof LockError && error.code === 'INVALID_DIGEST',
      `accepted ${JSON.stringify(bad)}`
    );
  }

  const tampered = { ...structuredClone(lock), cpuCount: 64 };
  const result = verifyLock({ lock: tampered, expectedDigest: digest });
  assert.equal(result.verified, false);
  assert.deepEqual(result.findings, [{ code: 'LOCK_DIGEST_MISMATCH', kind: 'environment' }]);
});

test('an object that is not a v1.1 lock is refused rather than digested', () => {
  assert.throws(
    () => verifyLock({ lock: { schema: 'something.else' }, expectedDigest: 'a'.repeat(64) }),
    (error) => error instanceof LockError && error.code === 'UNKNOWN_LOCK'
  );
});
