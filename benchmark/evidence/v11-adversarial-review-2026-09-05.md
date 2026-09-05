# ShadowGraph v1.1: What an Adversarial Review of the Run-Path Range Found

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Under review:** `git diff 1d005fe..36e8ce2` — the seven commits that bound the run path
- **Official run status:** **NOT STARTED**

## Decision

The range that cleared LB2a shipped with a defect that made every bound run
fail on its last line, a network fence that guarded four of the ten ways out
of the process, four guards that could not fire, four tests that were
satisfied by absent things, and sixteen passages across six documents and two
source comments that the same commits had made false. All of it was green:
2317 JS tests, 134 Python tests, `benchmark:check`, `check`, and a preflight
reporting READY with zero blockers.

Six reviewers, one per dimension, produced 40 findings. Each was then handed to
three independent skeptics on distinct lenses — correctness, reachability,
evidence — with instructions to refute it and to default to refuted. **35
survived.** This record is what they found and what was done about it.

The two that matter most are worth stating plainly, because both were invisible
to the entire suite and both would have produced a confident wrong answer rather
than a failure.

## F4 — No bound run could finish

`v11RuntimeDependencies` returned one `close()`, and it was handed to the runner
as `closeResources`. The runner calls that hook after the plan loop and **before**
it appends the terminal `run_finished` / `run_interrupted` event — and the hook
closed the progress ledger that event goes into. `progress.append` rejects once
closed.

So a run would execute all 308 units, persist every one to the unit ledger,
validate its own raw record as COMPLETE, and then die with `Progress ledger is
closed`. `v11RunCommand` never reaches `writeJson`: no `.raw.json`, no
`.aggregate.json`, exit non-zero. The interrupted branch fails identically, so
the ledger could never end durably with `run_interrupted` — which `validateResume`
requires — making the run unresumable as well.

A reviewer reproduced it by composing the real ledgers with the exact
`closeResources` the CLI built: `RUN THREW: Error - Progress ledger is closed`,
against a control that removed only `progress.close()` and returned
`RUN OK status=COMPLETE units=11`.

**Why nothing caught it.** The one test of the ordering
(`test/benchmark-v11-runner.test.js`) passed a fake progress recorder with no
`close()` and an `append` that accepted forever. It asserted that the terminal
event arrives after teardown — that is, it asserted precisely the ordering that
breaks the real ledger, and was green because the double ignored the contract it
was standing in for.

**Fixed.** `benchmark/lib/v11-run-resources.mjs` splits the two closes and makes
the split structural rather than remembered:

- `closeMeasurement()` is built from the meter and can reach nothing else. It is
  what the runner gets. The moment exists for the meter alone — closing it
  drains the in-flight handlers and the ledger append chain, so the provider
  ledger is complete at the instant the run declares itself finished.
- `close()` is the caller's `finally` and shuts all three.

Both are memoized. A single teardown failure is rethrown as itself rather than
wrapped, so the operator sees which resource failed. Passing one object as two
resources is refused — that is this defect arriving through the argument instead
of the body.

The fake now rejects appends after close, and a new test runs the real runner
against the real ledgers with the real closer. Mutating `closeMeasurement` to
close the run's ledgers again fails two tests.

## F5 — The loopback fence guarded four of ten ways out

`_loopback_only_network` guarded `connect`, `connect_ex`, `create_connection`
and `getaddrinfo`, and its docstring said it closed egress **"by construction
rather than by enumeration"**. It was an enumeration, and an incomplete one.
Demonstrated against the production module inside the pinned image:

- **A datagram needs no connection.** With the fence installed and active,
  `sock.sendto(b"...", ("192.0.2.1", 9))` returned 23 and
  `sendmsg([...], [], 0, ("192.0.2.1", 9))` returned 5, while a control
  `getaddrinfo("example.com", 80)` in the same block raised `NetworkFenceError`.
  `dnspython==2.8.0` is in the pinned 227-package runtime and resolves exactly
  this way.
- **`gethostbyname` does not route through `getaddrinfo`.** It returned a public
  address while `getaddrinfo` refused in the same block.

This mattered because the three metered arms run `--network host`: for them the
fence is the only barrier, and the container namespace — the part that genuinely
is by construction — protects only the arm that meters nothing.

**Fixed.** Ten entry points, named once in `FENCED_ENTRY_POINTS` and read from
that one list by the save, the guard table and the restore, with a refusal if
the two tables ever disagree: `socket.connect`, `socket.connect_ex`,
`socket.sendto`, `socket.sendmsg`, `create_connection`, `getaddrinfo`,
`gethostbyname`, `gethostbyname_ex`, `gethostbyaddr`, `getnameinfo`. `send` and
`sendall` are deliberately absent — reaching them requires a `connect` the fence
refuses. The docstring now says it is an enumeration and says which one.

Mutating the fence back to its four original entry points fails three tests and
errors a fourth. And because widening a fence can break the thing it protects,
it was then run against the real libraries in the pinned image - see below.

## F6 — The run wrote a provider ledger and nothing read it

`reconcileProviderEvidence` had exactly one production caller: `v11-arm-probe`.
The acceptance run opened `<attempt>.provider-requests.ndjson`, filled it, and
closed it. Nothing ever compared it against what the run said it did — so
`RETRY_OBSERVED`, `MODEL_MISMATCH` and `UNEXPECTED_CALL` were codes an
acceptance run could not emit, while the probe's own comment claimed it was
rehearsing "the comparison that matters — the one the run will use".

**Fixed.** `providerExpectationsFromRun` turns a finished run record into one
expectation per (unit, request class), for all three classes including the zeros:
an arm that meters nothing still has to be *checked* to have metered nothing, and
an expectation of zero is what turns a stray event into `UNEXPECTED_CALL` instead
of into silence. Only this attempt's units, because the ledger is opened per
attempt. `v11RunCommand` reconciles after the meter closes, writes
`<attempt>.provider-reconciliation.json`, and **exits non-zero on any
discrepancy**. A ledger that cannot be read is `UNAVAILABLE`, not `RECONCILED`.

## F7 — The Python runtime site was never checked against the lock

`verifyPythonRuntime` existed and its only caller was the *build* command. The
run path mounted whatever `--python-runtime` named, checking only that the path
was absolute. A site built from a stale wheel lock, or one where a transitive
dependency such as `httpx` or `litellm` was upgraded in place, satisfies every
arm's own `require_versions` — which checks that arm's top-level pinned
distribution and nothing else — and produces an artifact whose implementation
and environment lock hashes are identical to a run on the locked 227-package
set.

Neither lock can cover it: the implementation lock covers tracked repository
sources, and the environment lock's ten fields are frozen. **Fixed** by
verifying the site's manifest against the wheel lock and the pinned image at
bind time and refusing with `RUNTIME_UNAVAILABLE`. Refusing is what makes those
hashes mean the configuration that was measured.

## The fence, checked live against the real libraries

Widening a fence that sits in the execution path of four arms is exactly the
change that breaks a measurement silently, so it was checked in both directions
inside the pinned image, on `--network host`, against the pinned 227-package
runtime and the live pinned services -
`benchmark/probes/loopback_fence_live_demonstration.py`.

| Path | Verdict |
| --- | --- |
| `httpx` -> pinned Ollama on 127.0.0.1 | OK - 200, 3 models |
| OpenAI SDK -> pinned Ollama | OK - 3 models |
| `litellm.embedding` -> pinned Ollama | OK - 768 dimensions |
| Bolt -> pinned Neo4j on 127.0.0.1:7687 | OK - connected |
| `getaddrinfo`, `gethostbyname`, `gethostbyname_ex`, `getnameinfo`, `gethostbyaddr` for loopback | OK - all five resolve |
| connected loopback datagram (`send` and one-argument `sendto`) | OK - 9 bytes each |
| `AF_UNIX` | OK - reaches the kernel, `FileNotFoundError` |
| `connect` -> 192.0.2.1:80 | **Refused** |
| `sendto` -> 192.0.2.1:9 | **Refused** |
| `getaddrinfo("huggingface.co")` | **Refused** |
| `gethostbyname("huggingface.co")` | **Refused** |

15 of 15 as required, exit 0. Nothing a metered arm legitimately does was lost,
and both of the holes the review found are closed.

The run also caught one on its own, which is worth recording because it was not
arranged: importing LiteLLM under the fence produced

> `LiteLLM: Failed to fetch remote model cost map from`
> `https://raw.githubusercontent.com/BerriAI/litellm/... : Adapter network access`
> `is limited to loopback. Falling back to local backup.`

That is an unmetered outbound fetch, from a library three of the four Python arms
load, refused in the act. `LITELLM_LOCAL_MODEL_COST_MAP=True` is one of the gates
and closes the same path at the place LiteLLM documents; this probe applies only
the fence, so the two are independent and either one alone would have stopped it.

## The runtime verification, checked against the real site

The bind-time refusal added for F7 was run against the actual built runtime at
`/home/khouly/shadowgraph-v11-runtime/site`: `verifyPythonRuntime` returns
`valid: true` with zero findings against `python-wheels.lock.json` and the pinned
image, and the manifest is where the run path looks for it
(`dirname(site)/runtime-manifest.json`). A new refusal that would have blocked a
legitimate run is a worse defect than the one it fixes, so this is the half that
had to be shown rather than argued.

## The guards that could not fire

| Where | What it claimed | What it was |
| --- | --- | --- |
| `v11-python-hosts.mjs` | the registry and the executor disagreeing about an arm's metered request classes is a registry defect | the registry sets `requestClasses` to `spec.requestClasses` from the same import, so the check compared a frozen array with itself |
| `v11-environment.mjs` | the Python image is digest-pinned | `pythonImage.includes('@sha256:')` — a substring test that accepted `'@sha256:'` itself, a 63-character digest, and a reference with a shell argument appended |
| `v11-provider-models.mjs` | `providerModelsFor` narrows the lock to one arm and lets the host state the invariant as a comparison | no production caller; the host hand-rolled a duplicate that skipped its distinctness and unknown-class checks |
| `basic_memory_adapter.py` | (on every failure path) storage is unavailable because Task 8 must still lock a byte-attribution method | the same module implements one and LB2c is cleared — a run artifact asserting an open blocker the same commit closed |

The first is now described accurately: one table states an arm's metered classes,
so the check refuses a descriptor that did not come from the registry, which is
worth refusing but is not two independent readings meeting. The real invariant is
now checkable and checked — the models and the network come from one narrowing,
so an arm gets a network **if and only if** it was handed a model to reach over
it. The second uses `DIGEST_PINNED_IMAGE`, the pattern the launch path already
applies. The third is called. The fourth says what it means: this invocation
failed before a byte scope existed.

## The tests that were satisfied by absent things

| Test | Satisfied by | Now |
| --- | --- | --- |
| the models a Python arm is handed | shape only — the wrapper carrying the values went to a docker stand-in that drained stdin and discarded it | the stand-in keeps stdin; the test asserts the lock's own `modelId` and `embeddingDimension` on the wrapper the container reads |
| Basic Memory storage bytes | `0 == 0` — the fake client keeps notes in a dictionary, so the directory was empty and the assertion re-implemented the adapter's walk over nothing | two files of known size in the owned directory and 10 000 bytes outside it; the expectation is the literal `41 + 137` |
| the six new environment gates | a comparison of `GATES` with itself; the one test that reads the applied environment sampled six names, none of them new | the applied-environment sample is `tuple(python_host.GATES)` |
| teardown ordering | a progress double with no `close()` | the real ledgers, through the real runner |

**Mutation-tested, each one.** Replacing the narrowing with mem0's own defaults
(`gpt-5-mini`, `text-embedding-3-small` at 1536) fails; `total += 0` fails;
walking the state root instead of the project directory fails; truncating the
gate loop to seven fails; reverting the digest check to the substring fails;
reintroducing the close-ordering defect fails. Before this commit every one of
those mutations passed the entire suite.

## The demonstration that passed for arms that never ran

`runtime_binding_demonstration.mjs` counted an arm as having reached its runtime
if the executor **returned rather than threw**. The Python host converts every
`PythonAdapterExecutorError` into a returned FAILED envelope, so a container
that never launched counted as reached — a reviewer confirmed it with
`dockerExecutable: '/nonexistent/docker-binary'`. On a host with no Docker
daemon the probe would have exited 0 and the record would have read "seven
bound, seven reached their runtime" with no container ever started. This is the
same shape as F1, which this branch had already found once.

The envelopes the host synthesises now carry an exported constant,
`HOST_SYNTHESIZED_FAILURE`, and the probe distinguishes on it: a failure the
*product* reported means the runtime was reached, one the harness produced on its
behalf does not. Its header also claimed to show a metered arm's provider call
arriving at the meter — a reset makes no provider call by contract. The claim is
replaced by the negative one it can actually make, and that one is now checked:
a non-empty provider ledger fails the probe.

## The documents

Sixteen passages - across six documents and two source comments - asserted the
opposite of the tree they shipped in. Every one is corrected in place, with what
it used to say, because a record that quietly reads as current when it is not is
the failure mode this candidate keeps finding in itself.

- **`CANDIDATE-STATUS.md`** — requirement 6 said the metered runtime hosts remain
  unimplemented, 763 lines above a matrix recording all seven arms bound and
  reached. Requirement 7 cited four preflight findings where preflight emits
  three. The blocker section said "there is still no runtime that could run it",
  masking the real reason a run today would be meaningless, which is F2. And the
  open-methodology section said no amendment had been adopted and the definition
  still carried the Amendment 002 counts (308/16/292/28/264) — four hundred lines
  after the same document recorded adopting Amendment 003, and against a
  definition and a preflight that both report 308/20/288/28/260.
- **`v11-runtime-binding-2026-09-05.md`** — the bolded headline claimed all seven
  arms execute a real operation where the table beneath it records six; a scope
  bullet still said five after the table moved to six; and the section written to
  bound the record's claims listed Cognee as blocked on F3 three sections after
  declaring F3 fixed.
- **`v11-mem0-execution-2026-09-05.md`**, **`v11-retry-reconciliation-2026-09-05.md`**,
  **`v11-cognee-dataset-identity-2026-09-05.md`** — each stated in the present
  tense that the run path has no provider meter and no bound Python hosts, that
  LB2a is not done, that Cognee's client factory is still `RuntimeUnavailable`
  and its `userId` refusal untouched. Later commits in the same range made all of
  it false.
- **`v11-unpinned-model-fence-2026-09-05.md`** — repeated the fence's "by
  construction rather than by enumeration" claim.
- **`cli.mjs`** — `v11-arm-probe`'s docstring said the run path refuses at
  `RUNTIME_UNAVAILABLE` and measures nothing, and the comment beside its
  reconciliation said `reconcileProviderEvidence` had no caller outside its own
  test. Both are now true statements about the code beneath them.

## What this does not claim

- **No run was executed. No artifact exists.** The candidate has still produced
  no benchmark result, and nothing here changes that.
- **F4 was found by review, not by a run.** The composition is now tested against
  the real ledgers, but no real run has exercised teardown.
- **The provider reconciliation has never judged real traffic.** It is wired and
  unit-tested. Whether the correlations the meter records and the correlations
  the run record carries line up in practice is a question only a run answers.
- **Five findings were refuted and are not here.** Among them a claim that the
  Cognee record's frozen-file search could not be reproduced: two of three
  skeptics reproduced it exactly.
- **This review does not authorise a run.** F2 is unchanged and remains an owner
  decision, and so is LB2f.

## Reproduce

```
npm test                      # 2336 / 2336, 0 fail
npm run benchmark:test        # 1100 JS, then 136 Python
npm run benchmark:check
node benchmark/cli.mjs v11-preflight
```
