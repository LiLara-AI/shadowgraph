import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPACT_TOOL_NAMES, WORKFLOW_TOOL_NAMES, buildToolCatalog } from '../src/mcp-tools.js';

const CATALOG = buildToolCatalog({ verifier: true });

test('Feature 1: shadowgraph_record_attempt exposes required inputs and outputs', () => {
  const tool = CATALOG.find((t) => t.name === 'shadowgraph_record_attempt');
  assert.ok(tool, 'shadowgraph_record_attempt must exist');

  // Input schema checks
  const inputProps = tool.inputSchema.properties;
  assert.ok(inputProps.reusableWhen, 'reusableWhen in inputSchema');
  assert.ok(inputProps.relatedTo, 'relatedTo in inputSchema');
  assert.ok(inputProps.task, 'task in inputSchema');
  assert.ok(inputProps.tags, 'tags in inputSchema');
  assert.ok(inputProps.visibility, 'visibility in inputSchema');

  // Output schema checks
  const outputProps = tool.outputSchema.properties;
  assert.ok(outputProps.task, 'task in outputSchema');
  assert.ok(outputProps.tags, 'tags in outputSchema');
  assert.ok(outputProps.visibility, 'visibility in outputSchema');
});

test('Feature 2: shadowgraph_record_decision exposes required inputs and outputs', () => {
  const tool = CATALOG.find((t) => t.name === 'shadowgraph_record_decision');
  assert.ok(tool, 'shadowgraph_record_decision must exist');

  // Input schema checks
  const inputProps = tool.inputSchema.properties;
  assert.ok(inputProps.status, 'status in inputSchema');
  assert.ok(inputProps.supersedes, 'supersedes in inputSchema');
  assert.ok(inputProps.reviewAfter, 'reviewAfter in inputSchema');
  assert.ok(inputProps.failedAttempts, 'failedAttempts in inputSchema');
  assert.ok(inputProps.reason, 'reason in inputSchema');
  assert.ok(inputProps.changeSummary, 'changeSummary in inputSchema');
  assert.ok(inputProps.task, 'task in inputSchema');
  assert.ok(inputProps.tags, 'tags in inputSchema');
  assert.ok(inputProps.visibility, 'visibility in inputSchema');

  // Output schema checks
  const outputProps = tool.outputSchema.properties;
  assert.ok(outputProps.task, 'task in outputSchema');
  assert.ok(outputProps.tags, 'tags in outputSchema');
  assert.ok(outputProps.visibility, 'visibility in outputSchema');
  assert.ok(outputProps.changeSummary, 'changeSummary in outputSchema');
});

test('Feature 3: shadowgraph_record_outcome exposes autoTransition, decisionStatus, lifecycleStatus inside outcome and top-level', () => {
  const tool = CATALOG.find((t) => t.name === 'shadowgraph_record_outcome');
  assert.ok(tool, 'shadowgraph_record_outcome must exist');

  const topProps = tool.inputSchema.properties;
  assert.ok(topProps.autoTransition, 'autoTransition at top-level inputSchema');
  assert.ok(topProps.decisionStatus, 'decisionStatus at top-level inputSchema');
  assert.ok(topProps.lifecycleStatus, 'lifecycleStatus at top-level inputSchema');

  const outcomeProps = topProps.outcome.properties;
  assert.ok(outcomeProps.autoTransition, 'autoTransition inside outcome');
  assert.ok(outcomeProps.decisionStatus, 'decisionStatus inside outcome');
  assert.ok(outcomeProps.lifecycleStatus, 'lifecycleStatus inside outcome');
});

test('Feature 4: shadowgraph_recall exposes inputs and historyChain on hit schema', () => {
  const tool = CATALOG.find((t) => t.name === 'shadowgraph_recall');
  assert.ok(tool, 'shadowgraph_recall must exist');

  const inputProps = tool.inputSchema.properties;
  assert.ok(inputProps.includeHistory, 'includeHistory in inputSchema');
  assert.ok(inputProps.includeCrossProject, 'includeCrossProject in inputSchema');
  assert.ok(inputProps.expandSynonyms, 'expandSynonyms in inputSchema');

  // outputSchema -> envelope -> items (recallHitSchema)
  const hitSchema = tool.outputSchema.properties.items.items;
  assert.ok(hitSchema.properties.historyChain, 'historyChain in recallHitSchema');
});

test('Feature 5: shadowgraph_context exposes includeCrossProject and enriches advisoryItemSchema', () => {
  const tool = CATALOG.find((t) => t.name === 'shadowgraph_context');
  assert.ok(tool, 'shadowgraph_context must exist');

  const inputProps = tool.inputSchema.properties;
  assert.ok(inputProps.includeCrossProject, 'includeCrossProject in defaultContextInputSchema');

  // Verify advisory fields on userMemories / successfulApproaches / crossProjectExperience / relevantToTask
  const collections = ['userMemories', 'successfulApproaches', 'crossProjectExperience', 'relevantToTask'];
  const expectedAdvisoryFields = [
    'sourceProject', 'crossProject', 'reusableNow', 'conditionSummary', 'changeSummary',
    'summary', 'detail', 'score', 'title', 'chosen', 'solution', 'result', 'text', 'key', 'tags'
  ];

  for (const coll of collections) {
    const itemProps = tool.outputSchema.properties[coll].items.properties;
    assert.ok(itemProps, `advisory properties on ${coll}`);
    for (const field of expectedAdvisoryFields) {
      assert.ok(itemProps[field], `${field} in ${coll} advisory item schema`);
    }
  }
});

test('Feature 6: remember, record_fact, supersede schema completeness and fact value requirement', () => {
  // remember
  const rememberTool = CATALOG.find((t) => t.name === 'shadowgraph_remember');
  assert.ok(rememberTool.inputSchema.properties.visibility, 'visibility in remember');
  assert.ok(rememberTool.inputSchema.properties.reason, 'reason in remember');
  assert.ok(rememberTool.inputSchema.properties.changeSummary, 'changeSummary in remember');
  assert.ok(rememberTool.inputSchema.properties.allowHistorical, 'allowHistorical in remember');
  assert.ok(rememberTool.inputSchema.properties.backfill, 'backfill in remember');

  // record_fact
  const factTool = CATALOG.find((t) => t.name === 'shadowgraph_record_fact');
  assert.deepEqual(factTool.inputSchema.required, ['key', 'value'], 'key and value required for record_fact');
  const factProps = factTool.inputSchema.properties;
  assert.ok(factProps.visibility, 'visibility in record_fact');
  assert.ok(factProps.reason, 'reason in record_fact');
  assert.ok(factProps.changeSummary, 'changeSummary in record_fact');
  assert.ok(factProps.allowHistorical, 'allowHistorical in record_fact');
  assert.ok(factProps.backfill, 'backfill in record_fact');
  assert.ok(factProps.validFrom, 'validFrom in record_fact');
  assert.ok(factProps.validTo, 'validTo in record_fact');
  assert.ok(factProps.observedAt, 'observedAt in record_fact');
  assert.ok(factProps.tags, 'tags in record_fact');

  // Record schemas for memory and fact
  assert.ok(factTool.outputSchema.properties.visibility, 'visibility in factRecordSchema');
  assert.ok(factTool.outputSchema.properties.changeSummary, 'changeSummary in factRecordSchema');

  // supersede
  const supersedeTool = CATALOG.find((t) => t.name === 'shadowgraph_supersede');
  assert.ok(supersedeTool.inputSchema.properties.reason, 'reason in supersede');
  assert.ok(supersedeTool.inputSchema.properties.changeSummary, 'changeSummary in supersede');
});

test('Feature 7: search and retrieve expose matchMode, expandSynonyms, and hit outputs', () => {
  for (const name of ['shadowgraph_search', 'shadowgraph_retrieve']) {
    const tool = CATALOG.find((t) => t.name === name);
    assert.ok(tool, `${name} exists`);
    assert.deepEqual(tool.inputSchema.properties.matchMode.enum, ['all', 'partial', 'any'], `${name} matchMode enum`);
    assert.ok(tool.inputSchema.properties.expandSynonyms, `${name} expandSynonyms`);

    const hitSchema = tool.outputSchema.properties.items.items;
    assert.ok(hitSchema.properties.partialMatch, `${name} partialMatch in hitSchema`);
    assert.ok(hitSchema.properties.matchedTermCount, `${name} matchedTermCount in hitSchema`);
    assert.ok(hitSchema.properties.totalQueryTerms, `${name} totalQueryTerms in hitSchema`);
  }
});

test('Feature 8: profile inventory invariants (16 Compact, 20 Workflow, 35 Full, 36 Verifier)', () => {
  const full = buildToolCatalog({ verifier: false });
  assert.equal(full.length, 35, 'Full profile must have exactly 35 tools');

  const verifier = buildToolCatalog({ verifier: true });
  assert.equal(verifier.length, 36, 'Verifier profile must have exactly 36 tools');

  assert.equal(COMPACT_TOOL_NAMES.length, 16, 'Compact profile must have exactly 16 tools');
  assert.equal(WORKFLOW_TOOL_NAMES.length, 20, 'Workflow profile must have exactly 20 tools');
});
