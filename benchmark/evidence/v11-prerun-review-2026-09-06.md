# ShadowGraph v1.1: The Run Was Not Started, and Why

- **Date:** 2026-09-06
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Under review:** `git diff 3790797..97f9010`, and the run that was about to be executed against it
- **Official run status:** **NOT STARTED**

The owner approved executing the acceptance run. Preflight reported **READY with
zero blockers**, the Phase A probe accepted 6 of 6 against the committed lock,
and every gate was green. A pre-run adversarial review — six dimensions, three
skeptics per finding on distinct lenses — was run before starting, and it found
a reason not to.

## F25 — The per-operation deadline was sized for a model 15× smaller

`benchmark/lib/python-adapter-executor.mjs:30` sets
`DEFAULT_TIMEOUT_MS = 30_000` for a Python adapter *operation*, clamped at
`:956` to a maximum of `119_000`. `bindV11Runtime` constructs the Python hosts
without a `timeoutMs`:

```js
...build.createV11PythonHosts({
  stateRoot: pythonStateRoot,
  runtimeRoot: pythonRuntimeSite,
  providerEndpointFor,
  modelWeights
})
```

So every adapter operation in a real run gets thirty seconds, and no flag
changes it. Above it, `v11-runner.mjs:42` sets `UNIT_TIMEOUT_MS = 120_000` as a
hard monotonic deadline for the whole unit — also unreachable from the CLI.

Both numbers were chosen when the pinned decision model was `qwen2.5:0.5b`. The
model is now `qwen2.5:7b`, on a CPU-only Ollama, and one completion measures
**~29.6 seconds**.

Four of the six review dimensions reached this independently. It was then
measured rather than argued, in the pinned image against the live endpoint, with
Cognee configured exactly as `cognee_adapter._build_client` configures it — same
setter calls, same `openai/` prefix on the completion model and bare id on the
embedding one, same file-backed stores:

| Cognee operation | What the adapter calls | Measured | Deadline | Verdict |
| --- | --- | --- | --- | --- |
| **persist** | `add` (12.9s) + `cognify` (93.0s) | **105.9s** | 30s | **3.5× over** |
| **retrieve** | `search` | **38.7s** | 30s | **1.3× over** |

And against the unit budget, a decision unit is retrieve + outer decision +
persist: **38.7 + ~29.6 + 105.9 ≈ 175 seconds**, against a 120-second hard
deadline. Both ceilings are too low, not just one.

Cognee cannot avoid this. `cognee_adapter.py:646` asserts
`require_traffic("internal_memory_llm", "embedding")` on persist — an LLM call
is contractually required, not incidental. Mem0 is unaffected (it passes
`infer=False` and asserts `require_zero("internal_memory_llm")`; its probe
measured 9s). Basic Memory and the two ShadowGraph arms use no LLM. Graphiti has
Cognee's shape but is blocked by LB2f.

### Why this stops the run rather than slowing it

A timeout is recorded as a unit failure. Had the run started, Cognee's decision
units would have failed on a harness deadline and the artifact would have read
as *Cognee failed* — when what actually happened is *our ceiling was smaller
than the model we had just pinned*.

That is precisely the overstatement this benchmark treats as a defect. A
confident artifact reporting a competitor's failure, caused by our own
configuration, is worse than no artifact at all. **No run was started.**

### What it does not mean

The 30s and 120s values are **not** frozen methodology. The preregistration
freezes `requestTimeoutMs: 120000`, which governs one *outer* request and is
untouched here. It sets no per-operation or per-unit ceiling. These two are
harness parameters, and a harness parameter that was never sized for the
configuration under measurement is a defect in the harness, not a property of
the products.

### Resolved the same day, by owner decision

`UNIT_TIMEOUT_MS` is 600s. A new `ADAPTER_OPERATION_TIMEOUT_MS` of 300s is
passed explicitly by `bindV11Runtime` to `createV11PythonHosts`, and the
executor's clamp is raised from 119s to 599s so the unit watchdog remains the
one that fires last. Both values sit well clear of the measurement rather than
just above it, for the reason given under *What this record does not claim*.

The wiring is asserted now, which is the half that matters. F25 was an omitted
argument on a line no test entered — the same shape as F4, F6, F11 and F17. Four
mutations were run against the fix, and each fails a test:

| Mutation | Suite |
| --- | --- |
| `timeoutMs` omitted from `createV11PythonHosts`, exactly as F25 | fail 1 |
| `timeoutMs: 30_000`, the old effective value restored | fail 1 |
| operation ceiling raised above the unit ceiling | fail 1 |
| unit ceiling reverted to 120_000 | fail 1 |

The runner test that asserted the timeout message now derives the number from
`UNIT_TIMEOUT_MS` instead of repeating `120000`, because the property is that a
failure names the deadline it hit — which is how a reader tells a harness ceiling
from a product failure — and not that the deadline has any particular value.

## The other findings that survived

| Finding | Severity | State |
| --- | --- | --- |
| No interrupt handling and no reachable resume: `grep SIGINT\|SIGTERM\|AbortController` over `benchmark/cli.mjs` returns one hit, and it is an unrelated field read. Ctrl-C, a dropped connection or a sleeping laptop discards the whole multi-hour run | wastes-hours | **Open** |
| The raw artifact does not distinguish a harness-imposed deadline from a product failure — the run record drops the marker that carries the distinction | corrupts-the-artifact | **Open**, and it is what makes F25 dangerous rather than merely slow |
| Graphiti fails at an unconditional stub factory (`graphiti_adapter.py:51-54`, *"requires the Task 8 Neo4j image and model lock"*) — earlier than LB2f states, and it reports a service the probe has just verified as unavailable | corrupts-the-artifact | **Open** |
| An arm whose every decision unit failed is reported `PARTIAL_FAILED` — "partly measured" — when only its RESET units succeeded | corrupts-the-artifact | **Open** |
| Neither lock document is retained, so `implementationLockHash` and `environmentLockHash` are digests of preimages that exist nowhere | corrupts-the-artifact | **Open** |
| The readiness report is written on refusal but not on success, so a successful run keeps no record of what cleared its blockers | wastes-hours | **Open** |
| The run command needs five mandatory flags, and two path traps refuse late | blocks-the-run | Answered: the exact command line is below |

### Documents corrected in this commit

- `v11-readiness-and-f2-2026-09-06.md` said three follow-up steps "none has been
  done". All three were done in `97f9010`. Corrected, with what it did not
  anticipate stated.
- `CANDIDATE-STATUS.md` requirement 7 and the offline-harness section still said
  the run was blocked by the preflight findings and F2. Both cleared on
  2026-09-06; corrected to name F25 instead.
- `v11_phase_a_decision_probe.mjs` still documented F2 as open in its own header.

## The command, when the deadlines are right

Derived from `benchmark/cli.mjs:43,70-73,670-685` and
`v11-runtime-binding.mjs:146-172,235-240`, and to be run **inside WSL** from the
worktree root — `win32` is refused outright, and relative option values resolve
against the repository root rather than the working directory:

```
node benchmark/cli.mjs v11-run \
  --run-id v11-acceptance-001 \
  --service-evidence ~/shadowgraph-v11-run-evidence/service-evidence.json \
  --precondition-evidence ~/shadowgraph-v11-run-evidence/precondition-evidence.json \
  --provider-upstream http://127.0.0.1:11434/v1 \
  --state-root ~/shadowgraph-v11-run-state/node \
  --python-state-root ~/shadowgraph-v11-run-state/python \
  --python-runtime ~/shadowgraph-v11-runtime/site
```

`--python-runtime` must name the **site** directory: the binder reads the
manifest as its sibling. Both state roots must stay outside the worktree, or the
implementation lock's clean-tree check refuses every run after the first. `--out`
and `--ledger-dir` default to the gitignored `benchmark/results`.

## What this record does not claim

- **No run was executed. No artifact exists.**
- **The deadlines were changed only after the owner decided.** Raising them
  alters what the harness records as a stall. The measurement above is what the
  decision was made on; the values are in `v11-runner.mjs` and are not derived
  from any frozen source.
- **105.9 seconds is one observation of one record on one machine**, not a
  distribution. It is 3.5× the ceiling, which is the only precision the decision
  needs; a value chosen to sit just above it would be fitted to a single sample.
- **Nothing here says Cognee is slow as a product.** It says a 7B model on a CPU
  makes its pipeline slow, and the harness budget did not account for that.
- **Seven review findings were refuted** by two or more skeptics and are not
  listed.
- **LB2f is untouched.**

## Reproduce

```
npm test                      # 2363 / 2363
node benchmark/cli.mjs v11-preflight \
  --service-evidence <path> --precondition-evidence <path>   # READY, zero blockers
node benchmark/probes/v11_phase_a_decision_probe.mjs --endpoint http://127.0.0.1:11434/v1
```

The Cognee timing was taken in `python:3.12.11-slim@sha256:47ae396f…` on
`--network host` with the pinned runtime site mounted read-only, driving
`cognee.add` and `cognee.cognify` under the adapter's own configuration.
