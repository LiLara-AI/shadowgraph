// Only typed entity fields are interpreted. Literal values, metadata, unknown
// entities and unknown store collections are preserved, even if they look alike.
const ENTITY_KINDS = new Set(['decision', 'attempt', 'memory', 'fact']);
const isEntity = value => typeof value.id === 'string' && (value.kind === undefined
  ? Object.hasOwn(value, 'key') && Object.hasOwn(value, 'value')
  : ENTITY_KINDS.has(value.kind));
const mapChanged = (items, transform) => {
  const result = items.map(transform);
  return result.some((item, i) => item !== items[i]) ? result : items;
};
function entityWithoutCopies(value, ids) {
  let copy;
  const put = (key, item) => { if (item !== value[key]) (copy ??= { ...value })[key] = item; };
  if (ids.has(value.captureRef)) put('sourceAvailability', 'unavailable');
  const claim = (item, evidence = false) => {
    if (!item || !ids.has(item.sourceRef)) return item;
    const next = { ...item, sourceAvailability: 'unavailable' };
    delete next.evidence; delete next.readings;
    if (evidence) delete next.text;
    return next;
  };
  if (Array.isArray(value.claims)) put('claims', mapChanged(value.claims, item => claim(item)));
  const cause = value.causalClaim;
  if (cause && Array.isArray(cause.evidence)) {
    const evidence = mapChanged(cause.evidence, item => claim(item, true));
    if (evidence !== cause.evidence) {
      const next = { ...cause, evidence, sourceAvailability: 'unavailable' };
      // A mixed-source read withholds unassigned copied readings reversibly;
      // unaffected evidence nodes remain. captureRef alone does not bind cause.
      delete next.readings;
      put('causalClaim', next);
    }
  }
  return copy ?? value;
}
export function withoutSourceCopies(value, ids) {
  if (!value || typeof value !== 'object' || !ids?.size) return value;
  if (Array.isArray(value)) return mapChanged(value, item => withoutSourceCopies(item, ids));
  if (isEntity(value)) return entityWithoutCopies(value, ids);
  if (value.kind !== undefined) return value; // capture and unknown kinds
  if (value.type === 'legacy_metadata_event') return value;
  const store = Array.isArray(value.records) && (value.schemaVersion !== undefined || Array.isArray(value.facts));
  const keys = store ? ['records', 'facts', 'journal', 'idempotency'] : Object.keys(value);
  let copy;
  for (const key of keys) {
    if (key === 'metadata') continue;
    const next = withoutSourceCopies(value[key], ids);
    if (next !== value[key]) (copy ??= { ...value })[key] = next;
  }
  return copy ?? value;
}

export function sourceUnavailable(record) {
  return record?.sourceAvailability === 'unavailable'
    || (Array.isArray(record?.claims) && record.claims.some(claim => claim?.sourceAvailability === 'unavailable'))
    || record?.causalClaim?.sourceAvailability === 'unavailable'
    || (Array.isArray(record?.causalClaim?.evidence) && record.causalClaim.evidence.some(item => item?.sourceAvailability === 'unavailable'));
}
