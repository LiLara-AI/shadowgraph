import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedIssueAccess } from '../src/internal/snapshot.js';
import { withoutSourceCopies } from '../src/internal/source-availability.js';

test('derived memory requires transitively readable sources and rejects missing references and cycles', () => {
  const graph = createShadowGraph(), ids = {};
  for (const project of ['alpha', 'beta', 'gamma']) ids[project] = graph.remember({ project, memoryType: 'note', key: project, text: `${project} private checksum experience` }).memory.id;
  const data = privilegedSnapshot(graph);
  data.records.find(r => r.id === ids.beta).memoryDependencies = [ids.alpha];
  data.records.find(r => r.id === ids.gamma).memoryDependencies = [ids.beta];
  graph.replaceData(data);
  assert.equal(graph.exportData({ project: 'gamma' }).records.length, 0);
  const grant = privilegedIssueAccess(graph, { scope: { projects: ['alpha', 'beta'] }, surfaces: ['cli'], expiresAt: new Date(Date.now() + 86400000).toISOString(), reason: 'Synthetic source dependency check' }).entry;
  assert.equal(graph.exportData({ project: 'gamma', accessId: grant.accessId }).records.length, 3);
  graph.revokeAccess({ accessId: grant.accessId, reason: 'Synthetic revocation' });
  assert.equal(graph.exportData({ project: 'gamma' }).records.length, 0);
  const cyclic = privilegedSnapshot(graph);
  cyclic.records.find(r => r.id === ids.alpha).memoryDependencies = [ids.alpha];
  cyclic.records.find(r => r.id === ids.gamma).memoryDependencies = ['missing-source'];
  graph.replaceData(cyclic);
  assert.equal(graph.exportData({ project: 'alpha' }).records.length, 0);
  assert.equal(graph.exportData({ project: 'gamma' }).records.length, 0);
});

test('source unavailability removes contextual evidence copies while retaining the unverified field interpretation', () => {
  const record = { kind: 'decision', id: 'synthetic', chosen: 'K7', interpretation: { status: 'model_proposed', sourceRef: 'capture-source', sourceText: 'full captured context' },
    correction: { status: 'model_proposed', sourceRef: 'capture-source', statement: 'quoted correction' } };
  const result = withoutSourceCopies(record, new Set(['capture-source']));
  assert.equal(result.interpretation.sourceText, undefined);
  assert.equal(result.interpretation.sourceAvailability, 'unavailable');
  assert.equal(result.correction.statement, undefined);
  assert.equal(result.chosen, 'K7');
  assert.equal(record.interpretation.sourceText, 'full captured context');
});
