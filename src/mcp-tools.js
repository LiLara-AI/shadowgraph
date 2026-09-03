// ONE source of truth for MCP tool metadata: names, descriptions, input schemas,
// output schemas, behavioural annotations, compact membership, and which tools
// persist. src/mcp.js derives its advertised list, its unknown-tool guard, and
// its post-call persistence decision from this catalog, so those three lists
// cannot drift apart the way three hand-maintained string lists could.
//
// Nothing here reads the environment or performs I/O: the catalog is a pure
// function of the server's configuration, which keeps every claim testable
// in-process and keeps the wire output deterministic.
import { SOURCE_CLASSES, DECISION_STATUSES, OUTCOME_STATUSES, CONTENT_SEARCH_FIELDS, MEMORY_TYPES } from './shadowgraph.js';

// ---------------------------------------------------------------------------
// Protocol negotiation and capability tiers
// ---------------------------------------------------------------------------
// Handshake revisions this server implements, newest first. Each was read
// against its own specification text and is answered with the members that
// revision defines. A revision is added here only after its deltas have been
// audited and implemented, never because some client asked for it: a requested
// version is evidence of client preference, not of server capability.
//
// 2026-07-28 is deliberately absent. It removed the handshake altogether and is
// reached only through per-request `_meta`, which src/mcp.js handles separately.
export const LEGACY_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

// Revisions whose base protocol requires a server to accept JSON-RPC batches.
// 2025-03-26 introduced that requirement and 2025-06-18 removed batching, so
// this is exactly one revision rather than a range.
export const BATCH_PROTOCOL_VERSIONS = Object.freeze(['2025-03-26']);

// `annotations` entered the specification in 2025-03-26, and `outputSchema` with
// `structuredContent` in 2025-06-18. Optional tool members follow the revision
// the server NEGOTIATED and nothing else, because only that revision is agreed
// by both peers.
export const METADATA_TIER = Object.freeze({ BARE: 0, ANNOTATED: 1, STRUCTURED: 2 });
const TIER_BY_PROTOCOL_VERSION = Object.freeze({
  '2024-11-05': METADATA_TIER.BARE,
  '2025-03-26': METADATA_TIER.ANNOTATED,
  '2025-06-18': METADATA_TIER.STRUCTURED,
  '2025-11-25': METADATA_TIER.STRUCTURED
});

// Lifecycle: a server that supports the requested revision MUST answer with the
// same one, and otherwise MUST answer with another revision it supports, which
// SHOULD be the latest. Exact string match, no parsing and no ordering: an
// unrecognised value is simply a revision this server has not implemented,
// whatever it looks like. Callers reject a missing, non-string, or empty
// protocolVersion as invalid params before reaching this.
export function negotiateLegacyProtocolVersion(requested) {
  return LEGACY_PROTOCOL_VERSIONS.includes(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0];
}

// Tier for a NEGOTIATED revision. Anything absent from the table, including a
// session that has not negotiated yet, is BARE: a member is withheld rather
// than advertised to a peer that may be unable to interpret it.
export function metadataTierForProtocolVersion(negotiated) {
  return TIER_BY_PROTOCOL_VERSION[negotiated] ?? METADATA_TIER.BARE;
}

// ---------------------------------------------------------------------------
// Shared input-schema fragments
// ---------------------------------------------------------------------------
function described(schema, description) { return { ...schema, description }; }

const provenanceProperties = {
  sourceClass: { type: 'string', enum: [...SOURCE_CLASSES], description: 'Claimed origin, never proof: agent_claimed (the default), tool_observed, human_confirmed, or production_verified. It weights confidence only. An unrecognised label downgrades to agent_claimed, kept verbatim in sourceRaw.' },
  actor: { type: 'string', description: 'Who performed this write, such as an agent or person name. Stored for audit; never used to grant trust.' },
  client: { type: 'string', description: 'Which client software performed this write, such as the host application name.' },
  sessionId: { type: 'string', description: 'Caller-owned identifier that groups related writes in the audit trail.' }
};
const pageProperties = {
  limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum items to return, 1-1000; the default is 50 and completeness.limitSource reports which applied. Out of range is rejected, never silently clamped.' },
  offset: { type: 'integer', minimum: 0, description: 'Items to skip before this window. Ordering is total and deterministic, so paging cannot drop or duplicate an item.' }
};
const nullableStringProperty = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const jsonValueProperty = {
  description: 'Any lossless JSON value: string, finite number, boolean, null, array, or object.',
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    { type: 'array', items: { $ref: '#/$defs/jsonValue' } },
    { type: 'object', additionalProperties: { $ref: '#/$defs/jsonValue' } }
  ]
};
const evidenceItemProperty = {
  description: 'One piece of supporting evidence. A plain string is stored as its source; an object carries structured provenance. Nothing here is checked or re-verified: it records what the caller claimed.',
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Where the evidence came from, such as a document, ticket, or command. Searchable content.' },
        type: { type: 'string', description: 'Free-form evidence kind, such as benchmark, incident, or review.' },
        sourceClass: { type: 'string', enum: [...SOURCE_CLASSES], description: 'Claimed origin class for this item; an unrecognised value downgrades to agent_claimed.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How much weight the caller places on this item, 0-1. Defaults to 0.5.' },
        observedAt: { type: 'string', description: 'ISO 8601 timestamp of the observation. Defaults to the time of the write.' },
        detail: { type: 'string', description: 'Free-text detail. Searchable content.' }
      },
      additionalProperties: true
    }
  ]
};
const memoryScopeProperty = {
  type: 'object',
  description: 'Scope selector. Omitted or partial fields mean explicit nulls, not "any": identity is the exact (project, userId, agentId, runId, memoryType, key) tuple, so a run-scoped memory never leaks into a user-only read.',
  properties: {
    userId: described(nullableStringProperty, 'Person this memory belongs to, or null for none.'),
    agentId: described(nullableStringProperty, 'Agent this memory belongs to, or null for none.'),
    runId: described(nullableStringProperty, 'Single run or task this memory belongs to, or null for none.')
  },
  additionalProperties: false
};
const embeddingProperty = { type: 'array', minItems: 1, items: { type: 'number' }, description: 'Caller-supplied vector for this text. Omit to use the configured embedding provider; with no provider the record is still stored and recall reports semantic.available=false instead of renaming lexical overlap as semantic.' };
const memoryProperties = {
  memoryType: { type: 'string', enum: [...MEMORY_TYPES], description: 'Which kind of memory this is, and part of its identity. preference and profile are durable user facts, goal a desired state, instruction an operating constraint, procedure reusable steps, episode a recallable event, note general knowledge.' },
  key: { type: 'string', description: 'Stable caller-chosen name within this scope and type, such as hotel-style. Reusing it reconciles that memory rather than adding a second one.' },
  text: { type: 'string', description: 'The memory content itself. Stored verbatim, searched as content, and compared to decide ADD, UPDATE, or NOOP.' },
  scope: memoryScopeProperty,
  tags: { type: 'array', items: { type: 'string' }, description: 'Free-form labels stored with the memory. Part of the compared content, so changing them produces a new version.' },
  metadata: { type: 'object', description: 'Caller-owned JSON object kept with the memory. Part of the compared content, so changing it produces a new version.' },
  validFrom: { type: 'string', description: 'ISO 8601 instant from which this memory is true in the modeled world. Defaults to the write time. Writes for one identity must arrive in non-decreasing validFrom order.' },
  validTo: described(nullableStringProperty, 'ISO 8601 instant after which it stops being true, or null for open-ended. Must be later than validFrom.'),
  embedding: embeddingProperty
};
const idempotencyKeyProperty = { type: 'string', maxLength: 200, description: 'Retry key scoped by project and operation: reuse it so a retry returns the first result instead of writing a duplicate. Without it every call creates a new entity.' };
const projectProperty = { type: 'string', description: 'Project namespace. Defaults to "default"; an empty string is rejected.' };
const decisionIdProperty = { type: 'string', description: 'Identifier of an existing decision, as returned by shadowgraph_record_decision, shadowgraph_search, or shadowgraph_retrieve.' };
const changedFactsProperty = { type: 'array', items: { type: 'string' }, description: 'Fact keys that just changed. Only string-form reopenWhen rules match this list; it is an ephemeral signal, not durable state.' };
const factsOverrideProperty = { type: 'object', description: 'Fact key/value overrides evaluated instead of the stored facts of the same key. Stored facts are used for every key not listed here, so reopen rules still work after a restart.' };
const statusFilterProperty = { type: 'string', enum: [...DECISION_STATUSES], description: 'Return only decisions in this lifecycle state. A structured filter, so matching it is never counted as a content match.' };
const kindFilterProperty = { type: 'string', enum: ['decision', 'attempt'], description: 'Restrict results to decisions or to attempts. A structured filter, never a content match.' };
const sourceClassFilterProperty = { type: 'string', enum: [...SOURCE_CLASSES], description: 'Return only records carrying this claimed origin class. A structured filter, never a content match.' };
const minConfidenceProperty = { type: 'number', minimum: 0, maximum: 1, description: 'Return only decisions whose current confidence is at least this value, 0-1. A structured filter, never a content match.' };

// ---------------------------------------------------------------------------
// Shared output-schema fragments
// ---------------------------------------------------------------------------
// Rules these obey, enforced by test/mcp-tool-metadata.test.js: the root is an
// object (structuredContent must be an object for 2025-06-18 clients, and the
// TypeScript SDK requires outputSchema.type === "object"); every node carries a
// single string `type`; nullability is expressed with anyOf rather than a type
// array; there is no $ref, $defs, format, or empty schema. `required` lists only
// the keys the handler builds on every call, so a record imported from an older
// schema can never fail validation and turn a successful read into a client-side
// exception.
const integerCount = (description) => ({ type: 'integer', minimum: 0, description });
const stringOrNull = (description) => ({ anyOf: [{ type: 'string' }, { type: 'null' }], description });
const numberOrNull = (description) => ({ anyOf: [{ type: 'number' }, { type: 'null' }], description });
const integerOrNull = (description) => ({ anyOf: [{ type: 'integer' }, { type: 'null' }], description });
const objectOrNull = (description) => ({ anyOf: [{ type: 'object' }, { type: 'null' }], description });
const stringList = (description) => ({ type: 'array', items: { type: 'string' }, description });

const storedEntityProperties = {
  id: { type: 'string', description: 'Stable entity identifier.' },
  kind: { type: 'string', description: 'Entity kind: decision, attempt, memory, fact, relation, review, or alternative.' },
  schemaVersion: { type: 'integer', description: 'Storage schema version this entity was written under. A value above the build’s own version is preserved rather than downgraded.' },
  project: stringOrNull('Project namespace; records imported from a schema that predates projects may carry null.'),
  sourceClass: stringOrNull('Claimed origin class recorded with the write. A claim, never proof.'),
  sourceRaw: stringOrNull('The original origin label when it differed from sourceClass. Audit only; never evidence.'),
  actor: stringOrNull('Who performed the write.'),
  client: stringOrNull('Which client performed the write.'),
  sessionId: stringOrNull('Session identifier recorded with the write.'),
  createdAt: stringOrNull('ISO 8601 creation time.'),
  updatedAt: stringOrNull('ISO 8601 time of the last change.')
};
// `required` is a promise about every call, including reads of data imported
// from an older storage schema. Records carry a validated id and kind, facts
// carry a validated key but may predate both, and the generic entity schema has
// to hold any of them, so it promises nothing beyond being an object.
function entityRecordSchema(description, extra = {}, required = ['id', 'kind']) {
  return {
    type: 'object',
    description,
    ...(required.length ? { required } : {}),
    properties: { ...storedEntityProperties, ...extra }
  };
}
const decisionRecordSchema = entityRecordSchema('A stored decision, including its alternatives and auditable confidence basis.', {
  title: stringOrNull('Short name of the decision.'),
  goal: stringOrNull('What the decision was trying to achieve.'),
  chosen: stringOrNull('The option that was chosen.'),
  status: stringOrNull('Lifecycle state. Legacy records may carry a value this build does not recognise; shadowgraph_validate reports those.'),
  confidence: { type: 'object', description: 'Auditable confidence: initial, current (0-1), policy, a history entry per move, and a basis summarising the contributions it was folded from. Legacy records may lack basis.' },
  assumptions: stringList('Assumptions the decision rests on. Searchable content.'),
  evidence: { type: 'array', description: 'Normalised evidence entries: source, type, sourceClass, confidence, observedAt, detail.' },
  alternatives: { type: 'array', description: 'Rejected alternatives, each with id, label, reasonRejected, status, and the reopenWhen rules that make it reconsiderable.' },
  failedAttempts: { type: 'array', description: 'Attempt identifiers or notes attached to this decision.' },
  outcome: objectOrNull('The recorded outcome, or null until one is recorded.'),
  reviewAfter: stringOrNull('ISO 8601 instant after which shadowgraph_maintain marks this decision stale.'),
  supersededBy: stringOrNull('Identifier of the decision that replaced this one.'),
  supersedes: { type: 'array', description: 'Identifiers of decisions this one replaced.' },
  migration: { type: 'object', description: 'Present only on migrated records; records the legacy value a field was mapped from.' }
});
const attemptRecordSchema = entityRecordSchema('A stored attempt and its result.', {
  solution: stringOrNull('What was tried.'),
  result: stringOrNull('What happened.'),
  reason: stringOrNull('Why it turned out that way.'),
  environment: stringOrNull('Where it was tried.'),
  reusableWhen: { type: 'array', description: 'Conditions under which the attempt is worth repeating.' },
  relatedTo: { type: 'array', description: 'Identifiers of related entities.' }
});
const factRecordSchema = entityRecordSchema('A stored fact with its provenance claim and validity window.', {
  key: stringOrNull('Fact name, unique per project among active facts.'),
  value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }, { type: 'array' }, { type: 'object' }], description: 'The observed value, any lossless JSON value.' },
  source: stringOrNull('Legacy alias of sourceClass, retained for compatibility.'),
  confidence: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'Caller-declared confidence in the observation, 0-1.' },
  verificationStatus: stringOrNull('unverified, contradicted, expired, or verified. Only the separately configured signed-evidence verifier can produce verified.'),
  status: stringOrNull('active, superseded, or expired.'),
  expiresAt: stringOrNull('Caller-declared expiry instant, or null.'),
  observedAt: stringOrNull('ISO 8601 time the fact was observed.'),
  validityPolicy: { type: 'object', description: 'Declared expiry inputs and the effective expiration boundary derived from them.' },
  temporal: { type: 'object', description: 'Bi-temporal window: validFrom, validTo, recordedAt, invalidatedAt.' },
  verification: { type: 'object', description: 'Present only on a signed verification: the attestation this build checked.' }
}, ['key']);
const memoryRecordSchema = entityRecordSchema('A stored scoped memory version.', {
  memoryType: stringOrNull('preference, profile, goal, instruction, procedure, episode, or note.'),
  key: stringOrNull('Caller-chosen name within the scope and type.'),
  text: stringOrNull('The memory content.'),
  scope: { type: 'object', description: 'The userId, agentId, and runId this memory is scoped to; each is a string or null.' },
  version: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Version number within this identity, incrementing on each superseding write.' },
  tags: { type: 'array', description: 'Labels stored with the memory.' },
  metadata: { type: 'object', description: 'Caller-owned JSON stored with the memory.' },
  embedding: { anyOf: [{ type: 'array' }, { type: 'object' }, { type: 'null' }], description: 'The stored vector, or null when none was supplied and no provider was configured.' },
  status: stringOrNull('active, superseded, or invalidated.'),
  verificationStatus: stringOrNull('Always unverified for memories.'),
  temporal: { type: 'object', description: 'Bi-temporal window: validFrom, validTo, recordedAt, invalidatedAt.' },
  supersedes: stringOrNull('Identifier of the version this one replaced.'),
  supersededBy: stringOrNull('Identifier of the version that replaced this one.')
});
const storedRecordSchema = entityRecordSchema('One stored entity: a decision, attempt, memory, fact, or alternative. Fields vary by kind, and an entity imported from an older schema may carry fewer of them.', {}, []);
const storedRelationSchema = entityRecordSchema('A stored relationship between two entities.', {
  from: stringOrNull('Source entity identifier.'),
  to: stringOrNull('Target entity identifier.'),
  relation: stringOrNull('Relationship name, such as depends_on or supersedes.'),
  temporal: { type: 'object', description: 'Bi-temporal window for the relationship.' }
}, ['id', 'from', 'to', 'relation']);
const newRelationSchema = {
  type: 'object',
  description: 'The relationship that was created.',
  required: ['id', 'kind', 'schemaVersion', 'from', 'to', 'relation', 'createdAt', 'temporal'],
  properties: {
    id: { type: 'string', description: 'Identifier minted for this relationship. A new one on every call.' },
    kind: { type: 'string', const: 'relation', description: 'Always "relation".' },
    schemaVersion: { type: 'integer', description: 'Storage schema version.' },
    from: { type: 'string', description: 'Source entity identifier.' },
    to: { type: 'string', description: 'Target entity identifier.' },
    relation: { type: 'string', description: 'Relationship name as supplied.' },
    createdAt: { type: 'string', description: 'ISO 8601 creation time.' },
    temporal: { type: 'object', description: 'Bi-temporal window: validFrom, validTo, recordedAt, invalidatedAt.' }
  }
};
const reviewDueSchema = {
  type: 'object',
  description: 'One decision whose rejected alternatives are due for reconsideration.',
  required: ['decisionId', 'reason', 'alternativesToReconsider'],
  properties: {
    decisionId: { type: 'string', description: 'The decision to reconsider.' },
    title: stringOrNull('Decision title, when the stored decision has one.'),
    reason: { type: 'string', description: 'Comma-separated causes: the fact keys whose reopenWhen rules matched, "review date reached", or "decision outcome failed".' },
    alternativesToReconsider: stringList('Labels of the alternatives to look at again; all of them when the trigger was not alternative-specific.')
  }
};
const reviewSignalSchema = {
  type: 'object',
  description: 'A persisted review signal.',
  required: ['id', 'kind', 'decisionId', 'reason', 'alternativesToReconsider', 'status', 'createdAt'],
  properties: {
    id: { type: 'string', description: 'Signal identifier, used by shadowgraph_ack_review.' },
    kind: { type: 'string', const: 'review', description: 'Always "review".' },
    decisionId: { type: 'string', description: 'The decision this signal is about.' },
    title: stringOrNull('Decision title, when the stored decision has one.'),
    reason: { type: 'string', description: 'Why the signal was raised. Together with decisionId this is the dedupe identity, so the same cause never raises a second signal.' },
    alternativesToReconsider: stringList('Alternative labels to look at again.'),
    status: { type: 'string', enum: ['open', 'acknowledged'], description: 'open until acknowledged.' },
    createdAt: { type: 'string', description: 'ISO 8601 time the signal was raised.' },
    acknowledgedAt: stringOrNull('ISO 8601 time of the most recent acknowledgement.')
  }
};
const acknowledgedSignalSchema = {
  ...reviewSignalSchema,
  description: 'The acknowledged review signal, retained rather than deleted.',
  required: ['id', 'kind', 'decisionId', 'reason', 'alternativesToReconsider', 'status', 'createdAt', 'acknowledgedAt']
};
const pageSchema = {
  type: 'object',
  description: 'The window actually applied to the matching items.',
  required: ['offset', 'limit', 'total', 'hasMore'],
  properties: {
    offset: integerCount('Index of the first item returned.'),
    limit: { type: 'integer', minimum: 1, description: 'Window size applied, whether the caller set it or the default did.' },
    total: integerCount('Matching items before the window was applied.'),
    hasMore: { type: 'boolean', description: 'True when matching items exist beyond this window.' }
  }
};
function completenessSchema(extraProperties = {}, extraRequired = []) {
  return {
    type: 'object',
    description: 'Declares exactly what this response left out, so a truncated result can never look complete.',
    required: ['scope', 'returned', 'total', 'complete', 'omitted', 'losslessItems', 'limitSource', ...extraRequired],
    properties: {
      scope: { type: 'object', description: 'The project, query, and structured filters that produced this result, so it explains its own derivation.' },
      returned: integerCount('Items in this response.'),
      total: integerCount('Items that matched in total.'),
      complete: { type: 'boolean', description: 'True only when every matching item is present.' },
      omitted: integerCount('total minus returned.'),
      losslessItems: { type: 'boolean', description: 'Always true: each returned item is a full-fidelity record, never a summary or a truncated field.' },
      limitSource: { type: 'string', enum: ['caller', 'default'], description: 'Whose choice bounded the result.' },
      ...extraProperties
    }
  };
}
function envelopeSchema(description, itemsSchema, extraProperties = {}, extraRequired = []) {
  return {
    type: 'object',
    description,
    required: ['items', 'page', 'completeness'],
    properties: {
      items: { type: 'array', items: itemsSchema, description: 'The items in this window, in deterministic order.' },
      page: pageSchema,
      completeness: completenessSchema(extraProperties, extraRequired)
    }
  };
}
const contentFieldsProperty = stringList('The declared content fields a query term could match.');
const searchHitSchema = {
  type: 'object',
  description: 'One hit and the evidence for why it matched.',
  required: ['record', 'score', 'matched', 'reason', 'matchedBy', 'filters'],
  properties: {
    record: storedRecordSchema,
    score: { type: 'number', description: 'Relevance score; 0 when no query terms were supplied.' },
    matched: stringList('The content fields that actually matched, never schema keys.'),
    reason: { type: 'string', description: 'Human-readable explanation built from matched, so it can never claim a match it cannot name.' },
    matchedBy: { type: 'string', enum: ['content', 'filter', 'graph'], description: 'content when query terms matched, filter when only structured filters applied, graph when the item was pulled in as a neighbour.' },
    filters: { type: 'object', description: 'The structured filters that were applied.' }
  }
};
const retrieveHitSchema = {
  ...searchHitSchema,
  description: 'One hit, which may be a content match or a one-hop graph neighbour.',
  required: [...searchHitSchema.required, 'graphBoost', 'reasons'],
  properties: {
    ...searchHitSchema.properties,
    graphBoost: { type: 'number', description: '1 for an item included as a graph neighbour, 0 for a direct content match.' },
    reasons: stringList('All reasons this item is present.')
  }
};
const signalRankSchema = {
  type: 'object',
  description: 'Position this item held in each signal list, counting from 1, or null where that signal did not rank it.',
  required: ['lexical', 'semantic', 'graph', 'temporal'],
  properties: {
    lexical: integerOrNull('Position in the BM25-style lexical list.'),
    semantic: integerOrNull('Position in the vector list; null when no compatible query vector or provider existed.'),
    graph: integerOrNull('Position in the graph-distance list; null when no focalId was supplied.'),
    temporal: integerOrNull('Position in the recency list; null when neither asOf nor preferRecent was supplied.')
  }
};
// The raw values the ranks were derived from. Three are numeric; the temporal
// one is the instant the item was ordered by, so it is a timestamp string.
const signalScoreSchema = {
  type: 'object',
  description: 'The raw value behind each rank, or null where that signal did not rank this item.',
  required: ['lexical', 'semantic', 'graph', 'temporal'],
  properties: {
    lexical: numberOrNull('BM25-style lexical score.'),
    semantic: numberOrNull('Cosine similarity between the query vector and the stored vector.'),
    graph: numberOrNull('Hop distance from focalId.'),
    temporal: stringOrNull('The ISO 8601 validFrom or recordedAt instant recency ordering used, not a number.')
  }
};
const signalStateSchema = (description) => ({
  type: 'object',
  description,
  required: ['available', 'matched', 'reason'],
  properties: {
    available: { type: 'boolean', description: 'Whether this signal could contribute at all.' },
    matched: integerCount('Candidates this signal contributed.'),
    reason: stringOrNull('Why the signal was unavailable, when it was.')
  }
});
const recallSignalsSchema = {
  type: 'object',
  description: 'Authoritative per-signal availability. A signal that could not run says so instead of being silently dropped or renamed.',
  required: ['lexical', 'semantic', 'graph', 'temporal'],
  properties: {
    lexical: {
      type: 'object',
      description: 'BM25-style lexical matching over declared content.',
      required: ['available', 'matched', 'terms'],
      properties: {
        available: { type: 'boolean', description: 'True when the query contained terms.' },
        matched: integerCount('Candidates the lexical list contributed.'),
        terms: stringList('The query terms that were used.')
      }
    },
    semantic: signalStateSchema('Cosine vector matching. available is false when no compatible query vector or provider existed; the result is then lexical, graph, and temporal only.'),
    graph: signalStateSchema('Graph-distance ranking from focalId.'),
    temporal: {
      ...signalStateSchema('Recency ranking from asOf or preferRecent.'),
      required: ['available', 'matched', 'reason', 'asOf'],
      properties: {
        available: { type: 'boolean', description: 'Whether recency ranking ran.' },
        matched: integerCount('Candidates the temporal list contributed.'),
        reason: stringOrNull('Why recency ranking did not run, when it did not.'),
        asOf: stringOrNull('The point in time selection was made against, or null for now.')
      }
    }
  }
};
const rankingSchema = {
  type: 'object',
  description: 'How the per-signal lists were fused.',
  required: ['strategy', 'k', 'weights'],
  properties: {
    strategy: { type: 'string', description: 'Fusion strategy identifier, currently weighted_rrf.' },
    k: { type: 'number', description: 'Reciprocal rank fusion constant.' },
    weights: { type: 'object', description: 'Per-signal weights applied during fusion.' }
  }
};
const recallHitSchema = {
  type: 'object',
  description: 'One recalled record with its per-signal explanation.',
  required: ['record', 'score', 'ranks', 'scores', 'reasons'],
  properties: {
    record: storedRecordSchema,
    score: { type: 'number', description: 'Fused score.' },
    ranks: signalRankSchema,
    scores: signalScoreSchema,
    reasons: stringList('One entry per contributing signal, naming the rank it contributed.')
  }
};
const collectionCompletenessSchema = (description) => ({
  type: 'object',
  description,
  required: ['returned', 'total', 'hasMore', 'omitted'],
  properties: {
    returned: integerCount('Items returned for this collection.'),
    total: integerCount('Items that matched for this collection.'),
    hasMore: { type: 'boolean', description: 'True when this collection was truncated.' },
    omitted: integerCount('total minus returned for this collection.')
  }
});
const journalEntrySchema = {
  type: 'object',
  description: 'One journal entry: a complete post-operation snapshot. Entries imported from older schemas may lack seq or payload.',
  properties: {
    id: { type: 'string', description: 'Entry identifier.' },
    seq: { type: 'integer', description: 'Monotonic sequence number. Absent on pre-journal metadata entries.' },
    type: { type: 'string', description: 'Entry type, such as decision.recorded, fact.observed, memory.superseded, or project.purged.' },
    at: { type: 'string', description: 'ISO 8601 time the entry was appended.' },
    project: stringOrNull('Project the entry belongs to.'),
    entityKind: stringOrNull('Kind of the entity the entry is about.'),
    entityId: stringOrNull('Identifier of that entity; null on a redacted skeleton.'),
    schemaVersion: { type: 'integer', description: 'Schema version the entry was written under.' },
    payload: objectOrNull('The complete post-operation snapshot, or null once a logical purge reduced the entry to an audit skeleton.'),
    provenance: { type: 'object', description: 'actor, client, and sessionId recorded with the write; all null on purged skeletons.' },
    idempotencyKey: { type: 'string', description: 'Present only when the write carried a retry key.' },
    causationId: { type: 'string', description: 'Present only when this entry was caused by another; carries that entry id.' },
    transition: { type: 'object', description: 'Present only on lifecycle changes; carries from, to, and the actor that made them.' },
    redacted: { type: 'boolean', description: 'Present only on entries reduced by a logical purge.' },
    redactedReason: { type: 'string', description: 'Why the entry was reduced.' }
  }
};
const validationIssueSchema = {
  type: 'object',
  description: 'One diagnostic. Extra fields identify the affected entity, entry, or scope.',
  required: ['code', 'severity'],
  properties: {
    code: { type: 'string', description: 'Stable diagnostic code, such as missing_relation_source, unknown_decision_status, or journal_gap.' },
    severity: { type: 'string', enum: ['error', 'legacy', 'unsupported', 'info'], description: 'error is invalid data, legacy is readable but predates a contract, unsupported comes from a newer schema this build cannot interpret, info is a declared discontinuity.' },
    recordId: { type: 'string', description: 'Affected record or fact identifier.' },
    relationId: { type: 'string', description: 'Affected relationship identifier.' },
    entityId: { type: 'string', description: 'Affected entity identifier.' },
    entryId: { type: 'string', description: 'Affected journal entry identifier.' },
    seq: integerOrNull('Affected journal sequence number.'),
    type: stringOrNull('Affected journal entry type.'),
    detail: { type: 'string', description: 'Human-readable explanation.' }
  }
};
const projectionSchema = {
  type: 'object',
  description: 'The projection folded from the journal.',
  required: ['schemaVersion', 'records', 'facts', 'relations', 'idempotency'],
  properties: {
    schemaVersion: { type: 'integer', description: 'Schema version of the rebuilt projection.' },
    records: { type: 'array', items: storedRecordSchema, description: 'Decisions, attempts, and memories reconstructed by the fold.' },
    facts: { type: 'array', items: factRecordSchema, description: 'Facts reconstructed by the fold.' },
    relations: { type: 'array', items: storedRelationSchema, description: 'Relationships reconstructed by the fold.' },
    idempotency: { type: 'array', description: 'Retry-key entries reconstructed by the fold.' }
  }
};
const exportSchema = {
  type: 'object',
  description: 'A complete store export.',
  required: ['schemaVersion', 'revision', 'records', 'facts', 'relations', 'reviewSignals', 'idempotency', 'events', 'journal', 'journalSeq', 'journalEpoch'],
  properties: {
    schemaVersion: { type: 'integer', description: 'Storage schema version of this export.' },
    revision: { type: 'integer', description: 'Concurrency token of the state this export was taken from.' },
    records: { type: 'array', items: storedRecordSchema, description: 'Decisions, attempts, and memories.' },
    facts: { type: 'array', items: factRecordSchema, description: 'Observed facts with their provenance claims.' },
    relations: { type: 'array', items: storedRelationSchema, description: 'Relationships.' },
    reviewSignals: { type: 'array', items: reviewSignalSchema, description: 'Persisted review signals.' },
    idempotency: { type: 'array', description: 'Retry-key entries, each { key, value }.' },
    events: { type: 'array', description: 'Compatibility event log.' },
    journal: { type: 'array', items: journalEntrySchema, description: 'The append-oriented journal.' },
    journalSeq: { type: 'integer', description: 'Highest journal sequence issued.' },
    journalEpoch: integerOrNull('First replayable sequence, or null when nothing is replayable.')
  }
};

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------
// A description is the one piece of tool metadata an agent always reads, and it
// competes for context with every other tool in the list, so it carries only
// what changes a caller's choice: `does` (verb, resource, scope), `route` (which
// sibling to use instead), `effects` (what it persists, whether that is
// reversible, and what a retry does), and `returns`, which is present only for
// the two tools whose return shape no output schema can carry.
//
// Everything else lives where a caller can look it up without paying for it in
// every listing: field rules in the input-schema property descriptions, result
// shapes in the output schemas, and the longer explanations in
// docs/mcp-compatibility.md. Multi-line strings are avoided so a CRLF checkout
// cannot change the advertised bytes. test/mcp-tool-metadata.test.js caps each
// description and the total across the advertised set.
const CONTENT_FIELD_LIST = CONTENT_SEARCH_FIELDS.join(', ');

function compose({ does, route, effects, returns }) {
  return [does, route, effects, returns].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------
// `compact` marks the 12 everyday workflow tools advertised when
// SHADOWGRAPH_MCP_COMPACT=1. `persists` marks the tools whose successful call is
// followed by a durable save in src/mcp.js; shadowgraph_restore is deliberately
// false because the storage backend commits the replacement itself.
// `openWorldWhenEmbedding` marks the two tools whose reach depends on whether an
// embedding endpoint was configured.
const CATALOG = [
  {
    name: 'shadowgraph_record_decision',
    compact: true,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    describe: {
      does: 'Record one decision: chosen option, assumptions, evidence, and rejected alternatives with reopenWhen rules.',
      route: 'Use shadowgraph_record_attempt for something tried, shadowgraph_record_fact for an observation, shadowgraph_remember for a note.',
      effects: 'Appends a decision and a journal entry; without idempotencyKey each call adds another and commits a revision.'
    },
    inputSchema: {
      type: 'object',
      required: ['title', 'chosen'],
      properties: {
        title: { type: 'string', description: 'Short name of the decision. Required, non-empty, and searchable content.' },
        chosen: { type: 'string', description: 'The option actually chosen. Required, non-empty, and searchable content.' },
        project: projectProperty,
        goal: { type: 'string', description: 'What the decision is meant to achieve. Searchable content.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Starting confidence, 0-1. Defaults to 0.5. Later outcomes and evidence move it from this baseline; it is a degree of belief, never a verification status.' },
        assumptions: { type: 'array', items: { type: 'string' }, description: 'What the decision takes for granted. Record each as a fact too if it should be able to reopen the decision.' },
        evidence: { type: 'array', items: evidenceItemProperty, description: 'Supporting evidence. Counted as declared evidence in the confidence basis, but never re-checked.' },
        alternatives: {
          type: 'array',
          description: 'Options considered and rejected. Alternatives belong to the decision and have no separate write API; they are what shadowgraph_review reconsiders.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Name of the rejected option. Required in practice: an alternative without a non-empty label is rejected.' },
              reasonRejected: { type: 'string', description: 'Why it was rejected. Searchable content.' },
              reason: { type: 'string', description: 'Accepted as an alias of reasonRejected for older callers.' },
              reopenWhen: { type: 'array', description: 'Rules that make this alternative worth reconsidering. Each is either a fact key as a plain string, matched only against changedFacts, or an object { key, operator, value } evaluated against stored facts so it still fires after a restart. operator defaults to equals.' }
            }
          }
        },
        idempotencyKey: idempotencyKeyProperty,
        ...provenanceProperties
      }
    },
    outputSchema: decisionRecordSchema
  },
  {
    name: 'shadowgraph_record_attempt',
    compact: true,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    describe: {
      does: 'Record one attempt and how it turned out, so the same approach is not blindly retried.',
      route: 'Use shadowgraph_record_decision for the choice itself, shadowgraph_record_outcome for how one played out.',
      effects: 'Appends an attempt and a journal entry; without idempotencyKey a retry records a second one.'
    },
    inputSchema: {
      type: 'object',
      required: ['solution', 'result'],
      properties: {
        solution: { type: 'string', description: 'What was tried. Required, non-empty, and searchable content.' },
        result: { type: 'string', description: 'What happened. Required, non-empty, and searchable content. Wording such as failed, error, or regression is what makes the attempt surface in shadowgraph_context as one to avoid.' },
        project: projectProperty,
        reason: { type: 'string', description: 'Why it turned out that way. Searchable content.' },
        environment: { type: 'string', description: 'Where it was tried, such as a runtime, OS, or version. Searchable content, so a later attempt can be matched to the same environment.' },
        idempotencyKey: idempotencyKeyProperty,
        ...provenanceProperties
      }
    },
    outputSchema: attemptRecordSchema
  },
  {
    name: 'shadowgraph_review',
    compact: true,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    describe: {
      does: 'List decisions whose rejected alternatives are due again, from reopenWhen rules over stored facts.',
      route: 'shadowgraph_review_signals reads persisted ones, shadowgraph_ack_review closes one, shadowgraph_maintain ages first.',
      effects: 'Persists one signal per newly due decision, deduped by decision and reason; a repeat commits a revision.',
      returns: 'Returns a bare JSON array.'
    },
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Review only this project. Omit to review every project.' },
        changedFacts: changedFactsProperty,
        facts: factsOverrideProperty
      }
    }
  },
  {
    name: 'shadowgraph_search',
    compact: true,
    persists: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    describe: {
      does: 'Find decisions, attempts, and facts whose declared content fields contain every query term.',
      route: 'shadowgraph_retrieve adds one-hop neighbours, shadowgraph_recall fuses ranks over scoped memory, shadowgraph_context builds a working set, shadowgraph_traverse walks from an id.',
      effects: 'Reads only. Schema keys never match, and a filter is never a content match.'
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: `Whitespace-separated terms, matched case-insensitively as substrings against the declared content fields (${CONTENT_FIELD_LIST}). Every term must match something, so more terms narrow the result. Omit to filter without searching.` },
        project: { type: 'string', description: 'Restrict to one project. Omitted, decisions and facts are searched across projects, while memories stay in the default project and all-null scope.' },
        status: statusFilterProperty,
        kind: kindFilterProperty,
        sourceClass: sourceClassFilterProperty,
        minConfidence: minConfidenceProperty,
        ...pageProperties
      }
    },
    outputSchema: envelopeSchema('Matching records with their pagination and completeness declaration.', searchHitSchema, { contentFields: contentFieldsProperty }, ['contentFields'])
  },
  {
    name: 'shadowgraph_context',
    compact: true,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    describe: {
      does: "Build one project's working set before a consequential task: decisions, stale assumptions, failed attempts, open reviews.",
      route: 'shadowgraph_search or shadowgraph_retrieve look one thing up, shadowgraph_recall reads scoped memory, shadowgraph_review only evaluates.',
      effects: 'Not a read: it evaluates reopen rules, can persist signals, and commits a revision.'
    },
    inputSchema: {
      type: 'object',
      properties: {
        project: projectProperty,
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Maximum items per collection, 1-1000, applied to each collection independently. Omit for the default of 50.' },
        changedFacts: changedFactsProperty,
        facts: factsOverrideProperty
      }
    },
    outputSchema: {
      type: 'object',
      description: 'The working set for one project.',
      required: ['project', 'activeDecisions', 'staleAssumptions', 'failedAttemptsToAvoid', 'openReviews', 'suggestedQuestions', 'completeness'],
      properties: {
        project: { type: 'string', description: 'The project this context describes.' },
        activeDecisions: { type: 'array', items: decisionRecordSchema, description: 'Decisions in a current, actionable state: proposed, planned, in_progress, executed, validated, or reconsidered.' },
        staleAssumptions: { type: 'array', items: factRecordSchema, description: 'Facts that are no longer active, such as superseded or expired ones, which earlier decisions may still rest on.' },
        failedAttemptsToAvoid: { type: 'array', items: attemptRecordSchema, description: 'Attempts whose result mentions failure, regression, or error.' },
        openReviews: { type: 'array', items: reviewDueSchema, description: 'Decisions currently due for reconsideration.' },
        suggestedQuestions: stringList('Questions for the low-confidence decisions in this project.'),
        completeness: {
          type: 'object',
          description: 'Per-collection completeness. context returns five named collections, so one page object cannot describe it.',
          required: ['scope', 'complete', 'limitSource', 'losslessItems', 'collections'],
          properties: {
            scope: { type: 'object', description: 'The project this result covers.' },
            complete: { type: 'boolean', description: 'True only when no collection was truncated.' },
            limitSource: { type: 'string', enum: ['caller', 'default'], description: 'Whose choice bounded the collections.' },
            losslessItems: { type: 'boolean', description: 'Always true: items are full records, never summaries.' },
            collections: {
              type: 'object',
              description: 'One entry per returned collection.',
              required: ['activeDecisions', 'staleAssumptions', 'failedAttemptsToAvoid', 'openReviews', 'suggestedQuestions'],
              properties: {
                activeDecisions: collectionCompletenessSchema('Counts for activeDecisions.'),
                staleAssumptions: collectionCompletenessSchema('Counts for staleAssumptions.'),
                failedAttemptsToAvoid: collectionCompletenessSchema('Counts for failedAttemptsToAvoid.'),
                openReviews: collectionCompletenessSchema('Counts for openReviews.'),
                suggestedQuestions: collectionCompletenessSchema('Counts for suggestedQuestions.')
              }
            }
          }
        }
      }
    }
  },
  {
    name: 'shadowgraph_remember',
    compact: true,
    persists: true,
    openWorldWhenEmbedding: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    describe: {
      does: 'Add or reconcile one scoped memory, or apply an ADD/UPDATE/DELETE/NOOP plan, by identity tuple.',
      route: 'Use shadowgraph_record_decision for a choice, shadowgraph_record_fact for an observation, shadowgraph_recall to read memory back.',
      effects: 'Identical content is a NOOP, new content supersedes and keeps history, DELETE invalidates; every call commits a revision.'
    },
    inputSchema: {
      type: 'object',
      properties: {
        project: projectProperty,
        ...memoryProperties,
        operations: {
          type: 'array',
          description: 'A batch plan. Supply this instead of a single memory, typically from an extraction step. Every operation is validated before the first one is applied, so a malformed late operation cannot leave a half-applied batch.',
          items: {
            type: 'object',
            required: ['action', 'memoryType', 'key'],
            properties: {
              action: { type: 'string', enum: ['ADD', 'UPDATE', 'DELETE', 'NOOP'], description: 'ADD and UPDATE both reconcile against the current memory and require text; DELETE invalidates the current one, keeping history; NOOP records that nothing should change.' },
              ...memoryProperties
            }
          }
        },
        ...provenanceProperties
      },
      oneOf: [{ required: ['memoryType', 'key', 'text'] }, { required: ['operations'] }]
    },
    outputSchema: {
      type: 'object',
      description: 'Either the outcome of one reconciliation, or the outcome of a plan.',
      anyOf: [
        {
          type: 'object',
          required: ['operation', 'memory'],
          properties: {
            operation: { type: 'string', enum: ['ADD', 'UPDATE', 'NOOP'], description: 'ADD when no active memory existed, UPDATE when one was superseded, NOOP when content was identical.' },
            memory: memoryRecordSchema,
            previous: memoryRecordSchema,
            indexUpdated: { type: 'boolean', description: 'Present when identical content arrived with a different embedding: the index was refreshed without minting a new version.' }
          }
        },
        {
          type: 'object',
          required: ['results', 'completeness'],
          properties: {
            results: {
              type: 'array',
              description: 'One result per submitted operation, in order.',
              items: {
                type: 'object',
                required: ['operation', 'memory'],
                properties: {
                  operation: { type: 'string', enum: ['ADD', 'UPDATE', 'DELETE', 'NOOP'], description: 'What was actually applied, which may differ from the requested action when content already matched.' },
                  memory: { anyOf: [memoryRecordSchema, { type: 'null' }], description: 'The resulting memory, or null for a NOOP on an identity that has no memory.' },
                  previous: memoryRecordSchema,
                  indexUpdated: { type: 'boolean', description: 'Present when only the embedding was refreshed.' }
                }
              }
            },
            completeness: {
              type: 'object',
              description: 'Plan accounting. This is not the paginated completeness envelope.',
              required: ['complete', 'requested', 'applied'],
              properties: {
                complete: { type: 'boolean', description: 'Always true: a plan is applied in full or rejected in full.' },
                requested: integerCount('Operations submitted.'),
                applied: integerCount('Results produced, one per submitted operation.')
              }
            }
          }
        }
      ]
    }
  },
  {
    name: 'shadowgraph_recall',
    compact: true,
    persists: false,
    openWorldWhenEmbedding: true,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    describe: {
      does: 'Recall scoped memory and records by fusing lexical, vector, graph-distance, and temporal ranks.',
      route: 'shadowgraph_search is plain content matching, shadowgraph_retrieve adds graph neighbours, shadowgraph_remember writes memory.',
      effects: 'Reads only. Every response declares which signals were available, so absent ones are never renamed.'
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text to rank against. An empty query still returns scope-matching records ranked by the remaining signals.' },
        project: { type: 'string', description: 'Project to recall from. Defaults to "default" for memory records rather than meaning all projects.' },
        scope: memoryScopeProperty,
        memoryType: { type: 'string', enum: [...MEMORY_TYPES], description: 'Restrict memory candidates to this type.' },
        asOf: { type: 'string', description: 'ISO 8601 instant to select by valid time, returning what was true then rather than now. Also enables temporal ranking.' },
        focalId: { type: 'string', description: 'Entity id to measure graph distance from. Without it the graph signal reports available:false.' },
        preferRecent: { type: 'boolean', description: 'Enable temporal ranking against now. Ignored when asOf is supplied, which already selects a point in time.' },
        queryEmbedding: described(embeddingProperty, 'Caller-supplied query vector. Omit to use the configured provider; with neither, the semantic signal reports available:false and a reason.'),
        ...pageProperties
      }
    },
    outputSchema: envelopeSchema(
      'Fused results with a per-signal explanation of how they were ranked.',
      recallHitSchema,
      { signals: recallSignalsSchema, ranking: rankingSchema },
      ['signals', 'ranking']
    )
  },
  {
    name: 'shadowgraph_record_fact',
    compact: true,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    describe: {
      does: 'Record one observed fact as a project and key, with a claimed provenance class and optional validity window.',
      route: 'Use for the fact keys reopenWhen rules name; shadowgraph_remember stores durable memory that is not an observation.',
      effects: 'Supersedes the previous active fact, keeping it as history. No input can make a fact verified. Each call commits a revision.'
    },
    inputSchema: {
      type: 'object',
      $defs: { jsonValue: jsonValueProperty },
      required: ['key'],
      properties: {
        key: { type: 'string', description: 'Fact name, unique per project among active facts. Required and non-empty. Use the same key that a decision’s reopenWhen rules refer to.' },
        value: jsonValueProperty,
        source: { type: 'string', description: 'Legacy alias for sourceClass. An unknown label downgrades to agent_claimed with the raw label kept in sourceRaw.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How much the caller trusts this observation, 0-1. Defaults to 0.5. It does not verify anything.' },
        project: projectProperty,
        expiresAt: { type: 'string', description: 'ISO 8601 instant after which shadowgraph_maintain expires this fact. Combined with validTo, the earlier boundary wins.' },
        verificationStatus: { type: 'string', enum: ['unverified', 'contradicted'], description: 'Only "contradicted" may be set by a caller, because it lowers trust. "verified" and "expired" are rejected: verification is not self-assertable and expiry is owned by shadowgraph_maintain.' },
        idempotencyKey: idempotencyKeyProperty,
        ...provenanceProperties
      }
    },
    outputSchema: factRecordSchema
  },
  {
    name: 'shadowgraph_record_outcome',
    compact: true,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    describe: {
      does: 'Record how a decision turned out and move its confidence by an evidence-weighted amount.',
      route: 'shadowgraph_confidence_evidence records evidence short of an outcome, shadowgraph_update_status changes the lifecycle state.',
      effects: 'One outcome contribution per decision, so re-recording replaces rather than stacking, restamps it, and commits a revision.'
    },
    inputSchema: {
      type: 'object',
      required: ['decisionId', 'outcome'],
      properties: {
        decisionId: decisionIdProperty,
        outcome: {
          type: 'object',
          description: 'The outcome to record.',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: [...OUTCOME_STATUSES], description: 'successful raises confidence, failed lowers it and makes the decision due for review, mixed lowers it by half, and unknown moves nothing because "we do not know" is not evidence.' },
            sourceClass: { type: 'string', enum: [...SOURCE_CLASSES], description: 'Claimed origin of this outcome observation. It weights how far confidence moves; it never verifies anything.' },
            lessons: { type: 'array', items: { type: 'string' }, description: 'What was learned, stored with the outcome.' },
            observedAt: { type: 'string', description: 'ISO 8601 time the outcome was observed. Defaults to now.' }
          }
        }
      }
    },
    outputSchema: decisionRecordSchema
  },
  {
    name: 'shadowgraph_confidence_evidence',
    compact: false,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    describe: {
      does: "Apply one keyed piece of supporting or contradicting evidence to a decision's confidence.",
      route: 'Use shadowgraph_record_outcome once the decision has played out, shadowgraph_record_fact for an observation that can reopen it.',
      effects: 'Reusing key cannot double-count, but restamps the decision and commits a revision; a new observation needs a new key.'
    },
    inputSchema: {
      type: 'object',
      required: ['decisionId', 'reason', 'key'],
      properties: {
        decisionId: decisionIdProperty,
        reason: { type: 'string', description: 'Why this evidence matters. Required, non-empty, and kept in the audit history.' },
        supports: { type: 'boolean', description: 'Defaults to true. false records contradicting evidence, moving confidence down instead of up.' },
        key: { type: 'string', description: 'REQUIRED stable dedupe key. Reuse the same key for the same observation so retries cannot double-count; use a NEW key for a genuinely new observation. There is no default, because a generated one would only be stable within a millisecond.' },
        observedAt: { type: 'string', description: 'ISO 8601 time the evidence was observed. Defaults to now.' },
        ...provenanceProperties
      }
    },
    outputSchema: decisionRecordSchema
  },
  {
    name: 'shadowgraph_update_status',
    compact: false,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    describe: {
      does: 'Move one decision to another lifecycle state.',
      route: 'shadowgraph_supersede replaces a decision, shadowgraph_maintain alone produces stale, shadowgraph_record_outcome records the result.',
      effects: 'stale and superseded are system-owned and rejected. Setting the current state writes nothing but still commits a revision.'
    },
    inputSchema: {
      type: 'object',
      required: ['decisionId', 'status'],
      properties: {
        decisionId: decisionIdProperty,
        status: { type: 'string', enum: [...DECISION_STATUSES], description: 'Target state. Legal moves are proposed to planned/in_progress/abandoned/archived; planned to in_progress/abandoned/archived; in_progress to executed/failed/abandoned/archived; executed to validated/failed/reconsidered/archived; validated to reconsidered/archived; failed to reconsidered/abandoned/archived; reconsidered to planned/in_progress/abandoned/archived; stale to reconsidered/archived; abandoned to archived. stale and superseded cannot be set by a caller.' }
      }
    },
    outputSchema: decisionRecordSchema
  },
  {
    name: 'shadowgraph_link',
    compact: false,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    describe: {
      does: 'Create one named, directed relationship between two entities that already exist.',
      route: 'Read relationships back with shadowgraph_traverse; shadowgraph_supersede records replacement and its own relation.',
      effects: 'Every call mints a new relation id, so a repeat duplicates the relationship. There is no unlink tool.'
    },
    inputSchema: {
      type: 'object',
      required: ['from', 'to', 'relation'],
      properties: {
        from: { type: 'string', description: 'Source entity id. Must already exist: a decision, attempt, memory, fact, or alternative.' },
        to: { type: 'string', description: 'Target entity id. Must already exist.' },
        relation: { type: 'string', description: 'Relationship name, chosen by the caller and stored verbatim, such as depends_on, contradicts, or informs. It is what shadowgraph_traverse filters and explains hits by, so keep names consistent.' }
      }
    },
    outputSchema: newRelationSchema
  },
  {
    name: 'shadowgraph_traverse',
    compact: false,
    persists: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    describe: {
      does: 'Walk relationships outward from one entity id and return what is reached.',
      route: 'Find ids first with shadowgraph_search or shadowgraph_recall; shadowgraph_retrieve searches content and adds neighbours.',
      effects: 'Reads only. Memory outside the requested project and scope stays hidden.'
    },
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Entity id to start from. Must exist.' },
        depth: { type: 'integer', minimum: 1, maximum: 10, description: 'How many relationship hops to follow, 1-10. Defaults to 1. Anything outside the range is rejected.' },
        direction: { type: 'string', enum: ['in', 'out', 'both'], description: 'out follows relationships whose from is in the frontier, in follows their to, both follows either. Defaults to both.' },
        relation: { type: 'string', description: 'Follow only relationships with this exact name. Omit to follow all of them.' },
        project: { type: 'string', description: 'Project whose memory nodes are visible during the walk. Defaults to "default"; decisions, facts, and attempts are not filtered by it.' },
        scope: memoryScopeProperty
      }
    },
    outputSchema: {
      type: 'object',
      description: 'The reachable subgraph.',
      required: ['root', 'direction', 'depth', 'nodes', 'relations'],
      properties: {
        root: { type: 'string', description: 'The entity the walk started from.' },
        direction: { type: 'string', enum: ['in', 'out', 'both'], description: 'The direction that was applied.' },
        depth: { type: 'integer', minimum: 1, maximum: 10, description: 'The hop limit that was applied.' },
        nodes: { type: 'array', items: storedRecordSchema, description: 'Entities reached, root first. Mixed kinds, including alternatives synthesised from their decision.' },
        relations: { type: 'array', items: storedRelationSchema, description: 'Relationships traversed. Named relations, not "edges".' }
      }
    }
  },
  {
    name: 'shadowgraph_supersede',
    compact: false,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    describe: {
      does: 'Mark one decision superseded by a replacement in the same project.',
      route: 'shadowgraph_update_status handles ordinary lifecycle moves, shadowgraph_link any other relationship.',
      effects: 'Nothing is deleted: the previous decision stays searchable. A repeat returns the same result and commits a revision.'
    },
    inputSchema: {
      type: 'object',
      required: ['decisionId', 'replacementId'],
      properties: {
        decisionId: { type: 'string', description: 'The decision being replaced. It becomes superseded and is excluded from current context.' },
        replacementId: { type: 'string', description: 'The decision replacing it. Must be in the same project and must not be superseded, archived, abandoned, or stale.' }
      }
    },
    outputSchema: {
      type: 'object',
      description: 'Both sides of the supersession and the relationship that records it.',
      required: ['previous', 'replacement', 'relation'],
      properties: {
        previous: decisionRecordSchema,
        replacement: decisionRecordSchema,
        relation: { anyOf: [storedRelationSchema, { type: 'null' }], description: 'The supersedes relationship, or null when a repeated supersession found none to report.' }
      }
    }
  },
  {
    name: 'shadowgraph_redact',
    compact: false,
    persists: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    describe: {
      does: 'Return a redacted copy of the store export, with secret-looking keys and values replaced.',
      route: 'shadowgraph_backup writes an unredacted snapshot to disk, shadowgraph_purge actually removes data.',
      effects: 'Reads only, writes no file, and redacts journal payloads too, so a secret cannot survive in the audit trail.'
    },
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Limit the export to one project. Omit to redact everything.' },
        patterns: { type: 'array', items: { type: 'string' }, description: 'Case-insensitive regular expressions matched against key names, replacing the default set (password, secret, token, api[-_]?key, authorization, private[-_]?key). Supplying this replaces the defaults rather than adding to them; idempotency keys, evidence references, and signatures are always redacted.' }
      }
    },
    outputSchema: exportSchema
  },
  {
    name: 'shadowgraph_purge',
    compact: false,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    describe: {
      does: "Delete one project's decisions, attempts, memories, facts, relationships, events, and retry keys.",
      route: 'Run shadowgraph_purge_preview first; shadowgraph_redact shares without deleting, shadowgraph_backup keeps a copy.',
      effects: 'Irreversible without a backup. logical keeps an auditable journal skeleton; hard also drops entries, leaving a declared gap.'
    },
    inputSchema: {
      type: 'object',
      required: ['project'],
      properties: {
        project: { type: 'string', description: 'Project to delete. Required and non-empty; there is no wildcard.' },
        mode: { type: 'string', enum: ['logical', 'hard'], description: 'Defaults to logical, which keeps an auditable payload-free journal skeleton. "hard" is irreversible, physically removes journal entries, and leaves a sequence gap that validate() reports.' }
      }
    },
    outputSchema: {
      type: 'object',
      description: 'What the purge removed.',
      required: ['project', 'records', 'facts', 'relations', 'events', 'journal', 'removed', 'mode', 'journalEntriesRedacted', 'journalEntriesRemoved', 'removedJournalSequences', 'idempotencyRemoved', 'journalEntryId'],
      properties: {
        project: { type: 'string', description: 'The project that was purged.' },
        records: integerCount('Decisions, attempts, and memories that were present.'),
        facts: integerCount('Facts that were present.'),
        relations: integerCount('Relationships that were present.'),
        events: integerCount('Compatibility events that were present.'),
        journal: integerCount('Journal entries that were present for the project.'),
        removed: integerCount('Entities removed from live state, including alternatives.'),
        mode: { type: 'string', enum: ['logical', 'hard'], description: 'The mode that was applied.' },
        journalEntriesRedacted: integerCount('Entries reduced to an audit skeleton by a logical purge.'),
        journalEntriesRemoved: integerCount('Entries physically deleted by a hard purge.'),
        removedJournalSequences: { type: 'array', items: { type: 'integer' }, description: 'Sequence numbers a hard purge removed, declared so the resulting gap is explained rather than hidden.' },
        idempotencyRemoved: integerCount('Retry keys removed with the project.'),
        journalEntryId: { type: 'string', description: 'Id of the project.purged entry that records this purge.' }
      }
    }
  },
  {
    name: 'shadowgraph_maintain',
    compact: true,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    describe: {
      does: 'Run time-based maintenance: make due decisions stale, expire due facts, then evaluate reopen rules.',
      route: 'shadowgraph_review only evaluates reopen rules, shadowgraph_validate only reports, shadowgraph_update_status cannot set stale.',
      effects: 'Writes, and depends on the clock: a repeat at the same instant finds nothing to do but still commits a revision.'
    },
    inputSchema: {
      type: 'object',
      properties: {
        now: { type: 'string', description: 'ISO 8601 instant to treat as the current time. Defaults to the real clock; supplying it makes the run deterministic.' },
        changedFacts: changedFactsProperty,
        facts: factsOverrideProperty
      }
    },
    outputSchema: {
      type: 'object',
      description: 'What maintenance changed and what is now due.',
      required: ['at', 'staleDecisionIds', 'agedDecisionIds', 'reviewSignals', 'due'],
      properties: {
        at: { type: 'string', description: 'The instant maintenance ran against.' },
        staleDecisionIds: stringList('Decisions moved to stale because they passed reviewAfter.'),
        agedDecisionIds: stringList('Compatibility alias of staleDecisionIds for older callers.'),
        reviewSignals: { type: 'array', items: reviewSignalSchema, description: 'Every persisted review signal after the run, open and acknowledged alike.' },
        due: { type: 'array', items: reviewDueSchema, description: 'Decisions due for reconsideration after the run.' }
      }
    }
  },
  {
    name: 'shadowgraph_retrieve',
    compact: true,
    persists: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    describe: {
      does: 'Retrieve records matching a content query together with their one-hop graph neighbours.',
      route: 'shadowgraph_search returns matches only, shadowgraph_recall ranks scoped memory, shadowgraph_traverse walks from a known id, shadowgraph_context builds a project working set.',
      effects: 'Reads only. A neighbour can appear with no content match of its own.'
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: `Whitespace-separated terms matched against the declared content fields (${CONTENT_FIELD_LIST}), exactly as in shadowgraph_search. Omit to retrieve by filters alone.` },
        project: { type: 'string', description: 'Restrict to one project, including which neighbours may be pulled in.' },
        status: statusFilterProperty,
        kind: kindFilterProperty,
        minConfidence: minConfidenceProperty,
        ...pageProperties
      }
    },
    outputSchema: envelopeSchema(
      'Matching records plus their one-hop neighbours, with pagination and completeness.',
      retrieveHitSchema,
      { contentFields: contentFieldsProperty, includesGraphNeighbours: { type: 'boolean', description: 'Always true: this result may contain items reached by relationship rather than by content.' } },
      ['contentFields', 'includesGraphNeighbours']
    )
  },
  {
    name: 'shadowgraph_validate',
    compact: true,
    persists: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    describe: {
      does: 'Report graph integrity diagnostics by severity, without modifying storage.',
      route: 'shadowgraph_repair_plan shows what a fix would involve, shadowgraph_rebuild tests whether the journal reproduces the data.',
      effects: 'Reads only. Legacy data is named rather than guess-repaired, and newer-schema data is reported, not downgraded.'
    },
    inputSchema: { type: 'object' },
    outputSchema: {
      type: 'object',
      description: 'Integrity diagnostics.',
      required: ['valid', 'issues', 'counts'],
      properties: {
        valid: { type: 'boolean', description: 'False when any error or unsupported issue is present.' },
        issues: { type: 'array', items: validationIssueSchema, description: 'Every diagnostic found, each with a stable code and severity.' },
        counts: {
          type: 'object',
          description: 'Issue counts per severity.',
          required: ['error', 'legacy', 'unsupported', 'info'],
          properties: {
            error: integerCount('Genuinely invalid data.'),
            legacy: integerCount('Readable data that predates a contract.'),
            unsupported: integerCount('Data from a newer schema or policy this build cannot interpret.'),
            info: integerCount('Declared discontinuities, such as a hard-purge journal gap.')
          }
        }
      }
    }
  },
  {
    name: 'shadowgraph_journal',
    compact: false,
    persists: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    describe: {
      does: 'Read the append-oriented journal of complete post-operation snapshots, in sequence order.',
      route: 'shadowgraph_rebuild replays it into a projection, shadowgraph_validate diagnoses live data, shadowgraph_search finds records.',
      effects: 'Reads only. Entries are immutable audit evidence and are never rewritten in place.'
    },
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Return only entries recorded for this project. Omit for every project, including entries with no project.' },
        ...pageProperties
      }
    },
    outputSchema: envelopeSchema(
      'Journal entries with pagination, replay boundary, and declared gaps.',
      journalEntrySchema,
      {
        journalEpoch: integerOrNull('First replayable sequence, or null when nothing is replayable.'),
        journalSeq: { type: 'integer', description: 'Highest sequence issued so far.' },
        gaps: { type: 'array', description: 'Sequence ranges missing from the journal, each { from, to }. A hard purge legitimately creates one; it is declared, not hidden.', items: { type: 'object', properties: { from: { type: 'integer', description: 'First missing sequence.' }, to: { type: 'integer', description: 'Last missing sequence.' } } } }
      },
      ['journalEpoch', 'journalSeq', 'gaps']
    )
  },
  {
    name: 'shadowgraph_rebuild',
    compact: false,
    persists: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    describe: {
      does: "Replay this store's own journal into a projection and report whether the fold was complete.",
      route: 'shadowgraph_journal reads the entries themselves, shadowgraph_validate diagnoses the live graph.',
      effects: 'Reads only: the journal is untouched and the live graph is not replaced by the result.'
    },
    inputSchema: {
      type: 'object',
      properties: {
        requireFullHistory: { type: 'boolean', description: 'When true, refuse to rebuild if pre-journal metadata-only entries exist, returning rebuildable:false instead of a fold that silently starts later. Defaults to false.' }
      }
    },
    outputSchema: {
      type: 'object',
      description: 'The rebuild report and the projection it produced.',
      required: ['ok', 'rebuildable', 'reason', 'projection', 'journalEpoch', 'replayedFrom', 'replayedTo', 'applied', 'skipped', 'legacy', 'duplicates'],
      properties: {
        ok: { type: 'boolean', description: 'True when the fold ran; it does not by itself mean the projection is complete.' },
        rebuildable: { type: 'boolean', description: 'True only when every entry in the replay range was folded and the result is trustworthy.' },
        reason: stringOrNull('Why the projection is not rebuildable, or null when it is.'),
        projection: projectionSchema,
        journalEpoch: integerOrNull('First replayable sequence.'),
        replayedFrom: integerOrNull('Lowest sequence folded.'),
        replayedTo: integerOrNull('Highest sequence folded.'),
        applied: integerCount('Entries folded into the projection.'),
        skipped: { type: 'array', description: 'Entries not folded, each carrying seq, type, and a stable why such as unknown_entry_type or unsupported_schema_version.' },
        legacy: { type: 'array', description: 'Entries recognised as pre-journal or non-replayable, each with a why.' },
        duplicates: { type: 'array', description: 'Sequence numbers appearing more than once, each { seq, count }. A repeated sequence cannot be totally ordered, so it makes the fold untrustworthy.' }
      }
    }
  },
  {
    name: 'shadowgraph_review_signals',
    compact: false,
    persists: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    describe: {
      does: 'List the review signals already persisted, optionally narrowed to a project or to open or acknowledged ones.',
      route: 'shadowgraph_review re-evaluates reopen rules and can create signals, shadowgraph_ack_review closes one.',
      effects: 'Reads only. Acknowledged signals are retained rather than deleted.',
      returns: 'Returns a bare JSON array, not paginated.'
    },
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Only signals whose decision belongs to this project. Omit for every project.' },
        status: { type: 'string', enum: ['open', 'acknowledged'], description: 'Filter by state. Omit to return both.' }
      }
    }
  },
  {
    name: 'shadowgraph_purge_preview',
    compact: false,
    persists: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    describe: {
      does: 'Count what a purge of one project would remove, without changing anything.',
      route: 'Run this before shadowgraph_purge; it takes the same project name and reports the same counts.',
      effects: 'Reads only: no storage, journal, or signal change, and no file is written.'
    },
    inputSchema: {
      type: 'object',
      required: ['project'],
      properties: {
        project: { type: 'string', description: 'Project name to preview, matched exactly. Required and non-empty.' }
      }
    },
    outputSchema: {
      type: 'object',
      description: 'What a purge of this project would remove.',
      required: ['project', 'records', 'facts', 'relations', 'events', 'journal'],
      properties: {
        project: { type: 'string', description: 'The project that was previewed.' },
        records: integerCount('Decisions, attempts, and memories in the project.'),
        facts: integerCount('Facts in the project.'),
        relations: integerCount('Relationships touching the project.'),
        events: integerCount('Compatibility events for the project.'),
        journal: integerCount('Journal entries recorded for the project.')
      }
    }
  },
  {
    name: 'shadowgraph_ack_review',
    compact: false,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    describe: {
      does: 'Acknowledge one persisted review signal by id, closing it as open work.',
      route: 'Ids come from shadowgraph_review_signals or shadowgraph_review; use shadowgraph_update_status or shadowgraph_supersede to act on the decision.',
      effects: 'Overwrites status and acknowledgedAt in place with no journal entry, so a rebuild cannot reconstruct it; a repeat restamps it.'
    },
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Review signal id, as returned in the id field by shadowgraph_review_signals or in reviewSignals by shadowgraph_maintain. This is the signal id, not the decisionId it refers to.' }
      }
    },
    outputSchema: acknowledgedSignalSchema
  },
  {
    name: 'shadowgraph_repair_plan',
    compact: false,
    persists: false,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    describe: {
      does: 'Return the non-destructive repair plan implied by the current diagnostics.',
      route: 'Use after shadowgraph_validate; there is no apply tool, so the caller carries out every action with ordinary tools.',
      effects: 'Never mutates: the result always carries apply:false, and anything ambiguous is routed to manual_review.'
    },
    inputSchema: { type: 'object' },
    outputSchema: {
      type: 'object',
      description: 'A plan that is never applied automatically.',
      required: ['apply', 'actions'],
      properties: {
        apply: { type: 'boolean', const: false, description: 'Always false: this tool proposes, it never repairs.' },
        actions: {
          type: 'array',
          description: 'One action per diagnostic.',
          items: {
            type: 'object',
            required: ['action'],
            properties: {
              action: { type: 'string', enum: ['remove_relation', 'manual_review'], description: 'remove_relation for a relationship whose endpoint is missing; manual_review for everything else.' },
              relationId: { type: 'string', description: 'Relationship to remove, on a remove_relation action.' },
              reason: { type: 'string', description: 'The diagnostic code that justified a remove_relation action.' },
              code: { type: 'string', description: 'The diagnostic code, on a manual_review action.' },
              severity: { type: 'string', description: 'The diagnostic severity, on a manual_review action.' }
            }
          }
        }
      }
    }
  },
  {
    name: 'shadowgraph_backup',
    compact: false,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    describe: {
      does: 'Write a consistent snapshot of the whole store to a filesystem path on the server.',
      route: 'Take one before shadowgraph_purge or shadowgraph_restore; shadowgraph_redact shares data without writing a file.',
      effects: 'Overwrites any existing file at destination without warning, creates parent directories, and commits a revision.'
    },
    inputSchema: {
      type: 'object',
      required: ['destination'],
      properties: {
        destination: { type: 'string', description: 'Server-side path to write the snapshot to. Required. An existing file there is overwritten; parent directories are created. Use the storage backend’s own extension, .json for JSON stores and .db for SQLite.' }
      }
    },
    outputSchema: {
      type: 'object',
      description: 'Where the snapshot was taken from and written to.',
      required: ['source', 'destination'],
      properties: {
        source: { type: 'string', description: 'Path of the live store the snapshot was taken from.' },
        destination: { type: 'string', description: 'Path the snapshot was written to.' }
      }
    }
  },
  {
    name: 'shadowgraph_restore',
    compact: false,
    persists: false,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    describe: {
      does: 'Replace the entire live store with the contents of a JSON or SQLite backup.',
      route: 'Recovery only, never a merge: shadowgraph_purge removes one project, shadowgraph_backup makes the snapshot this reads.',
      effects: 'Destructive: every record and journal entry is replaced and a strictly greater revision installed. A failure is rolled back.'
    },
    inputSchema: {
      type: 'object',
      required: ['source'],
      properties: {
        source: { type: 'string', description: 'Server-side path of the backup to install. Required. It must match the configured storage backend: a JSON export cannot overwrite a SQLite database. The backup file itself is never rewritten.' }
      }
    },
    outputSchema: {
      type: 'object',
      description: 'What was restored from where. Fields beyond source and destination depend on the storage backend and on whether cleanup was confirmed.',
      required: ['source', 'destination'],
      properties: {
        source: { type: 'string', description: 'Path the backup was read from.' },
        destination: { type: 'string', description: 'Path of the store that was replaced.' },
        records: { type: 'integer', description: 'Records installed. JSON restores only.' },
        unchanged: { type: 'boolean', description: 'True when source and destination were the same path and nothing was replaced.' },
        retainedArtifacts: stringList('Rollback or recovery files still present after the restore.'),
        unknownArtifacts: { type: 'array', description: 'Artifact paths whose existence could not be determined, each { path, code }.' },
        artifactCleanup: { type: 'object', description: 'Cleanup outcome: status complete, incomplete, or unknown, plus any per-path errors.' },
        rollbackArtifact: { type: 'string', description: 'Retained rollback copy of the previous store, when one is left behind.' },
        recoveryArtifact: { type: 'string', description: 'Retained recovery copy, when one is left behind.' },
        temporaryArtifact: { type: 'string', description: 'Retained temporary file, when one is left behind.' }
      }
    }
  },
  {
    name: 'shadowgraph_verify_fact',
    requires: 'verifier',
    compact: false,
    persists: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    describe: {
      does: "Verify one active fact against a signed local evidence file, checked by the server's preconfigured Ed25519 trust store.",
      route: 'Advertised only with a verifier configured; shadowgraph_record_fact can never produce a verified fact.',
      effects: "Reads the caller's evidencePath inside the configured root. Bad evidence writes nothing; the same attestation again is a NOOP."
    },
    inputSchema: {
      type: 'object',
      required: ['factId', 'evidencePath'],
      additionalProperties: false,
      properties: {
        factId: { type: 'string', description: 'Identifier of the active fact to verify, as returned by shadowgraph_record_fact or shadowgraph_search.' },
        evidencePath: { type: 'string', description: 'Path to the signed attestation, which must resolve inside the verifier-configured evidence root. The signed digest binds the fact claim, verifier identity, evidence reference, method, and verification time.' }
      }
    },
    outputSchema: {
      type: 'object',
      description: 'The verification outcome and the resulting fact.',
      required: ['operation', 'fact'],
      properties: {
        operation: { type: 'string', enum: ['VERIFIED', 'NOOP'], description: 'VERIFIED when the attestation was accepted and applied, NOOP when the fact already carried the same verification.' },
        fact: factRecordSchema
      }
    }
  }
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export const COMPACT_TOOL_NAMES = Object.freeze(CATALOG.filter((entry) => entry.compact).map((entry) => entry.name));

// Two tools return a bare JSON array rather than an object. `structuredContent`
// must be an object for 2025-06-18 and 2025-11-25 clients, and the TypeScript
// SDK additionally requires outputSchema.type === "object", so wrapping them
// would be a result-shape change rather than a metadata change. They therefore
// declare no output schema and emit no structured content in any tier, and their
// descriptions carry the return shape instead. Recorded as backlog in
// docs/mcp-compatibility.md rather than fixed here.
export const OUTPUT_SCHEMA_OMISSIONS = Object.freeze({
  shadowgraph_review: 'Returns a bare JSON array of due decisions; an object-rooted output schema would require changing the result shape.',
  shadowgraph_review_signals: 'Returns a bare JSON array of review signals; an object-rooted output schema would require changing the result shape.'
});

export function buildToolCatalog({ verifier = false, embeddingConfigured = false } = {}) {
  return Object.freeze(CATALOG
    .filter((entry) => !entry.requires || (entry.requires === 'verifier' && verifier))
    .map((entry) => Object.freeze({
      name: entry.name,
      description: compose(entry.describe),
      describe: Object.freeze({ ...entry.describe }),
      inputSchema: entry.inputSchema,
      ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
      annotations: Object.freeze({
        ...entry.annotations,
        ...(entry.openWorldWhenEmbedding ? { openWorldHint: Boolean(embeddingConfigured) } : {})
      }),
      compact: entry.compact,
      persists: entry.persists
    })));
}

export function selectTools(catalog, { compact = false } = {}) {
  return Object.freeze(compact ? catalog.filter((entry) => entry.compact) : [...catalog]);
}

// The wire shape of one tool at a given tier. Key order is fixed so two
// processes with the same configuration emit byte-identical tools/list results.
export function projectTool(entry, tier) {
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    ...(tier >= METADATA_TIER.ANNOTATED ? { annotations: entry.annotations } : {}),
    ...(tier >= METADATA_TIER.STRUCTURED && entry.outputSchema ? { outputSchema: entry.outputSchema } : {})
  };
}

// The wire shape of one successful tool result. The serialized TextContent is
// always present and identical in every tier, so a session negotiated at
// 2024-11-05 receives the same `content` member, carrying the same text, that it
// received before structured content existed. `structuredContent` is added
// beside it, never in its place.
export function toolResult(entry, value, tier) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(tier >= METADATA_TIER.STRUCTURED && entry?.outputSchema ? { structuredContent: value } : {})
  };
}
