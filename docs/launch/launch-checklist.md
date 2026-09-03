# ShadowGraph — Technical Preview launch checklist

The final **human** checklist for announcing the Technical Preview. Tick each line yourself before
posting anything from [`short-announcement.md`](short-announcement.md) or
[`technical-preview-announcement.md`](technical-preview-announcement.md).

This is the *announcement* checklist. It is deliberately separate from
[`RELEASE_CHECKLIST.md`](../../RELEASE_CHECKLIST.md), which governs npm publication and is **not**
satisfied. Announcing the preview does not publish the package.

Status column meaning: `[x]` verified by the launch-preparation pass · `[ ]` requires a human
decision or action.

---

## 1. Repository state

- [x] Repository is **public** — `visibility: PUBLIC`, not archived.
- [x] Default branch is `main`.
- [x] Repository description is set and matches the positioning (local-first decision memory; what
      was chosen, rejected, why, when to reconsider; MCP/CLI/HTTP; zero runtime dependencies).
- [x] Topics are set: `ai-agents`, `cli`, `decision-support`, `knowledge-graph`, `local-first`,
      `mcp`, `memory`, `model-context-protocol`, `nodejs`, `sqlite`.
- [x] LICENSE present and detected as MIT.
- [x] No website, no logo, no decorative badges. One functional CI badge only.
- [ ] Final human read of the rendered README on github.com, on a phone as well as a desktop.

## 2. README and documentation

- [x] README opens with what ShadowGraph is, why it matters, quick start, then the demo.
- [x] Quick Start commands are executed and verified, not written from memory.
- [x] Shell quoting documented and tested for **bash/zsh/Git Bash, Windows PowerShell, and
      Windows `cmd.exe`**.
- [x] `setup` runs before `doctor` everywhere it appears; the `doctor`-before-`setup` exit `1` is
      explained as expected.
- [x] The decision-memory demo shows real, captured output.
- [x] All relative documentation links resolve.
- [x] `docs/api-reference.md` factual errors fixed (schema constants, four method signatures,
      `npx shadowgraph`, section numbering).
- [x] No internal handover, session, or agent-planning documents are present in the repository.
- [x] No personal paths, email addresses, tokens, or credentials in tracked files or the packaged
      tarball.

## 3. Claims discipline

- [x] Labelled **Technical Preview / Early Access** — never Stable, Production Ready, or Public Beta.
- [x] No comparative claim anywhere: not faster, cheaper, lower-token, more accurate, better than
      Mem0 or Graphiti, or "best".
- [x] The only approved benchmark sentence is used verbatim where a benchmark is mentioned.
- [x] Benchmark preregistration remains frozen with its SHA-256 sidecar intact.
- [ ] Human re-read of the announcement copy specifically hunting for accidental superiority
      wording before posting.

## 4. Verification gates

- [x] `npm run check`
- [x] `npm test` — 1250/1250, zero skips, todos, or failures
- [x] `npm run check:mcp` — strict official Inspector, full and compact, then the pinned Glama mcp-proxy gate
- [x] `npm run check:integrations`
- [x] `npm run check:package` — passes with `private: true`
- [x] `npm run smoke:package` — real tarball, clean install, path containing spaces
- [x] `npm audit --omit=dev` — 0 vulnerabilities
- [x] `git diff --check`
- [x] GitHub Actions green on the announced commit: Ubuntu + Windows × Node 20/22/24
- [ ] Re-confirm CI is green on the exact commit you are announcing, immediately before posting.

## 5. Install path

- [x] `npm install --global github:LiLara-AI/shadowgraph` verified from a clean environment.
- [x] Clone-from-source path verified.
- [x] `setup` → `doctor` → decision → restart → recall → changed fact → review verified end to end.
- [x] `shadowgraph mcp` starts and advertises 12 tools in compact mode.
- [x] Fresh clone of public `main` followed using only the published README.
- [ ] Optional: one other person follows the README cold on a machine you do not control.

## 6. Feedback and support paths

- [x] Issues enabled; bug report and feature request templates present and valid.
- [x] `.github/ISSUE_TEMPLATE/config.yml` present with contact links.
- [x] GitHub Discussions enabled and linked from README and CONTRIBUTING.
- [x] Private vulnerability reporting **enabled** and linked; SECURITY.md tells users never to file
      a public issue for a vulnerability.
- [x] README states what preview feedback is most wanted.
- [x] No telemetry or analytics added.
- [ ] Decide who monitors issues, discussions, and advisories in the first 72 hours after posting.

## 7. Security posture

- [x] AI-assisted independent security review recorded in
      [`SECURITY.md`](../../SECURITY.md#security-review-status): Antigravity Assistant
      (Gemini 3.7 Flash), 2026-08-30, commit `4a5e076`, tree `62c1918e`, PASS, no unresolved
      findings.
- [x] Stated plainly and in the same place that **no human third-party security audit has been
      performed**.
- [x] Secret scanning, push protection, and Dependabot security updates enabled.
- [x] Local threat model documented; HTTP binds `127.0.0.1`; dashboard is read-only and does not
      persist a token.
- [ ] Accept, as maintainer, that an AI-assisted review is the current security evidence, and that
      the announcement says so.

## 8. Publication boundaries — must remain FALSE at launch

These are the things that must **not** happen as part of announcing the preview.

- [x] `private: true` unchanged in `package.json`.
- [x] **No** `npm publish`.
- [x] **No** Git tag created.
- [x] **No** GitHub Release created.
- [x] No cloud service, hosted sync, or telemetry added.
- [x] No product features added during launch preparation.
- [x] Old Git history untouched.
- [ ] Confirm you are not about to run any publish/tag/release command out of habit.

## 9. Privacy cleanup status

- [ ] **GitHub Support privacy cleanup: status unknown / possibly pending.** Track this as a privacy
      housekeeping item, not a product defect. It does not block announcing the Technical Preview,
      and nothing in this launch interferes with the ticket. Confirm its current state before
      announcing, and note that any cached or forked copies of previously public content are outside
      the maintainer's control.

## 10. Post-announcement

- [ ] Watch for install failures in the first 24 hours — that is the highest-signal failure mode.
- [ ] Collect MCP client compatibility reports (client, mode, what was discovered).
- [ ] Do not promise dates for the comparative benchmark or the human security audit.
- [ ] Do not upgrade the label from Technical Preview based on positive feedback alone; the label
      changes only when the [release checklist](../../RELEASE_CHECKLIST.md) gates close.

---

## Known open gates (intentionally not closed)

| Gate | Status |
| --- | --- |
| Actual preregistered comparative benchmark | **Open** — zero arms measured; no comparative claim permitted |
| Human third-party security audit | **Open** — only an AI-assisted review exists |
| npm publication authorization | **Open** — `private: true`, not published |
| Git tag / GitHub Release | **Open** — none created, none authorized |
| GitHub Support privacy cleanup | **Status item** — confirm before announcing |

None of these blocks announcing a Technical Preview. All of them block calling it Beta, Stable, or
Production Ready.
