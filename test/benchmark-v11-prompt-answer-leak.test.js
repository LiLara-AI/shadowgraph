// F32: the decision model must never be shown its own prior answer to the
// question it is being asked.
//
// Run v11-acceptance-002 measured transcription, not detection. The harness
// stores each decision response verbatim as the memory record's content, the
// adapters return record content as native context, and `canonicalJson` sorts
// keys - so the rendered prompt opened with
// `{"content":{"changedFactDetected":null,...`. Every arm that retrieved
// anything copied that null: 64 units out of 64, across four memory arms and all
// four D phases. The control, which retrieves nothing and therefore saw no
// answer sheet, never did.
//
// These tests pin the prompt text itself, because that is where the defect was
// visible and where a reader can check it. Storage, the adapter protocol, the
// frozen response schema and both prompt-binding hashes are deliberately
// untouched, and the last test in this file is what says so.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';

import { buildV11Prompt, V11_OUTER_SYSTEM_PROMPT } from '../benchmark/lib/v11-prompts.mjs';
import {
  STANDARD_DECISION_RESPONSE_SCHEMA,
  validateDecisionResponse
} from '../benchmark/lib/outer-model.mjs';
import { loadV11AcceptanceDefinition } from '../benchmark/lib/v11-definition.mjs';
import { standardizedDecisionRecord } from '../benchmark/lib/v11-contract.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

// The real frozen acceptance scenario, not a hand-built one. A fixture of my own
// shape would pass the prompt boundary only by accident, and the leak this file
// is about was visible in exactly these scenarios.
async function acceptanceScenario() {
  const loaded = await loadV11AcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });
  return structuredClone(loaded.scenarios[0]);
}

/** A decision response shaped exactly as run 002 recorded them: nulls and all. */
function priorAnswer(scenario, overrides = {}) {
  return {
    decisionId: null,
    choiceId: scenario.choice.id,
    recalledAlternativeIds: scenario.alternatives.map((item) => item.id),
    recalledRejectionReasonIds: scenario.alternatives.map((item) => item.reasonId),
    constraintIdsAddressed: scenario.constraints.map((item) => item.id),
    evidenceIdsCited: scenario.evidence.map((item) => item.id),
    riskIdsRecognized: [...scenario.riskIds],
    reviewTriggerIds: [scenario.reviewTrigger.id],
    changedFactDetected: null,
    changedFactId: null,
    recommendation: 'Keep the reversible choice.',
    failedAttemptIdsAvoided: [],
    failedAttemptReasonIdsCited: [],
    memoryProjectId: scenario.projectId,
    memoryUserId: scenario.userId,
    ...overrides
  };
}

function recordFor(scenario, phase, overrides = {}) {
  return standardizedDecisionRecord(
    { armId: 'shadowgraph-full', scenarioId: scenario.id, repetition: 0, phase },
    priorAnswer(scenario, overrides)
  );
}

function promptFor(scenario, phase, nativeContext) {
  return buildV11Prompt({ phase, scenario, nativeContext }).prompt;
}

test('the D_TRUE prompt does not carry a prior changedFactDetected answer', async () => {
  const SCENARIO = await acceptanceScenario();
  const prompt = promptFor(SCENARIO, 'D_TRUE', [recordFor(SCENARIO, 'A'), recordFor(SCENARIO, 'C')]);
  assert.ok(!prompt.includes('"changedFactDetected"'),
    'the field the phase asks about must not appear pre-filled in the context');
  assert.ok(!prompt.includes('"changedFactDetected":null'));
});

test('every D_FALSE probe is equally free of a prior answer', async () => {
  const SCENARIO = await acceptanceScenario();
  for (const phase of ['D_FALSE_0', 'D_FALSE_1', 'D_FALSE_2']) {
    const prompt = promptFor(SCENARIO, phase, [recordFor(SCENARIO, 'A'), recordFor(SCENARIO, 'C')]);
    assert.ok(!prompt.includes('"changedFactDetected"'), `${phase} leaked the answer field`);
    assert.ok(!prompt.includes('"changedFactId"'), `${phase} leaked the changed-fact id`);
  }
});

test('a non-null prior answer is redacted too, not just a null one', async () => {
  const SCENARIO = await acceptanceScenario();
  // The defect is showing the model any prior answer, not showing it nulls.
  // A `true` left in context would be just as copyable, and would look like a
  // detection the arm never made this phase.
  const prompt = promptFor(SCENARIO, 'D_TRUE', [
    recordFor(SCENARIO, 'C', { changedFactDetected: true, changedFactId: 'fact-changed' })
  ]);
  assert.ok(!prompt.includes('"changedFactDetected"'));
  assert.ok(!prompt.includes('fact-changed'),
    'a prior changed-fact id must not reach the prompt either');
});

test('the prior decisionId echo is redacted while the record id survives', async () => {
  const SCENARIO = await acceptanceScenario();
  const record = recordFor(SCENARIO, 'A');
  const prompt = promptFor(SCENARIO, 'B', [record]);
  assert.ok(!prompt.includes('"decisionId"'), 'the prior echo is the null that teaches null');
  assert.ok(prompt.includes(record.id),
    'the record id is the thing Phase B is meant to be able to recall');
});

test('everything the phase is entitled to see still reaches the prompt', async () => {
  const SCENARIO = await acceptanceScenario();
  // Redaction has to be narrow. If it swallowed the recalled ids, the D phases
  // would stop measuring recall and this fix would trade one defect for another.
  const prompt = promptFor(SCENARIO, 'D_TRUE', [recordFor(SCENARIO, 'C')]);
  for (const value of [
    SCENARIO.choice.id,
    ...SCENARIO.alternatives.map((item) => item.id),
    ...SCENARIO.alternatives.map((item) => item.reasonId),
    ...SCENARIO.constraints.map((item) => item.id),
    ...SCENARIO.evidence.map((item) => item.id),
    ...SCENARIO.riskIds,
    SCENARIO.reviewTrigger.id,
    SCENARIO.projectId,
    'Keep the reversible choice.'
  ]) {
    assert.ok(prompt.includes(value), `${value} must still be visible as evidence`);
  }
});

test('a failed-attempt record passes through untouched', async () => {
  const SCENARIO = await acceptanceScenario();
  // Its content has none of the redacted fields, and nothing about it should
  // change. A redaction that reshaped every record would be too blunt.
  const failedAttempt = {
    id: 'failed-1', type: 'failed_attempt',
    content: {
      id: 'failed-1', approachId: 'approach-1',
      reasonId: 'failed-reason-1', reason: 'It was tried and it broke'
    }
  };
  const prompt = promptFor(SCENARIO, 'E', [failedAttempt]);
  assert.ok(prompt.includes('approach-1'));
  assert.ok(prompt.includes('It was tried and it broke'));
  assert.ok(prompt.includes('failed-reason-1'));
});

test('a record with no content object is passed through rather than rejected', async () => {
  const SCENARIO = await acceptanceScenario();
  const prompt = promptFor(SCENARIO, 'C', [{ id: 'opaque-1', type: 'note', text: 'native shape' }]);
  assert.ok(prompt.includes('native shape'));
});

test('Phase A is unaffected, because it retrieves nothing', async () => {
  const SCENARIO = await acceptanceScenario();
  const request = buildV11Prompt({ phase: 'A', scenario: SCENARIO, nativeContext: [] });
  assert.equal(request.system, V11_OUTER_SYSTEM_PROMPT);
  assert.deepEqual(request.responseSchema, STANDARD_DECISION_RESPONSE_SCHEMA);
});

// ---------------------------------------------------------------------------
// The frozen surfaces this fix must not have moved.
// ---------------------------------------------------------------------------

test('the fix changes neither prompt-binding hash nor the stored record', async () => {
  const SCENARIO = await acceptanceScenario();
  // `outerPromptBinding` is {systemSha256, responseSchemaSha256} over exactly
  // these two values. Redaction happens to per-unit context data, which is not
  // part of either, so a future run stays bound to the same frozen contract.
  const request = buildV11Prompt({ phase: 'C', scenario: SCENARIO, nativeContext: [recordFor(SCENARIO, 'A')] });
  assert.equal(request.system, V11_OUTER_SYSTEM_PROMPT);
  assert.deepEqual(request.responseSchema, STANDARD_DECISION_RESPONSE_SCHEMA);

  // The record itself still holds all fifteen frozen fields and still satisfies
  // the adapter protocol's decision-response validator, which requires exactly
  // those keys on both the JS and the Python side.
  const record = recordFor(SCENARIO, 'A');
  assert.deepEqual(
    Object.keys(record.content).sort(),
    Object.keys(STANDARD_DECISION_RESPONSE_SCHEMA).sort()
  );
  assert.doesNotThrow(() => validateDecisionResponse(record.content));
  assert.equal(record.content.changedFactDetected, null);
});
