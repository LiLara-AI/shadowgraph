import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { workerSettlement } from '../src/internal/extraction-state.js';
const moduleUrl = new URL('../src/internal/extraction-supervision.js', import.meta.url).href;
async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(25); }
  throw new Error('synthetic supervisor deadline exceeded');
}
test('supervisor: result and local exit proof are available before completion', async t => {
  const root = await scratchDirectory(t), env = { ...process.env, SHADOWGRAPH_HOME: root };
  const { runSupervised } = await import(moduleUrl);
  const out = await runSupervised({ executable: process.execPath, args: ['-e', 'process.stdout.write("fixture-result")'], cwd: root, env: process.env, input: '', timeoutMs: 2000, maxOutputBytes: 100 }, { env, activationId: 'synthetic-activation' });
  assert.equal(out.stdout, 'fixture-result'); assert.equal(out.localChildStopped, true);
  assert.equal(await workerSettlement(env), 'clear');
});
test('supervisor: killing the parent worker stops its real child and permits recovery without PID killing', async t => {
  const root = await scratchDirectory(t), env = { ...process.env, SHADOWGRAPH_HOME: root }, ready = join(root, 'child-ready.json');
  const request = { executable: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`], cwd: root, env, input: '', timeoutMs: 10000, maxOutputBytes: 100 };
  const code = `import {runSupervised} from ${JSON.stringify(moduleUrl)}; await runSupervised(${JSON.stringify(request)},{env:process.env,activationId:'synthetic-activation'});`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; parent.stderr.on('data', b => { error += b; }); t.after(() => parent.kill('SIGKILL'));
  const child = await until(() => readFile(ready, 'utf8').then(JSON.parse, () => null)).catch(cause => { throw new Error(`${cause.message}: ${error}`); });
  assert.equal(await workerSettlement(env), 'unconfirmed');
  const exited = new Promise(resolve => parent.once('close', resolve)); parent.kill('SIGKILL'); await exited;
  t.after(() => until(async () => await workerSettlement(env) === 'clear', 15000).catch(() => {}));
  await until(async () => await workerSettlement(env) === 'clear').catch(() => {});
  assert.equal(await workerSettlement(env), 'clear', 'parent death must produce timely child shutdown proof');
  assert.throws(() => process.kill(child.pid, 0));
  const marker = JSON.parse(await readFile(join(root, 'extraction-worker')));
  assert.equal(marker.state, 'running'); // Receipt, not forged parent success, proves settlement.
  const receipt = await readFile(join(root, 'extraction-worker.settlement.json'), 'utf8');
  assert.doesNotMatch(receipt, /fixture-result|child-ready|setInterval|stdout/);
});
test('supervisor: a mismatched proof cannot clear an unconfirmed execution', async t => {
  const root = await scratchDirectory(t), env = { SHADOWGRAPH_HOME: root };
  await writeFile(join(root, 'extraction-worker'), JSON.stringify({ version: 1, state: 'running', invocationId: 'one' }));
  await writeFile(join(root, 'extraction-worker.settlement.json'), JSON.stringify({ version: 1, invocationId: 'different', localChildStopped: true }));
  assert.equal(await workerSettlement(env), 'unconfirmed');
  await writeFile(join(root, 'extraction-worker.settlement.json'), JSON.stringify({ version: 1, invocationId: 'one', localChildStopped: false }));
  assert.equal(await workerSettlement(env), 'unconfirmed');
  await writeFile(join(root, 'extraction-worker.settlement.json'), JSON.stringify({ version: 1, invocationId: 'one', localChildStopped: true }));
  assert.equal(await workerSettlement(env), 'clear');
});


test('supervisor: parent death after running marker but before request leaves recoverable no-child proof', async t => {
  const root = await scratchDirectory(t), env = { ...process.env, SHADOWGRAPH_HOME: root };
  const invocationId = '2f31eb4a-2f83-4b60-a2ee-e11034171141', proof = join(root, 'extraction-worker.settlement.json');
  const childUrl = new URL('../src/internal/extraction-child.js', import.meta.url).href;
  const code = `import {fork} from 'node:child_process';import {writeFile} from 'node:fs/promises';const child=fork(new URL(${JSON.stringify(childUrl)}),${JSON.stringify([invocationId, proof])},{execArgv:[],detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});child.on('message',async m=>{if(m.ready){await writeFile(${JSON.stringify(join(root, 'extraction-worker'))},JSON.stringify({version:1,state:'running',invocationId:${JSON.stringify(invocationId)}}));process.stdout.write('marked');}});setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let marked = false; parent.stdout.on('data', () => { marked = true; }); t.after(() => parent.kill('SIGKILL'));
  await until(() => marked);
  const exited = new Promise(resolve => parent.once('close', resolve)); parent.kill('SIGKILL'); await exited;
  for (let i = 0; i < 100 && await workerSettlement(env) !== 'clear'; i++) await delay(25);
  assert.equal(await workerSettlement(env), 'clear', 'no host request was sent; bootstrap identity must still yield matching proof');
  assert.equal(JSON.parse(await readFile(proof)).invocationId, invocationId);
});
