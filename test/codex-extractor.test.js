import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCodexInvocation, parseCodexOutput, createCodexExtractor, codexOutputSchema } from '../src/codex-extractor.js';

const schema = { type: 'object', properties: { decision: { type: 'string' } }, required: ['decision'], additionalProperties: false };
const value = { decision: 'Use the reversible fixture method' };
const output = extra => [
  { type: 'thread.started', thread_id: 'synthetic-thread' }, { type: 'turn.started' },
  ...(extra ?? []), { type: 'item.completed', item: { id: 'result', type: 'agent_message', text: JSON.stringify(value) } },
  { type: 'turn.completed', usage: { input_tokens: 21, cached_input_tokens: 4, output_tokens: 8 } }
].map(JSON.stringify).join('\n');

test('Codex extraction has an explicit provider/model and cannot inherit host tools, hooks, project notes or provider keys', () => {
  const request = buildCodexInvocation({ executable: join(tmpdir(), 'codex.exe'), cwd: tmpdir(), schemaFile: join(tmpdir(), 'schema.json'), model: 'gpt-6.1-sol', env: { PATH: 'synthetic', SHADOWGRAPH_FILE: 'private-store', CLAUDE_CODE_USER_EMAIL: 'synthetic@example.invalid' } });
  assert.equal(request.shell, false);
  for (const arg of ['--ignore-user-config', '--ephemeral', '--json', '--output-schema', 'read-only', 'model_provider="openai"', 'features.shell_tool=false', 'features.hooks=false', 'features.apps=false', 'features.plugins=false', 'project_doc_max_bytes=0']) assert.ok(request.args.includes(arg), arg);
  assert.equal(request.env.SHADOWGRAPH_FILE, undefined);
  assert.equal(request.env.CLAUDE_CODE_USER_EMAIL, undefined);
  assert.throws(() => buildCodexInvocation({ executable: join(tmpdir(), 'codex.exe'), cwd: tmpdir(), schemaFile: join(tmpdir(), 'schema.json'), model: 'gpt-6.1-sol', env: { OPENAI_API_KEY: 'synthetic-only' } }), /provider_environment/);
});

test('Codex JSON events preserve structured value and numeric usage', () => {
  const result = parseCodexOutput(output(), schema);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.value, value);
  assert.deepEqual(result.usage, { inputTokens: 21, cacheReadInputTokens: 4, outputTokens: 8 });
});

test('optional evidence spans survive strict output schemas without invented values', () => {
  const optional = { ...schema, properties: { ...schema.properties, note: { type: 'string', minLength: 1 } } };
  const adapted = codexOutputSchema(optional);
  assert.deepEqual(adapted.required, ['decision', 'note']);
  assert.deepEqual(adapted.properties.note, { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] });
  const events = output().split('\n').map(JSON.parse);
  events[2].item.text = JSON.stringify({ ...value, note: null });
  assert.deepEqual(parseCodexOutput(events.map(JSON.stringify).join('\n'), optional).value, value);
  events[2].item.text = JSON.stringify({ decision: null, note: null });
  assert.equal(parseCodexOutput(events.map(JSON.stringify).join('\n'), optional).blockedReason, 'schema_invalid');
});

test('tool execution, missing completion, bad schema and multiple model turns fail closed', () => {
  assert.equal(parseCodexOutput(output([{ type: 'item.completed', item: { type: 'command_execution', command: 'synthetic' } }]), schema).blockedReason, 'unexpected_tool_activity');
  assert.equal(parseCodexOutput(output().split('\n').slice(0, -1).join('\n'), schema).status, 'blocked');
  assert.equal(parseCodexOutput(output(), { ...schema, properties: { decision: { type: 'string', maxLength: 1 } } }).status, 'blocked');
  assert.equal(parseCodexOutput(output() + '\n' + JSON.stringify({ type: 'turn.completed', usage: {} }), schema).status, 'blocked');
});

test('only recognized pre-turn capability warnings are diagnostics; runtime errors remain failures with usage', () => {
  const warning = { type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.' } };
  const lines = output().split('\n');
  lines.splice(1, 0, JSON.stringify(warning));
  const result = parseCodexOutput(lines.join('\n'), schema);
  assert.equal(result.status, 'success');
  assert.equal(result.diagnostics.length, 1);
  assert.equal(parseCodexOutput(output([warning]), schema).blockedReason, 'host_error');
  const failed = parseCodexOutput(output([{ ...warning, item: { ...warning.item, message: 'Unknown failure' } }]), schema);
  assert.equal(failed.status, 'blocked');
  assert.equal(failed.usage.inputTokens, 21);
});

test('case variants of a foreign CODEX_HOME cannot silently select the default account', () => {
  assert.throws(() => buildCodexInvocation({ executable: join(tmpdir(), 'codex.exe'), cwd: tmpdir(), schemaFile: join(tmpdir(), 'schema.json'), env: { Codex_Home: join(tmpdir(), 'foreign-profile') } }), /codex_profile_selected/);
});

test('executor checks identity before sending content, validates response and removes only its own scratch', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sg-codex-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex.exe'); await writeFile(executable, 'synthetic binary');
  const calls = [];
  const runProcess = async request => {
    calls.push(request);
    return { code: 0, stdout: request.args.includes('--version') ? 'codex-cli 0.161.0' : output(), stderr: '', localChildStopped: true, processStarted: true, outputBytes: 100 };
  };
  const options = { executable, env: {}, scratchRoot: root, runProcess, accountSalt: 'a'.repeat(32), accountLookup: async () => ({ type: 'chatgpt', email: 'synthetic@example.invalid' }), model: 'gpt-6.1-sol' };
  const executor = createCodexExtractor(options);
  const checked = await executor.check();
  assert.equal(checked.ok, true);
  assert.equal(checked.provider, 'codex');
  assert.match(checked.accountFingerprint, /^[a-f0-9]{64}$/u);
  const bound = createCodexExtractor({ ...options, expectedReceipt: checked });
  const result = await bound.extract({ prompt: 'Fresh synthetic work material.', schema });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.value, value);
  assert.equal(calls.filter(r => r.args.includes('exec')).length, 1);
  const changed = createCodexExtractor({ ...options, expectedReceipt: checked, accountLookup: async () => ({ type: 'chatgpt', email: 'different@example.invalid' }) });
  assert.equal((await changed.extract({ prompt: 'Must remain local.', schema })).blockedReason, 'activated_account_changed');
  assert.equal(calls.filter(r => r.args.includes('exec')).length, 1);
});

test('API authentication and missing account identity never permit extraction', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sg-codex-auth-')); t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'codex.exe'); await writeFile(executable, 'synthetic');
  for (const account of [{ type: 'apiKey' }, { type: 'chatgpt' }, null]) {
    const executor = createCodexExtractor({ executable, env: {}, scratchRoot: root, runProcess: async () => ({ code: 0, stdout: 'codex-cli 0.161.0' }), accountLookup: async () => account });
    assert.equal((await executor.check()).ok, false);
  }
});
