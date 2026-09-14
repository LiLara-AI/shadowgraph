# ShadowGraph — Review Condition Contract

**Status:** implemented. Applies to `evaluateRule()` in `src/condition-eval.js`, and to
`review()`, `maintain()`, `context()` and `normalizeRules()` in `src/shadowgraph.js`.

Principle: **a condition we cannot evaluate is not a condition that passed.**

The previous evaluator returned a bare boolean. An unknown operator, a value it could not parse
as a number, and a unit it could not read all produced `false` — the same answer as "checked, and
this decision is fine". Uncertainty was therefore indistinguishable from safety, and invisible.

---

## 1. Three verdicts

| Verdict | Meaning | Effect |
| --- | --- | --- |
| `true` | The condition is satisfied | The decision is due for review |
| `false` | The condition is genuinely not satisfied | No review from this rule |
| `unknown` | The condition could not be evaluated from available evidence | **No review, but reported** |

`unknown` never opens a review signal — an unevaluable condition is not evidence of a breach. It
is always reported, so it cannot be mistaken for a pass. A breach means **review is required**,
never that the decision is automatically replaced; supersession still requires an explicit
`supersedeDecision()` transition.

## 2. Where uncertainty surfaces

A decision whose conditions are all `unknown` produces no `due` entry and therefore no review
signal. Attaching uncertainty only to emitted signals would make it invisible again, so it travels
separately:

- `context().conditionDiagnostics` — a collection like any other, bounded by the same `limit` and
  declared in `completeness.collections.conditionDiagnostics` with `returned`/`total`/`hasMore`/
  `omitted`. It is never silently truncated and never unbounded.
- `maintain().diagnostics` — the same entries, on an already-object return.
- `review()` is **unchanged**: it still returns a bare array of due decisions.

A diagnostic is **not** a review signal. It asserts neither a breach nor a confirmed-safe decision.

## 3. Operators

`equals` · `not_equals` · `contains` · `greater_than` · `less_than` · `gte` · `lte` · `between` ·
`in` · `not_in`

- Rules within one alternative are **OR**-combined: any satisfied rule reopens that alternative.
  Unchanged.
- `between` takes `[low, high]` and both bounds are **inclusive**.
- `in` / `not_in` require an array; anything else is `unknown`.
- **Every operator requires an operand (changed 2026-09-14).** A rule that does not state what it
  compares against is `unknown`, for all ten operators. An *absent* operand is not `value: null`:
  null is a legitimate thing to compare against and JSON preserves it, while an absent property is
  a rule that never says what it means. Presence is what is tested, never truthiness — `0`, `false`
  and `''` are real operands and still decide. Previously only the ordered, range and set operators
  noticed: `equals` and `contains` compared against `undefined` and returned a confident `false`,
  and `not_equals` returned **`true`** — because `500 !== undefined` — so a rule that stated
  nothing read as a genuine breach and could raise a review signal. One predicate,
  `ruleOperandIssue()` in `src/condition-eval.js`, defines this and is shared with the coverage
  reconstruction in §8 so the two cannot drift apart.
- `equals`, `not_equals` and `contains` are total over any value and keep their legacy semantics
  exactly, including the `String()` coercion inside `contains`.
- Ordered operators resolve **temporally first**, then numerically. A date comparison requires
  both sides to be valid ISO-8601 instants. There is no prose date parsing.

## 4. Units

A rule may declare `unit`. The whitelist is `ms`, `s`, `sec`, `min`, `h`, `hr`, `d`, `%`, `pct`.

- A **bare number is read in the rule's declared unit** — the rule stating the unit of comparison,
  not an inference.
- An unannotated rule is **never** assumed to mean milliseconds.
- A value carrying a unit against a rule declaring none is `unknown`, not a guess.
- Units from different dimensions (a duration rule against `40%`) are `unknown`.
- `m` is deliberately absent because it reads as both minute and metre; byte units are absent
  because kB is 1000 under one convention and 1024 under another.

## 5. Evidence and conflict

`storedFactValues()` keeps its deterministic winner — newest `validFrom`, then descending `id`.
Storage behaviour is unchanged.

**Expiry is read at read time (changed 2026-09-14).** A candidate whose
`effectiveFactExpirationBoundary()` is at or before the evaluation instant is not applicable
evidence, whether or not `maintain()` has run since that instant passed. `maintain()` is what
flips `status` to `expired` and stamps `temporal.validTo`; before this, evaluation consulted only
those persisted marks, so the same evidence produced one `reusableAttempts` entry before a
maintenance run and none after it. The boundary instant itself is already expired, matching
`maintain()` exactly — both read the one canonical policy in `src/fact-validity.js` rather than
two copies of the temporal rules. When every applicable fact for a required condition has expired
the condition is `unknown` ("No fact recorded for this key"), never a pass, and it is reported.
Calling `maintain()` afterwards changes persisted housekeeping state only, never the answer.

When several **equally applicable** facts for one key disagree, the winner does not pass itself off
as settled evidence. The condition is reported in `conditionDiagnostics` with
`conflictingEvidence` listing every disagreeing observation — including when the verdict is
`false`, because a "no review needed" resting on contested facts is exactly the silent pass this
contract exists to prevent. A `true` verdict still fires when its evidence is contested;
suppressing it would hide the thing worth looking at.

Every reported condition names the evidence it was computed from (`factId`, and `observedAt` /
`validFrom` / `sourceClass` / `verificationStatus` where the fact records them). **Fields the fact
does not carry are omitted, never synthesised** — there is no invented previous value or
observation time.

**Returned details are detached (changed 2026-09-14).** **Every field** of a caller-visible detail
is a copy, not a reference into the stored rule or the stored fact — `expected`, `observed`,
`evidence` and `conflictingEvidence`, and equally `key`, `operator`, `unit`, the `title` and
`alternativesToReconsider` on a due entry, and `solution` on a reusable attempt. A caller holding a
returned condition — through `violatedConditions`, `conditionDiagnostics`,
`reusableAttempts[].satisfiedConditions`, or `maintain().due` / `.diagnostics` — may mutate it
freely: records, facts, relations, review signals and the journal are unaffected, later responses
recompute from canonical state, and export and rebuild are unchanged. Before this, an object- or
array-valued fact or rule was handed out by reference, so editing a returned value rewrote
canonical state with **no journal entry**, and a rebuild silently restored the old value —
a divergence between live state and the journal that nothing reported.

Detachment walks the detail's own keys rather than a list of fields expected to hold objects.
Naming fields would not be safe: write-time validation rejects an object `operator` or `unit`
(§7), but **stored records are lenient** and preserved verbatim, so a rule written by another build
can carry an object anywhere. The walk is field-by-field rather than one JSON round-trip of the
whole detail because a detail may legitimately carry `observed: undefined` ("no fact recorded for
this key"); a round-trip would drop that key instead of reporting it, and callers read key
presence.

## 6. Intentional behaviour changes

These are corrections, not compatibility breaks hidden behind a claim of equivalence:

| Before | After | Why |
| --- | --- | --- |
| An unsupported operator evaluated to `false` forever | `unknown`, reported | A typo'd `gte` meant a condition that could never fire, and nothing said so |
| `Number("250ms") > 200` → `false` | `unknown`, or decidable when the rule declares `unit: 'ms'` | NaN comparisons are always false, so unreadable evidence read as safety |
| `null` / empty / non-numeric against an ordered operator → `false` | `unknown` | Same reason |
| A caller-supplied `unit` was silently dropped by `normalizeRules` | Preserved and used | The unit never reached any comparison |
| Stored rules using `gte`/`lte`/`between`/`in`/`not_in` were inert | Now evaluate | They were in the vocabulary callers wrote but not the one the evaluator read |
| Returned condition values referenced canonical rules and facts | Detached copies (§5) | Editing a returned value rewrote stored state with no journal entry |
| Legacy free-text `reusableWhen` conditions were discarded before the ALL decision (§9) | Counted, and `unknown` | An ALL over a subset reported an attempt reusable on evidence that never settled it |
| A signal was identified by `(decisionId, reason)` (§8) | `(decisionId, reason, coverage)` | Two thresholds on one fact key share a reason, so a new breach inherited an old acknowledgement |
| Evaluation treated a fact as current until `maintain()` marked it expired (§5) | The canonical expiration boundary decides at read time | The same evidence answered differently before and after a maintenance run |

Five of these rows change behaviour **on existing stored data**: a rule that never fired may now
fire; an attempt previously reported reusable on a free-text condition no longer is; an
already-expired fact stops satisfying conditions before the next `maintain()`; and a decision with
two rules on one fact key raises a second, open signal where it previously reused the first. All
are listed in `CHANGELOG.md` for that reason.

Valid legacy behaviour is unchanged: string/token rules still match `changedFacts` only, and the
five original operators return exactly what they returned before for inputs they could evaluate.

## 7. Write-time validation versus stored data

`normalizeRules(rules, { strict })` has two modes, mirroring the envelope-versus-entity asymmetry
already used for schema versions:

- **Caller writes are strict.** `addDecision()` and `addAttempt()` reject an unsupported operator,
  an unsupported unit, an empty key, or a **missing operand**, so a typo fails loudly instead of
  becoming a condition that can never fire. Legacy free-text conditions are still accepted.
- **Stored records are lenient.** An operator this build does not recognise is preserved
  **verbatim** on import and migration, and evaluates to `unknown`. It is never rewritten onto a
  meaning we guessed, because losing a record written by another build is worse than keeping one
  we cannot interpret. A stored rule with **no operand** is likewise kept exactly as stored and
  evaluates to `unknown` (§3); no operand is invented for it.

**An absent operand is never written as `undefined` (changed 2026-09-14).** `normalizeRules` used
to emit `{key, operator, value: undefined}` for a rule that carried no operand. Two consequences,
both fixed by omitting the field instead:

- Stored state is plain JSON and `undefined` is not, so every later `clone()` of that record threw
  — one such rule arriving through the lenient import path took `exportData()` and `context()` down
  for the whole graph. A caller write was already rejected by that same throw, but reported
  `Values must be plain JSON data`, naming neither the rule nor the operand; strict mode now says
  `A structured rule requires a value for operator <operator>`.
- `JSON.stringify` **drops** an `undefined` field, so any identity derived from such a rule
  silently shrank to a shorter shape — the collision §8 guards against.

## 8. Acknowledging a review (changed 2026-09-14)

Entries in `review()`, `maintain().due` and `context().openReviews` carry two additive fields:

| Field | Meaning |
| --- | --- |
| `reviewSignalId` | The identifier `shadowgraph_ack_review` takes as its `id`. |
| `reviewSignalStatus` | `open` or `acknowledged`. |

The status is present because `due` is **recomputed from current evidence on every call and does not
drop an acknowledged entry**. An acknowledged review keeps appearing, so a caller must read the
status before acting rather than treating presence as "needs attention".

**Signal identity (corrected 2026-09-14).** A signal is identified by `(decisionId, coverage)`.

`reason` is **not** part of the identity, and the earlier statement that `(decisionId, reason)` was
the identity is withdrawn. `reason` is a readable cause list built from fact keys, and it failed as
identity in both directions:

- **Too coarse.** Two rules on one fact key both read as that key. Given alternatives carrying
  `lag >= 500` and `lag >= 1000`, a breach at `lag = 600` and a breach at `lag = 1200` — where the
  second, stricter alternative is now breached too — both produce the reason `lag`, so the newly
  applicable breach silently inherited the acknowledgement of the narrower one.
- **Too unstable.** It is built in stored-rule order, so exporting a decision and re-importing it
  with its alternatives in a different order turned `lag, load` into `load, lag` and reopened an
  acknowledged review that covered exactly the same breaches.

Coverage is a sorted set that already distinguishes everything `reason` distinguishes and more, so
`reason` was removed from the identity rather than canonicalised: it costs no discrimination, and
sorting the cause list would misreport the order the rules are actually stored in. `reason` is
still reported, exactly as built.

`coverage` is a sorted list of stable per-condition identifiers: the carrying alternative's `id`,
which is assigned at write and persists through export, import and rebuild, plus the rule named by
canonical content rather than by position, so reordering `reopenWhen` does not reopen a settled
review. Matches with no structured rule behind them — a `changedFacts` token, `review date
reached`, `decision outcome failed` — carry their own text.

The invariant is that **an acknowledgement covers exactly the breach set it acknowledged**:

- the same conditions still breached → still `acknowledged`;
- an additional, previously unacknowledged condition breaching → a **separate** signal, `open` and
  visible in `context().openReviews` and `getReviewSignals({ status: 'open' })`;
- the breach set narrowing back to the acknowledged one → that signal, still `acknowledged`.

`coverage` is persisted on the signal and travels through export, import and restart. It is
**not** repeated on `due` entries, where it would duplicate `violatedConditions`.

**Legacy signals without `coverage` — exact fallback semantics.** A signal persisted before
`coverage` existed is stored under the two-element `(decisionId, reason)` key and does not state
its scope. The rule is: **an acknowledgement may only cover conditions it can be shown to have
covered.**

1. The legacy signal is **left exactly as stored** — never re-keyed, never stamped with a
   `coverage` field, never deleted, its `id`, `status` and `acknowledgedAt` untouched. It remains
   visible through `getReviewSignals()` as historical data.
2. When a current breach set finds no signal under its own `(decisionId, coverage)` key, the legacy
   signals on that decision are examined. Each one's stored `violatedConditions` are
   **reconstructed** into coverage identifiers: every entry names the `alternativeId` that carried
   the rule plus the rule's `key`, `operator`, `expected` value and `unit`, which is exactly what a
   coverage identifier is built from. Candidates are ordered by `id`, so the outcome does not
   depend on import order.
3. A legacy signal is matched to the current breach set **only on an exact set equality** between
   its reconstructed coverage and the current coverage. On a match the current entry reports that
   signal's `id` and `status` — a pre-existing acknowledgement keeps applying, and the stored id is
   preserved.
4. Otherwise — **no match is made**, and the current breach set gets its own signal, `open` and
   visible. Reconstruction fails closed on every one of:
   - no `violatedConditions` at all, or an empty list;
   - an entry that is not an object, or is missing `alternativeId` or `key`;
   - an `operator` that is absent, not a string, or not one this build supports;
   - a `unit` this build does not recognise;
   - a **missing operand** — no `expected` field — or one that fails `ruleOperandIssue()`:
     a non-array for `in` / `not_in`, or anything but a two-element range for `between`.

   The operand rule matters most. `JSON.stringify` drops an `undefined` field, so reconstructing a
   rule from a condition with no `expected` produced `{"key":…,"operator":…}` — a *shorter*
   identity that could collide with a current rule stating no operand. Since §3 now makes such a
   rule `unknown`, it can no longer enter current coverage either; the two guards are independent
   and both are in place. Presence is tested, never truthiness, so a historical `expected` of `0`,
   `false`, `''` or `null` reconstructs normally.

Two properties make step 3 safe to rely on. Reconstruction can only ever *under*-state history:
`violatedConditions` records rule breaches and nothing else, so a historical match with no rule
behind it (a `changedFacts` token, `review date reached`, `decision outcome failed`) is absent from
it, and the reconstructed set is therefore always a subset of what was really acknowledged, never a
superset. And a rule edited or removed since reconstructs to an identifier that is not in today's
coverage, so the sets cannot match. Together these mean a legacy acknowledgement can be honoured
for a narrower or identical set, and **never widened**.

An earlier version of this fix stamped the *current* coverage onto a legacy signal so the new
lookup would find it. That is the silent widening this section exists to prevent — an
acknowledgement of `lag >= 500` alone came to cover `lag >= 1000` the moment the stricter
alternative began breaching — and it is withdrawn.

No schema version bump is required: `coverage` is an additive field on a payload the JSON and
SQLite stores both persist whole, and its absence is a meaningful, handled state rather than a
migration.

**Compact mode.** `shadowgraph_ack_review` is advertised in compact (13 tools). Before this, a
compact client could see reviews through `shadowgraph_context` but had no advertised route to
acknowledge one, and the only path to an id was `shadowgraph_maintain` — which also stales decisions
and expires facts, making it a maintenance write rather than a listing route. Listing reuses
`shadowgraph_context`; no tool was invented.

**Durability, stated precisely.** An acknowledgement survives a normal **process restart**, because
review signals are part of the persisted payload. It is **not** reconstructed by `rebuild()`:
signals are not journalled, so a projection rebuilt from the journal alone does not carry
acknowledgement state. That is a **known product backlog item, not fixed** — see
`docs/api-reference.md` and the backlog in `docs/handoff/cycle-status.md`. Proven in
`test/compact-review-ack.test.js`: restart preserves the acknowledgement, and a genuinely new breach
still surfaces.

## 9. Attempt reuse (`reusableWhen`)

`attempts[].reusableWhen` has been normalised and persisted since schema 4 with **nothing ever
reading it**. It is now evaluated by the same evaluator, and surfaces as
`context().reusableAttempts`.

Its combination rule is **ALL**, not `any` — the opposite of `reopenWhen`, deliberately:

- `reopenWhen` asks "is there any reason to look again?", so one satisfied rule is enough.
- `reusableWhen` asks "is every precondition for trying this again in place?", which is a positive
  claim, so every rule must hold.
- **Any unresolved or contested condition blocks the claim outright.** Uncertainty must never read
  as permission to retry.

**Every stored condition counts, including legacy free text (changed 2026-09-14).** `reusableWhen`
accepts the same string/token form `reopenWhen` does, and those strings were previously filtered
out *before* the ALL decision — making it an ALL over a subset. `reusableWhen: ["approval
required", {key: "ready", value: true}]` with `ready = true` reported the attempt reusable, because
the one condition the evaluator could not settle had been discarded rather than counted.

A free-text condition is now `unknown`: this evaluator is deterministic and has no way to prove
prose, so it says so instead of ignoring it. The text is **preserved exactly as stored** — never
interpreted, never migrated, never rewritten — appears verbatim as `expected` in
`conditionDiagnostics` with the reason `Legacy free-text condition this evaluator cannot verify`,
and holds the attempt out of `reusableAttempts` for as long as it is there. Attempts whose
conditions are all structured and satisfied are unaffected. As everywhere else in this contract,
`unknown` is not a failure of the attempt and reusable was never automatic retry authorisation —
the recorded failure stands either way.

A reported attempt **may be reconsidered**. It is not authorisation to retry, and the recorded
failure is untouched: a reusable attempt still appears in `failedAttemptsToAvoid`, and its stored
`result` and `resultClass` are unchanged.

### Attempt result classification

`attempt.resultClass` is optional and validated against `failed` · `succeeded` · `inconclusive`.

It is deliberately **not** called an outcome. `outcome` in this codebase is a decision-only,
single-slot concept that weights confidence and writes an `outcome.recorded` journal entry; none
of that applies to an attempt, and reusing the word would import those semantics by implication.

Precedence: a declared `resultClass` decides. When it is absent, the legacy
`/fail|regression|error/i` test over the free-text `result` still classifies, so **no stored
attempt changes meaning**. The two are distinguishable by whether `resultClass` is present, and an
inferred classification is never written back as though it were declared — a guess about prose is
not a verified failure. This matters for results worded `"no error, but the cache stayed cold"`
(a real failure the heuristic misses) and `"regression suite passed clean"` (a success the
heuristic would wrongly claim).

## 10. Regression evidence

- evaluator semantics, units, ranges, dates, novel values: `test/condition-eval.test.js`;
- core visibility of missing / unreadable / contested evidence, bounded diagnostics, scope
  isolation, acknowledgement, strict-versus-stored validation, restart persistence:
  `test/review-conditions.test.js`;
- attempt classification precedence, misleading result wording, ALL-combination for reuse,
  uncertainty blocking retry, and persistence/rebuild survival: `test/attempt-reuse.test.js`;
- pre-existing reconsideration acceptance from stored facts: `test/gap-regressions.test.js`;
- alternative-level rule matching: `test/v02-regressions.test.js`;
- detachment of returned condition details, legacy free-text `reusableWhen`, acknowledgement
  coverage across broadening and narrowing breach sets and across restart, read-time expiry
  including the exact boundary instant and before-versus-after `maintain()` equivalence, and
  JSON/SQLite coverage parity: `test/review-safety-regressions.test.js`;
- legacy signals without `coverage` (no recorded conditions, reconstructable conditions, exact
  match, broadening, narrowing, restart, both stores, compact list-and-acknowledge), detachment of
  object-valued `operator` / `unit` accepted by lenient import, and rule-reorder stability of
  acknowledgement identity: `test/review-acknowledgement-regressions.test.js`;
- missing operands across all ten operators, falsy operands staying valid, write-time rejection,
  an operandless imported rule neither breaching nor poisoning `exportData()`, and reconstruction
  failing closed on absent / malformed operand, operator and unit:
  `test/rule-operand-regressions.test.js`.
