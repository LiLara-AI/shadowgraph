import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const embeddingProbe = path.join(root, 'benchmark', 'probes', 'cognee_embedding_retry_taxonomy_demonstration.py');

test('offline embedding retry probe never embeds a credential-shaped API key literal', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(
    packageJson.scripts['benchmark:test:js'],
    /test\/benchmark-probe-secret-boundary\.test\.js/u
  );
  const source = await readFile(embeddingProbe, 'utf8');
  assert.doesNotMatch(source, /api_key\s*=\s*['"][^'"]+['"]/u);
  assert.match(source, /api_key\s*=\s*['"]{2}/u);
});
