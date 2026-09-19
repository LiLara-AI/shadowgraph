# ShadowGraph v1.1: The First Run, and What It Found in 67 Units

- **Date:** 2026-09-06
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Run:** `v11-acceptance-001`, launched at `0a954b2`, **aborted at 67 of 308 units**
- **Official run status:** **NO VALID ARTIFACT**

The acceptance run started for the first time. Sixty-seven units in, it was
stopped, because it had found something no amount of reading had: **the harness
cannot measure any memory arm past phase A.**

## What the run reported

| Arm | MEASURED | FAILED | EXCLUDED |
| --- | --- | --- | --- |
| no-memory | **10** | 0 | 1 |
| shadowgraph-full | 3 | 7 | 1 |
| shadowgraph-compact | 3 | 7 | 1 |
| mem0-oss | 4 | 7 | 0 |
| basic-memory | 2 | 8 | 1 |
| graphiti | 0 | 10 | 1 |
| cognee | 1 | 0 | 0 |

Graphiti's ten are `ENDPOINT_UNAVAILABLE` and expected: LB2f, an owner-accepted
open blocker. The other twenty-eight are not. They are identical:

```json
{ "cause": "CONTRACT_FAILURE", "operation": "outer", "message": "Measured operation failed closed" }
```

…across four unrelated arms, on phases **B, C, D_TRUE, D_FALSE_0/1/2 and E** —
every decision phase except A. And the unit record says how:

```
"latencyMs": 101.577,
"operations": { "outerDecisionModelCalls": 0, ... },
"adapterEvidence": { "retrieve": { "status": "SUCCEEDED", "nativeContextCount": 1 } }
```

The arm retrieved its record successfully. The outer model was **never called**.
The unit died in a tenth of a second, before any work.

**No timeouts.** The F25 fix held.

## F26 — Three rules the benchmark holds at once, and one of them had to give

1. `v11-contract.mjs` gives every decision record a deterministic id per
   (arm, scenario, repetition, phase), and spelled it out:
   `decision:19:shadowgraph-compact:20:ACC_INCIDENT_HANDOFF:1:0:1:A`.
2. An arm retrieves its own records, and they become `nativeContext` — which is
   the whole point of the benchmark.
3. `v11-runner.mjs:1248-1253` refuses any outer request whose prompt contains
   the arm's id, as a plain lowercase substring:

```js
const prompt = request.prompt.toLowerCase();
for (const identity of [spec.arm.id, spec.arm.name]) {
  if (isNonEmptyString(identity) && prompt.includes(identity.toLowerCase())) {
    throw new Error('Outer request prompt must not identify the arm under measurement');
  }
}
```

So an arm that uses its memory puts its own name into the prompt through the id,
and the audit refuses the request. Phase A carries no native context, so it
passes. `no-memory` retrieves nothing, so it passes everything. **Every other
arm fails every decision phase after A.**

Reproduced offline against the state the run left behind, using the shipped
builder and the audit's own test:

```
phase A (no native context):   audit passes
phase B (one retrieved record): audit REFUSES - prompt contains "shadowgraph-compact"
phase C:                        REFUSES
phase E:                        REFUSES

...Adapter-native context: [{"actor":null,"alternatives":[{"id":"decision:19:shadowgraph-compact:20:ACC_...
```

Note that the boundary's own arm-identity classifier, `ARM_ID_PATTERN`, does
**not** flag this — it requires the id not be preceded by `[A-Za-z0-9._:-]`, and
here it is preceded by a colon. The audit's `includes` and the boundary's regex
disagreed about what "identifies an arm" means, and nothing compared them.

### Why this had never been seen

No v1.1 acceptance run had ever been executed. Five rounds of adversarial review,
twenty-five findings, 2363 tests — and this one needed a real arm to store a real
record and retrieve it. It is the first thing the first run found.

## The fix, and why this one rather than the others

Three were possible: neutralize ids before they reach the prompt; relax the
audit to word-boundary matching; or stop putting the arm id in the id.

Relaxing the audit was rejected: the model would then genuinely see
`shadowgraph-compact` in its context, which is the leak the rule exists to stop.
Neutralizing downstream leaves the name in storage and adds a scrubbing step
that can be forgotten.

**`decisionRecordId` now hashes its correlation**, with its own domain
separator, exactly as `unitIdFor` beside it already did:

```js
const digest = domainSeparatedSha256('shadowgraph:v1.1:decision-record-id:v1', {
  armId, scenarioId, repetition, phase
});
return `decision:${digest}`;
```

Determinism and uniqueness are preserved, which is all any caller needed — both
sides compute the id from the same correlation with the same function, and
nothing reads it for meaning. No production Python builds this id; it travels in
the request payload.

Verified end to end with the same reproduction that found it, across every arm
and phase:

```
21 of 21 arm/phase combinations pass the audit
```

Three mutations, three failures: restoring the readable id (F26 verbatim),
dropping the arm from the digest so two arms collide, dropping the phase so two
phases collide.

Notable in itself: **2363 tests passed before the guard was added.** Nothing
pinned the id format, and nothing asserted the property the audit depends on.

## F27 — a path segment, and an arm reported as failing for it

The run was restarted with F26 fixed, and reached 155 of 308 units with five
arms measuring normally. Cognee did not: **20 of its 22 units failed**, and the
monitor called it a timeout. It was not a timeout.

The provider meter's ledger says what it was:

```
#69  embedding  A  http=None  latency=0.0s
     failure={"code":"CLIENT_CONTRACT_FAILURE","message":"Metered provider request violated the bound contract"}
```

Eight of those, all Cognee, all `embedding`, all refused in **zero
milliseconds** — before any upstream call. Mem0's twenty-one embedding requests
went through. The `TIMEOUT` the unit reported is what the adapter said *after*
its embeddings kept being refused.

A bound capability is a whole URL, `/provider-meter/v1/<48 hex>`, and the meter
requires the rest of the path to equal the resource for the bound class. The
upstream base already ends in `/v1`. Clients disagree about what to append.
Measured, by standing up a server shaped like the meter's route and logging
what Cognee asked for:

```
POST  suffix=/chat/completions      model=qwen2.5:7b              MATCHES
POST  suffix=/v1/embeddings         model=nomic-embed-text:v1.5   REFUSED - meter wants /embeddings
```

Cognee's litellm completion path appends `/chat/completions`; its
`openai_compatible` embedding engine appends `/v1/embeddings`. Both name the
same resources the meter binds; one spelling was accepted and the other was
not, and **an arm was reported as failing over that**.

**The adapter cannot fix it.** The obvious candidate — hand Cognee an endpoint
that already names the resource — was tried and refuted in the same probe:
Cognee appends `/v1/embeddings` unconditionally, producing
`/embeddings/v1/embeddings`. No endpoint shape works.

**Fixed in the meter, in the one place that owns the comparison.** One leading
`/v1` is removed before the resource is compared *and* before it is forwarded.
The class separation the check exists for is untouched: a capability bound for
embeddings still cannot be used for a chat completion, in either spelling.

The second half of that sentence is the part the first attempt got wrong. The
meter forwards the client's resource path to the upstream base, so normalising
only the *check* would have accepted `/v1/embeddings` and then asked ollama for
`/v1/v1/embeddings`. The test asserts the forwarded path, and that is what
caught it before it shipped.

Four mutations, four failures: the normaliser reverted to identity (F27
verbatim); checked normalised but forwarded raw (the half-fix); `/v1` stripped
anywhere rather than only at the front; the class check dropped entirely. The
third of those initially **survived** — the comment said "leading" and nothing
pinned it — so the test now sends `/chat/v1/completions` and requires a refusal.

### What F27 means for the run that found it

Cognee's results in `v11-acceptance-002` are **not measurements of Cognee**.
They are our meter refusing its requests. Nothing from that arm may be read as
a property of the product.

## F28 — the isolation namespace is never registered, so the question cannot be asked

**Open, not fixed.** Basic Memory fails `ISOLATION_PROJECT` deterministically:
three of three repetitions, `OPERATION_FAILED` on `retrieve`, ~4.5s, after one
memory read. Every other phase of that arm is `MEASURED` (27 of 33 units), and
four other arms pass the same phase. So it is specific to this arm and this
phase.

The mechanism, established rather than guessed:

1. `basic_memory_adapter.py` calls `create_memory_project` **only in the RESET
   branch**, and only for the arm's own namespace plus the reset anchor.
2. `ISOLATION_PROJECT` retrieves with `project=<isolationProjectId>` —   `lantern-training` for one scenario, `mariner-lab` for the other — which
   RESET never creates.
3. Basic Memory raises rather than returning nothing for a project it does not
   know, and the adapter classifies that as `OPERATION_FAILED`.

**A first hypothesis was wrong and is recorded as such.** `_measured_storage`
raises `ContractError` when the project directory is absent, which looked like
the cause. It is not: `_project_path` calls `_ensure_real_direct_directory`,
which *creates* the directory. Computing the adapter's own digest over every
directory on disk shows all three present in every state root — the arm
project, the isolation project, and the anchor. The directory exists; the
*registration* does not.

### Why this is a harness question, not a Basic Memory result

The isolation claim is *the record is not visible under the other namespace*.
Demonstrating it requires querying that namespace and finding nothing. Four
arms can be asked; this one cannot, because the harness asks about a namespace
it never registered with the product.

Creating an empty project and finding nothing in it does not manufacture
isolation — it is the demonstration. But it is a change to what the arm is
asked to do, so it is recorded for the owner rather than taken here. The
alternative reading, that a product refusing to answer is itself the answer, is
a different claim from the one this phase makes, and the artifact currently
records neither: it records `OPERATION_FAILED`.

## An operator error in this session, recorded because it was reported wrongly

The first attempt to stop the run reported "stopped" and stopped nothing. The
pid was read inside a nested quoting level that produced an empty string, so
`ps -p ""` failed and the script took that for a dead process. The run kept
executing for roughly another fifteen minutes — visible in the ledgers, which
grew from 215 KB to 357 KB after the copy that was taken to preserve them. It
was found by noticing that discrepancy, and the process was then killed by
pattern rather than by pid.

Nothing was lost: the additional units carried the same defect, and the
preserved copy is ample evidence. But "stopped" was stated to the owner before
it was true, and this benchmark treats an unverified claim as a defect whether
it is in a record or in a sentence.

## What this record does not claim

- **There is no artifact.** The run was aborted, `benchmark/results/` was
  removed, and no acceptance result exists. The ledgers are kept outside the
  repository at `~/shadowgraph-v11-run-evidence/aborted-run-001/`.
- **The 67 units are not a partial result.** They are a defect report.
- **F26 is fixed, not F26's class.** The audit and the boundary still define
  "identifies an arm" differently; only the input that tripped the difference is
  gone. Nothing yet asserts that the two agree.
- **The six open findings from the pre-run review are still open**, including
  the one that made this dangerous: the raw artifact does not distinguish a
  harness refusal from a product failure.
- **LB2f is untouched.** Graphiti's ten failures are that blocker, observed.

## Reproduce

```
npm test                      # 2363 + 1, 0 fail
node --test test/benchmark-v11-contract.test.js   # the F26 guard
```
