// Verified service evidence: the input by which a provisioned required service
// may clear a readiness blocker.
//
// The point of these tests is the direction of the default. Absent, stale,
// malformed, mismatched or failing evidence must leave the blocker standing;
// only a record that agrees with the committed manifest and the committed model
// weight lock, and that was observed recently, may clear one. Every test below
// that expects a clearance is paired with one that removes a single field and
// expects the clearance to disappear.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SERVICE_EVIDENCE_MAX_AGE_MS,
  SERVICE_EVIDENCE_SCHEMA,
  verifyServiceEvidence
} from '../benchmark/lib/v11-service-evidence.mjs';

const NOW = Date.parse('2026-09-05T03:00:00.000Z');
const OBSERVED_AT = '2026-09-05T02:55:00.000Z';

const NEO4J_DIGEST = `sha256:${'9'.repeat(64)}`;
const OLLAMA_DIGEST = `sha256:${'8'.repeat(64)}`;
const LLM_WEIGHTS = `sha256:${'c'.repeat(64)}`;
const EMBEDDING_WEIGHTS = `sha256:${'e'.repeat(64)}`;

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
      { kind: 'decision_llm', modelId: 'qwen2.5:7b', digestKind: 'model_weights', weightsDigest: LLM_WEIGHTS },
      { kind: 'embedding', modelId: 'nomic-embed-text:v1.5', digestKind: 'model_weights', weightsDigest: EMBEDDING_WEIGHTS }
    ]
  };
}

function evidence(overrides = {}) {
  return {
    schema: SERVICE_EVIDENCE_SCHEMA,
    version: 1,
    observedAt: OBSERVED_AT,
    services: [
      {
        name: 'neo4j',
        image: 'neo4j:5.20',
        resolvedDigest: NEO4J_DIGEST,
        containerId: 'f77e3ef92797',
        servedModels: [],
        checks: [
          {
            kind: 'http-status',
            endpoint: 'http://127.0.0.1:7474/',
            observedAt: OBSERVED_AT,
            outcome: 'PASS',
            detail: 'HTTP 200'
          },
          {
            kind: 'cypher-statement',
            endpoint: 'http://127.0.0.1:7474/db/neo4j/tx/commit',
            observedAt: OBSERVED_AT,
            outcome: 'PASS',
            detail: 'RETURN 1 AS ok'
          }
        ]
      },
      {
        name: 'ollama',
        image: 'ollama/ollama:0.33.2',
        resolvedDigest: OLLAMA_DIGEST,
        containerId: '9bf2e614d12d',
        servedModels: [
          { modelId: 'qwen2.5:7b', weightsDigest: LLM_WEIGHTS },
          { modelId: 'nomic-embed-text:v1.5', weightsDigest: EMBEDDING_WEIGHTS }
        ],
        checks: [
          {
            kind: 'openai-chat-completions',
            endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
            observedAt: OBSERVED_AT,
            outcome: 'PASS',
            detail: 'HTTP 200'
          },
          {
            kind: 'openai-embeddings',
            endpoint: 'http://127.0.0.1:11434/v1/embeddings',
            observedAt: OBSERVED_AT,
            outcome: 'PASS',
            detail: 'HTTP 200, 768 dimensions'
          }
        ]
      }
    ],
    ...overrides
  };
}

function verify(input = {}) {
  return verifyServiceEvidence({
    evidence: evidence(),
    serviceManifest: serviceManifest(),
    modelWeights: modelWeights(),
    now: NOW,
    ...input
  });
}

function mutateService(name, mutate) {
  const document = evidence();
  const service = document.services.find((entry) => entry.name === name);
  mutate(service);
  return document;
}

test('a complete, fresh record verifies every service it describes', () => {
  const result = verify();
  assert.deepEqual(result.findings, []);
  assert.deepEqual([...result.verifiedServices].sort(), ['neo4j', 'ollama']);
});

test('absent evidence verifies nothing and is not an error', () => {
  for (const missing of [null, undefined]) {
    const result = verify({ evidence: missing });
    assert.deepEqual([...result.verifiedServices], [], 'absence must never verify a service');
    assert.deepEqual(result.findings.map((finding) => finding.code), ['SERVICE_EVIDENCE_ABSENT']);
  }
});

test('a record that is not this schema verifies nothing', () => {
  for (const document of [
    {},
    { schema: 'shadowgraph.v11.something-else', version: 1, observedAt: OBSERVED_AT, services: [] },
    { schema: SERVICE_EVIDENCE_SCHEMA, version: 2, observedAt: OBSERVED_AT, services: [] },
    { schema: SERVICE_EVIDENCE_SCHEMA, version: 1, observedAt: OBSERVED_AT, services: 'neo4j' }
  ]) {
    const result = verify({ evidence: document });
    assert.deepEqual([...result.verifiedServices], []);
    assert.ok(result.findings.length > 0, 'a malformed record must produce a finding');
  }
});

test('evidence older than the freshness window verifies nothing', () => {
  const result = verify({ now: NOW + SERVICE_EVIDENCE_MAX_AGE_MS + 1 });
  assert.deepEqual([...result.verifiedServices], []);
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_EVIDENCE_STALE'));
});

test('evidence dated in the future verifies nothing', () => {
  const result = verify({ now: Date.parse(OBSERVED_AT) - 1 });
  assert.deepEqual([...result.verifiedServices], []);
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_EVIDENCE_FUTURE_DATED'));
});

test('a service the committed manifest does not declare is not verified', () => {
  const document = evidence();
  document.services.push({
    name: 'undeclared-cache',
    image: 'redis:7.4',
    resolvedDigest: `sha256:${'a'.repeat(64)}`,
    containerId: 'aaaabbbbcccc',
    servedModels: [],
    checks: [{ kind: 'http-status', endpoint: 'http://127.0.0.1:6379/', observedAt: OBSERVED_AT, outcome: 'PASS', detail: 'HTTP 200' }]
  });
  const result = verify({ evidence: document });
  assert.ok(!result.verifiedServices.has('undeclared-cache'));
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_NOT_DECLARED' && finding.service === 'undeclared-cache'));
  assert.ok(result.verifiedServices.has('neo4j'), 'one undeclared entry must not invalidate the declared ones');
});

test('an image reference that differs from the committed manifest is not verified', () => {
  const document = mutateService('neo4j', (service) => { service.image = 'neo4j:5.21'; });
  const result = verify({ evidence: document });
  assert.ok(!result.verifiedServices.has('neo4j'));
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_IMAGE_MISMATCH' && finding.service === 'neo4j'));
});

test('a resolved digest that is not a sha256 reference is not verified', () => {
  for (const digest of ['', 'sha256:short', 'neo4j:5.20', `sha256:${'Z'.repeat(64)}`, `sha256:${'9'.repeat(63)}`]) {
    const document = mutateService('neo4j', (service) => { service.resolvedDigest = digest; });
    const result = verify({ evidence: document });
    assert.ok(!result.verifiedServices.has('neo4j'), `digest ${digest} must not verify`);
    assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_DIGEST_MALFORMED'));
  }
});

test('a service with no checks at all is not verified', () => {
  const document = mutateService('neo4j', (service) => { service.checks = []; });
  const result = verify({ evidence: document });
  assert.ok(!result.verifiedServices.has('neo4j'));
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_UNCHECKED' && finding.service === 'neo4j'));
});

test('a single failed check withholds verification from its service', () => {
  const document = mutateService('neo4j', (service) => { service.checks[1].outcome = 'FAIL'; });
  const result = verify({ evidence: document });
  assert.ok(!result.verifiedServices.has('neo4j'));
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_CHECK_FAILED' && finding.service === 'neo4j'));
  assert.ok(result.verifiedServices.has('ollama'), 'a failure in one service must not withhold another');
});

test('a check observed outside the freshness window withholds verification', () => {
  const stale = new Date(NOW - SERVICE_EVIDENCE_MAX_AGE_MS - 1_000).toISOString();
  const document = mutateService('ollama', (service) => { service.checks[0].observedAt = stale; });
  const result = verify({ evidence: document });
  assert.ok(!result.verifiedServices.has('ollama'));
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_CHECK_STALE' && finding.service === 'ollama'));
});

test('every locked model weight must be served, with a digest that matches the lock', () => {
  const absent = mutateService('ollama', (service) => { service.servedModels = [service.servedModels[0]]; });
  const absentResult = verify({ evidence: absent });
  assert.ok(!absentResult.verifiedServices.has('ollama'));
  assert.ok(absentResult.findings.some((finding) => (
    finding.code === 'SERVICE_MODEL_ABSENT' && finding.modelId === 'nomic-embed-text:v1.5'
  )));

  const mismatched = mutateService('ollama', (service) => {
    service.servedModels[1].weightsDigest = `sha256:${'f'.repeat(64)}`;
  });
  const mismatchedResult = verify({ evidence: mismatched });
  assert.ok(!mismatchedResult.verifiedServices.has('ollama'));
  assert.ok(mismatchedResult.findings.some((finding) => (
    finding.code === 'SERVICE_MODEL_DIGEST_MISMATCH' && finding.modelId === 'nomic-embed-text:v1.5'
  )));
});

test('a model-serving claim is only required of the service that claims to serve models', () => {
  // Neo4j serves no model and must not be asked to. The locked weights are a
  // property of the common endpoint, not of every provisioned service.
  const result = verify();
  assert.ok(result.verifiedServices.has('neo4j'));
});

test('the locked weights must be served by one endpoint, not spread across several', () => {
  const document = evidence();
  document.services[0].servedModels = [{ modelId: 'nomic-embed-text:v1.5', weightsDigest: EMBEDDING_WEIGHTS }];
  document.services[1].servedModels = [{ modelId: 'qwen2.5:7b', weightsDigest: LLM_WEIGHTS }];
  const result = verify({ evidence: document });
  assert.ok(!result.verifiedServices.has('ollama'), 'a partial model set must not verify the common endpoint');
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_MODEL_ABSENT'));
});

test('the committed manifest and weight lock are required inputs, and their absence verifies nothing', () => {
  for (const input of [{ serviceManifest: null }, { modelWeights: null }, { serviceManifest: {} }, { modelWeights: {} }]) {
    const result = verify(input);
    assert.deepEqual([...result.verifiedServices], [], 'without a committed baseline nothing can be checked against it');
    assert.ok(result.findings.length > 0);
  }
});

test('the result records that it cannot establish the probe actually ran', () => {
  const result = verify();
  assert.match(result.note, /cannot establish/iu);
});

test('a service described twice verifies neither description', () => {
  // Found by attacking this module rather than by reading it. A record can pair
  // a healthy entry with a broken duplicate of the same service: the healthy one
  // used to add the name to the verified set while the broken one only added a
  // finding, so the blocker cleared. Which of two contradictory descriptions is
  // true is not answerable here, so neither is used.
  const document = evidence();
  const ollama = document.services.find((service) => service.name === 'ollama');
  document.services.push({
    ...structuredClone(ollama),
    checks: [{
      kind: 'openai-chat-completions',
      endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
      observedAt: OBSERVED_AT,
      outcome: 'FAIL',
      detail: 'connection refused'
    }]
  });

  const result = verify({ evidence: document });
  assert.ok(!result.verifiedServices.has('ollama'), 'a contradicted service must not verify');
  assert.ok(result.findings.some((finding) => (
    finding.code === 'SERVICE_DUPLICATE_ENTRY' && finding.service === 'ollama'
  )));
});

test('two identical healthy entries for one service are still refused', () => {
  // Not only contradictions. A duplicate is a record this module cannot reason
  // about, whatever the two copies happen to say.
  const document = evidence();
  const neo4j = document.services.find((service) => service.name === 'neo4j');
  document.services.push(structuredClone(neo4j));

  const result = verify({ evidence: document });
  assert.ok(!result.verifiedServices.has('neo4j'));
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_DUPLICATE_ENTRY'));
});

test('evidence exactly at the freshness window has already expired', () => {
  const result = verify({ now: NOW + SERVICE_EVIDENCE_MAX_AGE_MS });
  assert.deepEqual([...result.verifiedServices], []);
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_EVIDENCE_STALE'));
});

test('a record where nothing serves the locked weights verifies nothing at all', () => {
  // Found by mutation: deleting the whole-record model-endpoint rule left every
  // existing test green, because each one also tripped a per-service finding.
  // This is the case only the record-level rule catches - every service is
  // individually healthy, and none of them is the common endpoint. Verifying
  // here would clear Cognee's required service on evidence that no model
  // endpoint exists.
  const document = evidence();
  for (const service of document.services) service.servedModels = [];

  const result = verify({ evidence: document });
  assert.deepEqual([...result.verifiedServices], [], 'a provisioned database is not a model endpoint');
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_MODEL_ENDPOINT_ABSENT'));
});

test('a service that serves the weights but is otherwise broken cannot be the endpoint', () => {
  // The record-level rule counts only VERIFIED services. An endpoint that
  // serves every locked model and fails its health check establishes nothing,
  // and must not stand in as the common endpoint for the others.
  const document = mutateService('ollama', (service) => {
    service.checks[0].outcome = 'FAIL';
  });

  const result = verify({ evidence: document });
  assert.ok(!result.verifiedServices.has('ollama'));
  assert.deepEqual([...result.verifiedServices], [], 'neo4j must not verify on a record with no working endpoint');
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_MODEL_ENDPOINT_ABSENT'));
});

test('a service claiming the locked weights must answer on both endpoint surfaces', () => {
  // Found by review, and the concrete regression it defends: a refactor that
  // swallowed the chat call left `ollama` with an embeddings check, correct
  // served models, and no findings at all - because the served digests come
  // from the container manifest, not from the chat probe. The record verified
  // without ever establishing that the decision model generates.
  for (const dropped of ['openai-chat-completions', 'openai-embeddings']) {
    const document = mutateService('ollama', (service) => {
      service.checks = service.checks.filter((check) => check.kind !== dropped);
    });
    const result = verify({ evidence: document });
    assert.ok(!result.verifiedServices.has('ollama'), `dropping ${dropped} must withhold verification`);
    assert.ok(result.findings.some((finding) => (
      finding.code === 'SERVICE_ENDPOINT_CHECKS_MISSING' && finding.check === dropped
    )));
  }
});

test('an identity check alone does not establish that a service answers', () => {
  // Identity says which image is running. A container can be the right image
  // and be wedged.
  const document = mutateService('neo4j', (service) => {
    service.checks = [{
      kind: 'image-identity',
      endpoint: 'shadowgraph-v11-neo4j',
      observedAt: OBSERVED_AT,
      outcome: 'PASS',
      detail: 'layers match'
    }];
  });
  const result = verify({ evidence: document });
  assert.ok(!result.verifiedServices.has('neo4j'));
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_LIVENESS_UNPROVEN'));
});

test('a check kind this module does not define is refused, not ignored', () => {
  // The kind list is an allow-list and nothing else enforced it. Without this
  // a record could verify a service on the strength of a check nobody defined.
  const document = mutateService('neo4j', (service) => {
    service.checks[0] = { ...service.checks[0], kind: 'looks-fine-to-me' };
  });
  const result = verify({ evidence: document });
  assert.ok(!result.verifiedServices.has('neo4j'));
  assert.ok(result.findings.some((finding) => finding.code === 'SERVICE_CHECK_MALFORMED'));
});

test('the freshness boundary is measured from the record, and expires at the window', () => {
  // The earlier boundary test stamped the record five minutes before NOW and
  // then advanced NOW by the whole window, so it asserted an age of
  // window+5min and held identically under > and >=. Reverting the comparison
  // left it green. This drives both sides from the record's own instant.
  const observedAt = Date.parse(OBSERVED_AT);

  const atWindow = verify({ now: observedAt + SERVICE_EVIDENCE_MAX_AGE_MS });
  assert.deepEqual([...atWindow.verifiedServices], [], 'evidence expires at the window, not after it');
  assert.ok(atWindow.findings.some((finding) => finding.code === 'SERVICE_EVIDENCE_STALE'));

  const justInside = verify({ now: observedAt + SERVICE_EVIDENCE_MAX_AGE_MS - 1 });
  assert.deepEqual([...justInside.verifiedServices].sort(), ['neo4j', 'ollama']);
  assert.deepEqual(justInside.findings, []);
});

test('a single check expires at the window even while the record around it is fresh', () => {
  // The record-level and check-level boundaries are separate comparisons, and
  // only the record-level one was pinned. This drives the check-level one on its
  // own: a document stamped a second ago, carrying a check stamped exactly a
  // window ago.
  const recordAt = new Date(NOW - 1_000).toISOString();
  const checkAt = new Date(NOW - SERVICE_EVIDENCE_MAX_AGE_MS).toISOString();

  const document = evidence({ observedAt: recordAt });
  for (const service of document.services) {
    for (const check of service.checks) check.observedAt = recordAt;
  }
  const neo4j = document.services.find((service) => service.name === 'neo4j');
  neo4j.checks[1].observedAt = checkAt;

  const result = verify({ evidence: document });
  assert.ok(!result.verifiedServices.has('neo4j'), 'a check expires at the window, not after it');
  assert.ok(result.findings.some((finding) => (
    finding.code === 'SERVICE_CHECK_STALE' && finding.service === 'neo4j'
  )));
  assert.ok(result.verifiedServices.has('ollama'), 'and only its own service is withheld');
});
