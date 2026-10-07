// Reader-before-writer support for reprocessed attempt representations. An
// attempt event remains historical evidence; replacing its extraction does
// not mean the event stopped happening. Never persist this read projection.
const kinds = new Set(['attempt', 'decision', 'memory']);
const list = value => Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
const projectWide = record => record.kind !== 'memory' || ['userId', 'agentId', 'runId'].every(key => record.scope?.[key] == null);
const sameOwner = (a, b) => a.attribution === b.attribution && a.project === b.project && a.originId === b.originId
  && (a.attribution === 'project' ? typeof a.project === 'string' && a.project.length > 0
    : a.attribution === 'unattributed' && typeof a.originId === 'string' && a.originId.length > 0);

export function extractionSupersession(record, records, relations, visible = projectWide) {
  // This name belongs to the read projection. Unknown stored members survive
  // persistence, but cannot supply authority to hide a representation.
  if (record && Object.hasOwn(record, 'derivationState')) {
    const { derivationState, ...stored } = record;
    record = stored;
  }
  if (!kinds.has(record?.kind) || typeof record.captureRef !== 'string' || !record.captureRef) return record;
  const before = [], after = [];
  for (const edge of relations.values()) {
    if (edge.relation !== 'supersedes' || edge.from === edge.to || (edge.from !== record.id && edge.to !== record.id)) continue;
    const from = records.get(edge.from), to = records.get(edge.to);
    if (!from || !to || !visible(from) || !visible(to) || to.kind !== 'attempt' || !kinds.has(from.kind)
      || from.captureRef !== record.captureRef || to.captureRef !== record.captureRef || !sameOwner(from, to)) continue;
    (edge.from === record.id ? before : after).push(edge.from === record.id ? edge.to : edge.from);
  }
  if (!before.length && !after.length) return record;
  return { ...record,
    ...(before.length ? { supersedes: [...new Set([...list(record.supersedes), ...before])].sort() } : {}),
    ...(after.length ? { supersededBy: [...new Set([...list(record.supersededBy), ...after])].sort(), derivationState: 'superseded' } : {}) };
}
