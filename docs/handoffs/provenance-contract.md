# ShadowGraph — Provenance Contract (G2)

**Status:** implemented in Phase 2 (2026-08-25); U-1 is accepted as unverified-only for 0.31.0. Applies to `addFact()` and `addDecision()` in `src/shadowgraph.js`.
**Scope:** G2 only. Does not change `review()`, lifecycle, search, purge, event payloads, or MCP.

---

## 1. Official source classes

Exactly four, taken from `docs/shadowgraph-security-and-safety.md`:

| Class | Meaning | Can ShadowGraph confirm it? |
| --- | --- | --- |
| `agent_claimed` | An AI agent asserted this. No corroboration. | n/a — it *is* the unconfirmed baseline |
| `tool_observed` | The agent says a tool/command produced this. | ❌ **No.** Arrives as a string, indistinguishable from a fabrication |
| `human_confirmed` | The agent says a human confirmed this. | ❌ **No.** No human-in-the-loop channel exists |
| `production_verified` | The agent says production behaviour confirmed this. | ❌ **No.** No production telemetry channel exists |

The class records **what was claimed about origin**. It is a claim, not a proof.

## 2. What `verified` means — and why nothing can be `verified` at creation

`verificationStatus` vocabulary is unchanged: `unverified` · `verified` · `contradicted` · `expired`.

**Rule: no input to `addFact()` can produce `verified`.**

Rationale: `verified` must mean "ShadowGraph confirmed this through a channel the writer does not control." No such channel exists. Every input — the `source` string, any reference string, the `verificationStatus` field — arrives through the *same* untrusted path: the agent's own tool call. Deriving `verified` from any of them means `verified` only ever means "someone typed something", which is precisely the defect G2 names, and it violates the security doc's rule *"Never promote an agent assertion to a verified fact."*

**Honest consequence, stated plainly: ShadowGraph currently cannot represent a verified fact.** `verified` remains in the vocabulary for (a) legacy data already on disk and (b) a future verification mechanism. It is unreachable from `addFact` input. That is a deliberate, documented capability gap, not an oversight.

Statuses a caller **may** request:

| Requested | Result | Why |
| --- | --- | --- |
| `unverified` | accepted | non-elevating; it is the default anyway |
| `contradicted` | accepted | **lowers** trust; fail-safe direction |
| `verified` | ❌ **throws** | elevation attempt — see §4 |
| `expired` | ❌ **throws** | lifecycle-owned; set only by `maintain()` |
| anything else | ❌ throws `Invalid fact verificationStatus` (pre-existing message) | unchanged |

## 3. "Verifiable reference" — NOT implemented, needs a separate decision

A verifiable reference would be a pointer ShadowGraph can independently re-check (a CI run URL it fetches, a signed attestation it validates, a file hash it recomputes, an OS-level human-confirmation prompt).

**We have none of these, and none can be added inside G2's scope:**

- Facts have **no** evidence field at all.
- Decision `evidence[]` exists but `normalizeEvidence()` only reshapes free text into `{source, type, confidence, observedAt, detail}`. Nothing is checked. An agent writes whatever it likes.
- Re-checking a URL means network access from MCP stdio, which `shadowgraph-security-and-safety.md` forbids without separate review.

**Therefore no `evidenceRef` field was added.** Adding an unverified reference field would create a field that *looks* like proof, invites callers to treat it as proof, and would later be cited as justification for re-enabling auto-verification. That is the trap this contract exists to close.

→ Recorded as unresolved decision **U-1** in §7 and in `next-actions.md`.

## 4. Unknown and non-canonical source values

Decision: **downgrade and preserve, do not reject.**

| Input | `sourceClass` | `sourceRaw` |
| --- | --- | --- |
| `'tool_observed'` | `tool_observed` | *(absent — already canonical)* |
| `'human-confirmed'` | `human_confirmed` | `'human-confirmed'` |
| `'Human Confirmed'` | `agent_claimed` (space is not an alias) | `'Human Confirmed'` |
| `'totally_made_up_source'` | `agent_claimed` | `'totally_made_up_source'` |
| `'model_inferred'` | `agent_claimed` | `'model_inferred'` |
| `null` / omitted | `agent_claimed` | *(absent)* |

Normalization: `trim()` → `toLowerCase()` → `-` becomes `_`. If the result is one of the four classes it is used; otherwise the class is `agent_claimed`.

**Why downgrade rather than reject:** a source label is a *description of origin*. An agent writing `source: 'human_confirmed'` may be honestly reporting its belief. Rejecting the write would discard a real fact over a labelling problem. Downgrading keeps the fact, records the claim verbatim for audit (security doc: *"preserve the original source label for audit"*), and simply declines to grant trust.

**Why `verificationStatus: 'verified'` throws instead:** that field is not a description of origin — it is a direct write to the trust field. A silent downgrade would leave the caller believing verification succeeded. Throwing is also consistent with the existing validation style in `addFact` (`A fact requires a non-empty key`, `Fact confidence must be…`, `Invalid fact verificationStatus`).

So: **claims about origin are recorded and downgraded; attempts to write trust directly are refused.**

## 5. Field shape (plain JSON only — no live objects)

Added to **facts**:

| Field | Type | Default |
| --- | --- | --- |
| `sourceClass` | one of the four classes | `'agent_claimed'` |
| `source` | same value as `sourceClass` | **legacy alias, retained** for backward compatibility |
| `sourceRaw` | string | present **only** when the raw label differs from `sourceClass` |
| `actor` | string \| null | `null` |
| `client` | string \| null | `null` |
| `sessionId` | string \| null | `null` |

Added to **decisions**: `sourceClass`, `actor`, `client`, `sessionId` (same semantics). Decisions have no `source` field today and none is added.

Non-string `actor`/`client`/`sessionId` throw. All values are JSON-serializable and survive `exportData()` → `importData()`.

## 6. Import / restore behaviour

`importData()` **preserves stored values as-is and never elevates trust.** A legacy fact on disk carrying `verificationStatus: 'verified'` keeps it.

Rationale: import is a migration/restore path, not an agent assertion. The security doc requires *"Do not rewrite user data in place without a backup or transactional protection."* Rewriting on import would also break round-trip stability, since `exportData`/`importData` runs on every persist and reload.

Accepted residual risk: someone with filesystem write access can hand-author a `verified` fact. In a local-first single-user threat model they already own the data. Documented, not mitigated.

## 7. Deferred capability decisions

- **U-1 — verification channel:** **accepted unverified-only for 0.31.0**. No out-of-band authorization or re-checkable evidence mechanism exists; ordinary tool input cannot produce `verified`. Revisit only after designing and testing a separately authorized mechanism.
- **U-2 — privileged `tool_observed` re-verification:** deferred. This would require an execution capability ShadowGraph does not have.
- **U-3 — legacy `verified` facts already on disk:** accepted provisional. Preserve legacy values for compatibility, never elevate them from ordinary input or replay; a future migration marker depends on U-1.
