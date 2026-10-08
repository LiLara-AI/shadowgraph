# Wider access transport contract

Wider access augments reads only. A request is a proposal, never a grant. Every
grant-bearing CLI, HTTP and MCP operation loads current authority and commits
its bounded audit through the existing revision/fence mechanism before returning
the result. A revision conflict reloads and repeats the entire operation, at most
three times. Failed saves return no read result; an uncertain committed save is
reloaded rather than refunded. Process-exit tests cover pre-commit atomicity,
not power-loss or fsync guarantees.

## CLI

`request-access <JSON>` proposes `scope`, `surfaces`, `expiresAt`, and `reason`.
Scope is a finite union of `projects`, `originIds`, and `legacyAttributions`
(`legacy_ambiguous` or `legacy_unattributed`), kept disjoint. Surfaces are `cli`,
`mcp`, and `http`. Expiry is mandatory and must be a future ISO instant.

`issue-access <JSON>` (alias `grant`) and `delegate-access <JSON>` (alias
`delegate`) issue owner authority only when actual stdin and stdout are TTYs,
the normalized bounds have been displayed, and the operator types `confirm`.
Delegation also displays and requires a positive `issuanceLimit`.
`grant --request <id>` resolves and displays the stored proposal before the same
confirmation. Flags, environment variables, configuration, and body booleans
cannot confirm. Decline, EOF, missing TTY, invalid bounds, and kernel refusal
produce a failing exit status.

`issue-access` may issue noninteractively only with `delegationId`. Scope,
surfaces, expiry, state, witness, and remaining issuance budget are rechecked.
Creation, witness, and budget consumption commit together. `idempotencyKey`
returns the existing receipt on an identical retry without consuming again.
Delegations cannot issue delegations.

`revoke-access <JSON>` / `discard-access <JSON>` take `accessId` and an optional
reason. `access revoke <id>` and `access discard <id>` are equivalent aliases.
`access-status` / `access status` returns explicitly privileged local inspection;
it is not memory content and is not exposed over HTTP or MCP.

`bind <JSON>` takes `project` and `reason`. It displays both discovered
worktree and common-repository paths, requires choosing `worktree` or
`shared_repository`, then displays and confirms the exact mapping. Opening a
workspace creates no mapping. A worktree mapping takes precedence over a shared
mapping. Runtime adapters reread the confirmed local file on each operation and strip caller
`binding` and `surface` fields. Scope-aware writes use the mapping as their base
ownership, never as grant authority. MCP verification projects the trusted
mapping into its existing strict `project` input when no project is supplied.

The worktree signal is `.shadowgraph/project-binding.json` at the discovered
workspace root. The shared-repository signal is `shadowgraph-project-binding.json`
inside Git's discovered common directory. Paths are locally resolved; caller
absolute paths do not select a binding file. Both use version 1, the selected
type and exact path, project, and `confirmed:true`. A missing worktree signal
permits the shared mapping; a malformed or unreadable signal fails closed.
Store `projectBindings` entries are confirmation history, never runtime fallback.
Binding first commits that confirmation audit, then backs up any existing file
and atomically replaces the signal. This is not an atomic transaction across the
store and filesystem: a failed file activation rejects the command and preserves
the prior file, but the confirmation audit can remain.

`attribute <JSON>` displays and confirms explicit `ids` or `originId`,
`targetProject`, and `reason`. It preserves material identity and provenance and
uses the existing `entity.attributed` journal vocabulary. It accepts no grant as
write authority.

## HTTP and MCP

HTTP adds only `POST /access-requests`, `POST /access-grants/revoke`, and
`POST /access-grants/discard`. MCP full mode adds only
`shadowgraph_request_wider_access`, `shadowgraph_revoke_grant`, and
`shadowgraph_discard_access`, plus `shadowgraph_bind` and `shadowgraph_attribute`,
which only propose (owner decision D3, 2026-10-08). Bind requires mapping type,
project and reason; attribution requires IDs or exact origin, target project and
reason. A proposal writes, applies and looks up nothing: no binding file, store
entry, journal event or audit, and no lookup of the named identifiers, so it
neither changes ownership or bindings nor discloses whether a record exists. It
returns the CLI verb and input the owner runs; `bind` and `attribute` at the CLI
apply it after terminal confirmation. A grant is refused as write authority. A
binding or attribution an MCP call applied before D3 stays as it was recorded,
with `surface: 'mcp'` on its event: nothing relabels it as owner-confirmed. There
is no HTTP binding or attribution route. Neither surface has an issuer or authority-import
operation. Existing HTTP bearer, Host, Origin, and body-size protections remain.

Invalid CLI issuance preflight and attempted unavailable HTTP/MCP issuance
operations also persist a bounded refusal aggregate. Recording that refusal
never dispatches to an owner issuer. HTTP admission checks still run first.

Read operations accept `accessId` or its documented alias `grantId`.
Conflicting identifiers fail closed in the kernel. Runtime surface is fixed by
the adapter. An invalid grant preserves ordinary own-scope reads and reports a
limitation. Revocation and expiry are checked at the next operation, including
long-lived servers and inherited expansions.

Effective grant metadata is null or `{accessId, expiresAt, surface}`.
`readProvenance` is a separate optional result field with version 1, original
request project/origin, original `accessId`, scope, surfaces, and expiry.
Reusing it cannot widen the original bounds; authority is revalidated. Redaction
omits provenance. Public export and redaction remain memory-only views.

Grant-capable MCP tools declare `readOnlyHint:false` and `idempotentHint:false`
because grant use/refusal durably updates audit. Ordinary own-scope reads still
do not save. The effects test measures both paths; lifecycle calls persist, and
restore retains its separate backend commit.

## MCP catalog accounting

PR12 adds five full-mode tools (33 normally, 34 with the optional verifier).
Compact mode remains 14 tools. Plan v1.4.4 PR-16 later adds the compact
`shadowgraph_review_context`: 34 full, 35 with the verifier, 15 compact. Required grant inputs, the `grantId` alias,
effective-grant output fields and bounded provenance schemas increase wire
bytes. Descriptions were shortened while retaining routing and effect claims;
existing description ceilings remain unchanged (350 per tool; 9,100 full,
9,400 with verifier, 4,750 compact).

Measured UTF-8 bytes of `JSON.stringify(result.tools)` with
`node scripts/mcp-wire-size.mjs --json`:

| Catalog | Bare | Annotated | Structured | Description characters |
|---|---:|---:|---:|---:|
| Full | 49,945 | 53,433 | 234,621 | 9,047 |
| Full with verifier | 50,861 | 54,454 | 238,936 | 9,396 |
| Compact, either configuration | 32,286 | 33,769 | 149,043 | 3,947 |

Engineering wire ceilings retain approximately 2% headroom: full
51,000 / 54,600 / 239,400; verifier full 51,900 / 55,600 / 243,800; compact
33,000 / 34,500 / 152,100. Prior ceilings were respectively
44,500 / 47,500 / 203,000; 45,500 / 48,500 / 207,500; and
31,500 / 33,000 / 134,000. Structured cost includes the repeated portable inline
schemas; this catalog intentionally has no shared schema references. This is
contract accounting for PR12, not a campaign, benchmark, or operational audit
performance-threshold change.

## Limits retained

Local filesystem writers can fabricate authority and its witness outside the
product. This boundary is not an enterprise identity system. The old ID-only
outcome, status, and acknowledgement transport arms remain unchanged for PR13.
Other deferred input/schema/dashboard alignment and caller-ID policy remain
outside this change.
