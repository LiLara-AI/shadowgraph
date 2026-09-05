// The producer of service evidence.
//
// The probe's job is to write down what happened, including when nothing did.
// These tests pin both halves: a healthy probe produces a record the readiness
// gate accepts, and every partial outage produces a record the gate refuses.
// Pairing the two modules in the same test is deliberate - a probe whose output
// its own verifier rejects would be useless, and only an end-to-end assertion
// catches that.

import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyServiceEvidence } from '../benchmark/lib/v11-service-evidence.mjs';
import {
  SERVICE_ENDPOINTS_SCHEMA,
  ServiceProbeError,
  ollamaManifestPath,
  ollamaWeightsDigest,
  probeServices
} from '../benchmark/lib/v11-service-probe.mjs';

const NOW = Date.parse('2026-09-05T03:00:00.000Z');
// A digest-pinned container and the same image reached through its tag are two
// distinct local entries with two distinct ids. These fixtures keep that real:
// the ids never match, and only the layer chains do.
const NEO4J_IMAGE_ID = `sha256:${'1'.repeat(64)}`;
const OLLAMA_IMAGE_ID = `sha256:${'2'.repeat(64)}`;
const NEO4J_TAG_ID = `sha256:${'3'.repeat(64)}`;
const OLLAMA_TAG_ID = `sha256:${'4'.repeat(64)}`;
const NEO4J_LAYERS = [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`];
const OLLAMA_LAYERS = [`sha256:${'7'.repeat(64)}`];
const LLM_WEIGHTS = `sha256:${'c'.repeat(64)}`;
const EMBEDDING_WEIGHTS = `sha256:${'e'.repeat(64)}`;
const NEO4J_SECRET = 'neo4j:correct-horse-battery-staple';

function serviceManifest() {
  return {
    schema: 'shadowgraph.service-images',
    version: 1,
    services: [
      { name: 'neo4j', image: 'neo4j:5.20' },
      { name: 'ollama', image: 'ollama/ollama:0.33.2' }
    ]
  };
}

function modelWeights() {
  return {
    schemaVersion: 1,
    models: [
      { kind: 'decision_llm', modelId: 'qwen2.5:0.5b', digestKind: 'model_weights', weightsDigest: LLM_WEIGHTS },
      { kind: 'embedding', modelId: 'nomic-embed-text:v1.5', digestKind: 'model_weights', weightsDigest: EMBEDDING_WEIGHTS }
    ]
  };
}

function endpoints() {
  return {
    schema: SERVICE_ENDPOINTS_SCHEMA,
    version: 1,
    services: [
      {
        name: 'neo4j',
        kind: 'neo4j',
        container: 'shadowgraph-v11-neo4j',
        baseUrl: 'http://127.0.0.1:7474',
        database: 'neo4j',
        authEnvironmentVariable: 'SHADOWGRAPH_TEST_NEO4J_AUTH'
      },
      {
        name: 'ollama',
        kind: 'openai-compatible',
        container: 'shadowgraph-v11-ollama',
        baseUrl: 'http://127.0.0.1:11434'
      }
    ]
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

/** A fake service estate. `failures` names endpoints that should misbehave. */
function estate(failures = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, headers: init.headers ?? {} });
    if (Object.hasOwn(failures, url)) return failures[url];
    if (url === 'http://127.0.0.1:7474/') return jsonResponse(200, { neo4j_version: '5.20.0' });
    if (url === 'http://127.0.0.1:7474/db/neo4j/tx/commit') {
      return jsonResponse(200, { results: [{ columns: ['ok'], data: [{ row: [1] }] }], errors: [] });
    }
    if (url === 'http://127.0.0.1:11434/v1/chat/completions') {
      return jsonResponse(200, { model: 'qwen2.5:0.5b', choices: [{ message: { role: 'assistant', content: 'OK' } }] });
    }
    if (url === 'http://127.0.0.1:11434/v1/embeddings') {
      return jsonResponse(200, { model: 'nomic-embed-text:v1.5', data: [{ embedding: new Array(768).fill(0.1) }] });
    }
    throw new Error(`unexpected request to ${url}`);
  };
  return { requests, fetchImpl };
}

function probeInput(overrides = {}) {
  const { requests, fetchImpl } = overrides.estate ?? estate();
  return {
    requests,
    input: {
      endpoints: endpoints(),
      serviceManifest: serviceManifest(),
      modelWeights: modelWeights(),
      fetchImpl,
      inspectContainer: async (name) => (name === 'shadowgraph-v11-neo4j'
        ? { id: 'container-neo4j', image: NEO4J_IMAGE_ID, layers: [...NEO4J_LAYERS] }
        : { id: 'container-ollama', image: OLLAMA_IMAGE_ID, layers: [...OLLAMA_LAYERS] }),
      inspectImage: async (reference) => (reference === 'neo4j:5.20'
        ? { id: NEO4J_TAG_ID, layers: [...NEO4J_LAYERS] }
        : { id: OLLAMA_TAG_ID, layers: [...OLLAMA_LAYERS] }),
      readModelWeightsDigest: async (_container, modelId) => (modelId === 'qwen2.5:0.5b'
        ? LLM_WEIGHTS
        : EMBEDDING_WEIGHTS),
      readAuthorization: (service) => (service.authEnvironmentVariable === undefined
        ? null
        : `Basic ${Buffer.from(NEO4J_SECRET, 'utf8').toString('base64')}`),
      now: NOW,
      ...overrides.input
    }
  };
}

function gate(evidence, now = NOW) {
  return verifyServiceEvidence({
    evidence,
    serviceManifest: serviceManifest(),
    modelWeights: modelWeights(),
    now
  });
}

test('a healthy estate produces a record its own verifier accepts', async () => {
  const { input } = probeInput();
  const evidence = await probeServices(input);

  assert.equal(evidence.observedAt, new Date(NOW).toISOString());
  assert.deepEqual(evidence.services.map((service) => service.name), ['neo4j', 'ollama']);
  assert.ok(evidence.services.every((service) => service.checks.every((entry) => entry.outcome === 'PASS')));

  const verified = gate(evidence);
  assert.deepEqual(verified.findings, []);
  assert.deepEqual([...verified.verifiedServices].sort(), ['neo4j', 'ollama']);
});

test('the record names the committed image, not whatever the container was started as', async () => {
  const { input } = probeInput();
  const evidence = await probeServices(input);
  assert.deepEqual(
    evidence.services.map((service) => service.image),
    ['neo4j:5.20', 'ollama/ollama:0.33.2']
  );
  assert.deepEqual(
    evidence.services.map((service) => service.resolvedDigest),
    [NEO4J_IMAGE_ID, OLLAMA_IMAGE_ID]
  );
});

test('weight digests are read from the serving container, not copied from the lock', async () => {
  const observed = [];
  const { input } = probeInput({
    input: {
      readModelWeightsDigest: async (container, modelId) => {
        observed.push({ container, modelId });
        return modelId === 'qwen2.5:0.5b' ? LLM_WEIGHTS : EMBEDDING_WEIGHTS;
      }
    }
  });
  await probeServices(input);
  assert.deepEqual(observed, [
    { container: 'shadowgraph-v11-ollama', modelId: 'qwen2.5:0.5b' },
    { container: 'shadowgraph-v11-ollama', modelId: 'nomic-embed-text:v1.5' }
  ]);
});

test('a model whose installed weights cannot be read is recorded, and refused by the gate', async () => {
  const { input } = probeInput({
    input: {
      readModelWeightsDigest: async (_container, modelId) => {
        if (modelId === 'nomic-embed-text:v1.5') throw new Error('no such file');
        return LLM_WEIGHTS;
      }
    }
  });
  const evidence = await probeServices(input);
  const ollama = evidence.services.find((service) => service.name === 'ollama');
  assert.equal(ollama.servedModels[1].weightsDigest, null);
  assert.ok(ollama.checks.some((entry) => entry.kind === 'model-weights' && entry.outcome === 'FAIL'));
  assert.ok(!gate(evidence).verifiedServices.has('ollama'));
});

test('an unreachable service is recorded as failed, and refused by the gate', async () => {
  const { input } = probeInput({
    estate: estate({ 'http://127.0.0.1:7474/db/neo4j/tx/commit': jsonResponse(401, { errors: [{ code: 'Unauthorized' }] }) })
  });
  const evidence = await probeServices(input);
  const neo4j = evidence.services.find((service) => service.name === 'neo4j');
  const cypher = neo4j.checks.find((entry) => entry.kind === 'cypher-statement');
  assert.equal(cypher.outcome, 'FAIL');
  assert.match(cypher.detail, /401/u);

  const verified = gate(evidence);
  assert.ok(!verified.verifiedServices.has('neo4j'));
  assert.ok(verified.verifiedServices.has('ollama'), 'the healthy service is still established');
});

test('an endpoint that answers 200 with an error body is a failure, not a pass', async () => {
  const { input } = probeInput({
    estate: estate({
      'http://127.0.0.1:11434/v1/embeddings': jsonResponse(200, { error: { message: 'model not found' } })
    })
  });
  const evidence = await probeServices(input);
  const ollama = evidence.services.find((service) => service.name === 'ollama');
  const embeddings = ollama.checks.find((entry) => entry.kind === 'openai-embeddings');
  assert.equal(embeddings.outcome, 'FAIL');
  assert.match(embeddings.detail, /model not found/u);
  assert.ok(!gate(evidence).verifiedServices.has('ollama'));
});

test('identity holds when only the image ids differ, because that is what pinning by digest does', async () => {
  // Regression: comparing image ids reported a mismatch between a live,
  // correctly digest-pinned container and the very tag it was pinned from,
  // because the tag resolves to the multi-platform index and the digest pull
  // resolves to the platform manifest inside it.
  const { input } = probeInput();
  const evidence = await probeServices(input);
  for (const service of evidence.services) {
    const identity = service.checks.find((entry) => entry.kind === 'image-identity');
    assert.equal(identity.outcome, 'PASS', identity.detail);
  }
  assert.notEqual(NEO4J_IMAGE_ID, NEO4J_TAG_ID, 'the fixture must not accidentally match by id');
});

test('a container whose layers are not the committed image layers fails identity', async () => {
  const { input } = probeInput({
    input: {
      inspectContainer: async () => ({
        id: 'container-rebuilt',
        image: `sha256:${'9'.repeat(64)}`,
        layers: [`sha256:${'d'.repeat(64)}`]
      })
    }
  });
  const evidence = await probeServices(input);
  for (const service of evidence.services) {
    const identity = service.checks.find((entry) => entry.kind === 'image-identity');
    assert.equal(identity.outcome, 'FAIL');
    assert.match(identity.detail, /does not have the layers/u);
  }
  assert.deepEqual([...gate(evidence).verifiedServices], []);
});

test('an image with no readable layers never establishes identity', async () => {
  for (const layers of [[], null, undefined, 'sha256:x']) {
    const { input } = probeInput({
      input: {
        inspectImage: async () => ({ id: NEO4J_TAG_ID, layers })
      }
    });
    const evidence = await probeServices(input);
    const identity = evidence.services[0].checks.find((entry) => entry.kind === 'image-identity');
    assert.equal(identity.outcome, 'FAIL', `layers ${JSON.stringify(layers)} must not establish identity`);
  }
});

test('the record carries no credential, and the credential does reach the request', async () => {
  const { input, requests } = probeInput();
  const evidence = await probeServices(input);
  const serialized = JSON.stringify(evidence);
  assert.ok(!serialized.includes(NEO4J_SECRET), 'the secret must not be written down');
  assert.ok(!serialized.includes(Buffer.from(NEO4J_SECRET, 'utf8').toString('base64')));

  const cypher = requests.find((entry) => entry.url.endsWith('/tx/commit'));
  assert.ok(cypher.headers.authorization, 'the probe must actually authenticate');
});

test('endpoints must declare this schema and a known kind', async () => {
  for (const services of [
    [{ name: 'neo4j', kind: 'redis', container: 'c', baseUrl: 'http://127.0.0.1:1' }],
    [{ name: '', kind: 'neo4j', container: 'c', baseUrl: 'http://127.0.0.1:1' }],
    [{ name: 'neo4j', kind: 'neo4j', baseUrl: 'http://127.0.0.1:1' }]
  ]) {
    const { input } = probeInput();
    await assert.rejects(
      () => probeServices({ ...input, endpoints: { ...endpoints(), services } }),
      ServiceProbeError
    );
  }

  const { input } = probeInput();
  await assert.rejects(
    () => probeServices({ ...input, endpoints: { ...endpoints(), schema: 'something-else' } }),
    ServiceProbeError
  );
});

test('a service the committed manifest does not declare cannot be probed into existence', async () => {
  const { input } = probeInput();
  const document = endpoints();
  document.services[0].name = 'redis';
  await assert.rejects(() => probeServices({ ...input, endpoints: document }), ServiceProbeError);
});

test('every container-runtime dependency is required', async () => {
  for (const dependency of ['inspectContainer', 'inspectImage', 'readModelWeightsDigest']) {
    const { input } = probeInput();
    await assert.rejects(
      () => probeServices({ ...input, [dependency]: undefined }),
      ServiceProbeError
    );
  }
});

test('an Ollama manifest yields exactly one weight-layer digest', () => {
  const manifest = JSON.stringify({
    layers: [
      { mediaType: 'application/vnd.ollama.image.license', digest: `sha256:${'a'.repeat(64)}` },
      { mediaType: 'application/vnd.ollama.image.model', digest: LLM_WEIGHTS }
    ]
  });
  assert.equal(ollamaWeightsDigest(manifest), LLM_WEIGHTS);

  for (const rejected of [
    'not json',
    JSON.stringify({ layers: [] }),
    JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model' }] }),
    JSON.stringify({
      layers: [
        { mediaType: 'application/vnd.ollama.image.model', digest: LLM_WEIGHTS },
        { mediaType: 'application/vnd.ollama.image.model', digest: EMBEDDING_WEIGHTS }
      ]
    })
  ]) {
    assert.throws(() => ollamaWeightsDigest(rejected), ServiceProbeError);
  }
});

test('a model id resolves to its manifest path, and a malformed one is refused', () => {
  assert.equal(
    ollamaManifestPath('nomic-embed-text:v1.5'),
    '/root/.ollama/models/manifests/registry.ollama.ai/library/nomic-embed-text/v1.5'
  );
  for (const rejected of ['qwen2.5', ':0.5b', 'qwen2.5:']) {
    assert.throws(() => ollamaManifestPath(rejected), ServiceProbeError);
  }
});
