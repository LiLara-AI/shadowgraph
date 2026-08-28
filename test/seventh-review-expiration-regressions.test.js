import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createFactAttestation, createLocalEvidenceVerifier } from '../src/verification.js';
import { journalEntryPostconditionIssue } from '../src/journal.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createShadowGraphServer } from '../src/server.js';

const exec = promisify(execFile);

async function signedFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-seventh-review-expiration-'));
  const evidenceRoot = join(directory, 'evidence');
  await mkdir(evidenceRoot);
  const keys = generateKeyPairSync('ed25519');
  const verifier = createLocalEvidenceVerifier({
    allowedEvidenceRoot: evidenceRoot,
    trustedVerifiers: { approver: keys.publicKey }
  });
  const clock = { value: options.now ?? '2026-08-27T12:00:00.000Z' };
  const graph = createShadowGraph({ verifier, now: () => clock.value });
  const fact = graph.addFact({
    id: options.id ?? 'ds-p1-005-valid-to-first',
    project: options.project ?? 'ds-p1-005',
    key: options.key ?? 'boundary-valid-to',
    value: options.value ?? true,
    sourceClass: 'production_verified',
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    ...(options.validTo === undefined ? {} : { validTo: options.validTo })
  });
  const evidencePath = join(evidenceRoot, `${fact.id}.json`);
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({
    fact,
    verifierIdentity: 'approver',
    evidenceReference: `ticket:${fact.id}`,
    verifiedAt: '2026-08-27T12:05:00.000Z',
    privateKey: keys.privateKey
  })), 'utf8');
  await graph.verifyFact({ factId: fact.id, evidencePath });
  return { directory, evidenceRoot, keys, verifier, graph, fact, clock };
}

function factById(graph, id) {
  return graph.exportData().facts.find((fact) => fact.id === id);
}

function expirationEntries(graph, id) {
  return graph.exportData().journal.filter((entry) => entry.type === 'fact.expired' && entry.entityId === id);
}

function startMcp(file) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: file },
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
    for (const line of lines.filter((candidate) => candidate.trim())) {
      const response = JSON.parse(line);
      const waiter = pending.get(JSON.stringify(response.id));
      if (waiter) {
        pending.delete(JSON.stringify(response.id));
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
    call(request) {
      return new Promise((resolve, reject) => {
        const key = JSON.stringify(request.id);
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`Timed out waiting for MCP response: ${stderr}`));
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

async function seedUnsignedValidTo(file, id, boundary) {
  const graph = createShadowGraph({ now: () => '2026-08-27T12:00:00.000Z' });
  graph.addFact({ id, project: 'ds-p1-005', key: id, value: true, validTo: boundary });
  const store = createJsonFileStore(file);
  await store.save(graph.exportData());
  store.close();
}

async function loadJson(file) {
  const store = createJsonFileStore(file);
  try { return await store.load(); }
  finally { store.close(); }
}

test('DS-P1-005 seventh review: signed validTo is the exact effective boundary and repeat maintain is idempotent', async () => {
  const boundary = '2026-08-28T00:00:00.000Z';
  const { graph, fact, clock } = await signedFixture({
    validTo: boundary,
    expiresAt: '2026-09-30T00:00:00.000Z'
  });
  const verified = factById(graph, fact.id);
  const attestation = structuredClone(verified.verification);
  const validityPolicy = structuredClone(verified.validityPolicy);

  clock.value = '2026-08-27T23:59:59.999Z';
  graph.maintain({ now: clock.value });
  assert.equal(factById(graph, fact.id).status, 'active');
  assert.equal(factById(graph, fact.id).verificationStatus, 'verified');
  assert.equal(expirationEntries(graph, fact.id).length, 0);
  assert.equal(graph.recall('boundary valid to', { project: 'ds-p1-005' }).items.some((item) => item.record.id === fact.id), true);

  clock.value = boundary;
  graph.maintain({ now: boundary });
  const expired = factById(graph, fact.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.verificationStatus, 'expired');
  assert.equal(expired.temporal.validTo, boundary, 'expiration must not extend the earlier validTo');
  assert.equal(expired.temporal.invalidatedAt, boundary);
  assert.deepEqual(expired.verification, attestation, 'expiration preserves signed audit evidence');
  assert.deepEqual(expired.validityPolicy, validityPolicy, 'maintain cannot rewrite signed validity policy');
  assert.equal(expirationEntries(graph, fact.id).length, 1);
  assert.deepEqual(expirationEntries(graph, fact.id)[0].payload, expired);
  assert.equal(graph.recall('boundary valid to', { project: 'ds-p1-005' }).items.some((item) => item.record.id === fact.id), false);
  assert.equal(graph.context({ project: 'ds-p1-005' }).staleAssumptions.some((item) => item.id === fact.id), true);

  clock.value = '2026-08-29T00:00:00.000Z';
  graph.maintain({ now: clock.value });
  assert.deepEqual(factById(graph, fact.id), expired);
  assert.equal(expirationEntries(graph, fact.id).length, 1, 'terminal expiration must not be journalled twice');
});

test('DS-P1-005 seventh review: validTo-only, expiresAt-first, timezone offsets, and unsigned facts share one boundary rule', async () => {
  const validToOnly = await signedFixture({
    id: 'signed-valid-to-only',
    validTo: '2026-08-28T03:00:00+03:00'
  });
  validToOnly.clock.value = '2026-08-28T00:00:00.000Z';
  validToOnly.graph.maintain({ now: validToOnly.clock.value });
  const expiredValidToOnly = factById(validToOnly.graph, validToOnly.fact.id);
  assert.equal(expiredValidToOnly.expiresAt, null);
  assert.equal(expiredValidToOnly.status, 'expired');
  assert.equal(expiredValidToOnly.temporal.validTo, '2026-08-28T03:00:00+03:00');
  assert.equal(journalEntryPostconditionIssue(expirationEntries(validToOnly.graph, validToOnly.fact.id)[0]), null);

  const expiresFirst = await signedFixture({
    id: 'signed-expires-first',
    expiresAt: '2026-08-27T20:00:00-04:00',
    validTo: '2026-09-30T00:00:00.000Z'
  });
  expiresFirst.clock.value = '2026-08-27T23:59:59.999Z';
  expiresFirst.graph.maintain({ now: expiresFirst.clock.value });
  assert.equal(factById(expiresFirst.graph, expiresFirst.fact.id).status, 'active');
  expiresFirst.clock.value = '2026-08-28T00:00:00.000Z';
  expiresFirst.graph.maintain({ now: expiresFirst.clock.value });
  const expiredByExpiresAt = factById(expiresFirst.graph, expiresFirst.fact.id);
  assert.equal(expiredByExpiresAt.status, 'expired');
  assert.equal(expiredByExpiresAt.temporal.validTo, '2026-08-27T20:00:00-04:00');

  const unsigned = createShadowGraph({ now: () => '2026-08-27T12:00:00.000Z' });
  const unsignedFact = unsigned.addFact({
    id: 'unsigned-valid-to-only', project: 'ds-p1-005', key: 'unsigned-window', value: true,
    validTo: '2026-08-28T00:00:00.000Z'
  });
  unsigned.maintain({ now: '2026-08-28T00:00:00.000Z' });
  assert.equal(factById(unsigned, unsignedFact.id).status, 'expired');
  assert.equal(factById(unsigned, unsignedFact.id).verificationStatus, 'expired');
  assert.equal(journalEntryPostconditionIssue(expirationEntries(unsigned, unsignedFact.id)[0]), null);
});

test('DS-P1-005 seventh review: fact migration backfills canonical validity and invalid maintain remains atomic', () => {
  const boundary = '2026-08-28T00:00:00.000Z';
  const graph = createShadowGraph({ now: () => '2026-08-27T12:00:00.000Z' });
  graph.importData({
    schemaVersion: 4,
    facts: [{
      id: 'legacy-valid-to-only', kind: 'fact', schemaVersion: 4, project: 'ds-p1-005',
      key: 'legacy-window', value: true, status: 'active', verificationStatus: 'unverified',
      observedAt: '2026-08-27T12:00:00.000Z', validTo: boundary
    }]
  });
  assert.deepEqual(factById(graph, 'legacy-valid-to-only').validityPolicy, {
    declaredExpiresAt: null,
    declaredValidTo: boundary,
    effectiveExpirationBoundary: boundary
  });

  const before = graph.exportData();
  assert.throws(() => graph.maintain({ now: boundary, changedFacts: {} }), /changedFacts/);
  assert.deepEqual(graph.exportData(), before, 'invalid maintain must not expire, journal, or otherwise mutate');

  graph.maintain({ now: boundary });
  const expired = factById(graph, 'legacy-valid-to-only');
  assert.equal(expired.status, 'expired');
  assert.equal(expired.temporal.validTo, boundary);
  assert.equal(expirationEntries(graph, expired.id).length, 1);
});

test('DS-P1-005 seventh review: an earlier current narrowing expires, while a superseded fact stays terminal', async () => {
  const narrowedSource = await signedFixture({
    id: 'signed-narrowed-active',
    validTo: '2026-09-15T00:00:00.000Z',
    expiresAt: '2026-09-30T00:00:00.000Z'
  });
  const narrowedPayload = narrowedSource.graph.exportData();
  const narrowedAt = '2026-08-29T00:00:00.000Z';
  narrowedPayload.facts.find((fact) => fact.id === narrowedSource.fact.id).temporal.validTo = narrowedAt;
  narrowedPayload.journal.findLast((entry) => entry.entityId === narrowedSource.fact.id && entry.payload).payload.temporal.validTo = narrowedAt;

  const narrowed = createShadowGraph({
    verifier: narrowedSource.verifier,
    now: () => '2026-08-28T00:00:00.000Z'
  });
  narrowed.importData(narrowedPayload);
  narrowed.maintain({ now: narrowedAt });
  assert.equal(factById(narrowed, narrowedSource.fact.id).status, 'expired');
  assert.equal(factById(narrowed, narrowedSource.fact.id).temporal.validTo, narrowedAt);

  const superseded = await signedFixture({
    id: 'signed-superseded-before-expiry',
    key: 'superseded-boundary',
    expiresAt: '2026-09-30T00:00:00.000Z'
  });
  superseded.graph.addFact({
    id: 'replacement-after-narrowing', project: 'ds-p1-005', key: 'superseded-boundary', value: false,
    validFrom: '2026-08-28T00:00:00.000Z', observedAt: '2026-08-28T00:00:00.000Z',
    recordedAt: '2026-08-28T00:00:00.000Z'
  });
  const terminal = factById(superseded.graph, superseded.fact.id);
  assert.equal(terminal.status, 'superseded');
  assert.equal(terminal.temporal.validTo, '2026-08-28T00:00:00.000Z');
  superseded.graph.maintain({ now: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual(factById(superseded.graph, superseded.fact.id), terminal);
  assert.equal(expirationEntries(superseded.graph, superseded.fact.id).length, 0);
});

test('DS-P1-005 seventh review: expired attestation survives import, rebuild, verifier policy, and JSON/SQLite restart', async (t) => {
  const fixture = await signedFixture({
    id: 'signed-persistence-valid-to-only',
    validTo: '2026-08-28T00:00:00.000Z'
  });
  fixture.graph.maintain({ now: '2026-08-28T00:00:00.000Z' });
  const source = fixture.graph.exportData();
  const terminal = structuredClone(source.facts.find((fact) => fact.id === fixture.fact.id));

  const configured = createShadowGraph({ verifier: fixture.verifier });
  configured.importData(source);
  assert.deepEqual(factById(configured, fixture.fact.id), terminal);

  const unconfigured = createShadowGraph();
  unconfigured.importData(source);
  const untrusted = factById(unconfigured, fixture.fact.id);
  assert.equal(untrusted.status, 'expired');
  assert.equal(untrusted.verificationStatus, 'expired');
  assert.deepEqual(untrusted.verification, terminal.verification);
  assert.equal(untrusted.verificationUntrustedReason, 'verifier_not_configured');

  const report = fixture.graph.rebuild();
  assert.equal(report.rebuildable, true);
  assert.equal(report.projection.facts.find((fact) => fact.id === fixture.fact.id).status, 'expired');
  const rebuilt = createShadowGraph({ verifier: fixture.verifier });
  rebuilt.importData(report.projection);
  assert.deepEqual(factById(rebuilt, fixture.fact.id), terminal);

  const jsonFile = join(fixture.directory, 'restart.json');
  const jsonStore = createJsonFileStore(jsonFile);
  await jsonStore.save(source);
  jsonStore.close();
  const jsonReopened = createShadowGraph({ verifier: fixture.verifier });
  jsonReopened.importData(await loadJson(jsonFile));
  assert.deepEqual(factById(jsonReopened, fixture.fact.id), terminal);

  const sqliteFile = join(fixture.directory, 'restart.db');
  let sqlite;
  try { sqlite = await createSqliteStore(sqliteFile); }
  catch (error) {
    if (/requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  await sqlite.save(source);
  sqlite.close();
  const reopenedStore = await createSqliteStore(sqliteFile);
  const sqliteReopened = createShadowGraph({ verifier: fixture.verifier });
  try { sqliteReopened.importData(await reopenedStore.load()); }
  finally { reopenedStore.close(); }
  assert.deepEqual(factById(sqliteReopened, fixture.fact.id), terminal);
});

test('DS-P1-005 seventh review: JS, CLI, HTTP, and MCP maintain expire validTo-only facts durably', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-seventh-review-interfaces-'));
  const boundary = '2030-01-01T00:00:00.000Z';

  const js = createShadowGraph({ now: () => '2029-01-01T00:00:00.000Z' });
  const jsFact = js.addFact({ id: 'js-valid-to-only', project: 'ds-p1-005', key: 'js-valid-to-only', value: true, validTo: boundary });
  js.maintain({ now: boundary });
  assert.equal(factById(js, jsFact.id).status, 'expired');

  const cliFile = join(directory, 'cli.json');
  await seedUnsignedValidTo(cliFile, 'cli-valid-to-only', boundary);
  const cli = await exec(process.execPath, ['src/cli.js', 'maintain', JSON.stringify({ now: boundary })], {
    cwd: process.cwd(), env: { ...process.env, SHADOWGRAPH_FILE: cliFile }
  });
  assert.equal(cli.stderr, '');
  assert.equal((await loadJson(cliFile)).facts.find((fact) => fact.id === 'cli-valid-to-only').status, 'expired');

  const httpFile = join(directory, 'http.json');
  await seedUnsignedValidTo(httpFile, 'http-valid-to-only', boundary);
  const app = await createShadowGraphServer({ file: httpFile });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/maintain`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: boundary })
  });
  assert.equal(response.status, 200);
  assert.equal((await loadJson(httpFile)).facts.find((fact) => fact.id === 'http-valid-to-only').status, 'expired');

  const mcpFile = join(directory, 'mcp.json');
  await seedUnsignedValidTo(mcpFile, 'mcp-valid-to-only', boundary);
  const rpc = startMcp(mcpFile);
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const maintained = await rpc.call({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'shadowgraph_maintain', arguments: { now: boundary } }
  });
  assert.equal(maintained.error, undefined, maintained.error?.message);
  assert.notEqual(maintained.result?.isError, true);
  await rpc.stop();
  assert.equal((await loadJson(mcpFile)).facts.find((fact) => fact.id === 'mcp-valid-to-only').status, 'expired');
});

test('DS-P1-005 seventh review: persisted lifecycle contradictions and validity extensions fail atomically', async () => {
  const fixture = await signedFixture({
    id: 'signed-contradiction',
    validTo: '2026-08-28T00:00:00.000Z',
    expiresAt: '2026-09-30T00:00:00.000Z'
  });
  fixture.graph.maintain({ now: '2026-08-28T00:00:00.000Z' });
  const legitimate = fixture.graph.exportData();
  const accepted = createShadowGraph({ verifier: fixture.verifier });
  assert.doesNotThrow(() => accepted.importData(legitimate));

  const assertRejected = (payload, pattern) => {
    const target = createShadowGraph({ verifier: fixture.verifier, now: () => '2026-08-27T12:00:00.000Z' });
    const before = target.exportData();
    assert.throws(() => target.importData(payload), pattern);
    assert.deepEqual(target.exportData(), before);
  };
  const mutateFinal = (payload, mutate) => {
    mutate(payload.facts.find((fact) => fact.id === fixture.fact.id));
    mutate(payload.journal.findLast((entry) => entry.entityId === fixture.fact.id && entry.payload).payload);
    return payload;
  };

  const extendedTerminal = mutateFinal(structuredClone(legitimate), (fact) => {
    fact.temporal.validTo = '2026-08-29T00:00:00.000Z';
  });
  assertRejected(extendedTerminal, /validity|effective expiration|verification.*invalid/i);

  const earlyInvalidation = mutateFinal(structuredClone(legitimate), (fact) => {
    fact.temporal.invalidatedAt = '2026-08-27T23:59:59.999Z';
  });
  assertRejected(earlyInvalidation, /invalidatedAt|effective expiration|postcondition/i);

  const laterDeclaredExpiry = structuredClone(legitimate);
  for (const fact of [
    laterDeclaredExpiry.facts.find((item) => item.id === fixture.fact.id),
    ...laterDeclaredExpiry.journal.filter((entry) => entry.entityId === fixture.fact.id && entry.payload).map((entry) => entry.payload)
  ]) fact.expiresAt = '2099-12-31T00:00:00.000Z';
  assertRejected(laterDeclaredExpiry, /validity|verification.*invalid|expiresAt/i);
  const noVerifier = createShadowGraph({ now: () => '2026-08-27T12:00:00.000Z' });
  const noVerifierBefore = noVerifier.exportData();
  assert.throws(() => noVerifier.importData(laterDeclaredExpiry), /validity|expiresAt/i);
  assert.deepEqual(noVerifier.exportData(), noVerifierBefore, 'policy contradictions fail closed without a configured verifier too');
});
