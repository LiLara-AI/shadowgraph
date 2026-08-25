import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('compact MCP advertises a smaller tool surface', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-compact-'));
  const child = spawn(process.execPath, ['src/mcp.js'], { env: { ...process.env, SHADOWGRAPH_MCP_COMPACT: '1', SHADOWGRAPH_FILE: join(dir, 'data.json') }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = '';
  const response = new Promise((resolve) => child.stdout.on('data', (chunk) => { buffer += chunk; const line = buffer.split('\n')[0]; if (line) resolve(JSON.parse(line)); }));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const result = await response; child.kill(); assert.equal(result.result.tools.length, 10); assert.ok(result.result.tools.some((tool) => tool.name === 'shadowgraph_context'));
});
