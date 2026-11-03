import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const revisions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const profiles = [
  { name: 'full', env: {}, count: 35 },
  { name: 'compact', env: { SHADOWGRAPH_MCP_COMPACT: '1' }, count: 16 },
  { name: 'workflow', env: { SHADOWGRAPH_MCP_PROFILE: 'workflow' }, count: 20 }
];

// Catches a real client boundary: legacy clients must receive the server guide,
// not only per-request discovery clients. Discovery/handshakes must not save data.
for (const profile of profiles) test(`${profile.name}: handshake clients receive discovery guidance without a store write`, async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-client-guidance-');
  const file = join(directory, 'data.json');
  const home = join(directory, 'home');
  mkdirSync(home);
  const snapshot = JSON.stringify(privilegedSnapshot(createShadowGraph({ now: () => '2030-01-01T00:00:00.000Z' })));
  writeFileSync(file, snapshot);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SHADOWGRAPH_')));
  const requests = [
    { jsonrpc: '2.0', id: 'discovery', method: 'server/discover', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'client-guidance-test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {}
    } } },
    ...revisions.map((protocolVersion) => ({ jsonrpc: '2.0', id: protocolVersion, method: 'initialize', params: {
      protocolVersion, capabilities: {}, clientInfo: { name: 'client-guidance-test', version: '1' }
    } })),
    { jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: {} }
  ];
  const child = spawnSync(process.execPath, [join(process.cwd(), 'src/mcp.js')], {
    cwd: directory,
    env: { ...env, SHADOWGRAPH_HOME: home, SHADOWGRAPH_FILE: file, ...profile.env },
    input: requests.map((request) => JSON.stringify(request)).join('\n') + '\n',
    encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const replies = new Map(child.stdout.trim().split('\n').map((line) => {
    const value = JSON.parse(line); assert.equal(value.error, undefined, line); return [value.id, value.result];
  }));
  assert.equal(replies.size, 6);
  const discovered = replies.get('discovery');
  assert.equal(typeof discovered.instructions, 'string');
  assert.ok(discovered.instructions.trim().length > 0);
  for (const revision of revisions) {
    const initialized = replies.get(revision);
    assert.equal(initialized.protocolVersion, revision);
    assert.equal(typeof initialized.instructions, 'string', `${revision} handshake omitted server guidance`);
    assert.equal(initialized.instructions, discovered.instructions, `${revision} exposes stale or different guidance`);
  }
  assert.equal(replies.get('tools').tools.length, profile.count);
  assert.equal(readFileSync(file, 'utf8'), snapshot, 'discovery and initialization must not commit a store revision');
});
