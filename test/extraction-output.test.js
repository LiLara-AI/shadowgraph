import test from 'node:test';
import assert from 'node:assert/strict';
import { extractionText, extractionPrompt, prepareExtraction } from '../src/internal/extraction-output.js';
import { DELIVERY_FRAME, deliveryEndLine } from '../src/internal/delivery-marker.js';
const item = { id: 'capture_fixture', observedAt: '2026-10-01T00:00:00.000Z', source: { role: 'user' } };
const text = 'The fixture completed in staging.';
const field = (name, value = text, sourceRef = item.id) => ({ name, text: value, sourceRef });

test('extraction output preserves typed fields and copies locally verified evidence', () => {
  for (const [kind, names] of [['decision', ['title', 'chosen', 'alternative']], ['attempt', ['solution', 'result', 'reason']], ['memory', ['text']]]) {
    const result = prepareExtraction(item, text, { records: [{ kind, fields: names.map(name => field(name)) }] });
    assert.equal(result.records.length, 1); assert.equal(result.records[0].kind, kind);
    assert.equal(result.records[0].claims.length, 1, 'one source span is not repeated support');
    assert.equal(result.records[0].claims[0].class, 'quoted');
    assert.equal(result.records[0].claims[0].evidence, text.slice(0, -1));
    assert.equal(result.unsupported.length, 0);
  }
});

test('extraction output cannot assign trust, authority, kinds or unsupported canonical text', () => {
  for (const extra of [{ verificationStatus: 'verified' }, { erasureToken: 'forged' }, { access: [] }, { confidence: 1 }]) {
    assert.throws(() => prepareExtraction(item, text, { records: [{ kind: 'memory', fields: [field('text')], ...extra }] }), { code: 'extraction_schema_invalid' });
  }
  for (const fields of [[field('text', text, 'foreign-source')], [field('text', 'All production work succeeded.')]]) {
    const value = prepareExtraction(item, text, { records: [{ kind: 'memory', fields }] }); assert.equal(value.records.length, 0); assert.equal(value.unsupported.length, 1);
  }
});

test('valid repeated fields deduplicate identical observations and retain conflicting observations without retry', () => {
  const same = prepareExtraction(item, text, { records: [{ kind: 'memory', fields: [field('text'), field('text')] }] });
  assert.equal(same.records.length, 1); assert.equal(same.records[0].claims.length, 1);
  // Both spellings are locally supported by the same span. Different field
  // assignments are retained once as provenance, without choosing a value.
  const alternate = text.slice(0, -1);
  assert.equal(prepareExtraction(item, text, { records: [{ kind: 'memory', fields: [field('text', alternate)] }] }).records.length, 1);
  const conflict = prepareExtraction(item, text, { records: [{ kind: 'memory', fields: [field('text'), field('text', alternate)] }] });
  assert.equal(conflict.records.length, 0); assert.equal(conflict.unsupported.length, 1);
  assert.ok(conflict.unsupported.every(x => x.failingDimension === 'field_conflict' && x.supportedClass === 'quoted'));
});

test('extraction strips self-delivery and redacts input and unsupported output', () => {
  const body = `${DELIVERY_FRAME}\nhead: {}\nitem: {"title":"Self evidence"}\n`;
  const block = `${body}${deliveryEndLine(Buffer.byteLength(body))}`;
  assert.equal(extractionText(block).trim(), '');
  const prompt = extractionPrompt(item, extractionText(`${block}\n${text}`));
  assert.equal(prompt.includes('Self evidence'), false); assert.ok(prompt.includes(text));
  const secret = 'ghp_' + 'A'.repeat(36);
  assert.equal(extractionText(`token=${secret}`).includes(secret), false);
  assert.equal(extractionText(`Before.\ntoken=${secret}\nAfter.`), 'Before.\n[REDACTED]\nAfter.', 'redaction preserves safe context instead of withholding the whole input');
  const result = prepareExtraction(item, text, { records: [{ kind: 'memory', fields: [field('text', `token=${secret}`, secret)] }] });
  assert.equal(result.records.length, 0); assert.equal(JSON.stringify(result).includes(secret), false);
});

// Independent review F1/F2 (record 32 D2/D3): a decision said in a sentence that
// stands alone keeps its parts -- chosen, rejected alternative, stated reason --
// each the sentence's own words, when the model proposes only the phrases; a
// decision the sentence does not establish is kept as the message itself; and
// nothing the ordinary verifier refuses is accepted by either route.
const DECISION = 'For the config loader we will use the streaming tokenizer instead of the per-line regex parser, because the regex parser cannot handle nested quotes.';
const phrases = (chosen = 'use the streaming tokenizer', alternative = 'the per-line regex parser', reason = 'the regex parser cannot handle nested quotes') => ({ kind: 'decision',
  fields: [field('title', 'Config loader parser'), field('chosen', chosen), ...(alternative ? [field('alternative', alternative)] : []), ...(reason ? [field('reason', reason)] : [])] });
const kinds = result => result.records.map(record => record.kind);

test('a decision sentence that stands alone is kept as a typed decision with its alternative and reason', () => {
  const result = prepareExtraction(item, DECISION, { records: [phrases()] });
  assert.deepEqual(kinds(result), ['decision']);
  const [decision] = result.records;
  assert.deepEqual(decision.values, { title: 'For the config loader we will use the streaming tokenizer', chosen: 'the streaming tokenizer' });
  assert.deepEqual(decision.alternatives, [{ label: 'the per-line regex parser', reasonRejected: 'the regex parser cannot handle nested quotes' }]);
  assert.equal(decision.claims[0].class, 'quoted'); assert.equal(decision.claims[0].evidence, DECISION.slice(0, -1));
  for (const claim of decision.claims.slice(1)) {
    assert.equal(claim.rule, 'decision-frame-v1'); assert.equal(claim.evidence, DECISION.slice(claim.span.start, claim.span.end)); assert.equal(claim.evidence, claim.text);
  }
  // The model's phrasing of a part need not repeat an article or the verb, and parts it leaves out are still the sentence's.
  for (const proposal of [phrases('the streaming tokenizer', 'per-line regex parser', 'because the regex parser cannot handle nested quotes'), phrases('streaming tokenizer', null, null)]) {
    assert.deepEqual(prepareExtraction(item, DECISION, { records: [proposal] }).records[0].alternatives, decision.alternatives);
  }
  for (const [source, chosen, alternatives] of [
    ["Let's go with the SQLite store rather than the JSON file.", 'the SQLite store', [{ label: 'the JSON file' }]],
    ['We decided to keep the v2 schema.', 'the v2 schema', []],
    ["- I'll switch to node-fetch in place of axios because axios adds 2 MB.", 'node-fetch', [{ label: 'axios', reasonRejected: 'axios adds 2 MB' }]]
  ]) {
    const typed = prepareExtraction(item, source, { records: [{ kind: 'decision', fields: [field('title', chosen), field('chosen', chosen)] }] });
    assert.deepEqual(kinds(typed), ['decision'], source); assert.equal(typed.records[0].values.chosen, chosen, source); assert.deepEqual(typed.records[0].alternatives, alternatives, source);
  }
  // The model's own whole-message memory lands on the sentence's place: it is the same experience, recorded once.
  assert.deepEqual(kinds(prepareExtraction(item, DECISION, { records: [phrases(), { kind: 'memory', fields: [field('text', DECISION)] }] })), ['decision']);
});

test('no decision is read from words that turn it; the message is kept as it is said, or not at all', () => {
  // Each case is proposed with its chosen part only, which its positive twin
  // accepts, so it fails for the words it adds and for nothing else.
  const chosenOnly = chosen => ({ records: [{ kind: 'decision', fields: [field('title', 'Parser choice'), field('chosen', chosen)] }] });
  for (const [source, chosen] of [[DECISION, 'use the streaming tokenizer'], ['We will use the streaming tokenizer instead of the per-line regex parser.', 'use the streaming tokenizer'],
    ['We will use SQLite instead of JSON because JSON is slow.', 'SQLite'], ['In the parser, we will use SQLite.', 'SQLite'], ['We will use option B.', 'option B'],
    ['For the report exporter we will use the streaming CSV writer instead of the in-memory table builder, because the in-memory builder runs out of memory on large reports.', 'the streaming CSV writer']]) {
    assert.deepEqual(kinds(prepareExtraction(item, source, chosenOnly(chosen))), ['decision'], `positive twin: ${source}`);
  }
  for (const [label, source, chosen = 'use the streaming tokenizer'] of [
    ['a condition after the reason', 'We will use SQLite instead of JSON because JSON is slow, unless the team objects.', 'SQLite'],
    ['a qualifier after the reason', 'We will use SQLite instead of JSON because JSON is slow, but not for prod.', 'SQLite'],
    ['a hedged reason', 'We will use SQLite instead of JSON because JSON may be slow.', 'SQLite'],
    ['a reason about the chosen part', 'We will use SQLite instead of JSON because it is faster.', 'SQLite'],
    ['a reason with no alternative to hold it', 'We will use SQLite because it is simple, unless the team objects.', 'SQLite'],
    ['a reason and no alternative', 'We will use SQLite because SQLite is simple.', 'SQLite'],
    ['a missed sentence end', 'We will use option B. Just kidding.', 'option B. Just kidding'],
    ['a quantity as a lead', 'In some cases, we will use SQLite.', 'SQLite'],
    ['a time in a lead', 'For the next release, we will use SQLite.', 'SQLite'],
    ['an outage as a lead', 'In case of an outage, we will use SQLite.', 'SQLite'],
    ['someone as a lead', "In Bob's opinion, we will use SQLite.", 'SQLite'],
    ['a while as a lead', 'For the moment, we will use SQLite.', 'SQLite'],
    ['a while as a lead, again', 'In the meantime, we will use SQLite.', 'SQLite'],
    ['an event as a lead', 'In the event of an outage, we will use SQLite.', 'SQLite'],
    ['a reason in words both parts share', 'We will use the JSON store instead of the SQLite store because the store is simple.', 'the JSON store'],
    ['negated', 'For the config loader we will not use the streaming tokenizer instead of the per-line regex parser.'],
    ['contracted negation', "We won't use the streaming tokenizer instead of the per-line regex parser."],
    ['hedged', 'We might use the streaming tokenizer instead of the per-line regex parser.'],
    ['hedged lead', 'Maybe we will use the streaming tokenizer instead of the per-line regex parser.'],
    ['a hedge as a lead', 'In theory, we will use the streaming tokenizer instead of the per-line regex parser.'],
    ['a time as a lead', 'For now, we will use the streaming tokenizer instead of the per-line regex parser.'],
    ['an owner as a lead', 'For our loader, we will use the streaming tokenizer instead of the per-line regex parser.'],
    ['someone else decides', 'They will use the streaming tokenizer instead of the per-line regex parser.'],
    ['an opinion about a decision', 'I think we will use the streaming tokenizer instead of the per-line regex parser.'],
    ['a time on the choice', 'We will use the streaming tokenizer tomorrow instead of the per-line regex parser.'],
    ['a condition on the choice', 'We will use the streaming tokenizer if it is fast instead of the per-line regex parser.'],
    ['a negated alternative', 'We will use the streaming tokenizer instead of not the per-line regex parser.'],
    ['a retraction after it', `${DECISION} Kidding.`],
    ['untested', `${DECISION} Untested.`],
    ['another request beside it', `${DECISION} Run node parse-demo.mjs sample.cfg.`],
    ['an aside after the reason', 'We will use the streaming tokenizer instead of the per-line regex parser (for now).']
  ]) {
    const result = prepareExtraction(item, source, chosenOnly(chosen));
    assert.deepEqual(result.records.map(record => ({ kind: record.kind, values: record.values })), [{ kind: 'memory', values: { text: source } }], label);
    assert.equal(result.records[0].claims[0].class, 'quoted', label);
  }
  // A question decides nothing, and is not kept either.
  for (const source of ['Should we use the streaming tokenizer instead of the per-line regex parser?', 'We will use the streaming tokenizer instead of the per-line regex parser, right?']) {
    assert.deepEqual(prepareExtraction(item, source, { records: [phrases()] }).records, [], source);
  }
  // The model's reading must be the sentence's: a swapped or invented part is another reading.
  for (const proposal of [phrases('use the per-line regex parser', 'the streaming tokenizer'), phrases(undefined, 'the regex parser'), phrases(undefined, undefined, 'the tokenizer is faster')]) {
    assert.deepEqual(kinds(prepareExtraction(item, DECISION, { records: [proposal] })), ['memory']);
  }
  // A decision cited only to another source keeps nothing.
  assert.deepEqual(prepareExtraction(item, DECISION, { records: [{ kind: 'decision', fields: [field('chosen', 'use the streaming tokenizer', 'foreign-source')] }] }).records, []);
});

test('a verified decision reason is the reason its one rejected alternative was rejected, and no other', () => {
  const one = prepareExtraction(item, text, { records: [{ kind: 'decision', fields: ['title', 'chosen', 'alternative', 'reason'].map(name => field(name)) }] });
  assert.deepEqual(one.records[0].alternatives, [{ label: text, reasonRejected: text }]); assert.equal(one.records[0].reason, null);
  assert.equal(one.unsupported.length, 0);
  const none = prepareExtraction(item, text, { records: [{ kind: 'decision', fields: ['title', 'chosen', 'reason'].map(name => field(name)) }] });
  assert.deepEqual(none.records[0].alternatives, []);
  assert.deepEqual(none.unsupported.map(x => [x.failingDimension, x.supportedClass]), [['unsupported_field', 'quoted']]);
});
