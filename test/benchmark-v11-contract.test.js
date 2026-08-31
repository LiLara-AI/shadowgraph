import { test } from 'node:test';
import { strict as assert } from 'node:assert';

test('UNIT_STATUSES constant exists with all four values', async () => {
  const { UNIT_STATUSES } = await import('../benchmark/lib/v11-contract.mjs');
  assert.ok(Array.isArray(UNIT_STATUSES));
  assert.ok(UNIT_STATUSES.includes('MEASURED'));
  assert.ok(UNIT_STATUSES.includes('FAILED'));
  assert.ok(UNIT_STATUSES.includes('NOT_MEASURED'));
  assert.ok(UNIT_STATUSES.includes('EXCLUDED'));
  assert.equal(UNIT_STATUSES.length, 4);
});

test('ARM_STATUSES constant exists with all five values', async () => {
  const { ARM_STATUSES } = await import('../benchmark/lib/v11-contract.mjs');
  assert.ok(Array.isArray(ARM_STATUSES));
  assert.ok(ARM_STATUSES.includes('MEASURED'));
  assert.ok(ARM_STATUSES.includes('PARTIAL_FAILED'));
  assert.ok(ARM_STATUSES.includes('FAILED'));
  assert.ok(ARM_STATUSES.includes('NOT_MEASURED'));
  assert.ok(ARM_STATUSES.includes('EXCLUDED'));
  assert.equal(ARM_STATUSES.length, 5);
});

test('REQUEST_CLASSES constant exists with three values', async () => {
  const { REQUEST_CLASSES } = await import('../benchmark/lib/v11-contract.mjs');
  assert.ok(Array.isArray(REQUEST_CLASSES));
  assert.ok(REQUEST_CLASSES.includes('outer_decision_llm'));
  assert.ok(REQUEST_CLASSES.includes('internal_memory_llm'));
  assert.ok(REQUEST_CLASSES.includes('embedding'));
  assert.equal(REQUEST_CLASSES.length, 3);
});

test('OPERATION_FIELDS constant exists with required operation counters', async () => {
  const { OPERATION_FIELDS } = await import('../benchmark/lib/v11-contract.mjs');
  assert.ok(Array.isArray(OPERATION_FIELDS));
  assert.ok(OPERATION_FIELDS.includes('memoryReadOperations'));
  assert.ok(OPERATION_FIELDS.includes('memoryWriteOperations'));
  assert.ok(OPERATION_FIELDS.includes('mcpToolCalls'));
  assert.ok(OPERATION_FIELDS.includes('outerDecisionModelCalls'));
  assert.ok(OPERATION_FIELDS.includes('internalMemoryModelCalls'));
  assert.ok(OPERATION_FIELDS.includes('embeddingCalls'));
  assert.ok(OPERATION_FIELDS.includes('persistenceVerificationOperations'));
});

test('deriveArmStatus: all measured units → MEASURED', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  const units = [
    { status: 'MEASURED' },
    { status: 'MEASURED' },
    { status: 'MEASURED' }
  ];
  assert.equal(deriveArmStatus(units), 'MEASURED');
});

test('deriveArmStatus: measured plus failed/unavailable → PARTIAL_FAILED', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');

  const units1 = [
    { status: 'MEASURED' },
    { status: 'FAILED' },
    { status: 'MEASURED' }
  ];
  assert.equal(deriveArmStatus(units1), 'PARTIAL_FAILED');

  const units2 = [
    { status: 'MEASURED' },
    { status: 'NOT_MEASURED' },
    { status: 'MEASURED' }
  ];
  assert.equal(deriveArmStatus(units2), 'PARTIAL_FAILED');
});

test('deriveArmStatus: failed with no measured units → FAILED', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  const units = [
    { status: 'FAILED' },
    { status: 'FAILED' }
  ];
  assert.equal(deriveArmStatus(units), 'FAILED');
});

test('deriveArmStatus: all unavailable → NOT_MEASURED', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  const units = [
    { status: 'NOT_MEASURED' },
    { status: 'NOT_MEASURED' }
  ];
  assert.equal(deriveArmStatus(units), 'NOT_MEASURED');
});

test('deriveArmStatus: explicitly excluded arm → EXCLUDED', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  const units = [{ status: 'MEASURED' }];
  const options = { excluded: true };
  assert.equal(deriveArmStatus(units, options), 'EXCLUDED');
});

test('deriveArmStatus: only boolean true explicitly excludes an arm', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  assert.equal(deriveArmStatus([{ status: 'MEASURED' }], { excluded: 'true' }), 'MEASURED');
  assert.equal(deriveArmStatus([{ status: 'MEASURED' }], { excluded: 1 }), 'MEASURED');
});

test('deriveArmStatus: empty units array → NOT_MEASURED', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  assert.equal(deriveArmStatus([]), 'NOT_MEASURED');
});

test('deriveArmStatus: all EXCLUDED units → EXCLUDED', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  const units = [
    { status: 'EXCLUDED' },
    { status: 'EXCLUDED' }
  ];
  assert.equal(deriveArmStatus(units), 'EXCLUDED');
});

test('deriveArmStatus: MEASURED + EXCLUDED → MEASURED', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  const units = [
    { status: 'MEASURED' },
    { status: 'EXCLUDED' },
    { status: 'MEASURED' }
  ];
  assert.equal(deriveArmStatus(units), 'MEASURED');
});

test('deriveArmStatus: FAILED + EXCLUDED (no MEASURED) → FAILED', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  const units = [
    { status: 'FAILED' },
    { status: 'EXCLUDED' }
  ];
  assert.equal(deriveArmStatus(units), 'FAILED');
});

test('deriveArmStatus: NOT_MEASURED + EXCLUDED → NOT_MEASURED', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  const units = [
    { status: 'NOT_MEASURED' },
    { status: 'EXCLUDED' }
  ];
  assert.equal(deriveArmStatus(units), 'NOT_MEASURED');
});

test('deriveArmStatus: MEASURED + FAILED + EXCLUDED → PARTIAL_FAILED', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  const units = [
    { status: 'MEASURED' },
    { status: 'FAILED' },
    { status: 'EXCLUDED' }
  ];
  assert.equal(deriveArmStatus(units), 'PARTIAL_FAILED');
});

test('deriveArmStatus: rejects non-array units', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  assert.throws(() => deriveArmStatus(null), /must be an array/i);
  assert.throws(() => deriveArmStatus(undefined), /must be an array/i);
  assert.throws(() => deriveArmStatus({ status: 'MEASURED' }), /must be an array/i);
});

test('deriveArmStatus: rejects unknown unit status', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  const units = [{ status: 'success' }]; // lowercase - invalid
  assert.throws(() => deriveArmStatus(units), /unknown.*status/i);
});

test('deriveArmStatus: rejects malformed unit (missing status)', async () => {
  const { deriveArmStatus } = await import('../benchmark/lib/v11-contract.mjs');
  const units = [{ phase: 'A' }]; // no status field
  assert.throws(() => deriveArmStatus(units), /missing.*status/i);
});

test('validateApplicability accepts valid SUPPORTED status', async () => {
  const { validateApplicability } = await import('../benchmark/lib/v11-contract.mjs');
  const applicability = {
    userIsolation: { status: 'SUPPORTED', reason: null },
    persistence: { status: 'SUPPORTED', reason: null }
  };
  assert.doesNotThrow(() => validateApplicability(applicability));
});

test('validateApplicability accepts valid NOT_APPLICABLE status', async () => {
  const { validateApplicability } = await import('../benchmark/lib/v11-contract.mjs');
  const applicability = {
    userIsolation: { status: 'NOT_APPLICABLE', reason: 'no native user namespace' },
    persistence: { status: 'SUPPORTED', reason: null }
  };
  assert.doesNotThrow(() => validateApplicability(applicability));
});

test('validateApplicability rejects invalid status', async () => {
  const { validateApplicability } = await import('../benchmark/lib/v11-contract.mjs');
  const applicability = {
    userIsolation: { status: 'INVALID', reason: null },
    persistence: { status: 'SUPPORTED', reason: null }
  };
  assert.throws(() => validateApplicability(applicability), /invalid.*status/i);
});

test('validateApplicability rejects null input', async () => {
  const { validateApplicability } = await import('../benchmark/lib/v11-contract.mjs');
  assert.throws(() => validateApplicability(null), /applicability.*object/i);
});

test('validateApplicability rejects array input', async () => {
  const { validateApplicability } = await import('../benchmark/lib/v11-contract.mjs');
  assert.throws(() => validateApplicability([]), /applicability.*object/i);
});

test('validateApplicability rejects missing userIsolation', async () => {
  const { validateApplicability } = await import('../benchmark/lib/v11-contract.mjs');
  const applicability = {
    persistence: { status: 'SUPPORTED', reason: null }
  };
  assert.throws(() => validateApplicability(applicability), /userIsolation/i);
});

test('validateApplicability rejects missing persistence', async () => {
  const { validateApplicability } = await import('../benchmark/lib/v11-contract.mjs');
  const applicability = {
    userIsolation: { status: 'SUPPORTED', reason: null }
  };
  assert.throws(() => validateApplicability(applicability), /persistence/i);
});

test('validateApplicability rejects SUPPORTED with non-null reason', async () => {
  const { validateApplicability } = await import('../benchmark/lib/v11-contract.mjs');
  const applicability = {
    userIsolation: { status: 'SUPPORTED', reason: 'should be null' },
    persistence: { status: 'SUPPORTED', reason: null }
  };
  assert.throws(() => validateApplicability(applicability), /SUPPORTED.*null.*reason/i);
});

test('validateApplicability rejects NOT_APPLICABLE with null reason', async () => {
  const { validateApplicability } = await import('../benchmark/lib/v11-contract.mjs');
  const applicability = {
    userIsolation: { status: 'NOT_APPLICABLE', reason: null },
    persistence: { status: 'SUPPORTED', reason: null }
  };
  assert.throws(() => validateApplicability(applicability), /NOT_APPLICABLE.*reason/i);
});

test('validateApplicability rejects NOT_APPLICABLE with empty reason', async () => {
  const { validateApplicability } = await import('../benchmark/lib/v11-contract.mjs');
  const applicability = {
    userIsolation: { status: 'NOT_APPLICABLE', reason: '' },
    persistence: { status: 'SUPPORTED', reason: null }
  };
  assert.throws(() => validateApplicability(applicability), /NOT_APPLICABLE.*non-empty.*reason/i);
});

test('validateApplicability rejects unknown capabilities and record fields', async () => {
  const { validateApplicability } = await import('../benchmark/lib/v11-contract.mjs');
  const base = {
    userIsolation: { status: 'SUPPORTED', reason: null },
    persistence: { status: 'SUPPORTED', reason: null }
  };

  assert.throws(
    () => validateApplicability({ ...base, syntheticNamespace: { status: 'SUPPORTED', reason: null } }),
    /unknown.*capability/i
  );
  assert.throws(
    () => validateApplicability({ ...base, userIsolation: { ...base.userIsolation, guessedByModel: true } }),
    /unknown.*field/i
  );
});

test('validateApplicability rejects malformed records and non-string N/A reasons', async () => {
  const { validateApplicability } = await import('../benchmark/lib/v11-contract.mjs');
  const persistence = { status: 'SUPPORTED', reason: null };

  assert.throws(() => validateApplicability({ userIsolation: [], persistence }), /userIsolation.*object/i);
  assert.throws(
    () => validateApplicability({ userIsolation: { status: 'NOT_APPLICABLE', reason: 7 }, persistence }),
    /NOT_APPLICABLE.*string.*reason/i
  );
});

test('validateOperationMetrics accepts valid non-negative integers', async () => {
  const { validateOperationMetrics } = await import('../benchmark/lib/v11-contract.mjs');
  const metrics = {
    memoryReadOperations: 5,
    memoryWriteOperations: 2,
    mcpToolCalls: 3,
    outerDecisionModelCalls: 1,
    internalMemoryModelCalls: 0,
    embeddingCalls: 4,
    persistenceVerificationOperations: 1
  };
  assert.doesNotThrow(() => validateOperationMetrics(metrics));
});

test('validateOperationMetrics rejects negative values', async () => {
  const { validateOperationMetrics } = await import('../benchmark/lib/v11-contract.mjs');
  const metrics = {
    memoryReadOperations: -1,
    memoryWriteOperations: 2,
    mcpToolCalls: 3,
    outerDecisionModelCalls: 1,
    internalMemoryModelCalls: 0,
    embeddingCalls: 4,
    persistenceVerificationOperations: 1
  };
  assert.throws(() => validateOperationMetrics(metrics), /negative/i);
});

test('validateOperationMetrics rejects legacy generic toolCalls', async () => {
  const { validateOperationMetrics } = await import('../benchmark/lib/v11-contract.mjs');
  const metrics = {
    toolCalls: 10, // legacy field - forbidden
    memoryReadOperations: 5,
    memoryWriteOperations: 2,
    mcpToolCalls: 3
  };
  assert.throws(() => validateOperationMetrics(metrics), /toolCalls.*forbidden/i);
});

test('validateOperationMetrics rejects non-integer values', async () => {
  const { validateOperationMetrics } = await import('../benchmark/lib/v11-contract.mjs');
  const metrics = {
    memoryReadOperations: 5.5,
    memoryWriteOperations: 2,
    mcpToolCalls: 3,
    outerDecisionModelCalls: 1,
    internalMemoryModelCalls: 0,
    embeddingCalls: 4,
    persistenceVerificationOperations: 1
  };
  assert.throws(() => validateOperationMetrics(metrics), /integer/i);
});

test('validateOperationMetrics rejects integers outside the exact safe range', async () => {
  const { validateOperationMetrics } = await import('../benchmark/lib/v11-contract.mjs');
  const metrics = {
    memoryReadOperations: Number.MAX_SAFE_INTEGER + 1,
    memoryWriteOperations: 2,
    mcpToolCalls: 3,
    outerDecisionModelCalls: 1,
    internalMemoryModelCalls: 0,
    embeddingCalls: 4,
    persistenceVerificationOperations: 1
  };
  assert.throws(() => validateOperationMetrics(metrics), /safe integer/i);
});

test('validateOperationMetrics rejects missing required field', async () => {
  const { validateOperationMetrics } = await import('../benchmark/lib/v11-contract.mjs');
  const metrics = {
    memoryReadOperations: 5,
    memoryWriteOperations: 2,
    mcpToolCalls: 3,
    outerDecisionModelCalls: 1,
    internalMemoryModelCalls: 0,
    embeddingCalls: 4
    // missing persistenceVerificationOperations
  };
  assert.throws(() => validateOperationMetrics(metrics), /persistenceVerificationOperations/i);
});

test('validateOperationMetrics rejects unknown extra field', async () => {
  const { validateOperationMetrics } = await import('../benchmark/lib/v11-contract.mjs');
  const metrics = {
    memoryReadOperations: 5,
    memoryWriteOperations: 2,
    mcpToolCalls: 3,
    outerDecisionModelCalls: 1,
    internalMemoryModelCalls: 0,
    embeddingCalls: 4,
    persistenceVerificationOperations: 1,
    unknownField: 99
  };
  assert.throws(() => validateOperationMetrics(metrics), /unknown.*field/i);
});

test('validateOperationMetrics rejects null and non-object inputs', async () => {
  const { validateOperationMetrics } = await import('../benchmark/lib/v11-contract.mjs');
  assert.throws(() => validateOperationMetrics(null), /metrics.*object/i);
  assert.throws(() => validateOperationMetrics([]), /metrics.*object/i);
});

test('validateStorageMeasurement accepts MEASURED with bytes', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  const storage = {
    status: 'MEASURED',
    bytes: 1024,
    scope: 'isolated project directory',
    method: 'du -sb',
    reason: null,
    blockedClaims: []
  };
  assert.doesNotThrow(() => validateStorageMeasurement(storage));
});

test('validateStorageMeasurement accepts NOT_AVAILABLE with null bytes and reason', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  const storage = {
    status: 'NOT_AVAILABLE',
    bytes: null,
    scope: 'Neo4j database',
    method: null,
    reason: 'cannot query Neo4j bytes without custom instrumentation',
    blockedClaims: ['storage efficiency']
  };
  assert.doesNotThrow(() => validateStorageMeasurement(storage));
});

test('validateStorageMeasurement rejects MEASURED with null bytes', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  const storage = {
    status: 'MEASURED',
    bytes: null,
    scope: 'directory',
    method: 'du',
    reason: null,
    blockedClaims: []
  };
  assert.throws(() => validateStorageMeasurement(storage), /bytes.*required/i);
});

test('validateStorageMeasurement rejects byte counts outside the exact safe range', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  const storage = {
    status: 'MEASURED',
    bytes: Number.MAX_SAFE_INTEGER + 1,
    scope: 'directory',
    method: 'du',
    reason: null,
    blockedClaims: []
  };
  assert.throws(() => validateStorageMeasurement(storage), /safe integer/i);
});

test('validateStorageMeasurement rejects MEASURED with missing scope', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  const storage = {
    status: 'MEASURED',
    bytes: 1024,
    method: 'du -sb',
    reason: null,
    blockedClaims: []
  };
  assert.throws(() => validateStorageMeasurement(storage), /scope/i);
});

test('validateStorageMeasurement rejects MEASURED with missing method', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  const storage = {
    status: 'MEASURED',
    bytes: 1024,
    scope: 'project directory',
    reason: null,
    blockedClaims: []
  };
  assert.throws(() => validateStorageMeasurement(storage), /method/i);
});

test('validateStorageMeasurement rejects NOT_AVAILABLE with non-null bytes', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  const storage = {
    status: 'NOT_AVAILABLE',
    bytes: 0,
    scope: 'Neo4j',
    method: null,
    reason: 'cannot measure',
    blockedClaims: ['storage']
  };
  assert.throws(() => validateStorageMeasurement(storage), /NOT_AVAILABLE.*null.*bytes/i);
});

test('validateStorageMeasurement rejects NOT_AVAILABLE with missing scope', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  const storage = {
    status: 'NOT_AVAILABLE',
    bytes: null,
    method: null,
    reason: 'cannot measure',
    blockedClaims: ['storage']
  };
  assert.throws(() => validateStorageMeasurement(storage), /scope/i);
});

test('validateStorageMeasurement rejects NOT_AVAILABLE with missing reason', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  const storage = {
    status: 'NOT_AVAILABLE',
    bytes: null,
    scope: 'Neo4j',
    method: null,
    blockedClaims: ['storage']
  };
  assert.throws(() => validateStorageMeasurement(storage), /reason/i);
});

test('validateStorageMeasurement rejects NOT_AVAILABLE with empty blockedClaims', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  const storage = {
    status: 'NOT_AVAILABLE',
    bytes: null,
    scope: 'Neo4j',
    method: null,
    reason: 'cannot measure',
    blockedClaims: []
  };
  assert.throws(() => validateStorageMeasurement(storage), /blockedClaims/i);
});

test('validateStorageMeasurement rejects missing required field', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  const storage = {
    status: 'MEASURED',
    bytes: 1024,
    scope: 'directory'
    // missing method, reason, blockedClaims
  };
  assert.throws(() => validateStorageMeasurement(storage), /required.*field/i);
});

test('validateStorageMeasurement rejects null, arrays, and unknown fields', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  assert.throws(() => validateStorageMeasurement(null), /storage.*object/i);
  assert.throws(() => validateStorageMeasurement([]), /storage.*object/i);
  assert.throws(
    () => validateStorageMeasurement({
      status: 'MEASURED', bytes: 1, scope: 'directory', method: 'du', reason: null, blockedClaims: [], estimate: true
    }),
    /unknown.*storage.*field/i
  );
});

test('validateStorageMeasurement requires typed descriptive fields', async () => {
  const { validateStorageMeasurement } = await import('../benchmark/lib/v11-contract.mjs');
  const measured = { status: 'MEASURED', bytes: 1, scope: 'directory', method: 'du', reason: null, blockedClaims: [] };
  const unavailable = {
    status: 'NOT_AVAILABLE', bytes: null, scope: 'Neo4j database', method: null,
    reason: 'no attributable byte scope', blockedClaims: ['storage efficiency']
  };

  assert.throws(() => validateStorageMeasurement({ ...measured, scope: 7 }), /scope.*string/i);
  assert.throws(() => validateStorageMeasurement({ ...measured, method: true }), /method.*string/i);
  assert.throws(() => validateStorageMeasurement({ ...unavailable, reason: 7 }), /reason.*string/i);
  assert.throws(() => validateStorageMeasurement({ ...unavailable, method: 7 }), /method.*string/i);
  assert.throws(() => validateStorageMeasurement({ ...unavailable, blockedClaims: ['storage', 7] }), /blockedClaims/i);
});

test('validateAdapterEnvelope accepts valid common envelope', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  const envelope = {
    phase: 'A',
    armId: 'shadowgraph-full',
    scenarioId: 'S01',
    repetition: 0,
    status: 'MEASURED',
    operations: {
      memoryReadOperations: 0,
      memoryWriteOperations: 1,
      mcpToolCalls: 2,
      outerDecisionModelCalls: 0,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 1
    },
    applicability: {
      userIsolation: { status: 'SUPPORTED', reason: null },
      persistence: { status: 'SUPPORTED', reason: null }
    },
    storage: {
      status: 'MEASURED',
      bytes: 512,
      scope: 'project directory',
      method: 'du -sb',
      reason: null,
      blockedClaims: []
    }
  };
  assert.doesNotThrow(() => validateAdapterEnvelope(envelope));
});

test('validateAdapterEnvelope rejects envelope with invalid operations', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  const envelope = {
    phase: 'A',
    armId: 'test',
    scenarioId: 'S01',
    repetition: 0,
    status: 'MEASURED',
    operations: {
      toolCalls: 5 // forbidden legacy field
    },
    applicability: {
      userIsolation: { status: 'SUPPORTED', reason: null },
      persistence: { status: 'SUPPORTED', reason: null }
    },
    storage: {
      status: 'MEASURED',
      bytes: 512,
      scope: 'dir',
      method: 'du',
      reason: null,
      blockedClaims: []
    }
  };
  assert.throws(() => validateAdapterEnvelope(envelope), /toolCalls.*forbidden/i);
});

test('validateAdapterEnvelope always validates applicability and storage', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  const envelope = {
    phase: 'A',
    armId: 'test',
    scenarioId: 'S01',
    repetition: 0,
    status: 'MEASURED',
    operations: {
      memoryReadOperations: 0,
      memoryWriteOperations: 1,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 0,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 1
    },
    applicability: {
      userIsolation: { status: 'SUPPORTED', reason: null },
      persistence: { status: 'SUPPORTED', reason: null }
    },
    storage: {
      status: 'MEASURED', bytes: 512, scope: 'directory', method: 'du', reason: null, blockedClaims: []
    }
  };

  assert.throws(
    () => validateAdapterEnvelope({ ...envelope, applicability: { ...envelope.applicability, persistence: { status: 'NOT_APPLICABLE', reason: null } } }),
    /NOT_APPLICABLE.*reason/i
  );
  assert.throws(
    () => validateAdapterEnvelope({ ...envelope, storage: { ...envelope.storage, bytes: null } }),
    /bytes.*required/i
  );
});

test('validateAdapterEnvelope rejects unknown top-level fields', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  const envelope = {
    phase: 'A',
    armId: 'test',
    scenarioId: 'S01',
    repetition: 0,
    status: 'MEASURED',
    operations: {
      memoryReadOperations: 0,
      memoryWriteOperations: 1,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 0,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 1
    },
    applicability: {
      userIsolation: { status: 'SUPPORTED', reason: null },
      persistence: { status: 'SUPPORTED', reason: null }
    },
    storage: {
      status: 'MEASURED', bytes: 1, scope: 'directory', method: 'du', reason: null, blockedClaims: []
    },
    modelOutput: { choiceId: 'fixture-choice' }
  };
  assert.throws(() => validateAdapterEnvelope(envelope), /unknown.*envelope.*field/i);
});

test('validateAdapterEnvelope requires adapter outer-model calls to stay zero', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  const envelope = {
    phase: 'A',
    armId: 'test',
    scenarioId: 'S01',
    repetition: 0,
    status: 'MEASURED',
    operations: {
      memoryReadOperations: 0,
      memoryWriteOperations: 1,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 1,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 1
    },
    applicability: {
      userIsolation: { status: 'SUPPORTED', reason: null },
      persistence: { status: 'SUPPORTED', reason: null }
    },
    storage: {
      status: 'MEASURED', bytes: 1, scope: 'directory', method: 'du', reason: null, blockedClaims: []
    }
  };
  assert.throws(() => validateAdapterEnvelope(envelope), /outerDecisionModelCalls.*zero/i);
});

test('validateAdapterEnvelope rejects null input', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  assert.throws(() => validateAdapterEnvelope(null), /envelope.*null/i);
});

test('validateAdapterEnvelope rejects non-object input', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  assert.throws(() => validateAdapterEnvelope('string'), /envelope.*object/i);
});

test('validateAdapterEnvelope rejects missing operations', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  const envelope = {
    phase: 'A',
    armId: 'test',
    scenarioId: 'S01',
    repetition: 0,
    status: 'MEASURED',
    applicability: {
      userIsolation: { status: 'SUPPORTED', reason: null },
      persistence: { status: 'SUPPORTED', reason: null }
    },
    storage: {
      status: 'MEASURED',
      bytes: 512,
      scope: 'dir',
      method: 'du',
      reason: null,
      blockedClaims: []
    }
  };
  assert.throws(() => validateAdapterEnvelope(envelope), /operations/i);
});

test('validateAdapterEnvelope rejects missing applicability', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  const envelope = {
    phase: 'A',
    armId: 'test',
    scenarioId: 'S01',
    repetition: 0,
    status: 'MEASURED',
    operations: {
      memoryReadOperations: 0,
      memoryWriteOperations: 1,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 1,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 1
    },
    storage: {
      status: 'MEASURED',
      bytes: 512,
      scope: 'dir',
      method: 'du',
      reason: null,
      blockedClaims: []
    }
  };
  assert.throws(() => validateAdapterEnvelope(envelope), /applicability/i);
});

test('validateAdapterEnvelope rejects missing storage', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  const envelope = {
    phase: 'A',
    armId: 'test',
    scenarioId: 'S01',
    repetition: 0,
    status: 'MEASURED',
    operations: {
      memoryReadOperations: 0,
      memoryWriteOperations: 1,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 1,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 1
    },
    applicability: {
      userIsolation: { status: 'SUPPORTED', reason: null },
      persistence: { status: 'SUPPORTED', reason: null }
    }
  };
  assert.throws(() => validateAdapterEnvelope(envelope), /storage/i);
});

test('validateAdapterEnvelope rejects invalid unit status (lowercase)', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  const envelope = {
    phase: 'A',
    armId: 'test',
    scenarioId: 'S01',
    repetition: 0,
    status: 'success', // invalid lowercase
    operations: {
      memoryReadOperations: 0,
      memoryWriteOperations: 1,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 1,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 1
    },
    applicability: {
      userIsolation: { status: 'SUPPORTED', reason: null },
      persistence: { status: 'SUPPORTED', reason: null }
    },
    storage: {
      status: 'MEASURED',
      bytes: 512,
      scope: 'dir',
      method: 'du',
      reason: null,
      blockedClaims: []
    }
  };
  assert.throws(() => validateAdapterEnvelope(envelope), /invalid.*status|status.*invalid/i);
});

test('validateAdapterEnvelope rejects missing phase', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  const envelope = {
    armId: 'test',
    scenarioId: 'S01',
    repetition: 0,
    status: 'MEASURED',
    operations: {
      memoryReadOperations: 0,
      memoryWriteOperations: 1,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 1,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 1
    },
    applicability: {
      userIsolation: { status: 'SUPPORTED', reason: null },
      persistence: { status: 'SUPPORTED', reason: null }
    },
    storage: {
      status: 'MEASURED',
      bytes: 512,
      scope: 'dir',
      method: 'du',
      reason: null,
      blockedClaims: []
    }
  };
  assert.throws(() => validateAdapterEnvelope(envelope), /phase/i);
});

test('validateAdapterEnvelope rejects invalid repetition', async () => {
  const { validateAdapterEnvelope } = await import('../benchmark/lib/v11-contract.mjs');
  const envelope = {
    phase: 'A',
    armId: 'test',
    scenarioId: 'S01',
    repetition: -1,
    status: 'MEASURED',
    operations: {
      memoryReadOperations: 0,
      memoryWriteOperations: 1,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 1,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 1
    },
    applicability: {
      userIsolation: { status: 'SUPPORTED', reason: null },
      persistence: { status: 'SUPPORTED', reason: null }
    },
    storage: {
      status: 'MEASURED',
      bytes: 512,
      scope: 'dir',
      method: 'du',
      reason: null,
      blockedClaims: []
    }
  };
  assert.throws(() => validateAdapterEnvelope(envelope), /repetition.*non-negative/i);
});
