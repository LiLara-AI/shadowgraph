// Metadata only. No account lookup, executor import, credentials or model calls.
const PROFILE_SELECTORS = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN']);
export const sessionProfileSelected = env => Object.entries(env).some(([name, value]) => PROFILE_SELECTORS.has(name.toUpperCase()) && typeof value === 'string' && value !== '');
export function validExtractionBinding(value) {
  return value && ['claude', 'codex'].includes(value.provider)
    && /^[0-9a-f]{64}$/u.test(value.accountFingerprint ?? '')
    && typeof value.setupId === 'string' && /^[0-9a-f-]{36}$/u.test(value.setupId);
}
export function sameExtractionBinding(left, right) {
  return Boolean(validExtractionBinding(left) && validExtractionBinding(right)
    && ['provider', 'accountFingerprint', 'setupId'].every(key => left[key] === right[key]));
}
// The gap capture status declares for items the current setup never extracts.
export const PRIOR_SETUP = 'prior_setup';
export const extractionBinding = activation => ({ provider: activation.executor.provider ?? 'claude',
  accountFingerprint: activation.executor.accountFingerprint, setupId: activation.activationId });
