import { createInterface } from 'node:readline';
import { createStorage } from './storage.js';
import { createShadowGraph } from './shadowgraph.js';

const file = process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json';
const store = await createStorage({ file });
const MCP_VERSION = '0.30.0';
const graph = createShadowGraph();
graph.importData(await store.load());
let persistQueue = Promise.resolve();
function persist() { const operation = persistQueue.then(async () => { const revision = await store.save(graph.exportData()); graph.setRevision(revision); }).catch(async (error) => { if (/revision conflict/i.test(error.message)) graph.replaceData(await store.load()); throw error; }); persistQueue = operation.catch(() => {}); return operation; }

const tools = [
  { name: 'shadowgraph_record_decision', description: 'Record a decision, its assumptions, evidence, and rejected alternatives.', inputSchema: { type: 'object', required: ['title', 'chosen'], properties: { title: { type: 'string' }, chosen: { type: 'string' }, project: { type: 'string' }, goal: { type: 'string' }, assumptions: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: { type: 'string' } }, alternatives: { type: 'array' } } } },
  { name: 'shadowgraph_record_attempt', description: 'Record a failed or informative attempt so the agent does not repeat it blindly.', inputSchema: { type: 'object', required: ['solution', 'result'], properties: { solution: { type: 'string' }, result: { type: 'string' }, project: { type: 'string' }, reason: { type: 'string' }, environment: { type: 'string' } } } },
  { name: 'shadowgraph_review', description: 'Find decisions whose rejected alternatives should be reconsidered after facts change.', inputSchema: { type: 'object', properties: { changedFacts: { type: 'array', items: { type: 'string' } }, facts: { type: 'object' } } } },
  { name: 'shadowgraph_search', description: 'Search the unified decision and attempt memory with explanations.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' }, status: { type: 'string' }, minConfidence: { type: 'number' } } } },
  { name: 'shadowgraph_context', description: 'Build relevant working context before an agent starts a consequential task.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, changedFacts: { type: 'array', items: { type: 'string' } }, facts: { type: 'object' } } } },
  { name: 'shadowgraph_record_fact', description: 'Record an observed fact with provenance and confidence.', inputSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string' }, value: {}, source: { type: 'string' }, confidence: { type: 'number' }, project: { type: 'string' } } } },
  { name: 'shadowgraph_record_outcome', description: 'Record what happened after a decision and update its confidence.', inputSchema: { type: 'object', required: ['decisionId', 'outcome'], properties: { decisionId: { type: 'string' }, outcome: { type: 'object' } } } },
  { name: 'shadowgraph_update_status', description: 'Move a decision through its lifecycle.', inputSchema: { type: 'object', required: ['decisionId', 'status'], properties: { decisionId: { type: 'string' }, status: { type: 'string' } } } },
  { name: 'shadowgraph_link', description: 'Create an explainable relationship between graph entities.', inputSchema: { type: 'object', required: ['from', 'to', 'relation'], properties: { from: { type: 'string' }, to: { type: 'string' }, relation: { type: 'string' } } } },
  { name: 'shadowgraph_traverse', description: 'Traverse related decisions, facts, attempts, and relationships.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, depth: { type: 'integer' }, direction: { type: 'string' }, relation: { type: 'string' } } } },
  { name: 'shadowgraph_supersede', description: 'Mark one decision superseded by a replacement decision in the same project.', inputSchema: { type: 'object', required: ['decisionId', 'replacementId'], properties: { decisionId: { type: 'string' }, replacementId: { type: 'string' } } } },
  { name: 'shadowgraph_redact', description: 'Return a redacted export without changing stored data.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, patterns: { type: 'array', items: { type: 'string' } } } } },
  { name: 'shadowgraph_purge', description: 'Permanently remove all records, facts, events, and relationships for a project.', inputSchema: { type: 'object', required: ['project'], properties: { project: { type: 'string' } } } },
  { name: 'shadowgraph_maintain', description: 'Age due decisions, expire facts, and generate persistent review signals.', inputSchema: { type: 'object', properties: { now: { type: 'string' }, changedFacts: { type: 'array' }, facts: { type: 'object' } } } },
  { name: 'shadowgraph_retrieve', description: 'Retrieve relevant records plus one-hop related graph context.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' }, status: { type: 'string' } } } },
  { name: 'shadowgraph_validate', description: 'Validate graph integrity without modifying storage.', inputSchema: { type: 'object' } },
  { name: 'shadowgraph_review_signals', description: 'List persistent review signals.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, status: { type: 'string' } } } },
  { name: 'shadowgraph_purge_preview', description: 'Preview project deletion counts without modifying storage.', inputSchema: { type: 'object', required: ['project'], properties: { project: { type: 'string' } } } },
  { name: 'shadowgraph_ack_review', description: 'Acknowledge one persistent review signal.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'shadowgraph_repair_plan', description: 'Return a non-destructive graph repair plan.', inputSchema: { type: 'object' } },
  { name: 'shadowgraph_backup', description: 'Create a consistent backup snapshot at a destination path.', inputSchema: { type: 'object', required: ['destination'], properties: { destination: { type: 'string' } } } },
  { name: 'shadowgraph_restore', description: 'Restore a JSON or SQLite backup using the configured storage backend.', inputSchema: { type: 'object', required: ['source'], properties: { source: { type: 'string' } } } }
];

async function call(name, args) {
  let value;
  if (name === 'shadowgraph_record_decision') value = graph.addDecision(args);
  else if (name === 'shadowgraph_record_attempt') value = graph.addAttempt(args);
  else if (name === 'shadowgraph_review') value = graph.review(args ?? {});
  else if (name === 'shadowgraph_search') value = graph.search(args?.query ?? '', args ?? {});
  else if (name === 'shadowgraph_context') value = graph.context(args ?? {});
  else if (name === 'shadowgraph_record_fact') value = graph.addFact(args);
  else if (name === 'shadowgraph_record_outcome') value = graph.setOutcome(args?.decisionId, args?.outcome);
  else if (name === 'shadowgraph_update_status') value = graph.updateDecisionStatus(args?.decisionId, args?.status);
  else if (name === 'shadowgraph_link') value = graph.link(args);
  else if (name === 'shadowgraph_traverse') value = graph.traverse(args ?? {});
  else if (name === 'shadowgraph_supersede') value = graph.supersedeDecision(args ?? {});
  else if (name === 'shadowgraph_redact') value = graph.redact(args ?? {});
  else if (name === 'shadowgraph_purge') value = graph.purgeProject(args?.project);
  else if (name === 'shadowgraph_maintain') value = graph.maintain(args ?? {});
  else if (name === 'shadowgraph_retrieve') value = graph.retrieve(args?.query ?? '', args ?? {});
  else if (name === 'shadowgraph_validate') value = graph.validate();
  else if (name === 'shadowgraph_review_signals') value = graph.getReviewSignals(args ?? {});
  else if (name === 'shadowgraph_purge_preview') value = graph.projectSummary(args?.project);
  else if (name === 'shadowgraph_ack_review') value = graph.acknowledgeReview(args?.id);
  else if (name === 'shadowgraph_repair_plan') value = graph.repairPlan();
  else if (name === 'shadowgraph_backup') { const { backupFile } = await import('./backup.js'); value = await backupFile(file, args?.destination, { store }); }
  else if (name === 'shadowgraph_restore') { value = store.restore ? await store.restore(args?.source) : await (await import('./backup.js')).restoreFile(args?.source, file, { storage: process.env.SHADOWGRAPH_STORAGE }); graph.replaceData(await store.load()); }
  else if (!name) { const error = new Error('Invalid tool parameters'); error.code = -32602; throw error; }
  else { const error = new Error(`Unknown tool: ${name}`); error.code = -32601; throw error; }
  if (name.includes('record_') || name === 'shadowgraph_update_status' || name === 'shadowgraph_link' || name === 'shadowgraph_supersede' || name === 'shadowgraph_purge' || name === 'shadowgraph_maintain' || name === 'shadowgraph_review' || name === 'shadowgraph_ack_review' || name === 'shadowgraph_backup' || name === 'shadowgraph_restore') await persist();
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function reply(id, result, error) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, ...(error ? { error: { code: error.code ?? -32000, message: error.message } } : { result }) }) + '\n');
}

const input = createInterface({ input: process.stdin });
input.on('line', async (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
    if (request.method === 'initialize') reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'shadowgraph', version: MCP_VERSION } });
    else if (request.method === 'notifications/initialized') return;
    else if (request.method === 'tools/list') reply(request.id, { tools });
    else if (request.method === 'resources/list') reply(request.id, { resources: [{ uri: 'shadowgraph://context', name: 'ShadowGraph context', description: 'Current project context and open review signals.', mimeType: 'application/json' }] });
    else if (request.method === 'resources/read') reply(request.id, { contents: [{ uri: request.params?.uri, mimeType: 'application/json', text: JSON.stringify(graph.context({}) ) }] });
    else if (request.method === 'prompts/list') reply(request.id, { prompts: [{ name: 'shadowgraph_consequential_task', description: 'Use ShadowGraph before, during, and after consequential work.', arguments: [] }] });
    else if (request.method === 'prompts/get') reply(request.id, { description: 'ShadowGraph operating policy', messages: [{ role: 'user', content: { type: 'text', text: 'Before consequential work call context and retrieve. Record decisions, assumptions, evidence, alternatives, failed attempts, facts, and outcomes. Review open signals before continuing.' } }] });
    else if (request.method === 'tools/call') reply(request.id, await call(request.params?.name, request.params?.arguments ?? {}));
    else reply(request.id, {});
  } catch (error) {
    const parseError = error instanceof SyntaxError;
    reply(request?.id ?? null, null, { code: parseError ? -32700 : -32000, message: parseError ? 'Parse error' : error.message });
  }
});
