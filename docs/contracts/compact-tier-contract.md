# Compact-tier contract (G-5)

**Provenance.** This contract is the accepted P0 G-5 specification, reproduced **verbatim** between the two rules
below, followed by the P4 variance annex. Source: `05-WS04-G5-Specification.md`, 17 876 bytes, SHA-256
`74ec2ca0debfa74ac43e02bf597ac6f42a8f0b7f125c377511658c95a615ddb1`, a member of the P0 implementation review
package and accepted in the corrected P0 summary as "Register, G-5 specification, compatibility matrix exist — MET
(unchanged; accepted)". The specification's own status line describes P0, when nothing was implemented; what P4
implements, and how, is in the annex. Nothing in the specification's text is changed here. No [CONTRACT] item and no
G5-1…G5-10 fixture is varied; where the implementation departs from an [ENGINEERING] choice, the annex says how and
why.

---

# WS-04 — G-5 Specification: Compact Tier and Miss Detection

**Phase:** P0 · **Workstream:** WS-04 · **Gate:** G-5 (contract `11-implementation-readiness-gates.md`)
**Status:** WRITTEN SPECIFICATION ONLY. **Nothing here is implemented in P0.** No compact tier, miss ledger or
expansion tool exists in the repository, and none was added. This document must be **reviewed and accepted before
any compact tier is used for delivery** (G-5 severity: blocking; plan P4 entry condition).
**Governing text:** PC-08 (base + amendment (a)(b)), PC-24, PC-25, PC-13(a); AC-017, AC-018, AC-019, AC-020;
plan v1.4.4 §17, §13.1, §10.5, WS-21, WS-22, WS-23; R-11. **All 66 ACs remain `NOT_ASSESSED`.**

Each statement is tagged **[CONTRACT]** (required by the approved contract/plan) or **[ENGINEERING]** (a design
choice made here, with its reason, open to review).

## 0. G-5 pass items → where each is answered

| G-5 "passes when" item | Section |
|---|---|
| what the compact tier contains | §2 |
| how negation, scope qualifier and precondition survive compression | §3 |
| how it binds to the canonical revision | §4 |
| how staleness is detected | §5 |
| **how an actual miss is recorded when it happens** | §6 |
| what the agent sees when expansion fails or the record is unavailable | §8 |
| *(owner request)* deterministic expansion | §7 |
| *(owner request)* safe fallback | §9 |

## 1. Tiers and the facts they rest on

| Tier | Content | Exists at v0.41.0? | Canonical |
|---|---|---|---|
| **T0** | Existing four-signal RRF ranking (`hybridSearch`: lexical, semantic, graph, temporal) with a per-signal availability report (`src/hybrid-search.js:292-295`) | **yes** | no |
| **T1** | One derived **claim line** per canonical record (this spec) | **no** — `context()` declares `losslessItems: true`; there is no light view today, so today's "no miss from compression" is structural, not earned (PC-08 amendment reason) | **no** — never |
| **T2** | The complete permitted canonical record | yes | **yes** |

[CONTRACT] T1 is a means, never the source of truth and never a mandatory payload format. Delivering a relevant
full record directly is permitted. Prohibited: indiscriminate or default full-history dumping, excessive irrelevant
context, a compact tier that is the **only** discovery path, and a light view with no miss-detection path.

## 2. What a T1 line contains

[CONTRACT for the decisive fields, ENGINEERING for the shape]

```
t1Line: {
  recordId, kind,                         // decision | attempt | memory | fact
  line,                                   // short text, derived deterministically (§2.1)
  claimClass,                             // quoted | entailed | ambiguous | unsupported (P3) | legacy_freetext | not_classified
  polarity: { negated, span },            // §3.1 — span is the verbatim negating text, never paraphrased
  scope: { project, memoryScope, environment, applicability },   // §3.2
  preconditions: { count, decisive: [ { kind, text } ] },        // §3.3 — reopenWhen / reusableWhen / assumptions
  status: { lifecycle, supersededBy, verification, correctedBy }, // current state and corrections
  outcome: { resultClass?, outcomeEvidenceState?, reasonState },  // attempts only; reasonState: recorded | unknown | not_recorded | legacy_freetext
  provenance: { sourceClass, sourceRef },
  boundRevision: { recordId, digest },    // §4
  derived: true, derivationVersion,
  decisiveOmitted: [],                    // §3.4 — names any decisive element that did not fit; non-empty => requiresExpansion
  requiresExpansion,
  expansion: { operation, recordId, digest }   // §7
}
```

### 2.1 How `line` is produced

[ENGINEERING] **Deterministically, from the canonical record's structured fields** (title/chosen/goal, rejected
alternatives with their reasons, status, outcome), by a versioned template (`derivationVersion`). **No model call.**
Reason: a deterministic projection cannot invent meaning, can be rebuilt identically at any time, and can be tested
by fixture. A generative summariser is outside G-5. Adding one later is a new derivation version and must pass §10's
fixtures plus the P3 verifier's six checked dimensions before it is used for delivery.

### 2.2 Size

[ENGINEERING] A per-line byte ceiling is set in P4 **by measurement** (`scripts/context-size.mjs`), not assumed
here. Only descriptive text may be shortened, and it is marked when it is. Decisive elements (§3) are never
shortened. A line that cannot carry them within the ceiling follows §3.4.

## 3. How decisive meaning survives

[CONTRACT] PC-08 base: *"Compression MUST NOT change negation, source attribution, causal uncertainty, lifecycle
status, or applicability."* AC-017 adds failure reason and correction.

### 3.1 Negation

- `polarity.negated` is copied from the P3 claim model's checked **polarity** dimension, not inferred from the line.
- `polarity.span` carries the negating text **verbatim** from the canonical field (for example "never retried").
  The template must not rephrase a negated clause into a positive one.
- A record whose decisive field is negated but whose claim is not yet classified (legacy, pre-P3) gets
  `claimClass: not_classified` and `requiresExpansion: true`. **No legacy negation is guessed.**

### 3.2 Scope qualifier

- `scope.project` and `scope.memoryScope` are always present. The line is scoped exactly like its record, and a T1
  read obeys the same `project_only` boundary as every other read path (PC-13(a); a new read path is non-conformant
  until it is shown to scope).
- `scope.environment` / `scope.applicability` carry recorded environment and applicability qualifiers verbatim (for
  example "on the EU tenant pool"). **An applicability qualifier is never dropped to fit the budget** (§3.4).

### 3.3 Preconditions

- `preconditions.count` is always present, so the agent can see that conditions exist even when their text is
  elided.
- `preconditions.decisive` carries, verbatim, every precondition that decides whether the experience applies:
  `reopenWhen` / `reusableWhen` rules and recorded assumptions. [CONTRACT, §17.4] A precondition is a **signal, not
  a gate**: an absent, unfired or `unknown` condition never suppresses the line.

### 3.4 When decisive meaning does not fit

[ENGINEERING] The line is **not** shortened silently. It is emitted with `decisiveOmitted` naming what was left out
and `requiresExpansion: true`, or the record is delivered as T2 instead (justified full record, PC-08(a)). A line
with a non-empty `decisiveOmitted` is **never presented as complete**, and the envelope's `complete` is `false` for
that response.

### 3.5 Status, corrections, uncertainty, provenance

`status` carries lifecycle, supersession and verification state, plus any correction reference. `claimClass` and
`outcome.reasonState` preserve uncertainty. `legacy_freetext` stays `legacy_freetext` and is **never** promoted to
`entailed` (plan §9.4). `provenance` carries the source class and reference. **A correction always changes the
record's digest and therefore stales the line** (§5).

## 4. Binding to the canonical revision

[ENGINEERING, on verified ground] **`boundRevision.digest` = SHA-256 of the canonical record's stable JSON
serialisation** (sorted keys, the same clone the kernel returns) at derivation time.

Why this and not an existing counter:

| Candidate | Why rejected / chosen |
|---|---|
| The store-level `revision` (fencing counter) | Global — it changes on **every** save, so it would stale every line on any unrelated write |
| Memory `version` | Exists only on `memory` records; decisions/attempts/facts have none |
| `updatedAt` | Not every canonical change touches it reliably, and timestamp ordering is not identity |
| Latest journal `seq` for the entity | Not every persisted change is journalled (review acknowledgement is persisted but not journalled, `docs/api-reference.md` §152), so a change could leave the seq unchanged |
| **Content digest of the record** | **Chosen.** Any change to any field changes it. Coarse (a non-decisive edit also stales the line), and that is the safe direction: a rebuild is cheaper than a stale line served as current |

## 5. Staleness detection

[CONTRACT §17.3] On **every** read that would serve a T1 line, the line's `boundRevision.digest` is compared with
the digest of the live canonical record.

| Observation | Action | Never |
|---|---|---|
| digests equal | serve the line | — |
| digests differ (edited, corrected, superseded, re-verified) | **rebuild the line on the spot** (a declared operational write, PC-25 / plan §13.1); if the rebuild cannot run within budget, serve T2 or report `limitation: { code: 'stale_compact_line' }` | serve the stale line as current |
| record absent (purged, hard-deleted) | drop the line; the read proceeds as if it never existed; expansion follows §8 | serve the line |
| record out of the caller's scope | the line is not visible (scoping runs before staleness) | reveal that a line exists |

The digest comparison is **read-side**, so the correctness of staleness detection does not depend on every writer
remembering to invalidate. Write-side invalidation (P8, PR-42) is an optimisation on top.

## 6. How an ACTUAL miss is recorded

[CONTRACT] PC-08(b): *"A light view that prevents discovery of an important full record is a product failure, and
MUST be detectable as one. The evaluation MUST be able to record an actual miss. Presence of the record on disk
never satisfies the criterion."* AC-019 names the required evidence: grounded relevant-record annotation, index
state, retrieval trace and agent outcome.

### 6.1 Definition

An **actual miss** is a **recorded event** that a record **known to be relevant**, by grounded evidence, was not
surfaced by the path under test. It is never an inference from similarity, and never satisfied by the record
existing in the store.

### 6.2 Where misses are recorded

| Source | Ground truth | Recorded when | Status in P0 |
|---|---|---|---|
| **Evaluation** (`scripts/retrieval-eval.mjs`) — the authoritative instrument | each case names its known-relevant records, and each must exist in the corpus and in the evaluated project (grounded) | per case, per engine or tier, per relevant record: `delivered` (inside the scored depth), `ranked` (returned below it), `expanded` (reached only through T1→T2 expansion — exists from P4), `missed` (not returned) | **Scaffolding landed in PR-02**: grounding check and `delivered`/`ranked`/`missed` from actual engine output; scoring unchanged |
| **Runtime miss ledger** (WS-22, P4) | (a) **fallback recovery**: T1 established no relevance, and the §9 fallback surfaced and delivered a record the T1 pass did not; (b) **explicit correction**: a user or agent correction names an in-scope record that should have been delivered for an earlier query | on either event, never on similarity alone | not built (P4, PR-28) |

### 6.3 What a miss event contains

[ENGINEERING]

```
miss: {
  missId, at, source: 'evaluation' | 'runtime',
  evidence: 'grounded_case' | 'fallback_recovery' | 'explicit_correction',
  scope: { project, requestState },
  queryDigest,                     // SHA-256 of the query; raw text only in the evaluation, where it is synthetic
  recordId, boundRevision,         // the relevant record and the revision the path saw
  tier: 'T0' | 'T1',
  stage: 'not_ranked' | 'ranked_not_delivered' | 'delivered_line_without_decisive_meaning',
  rank,                            // null when not returned
  signals: { lexical, semantic, graph, temporal },   // availability + matched count — settles EVG-10 per event
  reason                           // why it was not returned, from the retrieval trace
}
```

- `signals` copies the per-signal availability report, so **every miss states whether the semantic signal was
  populated** (EVG-10) rather than leaving that to a separate probe.
- `delivered_line_without_decisive_meaning` records the AC-017 failure mode: the record was delivered, but as a
  line that lost negation, scope or precondition. It is a miss even though the record id was returned.

### 6.4 Storage and lifecycle of runtime miss events

[CONTRACT PC-25 / plan §13.1] Runtime miss events are **derived operational data**. They are not canonical, never
replayed into the projection, and written as a **declared operational write** inside the measured budget of
WS-14. They are bounded (count cap measured in P4), scoped like every read path, and reached by purge and deletion
(P8). They hold a query **digest**, not the query text, so the ledger does not become a second store of private
prompts.

### 6.5 Receipt obligation

[CONTRACT] The P4 receipt must contain **at least one recorded miss** (plan P4 exit). The current evaluation
already records misses on its dev split (PR-02 receipt: search 4, retrieve 4, recall 2). That shows the
instrument works. **It is not the P4 receipt** and makes no claim about T1, which does not exist.

## 7. Deterministic expansion (T1 → T2)

[CONTRACT §17.3, AC-018; ENGINEERING for the operation]

`expand({ recordId, digest }, requestScope)`:

1. **Scope first.** Resolved inside the scope — and the grant id, if any — of the query that produced the line
   (boundary inheritance, plan §10.5). Out of scope → §8, with the same response as not-found.
2. **Revision check.** Live digest equal → return the live canonical record: it *is* the bound revision. Live
   digest different → return the **current** record, with `revisionChanged: true` and the bound digest, so the
   agent knows the line it acted on came from an older revision. **The old line's text is never returned as if it
   were the record.** Point-in-time expansion to the older revision (from journal payloads) belongs to AC-016 /
   WS-24, not here.
3. **No ranking, no model call, no randomness.** The same `(recordId, digest, scope)` over the same store state
   returns the same bytes.
4. Redacted fields stay redacted and are **named** as redacted (AC-018: "identifies redaction or unavailable
   evidence rather than pretending completeness").

## 8. What the agent sees when expansion fails or the record is unavailable

[CONTRACT AC-018, §17.3: "an explicit limitation, never a substituted summary"]

| Situation | Response |
|---|---|
| Record logically purged (tombstone) | `limitation: { code: 'expansion_unavailable', reason: 'purged', recordId }` — no content |
| Record hard-deleted or unknown id | `limitation: { code: 'expansion_unavailable', reason: 'unavailable', recordId }` |
| Record outside the caller's scope | **identical** to the unknown-id response — existence is not leaked (plan §10.5). *(The PR-01 harness records that today's by-id path does leak existence: `entity.existenceDistinguishable: true`.)* |
| Fields redacted | the record, with each redacted field named |
| Bound revision superseded | the current record with `revisionChanged: true` (§7.2) |
| Store unavailable / locked / degraded | `limitation: { code: 'expansion_unavailable', reason: 'store_unavailable' }`; the host's work is not blocked (PC-15) |

In every case the T1 line is **not** re-served as a substitute, and the response's `complete` is `false`.

## 9. Safe fallback

[CONTRACT PC-08(a): "A safe retrieval fallback MUST be permitted where the compact representation cannot establish
relevance, so that a single short sentence is never the sole, untested discovery path."]

The fallback is **T0 over live canonical records, delivering T2 within the byte budget**. It runs when:

- no T1 lines exist for the scope (not built, being rebuilt, derivation pending);
- T1 yields no candidate while T0 has candidates;
- every candidate line is stale and cannot be rebuilt within budget;
- a candidate line carries `decisiveOmitted` for an element the query touches.

The envelope declares `fallback: { used: true, reason }`. **An empty T1 result is never returned as "nothing
relevant"** while the fallback has not run. A record surfaced by the fallback that T1 did not surface is recorded
as a runtime miss (§6.2 a).

## 10. Fixtures G-5 requires before delivery use (definitions only — nothing executed)

| # | Fixture | Pass |
|---|---|---|
| G5-1 | Negated decision ("never retried") | line has `polarity.negated: true` and the verbatim span; delivered meaning is not positive |
| G5-2 | Failure reason on an attempt | `outcome.reasonState` preserved; `legacy_freetext` never shown as `entailed` |
| G5-3 | Scope qualifier ("EU tenants only") | the qualifier appears verbatim, or `decisiveOmitted` names it |
| G5-4 | Correction after derivation | digest mismatch detected; the line is rebuilt or reported stale; never served as current |
| G5-5 | Precondition (`reopenWhen`) present | `preconditions.count > 0` and the decisive rule appears verbatim |
| G5-6 | Purged record behind a line | expansion returns the `purged` limitation; no content; no substituted summary |
| G5-7 | Out-of-scope id vs unknown id | byte-identical expansion responses |
| G5-8 | T1 empty, T0 has the relevant record | fallback runs, delivers it, declares `fallback.used`, records a miss |
| G5-9 | Evaluation run | at least one grounded miss recorded with `signals` populated |
| G5-10 | Same expansion twice | byte-identical output |

## 11. Open engineering items (settled by measurement in P4, not by the owner)

- the per-line byte ceiling (§2.2);
- the runtime miss-ledger count cap (§6.4);
- the exact template text per record kind (`derivationVersion` 1).

None of these is an owner decision. None blocks review of this specification.

## 12. What this specification does not do

It implements nothing, changes no schema, runs no benchmark, and moves no acceptance criterion. AC-017, AC-018,
AC-019 and AC-020 remain `NOT_ASSESSED`. It does not authorise P4.

---

## Annex: P4 implementation and variances

Each entry names the specification section, what P4 does, and whether it departs from an [ENGINEERING] choice.
Every departure keeps the [CONTRACT] requirement it serves.

**A1. The bound revision and its closure (§4). Variance.** `boundRevision.digest` is SHA-256 over the
deterministic, key-sorted serialisation of `t1Inputs(record, { asOf, visible })` = `{ derivationVersion, asOf,
record }`, not of the record alone (plan revision 6, VAR-09).
- The record is the one a public, boundary-scoped read returned. An erasure token is never part of it, and its
  `embedding` is left out: it is derived from the record's text, which the digest covers.
- Derivation version 1 renders only the record's own fields; a linked record appears by its id alone. The
  caller's `visible` says whether each linked id (`supersededBy`, `supersedes`, `relatedTo`, `failedAttempts`) is
  inside the request's boundary, and by default none is: a link is rendered only when the caller says so. A link
  outside the boundary is taken out of the closure before rendering and hashing, so no entity outside the
  boundary can change a digest, and no line renders one. Callers that serve lines (PR-26, PR-27) pass the
  request's boundary.
- `asOf` is `null` or a valid ISO 8601 instant string (anything else is refused), and is hashed as the one
  instant it names, however it is written. Including it and `derivationVersion` means a new template or a
  different as-of instant never serves an old line as current (A5).

**A2. The line's shape (§2). Variance in shape only.**
- Every value a caller or a legacy writer supplied is written as JSON (strings quoted and escaped, other values
  as JSON), with the characters JSON leaves raw that could break or reorder a line -- C1 controls, DEL, the line
  and paragraph separators, the bidirectional controls, the byte-order mark -- escaped as well, so no stored text
  can read as part of the template, and nothing of any type is dropped. The kernel's own vocabulary -- statuses,
  classes, source classes, identifiers, instants -- is written bare when it has its expected form and as JSON
  when it does not. A rule's missing operator or operand is written as missing ("no recorded operator", "no
  recorded value"), never supplied. A field stored as one value where a list is expected
  (`alternatives`, `assumptions`, `reopenWhen`, `reusableWhen`) is carried as a one-item list.
- `polarity.span` is a list of `{ field, text }`, since a record may negate in more than one field; each `text` is
  the verbatim value (JSON for a value that is not a string).
- `claimClass` is the weakest of the record's stored claims and, for an attempt, its cause:
  `not_classified` < `unsupported` < `ambiguous` < `entailed` < `quoted`. A record with no stored claim is
  `not_classified`, which is every record before P7 writes claims; an attempt whose cause no verifier classified
  (`recorded` by hand, `unknown`, or `legacy_freetext`) is capped at `not_classified`. `legacy_freetext` is never a
  class: it is the attempt's `outcome.reasonState`, one of the PR-23 cause states, and it is never rendered as
  `entailed`. An attempt shown without a stored cause takes the state a public read derives for it.
- `scope.applicability` is the stored validity window of a fact or memory (`{ validFrom, validTo }`), and the
  line carries it as `valid from … until …`. A fact's end is the kernel's effective expiration boundary, the
  earliest of its declared expiry and validity ends; a memory's is its `temporal.validTo`. Other recorded
  qualifiers are rendered where they are stored: an attempt's `environment` (`in …`), a memory's `scope` (`for
  …`, when it names anything), and the decisive text fields verbatim.
- `status.correctedBy` is `null` in derivation version 1: a correction is carried by supersession
  (`status.supersededBy`) and by the digest, which any change to the record changes.
- Conditions are rendered as recorded history, never as instructions: "recorded reopen condition for …",
  "recorded reuse condition: …", "recorded assumption …", "rejected …, recorded reason …".
- The expansion handle is `{ operation: 'shadowgraph_expand', recordId, digest, asOf, derivationVersion,
  scope: { project, grantId }, derivedAt }` (VAR-09). It carries no token.

**A3. Negation (§3.1). Variance in source, kept fail-safe.** Before P7 no stored record carries a claim whose
polarity the verifier checked, so derivation version 1 reads every decisive value of the record -- its text
fields, a decision's outcome, the JSON of values that are not strings, rule values, and any status, result class,
verification status, source class, outcome-evidence state or cause state that is not one of the kernel's own
values (`T1_VOCABULARY` in `src/compact-tier.js`, held to the kernel's exports by a test) -- with `negationsIn`
(`src/verification.js`). The kernel's own values are vocabulary, not text (`not_applicable` negates nothing).
`negationsIn` uses the claim verifier's own word reader after combining marks are taken off (so an accented letter
cannot hide a negator), and the claim verifier's whole polarity lexicon. Only the text of an outcome or a state
itself -- an attempt's `result`, a decision's `outcome`, and a class or status outside the vocabulary -- leaves out
the words that state an outcome (`failed`, `error`, `pending`, …), since that is what an outcome says. A word is
also read as the Latin letters it looks like, through a small table of lookalike letters (Greek, Cyrillic and
Armenian letters, Latin small capitals), so a negator written wholly in lookalikes is caught; and a word mixing
ASCII letters with any other letter counts as negating (`nøt`). Both can over-count (`straße`, `50µs`), and
over-counting only asks for the full record; the lookalike table is hand-picked, not Unicode's whole
confusables list. A negated line requires expansion unless the line is classified (not
`not_classified`) and every negated value is the text of a stored `quoted` or `entailed` claim, ignoring letter
case and white space at either end: no negation is guessed away.

**A4. Size (§2.2). Settled by measurement.** `T1_LINE_CEILING` is 512 bytes of `line`. Measured over the
repository's own corpora (`scripts/context-size.mjs` seed: 40 decisions, 30 attempts, 106 facts; the retrieval
evaluation: 11 decisions), 187 full lines: median 206 B, p95 452 B, maximum 452 B, so every measured line is
carried complete. The ceiling counts bytes, separators included. Derivation version 1 renders no descriptive
text -- every part of a line is decisive -- so a part is carried whole or named in `decisiveOmitted` with
`requiresExpansion: true` (§3.4). Nothing is cut mid-part. The structured fields (`scope`, `preconditions`,
`status`, `outcome`, `provenance`) keep what they hold whatever the ceiling; any other part named in
`decisiveOmitted` is reached through expansion, which `requiresExpansion` points to.

**A5. Staleness (§5). Variance in mechanism.** Lines are derived on every read and never persisted (PC-08 permits
views produced dynamically), so a rebuild re-derives the line and is not a write; plan §13.1's T1-rebuild write is
never exercised. `t1Current(line, current, { asOf, scope, visible })` checks the line against the record it
names in the **request's** context -- its as-of instant, scope (grant included) and boundary, never the line's --
and derives the line afresh every time, so what it serves is never the copy it was handed:
- equal digests serve it as `current`;
- a changed record, or a line for another as-of instant, serves it `rebuilt` on the spot, naming the stale digest;
- when the caller cannot rebuild (the §5 budget branch), `{ status: 'stale', limitation: { code:
  'stale_compact_line' } }` with no content;
- a record that is gone, or that is not the one the line names, or no line at all, drops it.

A stale line is never served as current. Scoping runs before staleness: a line is only ever derived from a record
a boundary-scoped read returned.

**A6. The ceiling is a rendering bound, not part of the closure.** `ceiling` chooses which whole parts `line`
carries; it is not hashed. Two lines with one digest differ only in which parts they carry -- each naming in
`decisiveOmitted` what it left out, so neither is presented as complete -- and in the request's own
`expansion.scope` and `derivedAt`.

**A7. The hook path and the runtime miss ledger (§6, §9). Variance, recorded here as plan revision 6 requires.**
The delivery hook (P5) is write-free: it may run the §9 fallback and then declares `fallback: { used: true,
reason }`, but it persists no runtime miss. PC-08(a) requires only that a safe fallback be permitted; recording
an actual miss is the evaluation's duty (PC-08(b), AC-019), and the runtime ledger (PR-28) records fallback
recoveries on every non-hook read that runs the fallback.

**A8. Not in PR-25.** The §9 fallback and the default-path `relevant` block (PR-26), §7-§8 expansion (PR-27), and
the §6 runtime miss ledger (PR-28) arrive in their own change-sets, each adding its entry here.
