// Metadata only. No account lookup, executor import, credentials or model calls.
export function validExtractionBinding(value) {
  return value && ['claude', 'codex'].includes(value.provider)
    && /^[0-9a-f]{64}$/u.test(value.accountFingerprint ?? '')
    && typeof value.setupId === 'string' && /^[0-9a-f-]{36}$/u.test(value.setupId);
}
export function sameExtractionBinding(left, right) {
  return Boolean(validExtractionBinding(left) && validExtractionBinding(right)
    && ['provider', 'accountFingerprint', 'setupId'].every(key => left[key] === right[key]));
}
export const extractionBinding = activation => ({ provider: activation.executor.provider ?? 'claude',
  accountFingerprint: activation.executor.accountFingerprint, setupId: activation.activationId });
