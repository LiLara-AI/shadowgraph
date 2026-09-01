// Evidence index and review bundle for the v1.1 candidate.
//
// A review verdict is only worth something if it is bound to exact bytes. This
// module produces that binding: an index naming every artifact with its digest,
// and a bundle that ties the index to the commit and the locks it was produced
// under. Two builds from the same inputs must be byte-identical, so a reviewer
// can rebuild the bundle and compare digests rather than trusting a report.
//
// Nothing here reads a file or computes a digest from disk. Digests are supplied
// by the caller that actually hashed the bytes, and every one of them is checked
// for shape. That is deliberate: a builder that hashed files itself could be
// pointed at a different tree than the one under review, and a builder that
// accepted an absent digest would let a bundle claim coverage it does not have.

import { createHash } from 'node:crypto';

import { canonicalJson } from './v11-contract.mjs';

export class EvidenceBundleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvidenceBundleError';
    this.code = code;
  }
}

const BARE_SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^[a-f0-9]{40}$/u;

/** What an indexed artifact is evidence of. Anything else is refused. */
export const EVIDENCE_KINDS = Object.freeze([
  'frozen-methodology',
  'acceptance-definition',
  'implementation-lock',
  'environment-lock',
  'service-manifest',
  'model-weights-lock',
  'runtime-bytes-lock',
  'raw-run',
  'aggregate',
  'progress-ledger',
  'unit-evidence-ledger',
  'provider-ledger',
  'readiness-report',
  'documentation'
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reject(code, message) {
  throw new EvidenceBundleError(code, message);
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !BARE_SHA256.test(value)) {
    reject('INVALID_DIGEST', `${label} must be a lowercase hex sha256 digest`);
  }
}

/**
 * Build the evidence index.
 *
 * Entries are sorted by path so the index is a function of its contents and not
 * of the order the caller happened to collect them in. A duplicate path is
 * refused rather than deduplicated: two different digests for one path means
 * the caller is describing two different trees, and silently keeping one of
 * them would produce an index that matches neither.
 */
export function buildEvidenceIndex(input) {
  if (!isPlainObject(input) || !Array.isArray(input.entries)) {
    reject('CONTRACT_FAILURE', 'evidence index requires an entries array');
  }
  if (input.entries.length === 0) {
    reject('EMPTY_INDEX', 'an evidence index with no entries would attest to nothing');
  }

  const byPath = new Map();
  for (const entry of input.entries) {
    if (!isPlainObject(entry)) reject('CONTRACT_FAILURE', 'each evidence entry must be an object');
    const { path: entryPath, sha256, bytes, kind } = entry;
    if (typeof entryPath !== 'string' || entryPath.length === 0) {
      reject('CONTRACT_FAILURE', 'each evidence entry needs a path');
    }
    if (entryPath.startsWith('/') || entryPath.includes('\\') || entryPath.split('/').includes('..')) {
      reject('UNSAFE_PATH', `evidence path must be repository-relative and contain no traversal: ${entryPath}`);
    }
    assertDigest(sha256, `evidence digest for ${entryPath}`);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      reject('CONTRACT_FAILURE', `evidence size for ${entryPath} must be a non-negative integer`);
    }
    if (!EVIDENCE_KINDS.includes(kind)) {
      reject('UNKNOWN_KIND', `evidence kind is not one this bundle recognises: ${kind}`);
    }
    const existing = byPath.get(entryPath);
    if (existing !== undefined) {
      reject('DUPLICATE_PATH', `evidence index lists ${entryPath} more than once`);
    }
    byPath.set(entryPath, { path: entryPath, kind, sha256, bytes });
  }

  const entries = [...byPath.values()].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  return {
    schema: 'shadowgraph.v11.evidence-index',
    version: 1,
    entryCount: entries.length,
    entries
  };
}

/** The digest of an index, over its canonical bytes. */
export function evidenceIndexDigest(index) {
  return createHash('sha256')
    .update('shadowgraph:v1.1:evidence-index:v1', 'utf8')
    .update('\0', 'utf8')
    .update(canonicalJson(index), 'utf8')
    .digest('hex');
}

/**
 * Build the review bundle.
 *
 * The bundle binds one commit, one implementation lock, one environment lock
 * and one evidence index together, and its digest covers all of them. A review
 * verdict quoting this digest is a verdict about exactly those bytes; if any of
 * them changes, the digest changes and the verdict no longer applies.
 *
 * `coverage` names the evidence kinds a reviewer must be able to see. A bundle
 * missing one of them is refused rather than shipped with a gap, because an
 * absent artifact is indistinguishable from one nobody produced.
 */
export function buildReviewBundle(input) {
  if (!isPlainObject(input)) reject('CONTRACT_FAILURE', 'review bundle requires an object');
  const {
    commit,
    implementationLockHash,
    environmentLockHash,
    sourceHashes,
    index,
    scored,
    requiredCoverage = []
  } = input;

  if (typeof commit !== 'string' || !GIT_OBJECT.test(commit)) {
    reject('INVALID_COMMIT', 'review bundle must name a full commit object id');
  }
  assertDigest(implementationLockHash, 'implementation lock hash');
  assertDigest(environmentLockHash, 'environment lock hash');
  if (!isPlainObject(sourceHashes)) {
    reject('CONTRACT_FAILURE', 'review bundle requires the frozen source hashes');
  }
  for (const field of ['preregistrationSha256', 'amendment001Sha256', 'amendment002Sha256']) {
    assertDigest(sourceHashes[field], `frozen source hash ${field}`);
  }
  if (scored !== false) {
    // The bundle records the mode it was built for. A scored bundle is not
    // something this candidate may produce, so the field is not merely copied.
    reject('SCORED_BUNDLE', 'this candidate may only bundle a non-scored run');
  }
  if (!isPlainObject(index) || index.schema !== 'shadowgraph.v11.evidence-index') {
    reject('CONTRACT_FAILURE', 'review bundle requires an evidence index');
  }

  // Rebuild the index from its own entries rather than trusting the object
  // handed in. Checking only the schema tag left every protection in
  // buildEvidenceIndex bypassable by anyone who constructed the index by hand:
  // a traversing path, a malformed digest, a duplicate path with two different
  // digests, an unknown kind, or a lying entryCount all passed straight
  // through, and requiredCoverage was then satisfied against those unvalidated
  // kinds. Rebuilding also makes the byte-identity guarantee unconditional,
  // since the entries are re-sorted here rather than assumed sorted.
  const validated = buildEvidenceIndex({ entries: index.entries });
  if (index.entryCount !== validated.entryCount) {
    reject('CONTRACT_FAILURE', 'evidence index entryCount does not match its entries');
  }

  const present = new Set(validated.entries.map((entry) => entry.kind));
  const missing = [...requiredCoverage].filter((kind) => !present.has(kind)).sort();
  if (missing.length > 0) {
    reject('INCOMPLETE_COVERAGE', `review bundle is missing required evidence: ${missing.join(', ')}`);
  }

  const bundle = {
    schema: 'shadowgraph.v11.review-bundle',
    version: 1,
    scored: false,
    commit,
    implementationLockHash,
    environmentLockHash,
    sourceHashes: {
      preregistrationSha256: sourceHashes.preregistrationSha256,
      amendment001Sha256: sourceHashes.amendment001Sha256,
      amendment002Sha256: sourceHashes.amendment002Sha256
    },
    evidenceIndexDigest: evidenceIndexDigest(validated),
    index: validated
  };
  return { bundle, bytes: `${canonicalJson(bundle)}\n`, digest: bundleDigest(bundle) };
}

/** The digest a review verdict is bound to. */
export function bundleDigest(bundle) {
  return createHash('sha256')
    .update('shadowgraph:v1.1:review-bundle:v1', 'utf8')
    .update('\0', 'utf8')
    .update(canonicalJson(bundle), 'utf8')
    .digest('hex');
}

/**
 * Check a bundle against the artifacts a reviewer actually has.
 *
 * `observed` maps repository-relative paths to the digests the reviewer
 * computed. Every discrepancy is reported rather than the first one: a reviewer
 * needs to see the whole disagreement, not be sent round the loop once per file.
 */
export function verifyReviewBundle(input) {
  if (!isPlainObject(input) || !isPlainObject(input.bundle) || !isPlainObject(input.observed)) {
    reject('CONTRACT_FAILURE', 'bundle verification requires a bundle and observed digests');
  }
  // Required, not optional. This module exists to bind a verdict to exact
  // bytes, and a function called verifyReviewBundle that answers verified:true
  // for a bundle whose commit was swapped is the precise failure it was written
  // to prevent. Independent review flagged it; the caller always knows which
  // digest it means to check against, so there is no cost to demanding it.
  assertDigest(input.expectedDigest, 'expected bundle digest');
  const { bundle, observed } = input;
  const findings = [];

  if (bundleDigest(bundle) !== input.expectedDigest) {
    findings.push({ code: 'BUNDLE_DIGEST_MISMATCH' });
  }
  if (evidenceIndexDigest(bundle.index) !== bundle.evidenceIndexDigest) {
    findings.push({ code: 'INDEX_DIGEST_MISMATCH' });
  }

  for (const entry of bundle.index.entries) {
    const actual = observed[entry.path];
    if (actual === undefined) {
      findings.push({ code: 'MISSING_ARTIFACT', path: entry.path });
      continue;
    }
    if (actual !== entry.sha256) {
      findings.push({ code: 'ARTIFACT_DIGEST_MISMATCH', path: entry.path });
    }
  }
  for (const observedPath of Object.keys(observed)) {
    if (!bundle.index.entries.some((entry) => entry.path === observedPath)) {
      findings.push({ code: 'UNINDEXED_ARTIFACT', path: observedPath });
    }
  }

  findings.sort((left, right) => {
    const key = (finding) => `${finding.code} ${finding.path ?? ''}`;
    return key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
  });
  return { verified: findings.length === 0, findings };
}
