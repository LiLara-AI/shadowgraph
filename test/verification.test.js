import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import {
  createFactAttestation,
  createLocalEvidenceVerifier
} from '../src/verification.js';

function startMcp(file, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(), env: { ...process.env, SHADOWGRAPH_FILE: file, ...extraEnv },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  let buffer = '';
  const pending = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) pending.shift()?.(JSON.parse(line));
  });
  return {
    child,
    call(request) {
      const response = new Promise((resolve) => pending.push(resolve));
      child.stdin.write(`${JSON.stringify(request)}\n`);
      return response;
    }
  };
}

function fixture() {
  const directoryPromise = mkdtemp(join(tmpdir(), 'shadowgraph-verification-'));
  const trusted = generateKeyPairSync('ed25519');
  const wrong = generateKeyPairSync('ed25519');
  return { directoryPromise, trusted, wrong };
}

async function setup(options = {}) {
  const { directoryPromise, trusted, wrong } = fixture();
  const directory = await directoryPromise;
  const verifier = createLocalEvidenceVerifier({
    allowedEvidenceRoot: directory,
    trustedVerifiers: { 'release-approver': trusted.publicKey }
  });
  const graph = createShadowGraph({ verifier, now: () => '2026-08-27T12:00:00.000Z' });
  const fact = graph.addFact({
    id: options.factId ?? 'fact-release', project: 'app', key: options.key ?? 'release-ready',
    value: options.value ?? true, sourceClass: 'production_verified', actor: 'writer-agent',
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {})
  });
  const document = createFactAttestation({
    fact,
    verifierIdentity: 'release-approver',
    evidenceReference: options.evidenceReference ?? 'ticket:SG-42',
    verificationMethod: 'ed25519-local-evidence-v1',
    verifiedAt: '2026-08-27T12:05:00.000Z',
    privateKey: options.privateKey ?? trusted.privateKey
  });
  const evidencePath = join(directory, options.filename ?? 'attestation.json');
  await writeFile(evidencePath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return { directory, trusted, wrong, verifier, graph, fact, document, evidencePath };
}

test('U-1: only separately configured signed local evidence can verify a fact', async () => {
  const { graph, fact, evidencePath } = await setup();
  const verified = await graph.verifyFact({ factId: fact.id, evidencePath });

  assert.equal(verified.operation, 'VERIFIED');
  assert.equal(verified.fact.verificationStatus, 'verified');
  assert.deepEqual(verified.fact.verification, {
    factId: fact.id,
    verifierIdentity: 'release-approver',
    evidenceReference: 'ticket:SG-42',
    verificationMethod: 'ed25519-local-evidence-v1',
    verifiedAt: '2026-08-27T12:05:00.000Z',
    factDigest: verified.fact.verification.factDigest,
    signature: verified.fact.verification.signature
  });
  assert.match(verified.fact.verification.factDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(graph.getJournal({ limit: 20 }).items.at(-1).type, 'fact.verified');
});

test('U-1: writer-controlled fields, strong source claims, and unknown verification arguments cannot grant trust', async () => {
  const { graph, fact, evidencePath } = await setup();
  assert.equal(fact.sourceClass, 'production_verified');
  assert.equal(fact.verificationStatus, 'unverified');
  assert.throws(() => graph.addFact({ key: 'forged', value: true, verificationStatus: 'verified' }), /cannot set.*verified/);
  await assert.rejects(
    graph.verifyFact({ factId: fact.id, evidencePath, verified: true, signature: 'writer supplied' }),
    /only accepts factId and evidencePath/
  );
  assert.equal(graph.exportData().facts.find((item) => item.id === fact.id).verificationStatus, 'unverified');
});

test('U-1: tampered evidence, wrong signatures, missing references, and missing files are rejected atomically', async () => {
  const { graph, fact, document, evidencePath, directory, wrong } = await setup();
  const before = graph.exportData();

  await writeFile(evidencePath, JSON.stringify({ ...document, evidenceReference: 'ticket:TAMPERED' }), 'utf8');
  await assert.rejects(graph.verifyFact({ factId: fact.id, evidencePath }), /signature/i);
  assert.deepEqual(graph.exportData(), before);

  const wrongDocument = createFactAttestation({
    fact, verifierIdentity: 'release-approver', evidenceReference: 'ticket:SG-42',
    verificationMethod: 'ed25519-local-evidence-v1', verifiedAt: '2026-08-27T12:05:00.000Z',
    privateKey: wrong.privateKey
  });
  await writeFile(evidencePath, JSON.stringify(wrongDocument), 'utf8');
  await assert.rejects(graph.verifyFact({ factId: fact.id, evidencePath }), /signature/i);
  assert.deepEqual(graph.exportData(), before);

  const missingReference = { ...document };
  delete missingReference.evidenceReference;
  await writeFile(evidencePath, JSON.stringify(missingReference), 'utf8');
  await assert.rejects(graph.verifyFact({ factId: fact.id, evidencePath }), /evidenceReference/);
  assert.deepEqual(graph.exportData(), before);

  await assert.rejects(
    graph.verifyFact({ factId: fact.id, evidencePath: join(directory, 'missing.json') }),
    /evidence file.*not found/i
  );
  assert.deepEqual(graph.exportData(), before);
});

test('U-1: verification retries are idempotent and conflicting attestations are refused', async () => {
  const { graph, fact, evidencePath, trusted, directory } = await setup();
  const first = await graph.verifyFact({ factId: fact.id, evidencePath });
  const journalLength = graph.exportData().journal.length;
  const retry = await graph.verifyFact({ factId: fact.id, evidencePath });
  assert.equal(retry.operation, 'NOOP');
  assert.deepEqual(retry.fact.verification, first.fact.verification);
  assert.equal(graph.exportData().journal.length, journalLength);

  const conflicting = createFactAttestation({
    fact, verifierIdentity: 'release-approver', evidenceReference: 'ticket:OTHER',
    verificationMethod: 'ed25519-local-evidence-v1', verifiedAt: '2026-08-27T12:06:00.000Z',
    privateKey: trusted.privateKey
  });
  const conflictPath = join(directory, 'conflict.json');
  await writeFile(conflictPath, JSON.stringify(conflicting), 'utf8');
  await assert.rejects(graph.verifyFact({ factId: fact.id, evidencePath: conflictPath }), /already verified by a different attestation/);
  assert.equal(graph.exportData().journal.length, journalLength);
});

test('U-1: signed verification survives export/import, journal rebuild, and JSON restart', async () => {
  const { graph, fact, evidencePath, verifier, directory } = await setup();
  await graph.verifyFact({ factId: fact.id, evidencePath });
  const original = graph.exportData().facts.find((item) => item.id === fact.id);

  const imported = createShadowGraph({ verifier });
  imported.importData(graph.exportData());
  assert.deepEqual(imported.exportData().facts.find((item) => item.id === fact.id), original);

  const rebuilt = graph.rebuild();
  assert.equal(rebuilt.rebuildable, true);
  const fromJournal = createShadowGraph({ verifier });
  fromJournal.importData({ ...rebuilt.projection, schemaVersion: graph.exportData().schemaVersion });
  assert.deepEqual(fromJournal.exportData().facts.find((item) => item.id === fact.id), original);

  const store = createJsonFileStore(join(directory, 'data.json'));
  await store.save(graph.exportData());
  const restarted = createShadowGraph({ verifier });
  restarted.importData(await store.load());
  assert.deepEqual(restarted.exportData().facts.find((item) => item.id === fact.id), original);
});

test('U-1: signed verification has JSON and SQLite restart parity', async (t) => {
  const { graph, fact, evidencePath, verifier, directory } = await setup();
  await graph.verifyFact({ factId: fact.id, evidencePath });
  let sqlite;
  try { sqlite = await createSqliteStore(join(directory, 'data.db')); }
  catch (error) { if (/requires Node/.test(error.message)) return t.skip(error.message); throw error; }
  await sqlite.save(graph.exportData());
  sqlite.close();

  const reopened = await createSqliteStore(join(directory, 'data.db'));
  const restarted = createShadowGraph({ verifier });
  restarted.importData(await reopened.load());
  reopened.close();
  assert.deepEqual(
    restarted.exportData().facts.find((item) => item.id === fact.id),
    graph.exportData().facts.find((item) => item.id === fact.id)
  );
});

test('U-1: modified persisted attestations cannot survive import', async () => {
  const { graph, fact, evidencePath, verifier } = await setup();
  await graph.verifyFact({ factId: fact.id, evidencePath });
  const tampered = graph.exportData();
  tampered.facts[0].value = false;
  const restarted = createShadowGraph({ verifier });
  assert.throws(() => restarted.importData(tampered), /persisted fact verification.*invalid/i);
});

test('U-1: verifier trust keys and evidence documents are strictly Ed25519 and closed-shape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-verifier-strict-'));
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => createLocalEvidenceVerifier({
    allowedEvidenceRoot: directory,
    trustedVerifiers: { wrongAlgorithm: rsa.publicKey }
  }), /Ed25519 public key/);

  const { graph, fact, document, evidencePath } = await setup();
  const before = graph.exportData();
  await writeFile(evidencePath, JSON.stringify({ ...document, unsignedComment: 'not covered by the signature' }), 'utf8');
  await assert.rejects(graph.verifyFact({ factId: fact.id, evidencePath }), /unknown field unsignedComment/);
  assert.deepEqual(graph.exportData(), before);

  await writeFile(evidencePath, JSON.stringify({ ...document, verifiedAt: 'March 1, 2026' }), 'utf8');
  await assert.rejects(graph.verifyFact({ factId: fact.id, evidencePath }), /verifiedAt must be a valid timestamp/);
  assert.deepEqual(graph.exportData(), before);
});

test('U-1: restarting an expired signed fact never promotes it back to effectively verified', async () => {
  const { graph, fact, evidencePath, verifier } = await setup({ expiresAt: '2026-08-28T00:00:00.000Z' });
  await graph.verifyFact({ factId: fact.id, evidencePath });
  graph.maintain({ now: '2026-08-29T00:00:00.000Z' });
  const expired = graph.exportData().facts.find((item) => item.id === fact.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.verificationStatus, 'expired');

  const restarted = createShadowGraph({ verifier });
  restarted.importData(graph.exportData());
  const imported = restarted.exportData().facts.find((item) => item.id === fact.id);
  assert.equal(imported.status, 'expired');
  assert.equal(imported.verificationStatus, 'expired');
});

test('U-1: redaction hides verification evidence and purge prevents signed evidence from resurrecting a fact', async () => {
  const { graph, fact, evidencePath } = await setup({ key: 'api-token', value: 'super-secret', evidenceReference: 'secret-ticket:SG-42' });
  await graph.verifyFact({ factId: fact.id, evidencePath });
  const redacted = JSON.stringify(graph.redact({ project: 'app' }));
  assert.equal(redacted.includes('super-secret'), false);
  assert.equal(redacted.includes('secret-ticket:SG-42'), false);
  assert.equal(redacted.includes(graph.exportData().facts[0].verification.signature), false);

  graph.purgeProject('app');
  assert.equal(JSON.stringify(graph.exportData()).includes('secret-ticket:SG-42'), false);
  assert.equal(JSON.stringify(graph.rebuild().projection).includes('secret-ticket:SG-42'), false);
  await assert.rejects(graph.verifyFact({ factId: fact.id, evidencePath }), /Fact not found/);
});

test('U-1: MCP exposes verification only when a separate verifier is preconfigured, then checks real signed evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-verifier-mcp-'));
  const unconfigured = startMcp(join(directory, 'plain.json'));
  t.after(() => unconfigured.child.kill());
  const plainList = await unconfigured.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(plainList.result.tools.length, 27);
  assert.equal(plainList.result.tools.some((tool) => tool.name === 'shadowgraph_verify_fact'), false);

  const keys = generateKeyPairSync('ed25519');
  const evidenceRoot = join(directory, 'evidence');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(evidenceRoot));
  const configPath = join(directory, 'verifier.json');
  await writeFile(configPath, JSON.stringify({
    allowedEvidenceRoot: evidenceRoot,
    trustedVerifiers: {
      approver: keys.publicKey.export({ type: 'spki', format: 'pem' })
    }
  }), 'utf8');
  const configured = startMcp(join(directory, 'configured.json'), { SHADOWGRAPH_VERIFIER_CONFIG: configPath });
  t.after(() => configured.child.kill());
  const configuredList = await configured.call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(configuredList.result.tools.length, 28);
  assert.equal(configuredList.result.tools.some((tool) => tool.name === 'shadowgraph_verify_fact'), true);

  const configuredCompact = startMcp(join(directory, 'configured-compact.json'), {
    SHADOWGRAPH_VERIFIER_CONFIG: configPath,
    SHADOWGRAPH_MCP_COMPACT: '1'
  });
  t.after(() => configuredCompact.child.kill());
  const compactList = await configuredCompact.call({ jsonrpc: '2.0', id: 20, method: 'tools/list' });
  assert.equal(compactList.result.tools.length, 12);
  assert.equal(compactList.result.tools.some((tool) => tool.name === 'shadowgraph_verify_fact'), false);

  const recorded = await configured.call({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'shadowgraph_record_fact', arguments: { project: 'app', key: 'release', value: 'ready' }
    }
  });
  const fact = JSON.parse(recorded.result.content[0].text);
  const evidencePath = join(evidenceRoot, 'signed.json');
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({
    fact, verifierIdentity: 'approver', evidenceReference: 'ticket:MCP-1',
    verifiedAt: '2026-08-27T00:00:00.000Z', privateKey: keys.privateKey
  })), 'utf8');
  const verified = await configured.call({
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'shadowgraph_verify_fact', arguments: { factId: fact.id, evidencePath }
    }
  });
  const payload = JSON.parse(verified.result.content[0].text);
  assert.equal(payload.fact.verificationStatus, 'verified');
  assert.equal(payload.fact.verification.evidenceReference, 'ticket:MCP-1');
});
