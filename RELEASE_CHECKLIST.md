# Release checklist — ShadowGraph 0.40.0 pre-Beta candidate

No publish, tag, GitHub release, commit, push, or release-branch action is part of this checklist run.

## Current publication decision

- [x] Package and lockfile use the identical name/version: `shadowgraph-unified-plugin@0.40.0`.
- [x] The exact name was syntactically accepted by `npm pack` and the live registry returned HTTP 404 / npm `E404` on 2026-08-27.
- [x] Recheck the exact registry name immediately before publication; the 404 is evidence at one point in time, not a reservation.
- [x] Keep `"private": true` and retain non-Beta status while independent security review and actual preregistered comparative measurement remain open. The valid zero-measurement run and local journal benchmark do not satisfy those gates.
- [ ] After every remaining gate is approved, change `private` to `false`, regenerate/verify the lockfile, rerun every command below, inspect the real tarball, then obtain explicit publish authorization.

## Technical gates

- [ ] `npm ci`
- [ ] Verify `benchmark/preregistration.json` still hashes to `738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac` and matches its sidecar.
- [ ] `npm run benchmark:journal:validate -- benchmark/results/20260827T161115Z/journal-raw.json`
- [ ] `npm run benchmark:validate -- --input benchmark/results/20260827T161115Z/comparative/raw-run.json`
- [ ] `npm run benchmark:aggregate -- --input benchmark/results/20260827T161115Z/comparative/raw-run.json --output benchmark/results/20260827T161115Z/comparative/aggregate.json`
- [ ] `npm run benchmark:test`
- [ ] `npm run benchmark:check`
- [ ] `npm test` with no failures, skipped tests, todos, or weakened coverage
- [ ] `npm run check`
- [ ] `npm run check:integrations`
- [ ] `npm run check:mcp` (strict official Inspector, full and compact)
- [ ] `npm audit --omit=dev`
- [ ] `npm run check:package`
- [ ] `npm pack --dry-run --json`; inspect every path and exact count
- [ ] `npm run smoke:package`; confirm real pack/install under a clean path containing spaces and cleanup
- [ ] Windows Node 20/22/24 matrix green; SQLite gates only where `node:sqlite` exists
- [ ] Linux Node 20/22/24 matrix green; SQLite gates only where `node:sqlite` exists
- [ ] `git diff --check`
- [ ] `git status --short --branch`; review every intended/unrelated dirty path before any commit

## Artifact policy

- [x] Allowlist runtime source, dashboard, user docs, integrations, and release notes.
- [x] Include benchmark CLI/libraries, the frozen preregistration and SHA-256 sidecar, competitor lock, and benchmark plan/report needed to reproduce and interpret results.
- [x] Exclude `benchmark/results/**`, benchmark logs/raw isolated state, `test/`, `.github/`, package-manager caches, DB/SQLite files, `.shadowgraph/`, local agent state, coverage, compiled Python, handoff/planning material, and `RELEASE_CHECKLIST.md` itself.
- [x] Include copy-ready Claude Code, Cursor, Codex, and Hermes MCP configuration with compact mode recommended and full mode documented.
- [x] Include `shadowgraph setup`, `shadowgraph doctor`, installed CLI/MCP/HTTP smoke coverage, and actionable storage errors.
- [x] Document logical versus hard purge and the external Markdown-copy deletion boundary.
- [x] Document that the dashboard is local-only, same-origin, read-only, and does not persist an entered API token.

## Remaining non-technical release gates — intentionally not performed here

- [ ] **Independent security review.** Record reviewer, scope, commit/tree hash, findings, accepted risk, and remediation verification. Do not replace this with self-review or `npm audit`.
- [ ] **Actual preregistered benchmark comparison.** The retained record is valid but has `MEASURED=0`, `NOT_MEASURED=7`, and `measurements=0` because no common local/free LLM and embedding endpoint existed. Run all seven arms under the frozen equal-configuration rules, retain raw outputs, validate/aggregate them, and obtain independent interpretation. Dependency import probes and the local journal benchmark do not satisfy this gate. Until then, `best` and equivalent overall-superiority wording are prohibited.
- [ ] Maintainer signs off on public-beta wording, package ownership/access, provenance, and support contact.
- [ ] Explicit authorization to remove `private`, publish npm, create a Git tag, and create a GitHub release.

## Publication-day commands (only after all gates are checked)

```bash
npm view shadowgraph-unified-plugin name version dist-tags --json
npm ci
npm run benchmark:journal:validate -- benchmark/results/20260827T161115Z/journal-raw.json
npm run benchmark:validate -- --input benchmark/results/20260827T161115Z/comparative/raw-run.json
npm run benchmark:aggregate -- --input benchmark/results/20260827T161115Z/comparative/raw-run.json --output benchmark/results/20260827T161115Z/comparative/aggregate.json
npm run benchmark:test
npm run benchmark:check
npm test
npm run check
npm run check:integrations
npm run check:mcp
npm audit --omit=dev
npm run check:package
npm pack --dry-run --json
npm run smoke:package
git diff --check
git status --short --branch
```

Do not run `npm publish`, create a tag, or create a GitHub release without the explicit authorization gate above.
