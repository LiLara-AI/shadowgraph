// The inventory is deliberately explicit: a new graph operation or persistence
// route requires classification, rather than silently escaping generation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { generationIssue, invalidatedCaptureTokens, effectiveGeneration } from '../src/internal/capture-generation.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedRecordCapture, privilegedSnapshot, privilegedIssueAccess } from '../src/internal/snapshot.js';

const source = path => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
const inventory = {
  material: 'replaceData addDecision addAttempt remember applyMemoryPlan addFact migrateAttribution backfillErasureTokens attribute verifyFact setOutcome addConfidenceEvidence updateDecisionStatus supersedeDecision link purgeProject importData bindProject cancelCapture deleteCapture completeCaptureDelete reapplyDeletion completePurge',
  authority: 'requestAccess issueAccess ownerIssueAccess revokeAccess discardAccess',
  capture: 'recordCapture transitionCapture claimCapture completeExtraction settleExtraction expireCapture recordSelfEvent recordTranscript',
  audit: 'memoryHistory traverse expand redact review reconsider maintain getReviewSignals acknowledgeReview search retrieve recall validate repairPlan context reviewContext exportData getJournal rebuild stats accessRefusal'
  , revisionOnly: 'setRevision'
};

test('generation source scan: all graph mutation and audited-read entries are classified under the common transaction fence', async () => {
  const graph = await source('shadowgraph.js');
  const tail = graph.slice(graph.indexOf('return registerPrivileged'));
  assert.ok(tail.length > 1000, 'locate the actual public/privileged surface');
  const entries = [...tail.matchAll(/(?:transactional|auditedRead)\('([^']+)'/gu)].map(match => match[1]).sort();
  assert.deepEqual(entries, Object.values(inventory).flatMap(value => value.split(' ')).sort());
  assert.match(graph, /invalidatedCaptureTokens\(generationBefore, snapshot\(\)\)/u);
  assert.match(graph, /cancelRequested: true/u);
  const capture = await source('internal/capture.js');
  assert.match(capture, /Object\.hasOwn\(item, 'generation'\)/u);
  assert.equal(generationIssue({ generationCounters: [{ token: 'opaque', counter: 1 }] }), null);
});

test('generation source scan: both store commits advance before payload and restore advances before its primitive activation', async () => {
  const json = await source('storage.js'), sqlite = await source('sqlite-storage.js'), restore = await source('internal/restore-wrapper.js');
  for (const code of [json, sqlite]) {
    const calls = [...code.matchAll(/beforeRecord: \(\) => recordGenerationChanges\(/gu)];
    assert.equal(calls.length, 1, 'one fenced persistence boundary per backend');
    assert.ok(calls[0].index > code.indexOf('await recordPurges('), 'generation runs through the preflight-aware commit callback');
    assert.match(code, /const before = structuredClone\(current\)/u, 'hook callback cannot alias away the comparison');
  }
  assert.match(restore, /restoreGeneration\(mine\.ledger, carried\.ledger\)/u);
  assert.match(restore, /if \(!fresh\.length\) \{ await beforeRecord\?\.\(\); return null; \}/u);
  const purge = restore.slice(restore.indexOf('export async function recordPurges'));
  assert.ok(purge.indexOf('await registryUsable(') < purge.indexOf('await beforeRecord?.();', purge.indexOf('const forms =')));
  assert.ok(purge.indexOf('await beforeRecord?.();', purge.indexOf('const forms =')) < purge.indexOf('await writeLedger('));
  assert.match(restore, /bytes: generationPrior\.bytes/u, 'failed restore keeps its allocated base');
  const writers = [];
  for (const directory of ['', 'internal/']) for (const entry of await readdir(new URL(`../src/${directory}`, import.meta.url), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const path = `${directory}${entry.name}`, code = await source(path);
    if (/generationBase\s*(?::|=)|generationCounters\s*(?::|=)/u.test(code)) writers.push(path);
    if (path !== 'internal/extraction-worker.js') assert.doesNotMatch(code, /(?:from\s+|import\s*\()['"][^'"]*extraction-worker\.js/u, `${path}: worker remains inert until its activation change`);
  }
  assert.deepEqual(writers.sort(), ['internal/capture-generation.js', 'internal/deletion-knowledge.js']);
});

test('generation completeness separates write invalidation from both fenced clock terms', () => {
  const at = '2026-10-01T00:00:00.000Z', graph = createShadowGraph({ now: () => at });
  const item = privilegedRecordCapture(graph, { project: 'p', originId: 'fixture', text: 'Synthetic generation fixture.', source: { event: 'Stop', sessionId: 's' }, admission: { limits: { maxStoreBytes: 2 ** 30, maxItemBytes: 2 ** 20, maxQueueDepth: 100, maxItemsPerSession: 100 }, storeBytes: 0 } });
  graph.remember({ project: 'p', memoryType: 'note', key: 'correction', text: 'Before.' });
  const grant = privilegedIssueAccess(graph, { scope: { projects: ['p'] }, surfaces: ['cli'], expiresAt: '2026-10-01T00:01:00.000Z', reason: 'Synthetic authority' }).entry;
  const before = privilegedSnapshot(graph);
  const edits = {
    correction: p => { p.records.find(r => r.kind === 'memory').text = 'After.'; },
    purge: p => { p.records = p.records.filter(r => r.kind !== 'capture'); },
    revocation: p => { p.accessRevocations = [{ accessId: grant.accessId }]; },
    attribution: p => { p.records.find(r => r.id === item.id).originId = 'changed'; },
    redaction: p => { p.captureContent[0].text = '[redacted]'; },
    cancellation: p => { p.records.find(r => r.id === item.id).cancelRequested = true; },
    sweep: p => { p.captureContent = []; }
  };
  for (const [name, change] of Object.entries(edits)) { const next = structuredClone(before); change(next); assert.deepEqual(invalidatedCaptureTokens(before, next), [item.erasureToken], name); }
  const leased = { ...item, lease: { accessId: grant.accessId, leaseId: 'fixture', ownerId: 'fixture', ownerBootId: 'fixture', leaseExpiresAt: '2026-10-01T00:02:00.000Z' } };
  assert.equal(effectiveGeneration(leased, null, before, at), 0);
  assert.equal(effectiveGeneration(leased, null, before, '2026-10-01T00:01:00.000Z'), 1, 'covering grant clock term');
  assert.equal(effectiveGeneration(leased, null, before, '2026-10-08T00:00:00.000Z'), 2, 'retention plus grant clock terms');
});
