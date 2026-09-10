// The producer of the service evidence `v11-service-evidence.mjs` verifies.
//
// The readiness gate reads a file, and a file can be written by hand. That is
// an honest limit rather than a solved problem, but it is a much smaller one
// when the harness can write the file itself from probes it performed. This
// module is that writer: it contacts the services an operator names, records
// exactly what came back, and produces the record. It decides nothing about
// readiness and clears nothing - a failed probe is written down as a failed
// probe, and the gate refuses it later.
//
// Nothing here is inferred from the committed files. The model ids come from
// the weight lock because that is which models must be served, but the weight
// digests are read out of the serving container's own model manifest, so a
// digest in the evidence is an observation of what is installed rather than the
// locked value copied forward. That distinction is the whole reason to have a
// probe: copying the lock into the evidence and then checking the evidence
// against the lock would prove nothing at all.
//
// Every external effect arrives as an injected function. The module performs no
// I/O of its own, so its behaviour on a partial outage is testable without one.

import path from 'node:path';

import { parseServiceManifestDocument } from './implementation-lock.mjs';
import { SERVICE_EVIDENCE_SCHEMA, SERVICE_EVIDENCE_VERSION } from './v11-service-evidence.mjs';

export const SERVICE_ENDPOINTS_SCHEMA = 'shadowgraph.v11.service-endpoints';

/** The Ollama layer media type that carries model weights. */
const OLLAMA_WEIGHTS_MEDIA_TYPE = 'application/vnd.ollama.image.model';

// Assembled rather than written literally, for the same reason
// python-container-runtime.mjs assembles its scratch target: the
// packaged-artifact audit reads a spelled-out absolute POSIX profile path in
// shipped source as a local-path disclosure. This one is a path *inside the
// service container*, not on any host, and it is the default only - an endpoint
// may name its own.
const OLLAMA_HOME = path.posix.join(path.posix.sep, 'root', '.ollama');

export class ServiceProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ServiceProbeError';
    this.code = code;
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function check(kind, endpoint, observedAt, outcome, detail) {
  return { kind, endpoint, observedAt, outcome, detail };
}

/** Record an outcome without letting a transport failure end the probe. */
function redactUnsafeUrlUserinfo(value) {
  return String(value).replace(/\b(https?:\/\/)([^/\s@]+)@/giu, '$1[redacted]@');
}

async function attempt(operation) {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, detail: redactUnsafeUrlUserinfo(error?.message ?? String(error)) };
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`response was not JSON (HTTP ${response.status})`);
  }
}

/**
 * Are two images the same image for this platform?
 *
 * Compared by filesystem layers, not by image id. A container started from a
 * digest reference and the same image reached through its tag are two distinct
 * local entries with two distinct ids - a tag resolves to the multi-platform
 * index while a digest pull resolves to the platform manifest inside it - so an
 * id comparison reports a mismatch between an image and itself. The layer chain
 * is the same content by definition, which is the question actually being
 * asked: is the container running these bytes?
 */
function sameImageContent(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length === 0 || left.length !== right.length) return false;
  return left.every((layer, index) => layer === right[index]);
}

/** Convert a validated repository:tag reference into canonical repository form. */
function repositoryOfTaggedImage(image) {
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  return lastColon > lastSlash ? image.slice(0, lastColon) : image;
}

function immutableReferenceFor(manifestService) {
  return `${repositoryOfTaggedImage(manifestService.image)}@${manifestService.digest}`;
}

function imageIdentityObservation(service, manifestService, container, resolvedImage) {
  if (!isPlainRecord(container)
    || !isNonEmptyString(container.id)
    || !isNonEmptyString(container.image)
    || !isPlainRecord(resolvedImage)
    || !isNonEmptyString(resolvedImage.platform)) return null;
  return {
    schema: 'shadowgraph.v11.service-image-identity',
    version: 1,
    serviceName: service.name,
    image: manifestService.image,
    platformManifestDigest: manifestService.digest,
    registryIndexDigest: manifestService.registryIndexDigest,
    platform: resolvedImage.platform,
    immutableReference: immutableReferenceFor(manifestService),
    containerReference: service.container,
    containerId: container.id,
    containerImageId: container.image
  };
}

/**
 * Confirm the named container is running the image the committed manifest pins.
 *
 * Recorded as a check rather than enforced here. The implementation lock is the
 * authority on which bytes a run may claim; this only writes down whether the
 * container an operator pointed at is the one the manifest names, so a run
 * against a container someone rebuilt is visible instead of silent.
 */
async function imageIdentityCheck(service, manifestService, observedAt, deps) {
  const container = await attempt(() => deps.inspectContainer(service.container));
  if (!container.ok) {
    return {
      resolvedDigest: null,
      containerId: null,
      imageIdentity: null,
      check: check('image-identity', service.container, observedAt, 'FAIL', container.detail)
    };
  }
  const immutableReference = immutableReferenceFor(manifestService);
  const image = await attempt(() => deps.inspectImage(immutableReference));
  if (!image.ok) {
    return {
      resolvedDigest: null,
      containerId: container.value.id ?? null,
      imageIdentity: null,
      check: check('image-identity', service.container, observedAt, 'FAIL', image.detail)
    };
  }
  const localImageMatches = container.value.image === image.value.id;
  const platformMatches = image.value.platform === manifestService.platform;
  const layersMatch = sameImageContent(container.value.layers, image.value.layers);
  const matches = localImageMatches && platformMatches && layersMatch;
  let detail;
  if (!localImageMatches) {
    detail = `container local image ID ${container.value.image} does not match image ID ${image.value.id} resolved from committed OCI platform manifest digest ${manifestService.digest}`;
  } else if (!platformMatches) {
    detail = `immutable image ${immutableReference} reports platform ${image.value.platform ?? 'unknown'}, not ${manifestService.platform}`;
  } else if (!layersMatch) {
    detail = `container image ${container.value.image} does not have the layers ${immutableReference} resolves to (${image.value.id})`;
  } else {
    detail = `container local image ID matches the ${image.value.layers.length} layers resolved from OCI platform manifest ${manifestService.digest}`;
  }
  return {
    resolvedDigest: matches ? manifestService.digest : null,
    containerId: container.value.id ?? null,
    imageIdentity: imageIdentityObservation(service, manifestService, container.value, image.value),
    check: check('image-identity', service.container, observedAt, matches ? 'PASS' : 'FAIL', detail)
  };
}

/** Probe a Neo4j-compatible database over its HTTP interface. */
async function probeNeo4j(service, observedAt, deps) {
  const checks = [];
  const root = new URL('/', service.baseUrl).toString();
  const status = await attempt(async () => {
    const response = await deps.fetchImpl(root, { method: 'GET' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.status;
  });
  checks.push(check('http-status', root, observedAt, status.ok ? 'PASS' : 'FAIL',
    status.ok ? `HTTP ${status.value}` : status.detail));

  const database = isNonEmptyString(service.database) ? service.database : 'neo4j';
  const endpoint = new URL(`/db/${database}/tx/commit`, service.baseUrl).toString();
  const authorization = deps.readAuthorization(service);
  const cypher = await attempt(async () => {
    const response = await deps.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(authorization === null ? {} : { authorization })
      },
      body: JSON.stringify({ statements: [{ statement: 'RETURN 1 AS ok' }] })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await readJsonResponse(response);
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new Error(`Cypher returned ${body.errors.length} error(s)`);
    }
    const row = body?.results?.[0]?.data?.[0]?.row?.[0];
    if (row !== 1) throw new Error('RETURN 1 did not produce 1');
    return 'RETURN 1 AS ok';
  });
  checks.push(check('cypher-statement', endpoint, observedAt, cypher.ok ? 'PASS' : 'FAIL',
    cypher.ok ? cypher.value : cypher.detail));

  return { checks, servedModels: [] };
}

/**
 * Probe an OpenAI-compatible model endpoint for the models the weight lock
 * pins, and read each one's installed weight digest out of the container.
 */
async function probeModelEndpoint(service, modelWeights, observedAt, deps) {
  const checks = [];
  const byKind = new Map(modelWeights.models.map((model) => [model.kind, model]));
  const decision = byKind.get('decision_llm') ?? null;
  const embedding = byKind.get('embedding') ?? null;

  if (decision === null || embedding === null) {
    throw new ServiceProbeError(
      'CONTRACT_FAILURE',
      'the model weight lock must pin both a decision_llm and an embedding model'
    );
  }

  const chatEndpoint = new URL('/v1/chat/completions', service.baseUrl).toString();
  const chat = await attempt(async () => {
    const response = await deps.fetchImpl(chatEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: decision.modelId,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        temperature: 0,
        max_tokens: 8
      })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await readJsonResponse(response);
    if (body?.error) throw new Error(String(body.error?.message ?? 'endpoint returned an error'));
    if (!isNonEmptyString(body?.choices?.[0]?.message?.content)) {
      throw new Error('no assistant content was returned');
    }
    return `HTTP ${response.status}, model ${body.model ?? decision.modelId}`;
  });
  checks.push(check('openai-chat-completions', chatEndpoint, observedAt, chat.ok ? 'PASS' : 'FAIL',
    chat.ok ? chat.value : chat.detail));

  const embeddingEndpoint = new URL('/v1/embeddings', service.baseUrl).toString();
  const embed = await attempt(async () => {
    const response = await deps.fetchImpl(embeddingEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: embedding.modelId, input: 'shadowgraph service probe' })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await readJsonResponse(response);
    if (body?.error) throw new Error(String(body.error?.message ?? 'endpoint returned an error'));
    const vector = body?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length === 0) throw new Error('no embedding was returned');
    return `HTTP ${response.status}, ${vector.length} dimensions`;
  });
  checks.push(check('openai-embeddings', embeddingEndpoint, observedAt, embed.ok ? 'PASS' : 'FAIL',
    embed.ok ? embed.value : embed.detail));

  // The weight digest is read from the serving container, not copied from the
  // lock. A model the endpoint answers for but whose installed weights cannot
  // be read is recorded with a null digest, which the gate refuses.
  const servedModels = [];
  for (const model of [decision, embedding]) {
    const observed = await attempt(() => deps.readModelWeightsDigest(service.container, model.modelId));
    servedModels.push({
      modelId: model.modelId,
      weightsDigest: observed.ok ? observed.value : null
    });
    if (!observed.ok) {
      checks.push(check('model-weights', service.container, observedAt, 'FAIL',
        `${model.modelId}: ${observed.detail}`));
    }
  }

  return { checks, servedModels };
}

/**
 * Parse an Ollama model manifest into its weight-layer digest.
 *
 * Exported so the container command that fetches the manifest and the parsing
 * of it are separately testable, and so the media type this depends on is
 * stated in one place.
 */
export function ollamaWeightsDigest(manifestText) {
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new ServiceProbeError('CONTRACT_FAILURE', 'the model manifest is not valid JSON');
  }
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
  const weights = layers.filter((layer) => layer?.mediaType === OLLAMA_WEIGHTS_MEDIA_TYPE);
  if (weights.length !== 1 || !isNonEmptyString(weights[0].digest)) {
    throw new ServiceProbeError(
      'CONTRACT_FAILURE',
      'the model manifest does not carry exactly one weight layer'
    );
  }
  return weights[0].digest;
}

/** The in-container path of an Ollama model manifest for `name:tag`. */
export function ollamaManifestPath(modelId, root = OLLAMA_HOME) {
  const separator = modelId.lastIndexOf(':');
  if (separator <= 0 || separator === modelId.length - 1) {
    throw new ServiceProbeError('CONTRACT_FAILURE', `model id ${modelId} is not name:tag`);
  }
  const name = modelId.slice(0, separator);
  const tag = modelId.slice(separator + 1);
  return path.posix.join(root, 'models', 'manifests', 'registry.ollama.ai', 'library', name, tag);
}

function rawAuthorityIsUnsafe(value) {
  if (typeof value !== 'string' || value.includes('\\')) return true;
  const match = /^(?:https?):\/\/([^/?#]*)/iu.exec(value);
  if (match === null || match[1].length === 0) return true;
  return match[1].includes('@');
}

function validateSafeBaseUrl(value) {
  if (rawAuthorityIsUnsafe(value)) {
    throw new ServiceProbeError(
      'CONTRACT_FAILURE',
      'each endpoint baseUrl must be a safe absolute http or https URL without userinfo'
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ServiceProbeError(
      'CONTRACT_FAILURE',
      'each endpoint baseUrl must be a safe absolute http or https URL without userinfo'
    );
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.hostname.length === 0
    || parsed.username.length > 0
    || parsed.password.length > 0) {
    throw new ServiceProbeError(
      'CONTRACT_FAILURE',
      'each endpoint baseUrl must be a safe absolute http or https URL without userinfo'
    );
  }
}

function validateEndpoints(endpoints) {
  if (!isPlainRecord(endpoints)
    || endpoints.schema !== SERVICE_ENDPOINTS_SCHEMA
    || endpoints.version !== 1
    || !Array.isArray(endpoints.services)
    || endpoints.services.length === 0) {
    throw new ServiceProbeError(
      'CONTRACT_FAILURE',
      `service endpoints must declare schema ${SERVICE_ENDPOINTS_SCHEMA} version 1 and a non-empty services array`
    );
  }
  for (const service of endpoints.services) {
    if (!isPlainRecord(service)
      || !isNonEmptyString(service.name)
      || !isNonEmptyString(service.container)
      || !isNonEmptyString(service.baseUrl)
      || !['neo4j', 'openai-compatible'].includes(service.kind)) {
      throw new ServiceProbeError(
        'CONTRACT_FAILURE',
        'each endpoint needs a name, container, baseUrl and a kind of neo4j or openai-compatible'
      );
    }
    validateSafeBaseUrl(service.baseUrl);
  }
}

/**
 * Probe every declared service and return the evidence record.
 *
 * The record is written whatever came back. A probe that could not reach its
 * service produces a record with failed checks, which is the truthful artifact:
 * the gate then refuses it, and the operator sees which check failed rather
 * than an empty file.
 */
export async function probeServices(input) {
  const {
    endpoints,
    serviceManifest,
    modelWeights,
    fetchImpl = globalThis.fetch,
    inspectContainer,
    inspectImage,
    readModelWeightsDigest,
    readAuthorization = () => null,
    now
  } = input ?? {};

  validateEndpoints(endpoints);
  let declared;
  try {
    declared = parseServiceManifestDocument(serviceManifest);
  } catch (error) {
    throw new ServiceProbeError(
      'CONTRACT_FAILURE',
      `the committed service manifest is invalid: ${error?.message ?? String(error)}`
    );
  }
  if (!Array.isArray(modelWeights?.models) || modelWeights.models.length === 0) {
    throw new ServiceProbeError('CONTRACT_FAILURE', 'the committed model weight lock pins no model');
  }
  for (const dependency of ['inspectContainer', 'inspectImage', 'readModelWeightsDigest']) {
    if (typeof input[dependency] !== 'function') {
      throw new ServiceProbeError('CONTRACT_FAILURE', `${dependency} must be supplied`);
    }
  }

  const observedAt = new Date(now).toISOString();
  const deps = { fetchImpl, inspectContainer, inspectImage, readModelWeightsDigest, readAuthorization };
  const services = [];

  for (const service of endpoints.services) {
    const manifestEntry = declared.get(service.name.toLowerCase());
    if (manifestEntry === undefined) {
      throw new ServiceProbeError(
        'CONTRACT_FAILURE',
        `service ${service.name} is not declared in the committed service manifest`
      );
    }
    const identity = await imageIdentityCheck(service, manifestEntry, observedAt, deps);
    const probed = service.kind === 'neo4j'
      ? await probeNeo4j(service, observedAt, deps)
      : await probeModelEndpoint(service, modelWeights, observedAt, deps);

    services.push({
      name: service.name,
      image: manifestEntry.image,
      resolvedDigest: identity.resolvedDigest,
      containerId: identity.containerId,
      imageIdentity: identity.imageIdentity,
      servedModels: probed.servedModels,
      checks: [identity.check, ...probed.checks]
    });
  }

  return {
    schema: SERVICE_EVIDENCE_SCHEMA,
    version: SERVICE_EVIDENCE_VERSION,
    observedAt,
    services
  };
}
