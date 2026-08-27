const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function endpointFor(baseUrl) {
  let parsed;
  try { parsed = new URL(baseUrl); }
  catch { throw new Error('Embedding baseUrl must be a valid http(s) URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Embedding baseUrl must use http or https');
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/embeddings`;
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function validateVector(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new Error('Embedding response must contain a finite numeric vector');
  }
  return [...value];
}

/**
 * Create an OpenAI-compatible embedding function.
 *
 * Remote endpoints are opt-in because memory text is private by default. A local
 * Ollama, llama.cpp, LM Studio, or other OpenAI-compatible server works without
 * relaxing that boundary.
 */
export function createEmbeddingClient(options = {}) {
  if (typeof options.baseUrl !== 'string' || !options.baseUrl.trim()) throw new Error('Embedding baseUrl is required');
  if (typeof options.model !== 'string' || !options.model.trim()) throw new Error('Embedding model is required');
  const endpoint = endpointFor(options.baseUrl);
  const local = LOCAL_HOSTS.has(endpoint.hostname);
  if (!local && options.allowRemote !== true) throw new Error('Remote embedding endpoints require allowRemote=true');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Embedding timeoutMs must be a positive integer');

  return async function embed(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Embedding input must be non-empty text');
    const headers = { 'content-type': 'application/json' };
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
    const response = await fetchImpl(endpoint.toString(), {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify({ model: options.model, input: text }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response?.ok) throw new Error(`Embedding endpoint failed with HTTP ${response?.status ?? 'unknown'}`);
    const payload = await response.json();
    if (payload?.model !== undefined && payload.model !== options.model) {
      throw new Error(`Embedding response model ${String(payload.model)} does not match ${options.model}`);
    }
    const values = validateVector(payload?.data?.[0]?.embedding);
    return { model: options.model, values };
  };
}
