import assert from 'node:assert/strict';
import { link, open, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  loadNativeAttemptProbeReports,
  readNativeAttemptEvidenceReportForTest
} from '../benchmark/lib/v11-native-attempt-evidence-loader.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

// These two tests need the filesystem to let them build the attack they defend
// against. Where it will not, the prerequisite is missing rather than the
// invariant broken, so each is probed by ATTEMPTING the operation. Naming a
// platform or a release would both over- and under-skip, because the two tests
// do not need the same thing: a host may create an ordinary symbolic link and
// still refuse one at a path whose previous inode has an open descriptor. Both
// refusals arrive as EPERM or EACCES.
function isMissingCapability(error) {
  return error?.code === 'EPERM' || error?.code === 'EACCES';
}

async function symlinkOrSkip(t, target, linkPath) {
  try {
    await symlink(target, linkPath);
    return true;
  } catch (error) {
    if (isMissingCapability(error)) {
      t.skip('Prerequisite unavailable: this host cannot create a symbolic link');
      return false;
    }
    throw error;
  }
}

// The race test replaces a path with a symlink while the loader still holds a
// descriptor on what used to be there. Probing a plain symlink would not answer
// that question, so the probe performs the same swap on scratch files.
async function canSwapOpenPathForSymlink(t) {
  const probe = await scratchDirectory(t, 'shadowgraph-native-report-probe-');
  const target = path.join(probe, 'target.report.json');
  const swapped = path.join(probe, 'swapped.report.json');
  await writeFile(target, '{}\n', 'utf8');
  await writeFile(swapped, '{}\n', 'utf8');
  const handle = await open(swapped, 'r');
  try {
    await unlink(swapped);
    await symlink(target, swapped);
    return true;
  } catch (error) {
    if (isMissingCapability(error)) return false;
    throw error;
  } finally {
    await handle.close();
  }
}

test('native evidence loader rejects a safe-name symlink that escapes its canonical root', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-native-report-root-');
  const outside = await scratchDirectory(t, 'shadowgraph-native-report-outside-');
  const evidencePath = path.join(directory, 'native-attempt-evidence.json');
  const outsidePath = path.join(outside, 'outside.report.json');
  await writeFile(outsidePath, '{"outside":true}\n', 'utf8');
  await writeFile(evidencePath, '{}\n', 'utf8');
  if (!await symlinkOrSkip(t, outsidePath, path.join(directory, 'escape.report.json'))) return;

  const reports = await loadNativeAttemptProbeReports({
    evidencePath,
    evidence: { entries: [{ probeReport: 'escape.report.json' }] }
  });

  assert.equal(reports.has('escape.report.json'), false);
});

test('native evidence loader binds report bytes to an opened descriptor across a hard-link restore race', async (t) => {
  if (!await canSwapOpenPathForSymlink(t)) {
    t.skip('Prerequisite unavailable: this host cannot place a symbolic link at a path with an open descriptor');
    return;
  }
  const directory = await scratchDirectory(t, 'shadowgraph-native-report-race-root-');
  const outside = await scratchDirectory(t, 'shadowgraph-native-report-race-outside-');
  const evidencePath = path.join(directory, 'native-attempt-evidence.json');
  const candidate = path.join(directory, 'race.report.json');
  const retained = path.join(directory, 'retained-original.report.json');
  const outsidePath = path.join(outside, 'outside.report.json');
  const original = '{"inside":true}\n';
  await writeFile(evidencePath, '{}\n', 'utf8');
  await writeFile(candidate, original, 'utf8');
  await writeFile(outsidePath, '{"outside":true}\n', 'utf8');
  await link(candidate, retained);

  let swapped = false;
  const bytes = await readNativeAttemptEvidenceReportForTest({
    candidate,
    canonicalRoot: await realpath(directory),
    afterDescriptorOpened: async () => {
      swapped = true;
      await unlink(candidate);
      await symlink(outsidePath, candidate);
      await unlink(candidate);
      await link(retained, candidate);
    }
  });

  assert.equal(swapped, true, 'test must swap only after descriptor open');
  assert.equal(bytes.toString('utf8'), original);
});

test('native evidence loader reads only safe co-located probe reports', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-native-report-loader-');
  const evidencePath = path.join(directory, 'native-attempt-evidence.json');
  await writeFile(path.join(directory, 'valid.report.json'), '{"valid":true}\n', 'utf8');
  await writeFile(evidencePath, '{}\n', 'utf8');

  const reports = await loadNativeAttemptProbeReports({
    evidencePath,
    evidence: {
      entries: [
        { probeReport: 'valid.report.json' },
        { probeReport: '../outside.json' },
        { probeReport: 'nested/inside.json' }
      ]
    }
  });

  assert.deepEqual([...reports.keys()], ['valid.report.json']);
  assert.equal(reports.get('valid.report.json').toString('utf8'), '{"valid":true}\n');
});
