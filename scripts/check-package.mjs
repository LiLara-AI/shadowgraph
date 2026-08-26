import { readFile } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lockfile = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));

if (manifest.version !== lockfile.version || manifest.version !== lockfile.packages?.['']?.version) {
  throw new Error(`package version mismatch: manifest=${manifest.version}, lock=${lockfile.version}, root=${lockfile.packages?.['']?.version}`);
}

const { stdout } = await execAsync(`${process.platform === 'win32' ? 'npm.cmd' : 'npm'} pack --dry-run --json --ignore-scripts`, {
  cwd: new URL('..', import.meta.url),
  maxBuffer: 1024 * 1024
});
const report = JSON.parse(stdout);
const files = report.flatMap((item) => item.files ?? []).map((item) => item.path);
const forbidden = files.filter((file) => /(^|\/)(?:__pycache__|\.npm-cache|\.shadowgraph|test|\.github)(\/|$)|\.(?:pyc|pyo|pyd|log)$/i.test(file));
if (forbidden.length) throw new Error(`forbidden package artifacts: ${forbidden.join(', ')}`);
for (const required of ['src/restore-validation.js', 'scripts/bench-journal.mjs', 'scripts/check-package.mjs']) {
  if (!files.includes(required)) throw new Error(`required package file is missing: ${required}`);
}

console.log(`package metadata and tarball contents valid for ${manifest.name}@${manifest.version} (${files.length} files)`);
