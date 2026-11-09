import { validateRestorePayload } from '../src/restore-validation.js';

// Only for fixtures whose stored pre-policy identity is part of the test.
// Ordinary setup writes use generated IDs; this rewrites a detached snapshot,
// including journal/idempotency references, and validates it before import.
export function historicalIds(snapshot, names, options) {
  const replacements = new Map(Object.entries(names).map(([name, id]) => [id, name]));
  const rewrite = (value) => {
    if (typeof value === 'string') return replacements.get(value) ?? value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  const payload = rewrite(snapshot);
  validateRestorePayload(payload, options);
  return payload;
}
