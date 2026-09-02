import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

import { checkPackage, inspectPackagedText, parseNpmTarball } from '../scripts/check-package.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const fixturePath = 'docs/followup-package-scanner-fixture.md';
const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
const frozenPreregistrationSha256 = '738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac';
const credentialNames = [
  'access_token',
  'auth_token',
  'x-api-key',
  'api-key',
  'apikey',
  'client_secret',
  'password',
  'sig',
  'x-amz-signature'
];

function percentEncodeEveryByte(value) {
  return [...Buffer.from(value, 'utf8')]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');
}

function percentEncodeRounds(value, rounds) {
  let encoded = value;
  for (let round = 0; round < rounds; round += 1) encoded = percentEncodeEveryByte(encoded);
  return encoded;
}

function captureInspectionFailure(text, path = fixturePath) {
  try {
    inspectPackagedText([{ path, content: Buffer.from(text, 'utf8') }]);
  } catch (error) {
    return error;
  }
  return null;
}

function assertCredentialFixtureRejected(line, label) {
  const failure = captureInspectionFailure(line);
  assert.ok(failure instanceof Error, `${label}: injected credential fixture passed`);
  assert.equal(
    failure.message,
    `packaged text policy violations:\n- ${fixturePath}:1 [credential-literal]`,
    `${label}: diagnostic must contain only a relative location and category`
  );
  assert.equal(failure.message.includes(line), false, `${label}: diagnostic disclosed the fixture value`);
  assert.equal(failure.message.includes(repositoryRoot), false, `${label}: diagnostic disclosed the repository root`);
  assert.doesNotMatch(failure.message, /\bat\s+.*check-package|Error:/u, `${label}: diagnostic disclosed a stack`);
}

function assertCredentialFixtureAccepted(line, label) {
  assert.doesNotThrow(
    () => inspectPackagedText([{ path: fixturePath, content: Buffer.from(line, 'utf8') }]),
    `${label}: harmless fixture was rejected`
  );
}

async function actualPackedEntries(t) {
  const destination = await scratchDirectory(t, 'shadowgraph-followup-scanner-pack-');
  const args = ['pack', '--json', '--ignore-scripts', '--pack-destination', destination];
  const options = { cwd: repositoryRoot, maxBuffer: 10 * 1024 * 1024, windowsHide: true };
  const run = process.env.npm_execpath
    ? await execFileAsync(process.execPath, [process.env.npm_execpath, ...args], options)
    : process.platform === 'win32'
      ? await execFileAsync(process.execPath, [
        join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ...args
      ], options)
      : await execFileAsync('npm', args, options);
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

function displayCaseVariant(name, index) {
  if (index % 3 === 0) return name.toUpperCase();
  if (index % 3 === 1) return name.toLowerCase();
  return name.replace(/[A-Za-z]/gu, (character, offset) => (
    offset % 2 === 0 ? character.toUpperCase() : character.toLowerCase()
  ));
}

test('follow-up package scanner rejects raw, encoded, and normalized credential names on every text surface', async (t) => {
  const quotes = ['"', "'", '`', ''];

  for (const [index, baseName] of credentialNames.entries()) {
    const name = displayCaseVariant(baseName, index);
    const suffixName = ['sig', 'x-amz-signature'].includes(baseName) ? name : `provider_${name}`;
    const value = `live-${index}-contest-latest-testnet-value-Q7w9Z2p4`;
    const encodedName = percentEncodeEveryByte(name);
    const encodedValue = percentEncodeEveryByte(value);
    const quote = quotes[index % quotes.length];
    const quotedValue = quote ? `${quote}${value}${quote}` : value;

    const probes = [
      [`${baseName} URL query`, `https://provider.example.invalid/v1?${name}=${value}&api-version=2026-08-28`],
      [`${baseName} encoded URL query`, `https://provider.example.invalid/v1?${encodedName}=${encodedValue}&model=harmless-model`],
      [`${baseName} normalized suffix URL query`, `https://provider.example.invalid/v1?${suffixName}=${value}&version=4.0.0`],
      [`${baseName} header`, `${name}: ${quotedValue}`],
      [`${baseName} encoded header`, `${encodedName}: ${encodedValue}`],
      [`${baseName} assignment`, `${name} = ${quotedValue}`],
      [`${baseName} encoded assignment`, `${encodedName}=${encodedValue}`],
      [`${baseName} normalized suffix assignment`, `${suffixName}: ${quotedValue}`]
    ];

    for (const [label, line] of probes) {
      await t.test(label, () => assertCredentialFixtureRejected(line, label));
    }
  }
});

test('follow-up package scanner rejects quoted and unquoted all-alpha and dotted credential literals', async (t) => {
  const cases = [
    ['double-quoted all-alpha', 'api_key="supersecretcredentialvalue"'],
    ['single-quoted all-alpha', "api_key='supersecretcredentialvalue'"],
    ['backtick-quoted all-alpha', 'api_key=`supersecretcredentialvalue`'],
    ['unquoted uppercase-name all-alpha', 'API_KEY=supersecretcredentialvalue'],
    ['unquoted lowercase-name all-alpha', 'api_key=supersecretcredentialvalue'],
    ['unquoted camel-name all-alpha', 'apiKey=supersecretcredentialvalue'],
    ['unquoted provider property chain', 'api_key=synthetic.live.token'],
    ['unquoted nested property chain', 'client_secret=configuration.credentials.primary'],
    ['quoted dotted provider token', 'auth_token="provider.live.production.token"'],
    ['unquoted JWT', 'access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.publicsignature'],
    ['quoted JWT', 'authorization="eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJwcm9kdWN0aW9uIn0.publicsignature"']
  ];

  for (const [label, line] of cases) {
    await t.test(label, () => assertCredentialFixtureRejected(line, label));
  }
});

test('follow-up package scanner exempts only explicit runtime credential references', async (t) => {
  const accepted = [
    ['POSIX environment variable', 'api_key=$SHADOWGRAPH_API_KEY'],
    ['braced environment variable', 'api_key=${SHADOWGRAPH_API_KEY}'],
    ['quoted braced environment variable', 'api_key="${SHADOWGRAPH_API_KEY}"'],
    ['process environment property', 'api_key=process.env.SHADOWGRAPH_API_KEY'],
    ['quoted process environment property', "api_key='process.env.SHADOWGRAPH_API_KEY'"],
    ['import-meta environment property', 'api_key=import.meta.env.SHADOWGRAPH_API_KEY'],
    ['Windows environment variable', 'api_key=%SHADOWGRAPH_API_KEY%'],
    ['Bearer environment template', 'authorization=Bearer ${SHADOWGRAPH_ACCESS_TOKEN}'],
    ['backtick Bearer environment template', 'authorization=`Bearer ${SHADOWGRAPH_ACCESS_TOKEN}`'],
    ['runtime identifier declaration', 'const token = runtimeToken;'],
    ['runtime call declaration', 'const token = createRuntimeToken();'],
    ['runtime indexed declaration', 'const token = tokens[index];'],
    ['runtime selector declaration', "const token = $('token').value;"],
    ['runtime fallback declaration', 'const apiToken = options.apiToken ?? process.env.SHADOWGRAPH_API_TOKEN;'],
    ['runtime regex declaration', 'const authorization = /^(?:basic|bearer)\\s+(.+)$/iu.exec(candidate);'],
    ['runtime-only template declaration', 'const token = `${process.pid}.${Date.now()}`;']
  ];
  const rejected = [
    ['arbitrary property chain', 'api_key=synthetic.live.token'],
    ['credential object property chain', 'api_key=credentials.primary.apiKey'],
    ['optional property chain', 'api_key=config?.provider?.token'],
    ['function property chain', 'api_key=getConfig().provider.token'],
    ['numeric literal declaration', 'const token = 1234567;'],
    ['quoted literal declaration', 'const token = "hunter2";'],
    ['mixed runtime-literal template declaration', 'const token = `${process.pid}.hunter2`;'],
    ['environment substring', 'api_key=prefix-${SHADOWGRAPH_API_KEY}'],
    ['documented placeholder substring', 'api_key=prefix-use-a-random-token-at-least-16-characters'],
    ['redaction substring', 'api_key=redacted-productioncredentialvalue']
  ];

  for (const [label, line] of accepted) {
    await t.test(`accepts ${label}`, () => assertCredentialFixtureAccepted(line, label));
  }
  for (const [label, line] of rejected) {
    await t.test(`rejects ${label}`, () => assertCredentialFixtureRejected(line, label));
  }
});

test('follow-up package scanner handles credential-name encoding through the supported bound and fails closed beyond it', async (t) => {
  const value = 'productioncredentialvalue';
  for (const rounds of [1, 2, 3, 4, 5]) {
    const name = percentEncodeRounds('api_key', rounds);
    const probes = [
      [`${rounds}-round assignment`, `${name}=${value}`],
      [`${rounds}-round header`, `${name}: ${value}`],
      [`${rounds}-round URL`, `https://provider.example.invalid/v1?${name}=${value}`]
    ];
    for (const [label, line] of probes) {
      await t.test(label, () => assertCredentialFixtureRejected(line, label));
    }
  }

  const ambiguousName = `${percentEncodeRounds('api_key', 2)}%25`;
  await t.test('ambiguous encoded credential name', () => {
    assertCredentialFixtureRejected(`${ambiguousName}=${value}`, 'ambiguous encoded credential name');
  });
});

test('follow-up package scanner fails closed for strict and lenient credential-name decoding beyond the supported bound', async (t) => {
  const value = 'productioncredentialvalue';
  const names = [
    ['six-round strict decode', percentEncodeRounds('api_key', 6)],
    ['seven-round strict decode', percentEncodeRounds('Api.Key', 7)],
    ['six-round lenient decode', `${percentEncodeRounds('API-KEY', 6)}%ZZ`]
  ];

  for (const [nameLabel, name] of names) {
    const probes = [
      [`${nameLabel} assignment`, `${name}=${value}`],
      [`${nameLabel} header`, `${name}: ${value}`],
      [`${nameLabel} URL`, `https://provider.example.invalid/v1?${name}=${value}`]
    ];
    for (const [label, line] of probes) {
      await t.test(label, () => assertCredentialFixtureRejected(line, label));
    }
  }
});

test('follow-up package scanner accepts harmless malformed percent names across credential surfaces', async (t) => {
  const names = [
    'completion%rate',
    'build%2Glabel',
    'discount%25off',
    'public%4Bey'
  ];

  for (const name of names) {
    const probes = [
      [`${name} assignment`, `${name}=x`],
      [`${name} header`, `${name}: x`],
      [`${name} URL`, `https://provider.example.invalid/v1?${name}=x`]
    ];
    await t.test(name, () => {
      for (const [label, line] of probes) assertCredentialFixtureAccepted(line, label);
    });
  }
});

test('follow-up package scanner accepts malformed fragments at every harmless-name position', async (t) => {
  const names = [
    'completionRate',
    'buildLabel',
    'discountOff',
    'publicKey',
    'designToken',
    'paginationToken',
    'publicSignature'
  ];
  const fragments = ['%', '%A', '%ZZ', '%2G', '%25'];

  for (const name of names) {
    for (const fragment of fragments) {
      await t.test(`${name} with ${fragment}`, () => {
        for (let position = 0; position <= name.length; position += 1) {
          const ambiguousName = `${name.slice(0, position)}${fragment}${name.slice(position)}`;
          const label = `${name} ${fragment} at position ${position}`;
          const probes = [
            [`${label} assignment`, `${ambiguousName}=x`],
            [`${label} header`, `${ambiguousName}: x`],
            [`${label} URL`, `https://provider.example.invalid/v1?${ambiguousName}=x`]
          ];
          for (const [probeLabel, line] of probes) assertCredentialFixtureAccepted(line, probeLabel);
        }
      });
    }
  }
});

test('follow-up package scanner rejects malformed and truncated percent escapes at every credential-name position', async (t) => {
  const names = ['api_key', 'API-KEY', 'Api.Key'];
  const malformedEscapes = ['%', '%A', '%ZZ', '%2G'];
  const value = 'x';

  for (const name of names) {
    for (const malformedEscape of malformedEscapes) {
      for (let position = 0; position <= name.length; position += 1) {
        const ambiguousName = `${name.slice(0, position)}${malformedEscape}${name.slice(position)}`;
        const label = `${name} ${malformedEscape} at position ${position}`;
        const probes = [
          [`${label} assignment`, `${ambiguousName}=${value}`],
          [`${label} header`, `${ambiguousName}: ${value}`],
          [`${label} URL`, `https://provider.example.invalid/v1?${ambiguousName}=${value}`]
        ];

        await t.test(label, () => {
          for (const [probeLabel, line] of probes) assertCredentialFixtureRejected(line, probeLabel);
        });
      }
    }
  }
});

test('follow-up package scanner rejects mixed valid-invalid escapes and over-bound credential names', async (t) => {
  const names = [
    'api%ZZkey',
    'api%2Gkey',
    'api_key%',
    'api%5F%ZZkey',
    'api%ZZ%5Fkey',
    '%61pi%2Gkey',
    'api%5Fkey%',
    'token%25%2G',
    `${percentEncodeRounds('Api.Key', 2)}%A`,
    percentEncodeRounds('api_key', 4),
    percentEncodeRounds('API-KEY', 5)
  ];

  for (const [index, name] of names.entries()) {
    const value = String(index + 1);
    const probes = [
      [`mixed/over-bound name ${index} assignment`, `${name}=${value}`],
      [`mixed/over-bound name ${index} header`, `${name}: ${value}`],
      [`mixed/over-bound name ${index} URL`, `https://provider.example.invalid/v1?${name}=${value}`]
    ];
    await t.test(`mixed/over-bound name ${index}`, () => {
      for (const [label, line] of probes) assertCredentialFixtureRejected(line, label);
    });
  }
});

test('follow-up package scanner rejects every 1-7 character unquoted literal across credential surfaces', async (t) => {
  const surfaces = [
    ['lowercase underscore assignment', (value) => `api_key=${value}`],
    ['uppercase hyphen header', (value) => `API-KEY: ${value}`],
    ['mixed-case dot URL', (value) => `https://provider.example.invalid/v1?Api.Key=${value}`]
  ];

  for (let length = 1; length <= 7; length += 1) {
    const value = 'abcdefg'.slice(0, length);
    await t.test(`${length}-character literal`, () => {
      for (const [surface, makeLine] of surfaces) {
        assertCredentialFixtureRejected(makeLine(value), `${surface}, length ${length}`);
      }
    });
  }

  const reviewerCases = [
    ['six-character API key', 'api_key=abc123'],
    ['seven-character token', 'token=1234567'],
    ['seven-character password', 'password=hunter2']
  ];
  for (const [label, line] of reviewerCases) {
    await t.test(label, () => assertCredentialFixtureRejected(line, label));
  }
});

test('follow-up package scanner recognizes precise normalized credential namespaces across headers, URLs, and assignments', async (t) => {
  const names = [
    'provider.access-token',
    'provider_authToken',
    'x-api-key',
    'service.apiToken',
    'provider-client_secret',
    'databasePassword',
    'private-key',
    'x-amz-signature',
    'credential',
    'secret'
  ];
  const value = 'productioncredentialvalue';

  for (const name of names) {
    const probes = [
      [`${name} header`, `${name}: ${value}`],
      [`${name} assignment`, `${name}=${value}`],
      [`${name} URL`, `https://provider.example.invalid/v1?${name}=${value}`]
    ];
    for (const [label, line] of probes) {
      await t.test(label, () => assertCredentialFixtureRejected(line, label));
    }
  }
});

test('follow-up package scanner preserves public design, pagination, and signature semantics', async (t) => {
  const fields = [
    ['designToken', 'brandprimarycoloralpha'],
    ['paginationToken', 'eyJwYWdlIjoyfQ.next.page'],
    ['publicSignature', 'MEUCIQDk3Fpublicverificationsignature'],
    ['signature', 'MEUCIQDk3Fpublicverificationsignature'],
    ['document_signature', 'sha256-public-verification-signature'],
    ['provider_signature', 'ed25519-public-verification-signature']
  ];

  for (const [name, value] of fields) {
    const probes = [
      [`${name} header`, `${name}: ${value}`],
      [`${name} assignment`, `${name}="${value}"`],
      [`${name} URL`, `https://provider.example.invalid/v1?${name}=${value}`]
    ];
    for (const [label, line] of probes) {
      await t.test(label, () => assertCredentialFixtureAccepted(line, label));
    }
  }
});

test('follow-up package scanner preserves bounded encodings of harmless token and public-signature names', async (t) => {
  const fields = [
    ['publicKey', 'public-material'],
    ['designToken', 'brandprimarycoloralpha'],
    ['paginationToken', 'page'],
    ['publicSignature', 'public-verification'],
    ['signature', 'public-verification']
  ];

  for (const [name, value] of fields) {
    for (const rounds of [1, 2, 3, 4, 5]) {
      const encodedName = percentEncodeRounds(name, rounds);
      const probes = [
        [`${name} ${rounds}-round header`, `${encodedName}: ${value}`],
        [`${name} ${rounds}-round assignment`, `${encodedName}=${value}`],
        [`${name} ${rounds}-round URL`, `https://provider.example.invalid/v1?${encodedName}=${value}`]
      ];
      await t.test(`${name} ${rounds}-round encoding`, () => {
        for (const [label, line] of probes) assertCredentialFixtureAccepted(line, label);
      });
    }
  }
});

test('follow-up package scanner does not treat ordinary substrings as harmless credential values', async (t) => {
  const values = [
    'contest',
    'latest',
    'testnet',
    'contest.latest',
    'contest(testnet)',
    'contest[testnet]',
    'production-contest-winner-Q7w9Z2p4',
    'latest-production-credential-Q7w9Z2p4',
    'testnet-production-credential-Q7w9Z2p4',
    'examplecorp-production-Q7w9Z2p4',
    'sampled-production-Q7w9Z2p4',
    'dummyproof-production-Q7w9Z2p4',
    'placeholderish-production-Q7w9Z2p4',
    'fakeout-production-Q7w9Z2p4',
    'redactedness-production-Q7w9Z2p4',
    'smokestack-production-Q7w9Z2p4',
    'yourself-production-Q7w9Z2p4'
  ];

  for (const value of values) {
    await t.test(value, () => {
      assertCredentialFixtureRejected(`API_KEY = "${value}"`, value);
    });
  }
});

test('follow-up package scanner accepts only exact labelled placeholders and known fake credential values', () => {
  const fixture = [
    'ACCESS_TOKEN="${SHADOWGRAPH_ACCESS_TOKEN}"',
    "auth_token='process.env.SHADOWGRAPH_AUTH_TOKEN'",
    'X-API-KEY=`import.meta.env.SHADOWGRAPH_API_KEY`',
    'api-key="%SHADOWGRAPH_API_KEY%"',
    'apikey="$SHADOWGRAPH_API_KEY"',
    'client_secret="<CLIENT_SECRET>"',
    'PASSWORD="[REDACTED]"',
    'signature="***"',
    'provider_access_token="your-access-token"',
    'AUTH_TOKEN="use-a-random-token-at-least-16-characters"',
    'Authorization: Bearer <token>',
    'Authorization: Bearer use-a-random-token-at-least-16-characters',
    'Authorization: Bearer ***'
  ].join('\n');

  assert.doesNotThrow(() => inspectPackagedText([
    { path: fixturePath, content: Buffer.from(fixture, 'utf8') }
  ]));
});

test('follow-up package scanner preserves harmless URL metadata names', () => {
  const harmless = [
    'https://api.example.invalid/v1?api-version=2026-08-28&model=model-token-preview-v3',
    'https://registry.example.invalid/artifact?version=4.0.0&digest=87cf2ad06882bf2aaf432bd5718f48033447ec5f14e42ad71eaa3c325af32796'
  ].join('\n');

  assert.doesNotThrow(() => inspectPackagedText([
    { path: fixturePath, content: Buffer.from(harmless, 'utf8') }
  ]));
});

test('follow-up package scanner reports one sanitized category for multi-credential lines', () => {
  const line = 'ACCESS_TOKEN="<ACCESS_TOKEN>"; X-Api-Key: \'header-live-R8x0A3q5\'; password=`db-live-S9y1B4r6`; signature=signed-live-T0z2C5s7';
  assertCredentialFixtureRejected(line, 'multi-credential line');
});

test('follow-up package scanner accepts the actual npm pack output', async () => {
  await checkPackage(repositoryRoot);
});

test('follow-up package scanner packs an LF checksum sidecar that verifies the frozen preregistration', async (t) => {
  const entries = await actualPackedEntries(t);
  const preregistration = entries.find((entry) => entry.path === 'benchmark/preregistration.json');
  const sidecar = entries.find((entry) => entry.path === 'benchmark/preregistration.sha256');
  assert.ok(preregistration, 'packed preregistration JSON is missing');
  assert.ok(sidecar, 'packed preregistration checksum sidecar is missing');
  assert.equal(sidecar.content.includes(0x0d), false, 'packed checksum sidecar contains CR bytes');
  assert.equal(
    sidecar.content.toString('utf8'),
    `${frozenPreregistrationSha256}  benchmark/preregistration.json\n`,
    'packed checksum sidecar must preserve the frozen digest text with one LF terminator'
  );
  assert.equal(
    createHash('sha256').update(preregistration.content).digest('hex'),
    frozenPreregistrationSha256,
    'packed preregistration JSON does not match its frozen checksum'
  );
});
