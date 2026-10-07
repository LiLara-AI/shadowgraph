// Test isolation (PR-37a, design §8, F17; PR-37d design §7.4). Preloaded into
// every test process by the npm test script: ShadowGraph's per-user root -- the
// activation record, the deletion registry -- resolves under a fresh scratch
// directory, never the owner's real ~/.shadowgraph. From PR-37d a purge writes
// the registry, so:
//   1. a test-file process (argv[1] ends in `.test.js`) always makes a fresh
//      home, even when one is inherited, so no two test files share a registry;
//   2. any other process keeps a SHADOWGRAPH_HOME it was given: a test's child
//      inherits its test file's home, or the one its test chose;
//   3. any other process without one makes a fresh home, unless HOME or
//      USERPROFILE provably leads away from the account's home: both resolved
//      to their final paths (case-folded on win32), each resolved and the two
//      different. Any error, or one identity, makes a fresh home, so another
//      spelling of the owner's own home is never taken for a redirect;
//   4. it reaches every Node child that inherits the environment: its own URL
//      is appended to NODE_OPTIONS as an --import when absent.
// A fresh home is removed at exit (a killed process leaves its temporary home).
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const folded = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);

function redirected() {
  try {
    return folded(realpathSync.native(homedir())) !== folded(realpathSync.native(userInfo().homedir));
  } catch { return false; }
}

const testFile = /\.test\.js$/u.test(process.argv[1] ?? '');
if (testFile || (!process.env.SHADOWGRAPH_HOME && !redirected())) {
  const home = mkdtempSync(join(tmpdir(), 'shadowgraph-test-home-'));
  process.env.SHADOWGRAPH_HOME = home;
  process.on('exit', () => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}

const preload = `--import=${import.meta.url}`;
if (!(process.env.NODE_OPTIONS ?? '').includes(preload)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim();
