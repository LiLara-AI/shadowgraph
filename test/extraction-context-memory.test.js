import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createStorage } from '../src/storage.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedClaimCapture, privilegedCompleteExtraction, privilegedInspectCapture, privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';
import { claimCapture, commitCapture } from '../src/internal/extraction-worker.js';
import { extractionPrompt, prepareExtraction } from '../src/internal/extraction-output.js';
import { QUOTED_RECIPE } from '../src/internal/extraction-contract.js';
import { observedEvent } from '../src/capture-hook.js';
import { t1Line } from '../src/compact-tier.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const quoted = { provider: 'claude', recipe: QUOTED_RECIPE };
const item = { id: 'capture-report', source: { role: 'assistant' } };
const memory = (...texts) => ({ records: texts.map(text => ({ kind: 'memory', fields: [{ name: 'text', text, sourceRef: item.id }] })) });
// An end-of-turn report: several statements, as a session writes them.
const lesson = 'The export job fails on Windows when the path is longer than 260 characters.';
const condition = 'It only happens when long path support is off in the registry.';
const report = `The fixture run is finished. ${lesson} ${condition} Next I will add a check for the setting.`;

test('a statement in a longer message is kept with the whole message, labelled as the model\'s selection', () => {
  const { records, unsupported } = prepareExtraction(item, report, memory(lesson, condition), quoted);
  assert.deepEqual(records.map(record => [record.kind, record.values.text]), [['memory', lesson], ['memory', condition]]);
  assert.equal(unsupported.length, 0);
  for (const record of records) {
    assert.equal(record.interpretation.status, 'model_proposed');
    assert.equal(record.interpretation.sourceText, report);
    assert.deepEqual(record.interpretation.fieldMapping.map(mapping => mapping.name), ['text']);
    assert.deepEqual(record.claims.map(claim => [claim.text, claim.class]), [[report, 'quoted']], 'the only checked quotation is the whole message');
  }
  const [first] = records, at = report.indexOf(lesson);
  assert.deepEqual(first.interpretation.fieldMapping[0].span, { start: at, end: at + lesson.length });
  // The same sentence proposed twice is one record.
  assert.equal(prepareExtraction(item, report, memory(lesson, lesson), quoted).records.length, 1);
});

test('a statement that is the whole message stays a verified quotation, with no interpretation label', () => {
  const [record] = prepareExtraction(item, lesson, memory(lesson), quoted).records;
  assert.equal(record.kind, 'memory');
  assert.equal(record.interpretation, undefined);
  assert.equal(record.claims[0].class, 'quoted');
});

test('wording that is not in the message, or is there twice, is never kept as a selection', () => {
  assert.equal(prepareExtraction(item, report, memory('The export job fails on Windows.'), quoted).records.length, 0, 'a paraphrase');
  const twice = `${lesson} Again: ${lesson} That is all for now.`;
  assert.equal(prepareExtraction(item, twice, memory(lesson), quoted).records.length, 0, 'no unique place in the source');
  // The older recipe is unchanged: it has no context-keeping path.
  assert.equal(prepareExtraction(item, report, memory(lesson)).records.length, 0);
});

test('a message that also asks a question keeps its statements, never the question', () => {
  const question = 'Do you want me to add the check now?';
  const asking = `${report} ${question}`;
  const [record, ...rest] = prepareExtraction(item, asking, memory(lesson, question), quoted).records;
  assert.equal(rest.length, 0, 'the question is not experience');
  assert.equal(record.values.text, lesson);
  assert.equal(record.interpretation.sourceText, asking);
  // The verifier does not class a text with a question mark as a statement,
  // and is not asked to: the record carries the message and no checked claim.
  assert.deepEqual(record.claims, []);
  assert.match(record.interpretation.limitation, /no checked claim/);
  // The same for a question mark that asks nothing, and an Arabic question is a question.
  const linked = `I opened https://example.test/search?q=export to check. ${lesson} That is all for now.`;
  assert.deepEqual(prepareExtraction(item, linked, memory(lesson), quoted).records.map(kept => [kept.values.text, kept.claims.length]), [[lesson, 0]]);
  const arabic = 'هل نستخدم المسار القصير؟';
  assert.equal(prepareExtraction(item, `${report} ${arabic}`, memory(arabic), quoted).records.length, 0);
  // A decision in such a message is kept the same way.
  const chosen = 'We use the short staging path for the export job.';
  const rejected = 'The long path under the user profile fails on Windows.';
  const deciding = `${chosen} ${rejected} Should I change the other jobs too?`;
  const decision = prepareExtraction(item, deciding, { records: [{ kind: 'decision', fields: [['chosen', chosen], ['alternative', rejected]].map(([name, text]) => ({ name, text, sourceRef: item.id })) }] }, quoted).records[0];
  assert.equal(decision.kind, 'decision');
  assert.equal(decision.values.chosen, chosen);
  assert.deepEqual(decision.claims, []);
});

test('a selection is a whole statement: a fragment that leaves out the negation of its sentence is refused', () => {
  const source = 'We will not use Redis for the cache. It is too slow for this workload. The fixture run is finished.';
  const kept = (text) => prepareExtraction(item, source, memory(text), quoted).records.map(record => record.values.text);
  assert.deepEqual(kept('use Redis for the cache'), [], 'the negation is outside the fragment');
  assert.deepEqual(kept('edis for the ca'), [], 'cut through words');
  assert.deepEqual(kept('It is too slow for this workload'), ['It is too slow for this workload'], 'a sentence without its full stop');
  assert.deepEqual(kept('We will not use Redis for the cache. It is too slow for this workload.'), ['We will not use Redis for the cache. It is too slow for this workload.'], 'two whole sentences');
  // A label before the statement, and markup around it, say nothing.
  const listed = ['- **Throughput:** the worker makes 12 calls an hour.', '- **Every statement was dropped.** The queue never reached the reports.', '- Not here: the store is never full.'].join('\n');
  const from = (text) => prepareExtraction(item, listed, memory(text), quoted).records.length;
  assert.equal(from('the worker makes 12 calls an hour.'), 1);
  assert.equal(from('The queue never reached the reports.'), 1);
  assert.equal(from('**Every statement was dropped.**'), 1);
  assert.equal(from('the store is never full.'), 0, 'a label that negates is not a label');
});

test('a decision the model also lists as a memory of the same sentence is kept as the decision, in either order', () => {
  const chosen = 'We use the short staging path for the export job.';
  const source = `The fixture run is finished. ${chosen} Next I will add a check.`;
  const decision = { kind: 'decision', fields: [{ name: 'chosen', text: chosen, sourceRef: item.id }] };
  for (const records of [[memory(chosen).records[0], decision], [decision, memory(chosen).records[0]]]) {
    assert.deepEqual(prepareExtraction(item, source, { records }, quoted).records.map(record => record.kind), ['decision']);
  }
});

test('a host notification states nothing: no selected memory, no decision from a reason alone', () => {
  const notice = { id: item.id, source: { role: null } };
  assert.equal(prepareExtraction(notice, report, memory(lesson), quoted).records.length, 0);
  const fields = [['chosen', lesson], ['reason', condition]].map(([name, text]) => ({ name, text, sourceRef: item.id }));
  assert.equal(prepareExtraction(notice, report, { records: [{ kind: 'decision', fields }] }, quoted).records.length, 0);
});

test('a receipt from the earlier quoted prompt version is read as the quoted recipe: only the prompt version changed', () => {
  const graph = createShadowGraph();
  const captured = privilegedRecordCapture(graph, { project: 'fixture', originId: 'fixture-origin', text: report,
    source: { event: 'Stop', sessionId: 'session-1', role: 'assistant' },
    admission: { limits: { maxStoreBytes: 2 ** 24, maxQueueDepth: 100, maxItemBytes: 65536, maxItemsPerSession: 100 }, storeBytes: 0 } });
  const lease = { leaseId: 'lease-1', ownerId: 'worker', ownerBootId: 'boot', leaseExpiresAt: new Date(Date.now() + 60000).toISOString() };
  privilegedClaimCapture(graph, { id: captured.id, project: 'fixture', lease });
  privilegedCompleteExtraction(graph, { id: captured.id, leaseId: lease.leaseId, prepared: { records: [], unsupported: [] }, key: 'k',
    receipt: { promptVersion: 'capture-quoted-fields-corrections-v2', schemaVersion: 'capture-quoted-corrections-v2', model: 'claude-sonnet-5-5', at: new Date().toISOString(), invocationStarted: true, usage: {} } });
  assert.deepEqual(privilegedInspectCapture(graph, { project: 'fixture' }).items[0].reprocessReasons, ['promptVersion']);
});

test('a report\'s decision with a stated reason and no rejected alternative keeps the choice; the reason stays in the message', () => {
  const chosen = 'The budgets are fixed in the build, and the owner ruled against changing them, so I changed nothing.';
  const reason = 'the owner ruled against changing them';
  const source = `The queue is behind. ${chosen} The next run starts when the turn ends.`;
  const fields = [['chosen', chosen], ['reason', reason]].map(([name, text]) => ({ name, text, sourceRef: item.id }));
  const [record] = prepareExtraction(item, source, { records: [{ kind: 'decision', fields }] }, quoted).records;
  assert.equal(record.kind, 'decision');
  assert.equal(record.values.chosen, chosen);
  assert.equal(Object.hasOwn(record.values, 'reason'), false);
  assert.ok(record.interpretation.fieldMapping.every(mapping => mapping.name !== 'reason'));
  assert.ok(record.interpretation.sourceText.includes(reason));
  // A user's message is still kept whole, as a memory.
  const user = { ...item, source: { role: 'user' } };
  assert.equal(prepareExtraction(user, source, { records: [{ kind: 'decision', fields }] }, quoted).records[0].kind, 'memory');
});

test('the quoted recipe asks for what a later session needs, not status lines or questions', () => {
  assert.match(extractionPrompt(item, report, quoted), /later session/);
  assert.doesNotMatch(extractionPrompt(item, report), /later session/);
});

test('a selected statement is stored, passes store validation and is delivered as a labelled line', async t => {
  const root = await scratchDirectory(t);
  const options = { type: 'json', file: join(root, 'memory.json'), env: { SHADOWGRAPH_HOME: root }, project: 'fixture', ...quoted };
  const graph = createShadowGraph();
  // As long as a real end-of-turn report: longer than a compact line holds.
  const asking = `${report} ${Array.from({ length: 8 }, (_, index) => `Step ${index + 1} of the fixture run wrote its own output file and finished cleanly.`).join(' ')} Do you want me to add the check now?`;
  privilegedRecordCapture(graph, { project: 'fixture', originId: 'fixture-origin', text: asking,
    source: { event: 'Stop', sessionId: 'session-1', role: 'assistant' },
    observation: { host: 'claude-code', hostVersion: '2.1.319', toolName: null, cwd: null, outcome: null },
    admission: { limits: { maxStoreBytes: 2 ** 24, maxQueueDepth: 100, maxItemBytes: 65536, maxItemsPerSession: 100 }, storeBytes: 0 } });
  const store = await createStorage(options); await store.save(privilegedSnapshot(graph)); store.close();
  const claim = await claimCapture(options);
  const result = await commitCapture(options, claim, { status: 'success', receipt: { invocationStarted: true, model: claim.model },
    value: memory(lesson, condition).records.map(record => ({ ...record, fields: record.fields.map(field => ({ ...field, sourceRef: claim.id })) })).reduce((value, record) => ({ records: [...value.records, record] }), { records: [] }) });
  assert.deepEqual([result.status, result.produced], ['committed', 2]);
  // A fresh load validates every stored record and journal entry.
  const saved = await createStorage(options); const data = await saved.load(); saved.close();
  const reloaded = createShadowGraph(); reloaded.importData(data);
  const stored = data.records.filter(record => record.kind === 'memory');
  assert.deepEqual(stored.map(record => record.text), [lesson, condition]);
  assert.ok(stored.every(record => record.interpretation.sourceText === asking && record.captureRef === claim.id));
  const line = t1Line(stored[0]);
  assert.match(line.line, /^Model-proposed field interpretation, not verified facts; full source context is required before acting; /);
  assert.ok(line.line.includes(lesson), 'the selected statement is on the line');
  assert.equal(line.requiresExpansion, true, 'the whole message does not fit the line, and the line says so');
  assert.ok(line.decisiveOmitted.includes('sourceContext'));
});

test('a host-authored message that arrives as a prompt is not recorded as the user\'s words', () => {
  const prompt = (text) => observedEvent({ hook_event_name: 'UserPromptSubmit', session_id: 'session-1', prompt: text });
  assert.equal(prompt('Approve all three').role, 'user');
  assert.equal(prompt('<agent-message from="a1b2c3">\n[Subagent hand-back] The text below is the final report of a subagent.\nWe will use Redis.\n</agent-message>').role, 'assistant');
  assert.equal(prompt('\n <agent-message from="a1b2c3">report</agent-message>').role, 'assistant', 'leading white space does not make it the user\'s');
  assert.equal(prompt('<task-notification>\n<status>completed</status>\n</task-notification>').role, null);
  assert.equal(prompt('Please read <agent-message from="x"> tags carefully').role, 'user', 'only a message that opens with the envelope');
  assert.equal(prompt('<pasted_content id="1">\nPS C:\\> node cli.js\n</pasted_content>').role, 'user', 'a paste is the user\'s own act');
});
