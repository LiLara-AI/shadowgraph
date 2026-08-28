const CREDENTIAL_NAMES = [
  'ANTHROPIC_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'COHERE_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'LM_STUDIO_API_KEY',
  'MEM0_API_KEY',
  'MISTRAL_API_KEY',
  'NEO4J_PASSWORD',
  'OPENAI_API_KEY',
  'SHADOWGRAPH_BENCH_API_KEY',
  'SHADOWGRAPH_BENCH_EMBEDDING_API_KEY',
  'SHADOWGRAPH_EMBEDDING_API_KEY',
  'TOGETHER_API_KEY',
  'VOYAGE_API_KEY'
];

const ENDPOINT_NAMES = [
  'NEO4J_URI',
  'OLLAMA_HOST',
  'OPENAI_API_BASE',
  'OPENAI_BASE_URL',
  'SHADOWGRAPH_BENCH_EMBEDDING_BASE_URL',
  'SHADOWGRAPH_BENCH_LLM_BASE_URL',
  'SHADOWGRAPH_EMBEDDING_URL'
];

const MODEL_NAMES = [
  'SHADOWGRAPH_BENCH_EMBEDDING_MODEL',
  'SHADOWGRAPH_BENCH_LLM_MODEL',
  'SHADOWGRAPH_EMBEDDING_MODEL'
];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);
const LOCAL_DISCOVERY_BASES = [
  'http://127.0.0.1:1234/v1',
  'http://127.0.0.1:8000/v1',
  'http://127.0.0.1:8080/v1',
  'http://127.0.0.1:11434/v1'
];

export const NO_COMMON_MODEL_REASON = 'No common local/free LLM and embedding endpoint was available.';

function configured(environment, name) {
  return typeof environment[name] === 'string' && environment[name].trim().length > 0;
}

function endpointLocality(value) {
  try {
    return LOCAL_HOSTS.has(new URL(value).hostname) ? 'local' : 'non-local';
  } catch {
    return 'invalid';
  }
}

export function summarizeConfiguredEnvironment(environment = process.env) {
  const endpoints = ENDPOINT_NAMES.filter((name) => configured(environment, name)).map((name) => endpointLocality(environment[name]));
  return {
    credentials: { configuredCount: CREDENTIAL_NAMES.filter((name) => configured(environment, name)).length },
    endpoints: {
      configuredCount: endpoints.length,
      localCount: endpoints.filter((value) => value === 'local').length,
      nonLocalCount: endpoints.filter((value) => value === 'non-local').length,
      invalidCount: endpoints.filter((value) => value === 'invalid').length
    },
    models: { configuredCount: MODEL_NAMES.filter((name) => configured(environment, name)).length }
  };
}

function benchmarkConfiguration(environment) {
  const llmApiKey = configured(environment, 'SHADOWGRAPH_BENCH_API_KEY')
    ? environment.SHADOWGRAPH_BENCH_API_KEY
    : null;
  const embeddingApiKey = configured(environment, 'SHADOWGRAPH_BENCH_EMBEDDING_API_KEY')
    ? environment.SHADOWGRAPH_BENCH_EMBEDDING_API_KEY
    : llmApiKey;
  return {
    llm: {
      endpoint: configured(environment, 'SHADOWGRAPH_BENCH_LLM_BASE_URL') ? environment.SHADOWGRAPH_BENCH_LLM_BASE_URL : null,
      model: configured(environment, 'SHADOWGRAPH_BENCH_LLM_MODEL') ? environment.SHADOWGRAPH_BENCH_LLM_MODEL : null,
      apiKey: llmApiKey
    },
    embedding: {
      endpoint: configured(environment, 'SHADOWGRAPH_BENCH_EMBEDDING_BASE_URL') ? environment.SHADOWGRAPH_BENCH_EMBEDDING_BASE_URL : null,
      model: configured(environment, 'SHADOWGRAPH_BENCH_EMBEDDING_MODEL') ? environment.SHADOWGRAPH_BENCH_EMBEDDING_MODEL : null,
      apiKey: embeddingApiKey
    },
    declaredFree: environment.SHADOWGRAPH_BENCH_FREE_ENDPOINT === '1'
  };
}

function endpointFor(base, resource) {
  const parsed = new URL(base);
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/${resource}`;
  return parsed.toString();
}

async function boundedFetch(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeEndpoint({ fetchImpl, endpoint, model, apiKey, kind, timeoutMs }) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const resource = kind === 'llm' ? 'chat/completions' : 'embeddings';
  const body = kind === 'llm'
    ? { model, temperature: 0, max_tokens: 1, messages: [{ role: 'user', content: 'capability probe' }] }
    : { model, input: 'capability probe' };
  try {
    const response = await boundedFetch(fetchImpl, endpointFor(endpoint, resource), {
      method: 'POST', headers, body: JSON.stringify(body)
    }, timeoutMs);
    if (!response.ok) return { reachable: true, compatible: false };
    const payload = await response.json();
    const compatible = kind === 'llm'
      ? Array.isArray(payload?.choices)
      : Array.isArray(payload?.data) && Array.isArray(payload.data[0]?.embedding);
    return { reachable: true, compatible };
  } catch {
    return { reachable: false, compatible: false };
  }
}

async function discoverLocalEndpoints(fetchImpl, timeoutMs) {
  let respondingCount = 0;
  for (const base of LOCAL_DISCOVERY_BASES) {
    try {
      const response = await boundedFetch(fetchImpl, endpointFor(base, 'models'), { method: 'GET' }, timeoutMs);
      if (response.ok) respondingCount += 1;
    } catch {
      // A failed local discovery request is represented only as a count.
    }
  }
  return { attemptedCount: LOCAL_DISCOVERY_BASES.length, respondingCount };
}

export async function probeCommonCapabilities({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 1500
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Capability probe requires fetch');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Capability probe timeoutMs must be a positive integer');
  const configuration = benchmarkConfiguration(environment);
  const llmConfigured = Boolean(configuration.llm.endpoint && configuration.llm.model);
  const embeddingConfigured = Boolean(configuration.embedding.endpoint && configuration.embedding.model);
  const llmPolicyAllowed = llmConfigured && (endpointLocality(configuration.llm.endpoint) === 'local' || configuration.declaredFree);
  const embeddingPolicyAllowed = embeddingConfigured && (endpointLocality(configuration.embedding.endpoint) === 'local' || configuration.declaredFree);
  const llmResult = llmPolicyAllowed
    ? await probeEndpoint({ fetchImpl, ...configuration.llm, kind: 'llm', timeoutMs })
    : { reachable: false, compatible: false };
  const embeddingResult = embeddingPolicyAllowed
    ? await probeEndpoint({ fetchImpl, ...configuration.embedding, kind: 'embedding', timeoutMs })
    : { reachable: false, compatible: false };
  const commonModelAvailable = llmResult.compatible && embeddingResult.compatible;
  const output = {
    schemaVersion: 1,
    commonModelAvailable,
    reason: commonModelAvailable ? null : NO_COMMON_MODEL_REASON,
    configuredEnvironment: summarizeConfiguredEnvironment(environment),
    llm: {
      configured: llmConfigured,
      policyAllowed: llmPolicyAllowed,
      reachable: llmResult.reachable,
      compatible: llmResult.compatible
    },
    embedding: {
      configured: embeddingConfigured,
      policyAllowed: embeddingPolicyAllowed,
      reachable: embeddingResult.reachable,
      compatible: embeddingResult.compatible
    }
  };
  if (!llmConfigured && !embeddingConfigured) output.localDiscovery = await discoverLocalEndpoints(fetchImpl, timeoutMs);
  return output;
}

export function readCommonModelConfiguration(environment = process.env) {
  const configuration = benchmarkConfiguration(environment);
  if (!configuration.llm.endpoint || !configuration.llm.model || !configuration.embedding.endpoint || !configuration.embedding.model) return null;
  return configuration;
}
