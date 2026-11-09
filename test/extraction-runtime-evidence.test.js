// The runtime-evidence profile (2026-10-27): a Claude Code 2.x host newer than
// the pinned profiles extracts with a model the owner selected, only with no
// managed policy present, and only when the host's own stream shows the
// confined session the flags asked for. An empty remote cache is no policy.
// No real host or model is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createExtractor, confinedResult, inspectPolicy } from '../src/extractor.js';
import { CURRENT_EXTRACTION_MODELS, EXTRACTION_MODEL, RUNTIME_EVIDENCE_PROFILE, hostProfileFor, modelSelectable } from '../src/internal/extraction-contract.js';
import { validExecutorReceipt } from '../src/internal/extraction-state.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const SCHEMA = { type: 'object', properties: { claims: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 100 } } }, required: ['claims'], additionalProperties: false };
const HELP = '--safe-mode --tools --setting-sources --settings --strict-mcp-config --mcp-config --disable-slash-commands --no-session-persistence --session-id --json-schema --model --output-format --system-prompt --verbose';
const AUTH = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', apiKeySource: null, email: 'synthetic-owner@example.invalid' };
const DOCTOR = 'Managed settings (remote): not fetched — requires an Enterprise or Team subscription';
const MODEL = 'claude-haiku-5-5';
const VERSION = '2.1.302';
const result = (value) => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
// The stream a confined 2.1.302 session printed in the 2026-10-27 probe, shape for shape.
function stream({ init = {}, events = [], final = {} } = {}) {
  return [
    { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [], model: MODEL, apiKeySource: 'none', claude_code_version: VERSION, permissionMode: 'default', slash_commands: [], skills: [], agents: ['claude'],
      plugins: [{ name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' }], ...init },
    { type: 'system', subtype: 'thinking_tokens' },
    { type: 'assistant', message: { content: [{ type: 'thinking' }, { type: 'tool_use', name: 'StructuredOutput', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    ...events,
    { type: 'result', subtype: 'success', is_error: false, num_turns: 2, structured_output: { claims: ['bounded observation'] },
      modelUsage: { [MODEL]: { inputTokens: 2, outputTokens: 30, provider: 'firstParty' } }, ...final }
  ].map((event) => JSON.stringify(event)).join('\n');
}
async function fixture(t, overrides = {}) {
  const root = await scratchDirectory(t, 'shadowgraph-evidence-');
  const executable = join(root, process.platform === 'win32' ? 'host.exe' : 'host');
  await writeFile(executable, 'fake host binary');
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    if (request.args.includes('--version')) return result(`${overrides.version ?? VERSION} (Claude Code)`);
    if (request.args.includes('--help')) return result(overrides.help ?? HELP);
    if (request.args.includes('auth')) return result(AUTH);
    if (request.args.includes('doctor')) return result(DOCTOR);
    return result(overrides.output ?? stream());
  };
  const env = { HOME: root, USERPROFILE: root, PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' };
  const make = (options = {}) => createExtractor({ executable, env, scratchRoot: root, runProcess: runner, inspectPolicy: async () => overrides.policy ?? { ok: true, sources: [] }, ...options });
  return { root, executable, calls, make };
}

test('a 2.x host past the pinned profiles takes the runtime-evidence profile; 3.x and older hosts take none', () => {
  assert.equal(hostProfileFor('2.1.302'), RUNTIME_EVIDENCE_PROFILE);
  assert.equal(hostProfileFor('2.9.0'), RUNTIME_EVIDENCE_PROFILE);
  assert.ok(hostProfileFor('2.1.288') && !hostProfileFor('2.1.288').runtimeEvidence, 'a pinned profile stays itself');
  for (const version of ['2.1.287', '3.0.0', '2.1', 'latest', undefined]) assert.equal(hostProfileFor(version), null, String(version));
  assert.equal(hostProfileFor('2.1.302', { '2.1.288': {} }), null, 'a caller-supplied list has no fallback');
  for (const model of CURRENT_EXTRACTION_MODELS) assert.ok(modelSelectable(RUNTIME_EVIDENCE_PROFILE, model));
  assert.ok(!modelSelectable(RUNTIME_EVIDENCE_PROFILE, EXTRACTION_MODEL), 'the old traced model is not offered on a new host');
  assert.ok(!modelSelectable(hostProfileFor('2.1.288'), MODEL), 'nor a new model on a pinned host');
});

test('the selected model runs on a current host with stream evidence, and the receipt names profile and model', async (t) => {
  const s = await fixture(t);
  const check = await s.make({ model: MODEL }).check();
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.model, MODEL);
  assert.equal(check.hostProfile, RUNTIME_EVIDENCE_PROFILE.id);
  assert.equal(check.configurationProfile, 'subscription-unmanaged-safe-mode-runtime-evidence-v1');
  const out = await s.make({ model: MODEL }).extract({ prompt: 'p', schema: SCHEMA });
  assert.equal(out.status, 'success', JSON.stringify(out));
  assert.equal(out.receipt.model, MODEL);
  assert.equal(out.receipt.runtimeEvidence, 'confined_session_verified');
  const invocation = s.calls.at(-1).args;
  const after = (flag) => invocation[invocation.indexOf(flag) + 1];
  assert.equal(after('--model'), MODEL);
  assert.equal(after('--output-format'), 'stream-json');
  assert.ok(invocation.includes('--verbose'));
  assert.deepEqual(JSON.parse(after('--settings')).availableModels, [MODEL]);
  assert.equal(after('--tools'), '');
  // Without an explicit current model a new host is refused before any call.
  assert.equal((await s.make().check()).blockedReason, 'model_not_selectable');
});

test('a host without the stream switch is refused on the runtime-evidence profile', async (t) => {
  const s = await fixture(t, { help: HELP.replace(' --verbose', '') });
  assert.equal((await s.make({ model: MODEL }).check()).blockedReason, 'restriction_switch_unavailable');
});

test('any sign of an unconfined session discards the output', async (t) => {
  const cases = [
    ['a tool beyond the structured one', { init: { tools: ['StructuredOutput', 'Bash'] } }],
    ['an MCP server', { init: { mcp_servers: [{ name: 'x', status: 'connected' }] } }],
    ['a slash command', { init: { slash_commands: ['review'] } }],
    ['a skill', { init: { skills: ['deep-research'] } }],
    ['a key route', { init: { apiKeySource: 'ANTHROPIC_API_KEY' } }],
    ['another model', { init: { model: 'claude-opus-5-5' } }],
    ['another host version', { init: { claude_code_version: '2.1.303' } }],
    ['a plugin that is not built in', { init: { plugins: [{ name: 'p', path: 'C:/plugins/p' }] } }],
    // Absent is not empty (review of the route, 2026-10-27, finding 4).
    ...['tools', 'mcp_servers', 'slash_commands', 'skills', 'plugins'].map((field) => [`no ${field} field`, { init: { [field]: undefined } }]),
    ['a hook that ran', { events: [{ type: 'system', subtype: 'hook_started', hook_event: 'SessionStart' }] }],
    ['a tool call', { events: [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }] }],
    ['another provider', { final: { modelUsage: { [MODEL]: { inputTokens: 1, provider: 'bedrock' } } } }]
  ];
  for (const [label, shape] of cases) {
    const s = await fixture(t, { output: stream(shape) });
    const out = await s.make({ model: MODEL }).extract({ prompt: 'p', schema: SCHEMA });
    assert.equal(out.status, 'blocked', label);
    assert.equal(out.blockedReason, 'runtime_confinement_unverified', label);
  }
  // No init, two results, a non-JSON line.
  assert.equal(confinedResult(stream().split('\n').slice(1).join('\n'), { model: MODEL, hostVersion: VERSION }).blockedReason, 'runtime_confinement_unverified');
  assert.equal(confinedResult(`${stream()}\n${stream().split('\n').at(-1)}`, { model: MODEL, hostVersion: VERSION }).blockedReason, 'runtime_confinement_unverified');
  assert.equal(confinedResult(`${stream()}\nnot json`, { model: MODEL, hostVersion: VERSION }).blockedReason, 'unrecognised_response');
});

test('the host may update in place on the runtime-evidence profile; a pinned profile still needs a new activation', async (t) => {
  const s = await fixture(t);
  const receipt = await s.make({ model: MODEL }).check();
  const moved = await fixture(t, { version: '2.1.305', output: stream({ init: { claude_code_version: '2.1.305' } }) });
  const executor = createExtractor({ executable: moved.executable, env: { HOME: moved.root, USERPROFILE: moved.root, PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' }, scratchRoot: moved.root,
    runProcess: async (request) => (request.args.includes('--version') ? result('2.1.305 (Claude Code)') : request.args.includes('--help') ? result(HELP) : request.args.includes('auth') ? result(AUTH) : request.args.includes('doctor') ? result(DOCTOR) : result(stream({ init: { claude_code_version: '2.1.305' } }))),
    inspectPolicy: async () => ({ ok: true, sources: [] }), expectedReceipt: { ...receipt, executable: (await moved.make({ model: MODEL }).check()).executable } });
  assert.equal((await executor.extract({ prompt: 'p', schema: SCHEMA })).status, 'success');
  // A different selected model is a different activation.
  const other = createExtractor({ executable: s.executable, env: { HOME: s.root, USERPROFILE: s.root, PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' }, scratchRoot: s.root,
    runProcess: async (request) => (request.args.includes('--version') ? result(`${VERSION} (Claude Code)`) : request.args.includes('--help') ? result(HELP) : request.args.includes('auth') ? result(AUTH) : request.args.includes('doctor') ? result(DOCTOR) : result(stream())),
    inspectPolicy: async () => ({ ok: true, sources: [] }), expectedReceipt: { ...receipt, model: 'claude-sonnet-5-5' }, model: MODEL });
  assert.equal((await other.extract({ prompt: 'p', schema: SCHEMA })).blockedReason, 'activated_executor_changed');
});

test('an empty remote cache is no policy source; any larger cache, or any other source, still blocks', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-evidence-policy-');
  const home = join(root, 'home');
  await mkdir(join(home, '.claude'), { recursive: true });
  const cache = join(home, '.claude', 'remote-settings.json');
  const policy = (extra = []) => inspectPolicy({ env: { USERPROFILE: home, HOME: home }, platform: 'win32', policyPaths: extra, registry: async () => [] });
  for (const bytes of ['{}', '\uFEFF{}', '{}\r\n']) {
    await writeFile(cache, bytes);
    const found = await policy();
    assert.equal(found.ok, true, JSON.stringify(bytes));
    assert.equal(found.remoteCacheEmpty, true);
  }
  for (const bytes of ['{"":0}', '{"env":{}}', '{"permissions":{"deny":["Bash"]}}']) {
    await writeFile(cache, bytes);
    const found = await policy();
    assert.equal(found.blockedReason, 'managed_policy_present', bytes);
    assert.deepEqual(found.sources, ['remote-settings.json']);
  }
  await writeFile(cache, '{}');
  const system = join(root, 'managed-settings.json');
  await writeFile(system, '{}');
  assert.equal((await policy([system])).blockedReason, 'managed_policy_present', 'a system policy file blocks on existence alone, whatever its size');
});

test('an activation receipt is valid only with its profile, a selectable model and the profile name it ran under', () => {
  const base = { ok: true, executable: join(process.cwd(), 'host.exe'), binarySha256: 'a'.repeat(64), hostVersion: VERSION, model: MODEL, hostProfile: RUNTIME_EVIDENCE_PROFILE.id,
    restrictions: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`E-${i + 1}`, true])), accountFingerprint: 'b'.repeat(64), accountSalt: 'c'.repeat(32) };
  assert.ok(validExecutorReceipt(base));
  assert.ok(!validExecutorReceipt({ ...base, model: EXTRACTION_MODEL }));
  assert.ok(!validExecutorReceipt({ ...base, hostProfile: undefined }), 'a new host without its profile name');
  assert.ok(!validExecutorReceipt({ ...base, hostVersion: '2.1.288' }), 'a pinned host with the evidence profile name');
  assert.ok(!validExecutorReceipt({ ...base, hostVersion: '3.0.0' }));
});

test('a Claude activation on the runtime-evidence profile runs the quoted recipe, with corrections and source-context decisions', async () => {
  const { extractionPrompt, extractionSchema, prepareExtraction } = await import('../src/internal/extraction-output.js');
  const { QUOTED_RECIPE } = await import('../src/internal/extraction-contract.js');
  const quoted = { provider: 'claude', recipe: QUOTED_RECIPE };
  const item = { id: 'cap', source: { role: 'user' } };
  const source = 'Correction: use the regex parser instead of parseFloat, because parseFloat stops at the comma in 7,5.';
  assert.match(extractionPrompt(item, source, quoted), /copy exact source wording/u);
  assert.ok(extractionSchema('claude', QUOTED_RECIPE).properties.records.items.properties.correction);
  const candidate = { recordId: 'old', priorChosen: 'Use parseFloat for hour cells.', expectedHash: 'a'.repeat(64) };
  const value = { records: [{ kind: 'decision', fields: [{ name: 'chosen', text: source, sourceRef: 'cap' }], correction: { recordId: 'old', priorChosen: candidate.priorChosen, statement: source } }] };
  const prepared = prepareExtraction(item, source, value, { ...quoted, correctionCandidates: [candidate] });
  assert.equal(prepared.records[0].correction.recordId, 'old');
  // Without the recipe the Claude route is unchanged.
  assert.doesNotMatch(extractionPrompt(item, source, { provider: 'claude' }), /copy exact source wording/u);
});

test('on the Claude route a later user correction supersedes the earlier decision it names, and the receipt keeps the selected model', async (t) => {
  const { createShadowGraph } = await import('../src/shadowgraph.js');
  const { createStorage } = await import('../src/storage.js');
  const { privilegedRecordCapture, privilegedSnapshot } = await import('../src/internal/snapshot.js');
  const { claimCapture, commitCapture } = await import('../src/internal/extraction-worker.js');
  const { QUOTED_RECIPE, CODEX_PROMPT_VERSION } = await import('../src/internal/extraction-contract.js');
  const root = await scratchDirectory(t, 'shadowgraph-evidence-correction-');
  const binding = { provider: 'claude', accountFingerprint: 'a'.repeat(64), setupId: '12ab5678-1234-1234-1234-123456789012' };
  const options = { type: 'json', file: join(root, 'memory.json'), env: { SHADOWGRAPH_HOME: root }, project: 'csv', provider: 'claude', recipe: QUOTED_RECIPE, model: MODEL, extractionBinding: binding };
  const graph = createShadowGraph();
  const admission = { limits: { maxStoreBytes: 2 ** 24, maxQueueDepth: 100, maxItemBytes: 65536, maxItemsPerSession: 100 }, storeBytes: 0 };
  const record = (text, sessionId) => privilegedRecordCapture(graph, { project: 'csv', originId: 'csv-origin', text, source: { event: 'UserPromptSubmit', sessionId, role: 'user', hostEventId: sessionId },
    observation: { host: 'claude-code', hostVersion: null, toolName: null, cwd: null, outcome: null, extractionBinding: binding }, admission });
  const first = 'We will parse the hour cells with parseFloat.';
  const second = 'Correction: parse the hour cells with the comma-decimal regex parser instead of parseFloat, because parseFloat stops at the comma.';
  record(first, 's1');
  const store = await createStorage(options); await store.save(privilegedSnapshot(graph)); store.close();
  const receipt = { invocationStarted: true, model: MODEL };
  const one = await claimCapture(options);
  assert.equal((await commitCapture(options, one, { status: 'success', receipt, value: { records: [{ kind: 'decision', fields: [{ name: 'chosen', text: first, sourceRef: one.id }] }] } })).status, 'committed');
  const reopened = await createStorage(options); const payload = await reopened.load();
  // The second capture joins the store the first extraction left.
  const merged = createShadowGraph(); merged.importData(payload);
  privilegedRecordCapture(merged, { project: 'csv', originId: 'csv-origin', text: second, source: { event: 'UserPromptSubmit', sessionId: 's2', role: 'user', hostEventId: 's2' },
    observation: { host: 'claude-code', hostVersion: null, toolName: null, cwd: null, outcome: null, extractionBinding: binding }, admission });
  await reopened.save(privilegedSnapshot(merged)); reopened.close();
  const two = await claimCapture(options);
  assert.equal(two.correctionCandidates.length, 1, 'the earlier decision is offered as a candidate');
  const [candidate] = two.correctionCandidates;
  const committed = await commitCapture(options, two, { status: 'success', receipt, value: { records: [{ kind: 'decision', fields: [{ name: 'chosen', text: second, sourceRef: two.id }],
    correction: { recordId: candidate.recordId, priorChosen: candidate.priorChosen, statement: second } }] } });
  assert.equal(committed.status, 'committed');
  const data = await (async () => { const s = await createStorage(options); try { return await s.load(); } finally { s.close(); } })();
  const decisions = data.records.filter((row) => row.kind === 'decision');
  const old = decisions.find((row) => row.id === candidate.recordId), fresh = decisions.find((row) => row.id !== candidate.recordId);
  assert.equal(old.status, 'superseded');
  assert.equal(fresh.correction.recordId, old.id);
  const extracted = data.records.find((row) => row.id === two.id);
  assert.equal(extracted.receipts.at(-1).model, MODEL);
  assert.equal(extracted.receipts.at(-1).promptVersion, CODEX_PROMPT_VERSION);
});

// Live proof 2026-10-27, case C2: an Arabic decision the claim checks could not
// structure was kept verbatim as a memory, and a later English correction had
// nothing to supersede. The user's own verbatim decision is now a candidate.
const ROUNDING_CORRECTION = 'Correction to the rounding decision: round invoice amounts with Number(amount.toFixed(2)) instead of Math.round(amount * 100) / 100, because Math.round(amount * 100) / 100 rounds 1.005 down to 1 in our tests.';
async function verbatimCorrection(t, arabic, chosen, { correction = ROUNDING_CORRECTION, fields = (id) => [{ name: 'chosen', text: correction, sourceRef: id }] } = {}) {
  const { createShadowGraph } = await import('../src/shadowgraph.js');
  const { createStorage } = await import('../src/storage.js');
  const { privilegedRecordCapture, privilegedSnapshot } = await import('../src/internal/snapshot.js');
  const { claimCapture, commitCapture } = await import('../src/internal/extraction-worker.js');
  const { QUOTED_RECIPE } = await import('../src/internal/extraction-contract.js');
  const root = await scratchDirectory(t, 'shadowgraph-evidence-verbatim-correction-');
  const binding = { provider: 'claude', accountFingerprint: 'a'.repeat(64), setupId: '12ab5678-1234-1234-1234-123456789012' };
  const options = { type: 'json', file: join(root, 'memory.json'), env: { SHADOWGRAPH_HOME: root }, project: 'inv', provider: 'claude', recipe: QUOTED_RECIPE, model: MODEL, extractionBinding: binding };
  const admission = { limits: { maxStoreBytes: 2 ** 24, maxQueueDepth: 100, maxItemBytes: 65536, maxItemsPerSession: 100 }, storeBytes: 0 };
  const capture = (graph, text, sessionId, role) => privilegedRecordCapture(graph, { project: 'inv', originId: 'inv-origin', text,
    source: { event: role === 'user' ? 'UserPromptSubmit' : 'Stop', sessionId, role, hostEventId: `${sessionId}-${role}` },
    observation: { host: 'claude-code', hostVersion: null, toolName: null, cwd: null, outcome: null, extractionBinding: binding }, admission });
  const save = async (graph) => { const store = await createStorage(options); await store.save(privilegedSnapshot(graph)); store.close(); };
  const load = async () => { const store = await createStorage(options); try { return await store.load(); } finally { store.close(); } };
  const receipt = { invocationStarted: true, model: MODEL };
  const echo = 'Rounding invoice amounts with Math.round(amount * 100) / 100 is noted.';
  const graph = createShadowGraph();
  capture(graph, arabic, 's1', 'user'); capture(graph, echo, 's1', 'assistant');
  await save(graph);
  // The fields the extractor proposed live (evidence/live/B2E/diag/replay-C1.json):
  // partial Arabic quotes the checks do not establish, so the user's whole
  // message is kept verbatim as a memory.
  const first = await claimCapture(options);
  assert.equal((await commitCapture(options, first, { status: 'success', receipt, value: { records: [{ kind: 'decision', fields: [
    { name: 'title', text: 'قرار لهذا المشروع', sourceRef: first.id }, { name: 'chosen', text: chosen, sourceRef: first.id },
    { name: 'reason', text: 'لأنه أبسط ولا يحتاج مكتبة', sourceRef: first.id }] }] } })).status, 'committed');
  const reply = await claimCapture(options);
  assert.equal((await commitCapture(options, reply, { status: 'success', receipt, value: { records: [{ kind: 'memory', fields: [{ name: 'text', text: echo, sourceRef: reply.id }] }] } })).status, 'committed');
  let data = await load();
  const verbatim = data.records.find((row) => row.kind === 'memory' && row.text === arabic);
  assert.ok(verbatim, 'the Arabic decision is kept verbatim as a memory');
  const assistantMemory = data.records.find((row) => row.kind === 'memory' && row.text === echo);
  assert.ok(assistantMemory);
  const merged = createShadowGraph(); merged.importData(data);
  capture(merged, correction, 's2', 'user');
  await save(merged);
  const second = await claimCapture(options);
  assert.deepEqual(second.correctionCandidates.map((candidate) => candidate.recordId), [verbatim.id], 'only the user\'s own verbatim decision is offered');
  assert.equal(second.correctionCandidates[0].priorChosen, arabic);
  const [candidate] = second.correctionCandidates;
  assert.equal((await commitCapture(options, second, { status: 'success', receipt, value: { records: [{ kind: 'decision', fields: fields(second.id),
    correction: { recordId: candidate.recordId, priorChosen: candidate.priorChosen, statement: correction } }] } })).status, 'committed');
  data = await load();
  const fresh = data.records.find((row) => row.correction?.recordId === verbatim.id);
  assert.ok(fresh, 'the correction names the verbatim memory');
  assert.equal(data.records.find((row) => row.id === assistantMemory.id).status, 'active', 'an assistant memory is untouched');
  const reader = createShadowGraph(); reader.importData(data);
  const read = reader.context({ project: 'inv', query: 'rounding invoice amounts Math.round', compact: false }).relevant.items;
  const states = Object.fromEntries(read.map((item) => [item.record.id, item.temporalEvidence?.currentState?.state]));
  return { data, verbatim, fresh, closed: data.records.find((row) => row.id === verbatim.id), states, reader };
}
const CHOSEN = 'نقرّب مبالغ الفواتير إلى سنتين باستخدام Math.round(amount * 100) / 100 لأنه أبسط ولا يحتاج مكتبة.';

test('a user correction of a decision kept verbatim as a memory is linked, not applied; the memory stays current, marked as corrected', async (t) => {
  const arabic = `قرار لهذا المشروع: ${CHOSEN}`;
  const { fresh, closed, states, reader } = await verbatimCorrection(t, arabic, CHOSEN);
  assert.equal(closed.status, 'active');
  assert.equal(closed.supersededBy, undefined);
  assert.equal(closed.text, arabic, 'the memory keeps its text');
  assert.equal(fresh.correction.applied, false);
  assert.match(fresh.correction.limitation, /kept verbatim/);
  assert.equal(states[fresh.id], 'current');
  assert.equal(states[closed.id], 'current');
  const read = reader.context({ project: 'inv', query: 'rounding invoice amounts Math.round', compact: true }).relevant.items;
  const memory = read.find((item) => (item.record?.id ?? item.line?.recordId) === closed.id);
  assert.deepEqual(memory.correctedBy, [fresh.id], 'every read names the correcting decision');
  const { operation, scope, ...handle } = memory.line?.expansion ?? memory.expansion;
  const expanded = reader.expand({ ...handle, project: scope.project });
  assert.equal(expanded.status, 'current');
  assert.deepEqual(expanded.correctedBy, [fresh.id], 'and so does its expansion');
  const { t1Line } = await import('../src/compact-tier.js');
  assert.match(t1Line(fresh, { ceiling: 2048 }).line, new RegExp(`not applied: "${closed.id}" stays current, marked as corrected`));
});

// Independent review: a correction of one statement closed a memory that also
// held a standing instruction, which retrieval then lost, whatever separated
// the two. Nothing the correction does not name is closed.
test('a correction never closes what else a verbatim message says', async (t) => {
  for (const rest of [' احتفظ بسجلات التدقيق لمدة 90 يومًا.', '؛ واحتفظ بسجلات التدقيق لمدة 90 يومًا.', 'Keep audit logs for 90 days.']) {
    await t.test(JSON.stringify(rest), async (st) => {
      const { closed, states } = await verbatimCorrection(st, `قرار لهذا المشروع: ${CHOSEN}${rest}`, CHOSEN);
      assert.equal(closed.status, 'active');
      assert.equal(states[closed.id], 'current', 'the standing instruction stays retrievable');
    });
  }
});

// Final-candidate check F1 (host simulated, Sonnet): the English correction's
// fields failed the claim checks (dots in DD.MM.YYYY), so the correction was
// itself kept verbatim and dropped its link. It now keeps the link, unapplied.
test('a correction kept verbatim itself still links what it corrects, and closes nothing', async (t) => {
  const correction = "Correction to the date decision: show invoice dates as DD.MM.YYYY instead of YYYY-MM-DD, because our customers' accounting software only imports DD.MM.YYYY. Update the Dates section of README.md to say this, nothing else.";
  const dates = 'نعرض تواريخ الفواتير بصيغة YYYY-MM-DD لأنها لا تلتبس على أي عميل.';
  const { fresh, closed, reader } = await verbatimCorrection(t, `قرار لهذا المشروع: ${dates} سجّل ذلك في README.md تحت عنوان "Dates" فقط.`, dates, { correction, fields: (id) => [
    { name: 'chosen', text: correction.slice(0, correction.indexOf(' Update')), sourceRef: id },
    { name: 'reason', text: "because our customers' accounting software only imports DD.MM.YYYY", sourceRef: id }] });
  assert.equal(fresh.kind, 'memory', 'the correction itself is kept verbatim');
  assert.equal(fresh.text, correction);
  assert.equal(fresh.correction.applied, false);
  assert.equal(closed.status, 'active');
  const memory = reader.context({ project: 'inv', query: 'invoice dates YYYY-MM-DD', compact: true }).relevant.items
    .find((item) => (item.record?.id ?? item.line?.recordId) === closed.id);
  assert.equal(memory.temporalEvidence.currentState.state, 'current');
  assert.deepEqual(memory.correctedBy, [fresh.id]);
  // Once the correcting memory is deleted, nothing names the target as corrected.
  reader.applyMemoryPlan({ project: 'inv', originId: fresh.originId, operations: [{ action: 'DELETE', memoryType: fresh.memoryType, key: fresh.key, scope: fresh.scope }] });
  assert.equal(reader.exportData({ project: 'inv' }).records.find((row) => row.id === fresh.id)?.status ?? 'invalidated', 'invalidated');
  const after = reader.context({ project: 'inv', query: 'invoice dates YYYY-MM-DD', compact: true }).relevant.items
    .find((item) => (item.record?.id ?? item.line?.recordId) === closed.id);
  assert.equal(after.correctedBy, undefined);
});

// Live proof run 3, case Cx2: the candidate read was cut to four before it was
// filtered, and earlier corrections from another setup, sharing the words
// "Correction ... decision ... instead of", filled every place. The user's own
// decision, kept verbatim, ranked sixth and was never offered.
test('a correction is offered its target even when ineligible records share more words with it', async (t) => {
  const { createShadowGraph } = await import('../src/shadowgraph.js');
  const { createStorage } = await import('../src/storage.js');
  const { privilegedRecordCapture, privilegedSnapshot } = await import('../src/internal/snapshot.js');
  const { claimCapture, commitCapture } = await import('../src/internal/extraction-worker.js');
  const { QUOTED_RECIPE } = await import('../src/internal/extraction-contract.js');
  const root = await scratchDirectory(t, 'shadowgraph-evidence-candidate-read-');
  const binding = { provider: 'claude', accountFingerprint: 'a'.repeat(64), setupId: '12ab5678-1234-1234-1234-123456789012' };
  const options = { type: 'json', file: join(root, 'memory.json'), env: { SHADOWGRAPH_HOME: root }, project: 'inv', provider: 'claude', recipe: QUOTED_RECIPE, model: MODEL, extractionBinding: binding };
  const admission = { limits: { maxStoreBytes: 2 ** 24, maxQueueDepth: 100, maxItemBytes: 65536, maxItemsPerSession: 100 }, storeBytes: 0 };
  const capture = (graph, text, sessionId) => privilegedRecordCapture(graph, { project: 'inv', originId: 'inv-origin', text,
    source: { event: 'UserPromptSubmit', sessionId, role: 'user', hostEventId: sessionId },
    observation: { host: 'claude-code', hostVersion: null, toolName: null, cwd: null, outcome: null, extractionBinding: binding }, admission });
  const save = async (graph) => { const store = await createStorage(options); await store.save(privilegedSnapshot(graph)); store.close(); };
  const load = async () => { const store = await createStorage(options); try { return await store.load(); } finally { store.close(); } };
  const receipt = { invocationStarted: true, model: MODEL };
  const graph = createShadowGraph();
  // Decisions with no capture of this setup behind them: never candidates.
  for (const subject of ['rounding', 'formatting', 'date', 'currency', 'discount', 'tax']) {
    graph.addDecision({ project: 'inv', title: 'Correction to the invoice number decision', chosen: `Correction to the invoice number decision: number invoices with the ${subject} prefix instead of INV-2026-0001, because the tax office portal rejects the INV- prefix.` });
  }
  const arabic = 'قرار لهذا المشروع: نرقّم الفواتير بالصيغة INV-2026-0001 لأن قسم المحاسبة يفرزها بهذا الشكل.';
  capture(graph, arabic, 's1');
  await save(graph);
  const first = await claimCapture(options);
  assert.equal((await commitCapture(options, first, { status: 'success', receipt, value: { records: [{ kind: 'decision', fields: [
    { name: 'chosen', text: 'نرقّم الفواتير بالصيغة INV-2026-0001', sourceRef: first.id }] }] } })).status, 'committed');
  const data = await load();
  // Kept as a decision or verbatim as a memory, it is the one record the correction may name.
  const [targetId] = data.records.find((row) => row.id === first.id).producedRecordIds;
  const verbatim = data.records.find((row) => row.id === targetId);
  assert.ok(['decision', 'memory'].includes(verbatim?.kind));
  const merged = createShadowGraph(); merged.importData(data);
  const correction = 'Correction to the invoice number decision: number invoices as 2026/0001 instead of INV-2026-0001, because the tax office portal rejects the INV- prefix.';
  const ranked = merged.context({ project: 'inv', query: correction, limit: 10, compact: false }).relevant.items.map((item) => item.record.id);
  assert.ok(ranked.indexOf(verbatim.id) >= 4, `the target ranks below four ineligible records (rank ${ranked.indexOf(verbatim.id) + 1})`);
  capture(merged, correction, 's2');
  await save(merged);
  const second = await claimCapture(options);
  assert.deepEqual(second.correctionCandidates.map((candidate) => candidate.recordId), [verbatim.id]);
});
