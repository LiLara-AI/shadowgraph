const HASH = /^[a-f0-9]{64}$/u;
const PROGRAM_LINEAGE_ID = 'shadowgraph-v11-final-program';
const ABSOLUTE_DEADLINE = Date.parse('2026-09-25T23:37:31.000Z');
const CLASS_LIMITS = Object.freeze({
  outer_decision_llm: 2730,
  internal_memory_llm: 2738,
  embedding: 10801
});
const SESSION_LIMITS = Object.freeze({ probe: 12, acceptance: 3, scored: 1 });

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateV11FinalProgramPolicy(policy, expectedImplementationLockHash) {
  const deadline = Date.parse(policy?.deadline);
  const hasContinuation = isRecord(policy?.continuation);
  const lineageId = hasContinuation ? policy?.campaignLineageId : policy?.campaignId;
  const finalShape = isRecord(policy)
    && isRecord(policy.limits)
    && isRecord(policy.sessionLimits)
    && Object.keys(policy.sessionLimits).length === 3
    && Object.keys(SESSION_LIMITS).every((kind) => Number.isInteger(policy.sessionLimits[kind])
      && policy.sessionLimits[kind] >= 0
      && policy.sessionLimits[kind] <= SESSION_LIMITS[kind])
    && Object.values(policy.sessionLimits).reduce((sum, value) => sum + value, 0) === policy.maxSessions
    && policy.maxSessions <= 16
    && policy.maxRecoveryAttempts === 0
    && Number.isInteger(policy.maxRequests) && policy.maxRequests >= 1 && policy.maxRequests <= 16269
    && Object.entries(CLASS_LIMITS).every(([requestClass, ceiling]) => (
      Number.isInteger(policy.limits[requestClass])
      && policy.limits[requestClass] >= 0
      && policy.limits[requestClass] <= ceiling
    ))
    && Object.values(policy.limits).reduce((sum, value) => sum + value, 0) === policy.maxRequests
    && Number.isFinite(deadline) && deadline <= ABSOLUTE_DEADLINE
    && HASH.test(expectedImplementationLockHash)
    && policy.implementationLockHash === expectedImplementationLockHash
    && lineageId === PROGRAM_LINEAGE_ID
    && (hasContinuation
      ? true
      : typeof policy.campaignRegistryPath === 'string'
        && typeof policy.continuityRegistryPath === 'string');
  if (!finalShape) {
    const error = new Error('Campaign policy exceeds or does not bind the Amendment 009 cumulative program envelope');
    error.code = 'PROGRAM_BUDGET_MISMATCH';
    throw error;
  }
  return structuredClone(policy);
}

export const V11_FINAL_PROGRAM_CEILINGS = Object.freeze({
  absoluteDeadline: new Date(ABSOLUTE_DEADLINE).toISOString(),
  maxSessions: 16,
  sessionLimits: structuredClone(SESSION_LIMITS),
  classLimits: structuredClone(CLASS_LIMITS),
  maxRequests: 16269,
  maxRecoveryAttempts: 0
});
