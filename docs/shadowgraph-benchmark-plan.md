# ShadowGraph warm-lifecycle benchmark plan

## Authority and frozen state

This document summarizes the machine-readable preregistration in
[`benchmark/preregistration.json`](../benchmark/preregistration.json). The JSON is
normative if this summary and the frozen file ever differ.

- Status: `FROZEN_BEFORE_COMPARATIVE_RESULTS`
- Frozen at: `2026-08-27T15:19:06Z`
- Repository commit recorded at freeze:
  `3e831959ec163f8a78fa852a96f552852c58ce95`
- Frozen SHA-256:
  `738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac`
- Sidecar: [`benchmark/preregistration.sha256`](../benchmark/preregistration.sha256)
- Harness version: `1.0.0`

Do not edit the preregistration or its sidecar after results exist. Any future
change requires an explicit amendment frozen before affected results are
observed. The purpose is a matched warm-lifecycle comparison, not a first-call
microbenchmark.

## Seven fixed arms and dependency pins

Every arm is required for an overall `best` claim.

| Arm id | Display name | Fixed package/build |
| --- | --- | --- |
| `no-memory` | No memory | Control; version `none` |
| `shadowgraph-full` | ShadowGraph Full | Local checkout `shadowgraph-unified-plugin@0.40.0`, mode `full` |
| `shadowgraph-compact` | ShadowGraph Compact | Local checkout `shadowgraph-unified-plugin@0.40.0`, mode `compact` |
| `mem0-oss` | Mem0 OSS | `mem0ai==2.0.19` |
| `graphiti` | Graphiti | `graphiti-core==0.29.3` plus `httpx==0.28.1`; also requires a Neo4j-compatible database |
| `basic-memory` | Basic Memory | `basic-memory==0.23.2` |
| `cognee` | Cognee | `cognee==1.5.3` |

The Python container pin is
`python:3.12.11-slim@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f`.
The complete lock and import commands are in
[`benchmark/competitors.lock.json`](../benchmark/competitors.lock.json).

Cognee may be replaced only after a real pinned install/start attempt fails for
a documented technical reason. The replacement must be a real named product
and must be preregistered in an amendment before its results are observed;
Cognee remains `NOT_MEASURED`. A lexical or handwritten baseline must never be
renamed as a product.

A package install/import probe establishes only that the pinned dependency can
be imported in that probe environment. It is setup evidence, **not** a
benchmark measurement, lifecycle result, product-health result, or performance
win.

## Common execution equality requirements

A comparative value is `MEASURED` only when every measured arm uses the exact
same:

- LLM id and embedding id;
- endpoint build;
- machine;
- scenario and prompt text;
- temperature and token limits;
- three repetitions and their seeds.

The fixed common configuration is:

| Setting | Frozen value |
| --- | --- |
| Repetitions | `3` |
| Seeds | `1729`, `2718`, `31415` |
| Temperature | `0` |
| Maximum input tokens | `8192` |
| Maximum output tokens | `1200` |
| Request timeout | `120000 ms` |
| Retrieval limit | `20` |
| Concurrency | `1` |

Unsupported seed controls are recorded but do not disqualify an arm when every
arm shares the same provider behavior. For each repetition, the seven-arm list
is rotated left by `seed modulo 7`; one scenario is executed at a time. An
unavailable arm is recorded at its scheduled position and receives no score.

No paid or remote inference is permitted. Only an explicitly available local
or documented free endpoint may receive benchmark scenario content. Downloading
competitor packages or images is allowed.

Adapter processes use `shell:false` and inherit only the small cross-platform
runtime environment allowlist needed to start a process; every additional
variable must be declared in that arm's adapter configuration. LLM credentials,
an optional distinct `SHADOWGRAPH_BENCH_EMBEDDING_API_KEY`, endpoint userinfo,
and credential-valued adapter fields are sent only to the bounded adapter and
are recursively replaced with `[REDACTED]` in responses, usage/tool/storage
metadata, logs, stdout/stderr, failure evidence, and recorded commands. Model
ids, credential-free endpoints, executable paths, and non-secret arguments stay
available as evidence.

### Current external blocker

At freeze and in run `20260827T161115Z-no-model`, no common local/free LLM and
embedding endpoint was configured and reachable. Local discovery tried four
endpoints and found zero responders. Therefore all seven arms are
`NOT_MEASURED`, there are zero comparative measurements, and no comparative
ranking is permitted. Dependency imports do not remove this blocker.

## Ten fixed scenarios

All fixture constraints, alternatives, rejection reasons, evidence, risks,
review triggers, changed facts, irrelevant facts, failed attempts, project/user
scopes, and exact prompt data are frozen in the preregistration.

| Scenario | Domain | Fixed task | Expected choice id |
| --- | --- | --- | --- |
| `S01_DATABASE` | database choice | Choose the primary persistence engine for a local-first single-user desktop app that must ship without a separately operated database service. | `sqlite` |
| `S02_DEPLOYMENT` | deployment | Choose a deployment target for a low-traffic API with a hard monthly infrastructure cap and no on-call operator. | `managed-container` |
| `S03_CACHING` | caching | Choose a cache for immutable catalog responses in a single Node process where stale data for more than 60 seconds is unacceptable. | `bounded-memory-cache` |
| `S04_API_ERRORS` | API error handling | Choose the public error contract for an SDK that must remain machine-readable across languages while hiding server internals. | `typed-error-envelope` |
| `S05_MIGRATION` | schema migration | Choose a migration rollout for a large table where writes must continue and rollback must remain possible. | `expand-contract` |
| `S06_AUTH` | authentication | Choose authentication for an internal browser app that must use company identity, MFA, and immediate employee deprovisioning. | `oidc-company-idp` |
| `S07_TESTING` | testing strategy | Choose the primary regression strategy for a deterministic CLI parser with many boundary cases and a small team. | `table-property-tests` |
| `S08_PERFORMANCE` | performance | Choose the first optimization for a read endpoint whose trace shows repeated full-table scans on a selective predicate. | `targeted-index` |
| `S09_CHANGED_CONSTRAINT` | changed deployment constraint | Choose job execution for a nightly deterministic transformation that currently completes in eight minutes and has no external network access. | `scheduled-container-job` |
| `S10_RELEASE_BACKUP` | release and backup | Choose a release backup policy for a local-first desktop app whose user data must survive a bad upgrade and support verified rollback. | `versioned-atomic-backup` |

## Fixed lifecycle phases and probes

One measurement unit is one arm × scenario × repetition × phase/probe. A
complete lifecycle has ten units; all seven arms would produce 2,100 units in a
fully measured run.

| Unit | Fixed purpose |
| --- | --- |
| `A` | Fresh decision using the task, constraints, and evidence. |
| `B` | Restart/new-process recall without putting the Phase A answer in the prompt. |
| `C` | Repeated task without putting the Phase A answer in the prompt. |
| `D_TRUE` | Changed-fact review using the fixed relevant changed fact. |
| `D_FALSE_0` | Irrelevant-fact false-alert probe 1. |
| `D_FALSE_1` | Irrelevant-fact false-alert probe 2. |
| `D_FALSE_2` | Irrelevant-fact false-alert probe 3. |
| `E` | Retry after a grounded failed attempt has already been recorded; failed-attempt details are omitted from the prompt. |
| `ISOLATION_PROJECT` | Probe a different project and require the target scenario not to appear. |
| `ISOLATION_USER` | Probe a different user and require the target scenario not to appear. |

All arms receive the same fixed system prompt and expanded phase template. JSON
placeholders use `JSON.stringify` with the preregistered insertion order and no
whitespace; no arm-specific prompt text may be added. Tool schemas may differ,
but their token and tool-call costs remain part of the arm.

Every response must be exactly one JSON object with these fields:
`decisionId`, `choiceId`, `recalledAlternativeIds`,
`recalledRejectionReasonIds`, `constraintIdsAddressed`, `evidenceIdsCited`,
`riskIdsRecognized`, `reviewTriggerIds`, `changedFactDetected`,
`changedFactId`, `recommendation`, `failedAttemptIdsAvoided`,
`failedAttemptReasonIdsCited`, `memoryProjectId`, and `memoryUserId`.

## Statuses, raw measurements, and exact metric definitions

Allowed statuses are `MEASURED`, `NOT_MEASURED`, `FAILED`, and `EXCLUDED`.
Only a `MEASURED` unit with valid response JSON and persisted-state verification
enters a denominator. Unavailable or failed units receive no points, are never
zero-filled, and are never ranked.

### Raw measurement fields

Every measured unit preserves these fields:

`schemaVersion`, `runId`, `preregistrationSha256`, `harnessVersion`, `armId`,
`competitorVersion`, `status`, `statusReason`, `scenarioId`, `phase`,
`repetition`, `seed`, `startedAt`, `latencyMs`, `request`, `response`, `usage`,
`toolCalls`, `storageBytes`, `cost`, `scores`, and `logs`.

Usage fields are `inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `totalTokens`, and `source`. Cost fields are `currency`,
`amount`, and `source`.

- **Latency:** wall-clock milliseconds from immediately before the arm receives
  the prompt until valid response JSON and all synchronous persistence finish.
- **Storage:** recursive bytes in that arm's isolated persisted-data directory
  after each phase, excluding installations and logs.
- **Tool calls:** every model-requested memory operation; setup, version, and
  health probes are logged separately and excluded.
- **Tokens:** provider usage metadata only. If unavailable, token fields are
  null and no token claim is allowed; output character length is not a proxy.
- **Cost:** provider-reported or deterministic published price for the exact
  model at run time. A local/free endpoint records USD `0` with
  `source=local-free`; unverifiable cost is null.

### Exact efficacy metrics

- **Decision retrieval accuracy:** Phase B is `1` only when `choiceId` exactly
  equals the fixture choice and `decisionId` is non-empty; otherwise `0`.
- **Rejected-alternative recall:** Phase B unique intersection with the two
  fixture alternative ids, divided by `2`.
- **Rejection-reason recall:** Phase B unique intersection with the two fixture
  reason ids, divided by `2`.
- **Changed-fact detection:** `D_TRUE` is `1` only when
  `changedFactDetected=true` and `changedFactId` exactly matches the fixture.
- **False-alert rate:** number of the three `D_FALSE` responses whose
  `changedFactDetected` is true, divided by `3`. Missing, null, or malformed
  output fails the unit; it is not treated as a negative prediction.
- **Failed-attempt avoidance:** Phase E is `1` only when the exact failed-attempt
  id and reason id are present and `choiceId` is not the failed approach.
- **Project isolation:** `1` only when the isolation response contains none of
  the target decision/choice/alternative/failed-attempt ids and persisted-state
  inspection confirms that no target record was copied.
- **User isolation:** the same requirement for the isolation user. A product
  without a user namespace is `NOT_MEASURED` for this metric, not scored zero.
- **Efficacy composite:** arithmetic mean of decision retrieval accuracy,
  rejected-alternative recall, rejection-reason recall, changed-fact detection,
  failed-attempt avoidance, and `1 - false-alert rate`. Isolation and quality
  remain hard gates rather than being diluted into this mean.

Aggregation first averages the three repetitions within each scenario and then
macro-averages the ten scenario means. Paired deltas use only the identical
measured scenario/repetition intersection.

## Fixed decision-quality rubric (no model judge)

Each scenario/repetition is scored `0..16`: eight exact-id criteria, each worth
`0`, `1`, or `2`.

| Criterion | 0 | 1 | 2 |
| --- | --- | --- | --- |
| Constraint fit | No fixture constraint id addressed | One or two addressed | All addressed and `choiceId` equals the fixture choice |
| Evidence quality | No fixture evidence id cited | One cited | All cited |
| Alternative coverage | No fixture alternative id recalled | One recalled | Both recalled |
| Rejection rationale | No fixture reason id recalled | One recalled | Both recalled |
| Risk recognition | No fixture risk id recognized | One recognized | Both recognized |
| Reversibility/review trigger | Fixture trigger absent | Present in Phase A or C only | Present in both A and C |
| Changed-fact response | `D_TRUE` not detected | Exact changed-fact id detected but recommendation empty | Exact id detected and recommendation non-empty |
| Known-failure avoidance | Failed approach repeated or failed id absent | Failed id avoided but reason id absent | Failed id avoided and exact reason id cited |

## Eligibility, equality, ties, wins, and failure handling

An arm is rank-eligible only when all ten scenarios × three repetitions × ten
phases/probes are measured. A genuine lack of user namespace can make only user
isolation `NOT_MEASURED`, but that still blocks every `best` claim.

- Discrete macro-average differences below `0.005` are ties; higher wins except
  false-alert rate, where lower wins.
- Quality differences below `0.10` on the `0..16` mean are ties.
- Token, tool-call, latency, cost, and storage relative differences below `5%`,
  using the larger value as denominator, are ties; lower wins. A null value
  cannot win or tie and blocks claims about that metric.
- A ShadowGraph arm wins an overall pair only if its efficacy composite is at
  least `0.05` higher, decision quality is no more than `0.5` lower, project and
  user isolation equal `1.0` for both arms, false-alert rate is no worse, and
  failed-attempt avoidance is no worse. Economics are reported separately.

A crash, timeout, malformed response, persistence mismatch, data leak, or
missing phase makes that unit `FAILED`; it stays in raw output. No replacement
rerun is allowed. A diagnostic rerun may be logged but cannot be substituted.
Only a process-level infrastructure outage affecting every arm before any
request may restart the entire run, under a new run id.

Allowed exclusion reasons are an exact package/image that cannot install or
start, unavailable required key/service, no common LLM or embedding model,
missing product namespace for the applicable isolation metric, or a platform or
license restriction. Evidence must include the sanitized command, exit code,
log path, version, and reason; credential-bearing command arguments must be
recorded as `[REDACTED]`. Never drop slow/low results, replace a failed
repetition, score unavailable as zero, simulate a named competitor, vary common
configuration by arm, or infer results from documentation.

## Raw-result structure and retained evidence

A comparative `raw-run.json` contains:

- run identity, preregistration hash, harness version, UTC start/end;
- common configuration, sanitized runtime capture, and a credential-free
  capability summary;
- the dependency lock and separate dependency-probe evidence;
- the common-model capability probe;
- one status record for each of the seven arms; and
- the raw measurement array, with no inferred values.

The arm records preserve `armId`, `name`, `status`, `competitorVersion`, the
command with any credential values replaced by `[REDACTED]`, exit code,
sanitized log path, and reason. Deterministic aggregation writes a separate
`aggregate.json` generated from the validated raw run.

The proven run layout is:

```text
benchmark/results/20260827T161115Z/
  run-intent.json
  journal-raw.json
  journal-output.txt
  comparative/
    raw-run.json
    aggregate.json
    logs/capability-probe.json
```

Raw results, logs, and isolated benchmark state are evidence retained in the
working tree but intentionally excluded from the npm package. The package does
include the CLI, benchmark libraries, frozen preregistration and sidecar,
competitor lock, and reproduction docs.

## Run, validation, and aggregation commands

Verify the frozen file before any run:

```bash
sha256sum -c benchmark/preregistration.sha256
npm run benchmark:preflight
```

A real comparative run requires a successful common local/free LLM and
embedding capability probe plus real adapter commands for all seven arms:

```bash
npm run benchmark:run -- \
  --run-id <UTC_RUN_ID> \
  --output benchmark/results/<UTC_RUN_ID>/comparative/raw-run.json \
  --adapter-config <seven-arm-adapter-config.json>
```

Validate and aggregate the proven no-model run:

```bash
npm run benchmark:validate -- \
  --input benchmark/results/20260827T161115Z/comparative/raw-run.json
npm run benchmark:aggregate -- \
  --input benchmark/results/20260827T161115Z/comparative/raw-run.json \
  --output benchmark/results/20260827T161115Z/comparative/aggregate.json
```

Run and validate the independent journal benchmark:

```bash
npm run bench -- \
  --json-out benchmark/results/20260827T161115Z/journal-raw.json \
  --human-out benchmark/results/20260827T161115Z/journal-output.txt
npm run benchmark:journal:validate -- \
  benchmark/results/20260827T161115Z/journal-raw.json
```

Harness and release verification:

```bash
npm run benchmark:test
npm run benchmark:check
npm test
npm run check
npm run check:package
npm pack --dry-run --json
npm audit --omit=dev
git diff --check
git status --short --branch
```

## Marketing gate

The aggregation script applies the frozen thresholds and emits the only allowed
marketing text. With zero measured arms, the word `best` and every equivalent
superiority claim are forbidden. The current generated text is:

> Comparative benchmark infrastructure was executed, but no arm was measured because no common local/free LLM and embedding endpoint was available. No comparative performance, quality, token, cost, or 'best' claim is supported.
