// Credential redaction (PR-30, moved here by PR-37b so the capture writer and
// delivery share one redactor; plan v1.4.4 §21.6: redaction at capture before
// write, and at delivery before stdout). Pure: no I/O, and nothing here
// imports the kernel.
import { credentialLiteralIn, isCredentialName as checkerCredentialName, urlContainsCredential } from './credential-literal.js';

export const REDACTED = '[REDACTED]';
// Why a capture is kept without its content (PR-37b).
export const CREDENTIAL_WITHHELD = 'credential_withheld';
const MOST_NESTING = 100;

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
const CREDENTIAL_PAIRS = new Set(['apikey', 'apitoken', 'accesstoken', 'authtoken', 'secretkey', 'privatekey', 'clientsecret', 'accesskey', 'accountkey', 'signingkey', 'masterkey', 'encryptionkey', 'sessiontoken', 'refreshtoken', 'bearertoken', 'idtoken', 'keydata']);
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
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gu,
  // Shapes the post-merge review (R3-9) found passing: Stripe webhook secrets,
  // Google OAuth access tokens, Slack app tokens, Docker and Grafana tokens.
  /\bwhsec_[A-Za-z0-9]{24,}/gu,
  /\bya29\.[A-Za-z0-9_-]{20,}/gu,
  /\bxapp-[A-Za-z0-9-]{10,}/gu,
  /\bdckr_pat_[A-Za-z0-9_-]{20,}/gu,
  /\bglsa_[A-Za-z0-9_]{32,}/gu
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
const CREDENTIAL_FLAG = /((?:^|\s)--(?:password|passwd|pass|pw|auth|token|api-?key|secret|client-secret|auth-token)(?:=|\s+))\S+/giu;
const USER_PASSWORD_FLAG = /((?:^|\s)(?:-u|--user)\s+)[^\s:]+:\S+/gu;
const AUTH_SCHEME = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/giu;
export const KEYED_NAMES = ['key', 'name', 'Key', 'Name', 'ParameterKey'];
export const KEYED_VALUES = new Set(['value', 'text', 'Value', 'ParameterValue']);

// The checker's names, and any name one of whose words is a credential word or
// whose two neighbouring words make one (`SECRET_KEY_BASE`, `dbPassword`).
export function isCredentialName(name, allowBareKey = false) {
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

// A cookie header, also as a quoted JSON key, whose value holds a name=value
// pair: session credentials, removed to the line's end. Prose about a cookie
// is left alone.
const COOKIE_HEADER = /(\b(?:set-)?cookie["']?[^\S\r\n]*:)(?=[^\S\r\n]*["']?[^\s=;"']+=)[^\r\n]*/giu;
function redactView(text) {
  let result = text.replace(KEY_BLOCK, REDACTED);
  for (const pattern of KNOWN_TOKENS) result = result.replace(pattern, REDACTED);
  result = result.replace(URL_USERINFO, `$1${REDACTED}@`);
  result = result.replace(ANY_URL, (url) => (urlHasCredential(url.replace(/^[^a-z]+/iu, '')) ? REDACTED : url));
  result = result.replace(DEFINE, (match, quote, name) => (isCredentialName(name) ? REDACTED : match));
  result = result.replace(ELEMENT, (match, tag) => (isCredentialName(tag) ? `<${tag}>${REDACTED}</${tag}>` : match));
  result = result.replace(CREDENTIAL_FLAG, `$1${REDACTED}`).replace(USER_PASSWORD_FLAG, `$1${REDACTED}`);
  result = result.replace(COOKIE_HEADER, `$1 ${REDACTED}`);
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
export const fold = (text) => text.normalize('NFKC').replace(FORMAT_CHARACTERS, '');
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
      // The key's body running on into this value, then other text: the
      // body's lines go, and the rest is redacted as text (PR-37b).
      const lines = value.split(/\r?\n/u);
      let lead = 0;
      while (lead < lines.length && base64Line(lines[lead].trim())) lead += 1;
      if (lead > 0 && isKeyBody(lines.slice(0, lead).join('\n'))) value = [REDACTED, ...lines.slice(lead)].join('\n');
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
export const flaggedText = (value) => credentialLiteralIn(value) || credentialLiteralIn(fold(value));
// The JSON string literals in a text, quotes paired left to right, a
// backslash escaping the character after it. One pass: once a literal is left
// open, no later one can close.
export function jsonLiterals(text) {
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
// Whether the checker flags a text, as it stands, folded, or in any JSON
// string literal it carries, decoded.
export const credentialFlagged = (text) => flaggedText(text) || jsonLiterals(text).some((literal) => {
  try { return flaggedText(JSON.parse(literal)); } catch { return false; }
});

// A value whose strings the checker still flags after redaction loses them
// whole (PR-37b): what a capture observed is kept, never its credential.
export function withholdFlagged(value, depth = 0) {
  if (typeof value === 'string') return credentialFlagged(value) ? REDACTED : value;
  if (value && typeof value === 'object' && depth >= MOST_NESTING) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => withholdFlagged(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, withholdFlagged(item, depth + 1)]));
  return value;
}

// What a capture withholds after redaction (plan v1.4.4 §21.2 M-2; PR-37
// design §3.2, revision 2 R2, R6): whatever the checker still flags, and
// any text holding the boundary line of a private key, whose other part
// another item took. The checker is the floor: what it would call a credential
// never reaches the store.
export const captureWithheld = (text) => credentialFlagged(text) || KEY_BLOCK_BEGIN.test(text) || KEY_BLOCK_END.test(text);
