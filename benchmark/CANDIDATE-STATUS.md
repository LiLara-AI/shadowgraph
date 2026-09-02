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
| Full repository | `npm test` | **2061 / 2061 pass**, 0 fail, 20 suites |
| Benchmark focused | `npm run benchmark:test` | **906 / 906 pass**, 0 fail |
| v1.1 suites only | `node --test test/benchmark-v11-*.test.js` | **762 / 762 pass**, 0 fail |
| Python adapters | `npm run benchmark:test:python` | **86 tests, OK** |
| Node syntax | `npm run check`, `npm run benchmark:check` | pass |
| Python syntax | `npm run benchmark:check:python` | pass |
| Package privacy | `npm run check:package` | pass |
| MCP | `npm run check:mcp` | pass |
| Integrations | `npm run check:integrations` | pass |
| Package smoke | `npm run smoke:package` | pass |

That no result exists is now asserted by the suite rather than checked by hand.
It is the single most important claim in this document and it had been verified
only by a reviewer, six times. The check has the same shape as the executable-bit
and NUL-byte assertions: a sweep over `git ls-files` plus the working tree,
refusing any `benchmark/results/` directory and any tracked raw or aggregate
artifact.

`npm run benchmark:journal:validate` is **not** an argument-free gate. It
requires `<raw-results.json>` and therefore only applies after a real run, which
has not occurred.

`npm run benchmark:test` runs at Node's default concurrency while `npm test`
pins `--test-concurrency=1`, and the difference is load-bearing. One run of it
failed a single test, `journal benchmark treats projection collection order as
non-semantic at 1k`, which re-ran clean immediately after. The cause is not
timing. `scripts/bench-journal.mjs` reported `json at 1000 was not measured` and
`sqlite at 1000 was not measured`, and the backend evidence carried
`ENOSPC: no space left on device`. Six copies in parallel reproduce it seven
times in eight; run sequentially it is green three times in three. The tool is
behaving correctly - it refuses to report a measurement it did not take - and
the failure is environmental. It is recorded because a suite that can fail for a
reason unrelated to the code under test is precisely what corrupts a mutation
table, and because the host `/tmp` was found holding 83,833 leaked
`shadowgraph-*` scratch directories occupying 8.7 GB of a 16 GB tmpfs,
accumulated since 30 August 2026. That glob undercounts. Independent review
measured the tmpfs again after a few further hours of test runs and found 18,901
leaked directories holding 7.82 GB, of which only 5,187 match `shadowgraph-*`;
most are named with spaces rather than hyphens. The leak is in the suite's own
scratch handling, it is unfixed, and it is a finding in its own right.

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

The third attempt substituted a probe arm and required an identical rebuild.
That closed the `arm` field and nothing else: `namespace` and `correlation` were
still spread into both builds unchanged, and `correlation.armId` carries the
real arm id. Independent review branched on it and reproduced the original
bypass verbatim — 36 units of one named arm measured under a biased prompt, run
reporting COMPLETE. `namespace.userId` was a second, coarser channel worth 240
biased builds.

The fix is not a fourth detector. The builder is now handed `phase`, `scenario`
and `nativeContext` and nothing else, so no *field* identifying the arm reaches
it. The field list is exported as `OUTER_REQUEST_INPUT_FIELDS`, and the runner
builds its call-site object from that constant rather than restating it, so the
two cannot drift. The acceptance suite asserts the surface on every one of its
builder calls, with `arm`, `armId`, `namespace` and `correlation` each named so
a regression says which channel it reopened.

To be exact about where that holds: the assertion runs in the offline suite. In
a real run the enforcement is the derivation above, plus `buildV11Prompt`
refusing any input key it does not expect.

An earlier version of this paragraph continued "a builder that cannot tell the
arms apart cannot favour one". That was false. Two ways to tell them apart
survive the narrowing, and stating them plainly matters more than adding a fifth
detector.

**Call position.** A builder can count its own calls. The runner calls it a
fixed number of times per unit and the plan is ordered, so the call index yields
the unit and hence the arm. The request is built twice with identical arguments
and the two must match, which catches this only when the period is *not* aligned
to that stride — an aligned period is constant within each pair, every
comparison matches, and independent review used exactly that to deliver a biased
prompt to all 36 decision units of one named arm with the run reporting
COMPLETE. Varying the stride would relocate the arms race rather than end it, so
the answer is upstream: `executeV11AcceptanceRun` accepts no prompt builder but
`buildV11Prompt` itself, and a wrapper that merely forwards to it is refused.
The rebuild check stays, guarding the injected path the tests use.

That check holds at the **assembly layer**, and saying so matters. Review pointed
out that `runV11Benchmark` is exported and directly callable, and demonstrated a
valid 308-unit **scored** run driven with a hostile builder in one call to it —
no live path exists, since the CLI does not import the runner and its only
non-test caller sits behind the check, but the guarantee read as *the only
caller happens to be gated* rather than *the API cannot do this*. The mode half
now moves down: `runV11Benchmark` refuses `scored: true` outright, because this
candidate may not emit that mode at all and a constraint enforced by every
caller remembering to pass `false` is enforced by nothing. Builder identity
remains an assembly-layer property, and the sentence above says which layer.

**Context shape.** `nativeContext` is arm-correlated by construction — the
prompt depends on what the arm retrieved, and that dependence **is** the
measurement — so a builder can infer the arm from context shape. Review
demonstrated this too (168 biased sends across six arms) and advised against
closing it, which is right: removing it would remove the thing being measured.
It is recorded so nobody reads "prompt fairness" as stronger than it is.

The system instruction and response schema are separately pinned by the first
measured unit, and no prompt may name the arm it is running.

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

That field extended `schemaVersion: 2` **in place** rather than bumping it.
That was safe only because no raw run exists anywhere, so no artifact was ever
written under the older shape. From the first real run onward, any change to
the raw shape must bump the version. Recording it here turns a silent decision
into a stated one.

Each guard is mutation-tested against the full repository suite, not the v1.1
glob. The table is generated by `tools/mutation-table.sh`, which drives
`tools/mutate.cjs` to remove one guard at a time and records **which** tests
break, compared against `tools/expected-failures.json`. A missing expected
failure means the guard stopped being load-bearing; an unexpected extra is
treated as a flake and the cell is re-run once before the harness fails. Each
cell names its tests, so any reader can check one directly rather than trusting
a count.

It counted failures until independent review ran it twice at this commit and
got two different tables, a different cell wrong each time. A flake anywhere in
the suite is attributed to whichever guard happens to be mutated at that
moment, and the baseline/final checks cannot see it because the flake only
appears mid-table. The generator had removed transcription error and replaced
it with attribution error — the same class of mistake one level up. A count is
not a measurement when the population is flaky.

Two things the identity version has caught that a count could not. First, the
flake, on its first run: the `purity` cell picked up
`DS-P1-003 SQLite: a child writer begun before restore either completes first
or conflicts`, an unrelated concurrency test. Under the old harness that would
have been published as `Purity rebuild | 2`. It was named, re-run, and
resolved. **That test is genuinely flaky and is a finding in its own right** —
it is what corrupted two of the reviewer’s runs, it is unrelated to v1.1, and
it is recorded here rather than fixed because it sits outside this candidate.

Second, a guard whose reach genuinely grew. Making the end-to-end connection
test detect a collapsed plan — it had counted 308 units without checking any
were measured, and stayed green with every one of them FAILED — gave the
`narrowing` guard a second test. The harness refused to publish any table until
`tools/expected-failures.json` was edited to say so. That is the difference
between a widened guard and a flake, and a count cannot tell them apart: both
read as `Narrowing | 2`.

It lives under `tools/` rather than `scripts/` because `files` carries
`scripts/`, and a tool whose whole purpose is rewriting `benchmark/lib` in place
has no business in a distributable. Independent review found it shipping (112
files, now 110) and found its first version deleting its own backups on
interrupt without restoring — the safety net vanishing across roughly thirteen
of the run's fourteen minutes. Both are fixed; the restore-on-interrupt is
verified rather than asserted, by sending SIGINT mid-run and comparing digests.

A third harness defect, found by running it. One `npm test` inside it stalled
for over an hour at near-zero CPU with nothing on stdout, and the harness waited
with it. The cause was one test in `test/benchmark-provider-meter.test.js` that
started a provider meter and closed it only at the end of the test body, behind
eight assertions and eighteen concurrent requests. A meter holds a listening
socket and an open ledger descriptor, so any assertion that threw skipped the
close and kept the event loop alive forever: every test in the file reported,
and then the process sat there. The temporary-directory hook did run, unlinking
the ledger while the descriptor stayed open, which is why the stuck process was
found holding an open-but-deleted `concurrent.ndjson`.

It was the only one of five creation sites in that file with no immediate
cleanup hook. Counting sites understated it: `meterFor()` is one site but
fifteen tests call it, so the file starts nineteen meters per run and the first
version of this fix bounded three of them, while the paragraph describing it
said "every". Independent review found that. Starting a meter and registering
its shutdown are now the same call for every meter in the file but one.

That shutdown is bounded, because a hook that calls `close()` guarantees the
call and not the return. Be exact about what the bound buys. When it expires
the handle is still open, so the process still stalls; and Node reports only
the first error per test, so on the path this exists for - where the body
already threw - what survives is a warning rather than a second failure. It
makes the stall say why. It does not end it. The bound also warns rather than
rejecting, because a rejecting hook aborts every hook registered after it, and
one stuck close should not take the rest of the teardown with it.

The one meter that still owns its hook is the disconnect test, and not for the
reason first written here. There is no deadlock: that test closes its meter
within a second while the handler is still parked, and the file passes. The
reason is hook order. A tracked hook would be registered before any hook that
releases the handler, and hooks run in registration order, so on the failure
path it would run first and spend its whole budget before the release could
happen.

The attribution matters more than the leak. `serviceTag` was the mutation
mounted when the stall was noticed, and it is the tenth of eleven cells, so it
inherited the blame for a defect it has no path to: `node --test` runs each file
in its own process, nothing outside `test/benchmark-v11-locks.test.js` imports
`v11-locks.mjs`, and the mutation replaces one synchronous rejection with
another. Measured, it takes the same 84 seconds as every other cell. An
unbounded wait had reintroduced attribution error in the time dimension, which
is the same mistake this file exists to remove in the count dimension. Every run
is now bounded; a timeout is written as its own kind of row, never folded into a
mismatch, its log is kept, and the harness stops rather than spending the
remaining cells rediscovering the same thing.

And a defect in that fix, found by probing it rather than by reading it: the
first version printed `baseline: green` after a five-second timeout. The run had
been killed, the truncated log carried no failure lines, and absence of evidence
was read as health — the broad-claim/narrow-inspection shape recorded above,
inside the patch written to prevent it. A run with no test summary is now
unmeasured at the baseline, at every cell, and at the final check.

Adding that bound then silently broke something the paragraphs above claim.
GNU `timeout` puts the suite in its own process group, which is what lets it
kill npm's node children - and equally what removes them from the terminal's
foreground group, so Ctrl-C stopped reaching them. The restore-on-interrupt
verified before the timeout existed had quietly stopped working: the trap would
not run until the suite ended on its own, up to ten minutes later, and an
operator who escalated in that window would leave mutated source behind with
the only backup in an orphaned temporary directory. Independent review found
it. The harness now runs the suite as a job it can signal, kills that process
group itself, and restores. Re-verified the way the original was: SIGINT during
a mutated cell, harness gone in one second, all four mutable files
byte-identical, `git status` clean. The first attempt at that fix cleaned up
twice - once in the handler, once more through the EXIT trap - and printed
"could not restore" for files it had just restored successfully, so cleanup now
runs once.

Three smaller findings from the same review. The summary check matched `^.`
against a line the reporter prefixes with a three-byte character, so it held in
a UTF-8 locale and failed under `LC_ALL=C`, reporting a run that finished as one
that died; it now matches in both. The harness kept its own list of files to
back up, and that list had drifted to include `validate.mjs`, which no mutation
writes - it now asks `mutate.cjs` which files it can write, so the two cannot
disagree. And the run printed the tree state at the end without checking it, so
a surviving mutation was left for the reader to notice.

A confirmation pass over those fixes found that the check written to close that
last one had become the next instance of the same pattern, twice over. It ran
after the table was printed, so the one condition that invalidates every row
above could not reach the banner that says so: redirect stdout to a file and the
table came out clean and unmarked, with the problem only on stderr. And it
grepped `git status` for `benchmark/lib/` - a second remembered list, in the
same commit that had just stopped remembering the first. That would miss a
mutation to any file outside the directory, fail on unrelated dirt whose path
merely contained the string, and pass silently with no git at all. Every mutable
file is now compared against the copy taken before the run, before anything is
printed.

Three more from that pass. The bounded cleanup converted an expiry but not a
failure while the paragraph above it claimed the general property, and two tests
here register a meter hook that is not the last one, so a rejected close would
have skipped the next meter's. The guard that stopped cleanup running twice had
made it non-resumable: a second Ctrl-C during the restore re-entered the
handler, took the guard's early return, and exited with the tree still mutated -
the fix for one failure opening another. Interrupts are now ignored while the
handler works, verified on a two-file replica of this teardown by sending three
signals during a deliberately slowed restore and confirming both came back; the
real four-file restore was verified separately, on the harness itself, by one
interrupt mid-cell. And the reconciliation counted rows where
its own comment promised membership; it now names the guards that produced
none.

A third pass found the pattern again, in both of those fixes. The comparison of
each mutable file against its pre-run copy is exact, but narrower than the check
it replaced: a suite writing to any other file under `benchmark/lib` walked past
it, and the tree listing was once more printed without being checked. It is now
compared against the listing taken before the run - the first version of this
check that is a superset of the earlier ones rather than a different narrow one.

The worse half was the restore on the exit path. It ran after that comparison had
already established byte-identity, and `cp` truncates before it writes, so the
only thing that pass could ever change was a file that was already correct - and
it ran too late for its own error status to reach the exit code. Review executed
it: four guard sources truncated to zero bytes, an eleven-row table published
with no banner, exit 0, and the backups deleted a line later. Restore now copies
only what differs, so the ordinary path writes nothing at all, and a failed
restore keeps the backups and exits non-zero.

Three smaller ones from the same pass. The bounded cleanup took its argument as a
promise, so the call was evaluated outside the try meant to guard it and a
synchronous throw still aborted the later hooks; it takes a thunk now. The
backups shared a flat directory with the harness's own working files, where a
future key collision would have been invisible to a check that reads the same key
it wrote. And a guard whose cell times out does appear in the table, so reporting
that it "produced no row" contradicted the rows above it - it now says no
measurement.

A fourth pass signed the work off and named the thing worth fixing anyway: **an
empty result read as a healthy result** had by then appeared four times in this
one file. A truncated log read as a green baseline. A missing summary read as no
failures. Git unavailable read as a clean tree. Git failing mid-run read as an
unchanged tree - the last of those inside the check written to close the second.
Each had been fixed as an instance. This pass treats the class: `mktemp`, both
`git status` calls, the declaration read, and the final run's timeout are all
checked, and none of them may report success by returning nothing. Verified by
running the harness with a git that fails: it exits 1 having printed **no table
at all**, rather than an unmarked one.

The same pass found the final run alone did not distinguish a timeout from a
dead run, so a hung suite was reported as one that produced no summary - failing
closed, but with the wrong diagnosis, which this harness elsewhere calls its own
kind of wrong answer. It now checks both, as the baseline and every cell already
did.

What the reviewer declined to call a defect is worth recording too. The residual
findings are all second layers failing while the primary layer holds: the byte
comparison over the mutable files needs no git, covers every file any mutation
can write, and runs before anything is printed. None of them can put a wrong
number in a published cell.

A scoped pass over that class fix then found two members of the class still
open, in the commit whose message said it closed the class - which is the
broader-claim-than-code shape one more time, and worth writing down rather than
quietly patching. The list of mutable files was read through a process
substitution, which discards the producer's exit status, so a *partial* list
would have passed the count guard: the harness would then have backed up,
restored and byte-checked only the files it had heard about, while `mutate.cjs`
could still write the ones it had not. Verified by making the producer emit two
of four paths and exit non-zero - previously accepted, now refused with no table
and the sources untouched. The reconciliation discarded `comm`'s status the same
way, where a failure would have read as "nothing missing". Both are checked now.
That is narrower than it first read here: the `comm` fix concerns declared
against measured *guards*, not file coverage, and only the producer check bears
on the sentence above - which it makes no longer defeatable by a failing
producer, rather than simply true.

A final pass then found three more members, two by execution, including the
first instance the header of `tools/mutation-table.sh` names. The extractor that
pulls failing test names out of a log is a pipeline, so its status was the status
of `sort` alone: a failing `sed` yielded an empty file, and an empty file of
failing test names is exactly what a green run looks like. The harness printed
`baseline: green` and published a table. It now returns the whole pipeline's
status, and every one of its three call sites is checked. Verified by making
`sed` fail: no table, no `green`, exit 1 - where before it was a published,
unbannered table. The sorts feeding the reconciliation were unchecked the same
way, one of them added by the commit that claimed to close the class.

One member stays open by design, and is recorded rather than fixed. A producer
that emits a *partial* file list and exits zero is indistinguishable from an
honest short list, because avoiding a second remembered list to check it against
was the point. It is still caught - by the whole-tree comparison, not the byte
check - but the harness exits with those unlisted files still mutated, since
restore only walks the list it was given. The exit is non-zero and the table
carries its banner, so nothing false is published; the tree needs `git checkout`
by hand.

It exists because three consecutive review rounds each caught one wrong number
in a hand-written table. The last was a purity-rebuild figure of 3 that should
have been 1: that mutation removed the rebuild *call* as well as the comparison,
so it also tripped two assertions that count builder invocations. Both
measurements were correct about what they actually mutated, which is exactly the
confusion generating the table removes.

| Guard removed | Tests that fail |
| --- | --- |
| Narrowing | 2 — the prompt builder is never told which arm it is serving; a ready candidate runs the plan and reaches the validator and the aggregator |
| Purity | 1 — a builder whose output depends on anything but its input fails the unit |
| Arm Identity | 1 — a prompt that names an arm fails the units of that arm |
| Resume Seed | 1 — a resumed attempt cannot adopt a different outer instruction |
| Index Rebuild | 3 — a hand-made index is revalidated, not trusted for its schema tag; required coverage is checked against validated kinds, not claimed ones; byte-identity holds for a hand-made index too, not only a built one |
| Required Digest | 1 — verification refuses to run without the digest it is meant to check |
| Canonical | 1 — a real run may use only the frozen prompt builder |
| Scored Refusal | 1 — the runner itself refuses a scored run, not merely the layer above it |
| Env Type | 1 — a placeholder in a numeric field is not an observation |
| Service Tag | 2 — a service pinned by tag is not pinned; a service image and its recorded digest cannot disagree |
| Model Digest | 1 — a short model identifier cannot pin weights — this is blocker B1 in code |
| Placeholder | 3 — a placeholder in a description field is not an observation; a service or model named by a placeholder is not identified; a placeholder cannot stand in for public model or service metadata |

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

`verifyReviewBundle` used to treat `expectedDigest` as optional and reported
`verified: true` for a bundle whose commit had been swapped — the precise failure
a function of that name exists to prevent. It is now required.

One known gap, deliberately left open: the path check accepts `C:/x` and
`a/./b` as repository-relative. These are index labels that are never resolved
against a filesystem, so the value of tightening them is low; independent review
agreed. It is recorded here rather than fixed so that nobody has to rediscover
it.

**The environment, service and model lock builders now exist.** Requirement 8
names four locks; only the implementation lock had one. I had been describing
this section as "builders done, artifacts blocked", which was true of the
evidence index and the review bundle and false of three of the four locks.
`benchmark/lib/v11-locks.mjs` closes that.

Each refuses incomplete evidence rather than recording a placeholder, and the
refusal is the point — a lock exists so a reader can tell whether two runs are
comparable, and one built from whatever was available answers that wrongly while
looking authoritative.

- **Environment.** All ten fields required; empty strings and non-positive
  numbers are missing evidence, not evidence; an observation the lock does not
  record is refused rather than dropped, because silently ignoring one would let
  a caller believe something was pinned that the lock never carried.
- **Service.** A tag is not a pin. `neo4j:5.20` names whatever that tag points
  at today and would silently become a different service tomorrow, which is the
  thing a lock exists to prevent.
- **Model.** Refuses anything but a full `sha256:` weights digest. **This is
  blocker B1 expressed as code rather than as a sentence in this document.**
  `MISSING-EVIDENCE.md` records that only short Ollama identifiers were
  captured; a short id cannot distinguish two weight sets a registry labelled
  the same way. Passing one is exactly what this candidate could do today, and
  the builder refuses it.

Trying to *produce* the requirement 8 artifacts, rather than reasoning about
them, found a defect in the environment lock. The typed-field guard closed one
half of the placeholder problem: a count may not be prose. The description half
stayed open, under a comment asserting the opposite - *"the only thing standing
between a real observation and 'unknown' typed into the same slot"* - while the
code rejected only empty strings and numbers. An environment lock with **every**
description field set to `unknown`, `N/A`, `TODO` or `not captured` was accepted
and returned a digest that reads as authoritative, which is precisely what this
module's header says it exists to refuse. It now refuses the spellings that mean
"we did not look", while still accepting a real version string that merely
contains such a word - it refuses the value, not the substring.

Two corrections from the review of that fix, because the first version was the
review example rather than the defect. The identifier check one function away
still took any non-empty string, so a service lock naming `unknown` and a model
lock with `modelId: "N/A"` both built and digested; all three builders now share
the predicate. And the denylist missed the spellings people actually type -
`undefined` above all, which is what a collector emits for a property it never
read, plus `NaN`, `N / A`, `N.A.`, `???` and `---`. Spacing and punctuation are
folded before comparison.

This is a denylist and cannot be complete, which is worth stating plainly rather
than implying otherwise: a version string is not checkable, so anything unlisted
is taken at face value. It closes the spellings that mean nothing was observed,
not every possible one.

Review of that commit found the class open in a fourth place and the guard wrong
in two others, and caught a false claim in the commit message itself.

**The fourth lock.** Requirement 8 names four locks. The v1.1 three refused a
placeholder while `implementation-lock.mjs`, which governs the source tree,
still took `unknown` for a model architecture or a service name - the same
"fixed here, open next door" shape, one module away from where the last one was
found. The predicate now lives in `benchmark/lib/placeholder.mjs` and all four
import it, because two copies that can disagree about what counts as evidence is
the defect it exists to prevent.

**Over-breadth, which the previous commit message said was written down and was
not.** It claimed the caveats were recorded here; they were not, and a grep for
`cpuModel` would have shown that. They are now. A guard that refuses a real
observation is worse than the hole it closes, so:

- `none` has been **removed** from the list. `benchmark/competitors.lock.json`
  records `"version": "none"` for the no-memory control arm - a true answer,
  committed, and this repository's own convention. A machine with no container
  runtime is in the same position. Where a token is genuinely ambiguous between
  "absent" and "we did not look", it is left out.
- `cpuModel` can legitimately be the literal `unknown` on hosts where libuv
  finds no model-name line in `/proc/cpuinfo`, which is common on aarch64. That
  value is still refused. The refusal is arguably correct - a lock claiming to
  pin an unrecordable CPU model would answer the comparability question wrongly
  - but it is a real observation being refused, it is loud, and it is written
  here rather than left to be rediscovered.

**An asymmetry in the folding.** The trailing-period strip ran before the
punctuation-run collapse, so `...` reduced to the empty string and was accepted
while `---` and `???` were refused, and the `.` entry in the list was
unreachable. The strip now uses a lookbehind so it cannot consume a string that
is entirely punctuation.

The guard is measured across all four builders, and its declared set has grown
to three tests, which the harness refused to publish until the declaration said
so.

The other three artifacts refuse, and the refusals are mechanical rather than
declarative. Attempted here with the best evidence that exists:

| Artifact | Outcome |
| --- | --- |
| Environment lock | **produced** from real observations of this machine |
| Service lock | `EMPTY_SERVICE_LOCK` — nothing is provisioned to pin |
| Model lock | `UNPINNED_MODEL` — a short Ollama id cannot identify weights (B1) |
| Implementation lock | refused — it reconciles against a committed `benchmark/service-images.json`, which does not exist, and requires a full weights digest for every model kind |
| Review bundle | `INVALID_DIGEST` — it requires an implementation lock hash that cannot exist |

So requirement 8 is blocked structurally, not for want of effort: the review
bundle depends on the implementation lock, which depends on B1 and B2. Producing
any of them would mean inventing a digest, which is the one thing this work may
not do.

Verification requires the digest it is checking against, for the same reason the
review bundle does.

Lock and bundle **artifacts** remain ungenerated, for three different reasons
and one choice — and the distinction matters, because an earlier version of this
paragraph flattened them into "the builders would refuse the inputs available
today", which is false of the fourth.

- **Implementation lock** — `implementation-lock.mjs` requires a fully clean
  tree, untracked files included, and an immutable HEAD.
- **Model lock** — refuses the short Ollama identifiers that are all this
  candidate holds (B1). Enforced, not merely stated.
- **Service lock** — `benchmark/service-images.json` cannot be authored without
  real image digests (B2).
- **Environment lock** — *could* be built today. Independent review built a
  valid one from a real machine in this workspace. It is ungenerated by choice,
  not by blocker: an environment lock pinned to a machine while the run it would
  govern cannot happen describes nothing. Naming it here rather than letting it
  hide inside a blanket claim is the same correction this section already makes
  once.

`v11-preflight` reports all three immutable prerequisites as unmet.

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
