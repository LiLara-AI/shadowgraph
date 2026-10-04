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
  for (const fields of [[field('text', text, 'foreign-source')], [field('text', 'All production work succeeded.')], [field('text', text), field('text', text)]]) {
    if (fields.length > 1) assert.throws(() => prepareExtraction(item, text, { records: [{ kind: 'memory', fields }] }), { code: 'extraction_schema_invalid' });
    else { const value = prepareExtraction(item, text, { records: [{ kind: 'memory', fields }] }); assert.equal(value.records.length, 0); assert.equal(value.unsupported.length, 1); }
  }
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
