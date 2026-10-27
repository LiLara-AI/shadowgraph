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
export const CODEX_PROMPT_VERSION = 'capture-quoted-fields-corrections-v2';
export const CODEX_OUTPUT_SCHEMA_VERSION = 'capture-quoted-corrections-v2';
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
// Claude Code moves on weekly; a list of traced versions cannot keep up, and a
// version string trusted nothing by itself anyway. A 2.x host newer than the
// first profile is taken on the runtime-evidence profile instead: every
// invocation streams the host's own account of the session it started (its
// init event: tools, MCP servers, slash commands, skills, plugins, model,
// version and key source; any hook it ran; every tool call) and its output is
// used only when that account shows the confined session the flags asked for
// (extractor.js). It runs only with no managed policy present at all and with
// a model the owner selected explicitly at activation.
export const RUNTIME_EVIDENCE_PROFILE = Object.freeze({ id: 'claude-code-runtime-evidence-v1', minimumVersion: '2.1.288', belowMajor: 3,
  binarySha256: null, requiresHostValidation: false, runtimeEvidence: true });
// The current models an owner may select for that profile, least costly first.
// The pinned profiles keep the model they were traced with.
export const CURRENT_EXTRACTION_MODELS = Object.freeze(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
export const EXTRACTION_MODELS = Object.freeze([EXTRACTION_MODEL, ...CURRENT_EXTRACTION_MODELS]);
const version = (value) => (/^(\d+)\.(\d+)\.(\d+)$/u.exec(value ?? '') ?? []).slice(1).map(Number);
// The profile a host version runs under, or null. Only the build's own profile
// list falls back to the runtime-evidence profile; a list a caller supplies is
// taken as it is.
export function hostProfileFor(hostVersion, profiles = HOST_PROFILES) {
  if (typeof hostVersion !== 'string') return null;
  if (Object.hasOwn(profiles, hostVersion)) return profiles[hostVersion];
  if (profiles !== HOST_PROFILES) return null;
  const [major, minor, patch] = version(hostVersion), floor = version(RUNTIME_EVIDENCE_PROFILE.minimumVersion);
  if (major === undefined || major >= RUNTIME_EVIDENCE_PROFILE.belowMajor) return null;
  const above = major !== floor[0] ? major > floor[0] : minor !== floor[1] ? minor > floor[1] : patch >= floor[2];
  return above ? RUNTIME_EVIDENCE_PROFILE : null;
}
export const modelSelectable = (profile, model) => (profile?.runtimeEvidence ? CURRENT_EXTRACTION_MODELS.includes(model) : model === EXTRACTION_MODEL);
// The quoted-fields recipe with corrections, which the Codex route introduced,
// is what a runtime-evidence activation runs on Claude as well.
export const QUOTED_RECIPE = 'capture-quoted-corrections-v2';
export const HOST_VALIDATION_KIND = 'shadowgraph-extraction-host-validation';
export const HOST_VALIDATION_CHECKS = Object.freeze(['confinement', 'routing', 'recursion', 'shutdown']);
export const PROMPT_VERSION = 'capture-fields-v1';
export const OUTPUT_SCHEMA_VERSION = 'capture-fields-v1';
export const EXTRACTION_RECIPE = Object.freeze({
  promptVersion: PROMPT_VERSION, schemaVersion: OUTPUT_SCHEMA_VERSION, model: EXTRACTION_MODEL
});
