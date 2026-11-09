# ShadowGraph decision-memory workflow design

Date: 2026-11-08
Status: Phase 1A implemented; Phase 1B retrieval and scope plan pending

## Purpose

ShadowGraph should help an AI host answer four questions before and during work:

1. What did we decide, and why?
2. What did we already try, and what happened?
3. What should we avoid or reuse now?
4. What changed that could make an old decision wrong?

After work, the host should be able to record the result and connect it to the earlier decision and attempts. A later session should receive the same story without needing the old chat transcript.

The existing record types, local storage, reconsideration rules, and retrieval system remain the foundation. This design improves their public workflow rather than replacing them.

## Confirmed starting point

The current code already provides:

- decisions with chosen options, rejected alternatives, reasons, assumptions, evidence, and reopen rules;
- attempts with result, reason, environment, explicit success/failure classification, and reuse conditions;
- outcomes that affect an auditable confidence history;
- facts with temporal history and deterministic reconsideration;
- project context, search, graph retrieval, scoped recall, and declared result completeness;
- durable local state and journal history.

The main gaps are operational: the recommended compact workflow cannot complete every documented lifecycle step, some useful fields are not advertised, examples can produce invisible failure memories, context is not task-ranked, and real-host mistake avoidance has not been measured.

## Design principles

- **Explicit capture:** the host decides what to record. No conversation watcher or automatic fact extractor is added.
- **No invented explanations:** missing reasons are shown as missing or unknown, never filled in by the server.
- **Current and historical memory stay distinct:** superseded decisions and failed attempts remain available without being presented as current advice.
- **No silent loss or omission:** truncation, unavailable ranking signals, and incomplete records have visible follow-up information.
- **Compatibility while migrating:** old stored data remains readable. Public behavior changes are versioned or added compatibly where possible.
- **Small, measurable slices:** each phase must pass its own acceptance checks before the next phase begins.

## Target operating loop

### Before work

1. The host uses one stable project name and the intended memory scope.
2. It calls `shadowgraph_context` with the project and, once Phase 3 is available, a short task description and environment.
3. It inspects current decisions, rejected alternatives, failed attempts, successful attempts, open reviews, unresolved conditions, and completeness information.
4. It uses `search`, `retrieve`, or `recall` only when it needs a more specific or broader lookup than the working set provides.

The public meanings become:

- `context`: prepare for a task and see what needs attention now.
- `search`: find records using exact words and structured filters.
- `retrieve`: find records and their directly related records.
- `recall`: search scoped memories and history using all available ranking signals.

### During work

1. Record a consequential decision before relying on it, including known assumptions, evidence, rejected alternatives, and durable reopen rules.
2. Record each informative attempt with an explicit result class, what happened, the environment, and the related decision when one exists.
3. Record a reason when known. If it is not known, omit it and accept the visible missing-reason notice rather than inventing one.
4. Use a stable retry key from the first attempt of a logical write. Reuse it only for an exact retry of that same write.
5. Record changed facts using the same keys named by decision reopen rules.

### After work

1. Record the outcome and its supporting attempts or evidence.
2. Record whether the outcome is a new observation or a correction.
3. Replace or update decisions that are no longer current.
4. Run maintenance when time-sensitive facts or decisions may have changed.
5. Resolve reviews with an action and reason. Acknowledgement alone means only “seen”, not “handled”.

## Phase 1: Make the existing workflow correct and self-contained

### 1.1 Correct examples and host instructions

Update the README, decision-memory demo, integration guide, agent policy, MCP prompt, and discovery instructions so they describe the same operating loop.

Every example that writes project data must include its project. Failure examples must include `resultClass: "failed"`; successful examples must use `resultClass: "succeeded"`. Examples must include a reason and environment when those are part of the lesson.

The demo must show a new session discovering a previous failure and changing its plan, not only writing and reading known records. It must also show the final outcome and distinguish review acknowledgement from resolution.

Retry guidance must say to choose a key before the first write. Scope guidance must require the same project and scope on later reads, and warn that a run-scoped memory does not automatically become a cross-run memory.

Documentation must describe per-tool project behavior instead of claiming that every omitted project has the same meaning.

### 1.2 Make compact mode able to finish the workflow

Add the existing decision status update and supersession operations to compact mode. Do not create a second replacement API.

Add `resolve_review` in Phase 2; until then, compact instructions must not imply that acknowledgement resolves the underlying decision.

Descriptions generated for compact mode may name only tools available in compact mode. Full-only routes must be omitted or explicitly labeled as full-only. Add a test that parses every advertised compact route and proves that the call is available.

### 1.3 Advertise supported write fields

Add the existing core fields to the MCP input schemas:

- decision `reviewAfter`;
- attempt `relatedTo` and `reusableWhen`;
- fact `observedAt`, `validFrom`, and `validTo`.

Use one structured condition schema for `reopenWhen` and `reusableWhen`, including the supported keys, operators, expected value, and optional unit. Required operands must be represented in the schema rather than explained only in prose.

Mark fact `value` and alternative `label` as required because runtime writes already require them.

New MCP attempt writes should require `resultClass`. Imported and older stored attempts remain supported through the existing wording fallback. CLI and JavaScript compatibility must be documented explicitly rather than silently changing every interface at once.

### 1.4 Make setup preserve continuity

Setup documentation and examples must make the storage choice explicit:

- project-local storage for memory belonging to one workspace;
- one absolute `SHADOWGRAPH_FILE` for memory shared across working directories.

Copy-ready host configurations must include a clearly marked absolute-path placeholder. `setup` and `doctor` output must print the effective store path so a user can detect accidental fragmentation. Existing stores must not be moved or merged automatically.

### 1.5 Correct public retrieval and error contracts

- Index outcome status and lessons as declared searchable content.
- Either support direct fact content search or narrow the tool promise; the preferred target is direct search over fact keys and lossless textual values.
- Apply caller filters to graph neighbours in `retrieve`, and do not traverse invalid relationships.
- Make project isolation a normal acceptance gate across the existing scope-conformance matrix, including omitted project, selected project, by-ID reads, and cross-project edges.
- Return stable, safe error codes such as `missing_required_field`, `invalid_field`, `unknown_decision`, `illegal_transition`, and `idempotency_conflict`, plus a safe field path and retryability where known. Never echo private values, stored content, filesystem paths, or stack traces.

### 1.6 Phase 1 acceptance checks

- The exact former demo failure appears in `failedAttemptsToAvoid` after its example is corrected.
- A compact host can record, update, and replace a decision without calling an unavailable tool.
- Every newly advertised field survives MCP restart and affects the documented later behavior.
- A cold-start demo uses the same store and project and finds the prior failure with different task wording.
- No compact description routes to an unknown tool.
- The scope-conformance cases run as ordinary production tests with no unexpected cross-project content or identifiers.
- Caller mistakes return distinct corrective errors without leaking supplied values.

## Phase 2: Connect the complete decision story

### 2.1 Link attempts to decisions directly

Add optional `decisionId` to attempt writes. When supplied, it must name an existing decision in the same project. This becomes the normal way to express the basic decision-attempt relationship; generic `link` remains available for additional relationships.

Expose a per-decision history response containing the decision, its attempts, effective outcome, outcome observations, reviews, resolutions, and replacement chain. Existing `failedAttempts` and `relatedTo` data remain readable for compatibility, but new callers should not need to maintain duplicate arrays manually.

### 2.2 Preserve outcome observations and corrections separately

Keep the existing `decision.outcome` as the current effective outcome for compatibility. Add an append-only outcome history for that decision.

Each outcome observation has an ID, status, optional reason, lessons, environment, related attempt IDs, observation time, and provenance. A correction names `correctsOutcomeId`; an observation without that field is a new observation, such as success in staging followed by failure in production.

Only the current effective outcome contributes the decision-level outcome confidence contribution. Corrections replace the corrected observation's effective contribution rather than stacking it. All original snapshots remain in history. Missing reasons remain visibly missing.

### 2.3 Close the review loop

Add `shadowgraph_resolve_review` to compact and full modes. Its inputs are:

- review signal ID;
- action: `keep`, `revise`, `retry`, or `abandon`;
- optional reason, visibly marked missing when omitted;
- resulting decision ID or attempt ID when the action creates or uses one.

The operation validates same-project relationships and does not infer a lifecycle change from acknowledgement. Journal both acknowledgement and resolution as complete post-operation snapshots, and include review signals in journal rebuild so their state and timestamps survive reconstruction.

### 2.4 Prevent retry-key content loss

Persist a canonical fingerprint of the meaningful normalized write with each retry-key entry.

- Same key and same fingerprint: return the original result without another write.
- Same key and different fingerprint: reject with `idempotency_conflict`.
- New logical operation: require a new key.

Apply this to decisions, attempts, memories, and keyed confidence evidence. Fingerprints and their effects must survive restart and journal rebuild.

### 2.5 Phase 2 acceptance checks

- A later session can open one decision and see why it was chosen, every linked attempt, each outcome observation, and any replacement.
- Same-project and cross-project invalid links are handled explicitly.
- Staging success followed by production failure remains two observations; correcting a mistyped status does not create a false second observation.
- Review resolution and acknowledgement both survive ordinary restart and journal-only rebuild.
- An exact retry is deduplicated, while the same key with different content is rejected.

## Phase 3: Make the working set relevant to the task

### 3.1 Extend context rather than adding another wrapper

Add optional `task`, `environment`, and `offset` to `shadowgraph_context`. Keep `limit` and current behavior when `task` is omitted.

When `task` is present, use the existing retrieval machinery to rank current decisions, failed attempts, and successful attempts against the task. Environment contributes to matching and explanations but is not a hard filter. Semantic lookup remains optional; its availability is declared and its absence does not block local text memory.

Add `successfulAttemptsToReuse` as a separate collection. A successful attempt is reusable evidence, not a command to repeat it. Failed attempts remain historical even when their reuse conditions now hold.

Add deterministic paging for context collections and a usable next-page path for every non-zero omission count. Full records remain lossless.

### 3.2 Keep history distinguishable during recall

Add structured `kind`, decision `status`, and attempt `resultClass` filters to recall where applicable. Ensure recent-order requests can use decision and attempt creation times as well as temporal memory timestamps.

Current guidance must outrank superseded guidance in task preparation. Historical records remain retrievable deliberately and are labeled with their status.

### 3.3 Add lightweight capture guidance

Write responses may include advisory notices such as:

- missing rejection reason;
- missing failure or success reason;
- missing explicit result class on legacy interfaces;
- string-form reopen rule that depends on ephemeral `changedFacts` rather than stored facts;
- omitted context items with the exact follow-up page or lookup.

Notices describe capture quality only. They do not create facts, change confidence, or claim verification.

### 3.4 Phase 3 acceptance checks

- A paraphrased task surfaces the relevant prior failure, its reason, and environment.
- A relevant success is surfaced separately from failures.
- A relevant record beyond the old 50-item boundary can be reached deterministically without overlap or duplication.
- Superseded decisions never appear as current guidance.
- Context works without an embedding provider and says which ranking signals were unavailable.
- No advisory notice is treated as stored evidence.

## Phase 4: Prove that memory reduces repeated work

### 4.1 Deterministic cold-start MCP acceptance test

Use the real MCP server and a temporary store:

1. Session A records a decision, rejected alternative and reason, failed attempt, successful attempt, and outcome.
2. Stop the process and reopen the same store.
3. Session B uses a paraphrased task without receiving the old failure details.
4. Assert delivery of the correct failure and reason, separate delivery of the success, current-decision precedence, and no cross-project leakage.
5. Change the relevant facts and verify reconsideration and conservative attempt-reuse behavior.

### 4.2 Real-host evaluation

Run three scenarios with three seeds each, comparing compact ShadowGraph with a no-memory control. Each scenario has two genuinely separate host sessions:

- Session A performs work, encounters a known failure, and chooses what to record.
- Session B receives a paraphrased task without the failure details and chooses its own memory calls and actions.

Measure separately:

- capture rate for decisions, attempts, results, and reasons;
- retrieval rate for the relevant prior records;
- avoidance rate based on the final choice and actual action/tool trace;
- correct reuse of successful prior work;
- correct reconsideration after changed conditions;
- unintended duplicate rate;
- tool calls, returned bytes, elapsed time, and provider tokens where available.

Report every scenario and seed. Do not hide a catastrophic repeated failure inside an average, and do not claim time, token, or quality improvement until measured.

### 4.3 Standard implementation verification

Each implementation slice must pass the project checks covering its changed surfaces, ending with:

```bash
npm run check
npm test
npm run check:integrations
npm run check:mcp
npm run check:package
npm run smoke:package
```

The cold-start MCP test and scope-conformance matrix must pass on the final deliverable, not only on an intermediate patch. Any pre-existing unrelated failure must be reported separately rather than presented as a pass.

## Components and boundaries

- `src/shadowgraph.js`: domain validation, decision/attempt/outcome history, review resolution, and context assembly.
- `src/mcp-tools.js`: public tool schemas, compact membership, descriptions, and result contracts.
- `src/mcp.js`: dispatch, safe error translation, persistence, and discoverable operating instructions.
- `src/hybrid-search.js`: task ranking, structured filters, and signal explanations.
- `src/journal.js` and storage modules: retry fingerprints and replayable review state; no storage-engine replacement.
- `integrations/` and user documentation: one consistent setup and operating loop.
- Existing tests and evaluation scripts: contract, cold-start, isolation, and real-host evidence.

Each phase should use the existing module boundaries. No new memory type, hosted service, background watcher, or automatic extractor is required.

## Error and privacy behavior

- Validation errors identify only safe field paths and stable codes.
- Unknown or conflicting evidence never becomes permission to retry a failed approach.
- Missing reasons remain unknown; the server never fabricates them.
- Project and exact memory scope apply to both direct hits and graph neighbours.
- Setup never moves, merges, or deletes existing stores.
- No private memory is sent to an external service by this design. Optional embeddings remain subject to the existing remote-embedding opt-in.

## Compatibility and migration

- Existing stores and older record schemas remain importable.
- Existing wording-based failure classification remains only for legacy records and interfaces that have not yet migrated.
- Existing `decision.outcome` remains the effective current outcome while detailed history is added.
- Existing acknowledgement remains valid and distinct from resolution.
- New fields and collections are additive where possible. Required-field changes to MCP writes and any changed result shapes must be called out in release notes and compatibility tests.
- No automatic content-based merging of possible duplicate decisions is introduced.

## Delivery order

Phase 1 is the first implementation slice. Phase 2 starts only after the compact workflow and retrieval contracts are corrected. Phase 3 follows once the connected history exists to rank. Phase 4 supplies product-level evidence and may begin its deterministic test alongside the relevant earlier phase, but the real-host evaluation should judge the integrated result.

## Non-goals

- Automatic transcript capture or background watching.
- Cloud storage, hosted sync, or a new account system.
- Automatic merging of similar decisions.
- Treating confidence or provenance labels as proof of truth.
- Claiming that ShadowGraph saves time or tokens before the real-host evaluation measures it.

## Final acceptance outcome

The design is successful when a fresh AI host session, using the same store and project, can discover what was previously decided, what failed and why, what succeeded and why, and what changed; then avoid repeating the old failure without suppressing legitimate reconsideration. The host must also be able to record the new result and resolution so the next session receives the complete updated story.
