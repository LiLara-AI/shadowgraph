import { createInterface } from 'node:readline';
import { createJsonFileStore } from './storage.js';
import { createShadowGraph } from './shadowgraph.js';

const file = process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json';
const store = createJsonFileStore(file);
const graph = createShadowGraph();
graph.importData(await store.load());

const tools = [
  { name: 'shadowgraph_record_decision', description: 'Record a decision, its assumptions, evidence, and rejected alternatives.', inputSchema: { type: 'object', required: ['title', 'chosen'], properties: { title: { type: 'string' }, chosen: { type: 'string' }, goal: { type: 'string' }, assumptions: { type: 'array', items: { type: 'string' } }, evidence: { type: 'array', items: { type: 'string' } }, alternatives: { type: 'array' } } } },
  { name: 'shadowgraph_record_attempt', description: 'Record a failed or informative attempt so the agent does not repeat it blindly.', inputSchema: { type: 'object', required: ['solution', 'result'], properties: { solution: { type: 'string' }, result: { type: 'string' }, reason: { type: 'string' }, environment: { type: 'string' } } } },
  { name: 'shadowgraph_review', description: 'Find decisions whose rejected alternatives should be reconsidered after facts change.', inputSchema: { type: 'object', properties: { changedFacts: { type: 'array', items: { type: 'string' } } } } },
  { name: 'shadowgraph_search', description: 'Search the unified decision and attempt memory.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }
];

async function call(name, args) {
  let value;
  if (name === 'shadowgraph_record_decision') value = graph.addDecision(args);
  else if (name === 'shadowgraph_record_attempt') value = graph.addAttempt(args);
  else if (name === 'shadowgraph_review') value = graph.review(args ?? {});
  else if (name === 'shadowgraph_search') value = graph.search(args?.query ?? '');
  else throw new Error(`Unknown tool: ${name}`);
  if (name.includes('record_')) await store.save(graph.exportData());
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function reply(id, result, error) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, ...(error ? { error: { code: error.code ?? -32000, message: error.message } } : { result }) }) + '\n');
}

const input = createInterface({ input: process.stdin });
input.on('line', async (line) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    if (request.method === 'initialize') reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'shadowgraph', version: '0.1.0' } });
    else if (request.method === 'notifications/initialized') return;
    else if (request.method === 'tools/list') reply(request.id, { tools });
    else if (request.method === 'tools/call') reply(request.id, await call(request.params.name, request.params.arguments ?? {}));
    else reply(request.id, {});
  } catch (error) {
    reply(null, null, { code: -32700, message: 'Parse error' });
  }
});
