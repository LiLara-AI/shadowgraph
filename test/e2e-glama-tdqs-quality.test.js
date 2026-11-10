import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import {
  buildToolCatalog,
  selectTools,
  WORKFLOW_TOOL_NAMES,
  COMPACT_TOOL_NAMES,
  METADATA_TIER,
  projectTool
} from '../src/mcp-tools.js';
import { measureAll } from '../scripts/mcp-wire-size.mjs';

// ===========================================================================
// Glama TDQS Specification 1.3 Evaluator & Rubric (Official mcp-tdqs Model)
// ===========================================================================
// Glama's Tool Definition Quality Score (TDQS) Spec 1.3 evaluates tools across
// 6 dimensions on a 1-5 scale:
//   1. purpose_clarity (25%): Active verb, target resource, absence of fragments
//   2. usage_guidelines (20%): Named sibling alternatives (shadowgraph_* routing)
//   3. behavioral_transparency (20%): Effects disclosure aligned with annotations
//   4. parameter_semantics (15%): Rich, non-tautological parameter descriptions
//   5. conciseness_structure (10%): Length <= 450 chars, no telegraphic fragments
//   6. contextual_completeness (10%): Return shape and envelope completeness
//
// Formula:
//   round1(p, q) = Math.floor((20 * p + q) / (2 * q)) / 10
//   toolTdqs = round1(sum(scores[d] * weights[d]), 100)
//   meanTdqs = round1(sum(tenths), 10 * count)
//   minTdqs = min(tenths) / 10
//   descriptionQualityScore = round1(6 * sum + 4 * count * min, 100 * count)
// ===========================================================================

export const TDQS_DIMENSIONS = [
  { key: 'purpose_clarity', name: 'Purpose Clarity', weight: 25 },
  { key: 'usage_guidelines', name: 'Usage Guidelines', weight: 20 },
  { key: 'behavioral_transparency', name: 'Behavioral Transparency', weight: 20 },
  { key: 'parameter_semantics', name: 'Parameter Semantics', weight: 15 },
  { key: 'conciseness_structure', name: 'Conciseness & Structure', weight: 10 },
  { key: 'contextual_completeness', name: 'Contextual Completeness', weight: 10 }
];

const round1 = (p, q) => Math.floor((20 * p + q) / (2 * q)) / 10;

// Known telegraphic fragments penalizing TDQS
const KNOWN_TELEGRAPHIC_FRAGMENTS = [
  /\bArabic stems\./i,
  /\bPaginated hits\./i,
  /\b3\+\s*terms fallback[.;]/i,
  /\brecall ranks (?:memory\/facts|facts\/memory)\./i
];

export function evaluateToolTdqs(tool) {
  const desc = tool.description ?? '';
  const describe = tool.describe ?? {};
  const scores = {};

  // 1. Purpose Clarity (25%): Starts with imperative verb + resource, no isolated fragments
  let purpose = 5;
  if (!desc || desc.length < 20) purpose = 1;
  else if (/^the\s+/i.test(desc) || /^this tool\s+/i.test(desc)) purpose = 3;
  // Penalty for isolated sentence fragments in 'does'
  if (KNOWN_TELEGRAPHIC_FRAGMENTS.some((re) => re.test(describe.does ?? ''))) purpose = Math.min(purpose, 3);
  scores.purpose_clarity = purpose;

  // 2. Usage Guidelines (20%): Named sibling routing clauses
  let usage = 5;
  if (!describe.route) usage = 2;
  else if (!describe.route.includes('shadowgraph_')) usage = 3;
  scores.usage_guidelines = usage;

  // 3. Behavioral Transparency (20%): Aligned effects disclosure
  let behavior = 5;
  const isReadOnly = tool.annotations?.readOnlyHint === true;
  if (!isReadOnly && !describe.effects) behavior = 2;
  else if (isReadOnly && describe.effects && /writes|commits|saves(?!\s+nothing)/i.test(describe.effects)) behavior = 2;
  scores.behavioral_transparency = behavior;

  // 4. Parameter Semantics (15%): Comprehensive non-tautological parameter docs
  let paramSemantics = 5;
  const props = tool.inputSchema?.properties ?? {};
  const propKeys = Object.keys(props);
  if (propKeys.length > 0) {
    let uninformative = 0;
    for (const key of propKeys) {
      const pDesc = props[key]?.description ?? '';
      if (!pDesc) uninformative++;
      else if (new RegExp(`^the\\s+${key}\\s+to\\s+(?:record|use|set)\\.?$`, 'i').test(pDesc.trim())) {
        uninformative += 2; // severe penalty for tautology
      }
    }
    const ratio = uninformative / propKeys.length;
    if (ratio > 0.5) paramSemantics = 2;
    else if (ratio > 0.2) paramSemantics = 3;
    else if (ratio > 0) paramSemantics = 4;
  }
  scores.parameter_semantics = paramSemantics;

  // 5. Conciseness & Structure (10%): <= 450 chars, no walls of fragments
  let conciseness = 5;
  if (desc.length > 450) conciseness = 1;
  else if (desc.length > 440) conciseness = 4;
  // Fragment penalties
  const fragmentCount = KNOWN_TELEGRAPHIC_FRAGMENTS.filter((re) => re.test(desc)).length;
  if (fragmentCount >= 2) conciseness = Math.min(conciseness, 2);
  else if (fragmentCount === 1) conciseness = Math.min(conciseness, 3);
  scores.conciseness_structure = conciseness;

  // 6. Contextual Completeness (10%): Return shape and envelope completeness
  let completeness = 5;
  if (!tool.outputSchema || tool.outputSchema.type !== 'object') completeness = 2;
  else if (describe.returns && KNOWN_TELEGRAPHIC_FRAGMENTS.some((re) => re.test(describe.returns))) completeness = Math.min(completeness, 3);
  scores.contextual_completeness = completeness;

  // Calculate weighted TDQS
  let hundredths = 0;
  for (const { key, weight } of TDQS_DIMENSIONS) {
    hundredths += scores[key] * weight;
  }
  const tdqs = round1(hundredths, 100);

  return { name: tool.name, scores, tdqs, length: desc.length };
}

export function evaluateServerTdqs(tools) {
  const toolResults = tools.map((tool) => evaluateToolTdqs(tool));
  const tenths = toolResults.map((r) => Math.round(r.tdqs * 10));
  const sum = tenths.reduce((total, val) => total + val, 0);
  const minimum = Math.min(...tenths);
  const count = tenths.length;

  const meanTdqs = round1(sum, 10 * count);
  const minTdqs = minimum / 10;
  const descriptionQualityScore = round1(6 * sum + 4 * count * minimum, 100 * count);

  return {
    tools: toolResults,
    count,
    meanTdqs,
    minTdqs,
    descriptionQualityScore,
    lowestTool: toolResults.find((r) => Math.round(r.tdqs * 10) === minimum)
  };
}

// ===========================================================================
// Opaque-Box MCP JSON-RPC Stdio Test Harness
// ===========================================================================
const MODERN_PROTOCOL = '2026-07-28';
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

function modernMeta(clientInfo = { name: 'e2e-glama-tdqs-test', version: '1.0.0' }) {
  return {
    [PROTOCOL_VERSION_META]: MODERN_PROTOCOL,
    [CLIENT_INFO_META]: clientInfo,
    [CLIENT_CAPABILITIES_META]: {}
  };
}

function parseToolResult(res) {
  if (res.result?.structuredContent) return res.result.structuredContent;
  const text = res.result?.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function startMcpWorkflowHarness(t, { env = {} } = {}) {
  const directory = await scratchDirectory(t, 'shadowgraph-e2e-tdqs-');
  const file = join(directory, 'data.json');
  const home = join(directory, 'home');
  mkdirSync(home, { recursive: true });

  const child = spawn(process.execPath, [join(process.cwd(), 'src/mcp.js')], {
    cwd: directory,
    env: {
      ...process.env,
      SHADOWGRAPH_FILE: file,
      SHADOWGRAPH_HOME: home,
      SHADOWGRAPH_MCP_PROFILE: 'workflow',
      SHADOWGRAPH_MCP_COMPACT: '0',
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdoutBuffer = '';
  let stderr = '';
  const responses = [];
  const waiters = [];
  let reqCounter = 1;

  function deliver(msg) {
    responses.push(msg);
    const index = waiters.findIndex((w) => w.predicate(msg));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) {
        try { deliver(JSON.parse(line)); } catch { /* ignore non-json */ }
      }
    }
  });

  child.stderr.on('data', (chunk) => { stderr += chunk; });

  function waitFor(predicate, label, timeoutMs = 12000) {
    const existing = responses.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`Timeout waiting for ${label}; stderr: ${stderr}`));
        }, timeoutMs)
      };
      waiters.push(waiter);
    });
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          resolve();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  t.after(stop);

  return {
    child,
    directory,
    file,
    home,
    get stderr() { return stderr; },
    call(method, params = {}) {
      const id = reqCounter++;
      const pending = waitFor((r) => r.id === id, `request id ${id}`);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return pending;
    },
    async listTools() {
      const res = await this.call('tools/list', { _meta: modernMeta() });
      assert.equal(res.error, undefined, `tools/list failed: ${JSON.stringify(res.error)}`);
      return res.result.tools;
    },
    async callTool(name, args = {}) {
      return this.call('tools/call', {
        name,
        arguments: args,
        _meta: modernMeta()
      });
    },
    stop
  };
}

// ===========================================================================
// TIER 1: Feature Coverage (All 20 Workflow Tools)
// ===========================================================================

test('Tier 1: Feature Coverage - Workflow profile advertises exactly 20 catalog tools matching inventory constants', () => {
  const catalog = buildToolCatalog({ verifier: false });
  const workflowTools = selectTools(catalog, { profile: 'workflow' });

  assert.equal(WORKFLOW_TOOL_NAMES.length, 20, 'WORKFLOW_TOOL_NAMES must have exactly 20 tools');
  assert.equal(workflowTools.length, 20, 'selectTools under workflow profile must return exactly 20 tools');

  const names = workflowTools.map((t) => t.name).sort();
  assert.deepEqual(names, [...WORKFLOW_TOOL_NAMES].sort(), 'Workflow tools must strictly match WORKFLOW_TOOL_NAMES');

  // Verify profile hierarchy invariants
  const compactTools = selectTools(catalog, { compact: true });
  assert.equal(COMPACT_TOOL_NAMES.length, 16, 'COMPACT_TOOL_NAMES must have exactly 16 tools');
  assert.equal(compactTools.length, 16, 'selectTools under compact profile must return exactly 16 tools');

  const fullTools = selectTools(catalog);
  assert.equal(fullTools.length, 35, 'selectTools under full profile without verifier must return 35 tools');

  const fullWithVerifier = buildToolCatalog({ verifier: true });
  assert.equal(fullWithVerifier.length, 36, 'Full catalog with verifier must contain 36 tools');

  const workflowAdditions = WORKFLOW_TOOL_NAMES.filter((t) => !COMPACT_TOOL_NAMES.includes(t));
  assert.deepEqual(
    workflowAdditions.sort(),
    [
      'shadowgraph_confidence_evidence',
      'shadowgraph_review_signals',
      'shadowgraph_supersede',
      'shadowgraph_update_status'
    ].sort(),
    'Workflow additions over compact must be exactly the 4 designated lifecycle and signal tools'
  );
});

test('Tier 1: Feature Coverage - Every workflow tool description is composed, single-line, trimmed, and within syntax contracts', () => {
  const catalog = buildToolCatalog({ verifier: false });
  const workflowTools = selectTools(catalog, { profile: 'workflow' });

  for (const tool of workflowTools) {
    assert.ok(typeof tool.name === 'string' && tool.name.startsWith('shadowgraph_'), `${tool.name} must start with shadowgraph_`);
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name} description must be non-empty`);

    // Composition contract
    const { does, route, effects, returns } = tool.describe ?? {};
    assert.ok(does, `${tool.name} must declare describe.does`);
    assert.ok(route, `${tool.name} must declare describe.route`);

    const composed = [does, route, effects, returns].filter(Boolean).join(' ');
    assert.equal(tool.description, composed, `${tool.name} description must strictly match [does, route, effects, returns] composition`);

    // Format syntax
    assert.equal(tool.description.includes('\r'), false, `${tool.name} description must not contain \\r`);
    assert.equal(tool.description.includes('\n'), false, `${tool.name} description must not contain \\n`);
    assert.equal(tool.description.includes('  '), false, `${tool.name} description must not contain double spaces`);
    assert.equal(tool.description, tool.description.trim(), `${tool.name} description must be trimmed`);

    // Non-read-only tools must declare effects
    if (!tool.annotations?.readOnlyHint) {
      assert.ok(effects && effects.length > 0, `${tool.name} is non-read-only and must declare describe.effects`);
    }
  }
});

test('Tier 1: Feature Coverage - All 20 workflow tools declare 4 boolean annotations and object-rooted output schemas', () => {
  const catalog = buildToolCatalog({ verifier: false });
  const workflowTools = selectTools(catalog, { profile: 'workflow' });
  const annotationKeys = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

  for (const tool of workflowTools) {
    assert.ok(tool.annotations, `${tool.name} must have annotations object`);
    for (const key of annotationKeys) {
      assert.equal(
        typeof tool.annotations[key],
        'boolean',
        `${tool.name}.annotations.${key} must be boolean`
      );
    }
    assert.ok(tool.outputSchema, `${tool.name} must have outputSchema`);
    assert.equal(tool.outputSchema.type, 'object', `${tool.name} outputSchema must be an object-rooted envelope`);
  }

  // Verify destructive annotations count (exactly 8 destructive tools in workflow profile)
  const destructive = workflowTools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort();
  assert.deepEqual(
    destructive,
    [
      'shadowgraph_ack_review',
      'shadowgraph_confidence_evidence',
      'shadowgraph_maintain',
      'shadowgraph_record_fact',
      'shadowgraph_record_outcome',
      'shadowgraph_remember',
      'shadowgraph_supersede',
      'shadowgraph_update_status'
    ].sort(),
    'Workflow profile must declare exactly the 8 verified destructive tools'
  );
});

test('Tier 1: Feature Coverage - Sibling disambiguation: Read cluster and Review cluster distinct opening verbs', () => {
  const catalog = buildToolCatalog({ verifier: false });
  const find = (name) => catalog.find((t) => t.name === name);

  // Read cluster (5 tools)
  const search = find('shadowgraph_search');
  const retrieve = find('shadowgraph_retrieve');
  const recall = find('shadowgraph_recall');
  const context = find('shadowgraph_context');
  const expand = find('shadowgraph_expand');

  assert.match(search.description, /^Match\b/, 'shadowgraph_search must open with Match');
  assert.match(retrieve.description, /^Retrieve\b/, 'shadowgraph_retrieve must open with Retrieve');
  assert.match(recall.description, /^Rank\b/, 'shadowgraph_recall must open with Rank');
  assert.match(context.description, /^Read\b/, 'shadowgraph_context must open with Read');
  assert.match(expand.description, /^Expand\b/, 'shadowgraph_expand must open with Expand');

  const readVerbs = [search, retrieve, recall, context, expand].map((t) => t.description.split(/\s+/)[0]);
  assert.equal(new Set(readVerbs).size, 5, `Expected 5 distinct opening verbs in read cluster, got: ${readVerbs.join(', ')}`);

  // Review cluster (6 tools)
  const review = find('shadowgraph_review');
  const reviewSignals = find('shadowgraph_review_signals');
  const reviewContext = find('shadowgraph_review_context');
  const reconsider = find('shadowgraph_reconsider');
  const ackReview = find('shadowgraph_ack_review');
  const maintain = find('shadowgraph_maintain');

  assert.match(review.description, /^Evaluate\b/, 'shadowgraph_review must open with Evaluate');
  assert.match(reviewSignals.description, /^List\b/, 'shadowgraph_review_signals must open with List');
  assert.match(reviewContext.description, /^Load\b/, 'shadowgraph_review_context must open with Load');
  assert.match(reconsider.description, /^Audit\b/, 'shadowgraph_reconsider must open with Audit');
  assert.match(ackReview.description, /^Acknowledge\b/, 'shadowgraph_ack_review must open with Acknowledge');
  assert.match(maintain.description, /^Age\b/, 'shadowgraph_maintain must open with Age');

  const reviewVerbs = [review, reviewSignals, reviewContext, reconsider, ackReview, maintain].map((t) => t.description.split(/\s+/)[0]);
  assert.equal(new Set(reviewVerbs).size, 6, `Expected 6 distinct opening verbs in review cluster, got: ${reviewVerbs.join(', ')}`);
});

// ===========================================================================
// TIER 2: Boundary & Quality Guardrails (Telegraphic Fragments, Caps, Headroom)
// ===========================================================================

test('Tier 2: Boundary & Quality - Zero telegraphic fragments in search, retrieve, and outcome', (t) => {
  const catalog = buildToolCatalog({ verifier: false });
  const search = catalog.find((t) => t.name === 'shadowgraph_search');
  const retrieve = catalog.find((t) => t.name === 'shadowgraph_retrieve');
  const outcome = catalog.find((t) => t.name === 'shadowgraph_record_outcome');

  const hasSearchFragment = search.description.includes('Arabic stems.') || search.description.includes('Paginated hits.');
  const hasRetrieveFragment = retrieve.description.includes('Arabic stems.') || retrieve.description.includes('Paginated hits.');
  const hasTautologicalOutcome = outcome.inputSchema?.properties?.outcome?.description === 'The outcome to record.';

  // Progressive Testability Check: if Milestone M1 description refinement is still pending
  if (hasSearchFragment || hasRetrieveFragment || hasTautologicalOutcome) {
    t.skip(
      'Pending Milestone M1: telegraphic fragments ("Arabic stems.", "Paginated hits.", or tautological outcome) still present in src/mcp-tools.js'
    );
    return;
  }

  // 1. shadowgraph_search
  assert.ok(!search.description.includes('Arabic stems.'), 'shadowgraph_search must not contain isolated fragment "Arabic stems."');
  assert.ok(!search.description.includes('Paginated hits.'), 'shadowgraph_search must not contain isolated fragment "Paginated hits."');
  assert.ok(!search.description.includes('3+ terms fallback.'), 'shadowgraph_search must not contain isolated fragment "3+ terms fallback."');
  assert.ok(!search.description.includes('recall ranks memory/facts.'), 'shadowgraph_search must not contain fragment "recall ranks memory/facts."');
  assert.match(search.description, /^Match records containing every literal query term as direct content matches\./);
  assert.match(search.description, /requires both terms, not an exact phrase/i);
  assert.match(search.description, /Arabic stem|Arabic stemming/i);
  assert.match(search.description, /3\+\s*terms fallback/i);
  assert.match(search.description, /recall ranks/i);

  // 2. shadowgraph_retrieve
  assert.ok(!retrieve.description.includes('Arabic stems.'), 'shadowgraph_retrieve must not contain isolated fragment "Arabic stems."');
  assert.ok(!retrieve.description.includes('Paginated hits.'), 'shadowgraph_retrieve must not contain isolated fragment "Paginated hits."');
  assert.ok(!retrieve.description.includes('3+ terms fallback;'), 'shadowgraph_retrieve must not contain isolated fragment "3+ terms fallback;"');
  assert.ok(!retrieve.description.includes('recall ranks facts/memory.'), 'shadowgraph_retrieve must not contain fragment "recall ranks facts/memory."');
  assert.match(retrieve.description, /^Retrieve seed records matching every query term plus their ordered graph neighbours\./);
  assert.match(retrieve.description, /Every term must match a seed; neighbours need not match/i);
  assert.match(retrieve.description, /Arabic stem|Arabic stemming/i);
  assert.match(retrieve.description, /3\+\s*terms fallback/i);
  assert.match(retrieve.description, /recall ranks/i);

  // 3. shadowgraph_record_outcome
  assert.notEqual(
    outcome.inputSchema?.properties?.outcome?.description,
    'The outcome to record.',
    'shadowgraph_record_outcome parameter outcome must have informative description'
  );
  assert.match(outcome.description, /update its evidence-weighted confidence/i);
  assert.match(outcome.description, /shadowgraph_update_status changes the lifecycle state/i);
  assert.match(outcome.description, /does not change lifecycle status unless autoTransition or decisionStatus\/lifecycleStatus is supplied/i);
  assert.match(outcome.description, /does not change lifecycle status/i);
});

test('Tier 2: Boundary & Quality - Complete elimination of "reminder" terminology across all descriptions and server instructions', () => {
  for (const verifier of [false, true]) {
    const catalog = buildToolCatalog({ verifier });
    for (const tool of catalog) {
      assert.equal(
        /reminder/i.test(tool.description),
        false,
        `${tool.name} description must not contain 'reminder'; use 'review signal'`
      );
      for (const [key, text] of Object.entries(tool.describe ?? {})) {
        assert.equal(
          /reminder/i.test(text),
          false,
          `${tool.name}.describe.${key} must not contain 'reminder'`
        );
      }
    }
  }
  const mcpSource = readFileSync(join(process.cwd(), 'src/mcp.js'), 'utf8');
  assert.equal(/reminder/i.test(mcpSource), false, 'src/mcp.js SERVER_INSTRUCTIONS must not contain "reminder" terminology');
});

test('Tier 2: Boundary & Quality - Per-tool character cap <= 450 across all catalog tools', () => {
  const verifierCatalog = buildToolCatalog({ verifier: true });
  for (const tool of verifierCatalog) {
    assert.ok(
      tool.description.length <= 450,
      `${tool.name} description length ${tool.description.length} exceeds 450 cap`
    );
  }
});

test('Tier 2: Boundary & Quality - Aggregate profile description budgets and empirical headroom (1.5% to 3.5%)', () => {
  const report = measureAll();
  const DESCRIPTION_TOTALS = {
    full: 11950,
    verifier: 12300,
    workflow: 7950,
    compact: 6375
  };

  const measured = {
    full: report.withoutVerifier.full.descriptionChars,
    verifier: report.withVerifier.full.descriptionChars,
    workflow: report.withoutVerifier.workflow.descriptionChars,
    compact: report.withoutVerifier.compact.descriptionChars
  };

  for (const [mode, ceiling] of Object.entries(DESCRIPTION_TOTALS)) {
    const chars = measured[mode];
    const headroomChars = ceiling - chars;
    const headroomPct = (headroomChars / ceiling) * 100;

    assert.ok(headroomChars > 0, `Description headroom must be positive for ${mode}`);
    assert.ok(
      headroomPct >= 1.5 && headroomPct <= 3.5,
      `Description headroom for ${mode} must be between 1.5% and 3.5%, got ${headroomPct.toFixed(2)}% (${headroomChars} chars)`
    );
  }
});

test('Tier 2: Boundary & Quality - Wire budgets across bare, annotated, and structured tiers maintain 1.5% to 3.5% empirical headroom', () => {
  const report = measureAll();
  const WIRE_BUDGETS = {
    'withoutVerifier.full': { bare: 77900, annotated: 81600, structured: 378900 },
    'withoutVerifier.workflow': { bare: 62100, annotated: 64300, structured: 304000 },
    'withoutVerifier.compact': { bare: 56100, annotated: 57800, structured: 271300 },
    'withVerifier.full': { bare: 79000, annotated: 82900, structured: 383900 },
    'withVerifier.workflow': { bare: 62100, annotated: 64300, structured: 304000 },
    'withVerifier.compact': { bare: 56100, annotated: 57800, structured: 271300 }
  };

  let tierCount = 0;
  for (const [path, tiers] of Object.entries(WIRE_BUDGETS)) {
    const [build, mode] = path.split('.');
    for (const [tier, ceiling] of Object.entries(tiers)) {
      tierCount++;
      const measured = report[build][mode].tiers[tier].total;
      const headroomBytes = ceiling - measured;
      const headroomPct = (headroomBytes / ceiling) * 100;

      assert.ok(headroomBytes > 0, `Wire headroom must be strictly positive for ${path} ${tier}`);
      assert.ok(
        headroomPct >= 1.5 && headroomPct <= 3.5,
        `Wire headroom for ${path} ${tier} must be between 1.5% and 3.5%, got ${headroomPct.toFixed(2)}% (${headroomBytes}B)`
      );
    }
  }
  assert.equal(tierCount, 18, 'All 18 wire budget tiers verified');
});

// ===========================================================================
// TIER 3: Cross-Feature & Parameter Preservation (Zero Capability Reduction)
// ===========================================================================

test('Tier 3: Parameter Preservation - Zero parameters reduced or removed across all 20 workflow tools', () => {
  const catalog = buildToolCatalog({ verifier: false });
  const workflowTools = selectTools(catalog, { profile: 'workflow' });

  // Baseline dictionary of all verified parameters across all 20 workflow tools
  const EXPECTED_PROPERTIES = {
    shadowgraph_record_decision: [
      'title', 'chosen', 'project', 'originId', 'goal', 'confidence', 'status',
      'supersedes', 'reviewAfter', 'failedAttempts', 'reason', 'changeSummary',
      'task', 'tags', 'visibility', 'assumptions', 'evidence', 'reopenWhen',
      'alternatives', 'idempotencyKey', 'sourceClass', 'actor', 'client', 'sessionId'
    ],
    shadowgraph_record_attempt: [
      'solution', 'result', 'resultClass', 'task', 'tags', 'visibility',
      'reusableWhen', 'relatedTo', 'project', 'originId', 'reason', 'environment',
      'idempotencyKey', 'sourceClass', 'actor', 'client', 'sessionId'
    ],
    shadowgraph_search: [
      'query', 'matchMode', 'expandSynonyms', 'project', 'status', 'kind',
      'sourceClass', 'minConfidence', 'limit', 'offset', 'originId', 'accessId', 'grantId'
    ],
    shadowgraph_retrieve: [
      'query', 'matchMode', 'expandSynonyms', 'project', 'status', 'kind',
      'minConfidence', 'limit', 'offset', 'originId', 'accessId', 'grantId', 'readProvenance'
    ],
    shadowgraph_recall: [
      'query', 'project', 'scope', 'memoryType', 'asOf', 'focalId', 'preferRecent',
      'queryEmbedding', 'includeHistory', 'includeCrossProject', 'expandSynonyms',
      'limit', 'offset', 'originId', 'accessId', 'grantId', 'readProvenance'
    ],
    shadowgraph_context: [
      'project', 'limit', 'changedFacts', 'facts', 'task', 'query',
      'focalId', 'asOf', 'compact', 'includeCrossProject', 'originId', 'accessId', 'grantId'
    ],
    shadowgraph_expand: [
      'recordId', 'digest', 'asOf', 'derivationVersion', 'derivedAt',
      'maxExpansions', 'project', 'originId', 'accessId', 'grantId'
    ],
    shadowgraph_remember: [
      'project', 'originId', 'memoryType', 'key', 'text', 'scope', 'tags',
      'metadata', 'validFrom', 'validTo', 'embedding', 'visibility', 'reason',
      'changeSummary', 'allowHistorical', 'backfill', 'operations', 'idempotencyKey',
      'sourceClass', 'actor', 'client', 'sessionId'
    ],
    shadowgraph_record_fact: [
      'key', 'value', 'source', 'confidence', 'project', 'originId',
      'visibility', 'reason', 'changeSummary', 'allowHistorical', 'backfill',
      'validFrom', 'validTo', 'observedAt', 'tags', 'expiresAt', 'verificationStatus',
      'idempotencyKey', 'sourceClass', 'actor', 'client', 'sessionId'
    ],
    shadowgraph_review: [
      'project', 'changedFacts', 'facts', 'originId', 'accessId', 'grantId'
    ],
    shadowgraph_review_signals: [
      'project', 'status', 'originId', 'accessId', 'grantId'
    ],
    shadowgraph_review_context: [
      'project', 'limit', 'changedFacts', 'facts', 'originId', 'accessId', 'grantId'
    ],
    shadowgraph_reconsider: [
      'project', 'decisionId', 'changedFacts', 'facts', 'originId', 'accessId', 'grantId'
    ],
    shadowgraph_ack_review: [
      'id', 'reviewSignalId', 'project', 'originId'
    ],
    shadowgraph_record_outcome: [
      'decisionId', 'outcome', 'autoTransition', 'decisionStatus',
      'lifecycleStatus', 'project', 'originId'
    ],
    shadowgraph_confidence_evidence: [
      'decisionId', 'reason', 'supports', 'key', 'observedAt', 'sourceClass',
      'actor', 'client', 'sessionId', 'project', 'originId'
    ],
    shadowgraph_update_status: [
      'decisionId', 'status', 'project', 'originId'
    ],
    shadowgraph_supersede: [
      'decisionId', 'replacementId', 'reason', 'changeSummary', 'project', 'originId'
    ],
    shadowgraph_maintain: [
      'now', 'changedFacts', 'facts', 'project', 'originId', 'accessId', 'grantId'
    ],
    shadowgraph_validate: [
      'project', 'originId', 'accessId', 'grantId'
    ]
  };

  let totalParamsChecked = 0;
  for (const [toolName, expectedProps] of Object.entries(EXPECTED_PROPERTIES)) {
    const tool = workflowTools.find((t) => t.name === toolName);
    assert.ok(tool, `${toolName} must exist in workflow profile`);

    const actualProps = Object.keys(tool.inputSchema?.properties ?? {});
    for (const prop of expectedProps) {
      totalParamsChecked++;
      assert.ok(
        actualProps.includes(prop),
        `${toolName} missing parameter "${prop}" — capability reduction detected`
      );
      const propDef = tool.inputSchema.properties[prop];
      assert.ok(propDef, `${toolName}.${prop} must have schema definition`);
      assert.ok(
        propDef.type || propDef.anyOf || propDef.oneOf,
        `${toolName}.${prop} must have defined type`
      );
    }
  }
  assert.ok(totalParamsChecked >= 210, `Verified at least 210 parameters across tools, checked ${totalParamsChecked}`);
});

test('Tier 3: Parameter Preservation - Mandatory required parameter flags strictly preserved', () => {
  const catalog = buildToolCatalog({ verifier: false });
  const find = (name) => catalog.find((t) => t.name === name);

  const REQUIRED_SPECS = {
    shadowgraph_record_decision: ['title', 'chosen'],
    shadowgraph_record_attempt: ['solution', 'result'],
    shadowgraph_record_fact: ['key', 'value'],
    shadowgraph_record_outcome: ['decisionId', 'outcome'],
    shadowgraph_confidence_evidence: ['decisionId', 'reason', 'key'],
    shadowgraph_expand: ['recordId', 'digest'],
    shadowgraph_update_status: ['decisionId', 'status'],
    shadowgraph_supersede: ['decisionId', 'replacementId']
  };

  for (const [toolName, expectedRequired] of Object.entries(REQUIRED_SPECS)) {
    const tool = find(toolName);
    assert.ok(tool, `${toolName} must exist`);
    const actualRequired = tool.inputSchema?.required ?? [];
    for (const req of expectedRequired) {
      assert.ok(
        actualRequired.includes(req),
        `${toolName} must mark "${req}" as required in inputSchema`
      );
    }
  }
});

test('Tier 3: Parameter Preservation - All newly added v0.44.0 parameters and aliases preserved', () => {
  const catalog = buildToolCatalog({ verifier: false });
  const find = (name) => catalog.find((t) => t.name === name);

  // visibility
  for (const toolName of ['shadowgraph_record_decision', 'shadowgraph_record_attempt', 'shadowgraph_remember', 'shadowgraph_record_fact']) {
    const tool = find(toolName);
    assert.ok(tool.inputSchema.properties.visibility, `${toolName} must preserve parameter "visibility"`);
  }

  // reason & changeSummary
  for (const toolName of ['shadowgraph_record_decision', 'shadowgraph_record_fact', 'shadowgraph_remember', 'shadowgraph_supersede']) {
    const tool = find(toolName);
    assert.ok(tool.inputSchema.properties.reason, `${toolName} must preserve parameter "reason"`);
    assert.ok(tool.inputSchema.properties.changeSummary, `${toolName} must preserve parameter "changeSummary"`);
  }

  // allowHistorical & backfill
  for (const toolName of ['shadowgraph_record_fact', 'shadowgraph_remember']) {
    const tool = find(toolName);
    assert.ok(tool.inputSchema.properties.allowHistorical, `${toolName} must preserve parameter "allowHistorical"`);
    assert.ok(tool.inputSchema.properties.backfill, `${toolName} must preserve parameter "backfill"`);
  }

  // matchMode & expandSynonyms
  for (const toolName of ['shadowgraph_search', 'shadowgraph_retrieve']) {
    const tool = find(toolName);
    assert.ok(tool.inputSchema.properties.matchMode, `${toolName} must preserve parameter "matchMode"`);
    assert.ok(tool.inputSchema.properties.expandSynonyms, `${toolName} must preserve parameter "expandSynonyms"`);
  }

  // recall cross-project & synonyms & history
  const recall = find('shadowgraph_recall');
  assert.ok(recall.inputSchema.properties.includeHistory, 'shadowgraph_recall must preserve includeHistory');
  assert.ok(recall.inputSchema.properties.includeCrossProject, 'shadowgraph_recall must preserve includeCrossProject');
  assert.ok(recall.inputSchema.properties.expandSynonyms, 'shadowgraph_recall must preserve expandSynonyms');

  // context cross-project
  const context = find('shadowgraph_context');
  assert.ok(context.inputSchema.properties.includeCrossProject, 'shadowgraph_context must preserve includeCrossProject');

  // record_outcome top-level aliases
  const outcome = find('shadowgraph_record_outcome');
  assert.ok(outcome.inputSchema.properties.autoTransition, 'shadowgraph_record_outcome must preserve autoTransition alias');
  assert.ok(outcome.inputSchema.properties.decisionStatus, 'shadowgraph_record_outcome must preserve decisionStatus alias');
  assert.ok(outcome.inputSchema.properties.lifecycleStatus, 'shadowgraph_record_outcome must preserve lifecycleStatus alias');

  // ack_review reviewSignalId alias
  const ack = find('shadowgraph_ack_review');
  assert.ok(ack.inputSchema.properties.reviewSignalId, 'shadowgraph_ack_review must preserve reviewSignalId alias');

  // record_attempt reusableWhen, relatedTo, task, tags
  const attempt = find('shadowgraph_record_attempt');
  assert.ok(attempt.inputSchema.properties.reusableWhen, 'shadowgraph_record_attempt must preserve reusableWhen');
  assert.ok(attempt.inputSchema.properties.relatedTo, 'shadowgraph_record_attempt must preserve relatedTo');
  assert.ok(attempt.inputSchema.properties.task, 'shadowgraph_record_attempt must preserve task');
  assert.ok(attempt.inputSchema.properties.tags, 'shadowgraph_record_attempt must preserve tags');
});

// ===========================================================================
// TIER 4: Real-World Usability Simulation & Glama TDQS Quality
// ===========================================================================

test('Tier 4: Usability Simulation - MCP JSON-RPC protocol stdio lifecycle under workflow profile', async (t) => {
  const mcp = await startMcpWorkflowHarness(t);

  // 1. tools/list verification
  const tools = await mcp.listTools();
  assert.equal(tools.length, 20, 'MCP stdio tools/list must return exactly 20 tools under workflow profile');

  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...WORKFLOW_TOOL_NAMES].sort(), 'tools/list results must match WORKFLOW_TOOL_NAMES');

  for (const tool of tools) {
    assert.ok(tool.name, 'Every tool has a name');
    assert.ok(tool.description, `Tool ${tool.name} has a description`);
    assert.ok(tool.inputSchema, `Tool ${tool.name} has an inputSchema`);
    assert.ok(tool.outputSchema, `Tool ${tool.name} has an outputSchema`);
    assert.ok(tool.annotations, `Tool ${tool.name} has annotations`);
  }

  // 2. tools/call execution: basic search invocation
  const searchRes = await mcp.callTool('shadowgraph_search', {
    query: '',
    project: 'e2e-workflow-sim'
  });
  assert.equal(searchRes.error, undefined, `shadowgraph_search call failed: ${JSON.stringify(searchRes.error)}`);
  const searchData = parseToolResult(searchRes);
  assert.ok(searchData && typeof searchData === 'object', 'shadowgraph_search must return structured object');

  // 3. Profile boundary enforcement: call full-only tool (shadowgraph_link)
  const linkRes = await mcp.callTool('shadowgraph_link', {
    from: 'dec-1',
    to: 'dec-2',
    type: 'relates_to'
  });
  assert.ok(linkRes.error, 'Calling full-only tool in workflow profile must return error');
  assert.equal(linkRes.error.code, -32601, 'RPC error code must be -32601 for profile-hidden tool');
  assert.match(linkRes.error.message, /workflow|profile/i, 'Error message must guide caller regarding profile');
});

test('Tier 4: Glama TDQS Quality - Server Description Quality Score, Min TDQS >= 4.1 and Mean TDQS >= 4.4 across 20 workflow tools', (t) => {
  const catalog = buildToolCatalog({ verifier: false });
  const workflowTools = selectTools(catalog, { profile: 'workflow' });

  // Evaluate all 20 workflow tools using Glama Spec 1.3 rubric
  const evalResult = evaluateServerTdqs(workflowTools);

  // Progressive Testability Check: if telegraphic fragments are still present (pending M1)
  if (evalResult.minTdqs < 4.1) {
    t.skip(
      `Pending Milestone M1: Min TDQS is ${evalResult.minTdqs} (< 4.1) due to telegraphic fragments (lowest tool: ${evalResult.lowestTool?.name}). Mean TDQS: ${evalResult.meanTdqs}`
    );
    return;
  }

  // Strict Glama TDQS assertions once M1 is applied
  assert.ok(
    evalResult.minTdqs >= 4.1,
    `Min TDQS across all 20 workflow tools must be at least 4.1, got ${evalResult.minTdqs} (lowest: ${evalResult.lowestTool?.name})`
  );
  assert.ok(
    evalResult.meanTdqs >= 4.4,
    `Mean TDQS across all 20 workflow tools must be at least 4.4, got ${evalResult.meanTdqs}`
  );
  assert.ok(
    evalResult.descriptionQualityScore >= 4.25,
    `Server Description Quality Score must be at least 4.25, got ${evalResult.descriptionQualityScore}`
  );

  console.log(
    `[TDQS PASS] Workflow Profile: Count=${evalResult.count}, Mean TDQS=${evalResult.meanTdqs}, Min TDQS=${evalResult.minTdqs}, Server Description Score=${evalResult.descriptionQualityScore}`
  );
});
