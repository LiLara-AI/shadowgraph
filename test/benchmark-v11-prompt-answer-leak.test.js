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
  DECISION_RECORD_CONTENT_SCHEMA,
  STANDARD_DECISION_RESPONSE_SCHEMA,
  validateDecisionRecordContent
} from '../benchmark/lib/outer-model.mjs';
import { loadV11AcceptanceDefinition } from '../benchmark/lib/v11-definition.mjs';
import {
  DECISION_PROBE_ANSWER_FIELDS,
  standardizedDecisionRecord
} from '../benchmark/lib/v11-contract.mjs';
import { readFile } from 'node:fs/promises';

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

// ---------------------------------------------------------------------------
// Adapter-native shapes. The first version of this redaction matched the path
// `record.content.<key>`, which is what `logical_record` produces and what four
// of the seven arms return. Every other shape went straight through. These pin
// the key-based behaviour that replaced it.
// ---------------------------------------------------------------------------

const ANSWER_KEYS = ['changedFactDetected', 'changedFactId', 'decisionId'];

function leakedKeys(prompt) {
  // Escaped too: a record serialised into a string renders as \"key\".
  return ANSWER_KEYS.filter((key) => prompt.includes(`"${key}"`) || prompt.includes(`\\"${key}\\"`));
}

test('an answer field nested below content does not reach the prompt', async () => {
  const SCENARIO = await acceptanceScenario();
  const record = recordFor(SCENARIO, 'A');
  const prompt = promptFor(SCENARIO, 'D_TRUE', [
    { id: 'r1', type: 'decision', content: { inner: record.content } }
  ]);
  assert.deepEqual(leakedKeys(prompt), []);
});

test('an answer field in a sibling key of content does not reach the prompt', async () => {
  const SCENARIO = await acceptanceScenario();
  const record = recordFor(SCENARIO, 'A');
  const prompt = promptFor(SCENARIO, 'D_TRUE', [
    { id: 'r1', type: 'decision', data: record.content }
  ]);
  assert.deepEqual(leakedKeys(prompt), []);
});

test('an answer field inside an array of results does not reach the prompt', async () => {
  const SCENARIO = await acceptanceScenario();
  const record = recordFor(SCENARIO, 'A');
  const prompt = promptFor(SCENARIO, 'D_TRUE', [
    { id: 'r1', type: 'decision', results: [{ content: record.content }] }
  ]);
  assert.deepEqual(leakedKeys(prompt), []);
});

test('a record serialised into a string carries no answer fields either, F37 closed', async () => {
  // This test used to assert the opposite, and said so: "if this ever comes back
  // empty, F37 has been closed and this test should assert that instead."
  //
  // Key-based redaction cannot reach inside a string, and Cognee's retrieve
  // returns `{search_result, dataset_id, dataset_name}` with the record encoded
  // as JSON inside `search_result` - so redaction alone left one of the seven
  // required arms exposed. The fields are no longer written to a record at all
  // (`DECISION_PROBE_ANSWER_FIELDS` in `v11-contract.mjs`), so no shape and no
  // encoding can carry them. This builds the string from a real
  // `standardizedDecisionRecord`, which is what an adapter would actually have
  // to encode.
  const SCENARIO = await acceptanceScenario();
  const record = recordFor(SCENARIO, 'A');
  const prompt = promptFor(SCENARIO, 'D_TRUE', [{
    search_result: `shadowgraph-benchmark-record:v2:${JSON.stringify({ content: record.content })}`,
    dataset_id: 'd1',
    dataset_name: 'benchmark'
  }]);
  // Only the keys: D_TRUE's own public phase input legitimately names the
  // changed fact, so its id appearing in the prompt is the question, not a leak.
  assert.deepEqual(leakedKeys(prompt), []);
});

test('an adapter that invents the answer fields is still redacted, at any depth', async () => {
  // The render-time redaction remains the second line of defence: storage cannot
  // produce these fields any more, but an adapter can still fabricate them.
  const SCENARIO = await acceptanceScenario();
  const fabricated = {
    changedFactDetected: null, changedFactId: SCENARIO.changedFact.id, decisionId: null
  };
  for (const shape of [
    { id: 'r1', type: 'decision', content: fabricated },
    { id: 'r1', type: 'decision', content: { inner: fabricated } },
    { id: 'r1', type: 'decision', data: fabricated },
    { id: 'r1', type: 'decision', results: [{ content: fabricated }] }
  ]) {
    const prompt = promptFor(SCENARIO, 'D_TRUE', [shape]);
    assert.deepEqual(leakedKeys(prompt), [], `leaked from ${JSON.stringify(shape).slice(0, 60)}`);
  }
});

test('the byte cap is measured on what the adapter returned, not on the redacted text', async () => {
  // Redacted text is necessarily shorter, so capping after redaction would
  // quietly admit payloads the boundary used to reject.
  const SCENARIO = await acceptanceScenario();
  const oversized = Array.from({ length: 9 }, (_, index) => {
    const record = recordFor(SCENARIO, 'A');
    return { ...record, id: `decision:oversized-${index}`, content: { ...record.content, recommendation: 'x'.repeat(8000) } };
  });
  assert.throws(
    () => buildV11Prompt({ phase: 'D_TRUE', scenario: SCENARIO, nativeContext: oversized }),
    (error) => error.code === 'LIMIT'
  );
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

  // The record holds the response minus the three probe-answer fields, and the
  // adapter protocol's record-content validator - which is a separate contract,
  // not a loosened one - accepts exactly that and rejects the response shape.
  const record = recordFor(SCENARIO, 'A');
  assert.deepEqual(
    Object.keys(record.content).sort(),
    Object.keys(STANDARD_DECISION_RESPONSE_SCHEMA)
      .filter((field) => !['changedFactDetected', 'changedFactId', 'decisionId'].includes(field))
      .sort()
  );
  assert.doesNotThrow(() => validateDecisionRecordContent(record.content));
  assert.throws(() => validateDecisionRecordContent({ ...record.content, changedFactDetected: null }));
  for (const field of ['changedFactDetected', 'changedFactId', 'decisionId']) {
    assert.ok(!Object.hasOwn(record.content, field), `${field} must never be stored`);
  }
});

// ---------------------------------------------------------------------------
// One list, five copies. The three field names are written out independently in
// `v11-contract.mjs` (canonical), `v11-prompts.mjs`, `outer-model.mjs`,
// `envelope.py`, and in this file. They cannot be collapsed into one import
// everywhere - `v11-prompts.mjs` already imports `v11-definition.mjs`, and
// `outer-model.mjs` is imported *by* `v11-contract.mjs`, so either direction
// closes a cycle - and Python cannot import from JavaScript at all.
//
// So the agreement is asserted instead. Drift here would be silent and would
// reopen exactly the Cognee-shape hole F37 closed: one copy still redacting
// while another had stopped withholding.
// ---------------------------------------------------------------------------

test('every copy of the probe-answer field list agrees with the canonical one', async () => {
  const canonical = [...DECISION_PROBE_ANSWER_FIELDS].sort();
  assert.deepEqual(canonical, ['changedFactDetected', 'changedFactId', 'decisionId']);

  // This file's own copy.
  assert.deepEqual([...ANSWER_KEYS].sort(), canonical);

  // The record-content schema is the response schema minus exactly these.
  assert.deepEqual(
    Object.keys(STANDARD_DECISION_RESPONSE_SCHEMA)
      .filter((field) => !Object.hasOwn(DECISION_RECORD_CONTENT_SCHEMA, field))
      .sort(),
    canonical
  );

  // The render-time redaction list in v11-prompts.mjs.
  const prompts = await readFile(new URL('../benchmark/lib/v11-prompts.mjs', import.meta.url), 'utf8');
  const redacted = prompts
    .slice(prompts.indexOf('REDACTED_PRIOR_ANSWER_FIELDS = Object.freeze(['))
    .slice(0, prompts.slice(prompts.indexOf('REDACTED_PRIOR_ANSWER_FIELDS = Object.freeze([')).indexOf(']'));
  for (const field of canonical) {
    assert.ok(redacted.includes(`'${field}'`), `v11-prompts.mjs no longer redacts ${field}`);
  }
  assert.equal((redacted.match(/'/gu) ?? []).length / 2, canonical.length,
    'v11-prompts.mjs redacts a different number of fields than the canonical list');

  // And the Python side, which cannot import any of the above.
  const envelope = await readFile(new URL('../benchmark/adapters/envelope.py', import.meta.url), 'utf8');
  const python = envelope
    .slice(envelope.indexOf('DECISION_PROBE_ANSWER_FIELDS = ('))
    .slice(0, envelope.slice(envelope.indexOf('DECISION_PROBE_ANSWER_FIELDS = (')).indexOf(')'));
  for (const field of canonical) {
    assert.ok(python.includes(`"${field}"`), `envelope.py no longer withholds ${field}`);
  }
  assert.equal((python.match(/"/gu) ?? []).length / 2, canonical.length,
    'envelope.py withholds a different number of fields than the canonical list');
});
