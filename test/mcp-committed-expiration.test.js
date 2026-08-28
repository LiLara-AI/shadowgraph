import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as shadowgraph from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createFactAttestation } from '../src/verification.js';

const BEFORE_BOUNDARY = '2099-08-28T00:00:00.999Z';
const BOUNDARY = '2099-08-28T00:00:01.000Z';

function toolRequest(id, name, args = {}) {
  return {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: args }
  };
}

function toolPayload(response) {
  assert.equal(response.error, undefined, response.error?.message);
  return JSON.parse(response.result.content[0].text);
}

function startMcp(file, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: file, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop();
    for (const line of lines.filter(Boolean)) {
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
          reject(new Error(`MCP timed out: ${stderr}`));
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

async function realVerifierFixture(directory) {
  const keys = generateKeyPairSync('ed25519');
  const evidenceRoot = join(directory, 'evidence');
  const clockFile = join(directory, 'clock.txt');
  const configPath = join(directory, 'verifier.json');
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(clockFile, BEFORE_BOUNDARY, 'utf8');
  await writeFile(configPath, JSON.stringify({
    allowedEvidenceRoot: evidenceRoot,
    trustedVerifiers: {
      approver: keys.publicKey.export({ type: 'spki', format: 'pem' })
    }
  }), 'utf8');
  return { keys, evidenceRoot, clockFile, configPath };
}

async function loadJson(file) {
  const store = createJsonFileStore(file);
  try { return await store.load(); }
  finally { store.close(); }
}

async function loadSqlite(file) {
  const store = await createSqliteStore(file);
  try { return await store.load(); }
  finally { store.close(); }
}

async function loadBackend(backend, file) {
  return backend === 'sqlite' ? loadSqlite(file) : loadJson(file);
}

async function setupVerifiedMcp(t, backend, label) {
  const directory = await mkdtemp(join(tmpdir(), `shadowgraph-mcp-${label}-${backend}-`));
  const file = join(directory, backend === 'sqlite' ? 'data.db' : 'data.json');
  const fixture = await realVerifierFixture(directory);
  if (backend === 'sqlite') {
    let probe;
    try { probe = await createSqliteStore(file); }
    catch (error) {
      if (/requires Node/.test(error.message)) {
        t.skip(error.message);
        return null;
      }
      throw error;
    }
    probe.close();
  }
  const faultFile = join(directory, 'save-fault.txt');
  await writeFile(faultFile, '', 'utf8');
  const env = {
    NODE_ENV: 'test',
    SHADOWGRAPH_STORAGE: backend,
    SHADOWGRAPH_VERIFIER_CONFIG: fixture.configPath,
    SHADOWGRAPH_TEST_CLOCK_FILE: fixture.clockFile,
    SHADOWGRAPH_TEST_SAVE_FAULT_FILE: faultFile
  };
  const rpc = startMcp(file, env);
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: `${label}-list`, method: 'tools/list' });
  const fact = toolPayload(await rpc.call(toolRequest(`${label}-record`, 'shadowgraph_record_fact', {
    id: `${label}-${backend}-fact`,
    project: label,
    key: 'release-ready',
    value: true,
    expiresAt: BOUNDARY
  })));
  const evidencePath = join(fixture.evidenceRoot, `${label}-${backend}.json`);
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({
    fact,
    verifierIdentity: 'approver',
    evidenceReference: `ticket:${label}:${backend}`,
    verifiedAt: BEFORE_BOUNDARY,
    privateKey: fixture.keys.privateKey
  })), 'utf8');
  const first = toolPayload(await rpc.call(toolRequest(`${label}-verify`, 'shadowgraph_verify_fact', { factId: fact.id, evidencePath })));
  assert.equal(first.operation, 'VERIFIED');
  assert.equal((await loadBackend(backend, file)).revision, 2);
  return { backend, file, fixture, faultFile, env, rpc, fact, evidencePath };
}

function committedExpirationFixture() {
  const clock = { value: BEFORE_BOUNDARY };
  const attestation = { factId: 'mcp-committed-expiration', verifierIdentity: 'test-verifier' };
  const verifier = {
    async verify() { return structuredClone(attestation); },
    validateStored(_fact, { trustedValidationInstant } = {}) {
      return Date.parse(trustedValidationInstant) < Date.parse(BOUNDARY);
    }
  };
  const graph = shadowgraph.createShadowGraph({ verifier, now: () => clock.value });
  const fact = graph.addFact({
    id: attestation.factId,
    project: 'mcp-committed-expiration',
    key: 'release-ready',
    value: true,
    expiresAt: BOUNDARY
  });
  return { graph, fact, clock };
}

test('committed expiration rejection is tagged for persistence adapters', async () => {
  const { graph, fact, clock } = committedExpirationFixture();
  await graph.verifyFact({ factId: fact.id, evidencePath: 'controlled-evidence.json' });
  clock.value = BOUNDARY;

  const error = await graph.verifyFact({ factId: fact.id, evidencePath: 'controlled-evidence.json' })
    .then(() => null, (reason) => reason);

  assert.equal(typeof shadowgraph.isCommittedRejection, 'function');
  assert.equal(shadowgraph.isCommittedRejection(error), true);
  assert.match(error.message, /invalid or expired persisted fact verification/i);
  assert.equal(graph.exportData().facts[0].verificationStatus, 'expired');
  assert.equal(graph.exportData().journal.at(-1).type, 'fact.expired');
});

test('MCP JSON persists a committed expiration before returning the legacy verification rejection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-mcp-committed-expiration-json-'));
  const file = join(directory, 'data.json');
  const fixture = await realVerifierFixture(directory);
  let rpc = startMcp(file, {
    NODE_ENV: 'test',
    SHADOWGRAPH_STORAGE: 'json',
    SHADOWGRAPH_VERIFIER_CONFIG: fixture.configPath,
    SHADOWGRAPH_TEST_CLOCK_FILE: fixture.clockFile
  });
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  const fact = toolPayload(await rpc.call(toolRequest(2, 'shadowgraph_record_fact', {
    id: 'mcp-json-committed-expiration',
    project: 'mcp-committed-expiration',
    key: 'release-ready',
    value: true,
    expiresAt: BOUNDARY
  })));
  const evidencePath = join(fixture.evidenceRoot, 'signed.json');
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({
    fact,
    verifierIdentity: 'approver',
    evidenceReference: 'ticket:MCP-COMMITTED-EXPIRATION',
    verifiedAt: BEFORE_BOUNDARY,
    privateKey: fixture.keys.privateKey
  })), 'utf8');

  const first = toolPayload(await rpc.call(toolRequest(3, 'shadowgraph_verify_fact', { factId: fact.id, evidencePath })));
  assert.equal(first.operation, 'VERIFIED');
  assert.equal(first.fact.verificationStatus, 'verified');
  const verifiedDurable = await loadJson(file);
  assert.equal(verifiedDurable.revision, 2);
  assert.equal(verifiedDurable.facts[0].verificationStatus, 'verified');
  assert.equal(verifiedDurable.journal.at(-1).type, 'fact.verified');

  await writeFile(fixture.clockFile, BOUNDARY, 'utf8');
  const retry = await rpc.call(toolRequest(4, 'shadowgraph_verify_fact', { factId: fact.id, evidencePath }));
  assert.equal(retry.error.code, -32000);
  assert.match(retry.error.message, /invalid or expired persisted fact verification/i);

  const liveJournal = toolPayload(await rpc.call(toolRequest(5, 'shadowgraph_journal', { limit: 100 })));
  assert.equal(liveJournal.items.at(-1).type, 'fact.expired');
  assert.equal(liveJournal.items.at(-1).payload.status, 'expired');
  assert.equal(liveJournal.items.at(-1).payload.verificationStatus, 'expired');

  const durable = await loadJson(file);
  assert.equal(durable.revision, 3);
  assert.equal(durable.facts[0].status, 'expired');
  assert.equal(durable.facts[0].verificationStatus, 'expired');
  assert.equal(durable.journal.at(-1).type, 'fact.expired');
  assert.deepEqual(durable.journal.at(-1).payload, durable.facts[0]);

  await rpc.stop();
  rpc = startMcp(file, {
    NODE_ENV: 'test',
    SHADOWGRAPH_STORAGE: 'json',
    SHADOWGRAPH_VERIFIER_CONFIG: fixture.configPath,
    SHADOWGRAPH_TEST_CLOCK_FILE: fixture.clockFile
  });
  await rpc.call({ jsonrpc: '2.0', id: 6, method: 'tools/list' });
  const rebuilt = toolPayload(await rpc.call(toolRequest(7, 'shadowgraph_rebuild')));
  assert.equal(rebuilt.rebuildable, true);
  const rebuiltFact = rebuilt.projection.facts.find((item) => item.id === fact.id);
  assert.equal(rebuiltFact.status, 'expired');
  assert.equal(rebuiltFact.verificationStatus, 'expired');
  assert.deepEqual(rebuiltFact, durable.facts[0]);
  const recall = toolPayload(await rpc.call(toolRequest(8, 'shadowgraph_recall', {
    project: fact.project,
    query: 'release ready'
  })));
  assert.equal(recall.items.some((item) => item.record.id === fact.id), false, 'restart must not expose expired trust');
});

test('MCP SQLite persists a committed expiration with JSON-equivalent restart and rebuild state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-mcp-committed-expiration-sqlite-'));
  const file = join(directory, 'data.db');
  const fixture = await realVerifierFixture(directory);
  let probe;
  try { probe = await createSqliteStore(file); }
  catch (error) {
    if (/requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  probe.close();

  const env = {
    NODE_ENV: 'test',
    SHADOWGRAPH_STORAGE: 'sqlite',
    SHADOWGRAPH_VERIFIER_CONFIG: fixture.configPath,
    SHADOWGRAPH_TEST_CLOCK_FILE: fixture.clockFile
  };
  let rpc = startMcp(file, env);
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 20, method: 'tools/list' });

  const fact = toolPayload(await rpc.call(toolRequest(21, 'shadowgraph_record_fact', {
    id: 'mcp-sqlite-committed-expiration',
    project: 'mcp-committed-expiration',
    key: 'release-ready',
    value: true,
    expiresAt: BOUNDARY
  })));
  const evidencePath = join(fixture.evidenceRoot, 'signed-sqlite.json');
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({
    fact,
    verifierIdentity: 'approver',
    evidenceReference: 'ticket:MCP-SQLITE-COMMITTED-EXPIRATION',
    verifiedAt: BEFORE_BOUNDARY,
    privateKey: fixture.keys.privateKey
  })), 'utf8');

  const first = toolPayload(await rpc.call(toolRequest(22, 'shadowgraph_verify_fact', { factId: fact.id, evidencePath })));
  assert.equal(first.operation, 'VERIFIED');
  assert.equal(first.fact.verificationStatus, 'verified');
  const verifiedDurable = await loadSqlite(file);
  assert.equal(verifiedDurable.revision, 2);
  assert.equal(verifiedDurable.facts[0].verificationStatus, 'verified');
  assert.equal(verifiedDurable.journal.at(-1).type, 'fact.verified');

  await writeFile(fixture.clockFile, BOUNDARY, 'utf8');
  const retry = await rpc.call(toolRequest(23, 'shadowgraph_verify_fact', { factId: fact.id, evidencePath }));
  assert.equal(retry.error.code, -32000);
  assert.match(retry.error.message, /invalid or expired persisted fact verification/i);

  const liveJournal = toolPayload(await rpc.call(toolRequest(24, 'shadowgraph_journal', { limit: 100 })));
  assert.equal(liveJournal.items.at(-1).type, 'fact.expired');
  assert.equal(liveJournal.items.at(-1).payload.verificationStatus, 'expired');
  const durable = await loadSqlite(file);
  assert.equal(durable.revision, 3);
  assert.equal(durable.facts[0].status, 'expired');
  assert.equal(durable.facts[0].verificationStatus, 'expired');
  assert.equal(durable.journal.at(-1).type, 'fact.expired');
  assert.deepEqual(durable.journal.at(-1).payload, durable.facts[0]);

  await rpc.stop();
  rpc = startMcp(file, env);
  await rpc.call({ jsonrpc: '2.0', id: 25, method: 'tools/list' });
  const rebuilt = toolPayload(await rpc.call(toolRequest(26, 'shadowgraph_rebuild')));
  assert.equal(rebuilt.rebuildable, true);
  const rebuiltFact = rebuilt.projection.facts.find((item) => item.id === fact.id);
  assert.deepEqual(rebuiltFact, durable.facts[0]);
  assert.equal(rebuiltFact.status, 'expired');
  assert.equal(rebuiltFact.verificationStatus, 'expired');
  const recall = toolPayload(await rpc.call(toolRequest(27, 'shadowgraph_recall', {
    project: fact.project,
    query: 'release ready'
  })));
  assert.equal(recall.items.some((item) => item.record.id === fact.id), false, 'SQLite restart must not expose expired trust');
});

test('MCP JSON fails closed and latches after committed expiration persistence fails before commit', async (t) => {
  const scenario = await setupVerifiedMcp(t, 'json', 'precommit-failure');
  await writeFile(scenario.faultFile, 'beforeCommit', 'utf8');
  await writeFile(scenario.fixture.clockFile, BOUNDARY, 'utf8');

  const retry = await scenario.rpc.call(toolRequest('precommit-retry', 'shadowgraph_verify_fact', {
    factId: scenario.fact.id,
    evidencePath: scenario.evidencePath
  }));
  assert.equal(retry.error.code, -32001);
  assert.match(retry.error.message, /committed expiration.*(?:persist|durable)|persistent storage unavailable/i);
  assert.equal(await readFile(scenario.faultFile, 'utf8'), 'triggered:beforeCommit');

  const durable = await loadJson(scenario.file);
  assert.equal(durable.revision, 2);
  assert.equal(durable.facts[0].status, 'active');
  assert.equal(durable.facts[0].verificationStatus, 'verified');
  assert.equal(durable.journal.at(-1).type, 'fact.verified');

  const blockedRead = await scenario.rpc.call(toolRequest('precommit-blocked-read', 'shadowgraph_journal', { limit: 100 }));
  assert.equal(blockedRead.error.code, -32001);
  const blockedWrite = await scenario.rpc.call(toolRequest('precommit-blocked-write', 'shadowgraph_record_decision', {
    id: 'must-not-land', title: 'Must not land', chosen: 'blocked'
  }));
  assert.equal(blockedWrite.error.code, -32001);
  assert.equal((await loadJson(scenario.file)).revision, 2);
});

test('MCP SQLite fails closed and latches after committed expiration persistence fails before commit', async (t) => {
  const scenario = await setupVerifiedMcp(t, 'sqlite', 'precommit-failure');
  if (!scenario) return;
  await writeFile(scenario.faultFile, 'beforeCommit', 'utf8');
  await writeFile(scenario.fixture.clockFile, BOUNDARY, 'utf8');

  const retry = await scenario.rpc.call(toolRequest('sqlite-precommit-retry', 'shadowgraph_verify_fact', {
    factId: scenario.fact.id,
    evidencePath: scenario.evidencePath
  }));
  assert.equal(retry.error.code, -32001);
  assert.match(retry.error.message, /committed expiration.*(?:persist|durable)|persistent storage unavailable/i);
  assert.equal(await readFile(scenario.faultFile, 'utf8'), 'triggered:beforeCommit');
  const durable = await loadSqlite(scenario.file);
  assert.equal(durable.revision, 2);
  assert.equal(durable.facts[0].status, 'active');
  assert.equal(durable.facts[0].verificationStatus, 'verified');
  assert.equal(durable.journal.at(-1).type, 'fact.verified');

  const blocked = await scenario.rpc.call(toolRequest('sqlite-precommit-blocked', 'shadowgraph_journal', { limit: 100 }));
  assert.equal(blocked.error.code, -32001);
  assert.equal((await loadSqlite(scenario.file)).revision, 2);
});

for (const backend of ['json', 'sqlite']) {
  test(`MCP ${backend} read-back recognizes an injected post-commit expiration and permits later operations`, async (t) => {
    const scenario = await setupVerifiedMcp(t, backend, 'postcommit-failure');
    if (!scenario) return;
    await writeFile(scenario.faultFile, 'afterCommit', 'utf8');
    await writeFile(scenario.fixture.clockFile, BOUNDARY, 'utf8');

    const retry = await scenario.rpc.call(toolRequest(`${backend}-postcommit-retry`, 'shadowgraph_verify_fact', {
      factId: scenario.fact.id,
      evidencePath: scenario.evidencePath
    }));
    assert.equal(retry.error.code, -32000);
    assert.match(retry.error.message, /invalid or expired persisted fact verification/i);
    assert.equal(await readFile(scenario.faultFile, 'utf8'), 'triggered:afterCommit');

    const liveJournal = toolPayload(await scenario.rpc.call(toolRequest(`${backend}-postcommit-journal`, 'shadowgraph_journal', { limit: 100 })));
    assert.equal(liveJournal.items.at(-1).type, 'fact.expired');
    const committed = await loadBackend(backend, scenario.file);
    assert.equal(committed.revision, 3);
    assert.equal(committed.facts[0].status, 'expired');
    assert.equal(committed.facts[0].verificationStatus, 'expired');
    assert.equal(committed.journal.at(-1).type, 'fact.expired');

    const later = toolPayload(await scenario.rpc.call(toolRequest(`${backend}-postcommit-later`, 'shadowgraph_record_decision', {
      id: `${backend}-later-decision`,
      project: 'later-operations',
      title: 'Later operation',
      chosen: 'queue and revision remain usable'
    })));
    assert.equal(later.id, `${backend}-later-decision`);
    const afterLater = await loadBackend(backend, scenario.file);
    assert.equal(afterLater.revision, 4, 'read-back must advance the live expected revision before the later save');
    assert.equal(afterLater.records.some((record) => record.id === later.id), true);
    assert.equal(afterLater.journal.at(-1).type, 'decision.recorded');
  });
}

for (const backend of ['json', 'sqlite']) {
  test(`MCP ${backend} fails closed when an independent writer wins before committed expiration persistence`, async (t) => {
    const scenario = await setupVerifiedMcp(t, backend, 'independent-writer-conflict');
    if (!scenario) return;

    const writer = startMcp(scenario.file, scenario.env);
    t.after(async () => { await writer.stop(); });
    await writer.call({ jsonrpc: '2.0', id: `${backend}-writer-list`, method: 'tools/list' });
    const independent = toolPayload(await writer.call(toolRequest(`${backend}-writer-save`, 'shadowgraph_record_decision', {
      id: `${backend}-independent-winner`,
      project: 'independent-writer',
      title: 'Independent writer wins',
      chosen: 'preserve its committed revision'
    })));
    assert.equal(independent.id, `${backend}-independent-winner`);
    await writer.stop();
    const afterWriter = await loadBackend(backend, scenario.file);
    assert.equal(afterWriter.revision, 3);
    assert.equal(afterWriter.records.some((record) => record.id === independent.id), true);

    await writeFile(scenario.fixture.clockFile, BOUNDARY, 'utf8');
    const retry = await scenario.rpc.call(toolRequest(`${backend}-conflict-retry`, 'shadowgraph_verify_fact', {
      factId: scenario.fact.id,
      evidencePath: scenario.evidencePath
    }));
    assert.equal(retry.error.code, -32001);
    assert.equal(retry.error.data.issueCode, 'committed_rejection_persistence_unconfirmed');
    assert.equal(retry.error.data.expirationDurable, false);
    assert.match(retry.error.data.persistenceError, /revision conflict/i);

    const durable = await loadBackend(backend, scenario.file);
    assert.equal(durable.revision, 3);
    assert.equal(durable.records.some((record) => record.id === independent.id), true);
    assert.equal(durable.facts[0].status, 'active');
    assert.equal(durable.facts[0].verificationStatus, 'verified');
    assert.equal(durable.journal.some((entry) => entry.type === 'fact.expired'), false);
    assert.equal(durable.journal.at(-1).type, 'decision.recorded');

    const blockedRead = await scenario.rpc.call(toolRequest(`${backend}-conflict-blocked-read`, 'shadowgraph_recall', {
      project: scenario.fact.project,
      query: 'release ready'
    }));
    assert.equal(blockedRead.error.code, -32001, 'no later read may expose the now-expired durable verification');
    const blockedWrite = await scenario.rpc.call(toolRequest(`${backend}-conflict-blocked-write`, 'shadowgraph_record_decision', {
      id: `${backend}-blocked-after-conflict`, title: 'Blocked', chosen: 'must not persist'
    }));
    assert.equal(blockedWrite.error.code, -32001);
    assert.equal((await loadBackend(backend, scenario.file)).revision, 3);
  });
}
