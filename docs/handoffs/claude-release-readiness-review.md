# ShadowGraph — Independent Release-Readiness Review (Claude)

**Reviewer:** Claude (first independent reviewer; did not participate in prior sessions)
**Review date:** 2026-08-29
**Reviewed tree:** `main` @ `96a34c60475739014b38f9a44caf30b5e4527c76`
**Fix branch produced:** `claude/final-beta-readiness`, pushed to origin, **5 commits**
ahead of `main`, open as a pull request and **not merged**.

**Code-bearing commits:** `77d8206` (the three fixes) and `6b0dbbd` (the Node 20 fix).
Every later commit on this branch is documentation-only, so the last commit that can
change behaviour is `6b0dbbd`.

**CI:** green on **all six jobs** for every commit from `6b0dbbd` onward —
run **33245087040** on `6b0dbbd` (green on **two** attempts) and run **33245578769**
on `feb277e` — **3 named green six-job runs**, covering the final code state twice.
Every later push is documentation-only and starts its own run; all have been green,
and the run for the exact current HEAD is linked from the pull request and reported
to the maintainer alongside the final SHA.

> **Why this document does not name its own HEAD.** A file that records the SHA it is
> committed as is stale the instant it is committed — that is exactly how the earlier
> "three commits / head `6b0dbbd`" mismatch arose. The stable facts are the
> code-bearing commits and their CI runs; the moving HEAD lives in the PR.
**Verdict:** **NOT READY FOR PUBLIC BETA** — see §19. The CI blocker is closed; the
remaining blockers are the independent security review, the comparative benchmark,
and maintainer sign-off — none of which can be satisfied from inside this repository.

Everything below was independently re-derived from the repository. No claim from
the previous Hermes handover was accepted without its own evidence.

---

## 1. Verified repository identity

    git rev-parse --show-toplevel   -> C:/Users/aelkh/AI Projects/test deepseek   [MATCHES canonical]
    git remote -v                   -> origin https://github.com/LiLara-AI/shadowgraph.git (fetch/push)
    git rev-parse HEAD              -> 96a34c60475739014b38f9a44caf30b5e4527c76
    git status --short --branch     -> ## main...origin/main
                                       ?? docs/claude-handover-new-session.md

The expected HEAD `96a34c6` was **confirmed**, not assumed. Working tree was clean
apart from one untracked handover file.

Local branches at review start:

| Branch | Head | Tracking |
| --- | --- | --- |
| `main` | `96a34c6` | `origin/main` |
| `fix/node20-ci-and-remaining-findings` | `2dfcc23` | pushed |
| `feature/shadowgraph-v032-hardening` | `d04e7a0` | pushed |
| `feature/shadowgraph-v031-release-review` | `15f2e53` | pushed |

## 2. Local and remote commit state

`git fetch --prune` succeeded (pruned two deleted remote branches).

    git rev-parse HEAD origin/main        -> both 96a34c6...
    git rev-list --left-right --count HEAD...origin/main -> 0   0

**Local `main` is exactly in sync with `origin/main`** — zero ahead, zero behind.

`96a34c6` is a merge of `0aa023c` and `2dfcc23`. `git diff 2dfcc23 96a34c6` is
**empty**: the merge introduced no content beyond the feature branch, so the
`main` tree equals the `2dfcc23` tree.

## 3. GitHub Actions status — **RED**

`gh` is authenticated (account `LiLara-AI`, scopes `gist, read:org, repo, workflow`),
so remote CI was verified directly rather than inferred.

    gh run list --branch main --limit 5

| Run | Commit | Result | When |
| --- | --- | --- | --- |
| 33201202487 | `96a34c6` (current HEAD) | **failure** | 2026-08-28T18:51Z |
| 33145524708 | `0aa023c` | failure | 2026-08-28T05:41Z |
| 33077509331 | `3e83195` | success | 2026-08-27T13:34Z |
| 33000080165 | `874cff8` | success | 2026-08-26T18:30Z |
| 32933109843 | — | success | 2026-08-26T05:11Z |

**The current tip of `main` has never had a green CI run.** The last green run
predates both `0aa023c` and `2dfcc23`.

Per-job breakdown of run 33201202487 (matrix = {ubuntu, windows} x Node {20, 22, 24}):

| Job | Result | Failing tests | Counts |
| --- | --- | --- | --- |
| ubuntu / Node 20 | fail | #44 metacharacter pack, #192 tarball audit | 1201 tests, 1089 pass, 2 fail, 110 skipped |
| ubuntu / Node 22 | fail | #192 tarball audit | 1201 tests, 1200 pass, 1 fail, 0 skipped |
| ubuntu / Node 24 | fail | #192 tarball audit | 1 fail |
| windows / Node 20 | fail | #44 metacharacter pack | 1201 tests, 1090 pass, 1 fail, 110 skipped |
| windows / Node 22 | pass | — | — |
| windows / Node 24 | fail | `DS-P1-003 MCP restore fences an external JSON writer` | 1200 pass, 1 fail |

Because `npm test` fails, **every gate after it never executed** in the failing
jobs: `npm audit`, `check:integrations`, strict MCP Inspector, SQLite coverage,
`py_compile`, `check:package`, and the real tarball clean-install smoke were all
skipped. The green appearance of those gates locally does not extend to CI.

## 4. Documentation authority map

Authority order used: **implementation and tests > package scripts and CI > release
contract prose > handoff prose > historical planning prose.**

Ground truth extracted from code:

| Fact | Source of truth | Value |
| --- | --- | --- |
| Package version | `package.json` | `0.40.0` |
| Publication state | `package.json` | `"private": true` |
| Entity schema | `src/shadowgraph.js:20` | `SCHEMA_VERSION = 5` (supports 1–5) |
| Journal schema | `src/journal.js:11` | `JOURNAL_SCHEMA_VERSION = 5` |
| MCP protocol | `src/mcp.js:70-71` | dual-era: legacy `2024-11-05`, modern `2026-07-28` |
| MCP tools | official Inspector | 27 full / 12 compact |
| Packed files | `npm pack --dry-run` | 60 |
| Version string | `src/version.js` | single source, read from `package.json` |

Document classification:

| File | Location | Ver | Schema | Class | Evidence / required correction |
| --- | --- | --- | --- | --- | --- |
| `package.json`, `package-lock.json`, `src/**`, `test/**`, `.github/workflows/ci.yml` | repo | 0.40.0 | 5 | **current (authoritative)** | — |
| `README.md` | repo | 0.40.0 | 5 | **current** | Matches code, incl. honest benchmark and `private:true` wording |
| `RELEASE_CHECKLIST.md` | repo | 0.40.0 | — | **current** | Accurate and honest; all technical gates still unchecked |
| `RELEASE_NOTES.md` | repo | 0.40.0 | — | **current** | No superiority claims |
| `SECURITY.md` | repo | 0.40.0 | — | **current** | Correctly names independent review as an open gate |
| `CHANGELOG.md` | repo | 0.40.0 | 4→5 | **current** | Historical entries mention schema 4; correct in context |
| `CONTRIBUTING.md` | repo | — | — | current | — |
| `docs/api-reference.md` | repo | 0.40.0 | 5 | **current** | Matches code |
| `docs/unified-memory.md` | repo | 0.40.0 | 5 | **current** | Markdown external-copy boundary documented |
| `docs/benchmark-report.md` | repo | 0.40.0 | — | **current** | `bestClaimAllowed=false` reproduced from the real aggregate |
| `docs/mcp-compatibility.md` | repo | — | — | current | Consistent with dual-era code |
| `docs/shadowgraph-benchmark-plan.md` | repo | 0.40.0 | — | **current** | Preregistration rules match the shipped harness |
| `docs/adr/0006`, `0007` | repo | — | — | **current** | ADR-0006 accepted; 0007 matches journal code |
| `docs/handoffs/lifecycle-contract.md` | repo | — | 5 | **current** | — |
| `docs/handoffs/journal-contract.md` | repo | — | — | **current** | Matches `src/journal.js` epoch/gap rules |
| `docs/handoffs/sqlite-restore-contract.md` | repo | — | — | **current** | Matches `src/sqlite-storage.js` |
| `docs/handoffs/current-status.md` | repo | 0.40.0 | **4** | **CONTRADICTORY** | See §5 — four separate stale facts |
| `docs/handoffs/next-actions.md` | repo | 0.31.0 | — | **historical** | Says branch "awaiting conditional merge"; it merged on 2026-08-28 |
| `docs/handoffs/issues-and-risks.md` | repo | 0.31.0 | — | historical | Last updated 2026-08-25 |
| `docs/handoffs/{decision,session,research,test-and-benchmark}-log.md` | repo | 0.31.0 | — | historical | Append-only logs; correct as history |
| `docs/handoffs/{g4-plan,cumulative-diff-review}.md` | repo | 0.30.0 | — | historical | `next-actions.md` itself proposes archiving these |
| `docs/handoffs/{completeness,confidence,provenance,search}-contract.md` | repo | — | — | current | — |
| `docs/goal-review.md`, `docs-v030-acceptance.md` | repo | 0.31.0 / — | — | historical | Excluded from the package |
| `docs/shadowgraph-*.md` (7 files) | repo | 0.30–0.40 | — | mixed historical | Repo copies are the newer of each pair |
| `docs/claude-handover-new-session.md` | repo (**untracked**) | — | — | **contradictory** | See §7 |
| `IDEA.md` | external only | — | — | **unique to external folder** | Not duplicated in repo |
| `<external>/docs/*.md` (8 files) | external | — | — | **stale duplicates** | See §5 |

## 5. Duplicated, stale, and conflicting documents

### 5a. External folder `C:\Users\aelkh\AI Projects\ShadowGraph` — read-only, untouched

10 files. Byte-comparison against the repo copies:

| File | Status |
| --- | --- |
| `IDEA.md` | **exists only externally** — no repo counterpart |
| `docs/claude-handover-new-session.md` | **identical** to the untracked repo copy (both written 2026-08-29 08:40) |
| `docs/shadowgraph-benchmark-plan.md` | differs — repo 18 442 B vs external 3 487 B |
| `docs/shadowgraph-security-and-safety.md` | differs — repo 8 123 B vs external 4 175 B |
| `docs/shadowgraph-vision-scope.md` | differs — repo 4 959 B vs external 3 972 B |
| `docs/shadowgraph-redesign-proposal.md` | differs — repo 6 556 B vs external 6 028 B |
| `docs/shadowgraph-product-manager-current.md` | differs — repo 5 145 B vs external 4 604 B |
| `docs/shadowgraph-next-session-brief.md` | differs — repo 3 769 B vs external 3 079 B |
| `docs/shadowgraph-competitor-research-notes.md` | differs — repo 1 878 B vs external 1 836 B |
| `docs/shadowgraph-session-start.md` | differs — repo 1 419 B vs external 1 388 B |

Every differing external file is dated **2026-08-25**; the repo copies are tracked
and newer. The external folder is a **stale 2026-08-25 snapshot**, not a second
source of truth. `docs/handoffs/next-actions.md` independently records the same
conclusion. **Nothing in the external folder was modified, deleted, or merged.**

**Recommendation (needs your decision, not performed):** keep the repo copies
authoritative; either delete the external `docs/` snapshot or mark it `ARCHIVE-`
prefixed. `IDEA.md` is the only file that would be lost and should be copied into
the repo first if it still matters.

### 5b. `docs/handoffs/current-status.md` — four contradictions with the implementation

| Claim in doc | Actual | Impact |
| --- | --- | --- |
| `npm test -> 372 tests / 367 pass / 5 todo` | 1204 tests / 1204 pass / **0 todo** | Materially stale |
| **Schema: 4** | `SCHEMA_VERSION = 5`, `JOURNAL_SCHEMA_VERSION = 5` | Wrong schema in the primary status doc |
| `check:package -> 62 files` | 60 files | Stale |
| "MCP is `2024-11-05` … no newer support claimed" | dual-era, modern `2026-07-28` implemented | Understates the product |
| "Branch: `main` with an uncommitted review tree" | tree is clean | Stale |
| "5 remaining `todo` entries … U-1, L-1, L-2, L-5" | 0 todo tests remain | The open *decisions* still exist; the todo *tests* do not |

None of these are code defects. All are **P2 documentation corrections**.

### 5c. Superiority-claim scan — clean

A scan of every tracked `.md` for `best|fastest|cheaper|better than|outperform|
superior|beats|more accurate|leading` found **no unsupported comparative claim**.
Every hit is either the *prohibition* itself, a changelog entry recording the
prohibition, or an unrelated word (`superseded`). README, RELEASE_NOTES,
benchmark-report and the benchmark plan all carry the frozen no-result text.
This is a genuine strength and should not be weakened.

## 6. Previous claims **CONFIRMED**

| # | Claim (Hermes handover / status docs) | Independent evidence |
| --- | --- | --- |
| C1 | HEAD is `96a34c6`, merge of `fix/node20-ci-and-remaining-findings` | `git log`/`git rev-parse` confirm; merge adds nothing beyond `2dfcc23` |
| C2 | Credential-name boundary capped at 512 across channels | `benchmark/lib/adapters.mjs:32` `MAX_DISCOVERED_CREDENTIAL_NAME_CHARS = 512`, enforced in `normalizedCredentialName()` before and inside the decode loop |
| C3 | Bounded, fail-closed decoding | `MAX_SECRET_ENCODING_ROUNDS = 3`; a 4th round calls `markDiscoveryExhausted` and returns `null` |
| C4 | Public signature fields preserved, auth signatures redacted | `excludedCredentialName()` exempts `publickey`, `documentsignature`, `providersignature`, `publicsignature` and pagination tokens; `AUTH_RELATED_KEY_PREFIXES` still redacts `apiKey`/`privateKey`/`signingKey`/`encryptionKey` |
| C5 | SQLite coverage enforcement exists | `scripts/assert-sqlite-coverage.mjs` → 37 pass, 0 skipped/todo/fail |
| C6 | Package scanner bounded + shell-free `npm pack` | `scripts/check-package.mjs` uses `execFile` with no `shell` option anywhere |
| C7 | `npm run check`, `npm test`, `benchmark:test`, `audit`, `check:mcp`, `check:integrations`, `check:package`, `smoke:package` all pass locally | Reproduced — §8 |
| C8 | Preregistration hash `738ee8b4…5dac` | `sha256sum benchmark/preregistration.json` matches the sidecar and the checklist |
| C9 | Dashboard does not persist the API token | `dashboard/index.html` — `type="password"`, `autocomplete="off"`, no `localStorage`/`sessionStorage`/cookie use |
| C10 | Comparative benchmark measured nothing | `aggregate.json`: `measuredArms:0, notMeasuredArms:7, measurements:0, bestClaimAllowed:false` |
| C11 | G1 — reconsideration works from persisted state | Independently reproduced end-to-end on JSON, SQLite, and MCP with negative controls — §11, §12 |
| C12 | G5 — logical vs hard purge semantics | Independently reproduced, including declared journal gap — §11 |

## 7. Previous claims **DISPROVED or materially incomplete**

| # | Claim | Reality |
| --- | --- | --- |
| **D1** | Handover §3: "Command suite passed successfully; **no test failures** in the recorded complete runs" | True **only** for Windows + Node 24. Remote CI has failed on `main` since `0aa023c`; the current HEAD run 33201202487 failed on **5 of 6** matrix jobs. The handover does disclose it "did not perform a fresh remote CI verify" — but the plain reading that the suite is green is wrong. |
| **D2** | Branch name and commit `2dfcc23` "chore: close remaining P1/P2 findings and finalize CI gates" imply Node 20 CI was fixed | Node 20 still fails on both operating systems (test #44). The branch named `fix/node20-ci-...` did not fix Node 20. |
| **D3** | `current-status.md`: schema 4, 372 tests, 5 todo, 62 packed files, MCP `2024-11-05` only | All five are stale — §5b |
| **D4** | `next-actions.md`: "review branch is pushed and awaiting conditional merge" | Merged 2026-08-28; document is historical |
| **D5** | Implicit in the handover's "all P0/P1/P2 findings closed before merge" | Three defects were open at merge and are only closed by this session's branch — §14 |

Note on D1: the previous session's verification was honest about *what it ran*;
the gap is that a Windows/Node 24-only run structurally cannot observe the Linux
`/tmp` failure or the Node 20 failure. **Local green is not evidence of CI green
for this repository**, and that should be treated as a standing rule.

## 8. Exact command results

Environment: Windows 11 Pro 26200, **Node v24.18.0**, **npm 11.9.0**, **Python 3.11.15**.
Run from the canonical repository after `npm ci`. The package has **zero runtime
dependencies** (`audited 1 package`).

On `main` @ `96a34c6`:

| Command | Exit | Result |
| --- | --- | --- |
| `npm ci` | 0 | up to date, audited 1 package, 0 vulnerabilities |
| `npm run check` | 0 | all `node --check` + `benchmark:check` pass |
| `npm test` | 0 | **1201 tests / 1201 pass / 0 fail / 0 skipped / 0 todo**, 20 suites, 101 970 ms |
| `npm run benchmark:test` | 0 | 49 / 49 pass |
| `npm run check:mcp` | 0 | Inspector Full tools=27 errors=0 warnings=0; Compact tools=12 errors=0 warnings=0 |
| `npm run check:integrations` | 0 | Claude Code / Cursor / Codex / Hermes templates valid |
| `npm run check:package` | 0 | valid, 60 files, `private=true` |
| `npm run smoke:package` | 0 | real pack + clean install under a spaced path; CLI, MCP full+compact, HTTP all true; cleanup verified |
| `npm audit --omit=dev` | 0 | 0 vulnerabilities |
| `npm pack --dry-run --json` | 0 | 60 entries, 207 987 B packed, 773 059 B unpacked |
| `node scripts/assert-sqlite-coverage.mjs` | 0 | 37 pass, 0 skipped/todo/fail |
| `python -m py_compile integrations/hermes-agent.py` | 0 | — |
| `git diff --check` | 0 | clean |

On `claude/final-beta-readiness` (code state `6b0dbbd`), every command above was re-run with
the same exit codes; `npm test` becomes **1204 / 1204 pass / 0 fail / 0 skipped /
0 todo** (three regression tests added). The same chain then ran green on all six
CI jobs — §15.

Code markers: `git grep -nE "TODO|FIXME|HACK|XXX"` returns **5 hits, all in
historical handoff prose**, none in `src/`, `test/`, `scripts/`, or `benchmark/`.
No code-level TODO is a release blocker. `todo()` was not used.

**NOT MEASURED / EXTERNALLY BLOCKED**

- **Node 20 and Node 22 behaviour locally** — only Node 24 is installed and no
  version manager is present. Installing another runtime would mean downloading an
  external binary, which was not done. **This was resolved by CI instead**: the
  matrix exercised Node 20 and 22 on both operating systems and is green (§15).
- **Linux behaviour locally** — Windows-only host. Simulated faithfully for the
  specific failing assertion (§14, CI-1), then **confirmed on real Linux runners**
  by CI (§15).

Remote CI is **no longer** an unmeasured item. The branch was pushed with the
maintainer's approval and verified directly — see §15 for the per-job results.

## 9. Security findings

Scope: independent read of `src/`, `scripts/`, `benchmark/lib/`, `dashboard/`,
plus live probing. Findings are separated by kind, and no theoretical issue is
presented as a vulnerability.

### Confirmed vulnerabilities

**None.** No confirmed exploitable vulnerability was found in this review.

### Verified-correct controls (evidence, not assertions)

| Surface | Evidence |
| --- | --- |
| Bearer token comparison | `src/server.js:236` uses `timingSafeEqual` with a required length pre-check; token minimum 16 chars enforced at startup (`server.js:80`) |
| Network binding | `listen(port, '127.0.0.1')` — loopback only |
| DNS rebinding | `Host` header validated against loopback authority **and** the actual `socket.localPort` (`isAllowedLocalHost`) |
| CORS / origin | `Origin`, when present, must be `http://` loopback on the same port |
| Request body limit | `MAX_BODY_BYTES = 1 MiB`, enforced with a `413` |
| Path traversal (Markdown) | `safeSegment()` maps `<>:"/\|?*` and control chars to `_`, rewrites trailing dots/spaces, maps a pure-dot segment (`.`, `..`) to `_`, and prefixes Windows device names. `..` **cannot** become a path segment. |
| Symlink traversal (Markdown pull) | `readdir(withFileTypes)` + `isDirectory()`/`isFile()` — dirents for symlinks are neither, so links are skipped |
| SQL injection | The only interpolated SQL is `VACUUM INTO '<path>'`; `quoteSqlPath` doubles single quotes, and all three call sites use internally derived paths |
| SQLite durability | `PRAGMA busy_timeout=5000`, `journal_mode=WAL`, `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK`, `wal_checkpoint(TRUNCATE)` + `secure_delete=ON` before purge-related `VACUUM`, `VACUUM INTO` for backup/staging |
| JSON atomicity | temp-write with pid+time+random suffix, then `rename` |
| Command execution | `scripts/check-package.mjs` and `benchmark/lib/adapters.mjs` use `execFile` with argument arrays; **no `shell` option in shipped code** |
| Credential redaction | 512-char name cap, 3-round bounded decoding, fail-closed on exhaustion, context-scoped short aliases, public-signature exemptions (C2–C4) |
| Secret logging | Adapter artifacts sanitize stdout/stderr/command/nested artifacts; covered by dedicated suites |
| Scoped isolation | Independently reproduced: a null-scope recall cannot see another user's scoped memory (§11) |
| Cross-project isolation | Independently reproduced: project `alpha` recall never returned the `beta` marker (§11) |
| Purge | Logical redacts the journal payload in place; hard removes entries and **declares** the gap; graph stays `valid` (§11) |
| External Markdown boundary | Documented in `README.md:35`, `README.md:216`, `docs/unified-memory.md:230`, `SECURITY.md:23` |
| Package artifact contents | 60 files; `test/`, `.github/`, `docs/handoffs/`, `RELEASE_CHECKLIST.md`, `benchmark/results/**`, DB files and caches all excluded (verified in the real tarball, not just `--dry-run`) |
| Supply chain | Zero runtime dependencies; `npm audit --omit=dev` → 0 vulnerabilities |

### Defense-in-depth findings (fixed this session)

**S-1 — `EPERM` on a delete-pending lock file defeated the destination fence (Windows).**
*Severity:* P1 (availability / data-integrity edge, Windows only).
*Path:* `src/revision-store.js`, `acquire()`.
*Reproduction:* CI run 33201202487, `windows-latest / Node 24`,
`DS-P1-003 MCP restore fences an external JSON writer in a separate server process`
— the external writer received
`EPERM: operation not permitted, open '...\live state.json.lock'` instead of the
documented `revision conflict`.
*Cause:* Only `EEXIST` was treated as contention. Windows keeps an
unlinked-but-still-open file in a *delete-pending* state where every `open` returns
`EPERM`/`EACCES` rather than `ENOENT`, so a writer arriving during lock release
failed hard instead of waiting.
*Expected:* a concurrent writer waits for the fence and is then checked against the
restored revision.
*Fix:* `LOCK_CONTENTION_CODES` adds `EPERM`, `EACCES`, `EBUSY` **on win32 only**;
they remain bounded by `lockTimeoutMs`, so a genuine permission fault still fails
as an explicit `storage_lock_timeout`. The staleness probe handles the same window.
*Regression test:* `DS-P1-003 destination fence treats a transiently unopenable lock
as contention and still fails closed` — asserts a held lock still fails closed, a
disappearing foreign lock is waited out with `onWait` fired, and no lock is leaked.

**S-2 — the package checker discarded the cause of a packaging failure.**
*Severity:* P1 (release-process integrity).
*Path:* `scripts/check-package.mjs`, `runNpm()`.
*Reproduction:* CI Node 20 reported only `package check failed: npm pack command failed`.
*Cause:* `catch { fail('npm pack command failed'); }` swallowed both npm's real
error **and** the more specific `PackageCheckError` thrown by `resolveNpmCli()`
("npm CLI entry point could not be resolved"), because the resolver ran inside the
same `try`.
*Expected:* the release gate names why packaging failed without disclosing a local
path.
*Fix:* resolver moved outside the `try`; failures now carry exit code / signal /
errno and npm's own error lines, with every absolute path replaced first.
*Regression test:* `check-package reports why npm pack failed without disclosing any
absolute path` — asserts the cause survives **and** that no Windows or POSIX
absolute path appears in the diagnostic.

### Documentation issues

- **S-3 (P2):** `docs/handoffs/current-status.md` misstates schema, test counts,
  todo count, packed-file count, and MCP protocol support (§5b).
- **S-4 (P2):** `docs/handoffs/next-actions.md` describes a merge that has happened.

### Unsupported / theoretical — explicitly *not* claimed as findings

- Token **length** is observable through the `timingSafeEqual` length pre-check.
  This is unavoidable with that primitive, the server is loopback-only, and the
  token has a 16-char minimum. Not a finding.
- `atomicWrite` in `markdown-workspace.js` leaves a `.tmp` file if `rename` fails.
  Same-directory, non-secret, user-owned. Housekeeping, not a vulnerability.
- **P2 (not fixed, out of scope):** the *test helper* `runNpmPack` in
  `test/followup-public-artifacts.test.js:507` still uses `shell: true` on Windows
  with an argument array — the exact DEP0190 pattern the shipped script was
  hardened against. It emits a deprecation warning during `npm test`. Test-only
  code with locally derived arguments; recorded for consistency, not fixed here.

## 10. Package clean-install results

`npm run smoke:package` (exit 0) and an additional **independent** manual
clean-install performed by this review:

- Real tarball built with `npm pack` → `shadowgraph-unified-plugin-0.40.0.tgz`, 60 files.
- Installed into a fresh host package at
  `…/scratchpad/sg lifecycle test/clean install with spaces/` — **path contains spaces**.
- `node_modules/.bin/shadowgraph{,.cmd,.ps1}` present.
- `shadowgraph setup` → exit 0, created JSON store at a spaced path.
- `shadowgraph doctor` → exit 0; `storage.writable: true`, `graph.valid: true`,
  `mcp.available: true`, `recommendedMode: compact`.
- CLI exit codes verified correct: invalid input → **exit 1** with a clear message.

The harness smoke reports `tarballFiles:60, cleanDirectoryContainedSpaces:true,
installedPackage:true, cliSetupDoctor:true, cliRememberRestartRecall:true,
changedFactReviewAfterRestart:true, mcpFullTools:27, mcpCompactTools:12,
mcpRememberRestartRecall:true, httpHealthAndDashboard:true`, plus verified cleanup.

## 11. JSON and SQLite workflow results

Every step below was run against the **installed package**, in separate processes,
with the persisted file inspected directly — not inferred from tool output.

**JSON storage — full 22-step lifecycle: PASS**

| Step | Result |
| --- | --- |
| install / setup / doctor | pass (§10) |
| record scoped memory | `schemaVersion:5`, scope `{u1,a1,r1}` persisted |
| record decision + alternatives + rejection reasons | both alternatives persisted with `reasonRejected`, `status:"rejected"`, `reopenWhen` |
| record fact + evidence | `sourceClass:"tool_observed"`, `verificationStatus:"unverified"` |
| record failed attempt | `result:"failure"`, `reusableWhen` persisted |
| exit and restart | every read below is a **new process** |
| recall stored state | returns the persisted records |
| direct file inspection | `schemaVersion:5`; keys `records, facts, relations, reviewSignals, idempotency, events, journal, journalSeq, journalEpoch` |
| change a stored fact | supersedes prior value; prior fact becomes `status:"superseded"` |
| reconsideration — **negative control** | string `reopenWhen` rule with no `changedFacts` → `[]` (documented ephemeral-signal semantics) |
| reconsideration — string rule | `changedFacts:["deployment_model"]` → decision due, alternative `Postgres` |
| reconsideration — **stored state only** | object rule `{key,operator,value}`, **no arguments at all**, fresh process → decision due. **This is G1 and it holds.** |
| confidence + provenance | `evidence_weighted_bounded_v1`, full basis; `sourceClass` retained; nothing reached `verified` |
| project isolation | `alpha` recall never returned the `beta` marker |
| scope isolation | a null-scope recall could not see `u2`'s memory |
| backup | 5 records / 2 facts / revision 12 written to a spaced path |
| mutate | 6 records, mutation present |
| restore | 5 records, **mutation absent**, revision 14 (monotonic — stale-writer safe) |
| verify restored data | reconsideration still fires after restore |
| purge preview | `records:1, events:1, journal:1` for `beta` |
| logical purge | record removed; `journalEntriesRedacted:1`, `journalEntriesRemoved:0`; **raw file no longer contains the payload** |
| hard purge | `journalEntriesRemoved:1`, `removedJournalSequences:[10]`; **raw file clean**; `validate` reports `valid:true` with an **info** `journal_gap 10→10` — the gap is declared, not hidden |

**SQLite storage: PASS**

- `setup`/`doctor` report `type:"sqlite"`, writable, valid.
- Direct DB inspection: tables `shadowgraph_{entities,events,idempotency,journal,
  meta,relations,reviews,state}`; `journal_mode = wal`.
- Reconsideration with a proper negative control: `[]` while the fact was `small`,
  then due after the fact changed to `large` — **across separate processes**.
- Backup → mutate → restore verified **at the database level**: after restore the
  post-backup decision `SQLITE-POST-BACKUP` is absent and entity count is correct.

## 12. MCP full and compact results

- Official strict Inspector (`npm run check:mcp`): **Full 27 tools, Compact 12
  tools, 0 errors, 0 warnings.**
- Independent stdio JSON-RPC probe against the **installed** package confirmed the
  same counts and `protocolVersion 2024-11-05`, `serverInfo.name "shadowgraph"`.
- Three-process lifecycle driven over MCP in **both** modes
  (`shadowgraph_record_decision` → `shadowgraph_record_fact` → kill → `shadowgraph_review`
  (negative control: `[]`) → change fact → kill → `shadowgraph_review`):
  both **full** and **compact** returned the decision as due for reconsideration
  after restart. Cross-process durability and reconsideration hold on both surfaces.
- Compact tool set verified: `shadowgraph_{record_decision,record_attempt,review,
  search,context,remember,recall,record_fact,record_outcome,maintain,retrieve,validate}`.

## 13. Benchmark results and limitations

Three distinct things must not be conflated, and the repository does not conflate them:

1. **Harness tests** — `npm run benchmark:test` → 49/49 pass. Proves the harness works.
2. **Journal/storage performance** — `benchmark/results/20260827T161115Z/journal-raw.json`
   exists; a local 1k/10k/100k JSON+SQLite journal measurement. Proves storage cost.
3. **Comparative AI-memory evaluation** — **NOT PERFORMED.**

Verified from the retained artifacts (not from prose):

- `benchmark/preregistration.json` hashes to
  `738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac`, matching both
  the sidecar and `RELEASE_CHECKLIST.md`. The preregistration is genuinely frozen.
- `comparative/aggregate.json`: `measuredArms: 0`, `notMeasuredArms: 7`,
  `failedArms: 0`, `measurements: 0`, `rankEligibleArms: []`, `armResults: []`,
  **`bestClaimAllowed: false`**.
- `comparative/logs/capability-probe.json`: `commonModelAvailable: false`; LLM and
  embedding both `configured:false, reachable:false, compatible:false`;
  `localDiscovery: attempted 4, responding 0`.

### COMPARATIVE BENCHMARK NOT MEASURED

The required lifecycle comparison — **A** fresh decision, **B** restart recall,
**C** repeated task, **D** changed-fact reconsideration, **E** failed-attempt
avoidance — has **not** been run against competitors. No common local/free LLM and
embedding endpoint is available in this environment, so it remains
**EXTERNALLY BLOCKED**.

Note the distinction carefully: this review **did** independently verify B, D and E
*for ShadowGraph itself* (§11, §12) — restart recall, changed-fact reconsideration,
and stored failed attempts all work. That is **product-behaviour evidence, not
comparative evidence**. No claim that ShadowGraph is faster, cheaper, better, or
more accurate than any alternative is supported, and none is made anywhere in the
repository (§5c).

## 14. Confirmed code changes

Branch `claude/final-beta-readiness`, **5 commits** ahead of `main`. Only two carry
code: `77d8206` (the three fixes) and `6b0dbbd` (the Node 20 fix); `550b118`,
`feb277e` and the consistency pass are documentation-only.
Each fix has a regression test. No existing assertion was weakened to obtain a
green suite: the only assertion that changed (CI-2) was made *truthful* about what
ShadowGraph owns versus what npm owns, and still fails on any unexpected error.

**CI-1 — `runtime-local-root` false positive on every Linux runner** *(P0 — blocks CI)*
`test/followup-public-artifacts.test.js`. `sensitiveRoots.some(root =>
normalized.includes(root))` was a bare substring test. On Linux `tmpdir()` is
`/tmp`, and line 23 of `scripts/check-package.mjs` — this project's own
`posixTempPathPattern`, containing `var/tmp` and `private/tmp` — therefore matched.
The tarball was reported as leaking a local path when it does not.
Root matching is now anchored at a path boundary: skip back over a run of
separators (so `file:///home/you/x` still counts) and reject when the preceding
character could continue a path segment.
**Proof, not assertion:** the real tarball was scanned with Linux-style roots
(`/home/runner/work/shadowgraph/shadowgraph`, `/home/runner`, `/tmp`). The old
matcher reports **exactly one** hit — `scripts/check-package.mjs:23`, identical to
the CI failure — and the new matcher reports **zero**, with no other packed file
affected. New test asserts the benign pattern is clean *and* that seven genuine
disclosure shapes (leading separator, nested temp path, home subdirectory,
`file:` URL, quoted bare root, Windows repository root, end-of-line) are still caught,
that the offending line is still rejected as `absolute-posix-temp-path`, and that an
empty root never matches everything.

**CI-2 — the Node 20 packaging failure had no diagnosable cause** *(P1)*
`scripts/check-package.mjs` — see **S-2**. Surfacing the cause worked: CI run
33244747010 reported

    package check failed: npm pack command failed: exit=1
      stderr=npm error URI malformed | npm error A complete log of this run can be found in: <path>

(note the sanitizer replaced npm's log path with `<path>` and disclosed no local root).

**Root cause, now confirmed:** npm 10.8.x, bundled with **Node 20**, throws
`URI malformed` when it turns a package directory whose absolute path contains `%`
into a `file:` spec. npm 10.9+ (Node 22/24) does not. The fixture at
`test/check-package.test.js` deliberately packs from
`shadowgraph npm pack &()!^%-XXXX/safe repo copy &()!^%`. **This is an upstream npm
bug, not a ShadowGraph defect**, and no invocation style avoids it — npm hits it
while resolving the package directory itself.

**Resolution:** the test now asserts what ShadowGraph actually owns, unconditionally
on every runtime — the fallback never spawns a shell (no `DEP0190`, so `&()!^%`
cannot be interpreted) and no local path is disclosed — and then branches: where npm
can handle `%` it must succeed, and where npm cannot it must fail with *exactly* the
sanitized upstream reason. Any other failure still fails the test. The assertion was
made truthful rather than weakened: `scripts/check-package.mjs` is a security control
and was not relaxed to accommodate npm.

*Impact note:* this affects only the maintainer-facing release gate. The shipped
runtime (`src/`) never shells out to npm, and `npm run check:package` runs from the
repository root.

**CI-3 — Windows delete-pending lock defeated the destination fence** *(P1)*
`src/revision-store.js` — see **S-1**.

Post-change gate results on the branch (all exit 0): `check`, `test`
(**1204/1204 pass, 0 fail, 0 skipped, 0 todo**), `benchmark:test` (49/49),
`check:mcp` (27/12, 0 errors), `check:integrations`, `check:package` (60 files),
`smoke:package`, `audit --omit=dev`, `assert-sqlite-coverage` (37/37),
`py_compile`, `git diff --check`.

## 15. Remaining P0 blockers

**None. P0-1 (CI matrix) is CLOSED.**

The fix branch was pushed with approval and the matrix was taken from red to fully
green, then re-run to rule out flakiness:

| Job | `main` 33201202487 (`96a34c6`) | 33244747010 (`550b118`) | 33245087040 att.1 (`6b0dbbd`) | 33245087040 att.2 (`6b0dbbd`) | **33245578769 (`feb277e`)** |
| --- | --- | --- | --- | --- | --- |
| ubuntu / Node 20 | fail (2) | fail (1) | **success** | **success** | **success** |
| ubuntu / Node 22 | fail | success | **success** | **success** | **success** |
| ubuntu / Node 24 | fail | success | **success** | **success** | **success** |
| windows / Node 20 | fail | fail (1) | **success** | **success** | **success** |
| windows / Node 22 | pass | success | **success** | **success** | **success** |
| windows / Node 24 | fail | success | **success** | **success** | **success** |
| **Overall** | **1/6** | **4/6** | **6/6** | **6/6** | **6/6** |

**Three** six-job runs are green: 33245087040 attempts 1 and 2 (both on the final
code state `6b0dbbd`), and 33245578769. Every commit from `6b0dbbd` onward is green;
the later commits are documentation-only and each triggers its own run, linked from
the pull request.

Every gate genuinely executed — verified per step, not inferred from the job
conclusion: `npm ci`, `npm run check`, `npm test`, `npm audit --omit=dev`,
`check:integrations`, strict MCP Inspector, SQLite coverage assertion,
`py_compile`, `check:package`, and the real tarball clean-install smoke under a
spaced path. The only `skipped` steps are the workflow's own deliberate `if:`
conditions (Inspector on Node 24 only; SQLite coverage off Node 20), which is the
documented design.

`windows / Node 24` passed the previously intermittent
`DS-P1-003 MCP restore fences an external JSON writer in a separate server process`
on **all three** green runs, so CI-3 is treated as genuinely fixed rather than lucky.

This closes the `RELEASE_CHECKLIST.md` gates "Windows Node 20/22/24 matrix green"
and "Linux Node 20/22/24 matrix green" **for the fix branch**. They are still
unmet on `main`, because nothing has been merged — merging requires your approval.

## 16. Remaining P1 blockers

**P1-1 — Independent security review not performed.** `RELEASE_CHECKLIST.md` and
`SECURITY.md` both require a named external reviewer with scope, tree hash,
findings, accepted risk, and remediation verification. This review is thorough but
is **still a Claude self-review of a Claude-built tree** and explicitly does not
satisfy that gate. `npm audit` (0 vulnerabilities, zero dependencies) does not
substitute for it either.

**P1-2 — Actual preregistered comparative benchmark not run.** §13. Seven arms,
zero measured. Requires a common local/free LLM + embedding endpoint.

**P1-3 — Maintainer sign-off and publication authorization outstanding.** Public-beta
wording, package ownership/access, provenance, support contact; plus explicit
authorization to flip `private:false`, publish, tag, and release. `package.json`
still carries `"private": true`, which is correct and should stay until the gates above close.

## 17. Deferred P2 improvements (wait for feedback / not release-blocking)

1. Correct `docs/handoffs/current-status.md` — schema 4→5, test counts, todo count,
   packed-file count, MCP dual-era support, branch state (**S-3**).
2. Mark `docs/handoffs/next-actions.md` historical (**S-4**).
3. Resolve the external-folder duplication; preserve `IDEA.md` first (§5a).
4. Archive `g4-plan.md` and `cumulative-diff-review.md` as `next-actions.md` proposes.
5. Remove `shell: true` from the `runNpmPack` test helper (§9, DEP0190 warning).
6. Open product decisions **U-1** (how a fact may ever become `verified`), **L-1**
   (`active` vs `proposed` entry state), **L-2** (normative transitions), **L-5**
   (`stale`/`archived` meaning). These are decisions for you, not defects; the
   interim behaviour is documented and enforced by tests.
7. `docs/shadowgraph-redesign-proposal.md` still diagrams a transition ladder as if
   normative (relates to L-2).
8. MCP `2026-07-28` real client interop testing (the server implements dual-era;
   interop is untested).
9. Consider excluding dev-only scripts (`check-mcp.mjs`, `assert-sqlite-coverage.mjs`)
   from the published tarball — currently shipped, harmless.
10. 100k-entry benchmark, if journal size ever becomes a concern.

## 18. External blockers

**Resolved during this review** — branch CI verification is **no longer** an
external blocker. The branch was pushed with the maintainer's approval and the
matrix ran green three times (§15), which also covered the Node 20, Node 22 and
Linux behaviour that could not be reproduced on this Windows/Node 24 host.

Still external:

| Blocker | Why | What unblocks it |
| --- | --- | --- |
| **Comparative benchmark** | No common local/free LLM + embedding endpoint; `localDiscovery` found 0 of 4 | Provide a shared endpoint, or accept the gate stays open |
| **Independent security review** | Must be a party independent of the build | Engage a named external reviewer |
| **Merging to `main`** | Deliberately withheld; requires maintainer approval | Maintainer approves and merges the pull request |
| **npm name availability** | The 404 of 2026-08-27 is a point-in-time observation, not a reservation | Re-check immediately before publishing |

## 19. Final conclusion

# NOT READY FOR PUBLIC BETA

The product itself is in better shape than its status documents suggest. Every
core behavioural claim this review could test independently held up: reconsideration
from stored state across restarts on JSON, SQLite, CLI and MCP; scoped and
cross-project isolation; atomic backup/restore with monotonic revisions; declared
purge gaps; loopback-only HTTP with timing-safe auth, host and origin validation;
bounded fail-closed credential redaction; a zero-dependency package; and — notably
— documentation that refuses to make a comparative claim it cannot support.

It is not Beta-ready because required release gates are genuinely unmet:

1. **CI on `main` is still red** — `main` is unchanged at `96a34c6`. The fix branch
   `claude/final-beta-readiness` is green on all six matrix jobs, across three green
   runs covering every commit from the final code state `6b0dbbd` onward, but
   **nothing has been merged**. A pull request is open for your decision. This
   blocker is solved but not yet landed.
2. **The independent security review has not happened.**
3. **The comparative benchmark measured zero of seven arms.**
4. **Maintainer sign-off and publication authorization are outstanding**, and
   `private: true` correctly still stands.

"READY" is reserved for the state where every required gate is *actually verified*.
Three of the four above are not verified, and one of them cannot be satisfied from
inside this repository at all.

---

### Standing rule for the next session

**Local green is not CI green for this repository.** A Windows + Node 24 run cannot
observe the Linux `tmpdir()` path or Node 20 behaviour — exactly the blind spot that
let a red `main` be handed over as passing. Check `gh run list --branch <branch>`
before reporting any suite as green.
