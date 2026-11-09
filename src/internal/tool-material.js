// A tool call as text, and the one split capture can prove between the agent's
// input and the tool's output. The split is the renderer's own fields, measured
// after the same redaction the stored text goes through. It is never recovered
// by searching the rendered lines for labels.
import { createHash } from 'node:crypto';
import { KEYED_NAMES, KEYED_VALUES, REDACTED, isCredentialName } from './redaction.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const TOOL_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);

// A key or argument naming a credential, by the redactor's names or the short
// ones a tool's input uses, with an argument's leading dashes ignored (PR-37b
// review F4, re-review NF-4).
const SHORT_CREDENTIAL_KEYS = new Set(['pass', 'pw', 'auth', 'cookie', 'cookies', 'set-cookie']);
const credentialKey = (name) => isCredentialName(name) || SHORT_CREDENTIAL_KEYS.has(String(name).toLowerCase().replace(/^-+/u, ''));
// The value after a user flag that carries a password (`-u user:pass`).
const USER_FLAG = /^(?:-u|--user)$/u;

// A tool call as text (design review D-12): its name, then every leaf of its
// input, its response and a failure's error, labelled by path. A string keeps
// its own line breaks, so a delivered block inside one is found and stripped
// as in plain text; any other value is written as JSON. Walked without
// recursion.
export function renderToolMaterial({ toolName, toolInput, toolResponse, error }) {
  const lines = [`tool: ${toolName}`];
  const pending = [['error', error], ['response', toolResponse], ['input', toolInput]].filter(([, value]) => value !== undefined);
  // What a credential names is rendered as one redacted line, whatever it
  // holds (PR-37b R1): the value of a key named for one, the value field of a
  // pair keyed by one, and an array element after one (a header pair, an
  // argument vector's `--password <value>`). An array of one-line strings is
  // one line, as a command is, so the redactor's flag rules apply to it.
  const hides = (item) => item !== null && item !== undefined;
  const follows = (array, index) => index > 0 && typeof array[index - 1] === 'string'
    && (credentialKey(array[index - 1]) || (USER_FLAG.test(array[index - 1]) && typeof array[index] === 'string' && array[index].includes(':')));
  while (pending.length) {
    const [path, value, hidden] = pending.pop();
    if (hidden) lines.push(`${path}: ${REDACTED}`);
    else if (typeof value === 'string') lines.push(`${path}:`, value);
    else if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string' && !/[\r\n]/u.test(item))) {
      lines.push(`${path}: ${value.map((item, index) => (follows(value, index) ? REDACTED : item)).join(' ')}`);
    } else if (isObject(value) || (Array.isArray(value) && value.length)) {
      const keyed = !Array.isArray(value) && KEYED_NAMES.some((name) => typeof value[name] === 'string' && isCredentialName(value[name]));
      const entries = Array.isArray(value)
        ? value.map((item, index) => [`${path}[${index}]`, item, follows(value, index) && hides(item)])
        : Object.entries(value).map(([key, item]) => [`${path}.${key}`, item, hides(item) && (credentialKey(key) || (keyed && KEYED_VALUES.has(key)))]);
      if (!entries.length) lines.push(`${path}: {}`);
      for (let at = entries.length - 1; at >= 0; at -= 1) pending.push(entries[at]);
    } else lines.push(`${path}: ${JSON.stringify(value)}`);
  }
  return lines.join('\n');
}

// A tool call's input or response with every value the renderer would show as
// redacted replaced by REDACTED, in the same shape, by the same rules: a key
// named for a credential, the value of a pair keyed by one, an array element
// after one, and a user flag's `user:password`. The capture spool keeps this
// (independent review of the spool, 2026-10-27): the redactor's text rules
// alone do not know an argument vector's neighbours. Strings are then
// redacted as text by the caller. Walked to a bounded depth; past it a value
// is withheld whole.
export function redactToolStructure(value, depth = 0) {
  if (depth > 64) return REDACTED;
  if (Array.isArray(value)) {
    const follows = (index) => index > 0 && typeof value[index - 1] === 'string'
      && (credentialKey(value[index - 1]) || (USER_FLAG.test(value[index - 1]) && typeof value[index] === 'string' && value[index].includes(':')));
    return value.map((item, index) => (follows(index) && item !== null && item !== undefined ? REDACTED : redactToolStructure(item, depth + 1)));
  }
  if (!isObject(value)) return value;
  const keyed = KEYED_NAMES.some((name) => typeof value[name] === 'string' && isCredentialName(value[name]));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    item !== null && item !== undefined && (credentialKey(key) || (keyed && KEYED_VALUES.has(key))) ? REDACTED : redactToolStructure(item, depth + 1)]));
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// The stored length of the redacted input side, and the hash of that side.
// Null unless the stored text is exactly this call rendered and prepared the
// same way, and that text starts with the input side, a newline, and a
// non-empty outcome, each side prepared on its own. A secret or a delivered
// block that redaction or stripping runs across the join, terminated or not,
// makes the sides differ from the whole and stores nothing. `prepare` is the
// writer's strip-and-redact, so the length is an index into the text it hashes.
export function provenToolInputSplit({ event, storedText, toolCall, prepare }) {
  if (!TOOL_EVENTS.has(event) || typeof storedText !== 'string' || !storedText) return null;
  if (!isObject(toolCall) || typeof toolCall.toolName !== 'string' || typeof prepare !== 'function') return null;
  try {
    const rendered = renderToolMaterial({
      toolName: toolCall.toolName,
      toolInput: toolCall.toolInput,
      toolResponse: toolCall.toolResponse,
      error: event === 'PostToolUseFailure' ? toolCall.error : undefined
    });
    const inputOnly = renderToolMaterial({ toolName: toolCall.toolName, toolInput: toolCall.toolInput });
    if (!rendered.startsWith(`${inputOnly}\n`)) return null;
    const full = prepare(rendered);
    const input = prepare(inputOnly);
    const outcome = prepare(rendered.slice(inputOnly.length + 1));
    if (typeof full !== 'string' || typeof input !== 'string' || typeof outcome !== 'string' || full !== storedText || !input || !outcome) return null;
    if (storedText !== `${input}\n${outcome}`) return null;
    return { boundary: input.length, hash: sha256(input) };
  } catch {
    return null;
  }
}
