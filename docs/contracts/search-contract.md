# ShadowGraph — Search Contract (G7)

**Status:** implemented. Applies to `rank()`, `matchFields()`, `search()`, `retrieve()` in `src/shadowgraph.js`.

Principle: **every hit must be explainable by a real content field.** A search result that cannot say what matched is not explainable, and an unexplainable hit is worse than no hit.

---

## 1. Declared content fields

A free-text query term may only match these ten fields (`CONTENT_SEARCH_FIELDS`):

`title` · `goal` · `chosen` · `assumption` · `evidence` · `alternative` · `attempt solution` · `attempt result` · `attempt reason` · `environment`

`evidence` matches an entry's `source` or `detail`; `alternative` matches a `label` or `reasonRejected`. Both are matched field-wise rather than by stringifying the object, so a query cannot match an alternative's internal `id` or `status`.

## 2. What is NOT content

**Schema key names, internal metadata, and structured values never match a free-text term.** The G7 defect was `JSON.stringify(record)` matching, which made `search('title')`, `search('schemaVersion')`, `search('confidence')`, and `search('kind')` all return records containing none of those words — and `matched: []` with `reason: 'Matched record content'`, a claim contradicted by its own evidence field.

Explicitly non-matchable: `id`, `kind`, `schemaVersion`, `project`, `status`, `confidence` (and all its subfields), `createdAt`/`updatedAt`, `supersededBy`, `sourceClass`/`sourceRaw`/`actor`/`client`/`sessionId`, `reviewAfter`, and all journal fields.

## 3. Filters are not content matches

`SEARCH_FILTERS` — `project`, `status`, `minConfidence`, `sourceClass`, `kind` — are structured predicates. Satisfying a filter is **never** a content match:

| Case | `matchedBy` | `reason` |
| --- | --- | --- |
| Query terms matched content | `'content'` | `Matched title, chosen` — names the actual fields |
| Filters only, no query | `'filter'` | `'Matched filters only'` |
| Graph neighbour via `retrieve()` | `'graph'` | `Related by depends_on` |

`matched` always lists the real fields, and `filters` echoes the applied filters, so a caller can distinguish "this matched your words" from "this passed your filters" — a distinction the old code destroyed.

`reason: 'Matched record content'` with an empty `matched` is now impossible: the reason is constructed **from** `matched`.

## 4. Multi-term semantics

Terms are split on whitespace and lowercased. **Every term must match at least one content field** (AND across terms, OR across fields). A record matching only some terms is excluded. `matched` is the deduplicated union of fields across all terms.

Matching is **case-insensitive substring**, not tokenised: `cach` matches `cache`. This is deliberate for a local-first store with no index — it favours recall and needs no stemmer, dictionary, or dependency. The cost, stated plainly: no stemming (`caches` will not match `caching`) and no ranking beyond field weights.

**Unicode folding (changed 2026-09-13).** Query and content are both folded by `foldText()` from `src/hybrid-search.js` — the *same* function `recall()`'s tokenizer uses, shared so the two paths cannot drift apart. It applies NFKC, then NFD, then drops `\p{Mn}`, then folds Arabic `أ/إ/آ/ٱ`→`ا`, `ى`→`ي`, `ة`→`ه`, removes tatweel, then lowercases.

This corrects a silent failure rather than adding a feature. Arabic harakat are `\p{Mn}`, so the recall tokenizer's `[\p{L}\p{N}]+` treated them as **separators**: `مُحَمَّد` tokenised to `["م","ح","م","د"]`, four single letters that could never match the same word typed without diacritics. Those records were unreachable. On the substring path, `résumé` and `resume` were simply different strings.

Folding only ever **widens** what counts as the same character, so it can add a match but not remove one. `cach` still matches `cache`; declared content fields, `matched`, `matchedBy` and ordering are untouched. Measured effect and the rejected alternatives are recorded in `docs/retrieval-decision-2026-09-13.md`; regressions in `test/retrieval-folding.test.js`.

**The precision cost, stated rather than buried.** Widening matching necessarily admits false positives, and two of the Arabic folds collapse genuinely different words:

| Fold | Collapses | Which are |
| --- | --- | --- |
| `ى` → `ي` | `على` / `علي` | "on, about" and the name Ali |
| `آ` → `ا` | `آمن` / `امن` | "safe, believed" and "security" |

The hamza-seat folds (`أ/إ/آ/ٱ` → `ا`) are otherwise near-free — that is casual typing, not a different word. The trade is taken because the alternative is worse: without it a record is unreachable whenever writer and searcher chose different spellings of the same word, which is common. A false positive is visible and rankable; an unreachable record is neither. Both collisions are asserted in `test/retrieval-folding.test.js` so they stay known.

### Exact original text outranks a fold-only match (changed 2026-09-14)

Folding decides **whether** a record matches. It decided nothing about order, so once two words collided, the record holding the word the caller actually typed scored identically to the one holding only its near-twin — the distinction was not merely widened, it was erased from the ranking.

`score()` now adds a fixed bonus when a term also matches on the **stored text with only case folded away** — no diacritic or orthographic folding. So for the query `علي` the record containing `علي` ranks above one containing only `على`, and symmetrically for `على`.

| Property | Guarantee |
| --- | --- |
| Recall | Unchanged. Both records still return; only their order differs. |
| Stored text | Never rewritten. The comparison reads it; nothing writes it. |
| Identifiers | Matched literally, so an exact identifier can only be reinforced, never displaced by a folded variant. |
| Scope | Applied after the scope filter, so it cannot surface a record the filter excluded. |
| Case | Still ignored — case was never the distinction in question. |

**This applies to `search()` and `retrieve()` only.** `recall()`'s weighted-RRF fusion is deliberately unchanged and keeps the behaviour documented for it: adding an exact-match signal there requires a second token stream and a re-weighting of the fusion, which is a retrieval-subsystem change rather than a ranking fix. The two paths therefore differ on this point, by decision. Regressions: `test/retrieval-folding.test.js`.

It does **not** reach meaning: paraphrase and cross-language queries still fail, and `scripts/retrieval-eval.mjs` keeps scoring those categories so the limitation stays visible.

An empty query returns all filter-passing records with `matchedBy: 'filter'` — never an error and never silently zero results.

## 5. Ordering

Sorted by score descending, then by `id` ascending. The `id` tiebreak makes ordering **total and deterministic**, so pagination cannot drop or duplicate a record across pages when scores tie.

## 6. Surfaces

MCP tool descriptions for `shadowgraph_search` and `shadowgraph_retrieve` state the declared-content-field rule and enumerate the fields inline, so a model reading the schema learns the semantics without external docs. `status` and `sourceClass` enums in those schemas are generated from `DECISION_STATUSES` and `SOURCE_CLASSES`, so a schema cannot drift from the vocabulary the core enforces.
