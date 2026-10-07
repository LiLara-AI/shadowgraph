// Capture privacy at write (plan v1.4.4 §21.2 M-2, M-3, §21.6; programme plan revision 6 PR-37; PR-37 series design
// §3 and revision 2, briefs/PR37-design.md): credentials are redacted before anything a capture writes reaches the
// store, what the checker still flags is withheld, the capture store and its side files are owner-only, and a
// structural refusal is visible without any write. Every credential here is assembled at runtime from fragments and
// carries an alphanumeric sentinel; the sentinels are looked for in every file the store's directory holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { appendFile, chmod, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore, createStorage } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { CAPTURE_LIMITS, runCapture, storeRepository } from '../src/capture-hook.js';
import { redactText as deliveryRedactText, redactValue as deliveryRedactValue, runDeliver } from '../src/delivery.js';
import { redactText, redactValue } from '../src/internal/redaction.js';
import { privilegedBindProject, privilegedRecordCapture, privilegedRecordTranscript, privilegedSnapshot } from '../src/internal/snapshot.js';
import { DELIVERY_FRAME, deliveryEndLine } from '../src/internal/delivery-marker.js';
import { mintOriginId } from '../src/scope.js';
import { fenceLockPath } from '../src/revision-store.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const CLI = resolve('src/cli.js');
const ACTIVATED = '2026-01-01T00:00:00.000Z';
const WIDE = { maxStoreBytes: 2 ** 40, maxQueueDepth: 2 ** 30, maxItemBytes: 2 ** 40, maxItemsPerSession: 2 ** 30 };
const admission = (limits = {}) => ({ limits: { ...WIDE, ...limits }, storeBytes: 0 });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const POSIX = process.platform === 'win32' ? { skip: 'POSIX file modes' } : {};

// Credentials, assembled at runtime: no literal of one is ever in tracked source.
const DASHES = '-'.repeat(5);
const BEGIN = `${DASHES}BEGIN RSA PRIVATE ` + `KEY${DASHES}`;
const END = `${DASHES}END RSA PRIVATE ` + `KEY${DASHES}`;
const token = (sentinel) => `gh${'p'}_${sentinel}`;
let sentinels = 0;
const sentinel = () => `Zq9Snt${sentinels += 1}Kx7Wv2Rt8Pm4Lb6`;

// Every file under a directory, and which sentinels any of them holds.
async function leaks(directory, secrets) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath ?? entry.path, entry.name);
    const bytes = await readFile(file, 'latin1');
    for (const secret of secrets) if (bytes.includes(String(secret))) found.push(`${basename(file)}: ${secret}`);
  }
  return found;
}

// A private store holding one project's worktree binding, a working directory bound to it, and an active capture
// record naming the store; the session's transcript is a file the test grows.
async function setup(t, { file: chosen } = {}) {
  const root = await scratchDirectory(t, 'shadowgraph-capture-redaction-');
  const cwd = join(root, 'work');
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
  const home = join(root, 'home');
  const sgHome = join(root, 'sg-home');
  await mkdir(home);
  await mkdir(sgHome);
  await mkdir(join(root, 'transcripts'));
  const file = chosen ?? join(root, 'private', 'memory.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd), project: 'alpha', confirmed: true }));
  const graph = createShadowGraph();
  privilegedBindProject(graph, { type: 'worktree', path: resolve(cwd), project: 'alpha', reason: 'synthetic redaction test', surface: 'cli' });
  await createJsonFileStore(file).save(privilegedSnapshot(graph));
  const capture = { state: 'active', changedAt: ACTIVATED, evidence: 'synthetic', store: { file, storage: 'json' }, originId: mintOriginId(), coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS }, mcpServerNames: ['shadowgraph'] };
  const activation = join(sgHome, 'activation.json');
  await writeFile(activation, JSON.stringify({ version: 1, capabilities: { delivery: { state: 'active', store: { file, storage: 'json' } }, capture } }));
  const transcriptPath = join(root, 'transcripts', 'session-1.jsonl');
  const run = (payload, options = {}) => runCapture({ capture, input: JSON.stringify({ session_id: 'session-1', cwd: '/work', transcript_path: transcriptPath, ...payload }), deadline: Date.now() + 10_000, record: activation, home, cwd, ...options });
  const load = () => createJsonFileStore(file).load();
  const items = async () => (await load()).records.filter((item) => item.kind === 'capture');
  const textOf = async (item) => (await load()).captureContent?.find((entry) => entry.contentRef === item.contentRef)?.text;
  return { root, cwd, home, sgHome, file, capture, activation, transcriptPath, run, load, items, textOf, env: { HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: sgHome } };
}

// The transcript's lines, in the shape the reader recognises.
const line = (value) => `${JSON.stringify(value)}\n`;
const say = (uuid, text) => line({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const use = (uuid, id, text) => line({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }, { type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } });
const done = (uuid, id) => line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

test('PR-37b: the redactor is moved, not copied, and delivery still uses it', () => {
  assert.equal(deliveryRedactText, redactText);
  assert.equal(deliveryRedactValue, redactValue);
});

test('PR-37b M-2: no credential in any field the hook captures reaches the store\'s files', async (t) => {
  const s = await setup(t);
  const k = Array.from({ length: 16 }, sentinel);
  const number = 9182736455019;
  assert.equal(await s.run({ hook_event_name: 'UserPromptSubmit', prompt: `deploy with password=${k[0]} and ${token(k[1])}`, message_id: 'm1' }), 'written');
  // Every shape of a credential inside a tool's input, rendered as text (R1).
  assert.equal(await s.run({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', cwd: `/srv/app?token=${k[2]}`,
    tool_input: { command: 'deploy', password: k[3], token: number, headers: { Authorization: `Bearer ${k[4]}` }, credentials: { db: k[5] }, secrets: [k[6]], nested: { password: { value: k[7] } }, pairs: [['X-Api-Key', k[8]]], env: [{ name: 'DB_PASSWORD', value: k[9] }] },
    tool_response: { stdout: 'deployed', exit_code: 0 }
  }), 'written');
  // A whole key block in a tool's response.
  assert.equal(await s.run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'cat key' }, tool_response: { stdout: `${BEGIN}\nMIIEow${k[10]}\n${k[10]}AB==\n${END}`, exit_code: 0 } }), 'written');
  // A credential inside escaped JSON, which only the decoded literal shows (R2).
  assert.equal(await s.run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_3', tool_input: { command: 'curl' }, tool_response: { stdout: `{"body":"{\\"api_key\\":\\"${k[11]}\\"}"}`, exit_code: 0 } }), 'written');
  // A tool whose name carries a credential, with an id, so the outcome holds a copy of the name (R5).
  assert.equal(await s.run({ hook_event_name: 'PostToolUseFailure', tool_name: `Deploy ${token(k[12])}`, tool_use_id: 'toolu_4', tool_input: { target: 'prod' }, error: `login failed: password=${k[13]}` }), 'written');
  assert.equal(await s.run({ hook_event_name: 'Stop', last_assistant_message: `Done. Authorization: Bearer ${k[14]}9` }), 'written');
  assert.deepEqual(await leaks(dirname(s.file), [...k, number]), []);
  const items = await s.items();
  const byCall = (id) => items.find((item) => item.source.toolCallId === id);
  assert.equal(items.length, 6);
  assert.equal(byCall('toolu_1').state, 'pending', 'the redacted input is kept, not withheld');
  assert.match(await s.textOf(byCall('toolu_1')), /\[REDACTED\]/u);
  assert.deepEqual([byCall('toolu_3').state, byCall('toolu_3').blockedReason, byCall('toolu_3').contentRef], ['blocked', 'credential_withheld', null], 'what the redactor leaves and the checker flags is withheld');
});

test('PR-37b M-2: transcript text is redacted, a key split across entries included, and a Stop holding a credential is captured once', async (t) => {
  const s = await setup(t);
  const k = Array.from({ length: 5 }, sentinel);
  assert.equal(await s.run({ hook_event_name: 'UserPromptSubmit', prompt: 'go', message_id: 'm1' }), 'written');
  const final = `All done, password=${k[4]} rotated.`;
  await appendFile(s.transcriptPath, [
    use('a1', 't1', `Using api_key=${k[0]} now.`), done('u1', 't1'),
    use('a2', 't2', `The key:\n${BEGIN}`), done('u2', 't2'),
    use('a3', 't3', `MIIEow${k[1]}AAAA\n${k[2]}BBBB`), done('u3', 't3'),
    use('a4', 't4', `${k[3]}CCCC==\n${END}`), done('u4', 't4'),
    say('a5', final)
  ].join(''));
  assert.equal(await s.run({ hook_event_name: 'Stop', last_assistant_message: final }), 'written');
  assert.deepEqual(await leaks(dirname(s.file), k), []);
  const events = (await s.items()).map((item) => item.source.event);
  assert.deepEqual(events, ['UserPromptSubmit', 'Stop', 'Transcript', 'Transcript', 'Transcript', 'Transcript'], 'the final message reconciles with its Stop; the four tool-side texts are recorded');
});

test('PR-37b M-2: a key whose BEGIN line an earlier read took is withheld by its END line', () => {
  const graph = createShadowGraph({ now: () => '2026-02-01T00:00:00.000Z' });
  const k = sentinel();
  const item = privilegedRecordCapture(graph, { project: 'alpha', originId: 'origin-a', text: `${k}DDDD==\n${END}`, admission: admission(), source: { event: 'Transcript', sessionId: 's-1', role: 'assistant', hostEventId: 'a9' } });
  assert.deepEqual([item.state, item.blockedReason, item.contentRef, item.contentHash], ['blocked', 'credential_withheld', null, null]);
  assert.equal(JSON.stringify(privilegedSnapshot(graph)).includes(k), false);
});

test('PR-37b M-2: contentHash is the hash of the stored, redacted text', () => {
  const graph = createShadowGraph({ now: () => '2026-02-01T00:00:00.000Z' });
  const k = sentinel();
  const raw = `use password=${k} here`;
  const item = privilegedRecordCapture(graph, { project: 'alpha', originId: 'origin-a', text: raw, admission: admission(), source: { event: 'UserPromptSubmit', sessionId: 's-1', role: 'user', hostEventId: 'm1' } });
  const stored = privilegedSnapshot(graph).captureContent.find((entry) => entry.contentRef === item.contentRef).text;
  assert.equal(stored.includes(k), false);
  assert.equal(item.contentHash, sha256(stored));
  assert.notEqual(item.contentHash, sha256(raw));
});

test('PR-37b M-2: delivered blocks are stripped before the rest is redacted', () => {
  const graph = createShadowGraph({ now: () => '2026-02-01T00:00:00.000Z' });
  const [inside, outside] = [sentinel(), sentinel()];
  const block = `${DELIVERY_FRAME}\nhead: {"note":"password=${inside}"}\n`;
  const text = `before password=${outside}\n${block}${deliveryEndLine(Buffer.byteLength(block))}\nafter`;
  const item = privilegedRecordCapture(graph, { project: 'alpha', originId: 'origin-a', text, admission: admission(), source: { event: 'PostToolUse', sessionId: 's-1', role: null, toolCallId: 'c1' } });
  const snapshot = privilegedSnapshot(graph);
  const stored = snapshot.captureContent.find((entry) => entry.contentRef === item.contentRef).text;
  assert.equal(stored.includes(DELIVERY_FRAME), false, 'the whole block is gone');
  assert.match(JSON.stringify(snapshot.captureSessions[0].selfEvents), /S-1/u, 'and counted as ShadowGraph\'s own');
  assert.equal(JSON.stringify(snapshot).includes(inside) || JSON.stringify(snapshot).includes(outside), false);
});

test('PR-37b M-2: what the checker flags after redaction is withheld, end to end, with no content and no hash', async (t) => {
  const s = await setup(t);
  const k = sentinel();
  assert.equal(await s.run({ hook_event_name: 'UserPromptSubmit', prompt: `password:\n${k}`, message_id: 'm1' }), 'written');
  const [item] = await s.items();
  assert.deepEqual([item.state, item.blockedReason, item.contentRef, item.contentHash], ['blocked', 'credential_withheld', null, null]);
  assert.deepEqual((await s.load()).captureContent ?? [], []);
  assert.deepEqual(await leaks(dirname(s.file), [k]), []);
});

test('PR-37b M-2: a withheld Stop\'s transcript copy is withheld too, and withheld items are no repeats of one another', () => {
  let clock = Date.parse('2026-02-01T00:00:00.000Z');
  const graph = createShadowGraph({ now: () => new Date(clock += 1000).toISOString() });
  const [first, second, third] = [sentinel(), sentinel(), sentinel()];
  const record = (event, text, source = {}) => privilegedRecordCapture(graph, { project: 'alpha', originId: 'origin-a', text, admission: admission(), source: { event, sessionId: 's-1', ...source } });
  const one = record('UserPromptSubmit', `password:\n${first}`, { role: 'user' });
  const two = record('UserPromptSubmit', `password:\n${second}`, { role: 'user' });
  assert.deepEqual([one.state, two.state, two.possibleDuplicateOf], ['blocked', 'blocked', null], 'two different withheld prompts are not repeats');
  const stop = record('Stop', `password:\n${third}`, { role: 'assistant' });
  assert.equal(stop.state, 'blocked');
  const file = { ref: 'ref-a', bytes: Buffer.alloc(0) };
  const transcript = { ref: 'ref-a', size: () => file.bytes.length, read: (start, length) => file.bytes.subarray(start, start + length) };
  const step = (trigger) => privilegedRecordTranscript(graph, { originId: 'origin-a', sessionId: 's-1', project: 'alpha', activatedAt: ACTIVATED, trigger, triggerItemId: null, transcript, admission: admission() });
  step(null);
  file.bytes = Buffer.from(say('a1', `password:\n${third}`));
  step('Stop');
  const copies = privilegedSnapshot(graph).records.filter((item) => item.kind === 'capture' && item.source.event === 'Transcript');
  assert.deepEqual(copies.map((item) => [item.state, item.blockedReason]), [['blocked', 'credential_withheld']], 'declared: recorded again, and withheld again');
  assert.equal(JSON.stringify(privilegedSnapshot(graph)).includes(third), false);
});

test('PR-37b M-2: raw text over twice the item limit is refused before it is redacted; a redacted item within the limit is admitted', () => {
  const graph = createShadowGraph({ now: () => '2026-02-01T00:00:00.000Z' });
  const record = (text, limits, id) => privilegedRecordCapture(graph, { project: 'alpha', originId: 'origin-a', text, admission: admission(limits), source: { event: 'PostToolUse', sessionId: 's-1', toolCallId: id } });
  const big = `${BEGIN}\n${'QUJD'.repeat(400)}\n${END}`;
  assert.equal(record(big, { maxItemBytes: 100 }, 'c1').refused?.limit, 'maxItemBytes', 'more than twice the limit: refused unredacted');
  const fits = `${BEGIN}\n${'QUJD'.repeat(10)}\n${END}`;
  assert.ok(Buffer.byteLength(fits) > 100 && Buffer.byteLength(fits) <= 200);
  assert.equal(record(fits, { maxItemBytes: 100 }, 'c2').state, 'pending', 'redacted, it fits');
});

test('PR-37b M-3: a store inside a git worktree or its common directory is refused, writes nothing, and delivery says capture is unavailable', async (t) => {
  const base = await scratchDirectory(t, 'shadowgraph-capture-worktree-');
  const git = (args, cwd) => execFileSync('git', args, { cwd, env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }, stdio: 'pipe' });
  const main = join(base, 'main');
  await mkdir(main);
  git(['init', '-q'], main);
  await writeFile(join(main, 'readme.txt'), 'x');
  git(['add', '.'], main);
  git(['commit', '-q', '-m', 'init'], main);
  git(['worktree', 'add', '-q', join(base, 'linked'), '-b', 'linked'], main);
  for (const file of [join(base, 'linked', 'private', 'memory.json'), join(main, '.git', 'capture', 'memory.json')]) {
    const s = await setup(t, { file });
    const before = await readFile(s.file);
    assert.equal(await s.run({ hook_event_name: 'UserPromptSubmit', prompt: 'hello', message_id: 'm1' }), 'store_inside_repository', file);
    assert.deepEqual(await readFile(s.file), before, 'nothing written');
    let text = '';
    await runDeliver({ args: ['--hook'], readInput: () => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-1' }), env: { SHADOWGRAPH_HOME: s.sgHome }, write: (out) => { text += out; } });
    const processing = JSON.parse(JSON.parse(text).hookSpecificOutput.additionalContext.split('\n').find((entry) => entry.startsWith('processing: ')).slice('processing: '.length));
    assert.deepEqual([processing.capture, processing.reason], ['unavailable', 'store_inside_repository'], file);
  }
  // SHADOWGRAPH_FILE never selects the store, even pointing inside a worktree.
  const s = await setup(t);
  const routed = join(base, 'linked', 'routed.json');
  const result = await new Promise((settle, fail) => {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SHADOWGRAPH_'))), ...s.env, SHADOWGRAPH_FILE: routed };
    const child = spawn(process.execPath, [CLI, 'capture', '--hook'], { cwd: s.cwd, env });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', fail);
    child.on('close', (code) => settle({ code, output }));
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-1', cwd: '/work', prompt: 'routed', message_id: 'm1' }));
  });
  assert.deepEqual([result.code, result.output], [0, '']);
  assert.equal(fs.existsSync(routed), false);
  assert.deepEqual((await s.items()).map((item) => item.source.event), ['UserPromptSubmit']);
  // The CLI hands delivery SHADOWGRAPH_FILE as its file; the capture line still judges the activation's store.
  let text = '';
  await runDeliver({ args: ['--hook'], readInput: () => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-1' }), file: routed, storage: 'json', env: { SHADOWGRAPH_HOME: s.sgHome }, write: (out) => { text += out; } });
  assert.match(text, /processing: \{\\"capture\\":\\"active\\"/u, 'the activation store is capturing');
});

test('PR-37b: delivery names why capture is unavailable when the store cannot be read, is newer, or holds a pending deletion record', async (t) => {
  const s = await setup(t);
  const reason = async () => {
    let text = '';
    await runDeliver({ args: ['--hook'], readInput: () => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-1' }), env: { SHADOWGRAPH_HOME: s.sgHome }, write: (out) => { text += out; } });
    const processing = JSON.parse(JSON.parse(text).hookSpecificOutput.additionalContext.split('\n').find((entry) => entry.startsWith('processing: ')).slice('processing: '.length));
    return [processing.capture, processing.reason ?? null];
  };
  assert.deepEqual(await reason(), ['active', null]);
  const payload = JSON.parse(await readFile(s.file, 'utf8'));
  await writeFile(`${s.file}.control.json`, JSON.stringify({ version: 1, pending: [{ kind: 'purge' }] }));
  assert.deepEqual(await reason(), ['unavailable', 'deletion_pending']);
  fs.rmSync(`${s.file}.control.json`);
  await writeFile(s.file, JSON.stringify({ ...payload, schemaVersion: payload.schemaVersion + 1 }));
  assert.deepEqual(await reason(), ['unavailable', 'newer_schema']);
  await writeFile(s.file, '{not json');
  assert.deepEqual(await reason(), ['unavailable', 'store_unreadable']);
});

test('PR-37b M-3: a directory whose .git entry cannot be examined counts as a repository', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-capture-eacces-');
  const deny = join(root, 'deny');
  await mkdir(join(deny, 'inner'), { recursive: true });
  const original = fs.promises.lstat;
  fs.promises.lstat = async (path, ...rest) => {
    if (String(path).endsWith(`${sep}deny${sep}.git`)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.lstat = original; syncBuiltinESMExports(); });
  assert.equal(await storeRepository(join(deny, 'inner', 'store.json')), await realpath(deny));
});

test('PR-37b D5: a capture that loses the lock or runs out of time writes nothing anywhere', async (t) => {
  const s = await setup(t);
  const listing = async () => (await readdir(s.root, { recursive: true })).sort();
  const before = await listing();
  const storeBefore = await readFile(s.file);
  assert.equal(await s.run({ hook_event_name: 'UserPromptSubmit', prompt: 'late', message_id: 'm1' }, { deadline: Date.now() + 100 }), 'out_of_time');
  // The store's lock held by a live owner, so the hook cannot take it in time.
  const lock = `${s.file}.lock`;
  await writeFile(lock, `${process.pid}:${Date.now()}:held`);
  await assert.rejects(s.run({ hook_event_name: 'UserPromptSubmit', prompt: 'blocked', message_id: 'm2' }, { deadline: Date.now() + 1500 }));
  fs.rmSync(lock);
  assert.deepEqual(await listing(), before);
  assert.deepEqual(await readFile(s.file), storeBefore);
});

// What mode each file was created with: a spy on the creating calls, so the
// check holds on every platform.
function spyModes(t) {
  const created = [];
  const { writeFile: originalWrite, open: originalOpen, mkdir: originalMkdir } = fs.promises;
  const modeOf = (options) => (typeof options === 'object' && options !== null && options.mode !== undefined ? options.mode : null);
  fs.promises.writeFile = async (path, data, options) => { created.push({ call: 'writeFile', path: String(path), mode: modeOf(options) }); return originalWrite(path, data, options); };
  fs.promises.open = async (path, flags, mode) => { if (String(flags).includes('x')) created.push({ call: 'open', path: String(path), mode: mode ?? null }); return originalOpen(path, flags, mode); };
  fs.promises.mkdir = async (path, options) => { created.push({ call: 'mkdir', path: String(path), mode: modeOf(options) }); return originalMkdir(path, options); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs.promises, { writeFile: originalWrite, open: originalOpen, mkdir: originalMkdir }); syncBuiltinESMExports(); });
  return created;
}
const modes = (entries) => [...new Set(entries.map((entry) => entry.mode))];

test('PR-37b FND-P6-11: every capture commit, its lock and the store\'s directory are owner-only; a manual save keeps the store\'s mode', async (t) => {
  const s = await setup(t);
  // A store made group- and world-readable, so the owner-only commit is not the store's own mode (where modes exist).
  await chmod(s.file, 0o644);
  const created = spyModes(t);
  assert.equal(await s.run({ hook_event_name: 'UserPromptSubmit', prompt: 'hello', message_id: 'm1' }), 'written');
  const temporary = created.filter((entry) => entry.call === 'writeFile' && entry.path.endsWith('.tmp') && dirname(entry.path) === dirname(s.file));
  assert.ok(temporary.length >= 1, JSON.stringify(created));
  assert.deepEqual(modes(temporary), [0o600], 'the capture commit');
  // The fence names its lock beside the store's canonical path (PR-37c design §3.1, check R3-2).
  const lock = await fenceLockPath(s.file);
  assert.deepEqual(modes(created.filter((entry) => entry.call === 'open' && entry.path === lock)), [0o600], 'the lock');
  assert.deepEqual(modes(created.filter((entry) => entry.call === 'mkdir' && entry.path === dirname(s.file))), [0o700], 'the store\'s directory, when made');
  created.length = 0;
  // The capture made the store owner-only; a manual store made readable again keeps that mode on a manual save.
  await chmod(s.file, 0o644);
  const kept = (await stat(s.file)).mode & 0o777;
  const manual = createJsonFileStore(s.file);
  await manual.save({ ...(await manual.load()) });
  assert.deepEqual(modes(created.filter((entry) => entry.call === 'writeFile' && entry.path.endsWith('.tmp'))), [kept], 'a manual save keeps the store\'s mode');
  created.length = 0;
  const fresh = join(s.root, 'new', 'store.json');
  await createJsonFileStore(fresh).save({ records: [] });
  assert.deepEqual(modes(created.filter((entry) => entry.call === 'writeFile' && entry.path.endsWith('.tmp'))), [0o600], 'a new store is owner-only');
});

test('PR-37b FND-P6-11: a restore creates its temporary and rollback files with the destination\'s mode', async (t) => {
  const s = await setup(t);
  const source = join(s.root, 'backup.json');
  await writeFile(source, await readFile(s.file));
  const kept = (await stat(s.file)).mode & 0o777;
  const created = spyModes(t);
  await restoreFile(source, s.file, { env: s.env });
  const restoreFiles = created.filter((entry) => entry.call === 'writeFile' && dirname(entry.path) === dirname(s.file) && /\.restore\.|\.rollback/u.test(basename(entry.path)));
  assert.ok(restoreFiles.length >= 2, JSON.stringify(created));
  assert.deepEqual(modes(restoreFiles), [kept]);
  created.length = 0;
  const fresh = join(s.root, 'fresh', 'restored.json');
  await mkdir(dirname(fresh));
  await restoreFile(source, fresh, { env: s.env });
  assert.deepEqual(modes(created.filter((entry) => entry.call === 'writeFile' && /\.restore\./u.test(basename(entry.path)))), [0o600], 'a new destination is owner-only');
});

test('PR-37b FND-P6-11: on POSIX, a capture store created group- and world-readable is owner-only after a capture, and a manual store keeps its mode', POSIX, async (t) => {
  const s = await setup(t);
  await chmod(s.file, 0o644);
  assert.equal(await s.run({ hook_event_name: 'UserPromptSubmit', prompt: 'hello', message_id: 'm1' }), 'written');
  assert.equal((await stat(s.file)).mode & 0o777, 0o600);
  const manual = join(s.root, 'manual.json');
  await writeFile(manual, '{}');
  await chmod(manual, 0o644);
  await createJsonFileStore(manual).save({ records: [] });
  assert.equal((await stat(manual)).mode & 0o777, 0o644);
});

// ---------------------------------------------------------------------------
// The review of the change (briefs/PR37b-review.md): its findings and the
// killing tests its tests lens drafted.
// ---------------------------------------------------------------------------

// A transcript held in memory, for the kernel's own read.
function memoryTranscript() {
  const file = { bytes: Buffer.alloc(0) };
  return { file, transcript: { ref: 'ref-a', size: () => file.bytes.length, read: (start, length) => file.bytes.subarray(start, start + length) } };
}

for (const stopped of [true, false]) test(`PR-37b review F1: a credential the checker finds only across a run's entries is withheld in each (${stopped ? 'its Stop withheld' : 'no Stop'})`, () => {
  let clock = Date.parse('2026-02-01T00:00:00.000Z');
  const graph = createShadowGraph({ now: () => new Date(clock += 1000).toISOString() });
  const k = sentinel();
  const { file, transcript } = memoryTranscript();
  const step = (trigger) => privilegedRecordTranscript(graph, { originId: 'origin-a', sessionId: 's-1', project: 'alpha', activatedAt: ACTIVATED, trigger, triggerItemId: null, transcript, admission: admission() });
  step(null);
  const [one, two] = ['Set it with password:', k];
  if (stopped) assert.equal(privilegedRecordCapture(graph, { project: 'alpha', originId: 'origin-a', text: `${one}\n\n${two}`, admission: admission(), source: { event: 'Stop', sessionId: 's-1', role: 'assistant' } }).state, 'blocked');
  file.bytes = Buffer.from(say('c1', one) + say('c2', two));
  step(stopped ? 'Stop' : 'PreCompact');
  const copies = privilegedSnapshot(graph).records.filter((item) => item.kind === 'capture' && item.source.event === 'Transcript');
  assert.deepEqual(copies.map((item) => [item.state, item.blockedReason]), [['blocked', 'credential_withheld'], ['blocked', 'credential_withheld']]);
  assert.equal(JSON.stringify(privilegedSnapshot(graph)).includes(k), false);
});

test('PR-37b review F2, F4: an argument vector\'s credential flags, short credential keys, cookies and key data are redacted', async (t) => {
  const s = await setup(t);
  const k = Array.from({ length: 10 }, sentinel);
  assert.equal(await s.run({
    hook_event_name: 'PostToolUse', tool_name: 'mcp__shell__run', tool_use_id: 'toolu_9',
    tool_input: { args: ['mysql', '--password', k[0]], argv: ['run', '--token', k[1], '--verbose'], curl: ['-u', `me:${k[2]}`, 'https://example.invalid'], header: ['set', 'X-Api-Key', k[9]], pass: k[3], pw: k[4], auth: k[5], cookie: `session=${k[6]}` },
    tool_response: { stdout: `Cookie: theme=dark; session=${k[7]}\nclient-key-data: ${k[8]}` }
  }), 'written');
  assert.deepEqual(await leaks(dirname(s.file), k), []);
  const [item] = await s.items();
  assert.equal(item.state, 'pending', 'redacted, not withheld');
  assert.match(await s.textOf(item), /--password \[REDACTED\]/u);
});

test('PR-37b review F8: a key\'s body running on into an entry that then says more is redacted, and the rest kept', () => {
  let clock = Date.parse('2026-02-01T00:00:00.000Z');
  const graph = createShadowGraph({ now: () => new Date(clock += 1000).toISOString() });
  const [first, second] = [sentinel(), sentinel()];
  const { file, transcript } = memoryTranscript();
  const step = (trigger) => privilegedRecordTranscript(graph, { originId: 'origin-a', sessionId: 's-1', project: 'alpha', activatedAt: ACTIVATED, trigger, triggerItemId: null, transcript, admission: admission() });
  step(null);
  file.bytes = Buffer.from(use('k1', 't1', `The key:\n${BEGIN}`) + done('u1', 't1') + use('k2', 't2', `MIIEow${first}AAAA\n${second}BBBB==\nThat was the key.\nKeep it safe.`) + done('u2', 't2'));
  step('PreCompact');
  const snapshot = privilegedSnapshot(graph);
  assert.equal(JSON.stringify(snapshot).includes(first) || JSON.stringify(snapshot).includes(second), false);
  assert.ok(snapshot.captureContent.some((entry) => entry.text.includes('That was the key.')), 'the prose is kept');
});

test('PR-37b review F9: an observed string the checker still flags is withheld from the observation', async (t) => {
  const s = await setup(t);
  const k = sentinel();
  // Escaped JSON inside a string literal, as a tool prints it: only the decoded literal shows the credential.
  const escaped = `"{\\"api_key\\":\\"${k}\\"}"`;
  assert.equal(await s.run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_8', cwd: escaped, tool_input: { command: 'ls' }, tool_response: { stdout: 'ok', exit_code: 0 } }), 'written');
  const [item] = await s.items();
  assert.equal(item.observation.cwd, '[REDACTED]');
  assert.deepEqual(await leaks(dirname(s.file), [k]), []);
});

test('PR-37b review F7: an entry too long to be an item is measured redacted, as its Stop is', () => {
  let clock = Date.parse('2026-02-01T00:00:00.000Z');
  const graph = createShadowGraph({ now: () => new Date(clock += 1000).toISOString() });
  const { file, transcript } = memoryTranscript();
  const limits = { maxItemBytes: 100 };
  const step = (trigger) => privilegedRecordTranscript(graph, { originId: 'origin-a', sessionId: 's-1', project: 'alpha', activatedAt: ACTIVATED, trigger, triggerItemId: null, transcript, admission: admission(limits) });
  step(null);
  const text = `password=${'x'.repeat(120)}`;
  assert.equal(privilegedRecordCapture(graph, { project: 'alpha', originId: 'origin-a', text, admission: admission(limits), source: { event: 'Stop', sessionId: 's-1', role: 'assistant' } }).state, 'pending');
  file.bytes = Buffer.from(say('l1', text));
  step('Stop');
  assert.deepEqual(privilegedSnapshot(graph).records.filter((item) => item.kind === 'capture').map((item) => item.source.event), ['Stop'], 'reconciled, not recorded twice');
});

test('PR-37b review P-1: a credential name the checker sees only folded is withheld', async (t) => {
  const s = await setup(t);
  const k = sentinel();
  assert.equal(await s.run({ hook_event_name: 'UserPromptSubmit', prompt: `ｐａｓｓｗｏｒｄ:\n${k}`, message_id: 'm1' }), 'written');
  const [item] = await s.items();
  assert.deepEqual([item.state, item.blockedReason], ['blocked', 'credential_withheld']);
  assert.deepEqual(await leaks(dirname(s.file), [k]), []);
});

test('PR-37b review P-2: a withheld item still meets the session limit', () => {
  const graph = createShadowGraph({ now: () => '2026-02-01T00:00:00.000Z' });
  const record = (text, id) => privilegedRecordCapture(graph, { project: 'alpha', originId: 'origin-a', text, admission: admission({ maxItemsPerSession: 1 }), source: { event: 'UserPromptSubmit', sessionId: 's-1', role: 'user', hostEventId: id } });
  assert.equal(record('first', 'm1').state, 'pending');
  assert.equal(record(`password:\n${sentinel()}`, 'm2').refused?.limit, 'maxItemsPerSession');
});

for (const order of ['withheld first', 'content-less first']) test(`PR-37b review P-3: a withheld item and a content-less one are never repeats of each other (${order})`, () => {
  let clock = Date.parse('2026-02-01T00:00:00.000Z');
  const graph = createShadowGraph({ now: () => new Date(clock += 1000).toISOString() });
  const record = (text) => privilegedRecordCapture(graph, { project: 'alpha', originId: 'origin-a', text, admission: admission(), source: { event: 'Stop', sessionId: 's-1', role: 'assistant' } });
  const texts = [`password:\n${sentinel()}`, undefined];
  if (order !== 'withheld first') texts.reverse();
  const [, second] = texts.map(record);
  assert.equal(second.possibleDuplicateOf, null);
});

for (const [label, parts] of [['two entries', (k) => [`First, password=${k} is set.`, 'Then it is done.']], ['one entry', (k) => [`All done, password=${k} rotated.`]]]) {
  test(`PR-37b review P-4: a final message holding a credential (${label}) is captured once, also after the next read`, async (t) => {
    const s = await setup(t);
    const k = sentinel();
    assert.equal(await s.run({ hook_event_name: 'UserPromptSubmit', prompt: 'go', message_id: 'm1' }), 'written');
    const texts = parts(k);
    await appendFile(s.transcriptPath, texts.map((text, index) => say(`f${index}`, text)).join(''));
    assert.equal(await s.run({ hook_event_name: 'Stop', last_assistant_message: texts.join('\n\n') }), 'written');
    await s.run({ hook_event_name: 'SessionEnd', reason: 'exit' });
    assert.deepEqual((await s.items()).map((item) => item.source.event), ['UserPromptSubmit', 'Stop']);
    assert.deepEqual(await leaks(dirname(s.file), [k]), []);
  });
}

test('PR-37b review P-5: a backup\'s ledger copy is created owner-only', async (t) => {
  const s = await setup(t);
  await writeFile(`${s.file}.control.json`, '{"version":1}\n');
  const created = spyModes(t);
  await backupFile(s.file, join(s.root, 'copy.json'), { env: s.env });
  const sidecar = created.filter((entry) => entry.call === 'open' && /\.control\.json\..*\.tmp$/u.test(entry.path));
  assert.ok(sidecar.length >= 1, JSON.stringify(created));
  assert.deepEqual(modes(sidecar), [0o600]);
});

test('PR-37b review P-6: a SQLite backup copy is made owner-only before it is renamed into place', async (t) => {
  const { nodeSqlite } = await (await import('../src/runtime-capabilities.js')).getRuntimeCapabilities();
  if (!nodeSqlite.available) { t.skip(nodeSqlite.reason); return; }
  const root = await scratchDirectory(t, 'shadowgraph-capture-redaction-sqlite-');
  const file = join(root, 'memory.db');
  const store = await createStorage({ type: 'sqlite', file });
  t.after(() => store.close?.());
  await store.save({ records: [] });
  const calls = [];
  const { chmod: originalChmod, rename: originalRename } = fs.promises;
  fs.promises.chmod = async (path, mode) => { calls.push(['chmod', String(path), mode]); return originalChmod(path, mode); };
  fs.promises.rename = async (from, to) => { calls.push(['rename', String(from), String(to)]); return originalRename(from, to); };
  syncBuiltinESMExports();
  t.after(() => { Object.assign(fs.promises, { chmod: originalChmod, rename: originalRename }); syncBuiltinESMExports(); });
  await store.backup(join(root, 'copy.db'));
  const chmods = calls.filter(([call]) => call === 'chmod');
  assert.deepEqual(chmods.map(([, , mode]) => mode), [0o600], JSON.stringify(calls));
  const renamed = calls.findIndex(([call, , to]) => call === 'rename' && basename(to) === 'copy.db');
  assert.ok(renamed > calls.indexOf(chmods[0]) && calls[renamed][1] === chmods[0][1]);
});

test('PR-37b review P-7: a capture out of time inside the store writes nothing in the store\'s, the record\'s or the per-user directory', async (t) => {
  const s = await setup(t);
  const roots = [s.root, process.env.SHADOWGRAPH_HOME].filter(Boolean);
  const listing = async () => (await Promise.all(roots.map((directory) => readdir(directory, { recursive: true }).catch(() => [])))).map((list) => list.sort());
  const before = await listing();
  let skew = 0;
  assert.equal(await s.run({ hook_event_name: 'UserPromptSubmit', prompt: 'late', message_id: 'm1' }, { post: (stage) => { if (stage === 'enter') skew = 60_000; }, now: () => Date.now() + skew }), 'out_of_time');
  assert.deepEqual(await listing(), before);
});

test('PR-37b review P-8: admission measures the observation as it is stored, redacted', () => {
  const raw = { host: 'claude-code', hostVersion: null, toolName: 'Bash', cwd: `/srv/app?token=${'Q'.repeat(4000)}`, outcome: null };
  const attempt = (observation, maxStoreBytes) => {
    const graph = createShadowGraph({ now: () => '2026-02-01T00:00:00.000Z' });
    return privilegedRecordCapture(graph, { project: 'alpha', originId: 'origin-a', text: 'ok', observation, admission: admission({ maxStoreBytes }), source: { event: 'PostToolUse', sessionId: 's-1', toolCallId: 'c1' } });
  };
  // The least store ceiling that admits the item with its observation as it is stored.
  let low = 1;
  let high = 1 << 20;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (attempt(redactValue(raw), middle).refused) low = middle + 1;
    else high = middle;
  }
  assert.equal(attempt(raw, low).refused, undefined, 'the credential the observation held is not counted');
});

// ---------------------------------------------------------------------------
// The re-review (briefs/PR37b-re-review.md).
// ---------------------------------------------------------------------------

test('PR-37b re-review NF-3: a run whose Stop was withheld waits for the rest of its copy, then is withheld whole', async (t) => {
  const s = await setup(t);
  const k = sentinel();
  assert.equal(await s.run({ hook_event_name: 'UserPromptSubmit', prompt: 'go', message_id: 'm1' }), 'written');
  const one = 'Set it with password:';
  await appendFile(s.transcriptPath, line({ type: 'user', uuid: 'u0', message: { role: 'user', content: 'next' } }) + say('a1', one));
  // The host's Stop comes before the transcript holds the whole message.
  assert.equal(await s.run({ hook_event_name: 'Stop', last_assistant_message: `${one}\n\n${k}` }), 'written');
  await appendFile(s.transcriptPath, say('a2', k));
  await s.run({ hook_event_name: 'SessionEnd', reason: 'exit' });
  assert.deepEqual(await leaks(dirname(s.file), [k]), []);
  assert.deepEqual((await s.items()).filter((item) => item.source.event === 'Transcript').map((item) => item.blockedReason), ['credential_withheld', 'credential_withheld']);
});

test('PR-37b re-review NF-3: a run being withheld that time cuts is read again whole', () => {
  let clock = Date.parse('2026-02-01T00:00:00.000Z');
  const graph = createShadowGraph({ now: () => new Date(clock += 1000).toISOString() });
  const k = sentinel();
  const { file, transcript } = memoryTranscript();
  const transcribed = () => privilegedSnapshot(graph).records.filter((item) => item.kind === 'capture' && item.source.event === 'Transcript');
  let limit = Infinity;
  const step = (trigger) => privilegedRecordTranscript(graph, { originId: 'origin-a', sessionId: 's-1', project: 'alpha', activatedAt: ACTIVATED, trigger, triggerItemId: null, transcript, admission: admission(), mayContinue: () => transcribed().length < limit });
  step(null);
  file.bytes = Buffer.from(say('c1', 'Set it with password:') + say('c2', k) + say('c3', 'Done.'));
  // Time runs out once the run's first entry is recorded.
  limit = 1;
  step('PreCompact');
  assert.equal(transcribed().length, 1);
  limit = Infinity;
  step('PreCompact');
  assert.deepEqual(transcribed().map((item) => item.blockedReason), ['credential_withheld', 'credential_withheld', 'credential_withheld']);
  assert.equal(JSON.stringify(privilegedSnapshot(graph)).includes(k), false);
});

test('PR-37b re-review NF-4, NF-5: user flags, auth and pw flags in any array, and cookies in JSON are redacted', async (t) => {
  const s = await setup(t);
  const k = Array.from({ length: 9 }, sentinel);
  assert.equal(await s.run({
    hook_event_name: 'PostToolUse', tool_name: 'mcp__shell__run', tool_use_id: 'toolu_7',
    tool_input: { authMixed: ['http', '--auth', `me:${k[8]}`, 8080], mixed: ['curl', '-u', `me:${k[0]}`, 3], multiline: ['curl', '-u', `me:${k[1]}`, '-d', '{\n"a":1\n}'], auth: ['http', '--auth', `me:${k[2]}`, 'https://example.invalid'], pw: ['tool', '--pw', k[3]], command: `http --auth me:${k[4]} https://example.invalid`, jar: { cookies: [{ name: 'sid', value: k[5] }] } },
    tool_response: { stdout: `{"headers":{"set-cookie":"sid=${k[6]}; Path=/"}}\n{"headers":{"Cookie":"sid=${k[7]}"}}` }
  }), 'written');
  assert.deepEqual(await leaks(dirname(s.file), k), []);
  assert.equal((await s.items())[0].state, 'pending', 'redacted, not withheld');
});
