import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingClient } from '../src/embedding.js';

test('OpenAI-compatible embeddings are localhost-only by default and validated', async () => {
  const calls = [];
  const embed = createEmbeddingClient({
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'nomic-embed-text',
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: [0.25, -0.5, 0.75] }] })
      };
    }
  });

  const result = await embed('quiet boutique lodging');
  assert.deepEqual(result, { model: 'nomic-embed-text', values: [0.25, -0.5, 0.75] });
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/embeddings');
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: 'nomic-embed-text', input: 'quiet boutique lodging' });
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[0].options.redirect, 'error');

  assert.throws(() => createEmbeddingClient({
    baseUrl: 'https://api.example.com/v1',
    model: 'remote-model'
  }), /Remote embedding endpoints require allowRemote=true/);

  const remote = createEmbeddingClient({
    baseUrl: 'https://api.example.com/v1',
    model: 'remote-model',
    apiKey: 'secret',
    allowRemote: true,
    fetch: async (_url, options) => ({
      ok: true,
      json: async () => {
        assert.equal(options.headers.authorization, 'Bearer secret');
        return { data: [{ embedding: [1, 0] }] };
      }
    })
  });
  assert.deepEqual(await remote('allowed explicitly'), { model: 'remote-model', values: [1, 0] });

  const malformed = createEmbeddingClient({
    baseUrl: 'http://localhost:11434/v1',
    model: 'bad',
    fetch: async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1, 'x'] }] }) })
  });
  await assert.rejects(() => malformed('bad response'), /finite numeric vector/);

  const mismatched = createEmbeddingClient({
    baseUrl: 'http://localhost:11434/v1',
    model: 'requested-model',
    fetch: async () => ({
      ok: true,
      json: async () => ({ model: 'actual-model', data: [{ embedding: [1, 0] }] })
    })
  });
  await assert.rejects(() => mismatched('wrong model'), /Embedding response model actual-model does not match requested-model/);
});
