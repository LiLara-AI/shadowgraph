// Plan v1.4.4 PR-24 (§9.4, §14.5, X-17, V-21, WS-20): whether an attempt failed
// has three answers -- failed, not failed, undetermined. A declared resultClass
// decides; a captured attempt with no class is undetermined, never a failure to
// avoid and never implied to have succeeded; every other attempt is classified
// exactly as before. resultClass keeps its three literals, and an outcome from
// an exit status is observed or absent, never a fourth class.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShadowGraph, ATTEMPT_RESULT_CLASSES } from '../src/shadowgraph.js';
import { CONFIDENCE_POLICY } from '../src/confidence.js';
import { attemptOutcome, outcomeFromExitStatus } from '../src/internal/outcome.js';
import { buildToolCatalog } from '../src/mcp-tools.js';
import { createShadowGraphServer } from '../src/server.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mcp = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
const copiesOf = (payload, id) => [...payload.records, ...payload.idempotency.map((item) => item.value), ...payload.journal.map((entry) => entry.payload)].filter((entity) => entity?.id === id);
const ABSENT = { state: 'absent', source: 'exit_status' };

// Attempts as only the capture writer (P6) will store them: a captureRef and
// outcome evidence, which no caller can set. Built by patching a store.
function withCaptured(graph, captured) {
  const ids = captured.map(({ solution, result, project = 'alpha', input = {} }) => graph.addAttempt({ project, solution, result, idempotencyKey: solution, ...input }).id);
  const payload = privilegedSnapshot(graph);
  captured.forEach(({ fields }, index) => {
    for (const entity of copiesOf(payload, ids[index])) {
      delete entity.resultClass;
      Object.assign(entity, structuredClone(fields));
    }
  });
  const loaded = createShadowGraph({ now });
  loaded.importData(payload);
  return loaded;
}

test('resultClass keeps its three literals in the kernel and on the MCP write; both context tools publish the undetermined count', () => {
  assert.deepEqual([...ATTEMPT_RESULT_CLASSES], ['failed', 'succeeded', 'inconclusive']);
  const catalog = buildToolCatalog();
  assert.deepEqual(catalog.find((item) => item.name === 'shadowgraph_record_attempt').inputSchema.properties.resultClass.enum, ['failed', 'succeeded', 'inconclusive']);
  // The two causes of a missing class, as published.
  const attemptSchema = catalog.find((item) => item.name === 'shadowgraph_record_attempt').outputSchema;
  for (const word of ['captureRef', 'outcomeEvidence', 'wording heuristic', 'undetermined']) assert.ok(attemptSchema.properties.resultClass.description.includes(word), word);
  assert.match(catalog.find((item) => item.name === 'shadowgraph_record_attempt').inputSchema.properties.result.description, /captured attempt's wording is never read/);
  for (const [tool, collection] of [['shadowgraph_context', 'failedAttempts'], ['shadowgraph_review_context', 'failedAttemptsToAvoid']]) {
    const entry = catalog.find((item) => item.name === tool).outputSchema.properties.completeness.properties.collections.properties[collection];
    assert.ok(entry.required.includes('undetermined'), tool);
    assert.equal(entry.properties.undetermined.type, 'integer', tool);
  }
});

test('an outcome from an exit status is observed or absent, never a fourth class', () => {
  for (const status of [0, 1, 2, 127, -1]) {
    assert.deepEqual(outcomeFromExitStatus(status, 'exit_status'), { resultClass: status === 0 ? 'succeeded' : 'failed', outcomeEvidence: { state: 'observed', source: 'exit_status', exitStatus: status } }, String(status));
  }
  for (const missing of [null, undefined, 1.5, '0', Number.NaN, 2 ** 53]) {
    assert.deepEqual(outcomeFromExitStatus(missing, 'exit_status'), { outcomeEvidence: ABSENT }, String(missing));
  }
});

test('a captured attempt with no class is undetermined: in no collection, counted in its own project, never called a success', () => {
  const base = createShadowGraph({ now });
  base.addFact({ project: 'alpha', key: 'region', value: 'eu' });
  const graph = withCaptured(base, [
    { solution: 'absent', result: 'error: exit unknown', fields: { captureRef: 'capture:c1', outcomeEvidence: ABSENT } },
    { solution: 'not applicable', result: 'failed to say', fields: { captureRef: 'capture:c2', outcomeEvidence: { state: 'not_applicable', source: 'exit_status' } } },
    { solution: 'ref only', result: 'regression', fields: { captureRef: 'capture:c3' } },
    { solution: 'evidence only', result: 'Failed hard', fields: { outcomeEvidence: { state: 'not_applicable', source: 'exit_status' } } },
    { solution: 'null class', result: 'ERROR', fields: { captureRef: 'capture:c6', resultClass: null, outcomeEvidence: ABSENT } },
    { solution: 'reusable', result: 'failed', input: { reusableWhen: [{ key: 'region', operator: 'equals', value: 'eu' }] }, fields: { captureRef: 'capture:c7', outcomeEvidence: ABSENT } },
    { solution: 'observed failure', result: 'all good', fields: { captureRef: 'capture:c4', resultClass: 'failed', outcomeEvidence: { state: 'observed', source: 'exit_status', exitStatus: 1 } } },
    { solution: 'observed success', result: 'fatal error', fields: { captureRef: 'capture:c5', resultClass: 'succeeded', outcomeEvidence: { state: 'observed', source: 'exit_status', exitStatus: 0 } } },
    { solution: 'elsewhere', result: 'error', project: 'beta', fields: { captureRef: 'capture:c8', outcomeEvidence: ABSENT } }
  ]);
  const view = graph.context({ project: 'alpha' });
  assert.deepEqual(view.failedAttempts.map((item) => item.solution), ['observed failure']);
  assert.equal(view.completeness.collections.failedAttempts.undetermined, 6);
  assert.deepEqual({ reusable: view.reusableAttempts, diagnostics: view.conditionDiagnostics }, { reusable: [], diagnostics: [] }, 'an undetermined attempt is not offered for reuse');
  const review = graph.reviewContext({ project: 'alpha' });
  assert.deepEqual(review.failedAttemptsToAvoid.map((item) => item.solution), ['observed failure']);
  assert.equal(review.completeness.collections.failedAttemptsToAvoid.undetermined, 6);
  assert.equal(graph.context({ project: 'beta' }).completeness.collections.failedAttempts.undetermined, 1, 'counted in its own project only');
  // Nothing calls an undetermined attempt a success or writes a class for it.
  const stored = Object.fromEntries(privilegedSnapshot(graph).records.map((record) => [record.solution, record]));
  for (const solution of ['absent', 'not applicable', 'ref only', 'evidence only', 'null class', 'reusable']) {
    assert.equal(attemptOutcome(stored[solution]), 'undetermined', solution);
    assert.equal(stored[solution].resultClass ?? null, null, solution);
  }
  assert.equal(attemptOutcome(stored['observed success']), 'not_failed');
  // With nothing captured the count is zero, and it is on the failed collection only.
  const plain = createShadowGraph({ now }).context({ project: 'alpha' }).completeness.collections;
  assert.equal(plain.failedAttempts.undetermined, 0);
  assert.equal(Object.hasOwn(plain.activeDecisions, 'undetermined'), false);
});

test('every attempt not captured classifies exactly as before: declared class first, then the wording', () => {
  const corpus = [
    ['heuristic hit', 'failed after three attempts', undefined, true],
    ['heuristic hit, error', 'error while linking', undefined, true],
    ['heuristic hit, regression', 'a regression in p99', undefined, true],
    ['heuristic hit, capitalised', 'Regression in p99', undefined, true],
    ['heuristic hit, upper case', 'ERROR: link', undefined, true],
    ['heuristic hit, Failed', 'Failed to start', undefined, true],
    ['heuristic miss', 'quietly wrong', undefined, false],
    ['declared failure', 'no error, but the cache stayed cold', 'failed', true],
    ['declared success', 'regression suite passed clean', 'succeeded', false],
    ['declared inconclusive', 'errors everywhere', 'inconclusive', false]
  ];
  const graph = createShadowGraph({ now });
  for (const [solution, result, resultClass] of corpus) graph.addAttempt({ project: 'alpha', solution, result, ...(resultClass ? { resultClass } : {}) });
  // A legacy record with a null class: not a failure, as it always was. A null
  // captureRef records no capture, so its wording still decides.
  graph.importData({ records: [
    { id: 'legacy-null', kind: 'attempt', project: 'alpha', solution: 'legacy null class', result: 'failed badly', resultClass: null, createdAt: NOW },
    { id: 'null-ref', kind: 'attempt', project: 'alpha', solution: 'null capture reference', result: 'failed badly', captureRef: null, createdAt: NOW }
  ] });
  const failed = graph.context({ project: 'alpha' }).failedAttempts.map((item) => item.solution).sort();
  assert.deepEqual(failed, [...corpus.filter(([, , , fails]) => fails).map(([solution]) => solution), 'null capture reference'].sort());
  assert.equal(graph.context({ project: 'alpha' }).completeness.collections.failedAttempts.undetermined, 0);
  // Reuse is evaluated for every attempt not captured, whatever its outcome, as before.
  const reuse = createShadowGraph({ now });
  reuse.addFact({ project: 'alpha', key: 'region', value: 'eu' });
  const when = { reusableWhen: [{ key: 'region', operator: 'equals', value: 'eu' }] };
  for (const [solution, result, resultClass] of [['succeeded', 'went fine', 'succeeded'], ['inconclusive', 'unclear', 'inconclusive'], ['wording miss', 'quietly wrong', undefined], ['failed', 'failed', 'failed']]) {
    reuse.addAttempt({ project: 'alpha', solution, result, ...(resultClass ? { resultClass } : {}), ...when });
  }
  assert.deepEqual(reuse.context({ project: 'alpha' }).reusableAttempts.map((item) => item.solution).sort(), ['failed', 'inconclusive', 'succeeded', 'wording miss']);
});

test('a caller cannot set captureRef or outcomeEvidence: the API, CLI, HTTP and MCP store the attempt without them, and the wording still applies', async (t) => {
  const declared = { captureRef: 'capture:c1', outcomeEvidence: { state: 'observed', source: 'exit_status', exitStatus: 0 } };
  const entities = (payload) => [...payload.records, ...payload.idempotency.map((item) => item.value), ...payload.journal.map((entry) => entry.payload)].filter((entity) => entity?.kind === 'attempt');
  // The attempt is stored, nowhere with either field, and classified by its wording.
  const check = (payload, solution, label) => {
    assert.ok(entities(payload).some((entity) => entity.solution === solution), `${label}: stored`);
    assert.equal(entities(payload).some((entity) => Object.hasOwn(entity, 'captureRef') || Object.hasOwn(entity, 'outcomeEvidence')), false, label);
    const graph = createShadowGraph({ now });
    graph.importData(structuredClone(payload));
    assert.deepEqual(graph.context({ project: 'alpha' }).failedAttempts.map((item) => item.solution), [solution], `${label}: the heuristic still classifies it`);
  };
  const graph = createShadowGraph({ now });
  graph.addAttempt({ project: 'alpha', solution: 'api', result: 'failed', idempotencyKey: 'api', ...declared });
  check(privilegedSnapshot(graph), 'api', 'API');

  const directory = await scratchDirectory(t, 'shadowgraph-outcome-');
  const cliFile = join(directory, 'cli.json');
  const run = spawnSync(process.execPath, [cli, 'attempt', JSON.stringify({ project: 'alpha', solution: 'cli', result: 'failed', ...declared })], { env: { ...process.env, SHADOWGRAPH_FILE: cliFile }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  check(JSON.parse(await readFile(cliFile, 'utf8')), 'cli', 'CLI');

  const httpFile = join(directory, 'http.json');
  const app = await createShadowGraphServer({ file: httpFile });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/attempts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'alpha', solution: 'http', result: 'failed', ...declared }) });
    assert.ok(response.ok, await response.text());
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
  check(JSON.parse(await readFile(httpFile, 'utf8')), 'http', 'HTTP');

  const mcpFile = join(directory, 'mcp.json');
  await writeFile(mcpFile, JSON.stringify(privilegedSnapshot(createShadowGraph({ now }))));
  const child = spawn(process.execPath, [mcp], { env: { ...process.env, SHADOWGRAPH_FILE: mcpFile, SHADOWGRAPH_STORAGE: 'json' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  let buffer = '';
  const reply = new Promise((resolve) => child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const line = buffer.split('\n').find((item) => item.includes('"id":1'));
    if (line) resolve(JSON.parse(line));
  }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shadowgraph_record_attempt', arguments: { project: 'alpha', solution: 'mcp', result: 'failed', ...declared } } })}\n`);
  const answer = await reply;
  assert.equal(answer.error, undefined, JSON.stringify(answer.error));
  assert.notEqual(answer.result.isError, true, JSON.stringify(answer.result));
  check(JSON.parse(await readFile(mcpFile, 'utf8')), 'mcp', 'MCP');
});

test('AC-010: outcome, explanation and confidence stay separately readable, and the confidence model is unchanged', () => {
  assert.equal(CONFIDENCE_POLICY, 'evidence_weighted_bounded_v1');
  const base = createShadowGraph({ now });
  const decision = base.addDecision({ project: 'alpha', title: 'Use a queue', chosen: 'queue', actor: 'sam' });
  const graph = withCaptured(base, [{ solution: 'sync calls', result: 'timed out', input: { relatedTo: [decision.id] }, fields: { captureRef: 'capture:c1', resultClass: 'failed', outcomeEvidence: { state: 'observed', source: 'exit_status', exitStatus: 1 }, causalClaim: { state: 'unknown' } } }]);
  const view = graph.context({ project: 'alpha' });
  const [attempt] = view.failedAttempts;
  assert.deepEqual({ outcome: attempt.outcomeEvidence.state, resultClass: attempt.resultClass, cause: attempt.causalClaim.state, relatedTo: attempt.relatedTo }, { outcome: 'observed', resultClass: 'failed', cause: 'unknown', relatedTo: [decision.id] });
  // A related attempt's observed failure moves no decision confidence: the policy's values, pinned.
  const basis = { supportingEvidence: 0, contradictingEvidence: 0, successfulOutcomes: 0, failedOutcomes: 0, mixedOutcomes: 0, unknownOutcomes: 0, humanConfirmations: 0, productionVerifications: 0, declaredEvidence: 0, policy: 'evidence_weighted_bounded_v1', contributions: [] };
  assert.deepEqual(view.activeDecisions[0].confidence, { initial: 0.5, current: 0.5, basis, history: [], policy: 'evidence_weighted_bounded_v1' });
  assert.equal(Object.values(attempt.causalClaim).some((value) => typeof value === 'number'), false, 'no numeric causal confidence');
});
