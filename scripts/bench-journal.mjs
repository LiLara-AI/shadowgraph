// ShadowGraph journal benchmark — preregistered, resource-aware JSON/SQLite evidence.
// Master mode runs every requested size sequentially in a fresh Node process.
// Default: 1k (5 rebuilds), 10k (5), 100k (3).

import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, release as osRelease, totalmem, type as osType, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { validateJournalBenchmark } from '../benchmark/lib/journal-validation.mjs';
import { createShadowGraph, rebuildProjection } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const DEFAULT_SIZES = Object.freeze([1000, 10000, 100000]);
const DEFAULT_RUNS_BY_SIZE = Object.freeze({ 1000: 5, 10000: 5, 100000: 3 });
const THRESHOLDS = Object.freeze({
  rebuildMsAt10k: 250,
  rebuildMsAt100k: 1000,
  journalSizeRatioAt10k: 10
});

function tokenizeArgs(argv) {
  const tokens = [];
  for (const token of argv) {
    if (token.startsWith('--') && token.includes('=')) {
      const at = token.indexOf('=');
      tokens.push(token.slice(0, at), token.slice(at + 1));
    } else tokens.push(token);
  }
  return tokens;
}

function parseArgs(argv) {
  const args = {
    sizes: [...DEFAULT_SIZES],
    runs: null,
    json: false,
    describe: false,
    worker: false,
    size: null,
    jsonOut: null,
    humanOut: null
  };
  const tokens = tokenizeArgs(argv);
  const booleanOptions = new Set(['--json', '--describe', '--worker']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (booleanOptions.has(token)) {
      const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      args[key] = true;
      continue;
    }
    const raw = tokens[++index];
    if (raw === undefined || raw.startsWith('--')) throw new Error(`${token} requires a value`);
    if (token === '--sizes') {
      const values = raw.split(',').map((value) => Number(value.trim()));
      if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value < 1)) {
        throw new Error(`--sizes must be a comma-separated list of positive integers, received: ${raw}`);
      }
      if (new Set(values).size !== values.length) throw new Error('--sizes must not contain duplicates');
      args.sizes = values;
    } else if (token === '--runs') {
      args.runs = positiveInteger(raw, '--runs');
    } else if (token === '--size') {
      args.size = positiveInteger(raw, '--size');
    } else if (token === '--json-out') args.jsonOut = raw;
    else if (token === '--human-out') args.humanOut = raw;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (args.worker && (!args.size || !args.runs)) throw new Error('worker mode requires --size and --runs');
  return args;
}

function positiveInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, received: ${raw}`);
  return value;
}

function environmentCapture() {
  const cpuList = cpus();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os: { type: osType(), release: osRelease() },
    cpu: { model: cpuList[0]?.model ?? 'unknown', logicalCount: cpuList.length },
    totalMemoryBytes: totalmem()
  };
}

function fixedGraph() {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1) + tick++ * 1000).toISOString();
  return createShadowGraph({ now });
}

function buildGraph(target) {
  let graph = fixedGraph();
  const cycles = Math.max(1, Math.ceil(target / 5));
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
    graph.addFact({ project, key: `fact_${index}`, value: index, sourceClass: 'tool_observed' });
    graph.updateDecisionStatus(decision.id, 'in_progress');
    graph.setOutcome(decision.id, { status: index % 3 === 0 ? 'failed' : 'successful', lesson: `lesson ${index}` });
  }
  const exported = graph.exportData();
  graph = null;
  return exported;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank];
}

function rounded(value) {
  return Number(value.toFixed(3));
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function storageFootprint(path) {
  const candidates = [
    ['main', path],
    ['wal', `${path}-wal`],
    ['shm', `${path}-shm`]
  ];
  const storageFiles = [];
  for (const [role, candidate] of candidates) {
    const details = await stat(candidate).catch(() => null);
    if (details) storageFiles.push({ role, bytes: details.size });
  }
  return {
    storageFiles,
    fileBytes: storageFiles.reduce((total, file) => total + file.bytes, 0)
  };
}

function comparable(data) {
  return {
    schemaVersion: data.schemaVersion,
    records: data.records,
    facts: data.facts,
    relations: data.relations,
    journalEpoch: data.journalEpoch,
    journal: data.journal
  };
}

function sortEntitiesById(items = []) {
  return [...items].sort((left, right) => {
    const leftId = String(left?.id ?? '');
    const rightId = String(right?.id ?? '');
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

function projectionComparable(data) {
  return {
    records: sortEntitiesById(data.records),
    facts: sortEntitiesById(data.facts),
    relations: sortEntitiesById(data.relations)
  };
}

function plainJsonEquivalent(left, right) {
  if (left === right || (typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right))) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) if (!plainJsonEquivalent(left[index], right[index])) return false;
    return true;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !plainJsonEquivalent(left[key], right[key])) return false;
  }
  return true;
}

function memorySampler() {
  const samples = [];
  return {
    sample(label) {
      samples.push({ label, rssBytes: process.memoryUsage().rss });
    },
    report() {
      const rss = process.memoryUsage().rss;
      const all = [...samples.map((sample) => sample.rssBytes), rss];
      return {
        metric: 'sampled-process-rss-bytes',
        method: 'process.memoryUsage().rss sampled at deterministic phase boundaries; peakSampledBytes is a proxy, not a continuous peak',
        currentBytes: rss,
        peakSampledBytes: Math.max(...all),
        samples,
        resourceUsageMaxRssKilobytes: process.resourceUsage().maxRSS
      };
    }
  };
}

async function measureBackend(name, path, exported, memory) {
  let store;
  let loaded;
  try {
    store = name === 'json' ? createJsonFileStore(path) : await createSqliteStore(path);
    let started = performance.now();
    await store.save(exported);
    const saveMs = performance.now() - started;
    memory.sample(`${name}-saved`);
    started = performance.now();
    loaded = await store.load();
    const loadMs = performance.now() - started;
    memory.sample(`${name}-loaded`);
    const actualEntries = (loaded.journal ?? []).length;
    const roundTripEquivalent = plainJsonEquivalent(comparable(loaded), comparable(exported));
    await store.close?.();
    store = null;
    const footprint = await storageFootprint(path);
    return {
      status: 'MEASURED',
      saveMs: rounded(saveMs),
      loadMs: rounded(loadMs),
      ...footprint,
      actualEntries,
      roundTripEquivalent
    };
  } catch (error) {
    try { await store?.close?.(); } catch { /* retain the original benchmark failure */ }
    store = null;
    const footprint = await storageFootprint(path);
    return {
      status: 'FAILED',
      saveMs: null,
      loadMs: null,
      ...footprint,
      actualEntries: null,
      roundTripEquivalent: null,
      error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) }
    };
  } finally {
    loaded = null;
    try { await store?.close?.(); } catch { /* backend close failure does not erase captured metrics */ }
  }
}

async function measureWorker(requestedEntries, runs) {
  const wallStarted = performance.now();
  const memory = memorySampler();
  memory.sample('start');
  let exported;
  let directory;
  try {
    exported = buildGraph(requestedEntries);
    memory.sample('graph-built-exported');
    const journal = exported.journal ?? [];
    const timings = [];
    let report = null;
    for (let run = 0; run < runs; run += 1) {
      globalThis.gc?.();
      const started = performance.now();
      report = rebuildProjection(journal, { journalEpoch: exported.journalEpoch });
      timings.push(performance.now() - started);
      memory.sample(`rebuild-${run + 1}`);
    }
    const projection = projectionComparable(exported);
    const rebuiltProjection = report?.projection ? projectionComparable(report.projection) : null;
    const rebuildComponentsEquivalent = rebuiltProjection === null ? {
      records: false, facts: false, relations: false
    } : {
      records: plainJsonEquivalent(rebuiltProjection.records, projection.records),
      facts: plainJsonEquivalent(rebuiltProjection.facts, projection.facts),
      relations: plainJsonEquivalent(rebuiltProjection.relations, projection.relations)
    };
    const rebuildEquivalent = Object.values(rebuildComponentsEquivalent).every(Boolean);
    const journalBytes = jsonBytes(journal);
    const projectionBytes = jsonBytes({ schemaVersion: exported.schemaVersion, ...projection });
    memory.sample('sizes-computed');

    directory = await mkdtemp(join(tmpdir(), 'shadowgraph-bench-'));
    const jsonPath = join(directory, 'bench.json');
    const sqlitePath = join(directory, 'bench.sqlite');
    const backends = {
      json: await measureBackend('json', jsonPath, exported, memory),
      sqlite: await measureBackend('sqlite', sqlitePath, exported, memory)
    };
    const actualEntries = journal.length;
    const validation = {
      requestedCountSatisfied: actualEntries === requestedEntries,
      rebuildEquivalent,
      rebuildComponentsEquivalent,
      jsonRoundTripEquivalent: backends.json.roundTripEquivalent === true,
      sqliteRoundTripEquivalent: backends.sqlite.roundTripEquivalent === true
    };
    memory.sample('complete');
    return {
      status: 'MEASURED',
      requestedEntries,
      actualEntries,
      wallTimeMs: rounded(performance.now() - wallStarted),
      decisions: exported.records.filter((item) => item.kind === 'decision').length,
      facts: exported.facts.length,
      rebuild: {
        runs,
        p50Ms: rounded(percentile(timings, 0.5)),
        p95Ms: rounded(percentile(timings, 0.95)),
        minMs: rounded(Math.min(...timings)),
        maxMs: rounded(Math.max(...timings)),
        rebuildable: report?.rebuildable ?? null,
        applied: report?.applied ?? null,
        rebuiltRecords: report?.projection.records.length ?? null,
        rebuiltFacts: report?.projection.facts.length ?? null
      },
      size: {
        journalBytes,
        projectionBytes,
        ratio: Number((journalBytes / Math.max(1, projectionBytes)).toFixed(3))
      },
      backends,
      validation,
      memory: memory.report()
    };
  } catch (error) {
    memory.sample('failed');
    return {
      status: 'FAILED',
      requestedEntries,
      actualEntries: exported?.journal?.length ?? null,
      wallTimeMs: rounded(performance.now() - wallStarted),
      error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) },
      memory: memory.report()
    };
  } finally {
    exported = null;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

function verdict(results) {
  const breaches = [];
  for (const result of results.filter((item) => item.status === 'MEASURED')) {
    if (result.actualEntries >= 9000 && result.actualEntries < 20000) {
      if (result.rebuild.p95Ms > THRESHOLDS.rebuildMsAt10k) breaches.push(`rebuild p95 ${result.rebuild.p95Ms}ms exceeds ${THRESHOLDS.rebuildMsAt10k}ms at ~10k`);
      if (result.size.ratio > THRESHOLDS.journalSizeRatioAt10k) breaches.push(`journal/projection ratio ${result.size.ratio}x exceeds ${THRESHOLDS.journalSizeRatioAt10k}x at ~10k`);
    }
    if (result.actualEntries >= 90000 && result.rebuild.p95Ms > THRESHOLDS.rebuildMsAt100k) {
      breaches.push(`rebuild p95 ${result.rebuild.p95Ms}ms exceeds ${THRESHOLDS.rebuildMsAt100k}ms at ~100k`);
    }
  }
  return {
    thresholds: THRESHOLDS,
    breaches,
    snapshotsNeeded: breaches.length > 0,
    statement: breaches.length
      ? 'At least one pre-declared threshold was breached. Snapshots/compaction now require a new ADR.'
      : 'No pre-declared threshold was breached. Snapshots/compaction stay DEFERRED BY MEASUREMENT, not by guess.'
  };
}

function humanOutput(output) {
  const lines = [
    `ShadowGraph journal benchmark — Node ${output.environment.node} on ${output.environment.platform} ${output.environment.arch}`,
    `OS ${output.environment.os.type} ${output.environment.os.release}; CPU ${output.environment.cpu.model} (${output.environment.cpu.logicalCount} logical)`,
    `generated ${output.generatedAt}; requested sizes ${output.requestedSizes.join(', ')}; fresh process per size`,
    ''
  ];
  for (const result of output.results) {
    if (result.status !== 'MEASURED') {
      lines.push(`requested=${result.requestedEntries} FAILED after ${result.wallTimeMs}ms — ${result.error?.name}: ${result.error?.message}`, `  memory proxy peak=${result.memory?.peakSampledBytes ?? 'n/a'}B current=${result.memory?.currentBytes ?? 'n/a'}B`, '');
      continue;
    }
    lines.push(`entries=${result.actualEntries} (requested ${result.requestedEntries}) decisions=${result.decisions} facts=${result.facts} wall=${result.wallTimeMs}ms`);
    lines.push(`  rebuild   runs=${result.rebuild.runs} p50=${result.rebuild.p50Ms}ms p95=${result.rebuild.p95Ms}ms min=${result.rebuild.minMs}ms max=${result.rebuild.maxMs}ms rebuildable=${result.rebuild.rebuildable} applied=${result.rebuild.applied}`);
    lines.push(`  rebuilt   records=${result.rebuild.rebuiltRecords} facts=${result.rebuild.rebuiltFacts} equivalent=${result.validation.rebuildEquivalent}`);
    lines.push(`  size      journal=${result.size.journalBytes}B projection=${result.size.projectionBytes}B ratio=${result.size.ratio}x`);
    for (const name of ['json', 'sqlite']) {
      const backend = result.backends[name];
      if (backend.status === 'MEASURED') lines.push(`  ${name.padEnd(9)} save=${backend.saveMs}ms load=${backend.loadMs}ms file=${backend.fileBytes}B actual=${backend.actualEntries} equivalent=${backend.roundTripEquivalent}`);
      else lines.push(`  ${name.padEnd(9)} FAILED — ${backend.error?.name}: ${backend.error?.message}`);
    }
    lines.push(`  memory    metric=${result.memory.metric} peakSampled=${result.memory.peakSampledBytes}B current=${result.memory.currentBytes}B resourceUsageMaxRSS=${result.memory.resourceUsageMaxRssKilobytes}KiB`, '');
  }
  lines.push(`VALIDATION: ${output.validation.valid ? 'PASS' : 'FAIL'} (${output.validation.measuredSizeCount}/${output.validation.requestedSizeCount} sizes measured)`);
  for (const error of output.validation.errors) lines.push(`  - ${error}`);
  lines.push(`VERDICT: ${output.verdict.statement}`);
  for (const breach of output.verdict.breaches) lines.push(`  - ${breach}`);
  return `${lines.join('\n')}\n`;
}

async function runMaster(args) {
  const wallStarted = performance.now();
  const results = [];
  for (const size of args.sizes) {
    const runs = args.runs ?? DEFAULT_RUNS_BY_SIZE[size] ?? (size >= 100000 ? 3 : 5);
    try {
      const child = await execFileAsync(process.execPath, [
        '--expose-gc', scriptPath, '--worker', '--size', String(size), '--runs', String(runs)
      ], { timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      results.push(JSON.parse(child.stdout));
    } catch (error) {
      let parsed = null;
      try { parsed = JSON.parse(error.stdout ?? ''); } catch { /* exact worker output was unavailable */ }
      results.push(parsed ?? {
        status: 'FAILED',
        requestedEntries: size,
        actualEntries: null,
        wallTimeMs: null,
        error: {
          name: error?.name ?? 'WorkerError',
          message: error?.killed ? 'fresh worker exceeded the explicit 30 minute timeout' : String(error?.message ?? error)
        },
        memory: null
      });
    }
  }
  const output = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    environment: environmentCapture(),
    requestedSizes: args.sizes,
    runsBySize: Object.fromEntries(args.sizes.map((size, index) => [String(size), results[index]?.rebuild?.runs ?? args.runs ?? DEFAULT_RUNS_BY_SIZE[size] ?? (size >= 100000 ? 3 : 5)])),
    freshProcessPerSize: true,
    totalWallTimeMs: rounded(performance.now() - wallStarted),
    results,
    verdict: verdict(results)
  };
  output.validation = validateJournalBenchmark(output);
  const json = `${JSON.stringify(output, null, 2)}\n`;
  const human = humanOutput(output);
  if (args.jsonOut) await writeFile(args.jsonOut, json);
  if (args.humanOut) await writeFile(args.humanOut, human);
  process.stdout.write(args.json ? json : human);
  if (!output.validation.valid) process.exitCode = 1;
}

const args = parseArgs(process.argv.slice(2));
if (args.describe) {
  process.stdout.write(`${JSON.stringify({
    sizes: DEFAULT_SIZES,
    runsBySize: DEFAULT_RUNS_BY_SIZE,
    freshProcessPerSize: true,
    backends: ['json', 'sqlite'],
    memoryMetric: 'sampled-process-rss-bytes'
  })}\n`);
} else if (args.worker) {
  process.stdout.write(`${JSON.stringify(await measureWorker(args.size, args.runs))}\n`);
} else {
  await runMaster(args);
}
