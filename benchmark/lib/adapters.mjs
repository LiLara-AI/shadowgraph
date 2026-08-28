import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const REDACTED = '[REDACTED]';
const REQUIRED_OUTPUT_FIELDS = [
  'response', 'usage', 'toolCalls', 'storageBytes', 'persistedVerified', 'logs'
];
const INHERITED_ENVIRONMENT_ALLOWLIST = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR'
]);
const SPEC_SECRET_VALUES = Symbol('adapter configured secret values');
const MAX_SECRET_ENCODING_ROUNDS = 3;
const MAX_DISCOVERED_CREDENTIALS = 64;
const MAX_DISCOVERED_SECRET_VARIANTS = 256;
const MAX_DISCOVERED_CREDENTIAL_CHARS = 512;
const MAX_DISCOVERED_CREDENTIAL_NAME_CHARS = 512;
const MAX_DISCOVERED_URL_CHARS = 8192;
const MIN_DISCOVERED_CREDENTIAL_CHARS = 8;
const MAX_DISCOVERY_TEXT_CHARS = 2 * MAX_OUTPUT_BYTES;
const MAX_DISCOVERY_NODES = 20_000;
const MAX_DISCOVERY_DEPTH = 32;
const MAX_DISCOVERY_MATCHES = 512;
const DISCOVERY_COMPLETE = 'complete';
const DISCOVERY_EXHAUSTED = 'exhausted';
const SANITIZATION_COMPLETE = 'sanitized';
const SANITIZATION_AMBIGUOUS = 'ambiguous';
const SANITIZATION_BUDGET_ERROR = 'Adapter output could not be safely sanitized';
const OUTPUT_CREDENTIAL_NAME_CHARACTERS = String.raw`[A-Za-z0-9._%+-]`;
const OUTPUT_POSSIBLE_CREDENTIAL_NAME = String.raw`-{0,2}${OUTPUT_CREDENTIAL_NAME_CHARACTERS}{1,${MAX_DISCOVERED_CREDENTIAL_NAME_CHARS}}`;
const OUTPUT_OVERLONG_CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(?:^|[\s,;{(\[])\s*["']?(?:(?:--|-(?!-))|(?!-))${OUTPUT_CREDENTIAL_NAME_CHARACTERS}{${MAX_DISCOVERED_CREDENTIAL_NAME_CHARS + 1}}${OUTPUT_CREDENTIAL_NAME_CHARACTERS}*["']?\s*(?:=|:)`,
  'iu'
);
const OUTPUT_OVERLONG_CREDENTIAL_ARGUMENT_PATTERN = new RegExp(
  String.raw`(?:^|[,\[])\s*["'](?:--|-(?!-))${OUTPUT_CREDENTIAL_NAME_CHARACTERS}{${MAX_DISCOVERED_CREDENTIAL_NAME_CHARS + 1}}`,
  'iu'
);
const OUTPUT_AUTHORIZATION_PATTERN = new RegExp(
  String.raw`(?:^|[\s,;{(\[])\s*(?=["']?(${OUTPUT_POSSIBLE_CREDENTIAL_NAME})["']?\s*(?:=|:)\s*["']?(?:bearer|basic)\s+([A-Za-z0-9._~+/%=-]+))`,
  'giu'
);
const OUTPUT_CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(?:^|[\s,;{(\[])\s*(?=["']?(${OUTPUT_POSSIBLE_CREDENTIAL_NAME})["']?\s*(?:=|:)\s*(?:"([^"\x0D\x0A]+)"|'([^'\x0D\x0A]+)'|([^\s&,;{}\[\]"']+)))`,
  'giu'
);
const OUTPUT_CREDENTIAL_SEPARATE_ARGUMENT_PATTERN = new RegExp(
  String.raw`(?:^|[,\[])\s*(?=["'](-{1,2}[A-Za-z0-9._%+-]{1,512})["']\s*,\s*(?:"([^"\x0D\x0A]+)"|'([^'\x0D\x0A]+)'|([^\s,\]}]+)))`,
  'giu'
);
const OUTPUT_URL_PATTERN = /\b[A-Za-z][A-Za-z0-9+.-]{1,20}:\/\/[^\s"'<>\\]+/gu;
const CREDENTIAL_QUERY_NAMES = new Set([
  'apikey',
  'auth',
  'authorization',
  'credential',
  'key',
  'passwd',
  'password',
  'secret',
  'sig',
  'signature',
  'token'
]);
const AUTH_RELATED_KEY_PREFIXES = [
  'access', 'api', 'auth', 'authorization', 'client', 'credential', 'encryption',
  'private', 'secret', 'signing'
];
const CREDENTIAL_QUERY_SUFFIXES = [
  'apikey', 'authorization', 'credential', 'passwd', 'password', 'secret',
  'signature', 'token'
];
const ORDINARY_TOKEN_NAMES = new Set([
  'continuationtoken',
  'designtoken',
  'nextpagetoken',
  'pagetoken',
  'paginationtoken',
  'previouspagetoken'
]);
const PUBLIC_SIGNATURE_NAMES = new Set([
  'documentsignature',
  'providersignature',
  'publicsignature'
]);

function addExactSecret(secrets, value) {
  if (typeof value !== 'string' || value.length === 0) return;
  secrets.add(value);
  secrets.add(value.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()));
}

function markDiscoveryExhausted(budget) {
  if (budget) budget.state = DISCOVERY_EXHAUSTED;
}

function decodePercentLeniently(value) {
  let output = '';
  for (let index = 0; index < value.length;) {
    if (value[index] !== '%' || !/^[0-9A-F]{2}$/iu.test(value.slice(index + 1, index + 3))) {
      output += value[index];
      index += 1;
      continue;
    }

    const escapes = [];
    while (value[index] === '%' && /^[0-9A-F]{2}$/iu.test(value.slice(index + 1, index + 3))) {
      escapes.push({ raw: value.slice(index, index + 3), byte: Number.parseInt(value.slice(index + 1, index + 3), 16) });
      index += 3;
    }

    for (let offset = 0; offset < escapes.length;) {
      const first = escapes[offset].byte;
      const length = first <= 0x7f ? 1
        : first >= 0xc2 && first <= 0xdf ? 2
          : first >= 0xe0 && first <= 0xef ? 3
            : first >= 0xf0 && first <= 0xf4 ? 4
              : 0;
      if (length > 0 && offset + length <= escapes.length) {
        try {
          output += new TextDecoder('utf-8', { fatal: true }).decode(
            Uint8Array.from(escapes.slice(offset, offset + length), ({ byte }) => byte)
          );
          offset += length;
          continue;
        } catch {
          // Preserve the first undecodable octet and continue with the bounded run.
        }
      }
      output += escapes[offset].raw;
      offset += 1;
    }
  }
  return output;
}

function decodedCandidates(value) {
  const candidates = [];
  for (const candidate of [value, value.replaceAll('+', ' ')]) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded.length > 0) candidates.push(decoded);
    } catch {
      const decoded = decodePercentLeniently(candidate);
      if (decoded.length > 0 && decoded !== candidate) candidates.push(decoded);
    }
  }
  return candidates;
}

function decodedSecretVariants(value, budget) {
  const variants = new Set([value]);
  let frontier = [value];
  for (let round = 0; round < MAX_SECRET_ENCODING_ROUNDS; round += 1) {
    const next = [];
    for (const current of frontier) {
      for (const decoded of decodedCandidates(current)) {
        if (!variants.has(decoded)) {
          variants.add(decoded);
          next.push(decoded);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  if (frontier.some((current) => decodedCandidates(current).some((decoded) => !variants.has(decoded)))) {
    markDiscoveryExhausted(budget);
  }
  return variants;
}

function addSecretValue(secrets, value, budget) {
  if (typeof value !== 'string' || value.length === 0) return;
  const decoded = decodedSecretVariants(value, budget);
  const authorizationTokens = [];
  for (const variant of decoded) {
    const authorization = /^(?:basic|bearer)\s+(.+)$/iu.exec(variant);
    if (authorization?.[1]) authorizationTokens.push(authorization[1]);
  }
  for (const token of authorizationTokens) {
    for (const variant of decodedSecretVariants(token, budget)) decoded.add(variant);
  }
  for (const variant of decoded) {
    let encoded = variant;
    for (let round = 0; round <= MAX_SECRET_ENCODING_ROUNDS; round += 1) {
      addExactSecret(secrets, encoded);
      addExactSecret(secrets, new URLSearchParams({ value: encoded }).toString().slice('value='.length));
      encoded = encodeURIComponent(encoded);
    }
  }
}

function compactCredentialName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function excludedCredentialName(name) {
  const compact = compactCredentialName(name);
  return compact === 'publickey'
    || PUBLIC_SIGNATURE_NAMES.has(compact)
    || ORDINARY_TOKEN_NAMES.has(compact);
}

function classifyCredentialName(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  const compact = compactCredentialName(name);
  if (excludedCredentialName(name)) return null;
  if (compact === 'credentials' || compact === 'proxyauthorization') return compact;
  if (CREDENTIAL_QUERY_NAMES.has(compact)) return compact;
  if (CREDENTIAL_QUERY_SUFFIXES.some((suffix) => compact.endsWith(suffix))) return compact;
  if (!compact.endsWith('key')) return null;
  const prefix = compact.slice(0, -'key'.length);
  return AUTH_RELATED_KEY_PREFIXES.some((candidate) => prefix.startsWith(candidate)) ? compact : null;
}

function invalidPercentElision(value) {
  if (!value.includes('%')) return null;
  try {
    decodeURIComponent(value);
    return null;
  } catch {
    // Decode valid portions first, then elide only the undecodable percent fragments.
  }
  const decoded = decodePercentLeniently(value);
  let elided = '';
  let removed = false;
  for (let index = 0; index < decoded.length;) {
    if (decoded[index] !== '%') {
      elided += decoded[index];
      index += 1;
      continue;
    }
    removed = true;
    index += 1;
    for (let count = 0; count < 2 && index < decoded.length && /^[A-Za-z0-9]$/u.test(decoded[index]); count += 1) {
      index += 1;
    }
  }
  return removed ? elided : null;
}

function normalizedCredentialName(rawName, budget) {
  if (typeof rawName !== 'string' || rawName.length === 0) return null;
  const initial = rawName.replace(/^-+/u, '').replaceAll('+', ' ');
  if (initial.length > MAX_DISCOVERED_CREDENTIAL_NAME_CHARS) {
    markDiscoveryExhausted(budget);
    return null;
  }
  let frontier = [initial];
  const seen = new Set(frontier);
  let classified = null;
  for (let round = 0; round <= MAX_SECRET_ENCODING_ROUNDS; round += 1) {
    for (const current of frontier) {
      if (current.length > MAX_DISCOVERED_CREDENTIAL_NAME_CHARS) {
        markDiscoveryExhausted(budget);
        return null;
      }
      const invalidElision = invalidPercentElision(current);
      if (invalidElision !== null && classifyCredentialName(invalidElision) !== null) {
        markDiscoveryExhausted(budget);
        return null;
      }
      if (excludedCredentialName(current)) return null;
      const normalized = classifyCredentialName(current);
      if (normalized !== null && classified === null) classified = normalized;
    }

    const next = [];
    for (const current of frontier) {
      for (const decoded of decodedCandidates(current)) {
        if (decoded === current || seen.has(decoded)) continue;
        seen.add(decoded);
        next.push(decoded);
      }
    }
    if (next.length === 0) return classified;
    if (round === MAX_SECRET_ENCODING_ROUNDS) {
      markDiscoveryExhausted(budget);
      return null;
    }
    frontier = next;
  }
  return null;
}

function outputCredentialFieldName(name, budget) {
  return normalizedCredentialName(name, budget) !== null;
}

function credentialArgumentValue(argument, budget) {
  if (typeof argument !== 'string' || !argument.startsWith('-')) return null;
  const separator = argument.indexOf('=');
  if (separator === -1) return null;
  const name = argument.slice(0, separator);
  return credentialArgumentName(name, budget) ? argument.slice(separator + 1) : null;
}

function credentialArgumentName(argument, budget) {
  if (typeof argument !== 'string' || !argument.startsWith('-')) return false;
  return outputCredentialFieldName(argument.split('=', 1)[0].replace(/^-+/u, ''), budget);
}

function newCredentialDiscoveryBudget({
  maxCredentials = MAX_DISCOVERED_CREDENTIALS,
  maxVariants = MAX_DISCOVERED_SECRET_VARIANTS
} = {}) {
  return {
    candidates: new Set(),
    matches: 0,
    maxCredentials,
    maxVariants,
    nodes: 0,
    secretVariants: new Set(),
    variantKeys: new Set(),
    state: DISCOVERY_COMPLETE,
    textChars: 0
  };
}

function addDiscoveredCredential(budget, value) {
  if (budget.state === DISCOVERY_EXHAUSTED || typeof value !== 'string') return;
  const rawCandidate = value.trim();
  const authorization = /^(?:basic|bearer)\s+(.+)$/iu.exec(rawCandidate);
  const candidate = authorization?.[1] ?? rawCandidate;
  if (candidate.length === 0) return;
  if (candidate.length > MAX_DISCOVERED_CREDENTIAL_CHARS) {
    markDiscoveryExhausted(budget);
    return;
  }
  if (!budget.candidates.has(candidate)) {
    if (budget.candidates.size >= budget.maxCredentials) {
      markDiscoveryExhausted(budget);
      return;
    }
    budget.candidates.add(candidate);
  }
  const variants = new Set();
  addSecretValue(variants, candidate, budget);
  for (const variant of variants) {
    if (variant.length === 0 || budget.secretVariants.has(variant)) continue;
    if (!budget.variantKeys.has(variant)
      && budget.variantKeys.size >= budget.maxVariants) {
      markDiscoveryExhausted(budget);
      break;
    }
    budget.variantKeys.add(variant);
    budget.secretVariants.add(variant);
  }
}

function inspectDiscoveredUrl(budget, value) {
  if (budget.state === DISCOVERY_EXHAUSTED) return;
  try {
    const parsed = new URL(value);
    if (parsed.username) addDiscoveredCredential(budget, parsed.username);
    if (parsed.password) addDiscoveredCredential(budget, parsed.password);
    for (const parameter of parsed.search.slice(1).split('&')) {
      if (parameter.length === 0) continue;
      const separator = parameter.indexOf('=');
      const rawName = separator === -1 ? parameter : parameter.slice(0, separator);
      const rawValue = separator === -1 ? '' : parameter.slice(separator + 1);
      if (normalizedCredentialName(rawName, budget) !== null) addDiscoveredCredential(budget, rawValue);
      if (budget.state === DISCOVERY_EXHAUSTED) return;
    }
  } catch {
    // Only syntactically valid URLs contribute credential candidates.
  }
}

function inspectDiscoveredText(budget, value) {
  if (budget.state === DISCOVERY_EXHAUSTED || typeof value !== 'string') return;
  const remaining = MAX_DISCOVERY_TEXT_CHARS - budget.textChars;
  if (value.length > remaining) {
    markDiscoveryExhausted(budget);
    return;
  }
  budget.textChars += value.length;
  if (OUTPUT_OVERLONG_CREDENTIAL_ASSIGNMENT_PATTERN.test(value)
    || OUTPUT_OVERLONG_CREDENTIAL_ARGUMENT_PATTERN.test(value)) {
    markDiscoveryExhausted(budget);
    return;
  }
  const inspectMatches = (pattern, inspect) => {
    for (const match of value.matchAll(pattern)) {
      const apply = inspect(match);
      if (budget.state === DISCOVERY_EXHAUSTED) return false;
      if (typeof apply !== 'function') continue;
      if (budget.matches >= MAX_DISCOVERY_MATCHES) {
        markDiscoveryExhausted(budget);
        return false;
      }
      budget.matches += 1;
      apply();
      if (budget.state === DISCOVERY_EXHAUSTED) return false;
    }
    return true;
  };
  if (!inspectMatches(OUTPUT_AUTHORIZATION_PATTERN, (match) => {
    const normalized = normalizedCredentialName(match[1], budget);
    if (normalized !== 'authorization' && normalized !== 'proxyauthorization') return null;
    return () => addDiscoveredCredential(budget, match[2]);
  })) return;
  if (!inspectMatches(OUTPUT_CREDENTIAL_ASSIGNMENT_PATTERN, (match) => {
    const normalized = normalizedCredentialName(match[1], budget);
    if (normalized === null || normalized === 'authorization' || normalized === 'proxyauthorization') return null;
    return () => addDiscoveredCredential(budget, match[2] ?? match[3] ?? match[4]);
  })) return;
  if (!inspectMatches(OUTPUT_CREDENTIAL_SEPARATE_ARGUMENT_PATTERN, (match) => {
    if (normalizedCredentialName(match[1], budget) === null) return null;
    return () => addDiscoveredCredential(budget, match[2] ?? match[3] ?? match[4]);
  })) return;
  inspectMatches(OUTPUT_URL_PATTERN, (match) => () => {
    if (match[0].length > MAX_DISCOVERED_URL_CHARS) {
      markDiscoveryExhausted(budget);
      return;
    }
    inspectDiscoveredUrl(budget, match[0]);
  });
}

function inspectDiscoveredCommand(budget, command, inspectText = false) {
  if (budget.state === DISCOVERY_EXHAUSTED || !Array.isArray(command)) return;
  for (let index = 0; index < command.length && budget.state === DISCOVERY_COMPLETE; index += 1) {
    const argument = command[index];
    if (typeof argument !== 'string') continue;
    if (inspectText) inspectDiscoveredText(budget, argument);
    const inline = credentialArgumentValue(argument, budget);
    if (inline !== null) addDiscoveredCredential(budget, inline);
    if (credentialArgumentName(argument, budget)
      && !argument.includes('=')
      && typeof command[index + 1] === 'string') {
      addDiscoveredCredential(budget, command[index + 1]);
    }
  }
}

function discoverSecretsWithBudget(budget, sources) {
  for (const source of sources) {
    const seen = new Set();
    const stack = [{ credentialContext: false, depth: 0, value: source }];
    while (stack.length > 0 && budget.state === DISCOVERY_COMPLETE) {
      const { credentialContext, depth, value } = stack.pop();
      if (budget.nodes >= MAX_DISCOVERY_NODES || depth > MAX_DISCOVERY_DEPTH) {
        markDiscoveryExhausted(budget);
        break;
      }
      budget.nodes += 1;
      if (typeof value === 'string') {
        if (credentialContext) addDiscoveredCredential(budget, value);
        inspectDiscoveredText(budget, value);
        continue;
      }
      if (value === null || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) {
        inspectDiscoveredCommand(budget, value);
        for (let index = value.length - 1; index >= 0; index -= 1) {
          stack.push({ credentialContext, depth: depth + 1, value: value[index] });
        }
        continue;
      }
      const entries = Object.entries(value);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [name, item] = entries[index];
        inspectDiscoveredText(budget, name);
        if (budget.state === DISCOVERY_EXHAUSTED) break;
        if (name === 'command' && Array.isArray(item)) {
          inspectDiscoveredCommand(budget, item, true);
          if (budget.state === DISCOVERY_EXHAUSTED) break;
        }
        stack.push({
          credentialContext: credentialContext || outputCredentialFieldName(name, budget),
          depth: depth + 1,
          value: item
        });
      }
    }
    if (budget.state === DISCOVERY_EXHAUSTED) break;
  }
  return {
    secrets: budget.state === DISCOVERY_COMPLETE ? [...budget.secretVariants] : null,
    state: budget.state
  };
}

function discoveredOutputSecrets(...sources) {
  return discoverSecretsWithBudget(newCredentialDiscoveryBudget(), sources);
}

function configuredSecrets(...sources) {
  return discoverSecretsWithBudget(newCredentialDiscoveryBudget({
    maxVariants: MAX_DISCOVERY_NODES
  }), sources);
}

function consumeStructuralText(budget, value) {
  const remaining = MAX_DISCOVERY_TEXT_CHARS - budget.textChars;
  if (value.length > remaining) {
    markDiscoveryExhausted(budget);
    return false;
  }
  budget.textChars += value.length;
  return true;
}

function cloneRedactedArtifact(source, secrets, budget) {
  const holder = { value: null };
  const seen = new Map();
  const stack = [{
    arrayParent: false,
    credentialContext: false,
    depth: 0,
    key: 'value',
    parent: holder,
    value: source
  }];
  const assign = (frame, value) => {
    if (frame.arrayParent) {
      frame.parent[frame.key] = value;
      return;
    }
    Object.defineProperty(frame.parent, frame.key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    });
  };

  while (stack.length > 0 && budget.state === DISCOVERY_COMPLETE) {
    const frame = stack.pop();
    if (budget.nodes >= MAX_DISCOVERY_NODES || frame.depth > MAX_DISCOVERY_DEPTH) {
      markDiscoveryExhausted(budget);
      break;
    }
    budget.nodes += 1;
    const { value } = frame;
    if (typeof value === 'string') {
      if (!consumeStructuralText(budget, value)) break;
      assign(frame, frame.credentialContext ? REDACTED : redactText(value, secrets));
      continue;
    }
    if (value === null || typeof value !== 'object') {
      assign(frame, value);
      continue;
    }
    if (seen.has(value)) {
      assign(frame, seen.get(value));
      continue;
    }

    const output = Array.isArray(value) ? [] : {};
    seen.set(value, output);
    assign(frame, output);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        const previous = index > 0 ? value[index - 1] : null;
        stack.push({
          arrayParent: true,
          credentialContext: frame.credentialContext || (
            typeof previous === 'string'
            && credentialArgumentName(previous, budget)
            && !previous.includes('=')
          ),
          depth: frame.depth + 1,
          key: index,
          parent: output,
          value: value[index]
        });
      }
      continue;
    }

    const entries = Object.entries(value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [name, item] = entries[index];
      if (!consumeStructuralText(budget, name)) break;
      stack.push({
        arrayParent: false,
        credentialContext: frame.credentialContext || outputCredentialFieldName(name, budget),
        depth: frame.depth + 1,
        key: redactText(name, secrets),
        parent: output,
        value: item
      });
    }
  }
  return budget.state === DISCOVERY_COMPLETE ? holder.value : null;
}

function sanitizeBoundedArtifacts(discover, secrets, sources, {
  retainKnownShortSecrets = false
} = {}) {
  const discovery = discover(...sources);
  if (discovery.state === DISCOVERY_EXHAUSTED) {
    return { state: SANITIZATION_AMBIGUOUS, values: null };
  }
  const budget = newCredentialDiscoveryBudget();
  const stableSecrets = retainKnownShortSecrets
    ? secrets
    : secrets.filter((secret) => secret.length >= MIN_DISCOVERED_CREDENTIAL_CHARS);
  const artifactSecrets = [...new Set([...stableSecrets, ...discovery.secrets])]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const values = sources.map((source) => cloneRedactedArtifact(
    source,
    artifactSecrets,
    budget
  ));
  return {
    state: budget.state === DISCOVERY_EXHAUSTED ? SANITIZATION_AMBIGUOUS : SANITIZATION_COMPLETE,
    values: budget.state === DISCOVERY_EXHAUSTED ? null : values
  };
}

function structurallyRedactCredentialContexts(secrets, ...sources) {
  return sanitizeBoundedArtifacts(discoveredOutputSecrets, secrets, sources, {
    retainKnownShortSecrets: true
  });
}

function structurallyRedactConfiguredContexts(secrets, ...sources) {
  return sanitizeBoundedArtifacts(configuredSecrets, secrets, sources);
}

function configuredSecretValues(...sources) {
  const discovery = configuredSecrets(...sources);
  if (discovery.state === DISCOVERY_EXHAUSTED) throw adapterSanitizationBudgetError({});
  const secrets = new Set(discovery.secrets);
  for (const source of sources) {
    if (source === null || typeof source !== 'object' || !source[SPEC_SECRET_VALUES]) continue;
    for (const secret of source[SPEC_SECRET_VALUES]) secrets.add(secret);
  }
  return [...secrets]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function redactText(value, secrets) {
  let redacted = String(value ?? '');
  for (const secret of secrets) {
    if (secret.length > 0 && redacted.includes(secret)) redacted = redacted.replaceAll(secret, REDACTED);
  }
  return redacted;
}

function withExplicitSecrets(detected, explicit) {
  const secrets = new Set(detected);
  for (const value of explicit ?? []) addSecretValue(secrets, value);
  return [...secrets].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function minimalInheritedEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment ?? {}).filter(([name, value]) => (
    INHERITED_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase()) && typeof value === 'string'
  )));
}

function validateAdapterSpec(spec, armId) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`Adapter ${armId} must be an object`);
  if (!Array.isArray(spec.command) || spec.command.length === 0 || spec.command.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`Adapter ${armId} command must be a non-empty string array`);
  }
  const timeoutMs = spec.timeoutMs ?? 120000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error(`Adapter ${armId} timeoutMs must be an integer from 1 through 600000`);
  if (spec.environment !== undefined && (spec.environment === null || typeof spec.environment !== 'object' || Array.isArray(spec.environment))) {
    throw new Error(`Adapter ${armId} environment must be an object when supplied`);
  }
  for (const [name, value] of Object.entries(spec.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof value !== 'string') throw new Error(`Adapter ${armId} has an invalid environment entry`);
  }
  const normalized = { command: [...spec.command], timeoutMs, environment: { ...(spec.environment ?? {}) } };
  Object.defineProperty(normalized, SPEC_SECRET_VALUES, {
    configurable: false,
    enumerable: false,
    value: configuredSecretValues(spec),
    writable: false
  });
  return normalized;
}

export async function loadAdapterConfiguration(path, requiredArmIds) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('A real adapter configuration path is required');
  if (!Array.isArray(requiredArmIds) || requiredArmIds.length === 0) throw new Error('requiredArmIds must be a non-empty array');
  const source = await readFile(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('Adapter configuration must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Adapter configuration must be an object keyed by arm id');
  const actualIds = Object.keys(parsed).sort();
  const expectedIds = [...requiredArmIds].sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`Adapter configuration must contain exactly: ${expectedIds.join(', ')}`);
  }
  return Object.fromEntries(requiredArmIds.map((armId) => [armId, validateAdapterSpec(parsed[armId], armId)]));
}

function validateAdapterOutput(output) {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) throw new Error('Adapter output must be one JSON object');
  for (const field of REQUIRED_OUTPUT_FIELDS) {
    if (!Object.hasOwn(output, field)) throw new Error(`Adapter output is missing ${field}`);
  }
  if (output.response === null || typeof output.response !== 'object' || Array.isArray(output.response)) throw new Error('Adapter response must be an object');
  if (output.usage !== null && (typeof output.usage !== 'object' || Array.isArray(output.usage))) throw new Error('Adapter usage must be null or an object');
  if (!Number.isInteger(output.toolCalls) || output.toolCalls < 0) throw new Error('Adapter toolCalls must be a non-negative integer');
  if (output.storageBytes !== null && (!Number.isInteger(output.storageBytes) || output.storageBytes < 0)) throw new Error('Adapter storageBytes must be null or a non-negative integer');
  if (typeof output.persistedVerified !== 'boolean') throw new Error('Adapter persistedVerified must be boolean');
  if (!Array.isArray(output.logs) || output.logs.some((value) => typeof value !== 'string')) throw new Error('Adapter logs must be a string array');
  return output;
}

export function adapterCommandForRecord(spec, ...secretSources) {
  const validated = validateAdapterSpec(spec, '<record>');
  const secrets = configuredSecretValues(validated, ...secretSources);
  const sanitization = sanitizeBoundedArtifacts(configuredSecrets, secrets, [validated.command], {
    retainKnownShortSecrets: true
  });
  if (sanitization.state === SANITIZATION_AMBIGUOUS) throw adapterSanitizationBudgetError({});
  return JSON.stringify(sanitization.values[0]);
}

export function redactConfiguredSecrets(value, ...secretSources) {
  const secrets = configuredSecretValues(...secretSources);
  const sanitization = structurallyRedactConfiguredContexts(secrets, value);
  if (sanitization.state === SANITIZATION_AMBIGUOUS) throw adapterSanitizationBudgetError({});
  return sanitization.values[0];
}

function adapterSanitizationBudgetError({
  code = null,
  signal = null
}) {
  const error = new Error(SANITIZATION_BUDGET_ERROR);
  error.name = 'AdapterExecutionError';
  error.stdout = REDACTED;
  error.stderr = REDACTED;
  error.command = REDACTED;
  error.exitCode = code;
  error.signal = signal;
  error.sanitizationState = SANITIZATION_AMBIGUOUS;
  return error;
}

function adapterError(message, {
  command,
  secrets,
  stdout = '',
  stderr = '',
  code = null,
  signal = null
}) {
  let discoveryStdout = stdout;
  try { discoveryStdout = JSON.parse(stdout); } catch { /* malformed output is inspected as bounded text */ }
  const structural = structurallyRedactCredentialContexts(
    secrets,
    discoveryStdout,
    stderr,
    message,
    command.command
  );
  if (structural.state === SANITIZATION_AMBIGUOUS) {
    return adapterSanitizationBudgetError({ command, secrets, code, signal });
  }
  const safeStdout = typeof discoveryStdout === 'string'
    ? structural.values[0]
    : JSON.stringify(structural.values[0]);
  const safeStderr = structural.values[1];
  const details = safeStderr.trim().length > 0 ? `; stderr: ${safeStderr.trim()}` : '';
  const error = new Error(`${structural.values[2]}${details}`);
  error.name = 'AdapterExecutionError';
  error.stdout = safeStdout;
  error.stderr = safeStderr;
  error.command = JSON.stringify(structural.values[3]);
  error.exitCode = code;
  error.signal = signal;
  error.sanitizationState = SANITIZATION_COMPLETE;
  return error;
}

export async function runAdapterRequest(spec, request, {
  inheritedEnvironment = process.env,
  secretValues = []
} = {}) {
  const validated = validateAdapterSpec(spec, '<request>');
  const secrets = withExplicitSecrets(configuredSecretValues(validated, request), secretValues);
  let requestBody;
  try {
    requestBody = JSON.stringify(request);
  } catch {
    throw adapterError('Adapter request could not be serialized', {
      command: validated,
      secrets
    });
  }
  return await new Promise((resolve, reject) => {
    const [executable, ...args] = validated.command;
    const child = spawn(executable, args, {
      env: { ...minimalInheritedEnvironment(inheritedEnvironment), ...validated.environment },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timer;
    const currentEvidence = () => ({
      command: validated,
      secrets,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8')
    });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const append = (current, chunk) => {
      if (settled) return current;
      const next = Buffer.concat([current, chunk]);
      if (next.length > MAX_OUTPUT_BYTES) {
        child.kill();
        fail(adapterError('Adapter output exceeded the 4 MiB limit', {
          ...currentEvidence(),
          stdout: current === stdout ? next.toString('utf8') : stdout.toString('utf8'),
          stderr: current === stderr ? next.toString('utf8') : stderr.toString('utf8')
        }));
      }
      return next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.stdin.on('error', () => {
      // Process close/error supplies the bounded, sanitized failure evidence.
    });
    child.on('error', (cause) => fail(adapterError(
      `Adapter process could not be started: ${cause?.message ?? 'unknown process error'}`,
      currentEvidence()
    )));
    timer = setTimeout(() => {
      child.kill();
      fail(adapterError(`Adapter request exceeded its ${validated.timeoutMs}ms timeout`, currentEvidence()));
    }, validated.timeoutMs);
    timer.unref?.();
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const evidence = { ...currentEvidence(), code, signal };
      if (code !== 0) {
        reject(adapterError(`Adapter process exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`, evidence));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.toString('utf8'));
        const structural = structurallyRedactCredentialContexts(secrets, parsed, stderr.toString('utf8'));
        if (structural.state === SANITIZATION_AMBIGUOUS) {
          reject(adapterSanitizationBudgetError(evidence));
          return;
        }
        const output = validateAdapterOutput(structural.values[0]);
        const safeStderr = structural.values[1].trim();
        if (safeStderr.length > 0) output.logs = [...output.logs, `Adapter stderr: ${safeStderr}`];
        resolve(output);
      } catch (cause) {
        reject(adapterError(`Adapter returned invalid JSON output: ${cause?.message ?? 'unknown parse error'}`, evidence));
      }
    });
    child.stdin.end(requestBody);
  });
}

export const ADAPTER_PROTOCOL = Object.freeze({
  schemaVersion: 1,
  transport: 'one JSON request on stdin; one JSON response on stdout; no shell',
  requiredOutputFields: [...REQUIRED_OUTPUT_FIELDS]
});
