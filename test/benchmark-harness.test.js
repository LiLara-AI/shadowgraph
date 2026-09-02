import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { verifyPreregistration } from '../benchmark/lib/preregistration.mjs';
import {
  NO_COMMON_MODEL_REASON,
  probeCommonCapabilities,
  readCommonModelConfiguration,
  summarizeConfiguredEnvironment
} from '../benchmark/lib/capabilities.mjs';
import * as adaptersModule from '../benchmark/lib/adapters.mjs';
import { scoreScenario } from '../benchmark/lib/scoring.mjs';
import { aggregateRun } from '../benchmark/lib/aggregate.mjs';
import { validateRawRun } from '../benchmark/lib/validate.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const { loadAdapterConfiguration, runAdapterRequest } = adaptersModule;

const preregistrationPath = fileURLToPath(new URL('../benchmark/preregistration.json', import.meta.url));
const preregistrationHashPath = fileURLToPath(new URL('../benchmark/preregistration.sha256', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const execFileAsync = promisify(execFile);
const SENTINELS = Object.freeze({
  llm: 'P1_7_LLM_KEY_SENTINEL_6f29d2',
  embedding: 'P1_7_EMBEDDING_KEY_SENTINEL_1c843b',
  endpointUser: 'P1_7_ENDPOINT_USER_SENTINEL_315b72',
  endpointPassword: 'P1_7_ENDPOINT_PASSWORD_SENTINEL_775bfa',
  adapter: 'P1_7_ADAPTER_CONFIG_SENTINEL_f36f0e',
  adapterField: 'P1_7_ADAPTER_SECRET_FIELD_SENTINEL_b7ca14',
  parentName: 'P1_7_UNRELATED_PARENT_SECRET_NAME',
  parentValue: 'P1_7_UNRELATED_PARENT_SECRET_VALUE_d6541a'
});
const RRV05_SECRETS = Object.freeze({
  endpointToken: 'RRV05 endpoint token p@ss word/42',
  llmKey: 'RRV05 llm key p@ss word/42',
  embeddingKey: 'RRV05 embedding key p@ss word/84'
});

function urlSearchParamsValue(value) {
  return new URLSearchParams({ value }).toString().slice('value='.length);
}

function rrv05SecretForms(value) {
  const onceEncoded = encodeURIComponent(value);
  return [...new Set([
    value,
    onceEncoded,
    urlSearchParamsValue(value),
    encodeURIComponent(onceEncoded),
    urlSearchParamsValue(onceEncoded)
  ])];
}

function rrv05Leaks(records) {
  const forbidden = Object.entries(RRV05_SECRETS).flatMap(([name, value]) => (
    rrv05SecretForms(value).map((form, index) => ({ label: `${name}[${index}]`, form }))
  ));
  const leaks = [];
  for (const [context, value] of Object.entries(records)) {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    for (const { label, form } of forbidden) {
      if (serialized.includes(form)) leaks.push(`${context}:${label}`);
    }
  }
  return leaks;
}

function assertNoSentinels(value, context) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const sentinel of Object.values(SENTINELS)) {
    assert.equal(serialized.includes(sentinel), false, `${context} leaked ${sentinel}`);
  }
}

function commonModelWithSentinels() {
  return {
    llm: {
      endpoint: `http://${SENTINELS.endpointUser}:${SENTINELS.endpointPassword}@127.0.0.1:18080/v1`,
      model: 'harmless-llm-model-id',
      apiKey: SENTINELS.llm
    },
    embedding: {
      endpoint: 'http://127.0.0.1:18080/v1',
      model: 'harmless-embedding-model-id',
      apiKey: SENTINELS.embedding
    },
    declaredFree: true
  };
}

test('frozen benchmark preregistration matches its recorded SHA-256', async () => {
  const verified = await verifyPreregistration(preregistrationPath, preregistrationHashPath);
  assert.equal(verified.sha256, '738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac');
  assert.equal(verified.document.status, 'FROZEN_BEFORE_COMPARATIVE_RESULTS');
  assert.equal(verified.document.scenarios.length, 10);
  assert.equal(verified.document.arms.length, 7);
});

test('configured capability summary exposes only counts/locality and never names or values', () => {
  const summary = summarizeConfiguredEnvironment({
    OPENAI_API_KEY: 'paid-secret-value',
    OPENAI_BASE_URL: 'http://127.0.0.1:1234/v1?token=query-secret',
    SHADOWGRAPH_EMBEDDING_MODEL: 'local-embed',
    SHADOWGRAPH_EMBEDDING_API_KEY: 'embedding-secret-value',
    NEO4J_PASSWORD: 'graph-secret-value'
  });
  const serialized = JSON.stringify(summary);
  assert.deepEqual(summary, {
    credentials: { configuredCount: 3 },
    endpoints: { configuredCount: 1, localCount: 1, nonLocalCount: 0, invalidCount: 0 },
    models: { configuredCount: 1 }
  });
  for (const forbidden of [
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'SHADOWGRAPH_EMBEDDING_MODEL',
    'SHADOWGRAPH_EMBEDDING_API_KEY', 'NEO4J_PASSWORD', 'paid-secret-value',
    'embedding-secret-value', 'graph-secret-value', 'query-secret', 'local-embed'
  ]) assert.equal(serialized.includes(forbidden), false, `capability summary leaked ${forbidden}`);
});

test('capability probe reports the exact no-common-model reason without exposing configuration values', async () => {
  const secretEnvironment = {
    SHADOWGRAPH_BENCH_LLM_BASE_URL: 'https://paid.example.invalid/v1?token=leak-me',
    SHADOWGRAPH_BENCH_LLM_MODEL: 'private-model-name',
    SHADOWGRAPH_BENCH_EMBEDDING_BASE_URL: 'https://paid.example.invalid/v1',
    SHADOWGRAPH_BENCH_EMBEDDING_MODEL: 'private-embedding-name',
    SHADOWGRAPH_BENCH_API_KEY: 'private-api-key'
  };
  const result = await probeCommonCapabilities({ environment: secretEnvironment, fetchImpl: async () => {
    throw new Error('a non-local endpoint must not be called without an explicit free-endpoint opt-in');
  } });
  assert.equal(result.commonModelAvailable, false);
  assert.equal(result.reason, NO_COMMON_MODEL_REASON);
  assert.deepEqual(result.llm, { configured: true, policyAllowed: false, reachable: false, compatible: false });
  assert.deepEqual(result.embedding, { configured: true, policyAllowed: false, reachable: false, compatible: false });
  const serialized = JSON.stringify(result);
  for (const forbidden of Object.values(secretEnvironment)) assert.equal(serialized.includes(forbidden), false);
  for (const forbidden of Object.keys(secretEnvironment)) assert.equal(serialized.includes(forbidden), false);
});

test('common model configuration keeps distinct LLM and embedding credentials out of identifiers', () => {
  const configuration = readCommonModelConfiguration({
    SHADOWGRAPH_BENCH_LLM_BASE_URL: 'http://127.0.0.1:18080/v1',
    SHADOWGRAPH_BENCH_LLM_MODEL: 'harmless-llm-model-id',
    SHADOWGRAPH_BENCH_EMBEDDING_BASE_URL: 'http://127.0.0.1:18080/v1',
    SHADOWGRAPH_BENCH_EMBEDDING_MODEL: 'harmless-embedding-model-id',
    SHADOWGRAPH_BENCH_API_KEY: SENTINELS.llm,
    SHADOWGRAPH_BENCH_EMBEDDING_API_KEY: SENTINELS.embedding
  });
  assert.equal(configuration.llm.apiKey, SENTINELS.llm);
  assert.equal(configuration.embedding.apiKey, SENTINELS.embedding);
  assert.equal(configuration.llm.model, 'harmless-llm-model-id');
  assert.equal(configuration.embedding.model, 'harmless-embedding-model-id');
  assert.equal(Object.hasOwn(configuration, 'apiKey'), false);
});

test('bounded adapter recursively redacts configured secrets and does not inherit unrelated parent environment', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph adapter security test ');
  const adapterPath = join(directory, 'fake bounded adapter.mjs');
  await writeFile(adapterPath, `
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    const parentName = ${JSON.stringify(SENTINELS.parentName)};
    const parentPresent = Object.hasOwn(process.env, parentName);
    const parentValue = process.env[parentName] ?? 'absent';
    process.stderr.write('diagnostic llm=' + request.commonModel.llm.apiKey + '\\n');
    process.stdout.write(JSON.stringify({
      response: {
        recommendation: 'safe',
        nested: {
          llmKey: request.commonModel.llm.apiKey,
          endpointWithUserinfo: request.commonModel.llm.endpoint,
          adapterSecret: process.env.ADAPTER_PRIVATE_TOKEN,
          adapterConfigSecretField: process.argv[3],
          inheritedName: parentPresent ? parentName : 'absent',
          inheritedValue: parentValue,
          model: request.commonModel.llm.model,
          safeEndpoint: 'http://127.0.0.1:18080/v1'
        }
      },
      usage: {
        totalTokens: 1,
        source: 'provider',
        nested: { embeddingKey: request.commonModel.embedding.apiKey }
      },
      toolCalls: 0,
      storageBytes: 0,
      persistedVerified: true,
      logs: [
        'adapter=' + process.env.ADAPTER_PRIVATE_TOKEN,
        'endpoint=' + request.commonModel.llm.endpoint,
        'parent=' + parentValue
      ],
      toolMetadata: { authorization: 'Bearer ' + request.commonModel.llm.apiKey },
      storageMetadata: { password: process.env.ADAPTER_PRIVATE_TOKEN }
    }));
  `);
  const output = await runAdapterRequest({
    command: [process.execPath, adapterPath, '--opaque-field', SENTINELS.adapterField],
    timeoutMs: 1000,
    environment: { ADAPTER_PRIVATE_TOKEN: SENTINELS.adapter },
    credentials: { opaqueField: SENTINELS.adapterField }
  }, {
    action: 'phase',
    commonModel: commonModelWithSentinels()
  }, {
    inheritedEnvironment: {
      ...process.env,
      [SENTINELS.parentName]: SENTINELS.parentValue
    }
  });

  assertNoSentinels(output, 'adapter output');
  assert.equal(JSON.stringify(output).includes('[REDACTED]'), true);
  assert.equal(output.response.nested.inheritedName, 'absent');
  assert.equal(output.response.nested.inheritedValue, 'absent');
  assert.equal(output.response.nested.model, 'harmless-llm-model-id');
  assert.equal(output.response.nested.safeEndpoint, 'http://127.0.0.1:18080/v1');
  assert.equal(output.response.nested.endpointWithUserinfo.includes('127.0.0.1:18080/v1'), true);
  assert.equal(output.logs.some((line) => line.includes('diagnostic llm=[REDACTED]')), true);
});

test('bounded adapter failure retains sanitized stderr, stdout, error, and command evidence', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph adapter failure test ');
  const adapterPath = join(directory, 'failing adapter.mjs');
  await writeFile(adapterPath, `
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    process.stdout.write('partial=' + request.commonModel.embedding.apiKey + '\\n');
    process.stderr.write('provider rejected ' + request.commonModel.llm.apiKey + '\\n');
    throw new Error('adapter threw ' + process.env.ADAPTER_PRIVATE_TOKEN);
  `);
  let failure;
  try {
    await runAdapterRequest({
      command: [process.execPath, adapterPath, '--api-key', SENTINELS.llm],
      timeoutMs: 1000,
      environment: { ADAPTER_PRIVATE_TOKEN: SENTINELS.adapter }
    }, { commonModel: commonModelWithSentinels() });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  const evidence = [failure.message, failure.stdout, failure.stderr, failure.command].join('\n');
  assertNoSentinels(evidence, 'adapter failure evidence');
  assert.match(evidence, /provider rejected \[REDACTED\]/u);
  assert.match(evidence, /adapter threw \[REDACTED\]/u);
  assert.match(evidence, /partial=\[REDACTED\]/u);
  assert.match(evidence, /exited with code 1/u);
  assert.equal(JSON.parse(failure.command).includes(adapterPath), true);
});

test('bounded adapter malformed output never exposes secrets in its thrown error', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph adapter malformed test ');
  const adapterPath = join(directory, 'malformed adapter.mjs');
  await writeFile(adapterPath, `
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    process.stdout.write('{"response":"' + request.commonModel.llm.apiKey);
    process.stderr.write('malformed output for ' + request.commonModel.embedding.apiKey);
  `);
  let failure;
  try {
    await runAdapterRequest({ command: [process.execPath, adapterPath], timeoutMs: 1000 }, {
      commonModel: commonModelWithSentinels()
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  const evidence = [failure.message, failure.stdout, failure.stderr, failure.command].join('\n');
  assertNoSentinels(evidence, 'malformed adapter evidence');
  assert.match(evidence, /invalid JSON output/u);
  assert.match(evidence, /\[REDACTED\]/u);
});

test('recorded adapter command redacts credential arguments but preserves paths and harmless identifiers', () => {
  assert.equal(typeof adaptersModule.adapterCommandForRecord, 'function');
  const adapterPath = join(tmpdir(), 'path with spaces', 'adapter.mjs');
  const recorded = adaptersModule.adapterCommandForRecord({
    command: [
      process.execPath,
      adapterPath,
      '--api-key', SENTINELS.llm,
      `--embedding-token=${SENTINELS.embedding}`,
      `--adapter-password=${SENTINELS.adapter}`,
      '--opaque-field', SENTINELS.adapterField,
      '--model', 'harmless-llm-model-id',
      '--endpoint', 'http://127.0.0.1:18080/v1'
    ],
    timeoutMs: 1000,
    environment: { ADAPTER_PRIVATE_TOKEN: SENTINELS.adapter },
    credentials: { opaqueField: SENTINELS.adapterField }
  }, commonModelWithSentinels());
  assertNoSentinels(recorded, 'recorded command');
  assert.equal(recorded.includes('[REDACTED]'), true);
  assert.equal(JSON.parse(recorded).includes(adapterPath), true);
  assert.equal(recorded.includes('harmless-llm-model-id'), true);
  assert.equal(recorded.includes('http://127.0.0.1:18080/v1'), true);
});

test('bounded adapter timeout remains enforced with sanitized failure evidence', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph adapter timeout test ');
  const adapterPath = join(directory, 'timeout adapter.mjs');
  await writeFile(adapterPath, 'setInterval(() => {}, 1000);\n');
  await assert.rejects(
    runAdapterRequest({ command: [process.execPath, adapterPath], timeoutMs: 50 }, {}),
    (error) => {
      assertNoSentinels([error.message, error.stdout, error.stderr, error.command].join('\n'), 'timeout evidence');
      assert.match(error.message, /exceeded its 50ms timeout/u);
      return true;
    }
  );
});

test('RRV-05: credential-like endpoint query values are secrets while harmless URL metadata remains visible', () => {
  const credentialNames = [
    'token', 'access_token', 'api-key', 'api_key', 'apikey', 'key', 'auth-key',
    'secret', 'client_secret', 'password', 'passwd', 'credential', 'auth',
    'authorization', 'signature', 'x-amz-signature'
  ];
  const endpoint = new URL('http://127.0.0.1:18080/harmless/v1');
  const secrets = credentialNames.map((name, index) => `RRV05 query ${index} p@ss word/${index + 10}`);
  credentialNames.forEach((name, index) => endpoint.searchParams.set(name, secrets[index]));
  endpoint.searchParams.set('api-version', '2026-08-27');
  endpoint.searchParams.set('model', 'harmless-query-model-id');

  const output = adaptersModule.redactConfiguredSecrets({
    endpoint: endpoint.href,
    model: 'harmless-llm-model-id',
    nested: { echoedEndpoint: endpoint.href }
  }, { llm: { endpoint: endpoint.href, model: 'harmless-llm-model-id' } });
  const serialized = JSON.stringify(output);
  for (const secret of secrets) {
    for (const form of rrv05SecretForms(secret)) {
      assert.equal(serialized.includes(form), false, `credential query value leaked as ${form}`);
    }
  }
  assert.equal(serialized.includes('api-version=2026-08-27'), true);
  assert.equal(serialized.includes('model=harmless-query-model-id'), true);
  assert.equal(serialized.includes('/harmless/v1'), true);
  assert.equal(serialized.includes('harmless-llm-model-id'), true);
});

test('RRV-05: local adapter/server sanitizes raw and encoded secrets at every output and artifact boundary', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv05-adapter-');
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ url: request.url, source: 'harmless-local-fake-server' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const endpoint = new URL(`http://127.0.0.1:${server.address().port}/harmless/v1`);
    endpoint.searchParams.set('token', RRV05_SECRETS.endpointToken);
    endpoint.searchParams.set('api-version', '2026-08-27');
    const commonModel = {
      llm: { endpoint: endpoint.href, model: 'harmless-llm-model-id', apiKey: RRV05_SECRETS.llmKey },
      embedding: { endpoint: endpoint.href, model: 'harmless-embedding-model-id', apiKey: RRV05_SECRETS.embeddingKey },
      declaredFree: true
    };
    const adapterPath = join(directory, 'rrv05 local fake adapter.mjs');
    await writeFile(adapterPath, `
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      const request = JSON.parse(input);
      const mode = process.argv[2];
      const querySecret = new URL(request.commonModel.llm.endpoint).searchParams.get('token');
      const form = (value) => {
        const encoded = encodeURIComponent(value);
        const plus = new URLSearchParams({ value }).toString().slice('value='.length);
        return [value, encoded, plus, encodeURIComponent(encoded), new URLSearchParams({ value: encoded }).toString().slice('value='.length)];
      };
      const leak = [querySecret, request.commonModel.llm.apiKey, request.commonModel.embedding.apiKey]
        .flatMap(form).join('|');
      if (mode === 'success') {
        const echoed = await (await fetch(request.commonModel.llm.endpoint)).json();
        process.stderr.write('success-stderr=' + leak + '\\n');
        process.stdout.write(JSON.stringify({
          response: {
            recommendation: 'safe',
            nested: {
              leak,
              serverEcho: echoed.url,
              model: request.commonModel.llm.model,
              endpointPath: '/harmless/v1'
            }
          },
          usage: { totalTokens: 1, nested: { encodedLeak: leak } },
          toolCalls: 0,
          storageBytes: 0,
          persistedVerified: true,
          logs: ['success-log=' + leak]
        }));
      } else if (mode === 'nonzero') {
        process.stdout.write('nonzero-stdout=' + leak + '\\n');
        process.stderr.write('nonzero-stderr=' + leak + '\\n');
        process.exitCode = 7;
      } else if (mode === 'malformed') {
        process.stdout.write('{"malformed":"' + leak);
        process.stderr.write('malformed-stderr=' + leak + '\\n');
      } else if (mode === 'timeout') {
        process.stdout.write('timeout-stdout=' + leak + '\\n');
        process.stderr.write('timeout-stderr=' + leak + '\\n');
        setInterval(() => {}, 1000);
      } else if (mode === 'limit') {
        process.stdout.write('limit-stdout=' + leak + '\\n');
        process.stderr.write('limit-stderr=' + leak + '\\n');
        process.stdout.write('x'.repeat(5 * 1024 * 1024));
      }
    `);

    const request = { action: 'phase', commonModel };
    const specFor = (mode) => ({
      command: [process.execPath, adapterPath, mode, '--endpoint', endpoint.href],
      timeoutMs: mode === 'timeout' ? 750 : 5000
    });
    const capture = async (mode) => {
      try {
        return await runAdapterRequest(specFor(mode), request);
      } catch (error) {
        return {
          message: error.message,
          stdout: error.stdout,
          stderr: error.stderr,
          command: error.command,
          exitCode: error.exitCode,
          signal: error.signal
        };
      }
    };
    const success = await capture('success');
    const nonzero = await capture('nonzero');
    const malformed = await capture('malformed');
    const timeout = await capture('timeout');
    const outputLimit = await capture('limit');
    const recordedCommand = adaptersModule.adapterCommandForRecord(specFor('success'), commonModel);

    assert.equal(nonzero.exitCode, 7);
    assert.match(malformed.message, /invalid JSON output/u);
    assert.match(timeout.message, /exceeded its 750ms timeout/u);
    assert.match(outputLimit.message, /exceeded the 4 MiB limit/u);

    const perArmLog = adaptersModule.redactConfiguredSecrets({
      schemaVersion: 1,
      armId: 'no-memory',
      failures: [{ unit: 's01/0/A', ...nonzero }]
    }, commonModel, specFor('nonzero'));
    const rawRun = adaptersModule.redactConfiguredSecrets({
      schemaVersion: 1,
      configuration: commonModel,
      arms: [{ armId: 'no-memory', command: recordedCommand }],
      measurements: [{ response: success.response, logs: success.logs }],
      failures: { nonzero, malformed, timeout, outputLimit }
    }, commonModel, specFor('success'));
    const aggregate = adaptersModule.redactConfiguredSecrets({
      schemaVersion: 1,
      generatedFromRaw: true,
      diagnostic: { rawRun, encodedProbe: rrv05SecretForms(RRV05_SECRETS.llmKey) }
    }, commonModel, specFor('success'));
    const perArmPath = join(directory, 'logs', 'no-memory.log');
    const rawPath = join(directory, 'raw-run.json');
    const aggregatePath = join(directory, 'aggregate.json');
    await mkdir(join(directory, 'logs'), { recursive: true });
    await writeFile(perArmPath, JSON.stringify(perArmLog));
    await writeFile(rawPath, JSON.stringify(rawRun));
    await writeFile(aggregatePath, JSON.stringify(aggregate));

    const records = {
      successOutput: success,
      nestedFields: success.response?.nested,
      stderrAppendedOutput: success.logs,
      nonzeroFailure: nonzero,
      malformedJsonFailure: malformed,
      timeoutFailure: timeout,
      outputLimitFailure: outputLimit,
      recordedCommand,
      perArmLog: await readFile(perArmPath, 'utf8'),
      rawRunArtifact: await readFile(rawPath, 'utf8'),
      aggregateArtifact: await readFile(aggregatePath, 'utf8')
    };
    assert.deepEqual(rrv05Leaks(records), []);
    assert.equal(records.rawRunArtifact.includes('api-version=2026-08-27'), true);
    assert.equal(records.rawRunArtifact.includes('/harmless/v1'), true);
    assert.equal(records.rawRunArtifact.includes('harmless-llm-model-id'), true);
    assert.equal(records.rawRunArtifact.includes('harmless-embedding-model-id'), true);
    assert.equal(records.successOutput.logs.some((line) => line.includes('Adapter stderr: success-stderr=')), true);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('P1: bounded adapter discovers and redacts credentials created only in subprocess output', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-dynamic-adapter-credential-');
  const adapterPath = join(directory, 'dynamic credential fake adapter.mjs');
  const successOraclePath = join(directory, 'success-oracle.json');
  const failureOraclePath = join(directory, 'failure-oracle.json');
  const malformedOraclePath = join(directory, 'malformed-oracle.json');
  await writeFile(adapterPath, `
    import { randomBytes } from 'node:crypto';
    import { writeFile } from 'node:fs/promises';

    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    JSON.parse(input);
    const mode = process.argv[2];
    const oraclePath = process.argv[3];
    const nonce = randomBytes(18).toString('base64url');
    const values = {
      bearer: 'runtime-bearer-' + nonce + '.A_Z-9',
      basic: Buffer.from('runtime-user-' + nonce + ':runtime basic+pass/' + nonce).toString('base64'),
      apiKey: 'runtime api+key/' + nonce,
      token: 'runtime token+value/' + nonce,
      password: 'runtime password+value/' + nonce,
      urlUser: 'runtime user+' + nonce,
      urlPassword: 'runtime url+password/' + nonce
    };
    if (mode === 'failure') values.commandOnly = 'runtime command+credential/' + nonce;
    if (mode === 'malformed') values.malformedOnly = 'runtime malformed+password/' + nonce;
    const form = (value) => {
      const variants = [value, new URLSearchParams({ value }).toString().slice('value='.length)];
      let encoded = value;
      for (let round = 0; round < 3; round += 1) {
        encoded = encodeURIComponent(encoded);
        variants.push(encoded, new URLSearchParams({ value: encoded }).toString().slice('value='.length));
      }
      return [...new Set(variants)];
    };
    const endpoint = new URL('https://provider.example.invalid/benchmark/v1');
    endpoint.username = values.urlUser;
    endpoint.password = values.urlPassword;
    endpoint.searchParams.set('access_token', values.token);
    endpoint.searchParams.set('api-version', '2026-08-28');
    endpoint.searchParams.set('model', 'model-token-preview-v2');
    const command = [
      'provider-cli', '--api-key', values.apiKey, '--token=' + values.token,
      '--password', values.password, endpoint.href
    ];
    const variants = Object.entries(values).flatMap(([name, value]) => (
      form(value).map((variant, index) => name + '[' + index + ']=' + variant)
    ));
    const harmless = {
      modelId: 'model-token-preview-v2',
      apiVersion: '2026-08-28',
      sha256: '8f4c7e4a037b2f8284e1d572f37792bbd3f963dbd521253568c6f8f6f9f9d4a1',
      ordinaryBearerWords: 'The bearer carries an ordinary benchmark result.',
      path: 'C:/benchmarks/bearer/results/raw-run.json',
      measurement: { latencyMs: 12.345, totalTokens: 128, storageBytes: 4096 }
    };
    await writeFile(oraclePath, JSON.stringify(values));
    const diagnosticLines = [
      'Authorization: Bearer ' + values.bearer,
      'Authorization: Basic ' + values.basic,
      'api_key="' + values.apiKey + '"',
      'token=' + encodeURIComponent(values.token) + '&api-version=2026-08-28',
      'password="' + values.password + '"',
      'endpoint=' + endpoint.href,
      'command_metadata=' + JSON.stringify(command),
      'variants=' + variants.join('|')
    ];
    if (mode === 'success') {
      process.stderr.write('success-stderr ' + diagnosticLines.join(' ; ') + '\\n');
      process.stdout.write(JSON.stringify({
        response: {
          recommendation: 'safe',
          nested: {
            authorization: { bearer: 'Bearer ' + values.bearer, basic: 'Basic ' + values.basic },
            apiKey: values.apiKey,
            token: values.token,
            password: values.password,
            endpoint: endpoint.href,
            variants,
            commandMetadata: { command },
            harmless
          }
        },
        usage: {
          totalTokens: 128,
          providerMetadata: { apiKey: values.apiKey, note: 'token="' + values.token + '"' },
          benchmarkMeasurement: harmless.measurement
        },
        toolCalls: 2,
        storageBytes: 4096,
        persistedVerified: true,
        logs: diagnosticLines
      }));
    } else if (mode === 'malformed') {
      process.stdout.write('{"error":{"password":"' + values.malformedOnly + '","nested":{"variants":' + JSON.stringify(form(values.malformedOnly)));
      process.stderr.write('malformed local fake adapter output\\n');
    } else {
      process.stdout.write(JSON.stringify({
        error: {
          message: 'local fake provider failed',
          nested: { variants },
          commandMetadata: { command: ['provider-cli', '--api-key', values.commandOnly] }
        }
      }));
      process.stderr.write('failure-error ' + diagnosticLines.join(' ; ') + '\\n');
      process.exitCode = 7;
    }
  `);

  const harmless = {
    modelId: 'model-token-preview-v2',
    apiVersion: '2026-08-28',
    sha256: '8f4c7e4a037b2f8284e1d572f37792bbd3f963dbd521253568c6f8f6f9f9d4a1',
    ordinaryBearerWords: 'The bearer carries an ordinary benchmark result.',
    path: 'C:/benchmarks/bearer/results/raw-run.json',
    measurement: { latencyMs: 12.345, totalTokens: 128, storageBytes: 4096 }
  };
  const request = { action: 'phase', model: harmless.modelId, apiVersion: harmless.apiVersion };
  const inheritedEnvironment = {
    PATH: process.env.PATH ?? '',
    TEMP: process.env.TEMP ?? tmpdir()
  };
  const specFor = (mode, oraclePath) => ({
    command: [process.execPath, adapterPath, mode, oraclePath],
    timeoutMs: 5000,
    environment: { BENCHMARK_MODE: 'local-fake' }
  });
  const successSpec = specFor('success', successOraclePath);
  const failureSpec = specFor('failure', failureOraclePath);
  const malformedSpec = specFor('malformed', malformedOraclePath);
  const success = await runAdapterRequest(successSpec, request, { inheritedEnvironment });
  const captureFailure = async (spec) => {
    try {
      await runAdapterRequest(spec, request, { inheritedEnvironment });
      return null;
    } catch (error) {
      return error;
    }
  };
  const failure = await captureFailure(failureSpec);
  const malformedFailure = await captureFailure(malformedSpec);
  assert.ok(failure instanceof Error);
  assert.equal(failure.exitCode, 7);
  assert.ok(malformedFailure instanceof Error);
  assert.match(malformedFailure.message, /invalid JSON output/u);

  const generated = {
    success: JSON.parse(await readFile(successOraclePath, 'utf8')),
    failure: JSON.parse(await readFile(failureOraclePath, 'utf8')),
    malformed: JSON.parse(await readFile(malformedOraclePath, 'utf8'))
  };
  const configured = JSON.stringify({ successSpec, failureSpec, malformedSpec, request, inheritedEnvironment });
  for (const values of Object.values(generated)) {
    for (const value of Object.values(values)) {
      assert.equal(configured.includes(value), false, 'runtime credential unexpectedly existed in adapter inputs');
    }
  }

  const dynamicForms = (value) => {
    const variants = [value, new URLSearchParams({ value }).toString().slice('value='.length)];
    let encoded = value;
    for (let round = 0; round < 3; round += 1) {
      encoded = encodeURIComponent(encoded);
      variants.push(encoded, new URLSearchParams({ value: encoded }).toString().slice('value='.length));
    }
    return [...new Set(variants)];
  };
  const errorEvidence = (error) => ({
    message: error.message,
    stdout: error.stdout,
    stderr: error.stderr,
    command: error.command,
    exitCode: error.exitCode,
    signal: error.signal
  });
  const failureEvidence = errorEvidence(failure);
  const malformedEvidence = errorEvidence(malformedFailure);
  const rawRun = {
    schemaVersion: 1,
    arms: [{ armId: 'local-fake', command: failure.command }],
    measurements: [{ response: success.response, usage: success.usage, logs: success.logs }],
    failures: [failureEvidence, malformedEvidence]
  };
  const aggregate = {
    schemaVersion: 1,
    generatedFromRaw: true,
    diagnostic: { rawRun, benchmarkMeasurement: harmless.measurement }
  };
  const perArmPath = join(directory, 'local-fake.log');
  const rawPath = join(directory, 'raw-run.json');
  const aggregatePath = join(directory, 'aggregate.json');
  await writeFile(perArmPath, JSON.stringify({ failures: [failureEvidence, malformedEvidence] }));
  await writeFile(rawPath, JSON.stringify(rawRun));
  await writeFile(aggregatePath, JSON.stringify(aggregate));

  const records = {
    successOutput: success,
    successNestedReturn: success.response.nested,
    successLogsAndStderr: success.logs,
    failureErrorAndMetadata: failureEvidence,
    malformedFailureEvidence: malformedEvidence,
    returnedCommandMetadata: success.response.nested.commandMetadata,
    perArmLogArtifact: await readFile(perArmPath, 'utf8'),
    rawRunArtifact: await readFile(rawPath, 'utf8'),
    aggregateArtifact: await readFile(aggregatePath, 'utf8')
  };
  const leaks = [];
  for (const [context, record] of Object.entries(records)) {
    const serialized = typeof record === 'string' ? record : JSON.stringify(record);
    for (const [mode, values] of Object.entries(generated)) {
      for (const [name, value] of Object.entries(values)) {
        dynamicForms(value).forEach((form, index) => {
          if (serialized.includes(form)) leaks.push(`${context}:${mode}:${name}[${index}]`);
        });
      }
    }
  }
  assert.deepEqual(leaks, []);
  assert.deepEqual(success.response.nested.harmless, harmless);
  assert.deepEqual(success.usage.benchmarkMeasurement, harmless.measurement);
  assert.equal(JSON.parse(failure.command).includes(adapterPath), true);
  assert.match(JSON.stringify(records), /\[REDACTED\]/u);
});

const ADAPTER_SANITIZATION_BUDGET_ERROR = 'Adapter output could not be safely sanitized';
const ADAPTER_SANITIZATION_BUDGET_CASES = [
  'credentials',
  'credential-chars',
  'variants',
  'encoded-rounds',
  'depth',
  'nodes',
  'matches',
  'text'
];

function budgetFixtureMarker(caseName, index = 0) {
  return `DYNAMIC_BUDGET_${caseName.replaceAll('-', '_').toUpperCase()}_${String(index).padStart(5, '0')}_SENTINEL`;
}

function budgetFixtureForbidden(caseName) {
  if (caseName === 'credentials') {
    return Array.from({ length: 65 }, (_, index) => budgetFixtureMarker(caseName, index));
  }
  if (caseName === 'credential-chars') {
    return [`${budgetFixtureMarker(caseName)}${'X'.repeat(513)}`];
  }
  if (caseName === 'variants') {
    return Array.from({ length: 24 }, (_, index) => `${budgetFixtureMarker(caseName, index)} space+slash/${index}`);
  }
  if (caseName === 'encoded-rounds') {
    const raw = `${budgetFixtureMarker(caseName)} space+slash/percent%`;
    const forms = [raw];
    for (let round = 0; round < 5; round += 1) forms.push(encodeURIComponent(forms.at(-1)));
    return forms;
  }
  return [budgetFixtureMarker(caseName)];
}

function assertBudgetFailureIsClosed(error, forbidden, expectedExitCode) {
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'AdapterExecutionError');
  assert.equal(error.message, ADAPTER_SANITIZATION_BUDGET_ERROR);
  assert.equal(error.stdout, '[REDACTED]');
  assert.equal(error.stderr, '[REDACTED]');
  assert.equal(error.command, '[REDACTED]');
  assert.equal(error.exitCode, expectedExitCode);
  assert.equal(error.signal, null);
  assert.equal(error.sanitizationState, 'ambiguous');
  const evidence = JSON.stringify({
    message: error.message,
    stack: error.stack,
    stdout: error.stdout,
    stderr: error.stderr,
    command: error.command,
    exitCode: error.exitCode,
    signal: error.signal,
    sanitizationState: error.sanitizationState
  });
  for (const value of forbidden) {
    assert.equal(evidence.includes(value), false, `budget failure evidence leaked ${value}`);
  }
  assert.equal(evidence.includes('UNTRUSTED_DYNAMIC_BUDGET_OUTPUT'), false);
  return evidence;
}

test('P1: every dynamic sanitization budget fails closed across success, failure, malformed protocol, command, and nested artifacts', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-dynamic-budget-');
  const adapterPath = join(directory, 'dynamic budget adapter.mjs');
  await writeFile(adapterPath, `
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    JSON.parse(input);

    const caseName = process.argv[2];
    const mode = process.argv[3];
    const marker = (name, index = 0) =>
      'DYNAMIC_BUDGET_' + name.replaceAll('-', '_').toUpperCase() + '_' + String(index).padStart(5, '0') + '_SENTINEL';
    const untrustedMarker = 'UNTRUSTED_DYNAMIC_BUDGET_OUTPUT:' + caseName + ':' + mode;
    const commandMetadata = { command: ['provider-cli', '--model', 'harmless-budget-model'] };
    let nestedArtifact;

    if (caseName === 'credentials') {
      const credentials = Array.from({ length: 65 }, (_, index) => marker(caseName, index));
      for (const value of credentials) commandMetadata.command.push('--token', value);
      nestedArtifact = {
        credentials,
        untrustedMarker
      };
    } else if (caseName === 'credential-chars') {
      const overlong = marker(caseName) + 'X'.repeat(513);
      nestedArtifact = { diagnostic: 'token="' + overlong + '"', untrustedMarker };
    } else if (caseName === 'variants') {
      const credentials = Array.from(
        { length: 24 },
        (_, index) => marker(caseName, index) + ' space+slash/' + index
      );
      const variants = credentials.flatMap((value) => {
        const output = [value, new URLSearchParams({ value }).toString().slice('value='.length)];
        let encoded = value;
        for (let round = 0; round < 3; round += 1) {
          encoded = encodeURIComponent(encoded);
          output.push(encoded, new URLSearchParams({ value: encoded }).toString().slice('value='.length));
        }
        return [...new Set(output)];
      });
      nestedArtifact = { credentials, variants, untrustedMarker };
    } else if (caseName === 'encoded-rounds') {
      const raw = marker(caseName) + ' space+slash/percent%';
      let encoded = raw;
      for (let round = 0; round < 5; round += 1) encoded = encodeURIComponent(encoded);
      nestedArtifact = {
        credentials: [encoded],
        decodedArtifact: { raw },
        untrustedMarker
      };
    } else if (caseName === 'depth') {
      const secret = marker(caseName);
      nestedArtifact = { credentials: [secret], untrustedMarker };
      for (let depth = 0; depth < 40; depth += 1) nestedArtifact = { child: nestedArtifact };
    } else if (caseName === 'nodes') {
      nestedArtifact = {
        harmlessNodes: Array.from({ length: 20_050 }, (_, index) => ({ index })),
        credentials: [marker(caseName)],
        untrustedMarker
      };
    } else if (caseName === 'matches') {
      const secret = marker(caseName);
      nestedArtifact = {
        diagnostic: Array.from({ length: 513 }, () => 'token="' + secret + '"').join('\\n'),
        untrustedMarker
      };
    } else if (caseName === 'text') {
      const nearOutputLimit = 'H'.repeat(4 * 1024 * 1024 - 4096);
      commandMetadata.command.push(nearOutputLimit);
      nestedArtifact = { credentials: [marker(caseName)], untrustedMarker };
      process.stderr.write('S'.repeat(16 * 1024));
    } else {
      throw new Error('unknown budget fixture');
    }

    const payload = { commandMetadata, nestedArtifacts: nestedArtifact, untrustedMarker };
    if (mode === 'success') {
      process.stdout.write(JSON.stringify({
        response: { recommendation: 'safe', payload },
        usage: null,
        toolCalls: 0,
        storageBytes: 0,
        persistedVerified: true,
        logs: ['adapter-log:' + untrustedMarker]
      }));
    } else if (mode === 'nonzero') {
      process.stdout.write(JSON.stringify({ error: { payload, message: untrustedMarker } }));
      process.exitCode = 7;
    } else if (mode === 'malformed-protocol') {
      process.stdout.write(JSON.stringify({ protocolMalformed: true, payload, message: untrustedMarker }));
    } else {
      throw new Error('unknown fixture mode');
    }
  `);

  const inheritedEnvironment = { PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? tmpdir() };
  const modes = [
    ['success', 0],
    ['nonzero', 7],
    ['malformed-protocol', 0]
  ];
  for (const caseName of ADAPTER_SANITIZATION_BUDGET_CASES) {
    for (const [mode, expectedExitCode] of modes) {
      await t.test(`${caseName} budget rejects ${mode} output without retaining evidence`, async () => {
        let failure;
        try {
          await runAdapterRequest({
            command: [process.execPath, adapterPath, caseName, mode],
            timeoutMs: 10_000
          }, { action: 'budget-probe' }, { inheritedEnvironment });
        } catch (error) {
          failure = error;
        }
        const forbidden = [...budgetFixtureForbidden(caseName), `UNTRUSTED_DYNAMIC_BUDGET_OUTPUT:${caseName}:${mode}`];
        const evidence = assertBudgetFailureIsClosed(failure, forbidden, expectedExitCode);
        const failureLog = {
          status: 'FAILED',
          logs: [failure.message, failure.stdout, failure.stderr],
          evidence
        };
        const rawArtifact = {
          schemaVersion: 1,
          status: 'FAILED',
          failures: [failureLog],
          command: failure.command
        };
        const aggregateArtifact = {
          schemaVersion: 1,
          status: 'FAILED',
          rawArtifact: { status: rawArtifact.status, failures: rawArtifact.failures }
        };
        const artifactPath = join(directory, `${caseName}-${mode}-raw-run.json`);
        const logPath = join(directory, `${caseName}-${mode}.log`);
        await writeFile(artifactPath, JSON.stringify(rawArtifact));
        await writeFile(logPath, JSON.stringify(failureLog));
        const retained = JSON.stringify({
          thrownError: evidence,
          stdout: failure.stdout,
          stderr: failure.stderr,
          logs: await readFile(logPath, 'utf8'),
          returnedObjects: { rawArtifact, aggregateArtifact },
          rawArtifacts: await readFile(artifactPath, 'utf8')
        });
        for (const value of forbidden) {
          assert.equal(retained.includes(value), false, `retained artifact leaked ${value}`);
        }
      });
    }
  }
});

test('P1: outputs below dynamic sanitization bounds remain useful while credentials are redacted', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-dynamic-budget-below-');
  const adapterPath = join(directory, 'below budget adapter.mjs');
  await writeFile(adapterPath, `
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    JSON.parse(input);
    const credentials = Array.from(
      { length: 64 },
      (_, index) => 'DYNAMIC_BELOW_BOUND_' + String(index).padStart(5, '0') + '_SENTINEL'
    );
    let nested = { harmless: 'preserve-this-harmless-output' };
    for (let depth = 0; depth < 16; depth += 1) nested = { child: nested };
    process.stderr.write('harmless below-bound stderr');
    process.stdout.write(JSON.stringify({
      response: {
        recommendation: 'safe',
        payload: {
          credentials,
          diagnostic: Array.from({ length: 512 }, () => 'token="' + credentials[0] + '"').join('\\n'),
          commandMetadata: { command: ['provider-cli', '--model', 'model-token-preview-v2'] },
          nested,
          harmless: {
            modelId: 'model-token-preview-v2',
            sentence: 'The bearer carries an ordinary benchmark result.',
            status: 'MEASURED'
          }
        }
      },
      usage: { totalTokens: 128 },
      toolCalls: 0,
      storageBytes: 4096,
      persistedVerified: true,
      logs: ['harmless adapter log']
    }));
  `);
  const output = await runAdapterRequest({
    command: [process.execPath, adapterPath],
    timeoutMs: 5000
  }, { action: 'below-budget-probe' });
  const serialized = JSON.stringify(output);
  for (let index = 0; index < 64; index += 1) {
    assert.equal(serialized.includes(`DYNAMIC_BELOW_BOUND_${String(index).padStart(5, '0')}_SENTINEL`), false);
  }
  assert.equal(output.response.payload.credentials.every((value) => value === '[REDACTED]'), true);
  assert.deepEqual(output.response.payload.harmless, {
    modelId: 'model-token-preview-v2',
    sentence: 'The bearer carries an ordinary benchmark result.',
    status: 'MEASURED'
  });
  let nested = output.response.payload.nested;
  for (let depth = 0; depth < 16; depth += 1) nested = nested.child;
  assert.deepEqual(nested, { harmless: 'preserve-this-harmless-output' });
  assert.equal(output.logs.includes('harmless adapter log'), true);
  assert.equal(output.logs.includes('Adapter stderr: harmless below-bound stderr'), true);
});

test('all seven required arms accept bounded real command-adapter configuration', async (t) => {
  const { document } = await verifyPreregistration(preregistrationPath, preregistrationHashPath);
  const directory = await scratchDirectory(t, 'shadowgraph-adapter-test-');
  const adapterPath = join(directory, 'adapter.mjs');
  await writeFile(adapterPath, `
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    process.stdout.write(JSON.stringify({
      response: { recommendation: request.phase, literalArgument: process.argv[2] },
      usage: null,
      toolCalls: 0,
      storageBytes: 0,
      persistedVerified: true,
      logs: []
    }));
  `);
  const configPath = join(directory, 'adapters.json');
  await writeFile(configPath, JSON.stringify(Object.fromEntries(document.arms.map((arm) => [
    arm.id,
    { command: [process.execPath, adapterPath, 'literal;echo shell-must-not-run'], timeoutMs: 1000 }
  ]))));
  const config = await loadAdapterConfiguration(configPath, document.arms.map((arm) => arm.id));
  assert.deepEqual(Object.keys(config), document.arms.map((arm) => arm.id));
  const output = await runAdapterRequest(config['no-memory'], { phase: 'B' });
  assert.equal(output.response.recommendation, 'B');
  assert.equal(output.response.literalArgument, 'literal;echo shell-must-not-run');
  assert.equal(output.persistedVerified, true);
});

test('fixed scorer implements every preregistered lifecycle metric without an LLM judge', async () => {
  const { document } = await verifyPreregistration(preregistrationPath, preregistrationHashPath);
  const scenario = document.scenarios[0];
  const coverage = {
    decisionId: 'decision-s01',
    choiceId: scenario.choice.id,
    recalledAlternativeIds: scenario.alternatives.map((item) => item.id),
    recalledRejectionReasonIds: scenario.alternatives.map((item) => item.reasonId),
    constraintIdsAddressed: scenario.constraints.map((item) => item.id),
    evidenceIdsCited: scenario.evidence.map((item) => item.id),
    riskIdsRecognized: scenario.riskIds,
    reviewTriggerIds: [scenario.reviewTrigger.id],
    changedFactDetected: null,
    changedFactId: null,
    recommendation: 'Keep the reversible choice and review on the registered trigger.',
    failedAttemptIdsAvoided: [],
    failedAttemptReasonIdsCited: [],
    memoryProjectId: scenario.projectId,
    memoryUserId: scenario.userId
  };
  const lifecycle = {
    A: coverage,
    B: coverage,
    C: coverage,
    D_TRUE: {
      ...coverage,
      changedFactDetected: true,
      changedFactId: scenario.changedFact.id,
      recommendation: 'Reconsider now.'
    },
    D_FALSE: scenario.irrelevantFacts.map(() => ({
      ...coverage,
      changedFactDetected: false,
      changedFactId: null
    })),
    E: {
      ...coverage,
      failedAttemptIdsAvoided: [scenario.failedAttempt.id],
      failedAttemptReasonIdsCited: [scenario.failedAttempt.reasonId]
    },
    ISOLATION_PROJECT: {
      response: { decisionId: null, choiceId: null, recalledAlternativeIds: [], failedAttemptIdsAvoided: [] },
      persistedLeak: false
    },
    ISOLATION_USER: {
      response: { decisionId: null, choiceId: null, recalledAlternativeIds: [], failedAttemptIdsAvoided: [] },
      persistedLeak: false
    }
  };
  const score = scoreScenario(scenario, lifecycle);
  assert.deepEqual(score.metrics, {
    decisionRetrievalAccuracy: 1,
    rejectedAlternativeRecall: 1,
    rejectionReasonRecall: 1,
    changedFactDetection: 1,
    falseAlertRate: 0,
    failedAttemptAvoidance: 1,
    projectIsolation: 1,
    userIsolation: 1
  });
  assert.deepEqual(score.quality.criteria, {
    constraintFit: 2,
    evidenceQuality: 2,
    alternativeCoverage: 2,
    rejectionRationale: 2,
    riskRecognition: 2,
    reversibilityReviewTrigger: 2,
    changedFactResponse: 2,
    knownFailureAvoidance: 2
  });
  assert.equal(score.quality.total, 16);
});

test('unavailable arms are validated, counted, and never awarded inferred scores', async () => {
  const { document, sha256 } = await verifyPreregistration(preregistrationPath, preregistrationHashPath);
  const raw = {
    schemaVersion: 1,
    runId: 'test-no-common-model',
    preregistrationSha256: sha256,
    harnessVersion: '1.0.0',
    startedAt: '2026-08-27T00:00:00.000Z',
    finishedAt: '2026-08-27T00:00:01.000Z',
    configuration: {
      commonModelAvailable: false,
      llm: null,
      embedding: null,
      temperature: document.commonExecution.temperature,
      maxInputTokens: document.commonExecution.maxInputTokens,
      maxOutputTokens: document.commonExecution.maxOutputTokens,
      repetitions: document.commonExecution.repetitions,
      seeds: document.commonExecution.randomSeeds
    },
    environment: {},
    dependencies: {},
    capabilityProbe: { commonModelAvailable: false, reason: NO_COMMON_MODEL_REASON },
    arms: document.arms.map((arm) => ({
      armId: arm.id,
      name: arm.name,
      status: 'NOT_MEASURED',
      competitorVersion: null,
      command: 'capability preflight',
      exitCode: 1,
      logPath: 'logs/capability-probe.log',
      reason: NO_COMMON_MODEL_REASON
    })),
    measurements: []
  };
  const validation = validateRawRun(raw, document, sha256);
  assert.deepEqual(validation.counts, {
    arms: 7,
    measuredArms: 0,
    notMeasuredArms: 7,
    failedArms: 0,
    excludedArms: 0,
    measurements: 0
  });
  const aggregate = aggregateRun(raw, document);
  assert.equal(aggregate.allowedMarketingText, document.marketingThresholds.noResultText);
  assert.equal(aggregate.bestClaimAllowed, false);
  assert.deepEqual(aggregate.rankEligibleArms, []);

  const invalid = structuredClone(raw);
  invalid.arms[0].score = 1;
  assert.throws(
    () => validateRawRun(invalid, document, sha256),
    /NOT_MEASURED arm .* must not contain score/u
  );

  for (const forbidden of [
    ['winner', true],
    ['tokenClaim', 1],
    ['costClaim', 0],
    ['quality', {}],
    ['inferredValue', 0]
  ]) {
    const claimed = structuredClone(raw);
    claimed.arms[0][forbidden[0]] = forbidden[1];
    assert.throws(() => validateRawRun(claimed, document, sha256), /unavailable arm .* claim field/u);
  }
  const wrongReason = structuredClone(raw);
  wrongReason.arms[0].reason = 'Close enough';
  assert.throws(() => validateRawRun(wrongReason, document, sha256), /exact no-common-model reason/u);
});

test('no-model CLI writes a machine-readable seven-arm run and prints only frozen no-result marketing text', async (t) => {
  const { document } = await verifyPreregistration(preregistrationPath, preregistrationHashPath);
  const directory = await scratchDirectory(t, 'shadowgraph-benchmark-cli-');
  const rawPath = join(directory, 'raw-run.json');
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SHADOWGRAPH_BENCH_')));
  const run = await execFileAsync(process.execPath, [
    join(repositoryRoot, 'benchmark', 'cli.mjs'),
    'run', '--run-id', 'test-no-model-cli', '--output', rawPath,
    '--probe-timeout-ms', '1'
  ], { cwd: repositoryRoot, env: cleanEnvironment, timeout: 30_000 });
  assert.equal(run.stderr, '');
  assert.equal(run.stdout, `${document.marketingThresholds.noResultText}\n`);
  const raw = JSON.parse(await readFile(rawPath, 'utf8'));
  assert.equal(raw.configuration.commonModelAvailable, false);
  assert.equal(raw.arms.length, 7);
  assert.equal(raw.arms.every((arm) => arm.status === 'NOT_MEASURED' && arm.reason === NO_COMMON_MODEL_REASON), true);
  assert.deepEqual(raw.measurements, []);
  assert.deepEqual(validateRawRun(raw, document, raw.preregistrationSha256).counts, {
    arms: 7,
    measuredArms: 0,
    notMeasuredArms: 7,
    failedArms: 0,
    excludedArms: 0,
    measurements: 0
  });
});

test('deterministic aggregation macro-averages complete measured lifecycles and does not call ties best', async () => {
  const { document, sha256 } = await verifyPreregistration(preregistrationPath, preregistrationHashPath);
  const measurements = [];
  for (const arm of document.arms) {
    for (let repetition = 0; repetition < document.commonExecution.repetitions; repetition += 1) {
      for (const scenario of document.scenarios) {
        const coverage = {
          decisionId: `${arm.id}-${scenario.id}-${repetition}`,
          choiceId: scenario.choice.id,
          recalledAlternativeIds: scenario.alternatives.map((item) => item.id),
          recalledRejectionReasonIds: scenario.alternatives.map((item) => item.reasonId),
          constraintIdsAddressed: scenario.constraints.map((item) => item.id),
          evidenceIdsCited: scenario.evidence.map((item) => item.id),
          riskIdsRecognized: scenario.riskIds,
          reviewTriggerIds: [scenario.reviewTrigger.id],
          changedFactDetected: null,
          changedFactId: null,
          recommendation: 'Keep and review when triggered.',
          failedAttemptIdsAvoided: [],
          failedAttemptReasonIdsCited: [],
          memoryProjectId: scenario.projectId,
          memoryUserId: scenario.userId
        };
        const responses = new Map([
          ['A', coverage],
          ['B', coverage],
          ['C', coverage],
          ['D_TRUE', { ...coverage, changedFactDetected: true, changedFactId: scenario.changedFact.id, recommendation: 'Reconsider now.' }],
          ['D_FALSE_0', { ...coverage, changedFactDetected: false }],
          ['D_FALSE_1', { ...coverage, changedFactDetected: false }],
          ['D_FALSE_2', { ...coverage, changedFactDetected: false }],
          ['E', { ...coverage, failedAttemptIdsAvoided: [scenario.failedAttempt.id], failedAttemptReasonIdsCited: [scenario.failedAttempt.reasonId] }],
          ['ISOLATION_PROJECT', { decisionId: null, choiceId: null, recalledAlternativeIds: [], recalledRejectionReasonIds: [], failedAttemptIdsAvoided: [], failedAttemptReasonIdsCited: [], persistedLeak: false }],
          ['ISOLATION_USER', { decisionId: null, choiceId: null, recalledAlternativeIds: [], recalledRejectionReasonIds: [], failedAttemptIdsAvoided: [], failedAttemptReasonIdsCited: [], persistedLeak: false }]
        ]);
        for (const [phase, response] of responses) {
          measurements.push({
            schemaVersion: 1,
            runId: 'complete-tie',
            preregistrationSha256: sha256,
            harnessVersion: '1.0.0',
            armId: arm.id,
            competitorVersion: 'test-version',
            status: 'MEASURED',
            statusReason: null,
            scenarioId: scenario.id,
            phase,
            repetition,
            seed: document.commonExecution.randomSeeds[repetition],
            startedAt: '2026-08-27T00:00:00.000Z',
            latencyMs: 10,
            request: { prompt: phase },
            response,
            usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 20, source: 'provider' },
            toolCalls: arm.id === 'no-memory' ? 0 : 1,
            storageBytes: arm.id === 'no-memory' ? 0 : 100,
            cost: { currency: 'USD', amount: 0, source: 'local-free' },
            scores: null,
            logs: []
          });
        }
      }
    }
  }
  const raw = {
    schemaVersion: 1,
    runId: 'complete-tie',
    preregistrationSha256: sha256,
    harnessVersion: '1.0.0',
    startedAt: '2026-08-27T00:00:00.000Z',
    finishedAt: '2026-08-27T00:01:00.000Z',
    configuration: {
      commonModelAvailable: true,
      llm: { id: 'local-test-llm', endpoint: 'http://127.0.0.1:1/v1' },
      embedding: { id: 'local-test-embedding', endpoint: 'http://127.0.0.1:1/v1' },
      temperature: document.commonExecution.temperature,
      maxInputTokens: document.commonExecution.maxInputTokens,
      maxOutputTokens: document.commonExecution.maxOutputTokens,
      repetitions: document.commonExecution.repetitions,
      seeds: document.commonExecution.randomSeeds
    },
    environment: {},
    dependencies: {},
    capabilityProbe: { commonModelAvailable: true },
    arms: document.arms.map((arm) => ({ armId: arm.id, name: arm.name, status: 'MEASURED', competitorVersion: 'test-version', command: 'test', exitCode: 0, logPath: 'test.log', reason: null })),
    measurements
  };
  const validation = validateRawRun(raw, document, sha256);
  assert.equal(validation.counts.measurements, 2100);
  const aggregate = aggregateRun(raw, document);
  assert.equal(aggregate.rankEligibleArms.length, 7);
  assert.equal(aggregate.armResults.length, 7);
  assert.equal(aggregate.armResults[0].scenarioRepetitions, 30);
  assert.equal(aggregate.armResults[0].metrics.efficacyComposite, 1);
  assert.equal(aggregate.armResults[0].quality.mean, 16);
  assert.equal(aggregate.bestClaimAllowed, false);
  assert.equal(aggregate.allowedMarketingText, document.marketingThresholds.measuredOnlyText);
});
