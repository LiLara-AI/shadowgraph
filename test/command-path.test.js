import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandPath } from '../src/internal/owner-files.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// The program a bare command name runs (git for the workspace checks, claude for
// the host version): an absolute program on an absolute PATH entry -- name.exe
// on Windows, an executable name elsewhere -- so a working directory that holds
// its own git is never run in its place.
test('a bare command resolves to an absolute program on an absolute PATH entry, never from the working directory', async (t) => {
  if (process.platform !== 'win32') {
    const root = await scratchDirectory(t, 'shadowgraph-command-path-');
    const bin = join(root, 'bin'), plain = join(root, 'plain');
    await mkdir(bin);
    await mkdir(plain);
    await writeFile(join(bin, 'git'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(join(plain, 'git'), '#!/bin/sh\n', { mode: 0o644 });
    await mkdir(join(root, 'folder-only', 'git'), { recursive: true });
    assert.equal(commandPath('git', { PATH: bin }), join(bin, 'git'), 'an absolute entry');
    assert.equal(commandPath('git', { PATH: `${join(root, 'folder-only')}:${plain}:${bin}` }), join(bin, 'git'), 'a folder, or a file that is not executable, is not the program');
    for (const PATH of ['', '.', 'bin', ':', `:${plain}`, `.:${plain}`, `${plain}::`]) assert.equal(commandPath('git', { PATH }), null, `relative or empty: ${JSON.stringify(PATH)}`);
    assert.equal(commandPath('git', { path: bin }), null, 'the variable is PATH, spelled exactly');
    assert.equal(commandPath('git', {}), null, 'no PATH at all');
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
