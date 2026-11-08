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
