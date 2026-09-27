import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { restoreFile } from '../src/backup.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { privilegedRebuild, privilegedSnapshot } from '../src/internal/snapshot.js';
import { historicalRelation } from '../tools/historical-relation.js';

const FIXED_NOW = '2026-08-27T12:00:00.000Z';
const DUE_AT = '2026-08-27T11:00:00.000Z';
const NODE_SQLITE = (await getRuntimeCapabilities()).nodeSqlite;
const SQLITE_TEST_OPTIONS = NODE_SQLITE.available ? {} : { skip: NODE_SQLITE.reason };

function startMcp(file, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: file, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const responses = [];
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop();
    for (const line of lines.filter((candidate) => candidate.trim())) {
      const response = JSON.parse(line);
      responses.push(response);
      const key = JSON.stringify(response.id);
      const waiter = pending.get(key);
      if (waiter) {
        pending.delete(key);
        waiter.resolve(response);
      }
    }
  });
  child.on('exit', (code) => {
    const error = new Error(`MCP exited before replying (code ${code}): ${stderr}`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  return {
    child,
    responses,
    send(request) { child.stdin.write(`${JSON.stringify(request)}\n`); },
    call(request) {
      assert.ok(Object.prototype.hasOwnProperty.call(request, 'id'), 'call() requires an identified JSON-RPC request');
      const key = JSON.stringify(request.id);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`Timed out waiting for MCP response to ${request.method}: ${stderr}`));
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

function maintenanceFixture() {
  const graph = createShadowGraph({ now: () => FIXED_NOW });
  graph.addDecision({
    project: 'maintain-project', title: 'Keep atomic', chosen: 'preflight',
    reviewAfter: DUE_AT,
    alternatives: [{ label: 'rollback', reopenWhen: ['changed-flag'] }]
  });
  graph.addFact({
    project: 'maintain-project', key: 'expires', value: true,
    validFrom: '2026-08-27T10:00:00.000Z', expiresAt: DUE_AT
  });
  return graph;
}

function assertMaintenanceSeedUnchanged(payload, before) {
  assert.equal(payload.records.find((record) => record.id === before.records[0].id).status, 'proposed');
  assert.equal(payload.facts.find((fact) => fact.id === before.facts[0].id).status, 'active');
  assert.deepEqual(payload.reviewSignals, before.reviewSignals);
}

test('P1-4 independent review: review and maintain preflight every caller input before any core mutation', () => {
  const malformedReviewInputs = [
    { changedFacts: {} },
    { facts: [] },
    { facts: { unsafe: new Date(FIXED_NOW) } },
    { project: '' },
    { asOf: 'not-a-timestamp' },
    null,
    []
  ];
  for (const input of malformedReviewInputs) {
    const graph = maintenanceFixture();
    const before = privilegedSnapshot(graph);
    assert.throws(() => graph.review(input).items);
    assert.deepEqual(privilegedSnapshot(graph), before, `review(${String(input)}) must be atomic`);
  }

  const malformedMaintainInputs = [
    { now: FIXED_NOW, changedFacts: {}, facts: {} },
    { now: FIXED_NOW, changedFacts: [], facts: [] },
    { now: 'not-a-timestamp', changedFacts: [], facts: {} },
    { now: FIXED_NOW, changedFacts: [], facts: { unsafe: new Date(FIXED_NOW) } },
    null,
    []
  ];
  for (const input of malformedMaintainInputs) {
    const graph = maintenanceFixture();
    const before = privilegedSnapshot(graph);
    assert.throws(() => graph.maintain(input));
    assert.deepEqual(privilegedSnapshot(graph), before, `maintain(${String(input)}) must be atomic`);

    graph.addAttempt({ project: 'maintain-project', solution: 'continue safely', result: 'valid' });
    const after = privilegedSnapshot(graph);
    assertMaintenanceSeedUnchanged(after, before);
    assert.equal(after.journalSeq, before.journalSeq + 1, 'the rejected maintain call must not consume a sequence');
    assert.equal(after.journal.length, before.journal.length + 1, 'only the subsequent valid write may append');
    assert.equal(after.events.length, before.events.length + 1, 'only the subsequent valid write may emit an event');
    assert.equal(after.revision, before.revision, 'core rejection must not advance the durable revision');
  }
});

test('P1-4 independent review: real MCP maintain rejection rolls live graph back before a later valid persistence', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-independent-p1-4-mcp-');
  const file = join(directory, 'state.json');
  const store = createJsonFileStore(file);
  const seed = maintenanceFixture();
  await store.save(privilegedSnapshot(seed));
  const before = await store.load();
  const beforeBytes = await readFile(file);

  const rpc = startMcp(file);
  t.after(async () => { await rpc.stop(); store.close(); });
  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const rejected = await rpc.call({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: {
      name: 'shadowgraph_maintain',
      arguments: { project: 'maintain-project', now: FIXED_NOW, changedFacts: {}, facts: {} }
    }
  });
  const bytesAfterRejection = await readFile(file);

  const journalResponse = await rpc.call({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'shadowgraph_journal', arguments: { project: 'maintain-project', limit: 1000 } }
  });
  const signalsResponse = await rpc.call({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'shadowgraph_review_signals', arguments: { project: 'maintain-project' } }
  });
  const searchResponse = await rpc.call({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'shadowgraph_search', arguments: { project: 'maintain-project', query: 'Keep atomic', limit: 10 } }
  });

  const valid = await rpc.call({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: {
      name: 'shadowgraph_record_attempt',
      arguments: { project: 'maintain-project', solution: 'continue safely', result: 'valid' }
    }
  });
  await rpc.stop();
  const after = await store.load();

  assert.ok(rejected.error, 'malformed maintain notification must be rejected');
  assert.deepEqual(bytesAfterRejection, beforeBytes, 'rejected MCP call must not alter durable bytes');

  const liveJournal = JSON.parse(journalResponse.result.content[0].text);
  assert.deepEqual(liveJournal.items, before.journal, 'rejected MCP call must not alter the live journal');
  assert.equal(Object.hasOwn(liveJournal.completeness, 'journalSeq'), false);
  assert.equal(liveJournal.items.at(-1).seq, before.journalSeq, 'the complete scoped fixture retains its last canonical sequence');
  assert.deepEqual(JSON.parse(signalsResponse.result.content[0].text).items, before.reviewSignals);
  const liveDecision = JSON.parse(searchResponse.result.content[0].text).items[0].record;
  assert.equal(liveDecision.status, 'proposed', 'rejected MCP call must restore the live decision');
  assert.equal(valid.error, undefined, valid.error?.message);

  assertMaintenanceSeedUnchanged(after, before);
  assert.equal(after.journalSeq, before.journalSeq + 1, 'only the valid MCP write may consume a sequence');
  assert.equal(after.journal.length, before.journal.length + 1);
  assert.equal(after.events.length, before.events.length + 1);
  assert.equal(after.revision, before.revision + 1, 'only the valid persisted call may advance revision');
  assert.equal(after.records.some((record) => record.id === JSON.parse(valid.result.content[0].text).id), true);
});

const PURGE_SECRET = 'SUPER-SECRET-42';
const PURGE_PROJECT = 'private-project';

function assertSecretAbsent(value, label) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  assert.equal(bytes.includes(Buffer.from(PURGE_SECRET)), false, `${label} retained secret entity-id bytes`);
}

function purgeFixture() {
  const graph = createShadowGraph({ now: () => FIXED_NOW });
  const kept = graph.addDecision({
    project: 'kept-project', title: 'Kept', chosen: 'safe', idempotencyKey: 'kept-retry'
  });
  const decision = graph.addDecision({
    project: PURGE_PROJECT, title: 'Private decision', chosen: 'private',
    idempotencyKey: `decision-retry_${PURGE_SECRET}`,
    reviewAfter: DUE_AT,
    alternatives: [{ label: 'Private alternative', reopenWhen: ['private-change'] }]
  });
  const fact = graph.addFact({
    project: PURGE_PROJECT, key: 'private-fact', value: true,
    idempotencyKey: `fact-retry_${PURGE_SECRET}`
  });
  const memory = graph.remember({
    project: PURGE_PROJECT,
    scope: { userId: 'private-user', agentId: null, runId: null },
    memoryType: 'profile', key: 'private-memory', text: 'private memory',
    idempotencyKey: `memory-retry_${PURGE_SECRET}`
  }).memory;
  // A relation into this project from another, as a store written before
  // link() refused one holds it (PR-09); the purge removes it all the same.
  const history = historicalRelation({
    id: `relation_${PURGE_SECRET}`, from: kept.id, to: decision.alternatives[0].id, relation: 'depends_on',
    project: 'kept-project', seq: privilegedSnapshot(graph).journalSeq + 1, at: FIXED_NOW
  });
  graph.importData(history);
  const [relation] = history.relations;
  // Administrative fixture: older stores can carry secret-bearing identities.
  // Hydrate every occurrence before exercising erasure; ordinary writes above
  // allocate IDs and the test never routes production creation through a bypass.
  const historicalIds = new Map([
    [decision.id, `decision_${PURGE_SECRET}`],
    [decision.alternatives[0].id, `alternative_${PURGE_SECRET}`],
    [fact.id, `fact_${PURGE_SECRET}`], [memory.id, `memory_${PURGE_SECRET}`]
  ]);
  const historical = (value) => typeof value === 'string' ? (historicalIds.get(value) ?? value)
    : Array.isArray(value) ? value.map(historical)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, historical(item)])) : value;
  graph.replaceData(historical(privilegedSnapshot(graph)));
  graph.review({ project: PURGE_PROJECT, asOf: FIXED_NOW }).items;
  return { graph, kept, decision: historical(decision), fact: historical(fact), memory: historical(memory), relation: historical(relation) };
}

async function createStore(backend, file) {
  return backend === 'sqlite' ? createSqliteStore(file) : createJsonFileStore(file);
}

async function assertPurgeErasureAcrossBackend(t, backend, mode) {
  const directory = await scratchDirectory(t, `shadowgraph-independent-p2-5-${backend}-${mode}-`);
  const extension = backend === 'sqlite' ? 'db' : 'json';
  const sourcePath = join(directory, `source.${extension}`);
  const destinationPath = join(directory, `destination.${extension}`);
  const { graph, kept } = purgeFixture();
  const before = privilegedSnapshot(graph);
  assert.equal(before.records.filter((record) => record.project === PURGE_PROJECT).length, 2);
  assert.equal(before.facts.filter((fact) => fact.project === PURGE_PROJECT).length, 1);
  assert.equal(before.relations.length, 1);
  assert.equal(before.reviewSignals.length, 1);
  assert.equal(before.idempotency.filter((entry) => entry.value.project === PURGE_PROJECT).length, 3);

  const result = graph.purgeProject(PURGE_PROJECT, { mode });
  const live = privilegedSnapshot(graph);
  assert.deepEqual(
    { records: result.records, facts: result.facts, relations: result.relations, removed: result.removed, idempotencyRemoved: result.idempotencyRemoved },
    { records: 2, facts: 1, relations: 1, removed: 4, idempotencyRemoved: 3 }
  );
  assert.equal(result.mode, mode);
  assert.equal(result.journalEntriesRemoved > 0, mode === 'hard');
  assert.equal(result.journalEntriesRedacted > 0, mode === 'logical');
  assert.equal(live.records.length, 1);
  assert.equal(live.records[0].id, kept.id);
  assert.equal(live.facts.length, 0);
  assert.equal(live.relations.length, 0, 'cross-project relation must be removed');
  assert.equal(live.reviewSignals.length, 0);
  assert.deepEqual(live.idempotency.map((entry) => entry.value.id), [kept.id]);
  assertSecretAbsent(live, `${mode} live export`);
  assertSecretAbsent(live.journal, `${mode} journal`);
  assertSecretAbsent(live.events, `${mode} events`);
  assertSecretAbsent(live.idempotency, `${mode} idempotency`);

  const marker = live.journal.findLast((entry) => entry.type === 'project.purged');
  assert.ok(marker);
  assert.equal(Object.hasOwn(marker.payload, 'purgedEntityIds'), false, 'purge marker must not retain raw entity ids');
  assert.equal(marker.entityId, null, 'purge marker must not place caller data in entityId');
  if (mode === 'logical') {
    const skeletons = live.journal.filter((entry) => entry.redactedReason === 'project_purged');
    assert.ok(skeletons.length >= 4);
    assert.ok(skeletons.every((entry) => entry.payload === null && entry.entityId === null));
    assert.ok(skeletons.every((entry) => !Object.hasOwn(entry, 'idempotencyKey')));
  } else {
    assert.ok(marker.payload.removedJournalSequences.length >= 4, 'hard purge gap evidence must survive without entity ids');
  }

  const rebuild = privilegedRebuild(graph);
  assertSecretAbsent(rebuild, `${mode} rebuild`);
  assert.equal(rebuild.projection.records.length, 1);
  assert.equal(rebuild.projection.records[0].id, kept.id);
  assert.equal(rebuild.projection.facts.length, 0);
  assert.equal(rebuild.projection.relations.length, 0);
  assert.deepEqual(rebuild.projection.idempotency.map((entry) => entry.value.id), [kept.id]);
  assert.equal(rebuild.rebuildable, mode === 'logical');
  assert.doesNotThrow(() => validateRestorePayload(live));

  let sourceStore = await createStore(backend, sourcePath);
  await sourceStore.save(live);
  sourceStore.close();
  assertSecretAbsent(await readFile(sourcePath), `${mode} ${backend} durable file`);

  sourceStore = await createStore(backend, sourcePath);
  const reopened = await sourceStore.load();
  sourceStore.close();
  assertSecretAbsent(reopened, `${mode} reopened ${backend}`);
  assert.equal(reopened.records.length, 1);
  assert.equal(reopened.relations.length, 0);
  assert.doesNotThrow(() => validateRestorePayload(reopened));

  let destinationStore = await createStore(backend, destinationPath);
  const destinationSeed = createShadowGraph({ now: () => FIXED_NOW });
  destinationSeed.addDecision({ project: 'destination', title: 'Replace me', chosen: 'old' });
  await destinationStore.save(privilegedSnapshot(destinationSeed));
  if (backend === 'sqlite') {
    await destinationStore.restore(sourcePath);
  } else {
    destinationStore.close();
    await restoreFile(sourcePath, destinationPath);
    destinationStore = await createStore(backend, destinationPath);
  }
  const restored = await destinationStore.load();
  destinationStore.close();
  assertSecretAbsent(restored, `${mode} restored ${backend}`);
  assert.deepEqual(restored.records.map((record) => record.id), [kept.id]);
  assert.equal(restored.relations.length, 0);
  assert.doesNotThrow(() => validateRestorePayload(restored));
}

test('P2-5 independent review: logical and hard purge erase secret-bearing ids across JSON and SQLite restart/restore', async (t) => {
  for (const backend of ['json', 'sqlite']) {
    for (const mode of ['logical', 'hard']) {
      await t.test(`${backend} ${mode}`, backend === 'sqlite' ? SQLITE_TEST_OPTIONS : {}, async (subtest) => {
        await assertPurgeErasureAcrossBackend(subtest, backend, mode);
      });
    }
  }
});

test('P2-6 independent review: all valid no-id stdio requests execute but emit only the later identified response', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-independent-p2-6-notifications-');
  const file = join(directory, 'state.json');
  const rpc = startMcp(file);
  t.after(async () => { await rpc.stop(); });

  rpc.send({ jsonrpc: '2.0', method: 'tools/list' });
  rpc.send({
    jsonrpc: '2.0', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'notification-test', version: '1.0.0' } }
  });
  rpc.send({
    jsonrpc: '2.0', method: 'tools/call',
    params: {
      name: 'shadowgraph_record_decision',
      arguments: { project: 'notifications', title: 'Notification mutation', chosen: 'execute' }
    }
  });
  const created = await rpc.call({
    jsonrpc: '2.0', id: 899, method: 'tools/call',
    params: { name: 'shadowgraph_search', arguments: { project: 'notifications', query: 'Notification mutation', limit: 10 } }
  });
  const createdDecision = JSON.parse(created.result.content[0].text).items[0].record;
  rpc.send({
    jsonrpc: '2.0', method: 'tools/call',
    params: {
      name: 'shadowgraph_update_status',
      arguments: { project: 'notifications', decisionId: createdDecision.id, status: 'validated' }
    }
  });

  const identified = await rpc.call({
    jsonrpc: '2.0', id: 900, method: 'tools/call',
    params: { name: 'shadowgraph_search', arguments: { project: 'notifications', query: 'Notification mutation', limit: 10 } }
  });
  await delay(100);

  assert.deepEqual(rpc.responses.map((response) => response.id), [899, 900], 'valid notifications must emit no success or error response');
  const search = JSON.parse(identified.result.content[0].text);
  assert.deepEqual(search.items.map((item) => item.record.id), [createdDecision.id]);
  assert.equal(search.items[0].record.status, 'proposed', 'failed notification execution must roll back without undoing the prior successful notification');

  await rpc.stop();
  const store = createJsonFileStore(file);
  const durable = await store.load();
  store.close();
  assert.deepEqual(durable.records.map((record) => record.id), [createdDecision.id], 'successful tool notification must still persist its intended mutation');
  assert.equal(durable.records[0].status, 'proposed');
  assert.equal(durable.revision, 1);
});

test('P2-6 independent review: id:null remains a request and malformed JSON still receives a parse error', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-independent-p2-6-null-');
  const rpc = startMcp(join(directory, 'state.json'));
  t.after(async () => { await rpc.stop(); });

  const explicitNull = await rpc.call({ jsonrpc: '2.0', id: null, method: 'tools/list' });
  assert.equal(explicitNull.id, null);
  assert.ok(Array.isArray(explicitNull.result.tools));

  rpc.child.stdin.write('{not-json\n');
  for (let attempt = 0; attempt < 100 && rpc.responses.length < 2; attempt += 1) await delay(10);
  assert.equal(rpc.responses.length, 2);
  assert.equal(rpc.responses[1].id, null);
  assert.equal(rpc.responses[1].error.code, -32700);
});
