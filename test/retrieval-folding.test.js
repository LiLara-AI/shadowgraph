import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { foldText } from '../src/hybrid-search.js';
import { runEvaluation } from '../scripts/retrieval-eval.mjs';

const decision = (graph, title, project = 'p') =>
  graph.addDecision({ project, title, chosen: 'x' });

test('Arabic diacritics no longer split a word into single letters', () => {
  // The tokenizer matched [\p{L}\p{N}]+, and harakat are \p{Mn}, so they acted
  // as separators: "muhammad" with tashkeel became four one-letter tokens.
  const tokens = (value) => foldText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
  assert.deepEqual(tokens('مُحَمَّد'), ['محمد']);
  assert.deepEqual(tokens('مُحَمَّد'), tokens('محمد'), 'with and without tashkeel are the same word');
});

test('Arabic orthographic variants of the SAME word fold to one form', () => {
  const fold = (value) => foldText(value);
  assert.equal(fold('إسلام'), fold('اسلام'), 'hamza seat is casual typing, not a different word');
  assert.equal(fold('مكتبة'), fold('مكتبه'), 'ta marbuta, same word');
  assert.equal(fold('مصطفى'), fold('مصطفي'), 'same name, variant spelling');
  assert.equal(fold('كــتاب'), fold('كتاب'), 'tatweel is decorative');
});

test('the folds that collapse genuinely DIFFERENT words are known and accepted', () => {
  // This is the precision cost of the recall gain, asserted so it stays a known
  // trade rather than a surprise. Both pairs are real minimal pairs, not
  // spelling variants of one word.
  assert.equal(foldText('على'), foldText('علي'), 'ى->ي collapses "on/about" with the name Ali');
  assert.equal(foldText('آمن'), foldText('امن'), 'alef madda collapses "safe/believed" with "security"');
  // Taken deliberately: a false positive is visible and rankable, while a record
  // nobody can reach is neither. Documented in docs/contracts/search-contract.md.
});

// Folded strings being equal only says the collision exists. It says nothing
// about which record a caller actually gets first, which is what they
// experience. These assert ORDER, with both meanings present in the corpus.

test('for a collided pair, the record holding the typed word ranks above the fold-only match', () => {
  const graph = createShadowGraph();
  // "on/about" -- the preposition.
  const preposition = graph.addDecision({ project: 'p', title: 'قرار بشأن الاعتماد على التخزين المحلي', chosen: 'a' });
  // "Ali" -- the name. Folds to the same string as the preposition.
  const name = graph.addDecision({ project: 'p', title: 'قرار راجعه علي قبل التنفيذ', chosen: 'b' });

  const forName = graph.search('علي', { project: 'p' });
  assert.equal(forName.items.length, 2, 'both are still reachable -- recall is not narrowed');
  assert.equal(forName.items[0].record.id, name.id, 'the exact original-text match ranks first');
  assert.ok(forName.items[0].score > forName.items[1].score, 'and it does so by score, not insertion order');

  const forPreposition = graph.search('على', { project: 'p' });
  assert.equal(forPreposition.items.length, 2);
  assert.equal(forPreposition.items[0].record.id, preposition.id, 'and symmetrically for the other meaning');
  assert.ok(forPreposition.items[0].score > forPreposition.items[1].score);
});

test('the same preference applies to the Latin collision and ignores case only', () => {
  const graph = createShadowGraph();
  const accented = graph.addDecision({ project: 'p', title: 'Parse the résumé attachment', chosen: 'a' });
  const plain = graph.addDecision({ project: 'p', title: 'Parse the resume attachment', chosen: 'b' });

  const forPlain = graph.search('RESUME', { project: 'p' });
  assert.equal(forPlain.items.length, 2, 'folding still finds both');
  assert.equal(forPlain.items[0].record.id, plain.id, 'case is ignored, diacritics are not');

  const forAccented = graph.search('résumé', { project: 'p' });
  assert.equal(forAccented.items[0].record.id, accented.id);
});

test('the ranking preference cannot resurrect a record the scope filter excluded', () => {
  const graph = createShadowGraph();
  graph.addDecision({ project: 'other', title: 'قرار راجعه علي قبل التنفيذ', chosen: 'b' });
  const mine = graph.addDecision({ project: 'p', title: 'قرار بشأن الاعتماد على التخزين المحلي', chosen: 'a' });

  const hits = graph.search('علي', { project: 'p' });
  assert.equal(hits.items.length, 1, 'the exact match in another project stays invisible');
  assert.equal(hits.items[0].record.id, mine.id);
});

test('an exact identifier match is reinforced, never displaced by a folded variant', () => {
  const graph = createShadowGraph();
  // Same field on both records, so field weight cannot decide it and the only
  // difference is exact original text versus a form that survives folding.
  const exact = graph.addDecision({ project: 'p', title: 'Rate limit', chosen: 'six-hundred-per-minute' });
  const variant = graph.addDecision({ project: 'p', title: 'Rate limit', chosen: 'six-hundred-per-minuté' });

  const hits = graph.search('six-hundred-per-minute', { project: 'p' });
  assert.equal(hits.items.length, 2, 'the folded variant is still reachable');
  assert.equal(hits.items[0].record.id, exact.id, 'but the literal identifier ranks first');
  assert.ok(hits.items[0].score > hits.items[1].score);

  // And asking for the accented form prefers that one, so neither is privileged
  // by anything other than what the caller typed.
  assert.equal(graph.search('six-hundred-per-minuté', { project: 'p' }).items[0].record.id, variant.id);
});

test('stored text is never rewritten by matching or ranking', () => {
  const graph = createShadowGraph();
  const original = 'قرار بشأن الاعتماد على التخزين المحلي';
  const record = graph.addDecision({ project: 'p', title: original, chosen: 'résumé-parser' });
  graph.search('علي', { project: 'p' });
  graph.search('resume', { project: 'p' });

  const stored = graph.exportData().records.find((item) => item.id === record.id);
  assert.equal(stored.title, original, 'the diacritics and alef maqsura are still there');
  assert.equal(stored.chosen, 'résumé-parser', 'and so is the accented identifier');
});

test('Latin diacritics fold in both directions', () => {
  assert.equal(foldText('Résumé'), 'resume');
  assert.equal(foldText('CAFÉ'), foldText('cafe'));
});

test('folding does not collapse genuinely different words', () => {
  assert.notEqual(foldText('cache'), foldText('cafe'), 'a near miss stays a miss');
  assert.notEqual(foldText('قرار'), foldText('قرر'));
  assert.notEqual(foldText('resume'), foldText('assume'));
});

test('an Arabic query without tashkeel now finds a record written with it', () => {
  const graph = createShadowGraph();
  const record = decision(graph, 'مُراجَعَة إعدادات المَكتبة');
  const hits = graph.search('مراجعة', { project: 'p' });
  assert.equal(hits.items.length, 1, 'this returned zero results before the fold');
  assert.equal(hits.items[0].record.id, record.id);
  assert.ok(hits.items[0].matched.includes('title'), 'and it still says which field matched');
});

test('substring matching is preserved, which is what the search contract promises', () => {
  const graph = createShadowGraph();
  decision(graph, 'Serve reads from a regional cache');
  // The contract states this explicitly: `cach` matches `cache`, deliberately,
  // so a tokenising matcher must not replace it.
  assert.equal(graph.search('cach', { project: 'p' }).items.length, 1);
  assert.equal(graph.search('egional', { project: 'p' }).items.length, 1);
});

test('folding widens matching without weakening scope isolation or explainability', () => {
  const graph = createShadowGraph();
  decision(graph, 'مُراجَعَة الإعدادات', 'p');
  decision(graph, 'مُراجَعَة الإعدادات', 'other');

  const hits = graph.search('مراجعة', { project: 'p' });
  assert.equal(hits.items.length, 1, 'the other project is not reachable');
  assert.equal(hits.items[0].record.project, "p");
  assert.equal(hits.items[0].matchedBy, 'content');
  assert.ok(hits.items[0].matched.length > 0, 'every hit still names a real field');
});

test('the evaluation reports Arabic orthography and leaves meaning-based cases alone', () => {
  const report = runEvaluation({ split: 'dev' });

  // What the fold actually bought, measured rather than asserted.
  for (const engine of ['search', 'retrieve', 'recall']) {
    const arabic = report.engines[engine].byCategory.arabicOrthography;
    assert.equal(arabic.passed, arabic.cases, `${engine} handles Arabic orthography`);
    assert.equal(report.engines[engine].leaks, 0, `${engine} leaks nothing across projects`);
  }

  // What it did NOT buy. Folding is character-level; it cannot reach meaning,
  // and the evaluation must keep saying so rather than quietly dropping the
  // categories that still fail.
  const searchEngine = report.engines.search.byCategory;
  assert.equal(searchEngine.paraphrase.passed, 0, 'paraphrase still fails without embeddings');
  assert.ok(searchEngine.crossLanguage.passed < searchEngine.crossLanguage.cases, 'cross-language still fails');
});
