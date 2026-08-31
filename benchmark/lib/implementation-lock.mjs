import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const INPUT_FIELDS = ['repoRoot', 'files', 'models', 'serviceImages'];
const VERIFY_FIELDS = [...INPUT_FIELDS, 'lock'];
const FILE_SPEC_FIELDS = ['role', 'path'];
const MODEL_FIELDS = [
  'kind',
  'modelId',
  'digestKind',
  'weightsDigest',
  'architecture',
  'parameterCount',
  'quantization',
  'contextLength',
  'embeddingDimension'
];
const SERVICE_IMAGE_FIELDS = ['name', 'image', 'digest'];

const SINGLETON_FILE_ROLES = Object.freeze([
  'preregistration',
  'preregistration_sidecar',
  'amendment_001',
  'amendment_001_sidecar',
  'amendment_002',
  'amendment_002_sidecar',
  'runner',
  'validator',
  'aggregator',
  'scorer',
  'competitor_lock',
  'service_manifest',
  'package_manifest',
  'package_lock'
]);
const REPEATABLE_FILE_ROLES = Object.freeze([
  'adapter',
  'helper',
  'runtime',
  'script',
  'acceptance_fixture',
  'test'
]);
const SINGLETON_ROLE_SET = new Set(SINGLETON_FILE_ROLES);
const FILE_ROLES = new Set([...SINGLETON_FILE_ROLES, ...REPEATABLE_FILE_ROLES]);

const SIDECAR_TARGETS = Object.freeze({
  preregistration_sidecar: 'preregistration',
  amendment_001_sidecar: 'amendment_001',
  amendment_002_sidecar: 'amendment_002'
});

const SERVICE_MANIFEST_PATH = 'benchmark/service-images.json';
const SERVICE_MANIFEST_SCHEMA = 'shadowgraph.service-images';
const SERVICE_MANIFEST_VERSION = 1;
const SERVICE_MANIFEST_FIELDS = ['schema', 'version', 'services'];
const SERVICE_MANIFEST_ENTRY_FIELDS = ['name', 'image'];

/**
 * The completeness contract, as one reviewable table.
 *
 * Every tracked repository path that matches a selector is a governed benchmark
 * source and MUST appear in the lock manifest under exactly the matched role;
 * every path that matches nothing MUST NOT appear. Selectors are evaluated in
 * order, so the exact canonical singleton paths win over the tree prefixes that
 * contain them. The table is serialized into the lock so the rule set that was
 * enforced is auditable from the artifact alone, and this module is itself a
 * governed `helper`, so the table cannot change without changing the lock.
 */
const COVERAGE_SELECTORS = Object.freeze([
  { role: 'package_manifest', kind: 'path', value: 'package.json' },
  { role: 'package_lock', kind: 'path', value: 'package-lock.json' },
  { role: 'preregistration', kind: 'path', value: 'benchmark/preregistration.json' },
  { role: 'preregistration_sidecar', kind: 'path', value: 'benchmark/preregistration.sha256' },
  { role: 'amendment_001', kind: 'path', value: 'benchmark/preregistration-amendment-001.json' },
  { role: 'amendment_001_sidecar', kind: 'path', value: 'benchmark/preregistration-amendment-001.sha256' },
  { role: 'amendment_002', kind: 'path', value: 'benchmark/preregistration-amendment-002.json' },
  { role: 'amendment_002_sidecar', kind: 'path', value: 'benchmark/preregistration-amendment-002.sha256' },
  { role: 'runner', kind: 'path', value: 'benchmark/lib/v11-runner.mjs' },
  { role: 'validator', kind: 'path', value: 'benchmark/lib/validate.mjs' },
  { role: 'aggregator', kind: 'path', value: 'benchmark/lib/aggregate.mjs' },
  { role: 'scorer', kind: 'path', value: 'benchmark/lib/scoring.mjs' },
  { role: 'competitor_lock', kind: 'path', value: 'benchmark/competitors.lock.json' },
  { role: 'service_manifest', kind: 'path', value: SERVICE_MANIFEST_PATH },
  { role: 'adapter', kind: 'prefix', value: 'benchmark/adapters/' },
  { role: 'acceptance_fixture', kind: 'prefix', value: 'benchmark/acceptance/' },
  { role: 'helper', kind: 'prefix', value: 'benchmark/' },
  { role: 'test', kind: 'pattern', value: '^test/bench(?:mark)?-[^/]+\\.test\\.js$' },
  { role: 'helper', kind: 'pattern', value: '^scripts/(?:validate-)?bench-[^/]+\\.mjs$' },
  { role: 'runtime', kind: 'prefix', value: 'src/' },
  { role: 'script', kind: 'prefix', value: 'scripts/' },
  { role: 'test', kind: 'prefix', value: 'test/' }
].map((selector) => Object.freeze({ ...selector })));

const COMPILED_SELECTORS = COVERAGE_SELECTORS.map((selector) => {
  if (selector.kind === 'path') return { ...selector, matches: (candidate) => candidate === selector.value };
  if (selector.kind === 'prefix') return { ...selector, matches: (candidate) => candidate.startsWith(selector.value) };
  const pattern = new RegExp(selector.value, 'u');
  return { ...selector, matches: (candidate) => pattern.test(candidate) };
});

const CANONICAL_SINGLETON_PATHS = new Map(COVERAGE_SELECTORS
  .filter((selector) => selector.kind === 'path' && SINGLETON_ROLE_SET.has(selector.role))
  .map((selector) => [selector.role, selector.value]));

for (const role of SINGLETON_FILE_ROLES) {
  if (!CANONICAL_SINGLETON_PATHS.has(role)) {
    throw new Error(`Implementation-lock coverage table is missing a canonical path for role: ${role}`);
  }
}

const MODEL_KINDS = Object.freeze(['decision_llm', 'embedding']);
const FULL_SHA256 = /^sha256:[a-f0-9]{64}$/iu;
const BARE_SHA256 = /^[a-f0-9]{64}$/iu;
const GIT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;
const PUBLIC_LABEL = /^[A-Za-z0-9][A-Za-z0-9._+:/@ -]{0,255}$/u;
const PUBLIC_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._+:/@~-]{0,255}$/u;
const PUBLIC_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const NON_PUBLIC_PREFIXES = Object.freeze([
  [115, 107, 45],
  [103, 104, 112, 95],
  [103, 104, 111, 95],
  [103, 104, 117, 95],
  [103, 104, 115, 95],
  [103, 104, 114, 95],
  [103, 105, 116, 104, 117, 98, 95, 112, 97, 116, 95]
].map((codePoints) => String.fromCodePoint(...codePoints)));
const AUTH_SCHEME = String.fromCodePoint(98, 101, 97, 114, 101, 114);
const MUTABLE_LATEST = /(?:^|[/:@])latest(?:$|[/:@])/iu;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) throw new Error(`Missing required ${label} field: ${key}`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
}

function hasNonPublicPrefix(value) {
  const folded = value.toLowerCase();
  return NON_PUBLIC_PREFIXES.some((prefix) => folded.startsWith(prefix))
    || (folded.startsWith(AUTH_SCHEME)
      && (folded.length === AUTH_SCHEME.length || /\s/u.test(folded[AUTH_SCHEME.length])));
}

function assertPublicValue(value, label, pattern = PUBLIC_LABEL) {
  assertNonEmptyString(value, label);
  if (!pattern.test(value)
    || value.includes('://')
    || /:\/\//u.test(value)
    || hasNonPublicPrefix(value)
    || /(?:api[_-]?key|access[_-]?token|authorization)=/iu.test(value)) {
    throw new Error(`${label} must be public non-secret metadata`);
  }
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (isPlainObject(value)) {
    const canonical = {};
    for (const key of Object.keys(value).sort()) canonical[key] = canonicalValue(value[key]);
    return canonical;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('Implementation lock cannot contain non-finite numbers');
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  throw new Error('Implementation lock contains a non-JSON value');
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function portableRepositoryPath(value, label) {
  assertNonEmptyString(value, label);
  if (value.includes('\\')
    || value.includes('\0')
    || value.includes(':')
    || /[<>"|?*\u0000-\u001f]/u.test(value)
    || path.posix.isAbsolute(value)
    || /^[A-Za-z]:[\\/]/u.test(value)) {
    throw new Error(`${label} must be a portable path inside the repository`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')
    || path.posix.normalize(value) !== value) {
    throw new Error(`${label} must be a portable path inside the repository`);
  }
  return value;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** Role a tracked repository path carries under the coverage table, or null when ungoverned. */
function classifyTrackedPath(trackedPath) {
  for (const selector of COMPILED_SELECTORS) {
    if (selector.matches(trackedPath)) return selector.role;
  }
  return null;
}

/** Every governed runtime/review source the repository currently tracks, as path -> role. */
function discoverGovernedSources(trackedPaths) {
  const discovered = new Map();
  for (const trackedPath of trackedPaths) {
    const role = classifyTrackedPath(trackedPath);
    if (role !== null) discovered.set(trackedPath, role);
  }
  return discovered;
}

function coverageFingerprint(discovered) {
  return [...discovered.entries()]
    .map(([trackedPath, role]) => JSON.stringify([role, trackedPath]))
    .sort(compareText)
    .join('\n');
}

function describePaths(paths) {
  return [...paths].sort(compareText).join(', ');
}

async function inspectRepository(repoRoot) {
  assertNonEmptyString(repoRoot, 'repoRoot');
  const resolved = await realpath(path.resolve(repoRoot));
  if (!(await stat(resolved)).isDirectory()) throw new Error('repoRoot must be a directory');

  let topLevel;
  let headCommit;
  let statusOutput;
  let trackedOutput;
  try {
    ({ stdout: topLevel } = await execFile('git', ['-C', resolved, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8'
    }));
    ({ stdout: headCommit } = await execFile('git', ['-C', resolved, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8'
    }));
    ({ stdout: statusOutput } = await execFile('git', [
      '-C', resolved, 'status', '--porcelain=v1', '-z', '--untracked-files=all'
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    ({ stdout: trackedOutput } = await execFile('git', ['-C', resolved, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    }));
  } catch {
    throw new Error('repoRoot must be a readable Git worktree with a committed HEAD');
  }

  const realTopLevel = await realpath(topLevel.trim());
  if (realTopLevel !== resolved) throw new Error('repoRoot must be the Git worktree root');
  if (statusOutput.length !== 0) {
    throw new Error('Repository must be clean before creating or verifying an implementation lock');
  }
  const normalizedHead = headCommit.trim().toLowerCase();
  if (!GIT_COMMIT.test(normalizedHead)) throw new Error('Repository HEAD is not a full immutable commit ID');

  return {
    repoRoot: resolved,
    headCommit: normalizedHead,
    trackedPaths: new Set(trackedOutput.split('\0').filter(Boolean))
  };
}

/**
 * Validate the declared manifest and require it to be exactly the governed
 * source set the repository tracks: canonical singleton paths, correct roles,
 * no omissions, and no declarations outside the governed surface.
 */
function validateFileSpecs(files, discovered) {
  if (!Array.isArray(files)) throw new Error('files must be an array');
  const normalized = [];
  const foldedPaths = new Set();
  const declared = new Map();
  const counts = new Map();

  for (const [index, spec] of files.entries()) {
    assertExactKeys(spec, FILE_SPEC_FIELDS, `files[${index}]`);
    if (!FILE_ROLES.has(spec.role)) throw new Error(`Unknown implementation-lock file role: ${spec.role}`);
    const portablePath = portableRepositoryPath(spec.path, `files[${index}].path`);
    const foldedPath = portablePath.toLowerCase();
    if (foldedPaths.has(foldedPath)) throw new Error(`Duplicate implementation-lock file path: ${portablePath}`);
    foldedPaths.add(foldedPath);
    counts.set(spec.role, (counts.get(spec.role) ?? 0) + 1);
    declared.set(portablePath, spec.role);
    normalized.push({ role: spec.role, path: portablePath });
  }

  for (const entry of normalized) {
    const canonicalPath = CANONICAL_SINGLETON_PATHS.get(entry.role);
    if (canonicalPath !== undefined && entry.path !== canonicalPath) {
      throw new Error(
        `Implementation-lock singleton role must use its canonical path: ${entry.role} must be ${canonicalPath}`
      );
    }
  }

  for (const role of SINGLETON_FILE_ROLES) {
    const count = counts.get(role) ?? 0;
    if (count === 0) throw new Error(`Required implementation-lock file role missing: ${role}`);
    if (count !== 1) throw new Error(`Implementation-lock file role must be unique: ${role}`);
  }
  for (const role of REPEATABLE_FILE_ROLES) {
    if ((counts.get(role) ?? 0) === 0) {
      throw new Error(`Required implementation-lock file role missing: ${role}`);
    }
  }

  const omitted = [...discovered.keys()].filter((trackedPath) => !declared.has(trackedPath));
  if (omitted.length > 0) {
    throw new Error(`Implementation-lock manifest omits tracked governed sources: ${describePaths(omitted)}`);
  }
  for (const entry of normalized) {
    const governedRole = discovered.get(entry.path);
    if (governedRole === undefined) {
      const message = classifyTrackedPath(entry.path) === null
        ? `Implementation-lock manifest declares files outside the governed source surface: ${entry.path}`
        : `Implementation-lock manifest declares files the repository does not track: ${entry.path}`;
      throw new Error(message);
    }
    if (governedRole !== entry.role) {
      throw new Error(
        `Implementation-lock file role does not match its canonical role: ${entry.path} is ${governedRole}, not ${entry.role}`
      );
    }
  }

  return normalized.sort((left, right) => compareText(left.path, right.path) || compareText(left.role, right.role));
}

async function hashManifestFiles(repository, specs) {
  const entries = [];
  const contentBySingletonRole = new Map();
  for (const spec of specs) {
    if (!repository.trackedPaths.has(spec.path)) {
      throw new Error(`Implementation-lock file is missing or not tracked: ${spec.path}`);
    }
    const absolute = path.resolve(repository.repoRoot, ...spec.path.split('/'));
    let fileInfo;
    let realFile;
    try {
      fileInfo = await lstat(absolute);
      realFile = await realpath(absolute);
    } catch {
      throw new Error(`Implementation-lock file is missing: ${spec.path}`);
    }
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || !isInside(repository.repoRoot, realFile)) {
      throw new Error(`Implementation-lock file must be a regular file inside the repository: ${spec.path}`);
    }
    const content = await readFile(realFile);
    entries.push({
      role: spec.role,
      path: spec.path,
      bytes: content.length,
      sha256: sha256(content)
    });
    if (SINGLETON_ROLE_SET.has(spec.role)) contentBySingletonRole.set(spec.role, content);
  }
  validateSidecars(entries, contentBySingletonRole);
  return { entries, contentBySingletonRole };
}

function validateSidecars(entries, contentByRole) {
  const entryByRole = new Map(entries.map((entry) => [entry.role, entry]));
  for (const [sidecarRole, targetRole] of Object.entries(SIDECAR_TARGETS)) {
    const sidecar = contentByRole.get(sidecarRole)?.toString('utf8');
    const match = /^([a-f0-9]{64})  ([^\r\n]+)\n?$/u.exec(sidecar ?? '');
    if (!match) throw new Error(`Hash sidecar has invalid evidence format: ${sidecarRole}`);
    const recordedPath = portableRepositoryPath(match[2], `${sidecarRole} recorded path`);
    const target = entryByRole.get(targetRole);
    const permittedRecordedPaths = new Set([target.path, path.posix.basename(target.path)]);
    if (match[1] !== target.sha256 || !permittedRecordedPaths.has(recordedPath)) {
      throw new Error(`Hash sidecar does not match its target file: ${sidecarRole}`);
    }
  }
}

function normalizeDigest(value, label) {
  assertNonEmptyString(value, label);
  if (!FULL_SHA256.test(value)) {
    throw new Error(`${label} must be a full sha256:<64 hex> digest`);
  }
  return value.toLowerCase();
}

function assertLockableImage(value, label) {
  assertPublicValue(value, label, PUBLIC_IMAGE);
  if (value.includes('@') || BARE_SHA256.test(value) || /^sha256:/iu.test(value)) {
    throw new Error(`${label} must be an image repository/name, not an image ID`);
  }
  if (MUTABLE_LATEST.test(value)) throw new Error('Mutable latest service-image references are forbidden');
}

/**
 * Parse the committed service manifest that grounds service-image completeness.
 *
 * The manifest names every service whose image can influence execution. It
 * carries no digests: digests are operator-supplied run evidence, while the
 * manifest is the reviewed, committed statement of which digests must exist.
 */
function parseServiceManifest(content) {
  if (content === undefined) {
    throw new Error(`Service image manifest is missing: ${SERVICE_MANIFEST_PATH}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error(`Service image manifest is not valid JSON: ${SERVICE_MANIFEST_PATH}`);
  }
  assertExactKeys(parsed, SERVICE_MANIFEST_FIELDS, 'service image manifest');
  if (parsed.schema !== SERVICE_MANIFEST_SCHEMA) {
    throw new Error(`Service image manifest declares an unknown schema: ${String(parsed.schema)}`);
  }
  if (parsed.version !== SERVICE_MANIFEST_VERSION) {
    throw new Error(`Service image manifest version must be ${SERVICE_MANIFEST_VERSION}`);
  }
  if (!Array.isArray(parsed.services) || parsed.services.length === 0) {
    throw new Error('Service image manifest must declare at least one service');
  }

  const required = new Map();
  for (const [index, service] of parsed.services.entries()) {
    assertExactKeys(service, SERVICE_MANIFEST_ENTRY_FIELDS, `service image manifest services[${index}]`);
    assertPublicValue(service.name, `service image manifest services[${index}].name`);
    assertLockableImage(service.image, `service image manifest services[${index}].image`);
    const foldedName = service.name.toLowerCase();
    if (required.has(foldedName)) {
      throw new Error(`Duplicate service in the service image manifest: ${service.name}`);
    }
    required.set(foldedName, { name: service.name, image: service.image });
  }
  return required;
}

/**
 * Validate declared service images and require them to cover the committed
 * manifest exactly: no omitted service, no undeclared extra, no image drift.
 */
function validateServiceImages(serviceImages, modelDigests, requiredServices) {
  if (!Array.isArray(serviceImages) || serviceImages.length === 0) {
    throw new Error('At least one service image digest is required');
  }
  const normalized = [];
  const names = new Set();
  const references = new Set();
  for (const [index, service] of serviceImages.entries()) {
    assertExactKeys(service, SERVICE_IMAGE_FIELDS, `serviceImages[${index}]`);
    assertPublicValue(service.name, `serviceImages[${index}].name`);
    assertLockableImage(service.image, `serviceImages[${index}].image`);
    const digest = normalizeDigest(service.digest, `serviceImages[${index}].digest`);
    if (modelDigests.has(digest)) throw new Error('A digest cannot be reused as both model weights and a service image');
    const foldedName = service.name.toLowerCase();
    const foldedReference = `${service.image.toLowerCase()}@${digest}`;
    if (names.has(foldedName)) throw new Error(`Duplicate service image name: ${service.name}`);
    if (references.has(foldedReference)) throw new Error(`Duplicate service image reference: ${service.image}`);
    names.add(foldedName);
    references.add(foldedReference);
    normalized.push({ name: service.name, image: service.image, digest });
  }

  const declaredByName = new Map(normalized.map((service) => [service.name.toLowerCase(), service]));
  const omitted = [...requiredServices.values()]
    .filter((service) => !declaredByName.has(service.name.toLowerCase()))
    .map((service) => service.name);
  if (omitted.length > 0) {
    throw new Error(
      `Declared service images omit services required by ${SERVICE_MANIFEST_PATH}: ${describePaths(omitted)}`
    );
  }
  const extra = normalized
    .filter((service) => !requiredServices.has(service.name.toLowerCase()))
    .map((service) => service.name);
  if (extra.length > 0) {
    throw new Error(
      `Declared service images include services not required by ${SERVICE_MANIFEST_PATH}: ${describePaths(extra)}`
    );
  }
  for (const service of normalized) {
    const required = requiredServices.get(service.name.toLowerCase());
    if (required.image !== service.image) {
      throw new Error(
        `Declared service image does not match the committed service manifest: ${service.name} `
        + `(declared ${service.image}, required ${required.image})`
      );
    }
  }

  return normalized.sort((left, right) => compareText(left.name, right.name) || compareText(left.image, right.image));
}

function validateModels(models) {
  if (!Array.isArray(models)) throw new Error('models must be an array');
  const normalized = [];
  const kinds = new Set();
  const ids = new Set();
  const digests = new Set();

  for (const [index, model] of models.entries()) {
    assertExactKeys(model, MODEL_FIELDS, `models[${index}]`);
    if (!MODEL_KINDS.includes(model.kind)) throw new Error(`Unknown model kind: ${model.kind}`);
    if (kinds.has(model.kind)) throw new Error(`Duplicate model kind: ${model.kind}`);
    kinds.add(model.kind);
    assertPublicValue(model.modelId, `models[${index}].modelId`, PUBLIC_MODEL_ID);
    if (MUTABLE_LATEST.test(model.modelId)) throw new Error('Mutable latest model references are forbidden');
    if (ids.has(model.modelId.toLowerCase())) throw new Error(`Duplicate model ID: ${model.modelId}`);
    ids.add(model.modelId.toLowerCase());
    if (model.digestKind !== 'model_weights') {
      throw new Error(`models[${index}].digestKind must be model_weights`);
    }
    const weightsDigest = normalizeDigest(model.weightsDigest, `models[${index}].weightsDigest`);
    if (digests.has(weightsDigest)) throw new Error('Model weight digests must be unique across model kinds');
    digests.add(weightsDigest);
    assertPublicValue(model.architecture, `models[${index}].architecture`);
    assertPublicValue(model.quantization, `models[${index}].quantization`);
    assertPositiveSafeInteger(model.parameterCount, `models[${index}].parameterCount`);
    assertPositiveSafeInteger(model.contextLength, `models[${index}].contextLength`);
    if (model.kind === 'embedding') {
      assertPositiveSafeInteger(model.embeddingDimension, `models[${index}].embeddingDimension`);
    } else if (model.embeddingDimension !== null) {
      throw new Error(`models[${index}].embeddingDimension must be null for decision_llm`);
    }
    normalized.push({
      kind: model.kind,
      modelId: model.modelId,
      digestKind: 'model_weights',
      weightsDigest,
      architecture: model.architecture,
      parameterCount: model.parameterCount,
      quantization: model.quantization,
      contextLength: model.contextLength,
      embeddingDimension: model.embeddingDimension
    });
  }

  for (const kind of MODEL_KINDS) {
    if (!kinds.has(kind)) throw new Error(`Required model identity missing: ${kind}`);
  }
  return normalized.sort((left, right) => MODEL_KINDS.indexOf(left.kind) - MODEL_KINDS.indexOf(right.kind));
}

/**
 * Create a deterministic lock from a clean Git worktree.
 *
 * The manifest is not merely validated, it is reconciled: the declared files
 * must be exactly the governed sources the repository tracks, and the declared
 * service images must be exactly the services the committed service manifest
 * requires. The returned object contains no timestamps or absolute paths and
 * binds exact file bytes plus immutable runtime identities.
 */
export async function createImplementationLock(input) {
  assertExactKeys(input, INPUT_FIELDS, 'implementation-lock input');
  const before = await inspectRepository(input.repoRoot);
  const discovered = discoverGovernedSources(before.trackedPaths);
  const specs = validateFileSpecs(input.files, discovered);
  const models = validateModels(input.models);
  const modelDigests = new Set(models.map((model) => model.weightsDigest));
  const { entries: files, contentBySingletonRole } = await hashManifestFiles(before, specs);
  const requiredServices = parseServiceManifest(contentBySingletonRole.get('service_manifest'));
  const serviceImages = validateServiceImages(input.serviceImages, modelDigests, requiredServices);
  const after = await inspectRepository(input.repoRoot);
  if (after.headCommit !== before.headCommit) {
    throw new Error('Repository HEAD changed while creating the implementation lock');
  }
  if (coverageFingerprint(discoverGovernedSources(after.trackedPaths)) !== coverageFingerprint(discovered)) {
    throw new Error('Governed runtime/review sources changed while creating the implementation lock');
  }

  const core = {
    schema: 'shadowgraph.implementation-lock',
    version: 2,
    repository: { headCommit: before.headCommit },
    coverage: {
      serviceManifest: SERVICE_MANIFEST_PATH,
      selectors: COVERAGE_SELECTORS.map((selector) => ({
        role: selector.role,
        kind: selector.kind,
        value: selector.value
      }))
    },
    files,
    models,
    serviceImages
  };
  const lock = {
    ...core,
    lockSha256: sha256(Buffer.from(canonicalStringify(core), 'utf8'))
  };
  return deepFreeze(lock);
}

/**
 * Recreate the expected lock from current bytes and explicit runtime evidence,
 * then require byte-for-byte canonical agreement with the supplied lock.
 */
export async function verifyImplementationLock(input) {
  assertExactKeys(input, VERIFY_FIELDS, 'implementation-lock verification input');
  if (!isPlainObject(input.lock)) throw new Error('lock must be an implementation-lock object');
  const expected = await createImplementationLock({
    repoRoot: input.repoRoot,
    files: input.files,
    models: input.models,
    serviceImages: input.serviceImages
  });
  if (canonicalStringify(input.lock) !== canonicalStringify(expected)) {
    throw new Error('Implementation lock does not match current bytes and evidence');
  }
  return deepFreeze({ valid: true, lockSha256: expected.lockSha256 });
}
