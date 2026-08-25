# ShadowGraph — Benchmark Report

**Generated:** 2026-08-25T16:04:47.630Z
**Environment:** Node v24.18.0, win32 x64
**Command actually run:** `node scripts/bench-journal.mjs --sizes 1000,10000 --runs 5 --json`
**Also verified:** `npm run bench -- --sizes=1000,10000 --runs=5 --json` (equals form)
**Arguments were parsed, not defaulted:** the JSON output echoes `"sizes": [1000, 10000]` and `"runs": 5`, and the script now **throws on an unknown or malformed argument** instead of silently falling back to defaults. A number in this report can therefore be traced to the invocation that produced it.

---

## 0. Scope of this report — read before quoting any number

This report covers **journal replay and persistence performance only** (finding P2-18).

It is **not** a confidence-calibration report, and nothing here supports any claim about calibration. The two are separate concerns and are deliberately kept apart:

| Concern | Status | Where it lives |
| --- | --- | --- |
| Journal rebuild speed and size (X-2) | ✅ **measured**, thresholds pre-declared | this report |
| Confidence **correctness** (fold, dedupe, bounds, parity) | ✅ **tested**, not benchmarked | `test/review-findings.test.js` P1-8/P1-9/P1-10 |
| Confidence **calibration** (does 0.7 mean right 70% of the time?) | ❌ **not established, not claimed** | `docs/handoffs/confidence-contract.md` §7 |
| Token / cost / latency per work lifecycle | ❌ **never measured** | ADR-0004, unimplemented |

The confidence weights (`BASE_STEP = 0.2`; class weights 0.5 / 0.7 / 0.85 / 1.0) are a **declared policy, not an empirically calibrated model**. No Brier score, ECE, or reliability bucket exists in this repository. Producing one honestly needs ground-truth outcomes at volume, a no-memory baseline, and a benchmark that does not feed the answer through call arguments; a synthetic score would measure the generator, not the model.

## 1. Verdict

**No pre-declared threshold was breached. Snapshots and compaction stay DEFERRED BY MEASUREMENT, not by guess.**

Thresholds were fixed in ADR-0001 D13 **before** measuring, so the verdict could not be rationalised after seeing the numbers. The script computes the verdict itself and reports `"breaches": []`.

| Threshold (pre-declared) | Limit | Measured | Result |
| --- | --- | --- | --- |
| Rebuild p95 at ~10k entries | > 250 ms | **7.01 ms** | ✅ 36× headroom |
| Rebuild p95 at ~100k entries | > 1000 ms | not measured (§4) | — |
| Journal ÷ projection bytes at ~10k | > 10× | **3.47×** | ✅ 2.9× headroom |

## 2. Raw results

### ~1,000 journal entries (200 decisions, 200 facts)

```
rebuild   p50=0.60ms  p95=8.41ms  min=0.51ms  max=8.41ms  rebuildable=true  applied=1000
rebuilt   records=200  facts=200
size      journal=1,693,168B  projection=488,568B  ratio=3.47x
json      save=12.62ms  load=22.61ms  file=3,658,522B  journalRoundTripped=1000
sqlite    save=19.10ms  load=13.71ms  file=3,723,264B  journalRoundTripped=1000
```

### ~10,000 journal entries (2,000 decisions, 2,000 facts)

```
rebuild   p50=6.88ms  p95=7.01ms  min=5.08ms  max=7.01ms  rebuildable=true  applied=10000
rebuilt   records=2000  facts=2000
size      journal=16,965,569B  projection=4,895,168B  ratio=3.47x
json      save=103.15ms  load=89.80ms   file=36,629,124B  journalRoundTripped=10000
sqlite    save=273.08ms  load=108.23ms  file=36,536,320B  journalRoundTripped=10000
```

## 3. What the numbers say

**Rebuild is not the bottleneck — it is nearly free.** 10,000 entries fold in ~7 ms. That is the expected consequence of the ADR-0001 D4 choice: replay is a fold over complete post-operation snapshots with no domain logic, no clock, and no id generation, so per-entry cost is a map assignment.

**The 1k p95 (8.41 ms) is HIGHER than the 10k p95 (7.01 ms), and that is not a size effect.** It is first-iteration JIT warm-up: `min` at 1k was 0.51 ms and p50 was 0.60 ms, so a single cold run dominates the tail of a 5-run sample. Reading it as "1k is slower than 10k" would be a misreading of measurement noise, and it is the reason p50 is quoted alongside p95 rather than p95 alone.

**Storage is the real cost, and the passing ratio understates it in absolute terms.** 3.47× clears the 10× threshold comfortably, but the persisted file at 10k entries is **~36 MB on both backends**. That is the honest price of full snapshots — storage grows with `entity size × mutation count`, not with change size. For a local-first single-user decision ledger it is acceptable (2,000 decisions is a great many recorded decisions), but it is stated plainly rather than hidden behind a ratio.

**Both backends round-tripped all 10,000 entries.** `journalRoundTripped` equals the entry count for JSON and SQLite, so the journal survives persistence intact on both paths — the parity that finding P1-10 asked to be proven for confidence specifically is now also visible at the whole-journal level here.

**SQLite save is ~2.6× slower than JSON at 10k** (273 ms vs 103 ms), while load is comparable (108 ms vs 90 ms). This is consistent with suspicion **X-4**: the SQLite path rewrites all rows inside one `BEGIN IMMEDIATE` transaction on every save. At this scale it is acceptable and the atomicity it buys is worth the cost — that single transaction is precisely what makes state and journal unable to diverge (journal contract §10). The write amplification is now **measured rather than suspected**, and it is the first thing to revisit if save latency ever becomes a complaint.

## 4. Not measured, and why

**100k entries.** The 10k case already writes ~36 MB per backend per run; 100k would generate ~360 MB of temp files per run and cross into territory where the binding limit is disk and memory rather than fold speed. Given 36× headroom against the rebuild threshold, extrapolation is uninformative and the cost is real. Run it deliberately if the number is ever needed:

```bash
node scripts/bench-journal.mjs --sizes 100000 --runs 3
```

**Token, cost, latency, tool-call counts.** Still **never measured**. The ADR-0004 warm-task benchmark (first decision → restart recall → repeated task → changed-fact reconsideration → failed-attempt avoidance) is not implemented. No figure of that kind appears anywhere in this repository.

**Confidence calibration.** See §0. Not measured, not claimable.

## 5. Reproducing

```bash
npm run bench                                              # defaults: 1k + 10k, 5 runs
npm run bench -- --sizes=1000,10000 --runs=5 --json        # equals form
node scripts/bench-journal.mjs --sizes 1000,10000 --runs 5  # space form
node scripts/bench-journal.mjs --json                       # machine-readable
```

Both argument forms are supported and both are exercised above. An unknown flag, a non-integer size, or a non-positive run count **throws** rather than silently reverting to defaults, so a report cannot quote default-run numbers while claiming custom arguments.

The generator uses a fixed injected clock, so entry counts and record shapes are deterministic across runs; only timings vary. Temp files are created under the OS temp directory and removed in a `finally` block. If `node:sqlite` is unavailable the SQLite row reports `SKIPPED` with the reason rather than being silently omitted from the comparison.
