// A small, varied retrieval evaluation for the two search paths.
//
// It exists to stop a retrieval change being justified by a plausible story.
// Categories are scored SEPARATELY and deliberately, because they test
// different capabilities and lumping them together hides which one moved:
//
//   normalization   accent / width / case folding      -- a tokenizer can fix
//   lexical         the right words, ranked wrong      -- ranking can fix
//   paraphrase      same meaning, NO shared keywords   -- needs meaning, not lexis
//   crossLanguage   Arabic query, English record       -- needs translation
//   identifier      exact ids and partial identifiers  -- must stay exact
//   nearMiss        similar but WRONG decision         -- precision, not recall
//   negation        "not", "without", "never"          -- lexical search cannot
//   temporal        superseded vs current              -- status, not text
//   contradiction   two records that disagree          -- both must surface
//   crossProject    another project's record           -- must NEVER return
//
// `paraphrase` and `crossLanguage` are expected to score poorly without
// embeddings. That is the point: they are in here so the limitation is measured
// and reported rather than quietly omitted from the evaluation.
//
// dev cases are for iterating. holdout cases are NOT to be looked at while
// tuning, and a holdout number claimed after tuning on holdout is worthless.
//
// Each case also records, per known-relevant record, whether the engine
// delivered it, ranked it too low, reached it only by expanding a delivered
// line, or missed it (`--json`, `cases[].relevant`), and every miss goes into
// `missLedger` with the signals the engine reported. The default read (PR-26,
// compact lines) is evaluated beside the three search paths, the lines it
// delivers are checked for the phrases their meaning rests on (`fidelity`), and
// `evg10` says whether the semantic signal was populated at all. None of that
// feeds the score (plan v1.4.4 §17.3; G-5 §6.2, G5-9; PR-28).
//
// Usage:
//   node scripts/retrieval-eval.mjs                 dev split, table
//   node scripts/retrieval-eval.mjs --split holdout run the held-out cases
//   node scripts/retrieval-eval.mjs --json
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShadowGraph } from '../src/shadowgraph.js';

const PROJECT = 'eval';
const OTHER_PROJECT = 'eval-other';

// New decision histories, written for this evaluation. Ids are stable so cases
// can name them.
export const CORPUS = [
  {
    id: 'd-cache', project: PROJECT,
    title: 'Serve product reads from a regional cache',
    goal: 'Cut read latency for the catalogue endpoint',
    chosen: 'regional-cache',
    alternatives: [{ label: 'origin-only', reasonRejected: 'origin p99 exceeded the agreed ceiling' }]
  },
  {
    id: 'd-queue', project: PROJECT,
    title: 'Process uploads through a background queue',
    goal: 'Keep the upload endpoint responsive under burst load',
    chosen: 'background-queue',
    alternatives: [{ label: 'synchronous-processing', reasonRejected: 'request timeouts under burst load' }]
  },
  {
    id: 'd-cafe', project: PROJECT,
    // Deliberately near-miss vocabulary against d-cache: "cache" vs "cafe".
    title: 'Cafe menu rendering uses server-side templates',
    goal: 'Render the cafe menu without a client bundle',
    chosen: 'server-side-templates',
    alternatives: [{ label: 'client-rendering', reasonRejected: 'menu content is static' }]
  },
  {
    id: 'd-nosql', project: PROJECT,
    title: 'Store session state in Postgres, not in a document store',
    goal: 'Avoid a second datastore for session data',
    chosen: 'postgres-sessions',
    alternatives: [{ label: 'document-store', reasonRejected: 'no schema flexibility was actually needed' }]
  },
  {
    id: 'd-noretry', project: PROJECT,
    // Negation case: the decision is NOT to retry.
    title: 'Payment webhooks are never retried automatically',
    goal: 'Prevent duplicate charges from replayed webhooks',
    chosen: 'no-automatic-retry',
    alternatives: [{ label: 'automatic-retry', reasonRejected: 'duplicate charges outweighed delivery gains' }]
  },
  {
    id: 'd-arabic', project: PROJECT,
    // Arabic record. Query cases probe both Arabic-to-Arabic and cross-language.
    title: 'تخزين سجلات القرارات محليا بدون خدمة سحابية',
    goal: 'حماية خصوصية البيانات مع بقاء النظام يعمل دون اتصال',
    chosen: 'التخزين-المحلي',
    alternatives: [{ label: 'الاستضافة-السحابية', reasonRejected: 'متطلبات الخصوصية تمنع رفع البيانات' }]
  },
  {
    id: 'd-accent', project: PROJECT,
    // Normalization case: accented and unaccented forms.
    // The accented form is the ONLY form here. An unaccented query must rely on
    // normalization, not on finding the bare word somewhere else in the record.
    title: 'Deploy the résumé parser behind a feature flag',
    goal: 'Roll out CV parsing to a subset of tenants',
    chosen: 'feature-flagged-rollout',
    alternatives: [{ label: 'big-bang-release', reasonRejected: 'parser accuracy was unproven' }]
  },
  {
    id: 'd-superseded', project: PROJECT,
    title: 'Rate limit the export API at sixty requests per minute',
    goal: 'Protect the export workers from bulk scrapers',
    chosen: 'sixty-per-minute',
    alternatives: [{ label: 'no-limit', reasonRejected: 'workers saturated during scraping' }]
  },
  {
    id: 'd-current', project: PROJECT,
    title: 'Rate limit the export API at six hundred requests per minute',
    goal: 'Raise the export ceiling after the worker pool grew',
    chosen: 'six-hundred-per-minute',
    alternatives: [{ label: 'sixty-per-minute', reasonRejected: 'the old ceiling throttled legitimate partners' }]
  },
  {
    // Arabic written WITH tashkeel and with the orthographic variants a writer
    // actually uses: أ for alef, ة for ta marbuta, ى for alef maqsura. Readers
    // type the bare forms, so a store that treats these as different words
    // cannot find this record at all.
    id: 'd-arabic-diacritics', project: PROJECT,
    title: 'مُراجَعَة إعدادات المَكتبة العربية',
    goal: 'ضمان أن البحث يجد السجلات المكتوبة بالتشكيل',
    chosen: 'التطبيع-الإملائي',
    alternatives: [{ label: 'بدون-تطبيع', reasonRejected: 'الاستعلام بدون تشكيل لا يطابق النص المُشكَّل' }]
  },
  {
    id: 'd-trap', project: OTHER_PROJECT,
    // Cross-project trap: strongest possible lexical match, must never return.
    title: 'Serve product reads from a regional cache',
    goal: 'Cut read latency for the catalogue endpoint',
    chosen: 'regional-cache',
    alternatives: [{ label: 'origin-only', reasonRejected: 'origin p99 exceeded the agreed ceiling' }]
  }
];

export const CASES = [
  // --- development split -------------------------------------------------
  { id: 'norm-accent', category: 'normalization', split: 'dev', query: 'resume parser', expect: ['d-accent'] },
  { id: 'norm-case', category: 'normalization', split: 'dev', query: 'REGIONAL CACHE', expect: ['d-cache'] },
  { id: 'lex-rank', category: 'lexical', split: 'dev', query: 'regional cache', expect: ['d-cache'], mustNotReturn: ['d-trap'] },
  { id: 'lex-partial', category: 'lexical', split: 'dev', query: 'cach', expect: ['d-cache'] },
  { id: 'para-queue', category: 'paraphrase', split: 'dev', query: 'defer slow work off the request path', expect: ['d-queue'] },
  { id: 'para-cache', category: 'paraphrase', split: 'dev', query: 'reduce how long catalogue lookups take', expect: ['d-cache'] },
  { id: 'xlang-ar-en', category: 'crossLanguage', split: 'dev', query: 'local storage without cloud', expect: ['d-arabic'] },
  { id: 'xlang-ar-ar', category: 'crossLanguage', split: 'dev', query: 'التخزين المحلي', expect: ['d-arabic'] },
  { id: 'id-exact', category: 'identifier', split: 'dev', query: 'six-hundred-per-minute', expect: ['d-current'] },
  { id: 'near-cafe', category: 'nearMiss', split: 'dev', query: 'cafe menu', expect: ['d-cafe'], mustNotReturn: ['d-cache'] },
  { id: 'neg-retry', category: 'negation', split: 'dev', query: 'webhooks are not retried', expect: ['d-noretry'] },
  { id: 'trap-project', category: 'crossProject', split: 'dev', query: 'regional cache', expect: ['d-cache'], mustNotReturn: ['d-trap'] },
  // Added AFTER the research pass identified the tokenizer defect, so these
  // demonstrate the fix rather than having predicted it. Stated plainly because
  // a case written to match a fix is weak evidence unless it says so.
  { id: 'ar-harakat', category: 'arabicOrthography', split: 'dev', query: 'مراجعة', expect: ['d-arabic-diacritics'] },
  { id: 'ar-alef', category: 'arabicOrthography', split: 'dev', query: 'اعدادات', expect: ['d-arabic-diacritics'] },
  { id: 'ar-ta-marbuta', category: 'arabicOrthography', split: 'dev', query: 'المكتبه العربيه', expect: ['d-arabic-diacritics'] },

  // --- held-out split - do not inspect while tuning ----------------------
  { id: 'h-norm', category: 'normalization', split: 'holdout', query: 'résumé', expect: ['d-accent'] },
  { id: 'h-lex', category: 'lexical', split: 'holdout', query: 'background queue uploads', expect: ['d-queue'] },
  { id: 'h-para', category: 'paraphrase', split: 'holdout', query: 'keep user sign-in data in the relational database', expect: ['d-nosql'] },
  { id: 'h-xlang', category: 'crossLanguage', split: 'holdout', query: 'privacy offline decision records', expect: ['d-arabic'] },
  { id: 'h-id', category: 'identifier', split: 'holdout', query: 'postgres-sessions', expect: ['d-nosql'] },
  { id: 'h-near', category: 'nearMiss', split: 'holdout', query: 'server-side templates', expect: ['d-cafe'], mustNotReturn: ['d-cache'] },
  { id: 'h-neg', category: 'negation', split: 'holdout', query: 'never retry automatically', expect: ['d-noretry'] },
  { id: 'h-temporal', category: 'temporal', split: 'holdout', query: 'export API rate limit', expect: ['d-current', 'd-superseded'] },
  { id: 'h-contradiction', category: 'contradiction', split: 'holdout', query: 'requests per minute ceiling', expect: ['d-current', 'd-superseded'] },
  { id: 'h-trap', category: 'crossProject', split: 'holdout', query: 'catalogue endpoint latency', mustNotReturn: ['d-trap'] }
];

// Fidelity (plan v1.4.4 §17.3; AC-017; G-5 §6.3): the line the default read
// delivers for a record must keep each phrase its meaning rests on -- the
// negation and the scope qualifier of the PR-25 fixtures G5-1 and G5-3, here on
// the evaluation's own path. The attempt lives in a project of its own, so the
// retrieval cases above never see it.
const FIDELITY_PROJECT = 'eval-fidelity';
export const FIDELITY_CORPUS = [
  {
    id: 'a-eu-export', project: FIDELITY_PROJECT,
    solution: 'Retry failed invoice exports every night',
    environment: 'EU tenants only',
    result: 'duplicate invoices reached two tenants',
    resultClass: 'failed'
  }
];
export const FIDELITY_CASES = [
  { id: 'fid-noretry', split: 'dev', project: PROJECT, query: 'payment webhooks', record: 'd-noretry', mustPreserve: ['never retried automatically'] },
  { id: 'fid-eu-export', split: 'dev', project: FIDELITY_PROJECT, query: 'invoice exports', record: 'a-eu-export', mustPreserve: ['EU tenants only'] }
];

export function buildGraph() {
  const graph = createShadowGraph();
  const ids = new Map();
  for (const entry of CORPUS) {
    const created = graph.addDecision({
      project: entry.project,
      title: entry.title,
      goal: entry.goal,
      chosen: entry.chosen,
      alternatives: entry.alternatives
    });
    ids.set(entry.id, created.id);
  }
  for (const { id, ...attempt } of FIDELITY_CORPUS) ids.set(id, graph.addAttempt(attempt).id);
  return { graph, ids };
}

const RANK_DEPTH = 5;

// Every record a case names must exist in the corpus, and every record it
// expects must belong to the project being evaluated. Without this a typo in
// `expect` scored as an ordinary miss, and a relevance judgement nobody could
// satisfy was indistinguishable from a retrieval failure.
export function groundCases(cases = CASES, corpus = CORPUS) {
  const byKey = new Map(corpus.map((entry) => [entry.id, entry]));
  for (const testCase of cases) {
    for (const key of [...(testCase.expect ?? []), ...(testCase.mustNotReturn ?? [])]) {
      if (!byKey.has(key)) throw new Error(`case ${testCase.id} names ${key}, which is not in the corpus`);
    }
    for (const key of testCase.expect ?? []) {
      if (byKey.get(key).project !== PROJECT) throw new Error(`case ${testCase.id} expects ${key}, which is outside project ${PROJECT}`);
    }
  }
}

// What happened to each known-relevant record, read from the engine's actual
// output -- a miss is recorded, never inferred, and the record merely existing
// in the store counts for nothing. `delivered` is inside the RANK_DEPTH the
// scoring counts, `ranked` was returned below it, `expanded` was not returned
// but a delivered line's expansion reached it, `missed` was neither.
// Annotation only: scoreCase() does not read it.
export function annotateRelevant(testCase, returnedIds, ids, expanded = new Set()) {
  return (testCase.expect ?? []).map((key) => {
    const at = returnedIds.indexOf(ids.get(key));
    const rank = at === -1 ? null : at + 1;
    return { record: key, rank, outcome: rank === null ? (expanded.has(ids.get(key)) ? 'expanded' : 'missed') : rank <= RANK_DEPTH ? 'delivered' : 'ranked' };
  });
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const signalState = (signals) => Object.fromEntries(Object.entries(signals).map(([name, signal]) => [name, { available: signal.available, matched: signal.matched }]));

// The evaluation's miss ledger (G-5 §6.2-§6.3, the authoritative instrument):
// one entry per relevant record an engine ranked too low or did not return,
// with the reason read from its output and the signals it reported -- null for
// an engine that reports none. A relevant record the default read delivered
// only because no signal ranked anything is a miss of the ranking too, a
// fallback recovery (§6.2(a), §9), whatever its position in the working set.
// The queries are synthetic, so the text is kept.
export function missesOf(engine, testCase, relevant, signals, fallback = false) {
  const entry = (record, fields) => ({
    missId: `${engine}:${testCase.id}:${record}`, source: 'evaluation', evidence: 'grounded_case', engine, case: testCase.id,
    scope: { project: PROJECT, requestState: 'project_selected' }, query: testCase.query, queryDigest: sha256(testCase.query),
    record, boundRevision: null, tier: 'T0', signals, unavailableSignals: signals ? Object.keys(signals).filter((name) => !signals[name].available) : null,
    ...fields
  });
  return relevant.flatMap(({ record, rank, outcome }) => {
    if (fallback && rank !== null) return [entry(record, { evidence: 'fallback_recovery', stage: 'not_ranked', rank: null, reason: 'relevance_not_established' })];
    if (outcome === 'missed') return [entry(record, { stage: 'not_ranked', rank, reason: 'no_signal_match' })];
    if (outcome === 'ranked') return [entry(record, { stage: 'ranked_not_delivered', rank, reason: 'ranked_below_depth' })];
    return [];
  });
}

// The default read (PR-26) as an engine: relevance ranked on the records,
// delivered as compact lines. Each delivered line is expanded (PR-27), and
// what its investigation reaches is `expanded` for a record not returned.
export function readDefault(graph, project, query) {
  const { relevant } = graph.context({ project, query, compact: true });
  const expanded = new Set();
  for (const { tier, line } of relevant.items) {
    if (tier !== 'T1') continue;
    const { recordId, digest, asOf, derivationVersion, derivedAt, scope } = line.expansion;
    const reply = graph.expand({ recordId, digest, derivationVersion, derivedAt, ...(asOf ? { asOf } : {}), project: scope.project });
    for (const pair of reply.investigation?.pairs ?? []) expanded.add(pair.recordId);
  }
  return { ids: relevant.items.map((item) => (item.tier === 'T1' ? item.line.recordId : item.record.id)), signals: relevant.relevance.signals, expanded, fallback: !relevant.relevance.established, relevant };
}

// Fidelity: a phrase missing from a delivered line is a miss of that line
// (delivered_line_without_decisive_meaning); a record delivered in full keeps
// every phrase, though one only the fallback delivered is a fallback recovery;
// a record not delivered at all is a miss of the ranking and loses every
// phrase. Phrases are matched verbatim.
export function runFidelity(graph, ids, cases = FIDELITY_CASES) {
  const results = [];
  const misses = [];
  for (const testCase of cases) {
    const id = ids.get(testCase.record);
    if (!id) throw new Error(`fidelity case ${testCase.id} names ${testCase.record}, which is not in the corpus`);
    const answer = readDefault(graph, testCase.project, testCase.query);
    const at = answer.ids.indexOf(id);
    const item = at === -1 ? null : answer.relevant.items[at];
    const text = item?.tier === 'T1' ? item.line.line : null;
    const lost = item === null ? [...testCase.mustPreserve] : text === null ? [] : testCase.mustPreserve.filter((phrase) => !text.includes(phrase));
    const fallback = item !== null && answer.fallback;
    results.push({ case: testCase.id, record: testCase.record, tier: item?.tier ?? null, lost, ...(fallback ? { fallback: true } : {}) });
    const miss = (fields) => misses.push({
      missId: `context:${testCase.id}:${testCase.record}`, source: 'evaluation', evidence: 'grounded_case', engine: 'context', case: testCase.id,
      scope: { project: testCase.project, requestState: 'project_selected' }, query: testCase.query, queryDigest: sha256(testCase.query),
      record: testCase.record, signals: answer.signals, unavailableSignals: Object.keys(answer.signals).filter((name) => !answer.signals[name].available),
      lost, ...fields
    });
    if (item === null) miss({ boundRevision: null, tier: 'T0', stage: 'not_ranked', rank: null, reason: 'no_signal_match' });
    else if (fallback) miss({ evidence: 'fallback_recovery', boundRevision: null, tier: 'T0', stage: 'not_ranked', rank: null, reason: 'relevance_not_established' });
    else if (text !== null && lost.length) miss({ boundRevision: item.line.boundRevision, tier: 'T1', stage: 'delivered_line_without_decisive_meaning', rank: at + 1, reason: 'decisive_meaning_lost' });
  }
  return { results, misses };
}

// EVG-10 (§17.3): whether the semantic signal was populated, read from whether
// an endpoint is configured (presence only: the evaluation never calls one) and
// from what the engines themselves reported.
export function evg10Of(answers, env = process.env) {
  const semanticAvailable = answers.some((answer) => answer.signals?.semantic.available === true);
  return {
    embeddingConfigured: Boolean(env.SHADOWGRAPH_EMBEDDING_URL),
    semanticAvailable,
    indexed: Math.max(0, ...answers.map((answer) => answer.indexed ?? 0)),
    verdict: semanticAvailable ? 'semantic_populated' : 'semantic_not_populated'
  };
}

// Recall@k over the expected set, plus reciprocal rank of the first hit, plus a
// hard precision check: a case listing mustNotReturn fails outright if that
// record appears anywhere in the results.
function scoreCase(testCase, returnedIds, ids) {
  const expected = (testCase.expect ?? []).map((key) => ids.get(key));
  const forbidden = (testCase.mustNotReturn ?? []).map((key) => ids.get(key));
  const top = returnedIds.slice(0, RANK_DEPTH);
  const found = expected.filter((id) => top.includes(id));
  const leaked = forbidden.filter((id) => returnedIds.includes(id));
  const firstRank = expected.length
    ? Math.min(...expected.map((id) => { const at = top.indexOf(id); return at === -1 ? Infinity : at + 1; }))
    : Infinity;
  return {
    id: testCase.id,
    category: testCase.category,
    recall: expected.length ? found.length / expected.length : null,
    reciprocalRank: Number.isFinite(firstRank) ? Number((1 / firstRank).toFixed(4)) : 0,
    // Recall alone flatters a permissive engine on a small corpus: returning
    // most of the records scores well without discriminating at all. `returned`
    // and `precision` make that visible instead of letting it read as skill.
    returned: returnedIds.length,
    precision: top.length ? Number((found.length / top.length).toFixed(4)) : 0,
    leaked: leaked.length,
    passed: leaked.length === 0 && (expected.length === 0 || found.length === expected.length)
  };
}

export function runEvaluation({ split = 'dev' } = {}) {
  const { graph, ids } = buildGraph();
  const cases = CASES.filter((entry) => entry.split === split);
  groundCases(cases);
  // Each engine answers with the ids it returned, in order, and -- where it
  // reports them -- its signals and what a delivered line's expansion reached.
  const engines = {
    search: (query) => ({ ids: graph.search(query, { project: PROJECT }).items.map((item) => item.id ?? item.record?.id) }),
    retrieve: (query) => ({ ids: graph.retrieve(query, { project: PROJECT }).items.map((item) => item.id ?? item.record?.id) }),
    recall: (query) => {
      const result = graph.recall(query, { project: PROJECT });
      return { ids: result.items.map((item) => item.record?.id ?? item.id), signals: signalState(result.signals), indexed: result.signals.semantic.indexed };
    },
    context: (query) => readDefault(graph, PROJECT, query)
  };

  const report = { split, rankDepth: RANK_DEPTH, cases: cases.length, engines: {}, missLedger: [] };
  const answered = [];
  for (const [name, run] of Object.entries(engines)) {
    const started = performance.now();
    const answers = cases.map((testCase) => run(testCase.query));
    const returned = answers.map((answer) => answer.ids ?? []);
    const scored = cases.map((testCase, index) => scoreCase(testCase, returned[index], ids));
    const elapsed = Number((performance.now() - started).toFixed(3));
    const relevantOutcomes = { delivered: 0, ranked: 0, expanded: 0, missed: 0 };
    scored.forEach((result, index) => {
      result.relevant = annotateRelevant(cases[index], returned[index], ids, answers[index].expanded);
      if (answers[index].fallback === true) result.fallback = true;
      for (const { outcome } of result.relevant) relevantOutcomes[outcome] += 1;
      report.missLedger.push(...missesOf(name, cases[index], result.relevant, answers[index].signals ?? null, answers[index].fallback === true));
    });
    answered.push(...answers);
    const fallbackAnswered = answers.filter((answer) => answer.fallback === true).length;

    const byCategory = {};
    for (const result of scored) {
      const bucket = byCategory[result.category] ??= { cases: 0, passed: 0, recall: [], mrr: [], returned: [], leaks: 0 };
      bucket.cases += 1;
      bucket.passed += result.passed ? 1 : 0;
      if (result.recall !== null) bucket.recall.push(result.recall);
      bucket.mrr.push(result.reciprocalRank);
      bucket.returned.push(result.returned);
      bucket.leaks += result.leaked;
    }
    for (const bucket of Object.values(byCategory)) {
      bucket.recall = bucket.recall.length ? Number((bucket.recall.reduce((a, b) => a + b, 0) / bucket.recall.length).toFixed(4)) : null;
      bucket.mrr = Number((bucket.mrr.reduce((a, b) => a + b, 0) / bucket.mrr.length).toFixed(4));
      bucket.returned = Number((bucket.returned.reduce((a, b) => a + b, 0) / bucket.returned.length).toFixed(2));
    }
    report.engines[name] = {
      totalMs: elapsed,
      passed: scored.filter((result) => result.passed).length,
      leaks: scored.reduce((sum, result) => sum + result.leaked, 0),
      relevantOutcomes,
      byCategory,
      cases: scored,
      ...(name === 'context' ? { fallbackAnswered } : {})
    };
  }
  const fidelity = runFidelity(graph, ids, FIDELITY_CASES.filter((entry) => entry.split === split));
  report.fidelity = fidelity.results;
  report.missLedger.push(...fidelity.misses);
  report.evg10 = evg10Of(answered);
  return report;
}

function formatReport(report) {
  const lines = [`Retrieval evaluation - split: ${report.split}, ${report.cases} cases, recall@${report.rankDepth}`, ''];
  const categories = [...new Set(CASES.filter((entry) => entry.split === report.split).map((entry) => entry.category))];
  lines.push(['category'.padEnd(15), ...Object.keys(report.engines).map((name) => name.padEnd(22))].join(' '));
  for (const category of categories) {
    const cells = Object.values(report.engines).map((engine) => {
      const bucket = engine.byCategory[category];
      if (!bucket) return ''.padEnd(22);
      return `${bucket.passed}/${bucket.cases} r=${bucket.recall ?? "-"} n=${bucket.returned}`.padEnd(22);
    });
    lines.push([category.padEnd(15), ...cells].join(' '));
  }
  lines.push('');
  for (const [name, engine] of Object.entries(report.engines)) {
    const fallback = engine.fallbackAnswered ? ` (${engine.fallbackAnswered} answered by the fallback, whose relevant deliveries are recorded misses)` : '';
    lines.push(`${name}: ${engine.passed}/${report.cases} passed${fallback}, ${engine.leaks} cross-project leaks, ${engine.relevantOutcomes.missed} relevant records missed, ${engine.totalMs} ms`);
  }
  const delivered = report.fidelity.filter((result) => result.tier === 'T1');
  lines.push(`fidelity: ${delivered.filter((result) => !result.lost.length).length}/${delivered.length} delivered lines kept their decisive phrases (${report.fidelity.length} cases)`);
  lines.push(`EVG-10: ${report.evg10.verdict} (endpoint configured: ${report.evg10.embeddingConfigured}, stored vectors: ${report.evg10.indexed})`);
  lines.push(`miss ledger: ${report.missLedger.length} grounded misses`);
  lines.push('');
  lines.push('paraphrase and crossLanguage are expected to be weak without embeddings.');
  lines.push('They are measured so the limitation is reported, not hidden.');
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const splitAt = args.indexOf('--split');
  const split = splitAt >= 0 && args[splitAt + 1] ? args[splitAt + 1] : 'dev';
  const report = runEvaluation({ split });
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
}
