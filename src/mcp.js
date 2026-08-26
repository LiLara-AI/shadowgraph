import { createInterface } from 'node:readline';
import { createStorage } from './storage.js';
import { createShadowGraph, SOURCE_CLASSES, DECISION_STATUSES, OUTCOME_STATUSES, CONTENT_SEARCH_FIELDS } from './shadowgraph.js';
import { VERSION } from './version.js';
import { validateRestorePayload } from './restore-validation.js';

const file = process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json';
const store = await createStorage({ file });
// P1-3: single source of truth — package.json via src/version.js.
const MCP_VERSION = VERSION;
// Protocol version actually IMPLEMENTED by this server. The current MCP spec is
// 2026-07-28 (no initialize handshake, mandatory server/discover); this server
// implements the legacy 2024-11-05 handshake and is therefore a "Legacy-era"
// server in that spec's own terms. Advertising anything newer without client
// interoperability testing would be a false claim — see docs/mcp-compatibility.md.
const PROTOCOL_VERSION = '2024-11-05';
const graph = createShadowGraph();
graph.importData(await store.load());
let persistQueue = Promise.resolve();
function persist() { const operation = persistQueue.then(async () => { const revision = await store.save(graph.exportData()); graph.setRevision(revision); }).catch(async (error) => { if (/revision conflict/i.test(error.message)) graph.replaceData(await store.load()); throw error; }); persistQueue = operation.catch(() => {}); return operation; }

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
const RESULT_ENVELOPE = 'Returns { items, page: { offset, limit, total, hasMore }, completeness } — completeness always declares what was omitted.';

const allTools = [
  { name: 'shadowgraph_record_decision', description: 'Record a decision, its assumptions, evidence, and rejected alternatives.', inputSchema: { type: 'object', required: ['title', 'chosen'], properties: { title: { type: 'string' }, chosen: { type: 'string' }, project: { type: 'string' }, goal: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, assumptions: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: {} }, alternatives: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, reasonRejected: { type: 'string' }, reason: { type: 'string' }, reopenWhen: { type: 'array' } } } }, idempotencyKey: { type: 'string', maxLength: 200, description: 'Retry key scoped by project and operation; reuse only for the same logical write.' }, ...provenanceProperties } } },
  { name: 'shadowgraph_record_attempt', description: 'Record a failed or informative attempt so the agent does not repeat it blindly.', inputSchema: { type: 'object', required: ['solution', 'result'], properties: { solution: { type: 'string' }, result: { type: 'string' }, project: { type: 'string' }, reason: { type: 'string' }, environment: { type: 'string' }, idempotencyKey: { type: 'string', maxLength: 200, description: 'Retry key scoped by project and operation; reuse only for the same logical write.' }, ...provenanceProperties } } },
  { name: 'shadowgraph_review', description: 'Find decisions whose rejected alternatives should be reconsidered. Evaluates reopenWhen rules against STORED facts, so it works after a restart without re-supplying them.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, changedFacts: { type: 'array', items: { type: 'string' } }, facts: { type: 'object', description: 'Optional overrides; these take precedence over stored facts.' } } } },
  { name: 'shadowgraph_search', description: `Search decision and attempt memory. A query term matches DECLARED CONTENT FIELDS only (${CONTENT_SEARCH_FIELDS.join(', ')}) — schema keys and internal metadata never match. ${RESULT_ENVELOPE}`, inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' }, status: { type: 'string', enum: [...DECISION_STATUSES] }, kind: { type: 'string', enum: ['decision', 'attempt'] }, sourceClass: { type: 'string', enum: [...SOURCE_CLASSES] }, minConfidence: { type: 'number', minimum: 0, maximum: 1 }, ...pageProperties } } },
  { name: 'shadowgraph_context', description: 'Build working context before a consequential task. Every collection declares its total in `completeness.collections`, so truncation is never silent.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000 }, changedFacts: { type: 'array', items: { type: 'string' } }, facts: { type: 'object' } } } },
  { name: 'shadowgraph_record_fact', description: 'Record an observed fact with provenance. IMPORTANT: no input can mark a fact `verified` — a source label is a claim about origin, not proof.', inputSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string' }, value: {}, source: { type: 'string', description: 'Legacy alias for sourceClass. Unknown labels downgrade to agent_claimed with the raw label kept in sourceRaw.' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, project: { type: 'string' }, expiresAt: { type: 'string' }, verificationStatus: { type: 'string', enum: ['unverified', 'contradicted'], description: 'Only `contradicted` may be set by a caller; `verified` and `expired` are rejected.' }, idempotencyKey: { type: 'string', maxLength: 200, description: 'Retry key scoped by project and operation; reuse only for the same logical write.' }, ...provenanceProperties } } },
  { name: 'shadowgraph_record_outcome', description: 'Record what happened after a decision. Confidence moves by an evidence-weighted amount derived from the outcome\'s claimed source class; it never sets a verification status.', inputSchema: { type: 'object', required: ['decisionId', 'outcome'], properties: { decisionId: { type: 'string' }, outcome: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: [...OUTCOME_STATUSES] }, sourceClass: { type: 'string', enum: [...SOURCE_CLASSES] }, lessons: { type: 'array', items: { type: 'string' } }, observedAt: { type: 'string' } } } } } },
  { name: 'shadowgraph_confidence_evidence', description: 'Record evidence for or against a decision and move its confidence by a weighted, auditable amount. `key` is REQUIRED and must be stable: it is the dedupe key, so a retry with the same key is a no-op and cannot double-count.', inputSchema: { type: 'object', required: ['decisionId', 'reason', 'key'], properties: { decisionId: { type: 'string' }, reason: { type: 'string' }, supports: { type: 'boolean', description: 'Defaults to true. false records contradicting evidence.' }, key: { type: 'string', description: 'REQUIRED stable dedupe key. Reuse the same key for the same observation so retries do not double-count; use a NEW key for a genuinely new observation.' }, observedAt: { type: 'string' }, ...provenanceProperties } } },
  { name: 'shadowgraph_update_status', description: 'Move a decision through its lifecycle. Nine documented execution states plus four retained legacy states; formatting variants like in-progress are accepted and stored canonically.', inputSchema: { type: 'object', required: ['decisionId', 'status'], properties: { decisionId: { type: 'string' }, status: { type: 'string', enum: [...DECISION_STATUSES] } } } },
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
const compactNames = new Set(['shadowgraph_context','shadowgraph_record_decision','shadowgraph_record_attempt','shadowgraph_record_fact','shadowgraph_record_outcome','shadowgraph_retrieve','shadowgraph_search','shadowgraph_review','shadowgraph_validate','shadowgraph_maintain']);
const tools = process.env.SHADOWGRAPH_MCP_COMPACT === '1' ? allTools.filter((tool) => compactNames.has(tool.name)) : allTools;

async function call(name, args) {
  let value;
  if (name === 'shadowgraph_record_decision') value = graph.addDecision(args);
  else if (name === 'shadowgraph_record_attempt') value = graph.addAttempt(args);
  else if (name === 'shadowgraph_review') value = graph.review(args ?? {});
  else if (name === 'shadowgraph_search') value = graph.search(args?.query ?? '', args ?? {});
  else if (name === 'shadowgraph_context') value = graph.context(args ?? {});
  else if (name === 'shadowgraph_record_fact') value = graph.addFact(args);
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
  else if (name === 'shadowgraph_restore') { value = store.restore ? await store.restore(args?.source) : await (await import('./backup.js')).restoreFile(args?.source, file, { storage: process.env.SHADOWGRAPH_STORAGE, validate: validateRestorePayload }); graph.replaceData(await store.load()); }
  else if (!name) { const error = new Error('Invalid tool parameters'); error.code = -32602; throw error; }
  else { const error = new Error(`Unknown tool: ${name}`); error.code = -32601; throw error; }
  if (name.includes('record_') || name === 'shadowgraph_confidence_evidence' || name === 'shadowgraph_update_status' || name === 'shadowgraph_link' || name === 'shadowgraph_supersede' || name === 'shadowgraph_purge' || name === 'shadowgraph_maintain' || name === 'shadowgraph_review' || name === 'shadowgraph_ack_review' || name === 'shadowgraph_backup') await persist();
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

// The single resource and prompt this server actually serves. Requests for
// anything else are errors, not silent substitutions (P1-7).
const RESOURCE_URIS = new Set(['shadowgraph://context']);
const PROMPT_NAMES = new Set(['shadowgraph_consequential_task']);

function rpcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function reply(id, result, error) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, ...(error ? { error: { code: error.code ?? -32000, message: error.message } } : { result }) }) + '\n');
}

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
    isNotification = !Object.prototype.hasOwnProperty.call(request, 'id');
    if (typeof request.method !== 'string') throw rpcError(-32600, 'Invalid Request: method must be a string');
    if (request.params !== undefined && (typeof request.params !== 'object' || request.params === null || Array.isArray(request.params))) {
      throw rpcError(-32602, 'Invalid params: params must be an object');
    }

    if (request.method === 'initialize') {
      // Legacy 2024-11-05 handshake. A client may ask for a different revision;
      // per that spec the server answers with the version it actually implements
      // rather than echoing a version it does not support.
      const requested = request.params?.protocolVersion;
      if (requested !== undefined && typeof requested !== 'string') throw rpcError(-32602, 'Invalid params: protocolVersion must be a string');
      reply(request.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'shadowgraph', version: MCP_VERSION } });
    } else if (request.method.startsWith('notifications/')) {
      // Accepted and deliberately unanswered.
      return;
    } else if (request.method === 'tools/list') reply(request.id, { tools });
    // Minimal forward-compatibility shim: a 2026-07-28-era client sends
    // server/discover with no handshake. Answering it truthfully is better than
    // returning "method not found", but this server is still a Legacy-era server
    // and does not claim conformance to that revision.
    else if (request.method === 'server/discover') reply(request.id, { protocolVersion: PROTOCOL_VERSION, serverInfo: { name: 'shadowgraph', version: MCP_VERSION }, capabilities: { tools: {}, resources: {}, prompts: {} }, tools });
    else if (request.method === 'resources/list') reply(request.id, { resources: [{ uri: 'shadowgraph://context', name: 'ShadowGraph context', description: 'Current project context and open review signals.', mimeType: 'application/json' }] });
    else if (request.method === 'resources/read') {
      // P1-7: an unknown URI used to receive the real context payload anyway,
      // which told the client its request had succeeded when it had not.
      const uri = request.params?.uri;
      if (typeof uri !== 'string' || !uri) throw rpcError(-32602, 'Invalid params: uri is required');
      if (!RESOURCE_URIS.has(uri)) throw rpcError(-32602, `Unknown resource URI: ${uri}`);
      reply(request.id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(graph.context({})) }] });
    } else if (request.method === 'prompts/list') reply(request.id, { prompts: [{ name: 'shadowgraph_consequential_task', description: 'Use ShadowGraph before, during, and after consequential work.', arguments: [] }] });
    else if (request.method === 'prompts/get') {
      // P1-7: same failure as resources/read — any name returned the policy text.
      const promptName = request.params?.name;
      if (typeof promptName !== 'string' || !promptName) throw rpcError(-32602, 'Invalid params: name is required');
      if (!PROMPT_NAMES.has(promptName)) throw rpcError(-32602, `Unknown prompt: ${promptName}`);
      reply(request.id, { description: 'ShadowGraph operating policy', messages: [{ role: 'user', content: { type: 'text', text: 'Before consequential work call context and retrieve. Record decisions, assumptions, evidence, alternatives, failed attempts, facts, and outcomes. Review open signals before continuing. Treat agent_claimed and unverified facts as hypotheses: nothing in ShadowGraph can be marked verified, so never present a stored claim as confirmed.' } }] });
    } else if (request.method === 'tools/call') {
      if (request.params === undefined) throw rpcError(-32602, 'Invalid params: params is required for tools/call');
      const args = request.params.arguments ?? {};
      if (typeof args !== 'object' || args === null || Array.isArray(args)) throw rpcError(-32602, 'Invalid params: arguments must be an object');
      reply(request.id, await call(request.params.name, args));
    } else throw rpcError(-32601, `Method not found: ${request.method}`);
  } catch (error) {
    // P1-5: PRESERVE error.code. The old catch rebuilt a plain object and
    // hardcoded -32000, so the -32601/-32602 codes that `call()` raises were
    // flattened and a client could not distinguish "no such tool" from a genuine
    // internal failure.
    if (isNotification) return;
    const parseError = error instanceof SyntaxError;
    reply(request?.id ?? null, null, { code: error.code ?? (parseError ? -32700 : -32000), message: parseError ? 'Parse error' : error.message });
  }
});
