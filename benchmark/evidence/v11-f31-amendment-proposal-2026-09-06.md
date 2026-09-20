# F31: `decisionRetrievalAccuracy` — proposal, not an amendment

**Status: PROPOSED, NOT AUTHORIZED, NOT ADOPTED.** This is a document, not an
amendment file. No `preregistration-amendment-004.json` exists, and if one did
nothing would read it: `v11-definition.mjs:652-757` loads amendments by explicit
filename (`001`, `002`, `003`) and hash-gates each against its `.sha256`
sidecar. Nothing in this file changes any gate, any hash, or any run.

---

## 1. The finding, corrected

An earlier statement of F31 said the model "is never given a decision id nor
asked to mint one". Checked against the code, that is **wrong in both halves**:

- **It is asked for one.** `outer-model.mjs` sends
  `Return exactly one JSON object with this field contract: {...}` and the
  contract's first entry is `"decisionId":"string|null"`. The field is requested
  on every phase.
- **It is given one**, for any arm that retrieves. A decision record is
  `{id, type, content}` and `id` is `decision:<sha256>`, so the record id is in
  the native context the prompt serialises. Four Phase-E units in run 002 show
  exactly this: `basic-memory` returned a real `decision:<hex>` copied out of an
  eight-record context.

What is actually missing is narrower, and worse:

> **Nothing in the frozen prompt contract says what `decisionId` should
> contain.** The system prompt does not mention it. The schema supplies a type
> and no semantics. A model that returns `null` has complied with everything it
> was told.

Run 002's distribution is what that predicts: `null` ×152; `'D001'` ×28, every
one of them in a unit with `nativeContextCount == 0`, i.e. invented by a model
with no context to copy from; a real `decision:<hex>` ×4.

## 2. Why this cannot be fixed the way F29, F30 and F32 were

Those three were harness defects — code disagreeing with frozen text, or the
harness corrupting its own measurement. Each was fixed without touching a frozen
byte.

F31 is not like that. Both available levers are frozen:

| Lever | Frozen where | Effect of changing it |
|---|---|---|
| The outer system prompt | hashed into `outerPromptBinding.systemSha256`, recorded in every raw run | changes the binding; runs before and after are not the same instrument |
| The response schema | **verbatim in `preregistration.json` → `promptProtocol.responseSchema`**, and hashed into `outerPromptBinding.responseSchemaSha256` | same, plus it edits the preregistration itself |
| The scoring rule | `preregistration.json` → `scoring.decisionRetrievalAccuracy` | changing the rule so the current data passes is precisely what the methodology forbids |

So **F31's dependency is an owner-authorised amendment.** It is not blocked on
evidence, infrastructure, or engineering effort. It is blocked on a decision that
is not mine to make.

## 3. Options, for the owner

**A — Give `decisionId` a meaning in the outer system prompt.** One sentence, to
the effect that when native context contains decision records, `decisionId` is
the `id` of the record the answer is drawn from, and `null` when there is none.
Changes `systemSha256` only; the preregistration is untouched; the scoring rule
is untouched and becomes measurable as written.

**B — Say it in the Phase B prompt only.** Narrower blast radius in principle,
but `auditOuterRequest` requires one common system instruction across all
phases, and the per-phase prompt is built by the same allowlisted builder, so
this is not obviously smaller than A in practice.

**C — Change the metric** to score Phase B on `choiceId` plus recalled ids and
drop the id requirement. This edits `preregistration.json`'s scoring text, and it
edits it in the direction that makes the existing data score better. Recorded
for completeness; **not recommended**, for that reason.

**D — Keep the rule and document what it measures.** Under the rule as frozen,
`decisionRetrievalAccuracy` is "did the arm surface a record id the model could
cite". That is a genuine memory capability, and the control's structural 0 is
arguably the correct answer for an arm with no memory. But then the metric must
be described that way, and it must be stated that it cannot distinguish "no
memory" from "memory that returned nothing".

**Recommendation: A.** It is the smallest change that makes the frozen rule
measurable without altering the rule, and it does not touch the preregistration.

One thing that improved while this sat open: F32's fix redacts the prior
`content.decisionId` echo from rendered context while leaving `record.id`
intact. So under A the instruction now has exactly one referent in the prompt
instead of two, and the null that used to sit next to it is gone.

## 4. What must accompany any of these

- A new amendment file and `.sha256` sidecar, wired into `v11-definition.mjs`'s
  explicit list, since nothing loads amendments by glob.
- A regression test pinning the new `systemSha256`, so a later drift is caught
  the way `auditOuterRequest` already catches divergence within a run.
- An explicit statement that runs before and after the amendment are not
  comparable on this metric.
- No re-scoring of `v11-acceptance-002`, which stays preserved and diagnostic.
