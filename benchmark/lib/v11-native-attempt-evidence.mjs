import { createHash } from 'node:crypto';

import { TextDecoder } from 'node:util';

import { validateNativeAttemptPolicy } from './v11-native-attempts.mjs';

export const NATIVE_ATTEMPT_EVIDENCE_SCHEMA = 'shadowgraph.v11.native-attempt-evidence';
export const NATIVE_ATTEMPT_EVIDENCE_VERSION = 1;
export const NATIVE_ATTEMPT_EVIDENCE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const NATIVE_ATTEMPT_EVIDENCE_NOTE =
  'fresh loopback fault evidence is checked against the frozen Amendment 006 policy, package pins, and model pins; live meter reconciliation remains required for every run';

const RECOVERY_CATEGORIES = Object.freeze(['B', 'C', 'D']);
const TAXONOMY_KEYS = Object.freeze(['A', 'B', 'C', 'D', 'E']);
const SHA256 = /^[a-f0-9]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const SAFE_PROBE_REPORT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NATIVE_ATTEMPT_REPORT_SCHEMA = 'shadowgraph.v11.native-attempt-loopback-report';
const NATIVE_ATTEMPT_REPORT_VERSION = 1;
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
const REPORT_FIELDS = Object.freeze([
  'schema', 'version', 'observedAt', 'amendment006Sha256',
  'armId', 'requestClass', 'category', 'package', 'modelId', 'network',
  'rootOperationInvocations', 'wireAttempts', 'taxonomy', 'allAttemptsMetered',
  'providerUsageAccounting', 'modelEndpointPinned', 'harnessOperationReruns'
]);
const PACKAGE_FIELDS = Object.freeze(['name', 'version']);
const WIRE_ATTEMPT_FIELDS = Object.freeze([
  'ordinal', 'path', 'outcome', 'modelId', 'retryOrdinal', 'responseFormat'
]);

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function exactKeys(value, fields) {
  return isPlainRecord(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function recoveryKey(armId, requestClass, category) {
  return `${armId}\u001f${requestClass}\u001f${category}`;
}

function instantOf(value) {
  if (!isNonEmptyString(value) || !ISO_INSTANT.test(value)) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function empty(findings) {
  return Object.freeze({
    satisfiedRecoveries: new Set(),
    findings: Object.freeze(findings),
    note: NATIVE_ATTEMPT_EVIDENCE_NOTE
  });
}

function expectedRecoveries(policy) {
  const expected = new Map();
  for (const [armId, recovery] of policy.policies) {
    for (const [requestClass, categories] of Object.entries(recovery)) {
      for (const category of categories) {
        expected.set(recoveryKey(armId, requestClass, category), { armId, requestClass, category });
      }
    }
  }
  return expected;
}

function probeReportBytes(probeReports, name) {
  if (probeReports instanceof Map) return probeReports.get(name) ?? null;
  if (isPlainRecord(probeReports) && Object.hasOwn(probeReports, name)) return probeReports[name];
  return null;
}

function expectedWirePath(requestClass) {
  if (requestClass === 'embedding') return '/v1/embeddings';
  return '/v1/chat/completions';
}

function parseProbeReport(bytes) {
  try {
    const report = JSON.parse(UTF8_FATAL.decode(Buffer.from(bytes)));
    return isPlainRecord(report) ? report : null;
  } catch {
    return null;
  }
}

function validateProbeReport(report, entry, input) {
  if (!exactKeys(report, REPORT_FIELDS)
    || !exactKeys(report.package, PACKAGE_FIELDS)
    || report.schema !== NATIVE_ATTEMPT_REPORT_SCHEMA
    || report.version !== NATIVE_ATTEMPT_REPORT_VERSION) {
    return 'NATIVE_PROBE_REPORT_MALFORMED';
  }
  const reportInstant = instantOf(report.observedAt);
  if (reportInstant === null || reportInstant > input.evidenceObservedAt
    || input.evidenceObservedAt - reportInstant > NATIVE_ATTEMPT_EVIDENCE_MAX_AGE_MS) {
    return 'NATIVE_PROBE_REPORT_IDENTITY_MISMATCH';
  }
  if (report.amendment006Sha256 !== input.amendment006Sha256
    || report.armId !== entry.armId
    || report.requestClass !== entry.requestClass
    || report.category !== entry.category
    || report.package?.name !== entry.package.name
    || report.package?.version !== entry.package.version
    || report.modelId !== entry.modelId
    || report.network !== entry.network
    || report.rootOperationInvocations !== 1
    || report.allAttemptsMetered !== true
    || report.providerUsageAccounting !== 'metered-complete-or-fail-closed'
    || report.modelEndpointPinned !== true
    || report.harnessOperationReruns !== 0
    || !exactKeys(report.taxonomy, TAXONOMY_KEYS)
    || TAXONOMY_KEYS.some((key) => report.taxonomy[key] !== entry.taxonomy[key])) {
    return 'NATIVE_PROBE_REPORT_IDENTITY_MISMATCH';
  }
  if (!Array.isArray(report.wireAttempts) || report.wireAttempts.length !== entry.wireRequests) {
    return 'NATIVE_PROBE_REPORT_WIRE_MISMATCH';
  }
  for (let index = 0; index < report.wireAttempts.length; index += 1) {
    const attempt = report.wireAttempts[index];
    if (!exactKeys(attempt, WIRE_ATTEMPT_FIELDS)
      || attempt.ordinal !== index + 1
      || attempt.path !== expectedWirePath(entry.requestClass)
      || attempt.modelId !== entry.modelId
      || !['SUCCEEDED', 'FAILED'].includes(attempt.outcome)
      || !Number.isSafeInteger(attempt.retryOrdinal) || attempt.retryOrdinal < 0
      || ![null, 'json_object', 'json_schema', 'other'].includes(attempt.responseFormat)) {
      return 'NATIVE_PROBE_REPORT_WIRE_MISMATCH';
    }
  }
  if (entry.category === 'B' && !report.wireAttempts.some((attempt) => attempt.outcome === 'FAILED')) {
    return 'NATIVE_PROBE_REPORT_WIRE_MISMATCH';
  }
  if (entry.category === 'C' && !report.wireAttempts.every((attempt) => attempt.outcome === 'SUCCEEDED')) {
    return 'NATIVE_PROBE_REPORT_WIRE_MISMATCH';
  }
  if (entry.category === 'D' && new Set(report.wireAttempts.map((attempt) => attempt.responseFormat)).size < 2) {
    return 'NATIVE_PROBE_REPORT_WIRE_MISMATCH';
  }
  return null;
}

function validateEntry(entry, expected, input, policy) {
  const fields = [
    'armId', 'requestClass', 'category', 'package', 'modelId', 'outcome',
    'network', 'wireRequests', 'allAttemptsMetered', 'providerUsageAccounting',
    'modelEndpointPinned', 'harnessOperationReruns', 'taxonomy', 'probeReport', 'probeSha256'
  ];
  if (!exactKeys(entry, fields) || !exactKeys(entry.package, PACKAGE_FIELDS)) {
    return 'NATIVE_ATTEMPT_EVIDENCE_ENTRY_MALFORMED';
  }
  if (entry.armId !== expected.armId || entry.requestClass !== expected.requestClass || entry.category !== expected.category) {
    return 'NATIVE_ATTEMPT_EVIDENCE_ENTRY_MISMATCH';
  }
  const pinnedPackage = input.pinnedPackages?.[entry.armId];
  if (!isPlainRecord(pinnedPackage)
    || entry.package?.name !== pinnedPackage.name
    || entry.package?.version !== pinnedPackage.version) {
    return 'NATIVE_ATTEMPT_PACKAGE_MISMATCH';
  }
  const pinnedModel = input.pinnedModels?.[entry.requestClass]?.modelId;
  if (!isNonEmptyString(pinnedModel) || entry.modelId !== pinnedModel) {
    return 'NATIVE_ATTEMPT_MODEL_MISMATCH';
  }
  if (entry.outcome !== 'PASS' || entry.network !== 'loopback-only'
    || !Number.isSafeInteger(entry.wireRequests) || entry.wireRequests < 2
    || entry.wireRequests > policy.maxAttemptsPerRootRequestClass
    || entry.allAttemptsMetered !== true
    || entry.providerUsageAccounting !== 'metered-complete-or-fail-closed'
    || entry.modelEndpointPinned !== true
    || entry.harnessOperationReruns !== 0
    || !isNonEmptyString(entry.probeSha256) || !SHA256.test(entry.probeSha256)) {
    return 'NATIVE_ATTEMPT_PROBE_CONTRACT_FAILED';
  }
  if (!exactKeys(entry.taxonomy, TAXONOMY_KEYS)
    || TAXONOMY_KEYS.some((key) => typeof entry.taxonomy[key] !== 'boolean')
    || entry.taxonomy.A !== false
    || entry.taxonomy.E !== false
    || entry.taxonomy[entry.category] !== true
    || RECOVERY_CATEGORIES.some((category) => category !== entry.category && entry.taxonomy[category] !== false)) {
    return 'NATIVE_ATTEMPT_TAXONOMY_MISMATCH';
  }
  if (!isNonEmptyString(entry.probeReport) || !SAFE_PROBE_REPORT.test(entry.probeReport)
    || entry.probeReport.includes('..')) {
    return 'NATIVE_PROBE_REPORT_INVALID';
  }
  const report = probeReportBytes(input.probeReports, entry.probeReport);
  if (!(typeof report === 'string' || report instanceof Uint8Array)) {
    return 'NATIVE_PROBE_REPORT_MISSING';
  }
  if (createHash('sha256').update(report).digest('hex') !== entry.probeSha256) {
    return 'NATIVE_PROBE_REPORT_HASH_MISMATCH';
  }
  const parsedReport = parseProbeReport(report);
  if (parsedReport === null) return 'NATIVE_PROBE_REPORT_MALFORMED';
  return validateProbeReport(parsedReport, entry, input);
}

/**
 * Validate generic, prospective proof for every policy-permitted native B/C/D
 * recovery. The evidence is intentionally external to the checkout and fresh;
 * its role is to prove the selected runtime's behavior before a live run, while
 * the meter-owned trace proves what actually happens during that run.
 */
export function verifyNativeAttemptEvidence(input) {
  const { evidence, policy, amendment006Sha256, pinnedPackages, pinnedModels, probeReports = null, now } = input ?? {};
  let normalizedPolicy;
  try {
    normalizedPolicy = validateNativeAttemptPolicy(policy);
  } catch {
    return empty([{ code: 'NATIVE_ATTEMPT_POLICY_INVALID' }]);
  }
  if (!isNonEmptyString(amendment006Sha256) || !SHA256.test(amendment006Sha256)
    || !isPlainRecord(pinnedPackages) || !isPlainRecord(pinnedModels) || !Number.isFinite(now)) {
    return empty([{ code: 'NATIVE_ATTEMPT_EVIDENCE_CONTEXT_INVALID' }]);
  }
  const expected = expectedRecoveries(normalizedPolicy);
  if (expected.size === 0) return Object.freeze({
    satisfiedRecoveries: new Set(),
    findings: Object.freeze([]),
    note: NATIVE_ATTEMPT_EVIDENCE_NOTE
  });
  if (!exactKeys(evidence, ['schema', 'version', 'observedAt', 'amendment006Sha256', 'entries'])
    || evidence.schema !== NATIVE_ATTEMPT_EVIDENCE_SCHEMA
    || evidence.version !== NATIVE_ATTEMPT_EVIDENCE_VERSION
    || !Array.isArray(evidence.entries)) {
    return empty([{ code: 'NATIVE_ATTEMPT_EVIDENCE_MALFORMED' }]);
  }
  const observedAt = instantOf(evidence.observedAt);
  if (observedAt === null) return empty([{ code: 'NATIVE_ATTEMPT_EVIDENCE_MALFORMED' }]);
  if (observedAt > now) return empty([{ code: 'NATIVE_ATTEMPT_EVIDENCE_FUTURE_DATED' }]);
  if (now - observedAt >= NATIVE_ATTEMPT_EVIDENCE_MAX_AGE_MS) {
    return empty([{ code: 'NATIVE_ATTEMPT_EVIDENCE_STALE', maxAgeMs: NATIVE_ATTEMPT_EVIDENCE_MAX_AGE_MS }]);
  }
  if (evidence.amendment006Sha256 !== amendment006Sha256) {
    return empty([{ code: 'NATIVE_ATTEMPT_METHODOLOGY_MISMATCH' }]);
  }

  const findings = [];
  const seen = new Set();
  for (const entry of evidence.entries) {
    const key = isPlainRecord(entry)
      ? recoveryKey(entry.armId, entry.requestClass, entry.category)
      : null;
    if (key === null || !expected.has(key)) {
      findings.push({ code: 'NATIVE_ATTEMPT_EVIDENCE_UNEXPECTED_ENTRY' });
      continue;
    }
    if (seen.has(key)) {
      findings.push({ code: 'NATIVE_ATTEMPT_EVIDENCE_DUPLICATE_ENTRY', ...expected.get(key) });
      continue;
    }
    seen.add(key);
    const code = validateEntry(entry, expected.get(key), {
      pinnedPackages, pinnedModels, probeReports, evidenceObservedAt: observedAt, amendment006Sha256
    }, normalizedPolicy);
    if (code !== null) findings.push({ code, ...expected.get(key) });
  }
  for (const [key, expectedEntry] of expected) {
    if (!seen.has(key)) findings.push({ code: 'NATIVE_ATTEMPT_EVIDENCE_MISSING', ...expectedEntry });
  }
  if (findings.length > 0) return empty(findings);
  return Object.freeze({
    satisfiedRecoveries: new Set(expected.keys()),
    findings: Object.freeze([]),
    note: NATIVE_ATTEMPT_EVIDENCE_NOTE
  });
}
