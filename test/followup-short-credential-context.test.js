import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAdapterRequest } from '../benchmark/lib/adapters.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const REDACTED = '[REDACTED]';
const MODES = ['success', 'nonzero', 'malformed', 'timeout'];

function encodedForms(value) {
  const forms = new Set([value, new URLSearchParams({ value }).toString().slice('value='.length)]);
  let encoded = value;
  for (let round = 0; round < 3; round += 1) {
    encoded = encodeURIComponent(encoded);
    forms.add(encoded);
    forms.add(new URLSearchParams({ value: encoded }).toString().slice('value='.length));
  }
  return [...forms];
}

function errorArtifact(error) {
  return {
    name: error?.name,
    message: error?.message,
    stdout: error?.stdout,
    stderr: error?.stderr,
    command: error?.command,
    exitCode: error?.exitCode,
    signal: error?.signal,
    sanitizationState: error?.sanitizationState
  };
}

function redactArtifactAliases(value, aliases) {
  if (typeof value === 'string') {
    return [...aliases]
      .sort((left, right) => right.length - left.length)
      .reduce((output, alias) => output.replaceAll(alias, REDACTED), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactArtifactAliases(item, aliases));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [
      name,
      redactArtifactAliases(item, aliases)
    ]));
  }
  return value;
}

async function captureFailure(spec, request) {
  try {
    await runAdapterRequest(spec, request, {
      inheritedEnvironment: { PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? tmpdir() }
    });
  } catch (error) {
    return error;
  }
  return null;
}

function assertPayloadSanitized(payload, oracle, label) {
  assert.deepEqual(Object.values(payload.named), Array(7).fill(REDACTED), `${label}: named fields`);
  assert.deepEqual(payload.headers, {
    authorization: REDACTED,
    proxyAuthorization: REDACTED,
    xApiKey: REDACTED
  }, `${label}: headers`);
  assert.equal(payload.commandMetadata.command[2], REDACTED, `${label}: separate argument`);
  assert.equal(payload.commandMetadata.command[3], `--auth-token=${REDACTED}`, `${label}: inline argument`);

  for (const [urlLabel, href] of [
    ['endpoint', payload.endpoint],
    ['command endpoint', payload.commandMetadata.command[4]]
  ]) {
    const endpoint = new URL(href);
    assert.equal(decodeURIComponent(endpoint.username), REDACTED, `${label}: ${urlLabel} username`);
    assert.equal(decodeURIComponent(endpoint.password), REDACTED, `${label}: ${urlLabel} password`);
    assert.equal(endpoint.searchParams.get('access_token'), REDACTED, `${label}: ${urlLabel} query`);
    assert.equal(endpoint.searchParams.get('api-version'), REDACTED, `${label}: ${urlLabel} artifact-local alias`);
  }

  assert.deepEqual(payload.longEchoes, Array(payload.longEchoes.length).fill(REDACTED), `${label}: long encoded echoes`);
  assert.deepEqual(
    payload.harmless,
    redactArtifactAliases(oracle.harmless, oracle.shorts),
    `${label}: proven aliases close the whole bounded artifact`
  );
}

function assertDiagnosticSanitized(text, oracle, label) {
  const [one, two, three, four, five, six, seven] = oracle.shorts;
  for (const forbidden of [
    `Authorization: Bearer ${one}`,
    `Proxy-Authorization: Basic ${two}`,
    `x-api-key="${three}"`,
    `token=${four}`,
    `\"--api-key\",\"${five}\"`,
    `--auth-token=${six}`
  ]) assert.equal(text.includes(forbidden), false, `${label} leaked ${forbidden}`);
  assert.equal(text.includes('Authorization: Bearer [REDACTED]'), true, `${label}: bearer header`);
  assert.equal(text.includes('Proxy-Authorization: Basic [REDACTED]'), true, `${label}: basic header`);
  assert.equal(text.includes('x-api-key="[REDACTED]"'), true, `${label}: named header`);
  assert.equal(text.includes('token=[REDACTED]'), true, `${label}: assignment`);
  assert.equal(text.includes('"--api-key","[REDACTED]"'), true, `${label}: separate argument`);
  assert.equal(text.includes('--auth-token=[REDACTED]'), true, `${label}: inline argument`);
  assert.equal(text.includes('api-version=[REDACTED]'), true, `${label}: artifact-local query alias`);
  assert.equal(text.includes('harmless-summary='), true, `${label}: harmless summary retained`);
  for (const sentence of oracle.harmless.prose) {
    assert.equal(
      text.includes(redactArtifactAliases(sentence, oracle.shorts)),
      true,
      `${label}: bounded-artifact alias did not propagate: ${sentence}`
    );
  }
  assert.equal(text.includes(seven), false, `${label}: proven malformed-percent alias leaked in prose`);
}

function assertLongSecretAbsent(artifact, oracle, label) {
  const serialized = typeof artifact === 'string' ? artifact : JSON.stringify(artifact);
  for (const form of encodedForms(oracle.longSecret)) {
    assert.equal(serialized.includes(form), false, `${label} leaked long credential form`);
  }
}

test('short subprocess credentials close their bounded execution artifact across retained evidence', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-short-credential-context-');
  const adapterPath = join(directory, 'short-context-adapter.mjs');
  await writeFile(adapterPath, String.raw`
    import { randomBytes } from 'node:crypto';
    import { writeFileSync } from 'node:fs';

    for await (const _chunk of process.stdin) {}
    const mode = process.argv[2];
    const oraclePath = process.argv[3];
    const shorts = ['1', 'v2', '7ms', '4KiB', 'alpha', '%FF%2G', 'tok_7.z'];
    const longSecret = 'runtime-long%20valid%FF%2G-' + randomBytes(12).toString('hex');
    const forms = (value) => {
      const output = [value, new URLSearchParams({ value }).toString().slice('value='.length)];
      let encoded = value;
      for (let round = 0; round < 3; round += 1) {
        encoded = encodeURIComponent(encoded);
        output.push(encoded, new URLSearchParams({ value: encoded }).toString().slice('value='.length));
      }
      return [...new Set(output)];
    };
    const harmless = {
      modelIds: shorts.map((value) => 'model-' + value + '-preview'),
      versions: ['model-v1', 'build v2', ...shorts.map((value) => 'version-' + value)],
      counts: { totalTokens: 1, labels: shorts.map((value) => 'count-' + value) },
      latency: { latencyMs: 1, labels: shorts.map((value) => 'latency-' + value) },
      storage: { storageBytes: 1, labels: shorts.map((value) => 'storage-' + value) },
      prose: shorts.map((value) => 'Ordinary evidence keeps ' + value + ' unchanged.')
    };
    const endpoint = new URL('https://provider.example.invalid/benchmark');
    endpoint.username = shorts[4];
    endpoint.password = shorts[5];
    endpoint.searchParams.set('access_token', shorts[6]);
    endpoint.searchParams.set('api-version', 'v2');
    const command = [
      'provider-cli', '--api-key', shorts[4], '--auth-token=' + shorts[5], endpoint.href
    ];
    const payload = {
      named: {
        token: shorts[0],
        apiKey: shorts[1],
        password: shorts[2],
        clientSecret: shorts[3],
        credential: shorts[4],
        accessToken: shorts[5],
        xApiKey: shorts[6]
      },
      headers: {
        authorization: 'Bearer ' + shorts[0],
        proxyAuthorization: 'Basic ' + shorts[1],
        xApiKey: shorts[2]
      },
      commandMetadata: { command },
      endpoint: endpoint.href,
      refreshToken: longSecret,
      longEchoes: forms(longSecret),
      harmless
    };
    const diagnostic = [
      'Authorization: Bearer ' + shorts[0],
      'Proxy-Authorization: Basic ' + shorts[1],
      'x-api-key="' + shorts[2] + '"',
      'token=' + shorts[3],
      'command=' + JSON.stringify(command),
      'endpoint=' + endpoint.href,
      'refresh_token="' + longSecret + '"',
      'long-forms=' + forms(longSecret).join('|'),
      'harmless-summary=' + JSON.stringify(harmless)
    ].join(' ; ');
    writeFileSync(oraclePath, JSON.stringify({ shorts, longSecret, harmless }));

    if (mode === 'success') {
      process.stderr.write('success-stderr ' + diagnostic + '\n');
      process.stdout.write(JSON.stringify({
        response: { recommendation: 'safe', payload },
        usage: { totalTokens: 1, latencyMs: 1, storageBytes: 1 },
        toolCalls: 1,
        storageBytes: 1,
        persistedVerified: true,
        logs: ['success-log ' + diagnostic]
      }));
    } else if (mode === 'nonzero') {
      process.stdout.write(JSON.stringify({ error: { payload, diagnostic } }));
      process.stderr.write('nonzero-stderr ' + diagnostic + '\n');
      process.exitCode = 23;
    } else if (mode === 'malformed') {
      process.stdout.write('malformed-stdout ' + diagnostic + '\n{"broken":');
      process.stderr.write('malformed-stderr ' + diagnostic + '\n');
    } else if (mode === 'timeout') {
      process.stdout.write('timeout-stdout ' + diagnostic + '\n');
      process.stderr.write('timeout-stderr ' + diagnostic + '\n');
      setInterval(() => {}, 1000);
    }
  `, 'utf8');

  const request = { action: 'short-context-probe', model: 'request-model-v1', version: 'v2' };
  const specs = Object.fromEntries(MODES.map((mode) => [mode, {
    command: [process.execPath, adapterPath, mode, join(directory, `${mode}-oracle.json`)],
    timeoutMs: mode === 'timeout' ? 800 : 10_000
  }]));
  const success = await runAdapterRequest(specs.success, request, {
    inheritedEnvironment: { PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? tmpdir() }
  });
  const failures = {
    nonzero: await captureFailure(specs.nonzero, request),
    malformed: await captureFailure(specs.malformed, request),
    timeout: await captureFailure(specs.timeout, request)
  };
  assert.ok(failures.nonzero instanceof Error);
  assert.ok(failures.malformed instanceof Error);
  assert.ok(failures.timeout instanceof Error);
  assert.equal(failures.nonzero.exitCode, 23);
  assert.match(failures.malformed.message, /invalid JSON output/u);
  assert.match(failures.timeout.message, /800ms timeout/u);

  const oracles = Object.fromEntries(await Promise.all(MODES.map(async (mode) => [
    mode,
    JSON.parse(await readFile(join(directory, `${mode}-oracle.json`), 'utf8'))
  ])));
  const configuredInputs = JSON.stringify({ request, specs });
  for (const oracle of Object.values(oracles)) {
    assert.equal(configuredInputs.includes(oracle.longSecret), false, 'long credential existed in adapter inputs');
  }
  assert.deepEqual(request, {
    action: 'short-context-probe',
    model: 'request-model-v1',
    version: 'v2'
  }, 'short values may be incidental input evidence but are never configured as credentials');

  assertPayloadSanitized(success.response.payload, oracles.success, 'success payload');
  assertDiagnosticSanitized(success.logs.join('\n'), oracles.success, 'success logs/stderr');
  assertLongSecretAbsent(success, oracles.success, 'success');

  const nonzeroParsed = JSON.parse(failures.nonzero.stdout);
  assertPayloadSanitized(nonzeroParsed.error.payload, oracles.nonzero, 'nonzero payload');
  assertDiagnosticSanitized(nonzeroParsed.error.diagnostic, oracles.nonzero, 'nonzero stdout');
  assertDiagnosticSanitized(failures.nonzero.stderr, oracles.nonzero, 'nonzero stderr');
  assertDiagnosticSanitized(failures.malformed.stdout, oracles.malformed, 'malformed stdout');
  assertDiagnosticSanitized(failures.malformed.stderr, oracles.malformed, 'malformed stderr');
  assertDiagnosticSanitized(failures.timeout.stdout, oracles.timeout, 'timeout stdout');
  assertDiagnosticSanitized(failures.timeout.stderr, oracles.timeout, 'timeout stderr');
  for (const [mode, failure] of Object.entries(failures)) {
    assertLongSecretAbsent(errorArtifact(failure), oracles[mode], `${mode} error`);
    assertDiagnosticSanitized(failure.message, oracles[mode], `${mode} error message`);
  }

  const raw = {
    schemaVersion: 1,
    measurements: [success],
    failures: Object.fromEntries(Object.entries(failures).map(([mode, error]) => [mode, errorArtifact(error)]))
  };
  const aggregate = { schemaVersion: 1, generatedFromRaw: true, raw };
  const artifactsDirectory = join(directory, 'artifacts');
  await mkdir(artifactsDirectory, { recursive: true });
  await writeFile(join(artifactsDirectory, 'adapter.log'), JSON.stringify({
    success: success.logs,
    failures: raw.failures
  }), 'utf8');
  await writeFile(join(artifactsDirectory, 'raw-run.json'), JSON.stringify(raw), 'utf8');
  await writeFile(join(artifactsDirectory, 'aggregate.json'), JSON.stringify(aggregate), 'utf8');

  const retained = {
    log: await readFile(join(artifactsDirectory, 'adapter.log'), 'utf8'),
    raw: await readFile(join(artifactsDirectory, 'raw-run.json'), 'utf8'),
    aggregate: await readFile(join(artifactsDirectory, 'aggregate.json'), 'utf8')
  };
  for (const [artifactName, artifact] of Object.entries(retained)) {
    assert.equal(artifact.includes('model-v[REDACTED]'), true, `${artifactName}: model alias not closed`);
    assert.equal(artifact.includes('build [REDACTED]'), true, `${artifactName}: version alias not closed`);
    assert.equal(
      artifact.includes('Ordinary evidence keeps [REDACTED] unchanged.'),
      true,
      `${artifactName}: prose alias not closed`
    );
    for (const [mode, oracle] of Object.entries(oracles)) {
      assertLongSecretAbsent(artifact, oracle, `${artifactName}:${mode}`);
    }
  }
});
