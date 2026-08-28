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
