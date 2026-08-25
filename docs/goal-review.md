# ShadowGraph Goal Review

**Status:** review candidate
**Version:** 0.31.0

## Main goal

ShadowGraph is a persistent, local-first decision memory. A decision, its rejected alternatives, and falsification conditions must survive a restart; stored facts must be sufficient to trigger reconsideration without the caller supplying the answer again. Retrieved records must declare completeness, provenance must not be self-asserted as verification, and the journal must support an honest rebuild report.

## Verified path

The current implementation and tests cover the core path:

1. `addDecision()` stores alternatives and `reopenWhen` rules.
2. JSON and SQLite persistence retain the decision and facts across close/reopen.
3. `review({})` evaluates object-form `reopenWhen` rules against active stored facts scoped to the decision project.
4. Caller facts override stored facts for the same key; string rules remain ephemeral `changedFacts` signals by design.
5. `search()` and `retrieve()` return completeness envelopes and preserve full records in returned items.
6. `rebuild()` folds journal snapshots and reports unsupported, malformed, legacy, duplicate-sequence, and purge conditions instead of presenting a partial projection as complete.
7. Provenance source classes remain claims; caller input cannot create `verified`.

## Review conclusion

No additional production change is authorized by this review document alone. The main goal path is implemented and independently verified by the existing acceptance, parity, adversarial, and interface suites. Remaining open decisions are explicitly deferred in `docs/handoffs/current-status.md`, especially U-1 (a genuine verification channel), lifecycle semantics L-1/L-2/L-5, modern MCP interoperability, and warm-task benchmarking.

## Documentation corrections made for review

User-facing documentation must say `0.31.0` and schema `3`, and examples must demonstrate stored-state reconsideration after persistence rather than always passing the triggering fact into `review()` or `context()`. No document may imply that a source label is proof or that `verified` can be created through the current tool path.
