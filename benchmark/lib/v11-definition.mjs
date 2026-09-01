import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  V11_PHASES,
  canonicalJson,
  validateApplicability
} from './v11-contract.mjs';
import {
  assertDenseArray,
  assertOwnDataProperties,
  boundaryReject,
  createV11LexicalClassifier,
  normalizedPublicDataKey,
  sealBoundary
} from './v11-lexical.mjs';
// One edge into the registry graph, for the shared exclusion predicate. That
// graph reaches adapter-protocol, outer-model, python-adapter-executor and
// v11-contract; none of them imports this module, so there is no cycle. Check
// that again before adding an import to any of them.
import { isExcludedFromUserIsolation } from './v11-registry.mjs';

const FIXTURE_SET = 'candidate-acceptance-non-scored-2026-08';
const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const ACCEPTANCE_ID = /^ACC_[A-Z0-9_]+$/u;
const DEFINITION_FIELDS = [
  'schemaVersion',
  'benchmarkVersion',
  'fixtureSet',
  'scored',
  'sourceHashes',
  'scenarios',
  'arms',
  'phases',
  'commonExecution',
  'expectedCounts'
];
const SCENARIO_DOCUMENT_FIELDS = ['schemaVersion', 'fixtureSet', 'scored', 'scenarios'];
const SCENARIO_FIELDS = [
  'id',
  'domain',
  'projectId',
  'userId',
  'isolationProjectId',
  'isolationUserId',
  'task',
  'choice',
  'constraints',
  'alternatives',
  'assumptionIds',
  'evidence',
  'riskIds',
  'reviewTrigger',
  'changedFact',
  'irrelevantFacts',
  'failedAttempt'
];
const MOCK_OR_REJECTED_SCENARIO_ID = /^(?:ACC_RUNNER_|ACC_VALIDATION_|ACC_FIXTURE$|ACC_SECOND$)/u;
const FORBIDDEN_PUBLIC_DATA_KEYS = new Set([
  'answer',
  'oracle',
  'proto',
  'prototype',
  'constructor',
  'expected',
  'expectedanswer',
  'expectedchoice',
  'expectedoutcome',
  'expectedresult',
  'fixturetruth',
  'groundtruth',
  'winner',
  'fallback',
  'score',
  'scoring',
  'rank',
  'ranking',
  'system',
  'systemprompt',
  'developer',
  'developerprompt',
  'instruction',
  'instructions',
  'prompt',
  'messages',
  'responseschema',
  'outerauthority',
  'outerprompt',
  'outermodel',
  'apikey',
  'accesstoken',
  'authtoken',
  'authorization',
  'bearer',
  'clientsecret',
  'credential',
  'credentials',
  'secret',
  'password',
  'token',
  'endpoint',
  'baseurl',
  'model',
  'modelid',
  'modelname',
  'modelconfig',
  'temperature',
  'seed',
  'maxtokens',
  'maxinputtokens',
  'maxoutputtokens',
  'timeout',
  'timeoutms',
  'retries',
  'arm',
  'armid',
  'adapter',
  'adapterid',
  'product',
  'productid',
  'path',
  'filepath',
  'privatepath',
  'cwd',
  'workspace',
  'homedir'
]);

export const V11_ACCEPTANCE_SOURCE_HASHES = Object.freeze({
  preregistrationSha256: '738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac',
  amendment001Sha256: '2b209df6ca46a179e332acd4ed0b16a35a089f5c14575dd86353db0dc7249c4a',
  amendment002Sha256: '08e12eca3f93bd67cfeaf90a2064f91beb240e78a8fd63ed8645da78c0d88f1b'
});

export const V11_ACCEPTANCE_ARM_IDS = Object.freeze([
  'no-memory',
  'shadowgraph-full',
  'shadowgraph-compact',
  'mem0-oss',
  'graphiti',
  'basic-memory',
  'cognee'
]);

export const V11_ACCEPTANCE_PHASES = V11_PHASES;

export const V11_ACCEPTANCE_EXPECTED_COUNTS = Object.freeze({
  totalUnits: 308,
  excludedUnits: 16,
  measuredUnits: 292,
  resetUnits: 28,
  outerDecisionCalls: 264
});

const EXPECTED_APPLICABILITY = Object.freeze({
  'no-memory': Object.freeze({
    userIsolation: Object.freeze({
      status: 'NOT_APPLICABLE',
      reason: 'control has no memory system or native user namespace'
    }),
    persistence: Object.freeze({
      status: 'NOT_APPLICABLE',
      reason: 'control intentionally persists no records'
    })
  }),
  'shadowgraph-full': Object.freeze({
    userIsolation: Object.freeze({
      status: 'NOT_APPLICABLE',
      reason: 'decision records have a native project namespace but no native user namespace'
    }),
    persistence: Object.freeze({ status: 'SUPPORTED', reason: null })
  }),
  'shadowgraph-compact': Object.freeze({
    userIsolation: Object.freeze({
      status: 'NOT_APPLICABLE',
      reason: 'decision records have a native project namespace but no native user namespace'
    }),
    persistence: Object.freeze({ status: 'SUPPORTED', reason: null })
  }),
  'mem0-oss': Object.freeze({
    userIsolation: Object.freeze({ status: 'SUPPORTED', reason: null }),
    persistence: Object.freeze({ status: 'SUPPORTED', reason: null })
  }),
  graphiti: Object.freeze({
    userIsolation: Object.freeze({ status: 'SUPPORTED', reason: null }),
    persistence: Object.freeze({ status: 'SUPPORTED', reason: null })
  }),
  'basic-memory': Object.freeze({
    userIsolation: Object.freeze({
      status: 'NOT_APPLICABLE',
      reason: 'product exposes project namespaces but no native user namespace'
    }),
    persistence: Object.freeze({ status: 'SUPPORTED', reason: null })
  }),
  cognee: Object.freeze({
    userIsolation: Object.freeze({ status: 'SUPPORTED', reason: null }),
    persistence: Object.freeze({ status: 'SUPPORTED', reason: null })
  })
});

const EXPECTED_ARM_NAMES = Object.freeze({
  'no-memory': 'No memory',
  'shadowgraph-full': 'ShadowGraph Full',
  'shadowgraph-compact': 'ShadowGraph Compact',
  'mem0-oss': 'Mem0 OSS',
  graphiti: 'Graphiti',
  'basic-memory': 'Basic Memory',
  cognee: 'Cognee'
});

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const ARM_SPECIFIC_REFERENCE = new RegExp(
  `(?:^|[^A-Za-z0-9._:-])(?:${[
    ...V11_ACCEPTANCE_ARM_IDS,
    ...Object.values(EXPECTED_ARM_NAMES)
  ].map(escapePattern).join('|')})(?=$|[^A-Za-z0-9._:-])`,
  'iu'
);

const LEXICAL_CLASSIFIER = createV11LexicalClassifier([
  ...V11_ACCEPTANCE_ARM_IDS,
  ...Object.values(EXPECTED_ARM_NAMES)
]);

export function isForbiddenV11PublicDataKey(value) {
  return typeof value === 'string'
    && FORBIDDEN_PUBLIC_DATA_KEYS.has(normalizedPublicDataKey(value));
}

/**
 * Classify serialized text for the public boundary.
 *
 * Returns a stable boundary code, or null when the text is safe. Callers get
 * the code only; the rejected text never travels with it.
 */
export function v11UnsafeTextCode(value) {
  return LEXICAL_CLASSIFIER.classify(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expectedFields, label) {
  if (!isPlainObject(value)) boundaryReject('SHAPE');
  const expected = new Set(expectedFields);
  for (const field of Object.keys(value)) {
    if (!expected.has(field)) boundaryReject('SHAPE');
  }
  for (const field of expectedFields) {
    if (!Object.hasOwn(value, field)) boundaryReject('SHAPE');
  }
}

function assertNonEmptyString(value, label, maximum = 4_096) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    boundaryReject('SHAPE');
  }
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    boundaryReject('SHAPE');
  }
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) boundaryReject('SHAPE');
}

// Depth budget for public scenario data, measured from the scenario object.
// Six containers below `reviewTrigger.value` are accepted; the seventh is not.
const MAX_PUBLIC_DEPTH = 8;

/**
 * Walk public scenario data as inert JSON.
 *
 * Values are read through property descriptors so a getter is rejected rather
 * than invoked, and no label derived from the data is ever carried into an
 * error.
 */
function neutralPublicSnapshot(value, depth = 0, seen = new Set()) {
  if (depth > MAX_PUBLIC_DEPTH) boundaryReject('LIMIT');
  if (typeof value === 'string') {
    const code = v11UnsafeTextCode(value);
    if (code !== null) boundaryReject(code);
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) boundaryReject('SHAPE');
    return value;
  }
  if (typeof value !== 'object') boundaryReject('SHAPE');
  if (seen.has(value)) boundaryReject('SHAPE');
  seen.add(value);
  let snapshot;
  if (Array.isArray(value)) {
    assertDenseArray(value);
    snapshot = [];
    for (let index = 0; index < value.length; index += 1) {
      snapshot.push(neutralPublicSnapshot(value[index], depth + 1, seen));
    }
  } else {
    if (!isPlainObject(value)) boundaryReject('SHAPE');
    assertOwnDataProperties(value);
    snapshot = Object.create(null);
    for (const field of Object.keys(value)) {
      const keyCode = v11UnsafeTextCode(field);
      if (keyCode !== null) boundaryReject(keyCode);
      if (field.length === 0 || isForbiddenV11PublicDataKey(field)) boundaryReject('KEY');
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (descriptor === undefined || !('value' in descriptor)) boundaryReject('SHAPE');
      if (descriptor.value === undefined) boundaryReject('SHAPE');
      Object.defineProperty(snapshot, field, {
        value: neutralPublicSnapshot(descriptor.value, depth + 1, seen),
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
  }
  seen.delete(value);
  return snapshot;
}

function validateIdList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    boundaryReject('SHAPE');
  }
  value.forEach((id, index) => assertSafeId(id, `${label}[${index}]`));
  assertUnique(value, label);
}

function validateTextDescriptor(value, label) {
  assertExactKeys(value, ['id', 'text'], label);
  assertSafeId(value.id, `${label}.id`);
  assertNonEmptyString(value.text, `${label}.text`);
}

function validateFact(value, label) {
  assertExactKeys(value, ['id', 'key', 'value'], label);
  assertSafeId(value.id, `${label}.id`);
  assertSafeId(value.key, `${label}.key`);
  canonicalJson(value.value);
}

export function validateV11PublicScenario(scenario) {
  // Sealed around the entire body. Reading any property of a hostile value can
  // throw, so sealing only the snapshot walk left every later read - starting
  // with scenario.id - able to escape as an uncoded error carrying attacker
  // text.
  return sealBoundary(() => validateV11PublicScenarioUnsealed(scenario));
}

function validateV11PublicScenarioUnsealed(scenario) {
  const snapshot = neutralPublicSnapshot(scenario);
  assertExactKeys(scenario, SCENARIO_FIELDS, 'acceptance scenario');
  assertSafeId(scenario.id, 'acceptance scenario.id');
  for (const field of [
    'domain',
    'projectId',
    'userId',
    'isolationProjectId',
    'isolationUserId',
    'task'
  ]) assertNonEmptyString(scenario[field], `acceptance scenario.${field}`);
  for (const field of ['projectId', 'userId', 'isolationProjectId', 'isolationUserId']) {
    assertSafeId(scenario[field], `acceptance scenario.${field}`);
  }
  if (scenario.projectId === scenario.isolationProjectId) {
    boundaryReject('SHAPE');
  }
  if (scenario.userId === scenario.isolationUserId) {
    boundaryReject('SHAPE');
  }

  assertExactKeys(scenario.choice, ['id', 'label'], 'acceptance scenario.choice');
  assertSafeId(scenario.choice.id, 'acceptance scenario.choice.id');
  assertNonEmptyString(scenario.choice.label, 'acceptance scenario.choice.label');

  if (!Array.isArray(scenario.alternatives) || scenario.alternatives.length < 2) {
    boundaryReject('SHAPE');
  }
  for (const [index, alternative] of scenario.alternatives.entries()) {
    const label = `acceptance scenario.alternatives[${index}]`;
    assertExactKeys(alternative, ['id', 'label', 'reasonId', 'reason'], label);
    assertSafeId(alternative.id, `${label}.id`);
    assertNonEmptyString(alternative.label, `${label}.label`);
    assertSafeId(alternative.reasonId, `${label}.reasonId`);
    assertNonEmptyString(alternative.reason, `${label}.reason`);
  }
  const optionIds = [scenario.choice.id, ...scenario.alternatives.map(({ id }) => id)];
  assertUnique(optionIds, 'acceptance scenario option ids');
  assertUnique(
    scenario.alternatives.map(({ reasonId }) => reasonId),
    'acceptance scenario alternative reason ids'
  );

  if (!Array.isArray(scenario.constraints) || scenario.constraints.length < 2) {
    boundaryReject('SHAPE');
  }
  scenario.constraints.forEach((value, index) => (
    validateTextDescriptor(value, `acceptance scenario.constraints[${index}]`)
  ));
  assertUnique(scenario.constraints.map(({ id }) => id), 'acceptance scenario constraint ids');
  validateIdList(scenario.assumptionIds, 'acceptance scenario.assumptionIds');

  if (!Array.isArray(scenario.evidence) || scenario.evidence.length < 2) {
    boundaryReject('SHAPE');
  }
  scenario.evidence.forEach((value, index) => (
    validateTextDescriptor(value, `acceptance scenario.evidence[${index}]`)
  ));
  assertUnique(scenario.evidence.map(({ id }) => id), 'acceptance scenario evidence ids');
  validateIdList(scenario.riskIds, 'acceptance scenario.riskIds');

  assertExactKeys(
    scenario.reviewTrigger,
    ['id', 'key', 'operator', 'value'],
    'acceptance scenario.reviewTrigger'
  );
  for (const field of ['id', 'key', 'operator']) {
    assertSafeId(scenario.reviewTrigger[field], `acceptance scenario.reviewTrigger.${field}`);
  }
  canonicalJson(scenario.reviewTrigger.value);
  validateFact(scenario.changedFact, 'acceptance scenario.changedFact');
  if (scenario.changedFact.key !== scenario.reviewTrigger.key) {
    boundaryReject('SHAPE');
  }

  if (!Array.isArray(scenario.irrelevantFacts) || scenario.irrelevantFacts.length !== 3) {
    boundaryReject('SHAPE');
  }
  scenario.irrelevantFacts.forEach((value, index) => (
    validateFact(value, `acceptance scenario.irrelevantFacts[${index}]`)
  ));
  assertUnique(scenario.irrelevantFacts.map(({ id }) => id), 'acceptance scenario irrelevant fact ids');
  if (scenario.irrelevantFacts.some(({ key }) => key === scenario.reviewTrigger.key)) {
    boundaryReject('SHAPE');
  }

  assertExactKeys(
    scenario.failedAttempt,
    ['id', 'approachId', 'reasonId', 'reason'],
    'acceptance scenario.failedAttempt'
  );
  for (const field of ['id', 'approachId', 'reasonId']) {
    assertSafeId(scenario.failedAttempt[field], `acceptance scenario.failedAttempt.${field}`);
  }
  assertNonEmptyString(scenario.failedAttempt.reason, 'acceptance scenario.failedAttempt.reason');
  if (!optionIds.includes(scenario.failedAttempt.approachId)) {
    boundaryReject('SHAPE');
  }
  return snapshot;
}

export function validateV11AcceptanceScenario(scenario) {
  return sealBoundary(() => validateV11AcceptanceScenarioUnsealed(scenario));
}

function validateV11AcceptanceScenarioUnsealed(scenario) {
  validateV11PublicScenario(scenario);
  if (!ACCEPTANCE_ID.test(scenario.id) || MOCK_OR_REJECTED_SCENARIO_ID.test(scenario.id)) {
    boundaryReject('SHAPE');
  }
  return scenario;
}

function parseJson(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!isPlainObject(value)) boundaryReject('SHAPE');
    return value;
  } catch {
    boundaryReject('SHAPE');
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    boundaryReject('SHAPE');
  }
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function readSafeFile(filePath, allowedRoot, label) {
  const stat = await lstat(filePath);
  if (stat.isSymbolicLink()) boundaryReject('LOCAL_REFERENCE');
  if (!stat.isFile()) boundaryReject('LOCAL_REFERENCE');
  const [actualFile, actualRoot] = await Promise.all([realpath(filePath), realpath(allowedRoot)]);
  if (!inside(actualRoot, actualFile) || actualFile !== path.resolve(filePath)) {
    boundaryReject('LOCAL_REFERENCE');
  }
  return readFile(actualFile);
}

function validateDefinitionShape(definition) {
  assertExactKeys(definition, DEFINITION_FIELDS, 'acceptance definition');
  if (definition.schemaVersion !== 1) boundaryReject('SHAPE');
  if (definition.benchmarkVersion !== '1.1') {
    boundaryReject('SHAPE');
  }
  if (definition.fixtureSet !== FIXTURE_SET) {
    boundaryReject('SHAPE');
  }
  if (definition.scored !== false) boundaryReject('SHAPE');

  assertExactKeys(
    definition.sourceHashes,
    Object.keys(V11_ACCEPTANCE_SOURCE_HASHES),
    'acceptance definition.sourceHashes'
  );
  for (const [field, expected] of Object.entries(V11_ACCEPTANCE_SOURCE_HASHES)) {
    assertHash(definition.sourceHashes[field], `acceptance definition.sourceHashes.${field}`);
    if (definition.sourceHashes[field] !== expected) {
      boundaryReject('SHAPE');
    }
  }

  assertExactKeys(definition.scenarios, ['path', 'sha256'], 'acceptance definition.scenarios');
  if (definition.scenarios.path !== 'scenarios.json') {
    boundaryReject('LOCAL_REFERENCE');
  }
  assertHash(definition.scenarios.sha256, 'acceptance definition.scenarios.sha256');

  if (!Array.isArray(definition.arms) || definition.arms.length !== V11_ACCEPTANCE_ARM_IDS.length) {
    boundaryReject('SHAPE');
  }
  const armIds = [];
  definition.arms.forEach((arm, index) => {
    assertExactKeys(arm, ['id', 'name', 'applicability'], `acceptance definition.arms[${index}]`);
    assertSafeId(arm.id, `acceptance definition.arms[${index}].id`);
    assertNonEmptyString(arm.name, `acceptance definition.arms[${index}].name`);
    validateApplicability(arm.applicability);
    armIds.push(arm.id);
    const expectedId = V11_ACCEPTANCE_ARM_IDS[index];
    if (arm.id !== expectedId) boundaryReject('SHAPE');
    if (arm.name !== EXPECTED_ARM_NAMES[expectedId]) {
      boundaryReject('SHAPE');
    }
    if (!isDeepStrictEqual(arm.applicability, EXPECTED_APPLICABILITY[expectedId])) {
      boundaryReject('SHAPE');
    }
  });
  assertUnique(armIds, 'acceptance definition arm ids');

  if (!Array.isArray(definition.phases)
    || !isDeepStrictEqual(definition.phases, [...V11_ACCEPTANCE_PHASES])) {
    boundaryReject('SHAPE');
  }
  assertExactKeys(
    definition.commonExecution,
    ['repetitions', 'randomSeeds'],
    'acceptance definition.commonExecution'
  );
  if (definition.commonExecution.repetitions !== 2) {
    boundaryReject('SHAPE');
  }
  if (!isDeepStrictEqual(definition.commonExecution.randomSeeds, [1729, 2718])) {
    boundaryReject('SHAPE');
  }
  assertExactKeys(
    definition.expectedCounts,
    Object.keys(V11_ACCEPTANCE_EXPECTED_COUNTS),
    'acceptance definition.expectedCounts'
  );
  if (!isDeepStrictEqual(definition.expectedCounts, V11_ACCEPTANCE_EXPECTED_COUNTS)) {
    boundaryReject('SHAPE');
  }
}

function declaredScenarioIds(scenario) {
  return [
    scenario.id,
    scenario.choice.id,
    ...scenario.alternatives.flatMap(({ id, reasonId }) => [id, reasonId]),
    ...scenario.constraints.map(({ id }) => id),
    ...scenario.assumptionIds,
    ...scenario.evidence.map(({ id }) => id),
    ...scenario.riskIds,
    scenario.reviewTrigger.id,
    scenario.changedFact.id,
    ...scenario.irrelevantFacts.map(({ id }) => id),
    scenario.failedAttempt.id,
    scenario.failedAttempt.reasonId
  ];
}

function validateScenarioDocument(document, preregistration) {
  assertExactKeys(document, SCENARIO_DOCUMENT_FIELDS, 'acceptance scenarios document');
  if (document.schemaVersion !== 1) boundaryReject('SHAPE');
  if (document.fixtureSet !== FIXTURE_SET) {
    boundaryReject('SHAPE');
  }
  if (document.scored !== false) boundaryReject('SHAPE');
  if (!Array.isArray(document.scenarios) || document.scenarios.length !== 2) {
    boundaryReject('SHAPE');
  }
  document.scenarios.forEach(validateV11AcceptanceScenario);
  assertUnique(document.scenarios.map(({ id }) => id), 'acceptance scenarios');
  const declaredIds = document.scenarios.flatMap(declaredScenarioIds);
  assertUnique(declaredIds, 'acceptance scenario declared ids');

  const frozenIds = new Set(preregistration.scenarios.map(({ id }) => id));
  const frozenDeclaredIds = new Set(preregistration.scenarios.flatMap(declaredScenarioIds));
  const frozenTasks = new Set(preregistration.scenarios.map(({ task }) => task));
  const frozenContentWithoutId = new Set(preregistration.scenarios.map((scenario) => {
    const { id: _id, ...content } = scenario;
    return canonicalJson(content);
  }));
  for (const scenario of document.scenarios) {
    if (frozenIds.has(scenario.id) || frozenTasks.has(scenario.task)) {
      boundaryReject('SHAPE');
    }
    const { id: _id, ...content } = scenario;
    if (frozenContentWithoutId.has(canonicalJson(content))) {
      boundaryReject('SHAPE');
    }
    if (declaredScenarioIds(scenario).some((id) => frozenDeclaredIds.has(id))) {
      boundaryReject('SHAPE');
    }
  }
}

function validateFrozenSources(preregistration, amendment001, amendment002, definition) {
  if (!Array.isArray(preregistration.arms)
    || !isDeepStrictEqual(preregistration.arms.map(({ id }) => id), [...V11_ACCEPTANCE_ARM_IDS])) {
    boundaryReject('SHAPE');
  }
  if (!isPlainObject(amendment001)) boundaryReject('SHAPE');
  if (amendment002?.amendmentId !== 'amendment-002') {
    boundaryReject('SHAPE');
  }
  if (amendment002?.supersedes?.preregistrationSha256 !== definition.sourceHashes.preregistrationSha256
    || amendment002?.supersedes?.amendment001Sha256 !== definition.sourceHashes.amendment001Sha256) {
    boundaryReject('SHAPE');
  }
  const candidate = amendment002.candidateAcceptance;
  if (!isPlainObject(candidate)
    || candidate.fixtureSet !== FIXTURE_SET
    || candidate.repetitions !== 2
    || candidate.scored !== false
    || candidate.requiredArms !== 7
    || !isDeepStrictEqual(candidate.requiredPhases, [...V11_ACCEPTANCE_PHASES])) {
    boundaryReject('SHAPE');
  }
  const matrix = amendment002?.definitions?.applicability?.armMatrix;
  if (!isPlainObject(matrix)
    || !isDeepStrictEqual(new Set(Object.keys(matrix)), new Set(V11_ACCEPTANCE_ARM_IDS))) {
    boundaryReject('SHAPE');
  }
  for (const armId of V11_ACCEPTANCE_ARM_IDS) {
    if (!isDeepStrictEqual(matrix[armId], EXPECTED_APPLICABILITY[armId])) {
      boundaryReject('SHAPE');
    }
  }
}

function validateMechanicalCounts(definition, scenarioCount) {
  const repetitions = definition.commonExecution.repetitions;
  const totalUnits = scenarioCount * repetitions * definition.arms.length * definition.phases.length;
  const excludedArmCount = definition.arms.filter((arm) => (
    isExcludedFromUserIsolation(arm.applicability)
  )).length;
  const excludedUnits = scenarioCount * repetitions * excludedArmCount;
  const measuredUnits = totalUnits - excludedUnits;
  const resetUnits = scenarioCount * repetitions * definition.arms.length;
  const outerDecisionCalls = measuredUnits - resetUnits;
  const calculated = { totalUnits, excludedUnits, measuredUnits, resetUnits, outerDecisionCalls };
  if (!isDeepStrictEqual(calculated, V11_ACCEPTANCE_EXPECTED_COUNTS)
    || !isDeepStrictEqual(calculated, definition.expectedCounts)) {
    boundaryReject('SHAPE');
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/**
 * Load and validate the frozen acceptance definition.
 *
 * Deliberately outside the sealed set. The three sealed entry points handle
 * values that reach the outer prompt; this one reads harness-supplied paths, so
 * its failures are operator diagnostics rather than attacker output. Sealing it
 * would replace an actionable message - which file is missing, and where - with
 * an opaque code, and would buy nothing: an unhandled failure here carries a
 * static field name or a path the harness itself supplied, never scenario
 * content. Everything it returns still passes through validateV11PublicScenario
 * before it can become prompt material.
 *
 * What would invalidate this: if repositoryRoot ever became attacker- or
 * config-influenced rather than derived from import.meta.url, the path in an
 * ENOENT would start disclosing something, and this function would then need
 * sealing like the rest.
 */
export async function loadV11AcceptanceDefinition(options) {
  assertExactKeys(options, ['repositoryRoot'], 'acceptance definition loader options');
  assertNonEmptyString(options.repositoryRoot, 'acceptance definition loader repositoryRoot');
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const benchmarkRoot = path.join(repositoryRoot, 'benchmark');
  const acceptanceRoot = path.join(benchmarkRoot, 'acceptance');
  const definitionPath = path.join(acceptanceRoot, 'definition.json');
  const definitionBytes = await readSafeFile(definitionPath, acceptanceRoot, 'acceptance definition file');
  const definition = parseJson(definitionBytes, 'acceptance definition');
  validateDefinitionShape(definition);

  const sourceFiles = [
    ['preregistrationSha256', 'preregistration.json', 'frozen preregistration'],
    ['amendment001Sha256', 'preregistration-amendment-001.json', 'frozen Amendment 001'],
    ['amendment002Sha256', 'preregistration-amendment-002.json', 'frozen Amendment 002']
  ];
  const parsedSources = [];
  for (const [hashField, filename, label] of sourceFiles) {
    const bytes = await readSafeFile(path.join(benchmarkRoot, filename), benchmarkRoot, label);
    const actualHash = sha256(bytes);
    if (actualHash !== V11_ACCEPTANCE_SOURCE_HASHES[hashField]
      || actualHash !== definition.sourceHashes[hashField]) {
      boundaryReject('SHAPE');
    }
    parsedSources.push(parseJson(bytes, label));
  }
  const [preregistration, amendment001, amendment002] = parsedSources;
  validateFrozenSources(preregistration, amendment001, amendment002, definition);

  const scenariosPath = path.resolve(acceptanceRoot, definition.scenarios.path);
  if (!inside(acceptanceRoot, scenariosPath) || path.dirname(scenariosPath) !== acceptanceRoot) {
    boundaryReject('LOCAL_REFERENCE');
  }
  const scenarioBytes = await readSafeFile(scenariosPath, acceptanceRoot, 'acceptance scenarios file');
  if (sha256(scenarioBytes) !== definition.scenarios.sha256) {
    boundaryReject('SHAPE');
  }
  const scenarioDocument = parseJson(scenarioBytes, 'acceptance scenarios');
  validateScenarioDocument(scenarioDocument, preregistration);
  validateMechanicalCounts(definition, scenarioDocument.scenarios.length);

  return deepFreeze({
    definition: structuredClone(definition),
    scenarios: structuredClone(scenarioDocument.scenarios),
    sourceHashes: structuredClone(V11_ACCEPTANCE_SOURCE_HASHES),
    expectedCounts: structuredClone(V11_ACCEPTANCE_EXPECTED_COUNTS)
  });
}
