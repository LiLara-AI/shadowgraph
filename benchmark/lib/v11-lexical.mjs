// v1.1 Boundary Error + Structural Lexical Classifier
//
// One classifier owns every "is this text safe to serialize into the common
// outer prompt" decision. It is deliberately structural rather than a list of
// per-example patterns: text is normalised and decoded first, then classified
// by shape (URL, filesystem path, credential, arm identity, authority), so a
// new punctuation or encoding variant of a known attack is caught by the same
// rule that catches the plain form.
//
// Every rejection is a V11BoundaryError carrying a stable code and a static
// message. The rejected material is never placed on the error surface: not in
// the message, not in a cause, not in an enumerable property. Callers that
// need to know *why* get the code; nobody gets the payload back.

/** Stable boundary rejection codes. */
export const V11_BOUNDARY_CODES = Object.freeze([
  'SHAPE',
  'KEY',
  'ARM',
  'CREDENTIAL',
  'LOCAL_REFERENCE',
  'AUTHORITY',
  'TEXT',
  'LIMIT'
]);

const BOUNDARY_CODE_SET = new Set(V11_BOUNDARY_CODES);

/**
 * Static, non-disclosing message per code. The message must never be derived
 * from the rejected value, or the error surface leaks what the boundary was
 * built to contain.
 */
const STATIC_MESSAGES = new Map([
  ['SHAPE', 'v1.1 boundary rejected a value whose object or array shape is not permitted'],
  ['KEY', 'v1.1 boundary rejected a forbidden data key'],
  ['ARM', 'v1.1 boundary rejected arm-specific material'],
  ['CREDENTIAL', 'v1.1 boundary rejected credential-like material'],
  ['LOCAL_REFERENCE', 'v1.1 boundary rejected a local filesystem reference'],
  ['AUTHORITY', 'v1.1 boundary rejected outer-authority material'],
  ['TEXT', 'v1.1 boundary rejected unsafe serialized text'],
  ['LIMIT', 'v1.1 boundary rejected a value exceeding a declared size or depth limit']
]);

/**
 * A boundary rejection.
 *
 * `code` is the only channel of information: it is the sole enumerable own
 * property, so JSON.stringify of the error yields nothing about the input. No
 * cause is attached. `name` is defined non-enumerably because a plain
 * assignment would make it enumerable and quietly widen that surface.
 */
export class V11BoundaryError extends Error {
  constructor(code) {
    if (!BOUNDARY_CODE_SET.has(code)) {
      throw new Error(`Unknown v1.1 boundary code: ${code}`);
    }
    super(STATIC_MESSAGES.get(code));
    Object.defineProperty(this, 'name', {
      value: 'V11BoundaryError',
      enumerable: false,
      writable: false,
      configurable: false
    });
    Object.defineProperty(this, 'code', {
      value: code,
      enumerable: true,
      writable: false,
      configurable: false
    });
  }
}

/** Throw a boundary rejection carrying only a stable code. */
export function boundaryReject(code) {
  throw new V11BoundaryError(code);
}

let sealedFaultSink = null;

/**
 * Observe throws that the seal converted, without widening the error surface.
 *
 * A converted throw is either hostile input or a harness fault, and at the
 * boundary those are indistinguishable: any property of the thrown value that
 * could tell them apart is itself attacker-controlled. Security therefore wins
 * and everything becomes a coded rejection - but a benchmark must not silently
 * record a harness fault as an input rejection, so the original is offered to a
 * sink the operator installs. The sink is diagnostic only: nothing it receives
 * may reach a unit result or an error surface.
 */
export function setSealedFaultSink(sink) {
  if (sink !== null && typeof sink !== 'function') {
    throw new Error('sealed fault sink must be a function or null');
  }
  const previous = sealedFaultSink;
  sealedFaultSink = sink;
  return previous;
}

/**
 * Run untrusted-input handling so that nothing but a boundary rejection escapes.
 *
 * Reflection on a hostile value can throw on its own account: a Proxy trap
 * raises whatever it likes, with a message and stack the attacker controls.
 * Converting any such throw into a coded rejection is what makes the guarantee
 * hold for every input rather than only for the ones that happen to be
 * reachable today.
 *
 * Seal at the public entry point, not around one internal call. A seal placed
 * around part of a function leaves the rest of that function reading the same
 * untrusted value unprotected.
 */
export function sealBoundary(operation, fallbackCode = 'SHAPE') {
  try {
    return operation();
  } catch (error) {
    if (error instanceof V11BoundaryError) throw error;
    if (sealedFaultSink !== null) {
      // Never let a faulty sink become a second escape route.
      try {
        sealedFaultSink(error);
      } catch {
        // ignored on purpose
      }
    }
    throw new V11BoundaryError(fallbackCode);
  }
}

// ---------------------------------------------------------------------------
// Inert traversal
// ---------------------------------------------------------------------------

/**
 * Reject symbol keys, accessor properties and hidden keys.
 *
 * Properties are inspected through their descriptors, so a getter is rejected
 * without ever being invoked.
 */
export function assertOwnDataProperties(value) {
  if (sealBoundary(() => Object.getOwnPropertySymbols(value)).length > 0) boundaryReject('SHAPE');
  for (const field of sealBoundary(() => Object.getOwnPropertyNames(value))) {
    const descriptor = sealBoundary(() => Object.getOwnPropertyDescriptor(value, field));
    if (descriptor === undefined) boundaryReject('SHAPE');
    if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
      boundaryReject('SHAPE');
    }
    if (!descriptor.enumerable) boundaryReject('SHAPE');
  }
}

/** Reject sparse arrays and arrays carrying non-index properties. */
export function assertDenseArray(value) {
  if (sealBoundary(() => Object.getOwnPropertySymbols(value)).length > 0) boundaryReject('SHAPE');
  for (const field of sealBoundary(() => Object.getOwnPropertyNames(value))) {
    if (field === 'length') continue;
    const index = Number(field);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) boundaryReject('SHAPE');
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      boundaryReject('SHAPE');
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) boundaryReject('SHAPE');
  }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

// C0/C1 controls except tab, line feed and carriage return, which are ordinary
// text in a scenario body.
const DISALLOWED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
// Bidi overrides, zero-width joiners/spaces, invisible separators and BOM.
const INVISIBLE_OR_BIDI = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const LONE_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// A percent sign that itself encodes a percent sign: the value was encoded
// twice, so a single decode by any downstream consumer reveals different text.
const DOUBLE_PERCENT_ENCODING = /%25[0-9A-Fa-f]{2}/;

function hasStructurallyUnsafeText(value) {
  return DISALLOWED_CONTROL.test(value)
    || INVISIBLE_OR_BIDI.test(value)
    || LONE_HIGH_SURROGATE.test(value)
    || LONE_LOW_SURROGATE.test(value)
    || DOUBLE_PERCENT_ENCODING.test(value);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Fold punctuation to single spaces so prose patterns survive obfuscation. */
function normalizedProse(value) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

/** Fold an identifier to letters and digits only. */
export function normalizedPublicDataKey(value) {
  return value.normalize('NFKC').replace(/[^A-Za-z0-9]/gu, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// URL shape
// ---------------------------------------------------------------------------

const HAS_SCHEME_AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

function urlShape(value) {
  const trimmed = value.trim();
  if (!HAS_SCHEME_AUTHORITY.test(trimmed)) return { kind: 'none' };
  try {
    return { kind: 'url', url: new URL(trimmed) };
  } catch {
    return { kind: 'malformed' };
  }
}

// ---------------------------------------------------------------------------
// Credential shape
// ---------------------------------------------------------------------------

const CREDENTIAL_TOKENS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{8,}/u,
  /\bghp_[A-Za-z0-9]{20,}/u,
  /\bgho_[A-Za-z0-9]{20,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bglpat-[A-Za-z0-9_-]{16,}/u,
  /\bhf_[A-Za-z0-9]{16,}/u,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{4,}/u
]);

const CREDENTIAL_LABEL = String.raw`api[_ -]?key|access[_ -]?token|auth(?:oriz(?:ation|ed))?[_ -]?(?:token|key)?|client[_ -]?secret|credentials?|password|passphrase|secret|token`;
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`\b(?:${CREDENTIAL_LABEL})\s*[:=]\s*(?:["'][^"']{4,}["']|\S{4,})`,
  'iu'
);

function hasCredentialShape(candidate) {
  if (CREDENTIAL_ASSIGNMENT.test(candidate)) return true;
  return CREDENTIAL_TOKENS.some((pattern) => pattern.test(candidate));
}

// ---------------------------------------------------------------------------
// Local filesystem reference shape
// ---------------------------------------------------------------------------

const PRIVATE_ROOTS = String.raw`home|users|tmp|root|etc|opt|srv|workspace|var/tmp|private/tmp|mnt/[a-z]|media/[a-z]`;
const WINDOWS_DRIVE = /^[A-Za-z]:\//u;
const UNC_PATH = /^\/\/+[^/\s]+\/[^/\s]+/u;
const PRIVATE_POSIX_ROOT = new RegExp(String.raw`^/(?:${PRIVATE_ROOTS})(?:/|$)`, 'iu');

/** Split free text into path-bearing candidates without losing rooted forms. */
function pathCandidates(value) {
  const unified = value.replace(/\\/gu, '/');
  const pieces = [unified];
  for (const piece of unified.split(/[\s,;'"()[\]{}<>]+/u)) {
    if (piece.length === 0) continue;
    pieces.push(piece);
    // `Path:/home/...` and `file:C:/...` carry the path after a label.
    const separator = piece.indexOf(':');
    if (separator > 0 && separator < piece.length - 1) {
      pieces.push(piece.slice(separator + 1));
    }
  }
  return pieces;
}

function isLocalPath(candidate) {
  if (WINDOWS_DRIVE.test(candidate)) return true;
  if (UNC_PATH.test(candidate)) return true;
  // Collapse a repeated leading separator so a multiply-rooted path reads as
  // its single-rooted equivalent.
  const collapsed = candidate.replace(/^\/+/u, '/');
  return PRIVATE_POSIX_ROOT.test(collapsed);
}

function hasLocalReferenceShape(value) {
  if (/^file:/iu.test(value.trim())) return true;
  return pathCandidates(value).some(isLocalPath);
}

// ---------------------------------------------------------------------------
// Outer-authority shape
// ---------------------------------------------------------------------------

// Matched against normalised prose, so punctuation, casing and line breaks in
// the raw value cannot defeat them.
const AUTHORITY_SHAPES = Object.freeze([
  // Instruction override: a displacing verb aimed at a governing noun.
  /\b(?:ignore|disregard|forget|override|bypass|supersede|supercede|replace|discard|skip)\b(?:\s+\w+){0,4}?\s+\b(?:instruction|instructions|rule|rules|policy|policies|prompt|prompts|message|messages|guardrail|guardrails|direction|directions)\b/u,
  // Role reassignment.
  /\byou are now\b/u,
  /\b(?:act|behave|respond|operate)\s+as\b(?:\s+\w+){0,3}?\s*\b(?:system|developer|administrator|admin|root|assistant|operator)\b/u,
  // Naming the privileged channel itself.
  /\b(?:system|developer|operator)\s+(?:prompt|message|policy|instruction|instructions)\b/u,
  // Elevation claims.
  /\b(?:new|updated|revised)\s+(?:system|developer)\s+(?:prompt|message|policy|instructions?)\b/u
]);

function hasAuthorityShape(prose) {
  return AUTHORITY_SHAPES.some((pattern) => pattern.test(prose));
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Build a classifier bound to an arm vocabulary.
 *
 * `classify(value)` returns a boundary code, or null when the text is safe.
 * Ordering is significant and encodes precedence: structural text defects are
 * decided before any decoding-dependent interpretation, so a double-encoded
 * private path is reported as unsafe text rather than silently decoded and
 * reported as a path.
 */
export function createV11LexicalClassifier(armTerms) {
  if (!Array.isArray(armTerms) || armTerms.length === 0) {
    throw new Error('arm vocabulary must be a non-empty array');
  }
  const armPattern = new RegExp(
    `(?:^|[^A-Za-z0-9._:-])(?:${armTerms.map(escapePattern).join('|')})(?=$|[^A-Za-z0-9._:-])`,
    'iu'
  );

  function classify(value) {
    if (typeof value !== 'string' || value.length === 0) return null;

    // 1. Structural text defects, before any decoding.
    if (hasStructurallyUnsafeText(value)) return 'TEXT';

    const shape = urlShape(value);
    if (shape.kind === 'malformed') return 'TEXT';

    // Decoded views participate in credential and path detection, so a single
    // layer of percent-encoding cannot smuggle either past the boundary.
    const decoded = safeDecode(value);
    const views = decoded === null || decoded === value ? [value] : [value, decoded];

    // 2. Credentials.
    if (shape.kind === 'url' && (shape.url.username !== '' || shape.url.password !== '')) {
      return 'CREDENTIAL';
    }
    if (views.some(hasCredentialShape)) return 'CREDENTIAL';

    // 3. Local filesystem references.
    //
    // A well-formed URL is not free text: its authority and path legitimately
    // contain a doubled separator and privately-named segments, so only the
    // decoded query and
    // fragment - the parts that carry caller-supplied values - are searched
    // for a local path. Everything else is treated as free text.
    if (shape.kind === 'url') {
      if (shape.url.protocol.toLowerCase() === 'file:') return 'LOCAL_REFERENCE';
      const embedded = [...shape.url.searchParams.values()];
      if (shape.url.hash.length > 1) {
        const fragment = safeDecode(shape.url.hash.slice(1));
        if (fragment !== null) embedded.push(fragment);
      }
      if (embedded.some((entry) => pathCandidates(entry).some(isLocalPath))) {
        return 'LOCAL_REFERENCE';
      }
    } else if (views.some(hasLocalReferenceShape)) {
      return 'LOCAL_REFERENCE';
    }

    // 4. Arm identity.
    if (views.some((view) => armPattern.test(view))) return 'ARM';

    // 5. Outer authority, over normalised prose.
    if (views.some((view) => hasAuthorityShape(normalizedProse(view)))) return 'AUTHORITY';

    return null;
  }

  return Object.freeze({ classify });
}
