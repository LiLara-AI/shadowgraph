// The pinned model behind each metered request class.
//
// A provider route is a capability: it says where an internal call may go, and
// the meter counts what arrives. It says nothing about what was asked for, and
// every one of these libraries has an opinion when nobody tells it - mem0 2.0.19
// reaches for gpt-5-mini and text-embedding-3-small at 1536 dimensions. Pointed
// at the pinned Ollama that serves qwen2.5:0.5b and a 768-wide embedder, the
// first names a model that is not installed and the second sizes a vector
// collection to a width the vectors do not have.
//
// So this module exists to make the lock the answer to "which model", and these
// tests exist to make sure the answer is the lock's and not a default that
// happens to look plausible.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PROVIDER_MODEL_CLASSES,
  ProviderModelError,
  isPinnedModelId,
  providerModelsFor,
  providerModelsFromLock
} from '../benchmark/lib/v11-provider-models.mjs';
import { PYTHON_ADAPTER_SPECS } from '../benchmark/lib/python-adapter-executor.mjs';
import { REQUEST_CLASSES } from '../benchmark/lib/v11-contract.mjs';

const LOCK_PATH = fileURLToPath(new URL('../benchmark/model-weights.lock.json', import.meta.url));

function lock(models) {
  return { schemaVersion: 1, models };
}

function pinned() {
  return [
    { kind: 'decision_llm', modelId: 'qwen2.5:0.5b', embeddingDimension: null },
    { kind: 'embedding', modelId: 'nomic-embed-text:v1.5', embeddingDimension: 768 }
  ];
}

test('the metered classes are exactly the contract classes an adapter can be routed for', () => {
  // The outer decision model is metered too, but it is the harness asking, not
  // an arm: no wrapper carries it, so it has no place here.
  assert.deepEqual([...PROVIDER_MODEL_CLASSES].sort(), ['embedding', 'internal_memory_llm']);
  for (const requestClass of PROVIDER_MODEL_CLASSES) {
    assert.ok(REQUEST_CLASSES.includes(requestClass), `${requestClass} must be a contract class`);
  }
  assert.equal(PROVIDER_MODEL_CLASSES.includes('outer_decision_llm'), false);
});

test('the real lock resolves to the models the pinned services serve', async () => {
  const modelWeights = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  const resolved = providerModelsFromLock(modelWeights);
  assert.deepEqual(resolved, {
    internal_memory_llm: { modelId: 'qwen2.5:0.5b', embeddingDimension: null },
    embedding: { modelId: 'nomic-embed-text:v1.5', embeddingDimension: 768 }
  });
});

test("the lock's chat model is what an arm's internal memory LLM must use", async () => {
  // One chat model is pinned, and the same weights answer both the outer
  // decision and every arm's internal extraction. An arm allowed its own would
  // be measured against different reasoning, and the comparison would stop
  // being between memory systems.
  const modelWeights = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  const decision = modelWeights.models.find((model) => model.kind === 'decision_llm');
  assert.equal(
    providerModelsFromLock(modelWeights).internal_memory_llm.modelId,
    decision.modelId
  );
});

test('a lock that pins no chat or no embedding model resolves nothing', () => {
  for (const models of [
    [],
    [pinned()[0]],
    [pinned()[1]],
    [{ kind: 'reranker', modelId: 'bge-reranker', embeddingDimension: null }]
  ]) {
    assert.throws(() => providerModelsFromLock(lock(models)), ProviderModelError);
  }
});

test('a lock that pins one kind twice is refused rather than resolved to the first', () => {
  assert.throws(() => providerModelsFromLock(lock([
    ...pinned(),
    { kind: 'decision_llm', modelId: 'qwen2.5:7b', embeddingDimension: null }
  ])), ProviderModelError);
});

test('the embedding model must record its width and the chat model must not', () => {
  const missingWidth = pinned();
  missingWidth[1].embeddingDimension = null;
  assert.throws(() => providerModelsFromLock(lock(missingWidth)), ProviderModelError);

  for (const dimension of [0, -768, 768.5, '768', true]) {
    const wrong = pinned();
    wrong[1].embeddingDimension = dimension;
    assert.throws(
      () => providerModelsFromLock(lock(wrong)),
      ProviderModelError,
      `${String(dimension)} must not pass as a width`
    );
  }

  // A width on the chat model means the two were transposed somewhere.
  const transposed = pinned();
  transposed[0].embeddingDimension = 768;
  assert.throws(() => providerModelsFromLock(lock(transposed)), ProviderModelError);
});

test('a model id that could not name a model is refused', () => {
  for (const modelId of ['', ' ', 'qwen 2.5:0.5b', '-qwen2.5', 'qwen\n2.5', 'a'.repeat(201), null, 7]) {
    assert.equal(isPinnedModelId(modelId), false, `${String(modelId)} must not be an id`);
    const broken = pinned();
    broken[0].modelId = modelId;
    assert.throws(() => providerModelsFromLock(lock(broken)), ProviderModelError);
  }
  for (const modelId of ['qwen2.5:0.5b', 'nomic-embed-text:v1.5', 'library/llama3.2:1b', 'a']) {
    assert.equal(isPinnedModelId(modelId), true, `${modelId} must be an id`);
  }
});

test('a lock that is not a lock resolves nothing', () => {
  for (const modelWeights of [null, undefined, {}, [], { models: 'qwen2.5:0.5b' }, lock([null]), lock(['qwen'])]) {
    assert.throws(() => providerModelsFromLock(modelWeights), ProviderModelError);
  }
});

test('narrowing gives an arm a model for each class it meters and null for the rest', async () => {
  const modelWeights = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  const both = providerModelsFor(modelWeights, ['internal_memory_llm', 'embedding']);
  assert.deepEqual(both, providerModelsFromLock(modelWeights));

  const none = providerModelsFor(modelWeights, []);
  assert.deepEqual(none, { internal_memory_llm: null, embedding: null });

  const only = providerModelsFor(modelWeights, ['embedding']);
  assert.equal(only.internal_memory_llm, null);
  assert.equal(only.embedding.modelId, 'nomic-embed-text:v1.5');
});

test('an arm that meters nothing needs no lock at all', () => {
  // Basic Memory takes no routes, so it must not be the reason a broken lock
  // stops the run - and it must not quietly receive a model either.
  assert.deepEqual(providerModelsFor(lock([]), []), {
    internal_memory_llm: null,
    embedding: null
  });
});

test('an unknown or repeated request class is refused', () => {
  for (const requestClasses of [
    'internal_memory_llm',
    ['outer_decision_llm'],
    ['internal_memory_llm', 'internal_memory_llm'],
    ['reranking']
  ]) {
    assert.throws(() => providerModelsFor(lock(pinned()), requestClasses), ProviderModelError);
  }
});

test('every Python arm that takes routes resolves against the real lock', async () => {
  const modelWeights = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  for (const [armId, spec] of Object.entries(PYTHON_ADAPTER_SPECS)) {
    const models = providerModelsFor(modelWeights, [...spec.requestClasses]);
    for (const requestClass of PROVIDER_MODEL_CLASSES) {
      const metered = spec.requestClasses.includes(requestClass);
      assert.equal(
        models[requestClass] !== null,
        metered,
        `${armId} must have a model for ${requestClass} exactly when it meters it`
      );
    }
  }
});

test('the resolved record is frozen so a caller cannot retarget one arm', () => {
  const resolved = providerModelsFromLock(lock(pinned()));
  assert.throws(() => {
    resolved.internal_memory_llm = null;
  }, TypeError);
  assert.throws(() => {
    resolved.embedding.modelId = 'gpt-5-mini';
  }, TypeError);
});
