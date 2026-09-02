// Environment, service and model locks for the v1.1 candidate.
//
// The implementation lock already existed and covers the source tree. These
// cover the other three things a result would be interpreted against: the
// machine it ran on, the services it talked to, and the model weights that
// produced its decisions.
//
// Every builder here refuses incomplete evidence rather than recording a
// placeholder. That refusal is the feature. A lock exists so a reader can tell
// whether two runs are comparable; one built from "whatever was available"
// answers that question wrongly and looks authoritative doing it. The model
// lock in particular refuses the short Ollama identifiers that are the only
// thing this candidate has today - which is blocker B1, expressed as code
// rather than as a sentence in a document.
//
// Nothing here reads a file, runs a command, or contacts anything. Observations
// are supplied by the caller that actually made them, and are checked for shape
// only. A builder that gathered its own facts could be pointed at a different
// machine than the one under measurement.

import { createHash } from 'node:crypto';

import { canonicalJson } from './v11-contract.mjs';

export class LockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LockError';
    this.code = code;
  }
}

const BARE_SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Values that record the absence of an observation rather than an observation.
 *
 * The typed-field guard closed half of this: a count may not be prose. The
 * other half stayed open, under a comment claiming it was shut - a string field
 * accepted "unknown", "N/A", "TODO" or "not captured", and an environment lock
 * with every string field set to one of them produced a digest that reads as
 * authoritative. That is the exact failure this module's header says it exists
 * to refuse, reached by typing the placeholder into the slot the comment named.
 *
 * A version string is not otherwise checkable, so this refuses the tokens that
 * mean "we did not look" rather than trying to validate the ones that mean
 * something.
 */
const PLACEHOLDER_VALUES = new Set([
  '-', '?', '.', 'empty', 'missing', 'n/a', 'n.a', 'na', 'nan', 'nil', 'none',
  'null', 'pending', 'tbd', 'to do', 'todo', 'unavailable', 'undefined',
  'unknown', 'unset', 'unspecified', '[object object]',
  'not applicable', 'not available', 'not captured', 'not known',
  'not measured', 'not recorded', 'not set'
]);

/**
 * Fold the spellings of one placeholder together before comparing.
 *
 * `N / A`, `N.A.` and `???` are the same answer typed three ways, and matching
 * the exact string missed all three. This never changes what a lock records: it
 * exists only inside the comparison below.
 */
function normalizePlaceholder(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/\s*([/.])\s*/gu, '$1')
    .replace(/\.+$/u, '')
    .replace(/^[-?.]+$/u, (run) => (new Set(run).size === 1 ? run[0] : run));
}

/**
 * A value that records the absence of an observation rather than an observation.
 *
 * This is a denylist and therefore cannot be complete - a version string is not
 * otherwise checkable, so anything not listed here is taken at face value. It
 * refuses the spellings that mean "we did not look", including `undefined`,
 * which is what a collector emits for a property it never read.
 */
function isPlaceholder(value) {
  return PLACEHOLDER_VALUES.has(normalizePlaceholder(value));
}
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/u;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reject(code, message) {
  throw new LockError(code, message);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    reject('CONTRACT_FAILURE', `${label} must be a non-empty string`);
  }
  if (isPlaceholder(value)) {
    reject('CONTRACT_FAILURE', `${label} is a placeholder, not an observation`);
  }
}

/** Domain-separated digest over a lock's canonical bytes. */
function lockDigest(kind, lock) {
  return createHash('sha256')
    .update(`shadowgraph:v1.1:${kind}-lock:v1`, 'utf8')
    .update('\u0000', 'utf8')
    .update(canonicalJson(lock), 'utf8')
    .digest('hex');
}

/**
 * The environment facts a result depends on, each with the shape it must have.
 *
 * Typed per field, not merely present. The first version accepted any non-empty
 * string OR any positive number for every field, so `cpuCount: "unknown"` and
 * `totalMemoryBytes: "lots"` both passed - a placeholder recorded as though it
 * were an observation, by the builder whose stated purpose is refusing exactly
 * that. Independent review demonstrated it. A count is a count.
 */
export const ENVIRONMENT_SHAPE = Object.freeze({
  osType: 'string',
  osRelease: 'string',
  arch: 'string',
  cpuModel: 'string',
  cpuCount: 'count',
  totalMemoryBytes: 'count',
  nodeVersion: 'string',
  npmVersion: 'string',
  pythonVersion: 'string',
  containerRuntimeVersion: 'string'
});

export const ENVIRONMENT_FIELDS = Object.freeze(Object.keys(ENVIRONMENT_SHAPE));

/**
 * Build the environment lock.
 *
 * Every field is required and none may be empty. An environment lock with gaps
 * is worse than none: it implies the machine was pinned when part of it was
 * not, and the missing part is exactly where an unexplained difference between
 * two runs would hide.
 */
export function buildEnvironmentLock(input) {
  if (!isPlainObject(input) || !isPlainObject(input.observations)) {
    reject('CONTRACT_FAILURE', 'environment lock requires observations');
  }
  const { observations } = input;

  const missing = ENVIRONMENT_FIELDS.filter((field) => {
    const value = observations[field];
    if (ENVIRONMENT_SHAPE[field] === 'count') {
      return !Number.isSafeInteger(value) || value <= 0;
    }
    // A string field holds a description, and neither a number nor a
    // placeholder is one. This is what stands between a real observation and
    // "unknown" typed into the same slot - which the previous version of this
    // comment claimed while accepting it.
    if (typeof value !== 'string' || value.trim().length === 0) return true;
    return isPlaceholder(value);
  }).sort();
  if (missing.length > 0) {
    reject(
      'INCOMPLETE_ENVIRONMENT',
      `environment lock is missing or holds a placeholder for: ${missing.join(', ')}`
    );
  }

  const unknown = Object.keys(observations)
    .filter((field) => !ENVIRONMENT_FIELDS.includes(field))
    .sort();
  if (unknown.length > 0) {
    reject('UNKNOWN_ENVIRONMENT_FIELD', `environment lock does not record: ${unknown.join(', ')}`);
  }

  const lock = {
    schema: 'shadowgraph.v11.environment-lock',
    version: 1,
    ...Object.fromEntries(ENVIRONMENT_FIELDS.map((field) => [field, observations[field]]))
  };
  return { lock, bytes: `${canonicalJson(lock)}\n`, digest: lockDigest('environment', lock) };
}

/**
 * Build the service lock.
 *
 * A service is pinned by an image digest or it is not pinned. A tag is a
 * moving reference, so `neo4j:5.20` names whatever that tag points at today and
 * would silently become a different service tomorrow - which is precisely the
 * thing a lock exists to prevent.
 */
export function buildServiceLock(input) {
  if (!isPlainObject(input) || !Array.isArray(input.services)) {
    reject('CONTRACT_FAILURE', 'service lock requires a services array');
  }
  if (input.services.length === 0) {
    reject('EMPTY_SERVICE_LOCK', 'a service lock with no services would pin nothing');
  }

  const byName = new Map();
  for (const service of input.services) {
    if (!isPlainObject(service)) reject('CONTRACT_FAILURE', 'each service must be an object');
    assertNonEmptyString(service.name, 'service name');
    assertNonEmptyString(service.image, `service image for ${service.name}`);
    assertNonEmptyString(service.armId, `service armId for ${service.name}`);

    // Exactly one '@'. With two, split() destructured the first digest while
    // `image` kept the whole string including the second, so a reader pulling
    // the recorded image got something other than what the recorded digest
    // named - inside a lock whose entire purpose is that those two agree.
    const parts = service.image.split('@');
    if (parts.length !== 2) {
      reject(
        'UNPINNED_SERVICE',
        parts.length === 1
          ? `service ${service.name} names an image by tag, not by digest: ${service.image}`
          : `service ${service.name} names more than one digest: ${service.image}`
      );
    }
    const [repository, digest] = parts;
    if (!PREFIXED_SHA256.test(digest)) {
      reject('INVALID_SERVICE_DIGEST', `service ${service.name} has a malformed image digest`);
    }
    assertNonEmptyString(repository, `service repository for ${service.name}`);
    if (byName.has(service.name)) {
      reject('DUPLICATE_SERVICE', `service lock names ${service.name} more than once`);
    }
    byName.set(service.name, {
      name: service.name,
      armId: service.armId,
      image: service.image,
      repository,
      digest
    });
  }

  const services = [...byName.values()].sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ));
  const lock = {
    schema: 'shadowgraph.v11.service-lock',
    version: 1,
    serviceCount: services.length,
    services
  };
  return { lock, bytes: `${canonicalJson(lock)}\n`, digest: lockDigest('service', lock) };
}

/**
 * Build the model lock.
 *
 * A model is identified by the digest of its weights, not by a name, a tag, or
 * a short id. `MISSING-EVIDENCE.md` records that only short Ollama identifiers
 * were captured for this candidate, and a short id cannot distinguish two
 * different weight sets that a registry happened to label the same way. That is
 * blocker B1, and this builder is where it becomes mechanical: pass a short id
 * and it refuses, rather than producing a lock that reads as authoritative.
 */
export function buildModelLock(input) {
  if (!isPlainObject(input) || !Array.isArray(input.models)) {
    reject('CONTRACT_FAILURE', 'model lock requires a models array');
  }
  if (input.models.length === 0) {
    reject('EMPTY_MODEL_LOCK', 'a model lock with no models would pin nothing');
  }

  const byId = new Map();
  for (const model of input.models) {
    if (!isPlainObject(model)) reject('CONTRACT_FAILURE', 'each model must be an object');
    assertNonEmptyString(model.modelId, 'model id');
    assertNonEmptyString(model.requestClass, `request class for ${model.modelId}`);

    if (model.digestKind !== 'model_weights') {
      reject(
        'WRONG_DIGEST_KIND',
        `model ${model.modelId} must pin weights, not ${String(model.digestKind)}`
      );
    }
    if (typeof model.weightsDigest !== 'string' || !PREFIXED_SHA256.test(model.weightsDigest)) {
      reject(
        'UNPINNED_MODEL',
        `model ${model.modelId} has no full sha256 weights digest; a short id cannot identify weights`
      );
    }
    if (byId.has(model.modelId)) {
      reject('DUPLICATE_MODEL', `model lock names ${model.modelId} more than once`);
    }
    byId.set(model.modelId, {
      modelId: model.modelId,
      requestClass: model.requestClass,
      digestKind: 'model_weights',
      weightsDigest: model.weightsDigest
    });
  }

  const models = [...byId.values()].sort((left, right) => (
    left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0
  ));
  const lock = {
    schema: 'shadowgraph.v11.model-lock',
    version: 1,
    modelCount: models.length,
    models
  };
  return { lock, bytes: `${canonicalJson(lock)}\n`, digest: lockDigest('model', lock) };
}

/**
 * Verify a lock against the digest a verdict was bound to.
 *
 * `expectedDigest` is required, for the same reason it is required on the review
 * bundle: a verification that answers "verified" without being told what it is
 * verifying against is the failure it exists to prevent.
 */
export function verifyLock(input) {
  if (!isPlainObject(input) || !isPlainObject(input.lock)) {
    reject('CONTRACT_FAILURE', 'lock verification requires a lock');
  }
  if (typeof input.expectedDigest !== 'string' || !BARE_SHA256.test(input.expectedDigest)) {
    reject('INVALID_DIGEST', 'lock verification requires the digest it is checking against');
  }
  const kind = {
    'shadowgraph.v11.environment-lock': 'environment',
    'shadowgraph.v11.service-lock': 'service',
    'shadowgraph.v11.model-lock': 'model'
  }[input.lock.schema];
  if (kind === undefined) {
    reject('UNKNOWN_LOCK', `not a v1.1 lock: ${String(input.lock.schema)}`);
  }
  const actual = lockDigest(kind, input.lock);
  return {
    verified: actual === input.expectedDigest,
    kind,
    digest: actual,
    findings: actual === input.expectedDigest ? [] : [{ code: 'LOCK_DIGEST_MISMATCH', kind }]
  };
}
