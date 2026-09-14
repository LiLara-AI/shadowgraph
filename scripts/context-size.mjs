// Measures what a RETRIEVED CONTEXT actually costs, and how much of the evidence
// a caller needs actually arrives.
//
// This is deliberately a different measurement from `scripts/mcp-wire-size.mjs`,
// which measures the tool catalog. Tool-definition bytes and retrieved-context
// bytes are separate quantities and one must never be inferred from the other,
// so they live in separate scripts with separate reports.
//
// Everything here is bytes and milliseconds. Nothing here is tokens: no token
// measurement is taken, so no token claim is made.
//
// Phases are timed separately, because "recall is slow" is not an actionable
// finding -- knowing whether the cost is the snapshot clone, the ranking, or the
// serialization is.
//
// Usage:
//   node scripts/context-size.mjs                print the table
//   node scripts/context-size.mjs --json         print the same data as JSON
//   node scripts/context-size.mjs --diff FILE    compare against saved JSON
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShadowGraph } from '../src/shadowgraph.js';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const PROJECT = 'bench';

// A deterministic corpus. Sizes are fixed so two runs are comparable; the shapes
// mirror what the product actually stores rather than a synthetic blob.
export function seedGraph({ decisions = 40, attempts = 30, facts = 60 } = {}) {
  const graph = createShadowGraph();
  const expected = { violatedKeys: [], reusableAttemptIds: [], decisionIds: [] };

  for (let index = 0; index < decisions; index += 1) {
    const key = `latencyMs${index}`;
    const decision = graph.addDecision({
      project: PROJECT,
      title: `Serve tier ${index} from the regional cache`,
      goal: `Keep tier ${index} reads under the agreed ceiling`,
      chosen: `regional-cache-${index}`,
      assumptions: [`tier ${index} traffic stays within forecast`],
      evidence: [{ source: `runbook-${index}`, detail: `measured p99 for tier ${index}`, sourceClass: 'measured' }],
      alternatives: [{
        label: `origin-only-${index}`,
        reasonRejected: `origin p99 was above the ceiling for tier ${index}`,
        reopenWhen: [{ key, operator: 'greater_than', value: 200, unit: 'ms' }]
      }]
    });
    expected.decisionIds.push(decision.id);
    // Every third decision has a breach, so coverage has something real to find.
    if (index % 3 === 0) {
      graph.addFact({ project: PROJECT, key, value: '450ms', sourceClass: 'measured' });
      expected.violatedKeys.push(key);
    } else {
      graph.addFact({ project: PROJECT, key, value: '20ms', sourceClass: 'measured' });
    }
  }

  for (let index = 0; index < attempts; index += 1) {
    const key = `quotaPerMin${index}`;
    const attempt = graph.addAttempt({
      project: PROJECT,
      solution: `bulk backfill pass ${index}`,
      result: `failed: the upstream quota rejected batch ${index}`,
      resultClass: 'failed',
      reusableWhen: [{ key, operator: 'gte', value: 600 }]
    });
    if (index % 5 === 0) {
      graph.addFact({ project: PROJECT, key, value: 1200, sourceClass: 'measured' });
      expected.reusableAttemptIds.push(attempt.id);
    }
  }

  for (let index = 0; index < facts; index += 1) {
    graph.addFact({ project: PROJECT, key: `unrelated${index}`, value: `value ${index}`, sourceClass: 'human' });
  }

  return { graph, expected };
}

function time(run, iterations = 5) {
  run();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) run();
  return Number(((performance.now() - started) / iterations).toFixed(4));
}

// Coverage is about evidence, not item counts. A context that returns fifty
// records but omits the fact a breach was computed from has not delivered the
// thing the caller needed, and a count would score it perfect.
export function measureCoverage(view, expected) {
  const violated = view.openReviews.flatMap((item) => item.violatedConditions ?? []);
  const violatedKeys = new Set(violated.map((item) => item.key));
  const withEvidence = violated.filter((item) => item.evidence?.factId).length;
  const reusableIds = new Set(view.reusableAttempts.map((item) => item.attemptId));
  const breachesFound = expected.violatedKeys.filter((key) => violatedKeys.has(key)).length;
  const reuseFound = expected.reusableAttemptIds.filter((id) => reusableIds.has(id)).length;
  return {
    expectedBreaches: expected.violatedKeys.length,
    breachesReported: breachesFound,
    breachesWithNamedEvidence: withEvidence,
    expectedReusable: expected.reusableAttemptIds.length,
    reusableReported: reuseFound,
    // A grounded condition is one that names both the value it compared and the
    // fact it came from. An ungrounded verdict is an assertion, not evidence.
    groundedConditionRatio: violated.length ? Number((withEvidence / violated.length).toFixed(4)) : null,
    breachRecall: expected.violatedKeys.length ? Number((breachesFound / expected.violatedKeys.length).toFixed(4)) : null,
    reuseRecall: expected.reusableAttemptIds.length ? Number((reuseFound / expected.reusableAttemptIds.length).toFixed(4)) : null
  };
}

export function measure(options = {}) {
  const { graph, expected } = seedGraph(options);
  const snapshot = graph.exportData();

  const view = graph.context({ project: PROJECT });
  const searchResult = graph.search('regional cache', { project: PROJECT });
  const retrieveResult = graph.retrieve('regional cache', { project: PROJECT });
  const recallResult = graph.recall('regional cache', { project: PROJECT });

  // recall() re-exports the whole graph on every call, so the clone is timed on
  // its own to show how much of recall is ranking and how much is copying.
  const cloneMs = time(() => graph.exportData());
  const recallMs = time(() => graph.recall('regional cache', { project: PROJECT }));
  const contextMs = time(() => graph.context({ project: PROJECT }));
  const searchMs = time(() => graph.search('regional cache', { project: PROJECT }));
  const serializeContextMs = time(() => JSON.stringify(view));

  return {
    corpus: {
      records: snapshot.records.length,
      facts: snapshot.facts.length,
      snapshotBytes: bytes(snapshot)
    },
    contextBytes: {
      total: bytes(view),
      activeDecisions: bytes(view.activeDecisions),
      failedAttemptsToAvoid: bytes(view.failedAttemptsToAvoid),
      openReviews: bytes(view.openReviews),
      conditionDiagnostics: bytes(view.conditionDiagnostics),
      reusableAttempts: bytes(view.reusableAttempts),
      staleAssumptions: bytes(view.staleAssumptions),
      completeness: bytes(view.completeness)
    },
    resultBytes: {
      search: bytes(searchResult),
      retrieve: bytes(retrieveResult),
      recall: bytes(recallResult)
    },
    phaseMs: {
      exportClone: cloneMs,
      context: contextMs,
      search: searchMs,
      recallTotal: recallMs,
      // `exportClone` is measured as a reference point, NOT as a component of
      // recall: recall used to call exportData() and no longer does, so
      // subtracting one from the other would produce a meaningless negative.
      // Keep both and compare them directly.
      recallVsFullClone: Number((recallMs / cloneMs).toFixed(4)),
      serializeContext: serializeContextMs
    },
    coverage: measureCoverage(view, expected)
  };
}

function formatReport(report, baseline) {
  const lines = [];
  const delta = (path, value) => {
    const previous = path.split('.').reduce((node, key) => (node ?? {})[key], baseline);
    if (previous === undefined || previous === null || previous === value) return String(value);
    const change = Number((value - previous).toFixed(4));
    return `${value} (${change > 0 ? '+' : ''}${change})`;
  };
  const section = (title, object, prefix) => {
    lines.push(title);
    const width = Math.max(...Object.keys(object).map((key) => key.length));
    for (const [key, value] of Object.entries(object)) {
      lines.push(`  ${key.padEnd(width)}  ${delta(`${prefix}.${key}`, value)}`);
    }
    lines.push('');
  };
  lines.push('Retrieved-context cost. Bytes are UTF-8 of JSON.stringify(value).');
  lines.push('Tool-definition bytes are a separate measurement: scripts/mcp-wire-size.mjs.');
  lines.push('No token measurement is taken here, so no token claim is made.');
  lines.push('');
  section('corpus', report.corpus, 'corpus');
  section('context bytes', report.contextBytes, 'contextBytes');
  section('result bytes', report.resultBytes, 'resultBytes');
  section('phase milliseconds (mean of 5)', report.phaseMs, 'phaseMs');
  section('factual coverage', report.coverage, 'coverage');
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const report = measure();
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const diffAt = args.indexOf('--diff');
    const baseline = diffAt >= 0 && args[diffAt + 1] ? JSON.parse(await readFile(args[diffAt + 1], 'utf8')) : null;
    process.stdout.write(`${formatReport(report, baseline)}\n`);
  }
}
