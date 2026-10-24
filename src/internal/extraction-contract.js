// Read-only recipe identity. Importing it never loads or invokes an executor.
import { createHmac } from 'node:crypto';
// The bound account's e-mail as activation keeps it: a digest under the
// activation's key, so a hook can compare a session's own account without
// either side keeping the address.
export const accountEmailDigest = (salt, email) => typeof email === 'string' && email.trim()
  ? createHmac('sha256', salt).update(`email\0${email.trim().toLowerCase()}`).digest('hex') : null;
export const EXTRACTION_MODEL = 'claude-opus-5[1m]';
export const CODEX_EXTRACTION_MODEL = 'gpt-6.1-sol';
export const CODEX_CONFIGURATION = 'codex-subscription-text-only-v1';
export function extractionModel(provider = 'claude') {
  if (provider === 'claude') return EXTRACTION_MODEL;
  if (provider === 'codex') return CODEX_EXTRACTION_MODEL;
  throw new Error('unsupported_extraction_provider');
}
// The Claude Code hosts extraction runs on. A version string alone trusts no
// host: 2.1.288 is the AG-3 profile, kept as it was validated; 2.1.292 names the
// one binary it was prepared against, and an extraction activation on it also
// needs that binary's passing real-host validation receipt (activation.js).
// remoteCacheGatedByEligibility: this pinned binary was traced (record 26) not to
// fetch or apply ~/.claude/remote-settings.json when its own doctor reports the
// account ineligible, so that cache alone defers to that report (record 27).
export const HOST_PROFILES = Object.freeze({
  '2.1.288': Object.freeze({ binarySha256: null, requiresHostValidation: false }),
  '2.1.292': Object.freeze({ binarySha256: 'eb95bb65955f8b1702e800815f9a2c0388a5de0f196c354c7ee1dd5cb9a2ba23', requiresHostValidation: true, remoteCacheGatedByEligibility: true })
});
export const HOST_VALIDATION_KIND = 'shadowgraph-extraction-host-validation';
export const HOST_VALIDATION_CHECKS = Object.freeze(['confinement', 'routing', 'recursion', 'shutdown']);
export const PROMPT_VERSION = 'capture-fields-v1';
export const OUTPUT_SCHEMA_VERSION = 'capture-fields-v1';
export const EXTRACTION_RECIPE = Object.freeze({
  promptVersion: PROMPT_VERSION, schemaVersion: OUTPUT_SCHEMA_VERSION, model: EXTRACTION_MODEL
});
