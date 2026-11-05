import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildToolCatalog, selectTools, METADATA_TIER, projectTool } from '../src/mcp-tools.js';

test('usability regression: read cluster disambiguation (search, retrieve, recall, context, expand)', () => {
  const catalog = buildToolCatalog({ verifier: false });
  const find = (name) => catalog.find((tool) => tool.name === name);

  const search = find('shadowgraph_search');
  assert.ok(search, 'shadowgraph_search exists');
  // Clarifies unranked literal matching with distinct opening verb "Match"
  assert.match(search.description, /^Match records containing every literal query term as direct content matches\./);
  assert.match(search.description, /requires both terms, not an exact phrase/i);
  assert.match(search.describe.effects, /Own-scope read saves nothing; an access key commits a revision and audit/i);
  assert.match(search.describe.route, /shadowgraph_retrieve adds ordered neighbours; shadowgraph_recall ranks matches; shadowgraph_context prepares a working set/i);

  const retrieve = find('shadowgraph_retrieve');
  assert.ok(retrieve, 'shadowgraph_retrieve exists');
  // Clarifies that seeds match query terms, but ordered graph neighbours are included via graph relations
  assert.match(retrieve.description, /^Retrieve seed records matching every query term plus their ordered graph neighbours\./);
  assert.match(retrieve.describe.returns, /Every term must match a seed; neighbours need not match/i);
  assert.match(retrieve.describe.route, /shadowgraph_search returns matches only; shadowgraph_recall ranks relevance; shadowgraph_context prepares a working set/i);

  const recall = find('shadowgraph_recall');
  assert.ok(recall, 'shadowgraph_recall exists');
  // Declares 4 ranking signals, dependency on provider, and explicit null-scope
  assert.match(recall.description, /^Rank relevant scoped memory and records by lexical, vector, graph and temporal signals\./);
  assert.match(recall.describe.returns, /no provider\/vector means no semantic ranking/i);
  assert.match(recall.describe.returns, /Omitted memory scope fields select null, not any user\/run/i);

  const context = find('shadowgraph_context');
  assert.ok(context, 'shadowgraph_context exists');
  // Emphasizes in-memory evaluation without saving signals
  assert.match(context.description, /^Read a planning working set without saving signals:/);
  assert.match(context.describe.effects, /No decision or signal writes/i);
  assert.match(context.describe.route, /shadowgraph_review_context persists signals/i);

  const expand = find('shadowgraph_expand');
  assert.ok(expand, 'shadowgraph_expand exists');
  // Declares dependency on context handle and stale/purged/unavailable outcomes
  assert.match(expand.description, /^Expand a context claim line to its full current record using its expansion handle as input\./);
  assert.match(expand.describe.route, /shadowgraph_context supplies the handle/i);
  assert.match(expand.describe.returns, /Stale digest yields revision_changed; purged yields purged; missing or out-of-scope yields unavailable/i);

  // Verify all 5 sibling read tools open with distinct verbs
  const openingVerbs = [search, retrieve, recall, context, expand].map((t) => t.description.split(/\s+/)[0]);
  assert.equal(new Set(openingVerbs).size, 5, `Expected 5 distinct opening verbs in read family, got: ${openingVerbs.join(', ')}`);
});

test('usability regression: review family disambiguation (review, review_signals, review_context, reconsider, maintain, ack_review)', () => {
  const catalog = buildToolCatalog({ verifier: false });
  const find = (name) => catalog.find((tool) => tool.name === name);

  const review = find('shadowgraph_review');
  assert.match(review.description, /^Evaluate reopen rules, reviewAfter and failed outcomes; persist signals and return due decisions/i);
  assert.match(review.describe.route, /shadowgraph_review_signals lists signals; shadowgraph_reconsider audits verdicts; shadowgraph_review_context adds context; shadowgraph_ack_review closes one/i);
  assert.match(review.describe.effects, /Saves owned signals deduped by decision\/reason\/coverage and commits a revision/i);

  const reviewSignals = find('shadowgraph_review_signals');
  assert.match(reviewSignals.description, /^List saved review signals without reevaluating rules or creating signals\./);
  assert.equal(reviewSignals.persists, false);
  assert.equal(reviewSignals.persistsWithAccess, true);
  assert.match(reviewSignals.describe.effects, /Own-scope read saves nothing; an access key commits a revision and audit/i);
  assert.match(reviewSignals.describe.returns, /acknowledged ones stay retained/i);
  // Confirms 'reminder' has been completely eliminated in favor of 'signal'
  assert.equal(/reminder/i.test(reviewSignals.description), false);

  const reviewContext = find('shadowgraph_review_context');
  assert.match(reviewContext.description, /^Load the project working set and persist signals from reopen rules, reviewAfter and failed outcomes\./);
  assert.match(reviewContext.describe.route, /shadowgraph_context saves no signals/i);
  assert.match(reviewContext.describe.effects, /Skips closed decisions\. Deduplicates owned signals by decision\/reason\/coverage and commits a revision/i);

  const reconsider = find('shadowgraph_reconsider');
  assert.match(reconsider.description, /^Audit one decision or project: explain all reopen verdicts and persist signals for due decisions\./);
  assert.match(reconsider.describe.returns, /review_recommended: condition fired; manual_review: unresolved evidence; unchanged: complete, no trigger/i);
  assert.match(reconsider.describe.effects, /Rejects unknown, out-of-scope or closed decisionId\. Saves deduplicated owned signals and commits a revision/i);
  assert.match(reconsider.inputSchema.properties.decisionId.description, /shadowgraph_record_decision, shadowgraph_search, or shadowgraph_context/i);
  assert.match(reconsider.inputSchema.properties.decisionId.description, /archived, abandoned, superseded/i);
  assert.match(reconsider.inputSchema.properties.decisionId.description, /unresolved scope yields manual_review\/partial/i);
  assert.match(reconsider.inputSchema.properties.changedFacts.description, /Non-persisted string\[\] of changed fact keys/i);
  assert.match(reconsider.inputSchema.properties.facts.description, /Non-persisted \{key:value\} map overriding stored facts/i);
  assert.match(reconsider.inputSchema.properties.originId.description, /Capture-origin ID for unattributed records when project is omitted/i);

  const ackReview = find('shadowgraph_ack_review');
  assert.match(ackReview.description, /^Acknowledge a saved review signal by ID; updates signal status, not the decision\./);
  assert.match(ackReview.describe.route, /Update decisions via shadowgraph_update_status or shadowgraph_supersede/i);
  assert.match(ackReview.describe.effects, /Rejects unknown\/unowned id\. Overwrites status and acknowledgedAt \(untracked by journal\/rebuild\)/i);

  const maintain = find('shadowgraph_maintain');
  assert.match(maintain.description, /^Age due owned decisions to stale, expire due owned facts, then evaluate reopen rules\./);
  assert.match(maintain.describe.route, /Maintenance does not repair or restore/i);
  assert.equal(maintain.annotations.destructiveHint, true);

  // Verify all 6 sibling review tools open with distinct verbs
  const openingVerbs = [review, reviewSignals, reviewContext, reconsider, ackReview, maintain].map((t) => t.description.split(/\s+/)[0]);
  assert.equal(new Set(openingVerbs).size, 6, `Expected 6 distinct opening verbs in review family, got: ${openingVerbs.join(', ')}`);
});

test('usability regression: decision lifecycle side effects (record_outcome, confidence_evidence, update_status)', () => {
  const catalog = buildToolCatalog({ verifier: false });
  const find = (name) => catalog.find((tool) => tool.name === name);

  const recordOutcome = find('shadowgraph_record_outcome');
  assert.match(recordOutcome.description, /update its evidence-weighted confidence/i);
  assert.match(recordOutcome.describe.effects, /does not change lifecycle status/i);
  assert.match(recordOutcome.describe.route, /shadowgraph_update_status changes the lifecycle state/i);

  const confEvidence = find('shadowgraph_confidence_evidence');
  assert.match(confEvidence.description, /no outcome is recorded/i);
  assert.match(confEvidence.describe.effects, /Reusing key cannot double-count/i);
  assert.match(confEvidence.describe.route, /shadowgraph_record_outcome once the decision has played out/i);
});

test('usability regression: profile boundary dead-end resolution for shadowgraph_validate and repair_plan unlink boundary', () => {
  const catalog = buildToolCatalog({ verifier: false });
  const fullValidate = catalog.find((t) => t.name === 'shadowgraph_validate');
  assert.match(fullValidate.describe.route, /shadowgraph_repair_plan proposes repairs; shadowgraph_rebuild checks journal replay/i);

  const repairPlan = catalog.find((t) => t.name === 'shadowgraph_repair_plan');
  const linkTool = catalog.find((t) => t.name === 'shadowgraph_link');
  assert.match(linkTool.describe.effects, /There is no unlink tool/i);
  assert.match(repairPlan.describe.route, /Use after shadowgraph_validate; there is no apply or unlink tool, so repairs require owner or store-level action/i);
  assert.equal(/ordinary tools/i.test(repairPlan.description), false);

  // In Workflow profile, absent tools are qualified and restart guidance is appended
  const workflowCatalog = selectTools(catalog, { profile: 'workflow' });
  const workflowValidate = workflowCatalog.find((t) => t.name === 'shadowgraph_validate');
  assert.ok(workflowValidate, 'shadowgraph_validate exists in workflow profile');
  assert.match(workflowValidate.description, /shadowgraph_repair_plan \(full mode only\)/i);
  assert.match(workflowValidate.description, /shadowgraph_rebuild \(full mode only\)/i);
  assert.match(workflowValidate.description, /ask the operator to unset SHADOWGRAPH_MCP_PROFILE and restart with SHADOWGRAPH_MCP_COMPACT=0/i);

  // In Compact mode, absent tools are also qualified and restart guidance is appended
  const compactCatalog = selectTools(catalog, { compact: true });
  const compactValidate = compactCatalog.find((t) => t.name === 'shadowgraph_validate');
  assert.ok(compactValidate, 'shadowgraph_validate exists in compact profile');
  assert.match(compactValidate.description, /shadowgraph_repair_plan \(full mode only\)/i);
  assert.match(compactValidate.description, /shadowgraph_rebuild \(full mode only\)/i);
  assert.match(compactValidate.description, /ask the operator to restart with SHADOWGRAPH_MCP_COMPACT=0/i);
});

test('usability regression: complete elimination of "reminder" terminology across entire catalog and SERVER_INSTRUCTIONS', () => {
  for (const verifier of [false, true]) {
    const catalog = buildToolCatalog({ verifier });
    for (const tool of catalog) {
      assert.equal(
        /reminder/i.test(tool.description),
        false,
        `${tool.name} must not contain 'reminder' in its composed description; use 'review signal'`
      );
      for (const [key, text] of Object.entries(tool.describe)) {
        assert.equal(
          /reminder/i.test(text),
          false,
          `${tool.name}.describe.${key} must not contain 'reminder'`
        );
      }
    }
  }
  const mcpSource = readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8');
  assert.equal(/reminder/i.test(mcpSource), false, 'src/mcp.js SERVER_INSTRUCTIONS must not use "reminder" terminology');
});

test('usability regression: preservation of all 8 destructive hints in workflow profile', () => {
  const catalog = buildToolCatalog({ verifier: false });
  const workflow = selectTools(catalog, { profile: 'workflow' });
  const destructive = workflow.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort();
  assert.deepEqual(destructive, [
    'shadowgraph_ack_review',
    'shadowgraph_confidence_evidence',
    'shadowgraph_maintain',
    'shadowgraph_record_fact',
    'shadowgraph_record_outcome',
    'shadowgraph_remember',
    'shadowgraph_supersede',
    'shadowgraph_update_status'
  ]);
});

test('usability regression: strict character budget preservation', () => {
  const full = buildToolCatalog({ verifier: false });
  const verifier = buildToolCatalog({ verifier: true });
  const compact = selectTools(full, { compact: true });

  const totalChars = (tools) => tools.reduce((sum, t) => sum + t.description.length, 0);

  const fullChars = totalChars(full);
  const compactChars = totalChars(compact);
  const verifierChars = totalChars(verifier);

  assert.ok(fullChars <= 11700, `Full descriptions total ${fullChars} must be <= 11700`);
  assert.ok(compactChars <= 7000, `Compact descriptions total ${compactChars} must be <= 7000`);
  assert.ok(verifierChars <= 12050, `Verifier descriptions total ${verifierChars} must be <= 12050`);

  for (const tool of verifier) {
    assert.ok(
      tool.description.length <= 450,
      `${tool.name} length ${tool.description.length} exceeds 450 cap`
    );
  }
});
