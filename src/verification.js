import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { effectiveFactExpirationBoundary, factValidityPolicyIssue } from './fact-validity.js';

export const LOCAL_EVIDENCE_METHOD = 'ed25519-local-evidence-v1';
const EVIDENCE_SCHEMA_VERSION = 2;
const MAX_EVIDENCE_BYTES = 64 * 1024;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function assertFactValidityPolicy(fact) {
  const issue = factValidityPolicyIssue(fact, { required: true });
  if (issue) {
    if (issue === 'Fact validityPolicy is required') throw new Error('Fact validityPolicy is required for signed verification');
    throw new Error(issue);
  }
  return fact.validityPolicy;
}

function factClaim(fact) {
  const validityPolicy = assertFactValidityPolicy(fact);
  return {
    factId: fact.id,
    project: fact.project ?? 'default',
    key: fact.key,
    value: fact.value,
    sourceClass: fact.sourceClass ?? null,
    sourceRaw: fact.sourceRaw ?? null,
    actor: fact.actor ?? null,
    client: fact.client ?? null,
    sessionId: fact.sessionId ?? null,
    confidence: fact.confidence ?? null,
    observedAt: fact.observedAt ?? null,
    validFrom: fact.temporal?.validFrom ?? fact.validFrom ?? fact.observedAt ?? null,
    recordedAt: fact.temporal?.recordedAt ?? fact.recordedAt ?? fact.observedAt ?? null,
    expiresAt: fact.expiresAt ?? null,
    validityPolicy
  };
}

export function factVerificationDigest(fact) {
  if (!fact || fact.kind !== 'fact' || typeof fact.id !== 'string' || !fact.id) {
    throw new Error('A fact with a non-empty id is required for verification');
  }
  return `sha256:${createHash('sha256').update(canonicalJson(factClaim(fact))).digest('hex')}`;
}

function signableAttestation(attestation) {
  return {
    schemaVersion: attestation.schemaVersion,
    factId: attestation.factId,
    factDigest: attestation.factDigest,
    verifierIdentity: attestation.verifierIdentity,
    evidenceReference: attestation.evidenceReference,
    verificationMethod: attestation.verificationMethod,
    verifiedAt: attestation.verifiedAt
  };
}

function assertTimestamp(value, name) {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error(`${name} must be a valid timestamp`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) throw new Error(`${name} must be a valid timestamp`);
  if (zone !== 'Z') {
    const [zoneHour, zoneMinute] = zone.slice(1).split(':').map(Number);
    if (zoneHour > 23 || zoneMinute > 59) throw new Error(`${name} must be a valid timestamp`);
  }
}

function assertAttestationShape(attestation) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) throw new Error('Evidence document must be a JSON object');
  const allowed = new Set(['schemaVersion', 'factId', 'factDigest', 'verifierIdentity', 'evidenceReference', 'verificationMethod', 'verifiedAt', 'signature']);
  const unknown = Object.keys(attestation).find((name) => !allowed.has(name));
  if (unknown) throw new Error(`Evidence document contains unknown field ${unknown}`);
  if (attestation.schemaVersion !== EVIDENCE_SCHEMA_VERSION) throw new Error(`Evidence schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`);
  for (const name of ['factId', 'factDigest', 'verifierIdentity', 'evidenceReference', 'verificationMethod', 'signature']) {
    if (typeof attestation[name] !== 'string' || !attestation[name].trim()) throw new Error(`Evidence ${name} must be a non-empty string`);
  }
  if (attestation.verificationMethod !== LOCAL_EVIDENCE_METHOD) throw new Error(`Unsupported verification method: ${attestation.verificationMethod}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(attestation.factDigest)) throw new Error('Evidence factDigest must be a sha256 digest');
  assertTimestamp(attestation.verifiedAt, 'Evidence verifiedAt');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(attestation.signature)) throw new Error('Evidence signature must be a canonical Ed25519 base64 signature');
}

function keyMap(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('trustedVerifiers must be an object');
  const result = new Map();
  for (const [identity, key] of Object.entries(input)) {
    if (!identity.trim()) throw new Error('Trusted verifier identities must be non-empty');
    const publicKey = key?.type === 'public' ? key : createPublicKey(key);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error(`Trusted verifier ${identity} must use an Ed25519 public key`);
    result.set(identity, publicKey);
  }
  if (!result.size) throw new Error('At least one trusted verifier public key is required');
  return result;
}

function checkAttestation(attestation, fact, trustedKeys) {
  assertAttestationShape(attestation);
  if (attestation.factId !== fact.id) throw new Error('Evidence factId does not match the requested fact');
  const digest = factVerificationDigest(fact);
  if (attestation.factDigest !== digest) throw new Error('Evidence factDigest does not match the current fact');
  const publicKey = trustedKeys.get(attestation.verifierIdentity);
  if (!publicKey) throw new Error(`Verifier identity is not trusted: ${attestation.verifierIdentity}`);
  const signature = Buffer.from(attestation.signature, 'base64');
  const valid = verify(null, Buffer.from(canonicalJson(signableAttestation(attestation))), publicKey, signature);
  if (!valid) throw new Error('Evidence signature verification failed');
  return {
    factId: attestation.factId,
    factDigest: attestation.factDigest,
    verifierIdentity: attestation.verifierIdentity,
    evidenceReference: attestation.evidenceReference,
    verificationMethod: attestation.verificationMethod,
    verifiedAt: attestation.verifiedAt,
    signature: attestation.signature
  };
}

function assertActiveFactBeforeSignedBoundary(fact, trustedValidationInstant) {
  if (fact?.status !== 'active' || trustedValidationInstant === undefined || trustedValidationInstant === null) return;
  assertTimestamp(trustedValidationInstant, 'Trusted validation instant');
  const boundary = effectiveFactExpirationBoundary(fact);
  if (boundary && Date.parse(trustedValidationInstant) >= Date.parse(boundary)) {
    throw new Error('Active fact is at or past its signed effective expiration boundary');
  }
}

export function createFactAttestation(input = {}) {
  const { fact, privateKey } = input;
  if (!privateKey) throw new Error('A verifier private key is required to create an attestation');
  const attestation = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    factId: fact?.id,
    factDigest: factVerificationDigest(fact),
    verifierIdentity: input.verifierIdentity,
    evidenceReference: input.evidenceReference,
    verificationMethod: input.verificationMethod ?? LOCAL_EVIDENCE_METHOD,
    verifiedAt: input.verifiedAt
  };
  for (const name of ['verifierIdentity', 'evidenceReference']) {
    if (typeof attestation[name] !== 'string' || !attestation[name].trim()) throw new Error(`${name} must be a non-empty string`);
  }
  if (attestation.verificationMethod !== LOCAL_EVIDENCE_METHOD) throw new Error(`Unsupported verification method: ${attestation.verificationMethod}`);
  assertTimestamp(attestation.verifiedAt, 'verifiedAt');
  const signingKey = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('A verifier private key must use Ed25519');
  const signature = sign(null, Buffer.from(canonicalJson(attestation)), signingKey).toString('base64');
  return { ...attestation, signature };
}

async function resolveEvidencePath(root, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('evidencePath must be a non-empty path');
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  let actual;
  try { actual = await realpath(absolute); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Evidence file not found: ${candidate}`);
    throw error;
  }
  const actualRoot = await realpath(root);
  const rel = relative(actualRoot, actual);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('Evidence path must stay within the configured evidence root');
  }
  const info = await stat(actual);
  if (!info.isFile()) throw new Error('Evidence path must reference a regular file');
  if (info.size > MAX_EVIDENCE_BYTES) throw new Error(`Evidence file exceeds ${MAX_EVIDENCE_BYTES} bytes`);
  return actual;
}

export function createLocalEvidenceVerifier(options = {}) {
  if (typeof options.allowedEvidenceRoot !== 'string' || !options.allowedEvidenceRoot.trim()) {
    throw new Error('allowedEvidenceRoot must be a non-empty path');
  }
  const root = resolve(options.allowedEvidenceRoot);
  const trustedKeys = keyMap(options.trustedVerifiers);
  return Object.freeze({
    method: LOCAL_EVIDENCE_METHOD,
    async verify({ fact, evidencePath }) {
      const path = await resolveEvidencePath(root, evidencePath);
      let attestation;
      try { attestation = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) {
        if (error instanceof SyntaxError) throw new Error('Evidence file must contain valid JSON');
        throw error;
      }
      return checkAttestation(attestation, fact, trustedKeys);
    },
    validateStored(fact, validation = {}) {
      try {
        const checked = checkAttestation({ schemaVersion: EVIDENCE_SCHEMA_VERSION, ...fact?.verification }, fact, trustedKeys);
        assertActiveFactBeforeSignedBoundary(fact, validation.trustedValidationInstant);
        return canonicalJson(checked) === canonicalJson(fact.verification);
      } catch {
        return false;
      }
    }
  });
}

export async function loadLocalEvidenceVerifier(configPath) {
  if (typeof configPath !== 'string' || !configPath.trim()) throw new Error('Verifier config path must be a non-empty path');
  const absolute = resolve(configPath);
  const info = await stat(absolute);
  if (!info.isFile()) throw new Error('Verifier config must be a regular file');
  if (info.size > MAX_EVIDENCE_BYTES) throw new Error(`Verifier config exceeds ${MAX_EVIDENCE_BYTES} bytes`);
  let config;
  try { config = JSON.parse(await readFile(absolute, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Verifier config must contain valid JSON');
    throw error;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Verifier config must be a JSON object');
  const allowedEvidenceRoot = isAbsolute(config.allowedEvidenceRoot ?? '')
    ? config.allowedEvidenceRoot
    : resolve(dirname(absolute), config.allowedEvidenceRoot ?? '');
  return createLocalEvidenceVerifier({
    allowedEvidenceRoot,
    trustedVerifiers: config.trustedVerifiers
  });
}

// Plan v1.4.4 §14 (PR-22): the claim verifier. Deterministic local code with no
// model call. It classifies one claim against the source text it cites:
//   quoted      the claim is a span of the source under whitespace-and-case
//               normalisation, and the source says nothing else;
//   entailed    the same, once a named derivation rule is applied (the rule is
//               recorded);
//   ambiguous   the source says the claim plainly in one place and qualified
//               in another, and nothing else (the readings are recorded);
//   unsupported anything else, with the dimension that failed, or `no_span`.
// It fails safe (§14.4: fidelity, not yield). A deterministic reader cannot
// tell which other sentence retracts, hedges or narrows a claim ("Oops,
// disregard that.", "Untested.", "E2E suite skipped."), so it vouches only for
// a claim its source states alone:
//   - the claim's own unit (a line, or a sentence within one) holds nothing
//     beside it but a list bullet or number, "the", "a", "an", and closing
//     punctuation;
//   - every other unit of the source that does not itself hold the claim is
//     neutral: only neutral heading words, no question and no markup.
// Word lists only name the dimension that failed. Markers are read after NFKC,
// with format and combining characters ignored, apostrophe variants folded and
// contractions split; a word mixing scripts is a marker. The lexicons are
// English only. Nothing here sets a verificationStatus, and an unsupported
// claim is returned apart and never promoted.
export const CLAIM_VERIFIER_VERSION = 'claim-verifier-v1';
export const CLAIM_DIMENSIONS = Object.freeze(['quantifier', 'polarity', 'actor', 'time', 'scope', 'modality']);
export const CLAIM_DERIVATION_RULES = Object.freeze({
  'contraction-expansion-v1': "reads n't, 're, 've, 'll and 'm (with any apostrophe) as the words they contract; nothing else"
});
// The order a failure is reported in: what reverses or hedges a claim first.
const FAILURE_ORDER = ['polarity', 'modality', 'quantifier', 'actor', 'time', 'scope'];

const CLAIM_MARKERS = {
  quantifier: ['all', 'every', 'each', 'some', 'several', 'few', 'many', 'most', 'mostly', 'any', 'both', 'only', 'just', 'always', 'sometimes', 'usually', 'often', 'rarely', 'occasionally', 'intermittently', 'nightly', 'daily', 'partially', 'partly', 'largely', 'entirely', 'fully', 'half', 'majority', 'almost', 'nearly', 'about', 'approximately', 'around', 'roughly', 'percent', 'once', 'twice', 'zero', 'one', 'two', 'three', 'handful'],
  polarity: ['not', 'no', 'nope', 'nah', 'never', 'none', 'nobody', 'noone', 'nothing', 'neither', 'nor', 'without', 'cannot', 'non', 'unable', 'hardly', 'barely', 'scarcely', 'false', 'untrue', 'incorrect', 'incorrectly', 'inaccurate', 'wrong', 'wrongly', 'mistaken', 'myth', 'debunked', 'unless', 'deny', 'denies', 'denied', 'refused', 'rejected', 'reverted', 'rolled', 'rollback', 'refuted', 'disputed', 'lied', 'fail', 'fails', 'failed', 'failing', 'failure', 'failures', 'error', 'errors', 'unsuccessful', 'unsuccessfully', 'lack', 'lacks', 'lacked', 'lacking', 'absent', 'absence', 'missing', 'incomplete', 'pending', 'blocked', 'removed', 'deprecated', 'obsolete', 'retracted', 'scratch', 'correction', 'undone', 'undid', 'timed', 'crashed', 'aborted', 'cancelled', 'canceled', 'killed', 'broke', 'broken'],
  actor: ['i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their', 'user', 'users', 'agent', 'agents', 'assistant', 'claude', 'human', 'owner', 'operator', 'developer', 'developers', 'engineer', 'engineers', 'team', 'bot', 'model', 'someone', 'somebody', 'everyone', 'attacker', 'wrote'],
  time: ['was', 'were', 'had', 'will', 'previously', 'earlier', 'before', 'after', 'yesterday', 'today', 'tomorrow', 'now', 'currently', 'still', 'then', 'formerly', 'ago', 'later', 'until', 'since', 'last', 'next', 'anymore', 'recently', 'during', 'soon', 'eventually', 'initially', 'originally', 'temporarily', 'briefly', 'historically', 'future', 'past', 'scheduled', 'used', 'when'],
  scope: ['in', 'on', 'at', 'with', 'from', 'by', 'within', 'under', 'for', 'against', 'via', 'using', 'across', 'per', 'inside', 'outside', 'except', 'excluding', 'staging', 'production', 'prod', 'development', 'dev', 'locally', 'local', 'remote', 'ci', 'windows', 'linux', 'macos', 'branch', 'environment', 'mocked', 'mock', 'sandbox', 'simulated', 'dry', 'disabled', 'enabled', 'other', 'expected', 'received'],
  modality: ['may', 'might', 'could', 'can', 'should', 'would', 'must', 'possibly', 'probably', 'likely', 'unlikely', 'perhaps', 'maybe', 'seems', 'seem', 'seemed', 'seemingly', 'appears', 'appear', 'appeared', 'apparently', 'suggests', 'suggest', 'suggested', 'reportedly', 'reported', 'reports', 'supposedly', 'suppose', 'allegedly', 'presumably', 'hopefully', 'hoping', 'hoped', 'ideally', 'theoretically', 'arguably', 'according', 'said', 'says', 'say', 'saying', 'state', 'states', 'stated', 'claimed', 'claims', 'claim', 'believes', 'believe', 'believed', 'thinks', 'think', 'thought', 'told', 'heard', 'doubt', 'doubts', 'doubted', 'doubtful', 'suspect', 'suspects', 'suspected', 'assume', 'assumes', 'assumed', 'assuming', 'assumption', 'assumptions', 'hypothesis', 'hypotheses', 'hypothetically', 'guess', 'bet', 'speculated', 'expect', 'expects', 'plan', 'plans', 'planned', 'goal', 'goals', 'todo', 'tbd', 'intended', 'wanted', 'want', 'proposed', 'proposal', 'tried', 'attempted', 'verify', 'ensure', 'make', 'whether', 'if', 'asked', 'question', 'wondered', 'clear', 'unclear', 'certain', 'uncertain', 'convinced', 'unconfirmed', 'unverified', 'rumor', 'rumors', 'rumour', 'rumours', 'because', 'caused', 'causes', 'cause', 'causing', 'due', 'therefore', 'thus', 'hence', 'led', 'leads', 'resulted', 'so', 'joked', 'criteria', 'acceptance']
};
const MARKER_DIMENSION = new Map(CLAIM_DIMENSIONS.flatMap((dimension) => CLAIM_MARKERS[dimension].map((word) => [word, dimension])));
const SUFFIX_DIMENSION = new Map([["n't", 'polarity'], ["'ll", 'time'], ["'ve", 'time'], ["'d", 'modality']]);
const NEUTRAL_WORDS = new Set(['the', 'a', 'an']);
// Every other unit of a quoted claim's source may use these words and no others.
// Structural heading words only: none says what state anything is in ("Fixed.",
// "Done." or "Passed now." after a claim would change it).
const LABEL_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'summary', 'result', 'results', 'output', 'outputs', 'status', 'note', 'notes', 'log', 'logs', 'detail', 'details', 'changes', 'changelog', 'fact', 'facts', 'evidence', 'finding', 'findings', 'outcome', 'outcomes', 'report', 'overview', 'context', 'background', 'description', 'response', 'answer', 'reply', 'transcript', 'session', 'history']);
const CLAIM_STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'to', 'that', 'this', 'these', 'those', 'it', 'its', 'is', 'are', 'am', 'be', 'been', 'being', 'has', 'have', 'do', 'does', 'did', 'as', 'and', 'or', 'but', 'there', 'here', 'what', 'which', 'who']);
const APOSTROPHES = "'’ʼ`´‘′‛＇";
const APOSTROPHE = new RegExp(`[${APOSTROPHES}]`, 'g');
const ANY_APOSTROPHE = `[${APOSTROPHES}]`;
const WORD = new RegExp(`[\\p{L}\\p{M}\\p{N}\\p{Cf}]+(?:${ANY_APOSTROPHE}[\\p{L}\\p{M}\\p{Cf}]+)?`, 'gu');
const WORD_CHARACTER = new RegExp(`[\\p{L}\\p{M}\\p{N}\\p{Cf}${APOSTROPHES}]`, 'u');
const wordCharacter = (character) => character !== undefined && WORD_CHARACTER.test(character);
const NEGATED_AUXILIARY = /^(?:do|does|did|is|are|was|were|has|have|had|can|could|would|should|wo|ca|must|need|ai|sha)nt$/;
const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'vs', 'etc', 'eg', 'ie', 'fig', 'no', 'vol', 'approx', 'inc', 'ltd', 'jr', 'sr']);
// ponytail: a crude suffix stem, used only to compare words across a claim and
// its source when there is no span; it never makes a claim supported.
const stem = (word) => word.replace(/(ing|ed|es|e|s|d)$/, '');

// A word as markers read it: NFKC, no format or combining characters, one
// apostrophe, lower case; and its base and suffix when it is a contraction.
function readWord(raw) {
  const word = raw.normalize('NFKC').replace(/[\p{Cf}\p{M}]/gu, '').replace(APOSTROPHE, "'").toLowerCase();
  const cut = word.endsWith("n't") ? word.length - 3 : word.indexOf("'");
  return { word, base: cut > 0 ? word.slice(0, cut) : word, suffix: cut > 0 ? word.slice(cut) : '' };
}
// A word that mixes Latin letters with Greek or Cyrillic ones is never read as
// the word it looks like; it qualifies whatever it stands beside.
const MIXED_SCRIPT = (word) => /\p{Script=Latin}/u.test(word) && /[\p{Script=Greek}\p{Script=Cyrillic}]/u.test(word);
function markerOf({ word, base, suffix }) {
  if (MIXED_SCRIPT(word)) return 'scope';
  if (NEGATED_AUXILIARY.test(word) || suffix === "n't") return 'polarity';
  if (/^\p{N}/u.test(base)) return 'quantifier';
  return MARKER_DIMENSION.get(base) ?? SUFFIX_DIMENSION.get(suffix) ?? MARKER_DIMENSION.get(word) ?? null;
}
function wordsOf(text, offset = 0) {
  const words = [];
  for (const match of text.matchAll(WORD)) {
    const read = readWord(match[0]);
    if (read.word) words.push({ ...read, marker: markerOf(read), start: offset + match.index, end: offset + match.index + match[0].length });
  }
  return words;
}
const contentOf = (words) => words.filter(({ base, marker }) => !marker && !CLAIM_STOP_WORDS.has(base)).map(({ base }) => stem(base));
function markersOf(words) {
  const profile = Object.fromEntries(CLAIM_DIMENSIONS.map((dimension) => [dimension, new Set()]));
  for (const { base, suffix, marker } of words) if (marker) profile[marker].add(marker === 'polarity' && suffix === "n't" ? 'not' : stem(base));
  return profile;
}
const isQuestionMark = (character) => character === '?' || character.normalize('NFKC') === '?';

// Whitespace runs become one space and letters are lower-cased; `map[i]` is the
// source offset of normalised character i. Linear in the source.
function normaliseClaimText(text) {
  const out = [];
  const map = [];
  let space = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (/\s/.test(character)) { space = out.length > 0; continue; }
    if (space) { out.push(' '); map.push(index - 1); space = false; }
    for (const lower of character.toLowerCase()) { out.push(lower); map.push(index); }
  }
  return { text: out.join(''), map };
}

// Units: lines, and sentences within them. A sentence ends at . ! ? before
// whitespace, except after a number, a single letter or a known abbreviation,
// so a list number or "Dr." never starts a unit of its own. One pass.
function unitsOf(text) {
  const units = [];
  let start = 0;
  const close = (end) => {
    let from = start;
    let to = end;
    while (from < to && /\s/.test(text[from])) from += 1;
    while (to > from && /\s/.test(text[to - 1])) to -= 1;
    if (to > from) units.push([from, to]);
    start = end;
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\n') { close(index); continue; }
    if (!'.!?'.includes(character) || !/\s/.test(text[index + 1] ?? ' ')) continue;
    let wordStart = index;
    while (wordStart > start && /[\p{L}\p{N}]/u.test(text[wordStart - 1])) wordStart -= 1;
    const before = text.slice(wordStart, index).toLowerCase();
    if (character === '.' && (/^\p{N}+$/u.test(before) || before.length === 1 || ABBREVIATIONS.has(before) || /^v\d/.test(before))) continue;
    close(index + 1);
  }
  close(text.length);
  return units;
}

// Prefix counts over a sorted list, and the index of the first item at or after
// an offset: every span check is a lookup.
function prefixCounts(items, keep) {
  const counts = [0];
  for (const item of items) counts.push(counts.at(-1) + (keep(item) ? 1 : 0));
  return counts;
}
function firstAtOrAfter(items, offset) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (items[middle].start < offset) low = middle + 1; else high = middle;
  }
  return low;
}
const countIn = (items, counts, from, to) => counts[firstAtOrAfter(items, to)] - counts[firstAtOrAfter(items, from)];

// Reads a source once: its units; each unit's words and signs with prefix
// counts, for the claim's own unit; and, for every other unit, what makes it
// say something (the dimensions of its markers, `scope` for any other word
// that is not a neutral heading word or for markup, `modality` for a question).
function readSource(text) {
  const diffLike = /^\+(?!\+)/m.test(text);
  // A number is a list number only in a list: two numbered lines at least, and
  // not before a lowercase word. Otherwise it is a count.
  const numbered = (text.match(/^[ \t]*\d{1,3}\.[ \t]/gm) ?? []).length >= 2 ? '|\\d{1,3}\\.(?=\\s+[^\\p{Ll}])' : '';
  const listMarker = new RegExp(`^(?:${diffLike ? '[*•]' : '[-*+•]'}${numbered})\\s+`, 'u');
  const units = [];
  for (const [from, to] of unitsOf(text)) {
    const body = text.slice(from, to);
    const bullet = listMarker.exec(body)?.[0].length ?? 0;
    const bodyFrom = from + bullet;
    const words = wordsOf(text.slice(bodyFrom, to), bodyFrom);
    const signs = [];
    const inWord = new Uint8Array(to - bodyFrom);
    for (const word of words) inWord.fill(1, word.start - bodyFrom, word.end - bodyFrom);
    for (let at = bodyFrom; at < to; at += 1) {
      if (inWord[at - bodyFrom] || /\s/.test(text[at])) continue;
      signs.push({ start: at, question: isQuestionMark(text[at]), closing: '.,;!'.includes(text[at]) });
    }
    const says = new Set();
    for (const { word, marker } of words) if (marker || !LABEL_WORDS.has(word)) says.add(marker ?? 'scope');
    if (signs.some(({ question }) => question)) says.add('modality');
    if (signs.some(({ start: at }) => !`.,;:!?"'()-`.includes(text[at])) || /:[\w+-]+:/.test(body)) says.add('scope');
    units.push({
      from, to, bodyFrom, words, signs, says,
      unknown: prefixCounts(words, ({ word, marker }) => !marker && !NEUTRAL_WORDS.has(word)),
      dimension: Object.fromEntries(CLAIM_DIMENSIONS.map((dimension) => [dimension, prefixCounts(words, ({ marker }) => marker === dimension)])),
      question: prefixCounts(signs, ({ question }) => question),
      opening: prefixCounts(signs, () => true),
      unclosing: prefixCounts(signs, ({ closing, question }) => !closing || question)
    });
  }
  return { text, units, normalised: normaliseClaimText(text), readings: new Map() };
}
function unitAt(units, offset) {
  let low = 0;
  let high = units.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (units[middle].to <= offset) low = middle + 1; else high = middle;
  }
  return low;
}

// The claim's own units at [start, end): nothing beside it but neutral
// material. All by lookup.
function readSpan(source, [start, end]) {
  const { units } = source;
  const first = unitAt(units, start);
  const last = unitAt(units, Math.max(start, end - 1));
  const failed = new Set();
  // Words no list names, or signs, beside the claim: not a reading of it but
  // something else said with it.
  let strange = false;
  for (let index = first; index <= last; index += 1) {
    const unit = units[index];
    const outside = (counts) => counts.at(-1) - countIn(unit.words, counts, start, end);
    if (outside(unit.unknown)) { failed.add('scope'); strange = true; }
    for (const dimension of CLAIM_DIMENSIONS) if (outside(unit.dimension[dimension])) failed.add(dimension);
  }
  const head = units[first];
  const tail = units[last];
  if (countIn(head.signs, head.question, head.bodyFrom, start) || countIn(tail.signs, tail.question, end, tail.to + 1)) failed.add('modality');
  else if (countIn(head.signs, head.opening, head.bodyFrom, start) || countIn(tail.signs, tail.unclosing, end, tail.to + 1)) { failed.add('scope'); strange = true; }
  return { units: [first, last], failed, strange };
}
const checksOf = (failed) => Object.fromEntries(CLAIM_DIMENSIONS.map((dimension) => [dimension, failed.has(dimension) ? 'inconsistent' : 'consistent']));
const failingOf = (failed) => FAILURE_ORDER.find((dimension) => failed.has(dimension)) ?? null;

// Where the claim occurs in the source, on word boundaries, as source offsets.
// The pattern is a literal, or the literal with each contracted form of the
// named rule allowed: never a backtracking construct.
function occurrencesOf(pattern, source) {
  const found = [];
  const { normalised } = source;
  for (const match of normalised.text.matchAll(pattern)) {
    const start = normalised.map[match.index];
    const end = normalised.map[match.index + match[0].length - 1] + 1;
    if (!wordCharacter(source.text[start - 1]) && !wordCharacter(source.text[end])) found.push([start, end]);
  }
  return found;
}
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function contractedPattern(expandedClaim) {
  return literal(expandedClaim)
    .replace(/\bwill not\b/g, `(?:will not|won${ANY_APOSTROPHE}?t)`)
    .replace(/\bcannot\b/g, `(?:cannot|can${ANY_APOSTROPHE}?t)`)
    .replace(/\b(do|does|did|is|are|was|were|has|have|had|could|would|should|must|need) not\b/g, `$1(?: not|n${ANY_APOSTROPHE}?t)`)
    .replace(/\bi am\b/g, `i(?: am|${ANY_APOSTROPHE}m)`)
    .replace(/\b(you|we|they) are\b/g, `$1(?: are|${ANY_APOSTROPHE}re)`)
    .replace(/\b(i|you|we|they) have\b/g, `$1(?: have|${ANY_APOSTROPHE}ve)`)
    .replace(/\b(i|you|we|they|he|she|it) will\b/g, `$1(?: will|${ANY_APOSTROPHE}ll)`);
}
const expandContractions = (text) => text.replace(APOSTROPHE, "'").replace(/\bcan't\b/g, 'cannot').replace(/\bwon't\b/g, 'will not')
  .replace(/n't\b/g, ' not').replace(/'re\b/g, ' are').replace(/'ve\b/g, ' have').replace(/'ll\b/g, ' will').replace(/'m\b/g, ' am');

// No usable span: which dimension explains the difference? First, the claim
// must be about the source at all; then a marker the claim adds that the source
// never has; then a marker the closest source unit has that the claim drops.
// What a diagnosis reads of the whole source does not depend on the claim, so a
// source read once (verifiedClaims reads each sourceRef once) is summarised once,
// not once per claim that has no span in it.
const sourceSummaries = new WeakMap();
function summaryOf(source) {
  let summary = sourceSummaries.get(source);
  if (!summary) {
    const words = source.units.flatMap((unit) => unit.words);
    summary = { content: new Set(contentOf(words)), markers: markersOf(words), unitContent: source.units.map((unit) => contentOf(unit.words)) };
    sourceSummaries.set(source, summary);
  }
  return summary;
}
function diagnoseClaim(claimText, source) {
  const claimWords = wordsOf(claimText);
  const content = contentOf(claimWords);
  const { content: sourceContent, markers: sourceMarkers, unitContent } = summaryOf(source);
  if (!content.length || content.filter((word) => sourceContent.has(word)).length / content.length < 0.5) return 'no_span';
  const claimMarkers = markersOf(claimWords);
  const added = FAILURE_ORDER.find((dimension) => [...claimMarkers[dimension]].some((marker) => !sourceMarkers[dimension].has(marker)));
  if (added) return added;
  const wanted = new Set(content);
  let closest = null;
  let best = -1;
  source.units.forEach((unit, index) => {
    const overlap = unitContent[index].filter((word) => wanted.has(word)).length;
    if (overlap > best) { best = overlap; closest = unit; }
  });
  const closestMarkers = markersOf(closest?.words ?? []);
  if (closest?.question.at(-1)) closestMarkers.modality.add('?');
  return FAILURE_ORDER.find((dimension) => [...closestMarkers[dimension]].some((marker) => !claimMarkers[dimension].has(marker))) ?? 'no_span';
}

// The claim's own words, with outer quotes, brackets and final punctuation
// taken off, without a backtracking pattern.
function claimWordsOf(text) {
  let from = 0;
  let to = text.length;
  while (from < to && /[\s"'“‘(\[]/.test(text[from])) from += 1;
  while (to > from && /[\s"'”’)\].!;:,]/.test(text[to - 1])) to -= 1;
  return normaliseClaimText(text.slice(from, to)).text;
}

// Every place the claim occurs is read on its own; everything else in the
// source must say nothing. Plain everywhere: one class; plain in one place and
// narrowed in another (quantity, scope, time or actor, never a reversal or a
// hedge): ambiguous, with up to READING_LIMIT readings. A caller's own place
// must be plain.
const READING_LIMIT = 32;
function readingOf(source, [first, last]) {
  const key = `${first}:${last}`;
  if (!source.readings.has(key)) {
    const text = normaliseClaimText(source.text.slice(source.units[first].from, source.units[last].to)).text;
    let to = text.length;
    while (to > 0 && '.!?'.includes(text[to - 1])) to -= 1;
    source.readings.set(key, text.slice(0, to));
  }
  return source.readings.get(key);
}
function readOccurrences(source, found, preferred) {
  const reads = found.map((occurrence) => ({ occurrence, ...readSpan(source, occurrence) }));
  const occupied = new Set(reads.flatMap(({ units: [first, last] }) => Array.from({ length: last - first + 1 }, (_, offset) => first + offset)));
  const elsewhere = new Set();
  source.units.forEach((unit, index) => { if (!occupied.has(index)) for (const dimension of unit.says) elsewhere.add(dimension); });
  const inconsistent = (failed) => ({ outcome: 'inconsistent', failing: failingOf(failed), checks: checksOf(failed) });
  const own = preferred && reads.find(({ occurrence }) => occurrence[0] === preferred[0] && occurrence[1] === preferred[1]);
  // A reversal, a hedge or a question at any place the claim occurs speaks
  // against every place, as anything else the source says does.
  for (const { failed, strange } of reads) {
    for (const dimension of ['polarity', 'modality']) if (failed.has(dimension)) elsewhere.add(dimension);
    if (strange) elsewhere.add('scope');
  }
  if (elsewhere.size) return inconsistent(new Set([...elsewhere, ...(own ?? reads[0]).failed]));
  if (own?.failed.size) return inconsistent(own.failed);
  const plain = own ?? reads.find(({ failed }) => !failed.size);
  if (!plain) return inconsistent(reads[0].failed);
  if (reads.every(({ failed }) => !failed.size)) return { outcome: 'consistent', occurrence: plain.occurrence, checks: checksOf(plain.failed) };
  const readings = [...new Set(reads.slice(0, READING_LIMIT).map(({ units }) => readingOf(source, units)))];
  return { outcome: 'ambiguous', readings, span: { start: plain.occurrence[0], end: plain.occurrence[1] } };
}

function classifyAgainst(claim, source) {
  const done = (fields) => ({ text: claim.text, sourceRef: claim.sourceRef, ...fields, verifierVersion: CLAIM_VERIFIER_VERSION });
  const unsupported = (failingDimension, checks) => done({ class: 'unsupported', failingDimension, ...(checks ? { checks } : {}) });
  const wanted = claimWordsOf(claim.text);
  if ([...wanted].some(isQuestionMark)) return unsupported('modality');
  if (!contentOf(wordsOf(wanted)).length) return unsupported('no_span');
  const rule = 'contraction-expansion-v1';
  const classified = (read, fields) => {
    if (read.outcome === 'ambiguous') return done({ class: 'ambiguous', readings: read.readings, span: read.span });
    if (read.outcome === 'inconsistent') return unsupported(read.failing, read.checks);
    const [start, end] = read.occurrence;
    return done({ ...fields, span: { start, end }, checks: read.checks });
  };
  const sourceText = source.text;
  const verbatim = () => occurrencesOf(new RegExp(literal(wanted), 'g'), source);
  const contracted = () => occurrencesOf(new RegExp(contractedPattern(expandContractions(wanted)), 'g'), source);
  if (claim.span !== undefined) {
    let { start, end } = claim.span ?? {};
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > sourceText.length || start >= end) return unsupported('no_span');
    while (start < end && /\s/.test(sourceText[start])) start += 1;
    while (end > start && /[\s.!;:,]/.test(sourceText[end - 1])) end -= 1;
    // A span holds the claim's words and nothing else: quote marks or brackets
    // inside its edges make it another text.
    const spanText = normaliseClaimText(sourceText.slice(start, end)).text;
    const onBoundary = start < end && !wordCharacter(sourceText[start - 1]) && !wordCharacter(sourceText[end]);
    const derived = spanText !== wanted && expandContractions(spanText) === expandContractions(wanted);
    if (!onBoundary || (spanText !== wanted && !derived)) return unsupported(diagnoseClaim(expandContractions(wanted), source));
    // Its other places are read too: a caller's span never hides them.
    const found = derived ? contracted() : verbatim();
    const all = found.some(([from, to]) => from === start && to === end) ? found : [...found, [start, end]];
    return classified(readOccurrences(source, all, [start, end]), derived ? { class: 'entailed', rule } : { class: 'quoted' });
  }
  const plain = verbatim();
  if (plain.length) return classified(readOccurrences(source, plain), { class: 'quoted' });
  const derived = contracted();
  if (derived.length) return classified(readOccurrences(source, derived), { class: 'entailed', rule });
  return unsupported(diagnoseClaim(expandContractions(wanted), source));
}

export function classifyClaim(claim, sourceText) {
  if (!claim || typeof claim.text !== 'string' || !claim.text.trim() || typeof claim.sourceRef !== 'string' || !claim.sourceRef) throw new Error('A claim needs non-empty text and a sourceRef');
  if (typeof sourceText !== 'string') throw new Error('A claim is classified against its source text');
  return classifyAgainst(claim, readSource(sourceText));
}

// Many claims, each checked against the source its sourceRef names: `sources`
// (an object or a Map) gives the text of each sourceRef, read once, and a claim
// whose source is not given, or that is not a claim at all, is unsupported. A
// claim repeated with the same source, span and words is checked once, and
// accepted claims that land on one place in one source count once (§14.6).
// Unsupported claims are returned apart, never among the accepted, and counted
// by failing dimension.
export function verifiedClaims(claims, sources) {
  if (!sources || typeof sources !== 'object') throw new Error('verifiedClaims needs the source text of each sourceRef');
  const sourceOf = (ref) => (sources instanceof Map ? sources.get(ref) : Object.hasOwn(sources, ref) ? sources[ref] : undefined);
  const read = new Map();
  const seen = new Set();
  const places = new Set();
  const accepted = [];
  const unsupported = [];
  const countsByDimension = {};
  const reject = (outcome) => {
    unsupported.push(outcome);
    countsByDimension[outcome.failingDimension] = (countsByDimension[outcome.failingDimension] ?? 0) + 1;
  };
  for (const claim of claims) {
    if (!claim || typeof claim.text !== 'string' || !claim.text.trim() || typeof claim.sourceRef !== 'string' || !claim.sourceRef) {
      reject({ text: typeof claim?.text === 'string' ? claim.text : null, sourceRef: typeof claim?.sourceRef === 'string' ? claim.sourceRef : null, class: 'unsupported', failingDimension: 'no_span', verifierVersion: CLAIM_VERIFIER_VERSION });
      continue;
    }
    const words = expandContractions(claimWordsOf(claim.text));
    const key = JSON.stringify([claim.sourceRef, claim.span === undefined ? 'none' : ['span', claim.span], words]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!read.has(claim.sourceRef)) read.set(claim.sourceRef, readSource(typeof sourceOf(claim.sourceRef) === 'string' ? sourceOf(claim.sourceRef) : ''));
    const outcome = classifyAgainst(claim, read.get(claim.sourceRef));
    if (outcome.class === 'unsupported') { reject(outcome); continue; }
    const place = JSON.stringify([outcome.sourceRef, outcome.span.start, outcome.span.end]);
    if (places.has(place)) continue;
    places.add(place);
    accepted.push(outcome);
  }
  return { accepted, unsupported, countsByDimension };
}

// Plan v1.4.4 §17, G-5 §3.1 (PR-25): the negating words of a text, read as the
// claim verifier reads words (NFKC, format characters ignored, apostrophes
// folded, contractions split), after combining marks are taken off, so an
// accented letter cannot hide a negator. The claim verifier's whole polarity
// lexicon counts, except in the text of an outcome itself (`outcome: true`: an
// attempt's result, a decision's outcome), where the words that state an
// outcome ("failed", "error", "pending") are what the outcome is. A word mixing
// ASCII letters with any other letter is counted, since it may stand for a
// negator ("nøt"); that can over-count ("straße", "50µs"), and over-counting
// only asks for the full record.
const OUTCOME_WORDS = new Set(['fail', 'fails', 'failed', 'failing', 'failure', 'failures', 'error', 'errors', 'unsuccessful', 'unsuccessfully', 'timed', 'crashed', 'aborted', 'cancelled', 'canceled', 'killed', 'broke', 'broken', 'pending', 'blocked', 'incomplete', 'removed', 'deprecated', 'obsolete']);
const NEGATORS = new Set(CLAIM_MARKERS.polarity);
const OUTCOME_NEGATORS = new Set(CLAIM_MARKERS.polarity.filter((word) => !OUTCOME_WORDS.has(word)));
const MIXED_LETTERS = (word) => /[a-z]/i.test(word) && /[^\u0000-\u007f]/u.test(word);
// Letters that read as a Latin letter, by code point, so a negator written
// wholly in lookalikes ("NO" in Greek capitals, small capitals, Armenian) is
// read as the word it looks like.
// ponytail: a hand-picked table, not Unicode's full confusables list; add a
// letter when one is found standing in for a negator.
const CONFUSABLE = new Map([[0x391, 'a'], [0x392, 'b'], [0x395, 'e'], [0x396, 'z'], [0x397, 'h'], [0x399, 'i'], [0x39a, 'k'], [0x39c, 'm'], [0x39d, 'n'], [0x39f, 'o'], [0x3a1, 'p'], [0x3a4, 't'], [0x3a5, 'y'], [0x3a7, 'x'], [0x3b1, 'a'], [0x3b9, 'i'], [0x3ba, 'k'], [0x3bd, 'v'], [0x3bf, 'o'], [0x3c1, 'p'], [0x3c4, 't'], [0x3c5, 'u'], [0x3c7, 'x'], [0x410, 'a'], [0x412, 'b'], [0x415, 'e'], [0x41a, 'k'], [0x41c, 'm'], [0x41d, 'h'], [0x41e, 'o'], [0x420, 'p'], [0x421, 'c'], [0x422, 't'], [0x423, 'y'], [0x425, 'x'], [0x430, 'a'], [0x435, 'e'], [0x43e, 'o'], [0x43f, 'n'], [0x440, 'p'], [0x441, 'c'], [0x443, 'y'], [0x445, 'x'], [0x455, 's'], [0x456, 'i'], [0x458, 'j'], [0x501, 'd'], [0x570, 'h'], [0x578, 'n'], [0x57d, 'u'], [0x585, 'o'], [0xf8, 'o'], [0x251, 'a'], [0x261, 'g'], [0x262, 'g'], [0x269, 'i'], [0x26a, 'i'], [0x274, 'n'], [0x280, 'r'], [0x28f, 'y'], [0x299, 'b'], [0x29c, 'h'], [0x29f, 'l'], [0x1d00, 'a'], [0x1d04, 'c'], [0x1d05, 'd'], [0x1d07, 'e'], [0x1d0a, 'j'], [0x1d0b, 'k'], [0x1d0d, 'm'], [0x1d0f, 'o'], [0x1d18, 'p'], [0x1d1b, 't'], [0x1d1c, 'u'], [0x1d20, 'v'], [0x1d21, 'w'], [0x1d22, 'z'], [0xa731, 's']].map(([code, letter]) => [String.fromCodePoint(code), letter]));
const skeleton = (word) => [...word].map((character) => CONFUSABLE.get(character) ?? character).join('');
export function negationsIn(text, { outcome = false } = {}) {
  if (typeof text !== 'string') return [];
  const negators = outcome ? OUTCOME_NEGATORS : NEGATORS;
  const folded = text.normalize('NFKD').replace(/\p{M}/gu, '');
  return wordsOf(folded)
    .filter(({ word, base, suffix, start, end }) => {
      // The skeleton is read from the letters as written: a capital lookalike
      // may stand for another letter than its lower case does.
      const looks = skeleton(folded.slice(start, end)).toLowerCase();
      return negators.has(base) || negators.has(word) || negators.has(looks) || NEGATED_AUXILIARY.test(looks) || suffix === "n't" || NEGATED_AUXILIARY.test(word) || MIXED_SCRIPT(word) || MIXED_LETTERS(word);
    })
    .map(({ start, end }) => folded.slice(start, end));
}
