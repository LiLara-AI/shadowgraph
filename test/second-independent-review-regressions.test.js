import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { copyFile as realCopyFile, mkdir, readFile, readdir, rename as realRename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { restoreFile } from '../src/backup.js';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';
import { createRestoreValidator } from '../src/restore-validation.js';
import { rebuildProjection } from '../src/journal.js';
import { createFactAttestation, createLocalEvidenceVerifier } from '../src/verification.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const FIXED_NOW = '2026-08-27T12:00:00.000Z';
const JSON_ARTIFACT = /^\.restore\..+\.(?:tmp|rollback)$/;

function graphPayload(id, title) {
  const graph = createShadowGraph({ now: () => FIXED_NOW });
  graph.addDecision({ id, project: 'rrv', title, chosen: title });
  return graph.exportData();
}

async function writePayload(path, payload) {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function jsonArtifacts(directory) {
  return (await readdir(directory)).filter((name) => JSON_ARTIFACT.test(name)).sort();
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
    for (const line of lines.filter((candidate) => candidate.trim())) {
      const response = JSON.parse(line);
      const waiter = pending.get(JSON.stringify(response.id));
      if (!waiter) continue;
      pending.delete(JSON.stringify(response.id));
      waiter.resolve(response);
    }
  });
  child.on('exit', (code) => {
    const error = new Error(`MCP exited before replying (code ${code}): ${stderr}`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  return {
    child,
    call(request) {
      return new Promise((resolveCall, rejectCall) => {
        const key = JSON.stringify(request.id);
        const timer = setTimeout(() => {
          pending.delete(key);
          rejectCall(new Error(`Timed out waiting for MCP response to ${request.method}: ${stderr}`));
        }, 10_000);
        pending.set(key, {
          resolve(value) { clearTimeout(timer); resolveCall(value); },
          reject(error) { clearTimeout(timer); rejectCall(error); }
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

function mcpTool(id, name, args = {}) {
  return {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: args }
  };
}

function assertPrivateLegacyMcpFailure(response, {
  code = -32000,
  message = 'Tool execution failed',
  data,
  forbidden = []
} = {}) {
  assert.equal(response.result, undefined, 'legacy tool failures use the numeric JSON-RPC error form');
  assert.deepEqual(response.error, {
    code,
    message,
    ...(data === undefined ? {} : { data })
  });
  const publicFailure = JSON.stringify(response);
  for (const privateValue of forbidden) {
    assert.equal(publicFailure.includes(String(privateValue)), false, `MCP failure disclosed ${String(privateValue)}`);
  }
  assert.doesNotMatch(publicFailure, /retainedArtifacts|unknownArtifacts|artifactCleanup|rollbackArtifact|recoveryArtifact|EACCES|EPERM|SQLITE_[A-Z_]+/);
}

async function verifierFixture(directory) {
  const keys = generateKeyPairSync('ed25519');
  const evidenceRoot = join(directory, 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const verifier = createLocalEvidenceVerifier({
    allowedEvidenceRoot: evidenceRoot,
    trustedVerifiers: { approver: keys.publicKey }
  });
  const configPath = join(directory, 'verifier.json');
  await writeFile(configPath, JSON.stringify({
    allowedEvidenceRoot: evidenceRoot,
    trustedVerifiers: { approver: keys.publicKey.export({ type: 'spki', format: 'pem' }) }
  }), 'utf8');
  return { keys, evidenceRoot, verifier, configPath };
}

async function signedFactPayload(directory, fixture, options = {}) {
  const graph = createShadowGraph({ verifier: fixture.verifier, now: () => options.now ?? FIXED_NOW });
  const fact = graph.addFact({
    id: options.id ?? 'rrv02-signed-fact', project: 'rrv', key: options.key ?? 'rrv02-key',
    value: options.value ?? 'signed', expiresAt: options.expiresAt ?? '2026-09-30T00:00:00.000Z'
  });
  const evidencePath = join(fixture.evidenceRoot, `${fact.id}.json`);
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({
    fact,
    verifierIdentity: 'approver',
    evidenceReference: `ticket:${fact.id}`,
    verifiedAt: options.verifiedAt ?? '2026-08-27T12:05:00.000Z',
    privateKey: fixture.keys.privateKey
  })), 'utf8');
  await graph.verifyFact({ factId: fact.id, evidencePath });
  if (options.terminal === 'expired') graph.maintain({ now: options.expiredAt ?? '2026-10-01T00:00:00.000Z' });
  if (options.terminal === 'superseded') {
    graph.addFact({
      id: `${fact.id}-replacement`, project: fact.project, key: fact.key, value: 'replacement',
      validFrom: '2026-09-01T00:00:00.000Z', observedAt: '2026-09-01T00:00:00.000Z',
      recordedAt: '2026-09-01T00:00:00.000Z'
    });
  }
  return graph.exportData();
}

function appendVerifiedResurrection(payload, factId) {
  const verified = payload.journal.find((entry) => entry.type === 'fact.verified' && entry.entityId === factId);
  assert.ok(verified, 'fixture requires a verified journal entry');
  const resurrection = structuredClone(verified);
  resurrection.id = `${verified.id}-resurrection`;
  resurrection.seq = Math.max(...payload.journal.map((entry) => entry.seq)) + 1;
  resurrection.at = '2026-10-02T00:00:00.000Z';
  payload.journal.push(resurrection);
  payload.journalSeq = resurrection.seq;
  payload.facts[payload.facts.findIndex((fact) => fact.id === factId)] = structuredClone(verified.payload);
  return payload;
}

function rewriteTerminalAsDuplicateVerification(payload, factId) {
  const verified = payload.journal.find((entry) => entry.type === 'fact.verified' && entry.entityId === factId);
  const terminal = payload.journal.findLast((entry) => ['fact.expired', 'fact.superseded'].includes(entry.type) && entry.entityId === factId);
  assert.ok(verified && terminal, 'fixture requires verified and terminal journal entries');
  terminal.type = 'fact.verified';
  terminal.payload = structuredClone(verified.payload);
  payload.facts[payload.facts.findIndex((fact) => fact.id === factId)] = structuredClone(verified.payload);
  return payload;
}

function legacyVerifiedIdempotencyPayload(schemaVersion, suffix = String(schemaVersion)) {
  const graph = createShadowGraph({ now: () => FIXED_NOW });
  graph.addFact({
    id: `rrv03-fact-${suffix}`, project: 'rrv03', key: `legacy-${suffix}`, value: { schemaVersion, stable: true },
    sourceClass: 'human_confirmed', actor: 'legacy-writer', idempotencyKey: `retry-${suffix}`
  });
  const payload = graph.exportData();
  payload.schemaVersion = schemaVersion;
  const markLegacyVerified = (fact) => {
    fact.schemaVersion = schemaVersion;
    fact.verificationStatus = 'verified';
    delete fact.verification;
    delete fact.verificationUntrustedReason;
    delete fact.legacyVerificationStatus;
  };
  markLegacyVerified(payload.facts[0]);
  markLegacyVerified(payload.idempotency[0].value);
  for (const entry of payload.journal) {
    entry.schemaVersion = schemaVersion;
    if (entry.payload?.kind === 'fact') markLegacyVerified(entry.payload);
  }
  return payload;
}

function assertCanonicalUnverifiedRetry(graph, schemaVersion, suffix = String(schemaVersion)) {
  const canonicalFact = graph.exportData().facts.find((fact) => fact.id === `rrv03-fact-${suffix}`);
  const retry = graph.addFact({
    project: 'rrv03', key: 'ignored-on-retry', value: 'ignored', idempotencyKey: `retry-${suffix}`
  });
  assert.equal(canonicalFact.verificationStatus, 'unverified');
  assert.equal(canonicalFact.legacyVerificationStatus, 'verified');
  assert.deepEqual(retry, canonicalFact, `schema ${schemaVersion} retry must return the canonical migrated fact`);
  const cached = graph.exportData().idempotency.find((item) => item.value.id === canonicalFact.id);
  assert.deepEqual(cached.value, canonicalFact, `schema ${schemaVersion} cache must store canonical content`);
  return canonicalFact;
}

function runCli(file, command, argument) {
  return new Promise((resolveCli, rejectCli) => {
    const child = spawn(process.execPath, ['src/cli.js', command, argument], {
      cwd: process.cwd(), env: { ...process.env, SHADOWGRAPH_FILE: file }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectCli);
    child.on('close', (code) => {
      if (code !== 0) rejectCli(new Error(stderr));
      else resolveCli(JSON.parse(stdout));
    });
  });
}

test('RRV-01: JSON restore verifies a complete rollback artifact before installation and cleans it after success', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv01-json-preinstall-');
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  const original = graphPayload('rrv01-old', 'RRV01 OLD');
  const replacement = graphPayload('rrv01-new', 'RRV01 NEW');
  await writePayload(destination, original);
  await writePayload(source, replacement);
  const originalBytes = await readFile(destination);
  let observedRollbackPath;

  const result = await restoreFile(source, destination, {
    restoreFs: {
      async rename(from, to) {
        if (resolve(to) === resolve(destination) && String(from).endsWith('.tmp')) {
          const rollbackNames = (await jsonArtifacts(directory)).filter((name) => name.endsWith('.rollback'));
          assert.equal(rollbackNames.length, 1, 'one rollback artifact must exist before replacement installation');
          observedRollbackPath = join(directory, rollbackNames[0]);
          const rollbackBytes = await readFile(observedRollbackPath);
          assert.deepEqual(rollbackBytes, originalBytes, 'the preinstalled rollback artifact must be a complete byte-for-byte snapshot');
          assert.deepEqual(JSON.parse(rollbackBytes), original, 'the rollback artifact must be complete parseable ShadowGraph JSON');
        }
        return realRename(from, to);
      }
    }
  });

  assert.equal(result.records, 1);
  assert.ok(observedRollbackPath, 'the installation hook must observe the rollback artifact');
  assert.deepEqual(await jsonArtifacts(directory), [], 'successful restore must clean temporary and rollback artifacts');
  assert.deepEqual(
    JSON.parse(await readFile(destination, 'utf8')),
    { ...replacement, revision: 1 },
    'restored semantics must match the source while the concurrency token is max(destination=0, source=0) + 1'
  );
});

test('RRV-01: JSON unconfirmed recovery retains and reports the exact complete rollback artifact', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv01-json-unconfirmed-');
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  const original = graphPayload('rrv01-retained-old', 'RRV01 RETAINED OLD');
  const replacement = graphPayload('rrv01-retained-new', 'RRV01 RETAINED NEW');
  await writePayload(destination, original);
  await writePayload(source, replacement);
  const originalBytes = await readFile(destination);
  let recoveryError;

  await assert.rejects(restoreFile(source, destination, {
    restoreFault(stage) {
      if (stage === 'afterReplacementRename') throw new Error('injected activation failure');
      if (stage === 'beforeRollbackInstall') throw new Error('injected rollback install failure');
    }
  }), (error) => {
    recoveryError = error;
    assert.equal(error.code, 'json_restore_recovery_unconfirmed');
    assert.match(error.message, /rollback is unconfirmed/i);
    assert.ok(error.rollbackArtifact, 'the exact rollback path must be reported');
    assert.deepEqual(error.retainedArtifacts, [error.rollbackArtifact]);
    return true;
  });

  t.after(async () => {
    for (const path of recoveryError?.retainedArtifacts ?? []) await unlink(path).catch(() => {});
  });
  assert.equal(resolve(recoveryError.rollbackArtifact).startsWith(resolve(directory)), true);
  assert.deepEqual(await readFile(recoveryError.rollbackArtifact), originalBytes);
  assert.deepEqual(JSON.parse(await readFile(recoveryError.rollbackArtifact, 'utf8')), original);
  assert.deepEqual((await jsonArtifacts(directory)).filter((name) => name.endsWith('.rollback')), [recoveryError.rollbackArtifact.split(/[\\/]/).pop()]);
});

test('RRV-01: ordinary JSON rollback restores old bytes and cleans every artifact', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv01-json-rollback-clean-');
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  await writePayload(destination, graphPayload('rrv01-clean-old', 'RRV01 CLEAN OLD'));
  await writePayload(source, graphPayload('rrv01-clean-new', 'RRV01 CLEAN NEW'));
  const before = await readFile(destination);

  await assert.rejects(restoreFile(source, destination, {
    afterReplace() { throw new Error('ordinary activation failure'); }
  }), (error) => error.code === 'json_restore_rolled_back');

  assert.deepEqual(await readFile(destination), before);
  assert.deepEqual(await jsonArtifacts(directory), []);
});

test('RRV-01: real HTTP JSON restore latches degraded state, exposes retained evidence, and blocks later reads and writes', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv01-http-json-');
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  await writePayload(destination, graphPayload('rrv01-http-old', 'RRV01 HTTP OLD'));
  await writePayload(source, graphPayload('rrv01-http-new', 'RRV01 HTTP NEW'));
  const originalBytes = await readFile(destination);
  const app = await createShadowGraphServer({
    file: destination,
    now: () => FIXED_NOW,
    restoreFault(stage) {
      if (stage === 'afterReplacementRename') throw new Error('injected HTTP activation failure');
      if (stage === 'beforeRollbackInstall') throw new Error('injected HTTP rollback failure');
    }
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let retainedPath;
  t.after(async () => {
    await new Promise((resolveClose) => app.server.close(resolveClose));
    if (retainedPath) await unlink(retainedPath).catch(() => {});
  });

  const restore = await fetch(`${base}/restore`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source })
  });
  const failure = await restore.json();
  assert.equal(restore.status, 500);
  assert.equal(failure.code, 'json_restore_recovery_unconfirmed');
  assert.equal(failure.retainedArtifacts.length, 1);
  [retainedPath] = failure.retainedArtifacts;
  assert.deepEqual(await readFile(retainedPath), originalBytes);
  const evidenceBeforeLaterCalls = await readFile(retainedPath);

  const blockedWrite = await fetch(`${base}/decisions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'rrv01-http-post-fatal', title: 'MUST NOT LAND', chosen: 'unsafe' })
  });
  assert.equal(blockedWrite.status, 503);
  assert.equal((await blockedWrite.json()).code, 'persistence_unavailable');
  assert.equal((await fetch(`${base}/search?query=RRV01`)).status, 503);
  assert.deepEqual(await readFile(retainedPath), evidenceBeforeLaterCalls, 'later requests must not overwrite retained recovery evidence');
  assert.equal((await readFile(destination, 'utf8')).includes('MUST NOT LAND'), false);

  const healthResponse = await fetch(`${base}/health`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.ok, false);
  assert.equal(health.status, 'degraded');
  assert.equal(health.recoveryCode, 'json_restore_recovery_unconfirmed');
  assert.deepEqual(health.retainedArtifacts, [retainedPath]);
});

test('RRV-01: real MCP JSON restore fail-closes after unconfirmed recovery and preserves retained evidence', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv01-mcp-json-');
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  await writePayload(destination, graphPayload('rrv01-mcp-old', 'RRV01 MCP OLD'));
  await writePayload(source, graphPayload('rrv01-mcp-new', 'RRV01 MCP NEW'));
  const originalBytes = await readFile(destination);
  const rpc = startMcp(destination, {
    NODE_ENV: 'test',
    SHADOWGRAPH_TEST_RESTORE_FAULT_STAGES: 'afterReplacementRename,beforeRollbackInstall'
  });
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  const restore = await rpc.call(mcpTool(2, 'shadowgraph_restore', { source }));
  assertPrivateLegacyMcpFailure(restore, {
    message: 'Tool execution failed (json_restore_recovery_unconfirmed)',
    data: {
      issueCode: 'json_restore_recovery_unconfirmed',
      recoveryCode: 'json_restore_recovery_unconfirmed'
    },
    forbidden: [source, destination, 'rrv01-mcp-old', 'rrv01-mcp-new', 'rollback is unconfirmed']
  });
  const artifactNames = await jsonArtifacts(directory);
  assert.equal(artifactNames.length, 1, 'unconfirmed JSON recovery retains only one rollback artifact');
  assert.equal(artifactNames[0].endsWith('.rollback'), true);
  const retainedPath = join(directory, artifactNames[0]);
  t.after(async () => { await unlink(retainedPath).catch(() => {}); });
  assert.deepEqual(await readFile(retainedPath), originalBytes);
  const evidenceBeforeLaterCalls = await readFile(retainedPath);

  const blockedWrite = await rpc.call(mcpTool(3, 'shadowgraph_record_decision', {
    id: 'rrv01-mcp-post-fatal', project: 'rrv', title: 'MUST NOT LAND', chosen: 'unsafe'
  }));
  assertPrivateLegacyMcpFailure(blockedWrite, {
    code: -32001,
    message: 'Persistent storage unavailable',
    data: { recoveryCode: 'json_restore_recovery_unconfirmed' },
    forbidden: ['rrv01-mcp-post-fatal', retainedPath]
  });

  const blockedRead = await rpc.call(mcpTool(4, 'shadowgraph_search', { project: 'rrv', query: 'RRV01' }));
  assertPrivateLegacyMcpFailure(blockedRead, {
    code: -32001,
    message: 'Persistent storage unavailable',
    data: { recoveryCode: 'json_restore_recovery_unconfirmed' },
    forbidden: [retainedPath]
  });
  assert.deepEqual(await readFile(retainedPath), evidenceBeforeLaterCalls);
  assert.equal((await readFile(destination, 'utf8')).includes('MUST NOT LAND'), false);

  const protocolDiagnostic = await rpc.call({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  assert.equal(protocolDiagnostic.error, undefined, 'protocol discovery remains available for restart diagnostics');
});

test('RRV-01: real MCP SQLite unconfirmed recovery uses the same fail-closed latch', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv01-mcp-sqlite-');
  const destination = join(directory, 'live.db');
  const source = join(directory, 'source.db');
  let live;
  let backup;
  try {
    live = await createSqliteStore(destination);
    backup = await createSqliteStore(source);
  } catch (error) {
    if (/requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  await live.save(graphPayload('rrv01-mcp-sqlite-old', 'RRV01 MCP SQLITE OLD'));
  await backup.save(graphPayload('rrv01-mcp-sqlite-new', 'RRV01 MCP SQLITE NEW'));
  live.close();
  backup.close();

  const rpc = startMcp(destination, {
    NODE_ENV: 'test',
    SHADOWGRAPH_STORAGE: 'sqlite',
    SHADOWGRAPH_TEST_RESTORE_FAULT_STAGES: 'afterReplacementRename,beforeRecoveryCopy'
  });
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 20, method: 'tools/list' });
  const restore = await rpc.call(mcpTool(21, 'shadowgraph_restore', { source }));
  assertPrivateLegacyMcpFailure(restore, {
    message: 'Tool execution failed (sqlite_restore_recovery_unconfirmed)',
    data: {
      issueCode: 'sqlite_restore_recovery_unconfirmed',
      recoveryCode: 'sqlite_restore_recovery_unconfirmed'
    },
    forbidden: [source, destination, 'rrv01-mcp-sqlite-old', 'rrv01-mcp-sqlite-new', 'rollback is unconfirmed']
  });
  const retainedNames = (await readdir(directory))
    .filter((name) => /^\..+\.(?:restore|rollback|old|recovery)(?:-(?:wal|shm|journal))?$/.test(name))
    .sort();
  const rollbackNames = retainedNames.filter((name) => name.endsWith('.rollback'));
  assert.equal(rollbackNames.length, 1, 'unconfirmed SQLite recovery retains one complete rollback database');
  const rollbackPath = join(directory, rollbackNames[0]);
  const retained = await createSqliteStore(rollbackPath);
  try { assert.equal((await retained.load()).records[0].id, 'rrv01-mcp-sqlite-old'); }
  finally { retained.close(); }

  const blockedWrite = await rpc.call(mcpTool(22, 'shadowgraph_record_decision', {
    id: 'rrv01-mcp-sqlite-post-fatal', title: 'MUST NOT LAND SQLITE', chosen: 'unsafe'
  }));
  const blockedRead = await rpc.call(mcpTool(23, 'shadowgraph_search', { query: 'RRV01' }));
  const sqliteLatch = {
    code: -32001,
    message: 'Persistent storage unavailable',
    data: { recoveryCode: 'sqlite_restore_recovery_unconfirmed' }
  };
  assertPrivateLegacyMcpFailure(blockedWrite, {
    ...sqliteLatch,
    forbidden: ['rrv01-mcp-sqlite-post-fatal', rollbackPath]
  });
  assertPrivateLegacyMcpFailure(blockedRead, { ...sqliteLatch, forbidden: [rollbackPath] });

  await rpc.stop();
  for (const name of retainedNames) await unlink(join(directory, name)).catch(() => {});
});

test('RRV-02: core import and journal rebuild reject rewritten, duplicate, and post-terminal fact verification', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv02-core-lifecycle-');
  const fixture = await verifierFixture(directory);
  const attacks = [];
  for (const terminal of ['expired', 'superseded']) {
    const factId = `rrv02-${terminal}`;
    attacks.push({
      label: `${terminal} terminal followed by active verification`,
      payload: appendVerifiedResurrection(
        await signedFactPayload(directory, fixture, { id: factId, terminal }),
        factId
      )
    });
    const rewrittenId = `rrv02-${terminal}-rewritten`;
    attacks.push({
      label: `${terminal} terminal rewritten as duplicate verification`,
      payload: rewriteTerminalAsDuplicateVerification(
        await signedFactPayload(directory, fixture, { id: rewrittenId, terminal }),
        rewrittenId
      )
    });
  }

  for (const { label, payload } of attacks) {
    const target = createShadowGraph({ verifier: fixture.verifier, now: () => FIXED_NOW });
    const before = target.exportData();
    assert.throws(
      () => target.importData(payload),
      /fact.*lifecycle|duplicate.*fact\.verified|terminal.*verified|monotonic/i,
      label
    );
    assert.deepEqual(target.exportData(), before, `${label}: failed merge-oriented import must be atomic`);

    const report = rebuildProjection(payload.journal, { journalEpoch: payload.journalEpoch });
    assert.equal(report.rebuildable, false, `${label}: raw journal rebuild must be declared incomplete`);
    assert.ok(report.skipped.some((entry) => entry.why === 'fact_lifecycle_violation'), `${label}: report must identify lifecycle corruption`);
    assert.notEqual(report.projection.facts.find((fact) => fact.id === payload.facts[0].id)?.verificationStatus, 'verified');
  }
});

test('RRV-02: an active signed fact is trusted before but never at or after its signed effective expiration boundary', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv02-trusted-instant-');
  const fixture = await verifierFixture(directory);
  const boundary = '2026-08-28T00:00:00.000Z';
  const payload = await signedFactPayload(directory, fixture, {
    id: 'rrv02-expiration-boundary', expiresAt: boundary
  });

  const preExpiry = createShadowGraph({ verifier: fixture.verifier, now: () => '2026-08-27T23:59:59.999Z' });
  assert.doesNotThrow(() => preExpiry.importData(payload), 'a valid pre-expiry backup must remain restorable');
  assert.equal(preExpiry.exportData().facts[0].verificationStatus, 'verified');
  assert.doesNotThrow(() => createRestoreValidator({
    verifier: fixture.verifier,
    now: () => '2026-08-27T23:59:59.999Z'
  })(payload));

  for (const trustedInstant of [boundary, '2026-08-28T00:00:00.001Z']) {
    const expiredTrust = createShadowGraph({ verifier: fixture.verifier, now: () => trustedInstant });
    assert.throws(() => expiredTrust.importData(payload), /verification.*expired|expiration boundary|invalid/i);
  }

  let trustedInstant = '2026-08-27T23:59:59.999Z';
  const rebuilding = createShadowGraph({ verifier: fixture.verifier, now: () => trustedInstant });
  rebuilding.importData(payload);
  const rawJournal = structuredClone(rebuilding.exportData().journal);
  trustedInstant = boundary;
  const report = rebuilding.rebuild();
  assert.equal(report.rebuildable, false);
  assert.notEqual(report.projection.facts[0]?.verificationStatus, 'verified');
  assert.deepEqual(rebuilding.exportData().journal, rawJournal, 'failed trusted rebuild must not rewrite audit evidence');
});

test('RRV-02: JSON and SQLite restore reject lifecycle resurrection before replacing either destination', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv02-direct-restore-');
  const fixture = await verifierFixture(directory);
  const factId = 'rrv02-direct-restore-fact';
  const attack = rewriteTerminalAsDuplicateVerification(
    await signedFactPayload(directory, fixture, { id: factId, terminal: 'expired' }),
    factId
  );
  const validator = createRestoreValidator({ verifier: fixture.verifier, now: () => FIXED_NOW });
  const old = graphPayload('rrv02-direct-old', 'RRV02 DIRECT OLD');

  const jsonDestination = join(directory, 'live.json');
  const jsonSource = join(directory, 'source.json');
  await writePayload(jsonDestination, old);
  await writePayload(jsonSource, attack);
  const jsonBefore = await readFile(jsonDestination);
  await assert.rejects(restoreFile(jsonSource, jsonDestination, { validate: validator }), /lifecycle|duplicate.*fact\.verified|monotonic/i);
  assert.deepEqual(await readFile(jsonDestination), jsonBefore);
  assert.deepEqual(await jsonArtifacts(directory), []);

  let sqliteDestination;
  let sqliteSource;
  const sqliteDestinationPath = join(directory, 'live.db');
  const sqliteSourcePath = join(directory, 'source.db');
  try {
    sqliteDestination = await createSqliteStore(sqliteDestinationPath, { restoreValidator: validator });
    sqliteSource = await createSqliteStore(sqliteSourcePath);
  } catch (error) {
    if (/requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  await sqliteDestination.save(old);
  await sqliteSource.save(attack);
  sqliteSource.close();
  sqliteDestination.close();
  sqliteDestination = await createSqliteStore(sqliteDestinationPath, { restoreValidator: validator });
  const sqliteBefore = await readFile(sqliteDestinationPath);
  await assert.rejects(sqliteDestination.restore(sqliteSourcePath), /lifecycle|duplicate.*fact\.verified|monotonic/i);
  assert.deepEqual(await readFile(sqliteDestinationPath), sqliteBefore);
  assert.equal((await sqliteDestination.load()).records[0].id, old.records[0].id);
  sqliteDestination.close();
});

test('RRV-02: real HTTP and MCP restore reject lifecycle resurrection atomically', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv02-interfaces-');
  const fixture = await verifierFixture(directory);
  const factId = 'rrv02-interface-fact';
  const attack = rewriteTerminalAsDuplicateVerification(
    await signedFactPayload(directory, fixture, { id: factId, terminal: 'expired' }),
    factId
  );
  const old = graphPayload('rrv02-interface-old', 'RRV02 INTERFACE OLD');

  const httpDestination = join(directory, 'http-live.json');
  const httpSource = join(directory, 'http-source.json');
  await writePayload(httpDestination, old);
  await writePayload(httpSource, attack);
  const httpBefore = await readFile(httpDestination);
  const app = await createShadowGraphServer({ file: httpDestination, verifier: fixture.verifier, now: () => FIXED_NOW });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const response = await fetch(`${base}/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: httpSource })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /lifecycle|duplicate.*fact\.verified|monotonic/i);
    assert.deepEqual(await readFile(httpDestination), httpBefore);
    const records = await (await fetch(`${base}/records`)).json();
    assert.deepEqual(records.records.map((record) => record.id), [old.records[0].id]);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
  }

  const mcpDestination = join(directory, 'mcp-live.json');
  const mcpSource = join(directory, 'mcp-source.json');
  await writePayload(mcpDestination, old);
  await writePayload(mcpSource, attack);
  const mcpBefore = await readFile(mcpDestination);
  const rpc = startMcp(mcpDestination, { SHADOWGRAPH_VERIFIER_CONFIG: fixture.configPath });
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 30, method: 'tools/list' });
  const rejected = await rpc.call(mcpTool(31, 'shadowgraph_restore', { source: mcpSource }));
  assertPrivateLegacyMcpFailure(rejected, {
    forbidden: [mcpSource, mcpDestination, factId, 'lifecycle', 'duplicate fact.verified', 'monotonic']
  });
  assert.deepEqual(await readFile(mcpDestination), mcpBefore);
  const search = await rpc.call(mcpTool(32, 'shadowgraph_search', { project: 'rrv', query: 'RRV02 INTERFACE OLD' }));
  assert.equal(search.error, undefined, search.error?.message);
  assert.equal(JSON.parse(search.result.content[0].text).page.total, 1);
});

test('RRV-02: legitimate signed expiration and supersession remain importable and rebuildable', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv02-legitimate-');
  const fixture = await verifierFixture(directory);
  for (const terminal of ['expired', 'superseded']) {
    const payload = await signedFactPayload(directory, fixture, { id: `rrv02-legitimate-${terminal}`, terminal });
    const graph = createShadowGraph({ verifier: fixture.verifier, now: () => '2026-10-02T00:00:00.000Z' });
    assert.doesNotThrow(() => graph.importData(payload), terminal);
    const signed = graph.exportData().facts.find((fact) => fact.verification);
    assert.equal(signed.status, terminal);
    const report = graph.rebuild();
    assert.equal(report.rebuildable, true, `${terminal} journal must remain rebuildable`);
    assert.equal(report.projection.facts.find((fact) => fact.id === signed.id).status, terminal);
    assert.doesNotThrow(() => createRestoreValidator({
      verifier: fixture.verifier,
      now: () => '2026-10-02T00:00:00.000Z'
    })(payload));
  }
});

test('RRV-03: schemas 1-5 normalize legacy verified idempotency to the canonical unverified fact in core and rebuild', () => {
  for (const schemaVersion of [1, 2, 3, 4, 5]) {
    const graph = createShadowGraph({ now: () => FIXED_NOW });
    graph.importData(legacyVerifiedIdempotencyPayload(schemaVersion));
    const canonical = assertCanonicalUnverifiedRetry(graph, schemaVersion);

    const report = graph.rebuild();
    assert.equal(report.rebuildable, true, `schema ${schemaVersion} journal must rebuild`);
    const rebuiltFact = report.projection.facts.find((fact) => fact.id === canonical.id);
    const rebuiltCache = report.projection.idempotency.find((item) => item.value.id === canonical.id);
    assert.equal(rebuiltFact.verificationStatus, 'unverified');
    assert.deepEqual(rebuiltCache.value, rebuiltFact, `schema ${schemaVersion} rebuild cache must equal its final entity`);

    const rebuiltImport = createShadowGraph({ now: () => FIXED_NOW });
    rebuiltImport.importData({ ...report.projection, schemaVersion: 5 });
    assertCanonicalUnverifiedRetry(rebuiltImport, schemaVersion);
  }
});

test('RRV-03: unexplained idempotency semantic mismatches are rejected atomically', () => {
  const payload = legacyVerifiedIdempotencyPayload(5, 'mismatch');
  payload.idempotency[0].value.value = { schemaVersion: 5, stable: false, injected: 'cache-only poison' };
  const graph = createShadowGraph({ now: () => FIXED_NOW });
  const before = graph.exportData();
  assert.throws(() => graph.importData(payload), /idempotency.*semantic.*mismatch|canonical entity/i);
  assert.deepEqual(graph.exportData(), before);
});

test('RRV-03: schemas 1-5 keep canonical unverified retries across JSON and SQLite restart', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv03-restarts-');
  for (const schemaVersion of [1, 2, 3, 4, 5]) {
    const payload = legacyVerifiedIdempotencyPayload(schemaVersion);
    const jsonPath = join(directory, `schema-${schemaVersion}.json`);
    const jsonStore = createJsonFileStore(jsonPath);
    await jsonStore.save(payload);
    const jsonGraph = createShadowGraph({ now: () => FIXED_NOW });
    jsonGraph.importData(await jsonStore.load());
    assertCanonicalUnverifiedRetry(jsonGraph, schemaVersion);

    const sqlitePath = join(directory, `schema-${schemaVersion}.db`);
    let sqlite;
    try { sqlite = await createSqliteStore(sqlitePath); }
    catch (error) {
      if (/requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }
    await sqlite.save(payload);
    sqlite.close();
    sqlite = await createSqliteStore(sqlitePath);
    const sqliteGraph = createShadowGraph({ now: () => FIXED_NOW });
    sqliteGraph.importData(await sqlite.load());
    sqlite.close();
    assertCanonicalUnverifiedRetry(sqliteGraph, schemaVersion);
  }
});

test('RRV-03: CLI, HTTP, and real MCP retries expose only the canonical unverified fact', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv03-interfaces-');
  const retryInput = (suffix) => ({
    project: 'rrv03', key: 'ignored-on-retry', value: 'ignored', idempotencyKey: `retry-${suffix}`
  });

  const cliFile = join(directory, 'cli.json');
  await writePayload(cliFile, legacyVerifiedIdempotencyPayload(5, 'cli'));
  const cliRetry = await runCli(cliFile, 'fact', JSON.stringify(retryInput('cli')));
  assert.equal(cliRetry.verificationStatus, 'unverified');
  const cliDurable = JSON.parse(await readFile(cliFile, 'utf8'));
  assert.deepEqual(cliRetry, cliDurable.facts[0]);
  assert.deepEqual(cliDurable.idempotency[0].value, cliDurable.facts[0]);

  const httpFile = join(directory, 'http.json');
  await writePayload(httpFile, legacyVerifiedIdempotencyPayload(5, 'http'));
  const app = await createShadowGraphServer({ file: httpFile, now: () => FIXED_NOW });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const response = await fetch(`${base}/facts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(retryInput('http'))
    });
    const retry = await response.json();
    assert.equal(response.status, 200);
    assert.equal(retry.verificationStatus, 'unverified');
    const exported = await (await fetch(`${base}/records`)).json();
    assert.deepEqual(retry, exported.facts[0]);
    assert.deepEqual(exported.idempotency[0].value, exported.facts[0]);
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
  }

  const mcpFile = join(directory, 'mcp.json');
  await writePayload(mcpFile, legacyVerifiedIdempotencyPayload(5, 'mcp'));
  const rpc = startMcp(mcpFile);
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 40, method: 'tools/list' });
  const response = await rpc.call(mcpTool(41, 'shadowgraph_record_fact', retryInput('mcp')));
  assert.equal(response.error, undefined, response.error?.message);
  const retry = JSON.parse(response.result.content[0].text);
  assert.equal(retry.verificationStatus, 'unverified');
  await rpc.stop();
  const durable = JSON.parse(await readFile(mcpFile, 'utf8'));
  assert.deepEqual(retry, durable.facts[0]);
  assert.deepEqual(durable.idempotency[0].value, durable.facts[0]);
});

test('RRV-03: valid signed facts return the final verified entity on retry when the verifier is configured', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-rrv03-valid-verifier-');
  const fixture = await verifierFixture(directory);
  const graph = createShadowGraph({ verifier: fixture.verifier, now: () => FIXED_NOW });
  const fact = graph.addFact({
    id: 'rrv03-valid-signed', project: 'rrv03', key: 'valid-signed', value: true,
    expiresAt: '2026-12-31T00:00:00.000Z', idempotencyKey: 'valid-signed-retry'
  });
  const evidencePath = join(fixture.evidenceRoot, 'rrv03-valid-signed.json');
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({
    fact, verifierIdentity: 'approver', evidenceReference: 'ticket:rrv03-valid',
    verifiedAt: '2026-08-27T12:05:00.000Z', privateKey: fixture.keys.privateKey
  })), 'utf8');
  await graph.verifyFact({ factId: fact.id, evidencePath });
  const canonical = graph.exportData().facts[0];
  assert.equal(canonical.verificationStatus, 'verified');

  const retryInput = { project: 'rrv03', key: 'ignored', value: false, idempotencyKey: 'valid-signed-retry' };
  assert.deepEqual(graph.addFact(retryInput), canonical, 'same-process retry must reflect verification');
  assert.deepEqual(graph.exportData().idempotency[0].value, canonical);
  const report = graph.rebuild();
  assert.equal(report.rebuildable, true);
  assert.deepEqual(report.projection.idempotency[0].value, report.projection.facts[0]);
  assert.equal(report.projection.idempotency[0].value.verificationStatus, 'verified');

  const restarted = createShadowGraph({ verifier: fixture.verifier, now: () => FIXED_NOW });
  restarted.importData(graph.exportData());
  assert.deepEqual(restarted.addFact(retryInput), restarted.exportData().facts[0]);
  assert.equal(restarted.addFact(retryInput).verificationStatus, 'verified');
});
