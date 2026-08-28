import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { stat as fsStat, unlink as fsUnlink } from 'node:fs/promises';
import { createStorage } from './storage.js';
import { createShadowGraph, isCommittedRejection, SOURCE_CLASSES, DECISION_STATUSES, OUTCOME_STATUSES, CONTENT_SEARCH_FIELDS, MEMORY_TYPES } from './shadowgraph.js';
import { createEmbeddingClient } from './embedding.js';
import { VERSION } from './version.js';
import { createRestoreValidator } from './restore-validation.js';
import { loadLocalEvidenceVerifier } from './verification.js';

const file = process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json';
const injectedRestoreFaultStages = process.env.NODE_ENV === 'test'
  ? new Set(String(process.env.SHADOWGRAPH_TEST_RESTORE_FAULT_STAGES ?? '').split(',').map((value) => value.trim()).filter(Boolean))
  : new Set();
function injectedRestoreFault(stage) {
  if (injectedRestoreFaultStages.has(stage)) throw new Error(`injected MCP restore fault at ${stage}`);
}
const injectedStatErrorSuffix = process.env.NODE_ENV === 'test'
  ? process.env.SHADOWGRAPH_TEST_RESTORE_STAT_ERROR_SUFFIX
  : undefined;
const injectedUnlinkErrorSuffix = process.env.NODE_ENV === 'test'
  ? process.env.SHADOWGRAPH_TEST_RESTORE_UNLINK_ERROR_SUFFIX
  : undefined;
const injectedRestoreFs = injectedStatErrorSuffix || injectedUnlinkErrorSuffix ? {
  ...(injectedStatErrorSuffix ? {
    async stat(path) {
      if (String(path).endsWith(injectedStatErrorSuffix)) {
        const error = new Error(`injected MCP restore stat fault for ${injectedStatErrorSuffix}`);
        error.code = process.env.SHADOWGRAPH_TEST_RESTORE_STAT_ERROR_CODE ?? 'EACCES';
        throw error;
      }
      return fsStat(path);
    }
  } : {}),
  ...(injectedUnlinkErrorSuffix ? {
    async unlink(path) {
      if (String(path).endsWith(injectedUnlinkErrorSuffix)) {
        const error = new Error(`injected MCP restore unlink fault for ${injectedUnlinkErrorSuffix}`);
        error.code = process.env.SHADOWGRAPH_TEST_RESTORE_UNLINK_ERROR_CODE ?? 'EACCES';
        throw error;
      }
      return fsUnlink(path);
    }
  } : {})
} : undefined;
const verifier = process.env.SHADOWGRAPH_VERIFIER_CONFIG
  ? await loadLocalEvidenceVerifier(process.env.SHADOWGRAPH_VERIFIER_CONFIG)
  : null;
const injectedClockFile = process.env.NODE_ENV === 'test'
  ? process.env.SHADOWGRAPH_TEST_CLOCK_FILE
  : undefined;
const injectedNow = injectedClockFile
  ? () => readFileSync(injectedClockFile, 'utf8').trim()
  : undefined;
const injectedSaveFaultFile = process.env.NODE_ENV === 'test'
  ? process.env.SHADOWGRAPH_TEST_SAVE_FAULT_FILE
  : undefined;
function injectedSaveFault(stage) {
  if (!injectedSaveFaultFile) return;
  if (readFileSync(injectedSaveFaultFile, 'utf8').trim() !== stage) return;
  writeFileSync(injectedSaveFaultFile, `triggered:${stage}`, 'utf8');
  throw new Error(`injected MCP persistence fault at ${stage}`);
}
const restoreValidator = createRestoreValidator({ verifier });
const store = await createStorage({ file, restoreValidator, restoreFault: injectedRestoreFault, saveFault: injectedSaveFault });
// P1-3: single source of truth — package.json via src/version.js.
const MCP_VERSION = VERSION;
// Dual-era protocol support: initialize selects the legacy contract, while
// per-request io.modelcontextprotocol metadata selects the modern contract.
const LEGACY_PROTOCOL_VERSION = '2024-11-05';
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION]);
const JSON_RPC_ERROR = Symbol('shadowgraph.jsonRpcError');
const PUBLIC_ERROR = Symbol('shadowgraph.publicError');
const graph = createShadowGraph({ verifier, ...(injectedNow ? { now: injectedNow } : {}) });
graph.importData(await store.load());
const embeddingClient = process.env.SHADOWGRAPH_EMBEDDING_URL ? createEmbeddingClient({
  baseUrl: process.env.SHADOWGRAPH_EMBEDDING_URL,
  model: process.env.SHADOWGRAPH_EMBEDDING_MODEL,
  apiKey: process.env.SHADOWGRAPH_EMBEDDING_API_KEY,
  allowRemote: process.env.SHADOWGRAPH_ALLOW_REMOTE_EMBEDDINGS === '1'
}) : null;
let persistQueue = Promise.resolve();
function persist() { const operation = persistQueue.then(async () => { const revision = await store.save(graph.exportData()); graph.setRevision(revision); }); persistQueue = operation.catch(() => {}); return operation; }
let callQueue = Promise.resolve();
function queueCall(operation) { const queued = callQueue.then(operation); callQueue = queued.catch(() => {}); return queued; }
let persistenceUnavailable = null;
const UNCONFIRMED_RECOVERY_CODES = new Set(['json_restore_recovery_unconfirmed', 'sqlite_restore_recovery_unconfirmed']);
function unavailableError() {
  const data = persistenceUnavailable.data
    ? structuredClone(persistenceUnavailable.data)
    : {
        recoveryCode: persistenceUnavailable.recoveryCode,
        retainedArtifacts: [...persistenceUnavailable.retainedArtifacts],
        ...(persistenceUnavailable.unknownArtifacts ? { unknownArtifacts: structuredClone(persistenceUnavailable.unknownArtifacts) } : {})
      };
  const recoveryCode = data.recoveryCode;
  const issueCode = data.issueCode;
  const publicData = {
    ...(PUBLIC_DOMAIN_CODES.has(issueCode) ? { issueCode } : {}),
    ...(PUBLIC_DOMAIN_CODES.has(recoveryCode) ? { recoveryCode } : {})
  };
  return applicationError(
    -32001,
    persistenceUnavailable.message ?? 'Persistent storage unavailable after unconfirmed restore recovery; restart required',
    data,
    'Persistent storage unavailable',
    Object.keys(publicData).length ? publicData : undefined
  );
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function isExpectedCommittedPayload(snapshot, durable) {
  if (!Number.isSafeInteger(snapshot?.revision) || durable?.revision !== snapshot.revision + 1) return false;
  return JSON.stringify(canonical({ ...durable, revision: snapshot.revision })) === JSON.stringify(canonical(snapshot));
}

function committedPersistenceError(persistenceError, durable, reconciliationError) {
  const data = {
    issueCode: 'committed_rejection_persistence_unconfirmed',
    expirationDurable: false,
    ...(Number.isSafeInteger(durable?.revision) ? { durableRevision: durable.revision } : {}),
    persistenceError: persistenceError?.message ?? 'durable read-back failed',
    ...(reconciliationError ? { reconciliationError: reconciliationError.message } : {})
  };
  persistenceUnavailable = {
    message: 'Committed expiration could not be confirmed durable; persistent storage unavailable until restart',
    data
  };
  return unavailableError();
}

async function persistCommittedRejection(rejection) {
  const committed = graph.exportData();
  let persistenceError = null;
  try { await persist(); }
  catch (error) { persistenceError = error; }

  let durable;
  try { durable = await store.load(); }
  catch (error) { throw committedPersistenceError(persistenceError ?? error, null, error); }

  if (isExpectedCommittedPayload(committed, durable)) {
    graph.replaceData(durable);
    throw rejection;
  }

  let reconciliationError = null;
  try { graph.replaceData(durable); }
  catch (error) { reconciliationError = error; }
  throw committedPersistenceError(persistenceError, durable, reconciliationError);
}

// Provenance properties shared by every write tool. `sourceClass` records WHAT WAS
// CLAIMED about origin — it is never proof and never produces a verified fact.
const provenanceProperties = {
  sourceClass: { type: 'string', enum: [...SOURCE_CLASSES], description: 'Claimed origin class. A claim, not proof: no value here can make a fact verified.' },
  actor: { type: 'string', description: 'Who performed this write, e.g. an agent name.' },
  client: { type: 'string', description: 'Which client performed this write.' },
  sessionId: { type: 'string', description: 'Session identifier for this write.' }
};
const pageProperties = {
  limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Page size. Omitted means a declared default, never silent truncation.' },
  offset: { type: 'integer', minimum: 0, description: 'Page offset.' }
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
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: {
        source: { type: 'string' },
        type: { type: 'string' },
        sourceClass: { type: 'string', enum: [...SOURCE_CLASSES] },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        observedAt: { type: 'string' },
        detail: { type: 'string' }
      },
      additionalProperties: true
    }
  ]
};
const memoryScopeProperty = {
  type: 'object',
  properties: {
    userId: nullableStringProperty,
    agentId: nullableStringProperty,
    runId: nullableStringProperty
  },
  additionalProperties: false
};
const embeddingProperty = { type: 'array', minItems: 1, items: { type: 'number' }, description: 'Optional caller-supplied vector. When omitted, the configured embedding provider is used.' };
const memoryProperties = {
  memoryType: { type: 'string', enum: [...MEMORY_TYPES] },
  key: { type: 'string' },
  text: { type: 'string' },
  scope: memoryScopeProperty,
  tags: { type: 'array', items: { type: 'string' } },
  metadata: { type: 'object' },
  validFrom: { type: 'string' },
  validTo: nullableStringProperty,
  embedding: embeddingProperty
};
const RESULT_ENVELOPE = 'Returns { items, page: { offset, limit, total, hasMore }, completeness } — completeness always declares what was omitted.';

const baseTools = [
  { name: 'shadowgraph_record_decision', description: 'Record a decision, its assumptions, evidence, and rejected alternatives.', inputSchema: { type: 'object', required: ['title', 'chosen'], properties: { title: { type: 'string' }, chosen: { type: 'string' }, project: { type: 'string' }, goal: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, assumptions: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: evidenceItemProperty }, alternatives: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, reasonRejected: { type: 'string' }, reason: { type: 'string' }, reopenWhen: { type: 'array' } } } }, idempotencyKey: { type: 'string', maxLength: 200, description: 'Retry key scoped by project and operation; reuse only for the same logical write.' }, ...provenanceProperties } } },
  { name: 'shadowgraph_record_attempt', description: 'Record a failed or informative attempt so the agent does not repeat it blindly.', inputSchema: { type: 'object', required: ['solution', 'result'], properties: { solution: { type: 'string' }, result: { type: 'string' }, project: { type: 'string' }, reason: { type: 'string' }, environment: { type: 'string' }, idempotencyKey: { type: 'string', maxLength: 200, description: 'Retry key scoped by project and operation; reuse only for the same logical write.' }, ...provenanceProperties } } },
  { name: 'shadowgraph_review', description: 'Find decisions whose rejected alternatives should be reconsidered. Evaluates reopenWhen rules against STORED facts, so it works after a restart without re-supplying them.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, changedFacts: { type: 'array', items: { type: 'string' } }, facts: { type: 'object', description: 'Optional overrides; these take precedence over stored facts.' } } } },
  { name: 'shadowgraph_search', description: `Search decision and attempt memory. A query term matches DECLARED CONTENT FIELDS only (${CONTENT_SEARCH_FIELDS.join(', ')}) — schema keys and internal metadata never match. ${RESULT_ENVELOPE}`, inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' }, status: { type: 'string', enum: [...DECISION_STATUSES] }, kind: { type: 'string', enum: ['decision', 'attempt'] }, sourceClass: { type: 'string', enum: [...SOURCE_CLASSES] }, minConfidence: { type: 'number', minimum: 0, maximum: 1 }, ...pageProperties } } },
  { name: 'shadowgraph_context', description: 'Build working context before a consequential task. Every collection declares its total in `completeness.collections`, so truncation is never silent.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000 }, changedFacts: { type: 'array', items: { type: 'string' } }, facts: { type: 'object' } } } },
  {
    name: 'shadowgraph_remember',
    description: 'Add or reconcile scoped user, agent, run, procedure, episode, or note memory without flattening decision records. Accepts one memory or an explicit ADD/UPDATE/DELETE/NOOP plan.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        ...memoryProperties,
        operations: { type: 'array', items: { type: 'object', required: ['action', 'memoryType', 'key'], properties: { action: { type: 'string', enum: ['ADD', 'UPDATE', 'DELETE', 'NOOP'] }, ...memoryProperties } } },
        ...provenanceProperties
      },
      oneOf: [{ required: ['memoryType', 'key', 'text'] }, { required: ['operations'] }]
    }
  },
  {
    name: 'shadowgraph_recall',
    description: `Explainable hybrid recall across decisions, facts, attempts, and scoped memories. Fuses lexical, optional vector, graph-distance, and temporal ranks and declares unavailable signals. ${RESULT_ENVELOPE}`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' }, scope: memoryScopeProperty, memoryType: { type: 'string', enum: [...MEMORY_TYPES] }, asOf: { type: 'string' }, focalId: { type: 'string' }, preferRecent: { type: 'boolean' }, queryEmbedding: embeddingProperty, ...pageProperties } }
  },
  { name: 'shadowgraph_record_fact', description: 'Record an observed fact with provenance. IMPORTANT: no input can mark a fact `verified` — a source label is a claim about origin, not proof.', inputSchema: { type: 'object', $defs: { jsonValue: jsonValueProperty }, required: ['key'], properties: { key: { type: 'string' }, value: jsonValueProperty, source: { type: 'string', description: 'Legacy alias for sourceClass. Unknown labels downgrade to agent_claimed with the raw label kept in sourceRaw.' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, project: { type: 'string' }, expiresAt: { type: 'string' }, verificationStatus: { type: 'string', enum: ['unverified', 'contradicted'], description: 'Only `contradicted` may be set by a caller; `verified` and `expired` are rejected.' }, idempotencyKey: { type: 'string', maxLength: 200, description: 'Retry key scoped by project and operation; reuse only for the same logical write.' }, ...provenanceProperties } } },
  { name: 'shadowgraph_record_outcome', description: 'Record what happened after a decision. Confidence moves by an evidence-weighted amount derived from the outcome\'s claimed source class; it never sets a verification status.', inputSchema: { type: 'object', required: ['decisionId', 'outcome'], properties: { decisionId: { type: 'string' }, outcome: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: [...OUTCOME_STATUSES] }, sourceClass: { type: 'string', enum: [...SOURCE_CLASSES] }, lessons: { type: 'array', items: { type: 'string' } }, observedAt: { type: 'string' } } } } } },
  { name: 'shadowgraph_confidence_evidence', description: 'Record evidence for or against a decision and move its confidence by a weighted, auditable amount. `key` is REQUIRED and must be stable: it is the dedupe key, so a retry with the same key is a no-op and cannot double-count.', inputSchema: { type: 'object', required: ['decisionId', 'reason', 'key'], properties: { decisionId: { type: 'string' }, reason: { type: 'string' }, supports: { type: 'boolean', description: 'Defaults to true. false records contradicting evidence.' }, key: { type: 'string', description: 'REQUIRED stable dedupe key. Reuse the same key for the same observation so retries do not double-count; use a NEW key for a genuinely new observation.' }, observedAt: { type: 'string' }, ...provenanceProperties } } },
  { name: 'shadowgraph_update_status', description: 'Move a decision through the explicit schema-5 lifecycle. stale and superseded are system-owned; archived is an explicit terminal disposition. Formatting variants like in-progress are accepted and stored canonically.', inputSchema: { type: 'object', required: ['decisionId', 'status'], properties: { decisionId: { type: 'string' }, status: { type: 'string', enum: [...DECISION_STATUSES] } } } },
  { name: 'shadowgraph_link', description: 'Create an explainable relationship between graph entities.', inputSchema: { type: 'object', required: ['from', 'to', 'relation'], properties: { from: { type: 'string' }, to: { type: 'string' }, relation: { type: 'string' } } } },
  { name: 'shadowgraph_traverse', description: 'Traverse related decisions, facts, attempts, and relationships.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, depth: { type: 'integer', minimum: 1, maximum: 10 }, direction: { type: 'string', enum: ['in', 'out', 'both'] }, relation: { type: 'string' } } } },
  { name: 'shadowgraph_supersede', description: 'Mark one decision superseded by a replacement decision in the same project.', inputSchema: { type: 'object', required: ['decisionId', 'replacementId'], properties: { decisionId: { type: 'string' }, replacementId: { type: 'string' } } } },
  { name: 'shadowgraph_redact', description: 'Return a redacted export without changing stored data. Redaction covers journal payloads too.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, patterns: { type: 'array', items: { type: 'string' } } } } },
  { name: 'shadowgraph_purge', description: 'Remove a project. Default mode `logical` keeps an auditable, payload-free journal skeleton. Mode `hard` physically deletes journal entries too, which creates a sequence gap that validate() reports.', inputSchema: { type: 'object', required: ['project'], properties: { project: { type: 'string' }, mode: { type: 'string', enum: ['logical', 'hard'], description: 'Defaults to logical. `hard` is irreversible and removes audit history.' } } } },
  { name: 'shadowgraph_maintain', description: 'Age due decisions, expire facts, and generate persistent review signals.', inputSchema: { type: 'object', properties: { now: { type: 'string' }, changedFacts: { type: 'array' }, facts: { type: 'object' } } } },
  { name: 'shadowgraph_retrieve', description: `Retrieve relevant records plus one-hop related graph context. ${RESULT_ENVELOPE}`, inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' }, status: { type: 'string', enum: [...DECISION_STATUSES] }, kind: { type: 'string', enum: ['decision', 'attempt'] }, minConfidence: { type: 'number', minimum: 0, maximum: 1 }, ...pageProperties } } },
  { name: 'shadowgraph_validate', description: 'Validate graph integrity without modifying storage. Issues carry a severity: error (invalid data), legacy (readable but pre-contract), unsupported (newer schema), info.', inputSchema: { type: 'object' } },
  { name: 'shadowgraph_journal', description: `Read the append-oriented journal of complete post-operation snapshots. ${RESULT_ENVELOPE} completeness.gaps lists sequence gaps left by hard purges.`, inputSchema: { type: 'object', properties: { project: { type: 'string' }, ...pageProperties } } },
  { name: 'shadowgraph_rebuild', description: 'Rebuild a projection from the journal alone and report whether it was complete. Returns rebuildable:false with a reason rather than a silently partial graph.', inputSchema: { type: 'object', properties: { requireFullHistory: { type: 'boolean', description: 'When true, refuse to rebuild if pre-journal metadata-only entries exist.' } } } },
  { name: 'shadowgraph_review_signals', description: 'List persistent review signals.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, status: { type: 'string', enum: ['open', 'acknowledged'] } } } },
  { name: 'shadowgraph_purge_preview', description: 'Preview project deletion counts without modifying storage.', inputSchema: { type: 'object', required: ['project'], properties: { project: { type: 'string' } } } },
  { name: 'shadowgraph_ack_review', description: 'Acknowledge one persistent review signal.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'shadowgraph_repair_plan', description: 'Return a non-destructive graph repair plan. Never mutates data.', inputSchema: { type: 'object' } },
  { name: 'shadowgraph_backup', description: 'Create a consistent backup snapshot at a destination path.', inputSchema: { type: 'object', required: ['destination'], properties: { destination: { type: 'string' } } } },
  { name: 'shadowgraph_restore', description: 'Restore a JSON or SQLite backup using the configured storage backend.', inputSchema: { type: 'object', required: ['source'], properties: { source: { type: 'string' } } } }
];
const verificationTool = {
  name: 'shadowgraph_verify_fact',
  description: 'Verify an active fact using a signed local evidence file checked by the server\'s separately preconfigured Ed25519 trust store. The caller cannot supply verifier identity, key, signature, method, or verified status.',
  inputSchema: {
    type: 'object',
    required: ['factId', 'evidencePath'],
    additionalProperties: false,
    properties: {
      factId: { type: 'string' },
      evidencePath: { type: 'string', description: 'Path inside the verifier-configured evidence root.' }
    }
  }
};
const allTools = verifier ? [...baseTools, verificationTool] : baseTools;
const compactNames = new Set(['shadowgraph_context','shadowgraph_remember','shadowgraph_recall','shadowgraph_record_decision','shadowgraph_record_attempt','shadowgraph_record_fact','shadowgraph_record_outcome','shadowgraph_retrieve','shadowgraph_search','shadowgraph_review','shadowgraph_validate','shadowgraph_maintain']);
const tools = process.env.SHADOWGRAPH_MCP_COMPACT === '1' ? allTools.filter((tool) => compactNames.has(tool.name)) : allTools;

async function addConfiguredEmbeddings(args = {}) {
  if (!embeddingClient) return args;
  if (Array.isArray(args.operations)) {
    const operations = [];
    for (const operation of args.operations) {
      const needsEmbedding = ['ADD', 'UPDATE'].includes(String(operation.action ?? '').toUpperCase()) && !operation.embedding && typeof operation.text === 'string' && operation.text.trim();
      operations.push(needsEmbedding ? { ...operation, embedding: await embeddingClient(operation.text) } : operation);
    }
    return { ...args, operations };
  }
  return !args.embedding && typeof args.text === 'string' && args.text.trim()
    ? { ...args, embedding: await embeddingClient(args.text) }
    : args;
}

async function callUnqueued(name, args) {
  if (persistenceUnavailable) throw unavailableError();
  const before = graph.exportData();
  let value;
  try {
  if (name === 'shadowgraph_record_decision') value = graph.addDecision(args);
  else if (name === 'shadowgraph_record_attempt') value = graph.addAttempt(args);
  else if (name === 'shadowgraph_review') value = graph.review(args ?? {});
  else if (name === 'shadowgraph_search') value = graph.search(args?.query ?? '', args ?? {});
  else if (name === 'shadowgraph_context') value = graph.context(args ?? {});
  else if (name === 'shadowgraph_remember') {
    const prepared = await addConfiguredEmbeddings(args ?? {});
    value = Array.isArray(prepared.operations) ? graph.applyMemoryPlan(prepared) : graph.remember(prepared);
  }
  else if (name === 'shadowgraph_recall') {
    const query = args?.query ?? '';
    let prepared = args ?? {};
    let embeddingFailure = null;
    if (embeddingClient && !args?.queryEmbedding && String(query).trim()) {
      try { prepared = { ...(args ?? {}), queryEmbedding: await embeddingClient(String(query)) }; }
      catch (error) { embeddingFailure = `Configured embedding provider failed: ${error.message}`; }
    }
    value = graph.recall(query, prepared);
    if (embeddingFailure) value.signals.semantic = { ...value.signals.semantic, available: false, matched: 0, reason: embeddingFailure };
  }
  else if (name === 'shadowgraph_record_fact') value = graph.addFact(args);
  else if (name === 'shadowgraph_verify_fact' && verifier) value = await graph.verifyFact(args ?? {});
  else if (name === 'shadowgraph_record_outcome') value = graph.setOutcome(args?.decisionId, args?.outcome);
  else if (name === 'shadowgraph_confidence_evidence') value = graph.addConfidenceEvidence(args ?? {});
  else if (name === 'shadowgraph_update_status') value = graph.updateDecisionStatus(args?.decisionId, args?.status);
  else if (name === 'shadowgraph_link') value = graph.link(args);
  else if (name === 'shadowgraph_traverse') value = graph.traverse(args ?? {});
  else if (name === 'shadowgraph_supersede') value = graph.supersedeDecision(args ?? {});
  else if (name === 'shadowgraph_redact') value = graph.redact(args ?? {});
  else if (name === 'shadowgraph_purge') value = graph.purgeProject(args?.project, { mode: args?.mode });
  else if (name === 'shadowgraph_maintain') value = graph.maintain(args ?? {});
  else if (name === 'shadowgraph_retrieve') value = graph.retrieve(args?.query ?? '', args ?? {});
  else if (name === 'shadowgraph_validate') value = graph.validate();
  else if (name === 'shadowgraph_journal') value = graph.getJournal(args ?? {});
  else if (name === 'shadowgraph_rebuild') value = graph.rebuild(args ?? {});
  else if (name === 'shadowgraph_review_signals') value = graph.getReviewSignals(args ?? {});
  else if (name === 'shadowgraph_purge_preview') value = graph.projectSummary(args?.project);
  else if (name === 'shadowgraph_ack_review') value = graph.acknowledgeReview(args?.id);
  else if (name === 'shadowgraph_repair_plan') value = graph.repairPlan();
  else if (name === 'shadowgraph_backup') { const { backupFile } = await import('./backup.js'); value = await backupFile(file, args?.destination, { store }); }
  else if (name === 'shadowgraph_restore') {
    value = store.restore
      ? await store.restore(args?.source, { validate: restoreValidator, afterReplace: (payload) => graph.replaceData(payload) })
      : await (await import('./backup.js')).restoreFile(args?.source, file, {
        storage: process.env.SHADOWGRAPH_STORAGE,
        validate: restoreValidator,
        restoreFs: injectedRestoreFs,
        restoreFault: injectedRestoreFault,
        afterReplace: (payload) => graph.replaceData(payload)
      });
  }
  else if (!name) { const error = new Error('Invalid tool parameters'); error.code = -32602; throw error; }
  else { const error = new Error('Unknown tool'); error.code = -32601; throw error; }
  } catch (error) {
    if (isCommittedRejection(error)) {
      return persistCommittedRejection(error);
    }
    // P1-4: persistence rollback is too late for a domain operation that mutates
    // and then throws. Restore the snapshot while this call still owns the global
    // queue, so a later serialized write cannot persist the rejected mutation.
    if (UNCONFIRMED_RECOVERY_CODES.has(error.code)) {
      persistenceUnavailable = {
        recoveryCode: error.code,
        retainedArtifacts: [...(error.retainedArtifacts ?? [])],
        ...(error.unknownArtifacts ? { unknownArtifacts: structuredClone(error.unknownArtifacts) } : {})
      };
      error.data = {
        recoveryCode: error.code,
        retainedArtifacts: [...(error.retainedArtifacts ?? [])],
        ...(error.unknownArtifacts ? { unknownArtifacts: structuredClone(error.unknownArtifacts) } : {})
      };
      error.code = -32000;
    } else if (error.artifactCleanup) {
      error.data = {
        retainedArtifacts: [...(error.retainedArtifacts ?? [])],
        unknownArtifacts: structuredClone(error.unknownArtifacts ?? []),
        artifactCleanup: structuredClone(error.artifactCleanup)
      };
    } else if (typeof error.code === 'string') {
      error.data = { ...(error.data ?? {}), issueCode: error.code };
      error.code = -32000;
    }
    // Install the fail-closed latch before restoring the in-memory snapshot, so
    // no later graph call can enter if snapshot restoration itself ever fails.
    graph.replaceData(before);
    throw error;
  }
  if (name.includes('record_') || name === 'shadowgraph_verify_fact' || name === 'shadowgraph_context' || name === 'shadowgraph_remember' || name === 'shadowgraph_confidence_evidence' || name === 'shadowgraph_update_status' || name === 'shadowgraph_link' || name === 'shadowgraph_supersede' || name === 'shadowgraph_purge' || name === 'shadowgraph_maintain' || name === 'shadowgraph_review' || name === 'shadowgraph_ack_review' || name === 'shadowgraph_backup') {
    try { await persist(); }
    catch (error) {
      try { graph.replaceData(await store.load()); }
      catch { graph.replaceData(before); }
      throw error;
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function call(name, args) { return queueCall(() => callUnqueued(name, args)); }

// The single resource and prompt this server actually serves. Requests for
// anything else are errors, not silent substitutions (P1-7).
const RESOURCE_URIS = new Set(['shadowgraph://context']);
const PROMPT_NAMES = new Set(['shadowgraph_consequential_task']);
const SERVER_INFO = Object.freeze({ name: 'shadowgraph', version: MCP_VERSION });
const SERVER_CAPABILITIES = Object.freeze({
  tools: Object.freeze({ listChanged: false }),
  resources: Object.freeze({ listChanged: false, subscribe: false }),
  prompts: Object.freeze({ listChanged: false })
});
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';

const PUBLIC_PROTOCOL_MESSAGES = new Set([
  'Parse error',
  'Invalid Request',
  'Invalid Request: jsonrpc must be 2.0',
  'Invalid Request: method must be a string',
  'Method not found',
  'Unknown tool',
  'Unknown resource URI',
  'Unknown prompt',
  'Unsupported protocol version',
  'Invalid params: params must be an object',
  'Invalid params: modern requests require params._meta',
  `Invalid params: _meta.${PROTOCOL_VERSION_META} must be a string`,
  `Invalid params: _meta.${CLIENT_INFO_META} requires name and version strings when present`,
  `Invalid params: _meta.${CLIENT_CAPABILITIES_META} must be an object`,
  'Invalid params: protocolVersion must be a string',
  'Invalid params: clientInfo requires name and version strings when present',
  'Invalid params: capabilities must be an object when present',
  'Invalid params: uri is required',
  'Invalid params: name is required',
  'Invalid params: params is required for tools/call',
  'Invalid params: name is required for tools/call',
  'Invalid params: arguments must be an object'
]);
const PUBLIC_RPC_FALLBACK_MESSAGES = new Map([
  [-32700, 'Parse error'],
  [-32600, 'Invalid Request'],
  [-32601, 'Method not found'],
  [-32602, 'Invalid params'],
  [-32022, 'Unsupported protocol version']
]);
// Only stable codes documented by the storage/journal contracts cross the MCP
// boundary. In particular, platform codes such as ENOENT/EACCES are private.
const PUBLIC_DOMAIN_CODES = new Set([
  'committed_rejection_persistence_unconfirmed',
  'duplicate_hard_purge_ledger_sequence',
  'duplicate_journal_sequence',
  'hard_purge_ledger_not_array',
  'invalid_hard_purge_ledger_sequence',
  'invalid_journal_sequence',
  'invalid_projection_baseline_placement',
  'json_restore_recovery_unconfirmed',
  'json_restore_rolled_back',
  'multiply_claimed_hard_purge_ledger_sequence',
  'noncanonical_schema5_purge_artifact',
  'noncausal_hard_purge_ledger_sequence',
  'persistence_unavailable',
  'revision_overflow',
  'sqlite_restore_recovery_unconfirmed',
  'sqlite_restore_rolled_back',
  'sqlite_save_compaction_unconfirmed',
  'storage_lock_reentrant',
  'storage_lock_timeout',
  'unexplained_journal_gap',
  'unrelated_hard_purge_ledger_sequence',
  'unsupported_schema_version'
]);
const PUBLIC_DOMAIN_MESSAGES = new Set([
  'A caller cannot set fact verificationStatus to verified',
  'A caller cannot set fact verificationStatus to expired',
  'Invalid fact verificationStatus',
  'Purge mode must be logical or hard',
  'Outcome status must be successful, mixed, failed, or unknown',
  'Decision not found'
]);
const PUBLIC_ERROR_NAME_MESSAGES = new Map([
  ['RevisionConflictError', 'Storage revision conflict']
]);

function tagPublicError(error, message, data) {
  error[PUBLIC_ERROR] = Object.freeze({
    message,
    ...(data === undefined ? {} : { data: structuredClone(data) })
  });
  return error;
}

function publicRpcData(code, data) {
  if (code !== -32022 || !Array.isArray(data?.supported)) return undefined;
  const supported = data.supported.filter((version) => SUPPORTED_PROTOCOL_VERSIONS.includes(version));
  if (!supported.length) return undefined;
  const requested = typeof data.requested === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(data.requested)
    ? data.requested
    : undefined;
  return {
    supported,
    ...(requested === undefined ? {} : { requested })
  };
}

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = code;
  error[JSON_RPC_ERROR] = true;
  if (data !== undefined) error.data = data;
  const publicMessage = PUBLIC_PROTOCOL_MESSAGES.has(message)
    ? message
    : PUBLIC_RPC_FALLBACK_MESSAGES.get(code);
  return publicMessage
    ? tagPublicError(error, publicMessage, publicRpcData(code, data))
    : error;
}

function applicationError(code, message, data, publicMessage, publicData) {
  const error = new Error(message);
  error.code = code;
  if (data !== undefined) error.data = data;
  return tagPublicError(error, publicMessage, publicData);
}

function isRpcError(error) {
  return error?.[JSON_RPC_ERROR] === true;
}

function publicDomainCode(error) {
  for (const candidate of [error?.code, error?.data?.issueCode, error?.data?.recoveryCode]) {
    if (PUBLIC_DOMAIN_CODES.has(candidate)) return candidate;
  }
  return null;
}

function publicErrorDetails(error) {
  const tagged = error?.[PUBLIC_ERROR];
  if (tagged) return tagged;

  const issueCode = publicDomainCode(error);
  if (issueCode) {
    return {
      message: `Tool execution failed (${issueCode})`,
      data: {
        issueCode,
        ...(error?.data?.recoveryCode === issueCode ? { recoveryCode: issueCode } : {})
      }
    };
  }
  if (error instanceof SyntaxError) return { message: 'Tool execution failed: invalid JSON data' };
  const namedMessage = PUBLIC_ERROR_NAME_MESSAGES.get(error?.name);
  if (namedMessage) return { message: namedMessage };
  if (PUBLIC_DOMAIN_MESSAGES.has(error?.message)) return { message: error.message };
  return { message: 'Tool execution failed' };
}

function publicErrorMessage(error) {
  return publicErrorDetails(error).message;
}

function reply(id, result, error) {
  const errorCode = Number.isFinite(error?.code) && Number.isInteger(error.code)
    ? error.code
    : -32000;
  const publicFailure = error ? publicErrorDetails(error) : null;
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: id ?? null,
    ...(error ? { error: {
      code: errorCode,
      message: publicFailure.message,
      ...(publicFailure.data === undefined ? {} : { data: publicFailure.data })
    } } : { result })
  }) + '\n');
}

function requestUsesModernProtocol(request) {
  if (request.method === 'initialize') return false;
  const meta = request.params?._meta;
  const attempted = request.method === 'server/discover'
    || (meta && typeof meta === 'object' && [PROTOCOL_VERSION_META, CLIENT_INFO_META, CLIENT_CAPABILITIES_META].some((key) => Object.hasOwn(meta, key)));
  if (!attempted) return false;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw rpcError(-32602, 'Invalid params: modern requests require params._meta');
  const protocolVersion = meta[PROTOCOL_VERSION_META];
  if (typeof protocolVersion !== 'string' || !protocolVersion) throw rpcError(-32602, `Invalid params: _meta.${PROTOCOL_VERSION_META} must be a string`);
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion) || protocolVersion !== MODERN_PROTOCOL_VERSION) {
    throw rpcError(-32022, 'Unsupported protocol version', { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: protocolVersion });
  }
  const clientInfo = meta[CLIENT_INFO_META];
  if (clientInfo !== undefined && (!clientInfo || typeof clientInfo !== 'object' || Array.isArray(clientInfo) || typeof clientInfo.name !== 'string' || !clientInfo.name || typeof clientInfo.version !== 'string' || !clientInfo.version)) {
    throw rpcError(-32602, `Invalid params: _meta.${CLIENT_INFO_META} requires name and version strings when present`);
  }
  const capabilities = meta[CLIENT_CAPABILITIES_META];
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw rpcError(-32602, `Invalid params: _meta.${CLIENT_CAPABILITIES_META} must be an object`);
  }
  return true;
}

function modernResult(result, cacheScope) {
  return {
    resultType: 'complete',
    ...result,
    ...(cacheScope ? { ttlMs: 0, cacheScope } : {}),
    _meta: { ...(result?._meta ?? {}), [SERVER_INFO_META]: SERVER_INFO }
  };
}

function eraResult(modern, result, cacheScope) {
  return modern ? modernResult(result, cacheScope) : result;
}

const resourceList = [{ uri: 'shadowgraph://context', name: 'ShadowGraph context', description: 'Current project context and open review signals.', mimeType: 'application/json' }];
const promptList = [{ name: 'shadowgraph_consequential_task', description: 'Use ShadowGraph before, during, and after consequential work.', arguments: [] }];
const promptText = verifier
  ? 'Before consequential work call context and retrieve. Record decisions, assumptions, evidence, alternatives, failed attempts, facts, and outcomes. Review open signals before continuing. Treat agent_claimed and unverified facts as hypotheses. Only the separately configured signed local-evidence verifier can mark an active fact verified.'
  : 'Before consequential work call context and retrieve. Record decisions, assumptions, evidence, alternatives, failed attempts, facts, and outcomes. Review open signals before continuing. Treat agent_claimed and unverified facts as hypotheses: without a separately configured verifier, nothing in ShadowGraph can be marked verified, so never present a stored claim as confirmed.';

const input = createInterface({ input: process.stdin });
input.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  // P1-6: a JSON-RPC NOTIFICATION has no `id` member and MUST NOT be answered.
  // The old code fell through to `reply(request.id, {})` for any unrecognised
  // method, emitting `{"id": null, "result": {}}` for notifications — a protocol
  // violation that a strict client can treat as a spurious response.
  let isNotification = false;
  try {
    request = JSON.parse(line);
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw rpcError(-32600, 'Invalid Request');
    if (request.jsonrpc !== '2.0') throw rpcError(-32600, 'Invalid Request: jsonrpc must be 2.0');
    if (typeof request.method !== 'string') throw rpcError(-32600, 'Invalid Request: method must be a string');
    // Only a syntactically valid Request object with no id is a notification.
    // Parse errors and malformed request envelopes still receive id:null errors.
    isNotification = !Object.prototype.hasOwnProperty.call(request, 'id');
    if (request.params !== undefined && (typeof request.params !== 'object' || request.params === null || Array.isArray(request.params))) {
      throw rpcError(-32602, 'Invalid params: params must be an object');
    }
    const respond = (result, error) => {
      if (!isNotification) reply(request.id, result, error);
    };
    const modern = requestUsesModernProtocol(request);

    if (persistenceUnavailable && request.method === 'resources/read') throw unavailableError();

    if (request.method === 'initialize') {
      // Legacy 2024-11-05 handshake. A client may ask for a different revision;
      // per that spec the server answers with the version it actually implements
      // rather than echoing a version it does not support.
      const requested = request.params?.protocolVersion;
      if (requested !== undefined && typeof requested !== 'string') throw rpcError(-32602, 'Invalid params: protocolVersion must be a string');
      const clientInfo = request.params?.clientInfo;
      if (clientInfo !== undefined && (!clientInfo || typeof clientInfo !== 'object' || Array.isArray(clientInfo) || typeof clientInfo.name !== 'string' || !clientInfo.name || typeof clientInfo.version !== 'string' || !clientInfo.version)) {
        throw rpcError(-32602, 'Invalid params: clientInfo requires name and version strings when present');
      }
      const capabilities = request.params?.capabilities;
      if (capabilities !== undefined && (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities))) {
        throw rpcError(-32602, 'Invalid params: capabilities must be an object when present');
      }
      respond({ protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: SERVER_CAPABILITIES, serverInfo: SERVER_INFO });
    } else if (request.method.startsWith('notifications/')) {
      // Method names do not define notifications; absence of id does. A client
      // that explicitly supplies id:null sent a request and still gets a reply.
      if (isNotification) return;
      respond({});
    } else if (request.method === 'server/discover') {
      respond(modernResult({
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        capabilities: SERVER_CAPABILITIES,
        instructions: 'Local-first explainable decision and scoped temporal memory. Use context/retrieve before consequential work and record outcomes afterward.'
      }, 'public'));
    } else if (request.method === 'tools/list') respond(eraResult(modern, { tools }, 'public'));
    else if (request.method === 'resources/list') respond(eraResult(modern, { resources: resourceList }, 'public'));
    else if (request.method === 'resources/read') {
      // P1-7: an unknown URI used to receive the real context payload anyway,
      // which told the client its request had succeeded when it had not.
      const uri = request.params?.uri;
      if (typeof uri !== 'string' || !uri) throw rpcError(-32602, 'Invalid params: uri is required');
      if (!RESOURCE_URIS.has(uri)) throw rpcError(-32602, 'Unknown resource URI');
      const context = await queueCall(async () => {
        const before = graph.exportData();
        let value;
        try { value = graph.context({}); }
        catch (error) { graph.replaceData(before); throw error; }
        try { await persist(); }
        catch (error) {
          try { graph.replaceData(await store.load()); }
          catch { graph.replaceData(before); }
          throw error;
        }
        return value;
      });
      respond(eraResult(modern, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(context) }] }, 'private'));
    } else if (request.method === 'prompts/list') respond(eraResult(modern, { prompts: promptList }, 'public'));
    else if (request.method === 'prompts/get') {
      // P1-7: same failure as resources/read — any name returned the policy text.
      const promptName = request.params?.name;
      if (typeof promptName !== 'string' || !promptName) throw rpcError(-32602, 'Invalid params: name is required');
      if (!PROMPT_NAMES.has(promptName)) throw rpcError(-32602, 'Unknown prompt');
      respond(eraResult(modern, { description: 'ShadowGraph operating policy', messages: [{ role: 'user', content: { type: 'text', text: promptText } }] }));
    } else if (request.method === 'tools/call') {
      if (request.params === undefined) throw rpcError(-32602, 'Invalid params: params is required for tools/call');
      if (typeof request.params.name !== 'string' || !request.params.name) throw rpcError(-32602, 'Invalid params: name is required for tools/call');
      const args = request.params.arguments ?? {};
      if (typeof args !== 'object' || args === null || Array.isArray(args)) throw rpcError(-32602, 'Invalid params: arguments must be an object');
      if (!tools.some((tool) => tool.name === request.params.name)) {
        throw rpcError(modern ? -32602 : -32601, 'Unknown tool');
      }
      try {
        const result = await call(request.params.name, args);
        respond(eraResult(modern, modern ? { ...result, isError: false } : result));
      } catch (error) {
        if (!modern || isRpcError(error)) throw error;
        respond(modernResult({ content: [{ type: 'text', text: publicErrorMessage(error) }], isError: true }));
      }
    } else throw rpcError(-32601, 'Method not found');
  } catch (error) {
    // P1-5: PRESERVE error.code. The old catch rebuilt a plain object and
    // hardcoded -32000, so the -32601/-32602 codes that `call()` raises were
    // flattened and a client could not distinguish "no such tool" from a genuine
    // internal failure.
    if (isNotification) return;
    const parseError = request === undefined && error instanceof SyntaxError;
    reply(request?.id ?? null, null, parseError
      ? rpcError(-32700, 'Parse error')
      : error);
  }
});
