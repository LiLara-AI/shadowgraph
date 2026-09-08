# Operational provider-budget repair — offline candidate

## Disposition

Hermes owns this benchmark-only repair. No product/plugin change is required by the demonstrated defect, so there is no Codex product handoff. This document supersedes the **operational budget advice** in `v11-hermes-execution-handoff-2026-09-06.md`, not any frozen methodology. The historical document, external scripts, run-002/run-003 evidence and state remain unchanged.

**Owner authorization is granted; execution eligibility remains BLOCKED.** The owner permits verified local benchmark-only commits and one fresh `v11-acceptance-004`, conditional on every prerequisite. The selected Cognee runtime does not satisfy the frozen disabled-native-retries requirement (see the bounded integrity disposition below). No service/precondition probe or acceptance inference was dispatched in this engineering pass. Run-003 remains interrupted and is not resumed.

## Authority and corrections to the post-mortem

- `exactFiniteTotal` was created by external coordinator scripts `shadowgraph-v11-budget-resolution.py:120` and `shadowgraph-v11-budget-resolution-v2.py:27`; the latter wrote the historical budget-resolution record. `shadowgraph-v11-stop-current.py:19` subsequently used it in the stop rationale. It was not a repository launch predicate or a frozen methodology field.
- Amendment 002, `resolvedMethodologyChoices.measuredOperationRetries` (lines 33–38), requires zero measured retries and disabled library defaults. Its `providerMetering` (lines 216–227) requires capture of request counts, identity, available usage, latency and failures. It does **not** require an exact advance forecast of variable native calls.
- The launch error was failure to resolve and enforce an explicit finite operational authorization before dispatch. Treating `exactFiniteTotal:false` itself as a frozen-contract violation was an incorrect explanation. The intentional external SIGTERM remains the recorded interruption cause; no plugin crash is established by that fact.
- The old statement “zero integrity violations” was too strong. The historical completion ledger has no write-ahead attempts or provider-event wall-clock timestamps. Its successful rows do not prove that no request was in flight at termination, no attempt was omitted, or that all retry/state/prompt/model constraints were fully reconciled. No completed run-003 raw/aggregate/reconciliation artifacts exist.

## Four quantities that must not be conflated

| Quantity | Meaning / authority |
|---|---|
| 260 | Deterministic outer-decision **slots**, also declared in Amendment 003. Derived as non-excluded units minus RESET units. An early arm failure may prevent a scheduled outer call; this is not a promise of 260 successes. |
| Native internal/embedding calls | Data-dependent. `ProviderCalls` increments observed calls (`python_runtime.py:145–175`); `require_traffic` means at least one on the branch that invokes it, not exactly one. Cognee's absent-dataset retrieval explicitly makes zero calls (`cognee_adapter.py:499–514`). |
| 264 / 308 / ~320 | Historical handoff lines 280–284 reuse run-002 expected/matched 264 and observed 308 as future-budget guidance, with an approximate ~320 stop heuristic. Neither is a valid authorization for the changed candidate or a forecast for run-003. |
| 588 | Retracted coordinator forecast based on fixed native multiplicities; not a frozen or approved safety ceiling. Do not reinstate it. |
| Finite safety ceilings | Explicit operator-chosen admission limits for **each** of the three request classes. They are not expected call counts, retry allowances, success promises, or reconciliation tolerances. |
| Observed completion rows | Run-003 preserved rows: 64, comprising 43 outer and 21 embedding, all SUCCEEDED. These are recorded terminal events, **not a proven total of upstream attempts**. Partial terminal unit rows: 62, comprising 48 MEASURED, 10 FAILED and 4 EXCLUDED. |

The external script's previous native “minimum” values (44/160) are not adopted as limits or authoritative forecasts. Its Mem0 calculation assumes nine decision phases while Mem0 supports the user-isolation phase; its Cognee calculation treats absent-dataset retrievals as calls. No cap may be silently derived from those assumptions.

## Implemented launch and accounting policy

1. `v11-preflight` and `v11-run` read an explicitly supplied `--provider-budget` JSON file. Missing, malformed, non-finite, retry-enabled or identity-mismatched policy blocks readiness. There is no guessed numeric default and no `exactFiniteTotal` guard to delete.
2. Budget files must explicitly name `--run-id` and `--attempt-id`, an operator authorization reference, the **new** canonical implementation-lock hash, `maxRetries:0`, and finite non-negative safe-integer limits for `outer_decision_llm`, `internal_memory_llm`, and `embedding`.
3. Readiness refuses before runtime binding. Binding independently validates budget identity before runtime discovery; after building the canonical implementation lock it checks the approved hash **before environment observation, directories, meter, hosts or ledgers**. The budget snapshot is cloned/frozen and passed through to execution and the meter.
4. The meter synchronously reserves a class slot before any asynchronous work. Admitted malformed, timed-out and failed requests consume their slots; no refunds. Concurrent calls cannot oversubscribe. The first denied request latches an attempt-wide stop on new admissions. Already admitted in-flight requests remain within the reserved ceilings. A denial is HTTP 403 and a FAILED `PROVIDER_BUDGET_EXHAUSTED` completion, never a silent exclusion or upstream retry.
5. The existing provider completion schema remains unchanged. A new exclusive companion `<provider-ledger>.attempts.ndjson` captures the authorization, timestamped admissions, write-ahead dispatch intents and completion links. Its writes are synchronized before upstream dispatch; an evidence-write failure prevents later dispatch and makes close fail.
6. A dispatch intent is **not proof of provider receipt**: a process can die between journal sync and socket send. An unmatched intent/admission stays incomplete/unknown. Completed, admitted, denied, succeeded, failed and incomplete counts are separate.
7. New-run reconciliation requires the companion ledger as well as existing model/usage/count reconciliation. Missing, malformed, mismatched, failed or incomplete attempt evidence blocks the combined verdict. Legacy historical reconciliation remains readable without inventing historical attempt rows.
8. The generic stand-alone meter API retains its legacy unbudgeted mode for existing non-acceptance callers. The v1.1 acceptance binding never uses that mode. This is an operational acceptance boundary, not an OS-wide egress firewall or protection against a malicious operator changing source code.
9. No measured retry rule is relaxed. Native multiplicity is compared with actual operation counters; it is not automatically a retry. Existing `RETRY_OBSERVED` and `UNEXPECTED_CALL` checks remain. A refusal event may still trigger the existing extra-call code; the attempt journal distinguishes refusal from actual upstream dispatch.

## Final owner-authorized single-run limits

- Owner-authorized aggregate outer ceiling: **260 admitted calls** across all arms, not per arm.
- Owner-authorized single-run native internal-memory ceiling: **256 admitted calls**.
- Owner-authorized single-run embedding ceiling: **1,024 admitted calls**.
- Owner-authorized single-run `maxRetries`: **0**.
- The three acceptance caps sum to **1,540**, but this is NOT a shared pool and NOT a probe-inclusive budget. Probe traffic must be recorded separately. No operational campaign was initialized and no deadline started while the Cognee prerequisite remains unmet. The campaign library supports an immutable absolute deadline, cumulative request/class ceilings and recovery limit; that capability is not a claim that all probe routes are integrated. The final owner authority permits **one acceptance attempt, zero recovery attempts**, one service probe and one precondition probe.
- These native values are discretionary operational stop-losses, not exact forecasts or reconciliation targets. Cognee's native natural multiplicity remains unbounded without an explicit chunk/output cap; the campaign and per-class ceilings therefore remain fail-closed safety limits rather than claims of complete coverage.
- The owner must not treat a ceiling crossing as a product failure: it is a contained diagnostic interruption with preserved attempts and incomplete reconciliation. The campaign policy itself is versioned, identity-bound and immutable after creation.
- The owner explicitly authorized local commits of verified benchmark-only changes. No push, merge, release, tag, or product change is authorized.

A budget is a stop-loss, not permission to alter a failed run after the fact. Never raise a ceiling in a running attempt, reuse a consumed identity, retry measured operations, or relabel a budget-limited run as completed acceptance. A ceiling can halt a healthy but call-heavy native branch; that is an operational interruption, not evidence that the product failed its intended task.

## New candidate identity and remaining gates

The repair was captured as an **uncommitted** benchmark-only changeset based on `50aefb45f835890c02e7bdc4e6c1307eaba5b0d3` before local commit. The old reviewed code pin does not cover these bytes. `package.json` changes only register the new benchmark check/test; the package version is unchanged.

The external evidence directory `~/shadowgraph-v11-run-evidence/budget-repair-offline/` contains the working-copy file-hash manifest, binary diff, preservation audit, test logs and canonical builder refusal. The working-copy manifest is **not** an official implementation lock. The canonical builder's clean-committed-tree requirement is retained. Local-commit permission is now granted; the final external report records the actual commit and builder result, not this pre-commit document.

Required order: complete offline conformance and independent review; commit named verified files; obtain the service identity inputs required by the actual lock builder; create/verify a new implementation lock; bind exact policy/configuration/coordinator bytes; refresh permitted prerequisite evidence and require structured READY plus exit 0. Historical service evidence can supply offline candidate-lock identity inputs, but cannot clear live freshness. The Cognee blocker forbids launching even if shallow CLI gates would pass.

Known Graphiti LB2f and Basic Memory F28 outcomes remain failures, not passes or exclusions. Cognee ACL prerequisites must be demonstrated before dispatch; a known possible failure cannot bypass readiness. Passing operational gates does not guarantee successful seven-arm acceptance.

## Verification and deferred disposition

- Full-worktree gate: the existing `benchmark-v11-definition.test.js` no-results assertion rejects the preserved `benchmark/results/` directory. Retain the historical evidence and the original assertion; neither deleting evidence nor weakening the test is an acceptable route to a green gate. Runtime-specific final counts and command statuses belong in the external closure record.
- Deferred no-results gate disposition: **reason** historical acceptance artifacts exist; **impact** the full-worktree test gate fails; **workaround** focused offline suites can verify the repair but cannot establish a fully green historical worktree; **non-collapse test** retain the original failing guard; **next action** resolve the post-execution testing policy separately without deleting or reinterpreting historical evidence; **decision state** OPEN.
- Review records are snapshot-specific. The external closure record must distinguish completed reviews, unavailable attempts, unchanged reviewed code, and documentation-only deltas. This pre-commit document is not itself proof that a commit, official implementation lock, or live-readiness gate completed.

- Focused offline tests exercised readiness refusal, otherwise-ready budget-only refusal, wiring to the meter, wrong implementation identity, concurrent reservation, failed-call consumption, zero meter retries, cross-class latch, completion/attempt accounting, malformed evidence and missing identity.
- An earlier bounded review identified a P2 admission-correlation omission: missing run/attempt IDs could behave as wildcards. The regression reproduced RECONCILED for a mismatched completion; production validation now requires both fields. The completed independent final changed-surface review (`deleg_b39e5035`) found no P0/P1/P2 findings and issued no live-acceptance verdict. The independent documentation-delta review recorded externally after that review must cover the final wording before staging; no live launch is claimed by either review.
- Native ceilings and local-commit authorization: CLOSED (owner-approved). Actual commit/lock/review evidence is captured externally; authorization is not evidence of completion.

## Bounded Cognee integrity disposition

**BLOCKED: no compliant selected native LLM route has been demonstrated.** The adapter selects Cognee 1.5.3 `litellm_native` and the OpenAI-compatible embedding engine. The pinned `get_native_client.py` factory forwards model, endpoint, fallback fields and `llm_args`, but not the adapter's `max_retries` declaration. `native_adapter.py:250–318` implements a fixed three-attempt JSON self-correction loop; `:401–497` also applies tenacity. `retry_config.py:29–37` hard-codes the outer attempt/time floors. No public configuration disabling the selected JSON loop was found in this bounded source audit. Changing framework/model or vendor code is outside the present authority.

The captured offline injection exercised the configured native client with one malformed structured response per call. It recorded **3 completion invocations**, all `openai/qwen2.5:7b`, with fallback absent and adapter `max_retries:0`. The unchanged assertion required one and exited 1. Docker used `--network none`; the completions were fault-injection test doubles, not live provider requests. Cancellation bounded the outer retry wrapper: the three observed calls demonstrate the inner JSON loop, not three outer retry cycles. Original log: external `004-engineering/cognee-integrity-red.log`.

The selected retrieval call supplies `GRAPH_COMPLETION` and `only_context=True`. Pinned `session_aware_completion.py:361–393` bypasses turn preparation and returns before completion for that flag. This source evidence is not an end-to-end measured retrieval proof; `require_zero` checks after the operation, not before dispatch. No active alternate fallback model was found.

Resource caps do not disable retries, and exact reconciliation cannot retroactively make a retried operation compliant. Earlier scratch prose claiming otherwise is withdrawn. Do not replace this prerequisite with a blanket failed-arm shortcut to obtain a run. **Reason:** selected vendor path has demonstrated self-correction retries and no demonstrated supported off-switch. **Impact:** no eligible 004 acceptance. **Workaround:** stay offline; preserve the diagnostic failure. **Non-collapse evidence:** the one-call injection remains failing, not relaxed to accept three. **Next action:** establish a supported zero-retry control for the pinned path, or seek a separately approved methodology/runtime change. **Decision state:** BLOCKED, not an owner-budget/commit decision.

## Campaign integration scope

The CLI accepts paired `--campaign-policy` and `--campaign-root`, validates supplied policy, and the runtime binding opens the persistent ledger after its implementation lock, validates lock identity, begins a unique session and passes the reservation callback to the meter. This integration is optional for legacy library callers. Stand-alone probe routes are not yet integrated with it; do not claim a complete probe-inclusive execution coordinator. Completing that deployment is deferred behind the substantive Cognee prerequisite. Tests prove the covered seams only, not live readiness.
