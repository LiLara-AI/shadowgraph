import assert from 'node:assert/strict';
import test from 'node:test';

import { runProviderReconciliation } from '../benchmark/lib/v11-provider-reconciler.mjs';

const RUN = 'run-plan-reconcile-1';
const ATTEMPT = 'attempt-plan-reconcile-1';
const ROOT = 'root-persist-1';
const DISPATCH = 'a'.repeat(48);
const ALIAS = 'b'.repeat(48);
const PINNED = {
  internal_memory_llm: { modelId: 'qwen2.5:7b' },
  embedding: { modelId: 'nomic-embed-text:v1.5' }
};

const CAMPAIGN_POLICY = Object.freeze({
  campaignId: 'offline-only',
  deadline: '2099-01-01T00:00:00.000Z',
  limits: { outer_decision_llm: 5, internal_memory_llm: 5, embedding: 5 },
  maxRequests: 5,
  maxSessions: 5,
  maxRecoveryAttempts: 0,
  implementationLockHash: 'e'.repeat(64)
});

function raw() {
  return {
    implementationLockHash: CAMPAIGN_POLICY.implementationLockHash,
    units: [{
    unitId: 'cognee:ACC_PLAN_1:0:A',
    runId: RUN,
    attemptId: ATTEMPT,
    armId: 'cognee',
    scenarioId: 'ACC_PLAN_1',
    repetition: 0,
    phase: 'A',
    status: 'MEASURED',
    operations: {
      memoryReadOperations: 0,
      memoryWriteOperations: 0,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 0,
      internalMemoryModelCalls: 0,
      embeddingCalls: 1,
      persistenceVerificationOperations: 0
    }
  }] };
}

function event(rootOperation, { campaignReservationId = null } = {}) {
  return {
    schema: 'shadowgraph.provider-meter.event',
    version: 2,
    event: 'provider_request',
    requestNumber: 1,
    runId: RUN,
    attemptId: ATTEMPT,
    armId: 'cognee',
    scenarioId: 'ACC_PLAN_1',
    repetition: 0,
    phase: 'A',
    requestClass: 'embedding',
    rootOperation,
    rootInvocationId: ROOT,
    plannedDispatchId: DISPATCH,
    planSlot: 'root-embedding:child:1',
    dispatchAlias: ALIAS,
    disposition: 'data-dependent-child',
    ...(campaignReservationId === null ? {} : { campaignReservationId }),
    requestedModel: PINNED.embedding.modelId,
    responseFormat: null,
    providerModel: PINNED.embedding.modelId,
    latencyMs: 1,
    outcome: 'SUCCEEDED',
    failure: null,
    httpStatus: 200,
    usage: { input_tokens: 1, total_tokens: 1 }
  };
}

function planLedger({ omitChildRule = false, omitClose = false, omitRootPlanSlot = false } = {}) {
  const correlation = {
    runId: RUN,
    attemptId: ATTEMPT,
    armId: 'cognee',
    scenarioId: 'ACC_PLAN_1',
    repetition: 0,
    phase: 'A',
    requestClass: 'embedding',
    rootOperation: 'persist'
  };
  return [
    {
      schema: 'shadowgraph.provider-meter.plan', version: 1, recordedAt: '2099-01-01T00:00:00.000Z',
      event: 'root_plan', rootInvocationId: ROOT, planSlot: 'root-embedding', identityMode: 'dynamic',
      ...(omitChildRule ? {} : { childRule: 'data-dependent-before-send' }), correlation
    },
    {
      schema: 'shadowgraph.provider-meter.plan', version: 1, recordedAt: '2099-01-01T00:00:01.000Z',
      event: 'dispatch_plan', plannedDispatchId: DISPATCH, alias: ALIAS, rootInvocationId: ROOT,
      parentRootInvocationId: ROOT, ...(omitRootPlanSlot ? {} : { rootPlanSlot: 'root-embedding' }),
      ...(omitChildRule ? {} : { childRule: 'data-dependent-before-send' }),
      planSlot: 'root-embedding:child:1', disposition: 'data-dependent-child', recoveryOf: null, correlation
    },
    {
      schema: 'shadowgraph.provider-meter.plan', version: 1, recordedAt: '2099-01-01T00:00:02.000Z',
      event: 'dispatch_closed', plannedDispatchId: DISPATCH, alias: ALIAS, rootInvocationId: ROOT,
      planSlot: 'root-embedding:child:1'
    }
  ].filter((row) => !omitClose || row.event !== 'dispatch_closed')
    .map((row) => JSON.stringify(row)).join('\n') + '\n';
}

function campaignLedger({
  reservationId = 'offline-only:1',
  plannedDispatchId = DISPATCH,
  policy = CAMPAIGN_POLICY
} = {}) {
  const correlation = {
    runId: RUN, attemptId: ATTEMPT, armId: 'cognee', scenarioId: 'ACC_PLAN_1',
    repetition: 0, phase: 'A', requestClass: 'embedding', rootOperation: 'persist'
  };
  return [
    { event: 'policy', policy },
    {
      event: 'session', id: 'attempt-plan-reconcile-1', recovery: false,
      kind: 'acceptance', runId: RUN, attemptId: ATTEMPT
    },
    {
      event: 'reservation', reservationId, session: 'attempt-plan-reconcile-1',
      ...correlation, rootInvocationId: ROOT, plannedDispatchId,
      planSlot: 'root-embedding:child:1', disposition: 'data-dependent-child'
    }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
}

test('a plan alias cannot credit a provider event from another root operation', () => {
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('verify'))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: planLedger(),
    requireDispatchPlans: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'DISPATCH_PLAN_MISMATCH'));
});

test('a matching plan alias reconciles valid same-operation traffic', () => {
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist'))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: planLedger(),
    requireDispatchPlans: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'RECONCILED');
  assert.deepEqual(report.findings, []);
});

test('a bound dynamic replay denial joins its root slot and exact child plan', () => {
  const rows = planLedger().trimEnd().split('\n');
  rows.push(JSON.stringify({
    schema: 'shadowgraph.provider-meter.plan', version: 1, recordedAt: '2099-01-01T00:00:03.000Z',
    event: 'dispatch_denied', code: 'INVALID_OR_REUSED_DISPATCH_ALIAS',
    rootInvocationId: ROOT, rootPlanSlot: 'root-embedding', planSlot: 'root-embedding:child:1',
    plannedDispatchId: DISPATCH, alias: ALIAS, disposition: 'data-dependent-child',
    correlation: {
      runId: RUN, attemptId: ATTEMPT, armId: 'cognee', scenarioId: 'ACC_PLAN_1',
      repetition: 0, phase: 'A', requestClass: 'embedding', rootOperation: 'persist'
    }
  }));
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist'))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: `${rows.join('\n')}\n`,
    requireDispatchPlans: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'RECONCILED');
  assert.deepEqual(report.findings, []);
});

test('a dynamic replay denial cannot forge its planned dispatch identity', () => {
  const rows = planLedger().trimEnd().split('\n');
  rows.push(JSON.stringify({
    schema: 'shadowgraph.provider-meter.plan', version: 1, recordedAt: '2099-01-01T00:00:03.000Z',
    event: 'dispatch_denied', code: 'INVALID_OR_REUSED_DISPATCH_ALIAS',
    rootInvocationId: ROOT, rootPlanSlot: 'root-embedding', planSlot: 'root-embedding:child:1',
    plannedDispatchId: 'c'.repeat(48), alias: ALIAS, disposition: 'data-dependent-child',
    correlation: {
      runId: RUN, attemptId: ATTEMPT, armId: 'cognee', scenarioId: 'ACC_PLAN_1',
      repetition: 0, phase: 'A', requestClass: 'embedding', rootOperation: 'persist'
    }
  }));
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist'))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: `${rows.join('\n')}\n`,
    requireDispatchPlans: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'DISPATCH_PLAN_INVALID'));
});

test('a known dynamic replay cannot be represented as an unbound denial', () => {
  const rows = planLedger().trimEnd().split('\n');
  rows.push(JSON.stringify({
    schema: 'shadowgraph.provider-meter.plan', version: 1, recordedAt: '2099-01-01T00:00:03.000Z',
    event: 'dispatch_denied', code: 'INVALID_OR_REUSED_DISPATCH_ALIAS',
    rootInvocationId: ROOT, planSlot: 'root-embedding',
    plannedDispatchId: null, alias: null, disposition: null,
    correlation: {
      runId: RUN, attemptId: ATTEMPT, armId: 'cognee', scenarioId: 'ACC_PLAN_1',
      repetition: 0, phase: 'A', requestClass: 'embedding', rootOperation: 'persist'
    }
  }));
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist'))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: `${rows.join('\n')}\n`,
    requireDispatchPlans: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'DISPATCH_PLAN_INVALID'));
});

test('an unknown dynamic alias remains explicitly unbound', () => {
  const rows = planLedger().trimEnd().split('\n');
  rows.push(JSON.stringify({
    schema: 'shadowgraph.provider-meter.plan', version: 1, recordedAt: '2099-01-01T00:00:03.000Z',
    event: 'dispatch_denied', code: 'UNKNOWN_DISPATCH_ALIAS',
    rootInvocationId: ROOT, rootPlanSlot: 'root-embedding', planSlot: null,
    plannedDispatchId: null, alias: null, disposition: null,
    correlation: {
      runId: RUN, attemptId: ATTEMPT, armId: 'cognee', scenarioId: 'ACC_PLAN_1',
      repetition: 0, phase: 'A', requestClass: 'embedding', rootOperation: 'persist'
    }
  }));
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist'))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: `${rows.join('\n')}\n`,
    requireDispatchPlans: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'RECONCILED');
  assert.deepEqual(report.findings, []);
});

test('a missing campaign reservation receipt cannot reconcile a planned event', () => {
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist', { campaignReservationId: 'offline-only:2' }))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: planLedger(),
    campaignLedgerText: campaignLedger(),
    requireDispatchPlans: true,
    requireCampaignReservations: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'CAMPAIGN_RESERVATION_UNKNOWN'));
});

test('a matching campaign reservation receipt reconciles a planned event', () => {
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist', { campaignReservationId: 'offline-only:1' }))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: planLedger(),
    campaignLedgerText: campaignLedger(),
    requireDispatchPlans: true,
    requireCampaignReservations: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'RECONCILED');
  assert.deepEqual(report.findings, []);
});

test('a campaign receipt ledger with an incomplete policy is invalid evidence', () => {
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist', { campaignReservationId: 'offline-only:1' }))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: planLedger(),
    campaignLedgerText: campaignLedger({ policy: { campaignId: 'offline-only' } }),
    requireDispatchPlans: true,
    requireCampaignReservations: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });
  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'CAMPAIGN_LEDGER_INVALID'));
});

test('a noncontiguous campaign receipt sequence is invalid evidence', () => {
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist', { campaignReservationId: 'offline-only:2' }))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: planLedger(),
    campaignLedgerText: campaignLedger({ reservationId: 'offline-only:2' }),
    requireDispatchPlans: true,
    requireCampaignReservations: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });
  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'CAMPAIGN_LEDGER_INVALID'));
});

test('campaign receipts exceeding the policy maximum are invalid evidence', () => {
  const policy = { ...CAMPAIGN_POLICY, maxRequests: 1, limits: { ...CAMPAIGN_POLICY.limits, embedding: 1 } };
  const rows = campaignLedger({ policy }).trimEnd().split('\n');
  const receipt = JSON.parse(rows.at(-1));
  rows.push(JSON.stringify({ ...receipt, reservationId: 'offline-only:2' }));
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist', { campaignReservationId: 'offline-only:1' }))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson', planLedgerText: planLedger(),
    campaignLedgerText: `${rows.join('\n')}\n`, requireDispatchPlans: true,
    requireCampaignReservations: true, raw: raw(), attemptId: ATTEMPT, pinnedModels: PINNED
  });
  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'CAMPAIGN_LEDGER_INVALID'));
});

test('campaign sessions exceeding the policy maximum are invalid evidence', () => {
  const policy = { ...CAMPAIGN_POLICY, maxSessions: 1 };
  const rows = campaignLedger({ policy }).trimEnd().split('\n');
  rows.splice(2, 0, JSON.stringify({
    event: 'session', id: 'probe-session-2', recovery: false, kind: 'probe', runId: RUN, attemptId: ATTEMPT
  }));
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist', { campaignReservationId: 'offline-only:1' }))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson', planLedgerText: planLedger(),
    campaignLedgerText: `${rows.join('\n')}\n`, requireDispatchPlans: true,
    requireCampaignReservations: true, raw: raw(), attemptId: ATTEMPT, pinnedModels: PINNED
  });
  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'CAMPAIGN_LEDGER_INVALID'));
});

test('campaign recovery sessions exceeding the policy maximum are invalid evidence', () => {
  const policy = { ...CAMPAIGN_POLICY, maxSessions: 5, maxRecoveryAttempts: 0 };
  const rows = campaignLedger({ policy }).trimEnd().split('\n');
  rows.splice(2, 0, JSON.stringify({
    event: 'session', id: 'recovery-session-2', recovery: true, kind: 'probe', runId: RUN, attemptId: ATTEMPT
  }));
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist', { campaignReservationId: 'offline-only:1' }))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson', planLedgerText: planLedger(),
    campaignLedgerText: `${rows.join('\n')}\n`, requireDispatchPlans: true,
    requireCampaignReservations: true, raw: raw(), attemptId: ATTEMPT, pinnedModels: PINNED
  });
  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'CAMPAIGN_LEDGER_INVALID'));
});

test('a campaign ledger cannot reconcile without raw implementation-lock identity', () => {
  const observedRaw = raw();
  delete observedRaw.implementationLockHash;
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist', { campaignReservationId: 'offline-only:1' }))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson', planLedgerText: planLedger(),
    campaignLedgerText: campaignLedger(), requireDispatchPlans: true,
    requireCampaignReservations: true, raw: observedRaw, attemptId: ATTEMPT, pinnedModels: PINNED
  });
  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'CAMPAIGN_LEDGER_INVALID'));
});

test('a campaign ledger for another implementation lock is invalid evidence', () => {
  const observedRaw = raw();
  observedRaw.implementationLockHash = 'f'.repeat(64);
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist', { campaignReservationId: 'offline-only:1' }))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson', planLedgerText: planLedger(),
    campaignLedgerText: campaignLedger(), requireDispatchPlans: true,
    requireCampaignReservations: true, raw: observedRaw, attemptId: ATTEMPT, pinnedModels: PINNED
  });
  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'CAMPAIGN_LEDGER_INVALID'));
});

test('a campaign receipt with an out-of-policy request class is invalid evidence', () => {
  const rows = campaignLedger().trimEnd().split('\n');
  const receipt = JSON.parse(rows.at(-1));
  rows[rows.length - 1] = JSON.stringify({ ...receipt, requestClass: 'unknown_provider_class' });
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist', { campaignReservationId: 'offline-only:1' }))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson', planLedgerText: planLedger(),
    campaignLedgerText: `${rows.join('\n')}\n`, requireDispatchPlans: true,
    requireCampaignReservations: true, raw: raw(), attemptId: ATTEMPT, pinnedModels: PINNED
  });
  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'CAMPAIGN_LEDGER_INVALID'));
});

test('a malformed campaign dispatch identity invalidates the campaign ledger', () => {
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist', { campaignReservationId: 'offline-only:1' }))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: planLedger(),
    campaignLedgerText: campaignLedger({ plannedDispatchId: 'not-an-opaque-dispatch-id' }),
    requireDispatchPlans: true,
    requireCampaignReservations: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'CAMPAIGN_LEDGER_INVALID'));
});

test('a dynamic root cannot credit a root-initial consumed dispatch', () => {
  const rows = planLedger().trimEnd().split('\n').map((line) => JSON.parse(line));
  rows[1] = {
    ...rows[1],
    planSlot: 'root-embedding',
    disposition: 'root-initial'
  };
  rows[2] = {
    ...rows[2],
    event: 'dispatch_consumed',
    planSlot: 'root-embedding'
  };
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify({
      ...event('persist'),
      planSlot: 'root-embedding',
      disposition: 'root-initial'
    })}\n`,
    ledgerPath: 'forged-dynamic-static.provider-requests.ndjson',
    planLedgerText: `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    requireDispatchPlans: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'DISPATCH_PLAN_INVALID'));
});

test('a consumed static plan permits exactly one provider event', () => {
  const correlation = {
    runId: RUN, attemptId: ATTEMPT, armId: 'shadowgraph-full', scenarioId: 'ACC_STATIC_1',
    repetition: 0, phase: 'A', requestClass: 'internal_memory_llm', rootOperation: 'outer-decision'
  };
  const staticEvent = {
    ...event('outer-decision'),
    armId: 'shadowgraph-full', scenarioId: 'ACC_STATIC_1', requestClass: 'internal_memory_llm',
    rootInvocationId: 'root-static-1', plannedDispatchId: 'c'.repeat(48), dispatchAlias: 'd'.repeat(48),
    planSlot: 'outer-decision', disposition: 'root-initial',
    requestedModel: PINNED.internal_memory_llm.modelId, providerModel: PINNED.internal_memory_llm.modelId
  };
  const planText = [
    {
      schema: 'shadowgraph.provider-meter.plan', version: 1, recordedAt: '2099-01-01T00:00:00.000Z',
      event: 'root_plan', rootInvocationId: 'root-static-1', planSlot: 'outer-decision',
      identityMode: 'static', childRule: null, correlation
    },
    {
      schema: 'shadowgraph.provider-meter.plan', version: 1, recordedAt: '2099-01-01T00:00:01.000Z',
      event: 'dispatch_plan', plannedDispatchId: 'c'.repeat(48), alias: 'd'.repeat(48),
      rootInvocationId: 'root-static-1', parentRootInvocationId: 'root-static-1', rootPlanSlot: 'outer-decision', childRule: null,
      planSlot: 'outer-decision', disposition: 'root-initial', recoveryOf: null, correlation
    },
    {
      schema: 'shadowgraph.provider-meter.plan', version: 1, recordedAt: '2099-01-01T00:00:02.000Z',
      event: 'dispatch_consumed', plannedDispatchId: 'c'.repeat(48), alias: 'd'.repeat(48),
      rootInvocationId: 'root-static-1', planSlot: 'outer-decision'
    }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(staticEvent)}\n`,
    ledgerPath: 'static.provider-requests.ndjson',
    planLedgerText: planText,
    requireDispatchPlans: true,
    raw: { units: [{
      unitId: 'shadowgraph-full:ACC_STATIC_1:0:A', ...correlation, status: 'MEASURED',
      operations: {
        memoryReadOperations: 0, memoryWriteOperations: 0, mcpToolCalls: 0,
        outerDecisionModelCalls: 0, internalMemoryModelCalls: 1, embeddingCalls: 0,
        persistenceVerificationOperations: 0
      }
    }] },
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'RECONCILED');
  assert.deepEqual(report.findings, []);

  const unconsumedPlanText = `${planText.trimEnd().split('\n').slice(0, -1).join('\n')}\n`;
  const unconsumed = runProviderReconciliation({
    ledgerText: `${JSON.stringify(staticEvent)}\n`,
    ledgerPath: 'static.provider-requests.ndjson',
    planLedgerText: unconsumedPlanText,
    requireDispatchPlans: true,
    raw: { units: [{
      unitId: 'shadowgraph-full:ACC_STATIC_1:0:A', ...correlation, status: 'MEASURED',
      operations: {
        memoryReadOperations: 0, memoryWriteOperations: 0, mcpToolCalls: 0,
        outerDecisionModelCalls: 0, internalMemoryModelCalls: 1, embeddingCalls: 0,
        persistenceVerificationOperations: 0
      }
    }] },
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });
  assert.equal(unconsumed.status, 'DISCREPANT');
  assert.ok(unconsumed.findings.some((finding) => finding.code === 'STATIC_DISPATCH_UNCONSUMED'));

  const replay = runProviderReconciliation({
    ledgerText: `${JSON.stringify(staticEvent)}\n${JSON.stringify({ ...staticEvent, requestNumber: 2 })}\n`,
    ledgerPath: 'static.provider-requests.ndjson',
    planLedgerText: planText,
    requireDispatchPlans: true,
    raw: { units: [{
      unitId: 'shadowgraph-full:ACC_STATIC_1:0:A', ...correlation, status: 'MEASURED',
      operations: { memoryReadOperations: 0, memoryWriteOperations: 0, mcpToolCalls: 0,
        outerDecisionModelCalls: 0, internalMemoryModelCalls: 2, embeddingCalls: 0,
        persistenceVerificationOperations: 0 }
    }] },
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });
  assert.equal(replay.status, 'DISCREPANT');
  assert.ok(replay.findings.some((finding) => finding.code === 'STATIC_DISPATCH_REPLAY'));
});

test('an interrupted dynamic plan without closure is invalid evidence', () => {
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist'))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: planLedger({ omitClose: true }),
    requireDispatchPlans: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'DISPATCH_PLAN_INVALID'));
});

test('a strict plan ledger without its root plan slot is invalid evidence', () => {
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist'))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: planLedger({ omitRootPlanSlot: true }),
    requireDispatchPlans: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'DISPATCH_PLAN_INVALID'));
});

test('a strict plan ledger without its declared child rule is invalid evidence', () => {
  const report = runProviderReconciliation({
    ledgerText: `${JSON.stringify(event('persist'))}\n`,
    ledgerPath: 'planned.provider-requests.ndjson',
    planLedgerText: planLedger({ omitChildRule: true }),
    requireDispatchPlans: true,
    raw: raw(),
    attemptId: ATTEMPT,
    pinnedModels: PINNED
  });

  assert.equal(report.status, 'DISCREPANT');
  assert.ok(report.findings.some((finding) => finding.code === 'DISPATCH_PLAN_INVALID'));
});
