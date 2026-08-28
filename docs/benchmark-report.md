# ShadowGraph benchmark report

**Evidence set:** frozen preregistration plus raw run<br>
`benchmark/results/20260827T161115Z/`<br>
**Comparative run id:** `20260827T161115Z-no-model`<br>
**Journal raw generated:** `2026-08-27T16:21:36.964Z`

## Scope and evidence discipline

This report uses only these raw artifacts:

- `benchmark/preregistration.json`
- `benchmark/preregistration.sha256`
- `benchmark/competitors.lock.json`
- `benchmark/results/20260827T161115Z/run-intent.json`
- `benchmark/results/20260827T161115Z/comparative/raw-run.json`
- `benchmark/results/20260827T161115Z/comparative/aggregate.json`
- `benchmark/results/20260827T161115Z/comparative/logs/capability-probe.json`
- `benchmark/results/20260827T161115Z/journal-raw.json`
- `benchmark/results/20260827T161115Z/journal-output.txt`

The comparative lifecycle and the local journal benchmark are different
evidence. The journal run measures ShadowGraph journal rebuild/persistence on one
machine; it is not evidence about any competitor. Dependency install/import
probes are capability setup evidence only and are not lifecycle, quality,
economics, or performance measurements.

## Frozen preregistration

| Field | Exact value |
| --- | --- |
| Status | `FROZEN_BEFORE_COMPARATIVE_RESULTS` |
| Frozen at | `2026-08-27T15:19:06Z` |
| Repository commit at freeze | `3e831959ec163f8a78fa852a96f552852c58ce95` |
| SHA-256 | `738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac` |
| Arms | `7` |
| Scenarios | `10` |
| Repetitions | `3` |
| Seeds | `1729`, `2718`, `31415` |
| Phases/probes per lifecycle | `10` |
| Fully measured unit count | `2100` |
| Temperature | `0` |
| Input/output limits | `8192` / `1200` tokens |
| Retrieval limit / concurrency | `20` / `1` |

The SHA-256 matches the sidecar, comparative raw run, and aggregate. Neither the
preregistration nor its sidecar was changed for this report.

## Exact captured environment

The comparative raw run started `2026-08-27T16:11:42.008Z` and finished
`2026-08-27T16:11:42.549Z`.

| Field | Captured value |
| --- | --- |
| Node | `v24.18.0` |
| npm | `11.9.0` |
| Python | `Python 3.11.15` |
| pip | `pip 26.2.1 from a local virtual-environment site-packages directory (absolute path redacted; python 3.11)` |
| Node platform / architecture | `win32` / `x64` |
| OS | `Windows_NT 10.0.26200` |
| CPU | `Intel(R) Core(TM) Ultra 9 185H` |
| Logical CPU count | `22` |
| Total memory | `68201287680` bytes |
| Git commit captured by run | `3e831959ec163f8a78fa852a96f552852c58ce95` |
| Git dirty at run | `true` |
| Docker client | `29.6.2`, API `1.55`, `windows/amd64` |
| Docker server | `29.6.2`, API `1.55`, `linux/amd64`, kernel `6.18.33.2-microsoft-standard-WSL2` |
| Docker Desktop | `4.85.0 (235549)` |
| Python image pin | `python:3.12.11-slim@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f` |
| Common LLM id | `null` |
| Common embedding id | `null` |

The journal raw records the same Node, platform, architecture, OS, CPU, logical
CPU count, and total-memory values. It ran each requested size in a fresh
process and used five rebuild runs at 1,000 and 10,000 entries and three at
100,000 entries.

## Dependency probes only — explicitly not performance evidence

This tracked report records only sanitized status from the local dependency
probes. Those status notes do not show that an arm completed the preregistered
lifecycle, that all required services were available, or that one product beat
another.

| Arm | Exact pin | Tracked sanitized status | Qualification |
| --- | --- | --- | --- |
| Mem0 OSS | `mem0ai==2.0.19` | Import status reports version `2.0.19` | Import probe only; no benchmark measurement. |
| Graphiti | `graphiti-core==0.29.3` + `httpx==0.28.1` | Sanitized status records version `0.29.3` after adding the fixed support package | The sanitized lock metadata records the initial `httpx` import issue and the successful fixed-support import. No benchmark measurement. |
| Basic Memory | `basic-memory==0.23.2` | Import status reports version `0.23.2` | Import probe only; no benchmark measurement. |
| Cognee | `cognee==1.5.3` | Import status reports version `1.5.3` | Sanitized status records `comparativeMeasurement: false`. |

Raw install/probe logs under `benchmark/results/20260827T153024Z/logs/` are
local ignored files: they are not source-controlled and are intentionally
excluded from the npm package. This report and `benchmark/competitors.lock.json`
retain only sanitized status and pin metadata.

## Comparative lifecycle result: all seven arms

The capability probe recorded:

- `commonModelAvailable: false`;
- configured credentials: `0`;
- configured endpoints: `0`;
- configured models: `0`;
- local discovery attempts: `4`;
- responding local endpoints: `0`;
- LLM configured/reachable/compatible: `false/false/false`;
- embedding configured/reachable/compatible: `false/false/false`.

Every arm was recorded at the same preregistered preflight boundary with exit
code `2` and reason `No common local/free LLM and embedding endpoint was
available.`

| Arm id | Display name | Version | Status | Measured values |
| --- | --- | --- | --- | --- |
| `no-memory` | No memory | `none` | `NOT_MEASURED` | None |
| `shadowgraph-full` | ShadowGraph Full | `0.40.0` | `NOT_MEASURED` | None |
| `shadowgraph-compact` | ShadowGraph Compact | `0.40.0` | `NOT_MEASURED` | None |
| `mem0-oss` | Mem0 OSS | `2.0.19` | `NOT_MEASURED` | None |
| `graphiti` | Graphiti | `0.29.3` | `NOT_MEASURED` | None |
| `basic-memory` | Basic Memory | `0.23.2` | `NOT_MEASURED` | None |
| `cognee` | Cognee | `1.5.3` | `NOT_MEASURED` | None |

### Exact comparative validation and aggregation counts

| Count | Exact value |
| --- | ---: |
| Total arms | 7 |
| `MEASURED` arms | 0 |
| `NOT_MEASURED` arms | 7 |
| `FAILED` arms | 0 |
| `EXCLUDED` arms | 0 |
| Raw measurements | 0 |
| Rank-eligible arms | 0 |
| Aggregate arm results | 0 |
| `bestClaimAllowed` | `false` |

`benchmark:validate` accepts this as a valid no-common-model record because all
seven arms are present, every arm has the same exact `NOT_MEASURED` reason, and
no comparative values or scores were inferred. Validity of the record does not
turn absence into a measurement.

## Measured ShadowGraph journal results

These are local ShadowGraph journal/rebuild/backend measurements, not seven-arm
comparative results. Total wall time across the three fresh size processes was
`98971.39 ms`.

| Entries | Decisions | Facts | Rebuild runs | Rebuild p50 (ms) | Rebuild p95 (ms) | Wall (ms) | Journal bytes | Projection bytes | JSON bytes | SQLite bytes | Sampled RSS proxy bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 200 | 200 | 5 | 0.903 | 7.948 | 189.827 | 1,719,568 | 514,168 | 3,734,922 | 3,760,128 | 98,439,168 |
| 10,000 | 2,000 | 2,000 | 5 | 10.43 | 18.03 | 1,454.577 | 17,229,569 | 5,151,168 | 37,393,124 | 36,888,576 | 322,953,216 |
| 100,000 | 20,000 | 20,000 | 3 | 85.493 | 103.532 | 96,854.631 | 172,635,570 | 51,611,168 | 374,389,126 | 368,717,824 | 2,992,775,168 |

`Sampled RSS proxy bytes` is `process.memoryUsage().rss` sampled at deterministic
phase boundaries. It is `peakSampledBytes`, not a continuously observed peak.

### Backend latency and round-trip evidence

| Entries | JSON save (ms) | JSON load (ms) | SQLite save (ms) | SQLite load (ms) | JSON actual entries | SQLite actual entries |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 24.644 | 9.191 | 19.786 | 9.166 | 1,000 | 1,000 |
| 10,000 | 109.812 | 78.273 | 269.037 | 87.153 | 10,000 | 10,000 |
| 100,000 | 977.414 | 881.032 | 2,425.679 | 1,085.048 | 100,000 | 100,000 |

### Validation, equivalence, and thresholds

Journal validation is `PASS`: `valid=true`, three requested sizes, three
measured sizes, and zero validation errors.

For all three sizes:

- `actualEntries` equals `requestedEntries`;
- rebuild applied the exact entry count;
- canonical rebuild equivalence is true;
- record, fact, and relation component equivalence are each true;
- JSON round-trip equivalence is true; and
- SQLite round-trip equivalence is true after the database is closed and its
  final file footprint is measured.

| Preregistered trigger | Trigger value | Measured value | Breached |
| --- | ---: | ---: | --- |
| Rebuild p95 at 10,000 entries | `> 250 ms` | `18.03 ms` | No |
| Rebuild p95 at 100,000 entries | `> 1000 ms` | `103.532 ms` | No |
| Journal/projection ratio at 10,000 entries | `> 10` | `3.345` | No |

The raw verdict contains zero breaches and states:
`No pre-declared threshold was breached. Snapshots/compaction stay DEFERRED BY
MEASUREMENT, not by guess.`

## Proven vs. not measured

### Supported by retained raw evidence or tracked sanitized status

- The preregistration hash and sidecar match the required frozen SHA-256.
- The raw comparative record contains exactly seven preregistered arms, with
  zero measured arms, seven `NOT_MEASURED` arms, and zero measurement rows.
- The tracked sanitized dependency status records four successful import probes,
  with Graphiti requiring the separately pinned `httpx==0.28.1` support package;
  ignored raw install logs are not claimed as tracked evidence.
- The local journal benchmark measured 1,000, 10,000, and 100,000 entries.
- All three rebuilds and both backend round trips were canonically equivalent.
- Journal validation passed `3/3`; no preregistered journal threshold was
  breached.

### `NOT_MEASURED`

- Comparative decision retrieval accuracy, alternative recall, rejection-reason
  recall, changed-fact detection, false-alert rate, failed-attempt avoidance,
  project isolation, and user isolation for every arm.
- Comparative fixed-rubric decision quality for every arm.
- Comparative lifecycle tokens, tool calls, latency, cost, and storage for every
  arm.
- Every pairwise comparison, ranking, win, tie, and overall-superiority claim.
- Any conclusion that dependency import success predicts end-to-end behavior or
  performance.

## Limitations

1. No common local/free LLM and embedding endpoint existed, so the comparative
   harness stopped before any arm received scenario content.
2. The journal benchmark is machine- and build-specific and has no competitor
   control arm.
3. Timings are a small fixed sample: five rebuilds at 1k/10k and three at 100k.
4. RSS is sampled only at deterministic boundaries and can miss a higher
   between-sample peak; `resourceUsage().maxRSS` is also retained in raw data but
   is not substituted for the declared sampled-process-RSS metric.
5. Backend bytes are final local files after the persistence cycle; they do not
   include package/image/runtime installation or logs.
6. The repository was dirty during capture. The raw run preserves its commit and
   dirty-path list; reproduction must capture a new commit/tree and dirty state.
7. No remote or paid inference was attempted, in accordance with the frozen
   network policy.

## Reproduction and validation commands

Verify the preregistration:

```bash
sha256sum -c benchmark/preregistration.sha256
```

Validate the retained journal and comparative raw files, then regenerate the
aggregate deterministically:

```bash
npm run benchmark:journal:validate -- \
  benchmark/results/20260827T161115Z/journal-raw.json
npm run benchmark:validate -- \
  --input benchmark/results/20260827T161115Z/comparative/raw-run.json
npm run benchmark:aggregate -- \
  --input benchmark/results/20260827T161115Z/comparative/raw-run.json \
  --output benchmark/results/20260827T161115Z/comparative/aggregate.json
```

The journal command recorded before execution was:

```bash
npm run bench -- \
  --json-out benchmark/results/20260827T161115Z/journal-raw.json \
  --human-out benchmark/results/20260827T161115Z/journal-output.txt
```

Run all local harness and release checks:

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

A future real comparative run must first expose one policy-allowed common
local/free LLM and embedding endpoint and provide real seven-arm adapter
commands. It must retain the exact frozen configuration and write a new run id;
the current no-model raw file must not be overwritten.

## Only allowed marketing text

The deterministic aggregate sets `bestClaimAllowed=false`. The word `best` and
equivalent overall-superiority language are prohibited for this result. The
only preregistered marketing text allowed for the current evidence is:

> Comparative benchmark infrastructure was executed, but no arm was measured because no common local/free LLM and embedding endpoint was available. No comparative performance, quality, token, cost, or 'best' claim is supported.
