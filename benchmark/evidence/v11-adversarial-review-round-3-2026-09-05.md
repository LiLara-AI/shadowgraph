# ShadowGraph v1.1: Three Rounds, and the Line Nobody Was Standing On

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Under review:** `git diff cab97a3..d61c8c1` — the commit that fixed the fixes
- **Official run status:** **NOT STARTED**

## Decision

44 findings, three skeptics each, **37 survived**. Two of them were fail-opens
the previous commit had *created*, and one was a defect that predated all three
reviews and would have stopped every run on its first line.

But the finding that matters is the one the chain had been circling for two
rounds and finally stated plainly:

> Nothing in this suite enters `v11RunCommand` past the readiness refusal, or
> `v11RuntimeDependencies` at all. A `throw` inserted at the top of either leaves
> 2344 tests green.

That is why the same class kept recurring. Every guard was correct in the
library it lived in, and *chosen* on a line in `benchmark/cli.mjs` that no test
executes. Reverting any one of those choices passed the whole suite:

| Reverted at its own call site | What it would do |
| --- | --- |
| `closeResources: runtime.closeMeasurement` → `runtime.close` | every run executes 308 units and writes no artifact (F4, verbatim) |
| `manifest: { ...runtimeManifest, distributions: siteDistributions }` → `manifest: runtimeManifest` | an in-place `pip --upgrade` passes the bind-time refusal (F11, verbatim) |
| deleting the CLI's `reconcileProviderEvidence` argument | the run stops reconciling its own ledger (F6, verbatim) |
| `if (options.verify === 'only')` → `if (false)` | `--verify only` silently repairs a manifest that misdescribes its build |

**So the run path moved.** `benchmark/lib/v11-runtime-binding.mjs` is the
composition, with injectable constructors, and `benchmark/cli.mjs` is option
parsing that calls it. `test/benchmark-v11-runtime-binding.test.js` drives it.
All three headline choices are now mutation-tested: reintroducing any of them
fails a test.

## F12 — No unit could have executed

`v11RuntimeDependencies` handed the runner `now: () => Date.now()`. The runner's
first act is `assertIsoTimestamp(options.now(), 'now')`, which requires a
non-empty string and throws `now must return an ISO timestamp`.

So a READY candidate with every flag supplied would start the provider meter,
open both ledgers, build the implementation lock and the environment lock, and
then die stamping `startedAt` — before `run_started`, before the first unit,
before any adapter was reached. A reviewer confirmed it by changing only the
clock in the one test that runs a full plan: pass 1 → fail 1, with that message.

This predates all three reviews. It survived them because it lives on the same
untested line as everything else in this section, and no probe uses the runner.

## F13 — The F10 fix re-created the refusal it removed, and opened two holes

Round 2 stopped a failed unit's zero counts from being enforced by *removing*
that unit's events before the comparison. Three consequences, all demonstrated
against the shipped module:

1. **`LEDGER_GAP` fired on exactly the run it was meant to save.**
   `requestNumber` is one counter across the whole attempt, so deleting a
   contiguous block belonging to a unit in the middle of the plan leaves a hole.
   A three-unit record with the failed unit owning requests 2 and 3 reported
   `DISCREPANT`, `LEDGER_GAP after 1 before 4`. The two tests certifying the fix
   both put the failed unit's events *last*, where no gap can form.
2. **The removed events escaped every per-event check.** `MODEL_MISMATCH`,
   `FAILED_OUTCOME` and `INCOMPLETE_USAGE` read no count. A failed unit whose
   ledger event named `gpt-4o-from-the-internet` reconciled clean.
3. **`EXCLUDED` and `NOT_MEASURED` units were excused too** — though
   `validateRawRun` *forbids* them from recording any operation, so their zero
   is structural and the record does know the answer. That is 20 of every 308
   units. The same input against the previous commit reported `UNEXPECTED_CALL`
   and two `MODEL_MISMATCH`es; this commit had turned a caught violation into a
   clean reconciliation.

**Fixed by narrowing the exemption to what it was ever about.** Nothing is
removed from the ledger. Every unit gets expectations. A `FAILED` unit's
correlation is passed as `unverifiedCounts`, and the reconciler skips *only* the
count comparison for it — no `MISSING_CALL`, no `RETRY_OBSERVED`, and no
`UNEXPECTED_CALL`-by-count — while `LEDGER_GAP`, `DUPLICATE_REQUEST_NUMBER`,
`MODEL_MISMATCH`, `FAILED_OUTCOME` and `INCOMPLETE_USAGE` all still apply. The
totals carry `unverifiedCountUnits` and `unverifiedCountEvents`.

The limit that remains is the honest one: the harness does not know *how many*
calls a crashed container made. It still knows what they were.

## F14 — `--verify only` measured fresh probes and judged the recorded ones

The round-2 fix made `--verify only` read the recorded manifest instead of
rewriting it, and overrode `distributions` with what the site now holds. It did
not override `importProbes`. The command runs four fresh import probes inside
the container, prints them, and hands the *build-time* probes to
`verifyPythonRuntime`.

A reviewer renamed `site/graphiti_core` (leaving its dist-info intact, so the
distribution checks still passed) and ran it: exit 0, `valid: true`,
`findings: []`, with `graphiti FAIL observed=None` printed in the same JSON
object. The previous commit exited 1 with `IMPORT_PROBE_FAILED`. The fix for one
fail-open had opened another.

**Fixed.** `--verify only` takes from the recorded manifest exactly what it
cannot re-observe — the image it was built against and the wheel-lock hash it
was built from — and measures everything else now.

## F15 — A real in-place upgrade leaves two `.dist-info` directories

`pip install --target <site> --upgrade` does not remove the superseded
`.dist-info`. Demonstrated in the pinned image: installing `httpx==0.28.1` then
upgrading to `0.27.2` left both directories, with `importlib.metadata` resolving
`0.27.2`. `readPythonSiteDistributions` returned both entries and
`verifyPythonRuntime` collapsed them with `installed.set(name, version)` —
last-`readdir`-wins — and reported **valid** against a lock pinning `0.28.1`.

So F11's own named case still passed, depending on directory order.

**Fixed.** A distribution installed at two versions is reported as
`DISTRIBUTION_DUPLICATED` rather than collapsed — which of them an import
resolves to is pip's business, not the lock's, and neither answer is a pinned
runtime. The site read also covers `*.egg-info/PKG-INFO`, because
`importlib.metadata` does and a `.dist-info`-only reader enumerated less than
the arms themselves see, and it now reads past a byte-order mark and CRLF
endings rather than returning nothing.

## The rest

| Finding | Answer |
| --- | --- |
| `RawSocketFenceTests` exercised 4 of the 9 new `_socket` guards; deleting the other 5 left 139/139 green | every one is exercised, in both directions; the reviewer's deletion now fails 3 |
| `runnerResources.persistUnit` was asserted by key name only; a no-op passed | it is called, and what it wrote is asserted |
| Both new refusals in `executeV11AcceptanceRun` were untested, and a test comment claimed one of them fires | both are tested, against the same READY candidate |
| `assert.deepEqual(recorder.invocations(), [])` compared two absent things — the recorder was built and never bound | the test now binds *both* executables and contrasts them, which is the property |
| The run-resources file's header claimed every assertion goes through real ledgers; one did not | the exception is marked, and says why counting calls needs recorders |
| `carries()` was widened in the wrong direction: the shape this path produces is the teardown error carrying the run failure | `combineRunFailure` asks both directions, and is exported and tested |
| The validity guard could not fire | removed in the last commit; the field is reported and explained |
| The round-2 record's F8 experiment paired one commit's JS count with the next commit's Python count | corrected, and said so |
| "four hundred lines" survived in `CANDIDATE-STATUS.md` — the document the distance measures | 890, counted |
| The withdrawn one-argument `sendto` claim was restated in `python_host.py`'s guard comment and left in the round-1 results table | both corrected |
| Requirement 4 was marked Closed while F10 had narrowed it | the limit is stated in the table |

## Verified live

- `benchmark/probes/loopback_fence_live_demonstration.py` in the pinned image on
  `--network host`: **18 of 18 as required**, unchanged.
- `readPythonSiteDistributions` against the real built runtime: **227
  distributions**, verification valid, zero findings.

## What this does not claim

- **No run was executed. No artifact exists.**
- **The CLI is thinner, not tested.** `v11RunCommand` still writes the artifacts
  and sets the exit status on lines no test reaches. What moved out is every
  decision: the binding, the failure combination, the ledger path, the
  reconciliation requirement. What remains is `writeJson` and `process.exitCode`.
- **F13 narrows the reconciliation.** A retry inside a failed unit is invisible
  to it. That is the truthful state.
- **The fence is an enumeration with named gaps.** Unchanged from round 2.
- **Seven findings were refuted** and are not here.
- **F2 and LB2f are untouched** and remain owner decisions.

## Reproduce

```
npm test                      # 2357 / 2357, 0 fail
npm run benchmark:test        # 1121 JS, then 139 Python
npm run benchmark:check
node benchmark/cli.mjs v11-preflight
```
