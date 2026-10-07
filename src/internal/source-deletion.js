// Durable removal cannot assign a mixed causal reading to one of its sources.
// Refuse before mutation; reversible read withholding uses a separate overlay.
import { withoutSourceCopies } from './source-availability.js';
export function assertSourceRemovalSafe(value, sources, removed, supportedVersion) {
  if (!value || typeof value !== 'object' || !sources.size) return;
  if (Array.isArray(value)) {
    for (const item of value) assertSourceRemovalSafe(item, sources, removed, supportedVersion);
    return;
  }
  const entity = typeof value.id === 'string' && (value.kind === undefined
    ? Object.hasOwn(value, 'key') && Object.hasOwn(value, 'value')
    : ['decision', 'attempt', 'memory', 'fact'].includes(value.kind));
  if (entity) {
    if (removed.has(value.id)) return;
    if (value.schemaVersion > supportedVersion && withoutSourceCopies(value, sources) !== value) {
      throw new Error('Refusing source removal inside a newer entity schema');
    }
    const cause = value.causalClaim;
    if (Array.isArray(cause?.readings) && cause.readings.length && Array.isArray(cause.evidence)
      && cause.evidence.some(item => sources.has(item?.sourceRef))
      && cause.evidence.some(item => !sources.has(item?.sourceRef))) {
      throw new Error('Refusing partial removal of mixed-source unassigned causal readings');
    }
    return;
  }
  if (value.kind !== undefined || value.type === 'legacy_metadata_event') return;
  const store = Array.isArray(value.records) && (value.schemaVersion !== undefined || Array.isArray(value.facts));
  for (const key of store ? ['records', 'facts', 'journal', 'idempotency'] : Object.keys(value)) {
    if (key !== 'metadata') assertSourceRemovalSafe(value[key], sources, removed, supportedVersion);
  }
}
