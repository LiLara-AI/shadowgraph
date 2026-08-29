# ShadowGraph — Verified Handover for the Next Session

**Written:** 2026-08-29 by the first independent Claude reviewer
**Companion document:** [`claude-release-readiness-review.md`](claude-release-readiness-review.md) — full evidence
**Verdict carried forward:** **NOT READY FOR PUBLIC BETA**

This document states only what was independently verified in this session, and
labels everything else. Treat every unlabelled claim in *older* handover documents
as unverified until you re-derive it.

---

## 1. Where things actually stand

| Item | State | Confidence |
| --- | --- | --- |
| Repo root | `C:\Users\aelkh\AI Projects\test deepseek` | verified |
| Remote | `https://github.com/LiLara-AI/shadowgraph.git` | verified |
| `main` | `96a34c6`, identical to `origin/main` (0 ahead / 0 behind) | verified |
| **CI on `main`** | **RED** — run 33201202487 failed 5 of 6 matrix jobs | verified via `gh` |
| **CI on fix branch** | **6 of 6 green** for every commit from `6b0dbbd` onward | verified via `gh` |
| Green six-job runs | **3 named** — 33245087040 att.1 + att.2 (`6b0dbbd`), 33245578769 (`feb277e`); later documentation-only pushes each add another, all green | verified via `gh` |
| Fix branch | `claude/final-beta-readiness` — **5 commits** ahead of `main`, pushed, PR open, **not merged** | verified |
| Last code-bearing commit | `6b0dbbd`. Everything after it is documentation-only | verified |
| Local suite on fix branch | 1204 tests / 1204 pass / 0 fail / 0 skipped / 0 todo | verified (Windows, Node 24) |
| CI suite on fix branch | 1204 tests, 0 fail on all six jobs; every gate ran | verified per step |
| Version / schema | `0.40.0` / entity schema **5**, journal schema **5** | verified in code |
| Publication state | `"private": true` — correct, keep it | verified |
| Comparative benchmark | **NOT MEASURED** — 0 of 7 arms | verified in artifacts |
| Independent security review | **not performed** | verified (gate still open) |

## 2. The single most important thing to know

**Local green is not CI green for this repository.**

The previous session ran the full gate chain on Windows + Node 24, saw everything
pass, and handed over as if the suite were green. `main` had already been red on
GitHub Actions for two consecutive pushes. A Windows/Node 24 run structurally
cannot observe either failure mode:

- the Linux failure depends on `os.tmpdir()` being `/tmp`;
- the other failure only occurs on Node 20.

**Before reporting any suite as green, run `gh run list --branch <branch> --limit 5`.**

## 3. What is on the fix branch

`claude/final-beta-readiness` — **5 commits** ahead of `main`. Only two carry code:
`77d8206` (the three fixes) and `6b0dbbd` (the Node 20 fix). `550b118`, `feb277e` and
the consistency pass are documentation-only, so **`6b0dbbd` is the last commit that
can change behaviour**. Three defects fixed, each with a regression test.

> This file deliberately does not name its own HEAD SHA: a document that records the
> commit it ships in is stale the moment it is committed, which is how the earlier
> "three commits / head `6b0dbbd`" mismatch happened. The authoritative HEAD and
> commit count are on the pull request.
No existing assertion was weakened; the one assertion that changed (Node 20) was
made *truthful* about what ShadowGraph owns versus what npm owns, and still fails
on any unexpected error.

| ID | Defect | File | Status |
| --- | --- | --- | --- |
| CI-1 | `runtime-local-root` used a bare `includes()`, so on Linux (`tmpdir()` = `/tmp`) the packed source of this project's own `posixTempPathPattern` was reported as a leaked local path. Failed **all three Linux jobs**. | `test/followup-public-artifacts.test.js` | **FIXED — confirmed by CI.** ubuntu Node 20/22/24 all pass this test now |
| CI-2 | `runNpm()` replaced npm's real error with a bare "npm pack command failed", so the Node 20 failure reached CI undiagnosable. | `scripts/check-package.mjs`, `test/check-package.test.js` | **FIXED — confirmed by CI.** The new diagnostic named it: `npm error URI malformed`. npm 10.8 (Node 20) cannot turn a package directory containing `%` into a `file:` spec; npm 10.9+ can — an upstream npm bug. The test now asserts the shell-free and no-disclosure invariants unconditionally and branches on npm's capability |
| CI-3 | The destination fence treated only `EEXIST` as contention. Windows delete-pending files answer `open` with `EPERM`/`EACCES`, so a writer arriving during lock release failed hard instead of waiting. Failed `windows / Node 24`. | `src/revision-store.js` | **FIXED — confirmed across three green runs**, so not a lucky pass |

## 4. Your next action, in order

The CI blocker is **solved but not landed**. `claude/final-beta-readiness` is green
on all six matrix jobs for every commit from the final code state `6b0dbbd` onward —
three six-job runs green in total. `main` is still red at `96a34c6` because nothing
has been merged. A pull request is open.

1. **Merge the open pull request — this needs the user's explicit approval.** The PR
   is already created (base `main`, head `claude/final-beta-readiness`). Do not merge
   without explicit approval.

2. **After merging, confirm `main` itself goes green** — a merge commit is a new
   tree and gets its own run:

   ```bash
   gh run list --branch main --limit 3
   ```

   Do not report the release gate as closed until `main` is green.

3. **Then the remaining gates are not engineering work** (§6): an independent
   security review by someone outside this build, the seven-arm preregistered
   comparative benchmark (needs a common LLM + embedding endpoint), and maintainer
   sign-off plus explicit publication authorization.

4. **Optional P2 cleanup** is listed in the companion review §17 — most usefully,
   correcting `docs/handoffs/current-status.md`, which is wrong in five places (§7).

## 5. What NOT to do

- **Do not** publish to npm, create a tag, or create a GitHub release. Not
  authorized, and three release gates are still open.
- **Do not** flip `"private": false`. It correctly guards the unfinished gates.
- **Do not** weaken a test to turn CI green. Two of the three defects looked like
  "just a test problem" and one of them (CI-3) was a real Windows robustness gap in
  `src/revision-store.js`.
- **Do not** implement tasks merely because an old planning document lists them —
  several describe work that is already done (see §7).
- **Do not** trust `docs/handoffs/current-status.md` (§7).
- **Do not** modify `C:\Users\aelkh\AI Projects\ShadowGraph`; it is a read-only
  stale snapshot pending your decision.

## 6. Gates: verified vs open

**Verified in this session** (exact outputs in the companion document §8):
`npm ci` · `npm run check` · `npm test` · `npm run benchmark:test` (49/49) ·
`npm run check:mcp` (27 full / 12 compact, 0 errors) · `npm run check:integrations` ·
`npm run check:package` (60 files) · `npm run smoke:package` ·
`npm audit --omit=dev` (0 vulnerabilities, zero dependencies) ·
`npm pack --dry-run --json` (60 entries) · `node scripts/assert-sqlite-coverage.mjs`
(37/37) · `python -m py_compile integrations/hermes-agent.py` · `git diff --check`.

Also independently verified end-to-end against the **installed tarball** in a path
containing spaces: setup, doctor, scoped memory, decisions with alternatives and
rejection reasons, facts with evidence, failed attempts, restart recall, changed-fact
reconsideration **from stored state alone**, confidence and provenance, project and
scope isolation, backup → mutate → restore (JSON at file level, SQLite at database
level), purge preview, logical purge (journal redacted in place), hard purge (entry
removed, gap **declared**, graph still `valid`), and a three-process MCP lifecycle in
**both** full and compact modes.

**Still open — these are the release blockers:**

| Gate | Owner | Status |
| --- | --- | --- |
| CI matrix green (Linux + Windows, Node 20/22/24) | — | **CLOSED on the fix branch** — 6/6, 3 green runs from `6b0dbbd` onward. Still red on `main` until merged |
| Independent security review | external reviewer | **P1** — cannot be satisfied by Claude self-review or `npm audit` |
| Preregistered comparative benchmark, 7 arms | needs a common LLM + embedding endpoint | **P1** — currently 0 measured |
| Maintainer sign-off + publication authorization | you | **P1** |

## 7. Documents you must not trust as-is

`docs/handoffs/current-status.md` is the primary status document and is **wrong in
five places**. Corrections (all P2, none blocking):

| Says | Actually |
| --- | --- |
| Schema **4** | **5** (`src/shadowgraph.js:20`, `src/journal.js:11`) |
| 372 tests / 367 pass / **5 todo** | 1204 / 1204 / **0 todo** |
| `check:package` 62 files | 60 |
| MCP `2024-11-05` only, "no newer support claimed" | dual-era; modern `2026-07-28` implemented (`src/mcp.js:70-71`) |
| "`main` with an uncommitted review tree" | tree is clean |

`docs/handoffs/next-actions.md` is **historical** — it describes a merge that has
already happened, and lists P1 items that are done.

`docs/claude-handover-new-session.md` (untracked, also duplicated in the external
folder) claims the command suite passed with no failures. That was true only on
Windows/Node 24; CI was already red. It is superseded by this document.

Documents that **are** current and trustworthy: `README.md`, `RELEASE_CHECKLIST.md`,
`RELEASE_NOTES.md`, `SECURITY.md`, `docs/api-reference.md`, `docs/unified-memory.md`,
`docs/benchmark-report.md`, `docs/mcp-compatibility.md`,
`docs/shadowgraph-benchmark-plan.md`, both ADRs, and the lifecycle / journal /
sqlite-restore contracts.

## 8. External folder — awaiting your decision

`C:\Users\aelkh\AI Projects\ShadowGraph` holds 10 files and was **not modified**.
Eight `docs/*.md` files are **stale 2026-08-25 duplicates** of newer tracked repo
copies; `claude-handover-new-session.md` is identical to the untracked repo copy;
**`IDEA.md` exists only there.**

Recommendation: copy `IDEA.md` into the repo if it still matters, then archive or
delete the external `docs/` snapshot. Not performed — it is a deletion decision and
needs your say-so.

## 9. Open product decisions (yours, not defects)

`U-1` — how may a fact ever legitimately become `verified`? (interim: nothing
reaches `verified` from tool input; verified as still true in this session).
`L-1` — entry state `active` vs `proposed`. `L-2` — are documented transitions
normative? `L-3`/`L-5` — meaning of `stale` / `archived`. Each has documented
interim behaviour enforced by tests. No code change is needed until you rule.

## 10. Exact prompt for the next session

```text
Continue the ShadowGraph release-readiness work.

Repository: C:\Users\aelkh\AI Projects\test deepseek
Read first: docs/handoffs/claude-release-handover.md, then
            docs/handoffs/claude-release-readiness-review.md

State: branch claude/final-beta-readiness (5 commits ahead of main) fixes the
three defects that kept CI red and is GREEN on all six matrix jobs. The last
code-bearing commit is 6b0dbbd; everything after it is documentation. 3 six-job
runs are green. main @ 96a34c6 is still red because nothing has been merged.
A PR is open and must not be merged without my approval.

Do this in order:
1. Verify identity and state: git rev-parse --show-toplevel;
   git status --short --branch; git log --oneline -4.
2. Confirm the branch is still green before trusting anything local:
   gh run list --branch claude/final-beta-readiness --limit 3
3. Ask me whether to merge claude/final-beta-readiness into main. Do not merge
   without my explicit approval.
4. After any merge, confirm main itself goes green:
   gh run list --branch main --limit 3
5. Report proven vs not-measured separately. The still-open gates are the
   independent security review, the seven-arm comparative benchmark
   (COMPARATIVE BENCHMARK NOT MEASURED - 0 of 7 arms), and maintainer sign-off.
6. Do not publish to npm, tag, create a release, or flip private:false.
7. Optional: the P2 documentation corrections in the review, section 17 -
   docs/handoffs/current-status.md is wrong in five places.
```
