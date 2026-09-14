# Retrieval design decision — 2026-09-13

**Decision: fix text normalisation in the existing search paths. Add no dependency, no vector
index, and no second storage engine.**

Bounded research pass, one pass, sources verified on 2026-09-13 against Node v24.18.0 with bundled
SQLite 3.53.1. Constraints in force: zero runtime dependencies, local-first, and **no inference
authorised this cycle**, so any embedding-based option could be assessed on paper only.

---

## What shipped, and what it bought

`src/hybrid-search.js` matched `[\p{L}\p{N}]+` over NFKC text. Arabic harakat are `\p{Mn}` — neither
a letter nor a number — so **they were treated as token separators**:

```
"مُحَمَّد"  ->  ["م","ح","م","د"]      four single letters
"محمد"    ->  ["محمد"]
```

Every Arabic record written with tashkeel was unreachable by BM25, and the same held for the
substring path, which only lowercased. Orthographic variants a writer actually types — `أ/إ/آ` for
alef, `ة` for ta marbuta, `ى` for alef maqsura — did not unify either.

One shared `foldText()` in `src/hybrid-search.js` now does NFKC → NFD → drop `\p{Mn}` → Arabic
letter folds → lowercase, and `src/shadowgraph.js` uses the same function, so the two search paths
cannot drift apart. It **widens** what counts as the same character: it can add a match but not
remove one, and substring semantics are untouched.

### The precision cost — a trade, not a free win

Widening matching admits false positives, and two of the Arabic folds collapse genuinely different
words rather than spellings of one word:

- `ى` → `ي` collapses **على** ("on", "about") with **علي** (the name Ali).
- `آ` → `ا` collapses **آمن** ("safe", "believed") with **امن** ("security").

The hamza-seat folds are otherwise near-free — `أ/إ/آ/ٱ` for `ا` is casual typing. The trade is
taken because the alternative is worse: without it a record is unreachable whenever the writer and
the searcher picked different spellings of the same word, which is common in Arabic. A false
positive is visible and rankable; an unreachable record is neither.

This is the standard trade Arabic information retrieval makes, but it is a trade, and an earlier
draft of this document described these folds as unifying "the same word to a reader" — which is
true for the hamza seats and **not** true for these two pairs. Both collisions are now asserted in
`test/retrieval-folding.test.js` so they remain a known cost rather than a surprise. Removing
`ى` → `ي` is the lever to pull if precision on that pair ever matters more than recall.

### Measured, same 15 cases, `scripts/retrieval-eval.mjs`

| engine | before | after | arabicOrthography | normalization |
| --- | --- | --- | --- | --- |
| `search` | 7/15 | **11/15** | 0/3 → **3/3** | 1/2 → **2/2** |
| `retrieve` | 7/15 | **11/15** | 0/3 → **3/3** | 1/2 → **2/2** |
| `recall` | 10/15 | **13/15** | 0/3 → **3/3** | 2/2 |

Before the change those Arabic queries returned **zero** results — not wrong results, nothing.
Cross-project leaks: 0 before and after.

**What it did not buy, stated plainly:** paraphrase (0/2 on `search`) and cross-language (1/2) are
unchanged. Character folding cannot reach meaning. Those categories stay in the evaluation
precisely so the limitation keeps being reported.

One caveat on `recall`'s paraphrase score: it "passes" by returning 3.5 of 9 records on a small
corpus. The report prints `n=` (mean results returned) beside recall for that reason — permissive
retrieval on a small corpus is not comprehension, and the number should not be read as such.

---

## Rejected alternatives, with evidence

### SQLite FTS5 — available, but wrong for `search()` today

**Verified compiled in**: `pragma_compile_options()` reports `ENABLE_FTS5`; an FTS5 virtual table
with `MATCH` + `bm25()` works with no extension load. Present in `deps/sqlite/sqlite.gyp` on
Node v22/v24/v26; absent on v20, which has no `node:sqlite` at all.

Rejected for now on three grounds:

1. **It cannot back `search()` without breaking its contract.** FTS5 has no substring match — `cach`
   against `cache` returns **0 rows**; it needs `cach*` or the `trigram` tokenizer.
   `docs/contracts/search-contract.md` promises `cach` matches `cache` deliberately.
2. **It inherits the identical Arabic defect.** FTS5's `unicode61` also admits only `L*`/`N*`, so
   `مُحَمَّد` shreds the same way, and `tokenize='unicode61 remove_diacritics 2'` does **not** fix it
   (verified — identical term list). The fold shipped here would be a prerequisite anyway.
3. `node:sqlite` is `Stability: 1.2 - Release candidate` and does not exist before Node 22.5, while
   `package.json` declares `>=20`. SQLite is an optional backend; JSON is the default.

It remains the right future home for `recall()`'s lexical leg **if in-memory scan is ever measured
as the bottleneck**. It has not been.

### sqlite-vec — rejected

Stable **v0.1.9, 2026-03-31**; latest of any kind **v0.1.10-alpha.4, 2026-05-18**, which is also the
last commit — roughly four months quiet. Dual Apache-2.0/MIT. It is a **prebuilt native extension**
shipping 12 platform tarballs, loadable via `allowExtension: true` (Node ≥22.13/23.5). A per-platform
native binary from a pre-v1 project is exactly the runtime dependency this product does not have.

### Anthropic contextual retrieval — out of scope

Published 2024-09-19. It requires **one LLM call per chunk at index time** to generate a context
prefix. Out of scope under "no inference authorised", and structurally wrong for a local-first store
that would then need an API call on every write.

### Qwen3-Embedding — not viable here

Released 2025-06-05; 0.6B/4B/8B, Apache-2.0, "100+ languages". **Not verified:** the blog does not
name Arabic explicitly, and no per-language benchmark or RAM figure was confirmed — any number here
would be an estimate, not evidence. Decisive blocker regardless: there is **no pure-JS inference
path**. Running it means ONNX Runtime / transformers.js / llama.cpp plus a multi-hundred-MB
download, and it cannot be evaluated at all this cycle.

### arXiv 2608.24060 — real, and it validates the existing design

**"SQLite is Enough. Lexical, Semantic, and Hybrid Search with scrydb"**, Timo Breuer, submitted
**2026-08-25**, cs.IR, MIT licensed. A Python library: FTS5 for lexical, sqlite-vec for semantic,
with rerank/fusion.

*Verification note:* the arXiv export API returned empty for this id **and for a known-good control
id**, so the API was unreachable rather than the paper fictional; it was confirmed from the raw
`arxiv.org/abs/` HTML, and neighbouring ids resolve to unrelated real papers.

Its value here is confirmation that **FTS5 + rank fusion is a published, benchmarked architecture** —
which is essentially what `recall()` already does with BM25 + weighted RRF. It offers no code for
this stack.

### `Intl.Segmenter` — viable, deferred

Available since **Node 16**, so no version gate. Segments Arabic word boundaries correctly and
handles CJK, which the current regex cannot, and benchmarked *faster* than the existing
`NFKC + regex` path (31.3 vs 23.8 M chars/s on a mixed corpus).

Deferred, not rejected: it is marginal on space-delimited text next to the folding fix, and its
behaviour under a `small-icu` build is **unverified** — adopting it needs a
`typeof Intl.Segmenter === 'function'` guard with a regex fallback. Worth doing when CJK support is
actually wanted.

---

## Negative result, recorded

No semantic component was shipped, and none was evaluated empirically, because no inference was
authorised. `createEmbeddingClient` is unchanged: still opt-in, still localhost-only unless
explicitly unlocked, still degrading to `signals.semantic.available: false` with a stated reason.
**Its retrieval benefit for this product remains untested and is not claimed anywhere.**

The simplest available change beat every dependency-bearing option on the cases that were actually
failing, so the simpler design shipped.

## Backlog, in priority order

1. `Intl.Segmenter` behind a capability guard, for CJK and cleaner Arabic segmentation.
2. FTS5 for `recall()`'s lexical leg — only once in-memory scan is measured as the bottleneck, and
   only with this fold applied before insert.
3. Revisit embeddings when inference is authorised; evaluate on the `paraphrase` and
   `crossLanguage` categories, which are already in the harness and already failing.
4. Arabic stemming / clitic handling (`كاش` vs `الكاش`) — the `ال-` article is still not handled.
