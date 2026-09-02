import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-08-28T00:00:00.000Z';
const LATER = '2026-08-29T00:00:00.000Z';
const FAULT = 'injected transaction fault';

function exportBytes(graph) {
  return JSON.stringify(graph.exportData());
}

function controlledClock(value = NOW) {
  let calls = 0;
  let failAt = null;
  return {
    now() {
      calls += 1;
      if (calls === failAt) throw new Error(`${FAULT}: now call ${calls}`);
      return value;
    },
    arm(position = null) { calls = 0; failAt = position; },
    get calls() { return calls; }
  };
}

function graphWithClock(options = {}) {
  const clock = controlledClock();
  const graph = createShadowGraph({ ...options, now: () => clock.now() });
  return { graph, clock };
}

function decisionInput(id, extra = {}) {
  return { id, project: 'transaction', title: id, chosen: 'A', ...extra };
}

function memoryInput(id, key, text, extra = {}) {
  return { id, project: 'transaction', scope: {}, memoryType: 'note', key, text, ...extra };
}

function projectionFromLive(data) {
  const byId = (items) => [...items].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const mappings = (items) => [...items].sort((left, right) => left.key.localeCompare(right.key));
  return {
    records: byId(data.records),
    facts: byId(data.facts),
    relations: byId(data.relations),
    idempotency: mappings(data.idempotency)
  };
}

function assertRebuildParity(graph, label) {
  const live = graph.exportData();
  const rebuilt = graph.rebuild();
  assert.equal(rebuilt.rebuildable, true, `${label}: journal remains rebuildable`);
  assert.deepEqual(projectionFromLive(rebuilt.projection), projectionFromLive(live), `${label}: rebuilt projection matches live state`);
}

function importDeltaScenario() {
  const { graph, clock } = graphWithClock();
  const decision = graph.addDecision(decisionInput('transaction-import-decision', { title: 'old' }));
  const source = createShadowGraph({ now: () => NOW });
  const fact = source.addFact({ id: 'transaction-import-fact', project: 'transaction', key: 'imported', value: true });
  clock.arm();
  return {
    graph,
    clock,
    invoke: () => graph.importData({
      schemaVersion: 5,
      records: [{ ...decision, title: 'new' }],
      facts: [fact]
    })
  };
}

const CLOCK_MUTATOR_CASES = [
  {
    name: 'addDecision',
    build() {
      const { graph, clock } = graphWithClock();
      clock.arm();
      return { graph, clock, invoke: () => graph.addDecision(decisionInput('transaction-decision', { alternatives: [{ id: 'transaction-decision-alt', label: 'B' }], idempotencyKey: 'decision-retry' })) };
    }
  },
  {
    name: 'addAttempt',
    build() {
      const { graph, clock } = graphWithClock();
      clock.arm();
      return { graph, clock, invoke: () => graph.addAttempt({ id: 'transaction-attempt', project: 'transaction', solution: 'try', result: 'result', idempotencyKey: 'attempt-retry' }) };
    }
  },
  {
    name: 'remember multi-entry update',
    build() {
      const { graph, clock } = graphWithClock();
      graph.remember(memoryInput('transaction-memory-old', 'memory-update', 'old'));
      clock.arm();
      return { graph, clock, invoke: () => graph.remember(memoryInput('transaction-memory-new', 'memory-update', 'new', { idempotencyKey: 'memory-retry' })) };
    }
  },
  {
    name: 'applyMemoryPlan nested mixed batch',
    build() {
      const { graph, clock } = graphWithClock();
      graph.remember(memoryInput('transaction-plan-old', 'plan-update', 'old'));
      graph.remember(memoryInput('transaction-plan-delete', 'plan-delete', 'delete'));
      clock.arm();
      return {
        graph,
        clock,
        invoke: () => graph.applyMemoryPlan({ project: 'transaction', scope: {}, operations: [
          { action: 'ADD', id: 'transaction-plan-add', memoryType: 'note', key: 'plan-add', text: 'add' },
          { action: 'UPDATE', id: 'transaction-plan-new', memoryType: 'note', key: 'plan-update', text: 'new' },
          { action: 'DELETE', memoryType: 'note', key: 'plan-delete' },
          { action: 'NOOP', memoryType: 'note', key: 'plan-noop' }
        ] })
      };
    }
  },
  {
    name: 'addFact multi-entry supersession',
    build() {
      const { graph, clock } = graphWithClock();
      graph.addFact({ id: 'transaction-fact-old', project: 'transaction', key: 'fact-update', value: 'old' });
      clock.arm();
      return { graph, clock, invoke: () => graph.addFact({ id: 'transaction-fact-new', project: 'transaction', key: 'fact-update', value: 'new', idempotencyKey: 'fact-retry' }) };
    }
  },
  {
    name: 'verifyFact async commit',
    build() {
      const verifier = {
        async verify({ fact }) { await Promise.resolve(); return { factId: fact.id, verifierIdentity: 'transaction-verifier' }; },
        validateStored() { return true; }
      };
      const { graph, clock } = graphWithClock({ verifier });
      const fact = graph.addFact({ id: 'transaction-verify', project: 'transaction', key: 'verified', value: true });
      clock.arm();
      return { graph, clock, invoke: () => graph.verifyFact({ factId: fact.id, evidencePath: 'trusted.json' }) };
    }
  },
  {
    name: 'link',
    build() {
      const { graph, clock } = graphWithClock();
      const from = graph.addDecision(decisionInput('transaction-link-from'));
      const to = graph.addDecision(decisionInput('transaction-link-to'));
      clock.arm();
      return { graph, clock, invoke: () => graph.link({ id: 'transaction-link', from: from.id, to: to.id, relation: 'depends_on' }) };
    }
  },
  {
    name: 'supersedeDecision nested link and causation batch',
    build() {
      const { graph, clock } = graphWithClock();
      const previous = graph.addDecision(decisionInput('transaction-supersede-old'));
      const replacement = graph.addDecision(decisionInput('transaction-supersede-new'));
      clock.arm();
      return { graph, clock, invoke: () => graph.supersedeDecision({ decisionId: previous.id, replacementId: replacement.id }) };
    }
  },
  {
    name: 'updateDecisionStatus',
    build() {
      const { graph, clock } = graphWithClock();
      const decision = graph.addDecision(decisionInput('transaction-status'));
      clock.arm();
      return { graph, clock, invoke: () => graph.updateDecisionStatus(decision.id, 'planned') };
    }
  },
  {
    name: 'setOutcome with nested confidence state',
    build() {
      const { graph, clock } = graphWithClock();
      const decision = graph.addDecision(decisionInput('transaction-outcome'));
      clock.arm();
      return { graph, clock, invoke: () => graph.setOutcome(decision.id, { status: 'successful' }) };
    }
  },
  {
    name: 'addConfidenceEvidence with nested confidence state',
    build() {
      const { graph, clock } = graphWithClock();
      const decision = graph.addDecision(decisionInput('transaction-confidence'));
      clock.arm();
      return { graph, clock, invoke: () => graph.addConfidenceEvidence({ decisionId: decision.id, key: 'transaction-evidence', reason: 'evidence' }) };
    }
  },
  {
    name: 'review multi-signal batch',
    build() {
      const { graph, clock } = graphWithClock();
      for (const suffix of ['a', 'b']) graph.addDecision(decisionInput(`transaction-review-${suffix}`, {
        alternatives: [{ id: `transaction-review-alt-${suffix}`, label: 'B', reopenWhen: ['changed'] }]
      }));
      clock.arm();
      return { graph, clock, invoke: () => graph.review({ project: 'transaction', changedFacts: ['changed'] }) };
    }
  },
  {
    name: 'context nested review mutation',
    build() {
      const { graph, clock } = graphWithClock();
      graph.addDecision(decisionInput('transaction-context', {
        alternatives: [{ id: 'transaction-context-alt', label: 'B', reopenWhen: ['changed'] }]
      }));
      clock.arm();
      return { graph, clock, invoke: () => graph.context({ project: 'transaction', changedFacts: ['changed'] }) };
    }
  },
  {
    name: 'maintain lifecycle and review batch',
    build() {
      const { graph, clock } = graphWithClock();
      for (const suffix of ['a', 'b']) {
        graph.addDecision(decisionInput(`transaction-maintain-decision-${suffix}`, { reviewAfter: NOW }));
        graph.addFact({ id: `transaction-maintain-fact-${suffix}`, project: 'transaction', key: `maintain-${suffix}`, value: suffix, expiresAt: NOW });
      }
      clock.arm();
      return { graph, clock, invoke: () => graph.maintain({ now: LATER }) };
    }
  },
  {
    name: 'acknowledgeReview',
    build() {
      const { graph, clock } = graphWithClock();
      graph.addDecision(decisionInput('transaction-ack', {
        alternatives: [{ id: 'transaction-ack-alt', label: 'B', reopenWhen: ['changed'] }]
      }));
      graph.review({ project: 'transaction', changedFacts: ['changed'], asOf: NOW });
      const signal = graph.getReviewSignals()[0];
      clock.arm();
      return { graph, clock, invoke: () => graph.acknowledgeReview(signal.id) };
    }
  },
  {
    name: 'purgeProject',
    build() {
      const { graph, clock } = graphWithClock();
      graph.addDecision(decisionInput('transaction-purge'));
      clock.arm();
      return { graph, clock, invoke: () => graph.purgeProject('transaction', { mode: 'logical' }) };
    }
  },
  {
    name: 'importData generated delta batch',
    build: importDeltaScenario
  }
];

async function invokeAsPromise(invoke) {
  return Promise.resolve().then(invoke);
}

test('transaction boundary: every injected now() call position is atomic across direct public mutators and mixed batches', async () => {
  for (const scenario of CLOCK_MUTATOR_CASES) {
    const probe = scenario.build();
    probe.clock.arm();
    await invokeAsPromise(probe.invoke);
    const callCount = probe.clock.calls;
    assert.ok(callCount > 0, `${scenario.name}: scenario must exercise now()`);

    for (let failAt = 1; failAt <= callCount; failAt += 1) {
      const attempt = scenario.build();
      const before = exportBytes(attempt.graph);
      attempt.clock.arm(failAt);
      await assert.rejects(invokeAsPromise(attempt.invoke), new RegExp(`${FAULT}: now call ${failAt}`), `${scenario.name}: now call ${failAt} must reject`);
      attempt.clock.arm();
      assert.equal(exportBytes(attempt.graph), before, `${scenario.name}: now call ${failAt} must restore exportData byte-for-byte`);
      await invokeAsPromise(attempt.invoke);
      assertRebuildParity(attempt.graph, `${scenario.name}: retry after now call ${failAt}`);
    }
  }
});

const JSON_MUTATOR_CASES = [
  CLOCK_MUTATOR_CASES.find((item) => item.name === 'addDecision'),
  CLOCK_MUTATOR_CASES.find((item) => item.name === 'remember multi-entry update'),
  CLOCK_MUTATOR_CASES.find((item) => item.name === 'applyMemoryPlan nested mixed batch'),
  CLOCK_MUTATOR_CASES.find((item) => item.name === 'addFact multi-entry supersession'),
  CLOCK_MUTATOR_CASES.find((item) => item.name === 'verifyFact async commit'),
  CLOCK_MUTATOR_CASES.find((item) => item.name === 'setOutcome with nested confidence state'),
  CLOCK_MUTATOR_CASES.find((item) => item.name === 'addConfidenceEvidence with nested confidence state'),
  CLOCK_MUTATOR_CASES.find((item) => item.name === 'maintain lifecycle and review batch'),
  CLOCK_MUTATOR_CASES.find((item) => item.name === 'importData generated delta batch'),
  {
    name: 'replaceData staged replacement',
    build() {
      const { graph, clock } = graphWithClock();
      graph.addDecision(decisionInput('transaction-replace-old'));
      const source = createShadowGraph({ now: () => NOW });
      const replacement = source.addDecision(decisionInput('transaction-replace-new'));
      const journalFree = { schemaVersion: 5, records: [replacement] };
      clock.arm();
      return { graph, clock, invoke: () => graph.replaceData(journalFree) };
    }
  }
];

async function withJsonStringifyFault(position, invoke) {
  const original = JSON.stringify;
  let calls = 0;
  JSON.stringify = function injectedStringify(...args) {
    calls += 1;
    if (calls === position) throw new Error(`${FAULT}: JSON.stringify call ${calls}`);
    return Reflect.apply(original, this, args);
  };
  try {
    const value = await invokeAsPromise(invoke);
    return { value, calls };
  } finally {
    JSON.stringify = original;
  }
}

test('transaction boundary: clone/JSON failures at every call position restore mixed, imported, async, and nested state', async () => {
  for (const scenario of JSON_MUTATOR_CASES) {
    const probe = scenario.build();
    const counted = await withJsonStringifyFault(null, probe.invoke);
    assert.ok(counted.calls > 0, `${scenario.name}: scenario must exercise JSON serialization`);

    for (let failAt = 1; failAt <= counted.calls; failAt += 1) {
      const attempt = scenario.build();
      const before = exportBytes(attempt.graph);
      await assert.rejects(
        withJsonStringifyFault(failAt, attempt.invoke),
        new RegExp(`${FAULT}: JSON.stringify call ${failAt}`),
        `${scenario.name}: JSON.stringify call ${failAt} must reject`
      );
      assert.equal(exportBytes(attempt.graph), before, `${scenario.name}: JSON.stringify call ${failAt} must restore exportData byte-for-byte`);
      await invokeAsPromise(attempt.invoke);
      assertRebuildParity(attempt.graph, `${scenario.name}: retry after JSON.stringify call ${failAt}`);
    }
  }
});

test('transaction boundary: reads and true no-op mutations do not clone the whole graph', () => {
  const graph = createShadowGraph({ now: () => NOW });
  const decisionInputWithRetry = decisionInput('transaction-noop-decision', { idempotencyKey: 'noop-decision' });
  const decision = graph.addDecision(decisionInputWithRetry);
  const factInput = { id: 'transaction-noop-fact', project: 'transaction', key: 'noop', value: true, idempotencyKey: 'noop-fact' };
  graph.addFact(factInput);
  graph.remember(memoryInput('transaction-noop-memory', 'noop-memory', 'same'));
  const original = globalThis.structuredClone;
  try {
    globalThis.structuredClone = () => { throw new Error('unexpected whole-graph snapshot'); };
    assert.equal(graph.addDecision({ ...decisionInputWithRetry, title: 'ignored retry' }).id, decision.id);
    assert.equal(graph.addFact({ ...factInput, value: false }).id, factInput.id);
    assert.equal(graph.remember({ project: 'transaction', scope: {}, memoryType: 'note', key: 'noop-memory', text: 'same' }).operation, 'NOOP');
    assert.equal(graph.applyMemoryPlan({ project: 'transaction', scope: {}, operations: [{ action: 'NOOP', memoryType: 'note', key: 'absent' }] }).results[0].operation, 'NOOP');
    assert.equal(graph.updateDecisionStatus(decision.id, 'proposed').status, 'proposed');
    assert.doesNotThrow(() => graph.search(''));
    assert.doesNotThrow(() => graph.exportData());
  } finally {
    globalThis.structuredClone = original;
  }
});

test('transaction boundary: id generation faults roll back records, alternatives, events, journal, and idempotency', async () => {
  const build = () => {
    const graph = createShadowGraph({ now: () => NOW });
    return {
      graph,
      invoke: () => graph.addDecision({
        project: 'transaction', title: 'generated ids', chosen: 'A', idempotencyKey: 'generated-id-retry',
        alternatives: [{ label: 'B' }, { label: 'C' }]
      })
    };
  };
  const original = Date.now;
  let calls = 0;
  try {
    Date.now = () => { calls += 1; return original(); };
    const probe = build();
    await invokeAsPromise(probe.invoke);
  } finally {
    Date.now = original;
  }
  assert.ok(calls >= 5, 'scenario must generate entity, alternative, event, and journal ids');

  for (let failAt = 1; failAt <= calls; failAt += 1) {
    const attempt = build();
    const before = exportBytes(attempt.graph);
    let current = 0;
    try {
      Date.now = () => {
        current += 1;
        if (current === failAt) throw new Error(`${FAULT}: id call ${current}`);
        return original();
      };
      await assert.rejects(invokeAsPromise(attempt.invoke), new RegExp(`${FAULT}: id call ${failAt}`));
    } finally {
      Date.now = original;
    }
    assert.equal(exportBytes(attempt.graph), before, `id call ${failAt} must restore exportData byte-for-byte`);
    await invokeAsPromise(attempt.invoke);
    assertRebuildParity(attempt.graph, `id retry ${failAt}`);
  }
});

test('transaction boundary: purge publication faults restore every live and audit collection', async () => {
  const build = (mode) => {
    const graph = createShadowGraph({ now: () => NOW });
    graph.addDecision(decisionInput(`transaction-purge-delete-a-${mode}`, { idempotencyKey: `purge-a-${mode}` }));
    graph.addDecision(decisionInput(`transaction-purge-delete-b-${mode}`, { idempotencyKey: `purge-b-${mode}` }));
    graph.addDecision({ id: `transaction-purge-kept-${mode}`, project: 'kept', title: 'kept', chosen: 'A' });
    return { graph, invoke: () => graph.purgeProject('transaction', { mode }) };
  };
  const original = Map.prototype.delete;

  for (const mode of ['logical', 'hard']) {
    let calls = 0;
    try {
      Map.prototype.delete = function countedDelete(...args) {
        calls += 1;
        return Reflect.apply(original, this, args);
      };
      const probe = build(mode);
      await invokeAsPromise(probe.invoke);
    } finally {
      Map.prototype.delete = original;
    }
    assert.ok(calls >= 2, `${mode}: scenario must delete multiple map entries during publication`);

    for (let failAt = 1; failAt <= calls; failAt += 1) {
      const attempt = build(mode);
      const before = exportBytes(attempt.graph);
      let current = 0;
      try {
        Map.prototype.delete = function injectedDelete(...args) {
          current += 1;
          if (current === failAt) throw new Error(`${FAULT}: purge delete ${current}`);
          return Reflect.apply(original, this, args);
        };
        await assert.rejects(invokeAsPromise(attempt.invoke), new RegExp(`${FAULT}: purge delete ${failAt}`));
      } finally {
        Map.prototype.delete = original;
      }
      assert.equal(exportBytes(attempt.graph), before, `${mode}: delete ${failAt} restores exportData byte-for-byte`);
      await invokeAsPromise(attempt.invoke);
      const after = attempt.graph.exportData();
      assert.equal(after.records.some((item) => item.project === 'transaction'), false);
      assert.equal(after.records.some((item) => item.project === 'kept'), true);
      if (mode === 'logical') assertRebuildParity(attempt.graph, `${mode}: retry after delete ${failAt}`);
    }
  }
});

test('transaction boundary: synchronous clock reentry fails explicitly and rolls the outer mutation back', () => {
  let graph;
  let reenter = false;
  let attempted = false;
  const now = () => {
    if (reenter && !attempted) {
      attempted = true;
      graph.setRevision(99);
    }
    return NOW;
  };
  graph = createShadowGraph({ now });
  const decision = graph.addDecision(decisionInput('transaction-reentry-status'));
  const before = exportBytes(graph);
  reenter = true;
  assert.throws(
    () => graph.updateDecisionStatus(decision.id, 'planned'),
    /mutation.*(?:already|in progress)|reentrant/i
  );
  reenter = false;
  assert.equal(exportBytes(graph), before);
  assert.equal(graph.updateDecisionStatus(decision.id, 'planned').status, 'planned', 'graph remains usable after rejected reentry');
});

test('transaction boundary: verifyFact spans await, rejects concurrent direct mutation explicitly, and releases after rejection', async () => {
  let rejectVerification;
  let verifierEntered;
  const entered = new Promise((resolve) => { verifierEntered = resolve; });
  const verifier = {
    verify() {
      verifierEntered();
      return new Promise((_resolve, reject) => { rejectVerification = reject; });
    },
    validateStored() { return true; }
  };
  const graph = createShadowGraph({ now: () => NOW, verifier });
  const fact = graph.addFact({ id: 'transaction-async-fact', project: 'transaction', key: 'async', value: true });
  const before = exportBytes(graph);
  const pending = graph.verifyFact({ factId: fact.id, evidencePath: 'trusted.json' });
  await entered;

  let concurrentError = null;
  try {
    graph.addAttempt({ id: 'transaction-concurrent-attempt', project: 'transaction', solution: 'concurrent', result: 'must reject' });
  } catch (error) {
    concurrentError = error;
  }
  rejectVerification(new Error('injected verifier rejection'));
  await assert.rejects(pending, /injected verifier rejection/);
  assert.match(concurrentError?.message ?? '', /mutation.*(?:already|in progress)|reentrant/i);
  assert.equal(exportBytes(graph), before, 'verifier rejection and concurrent attempt leave no state');
  assert.equal(graph.addAttempt({ id: 'transaction-after-rejection', project: 'transaction', solution: 'after', result: 'works' }).id, 'transaction-after-rejection');
});

async function postJson(base, path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function durableServerFaultScenario(backend, t) {
  const directory = await scratchDirectory(t, `shadowgraph-transaction-${backend}-`);
  const destination = join(directory, backend === 'sqlite' ? 'data.db' : 'data.json');
  let store;
  try {
    store = backend === 'sqlite' ? await createSqliteStore(destination) : createJsonFileStore(destination);
  } catch (error) {
    if (/requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  const seed = createShadowGraph({ now: () => NOW });
  seed.addDecision(decisionInput(`transaction-${backend}-kept`));
  await store.save(seed.exportData());
  const durableBefore = await store.load();

  const clock = controlledClock();
  const app = await createShadowGraphServer({ file: destination, storage: backend, store, now: () => clock.now() });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const liveBefore = exportBytes(app.graph);
    // addDecision samples createdAt and updatedAt before publishing the record; the
    // third sample is the compatibility event timestamp after records.set().
    clock.arm(3);
    const rejected = await postJson(base, '/decisions', decisionInput(`transaction-${backend}-rejected`));
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /injected transaction fault/);
    clock.arm();
    assert.equal(exportBytes(app.graph), liveBefore, `${backend}: rejected HTTP mutation restores live bytes`);
    assert.deepEqual(await store.load(), durableBefore, `${backend}: rejected HTTP mutation preserves durable state`);

    const successful = await postJson(base, '/decisions', decisionInput(`transaction-${backend}-success`));
    assert.equal(successful.status, 200);
    const persisted = await store.load();
    const restarted = createShadowGraph({ now: () => NOW });
    restarted.importData(persisted);
    assertRebuildParity(restarted, `${backend}: successful retry restart`);
    assert.equal(persisted.records.some((item) => item.id === `transaction-${backend}-rejected`), false);
    assert.equal(persisted.records.some((item) => item.id === `transaction-${backend}-success`), true);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
}

test('transaction boundary: HTTP rejection preserves JSON durability and a later write restarts/rebuilds cleanly', async (t) => {
  await durableServerFaultScenario('json', t);
});

test('transaction boundary: HTTP rejection preserves SQLite durability and a later write restarts/rebuilds cleanly', async (t) => {
  await durableServerFaultScenario('sqlite', t);
});

function nearBoundaryPayload(id) {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision(decisionInput(id));
  const data = graph.exportData();
  data.journal[0].seq = Number.MAX_SAFE_INTEGER - 1;
  data.journalSeq = Number.MAX_SAFE_INTEGER - 1;
  data.journalEpoch = Number.MAX_SAFE_INTEGER - 1;
  return data;
}

function runCli(file, command, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', command, JSON.stringify(payload)], {
      cwd: process.cwd(),
      env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startMcp(file) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json', SHADOWGRAPH_MCP_COMPACT: '0' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffered = '';
  let stderr = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines.filter((candidate) => candidate.trim())) {
      const response = JSON.parse(line);
      const waiter = pending.get(JSON.stringify(response.id));
      if (!waiter) continue;
      pending.delete(JSON.stringify(response.id));
      waiter.resolve(response);
    }
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited with ${code}: ${stderr}`));
    pending.clear();
  });
  return {
    call(request) {
      return new Promise((resolve, reject) => {
        const key = JSON.stringify(request.id);
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`MCP timeout: ${stderr}`));
        }, 10_000);
        pending.set(key, {
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); }
        });
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };
}

async function seedNearBoundaryFile(file, id) {
  const store = createJsonFileStore(file);
  try { await store.save(nearBoundaryPayload(id)); }
  finally { store.close(); }
}

function assertPersistedRebuildParity(data, label) {
  const restarted = createShadowGraph({ now: () => NOW });
  restarted.importData(data);
  assertRebuildParity(restarted, label);
}

test('transaction boundary: CLI rejection preserves bytes, then a smaller successful write restarts with rebuild parity', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-transaction-cli-');
  const file = join(directory, 'data.json');
  const decisionId = 'transaction-cli-decision';
  await seedNearBoundaryFile(file, decisionId);
  const before = await readFile(file);

  const rejected = await runCli(file, 'outcome', { decisionId, outcome: { status: 'successful', observedAt: NOW } });
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /journal sequence overflow/i);
  assert.deepEqual(await readFile(file), before, 'CLI rejection preserves exact durable bytes');

  const successful = await runCli(file, 'status', { decisionId, status: 'planned' });
  assert.equal(successful.code, 0, successful.stderr);
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.records.find((item) => item.id === decisionId).status, 'planned');
  assertPersistedRebuildParity(persisted, 'CLI later successful write');
});

test('transaction boundary: MCP rejection preserves bytes, then a smaller successful write restarts with rebuild parity', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-transaction-mcp-');
  const file = join(directory, 'data.json');
  const decisionId = 'transaction-mcp-decision';
  await seedNearBoundaryFile(file, decisionId);
  const before = await readFile(file);
  const rpc = startMcp(file);
  try {
    await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const rejected = await rpc.call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'shadowgraph_record_outcome', arguments: { decisionId, outcome: { status: 'successful', observedAt: NOW } } }
    });
    assert.equal(rejected.result, undefined, 'legacy tool failures use the numeric JSON-RPC error form');
    assert.deepEqual(rejected.error, { code: -32000, message: 'Tool execution failed' });
    const publicFailure = JSON.stringify(rejected);
    assert.equal(publicFailure.includes(file), false, 'MCP failure disclosed the storage path');
    assert.equal(publicFailure.includes(decisionId), false, 'MCP failure disclosed the decision id');
    assert.equal(publicFailure.includes('journal sequence overflow'), false, 'MCP failure disclosed the raw journal diagnostic');
    assert.deepEqual(await readFile(file), before, 'MCP rejection preserves exact durable bytes');

    const successful = await rpc.call({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'shadowgraph_update_status', arguments: { decisionId, status: 'planned' } }
    });
    assert.equal(successful.error, undefined);
  } finally {
    await rpc.stop();
  }
  const persisted = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(persisted.records.find((item) => item.id === decisionId).status, 'planned');
  assertPersistedRebuildParity(persisted, 'MCP later successful write');
});
