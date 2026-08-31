import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  createImplementationLock,
  verifyImplementationLock
} from '../benchmark/lib/implementation-lock.mjs';

const execFile = promisify(execFileCallback);
const FIXTURE_DATE = '2000-01-01T00:00:00Z';
const SERVICE_MANIFEST_PATH = 'benchmark/service-images.json';

// Every governed source the fixture repository tracks. Completeness is the
// contract under test: this list must stay exactly equal to what the module
// discovers from `git ls-files`, with no omissions and no extras.
const FILE_SPECS = Object.freeze([
  { role: 'package_manifest', path: 'package.json' },
  { role: 'package_lock', path: 'package-lock.json' },
  { role: 'preregistration', path: 'benchmark/preregistration.json' },
  { role: 'preregistration_sidecar', path: 'benchmark/preregistration.sha256' },
  { role: 'amendment_001', path: 'benchmark/preregistration-amendment-001.json' },
  { role: 'amendment_001_sidecar', path: 'benchmark/preregistration-amendment-001.sha256' },
  { role: 'amendment_002', path: 'benchmark/preregistration-amendment-002.json' },
  { role: 'amendment_002_sidecar', path: 'benchmark/preregistration-amendment-002.sha256' },
  { role: 'runner', path: 'benchmark/lib/v11-runner.mjs' },
  { role: 'validator', path: 'benchmark/lib/validate.mjs' },
  { role: 'aggregator', path: 'benchmark/lib/aggregate.mjs' },
  { role: 'scorer', path: 'benchmark/lib/scoring.mjs' },
  { role: 'competitor_lock', path: 'benchmark/competitors.lock.json' },
  { role: 'service_manifest', path: SERVICE_MANIFEST_PATH },
  { role: 'adapter', path: 'benchmark/adapters/fixture-adapter.mjs' },
  { role: 'adapter', path: 'benchmark/adapters/second-adapter.mjs' },
  { role: 'helper', path: 'benchmark/cli.mjs' },
  { role: 'helper', path: 'benchmark/lib/fixture-helper.mjs' },
  { role: 'helper', path: 'benchmark/lib/second-helper.mjs' },
  { role: 'helper', path: 'scripts/bench-fixture.mjs' },
  { role: 'runtime', path: 'src/shadowgraph.js' },
  { role: 'runtime', path: 'src/storage.js' },
  { role: 'script', path: 'scripts/check-package.mjs' },
  { role: 'script', path: 'scripts/smoke-package.mjs' },
  { role: 'acceptance_fixture', path: 'benchmark/acceptance/scenarios.json' },
  { role: 'acceptance_fixture', path: 'benchmark/acceptance/second-scenarios.json' },
  { role: 'test', path: 'test/bench-fixture.test.js' },
  { role: 'test', path: 'test/benchmark-fixture.test.js' },
  { role: 'test', path: 'test/review-fixture.test.js' },
  { role: 'test', path: 'test/runtime-fixture.test.js' }
]);

const MODELS = Object.freeze([
  Object.freeze({
    kind: 'decision_llm',
    modelId: 'fixture-decision-model',
    digestKind: 'model_weights',
    weightsDigest: `sha256:${'a'.repeat(64)}`,
    architecture: 'fixture-transformer',
    parameterCount: 7_000_000_000,
    quantization: 'Q4_K_M',
    contextLength: 8192,
    embeddingDimension: null
  }),
  Object.freeze({
    kind: 'embedding',
    modelId: 'fixture-embedding-model',
    digestKind: 'model_weights',
    weightsDigest: `sha256:${'b'.repeat(64)}`,
    architecture: 'fixture-encoder',
    parameterCount: 137_000_000,
    quantization: 'F16',
    contextLength: 2048,
    embeddingDimension: 768
  })
]);

// The committed service manifest is the ground truth for which services must
// carry a digest; these declarations must cover it exactly.
const MANIFEST_SERVICES = Object.freeze([
  Object.freeze({ name: 'fixture-neo4j', image: 'neo4j:5.26.0' }),
  Object.freeze({ name: 'fixture-qdrant', image: 'qdrant/qdrant:v1.12.4' })
]);

const SERVICE_IMAGES = Object.freeze([
  Object.freeze({ name: 'fixture-neo4j', image: 'neo4j:5.26.0', digest: `sha256:${'c'.repeat(64)}` }),
  Object.freeze({ name: 'fixture-qdrant', image: 'qdrant/qdrant:v1.12.4', digest: `sha256:${'d'.repeat(64)}` })
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function temporaryDirectory(t, prefix = 'shadowgraph-lock-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function git(repository, args, { date = FIXTURE_DATE } = {}) {
  return execFile('git', ['-C', repository, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date
    }
  });
}

async function commitAll(repository, message, date = FIXTURE_DATE) {
  await git(repository, ['add', '--all'], { date });
  await git(repository, [
    '-c', 'user.name=ShadowGraph Fixture',
    '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '--no-gpg-sign', '-m', message
  ], { date });
}

async function writeRepositoryFile(repository, portablePath, content) {
  const absolute = path.join(repository, ...portablePath.split('/'));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

function serviceManifestBytes(services, overrides = {}) {
  return `${JSON.stringify({
    schema: 'shadowgraph.service-images',
    version: 1,
    services,
    ...overrides
  }, null, 2)}\n`;
}

async function writeServiceManifest(repository, services, overrides = {}) {
  await writeRepositoryFile(repository, SERVICE_MANIFEST_PATH, serviceManifestBytes(services, overrides));
}

function fixtureInput(repository) {
  return {
    repoRoot: repository,
    files: FILE_SPECS.map((entry) => ({ ...entry })),
    models: MODELS.map((entry) => ({ ...entry })),
    serviceImages: SERVICE_IMAGES.map((entry) => ({ ...entry }))
  };
}

function withoutPath(input, portablePath) {
  return { ...input, files: input.files.filter((entry) => entry.path !== portablePath) };
}

async function createFixture(t) {
  const base = await temporaryDirectory(t);
  const repository = path.join(base, 'repo');
  await mkdir(repository, { recursive: true });
  await execFile('git', ['-C', repository, 'init', '--quiet']);

  const primaryFiles = new Map([
    ['.gitattributes', '* -text\n'],
    ['package.json', '{"name":"fixture-package"}\n'],
    ['package-lock.json', '{"name":"fixture-package","lockfileVersion":3}\n'],
    ['benchmark/preregistration.json', '{"fixture":"preregistration"}\n'],
    ['benchmark/preregistration-amendment-001.json', '{"fixture":"amendment-001"}\n'],
    ['benchmark/preregistration-amendment-002.json', '{"fixture":"amendment-002"}\n'],
    ['benchmark/lib/v11-runner.mjs', 'export const fixtureRunner = true;\n'],
    ['benchmark/lib/validate.mjs', 'export const fixtureValidator = true;\n'],
    ['benchmark/lib/aggregate.mjs', 'export const fixtureAggregator = true;\n'],
    ['benchmark/lib/scoring.mjs', 'export const fixtureScorer = true;\n'],
    ['benchmark/competitors.lock.json', '{"fixture":"competitors"}\n'],
    ['benchmark/adapters/fixture-adapter.mjs', 'export const fixtureAdapter = true;\n'],
    ['benchmark/adapters/second-adapter.mjs', 'export const secondAdapter = true;\n'],
    ['benchmark/cli.mjs', 'export const fixtureCli = true;\n'],
    ['benchmark/lib/fixture-helper.mjs', 'export const fixtureHelper = true;\n'],
    ['benchmark/lib/second-helper.mjs', 'export const secondHelper = true;\n'],
    ['scripts/bench-fixture.mjs', 'export const fixtureScript = true;\n'],
    ['src/shadowgraph.js', 'export const shadowgraphRuntime = true;\n'],
    ['src/storage.js', 'export const storageRuntime = true;\n'],
    ['scripts/check-package.mjs', 'export const checkPackage = true;\n'],
    ['scripts/smoke-package.mjs', 'export const smokePackage = true;\n'],
    ['benchmark/acceptance/scenarios.json', '[{"id":"ACC_FIXTURE"}]\n'],
    ['benchmark/acceptance/second-scenarios.json', '[{"id":"ACC_SECOND"}]\n'],
    ['test/bench-fixture.test.js', 'export const benchFixtureTest = true;\n'],
    ['test/benchmark-fixture.test.js', 'export const benchmarkFixtureTest = true;\n'],
    ['test/review-fixture.test.js', 'export const reviewFixtureTest = true;\n'],
    ['test/runtime-fixture.test.js', 'export const runtimeFixtureTest = true;\n'],
    // Deliberately outside the governed runtime/review source surface.
    ['docs/notes.md', 'fixture notes\n'],
    ['integrations/example.json', '{"fixture":true}\n']
  ]);

  for (const [portablePath, content] of primaryFiles) {
    await writeRepositoryFile(repository, portablePath, content);
  }
  await writeServiceManifest(repository, MANIFEST_SERVICES.map((entry) => ({ ...entry })));

  const sidecars = [
    [
      'benchmark/preregistration.sha256',
      'benchmark/preregistration.json',
      'benchmark/preregistration.json'
    ],
    [
      'benchmark/preregistration-amendment-001.sha256',
      'benchmark/preregistration-amendment-001.json',
      'preregistration-amendment-001.json'
    ],
    [
      'benchmark/preregistration-amendment-002.sha256',
      'benchmark/preregistration-amendment-002.json',
      'preregistration-amendment-002.json'
    ]
  ];
  for (const [sidecarPath, targetPath, recordedPath] of sidecars) {
    const target = await readFile(path.join(repository, ...targetPath.split('/')));
    await writeRepositoryFile(repository, sidecarPath, `${sha256(target)}  ${recordedPath}\n`);
  }

  await commitAll(repository, 'fixture baseline');
  return { base, repository, input: fixtureInput(repository) };
}

function replaceModel(input, kind, replacement) {
  return {
    ...input,
    models: input.models.map((model) => model.kind === kind ? replacement(model) : { ...model })
  };
}

test('lock is deterministic, comprehensive, path-portable, and verifies in a byte-identical clone', async (t) => {
  const fixture = await createFixture(t);
  const lock = await createImplementationLock(fixture.input);

  const cloneBase = await temporaryDirectory(t, 'shadowgraph-lock-clone-');
  const clone = path.join(cloneBase, 'repo-copy');
  await execFile('git', ['clone', '--quiet', '--no-local', fixture.repository, clone]);
  const cloneInput = fixtureInput(clone);
  cloneInput.files.reverse();
  cloneInput.models.reverse();
  cloneInput.serviceImages.reverse();

  const clonedLock = await createImplementationLock(cloneInput);
  assert.deepEqual(clonedLock, lock, 'input order and clone path must not change the lock');
  assert.equal(lock.schema, 'shadowgraph.implementation-lock');
  assert.equal(lock.version, 2);
  assert.match(lock.repository.headCommit, /^[a-f0-9]{40,64}$/u);
  assert.match(lock.lockSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(new Set(lock.files.map((entry) => entry.role)), new Set(FILE_SPECS.map((entry) => entry.role)));
  assert.deepEqual(
    lock.files.map((entry) => entry.path),
    FILE_SPECS.map((entry) => entry.path).sort(),
    'the lock must bind every governed source, sorted deterministically'
  );
  assert.ok(lock.files.every((entry) => !entry.path.includes('\\') && !path.isAbsolute(entry.path)));
  assert.ok(lock.files.every((entry) => Number.isSafeInteger(entry.bytes) && entry.bytes >= 0));
  assert.ok(lock.files.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256)));

  // The completeness contract itself is serialized so a reviewer can audit it.
  assert.equal(lock.coverage.serviceManifest, SERVICE_MANIFEST_PATH);
  assert.ok(Array.isArray(lock.coverage.selectors) && lock.coverage.selectors.length > 0);
  assert.ok(lock.coverage.selectors.every((selector) =>
    ['path', 'prefix', 'pattern'].includes(selector.kind)
    && typeof selector.value === 'string'
    && typeof selector.role === 'string'));

  // Runtime and review inputs are bound, while unrelated public artifacts stay out.
  const lockedPaths = new Set(lock.files.map((entry) => entry.path));
  for (const requiredPath of [
    'package.json',
    'package-lock.json',
    'src/shadowgraph.js',
    'src/storage.js',
    'scripts/check-package.mjs',
    'scripts/smoke-package.mjs',
    'test/review-fixture.test.js',
    'test/runtime-fixture.test.js'
  ]) {
    assert.ok(lockedPaths.has(requiredPath), `${requiredPath} must be implementation-locked`);
  }
  assert.ok(!lockedPaths.has('docs/notes.md'));
  assert.ok(!lockedPaths.has('integrations/example.json'));

  const serialized = JSON.stringify(lock);
  assert.ok(!serialized.includes(fixture.base));
  assert.ok(!serialized.includes(cloneBase));
  assert.ok(!serialized.includes('authorization'));

  assert.deepEqual(await verifyImplementationLock({ ...cloneInput, lock }), {
    valid: true,
    lockSha256: lock.lockSha256
  });
});

test('file manifest is fail-closed across benchmark, runtime, script, package, and test sources', async (t) => {
  const fixture = await createFixture(t);
  await createImplementationLock(fixture.input);

  const omissions = [
    ['adapter', 'benchmark/adapters/second-adapter.mjs'],
    ['helper', 'benchmark/lib/second-helper.mjs'],
    ['helper', 'benchmark/cli.mjs'],
    ['helper', 'scripts/bench-fixture.mjs'],
    ['runtime', 'src/storage.js'],
    ['script', 'scripts/smoke-package.mjs'],
    ['package manifest', 'package.json'],
    ['package lock', 'package-lock.json'],
    ['acceptance fixture', 'benchmark/acceptance/second-scenarios.json'],
    ['test', 'test/benchmark-fixture.test.js'],
    ['test', 'test/bench-fixture.test.js'],
    ['review test', 'test/review-fixture.test.js'],
    ['competitor lock', 'benchmark/competitors.lock.json'],
    ['service manifest', SERVICE_MANIFEST_PATH]
  ];
  for (const [label, omitted] of omissions) {
    const incomplete = withoutPath(fixture.input, omitted);
    await assert.rejects(
      createImplementationLock(incomplete),
      (error) => error instanceof Error
        && /omits tracked (?:benchmark |governed )?sources|Required implementation-lock file role missing/iu.test(error.message)
        && (error.message.includes(omitted) || error.message.includes('role missing')),
      `omitting the ${label} ${omitted} must fail closed`
    );
  }

  // Dropping every repeatable member of a role must fail closed too.
  for (const role of ['adapter', 'helper', 'runtime', 'script', 'acceptance_fixture', 'test']) {
    const stripped = { ...fixture.input, files: fixture.input.files.filter((entry) => entry.role !== role) };
    await assert.rejects(
      createImplementationLock(stripped),
      /omits tracked (?:benchmark |governed )?sources|Required implementation-lock file role missing/iu,
      `dropping every ${role} must fail closed`
    );
  }
});

test('file manifest is fail-closed against extra, misrouted, and non-canonical declarations', async (t) => {
  const fixture = await createFixture(t);

  // A declared path outside the governed surface is rejected, not silently hashed.
  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      files: [...fixture.input.files, { role: 'helper', path: 'docs/notes.md' }]
    }),
    /outside the governed (?:benchmark )?source surface/iu
  );

  // A governed path declared under the wrong role is rejected.
  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      files: fixture.input.files.map((entry) => entry.path === 'benchmark/cli.mjs'
        ? { ...entry, role: 'adapter' }
        : entry)
    }),
    /canonical role/iu
  );

  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      files: fixture.input.files.map((entry) => entry.path === 'src/shadowgraph.js'
        ? { ...entry, role: 'helper' }
        : entry)
    }),
    /canonical role/iu
  );

  // Singleton roles are pinned to exact canonical paths.
  const nonCanonicalSingletons = [
    ['runner', 'benchmark/lib/decoy-runner.mjs'],
    ['validator', 'benchmark/lib/decoy-validate.mjs'],
    ['aggregator', 'benchmark/lib/decoy-aggregate.mjs'],
    ['scorer', 'benchmark/lib/decoy-scoring.mjs'],
    ['preregistration', 'benchmark/decoy-preregistration.json'],
    ['service_manifest', 'benchmark/decoy-service-images.json'],
    ['package_manifest', 'meta/package.json'],
    ['package_lock', 'meta/package-lock.json']
  ];
  for (const [role, decoyPath] of nonCanonicalSingletons) {
    await assert.rejects(
      createImplementationLock({
        ...fixture.input,
        files: fixture.input.files.map((entry) => entry.role === role ? { ...entry, path: decoyPath } : entry)
      }),
      /canonical path/iu,
      `${role} must be pinned to its canonical path`
    );
  }
});

test('a governed source added after locking invalidates the lock instead of being ignored', async (t) => {
  const fixture = await createFixture(t);
  const lock = await createImplementationLock(fixture.input);

  await writeRepositoryFile(
    fixture.repository,
    'benchmark/adapters/third-adapter.mjs',
    'export const thirdAdapter = true;\n'
  );
  await commitAll(fixture.repository, 'new adapter appears', '2000-01-05T00:00:00Z');

  await assert.rejects(
    createImplementationLock(fixture.input),
    (error) => /omits tracked (?:benchmark |governed )?sources/iu.test(error.message)
      && error.message.includes('benchmark/adapters/third-adapter.mjs')
  );
  await assert.rejects(
    verifyImplementationLock({ ...fixture.input, lock }),
    /omits tracked (?:benchmark |governed )?sources/iu
  );
});

test('new tracked runtime, script, and review-test sources cannot appear outside the manifest', async (t) => {
  const additions = [
    ['src/late-runtime.js', 'export const lateRuntime = true;\n'],
    ['scripts/late-review.mjs', 'export const lateReview = true;\n'],
    ['test/late-review.test.js', 'export const lateReviewTest = true;\n']
  ];

  for (const [portablePath, content] of additions) {
    const fixture = await createFixture(t);
    await writeRepositoryFile(fixture.repository, portablePath, content);
    await commitAll(fixture.repository, `add ${portablePath}`, '2000-01-06T00:00:00Z');
    await assert.rejects(
      createImplementationLock(fixture.input),
      (error) => /omits tracked (?:benchmark |governed )?sources/iu.test(error.message)
        && error.message.includes(portablePath),
      `${portablePath} must become required as soon as Git tracks it`
    );
  }
});

test('verification fails closed for changed bytes, changed evidence, and lock tampering', async (t) => {
  const fixture = await createFixture(t);
  const lock = await createImplementationLock(fixture.input);
  const runnerPath = path.join(fixture.repository, 'benchmark/lib/v11-runner.mjs');

  await writeFile(runnerPath, 'export const fixtureRunner = false;\n');
  await assert.rejects(
    verifyImplementationLock({ ...fixture.input, lock }),
    /repository must be clean/i
  );
  await commitAll(fixture.repository, 'fixture byte change', '2000-01-02T00:00:00Z');
  await assert.rejects(
    verifyImplementationLock({ ...fixture.input, lock }),
    /does not match/i
  );

  const currentLock = await createImplementationLock(fixture.input);
  const changedModels = replaceModel(fixture.input, 'embedding', (model) => ({
    ...model,
    contextLength: model.contextLength + 1
  }));
  await assert.rejects(
    verifyImplementationLock({ ...changedModels, lock: currentLock }),
    /does not match/i
  );

  const tampered = structuredClone(currentLock);
  tampered.files[0].sha256 = 'f'.repeat(64);
  await assert.rejects(
    verifyImplementationLock({ ...fixture.input, lock: tampered }),
    /does not match/i
  );

  const tamperedCoverage = structuredClone(currentLock);
  tamperedCoverage.coverage.selectors = [];
  await assert.rejects(
    verifyImplementationLock({ ...fixture.input, lock: tamperedCoverage }),
    /does not match/i
  );
});

test('creation rejects dirty repositories, missing roles/files, duplicates, and paths outside the repo', async (t) => {
  const fixture = await createFixture(t);

  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      files: fixture.input.files.filter((entry) => entry.role !== 'scorer')
    }),
    /required.*scorer/i
  );
  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      files: fixture.input.files.map((entry) => entry.path === 'benchmark/lib/fixture-helper.mjs'
        ? { ...entry, path: 'benchmark/lib/missing-helper.mjs' }
        : entry)
    }),
    /omits tracked (?:benchmark |governed )?sources|outside the governed (?:benchmark )?source surface/iu
  );
  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      files: [...fixture.input.files, { ...fixture.input.files[0], role: 'helper' }]
    }),
    /duplicate.*path/i
  );
  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      files: fixture.input.files.map((entry) => entry.path === 'benchmark/lib/fixture-helper.mjs'
        ? { ...entry, path: '../outside-helper.mjs' }
        : entry)
    }),
    /outside|portable path/i
  );
  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      files: fixture.input.files.map((entry) => entry.path === 'benchmark/lib/fixture-helper.mjs'
        ? { ...entry, path: 'C:/private/helper.mjs' }
        : entry)
    }),
    /outside|portable path/i
  );

  await writeRepositoryFile(fixture.repository, 'untracked-private.txt', 'must make the repository dirty\n');
  await assert.rejects(createImplementationLock(fixture.input), /repository must be clean/i);
});

test('sidecars must be exact hash evidence for their paired preregistration files', async (t) => {
  const fixture = await createFixture(t);
  const sidecar = path.join(fixture.repository, 'benchmark/preregistration-amendment-002.sha256');
  const target = await readFile(path.join(
    fixture.repository,
    'benchmark/preregistration-amendment-002.json'
  ));
  await writeFile(sidecar, `${'0'.repeat(64)}  preregistration-amendment-002.json\n`);
  await commitAll(fixture.repository, 'mismatched fixture sidecar', '2000-01-03T00:00:00Z');

  await assert.rejects(createImplementationLock(fixture.input), /sidecar.*does not match/i);

  await writeFile(
    sidecar,
    `${sha256(target)}  unrelated/preregistration-amendment-002.json\n`
  );
  await commitAll(fixture.repository, 'misdirected fixture sidecar', '2000-01-04T00:00:00Z');
  await assert.rejects(createImplementationLock(fixture.input), /sidecar.*does not match|recorded path/i);
});

test('model identities require complete immutable weight evidence for exactly both model kinds', async (t) => {
  const fixture = await createFixture(t);

  const incomplete = replaceModel(fixture.input, 'embedding', (model) => {
    const { embeddingDimension: _omitted, ...rest } = model;
    return rest;
  });
  await assert.rejects(createImplementationLock(incomplete), /embeddingDimension/i);

  const mutable = replaceModel(fixture.input, 'decision_llm', (model) => ({
    ...model,
    modelId: 'fixture-model:latest'
  }));
  await assert.rejects(createImplementationLock(mutable), /latest|mutable/i);

  const bareDigest = replaceModel(fixture.input, 'decision_llm', (model) => ({
    ...model,
    weightsDigest: 'a'.repeat(64)
  }));
  await assert.rejects(createImplementationLock(bareDigest), /weightsDigest|sha256/i);

  const imageDigestKind = replaceModel(fixture.input, 'decision_llm', (model) => ({
    ...model,
    digestKind: 'container_image'
  }));
  await assert.rejects(createImplementationLock(imageDigestKind), /model_weights|digestKind/i);

  await assert.rejects(
    createImplementationLock({ ...fixture.input, models: [fixture.input.models[0]] }),
    /embedding.*required|required.*embedding/i
  );

  const duplicated = {
    ...fixture.input,
    models: [...fixture.input.models, { ...fixture.input.models[0], modelId: 'duplicate-decision' }]
  };
  await assert.rejects(createImplementationLock(duplicated), /duplicate.*decision_llm/i);
});

test('service images require public immutable digest references and reject model-digest substitution', async (t) => {
  const fixture = await createFixture(t);
  const [baseImage, otherImage] = fixture.input.serviceImages;

  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      serviceImages: [{ ...baseImage, image: 'neo4j:latest' }, { ...otherImage }]
    }),
    /latest|mutable/i
  );
  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      serviceImages: [{ ...baseImage, digest: 'c'.repeat(64) }, { ...otherImage }]
    }),
    /digest|sha256/i
  );
  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      serviceImages: [{ ...baseImage, image: `sha256:${'d'.repeat(64)}` }, { ...otherImage }]
    }),
    /image.*name|repository|image id/i
  );
  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      serviceImages: [{ ...baseImage, digest: fixture.input.models[0].weightsDigest }, { ...otherImage }]
    }),
    /model.*service|digest.*reused/i
  );
  await assert.rejects(createImplementationLock({ ...fixture.input, serviceImages: [] }), /service image.*required/i);
});

test('declared service images must cover the committed service manifest exactly', async (t) => {
  const fixture = await createFixture(t);
  await createImplementationLock(fixture.input);

  // Omitting an influential service image fails closed.
  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      serviceImages: [{ ...fixture.input.serviceImages[0] }]
    }),
    (error) => /omit|missing/iu.test(error.message) && error.message.includes('fixture-qdrant')
  );

  // Declaring a service the manifest does not require fails closed.
  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      serviceImages: [
        ...fixture.input.serviceImages,
        { name: 'fixture-rogue', image: 'rogue/rogue:1.0.0', digest: `sha256:${'e'.repeat(64)}` }
      ]
    }),
    (error) => /not required by|absent from/iu.test(error.message) && error.message.includes('fixture-rogue')
  );

  // Declaring the right name against the wrong image fails closed.
  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      serviceImages: fixture.input.serviceImages.map((entry) => entry.name === 'fixture-qdrant'
        ? { ...entry, image: 'qdrant/qdrant:v1.11.0' }
        : entry)
    }),
    (error) => /does not match the committed service manifest/iu.test(error.message)
      && error.message.includes('fixture-qdrant')
  );
});

test('the committed service manifest is itself validated and bound to the lock', async (t) => {
  const fixture = await createFixture(t);
  const lock = await createImplementationLock(fixture.input);
  const manifestEntry = lock.files.find((entry) => entry.role === 'service_manifest');
  assert.equal(manifestEntry.path, SERVICE_MANIFEST_PATH);
  assert.match(manifestEntry.sha256, /^[a-f0-9]{64}$/u);

  const rewrite = async (bytes, message, date) => {
    await writeRepositoryFile(fixture.repository, SERVICE_MANIFEST_PATH, bytes);
    await commitAll(fixture.repository, message, date);
  };

  await rewrite('{ not json', 'invalid manifest json', '2000-02-01T00:00:00Z');
  await assert.rejects(createImplementationLock(fixture.input), /service image manifest.*json/iu);

  await rewrite(serviceManifestBytes([]), 'empty manifest', '2000-02-02T00:00:00Z');
  await assert.rejects(createImplementationLock(fixture.input), /at least one service/iu);

  await rewrite(
    serviceManifestBytes(MANIFEST_SERVICES.map((entry) => ({ ...entry })), { schema: 'wrong.schema' }),
    'wrong manifest schema',
    '2000-02-03T00:00:00Z'
  );
  await assert.rejects(createImplementationLock(fixture.input), /service image manifest.*schema/iu);

  await rewrite(
    serviceManifestBytes(MANIFEST_SERVICES.map((entry) => ({ ...entry })), { rogueField: true }),
    'unknown manifest field',
    '2000-02-04T00:00:00Z'
  );
  await assert.rejects(createImplementationLock(fixture.input), /unknown.*service image manifest field/iu);

  await rewrite(
    serviceManifestBytes([{ name: 'fixture-neo4j', image: 'neo4j:latest' }]),
    'mutable manifest image',
    '2000-02-05T00:00:00Z'
  );
  await assert.rejects(createImplementationLock(fixture.input), /latest|mutable/i);

  await rewrite(
    serviceManifestBytes([
      { name: 'fixture-neo4j', image: 'neo4j:5.26.0' },
      { name: 'fixture-neo4j', image: 'neo4j:5.26.1' }
    ]),
    'duplicate manifest service',
    '2000-02-06T00:00:00Z'
  );
  await assert.rejects(createImplementationLock(fixture.input), /duplicate.*service/i);

  // Manifest growth invalidates a previously issued lock rather than passing silently.
  await rewrite(
    serviceManifestBytes([
      ...MANIFEST_SERVICES.map((entry) => ({ ...entry })),
      { name: 'fixture-postgres', image: 'postgres:16.4' }
    ]),
    'manifest grows a service',
    '2000-02-07T00:00:00Z'
  );
  await assert.rejects(
    verifyImplementationLock({ ...fixture.input, lock }),
    (error) => /omit|missing/iu.test(error.message) && error.message.includes('fixture-postgres')
  );
});

test('lock metadata rejects obvious credential material instead of serializing it', async (t) => {
  const fixture = await createFixture(t);
  const secretModel = replaceModel(fixture.input, 'decision_llm', (model) => ({
    ...model,
    modelId: 'sk-proj-fixture-secret'
  }));
  await assert.rejects(createImplementationLock(secretModel), /secret|credential|public/i);

  await assert.rejects(
    createImplementationLock({
      ...fixture.input,
      serviceImages: fixture.input.serviceImages.map((entry) => entry.name === 'fixture-neo4j'
        ? { ...entry, image: 'https://user:password@private.invalid/image:1' }
        : entry)
    }),
    /secret|credential|public|image/i
  );
});
