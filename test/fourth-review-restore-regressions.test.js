import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtemp,
  readFile,
  readdir,
  stat as realStat,
  unlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { restoreFile } from '../src/backup.js';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';

const FIXED_NOW = '2026-08-27T12:00:00.000Z';
const API_TOKEN = 'fourth-review-token';
const JSON_ARTIFACT = /^\.restore\..+\.(?:tmp|rollback|recovery)$/;

function graphPayload(id, title) {
  const graph = createShadowGraph({ now: () => FIXED_NOW });
  graph.addDecision({ id, project: 'fourth-review', title, chosen: title });
  return graph.exportData();
}

async function writePayload(path, payload) {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function installedJsonBytes(sourceBytes, revision) {
  const payload = JSON.parse(Buffer.from(sourceBytes).toString('utf8'));
  return Buffer.from(`${JSON.stringify({ ...payload, revision }, null, 2)}\n`, 'utf8');
}

async function artifactPaths(directory) {
  return (await readdir(directory))
    .filter((name) => JSON_ARTIFACT.test(name))
    .sort()
    .map((name) => join(directory, name));
}

function filesystemError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rollbackStatDenied(path) {
  if (String(path).endsWith('.rollback')) throw filesystemError('injected rollback stat denial', 'EACCES');
  return realStat(path);
}

function recoveryFailure(stage) {
  if (stage === 'afterReplacementRename') throw new Error('injected post-replacement failure');
  if (stage === 'beforeRollbackInstall') throw new Error('injected rollback install failure');
}

function mcpTool(id, name, args = {}) {
  return {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: args }
  };
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
      const key = JSON.stringify(response.id);
      const waiter = pending.get(key);
      if (!waiter) continue;
      pending.delete(key);
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
      const key = JSON.stringify(request.id);
      return new Promise((resolveCall, rejectCall) => {
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

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolveClose) => server.close(resolveClose));
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${API_TOKEN}`, ...extra };
}

test('DS-P1-001 direct JSON: unconfirmed recovery stays authoritative when rollback inventory stat is denied', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ds-p1-001-direct-'));
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  const original = graphPayload('ds-p1-direct-old', 'DS P1 DIRECT OLD');
  const replacement = graphPayload('ds-p1-direct-new', 'DS P1 DIRECT NEW');
  await writePayload(destination, original);
  await writePayload(source, replacement);
  const originalBytes = await readFile(destination);
  let recoveryError;

  await assert.rejects(restoreFile(source, destination, {
    restoreFault: recoveryFailure,
    restoreFs: { stat: rollbackStatDenied }
  }), (error) => {
    recoveryError = error;
    assert.equal(error.code, 'json_restore_recovery_unconfirmed');
    assert.match(error.message, /rollback is unconfirmed/i);
    assert.deepEqual(error.retainedArtifacts, []);
    assert.equal(error.rollbackArtifact, undefined);
    assert.equal(error.unknownArtifacts?.length, 1);
    assert.deepEqual(error.unknownArtifacts[0], {
      path: error.unknownArtifacts[0].path,
      code: 'EACCES'
    });
    assert.equal(error.unknownArtifacts[0].path.endsWith('.rollback'), true);
    return true;
  });

  const artifacts = await artifactPaths(directory);
  t.after(async () => { for (const path of artifacts) await unlink(path).catch(() => {}); });
  assert.deepEqual(artifacts, [recoveryError.unknownArtifacts[0].path]);
  assert.deepEqual(await readFile(artifacts[0]), originalBytes, 'unknown rollback path must retain the complete old bytes');
  assert.deepEqual(await readFile(destination), installedJsonBytes(await readFile(source), 1), 'installed content must match the source with the fresh max(destination=0, source=0) + 1 revision');

  const restarted = createJsonFileStore(destination);
  assert.deepEqual((await restarted.load()).records.map((record) => record.id), ['ds-p1-direct-new']);
  restarted.close();
});

test('DS-P1-001 HTTP: stat-denied inventory returns the fatal code and latches authenticated fail-closed state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ds-p1-001-http-'));
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  await writePayload(destination, graphPayload('ds-p1-http-old', 'DS P1 HTTP OLD'));
  await writePayload(source, graphPayload('ds-p1-http-new', 'DS P1 HTTP NEW'));
  const originalBytes = await readFile(destination);
  const app = await createShadowGraphServer({
    file: destination,
    apiToken: API_TOKEN,
    now: () => FIXED_NOW,
    restoreFault: recoveryFailure,
    restoreFs: { stat: rollbackStatDenied }
  });
  t.after(async () => { await closeServer(app.server); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const restore = await fetch(`${base}/restore`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ source })
  });
  const failure = await restore.json();
  assert.equal(restore.status, 500);
  assert.equal(failure.code, 'json_restore_recovery_unconfirmed');
  assert.deepEqual(failure.retainedArtifacts, []);
  assert.equal(failure.unknownArtifacts?.length, 1);
  assert.equal(failure.unknownArtifacts[0].code, 'EACCES');

  const [rollbackPath] = await artifactPaths(directory);
  t.after(async () => { await unlink(rollbackPath).catch(() => {}); });
  assert.equal(resolve(failure.unknownArtifacts[0].path), resolve(rollbackPath));
  assert.deepEqual(await readFile(rollbackPath), originalBytes);
  const destinationAfterFailure = await readFile(destination);
  const evidenceAfterFailure = await readFile(rollbackPath);

  const blockedWrite = await fetch(`${base}/decisions`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ id: 'ds-p1-http-must-not-land', title: 'MUST NOT LAND', chosen: 'unsafe' })
  });
  const blockedRead = await fetch(`${base}/records`, { headers: authHeaders() });
  assert.equal(blockedWrite.status, 503);
  assert.equal(blockedRead.status, 503);
  assert.deepEqual(await readFile(destination), destinationAfterFailure, 'later HTTP calls must not mutate the unconfirmed destination');
  assert.deepEqual(await readFile(rollbackPath), evidenceAfterFailure, 'later HTTP calls must not alter retained evidence');

  const unauthorizedDashboard = await fetch(`${base}/dashboard`);
  const dashboardText = await unauthorizedDashboard.text();
  assert.equal(unauthorizedDashboard.status, 200, 'the intentionally public static dashboard remains non-diagnostic');
  assert.equal(dashboardText.includes(rollbackPath), false, 'unauthenticated static HTML must not expose recovery paths');
  assert.equal(dashboardText.includes('json_restore_recovery_unconfirmed'), false);

  const unauthorizedHealth = await fetch(`${base}/health`);
  assert.equal(unauthorizedHealth.status, 401);
  assert.deepEqual(await unauthorizedHealth.json(), { error: 'authentication required' });
  const healthResponse = await fetch(`${base}/health`, { headers: authHeaders() });
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.status, 'degraded');
  assert.equal(health.recoveryCode, 'json_restore_recovery_unconfirmed');
  assert.deepEqual(health.retainedArtifacts, []);
  assert.deepEqual(health.unknownArtifacts, failure.unknownArtifacts);

  await closeServer(app.server);
  const restarted = await createShadowGraphServer({ file: destination, apiToken: API_TOKEN, now: () => FIXED_NOW });
  t.after(async () => { await closeServer(restarted.server); });
  restarted.server.listen(0, '127.0.0.1');
  await once(restarted.server, 'listening');
  const restartedBase = `http://127.0.0.1:${restarted.server.address().port}`;
  const records = await (await fetch(`${restartedBase}/records`, { headers: authHeaders() })).json();
  assert.deepEqual(records.records.map((record) => record.id), ['ds-p1-http-new']);
  assert.deepEqual(await readFile(rollbackPath), evidenceAfterFailure);
});

test('DS-P1-001 MCP: stat-denied inventory latches all graph tools while protocol diagnostics remain available', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ds-p1-001-mcp-'));
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  await writePayload(destination, graphPayload('ds-p1-mcp-old', 'DS P1 MCP OLD'));
  await writePayload(source, graphPayload('ds-p1-mcp-new', 'DS P1 MCP NEW'));
  const originalBytes = await readFile(destination);
  const rpc = startMcp(destination, {
    NODE_ENV: 'test',
    SHADOWGRAPH_TEST_RESTORE_FAULT_STAGES: 'afterReplacementRename,beforeRollbackInstall',
    SHADOWGRAPH_TEST_RESTORE_STAT_ERROR_SUFFIX: '.rollback',
    SHADOWGRAPH_TEST_RESTORE_STAT_ERROR_CODE: 'EACCES'
  });
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  const restore = await rpc.call(mcpTool(2, 'shadowgraph_restore', { source }));
  assert.equal(restore.result, undefined, 'legacy tool failures use the numeric JSON-RPC error form');
  assert.deepEqual(restore.error, {
    code: -32000,
    message: 'Tool execution failed (json_restore_recovery_unconfirmed)',
    data: {
      issueCode: 'json_restore_recovery_unconfirmed',
      recoveryCode: 'json_restore_recovery_unconfirmed'
    }
  });

  const retainedPaths = await artifactPaths(directory);
  assert.equal(retainedPaths.length, 1, 'stat-denied cleanup retains exactly the unknown rollback artifact');
  const [rollbackPath] = retainedPaths;
  t.after(async () => { await unlink(rollbackPath).catch(() => {}); });
  assert.deepEqual(await readFile(rollbackPath), originalBytes);
  const publicRestore = JSON.stringify(restore);
  for (const privateValue of [
    source, destination, rollbackPath,
    'ds-p1-mcp-old', 'ds-p1-mcp-new',
    'EACCES', 'retainedArtifacts', 'unknownArtifacts', 'rollback is unconfirmed'
  ]) {
    assert.equal(publicRestore.includes(privateValue), false, `restore failure disclosed ${privateValue}`);
  }
  const destinationAfterFailure = await readFile(destination);
  const evidenceAfterFailure = await readFile(rollbackPath);

  const blockedWrite = await rpc.call(mcpTool(3, 'shadowgraph_record_decision', {
    id: 'ds-p1-mcp-must-not-land', project: 'fourth-review', title: 'MUST NOT LAND', chosen: 'unsafe'
  }));
  const blockedRead = await rpc.call(mcpTool(4, 'shadowgraph_search', { project: 'fourth-review', query: 'DS P1' }));
  const publicLatchError = {
    code: -32001,
    message: 'Persistent storage unavailable',
    data: { recoveryCode: 'json_restore_recovery_unconfirmed' }
  };
  assert.equal(blockedWrite.result, undefined);
  assert.deepEqual(blockedWrite.error, publicLatchError);
  assert.equal(blockedRead.result, undefined);
  assert.deepEqual(blockedRead.error, publicLatchError);
  const publicLatch = JSON.stringify([blockedWrite, blockedRead]);
  for (const privateValue of ['ds-p1-mcp-must-not-land', rollbackPath, 'EACCES', 'unknownArtifacts']) {
    assert.equal(publicLatch.includes(privateValue), false, `degraded latch disclosed ${privateValue}`);
  }
  assert.deepEqual(await readFile(destination), destinationAfterFailure, 'later MCP calls must not mutate the unconfirmed destination');
  assert.deepEqual(await readFile(rollbackPath), evidenceAfterFailure, 'later MCP calls must not alter retained evidence');

  const diagnostics = await rpc.call({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  assert.equal(diagnostics.error, undefined, 'protocol-only diagnostics remain available');

  await rpc.stop();
  const restarted = startMcp(destination);
  t.after(async () => { await restarted.stop(); });
  await restarted.call({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
  const search = await restarted.call(mcpTool(11, 'shadowgraph_search', { project: 'fourth-review', query: 'DS P1 MCP NEW' }));
  assert.equal(search.error, undefined, search.error?.message);
  assert.deepEqual(JSON.parse(search.result.content[0].text).items.map((item) => item.record.id), ['ds-p1-mcp-new']);
  assert.deepEqual(await readFile(rollbackPath), evidenceAfterFailure);
});

test('DS-P2-002 direct JSON: successful restore reports a retained complete rollback artifact after unlink denial', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ds-p2-002-success-'));
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  await writePayload(destination, graphPayload('ds-p2-success-old', 'DS P2 SUCCESS OLD'));
  await writePayload(source, graphPayload('ds-p2-success-new', 'DS P2 SUCCESS NEW'));
  const originalBytes = await readFile(destination);
  const inspected = [];

  const result = await restoreFile(source, destination, {
    restoreFs: {
      async unlink(path) {
        if (String(path).endsWith('.rollback')) throw filesystemError('injected rollback unlink denial', 'EACCES');
        return unlink(path);
      },
      async stat(path) {
        inspected.push(path);
        return realStat(path);
      }
    }
  });

  assert.equal(result.records, 1, 'the existing success result remains compatible');
  assert.equal(result.retainedArtifacts.length, 1);
  assert.deepEqual(result.unknownArtifacts, []);
  assert.deepEqual(result.artifactCleanup, {
    status: 'incomplete',
    errors: [{ path: result.retainedArtifacts[0], code: 'EACCES' }]
  });
  assert.deepEqual(inspected.map((path) => path.match(/\.(rollback|recovery|tmp)$/)?.[1]).sort(), ['recovery', 'rollback', 'tmp']);

  const [rollbackPath] = await artifactPaths(directory);
  t.after(async () => { await unlink(rollbackPath).catch(() => {}); });
  assert.equal(resolve(result.retainedArtifacts[0]), resolve(rollbackPath));
  assert.deepEqual(await readFile(rollbackPath), originalBytes, 'retained success artifact must contain the exact complete old file');
  assert.deepEqual(await readFile(destination), installedJsonBytes(await readFile(source), 1), 'installed content must match the source with the fresh max(destination=0, source=0) + 1 revision');
  const restarted = createJsonFileStore(destination);
  assert.deepEqual((await restarted.load()).records.map((record) => record.id), ['ds-p2-success-new']);
  restarted.close();
});

test('DS-P2-002 direct JSON: confirmed rollback reports cleanup retention and restarts with exact old bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ds-p2-002-rolled-back-'));
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  await writePayload(destination, graphPayload('ds-p2-rollback-old', 'DS P2 ROLLBACK OLD'));
  await writePayload(source, graphPayload('ds-p2-rollback-new', 'DS P2 ROLLBACK NEW'));
  const originalBytes = await readFile(destination);
  let rollbackError;

  await assert.rejects(restoreFile(source, destination, {
    afterReplace() { throw new Error('injected activation rejection'); },
    restoreFs: {
      async unlink(path) {
        if (String(path).endsWith('.rollback')) throw filesystemError('injected rollback unlink denial', 'EACCES');
        return unlink(path);
      }
    }
  }), (error) => {
    rollbackError = error;
    assert.equal(error.code, 'json_restore_rolled_back');
    assert.equal(error.retainedArtifacts.length, 1);
    assert.deepEqual(error.unknownArtifacts, []);
    assert.equal(error.rollbackArtifact, error.retainedArtifacts[0]);
    assert.deepEqual(error.artifactCleanup, {
      status: 'incomplete',
      errors: [{ path: error.rollbackArtifact, code: 'EACCES' }]
    });
    return true;
  });

  const [rollbackPath] = await artifactPaths(directory);
  t.after(async () => { await unlink(rollbackPath).catch(() => {}); });
  assert.equal(resolve(rollbackError.rollbackArtifact), resolve(rollbackPath));
  assert.deepEqual(await readFile(rollbackPath), originalBytes);
  assert.deepEqual(await readFile(destination), originalBytes, 'confirmed rollback must restore exact old destination bytes');
  const restarted = createJsonFileStore(destination);
  assert.deepEqual((await restarted.load()).records.map((record) => record.id), ['ds-p2-rollback-old']);
  restarted.close();
});

test('DS-P2-002 direct JSON: delete-then-throw cleanup is confirmed complete and never falsely retained', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ds-p2-002-delete-throw-'));
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  await writePayload(destination, graphPayload('ds-p2-delete-old', 'DS P2 DELETE OLD'));
  await writePayload(source, graphPayload('ds-p2-delete-new', 'DS P2 DELETE NEW'));
  let deletedThenThrew = false;

  const result = await restoreFile(source, destination, {
    restoreFs: {
      async unlink(path) {
        if (!deletedThenThrew && String(path).endsWith('.rollback')) {
          await unlink(path);
          deletedThenThrew = true;
          throw filesystemError('injected unlink-after-delete failure', 'EIO');
        }
        return unlink(path);
      }
    }
  });

  assert.equal(deletedThenThrew, true);
  assert.deepEqual(result.retainedArtifacts, []);
  assert.deepEqual(result.unknownArtifacts, []);
  assert.deepEqual(result.artifactCleanup, {
    status: 'complete',
    errors: [{ path: result.artifactCleanup.errors[0].path, code: 'EIO' }]
  });
  assert.equal(result.artifactCleanup.errors[0].path.endsWith('.rollback'), true);
  assert.deepEqual(await artifactPaths(directory), []);
  assert.deepEqual(await readFile(destination), installedJsonBytes(await readFile(source), 1), 'installed content must match the source with the fresh max(destination=0, source=0) + 1 revision');
});

test('DS-P2-002 HTTP: successful restore propagates retained rollback cleanup evidence', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ds-p2-002-http-'));
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  await writePayload(destination, graphPayload('ds-p2-http-old', 'DS P2 HTTP OLD'));
  await writePayload(source, graphPayload('ds-p2-http-new', 'DS P2 HTTP NEW'));
  const originalBytes = await readFile(destination);
  const app = await createShadowGraphServer({
    file: destination,
    apiToken: API_TOKEN,
    now: () => FIXED_NOW,
    restoreFs: {
      async unlink(path) {
        if (String(path).endsWith('.rollback')) throw filesystemError('injected HTTP rollback unlink denial', 'EACCES');
        return unlink(path);
      }
    }
  });
  t.after(async () => { await closeServer(app.server); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const response = await fetch(`${base}/restore`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ source })
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.artifactCleanup.status, 'incomplete');
  assert.equal(result.retainedArtifacts.length, 1);
  assert.deepEqual(result.unknownArtifacts, []);
  const [rollbackPath] = await artifactPaths(directory);
  t.after(async () => { await unlink(rollbackPath).catch(() => {}); });
  assert.equal(resolve(result.retainedArtifacts[0]), resolve(rollbackPath));
  assert.deepEqual(await readFile(rollbackPath), originalBytes);
  assert.deepEqual((await (await fetch(`${base}/records`, { headers: authHeaders() })).json()).records.map((record) => record.id), ['ds-p2-http-new']);

  await closeServer(app.server);
  const restarted = createJsonFileStore(destination);
  assert.deepEqual((await restarted.load()).records.map((record) => record.id), ['ds-p2-http-new']);
  restarted.close();
});

test('DS-P2-002 HTTP: confirmed rollback propagates retained cleanup evidence without degrading the server', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ds-p2-002-http-rollback-'));
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  await writePayload(destination, graphPayload('ds-p2-http-rollback-old', 'DS P2 HTTP ROLLBACK OLD'));
  await writePayload(source, graphPayload('ds-p2-http-rollback-new', 'DS P2 HTTP ROLLBACK NEW'));
  const originalBytes = await readFile(destination);
  const app = await createShadowGraphServer({
    file: destination,
    apiToken: API_TOKEN,
    now: () => FIXED_NOW,
    restoreFault(stage) {
      if (stage === 'afterReplacementRename') throw new Error('injected HTTP activation rejection');
    },
    restoreFs: {
      async unlink(path) {
        if (String(path).endsWith('.rollback')) throw filesystemError('injected HTTP rollback unlink denial', 'EACCES');
        return unlink(path);
      }
    }
  });
  t.after(async () => { await closeServer(app.server); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const response = await fetch(`${base}/restore`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ source })
  });
  const failure = await response.json();
  assert.equal(response.status, 400);
  assert.equal(failure.code, 'json_restore_rolled_back');
  assert.equal(failure.artifactCleanup.status, 'incomplete');
  assert.equal(failure.retainedArtifacts.length, 1);
  assert.deepEqual(failure.unknownArtifacts, []);
  const [rollbackPath] = await artifactPaths(directory);
  t.after(async () => { await unlink(rollbackPath).catch(() => {}); });
  assert.equal(resolve(failure.retainedArtifacts[0]), resolve(rollbackPath));
  assert.deepEqual(await readFile(rollbackPath), originalBytes);
  assert.deepEqual(await readFile(destination), originalBytes);

  const recordsResponse = await fetch(`${base}/records`, { headers: authHeaders() });
  const records = await recordsResponse.json();
  assert.equal(recordsResponse.status, 200, 'confirmed rollback must not latch degraded state');
  assert.deepEqual(records.records.map((record) => record.id), ['ds-p2-http-rollback-old']);
});

test('DS-P2-002 MCP: successful restore propagates retained rollback cleanup evidence across restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ds-p2-002-mcp-'));
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  await writePayload(destination, graphPayload('ds-p2-mcp-old', 'DS P2 MCP OLD'));
  await writePayload(source, graphPayload('ds-p2-mcp-new', 'DS P2 MCP NEW'));
  const originalBytes = await readFile(destination);
  const rpc = startMcp(destination, {
    NODE_ENV: 'test',
    SHADOWGRAPH_TEST_RESTORE_UNLINK_ERROR_SUFFIX: '.rollback',
    SHADOWGRAPH_TEST_RESTORE_UNLINK_ERROR_CODE: 'EACCES'
  });
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 20, method: 'tools/list' });

  const response = await rpc.call(mcpTool(21, 'shadowgraph_restore', { source }));
  assert.equal(response.error, undefined, response.error?.message);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.artifactCleanup.status, 'incomplete');
  assert.equal(result.retainedArtifacts.length, 1);
  assert.deepEqual(result.unknownArtifacts, []);
  const [rollbackPath] = await artifactPaths(directory);
  t.after(async () => { await unlink(rollbackPath).catch(() => {}); });
  assert.equal(resolve(result.retainedArtifacts[0]), resolve(rollbackPath));
  assert.deepEqual(await readFile(rollbackPath), originalBytes);

  await rpc.stop();
  const restarted = startMcp(destination);
  t.after(async () => { await restarted.stop(); });
  await restarted.call({ jsonrpc: '2.0', id: 30, method: 'tools/list' });
  const search = await restarted.call(mcpTool(31, 'shadowgraph_search', { project: 'fourth-review', query: 'DS P2 MCP NEW' }));
  assert.equal(search.error, undefined, search.error?.message);
  assert.deepEqual(JSON.parse(search.result.content[0].text).items.map((item) => item.record.id), ['ds-p2-mcp-new']);
  assert.deepEqual(await readFile(rollbackPath), originalBytes);
});

test('DS-P2-002 MCP: confirmed rollback keeps cleanup evidence private and remains usable with old state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ds-p2-002-mcp-rollback-'));
  const destination = join(directory, 'live.json');
  const source = join(directory, 'source.json');
  await writePayload(destination, graphPayload('ds-p2-mcp-rollback-old', 'DS P2 MCP ROLLBACK OLD'));
  await writePayload(source, graphPayload('ds-p2-mcp-rollback-new', 'DS P2 MCP ROLLBACK NEW'));
  const originalBytes = await readFile(destination);
  const rpc = startMcp(destination, {
    NODE_ENV: 'test',
    SHADOWGRAPH_TEST_RESTORE_FAULT_STAGES: 'afterReplacementRename',
    SHADOWGRAPH_TEST_RESTORE_UNLINK_ERROR_SUFFIX: '.rollback',
    SHADOWGRAPH_TEST_RESTORE_UNLINK_ERROR_CODE: 'EACCES'
  });
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 40, method: 'tools/list' });

  const response = await rpc.call(mcpTool(41, 'shadowgraph_restore', { source }));
  assert.equal(response.result, undefined, 'legacy tool failures use the numeric JSON-RPC error form');
  assert.deepEqual(response.error, {
    code: -32000,
    message: 'Tool execution failed (json_restore_rolled_back)',
    data: { issueCode: 'json_restore_rolled_back' }
  });
  const retainedPaths = await artifactPaths(directory);
  assert.equal(retainedPaths.length, 1, 'incomplete cleanup retains exactly the rollback artifact');
  const [rollbackPath] = retainedPaths;
  t.after(async () => { await unlink(rollbackPath).catch(() => {}); });
  assert.deepEqual(await readFile(rollbackPath), originalBytes);
  assert.deepEqual(await readFile(destination), originalBytes);
  const publicFailure = JSON.stringify(response);
  for (const privateValue of [
    source, destination, rollbackPath,
    'ds-p2-mcp-rollback-old', 'ds-p2-mcp-rollback-new',
    'EACCES', 'artifactCleanup', 'retainedArtifacts', 'injected MCP activation rejection'
  ]) {
    assert.equal(publicFailure.includes(privateValue), false, `rollback failure disclosed ${privateValue}`);
  }

  const search = await rpc.call(mcpTool(42, 'shadowgraph_search', { project: 'fourth-review', query: 'DS P2 MCP ROLLBACK OLD' }));
  assert.equal(search.error, undefined, search.error?.message);
  assert.deepEqual(JSON.parse(search.result.content[0].text).items.map((item) => item.record.id), ['ds-p2-mcp-rollback-old']);
});
