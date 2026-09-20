# ShadowGraph v1.1: Reachable Is Not Asserted

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Under review:** `git diff d61c8c1..f465fff` — the commit that moved the run path out of the CLI
- **Official run status:** **NOT STARTED**

## Decision

40 findings, three skeptics each, **33 survived**.

Round three's diagnosis was right and its fix was half of one. Moving the
composition into `benchmark/lib/v11-runtime-binding.mjs` made the run path
*reachable*; it did not make it *asserted*. Two of the doubles in the new test did
record — `verifyPythonRuntime` pushed its whole input and `createProviderMeter`
its whole config — and the rest recorded a fixed string or nothing at all, so most
of the argument wiring, which is the only thing that function does, was still
unchecked. A reviewer changed one token at a time and ran the suite:

| One token, in `bindV11Runtime` | Suite |
| --- | --- |
| `runtimeRoot: pythonRuntimeSite` → `stateRoot` (the arms mount the node state directory) | green |
| the two state roots swapped between host families | green |
| `createV11NodeHosts` deleted entirely | green |
| `wheelsLockSha256: createHash(...)` → `runtimeManifest.wheelsLockSha256` (self-comparing) | green |
| the outer model, seeds, temperature, token cap and timeout | green |
| the implementation and environment lock hashes swapped | green |

The last is worth stating twice: the two hashes a run record carries to say *what
configuration was measured* could be swapped, and 2357 tests passed.

**Fixed by asserting the composition, argument by argument.** Every double in
`test/benchmark-v11-runtime-binding.test.js` now records its whole input, and one
test walks it: the lock's inputs, the environment observation, both host
families' state roots, the site the arms mount, the executor's registry and host
map, the outer transport's five frozen parameters and its meter, the meter's
deadline, both ledgers' paths and identities, the progress ledger's stall
deadline, and both lock hashes — with distinct fixture values so a swap is
visible. All six mis-wirings above now fail.

## F18 — The duplicate check could not fire where manifests are made

F15 taught `verifyPythonRuntime` to report two versions of one distribution
rather than collapse them. But the `distributions` array it judges comes from
`LIST_DISTRIBUTIONS_SCRIPT`, run inside the container, and that script built a
dictionary keyed by name — `found[name] = distribution.version`, last-discover-
wins. So the collapse F15 named as the defect still stood one layer earlier, on
the only path that produces a manifest, and `DISTRIBUTION_DUPLICATED` could never
fire from it.

Confirmed in the pinned image against a site holding both `httpx-0.27.2.dist-info`
and `httpx-0.28.1.dist-info`: the script returned one entry.

**Fixed.** The script appends to a list and sorts, and it moved to
`v11-python-runtime.mjs` so a test can run it. Against the same two-version site
it now returns both, and the test runs the real script through `python3` (and
skips where there is none) rather than reading its source.

## F19 — the rule `--verify only` follows was correct and unreachable

**This section was wrong in the commit that first published it, and the
correction is now the finding.** As published it said round three's fix "did not
override `importProbes`", and told the story of a reviewer renaming
`site/graphiti_core` to get `valid: true` out of a command that printed
`graphiti FAIL observed=None` in the same object. That experiment is real, but
it is round *three's* — its own F14, run against `d61c8c1`. At `f465fff`, the
commit this review actually covers, `benchmark/cli.mjs:881` already read:

```js
manifest = { ...manifest, distributions, importProbes };
```

The override was there. Restating a fixed defect as a fresh one, against the
commit that fixed it, is the overstatement this benchmark treats as a defect in
its own right — and it reached a published record because no one checked the
claim against the tree, myself included.

What *was* true at `f465fff` is narrower, and worth its own line: the rule lived
inline in `v11PythonRuntimeCommand`, a function no test enters, so
`if (options.verify === 'only')` could be reverted to `if (false)` with the whole
suite green. Correct, and unreachable — the same shape as everything round three
had just moved out of the CLI, in the one place round three left behind.

**Fixed by extracting it.** `pythonRuntimeManifest` states the rule once — what
the site can be asked now is measured now; only what it cannot be asked, the
image it was built against and the wheel lock it was built from, comes from the
record — and it is exported and tested, all three of its refusals included.

## The tests that could not fail

| Test | What it was satisfied by | Now |
| --- | --- | --- |
| "read past a byte-order mark and CRLF line endings" | the mark sat before `Metadata-Version:`, a line the parser skips, and the `\r` was already removed by the value's `.trim()` — both new guards could be deleted | the mark sits before `Name:`, and a CRLF description begins with a line that looks like a header, so the scan must stop at the blank line |
| three guards: `_socket.socket.sendmsg`, `_socket.socket.connect`, `socket.socket.sendmsg` | only the refusing direction — making them refuse *everything*, loopback included, was invisible. (This row first called all three `_socket` guards. Two are; the third belongs to the `socket` family, per the diff of `test_python_host.py` across this commit.) | both directions, on every one |
| the two totals the reconciler change touched | `expectedCalls` and `matchedCalls` were the two the diff altered and the two the test skipped | asserted |
| "the image still comes from the competitor lock" | the fixture made both sources equal | distinct fixtures throughout |

## The documents

Six more passages in `CANDIDATE-STATUS.md`, all describing the tree before
Amendment 003 or before the run path existed — and all in sections two earlier
reviews had edited without reaching:

- requirement 7 still quoted the Amendment 002 counts (**16 / 292 / 264**) and
  said each was "cross-checked against the literal in the test". The test asserts
  20 / 288 / 260;
- it explained the stub registry by two reasons that are both false now, and
  closed by saying "B1 alone still prevents a real acceptance run" — B1 being a
  blocker the same document files under *historical*;
- requirement 6 still said the frozen matrix declares Graphiti's user isolation
  `SUPPORTED`;
- requirement 8 named a superseded record as "the authoritative current split"
  and a blocker count preflight no longer emits.

Plus the round-3 record's own `_socket` deletion count, and the `runtime` record
`bindV11Runtime` returns — documented as existing for a caller and a test, and
read by neither. It is reported in the run's summary now, which is where it
belongs: neither lock can name the site the arms imported.

## What this does not claim

- **No run was executed. No artifact exists.**
- **`v11PythonRuntimeCommand` is still entered by no test.** Its decisions moved
  out — `pythonRuntimeManifest` and `LIST_DISTRIBUTIONS_SCRIPT` are exported and
  tested — but the command that sequences them is not.
- **The binding test asserts the composition, not the constructors.** The doubles
  record; they do not enforce what the real ones refuse. A composition that is
  correctly *wired* to a constructor that would reject it still passes here.
- **Bind-time verification re-reads the distributions and trusts the recorded
  import probes.** `bindV11Runtime` hands `verifyPythonRuntime` a manifest whose
  `distributions` come from the site the arms will mount, but whose
  `importProbes` come from the record — running a probe needs a container the
  bind path does not start. So a build that recorded a failing probe is refused
  (`IMPORT_PROBE_FAILED`), and a site that *degraded after* its build is not:
  F14's own case, `site/graphiti_core` renamed with its `.dist-info` intact,
  passes bind time. `v11-python-runtime --verify only` is the command that
  catches it, and it has to be run separately.
- **Seven findings were refuted** and are not here.
- **F2 and LB2f are untouched.**

## Reproduce

```
npm test                      # 2361 / 2361, 0 fail
npm run benchmark:test        # 1125 JS, then 139 Python
npm run benchmark:check
node benchmark/cli.mjs v11-preflight
```
