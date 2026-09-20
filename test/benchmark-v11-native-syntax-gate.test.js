import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { scratchDirectory } from '../tools/scratch-directory.js';

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const NATIVE_MODULES = Object.freeze([
  'benchmark/lib/v11-native-attempts.mjs',
  'benchmark/lib/v11-native-attempt-evidence.mjs',
  'benchmark/lib/v11-native-attempt-evidence-loader.mjs'
]);

test('benchmark syntax gate names every native-attempt module and each syntax defect is rejected', async (t) => {
  const packageJson = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  const benchmarkCheck = packageJson.scripts['benchmark:check'];
  assert.doesNotMatch(benchmarkCheck, /npm run/u);
  assert.match(packageJson.scripts.check, /node scripts\/check-benchmark-syntax\.mjs/u);
  assert.doesNotMatch(packageJson.scripts.check, /npm run benchmark:check/u);
  const gateSource = await readFile(path.join(REPOSITORY_ROOT, 'scripts', 'check-benchmark-syntax.mjs'), 'utf8');
  for (const modulePath of NATIVE_MODULES) {
    assert.match(benchmarkCheck, new RegExp(`node --check ${modulePath.replace(/[.]/gu, '\\.')}`, 'u'));
    assert.match(gateSource, new RegExp(`['\"]${modulePath.replace(/[.]/gu, '\\.')}`, 'u'));
  }

  const directory = await scratchDirectory(t, 'shadowgraph-v11-native-syntax-');
  for (const modulePath of NATIVE_MODULES) {
    const candidate = path.join(directory, path.basename(modulePath));
    await writeFile(candidate, 'export const syntax = ;\n', 'utf8');
    await assert.rejects(
      execFileAsync(process.execPath, ['--check', candidate]),
      /SyntaxError/u,
      `${modulePath} syntax defects must be rejected by its declared Node check`
    );
  }
});
