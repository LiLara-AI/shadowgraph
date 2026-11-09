// A relation across a project boundary, as a store written before ShadowGraph
// refused to create one holds it (plan v1.4.4 PR-09; P1 reconciliation F-16):
// the relation, the `relation.created` journal entry and the breadcrumb event
// link() wrote for it, shaped and labelled as link() wrote them -- the entry
// and the event carry the source's project. link() no longer writes such a
// relation, so fixtures that need one import this payload; the store keeps it
// as legacy data, and scoped reads do not cross it.
//
// `seq` is the next journal sequence of the graph it is imported into. Entry
// and event ids come from it rather than from the relation id, so they carry
// nothing a purge would have to scrub.
export function historicalRelation({ id, from, to, relation, project = null, seq, at }) {
  const item = { id, kind: 'relation', schemaVersion: 6, from, to, relation, createdAt: at, temporal: { validFrom: at, validTo: null, recordedAt: at, invalidatedAt: null } };
  return {
    schemaVersion: 6,
    relations: [item],
    events: [{ id: `event_historical_${seq}`, type: 'relation.created', at, ...(project ? { project } : {}), relationId: id }],
    journal: [{
      id: `jentry_historical_${seq}`, seq, type: 'relation.created', at, project, entityKind: 'relation', entityId: id,
      schemaVersion: 6, payload: item, provenance: { actor: null, client: null, sessionId: null }
    }]
  };
}
