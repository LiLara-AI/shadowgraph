import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadV11AcceptanceDefinition
} from '../benchmark/lib/v11-definition.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the effective candidate identity binds every authorized amendment through Amendment 005', async () => {
  const loaded = await loadV11AcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });

  assert.match(loaded.sourceHashes.amendment004Sha256, /^[a-f0-9]{64}$/u);
  assert.match(loaded.sourceHashes.amendment005Sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(loaded.definition.sourceHashes, loaded.sourceHashes);
});

test('the benchmark JavaScript gate includes Amendment 005 regression coverage', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(
    packageJson.scripts['benchmark:test:js'],
    /test\/benchmark-v11-amendment-005\.test\.js/u
  );
});

test('Amendment 005 bytes and sidecar are governed by the implementation lock', async () => {
  const amendmentUrl = new URL('../benchmark/preregistration-amendment-005.json', import.meta.url);
  const sidecarUrl = new URL('../benchmark/preregistration-amendment-005.sha256', import.meta.url);
  const digest = createHash('sha256').update(await readFile(amendmentUrl)).digest('hex');
  const sidecar = await readFile(sidecarUrl, 'utf8');
  assert.equal(sidecar.trim().split(/\s+/u)[0], digest);

  const lockSource = await readFile(
    new URL('../benchmark/lib/implementation-lock.mjs', import.meta.url), 'utf8'
  );
  for (const role of ['amendment_005', 'amendment_005_sidecar']) {
    assert.ok(lockSource.includes(`'${role}'`), `the lock does not declare the role ${role}`);
  }
});
