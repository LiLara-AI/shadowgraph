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

Matching is **case-insensitive substring**, not tokenised: `cach` matches `cache`. This is deliberate for a local-first store with no index — it favours recall and needs no stemmer, dictionary, or dependency. The cost, stated plainly: no stemming (`caches` will not match `caching`), no ranking beyond field weights, and no Unicode normalisation beyond JavaScript's own `toLowerCase()`, so accented and unaccented forms are distinct.

An empty query returns all filter-passing records with `matchedBy: 'filter'` — never an error and never silently zero results.

## 5. Ordering

Sorted by score descending, then by `id` ascending. The `id` tiebreak makes ordering **total and deterministic**, so pagination cannot drop or duplicate a record across pages when scores tie.

## 6. Surfaces

MCP tool descriptions for `shadowgraph_search` and `shadowgraph_retrieve` state the declared-content-field rule and enumerate the fields inline, so a model reading the schema learns the semantics without external docs. `status` and `sourceClass` enums in those schemas are generated from `DECISION_STATUSES` and `SOURCE_CLASSES`, so a schema cannot drift from the vocabulary the core enforces.
