# Explicit wider reads and local authority

Ordinary requests resolve to either a selected project or an unresolved project.
An exact origin can read its own unattributed material without becoming a project.
The real project `default`, legacy ambiguous material, legacy unattributed material,
and origin-owned material are distinct. Capture coverage is not read permission.

A wider read names a stored grant with `grantId` (or `accessId`). A proposal ID and
a caller-supplied grant object confer no permission. Each operation checks current
state, scope, surfaces, absolute expiry, suspension, terminal tombstones, issuance
witness and applicable delegation restrictions. A refused grant leaves permitted
own-scope access available and reports the limitation. It never reveals whether an
otherwise hidden entity ID exists.

## Storage and issuance

Authority uses the existing extra-collection carrier, including `shadowgraph_extra`
on SQLite. No authority table, entity kind or journal type is introduced:

```js
access: { lineageId, entries: [/* request, grant or delegation */] }
accessRevocations: { lineageId, ledgerSeq, entries: [/* terminal tombstones */] }
```

An entry contains `accessId`, `type`, `state`, `scope`, `surfaces`, `reason`,
`createdAt`, `expiresAt`, `revokedAt`, `suspendedAt`, `suspendedReason`,
`terminalReason`, `issuedBy`, `issuanceEventId` and `derivedFrom`. Issued authority
also records `issuedInLineage`. A delegation adds `issuanceLimit` and
`issuanceConsumed`; remaining budget is derived. Lineage identifiers and ledger
sequence numbers describe provenance, never freshness or permission.

Scope is a finite explicit union of `projects`, `originIds` and
`legacyAttributions` arrays. The latter accepts only `legacy_ambiguous` and
`legacy_unattributed`. A name such as `all` is an ordinary literal project name;
there is no automatic all-project or similar-project sharing mode. Surfaces are
explicitly selected from `cli`, `mcp` and `http`.

Proposals write request state and an `access.requested` event. Owner issuance is a
local CLI operation requiring both actual standard streams to be TTYs, displayed
bounds and explicit confirmation. No flag, environment variable, configuration
setting, HTTP token or request-body boolean substitutes for confirmation.
HTTP and MCP expose proposal and narrowing operations, never issuance.

Only an owner-issued delegation permits noninteractive grant issuance. It cannot
create another delegation. Grant creation, witness creation and budget consumption
are one revision. Conflicting writers reload and recheck before retrying. An
idempotency key returns the same committed issuance receipt without another unit
of consumption. Expiry and exhaustion stop further issuance. A delegation's
expiry or exhaustion alone does not revoke its existing grants; revocation
cascades. Discard retains a terminal record and ledger tombstone.

`access.issued` is a required corroborating witness in `events`, not owner
confirmation and not an event stream from which authority is reconstructed.
Someone who can directly rewrite local files can fabricate both state and witness.
This is the disclosed local filesystem trust boundary, not enterprise identity.

## Reads, writes and derived results

The kernel carries one boundary through ranking, lookup, traversal, expansion,
context, review, public diagnostics, export and redaction. A wider read never
widens canonical mutation ownership. Existing own-scope evaluation effects remain:
`reviewContext`, `review`, `reconsider` and `maintain` can create their existing
own-scope signals; `context` is a read and creates none (plan v1.4.4 PR-16). A
wider evaluation is read-only, including when foreign evidence would otherwise
produce a new signal about an own decision. Maintenance changes only own records
and facts.

Full public reads apply the same named-reference visibility rule as compact T1:
`failedAttempts`, `relatedTo`, `supersedes` and `supersededBy` retain only targets
reachable in the resolved read boundary, including the requested memory scope
where that read has one. This also covers historical records, journal payloads,
public rebuild views, nested alternatives and expansion counterparts. Mutation
responses, including unchanged-status and idempotent replies, project references
within the returned record's owner and memory scope; a wider read remains a
separate grant-bearing operation. Legacy attribution review retains references
only within its declared administrative view. Unresolvable references are
withheld. Redaction applies this rule before caller-defined masking. Stored IDs,
links, journal history and privileged persistence/replay remain unchanged; a
scoped public export remains unsuitable for saving or restoring a store.

An explicit wider retrieval can return another project's technical experience,
its recorded outcome, proposed reason, conditions, evidence and uncertainty.
Its source project and local choices remain attributable. A project grant also
permits reading that project's private constraints: it is not lesson-only sharing.
There is no lesson selector or automatic generalization of local choices into
universal instructions. Relevance ranking does not narrow the grant's authority.

The automatic delivery hook resolves its covered workspace's project and does
not select a wider-read grant merely because one exists in the store. Explicit
cross-project retrieval and automatic hook delivery are distinct paths. Synthetic
CLI coverage of these paths is not proof of usefulness in a real model session.

Results identify a successfully rechecked grant in `completeness.scope.grant` as
`{accessId, expiresAt, surface}`. Otherwise it is null. Origin-only requests remain
project-unresolved even with a grant. Grant-bearing results also carry
`readProvenance`: the original request, grant ID and bounds. Follow-up expansion
with that provenance retains the original request and intersects its original
bounds with freshly checked authority; a new broader argument cannot silently
widen it. This provenance is a constraint, never authority by itself. No persistent
result cache or third request-resolution state is introduced.

Redaction omits reusable provenance and withholds the project display label with
the existing `projectLabelWithheld` flag. Null display metadata does not unselect
the real request. Public exports/redactions always exclude authority collections
and projectless authority audit, even under a valid wider grant, and retain their
fixed non-store discriminator. Privileged snapshots and backups preserve them.
Store-wide authority inspection is explicitly labelled `privileged_authority`;
public validation retains its scoped details and neutral whole-store verdict.

## Declared operational audit

Grant-bearing transport operations reload current state and persist operational
audit before delivery, with revision conflicts causing reload and recheck. Their
metadata declares the conditional operational write. Audit does not change memory,
journal projection, confidence, evidence or mutation ownership.

Issuance, proposal and terminal events are individual records. Use aggregates are
keyed by `(accessId, surface, UTC day)`; refusal aggregates additionally include
reason. Unknown identifiers are hashed rather than echoed into audit details.
Engineering-selected bounds are a 30-day aggregate window, the three most recent
samples, and at most 256 distinct keys per day plus one overflow aggregate.
Overflow keeps exact total counts and separate use/refusal counts while declaring
that individual key detail has been aggregated. No owner-selected bound is claimed.

Aggregates contain `count`, `recordsReturnedTotal`, earliest `firstAt`, latest
`lastAt` and bounded samples. Samples identify the resolved request scope and a
SHA-256 fingerprint of the exact granted scope used. Request labels over 128 UTF-8
bytes are represented by labelled SHA-256 digests; invalid surfaces use a fixed
`invalid` label. Failed operations roll back canonical effects before committing
their refusal audit. Repeated delivery updates a record rather than
appending an event. Required issuance witnesses and terminal evidence do not
expire while their authority remains referenced. Restore uses maximum counters,
earliest first/ latest last timestamps and explicit restored boundaries; restored
usage is a lower bound, never exact lost history or zero cost. Measurements must
state serialized bytes, journal entries, revision increments and elapsed time;
logical SQLite equality does not imply database-byte equality.

## Restore and explicit ownership administration

Supported restore never increases usable authority relative to the destination.
Memory recovery and authority eligibility are separate decisions staged under the
existing destination fence. Shared entries narrow monotonically; backup-only
active entries suspend; terminal entries and tombstones remain terminal; no readable
destination authority means recovered backup authority is unusable; requests remain
requests. State restrictions, bounds, budgets, timestamps and destination-only
tombstones survive repeated or chained restores. Restoring a witness or delegation
relationship cannot activate previously unusable destination permission.

A stale destination may already contain permission revoked only on a lost branch.
Restore cannot discover that lost event and does not claim freshness. No remote
revocation service or non-copyable identity scheme is introduced.

Binding is an explicitly confirmed local mapping file for either an individual
worktree or the shared repository. Merely opening a directory creates no binding.
Stored mapping entries and `project.bound` events record confirmation; the local
file is the activation signal. Confirmation audit precedes file activation, so a
failed file operation can leave a confirmation receipt while preserving the prior
signal. This is not an atomic transaction across the store and local file. Explicit
attribution names material IDs or an exact unattributed origin and a target
project; it preserves source identity, origin, observations, claims and provenance.
It uses the existing `entity.attributed` journal type and `attribution.changed`
audit event. No ownership is inferred from text. Legacy inspection remains a
separate read-only administrative view.

Project purge uses current ownership rather than historical project labels.
Relations follow endpoint fate, so reassignment does not make an unrelated purge
erase retained relationship history. Purging real `default` leaves both legacy
buckets and origin-owned material intact. Purge removes the affected project from
authority scopes while retaining unaffected selectors. Removing the last selector
revokes and tombstones that authority without deleting its witness.

Pre-access builds retain their historical restore-presence guard and memory-only
escape path. Older preservation-capable readers can still have different
validation/replay capabilities. A complete current-format preservation copy is
required before any destructive downgrade fork; ordinary save preservation is
not an operational rollback guarantee.
