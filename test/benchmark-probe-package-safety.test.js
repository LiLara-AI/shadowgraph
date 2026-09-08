import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(root, 'scripts', 'check-package.mjs');

test('the actual packaged native retry probes satisfy package privacy policy', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(
    packageJson.scripts['benchmark:test:js'],
    /test\/benchmark-probe-package-safety\.test\.js/u
  );
  const result = await execFile(process.execPath, [checker], { cwd: root });
  assert.match(result.stdout, /package metadata and tarball contents valid/u);
});
