// Test isolation (PR-37a, design §8, F17). Preloaded into every test process
// by the npm test script: ShadowGraph's per-user root -- the activation record,
// the deletion registry -- resolves under a fresh scratch directory, never the
// owner's real ~/.shadowgraph. Each test file's process makes its own home,
// which the children it spawns inherit; a test that sets its own keeps it. The
// directory is removed at exit (a killed process leaves its temporary home).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.SHADOWGRAPH_HOME) {
  const home = mkdtempSync(join(tmpdir(), 'shadowgraph-test-home-'));
  process.env.SHADOWGRAPH_HOME = home;
  process.on('exit', () => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}
