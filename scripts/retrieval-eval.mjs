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
// Usage:
//   node scripts/retrieval-eval.mjs                 dev split, table
//   node scripts/retrieval-eval.mjs --split holdout run the held-out cases
//   node scripts/retrieval-eval.mjs --json
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
  return { graph, ids };
}

const RANK_DEPTH = 5;

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
  const engines = {
    search: (query) => graph.search(query, { project: PROJECT }).items.map((item) => item.id ?? item.record?.id),
    retrieve: (query) => graph.retrieve(query, { project: PROJECT }).items.map((item) => item.id ?? item.record?.id),
    recall: (query) => graph.recall(query, { project: PROJECT }).items.map((item) => item.record?.id ?? item.id)
  };

  const report = { split, rankDepth: RANK_DEPTH, cases: cases.length, engines: {} };
  for (const [name, run] of Object.entries(engines)) {
    const started = performance.now();
    const scored = cases.map((testCase) => scoreCase(testCase, run(testCase.query) ?? [], ids));
    const elapsed = Number((performance.now() - started).toFixed(3));

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
      byCategory,
      cases: scored
    };
  }
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
    lines.push(`${name}: ${engine.passed}/${report.cases} passed, ${engine.leaks} cross-project leaks, ${engine.totalMs} ms`);
  }
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
