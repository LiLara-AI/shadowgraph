// Plan v1.4.4 PR-35 (§16.2-§16.6; AC-065, AC-001): who produced an event. A
// ShadowGraph self-event -- one naming its runtime artefacts (S-1), carrying a
// correlation token it minted (S-2), or produced inside its own worker's
// session (S-3) -- is counted on its session and never recorded. An event with
// no signal is captured, marked unattributed_observer: absence never
// excludes. A delivered ShadowGraph block is removed from captured text before
// it becomes raw material, and the removal is counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { runtimeHookCommand } from '../src/host-hooks.js';
import { DELIVERY_CAP_BYTES, DELIVERY_FRAME, deliveryEndLine } from '../src/internal/delivery-marker.js';
import { captureArtefacts, classifyCaptureSource, mintCorrelationToken, stripDeliveredBlocks } from '../src/internal/capture-source.js';
import { downgradeToSchema6 } from '../src/schema-conversion.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { privilegedRecordCapture, privilegedRecordSelfEvent, privilegedSnapshot } from '../src/internal/snapshot.js';

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const bytes = (value) => JSON.stringify(value);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const WIN32 = process.platform === 'win32';
// A synthetic home, outside any real profile directory.
const HOME = WIN32 ? 'D:\\sg\\owner' : '/srv/sg/owner';
const at = (...parts) => join(HOME, ...parts);
// An unquoted path as Git Bash takes it: backslashes there are escapes.
const fwd = (path) => path.replaceAll('\\', '/');
const STORE = at('.shadowgraph', 'memory.json');
const RUNTIME = at('.shadowgraph', 'runtime', '143bbde80190970a00d34265bc8509949f28d2cd');
const DEV_REPO = at('work', 'shadowgraph');
const artefacts = (runtimeDirectory) => ({
  ...captureArtefacts({
    storeFile: STORE,
    runtimeDirectory,
    activationFile: at('.shadowgraph', 'activation.json'),
    markerFiles: [at('work', 'app', '.shadowgraph', 'project-binding.json')]
  }),
  home: HOME
});
const CONTEXT = artefacts(RUNTIME);
// The runtime resolved to the developer's own checkout (npm link, or hooks
// pointed at it).
const DEV_CONTEXT = artefacts(DEV_REPO);
const CAPTURED = { selfEvent: false, sourceIdentity: 'unattributed_observer' };
// Admission (PR-36b) is every capture's: limits no test here reaches.
const ADMISSION = Object.freeze({ limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 2 ** 30, maxItemBytes: 2 ** 40, maxItemsPerSession: 2 ** 30 }, storeBytes: 0 });
const tool = (toolName, toolInput, extra = {}) => ({ event: 'PostToolUse', sessionId: 'session-1', cwd: at('work', 'app'), toolName, toolInput, ...extra });
const bash = (command, extra) => tool('Bash', { command }, extra);
const ps = (command, extra) => tool('PowerShell', { command }, extra);

test('S-1: ShadowGraph\'s own MCP server, binary and runtime artefacts are its own traffic', () => {
  const cases = [
    ['its MCP server', tool('mcp__shadowgraph__shadowgraph_context', { project: 'alpha' })],
    ['its MCP server through a plugin', tool('mcp__plugin_shadowgraph_shadowgraph__shadowgraph_context', { project: 'alpha' })],
    ['its binary', bash('shadowgraph deliver --hook')],
    ['its binary through npx', bash('cd app && npx shadowgraph context')],
    ['its binary through npx with a flag and a version', bash('npx -y shadowgraph@0.41.0 context')],
    ['its binary through pnpm dlx', bash('pnpm dlx shadowgraph context')],
    ['its binary through npm exec', bash('npm exec -- shadowgraph context')],
    ['its binary after an assignment', bash('SHADOWGRAPH_FILE=x shadowgraph search "" ')],
    ['its binary through env', bash('env SHADOWGRAPH_FILE=x shadowgraph search x')],
    ['its binary in a substitution', bash('echo $(shadowgraph context)')],
    ['its binary after a background job', bash('sleep 1 & shadowgraph context')],
    ['its binary after a heredoc', bash('cat <<EOF\nnotes\nEOF\nshadowgraph context')],
    ['its binary in PowerShell', tool('PowerShell', { command: 'shadowgraph context --project alpha' })],
    ['its pinned runtime, as the hook runs it', bash(runtimeHookCommand(RUNTIME))],
    ['its pinned runtime through the call operator', tool('PowerShell', { command: `& node "${join(RUNTIME, 'src', 'cli.js')}" deliver --hook` })],
    ['its pinned runtime\'s MCP server', bash(`node ${fwd(join(RUNTIME, 'src', 'mcp.js'))}`)],
    ['its pinned runtime run directly', bash(`"${join(RUNTIME, 'src', 'cli.js')}" context`)],
    ['a read of its store', tool('Read', { file_path: STORE })],
    ['a read of its store lock', tool('Read', { file_path: `${STORE}.lock` })],
    ['a SQLite side file', tool('Read', { file_path: `${STORE}-wal` })],
    ['a JSON restore\'s rollback file', tool('Read', { file_path: at('.shadowgraph', '.restore.3f9a.rollback') })],
    ['a SQLite restore\'s staged file', tool('Read', { file_path: at('.shadowgraph', '.memory.json.3f9a.restore') })],
    ['a save\'s temporary file', tool('Read', { file_path: at('.shadowgraph', '.memory.json.4242.1767225600000.k3j.tmp') })],
    ['its activation record', tool('Read', { file_path: at('.shadowgraph', 'activation.json') })],
    ['a binding marker', tool('Read', { file_path: at('work', 'app', '.shadowgraph', 'project-binding.json') })],
    ['a grep of its store', tool('Grep', { pattern: 'x', path: STORE })],
    ['its store in a command', bash(`cat ${fwd(STORE)}`)],
    ['its store quoted in a command', bash(`cat "${STORE}"`)],
    ['its store as an option value', bash(`node tool.js --file=${fwd(STORE)}`)],
    ['its store named in an assignment', bash(`SHADOWGRAPH_FILE=${fwd(STORE)} node other.js`)],
    ['its store from home', bash('cat ~/.shadowgraph/memory.json')],
    ['its store from $HOME', bash('cat $HOME/.shadowgraph/memory.json')],
    ['its store from ${HOME}', bash('cat ${HOME}/.shadowgraph/memory.json')],
    ['its store from a double-quoted $HOME', bash('cat "$HOME/.shadowgraph/memory.json"')],
    ['its store relative to the working directory', tool('Read', { file_path: join('..', '..', '.shadowgraph', 'memory.json') })],
    ['its binary from its package', bash('npx -p shadowgraph-unified-plugin shadowgraph context')],
    ['its binary from its package, named inline', bash('npx --package=shadowgraph-unified-plugin shadowgraph context')],
    ['its binary after a comment', bash('# check the store first\nshadowgraph context')],
    ['its binary after a PowerShell here-string', ps("git commit -m @'\nDon't strip.\n'@\nshadowgraph context")],
    ['its binary after a PowerShell comment', ps('# check the store first\nshadowgraph context')],
    ['its binary after a word with a hash', bash('echo "issue"#12; shadowgraph context')],
    ['its binary after a tab-indented heredoc', bash('cat <<-EOF\n\tnotes\n\tEOF\nshadowgraph context')],
    ['its binary after a here-string', bash('grep x <<<"notes"\nshadowgraph context')],
    ['its binary after an escaped PowerShell quote', ps('echo "say `"hi`""; shadowgraph context')],
    ['its binary after a commit through "$(cat <<EOF)"', bash('git commit -m "$(cat <<\'EOF\'\nSay "hi\nEOF\n)" && shadowgraph context')],
    ['its binary quoted and invoked in PowerShell', ps('& "D:/tools/shadowgraph" context')],
    ['its binary quoted and dot-invoked in PowerShell', ps('. "D:/tools/shadowgraph" context')]
  ];
  if (WIN32) cases.push(
    ['its binary in another case, with its extension', bash('ShadowGraph.CMD context')],
    ['its store in another case', tool('Read', { file_path: STORE.toUpperCase() })],
    ['its store as Git Bash spells it', bash('cat /d/sg/owner/.shadowgraph/memory.json')],
    ['its store from %USERPROFILE%', tool('PowerShell', { command: 'type %USERPROFILE%\\.shadowgraph\\memory.json' })],
    ['its store from $env:USERPROFILE', tool('PowerShell', { command: 'Get-Content $env:USERPROFILE\\.shadowgraph\\memory.json' })],
    ['its store from Git Bash\'s $USERPROFILE', bash('cat $USERPROFILE/.shadowgraph/memory.json')],
    ['its store behind the long-path prefix', tool('Read', { file_path: `\\\\?\\${STORE}` })]
  );
  for (const [label, event] of cases) assert.deepEqual(classifyCaptureSource(event, CONTEXT), { selfEvent: true, signal: 'S-1' }, label);
  // Running the checkout's CLI is running ShadowGraph, when the checkout is
  // the installed runtime.
  assert.deepEqual(classifyCaptureSource(bash('node src/cli.js context', { cwd: DEV_REPO }), DEV_CONTEXT), { selfEvent: true, signal: 'S-1' });
});

// The false-exclusion check (§16.6): a user developing ShadowGraph is a user.
test('no signal is no exclusion: developing ShadowGraph itself is captured', () => {
  const cases = [
    ['node --test in a repository named shadowgraph', bash('node --test', { cwd: DEV_REPO })],
    ['npm test there', bash('cd shadowgraph && npm test', { cwd: at('work') })],
    ['an edit of src/shadowgraph.js', tool('Edit', { file_path: join(DEV_REPO, 'src', 'shadowgraph.js'), old_string: 'a', new_string: 'b' })],
    ['a read of a file named for it', tool('Read', { file_path: join(DEV_REPO, 'shadowgraph.json') })],
    ['the development CLI', bash('node src/cli.js context', { cwd: DEV_REPO })],
    ['a server merely named like it', tool('mcp__shadowgraph-dev__search', { query: 'x' })],
    ['a plugin server merely named like it', tool('mcp__plugin_tools_notshadowgraph__search', { query: 'x' })],
    ['a prompt', { event: 'UserPromptSubmit', sessionId: 'session-1', cwd: DEV_REPO }],
    ['a turn that mentions it', { event: 'Stop', sessionId: 'session-1', cwd: DEV_REPO, toolInput: { text: 'shadowgraph deliver --hook' } }],
    // Prose and data inside a command are not commands (review BLK-1).
    ['a commit message naming it', bash('git commit -m "Fix recall; shadowgraph now returns scores"')],
    ['a single-quoted commit message naming it', bash("git commit -m 'Fix recall; shadowgraph now returns scores'")],
    ['a PowerShell message with an escaped quote', ps('git commit -m "Say `"hi`"; shadowgraph now returns scores"')],
    ['a commit message through a heredoc', bash('git commit -F - <<\'EOF\'\nShadowGraph now tells its own traffic apart.\nshadowgraph deliver stays inert.\nEOF')],
    ['docs written through a heredoc', bash('cat > docs/usage.md <<\'EOF\'\nshadowgraph context --project alpha\nEOF')],
    ['an echo of a pipe', bash('echo "a | shadowgraph b"')],
    ['a grep for it', bash('grep -E "foo|shadowgraph" README.md')],
    ['a commit message naming its store', bash('git commit -m "Move the store; now at ~/.shadowgraph/memory.json"')],
    ['a note naming its store through a heredoc', bash('cat >> NOTES.md <<EOF\nThe store lives at ~/.shadowgraph/memory.json now\nEOF')],
    // Files beside the runtime are read and edited, not run (review MAJ-1).
    ['a read of the installed runtime\'s docs', tool('Read', { file_path: join(RUNTIME, 'docs', 'api-reference.md') })],
    ['an edit of the installed runtime\'s CLI', tool('Edit', { file_path: join(RUNTIME, 'src', 'cli.js'), old_string: 'a', new_string: 'b' })],
    ['git in the installed runtime', bash(`cd "${RUNTIME}" && git log`)],
    ['a sibling of the installed runtime', bash(`node "${join(`${RUNTIME}-old`, 'src', 'cli.js')}" context`)],
    // Only path fields are targets, never the data a tool writes (review MIN-1).
    ['an edit that writes its store\'s path', tool('Edit', { file_path: at('work', 'app', 'notes.md'), old_string: 'x', new_string: STORE })],
    ['a write whose content is its activation path', tool('Write', { file_path: at('work', 'app', 'config.md'), content: at('.shadowgraph', 'activation.json') })],
    // PowerShell is read by its own rules: here-strings, '' and a literal
    // backslash (re-review NEW-1), in the commit form its tool prescribes.
    ['a PowerShell here-string commit naming it', ps("git commit -m @'\nDon't strip text.\nShadowGraph now tells its own traffic apart.\n'@")],
    ['a PowerShell here-string naming its store', ps("git commit -m @'\nIt's moved.\nThe store now lives at ~/.shadowgraph/memory.json\n'@")],
    ['a PowerShell expandable here-string', ps('git commit -m @"\nQuote "recall\nshadowgraph context stays inert\n"@')],
    ['a PowerShell path ending in a backslash', ps('Copy-Item x "D:\\dest\\" ; git commit -m "Fix recall; shadowgraph now returns scores"')],
    ...[
      '- `shadowgraph deactivate delivery` never asks.',
      '- `shadowgraph uninstall-hooks` removes ShadowGraph\'s handlers',
      'ShadowGraph metadata. VAR-04 labels the register.',
      'what it costs in real work; ShadowGraph as the answer;'
    ].map((line) => [`a commit line: ${line}`, ps(`git commit -m @'\nDon't prompt.\n${line}\n'@`)]),
    // A launcher's option value is not its program (re-review NEW-2).
    ['npm with a prefix named for it', bash('npm --prefix shadowgraph test')],
    ['npm with a prefix path named for it', bash('npm --prefix ~/work/shadowgraph test')],
    ['pnpm in a folder named for it', bash('pnpm -C shadowgraph test')],
    ['pnpm filtered to it', bash('pnpm --filter shadowgraph build')],
    ['yarn in a folder named for it', bash('yarn --cwd shadowgraph test')],
    ['an npm workspace named for it', bash('npm -w shadowgraph test')],
    ['bun in a folder named for it', bash('bun --cwd shadowgraph test')],
    ['npx with a package named for it', bash('npx -p shadowgraph other-tool')],
    ['a package script named for it (declared: no exec, no run)', bash('yarn shadowgraph')],
    ['another scope\'s package', bash('npx @someone/shadowgraph')],
    // Comments, every heredoc delimiter, escapes and quoted home paths
    // (re-review NEW-3).
    ['a comment naming it', bash('# build first (shadowgraph needs node 22)\nnpm run build')],
    ['a comment naming its store', bash('# never touch ~/.shadowgraph/memory.json here\nnpm test')],
    ['a heredoc with an escaped delimiter', bash('cat > docs/usage.md <<\\EOF\nshadowgraph context --project alpha\nEOF')],
    ['a heredoc with a quoted delimiter', bash("cat > docs/usage.md <<'END-DOC'\nshadowgraph context\nEND-DOC")],
    ['an escaped quote outside quotes', bash(`echo It\\'s done && git commit -m "Don't break; shadowgraph now returns scores"`)],
    ['a grep for its quoted home path', bash('grep -rn "~/.shadowgraph/memory.json" docs/')],
    ['a search for its single-quoted $HOME path', bash("rg '$HOME/.shadowgraph/memory.json' test/")],
    ['an unclosed quote', bash('echo "unclosed; shadowgraph context')],
    ['a PowerShell comment', ps('# shadowgraph context\nGet-ChildItem')],
    ['a PowerShell block comment', ps('<# first; shadowgraph context #> Get-ChildItem')],
    // Round 3 (briefs/PR35-re-review-2.md): a here-document inside "$(...)",
    // quoted PowerShell values, launcher option values, typographic quotes.
    ['a commit message through "$(cat <<EOF)" with a lone quote', bash('git commit -m "$(cat <<\'EOF\'\nSay "hi\nshadowgraph context\nEOF\n)"')],
    ['a multi-line quoted word first in its command', bash('"see the repository at\nhttps://example.com/work/shadowgraph" > notes.txt')],
    ['a PowerShell here-string piped on', ps("@'\nSee the repository:\nhttps://example.com/work/shadowgraph\n'@ | Set-Content docs/links.md")],
    ['a PowerShell quoted path piped on', ps('"D:\\work\\shadowgraph" | Set-Clipboard')],
    ['a PowerShell quoted URL piped on', ps('"see https://example.com/work/shadowgraph" | Out-File notes.txt')],
    ['a PowerShell single-quoted path piped on', ps("'D:/work/shadowgraph' | Set-Location")],
    ['npm exec in a workspace named for it', bash('npm exec -w shadowgraph -- vitest run')],
    ['npm exec with a prefix named for it', bash('npm exec --prefix shadowgraph -- eslint .')],
    ['npx in a workspace named for it', bash('npx -w shadowgraph vitest')],
    ['npx with a prefix named for it', bash('npx --prefix shadowgraph eslint .')],
    ['a PowerShell commit with typographic quotes', ps('git commit -m \u201cFix recall; shadowgraph now returns scores\u201d')]
  ];
  if (!WIN32) cases.push(['another program of that name in another case', bash('ShadowGraph --render img.png')]);
  for (const [label, event] of cases) assert.deepEqual(classifyCaptureSource(event, CONTEXT), CAPTURED, label);
  for (const [label, event] of [
    ['an edit of src/shadowgraph.js', tool('Edit', { file_path: join(DEV_REPO, 'src', 'shadowgraph.js'), old_string: 'a', new_string: 'b' })],
    ['node --test', bash('node --test', { cwd: DEV_REPO })],
    ['one test file', bash('node --test test/capture-source.test.js', { cwd: DEV_REPO })],
    ['a read of the CLI', tool('Read', { file_path: join(DEV_REPO, 'src', 'cli.js') })]
  ]) assert.deepEqual(classifyCaptureSource(event, DEV_CONTEXT), CAPTURED, `runtime at the checkout: ${label}`);
});

test('S-2: a correlation token ShadowGraph minted marks its own invocation; S-3: its worker\'s session is its own', () => {
  const token = mintCorrelationToken();
  assert.match(token, /^sgcorr_[0-9a-f-]{36}$/);
  const withToken = bash(`claude -p --append-system-prompt ${token} summarise`);
  const without = bash('claude -p summarise');
  const minted = { ...CONTEXT, correlationTokens: [token] };
  assert.deepEqual(classifyCaptureSource(withToken, minted), { selfEvent: true, signal: 'S-2' });
  assert.deepEqual(classifyCaptureSource({ event: 'UserPromptSubmit', sessionId: 'worker', prompt: `Summarise. ${token}` }, minted), { selfEvent: true, signal: 'S-2' }, 'the prompt is its invocation\'s argument');
  assert.deepEqual(classifyCaptureSource(without, minted), CAPTURED);
  assert.deepEqual(classifyCaptureSource(withToken, CONTEXT), CAPTURED, 'a token nobody minted marks nothing');
  // Arguments only: output that shows the token is the user's own (review MIN-6).
  assert.deepEqual(classifyCaptureSource(bash('ps aux', { toolResponse: { stdout: `claude -p ${token}` } }), minted), CAPTURED);
  // A token too short to be one ShadowGraph minted marks nothing.
  assert.deepEqual(classifyCaptureSource(bash('echo sgcorr_short'), { ...CONTEXT, correlationTokens: ['', 'sgcorr_short'] }), CAPTURED);
  // Deep input is walked without recursion and within a bound (review MIN-4).
  let deep = { note: token };
  for (let depth = 0; depth < 20000; depth += 1) deep = { deep };
  assert.deepEqual(classifyCaptureSource(tool('Task', deep), minted), CAPTURED, 'past the bound nothing is read, so the event is captured');
  const worker = { ...without, sessionId: 'worker-session-7' };
  assert.deepEqual(classifyCaptureSource(worker, { ...CONTEXT, observedAt: NOW, workerInvocations: [{ invocationId: 'worker-session-7', leaseId: 'own-lease', from: NOW, to: '2026-01-01T00:05:00.000Z' }] }), { selfEvent: true, signal: 'S-3' });
  assert.deepEqual(classifyCaptureSource(worker, CONTEXT), CAPTURED);
});

test('the classifier takes what it is given: nothing malformed throws, and every command is read in one pass', () => {
  for (const [event, context] of [
    [null, CONTEXT], [undefined, undefined], [bash('x'), null],
    [bash('cat ~/.shadowgraph/memory.json'), { ...CONTEXT, home: 7, correlationTokens: 'sgcorr_not_a_list', workerSessionIds: 'worker-session-7', artefactPaths: [null, 3], mcpServerNames: 'shadowgraph' }]
  ]) assert.doesNotThrow(() => classifyCaptureSource(event, context));
  assert.deepEqual(classifyCaptureSource({ ...bash('x'), sessionId: 'work' }, { ...CONTEXT, workerSessionIds: 'worker-session-7' }), CAPTURED, 'a session list that is a string matches nothing');
  // Linear whatever the command (re-review NEW-4: an unclosed quote followed
  // by escaped quotes was quadratic).
  const size = 256 * 1024;
  const fill = (unit) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const started = performance.now();
  for (const command of [`echo "${fill('\\"')}`, fill('"a\\" '), fill('cat <<A\n'), fill("'"), fill('echo a/b ; '), fill('npm -x '), fill('@\'\n')]) {
    for (const shell of ['Bash', 'PowerShell']) classifyCaptureSource(tool(shell, { command }), CONTEXT);
  }
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `${Math.round(elapsed)} ms`);
});

// §16.3, AC-065: a self-event is a bounded counter on its session, never a
// capture item, record, journal entry or retry key.
test('a self-event only counts, and the count stays one record however many arrive', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'Cache', chosen: 'redis' });
  privilegedRecordCapture(graph, { admission: ADMISSION, project: 'alpha', originId: 'origin-a', text: 'a prompt', source: { event: 'UserPromptSubmit', sessionId: 'session-1' } });
  const before = privilegedSnapshot(graph);
  const counted = privilegedRecordSelfEvent(graph, { project: 'alpha', originId: 'origin-a', signal: 'S-1', source: { event: 'PostToolUse', sessionId: 'session-1' } });
  assert.deepEqual(counted, { 'S-1': { PostToolUse: 1 } });
  const after = privilegedSnapshot(graph);
  for (const collection of ['records', 'facts', 'relations', 'journal', 'idempotency', 'events', 'captureContent']) assert.equal(bytes(after[collection]), bytes(before[collection]), collection);
  assert.deepEqual(after.captureSessions[0].selfEvents, { 'S-1': { PostToolUse: 1 } });
  assert.equal(after.captureSessions[0].occurrenceSeqHighWater, 1, 'a self-event takes no ordinal');
  for (let index = 0; index < 10000; index += 1) {
    privilegedRecordSelfEvent(graph, { project: 'alpha', originId: 'origin-a', signal: ['S-1', 'S-2', 'S-3'][index % 3], source: { event: ['PostToolUse', 'Stop'][index % 2], sessionId: 'session-1' } });
  }
  const many = privilegedSnapshot(graph);
  for (const collection of ['records', 'journal', 'idempotency']) assert.equal(many[collection].length, before[collection].length, collection);
  assert.equal(many.captureSessions.length, 1);
  const counters = many.captureSessions[0].selfEvents;
  assert.deepEqual(Object.keys(counters).sort(), ['S-1', 'S-2', 'S-3']);
  for (const signal of Object.keys(counters)) assert.deepEqual(Object.keys(counters[signal]).sort(), ['PostToolUse', 'Stop'], 'a fixed set of counters');
  assert.equal(Object.values(counters).flatMap(Object.values).reduce((sum, value) => sum + value, 0), 10001);
  assert.ok(bytes(many.captureSessions[0]).length < 400, 'constant size, not growing as records');
  // A self-event never decides whose work follows: a session it opened takes
  // the owner of its first capture, and a purge of that project reaches it
  // (review MIN-8).
  privilegedRecordSelfEvent(graph, { project: 'beta', originId: 'origin-a', signal: 'S-1', source: { event: 'PostToolUse', sessionId: 'session-2' } });
  const later = privilegedRecordCapture(graph, { admission: ADMISSION, project: 'gamma', originId: 'origin-a', text: 'x', source: { event: 'UserPromptSubmit', sessionId: 'session-2' } });
  assert.deepEqual([later.project, later.occurrenceSeq], ['gamma', 1]);
  const reowned = privilegedSnapshot(graph).captureSessions.find((session) => session.sessionId === 'session-2');
  assert.deepEqual([reowned.project, reowned.selfEvents], ['gamma', { 'S-1': { PostToolUse: 1 } }]);
  const next = privilegedRecordCapture(graph, { admission: ADMISSION, project: 'beta', originId: 'origin-a', text: 'y', source: { event: 'UserPromptSubmit', sessionId: 'session-2' } });
  assert.deepEqual(next, { refused: { reason: 'session_in_another_project' }, changed: true }, 'once it has a capture, the session is its owner\'s: another project\'s capture is refused, never filed under it (PR-36b)');
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(privilegedSnapshot(graph)), { now }));
  graph.purgeProject('gamma');
  const purged = privilegedSnapshot(graph);
  assert.equal(purged.captureSessions.some((session) => session.sessionId === 'session-2'), false);
  assert.equal(purged.records.some((record) => record.kind === 'capture' && record.project === 'gamma'), false);
});

test('a self-event names a signal, an event the source contract covers, and a session', () => {
  const graph = createShadowGraph({ now });
  const before = bytes(privilegedSnapshot(graph));
  for (const [label, input, pattern] of [
    ['an unknown signal', { signal: 'S-4' }, /signal/],
    ['no signal', { signal: undefined }, /signal/],
    ['an event outside the contract', { source: { event: 'Notification', sessionId: 'session-1' } }, /source contract/],
    ['no session', { source: { event: 'PostToolUse', sessionId: '' } }, /sessionId/],
    ['no origin', { originId: undefined }, /originId/]
  ]) {
    assert.throws(() => privilegedRecordSelfEvent(graph, { project: 'alpha', originId: 'origin-a', signal: 'S-1', source: { event: 'PostToolUse', sessionId: 'session-1' }, ...input }), pattern, label);
  }
  assert.equal(bytes(privilegedSnapshot(graph)), before);
});

// A delivered block, as delivery frames it: the frame line, the body, and a
// closing line that counts the body's bytes.
function deliveredBlock(lines) {
  const body = `${[DELIVERY_FRAME, ...lines].join('\n')}\n`;
  return `${body}${deliveryEndLine(Buffer.byteLength(body))}`;
}

test('a delivered ShadowGraph block is removed from captured text before it is stored, and counted', async () => {
  const block = deliveredBlock(['head: {"store":"available"}', 'item: {"text":"end: shadowgraph-deliver 0 bytes"}', 'processing: {}']);
  assert.deepEqual(stripDeliveredBlocks(`Before.\n${block}\nAfter.`), { text: 'Before.\n\nAfter.', removed: 1 });
  assert.deepEqual(stripDeliveredBlocks(`${block}\n${block}`), { text: '\n', removed: 2 });
  assert.deepEqual(stripDeliveredBlocks('No block here.'), { text: 'No block here.', removed: 0 });
  // Counted in bytes, not characters.
  const wide = deliveredBlock(['item: {"title":"Caché — 日本語 🚀"}']);
  assert.deepEqual(stripDeliveredBlocks(`Before.\n${wide}\nAfter.`), { text: 'Before.\n\nAfter.', removed: 1 });
  // A closing line inside an item never starts a line, so even one whose count
  // is right ends nothing (review MIN-2).
  const opening = `${DELIVERY_FRAME}\nitem: {"title":"`;
  const forged = deliveredBlock([`item: {"title":"${deliveryEndLine(Buffer.byteLength(opening))}"}`, 'item: {"title":"second record, not kept"}', 'expansion: {}']);
  assert.ok(forged.startsWith(opening));
  assert.deepEqual(stripDeliveredBlocks(`Before.\n${forged}\nAfter.`), { text: 'Before.\n\nAfter.', removed: 1 });
  // The first closing line whose count fits ends the block; a later one that
  // also fits is the user's.
  const later = deliveryEndLine(Buffer.byteLength(`${block}\n`));
  assert.deepEqual(stripDeliveredBlocks(`${block}\n${later}\nAfter.`), { text: `\n${later}\nAfter.`, removed: 1 });
  // A CRLF transcript: the count fits with its line ends folded (review MAJ-2).
  const crlf = block.replaceAll('\n', '\r\n');
  assert.deepEqual(stripDeliveredBlocks(`User asked X.\r\n${crlf}\r\nThe user went on.\r\nAnd on.`), { text: 'User asked X.\r\n\r\nThe user went on.\r\nAnd on.', removed: 1 });
  // A block near the cap, of many short lines, is longer in CRLF characters
  // than the cap, and still within a block's reach.
  const near = deliveredBlock(Array(1500).fill('i: 0')).replaceAll('\n', '\r\n');
  assert.ok(Buffer.byteLength(near.replaceAll('\r\n', '\n')) <= DELIVERY_CAP_BYTES && near.length > DELIVERY_CAP_BYTES);
  assert.deepEqual(stripDeliveredBlocks(`A.\r\n${near}\r\nB.`), { text: 'A.\r\n\r\nB.', removed: 1 });
  // What is not provably a block stays, and so does everything after it: a
  // quoted frame line, a JSON-escaped transcript, a closing line beyond any
  // block's reach, a developer reading ShadowGraph's own source.
  for (const [label, text] of [
    ['a quoted frame line', `Keep this.\n${DELIVERY_FRAME}\nhead: {}\nend: shadowgraph-deliver 9 bytes\nand this`],
    ['a closing line that does not start a line', (() => { const lead = `${DELIVERY_FRAME} quoted, then `; return `Keep.\n${lead}${deliveryEndLine(Buffer.byteLength(lead))}\nAfter.`; })()],
    ['a JSON-escaped transcript', `${JSON.stringify({ type: 'attachment', content: `User asked X.\n${block}` })}\n${JSON.stringify({ type: 'user', content: 'The user went on.' })}`],
    ['a closing line beyond reach', (() => { const body = `${DELIVERY_FRAME}\n${'x'.repeat(2 * DELIVERY_CAP_BYTES)}\n`; return `${body}${deliveryEndLine(Buffer.byteLength(body))}\nAfter.`; })()],
    ['the frame\'s own source', await readFile(new URL('../src/internal/delivery-marker.js', import.meta.url), 'utf8')],
    ['the delivery tests', await readFile(new URL('./deliver.test.js', import.meta.url), 'utf8')]
  ]) assert.deepEqual(stripDeliveredBlocks(text), { text, removed: 0 }, label);
  // Through the writer: every block removed is counted, and none is stored.
  const graph = createShadowGraph({ now });
  const item = privilegedRecordCapture(graph, { admission: ADMISSION, project: 'alpha', originId: 'origin-a', text: `The assistant said.\n${block}\nThen it went on.\n${wide}`, source: { event: 'Stop', sessionId: 'session-1', turnIndex: 1 } });
  const snapshot = privilegedSnapshot(graph);
  assert.equal(snapshot.captureContent[0].text, 'The assistant said.\n\nThen it went on.\n');
  assert.equal(JSON.stringify(snapshot).includes(DELIVERY_FRAME), false, 'no delivered text is stored anywhere');
  assert.equal(item.contentHash, sha256('The assistant said.\n\nThen it went on.\n'));
  assert.deepEqual(snapshot.captureSessions[0].selfEvents, { 'S-1': { Stop: 2 } });
});

test('a session with counters passes the capture floor: restore, purge and downgrade', () => {
  const graph = createShadowGraph({ now });
  privilegedRecordSelfEvent(graph, { project: 'alpha', originId: 'origin-a', signal: 'S-2', source: { event: 'PostToolUse', sessionId: 'session-1' } });
  privilegedRecordSelfEvent(graph, { originId: 'origin-b', signal: 'S-1', source: { event: 'Stop', sessionId: 'session-9' } });
  const snapshot = privilegedSnapshot(graph);
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(snapshot), { now }));
  assert.deepEqual(downgradeToSchema6(snapshot, { now }).report.excludedEntryCounts, { captureSessions: 2 });
  // The counters are operational metadata, carried as they are: an unreadable
  // count restarts, and a member this build does not know is kept untouched.
  const odd = structuredClone(snapshot);
  odd.captureSessions[1].selfEvents = { 'S-1': { Stop: -7 }, 'S-9': 'a later build\'s' };
  const reloaded = createShadowGraph({ now });
  reloaded.importData(odd);
  assert.deepEqual(privilegedRecordSelfEvent(reloaded, { originId: 'origin-b', signal: 'S-1', source: { event: 'Stop', sessionId: 'session-9' } }), { 'S-1': { Stop: 1 }, 'S-9': 'a later build\'s' });
  graph.purgeProject('alpha');
  assert.deepEqual(privilegedSnapshot(graph).captureSessions.map((session) => session.originId), ['origin-b']);
});
