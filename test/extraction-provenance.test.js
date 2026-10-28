import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createStorage } from '../src/storage.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';
import { claimCapture, commitCapture } from '../src/internal/extraction-worker.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { extractionPrompt, prepareExtraction } from '../src/internal/extraction-output.js';

test('multi-sentence decisions can retain chosen and rejected evidence without weakening the verifier', () => {
  const first = "For Cedar-731's export interoperability work, Q2 dropped the footer checksum in partner testing.";
  const second = "K7 keeps it intact, so let's use K7 for the current export format.";
  const source = first + ' ' + second + ' Please run the existing diagnostic.';
  const item = { id: 'synthetic-capture', source: { role: 'user' } };
  const proposed = { records: [{ kind: 'decision', fields: [['title', first], ['chosen', second], ['alternative', first], ['reason', first]].map(([name, text]) => ({ name, text, sourceRef: item.id })) }] };
  const prepared = prepareExtraction(item, source, proposed, { provider: 'codex' });
  assert.equal(prepared.records[0].kind, 'decision');
  assert.equal(prepared.records[0].values.chosen, second);
  assert.equal(prepared.records[0].alternatives[0].reasonRejected, first);
  assert.equal(prepared.records[0].interpretation.status, 'model_proposed');
  assert.equal(prepared.records[0].interpretation.sourceText, source);
  assert.equal(prepared.records[0].claims.length, 1);
  assert.equal(prepared.records[0].claims[0].text, source);
  const withoutTitle = structuredClone(proposed);
  withoutTitle.records[0].fields = withoutTitle.records[0].fields.filter(field => field.name !== 'title');
  const titled = prepareExtraction(item, source, withoutTitle, { provider: 'codex' }).records[0];
  assert.equal(titled.kind, 'decision');
  assert.equal(titled.values.title, second);
  withoutTitle.records[0].fields[0].span = { start: 1, end: 2 };
  const located = prepareExtraction(item, source, withoutTitle, { provider: 'codex' }).records[0];
  assert.equal(located.kind, 'decision');
  assert.deepEqual(located.interpretation.fieldMapping[0].span, { start: source.indexOf(second), end: source.indexOf(second) + second.length });
  assert.deepEqual(located.interpretation.fieldMapping[0].reportedSpan, { start: 1, end: 2 });
  assert.equal(prepareExtraction(item, source, proposed).records[0].kind, 'memory', 'Claude behavior is unchanged');
  assert.match(extractionPrompt(item, source, { provider: 'codex' }), /copy exact source wording/);
  assert.doesNotMatch(extractionPrompt(item, source), /copy exact source wording/);
});

test('contextual organization never discards corrections or accepts invented field text as supported', () => {
  const source = 'We chose K7. Correction: K7 is only a proposal; nothing has been executed.';
  const item = { id: 'synthetic', source: { role: 'user' } };
  const value = { records: [{ kind: 'decision', fields: ['title', 'chosen'].map(name => ({ name, text: 'We chose K7.', sourceRef: item.id })) }] };
  const record = prepareExtraction(item, source, value, { provider: 'codex' }).records[0];
  assert.equal(record.interpretation.sourceText, source);
  assert.equal(record.claims[0].text, source);
  value.records[0].fields[1].text = 'K7 succeeded';
  assert.ok(prepareExtraction(item, source, value, { provider: 'codex' }).records.every(r => !r.interpretation));
});

test('correction proposals require a supplied candidate, exact prior choice and an exact current user quotation', () => {
  const source = 'Correction: choose R8 instead of K7.', item = { id: 'new', source: { role: 'user' } };
  const candidate = { recordId: 'old', priorChosen: 'We choose K7.', expectedHash: 'a'.repeat(64) };
  const value = { records: [{ kind: 'decision', fields: [{ name: 'chosen', text: source, sourceRef: 'new' }],
    correction: { recordId: 'old', priorChosen: candidate.priorChosen, statement: source } }] };
  const options = { provider: 'codex', correctionCandidates: [candidate] };
  assert.equal(prepareExtraction(item, source, value, options).records[0].correction.recordId, 'old');
  for (const altered of [{ ...options, correctionCandidates: [] }, options]) {
    const local = structuredClone(value);
    if (altered === options) local.records[0].correction.statement = 'This never appeared in the source';
    assert.equal(prepareExtraction(item, source, local, altered).records[0].correction, undefined);
  }
  assert.equal(prepareExtraction({ ...item, source: { role: 'assistant' } }, source, value, options).records[0].correction, undefined);
  assert.throws(() => prepareExtraction(item, source, value), { code: 'extraction_schema_invalid' });
});

test('Codex drains only fresh matching provenance; legacy, foreign accounts and prior setups remain untouched', async t => {
  const root = await scratchDirectory(t), binding = { provider: 'codex', accountFingerprint: 'a'.repeat(64), setupId: '12ab5678-1234-1234-1234-123456789012' };
  const options = { type: 'json', file: join(root, 'memory.json'), env: { SHADOWGRAPH_HOME: root }, project: 'fixture', provider: 'codex', extractionBinding: binding };
  const graph = createShadowGraph(), items = [];
  for (const provenance of [undefined, { ...binding, provider: 'claude' }, { ...binding, accountFingerprint: 'b'.repeat(64) }, { ...binding, setupId: '22ab5678-1234-1234-1234-123456789012' }, binding]) {
    items.push(privilegedRecordCapture(graph, { project: 'fixture', originId: 'fixture-origin', text: 'The fixture completed in staging.',
      source: { event: 'UserPromptSubmit', sessionId: `session-${items.length}` },
      observation: { host: 'codex-cli', hostVersion: '0.161.0', toolName: null, cwd: null, outcome: null, ...(provenance ? { extractionBinding: provenance } : {}) },
      admission: { limits: { maxStoreBytes: 2 ** 24, maxQueueDepth: 100, maxItemBytes: 65536, maxItemsPerSession: 100 }, storeBytes: 0 } }));
  }
  const store = await createStorage(options); await store.save(privilegedSnapshot(graph)); store.close();
  await assert.rejects(claimCapture({ ...options, extractionBinding: undefined }), { code: 'capture_provenance_required' });
  const claim = await claimCapture(options);
  assert.equal(claim.id, items[4].id);
  const result = await commitCapture(options, claim, { status: 'success', receipt: { invocationStarted: true, provider: 'codex', model: 'gpt-6.1-sol' },
    value: { records: [{ kind: 'memory', fields: [{ name: 'text', text: 'The fixture completed in staging.', sourceRef: claim.id }] }] } });
  assert.equal(result.status, 'committed');
  assert.equal((await claimCapture(options)).status, 'idle');
  const saved = await createStorage(options); const data = await saved.load(); saved.close();
  for (const item of items.slice(0, 4)) assert.deepEqual(data.records.find(row => row.id === item.id), item);
  const accepted = data.records.find(row => row.id === claim.id);
  assert.equal(accepted.receipts.at(-1).provider, 'codex');
  assert.equal(accepted.receipts.at(-1).model, 'gpt-6.1-sol');
});

test('a contextual decision whose reason does not name its alternative keeps the choice and the alternative, not the link', async () => {
  const { QUOTED_RECIPE } = await import('../src/internal/extraction-contract.js');
  // The fifth live run's session summary, and the fields the extractor proposed for it.
  const title = '**What I changed:** hours and rates are scaled to integer hundredths, multiplied as integers, then rounded half up to cents with integer arithmetic and formatted as a string.';
  const chosen = 'hours and rates are scaled to integer hundredths, multiplied as integers, then rounded half up to cents with integer arithmetic and formatted as a string.';
  const alternative = 'the obvious fix is `Math.round(h * r * 100) / 100`. I checked it against the four sample rows and it fails two of them: `1.15 × 10.10` gives `11.61` (expected `11.62`), and `0.7 × 18.15` gives `12.70` (expected `12.71`).';
  const reason = 'Both products land just below the half cent in floating point, so the simple version would underpay those lines.';
  const source = 'The pay check passes now. I only changed `src/pay-total.js`; the check and `samples/pay.csv` are untouched.\n\n'
    + '**What was wrong:** `linePay` multiplied the two floats and called `toFixed(2)`. `2.3 × 10.05` is `23.114999…` in binary, so it rounded down to `23.11` instead of `23.12`.\n\n'
    + `${title}\n\n**Why not the simpler option:** ${alternative} ${reason} The integer version gets all four right.\n\n`
    + 'One limit: the integer scaling assumes hours and rates have at most two decimal places, which matches the sample export. Inputs with more decimals would be rounded to hundredths before multiplying. Negative amounts are also not handled specially, since the rounding is half-up toward positive infinity.';
  const item = { id: 'capture-a5-stop', source: { role: 'assistant' } };
  const fields = [['title', title], ['chosen', chosen], ['alternative', alternative], ['reason', reason]].map(([name, text]) => ({ name, text, sourceRef: item.id }));
  const record = prepareExtraction(item, source, { records: [{ kind: 'decision', fields }] }, { provider: 'claude', recipe: QUOTED_RECIPE }).records[0];
  assert.equal(record?.kind, 'decision');
  assert.equal(record.values.chosen, chosen);
  assert.deepEqual(record.alternatives, [{ label: alternative }], 'the reason names nothing in the alternative, so it is not linked to it');
  assert.equal(Object.hasOwn(record.values, 'reason'), false);
  assert.ok(record.interpretation.fieldMapping.every(mapping => mapping.name !== 'reason'));
  assert.equal(record.interpretation.sourceText, source, 'the unlinked reason stays in the quoted source');
  assert.equal(record.claims.length, 1);
  assert.equal(record.claims[0].text, source);
  // A reason that does name the alternative is still linked to it.
  const named = fields.map(field => field.name === 'reason' ? { ...field, text: 'Both products land just below the half cent in floating point, so the simple version would underpay those lines.'.replace('the simple version', 'the obvious fix') } : field);
  const linkedSource = source.replace('so the simple version', 'so the obvious fix');
  const linked = prepareExtraction(item, linkedSource, { records: [{ kind: 'decision', fields: named }] }, { provider: 'claude', recipe: QUOTED_RECIPE }).records[0];
  assert.equal(linked.alternatives[0].reasonRejected, named[3].text);
  // Two alternatives and a reason: nothing says which one it rejects, so it is not linked and the decision stays.
  const two = [...fields, { name: 'alternative', text: 'Inputs with more decimals would be rounded to hundredths before multiplying.', sourceRef: item.id }];
  const both = prepareExtraction(item, source, { records: [{ kind: 'decision', fields: two }] }, { provider: 'claude', recipe: QUOTED_RECIPE }).records[0];
  assert.equal(both.kind, 'decision');
  assert.ok(both.alternatives.every(entry => !Object.hasOwn(entry, 'reasonRejected')));
});
