// The producer of service evidence.
//
// The probe's job is to write down what happened, including when nothing did.
// These tests pin both halves: a healthy probe produces a record the readiness
// gate accepts, and every partial outage produces a record the gate refuses.
// Pairing the two modules in the same test is deliberate - a probe whose output
// its own verifier rejects would be useless, and only an end-to-end assertion
// catches that.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

function sha256Digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function rawRegistryAttestation(repository, tag) {
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: `sha256:${'c'.repeat(64)}`,
      size: 1
    },
    layers: [{
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      digest: `sha256:${'d'.repeat(64)}`,
      size: 1
    }]
  }));
  const digest = sha256Digest(manifestBytes);
  const indexBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest,
      size: manifestBytes.length,
      platform: { os: 'linux', architecture: 'amd64' }
    }]
  }));
  return Object.freeze({
    digest,
    registryAttestation: Object.freeze({
      registry: 'registry-1.docker.io',
      repository,
      tag,
      indexDigest: sha256Digest(indexBytes),
      indexBase64: indexBytes.toString('base64'),
      platformManifestBase64: manifestBytes.toString('base64')
    })
  });
}

const NEO4J_ATTESTATION = rawRegistryAttestation('library/neo4j', '5.20');
const OLLAMA_ATTESTATION = rawRegistryAttestation('ollama/ollama', '0.33.2');
const NEO4J_PLATFORM_MANIFEST_DIGEST = NEO4J_ATTESTATION.digest;
const OLLAMA_PLATFORM_MANIFEST_DIGEST = OLLAMA_ATTESTATION.digest;
const NEO4J_LAYERS = [`sha256:${'a'.repeat(64)}`, `sha256:${'b'.repeat(64)}`];
const OLLAMA_LAYERS = [`sha256:${'7'.repeat(64)}`];
const LLM_WEIGHTS = `sha256:${'c'.repeat(64)}`;
const EMBEDDING_WEIGHTS = `sha256:${'e'.repeat(64)}`;
const NEO4J_SECRET = 'neo4j:correct-horse-battery-staple';

function serviceManifest() {
  return {
    schema: 'shadowgraph.service-images',
    version: 3,
    services: [
      {
        name: 'neo4j',
        image: 'neo4j:5.20',
        digest: NEO4J_PLATFORM_MANIFEST_DIGEST,
        digestKind: 'oci-platform-manifest',
        platform: 'linux/amd64',
        registryAttestation: NEO4J_ATTESTATION.registryAttestation
      },
      {
        name: 'ollama',
        image: 'ollama/ollama:0.33.2',
        digest: OLLAMA_PLATFORM_MANIFEST_DIGEST,
        digestKind: 'oci-platform-manifest',
        platform: 'linux/amd64',
        registryAttestation: OLLAMA_ATTESTATION.registryAttestation
      }
    ]
  };
}

function modelWeights() {
  return {
    schemaVersion: 1,
    models: [
      { kind: 'decision_llm', modelId: 'qwen2.5:7b', digestKind: 'model_weights', weightsDigest: LLM_WEIGHTS },
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
      return jsonResponse(200, { model: 'qwen2.5:7b', choices: [{ message: { role: 'assistant', content: 'OK' } }] });
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
      inspectImage: async (reference) => (reference.startsWith('neo4j@')
        ? { id: NEO4J_IMAGE_ID, layers: [...NEO4J_LAYERS], platform: 'linux/amd64' }
        : { id: OLLAMA_IMAGE_ID, layers: [...OLLAMA_LAYERS], platform: 'linux/amd64' }),
      readModelWeightsDigest: async (_container, modelId) => (modelId === 'qwen2.5:7b'
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
    [NEO4J_PLATFORM_MANIFEST_DIGEST, OLLAMA_PLATFORM_MANIFEST_DIGEST]
  );
});

test('the probe persists a complete service-bound OCI platform identity, not an untyped local image ID', async () => {
  const { input } = probeInput();
  const evidence = await probeServices(input);

  for (const service of evidence.services) {
    const expected = service.name === 'neo4j'
      ? {
          digest: NEO4J_PLATFORM_MANIFEST_DIGEST,
          index: NEO4J_ATTESTATION.registryAttestation.indexDigest,
          imageId: NEO4J_IMAGE_ID
        }
      : {
          digest: OLLAMA_PLATFORM_MANIFEST_DIGEST,
          index: OLLAMA_ATTESTATION.registryAttestation.indexDigest,
          imageId: OLLAMA_IMAGE_ID
        };
    assert.deepEqual(service.imageIdentity, {
      schema: 'shadowgraph.v11.service-image-identity',
      version: 1,
      serviceName: service.name,
      image: service.image,
      platformManifestDigest: expected.digest,
      registryIndexDigest: expected.index,
      platform: 'linux/amd64',
      immutableReference: `${service.image.slice(0, service.image.lastIndexOf(':'))}@${expected.digest}`,
      containerReference: `shadowgraph-v11-${service.name}`,
      containerId: service.containerId,
      containerImageId: expected.imageId
    });
  }
});

test('the probe inspects the canonical repository platform-manifest reference', async () => {
  const inspected = [];
  const { input } = probeInput({
    input: {
      inspectImage: async (reference) => {
        inspected.push(reference);
        if (reference === `neo4j@${NEO4J_PLATFORM_MANIFEST_DIGEST}`) {
          return { id: NEO4J_IMAGE_ID, layers: [...NEO4J_LAYERS], platform: 'linux/amd64' };
        }
        if (reference === `ollama/ollama@${OLLAMA_PLATFORM_MANIFEST_DIGEST}`) {
          return { id: OLLAMA_IMAGE_ID, layers: [...OLLAMA_LAYERS], platform: 'linux/amd64' };
        }
        throw new Error(`unexpected immutable reference ${reference}`);
      }
    }
  });
  const evidence = await probeServices(input);

  assert.ok(evidence.services.every((service) => service.checks[0].outcome === 'PASS'));
  assert.deepEqual(inspected, [
    `neo4j@${NEO4J_PLATFORM_MANIFEST_DIGEST}`,
    `ollama/ollama@${OLLAMA_PLATFORM_MANIFEST_DIGEST}`
  ]);
});

test('a local Docker image ID establishes a platform manifest only through the exact immutable reference', async () => {
  const manifest = serviceManifest();
  manifest.services[0].digest = NEO4J_PLATFORM_MANIFEST_DIGEST;
  manifest.services[1].digest = OLLAMA_PLATFORM_MANIFEST_DIGEST;
  const { input } = probeInput({
    input: {
      serviceManifest: manifest,
      inspectImage: async (reference) => {
        if (reference === `neo4j@${NEO4J_PLATFORM_MANIFEST_DIGEST}`) {
          return { id: NEO4J_IMAGE_ID, layers: [...NEO4J_LAYERS], platform: 'linux/amd64' };
        }
        if (reference === `ollama/ollama@${OLLAMA_PLATFORM_MANIFEST_DIGEST}`) {
          return { id: OLLAMA_IMAGE_ID, layers: [...OLLAMA_LAYERS], platform: 'linux/amd64' };
        }
        throw new Error(`unexpected immutable reference ${reference}`);
      }
    }
  });
  const evidence = await probeServices(input);
  const verified = verifyServiceEvidence({
    evidence,
    serviceManifest: manifest,
    modelWeights: modelWeights(),
    now: NOW
  });

  assert.ok(evidence.services.every((service) => service.checks[0].outcome === 'PASS'));
  assert.deepEqual(evidence.services.map((service) => service.resolvedDigest), [
    NEO4J_PLATFORM_MANIFEST_DIGEST,
    OLLAMA_PLATFORM_MANIFEST_DIGEST
  ]);
  assert.deepEqual(verified.findings, []);
});

test('weight digests are read from the serving container, not copied from the lock', async () => {
  const observed = [];
  const { input } = probeInput({
    input: {
      readModelWeightsDigest: async (container, modelId) => {
        observed.push({ container, modelId });
        return modelId === 'qwen2.5:7b' ? LLM_WEIGHTS : EMBEDDING_WEIGHTS;
      }
    }
  });
  await probeServices(input);
  assert.deepEqual(observed, [
    { container: 'shadowgraph-v11-ollama', modelId: 'qwen2.5:7b' },
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

test('identity binds a distinct platform manifest through its local image ID', async () => {
  // Docker records a local image/config identity on the container. The exact
  // immutable repository reference resolves to that local identity, while the
  // committed platform-manifest digest remains the evidence identity.
  const { input } = probeInput();
  const evidence = await probeServices(input);
  for (const service of evidence.services) {
    const identity = service.checks.find((entry) => entry.kind === 'image-identity');
    assert.equal(identity.outcome, 'PASS', identity.detail);
  }
  assert.notEqual(NEO4J_IMAGE_ID, NEO4J_PLATFORM_MANIFEST_DIGEST);
});

test('a same-layer tag/index identity cannot impersonate the committed platform manifest', async () => {
  const { input } = probeInput({
    input: {
      inspectContainer: async (name) => (name === 'shadowgraph-v11-neo4j'
        ? { id: 'container-neo4j', image: NEO4J_TAG_ID, layers: [...NEO4J_LAYERS] }
        : { id: 'container-ollama', image: OLLAMA_IMAGE_ID, layers: [...OLLAMA_LAYERS] })
    }
  });
  const evidence = await probeServices(input);
  const identity = evidence.services[0].checks.find((entry) => entry.kind === 'image-identity');

  assert.equal(identity.outcome, 'FAIL');
  assert.match(identity.detail, /platform manifest digest/u);
});

test('the persisted identity records the observed platform and a wrong platform cannot verify', async () => {
  const { input } = probeInput({
    input: {
      inspectImage: async (reference) => (reference.startsWith('neo4j@')
        ? { id: NEO4J_IMAGE_ID, layers: [...NEO4J_LAYERS], platform: 'linux/arm64' }
        : { id: OLLAMA_IMAGE_ID, layers: [...OLLAMA_LAYERS], platform: 'linux/amd64' })
    }
  });
  const evidence = await probeServices(input);
  const neo4j = evidence.services.find((service) => service.name === 'neo4j');

  assert.equal(neo4j.imageIdentity.platform, 'linux/arm64');
  assert.equal(neo4j.checks.find((check) => check.kind === 'image-identity').outcome, 'FAIL');
  const verified = gate(evidence);
  assert.equal(verified.verifiedServices.has('neo4j'), false);
  assert.ok(verified.findings.some((finding) => (
    finding.code === 'SERVICE_IMAGE_IDENTITY_PLATFORM_MISMATCH' && finding.service === 'neo4j'
  )));
});

test('a container whose layers are not the committed image layers fails identity', async () => {
  const { input } = probeInput({
    input: {
      inspectContainer: async (name) => (name === 'shadowgraph-v11-neo4j'
        ? {
            id: 'container-rebuilt-neo4j',
            image: NEO4J_IMAGE_ID,
            layers: [`sha256:${'d'.repeat(64)}`]
          }
        : {
            id: 'container-rebuilt-ollama',
            image: OLLAMA_IMAGE_ID,
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

test('endpoint userinfo and malformed authority are rejected before probing or persistence', async () => {
  const unsafe = [
    'http://probe-user:synthetic-token@127.0.0.1:7474',
    'http://probe%3Auser@127.0.0.1:7474',
    'http://probe%ZZ@127.0.0.1:7474'
  ];
  for (const baseUrl of unsafe) {
    const { input, requests } = probeInput();
    const document = endpoints();
    document.services[0].baseUrl = baseUrl;
    await assert.rejects(
      () => probeServices({ ...input, endpoints: document }),
      (error) => {
        assert.ok(error instanceof ServiceProbeError);
        assert.match(error.message, /safe absolute http or https URL without userinfo/u);
        assert.equal(error.message.includes('synthetic-token'), false);
        assert.equal(error.message.includes('probe%3Auser'), false);
        return true;
      },
      baseUrl
    );
    assert.deepEqual(requests, [], 'unsafe endpoint input must not reach a transport');
  }

  const { input } = probeInput();
  const safeEvidence = await probeServices(input);
  assert.equal(JSON.stringify(safeEvidence).includes('@127.0.0.1'), false);
  assert.ok(gate(safeEvidence).verifiedServices.has('neo4j'));
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
