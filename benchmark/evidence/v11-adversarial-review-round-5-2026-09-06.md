# ShadowGraph v1.1: A Fabricated Finding, Found in My Own Record

- **Date:** 2026-09-06
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Under review:** `git diff f465fff..3790797` — the commit that asserted the composition
- **Official run status:** **NOT STARTED**

## Decision

41 findings, three skeptics each, **34 survived**. One of them is not about the
code at all.

> F19 states "Round three fixed `--verify only` reading the recorded manifest
> instead of rewriting it… It did not override `importProbes`." At `f465fff` —
> the commit round four reviewed — `benchmark/cli.mjs:881` already reads
> `manifest = { ...manifest, distributions, importProbes };`. The sentence is
> round three's own F14 with "The round-2 fix" changed to "Round three".

I checked it against git rather than against the record, and the reviewer is
right:

```
$ git show f465fff:benchmark/cli.mjs | grep -n importProbes
821:  const importProbes = [];
842:    importProbes.push({
881:    manifest = { ...manifest, distributions, importProbes };
890:      importProbes
903:    importProbes,
```

At `d61c8c1` — the commit round *three* reviewed — line 881 does not exist. The
override was added by the fix round four was reviewing, and round four reported
it as still missing, reusing round three's demonstration (`site/graphiti_core`
renamed, `.dist-info` intact, exit 0 with `graphiti FAIL observed=None`) as if it
had been run again.

This is the failure mode this benchmark exists to refuse, committed in the
document that certifies the refusal. Nothing in the code was wrong; the evidence
was. Three skeptics passed it because each of them argued about whether the
*defect* was real, and none ran `git show`.

**F19 is rewritten** to say what was true at `f465fff`: the rule was correct and
sat inline in `v11PythonRuntimeCommand`, a function no test enters, so
`if (options.verify === 'only')` could be reverted to `if (false)` with the whole
suite green. Correct, and unreachable. `3790797` extracted it into
`pythonRuntimeManifest`, which is what made it testable. The commit message of
`3790797` carries the same error and cannot be edited; this record and the
corrected F19 are the correction.

**The standing rule this adds:** a finding that names a prior commit is checked
against that commit before it is written down, not against the record of it.

## F21 — Recording doubles that discarded what they recorded

Round four asserted the composition argument by argument, and said so. Four of
those arguments were still unpinned, because the fixture or the double could not
tell a right answer from a wrong one:

| What | Why it could not fail |
| --- | --- |
| `image: competitorLock.pythonImage` | the fixture gave the manifest and the lock the *same* image string, so pointing the check at `runtimeManifest.image` — self-comparing, the exact shape of the wheel-lock hash defect beside it — passed |
| `readPythonSiteDistributions(pythonRuntimeSite)` | the double took no arguments; passing it `pythonStateRoot` passed |
| the meter's `listenerUrl` | never read; `0.0.0.0` passed |
| `bindEndpoint(correlation)` | the double used only `correlation.requestClass`, so the one wire between a metered arm and the meter was asserted by a URL suffix; passing `{ requestClass }` alone passed |

**Fixed.** `MANIFEST_IMAGE` is a distinct digest from `IMAGE`, and the test
asserts both `verified[0].image === IMAGE` and
`notEqual(verified[0].image, MANIFEST.image)`. The site reader and the meter
record their arguments. All four mutations above now fail, along with the two
this round added coverage for — the two state roots created in the wrong order,
and a prompt builder that is a wrapper rather than `buildV11Prompt` itself.

## F22 — A distribution with no version took the whole listing down

`LIST_DISTRIBUTIONS_SCRIPT` — the script F18 moved out of the CLI so
`DISTRIBUTION_DUPLICATED` could fire from the command that builds manifests —
ended with:

```python
found.sort(key=lambda entry: (entry["name"], entry["version"]))
```

`distribution.version` is `None` when a `.dist-info` carries no `Version:`
header. Sorting `None` against a string is a `TypeError`, so the command exits
non-zero with no listing at all — on a site whose duplicate the sort was added to
expose.

**Fixed.** A name with no version pins nothing, which is already
`readPythonSiteDistributions`'s rule, so the script now applies the same one and
drops it. The test builds a site with an unversioned `.dist-info` beside
`httpx` at two versions and asserts the duplicate is still reported.

## F23 — The clamp that no test had ever seen move

`matchedCalls` totals `Math.min(matched.length, entry.expectedCalls)`. Every test
that asserted both totals asserted them equal, so the `Math.min` was pinned by
nothing: removing it, a run that retried would report `matchedCalls` above
`expectedCalls` — a summary saying the run made more of the calls it claimed than
it claimed to make, beside a `RETRY_OBSERVED` finding saying otherwise.

**Fixed.** One test drives both directions: two events against one expected call
(`matchedCalls` 1, `observedEvents` 2, `RETRY_OBSERVED` raised) and no events
against two expected (`matchedCalls` 0). Deleting the clamp now fails it.

## An assertion of my own that had to come out

Round four added a permitting-direction assertion to `RawSocketFenceTests` that
went one call too far: after `handle.connect(("127.0.0.1", 9))` it asserted
`handle.send(...) == 17`. On a connected datagram socket aimed at an unlistened
port, the kernel queues the ICMP port-unreachable from one datagram and delivers
it to the *next* call. Reproduced here, a repeated send alternates:

```
send 1 -> 17
send 2 -> ConnectionRefusedError (ECONNREFUSED)
send 3 -> 17
send 4 -> ConnectionRefusedError (ECONNREFUSED)
```

The test had already sent three datagrams to port 9 by that line, so whether the
assertion held depended on what was queued at that instant. `send` also carries
no address, so the fence does not guard it and it was never the property under
test. The `connect` assertion stays; the `send` is removed, with the mechanism
recorded beside it.

## The documents

| Passage | What was wrong | Now |
| --- | --- | --- |
| requirement 6's refusal table, `CANDIDATE-STATUS.md` | Cognee's two columns were those of an arm with **no** native user scope. `test_unprovisioned_runtimes.py` lists `cognee` with `has_native_user_namespace=True`, which makes `user-1` its native shape and `None` its foreign one | the columns match the test, and the paragraph says why Mem0 and Cognee share a shape that Graphiti does not |
| the same section's prose | "Cognee will not run against unpinned access control" — true before CB2 demonstrated the ACL | rewritten, with the inversion noted rather than quietly repaired |
| `benchmark/evidence/README.md` | "**Status: proposed, not adopted**… Until an amendment 003 is reviewed and accepted, the acceptance definition continues to carry the A002 counts" | amendment 003 carries `AUTHORIZED_FOR_NON_SCORED_V1_1_ACCEPTANCE`, `authorizedAt: 2026-09-04`, and `definition.json` carries 20 / 288 / 260. The original paragraph is kept for sequence; the false sentence is gone |
| the same file's probe quote | attributed *"Cognee user ACL is not locked for benchmark execution"* to `cognee_adapter.py`, which now resolves `namespace.userId` through `client.user_for(...)` | marked as the text at probe time, with what replaced it |
| round three's `_socket` deletion count | said "fails 3", then "fails 2 and errors a third". Both were written, neither was run | measured, one deletion at a time and restored between: the five module-level `_socket.*` entries → 2 failures and 2 errors; unbinding `GuardedRawSocket` → 2 failures; all nine → 6 tests |
| round four's fence row | called all three refusing-only guards `_socket` ones | two are; `socket.socket.sendmsg` is the third, per the diff of `test_python_host.py` across that commit |
| round four's opening | "Every constructor in the new test was a bare stub that recorded nothing" | two did record — `verifyPythonRuntime` its whole input, `createProviderMeter` its whole config |
| `benchmark/cli.mjs` | the run summary's `pythonRuntime` key was written twice, with its comment | once |

## Refuted, and worth naming

**"The build-manifest refusal test exercises one of `pythonRuntimeManifest`'s
three conditions."** It exercises all three: `/requires the manifest the build
wrote/`, `/records the image/`, and `/distributions and import probes/` three
ways. The claim did not survive checking.

## What this does not claim

- **No run was executed. No artifact exists.**
- **Bind-time verification trusts the recorded import probes.** `bindV11Runtime`
  re-reads the site's distributions but takes `importProbes` from the manifest,
  because running a probe needs a container the bind path does not start. A build
  that recorded a failing probe is refused; a site that *degraded after* its build
  is not — F14's own case passes bind time. `v11-python-runtime --verify only` is
  what catches it, and it has to be run separately.
- **`v11PythonRuntimeCommand` is still entered by no test**, unchanged from round
  four.
- **The binding test asserts the composition, not the constructors**, unchanged
  from round four.
- **The fence is an enumeration with named gaps**, unchanged since round two.
- **Seven findings were refuted** and are not here, beyond the one named above.
- **F2 and LB2f are untouched** and remain owner decisions.

## Reproduce

```
npm test                      # 2363 / 2363, 0 fail
npm run benchmark:test        # 1127 JS, then 139 Python
npm run benchmark:check
node benchmark/cli.mjs v11-preflight
```
