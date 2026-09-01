import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECONCILIATION_CODES,
  parseProviderLedger,
  reconcileProviderEvidence
} from '../benchmark/lib/v11-provider-reconciler.mjs';

const RUN = 'run-2026-08-31';
const ATTEMPT = 'attempt-1';

function event(overrides = {}) {
  return {
    schema: 'shadowgraph.provider-meter.event',
    version: 1,
    event: 'provider_request',
    requestNumber: 0,
    runId: RUN,
    attemptId: ATTEMPT,
    armId: 'mem0-oss',
    scenarioId: 'ACC_ONE',
    repetition: 0,
    phase: 'B',
    requestClass: 'internal_memory_llm',
    requestedModel: 'pinned-decision-model',
    providerModel: 'pinned-decision-model',
    latencyMs: 12,
    outcome: 'SUCCEEDED',
    failure: null,
    httpStatus: 200,
    usage: { inputTokens: 10, outputTokens: 4 },
    ...overrides
  };
}

function expectation(overrides = {}) {
  return {
    runId: RUN,
    attemptId: ATTEMPT,
    armId: 'mem0-oss',
    scenarioId: 'ACC_ONE',
    repetition: 0,
    phase: 'B',
    requestClass: 'internal_memory_llm',
    expectedCalls: 1,
    ...overrides
  };
}

function codes(report) {
  return report.findings.map((finding) => finding.code);
}

test('exact agreement reconciles', () => {
  const report = reconcileProviderEvidence({
    events: [event()],
    expectations: [expectation()]
  });
  assert.equal(report.status, 'RECONCILED');
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.totals, {
    expectedCalls: 1,
    observedEvents: 1,
    matchedCalls: 1,
    malformedLines: 0
  });
});

test('every correlation component must match exactly, with no approximate attribution', () => {
  // Each of these differs from the expectation in exactly one component. None
  // may be credited against it: the call is missing and the observed traffic is
  // unaccounted for.
  for (const divergence of [
    { runId: 'run-other' },
    { attemptId: 'attempt-2' },
    { armId: 'graphiti' },
    { scenarioId: 'ACC_TWO' },
    { repetition: 1 },
    { phase: 'C' },
    { requestClass: 'embedding' }
  ]) {
    const report = reconcileProviderEvidence({
      events: [event(divergence)],
      expectations: [expectation()]
    });
    assert.equal(report.status, 'DISCREPANT', JSON.stringify(divergence));
    assert.deepEqual(
      codes(report).sort(),
      ['MISSING_CALL', 'UNEXPECTED_CALL'],
      JSON.stringify(divergence)
    );
    assert.equal(report.totals.matchedCalls, 0);
  }
});

test('correlation components cannot impersonate one another across the key boundary', () => {
  // A naive delimiter-joined key lets one component borrow characters from its
  // neighbour. These two correlations must stay distinct.
  const left = reconcileProviderEvidence({
    events: [event({ armId: 'arm', scenarioId: 'a:b' })],
    expectations: [expectation({ armId: 'arm:a', scenarioId: 'b', expectedCalls: 1 })]
  });
  assert.equal(left.status, 'DISCREPANT');
  assert.deepEqual(codes(left).sort(), ['MISSING_CALL', 'UNEXPECTED_CALL']);
});

test('a missing call is reported with its expected and observed counts', () => {
  const report = reconcileProviderEvidence({
    events: [],
    expectations: [expectation({ expectedCalls: 2 })]
  });
  assert.deepEqual(codes(report), ['MISSING_CALL']);
  assert.equal(report.findings[0].expected, 2);
  assert.equal(report.findings[0].observed, 0);
  assert.equal(report.findings[0].correlation.phase, 'B');
});

test('an extra call is a retry where calls were expected and unexpected where none were', () => {
  const retry = reconcileProviderEvidence({
    events: [event({ requestNumber: 0 }), event({ requestNumber: 1 })],
    expectations: [expectation({ expectedCalls: 1 })]
  });
  assert.deepEqual(codes(retry), ['RETRY_OBSERVED']);
  assert.equal(retry.findings[0].observed, 2);

  // A RESET phase makes no outer call, so any traffic on it is unaccounted for
  // rather than a retry.
  const unexpected = reconcileProviderEvidence({
    events: [event({ phase: 'RESET' })],
    expectations: [expectation({ phase: 'RESET', expectedCalls: 0 })]
  });
  assert.deepEqual(codes(unexpected), ['UNEXPECTED_CALL']);
});

test('a gap or duplicate in ledger numbering is reported even when counts agree', () => {
  // Counts can agree while evidence is still missing, so continuity is checked
  // independently of attribution.
  const gap = reconcileProviderEvidence({
    events: [event({ requestNumber: 0 }), event({ requestNumber: 7, phase: 'C' })],
    expectations: [expectation(), expectation({ phase: 'C' })]
  });
  assert.ok(codes(gap).includes('LEDGER_GAP'));
  assert.deepEqual(
    gap.findings.find((finding) => finding.code === 'LEDGER_GAP'),
    { code: 'LEDGER_GAP', after: 0, before: 7 }
  );

  const duplicate = reconcileProviderEvidence({
    events: [event({ requestNumber: 3 }), event({ requestNumber: 3, phase: 'C' })],
    expectations: [expectation(), expectation({ phase: 'C' })]
  });
  assert.ok(codes(duplicate).includes('DUPLICATE_REQUEST_NUMBER'));
});

test('model mismatch is caught against the served model and against the declared model', () => {
  const served = reconcileProviderEvidence({
    events: [event({ requestedModel: 'pinned-a', providerModel: 'substituted-b' })],
    expectations: [expectation()]
  });
  assert.deepEqual(codes(served), ['MODEL_MISMATCH']);
  assert.equal(served.findings[0].providerModel, 'substituted-b');

  const declared = reconcileProviderEvidence({
    events: [event({ requestedModel: 'unpinned-c', providerModel: 'unpinned-c' })],
    expectations: [expectation()],
    expectedModels: { internal_memory_llm: 'pinned-decision-model' }
  });
  assert.deepEqual(codes(declared), ['MODEL_MISMATCH']);
  assert.equal(declared.findings[0].declaredModel, 'pinned-decision-model');
});

test('failed outcomes and absent usage are incomplete evidence, not silent successes', () => {
  const failed = reconcileProviderEvidence({
    events: [event({ outcome: 'FAILED', httpStatus: 503 })],
    expectations: [expectation()]
  });
  assert.deepEqual(codes(failed), ['FAILED_OUTCOME']);
  assert.equal(failed.findings[0].httpStatus, 503);

  const noUsage = reconcileProviderEvidence({
    events: [event({ usage: null })],
    expectations: [expectation()]
  });
  assert.deepEqual(codes(noUsage), ['INCOMPLETE_USAGE']);
});

test('the ledger parser keeps malformed lines as evidence instead of discarding them', () => {
  const ledger = [
    JSON.stringify(event({ requestNumber: 0 })),
    'not json at all',
    JSON.stringify({ schema: 'something.else', version: 1 }),
    JSON.stringify(event({ requestNumber: 1, repetition: -1 })),
    JSON.stringify(event({ requestNumber: 2, phase: '' })),
    ''
  ].join('\n');

  const { events, malformed } = parseProviderLedger(ledger);
  assert.equal(events.length, 1);
  assert.equal(events[0].requestNumber, 0);

  // Four rejections: unparseable, wrong schema, negative repetition, and an
  // empty phase. The last two are well-formed JSON with a broken correlation,
  // which is exactly the case that must not be credited as a real call.
  assert.equal(malformed.length, 4);
  assert.deepEqual(malformed.map((entry) => entry.lineNumber), [2, 3, 4, 5]);

  const report = reconcileProviderEvidence({
    events,
    malformed,
    expectations: [expectation()]
  });
  assert.equal(report.status, 'DISCREPANT');
  assert.equal(report.totals.malformedLines, 4);
  assert.equal(codes(report).filter((code) => code === 'MALFORMED_EVENT').length, 4);
});

test('the report carries correlations and counts but never request or response bodies', () => {
  const report = reconcileProviderEvidence({
    events: [event({
      outcome: 'FAILED',
      usage: null,
      requestedModel: 'pinned-a',
      providerModel: 'other-b'
    })],
    expectations: [expectation()]
  });
  const serialized = JSON.stringify(report);
  for (const forbidden of ['prompt', 'body', 'authorization', 'apiKey', 'messages']) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.findings));
});

test('findings are ordered by severity class so the report reads consistently', () => {
  const report = reconcileProviderEvidence({
    events: [event({ outcome: 'FAILED', usage: null })],
    expectations: [expectation({ expectedCalls: 2 })]
  });
  const indices = report.findings.map((finding) => RECONCILIATION_CODES.indexOf(finding.code));
  assert.deepEqual(indices, [...indices].sort((left, right) => left - right));
});

test('malformed input is refused rather than silently reconciled', () => {
  assert.throws(() => parseProviderLedger(null), /must be a string/u);
  assert.throws(() => reconcileProviderEvidence(null), /must be an object/u);
  assert.throws(
    () => reconcileProviderEvidence({ events: [], expectations: [{ runId: RUN }] }),
    /attemptId/u
  );
  assert.throws(
    () => reconcileProviderEvidence({
      events: [],
      expectations: [expectation({ expectedCalls: -1 })]
    }),
    /expectedCalls/u
  );
});
