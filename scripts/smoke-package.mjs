import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'shadowgraph clean install '));
const packDirectory = join(temporaryRoot, 'packed artifacts');
const appDirectory = join(temporaryRoot, 'clean consumer app');
const npmCli = process.env.npm_execpath;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runNpm(args, options = {}) {
  return npmCli
    ? exec(process.execPath, [npmCli, ...args], { maxBuffer: 10 * 1024 * 1024, ...options })
    : exec(npmCommand, args, { maxBuffer: 10 * 1024 * 1024, ...options });
}

function runInstalledCli(cliPath, args, options = {}) {
  return exec(process.execPath, [cliPath, ...args], {
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
}


async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function rpc(cliPath, env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'mcp'], {
      cwd: appDirectory,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const responses = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Installed MCP timed out: ${stderr || stdout}`));
    }, 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { responses.push(JSON.parse(line)); }
        catch (error) {
          clearTimeout(timer);
          child.kill();
          reject(new Error(`Installed MCP emitted invalid JSON: ${line}; ${error.message}`));
          return;
        }
      }
      if (responses.length >= requests.length) {
        clearTimeout(timer);
        child.kill();
        resolve(responses);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      if (responses.length < requests.length && code !== null) {
        clearTimeout(timer);
        reject(new Error(`Installed MCP exited ${code}: ${stderr || stdout}`));
      }
    });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Installed server did not start: ${stderr || stdout}`)), 10_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (/ShadowGraph listening on/.test(stdout)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      if (code !== null) {
        clearTimeout(timer);
        reject(new Error(`Installed server exited ${code}: ${stderr || stdout}`));
      }
    });
  });
}

let summary;
try {
  await mkdir(packDirectory, { recursive: true });
  await mkdir(appDirectory, { recursive: true });
  const packed = JSON.parse((await runNpm([
    'pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory
  ], { cwd: packageRoot })).stdout);
  assert.equal(packed.length, 1);
  const tarball = join(packDirectory, packed[0].filename);
  await access(tarball);

  await runNpm(['init', '--yes'], { cwd: appDirectory });
  await runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: appDirectory });

  const installedRoot = join(appDirectory, 'node_modules', manifest.name);
  const installedCli = join(installedRoot, 'src', 'cli.js');
  const installedBin = join(appDirectory, 'node_modules', '.bin', process.platform === 'win32' ? 'shadowgraph.cmd' : 'shadowgraph');
  const installedManifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installedManifest.name, manifest.name);
  assert.equal(installedManifest.version, manifest.version);
  await access(installedCli);
  await access(installedBin);

  const dataFile = join(appDirectory, 'state with spaces', 'data.json');
  const cliEnv = { ...process.env, SHADOWGRAPH_FILE: dataFile };
  const setup = JSON.parse((await runNpm(['exec', '--', 'shadowgraph', 'setup'], { cwd: appDirectory, env: cliEnv })).stdout);
  assert.equal(setup.ok, true);
  assert.equal(setup.created, true);
  const doctor = JSON.parse((await runNpm(['exec', '--', 'shadowgraph', 'doctor'], { cwd: appDirectory, env: cliEnv })).stdout);
  assert.equal(doctor.ok, true);

  const memoryInput = {
    project: 'beta-demo',
    scope: { userId: 'alice' },
    memoryType: 'preference',
    key: 'editor',
    text: 'Alice prefers VS Code'
  };
  const remembered = JSON.parse((await runInstalledCli(installedCli, ['remember', JSON.stringify(memoryInput)], { cwd: appDirectory, env: cliEnv })).stdout);
  assert.equal(remembered.operation, 'ADD');
  const recalledAfterRestart = JSON.parse((await runInstalledCli(installedCli, ['recall', JSON.stringify({
    project: 'beta-demo', scope: { userId: 'alice' }, query: 'editor preference'
  })], { cwd: appDirectory, env: cliEnv })).stdout);
  assert.equal(recalledAfterRestart.items[0].record.text, memoryInput.text);

  const decision = JSON.parse((await runInstalledCli(installedCli, ['decision', JSON.stringify({
    project: 'beta-demo',
    title: 'Choose deployment database',
    chosen: 'SQLite',
    alternatives: [{
      label: 'PostgreSQL',
      reasonRejected: 'Single-user deployment',
      reopenWhen: [{ key: 'deployment', operator: 'equals', value: 'multi-user' }]
    }]
  })], { cwd: appDirectory, env: cliEnv })).stdout);
  await runInstalledCli(installedCli, ['fact', JSON.stringify({
    project: 'beta-demo', key: 'deployment', value: 'single-user', sourceClass: 'human_confirmed'
  })], { cwd: appDirectory, env: cliEnv });
  await runInstalledCli(installedCli, ['fact', JSON.stringify({
    project: 'beta-demo', key: 'deployment', value: 'multi-user', sourceClass: 'human_confirmed'
  })], { cwd: appDirectory, env: cliEnv });
  const reviewAfterRestart = JSON.parse((await runInstalledCli(installedCli, ['review', JSON.stringify({ project: 'beta-demo' })], { cwd: appDirectory, env: cliEnv })).stdout);
  assert.equal(reviewAfterRestart.some((item) => item.decisionId === decision.id), true);

  const fullFile = join(appDirectory, 'mcp full', 'data.json');
  const [fullList] = await rpc(installedCli, { SHADOWGRAPH_FILE: fullFile, SHADOWGRAPH_MCP_COMPACT: '0' }, [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  ]);
  assert.equal(fullList.result.tools.length, 27);
  const compactFile = join(appDirectory, 'mcp compact', 'data.json');
  const [compactList] = await rpc(installedCli, { SHADOWGRAPH_FILE: compactFile, SHADOWGRAPH_MCP_COMPACT: '1' }, [
    { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  ]);
  assert.equal(compactList.result.tools.length, 12);
  const [mcpRemember] = await rpc(installedCli, { SHADOWGRAPH_FILE: compactFile, SHADOWGRAPH_MCP_COMPACT: '1' }, [
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shadowgraph_remember', arguments: {
      project: 'mcp-demo', memoryType: 'note', key: 'package', text: 'Loaded from installed tarball'
    } } }
  ]);
  assert.equal(JSON.parse(mcpRemember.result.content[0].text).operation, 'ADD');
  const [mcpRecall] = await rpc(installedCli, { SHADOWGRAPH_FILE: compactFile, SHADOWGRAPH_MCP_COMPACT: '1' }, [
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'shadowgraph_recall', arguments: {
      project: 'mcp-demo', query: 'installed package'
    } } }
  ]);
  assert.equal(JSON.parse(mcpRecall.result.content[0].text).items[0].record.key, 'package');

  const port = await freePort();
  const token = 'public-beta-smoke-token';
  const server = spawn(process.execPath, [installedCli, 'serve'], {
    cwd: appDirectory,
    env: {
      ...process.env,
      PORT: String(port),
      SHADOWGRAPH_FILE: join(appDirectory, 'http state', 'data.json'),
      SHADOWGRAPH_API_TOKEN: token
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  try {
    await waitForServer(server);
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/dashboard`)).status, 200);
    assert.equal((await fetch(`${base}/health`)).status, 401);
    const health = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.deepEqual({ ok: healthBody.ok, version: healthBody.version }, { ok: true, version: manifest.version });
  } finally {
    server.kill();
    await once(server, 'exit').catch(() => {});
  }

  const packageFiles = packed[0].files.map((item) => item.path);
  summary = {
    package: `${manifest.name}@${manifest.version}`,
    runtimeNode: process.version,
    doctorNode: doctor.node.version,
    tarballFiles: packageFiles.length,
    cleanDirectoryContainedSpaces: /\s/.test(appDirectory),
    installedPackage: true,
    cliSetupDoctor: true,
    cliRememberRestartRecall: true,
    changedFactReviewAfterRestart: true,
    mcpFullTools: fullList.result.tools.length,
    mcpCompactTools: compactList.result.tools.length,
    mcpRememberRestartRecall: true,
    httpHealthAndDashboard: true
  };
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(`clean-install smoke passed: ${JSON.stringify(summary)}`);
console.log('clean-install smoke cleanup passed: temporary tarball, install, state, and caches removed');
