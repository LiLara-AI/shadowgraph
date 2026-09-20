import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = path.join(root, 'benchmark', 'probes', 'cognee_acl_demonstration.py');

test('Cognee ACL demonstration supplies a designated non-secret local key before ingest', async () => {
  const source = await readFile(probe, 'utf8');
  assert.match(source, /^UNUSED_API_KEY = "not-a-secret"$/mu);
  assert.match(source, /api_key\s*=\s*UNUSED_API_KEY/u);
  assert.match(source, /set_llm_api_key\(api_key\)/u);
  assert.match(source, /set_embedding_api_key\(api_key\)/u);
  assert.doesNotMatch(source, /api_key\s*=\s*""/u);
});
