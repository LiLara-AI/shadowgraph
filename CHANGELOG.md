# Changelog

## Unreleased

### Added

- **`reconsider()`, and `shadowgraph_reconsider` in both MCP modes.** `review()` answered one
  question — which decisions are due — and said nothing about the decisions it passed over. A caller
  could not tell "checked, and nothing fired" from "could not check". `reconsider()` gives the three
  readings the product actually needs: `review_recommended` when a rule definitely fired,
  `unchanged` when evaluation was **complete** and nothing fired, and `manual_review` when nothing
  definitely fired but something could not be settled. `unchanged` is reported **only** with
  `evaluationCompleteness: 'complete'`; a rule firing while another is unknown is
  `review_recommended` **and** `partial`, with both sets of evidence visible so neither hides the
  other.

  It is a **projection of the same pass** `review()` runs, not a second evaluation. One pass, one
  evaluator (`src/condition-eval.js`), one set of verdicts, so the two cannot disagree about whether
  a stored rule fires, does not fire, or cannot be evaluated. A separate operator table on the
  reconsideration side would have meant a rule using `gte` — or any operator only one route
  understood — reporting `unchanged` with complete confidence on one route and a breach on the
  other. `test/reconsideration.test.js` proves the agreement operator by operator, driven from the
  canonical `RULE_OPERATORS` export rather than a second list that could drift.

  Each decision carries the evidence behind all three outcomes: `triggeredRules`, `triggeredBy`,
  `groundedConditions` (the rules that definitely did *not* fire, so `unchanged` rests on something
  rather than on an empty list), `rulesNotEvaluated`, `contestedConditions`, `affectedAlternatives`
  and `factsConsidered`. Signals are raised under the identity `review()` already uses, so a repeat
  adds none and an acknowledgement holds. Nothing is written to decision status, confidence or
  lifecycle state, and no stored rule is rewritten. Key matching stays **literal**: a near-miss key
  is `unknown`, never a match. Reaching it: `shadowgraph_reconsider` (full and compact),
  `POST /reconsider`, and `shadowgraph reconsider` on the CLI.

  `decisionId` **fails closed**. An unknown id, an id belonging to another project, and a closed
  decision are each an error rather than an empty result, because an empty `unchanged` + `complete`
  for a mis-addressed decision reads exactly like a healthy one. A focused call evaluates only its
  decision and raises no signal for any other.
- **MCP writes carry a session the runtime knows.** `sessionId` was caller-owned in every direction:
  two unrelated clients could claim the same one, and a client that sent none left a `null` where
  the grouping belonged. The MCP server now mints one id per process and records it on every write
  it performs. A caller-supplied `sessionId` is still **accepted** — never an error, no existing
  client breaks — but it is superseded rather than merged, because asserted provenance does not
  outrank observed provenance. This covers the per-operation `sessionId` inside an `applyMemoryPlan`
  batch too. `actor` and `client` are untouched, CLI and HTTP callers are unaffected, and the
  field's type and default are unchanged, so no migration is involved.
- **A local workspace for raw development material, outside the repository.** Repository hygiene
  used to offer only one place for internal handoffs, session state, backups, debugging logs and
  private benchmark material: an ignored directory *inside* the repository, one forced add away
  from publication. `npm run local:workspace:init` creates an external workspace instead, and
  `npm run local:workspace:status` reports where it resolves without touching anything. It resolves
  from `SHADOWGRAPH_LOCAL_WORKSPACE` or defaults to the repository's sibling `shadowgraph-local`;
  the repository root and every path inside it are refused by canonical, symlink-resolved comparison
  rather than a string prefix test. `init` checks every directory it would create and the README for
  a symlink, a Windows junction or a hardlink before it creates anything, so a workspace it refuses
  is a workspace it did not modify; it creates only what is missing, never overwrites an existing
  README, and creates no Git metadata. `status` only reads, and importing the module does nothing at
  all.

  Placing material in the workspace is **manual** in this release: no repository command copies,
  moves, deletes or rewrites raw data, and nothing indexes it. An automated preservation command was
  intentionally not shipped — copying into an external directory safely on every supported platform,
  while the filesystem underneath may be concurrently substituted, needs machinery out of proportion
  to a convenience `cp` already provides. The ignored directories named in `.gitignore` remain a
  fallback against an accidental `git add`, not the place raw material belongs. No runtime behaviour
  changes and no dependency is added.
- **The public hygiene check says what to do with a finding.** It reported the violation and left
  the developer to guess, which invites deleting the offending material. The diagnostic now states
  that raw data is meant to be preserved outside the repository and only a sanitized copy tracked,
  and names the workspace commands. The gate itself is unchanged in what it touches: it reports,
  and never deletes, moves, sanitizes, backs up or rewrites anything.

### Fixed

- **A stored string reopen rule that did not match is no longer silent.** A token rule matches
  `changedFacts` only, and durable facts are deliberately never fed into that list, so when a caller
  supplies nothing there is no evidence either way. Such a rule previously produced neither a `due`
  entry nor a diagnostic — the last silent path on the reopen side, indistinguishable from a checked
  and healthy decision. It is now `unknown`, with the reason
  `Legacy string condition this evaluator cannot settle from stored facts`, exactly as `reusableWhen`
  already treats legacy free text. The text is preserved verbatim and never interpreted; no meaning
  is invented for it. It stays out of `matches` and `coverage`, so it raises **no** review signal and
  changes **no** signal identity, and `review()`'s own return is byte-identical. The entry is
  additive on `context().conditionDiagnostics` and `maintain().diagnostics`.
- **Stale MCP tool counts across the documentation and the CI label.** `docs/mcp-compatibility.md`
  advertised compact as 12 in its mode table while the same document said 13 in five other places,
  its compact inventory table was missing `shadowgraph_ack_review` (listing it as full-mode-only),
  and the `2024-11-05` compatibility guarantee quoted "27/12/28". `integrations/README.md` claimed 12
  workflow tools and misdescribed what `smoke:package` verifies, and the CI step was labelled
  "27 full / 12 compact" while the gate it runs asserted 13. Every count is now derived from
  `buildToolCatalog()` and `npm run check:mcp` rather than restated by hand: **28 full, 14 compact,
  29 with a verifier configured.** Historical measurements are left as they were taken and labelled
  with the surface they were measured on, rather than re-labelled to match today's.
- **A rule that states no operand is `unknown`, for every operator.** Only the ordered, range and
  set operators noticed a missing `value`. `equals` and `contains` compared against `undefined` and
  returned a confident `false`; `not_equals` returned **`true`**, because `500 !== undefined`, so a
  stored rule that said nothing read as a genuine breach and could raise a review signal. One
  shared predicate, `ruleOperandIssue()`, now decides this for all ten operators and for review
  coverage reconstruction, so the two cannot drift apart. An *absent* operand is not `value: null`
  — null is a legitimate comparison target that JSON preserves — and presence is tested rather than
  truthiness, so `0`, `false` and `''` remain real operands that decide. The stored rule is
  reported as it is, never given an operand it did not have.
- **An absent operand is no longer written as `undefined`.** `normalizeRules` emitted
  `{key, operator, value: undefined}` for a rule carrying no operand. Stored state is plain JSON
  and `undefined` is not, so every later `clone()` of that record threw: one such rule arriving
  through the lenient import path took `exportData()` and `context()` down for the whole graph.
  The field is now omitted. A caller write was already refused by that same throw but reported
  `Values must be plain JSON data`; strict mode now says
  `A structured rule requires a value for operator <operator>`. **Affects existing stored data:** a
  graph holding such a rule becomes readable again, and that rule now reports `unknown` instead of
  a verdict.
- **Legacy acknowledgement reconstruction fails closed on incomplete history.** Coverage rebuilt
  from a pre-`coverage` signal's `violatedConditions` accepted an entry whose `expected` operand
  was missing. `JSON.stringify` drops an `undefined` field, so the reconstructed identity silently
  shrank to a shorter shape that could match a current rule stating no operand, and the old
  acknowledgement was reused for a breach it never covered. Reconstruction now refuses any entry
  with an absent or malformed operand, an absent / non-string / unsupported `operator`, or an
  unrecognised `unit`, and the current breach set gets its own `open` signal. A historical
  `expected` of `0`, `false`, `''` or `null` still reconstructs. The legacy signal is preserved
  unchanged either way.
- **Returned condition details no longer alias stored state.** Every field of a caller-visible
  detail on `violatedConditions`, `conditionDiagnostics`,
  `reusableAttempts[].satisfiedConditions` and `maintain().due` / `.diagnostics` was a reference
  into the stored rule or the stored fact whenever the value was an object or an array. Mutating a
  returned value therefore rewrote canonical state with **no journal entry**, so live state and the
  journal diverged silently and a rebuild put the old value back. They are copies now — the copy
  walks the detail's own keys rather than a list of fields expected to hold objects, because
  write-time validation rejects an object `operator` or `unit` but **import is lenient** and
  preserves stored records verbatim, so a rule written by another build can carry an object
  anywhere. A key whose value is `undefined` is preserved, since `observed: undefined` is how "no
  fact recorded for this key" is reported. No response field was added, removed or renamed.
- **Legacy free-text `reusableWhen` conditions are no longer discarded.** String conditions were
  filtered out before the ALL decision, making it an ALL over a subset:
  `reusableWhen: ["approval required", {key: "ready", value: true}]` with `ready = true` reported
  the attempt reusable even though nothing had settled the approval. Free text is now counted and
  evaluates to `unknown` — this evaluator is deterministic and cannot prove prose — which keeps the
  attempt out of `reusableAttempts` and surfaces the unresolved text verbatim in
  `conditionDiagnostics`. The stored condition is never interpreted, migrated or rewritten.
  **Affects existing stored data:** an attempt previously reported reusable may no longer be.
- **A newly applicable breach no longer inherits an old acknowledgement.** Review signal identity
  was `(decisionId, reason)`, and `reason` is a cause list built from fact keys, so two rules on
  one key collapsed to one reason. With alternatives carrying `lag >= 500` and `lag >= 1000`, an
  acknowledgement made at `lag = 600` silently covered the second alternative when `lag = 1200`
  breached it too. Identity is now `(decisionId, coverage)`, where the additive `coverage` field
  lists stable per-condition ids (the carrying alternative's persisted `id` plus the rule by
  canonical content, so reordering `reopenWhen` does not reopen a settled review). `reason` is
  **not** part of the identity: besides being too coarse, it is built in stored-rule order, so
  re-importing a decision with its alternatives reversed turned `lag, load` into `load, lag` and
  reopened an acknowledged review covering exactly the same breaches. Coverage already
  distinguishes everything `reason` does and more, so `reason` was dropped from the identity rather
  than canonicalised — sorting the cause list would misreport the order rules are stored in.
  `reason` is still reported, exactly as built. An unchanged breach set stays acknowledged, a
  broadened one raises a separate `open` signal, and narrowing back returns to the acknowledged
  signal. **Backward compatible, without widening:** a signal stored before `coverage` existed is
  left exactly as stored — never re-keyed, stamped or deleted — and is matched to a current breach
  set only when its own recorded `violatedConditions` reconstruct to precisely that set;
  reconstruction can only under-state history, never over-state it, so an old acknowledgement can
  be honoured but never widened. Where history is missing, partial, ambiguous or different, the
  current breach set is `open` and visible. No schema version bump: both stores persist the signal
  payload whole. **Affects existing stored data:** a decision with two rules on one fact key can
  now raise a second, open signal where it previously reused the first, and a pre-`coverage` signal
  with no recorded conditions no longer suppresses anything.
- **Expired evidence no longer satisfies conditions until `maintain()` runs.** Read-time evaluation
  consulted only the marks `maintain()` writes (`status`, `temporal.validTo`), so a fact whose
  expiration boundary had already passed still counted, and the same evidence gave `context()` one
  `reusableAttempts` entry before a maintenance run and none after. Evaluation now reads the
  canonical `effectiveFactExpirationBoundary()` — the same policy `maintain()` uses, not a second
  copy of the rules — and the boundary instant itself is already expired. A condition whose
  applicable evidence has all expired is `unknown` and reported, never a pass; `maintain()`
  afterwards changes persisted housekeeping only, never the answer. **Affects existing stored
  data:** an already-expired fact stops satisfying conditions before the next `maintain()`.

### Changed

- **Compact mode advertises 13 tools instead of 12.** `shadowgraph_ack_review` was promoted into
  compact. A compact client could already see reviews through `shadowgraph_context` but had no
  advertised route to acknowledge one, so signals accumulated with no way to clear them. The only
  path to a signal id was `shadowgraph_maintain`, which also stales decisions and expires facts —
  a maintenance write, not a listing route. No new tool was added; an existing one became reachable.
- `review()` / `maintain().due` / `context().openReviews` entries gained **`reviewSignalId`** and
  **`reviewSignalStatus`** (`open` | `acknowledged`), both additive. The id is what
  `shadowgraph_ack_review` takes. The status is included because entries are recomputed from current
  evidence on every call and an acknowledged one still appears, so a caller must check before
  acting. Existing fields are unchanged.
- **Behaviour change in ranking.** For `search()` and `retrieve()`, a match on the caller's original
  unfolded text now outranks a match that only survived Unicode folding. Folding decided whether a
  record matched but nothing about order, so a record holding the word the caller typed scored
  identically to one holding only its near-twin — `على` against `علي`, `آمن` against `امن`. Order
  only: no record is admitted or excluded, recall is unchanged, stored text is untouched, scope
  isolation is unaffected, and an exact identifier can only be reinforced. Case is still ignored.
  `recall()`'s RRF fusion is deliberately **not** changed and keeps its documented behaviour, so the
  two paths differ here; see `docs/contracts/search-contract.md`.
- **Arabic and accented text are now findable.** The `recall()` tokenizer matched `[\p{L}\p{N}]+`,
  and Arabic harakat are `\p{Mn}`, so diacritics acted as token *separators*: `مُحَمَّد` tokenised to
  four single letters and could never match `محمد`. Records written with tashkeel were unreachable
  by BM25, and on the substring path `résumé` and `resume` were different strings. One shared
  `foldText()` in `src/hybrid-search.js`, used by both search paths, now folds diacritics and the
  Arabic `أ/إ/آ/ٱ`, `ى`, `ة` and tatweel variants. Folding only widens what counts as the same
  character: it can add a match but not remove one, and `cach` still matches `cache`. Measured on 15
  cases: `search` 7→11, `retrieve` 7→11, `recall` 10→13, with Arabic orthography 0/3 → 3/3 on all
  three. Paraphrase and cross-language are unchanged — folding does not reach meaning. See
  `docs/retrieval-decision-2026-09-13.md`.
  **Precision cost, disclosed:** widening matching admits false positives, and two folds collapse
  genuinely different words — `ى`→`ي` merges `على` ("on/about") with `علي` (the name Ali), and
  `آ`→`ا` merges `آمن` ("safe/believed") with `امن` ("security"). Taken deliberately, because an
  unreachable record is worse than a rankable false positive; both are asserted in
  `test/retrieval-folding.test.js` so they stay known.
- `recall()` no longer deep-clones the entire graph on every call. It ranked over `exportData()`,
  which copies every record, fact, relation, review signal, idempotency entry, event and the whole
  journal; ranking reads three of those. It now ranks over live entities and clones only the page
  returned, so a caller still never holds a reference into live state. Measured on a 70-record
  corpus: 2.31 ms → 0.70 ms.
- New measurement scripts, kept separate on purpose: `scripts/context-size.mjs` (retrieved-context
  bytes, phase timings and factual coverage) and `scripts/retrieval-eval.mjs` (a 15-case retrieval
  evaluation with dev/held-out splits, scored per category). Tool-definition bytes stay in
  `scripts/mcp-wire-size.mjs` and are never inferred from context bytes. No token measurement is
  taken anywhere, so no token claim is made.
- Reconsideration conditions are evaluated with three verdicts instead of a boolean. `true` means
  review is due, `false` means the condition is genuinely unmet, and `unknown` means it could not
  be evaluated from the evidence available. `unknown` opens no review signal but is always
  reported, so uncertainty is no longer indistinguishable from safety. See
  `docs/contracts/review-conditions-contract.md`.
- **Behaviour change on existing stored data.** Rules using `gte`, `lte`, `between`, `in` or
  `not_in` were silently inert — the evaluator recognised five operators and returned `false` for
  everything else — and they now evaluate. A stored condition that never fired may now fire. Stored
  operators this build still does not recognise are preserved verbatim and evaluate to `unknown`;
  they are never rewritten.
- **Behaviour change.** An ordered comparison against a value that is not a finite number, such as
  `"250ms" > 200`, was `false` because `Number("250ms")` is `NaN`. It is now `unknown`, or decidable
  when the rule declares `unit: 'ms'`. `null`, empty strings and non-numeric values against ordered
  operators are likewise `unknown` rather than `false`.
- A caller-supplied `unit` on a rule is preserved instead of being dropped by `normalizeRules`, and
  participates in comparison through an explicit conversion whitelist. A bare number is read in the
  rule's declared unit; an unannotated rule is never assumed to mean milliseconds.
- `addDecision()` and `addAttempt()` now reject an unsupported operator, an unsupported unit, or an
  empty rule key, so a typo fails at the write instead of becoming a condition that can never fire.
  Legacy free-text conditions are still accepted, and import/migration stays lenient.
- `context()` gained a `conditionDiagnostics` collection and `maintain()` a `diagnostics` key, both
  additive, carrying conditions that are unresolved or resting on facts that disagree. The
  diagnostics collection is bounded and declared by the existing completeness contract.
  `review()` still returns a bare array of due decisions, unchanged.
- `openReviews[]` entries gained `violatedConditions`, naming the operator, expected value, observed
  value, unit and the fact the verdict was computed from. Existing fields are unchanged. Fields a
  fact does not record are omitted rather than synthesised.
- `attempts[].reusableWhen` is evaluated for the first time. The field has been normalised and
  persisted since schema 4 with nothing reading it; it now surfaces as `context().reusableAttempts`.
  Its rules combine with **ALL**, not `any` — the opposite of `reopenWhen` — and any unresolved or
  contested condition blocks the result, because uncertainty must not read as permission to retry.
  A reported attempt may be reconsidered; it is not authorised to retry, and it still appears in
  `failedAttemptsToAvoid` with its recorded failure untouched.
- `addAttempt()` accepts an optional `resultClass` of `failed`, `succeeded` or `inconclusive`.
  Deliberately not called an outcome: `outcome` is a decision-only, single-slot concept that weights
  confidence and writes an `outcome.recorded` journal entry, none of which applies to an attempt.
  A declared class decides which attempts reach `failedAttemptsToAvoid`; with none, the legacy
  `/fail|regression|error/i` wording test still classifies, so no stored attempt changes meaning.
  An inferred classification is never written back as though declared.

- MCP tool metadata now has one source, `src/mcp-tools.js`, which also supplies the advertised tool
  list, the unknown-tool guard, and the set of tools that persist after a successful call. Tool
  names and the 27/12/28 inventories are unchanged, as is what every tool does to the store.
- Every tool description states what it does, which sibling to use instead, and what it persists,
  destroys, or does on a retry, in at most 350 characters. Field rules moved into the input-schema
  property descriptions, result shapes into the output schemas, and longer explanations into
  `docs/mcp-compatibility.md`. Every input property, including nested ones, carries a description:
  top-level coverage went from 29% to 100%.
- `tools/list` is materially smaller. In full mode it is now 41,680 bytes bare, 44,514 annotated and
  155,847 structured, down from 52,215 / 55,043 / 166,376 on this branch; compact mode is 28,254 and
  90,356, down from 33,454 and 95,553. Description text across the 27 full-mode tools fell from
  18,429 to 8,515 characters. All figures are UTF-8 bytes of `JSON.stringify(result.tools)`, the same
  boundary used for the 17,839-byte pre-metadata baseline, and exclude the constant 44-byte JSON-RPC
  envelope. `npm run size:mcp` reproduces them with a per-member breakdown, and the metadata tests
  enforce per-tool, aggregate, and per-tier budgets.
- Output schemas were not changed. They account for 111,308 of the 155,847 structured bytes, and an
  advertised schema is a promise a validating client enforces, so none was trimmed to reduce a number.
- Tools declare `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`, derived
  from what each handler actually does, and 25 of the 27 full-mode tools declare an `outputSchema`
  and return matching `structuredContent` beside the unchanged serialized text.
  `shadowgraph_review` and `shadowgraph_review_signals` return bare JSON arrays and therefore
  declare neither; the omission is documented and asserted by tests.
- Tool annotations were corrected against what the handlers observably do. Every tool that persists,
  and `shadowgraph_restore`, is now `idempotentHint: false`: each successful call commits a new
  durable revision even when the domain result is a no-op, and that revision is the concurrency token
  other writers compare. That changes `shadowgraph_review`, `shadowgraph_context`,
  `shadowgraph_remember`, `shadowgraph_confidence_evidence`, `shadowgraph_update_status`,
  `shadowgraph_supersede`, `shadowgraph_ack_review`, and `shadowgraph_verify_fact`.
  `shadowgraph_ack_review` is additionally `destructiveHint: true`, because it rewrites a signal's
  status and `acknowledgedAt` in place with no journal entry, so the previous acknowledgement cannot
  be recovered. `shadowgraph_verify_fact` is additionally `openWorldHint: true`, because the caller
  chooses the evidence path the server reads, as with backup and restore.
- `test/mcp-tool-effects.test.js` now proves those annotations rather than restating them: it drives
  the real stdio server, calls every advertised tool twice with identical arguments, records the
  durable revision, the journal, the stored entities, the timestamps, and the files written, and
  derives all four hints from what changed. An annotation that stops matching the handler fails the
  suite.
- `initialize` now genuinely negotiates the protocol revision. A request for `2025-11-25`,
  `2025-06-18`, `2025-03-26`, or `2024-11-05` is echoed, and any other value is answered with
  `2025-11-25`, the latest revision this server implements. `protocolVersion` is required: a missing,
  non-string, or empty value is `-32602` rather than a revision to guess from. Previously every
  handshake answered `2024-11-05` no matter what was asked for.
- Optional tool members follow the revision the server returned, not the one the client asked for:
  `annotations` from `2025-03-26`, `outputSchema` and `structuredContent` from `2025-06-18`, and both
  for modern `_meta` requests. A future or unrecognised value can no longer unlock metadata by
  itself, because it first negotiates a revision both peers agree on. See
  `docs/mcp-compatibility.md` §4.
- A session negotiated at `2024-11-05` keeps the top-level tool members (`name`, `description`,
  `inputSchema`), the tool names and counts, and the serialized text result. Tool objects are not
  byte-identical to earlier releases: descriptions were rewritten and input-schema properties gained
  descriptions, as the bullets above and below describe.
- The stdio server accepts JSON-RPC batches in a session negotiated at `2025-03-26`, whose base
  protocol requires it, and only there: 2024-11-05 never defined batching and 2025-06-18 removed it.
  Responses for members carrying an `id` come back as one array on one line, and a batch of
  notifications alone produces no output.
- `server/discover` and the `-32022` error data now list every implemented revision, newest first:
  `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. Only `2026-07-28` is usable
  as a per-request `_meta` version.
- `shadowgraph_traverse` now documents its `project` and `scope` parameters, which the handler
  already accepted, and `shadowgraph_maintain` declares that `changedFacts` holds strings, which
  the server already enforced. No constraint was added or removed anywhere else.
- The strict official Inspector gate additionally fails when a tool is missing an annotation or an
  expected output schema.
- `npm run check:mcp` now also runs `scripts/check-glama-proxy.mjs` (`npm run check:glama`), which
  starts the pinned `mcp-proxy@6.4.3` that fronts Glama’s generated container, puts a transparent
  stdio recorder between it and the server, and scans over streamable HTTP as Glama does. It asserts
  that the proxy requests `2025-11-25`, that this server negotiates `2025-11-25` with it, and that
  the 27-tool list the scanner receives, annotations and output schemas included, is deep-equal to
  the one the server wrote. No dependency was added: the proxy is fetched through `npx`, exactly as
  the Inspector already is. What used to be a dated sentence in the compatibility document is now a
  gate that fails when it stops being true.
- `npm run size:mcp` reports `tools/list` wire sizes with a per-member breakdown, and
  `test/check-glama-proxy.test.js` covers the new gate’s recorder, event-stream parser, and
  assertions offline.

## 0.40.0 — Technical Preview (unreleased on npm)

This release keeps ShadowGraph's decision-first model and adds the everyday memory capabilities needed for user personalization, temporal recall, hybrid retrieval, and human-readable Markdown workflows. The implementation is independent; no competitor source code was copied.

### Breaking

- **`SCHEMA_VERSION` is now `5`** and imports schemas 1–5. Schema 4 added memory records; schema 5 adds the canonical lifecycle and signed-verification migration boundary.
- Compact MCP mode now advertises **12** workflow tools (previously 10), adding `shadowgraph_remember` and `shadowgraph_recall`. Full mode advertises 27 tools.

### Added

- Scoped memory for project plus `userId` / `agentId` / `runId`, with `preference`, `profile`, `goal`, `instruction`, `procedure`, `episode`, and `note` types.
- Deterministic reconciliation outcomes: `ADD`, `UPDATE`, `DELETE`, and `NOOP`; previous versions are retained and journalled rather than overwritten.
- Validated memory operation plans that preflight the complete batch before mutation.
- Bi-temporal validity and record-time fields for memory, facts, and relations; point-in-time `asOf` recall.
- Explainable hybrid candidate union over BM25-style lexical rank, optional cosine vector rank, graph distance, and temporal rank, fused with weighted RRF. Every response declares unavailable signals.
- Localhost-first OpenAI-compatible embedding adapter. Remote embedding endpoints require `allowRemote=true` / `SHADOWGRAPH_ALLOW_REMOTE_EMBEDDINGS=1`.
- Deterministic Markdown rendering and explicit push/pull synchronization with atomic writes, stable identity paths, Unicode round trips, content hashes, dry-run support, and conflict refusal.
- JavaScript, CLI (`remember`, `recall`, `markdown-sync`), HTTP (`POST /memories`, `POST /recall`), and MCP workflow surfaces.
- JSON/SQLite restart parity and journal rebuild coverage for scoped memories.
- Architecture decision record with grounded competitor research: `docs/adr/0006-unified-memory-kernel.md`.
- Canonical replay-baseline placement ADR: `docs/adr/0007-canonical-journal-baseline-placement.md`.
- Frozen seven-arm/ten-scenario benchmark preregistration, deterministic validation/aggregation harness, and measured 1k/10k/100k local journal evidence. Comparative lifecycle values remain unavailable because the common local/free LLM-and-embedding prerequisite was absent; dependency import probes are not performance evidence.
- Installed-package commands: `shadowgraph setup`, `shadowgraph doctor`, `shadowgraph serve`, and `shadowgraph mcp`.
- Real-tarball clean-install smoke coverage for paths containing spaces, including installed CLI, MCP full/compact, HTTP health, dashboard, and restart persistence workflows.
- Copy-ready Claude Code, Cursor, Codex, and Hermes MCP configurations, with compact mode recommended and full mode preserved.

### Fixed

- Replay baselines can no longer reset fact lifecycle history. Duplicate, ordinary midstream, rewind, wrong-epoch, and terminal-rewriting baselines reject atomically as `invalid_projection_baseline_placement`; pure rebuild skips them and reports incomplete instead of reactivating an expired or superseded signed fact. Schema 1–5 migration baselines, proven monotonic migration extensions, baseline-only snapshots, and hard-purge leading gaps remain supported.
- Scoped recall now fails closed: omitted project/scope means only the `default` project and all-null scope, never every project/user/agent/run. Supplied memory projects must be non-empty strings. Memory idempotency keys include the full scope/type/key identity.
- Schema-4 runtime writes/imports enforce globally unique record/fact/relation/alternative IDs so JSON and SQLite accept the same graph; new links reject missing endpoints; direct merge import rebuilds current-memory/current-fact indexes instead of retaining overwritten payload objects.
- Memory plans preflight retry keys, IDs, temporal ordering, and invalidation bounds. Re-adding an invalidated identity continues its monotonic version history.
- Same-content writes validate explicit temporal changes; temporal fields must be strings/null; supersession, deletion, and fact replacement never extend an interval that had already ended. Current recall keeps the prior value until a future-effective replacement starts. Fact expiry closes valid time before reconsideration.
- Derived embeddings can be refreshed without creating a semantic version, are journalled as `memory.indexed`, require model+dimension compatibility, reject redirects, and fall back honestly when a configured MCP query embedder fails.
- Schema-4 persisted memory/fact/relation envelopes receive full temporal validation, globally unique IDs are enforced, and journal-bearing schemas 1–3 are compared after symmetric migration during restore.
- Hard purge now persists an exact `removedJournalSequences` ledger; an unrelated or empty hard-purge marker can no longer excuse arbitrary restore gaps.
- Project purge clears the in-memory scoped-memory index; a later write cannot accidentally supersede or re-journal a purged payload. A tracked stale Markdown file cannot resurrect a purged memory.
- Markdown paths use stable bounded identity segments; immutable IDs and frontmatter identity edits are rejected. Pull rolls back the whole graph on a later-file error and advances sync state only after an optional canonical persistence callback succeeds.
- The MCP stdio server supports legacy `2024-11-05` initialization and modern `2026-07-28` per-request metadata/discovery semantics without falsely advertising one contract as the other.
- CLI/HTTP/MCP context paths now persist generated review signals. HTTP and MCP mutators reconcile live state to the last readable durable snapshot after ordinary persistence failures.
- MCP serializes complete tool/restore calls, preventing concurrent acknowledged writes from being erased by restore or conflict recovery.
- Schema-4 imports reject malformed projects/scopes/IDs before merge, reject collisions against live collections, validate stored fact/relation intervals and journal identity, and preserve nested-alternative links through rebuild.
- Markdown persistence callbacks now require durable read-back, resolving both pre-commit failures and commit-then-throw ambiguity.
- Explicit empty projects fail closed across search, retrieval, review, journal, redaction, and context instead of becoming cross-project wildcards.
- Temporal strings are validated as real timestamps and compared by instant, including equivalent timezone-offset representations.
- Restore/import validates review-signal references and IDs, idempotency references/namespaces, and schema-3/4 journal identities; legacy collection-local ID collisions migrate to deterministic schema-4 IDs.
- Direct writes preflight lossless plain-JSON serializability, large journal imports avoid argument-spread limits, and merge imports cannot decrease live revision or journal sequence high-water marks.
- Memory isolation now applies consistently to recall, search, retrieve, and traverse; omitted project/scope resolves to the default/all-null memory scope.
- Merge/restore validation covers final relation endpoints, duplicate review/idempotency semantic identities, journal type/entity consistency in both import and direct replay, strict calendar timestamps, and bounded hard-purge gap arithmetic.
- Review identities use tuple encoding rather than delimiter concatenation, and legacy idempotency keys are collision-checked again after canonicalization.
- Review/maintenance inputs are fully preflighted before mutation, and MCP restores its pre-call graph snapshot for domain-operation exceptions so a later write cannot persist rejected state.
- Logical and hard purge markers no longer retain caller-controlled entity IDs. Logical replay derives project/entity/relation deletion structurally; hard markers retain only sequence-gap evidence. JSON/SQLite restart and restore preserve erasure.
- Every valid no-id JSON-RPC message is response-suppressed after execution, including successful `initialize`, `tools/list`, and `tools/call`; explicit `id:null` requests and parse errors still respond.
- JSON and SQLite saves/restores now share one destination lock domain across store handles and processes. A writer overlapping restore waits and is revision-checked against the installed state or fails explicitly; it can no longer return success and disappear after replacement. The fence has bounded timeout, heartbeat-backed stale-lock recovery, and immediate same-chain reentry errors for validation/activation callbacks.

### Honest limits

- Semantic retrieval is available only when embeddings are supplied or an embedding endpoint is explicitly configured; lexical fallback is never labelled semantic.
- No default LLM extractor, background file watcher, hosted cloud sync, competitor-parity claim, or measured comparative token/cost/answer-quality result is included. All seven preregistered arms are `NOT_MEASURED` in the retained comparative run because no common local/free LLM and embedding endpoint was available.
- Dependency installation/import success is setup evidence only and must not be described as a benchmark win. The word `best` and equivalent overall-superiority wording are prohibited for the current evidence.
- Confidence calibration remains unresolved. Optional verification is restricted to a separately configured local Ed25519 trust boundary and is not a general remote attestation system.
- Version 0.40.0 is a Technical Preview and remains `private: true`. Independent security review and actual preregistered comparative measurement remain release gates; package/install hardening and the measured local journal run do not satisfy either gate.

## 0.31.0 (unreleased — review candidate)

Closes the eight architectural gaps G1–G8 proven by the 2026-08-25 audit. Versioning note: this project is `0.x` and `private: true`, so per semver's pre-1.0 allowance the breaking input-contract change below ships as a **minor** bump rather than a major one, consistent with the project's existing 0.26 → 0.27 → 0.30 feature-bump history.

### Breaking

- **`addFact()` now rejects caller-supplied `verificationStatus: 'verified'` and `'expired'`** with an error. Previously both were accepted verbatim, and `source: 'human-confirmed'` or `'tool_observed'` silently auto-promoted a fact to `verified`. Trust is no longer self-assertable from tool input. `'contradicted'` is still accepted because it lowers trust. `'expired'` is owned by `maintain()`.
  **Migration:** stop passing `verificationStatus`. A fact's trust is now derived, not declared. If you relied on auto-verification, note that **nothing in this build reaches `verified` from tool input** — see `docs/contracts/provenance-contract.md` §2 and open question U-1.
- **The no-source default changed from `model_inferred` to `agent_claimed`.** `model_inferred` is no longer producible. Unrecognised labels now downgrade to `agent_claimed` with the original string preserved in `sourceRaw` (audit only, not evidence).
  **Migration:** read `sourceClass`, not `source`. Stored legacy facts are backfilled on import; `source` is retained as a mirror for compatibility.
- **`SCHEMA_VERSION` is now `3`** (was `2`). v1 and v2 files still import — `SUPPORTED_SCHEMA_VERSIONS` is `[1, 2, 3]`.
- **`validate()` is stricter and returns severity-classified issues.** Legacy records with an unknown or missing decision `status` now surface as issues instead of validating clean. Data is **reported, never silently rewritten**.
- **Read paths return envelopes instead of bare arrays.** `search()`, `retrieve()`, and `context()` now return `{ items, page, completeness }`. See `docs/contracts/completeness-contract.md`.
- **`addConfidenceEvidence()` now REQUIRES a `key`.** Previously an omitted key was synthesised from a timestamp, which silently defeated the documented retry-idempotency: the same observation retried a few milliseconds later got a different key and was counted twice.
  **Migration:** pass a stable `key` identifying the observation (e.g. `ci-run-4821`). Reuse it for retries of the same observation; use a new key for a genuinely new one. The MCP schema marks it required.
- **`importData()` now refuses an envelope `schemaVersion` outside `SUPPORTED_SCHEMA_VERSIONS`.** Previously an unknown future version was silently half-read. Individual future *records/facts* are still preserved verbatim and reported by `validate()` — only the whole-file envelope is refused.
- **Legacy facts without IDs now receive deterministic content-derived IDs.** Re-importing the same legacy payload preserves restart parity; an occurrence ordinal keeps identical duplicate facts distinct.
- **MCP behaviour changes a strict client may notice:** `resources/read` with an unknown URI and `prompts/get` with an unknown name now return `-32602` instead of the default context/policy payload; unknown methods return `-32601` instead of `{}`; notifications receive no response at all.

### Added

- Append-**oriented** journal carrying complete post-operation snapshots, plus a pure `rebuildProjection()` replay (`src/journal.js`). Rebuild is a fold over snapshots — it runs no domain logic, so a replay cannot mint trust.
- `journalEpoch` migration boundary. Pre-existing metadata-only events are retained and marked non-replayable rather than being claimed as replayable history.
- Logical/tombstone purge as the **default**, with hard purge as a separate explicit operation. Hard purge creates sequence gaps, which `journalGaps()` and `validate()` **declare** rather than hide.
- Evidence-weighted bounded confidence model with an auditable `basis` (`src/confidence.js`), replacing hardcoded ±0.1/−0.2 deltas.
- Declared-content-field search. Schema key names and internal metadata no longer match as content, and every hit cites the real field that matched.
- `shadowgraph_journal` MCP tool; provenance, pagination, and completeness surfaced across MCP/HTTP/CLI.

### Fixed

- **G1:** `review()` now evaluates `reopenWhen` rules against **stored** facts, so reconsideration survives a restart. Previously it only saw facts the caller re-supplied, meaning it worked only when the caller already knew the answer.
- **G7:** `search()` no longer reports `reason: 'Matched record content'` when no content field matched.

### Fixed — independent review findings (2026-08-25)

An independent review of the G1–G8 work found 18 further issues. All are closed, each with a regression test that fails on the pre-fix behaviour (`test/review-findings.test.js`, `test/review-interfaces.test.js`).

- **P0-1 purge left the idempotency cache intact.** `purgeProject()` deleted records, facts, relations, signals and journal payloads but not the idempotency entries — which hold *cloned payloads*. A purged decision's full content survived in `exportData().idempotency`, and replaying its key **returned the deleted entity**. Both `logical` and `hard` modes are fixed; purge now reports `idempotencyRemoved`.
- **P0-2 a failed replace destroyed the live graph.** `replaceData()` cleared every map *before* parsing, so a malformed payload left nothing to fall back on — worst possible behaviour in a recovery path (`restore`, revision-conflict reload). Data is now built in an independent staging graph and validated first. Additionally, the **envelope-level `schemaVersion` was never checked at all**, so a payload from an unknown future build was silently half-read; it is now refused.
- **P1-3** `/health` returned a hardcoded `0.30.0` while `package.json` and `src/mcp.js` each held their own literal. All three now read `src/version.js`.
- **P1-4** GET query parameters arrived as strings, so `?limit=2` was rejected as a non-integer and `minConfidence` would have compared a string. Typed parameters are coerced at the transport boundary; an uncoercible value is a specific `400`.
- **P1-5** every MCP failure was flattened to `-32000`. Codes are preserved: `-32601` unknown tool/method, `-32602` invalid params, `-32700` parse error, `-32000` genuine application errors.
- **P1-6** an unrecognised method replied `{"id":null,"result":{}}` to JSON-RPC *notifications*. Notifications are now never answered.
- **P1-7** `resources/read` returned the real context payload for **any** URI and `prompts/get` returned the policy text for **any** name — telling a client its request succeeded when the server had ignored it. Both validate their target and return `-32602`.
- **P1-8** confidence is `clamp(initial + sum(deltas), 0, 1)` — summed first, clamped **once**. Per-step clamping made the result depend on the order evidence arrived in. Permutation invariance is now tested.
- **P1-9** omitting `key` on confidence evidence synthesised a timestamped key, so a retry milliseconds later counted twice — the documented retry-idempotency was false exactly when it mattered. **`key` is now REQUIRED.**
- **P1-10** SQLite/JSON parity for the whole nested confidence structure (`current`, `initial`, `basis`, `contributions`, `history`, `policy`) is now proven by close/reopen tests on both backends, compared canonically.
- **P1-11** JSON restore now applies mandatory shared domain/journal validation even for direct JavaScript calls; malformed or unsupported input cannot replace the old file.
- **P1-14** SQLite restore no longer destroys the old database when the installed replacement fails to reopen or prepare. Source and live committed WAL state are folded into verified standalone snapshots with `VACUUM INTO`; the old snapshot is retained until replacement open/prepare/load/domain-validation succeeds. Recovery checks an existing destination read-only before any write-capable open, so inspection cannot fabricate an empty database. Corrupt journal folds, unexplained sequence gaps without a persisted hard-purge marker, and journal/live projection divergence are refused. Caught rename, post-rename, `DatabaseSync`, and preparation failures restore and reopen the old payload. Direct JavaScript, HTTP, CLI, and MCP restore all use mandatory shared validation; HTTP blocks writes and mutating context requests before graph change, and MCP no longer performs a second save after restore commits. Cleanup failure re-inspects the artifact family before reporting retained paths, so a delete-that-then-throws does not produce a false retained-artifact claim. Recovery failure is explicit with the rollback artifact preserved, and HTTP latches degraded mode so every authenticated non-health route request returns `503` until restart/manual recovery. This is process-level rollback safety, not crash or power-loss durability.
- **P2-19** project-scoped redaction now excludes other projects' review signals as well as idempotency payloads and secret-like keys.
- **P2-11** an unnumbered journal produced `Math.min(...[]) === Infinity`, an epoch that excluded every entry while reporting success. Now finite-or-null, with entries reported as non-replayable legacy.
- **P2-12** duplicate `seq` values made the fold order-dependent. Detected, `rebuildable: false`, and reported by `validate()` as an error.
- **P2-13** `isReplayable()` existed but was never called, so an entry explicitly marked `replayable: false` was replayed anyway. Now honoured, with diagnostic and status agreeing.
- **P2-14** future *record/fact* schemas are preserved verbatim and reported as `unsupported` — never silently downgraded. (Contrast P0-2: a future *envelope* is refused, because one uninterpretable entity is survivable and an uninterpretable file is not.)
- **P2-15** duplicate active fact scopes resolved by array order, so the same file reordered gave different reconsideration results. Recency is now `observedAt` with `id` as a total tie-break; the ambiguity is still reported.
- **P2-16/17/18** `completeness-contract.md` claimed invalid limits fall back to defaults when the code throws; the benchmark rejected `--sizes=…` equals form; and the report mixed journal performance with confidence calibration. All corrected.

### Documentation

- New contracts: provenance, lifecycle, journal, completeness, search, confidence.
- `integrations/agent-policy.md` no longer instructs agents to key off `model_inferred`, which the code cannot produce.
- README no longer describes the journal as "append-only" — hard purge deletes entries.

## 0.30.0 (public repository release candidate)

- Added persistent review signals, maintenance/aging, fact verification and expiry, idempotency, graph-aware retrieval, validation, repair planning, and backup/restore helpers.
- Added normalized relational SQLite tables, transactional legacy-envelope migration, repeated-save revision synchronization, and revision conflict detection for JSON and SQLite saves.
- Added MCP resources/prompts, local dashboard, agent policy assets, and expanded interface parity.
- This version is intentionally not published or pushed as a release.

## 0.27.0

- Added bounded relationship traversal with direction, depth, and relation filters.
- Added explicit same-project decision supersession with persisted `supersedes` relationships.
- Added privacy-safe redacted exports and permanent project purge controls across HTTP, CLI, and MCP.
- Added multi-term explainable search and matching HTTP, CLI, and MCP surfaces.

## 0.26.0

- Rewrote the user-facing README and integration guide to explain the context, decision, work, observe, evaluate, and reconsider workflow.
- Added practical setup guidance for MCP clients, HTTP clients, JSON/SQLite storage, and optional Bearer authentication.
- Added optional Bearer-token authentication for shared local HTTP deployments.
- Added constant-time token comparison and SQLite WAL verification.
- Added project-scoped fact supersession, localhost port compatibility, no-store headers, and CLI search filters.
- Added final release hardening and v0.26 documentation parity.

## 0.25.0

- Added selectable JSON/SQLite storage through `SHADOWGRAPH_STORAGE`, including WAL mode and a 5-second busy timeout for concurrent SQLite writers.
- Added decision lifecycle statuses, relationships, retrieval filters, and expanded MCP tools.
- Added concurrency-safe JSON saves and broader integration tests.

## 0.2.0 - 2026-08-24

- Redesigned the core as a versioned decision graph.
- Added project scopes, structured facts, evidence provenance, outcomes, confidence history, and event history.
- Added explainable search and the `shadowgraph_context` MCP tool.
- Added migration compatibility for v0.1 decision records.
- Added fact, outcome, context, and review HTTP/CLI surfaces.
- Added an optional Node 22.5+ `node:sqlite` storage adapter; JSON remains the zero-dependency default.

## 0.1.0 - 2026-01-01

- Added unified decision and rejected-alternative graph.
- Added persistent JSON storage.
- Added CLI, local HTTP API, and MCP stdio server.
- Added integration templates for MCP and generic HTTP clients.
