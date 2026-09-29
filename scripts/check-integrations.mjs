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

// The Claude Code hook block (plan §18.1, §20.6): command handlers at
// SessionStart and UserPromptSubmit only, each running the inert-until-activated
// delivery verb with a timeout, and no other key (no async, no marker).
const hookTemplate = JSON.parse(await readFile(join(integrations, 'claude-code.hooks.json'), 'utf8'));
assert.deepEqual(Object.keys(hookTemplate), ['hooks'], 'claude-code.hooks.json holds only a hooks block');
assert.deepEqual(Object.keys(hookTemplate.hooks).sort(), ['SessionStart', 'UserPromptSubmit'], 'hooks only at SessionStart and UserPromptSubmit');
for (const [event, groups] of Object.entries(hookTemplate.hooks)) {
  assert.ok(Array.isArray(groups) && groups.length === 1, `${event} holds one group`);
  assert.deepEqual(Object.keys(groups[0]), ['hooks'], `${event} group has no matcher or other key`);
  assert.ok(Array.isArray(groups[0].hooks) && groups[0].hooks.length === 1, `${event} holds one handler`);
  const [handler] = groups[0].hooks;
  assert.deepEqual(Object.keys(handler).sort(), ['command', 'timeout', 'type'], `${event} handler keys`);
  assert.equal(handler.type, 'command', `${event} handler is a command`);
  assert.equal(handler.command, 'shadowgraph deliver --hook', `${event} handler runs the delivery verb`);
  assert.ok(Number.isInteger(handler.timeout) && handler.timeout > 0, `${event} handler has a timeout`);
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

console.log('integration templates valid: Claude Code=stdio JSON and SessionStart/UserPromptSubmit command hooks, Cursor=stdio JSON, Codex=config.toml, Hermes=config.yaml; compact recommended, full mode preserved');
