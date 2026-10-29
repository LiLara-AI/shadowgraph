import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';

// Captures recorded under an earlier extraction activation stay pending by
// design: the worker drains only the current setup's provenance. Capture status
// says so, instead of counting them as ordinary backlog (live run R7).
const CURRENT = { provider: 'claude', accountFingerprint: 'a'.repeat(64), setupId: '175eb08f-1234-1234-1234-123456789012' };
const PRIOR = { ...CURRENT, setupId: 'd27ffd42-1234-1234-1234-123456789012' };
const admission = { limits: { maxStoreBytes: 2 ** 24, maxQueueDepth: 100, maxItemBytes: 65536, maxItemsPerSession: 100 }, storeBytes: 0 };
const at = minute => `2026-10-28T10:${String(minute).padStart(2, '0')}:00.000Z`;

// Each entry: [minute, provenance, session]; `blocked` lists the sessions
// whose extraction a worker stopped at window_calls.
function store(entries, blocked = []) {
  let now = at(0);
  const graph = createShadowGraph({ now: () => now });
  for (const [minute, provenance, session] of entries) {
    now = at(minute);
    privilegedRecordCapture(graph, { project: 'p', originId: 'origin', text: `Synthetic observation ${minute}.`, admission,
      source: { event: 'UserPromptSubmit', sessionId: session },
      observation: { host: 'claude-code', hostVersion: '2.1.288', toolName: null, cwd: null, outcome: null, ...(provenance ? { extractionBinding: provenance } : {}) } });
  }
  const data = privilegedSnapshot(graph);
  for (const session of data.captureSessions) if (blocked.includes(session.sessionId)) session.extraction = { state: 'blocked', reason: 'window_calls', at: at(30) };
  return data;
}
function read(data, binding) {
  const extractionAvailable = Object.assign(() => true, { active: Boolean(binding), ...(binding ? { binding } : {}) });
  const graph = createShadowGraph({ extractionAvailable }); graph.importData(data);
  return graph.search('', { project: 'p' }).completeness;
}

const MIXED = [[1, PRIOR, 'prior'], [2, null, 'unbound'], [3, CURRENT, 'current'], [4, PRIOR, 'prior'], [5, CURRENT, 'current']];

test('a mixed store counts only the current setup as pending and reports the prior setup apart', () => {
  const completeness = read(store(MIXED, ['prior', 'unbound']), CURRENT), status = completeness.capture;
  assert.equal(status.pending, 2);
  assert.equal(status.oldestPendingAt, at(3), 'the oldest pending item is the current setup\'s');
  assert.equal(status.priorSetup, 3, 'items of another setup, and items bound to none, are counted apart');
  assert.deepEqual(status.gaps.filter(gap => gap.reason === 'prior_setup'), [{ reason: 'prior_setup', from: at(1), to: at(4) }]);
  assert.equal(status.workerErrors, undefined, 'a block written under the prior setup is not this setup\'s');
  assert.equal(status.extractionAvailable, true);
  assert.equal(completeness.complete, false, 'unextracted material still leaves the view incomplete');
  assert.match(completeness.limitation.detail, /earlier extraction setup/);
  assert.doesNotMatch(completeness.limitation.detail, /refused material/);
});

test('a prior-only store has nothing pending and no stale worker error', () => {
  const status = read(store([[1, PRIOR, 'prior'], [2, PRIOR, 'prior']], ['prior']), CURRENT).capture;
  assert.equal(status.pending, 0);
  assert.equal(status.processing, 0);
  assert.equal(status.oldestPendingAt, null);
  assert.equal(status.priorSetup, 2);
  assert.deepEqual(status.gaps.filter(gap => gap.reason === 'prior_setup'), [{ reason: 'prior_setup', from: at(1), to: at(2) }]);
  assert.equal(status.workerErrors, undefined);
  assert.equal(status.extractionAvailable, true);
});

test('with no active binding capture status is unchanged', () => {
  const data = store(MIXED, ['prior', 'unbound']);
  for (const status of [read(data, null).capture, (() => { const g = createShadowGraph(); g.importData(data); return g.search('', { project: 'p' }).completeness.capture; })()]) {
    assert.equal(status.pending, 5);
    assert.equal(status.oldestPendingAt, at(1));
    assert.equal(status.priorSetup, undefined);
    assert.ok(!status.gaps.some(gap => gap.reason === 'prior_setup'));
    assert.deepEqual(status.workerErrors, [{ reason: 'window_calls', at: at(30) }]);
    assert.equal(status.extractionAvailable, false);
  }
});

test('a current-setup window_calls block is still reported', () => {
  for (const [entries, blocked] of [[[[1, CURRENT, 'current']], ['current']], [MIXED, ['prior', 'unbound', 'current']]]) {
    const status = read(store(entries, blocked), CURRENT).capture;
    assert.deepEqual(status.workerErrors, [{ reason: 'window_calls', at: at(30) }]);
    assert.equal(status.extractionAvailable, false);
    assert.ok(status.pending >= 1);
  }
});
