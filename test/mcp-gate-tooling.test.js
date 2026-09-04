import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
}

test('external MCP gate clients are reproducibly locked outside the product package', async () => {
  const manifest = await readJson('../tooling/mcp-gates/package.json');
  const lock = await readJson('../tooling/mcp-gates/package-lock.json');

  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.dependencies, {
    '@modelcontextprotocol/inspector': '2.4.0',
    'mcp-proxy': '6.4.3'
  });
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.equal(lock.packages['node_modules/@modelcontextprotocol/inspector'].version, '2.4.0');
  assert.equal(lock.packages['node_modules/mcp-proxy'].version, '6.4.3');
});

test('the MCP gates and Node 24 CI consume the locked local clients', async () => {
  const [inspectorGate, glamaGate, workflow] = await Promise.all([
    readFile(new URL('../scripts/check-mcp.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/check-glama-proxy.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  ]);

  assert.match(inspectorGate, /tooling['"], ['"]mcp-gates['"].+@modelcontextprotocol['"].+inspector/su);
  assert.match(glamaGate, /tooling['"], ['"]mcp-gates['"].+mcp-proxy/su);
  assert.match(workflow, /if: matrix\.node-version == 24[\s\S]+run: npm ci --prefix tooling\/mcp-gates/u);
});
