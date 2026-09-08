import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { verifyNativeAttemptEvidence } from '../benchmark/lib/v11-native-attempt-evidence.mjs';

const NOW = Date.parse('2026-09-08T10:00:00.000Z');
const AMENDMENT_006 = 'a'.repeat(64);
function structuredReport({ requestClass, category, modelId, taxonomy, wireAttempts }) {
  return JSON.stringify({
    schema: 'shadowgraph.v11.native-attempt-loopback-report',
    version: 1,
    observedAt: '2026-09-08T09:59:00.000Z',
    amendment006Sha256: AMENDMENT_006,
    armId: 'memory-x',
    requestClass,
    category,
    package: { name: 'product-x', version: '1.5.3' },
    modelId,
    network: 'loopback-only',
    rootOperationInvocations: 1,
    wireAttempts,
    taxonomy,
    allAttemptsMetered: true,
    providerUsageAccounting: 'metered-complete-or-fail-closed',
    modelEndpointPinned: true,
    harnessOperationReruns: 0
  }) + '\n';
}

const PROBE_REPORTS = Object.freeze({
  'internal-c.report.json': structuredReport({
    requestClass: 'internal_memory_llm',
    category: 'C',
    modelId: 'decision-x',
    taxonomy: { A: false, B: false, C: true, D: false, E: false },
    wireAttempts: [
      { ordinal: 1, path: '/v1/chat/completions', outcome: 'SUCCEEDED', modelId: 'decision-x', retryOrdinal: 0, responseFormat: 'json_object' },
      { ordinal: 2, path: '/v1/chat/completions', outcome: 'SUCCEEDED', modelId: 'decision-x', retryOrdinal: 0, responseFormat: 'json_object' },
      { ordinal: 3, path: '/v1/chat/completions', outcome: 'SUCCEEDED', modelId: 'decision-x', retryOrdinal: 0, responseFormat: 'json_object' }
    ]
  }),
  'embedding-b.report.json': structuredReport({
    requestClass: 'embedding',
    category: 'B',
    modelId: 'embedding-x',
    taxonomy: { A: false, B: true, C: false, D: false, E: false },
    wireAttempts: [
      { ordinal: 1, path: '/v1/embeddings', outcome: 'FAILED', modelId: 'embedding-x', retryOrdinal: 0, responseFormat: null },
      { ordinal: 2, path: '/v1/embeddings', outcome: 'FAILED', modelId: 'embedding-x', retryOrdinal: 1, responseFormat: null },
      { ordinal: 3, path: '/v1/embeddings', outcome: 'SUCCEEDED', modelId: 'embedding-x', retryOrdinal: 2, responseFormat: null }
    ]
  })
});

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function policy() {
  return {
    schema: 'shadowgraph.v11.native-attempt-policy',
    version: 1,
    maxAttemptsPerRootRequestClass: 24,
    arms: [{
      armId: 'memory-x',
      recovery: {
        outer_decision_llm: [],
        internal_memory_llm: ['C'],
        embedding: ['B']
      }
    }]
  };
}

function evidence() {
  return {
    schema: 'shadowgraph.v11.native-attempt-evidence',
    version: 1,
    observedAt: '2026-09-08T09:59:00.000Z',
    amendment006Sha256: AMENDMENT_006,
    entries: [
      {
        armId: 'memory-x',
        requestClass: 'internal_memory_llm',
        category: 'C',
        package: { name: 'product-x', version: '1.5.3' },
        modelId: 'decision-x',
        outcome: 'PASS',
        network: 'loopback-only',
        wireRequests: 3,
        allAttemptsMetered: true,
        providerUsageAccounting: 'metered-complete-or-fail-closed',
        modelEndpointPinned: true,
        harnessOperationReruns: 0,
        taxonomy: { A: false, B: false, C: true, D: false, E: false },
        probeReport: 'internal-c.report.json',
        probeSha256: sha256(PROBE_REPORTS['internal-c.report.json'])
      },
      {
        armId: 'memory-x',
        requestClass: 'embedding',
        category: 'B',
        package: { name: 'product-x', version: '1.5.3' },
        modelId: 'embedding-x',
        outcome: 'PASS',
        network: 'loopback-only',
        wireRequests: 3,
        allAttemptsMetered: true,
        providerUsageAccounting: 'metered-complete-or-fail-closed',
        modelEndpointPinned: true,
        harnessOperationReruns: 0,
        taxonomy: { A: false, B: true, C: false, D: false, E: false },
        probeReport: 'embedding-b.report.json',
        probeSha256: sha256(PROBE_REPORTS['embedding-b.report.json'])
      }
    ]
  };
}

function verifierInput(record, probeReports = PROBE_REPORTS) {
  return {
    evidence: record,
    policy: policy(),
    amendment006Sha256: AMENDMENT_006,
    pinnedPackages: { 'memory-x': { name: 'product-x', version: '1.5.3' } },
    pinnedModels: {
      outer_decision_llm: { modelId: 'decision-x' },
      internal_memory_llm: { modelId: 'decision-x' },
      embedding: { modelId: 'embedding-x' }
    },
    probeReports,
    now: NOW
  };
}

test('native evidence requires each declared probe report byte source', () => {
  const result = verifyNativeAttemptEvidence(verifierInput(evidence(), {}));
  assert.deepEqual(result.findings.map((finding) => finding.code), [
    'NATIVE_PROBE_REPORT_MISSING',
    'NATIVE_PROBE_REPORT_MISSING'
  ]);
});

test('matching-hash opaque report bytes cannot clear native evidence', () => {
  const record = evidence();
  const opaque = 'this is not JSON\n';
  record.entries[0].probeSha256 = sha256(opaque);
  const result = verifyNativeAttemptEvidence(verifierInput(record, {
    ...PROBE_REPORTS,
    'internal-c.report.json': opaque
  }));

  assert.deepEqual(result.findings.map((finding) => finding.code), [
    'NATIVE_PROBE_REPORT_MALFORMED'
  ]);
  assert.deepEqual([...result.satisfiedRecoveries], []);
});

test('matching-hash report with wrong pinned identity cannot clear native evidence', () => {
  const record = evidence();
  const report = JSON.parse(PROBE_REPORTS['internal-c.report.json']);
  report.modelId = 'substituted-model';
  const altered = `${JSON.stringify(report)}\n`;
  record.entries[0].probeSha256 = sha256(altered);
  const result = verifyNativeAttemptEvidence(verifierInput(record, {
    ...PROBE_REPORTS,
    'internal-c.report.json': altered
  }));

  assert.deepEqual(result.findings.map((finding) => finding.code), [
    'NATIVE_PROBE_REPORT_IDENTITY_MISMATCH'
  ]);
});

test('matching-hash report with malformed schema cannot clear native evidence', () => {
  const record = evidence();
  const report = JSON.parse(PROBE_REPORTS['internal-c.report.json']);
  report.schema = 'shadowgraph.v11.not-a-native-probe';
  const altered = `${JSON.stringify(report)}\n`;
  record.entries[0].probeSha256 = sha256(altered);
  const result = verifyNativeAttemptEvidence(verifierInput(record, {
    ...PROBE_REPORTS,
    'internal-c.report.json': altered
  }));

  assert.deepEqual(result.findings.map((finding) => finding.code), [
    'NATIVE_PROBE_REPORT_MALFORMED'
  ]);
});

test('matching-hash report with an undeclared nested package field cannot clear native evidence', () => {
  const record = evidence();
  const report = JSON.parse(PROBE_REPORTS['internal-c.report.json']);
  report.package.audit = 'opaque';
  const altered = `${JSON.stringify(report)}\n`;
  record.entries[0].probeSha256 = sha256(altered);
  const result = verifyNativeAttemptEvidence(verifierInput(record, {
    ...PROBE_REPORTS,
    'internal-c.report.json': altered
  }));

  assert.deepEqual(result.findings.map((finding) => finding.code), [
    'NATIVE_PROBE_REPORT_MALFORMED'
  ]);
});

test('native evidence entry with an undeclared nested package field fails closed', () => {
  const record = evidence();
  record.entries[0].package.audit = 'opaque';
  const result = verifyNativeAttemptEvidence(verifierInput(record));

  assert.deepEqual(result.findings.map((finding) => finding.code), [
    'NATIVE_ATTEMPT_EVIDENCE_ENTRY_MALFORMED'
  ]);
});

test('matching-hash malformed UTF-8 report bytes cannot clear native evidence', () => {
  const record = evidence();
  const report = JSON.parse(PROBE_REPORTS['internal-c.report.json']);
  report.package.name = '__INVALID_UTF8__';
  const bytes = Buffer.from(`${JSON.stringify(report)}\n`, 'utf8');
  const marker = Buffer.from('__INVALID_UTF8__', 'utf8');
  const offset = bytes.indexOf(marker);
  assert.notEqual(offset, -1);
  bytes[offset] = 0x80;
  record.entries[0].probeSha256 = sha256(bytes);
  const result = verifyNativeAttemptEvidence(verifierInput(record, {
    ...PROBE_REPORTS,
    'internal-c.report.json': bytes
  }));

  assert.deepEqual(result.findings.map((finding) => finding.code), [
    'NATIVE_PROBE_REPORT_MALFORMED'
  ]);
});

test('native evidence accepts canonical UTC microsecond instants from the pinned Python probe', () => {
  const record = evidence();
  record.observedAt = '2026-09-08T09:59:00.123456Z';
  const result = verifyNativeAttemptEvidence(verifierInput(record));
  assert.deepEqual(result.findings, []);
});

test('fresh generic native evidence satisfies every non-empty arm policy entry', () => {
  const result = verifyNativeAttemptEvidence(verifierInput(evidence()));

  assert.deepEqual([...result.satisfiedRecoveries].sort(), [
    'memory-x\u001fembedding\u001fB',
    'memory-x\u001finternal_memory_llm\u001fC'
  ]);
  assert.deepEqual(result.findings, []);
});
