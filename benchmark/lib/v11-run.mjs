// v1.1 run assembly: readiness, adapter routing, and the end-to-end path from
// the registry through the runner to the validator and aggregator.
//
// This module exists so that readiness has exactly one implementation. The
// preflight command and the run command ask the same function the same
// question, which is the only way a NOT READY preflight and a run that starts
// anyway cannot both be true at once.
//
// Nothing here contacts a service or executes an arm. It decides whether a run
// may start, routes each arm to the runtime the lock names for it, and connects
// the pieces. A run that is not permitted produces a refusal and no artifact -
// never a partial result directory that could later be mistaken for evidence.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseServiceManifestDocument } from './implementation-lock.mjs';
import { aggregateRun } from './aggregate.mjs';
import { verifyPreconditionEvidence } from './v11-precondition-evidence.mjs';
import { verifyNativeAttemptEvidence } from './v11-native-attempt-evidence.mjs';
import { loadNativeAttemptProbeReports } from './v11-native-attempt-evidence-loader.mjs';
import { validateNativeAttemptPolicy } from './v11-native-attempts.mjs';
import { buildV11Prompt } from './v11-prompts.mjs';
import { providerModelsFromLock } from './v11-provider-models.mjs';
import {
  captureVerifiedServiceEvidence,
  resolveVerifiedServiceEvidence,
  verifyServiceEvidence
} from './v11-service-evidence.mjs';
import { validateRawRun } from './validate.mjs';
import { runV11Benchmark } from './v11-runner.mjs';
import { validateProviderBudget } from './v11-budget.mjs';

export class V11RunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'V11RunError';
    this.code = code;
  }
}

const FULL_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const BARE_SHA256 = /^[a-f0-9]{64}$/u;

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The immutable prerequisites a real acceptance run depends on.
 *
 * Each gate checks that the declaring file exists and is shaped like the
 * evidence it claims to be. None of them can check that the evidence is
 * authentic - a syntactically valid digest for a model nobody ran would satisfy
 * the shape check - and the blocker text says so rather than implying more.
 */
export const V11_PREREQUISITE_GATES = Object.freeze([
  Object.freeze({
    requirement: 'model-weight-digests',
    file: 'model-weights.lock.json',
    isSatisfied: (value) => Array.isArray(value?.models) && value.models.length > 0
      && value.models.every((model) => (
        isPlainRecord(model)
        && model.digestKind === 'model_weights'
        && typeof model.weightsDigest === 'string'
        && FULL_SHA256.test(model.weightsDigest)
        && typeof model.modelId === 'string'
        && model.modelId.length > 0
      ))
  }),
  Object.freeze({
    requirement: 'service-manifest',
    file: 'service-images.json',
    // The implementation-lock parser owns the exact service identity grammar.
    // A readiness gate must never accept a tag-only/index/config-ID shape that
    // the lock or service-evidence verifier would later reject.
    isSatisfied: (value) => {
      try {
        parseServiceManifestDocument(value);
        return true;
      } catch {
        return false;
      }
    }
  }),
  Object.freeze({
    requirement: 'reproducible-runtime-bytes',
    file: 'python-wheels.lock.json',
    isSatisfied: (value) => Array.isArray(value?.wheels) && value.wheels.length > 0
      && value.wheels.every((wheel) => (
        isPlainRecord(wheel)
        && typeof wheel.name === 'string' && wheel.name.length > 0
        && typeof wheel.sha256 === 'string' && BARE_SHA256.test(wheel.sha256)
      ))
  })
]);

/** Read a gate file, distinguishing absent from unreadable from malformed. */
export async function readGateJson(filePath, readFileImpl = readFile) {
  let text;
  try {
    text = await readFileImpl(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable' };
  }
  try {
    return { state: 'present', value: JSON.parse(text), text };
  } catch {
    return { state: 'malformed' };
  }
}

function unmetReason(gate, isSatisfied) {
  if (gate.state === 'absent') return 'the declaring file does not exist';
  if (gate.state === 'unreadable') return 'the declaring file could not be read';
  if (gate.state === 'malformed') return 'the declaring file is not valid JSON';
  return isSatisfied(gate.value) ? null : 'the declaring file contains no usable entry';
}

/**
 * Decide whether the candidate may start a real non-scored acceptance run.
 *
 * Applicability findings, count mismatches, unprovisioned services and unmet
 * immutable prerequisites are all blockers of equal standing. A run is READY
 * only when every one of them is clear, because each describes something the
 * resulting numbers would depend on.
 */
export async function computeV11Readiness(input) {
  const {
    registry,
    definition,
    scenarios,
    nativeAttemptPolicy = null,
    sourceHashes = null,
    campaign = null,
    benchmarkRoot,
    // An operator's unverified declaration that a precondition holds. Retained
    // for the tests that drive applicability directly; the CLI never populates
    // it, because a declaration is not a demonstration.
    satisfiedPreconditions = [],
    preconditionEvidencePath = null,
    nativeAttemptEvidencePath = null,
    serviceEvidencePath = null,
    // A module-minted snapshot may be carried from the readiness decision into
    // runtime binding. It is deliberately preferred over a path: reopening a
    // mutable path would turn a passed preflight into a different evidence claim.
    verifiedServiceEvidence = null,
    // Deliberately not called `now`: elsewhere in this module `now` is the
    // clock function a run is given, and freshness here is an instant, not a
    // clock. One name for two types is how a run would end up handing a
    // function to a comparison and getting a silent answer.
    verificationInstant = Date.now(),
    readFileImpl = readFile
  } = input;

  // A precondition is met when a demonstration establishes it, not when someone
  // says so. The declared side of that comparison comes from the registry and
  // the lock, never from the record being checked.
  const preconditionEvidenceGate = preconditionEvidencePath === null
    ? { state: 'absent' }
    : await readGateJson(preconditionEvidencePath, readFileImpl);
  const preconditionEvidence = verifyPreconditionEvidence({
    evidence: preconditionEvidenceGate.state === 'present' ? preconditionEvidenceGate.value : null,
    declaredPreconditions: Object.fromEntries(registry.descriptors.map((descriptor) => [
      descriptor.armId,
      descriptor.isolation?.userNamespacePrecondition ?? null
    ])),
    pinnedPackages: Object.fromEntries(registry.descriptors.map((descriptor) => [
      descriptor.armId,
      { name: descriptor.packageName ?? null, version: descriptor.version ?? null }
    ])),
    now: verificationInstant
  });

  const declared = Object.fromEntries(definition.arms.map((arm) => [arm.id, arm.applicability]));
  const applicability = registry.verifyApplicability(declared, [
    ...satisfiedPreconditions,
    ...preconditionEvidence.satisfiedPreconditions
  ]);
  const derivedCounts = registry.expectedCounts({
    scenarios: scenarios.length,
    repetitions: definition.commonExecution.repetitions,
    phases: definition.phases,
    declared
  });
  const declaredCounts = definition.expectedCounts;
  const countMismatches = Object.keys(derivedCounts)
    .filter((key) => derivedCounts[key] !== declaredCounts[key])
    .map((key) => ({ count: key, declared: declaredCounts[key], derived: derivedCounts[key] }));

  const blockers = [];
  if (campaign === null) blockers.push({ kind: 'campaign', code: 'CAMPAIGN_CONFIGURATION_REQUIRED' });
  let providerBudget = null;
  try {
    providerBudget = validateProviderBudget(input.providerBudget, {
      runId: input.runId, attemptId: input.attemptId,
      implementationLockHash: input.implementationLockHash
    });
  } catch (error) {
    blockers.push({ kind: 'operational-budget', code: error.code, detail: error.message });
  }
  for (const finding of applicability.findings) {
    blockers.push({ kind: 'applicability', ...finding });
  }
  for (const mismatch of countMismatches) {
    blockers.push({ kind: 'expected-counts', ...mismatch });
  }
  // The prerequisite gates are read first because two of the files they check -
  // the service manifest and the model weight lock - are also the committed
  // baseline a service probe record is checked against. Reading them once means
  // readiness cannot end up comparing evidence to one version of the manifest
  // while reporting the gate against another.
  const gateValues = new Map();
  const prerequisiteBlockers = [];
  for (const { requirement, file, isSatisfied } of V11_PREREQUISITE_GATES) {
    const gate = await readGateJson(path.join(benchmarkRoot, file), readFileImpl);
    gateValues.set(file, gate.state === 'present' ? gate.value : null);
    const reason = unmetReason(gate, isSatisfied);
    if (reason !== null) {
      prerequisiteBlockers.push({
        kind: 'immutable-prerequisite',
        requirement,
        detail: reason,
        note: 'presence and shape only; this check cannot establish authenticity'
      });
    }
  }

  // A required service is cleared only by exact probe bytes that agree with the
  // committed baselines. When a prior readiness decision supplies its trusted
  // snapshot, never reopen the mutable operator-selected path.
  let capturedServiceEvidence = verifiedServiceEvidence;
  let serviceEvidence;
  if (capturedServiceEvidence !== null) {
    serviceEvidence = resolveVerifiedServiceEvidence({
      snapshot: capturedServiceEvidence,
      serviceManifest: gateValues.get('service-images.json'),
      modelWeights: gateValues.get('model-weights.lock.json'),
      now: verificationInstant
    });
  } else {
    const serviceEvidenceGate = serviceEvidencePath === null
      ? { state: 'absent' }
      : await readGateJson(serviceEvidencePath, readFileImpl);
    if (serviceEvidenceGate.state === 'present') {
      try {
        capturedServiceEvidence = captureVerifiedServiceEvidence({
          evidenceText: serviceEvidenceGate.text,
          serviceManifest: gateValues.get('service-images.json'),
          modelWeights: gateValues.get('model-weights.lock.json'),
          now: verificationInstant
        });
        serviceEvidence = resolveVerifiedServiceEvidence({
          snapshot: capturedServiceEvidence,
          serviceManifest: gateValues.get('service-images.json'),
          modelWeights: gateValues.get('model-weights.lock.json'),
          now: verificationInstant
        });
      } catch {
        capturedServiceEvidence = null;
        serviceEvidence = verifyServiceEvidence({
          evidence: serviceEvidenceGate.value,
          serviceManifest: gateValues.get('service-images.json'),
          modelWeights: gateValues.get('model-weights.lock.json'),
          now: verificationInstant
        });
      }
    } else {
      serviceEvidence = verifyServiceEvidence({
        evidence: null,
        serviceManifest: gateValues.get('service-images.json'),
        modelWeights: gateValues.get('model-weights.lock.json'),
        now: verificationInstant
      });
    }
  }

  let nativeAttemptEvidence = null;
  let normalizedNativeAttemptPolicy = null;
  if (nativeAttemptPolicy !== null) {
    const nativeEvidenceGate = nativeAttemptEvidencePath === null
      ? { state: 'absent' }
      : await readGateJson(nativeAttemptEvidencePath, readFileImpl);
    try {
      normalizedNativeAttemptPolicy = validateNativeAttemptPolicy(nativeAttemptPolicy);
      const nativeProbeReports = nativeEvidenceGate.state === 'present'
        ? await loadNativeAttemptProbeReports({
          evidencePath: nativeAttemptEvidencePath,
          evidence: nativeEvidenceGate.value
        })
        : new Map();
      const pinnedModels = providerModelsFromLock(gateValues.get('model-weights.lock.json'));
      nativeAttemptEvidence = verifyNativeAttemptEvidence({
        evidence: nativeEvidenceGate.state === 'present' ? nativeEvidenceGate.value : null,
        policy: nativeAttemptPolicy,
        amendment006Sha256: sourceHashes?.amendment006Sha256,
        amendment008Sha256: sourceHashes?.amendment008Sha256,
        pinnedPackages: Object.fromEntries(registry.descriptors.map((descriptor) => [
          descriptor.armId,
          { name: descriptor.packageName ?? null, version: descriptor.version ?? null }
        ])),
        pinnedModels,
        probeReports: nativeProbeReports,
        now: verificationInstant
      });
    } catch {
      nativeAttemptEvidence = Object.freeze({
        satisfiedRecoveries: new Set(),
        findings: Object.freeze([{ code: 'NATIVE_ATTEMPT_EVIDENCE_CONTEXT_INVALID' }]),
        note: 'the native-attempt policy or committed runtime pins could not be verified'
      });
    }
    for (const [armId, recovery] of normalizedNativeAttemptPolicy?.policies ?? []) {
      for (const [requestClass, categories] of Object.entries(recovery)) {
        for (const category of categories) {
          const key = `${armId}\u001f${requestClass}\u001f${category}`;
          if (nativeAttemptEvidence.satisfiedRecoveries.has(key)) continue;
          blockers.push({
            kind: 'native-attempt-evidence',
            code: 'NATIVE_ATTEMPT_EVIDENCE_REQUIRED',
            armId,
            requestClass,
            category,
            note: nativeAttemptEvidence.note
          });
        }
      }
    }
    if (normalizedNativeAttemptPolicy === null) {
      blockers.push({
        kind: 'native-attempt-evidence',
        code: 'NATIVE_ATTEMPT_POLICY_INVALID',
        note: nativeAttemptEvidence.note
      });
    }
  }

  for (const descriptor of registry.descriptors) {
    if (descriptor.requiredService === null) continue;
    const unverified = descriptor.requiredServiceNames
      .filter((name) => !serviceEvidence.verifiedServices.has(name));
    if (unverified.length === 0) continue;
    blockers.push({
      kind: 'required-service',
      armId: descriptor.armId,
      service: descriptor.requiredService,
      unverified,
      note: serviceEvidence.note
    });
  }
  blockers.push(...prerequisiteBlockers);

  return {
    applicability,
    providerBudget,
    declaredCounts,
    derivedCounts,
    preconditionEvidence: {
      satisfiedPreconditions: [...preconditionEvidence.satisfiedPreconditions].sort(),
      findings: preconditionEvidence.findings,
      note: preconditionEvidence.note
    },
    nativeAttemptEvidence: nativeAttemptEvidence === null ? {
      satisfiedRecoveries: [],
      findings: [],
      note: 'no native recovery policy was supplied to this direct readiness call'
    } : {
      satisfiedRecoveries: [...nativeAttemptEvidence.satisfiedRecoveries].sort(),
      findings: nativeAttemptEvidence.findings,
      note: nativeAttemptEvidence.note
    },
    serviceEvidence: {
      evidenceSha256: serviceEvidence.evidenceSha256 ?? null,
      verifiedServices: [...serviceEvidence.verifiedServices].sort(),
      findings: serviceEvidence.findings,
      note: serviceEvidence.note
    },
    // Not rendered by the CLI preflight report. The run path consumes this
    // module-minted snapshot instead of reopening --service-evidence.
    verifiedServiceEvidence: serviceEvidence.evidenceSha256 === null ? null : capturedServiceEvidence,
    readiness: blockers.length === 0 ? 'READY' : 'NOT READY',
    blockers
  };
}

/**
 * Route each arm to the runtime the competitor lock names for it.
 *
 * The registry decides which host an arm gets; this only dispatches. An arm
 * whose runtime kind has no host is a refusal, not a fallback to some other
 * host that happens to be available - running an arm on a runtime the lock does
 * not describe would report a measurement of software nobody pinned.
 */
export function createV11AdapterExecutor(input) {
  const { registry, hosts } = input;
  if (!isPlainRecord(hosts)) {
    throw new V11RunError('CONTRACT_FAILURE', 'adapter hosts must be an object');
  }
  const measuredRoots = new Set();
  const measuredRootKey = (request) => {
    if (!isPlainRecord(request)) return null;
    const fields = ['runId', 'attemptId', 'armId', 'scenarioId', 'phase', 'operation'];
    if (fields.some((field) => (
      typeof request[field] !== 'string' || request[field].trim().length === 0
    ))
      || !Number.isSafeInteger(request.repetition) || request.repetition < 0) {
      return null;
    }
    return [...fields.slice(0, 4), 'repetition', ...fields.slice(4)]
      .map((field) => {
        const value = String(request[field]);
        return `${value.length}:${value}`;
      })
      .join('|');
  };
  const byArm = new Map();
  for (const descriptor of registry.descriptors) {
    const host = hosts[descriptor.kind];
    if (typeof host !== 'function') {
      throw new V11RunError(
        'RUNTIME_UNAVAILABLE',
        `arm ${descriptor.armId} needs a ${descriptor.kind} runtime host, which is not configured`
      );
    }
    byArm.set(descriptor.armId, host(descriptor));
  }

  return async function executeAdapter(request, options) {
    const root = measuredRootKey(request);
    if (root !== null) {
      if (measuredRoots.has(root)) {
        throw new V11RunError('HARNESS_OPERATION_REEXECUTION', 'A measured adapter root operation may be invoked only once');
      }
      measuredRoots.add(root);
    }
    const execute = byArm.get(request.armId);
    if (execute === undefined) {
      throw new V11RunError('RUNTIME_UNAVAILABLE', `no runtime is bound to arm ${request.armId}`);
    }
    return await execute(request, options);
  };
}

/**
 * Run the non-scored acceptance plan and connect its output to the validator
 * and the aggregator.
 *
 * The readiness gate comes first and is not overridable. There is deliberately
 * no flag that starts a run over its own blockers: the blockers describe
 * evidence the result would be interpreted against, so a run that ignored them
 * would produce numbers no one could hold to anything.
 */
export async function executeV11AcceptanceRun(input) {
  const {
    registry,
    definition,
    scenarios,
    nativeAttemptPolicy = null,
    benchmarkRoot,
    satisfiedPreconditions = [],
    preconditionEvidencePath = null,
    nativeAttemptEvidencePath = null,
    serviceEvidencePath = null,
    verifiedServiceEvidence = null,
    verificationInstant = undefined,
    runId,
    attemptId,
    executeAdapter,
    buildOuterRequest,
    requestOuter,
    progress,
    persistUnit,
    now,
    monotonicNow,
    sourceHashes,
    implementationLockHash,
    environmentLockHash,
    amendment002Path,
    amendment003Path,
    amendment004Path,
    amendment005Path,
    amendment005SidecarPath,
    amendment006Path,
    amendment006SidecarPath,
    amendment008Path,
    amendment008SidecarPath,
    resume = null,
    signal = undefined,
    // A production run owns a provider meter and two ledgers. The runner already
    // knows how to close them at the right moment - after the plan loop and
    // before the terminal progress event - but this function did not forward the
    // hook, so the only place left to close them was the caller's `finally`,
    // i.e. after the run record had already been written. A provider ledger that
    // is still being appended to when the run declares itself COMPLETE is not
    // evidence of that run.
    closeResources = undefined,
    heartbeatIntervalMs = undefined,
    // The run's own provider evidence, judged before the run is reported.
    //
    // Required rather than optional, and called here rather than by the
    // caller, for the reason the reconciliation exists at all: the meter wrote
    // a ledger on every run and nothing read it back, so three of the
    // reconciler's discrepancy codes were unreachable in production. Making it
    // the caller's step would leave the same hole one level up - a review
    // deleted exactly that call from the CLI and the whole suite stayed green.
    reconcileProviderEvidence,
    readFileImpl = readFile
  } = input;


  // A real run uses the one prompt builder this methodology defines. Nothing
  // else may be substituted here.
  //
  // The runner accepts an injected builder because that is what makes it
  // testable, and three rounds of review went into narrowing what such a
  // builder can see: it is handed phase, scenario and native context and
  // nothing that identifies the arm. But no runtime check can make an arbitrary
  // injected function pure. A builder that counts its own calls can recover the
  // unit index, because the runner calls it a fixed number of times per unit,
  // and from there the arm - the plan is ordered. The rebuild check below
  // catches call-order dependence whose period is not aligned to that stride,
  // and misses one that is.
  //
  // Rather than add a fifth detector to an arms race, the production path
  // refuses anything but the canonical builder. Detection stays where it
  // belongs, guarding the injected path the tests use; identity guards the path
  // a measurement would actually be taken on.
  if (buildOuterRequest !== buildV11Prompt) {
    throw new V11RunError(
      'NON_CANONICAL_PROMPT_BUILDER',
      'an acceptance run may only use the frozen v1.1 prompt builder'
    );
  }

  const readinessReport = await computeV11Readiness({
    providerBudget: input.providerBudget,
    runId,
    attemptId,
    implementationLockHash,
    registry,
    definition,
    scenarios,
    nativeAttemptPolicy,
    sourceHashes,
    campaign: input.campaign ?? null,
    benchmarkRoot,
    satisfiedPreconditions,
    preconditionEvidencePath,
    nativeAttemptEvidencePath,
    serviceEvidencePath,
    verifiedServiceEvidence,
    verificationInstant,
    readFileImpl
  });
  if (readinessReport.readiness !== 'READY') {
    throw Object.assign(
      new V11RunError('NOT_READY', 'The v1.1 candidate is not ready to execute an acceptance run'),
      { readiness: readinessReport }
    );
  }

  // After the readiness refusal, so a blocked candidate still refuses by name,
  // and before the plan loop, so a run cannot execute 308 units and only then
  // discover it has no way to judge its own provider traffic.
  if (typeof reconcileProviderEvidence !== 'function') {
    throw new Error('a v1.1 acceptance run must reconcile its own provider evidence');
  }

  const raw = await runV11Benchmark({
    runId,
    attemptId,
    scored: false,
    arms: definition.arms.map(({ id, name, applicability }) => ({
      id,
      name,
      applicability: structuredClone(applicability)
    })),
    scenarios: structuredClone(scenarios),
    repetitions: definition.commonExecution.repetitions,
    seeds: [...definition.commonExecution.randomSeeds],
    preregistrationSha256: sourceHashes.preregistrationSha256,
    amendment001Sha256: sourceHashes.amendment001Sha256,
    amendment002Sha256: sourceHashes.amendment002Sha256,
    amendment003Sha256: sourceHashes.amendment003Sha256,
    amendment004Sha256: sourceHashes.amendment004Sha256,
    amendment005Sha256: sourceHashes.amendment005Sha256,
    amendment006Sha256: sourceHashes.amendment006Sha256,
    amendment008Sha256: sourceHashes.amendment008Sha256,
    implementationLockHash,
    environmentLockHash,
    amendment002Path,
    amendment003Path,
    amendment004Path,
    amendment005Path,
    amendment005SidecarPath,
    amendment006Path,
    amendment006SidecarPath,
    amendment008Path,
    amendment008SidecarPath,
    progress,
    persistUnit,
    now,
    monotonicNow,
    executeAdapter,
    buildOuterRequest,
    requestOuter,
    ...(resume === null ? {} : { resume }),
    ...(signal === undefined ? {} : { signal }),
    ...(closeResources === undefined ? {} : { closeResources }),
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs })
  });

  // The validator and the aggregator take the resolved plan, not the acceptance
  // file: on disk `definition.scenarios` is a path and a digest, and the run
  // they are checking was executed against the scenarios that path resolved to.
  const resolvedDefinition = {
    arms: definition.arms.map(({ id, name, applicability }) => ({
      id,
      name,
      applicability: structuredClone(applicability)
    })),
    commonExecution: {
      repetitions: definition.commonExecution.repetitions,
      randomSeeds: [...definition.commonExecution.randomSeeds]
    },
    scenarios: structuredClone(scenarios)
  };
  const validation = validateRawRun(
    raw,
    resolvedDefinition,
    sourceHashes.preregistrationSha256,
    sourceHashes
  );
  const aggregate = aggregateRun(raw, resolvedDefinition, { trustedSourceHashes: sourceHashes });

  // After `closeResources`, so the ledger is complete, and after the record,
  // so there is something to compare it against.
  const providerEvidence = await reconcileProviderEvidence(raw);
  if (providerEvidence === null || typeof providerEvidence !== 'object'
    || typeof providerEvidence.status !== 'string') {
    throw new Error('provider evidence reconciliation must report a status');
  }

  return { readiness: readinessReport, raw, validation, aggregate, providerEvidence };
}
