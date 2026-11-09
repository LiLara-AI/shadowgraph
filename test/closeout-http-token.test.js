import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraphServer } from '../src/server.js';

test('a defined empty HTTP token is rejected rather than silently disabling authentication', async () => {
  const store = { load: async () => ({ records: [] }), save: async () => {} };
  for (const apiToken of ['', 'short']) {
    await assert.rejects(createShadowGraphServer({ store, apiToken }), /at least 16 characters/);
  }
  // Explicit absence retains the supported local optional-auth mode.
  const { server } = await createShadowGraphServer({ store, apiToken: undefined });
  server.close();
});
