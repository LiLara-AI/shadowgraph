import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInvocation, createExtractor, inspectPolicy, runBounded, validateSchemaValue, EXTRACTION_MODEL, EXTRACTOR_LIMITS } from '../src/extractor.js';

import { scratchDirectory } from '../tools/scratch-directory.js';

const SCHEMA = { type: 'object', properties: { claims: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 100 } } }, required: ['claims'], additionalProperties: false };
const HELP = '--safe-mode --tools --setting-sources --settings --strict-mcp-config --mcp-config --disable-slash-commands --no-session-persistence --session-id --json-schema --model --output-format --system-prompt';
const AUTH = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', apiKeySource: null };
const DOCTOR = 'Managed settings (remote): not fetched — requires an Enterprise or Team subscription';
const successful = { type: 'result', subtype: 'success', is_error: false, structured_output: { claims: ['bounded observation'] }, modelUsage: { 'claude-opus-5': { inputTokens: 12, outputTokens: 8 } } };
const result = (value, extra = {}) => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '', ...extra });
async function fixture(t, overrides = {}) {
  const root = await scratchDirectory(t, 'shadowgraph-executor-');
  const executable = join(root, process.platform === 'win32' ? 'host.exe' : 'host');
  await writeFile(executable, 'fake host binary');
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    if (request.args.includes('--version')) return result(overrides.version ?? '2.1.288 (Claude Code)');
    if (request.args.includes('--help')) return result(overrides.help ?? HELP);
    if (request.args.includes('auth')) return result(overrides.auth ?? AUTH);
    if (request.args.includes('doctor')) return result(overrides.doctor ?? DOCTOR);
    if (overrides.onInvoke) return overrides.onInvoke(request);
    return result(overrides.output ?? successful, overrides.processResult);
  };
  const env = { HOME: root, USERPROFILE: root, PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...(overrides.env ?? {}) };
  const executor = createExtractor({ executable, env, scratchRoot: root, runProcess: runner, inspectPolicy: async () => overrides.policy ?? { ok: true, sources: [] } });
  return { root, executable, env, calls, executor, runner };
}

test('invocation pins subscription model, inline schema, zero tools/customizations and no persistent session', () => {
  const request = buildInvocation({ executable: resolve('host'), cwd: resolve('scratch'), schema: SCHEMA, env: { HOME: resolve('fixture-home'), PATH: '/bin', UNRELATED_SECRET: 'not inherited' } });
  const after = (flag) => request.args[request.args.indexOf(flag) + 1];
  assert.deepEqual(JSON.parse(after('--json-schema')), SCHEMA);
  assert.equal(after('--tools'), '');
  assert.equal(after('--setting-sources'), '');
  assert.equal(after('--model'), EXTRACTION_MODEL);
  assert.deepEqual(JSON.parse(after('--mcp-config')), { mcpServers: {} });
  assert.equal(JSON.parse(after('--settings')).disableAllHooks, true);
  for (const flag of ['--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(request.args.includes(flag));
  for (const flag of ['--bare', '--fallback-model', '--resume', '--continue', '--dangerously-skip-permissions']) assert.ok(!request.args.includes(flag));
  assert.equal(request.env.UNRELATED_SECRET, undefined);
  assert.equal(request.env.CLAUDE_CODE_SIMPLE, undefined);
  assert.equal(request.shell, false);
});

test('schema paths, external references and unsupported schema semantics fail before a child starts', async (t) => {
  const s = await fixture(t);
  for (const schema of ['schema.json', { $ref: 'https://example.invalid/schema' }, { type: 'object', patternProperties: {} }]) {
    const out = await s.executor.extract({ prompt: 'private prompt', schema });
    assert.equal(out.status, 'malformed_invocation');
  }
  assert.equal(s.calls.length, 0);
});

test('startup checks resolve all ten restrictions without any model invocation or account leakage', async (t) => {
  const s = await fixture(t, { auth: { ...AUTH, email: 'private@example.invalid', organizationId: 'private-org' } });
  const check = await s.executor.check();
  assert.equal(check.ok, true);
  assert.deepEqual(Object.keys(check.restrictions), Array.from({ length: 10 }, (_, i) => `E-${i + 1}`));
  assert.ok(Object.values(check.restrictions).every(x => x === true));
  assert.equal(s.calls.length, 4);
  assert.ok(s.calls.every(x => !x.args.includes('-p') && !x.input));
  assert.doesNotMatch(JSON.stringify(check), /private@example|private-org/);
});

test('credential/provider/proxy routes block before any host process; names only are reported', async (t) => {
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CLIENT_SECRET', 'HTTPS_PROXY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const s = await fixture(t, { env: { [name]: 'private-route-value' } });
    const check = await s.executor.check();
    assert.equal(check.ok, false, name);
    assert.equal(check.blockedReason, 'provider_environment', name);
    assert.equal(s.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(check), /private-route-value/);
  }
});

test('unknown host, missing restriction switches, changed auth and unknown/managed remote policy fail closed', async (t) => {
  const cases = [
    { version: '9.9.9' }, ...HELP.split(' ').map(flag => ({ help: HELP.replace(flag, '') })),
    { auth: { ...AUTH, authMethod: 'api_key' } }, { auth: { ...AUTH, apiKeySource: 'environment' } },
    { auth: { ...AUTH, apiProvider: 'bedrock' } }, { auth: { ...AUTH, loggedIn: false } },
    { doctor: 'Managed settings (remote): fetch failed' }, { doctor: 'Managed settings (remote): loaded' },
    { policy: { ok: false, blockedReason: 'managed_policy_present' } }
  ];
  for (const entry of cases) {
    const s = await fixture(t, entry);
    const out = await s.executor.extract({ prompt: 'private', schema: SCHEMA });
    assert.equal(out.status, 'blocked', JSON.stringify(entry));
    assert.ok(s.calls.every(x => !x.args.includes('-p')), JSON.stringify(entry));
  }
});

test('policy inspection refuses helpers, managed files and unreadable policy without printing values', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-policy-');
  const userSettings = join(root, 'user.json');
  await writeFile(userSettings, JSON.stringify({ apiKeyHelper: 'private helper command' }));
  let out = await inspectPolicy({ platform: 'win32', userSettings, policyPaths: [], registry: async () => [] });
  assert.equal(out.ok, false); assert.doesNotMatch(JSON.stringify(out), /private helper/);
  await writeFile(userSettings, '{}');
  const managed = join(root, 'managed.json'); await writeFile(managed, JSON.stringify({ hooks: { SessionStart: [] } }));
  out = await inspectPolicy({ platform: 'win32', userSettings, policyPaths: [managed], registry: async () => [] });
  assert.equal(out.ok, false);
  out = await inspectPolicy({ platform: 'win32', userSettings, policyPaths: [], registry: async () => { throw Error('unreadable'); } });
  assert.equal(out.ok, false);
});

test('private input is stdin only, transient cwd is empty, output receipt carries no prompt or raw response', async (t) => {
  let captured;
  const s = await fixture(t, { onInvoke: async (request) => {
    captured = request;
    assert.deepEqual(await readdir(request.cwd), []);
    return result(successful);
  } });
  const out = await s.executor.extract({ prompt: 'private raw content', schema: SCHEMA });
  assert.equal(out.status, 'success'); assert.deepEqual(out.value, successful.structured_output);
  assert.equal(captured.input, 'private raw content'); assert.ok(!captured.args.join(' ').includes('private raw content'));
  assert.doesNotMatch(JSON.stringify(out.receipt), /private raw|bounded observation/);
  assert.equal(out.receipt.model, EXTRACTION_MODEL);
  await assert.rejects(readdir(captured.cwd), { code: 'ENOENT' });
});

test('approved model usage accepts the exact requested context suffix and preserves numeric usage', async (t) => {
  for (const model of ['claude-opus-5', 'claude-opus-5[1m]']) {
    const usage = { inputTokens: 17, outputTokens: 9, cacheReadInputTokens: 4, cacheCreationInputTokens: 3 };
    const s = await fixture(t, { output: { ...successful, modelUsage: { [model]: usage } } });
    const out = await s.executor.extract({ prompt: 'synthetic', schema: SCHEMA });
    assert.equal(out.status, 'success', model);
    assert.deepEqual(out.value, successful.structured_output);
    assert.deepEqual(out.receipt.usage, usage);
    assert.equal(out.receipt.model, 'claude-opus-5[1m]');
    assert.equal(s.calls.filter(x => x.args.includes('-p')).length, 1);
  }
});

test('model usage refuses other models, unapproved suffixes and ambiguous multiple identities', async (t) => {
  for (const models of [[], ['claude-opus-5-5'], ['claude-opus-5[200k]'], ['claude-opus-5[1m]extra'],
    ['claude-opus-5[1m][1m]'], ['CLAUDE-OPUS-5[1m]'], [' claude-opus-5[1m]'],
    ['claude-opus-5[1m]', 'claude-opus-5'], ['claude-opus-5[1m]', 'claude-opus-5-5']]) {
    const s = await fixture(t, { output: { ...successful, modelUsage: Object.fromEntries(models.map(model => [model, { inputTokens: 7 }])) } });
    const out = await s.executor.extract({ prompt: 'synthetic', schema: SCHEMA });
    assert.equal(out.status, 'blocked', JSON.stringify(models));
    assert.equal(out.blockedReason, 'model_unverified');
    assert.equal(out.value, undefined);
    assert.equal(s.calls.filter(x => x.args.includes('-p')).length, 1);
  }
});

test('invalid output, alternate model and unknown/limit terminal responses cannot be successful or silently retried', async (t) => {
  for (const [output, expected] of [
    [{ ...successful, structured_output: { claims: [2] } }, 'schema_invalid'],
    [{ ...successful, structured_output: { claims: [], extra: 'no' } }, 'schema_invalid'],
    [{ ...successful, modelUsage: { alternate: {} } }, 'blocked'],
    [{ is_error: true, result: 'usage limit reached private text' }, 'blocked'],
    ['not json private text', 'blocked']
  ]) {
    const s = await fixture(t, { output }); const out = await s.executor.extract({ prompt: 'private', schema: SCHEMA });
    assert.equal(out.status, expected); assert.equal(s.calls.filter(x => x.args.includes('-p')).length, 1);
    assert.doesNotMatch(JSON.stringify(out.receipt), /private text/);
  }
});

// The host's own structured stop_reason is the evidence; the result text is never classified or kept.
test('a host-reported safeguard refusal is named provider_refusal, never success; other errors stay unknown_terminal', async (t) => {
  const refusal = { type: 'result', subtype: 'success', is_error: true, stop_reason: 'refusal', result: 'refused private text', modelUsage: { 'claude-opus-5': { inputTokens: 3, outputTokens: 0 } } };
  for (const [output, processResult, expected] of [
    [refusal, { code: 1 }, 'provider_refusal'],
    [refusal, { code: 0 }, 'provider_refusal'],
    [{ ...refusal, stop_reason: 'end_turn' }, { code: 1 }, 'unknown_terminal'],
    [{ ...refusal, stop_reason: undefined }, { code: 1 }, 'unknown_terminal'],
    [{ ...refusal, is_error: false }, { code: 1 }, 'unknown_terminal'],
    [{ ...refusal, type: 'assistant' }, { code: 1 }, 'unknown_terminal'],
    [{ is_error: true, result: 'usage limit reached private text' }, { code: 1 }, 'unknown_terminal'],
    [`${JSON.stringify(refusal)}\nprivate text`, { code: 1 }, 'unknown_terminal'],
    [refusal, { code: null, failure: 'timeout' }, 'timeout']
  ]) {
    const s = await fixture(t, { output, processResult });
    const out = await s.executor.extract({ prompt: 'private', schema: SCHEMA });
    const why = JSON.stringify([output, processResult]);
    assert.equal(out.status, 'blocked', why); assert.equal(out.blockedReason, expected, why); assert.equal(out.value, undefined, why);
    assert.equal(s.calls.filter(x => x.args.includes('-p')).length, 1, why);
    assert.doesNotMatch(JSON.stringify(out), /private text/, why);
  }
});

test('input limits refuse before configuration work and schema validation rejects malformed values', async (t) => {
  const s = await fixture(t);
  assert.equal((await s.executor.extract({ prompt: 'x'.repeat(EXTRACTOR_LIMITS.inputBytes + 1), schema: SCHEMA })).status, 'malformed_invocation');
  assert.equal(s.calls.length, 0);
  for (const value of [null, [], { claims: Array(5).fill('x') }, { claims: ['x'.repeat(101)] }]) assert.equal(validateSchemaValue(SCHEMA, value), false);
  assert.equal(validateSchemaValue(SCHEMA, { claims: [] }), true);
});

test('bounded process kills output overflow/timeout, settles spawn errors, and never uses a shell', async () => {
  for (const mode of ['overflow', 'timeout', 'error']) {
    let killed = false;
    const spawnProcess = (_exe, _args, options) => {
      assert.equal(options.shell, false);
      const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
      c.kill = () => { killed = true; queueMicrotask(() => c.emit('close', null)); return true; };
      queueMicrotask(() => { if (mode === 'overflow') c.stdout.write('x'.repeat(101)); if (mode === 'error') c.emit('error', Error('private error')); });
      return c;
    };
    const out = await runBounded({ executable: '/fake', args: [], cwd: '/', env: {}, input: 'secret', timeoutMs: 20, maxOutputBytes: 100, spawnProcess });
    assert.equal(out.failure, mode === 'error' ? 'spawn_failed' : mode === 'overflow' ? 'output_limit' : 'timeout');
    if (mode !== 'error') assert.equal(killed, true);
  }
});

test('PR40: malformed input and positively unstarted spawn failure expose bounded retry evidence', async t => {
  const s = await fixture(t, { processResult: { failure: 'spawn_failed', processStarted: false, outputBytes: 0 } });
  const malformed = await s.executor.extract({ prompt: '', schema: SCHEMA });
  assert.deepEqual(malformed.receipt, { invocationStarted: false, processStarted: false, outputBytes: 0, zeroUsage: true, model: EXTRACTION_MODEL });
  const transport = await s.executor.extract({ prompt: 'synthetic', schema: SCHEMA });
  assert.equal(transport.status, 'transport_error'); assert.equal(transport.receipt.zeroUsage, true);
  for (const processResult of [{ failure: 'spawn_failed' }, { failure: 'spawn_failed', processStarted: true, outputBytes: 0 }, { failure: 'spawn_failed', processStarted: false, outputBytes: 1 }, { failure: 'timeout', processStarted: false, outputBytes: 0 }]) {
    const other = await fixture(t, { processResult });
    assert.equal((await other.executor.extract({ prompt: 'synthetic', schema: SCHEMA })).status, 'blocked');
  }
});

test('PR40: real process evidence distinguishes an unstarted executable from discarded response bytes', async t => {
  const root = await scratchDirectory(t);
  const missing = await runBounded({ executable: join(root, 'missing-executable'), args: [], cwd: root, env: {} });
  assert.equal(missing.failure, 'spawn_failed'); assert.equal(missing.processStarted, false); assert.equal(missing.outputBytes, 0);
  const partial = await runBounded({ executable: process.execPath, args: ['-e', "process.stdout.write('synthetic');setTimeout(()=>{},2000)"], cwd: root, env: {}, timeoutMs: 500 });
  assert.equal(partial.failure, 'timeout'); assert.equal(partial.processStarted, true); assert.equal(partial.outputBytes, 9); assert.equal(partial.stdout, '');
});

test('PR40: stopped extraction starts no process and runBounded abort kills a child without claiming model cancellation', async t => {
  const controller = new AbortController(); controller.abort(); const s = await fixture(t);
  assert.equal((await s.executor.extract({ prompt: 'synthetic', schema: SCHEMA, signal: controller.signal })).status, 'blocked');
  assert.equal(s.calls.length, 0);
  const active = new AbortController(); let child, kills = 0;
  const spawnProcess = () => {
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { kills++; queueMicrotask(() => child.emit('close', null)); };
    queueMicrotask(() => { child.emit('spawn'); child.stdout.write('partial'); active.abort(); }); return child;
  };
  const out = await runBounded({ executable: '/fake', args: [], cwd: '/', env: {}, signal: active.signal, spawnProcess });
  assert.equal(out.failure, 'aborted'); assert.equal(kills, 1); assert.equal(out.processStarted, true); assert.equal(out.outputBytes, 7);
  assert.equal(out.stdout, '');
});

test('host automatic refusal fallback is disabled before sending any extraction material', () => {
  const request = buildInvocation({ executable: resolve('host'), cwd: resolve('scratch'), schema: SCHEMA, env: {} });
  const settings = JSON.parse(request.args[request.args.indexOf('--settings') + 1]);
  assert.equal(settings.switchModelsOnFlag, false);
  assert.deepEqual(settings.availableModels, [EXTRACTION_MODEL.replace('[1m]', '')]);
});

test('object const and enum use JSON structural equality while array order and types still matter', () => {
  const properties = { a: { type: 'number' }, b: { type: 'array', items: { type: 'integer' } } };
  for (const key of ['enum', 'const']) {
    const fixed = { a: 0, b: [1, 2] };
    const schema = { type: 'object', properties, required: ['a', 'b'], additionalProperties: false, [key]: key === 'enum' ? [fixed] : fixed };
    assert.equal(validateSchemaValue(schema, { b: [1, 2], a: -0 }), true, key);
    assert.equal(validateSchemaValue(schema, { b: [2, 1], a: 0 }), false, key);
    assert.equal(validateSchemaValue(schema, { b: [1, 2], a: '0' }), false, key);
  }
});

test('only a recognized successful terminal envelope may produce extracted data', async (t) => {
  for (const envelope of [{ type: 'result', subtype: 'unknown_future' }, { type: 'assistant', subtype: 'success' }, {}]) {
    const s = await fixture(t, { output: { ...successful, ...envelope } });
    if (!Object.keys(envelope).length) {
      // The original pre-review positive fixture omitted both discriminators.
      const output = { ...successful }; delete output.type; delete output.subtype;
      const missing = await fixture(t, { output });
      assert.equal((await missing.executor.extract({ prompt: 'private', schema: SCHEMA })).status, 'blocked');
    } else assert.equal((await s.executor.extract({ prompt: 'private', schema: SCHEMA })).status, 'blocked');
  }
});

test('cached managed policy blocks without reading or interpreting its private contents', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-cached-policy-');
  await mkdir(join(root, '.claude'));
  await writeFile(join(root, '.claude', 'settings.json'), '{}');
  await writeFile(join(root, '.claude', 'remote-settings.json'), 'not even parseable private managed content');
  const out = await inspectPolicy({ platform: 'win32', env: { HOME: root, USERPROFILE: root }, policyPaths: [], registry: async () => [] });
  assert.equal(out.blockedReason, 'managed_policy_present');
  assert.doesNotMatch(JSON.stringify(out), /private managed content/);
});

test('billing-sensitive fast mode is explicitly disabled in the child configuration', () => {
  const request = buildInvocation({ executable: resolve('host'), cwd: resolve('scratch'), schema: SCHEMA, env: {} });
  assert.equal(request.env.CLAUDE_CODE_DISABLE_FAST_MODE, '1');
  const settings = JSON.parse(request.args[request.args.indexOf('--settings') + 1]);
  assert.equal(settings.fastMode, false); assert.deepEqual(settings.fallbackModel, []);
});

test('a real child that closes stdin before accepting the bounded prompt cannot report success', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-stdin-failure-');
  const out = await runBounded({ executable: process.execPath,
    args: ['-e', 'require("node:fs").closeSync(0);process.stdout.write("valid-looking output");'],
    cwd: root, env: { HOME: root, USERPROFILE: root }, input: 'x'.repeat(EXTRACTOR_LIMITS.inputBytes), timeoutMs: 5000 });
  assert.equal(out.failure, 'input_failed'); assert.equal(out.stdout, '');
});

test('environment routes and policy are rechecked when configuration changes before invoke', async (t) => {
  const s = await fixture(t);
  s.env.ANTHROPIC_BASE_URL = 'private changed route';
  assert.equal((await s.executor.check()).blockedReason, 'provider_environment');
  assert.equal(s.calls.length, 0);
  let inspections = 0, invoked = false;
  const second = createExtractor({ executable: s.executable, env: { HOME: s.root, PATH: process.env.PATH }, scratchRoot: s.root,
    inspectPolicy: async () => ++inspections === 1 ? { ok: true } : { ok: false, blockedReason: 'managed_policy_present' },
    runProcess: async ({ args }) => {
      if (args.includes('--version')) return result('2.1.288');
      if (args.includes('--help')) return result(HELP);
      if (args.includes('auth')) return result(AUTH);
      if (args.includes('doctor')) return result(DOCTOR);
      invoked = true; return result(successful);
    } });
  assert.equal((await second.extract({ prompt: 'private', schema: SCHEMA })).status, 'blocked');
  assert.equal(invoked, false);
});

test('schema is snapshotted before asynchronous checks and cannot be widened by its caller', async (t) => {
  const s = await fixture(t);
  const schema = structuredClone(SCHEMA);
  const executor = createExtractor({ executable: s.executable, env: s.env, scratchRoot: s.root,
    inspectPolicy: async () => { schema.properties.claims.items.type = 'number'; delete schema.properties.claims.items.maxLength; return { ok: true }; },
    runProcess: async ({ args }) => {
      if (args.includes('--version')) return result('2.1.288');
      if (args.includes('--help')) return result(HELP);
      if (args.includes('auth')) return result(AUTH);
      if (args.includes('doctor')) return result(DOCTOR);
      assert.equal(JSON.parse(args[args.indexOf('--json-schema') + 1]).properties.claims.items.type, 'string');
      return result(successful);
    } });
  assert.equal((await executor.extract({ prompt: 'private', schema })).status, 'success');
});

test('a scratch parent inside a repository blocks before any host probe and preserves unrelated files', async (t) => {
  const s = await fixture(t); await mkdir(join(s.root, '.git'));
  const check = await s.executor.check();
  assert.equal(check.blockedReason, 'invocation_cwd_unverified');
  assert.equal(s.calls.length, 0); assert.equal(await readFile(s.executable, 'utf8'), 'fake host binary');
});

test('configuration changes and unreadable pre-invoke checks never start a model call', async (t) => {
  for (const mode of ['environment', 'binary', 'cwd', 'policy_error']) {
    const s = await fixture(t); let inspections = 0, invoked = false;
    const executor = createExtractor({ executable: s.executable, env: s.env, scratchRoot: s.root,
      inspectPolicy: async () => { if (++inspections === 2 && mode === 'policy_error') throw Error('private failure'); return { ok: true }; },
      runProcess: async ({ args, cwd }) => {
        if (args.includes('--version')) return result('2.1.288');
        if (args.includes('--help')) return result(HELP);
        if (args.includes('auth')) return result(AUTH);
        if (args.includes('doctor')) {
          if (mode === 'environment') s.env.HOME = join(s.root, 'different');
          if (mode === 'binary') await writeFile(s.executable, 'replaced binary');
          if (mode === 'cwd') await writeFile(join(cwd, 'CLAUDE.md'), 'host-created instructions');
          return result(DOCTOR);
        }
        invoked = true; return result(successful);
      } });
    const out = await executor.extract({ prompt: 'private', schema: SCHEMA });
    assert.equal(out.status, 'blocked', mode); assert.equal(invoked, false, mode);
    assert.doesNotMatch(JSON.stringify(out.receipt), /private failure/);
  }
});

test('policy inspection cannot certify an unimplemented platform policy source', async () => {
  for (const platform of ['darwin', 'linux', 'unknown']) {
    const out = await inspectPolicy({ platform });
    assert.equal(out.blockedReason, 'policy_platform_unverified');
  }
});

test('a missing scratch root returns a sanitized blocked result rather than throwing', async (t) => {
  const s = await fixture(t);
  const executor = createExtractor({ executable: s.executable, env: s.env, scratchRoot: join(s.root, 'missing-private-location') });
  assert.equal((await executor.check()).blockedReason, 'scratch_unavailable');
  const out = await executor.extract({ prompt: 'private', schema: SCHEMA });
  assert.equal(out.status, 'blocked'); assert.equal(out.receipt.invocationStarted, false);
  assert.doesNotMatch(JSON.stringify(out), /missing-private-location/);
});

test('real child receives deliberate environment plus documented Windows OS names, and exact stdin/output', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-executor-child-');
  const out = await runBounded({ executable: process.execPath, args: ['-e', 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({input:s,env:Object.keys(process.env),cwd:process.cwd()})))'],
    cwd: root, env: { EXPLICIT_FIXTURE: 'yes' }, input: 'synthetic stdin', timeoutMs: 5000, maxOutputBytes: 8192 });
  assert.equal(out.code, 0); assert.equal(out.failure, null);
  const value = JSON.parse(out.stdout); assert.equal(value.input, 'synthetic stdin'); assert.equal(value.cwd, root);
  // libuv src/win/process.c required_vars restores these OS variables. It does
  // not restore arbitrary parent credentials or provider routes.
  const required = process.platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'] : [];
  assert.ok(value.env.includes('EXPLICIT_FIXTURE'));
  assert.ok(value.env.every(name => ['EXPLICIT_FIXTURE', ...required].includes(name)));
});

test('extractor imports are limited to the worker, verifier and explicit owner activation', async () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  const entries = await readdir(root, { recursive: true });
  const internal = new Set(['extractor.js', 'activation.js', 'extraction-runtime.js', 'internal/extraction-worker.js', 'internal/extraction-output.js', 'internal/extraction-child.js']);
  for (const name of entries.filter(x => x.endsWith('.js') && !internal.has(x.replaceAll('\\', '/')))) {
    assert.doesNotMatch(await readFile(join(root, name), 'utf8'), /(?:from\s*|import\s*\()["'][^"']*extractor\.js/, name);
  }
});

test('executor carries the registered dedicated session and correlation mark only in controlled arguments', async t => {
  const identity = { invocationId: 'ad260cbf-6460-419c-8aaf-1f4c38afcefa', correlationToken: 'sgcorr_583a6f19-08e9-4c33-9c52-d9dddaab9a72' };
  const s = await fixture(t);
  const out = await s.executor.extract({ prompt: 'same untrusted material', schema: SCHEMA, identity });
  assert.equal(out.status, 'success');
  const call = s.calls.find(x => x.args.includes('-p'));
  assert.equal(call.args[call.args.indexOf('--session-id') + 1], identity.invocationId);
  assert.ok(call.args[call.args.indexOf('--system-prompt') + 1].includes(identity.correlationToken));
  assert.equal(call.input, 'same untrusted material');
  const bad = await fixture(t);
  assert.equal((await bad.executor.extract({ prompt: 'data', schema: SCHEMA, identity: { ...identity, invocationId: '--resume' } })).status, 'malformed_invocation');
  assert.equal(bad.calls.length, 0);
});

test('bounded process distinguishes a requested kill from confirmed local child settlement', async () => {
  const controller = new AbortController(); let kills = 0;
  const out = await runBounded({ executable: '/fake', args: [], cwd: '/', env: {}, signal: controller.signal, spawnProcess: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { kills++; return false; }; child.unref = () => {};
    queueMicrotask(() => { child.emit('spawn'); controller.abort(); }); return child;
  } });
  assert.ok(kills > 0); assert.equal(out.failure, 'aborted'); assert.equal(out.localChildStopped, false);
});

// A child that exits before its stdin closes (git rev-parse does) made the
// close fail with EPIPE, about one call in twenty on Linux, and the empty-input
// call read as input_failed. With no input there is no pipe to lose, and the
// child's stdin is the null device, never the parent's (an MCP server's own
// protocol stream); with input, a stdin error is still a failure.
test('a call without input opens no stdin pipe, and a stdin error still fails a call with input', async () => {
  const stdins = [];
  const run = input => runBounded({ executable: '/fake', args: [], cwd: '/', env: {}, input, spawnProcess: (_exe, _args, options) => {
    stdins.push(options.stdio[0]);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = options.stdio[0] === 'pipe' ? new PassThrough() : null;
    child.kill = () => true;
    queueMicrotask(() => { child.emit('spawn'); child.stdin?.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); child.emit('close', 128); });
    return child;
  } });
  const empty = await run('');
  assert.equal(empty.failure, null); assert.equal(empty.code, 128); assert.equal(empty.processStarted, true);
  assert.equal((await run('synthetic prompt')).failure, 'input_failed');
  assert.deepEqual(stdins, ['ignore', 'pipe']);
});

test('bounded child shutdown escalates a refused soft termination before declaring settlement', async () => {
  const controller = new AbortController(), signals = [];
  const out = await runBounded({ executable: '/fake', args: [], cwd: '/', env: {}, signal: controller.signal, spawnProcess: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null)); return true; };
    queueMicrotask(() => { child.emit('spawn'); controller.abort(); }); return child;
  } });
  assert.ok(signals.includes('SIGKILL')); assert.equal(out.localChildStopped, true); assert.equal(out.failure, 'aborted');
});

test('activated executor binary/configuration pin is checked before every model invocation', async t => {
  const s = await fixture(t), expectedReceipt = await s.executor.check();
  const executor = createExtractor({ executable: s.executable, env: s.env, scratchRoot: s.root, runProcess: s.runner, inspectPolicy: async () => ({ ok: true }), expectedReceipt });
  assert.equal((await executor.extract({ prompt: 'synthetic', schema: SCHEMA })).status, 'success');
  const before = s.calls.filter(x => x.args.includes('-p')).length;
  await writeFile(s.executable, 'changed synthetic executable');
  const out = await executor.extract({ prompt: 'synthetic', schema: SCHEMA });
  assert.equal(out.status, 'blocked'); assert.equal(out.blockedReason, 'activated_executor_changed');
  assert.equal(s.calls.filter(x => x.args.includes('-p')).length, before);
});
test('registered invocation identity is snapshotted before asynchronous configuration checks', async t => {
  const s = await fixture(t);
  const identity = { invocationId: 'ad260cbf-6460-419c-8aaf-1f4c38afcefa', correlationToken: 'sgcorr_583a6f19-08e9-4c33-9c52-d9dddaab9a72' };
  const original = structuredClone(identity);
  const executor = createExtractor({ executable: s.executable, env: s.env, scratchRoot: s.root, runProcess: s.runner,
    inspectPolicy: async () => { identity.invocationId = 'bd260cbf-6460-419c-8aaf-1f4c38afcefa'; return { ok: true }; } });
  assert.equal((await executor.extract({ prompt: 'synthetic', schema: SCHEMA, identity })).status, 'success');
  const request = s.calls.find(x => x.args.includes('-p'));
  assert.equal(request.args[request.args.indexOf('--session-id') + 1], original.invocationId);
});

// D1 (owner decision 2026-10-08): a host profile is a version and, for 2.1.292,
// the one binary it was prepared against; any other version or binary blocks.
import { HOST_PROFILES } from '../src/internal/extraction-contract.js';
test('the executor accepts a profiled host version only on the binary its profile names', async (t) => {
  for (const [version, profiles, expected] of [
    ['2.1.300 (Claude Code)', undefined, 'host_version_unverified'],
    ['2.1.292 (Claude Code)', undefined, 'host_binary_unverified']
  ]) {
    const s = await fixture(t, { version });
    const executor = createExtractor({ executable: s.executable, env: s.env, scratchRoot: s.root, runProcess: s.runner, inspectPolicy: async () => ({ ok: true, sources: [] }), ...(profiles ? { hostProfiles: profiles } : {}) });
    assert.equal((await executor.check()).blockedReason, expected, version);
  }
  assert.ok(HOST_PROFILES['2.1.292'].requiresHostValidation && /^[0-9a-f]{64}$/u.test(HOST_PROFILES['2.1.292'].binarySha256));
  const s = await fixture(t, { version: '2.1.292 (Claude Code)' });
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(await readFile(s.executable)).digest('hex');
  const executor = createExtractor({ executable: s.executable, env: s.env, scratchRoot: s.root, runProcess: s.runner, inspectPolicy: async () => ({ ok: true, sources: [] }),
    hostProfiles: { '2.1.292': { binarySha256: digest, requiresHostValidation: true } } });
  const check = await executor.check();
  assert.equal(check.ok, true);
  assert.equal(check.hostVersion, '2.1.292');
});

test('an invocation is refused when the host version differs from the activated one, even on the same binary', async (t) => {
  const s = await fixture(t, { version: '2.1.292 (Claude Code)' });
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(await readFile(s.executable)).digest('hex');
  const profiles = { '2.1.288': { binarySha256: null, requiresHostValidation: false }, '2.1.292': { binarySha256: digest, requiresHostValidation: true } };
  const expectedReceipt = { ...(await createExtractor({ executable: s.executable, env: s.env, scratchRoot: s.root, runProcess: s.runner, inspectPolicy: async () => ({ ok: true }), hostProfiles: profiles }).check()), hostVersion: '2.1.288' };
  const executor = createExtractor({ executable: s.executable, env: s.env, scratchRoot: s.root, runProcess: s.runner, inspectPolicy: async () => ({ ok: true }), hostProfiles: profiles, expectedReceipt });
  const out = await executor.extract({ prompt: 'synthetic', schema: SCHEMA });
  assert.equal(out.blockedReason, 'activated_executor_changed');
  assert.equal(s.calls.filter((call) => call.args.includes('-p')).length, 0, 'no model invocation');
});
