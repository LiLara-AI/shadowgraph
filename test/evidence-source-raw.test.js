// Corrective change before plan v1.4.4 PR-17: a decision's evidence keeps the
// raw source label it was recorded with. Import re-derived the label from the
// stored, already-resolved sourceClass, so every load dropped it, and the next
// save removed it from the store. A grant-bearing default-path read reloads and
// rewrites the store, so that read silently altered canonical truth (PC-25).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { currentAccessOperation } from '../src/internal/access-transport.js';
import { privilegedIssueAccess, privilegedSnapshot } from '../src/internal/snapshot.js';

const NOW = '2026-01-01T00:00:00.000Z';
const recordWithLabel = (graph) => graph.addDecision({
  project: 'app', title: 'cache', chosen: 'redis',
  evidence: [{ source: 'runbook', detail: 'measured p99', sourceClass: 'measured' }]
});

test('stored evidence keeps its raw source label across a load', () => {
  const graph = createShadowGraph({ now: () => NOW });
  const decision = recordWithLabel(graph);
  const stored = privilegedSnapshot(graph).records.find((record) => record.id === decision.id).evidence[0];
  assert.equal(stored.sourceClass, 'agent_claimed');
  assert.equal(stored.sourceRaw, 'measured');
  graph.replaceData(privilegedSnapshot(graph));
  const reloaded = privilegedSnapshot(graph).records.find((record) => record.id === decision.id).evidence[0];
  assert.deepEqual(reloaded, stored);
});

test('a grant-bearing context read does not strip evidence labels from the store', async (t) => {
  const directory = await scratchDirectory(t, 'evidence-source-raw-');
  const file = join(directory, 'store.json');
  const graph = createShadowGraph({ now: () => NOW });
  const decision = recordWithLabel(graph);
  graph.addDecision({ project: 'other', title: 'wider', chosen: 'x' });
  const grant = privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['other'] }, surfaces: ['mcp'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'synthetic label fixture' }).entry;
  const store = createJsonFileStore(file);
  graph.setRevision(await store.save(privilegedSnapshot(graph)));
  await currentAccessOperation(graph, store, () => graph.context({ project: 'app', accessId: grant.accessId, surface: 'mcp' }));
  const durable = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(durable.records.find((record) => record.id === decision.id).evidence[0].sourceRaw, 'measured');
});

test('a caller still cannot set the raw label directly when recording evidence', () => {
  const graph = createShadowGraph({ now: () => NOW });
  const decision = graph.addDecision({ project: 'app', title: 'cache', chosen: 'redis', evidence: [{ source: 'runbook', sourceClass: 'tool_observed', sourceRaw: 'forged' }] });
  const evidence = privilegedSnapshot(graph).records.find((record) => record.id === decision.id).evidence[0];
  assert.equal(evidence.sourceClass, 'tool_observed');
  assert.equal(Object.hasOwn(evidence, 'sourceRaw'), false);
});
