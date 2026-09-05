import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RECONCILIATION_CODES,
  parseProviderLedger,
  providerExpectationsFromRun,
  reconcileProviderEvidence,
  runProviderReconciliation
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
    malformedLines: 0,
    unverifiedCountUnits: 0,
    unverifiedCountEvents: 0
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

// The run record is the claim; the ledger is the observation. Turning the first
// into expectations is what lets a real acceptance run be reconciled at all -
// before this existed the meter wrote a ledger on every run and nothing read it
// back, so three of this module's discrepancy codes were unreachable in
// production.

function unit(overrides = {}) {
  return {
    unitId: 'mem0-oss:ACC_ONE:0:B',
    runId: RUN,
    attemptId: ATTEMPT,
    armId: 'mem0-oss',
    scenarioId: 'ACC_ONE',
    repetition: 0,
    phase: 'B',
    status: 'MEASURED',
    operations: {
      memoryReadOperations: 1,
      memoryWriteOperations: 1,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 1,
      internalMemoryModelCalls: 2,
      embeddingCalls: 3,
      persistenceVerificationOperations: 0
    },
    ...overrides
  };
}

test('a run record becomes one expectation per unit and request class', () => {
  const { expectations, unverifiedCounts } = providerExpectationsFromRun({ units: [unit()] }, ATTEMPT);
  assert.deepEqual(unverifiedCounts, []);

  assert.deepEqual(expectations.map((each) => [each.requestClass, each.expectedCalls]), [
    ['outer_decision_llm', 1],
    ['internal_memory_llm', 2],
    ['embedding', 3]
  ]);
  assert.deepEqual(expectations[0], {
    runId: RUN,
    attemptId: ATTEMPT,
    armId: 'mem0-oss',
    scenarioId: 'ACC_ONE',
    repetition: 0,
    phase: 'B',
    requestClass: 'outer_decision_llm',
    expectedCalls: 1
  });
});

test('a unit that meters nothing still produces expectations of zero', () => {
  // An arm that issues no provider call has to be *checked* to have issued
  // none. The stray event below would be reported with no expectation at all -
  // the reconciler flags any unmatched event - so what the zero adds is the
  // run's own statement of what it claimed, carried into totals.expectedCalls
  // and held to rather than assumed.
  const quiet = unit({
    armId: 'basic-memory',
    operations: {
      memoryReadOperations: 1,
      memoryWriteOperations: 0,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 0,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 0
    }
  });
  const { expectations } = providerExpectationsFromRun({ units: [quiet] }, ATTEMPT);
  assert.equal(expectations.length, 3);
  assert.deepEqual(expectations.map((each) => each.expectedCalls), [0, 0, 0]);

  const stray = reconcileProviderEvidence({
    events: [event({ armId: 'basic-memory', requestClass: 'embedding' })],
    expectations
  });
  assert.equal(stray.status, 'DISCREPANT');
  assert.ok(stray.findings.some((finding) => finding.code === 'UNEXPECTED_CALL'));
  assert.equal(stray.totals.expectedCalls, 0, 'the run claimed nothing, and that is checked');
});

test('only this attempt is expected, because the ledger is opened per attempt', () => {
  // A resumed run carries the earlier attempt's units in its record, and that
  // attempt's provider traffic is in an earlier ledger. Expecting it here would
  // report every one of those calls missing from a ledger that never held them.
  const record = { units: [unit(), unit({ attemptId: 'attempt-2', unitId: 'mem0-oss:ACC_ONE:1:B' })] };
  const { expectations } = providerExpectationsFromRun(record, 'attempt-2');

  assert.equal(expectations.length, 3);
  assert.ok(expectations.every((each) => each.attemptId === 'attempt-2'));
});

test('a run record that cannot state its own provider traffic is refused', () => {
  for (const [record, pattern] of [
    [null, /raw run record/u],
    [{}, /raw run record/u],
    [{ units: [null] }, /must be an object/u],
    [{ units: [unit({ operations: undefined })] }, /no operation metrics/u],
    [{ units: [unit({ operations: { ...unit().operations, embeddingCalls: -1 } })] }, /embeddingCalls/u],
    [{ units: [unit({ operations: { ...unit().operations, outerDecisionModelCalls: null } })] }, /outerDecisionModelCalls/u]
  ]) {
    assert.throws(() => providerExpectationsFromRun(record, ATTEMPT), pattern);
  }
  assert.throws(() => providerExpectationsFromRun({ units: [] }, ''), /attempt/u);
});

test('a retry the run did not declare is reported against a run record', () => {
  // The whole reason the ledger counts requests rather than calls: a
  // transparent SDK retry is a second request for one call, and the run record
  // would say one.
  const { expectations } = providerExpectationsFromRun({ units: [unit()] }, ATTEMPT);
  const events = [
    event({ requestNumber: 0, requestClass: 'outer_decision_llm' }),
    event({ requestNumber: 1, requestClass: 'internal_memory_llm' }),
    event({ requestNumber: 2, requestClass: 'internal_memory_llm' }),
    event({ requestNumber: 3, requestClass: 'internal_memory_llm' }),
    event({ requestNumber: 4, requestClass: 'embedding' }),
    event({ requestNumber: 5, requestClass: 'embedding' }),
    event({ requestNumber: 6, requestClass: 'embedding' })
  ];

  const report = reconcileProviderEvidence({ events, expectations });
  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'RETRY_OBSERVED'));

  // And the same ledger without the extra internal call reconciles, so the
  // finding above is the retry rather than the shape of the expectations.
  const clean = reconcileProviderEvidence({
    // Renumbered, because a hole in the numbering is its own finding: the
    // meter numbers requests consecutively and a gap means evidence is missing.
    events: events
      .filter((each) => each.requestNumber !== 3)
      .map((each, index) => ({ ...each, requestNumber: index })),
    expectations
  });
  assert.equal(clean.status, 'RECONCILED');
  assert.equal(clean.totals.expectedCalls, 6);
  assert.equal(clean.totals.matchedCalls, 6);
});

// The decision a finished run makes about its own provider evidence. It is a
// pure function on purpose: the interesting case is the ledger that is not
// there, and leaving that in the CLI's catch block would put it where no test
// could reach it.

const PINNED = {
  internal_memory_llm: { modelId: 'pinned-decision-model', embeddingDimension: null },
  embedding: { modelId: 'pinned-embedding-model', embeddingDimension: 768 }
};

function ledgerLines(events) {
  return `${events.map((each) => JSON.stringify(each)).join(String.fromCharCode(10))}${String.fromCharCode(10)}`;
}

test('a run whose ledger matches its record reconciles', () => {
  const record = { units: [unit()] };
  const report = runProviderReconciliation({
    ledgerText: ledgerLines([
      event({ requestNumber: 0, requestClass: 'outer_decision_llm' }),
      event({ requestNumber: 1, requestClass: 'internal_memory_llm' }),
      event({ requestNumber: 2, requestClass: 'internal_memory_llm' }),
      event({ requestNumber: 3, requestClass: 'embedding', requestedModel: 'pinned-embedding-model', providerModel: 'pinned-embedding-model' }),
      event({ requestNumber: 4, requestClass: 'embedding', requestedModel: 'pinned-embedding-model', providerModel: 'pinned-embedding-model' }),
      event({ requestNumber: 5, requestClass: 'embedding', requestedModel: 'pinned-embedding-model', providerModel: 'pinned-embedding-model' })
    ]),
    ledgerPath: '/ledgers/attempt-1.provider-requests.ndjson',
    raw: record,
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.schema, 'shadowgraph.v11.provider-reconciliation');
  assert.equal(report.status, 'RECONCILED');
  assert.deepEqual(report.findings, []);
  assert.equal(report.totals.expectedCalls, 6);
  assert.equal(report.totals.matchedCalls, 6);
});

test('a ledger that could not be read is UNAVAILABLE, never RECONCILED', () => {
  // The meter opens this file when the run binds, so a run that produced a
  // record and no ledger has lost its evidence. Reporting that as reconciled is
  // the strongest overstatement this comparison could make.
  const report = runProviderReconciliation({
    ledgerText: null,
    ledgerPath: '/ledgers/attempt-1.provider-requests.ndjson',
    raw: { units: [unit()] },
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'UNAVAILABLE');
  assert.equal(report.totals, null);
  assert.deepEqual(report.findings.map((each) => each.code), ['LEDGER_UNREADABLE']);
});

test('an empty ledger is reconciled only when the run claimed nothing', () => {
  const quiet = unit({
    armId: 'basic-memory',
    operations: {
      memoryReadOperations: 1,
      memoryWriteOperations: 0,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 0,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 0
    }
  });
  const common = {
    ledgerText: '',
    ledgerPath: '/ledgers/attempt-1.provider-requests.ndjson',
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  };

  assert.equal(runProviderReconciliation({ ...common, raw: { units: [quiet] } }).status, 'RECONCILED');
  // And a run that claimed six calls against an empty ledger does not.
  const missing = runProviderReconciliation({ ...common, raw: { units: [unit()] } });
  assert.equal(missing.status, 'DISCREPANT');
  assert.equal(missing.totals.observedEvents, 0);
});

test('the model the run was bound to is the model the ledger is held to', () => {
  // Not a second reading of the lock: the run passes the models it actually
  // bound, so a ledger recording anything else is a mismatch rather than a
  // disagreement between two readers.
  const report = runProviderReconciliation({
    ledgerText: ledgerLines([
      event({ requestNumber: 0, requestClass: 'outer_decision_llm', requestedModel: 'some-other-model', providerModel: 'some-other-model' })
    ]),
    ledgerPath: '/ledgers/attempt-1.provider-requests.ndjson',
    raw: {
      units: [unit({
        operations: {
          memoryReadOperations: 0,
          memoryWriteOperations: 0,
          mcpToolCalls: 0,
          outerDecisionModelCalls: 1,
          internalMemoryModelCalls: 0,
          embeddingCalls: 0,
          persistenceVerificationOperations: 0
        }
      })]
    },
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'MODEL_MISMATCH'));
});

test('a reconciliation that cannot name its ledger or its models is refused', () => {
  const base = {
    ledgerText: '',
    ledgerPath: '/ledgers/attempt-1.provider-requests.ndjson',
    raw: { units: [] },
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  };
  assert.throws(() => runProviderReconciliation({ ...base, ledgerPath: '' }), /name the ledger/u);
  assert.throws(() => runProviderReconciliation({ ...base, pinnedModels: {} }), /pinned model ids/u);
  assert.throws(
    () => runProviderReconciliation({ ...base, pinnedModels: { internal_memory_llm: {} } }),
    /pinned model ids/u
  );
  // Present but nameless. This passed the earlier guard, made every entry of
  // `expectedModels` undefined, and turned the model comparison off entirely.
  assert.throws(
    () => runProviderReconciliation({
      ...base,
      pinnedModels: { internal_memory_llm: {}, embedding: {} }
    }),
    /pinned model ids/u
  );
  assert.throws(
    () => runProviderReconciliation({
      ...base,
      pinnedModels: { internal_memory_llm: { modelId: '' }, embedding: { modelId: 'e' } }
    }),
    /pinned model ids/u
  );
  assert.throws(() => runProviderReconciliation({ ...base, ledgerText: 42 }), /ledger text or nothing/u);
  assert.throws(() => runProviderReconciliation(), /name the ledger/u);
});

test('a failed unit is held to everything except its counts', () => {
  // A container that fails mid-operation gets a host-synthesised envelope whose
  // counts are all zero, and an abort discards counts the adapter had already
  // reported - while the calls are in the ledger either way. Holding those
  // correlations to zero reported a metering violation on a run that had none.
  //
  // The first attempt removed the events instead, and was wrong three ways: it
  // left a hole in the request numbering so LEDGER_GAP fired on the very run it
  // meant to save; it skipped every per-event check; and it therefore let an arm
  // reach an unpinned model and crash while the run reported RECONCILED. So the
  // count is what is unverifiable, and only the count.
  const failed = unit({ unitId: 'mem0-oss:ACC_ONE:1:B', repetition: 1, status: 'FAILED' });
  const record = { units: [unit(), failed] };
  const { expectations, unverifiedCounts } = providerExpectationsFromRun(record, ATTEMPT);

  assert.equal(expectations.length, 6, 'a failed unit still gets expectations');
  assert.deepEqual(unverifiedCounts.map((each) => [each.unitId, each.status]), [
    ['mem0-oss:ACC_ONE:1:B', 'FAILED']
  ]);

  // The failed unit's events sit in the MIDDLE of the ledger's numbering, which
  // is the case the removal broke: requestNumber is one counter for the whole
  // attempt, so dropping a contiguous block leaves a gap.
  const report = runProviderReconciliation({
    ledgerText: ledgerLines([
      event({ requestNumber: 0, requestClass: 'outer_decision_llm' }),
      event({ requestNumber: 1, repetition: 1, requestClass: 'internal_memory_llm' }),
      event({ requestNumber: 2, repetition: 1, requestClass: 'internal_memory_llm' }),
      event({ requestNumber: 3, requestClass: 'internal_memory_llm' }),
      event({ requestNumber: 4, requestClass: 'internal_memory_llm' }),
      event({ requestNumber: 5, requestClass: 'embedding', requestedModel: 'pinned-embedding-model', providerModel: 'pinned-embedding-model' }),
      event({ requestNumber: 6, requestClass: 'embedding', requestedModel: 'pinned-embedding-model', providerModel: 'pinned-embedding-model' }),
      event({ requestNumber: 7, requestClass: 'embedding', requestedModel: 'pinned-embedding-model', providerModel: 'pinned-embedding-model' })
    ]),
    ledgerPath: '/ledgers/attempt-1.provider-requests.ndjson',
    raw: record,
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'RECONCILED');
  assert.deepEqual(report.findings, [], 'no LEDGER_GAP: the events were never removed');
  assert.equal(report.totals.observedEvents, 8);
  assert.equal(report.totals.unverifiedCountEvents, 2);
  assert.equal(report.totals.unverifiedCountUnits, 1);
});

test('a failed unit reaching an unpinned model is still a finding', () => {
  // The hole the removal opened. MODEL_MISMATCH, FAILED_OUTCOME and
  // INCOMPLETE_USAGE read no count, so a unit whose counts cannot be verified is
  // still fully answerable for what its traffic actually was.
  const failed = unit({ unitId: 'mem0-oss:ACC_ONE:1:B', repetition: 1, status: 'FAILED' });
  const record = { units: [unit(), failed] };
  const report = runProviderReconciliation({
    ledgerText: ledgerLines([
      event({ requestNumber: 0, requestClass: 'outer_decision_llm' }),
      event({ requestNumber: 1, requestClass: 'internal_memory_llm' }),
      event({ requestNumber: 2, requestClass: 'internal_memory_llm' }),
      event({ requestNumber: 3, requestClass: 'embedding', requestedModel: 'pinned-embedding-model', providerModel: 'pinned-embedding-model' }),
      event({ requestNumber: 4, requestClass: 'embedding', requestedModel: 'pinned-embedding-model', providerModel: 'pinned-embedding-model' }),
      event({ requestNumber: 5, requestClass: 'embedding', requestedModel: 'pinned-embedding-model', providerModel: 'pinned-embedding-model' }),
      event({
        requestNumber: 6,
        repetition: 1,
        requestClass: 'internal_memory_llm',
        requestedModel: 'gpt-4o-from-the-internet',
        providerModel: 'gpt-4o-from-the-internet'
      }),
      event({ requestNumber: 7, repetition: 1, requestClass: 'embedding', outcome: 'FAILED', usage: null })
    ]),
    ledgerPath: '/ledgers/attempt-1.provider-requests.ndjson',
    raw: record,
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'DISCREPANT');
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes('MODEL_MISMATCH'), 'an unpinned model is a finding whoever made the call');
  assert.ok(codes.includes('FAILED_OUTCOME'));
  assert.ok(codes.includes('INCOMPLETE_USAGE'));
  // And none of them is a count finding, which is the part that was excused.
  assert.ok(!codes.includes('RETRY_OBSERVED'));
  assert.ok(!codes.includes('UNEXPECTED_CALL'));
});

test('an excluded unit is structurally zero and is still held to it', () => {
  // EXCLUDED and NOT_MEASURED units are not units the harness failed to observe:
  // `validateRawRun` forbids them from recording any operation, so the record
  // does know the answer. Excusing them excused the 20 excluded units every
  // acceptance plan schedules - on correlations an arm can still reach a model
  // from.
  const zeroes = {
    memoryReadOperations: 0,
    memoryWriteOperations: 0,
    mcpToolCalls: 0,
    outerDecisionModelCalls: 0,
    internalMemoryModelCalls: 0,
    embeddingCalls: 0,
    persistenceVerificationOperations: 0
  };
  for (const status of ['EXCLUDED', 'NOT_MEASURED']) {
    const excluded = unit({ unitId: `graphiti:ACC_ONE:0:ISOLATION_USER`, armId: 'graphiti', status, operations: zeroes });
    const { unverifiedCounts } = providerExpectationsFromRun({ units: [excluded] }, ATTEMPT);
    assert.deepEqual(unverifiedCounts, [], status);

    const report = runProviderReconciliation({
      ledgerText: ledgerLines([
        event({
          requestNumber: 0,
          armId: 'graphiti',
          requestClass: 'internal_memory_llm',
          requestedModel: 'a-model-from-the-internet',
          providerModel: 'a-model-from-the-internet'
        })
      ]),
      ledgerPath: '/ledgers/attempt-1.provider-requests.ndjson',
      raw: { units: [excluded] },
      attemptId: ATTEMPT,
      pinnedModels: PINNED
    });

    assert.equal(report.status, 'DISCREPANT', status);
    const codes = report.findings.map((finding) => finding.code);
    assert.ok(codes.includes('UNEXPECTED_CALL'), status);
    assert.ok(codes.includes('MODEL_MISMATCH'), status);
  }
});

test('the declared model is checked for every request class, not only the outer one', () => {
  // Each class is compared against its own entry, so a map that named only the
  // outer model would leave both classes a metered arm actually produces
  // unchecked.
  for (const requestClass of ['outer_decision_llm', 'internal_memory_llm', 'embedding']) {
    const operations = {
      memoryReadOperations: 0,
      memoryWriteOperations: 0,
      mcpToolCalls: 0,
      outerDecisionModelCalls: requestClass === 'outer_decision_llm' ? 1 : 0,
      internalMemoryModelCalls: requestClass === 'internal_memory_llm' ? 1 : 0,
      embeddingCalls: requestClass === 'embedding' ? 1 : 0,
      persistenceVerificationOperations: 0
    };
    const report = runProviderReconciliation({
      ledgerText: ledgerLines([
        event({
          requestNumber: 0,
          requestClass,
          requestedModel: 'a-model-from-the-internet',
          providerModel: 'a-model-from-the-internet'
        })
      ]),
      ledgerPath: '/ledgers/attempt-1.provider-requests.ndjson',
      raw: { units: [unit({ operations })] },
      attemptId: ATTEMPT,
      pinnedModels: PINNED
    });
    assert.equal(report.status, 'DISCREPANT', requestClass);
    assert.ok(
      report.findings.some((finding) => finding.code === 'MODEL_MISMATCH'),
      `${requestClass} must be held to its declared model`
    );
  }
});

test('LEDGER_UNREADABLE is one of the codes this module documents', () => {
  // The list is documented as every discrepancy the reconciler can report, and a
  // reader building a table of codes from it would have missed the one an absent
  // ledger produces.
  assert.ok(RECONCILIATION_CODES.includes('LEDGER_UNREADABLE'));
  const report = runProviderReconciliation({
    ledgerText: null,
    ledgerPath: '/ledgers/attempt-1.provider-requests.ndjson',
    raw: { units: [unit()] },
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });
  assert.ok(report.findings.every((finding) => RECONCILIATION_CODES.includes(finding.code)));
});
