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

import { createHash } from 'node:crypto';

import { parseServiceManifestDocument } from './implementation-lock.mjs';

export const SERVICE_EVIDENCE_SCHEMA = 'shadowgraph.v11.service-evidence';
export const SERVICE_EVIDENCE_VERSION = 2;
export const SERVICE_IMAGE_IDENTITY_SCHEMA = 'shadowgraph.v11.service-image-identity';
export const SERVICE_IMAGE_IDENTITY_VERSION = 1;
export const VERIFIED_SERVICE_EVIDENCE_SCHEMA = 'shadowgraph.v11.verified-service-evidence';
export const VERIFIED_SERVICE_EVIDENCE_VERSION = 1;

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
 * `image-identity` is mandatory. It binds the probe's named container and
 * local image observation to the exact platform-manifest and registry-index
 * identities the committed schema-v3 manifest attests. A matching tag, a
 * container name, or a copied digest alone never establishes service readiness.
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
const SERVICE_IMAGE_IDENTITY_FIELDS = Object.freeze([
  'schema', 'version', 'serviceName', 'image', 'platformManifestDigest',
  'registryIndexDigest', 'platform', 'immutableReference', 'containerReference',
  'containerId', 'containerImageId'
]);
const VERIFIED_SERVICE_EVIDENCE_FIELDS = Object.freeze([
  'schema', 'version', 'evidenceSha256', 'serviceImages', 'verifiedServices'
]);
const capturedServiceEvidence = new WeakMap();

function hasExactKeys(value, fields) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === fields.length
    && actual.every((key, index) => key === [...fields].sort()[index]);
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function immutableReference(image, digest) {
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  return `${lastColon > lastSlash ? image.slice(0, lastColon) : image}@${digest}`;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

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

/** Read the committed service manifest into `name -> immutable platform identity`. */
function declaredImages(serviceManifest) {
  try {
    return parseServiceManifestDocument(serviceManifest);
  } catch {
    return null;
  }
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

function requiredImageIdentityFindings(service, declaredService, checks, push) {
  const identity = service.imageIdentity;
  if (identity === undefined || identity === null) {
    push('SERVICE_IMAGE_IDENTITY_REQUIRED', {
      detail: 'a required immutable image identity observation is absent'
    });
    return;
  }
  if (!hasExactKeys(identity, SERVICE_IMAGE_IDENTITY_FIELDS)
    || identity.schema !== SERVICE_IMAGE_IDENTITY_SCHEMA
    || identity.version !== SERVICE_IMAGE_IDENTITY_VERSION
    || !isNonEmptyString(identity.serviceName)
    || !isNonEmptyString(identity.image)
    || !isNonEmptyString(identity.platformManifestDigest)
    || !isNonEmptyString(identity.registryIndexDigest)
    || !isNonEmptyString(identity.platform)
    || !isNonEmptyString(identity.immutableReference)
    || !isNonEmptyString(identity.containerReference)
    || !isNonEmptyString(identity.containerId)
    || !isNonEmptyString(identity.containerImageId)
    || !SHA256_REFERENCE.test(identity.platformManifestDigest)
    || !SHA256_REFERENCE.test(identity.registryIndexDigest)
    || !SHA256_REFERENCE.test(identity.containerImageId)) {
    push('SERVICE_IMAGE_IDENTITY_MALFORMED', {
      detail: 'image identity must be a complete schema-v3 platform-manifest observation'
    });
    return;
  }
  if (identity.serviceName.toLowerCase() !== service.name.toLowerCase()
    || identity.containerId !== service.containerId) {
    push('SERVICE_IMAGE_IDENTITY_CONTAINER_MISMATCH', {
      detail: 'image identity is not bound to this exact service entry and Docker container'
    });
  }
  if (identity.platform !== declaredService.platform) {
    push('SERVICE_IMAGE_IDENTITY_PLATFORM_MISMATCH', {
      declared: declaredService.platform,
      recorded: identity.platform
    });
  }
  if (identity.image !== declaredService.image
    || identity.platformManifestDigest !== declaredService.digest
    || identity.registryIndexDigest !== declaredService.registryIndexDigest
    || identity.immutableReference !== immutableReference(declaredService.image, declaredService.digest)) {
    push('SERVICE_IMAGE_IDENTITY_MISMATCH', {
      detail: 'image identity does not match the committed schema-v3 OCI attestation'
    });
  }
  const imageChecks = Array.isArray(checks)
    ? checks.filter((check) => isPlainRecord(check) && check.kind === 'image-identity')
    : [];
  if (imageChecks.length !== 1) {
    push('SERVICE_IMAGE_IDENTITY_REQUIRED', {
      detail: 'exactly one passing image-identity check is required for each service'
    });
  } else if (imageChecks[0].endpoint !== identity.containerReference) {
    push('SERVICE_IMAGE_IDENTITY_CONTAINER_MISMATCH', {
      detail: 'the image-identity check is not bound to the recorded container reference'
    });
  } else if (imageChecks[0].outcome !== 'PASS') {
    push('SERVICE_IMAGE_IDENTITY_CHECK_FAILED', { outcome: imageChecks[0].outcome ?? null });
  }
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

  const declaredService = images.get(name.toLowerCase());
  if (declaredService === undefined) {
    push('SERVICE_NOT_DECLARED', {
      detail: 'the committed service manifest does not declare a service by this name'
    });
    return findings;
  }
  if (service.image !== declaredService.image) {
    push('SERVICE_IMAGE_MISMATCH', { declared: declaredService.image, recorded: service.image ?? null });
  }
  if (!isNonEmptyString(service.resolvedDigest) || !SHA256_REFERENCE.test(service.resolvedDigest)) {
    push('SERVICE_DIGEST_MALFORMED', {
      detail: 'a resolved image digest must be sha256: followed by 64 lowercase hex characters'
    });
  } else if (service.resolvedDigest !== declaredService.digest) {
    push('SERVICE_PLATFORM_MANIFEST_DIGEST_MISMATCH', {
      declared: declaredService.digest,
      recorded: service.resolvedDigest,
      detail: 'the observed container identity is not the committed OCI platform-manifest digest'
    });
  }
  if (!isNonEmptyString(service.containerId)) {
    push('SERVICE_CONTAINER_UNIDENTIFIED', {
      detail: 'the record must name the container the probe addressed'
    });
  }

  const checks = Array.isArray(service.checks) ? service.checks : null;
  requiredImageIdentityFindings(service, declaredService, checks, push);
  if (checks === null || checks.length === 0) {
    push('SERVICE_UNCHECKED', { detail: 'a service with no recorded check establishes nothing' });
  } else {
    // Which kinds are present matters, not only that some passed. The kind list
    // is an allow-list, so without this a record could drop a whole probe - or a
    // refactor could stop performing one - and still verify on what remained.
    //
    // The requirement is derived from the record's own model claim rather than
    // from a self-declared service kind, because a self-declared kind is
    // another thing an operator could choose. A service claiming to serve the
    // locked weights is claiming to be the common endpoint, and the endpoint has
    // to answer on both surfaces the arms use.
    const kinds = new Set(checks.filter(isPlainRecord).map((check) => check.kind));
    const servesModels = Array.isArray(service.servedModels) && service.servedModels.length > 0;
    if (servesModels) {
      for (const required of ['openai-chat-completions', 'openai-embeddings']) {
        if (!kinds.has(required)) {
          push('SERVICE_ENDPOINT_CHECKS_MISSING', {
            check: required,
            detail: 'a service that claims to serve the locked weights must answer on both endpoints'
          });
        }
      }
    } else if ([...kinds].every((kind) => kind === 'image-identity')) {
      // Identity says which image is running. It says nothing about whether the
      // thing inside it responds.
      push('SERVICE_LIVENESS_UNPROVEN', {
        detail: 'an image-identity check alone does not establish that the service answers'
      });
    }
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
      if (now - observedAt >= SERVICE_EVIDENCE_MAX_AGE_MS) {
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
  // Expires at the window rather than after it, matching
  // v11-precondition-evidence. One boundary rule for both gates.
  if (now - observedAt >= SERVICE_EVIDENCE_MAX_AGE_MS) {
    return empty([{
      code: 'SERVICE_EVIDENCE_STALE',
      observedAt: evidence.observedAt,
      maxAgeMs: SERVICE_EVIDENCE_MAX_AGE_MS
    }]);
  }

  // A name that appears twice is refused outright, before any entry is judged.
  // Without this, a record could pair a healthy entry with a broken duplicate of
  // the same service: the healthy one would verify the name, the broken one
  // would only add a finding, and the blocker would clear. Which of two
  // contradictory descriptions of one service is true is not a question this
  // module can answer, so it declines to pick.
  const duplicated = new Set();
  const namesSeen = new Set();
  for (const service of evidence.services) {
    const name = isPlainRecord(service) ? service.name : null;
    if (!isNonEmptyString(name)) continue;
    const canonicalName = name.toLowerCase();
    if (namesSeen.has(canonicalName)) duplicated.add(canonicalName);
    namesSeen.add(canonicalName);
  }

  const findings = [];
  const verifiedServices = new Set();
  let servesLockedModels = false;
  for (const service of evidence.services) {
    if (isPlainRecord(service) && isNonEmptyString(service.name)
      && duplicated.has(service.name.toLowerCase())) {
      continue;
    }
    const serviceResult = serviceFindings(service, { images, weights, now });
    if (serviceResult.length === 0) {
      verifiedServices.add(service.name.toLowerCase());
      if (Array.isArray(service.servedModels) && service.servedModels.length > 0) {
        servesLockedModels = true;
      }
    } else findings.push(...serviceResult);
  }
  for (const name of duplicated) {
    findings.push({
      code: 'SERVICE_DUPLICATE_ENTRY',
      service: name,
      detail: 'the record describes this service more than once, so neither description is used'
    });
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

function snapshotFailure(code, detail) {
  return Object.freeze({
    verifiedServices: new Set(),
    findings: Object.freeze([{ code, detail }]),
    note: SERVICE_EVIDENCE_NOTE,
    serviceImages: Object.freeze([]),
    evidenceSha256: null
  });
}

function serviceImagesForVerifiedServices(images, verifiedServices) {
  const selected = [];
  for (const name of [...verifiedServices].sort()) {
    const declared = images.get(name);
    if (declared === undefined) return null;
    selected.push(Object.freeze({
      name: declared.name,
      image: declared.image,
      digest: declared.digest
    }));
  }
  return Object.freeze(selected.sort((left, right) => left.name.localeCompare(right.name)));
}

function sameServiceImages(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((entry, index) => (
      isPlainRecord(entry)
      && entry.name === right[index]?.name
      && entry.image === right[index]?.image
      && entry.digest === right[index]?.digest
    ));
}

/**
 * Capture exactly the UTF-8 bytes a readiness decision verified. The snapshot
 * deliberately has module-private provenance: only this module can mint one,
 * so a raw file object cannot be substituted into runtime binding after a
 * preflight check.
 */
export function captureVerifiedServiceEvidence(input) {
  const { evidenceText, serviceManifest, modelWeights, now } = input ?? {};
  if (typeof evidenceText !== 'string') {
    throw new Error('service evidence bytes must be UTF-8 text');
  }
  let evidence;
  try {
    evidence = JSON.parse(evidenceText);
  } catch {
    throw new Error('service evidence bytes are not valid JSON');
  }
  const images = declaredImages(serviceManifest);
  if (images === null) throw new Error('committed service manifest is unusable');
  const verification = verifyServiceEvidence({ evidence, serviceManifest, modelWeights, now });
  const serviceImages = serviceImagesForVerifiedServices(images, verification.verifiedServices);
  if (serviceImages === null) throw new Error('verified service is absent from the committed manifest');
  const snapshot = Object.freeze({
    schema: VERIFIED_SERVICE_EVIDENCE_SCHEMA,
    version: VERIFIED_SERVICE_EVIDENCE_VERSION,
    evidenceSha256: sha256Text(evidenceText),
    serviceImages,
    verifiedServices: Object.freeze([...verification.verifiedServices].sort())
  });
  capturedServiceEvidence.set(snapshot, Object.freeze({
    evidence: deepFreeze(evidence),
    evidenceText,
    serviceImages
  }));
  return snapshot;
}

/**
 * Recheck a module-minted snapshot against the committed baselines without
 * reopening the operator-selected path. Freshness is still measured at the
 * current caller-supplied instant, but the evidence bytes cannot drift.
 */
export function resolveVerifiedServiceEvidence(input) {
  const { snapshot, serviceManifest, modelWeights, now } = input ?? {};
  if (!hasExactKeys(snapshot, VERIFIED_SERVICE_EVIDENCE_FIELDS)
    || snapshot.schema !== VERIFIED_SERVICE_EVIDENCE_SCHEMA
    || snapshot.version !== VERIFIED_SERVICE_EVIDENCE_VERSION
    || typeof snapshot.evidenceSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(snapshot.evidenceSha256)
    || !Array.isArray(snapshot.verifiedServices)) {
    return snapshotFailure(
      'SERVICE_EVIDENCE_SNAPSHOT_UNTRUSTED',
      'runtime binding requires an in-process immutable snapshot produced by service validation'
    );
  }
  const captured = capturedServiceEvidence.get(snapshot);
  if (captured === undefined || sha256Text(captured.evidenceText) !== snapshot.evidenceSha256) {
    return snapshotFailure(
      'SERVICE_EVIDENCE_SNAPSHOT_TAMPERED',
      'the verified service-evidence bytes no longer match their captured hash'
    );
  }
  const images = declaredImages(serviceManifest);
  if (images === null) {
    return snapshotFailure('SERVICE_MANIFEST_UNUSABLE', 'the committed service manifest is absent or invalid');
  }
  const verification = verifyServiceEvidence({
    evidence: captured.evidence,
    serviceManifest,
    modelWeights,
    now
  });
  const serviceImages = serviceImagesForVerifiedServices(images, verification.verifiedServices);
  if (serviceImages === null
    || !sameServiceImages(serviceImages, snapshot.serviceImages)
    || JSON.stringify([...verification.verifiedServices].sort()) !== JSON.stringify(snapshot.verifiedServices)) {
    return snapshotFailure(
      'SERVICE_EVIDENCE_SNAPSHOT_MISMATCH',
      'the captured service evidence no longer verifies to the identity presented to runtime binding'
    );
  }
  return Object.freeze({
    ...verification,
    serviceImages,
    evidenceSha256: snapshot.evidenceSha256
  });
}