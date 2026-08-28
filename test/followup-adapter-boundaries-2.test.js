import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  redactConfiguredSecrets,
  runAdapterRequest
} from '../benchmark/lib/adapters.mjs';

const REDACTED = '[REDACTED]';
const BUDGET_ERROR = 'Adapter output could not be safely sanitized';
const INHERITED_ENVIRONMENT = {
  PATH: process.env.PATH ?? '',
  TEMP: process.env.TEMP ?? tmpdir()
};

function retainedError(error) {
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

async function captureFailure(spec, request) {
  try {
    await runAdapterRequest(spec, request, { inheritedEnvironment: INHERITED_ENVIRONMENT });
  } catch (error) {
    return error;
  }
  return null;
}

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

function encodedCredentialName(value, rounds) {
  let encoded = value.replace(
    /^[A-Za-z]/u,
    (character) => `%${character.codePointAt(0).toString(16).padStart(2, '0')}`
  );
  for (let round = 1; round < rounds; round += 1) encoded = encodeURIComponent(encoded);
  return encoded;
}

function encodedNameArtifact(channel, name, value) {
  const siblingEcho = `sibling-before<${value}>sibling-after`;
  if (channel === 'assignment') return { diagnostic: `${name}=${value}`, siblingEcho };
  if (channel === 'header') return { diagnostic: `${name}: ${value}`, siblingEcho };
  if (channel === 'flag') return { argv: ['provider-cli', `--${name}`, value], siblingEcho };
  if (channel === 'url-query') {
    return {
      endpoint: `https://provider.example.invalid/v1?${name}=${encodeURIComponent(value)}&api-version=2026-08-28`,
      siblingEcho
    };
  }
  if (channel === 'object-field') return { [name]: value, siblingEcho };
  throw new Error(`Unknown encoded-name channel: ${channel}`);
}

function assertAliasesAbsent(artifact, aliases, label) {
  const serialized = typeof artifact === 'string' ? artifact : JSON.stringify(artifact);
  for (const alias of aliases) {
    for (const form of encodedForms(alias)) {
      assert.equal(serialized.includes(form), false, `${label} leaked ${JSON.stringify(form)}`);
    }
  }
}

function assertClosedBudgetError(error, forbidden = []) {
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'AdapterExecutionError');
  assert.equal(error.message, BUDGET_ERROR);
  assert.equal(error.stdout, REDACTED);
  assert.equal(error.stderr, REDACTED);
  assert.equal(error.command, REDACTED);
  assert.equal(error.sanitizationState, 'ambiguous');
  const retained = JSON.stringify(retainedError(error));
  assert.equal(retained.includes('RangeError'), false);
  assert.equal(retained.includes('Maximum call stack'), false);
  for (const value of forbidden) assert.equal(retained.includes(value), false);
}

test('bounded artifacts propagate proven 1-7 character aliases across ancestors, siblings, text, and every string array', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-adapter-alias-boundary-'));
  try {
    const adapterPath = join(directory, 'artifact-alias-adapter.mjs');
    await writeFile(adapterPath, String.raw`
      import { writeFileSync } from 'node:fs';
      for await (const _chunk of process.stdin) {}
      const mode = process.argv[2];
      const oraclePath = process.argv[3];
      const aliases = Array.from(
        { length: 7 },
        (_, index) => String.fromCharCode(0xE001 + index).repeat(index + 1)
      );
      writeFileSync(oraclePath, JSON.stringify({ aliases }));
      const embedded = aliases.map((value, index) => 'echo-' + index + '<' + value + '>-tail');
      const arrays = {
        command: ['provider', '--token', aliases[0]],
        argv: ['provider', '--signature', aliases[1]],
        args: ['--sig', aliases[2]],
        arbitrary: ['provider', '--api-key', aliases[3]],
        nested: [
          ['--password', aliases[4]],
          { deeper: [['provider', '--client-secret', aliases[5]]] },
          ['--credential', aliases[6]]
        ],
        publicMaterial: ['--public-key', 'PUBLIC-ARRAY-MATERIAL'],
        designMetadata: ['--design-token', 'design-token-safe'],
        paginationMetadata: ['--page-token', 'page-token-safe']
      };
      const payload = {
        ancestorEchoBeforeProof: embedded,
        nested: {
          siblingEchoBeforeProof: embedded.toReversed(),
          proof: {
            token: aliases[0],
            signature: aliases[1],
            sig: aliases[2],
            apiKey: aliases[3],
            password: aliases[4],
            clientSecret: aliases[5],
            credential: aliases[6]
          },
          descendantEchoAfterProof: embedded
        },
        arrays,
        publicKey: 'PUBLIC-FIELD-MATERIAL',
        'public-key': 'PUBLIC-DASHED-MATERIAL',
        designToken: 'design-field-safe',
        pageToken: 'page-field-safe',
        paginationToken: 'pagination-field-safe'
      };
      const diagnostic = [
        ...embedded,
        'signature=' + aliases[1],
        'sig="' + aliases[2] + '"',
        'command=' + JSON.stringify(arrays.command),
        'argv=' + JSON.stringify(arrays.argv),
        'args=' + JSON.stringify(arrays.args),
        'arbitrary=' + JSON.stringify(arrays.arbitrary),
        'nested=' + JSON.stringify(arrays.nested),
        ...embedded.toReversed()
      ].join(' ; ');
      if (mode === 'success') {
        process.stderr.write('success-stderr ' + diagnostic);
        process.stdout.write(JSON.stringify({
          response: { recommendation: 'safe', payload },
          usage: { totalTokens: 1 },
          toolCalls: 0,
          storageBytes: 0,
          persistedVerified: true,
          logs: ['success-log ' + diagnostic]
        }));
      } else if (mode === 'failure') {
        process.stdout.write(JSON.stringify({ error: { payload, diagnostic } }));
        process.stderr.write('failure-stderr ' + diagnostic);
        process.exitCode = 29;
      } else if (mode === 'harmless') {
        process.stdout.write(JSON.stringify({
          response: {
            recommendation: 'safe',
            modelEvidence: aliases.map((value) => 'model<' + value + '>'),
            aliases,
            publicKey: 'PUBLIC-FIELD-MATERIAL',
            pageToken: 'page-field-safe'
          },
          usage: null,
          toolCalls: 0,
          storageBytes: 0,
          persistedVerified: true,
          logs: ['independent harmless artifact']
        }));
      }
    `, 'utf8');

    const specFor = (mode) => ({
      command: [process.execPath, adapterPath, mode, join(directory, `${mode}-oracle.json`)],
      timeoutMs: 10_000
    });
    const request = {
      action: 'artifact-alias-probe',
      model: 'model-v1-design-preview',
      publicKey: 'REQUEST-PUBLIC-MATERIAL',
      pageToken: 'request-page-safe'
    };
    const success = await runAdapterRequest(specFor('success'), request, {
      inheritedEnvironment: INHERITED_ENVIRONMENT
    });
    const failure = await captureFailure(specFor('failure'), request);
    const harmless = await runAdapterRequest(specFor('harmless'), request, {
      inheritedEnvironment: INHERITED_ENVIRONMENT
    });
    assert.ok(failure instanceof Error);
    assert.equal(failure.exitCode, 29);

    const successOracle = JSON.parse(await readFile(join(directory, 'success-oracle.json'), 'utf8'));
    const failureOracle = JSON.parse(await readFile(join(directory, 'failure-oracle.json'), 'utf8'));
    const harmlessOracle = JSON.parse(await readFile(join(directory, 'harmless-oracle.json'), 'utf8'));
    assertAliasesAbsent(success, successOracle.aliases, 'success return/log/stderr');
    assertAliasesAbsent(retainedError(failure), failureOracle.aliases, 'failure return/error/raw evidence');

    const raw = {
      schemaVersion: 1,
      measurements: [success],
      failures: [retainedError(failure)]
    };
    const aggregate = { schemaVersion: 1, generatedFromRaw: true, raw };
    assertAliasesAbsent(raw, [...successOracle.aliases, ...failureOracle.aliases], 'raw artifact');
    assertAliasesAbsent(aggregate, [...successOracle.aliases, ...failureOracle.aliases], 'aggregate artifact');

    assert.deepEqual(success.response.payload.arrays.publicMaterial, ['--public-key', 'PUBLIC-ARRAY-MATERIAL']);
    assert.deepEqual(success.response.payload.arrays.designMetadata, ['--design-token', 'design-token-safe']);
    assert.deepEqual(success.response.payload.arrays.paginationMetadata, ['--page-token', 'page-token-safe']);
    assert.equal(success.response.payload.publicKey, 'PUBLIC-FIELD-MATERIAL');
    assert.equal(success.response.payload['public-key'], 'PUBLIC-DASHED-MATERIAL');
    assert.equal(success.response.payload.designToken, 'design-field-safe');
    assert.equal(success.response.payload.pageToken, 'page-field-safe');
    assert.equal(success.response.payload.paginationToken, 'pagination-field-safe');

    assert.deepEqual(harmless.response.aliases, harmlessOracle.aliases);
    assert.deepEqual(
      harmless.response.modelEvidence,
      harmlessOracle.aliases.map((value) => `model<${value}>`)
    );
    assert.equal(harmless.response.publicKey, 'PUBLIC-FIELD-MATERIAL');
    assert.equal(harmless.response.pageToken, 'page-field-safe');
    assert.deepEqual(request, {
      action: 'artifact-alias-probe',
      model: 'model-v1-design-preview',
      publicKey: 'REQUEST-PUBLIC-MATERIAL',
      pageToken: 'request-page-safe'
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('artifact sanitization is local: proven short aliases close the artifact without corrupting independent config/model evidence', () => {
  const alias = 'v2';
  const sanitized = redactConfiguredSecrets({
    ancestorEcho: `before-${alias}-after`,
    nested: {
      siblingEcho: alias,
      auth: { token: alias },
      descendantEcho: `embedded<${alias}>`
    }
  });
  assertAliasesAbsent(sanitized, [alias], 'direct bounded artifact');

  const independent = redactConfiguredSecrets({
    model: `model-${alias}-preview`,
    version: alias,
    publicKey: alias,
    pageToken: alias,
    designToken: alias
  }, {
    auth: { token: alias }
  });
  assert.deepEqual(independent, {
    model: 'model-v2-preview',
    version: 'v2',
    publicKey: 'v2',
    pageToken: 'v2',
    designToken: 'v2'
  });
});

test('credential URL names decode through three rounds and a fourth round fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-adapter-url-name-rounds-'));
  try {
    const adapterPath = join(directory, 'url-name-round-adapter.mjs');
    await writeFile(adapterPath, String.raw`
      import { writeFileSync } from 'node:fs';
      for await (const _chunk of process.stdin) {}
      const rounds = Number(process.argv[2]);
      const oraclePath = process.argv[3];
      const secret = 'URL_NAME_ROUND_SECRET_' + rounds + '_VALUE';
      let name = rounds % 2 === 0 ? 'signature' : 'sig';
      for (let round = 0; round < rounds; round += 1) name = encodeURIComponent(name).replace('s', '%73');
      const endpoint = 'https://provider.example.invalid/path?' + name + '=' + encodeURIComponent(secret)
        + '&api-version=2026-08-28&design=ordinary';
      writeFileSync(oraclePath, JSON.stringify({ secret, endpoint, name }));
      process.stdout.write(JSON.stringify({
        response: { recommendation: 'safe', endpoints: [endpoint] },
        usage: null,
        toolCalls: 0,
        storageBytes: 0,
        persistedVerified: true,
        logs: ['endpoint=' + endpoint]
      }));
    `, 'utf8');

    for (let rounds = 0; rounds <= 3; rounds += 1) {
      const oraclePath = join(directory, `round-${rounds}.json`);
      const output = await runAdapterRequest({
        command: [process.execPath, adapterPath, String(rounds), oraclePath],
        timeoutMs: 10_000
      }, { action: 'url-name-round-probe' }, { inheritedEnvironment: INHERITED_ENVIRONMENT });
      const oracle = JSON.parse(await readFile(oraclePath, 'utf8'));
      assertAliasesAbsent(output, [oracle.secret], `URL name round ${rounds}`);
      const endpoint = new URL(output.response.endpoints[0]);
      assert.equal([...endpoint.searchParams.values()].includes(REDACTED), true);
      assert.equal(endpoint.searchParams.get('api-version'), '2026-08-28');
      assert.equal(endpoint.searchParams.get('design'), 'ordinary');
    }

    const oraclePath = join(directory, 'round-4.json');
    const failure = await captureFailure({
      command: [process.execPath, adapterPath, '4', oraclePath],
      timeoutMs: 10_000
    }, { action: 'url-name-round-exhaustion-probe' });
    const oracle = JSON.parse(await readFile(oraclePath, 'utf8'));
    assertClosedBudgetError(failure, [oracle.secret, oracle.endpoint, oracle.name]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('credential-name normalization is authoritative and bounded across text, fields, flags, and URL queries', () => {
  const channels = ['assignment', 'header', 'flag', 'url-query', 'object-field'];
  let caseIndex = 0;
  for (const channel of channels) {
    for (let rounds = 1; rounds <= 3; rounds += 1) {
      const credentialName = rounds % 2 === 0 ? 'signature' : 'sig';
      const name = encodedCredentialName(credentialName, rounds);
      const value = rounds === 1
        ? String.fromCodePoint(0xE100 + caseIndex)
        : `ENCODED_NAME_${channel.replace('-', '_').toUpperCase()}_ROUND_${rounds}_LONG_VALUE`;
      const artifact = encodedNameArtifact(channel, name, value);
      const sanitized = redactConfiguredSecrets(artifact);
      assertAliasesAbsent(sanitized, [value], `${channel} round ${rounds}`);
      assert.equal(JSON.stringify(sanitized).includes('sibling-before<[REDACTED]>sibling-after'), true);
      caseIndex += 1;
    }
  }

  for (const [name, value] of [
    ['s%69g', 'EXACT_REVIEWER_SIG_VALUE'],
    ['sign%61ture', 'EXACT_REVIEWER_SIGNATURE_VALUE']
  ]) {
    const sanitized = redactConfiguredSecrets(encodedNameArtifact('assignment', name, value));
    assertAliasesAbsent(sanitized, [value], `exact reviewer probe ${name}`);
  }

  const ambiguousNames = [
    ['malformed', 'sig%ZZ'],
    ['truncated', 'signature%'],
    ['mixed', 's%69g%ZZ'],
    ['fourth-round', encodedCredentialName('signature', 4)]
  ];
  for (const channel of channels) {
    for (const [label, name] of ambiguousNames) {
      const value = `AMBIGUOUS_${channel.replace('-', '_').toUpperCase()}_${label.replace('-', '_').toUpperCase()}_VALUE`;
      const artifact = encodedNameArtifact(channel, name, value);
      let failure;
      try {
        redactConfiguredSecrets(artifact);
      } catch (error) {
        failure = error;
      }
      assertClosedBudgetError(failure, [name, value, JSON.stringify(artifact)]);
    }
  }

  const harmless = {
    'completion%rate': 'ordinary-percent-name',
    'build%2Glabel': 'ordinary-malformed-percent-name',
    'discount%25off': 'ordinary-escaped-percent-name',
    'public%4Bey': 'PUBLIC-KEY-MATERIAL',
    'design%54oken': 'design-token-safe',
    'pagination%54oken': 'pagination-token-safe',
    diagnostic: 'completion%rate=ordinary assignment ; build%2Glabel: ordinary header',
    argv: [
      'provider-cli',
      '--completion%rate', 'ordinary-flag-value',
      '--public%4Bey', 'PUBLIC-FLAG-MATERIAL',
      '--design%54oken', 'design-flag-safe',
      '--pagination%54oken', 'pagination-flag-safe'
    ],
    endpoint: 'https://provider.example.invalid/v1?completion%25rate=ordinary-query-value&public%4Bey=PUBLIC-QUERY-MATERIAL&design%54oken=design-query-safe&pagination%54oken=pagination-query-safe&api-version=2026-08-28'
  };
  assert.deepEqual(redactConfiguredSecrets(harmless), harmless);
});

test('encoded credential names sanitize short and long sibling echoes across every retained execution artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-encoded-name-artifacts-'));
  try {
    const adapterPath = join(directory, 'encoded-name-adapter.mjs');
    await writeFile(adapterPath, String.raw`
      import { writeFileSync } from 'node:fs';
      for await (const _chunk of process.stdin) {}
      const mode = process.argv[2];
      const oraclePath = process.argv[3];
      const encodeName = (value, rounds) => {
        let encoded = '%' + value.codePointAt(0).toString(16).padStart(2, '0') + value.slice(1);
        for (let round = 1; round < rounds; round += 1) encoded = encodeURIComponent(encoded);
        return encoded;
      };
      const names = [encodeName('sig', 1), encodeName('signature', 2), encodeName('sig', 3)];
      const shortValue = String.fromCodePoint(0xE230 + ['success', 'nonzero', 'malformed', 'timeout'].indexOf(mode));
      const longValue = 'ENCODED_RUNTIME_LONG_' + mode.toUpperCase() + '_CREDENTIAL_VALUE';
      const endpoint = 'https://provider.example.invalid/v1?' + names[2] + '=' + encodeURIComponent(longValue)
        + '&completion%25rate=ordinary-query-value&api-version=2026-08-28';
      const commandMetadata = {
        argv: ['provider-cli', '--' + names[0], shortValue, '--' + names[1] + '=' + longValue]
      };
      const diagnostic = [
        names[0] + '=' + shortValue,
        names[1] + ': ' + longValue,
        JSON.stringify(['--' + names[2], shortValue]),
        endpoint,
        'sibling-short<' + shortValue + '>',
        'sibling-long<' + longValue + '>',
        'sibling-encoded<' + encodeURIComponent(longValue) + '>'
      ].join(' ; ');
      const payload = {
        [names[0]]: shortValue,
        nested: { [names[1]]: longValue },
        commandMetadata,
        endpoint,
        siblingEchoes: [shortValue, longValue, encodeURIComponent(longValue), diagnostic],
        harmless: {
          publicKey: 'PUBLIC-KEY-MATERIAL',
          designToken: 'design-token-safe',
          paginationToken: 'pagination-token-safe',
          'completion%rate': 'ordinary-percent-name',
          apiVersion: '2026-08-28'
        }
      };
      writeFileSync(oraclePath, JSON.stringify({ shortValue, longValue, diagnostic }));
      if (mode === 'success') {
        process.stderr.write('success-stderr ' + diagnostic);
        process.stdout.write(JSON.stringify({
          response: { recommendation: 'safe', payload },
          usage: { totalTokens: 1 },
          toolCalls: 0,
          storageBytes: 0,
          persistedVerified: true,
          logs: ['success-log ' + diagnostic]
        }));
      } else if (mode === 'nonzero') {
        process.stdout.write(JSON.stringify({ error: { payload, diagnostic } }));
        process.stderr.write('nonzero-stderr ' + diagnostic);
        process.exitCode = 31;
      } else if (mode === 'malformed') {
        process.stdout.write('malformed-stdout ' + diagnostic + ' {"broken":');
        process.stderr.write('malformed-stderr ' + diagnostic);
      } else if (mode === 'timeout') {
        process.stdout.write('timeout-stdout ' + diagnostic);
        process.stderr.write('timeout-stderr ' + diagnostic);
        setInterval(() => {}, 1000);
      }
    `, 'utf8');

    const modes = ['success', 'nonzero', 'malformed', 'timeout'];
    const specs = Object.fromEntries(modes.map((mode) => [mode, {
      command: [process.execPath, adapterPath, mode, join(directory, `${mode}-oracle.json`)],
      timeoutMs: mode === 'timeout' ? 800 : 10_000
    }]));
    const request = { action: 'encoded-name-artifact-probe' };
    const success = await runAdapterRequest(specs.success, request, {
      inheritedEnvironment: INHERITED_ENVIRONMENT
    });
    const failures = {
      nonzero: await captureFailure(specs.nonzero, request),
      malformed: await captureFailure(specs.malformed, request),
      timeout: await captureFailure(specs.timeout, request)
    };
    assert.equal(failures.nonzero.exitCode, 31);
    assert.match(failures.malformed.message, /invalid JSON output/u);
    assert.match(failures.timeout.message, /800ms timeout/u);

    const oracles = Object.fromEntries(await Promise.all(modes.map(async (mode) => [
      mode,
      JSON.parse(await readFile(join(directory, `${mode}-oracle.json`), 'utf8'))
    ])));
    assertAliasesAbsent(success, [oracles.success.shortValue, oracles.success.longValue], 'encoded-name success');
    assert.deepEqual(success.response.payload.harmless, {
      publicKey: 'PUBLIC-KEY-MATERIAL',
      designToken: 'design-token-safe',
      paginationToken: 'pagination-token-safe',
      'completion%rate': 'ordinary-percent-name',
      apiVersion: '2026-08-28'
    });
    for (const [mode, error] of Object.entries(failures)) {
      assertAliasesAbsent(retainedError(error), [oracles[mode].shortValue, oracles[mode].longValue], `${mode} error`);
    }

    const raw = {
      schemaVersion: 1,
      measurements: [success],
      failures: Object.fromEntries(Object.entries(failures).map(([mode, error]) => [mode, retainedError(error)]))
    };
    const aggregate = { schemaVersion: 1, generatedFromRaw: true, raw };
    const rawPath = join(directory, 'raw-run.json');
    const aggregatePath = join(directory, 'aggregate.json');
    await writeFile(rawPath, JSON.stringify(raw), 'utf8');
    await writeFile(aggregatePath, JSON.stringify(aggregate), 'utf8');
    const retained = `${await readFile(rawPath, 'utf8')}\n${await readFile(aggregatePath, 'utf8')}`;
    for (const oracle of Object.values(oracles)) {
      assertAliasesAbsent(retained, [oracle.shortValue, oracle.longValue], 'raw/aggregate encoded-name artifacts');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ambiguous encoded credential names fail closed across success, nonzero, malformed, timeout, raw, and aggregate evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ambiguous-name-artifacts-'));
  try {
    const adapterPath = join(directory, 'ambiguous-name-adapter.mjs');
    await writeFile(adapterPath, String.raw`
      import { writeFileSync } from 'node:fs';
      for await (const _chunk of process.stdin) {}
      const mode = process.argv[2];
      const oraclePath = process.argv[3];
      const values = [
        'MALFORMED_NAME_VALUE_' + mode,
        'TRUNCATED_NAME_VALUE_' + mode,
        'MIXED_NAME_VALUE_' + mode,
        'FOURTH_ROUND_NAME_VALUE_' + mode
      ];
      let fourthName = '%73ignature';
      for (let round = 1; round < 4; round += 1) fourthName = encodeURIComponent(fourthName);
      const marker = 'UNTRUSTED_AMBIGUOUS_ENCODED_NAME_OUTPUT_' + mode;
      const diagnostic = [
        'sig%ZZ=' + values[0],
        'signature%: ' + values[1],
        JSON.stringify(['--s%69g%ZZ', values[2]]),
        'https://provider.example.invalid/v1?' + fourthName + '=' + encodeURIComponent(values[3]),
        marker
      ].join(' ; ');
      writeFileSync(oraclePath, JSON.stringify({ values, marker, diagnostic, fourthName }));
      if (mode === 'success') {
        process.stdout.write(JSON.stringify({
          response: { recommendation: 'unsafe', diagnostic },
          usage: null,
          toolCalls: 0,
          storageBytes: 0,
          persistedVerified: false,
          logs: [diagnostic]
        }));
      } else if (mode === 'nonzero') {
        process.stdout.write(JSON.stringify({ error: diagnostic }));
        process.stderr.write(diagnostic);
        process.exitCode = 37;
      } else if (mode === 'malformed') {
        process.stdout.write(diagnostic + ' {"broken":');
        process.stderr.write(diagnostic);
      } else if (mode === 'timeout') {
        process.stdout.write(diagnostic);
        process.stderr.write(diagnostic);
        setInterval(() => {}, 1000);
      }
    `, 'utf8');

    const modes = ['success', 'nonzero', 'malformed', 'timeout'];
    const expectedExitCodes = { success: 0, nonzero: 37, malformed: 0, timeout: null };
    const retainedFailures = {};
    const allForbidden = [];
    for (const mode of modes) {
      const oraclePath = join(directory, `${mode}-oracle.json`);
      const error = await captureFailure({
        command: [process.execPath, adapterPath, mode, oraclePath],
        timeoutMs: mode === 'timeout' ? 800 : 10_000
      }, { action: 'ambiguous-encoded-name-probe' });
      const oracle = JSON.parse(await readFile(oraclePath, 'utf8'));
      const forbidden = [...oracle.values, oracle.marker, oracle.diagnostic, oracle.fourthName, adapterPath];
      assertClosedBudgetError(error, forbidden);
      assert.equal(error.exitCode, expectedExitCodes[mode]);
      assert.equal(Object.hasOwn(error, 'output'), false);
      assert.equal(Object.hasOwn(error, 'error'), false);
      assert.equal(Object.hasOwn(error, 'value'), false);
      retainedFailures[mode] = retainedError(error);
      allForbidden.push(...forbidden);
    }

    const raw = { schemaVersion: 1, status: 'FAILED', failures: retainedFailures };
    const aggregate = { schemaVersion: 1, status: 'FAILED', generatedFromRaw: true, raw };
    const rawPath = join(directory, 'ambiguous-raw-run.json');
    const aggregatePath = join(directory, 'ambiguous-aggregate.json');
    await writeFile(rawPath, JSON.stringify(raw), 'utf8');
    await writeFile(aggregatePath, JSON.stringify(aggregate), 'utf8');
    const retained = `${await readFile(rawPath, 'utf8')}\n${await readFile(aggregatePath, 'utf8')}`;
    for (const forbidden of allForbidden) {
      assert.equal(retained.includes(forbidden), false, `ambiguous raw/aggregate leaked ${forbidden}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('configured and request collection is iterative, bounded, and fails closed without raw recursion evidence', async () => {
  const marker = 'DEEP_REQUEST_RAW_MARKER_MUST_NOT_SURVIVE';
  let request = { auth: { token: marker } };
  for (let depth = 0; depth < 20_050; depth += 1) request = { child: request };

  const failure = await captureFailure({
    command: [process.execPath, 'adapter-must-not-start.mjs'],
    timeoutMs: 10_000
  }, request);
  assertClosedBudgetError(failure, [marker, 'adapter-must-not-start.mjs']);
});

test('known configured and request secrets of 1-7 characters stay invocation-scoped across every retained artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-configured-short-secrets-'));
  try {
    const configuredAliases = Array.from(
      { length: 7 },
      (_, index) => String.fromCodePoint(0xE400 + index).repeat(index + 1)
    );
    const requestAliases = Array.from(
      { length: 7 },
      (_, index) => index === 5 ? 'abc123' : String.fromCodePoint(0xE500 + index).repeat(index + 1)
    );
    const aliases = [...configuredAliases, ...requestAliases];
    const credentialNames = [
      'TOKEN', 'API_KEY', 'PASSWORD', 'CLIENT_SECRET', 'CREDENTIAL', 'ACCESS_TOKEN', 'SIGNATURE'
    ];
    const adapterPath = join(directory, 'configured-short-secret-adapter.mjs');
    await writeFile(adapterPath, String.raw`
      import { writeFileSync } from 'node:fs';
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const mode = process.argv[2];
      const oraclePath = process.argv[3];
      const credentialNames = [
        'TOKEN', 'API_KEY', 'PASSWORD', 'CLIENT_SECRET', 'CREDENTIAL', 'ACCESS_TOKEN', 'SIGNATURE'
      ];
      const configuredAliases = credentialNames.map((name) => process.env[name]);
      const requestAliases = [
        request.token,
        request.apiKey,
        request.password,
        request.clientSecret,
        request.credential,
        request.api_key,
        request.signature
      ];
      const aliases = [...configuredAliases, ...requestAliases];
      const exact = aliases.map((value, index) => ({ index, recommendation: value }));
      const embedded = aliases.map((value, index) => 'unrelated-' + index + '<' + value + '>-tail');
      const diagnostic = embedded.join(' | ');
      writeFileSync(oraclePath, JSON.stringify({ aliases, exact, embedded }));
      if (mode === 'success') {
        process.stdout.write(JSON.stringify({
          response: { recommendation: exact, explanation: embedded },
          usage: { totalTokens: 1 },
          toolCalls: 0,
          storageBytes: 0,
          persistedVerified: true,
          logs: ['success-log ' + diagnostic]
        }));
        process.stderr.write('success-stderr ' + diagnostic);
      } else if (mode === 'nonzero') {
        process.stdout.write(JSON.stringify({ recommendation: exact, explanation: embedded }));
        process.stderr.write('nonzero-stderr ' + diagnostic);
        process.exitCode = 43;
      } else if (mode === 'malformed') {
        process.stdout.write('malformed-stdout ' + diagnostic + ' {"broken":');
        process.stderr.write('malformed-stderr ' + diagnostic);
      } else if (mode === 'timeout') {
        process.stdout.write('timeout-stdout ' + diagnostic);
        process.stderr.write('timeout-stderr ' + diagnostic);
        setInterval(() => {}, 1000);
      }
    `, 'utf8');

    const environment = Object.fromEntries(credentialNames.map((name, index) => [name, configuredAliases[index]]));
    const request = {
      token: requestAliases[0],
      apiKey: requestAliases[1],
      password: requestAliases[2],
      clientSecret: requestAliases[3],
      credential: requestAliases[4],
      api_key: requestAliases[5],
      signature: requestAliases[6],
      modelMetadata: aliases.map((alias) => `request-model-${alias}-preview`),
      harmless: { token: 1 }
    };
    const modes = ['success', 'nonzero', 'malformed', 'timeout'];
    const specs = Object.fromEntries(modes.map((mode) => [mode, {
      command: [process.execPath, adapterPath, mode, join(directory, `${mode}-oracle.json`)],
      timeoutMs: mode === 'timeout' ? 800 : 10_000,
      environment,
      modelMetadata: aliases.map((alias) => `adapter-model-${alias}-preview`)
    }]));
    const originalRequest = structuredClone(request);
    const originalSpecs = structuredClone(specs);

    const success = await runAdapterRequest(specs.success, request, {
      inheritedEnvironment: INHERITED_ENVIRONMENT
    });
    const failures = {
      nonzero: await captureFailure(specs.nonzero, request),
      malformed: await captureFailure(specs.malformed, request),
      timeout: await captureFailure(specs.timeout, request)
    };
    assert.equal(failures.nonzero.exitCode, 43);
    assert.match(failures.malformed.message, /invalid JSON output/u);
    assert.match(failures.timeout.message, /800ms timeout/u);

    const oracles = Object.fromEntries(await Promise.all(modes.map(async (mode) => [
      mode,
      JSON.parse(await readFile(join(directory, `${mode}-oracle.json`), 'utf8'))
    ])));
    assertAliasesAbsent(success, oracles.success.aliases, 'configured/request short success output');
    for (const [mode, failure] of Object.entries(failures)) {
      assertAliasesAbsent(retainedError(failure), oracles[mode].aliases, `${mode} configured/request short error`);
      assert.equal(Object.hasOwn(failure, 'value'), false);
      assert.equal(Object.hasOwn(failure, 'output'), false);
    }

    const raw = {
      schemaVersion: 1,
      measurements: [success],
      failures: Object.fromEntries(Object.entries(failures).map(([mode, error]) => [mode, retainedError(error)]))
    };
    const aggregate = { schemaVersion: 1, generatedFromRaw: true, raw };
    const rawPath = join(directory, 'configured-short-raw-run.json');
    const aggregatePath = join(directory, 'configured-short-aggregate.json');
    await writeFile(rawPath, JSON.stringify(raw), 'utf8');
    await writeFile(aggregatePath, JSON.stringify(aggregate), 'utf8');
    const retained = `${await readFile(rawPath, 'utf8')}\n${await readFile(aggregatePath, 'utf8')}`;
    for (const oracle of Object.values(oracles)) {
      assertAliasesAbsent(retained, oracle.aliases, 'configured/request short raw/aggregate');
    }

    const independentMetadata = {
      adapterModels: aliases.map((alias) => `adapter-model-${alias}-preview`),
      requestModels: aliases.map((alias) => `request-model-${alias}-preview`),
      versions: aliases,
      token: 1
    };
    assert.deepEqual(
      redactConfiguredSecrets(independentMetadata, specs.success, request),
      independentMetadata,
      'known short aliases must not globally corrupt independent config/model metadata'
    );
    assert.deepEqual(request, originalRequest, 'request input must not be mutated');
    assert.deepEqual(specs, originalSpecs, 'adapter configuration must not be mutated');
    assert.deepEqual(
      redactConfiguredSecrets({ token: 1 }),
      { token: 1 },
      'numeric token 1 remains harmless when string 1 was not configured as a secret'
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function boundaryCredentialName(length, placement = 'suffix') {
  if (placement === 'suffix') return `${'n'.repeat(length - 'signature'.length)}signature`;
  if (placement === 'prefix') return `token${'n'.repeat(length - 'token'.length)}`;
  return 'n'.repeat(length);
}

function boundaryNameArtifact(channel, name, shortValue, longValue) {
  const siblingValues = {
    short: `sibling-short<${shortValue}>`,
    long: `sibling-long<${longValue}>`
  };
  if (channel === 'object-field') {
    return {
      primary: { [name]: shortValue },
      secondary: { [name]: longValue },
      siblingValues
    };
  }
  if (channel === 'assignment') {
    return {
      diagnostic: `${name}="${shortValue}" ; ${name}=${longValue}`,
      siblingValues
    };
  }
  if (channel === 'header') {
    return {
      diagnostic: `${name}: ${shortValue} ; ${name}: ${longValue}`,
      siblingValues
    };
  }
  if (channel === 'args' || channel === 'argv' || channel === 'command') {
    return {
      [channel]: ['provider-cli', `--${name}`, shortValue, `--${name}=${longValue}`],
      siblingValues
    };
  }
  if (channel === 'url') {
    const endpoint = new URL('https://provider.example.invalid/v1');
    endpoint.searchParams.append(name, shortValue);
    endpoint.searchParams.append(name, longValue);
    endpoint.searchParams.set('api-version', '2026-08-28');
    return { endpoint: endpoint.href, siblingValues };
  }
  throw new Error(`Unknown boundary-name channel: ${channel}`);
}

test('credential names are safe at 512 characters and fail closed at every 513+ name channel', () => {
  const channels = ['object-field', 'assignment', 'header', 'args', 'argv', 'command', 'url'];
  const boundedName = boundaryCredentialName(512);
  for (const [index, channel] of channels.entries()) {
    const shortValue = String.fromCodePoint(0xE800 + index);
    const longValue = `BOUNDARY_512_${channel.replace('-', '_').toUpperCase()}_LONG_CREDENTIAL_VALUE`;
    const artifact = boundaryNameArtifact(channel, boundedName, shortValue, longValue);
    const sanitized = redactConfiguredSecrets(artifact);
    assertAliasesAbsent(sanitized, [shortValue, longValue], `512-character ${channel}`);
    assert.match(JSON.stringify(sanitized), /\[REDACTED\]/u);
  }

  const overlongCases = [
    ['suffix-513', boundaryCredentialName(513, 'suffix')],
    ['prefix-513', boundaryCredentialName(513, 'prefix')],
    ['unclassified-513', boundaryCredentialName(513, 'opaque')],
    ['suffix-769', boundaryCredentialName(769, 'suffix')]
  ];
  for (const channel of channels) {
    for (const [label, name] of overlongCases) {
      const shortValue = `OVERLONG_SHORT_${channel}_${label}`;
      const longValue = `OVERLONG_LONG_${channel}_${label}_CREDENTIAL_VALUE`;
      const artifact = boundaryNameArtifact(channel, name, shortValue, longValue);
      let failure;
      try {
        redactConfiguredSecrets(artifact);
      } catch (error) {
        failure = error;
      }
      assertClosedBudgetError(failure, [name, shortValue, longValue, JSON.stringify(artifact)]);
    }
  }
});

test('512 and 513+ credential names close success, nonzero, malformed, timeout, raw, and aggregate artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-adapter-name-lengths-'));
  try {
    const adapterPath = join(directory, 'name-length-adapter.mjs');
    await writeFile(adapterPath, String.raw`
      import { writeFileSync } from 'node:fs';
      for await (const _chunk of process.stdin) {}
      const mode = process.argv[2];
      const length = Number(process.argv[3]);
      const oraclePath = process.argv[4];
      const modes = ['success', 'nonzero', 'malformed', 'timeout'];
      const name = 'n'.repeat(length - 'signature'.length) + 'signature';
      const shortValue = String.fromCodePoint(0xE900 + modes.indexOf(mode) + (length > 512 ? 16 : 0));
      const longValue = 'RUNTIME_NAME_LENGTH_' + length + '_' + mode.toUpperCase() + '_LONG_CREDENTIAL_VALUE';
      const publicValues = [
        'PUBLIC_RUNTIME_SIGNATURE_' + length + '_' + mode,
        'DOCUMENT_RUNTIME_SIGNATURE_' + length + '_' + mode,
        'PROVIDER_RUNTIME_SIGNATURE_' + length + '_' + mode,
        'PUBLIC_RUNTIME_KEY_' + length + '_' + mode
      ];
      const publicEvidence = {
        publicSignature: publicValues[0],
        document_signature: publicValues[1],
        'provider-signature': publicValues[2],
        'public-key': publicValues[3],
        siblingValues: publicValues.map((value) => 'public-sibling<' + value + '>')
      };
      const endpoint = new URL('https://provider.example.invalid/v1');
      endpoint.searchParams.append(name, shortValue);
      endpoint.searchParams.append(name, longValue);
      endpoint.searchParams.set('api-version', '2026-08-28');
      const artifact = {
        objectField: { [name]: shortValue },
        assignmentText: name + '=' + longValue,
        headerText: name + ': ' + shortValue,
        args: ['provider-cli', '--' + name, shortValue, '--' + name + '=' + longValue],
        argv: ['provider-cli', '--' + name, shortValue, '--' + name + '=' + longValue],
        command: ['provider-cli', '--' + name, shortValue, '--' + name + '=' + longValue],
        endpoint: endpoint.href,
        publicEvidence,
        siblingValues: [
          'sibling-short<' + shortValue + '>',
          'sibling-long<' + longValue + '>'
        ]
      };
      const diagnostic = JSON.stringify(artifact);
      writeFileSync(oraclePath, JSON.stringify({
        name,
        shortValue,
        longValue,
        publicValues,
        publicEvidence,
        diagnostic
      }));
      if (mode === 'success') {
        process.stdout.write(JSON.stringify({
          response: { recommendation: 'safe', artifact },
          usage: null,
          toolCalls: 0,
          storageBytes: 0,
          persistedVerified: true,
          logs: [diagnostic]
        }));
        process.stderr.write(diagnostic);
      } else if (mode === 'nonzero') {
        process.stdout.write(JSON.stringify({ error: artifact }));
        process.stderr.write(diagnostic);
        process.exitCode = 61;
      } else if (mode === 'malformed') {
        process.stdout.write('malformed-name-boundary ' + diagnostic + ' {"broken":');
        process.stderr.write(diagnostic);
      } else if (mode === 'timeout') {
        process.stdout.write(JSON.stringify({ timeoutArtifact: artifact }));
        process.stderr.write(diagnostic);
        setInterval(() => {}, 1000);
      }
    `, 'utf8');

    const modes = ['success', 'nonzero', 'malformed', 'timeout'];
    const runMode = async (length, mode) => {
      const oraclePath = join(directory, `${length}-${mode}-oracle.json`);
      const spec = {
        command: [process.execPath, adapterPath, mode, String(length), oraclePath],
        timeoutMs: mode === 'timeout' ? 700 : 10_000
      };
      const result = mode === 'success' && length === 512
        ? await runAdapterRequest(spec, { action: 'name-length-probe' }, {
          inheritedEnvironment: INHERITED_ENVIRONMENT
        })
        : await captureFailure(spec, { action: 'name-length-probe' });
      const oracle = JSON.parse(await readFile(oraclePath, 'utf8'));
      return { oracle, result };
    };

    const bounded = Object.fromEntries(await Promise.all(modes.map(async (mode) => [
      mode,
      await runMode(512, mode)
    ])));
    assertAliasesAbsent(
      bounded.success.result,
      [bounded.success.oracle.shortValue, bounded.success.oracle.longValue],
      '512-character success artifact'
    );
    assert.deepEqual(
      bounded.success.result.response.artifact.publicEvidence,
      bounded.success.oracle.publicEvidence
    );
    for (const mode of ['nonzero', 'malformed', 'timeout']) {
      const { oracle, result } = bounded[mode];
      assert.ok(result instanceof Error);
      assert.equal(result.sanitizationState, 'sanitized');
      assertAliasesAbsent(retainedError(result), [oracle.shortValue, oracle.longValue], `512-character ${mode}`);
      const retained = JSON.stringify(retainedError(result));
      for (const publicValue of oracle.publicValues) {
        assert.equal(retained.includes(publicValue), true, `${mode} dropped public signature sibling evidence`);
      }
    }

    const boundedRaw = {
      schemaVersion: 1,
      measurement: bounded.success.result,
      failures: Object.fromEntries(
        ['nonzero', 'malformed', 'timeout'].map((mode) => [mode, retainedError(bounded[mode].result)])
      )
    };
    const boundedAggregate = { schemaVersion: 1, generatedFromRaw: true, raw: boundedRaw };
    const boundedRetained = JSON.stringify({ boundedRaw, boundedAggregate });
    for (const { oracle } of Object.values(bounded)) {
      assertAliasesAbsent(
        boundedRetained,
        [oracle.shortValue, oracle.longValue],
        '512-character raw/aggregate artifacts'
      );
      for (const publicValue of oracle.publicValues) {
        assert.equal(boundedRetained.includes(publicValue), true, 'raw/aggregate dropped public signature evidence');
      }
    }

    const overlong = Object.fromEntries(await Promise.all(modes.map(async (mode) => [
      mode,
      await runMode(513, mode)
    ])));
    const expectedExitCodes = { success: 0, nonzero: 61, malformed: 0, timeout: null };
    const overlongFailures = {};
    const allForbidden = [];
    for (const mode of modes) {
      const { oracle, result } = overlong[mode];
      const forbidden = [
        oracle.name,
        oracle.shortValue,
        oracle.longValue,
        ...oracle.publicValues,
        oracle.diagnostic,
        adapterPath
      ];
      assertClosedBudgetError(result, forbidden);
      assert.equal(result.exitCode, expectedExitCodes[mode]);
      overlongFailures[mode] = retainedError(result);
      allForbidden.push(...forbidden);
    }

    const overlongRaw = { schemaVersion: 1, status: 'FAILED', failures: overlongFailures };
    const overlongAggregate = { schemaVersion: 1, generatedFromRaw: true, raw: overlongRaw };
    const overlongRetained = JSON.stringify({ overlongRaw, overlongAggregate });
    for (const forbidden of allForbidden) {
      assert.equal(overlongRetained.includes(forbidden), false, `513-character raw/aggregate leaked ${forbidden}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('public/document/provider signatures and public keys stay public while exact authentication signatures remain secret', () => {
  const channels = ['assignment', 'header', 'flag', 'url-query', 'object-field'];
  const publicNames = [
    'publicSignature', 'public_signature', 'public-signature',
    'documentSignature', 'document_signature', 'document-signature',
    'providerSignature', 'provider_signature', 'provider-signature',
    'publicKey', 'public_key', 'public-key'
  ];
  let caseIndex = 0;
  for (const publicName of publicNames) {
    for (let rounds = 0; rounds <= 3; rounds += 1) {
      const name = rounds === 0 ? publicName : encodedCredentialName(publicName, rounds);
      for (const channel of channels) {
        const value = `PUBLIC_SIGNATURE_${caseIndex}_VERIFICATION_MATERIAL`;
        const artifact = encodedNameArtifact(channel, name, value);
        assert.deepEqual(
          redactConfiguredSecrets(artifact),
          artifact,
          `${publicName} round ${rounds} ${channel} must remain public with its sibling evidence`
        );
        caseIndex += 1;
      }
    }
  }

  const authenticationNames = ['sig', 'signature', 'x-amz-signature'];
  for (const authenticationName of authenticationNames) {
    for (let rounds = 0; rounds <= 3; rounds += 1) {
      const name = rounds === 0
        ? authenticationName
        : encodedCredentialName(authenticationName, rounds);
      for (const [channelIndex, channel] of channels.entries()) {
        const value = channelIndex % 2 === 0
          ? String.fromCodePoint(0xEA00 + caseIndex)
          : `AUTHENTICATION_SIGNATURE_${caseIndex}_LONG_SECRET_VALUE`;
        const artifact = encodedNameArtifact(channel, name, value);
        const sanitized = redactConfiguredSecrets(artifact);
        assertAliasesAbsent(
          sanitized,
          [value],
          `${authenticationName} round ${rounds} ${channel} authentication context`
        );
        assert.equal(
          JSON.stringify(sanitized).includes('sibling-before<[REDACTED]>sibling-after'),
          true
        );
        caseIndex += 1;
      }
    }
  }
});
