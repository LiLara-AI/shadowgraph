// Plan v1.4.4 PR-22 (§14.1-§14.6, §14.8; plan rev6 §3.2): a deterministic,
// local claim verifier. It classifies a claim against its source as quoted,
// entailed under a named rule, ambiguous with its readings, or unsupported with
// the dimension that failed, and it never promotes unsupported. No model is
// called, nothing in the kernel or on a transport calls it yet, and no caller
// can store a claim of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createShadowGraphServer } from '../src/server.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { CLAIM_DERIVATION_RULES, CLAIM_DIMENSIONS, CLAIM_VERIFIER_VERSION, classifyClaim, verifiedClaims } from '../src/verification.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mcp = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
const claim = (text, span) => ({ text, sourceRef: 'capture:c1', ...(span ? { span } : {}) });
const spanOf = (source, text) => ({ start: source.indexOf(text), end: source.indexOf(text) + text.length });

test('the verifier is local and declared: six dimensions, one named rule, a version', () => {
  assert.deepEqual([...CLAIM_DIMENSIONS], ['quantifier', 'polarity', 'actor', 'time', 'scope', 'modality']);
  assert.deepEqual(Object.keys(CLAIM_DERIVATION_RULES), ['contraction-expansion-v1']);
  assert.equal(typeof CLAIM_VERIFIER_VERSION, 'string');
  assert.ok(CLAIM_VERIFIER_VERSION);
});

// §14.3 and the P3 exit list: each is unsupported, on the dimension that fails.
const COUNTEREXAMPLES = [
  ['strengthened quantifier', 'Some tests passed on the second run.', 'all tests passed', 'quantifier'],
  ['negation, reworded', 'The migration did not complete.', 'the migration completed', 'polarity'],
  ['negation, as a verbatim substring', 'It is not true that the migration completed.', 'the migration completed', 'polarity'],
  ['borrowed quote', 'The ticket asked whether the cache fixed the timeout.', 'the cache fixed the timeout', 'modality'],
  ['causal invention', 'The config changed. The build failed.', 'the config change caused the build to fail', 'modality'],
  ['absent evidence', 'Tests passed on CI.', 'the database was restored', 'no_span'],
  ['may turned into does', 'The patch may fix the crash.', 'the patch does fix the crash', 'modality'],
  ['actor swap', 'The user deleted the branch.', 'the agent deleted the branch', 'actor'],
  ['past turned into current state', 'The service was down during the deploy.', 'the service is down', 'time'],
  ['dropped scope qualifier', 'The migration completed in staging.', 'the migration completed', 'scope']
];

test('the six-dimension counterexample suite: every case is unsupported, on the right dimension', () => {
  for (const [label, source, text, dimension] of COUNTEREXAMPLES) {
    const result = classifyClaim(claim(text), source);
    assert.equal(result.class, 'unsupported', label);
    assert.equal(result.failingDimension, dimension, label);
    assert.equal(result.verifierVersion, CLAIM_VERIFIER_VERSION, label);
  }
});

// The independent reviews' false accepts, one or more per cause: each must fail
// safe. Beside a quoted claim, in its own unit, only neutral material may
// stand, and the units around it may carry no marker.
const FAIL_SAFE = [
  ['a reversal two sentences on', 'The migration completed. The build finished. Neither is true.', 'the migration completed', 'polarity'],
  ['a hedge two sentences on', 'The patch fixed the crash. The logs rotated. We think so, anyway.', 'the patch fixed the crash', 'modality'],
  ['a blank line, then a rebuttal','The migration completed.\n\nNo, it did not. The table is empty.', 'the migration completed', 'polarity'],
  ['a contracted rebuttal', "The migration completed. That's not true.", 'the migration completed', 'polarity'],
  ['an ellipsis, then a question', 'The migration completed... Or did it?', 'the migration completed', 'modality'],
  ['a qualifier in the next sentence', 'The tests passed. On Windows only.', 'the tests passed', 'quantifier'],
  ['a count in the next sentence', 'All tests passed. 3 were skipped.', 'all tests passed', 'quantifier'],
  ['hearsay behind a contraction', "I'm told the migration completed.", 'the migration completed', 'modality'],
  ['a counterfactual behind a contraction', "The patch should've fixed the crash.", 'fixed the crash', 'modality'],
  ['a numbered list under a label', 'Not done:\n1. The migration completed.\n2. The backup finished.', 'the migration completed', 'polarity'],
  ['an abbreviation mid-sentence', 'According to Dr. Smith the patch fixed the crash.', 'the patch fixed the crash', 'modality'],
  ['a heading above a list', '## Not yet verified\n\n- The migration completed', 'the migration completed', 'polarity'],
  ['an unchecked task', '## Status\n\n- [x] Backup finished\n- [ ] The migration completed', 'the migration completed', 'scope'],
  ['a strikethrough', '~~The migration completed~~', 'the migration completed', 'scope'],
  ['a test runner failure line', '✕ the migration completes (12 ms)', 'the migration completes', 'quantifier'],
  ['a named actor', 'Alice deleted the branch.', 'deleted the branch', 'scope'],
  ['a dry run', '[dry-run] Deleted 42 files', 'deleted 42 files', 'scope'],
  ['an instruction', 'Make sure all tests pass.', 'all tests pass', 'modality'],
  ['a frequency', 'The test fails intermittently.', 'the test fails', 'quantifier'],
  ['a myth', 'It is a myth that the migration completed.', 'the migration completed', 'polarity'],
  ['a look-alike letter in a negation', 'It is nоt true that the migration completed.', 'the migration completed', 'scope'],
  ['a claim ending in a full stop', 'It is not true that the migration completed.', 'The migration completed.', 'polarity'],
  ['a curly apostrophe', 'It isn’t true that the migration completed.', 'the migration completed', 'polarity'],
  ['no apostrophe at all', 'The team didnt confirm the migration completed.', 'the migration completed', 'polarity'],
  ['a zero-width character inside a negation', 'It is n​ot true that the migration completed.', 'the migration completed', 'polarity'],
  ['a qualifier after a comma and but', 'The migration completed, but not in production.', 'the migration completed', 'polarity'],
  ['a quantifier after a comma', 'The migration completed, but only partially.', 'the migration completed', 'quantifier'],
  ['a label before a colon', 'Not verified: the migration completed.', 'the migration completed', 'polarity'],
  ['a hypothesis label', 'Hypothesis: the patch fixed the crash.', 'the patch fixed the crash', 'modality'],
  ['a qualifier after a semicolon', 'The migration completed; not in prod, though.', 'the migration completed', 'polarity'],
  ['a question', 'The migration completed?', 'the migration completed', 'modality'],
  ['failed to', 'Engineers failed to show the patch fixed the crash.', 'the patch fixed the crash', 'polarity'],
  ['unable to', 'Unable to verify the migration completed.', 'the migration completed', 'polarity'],
  ['a denial', 'The team denied the migration completed.', 'the migration completed', 'polarity'],
  ['a quoted sentence called false', '"The cache fixed the timeout" — false.', 'the cache fixed the timeout', 'polarity'],
  ['a non- prefix', 'Non-deterministic failures observed.', 'deterministic failures observed', 'polarity'],
  ['a hedging adverb', 'Supposedly the cache fixed the timeout.', 'the cache fixed the timeout', 'modality'],
  ['a share of a count', '2 of 10 tests passed.', '10 tests passed', 'quantifier'],
  ['almost all', 'Almost all tests passed.', 'all tests passed', 'quantifier'],
  ['a future time', 'The build fails tomorrow.', 'the build fails', 'time'],
  ['a place', 'The migration completed at Acme.', 'the migration completed', 'scope'],
  ['a condition', 'The tests passed against a mocked database.', 'the tests passed', 'scope'],
  ['two readings, neither plain', 'Hypothesis: the migration completed. Result: it is not true that the migration completed.', 'the migration completed', 'polarity'],
  ['a next sentence that points back', 'The migration completed. That is not true.', 'the migration completed', 'polarity'],
  ['a next sentence that doubts it', 'The job stopped. It is not clear the job stopped.', 'the job stopped', 'polarity']
];

// The dimension named there is the one the case was found on; a claim may now
// fail on another first, since everything else in its source is read too.
test('it fails safe: every false accept the reviews found is unsupported', () => {
  for (const [label, source, text] of FAIL_SAFE) {
    const result = classifyClaim(claim(text), source);
    assert.equal(result.class, 'unsupported', label);
    assert.ok([...CLAIM_DIMENSIONS, 'no_span'].includes(result.failingDimension), label);
  }
  // A span must start and end on word boundaries, and name words that assert something.
  for (const [source, text] of [['Client unable to connect.', 'able to connect'], ['Deploy unsuccessful on retry.', 'successful on retry'], ["We won't.", 'we won']]) {
    assert.equal(classifyClaim(claim(text, spanOf(source, text)), source).class, 'unsupported', `${text} inside ${source}`);
  }
  for (const text of ['the', 'is', 'the?']) assert.equal(classifyClaim(claim(text), 'The service is down. Is the build broken?').class, 'unsupported', text);
  // Whitespace around a span is not part of it.
  const spaced = 'Summary:\n  The job stopped.';
  assert.equal(classifyClaim(claim('the job stopped', { start: 9, end: 26 }), spaced).class, 'quoted');
});

// The third review's cases: qualifiers the own unit does not hold, reached by
// the paragraph, the neighbours, the whole source, the labels above and the
// markup around a claim.
const REACHED = [
  ['a bold label above a list', '**Not verified:**\n\n- The backup finished\n- The migration completed', 'the migration completed'],
  ['a plan lead-in two items up', 'Next steps\n\n1. Back up the database\n2. The migration completes\n3. Open the PR', 'the migration completes'],
  ['a heading above a label', '## Not done\n\nBackend:\n- The migration completed\n- The index rebuilt', 'the migration completed'],
  ['a fenced block after a doubting sentence', 'The first attempt did not really finish, even though the log claims otherwise.\n\n```\nThe migration completed\n```', 'the migration completed'],
  ['the expected side of a failing diff', '- Expected  - 1\n+ Received  + 1\n\n  Status report\n- the migration completed\n+ the migration timed out', 'the migration completed'],
  ['a mocha failing test', '  ✓ the backup finished\n  1) the migration completed\n  ✓ the index rebuilt', 'the migration completed'],
  ['a later retraction', 'The migration completed.\n\nThe index rebuilt.\n\nCorrection: everything above is wrong.', 'the migration completed'],
  ['a scope two sentences away', 'We ran the suite against staging. Here is the summary. All tests passed.', 'all tests passed'],
  ['a pending label', 'Pending:\n\n- The migration completed', 'the migration completed'],
  ['a setext heading', 'Not yet verified\n================\n\nThe migration completed.', 'the migration completed'],
  ['an HTML comment block', '<!--\nThe migration completed\n-->', 'the migration completed'],
  ['a lone cross after', 'The migration completed\n❌', 'the migration completed'],
  ['a look-alike word next', 'The migration completed. Nοt true.', 'the migration completed'],
  ['timed out next', 'The migration completed. Timed out.', 'the migration completed'],
  ['a lone numbered line is a count', 'Summary\n10. Tests passed\n', 'tests passed']
];

test('what reaches a claim from around it fails it: paragraph, neighbours, source, labels and markup', () => {
  for (const [label, source, text] of REACHED) assert.equal(classifyClaim(claim(text), source).class, 'unsupported', label);
  // Under a neutral heading, a claim stated alone still quotes.
  assert.equal(classifyClaim(claim('the migration completed'), 'Summary:\n\n- The migration completed').class, 'quoted');
});

// The fourth review's realistic sources: a claim next to anything else -- an
// afterthought, an overstatement, a filler line and then a narrowing, a plain
// heading, a revert -- in words no list names. A deterministic reader cannot
// tell which of those qualify it, so none of them is quoted (§14.4: fidelity,
// not yield).
const AFTERTHOUGHTS = [
  ['a retraction in unlisted words', 'The deploy succeeded.\n\nOops, disregard that.', 'the deploy succeeded'],
  ['an edit note', 'The certificate is valid.\n\nEdit: it expired.', 'the certificate is valid'],
  ['a hedge fragment', 'The root cause is the connection pool size. Unsure though.', 'the root cause is the connection pool size'],
  ['untested', 'The patch fixes the memory leak. Untested.', 'the patch fixes the memory leak'],
  ['a joke', 'I deleted the production bucket. Kidding.', 'i deleted the production bucket'],
  ['an outage after', 'The deploy succeeded.\n\nSite\'s down.', 'the deploy succeeded'],
  ['an overstatement beside it', 'All tests passed. E2E suite skipped.', 'all tests passed'],
  ['a narrowing after a filler line', 'All tests passed.\n\nLGTM.\n\nThat run was on the SQLite backend only.', 'all tests passed'],
  ['a traceback after', 'Migrations complete.\n\nSeeding fixtures\n\nTraceback (most recent call last):\n  File "seed.py", line 14, in <module>\n    load()\nKeyError: \'tenant_id\'', 'migrations complete'],
  ['a plain heading', 'Definition of done\n\nThe export finishes in under a minute.', 'the export finishes in under a minute'],
  ['a plain lead-in', 'Known issues\n- Export works\n- Import hangs', 'export works'],
  ['a revert in the log', 'commit a1\n    Enable response caching\n\ncommit b2\n    Revert "Enable response caching"\n\n    This reverts commit a1.', 'enable response caching'],
  ['a heading below', 'The cache is enabled by default.\n\n## Everything above is outdated', 'the cache is enabled by default'],
  ['deleted diff text', '@@ -8,6 +8,4 @@\n Configure TLS.\n-    The agent encrypts traffic between hosts.\n Run the health check.', 'the agent encrypts traffic between hosts']
];

test('anything else a source says, in any words, keeps a claim from being quoted; a claim stated alone still is', () => {
  for (const [label, source, text] of AFTERTHOUGHTS) assert.equal(classifyClaim(claim(text), source).class, 'unsupported', label);
  for (const source of ['The deploy succeeded.', 'I prefer tabs over spaces.', 'My name is Sam.', 'All 42 tests passed.']) {
    assert.equal(classifyClaim(claim(source), source).class, 'quoted', source);
  }
  // A one-word reply that changes the state is not a neutral heading.
  for (const [source, text] of [['The login is broken.\n\nFixed.', 'the login is broken'], ['The migration is pending.\n\nDone.', 'the migration is pending'], ['The tests are red.\n\nPassed now.', 'the tests are red'], ['The flag is off.\n\nChanged.', 'the flag is off']]) {
    assert.equal(classifyClaim(claim(text), source).class, 'unsupported', source);
  }
  // Two statements side by side vouch for neither: that is the price of failing safe.
  assert.equal(classifyClaim(claim('the app uses react 18 and tailwind'), 'Please add a dark mode toggle. The app uses React 18 and Tailwind.').class, 'unsupported');
});

test('verifiedClaims checks each claim against its own source, and no duplicate hides an unsupported claim', () => {
  const source = 'The job stopped.';
  const span = spanOf(source, 'The job stopped');
  const result = verifiedClaims([claim('the job stopped', span), claim('all jobs stopped', span), claim('the job never stopped', span)], { 'capture:c1': source });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.unsupported.length, 2);
  // One place in one source counts once, however it is cited.
  assert.equal(verifiedClaims([claim('the job stopped'), claim('the job stopped', span)], { 'capture:c1': source }).accepted.length, 1);
  // A claim citing a source it was not checked against is unsupported.
  const elsewhere = verifiedClaims([{ ...claim('the job stopped'), sourceRef: 'capture:c2' }], { 'capture:c1': source });
  assert.deepEqual({ accepted: elsewhere.accepted.length, dimension: elsewhere.unsupported[0].failingDimension }, { accepted: 0, dimension: 'no_span' });
  // A malformed claim is unsupported rather than fatal, and a null span is not "no span".
  const mixed = verifiedClaims([null, { text: 42, sourceRef: 'capture:c1' }, claim('the job stopped'), { ...claim('the job stopped'), span: null }], { 'capture:c1': source });
  assert.deepEqual({ accepted: mixed.accepted.length, unsupported: mixed.unsupported.length }, { accepted: 1, unsupported: 3 });
  assert.equal(verifiedClaims([claim('the job stopped')], new Map([['capture:c1', source]])).accepted.length, 1, 'sources may be a Map');
});

test('classification stays fast on large sources: paragraphs, an 80,000-line log, one line with 10,000 occurrences, many claims', () => {
  const big = 'The cache warmed quickly and the service answered. '.repeat(20_000);
  const log = 'request succeeded\n'.repeat(80_000);
  const line = 'request succeeded, '.repeat(10_000);
  const started = performance.now();
  classifyClaim(claim('the database was restored'), big);
  classifyClaim(claim('the service answered'), big);
  assert.equal(classifyClaim(claim('request succeeded'), log).class, 'quoted');
  assert.equal(classifyClaim(claim('request succeeded'), line).class, 'unsupported');
  verifiedClaims(Array.from({ length: 40 }, (_, index) => claim(`the service answered ${index}`)), { 'capture:c1': big });
  assert.ok(performance.now() - started < 15_000, `${Math.round(performance.now() - started)} ms`);
});

test('quoted under whitespace and case only, entailed under the named rule, ambiguous with both readings', () => {
  const source = 'The  Migration\n did NOT complete.';
  const quoted = classifyClaim(claim('the migration did not complete'), source);
  assert.equal(quoted.class, 'quoted');
  assert.equal(source.slice(quoted.span.start, quoted.span.end), 'The  Migration\n did NOT complete');
  assert.deepEqual(Object.values(quoted.checks), CLAIM_DIMENSIONS.map(() => 'consistent'));
  const entailed = classifyClaim(claim('the migration did not complete'), "The migration didn't complete.");
  assert.deepEqual({ class: entailed.class, rule: entailed.rule }, { class: 'entailed', rule: 'contraction-expansion-v1' });
  const twoReadings = 'The job stopped.\n\nThe job stopped in staging.';
  const ambiguous = classifyClaim(claim('the job stopped'), twoReadings);
  assert.equal(ambiguous.class, 'ambiguous');
  assert.deepEqual(ambiguous.readings, ['the job stopped', 'the job stopped in staging']);
  assert.equal(twoReadings.slice(ambiguous.span.start, ambiguous.span.end), 'The job stopped', 'the plain reading\'s place');
  // A span must cover the claim's own predicate.
  const elsewhere = 'The retry fixed the timeout. The cache fixed nothing.';
  const borrowed = classifyClaim(claim('the cache fixed the timeout', spanOf(elsewhere, 'The retry fixed the timeout')), elsewhere);
  assert.deepEqual({ class: borrowed.class, failingDimension: borrowed.failingDimension }, { class: 'unsupported', failingDimension: 'no_span' });
  const own = 'Summary:\nThe cache fixed the timeout.';
  assert.equal(classifyClaim(claim('the cache fixed the timeout', spanOf(own, 'The cache fixed the timeout')), own).class, 'quoted');
});

test('three copies of one (sourceRef, span) count once; unsupported is never accepted; nothing carries verificationStatus', () => {
  const sources = { 'capture:c1': 'The job stopped.', 'capture:c2': 'Some tests passed.', 'capture:c3': 'The migration completed in staging.' };
  const span = spanOf(sources['capture:c1'], 'The job stopped');
  const cite = (text, sourceRef, where) => ({ ...claim(text, where), sourceRef });
  const result = verifiedClaims([claim('the job stopped', span), claim('the job stopped', span), claim('The Job  stopped', span), cite('all tests passed', 'capture:c2'), cite('the migration completed', 'capture:c3')], sources);
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.unsupported.map((item) => item.failingDimension).sort(), ['quantifier', 'scope']);
  assert.equal(result.accepted.some((item) => item.class === 'unsupported'), false);
  assert.deepEqual(result.countsByDimension, { quantifier: 1, scope: 1 });
  assert.equal(JSON.stringify(result).includes('verificationStatus'), false);
});

test('repetition cannot upgrade: running the verifier changes no confidence, and a repeated confidence key counts once', () => {
  const graph = createShadowGraph({ now });
  const decision = graph.addDecision({ project: 'alpha', title: 'Cache', chosen: 'redis' });
  for (let copy = 0; copy < 3; copy += 1) graph.addConfidenceEvidence({ project: 'alpha', decisionId: decision.id, key: 'e1', supports: true, sourceClass: 'tool_observed', reason: 'the same observation' });
  const before = JSON.stringify(privilegedSnapshot(graph).records[0].confidence);
  assert.equal(privilegedSnapshot(graph).records[0].confidence.basis.contributions.length, 1, 'one key, one contribution');
  const source = 'The cache fixed the timeout.';
  verifiedClaims([1, 2, 3].map(() => claim('the cache fixed the timeout', spanOf(source, 'The cache fixed the timeout'))), { 'capture:c1': source });
  assert.equal(JSON.stringify(privilegedSnapshot(graph).records[0].confidence), before);
});

// §14.4: a write-path invariant. No P3 write path accepts a claim, so a class
// a caller declares is dropped, or the request refused, and never stored.
const DECLARED = { claims: [{ text: 'we fixed it', class: 'quoted', sourceRef: 'capture:c1', verifierVersion: CLAIM_VERIFIER_VERSION }], causalClaim: { statement: 'x', state: 'recorded', class: 'quoted' }, outcomeEvidence: { state: 'observed' }, captureRef: 'capture:c1' };
const V7_FIELDS = Object.keys(DECLARED);
// An attempt's own causalClaim is the kernel's, derived from its reason (PR-23).
const holdsClaims = (payload) => [...payload.records, ...payload.facts].some((entity) => V7_FIELDS.some((field) => Object.hasOwn(entity, field) && !(field === 'causalClaim' && entity.kind === 'attempt')));

test('a caller cannot store a claim: the API, CLI, HTTP and MCP never store one, and facts and memories stay unverified', async (t) => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'Declared', chosen: 'x', ...DECLARED });
  graph.addAttempt({ project: 'alpha', solution: 's', result: 'r', resultClass: 'failed', ...DECLARED });
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'k', text: 't', ...DECLARED });
  graph.addFact({ project: 'alpha', key: 'k', value: 1, ...DECLARED });
  const stored = privilegedSnapshot(graph);
  assert.equal(holdsClaims(stored), false, 'API');
  assert.deepEqual(stored.records.find((record) => record.kind === 'attempt').causalClaim, { state: 'not_recorded' }, 'the declared cause is not the stored one');
  assert.ok([...stored.records.filter((record) => record.kind === 'memory'), ...stored.facts].every((entity) => entity.verificationStatus === 'unverified'));

  const directory = await scratchDirectory(t, 'shadowgraph-claims-');
  const cliFile = join(directory, 'cli.json');
  spawnSync(process.execPath, [cli, 'decision', JSON.stringify({ project: 'alpha', title: 'CLI', chosen: 'x', ...DECLARED })], { env: { ...process.env, SHADOWGRAPH_FILE: cliFile }, encoding: 'utf8' });
  assert.equal(holdsClaims(JSON.parse(await readFile(cliFile, 'utf8'))), false, 'CLI');

  const httpFile = join(directory, 'http.json');
  const app = await createShadowGraphServer({ file: httpFile });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  try {
    await fetch(`http://127.0.0.1:${app.server.address().port}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'alpha', title: 'HTTP', chosen: 'x', ...DECLARED }) });
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
  assert.equal(holdsClaims(JSON.parse(await readFile(httpFile, 'utf8'))), false, 'HTTP');

  const mcpFile = join(directory, 'mcp.json');
  await writeFile(mcpFile, JSON.stringify(privilegedSnapshot(createShadowGraph({ now }))));
  const child = spawn(process.execPath, [mcp], { env: { ...process.env, SHADOWGRAPH_FILE: mcpFile }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const reply = new Promise((resolve) => child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const line = buffer.split('\n').find((item) => item.includes('"id":1'));
    if (line) resolve(JSON.parse(line));
  }));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shadowgraph_record_decision', arguments: { project: 'alpha', title: 'MCP', chosen: 'x', ...DECLARED } } })}\n`);
  await reply;
  child.stdin.end();
  child.kill();
  await once(child, 'exit');
  assert.equal(holdsClaims(JSON.parse(await readFile(mcpFile, 'utf8'))), false, 'MCP');
});

// PR-20's storage guard, now with the verifier's mark: a stored claim is one
// the verifier classified, never unsupported and never classless.
test('an unsupported or verifier-less stored claim is refused on import, on JSON and SQLite load, and at restore', async (t) => {
  const graph = createShadowGraph({ now });
  const attempt = graph.addAttempt({ project: 'alpha', solution: 's', result: 'r', resultClass: 'failed', idempotencyKey: 'a1' });
  const base = privilegedSnapshot(graph);
  const withClaims = (claims) => {
    const payload = structuredClone(base);
    const copies = [...payload.records, ...payload.idempotency.map((item) => item.value), ...payload.journal.map((entry) => entry.payload)].filter((entity) => entity?.id === attempt.id);
    for (const entity of copies) entity.claims = structuredClone(claims);
    return payload;
  };
  const good = withClaims([{ text: 'x', class: 'quoted', sourceRef: 'capture:c1', verifierVersion: CLAIM_VERIFIER_VERSION }]);
  assert.doesNotThrow(() => createShadowGraph({ now }).importData(structuredClone(good)), 'a verified claim is stored');
  const directory = await scratchDirectory(t, 'shadowgraph-stored-claims-');
  for (const [label, claims, reason] of [
    ['unsupported', [{ text: 'x', class: 'unsupported', sourceRef: 'capture:c1', verifierVersion: CLAIM_VERIFIER_VERSION }], /unsupported/],
    ['verifier-less', [{ text: 'x', class: 'quoted', sourceRef: 'capture:c1' }], /verifierVersion/],
    ['entailed without its rule', [{ text: 'x', class: 'entailed', sourceRef: 'capture:c1', verifierVersion: CLAIM_VERIFIER_VERSION }], /names no rule/],
    ['ambiguous without its readings', [{ text: 'x', class: 'ambiguous', sourceRef: 'capture:c1', verifierVersion: CLAIM_VERIFIER_VERSION }], /records no readings/],
    ['without its source', [{ text: 'x', class: 'quoted', verifierVersion: CLAIM_VERIFIER_VERSION }], /no text or sourceRef/]
  ]) {
    const payload = withClaims(claims);
    const refused = (error) => /claim model/.test(error.message) && reason.test(error.message);
    assert.throws(() => createShadowGraph({ now }).importData(structuredClone(payload)), refused, `import: ${label}`);
    assert.throws(() => validateRestorePayload(structuredClone(payload), { now }), refused, `restore: ${label}`);
    const file = join(directory, `${label}.json`);
    await writeFile(file, JSON.stringify(payload));
    const run = spawnSync(process.execPath, [cli, 'stats', '{"project":"alpha"}'], { env: { ...process.env, SHADOWGRAPH_FILE: file }, encoding: 'utf8' });
    assert.notEqual(run.status, 0, `JSON load: ${label}`);
    assert.match(run.stderr, /claim model/, `JSON load: ${label}`);
    try { await import('node:sqlite'); } catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); continue; }
    const sqliteFile = join(directory, `${label}.db`);
    const store = await createSqliteStore(sqliteFile);
    await store.save(structuredClone(payload)).catch(() => {});
    const loaded = await store.load();
    store.close();
    if (loaded.records?.length) assert.throws(() => createShadowGraph({ now }).importData(loaded), refused, `SQLite load: ${label}`);
  }
});
