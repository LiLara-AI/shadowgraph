import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const execFileAsync = promisify(execFile);
const gunzipAsync = promisify(gunzip);
const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const forbiddenPattern = /(^|\/)(?:__pycache__|node_modules|\.npm-cache|\.shadowgraph|\.hermes|\.claude|\.codex|\.cursor|coverage|test|\.github|docs\/handoffs|benchmark\/results)(\/|$)|(^|\/)(?:RELEASE_CHECKLIST\.md|docs-v030-acceptance\.md)$|\.(?:db|sqlite)(?:[-.].*)?$|\.(?:pyc|pyo|pyd|log|tmp)$/i;
const forbiddenBenchmarkArtifactPattern = /^benchmark\/(?:.*\/)?(?:logs|state)(?:\/|$)|^benchmark\/(?:.*\/)?(?:raw-run|journal-raw|run-intent|aggregate|capability-probe)\.json$|^benchmark\/(?:.*\/)?journal-output\.txt$/i;
const windowsProfilePathPattern = /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]+(?:Users|Documents +and +Settings)[\\/]+[^\\/\s"'`<>|]+(?:[\\/]+[^\s"'`<>|]*)?)/iu;
const posixProfilePathPattern = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9_:/])(?:/(?:home|Users)/[^/\s"'\x60<>]+(?:/[^\s"'\x60<>]*)?|/`
  + String.raw`root(?:/[^\s"'\x60<>]*)?)`,
  'u'
);
const windowsTempPathPattern = /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]+(?:Temp|Windows[\\/]+Temp|Users[\\/]+[^\\/\s"'`<>|]+[\\/]+AppData[\\/]+Local[\\/]+Temp)(?:[\\/]|$))/iu;
const posixTempPathPattern = /(?:^|[^A-Za-z0-9_:/])\/(?:tmp|var\/tmp|private\/tmp)(?:\/|$)/u;
const localHermesPathPattern = /(?:^|[^A-Za-z0-9_.-])\.hermes[\\/]|AppData[\\/]Local[\\/]hermes[\\/]|[\\/]hermes[\\/](?:profiles|cache|skills|plugins|cron|memories)[\\/]/iu;
const absoluteRepositoryPathPattern = /(?:[A-Za-z]:[\\/][^\x0D\x0A]*[\\/](?:AI +Projects|repos?|workspaces?)[\\/][^\s"'`<>|]+)|(?:^|[^A-Za-z0-9_:/])\/(?:[^/\s"'`<>]+\/)*(?:repos?|workspaces?)\/[^/\s"'`<>]+/iu;
const webUrlPattern = /https?:\/\/[^\s<>"'`]+/giu;
const namedValuePattern = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9%._-])(?:["'\x60])?([A-Za-z0-9%._-]+)(?:["'\x60])?\s*(?::|=(?![=>]))\s*`
  + String.raw`(?:(["'\x60])([^"'\x60\x0D\x0A]*)\2|((?:Basic|Bearer)\s+(?:\$\{[A-Z_][A-Z0-9_]*\}|<[A-Z_][A-Z0-9_]*>|[^\s,;#}\]"'\x60<>\x0D\x0A]+)|\$\{[A-Z_][A-Z0-9_]*\}|[^,;#}\]\x0D\x0A]+))`,
  'giu'
);
const credentialNameExact = new Set([
  'apikey', 'apitoken', 'accesstoken', 'authtoken', 'authorization',
  'clientsecret', 'credential', 'password', 'passwd', 'privatekey',
  'secret', 'sig', 'token', 'xamzsignature'
]);
const credentialNameSuffixes = Object.freeze([
  'apikey', 'apitoken', 'accesstoken', 'authtoken', 'clientsecret',
  'credential', 'password', 'passwd', 'privatekey', 'secret'
]);
const knownHarmlessCredentialValues = new Set([
  '', 'null', 'none', 'false', 'true', '***', '[redacted]', '<redacted>',
  'redacted', 'example', 'sample', 'dummy', 'placeholder', 'fake', 'changeme',
  'change-me', 'replace-me', 'not-a-secret',
  'use-a-random-token-at-least-16-characters', 'public-beta-smoke-token',
  'bearer use-a-random-token-at-least-16-characters', 'bearer <token>', 'bearer ***'
]);
const environmentCredentialReferencePattern = /^(?:(?:\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%|process\.env\.[A-Z_][A-Z0-9_]*|import\.meta\.env\.[A-Z_][A-Z0-9_]*|<[A-Z_][A-Z0-9_]*>)|(?:Basic|Bearer)\s+\$\{[A-Z_][A-Z0-9_]*\})$/iu;
const labelledCredentialPlaceholderPattern = /^(?:your|example|sample|dummy|fake)[-_ ](?:api[-_ ]?key|api[-_ ]?token|access[-_ ]?token|auth[-_ ]?token|authorization|client[-_ ]?secret|credential|password|passwd|private[-_ ]?key|secret|signature|token)$/iu;
const knownCredentialPatterns = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu
];
const requiredFiles = [
  'README.md',
  'SECURITY.md',
  'RELEASE_NOTES.md',
  'dashboard/index.html',
  'docs/api-reference.md',
  'docs/benchmark-report.md',
  'docs/mcp-compatibility.md',
  'docs/shadowgraph-benchmark-plan.md',
  'docs/unified-memory.md',
  'benchmark/cli.mjs',
  'benchmark/competitors.lock.json',
  'benchmark/lib/adapters.mjs',
  'benchmark/lib/aggregate.mjs',
  'benchmark/lib/capabilities.mjs',
  'benchmark/lib/journal-validation.mjs',
  'benchmark/lib/preregistration.mjs',
  'benchmark/lib/scoring.mjs',
  'benchmark/lib/validate.mjs',
  'benchmark/preregistration.json',
  'benchmark/preregistration.sha256',
  'integrations/claude-code.mcp.json',
  'integrations/codex.mcp.toml',
  'integrations/cursor.mcp.json',
  'integrations/hermes.mcp.yaml',
  'scripts/check-integrations.mjs',
  'scripts/check-package.mjs',
  'scripts/bench-journal.mjs',
  'scripts/smoke-package.mjs',
  'scripts/validate-bench-journal.mjs',
  'src/cli.js',
  'src/mcp.js',
  'src/restore-validation.js'
];

class PackageCheckError extends Error {}

function fail(message) {
  throw new PackageCheckError(message);
}

function normalizeRelativePath(path) {
  return String(path).replaceAll('\\', '/').replace(/^\.\//u, '');
}

function assertSafePackagePath(path) {
  const normalized = normalizeRelativePath(path);
  const segments = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized) || segments.includes('..')) {
    fail('package contains an unsafe absolute or parent-relative path');
  }
  return normalized;
}

function readTarString(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8').trim();
}

function readTarSize(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) {
    let value = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('npm tarball contains an unsupported oversized entry');
    return Number(value);
  }
  const raw = readTarString(buffer, offset, length).replaceAll('\0', '').trim();
  if (!raw) return 0;
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail('npm tarball contains an invalid entry size');
  return value;
}

function parsePaxFields(buffer) {
  const fields = {};
  let offset = 0;
  while (offset < buffer.length) {
    const separator = buffer.indexOf(0x20, offset);
    if (separator < 0) break;
    const length = Number.parseInt(buffer.subarray(offset, separator).toString('ascii'), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > buffer.length) break;
    const record = buffer.subarray(separator + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return fields;
}

function parseNpmTarball(buffer) {
  const entries = [];
  let offset = 0;
  let globalPax = {};
  let nextPax = {};
  let longPath;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = readTarSize(header, 124, 12);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > buffer.length) fail('npm tarball contains a truncated entry');
    const content = buffer.subarray(contentStart, contentEnd);
    const type = String.fromCharCode(header[156] || 0);
    const prefix = readTarString(header, 345, 155);
    const headerName = readTarString(header, 0, 100);
    const headerPath = prefix ? `${prefix}/${headerName}` : headerName;

    if (type === 'g') globalPax = { ...globalPax, ...parsePaxFields(content) };
    else if (type === 'x') nextPax = parsePaxFields(content);
    else if (type === 'L') longPath = readTarString(content, 0, content.length);
    else {
      const archivePath = nextPax.path ?? globalPax.path ?? longPath ?? headerPath;
      if (type === '\0' || type === '0' || type === '') entries.push({ archivePath, content: Buffer.from(content) });
      nextPax = {};
      longPath = undefined;
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function packagedPath(archivePath) {
  const normalized = normalizeRelativePath(archivePath);
  if (!normalized.startsWith('package/')) fail('npm tarball contains an entry outside the package root');
  return assertSafePackagePath(normalized.slice('package/'.length));
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return textDecoder.decode(buffer);
  } catch {
    return null;
  }
}

const maxCredentialNameDecodeRounds = 5;

function decodePercentEscapesStrict(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodePercentEscapesLenient(value) {
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded.replace(/%[0-9A-Fa-f]{2}/gu, (escape) => {
        try {
          return decodeURIComponent(escape);
        } catch {
          return escape;
        }
      });
    }
  });
}

function elideInvalidPercentFragments(value, fragmentLength) {
  let elided = '';
  for (let index = 0; index < value.length;) {
    if (value[index] !== '%') {
      elided += value[index];
      index += 1;
      continue;
    }
    const encodedRun = /^(?:%[0-9A-Fa-f]{2})+/u.exec(value.slice(index))?.[0];
    if (encodedRun) {
      try {
        decodeURIComponent(encodedRun);
        elided += encodedRun;
        index += encodedRun.length;
        continue;
      } catch {
        try {
          decodeURIComponent(encodedRun.slice(0, 3));
          elided += value[index];
          index += 1;
          continue;
        } catch {}
      }
    }
    index += 1;
    for (let offset = 1;
      offset < fragmentLength && index < value.length && value[index] !== '%';
      offset += 1) {
      index += 1;
    }
  }
  return elided;
}

function credentialNameDetails(name) {
  const candidates = new Set([String(name)]);
  let decoded = String(name);
  for (let round = 0; round < maxCredentialNameDecodeRounds && decoded.includes('%'); round += 1) {
    const next = decodePercentEscapesLenient(decoded);
    if (next === decoded) break;
    candidates.add(next);
    decoded = next;
  }
  const ambiguous = decodePercentEscapesStrict(decoded) !== decoded
    || decodePercentEscapesLenient(decoded) !== decoded;
  for (const candidate of [...candidates]) {
    for (const fragmentLength of [1, 2, 3]) {
      candidates.add(elideInvalidPercentFragments(candidate, fragmentLength));
    }
  }
  return {
    ambiguous,
    normalized: [...candidates].map((value) => value.toLowerCase().replaceAll(/[^a-z0-9]/gu, ''))
  };
}

function isCredentialName(name, allowBareKey = false) {
  const details = credentialNameDetails(name);
  return details.ambiguous || details.normalized.some((normalized) => (
    (allowBareKey && normalized === 'key')
    || credentialNameExact.has(normalized)
    || credentialNameSuffixes.some((suffix) => normalized.endsWith(suffix))
  ));
}

function isExplicitRuntimeCredentialIdentifier(value) {
  const candidate = value.trim();
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(candidate) && isCredentialName(candidate);
}

function isRuntimeDeclaration(line, matchIndex) {
  return /^\s*(?:const|let|var)\s+$/u.test(line.slice(0, matchIndex + 1));
}

function isRuntimeDeclarationReference(value, quoted) {
  const candidate = value.trim();
  if (quoted) {
    return /^(?:\$\{[^{}\x0D\x0A]+\})(?:[.:/_-]\$\{[^{}\x0D\x0A]+\})*$/u.test(candidate);
  }
  return /^[A-Za-z_$]/u.test(candidate)
    || /^\/(?:\\.|[^/\x0D\x0A])+\/[a-z]*\.[A-Za-z_$][A-Za-z0-9_$]*\(/u.test(candidate);
}

function isHarmlessCredentialValue(rawValue) {
  const value = String(rawValue).trim();
  if (knownHarmlessCredentialValues.has(value.toLowerCase())) return true;
  if (environmentCredentialReferencePattern.test(value)) return true;
  if (labelledCredentialPlaceholderPattern.test(value)) return true;
  if (/^x{4,}$/iu.test(value)) return true;
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
      return ![...url.searchParams].some(([name, queryValue]) => isCredentialName(name, true) && queryValue);
    }
  } catch {}
  return false;
}

function urlContainsCredential(urlText) {
  try {
    const url = new URL(urlText.replace(/[),.;]+$/u, ''));
    if (url.username || url.password) return true;
    return url.search.slice(1).split('&').some((segment) => {
      if (!segment) return false;
      const equals = segment.indexOf('=');
      const rawName = equals < 0 ? segment : segment.slice(0, equals);
      const pair = new URLSearchParams(segment).entries().next().value ?? ['', ''];
      const [decodedName, value] = pair;
      return (isCredentialName(rawName, true) || isCredentialName(decodedName, true))
        && value
        && !isHarmlessCredentialValue(value);
    });
  } catch {
    return false;
  }
}

function lineViolationCategories(line) {
  const categories = new Set();
  const urls = [...line.matchAll(webUrlPattern)].map((match) => match[0]);
  if (urls.some(urlContainsCredential)) categories.add('credential-literal');
  const withoutWebUrls = line.replace(webUrlPattern, ' ');
  if (windowsProfilePathPattern.test(withoutWebUrls)) categories.add('absolute-windows-profile-path');
  if (posixProfilePathPattern.test(withoutWebUrls)) categories.add('absolute-posix-profile-path');
  if (windowsTempPathPattern.test(withoutWebUrls)) categories.add('absolute-windows-temp-path');
  if (posixTempPathPattern.test(withoutWebUrls)) categories.add('absolute-posix-temp-path');
  if (localHermesPathPattern.test(withoutWebUrls)) categories.add('local-hermes-path');
  if (absoluteRepositoryPathPattern.test(withoutWebUrls)) categories.add('absolute-repository-path');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(line)) categories.add('credential-literal');
  if (/ignored raw/iu.test(line)
    && /(?:tracked|published|packaged) evidence|proves?|supports?|substantiates?/iu.test(line)
    && !/(?:not|never|no)\s+(?:claimed\s+as\s+)?(?:tracked|published|packaged)?\s*evidence/iu.test(line)) {
    categories.add('ignored-raw-evidence-claim');
  }

  for (const match of withoutWebUrls.matchAll(namedValuePattern)) {
    const [name, value] = [match[1], match[3] ?? match[4]];
    const quoted = match[3] !== undefined;
    const declaration = isRuntimeDeclaration(withoutWebUrls, match.index);
    const runtimeReference = declaration
      ? isRuntimeDeclarationReference(value, quoted)
      : (!quoted && isExplicitRuntimeCredentialIdentifier(value));
    if (isCredentialName(name)
      && value.trim().length > 0
      && !runtimeReference
      && !isHarmlessCredentialValue(value)) {
      categories.add('credential-literal');
    }
  }
  for (const pattern of knownCredentialPatterns) {
    for (const match of line.matchAll(pattern)) {
      if (!isHarmlessCredentialValue(match[0])) categories.add('credential-literal');
    }
  }
  return [...categories];
}

function inspectPackagedText(entries) {
  const violations = [];
  for (const entry of entries) {
    const text = decodeText(entry.content);
    if (text === null) continue;
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      for (const category of lineViolationCategories(lines[index])) {
        violations.push({ path: entry.path, line: index + 1, category });
      }
    }
  }
  if (!violations.length) return;
  violations.sort((left, right) => (
    left.path.localeCompare(right.path)
    || left.line - right.line
    || left.category.localeCompare(right.category)
  ));
  fail(`packaged text policy violations:\n${violations.map(({ path, line, category }) => `- ${path}:${line} [${category}]`).join('\n')}`);
}

async function resolveNpmCli() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  if (process.platform !== 'win32') return null;

  const pathDirectories = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates = [
    dirname(process.execPath),
    ...pathDirectories
  ].map((directory) => join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  fail('npm CLI entry point could not be resolved');
}

// npm's own failure text names absolute paths (cwd, cache, tarball destination), and
// this checker must never disclose a local root. Keep the part that identifies the
// fault — exit code, signal, spawn errno, `npm ERR! code <CODE>` — and replace every
// absolute path with a placeholder.
function sanitizeCommandDiagnostic(value) {
  const text = String(value ?? '');
  if (!text) return '';
  return text
    .replace(/[A-Za-z]:[\\/][^\s"'`<>|]*/gu, '<path>')
    .replace(/(^|[\s"'`(<[])\/[^\s"'`<>|]*/gu, '$1<path>')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !/^npm\s+warn\b/iu.test(line))
    .slice(-4)
    .join(' | ')
    .slice(0, 300);
}

function npmFailureReason(error) {
  const parts = [];
  if (typeof error?.code === 'number') parts.push(`exit=${error.code}`);
  else if (typeof error?.code === 'string') parts.push(`errno=${error.code}`);
  if (error?.signal) parts.push(`signal=${error.signal}`);
  const stderr = sanitizeCommandDiagnostic(error?.stderr);
  const stdout = stderr ? '' : sanitizeCommandDiagnostic(error?.stdout);
  if (stderr) parts.push(`stderr=${stderr}`);
  else if (stdout) parts.push(`stdout=${stdout}`);
  if (!parts.length && error?.message) parts.push(sanitizeCommandDiagnostic(error.message));
  return parts.join(' ');
}

async function runNpm(args, cwd) {
  const options = { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true };
  // Resolve OUTSIDE the try: a PackageCheckError raised here already says exactly
  // what went wrong ("npm CLI entry point could not be resolved"), and catching it
  // below replaced that with the generic "npm pack command failed", which is how a
  // Node-20-only packaging failure reached CI with no diagnosable cause.
  const npmCli = await resolveNpmCli();
  try {
    if (npmCli) return await execFileAsync(process.execPath, [npmCli, ...args], options);
    return await execFileAsync('npm', args, options);
  } catch (error) {
    const reason = npmFailureReason(error);
    fail(reason ? `npm pack command failed: ${reason}` : 'npm pack command failed');
  }
}

function parsePackReport(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    fail('npm pack returned invalid JSON');
  }
  if (!Array.isArray(report) || report.length !== 1) fail('npm pack did not return exactly one report');
  return report[0];
}

async function createAndReadPackage(root) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'shadowgraph-package-check-'));
  try {
    const run = await runNpm([
      'pack', '--json', '--ignore-scripts', '--pack-destination', temporaryRoot
    ], root);
    const report = parsePackReport(run.stdout);
    if (!report.filename || basename(report.filename) !== report.filename) fail('npm pack returned an unsafe tarball filename');
    const compressed = await readFile(join(temporaryRoot, report.filename));
    let archive;
    try {
      archive = await gunzipAsync(compressed);
    } catch {
      fail('npm pack returned an unreadable gzip archive');
    }
    const entries = parseNpmTarball(archive).map((entry) => ({
      path: packagedPath(entry.archivePath),
      content: entry.content
    }));
    return { report, entries };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function checkPackage(root = defaultRoot) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lockfile = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));

  if (manifest.version !== lockfile.version || manifest.version !== lockfile.packages?.['']?.version) {
    fail(`package version mismatch: manifest=${manifest.version}, lock=${lockfile.version}, root=${lockfile.packages?.['']?.version}`);
  }
  if (manifest.name !== lockfile.name || manifest.name !== lockfile.packages?.['']?.name) {
    fail(`package name mismatch: manifest=${manifest.name}, lock=${lockfile.name}, root=${lockfile.packages?.['']?.name}`);
  }
  if (typeof manifest.private !== 'boolean') fail('package.json must record an explicit private release decision');

  const { report, entries } = await createAndReadPackage(root);
  const reportFiles = (report.files ?? []).map((item) => assertSafePackagePath(item.path)).sort();
  const files = entries.map((entry) => entry.path).sort();
  if (report.entryCount !== reportFiles.length) {
    fail(`npm pack entry count mismatch: entryCount=${report.entryCount}, files=${reportFiles.length}`);
  }
  if (new Set(files).size !== files.length || JSON.stringify(files) !== JSON.stringify(reportFiles)) {
    fail(`npm pack report/archive file set mismatch: report=${reportFiles.length}, archive=${files.length}`);
  }

  const forbidden = files.filter((file) => forbiddenPattern.test(file) || forbiddenBenchmarkArtifactPattern.test(file));
  if (forbidden.length) fail(`forbidden package artifacts: ${forbidden.join(', ')}`);
  for (const file of requiredFiles) {
    if (!files.includes(file)) fail(`required package file is missing: ${file}`);
  }
  inspectPackagedText(entries);

  console.log(`package metadata and tarball contents valid for ${manifest.name}@${manifest.version} (${files.length} files, private=${manifest.private})`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  checkPackage().catch((error) => {
    const message = error instanceof PackageCheckError ? error.message : 'unexpected package checker failure';
    console.error(`package check failed: ${message}`);
    process.exitCode = 1;
  });
}

export { checkPackage, inspectPackagedText, lineViolationCategories, parseNpmTarball };
