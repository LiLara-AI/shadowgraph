# ShadowGraph v1.1 LB2a: The Run Path Is Bound

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Official run status:** **NOT STARTED**

## Decision

LB2a is cleared. `v11RuntimeDependencies()` threw `RUNTIME_UNAVAILABLE` for the
whole life of the candidate; it now returns the nine dependencies the runner
requires, and **all seven arms bind to the runtime the competitor lock names for
them and reach it. Six of the seven execute a real operation**; the seventh,
Graphiti, reaches its runtime and refuses there, which is LB2f's recorded owner
decision.

That is a narrower claim than it sounds, and the next section is the reason it
has to be.

## The run still would not measure anything, and now we know why

Binding the runtime made it possible to ask questions that could not be asked
before. Three of the answers are findings, and two of them would have made a run
produce a complete artifact describing something other than what it claimed to.

### F1 - The container runtime refused the only image the benchmark has

`competitors.lock.json` pins `python:3.12.11-slim@sha256:47ae396f…`.
`buildContainerInvocation`'s `DIGEST_PINNED_IMAGE` permitted **no tag before the
digest**, so it refused that exact string. The registry accepted it, this
project's own probe commands hand it straight to `docker run` where it works,
and every existing test of the container runtime used a tagless image - so the
runtime and the only image the benchmark has had never been composed.

The consequence was not a crash. `containerLaunch` turns the refusal into a
`PythonAdapterExecutorError`, the new host binding faithfully translates it into
a FAILED envelope, and **all four container arms would have been recorded as
`CONTRACT_FAILURE`s of the products** for a disagreement between two of our own
regexes.

The pattern now permits the optional tag OCI allows. Nothing is weakened: the
digest still decides which image runs, and a tag without a digest is still
refused. The regression test asserts against the lock rather than a literal, so
a reference format the runtime cannot launch is a defect whichever side moves.

### F2 - The pinned decision model cannot satisfy the frozen response schema

Measured against the live pinned Ollama, through the real transport and the real
meter: **0 of 4 Phase A attempts** - both acceptance scenarios × both frozen
seeds - produced a decision `validateDecisionResponse` accepts. Three failed
with `failedAttemptIdsAvoided must be an array of strings`; one omitted the field.

`qwen2.5:0.5b` returns `"failedAttemptIdsAvoided": null` where the contract says
`string[]`, while returning `[]` correctly for six other `string[]` fields in the
same object. It also writes `"decisionId": "continuous-chat-stream,null"` -
reading `string|null` as an instruction to append the word.

This is not a harness defect and must not be treated as one. The schema
instruction is explicit, and `auditPhaseARequest` requires the system prompt and
the response schema to be byte-identical to the frozen constants precisely so
that nobody tunes the instruction until the model passes. **Phase A is the first
thing every unit does**, so on the pinned configuration every measured unit would
fail at the outer model.

This is an owner decision, not an engineering one. It is recorded, not resolved.

### F3 - Cognee refuses the namespace the definition says it supports

`acceptance/definition.json` declares Cognee `userIsolation: SUPPORTED`, so the
runner hands it a `userId`. The adapter refuses on sight:

> `Cognee user ACL is not locked for benchmark execution`

That refusal was correct when it was written, because CB2 was open. **CB2 is
cleared** - `v11-cb2-acl-demonstration-2026-09-05.md` shows Cognee 1.5.3
enforcing its native user ACL under the pinned configuration - so the refusal
encoded a precondition that had been demonstrated, and Cognee failed every unit
with `CONTRACT_FAILURE` before reaching its client factory.

**Fixed here.** The adapter resolves the benchmark's user id to a Cognee
principal and names it on every call, and the mirror property replaces the
refusal: a namespace *without* a user is now what gets refused, because the
definition declares this arm supports user isolation and resolving a missing
user to Cognee's default principal would measure a different isolation than the
one declared. The alternate namespace in a verify is listed as the other
principal rather than through the owner's view, since Cognee namespaces a
dataset id by its owner and the owner's view is the one guaranteed to contain
the record.

Its client factory followed, so LB2b is cleared for Cognee too: the real library
on its pinned file-backed stores, with the access-control posture checked rather
than assumed, and provider calls counted at httpx - the only seam Cognee shares
between litellm completions and its own embedding engine.

## What was built

| # | File | What it does |
| --- | --- | --- |
| N1 | `benchmark/lib/v11-python-hosts.mjs` | Binds the four Python arms. Carries `adapterCause` across the throw/return boundary, and gives an arm with no metered request class a container with no network. |
| N2 | `benchmark/lib/v11-outer-transport.mjs` | The metered `requestOuter`. Fresh capability per call; bridges the runner's watchdog signal into the fetch. |
| N3 | `benchmark/lib/v11-environment.mjs` | The ten observations the environment lock accepts, with no fallback for a command that does not answer. |
| N4 | `benchmark/cli.mjs` | `v11RuntimeDependencies` - async, returning `{dependencies, close, pinnedModels}`, where `dependencies` carries the progress ledger, the unit ledger's append and the *measurement* close already paired by `v11-run-resources.mjs` - plus `--provider-upstream`, `--state-root`, `--python-state-root`, `--python-runtime`, `--ledger-dir`. |

Four existing modules had to change before any of it could work:

- **`v11-run.mjs` forwarded no `closeResources`.** The runner knows how to close
  resources after the plan loop and *before* the terminal progress event - the
  only moment at which the provider ledger is complete and the run has not yet
  declared itself finished. Without the hook the only place left was the
  caller's `finally`, i.e. after the record was written.
- **`implementation-lock.mjs` exported no way to build the manifest it demands.**
  It refuses a manifest that omits any tracked governed source, and the table
  that decides which sources those are was private. `discoverImplementationLockFiles`
  now exposes it, and the lock still discovers independently and still refuses a
  manifest that disagrees - the caller is asking the same question twice, not
  being trusted.
- **`v11-runner.mjs` kept `UNIT_TIMEOUT_MS` private**, so a production caller had
  to restate 120 000 for the progress ledger. The ledger's `stalled` verdict and
  the hard deadline now agree by construction.
- **`python-container-runtime.mjs`** - F1 above.

## The demonstration

`benchmark/probes/runtime_binding_demonstration.mjs`, against the pinned image,
the pinned 227-package runtime and the pinned Ollama. It is deliberately not a
run: no plan, no progress ledger, no implementation lock, no artifact. One
`reset` per arm - the only operation every arm must implement, and the one a run
does first.

| Arm | Runtime kind | Outcome | Storage |
| --- | --- | --- | --- |
| `no-memory` | control | SUCCEEDED | MEASURED |
| `shadowgraph-full` | node-mcp | SUCCEEDED | MEASURED |
| `shadowgraph-compact` | node-mcp | SUCCEEDED | MEASURED |
| `mem0-oss` | python-container | **SUCCEEDED** | NOT_AVAILABLE |
| `graphiti` | python-container | FAILED (`ENDPOINT_UNAVAILABLE`) | NOT_AVAILABLE |
| `basic-memory` | python-container | **SUCCEEDED** | **MEASURED** |
| `cognee` | python-container | **SUCCEEDED** | NOT_AVAILABLE |

Seven bound, seven reached their runtime, **six executed**. Only Graphiti
refuses, which is LB2f's recorded owner decision rather than an open question.

Cognee reached that state in three steps over this record's life, and the first
two are F3 and its own client factory: it began at `CONTRACT_FAILURE` (refusing
the user namespace the definition declares it supports), moved to
`ENDPOINT_UNAVAILABLE` once that stale refusal was lifted and it could reach its
factory, and reached `SUCCEEDED` when the factory was implemented. The table
above is the last of those runs.

The provider ledger recorded zero events, which is correct: a reset makes no provider call, and a ledger that had
recorded one would mean an arm was reaching the model for an operation the
contract says it must not.

Basic Memory's `MEASURED` is LB2c, in a real container: the bytes are the
project directory that namespace owns.

## What this does not claim

- **No run was executed. No artifact exists.** The candidate has still produced
  no benchmark result, and this record does not change that.
- **Six arms executing one reset is not six arms measured.** Nothing here
  exercises retrieve, persist or verify for the container arms beyond what
  `v11-arm-probe --arm mem0-oss` already showed for one of them.
- **F2 means a run today would fail every unit at the outer model.** The harness
  being runnable and the run being meaningful are different questions, and only
  the first is answered.
- **Graphiti remains blocked**, on LB2f's recorded owner decision. Cognee does
  not: F3 is fixed above and its client factory followed, and the table records
  it SUCCEEDED. An earlier version of this bullet still listed Cognee as blocked
  on F3 three sections after declaring F3 fixed.
- **The `close()` path was wrong, and this record said only that it was
  untested.** It closed the progress ledger the runner still had to write the
  terminal event to, so a run that executed every unit and validated its own
  raw record would have died on its last line and written no artifact. An
  adversarial review of this range found it; `v11-run-resources.mjs` splits the
  measurement close from the run's own ledgers, and the composition is now
  tested against the real ledgers rather than a double that ignored `close`.
  Still no real run has exercised it.

## Reproduce

```
SHADOWGRAPH_PYTHON_RUNTIME_SITE=<runtime-site> \
SHADOWGRAPH_PROVIDER_UPSTREAM=http://127.0.0.1:11434/v1 \
node benchmark/probes/runtime_binding_demonstration.mjs
```

Exit status is non-zero if any arm fails to reach its runtime, or if the
provider ledger is not empty. A reset makes no provider call by contract, so
an event there would mean an arm reached the model for an operation that must
not - and the two conditions together are what make the empty ledger mean
something, since a ledger nothing reached is also empty.

An arm that reaches its runtime and refuses is reported, not hidden. An arm
whose container never launched is *not* counted as having reached it: the
executor turns every launch failure into a returned envelope, so the count
asks who wrote the envelope rather than whether one came back.
