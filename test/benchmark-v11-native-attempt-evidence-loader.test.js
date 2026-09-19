import assert from 'node:assert/strict';
import { link, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  loadNativeAttemptProbeReports,
  readNativeAttemptEvidenceReportForTest
} from '../benchmark/lib/v11-native-attempt-evidence-loader.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

test('native evidence loader rejects a safe-name symlink that escapes its canonical root', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-native-report-root-');
  const outside = await scratchDirectory(t, 'shadowgraph-native-report-outside-');
  const evidencePath = path.join(directory, 'native-attempt-evidence.json');
  const outsidePath = path.join(outside, 'outside.report.json');
  await writeFile(outsidePath, '{"outside":true}\n', 'utf8');
  await writeFile(evidencePath, '{}\n', 'utf8');
  await symlink(outsidePath, path.join(directory, 'escape.report.json'));

  const reports = await loadNativeAttemptProbeReports({
    evidencePath,
    evidence: { entries: [{ probeReport: 'escape.report.json' }] }
  });

  assert.equal(reports.has('escape.report.json'), false);
});

test('native evidence loader binds report bytes to an opened descriptor across a hard-link restore race', async (t) => {
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
