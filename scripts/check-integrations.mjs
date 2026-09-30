import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DELIVERY_DEADLINE_MS } from '../src/delivery.js';
import { CAPTURE_DEADLINE_MS, CAPTURE_HARD_CAP_MS } from '../src/capture-hook.js';

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
  assert.ok(DELIVERY_DEADLINE_MS < handler.timeout * 1000, `${event}: the delivery deadline stays below the hook timeout`);
}

// The coverage manifest (plan §18.3; AC-061, AC-064): the host and its exact
// version, the same-turn gap declared, every trigger placing all seven stages,
// the hook's events covered, and at least one trigger uncovered.
const coverage = JSON.parse(await readFile(join(integrations, 'claude-code.coverage.json'), 'utf8'));
const STAGES = ['sourceCapture', 'extractionReadiness', 'storedExperience', 'modelVisibleDelivery', 'pendingUnprocessed', 'correctedExperience', 'replayProtection'];
assert.equal(coverage.host, 'claude-code', 'the coverage manifest names its host');
assert.match(coverage.verifiedVersion ?? '', /^\d+\.\d+\.\d+$/u, 'the coverage manifest names the exact verified version');
assert.ok(typeof coverage.sameTurnGap === 'string' && coverage.sameTurnGap.trim(), 'the coverage manifest declares the same-turn gap');
assert.deepEqual(coverage.stages, STAGES, 'the coverage manifest lists the seven stages');
assert.ok(Array.isArray(coverage.triggers) && coverage.triggers.length > 0, 'the coverage manifest has triggers');
for (const row of coverage.triggers) {
  assert.ok(['covered', 'unverified', 'uncovered'].includes(row.status), `${row.trigger}: a known status`);
  assert.deepEqual(Object.keys(row.stages ?? {}).sort(), [...STAGES].sort(), `${row.trigger}: every stage placed`);
  assert.ok(Object.values(row.stages).every((place) => typeof place === 'string' && place.trim()), `${row.trigger}: every stage described`);
}
for (const event of Object.keys(hookTemplate.hooks)) assert.equal(coverage.triggers.find((row) => row.trigger === event)?.status, 'covered', `${event} is covered`);
assert.ok(coverage.triggers.some((row) => row.status === 'uncovered'), 'at least one trigger is declared uncovered');

// The capture hook block (plan §12.1; PR-36 design review D-1): synchronous
// command handlers -- no async key, so a capture's output never reaches the
// model and no event is deduplicated away -- at the four events with
// immediate material, each running the inert-until-activated capture verb
// with a timeout its deadline and hard cap stay below.
const captureTemplate = JSON.parse(await readFile(join(integrations, 'claude-code.capture-hooks.json'), 'utf8'));
const CAPTURED = ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
assert.deepEqual(Object.keys(captureTemplate), ['hooks'], 'claude-code.capture-hooks.json holds only a hooks block');
assert.deepEqual(Object.keys(captureTemplate.hooks), CAPTURED, 'capture hooks at the four events with immediate material');
for (const [event, groups] of Object.entries(captureTemplate.hooks)) {
  assert.ok(Array.isArray(groups) && groups.length === 1, `${event} holds one capture group`);
  assert.deepEqual(Object.keys(groups[0]), ['hooks'], `${event} capture group has no matcher or other key`);
  assert.ok(Array.isArray(groups[0].hooks) && groups[0].hooks.length === 1, `${event} holds one capture handler`);
  const [handler] = groups[0].hooks;
  assert.deepEqual(Object.keys(handler).sort(), ['command', 'timeout', 'type'], `${event} capture handler keys (no async)`);
  assert.equal(handler.type, 'command', `${event} capture handler is a command`);
  assert.equal(handler.command, 'shadowgraph capture --hook', `${event} capture handler runs the capture verb`);
  assert.ok(Number.isInteger(handler.timeout) && CAPTURE_DEADLINE_MS < CAPTURE_HARD_CAP_MS && CAPTURE_HARD_CAP_MS < handler.timeout * 1000, `${event}: the capture deadline and hard cap stay below the hook timeout`);
}
assert.ok(manifest.files.includes('integrations/claude-code.capture-hooks.json'), 'the package ships the capture hook template: a pinned runtime\'s capture capability');

// What capture covers (plan §12.2.2): per event its material, identity and
// whether that identity is exact; what is never captured; and what is declared.
const captured = coverage.capture;
assert.deepEqual(captured?.handler, { type: 'command', command: 'shadowgraph capture --hook', events: CAPTURED, synchronous: true }, 'the manifest names the capture handler');
assert.ok(typeof captured.hostFields === 'string' && captured.hostFields.trim(), 'the manifest says how the host fields are known');
assert.deepEqual(captured.events.map((row) => row.event), CAPTURED, 'the manifest describes each captured event');
for (const row of captured.events) {
  assert.deepEqual(Object.keys(row).sort(), ['event', 'exact', 'identity', 'material', 'observation'], `${row.event}: capture row keys`);
  assert.equal(typeof row.exact, 'boolean', `${row.event}: whether its identity is exact`);
}
for (const list of ['neverCaptured', 'declarations']) assert.ok(Array.isArray(captured[list]) && captured[list].length > 0 && captured[list].every((line) => typeof line === 'string' && line.trim()), `the manifest lists ${list}`);

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

console.log('integration templates valid: Claude Code=stdio JSON, SessionStart/UserPromptSubmit command hooks, the capture hooks and the coverage manifest, Cursor=stdio JSON, Codex=config.toml, Hermes=config.yaml; compact recommended, full mode preserved');
