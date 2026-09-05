# ShadowGraph v1.1: The Review of the Review

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Under review:** `git diff 36e8ce2..cab97a3` — the commit that answered the first review
- **Official run status:** **NOT STARTED**

## Decision

The commit that fixed 35 findings shipped four of those fixes incomplete, and a
second review of that commit alone found them. 31 findings, three independent
skeptics each on distinct lenses, **30 survived**.

The shape of the misses is worth stating once, because it is the same shape
three times: **a defect was fixed in a module and left unfixed at the seam.**
The close was split correctly and then *chosen* wrongly-choosably in the CLI.
The fence was widened correctly across `socket` and not across `_socket`. The
reconciliation was written correctly and wired to expect things the record
cannot state. Each module's own tests were real and passed; each seam was
untested and would have carried the original defect straight through.

## F8 — The F4 fix could be undone at its own call site, with the suite green

`v11-run-resources.mjs` split the two closes and tested the split thoroughly.
But F4 was never a defect *in a module*: it was `benchmark/cli.mjs` handing the
runner `runtime.close` where it should have handed `runtime.closeMeasurement`.
That line is executed by no test. A reviewer changed it back — verbatim, at the
exact line — and ran the suite: **2336 / 2336 pass**, and 139 Python tests OK.

The new runner test the last commit added is called "closed the way the CLI
closes them" and does not read the CLI: it constructs `resources.closeMeasurement`
itself, so it cannot observe the CLI's choice. The record's claim that
"reintroducing the close ordering fails now" was true of the module and false of
the run.

**Fixed by removing the choice.** `createV11RunResources` now returns
`runnerResources` — the progress ledger, the unit ledger's append, and the
measurement close, already paired — and the CLI spreads it. A caller that
spreads cannot pair them wrongly, and the pairing is asserted in the module's
own tests, which do run.

## F9 — The fence was widened across `socket` and not across `_socket`

`socket` is a pure-Python wrapper around the C accelerator `_socket`, and
`socket.socket` subclasses `_socket.socket`. The widened fence guarded the
first spelling. Demonstrated in the pinned image, inside the installed fence:

```
_socket.socket(AF_INET, SOCK_DGRAM).sendto(b"shadowgraph", ("192.0.2.1", 9))  -> 11
socket.socket(AF_INET, SOCK_DGRAM).sendto(b"shadowgraph", ("192.0.2.1", 9))   -> NetworkFenceError
```

Eleven bytes to an arbitrary address, from the fence's own second entrance —
the same defect as the first round's, one layer down. For the three metered
arms on `--network host` this fence is the only barrier.

**Fixed**, as far as it can be. The five module-level resolvers on `_socket`
join `FENCED_ENTRY_POINTS`, which is now fifteen names. `_socket.socket` is an
immutable C type whose methods cannot be replaced, so the *name* is rebound to a
guarded subclass for the duration; `socket.socket` was built from the real base
at import time and is unaffected.

**And what stays open is now written down**, because that is what was wrong
twice: a reference to `_socket.socket` taken before the fence was installed, the
base type reached through `socket.socket.__base__`, and anything skipping
Python's socket API entirely — `ctypes`, a raw syscall, a C extension with its
own descriptor. No monkeypatch closes those. The container's network namespace
does, and only an arm that meters nothing gets it.

The restore was tightened at the same time: most of these attributes are
*inherited* rather than owned, and writing one creates an attribute that would
outlive the fence. The restore now removes what it created and reassigns only
what was already there.

## F10 — The reconciliation contradicted the record it was reconciling

`providerExpectationsFromRun` derived expectations from `unit.operations` for
every unit, and two paths make those numbers the harness's rather than the
adapter's:

- a container that fails mid-operation produces a **host-synthesised** envelope
  whose operation counts are all zero, while the provider calls it already made
  are in the ledger;
- an abort observed between the adapter returning and its counts being added
  (`v11-runner.mjs:1087`, before `addOperations` at `:1089`) **discards** them.

So a run containing one adapter failure, or any operator interruption, would
have reported `UNEXPECTED_CALL` and `RETRY_OBSERVED` against traffic its own
record never claimed to describe — a fail-closed refusal firing on a correct
run, and a new artifact contradicting the one beside it.

**Fixed by expecting only what the record can state.** Expectations come from
`MEASURED` units. Every other unit is returned as `unattributed`, its events are
held out of the comparison, and the totals carry `unattributedUnits` and
`unattributedEvents` — named and counted, not hidden. The exclusion is per unit:
a retry in a measured unit is still a finding while a failed unit's traffic is
set aside.

This is a real weakening of F6's guarantee and it is the honest one: the harness
does not know what a crashed container did, and saying zero would be a claim the
record cannot support.

## F11 — The runtime refusal never read the directory it gates

The bind-time check added for F7 verified `runtime-manifest.json` and never
opened the site. A reviewer copied the real runtime, ran the equivalent of
`pip install --target <site> --upgrade httpx` (dist-info renamed, METADATA
rewritten), left the manifest untouched, and the check returned **valid, zero
findings** — while the arms would have imported the upgraded package. The
in-place upgrade is the one case F7's own text names.

Worse, `v11-python-runtime --verify only` — the natural way to re-attest an
existing runtime — **rewrote** the manifest from the current locks before
verifying it, so `RUNTIME_IMAGE_MISMATCH` and `RUNTIME_WHEELS_LOCK_MISMATCH`
compared each value with itself and could never fire. A reviewer set the
manifest's `wheelsLockSha256` to 64 zeros, watched the bind-time check refuse,
ran `--verify only`, and watched the refusal disappear.

**Fixed.** `readPythonSiteDistributions` reads every `*.dist-info/METADATA` in
the site — where `importlib.metadata`, and therefore every arm's own
`require_versions`, reads its version from — and the bind-time check verifies
the *site's* distributions against the wheel lock, taking only the image, the
lock hash and the recorded import probes from the manifest. `--verify only`
reads the manifest the build wrote instead of writing a new one, and holds it
against what the site now contains.

Against the real built runtime: 227 distributions read off the site, verification
valid with zero findings.

## The rest

| # | Finding | Answer |
| --- | --- | --- |
| Gate values became self-referential | replacing the four literals with `**GATES` fixed the sampled-names defect and opened another: inverting `MEM0_TELEMETRY`, `TELEMETRY_DISABLED` and `BASIC_MEMORY_MODE` then passed | `REQUIRED_GATES` is written out, and `GATES` is asserted equal to it |
| The reconciliation's model guard accepted nameless descriptors | `{internal_memory_llm: {}, embedding: {}}` passed, made every `expectedModels` entry `undefined`, and disabled `MODEL_MISMATCH` entirely | the *ids* are required, and all three classes are tested |
| `LEDGER_UNREADABLE` was absent from `RECONCILIATION_CODES` | the list is documented as the complete set | added, with a note on which function emits it |
| `carries()` promised to unwrap causes and did not | a teardown failure wrapped by anything but an `AggregateError` was reported twice | it walks `cause` now |
| The validity guard could not fire | `validateRawRun` throws rather than returning `valid: false` | the dead guard is gone; the field is reported and explained |
| `close()` memoisation was observed only through the meter | de-memoising it passed | all three closes are counted |
| The binding probe's runtime/product distinction was in a probe nothing tests | reverting it to "did not throw" was invisible | it is `armReachedItsRuntime` in the host module now, with tests |
| The probe's AF_UNIX check reported OK when AF_UNIX was fenced | `NetworkFenceError` is an `OSError`, caught by the branch meant for a missing socket | the fence error is re-raised |
| "One-argument `sendto`" was claimed in three places | it is a `TypeError` in CPython, and not what the probe called | the claim is withdrawn and the comment says what is actually exercised |

## The documents, again

Six passages the last commit did not reach: the Mem0 record still said the run
path had no meter and that three arms had never executed, 120 lines below the
correction saying otherwise; the CB2 and adapter-runtime-blocker records — both
named in `CANDIDATE-STATUS.md` as *superseding* authority — still described the
pre-range tree; the runtime-binding record still documented the two-key return
shape and an exit rule the probe no longer follows alone; and the round-1 review
record gave a distance ("four hundred lines") that matches no reading of the
document it describes. Corrected, and the two superseded records now carry a
banner saying what in them still stands.

## Verified live, again

`benchmark/probes/loopback_fence_live_demonstration.py`, in the pinned image on
`--network host` against the pinned services: **18 of 18 as required**, up from
15 with the `_socket` paths added. Everything a metered arm does still works —
httpx and the OpenAI SDK to Ollama, a litellm embedding at 768 dimensions, Bolt
to Neo4j, all five resolvers, connected datagrams, AF_UNIX — and `_socket`
egress and `_socket.gethostbyname` are now refused alongside their `socket`
equivalents.

The bind-time runtime verification was run against the real built site:
227 distributions, valid, zero findings.

## What this does not claim

- **No run was executed. No artifact exists.**
- **The CLI's own sequencing is still untested.** `v11RunCommand` cannot be
  driven without the live stack, so the artifact write and the exit status are
  covered by nothing. What was done instead is to move every *decision* out of
  it: the reconciliation is now required by `executeV11AcceptanceRun` (deleting
  the call fails a test), the ledger path comes from one function used by both
  the meter and the reader, and the runner's resources are paired in a tested
  module. The sequence remains a reading exercise.
- **F10 narrows what the reconciliation can catch.** A retry inside a unit that
  failed is now invisible to it. That is the truthful state, not a good one.
- **The fence is an enumeration with named gaps**, stated above and in the
  module. It is not a kernel-level control.
- **One finding was refuted** and is not here: that the bind-time runtime
  verification had no test. It has one.
- **F2 and LB2f are untouched** and remain owner decisions.

## Reproduce

```
npm test                      # 2344 / 2344, 0 fail
npm run benchmark:test        # 1108 JS, then 139 Python
npm run benchmark:check
node benchmark/cli.mjs v11-preflight
```
