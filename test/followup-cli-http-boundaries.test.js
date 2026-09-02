import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { getRuntimeCapabilities, NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const API_TOKEN = 'followup-boundary-token';
const FIXED_NOW = '2026-08-28T12:00:00.000Z';

function runCli(args, extraEnv = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

async function pathExists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function graphPayload(id, title) {
  const graph = createShadowGraph({ now: () => FIXED_NOW });
  graph.addDecision({ id, project: 'followup-private', title, chosen: title });
  return graph.exportData();
}

async function writePayload(path, payload) {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolveClose) => server.close(resolveClose));
}

function recoveryFailure(stage) {
  if (stage === 'afterReplacementRename') throw new Error('injected post-replacement failure');
  if (stage === 'beforeRollbackInstall') throw new Error('injected rollback install failure');
}

function adminHeaders(origin, extra = {}) {
  return { authorization: `Bearer ${API_TOKEN}`, origin, ...extra };
}

function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolveResponse, reject) => {
    const target = new URL(url);
    const request = httpRequest(target, { method, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolveResponse({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function rawGet(url, headers) {
  return rawRequest(url, { headers });
}

function alternatePort(port) {
  return port === 65_535 ? port - 1 : port + 1;
}

function assertGenericForbidden(response, label) {
  assert.equal(response.status, 403, label);
  assert.equal(response.headers['cache-control'], 'no-store', `${label}: denial must not be cached`);
  assert.deepEqual(JSON.parse(response.body), { error: 'forbidden' }, label);
}

function assertNoRecoveryDisclosure(text, sensitiveValues) {
  for (const value of sensitiveValues) {
    assert.equal(text.includes(value), false, `public response disclosed ${value}`);
  }
  assert.doesNotMatch(text, /retainedArtifacts|unknownArtifacts|artifactCleanup|rollbackArtifact|recoveryArtifact|\.rollback/i);
}

test('follow-up CLI: doctor observes missing SQLite without materializing storage and setup/JSON contracts stay intact', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-followup-cli-');
  const missingParent = join(directory, 'classified-sqlite-parent', 'nested');
  const sqliteFile = join(missingParent, 'private-doctor-state.sqlite');
  const sqliteEnv = { SHADOWGRAPH_STORAGE: 'sqlite', SHADOWGRAPH_FILE: sqliteFile };
  const sqliteAvailable = (await getRuntimeCapabilities()).nodeSqlite.available;

  assert.deepEqual(await readdir(directory), []);
  const missingSqlite = await runCli(['doctor'], sqliteEnv);
  assert.equal(missingSqlite.code, 1);
  assert.equal(missingSqlite.stdout, '');
  if (!sqliteAvailable) {
    assert.equal(missingSqlite.stderr.includes(NODE_SQLITE_NOT_APPLICABLE_REASON), true, missingSqlite.stderr);
  } else {
    assert.match(missingSqlite.stderr, /Storage is not initialized at .*private-doctor-state\.sqlite\. Run `shadowgraph setup` first\./);
  }

  assert.equal(await pathExists(missingParent), false, 'doctor must not create the missing parent');
  assert.equal(await pathExists(sqliteFile), false, 'doctor must not create the SQLite database');
  for (const candidate of [
    `${sqliteFile}-wal`, `${sqliteFile}-shm`, `${sqliteFile}-journal`, `${sqliteFile}.lock`,
    `${sqliteFile}.revision`, `${sqliteFile}.rev`, join(missingParent, 'revision.json')
  ]) assert.equal(await pathExists(candidate), false, `doctor created ${candidate}`);
  assert.deepEqual(await readdir(directory), [], 'doctor must leave no parent, lock, sidecar, or revision artifacts');

  if (sqliteAvailable) {
    const setup = await runCli(['setup'], sqliteEnv);
    assert.equal(setup.code, 0, setup.stderr);
    assert.deepEqual(JSON.parse(setup.stdout), {
      ok: true,
      command: 'setup',
      created: true,
      storage: { type: 'sqlite', path: resolve(sqliteFile) },
      next: 'Run `shadowgraph doctor`, then `shadowgraph remember <JSON>`.'
    });
    assert.equal(await pathExists(sqliteFile), true, 'setup must still create SQLite storage');

    const healthy = await runCli(['doctor'], sqliteEnv);
    assert.equal(healthy.code, 0, healthy.stderr);
    const report = JSON.parse(healthy.stdout);
    assert.equal(report.ok, true);
    assert.deepEqual(report.storage, {
      type: 'sqlite', path: resolve(sqliteFile), initialized: true, readable: true, writable: true
    });
  }

  const jsonParent = join(directory, 'json-state');
  const jsonFile = join(jsonParent, 'data.json');
  const jsonEnv = { SHADOWGRAPH_STORAGE: 'json', SHADOWGRAPH_FILE: jsonFile };
  const missingJson = await runCli(['doctor'], jsonEnv);
  assert.equal(missingJson.code, 1);
  assert.equal(missingJson.stdout, '');
  assert.match(missingJson.stderr, /Storage is not initialized at .*data\.json\. Run `shadowgraph setup` first\./);
  assert.equal(await pathExists(jsonParent), false, 'JSON doctor must remain observational');

  const jsonSetup = await runCli(['setup'], jsonEnv);
  assert.equal(jsonSetup.code, 0, jsonSetup.stderr);
  assert.deepEqual(JSON.parse(jsonSetup.stdout), {
    ok: true,
    command: 'setup',
    created: true,
    storage: { type: 'json', path: resolve(jsonFile) },
    next: 'Run `shadowgraph doctor`, then `shadowgraph remember <JSON>`.'
  });
  const jsonPayload = JSON.parse(await readFile(jsonFile, 'utf8'));
  assert.equal(jsonPayload.revision, 1);

  const jsonDoctor = await runCli(['doctor'], jsonEnv);
  assert.equal(jsonDoctor.code, 0, jsonDoctor.stderr);
  assert.deepEqual(JSON.parse(jsonDoctor.stdout).storage, {
    type: 'json', path: resolve(jsonFile), initialized: true, readable: true, writable: true
  });
});

test('follow-up HTTP P1: real listener requires the exact loopback port before tokenless mutation or save', async (t) => {
  let durable = createShadowGraph({ now: () => FIXED_NOW }).exportData();
  let saveCalls = 0;
  const store = {
    async load() { return structuredClone(durable); },
    async save(payload) {
      saveCalls += 1;
      durable = structuredClone(payload);
      return (durable.revision ?? 0) + 1;
    },
    close() {}
  };
  const app = await createShadowGraphServer({ store, now: () => FIXED_NOW });
  t.after(() => closeServer(app.server));

  const requestedPort = 0;
  app.server.listen(requestedPort, '127.0.0.1');
  await once(app.server, 'listening');
  const localPort = app.server.address().port;
  assert.notEqual(localPort, requestedPort, 'port 0 must be resolved from the accepted socket, not treated as the authority');
  const base = `http://127.0.0.1:${localPort}`;

  const decisionBody = (id) => JSON.stringify({
    id, project: 'origin-boundary', title: id, chosen: 'persist only after authority validation'
  });
  const postDecision = (id, headers) => rawRequest(`${base}/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', ...headers },
    body: decisionBody(id)
  });

  const beforeWrongOrigin = app.graph.exportData();
  const durableBeforeWrongOrigin = structuredClone(durable);
  const wrongOrigin = await postDecision('wrong-origin-port-must-not-stick', {
    origin: `http://127.0.0.1:${alternatePort(localPort)}`
  });
  assertGenericForbidden(wrongOrigin, 'same loopback hostname on the wrong Origin port');
  assert.equal(saveCalls, 0, 'wrong-port tokenless simple POST must not save');
  assert.deepEqual(app.graph.exportData(), beforeWrongOrigin, 'wrong-port Origin must be rejected before live mutation');
  assert.deepEqual(durable, durableBeforeWrongOrigin, 'wrong-port Origin must not alter durable state');

  const exactOrigin = await postDecision('exact-origin-port-persists', { origin: base });
  assert.equal(exactOrigin.status, 200, exactOrigin.body);
  assert.equal(JSON.parse(exactOrigin.body).id, 'exact-origin-port-persists');
  assert.equal(saveCalls, 1, 'the exact actual listener port must pass and persist');

  const beforeWrongHost = app.graph.exportData();
  const durableBeforeWrongHost = structuredClone(durable);
  const wrongHost = await postDecision('wrong-host-port-must-not-stick', {
    host: `127.0.0.1:${alternatePort(localPort)}`,
    origin: base
  });
  assertGenericForbidden(wrongHost, 'Host on the wrong listener port');
  assert.equal(saveCalls, 1, 'wrong Host port must not save');
  assert.deepEqual(app.graph.exportData(), beforeWrongHost, 'wrong Host port must be rejected before live mutation');
  assert.deepEqual(durable, durableBeforeWrongHost, 'wrong Host port must not alter durable state');

  const localhost = await postDecision('localhost-authority-persists', {
    host: `localhost:${localPort}`,
    origin: `http://localhost:${localPort}`
  });
  assert.equal(localhost.status, 200, localhost.body);

  const missingOrigin = await postDecision('non-browser-without-origin-persists', {});
  assert.equal(missingOrigin.status, 200, missingOrigin.body);
  assert.equal(saveCalls, 3, 'localhost and an absent Origin must remain supported');
  assert.deepEqual(
    app.graph.exportData().records.map((record) => record.id),
    ['exact-origin-port-persists', 'localhost-authority-persists', 'non-browser-without-origin-persists']
  );
});

test('follow-up HTTP P2: real IPv6 listener accepts only canonical loopback Host and exact Origin authority', async (t) => {
  let durable = createShadowGraph({ now: () => FIXED_NOW }).exportData();
  let saveCalls = 0;
  const store = {
    async load() { return structuredClone(durable); },
    async save(payload) {
      saveCalls += 1;
      durable = structuredClone(payload);
      return (durable.revision ?? 0) + 1;
    },
    close() {}
  };
  const app = await createShadowGraphServer({ store, now: () => FIXED_NOW });
  t.after(() => closeServer(app.server));

  app.server.listen(0, '::1');
  await once(app.server, 'listening');
  const localPort = app.server.address().port;
  const base = `http://[::1]:${localPort}`;
  const decisionBody = (id) => JSON.stringify({
    id, project: 'ipv6-origin-boundary', title: id, chosen: 'canonical IPv6 only'
  });
  const postDecision = (id, headers) => rawRequest(`${base}/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', ...headers },
    body: decisionBody(id)
  });

  const canonical = await postDecision('canonical-ipv6-persists', { origin: base });
  assert.equal(canonical.status, 200, canonical.body);
  assert.equal(JSON.parse(canonical.body).id, 'canonical-ipv6-persists');
  assert.equal(saveCalls, 1);

  const invalidOrigins = [
    ['alternate IPv6 address', `http://[::2]:${localPort}`],
    ['non-canonical expanded IPv6 loopback', `http://[0:0:0:0:0:0:0:1]:${localPort}`],
    ['wrong IPv6 Origin port', `http://[::1]:${alternatePort(localPort)}`],
    ['credentials', `http://user:password@[::1]:${localPort}`],
    ['HTTPS scheme', `https://[::1]:${localPort}`],
    ['path-bearing malformed Origin', `${base}/not-an-origin`],
    ['opaque Origin', 'null'],
    ['empty present Origin', ''],
    ['unterminated IPv6 Origin', 'http://[::1']
  ];
  for (const [label, origin] of invalidOrigins) {
    const before = app.graph.exportData();
    const durableBefore = structuredClone(durable);
    const denied = await postDecision(`invalid-origin-${label}`, { origin });
    assertGenericForbidden(denied, label);
    assert.equal(saveCalls, 1, `${label}: invalid present Origin must not save`);
    assert.deepEqual(app.graph.exportData(), before, `${label}: invalid present Origin must precede mutation`);
    assert.deepEqual(durable, durableBefore, `${label}: invalid present Origin must not alter durable state`);
  }

  const invalidHosts = [
    ['alternate IPv6 Host', `[::2]:${localPort}`],
    ['non-canonical expanded IPv6 Host', `[0:0:0:0:0:0:0:1]:${localPort}`],
    ['wrong IPv6 Host port', `[::1]:${alternatePort(localPort)}`],
    ['credential-bearing Host', `user:password@[::1]:${localPort}`],
    ['scheme-bearing Host', `http://[::1]:${localPort}`]
  ];
  for (const [label, host] of invalidHosts) {
    const denied = await postDecision(`invalid-host-${label}`, { host, origin: base });
    assertGenericForbidden(denied, label);
    assert.equal(saveCalls, 1, `${label}: invalid Host must not save`);
  }
});

test('follow-up HTTP: recovery paths stay behind local host/origin and bearer boundaries', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-followup-http-');
  const sensitiveDirectory = join(directory, 'classified-client-recovery-DO-NOT-LEAK');
  const destination = join(sensitiveDirectory, 'private-live-state.json');
  const source = join(sensitiveDirectory, 'private-restore-source.json');
  await mkdir(sensitiveDirectory, { recursive: true });
  await writePayload(destination, graphPayload('followup-http-old', 'FOLLOWUP HTTP OLD'));
  await writePayload(source, graphPayload('followup-http-new', 'FOLLOWUP HTTP NEW'));

  const app = await createShadowGraphServer({
    file: destination,
    apiToken: API_TOKEN,
    now: () => FIXED_NOW,
    restoreFault: recoveryFailure
  });
  t.after(() => closeServer(app.server));
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const validOrigin = base;

  const restore = await fetch(`${base}/restore`, {
    method: 'POST',
    headers: adminHeaders(validOrigin, { 'content-type': 'application/json' }),
    body: JSON.stringify({ source })
  });
  const restoreDiagnostic = await restore.json();
  assert.equal(restore.status, 500);
  assert.equal(restoreDiagnostic.code, 'json_restore_recovery_unconfirmed');
  assert.equal(restoreDiagnostic.retainedArtifacts.length, 1);
  const [rollbackPath] = restoreDiagnostic.retainedArtifacts;
  assert.equal(await pathExists(rollbackPath), true, 'the recovery artifact must really exist');
  assert.equal(rollbackPath.includes(sensitiveDirectory), true);
  const sensitiveValues = [sensitiveDirectory, basename(sensitiveDirectory), rollbackPath, basename(rollbackPath), basename(destination)];

  const publicDashboard = await fetch(`${base}/dashboard`);
  assert.equal(publicDashboard.status, 200, 'static dashboard remains intentionally public');
  const publicDashboardHtml = await publicDashboard.text();
  assert.match(publicDashboardHtml, /ShadowGraph Dashboard/);
  assertNoRecoveryDisclosure(publicDashboardHtml, sensitiveValues);

  const wrongTokenDashboard = await fetch(`${base}/dashboard`, {
    headers: { authorization: 'Bearer definitely-the-wrong-token' }
  });
  assert.equal(wrongTokenDashboard.status, 200, 'static dashboard does not consume the API token');
  assertNoRecoveryDisclosure(await wrongTokenDashboard.text(), sensitiveValues);

  const invalidOrigin = `http://127.0.0.1:${port}.attacker.invalid`;
  const invalidOriginDashboard = await fetch(`${base}/dashboard`, { headers: { origin: invalidOrigin } });
  assert.equal(invalidOriginDashboard.status, 403);
  assert.equal(invalidOriginDashboard.headers.get('cache-control'), 'no-store');
  const invalidOriginDashboardText = await invalidOriginDashboard.text();
  assert.deepEqual(JSON.parse(invalidOriginDashboardText), { error: 'forbidden' });
  assertNoRecoveryDisclosure(invalidOriginDashboardText, sensitiveValues);

  const invalidHostDashboard = await rawGet(`${base}/dashboard`, adminHeaders(validOrigin, { host: 'attacker.invalid' }));
  assertGenericForbidden(invalidHostDashboard, 'invalid Host before dashboard');
  assertNoRecoveryDisclosure(invalidHostDashboard.body, sensitiveValues);

  const opaqueCases = [
    ['unauthenticated health', '/health', {}, 401, 'authentication required'],
    ['wrong-token health', '/health', { authorization: 'Bearer definitely-the-wrong-token', origin: validOrigin }, 401, 'authentication required'],
    ['invalid-origin before health authentication', '/health', { origin: invalidOrigin }, 403, 'forbidden'],
    ['invalid-host health', '/health', adminHeaders(validOrigin, { host: 'attacker.invalid' }), 403, 'forbidden'],
    ['unauthenticated degraded diagnostics', '/records', {}, 401, 'authentication required'],
    ['wrong-token degraded diagnostics', '/records', { authorization: 'Bearer definitely-the-wrong-token', origin: validOrigin }, 401, 'authentication required'],
    ['invalid-origin before degraded diagnostics authentication', '/records', { origin: invalidOrigin }, 403, 'forbidden'],
    ['invalid-host degraded diagnostics', '/records', adminHeaders(validOrigin, { host: 'attacker.invalid' }), 403, 'forbidden']
  ];
  for (const [label, path, headers, expectedStatus, expectedError] of opaqueCases) {
    const invalidHost = headers.host === 'attacker.invalid';
    const response = invalidHost
      ? await rawGet(`${base}${path}`, headers)
      : await fetch(`${base}${path}`, { headers });
    const text = invalidHost ? response.body : await response.text();
    assert.equal(response.status, expectedStatus, label);
    if (expectedStatus === 403) {
      const cacheControl = invalidHost ? response.headers['cache-control'] : response.headers.get('cache-control');
      assert.equal(cacheControl, 'no-store', `${label}: denial must not be cached`);
    }
    assert.deepEqual(JSON.parse(text), { error: expectedError }, label);
    assertNoRecoveryDisclosure(text, sensitiveValues);
  }

  const authorizedHealth = await fetch(`${base}/health`, { headers: adminHeaders(validOrigin) });
  const health = await authorizedHealth.json();
  assert.equal(authorizedHealth.status, 200);
  assert.equal(health.status, 'degraded');
  assert.equal(health.recoveryCode, 'json_restore_recovery_unconfirmed');
  assert.deepEqual(health.retainedArtifacts, [rollbackPath]);

  const authorizedHealthWithoutOrigin = await fetch(`${base}/health`, {
    headers: { authorization: `Bearer ${API_TOKEN}` }
  });
  assert.equal(authorizedHealthWithoutOrigin.status, 200, 'non-browser clients may omit Origin');
  assert.deepEqual(await authorizedHealthWithoutOrigin.json(), health);

  const authorizedDiagnostics = await fetch(`${base}/records`, { headers: adminHeaders(validOrigin) });
  const diagnostics = await authorizedDiagnostics.json();
  assert.equal(authorizedDiagnostics.status, 503);
  assert.equal(diagnostics.code, 'persistence_unavailable');
  assert.equal(diagnostics.recoveryCode, 'json_restore_recovery_unconfirmed');
  assert.deepEqual(diagnostics.retainedArtifacts, [rollbackPath]);
});
