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
const SECRET_FIELD_PATTERN = /(?:api[_-]?key|authorization|credential|password|passwd|secret|token)/iu;
const SPEC_SECRET_VALUES = Symbol('adapter configured secret values');
const MAX_SECRET_ENCODING_ROUNDS = 3;
const MAX_DISCOVERED_CREDENTIALS = 64;
const MAX_DISCOVERED_SECRET_VARIANTS = 256;
const MAX_DISCOVERED_CREDENTIAL_CHARS = 512;
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
const OUTPUT_CREDENTIAL_NAME = String.raw`(?:x[-_]?api[-_]?key|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|token|password|passwd|client[-_]?secret|secret|credential)`;
const OUTPUT_AUTHORIZATION_PATTERN = /\b(?:proxy[-_ ]?authorization|authorization)\b["']?\s*(?:=|:)\s*["']?(?:bearer|basic)\s+([A-Za-z0-9._~+/%=-]+)/giu;
const OUTPUT_CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b${OUTPUT_CREDENTIAL_NAME}\b["']?\s*(?:=|:)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s&,;}\]"']+))`,
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
  'private', 'public', 'secret', 'signing'
];
const CREDENTIAL_QUERY_SUFFIXES = [
  'apikey', 'authorization', 'credential', 'passwd', 'password', 'secret',
  'signature', 'token'
];

function addExactSecret(secrets, value) {
  if (typeof value !== 'string' || value.length === 0) return;
  secrets.add(value);
  secrets.add(value.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase()));
}

function markDiscoveryExhausted(budget) {
  if (budget) budget.state = DISCOVERY_EXHAUSTED;
}

function decodedCandidates(value) {
  const candidates = [];
  for (const candidate of [value, value.replaceAll('+', ' ')]) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded.length > 0) candidates.push(decoded);
    } catch {
      // Invalid percent escapes remain protected in their exact original form.
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

function addStringLeaves(secrets, value, seen = new Set()) {
  if (typeof value === 'string') {
    addSecretValue(secrets, value);
    return;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) addStringLeaves(secrets, item, seen);
    return;
  }
  for (const item of Object.values(value)) addStringLeaves(secrets, item, seen);
}

function credentialQueryName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const compact = name.toLowerCase().replace(/[^a-z0-9]/gu, '');
  if (CREDENTIAL_QUERY_NAMES.has(compact)) return true;
  if (CREDENTIAL_QUERY_SUFFIXES.some((suffix) => compact.endsWith(suffix))) return true;
  if (!compact.endsWith('key')) return false;
  const prefix = compact.slice(0, -'key'.length);
  return AUTH_RELATED_KEY_PREFIXES.some((candidate) => prefix.startsWith(candidate));
}

function outputCredentialFieldName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const compact = name.toLowerCase().replace(/[^a-z0-9]/gu, '');
  return compact === 'credentials'
    || compact === 'proxyauthorization'
    || credentialQueryName(name);
}

function addUrlSecrets(secrets, value) {
  if (typeof value !== 'string' || !value.includes('://')) return;
  try {
    const parsed = new URL(value);
    if (parsed.username) addSecretValue(secrets, parsed.username);
    if (parsed.password) addSecretValue(secrets, parsed.password);
    for (const [name, queryValue] of parsed.searchParams) {
      if (credentialQueryName(name)) addSecretValue(secrets, queryValue);
    }
    for (const parameter of parsed.search.slice(1).split('&')) {
      if (parameter.length === 0) continue;
      const separator = parameter.indexOf('=');
      const rawName = separator === -1 ? parameter : parameter.slice(0, separator);
      const rawValue = separator === -1 ? '' : parameter.slice(separator + 1);
      let decodedName = rawName;
      try { decodedName = decodeURIComponent(rawName.replaceAll('+', ' ')); } catch { /* exact name remains inspectable */ }
      if (credentialQueryName(decodedName)) addSecretValue(secrets, rawValue);
    }
  } catch {
    // Non-URL strings are inspected through their field and argument context.
  }
}

function credentialArgumentValue(argument) {
  if (typeof argument !== 'string' || !argument.startsWith('-')) return null;
  const separator = argument.indexOf('=');
  if (separator === -1) return null;
  const name = argument.slice(0, separator);
  return SECRET_FIELD_PATTERN.test(name) ? argument.slice(separator + 1) : null;
}

function credentialArgumentName(argument) {
  if (typeof argument !== 'string' || !argument.startsWith('-')) return false;
  return SECRET_FIELD_PATTERN.test(argument.split('=', 1)[0]);
}

function inspectCommandSecrets(secrets, command) {
  if (!Array.isArray(command)) return;
  for (let index = 0; index < command.length; index += 1) {
    const argument = command[index];
    addUrlSecrets(secrets, argument);
    const inline = credentialArgumentValue(argument);
    if (inline !== null) addSecretValue(secrets, inline);
    if (credentialArgumentName(argument) && !argument.includes('=') && index + 1 < command.length) {
      addSecretValue(secrets, command[index + 1]);
    }
  }
}

function newCredentialDiscoveryBudget() {
  return {
    candidates: new Set(),
    matches: 0,
    nodes: 0,
    secretVariants: new Set(),
    state: DISCOVERY_COMPLETE,
    textChars: 0
  };
}

function addDiscoveredCredential(budget, value) {
  if (budget.state === DISCOVERY_EXHAUSTED || typeof value !== 'string') return;
  const candidate = value.trim();
  if (candidate.length < MIN_DISCOVERED_CREDENTIAL_CHARS || budget.candidates.has(candidate)) return;
  if (candidate.length > MAX_DISCOVERED_CREDENTIAL_CHARS
    || budget.candidates.size >= MAX_DISCOVERED_CREDENTIALS) {
    markDiscoveryExhausted(budget);
    return;
  }
  budget.candidates.add(candidate);
  const variants = new Set();
  addSecretValue(variants, candidate, budget);
  for (const variant of variants) {
    if (budget.secretVariants.has(variant)) continue;
    if (budget.secretVariants.size >= MAX_DISCOVERED_SECRET_VARIANTS) {
      markDiscoveryExhausted(budget);
      break;
    }
    budget.secretVariants.add(variant);
  }
}

function inspectDiscoveredUrl(budget, value) {
  if (budget.state === DISCOVERY_EXHAUSTED) return;
  try {
    const parsed = new URL(value);
    if (parsed.username) addDiscoveredCredential(budget, parsed.username);
    if (parsed.password) addDiscoveredCredential(budget, parsed.password);
    for (const [name, queryValue] of parsed.searchParams) {
      if (credentialQueryName(name)) addDiscoveredCredential(budget, queryValue);
    }
    for (const parameter of parsed.search.slice(1).split('&')) {
      if (parameter.length === 0) continue;
      const separator = parameter.indexOf('=');
      const rawName = separator === -1 ? parameter : parameter.slice(0, separator);
      const rawValue = separator === -1 ? '' : parameter.slice(separator + 1);
      let decodedName = rawName;
      try { decodedName = decodeURIComponent(rawName.replaceAll('+', ' ')); } catch { /* bounded raw name remains inspectable */ }
      if (credentialQueryName(decodedName)) addDiscoveredCredential(budget, rawValue);
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
  const inspectMatches = (pattern, inspect) => {
    for (const match of value.matchAll(pattern)) {
      if (budget.matches >= MAX_DISCOVERY_MATCHES) {
        markDiscoveryExhausted(budget);
        return false;
      }
      budget.matches += 1;
      inspect(match);
      if (budget.state === DISCOVERY_EXHAUSTED) return false;
    }
    return true;
  };
  if (!inspectMatches(OUTPUT_AUTHORIZATION_PATTERN, (match) => {
    addDiscoveredCredential(budget, match[1]);
  })) return;
  if (!inspectMatches(OUTPUT_CREDENTIAL_ASSIGNMENT_PATTERN, (match) => {
    addDiscoveredCredential(budget, match[1] ?? match[2] ?? match[3]);
  })) return;
  inspectMatches(OUTPUT_URL_PATTERN, (match) => {
    if (match[0].length > MAX_DISCOVERED_URL_CHARS) {
      markDiscoveryExhausted(budget);
      return;
    }
    inspectDiscoveredUrl(budget, match[0]);
  });
}

function inspectDiscoveredCommand(budget, command) {
  if (budget.state === DISCOVERY_EXHAUSTED || !Array.isArray(command)) return;
  for (let index = 0; index < command.length && budget.state === DISCOVERY_COMPLETE; index += 1) {
    const argument = command[index];
    if (typeof argument !== 'string') continue;
    inspectDiscoveredText(budget, argument);
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    if (!name.startsWith('-') || !outputCredentialFieldName(name)) continue;
    if (separator !== -1) addDiscoveredCredential(budget, argument.slice(separator + 1));
    else if (typeof command[index + 1] === 'string') addDiscoveredCredential(budget, command[index + 1]);
  }
}

function discoveredOutputSecrets(...sources) {
  const budget = newCredentialDiscoveryBudget();
  const seen = new Set();
  const inspect = (value, depth = 0, credentialContext = false) => {
    if (budget.state === DISCOVERY_EXHAUSTED) return;
    if (budget.nodes >= MAX_DISCOVERY_NODES || depth > MAX_DISCOVERY_DEPTH) {
      markDiscoveryExhausted(budget);
      return;
    }
    budget.nodes += 1;
    if (typeof value === 'string') {
      if (credentialContext) addDiscoveredCredential(budget, value);
      inspectDiscoveredText(budget, value);
      return;
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        inspect(item, depth + 1, credentialContext);
        if (budget.state === DISCOVERY_EXHAUSTED) break;
      }
      return;
    }
    if (Array.isArray(value.command)) inspectDiscoveredCommand(budget, value.command);
    for (const [name, item] of Object.entries(value)) {
      if (budget.state === DISCOVERY_EXHAUSTED) break;
      inspectDiscoveredText(budget, name);
      inspect(item, depth + 1, credentialContext || outputCredentialFieldName(name));
    }
  };
  for (const source of sources) {
    inspect(source);
    if (budget.state === DISCOVERY_EXHAUSTED) break;
  }
  return {
    state: budget.state,
    secrets: budget.state === DISCOVERY_COMPLETE ? [...budget.secretVariants] : null
  };
}

function withDiscoveredOutputSecrets(secrets, ...sources) {
  const discovery = discoveredOutputSecrets(...sources);
  if (discovery.state === DISCOVERY_EXHAUSTED) {
    return { state: SANITIZATION_AMBIGUOUS, secrets: null };
  }
  return {
    state: SANITIZATION_COMPLETE,
    secrets: [...new Set([...secrets, ...discovery.secrets])]
      .sort((left, right) => right.length - left.length || left.localeCompare(right))
  };
}

function configuredSecretValues(...sources) {
  const secrets = new Set();
  const seen = new Set();
  const inspect = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      addUrlSecrets(secrets, value);
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value[SPEC_SECRET_VALUES]) {
      for (const secret of value[SPEC_SECRET_VALUES]) addSecretValue(secrets, secret);
    }
    if (Array.isArray(value)) {
      for (const item of value) inspect(item);
      return;
    }
    if (Array.isArray(value.command)) inspectCommandSecrets(secrets, value.command);
    for (const [name, item] of Object.entries(value)) {
      if (SECRET_FIELD_PATTERN.test(name)) addStringLeaves(secrets, item);
      if (typeof item === 'string') addUrlSecrets(secrets, item);
      inspect(item);
    }
  };
  for (const source of sources) inspect(source);
  return [...secrets].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function redactText(value, secrets) {
  let redacted = String(value ?? '');
  for (const secret of secrets) {
    if (secret.length > 0 && redacted.includes(secret)) redacted = redacted.replaceAll(secret, REDACTED);
  }
  return redacted;
}

function redactValue(value, secrets, seen = new Map()) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const output = [];
    seen.set(value, output);
    for (const item of value) output.push(redactValue(item, secrets, seen));
    return output;
  }
  const output = {};
  seen.set(value, output);
  for (const [name, item] of Object.entries(value)) {
    Object.defineProperty(output, redactText(name, secrets), {
      configurable: true,
      enumerable: true,
      value: redactValue(item, secrets, seen),
      writable: true
    });
  }
  return output;
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
  return JSON.stringify(redactValue(validated.command, secrets));
}

export function redactConfiguredSecrets(value, ...secretSources) {
  return redactValue(value, configuredSecretValues(...secretSources));
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
  const sanitization = withDiscoveredOutputSecrets(secrets, discoveryStdout, stderr, message);
  if (sanitization.state === SANITIZATION_AMBIGUOUS) {
    return adapterSanitizationBudgetError({ command, secrets, code, signal });
  }
  const outputSecrets = sanitization.secrets;
  const safeStdout = redactText(stdout, outputSecrets);
  const safeStderr = redactText(stderr, outputSecrets);
  const details = safeStderr.trim().length > 0 ? `; stderr: ${safeStderr.trim()}` : '';
  const error = new Error(`${redactText(message, outputSecrets)}${details}`);
  error.name = 'AdapterExecutionError';
  error.stdout = safeStdout;
  error.stderr = safeStderr;
  error.command = JSON.stringify(redactValue(command.command, outputSecrets));
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
        const sanitization = withDiscoveredOutputSecrets(secrets, parsed, stderr.toString('utf8'));
        if (sanitization.state === SANITIZATION_AMBIGUOUS) {
          reject(adapterSanitizationBudgetError(evidence));
          return;
        }
        const outputSecrets = sanitization.secrets;
        const output = validateAdapterOutput(redactValue(parsed, outputSecrets));
        const safeStderr = redactText(stderr.toString('utf8'), outputSecrets).trim();
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
