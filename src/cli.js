#!/usr/bin/env node
import { createStorage } from './storage.js';
import { createShadowGraph } from './shadowgraph.js';
import { backupFile, restoreFile } from './backup.js';
import { validateRestorePayload } from './restore-validation.js';

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
else if (command === 'search') { const query = parse(input || '{}'); result = graph.search(query.query ?? '', query); }
else if (command === 'context') result = graph.context(parse(input || '{}'));
else if (command === 'review') { result = graph.review(parse(input || '{}')); await store.save(graph.exportData()); }
else if (command === 'fact') { result = graph.addFact(parse(input)); await store.save(graph.exportData()); }
else if (command === 'outcome') { const value = parse(input); result = graph.setOutcome(value.decisionId, value.outcome); await store.save(graph.exportData()); }
else if (command === 'status') { const value = parse(input); result = graph.updateDecisionStatus(value.decisionId, value.status); await store.save(graph.exportData()); }
else if (command === 'link') { result = graph.link(parse(input)); await store.save(graph.exportData()); }
else if (command === 'traverse') result = graph.traverse(parse(input));
else if (command === 'redact') result = graph.redact(parse(input));
else if (command === 'supersede') { result = graph.supersedeDecision(parse(input)); await store.save(graph.exportData()); }
else if (command === 'purge-preview') result = graph.projectSummary(parse(input).project);
else if (command === 'purge') { const value = parse(input); result = graph.purgeProject(value.project, { mode: value.mode }); await store.save(graph.exportData()); }
else if (command === 'confidence-evidence') { result = graph.addConfidenceEvidence(parse(input)); await store.save(graph.exportData()); }
else if (command === 'journal') result = graph.getJournal(parse(input || '{}'));
else if (command === 'rebuild') result = graph.rebuild(parse(input || '{}'));
else if (command === 'maintain') { result = graph.maintain(parse(input || '{}')); await store.save(graph.exportData()); }
else if (command === 'signals') result = graph.getReviewSignals(parse(input || '{}'));
else if (command === 'ack') { result = graph.acknowledgeReview(parse(input).id); await store.save(graph.exportData()); }
else if (command === 'retrieve') { const value = parse(input || '{}'); result = graph.retrieve(value.query ?? '', value); }
else if (command === 'validate') result = graph.validate();
else if (command === 'repair-plan') result = graph.repairPlan();
else if (command === 'backup') result = await backupFile(file, input || `${file}.backup`, { store });
else if (command === 'restore') result = store.restore ? await store.restore(input) : await restoreFile(input, file, { storage: process.env.SHADOWGRAPH_STORAGE, validate: validateRestorePayload });
else if (command === 'decision') { result = graph.addDecision(parse(input)); await store.save(graph.exportData()); }
else if (command === 'attempt') { result = graph.addAttempt(parse(input)); await store.save(graph.exportData()); }
else {
  console.error('Usage: shadowgraph <stats|list|search|retrieve|context|review|maintain|signals|ack|validate|repair-plan|backup|restore|decision|attempt|fact|outcome|status|link|traverse|redact|supersede|purge-preview|purge> [JSON/path]');
  process.exitCode = 1;
  result = null;
}
if (result !== null) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
