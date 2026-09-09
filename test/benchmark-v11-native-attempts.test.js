import assert from 'node:assert/strict';
import test from 'node:test';

import { traceNativeAttempts } from '../benchmark/lib/v11-native-attempts.mjs';

const MODELS = Object.freeze({
  outer_decision_llm: 'qwen2.5:7b',
  internal_memory_llm: 'qwen2.5:7b',
  embedding: 'nomic-embed-text:v1.5'
});

function event(requestNumber, overrides = {}) {
  return {
    requestNumber,
    runId: 'run-native-trace-1',
    attemptId: 'attempt-native-trace-1',
    armId: 'cognee',
    scenarioId: 'ACC_TRACE_1',
    repetition: 0,
    phase: 'A',
    rootOperation: 'persist',
    requestClass: 'internal_memory_llm',
    requestedModel: MODELS.internal_memory_llm,
    providerModel: MODELS.internal_memory_llm,
    responseFormat: 'json_object',
    outcome: 'SUCCEEDED',
    ...overrides
  };
}

function policy() {
  return {
    schema: 'shadowgraph.v11.native-attempt-policy',
    version: 1,
    maxAttemptsPerRootRequestClass: 3,
    arms: [{
      armId: 'cognee',
      recovery: {
        outer_decision_llm: [],
        internal_memory_llm: ['B', 'C'],
        embedding: ['B']
      }
    }]
  };
}

test('a failed event with a non-null wrong provider model remains a fallback discrepancy', () => {
  const result = traceNativeAttempts({
    events: [
      event(1, {
        requestClass: 'embedding',
        responseFormat: null,
        requestedModel: MODELS.embedding,
        providerModel: 'unapproved-embedding-model',
        outcome: 'FAILED'
      }),
      event(2, {
        requestClass: 'embedding',
        responseFormat: null,
        requestedModel: MODELS.embedding,
        providerModel: MODELS.embedding
      })
    ],
    expectedModels: MODELS,
    policy: policy()
  });

  assert.equal(result.status, 'DISCREPANT');
  assert.ok(result.findings.some((finding) => finding.code === 'MODEL_OR_PROVIDER_FALLBACK'));
  assert.equal(result.trace[0].category, 'E');
});

test('a successful event without the pinned provider model remains a fallback discrepancy', () => {
  const result = traceNativeAttempts({
    events: [event(1, {
      requestClass: 'embedding',
      responseFormat: null,
      requestedModel: MODELS.embedding,
      providerModel: null,
      outcome: 'SUCCEEDED'
    })],
    expectedModels: MODELS,
    policy: policy()
  });

  assert.equal(result.status, 'DISCREPANT');
  assert.ok(result.findings.some((finding) => finding.code === 'MODEL_OR_PROVIDER_FALLBACK'));
  assert.equal(result.trace[0].category, 'E');
});

test('a B entry names the failed wire attempt it resolves', () => {
  const result = traceNativeAttempts({
    events: [
      event(1, { requestClass: 'embedding', responseFormat: null, requestedModel: MODELS.embedding, providerModel: MODELS.embedding, outcome: 'FAILED' }),
      event(2, { requestClass: 'embedding', responseFormat: null, requestedModel: MODELS.embedding, providerModel: MODELS.embedding })
    ],
    expectedModels: MODELS,
    policy: policy()
  });

  assert.equal(result.status, 'RECONCILED');
  assert.equal(result.trace[1].category, 'B');
  assert.equal(result.trace[1].priorRequestNumber, 1);
});

test('same-mode successful native follow-up is C only when the arm-neutral policy permits C', () => {
  const result = traceNativeAttempts({
    events: [event(1), event(2)],
    expectedModels: MODELS,
    policy: policy()
  });

  assert.equal(result.status, 'RECONCILED');
  assert.deepEqual(result.trace.map((entry) => entry.category), ['INITIAL', 'C']);
  assert.deepEqual(result.findings, []);
});

test('distinct planned dispatches under one root are independent INITIAL work', () => {
  const result = traceNativeAttempts({
    requireDispatchPlans: true,
    events: [
      event(1, { rootInvocationId: 'root-persist-1', plannedDispatchId: 'a'.repeat(48) }),
      event(2, { rootInvocationId: 'root-persist-1', plannedDispatchId: 'b'.repeat(48) })
    ],
    expectedModels: MODELS,
    policy: policy()
  });

  assert.equal(result.status, 'RECONCILED');
  assert.deepEqual(result.trace.map((entry) => entry.category), ['INITIAL', 'INITIAL']);
  assert.deepEqual(result.findings, []);
});

test('same planned dispatch retains its B/C/D lineage', () => {
  const result = traceNativeAttempts({
    requireDispatchPlans: true,
    events: [
      event(1, { rootInvocationId: 'root-persist-1', plannedDispatchId: 'c'.repeat(48) }),
      event(2, { rootInvocationId: 'root-persist-1', plannedDispatchId: 'c'.repeat(48) })
    ],
    expectedModels: MODELS,
    policy: policy()
  });

  assert.equal(result.status, 'RECONCILED');
  assert.deepEqual(result.trace.map((entry) => entry.category), ['INITIAL', 'C']);
  assert.deepEqual(result.findings, []);
});

test('distinct planned dispatches cannot reset the aggregate root class cap', () => {
  const bounded = policy();
  bounded.maxAttemptsPerRootRequestClass = 2;
  const result = traceNativeAttempts({
    requireDispatchPlans: true,
    events: [
      event(1, { rootInvocationId: 'root-persist-1', plannedDispatchId: 'd'.repeat(48) }),
      event(2, { rootInvocationId: 'root-persist-1', plannedDispatchId: 'e'.repeat(48) }),
      event(3, { rootInvocationId: 'root-persist-1', plannedDispatchId: 'f'.repeat(48) })
    ],
    expectedModels: MODELS,
    policy: bounded
  });

  assert.equal(result.status, 'DISCREPANT');
  assert.deepEqual(result.trace.map((entry) => entry.category), ['INITIAL', 'INITIAL', 'INITIAL']);
  assert.deepEqual(result.findings, [{ code: 'ROOT_CLASS_ATTEMPT_CAP_EXCEEDED', requestNumber: 3 }]);
});
