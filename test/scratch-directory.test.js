// Regression coverage for tools/scratch-directory.js.
//
// The property under test is not "the happy path removes its directory" - the
// suite already did that in 63 places and still leaked - but that a scratch
// directory is removed however its test ends: passing, failing, timing out,
// aborted, interrupted, or killed outright. Each scenario therefore drives a
// small fixture in its own process, with TMPDIR pointed at a sandbox this test
// owns, and asserts on what that sandbox holds afterwards as well as on how the
// process died. The fixtures are written into this test's own scratch
// directory, so the coverage cannot leak either.
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scratchDirectory, removeScratchDirectory } from '../tools/scratch-directory.js';

const HELPER = fileURLToPath(new URL('../tools/scratch-directory.js', import.meta.url));
const SUPERVISOR = fileURLToPath(new URL('../tools/scratch-supervisor.mjs', import.meta.url));
const REPOSITORY = fileURLToPath(new URL('..', import.meta.url));
const ROOT_NAME = /^shadowgraph-scratch-(\d+)-[A-Za-z0-9]{6}$/u;
const DEAD_PID = 4194303;
const posixOnly = process.platform === 'win32' ? 'POSIX signals and permissions only' : false;
const unprivileged = typeof process.getuid === 'function' && process.getuid() === 0
  ? 'root ignores directory permissions'
  : posixOnly;

function fixtureSource(body, helper = HELPER) {
  return `import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test, { beforeEach, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { scratchDirectory, removeScratchDirectory } from ${JSON.stringify(pathToFileURL(helper).href)};

${body}
`;
}

async function sandboxFor(t, name = 'shadowgraph-scratch-regression-') {
  const base = await scratchDirectory(t, name);
  const temporary = join(base, 'tmp');
  await mkdir(temporary);
  return { base, temporary };
}

function startFixture(t, file, temporary, extra = []) {
  const environment = { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.NODE_TEST_WORKER_ID;
  const child = spawn(process.execPath, ['--test-reporter=tap', file, ...extra], {
    cwd: REPOSITORY, env: environment, stdio: ['ignore', 'pipe', 'pipe']
  });
  const chunks = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { chunks.stdout += chunk; });
  child.stderr.on('data', (chunk) => { chunks.stderr += chunk; });
  const started = Date.now();
  // 'close' rather than 'exit': the supervisor inherits this process's stderr,
  // so waiting for the stream to close is what makes its diagnostics readable.
  const closed = once(child, 'close').then(([code, signal]) => ({
    code, signal, stdout: chunks.stdout, stderr: chunks.stderr, elapsedMs: Date.now() - started
  }));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { child, chunks, closed };
}

async function runFixture(t, body, options = {}) {
  const sandbox = options.sandbox ?? await sandboxFor(t);
  const file = join(sandbox.base, options.name ?? 'fixture.test.mjs');
  await writeFile(file, fixtureSource(body, options.helper), 'utf8');
  const handle = startFixture(t, file, sandbox.temporary, options.extra);
  return { ...await handle.closed, ...sandbox, file };
}

async function waitForLine(handle, pattern, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = pattern.exec(handle.chunks.stdout);
    if (match !== null) return match;
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      throw new Error(`fixture ended before ${pattern}\n${handle.chunks.stdout}\n${handle.chunks.stderr}`);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${pattern}\n${handle.chunks.stdout}`);
    await sleep(10);
  }
}

function summary(stdout) {
  const counts = {};
  for (const [, key, value] of stdout.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gmu)) {
    counts[key] = Number(value);
  }
  return counts;
}

function diagnostics(stderr) {
  return stderr.split('\n').filter((line) => line.length > 0);
}

async function entries(directory) {
  return (await readdir(directory)).sort();
}

async function assertSwept(temporary) {
  assert.deepEqual(await entries(temporary), [], 'the sandbox must hold nothing once the fixture has ended');
}

// Waits for a directory to drain: the supervisor removes a killed owner's root
// out of band, so the assertion is "soon", not "already".
async function assertSweptSoon(temporary, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = await entries(temporary);
    if (remaining.length === 0) return;
    if (Date.now() > deadline) assert.deepEqual(remaining, [], 'the sandbox must be swept after the owner is killed');
    await sleep(25);
  }
}

async function fabricateRoot(temporary, pid, suffix, marker) {
  const path = join(temporary, `shadowgraph-scratch-${pid}-${suffix}`);
  await mkdir(path);
  if (marker !== null) await writeFile(join(path, '.owner.json'), marker, 'utf8');
  return path;
}

async function makeAncient(path) {
  const ancient = new Date(Date.now() - 11 * 60 * 1000);
  await utimes(path, ancient, ancient);
}

test('a directory outlives nothing: a passing test leaves the sandbox empty', async (t) => {
  const result = await runFixture(t, `
test('creates and uses a scratch directory', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-normal-');
  assert.deepEqual(await readdir(directory), [], 'the helper must not write inside the directory');
  assert.match(basename(dirname(directory)), /^shadowgraph-scratch-\\d+-[A-Za-z0-9]{6}$/u);
  assert.equal(dirname(dirname(directory)), tmpdir());
  await writeFile(join(directory, 'state.json'), '{}');
  console.log('DIRECTORY ' + directory);
});
`);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(summary(result.stdout), { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.deepEqual(diagnostics(result.stderr), [], 'an ordinary run says nothing');
  await assertSwept(result.temporary);
});

test('a failing assertion still gives the directory up', async (t) => {
  const result = await runFixture(t, `
test('fails after creating a directory', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-failing-');
  await writeFile(join(directory, 'state.json'), '{}');
  assert.equal(1, 2, 'deliberate failure');
});
`);
  assert.equal(result.code, 1);
  assert.equal(summary(result.stdout).fail, 1);
  await assertSwept(result.temporary);
});

test('a directory created during a failed setup is still removed', async (t) => {
  const result = await runFixture(t, `
describe('setup that throws', () => {
  beforeEach(async (t) => {
    const directory = await scratchDirectory(t, 'shadowgraph-setup-');
    await writeFile(join(directory, 'state.json'), '{}');
    throw new Error('deliberate setup failure');
  });
  it('never runs its body', () => { console.log('BODY-RAN'); });
});

test('throws immediately after creating', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-setup-inline-');
  await writeFile(join(directory, 'state.json'), '{}');
  throw new Error('deliberate body failure');
});
`);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.includes('BODY-RAN'), false, 'the body must not have run');
  await assertSwept(result.temporary);
});

test('a teardown that throws does not keep the directory, whichever hook throws first', async (t) => {
  const result = await runFixture(t, `
test('a later hook throws', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-teardown-late-');
  await writeFile(join(directory, 'state.json'), '{}');
  t.after(() => { throw new Error('deliberate teardown failure'); });
});

test('an earlier hook throws', async (t) => {
  t.after(() => { throw new Error('deliberate early teardown failure'); });
  const directory = await scratchDirectory(t, 'shadowgraph-teardown-early-');
  await writeFile(join(directory, 'state.json'), '{}');
});
`);
  assert.equal(result.code, 1);
  assert.equal(summary(result.stdout).fail, 2);
  // Hooks run in registration order and a throwing one stops the rest, so both
  // tests starve their removal: the first because the throwing hook was
  // registered after it, the second because it was registered before. Only the
  // exit sweep saves them, and it says so rather than cleaning up silently.
  assert.deepEqual(diagnostics(result.stderr).map((line) => line.replace(/ left in .*/u, ' left in <root>')), [
    'scratch-directory: exit sweep removed 2 scratch directories left in <root>'
  ]);
  await assertSwept(result.temporary);
});

test('a removal that cannot succeed fails the test and names the path', { skip: unprivileged }, async (t) => {
  const result = await runFixture(t, `
test('makes its own root unwritable', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-unremovable-');
  await writeFile(join(directory, 'state.json'), '{}');
  t.after(() => { console.log('LATER-HOOK-RAN'); });
  console.log('DIRECTORY ' + directory);
  await chmod(dirname(directory), 0o500);
});
`);
  const directory = /^DIRECTORY (.+)$/mu.exec(result.stdout)[1];
  assert.equal(result.code, 1);
  assert.match(result.stdout, /hookFailed/u);
  assert.ok(
    result.stdout.includes(`scratch directory was not removed: ${directory} (EACCES)`),
    `the diagnostic must name the path\n${result.stdout}`
  );
  assert.match(result.stdout, /LATER-HOOK-RAN/u, 'a failed removal must not starve the hooks after it');
  const lines = diagnostics(result.stderr);
  assert.equal(lines.length, 2, result.stderr);
  assert.match(lines[0], /^scratch-directory: exit sweep could not remove .* EACCES$/u);
  assert.match(lines[1], /^scratch-directory: supervisor could not remove .* EACCES$/u);
  // The leak is real, which is the point: it was reported rather than hidden.
  const root = dirname(directory);
  assert.deepEqual(await entries(result.temporary), [basename(root)]);
  await import('node:fs/promises').then(({ chmod }) => chmod(root, 0o700));
  await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }));
  await assertSwept(result.temporary);
});

test('a wedged teardown is bounded by the hook timeout, not left to hang', async (t) => {
  const result = await runFixture(t, `
test('registers a hook that never settles', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-wedged-');
  await writeFile(join(directory, 'state.json'), '{}');
  t.after(() => new Promise(() => {}), { timeout: 50 });
});
`);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /hookFailed|test timed out/u);
  await assertSwept(result.temporary);
});

test('a timed-out or aborted test gives its directory up too', async (t) => {
  const result = await runFixture(t, `
test('never finishes', { timeout: 100 }, async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-timeout-');
  await writeFile(join(directory, 'state.json'), '{}');
  await new Promise(() => {});
});

const controller = new AbortController();
test('is aborted from outside', { signal: controller.signal }, async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-abort-');
  await writeFile(join(directory, 'state.json'), '{}');
  setTimeout(() => controller.abort(), 20);
  await new Promise(() => {});
});
`);
  assert.equal(result.code, 1);
  assert.equal(summary(result.stdout).cancelled, 2, result.stdout);
  await assertSwept(result.temporary);
});

test('an interrupted run sweeps and then dies by the signal it was sent', { skip: posixOnly }, async (t) => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const sandbox = await sandboxFor(t, `shadowgraph-scratch-${signal.toLowerCase()}-`);
    const file = join(sandbox.base, 'fixture.test.mjs');
    await writeFile(file, fixtureSource(`
test('waits to be interrupted', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-signal-');
  await writeFile(join(directory, 'state.json'), '{}');
  setInterval(() => {}, 1000);
  console.log('READY ' + directory);
  await new Promise(() => {});
});
`), 'utf8');
    const handle = startFixture(t, file, sandbox.temporary);
    const [, directory] = await waitForLine(handle, /^READY (.+)$/mu);
    assert.equal(dirname(dirname(directory)), sandbox.temporary);
    assert.equal((await entries(sandbox.temporary)).length, 1);
    handle.child.kill(signal);
    const result = await handle.closed;
    assert.equal(result.signal, signal, `${signal}: the process must still die by its signal\n${result.stderr}`);
    assert.equal(result.code, null);
    // The test was still holding its directory, so the sweep had work to do and
    // reports exactly what it removed.
    const lines = diagnostics(result.stderr);
    assert.equal(lines.length, 1, `${signal}: ${result.stderr}`);
    assert.equal(lines[0], `scratch-directory: ${signal} sweep removed 1 scratch directory left in ${dirname(directory)}`);
    await assertSwept(sandbox.temporary);
  }
});

test('an interrupted run that cannot sweep still dies by its signal', { skip: unprivileged }, async (t) => {
  const sandbox = await sandboxFor(t, 'shadowgraph-scratch-signal-stuck-');
  const file = join(sandbox.base, 'fixture.test.mjs');
  await writeFile(file, fixtureSource(`
test('makes its root unwritable and waits', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-signal-stuck-');
  await writeFile(join(directory, 'state.json'), '{}');
  setInterval(() => {}, 1000);
  await chmod(dirname(directory), 0o500);
  console.log('READY ' + directory);
  await new Promise(() => {});
});
`), 'utf8');
  const handle = startFixture(t, file, sandbox.temporary);
  const [, directory] = await waitForLine(handle, /^READY (.+)$/mu);
  handle.child.kill('SIGTERM');
  const result = await handle.closed;
  assert.equal(result.signal, 'SIGTERM', 'a failed sweep must not change how the process dies');
  const lines = diagnostics(result.stderr);
  assert.ok(lines.length >= 1, result.stderr);
  assert.match(lines[0], /^scratch-directory: SIGTERM sweep could not remove .* EACCES$/u);
  const { chmod, rm } = await import('node:fs/promises');
  await chmod(dirname(directory), 0o700);
  await rm(dirname(directory), { recursive: true, force: true });
  await assertSwept(sandbox.temporary);
});

test('directories created concurrently are distinct and every one is removed', async (t) => {
  const result = await runFixture(t, `
test('creates twenty five at once', async (t) => {
  const directories = await Promise.all(Array.from({ length: 25 }, (unused, index) =>
    scratchDirectory(t, 'shadowgraph-many-' + index + '-')));
  assert.equal(new Set(directories).size, 25);
  await Promise.all(directories.map((directory) => writeFile(join(directory, 'state.json'), '{}')));
});

describe('in parallel', { concurrency: 4 }, () => {
  for (let index = 0; index < 8; index += 1) {
    it('subtest ' + index, async (t) => {
      const directory = await scratchDirectory(t, 'shadowgraph-parallel-' + index + '-');
      await writeFile(join(directory, 'state.json'), '{}');
      await sleep(10);
    });
  }
});
`);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(summary(result.stdout).fail, 0);
  assert.deepEqual(diagnostics(result.stderr), []);
  await assertSwept(result.temporary);
});

// Holds a file open inside the directory while its test is still running, so
// the removal hook runs against an open descriptor, then recreates the
// directory after the hook has been and gone - and optionally locks the root,
// which is the one case no layer can recover from.
const LATE_CHILD = `const { chmodSync, mkdirSync, openSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const directory = process.argv[2];
const lock = process.argv[3] === 'lock';
openSync(join(directory, 'held'), 'w');
writeFileSync(join(directory, 'child-ready'), '1');
setTimeout(() => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'resurrected'), '1');
  if (lock) chmodSync(dirname(directory), 0o500);
}, 150);
setTimeout(() => {}, 400);
`;

const AWAIT_CHILD = `
async function awaitChild(directory) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(join(directory, 'child-ready'))) return;
    await sleep(10);
  }
  throw new Error('the late child never started');
}
`;

test('a directory a late child recreates is caught on the way out', { skip: posixOnly }, async (t) => {
  const sandbox = await sandboxFor(t, 'shadowgraph-scratch-resurrect-');
  const child = join(sandbox.base, 'late-child.cjs');
  await writeFile(child, LATE_CHILD, 'utf8');
  const result = await runFixture(t, `${AWAIT_CHILD}
test('leaves a child holding and then recreating its directory', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-resurrect-');
  await writeFile(join(directory, 'state.json'), '{}');
  spawn(process.execPath, [process.argv[2], directory], { stdio: 'ignore' });
  await awaitChild(directory);
});
`, { sandbox, extra: [child] });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(diagnostics(result.stderr).map((line) => line.replace(/ left in .*/u, ' left in <root>')), [
    'scratch-directory: exit sweep removed 1 scratch directory left in <root>'
  ]);
  await assertSwept(result.temporary);
});

test('residue that no layer can remove fails an otherwise green run', { skip: unprivileged }, async (t) => {
  const sandbox = await sandboxFor(t, 'shadowgraph-scratch-locked-');
  const child = join(sandbox.base, 'late-locker.cjs');
  await writeFile(child, LATE_CHILD, 'utf8');
  const result = await runFixture(t, `${AWAIT_CHILD}
test('leaves a child that recreates the directory and locks the root', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-resurrect-locked-');
  await writeFile(join(directory, 'state.json'), '{}');
  spawn(process.execPath, [process.argv[2], directory, 'lock'], { stdio: 'ignore' });
  await awaitChild(directory);
});
`, { sandbox, extra: [child] });
  // Every test passed and every hook succeeded; the residue appeared afterwards
  // and could not be removed, so the process itself must not report success.
  assert.equal(summary(result.stdout).fail, 0, result.stdout);
  assert.equal(result.code, 1, 'unremovable residue must not be reported as a clean run');
  const lines = diagnostics(result.stderr);
  assert.match(lines[0], /^scratch-directory: exit sweep could not remove .* EACCES$/u);
  const { chmod, rm } = await import('node:fs/promises');
  const root = join(result.temporary, (await entries(result.temporary))[0]);
  await chmod(root, 0o700);
  await rm(root, { recursive: true, force: true });
  await assertSwept(result.temporary);
});

test('the removal runs after the hooks a test registers later', async (t) => {
  const result = await runFixture(t, `
test('registers a hook after creating', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-ordering-');
  t.after(() => { console.log('LATER ' + existsSync(directory)); });
});
`);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^LATER true$/mu, 'a later hook must still see its directory');
  await assertSwept(result.temporary);
});

test('nothing is forced to exit: an open handle still holds the process open', async (t) => {
  const result = await runFixture(t, `
test('leaves a server listening past its own end', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-open-handle-');
  await writeFile(join(directory, 'state.json'), '{}');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  setTimeout(() => server.close(), 800);
});
`);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(result.elapsedMs >= 800, `the process exited after ${result.elapsedMs} ms, so the handle was cut short`);
  assert.deepEqual(diagnostics(result.stderr), []);
  await assertSwept(result.temporary);
});

test('a hard kill is covered by the supervisor, even with a child still running', { skip: posixOnly }, async (t) => {
  const sandbox = await sandboxFor(t, 'shadowgraph-scratch-sigkill-');
  const file = join(sandbox.base, 'fixture.test.mjs');
  await writeFile(file, fixtureSource(`
test('holds a directory and a child, then waits', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-sigkill-');
  await writeFile(join(directory, 'state.json'), '{}');
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  setInterval(() => {}, 1000);
  console.log('READY ' + directory);
  await new Promise(() => {});
});
`), 'utf8');
  const handle = startFixture(t, file, sandbox.temporary);
  const [, directory] = await waitForLine(handle, /^READY (.+)$/mu);
  assert.equal((await entries(sandbox.temporary)).length, 1, 'the directory exists before the kill');
  handle.child.kill('SIGKILL');
  const result = await handle.closed;
  assert.equal(result.signal, 'SIGKILL');
  await assertSweptSoon(sandbox.temporary);
  assert.ok(
    /^scratch-directory: owner pid \d+ of .* ended without removing 1 scratch directory; removed by supervisor$/mu
      .test(result.stderr),
    `the supervisor must say what it removed\n${result.stderr}`
  );
  assert.equal(basename(dirname(directory)).startsWith('shadowgraph-scratch-'), true);
});

test('a root whose supervisor also died is removed by the next run', { skip: posixOnly }, async (t) => {
  const sandbox = await sandboxFor(t, 'shadowgraph-scratch-janitor-live-');
  const file = join(sandbox.base, 'fixture.test.mjs');
  await writeFile(file, fixtureSource(`
test('waits with a directory', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-orphan-');
  await writeFile(join(directory, 'state.json'), '{}');
  setInterval(() => {}, 1000);
  console.log('READY ' + directory);
  await new Promise(() => {});
});
`), 'utf8');
  const handle = startFixture(t, file, sandbox.temporary);
  const [, directory] = await waitForLine(handle, /^READY (.+)$/mu);
  const root = dirname(directory);
  const listed = spawnSync('pgrep', ['-f', `scratch-supervisor.mjs ${root}`], { encoding: 'utf8' });
  const supervisors = listed.stdout.split('\n').filter(Boolean).map(Number);
  assert.equal(supervisors.length, 1, `expected one supervisor for ${root}, got ${listed.stdout}`);
  process.kill(supervisors[0], 'SIGKILL');
  await sleep(100);
  handle.child.kill('SIGKILL');
  await handle.closed;
  await sleep(200);
  assert.deepEqual(await entries(sandbox.temporary), [basename(root)], 'with both dead the root survives');

  const second = await runFixture(t, `
test('creates a directory of its own', async (t) => {
  await scratchDirectory(t, 'shadowgraph-after-orphan-');
});
`, { sandbox, name: 'second.test.mjs' });
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.ok(
    diagnostics(second.stderr).some((line) => line === `scratch-directory: removed stale scratch root ${root} (owner pid ${basename(root).split('-')[2]}, owner is gone)`),
    `the janitor must name what it removed\n${second.stderr}`
  );
  await assertSwept(sandbox.temporary);
});

describe('a supervisor that cannot be armed fails setup rather than running unprotected', () => {
  const variants = [
    ['exits before reporting ready', 'process.exit(3);\n', /exited before reporting ready/u],
    ['sends the wrong handshake', 'process.stdout.write("READY nope\\n"); setInterval(() => {}, 1000);\n', /unexpected handshake/u],
    ['never reports ready', 'process.stdin.resume(); setInterval(() => {}, 1000);\n', /did not report ready within/u],
    ['cannot be loaded', 'this is not javascript\n', /exited before reporting ready/u]
  ];
  for (const [name, stub, expected] of variants) {
    it(name, async (t) => {
      const sandbox = await sandboxFor(t, 'shadowgraph-scratch-handshake-');
      const variant = join(sandbox.base, 'variant');
      await mkdir(variant);
      await copyFile(HELPER, join(variant, 'scratch-directory.js'));
      await writeFile(join(variant, 'scratch-supervisor.mjs'), stub, 'utf8');
      const result = await runFixture(t, `
test('cannot obtain a protected directory', async (t) => {
  await assert.rejects(() => scratchDirectory(t, 'shadowgraph-unprotected-'), (error) => {
    console.log('REJECTED ' + error.message);
    return true;
  });
});
`, { sandbox, helper: join(variant, 'scratch-directory.js') });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const message = /^REJECTED (.+)$/mu.exec(result.stdout);
      assert.notEqual(message, null, result.stdout);
      assert.match(message[1], expected);
      await assertSwept(result.temporary);
    });
  }
});

describe('the supervisor refuses every target that is not its own root', () => {
  const nonce = 'a'.repeat(32);
  const marker = (pid, value = nonce) => JSON.stringify({ pid, nonce: value });

  it('refuses malformed, foreign, symlinked and mismatched targets', async (t) => {
    const { base, temporary } = await sandboxFor(t, 'shadowgraph-scratch-boundary-');
    const decoy = join(base, 'decoy');
    await mkdir(decoy);
    await writeFile(join(decoy, 'keep.txt'), 'untouched', 'utf8');
    const outside = join(base, `shadowgraph-scratch-${DEAD_PID}-aaaaaa`);
    await mkdir(outside);
    await writeFile(join(outside, '.owner.json'), marker(DEAD_PID), 'utf8');
    const valid = await fabricateRoot(temporary, DEAD_PID, 'bbbbbb', marker(DEAD_PID));
    const mismatched = await fabricateRoot(temporary, DEAD_PID, 'cccccc', marker(DEAD_PID, 'b'.repeat(32)));
    const wrongName = join(temporary, 'shadowgraph-scratch-not-a-pid');
    await mkdir(wrongName);
    const linked = join(temporary, `shadowgraph-scratch-${DEAD_PID}-dddddd`);
    await symlink(decoy, linked);

    const cases = [
      ['a missing target', [join(temporary, `shadowgraph-scratch-${DEAD_PID}-eeeeee`), DEAD_PID, nonce, temporary], /target does not exist/u],
      ['the temp root itself', [temporary, DEAD_PID, nonce, temporary], /basename is not a scratch root name/u],
      ['the filesystem root', ['/', DEAD_PID, nonce, temporary], /basename is not a scratch root name/u],
      ['a malformed basename', [wrongName, DEAD_PID, nonce, temporary], /basename is not a scratch root name/u],
      ['a symbolic link', [linked, DEAD_PID, nonce, temporary], /target is a symbolic link/u],
      ['a pid that is not the owner', [valid, DEAD_PID - 1, nonce, temporary], /basename pid does not match the owner pid/u],
      ['a nonce that does not match', [mismatched, DEAD_PID, nonce, temporary], /owner marker does not match the handshake/u],
      ['a root outside the temp root', [outside, DEAD_PID, nonce, temporary], /not an immediate child of the temp root/u]
    ];
    for (const [name, argv, expected] of cases) {
      const child = spawn(process.execPath, [SUPERVISOR, ...argv.map(String)], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      let stdout = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stdin.end();
      const [code] = await once(child, 'close');
      assert.equal(code, 2, `${name}: expected a refusal, got ${code}\n${stderr}`);
      assert.equal(stdout, '', `${name}: a refused supervisor must not report ready`);
      assert.equal(diagnostics(stderr).length, 1, `${name}: ${stderr}`);
      assert.match(stderr, expected, name);
    }

    assert.equal((await readFile(join(decoy, 'keep.txt'), 'utf8')), 'untouched', 'nothing outside the root may be touched');
    assert.deepEqual(await entries(decoy), ['keep.txt']);
    assert.deepEqual(await entries(outside), ['.owner.json']);
    assert.deepEqual((await entries(temporary)).length > 0, true);
  });
});

test('the janitor removes only roots whose owner is provably gone', { skip: posixOnly }, async (t) => {
  const { base, temporary } = await sandboxFor(t, 'shadowgraph-scratch-janitor-');
  const identity = process.platform === 'linux'
    ? (await readFile(`/proc/${process.pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19]
    : null;
  const live = process.pid;
  const removable = {
    deadWithMarker: await fabricateRoot(temporary, DEAD_PID, 'aaaaaa', JSON.stringify({ pid: DEAD_PID, nonce: 'x' })),
    deadNoMarkerOld: await fabricateRoot(temporary, DEAD_PID, 'bbbbbb', null),
    deadCorruptOld: await fabricateRoot(temporary, DEAD_PID, 'cccccc', 'not json')
  };
  const kept = {
    liveWithMarker: await fabricateRoot(temporary, live, 'dddddd', JSON.stringify({ pid: live, nonce: 'x', startIdentity: identity })),
    deadNoMarkerFresh: await fabricateRoot(temporary, DEAD_PID, 'eeeeee', null),
    liveNoMarkerOld: await fabricateRoot(temporary, live, 'ffffff', null)
  };
  const reused = process.platform === 'linux'
    ? await fabricateRoot(temporary, live, 'gggggg', JSON.stringify({ pid: live, nonce: 'x', startIdentity: '1' }))
    : null;
  const decoy = join(base, 'decoy');
  await mkdir(decoy);
  const linked = join(temporary, `shadowgraph-scratch-${DEAD_PID}-hhhhhh`);
  await symlink(decoy, linked);
  for (const path of [removable.deadNoMarkerOld, removable.deadCorruptOld, kept.liveNoMarkerOld]) await makeAncient(path);

  const fixture = join(base, 'janitor.test.mjs');
  await writeFile(fixture, fixtureSource(`
test('creating a root runs the janitor first', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-janitor-run-');
  console.log('ROOT ' + dirname(directory));
});
`), 'utf8');
  // The fixture inherits this process's pid only in the fabricated names, so it
  // is this process that must still be alive for the "kept" cases to hold.
  const handle = startFixture(t, fixture, temporary);
  const result = await handle.closed;
  assert.equal(result.code, 0, result.stdout + result.stderr);

  const remaining = new Set(await entries(temporary));
  for (const [name, path] of Object.entries(removable)) {
    assert.equal(remaining.has(basename(path)), false, `${name} should have been removed`);
    assert.match(result.stderr, new RegExp(`removed stale scratch root ${path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} `, 'u'));
  }
  for (const [name, path] of Object.entries(kept)) {
    assert.equal(remaining.has(basename(path)), true, `${name} should have been kept\n${result.stderr}`);
    assert.equal(result.stderr.includes(path), false, `${name} must not be mentioned`);
  }
  if (reused !== null) assert.equal(remaining.has(basename(reused)), false, 'a reused pid means the owner is gone');
  assert.equal(remaining.has(basename(linked)), true, 'a symbolic link is never followed or removed');
  assert.deepEqual(await entries(decoy), [], 'the link target must be untouched');
});

test('switching the temp directory mid-process gives each location its own root', async (t) => {
  const { base } = await sandboxFor(t, 'shadowgraph-scratch-two-temps-');
  const first = join(base, 'temp-a');
  const second = join(base, 'temp-b');
  await mkdir(first);
  await mkdir(second);
  const file = join(base, 'fixture.test.mjs');
  await writeFile(file, fixtureSource(`
const elsewhere = process.argv[2];
const original = tmpdir();
const pointAt = (where) => { process.env.TMPDIR = where; process.env.TEMP = where; process.env.TMP = where; };

test('follows the temp directory it is given', async (t) => {
  const one = await scratchDirectory(t, 'shadowgraph-temp-a-');
  pointAt(elsewhere);
  const two = await scratchDirectory(t, 'shadowgraph-temp-b-');
  pointAt(original);
  const three = await scratchDirectory(t, 'shadowgraph-temp-a-again-');
  console.log('ONE ' + one);
  console.log('TWO ' + two);
  console.log('THREE ' + three);
});
`), 'utf8');
  const handle = startFixture(t, file, first, [second]);
  const result = await handle.closed;
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const one = /^ONE (.+)$/mu.exec(result.stdout)[1];
  const two = /^TWO (.+)$/mu.exec(result.stdout)[1];
  const three = /^THREE (.+)$/mu.exec(result.stdout)[1];
  assert.equal(dirname(dirname(one)), first);
  assert.equal(dirname(dirname(two)), second);
  assert.equal(dirname(three), dirname(one), 'returning to a temp directory reuses its root');
  assert.deepEqual(await entries(first), [], 'the first temp directory must be swept');
  assert.deepEqual(await entries(second), [], 'the second temp directory must be swept');
});

test('the helper refuses a caller it cannot bind cleanup to', async (t) => {
  await assert.rejects(() => scratchDirectory(null, 'shadowgraph-'), TypeError);
  await assert.rejects(() => scratchDirectory({}, 'shadowgraph-'), TypeError);
  await assert.rejects(() => scratchDirectory(t, ''), TypeError);
  await assert.rejects(() => scratchDirectory(t, 42), TypeError);
  await assert.rejects(() => scratchDirectory(t, 'a/b'), TypeError);
  await assert.rejects(() => scratchDirectory(t, 'a\\b'), TypeError);
  await assert.rejects(() => removeScratchDirectory(join(tmpdir(), 'shadowgraph-never-created')), TypeError);
});

test('the prefix is used exactly as given, spaces and metacharacters included', async (t) => {
  for (const prefix of ['shadowgraph ', 'shadowgraph npm pack &()!^%-', 'sg-fence-']) {
    const directory = await scratchDirectory(t, prefix);
    assert.equal(basename(directory).startsWith(prefix), true, `${prefix} must survive verbatim`);
    assert.deepEqual(await readdir(directory), [], 'the helper writes nothing inside a scratch directory');
    const second = await scratchDirectory(t, prefix);
    assert.notEqual(directory, second);
  }
});

test('removal is idempotent and safe to call early', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-idempotent-');
  await writeFile(join(directory, 'state.json'), '{}');
  await removeScratchDirectory(directory);
  await removeScratchDirectory(directory);
  await assert.rejects(() => stat(directory), { code: 'ENOENT' });
});
