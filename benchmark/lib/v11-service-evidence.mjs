// Verified service evidence for the v1.1 readiness gate.
//
// Two arms of the frozen plan cannot execute without a service the repository
// does not contain: Graphiti needs a Neo4j-compatible database and the common
// model endpoint, and Cognee needs the common model endpoint. Until now the
// readiness gate emitted those as unconditional blockers, so provisioning the
// services could not clear them and a preflight could never reach READY. That
// was correct while nothing could describe a provisioned service, and it is
// what this module replaces.
//
// What this module does is narrow on purpose. It takes a record of a health
// probe and checks it against the two committed statements the repository
// already holds - `service-images.json`, which says which services must be
// pinned, and `model-weights.lock.json`, which says which model weights the
// common endpoint must serve - and reports which services that record
// establishes. Every one of those checks compares operator-supplied evidence to
// committed bytes; none of them takes the evidence's word for anything the
// repository can state itself.
//
// What this module cannot do is establish that the probe ever ran. The record
// is a file, and a file can be written by hand. That limit is the same one the
// immutable-prerequisite gates carry, it is stated in `note` rather than
// implied away, and it is the reason `v11-service-probe` exists: the harness
// writes this record from probes it performs itself, so the honest path is to
// produce it rather than compose it.
//
// The default is refusal in every direction. Absent evidence verifies nothing.
// Malformed evidence verifies nothing. Evidence older than the freshness window
// verifies nothing, because a service that answered yesterday is not a service
// that is answering now. A single failed or stale check withholds verification
// from its own service and from no other.

export const SERVICE_EVIDENCE_SCHEMA = 'shadowgraph.v11.service-evidence';
export const SERVICE_EVIDENCE_VERSION = 1;

/**
 * How long a probe stays good for.
 *
 * Long enough to provision, capture and then start a run without re-probing;
 * short enough that a record cannot be kept around and reused against a service
 * that has since been stopped, repointed or reconfigured.
 */
export const SERVICE_EVIDENCE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export const SERVICE_EVIDENCE_NOTE =
  'shape, freshness and agreement with the committed service manifest and model '
  + 'weight lock only; this check cannot establish that the recorded probe was '
  + 'actually performed against the described service';

/**
 * Probe kinds this record may carry. Unknown kinds are refused, not ignored: a
 * record naming a check this module does not understand would otherwise verify
 * a service on the strength of something nobody defined.
 *
 * `image-identity` records whether the probed container is running the image
 * the committed manifest pins. It is recorded rather than required here - the
 * implementation lock is the authority on which bytes a run may claim, and
 * duplicating that judgement in the readiness gate would put two answers to one
 * question in the repository.
 */
export const SERVICE_CHECK_KINDS = Object.freeze([
  'image-identity',
  'http-status',
  'cypher-statement',
  'openai-chat-completions',
  'openai-embeddings',
  'model-weights'
]);

const SHA256_REFERENCE = /^sha256:[a-f0-9]{64}$/u;

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Parse an ISO instant, returning null rather than NaN for anything else. */
function instantOf(value) {
  if (!isNonEmptyString(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read the committed service manifest into `name -> image`.
 *
 * Accepts the same two shapes `V11_PREREQUISITE_GATES` accepts, so a manifest
 * that satisfies the prerequisite gate is readable here rather than needing a
 * second, subtly different spelling.
 */
function declaredImages(serviceManifest) {
  if (!isPlainRecord(serviceManifest)) return null;
  const services = Array.isArray(serviceManifest.services)
    ? serviceManifest.services
    : serviceManifest.serviceImages;
  if (!Array.isArray(services) || services.length === 0) return null;
  const images = new Map();
  for (const service of services) {
    if (!isPlainRecord(service) || !isNonEmptyString(service.name) || !isNonEmptyString(service.image)) {
      return null;
    }
    images.set(service.name, service.image);
  }
  return images;
}

/** Read the committed weight lock into `modelId -> weightsDigest`. */
function lockedWeights(modelWeights) {
  if (!isPlainRecord(modelWeights) || !Array.isArray(modelWeights.models) || modelWeights.models.length === 0) {
    return null;
  }
  const weights = new Map();
  for (const model of modelWeights.models) {
    if (!isPlainRecord(model)
      || !isNonEmptyString(model.modelId)
      || !isNonEmptyString(model.weightsDigest)
      || !SHA256_REFERENCE.test(model.weightsDigest)) {
      return null;
    }
    weights.set(model.modelId, model.weightsDigest);
  }
  return weights;
}

/**
 * Check one service entry against the committed baseline.
 *
 * Returns the findings that withhold verification from this service. An empty
 * array means the record establishes it; anything else means it does not, and
 * says which part failed.
 */
function serviceFindings(service, { images, weights, now }) {
  const findings = [];
  if (!isPlainRecord(service) || !isNonEmptyString(service.name)) {
    return [{ code: 'SERVICE_ENTRY_MALFORMED', service: null }];
  }
  const name = service.name;
  const push = (code, extra = {}) => findings.push({ code, service: name, ...extra });

  const declaredImage = images.get(name);
  if (declaredImage === undefined) {
    push('SERVICE_NOT_DECLARED', {
      detail: 'the committed service manifest does not declare a service by this name'
    });
    return findings;
  }
  if (service.image !== declaredImage) {
    push('SERVICE_IMAGE_MISMATCH', { declared: declaredImage, recorded: service.image ?? null });
  }
  if (!isNonEmptyString(service.resolvedDigest) || !SHA256_REFERENCE.test(service.resolvedDigest)) {
    push('SERVICE_DIGEST_MALFORMED', {
      detail: 'a resolved image digest must be sha256: followed by 64 lowercase hex characters'
    });
  }
  if (!isNonEmptyString(service.containerId)) {
    push('SERVICE_CONTAINER_UNIDENTIFIED', {
      detail: 'the record must name the container the probe addressed'
    });
  }

  const checks = Array.isArray(service.checks) ? service.checks : null;
  if (checks === null || checks.length === 0) {
    push('SERVICE_UNCHECKED', { detail: 'a service with no recorded check establishes nothing' });
  } else {
    for (const check of checks) {
      if (!isPlainRecord(check)
        || !SERVICE_CHECK_KINDS.includes(check.kind)
        || !isNonEmptyString(check.endpoint)) {
        push('SERVICE_CHECK_MALFORMED', { detail: 'each check needs a known kind and an endpoint' });
        continue;
      }
      if (check.outcome !== 'PASS') {
        push('SERVICE_CHECK_FAILED', { check: check.kind, outcome: check.outcome ?? null });
        continue;
      }
      const observedAt = instantOf(check.observedAt);
      if (observedAt === null) {
        push('SERVICE_CHECK_MALFORMED', { check: check.kind, detail: 'observedAt is not an instant' });
        continue;
      }
      if (observedAt > now) {
        push('SERVICE_CHECK_FUTURE_DATED', { check: check.kind });
        continue;
      }
      if (now - observedAt > SERVICE_EVIDENCE_MAX_AGE_MS) {
        push('SERVICE_CHECK_STALE', { check: check.kind, observedAt: check.observedAt });
      }
    }
  }

  // A service that claims to serve models is held to the whole locked set. The
  // benchmark's common endpoint is one endpoint by construction: an arm that
  // reached one host for its LLM calls and another for its embeddings would not
  // be running against the configuration the methodology pins, so a partial
  // claim is refused rather than merged with somebody else's.
  const servedModels = Array.isArray(service.servedModels) ? service.servedModels : null;
  if (servedModels === null) {
    push('SERVICE_ENTRY_MALFORMED', { detail: 'servedModels must be an array, empty if none are served' });
  } else if (servedModels.length > 0) {
    const served = new Map();
    for (const model of servedModels) {
      if (!isPlainRecord(model) || !isNonEmptyString(model.modelId) || !isNonEmptyString(model.weightsDigest)) {
        push('SERVICE_MODEL_MALFORMED', { detail: 'each served model needs a modelId and a weightsDigest' });
        continue;
      }
      served.set(model.modelId, model.weightsDigest);
    }
    for (const [modelId, weightsDigest] of weights) {
      const recorded = served.get(modelId);
      if (recorded === undefined) push('SERVICE_MODEL_ABSENT', { modelId });
      else if (recorded !== weightsDigest) {
        push('SERVICE_MODEL_DIGEST_MISMATCH', { modelId, locked: weightsDigest, recorded });
      }
    }
  }

  return findings;
}

/**
 * Decide which services a probe record establishes.
 *
 * `evidence` is the operator-supplied record; `serviceManifest` and
 * `modelWeights` are the committed statements it is checked against; `now` is
 * the instant freshness is measured from. Returns the set of service names the
 * record establishes, the findings that withheld the rest, and the note that
 * says what this verification does not cover.
 */
export function verifyServiceEvidence(input) {
  const { evidence, serviceManifest, modelWeights, now } = input ?? {};
  const empty = (findings) => Object.freeze({
    verifiedServices: new Set(),
    findings: Object.freeze(findings),
    note: SERVICE_EVIDENCE_NOTE
  });

  if (evidence === null || evidence === undefined) {
    return empty([{
      code: 'SERVICE_EVIDENCE_ABSENT',
      detail: 'no service health evidence was supplied'
    }]);
  }
  if (!Number.isFinite(now)) {
    return empty([{ code: 'SERVICE_EVIDENCE_UNTIMED', detail: 'a verification instant is required' }]);
  }

  // Both committed baselines must be readable before anything is compared
  // against them. Verifying evidence against a baseline that is itself missing
  // would check the record only against itself.
  const images = declaredImages(serviceManifest);
  if (images === null) {
    return empty([{
      code: 'SERVICE_MANIFEST_UNUSABLE',
      detail: 'the committed service manifest is absent or does not declare services'
    }]);
  }
  const weights = lockedWeights(modelWeights);
  if (weights === null) {
    return empty([{
      code: 'MODEL_WEIGHT_LOCK_UNUSABLE',
      detail: 'the committed model weight lock is absent or declares no locked model'
    }]);
  }

  if (!isPlainRecord(evidence)
    || evidence.schema !== SERVICE_EVIDENCE_SCHEMA
    || evidence.version !== SERVICE_EVIDENCE_VERSION) {
    return empty([{
      code: 'SERVICE_EVIDENCE_MALFORMED',
      detail: `evidence must declare schema ${SERVICE_EVIDENCE_SCHEMA} version ${SERVICE_EVIDENCE_VERSION}`
    }]);
  }
  if (!Array.isArray(evidence.services) || evidence.services.length === 0) {
    return empty([{
      code: 'SERVICE_EVIDENCE_MALFORMED',
      detail: 'evidence must carry a non-empty services array'
    }]);
  }

  const observedAt = instantOf(evidence.observedAt);
  if (observedAt === null) {
    return empty([{ code: 'SERVICE_EVIDENCE_MALFORMED', detail: 'observedAt is not an instant' }]);
  }
  if (observedAt > now) {
    return empty([{ code: 'SERVICE_EVIDENCE_FUTURE_DATED', observedAt: evidence.observedAt }]);
  }
  if (now - observedAt > SERVICE_EVIDENCE_MAX_AGE_MS) {
    return empty([{
      code: 'SERVICE_EVIDENCE_STALE',
      observedAt: evidence.observedAt,
      maxAgeMs: SERVICE_EVIDENCE_MAX_AGE_MS
    }]);
  }

  const findings = [];
  const verifiedServices = new Set();
  let servesLockedModels = false;
  for (const service of evidence.services) {
    const serviceResult = serviceFindings(service, { images, weights, now });
    if (serviceResult.length === 0) {
      verifiedServices.add(service.name);
      if (Array.isArray(service.servedModels) && service.servedModels.length > 0) {
        servesLockedModels = true;
      }
    } else findings.push(...serviceResult);
  }

  // The locked weights have to be served in full by one verified endpoint. A
  // record where nothing serves them describes a provisioned database and no
  // common model endpoint, which is not the configuration either blocked arm
  // needs, so nothing in it is treated as established.
  if (!servesLockedModels) {
    findings.push({
      code: 'SERVICE_MODEL_ENDPOINT_ABSENT',
      detail: 'no verified service serves the complete set of locked model weights'
    });
    return empty(findings);
  }

  return Object.freeze({
    verifiedServices,
    findings: Object.freeze(findings),
    note: SERVICE_EVIDENCE_NOTE
  });
}
