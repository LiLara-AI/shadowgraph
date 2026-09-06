# Hermes execution handoff — ShadowGraph v1.1 non-scored acceptance

**Date:** 2026-09-06
**Audience:** a fresh Hermes session with no access to the conversation that
produced this candidate. Everything needed is here or reachable from a path named
here.

> **Hermes executes and collects evidence. Hermes does not repair.**
> No source, test, methodology, frozen file, lock or amendment may be edited
> under this handoff — see §12. If a gate fails, **stop and report**; do not fix
> it (§13).

---

## 1. Pinned candidate

| | |
|---|---|
| Repository | `C:/benchmark-engineering/worktrees/shadowgraph-v11-acceptance` (WSL: `/mnt/c/benchmark-engineering/worktrees/shadowgraph-v11-acceptance`) |
| Branch | `benchmark/v1.1-nonscored-acceptance` |
| **Pinned code commit** | **`aa5a35fd7918737b9647287c976309f843506b32`** |
| HEAD | the tip of `benchmark/v1.1-nonscored-acceptance`. It is at or ahead of the pinned commit, and **every commit after it is documentation only** |
| Working tree | clean — `git status --porcelain=v1 --untracked-files=all` prints nothing |
| Diff digest | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (the SHA-256 of the empty string, i.e. no diff) |

A document cannot contain its own commit hash, so the *code* is pinned and the
check below proves nothing executable moved after it.

### Verify the checkout before anything else

```bash
cd /mnt/c/benchmark-engineering/worktrees/shadowgraph-v11-acceptance && git status --porcelain=v1 --untracked-files=all | wc -l && git diff HEAD | sha256sum && git merge-base --is-ancestor aa5a35fd7918737b9647287c976309f843506b32 HEAD && echo PINNED-COMMIT-IS-ANCESTOR && git diff --stat aa5a35fd7918737b9647287c976309f843506b32..HEAD -- benchmark/lib benchmark/adapters benchmark/acceptance benchmark/preregistration.json benchmark/preregistration-amendment-001.json benchmark/preregistration-amendment-002.json benchmark/preregistration-amendment-003.json benchmark/preregistration-amendment-004.json src scripts test package.json
```

Expect, in order: `0`; then `e3b0c442…b855`; then `PINNED-COMMIT-IS-ANCESTOR`;
then **no output at all** from the final `git diff --stat` — meaning no code,
test, script, package, lock or methodology file changed after the pinned commit.
**Any other result: stop.**

---

## 2. Immutable locks and methodology hashes

```bash
cd /mnt/c/benchmark-engineering/worktrees/shadowgraph-v11-acceptance && sha256sum benchmark/preregistration.json benchmark/preregistration-amendment-00[1-4].json && sha256sum -c benchmark/preregistration-amendment-004.sha256
```

| File | SHA-256 |
|---|---|
| `benchmark/preregistration.json` | `738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac` |
| `preregistration-amendment-001.json` | `2b209df6ca46a179e332acd4ed0b16a35a089f5c14575dd86353db0dc7249c4a` |
| `preregistration-amendment-002.json` | `08e12eca3f93bd67cfeaf90a2064f91beb240e78a8fd63ed8645da78c0d88f1b` |
| `preregistration-amendment-003.json` | `726de2018584aca399fc27d2bba15585d8b6fb9454bc24083578daed22f0be0a` |
| `preregistration-amendment-004.json` | `b0c3a2553608efb78147a8c1f1ef9af51a7d0eebaa0037ce4ad7b64616b1c5f9` |

The first four are **byte-identical to what run `v11-acceptance-002` recorded**.
Amendment 004 is new and prospective (§3).

### Prompt contract this candidate will execute under

| | |
|---|---|
| `outerPromptBinding.systemSha256` | `99a04ebaca9e0a5cfbbaa818bde326670fad736ef72aff9dfcdadac83469c03a` |
| `outerPromptBinding.responseSchemaSha256` | `fad37bf4a43a6278be3d815f2a606c2c381c391c733a07a5f291754b1d6e0f75` |

The system digest **differs** from run 002's `24010602…d8065` because Amendment
004 added one sentence. The response-schema digest is **unchanged**. A new run's
own artifact records both, so which contract it ran under is always recoverable.
**Runs before and after Amendment 004 are not comparable on
`decisionRetrievalAccuracy`.**

---

## 3. F29 – F38 status

| ID | Status | One line |
|---|---|---|
| **F29** | **Closed** | Basic Memory published `MEASURED 0 bytes` for namespaces holding records; the arm now declares `NOT_AVAILABLE`. LB2c's clearance withdrawn. |
| **F30** | **Closed** | The scorer rewarded absent answers: a null `D_FALSE` probe read as a correct negative, and both isolation gates returned **1 — the best score** — for a probe that returned nothing, while the persisted-state half of the rule was never consulted at all. Fixed; two further fail-opens (`null <= 0.05`, `verified` standing alone without match counters) closed after review. |
| **F31** | **Closed by Amendment 004** | Nothing in the frozen contract said what `decisionId` was for, so a model returning `null` complied with everything it was told and `decisionRetrievalAccuracy` scored 0 for every arm. One sentence now names the field's referent. Prospective only; run 002 is not rescored. |
| **F32** | **Closed** (superseded by F37's fix) | The harness stored each decision response verbatim as record content and replayed it as native context, so every arm that retrieved anything was shown the answer sheet: 64 of 64 nulls in arms with context, 0 of 12 in the control. |
| **F33** | **Open, non-blocking** | The provider-reconciliation verdict never reaches the aggregate; run 002's `DISCREPANT` appears nowhere in `aggregate.json`. Hermes must read the reconciliation artifact directly — see §11. |
| **F34** | **Open, documentation** | `acceptance/definition.json` and `preregistration.json` both use `commonExecution.repetitions` with 2 and 3, and nothing says they are different protocols. Affects no execution. |
| **F35** | **Open, deliberate** | The v1.0 lifecycle's `persistedLeak` is computed with `=== true`, so an absent inspection reads as "no leak". Not fixed, because closing it would restate frozen v1.0 results as a side effect of a v1.1 repair. Does not affect v1.1. |
| **F36** | **Open, reporting** | The corrected 156/132 validity split for run 002 exists only in prose; `aggregate.coverage` counts unit status and reports 204/84. Affects analysis of run 002, not execution. |
| **F37** | **Closed** | Key-based redaction could not reach inside a string, which is Cognee's real retrieve shape — one of the seven required arms would have been shown the answer sheet while the others were clean. The three probe-answer fields are now **never written to a record**, so no shape or encoding can carry them. |
| **F38** | **Closed** | `benchmark:test` was `node --test … && npm run …python`, so a red JS half silently skipped 139 Python tests. Both halves now always run and are reported. |
| **F28** | **Open, owner decision** | Basic Memory's isolation namespace is never registered with the product, so `ISOLATION_PROJECT` fails for that arm. **Expect basic-memory to fail its 4 `ISOLATION_PROJECT` units.** This is known and is not a reason to stop. |
| **LB2f** | **Open, owner decision** | Graphiti's exact group driver is unavailable. **Expect graphiti to fail.** Known; not a reason to stop. |

---

## 4. Verification evidence at this commit

Produced on `aa5a35f` with a clean tree. **Run the two suites separately or via
`npm run benchmark:test`, which now runs both.**

| Gate | Command | Result |
|---|---|---|
| Full repository | `npm test` | **2423 tests — 2308 pass, 0 fail, 115 skipped, 0 todo** |
| Benchmark, both halves | `npm run benchmark:test` | **JS 1187 (1183 pass, 4 skipped, 0 fail) · Python 139 pass** — both reported |
| Node syntax | `npm run benchmark:check`, `npm run check` | PASS |
| Python syntax | `npm run benchmark:check:python` | PASS |
| Package privacy | `npm run check:package` | PASS |
| Package smoke | `npm run smoke:package` | PASS |
| MCP | `npm run check:mcp` | PASS |
| Integrations | `npm run check:integrations` | PASS |
| Mutation testing, cumulative | — | **44 mutants, 44 killed**, 1 recorded equivalent |

**All 115 skips have one cause**, and it is legitimate: Node `v20.20.2` has no
`node:sqlite`, which needs 22.5+. The guard is
`NODE_SQLITE_NOT_APPLICABLE_REASON` in `src/runtime-capabilities.js`. Four of
those 115 fall inside `benchmark:test`. **Zero unexplained skips, zero failures,
zero todos.**

Housekeeping that matters: always invoke Python with `-B`. A stray
`benchmark/adapters/__pycache__/*.pyc` makes `npm run check:package` fail
correctly, because `npm pack` would ship it.

---

## 5. Environment, runtime and service prerequisites

| | |
|---|---|
| Host | Windows 11 with WSL2, distro **Ubuntu-26.04**; the repository is on the Windows filesystem under `/mnt/c` |
| Node | **v20.20.2** at `$HOME/.nvm/versions/node/v20.20.2/bin` — **not on `PATH` by default**; export it in every script |
| Python | `python3` (3.14.x observed). Always `-B` |
| Container runtime | Docker, for the pinned Python image and the two services |
| Pinned Python image | `python:3.12.11-slim@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f` |

### Services (already provisioned; do not recreate or alter)

| Service | Image | Endpoint |
|---|---|---|
| Neo4j | `neo4j:5.20` | `http://127.0.0.1:7474` |
| Ollama | `ollama/ollama:0.33.2` | `http://127.0.0.1:11434` |

Container names: `shadowgraph-v11-neo4j`, `shadowgraph-v11-ollama`.

### Shell gotchas that will otherwise cost you a cycle

- `node` is not on `PATH`; every script must start with
  `export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"`.
- Do not inline `$(...)`, `$VAR` or backticks in `wsl bash -c` from a Windows
  shell — they expand in the **outer** shell. Write a script **file** and run
  `MSYS_NO_PATHCONV=1 wsl bash /mnt/c/.../script.sh`.
- Neo4j HTTP Basic wants `user:password`, not Neo4j's `user/password` form.

---

## 6. Decision-model and embedding-model configuration

**Do not substitute either model.** Swapping the decision model would hide the
null-answer behaviour F32/F37 exist to prevent rather than close it, and F2's
clearance is specific to `qwen2.5:7b`.

| Kind | Model id | Weights digest | Detail |
|---|---|---|---|
| `decision_llm` | **`qwen2.5:7b`** | `sha256:2bada8a7450677000f678be90653b85d364de7db25eb5ea54136ada5f3933730` | qwen2, 7,615,616,512 params, Q4_K_M, ctx 32768 |
| `embedding` | **`nomic-embed-text:v1.5`** | `sha256:970aa74c0a90ef7482477cf803618e776e173c007bf957f635f1015bfcfef0e6` | nomic-bert, 137M params, F16, ctx 2048, dim 768 |

Both are pinned in `benchmark/model-weights.lock.json`. All model traffic goes
through the loopback provider meter, which mints one capability per
(correlation, requestClass); adapters never hold a raw endpoint.

---

## 7. Live preflight — the current blocker

**Readiness today: NOT READY**, on one cause with two remedies. Everything in
§4 is green; what is stale is the *evidence records*, not the services.

```
readiness : NOT READY
blockers  : DECLARED_ISOLATION_PRECONDITION_UNMET (cognee)
            required-service graphiti [neo4j, ollama]
            required-service cognee   [ollama]
findings  : PRECONDITION_EVIDENCE_STALE  observedAt 2026-09-05T09:38:36Z
            SERVICE_EVIDENCE_STALE       observedAt 2026-09-05T09:38:19Z
            maxAgeMs 21600000  (6 hours)
```

**All three blockers are consequences of the six-hour freshness gate.** The
containers are up and answering. Do not read them as service outages, and do not
weaken the gate.

### Step 1 — regenerate service evidence *(live provider traffic)*

```bash
cd /mnt/c/benchmark-engineering/worktrees/shadowgraph-v11-acceptance && node benchmark/cli.mjs v11-service-probe --endpoints benchmark/probe-records/service-endpoints.json
```

`benchmark/probe-records/` is gitignored and `service-endpoints.json` is **not
present** — it must be recreated. `validateEndpoints`
(`benchmark/lib/v11-service-probe.mjs:286-310`) requires `schema`, `version: 1`,
and a non-empty `services[]` where each entry has `name`, `container`, `baseUrl`
and a `kind` of `neo4j` or `openai-compatible`. Optionally
`authEnvironmentVariable` names an environment variable whose value is sent as
HTTP Basic. Write:

```json
{
  "schema": "shadowgraph.v11.service-endpoints",
  "version": 1,
  "services": [
    { "name": "neo4j",  "container": "shadowgraph-v11-neo4j",  "baseUrl": "http://127.0.0.1:7474",  "kind": "neo4j", "authEnvironmentVariable": "SHADOWGRAPH_V11_NEO4J_AUTH" },
    { "name": "ollama", "container": "shadowgraph-v11-ollama", "baseUrl": "http://127.0.0.1:11434", "kind": "openai-compatible" }
  ]
}
```

**The Neo4j credential is held outside the repository** and is supplied through
the environment variable the entry names. `serviceAuthorization`
(`benchmark/cli.mjs:1382`) throws if the named variable is unset, and base64-encodes
its value as HTTP Basic — so it must be in **`user:password`** form, not Neo4j's
`user/password` form. Ask the owner for it; do not invent one, and do not commit
it.

This probe **POSTs to `/v1/chat/completions` and `/v1/embeddings`** — it is live
provider traffic and needs the owner's authorization.

### Step 2 — regenerate precondition evidence *(live traffic + a container)*

```bash
node benchmark/cli.mjs v11-precondition-probe --runtime <runtime-site> --work <writable-root> --llm-endpoint http://127.0.0.1:11434/v1 --embedding-endpoint http://127.0.0.1:11434/v1
```

### Step 3 — re-check readiness *(offline, no traffic)*

```bash
node benchmark/cli.mjs v11-preflight --precondition-evidence benchmark/probe-records/precondition-evidence.json --service-evidence benchmark/probe-records/service-evidence.json
```

**Expect `readiness: "READY"` with an empty `blockers` array.** That is a
prediction, not a result. **If it is anything else, stop and report (§13).**

---

## 8. The acceptance run

Only after §7 step 3 reports READY.

- **Run id: `v11-acceptance-003`.** Never `002`. Attempt id defaults to
  `v11-acceptance-003-attempt-1`.
- **Clean isolated state.** Fresh, empty `--state-root` and
  `--python-state-root` directories. Do not reuse run 002's state roots, and do
  not reuse a partially-run 003 state.
- `benchmark/results/` **must be empty or absent before you start** — a guard in
  the suite fails if a results directory exists, and the runner writes there.

```bash
cd /mnt/c/benchmark-engineering/worktrees/shadowgraph-v11-acceptance && node benchmark/cli.mjs v11-run --run-id v11-acceptance-003 --precondition-evidence benchmark/probe-records/precondition-evidence.json --service-evidence benchmark/probe-records/service-evidence.json --state-root <fresh-node-state> --python-state-root <fresh-python-state> --python-runtime <runtime-site> --adapter-config <adapters.json>
```

Expect roughly **3 hours** wall clock; run 002 took 2h52m for the same shape.

---

## 9. Expected counts under the approved contract

From `benchmark/acceptance/definition.json` and Amendment 003's derivation:

| Quantity | Expected |
|---|---|
| Scenarios × repetitions × arms | 2 × 2 × 7 |
| Seeds | `1729`, `2718` |
| **Total units** | **308** |
| Excluded units | **20** |
| Measured units | **288** |
| RESET units | **28** (24 of them MEASURED in a healthy run; graphiti's 4 are expected to FAIL) |
| Planned outer decision calls | **260** |
| Phases per unit set | `RESET, A, B, C, D_TRUE, D_FALSE_0, D_FALSE_1, D_FALSE_2, E, ISOLATION_PROJECT, ISOLATION_USER` |

**Applicability — `userIsolation` is `NOT_APPLICABLE` (so EXCLUDED) for:**
`no-memory`, `shadowgraph-full`, `shadowgraph-compact`, `basic-memory`,
`graphiti` — 4 units each, 20 total. `mem0-oss` and `cognee` are SUPPORTED.
`persistence` is `NOT_APPLICABLE` for `no-memory` only.

**Request budget:** **264 expected provider calls** across the three request
classes (`outer_decision_llm`, `internal_memory_llm`, `embedding`). Run 002
observed 308 provider events, matched 264, and left 44 unmatched — all cognee
embedding calls. Treat **more than ~320 provider events as a stop condition**
(§10).

**Known expected failures** — these are not reasons to stop: `graphiti` fails
(LB2f), `basic-memory` fails its 4 `ISOLATION_PROJECT` units (F28), and `cognee`
may fail if its backend ACL precondition is unmet.

---

## 10. Stop and failure conditions

**Stop immediately and report, without repairing:**

1. §1 checkout verification does not match exactly.
2. Any hash in §2 does not match.
3. Preflight reports anything other than `READY` at §7 step 3.
4. `git status` is not clean at any point — the tree must never be modified.
5. A results directory or benchmark artifact exists before the run starts.
6. Provider events materially exceed the budget (say, >320) — this indicates
   retry behaviour that the methodology forbids.
7. The run crashes, or `status` is anything but `COMPLETE`.
8. `outerPromptBinding` in the produced raw run is not exactly the two digests
   in §2 — that means the prompt contract drifted mid-run.
9. Any adapter attempts a retry of a *measured* operation. The methodology sets
   `measuredOperationRetries: 0`.

**Not stop conditions** (expected, documented): graphiti failing; basic-memory's
4 `ISOLATION_PROJECT` failures; cognee failing on its precondition; a
`DISCREPANT` provider reconciliation (§11); 20 EXCLUDED units.

---

## 11. Artifacts to preserve, and reconciliation

The runner writes six files to `benchmark/results/`, which is **gitignored** —
they are not committed and will be lost if the directory is cleared:

```
v11-acceptance-003-attempt-1.raw.json
v11-acceptance-003-attempt-1.aggregate.json
v11-acceptance-003-attempt-1.units.ndjson
v11-acceptance-003-attempt-1.progress.ndjson
v11-acceptance-003-attempt-1.provider-requests.ndjson
v11-acceptance-003-attempt-1.provider-reconciliation.json
```

**Immediately on completion**, copy all six outside the repository, checksum
them, and make them read-only — the same treatment run 002 received:

```bash
mkdir -p "$HOME/shadowgraph-v11-run-evidence/run-003-preserved" && cp benchmark/results/v11-acceptance-003-attempt-1.* "$HOME/shadowgraph-v11-run-evidence/run-003-preserved/" && cd "$HOME/shadowgraph-v11-run-evidence/run-003-preserved" && sha256sum v11-acceptance-003-attempt-1.* > SHA256SUMS.txt && chmod 444 * && sha256sum -c SHA256SUMS.txt
```

Run 002 remains preserved and untouched at
`$HOME/shadowgraph-v11-run-evidence/run-002-preserved/` (six files, `chmod 444`,
`SHA256SUMS.txt` verifies). **Never overwrite it.**

### Provider-ledger reconciliation

The reconciliation is produced automatically as
`…provider-reconciliation.json`. **It does not reach `aggregate.json` — that is
F33** — so read the artifact directly and report all of:

- `status` (`RECONCILED` or `DISCREPANT`),
- `totals`: `expectedCalls`, `observedEvents`, `matchedCalls`, `malformedLines`,
  `unverifiedCountUnits`, `unverifiedCountEvents`,
- `findings[]` grouped by `correlation.armId`, `correlation.requestClass` and
  `code` — note the arm is nested under `correlation`, **not** at the top level.

Three distinct quantities are easy to confuse: `unverifiedCountEvents`,
`unverifiedCountUnits`, and the length of `findings[]`. In run 002 they were 44,
84 and 64. Report all three separately.

---

## 12. What Hermes must not do

- **No code, test, methodology, fixture, lock or amendment edits.** Not to make a
  gate pass, not to fix a fixture, not to adjust a threshold. The tree is the
  candidate; changing it invalidates every hash in §2.
- **No model or endpoint substitution**, including "just to see".
- **No re-scoring, re-running or overwriting of run 002.**
- **No scored benchmark, no ranking, no comparative claim** — see §14.
- **No push, publish, release, version bump, or product-version change.**
- **No retry of a measured operation** and no diagnostic rerun substituted for
  measured evidence.
- **No creation or alteration of the provisioned containers.**

---

## 13. If a gate fails: stop, do not repair

Report: the exact command, its full output, the commit (`git rev-parse HEAD`),
and `git status --porcelain=v1 --untracked-files=all`. Then stop.

Preflight failing is the expected outcome until §7 steps 1–2 are authorised and
run. A preflight failure is **not** something to work around: it is the gate
doing its job.

---

## 14. Authorization boundary

This handoff authorizes **one non-scored acceptance run** under
`preregistration-amendment-002.json`'s `candidateAcceptance` block
(`scored: false`, `rankings: false`, `requiredArms: 7`, `repetitions: 2`), plus
the evidence collection around it.

It does **not** authorize a scored benchmark, any ranking, any comparative claim
between arms, or any publication. No arm is rank-eligible under
`winTieRules.eligibility`, which requires 10 scenarios × 3 repetitions; this
protocol is 2 × 2 by design. **Run 002 remains VALID FOR DIAGNOSTICS ONLY**
(`benchmark/evidence/v11-run-002-findings-2026-09-06.md`), and run 003 will need
its own analysis before any claim is made about it.

---

## 15. Reference documents

| Document | Path |
|---|---|
| Run 002 findings | `benchmark/evidence/v11-run-002-findings-2026-09-06.md` |
| Blocker/finding matrix (LB/F rows) | `benchmark/CANDIDATE-STATUS.md` |
| F31 amendment rationale | `benchmark/evidence/v11-f31-amendment-proposal-2026-09-06.md` |
| Amendment 004 (authorized) | `benchmark/preregistration-amendment-004.json` |
| Service readiness and endpoint shape | `benchmark/evidence/v11-service-readiness-2026-09-05.md` |
| Prior engineering handoff | `benchmark/evidence/v11-handoff-2026-09-06.md` |
