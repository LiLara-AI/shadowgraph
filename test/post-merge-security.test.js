// Post-merge security review of 46579c3 (2026-10-08): one regression for each
// fixed finding, named by its review id. Each fails on 46579c3. Credentials are
// assembled at runtime, so no literal of one is in tracked source.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import fsPromises, { mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { backupFile } from '../src/backup.js';
import { downgradeStore } from '../src/schema-conversion.js';
import { createShadowGraphServer } from '../src/server.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { tarEntries } from '../src/internal/tar.js';
import { redactText } from '../src/internal/redaction.js';
import { createExtractor, inspectPolicy } from '../src/extractor.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const now = () => '2026-10-08T00:00:00.000Z';
const WINDOWS = process.platform === 'win32' ? {} : { skip: 'Windows path semantics' };
const SQLITE = await import('node:sqlite').then(() => ({}), () => ({ skip: 'node:sqlite is not available' }));

async function storeOf(t, type = 'json') {
  const dir = await scratchDirectory(t, 'post-merge-security-');
  const env = { SHADOWGRAPH_HOME: join(dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  const file = join(dir, type === 'sqlite' ? 'store.db' : 'store.json');
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'p', title: 'A decision', chosen: 'x' });
  const store = await createStorage({ type, file, env });
  await store.save(privilegedSnapshot(graph));
  return { dir, env, file, store, graph };
}

test('R1-2: a copy never lands on an owner file through a spelling Windows folds onto it', WINDOWS, async (t) => {
  const s = await storeOf(t);
  for (const name of ['activation.json.', 'activation.json ', 'activation.json::$DATA', 'extraction-usage.json..']) {
    await assert.rejects(backupFile(s.file, join(s.env.SHADOWGRAPH_HOME, name), { env: s.env }), { code: 'deletion_file_destination_refused' }, name);
  }
  await assert.rejects(backupFile(s.file, join(s.env.SHADOWGRAPH_HOME, 'folder.', 'copy.json'), { env: s.env }), { code: 'deletion_file_destination_refused' });
  assert.deepEqual(await readdir(s.env.SHADOWGRAPH_HOME), [], 'nothing was written');
});

test('R1-3: a copy never lands on a lock file, a store\'s own fence lock included', async (t) => {
  const s = await storeOf(t);
  for (const destination of [`${s.file}.lock`, join(s.dir, 'other.LOCK')]) {
    await assert.rejects(backupFile(s.file, destination, { env: s.env }), { code: 'deletion_file_destination_refused' }, destination);
    assert.equal(existsSync(destination), false);
  }
  await backupFile(s.file, join(s.dir, 'copy.json'), { env: s.env });
  assert.ok(existsSync(join(s.dir, 'copy.json')), 'an ordinary name still takes a backup');
});

test('R1-1: a SQLite backup or downgrade output never sits beside a stale log that would replay over it', SQLITE, async (t) => {
  const s = await storeOf(t, 'sqlite');
  t.after(() => s.store.close?.());
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const destination = join(s.dir, `copy${suffix}.db`);
    await writeFile(`${destination}${suffix}`, 'a log from another database');
    await assert.rejects(s.store.backup(destination), /already sits beside its destination/u, suffix);
    assert.equal(existsSync(destination), false, `${suffix}: no copy was written`);
  }
  await s.store.backup(join(s.dir, 'clean.db'));
  assert.ok(existsSync(join(s.dir, 'clean.db')), 'a destination with no log still takes a backup');
  const output = join(s.dir, 'downgraded.db');
  await writeFile(`${output}-journal`, 'stale');
  const graph = createShadowGraph({ now });
  graph.importData(await s.store.load());
  await assert.rejects(downgradeStore({ graph, store: s.store, file: s.file, storageType: 'sqlite', output, preservationCopy: join(s.dir, 'kept.db'), toSchemaVersion: 6, now }), /SQLite log file already sits beside its output/u);
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(join(s.dir, 'kept.db')), false, 'refused before the preservation copy');
});

test('R1-4: a tar entry with a negative size is refused instead of looping', () => {
  const header = Buffer.alloc(512);
  header.write('a.txt', 0);
  header.write('-1000', 124); // -512 in octal: the cursor would never move
  header.write('0', 156);
  const archive = Buffer.concat([header, Buffer.alloc(1024)]);
  assert.throws(() => {
    const entries = tarEntries(archive);
    for (let read = 0; read < 10 && !entries.next().done; read += 1);
  }, /Malformed tar entry size/u);
});

function mcp(t, cwd, file) {
  const child = spawn(process.execPath, [resolve('src/mcp.js')], { cwd, env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let buffer = '';
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    const lines = (buffer + chunk).split(/\r?\n/u);
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
    }
  });
  let id = 0;
  return (method, params) => new Promise((settle) => {
    waiting.set(++id, settle);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

test('R1-5: MCP backup and restore refuse a missing path instead of naming a file `undefined`', async (t) => {
  const s = await storeOf(t);
  const call = mcp(t, s.dir, s.file);
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  for (const [name, args] of [['shadowgraph_backup', {}], ['shadowgraph_backup', { destination: ['a', 'b'] }], ['shadowgraph_restore', {}]]) {
    const response = await call('tools/call', { name, arguments: args });
    assert.ok(response.error || response.result?.isError, `${name} ${JSON.stringify(args)} is refused`);
  }
  assert.equal(existsSync(join(s.dir, 'undefined')), false);
  assert.equal(existsSync(join(s.dir, 'a,b')), false);
});

async function server(t, file) {
  const app = await createShadowGraphServer({ file });
  await new Promise((settle) => app.server.listen(0, '127.0.0.1', settle));
  t.after(() => app.server.close());
  return async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  };
}

test('R1-5: HTTP backup and restore refuse a missing path', async (t) => {
  const s = await storeOf(t);
  const post = await server(t, s.file);
  for (const [path, field] of [['/backup', 'destination'], ['/restore', 'source']]) {
    const response = await post(path, {});
    assert.equal(response.status, 400, path);
    assert.match(response.text, new RegExp(`${field} must be a non-empty string`, 'u'));
  }
});

test('R4-6: an HTTP restore error never repeats the bytes of the file it was given, nor its path', async (t) => {
  const s = await storeOf(t);
  const post = await server(t, s.file);
  const marker = `Zq9${'Snt'}Leak7Kx`;
  const source = join(s.dir, 'not-json.txt');
  await writeFile(source, `${marker}=value\n`);
  const response = await post('/restore', { source });
  assert.ok(response.status >= 400);
  assert.ok(!response.text.includes(marker), response.text);
  const missing = await post('/restore', { source: join(s.dir, 'folder', 'absent.json') });
  assert.ok(missing.status >= 400);
  assert.ok(!missing.text.includes(s.dir.replaceAll('\\', '\\\\')) && !missing.text.includes(s.dir), missing.text);
});

test('R3-2: the capture hook\'s save removes the temporary copy a killed save left beside the store', async (t) => {
  const s = await storeOf(t);
  const left = join(s.dir, '.store.json.4242.1790000000000.abc123.tmp');
  await writeFile(left, '{"a killed save":"raw text"}');
  await s.store.update((current) => current);
  assert.equal(existsSync(left), false);
});

test('R3-9: redaction covers the credential shapes the review found passing', () => {
  const body = 'Zq9Snt4Kx7Wv2Rt8Pm4Lb6Hq3Nc5Jd1Fg0Ty8Ue2Ab7Cd';
  for (const credential of [`whsec${'_'}${body}`, `ya29${'.'}${body}`, `xapp${'-'}1-A0B1C2D3E4-${body}`, `dckr${'_pat_'}${body}`, `glsa${'_'}${body}`]) {
    const redacted = redactText(`before ${credential} after`);
    assert.ok(!redacted.includes(body), credential.slice(0, 6));
    assert.match(redacted, /\[REDACTED\]/u);
  }
});

test('R2-4: on Windows the extraction executable must be a program file, never a .cmd or .bat', WINDOWS, async (t) => {
  const root = await scratchDirectory(t, 'post-merge-executor-');
  for (const name of ['host.cmd', 'host.bat']) {
    const executable = join(root, name);
    await writeFile(executable, '@echo 2.1.288 (Claude Code)');
    const calls = [];
    const executor = createExtractor({ executable, env: { HOME: root, USERPROFILE: root, PATH: process.env.PATH }, scratchRoot: root,
      runProcess: async (request) => { calls.push(request); return { code: 0, stdout: '2.1.288 (Claude Code)', stderr: '' }; }, inspectPolicy: async () => ({ ok: true, sources: [] }) });
    const check = await executor.check();
    assert.equal(check.blockedReason, 'executable_unavailable', name);
    assert.equal(calls.length, 0, `${name}: nothing was started`);
  }
});

test('R2-2: the managed-policy check looks at the default places whatever SYSTEMROOT and ProgramFiles say', WINDOWS, async (t) => {
  const root = await scratchDirectory(t, 'post-merge-policy-');
  const looked = [];
  const started = [];
  const original = { lstat: fsPromises.lstat, spawn: childProcess.spawn };
  fsPromises.lstat = async (path, ...rest) => { looked.push(String(path)); return original.lstat(path, ...rest); };
  childProcess.spawn = (command) => { started.push(command); throw new Error('not started in this test'); };
  syncBuiltinESMExports();
  t.after(() => { fsPromises.lstat = original.lstat; childProcess.spawn = original.spawn; syncBuiltinESMExports(); });
  const env = { HOME: root, USERPROFILE: root, ProgramFiles: join(root, 'elsewhere'), SYSTEMROOT: '' };
  const out = await inspectPolicy({ platform: 'win32', env });
  assert.equal(out.blockedReason, 'policy_unreadable', 'reg.exe was not started, so the policy is unreadable');
  assert.ok(looked.includes(join('C:\\Program Files', 'ClaudeCode', 'managed-settings.json')), 'the default policy folder is checked');
  assert.ok(looked.includes(join(root, 'elsewhere', 'ClaudeCode', 'managed-settings.json')), 'and the variable\'s folder');
  assert.deepEqual(started, [join('C:\\Windows', 'System32', 'reg.exe')], 'an empty SYSTEMROOT never names a relative reg.exe');
});
