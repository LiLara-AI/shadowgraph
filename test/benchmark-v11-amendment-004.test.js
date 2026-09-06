// Amendment 004: the `decisionId` semantics F31 said were missing.
//
// The frozen response schema asks for `decisionId` and types it `string|null`,
// and a decision record's id is present in adapter-native context - but nothing
// in the frozen prompt contract said what the field was for. A model returning
// `null` had complied with everything it was told, so
// `scoring.decisionRetrievalAccuracy`, which requires a non-empty id, scored 0
// for every arm however well it recalled. Run v11-acceptance-002 measured that
// exactly: `null` x152, the invented placeholder `'D001'` x28 (every one in a
// unit with no context to copy from), and a real `decision:<hex>` x4.
//
// These tests pin the three things that make the amendment trustworthy: it says
// what it does, the code does what it says, and it does not quietly do anything
// else. In particular they pin that no scoring rule and no response schema
// moved, because an amendment that edits the rule so existing data passes is the
// failure this methodology exists to prevent.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../benchmark/lib/v11-contract.mjs';
import { STANDARD_DECISION_RESPONSE_SCHEMA } from '../benchmark/lib/outer-model.mjs';
import { loadV11AcceptanceDefinition } from '../benchmark/lib/v11-definition.mjs';
import { V11_OUTER_SYSTEM_PROMPT, buildV11Prompt } from '../benchmark/lib/v11-prompts.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AMENDMENT_PATH = new URL('../benchmark/preregistration-amendment-004.json', import.meta.url);

async function amendment() {
  return JSON.parse(await readFile(AMENDMENT_PATH, 'utf8'));
}

// The runner's own digest, verbatim from v11-runner.mjs.
function domainDigest(domain, value) {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

test('the amendment file matches its sidecar', async () => {
  const bytes = await readFile(AMENDMENT_PATH);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const sidecar = await readFile(
    new URL('../benchmark/preregistration-amendment-004.sha256', import.meta.url), 'utf8'
  );
  assert.equal(sidecar.trim().split(/\s+/u)[0], digest);
});

test('the implementation lock governs the amendment and its sidecar', async () => {
  // This is what makes the amendment tamper-evident. It is deliberately not a
  // fifth source hash in the run record: what Amendment 004 changes is the
  // prompt contract, and every raw run already records the contract it executed
  // under as `outerPromptBinding`, so a run stays attributable without one.
  const source = await readFile(
    new URL('../benchmark/lib/implementation-lock.mjs', import.meta.url), 'utf8'
  );
  for (const role of ['amendment_004', 'amendment_004_sidecar']) {
    assert.ok(source.includes(`'${role}'`), `the lock does not declare the role ${role}`);
  }
  assert.ok(source.includes("value: 'benchmark/preregistration-amendment-004.json'"));
  assert.ok(source.includes("value: 'benchmark/preregistration-amendment-004.sha256'"));
});

test('the amendment supersedes exactly the frozen bytes on disk', async () => {
  const document = await amendment();
  assert.equal(document.amendmentId, 'amendment-004');
  assert.equal(document.status, 'AUTHORIZED_FOR_NON_SCORED_V1_1_ACCEPTANCE');
  const digestOf = async (name) => createHash('sha256')
    .update(await readFile(new URL(`../benchmark/${name}`, import.meta.url)))
    .digest('hex');
  assert.equal(document.supersedes.preregistrationSha256, await digestOf('preregistration.json'));
  assert.equal(document.supersedes.amendment001Sha256, await digestOf('preregistration-amendment-001.json'));
  assert.equal(document.supersedes.amendment002Sha256, await digestOf('preregistration-amendment-002.json'));
  assert.equal(document.supersedes.amendment003Sha256, await digestOf('preregistration-amendment-003.json'));
});

test('the sentence the amendment declares is the sentence the model receives', async () => {
  // The document/code agreement lives here rather than inside the definition
  // loader: `v11-prompts.mjs` already imports `v11-definition.mjs`, so checking
  // it there would close an import cycle and leave the constant undefined.
  const { promptContractCorrection } = await amendment();
  assert.ok(V11_OUTER_SYSTEM_PROMPT.includes(promptContractCorrection.addedSentence),
    'the outer system instruction must contain exactly the sentence the amendment authorises');
});

test('every arm and every measured phase receives the same instruction', async () => {
  const loaded = await loadV11AcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });
  const scenario = structuredClone(loaded.scenarios[0]);
  const phases = ['A', 'B', 'C', 'D_TRUE', 'D_FALSE_0', 'D_FALSE_1', 'D_FALSE_2', 'E',
    'ISOLATION_PROJECT', 'ISOLATION_USER'];
  for (const phase of phases) {
    const request = buildV11Prompt({ phase, scenario, nativeContext: [] });
    assert.equal(request.system, V11_OUTER_SYSTEM_PROMPT, `${phase} received a different instruction`);
  }
});

test('the instruction exposes no expected answer and no fixture identifier', async () => {
  const loaded = await loadV11AcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });
  // Nothing scenario-specific may appear in an instruction every scenario shares.
  for (const scenario of loaded.scenarios) {
    const forbidden = [
      scenario.id,
      scenario.choice.id,
      scenario.changedFact.id,
      scenario.failedAttempt.id,
      scenario.projectId,
      scenario.userId,
      ...scenario.alternatives.map((item) => item.id),
      ...scenario.irrelevantFacts.map((item) => item.id)
    ];
    for (const value of forbidden) {
      assert.ok(!V11_OUTER_SYSTEM_PROMPT.includes(value),
        `the common instruction leaks the fixture identifier ${value}`);
    }
  }
  // And nothing arm-specific, which would make the task easier for one arm.
  for (const armId of ['no-memory', 'shadowgraph-full', 'shadowgraph-compact',
    'mem0-oss', 'basic-memory', 'cognee', 'graphiti']) {
    assert.ok(!V11_OUTER_SYSTEM_PROMPT.includes(armId),
      `the common instruction names the arm ${armId}`);
  }
});

test('the amendment changes no scoring rule and no response schema', async () => {
  const document = await amendment();
  assert.equal(document.invariants.scoringRulesChanged, false);
  assert.equal(document.invariants.responseSchemaChanged, false);
  assert.equal(document.invariants.applicabilityMatrixChanged, false);
  assert.equal(document.invariants.scored, false);
  assert.equal(document.invariants.comparativeClaimsEnabled, false);

  // And the claim is true of the tree, not only of the document: the schema is
  // still byte-identical to the one frozen in the preregistration.
  const preregistration = JSON.parse(
    await readFile(new URL('../benchmark/preregistration.json', import.meta.url), 'utf8')
  );
  assert.deepEqual(preregistration.promptProtocol.responseSchema, { ...STANDARD_DECISION_RESPONSE_SCHEMA });
  assert.equal(
    domainDigest('shadowgraph:v1.1:outer-schema:v1', STANDARD_DECISION_RESPONSE_SCHEMA),
    document.promptBindingEffect.priorResponseSchemaSha256,
    'the response schema digest must not have moved'
  );
});

test('the amendment is prospective: it records the binding change and forbids rescoring', async () => {
  const document = await amendment();
  assert.equal(document.retrospectiveEffect.rescoreExistingRuns, false);
  assert.equal(document.retrospectiveEffect.appliesToRunsStartedBefore, false);
  assert.equal(document.promptBindingEffect.systemSha256Changes, true);
  assert.equal(document.promptBindingEffect.responseSchemaSha256Changes, false);

  // The system digest really did move, and away from exactly the value run
  // v11-acceptance-002 recorded. A reader can therefore always tell which
  // contract a run executed under, from the run's own artifact.
  const current = domainDigest('shadowgraph:v1.1:outer-system:v1', V11_OUTER_SYSTEM_PROMPT);
  assert.notEqual(current, document.promptBindingEffect.priorSystemSha256);
  assert.equal(document.promptBindingEffect.priorSystemSha256,
    '24010602c784bbb015997f859a0819ef41b0a872a0addd087ad69d8ca84d8065');
});

test('the three frozen sources the amendment supersedes are themselves unchanged', async () => {
  // Amendment 004 adds a sentence to the prompt. It must not have moved anything
  // it claims to leave alone, and the loader refusing to load would say so.
  const loaded = await loadV11AcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });
  assert.equal(loaded.definition.commonExecution.repetitions, 2);
  assert.equal(loaded.scenarios.length, 2);
});
