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

import { aggregateRun } from './aggregate.mjs';
import { buildV11Prompt } from './v11-prompts.mjs';
import { validateRawRun } from './validate.mjs';
import { runV11Benchmark } from './v11-runner.mjs';

export class V11RunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'V11RunError';
    this.code = code;
  }
}

const FULL_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const BARE_SHA256 = /^[a-f0-9]{64}$/u;

// A lockable service reference: a repository plus an explicit tag, with no
// digest suffix. Kept deliberately in step with `assertLockableImage` and
// `MUTABLE_LATEST` in implementation-lock.mjs, which owns this file's contract.
const LOCKABLE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MUTABLE_LATEST = /(?:^|[/:@])latest(?:$|[/:@])/iu;

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
    // The canonical `services` array is what implementation-lock.mjs parses at
    // this path; `serviceImages` is accepted for the older shape. An image must
    // be a lockable repository reference - a repository plus an explicit,
    // non-`latest` tag. Requiring an inline `@sha256:` digest here would be
    // wrong: assertLockableImage refuses a reference containing '@', so such a
    // manifest could satisfy readiness and still never produce a lock. Digests
    // are operator-supplied run evidence; the manifest is the committed
    // statement of which services must carry one.
    isSatisfied: (value) => {
      const services = Array.isArray(value?.services) ? value.services : value?.serviceImages;
      return Array.isArray(services) && services.length > 0
        && services.every((service) => (
          isPlainRecord(service)
          && typeof service.name === 'string' && service.name.length > 0
          && typeof service.image === 'string'
          && LOCKABLE_IMAGE.test(service.image)
          && !MUTABLE_LATEST.test(service.image)
        ));
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
    return { state: 'present', value: JSON.parse(text) };
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
    benchmarkRoot,
    satisfiedPreconditions = [],
    readFileImpl = readFile
  } = input;

  const declared = Object.fromEntries(definition.arms.map((arm) => [arm.id, arm.applicability]));
  const applicability = registry.verifyApplicability(declared, satisfiedPreconditions);
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
  for (const finding of applicability.findings) {
    blockers.push({ kind: 'applicability', ...finding });
  }
  for (const mismatch of countMismatches) {
    blockers.push({ kind: 'expected-counts', ...mismatch });
  }
  for (const descriptor of registry.descriptors) {
    if (descriptor.requiredService !== null) {
      blockers.push({
        kind: 'required-service',
        armId: descriptor.armId,
        service: descriptor.requiredService
      });
    }
  }
  for (const { requirement, file, isSatisfied } of V11_PREREQUISITE_GATES) {
    const gate = await readGateJson(path.join(benchmarkRoot, file), readFileImpl);
    const reason = unmetReason(gate, isSatisfied);
    if (reason !== null) {
      blockers.push({
        kind: 'immutable-prerequisite',
        requirement,
        detail: reason,
        note: 'presence and shape only; this check cannot establish authenticity'
      });
    }
  }

  return {
    applicability,
    declaredCounts,
    derivedCounts,
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
    benchmarkRoot,
    satisfiedPreconditions = [],
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
    resume = null,
    signal = undefined,
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
    registry,
    definition,
    scenarios,
    benchmarkRoot,
    satisfiedPreconditions,
    readFileImpl
  });
  if (readinessReport.readiness !== 'READY') {
    throw Object.assign(
      new V11RunError('NOT_READY', 'The v1.1 candidate is not ready to execute an acceptance run'),
      { readiness: readinessReport }
    );
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
    implementationLockHash,
    environmentLockHash,
    amendment002Path,
    progress,
    persistUnit,
    now,
    monotonicNow,
    executeAdapter,
    buildOuterRequest,
    requestOuter,
    ...(resume === null ? {} : { resume }),
    ...(signal === undefined ? {} : { signal })
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
  const validation = validateRawRun(raw, resolvedDefinition, sourceHashes.preregistrationSha256);
  const aggregate = aggregateRun(raw, resolvedDefinition, { trustedSourceHashes: sourceHashes });

  return { readiness: readinessReport, raw, validation, aggregate };
}
