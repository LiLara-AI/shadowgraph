# ShadowGraph — Completeness and Pagination Contract (G6)

**Status:** implemented. Applies to `search()`, `retrieve()`, `context()`, `getJournal()` in `src/shadowgraph.js`, and to their MCP/HTTP/CLI surfaces.

Principle being satisfied: **no silent omission.** A caller must never receive a truncated result that looks complete.

---

## 1. The envelope

Every paginated read path returns:

```jsonc
{
  "items": [ … ],
  "page": { "offset": 0, "limit": 50, "total": 137, "hasMore": true },
  "completeness": {
    "scope": { "project": "default", "requestState": "project_selected", "originPresented": false, "grant": null, "query": "cache", "filters": { … } },
    "returned": 50,
    "total": 137,
    "complete": false,
    "omitted": 87,
    "losslessItems": true,
    "limitSource": "default"
  }
}
```

**Bare arrays are never returned from a path that can be truncated.** That was the G6 defect: `search()`, `retrieve()` without an explicit `limit`, and `context()` all returned unbounded bare arrays with no way to know whether anything was missing.

## 2. Field meanings

| Field | Meaning |
| --- | --- |
| `page.offset` / `page.limit` | The window actually applied |
| `page.total` | Matching items **before** the window |
| `page.hasMore` | More items exist beyond this window |
| `completeness.scope` | The project, query, and structured filters that produced this result — so a result explains its own derivation |
| `completeness.returned` / `total` / `omitted` | Counts, with `omitted = total − returned` |
| `completeness.complete` | `true` only for a resolved project when every known matching item is returned without withheld detail; never total semantic recall |
| `completeness.losslessItems` | True for full-fidelity items; false for redaction or a bounded historical signal projection |
| `completeness.limitSource` | `'caller'` when the caller set a limit, `'default'` when the default applied — so a caller can tell whose choice caused truncation |

`losslessItems` is the load-bearing distinction for this product: compact retrieval may reduce the **number** of items with a declared total, but never the **content** of an item. Summarising away alternatives, rejection reasons, evidence, or provenance is prohibited.

## 3. Limits

`DEFAULT_PAGE_LIMIT = 50`, `MAX_PAGE_LIMIT = 1000`.

An **invalid limit throws** rather than being silently coerced: `Page limit must be an integer between 1 and 1000` for a non-integer, zero, negative, or over-maximum limit, and `Page offset must be a non-negative integer` for a bad offset.

This is deliberate. Silently substituting a different limit than the caller asked for would mean the caller believes it requested 5,000 items and received 1,000 with no indication the request was altered — a silent-omission failure wearing a `hasMore` flag. Rejecting the call keeps the caller's intent and the returned data in agreement.

When no limit is supplied, the default applies and `completeness.limitSource` reports `'default'`, so a caller can always tell whose choice bounded the result.

## 4. `context()` is shaped differently, and why

`context()` returns several named collections rather than one list, so a single `page` cannot describe it. Its collections are plain arrays: `activeDecisions`, `staleAssumptions`, `failedAttempts`, `firedConditions` and `belowConfidenceThreshold`. Plan v1.4.4 PR-19 renamed the collections whose names carried advice (`failedAttemptsToAvoid`, and `openReviews`, whose entries' `alternativesToReconsider` is now `affectedAlternatives`) and replaced the generated `suggestedQuestions` with `belowConfidenceThreshold`, the fact each question was generated from. The explicitly invoked `reviewContext()` keeps the original keys. It adds:

Two further collections arrived on 2026-09-13, both additive and both bound by this same contract: `conditionDiagnostics` (conditions that could not be settled, or that rest on facts which disagree) and `reusableAttempts` (attempts whose `reusableWhen` conditions all hold). Each declares its own counts under `collections`, and each participates in the top-level `complete`, so neither can truncate silently. See `docs/contracts/review-conditions-contract.md`.

```jsonc
"completeness": {
  "scope": { "project": "default", "requestState": "project_selected", "originPresented": false, "grant": null },
  "complete": true,
  "limitSource": "default",
  "losslessItems": true,
  "collections": {
    "activeDecisions": { "returned": 12, "total": 12, "hasMore": false, "omitted": 0 },
    …
  }
}
```

The failed collection's entry (`failedAttempts`, and `failedAttemptsToAvoid` in `reviewContext()`) also carries `undetermined`: the attempts in scope whose outcome is undetermined -- captured, with no `resultClass` -- which no collection holds (plan v1.4.4 PR-24).

`complete` is `true` only for a resolved project when **no** collection has more and no referenced historical signal detail is withheld. Per-collection totals mean truncation is attributable to a specific collection rather than hidden in an aggregate.

## 5. Journal reads

`getJournal(options)` retains its page/counts, scope-owned purge `gaps`, and `scoped_coverage` limitation. Public journal, redaction and rebuild envelopes omit global high-water, epoch, revision and replay-volume counters. Privileged persistence, integrity and restore retain them. Entry `seq` and own purge-gap coordinates remain canonical global ordering values: they can reveal interleaving when later own entries arrive, but are neither scoped activity counts nor freshness proof. A gap between scoped entries alone is not missing-journal corruption. The store-wide integrity/rebuild verdict is unchanged; public diagnostics and projections remain scoped.

## 6. Backward compatibility

`context()` renamed its advisory collections and replaced `suggestedQuestions` in plan v1.4.4 PR-19, a **breaking** change recorded in `CHANGELOG.md`; `reviewContext()` keeps the original keys. `search()` and `retrieve()` changed from bare array to envelope — a **breaking** shape change, recorded in `CHANGELOG.md` with migration guidance (`result.items`). MCP tool descriptions carry the envelope contract inline so a model reading the schema learns it without extra docs.

## 7. Tested boundaries

Empty selected-project results (`total: 0`, `complete: true`); unresolved results (`complete: false`); exact-boundary limit equal to total (`hasMore: false`); **invalid limits — `0`, negative, non-integer, above `MAX_PAGE_LIMIT` — all throw** and are asserted with `assert.throws`, never coerced; a bad offset throws; an omitted limit applies the default and reports `limitSource: 'default'`; offset past the end (empty `items`, `total` still truthful); filters reflected in `scope`; and `losslessItems` asserted against a full record comparison.

## 8. Resolved request coverage and history

Every normal read carries `completeness.scope`: resolved `project` (or null), `requestState`, `originPresented` and `grant: null`. Unresolved requests always report `complete: false` with a scoped-coverage limitation. An exact origin reads only its own unattributed content; no project and no usable origin searches no project content. Grant-shaped inputs confer nothing. No expansion capability is advertised.

Existing filters, query, temporal scope, paging counts, per-collection budgets and limitations remain. The separate legacy-attribution inspection and explicit administrative purge preview are not normal read scopes. Evaluation verdicts in reconsideration remain separate from request coverage.

Breaking shape change: `review()` and `getReviewSignals()` now return `{ items, completeness }`. Array consumers use `result.items`. Both remain unpaginated; returned/total count known matching own items, omitted is zero, and there is no invented limitSource. MCP, HTTP and CLI serialize the envelope. MCP structured tiers now provide object output schemas for both tools; input-scope alignment remains separate work.

An owner's historical signal citing out-of-scope facts is returned as identity/lifecycle fields plus a limitation. Historical condition text, coverage, reason, title and alternative labels are withheld together. Such a result is partial and not lossless; another owner's signals never create counts or notices. All-in-scope history stays full, status filters apply before coverage is calculated, and stored evidence/identity/acknowledgement remain unchanged. Export, redaction, statistics and maintenance carry the same partial signal coverage.

Redaction stamps its marker and completeness after transformation/native-key filtering and is never lossless or a usable store. Statistics and integrity/action results add coverage without replacing their existing counts, verdicts or limitations. CLI doctor forwards validation coverage; dashboard object metadata renders as JSON text.

## Capture, extraction and source availability

Scoped completeness also reports captured backlog, processing, blocked/error states, admission and transcript gaps, quarantined material, and pending restore status. These are known observations and limitations, not a guarantee that all host work was captured. Capture items remain hidden from ordinary experience reads. Expired or deleted raw cannot be reconstructed from a completeness count.

`extractionAvailable` projects the current exact-store configuration and outstanding execution state. It is false when configuration or settlement is unavailable; it is not a provider-health probe, does not start work, and is not saved in memory or restored from a backup. Source evidence that was removed is explicitly unavailable without changing a surviving record's verification result. Quarantine remains hidden until an authorized release; raw expiry does not release it. See [extraction status](../extraction.md) and [data lifecycle](../data-lifecycle.md).
