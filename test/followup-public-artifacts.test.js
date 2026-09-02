import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { gunzip } from 'node:zlib';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  adapterCommandForRecord,
  redactConfiguredSecrets,
  runAdapterRequest
} from '../benchmark/lib/adapters.mjs';
import { inspectPackagedText, parseNpmTarball } from '../scripts/check-package.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const BUDGET_ERROR = 'Adapter output could not be safely sanitized';

function encodingForms(value, rounds = 3) {
  const forms = new Set([value, new URLSearchParams({ value }).toString().slice('value='.length)]);
  let encoded = value;
  for (let round = 0; round < rounds; round += 1) {
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
    stack: error?.stack,
    stdout: error?.stdout,
    stderr: error?.stderr,
    command: error?.command,
    exitCode: error?.exitCode,
    signal: error?.signal,
    sanitizationState: error?.sanitizationState
  };
}

async function captureAdapterFailure(spec, request = { action: 'followup-public-artifact-probe' }) {
  try {
    await runAdapterRequest(spec, request, {
      inheritedEnvironment: { PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? tmpdir() }
    });
  } catch (error) {
    return error;
  }
  return null;
}

function assertNoRuntimeValues(artifacts, generatedByMode) {
  const leaks = [];
  for (const [artifactName, artifact] of Object.entries(artifacts)) {
    const serialized = typeof artifact === 'string' ? artifact : JSON.stringify(artifact);
    for (const [mode, generated] of Object.entries(generatedByMode)) {
      for (const [credentialName, value] of Object.entries(generated)) {
        encodingForms(value).forEach((form, formIndex) => {
          if (serialized.includes(form)) leaks.push(`${artifactName}:${mode}:${credentialName}[${formIndex}]`);
        });
      }
    }
  }
  assert.deepEqual(leaks, []);
}

async function readRuntimeOracle(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('follow-up: subprocess-only bearer/basic/header/arg/query/userinfo credentials are absent from every retained artifact', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-followup-runtime-artifacts-');
  const adapterPath = join(directory, 'runtime-secret-adapter.mjs');
  await writeFile(adapterPath, String.raw`
    import { randomBytes } from 'node:crypto';
    import { writeFileSync } from 'node:fs';

    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    JSON.parse(input);
    const mode = process.argv[2];
    const oraclePath = process.argv[3];
    const nonce = randomBytes(24).toString('base64url');
    const generated = {
      bearer: 'followup-bearer.' + nonce + '+/%',
      basic: Buffer.from('followup-user-' + nonce + ':followup pass+/' + nonce).toString('base64'),
      header: 'followup-header ' + nonce + '+/%',
      argument: 'followup-argument ' + nonce + '+/%',
      query: 'followup-query ' + nonce + '+/%',
      username: 'followup-user ' + nonce + '+',
      password: 'followup-password ' + nonce + '+/%FF%2G'
    };
    writeFileSync(oraclePath, JSON.stringify(generated));
    const forms = (value) => {
      const output = [value, new URLSearchParams({ value }).toString().slice('value='.length)];
      let encoded = value;
      for (let round = 0; round < 3; round += 1) {
        encoded = encodeURIComponent(encoded);
        output.push(encoded, new URLSearchParams({ value: encoded }).toString().slice('value='.length));
      }
      return [...new Set(output)];
    };
    const endpoint = new URL('https://provider.example.invalid/benchmark/v1');
    endpoint.username = generated.username;
    endpoint.password = generated.password;
    endpoint.searchParams.set('access_token', generated.query);
    endpoint.searchParams.set('api-version', '2026-08-28');
    const command = [
      'provider-cli',
      '--api-key', generated.argument,
      '--auth-token=' + generated.header,
      endpoint.href
    ];
    const nested = {
      headers: {
        authorization: 'Bearer ' + generated.bearer,
        proxyAuthorization: 'Basic ' + generated.basic,
        xApiKey: generated.header
      },
      commandMetadata: { command },
      endpoint,
      echoForms: [
        ...forms(generated.bearer),
        ...forms(generated.basic),
        ...forms(generated.header),
        ...forms(generated.argument),
        ...forms(generated.query),
        ...forms(generated.username),
        ...forms(generated.password)
      ],
      harmless: {
        model: 'followup-model-token-preview-v3',
        version: '2026-08-28',
        digest: '87cf2ad06882bf2aaf432bd5718f48033447ec5f14e42ad71eaa3c325af32796'
      }
    };
    const diagnostic = [
      'Authorization: Bearer ' + generated.bearer,
      'Authorization: Basic ' + generated.basic,
      'x-api-key="' + generated.header + '"',
      'command=' + JSON.stringify(command),
      'endpoint=' + endpoint.href,
      'forms=' + nested.echoForms.join('|')
    ].join(' ; ');
    if (mode === 'success') {
      process.stderr.write('success stderr ' + diagnostic + '\n');
      process.stdout.write(JSON.stringify({
        response: { recommendation: 'safe', nested },
        usage: { totalTokens: 1, nested },
        toolCalls: 1,
        storageBytes: 1,
        persistedVerified: true,
        logs: ['success log ' + diagnostic]
      }));
    } else if (mode === 'nonzero') {
      process.stdout.write(JSON.stringify({ error: { nested, diagnostic } }));
      process.stderr.write('nonzero stderr ' + diagnostic + '\n');
      process.exitCode = 19;
    } else if (mode === 'malformed') {
      process.stdout.write('{"error":{"nested":' + JSON.stringify(nested));
      process.stderr.write('malformed stderr ' + diagnostic + '\n');
    } else if (mode === 'timeout') {
      process.stdout.write('token="' + generated.argument + '"\n' + diagnostic);
      process.stderr.write('timeout stderr ' + diagnostic + '\n');
      setInterval(() => {}, 1000);
    }
  `, 'utf8');

  const modes = ['success', 'nonzero', 'malformed', 'timeout'];
  const specs = {};
  const oracles = {};
  for (const mode of modes) {
    const oraclePath = join(directory, `${mode}-oracle.json`);
    specs[mode] = {
      command: [process.execPath, adapterPath, mode, oraclePath],
      timeoutMs: mode === 'timeout' ? 750 : 10_000
    };
  }

  const request = { action: 'probe', model: 'followup-model-token-preview-v3' };
  const success = await runAdapterRequest(specs.success, request, {
    inheritedEnvironment: { PATH: process.env.PATH ?? '', TEMP: process.env.TEMP ?? tmpdir() }
  });
  const nonzero = await captureAdapterFailure(specs.nonzero, request);
  const malformed = await captureAdapterFailure(specs.malformed, request);
  const timeout = await captureAdapterFailure(specs.timeout, request);
  assert.ok(nonzero instanceof Error);
  assert.ok(malformed instanceof Error);
  assert.ok(timeout instanceof Error);
  assert.equal(nonzero.exitCode, 19);
  assert.match(malformed.message, /invalid JSON output/u);
  assert.match(timeout.message, /timeout/u);
  for (const mode of modes) oracles[mode] = await readRuntimeOracle(join(directory, `${mode}-oracle.json`));

  const configuredInputs = JSON.stringify({ specs, request });
  for (const generated of Object.values(oracles)) {
    for (const value of Object.values(generated)) {
      assert.equal(configuredInputs.includes(value), false, 'runtime credential existed before subprocess execution');
    }
  }

  const recordedCommand = adapterCommandForRecord(specs.success, request);
  const returned = {
    success,
    nonzero: errorArtifact(nonzero),
    malformed: errorArtifact(malformed),
    timeout: errorArtifact(timeout),
    recordedCommand
  };
  const logArtifact = {
    successLogs: success.logs,
    failureLogs: [nonzero.message, nonzero.stdout, nonzero.stderr, malformed.message, timeout.message]
  };
  const rawArtifact = {
    schemaVersion: 1,
    arms: modes.map((mode) => ({ armId: mode, command: returned[mode]?.command ?? recordedCommand })),
    returned,
    logArtifact
  };
  const aggregateArtifact = redactConfiguredSecrets({
    schemaVersion: 1,
    generatedFromRaw: true,
    rawArtifact,
    summary: { status: 'FOLLOWUP_PROBE_ONLY' }
  }, request, ...Object.values(specs));
  const artifactDirectory = join(directory, 'artifacts');
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(join(artifactDirectory, 'adapter.log'), JSON.stringify(logArtifact), 'utf8');
  await writeFile(join(artifactDirectory, 'raw-run.json'), JSON.stringify(rawArtifact), 'utf8');
  await writeFile(join(artifactDirectory, 'aggregate.json'), JSON.stringify(aggregateArtifact), 'utf8');

  const artifacts = {
    successReturn: success,
    successNested: success.response?.nested,
    successLogs: success.logs,
    nonzeroThrown: errorArtifact(nonzero),
    malformedThrown: errorArtifact(malformed),
    timeoutThrown: errorArtifact(timeout),
    returnedCommands: [nonzero.command, malformed.command, timeout.command, recordedCommand],
    logFile: await readFile(join(artifactDirectory, 'adapter.log'), 'utf8'),
    rawFile: await readFile(join(artifactDirectory, 'raw-run.json'), 'utf8'),
    aggregateFile: await readFile(join(artifactDirectory, 'aggregate.json'), 'utf8')
  };
  assertNoRuntimeValues(artifacts, oracles);
  assert.match(JSON.stringify(artifacts), /\[REDACTED\]/u);
  assert.equal(success.response.nested.harmless.model, 'followup-model-token-preview-v3');
  assert.equal(success.response.nested.harmless.version, '2026-08-28');
});

test('follow-up: credential context does not disclose a subprocess-only value below the discovery minimum', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-followup-short-secret-');
  const adapterPath = join(directory, 'short-secret-adapter.mjs');
  const oraclePath = join(directory, 'oracle.json');
  await writeFile(adapterPath, String.raw`
    import { randomBytes } from 'node:crypto';
    import { writeFileSync } from 'node:fs';
    for await (const _chunk of process.stdin) {}
    const token = randomBytes(12).toString('base64url').slice(0, 7);
    writeFileSync(process.argv[2], JSON.stringify({ token }));
    process.stdout.write(JSON.stringify({
      response: { recommendation: 'safe', nested: { token, echoed: token } },
      usage: null,
      toolCalls: 0,
      storageBytes: 0,
      persistedVerified: true,
      logs: ['token="' + token + '"']
    }));
  `, 'utf8');
  const spec = { command: [process.execPath, adapterPath, oraclePath], timeoutMs: 5000 };
  const output = await runAdapterRequest(spec, { action: 'short-secret-probe' });
  const generated = await readRuntimeOracle(oraclePath);
  const serialized = JSON.stringify({ output, raw: { measurements: [output] }, aggregate: { raw: output } });
  assert.equal(serialized.includes(generated.token), false, 'short runtime credential leaked');
  assert.match(serialized, /\[REDACTED\]/u);
});

function stringLeaves(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringLeaves(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => stringLeaves(item, output));
  return output;
}

function assertOracleAbsent(artifact, oracle, label) {
  const serialized = typeof artifact === 'string' ? artifact : JSON.stringify(artifact);
  const leaks = [];
  stringLeaves(oracle).forEach((value, valueIndex) => {
    encodingForms(value).forEach((form, formIndex) => {
      if (serialized.includes(form)) leaks.push(`${label}:value[${valueIndex}]:form[${formIndex}]`);
    });
  });
  assert.deepEqual(leaks, []);
}

const DISCOVERY_BOUND_CASES = [
  'credential-count',
  'credential-chars',
  'variant-count',
  'encoding-rounds',
  'url-chars',
  'depth',
  'nodes',
  'matches',
  'text',
  'output-bytes'
];

test('follow-up: every dynamic discovery/output bound is useful below and fail-closed above', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-followup-boundaries-');
  const adapterPath = join(directory, 'boundary-adapter.mjs');
  await writeFile(adapterPath, String.raw`
    import { randomBytes } from 'node:crypto';
    import { writeFileSync } from 'node:fs';

    for await (const _chunk of process.stdin) {}
    const caseName = process.argv[2];
    const side = process.argv[3];
    const oraclePath = process.argv[4];
    const nonce = randomBytes(18).toString('base64url');
    const secret = (label, length) => {
      const prefix = 'followup-' + label + '-' + nonce + '-';
      if (length === undefined) return prefix + 'credential';
      return (prefix + 'Q'.repeat(length)).slice(0, length);
    };
    const harmless = 'preserved-' + caseName + '-' + side;
    let oracle;
    let payload;
    let stderr = '';

    if (caseName === 'credential-count') {
      const count = side === 'below' ? 64 : 65;
      const credentials = Array.from({ length: count }, (_, index) => secret('count-' + index));
      oracle = { credentials };
      payload = { credentials, harmless };
    } else if (caseName === 'credential-chars') {
      const token = secret('chars', side === 'below' ? 512 : 513);
      oracle = { token };
      payload = { token, echo: token, harmless };
    } else if (caseName === 'variant-count') {
      const count = side === 'below' ? 12 : 64;
      const credentials = Array.from(
        { length: count },
        (_, index) => secret('variant-' + index) + ' space+slash/percent%'
      );
      oracle = { credentials };
      payload = { credentials, harmless };
    } else if (caseName === 'encoding-rounds') {
      const raw = secret('rounds') + ' space/slash';
      let encoded = raw;
      const rounds = side === 'below' ? 3 : 4;
      for (let round = 0; round < rounds; round += 1) encoded = encodeURIComponent(encoded);
      oracle = { raw };
      payload = { credentials: [encoded], rawEcho: raw, harmless };
    } else if (caseName === 'url-chars') {
      const token = secret('url');
      const target = side === 'below' ? 8192 : 8193;
      const prefix = 'https://provider.example.invalid/';
      const suffix = '?access_token=' + encodeURIComponent(token);
      const endpoint = prefix + 'p'.repeat(target - prefix.length - suffix.length) + suffix;
      if (endpoint.length !== target) throw new Error('url boundary fixture length mismatch');
      oracle = { token };
      payload = { endpoint, harmless };
    } else if (caseName === 'depth') {
      const token = secret('depth');
      let nested = { credentials: [token], harmless };
      const count = side === 'below' ? 24 : 40;
      for (let depth = 0; depth < count; depth += 1) nested = { child: nested };
      oracle = { token };
      payload = { nested, harmless };
    } else if (caseName === 'nodes') {
      const token = secret('nodes');
      const count = side === 'below' ? 8000 : 10050;
      oracle = { token };
      payload = {
        credentials: [token],
        harmlessNodes: Array.from({ length: count }, (_, index) => ({ index })),
        harmless
      };
    } else if (caseName === 'matches') {
      const token = secret('matches');
      const count = side === 'below' ? 512 : 513;
      oracle = { token };
      payload = {
        credentials: [token],
        diagnostic: Array.from({ length: count }, () => 'token="' + token + '"').join('\n'),
        harmless
      };
    } else if (caseName === 'text') {
      const token = secret('text');
      const fillerLength = side === 'below'
        ? 4 * 1024 * 1024 - 128 * 1024
        : 4 * 1024 * 1024 - 16 * 1024;
      oracle = { token };
      payload = {
        credentials: [token],
        commandMetadata: { command: ['provider-cli', '--model', 'H'.repeat(fillerLength)] },
        harmless
      };
      stderr = side === 'below' ? 'S'.repeat(4096) : 'S'.repeat(32 * 1024);
    } else if (caseName === 'output-bytes') {
      const token = secret('output');
      oracle = { token };
      payload = { credentials: [token], tokenEcho: token, padding: '', harmless };
    } else {
      throw new Error('unknown boundary fixture');
    }

    writeFileSync(oraclePath, JSON.stringify(oracle));
    const output = {
      response: { recommendation: 'safe', payload },
      usage: null,
      toolCalls: 0,
      storageBytes: 0,
      persistedVerified: true,
      logs: ['boundary fixture ' + harmless]
    };
    if (caseName === 'output-bytes') {
      const target = 4 * 1024 * 1024 + (side === 'below' ? -1 : 1);
      let serialized = JSON.stringify(output);
      output.response.payload.padding = 'P'.repeat(target - Buffer.byteLength(serialized));
      serialized = JSON.stringify(output);
      if (Buffer.byteLength(serialized) !== target) throw new Error('output boundary fixture length mismatch');
      process.stdout.write(serialized);
    } else {
      if (stderr) process.stderr.write(stderr);
      process.stdout.write(JSON.stringify(output));
    }
  `, 'utf8');

  for (const caseName of DISCOVERY_BOUND_CASES) {
    for (const side of ['below', 'above']) {
      await t.test(`${caseName} is safe ${side} its bound`, async () => {
        const oraclePath = join(directory, `${caseName}-${side}-oracle.json`);
        const spec = {
          command: [process.execPath, adapterPath, caseName, side, oraclePath],
          timeoutMs: 30_000
        };
        let returned;
        let failure;
        try {
          returned = await runAdapterRequest(spec, { action: 'boundary-probe' });
        } catch (error) {
          failure = error;
        }
        const oracle = await readRuntimeOracle(oraclePath);
        if (side === 'below') {
          assert.equal(failure, undefined, `${caseName} rejected below-bound output`);
          assert.equal(returned.response.payload.harmless, `preserved-${caseName}-${side}`);
        } else {
          assert.ok(failure instanceof Error, `${caseName} accepted above-bound output`);
          if (caseName === 'output-bytes') assert.match(failure.message, /exceeded the 4 MiB limit/u);
          else assert.equal(failure.message, BUDGET_ERROR);
        }
        const retained = failure ? errorArtifact(failure) : returned;
        const rawArtifact = { schemaVersion: 1, status: failure ? 'FAILED' : 'MEASURED', retained };
        const aggregateArtifact = { schemaVersion: 1, generatedFromRaw: true, rawArtifact };
        const artifactPath = join(directory, `${caseName}-${side}-retained.json`);
        await writeFile(artifactPath, JSON.stringify({ retained, rawArtifact, aggregateArtifact }), 'utf8');
        assertOracleAbsent(retained, oracle, `${caseName}:${side}:returned`);
        assertOracleAbsent(rawArtifact, oracle, `${caseName}:${side}:raw`);
        assertOracleAbsent(aggregateArtifact, oracle, `${caseName}:${side}:aggregate`);
        assertOracleAbsent(await readFile(artifactPath, 'utf8'), oracle, `${caseName}:${side}:file`);
      });
    }
  }
});

test('follow-up: adapter timeout validation accepts both endpoints and rejects outside both endpoints', () => {
  const base = { command: [process.execPath, 'harmless-adapter.mjs'] };
  assert.doesNotThrow(() => adapterCommandForRecord({ ...base, timeoutMs: 1 }));
  assert.doesNotThrow(() => adapterCommandForRecord({ ...base, timeoutMs: 600_000 }));
  assert.throws(() => adapterCommandForRecord({ ...base, timeoutMs: 0 }), /1 through 600000/u);
  assert.throws(() => adapterCommandForRecord({ ...base, timeoutMs: 600_001 }), /1 through 600000/u);
});

async function runNpmPack(cwd, destination) {
  const args = ['pack', '--json', '--ignore-scripts', '--pack-destination', destination];
  const options = { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true };
  if (process.env.npm_execpath) {
    return await execFileAsync(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return await execFileAsync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    ...options,
    shell: process.platform === 'win32'
  });
}

async function actualPackedEntries(t) {
  const destination = await scratchDirectory(t, 'shadowgraph-followup-real-pack-');
  const run = await runNpmPack(repositoryRoot, destination);
  const report = JSON.parse(run.stdout);
  assert.equal(Array.isArray(report), true);
  assert.equal(report.length, 1);
  assert.equal(basename(report[0].filename), report[0].filename);
  const archive = await gunzipAsync(await readFile(join(destination, report[0].filename)));
  return parseNpmTarball(archive).map((entry) => ({
    path: entry.archivePath.replaceAll('\\', '/').replace(/^package\//u, ''),
    content: entry.content
  }));
}

// A runtime root leak is a path REFERENCE, so the root has to start where a path
// starts. A bare `includes()` also matched a root that merely ended some longer
// path-like token, and on Linux `tmpdir()` is `/tmp`, so every packed line holding
// `var/tmp` or `private/tmp` — including this checker's own
// `posixTempPathPattern` source — was reported as a local-path leak. Anchor the
// match at a path boundary instead: skip back over a run of separators (so
// `file:///home/you/x` still counts) and reject the hit when the character before
// that run could continue a path segment (`var/tmp`, `private/tmp`). Genuine
// absolute-path disclosures always begin at such a boundary, so this narrows false
// positives without narrowing detection.
function containsRuntimeRoot(normalized, root) {
  for (let index = normalized.indexOf(root); index !== -1; index = normalized.indexOf(root, index + 1)) {
    let start = index;
    while (start > 0 && normalized[start - 1] === '/') start -= 1;
    const before = start === 0 ? '' : normalized[start - 1];
    if (before === '' || !/[a-z0-9_.-]/u.test(before)) return true;
  }
  return false;
}

function packageAuditCategories(line, sensitiveRoots) {
  const categories = new Set();
  const withoutWebUrls = line.replace(/https?:\/\/[^\s<>"'`]+/giu, ' ');
  const normalized = withoutWebUrls.replaceAll('\\', '/').toLowerCase();
  if (sensitiveRoots.some((root) => root && containsRuntimeRoot(normalized, root))) categories.add('runtime-local-root');
  if (/(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]+(?:Users|Documents +and +Settings)[\\/]+[^\\/\s"'`<>|]+)/iu.test(withoutWebUrls)) {
    categories.add('absolute-windows-profile-path');
  }
  if (/(?:^|[^A-Za-z0-9_:/])\/(?:home|Users)\/[^/\s"'`<>]+|(?:^|[^A-Za-z0-9_:/])\/root(?:\/|$)/u.test(withoutWebUrls)) {
    categories.add('absolute-posix-profile-path');
  }
  if (/(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]+(?:Temp|Windows[\\/]+Temp)(?:[\\/]|$))/iu.test(withoutWebUrls)) {
    categories.add('absolute-windows-temp-path');
  }
  if (/(?:^|[^A-Za-z0-9_:/])\/(?:tmp|var\/tmp|private\/tmp)(?:\/|$)/u.test(withoutWebUrls)) {
    categories.add('absolute-posix-temp-path');
  }
  if (/(?:^|[^A-Za-z0-9_.-])\.hermes[\\/]|AppData[\\/]Local[\\/]hermes[\\/]|[\\/]hermes[\\/](?:profiles|cache|skills|plugins|cron|memories)[\\/]/iu.test(withoutWebUrls)) {
    categories.add('local-hermes-path');
  }
  if (/(?:[A-Za-z]:[\\/][^\r\n]*[\\/](?:AI +Projects|repos?|workspaces?)[\\/][^\s"'`<>|]+)|(?:^|[^A-Za-z0-9_:/])\/(?:[^/\s"'`<>]+\/)*(?:repos?|workspaces?)\/[^/\s"'`<>]+/iu.test(withoutWebUrls)) {
    categories.add('absolute-repository-path');
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(line)) categories.add('credential-literal');
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu.test(line)) {
    categories.add('credential-literal');
  }
  const credentialName = String.raw`(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|authorization|client[_-]?secret|credential|password|passwd|private[_-]?key|secret|token)`;
  const quotedCredential = new RegExp(String.raw`\b(${credentialName})\b\s*[:=]\s*(["'\x60])([^"'\x60\r\n]*)\2`, 'giu');
  for (const match of line.matchAll(quotedCredential)) {
    const value = match[3].trim();
    if (!value || /^(?:null|none|false|true)$/iu.test(value)) continue;
    if (!/(?:example|sample|dummy|placeholder|replace|change.?me|random|your|redacted|not.?a.?secret|smoke|test|fake|process\.env|\$\{|<[^>]+>)/iu.test(value)) {
      categories.add('credential-literal');
    }
  }
  const unquotedCredential = new RegExp(String.raw`\b(${credentialName})\b\s*=\s*([^\s,;#}\]]+)`, 'giu');
  for (const match of line.matchAll(unquotedCredential)) {
    if (match[1] !== match[1].toUpperCase()) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_+./=-]{7,}$/u.test(match[2])) continue;
    if (!/(?:example|sample|dummy|placeholder|replace|change.?me|random|your|redacted|not.?a.?secret|smoke|test|fake|process\.env|\$\{|<[^>]+>)/iu.test(match[2])) {
      categories.add('credential-literal');
    }
  }
  if (/ignored raw/iu.test(line)
    && /(?:tracked|published|packaged) evidence|proves?|supports?|substantiates?/iu.test(line)
    && !/(?:not|never|no)\s+(?:claimed\s+as\s+)?(?:tracked|published|packaged)?\s*evidence/iu.test(line)) {
    categories.add('ignored-raw-evidence-claim');
  }
  return [...categories];
}

test('follow-up: the actual npm tarball contains no local paths, credentials, ignored-evidence claims, or raw results', async (t) => {
  const entries = await actualPackedEntries(t);
  const paths = entries.map((entry) => entry.path);
  assert.equal(paths.some((path) => /^benchmark\/results(?:\/|$)/iu.test(path)), false);
  assert.equal(paths.some((path) => /(?:^|\/)(?:raw-run|journal-raw|run-intent|aggregate|capability-probe)\.json$/iu.test(path)), false);
  assert.equal(paths.some((path) => /(?:^|\/)journal-output\.txt$/iu.test(path)), false);

  const roots = [repositoryRoot, homedir(), tmpdir()]
    .map((root) => root.replaceAll('\\', '/').replace(/\/$/u, '').toLowerCase())
    .filter(Boolean);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const violations = [];
  let scannedTextFiles = 0;
  for (const entry of entries) {
    if (entry.content.includes(0)) continue;
    let text;
    try {
      text = decoder.decode(entry.content);
    } catch {
      continue;
    }
    scannedTextFiles += 1;
    text.split(/\r?\n/u).forEach((line, index) => {
      packageAuditCategories(line, roots).forEach((category) => {
        violations.push(`${entry.path}:${index + 1} [${category}]`);
      });
    });
  }
  assert.ok(scannedTextFiles > 0);
  assert.deepEqual(violations, []);
});

test('follow-up: runtime-local-root anchors at a path boundary and still catches every real disclosure', () => {
  const flagged = (raw, roots) => packageAuditCategories(raw, roots).includes('runtime-local-root');

  // RED before the boundary fix: on Linux `tmpdir()` is `/tmp`, so the packed
  // source of this repository's own POSIX temp-path detector was reported as a
  // local-path leak on every Linux runner.
  const posixTempPatternSource = String.raw`const posixTempPathPattern = /(?:^|[^A-Za-z0-9_:/])\/(?:tmp|var\/tmp|private\/tmp)(?:\/|$)/u;`;
  assert.equal(flagged(posixTempPatternSource, ['/tmp']), false);
  assert.equal(flagged('values like var/tmp and private/tmp are pattern fragments', ['/tmp']), false);
  assert.equal(flagged('a token such as notmp or mytmp is unrelated', ['/tmp']), false);

  // The line is still rejected for the reasons it SHOULD be rejected for, so the
  // boundary fix narrowed one category rather than the audit as a whole.
  assert.deepEqual(packageAuditCategories('build output written to /tmp/shadowgraph-build/report.md', ['/tmp']).sort(), [
    'absolute-posix-temp-path',
    'runtime-local-root'
  ]);

  // GREEN in both directions: every shape a genuine runtime-root disclosure takes.
  const disclosures = [
    ['leading separator', '/tmp', '   /tmp'],
    ['nested temp path', '/tmp', 'wrote /tmp/shadowgraph-build/report.md'],
    ['home subdirectory', '/home/runner', 'stack at /home/runner/work/shadowgraph/src/x.js:12'],
    ['file: URL', '/home/runner', 'file:///home/runner/work/shadowgraph/src/x.js'],
    ['quoted bare root', '/home/runner', 'see "/home/runner" for details'],
    ['windows repository root', 'c:/users/example-user/ai projects/example repo', String.raw`packed from C:\Users\example-user\AI Projects\example repo\src\cli.js`],
    ['end of line', '/home/runner', 'resolved to /home/runner']
  ];
  for (const [label, root, raw] of disclosures) {
    assert.equal(flagged(raw, [root]), true, `missed runtime-local-root disclosure: ${label}`);
  }

  // An empty or missing root must never match everything.
  assert.equal(flagged('any harmless line', ['', null, undefined]), false);
});

test('follow-up: package diagnostics cover every local-path/evidence category and disclose only relative locations', () => {
  const fixture = [
    '# Follow-up package diagnostics',
    String.raw`Captured profile repository: C:\Users\followup-person\AI Projects\private-repo\report.md`,
    'Captured POSIX repository: /home/followup-person/repos/private-repo/report.md',
    String.raw`Captured Windows temporary file: D:\Temp\private-build\report.md`,
    'Captured POSIX temporary file: /var/tmp/private-build/report.md',
    'Captured Hermes state: .hermes/profiles/work/memories/private.md',
    '-----BEGIN PRIVATE KEY-----',
    'Ignored raw logs are tracked evidence proving the public benchmark claim.',
    ''
  ].join('\n');
  let failure;
  try {
    inspectPackagedText([{ path: 'docs/followup-audit.md', content: Buffer.from(fixture) }]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error);
  const diagnostic = failure.message;
  const expected = [
    'docs/followup-audit.md:2 [absolute-windows-profile-path]',
    'docs/followup-audit.md:2 [absolute-repository-path]',
    'docs/followup-audit.md:3 [absolute-posix-profile-path]',
    'docs/followup-audit.md:3 [absolute-repository-path]',
    'docs/followup-audit.md:4 [absolute-windows-temp-path]',
    'docs/followup-audit.md:5 [absolute-posix-temp-path]',
    'docs/followup-audit.md:6 [local-hermes-path]',
    'docs/followup-audit.md:7 [credential-literal]',
    'docs/followup-audit.md:8 [ignored-raw-evidence-claim]'
  ];
  expected.forEach((location) => assert.equal(diagnostic.includes(location), true, `missing ${location}`));
  diagnostic.split(/\r?\n/u).filter((line) => line.startsWith('- ')).forEach((line) => {
    assert.match(line, /^- [A-Za-z0-9._/-]+:\d+ \[[a-z-]+\]$/u);
  });
  for (const sensitive of ['followup-person', 'private-repo', 'private-build', '.hermes/profiles', 'PRIVATE KEY', 'Ignored raw logs']) {
    assert.equal(diagnostic.includes(sensitive), false, 'diagnostic disclosed sensitive fixture text');
  }
});

