import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { createShadowGraphServer } from '../src/server.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { privilegedSnapshot, privilegedRebuild } from '../src/internal/snapshot.js';
import { readLedger } from '../src/internal/deletion-knowledge.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
const execute = promisify(execFile), cli = fileURLToPath(new URL('../src/cli.js', import.meta.url)), mcp = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
const now = () => '2026-10-04T00:00:00.000Z', sqlite = (await getRuntimeCapabilities()).nodeSqlite;
async function restoreMcp(file, source, env, cwd) {
  const child = spawn(process.execPath, [mcp], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let buffer = '', stderr = ''; const responses = [];
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', text => { stderr += text; });
  child.stdout.on('data', text => { buffer += text; const lines = buffer.split('\n'); buffer = lines.pop(); responses.push(...lines.filter(Boolean).map(line => JSON.parse(line))); });
  const call = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = responses.find(value => value.id === id); if (result) return result;
      if (child.exitCode !== null) throw new Error(`Synthetic MCP exited: ${stderr}`);
      await delay(10);
    }
    throw new Error(`Synthetic MCP timeout: ${stderr}`);
  };
  try {
    await call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} });
    const response = await call(2, 'tools/call', { name: 'shadowgraph_restore', arguments: { source } });
    assert.equal(response.result?.isError, undefined, JSON.stringify(response));
    return response.result.structuredContent;
  } finally { child.kill(); await exited; }
}
for (const type of ['json', 'sqlite']) for (const mode of ['logical', 'hard']) for (const entry of ['direct', 'cli', 'mcp', 'http']) {
  test(`${type} ${mode} origin registry reaches ${entry} restore and active reads without crossing project ownership`, type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
    const root = await scratchDirectory(t, 'pr43-origin-entry-'), file = join(root, 'source'), backup = join(root, 'backup'), destination = join(root, 'destination');
    const priorHome = process.env.SHADOWGRAPH_HOME; process.env.SHADOWGRAPH_HOME = join(root, 'home');
    t.after(() => { if (priorHome === undefined) delete process.env.SHADOWGRAPH_HOME; else process.env.SHADOWGRAPH_HOME = priorHome; });
    const env = { ...process.env, SHADOWGRAPH_FILE: destination, SHADOWGRAPH_STORAGE: type, SHADOWGRAPH_API_TOKEN: '', SHADOWGRAPH_MCP_COMPACT: '0', SHADOWGRAPH_EMBEDDING_URL: '', SHADOWGRAPH_VERIFIER_CONFIG: '' };
    const graph = createShadowGraph({ now });
    const removed = graph.addDecision({ originId: 'a', title: 'Removed origin', chosen: 'Remove' });
    const peer = graph.addDecision({ project: 'p', originId: 'a', title: 'Project peer', chosen: 'Keep' });
    const other = graph.addDecision({ originId: 'b', title: 'Other origin', chosen: 'Keep' });
    const store = await createStorage({ type, file, env });
    try {
      await store.save(privilegedSnapshot(graph)); await backupFile(file, backup, { store, env });
      const loaded = createShadowGraph({ now }); loaded.importData(await store.load()); loaded.purgeOrigin('a', { mode });
      await store.save(privilegedSnapshot(loaded));
    } finally { store.close(); }
    const backupBytes = await readFile(backup); let result;
    if (entry === 'direct') {
      if (type === 'json') result = await restoreFile(backup, destination, { env });
      else { const target = await createStorage({ type, file: destination, env }); try { result = await target.restore(backup); } finally { target.close(); } }
    } else if (entry === 'cli') result = JSON.parse((await execute(process.execPath, [cli, 'restore', backup], { env, cwd: root })).stdout);
    else if (entry === 'mcp') result = await restoreMcp(destination, backup, env, root);
    else {
      const target = await createStorage({ type, file: destination, env });
      const app = await createShadowGraphServer({ store: target, file: destination, storage: type, cwd: root, apiToken: '' });
      app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
      const url = `http://127.0.0.1:${app.server.address().port}`;
      try {
        const response = await fetch(url + '/restore', { method: 'POST', body: JSON.stringify({ source: backup }) });
        assert.equal(response.status, 200, await response.clone().text()); result = await response.json();
        const visible = await (await fetch(url + '/records?project=p')).text();
        assert.equal(visible.includes(removed.id), false); assert.ok(visible.includes(peer.id));
      } finally { await new Promise(resolve => app.server.close(resolve)); target.close(); }
    }
    assert.equal(result.deletionKnowledge, 'present');
    const check = await createStorage({ type, file: destination, env });
    try {
      const payload = await check.load();
      assert.equal(payload.records.some(value => value.id === removed.id), false);
      assert.deepEqual(payload.records.map(value => value.id).sort(), [peer.id, other.id].sort());
      assert.ok(payload.journal.some(value => value.type === 'restore.reapplied' && value.payload.mode === mode));
      assert.equal((await readLedger(destination)).pending.length, 0);
      const reopened = createShadowGraph({ now }); reopened.importData(payload);
      assert.deepEqual(privilegedRebuild(reopened).skipped, []);
    } finally { check.close(); }
    assert.deepEqual(await readFile(backup), backupBytes);
  });
}
