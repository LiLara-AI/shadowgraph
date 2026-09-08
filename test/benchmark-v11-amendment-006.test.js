import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadV11AcceptanceDefinition } from '../benchmark/lib/v11-definition.mjs';
import { validateNativeAttemptPolicy } from '../benchmark/lib/v11-native-attempts.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AMENDMENT_PATH = path.join(REPOSITORY_ROOT, 'benchmark', 'preregistration-amendment-006.json');
const ARM_IDS = [
  'no-memory', 'shadowgraph-full', 'shadowgraph-compact', 'mem0-oss',
  'graphiti', 'basic-memory', 'cognee'
];

test('the benchmark JavaScript gate includes Amendment 006 regression coverage', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(packageJson.scripts['benchmark:test:js'], /test\/benchmark-v11-amendment-006\.test\.js/u);
  assert.match(packageJson.scripts['benchmark:test:js'], /test\/benchmark-v11-native-attempts\.test\.js/u);
  assert.match(packageJson.scripts['benchmark:test:js'], /test\/benchmark-v11-native-attempt-evidence\.test\.js/u);
  assert.match(packageJson.scripts['benchmark:test:js'], /test\/benchmark-v11-native-attempt-evidence-loader\.test\.js/u);
  assert.match(packageJson.scripts['benchmark:test:js'], /test\/benchmark-v11-native-syntax-gate\.test\.js/u);
});

test('Amendment 006 binds the arm-neutral native-attempt trace contract before loading acceptance', async () => {
  const source = await readFile(AMENDMENT_PATH);
  const amendment = JSON.parse(source.toString('utf8'));
  assert.equal(amendment.amendmentId, 'amendment-006');
  assert.equal(amendment.supersedes.amendment005Sha256,
    'c435fa9d772c151c83214ef3a4180e0646236cd2cbb079be082b8341c4e6e223');
  assert.equal(amendment.nativeAttemptTraceContract.maxAttemptsPerRootRequestClass, 24);
  const policy = validateNativeAttemptPolicy(amendment.nativeAttemptTraceContract.armNeutralRecoveryPolicy, ARM_IDS);
  assert.deepEqual(policy.policies.get('cognee').internal_memory_llm, ['C']);
  assert.deepEqual(policy.policies.get('cognee').embedding, ['B']);
  for (const armId of ARM_IDS.filter((id) => id !== 'cognee')) {
    assert.deepEqual(policy.policies.get(armId).internal_memory_llm, []);
    assert.deepEqual(policy.policies.get(armId).embedding, []);
  }

  const actualHash = createHash('sha256').update(source).digest('hex');
  const candidate = await loadV11AcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });
  assert.equal(candidate.sourceHashes.amendment006Sha256, actualHash);
  assert.equal(candidate.nativeAttemptPolicy.maxAttemptsPerRootRequestClass, 24);
  assert.equal(candidate.nativeAttemptPolicy.arms.find((arm) => arm.armId === 'cognee').recovery.internal_memory_llm[0], 'C');
});
