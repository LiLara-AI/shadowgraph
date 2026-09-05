// The pinned models each metered request class must be answered with.
//
// The provider routes tell a Python adapter *where* to send an internal call.
// They do not tell it *what to ask for*, and until this module existed nothing
// did: the host wrapper carried routes alone, so every library fell back to its
// own default. Mem0's is `gpt-5-mini` for chat and `text-embedding-3-small` at
// 1536 dimensions for embeddings. Pointed at the pinned Ollama, which serves
// `qwen2.5:0.5b` and `nomic-embed-text:v1.5` at 768, the first asks for a model
// that is not there and the second sizes a vector collection to a width the
// embeddings do not have.
//
// The lock's chat model is recorded under the kind `decision_llm` because that
// is the outer agent's model, and it is the same weights an arm's internal
// memory LLM must use. One chat model is pinned, deliberately: an arm allowed
// its own would be measured against different reasoning, and the comparison
// would be between models rather than between memory systems.
//
// What crosses the protocol is the lock's own value, unaltered. Libraries that
// need it dressed differently - Cognee routes completions through litellm,
// which wants a `openai/` provider prefix - derive that inside the adapter, so
// the wrapper stays a statement about what is pinned rather than about what
// some library happens to want this week.

const REQUEST_CLASS_BY_MODEL_KIND = Object.freeze({
  internal_memory_llm: 'decision_llm',
  embedding: 'embedding'
});

export const PROVIDER_MODEL_CLASSES = Object.freeze(Object.keys(REQUEST_CLASS_BY_MODEL_KIND));

// Deliberately permissive about the shape of an id and strict about what it may
// not be. The lock is the authority on which ids are legitimate; this only
// refuses values that could not name a model at all, or that could smuggle
// something else through a field an adapter will interpolate into a request.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;

export class ProviderModelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderModelError';
  }
}

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPinnedModelId(value) {
  return typeof value === 'string' && MODEL_ID.test(value);
}

/**
 * Read the pinned model for each metered request class out of the model weight
 * lock.
 *
 * Returns a frozen record keyed by request class. A class an arm does not use
 * is the caller's business - `providerModelsFor` narrows this to one arm.
 */
export function providerModelsFromLock(modelWeights) {
  if (!isPlainRecord(modelWeights) || !Array.isArray(modelWeights.models)) {
    throw new ProviderModelError('the model weight lock must record a models array');
  }
  const byKind = new Map();
  for (const model of modelWeights.models) {
    if (!isPlainRecord(model) || typeof model.kind !== 'string') {
      throw new ProviderModelError('every pinned model must record a kind');
    }
    if (byKind.has(model.kind)) {
      throw new ProviderModelError(`the model weight lock pins ${model.kind} more than once`);
    }
    byKind.set(model.kind, model);
  }

  const resolved = {};
  for (const requestClass of PROVIDER_MODEL_CLASSES) {
    const kind = REQUEST_CLASS_BY_MODEL_KIND[requestClass];
    const model = byKind.get(kind);
    if (model === undefined) {
      throw new ProviderModelError(`the model weight lock pins no ${kind} model`);
    }
    if (!isPinnedModelId(model.modelId)) {
      throw new ProviderModelError(`the pinned ${kind} model id is not usable`);
    }
    // The embedding width is carried because a client that does not know it
    // will invent one. Mem0 sizes its vector collection from this value and
    // only sends `dimensions` to the endpoint when it was told; left unset it
    // builds a 1536-wide collection for 768-wide vectors.
    const dimension = model.embeddingDimension ?? null;
    if (requestClass === 'embedding') {
      if (!Number.isSafeInteger(dimension) || dimension <= 0) {
        throw new ProviderModelError('the pinned embedding model must record its dimension');
      }
    } else if (dimension !== null) {
      throw new ProviderModelError(`a pinned ${kind} model must not record an embedding dimension`);
    }
    resolved[requestClass] = Object.freeze({
      modelId: model.modelId,
      embeddingDimension: dimension
    });
  }
  return Object.freeze(resolved);
}

/**
 * Narrow the pinned models to the request classes one arm actually meters.
 *
 * A class the arm does not use is present and null, mirroring the route record
 * exactly. Keeping the two the same shape is what lets the host state the
 * invariant that matters - an arm is handed a model for a class if and only if
 * it was handed a route for it - as a comparison rather than as prose.
 */
export function providerModelsFor(modelWeights, requestClasses) {
  if (!Array.isArray(requestClasses)) {
    throw new ProviderModelError('provider request classes must be an array');
  }
  for (const requestClass of requestClasses) {
    if (!PROVIDER_MODEL_CLASSES.includes(requestClass)) {
      throw new ProviderModelError(`unknown metered request class: ${String(requestClass)}`);
    }
  }
  if (new Set(requestClasses).size !== requestClasses.length) {
    throw new ProviderModelError('provider request classes must be distinct');
  }
  const all = requestClasses.length === 0 ? null : providerModelsFromLock(modelWeights);
  const narrowed = {};
  for (const requestClass of PROVIDER_MODEL_CLASSES) {
    narrowed[requestClass] = requestClasses.includes(requestClass) ? all[requestClass] : null;
  }
  return Object.freeze(narrowed);
}
