# ShadowGraph v1.1 D4: The Retry Rule Stands, and a Retry Would Be Seen

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Official run status:** **NOT STARTED**

## Decision

D4 asked whether a retry floor the library does not let us disable is
acceptable, or whether `automatic_retries: 0` stands.

**It stands, and no amendment is needed.** The premise of the question turned
out to be false for the arm it was asked about: Mem0's SDK retries *are*
disableable, by rebinding the constructed client, and one request per call was
observed on the wire. That is D1, recorded in
`v11-mem0-execution-2026-09-05.md`.

What was actually missing was not permission. It was detection.

## The rule, and the gap

The frozen rule is narrow and precise:

> `/definitions/adapterFairness/retryRule` - "No transparent retry during
> measured units. Diagnostic retries are separately identified and never
> substituted."

It forbids the retry that leaves no trace. It does not forbid a retry that is
recorded and identified. So the methodology never needed changing; what it
needed was something that would notice.

`benchmark/lib/v11-provider-reconciler.mjs` already existed, already knew how to
compare a provider-meter ledger against what a run declared, and already had
`RETRY_OBSERVED` among its codes. It had **no caller anywhere outside its own
test**. It could have emitted `RETRY_OBSERVED` on every run of the benchmark and
nothing would ever have asked it to.

That is the same shape as the other defects this branch has surfaced: a
capability the harness claims, sitting in code that nothing invokes.

## What changed

The Mem0 execution probe's loopback proxy now writes the same
newline-delimited ledger the harness's meter writes - one
`shadowgraph.provider-meter.event` per request, carrying the full correlation,
both model ids, the outcome, the HTTP status and the usage block.

The correlation travels in the route. Each operation is handed a fresh path per
request class (`/embed/attempt-persist`), which is how the real meter mints a
capability: the path *is* the correlation, so a request is attributed exactly
rather than by arrival order or best fit.

`v11-arm-probe` then runs the **production reconciler** over that ledger, with
expectations read from the envelopes the adapter produced - the arm's own claim
about what it did - and the models read from `model-weights.lock.json`.

Reconciliation is done by the CLI rather than inside the probe, deliberately. A
demonstration that judged its own evidence would be exercising its own
comparison; the comparison that matters is the one the run will use.

## What was observed

Against the real pinned Ollama, with the real Mem0 arm:

```
"reconciliation": {
  "status": "RECONCILED",
  "totals": { "expectedCalls": 2, "observedEvents": 2,
              "matchedCalls": 2, "malformedLines": 0 },
  "findings": []
}
```

Two embedding requests declared, two observed, two matched, nothing malformed,
no findings.

## The control, because agreement is worth what disagreement would have cost

A reconciliation that agrees is worth exactly as much as the chance it had to
disagree, and this branch has now found three checks that were green for reasons
unrelated to their claims. So the same ledger is reconciled a second time with
one event duplicated - which is what a single transparent retry looks like - and
the command refuses unless that produces `RETRY_OBSERVED`:

```
"retryControl": {
  "detected": true,
  "findings": [{
    "code": "RETRY_OBSERVED",
    "correlation": { "runId": "demonstration-run", "attemptId": "attempt-persist",
                     "armId": "mem0-oss", "scenarioId": "scenario-1",
                     "repetition": 0, "phase": "A", "requestClass": "embedding" },
    "expected": 1, "observed": 2
  }]
}
```

Real traffic reconciles. The same traffic plus one request is named, with the
exact correlation that produced it. A reconciler that had quietly stopped
comparing would report `RECONCILED` on every run and read as a clean result;
this makes that state fail instead.

## What this does not claim

- **The reconciler is not wired into `v11-run`.** It is wired into the arm
  probe. The run path has no provider meter and no bound Python hosts, which is
  LB2a and is not done; until it is, there is no run ledger to reconcile.
- **Only one arm produced a ledger.** Graphiti and Cognee have never executed.
- **This is not the harness's meter.** The probe's proxy writes the meter's
  ledger *shape*; it is not `provider-meter.mjs`, and nothing here exercises
  that module.
- **No retry was ever observed in real traffic.** The control constructs one.
  The claim is that a retry would be seen, not that one happened.
- **`automatic_retries: 0` is demonstrated for Mem0 only.** Cognee's config
  carries `max_retries: 0`, unverified against a running arm.

## Reproduce

```
node benchmark/cli.mjs v11-arm-probe --arm mem0-oss \
  --runtime <runtime-site> \
  --work <writable-root> \
  --model-endpoint http://127.0.0.1:11434/v1
```

The command exits non-zero if the reconciliation is discrepant **or** if the
control fails to detect the injected retry.
