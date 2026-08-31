import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  buildPhaseARequest,
  STANDARD_DECISION_RESPONSE_SCHEMA,
  requestOuterDecision
} from '../benchmark/lib/outer-model.mjs';
import {
  createAdapterRequest,
  validateAdapterRequest,
  validateAdapterResponse
} from '../benchmark/lib/adapter-protocol.mjs';

const RESPONSE_SCHEMA = {
  decisionId: 'string|null',
  choiceId: 'string|null',
  recalledAlternativeIds: 'string[]',
  recalledRejectionReasonIds: 'string[]',
  constraintIdsAddressed: 'string[]',
  evidenceIdsCited: 'string[]',
  riskIdsRecognized: 'string[]',
  reviewTriggerIds: 'string[]',
  changedFactDetected: 'boolean|null',
  changedFactId: 'string|null',
  recommendation: 'string',
  failedAttemptIdsAvoided: 'string[]',
  failedAttemptReasonIdsCited: 'string[]',
  memoryProjectId: 'string|null',
  memoryUserId: 'string|null'
};

const VALID_DECISION = {
  decisionId: 'decision-generated-1',
  choiceId: 'option-z',
  recalledAlternativeIds: ['option-a', 'option-m'],
  recalledRejectionReasonIds: ['reason-a', 'reason-m'],
  constraintIdsAddressed: ['constraint-a'],
  evidenceIdsCited: ['evidence-a'],
  riskIdsRecognized: ['risk-a'],
  reviewTriggerIds: ['trigger-a'],
  changedFactDetected: null,
  changedFactId: null,
  recommendation: 'Use the option that best fits the supplied evidence.',
  failedAttemptIdsAvoided: [],
  failedAttemptReasonIdsCited: [],
  memoryProjectId: 'project-a',
  memoryUserId: 'user-a'
};

const OUTER_CONFIG = {
  endpoint: 'http://127.0.0.1:11434/v1',
  apiKey: 'local-test-key',
  model: 'frozen-model',
  seed: 42,
  temperature: 0,
  maxOutputTokens: 900,
  timeoutMs: 5_000
};

const OUTER_CORRELATION = {
  runId: 'run-1',
  attemptId: 'attempt-1',
  armId: 'shadowgraph-full',
  scenarioId: 'S01_DATABASE',
  repetition: 0,
  phase: 'A',
  requestClass: 'outer_decision_llm'
};

const ADAPTER_CORRELATION = {
  runId: 'run-1',
  attemptId: 'attempt-1',
  phase: 'A',
  armId: 'shadowgraph-full',
  scenarioId: 'S01_DATABASE',
  repetition: 0
};

const NAMESPACE = { projectId: 'project-a', userId: null };

function retrievalPayload(task = 'persistence option') {
  return { query: { scenarioId: ADAPTER_CORRELATION.scenarioId, task } };
}

function phaseAScenario() {
  return {
    id: 'S01_DATABASE',
    projectId: 'project-a',
    userId: 'user-a',
    task: 'Choose a persistence option.',
    choice: { id: 'option-z', label: 'Zeta store' },
    alternatives: [
      { id: 'option-m', label: 'Middle store', reasonId: 'reason-m', reason: 'Middle reason text' },
      { id: 'option-a', label: 'Alpha store', reasonId: 'reason-a', reason: 'Alpha reason text' }
    ],
    constraints: [{ id: 'constraint-a', text: 'Constraint text' }],
    assumptionIds: ['assumption-id-only'],
    assumptions: [{ id: 'assumption-with-text', text: 'Assumption text' }],
    evidence: [{ id: 'evidence-a', text: 'Evidence text' }],
    riskIds: ['risk-id-only'],
    risks: [{ id: 'risk-with-text', text: 'Risk text' }],
    reviewTrigger: {
      id: 'trigger-a',
      key: 'concurrentUsers',
      operator: 'greaterThan',
      value: 10
    },
    expectedAnswer: { marker: 'HIDDEN_EXPECTED_ANSWER_TRAP' },
    scoring: { marker: 'HIDDEN_SCORING_TRAP' },
    advertisedSchemas: { marker: 'HIDDEN_SCHEMA_ECONOMICS_TRAP' },
    changedFact: { marker: 'HIDDEN_CHANGED_FACT_TRAP' },
    failedAttempt: { marker: 'HIDDEN_FAILED_ATTEMPT_TRAP' }
  };
}

function outerRequest() {
  return {
    system: 'Return one JSON object only.',
    prompt: 'Use the supplied decision inputs.',
    responseSchema: RESPONSE_SCHEMA
  };
}

function providerResponse(options = {}) {
  const decision = options.decision ?? VALID_DECISION;
  const usage = Object.hasOwn(options, 'usage')
    ? options.usage
    : { prompt_tokens: 101, completion_tokens: 37, total_tokens: 138 };
  const payload = {
    id: 'chatcmpl-local-1',
    object: 'chat.completion',
    created: 1,
    model: 'provider-reported-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: JSON.stringify(decision) },
      finish_reason: 'stop'
    }]
  };
  if (usage !== undefined) payload.usage = usage;
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function validAdapterEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: 'retrieve',
    runId: 'run-1',
    attemptId: 'attempt-1',
    phase: 'A',
    armId: 'shadowgraph-full',
    scenarioId: 'S01_DATABASE',
    repetition: 0,
    status: 'SUCCEEDED',
    result: {
      nativeContext: [],
      persistenceEvidence: null,
      isolationEvidence: null
    },
    failure: null,
    operations: {
      memoryReadOperations: 1,
      memoryWriteOperations: 0,
      mcpToolCalls: 1,
      outerDecisionModelCalls: 0,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 0
    },
    storage: {
      status: 'MEASURED',
      bytes: 512,
      scope: 'isolated project directory',
      method: 'recursive file bytes',
      reason: null,
      blockedClaims: []
    },
    ...overrides
  };
}

test('Phase A prompt exposes every allowed decision input without fixture truth or schema economics', () => {
  const request = buildPhaseARequest({
    scenario: phaseAScenario(),
    system: 'Common system prompt.',
    responseSchema: RESPONSE_SCHEMA
  });

  assert.equal(request.system, 'Common system prompt.');
  assert.deepEqual(request.responseSchema, RESPONSE_SCHEMA);
  assert.ok(request.prompt.includes('Candidate options: [{"id":"option-a","text":"Alpha store"},{"id":"option-m","text":"Middle store"},{"id":"option-z","text":"Zeta store"}]'));
  assert.ok(request.prompt.includes('Rejection reasons: [{"id":"reason-a","optionId":"option-a","text":"Alpha reason text"},{"id":"reason-m","optionId":"option-m","text":"Middle reason text"}]'));
  for (const visible of [
    'S01_DATABASE', 'project-a', 'user-a', 'Choose a persistence option.',
    'constraint-a', 'Constraint text',
    'assumption-id-only', 'assumption-with-text', 'Assumption text',
    'evidence-a', 'Evidence text',
    'risk-id-only', 'risk-with-text', 'Risk text',
    'trigger-a', 'concurrentUsers', 'greaterThan', '10'
  ]) assert.ok(request.prompt.includes(visible), `missing Phase A input: ${visible}`);

  for (const hidden of [
    'HIDDEN_EXPECTED_ANSWER_TRAP',
    'HIDDEN_SCORING_TRAP',
    'HIDDEN_SCHEMA_ECONOMICS_TRAP',
    'HIDDEN_CHANGED_FACT_TRAP',
    'HIDDEN_FAILED_ATTEMPT_TRAP'
  ]) assert.ok(!request.prompt.includes(hidden), `leaked hidden fixture input: ${hidden}`);
  assert.doesNotMatch(request.prompt, /(?:selected|preferred|correct|ground.?truth|expected answer|advertised schema|token economics)/iu);
});

test('the decision response schema is fixed to the frozen preregistration contract', async () => {
  const preregistration = JSON.parse(await readFile(
    new URL('../benchmark/preregistration.json', import.meta.url),
    'utf8'
  ));
  assert.deepEqual(STANDARD_DECISION_RESPONSE_SCHEMA, preregistration.promptProtocol.responseSchema);
  assert.deepEqual(STANDARD_DECISION_RESPONSE_SCHEMA, RESPONSE_SCHEMA);
  assert.throws(
    () => buildPhaseARequest({
      scenario: phaseAScenario(),
      system: 'Common system prompt.',
      responseSchema: { ...RESPONSE_SCHEMA, expectedChoiceId: 'string' }
    }),
    /responseSchema.*field/i
  );
});

test('outer decision request uses one fixed OpenAI-compatible request and preserves provider usage exactly', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return providerResponse();
  };

  const result = await requestOuterDecision({
    fetchImpl,
    config: OUTER_CONFIG,
    correlation: OUTER_CORRELATION,
    request: outerRequest()
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer local-test-key');
  assert.equal(calls[0].options.headers['x-shadowgraph-run-id'], 'run-1');
  assert.equal(calls[0].options.headers['x-shadowgraph-attempt-id'], 'attempt-1');
  assert.equal(calls[0].options.headers['x-shadowgraph-arm-id'], 'shadowgraph-full');
  assert.equal(calls[0].options.headers['x-shadowgraph-scenario-id'], 'S01_DATABASE');
  assert.equal(calls[0].options.headers['x-shadowgraph-repetition'], '0');
  assert.equal(calls[0].options.headers['x-shadowgraph-phase'], 'A');
  assert.equal(calls[0].options.headers['x-shadowgraph-request-class'], 'outer_decision_llm');
  assert.ok(calls[0].options.signal instanceof AbortSignal);

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'frozen-model');
  assert.equal(body.seed, 42);
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 900);
  assert.equal(body.n, 1);
  assert.equal(body.stream, false);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.messages[0], { role: 'system', content: 'Return one JSON object only.' });
  assert.match(body.messages[1].content, /Use the supplied decision inputs\./u);
  assert.match(body.messages[1].content, /"decisionId":"string\|null"/u);

  assert.deepEqual(result, {
    decision: VALID_DECISION,
    usage: { prompt_tokens: 101, completion_tokens: 37, total_tokens: 138 },
    providerModel: 'provider-reported-model',
    requestCount: 1,
    correlation: OUTER_CORRELATION
  });
});

test('outer decision request records unavailable provider usage as null without estimating it', async () => {
  const result = await requestOuterDecision({
    fetchImpl: async () => providerResponse({ usage: undefined }),
    config: OUTER_CONFIG,
    correlation: OUTER_CORRELATION,
    request: outerRequest()
  });
  assert.equal(result.usage, null);
});

test('outer decision request performs zero retries after an HTTP failure', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response('{"error":"rate limited"}', { status: 429 });
  };

  await assert.rejects(
    requestOuterDecision({ fetchImpl, config: OUTER_CONFIG, correlation: OUTER_CORRELATION, request: outerRequest() }),
    /HTTP 429/u
  );
  assert.equal(calls, 1);
});

test('outer decision timeout remains active while the provider response body is read', async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      text: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      })
    };
  };
  const pending = requestOuterDecision({
    fetchImpl,
    config: { ...OUTER_CONFIG, timeoutMs: 10 },
    correlation: OUTER_CORRELATION,
    request: outerRequest()
  });
  const outcome = await Promise.race([
    pending.then(() => 'resolved', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('still-pending'), 80))
  ]);

  assert.equal(outcome, 'rejected');
  assert.equal(calls, 1);
});

test('outer decision request rejects fenced, missing, extra, and mistyped decision JSON without filling fields', async () => {
  const cases = [
    `\`\`\`json\n${JSON.stringify(VALID_DECISION)}\n\`\`\``,
    JSON.stringify(Object.fromEntries(Object.entries(VALID_DECISION).filter(([key]) => key !== 'recommendation'))),
    JSON.stringify({ ...VALID_DECISION, expectedChoiceId: 'option-z' }),
    JSON.stringify({ ...VALID_DECISION, changedFactDetected: 'false' }),
    JSON.stringify({ ...VALID_DECISION, riskIdsRecognized: ['risk-a', 7] })
  ];

  for (const content of cases) {
    const fetchImpl = async () => new Response(JSON.stringify({
      model: 'provider-reported-model',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', index: 0 }]
    }), { status: 200 });
    await assert.rejects(
      requestOuterDecision({ fetchImpl, config: OUTER_CONFIG, correlation: OUTER_CORRELATION, request: outerRequest() })
    );
  }
});

test('outer decision request validates all frozen controls and correlation before network I/O', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return providerResponse();
  };
  const invalidInputs = [
    { config: { ...OUTER_CONFIG, model: '' }, correlation: OUTER_CORRELATION },
    { config: { ...OUTER_CONFIG, temperature: -0.1 }, correlation: OUTER_CORRELATION },
    { config: { ...OUTER_CONFIG, maxOutputTokens: 0 }, correlation: OUTER_CORRELATION },
    { config: { ...OUTER_CONFIG, timeoutMs: 0 }, correlation: OUTER_CORRELATION },
    { config: OUTER_CONFIG, correlation: { ...OUTER_CORRELATION, requestClass: 'internal_memory_llm' } },
    { config: OUTER_CONFIG, correlation: { ...OUTER_CORRELATION, runId: 'run-1\r\ninjected: yes' } }
  ];

  for (const input of invalidInputs) {
    await assert.rejects(requestOuterDecision({ fetchImpl, ...input, request: outerRequest() }));
  }
  assert.equal(calls, 0);
});

test('adapter request protocol accepts only the four operation-specific memory payloads', () => {
  const requests = [
    createAdapterRequest({ operation: 'reset', correlation: ADAPTER_CORRELATION, namespace: NAMESPACE, payload: {} }),
    createAdapterRequest({ operation: 'retrieve', correlation: ADAPTER_CORRELATION, namespace: NAMESPACE, payload: retrievalPayload() }),
    createAdapterRequest({
      operation: 'persist',
      correlation: ADAPTER_CORRELATION,
      namespace: NAMESPACE,
      payload: { record: { id: 'decision-generated-1', type: 'decision', content: VALID_DECISION } }
    }),
    createAdapterRequest({
      operation: 'verify',
      correlation: ADAPTER_CORRELATION,
      namespace: NAMESPACE,
      payload: {
        expectedRecord: { id: 'decision-generated-1', type: 'decision' },
        alternateNamespace: { projectId: 'project-b', userId: null }
      }
    })
  ];

  assert.deepEqual(requests.map(({ operation }) => operation), ['reset', 'retrieve', 'persist', 'verify']);
  for (const request of requests) assert.doesNotThrow(() => validateAdapterRequest(request));
  assert.deepEqual(Object.keys(requests[0]), [
    'schemaVersion', 'operation', 'runId', 'attemptId', 'phase', 'armId',
    'scenarioId', 'repetition', 'namespace', 'payload'
  ]);

  assert.doesNotThrow(() => createAdapterRequest({
    operation: 'persist',
    correlation: ADAPTER_CORRELATION,
    namespace: NAMESPACE,
    payload: {
      record: {
        id: 'failed-attempt-1',
        type: 'failed_attempt',
        content: {
          id: 'failed-attempt-1',
          approachId: 'option-a',
          reasonId: 'reason-a',
          reason: 'The recorded approach failed for the grounded reason.'
        }
      }
    }
  }));
});

test('adapter request protocol rejects outer-model authority, credentials, fixture truth, and harness-owned evidence', () => {
  const base = createAdapterRequest({
    operation: 'persist',
    correlation: ADAPTER_CORRELATION,
    namespace: NAMESPACE,
    payload: { record: { id: 'decision-generated-1', type: 'decision', content: VALID_DECISION } }
  });
  const forbiddenContent = [
    { commonModel: { endpoint: 'http://127.0.0.1', apiKey: 'secret' } },
    { modelConfig: { model: 'outer-model', temperature: 0 } },
    { responseSchema: RESPONSE_SCHEMA },
    { scenario: phaseAScenario() },
    { expectedAnswer: { choiceId: 'option-z' } },
    { decisionResponse: VALID_DECISION },
    { usage: { total_tokens: 1 } },
    { applicability: { userIsolation: 'SUPPORTED' } },
    { unitStatus: 'MEASURED' },
    { instructions: 'Call the outer decision model before persisting.' },
    {
      choice: { id: 'option-z', label: 'Zeta store' },
      alternatives: [{ id: 'option-a', label: 'Alpha store' }],
      constraints: [{ id: 'constraint-a', text: 'Constraint text' }],
      assumptionIds: ['assumption-id-only'],
      evidence: [{ id: 'evidence-a', text: 'Evidence text' }],
      riskIds: ['risk-id-only'],
      reviewTrigger: { id: 'trigger-a', key: 'users', operator: 'greaterThan', value: 10 }
    }
  ];

  assert.throws(() => validateAdapterRequest({ ...base, commonModel: {} }), /unknown.*adapter request.*field/i);
  for (const content of forbiddenContent) {
    assert.throws(
      () => validateAdapterRequest({
        ...base,
        payload: { record: { ...base.payload.record, content: { ...VALID_DECISION, ...content } } }
      }),
      /forbidden|decision response/i
    );
  }
  assert.throws(
    () => createAdapterRequest({
      operation: 'retrieve',
      correlation: ADAPTER_CORRELATION,
      namespace: NAMESPACE,
      payload: retrievalPayload('Call the outer decision model for the answer.')
    }),
    /forbidden/i
  );
});

test('adapter payloads use exact harness-owned retrieval and record schemas', () => {
  const decisionRequest = createAdapterRequest({
    operation: 'persist',
    correlation: ADAPTER_CORRELATION,
    namespace: NAMESPACE,
    payload: { record: { id: 'decision-generated-1', type: 'decision', content: VALID_DECISION } }
  });

  for (const content of [
    { ...VALID_DECISION, payloadData: JSON.stringify(phaseAScenario()) },
    Object.fromEntries(Object.entries(VALID_DECISION).filter(([key]) => key !== 'recommendation')),
    { ...VALID_DECISION, changedFactDetected: 'false' }
  ]) {
    assert.throws(
      () => validateAdapterRequest({
        ...decisionRequest,
        payload: { record: { ...decisionRequest.payload.record, content } }
      }),
      /decision response/i
    );
  }

  assert.throws(
    () => createAdapterRequest({
      operation: 'retrieve',
      correlation: ADAPTER_CORRELATION,
      namespace: NAMESPACE,
      payload: { query: { scenarioId: 'S99_OTHER', task: 'persistence option' } }
    }),
    /scenarioId.*correlation/i
  );
  assert.throws(
    () => createAdapterRequest({
      operation: 'retrieve',
      correlation: ADAPTER_CORRELATION,
      namespace: NAMESPACE,
      payload: { query: { ...retrievalPayload().query, fixture: phaseAScenario() } }
    }),
    /retrieve payload.query.*field/i
  );
  assert.throws(
    () => createAdapterRequest({
      operation: 'retrieve',
      correlation: ADAPTER_CORRELATION,
      namespace: NAMESPACE,
      payload: retrievalPayload(JSON.stringify(phaseAScenario()))
    }),
    /task.*plain text/i
  );
});

test('adapter response validation requires exact request correlation and the v1.1 response envelope', () => {
  const request = createAdapterRequest({
    operation: 'retrieve',
    correlation: ADAPTER_CORRELATION,
    namespace: NAMESPACE,
    payload: retrievalPayload()
  });
  const response = validAdapterEnvelope();

  assert.doesNotThrow(() => validateAdapterResponse({ request, response }));
  assert.throws(
    () => validateAdapterResponse({ request, response: { ...response, attemptId: 'attempt-other' } }),
    /correlation.*attemptId/i
  );
  assert.throws(
    () => validateAdapterResponse({
      request,
      response: {
        ...response,
        operations: { ...response.operations, outerDecisionModelCalls: 1 }
      }
    }),
    /outerDecisionModelCalls.*zero/i
  );
});

test('adapter verification response must prove the exact requested record and namespaces', () => {
  const request = createAdapterRequest({
    operation: 'verify',
    correlation: ADAPTER_CORRELATION,
    namespace: NAMESPACE,
    payload: {
      expectedRecord: { id: 'decision-generated-1', type: 'decision' },
      alternateNamespace: { projectId: 'project-b', userId: null }
    }
  });
  const result = {
    nativeContext: [],
    persistenceEvidence: {
      verified: true,
      expectedRecord: { id: 'decision-generated-1', type: 'decision' },
      matchedRecordIds: ['decision-generated-1'],
      namespace: NAMESPACE
    },
    isolationEvidence: {
      verified: true,
      alternateNamespace: { projectId: 'project-b', userId: null },
      leakedRecordIds: []
    }
  };
  const response = validAdapterEnvelope({ operation: 'verify', result });
  assert.doesNotThrow(() => validateAdapterResponse({ request, response }));

  assert.throws(
    () => validateAdapterResponse({
      request,
      response: {
        ...response,
        result: {
          ...result,
          persistenceEvidence: {
            ...result.persistenceEvidence,
            namespace: { projectId: 'project-other', userId: null }
          }
        }
      }
    }),
    /requested namespace/i
  );
  assert.throws(
    () => validateAdapterResponse({
      request,
      response: {
        ...response,
        result: {
          ...result,
          persistenceEvidence: {
            ...result.persistenceEvidence,
            expectedRecord: { id: 'decision-other', type: 'decision' },
            matchedRecordIds: ['decision-other']
          }
        }
      }
    }),
    /requested record/i
  );
  assert.throws(
    () => validateAdapterResponse({
      request,
      response: {
        ...response,
        result: {
          ...result,
          persistenceEvidence: {
            ...result.persistenceEvidence,
            verified: false,
            matchedRecordIds: []
          }
        }
      }
    }),
    /persistence.*verified/i
  );
  assert.throws(
    () => validateAdapterResponse({
      request,
      response: {
        ...response,
        result: {
          ...result,
          isolationEvidence: {
            ...result.isolationEvidence,
            verified: false,
            leakedRecordIds: ['decision-generated-1']
          }
        }
      }
    }),
    /isolation.*verified/i
  );
});

test('adapter verification preserves honest failed and not-applicable responses without invented evidence', () => {
  const request = createAdapterRequest({
    operation: 'verify',
    correlation: ADAPTER_CORRELATION,
    namespace: NAMESPACE,
    payload: {
      expectedRecord: { id: 'decision-generated-1', type: 'decision' },
      alternateNamespace: { projectId: 'project-b', userId: null }
    }
  });
  const emptyResult = {
    nativeContext: [],
    persistenceEvidence: null,
    isolationEvidence: null
  };

  const failed = validAdapterEnvelope({
    operation: 'verify',
    status: 'FAILED',
    result: emptyResult,
    failure: { cause: 'OPERATION_FAILED', message: 'Native verification failed' }
  });
  assert.doesNotThrow(() => validateAdapterResponse({ request, response: failed }));

  const notApplicable = validAdapterEnvelope({
    operation: 'verify',
    status: 'NOT_APPLICABLE',
    result: emptyResult,
    failure: null
  });
  assert.doesNotThrow(() => validateAdapterResponse({ request, response: notApplicable }));

  assert.throws(
    () => validateAdapterResponse({
      request,
      response: {
        ...notApplicable,
        result: { ...emptyResult, nativeContext: [{ id: 'invented-record' }] }
      }
    }),
    /NOT_APPLICABLE.*empty/i
  );

  const fullyVerifiedFailure = validAdapterEnvelope({
    operation: 'verify',
    status: 'FAILED',
    result: {
      nativeContext: [],
      persistenceEvidence: {
        verified: true,
        expectedRecord: { id: 'decision-generated-1', type: 'decision' },
        matchedRecordIds: ['decision-generated-1'],
        namespace: NAMESPACE
      },
      isolationEvidence: {
        verified: true,
        alternateNamespace: { projectId: 'project-b', userId: null },
        leakedRecordIds: []
      }
    },
    failure: { cause: 'OPERATION_FAILED', message: 'Contradictory failure' }
  });
  assert.throws(
    () => validateAdapterResponse({ request, response: fullyVerifiedFailure }),
    /FAILED.*successful verification/i
  );

  const partialFailure = {
    ...fullyVerifiedFailure,
    result: {
      ...fullyVerifiedFailure.result,
      isolationEvidence: {
        ...fullyVerifiedFailure.result.isolationEvidence,
        verified: false,
        leakedRecordIds: ['decision-generated-1']
      }
    }
  };
  assert.doesNotThrow(() => validateAdapterResponse({ request, response: partialFailure }));
});

test('adapter request protocol rejects unsupported operations, malformed namespaces, and extra correlation fields', () => {
  assert.throws(
    () => createAdapterRequest({ operation: 'decide', correlation: ADAPTER_CORRELATION, namespace: NAMESPACE, payload: {} }),
    /operation/i
  );
  assert.throws(
    () => createAdapterRequest({
      operation: 'reset',
      correlation: ADAPTER_CORRELATION,
      namespace: { ...NAMESPACE, syntheticUserDirectory: 'user-a' },
      payload: {}
    }),
    /namespace.*field/i
  );
  assert.throws(
    () => createAdapterRequest({
      operation: 'reset',
      correlation: { ...ADAPTER_CORRELATION, seed: 42 },
      namespace: NAMESPACE,
      payload: {}
    }),
    /correlation.*field/i
  );
});
