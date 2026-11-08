import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sharedPath = '/absolute/path/to/shared-shadowgraph/data.json';

test('copy-ready stdio templates pin one shared store placeholder', () => {
  for (const path of [
    'integrations/claude-code.mcp.json',
    'integrations/cursor.mcp.json',
    'integrations/codex.mcp.toml',
    'integrations/hermes.mcp.yaml'
  ]) {
    assert.ok(read(path).includes(sharedPath), `${path} must pin SHADOWGRAPH_FILE`);
  }
});

test('the failed-attempt demo declares its class, project, reason, and environment', () => {
  const demo = read('docs/decision-memory-demo.md');
  for (const fragment of [
    '"project":"checkout-service"',
    '"resultClass":"failed"',
    '"reason":"No shared transactional view"',
    '"environment":"Single-user local checkout prototype"'
  ]) assert.ok(demo.includes(fragment), `demo is missing ${fragment}`);
  assert.match(demo, /acknowledg\w* means seen, not resolved/i);
});

test('retry and scope guidance starts before the first write', () => {
  const policy = read('integrations/agent-policy.md');
  assert.match(policy, /before the first write/i);
  assert.match(policy, /same project and scope/i);
  assert.match(policy, /run-scoped memory does not automatically survive across runs/i);
});

test('current-facing compact guidance advertises 16 tools', () => {
  assert.match(read('integrations/README.md'), /SHADOWGRAPH_MCP_COMPACT=1`: 16 workflow tools/);
  assert.match(read('integrations/README.md'), /verifies 28 full and 16 compact tools/);
  assert.match(read('docs/unified-memory.md'), /Compact mode includes both workflows and remains exactly 16 tools\./);
  assert.match(read('docs/api-reference.md'), /SHADOWGRAPH_MCP_COMPACT=1` advertises 16 tools instead of 28\./);
  assert.match(read('.github/workflows/ci.yml'), /Strict MCP Inspector \(28 full \/ 16 compact\)/);
});

test('Phase 1A release notes disclose the compatibility boundary', () => {
  for (const path of ['CHANGELOG.md', 'RELEASE_NOTES.md']) {
    const document = read(path);
    const start = document.indexOf('## Unreleased');
    assert.notEqual(start, -1, `${path} needs an Unreleased entry`);
    const next = document.indexOf('\n## ', start + 1);
    const entry = document.slice(start, next === -1 ? undefined : next);
    assert.match(entry, /Phase 1A/);
    assert.match(entry, /16-tool compact/);
    assert.match(entry, /resultClass/);
    assert.match(entry, /CLI and JavaScript callers/);
    assert.match(entry, /older stored attempts/);
    assert.match(entry, /wording-based fallback/);
    assert.match(entry, /fact `value`/);
    assert.match(entry, /alternative `label`/);
    assert.ok(entry.includes('error.data'), `${path} must locate legacy error details`);
    assert.ok(entry.includes("result._meta['shadowgraph/error']"), `${path} must locate modern error details`);
  }
});

test('API reference limits required resultClass to new MCP attempt writes', () => {
  assert.match(
    read('docs/api-reference.md'),
    /New MCP attempt writes require `resultClass`; CLI and JavaScript callers and older stored attempts retain the wording-based fallback when it is absent\./
  );
});
