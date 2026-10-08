// Read-only recipe identity. Importing it never loads or invokes an executor.
export const EXTRACTION_MODEL = 'claude-opus-5[1m]';
// The Claude Code hosts extraction runs on. A version string alone trusts no
// host: 2.1.288 is the AG-3 profile, kept as it was validated; 2.1.292 names the
// one binary it was prepared against, and an extraction activation on it also
// needs that binary's passing real-host validation receipt (activation.js).
export const HOST_PROFILES = Object.freeze({
  '2.1.288': Object.freeze({ binarySha256: null, requiresHostValidation: false }),
  '2.1.292': Object.freeze({ binarySha256: 'eb95bb65955f8b1702e800815f9a2c0388a5de0f196c354c7ee1dd5cb9a2ba23', requiresHostValidation: true })
});
export const HOST_VALIDATION_KIND = 'shadowgraph-extraction-host-validation';
export const HOST_VALIDATION_CHECKS = Object.freeze(['confinement', 'routing', 'recursion', 'shutdown']);
export const PROMPT_VERSION = 'capture-fields-v1';
export const OUTPUT_SCHEMA_VERSION = 'capture-fields-v1';
export const EXTRACTION_RECIPE = Object.freeze({
  promptVersion: PROMPT_VERSION, schemaVersion: OUTPUT_SCHEMA_VERSION, model: EXTRACTION_MODEL
});
