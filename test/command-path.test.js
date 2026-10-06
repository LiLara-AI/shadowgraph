import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandPath } from '../src/internal/owner-files.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// The program a bare command name runs (git for the workspace checks, claude for
// the host version): on Windows an absolute name.exe on an absolute PATH entry,
// so a working directory that holds its own git.exe is never run in its place.
test('a bare command resolves to an absolute program on an absolute PATH entry, never from the working directory', async (t) => {
  if (process.platform !== 'win32') {
    assert.equal(commandPath('git', { PATH: '' }), 'git', 'elsewhere a path search never takes a bare name from the working directory');
    return;
  }
  const root = await scratchDirectory(t, 'shadowgraph-command-path-');
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'git.exe'), '');
  await mkdir(join(root, 'folder-only', 'git.exe'), { recursive: true });
  assert.equal(commandPath('git', { Path: bin }), join(bin, 'git.exe'), 'an absolute entry, however the variable is spelled');
  assert.equal(commandPath('git', { PATH: `"${bin}"` }), join(bin, 'git.exe'), 'a quoted entry');
  assert.equal(commandPath('git', { PATH: `;${join(root, 'folder-only')};${bin}` }), join(bin, 'git.exe'), 'a folder named git.exe is not the program');
  for (const PATH of ['', '.', 'bin', 'C:bin', '.;bin']) assert.equal(commandPath('git', { PATH }), null, `relative or empty: ${JSON.stringify(PATH)}`);
  assert.equal(commandPath('git', {}), null, 'no PATH at all');
});
