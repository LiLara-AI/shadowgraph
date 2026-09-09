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

function raw() {
  return { units: [{
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

function campaignLedger({ reservationId = 'offline-only:1', plannedDispatchId = DISPATCH } = {}) {
  const correlation = {
    runId: RUN, attemptId: ATTEMPT, armId: 'cognee', scenarioId: 'ACC_PLAN_1',
    repetition: 0, phase: 'A', requestClass: 'embedding', rootOperation: 'persist'
  };
  return [
    { event: 'policy', policy: { campaignId: 'offline-only' } },
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

test('a consumed static plan reconciles its one authorized provider event', () => {
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
