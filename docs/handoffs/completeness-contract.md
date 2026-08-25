# ShadowGraph — Completeness and Pagination Contract (G6)

**Status:** implemented. Applies to `search()`, `retrieve()`, `context()`, `journalEntries()` in `src/shadowgraph.js`, and to their MCP/HTTP/CLI surfaces.

Principle being satisfied: **no silent omission.** A caller must never receive a truncated result that looks complete.

---

## 1. The envelope

Every paginated read path returns:

```jsonc
{
  "items": [ … ],
  "page": { "offset": 0, "limit": 50, "total": 137, "hasMore": true },
  "completeness": {
    "scope": { "project": "default", "query": "cache", "filters": { … } },
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
| `completeness.complete` | `true` only when every matching item is in `items` |
| `completeness.losslessItems` | **Each returned item is a full-fidelity record**, never a summary or a truncated field |
| `completeness.limitSource` | `'caller'` when the caller set a limit, `'default'` when the default applied — so a caller can tell whose choice caused truncation |

`losslessItems` is the load-bearing distinction for this product: compact retrieval may reduce the **number** of items with a declared total, but never the **content** of an item. Summarising away alternatives, rejection reasons, evidence, or provenance is prohibited.

## 3. Limits

`DEFAULT_PAGE_LIMIT = 50`, `MAX_PAGE_LIMIT = 1000`.

An **invalid limit throws** rather than being silently coerced: `Page limit must be an integer between 1 and 1000` for a non-integer, zero, negative, or over-maximum limit, and `Page offset must be a non-negative integer` for a bad offset.

This is deliberate. Silently substituting a different limit than the caller asked for would mean the caller believes it requested 5,000 items and received 1,000 with no indication the request was altered — a silent-omission failure wearing a `hasMore` flag. Rejecting the call keeps the caller's intent and the returned data in agreement.

When no limit is supplied, the default applies and `completeness.limitSource` reports `'default'`, so a caller can always tell whose choice bounded the result.

## 4. `context()` is shaped differently, and why

`context()` returns five named collections rather than one list, so a single `page` cannot describe it. Its collections stay **at their original keys** (`activeDecisions`, `staleAssumptions`, `failedAttemptsToAvoid`, `openReviews`, `suggestedQuestions`) as plain arrays — preserving backward compatibility for existing callers — and it adds:

```jsonc
"completeness": {
  "scope": { "project": "default" },
  "complete": true,
  "limitSource": "default",
  "losslessItems": true,
  "collections": {
    "activeDecisions": { "returned": 12, "total": 12, "hasMore": false, "omitted": 0 },
    …
  }
}
```

`complete` is `true` only when **no** collection has more. Per-collection totals mean truncation is attributable to a specific collection rather than hidden in an aggregate.

## 5. Journal reads

`journalEntries(options)` uses the standard envelope and adds `journalEpoch`, `journalSeq`, and `gaps` to `completeness` — so a caller reading the journal learns the replay boundary and any hard-purge discontinuities in the same response.

## 6. Backward compatibility

`context()` keeps its original keys (additive change). `search()` and `retrieve()` changed from bare array to envelope — a **breaking** shape change, recorded in `CHANGELOG.md` with migration guidance (`result.items`). MCP tool descriptions carry the envelope contract inline so a model reading the schema learns it without extra docs.

## 7. Tested boundaries

Empty results (`total: 0`, `complete: true`); exact-boundary limit equal to total (`hasMore: false`); **invalid limits — `0`, negative, non-integer, above `MAX_PAGE_LIMIT` — all throw** and are asserted with `assert.throws`, never coerced; a bad offset throws; an omitted limit applies the default and reports `limitSource: 'default'`; offset past the end (empty `items`, `total` still truthful); filters reflected in `scope`; and `losslessItems` asserted against a full record comparison.
