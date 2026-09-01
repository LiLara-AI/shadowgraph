# ShadowGraph benchmark v1.1 — candidate status

ShadowGraph the product remains at **0.40.0** and `"private": true`. "v1.1" names
the benchmark methodology and candidate only. It is not a product release.

**This candidate has produced no benchmark result.** No scored run was executed,
no acceptance run was executed, no arm was ranked, and no comparative claim is
made anywhere in this repository. The historical run
`20260830T180000Z-comparative` remains permanently `INCOMPLETE / NOT MEASURED`;
it was not rerun and its partial state was not reused.

## Verification evidence

All figures below were produced on the current branch with a clean working tree.

| Gate | Command | Result |
| --- | --- | --- |
| Full repository | `npm test` | **2039 / 2039 pass**, 0 fail, 20 suites |
| Benchmark focused | `npm run benchmark:test` | **884 / 884 pass**, 0 fail |
| v1.1 suites only | `node --test test/benchmark-v11-*.test.js` | **741 / 741 pass**, 0 fail |
| Python adapters | `npm run benchmark:test:python` | **86 tests, OK** |
| Node syntax | `npm run check`, `npm run benchmark:check` | pass |
| Python syntax | `npm run benchmark:check:python` | pass |
| Package privacy | `npm run check:package` | pass |
| MCP | `npm run check:mcp` | pass |
| Integrations | `npm run check:integrations` | pass |
| Package smoke | `npm run smoke:package` | pass |

`npm run benchmark:journal:validate` is **not** an argument-free gate. It
requires `<raw-results.json>` and therefore only applies after a real run, which
has not occurred.

### Frozen bytes

Unchanged throughout, verified by `sha256sum` and an empty `git diff`:

```
738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac  preregistration.json
2b209df6ca46a179e332acd4ed0b16a35a089f5c14575dd86353db0dc7249c4a  preregistration-amendment-001.json
08e12eca3f93bd67cfeaf90a2064f91beb240e78a8fd63ed8645da78c0d88f1b  preregistration-amendment-002.json
```

All three `.sha256` sidecars are unmodified.
`preregistration-amendment-001.sha256` records a bare filename while the other
two record `benchmark/`-prefixed paths. This is a pre-existing inconsistency in
frozen bytes and is **deliberately preserved, not normalised**.

### Acceptance fixtures — weaker provenance, stated plainly

```
b48666efec93e4b7c6c6bebee66634546ccd991c66158d426d1547620720a596  acceptance/definition.json
728dc6e3f12db8334d31d29641caee01d4b1c645c5b51bcb27caa3fff5b4b14a  acceptance/scenarios.json
```

These two digests do **not** carry the same guarantee as the three above, and
should not be read as if they did. The files did not exist at `d493cd3` and have
no prior tracked version on any ref, so git cannot prove they were unmodified:
they arrived as untracked work from the interrupted session and were committed
as found. The claim that their bytes were never edited is supported by
filesystem mtimes predating this session's first commit, which is corroboration,
not proof.

What *is* provable from the repository: `definition.json` already recorded the
correct `scenarios.sha256` internally, so the two files were self-consistent
before anything was touched, and two digests asserted in
`test/benchmark-v11-definition.test.js` matched neither file. The **test
literals** were corrected; the JSON bytes were not.

### How to read the commit series

Much of the v1.1 work already existed as untracked files when this session
began, and was committed in stages. Several commits therefore appear in git as
pure additions while their messages describe repairing something that was
already there — `a442809` and `8c56e0b` are both new files with zero deletions,
and `e799342` also introduces the acceptance fixtures alongside the boundary
change.

The messages describe the change to the *candidate*, not the change to the
tracked tree. Reviewing this branch by diff alone will therefore understate what
was pre-existing and overstate what this session authored. Reviewers should
treat file content at HEAD, not the diffs, as the object of review.

## Requirement status

| # | Requirement | Status |
| --- | --- | --- |
| 1 | Serialized-input safety and error non-disclosure | **Closed**, scoped — see below |
| 2 | Registry, runner, CLI, validator, aggregator/scorer, truthful applicability | **Closed** offline; live execution waits on 6 |
| 3 | One centralized outer decision path; adapters memory-only | **Closed** |
| 4 | Provider-evidence reconciliation | **Closed** |
| 5 | Mutation state fails closed | **Closed** (mechanism); wiring waits on 6 |
| 6 | Real pinned runtime factories for all seven arms | **Open** — 4 of 7 real, 3 blocked; the 3 now covered |
| 7 | Non-scored acceptance, 308 units | **Closed** offline; a real run is blocked by B1/B2 |
| 8 | Locks, ledger validation, readiness, evidence index, review bundle | **Partial** — builders done, artifacts blocked |
| 9 | Focused, Node, Python, package, MCP, integration, smoke, privacy checks | **Closed** |

### Closed

**1 — Boundary.** Unit ids are one bounded opaque `unit:<64 hex>` derived by a
domain-separated digest, defined once in the contract kernel; the validator no
longer carries a second copy and rejects the legacy composite.

The non-disclosure claim is scoped deliberately, because a broader version of it
was written here once and turned out to be false. What is verified: **anything
that escapes `validateV11PublicScenario`, `validateV11AcceptanceScenario` or
`buildV11Prompt` is a `V11BoundaryError`** with a stable code and a static
message. Its `code` is the sole enumerable own property, so `JSON.stringify` of
the error is exactly `{"code":...}`; `name` is defined non-enumerably and no
cause is attached.

Each of those three functions is sealed around its **whole body**. An earlier
attempt sealed only the snapshot walk, which was not enough: the walk reads
through property descriptors, so a `get` trap never fires during it, and the
unsealed remainder then read `scenario.id` and let a raw `TypeError` out
carrying attacker-controlled text. Five such escapes existed and were found by
review, not by the tests written alongside the first fix — those tests placed
their proxy nested inside the sealed region and passed while the hole was open.

`loadV11AcceptanceDefinition` is **deliberately outside** that sealed set, and
is the only unsealed function that processes untrusted input. (Some exported
helpers also throw uncoded on a caller's own bad argument - a non-string key, an
empty arm vocabulary, an unknown boundary code. Their messages are static, and
none of those throw paths is reachable from scenario data: the boundary only
ever calls them with values it has already type-checked. Scenario data does
reach one of them - every validated key is folded by normalizedPublicDataKey -
but only ever as a string, which is the type its throw path requires it not to
be.) It reads harness-supplied paths, so
its failures are operator diagnostics: sealing it would replace "which file is
missing, and where" with an opaque code while buying nothing, since an unhandled
failure there carries a static field name or a path the harness itself supplied,
never scenario content. Independent review fuzzed it with 53 hostile-content
mutations of the two acceptance files: 51 rejected with a code, 2 rejected with
a static field name, none loaded, and no prototype pollution. Anything it
returns still passes through `validateV11PublicScenario` before it can become
prompt material.

Residual limitation, stated rather than resolved: a converted throw cannot be
attributed. Hostile input and a harness fault are indistinguishable at the
boundary, because every property that might tell them apart is itself
attacker-controlled — so a `ReferenceError` or `RangeError` raised inside the
sealed region is reported as `SHAPE`, the same code as a malformed input. That
is the correct trade for the security property but the wrong answer for
attribution, so `setSealedFaultSink` lets an operator observe converted throws
out of band. Nothing the sink receives may reach a unit result. Per-example regexes were replaced by one structural classifier
that normalises and decodes before classifying by shape. Public scenario and
native-context data are walked inertly through property descriptors, so a getter
is rejected rather than invoked, and validation returns an isolated
null-prototype snapshot.

**3 — Prompt fairness.** `buildV11Prompt` refuses an `armId` or a `system`
override, refuses any fixture-truth or expected-answer key at any depth, and
builds every measured phase from the same common path. Adapters receive memory
operations only.

**4 — Reconciliation.** `v11-provider-reconciler.mjs` matches ledger events to
units on exact run/attempt/arm/scenario/repetition/phase plus request class, with
length-prefixed key components so one field cannot impersonate another. It
reports missing calls, unaccounted traffic, retries, model substitution, failed
outcomes and absent usage, and checks ledger continuity separately so a numbering
gap is caught even when counts agree. Malformed lines are retained as evidence.

**5 — Fail-closed mutation.** A latch is fsynced before any native mutation and
removed only on confirmed success. A surviving latch forces `FAILED` /
`AMBIGUOUS` even against a reported success. No new unit status was introduced:
`AMBIGUOUS` is a mutation state, not a unit status, and the four contract
statuses are unchanged.

**2 — Integration.** The registry binds all seven arms to pinned runtimes and to
*observed* native isolation, refuses a lock that disagrees with an adapter spec,
and derives expected counts from whichever matrix is in force.

Readiness now has exactly one implementation, in `benchmark/lib/v11-run.mjs`.
`v11-preflight` and `v11-run` call the same function, and a test asserts their
blocker lists are deeply equal — the failure worth preventing is a preflight
that says NOT READY while a run starts anyway, and shared code is the only thing
that makes that impossible rather than merely unlikely.

`v11-run` refuses a blocked candidate, prints every blocker, exits non-zero and
writes **no** artifact, so a refused attempt cannot leave a directory behind that
later reads as evidence. Readiness is evaluated before the runtime binding is
resolved, so the refusal names the actual blockers rather than failing to reach
hosts that were never the point. There is no override flag.

`createV11AdapterExecutor` routes each arm to the runtime kind the lock names
for it and refuses an arm whose runtime host is not configured. It never falls
back to another host: running an arm on a runtime the lock does not describe
would report a measurement of software nobody pinned.

The full path — runner to validator to aggregator, with the progress ledger
supplying checkpoint and watchdog state and the unit-evidence ledger supplying
`persistUnit` — is exercised end to end over all 308 units in
`test/benchmark-v11-run.test.js`, with `validateRawRun` returning `valid: true`
for the run it just produced and 308 checkpoints on disk. That test uses a
**stub registry**, because a READY verdict is not reachable from the real one
today (graphiti declares user isolation the product does not have, and three
immutable prerequisites are absent). What it proves is that the pieces are
connected, not that the candidate is ready; the readiness tests beside it cover
the refusal against the real candidate.

**7 — Offline acceptance.** `test/benchmark-v11-acceptance.test.js` drives all
308 units through the real runner with the real prompt builder, adapters and
outer model injected: 16 EXCLUDED, 292 MEASURED, 28 RESET, 264 outer calls, each
count derived from the declared matrix and then cross-checked against the
definition, the loader and the literal. Eleven fault injections assert
fail-closed behaviour: prompt divergence, arm self-identification, memory
recalled before anything was stored, failed reset, unverified persistence,
malformed envelopes, outer failure with no fabricated fallback, watchdog stall,
interruption, resume, and one arm failing without taking the others down.

This closes the **offline** half of requirement 7 only. It is a mock harness
run. It is not evidence that any arm was measured, and B1 alone still prevents a
real acceptance run.

Building it found a real defect: the runner handed whatever `buildOuterRequest`
returned straight to the model with no audit. The injection point that makes the
runner testable is also what would let a caller give one arm different
instructions.

The first fix was incomplete, and independent review found it. It compared only
the system instruction and the response schema, so the task prompt — where the
instructions the model acts on actually live — was still free to differ per arm:
a biased `prompt` for one arm passed all 36 of that arm's units with the run
reporting 308/308 COMPLETE. The second attempt compared prompts across units
sharing a phase, scenario and native context, which is weaker than it looks — in
a real run each arm returns its own context, so almost every unit is the only one
of its shape and has nothing to be compared against.

`auditOuterRequest` now checks the property directly. It builds the request a
second time with a probe arm substituted and nothing else changed; if the two
differ, the builder consulted the arm, and the unit fails closed. That needs no
cross-unit baseline, so it holds on the first unit and on a resumed attempt
alike. The system instruction and response schema are separately pinned by the
first measured unit, and no prompt may name the arm it is running.

Divergence is checked rather than a particular wording: pinning the text would
bind the runner to one prompt module without catching anything divergence does
not, and `buildV11Prompt` already audits its own output. What this does **not**
prevent is a uniformly bad prompt given to every arm — that is a lock-level
question, not a fairness one.

Review also found that a resumed attempt started with an empty baseline, so 84
units were measured under a system instruction the first attempt never used,
with nothing recorded either way. The raw run now carries `outerPromptBinding`,
a digest pair for the system instruction and response schema, and a resume is
held to the previous attempt's binding.

Each guard is mutation-tested: removing the arm-invariance check fails 2 tests,
removing the resume seeding fails 1, and the pre-existing checks fail on removal
as recorded above.

**6 — Runtime factories, and what the blocked three actually do.** Four arms
have real pinned factories: no-memory, ShadowGraph Full, ShadowGraph Compact and
Basic Memory. Mem0 OSS, Graphiti and Cognee do not, because each needs a service
and a model lock that do not exist (B1, B2). That part is unchanged and is not
closeable offline.

What *was* closeable was the coverage gap. `_default_client_factory` is the code
path that actually runs today for those three arms, on every operation, and
nothing exercised it: every other adapter test injects a fake client, so a
default that crashed the adapter process, returned a SUCCEEDED envelope, or
counted work it never did would have passed the entire suite.
`benchmark/adapters/test_unprovisioned_runtimes.py` now covers it.

Writing that coverage surfaced the more interesting half. Each of the three
refuses, before reaching its runtime, the namespace shape its product cannot
natively honour:

| Arm | Native user scope | Project-only namespace | User-scoped namespace |
| --- | --- | --- | --- |
| Mem0 OSS | `user_id` | `CONTRACT_FAILURE` | `ENDPOINT_UNAVAILABLE` |
| Graphiti | none (`group_id` only) | `ENDPOINT_UNAVAILABLE` | `CONTRACT_FAILURE` |
| Cognee | ACL, not locked | `ENDPOINT_UNAVAILABLE` | `CONTRACT_FAILURE` |

Read across, that is "genuine native namespaces only, never manufacture
isolation" holding per arm, and holding whether or not the runtime exists. Mem0
will not silently widen a user scope it was asked for into a project-wide one;
Graphiti will not fold a user id into its group scope; Cognee will not run
against unpinned access control. The `ENDPOINT_UNAVAILABLE` cause in the
supported column is itself load-bearing: it tells a reviewer the arm is blocked
on provisioning rather than on its own contract.

In every combination the envelope is `FAILED` with a public cause, carries no
persistence or isolation evidence, counts zero operations of every kind, and
reports a static public message that is not the internal reason.

Note the consequence for Graphiti: the frozen matrix declares its user isolation
`SUPPORTED`, so the runner would send it a user-scoped namespace, and the
adapter would refuse every unit. That is the same contradiction `v11-preflight`
reports as a blocker, observed from the adapter side.

### Partial

**8 — Locks and bundle.** The readiness check exists, the isolation probe is
recorded under `benchmark/evidence/`, and provider-ledger validation is closed
under requirement 4.

The evidence index and review bundle **builders** are now implemented in
`benchmark/lib/v11-evidence-bundle.mjs`. The property they exist for is that a
review verdict can be bound to exact bytes: the index is sorted by path so it is
a function of its contents rather than of collection order, the bundle
serializes canonically, and its digest covers the commit, both lock hashes, the
three frozen source hashes and the index. Any change to any indexed artifact
changes the digest, so a verdict quoting one digest cannot be carried to a
different bundle.

Independent review found that `buildReviewBundle` checked only the index's
schema tag, so every protection below was bypassable by anyone who built the
index by hand — a traversing path, a malformed digest, a duplicate path with two
different digests, an unknown kind and a lying `entryCount` were all accepted at
once, and `requiredCoverage` was then satisfied against those unvalidated kinds.
Byte-identity was correspondingly conditional: it was a property of the index
builder's sort, not of the bundle. `buildReviewBundle` now rebuilds the index
from its own entries, which closes both. Removing that rebuild fails 3 tests.

Refusals: a malformed or fabricated-shaped digest, a duplicate path with two
digests, an absolute or traversing path, an empty index, an unrecognised
evidence kind, a short commit id, a missing required evidence kind, an
`entryCount` that disagrees with the entries, and any attempt to bundle a scored
run. They never hash files themselves — digests come from the caller that read
the bytes — because a builder that hashed its own tree could be pointed at a
different tree than the one under review.

Two known gaps, not yet closed: `verifyReviewBundle` treats `expectedDigest` as
optional and reports `verified: true` without it, and the path check accepts
`C:/x` and `a/./b` as repository-relative.

Lock and bundle **artifacts** remain deliberately ungenerated.
`implementation-lock.mjs` requires a fully clean tree (untracked files included)
and an immutable HEAD, so generating them before the governed source set is
final would be invalid. Model locks additionally require digests that do not
exist (B1), and `benchmark/service-images.json` cannot be authored without real
image digests, which is why `v11-preflight` still reports all three immutable
prerequisites as unmet.

## Known limitation: the `persistence` applicability field is inert

Both count implementations key exclusively off `userIsolation`. `no-memory`
declares `persistence: NOT_APPLICABLE` yet no persistence unit is excluded
anywhere, and `validateApplicability` shape-checks the field without it ever
affecting a count. Either the field is genuinely decorative — in which case
declaring it invites a false reading of the matrix — or a second exclusion rule
is missing. This is recorded rather than resolved, because changing which units
are excluded is a methodology decision.

## Blockers

**B1 — Immutable model-weight digests do not exist.**
`proposal-reference/MISSING-EVIDENCE.md` records: *"Complete immutable Ollama
model digests: NOT CAPTURED; only short Ollama IDs were available."*
`implementation-lock.mjs` requires `sha256:<64 hex>` with
`digestKind: model_weights`. Short Ollama ids cannot satisfy that. **This alone
prevents a real acceptance run.** No digest was synthesised.

**B2 — Services are not provisioned.** Graphiti needs a Neo4j-compatible
database plus an LLM and embedding endpoint; Cognee needs an LLM and embedding
endpoint. Mem0 needs an LLM and embedding endpoint for its declared request
classes. `v11-preflight` reports graphiti and cognee as blockers rather than
assuming them. It cannot block on mem0-oss: the competitor lock records no
`requiredService` for that arm even though its declared request classes need an
LLM and an embedding endpoint, so the gate has nothing to key on. That gap is in
the lock, not the gate, and it is why the readiness check names two arms while
this paragraph names three.

B2 covers **three arms, not all seven**. An earlier revision of this document
treated requirement 6 as wholly blocked, which overstated it. `no-memory`,
`shadowgraph-full` and `shadowgraph-compact` need no external service by
construction, and `basic-memory` was **measured** running its full adapter
operation sequence under `--network none` (see `benchmark/evidence/`), so its
`requestClasses: []` declaration is truthful and it needs no provider endpoint
either. Those four arms are open engineering, not blocked work, and the
distinction matters because a blocked item invites no further effort while an
open one does.

`v11-preflight` gates on B1 and B3 as well as B2, so satisfying every
applicability finding still leaves it NOT READY. A readiness check that could
go green while immutable prerequisites were missing would be worse than none.

Those gates read file **content**, not merely file existence — an earlier
version could be cleared by three files containing `{}` — and an unreadable or
malformed prerequisite file counts as unsatisfied rather than aborting the
command. What they cannot do is establish authenticity: a syntactically valid
digest for a model nobody ran would satisfy the shape check. Every prerequisite
blocker therefore carries that caveat in its own text, and confirming
authenticity remains a reviewer's job.

**B3 — Runtime bytes are version-pinned, not byte-pinned.**
`competitors.lock.json` contains exactly one `sha256` — the base image. There is
no requirements lock, no Dockerfile and no wheel hashes, so installed transitive
bytes are not reproducible. Until wheel-hash or derived-image evidence exists,
**no document may describe these clients as fully pinned.**

Not blockers, only ordinary setup: `npm install`, and Python packages installed
inside the pinned image.

## Open methodology question

Amendment 002 declares `userIsolation: SUPPORTED` for both `graphiti` and
`cognee`, while both adapters reject a non-null `userId`. That contradiction
determines how many `ISOLATION_USER` units are EXCLUDED, so it was settled by
observation rather than assumption. The probe is recorded in
`benchmark/evidence/`.

The two arms resolve **differently**:

- **Graphiti 0.29.3** exposes no user scope at all — no method parameter and no
  user field on either node model. Expressing a user would mean folding one into
  `group_id`, which is the manufactured isolation the methodology forbids. The
  adapter is correct and the matrix entry is not.
- **Cognee 1.5.3** does have a native user ACL, assignable programmatically. Its
  adapter refusal records that this harness has not pinned that ACL, not a
  missing product capability.

If Graphiti alone moves to `NOT_APPLICABLE`, the counts become
**308 / 20 EXCLUDED / 288 MEASURED / 28 RESET / 260 outer calls**, the delta
being exactly Graphiti's four `ISOLATION_USER` units.

**No amendment has been adopted and no count has been changed.** The acceptance
definition still carries the Amendment 002 counts
(308 / 16 / 292 / 28 / 264), and `v11-preflight` reports the disagreement as a
blocker. Correcting a declared applicability entry requires an amendment reviewed
under the methodology, which is not a decision this engineering work may take.

## What independent review must confirm

Review must be performed by a **different agent** than the one that wrote this,
and bound to a specific commit. Offline green tests authorise nothing: not
readiness, not acceptance, and not permission to execute.

1. The frozen digests above, recomputed independently.
2. That no scored or acceptance run exists anywhere in the tree.
3. That the boundary discloses no rejected material — check the error surface,
   not only the message.
4. That no isolation is manufactured by concatenating identifiers.
5. That the Graphiti and Cognee probe conclusions follow from the recorded
   evidence.
6. That B1, B2 and B3 are still open, since each one independently prevents an
   acceptance run.
