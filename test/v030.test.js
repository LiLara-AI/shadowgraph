import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createShadowGraph } from '../src/shadowgraph.js';
import { backupFile, restoreFile } from '../src/backup.js';

test('normalizes common MCP aliases for rejection reasons and human sources', () => {
  const graph = createShadowGraph();
  const decision = graph.addDecision({ title: 'Alias test', chosen: 'A', alternatives: [{ label: 'B', reason: 'not suitable' }] });
  assert.equal(decision.alternatives[0].reasonRejected, 'not suitable');
  const fact = graph.addFact({ key: 'reviewed', value: true, source: 'human-confirmed' });
  assert.equal(fact.source, 'human_confirmed');
  // UPDATED IN PHASE 2 (G2 fix, 2026-08-25) — this assertion previously read
  //   assert.equal(fact.verificationStatus, 'verified');
  // which pinned the G2 defect in place as if it were desired behaviour: a
  // self-asserted `human-confirmed` string auto-promoted the fact to `verified`
  // with no evidence and no human in the loop, violating the security doc rule
  // "Never promote an agent assertion to a verified fact".
  // The alias normalization being tested here (human-confirmed -> human_confirmed)
  // is unchanged and still correct; only the trust consequence changed.
  // See docs/handoffs/provenance-contract.md §2.
  assert.equal(fact.verificationStatus, 'unverified');
  assert.equal(fact.sourceClass, 'human_confirmed');
  assert.equal(fact.sourceRaw, 'human-confirmed');
});

test('idempotency prevents duplicate decisions and facts', () => {
  const graph = createShadowGraph();
  const first = graph.addDecision({ title: 'Same', chosen: 'A', idempotencyKey: 'x' });
  const second = graph.addDecision({ title: 'Same', chosen: 'A', idempotencyKey: 'x' });
  assert.equal(first.id, second.id);
  graph.addFact({ key: 'mode', value: 'a', idempotencyKey: 'fact-x' });
  graph.addFact({ key: 'mode', value: 'b', idempotencyKey: 'fact-x' });
  assert.equal(graph.stats().facts, 1);
});

test('maintenance ages decisions, expires facts, and persists review signals', () => {
  const graph = createShadowGraph({ now: () => '2027-01-01T00:00:00.000Z' });
  const decision = graph.addDecision({ title: 'Old', chosen: 'A', reviewAfter: '2026-01-01T00:00:00.000Z', alternatives: [{ label: 'B', reopenWhen: ['changed'] }] });
  graph.addFact({
    key: 'expiry', value: true,
    validFrom: '2025-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:00.000Z'
  });
  const result = graph.maintain({ changedFacts: ['changed'] });
  assert.equal(result.agedDecisionIds[0], decision.id);
  assert.equal(graph.getReviewSignals().length, 1);
  assert.equal(graph.exportData().facts[0].verificationStatus, 'expired');
});

test('validation and retrieval provide graph-aware explanations', () => {
  const graph = createShadowGraph();
  const decision = graph.addDecision({ title: 'Database', chosen: 'Postgres' });
  const fact = graph.addFact({ key: 'deployment', value: 'local' });
  graph.link({ from: decision.id, to: fact.id, relation: 'depends_on' });
  // G6: retrieve() returns a paginated envelope — see completeness-contract.md.
  const result = graph.retrieve('database');
  assert.equal(result.items.some((item) => item.record.id === fact.id && item.graphBoost === 1), true);
  assert.equal(graph.validate().valid, true);
});

test('backup and restore round-trip a graph export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-backup-'));
  const source = join(dir, 'source.json'); const backup = join(dir, 'backup.json'); const restored = join(dir, 'restored.json');
  const graph = createShadowGraph(); graph.addDecision({ title: 'Backup', chosen: 'A' });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(source, JSON.stringify(graph.exportData())));
  await backupFile(source, backup); await restoreFile(backup, restored);
  assert.equal((await readFile(restored, 'utf8')).includes('Backup'), true);
});
