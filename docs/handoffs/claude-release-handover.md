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
| Fix branch | `claude/final-beta-readiness` @ `77d8206` — **local only, not pushed** | verified |
| Local suite on fix branch | 1204 tests / 1204 pass / 0 fail / 0 skipped / 0 todo | verified (Windows, Node 24) |
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

`claude/final-beta-readiness` @ `77d8206` — 5 files, +176 / −7, one commit, three
fixes, each with a regression test. No existing assertion was weakened.

| ID | Defect | File | Status |
| --- | --- | --- | --- |
| CI-1 | `runtime-local-root` used a bare `includes()`, so on Linux (`tmpdir()` = `/tmp`) the packed source of this project's own `posixTempPathPattern` was reported as a leaked local path. Failed **all three Linux jobs**. | `test/followup-public-artifacts.test.js` | **fixed, proven** by scanning the real tarball with Linux-style roots: old matcher = exactly the CI hit, new matcher = zero, other packed files unaffected |
| CI-2 | `runNpm()` replaced npm's real error *and* the specific `resolveNpmCli()` error with a bare "npm pack command failed", so the Node 20 failure reached CI undiagnosable. | `scripts/check-package.mjs` | **diagnostic fixed; underlying Node 20 cause still UNKNOWN** |
| CI-3 | The destination fence treated only `EEXIST` as contention. Windows delete-pending files answer `open` with `EPERM`/`EACCES`, so a writer arriving during lock release failed hard instead of waiting. Failed `windows / Node 24`. | `src/revision-store.js` | **fixed by reasoning**; the race is not deterministically reproducible locally |

## 4. Your next action, in order

1. **Get CI to run the fix branch.** This is the blocking step and it needs your
   approval, because pushing is outward-facing:

   ```bash
   git push -u origin claude/final-beta-readiness
   ```

   Then watch it:

   ```bash
   gh run list --branch claude/final-beta-readiness --limit 3
   ```

2. **Read what Node 20 now says.** CI-2's whole purpose is to make the Node 20
   failure legible. Expect a message of the form
   `package check failed: npm pack command failed: exit=<n> stderr=<sanitized>`
   in the `ubuntu / Node 20` and `windows / Node 20` jobs. Fix the real cause from
   that text.

   Leading hypothesis, **unproven**: npm bundled with Node 20 (npm 10.8.x)
   mishandles a package directory whose absolute path contains `%` and other
   metacharacters when building its internal `file:` spec, and npm 10.9+/11 does
   not. `test/check-package.test.js:141` deliberately packs from a path named
   `shadowgraph npm pack &()!^%-XXXX/safe repo copy &()!^%`. If that is confirmed,
   the honest fix is a version-aware expectation in the test — **not** weakening
   `scripts/check-package.mjs`, which is a security control.

3. **Confirm CI-3 held.** `windows / Node 24` should now pass
   `DS-P1-003 MCP restore fences an external JSON writer in a separate server process`.
   It was flaky (it passed on `windows / Node 20` and `windows / Node 22` in the
   same run), so one green run is suggestive, not conclusive. Re-run the workflow
   once more before trusting it.

4. **Only then** merge to `main` — with your explicit approval. Do not merge while
   the matrix is red.

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
| CI matrix green (Linux + Windows, Node 20/22/24) | next session | **P0** — needs the push in §4 |
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

State: main @ 96a34c6 has RED CI. Branch claude/final-beta-readiness @ 77d8206
fixes three defects and is green locally on Windows/Node 24, but is NOT pushed.

Do this in order:
1. Verify identity: git rev-parse --show-toplevel; git status --short --branch;
   git log --oneline -3. Confirm the branch is still 77d8206.
2. Confirm remote CI state before trusting anything local:
   gh run list --branch main --limit 3
3. Ask me to approve pushing claude/final-beta-readiness, then push it and wait
   for the matrix.
4. Read the ubuntu/Node 20 and windows/Node 20 logs. The check-package failure now
   reports its real cause. Diagnose and fix it. Do NOT weaken
   scripts/check-package.mjs - it is a security control.
5. Confirm windows/Node 24 passes the MCP restore-fence test; re-run the workflow
   once to check it is no longer flaky.
6. Re-run every local gate; report proven vs not-measured separately.
7. Do not publish, tag, release, or flip private:false. Do not merge to main
   without my explicit approval.
```
