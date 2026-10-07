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
//   node scripts/context-size.mjs --deliver [--runs N] [--records N]
//                                                matched per-delivery latency of the hook;
//                                                --records sets the corpus's approximate
//                                                size, the report gives the exact count
//   node scripts/context-size.mjs --check        measure writes per delivery against
//                                                the declared budget; exit 1 when over
import { spawn } from 'node:child_process';
import fsPromises, { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { PerformanceObserver } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createShadowGraph } from '../src/shadowgraph.js';
import { CONTEXT_DELIVERY_BUDGET } from '../src/mcp-tools.js';
import { createJsonFileStore } from '../src/storage.js';
import { createShadowGraphServer } from '../src/server.js';
import { privilegedBindProject, privilegedIssueAccess, privilegedSnapshot } from '../src/internal/snapshot.js';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const PROJECT = 'bench';

// A deterministic corpus. Sizes are fixed so two runs are comparable; the shapes
// mirror what the product actually stores rather than a synthetic blob.
export function seedGraph({ decisions = 40, attempts = 30, facts = 60, now, project = PROJECT } = {}) {
  const graph = createShadowGraph(now ? { now } : undefined);
  const expected = { violatedKeys: [], reusableAttemptIds: [], decisionIds: [] };

  for (let index = 0; index < decisions; index += 1) {
    const key = `latencyMs${index}`;
    const decision = graph.addDecision({
      project: project,
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
      graph.addFact({ project: project, key, value: '450ms', sourceClass: 'measured' });
      expected.violatedKeys.push(key);
    } else {
      graph.addFact({ project: project, key, value: '20ms', sourceClass: 'measured' });
    }
  }

  for (let index = 0; index < attempts; index += 1) {
    const key = `quotaPerMin${index}`;
    const attempt = graph.addAttempt({
      project: project,
      solution: `bulk backfill pass ${index}`,
      result: `failed: the upstream quota rejected batch ${index}`,
      resultClass: 'failed',
      reusableWhen: [{ key, operator: 'gte', value: 600 }]
    });
    if (index % 5 === 0) {
      graph.addFact({ project: project, key, value: 1200, sourceClass: 'measured' });
      expected.reusableAttemptIds.push(attempt.id);
    }
  }

  for (let index = 0; index < facts; index += 1) {
    graph.addFact({ project: project, key: `unrelated${index}`, value: `value ${index}`, sourceClass: 'human' });
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
  const violated = view.firedConditions.flatMap((item) => item.violatedConditions ?? []);
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
  const snapshot = privilegedSnapshot(graph);

  const view = graph.context({ project: PROJECT });
  const searchResult = graph.search('regional cache', { project: PROJECT });
  const retrieveResult = graph.retrieve('regional cache', { project: PROJECT });
  const recallResult = graph.recall('regional cache', { project: PROJECT });

  // recall() re-exports the whole graph on every call, so the clone is timed on
  // its own to show how much of recall is ranking and how much is copying.
  const cloneMs = time(() => privilegedSnapshot(graph));
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
      failedAttempts: bytes(view.failedAttempts),
      firedConditions: bytes(view.firedConditions),
      belowConfidenceThreshold: bytes(view.belowConfidenceThreshold),
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

// Declared operational writes per delivery (plan v1.4.4 §13.3), measured on the
// HTTP transport over a real JSON store in a temporary directory, so a transport
// that saved after an own-scope read would be counted. The clock advances one
// minute per delivery, so one audit aggregate per call cannot pass for one per
// UTC day, and the grant phase ends on the next UTC day. The own-scope phase
// ends with a replay at the same instant. A request that presents an access key
// with a null value is routed through the fenced access operation by every
// transport, so it is measured apart and held to the grant tier. Revisions and
// the journal are read back from the store itself.
const DAY_ONE = Date.parse('2026-01-01T00:00:00.000Z');
const MINUTE = 60_000, DAY = 86_400_000;
const ACCESS_AUDIT_TYPES = new Set(['access.used', 'access.refused', 'access.audit_overflow']);
const mean = (items) => (items.length ? items.reduce((sum, item) => sum + item, 0) / items.length : 0);
const round = (value) => Number(value.toFixed(4));

// Content-free file-system timing for the write-budget measurement (the owner's
// option (d) diagnostic for the Windows first-save overrun, PR #12): while a
// measurement runs, every node:fs/promises call is recorded as its operation,
// the role of the file it touches (never the path), its interval and any error
// code. The calls run unchanged; the wrappers only time them, and the originals
// are restored afterwards. A save then splits into lock wait, rename retries
// and backoff, reads, the temporary write, the CPU gap before that write
// (serialization and validation), garbage collection, other calls, and what no
// call accounts for.
// The node:fs/promises functions that touch a file, and the methods of a
// handle one opens, so a new kind of call on these paths is counted too; the
// stream and iterator ones (glob, watch, a handle's streams and readLines) are
// not, nor are the synchronous and callback node:fs functions: the store's
// save and lock paths make no such call, and a delivery's one (the read of a
// workspace binding file, readFileSync) is not counted.
const OBSERVED_CALLS = ['open', 'readFile', 'writeFile', 'rename', 'stat', 'lstat', 'realpath', 'mkdir', 'unlink', 'rm', 'readdir', 'utimes',
  'access', 'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'lchown', 'link', 'lutimes', 'mkdtemp', 'opendir', 'readlink', 'rmdir', 'statfs', 'symlink', 'truncate'].filter((name) => typeof fsPromises[name] === 'function');
const HANDLE_CALLS = ['appendFile', 'chmod', 'chown', 'close', 'datasync', 'read', 'readFile', 'readv', 'stat', 'sync', 'truncate', 'utimes', 'write', 'writeFile', 'writev'];
const fileRole = (path) => {
  const name = basename(String(path));
  return name === 'store.json' ? 'store' : name.endsWith('.lock') ? 'lock' : name.endsWith('.tmp') ? 'temp' : 'other';
};
export function observeFileSystem() {
  const events = [], gc = [], originals = {};
  const timed = (op, path, call) => async (...args) => {
    const started = performance.now();
    try { const value = await call(...args); events.push({ op, role: fileRole(path), started, ended: performance.now() }); return value; }
    catch (error) { events.push({ op, role: fileRole(path), started, ended: performance.now(), code: String(error?.code ?? 'error') }); throw error; }
  };
  for (const name of OBSERVED_CALLS) {
    const original = originals[name] = fsPromises[name];
    fsPromises[name] = (path, ...rest) => timed(name, path, async () => {
      const value = await original(path, ...rest);
      // A lock is written and closed through its handle: those calls are timed too.
      if (name === 'open') for (const method of HANDLE_CALLS.filter((method) => typeof value[method] === 'function')) value[method] = timed(`handle.${method}`, path, value[method].bind(value));
      return value;
    })();
  }
  syncBuiltinESMExports();
  const gcEntry = (entry) => gc.push({ started: entry.startTime, ended: entry.startTime + entry.duration });
  const observer = new PerformanceObserver((list) => list.getEntries().forEach(gcEntry));
  observer.observe({ entryTypes: ['gc'] });
  return {
    events, gc,
    flush() { observer.takeRecords().forEach(gcEntry); },
    stop() {
      observer.takeRecords().forEach(gcEntry);
      observer.disconnect();
      Object.assign(fsPromises, originals);
      syncBuiltinESMExports();
    }
  };
}
// Length of the union of intervals, so overlapping calls count once.
const covered = (intervals) => {
  let total = 0, end = -Infinity;
  for (const { started, ended } of [...intervals].sort((a, b) => a.started - b.started)) {
    if (ended <= end) continue;
    total += ended - Math.max(started, end); end = ended;
  }
  return total;
};
const codes = (items) => items.reduce((all, item) => (item.code ? { ...all, [item.code]: (all[item.code] ?? 0) + 1 } : all), {});
// One window (a save, or a delivery outside its saves) split into phases.
// `excluded` windows (the delivery's saves) are left out of a delivery's figures.
export function windowPhases({ started, ended, events, gc = [], excluded = [] }) {
  const outside = (item) => !excluded.some((window) => item.started >= window.started && item.started < window.ended);
  const inside = events.filter((event) => event.started >= started && event.started < ended && outside(event));
  const of = (op, role) => inside.filter((event) => event.op === op && event.role === role);
  const sum = (items) => items.reduce((total, item) => total + (item.ended - item.started), 0);
  const span = (items) => (items.length ? items.at(-1).ended - items[0].started : 0);
  const lockOpens = of('open', 'lock'), renames = of('rename', 'temp'), writes = of('writeFile', 'temp');
  const firstLock = lockOpens.find((event) => !event.code);
  const lockWaitMs = firstLock ? firstLock.ended - lockOpens[0].started : span(lockOpens);
  const lockPollMs = Math.max(0, lockWaitMs - covered(lockOpens.filter((event) => event.ended <= (firstLock?.ended ?? Infinity))));
  const renameBackoffMs = Math.max(0, span(renames) - covered(renames));
  const before = writes[0] ? inside.filter((event) => event.ended <= writes[0].started) : [];
  const preWriteGapMs = writes[0] ? Math.max(0, writes[0].started - Math.max(started, ...before.map((event) => event.ended))) : 0;
  const fsMs = covered(inside);
  const windowMs = ended - started - covered(excluded.filter((window) => window.started >= started && window.started < ended));
  const known = new Set([...renames, ...writes, ...of('readFile', 'store'), ...inside.filter((event) => event.role === 'lock')]);
  const others = inside.filter((event) => !known.has(event));
  const gcMs = covered(gc.map((entry) => ({ started: Math.max(entry.started, started), ended: Math.min(entry.ended, ended) })).filter((entry) => entry.ended > entry.started));
  const count = (role) => inside.filter((event) => event.role === role).length;
  return {
    ms: round(windowMs),
    calls: { lock: count('lock'), store: count('store'), temp: count('temp'), other: count('other') },
    lock: { attempts: lockOpens.length, acquired: lockOpens.filter((event) => !event.code).length,
      // Lock calls made while waiting for the lock (failed opens and staleness probes), counted apart.
      contentionCalls: firstLock ? inside.filter((event) => event.role === 'lock' && event.started >= lockOpens[0].started && event.started < firstLock.started).length : lockOpens.length,
      codes: codes(lockOpens), waitMs: round(lockWaitMs), pollMs: round(lockPollMs), handleAndReleaseMs: round(sum(inside.filter((event) => event.role === 'lock' && event.op !== 'open'))) },
    rename: { attempts: renames.length, committed: renames.filter((event) => !event.code).length, codes: codes(renames), callMs: round(sum(renames)), backoffMs: round(renameBackoffMs) },
    writes: writes.length,
    readMs: round(sum(of('readFile', 'store'))),
    writeMs: round(sum(writes)),
    preWriteGapMs: round(preWriteGapMs),
    otherFs: { calls: others.length, ms: round(sum(others)), codes: codes(others) },
    fsMs: round(fsMs),
    gcMs: round(gcMs),
    unaccountedMs: round(Math.max(0, windowMs - fsMs - lockPollMs - renameBackoffMs - preWriteGapMs))
  };
}
// Canonical truth is the stored values, every non-audit event included. An
// import rebuilds objects in its own key order, so a reload and save may reorder
// keys without changing a value; that is compared away here, and nothing else.
const values = (value) => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]]))
  : item));
// The runtime miss ledger is declared operational data too (PR-28), measured
// apart from canonical truth like the access audit.
function partition(stored) {
  const { revision = 0, events = [], runtimeMisses = [], ...rest } = stored;
  return {
    canonical: { ...rest, events: events.filter((event) => !ACCESS_AUDIT_TYPES.has(event.type)) },
    audit: events.filter((event) => ACCESS_AUDIT_TYPES.has(event.type)),
    misses: runtimeMisses,
    revision
  };
}

// What a delivery's relevant block established, and in which tiers, so a
// measurement names the read it measured (PR-26); null without one.
const relevantSummary = (text) => {
  const { relevant } = JSON.parse(text);
  return relevant ? { established: relevant.relevance.established, tiers: [...new Set(relevant.items.map((item) => item.tier))] } : null;
};

// `request` adds fields to every delivery's body, such as a relevance query (PR-26).
export async function measureWrites({ deliveries = 5, request = {}, project = PROJECT, observe = true, ...options } = {}) {
  let clock = DAY_ONE;
  const now = () => new Date(clock).toISOString();
  const { graph } = seedGraph({ ...options, now, project });
  // The granted project holds a record, so every grant-bearing delivery is a
  // wider read and commits its audit aggregate.
  graph.addDecision({ project: 'elsewhere', title: 'Serve the wider tier from the regional cache', chosen: 'regional-cache' });
  const grant = privilegedIssueAccess(graph, {
    type: 'grant', scope: { projects: ['elsewhere'] }, surfaces: ['http'],
    expiresAt: '2099-01-01T00:00:00.000Z', reason: 'context-size write budget'
  }).entry;
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-context-size-'));
  const observation = observe ? observeFileSystem() : null;
  let app;
  try {
    const file = join(directory, 'store.json');
    const store = createJsonFileStore(file);
    await store.save(privilegedSnapshot(graph));
    const storeBytes = (await stat(file)).size;
    let saves = [];
    const measuredStore = {
      load: () => store.load(),
      async save(data) {
        const sizeBefore = (await stat(file)).size;
        const started = performance.now();
        const revision = await store.save(data);
        const ended = performance.now(), ms = ended - started;
        const size = (await stat(file)).size;
        saves.push({ ms, started, ended, bytesWritten: size, growthBytes: size - sizeBefore });
        return revision;
      },
      close() {}
    };
    app = await createShadowGraphServer({ store: measuredStore, now, cwd: directory, apiToken: '' });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${app.server.address().port}/context`;
    async function deliver(body) {
      const first = saves.length, started = performance.now();
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const text = await response.text();
      if (!response.ok) throw new Error(`POST /context answered ${response.status}: ${text}`);
      const ended = performance.now();
      return { text, ms: ended - started, started, ended, saves: saves.slice(first) };
    }
    async function phase(instants, body) {
      saves = [];
      const before = await readFile(file, 'utf8');
      const delivered = [];
      for (const instant of instants) { clock = instant; delivered.push(await deliver(body)); }
      const after = await readFile(file, 'utf8');
      const [was, is] = [partition(JSON.parse(before)), partition(JSON.parse(after))];
      const canonicalChanged = [...new Set([...Object.keys(was.canonical), ...Object.keys(is.canonical)])]
        .filter((key) => values(was.canonical[key]) !== values(is.canonical[key]));
      const used = is.audit.filter((event) => event.type === 'access.used' && event.accessId === grant.accessId);
      const perDay = new Map();
      for (const event of used) perDay.set(event.window, (perDay.get(event.window) ?? 0) + 1);
      return {
        deliveries: instants.length,
        saves: saves.length,
        maxSavesPerDelivery: Math.max(0, ...delivered.map((item) => item.saves.length)),
        bytesWritten: saves.reduce((sum, save) => sum + save.bytesWritten, 0),
        revisionDelta: is.revision - was.revision,
        journalDelta: (is.canonical.journalSeq ?? 0) - (was.canonical.journalSeq ?? 0),
        canonicalWrites: canonicalChanged.length,
        changedKeys: [...canonicalChanged, ...(values(was.audit) !== values(is.audit) ? ['accessAudit'] : []), ...(values(was.misses) !== values(is.misses) ? ['runtimeMisses'] : []), ...(is.revision !== was.revision ? ['revision'] : [])].sort(),
        runtimeMissesAdded: is.misses.length - was.misses.length,
        storeChanged: before !== after,
        growthBytes: Buffer.byteLength(after) - Buffer.byteLength(before),
        maxGrowthBytes: Math.max(0, ...saves.map((save) => save.growthBytes)),
        deliveryMsMean: round(mean(delivered.map((item) => item.ms))),
        deliveryMsMax: round(Math.max(...delivered.map((item) => item.ms))),
        saveMsMax: round(Math.max(0, ...delivered.map((item) => item.saves.reduce((sum, save) => sum + save.ms, 0)))),
        accessUsed: { aggregates: used.length, count: used.reduce((sum, event) => sum + event.count, 0), days: perDay.size, maxPerDay: Math.max(0, ...perDay.values()) },
        delivered
      };
    }
    const minutes = (from, count) => Array.from({ length: count }, (_, index) => DAY_ONE + (from + index) * MINUTE);
    const ownInstants = minutes(0, deliveries);
    const own = await phase([...ownInstants, ownInstants.at(-1)], { ...request, project });
    const granted = await phase([...minutes(deliveries, deliveries), DAY_ONE + DAY], { ...request, project, accessId: grant.accessId });
    const nullReference = await phase(minutes(2 * deliveries, deliveries).map((instant) => instant + DAY), { ...request, project, accessId: null });
    // Wall-clock added per delivery: an own-scope delivery adds the time of any
    // save it makes (none, when it is a read); a fenced delivery adds whatever it
    // takes beyond the mean own-scope read on the same transport: the reload,
    // the snapshot and the whole-store save.
    const added = (tier) => round(Math.max(0, ...tier.delivered.map((item) => item.ms - own.deliveryMsMean)));
    const [lastRead, replay] = own.delivered.slice(-2);
    // Each delivery's wall time and its saves' times stay in the report, so a budget failure shows which
    // delivery was slow and whether its save was, not only the maximum.
    // With observation, `phases` gives each delivery (outside its saves) and each of its saves split by phase.
    observation?.flush();
    const phasesOf = (item) => ({
      delivery: windowPhases({ ...observation, started: item.started, ended: item.ended, excluded: item.saves }),
      saves: item.saves.map((save) => windowPhases({ ...observation, started: save.started, ended: save.ended }))
    });
    const strip = ({ delivered, ...rest }) => ({ ...rest, deliveryMs: delivered.map((item) => round(item.ms)), saveMs: delivered.map((item) => item.saves.map((save) => round(save.ms))),
      ...(observation ? { phases: delivered.map(phasesOf) } : {}) });
    return {
      storeBytes,
      ownScope: { ...strip(own), addedMsMax: own.saveMsMax, replayIdentical: !own.storeChanged && lastRead.text === replay.text, relevant: relevantSummary(lastRead.text) },
      grant: { ...strip(granted), addedMsMax: added(granted), rewrite: 'whole_store' },
      nullReference: { ...strip(nullReference), addedMsMax: added(nullReference), rewrite: 'whole_store' }
    };
  } finally {
    observation?.stop();
    if (app) await new Promise((resolve) => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

// Every §13.3 category against the frozen budget. A null access key takes the
// fenced path, so it answers to the grant tier. Returns the violations; an empty
// list is the only passing result, and nothing here adjusts the budget.
export function checkWriteBudget(report, budget = CONTEXT_DELIVERY_BUDGET) {
  const violations = [];
  const over = (label, value, limit) => { if (value > limit) violations.push(`${label}: measured ${value}, declared ${limit}`); };
  for (const [tier, declaredTier] of [['ownScope', 'ownScope'], ['grant', 'grant'], ['nullReference', 'grant']]) {
    const measured = report[tier], declared = budget[declaredTier];
    over(`${tier}.canonicalWrites`, measured.canonicalWrites, declared.canonicalWrites);
    over(`${tier}.journalEntries per delivery`, measured.journalDelta / measured.deliveries, declared.journalEntries);
    over(`${tier}.revisions per delivery`, measured.revisionDelta / measured.deliveries, declared.revisions);
    over(`${tier}.saves per delivery`, measured.maxSavesPerDelivery, declared.saves);
    over(`${tier}.addedMs per delivery`, measured.addedMsMax, declared.addedMs);
  }
  over('ownScope.bytesWritten', report.ownScope.bytesWritten, budget.ownScope.bytesWritten);
  for (const tier of ['grant', 'nullReference']) {
    over(`${tier}.growthBytes per delivery`, report[tier].maxGrowthBytes, budget.grant.growthBytes);
    over(`${tier}.audit aggregates per key and UTC day`, report[tier].accessUsed.maxPerDay, budget.grant.newAuditAggregatesPerKeyDay);
  }
  return violations;
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

// Matched per-delivery latency (plan §18.4; AG-1 condition 5): the hook path,
// `shadowgraph deliver --hook` with a scratch activation record pinning a
// seeded store, at each hook event, against a matched no-op process
// (`node -e 0`) spawned the same way and interleaved with it. Wall-clock
// milliseconds from spawn to exit; nothing here measures the host.
// Delivered means a payload holding at least one record, not merely a line.
export const holdsRecord = (stdout) => stdout.length > 0 && JSON.parse(stdout).hookSpecificOutput.additionalContext.includes('\nitem: ');

export async function measureDeliveryLatency({ runs = 20, records = 130 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-deliver-latency-'));
  try {
    const cwd = join(directory, 'work');
    await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
    await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd), project: PROJECT, confirmed: true }));
    const scale = Math.max(1, Math.round(records / 130));
    const { graph } = seedGraph({ decisions: 40 * scale, attempts: 30 * scale, facts: 60 * scale });
    privilegedBindProject(graph, { type: 'worktree', path: resolve(cwd), project: PROJECT, reason: 'latency measurement' });
    const store = join(directory, 'store.json');
    await createJsonFileStore(store).save(privilegedSnapshot(graph));
    const home = join(directory, 'shadowgraph-home');
    await mkdir(home);
    await writeFile(join(home, 'activation.json'), JSON.stringify({ capabilities: { delivery: { state: 'active', store: { file: store, storage: 'json' } } } }));
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const env = { ...process.env, SHADOWGRAPH_HOME: home, SHADOWGRAPH_FILE: '' };
    const timed = (args, stdin) => new Promise((settle) => {
      const started = process.hrtime.bigint();
      const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stdin.end(stdin);
      child.on('close', () => settle({ ms: Number(process.hrtime.bigint() - started) / 1e6, delivered: holdsRecord(stdout) }));
    });
    const samples = { noop: [], sessionStart: [], userPromptSubmit: [] };
    let delivered = 0;
    for (let run = 0; run < runs; run += 1) {
      samples.noop.push((await timed(['-e', '0'], '')).ms);
      for (const [key, event] of [['sessionStart', { hook_event_name: 'SessionStart' }], ['userPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt: 'serve tier 7 from the regional cache' }]]) {
        const sample = await timed([cli, 'deliver', '--hook'], JSON.stringify(event));
        samples[key].push(sample.ms);
        if (sample.delivered) delivered += 1;
      }
    }
    const summary = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const at = (fraction) => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]);
      return { p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1)) };
    };
    const noop = summary(samples.noop);
    const [sessionStart, userPromptSubmit] = [summary(samples.sessionStart), summary(samples.userPromptSubmit)];
    const exported = graph.exportData({ project: PROJECT });
    return {
      runs, records: exported.records.length + exported.facts.length,
      noop, sessionStart, userPromptSubmit,
      addedP50: { sessionStart: sessionStart.p50 - noop.p50, userPromptSubmit: userPromptSubmit.p50 - noop.p50 },
      delivered: `${delivered} of ${runs * 2}`
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes('--deliver')) {
    const option = (name, fallback) => {
      const value = Number(args[args.indexOf(name) + 1]);
      return args.includes(name) && Number.isInteger(value) && value > 0 ? value : fallback;
    };
    process.stdout.write(`${JSON.stringify(await measureDeliveryLatency({ runs: option('--runs', 20), records: option('--records', 130) }), null, 2)}\n`);
    process.exit(0);
  }
  if (args.includes('--check')) {
    const writes = await measureWrites();
    // A delivery the fallback answers is measured too: it records runtime misses (PR-28).
    const fallbackWrites = await measureWrites({ request: { query: 'zebra crossing', compact: true } });
    const violations = [...checkWriteBudget(writes), ...checkWriteBudget(fallbackWrites).map((violation) => `fallback ${violation}`)];
    process.stdout.write(`${JSON.stringify({ budget: CONTEXT_DELIVERY_BUDGET, writes, fallbackWrites, violations }, null, 2)}\n`);
    process.exit(violations.length ? 1 : 0);
  }
  const report = measure();
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const diffAt = args.indexOf('--diff');
    const baseline = diffAt >= 0 && args[diffAt + 1] ? JSON.parse(await readFile(args[diffAt + 1], 'utf8')) : null;
    process.stdout.write(`${formatReport(report, baseline)}\n`);
  }
}
