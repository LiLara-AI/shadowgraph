import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(root, 'scripts', 'check-benchmark-python-syntax.mjs');

test('benchmark Python syntax gate uses the portable Node launcher and parses adapters', async () => {
  const launcherSource = await readFile(launcher, 'utf8');
  assert.match(launcherSource, /benchmark\/probes/u);
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(
    packageJson.scripts['benchmark:test:js'],
    /test\/check-benchmark-python-syntax\.test\.js/u
  );
  assert.equal(
    packageJson.scripts['benchmark:check:python'],
    'node scripts/check-benchmark-python-syntax.mjs'
  );

  const result = await execFile(process.execPath, [launcher], { cwd: root });
  assert.match(result.stdout, /BENCHMARK_PYTHON_SYNTAX=PASS/u);
});
