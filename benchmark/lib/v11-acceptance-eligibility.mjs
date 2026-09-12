import { createHash } from 'node:crypto';

import { validateV11ProviderReconciliationGate } from './aggregate.mjs';
import { canonicalJson } from './v11-contract.mjs';
import { validateRawRun } from './validate.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const FIELDS = Object.freeze([
  'schema', 'version', 'status', 'runId', 'attemptId',
  'implementationLockHash', 'amendment009Sha256', 'rawSha256',
  'providerReconciliationSha256', 'counts', 'issuedAt'
]);
const COUNT_FIELDS = Object.freeze(['totalUnits', 'applicableUnits', 'excludedUnits', 'failedUnits']);
const TRUSTED_ELIGIBILITY = new WeakSet();

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, fields, context) {
  if (!isPlainRecord(value)) throw new Error(`${context} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${context} fields do not match the frozen schema`);
  }
}

function hashCanonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function cleanAcceptanceCounts(raw) {
  return {
    totalUnits: raw.units.length,
    applicableUnits: raw.units.filter(({ status }) => status === 'MEASURED').length,
    excludedUnits: raw.units.filter(({ status }) => status === 'EXCLUDED').length,
    failedUnits: raw.units.filter(({ status }) => !['MEASURED', 'EXCLUDED'].includes(status)).length
  };
}

function validateEligibilityShape(evidence, expected) {
  assertExactKeys(expected, ['implementationLockHash', 'amendment009Sha256'], 'acceptance eligibility expectation');
  assertExactKeys(evidence, FIELDS, 'acceptance eligibility');
  assertExactKeys(evidence.counts, COUNT_FIELDS, 'acceptance eligibility counts');
  if (evidence.schema !== 'shadowgraph.v11.acceptance-eligibility'
    || evidence.version !== 1
    || evidence.status !== 'ELIGIBLE_FOR_SCORED'
    || typeof evidence.runId !== 'string' || evidence.runId.length === 0
    || typeof evidence.attemptId !== 'string' || evidence.attemptId.length === 0
    || evidence.implementationLockHash !== expected.implementationLockHash
    || evidence.amendment009Sha256 !== expected.amendment009Sha256
    || !HASH.test(evidence.rawSha256)
    || !HASH.test(evidence.providerReconciliationSha256)
    || evidence.counts.totalUnits !== 308
    || evidence.counts.applicableUnits !== 288
    || evidence.counts.excludedUnits !== 20
    || evidence.counts.failedUnits !== 0
    || !Number.isFinite(Date.parse(evidence.issuedAt))) {
    throw new Error('Acceptance eligibility does not match the exact clean final-acceptance contract');
  }
  return true;
}

export function validateV11AcceptanceEligibility(evidence, expected) {
  validateEligibilityShape(evidence, expected);
  if (!TRUSTED_ELIGIBILITY.has(evidence)) {
    throw new Error('Acceptance eligibility must be issued or artifact-verified by this module');
  }
  return Object.freeze({ evidence, sha256: hashCanonical(evidence) });
}

export function issueV11AcceptanceEligibility({ raw, providerReconciliation, definition, sourceHashes }) {
  const validation = validateRawRun(
    raw,
    { ...definition, scenarios: definition.scenarios },
    sourceHashes.preregistrationSha256,
    sourceHashes
  );
  if (!isPlainRecord(raw)
    || raw.mode !== 'ACCEPTANCE'
    || raw.status !== 'COMPLETE'
    || typeof raw.amendment009Sha256 !== 'string'
    || validation?.valid !== true) {
    throw new Error('Only a complete validated Amendment-009 acceptance can issue eligibility');
  }
  validateV11ProviderReconciliationGate(raw, providerReconciliation);
  const counts = cleanAcceptanceCounts(raw);
  if (counts.totalUnits !== 308
    || counts.applicableUnits !== 288
    || counts.excludedUnits !== 20
    || counts.failedUnits !== 0) {
    throw new Error('Final acceptance is not clean and cannot authorize scoring');
  }
  const evidence = {
    schema: 'shadowgraph.v11.acceptance-eligibility',
    version: 1,
    status: 'ELIGIBLE_FOR_SCORED',
    runId: raw.runId,
    attemptId: raw.attemptId,
    implementationLockHash: raw.implementationLockHash,
    amendment009Sha256: raw.amendment009Sha256,
    rawSha256: hashCanonical(raw),
    providerReconciliationSha256: hashCanonical(providerReconciliation),
    counts,
    issuedAt: raw.finishedAt
  };
  validateEligibilityShape(evidence, {
    implementationLockHash: raw.implementationLockHash,
    amendment009Sha256: raw.amendment009Sha256
  });
  const trustedEvidence = Object.freeze(structuredClone(evidence));
  TRUSTED_ELIGIBILITY.add(trustedEvidence);
  return trustedEvidence;
}

export function verifyV11AcceptanceEligibilityArtifacts({
  evidence,
  raw,
  providerReconciliation,
  definition,
  sourceHashes
}) {
  const expected = issueV11AcceptanceEligibility({ raw, providerReconciliation, definition, sourceHashes });
  if (canonicalJson(expected) !== canonicalJson(evidence)) {
    throw new Error('Acceptance eligibility does not match the supplied raw and reconciliation artifacts');
  }
  validateEligibilityShape(evidence, {
    implementationLockHash: raw.implementationLockHash,
    amendment009Sha256: raw.amendment009Sha256
  });
  const trustedEvidence = Object.freeze(structuredClone(evidence));
  TRUSTED_ELIGIBILITY.add(trustedEvidence);
  return validateV11AcceptanceEligibility(trustedEvidence, {
    implementationLockHash: raw.implementationLockHash,
    amendment009Sha256: raw.amendment009Sha256
  });
}
