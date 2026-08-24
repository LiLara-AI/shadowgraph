import { createInterface } from 'node:readline';
import { createStorage } from './storage.js';
import { createShadowGraph } from './shadowgraph.js';

const file = process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json';
const store = await createStorage({ file });
const MCP_VERSION = '0.26.0';
const graph = createShadowGraph();
graph.importData(await store.load());

const tools = [
  { name: 'shadowgraph_record_decision', description: 'Record a decision, its assumptions, evidence, and rejected alternatives.', inputSchema: { type: 'object', required: ['title', 'chosen'], properties: { title: { type: 'string' }, chosen: { type: 'string' }, goal: { type: 'string' }, assumptions: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: { type: 'string' } }, alternatives: { type: 'array' } } } },
  { name: 'shadowgraph_record_attempt', description: 'Record a failed or informative attempt so the agent does not repeat it blindly.', inputSchema: { type: 'object', required: ['solution', 'result'], properties: { solution: { type: 'string' }, result: { type: 'string' }, reason: { type: 'string' }, environment: { type: 'string' } } } },
  { name: 'shadowgraph_review', description: 'Find decisions whose rejected alternatives should be reconsidered after facts change.', inputSchema: { type: 'object', properties: { changedFacts: { type: 'array', items: { type: 'string' } }, facts: { type: 'object' } } } },
  { name: 'shadowgraph_search', description: 'Search the unified decision and attempt memory with explanations.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' }, status: { type: 'string' }, minConfidence: { type: 'number' } } } },
  { name: 'shadowgraph_context', description: 'Build relevant working context before an agent starts a consequential task.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, changedFacts: { type: 'array', items: { type: 'string' } }, facts: { type: 'object' } } } },
  { name: 'shadowgraph_record_fact', description: 'Record an observed fact with provenance and confidence.', inputSchema: { type: 'object', required: ['key'], properties: { key: { type: 'string' }, value: {}, source: { type: 'string' }, confidence: { type: 'number' }, project: { type: 'string' } } } },
  { name: 'shadowgraph_record_outcome', description: 'Record what happened after a decision and update its confidence.', inputSchema: { type: 'object', required: ['decisionId', 'outcome'], properties: { decisionId: { type: 'string' }, outcome: { type: 'object' } } } },
  { name: 'shadowgraph_update_status', description: 'Move a decision through its lifecycle.', inputSchema: { type: 'object', required: ['decisionId', 'status'], properties: { decisionId: { type: 'string' }, status: { type: 'string' } } } },
  { name: 'shadowgraph_link', description: 'Create an explainable relationship between graph entities.', inputSchema: { type: 'object', required: ['from', 'to', 'relation'], properties: { from: { type: 'string' }, to: { type: 'string' }, relation: { type: 'string' } } } }
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
  else if (!name) { const error = new Error('Invalid tool parameters'); error.code = -32602; throw error; }
  else { const error = new Error(`Unknown tool: ${name}`); error.code = -32601; throw error; }
  if (name.includes('record_') || name === 'shadowgraph_update_status' || name === 'shadowgraph_link') await store.save(graph.exportData());
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
    if (request.method === 'initialize') reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'shadowgraph', version: MCP_VERSION } });
    else if (request.method === 'notifications/initialized') return;
    else if (request.method === 'tools/list') reply(request.id, { tools });
    else if (request.method === 'tools/call') reply(request.id, await call(request.params?.name, request.params.arguments ?? {}));
    else reply(request.id, {});
  } catch (error) {
    const parseError = error instanceof SyntaxError;
    reply(request?.id ?? null, null, { code: parseError ? -32700 : -32000, message: parseError ? 'Parse error' : error.message });
  }
});
