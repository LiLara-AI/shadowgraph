// Read-only recipe identity. Importing it never loads or invokes an executor.
export const EXTRACTION_MODEL = 'claude-opus-5[1m]';
export const PROMPT_VERSION = 'capture-fields-v1';
export const OUTPUT_SCHEMA_VERSION = 'capture-fields-v1';
export const EXTRACTION_RECIPE = Object.freeze({
  promptVersion: PROMPT_VERSION, schemaVersion: OUTPUT_SCHEMA_VERSION, model: EXTRACTION_MODEL
});
