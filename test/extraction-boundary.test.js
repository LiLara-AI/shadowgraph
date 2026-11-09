import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';

async function imports() {
  const edges = new Map();
  for (const directory of ['', 'internal/']) for (const name of await readdir(new URL('../src/' + directory, import.meta.url))) {
    if (!name.endsWith('.js')) continue;
    const file = directory + name, code = await readFile(new URL('../src/' + file, import.meta.url), 'utf8');
    const paths = [...code.matchAll(/(?:from\s+|import\s*\()['"](\.[^'"]+\.js)['"]/gu)].map(m => posix.normalize(posix.join(dirname(file).replaceAll('\\', '/'), m[1])));
    edges.set(file, paths);
  }
  return edges;
}
test('extraction boundary: only explicit CLI owns the controller; agent and hook paths cannot reach it transitively', async () => {
  const edges = await imports();
  for (const [file, targets] of edges) {
    if (targets.includes('extraction-runtime.js')) assert.equal(file, 'cli.js', `${file}: unauthorized controller import`);
    if (targets.includes('internal/extraction-trigger.js')) assert.equal(file, 'capture-worker.js', `${file}: unauthorized detached trigger`);
  }
  for (const entry of ['mcp.js', 'mcp-tools.js', 'server.js', 'delivery.js', 'delivery-worker.js', 'capture-hook.js', 'capture-worker.js']) {
    const seen = new Set(), visit = file => {
      if (seen.has(file)) return; seen.add(file);
      assert.ok(!['extraction-runtime.js', 'internal/extraction-worker.js'].includes(file), `${entry} reaches ${file}`);
      for (const target of edges.get(file) ?? []) visit(target);
    };
    visit(entry);
  }
});
