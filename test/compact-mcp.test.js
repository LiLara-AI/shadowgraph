import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';

test('compact MCP advertises the workflow surface including remember and recall', { timeout: 10_000 }, async (t) => {
  const dir = await scratchDirectory(t, 'shadowgraph-compact-');
  const child = spawn(process.execPath, ['src/mcp.js'], { env: { ...process.env, SHADOWGRAPH_MCP_COMPACT: '1', SHADOWGRAPH_FILE: join(dir, 'data.json') }, stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = once(child, 'close');
  t.after(async () => { child.stdin.end(); child.kill(); await closed; });
  // Pipe chunks are not JSON messages. Fragment real server output even when
  // the operating system happens to deliver the whole response in one chunk.
  const output = child.stdout.pipe(new Transform({
    transform(chunk, encoding, callback) {
      for (let offset = 0; offset < chunk.length; offset += 31) this.push(chunk.subarray(offset, offset + 31));
      callback();
    }
  }));
  const lines = createInterface({ input: output, crlfDelay: Infinity });
  const response = once(lines, 'line').then(([line]) => JSON.parse(line));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const result = await response;
  assert.equal(result.result.tools.length, 16);
  assert.ok(result.result.tools.some((tool) => tool.name === 'shadowgraph_context'));
  assert.ok(result.result.tools.some((tool) => tool.name === 'shadowgraph_remember'));
  assert.ok(result.result.tools.some((tool) => tool.name === 'shadowgraph_recall'));
});
