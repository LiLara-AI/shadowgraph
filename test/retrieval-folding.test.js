import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createShadowGraph } from '../src/shadowgraph.js';
import { foldText } from '../src/hybrid-search.js';
import { FIDELITY_CASES, annotateRelevant, buildGraph, evg10Of, groundCases, missesOf, readDefault, runEvaluation, runFidelity } from '../scripts/retrieval-eval.mjs';
import { privilegedSnapshot } from '../src/internal/snapshot.js';

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

  const stored = privilegedSnapshot(graph).records.find((item) => item.id === record.id);
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

test('the evaluation records what happened to each relevant record, and refuses a case the corpus cannot ground', () => {
  const report = runEvaluation({ split: 'dev' });

  for (const [name, engine] of Object.entries(report.engines)) {
    for (const result of engine.cases) {
      // The annotation agrees with the score it does not feed.
      const delivered = result.relevant.filter((item) => item.outcome === 'delivered').length;
      if (result.recall !== null) assert.equal(delivered, Math.round(result.recall * result.relevant.length), `${name} ${result.id}`);
      // A record reached only by expanding a delivered line has no rank either.
      for (const item of result.relevant) {
        if (item.outcome === 'missed') assert.equal(item.rank, null, `${name} ${result.id} ${item.record}`);
        if (item.rank === null) assert.ok(['missed', 'expanded'].includes(item.outcome), `${name} ${result.id} ${item.record}`);
      }
    }
    const annotated = engine.cases.reduce((sum, result) => sum + result.relevant.length, 0);
    assert.equal(Object.values(engine.relevantOutcomes).reduce((a, b) => a + b, 0), annotated);
  }

  assert.throws(() => groundCases([{ id: 'typo', expect: ['d-missing'] }]), /not in the corpus/);
  assert.throws(() => groundCases([{ id: 'wrong-project', expect: ['d-trap'] }]), /outside project/);
});

// Plan v1.4.4 §17.3, G-5 §6.2 and G5-9 (PR-28): the evaluation also runs the
// default read's relevance path (compact lines), counts a relevant record
// reached only by expanding a delivered line, and keeps a ledger of every
// grounded miss with the signals the engine reported.
test('the default read is evaluated, and its misses are recorded with the signals it reported', () => {
  const report = runEvaluation({ split: 'dev' });
  assert.deepEqual(Object.keys(report.engines), ['search', 'retrieve', 'recall', 'context']);
  for (const engine of Object.values(report.engines)) assert.deepEqual(Object.keys(engine.relevantOutcomes), ['delivered', 'ranked', 'expanded', 'missed']);
  const misses = report.missLedger.filter((entry) => entry.engine === 'context' && entry.evidence === 'grounded_case' && entry.stage === 'not_ranked');
  assert.ok(misses.length > 0, 'the default read misses at least one grounded relevant record');
  const { graph, ids } = buildGraph();
  const stored = new Set(privilegedSnapshot(graph).records.map((record) => record.id));
  for (const miss of misses) {
    assert.equal(stored.has(ids.get(miss.record)), true, `${miss.case}: the record it missed is in the store`);
    assert.equal(miss.reason, 'no_signal_match');
    assert.equal(miss.signals.semantic.available, false);
    assert.ok(miss.unavailableSignals.includes('semantic'), `${miss.case} names the unavailable semantic signal`);
  }
  // The ledger holds exactly what the engines' output produced: every relevant
  // record missed or ranked too low, and for the default read every relevant
  // record only its fallback delivered (§6.2(a)).
  const annotated = Object.entries(report.engines).flatMap(([engine, { cases }]) => cases.flatMap((result) => result.relevant.flatMap((item) => {
    if (result.fallback && item.rank !== null) return [`${engine}:${result.id}:${item.record}:not_ranked:null:fallback_recovery`];
    if (item.outcome === 'missed') return [`${engine}:${result.id}:${item.record}:not_ranked:null:grounded_case`];
    if (item.outcome === 'ranked') return [`${engine}:${result.id}:${item.record}:ranked_not_delivered:${item.rank}:grounded_case`];
    return [];
  })));
  const recorded = report.missLedger.filter((entry) => !entry.case.startsWith('fid-'))
    .map((entry) => `${entry.engine}:${entry.case}:${entry.record}:${entry.stage}:${entry.rank}:${entry.evidence}`);
  assert.deepEqual(recorded.sort(), annotated.sort());
  const recoveries = report.missLedger.filter((entry) => entry.evidence === 'fallback_recovery');
  assert.equal(report.engines.context.fallbackAnswered, report.engines.context.cases.filter((result) => result.fallback).length);
  assert.ok(recoveries.length > 0, 'a relevant record the fallback delivered is recorded, not credited as ranked');
  for (const entry of recoveries) assert.deepEqual([entry.engine, entry.stage, entry.rank, entry.reason], ['context', 'not_ranked', null, 'relevance_not_established']);
  assert.ok(report.missLedger.some((entry) => entry.signals !== null), 'G5-9: a grounded miss carries its signals');
});

test('fidelity: a delivered line keeps the phrases its meaning rests on, and a lost one is recorded as a miss', () => {
  const report = runEvaluation({ split: 'dev' });
  assert.deepEqual(report.fidelity.map(({ case: id, tier, lost }) => ({ id, tier, lost })), FIDELITY_CASES.map(({ id }) => ({ id, tier: 'T1', lost: [] })));
  const { graph, ids } = buildGraph();
  const lossy = runFidelity(graph, ids, [{ ...FIDELITY_CASES[0], id: 'fid-lossy', mustPreserve: ['retried after one hour'] }]);
  assert.deepEqual(lossy.results.map(({ lost }) => lost), [['retried after one hour']]);
  assert.deepEqual(lossy.misses.map(({ case: id, engine, stage, tier, record, lost }) => ({ id, engine, stage, tier, record, lost })), [
    { id: 'fid-lossy', engine: 'context', stage: 'delivered_line_without_decisive_meaning', tier: 'T1', record: FIDELITY_CASES[0].record, lost: ['retried after one hour'] }
  ]);
  const { items } = graph.context({ project: FIDELITY_CASES[0].project, query: FIDELITY_CASES[0].query, compact: true }).relevant;
  const at = items.findIndex((item) => item.tier === 'T1' && item.line.recordId === ids.get(FIDELITY_CASES[0].record));
  assert.equal(lossy.misses[0].rank, at + 1);
  assert.deepEqual(lossy.misses[0].boundRevision, items[at].line.boundRevision);
  // Verbatim: a phrase in another letter case is lost.
  assert.deepEqual(runFidelity(graph, ids, [{ ...FIDELITY_CASES[1], id: 'fid-case', mustPreserve: ['eu tenants only'] }]).results[0].lost, ['eu tenants only']);
  // A record only the fallback delivered, in full, is a fallback recovery, not a kept line.
  const recovered = runFidelity(graph, ids, [{ ...FIDELITY_CASES[1], id: 'fid-fallback', query: 'zebra crossing' }]);
  assert.deepEqual(recovered.results, [{ case: 'fid-fallback', record: FIDELITY_CASES[1].record, tier: 'T2', lost: [], fallback: true }]);
  assert.deepEqual(recovered.misses.map(({ evidence, stage, rank, reason }) => ({ evidence, stage, rank, reason })), [{ evidence: 'fallback_recovery', stage: 'not_ranked', rank: null, reason: 'relevance_not_established' }]);
  // A record not delivered at all loses every phrase, and is a miss of the ranking.
  const absent = runFidelity(graph, ids, [{ ...FIDELITY_CASES[0], id: 'fid-absent', query: 'regional cache' }]);
  assert.deepEqual(absent.results, [{ case: 'fid-absent', record: FIDELITY_CASES[0].record, tier: null, lost: FIDELITY_CASES[0].mustPreserve }]);
  assert.deepEqual(absent.misses.map(({ stage, rank, reason }) => ({ stage, rank, reason })), [{ stage: 'not_ranked', rank: null, reason: 'no_signal_match' }]);
});

test('the default read counts a record reached only by expanding a delivered line as expanded', () => {
  const graph = createShadowGraph();
  const queue = graph.addDecision({ project: 'p', title: 'message queue', chosen: 'postgres outbox' });
  const replacement = graph.addDecision({ project: 'p', title: 'broker migration', chosen: 'managed broker' });
  graph.supersedeDecision({ project: 'p', decisionId: queue.id, replacementId: replacement.id });
  const answer = readDefault(graph, 'p', 'broker migration');
  assert.equal(answer.ids.includes(queue.id), false, 'the superseded decision is not returned');
  assert.equal(answer.expanded.has(queue.id), true, 'but the delivered line\'s expansion reaches it');
  assert.deepEqual(annotateRelevant({ expect: ['queue'] }, answer.ids, new Map([['queue', queue.id]]), answer.expanded), [{ record: 'queue', rank: null, outcome: 'expanded' }]);
});

test('annotation and the ledger classify every outcome, and a fallback recovery whatever its position', () => {
  const ids = new Map([['a', 'id-a'], ['b', 'id-b'], ['c', 'id-c'], ['d', 'id-d']]);
  const testCase = { id: 'synthetic', query: 'q', expect: ['a', 'b', 'c', 'd'] };
  const relevant = annotateRelevant(testCase, ['id-a', 'x1', 'x2', 'x3', 'x4', 'x5', 'id-b'], ids, new Set(['id-a', 'id-c']));
  assert.deepEqual(relevant, [
    { record: 'a', rank: 1, outcome: 'delivered' },
    { record: 'b', rank: 7, outcome: 'ranked' },
    { record: 'c', rank: null, outcome: 'expanded' },
    { record: 'd', rank: null, outcome: 'missed' }
  ]);
  const signals = { lexical: { available: true, matched: 1 }, semantic: { available: false, matched: 0 }, graph: { available: false, matched: 0 }, temporal: { available: false, matched: 0 } };
  const pick = (entries) => entries.map(({ record, evidence, stage, rank, reason }) => ({ record, evidence, stage, rank, reason }));
  assert.deepEqual(pick(missesOf('context', testCase, relevant, signals)), [
    { record: 'b', evidence: 'grounded_case', stage: 'ranked_not_delivered', rank: 7, reason: 'ranked_below_depth' },
    { record: 'd', evidence: 'grounded_case', stage: 'not_ranked', rank: null, reason: 'no_signal_match' }
  ]);
  assert.deepEqual(pick(missesOf('context', testCase, relevant, signals, true)), [
    { record: 'a', evidence: 'fallback_recovery', stage: 'not_ranked', rank: null, reason: 'relevance_not_established' },
    { record: 'b', evidence: 'fallback_recovery', stage: 'not_ranked', rank: null, reason: 'relevance_not_established' },
    { record: 'd', evidence: 'grounded_case', stage: 'not_ranked', rank: null, reason: 'no_signal_match' }
  ]);
  assert.deepEqual(missesOf('context', testCase, relevant, signals)[0].unavailableSignals, ['semantic', 'graph', 'temporal']);
  assert.equal(missesOf('search', testCase, relevant, null)[0].unavailableSignals, null);
});

test('EVG-10: the evaluation finds the semantic signal unpopulated, and calls no provider even with one configured', () => {
  const saved = process.env.SHADOWGRAPH_EMBEDDING_URL;
  const savedFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error('no network in the evaluation'); };
  try {
    for (const url of [undefined, 'http://127.0.0.1:9/']) {
      if (url === undefined) delete process.env.SHADOWGRAPH_EMBEDDING_URL;
      else process.env.SHADOWGRAPH_EMBEDDING_URL = url;
      const report = runEvaluation({ split: 'dev' });
      assert.deepEqual(report.evg10, { embeddingConfigured: url !== undefined, semanticAvailable: false, indexed: 0, verdict: 'semantic_not_populated' });
    }
  } finally {
    globalThis.fetch = savedFetch;
    if (saved === undefined) delete process.env.SHADOWGRAPH_EMBEDDING_URL;
    else process.env.SHADOWGRAPH_EMBEDDING_URL = saved;
  }
  assert.equal(calls, 0);
  // What makes the verdict populated is an engine reporting the signal.
  assert.deepEqual(evg10Of([{ signals: { semantic: { available: true } }, indexed: 2 }, { ids: [] }], {}), { embeddingConfigured: false, semanticAvailable: true, indexed: 2, verdict: 'semantic_populated' });
});

test('the semantic signal counts the stored vectors it could compare, with or without a query vector', () => {
  const graph = createShadowGraph();
  graph.remember({ project: 'p', memoryType: 'preference', key: 'a', text: 'vector note', embedding: [1, 0] });
  graph.remember({ project: 'p', memoryType: 'preference', key: 'b', text: 'plain note' });
  graph.addDecision({ project: 'p', title: 'note on decisions', chosen: 'x' });
  const lexical = graph.recall('note', { project: 'p' });
  assert.deepEqual([lexical.signals.semantic.available, lexical.signals.semantic.matched, lexical.signals.semantic.indexed], [false, 0, 1]);
  const fused = graph.recall('note', { project: 'p', queryEmbedding: [1, 0] });
  assert.deepEqual([fused.signals.semantic.available, fused.signals.semantic.matched, fused.signals.semantic.indexed], [true, 1, 1]);
});

test('adding the default read left every earlier engine\'s results exactly as they were', () => {
  // Hashes of the search, retrieve and recall per-case results for both splits,
  // taken at 612ad02 before PR-28 changed the harness: no scoring change.
  const expected = {
    dev: 'aeab09c814b6716f2f3ec967d3eb3aaea77f4cf23a4f4b0379d200330fe5445c',
    holdout: 'fa5c27a8b13a7c4ee04937ec100e05135ab400f591b8536932ef8f3182a92392'
  };
  for (const [split, hash] of Object.entries(expected)) {
    const { engines } = runEvaluation({ split });
    const pinned = Object.fromEntries(['search', 'retrieve', 'recall'].map((name) => [name, engines[name].cases]));
    assert.equal(createHash('sha256').update(JSON.stringify(pinned)).digest('hex'), hash, split);
  }
});
