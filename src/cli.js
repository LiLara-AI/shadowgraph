#!/usr/bin/env node
import { createStorage } from './storage.js';
import { createShadowGraph } from './shadowgraph.js';

const file = process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json';
const store = await createStorage({ file });
const graph = createShadowGraph();
graph.importData(await store.load());
const [command, ...rest] = process.argv.slice(2);
const input = rest.join(' ');

function parse(value) {
  try { return JSON.parse(value); } catch { throw new Error('Expected a JSON argument'); }
}

let result;
try {
if (command === 'stats') result = graph.stats();
else if (command === 'list') result = graph.exportData();
else if (command === 'search') result = graph.search(input);
else if (command === 'context') result = graph.context(parse(input || '{}'));
else if (command === 'review') result = graph.review(parse(input || '{}'));
else if (command === 'fact') { result = graph.addFact(parse(input)); await store.save(graph.exportData()); }
else if (command === 'outcome') { const value = parse(input); result = graph.setOutcome(value.decisionId, value.outcome); await store.save(graph.exportData()); }
else if (command === 'status') { const value = parse(input); result = graph.updateDecisionStatus(value.decisionId, value.status); await store.save(graph.exportData()); }
else if (command === 'link') { result = graph.link(parse(input)); await store.save(graph.exportData()); }
else if (command === 'decision') { result = graph.addDecision(parse(input)); await store.save(graph.exportData()); }
else if (command === 'attempt') { result = graph.addAttempt(parse(input)); await store.save(graph.exportData()); }
else {
  console.error('Usage: shadowgraph <stats|list|search|context|review|decision|attempt|fact|outcome|status|link> [JSON]');
  process.exitCode = 1;
  result = null;
}
if (result !== null) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
