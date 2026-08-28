import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const integrations = join(root, 'integrations');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(manifest.bin?.shadowgraph, './src/cli.js', 'MCP templates require the installed `shadowgraph` binary');

for (const file of (await readdir(integrations)).filter((name) => name.endsWith('.json'))) {
  JSON.parse(await readFile(join(integrations, file), 'utf8'));
}

for (const file of ['claude-code.mcp.json', 'cursor.mcp.json']) {
  const config = JSON.parse(await readFile(join(integrations, file), 'utf8'));
  const server = config.mcpServers?.shadowgraph;
  assert.equal(server?.type, 'stdio', `${file} must declare stdio`);
  assert.equal(server?.command, 'shadowgraph', `${file} must launch the installed binary`);
  assert.deepEqual(server?.args, ['mcp'], `${file} must launch MCP mode`);
  assert.equal(server?.env?.SHADOWGRAPH_MCP_COMPACT, '1', `${file} must recommend compact mode`);
}

const codex = await readFile(join(integrations, 'codex.mcp.toml'), 'utf8');
for (const expected of [
  '[mcp_servers.shadowgraph]',
  'command = "shadowgraph"',
  'args = ["mcp"]',
  '[mcp_servers.shadowgraph.env]',
  'SHADOWGRAPH_MCP_COMPACT = "1"'
]) assert.ok(codex.includes(expected), `Codex TOML is missing ${expected}`);

const hermes = await readFile(join(integrations, 'hermes.mcp.yaml'), 'utf8');
for (const expected of [
  'mcp_servers:',
  '  shadowgraph:',
  '    command: "shadowgraph"',
  '    args: ["mcp"]',
  '      SHADOWGRAPH_MCP_COMPACT: "1"'
]) assert.ok(hermes.includes(expected), `Hermes YAML is missing ${expected}`);

console.log('integration templates valid: Claude Code=stdio JSON, Cursor=stdio JSON, Codex=config.toml, Hermes=config.yaml; compact recommended, full mode preserved');
