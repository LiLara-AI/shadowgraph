import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { restoreFile } from '../src/backup.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createFactAttestation, createLocalEvidenceVerifier } from '../src/verification.js';
import { createRestoreValidator } from '../src/restore-validation.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

function startMcp(file, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: file, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const pending = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop();
    for (const line of lines.filter((candidate) => candidate.trim())) pending.shift()?.resolve(JSON.parse(line));
  });
  child.on('exit', (code) => {
    const error = new Error(`MCP exited before replying (code ${code}): ${stderr}`);
    for (const waiter of pending.splice(0)) waiter.reject(error);
  });
  return {
    child,
    call(request) {
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); }
        };
        const timer = setTimeout(() => {
          const index = pending.indexOf(waiter);
          if (index >= 0) pending.splice(index, 1);
          reject(new Error(`Timed out waiting for MCP response to ${request.method}`));
        }, 10_000);
        pending.push(waiter);
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

async function verifierFixture(directory) {
  const keys = generateKeyPairSync('ed25519');
  const evidenceRoot = join(directory, 'evidence');
  await mkdir(evidenceRoot);
  const verifierConfig = join(directory, 'verifier.json');
  await writeFile(verifierConfig, JSON.stringify({
    allowedEvidenceRoot: evidenceRoot,
    trustedVerifiers: {
      approver: keys.publicKey.export({ type: 'spki', format: 'pem' })
    }
  }), 'utf8');
  const verifier = createLocalEvidenceVerifier({
    allowedEvidenceRoot: evidenceRoot,
    trustedVerifiers: { approver: keys.publicKey }
  });
  return { keys, evidenceRoot, verifier, verifierConfig };
}

async function tamperedSignedSnapshot(directory, fixture) {
  const graph = createShadowGraph({
    verifier: fixture.verifier,
    now: () => '2026-08-27T12:00:00.000Z'
  });
  const fact = graph.addFact({
    id: 'signed-source-fact', project: 'source', key: 'release', value: 'signed-original',
    expiresAt: '2026-09-30T00:00:00.000Z'
  });
  const evidencePath = join(fixture.evidenceRoot, 'source-attestation.json');
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({
    fact,
    verifierIdentity: 'approver',
    evidenceReference: 'ticket:P1-restore',
    verifiedAt: '2026-08-27T12:05:00.000Z',
    privateKey: fixture.keys.privateKey
  })), 'utf8');
  await graph.verifyFact({ factId: fact.id, evidencePath });

  const tampered = graph.exportData();
  tampered.facts.find((item) => item.id === fact.id).value = 'tampered-after-signing';
  for (const entry of tampered.journal) {
    if (entry.entityId === fact.id && entry.payload?.verification) entry.payload.value = 'tampered-after-signing';
  }
  return tampered;
}

async function seedDestination(store) {
  const graph = createShadowGraph({ now: () => '2026-08-27T11:00:00.000Z' });
  graph.addDecision({ id: 'keep-original', project: 'live', title: 'KEEP ORIGINAL', chosen: 'original' });
  await store.save(graph.exportData());
  return store.load();
}

function liveRecordsFromSearch(response) {
  assert.equal(response.error, undefined, response.error?.message);
  return JSON.parse(response.result.content[0].text).items.map((item) => item.record);
}

async function assertMcpRestorePreflightIsAtomic(t, backend) {
  const directory = await scratchDirectory(t, `shadowgraph-independent-p1-restore-${backend}-`);
  const fixture = await verifierFixture(directory);
  const extension = backend === 'sqlite' ? 'db' : 'json';
  const destination = join(directory, `destination.${extension}`);
  const source = join(directory, `source.${extension}`);
  let destinationStore;
  let sourceStore;
  try {
    destinationStore = backend === 'sqlite' ? await createSqliteStore(destination) : createJsonFileStore(destination);
    sourceStore = backend === 'sqlite' ? await createSqliteStore(source) : createJsonFileStore(source);
  } catch (error) {
    if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }

  const originalSemantic = await seedDestination(destinationStore);
  await sourceStore.save(await tamperedSignedSnapshot(directory, fixture));
  destinationStore.close();
  sourceStore.close();
  destinationStore = undefined;
  sourceStore = undefined;

  const rpc = startMcp(destination, {
    SHADOWGRAPH_VERIFIER_CONFIG: fixture.verifierConfig,
    ...(backend === 'sqlite' ? { SHADOWGRAPH_STORAGE: 'sqlite' } : {})
  });
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const originalBytes = await readFile(destination);

  const rejected = await rpc.call({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'shadowgraph_restore', arguments: { source } }
  });
  assert.equal(rejected.result, undefined, 'legacy tool failures use the numeric JSON-RPC error form');
  assert.deepEqual(rejected.error, { code: -32000, message: 'Tool execution failed' });
  const publicFailure = JSON.stringify(rejected);
  for (const privateValue of [source, 'tampered-after-signing', 'persisted fact verification']) {
    assert.equal(publicFailure.includes(privateValue), false, `${backend}: MCP failure disclosed ${privateValue}`);
  }
  assert.deepEqual(await readFile(destination), originalBytes, 'destination bytes must not change on verifier preflight failure');

  const live = liveRecordsFromSearch(await rpc.call({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'shadowgraph_search', arguments: { project: 'live', query: 'KEEP ORIGINAL', limit: 10 } }
  }));
  assert.deepEqual(live, originalSemantic.records, 'live projection must remain the original state');

  await rpc.stop();
  const reopenedStore = backend === 'sqlite' ? await createSqliteStore(destination) : createJsonFileStore(destination);
  try {
    const reopened = await reopenedStore.load();
    assert.deepEqual(reopened, originalSemantic, 'fresh reopen must preserve the original semantic state');
    assert.deepEqual(live, reopened.records, 'live and freshly reopened durable projections must match');
  } finally {
    reopenedStore.close();
  }
}

test('P1-1 independent review: configured MCP JSON restore rejects tampered signatures before replacement', async (t) => {
  await assertMcpRestorePreflightIsAtomic(t, 'json');
});

test('P1-1 independent review: configured MCP SQLite restore rejects tampered signatures before replacement', async (t) => {
  await assertMcpRestorePreflightIsAtomic(t, 'sqlite');
});

test('P1-1 independent review: JSON restore rolls durable bytes back when post-replacement activation fails', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-independent-p1-json-rollback-');
  const destination = join(directory, 'destination.json');
  const source = join(directory, 'source.json');
  const original = createShadowGraph({ now: () => '2026-08-27T10:00:00.000Z' });
  original.addDecision({ id: 'rollback-original', title: 'ROLLBACK ORIGINAL', chosen: 'original' });
  const replacement = createShadowGraph({ now: () => '2026-08-27T11:00:00.000Z' });
  replacement.addDecision({ id: 'rollback-replacement', title: 'ROLLBACK REPLACEMENT', chosen: 'replacement' });
  await writeFile(destination, `${JSON.stringify(original.exportData(), null, 2)}\n`, 'utf8');
  await writeFile(source, `${JSON.stringify(replacement.exportData(), null, 2)}\n`, 'utf8');
  const before = await readFile(destination);

  await assert.rejects(
    restoreFile(source, destination, {
      afterReplace() { throw new Error('activation failed after replacement'); }
    }),
    /activation failed after replacement/
  );
  assert.deepEqual(await readFile(destination), before);
});

async function verifiedSnapshot(directory, fixture, options = {}) {
  const id = options.id ?? 'validity-fact';
  const graph = createShadowGraph({
    verifier: fixture.verifier,
    now: () => '2026-08-27T12:00:00.000Z'
  });
  const fact = graph.addFact({
    id,
    project: 'validity',
    key: options.key ?? id,
    value: options.value ?? 'signed-value',
    expiresAt: options.expiresAt ?? '2026-09-30T00:00:00.000Z',
    ...(options.validTo ? { validTo: options.validTo } : {})
  });
  const evidencePath = join(fixture.evidenceRoot, `${id}.json`);
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({
    fact,
    verifierIdentity: 'approver',
    evidenceReference: `ticket:${id}`,
    verifiedAt: '2026-08-27T12:05:00.000Z',
    privateKey: fixture.keys.privateKey
  })), 'utf8');
  await graph.verifyFact({ factId: fact.id, evidencePath });
  if (options.expire) graph.maintain({ now: '2026-10-01T00:00:00.000Z' });
  if (options.supersede) {
    graph.addFact({
      id: `${id}-replacement`, project: 'validity', key: fact.key, value: 'replacement',
      validFrom: '2026-09-01T00:00:00.000Z', observedAt: '2026-09-01T00:00:00.000Z',
      recordedAt: '2026-09-01T00:00:00.000Z'
    });
  }
  return graph.exportData();
}

function mutateLiveAndFinalJournal(payload, factId, mutate) {
  mutate(payload.facts.find((fact) => fact.id === factId));
  const finalEntry = [...payload.journal].reverse().find((entry) => entry.entityId === factId && entry.payload);
  assert.ok(finalEntry, `fixture requires a final journal payload for ${factId}`);
  mutate(finalEntry.payload);
  return payload;
}

function extendDeclaredExpiration(payload, factId) {
  return mutateLiveAndFinalJournal(payload, factId, (fact) => {
    fact.expiresAt = '2099-12-31T00:00:00.000Z';
  });
}

function extendEffectiveBoundary(payload, factId) {
  return mutateLiveAndFinalJournal(payload, factId, (fact) => {
    fact.temporal.validTo = '2026-09-20T00:00:00.000Z';
  });
}

function resurrectExpired(payload, factId) {
  return mutateLiveAndFinalJournal(payload, factId, (fact) => {
    fact.status = 'active';
    fact.verificationStatus = 'verified';
  });
}

function assertConfiguredImportRejects(payload, verifier, pattern) {
  const target = createShadowGraph({ verifier, now: () => '2026-08-27T12:00:00.000Z' });
  const before = target.exportData();
  assert.throws(() => target.importData(payload), pattern);
  assert.deepEqual(target.exportData(), before, 'configured import rejection must be atomic');
}

test('P1-2 independent review: signed claims reject declared and effective validity extensions on configured import', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-independent-p1-validity-import-');
  const fixture = await verifierFixture(directory);
  const declared = extendDeclaredExpiration(
    await verifiedSnapshot(directory, fixture, { id: 'declared-expiry' }),
    'declared-expiry'
  );
  assertConfiguredImportRejects(declared, fixture.verifier, /verification.*invalid|validity/i);

  const effective = extendEffectiveBoundary(
    await verifiedSnapshot(directory, fixture, {
      id: 'effective-boundary',
      validTo: '2026-09-01T00:00:00.000Z'
    }),
    'effective-boundary'
  );
  assertConfiguredImportRejects(effective, fixture.verifier, /verification.*invalid|validity/i);
});

test('P1-2 independent review: configured import rejects resurrection of an expired signed live fact and journal payload', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-independent-p1-expired-import-');
  const fixture = await verifierFixture(directory);
  const resurrected = resurrectExpired(
    await verifiedSnapshot(directory, fixture, { id: 'expired-resurrection', expire: true }),
    'expired-resurrection'
  );
  assertConfiguredImportRejects(resurrected, fixture.verifier, /fact\.expired|expired|invalidated|lifecycle/i);
});

async function assertConfiguredRestoreRejects(t, backend, attack) {
  const directory = await scratchDirectory(t, `shadowgraph-independent-p1-validity-${backend}-${attack}-`);
  const fixture = await verifierFixture(directory);
  const factId = `${backend}-${attack}`;
  const signed = await verifiedSnapshot(directory, fixture, {
    id: factId,
    ...(attack === 'resurrection' ? { expire: true } : {})
  });
  const tampered = attack === 'resurrection'
    ? resurrectExpired(signed, factId)
    : extendDeclaredExpiration(signed, factId);
  const extension = backend === 'sqlite' ? 'db' : 'json';
  const destination = join(directory, `destination.${extension}`);
  const source = join(directory, `source.${extension}`);
  let destinationStore;
  let sourceStore;
  try {
    destinationStore = backend === 'sqlite' ? await createSqliteStore(destination) : createJsonFileStore(destination);
    sourceStore = backend === 'sqlite' ? await createSqliteStore(source) : createJsonFileStore(source);
  } catch (error) {
    if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  t.after(() => { try { destinationStore?.close(); } catch {} try { sourceStore?.close(); } catch {} });
  const original = await seedDestination(destinationStore);
  await sourceStore.save(tampered);
  sourceStore.close();
  sourceStore = undefined;
  const beforeBytes = await readFile(destination);
  const validate = createRestoreValidator({ verifier: fixture.verifier });

  await assert.rejects(
    backend === 'sqlite'
      ? destinationStore.restore(source, { validate })
      : restoreFile(source, destination, { validate }),
    /verification.*invalid|fact\.expired|expired|validity|lifecycle/i
  );
  assert.deepEqual(await readFile(destination), beforeBytes, `${backend} restore must reject before replacement`);
  assert.deepEqual(await destinationStore.load(), original, `${backend} live durable handle must preserve the original state`);
  destinationStore.close();
  destinationStore = undefined;

  const reopened = backend === 'sqlite' ? await createSqliteStore(destination) : createJsonFileStore(destination);
  try { assert.deepEqual(await reopened.load(), original, `${backend} fresh reopen must preserve the original state`); }
  finally { reopened.close(); }
}

test('P1-2 independent review: configured JSON restore rejects validity extension and expired resurrection atomically', async (t) => {
  await assertConfiguredRestoreRejects(t, 'json', 'extension');
  await assertConfiguredRestoreRejects(t, 'json', 'resurrection');
});

test('P1-2 independent review: configured SQLite restore rejects validity extension and expired resurrection atomically', async (t) => {
  await assertConfiguredRestoreRejects(t, 'sqlite', 'extension');
  await assertConfiguredRestoreRejects(t, 'sqlite', 'resurrection');
});

test('P1-2 independent review: fact verification, expiration, and supersession journal postconditions reject contradictions', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-independent-p1-journal-postconditions-');
  const fixture = await verifierFixture(directory);

  const verified = await verifiedSnapshot(directory, fixture, { id: 'journal-verified' });
  verified.journal.find((entry) => entry.type === 'fact.verified').payload.verificationStatus = 'unverified';
  assertConfiguredImportRejects(verified, fixture.verifier, /fact\.verified|postcondition|verificationStatus/i);

  const expired = await verifiedSnapshot(directory, fixture, { id: 'journal-expired', expire: true });
  const expiredPayload = expired.journal.find((entry) => entry.type === 'fact.expired').payload;
  expiredPayload.status = 'active';
  expiredPayload.verificationStatus = 'verified';
  assertConfiguredImportRejects(expired, fixture.verifier, /fact\.expired|postcondition|status/i);

  const supersededGraph = createShadowGraph({ now: () => '2026-08-27T12:00:00.000Z' });
  supersededGraph.addFact({ id: 'journal-superseded', project: 'validity', key: 'superseded', value: 1 });
  supersededGraph.addFact({
    id: 'journal-superseding', project: 'validity', key: 'superseded', value: 2,
    validFrom: '2026-09-01T00:00:00.000Z', observedAt: '2026-09-01T00:00:00.000Z',
    recordedAt: '2026-09-01T00:00:00.000Z'
  });
  const superseded = supersededGraph.exportData();
  superseded.journal.find((entry) => entry.type === 'fact.superseded').payload.status = 'active';
  assertConfiguredImportRejects(superseded, fixture.verifier, /fact\.superseded|postcondition|status/i);
});

test('P1-2 independent review: legitimate system expiration and supersession narrowing preserve signed attestations', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-independent-p1-legitimate-narrowing-');
  const fixture = await verifierFixture(directory);
  for (const payload of [
    await verifiedSnapshot(directory, fixture, { id: 'legitimate-expired', expire: true }),
    await verifiedSnapshot(directory, fixture, { id: 'legitimate-superseded', supersede: true })
  ]) {
    const imported = createShadowGraph({ verifier: fixture.verifier });
    assert.doesNotThrow(() => imported.importData(payload));
    const signed = imported.exportData().facts.find((fact) => fact.verification);
    assert.ok(['expired', 'superseded'].includes(signed.status));
  }
});

function rebuiltPayload(report) {
  return {
    schemaVersion: report.projection.schemaVersion,
    records: report.projection.records,
    facts: report.projection.facts,
    relations: report.projection.relations,
    idempotency: report.projection.idempotency
  };
}

test('P1-3 independent review: verifier-less core reopen, rebuild, and rebuild-import stay effectively unverified', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-independent-p1-core-rebuild-policy-');
  const fixture = await verifierFixture(directory);
  const payload = await verifiedSnapshot(directory, fixture, { id: 'core-rebuild-policy' });
  const rawJournal = structuredClone(payload.journal);

  const reopened = createShadowGraph();
  reopened.importData(payload);
  assert.equal(reopened.exportData().facts[0].verificationStatus, 'unverified');
  assert.equal(reopened.exportData().facts[0].verificationUntrustedReason, 'verifier_not_configured');

  const report = reopened.rebuild();
  assert.equal(report.rebuildable, true);
  assert.equal(report.projection.facts[0].verificationStatus, 'unverified');
  assert.equal(report.projection.facts[0].verificationUntrustedReason, 'verifier_not_configured');

  const imported = createShadowGraph();
  imported.importData(rebuiltPayload(report));
  assert.equal(imported.exportData().facts[0].verificationStatus, 'unverified');
  assert.deepEqual(reopened.exportData().journal, rawJournal, 'exposed rebuild normalization must not rewrite the raw audit journal');
});

test('P1-3 independent review: verifier-less MCP rebuild cannot re-elevate a genuinely signed durable fact', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-independent-p1-mcp-rebuild-policy-');
  const fixture = await verifierFixture(directory);
  const file = join(directory, 'signed.json');
  const payload = await verifiedSnapshot(directory, fixture, { id: 'mcp-rebuild-policy' });
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const before = await readFile(file);
  const rpc = startMcp(file);
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  const response = await rpc.call({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'shadowgraph_rebuild', arguments: {} }
  });
  assert.equal(response.error, undefined, response.error?.message);
  const report = JSON.parse(response.result.content[0].text);
  assert.equal(report.rebuildable, true);
  assert.equal(report.projection.facts[0].verificationStatus, 'unverified');
  assert.equal(report.projection.facts[0].verificationUntrustedReason, 'verifier_not_configured');
  assert.deepEqual(await readFile(file), before, 'MCP rebuild must not rewrite durable audit data');
});

test('P1-3 independent review: exposed rebuild migrates pre-schema-5 lifecycle values without rewriting journal audit bytes', () => {
  const source = createShadowGraph({ now: () => '2026-08-27T12:00:00.000Z' });
  source.addDecision({ id: 'legacy-lifecycle', title: 'Legacy lifecycle', chosen: 'A' });
  const payload = source.exportData();
  payload.schemaVersion = 4;
  payload.records[0].schemaVersion = 4;
  payload.records[0].status = 'active';
  for (const entry of payload.journal) {
    entry.schemaVersion = 4;
    if (entry.payload?.id === 'legacy-lifecycle') {
      entry.payload.schemaVersion = 4;
      entry.payload.status = 'active';
    }
  }

  const graph = createShadowGraph();
  graph.importData(payload);
  assert.equal(graph.exportData().records[0].status, 'proposed');
  assert.equal(graph.exportData().journal[0].payload.status, 'active');
  const report = graph.rebuild();
  assert.equal(report.rebuildable, true);
  assert.equal(report.projection.schemaVersion, 5);
  assert.equal(report.projection.records[0].status, 'proposed');
  assert.equal(report.projection.records[0].schemaVersion, 5);
  assert.equal(graph.exportData().journal[0].payload.status, 'active');
});

test('P1-3 independent review: invalid verified journal payload makes core and configured MCP rebuild incomplete without trust elevation', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-independent-p1-invalid-rebuild-');
  const fixture = await verifierFixture(directory);
  const payload = await verifiedSnapshot(directory, fixture, { id: 'invalid-rebuild-payload' });
  const invalidEntry = payload.journal.find((entry) => entry.type === 'fact.verified');
  invalidEntry.payload.value = 'tampered-journal-only';
  const rawJournal = structuredClone(payload.journal);

  const graph = createShadowGraph({ verifier: fixture.verifier });
  graph.importData(payload);
  assert.equal(graph.exportData().facts[0].verificationStatus, 'verified', 'live fact remains genuinely verified');
  const coreReport = graph.rebuild();
  assert.equal(coreReport.rebuildable, false);
  assert.match(coreReport.reason, /verification|invalid.*projection/i);
  assert.notEqual(coreReport.projection.facts[0]?.verificationStatus, 'verified');
  assert.ok(coreReport.skipped.some((entry) => /verification|invalid.*projection/i.test(`${entry.why} ${entry.detail ?? ''}`)));
  assert.deepEqual(graph.exportData().journal, rawJournal, 'core rebuild must retain raw audit evidence unchanged');

  const file = join(directory, 'invalid-journal.json');
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const rpc = startMcp(file, { SHADOWGRAPH_VERIFIER_CONFIG: fixture.verifierConfig });
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
  const response = await rpc.call({
    jsonrpc: '2.0', id: 11, method: 'tools/call',
    params: { name: 'shadowgraph_rebuild', arguments: {} }
  });
  assert.equal(response.error, undefined, response.error?.message);
  const mcpReport = JSON.parse(response.result.content[0].text);
  assert.equal(mcpReport.rebuildable, false);
  assert.notEqual(mcpReport.projection.facts[0]?.verificationStatus, 'verified');
});
