// ShadowGraph journal benchmark — settles X-2 (do snapshots/compaction pay for
// themselves?) with measurements instead of intuition.
//
// Run:  node scripts/bench-journal.mjs [--sizes 1000,10000] [--runs 5] [--json]
//
// Not part of `npm test`: it writes temp files and takes seconds, so it must not
// slow the unit suite. Results belong in docs/benchmark-report.md.
//
// Thresholds pre-declared in ADR-0001 D13 — stated BEFORE measuring so the
// verdict cannot be rationalised after seeing the numbers:
//   - rebuild p95 > 250 ms at 10k entries, or > 1 s at 100k
//   - journal bytes > 10x live projection bytes at 10k entries

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createShadowGraph, rebuildProjection } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';

const THRESHOLDS = {
  rebuildMsAt10k: 250,
  rebuildMsAt100k: 1000,
  journalSizeRatioAt10k: 10
};

// P2-17: accept BOTH `--sizes 1000,10000` and `--sizes=1000,10000`. npm passes
// `npm run bench -- --sizes=1000,10000` through as a single `=`-joined token, so a
// space-only parser silently ignored the flag and reported DEFAULT sizes as if
// they were the requested ones — a benchmark claim about the wrong input.
// The parsed values are echoed in the output so the run is self-verifying.
function parseArgs(argv) {
  const args = { sizes: [1000, 10000], runs: 5, json: false, explicit: [] };
  const tokens = [];
  for (const token of argv) {
    if (token.startsWith('--') && token.includes('=')) {
      const at = token.indexOf('=');
      tokens.push(token.slice(0, at), token.slice(at + 1));
    } else tokens.push(token);
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === '--sizes') {
      const raw = tokens[++index];
      const sizes = String(raw ?? '').split(',').map((value) => Number(value.trim()));
      if (!sizes.length || sizes.some((value) => !Number.isInteger(value) || value < 1)) {
        throw new Error(`--sizes must be a comma-separated list of positive integers, received: ${raw}`);
      }
      args.sizes = sizes;
      args.explicit.push('sizes');
    } else if (tokens[index] === '--runs') {
      const raw = tokens[++index];
      const runs = Number(raw);
      if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, received: ${raw}`);
      args.runs = runs;
      args.explicit.push('runs');
    } else if (tokens[index] === '--json') {
      args.json = true;
      args.explicit.push('json');
    } else if (tokens[index].startsWith('--')) {
      throw new Error(`Unknown argument: ${tokens[index]}`);
    }
  }
  return args;
}

// Deterministic clock and ids: a benchmark must be re-runnable and comparable.
function fixedGraph() {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + tick++ * 1000).toISOString();
  return createShadowGraph({ now });
}

/** Build a graph whose journal holds approximately `target` entries. */
function buildGraph(target) {
  const graph = fixedGraph();
  // Each cycle emits ~5 entries: decision, fact, status change, outcome, confidence.
  const cycles = Math.max(1, Math.ceil(target / 5));
  const decisionIds = [];
  for (let index = 0; index < cycles; index += 1) {
    const project = `project_${index % 10}`;
    const decision = graph.addDecision({
      project,
      title: `Decision ${index}: choose a storage engine`,
      goal: 'Keep the deployment single-user and operationally cheap',
      chosen: index % 2 ? 'sqlite' : 'json',
      assumptions: ['single user', 'local-first'],
      evidence: [{ source: 'benchmark', detail: `synthetic evidence ${index}` }],
      alternatives: [
        { label: 'postgres', reasonRejected: 'operational burden for one user', reopenWhen: [{ key: 'deployment', operator: 'equals', value: 'multi-user' }] },
        { label: 'redis', reasonRejected: 'no durable audit trail' }
      ],
      sourceClass: 'tool_observed',
      actor: 'bench',
      client: 'bench-cli',
      sessionId: 'bench-session'
    });
    decisionIds.push(decision.id);
    graph.addFact({ project, key: `fact_${index}`, value: index, sourceClass: 'tool_observed' });
    graph.updateDecisionStatus(decision.id, 'in_progress');
    graph.setOutcome(decision.id, { status: index % 3 === 0 ? 'failed' : 'successful', lesson: `lesson ${index}` });
  }
  return { graph, decisionIds };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank];
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function fileBytes(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function measure(size, runs) {
  const { graph } = buildGraph(size);
  const exported = graph.exportData();
  const journal = exported.journal ?? [];

  // Rebuild timing — the pure fold, measured in isolation.
  const timings = [];
  let report = null;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    report = rebuildProjection(journal, { journalEpoch: exported.journalEpoch });
    timings.push(performance.now() - started);
  }

  // Size accounting. The projection excludes journal/events, so the ratio
  // answers "what does keeping full snapshots actually cost?"
  const projectionOnly = {
    schemaVersion: exported.schemaVersion,
    records: exported.records,
    facts: exported.facts,
    relations: exported.relations
  };
  const journalBytes = bytes(journal);
  const projectionBytes = bytes(projectionOnly);

  // Backend persistence timing, measured separately for JSON and SQLite.
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-bench-'));
  const backends = {};
  try {
    const jsonPath = join(directory, 'bench.json');
    const jsonStore = createJsonFileStore(jsonPath);
    let started = performance.now();
    await jsonStore.save(exported);
    const jsonSaveMs = performance.now() - started;
    started = performance.now();
    const jsonLoaded = await jsonStore.load();
    const jsonLoadMs = performance.now() - started;
    backends.json = {
      saveMs: Number(jsonSaveMs.toFixed(2)),
      loadMs: Number(jsonLoadMs.toFixed(2)),
      fileBytes: await fileBytes(jsonPath),
      journalEntriesRoundTripped: (jsonLoaded.journal ?? []).length
    };

    try {
      const sqlitePath = join(directory, 'bench.sqlite');
      const sqliteStore = await createSqliteStore(sqlitePath);
      started = performance.now();
      await sqliteStore.save(exported);
      const sqliteSaveMs = performance.now() - started;
      started = performance.now();
      const sqliteLoaded = await sqliteStore.load();
      const sqliteLoadMs = performance.now() - started;
      await sqliteStore.close?.();
      backends.sqlite = {
        saveMs: Number(sqliteSaveMs.toFixed(2)),
        loadMs: Number(sqliteLoadMs.toFixed(2)),
        fileBytes: await fileBytes(sqlitePath),
        journalEntriesRoundTripped: (sqliteLoaded.journal ?? []).length
      };
    } catch (error) {
      // Reported, never silently omitted.
      backends.sqlite = { skipped: String(error.message ?? error) };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  return {
    requestedSize: size,
    journalEntries: journal.length,
    decisions: exported.records.filter((item) => item.kind === 'decision').length,
    facts: exported.facts.length,
    rebuild: {
      runs,
      p50Ms: Number(percentile(timings, 0.5).toFixed(2)),
      p95Ms: Number(percentile(timings, 0.95).toFixed(2)),
      minMs: Number(Math.min(...timings).toFixed(2)),
      maxMs: Number(Math.max(...timings).toFixed(2)),
      rebuildable: report?.rebuildable ?? null,
      applied: report?.applied ?? null,
      rebuiltRecords: report?.projection.records.length ?? null,
      rebuiltFacts: report?.projection.facts.length ?? null
    },
    size: {
      journalBytes,
      projectionBytes,
      ratio: Number((journalBytes / Math.max(1, projectionBytes)).toFixed(2))
    },
    backends
  };
}

function verdict(results) {
  const findings = [];
  for (const result of results) {
    if (result.journalEntries >= 9000 && result.journalEntries < 20000) {
      if (result.rebuild.p95Ms > THRESHOLDS.rebuildMsAt10k) findings.push(`rebuild p95 ${result.rebuild.p95Ms}ms exceeds ${THRESHOLDS.rebuildMsAt10k}ms at ~10k`);
      if (result.size.ratio > THRESHOLDS.journalSizeRatioAt10k) findings.push(`journal/projection ratio ${result.size.ratio}x exceeds ${THRESHOLDS.journalSizeRatioAt10k}x at ~10k`);
    }
    if (result.journalEntries >= 90000 && result.rebuild.p95Ms > THRESHOLDS.rebuildMsAt100k) {
      findings.push(`rebuild p95 ${result.rebuild.p95Ms}ms exceeds ${THRESHOLDS.rebuildMsAt100k}ms at ~100k`);
    }
  }
  return {
    thresholds: THRESHOLDS,
    breaches: findings,
    snapshotsNeeded: findings.length > 0,
    statement: findings.length
      ? 'At least one pre-declared threshold was breached. Snapshots/compaction now require a new ADR.'
      : 'No pre-declared threshold was breached. Snapshots/compaction stay DEFERRED BY MEASUREMENT, not by guess.'
  };
}

const args = parseArgs(process.argv.slice(2));
const results = [];
for (const size of args.sizes) results.push(await measure(size, args.runs));
const output = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  sizes: args.sizes,
  runs: args.runs,
  results,
  verdict: verdict(results)
};

if (args.json) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`ShadowGraph journal benchmark — Node ${output.node} on ${output.platform}`);
  console.log(`generated ${output.generatedAt}, ${args.runs} runs per size\n`);
  for (const result of results) {
    console.log(`entries=${result.journalEntries} (requested ${result.requestedSize}) decisions=${result.decisions} facts=${result.facts}`);
    console.log(`  rebuild   p50=${result.rebuild.p50Ms}ms p95=${result.rebuild.p95Ms}ms min=${result.rebuild.minMs}ms max=${result.rebuild.maxMs}ms rebuildable=${result.rebuild.rebuildable} applied=${result.rebuild.applied}`);
    console.log(`  rebuilt   records=${result.rebuild.rebuiltRecords} facts=${result.rebuild.rebuiltFacts}`);
    console.log(`  size      journal=${result.size.journalBytes}B projection=${result.size.projectionBytes}B ratio=${result.size.ratio}x`);
    for (const [name, backend] of Object.entries(result.backends)) {
      if (backend.skipped) console.log(`  ${name.padEnd(9)} SKIPPED — ${backend.skipped}`);
      else console.log(`  ${name.padEnd(9)} save=${backend.saveMs}ms load=${backend.loadMs}ms file=${backend.fileBytes}B journalRoundTripped=${backend.journalEntriesRoundTripped}`);
    }
    console.log('');
  }
  console.log(`VERDICT: ${output.verdict.statement}`);
  if (output.verdict.breaches.length) for (const breach of output.verdict.breaches) console.log(`  - ${breach}`);
}
