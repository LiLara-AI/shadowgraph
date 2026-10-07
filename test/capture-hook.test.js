// Automatic capture's hook (plan v1.4.4 §12.1, §21.3, §22.6.1, §16.4; OD-3; programme plan revision 6 PR-36c; PR-36
// design review D-1, D-2, D-3, D-5, D-12, D-13, D-16, D-17, D-19, D-20): `shadowgraph capture --hook` records each
// event's immediate material into the private store the capture record names, under one hold of its fence, and is
// silent and inert otherwise. HOME, USERPROFILE and SHADOWGRAPH_HOME point into a scratch directory for every run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore, createStorage } from '../src/storage.js';
import { CAPTURE_LIMITS, activeCapture, admissionLimits, observedEvent, renderToolMaterial, runCapture, storeFootprint, superviseCapture, toolOutcome } from '../src/capture-hook.js';
import { privilegedBindProject, privilegedSnapshot } from '../src/internal/snapshot.js';
import { discoverWorkspace } from '../src/internal/access-transport.js';
import { DELIVERY_FRAME, deliveryEndLine } from '../src/internal/delivery-marker.js';
import { mintOriginId } from '../src/scope.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const CLI = resolve('src/cli.js');
const bytes = (value) => JSON.stringify(value);

// A private store holding one project's worktree binding, a working directory bound to it, and an active capture
// record naming the store.
async function setup(t, { project = 'alpha', recorded = true, record = {}, storage = 'json' } = {}) {
  const root = await scratchDirectory(t, 'shadowgraph-capture-hook-');
  const cwd = join(root, 'work');
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
  const home = join(root, 'home');
  const sgHome = join(root, 'sg-home');
  await mkdir(home);
  await mkdir(sgHome);
  const file = join(root, 'private', storage === 'sqlite' ? 'memory.db' : 'memory.json');
  await mkdir(dirname(file));
  if (project) await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd), project, confirmed: true }));
  const graph = createShadowGraph();
  if (project && recorded) privilegedBindProject(graph, { type: 'worktree', path: resolve(cwd), project, reason: 'synthetic capture test', surface: 'cli' });
  const store = await createStorage({ type: storage, file });
  await store.save(privilegedSnapshot(graph));
  store.close?.();
  const capture = { state: 'active', changedAt: '2026-01-01T00:00:00.000Z', evidence: 'synthetic', store: { file, storage }, originId: mintOriginId(), coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS }, mcpServerNames: ['shadowgraph'], ...record };
  const activation = join(sgHome, 'activation.json');
  await writeFile(activation, JSON.stringify({ version: 1, capabilities: { capture } }));
  const env = { HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: sgHome };
  return { root, cwd, file, home, sgHome, activation, capture, env, storage };
}

const load = async ({ file, storage }) => {
  const store = await createStorage({ type: storage, file });
  try { return await store.load(); } finally { store.close?.(); }
};
const items = async (setupResult) => (await load(setupResult)).records.filter((item) => item.kind === 'capture');
const prompt = (text, fields = {}) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-1', cwd: '/work', prompt: text, message_id: 'msg_1', ...fields });
const bash = (command, response, fields = {}) => JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'session-1', cwd: '/work', tool_name: 'Bash', tool_input: { command }, tool_response: response, tool_use_id: 'toolu_1', ...fields });
const capture = (s, input, options = {}) => runCapture({ capture: s.capture, input, deadline: Date.now() + 10_000, record: s.activation, home: s.home, cwd: s.cwd, ...options });

function hook(s, input, args = ['capture', '--hook'], { keepOpen = false, env = {} } = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SHADOWGRAPH_')));
  return new Promise((settle, fail) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { cwd: s.cwd, env: { ...base, ...s.env, ...env } });
    const guard = setTimeout(() => child.kill(), 30_000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (code) => { clearTimeout(guard); settle({ code, stdout, stderr, ms: Date.now() - started }); });
    child.stdin.on('error', () => {});
    if (keepOpen) child.stdin.write(input);
    else child.stdin.end(input);
  });
}
const silent = (result, label) => assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', ''], label);

test('the hook is inert unless the capture record is active, and capture without --hook is a usage error', async (t) => {
  const s = await setup(t);
  const before = bytes(await load(s));
  await writeFile(s.activation, JSON.stringify({ version: 1, capabilities: { capture: { ...s.capture, state: 'deactivated' } } }));
  // Inert even with its input left open: it returns without reading it.
  const held = await hook(s, '', undefined, { keepOpen: true });
  silent(held, 'deactivated');
  assert.ok(held.ms < 2500, `${held.ms} ms: it returned before the input wait of 3 000 ms`);
  await writeFile(s.activation, '{}');
  silent(await hook(s, prompt('hello')), 'no capture record');
  assert.equal(bytes(await load(s)), before, 'nothing written');
  for (const args of [['capture'], ['capture', '--hook', 'extra'], ['capture', '--store', s.file]]) {
    const usage = await hook(s, prompt('hello'), args);
    assert.equal(usage.code, 1, args.join(' '));
    assert.match(usage.stderr, /Usage: shadowgraph capture --hook/u);
  }
  // No variable selects the store: SHADOWGRAPH_FILE is never written.
  const other = join(s.root, 'other.json');
  await writeFile(s.activation, JSON.stringify({ version: 1, capabilities: { capture: s.capture } }));
  silent(await hook(s, prompt('routed'), undefined, { env: { SHADOWGRAPH_FILE: other } }));
  await assert.rejects(stat(other), { code: 'ENOENT' });
  assert.deepEqual((await items(s)).map((item) => item.source.event), ['UserPromptSubmit']);
});

test('a prompt in a worktree whose binding the store recorded is captured under that project, silently', async (t) => {
  const s = await setup(t);
  const result = await hook(s, prompt('Why does the cache miss?', { cwd: resolve('/work/app') }));
  silent(result);
  const [item] = await items(s);
  assert.deepEqual(
    [item.project, item.attribution, item.originId, item.state, item.source.event, item.source.sessionId, item.source.role, item.source.hostEventId, item.sourceIdentity],
    ['alpha', 'project', s.capture.originId, 'pending', 'UserPromptSubmit', 'session-1', 'user', 'msg_1', 'unattributed_observer']
  );
  assert.deepEqual(item.observation, { host: 'claude-code', hostVersion: null, toolName: null, cwd: resolve('/work/app'), outcome: null }, 'observed, never inferred: the event carries no host version');
  const stored = await load(s);
  assert.equal(stored.captureContent.find((entry) => entry.contentRef === item.contentRef).text, 'Why does the cache miss?');
  // A re-delivery of the same message is the same item, and writes nothing.
  const revision = stored.revision;
  silent(await hook(s, prompt('Why does the cache miss?')));
  assert.equal((await load(s)).revision, revision);
  // The store declares it to its project's reads.
  const graph = createShadowGraph();
  graph.importData(await load(s));
  assert.equal(graph.search('', { project: 'alpha' }).completeness.capture.pending, 1);
});

test('a project comes only from a worktree binding the store recorded: a shipped binding or none captures nothing', async (t) => {
  for (const [label, options] of [['a binding the store never recorded', { recorded: false }], ['no binding', { project: null }]]) {
    const s = await setup(t, options);
    const before = bytes(await load(s));
    assert.equal(await capture(s, prompt('hello')), 'project_unresolved', label);
    silent(await hook(s, prompt('hello')), label);
    assert.equal(bytes(await load(s)), before, label);
  }
});

test('coverage decides which resolved projects are captured', async (t) => {
  const excluded = await setup(t, { record: { coverage: { projects: 'all', exclude: ['alpha'] } } });
  assert.equal(await capture(excluded, prompt('hello')), 'not_covered');
  const other = await setup(t, { record: { coverage: { projects: 'only', include: ['beta'] } } });
  assert.equal(await capture(other, prompt('hello')), 'not_covered');
  const named = await setup(t, { record: { coverage: { projects: 'only', include: ['alpha'] } } });
  assert.equal(await capture(named, prompt('hello')), 'written');
  assert.equal((await items(excluded)).length + (await items(other)).length, 0);
});

test('the hook is silent and writes nothing on every path that captures nothing', async (t) => {
  const s = await setup(t);
  const before = bytes(await load(s));
  for (const [label, input] of [
    ['malformed input', '{not json'],
    ['not an object', '[]'],
    ['an event capture does not take', JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'session-1' })],
    ['a PreCompact, a flush trigger until the transcript cursor', JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'session-1', trigger: 'manual' })],
    ['a SessionEnd, likewise', JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'session-1', reason: 'exit' })],
    ['a Stop with no final message', JSON.stringify({ hook_event_name: 'Stop', session_id: 'session-1', stop_hook_active: false })],
    ['a prompt with no text', prompt('   ')],
    ['no session', prompt('hello', { session_id: '' })],
    ['a tool call with no tool name', bash('ls', 'x', { tool_name: '' })]
  ]) silent(await hook(s, input), label);
  assert.equal(bytes(await load(s)), before);
  // A store inside a repository is never written, whatever the record says (§21.3).
  const inside = await setup(t);
  await mkdir(join(dirname(inside.file), '.git'));
  const kept = bytes(await load(inside));
  silent(await hook(inside, prompt('hello')));
  assert.equal(await capture(inside, prompt('hello')), 'store_inside_repository');
  assert.equal(bytes(await load(inside)), kept);
  // A store of a newer schema is left as it is.
  const newer = await setup(t);
  const payload = await load(newer);
  await writeFile(newer.file, JSON.stringify({ ...payload, schemaVersion: payload.schemaVersion + 1 }));
  const newerBytes = await readFile(newer.file, 'utf8');
  assert.equal(await capture(newer, prompt('hello')), 'newer_schema');
  assert.equal(await readFile(newer.file, 'utf8'), newerBytes);
});

test('a tool call is captured as labelled text whose strings keep their line breaks; a delivered block in one is stripped and counted', async (t) => {
  const s = await setup(t);
  const block = `${DELIVERY_FRAME}\nhead: {}\n`;
  const delivered = `${block}${deliveryEndLine(Buffer.byteLength(block))}`;
  const response = { stdout: `before\n${delivered}\nafter`, stderr: '', interrupted: false, exit_code: 0 };
  assert.equal(await capture(s, bash('cat notes.txt', response)), 'written');
  const [item] = await items(s);
  const text = (await load(s)).captureContent.find((entry) => entry.contentRef === item.contentRef).text;
  assert.equal(text, 'tool: Bash\ninput.command:\ncat notes.txt\nresponse.stdout:\nbefore\n\nafter\nresponse.stderr:\n\nresponse.interrupted: false\nresponse.exit_code: 0');
  assert.doesNotMatch(text, /shadowgraph-deliver/u);
  const session = (await load(s)).captureSessions.find((entry) => entry.sessionId === 'session-1');
  assert.deepEqual(session.selfEvents, { 'S-1': { PostToolUse: 1 } }, 'the delivered block is counted as a tool-target self-event (§16.4)');
  assert.equal(item.source.toolCallId, 'toolu_1');
  assert.equal(item.observation.toolName, 'Bash');
  // A failure carries its error as material, never parsed for a status.
  assert.equal(renderToolMaterial({ toolName: 'Edit', toolInput: { file_path: '/a' }, toolResponse: undefined, error: 'exit code 2' }), 'tool: Edit\ninput.file_path:\n/a\nerror:\nexit code 2');
  assert.equal(renderToolMaterial({ toolName: 'Read', toolInput: {}, toolResponse: [] }), 'tool: Read\ninput: {}\nresponse: []');
});

test('an outcome is observed only as a single shell command\'s own success, scoped to that call; any other status is absent', () => {
  const source = { event: 'PostToolUse', toolCallId: 'toolu_1', toolName: 'Bash' };
  const outcome = (command, response, toolName = 'Bash') => toolOutcome({ event: 'PostToolUse', toolCallId: 'toolu_1', toolName, toolInput: { command }, toolResponse: response });
  assert.deepEqual(outcome('npm test', { exit_code: 0 }), { resultClass: 'succeeded', outcomeEvidence: { state: 'observed', source, exitStatus: 0 } });
  // A non-zero exit is not a failure by itself (PR-24): grep, diff, robocopy and wrappers use it for other results.
  for (const [label, command] of [['a single program', 'npm test'], ['grep', 'grep -r needle src'], ['diff', 'diff a b'], ['a wrapper', 'timeout 5 grep x y'], ['sudo', 'sudo grep x /etc/hosts'], ['robocopy', 'robocopy a b'], ['a pipeline', 'npm test | tee log'], ['a list', 'cd app && npm test'], ['a substitution', 'echo $(npm test)']]) {
    assert.deepEqual(outcome(command, { exit_code: 1 }), { outcomeEvidence: { state: 'absent', source } }, label);
  }
  for (const [label, command] of [['a list', 'npm test || true'], ['a pipeline', 'npm test | tee log'], ['a sequence', 'false; true']]) {
    assert.deepEqual(outcome(command, { exit_code: 0 }), { outcomeEvidence: { state: 'absent', source } }, `${label}: its status is another program's`);
  }
  assert.equal(outcome('grep -r needle src', { exit_code: 0 }).resultClass, 'succeeded', 'a match found');
  assert.deepEqual(outcome('npm test', 'plain output'), { outcomeEvidence: { state: 'absent', source } }, 'no status reported');
  assert.deepEqual(outcome('npm test', { exit_code: 1.5 }), { outcomeEvidence: { state: 'absent', source } });
  assert.deepEqual(outcome('npm test', { exit_code: 0 }, 'mcp__other__run'), { outcomeEvidence: { state: 'absent', source: { ...source, toolName: 'mcp__other__run' } } }, 'another tool\'s output is not an exit status');
  assert.equal(toolOutcome({ event: 'PostToolUse', toolCallId: null, toolName: 'Bash', toolInput: { command: 'ls' }, toolResponse: { exit_code: 0 } }), null, 'nothing to scope it to');
  assert.equal(toolOutcome({ event: 'PostToolUse', toolCallId: 't', toolName: 'PowerShell', toolInput: { command: 'Get-Item x' }, toolResponse: { exit_code: 0 } }).resultClass, 'succeeded');
  assert.equal(toolOutcome({ event: 'PostToolUse', toolCallId: 't', toolName: 'PowerShell', toolInput: { command: 'Get-Item x' }, toolResponse: { exit_code: 2 } }).outcomeEvidence.state, 'absent');
});

test('each event maps the host\'s documented fields and infers none', () => {
  assert.deepEqual(observedEvent({ hook_event_name: 'Stop', session_id: 's', last_assistant_message: 'Done.', stop_reason: 'end_turn' }), {
    event: 'Stop', sessionId: 's', cwd: null, role: 'assistant', hostEventId: null, toolCallId: null, toolName: null, toolInput: null, prompt: null, outcome: null, transcriptPath: null, text: 'Done.'
  });
  assert.equal(observedEvent({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'x', message_id: 7 }).hostEventId, null, 'an identifier that is not a string is absent');
  const failure = observedEvent({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', tool_input: { command: 'false' }, tool_use_id: 't', error: 'Command failed' });
  assert.deepEqual([failure.text, failure.outcome], ['tool: Bash\ninput.command:\nfalse\nerror:\nCommand failed', { outcomeEvidence: { state: 'absent', source: { event: 'PostToolUseFailure', toolCallId: 't', toolName: 'Bash' } } }]);
  // An event capture does not take is nothing, whatever fields it carries; so is one without a session.
  for (const event of ['SessionStart', 'Notification', 'SubagentStop']) assert.equal(observedEvent({ hook_event_name: event, session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't', prompt: 'x' }), null, event);
  // PreCompact, SessionEnd and a Stop with no final message carry no material: the transcript cursor's triggers
  // (PR-36), taking only the transcript's path, and only an absolute one to a .jsonl file.
  const transcript = resolve('session.jsonl');
  for (const event of ['PreCompact', 'SessionEnd', 'Stop']) {
    const flush = observedEvent({ hook_event_name: event, session_id: 's', transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't', prompt: 'x' });
    assert.deepEqual(flush, { event, sessionId: 's', cwd: null, role: null, hostEventId: null, toolCallId: null, toolName: null, toolInput: null, prompt: null, outcome: null, transcriptPath: transcript }, event);
  }
  for (const path of ['session.jsonl', resolve('session.json'), '', 7]) assert.equal(observedEvent({ hook_event_name: 'SessionEnd', session_id: 's', transcript_path: path }).transcriptPath, null, String(path));
  for (const sessionId of [undefined, '', '  ', 7]) assert.equal(observedEvent({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'x' }), null, String(sessionId));
});

test('ShadowGraph\'s own tool calls are counted as self-events and record no item', async (t) => {
  const s = await setup(t);
  assert.equal(await capture(s, bash('shadowgraph search {}', 'x')), 'self_event');
  assert.equal(await capture(s, JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'session-1', tool_name: 'mcp__shadowgraph__search', tool_input: {}, tool_response: 'x', tool_use_id: 'toolu_2' })), 'self_event');
  const named = await setup(t, { record: { mcpServerNames: ['memory'] } });
  assert.equal(await capture(named, JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'session-1', tool_name: 'mcp__memory__search', tool_input: {}, tool_response: 'x', tool_use_id: 'toolu_3' })), 'self_event', 'the server names the activation recorded');
  assert.equal(await capture(s, bash(`cat ${s.file.replaceAll('\\', '/')}`, 'x')), 'self_event', 'a touch of the store');
  assert.deepEqual(await items(s), []);
  assert.deepEqual((await load(s)).captureSessions[0].selfEvents, { 'S-1': { PostToolUse: 3 } });
});

test('admission uses the record\'s limits capped by the build\'s, and a refusal inside an open episode writes nothing', async (t) => {
  assert.deepEqual(admissionLimits({ maxStoreBytes: 2 ** 40, maxQueueDepth: 5, maxItemBytes: 2 ** 40, maxItemsPerSession: 2 ** 40 }), { ...CAPTURE_LIMITS, maxQueueDepth: 5 });
  const s = await setup(t, { record: { limits: { ...CAPTURE_LIMITS, maxItemsPerSession: 1 } } });
  assert.equal(await capture(s, prompt('one', { message_id: 'msg_1' })), 'written');
  assert.equal(await capture(s, prompt('two', { message_id: 'msg_2' })), 'refused');
  const held = bytes(await load(s));
  assert.equal(await capture(s, prompt('three', { message_id: 'msg_3' })), 'refused');
  assert.equal(bytes(await load(s)), held, 'the episode is open: nothing written');
  // An item over the build's own item limit is refused, whatever the record says.
  const big = await setup(t, { record: { limits: { ...CAPTURE_LIMITS, maxItemBytes: 2 ** 30 } } });
  assert.equal(await capture(big, prompt('x'.repeat(CAPTURE_LIMITS.maxItemBytes + 1))), 'refused');
  assert.deepEqual(await items(big), []);
});

test('a session another project owns refuses the other project\'s capture through the hook, and declares it', async (t) => {
  const s = await setup(t);
  assert.equal(await capture(s, prompt('in alpha')), 'written');
  // The same session moves to a worktree bound to beta.
  const betaWork = join(s.root, 'beta-work');
  await mkdir(join(betaWork, '.shadowgraph'), { recursive: true });
  await writeFile(join(betaWork, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(betaWork), project: 'beta', confirmed: true }));
  const store = createJsonFileStore(s.file);
  const graph = createShadowGraph();
  graph.importData(await store.load());
  privilegedBindProject(graph, { type: 'worktree', path: resolve(betaWork), project: 'beta', reason: 'synthetic capture test', surface: 'cli' });
  await store.save(privilegedSnapshot(graph));
  assert.equal(await capture(s, prompt('in beta', { message_id: 'msg_2' }), { cwd: betaWork }), 'refused');
  assert.deepEqual((await items(s)).map((item) => item.project), ['alpha']);
  assert.deepEqual((await load(s)).events.filter((entry) => entry.type === 'capture.refused').map((entry) => entry.project), ['beta']);
});

test('the store is entered and left around the work, and a commit starts only with time left for it', async (t) => {
  const s = await setup(t);
  const posts = [];
  assert.equal(await capture(s, prompt('hello'), { post: (message) => posts.push(message) }), 'written');
  assert.deepEqual(posts, ['enter', 'leave']);
  const outside = [];
  assert.equal(await capture(s, '{broken', { post: (message) => outside.push(message) }), 'unreadable');
  assert.deepEqual(outside, [], 'nothing to capture: the store is never entered');
  const before = bytes(await load(s));
  // Too little time for the lock: the store is never entered.
  assert.equal(await capture(s, prompt('late', { message_id: 'msg_8' }), { deadline: Date.now() + 100, post: (message) => outside.push(message) }), 'out_of_time');
  assert.deepEqual(outside, []);
  // Time runs out inside the store: nothing is committed, and the store is left.
  const base = Date.now();
  let entered = false;
  const late = [];
  const clock = () => entered ? base + 900 : base;
  assert.equal(await capture(s, prompt('later', { message_id: 'msg_9' }), { deadline: base + 1000, now: clock, post: (message) => { late.push(message); if (message === 'enter') entered = true; } }), 'out_of_time');
  assert.deepEqual(late, ['enter', 'leave']);
  assert.equal(bytes(await load(s)), before);
});

test('a store the hook cannot read, or cannot lock in time, is left as it is, silently', async (t) => {
  const corrupt = await setup(t);
  await writeFile(corrupt.file, '{not json');
  silent(await hook(corrupt, prompt('hello')), 'unreadable');
  assert.equal(await readFile(corrupt.file, 'utf8'), '{not json');
  // A lock a live process holds (this test's own) is waited for only as long as the deadline allows.
  const locked = await setup(t);
  const before = await readFile(locked.file, 'utf8');
  await writeFile(`${locked.file}.lock`, `${process.pid}:${Date.now()}:held-by-the-test`);
  const result = await hook(locked, prompt('hello'), undefined, { env: { SHADOWGRAPH_CAPTURE_DEADLINE_MS: '1500' } });
  silent(result, 'locked');
  assert.ok(result.ms < 8000, `${result.ms} ms: within the hard cap`);
  assert.equal(await readFile(locked.file, 'utf8'), before);
});

test('every resolved project is captured by default, a Stop included, and a directory outside git\'s work tree is not', async (t) => {
  const s = await setup(t);
  // A second project, bound and recorded in the same store.
  const betaWork = join(s.root, 'beta-work');
  await mkdir(join(betaWork, '.shadowgraph'), { recursive: true });
  await writeFile(join(betaWork, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(betaWork), project: 'beta', confirmed: true }));
  const store = createJsonFileStore(s.file);
  const graph = createShadowGraph();
  graph.importData(await store.load());
  privilegedBindProject(graph, { type: 'worktree', path: resolve(betaWork), project: 'beta', reason: 'synthetic capture test', surface: 'cli' });
  // A git repository whose own `.git` directory is outside its work tree.
  const repo = join(s.root, 'repo');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  const { worktreeRoot } = await discoverWorkspace(repo);
  await mkdir(join(worktreeRoot, '.shadowgraph'));
  await writeFile(join(worktreeRoot, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: worktreeRoot, project: 'gamma', confirmed: true }));
  privilegedBindProject(graph, { type: 'worktree', path: worktreeRoot, project: 'gamma', reason: 'synthetic capture test', surface: 'cli' });
  await store.save(privilegedSnapshot(graph));
  assert.equal(await capture(s, prompt('in alpha')), 'written');
  assert.equal(await capture(s, prompt('in beta', { session_id: 'session-2', message_id: 'msg_2' }), { cwd: betaWork }), 'written');
  assert.equal(await capture(s, JSON.stringify({ hook_event_name: 'Stop', session_id: 'session-2', last_assistant_message: 'Done in beta.' }), { cwd: betaWork }), 'written');
  assert.equal(await capture(s, prompt('in gamma', { session_id: 'session-3', message_id: 'msg_3' }), { cwd: join(worktreeRoot, '.git') }), 'project_unresolved');
  assert.equal(await capture(s, prompt('in gamma', { session_id: 'session-3', message_id: 'msg_3' }), { cwd: worktreeRoot }), 'written', 'the same repository from inside its work tree');
  const captured = await items(s);
  assert.deepEqual(captured.map((item) => [item.project, item.source.event, item.source.role]), [['alpha', 'UserPromptSubmit', 'user'], ['beta', 'UserPromptSubmit', 'user'], ['beta', 'Stop', 'assistant'], ['gamma', 'UserPromptSubmit', 'user']]);
  const stop = captured.find((item) => item.source.event === 'Stop');
  assert.equal((await load(s)).captureContent.find((entry) => entry.contentRef === stop.contentRef).text, 'Done in beta.');
});

test('a burst of hook processes on one store records every event', async (t) => {
  const s = await setup(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => hook(s, prompt(`burst ${index}`, { message_id: `msg_${index}`, session_id: `session-${index}` }))));
  for (const result of results) silent(result);
  assert.equal((await items(s)).length, 8);
  t.diagnostic(`8 parallel captures: slowest ${Math.max(...results.map((result) => result.ms))} ms`);
});

test('a SQLite store is never captured into: a record naming one is inert', async (t) => {
  try { await import('node:sqlite'); } catch { t.skip('node:sqlite is not available'); return; }
  // Delivery reports a SQLite store busy while a capture writes it, so a shared one would lose every delivery at a
  // captured prompt (review C-3); capture is refused there.
  const s = await setup(t, { storage: 'sqlite' });
  assert.equal(await activeCapture(s.env), null);
  const before = bytes(await load(s));
  silent(await hook(s, prompt('into sqlite')));
  assert.equal(bytes(await load(s)), before);
});

test('the store\'s footprint counts its side files and any temporary file a killed save left beside it', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-capture-footprint-');
  const file = join(root, 'memory.json');
  await writeFile(file, 'x'.repeat(10));
  await writeFile(`${file}-wal`, 'x'.repeat(5));
  await writeFile(join(root, '.memory.json.123.456.abc.tmp'), 'x'.repeat(7));
  await writeFile(join(root, 'unrelated.tmp'), 'x'.repeat(100));
  assert.equal(await storeFootprint(file), 22);
});

test('the deadline exits at once outside the store, and waits for a write inside it up to the hard cap', async () => {
  // Generous windows: a loaded machine fires timers late, never early, so each exit is placed by order, not by a
  // tight bound.
  const run = (script, { deadline = 100, hardCap = 600 } = {}) => new Promise((settle) => {
    const worker = new EventEmitter();
    const started = Date.now();
    let exitedAt = null;
    const done = superviseCapture(worker, { deadline: started + deadline, hardCap: started + hardCap, exit: () => { exitedAt ??= Date.now() - started; } });
    script(worker);
    setTimeout(() => { worker.emit('exit'); done.then(() => settle(exitedAt)); }, hardCap + 100);
  });
  const outside = await run(() => {});
  assert.ok(outside >= 95 && outside < 500, `outside the store: exits at the deadline, well before the hard cap (${outside} ms)`);
  const finished = await run((worker) => { worker.emit('message', 'enter'); setTimeout(() => worker.emit('message', 'leave'), 250); });
  assert.ok(finished >= 245 && finished < 590, `inside the store: waits past the deadline for it to leave, and no longer (${finished} ms)`);
  const stuck = await run((worker) => worker.emit('message', 'enter'));
  assert.ok(stuck >= 595, `a write that never leaves is abandoned at the hard cap (${stuck} ms)`);
  const early = await run((worker) => { worker.emit('message', 'enter'); worker.emit('message', 'leave'); });
  assert.ok(early >= 95, `a write that left before the deadline does not bring the exit forward (${early} ms)`);
});

test('a store\'s update loads, changes and writes under one hold of its fence, or writes nothing', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-store-update-');
  const kinds = [['json', join(root, 'data.json')]];
  try { await import('node:sqlite'); kinds.push(['sqlite', join(root, 'data.db')]); } catch {}
  for (const [type, file] of kinds) {
    const store = await createStorage({ type, file });
    await store.save(privilegedSnapshot(createShadowGraph()));
    const start = (await store.load()).revision;
    assert.equal(await store.update(() => null), null, `${type}: null writes nothing`);
    assert.equal(await store.update(() => {}), null, `${type}: nor does a change that returns nothing`);
    assert.equal((await store.load()).revision, start);
    assert.equal((await store.load()).schemaVersion, privilegedSnapshot(createShadowGraph()).schemaVersion, `${type}: the store is as it was`);
    // Parallel updates from separate handles serialise on the fence: none conflicts, none is lost.
    const handles = await Promise.all(Array.from({ length: 4 }, () => createStorage({ type, file })));
    await Promise.all(handles.map((handle, index) => handle.update((current) => {
      const graph = createShadowGraph();
      graph.importData(current);
      graph.addDecision({ project: 'alpha', title: `update ${index}`, chosen: 'x' });
      return privilegedSnapshot(graph);
    })));
    for (const handle of handles) handle.close?.();
    const after = await store.load();
    assert.equal(after.revision, start + 4, type);
    assert.equal(after.records.filter((record) => record.kind === 'decision').length, 4, type);
    store.close?.();
  }
});

test('hook reads registered dedicated worker identity while preserving user sessions', async t => {
  const { randomUUID } = await import('node:crypto');
  const { registerInvocation } = await import('../src/internal/extraction-identity.js');
  const s = await setup(t), at = Date.now();
  const row = { invocationId: randomUUID(), leaseId: randomUUID(), correlationToken: `sgcorr_${randomUUID()}`, from: new Date(at).toISOString(), to: new Date(at + 300000).toISOString() };
  await registerInvocation(row, { env: s.env, now: () => at });
  assert.equal(await capture(s, prompt('own invocation', { session_id: row.invocationId }), { env: s.env }), 'self_event');
  assert.equal((await items(s)).length, 0);
  assert.equal(await capture(s, prompt('ordinary user work', { session_id: 'user-session', tool_use_id: row.invocationId }), { env: s.env }), 'written');
  assert.equal((await items(s)).length, 1);
  assert.equal(await capture(s, prompt(row.correlationToken, { session_id: 'worker-other', message_id: 'm2' }), { env: s.env }), 'self_event');
  assert.equal((await items(s)).length, 1);
});
