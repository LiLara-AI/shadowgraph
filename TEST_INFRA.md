# ShadowGraph E2E Test Infrastructure

## 1. Overview & Architecture

The E2E Test Suite (`test/e2e-mcp-disambiguation.test.js`) provides an opaque-box, requirement-driven verification track for ShadowGraph's Model Context Protocol (MCP) server, Command-Line Interface (CLI), and public core engine.

### Core Architectural Principles

- **Opaque-Box Boundary Integrity**:
  Tests interact exclusively through official public entry points:
  1. **MCP stdio JSON-RPC protocol** via `node src/mcp.js` (exercising protocol handshakes, `tools/list`, `tools/call`, structured outputs, and JSON-RPC error frames).
  2. **CLI execution** via `node src/cli.js` (exercising operator commands, argument parsing, JSON feedback, help switches, and exit codes).
  3. **Public API exports** defined in `package.json` (`src/shadowgraph.js` and `src/mcp-tools.js`).
  *No tests reach into private engine internals or bypass process boundaries.*

- **Process & Filesystem Isolation**:
  Each test harness invocation allocates a unique scratch directory via `tools/scratch-directory.js`, isolated `SHADOWGRAPH_FILE` stores, and distinct `SHADOWGRAPH_HOME` roots. All subprocesses are monitored and guaranteed to be terminated cleanly via Node's `t.after()` lifecycle hooks.

- **Progressive Testability**:
  Tests verify functionality as milestones land without requiring unmerged future code to pass premature assertions. Feature capabilities are detected dynamically so that:
  - Completed and current milestone features (M1) are aggressively asserted.
  - Future milestone features (M2, M3, M4) report standard skipped milestones (`t.skip('Pending Milestone Mx: ...')`).
  - As workers merge features, tests automatically transition from skipped to strictly asserted without requiring test restructuring.

- **3-Profile Invariant Verification**:
  Guarantees tool counts and schemas remain strictly invariant across:
  - **Full Profile**: 35 tools (36 when verifier is configured).
  - **Compact Profile**: 16 tools (`SHADOWGRAPH_MCP_COMPACT=1`).
  - **Workflow Profile**: 20 tools (`SHADOWGRAPH_MCP_PROFILE=workflow`).

---

## 2. The 4-Tier Test Taxonomy

The test suite is structured into 4 distinct tiers:

### Tier 1: Feature Coverage (Happy Path)
Verifies each feature defined in `PROJECT.md` § Feature Inventory:
- **Feature 1**: `shadowgraph_record_attempt` input schema (`reusableWhen`, `relatedTo`, `task`, `tags`, `visibility`) and output schema fields.
- **Feature 2**: `shadowgraph_record_decision` input schema (`status`, `supersedes`, `reviewAfter`, `failedAttempts`, `reason`, `changeSummary`, `task`, `tags`, `visibility`) and record fields.
- **Feature 3**: `shadowgraph_record_outcome` schema and top-level aliases (`autoTransition`, `decisionStatus`, `lifecycleStatus`) and automatic decision lifecycle transition.
- **Feature 4**: `shadowgraph_recall` input schema (`includeHistory`, `includeCrossProject`, `expandSynonyms`) and hit schema (`historyChain`).
- **Feature 5**: `shadowgraph_context` input schema (`includeCrossProject`) and enriched `advisoryItemSchema` fields.
- **Feature 6**: `shadowgraph_remember`, `shadowgraph_record_fact`, and `shadowgraph_supersede` schema enhancements (visibility, backfill with timestamps, required value enforcement, reason, changeSummary).
- **Feature 7**: `shadowgraph_search` and `shadowgraph_retrieve` input schema (`matchMode`: `'all' | 'partial' | 'any'`, `expandSynonyms`) and hit metadata.
- **Feature 8**: 3-Profile inventory invariant (16 Compact, 20 Workflow, 35 Full / 36 with verifier).
- **Feature 9**: Tool description alignment (Arabic stemming, partial match fallback, symbolic operators, outcome lifecycle side-effects).
- **Feature 10**: Condition normalization aliases (`target` for `key`, `expected` for `value`).
- **Feature 11**: Safe AI error recovery (sanitized domain messages, absolute path redaction).
- **Feature 12**: Profile-hidden tool guidance (code -32601 and active profile guidance when Full tools are called under Compact/Workflow).
- **Feature 13**: Follow-up project defaulting across all 8 follow-up tools.
- **Feature 14**: Parameter alias `reviewSignalId` accepted for `id` in `shadowgraph_ack_review`.
- **Feature 15**: Human CLI ergonomics (`shadowgraph --help`, `-h`, `help` exit 0, syntax error feedback, workflow doctor documentation).
- **Feature 16**: Wire budget measurement across compact, workflow, and full profiles with ~2% headroom.
- **Feature 17**: Visual documentation verification (Mermaid diagrams in `README.md`, `docs/mcp-compatibility.md`, and `integrations/agent-policy.md`).

### Tier 2: Boundary & Corner Cases (Adversarial Verification)
Adversarial verification of system robustness and strict contract compliance:
- **T2.1**: Enforcement of `value` as required on `shadowgraph_record_fact` (empty or missing value rejected).
- **T2.2**: Conflict rejection on `shadowgraph_ack_review` when both `id` and `reviewSignalId` are provided with conflicting values.
- **T2.3**: Conflict rejection on condition normalization when `key`/`target` or `value`/`expected` conflict.
- **T2.4**: CLI JSON parse error feedback on malformed arguments without raw stack traces.
- **T2.5**: Error isolation when invalid `matchMode` is supplied to `shadowgraph_search` (server remains responsive).
- **T2.6**: Empty and whitespace search queries apply filters only without throwing errors.
- **T2.7**: Safe error sanitization across filesystem boundaries (paths and internal structures remain protected).
- **T2.8**: Paging boundary enforcement (limits 0 or >1000 rejected rather than silently clamped).

### Tier 3: Cross-Feature Combinations
Complex interactions combining multiple features:
- **T3.1**: Attempt with `reusableWhen` + Decision referencing failed attempt + Outcome with `autoTransition: true` + Follow-up project defaulting on subsequent actions.
- **T3.2**: Cross-project fact backfill + Cross-project recall (`includeCrossProject: true`, `includeHistory: true`) + Context advisory surfacing `sourceProject` and `reusableNow`.
- **T3.3**: Multi-lingual search with Arabic query terms (`محاوله` / `تجربه`) + `matchMode: 'partial'` across records created with various `tags`, `task`, and `visibility`.
- **T3.4**: Reopen condition with `target`/`expected` aliases + symbolic operator (`>=`) -> review signal generation -> `ack_review` via `reviewSignalId` alias.

### Tier 4: Real-World Application Scenarios
End-to-end agent decision-making workflows:
- **Scenario A (Autonomous Migration Lifecycle)**:
  Agent records proposed architectural decision -> executes attempt with task, tags, visibility, and reusable conditions -> records validated outcome with top-level `autoTransition: true` -> subsequent agent inspects advisory context across projects.
- **Scenario B (Policy Drift & Review Loop)**:
  Baseline compliance facts established -> policy decision conditioned on thresholds using symbolic operators -> environment changes triggering rule trip -> sentinel evaluates review signals -> security officer acknowledges signal using `reviewSignalId`.
- **Scenario C (Profile Navigation & Safe Error Recovery)**:
  Agent starts in Compact profile -> encounters profile boundary when invoking Full tool -> parses guidance message -> gracefully handles CLI help and diagnostics without exposing system paths.

---

## 3. How to Run the Tests

### Primary Invocation
Execute the E2E test suite using Node's native test runner:
```bash
node --test test/e2e-mcp-disambiguation.test.js
```

### Isolated Environment Invocation
Run with preloaded home isolation:
```bash
node --test --import ./test/helpers/isolated-home.mjs test/e2e-mcp-disambiguation.test.js
```

### Full Repository Verification
Run alongside the entire test suite and schema linters:
```bash
npm test
npm run check:mcp
npm run size:mcp
```
