import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { stat as fsStat, unlink as fsUnlink } from 'node:fs/promises';
import { createStorage } from './storage.js';
import { createShadowGraph, isCommittedRejection } from './shadowgraph.js';
import { createEmbeddingClient } from './embedding.js';
import { VERSION } from './version.js';
import { createRestoreValidator } from './restore-validation.js';
import { loadLocalEvidenceVerifier } from './verification.js';
import { BATCH_PROTOCOL_VERSIONS, LEGACY_PROTOCOL_VERSIONS, METADATA_TIER, buildToolCatalog, metadataTierForProtocolVersion, negotiateLegacyProtocolVersion, projectTool, selectTools, toolResult } from './mcp-tools.js';

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
// Dual-era protocol support: `initialize` negotiates one of the handshake
// revisions in LEGACY_PROTOCOL_VERSIONS, while per-request
// io.modelcontextprotocol metadata selects the modern contract. Newest first,
// modern ahead of the handshake revisions.
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS]);
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

// Tool metadata — names, descriptions, input/output schemas, behavioural
// annotations, compact membership, and which tools persist — lives in ONE place,
// src/mcp-tools.js. The advertised list, the unknown-tool guard, and the
// post-call persistence decision are all derived from it here, so the three
// cannot drift apart the way three hand-maintained string lists could.
const toolCatalog = buildToolCatalog({
  verifier: Boolean(verifier),
  embeddingConfigured: Boolean(process.env.SHADOWGRAPH_EMBEDDING_URL)
});
const tools = selectTools(toolCatalog, { compact: process.env.SHADOWGRAPH_MCP_COMPACT === '1' });
const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
const persistingTools = new Set(tools.filter((tool) => tool.persists).map((tool) => tool.name));
// One frozen projection per capability tier, built once. tools/list is answered
// from these, so two calls in a session — and two processes with the same
// configuration — return byte-identical bytes.
const toolLists = Object.freeze([METADATA_TIER.BARE, METADATA_TIER.ANNOTATED, METADATA_TIER.STRUCTURED]
  .map((tier) => Object.freeze(tools.map((tool) => projectTool(tool, tier)))));
// Capability tier of the current handshake session, derived ONLY from the
// revision `initialize` NEGOTIATED, never from the one the client asked for: a
// requested version is a preference, and only the returned one is agreed. Until
// initialize arrives, and in a session negotiated at 2024-11-05, the wire shape
// carries exactly the members that revision defines. A later initialize
// renegotiates and replaces both of these.
let legacyTier = METADATA_TIER.BARE;
// JSON-RPC batches are accepted only in a session negotiated at a revision whose
// base protocol requires them. 2025-03-26 is the only such revision: 2024-11-05
// never defined batching and 2025-06-18 removed it.
let batchesAccepted = false;

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

async function callUnqueued(name, args, tier) {
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
  // Which tools need a durable save is declared once, per tool, in the catalog.
  // shadowgraph_restore is deliberately absent: the storage backend commits the
  // replacement itself. See src/mcp-tools.js.
  if (persistingTools.has(name)) {
    try { await persist(); }
    catch (error) {
      try { graph.replaceData(await store.load()); }
      catch { graph.replaceData(before); }
      throw error;
    }
  }
  return toolResult(toolsByName.get(name), value, tier);
}

function call(name, args, tier) { return queueCall(() => callUnqueued(name, args, tier)); }

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
  'Invalid params: protocolVersion must be a non-empty string',
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

// The wire shape of one JSON-RPC response. Building it separately from writing
// it is what lets a batch collect several before one write; the object literal
// and its key order are unchanged, so a single response is serialized exactly as
// it was before batching existed.
function responseFor(id, result, error) {
  const errorCode = Number.isFinite(error?.code) && Number.isInteger(error.code)
    ? error.code
    : -32000;
  const publicFailure = error ? publicErrorDetails(error) : null;
  return {
    jsonrpc: '2.0', id: id ?? null,
    ...(error ? { error: {
      code: errorCode,
      message: publicFailure.message,
      ...(publicFailure.data === undefined ? {} : { data: publicFailure.data })
    } } : { result })
  };
}

function writeLine(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
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
  // Only the modern revision is usable per request. The handshake revisions are
  // negotiated through `initialize` and appear in `supported` so a client can
  // see everything this server implements.
  if (protocolVersion !== MODERN_PROTOCOL_VERSION) {
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

// Handles one already-parsed JSON-RPC message. `emit` receives the response
// object exactly once for a request and never for a notification, so a single
// line can write its response straight out while a batch collects several.
//
// P1-6: a JSON-RPC NOTIFICATION has no `id` member and MUST NOT be answered.
// The old code fell through to `reply(request.id, {})` for any unrecognised
// method, emitting `{"id": null, "result": {}}` for notifications — a protocol
// violation that a strict client can treat as a spurious response.
async function handleMessage(request, emit) {
  let isNotification = false;
  try {
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
      if (!isNotification) emit(responseFor(request.id, result, error));
    };
    const modern = requestUsesModernProtocol(request);

    if (persistenceUnavailable && request.method === 'resources/read') throw unavailableError();

    if (request.method === 'initialize') {
      // Handshake negotiation. `protocolVersion` is a required string in every
      // revision of InitializeRequest, so a missing, non-string, or empty value
      // is invalid params rather than something to guess a revision from.
      const requested = request.params?.protocolVersion;
      if (typeof requested !== 'string' || !requested) throw rpcError(-32602, 'Invalid params: protocolVersion must be a non-empty string');
      const clientInfo = request.params?.clientInfo;
      if (clientInfo !== undefined && (!clientInfo || typeof clientInfo !== 'object' || Array.isArray(clientInfo) || typeof clientInfo.name !== 'string' || !clientInfo.name || typeof clientInfo.version !== 'string' || !clientInfo.version)) {
        throw rpcError(-32602, 'Invalid params: clientInfo requires name and version strings when present');
      }
      const capabilities = request.params?.capabilities;
      if (capabilities !== undefined && (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities))) {
        throw rpcError(-32602, 'Invalid params: capabilities must be an object when present');
      }
      // Every check above runs first, so a rejected handshake leaves the session
      // exactly as it was. The revision this server answers with — the requested
      // one when implemented, otherwise the latest it implements — is what selects
      // the optional tool metadata and whether batches are accepted. The requested
      // value selects nothing on its own.
      const negotiated = negotiateLegacyProtocolVersion(requested);
      // A handshake is an exchange. An initialize with no id is a notification:
      // it receives no response, so the client never learns what was agreed and
      // nothing was agreed. Changing what this session emits on the strength of
      // it would let a message that negotiated nothing silently downgrade a
      // session that had, so the state is left exactly as it was.
      if (!isNotification) {
        legacyTier = metadataTierForProtocolVersion(negotiated);
        batchesAccepted = BATCH_PROTOCOL_VERSIONS.includes(negotiated);
      }
      respond({ protocolVersion: negotiated, capabilities: SERVER_CAPABILITIES, serverInfo: SERVER_INFO });
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
    } else if (request.method === 'tools/list') respond(eraResult(modern, { tools: toolLists[modern ? METADATA_TIER.STRUCTURED : legacyTier] }, 'public'));
    else if (request.method === 'resources/list') respond(eraResult(modern, { resources: resourceList }, 'public'));
    else if (request.method === 'resources/read') {
      // P1-7: an unknown URI used to receive the real context payload anyway,
      // which told the client its request had succeeded when it had not.
      const uri = request.params?.uri;
      if (typeof uri !== 'string' || !uri) throw rpcError(-32602, 'Invalid params: uri is required');
      if (!RESOURCE_URIS.has(uri)) throw rpcError(-32602, 'Unknown resource URI');
      const context = await queueCall(async () => {
        // Recheck inside the queue, before touching the graph. The check above
        // runs while the request is being dispatched, and a restore that
        // degrades the server may still have been in flight then — in one batch
        // both are dispatched together, so both clear that check before either
        // runs. Only here has the restore necessarily finished, which is what
        // makes the latch closed rather than merely early. callUnqueued does the
        // same for tools/call.
        if (persistenceUnavailable) throw unavailableError();
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
      if (!toolsByName.has(request.params.name)) {
        throw rpcError(modern ? -32602 : -32601, 'Unknown tool');
      }
      try {
        // Structured content is emitted only in a session negotiated at a
        // revision that defines it, or to a modern `_meta` request, and only for
        // a tool that advertises an output schema at that tier. A failed call
        // stays content-only.
        const result = await call(request.params.name, args, modern ? METADATA_TIER.STRUCTURED : legacyTier);
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
    emit(responseFor(request?.id ?? null, null, error));
  }
}

// 2025-03-26 base protocol: "MCP implementations MAY support sending JSON-RPC
// batches, but MUST support receiving JSON-RPC batches." The responses for
// members that carry an id are written as one array in member order; a batch of
// notifications alone writes nothing.
//
// Members are dispatched synchronously, in order, rather than awaited one at a
// time. Awaiting between them would return to the readline callback mid-batch,
// and readline delivers every line of one stdin chunk synchronously, so a
// message sent after the batch could reach the shared call queue ahead of a
// member still to be dispatched — reordering the domain operations themselves,
// not just the replies. Dispatching up front puts every member on that queue in
// its own position before any later line is read; each reply is collected by
// index, so completion order cannot disturb the order they are written in.
async function handleBatch(batch) {
  if (batch.length === 0) {
    writeLine(responseFor(null, null, rpcError(-32600, 'Invalid Request')));
    return;
  }
  const collected = batch.map(() => []);
  const settled = batch.map((member, index) => handleMessage(member, (response) => collected[index].push(response)));
  await Promise.all(settled);
  const responses = collected.flat();
  if (responses.length) writeLine(responses);
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (!line.trim()) return;
  let parsed;
  // A parse failure is answered before anything else can look at the message, so
  // an unparseable line - batch or not - is the one case that cannot carry an id.
  try { parsed = JSON.parse(line); }
  catch { writeLine(responseFor(null, null, rpcError(-32700, 'Parse error'))); return; }
  // Dispatch stays synchronous from here, for a single message and for every
  // member of a batch alike, so the order in which tool calls register on the
  // shared queue still follows the order the lines arrived in.
  if (!Array.isArray(parsed)) { void handleMessage(parsed, writeLine); return; }
  // An array is a batch only where the negotiated revision requires one to be
  // accepted; anywhere else it is exactly what it was before: an invalid request.
  if (!batchesAccepted) { writeLine(responseFor(null, null, rpcError(-32600, 'Invalid Request'))); return; }
  void handleBatch(parsed);
});
