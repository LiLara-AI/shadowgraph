// Durable capture input (independent review 2026-10-26 §5): the reviewer's
// reproducer -- a separate process holds the store's fence, with a heartbeat,
// while a prompt arrives -- turned into regressions, and the spool's own
// bounds. Every CLI run points HOME, USERPROFILE and SHADOWGRAPH_HOME into a
// scratch directory; no model is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, readFile, rename, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { CAPTURE_LIMITS, runCapture } from '../src/capture-hook.js';
import { privilegedBindProject, privilegedSnapshot } from '../src/internal/snapshot.js';
import { droppedDirectory, failSpoolEntry, SPOOL_LIMITS, spoolDirectory, spoolEntries, spoolEvent, spoolStatus } from '../src/internal/capture-spool.js';
import { mintOriginId } from '../src/scope.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const CLI = resolve('src/cli.js');

async function setup(t) {
  const root = await scratchDirectory(t, 'shadowgraph-capture-spool-');
  const cwd = join(root, 'work');
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
  const home = join(root, 'home');
  const sgHome = join(root, 'sg-home');
  await mkdir(home);
  await mkdir(sgHome);
  const file = join(root, 'private', 'memory.json');
  await mkdir(dirname(file));
  await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd), project: 'alpha', confirmed: true }));
  const graph = createShadowGraph();
  privilegedBindProject(graph, { type: 'worktree', path: resolve(cwd), project: 'alpha', reason: 'synthetic spool test', surface: 'cli' });
  const store = await createStorage({ type: 'json', file });
  await store.save(privilegedSnapshot(graph));
  store.close?.();
  const capture = { state: 'active', changedAt: '2026-01-01T00:00:00.000Z', evidence: 'synthetic', store: { file, storage: 'json' }, originId: mintOriginId(), coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS }, mcpServerNames: ['shadowgraph'] };
  const activation = join(sgHome, 'activation.json');
  await writeFile(activation, JSON.stringify({ version: 1, capabilities: { capture, delivery: { state: 'active', store: capture.store } } }));
  return { root, cwd, file, home, sgHome, activation, capture, spool: spoolDirectory(activation), env: { HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: sgHome } };
}
const load = async ({ file }) => JSON.parse(await readFile(file, 'utf8'));
const captures = async (s) => (await load(s)).records.filter((item) => item.kind === 'capture');
const texts = async (s) => (await load(s)).captureContent.map((entry) => entry.text);
const prompt = (text, fields = {}) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-1', cwd: '/work', prompt: text, message_id: `msg-${text.length}-${text.slice(0, 12)}`, ...fields });
const capture = (s, input, options = {}) => runCapture({ capture: s.capture, input, deadline: Date.now() + 10_000, record: s.activation, home: s.home, cwd: s.cwd, ...options });

function spawnCli(args, { cwd, env, input = '' }) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:SHADOWGRAPH_|CLAUDE|ANTHROPIC_)/i.test(name)));
  return new Promise((settle, fail) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...base, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (code) => settle({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const hook = (s, input) => spawnCli(['capture', '--hook'], { cwd: s.cwd, env: s.env, input });
const silent = (result, label) => assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', ''], label);
async function processing(s) {
  const result = await spawnCli(['deliver', '--hook'], { cwd: s.cwd, env: s.env, input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'session-1', cwd: s.cwd }) });
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  return JSON.parse(context.split('\n').find((line) => line.startsWith('processing: ')).slice('processing: '.length));
}

// A live writer, as the reviewer's fixture: a separate process holds the
// store's fence and keeps it fresh until it is stopped.
async function holdStore(file) {
  const code = "const fs=require('node:fs');const p=process.argv[1];const fd=fs.openSync(p,'wx',0o600);fs.writeSync(fd,process.pid+':'+Date.now()+':test-lock');process.stdout.write('READY\\n');setInterval(()=>{const d=new Date;fs.utimesSync(p,d,d)},500);";
  const holder = spawn(process.execPath, ['-e', code, `${file}.lock`], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((settle, fail) => {
    let seen = '';
    holder.stdout.on('data', (chunk) => { seen += chunk; if (seen.includes('READY')) settle(); });
    holder.on('error', fail);
    holder.on('exit', (code) => fail(new Error(`holder exited ${code}`)));
  });
  const closed = new Promise((settle) => holder.once('close', settle));
  let released = null;
  // Idempotent: a test may release early and again in its cleanup.
  return () => (released ??= (async () => {
    holder.removeAllListeners('exit');
    holder.kill();
    await closed;
    await unlink(`${file}.lock`).catch(() => {});
  })());
}

test('the reviewer reproducer: a prompt that meets a held store waits in the spool, is reported, and is replayed first after release', { timeout: 60_000 }, async (t) => {
  const s = await setup(t);
  const transcript = join(s.root, 'session.jsonl');
  const lost = 'The unique lost prompt is SEQUOIA_713; preserve its exact rationale.';
  await writeFile(transcript, `${JSON.stringify({ type: 'user', uuid: 'lost-prompt', message: { role: 'user', content: lost } })}\n`);
  const release = await holdStore(s.file);
  t.after(release);
  const before = await readFile(s.file, 'utf8');
  const blocked = await hook(s, prompt(lost, { message_id: 'lost-prompt', transcript_path: transcript }));
  silent(blocked, 'the host sees nothing, whatever the store does');
  assert.ok(blocked.ms < 9_000, `${blocked.ms} ms`);
  assert.equal(await readFile(s.file, 'utf8'), before, 'the held store is not written');
  assert.equal((await spoolStatus(s.spool)).pending, 1, 'the prompt is kept on disk');
  // Delivery, which never writes, says input is waiting.
  const waiting = await processing(s);
  assert.ok(waiting.gaps.includes('capture_input_waiting'), JSON.stringify(waiting));
  assert.equal(waiting.inputWaiting, 1);
  await release();
  // Ordinary work goes on; the next hook replays what waits before its own event.
  await appendFile(transcript, `${JSON.stringify({ type: 'assistant', uuid: 'assistant-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Interim note written while the store was held.' }] } })}\n`);
  silent(await hook(s, JSON.stringify({ hook_event_name: 'Stop', session_id: 'session-1', cwd: '/work', stop_hook_active: false, last_assistant_message: 'Completed ordinary work after contention.', transcript_path: transcript })));
  const items = await captures(s);
  const prompted = items.find((item) => item.source.event === 'UserPromptSubmit');
  const stopped = items.find((item) => item.source.event === 'Stop');
  assert.ok(prompted && stopped, JSON.stringify(items.map((item) => item.source.event)));
  assert.ok(prompted.occurrenceSeq < stopped.occurrenceSeq, 'the session keeps its order');
  assert.ok((await texts(s)).includes(lost), 'the lost prompt is in the store');
  // The cursor was anchored where the transcript ended when the prompt
  // arrived, so the assistant text written meanwhile is read, not skipped.
  assert.ok((await texts(s)).includes('Interim note written while the store was held.'), JSON.stringify(await texts(s)));
  assert.equal((await spoolStatus(s.spool)).pending, 0);
  const after = await processing(s);
  assert.ok(!after.gaps.includes('capture_input_waiting') && !after.gaps.includes('capture_input_dropped'), JSON.stringify(after));
  // A host re-delivery of the same prompt adds nothing.
  const count = (await captures(s)).length;
  silent(await hook(s, prompt(lost, { message_id: 'lost-prompt', transcript_path: transcript })));
  assert.equal((await captures(s)).length, count);
  assert.equal((await spoolStatus(s.spool)).pending, 0);
});

test('a re-delivery while the first copy waits is kept once, and written once', { timeout: 60_000 }, async (t) => {
  const s = await setup(t);
  const release = await holdStore(s.file);
  t.after(release);
  const input = prompt('kept once while the store is held', { message_id: 'once' });
  assert.equal(await capture(s, input, { deadline: Date.now() + 800 }), 'store_busy');
  assert.equal(await capture(s, input, { deadline: Date.now() + 800 }), 'store_busy');
  assert.equal((await spoolEntries(s.spool)).length, 1);
  await release();
  assert.equal(await capture(s, prompt('next', { message_id: 'next' })), 'written');
  assert.deepEqual((await captures(s)).map((item) => item.source.hostEventId), ['once', 'next']);
});

test('a tool call that touches the spool or its loss record is a self-event, not captured', { timeout: 60_000 }, async (t) => {
  const s = await setup(t);
  for (const path of [join(s.spool, 'x.json'), join(droppedDirectory(s.spool), 'y.json')]) {
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'session-1', cwd: '/work', tool_name: 'Read', tool_input: { file_path: path }, tool_response: 'x', tool_use_id: `toolu-${path.length}` });
    assert.equal(await capture(s, input), 'self_event', path);
  }
  assert.equal((await captures(s)).length, 0);
});

test('when neither the spool nor the store can take an event, the loss is recorded and reported, never silent', { timeout: 60_000 }, async (t) => {
  const s = await setup(t);
  // The spool's place is taken by a file, so nothing can be kept there.
  await writeFile(s.spool, 'not a directory');
  const release = await holdStore(s.file);
  t.after(release);
  const outcome = await capture(s, prompt('lost for good', { message_id: 'gone' }), { deadline: Date.now() + 800 });
  assert.equal(outcome, 'store_busy');
  const markers = await readdir(droppedDirectory(s.spool));
  assert.equal(markers.length, 1);
  const marker = JSON.parse(await readFile(join(droppedDirectory(s.spool), markers[0]), 'utf8'));
  assert.equal(marker.reason, 'spool_unwritable:store_busy');
  assert.equal(marker.event, 'UserPromptSubmit');
  assert.ok(!JSON.stringify(marker).includes('lost for good'), 'a marker never holds the material');
  await release();
  const reported = await processing(s);
  assert.ok(reported.gaps.includes('capture_input_dropped'), JSON.stringify(reported));
  assert.equal(reported.inputDropped, 1);
});

test('an entry that keeps failing is dropped with a marker after its attempts, and an expired one likewise', { timeout: 60_000 }, async (t) => {
  const s = await setup(t);
  const kept = await spoolEvent({ spool: s.spool, input: prompt('poison', { message_id: 'poison' }), cwd: s.cwd });
  let entry = kept.entry;
  for (let attempt = 1; attempt < SPOOL_LIMITS.maxAttempts; attempt += 1) entry = await failSpoolEntry(s.spool, entry, 'synthetic');
  assert.equal(entry.attempts, SPOOL_LIMITS.maxAttempts - 1);
  assert.equal(await failSpoolEntry(s.spool, entry, 'synthetic'), null);
  assert.equal((await spoolEntries(s.spool)).length, 0);
  // An entry older than the limit is dropped, not replayed.
  const old = await spoolEvent({ spool: s.spool, input: prompt('too old', { message_id: 'old' }), cwd: s.cwd, now: () => Date.now() - SPOOL_LIMITS.maxAgeMs - 1000 });
  assert.ok(old.kept);
  assert.equal(await capture(s, prompt('fresh', { message_id: 'fresh' })), 'written');
  assert.deepEqual((await captures(s)).map((item) => item.source.hostEventId), ['fresh']);
  const reasons = await Promise.all((await readdir(droppedDirectory(s.spool))).map(async (name) => JSON.parse(await readFile(join(droppedDirectory(s.spool), name), 'utf8')).reason));
  assert.deepEqual(reasons.sort(), ['attempts_exhausted:synthetic', 'expired']);
});

test('a claim a dead hook left returns to the queue and is replayed; a fresh claim is left to its hook', { timeout: 60_000 }, async (t) => {
  const s = await setup(t);
  const stale = (await spoolEvent({ spool: s.spool, input: prompt('claimed by a hook that died', { message_id: 'stale' }), cwd: s.cwd })).entry;
  await rename(join(s.spool, stale.name), join(s.spool, `${stale.name}.claim`));
  const old = new Date(Date.now() - 120_000);
  await utimes(join(s.spool, `${stale.name}.claim`), old, old);
  const live = (await spoolEvent({ spool: s.spool, input: prompt('claimed by a live hook', { message_id: 'live' }), cwd: s.cwd })).entry;
  await rename(join(s.spool, live.name), join(s.spool, `${live.name}.claim`));
  assert.equal((await spoolStatus(s.spool)).pending, 2, 'a claimed entry still counts as waiting');
  assert.equal(await capture(s, prompt('after', { message_id: 'after' })), 'written');
  assert.deepEqual((await captures(s)).map((item) => item.source.hostEventId), ['stale', 'after']);
  assert.equal((await spoolStatus(s.spool)).pending, 1);
});
