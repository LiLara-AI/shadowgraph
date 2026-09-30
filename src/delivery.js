// Plan v1.4.4 §18.2-§18.4, §22.7 and §23 F-2/F-4/F-16 (PR-30; programme plan
// revision 6 §3.4, VAR-11): host delivery. `shadowgraph deliver` reads the
// hook's JSON on stdin and writes one `hookSpecificOutput.additionalContext`
// line on stdout: the store's relevant experience, head first, within 8 000
// bytes, redacted before it reaches stdout and framed as data. It is strictly
// write-free: the store is read as it is, whatever its schema version, with no
// save, lock, stamp, migration or runtime-miss persistence, so a hook can never
// change what it reads. It never exits non-zero, never writes to stderr and
// never emits a field that could block or steer the host (§18.4, PC-15).
import { lstat, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createShadowGraph, MAX_PAGE_LIMIT, SCHEMA_VERSION } from './shadowgraph.js';
import { show, t1Line } from './compact-tier.js';
import { accessContext, discoverWorkspace } from './internal/access-transport.js';
import { credentialLiteralIn, isCredentialName as checkerCredentialName, urlContainsCredential } from './internal/credential-literal.js';
import { DELIVERY_CAP_BYTES, DELIVERY_FRAME, deliveryEndLine } from './internal/delivery-marker.js';

export { DELIVERY_CAP_BYTES, DELIVERY_FRAME };
const PROCESSING = 'processing: {"capture":"not_active","extraction":"not_active"}';
const SERVED_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
const HOOK_INPUT_LIMIT_BYTES = 1024 * 1024;
const HOOK_INPUT_WAIT_MS = 3000;
const GIT_TIMEOUT_MS = 3000;
// Below this, no item line can fit; the rest are not redacted or scanned. Past
// this many, no further item is examined: a few thousand bytes hold far fewer.
const SMALLEST_ITEM_BYTES = 64;
const MOST_ITEMS_EXAMINED = 200;
const MOST_NESTING = 100;
const REDACTED = '[REDACTED]';
const bytes = (text) => Buffer.byteLength(text, 'utf8');

// Credential-shaped text is removed before stdout (§18.2, §21.4 row 5): stdout
// lands verbatim in the host transcript and cannot be recalled. Two layers. The
// redactor removes what it recognises -- more than the package checker does --
// from the record values themselves, before anything is rendered or escaped.
// Then the checker's own detector (src/internal/credential-literal.js) runs on
// every value, every line and the escaped line, and any item it still flags is
// withheld: whatever the checker would call a credential never reaches stdout.
//
// A folded view of the text -- NFKC, which folds compatibility spaces and
// fullwidth forms, with format characters (zero-width, soft hyphen,
// bidirectional controls) removed -- is redacted too, so none of them can
// disguise a name.
const FORMAT_CHARACTERS = /\p{Cf}/gu;
const SPACE = '[^\\S\\r\\n]';
const CREDENTIAL_WORDS = new Set(['password', 'passwords', 'passwd', 'passphrase', 'pwd', 'secret', 'secrets', 'credential', 'credentials']);
const CREDENTIAL_PAIRS = new Set(['apikey', 'apitoken', 'accesstoken', 'authtoken', 'secretkey', 'privatekey', 'clientsecret', 'accesskey', 'accountkey', 'signingkey', 'masterkey', 'encryptionkey', 'sessiontoken', 'refreshtoken', 'bearertoken', 'idtoken']);
const KEY_BLOCK = /-{5}BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-{5}[\s\S]*?(?:-{5}END [A-Z ]*PRIVATE KEY(?: BLOCK)?-{5}|$)/gu;
const KEY_BLOCK_BEGIN = /-{5}BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-{5}/u;
const KEY_BLOCK_END = /-{5}END [A-Z ]*PRIVATE KEY(?: BLOCK)?-{5}/u;
// The body of a key, as a key split across fields continues: base64 lines,
// the last of which may be cut short or trail off, and at least one long
// enough to be key material or ending in its padding. Linear.
const base64Line = (line) => /^[A-Za-z0-9+/=]+$/u.test(line);
function isKeyBody(value) {
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.slice(0, -1).every(base64Line) && (lines.length > 1 || base64Line(lines[0]))
    && lines.some((line) => base64Line(line) && (line.length >= 16 || line.endsWith('=')));
}
const KNOWN_TOKENS = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/gu,
  /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  // From the start of a run only, so a long run is scanned once.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /\bglpat-[A-Za-z0-9_-]{20,}/gu,
  /\bnpm_[A-Za-z0-9]{36}\b/gu,
  /\bhf_[A-Za-z0-9]{30,}\b/gu,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu,
  /\bdop_v1_[a-f0-9]{64}\b/gu,
  /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/gu,
  /\bpypi-AgE[A-Za-z0-9_-]{50,}/gu,
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gu
];
// A URL wherever the checker finds one (`1https://` included): from the start of
// a run of scheme characters only, so the scan stays linear on long words.
const URL_USERINFO = /(?<![a-z0-9+.-])([a-z0-9+.-]+:\/\/)[^\s/?#@"'`<>]+@/giu;
const ANY_URL = /(?<![a-z0-9+.-])[a-z0-9+.-]+:\/\/[^\s<>"'`]+/giu;
// A name and its separator only: its value is found from there, so a name that
// is not a credential's never swallows a later one that is.
const NAME_CHARS = 'A-Za-z0-9%._-';
const NAME_BEFORE_SEPARATOR = new RegExp(`(?<![${NAME_CHARS}])["'\`]?((?:api|secret|access|private|signing|encryption|master)${SPACE}+key|[${NAME_CHARS}]+)["'\`]?\\]?${SPACE}*(?::|=>|=(?![=>]))`, 'giu');
const DEFINE = /\bdefine\(\s*(['"])([^'"]+)\1\s*,\s*(['"])(?:\\.|(?!\3)[^\\])*\3/gu;
const ELEMENT = /<([A-Za-z_][\w.-]*)>[^<]*<\/\1>/gu;
const CREDENTIAL_FLAG = /((?:^|\s)--(?:password|passwd|pass|token|api-?key|secret|client-secret|auth-token)(?:=|\s+))\S+/giu;
const USER_PASSWORD_FLAG = /((?:^|\s)(?:-u|--user)\s+)[^\s:]+:\S+/gu;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/giu;
const KEYED_NAMES = ['key', 'name', 'Key', 'Name', 'ParameterKey'];
const KEYED_VALUES = new Set(['value', 'text', 'Value', 'ParameterValue']);

// The checker's names, and any name one of whose words is a credential word or
// whose two neighbouring words make one (`SECRET_KEY_BASE`, `dbPassword`).
function isCredentialName(name, allowBareKey = false) {
  const text = String(name).normalize('NFKC').replace(FORMAT_CHARACTERS, '');
  if (checkerCredentialName(text, allowBareKey)) return true;
  const words = text.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  return words.some((word, index) => CREDENTIAL_WORDS.has(word) || CREDENTIAL_PAIRS.has(word + (words[index + 1] ?? '')) || word.endsWith('signature'));
}

function urlHasCredential(text) {
  if (urlContainsCredential(text)) return true;
  try {
    const url = new URL(text.replace(/[),.;]+$/u, ''));
    return Boolean(url.username || url.password) || [...url.searchParams].some(([name, value]) => value && isCredentialName(name, true));
  } catch {
    return false;
  }
}

// The index of the first match at or after `from`, or the text's length.
const searchFrom = (text, pattern, from) => {
  pattern.lastIndex = from;
  return pattern.exec(text)?.index ?? text.length;
};
const SPACE_CHARACTER = new RegExp(SPACE, 'u');
// A YAML block scalar's header, matched where the value starts and ending its
// line, so no value costs a scan to the line's end.
const BLOCK_HEADER = /[|>][-+0-9]*[^\S\r\n]*(?=[\r\n]|$)/y;

// Where a named value ends. A quoted value at its closing quote, escaped quotes
// passed over, with whatever is glued to it; a YAML block scalar (`|` or `>`)
// at the end of the more-indented lines that follow; otherwise at the later of
// the end of its first word and the checker's own terminators (`,;#}]` or the
// line's end), so no tail of a credential is left behind. Scanning starts at
// the value, never copying the rest of the text.
function valueEnd(text, start) {
  let at = start;
  while (at < text.length && SPACE_CHARACTER.test(text[at])) at += 1;
  if (at >= text.length || text[at] === '\n' || text[at] === '\r') return null;
  const quote = text[at];
  if (`"'\``.includes(quote)) {
    let end = at + 1;
    while (end < text.length && text[end] !== quote && text[end] !== '\n' && text[end] !== '\r') end += text[end] === '\\' ? 2 : 1;
    if (text[end] === quote) end += 1;
    while (end < text.length && /\S/u.test(text[end]) && !/[,;#}\]]/u.test(text[end])) end += 1;
    return Math.min(end, text.length);
  }
  if (quote === '|' || quote === '>') {
    BLOCK_HEADER.lastIndex = at;
    if (BLOCK_HEADER.test(text)) {
      const lineStart = text.lastIndexOf('\n', start) + 1;
      const indent = /^[ \t]*/u.exec(text.slice(lineStart, start))[0].length;
      const next = /\r?\n([ \t]*)([^\r\n]*)/gy;
      let end = BLOCK_HEADER.lastIndex;
      for (;;) {
        next.lastIndex = end;
        const line = next.exec(text);
        if (!line || (line[2].trim() !== '' && line[1].length <= indent)) break;
        end = next.lastIndex;
      }
      return end;
    }
  }
  return Math.max(searchFrom(text, /\s/gu, at), searchFrom(text, /[,;#}\]\r\n]/gu, at), at + 1);
}

function redactNamedValues(text) {
  let result = '';
  let from = 0;
  for (const match of text.matchAll(NAME_BEFORE_SEPARATOR)) {
    if (match.index < from || !isCredentialName(match[1])) continue;
    const end = valueEnd(text, match.index + match[0].length);
    if (end === null) continue;
    result += `${text.slice(from, match.index)}${REDACTED}`;
    from = end;
  }
  return result + text.slice(from);
}

function redactView(text) {
  let result = text.replace(KEY_BLOCK, REDACTED);
  for (const pattern of KNOWN_TOKENS) result = result.replace(pattern, REDACTED);
  result = result.replace(URL_USERINFO, `$1${REDACTED}@`);
  result = result.replace(ANY_URL, (url) => (urlHasCredential(url.replace(/^[^a-z]+/iu, '')) ? REDACTED : url));
  result = result.replace(DEFINE, (match, quote, name) => (isCredentialName(name) ? REDACTED : match));
  result = result.replace(ELEMENT, (match, tag) => (isCredentialName(tag) ? `<${tag}>${REDACTED}</${tag}>` : match));
  result = result.replace(CREDENTIAL_FLAG, `$1${REDACTED}`).replace(USER_PASSWORD_FLAG, `$1${REDACTED}`);
  result = redactNamedValues(result);
  // Bearer and basic tokens go only when they look like tokens, so "Basic
  // tests pass" stays.
  return result.replace(AUTH_SCHEME, (match, scheme, token) => (/[\d=+/]/u.test(token) || token.length >= 20 ? `${scheme} ${REDACTED}` : match));
}

// Redaction reads the characters as stored, where every word boundary the
// package checker relies on still stands; then a folded view of the result
// (NFKC, format characters removed), where a disguised name shows itself. The
// folded text is delivered only when it hid something to remove; otherwise the
// stored characters are, unaltered. If the package checker still finds a
// credential in either, the stored form is kept, and the item carrying it is
// withheld below.
const fold = (text) => text.normalize('NFKC').replace(FORMAT_CHARACTERS, '');
export function redactText(text) {
  const plain = redactView(String(text));
  const refolded = redactView(fold(plain));
  if (credentialLiteralIn(plain) || credentialLiteralIn(refolded)) return plain;
  return refolded === fold(plain) ? plain : refolded;
}

// Values in document order, so a key block split across entries or fields is
// removed from its header through its body to its last line (a header that is
// only mentioned opens nothing); a field named for a credential, or
// the value of a pair keyed by one (a fact, a memory, a condition, an
// environment entry), loses its value. An object or array nested deeper than
// MOST_NESTING levels is replaced whole, so no record can outgrow the stack.
export function redactValue(value, block = { open: false }, depth = 0) {
  if (typeof value === 'string') {
    if (block.open) {
      if (KEY_BLOCK_END.test(value)) {
        block.open = false;
        return REDACTED;
      }
      if (isKeyBody(value)) return REDACTED;
      block.open = false;
    }
    const begin = value.search(KEY_BLOCK_BEGIN);
    if (begin >= 0) {
      const tail = value.slice(begin).replace(KEY_BLOCK_BEGIN, '');
      if (!KEY_BLOCK_END.test(tail) && (tail.trim() === '' || isKeyBody(tail))) block.open = true;
    }
    return redactText(value);
  }
  if (value && typeof value === 'object' && depth >= MOST_NESTING) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, block, depth + 1));
  if (value && typeof value === 'object') {
    const keyed = KEYED_NAMES.some((name) => typeof value[name] === 'string' && isCredentialName(value[name]));
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [redactText(name),
      item !== null && item !== undefined && (isCredentialName(name) || (keyed && KEYED_VALUES.has(name))) ? REDACTED : redactValue(item, block, depth + 1)]));
  }
  return value;
}

// The checker's verdict on what would be delivered: the line, and every value
// and key in it, each as it stands and folded, with every quoted string a
// rendered line carries decoded. (The payload as escaped on stdout is checked
// whole, below.)
const flaggedText = (value) => credentialLiteralIn(value) || credentialLiteralIn(fold(value));
// The JSON string literals in a text, quotes paired left to right, a
// backslash escaping the character after it. One pass: once a literal is left
// open, no later one can close.
function jsonLiterals(text) {
  const literals = [];
  for (let start = text.indexOf('"'); start >= 0;) {
    let end = start + 1;
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
    if (end >= text.length) break;
    literals.push(text.slice(start, end + 1));
    start = text.indexOf('"', end + 1);
  }
  return literals;
}
function flagged(line, item) {
  if (flaggedText(line)) return true;
  const strings = [];
  const collect = (value) => {
    if (typeof value === 'string') strings.push(value);
    else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { strings.push(key); collect(entry); }
  };
  collect(item);
  return strings.some((value) => flaggedText(value) || jsonLiterals(value).some((literal) => {
    try { return flaggedText(JSON.parse(literal)); } catch { return false; }
  }));
}

// The closing self-check line: the byte count of everything before it. A
// verification aid, not runtime truncation detection (§18.2).
function framed(lines) {
  const body = `${lines.join('\n')}\n`;
  return `${body}${deliveryEndLine(bytes(body))}`;
}

// §18.2 order: the head (scope, request state, completeness, limitation), the
// processing block, the items in order, then the expansion pointer. Every line
// is JSON with line and paragraph separators, C1 and bidirectional controls
// escaped, so no delivered text can start a line of its own (AC-043). Items
// are taken in order while they fit; one that does not is left out whole and
// the next is tried, and the head counts every one left out (§23 F-4).
export function assemblePayload({ head, items, capBytes = DELIVERY_CAP_BYTES, redact = redactValue }) {
  const total = head.total ?? items.length;
  let withheld = 0;
  let examined = 0;
  const render = (kept) => {
    const delivered = kept.length;
    const shown = { ...head, complete: head.complete === true && delivered === items.length && withheld === 0, delivered, omitted: total - delivered, omittedForSize: examined - delivered - withheld, withheld, notExamined: items.length - examined };
    return framed([
      DELIVERY_FRAME, `head: ${show(redact(shown))}`, PROCESSING, ...kept,
      `expansion: ${show({ operation: 'shadowgraph_expand', notDelivered: total - delivered, fullRead: 'shadowgraph_context' })}`
    ]);
  };
  // The room for items: the cap, less the payload without them, less a margin
  // that covers every way the head and the byte count can grow as items are
  // taken (a digit or two, and `complete` turning true).
  // (`notExamined` shrinks as `examined` grows, so it widens nothing.)
  let room = capBytes - bytes(render([])) - 16;
  const kept = [];
  for (const [index, item] of items.entries()) {
    if (room < SMALLEST_ITEM_BYTES || index >= MOST_ITEMS_EXAMINED) break;
    examined += 1;
    const shown = redact(item);
    const line = `item: ${show(shown)}`;
    if (flagged(line, shown)) {
      withheld += 1;
      continue;
    }
    if (bytes(line) + 1 <= room) {
      kept.push(line);
      room -= bytes(line) + 1;
    }
  }
  // Whatever the lines hold together, the checker must pass the whole payload,
  // as delivered and as escaped on stdout: first without the items, and then,
  // if the head itself is the reason, with a head that holds only counts.
  const passes = (text) => !flaggedText(text) && !flaggedText(JSON.stringify(text));
  let text = render(kept);
  if (!passes(text)) {
    withheld += kept.length;
    kept.length = 0;
    text = render(kept);
  }
  const reduced = (code, detail) => framed([DELIVERY_FRAME, `head: ${show({ trigger: head.trigger, store: head.store, complete: false, limitation: { code, detail }, total, delivered: 0, omitted: total })}`, PROCESSING]);
  if (!passes(text)) text = reduced('head_withheld', 'The head held something the credential check flags, so it is shortened and no record is delivered.');
  else if (bytes(text) > capBytes) {
    kept.length = 0;
    text = reduced('head_too_large', 'The head alone exceeded the payload cap, so it is shortened and no record is delivered.');
  }
  return { text, delivered: kept.length, omittedForSize: examined - kept.length - withheld, withheld, notExamined: items.length - examined };
}

// §22.7, §23 F-2: a store that is missing, unreadable, in use, newer than this
// build or not readable by this runtime is reported unavailable, never empty
// and complete. This payload has its own reduced shape: no scope was resolved
// and nothing was counted, so its head says why and there is no pointer.
const UNAVAILABLE_DETAIL = {
  not_initialized: 'No ShadowGraph store exists here yet. Nothing was read, and none was created.',
  unreadable: 'The ShadowGraph store could not be read. Nothing was delivered from it.',
  busy: 'Another ShadowGraph process had the store open (its journal or lock was present, or the file changed while it was read). It was not read, so nothing torn or stale is delivered.',
  newer_schema: 'The ShadowGraph store was written by a newer build than this one, which does not read it. Nothing was delivered from it.',
  sqlite_unavailable: 'This runtime cannot read the SQLite store. Nothing was delivered from it.',
  unsupported_storage: 'The configured storage type is not supported. Nothing was read.'
};

function unavailablePayload(trigger, reason) {
  const head = { trigger, store: 'unavailable', reason, complete: false, limitation: { code: 'memory_unavailable', detail: UNAVAILABLE_DETAIL[reason] } };
  return framed([DELIVERY_FRAME, `head: ${show(head)}`, PROCESSING]);
}

async function present(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Another process at the store: a journal beside the database, or the store's
// own destination fence held.
const inUse = async (file) => (await present(`${file}-wal`)) || (await present(`${file}-journal`)) || (await present(`${file}.lock`));
const fingerprint = async (file) => { const { size, mtimeMs } = await stat(file); return `${size}:${mtimeMs}`; };

// The store as it is. JSON is read whole; SQLite is opened immutable and
// read-only, so no schema, pragma, sidecar or lock is created. A SQLite store
// another process has open -- a journal or the fence present before or after
// the read, or the file changed while it was read -- is busy rather than read.
// `afterRead` lets a test act between the read and the check that follows it.
export async function readStoreForDelivery({ file, storage, afterRead }) {
  if (!['json', 'sqlite'].includes(storage)) return { unavailable: 'unsupported_storage' };
  try {
    if (!(await present(file))) return { unavailable: 'not_initialized' };
    if (storage === 'json') return { payload: JSON.parse(await readFile(file, 'utf8')) };
    if (await inUse(file)) return { unavailable: 'busy' };
    let DatabaseSync, exportSqlitePayload;
    try { ({ DatabaseSync } = await import('node:sqlite')); ({ exportSqlitePayload } = await import('./sqlite-storage.js')); }
    catch { return { unavailable: 'sqlite_unavailable' }; }
    const before = await fingerprint(file);
    let database, legacy, payload = null;
    try {
      database = new DatabaseSync(new URL(`${pathToFileURL(file).href}?immutable=1`), { readOnly: true });
      const table = (name) => database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
      // A single-payload store not yet converted to tables: the live store
      // converts it on its next open, and the payload wins, so it is read here.
      legacy = table('shadowgraph_state') ? database.prepare('SELECT payload FROM shadowgraph_state WHERE id = 1').get()?.payload : undefined;
      if (legacy === undefined && table('shadowgraph_entities')) payload = exportSqlitePayload(database, { tolerant: true });
    } finally {
      database?.close();
    }
    await afterRead?.();
    if ((await inUse(file)) || (await fingerprint(file)) !== before) return { unavailable: 'busy' };
    if (legacy !== undefined) return { payload: JSON.parse(legacy) };
    if (payload === null) return { unavailable: (await stat(file)).size === 0 ? 'not_initialized' : 'unreadable' };
    return { payload };
  } catch {
    return { unavailable: 'unreadable' };
  }
}

// The per-user activation record (plan §26; programme plan revision 6 §5):
// `<SHADOWGRAPH_HOME, or ~/.shadowgraph>/activation.json`, written by
// `shadowgraph activate` (src/activation.js). A relative root is never trusted.
export function activationFile(env = process.env) {
  const root = env.SHADOWGRAPH_HOME || join(homedir(), '.shadowgraph');
  return isAbsolute(root) ? join(root, 'activation.json') : null;
}

// The delivery capability, when the record is a regular file saying delivery
// is active and naming the store it pins by absolute path; otherwise null,
// which leaves the hook path inert.
export async function activeDelivery(env = process.env) {
  try {
    const file = activationFile(env);
    if (!file || !(await lstat(file)).isFile()) return null;
    const delivery = JSON.parse(await readFile(file, 'utf8'))?.capabilities?.delivery;
    const pinned = delivery?.state === 'active' && typeof delivery.store?.file === 'string' && isAbsolute(delivery.store.file) && ['json', 'sqlite'].includes(delivery.store.storage);
    return pinned ? delivery : null;
  } catch {
    return null;
  }
}

// The hook's deadline, below the template's 10-second hook timeout (§18.4):
// past it the hook prints nothing and exits 0. SHADOWGRAPH_DELIVERY_DEADLINE_MS
// can only shorten it.
export const DELIVERY_DEADLINE_MS = 5000;
export function deliveryDeadlineMs(env = process.env) {
  const requested = Number(env.SHADOWGRAPH_DELIVERY_DEADLINE_MS);
  return requested > 0 ? Math.min(requested, DELIVERY_DEADLINE_MS) : DELIVERY_DEADLINE_MS;
}

// The hook's input: one JSON object, a leading byte-order mark allowed. Reading
// stops as soon as it parses, at the size limit, or after a short wait, so a
// host that leaves stdin open never holds the hook.
const unmarked = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
export function readHookInput(stream = process.stdin, { limit = HOOK_INPUT_LIMIT_BYTES, waitMs = HOOK_INPUT_WAIT_MS } = {}) {
  if (stream.isTTY) return Promise.resolve('');
  return new Promise((done) => {
    const chunks = [];
    let size = 0, settled = false;
    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeAllListeners('data');
      stream.destroy();
      done(unmarked(text));
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString('utf8')), waitMs);
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) return finish('');
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      try { JSON.parse(unmarked(text)); finish(text); } catch {}
    });
    stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => finish(''));
  });
}

// A line is rendered again from the redacted record, so its text never holds
// what redaction removed; its handle stays the read's own, bound to the record
// as stored, so expansion finds the very revision.
function itemOf({ tier, line, record, temporalEvidence }, records) {
  const time = { eventTime: temporalEvidence?.eventTime?.state ?? null, currentState: temporalEvidence?.currentState ? { state: temporalEvidence.currentState.state, basis: temporalEvidence.currentState.basis } : null };
  if (tier !== 'T1') return { tier, record, ...time };
  const full = records.get(line.recordId);
  if (!full) return null;
  // The one link a line renders is shown exactly when the read's own line
  // showed it; a part the redacted line cannot hold is declared, and the line
  // then asks for expansion.
  const rendered = t1Line(redactValue(full), {
    asOf: line.expansion.asOf, scope: line.expansion.scope, derivedAt: line.expansion.derivedAt,
    visible: (id) => id === line.status?.supersededBy
  });
  const omitted = rendered.decisiveOmitted;
  return { tier, line: rendered.line, claimClass: line.claimClass, requiresExpansion: line.requiresExpansion || omitted.length > 0, ...(omitted.length ? { omitted } : {}), ...time, expansion: line.expansion };
}

// No prompt at SessionStart: the working set, newest first within each kind and
// the kinds taken in turn, so neither the oldest decisions nor one kind fill
// the payload.
const recordedAt = (record) => String(record.temporal?.recordedAt ?? record.createdAt ?? record.recordedAt ?? record.observedAt ?? '');
function sessionOrder(items) {
  const byKind = new Map();
  for (const item of items) {
    const kind = item.record?.kind ?? 'fact';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(item);
  }
  const queues = [...byKind.values()].map((queue) => queue.sort((left, right) => recordedAt(right.record).localeCompare(recordedAt(left.record))));
  const ordered = [];
  while (queues.some((queue) => queue.length)) for (const queue of queues) if (queue.length) ordered.push(queue.shift());
  return ordered;
}

const PROJECT_UNRESOLVED = { code: 'project_unresolved', detail: 'No project was resolved for this workspace, so no project memory was searched.' };
const NOT_ASSESSED = { code: 'relevance_not_assessed', detail: `No prompt has been given yet, so relevance was not assessed: the working set follows, newest first and mixed by kind among its first ${MAX_PAGE_LIMIT} records (current decisions, failed and reusable attempts, then stale facts), as far as the payload cap allows. The semantic signal is unavailable on this path.` };

// SessionStart delivers the working set, the read's declared fallback when no
// signal can establish relevance (G-5 §9), and says what state memory is in:
// available, unavailable, or unresolved for this workspace. UserPromptSubmit
// ranks the prompt and delivers only what is relevant; otherwise it delivers
// nothing, the state having been said at the session's start (§18.4: degraded
// status is data, not a repeated alert; PC-09: no history dump).
//
// With `--hook` the capability must be active, and the store it pins is the
// one read, whatever SHADOWGRAPH_FILE or the workspace holds; a workspace
// binding then selects a project only when that store has recorded it too, so
// files a cloned repository ships choose nothing (FND-P5-07). Nothing is
// printed once the deadline has passed.
export async function runDeliver({ args = [], readInput = () => '', file, storage = 'json', env = process.env, deadline = Infinity, write }) {
  let trigger = null, emitted = false;
  const emit = (text) => {
    if (Date.now() >= deadline) return;
    emitted = true;
    write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: trigger, additionalContext: text } })}\n`);
  };
  try {
    const pinned = args.includes('--hook') ? await activeDelivery(env) : null;
    if (args.includes('--hook') && !pinned) return;
    let event;
    try { event = JSON.parse(unmarked(await readInput())); } catch { return; }
    if (!SERVED_EVENTS.has(event?.hook_event_name)) return;
    trigger = event.hook_event_name;
    const session = trigger === 'SessionStart';
    const prompt = session ? '' : typeof event.prompt === 'string' ? event.prompt : '';
    if (!session && !prompt.trim()) return;
    const read = await readStoreForDelivery(pinned ? pinned.store : { file, storage });
    const unavailable = read.unavailable ?? (read.payload?.schemaVersion > SCHEMA_VERSION ? 'newer_schema' : null);
    if (unavailable) return session ? emit(unavailablePayload(trigger, unavailable)) : undefined;
    const graph = createShadowGraph();
    try { graph.importData(read.payload); }
    catch { return session ? emit(unavailablePayload(trigger, 'unreadable')) : undefined; }
    const workspace = await discoverWorkspace(process.cwd(), { timeout: GIT_TIMEOUT_MS });
    // At SessionStart the whole working set, up to the largest page, is read,
    // so the order below chooses among all of it.
    const input = accessContext(graph, { query: prompt, compact: true, ...(session ? { limit: MAX_PAGE_LIMIT } : {}) }, 'cli', workspace, { confirmedByStore: Boolean(pinned) });
    const relevant = graph.context(input).relevant;
    const unresolved = relevant.scope.requestState !== 'project_selected';
    if (!session && (unresolved || !relevant.relevance.established)) return;
    // The records behind the lines, in this scope and as a read shows them,
    // looked up by id.
    const exported = session ? null : graph.exportData(input);
    const records = new Map(exported ? [...exported.records, ...exported.facts].map((record) => [record.id, record]) : []);
    const head = {
      trigger, store: 'available', scope: relevant.scope, complete: relevant.complete,
      limitation: unresolved ? PROJECT_UNRESOLVED : session ? NOT_ASSESSED : relevant.limitation ?? null,
      relevance: session ? 'not_assessed' : 'established',
      total: relevant.total, hasMore: relevant.hasMore, limitSource: relevant.limitSource, byKind: relevant.byKind,
      temporal: { eventTimeUnknown: relevant.temporal.eventTimeUnknown, recordingOrderOnly: relevant.temporal.recordingOrderOnly },
      // The host version recorded at activation; one other than the verified
      // version is said to be unverified (§18.1, F-23).
      ...(pinned?.host ? { host: pinned.host } : {})
    };
    const items = relevant.items.map((item) => itemOf(item, records)).filter(Boolean);
    emit(assemblePayload({ head, items: session ? sessionOrder(items) : items }).text);
  } catch {
    // Degraded, never blocking: nothing on stderr and no exit code (§18.4). A
    // session start that failed after the read still says memory is unavailable.
    try { if (trigger === 'SessionStart' && !emitted) emit(unavailablePayload(trigger, 'unreadable')); } catch {}
  }
}
