// The credential-literal detector (package policy, scripts/check-package.mjs),
// in one place for every surface that must keep a credential out of what it
// emits: the package gate checks packaged text with it, and host delivery
// (src/delivery.js, PR-30) withholds anything it still flags before stdout.
// Moved from scripts/check-package.mjs; two of its scans were made linear in
// the text with the same results (the percent-escape elision and the runtime
// declaration test), since delivery feeds it stored text of any length.

export const webUrlPattern = /https?:\/\/[^\s<>"'`]+/giu;
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

const maxCredentialNameDecodeRounds = 5;

function decodePercentEscapesStrict(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Escapes are judged without calling decodeURIComponent to see it throw: a run
// decodes exactly when its bytes are well-formed UTF-8, one character after
// another (RFC 3629), and a lone escape exactly when its byte is ASCII.
const escapeByte = (value, at) => Number.parseInt(value.slice(at + 1, at + 3), 16);
const continuation = (byte, low = 0x80, high = 0xbf) => byte >= low && byte <= high;
function utf8Length(bytes, at) {
  const [first, second] = [bytes[at], bytes[at + 1]];
  if (first < 0x80) return 1;
  if (first >= 0xc2 && first <= 0xdf) return continuation(second) ? 2 : 0;
  if (first >= 0xe0 && first <= 0xef) {
    const inRange = continuation(second, first === 0xe0 ? 0xa0 : 0x80, first === 0xed ? 0x9f : 0xbf);
    return inRange && continuation(bytes[at + 2]) ? 3 : 0;
  }
  if (first >= 0xf0 && first <= 0xf4) {
    const inRange = continuation(second, first === 0xf0 ? 0x90 : 0x80, first === 0xf4 ? 0x8f : 0xbf);
    return inRange && continuation(bytes[at + 2]) && continuation(bytes[at + 3]) ? 4 : 0;
  }
  return 0;
}

// For the run of escapes [start, end): whether the run from each of its
// escapes to its end decodes, each answer following from a later one.
function suffixesDecode(value, start, end) {
  const bytes = Array.from({ length: (end - start) / 3 }, (unused, escape) => escapeByte(value, start + escape * 3));
  const whole = new Array(bytes.length + 1).fill(false);
  whole[bytes.length] = true;
  for (let escape = bytes.length - 1; escape >= 0; escape -= 1) {
    const length = utf8Length(bytes, escape);
    whole[escape] = length > 0 && whole[escape + length];
  }
  return whole;
}

export function decodePercentEscapesLenient(value) {
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/gu, (encoded) => (suffixesDecode(encoded, 0, encoded.length)[0]
    ? decodeURIComponent(encoded)
    : encoded.replace(/%[0-9A-Fa-f]{2}/gu, (escape) => (escapeByte(escape, 0) < 0x80 ? String.fromCharCode(escapeByte(escape, 0)) : escape))));
}

// Each escape inside a run is reached at its own `%`, and the run from there
// ends where the whole run ends; so the run is found, and its suffixes
// decoded, once, and the scan stays linear.
function elideInvalidPercentFragments(value, fragmentLength) {
  let elided = '';
  let runStart = 0;
  let runEnd = -1;
  let whole = [];
  const run = /(?:%[0-9A-Fa-f]{2})+/uy;
  for (let index = 0; index < value.length;) {
    if (value[index] !== '%') {
      elided += value[index];
      index += 1;
      continue;
    }
    if (index >= runEnd) {
      run.lastIndex = index;
      const found = run.exec(value);
      if (found) [runStart, runEnd, whole] = [index, index + found[0].length, suffixesDecode(value, index, index + found[0].length)];
    }
    if (index < runEnd) {
      if (whole[(index - runStart) / 3]) {
        elided += value.slice(index, runEnd);
        index = runEnd;
        continue;
      }
      if (escapeByte(value, index) < 0x80) {
        elided += value[index];
        index += 1;
        continue;
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

export function isCredentialName(name, allowBareKey = false) {
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

// Where a name that follows `const`, `let` or `var` at the start of a line may
// begin: from the keyword's end to the end of the spaces after it. Found once
// per line, not once per name.
function declarationSpan(line) {
  const match = /^(\s*(?:const|let|var))\s+/u.exec(line);
  return match ? { from: match[1].length, to: match[0].length } : null;
}

function isRuntimeDeclarationReference(value, quoted) {
  const candidate = value.trim();
  if (quoted) {
    return /^(?:\$\{[^{}\x0D\x0A]+\})(?:[.:/_-]\$\{[^{}\x0D\x0A]+\})*$/u.test(candidate);
  }
  return /^[A-Za-z_$]/u.test(candidate)
    || /^\/(?:\\.|[^/\x0D\x0A])+\/[a-z]*\.[A-Za-z_$][A-Za-z0-9_$]*\(/u.test(candidate);
}

export function isHarmlessCredentialValue(rawValue) {
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

export function urlContainsCredential(urlText) {
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

// The three places the checker has always found a credential literal, kept
// apart so its categories keep their order.
export function credentialUrlIn(line) {
  return [...line.matchAll(webUrlPattern)].some(([url]) => urlContainsCredential(url));
}

export function privateKeyIn(line) {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(line);
}

export function credentialNamedOrKnownIn(line) {
  const withoutWebUrls = line.replace(webUrlPattern, ' ');
  const span = declarationSpan(withoutWebUrls);
  for (const match of withoutWebUrls.matchAll(namedValuePattern)) {
    const [name, value] = [match[1], match[3] ?? match[4]];
    const quoted = match[3] !== undefined;
    const declaration = span !== null && match.index >= span.from && match.index < span.to;
    const runtimeReference = declaration
      ? isRuntimeDeclarationReference(value, quoted)
      : (!quoted && isExplicitRuntimeCredentialIdentifier(value));
    if (isCredentialName(name)
      && value.trim().length > 0
      && !runtimeReference
      && !isHarmlessCredentialValue(value)) {
      return true;
    }
  }
  for (const pattern of knownCredentialPatterns) {
    for (const match of line.matchAll(pattern)) {
      if (!isHarmlessCredentialValue(match[0])) return true;
    }
  }
  return false;
}

export function credentialLiteralIn(line) {
  return credentialUrlIn(line) || privateKeyIn(line) || credentialNamedOrKnownIn(line);
}
