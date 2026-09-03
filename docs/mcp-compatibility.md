# ShadowGraph — MCP Compatibility Status

**Last verified:** 2026-09-03 against official MCP specification/schema sources, `@modelcontextprotocol/inspector@2.4.0`, and the pinned `mcp-proxy@6.4.3` that fronts Glama’s generated container.
**Implemented revisions:** handshake `2024-11-05`, `2025-03-26`, `2025-06-18`, and `2025-11-25`, negotiated by `initialize`; modern `2026-07-28` through per-request `_meta` (dual-era stdio server).

## 1. Honest compatibility statement

ShadowGraph implements both eras in the current specification's terms:

- **Handshake:** `initialize` negotiates one of `2025-11-25`, `2025-06-18`, `2025-03-26`, or `2024-11-05`. The requested revision is echoed when this server implements it, and any other value is answered with `2025-11-25`, the latest revision it implements. `protocolVersion` is required: a missing, non-string, or empty value is `-32602`, not a revision to guess from. Everything the session receives afterwards follows the revision the server returned (§4).
- **Modern:** requests carrying the required `io.modelcontextprotocol/*` `_meta` fields use stateless `2026-07-28` semantics. `server/discover` is implemented and advertises every revision this server implements, newest first.
- An unsupported modern per-request version returns `-32022` with exact `supported` and `requested` data. `supported` lists every implemented revision; only `2026-07-28` is usable per request, because the others are negotiated through `initialize`.

An `initialize` request selects handshake semantics; it never causes the server to falsely echo a revision it does not implement, `2026-07-28` included. Modern clients select modern semantics with per-request metadata.

## 2. Implemented methods

Both eras cover the implemented primitives:

- `server/discover` (modern, mandatory);
- `initialize` and `notifications/initialized` (handshake);
- `tools/list` and `tools/call`;
- `resources/list` and `resources/read`;
- `prompts/list` and `prompts/get`;
- client notifications, defined strictly as valid JSON-RPC requests with an absent `id`, which execute normally but never receive success or error responses;
- JSON-RPC batches on stdio, in a session negotiated at `2025-03-26` (§4);
- JSON-RPC parse, invalid-request, invalid-params, method-not-found, unsupported-version, and tool errors.

An explicit `"id": null` is still a request and receives a correlated `id:null` response. Parse errors also receive `id:null`; they are not valid notifications. This suppression rule applies to every method, including successful no-id `initialize`, `tools/list`, and mutating `tools/call` messages—not only method names under `notifications/*`.

Modern complete results include `resultType: 'complete'` and server identity metadata. Modern cacheable lists/resources include explicit `ttlMs` and `cacheScope`. Modern tool execution failures are returned as `isError: true`; malformed calls and unknown tools remain protocol errors. Handshake result shapes never gain the fields a modern result requires; the optional members a session receives are covered in §4.

## 3. Tool modes and verifier boundary

| Mode | Verifier | Advertised tools |
| --- | --- | ---: |
| Full | not configured | 27 |
| Full | configured | 28 (`shadowgraph_verify_fact` is added) |
| Compact | either | 12 |

`SHADOWGRAPH_MCP_COMPACT=1` must be passed to the server process, not merely assumed from the Inspector launch shell. The automated gate uses Inspector's server environment option and verifies the returned list count.

### Tool inventory

The **12 compact tools** are the everyday agent workflow. They are also present in full mode:

| Tool | Purpose |
| --- | --- |
| `shadowgraph_context` | Load the working set for a project before a consequential task |
| `shadowgraph_remember` | Store scoped memory (`preference`, `profile`, `goal`, `instruction`, `procedure`, `episode`, `note`) |
| `shadowgraph_recall` | Hybrid lexical/vector/graph/temporal recall of scoped memory |
| `shadowgraph_record_decision` | Record a decision with assumptions, evidence, and rejected alternatives |
| `shadowgraph_record_attempt` | Record an attempt and its lesson |
| `shadowgraph_record_fact` | Record an observed fact with a `sourceClass` provenance claim |
| `shadowgraph_record_outcome` | Record `successful` / `mixed` / `failed` / `unknown` and update confidence |
| `shadowgraph_retrieve` | Bounded retrieval with declared completeness |
| `shadowgraph_search` | Content search across decisions, attempts, and facts |
| `shadowgraph_review` | Evaluate reopen rules against stored facts and persist review signals |
| `shadowgraph_validate` | Report graph diagnostics by severity |
| `shadowgraph_maintain` | Stale decisions past `reviewAfter`, expire facts, then review |

**Full mode adds these 15**, for 27 total:

| Tool | Purpose |
| --- | --- |
| `shadowgraph_update_status` | Move a decision through the documented lifecycle states |
| `shadowgraph_link` | Create an explainable relationship between two entities |
| `shadowgraph_traverse` | Walk relationships from an entity by depth and direction |
| `shadowgraph_supersede` | Replace a decision, persisting a `supersedes` relation |
| `shadowgraph_redact` | Produce a privacy-safe export; never mutates |
| `shadowgraph_purge` | Logical (default) or explicit irreversible hard project purge |
| `shadowgraph_purge_preview` | Show deletion counts without changing storage |
| `shadowgraph_review_signals` | Read persisted review signals |
| `shadowgraph_ack_review` | Acknowledge one review signal |
| `shadowgraph_repair_plan` | Return a non-destructive repair plan (`apply:false`) |
| `shadowgraph_journal` | Read journal entries with declared pagination |
| `shadowgraph_rebuild` | Replay the journal into a projection |
| `shadowgraph_backup` | Write a consistent snapshot to a destination path |
| `shadowgraph_restore` | Restore a validated JSON or SQLite backup |
| `shadowgraph_confidence_evidence` | Apply one keyed confidence contribution |

A 28th tool, `shadowgraph_verify_fact`, appears in full mode **only** when
`SHADOWGRAPH_VERIFIER_CONFIG` names a local trust configuration. The caller supplies just `factId`
and an evidence path inside the configured root — never verifier identity, key, signature, method,
or target status. Compact mode stays at exactly 12 regardless.

Compact mode is a tool-advertisement choice, not lossy storage: the full relational graph,
memories, facts, alternatives, and outcomes are stored identically in both modes. Every tool listed
above declares an output schema except `shadowgraph_review` and `shadowgraph_review_signals`; §4
explains why.

Alongside tools, the server advertises exactly one resource, `shadowgraph://context`, and one
prompt, `shadowgraph_consequential_task`, in both modes. Reading that resource can generate review
signals, so the server serializes and persists it like a mutation.

## 4. Tool metadata by negotiated protocol revision

Tool `annotations` entered the specification in 2025-03-26, and `outputSchema` with
`structuredContent` in 2025-06-18. `initialize` negotiates a revision (§1), and the optional members
a session receives follow **the revision the server returned**, never the one the client asked for:

| Client requests in `initialize` | Server returns | Tool objects carry | A successful `tools/call` returns |
| --- | --- | --- | --- |
| nothing yet: no `initialize` sent | — | `name`, `description`, `inputSchema` | `content` |
| `2024-11-05` | `2024-11-05` | `name`, `description`, `inputSchema` | `content` |
| `2025-03-26` | `2025-03-26` | plus `annotations` | `content` |
| `2025-06-18` | `2025-06-18` | plus `annotations` and `outputSchema` | `content` plus `structuredContent` |
| `2025-11-25` | `2025-11-25` | plus `annotations` and `outputSchema` | `content` plus `structuredContent` |
| anything else, such as `2026-07-28`, `2099-01-01`, or `not-a-revision` | `2025-11-25` | plus `annotations` and `outputSchema` | `content` plus `structuredContent` |
| modern `_meta` `2026-07-28`, no handshake | not applicable | plus `annotations` and `outputSchema` | `content` plus `structuredContent` |

A missing, non-string, or empty `protocolVersion` is rejected with `-32602` and leaves the session
exactly as it was, still at the members of the revision it had already negotiated, or none. A later
`initialize` renegotiates and replaces them.

**Fallback.** A server that does not implement the requested revision must answer with another it
does, and the specification says that SHOULD be the latest. This server answers `2025-11-25`. It is
the latest handshake revision implemented here, so the answer never understates what the server can
do, and it matches what the reference TypeScript SDK server does with an unrecognised request. A
client too old to speak it disconnects, which the lifecycle already requires of a client that cannot
use the server's answer. What the fallback never does is let the requested value select metadata by
itself: a future or unknown revision reaches the structured tier only because `2025-11-25` was
negotiated and both peers agreed on it.

**Batches.** The 2025-03-26 base protocol requires a server to accept JSON-RPC batches: a JSON array
on one stdio line. This server accepts them in a session negotiated at that revision, and only
there, because 2024-11-05 never defined batching and 2025-06-18 removed it. Members are handled in
order through the same dispatch; the responses for members that carry an `id` are returned as one
JSON array on one line; a batch made only of notifications produces no output; an empty array
receives a single `id:null` `-32600` error object; a member that is not a valid request object
receives an `id:null` `-32600` entry inside the array; and an unparseable line receives a single
`-32700` object whether or not it looked like a batch. Members of one batch are strictly ordered,
though a separately sent line may be served between two of them while an asynchronous member is
still running, which JSON-RPC 2.0 permits. Every member is dispatched before the next line is read,
so a message sent alongside a batch cannot overtake one of its members. Initialization must be the
first interaction, so a batch is not a way to negotiate: send `initialize` as its own message first,
and an `initialize` with no `id` negotiates nothing at all, because a handshake with no response
agrees nothing. Every reply in a batch is held until the last member finishes, so a very large batch
costs memory in proportion to its results.

**Compatibility guarantee.** For a session negotiated at `2024-11-05`, the top-level member set of
every tool object (`name`, `description`, `inputSchema`), the tool names and the 27/12/28 counts, and
the serialized text result (`content[0].text`, the tool's return value as
`JSON.stringify(value, null, 2)`) are the same as before this metadata existed, and that text block
is identical in every tier: `structuredContent` is an addition beside it, never a replacement. Tool
objects are **not** byte-identical to earlier releases. Descriptions were rewritten, every
input-schema property gained a description, `shadowgraph_traverse` now documents `project` and
`scope`, and `shadowgraph_maintain` declares that `changedFacts` holds strings. Those are additions
to how the tools are described, not changes to what they accept or return, which is what
[ADR-0006 §6](adr/0006-unified-memory-kernel.md) requires. A tool execution failure never carries
`structuredContent`.

All metadata lives in one place, `src/mcp-tools.js`, which also supplies the advertised list, the
unknown-tool guard, and the set of tools whose successful call is followed by a durable save.

### Behavioural annotations

Annotations are hints, and every one here is derived from what the handler actually does to the
server's environment. `readOnlyHint` means a call leaves the durable store byte-identical and writes
no file. `destructiveHint` means a call can remove stored state, overwrite an existing record without
leaving the previous value in the journal, or replace a file outside the store; transitions that keep
history (status changes, supersession, fact supersession, memory invalidation) are additive and are
not destructive. `idempotentHint` means a repeated identical call has no further effect on that
environment — which includes the durable revision, not only the domain result. `openWorldHint` means
the tool reads or writes a caller-selected path outside the store.

`test/mcp-tool-effects.test.js` drives the running server, calls every tool twice with identical
arguments, records the durable revision, the journal, the stored entities, the timestamps, and the
files written, and derives all four hints from those observations. Every row below is what that test
proves, not a description maintained beside the code, with one exception: it runs with no embedding
endpoint configured, so the two "only with an embedder" cells are covered by the catalog tests in
`test/mcp-tool-metadata.test.js` instead, which build the catalog both ways.

| Tool | readOnly | destructive | idempotent | openWorld |
| --- | :---: | :---: | :---: | :---: |
| `shadowgraph_search` | yes | no | yes | no |
| `shadowgraph_retrieve` | yes | no | yes | no |
| `shadowgraph_recall` | yes | no | yes | only with an embedder |
| `shadowgraph_traverse` | yes | no | yes | no |
| `shadowgraph_validate` | yes | no | yes | no |
| `shadowgraph_journal` | yes | no | yes | no |
| `shadowgraph_rebuild` | yes | no | yes | no |
| `shadowgraph_review_signals` | yes | no | yes | no |
| `shadowgraph_purge_preview` | yes | no | yes | no |
| `shadowgraph_repair_plan` | yes | no | yes | no |
| `shadowgraph_redact` | yes | no | yes | no |
| `shadowgraph_record_decision` | no | no | no | no |
| `shadowgraph_record_attempt` | no | no | no | no |
| `shadowgraph_record_fact` | no | no | no | no |
| `shadowgraph_record_outcome` | no | no | no | no |
| `shadowgraph_link` | no | no | no | no |
| `shadowgraph_maintain` | no | no | no | no |
| `shadowgraph_review` | no | no | no | no |
| `shadowgraph_context` | no | no | no | no |
| `shadowgraph_remember` | no | no | no | only with an embedder |
| `shadowgraph_confidence_evidence` | no | no | no | no |
| `shadowgraph_update_status` | no | no | no | no |
| `shadowgraph_supersede` | no | no | no | no |
| `shadowgraph_verify_fact` | no | no | no | **yes** |
| `shadowgraph_ack_review` | no | **yes** | no | no |
| `shadowgraph_purge` | no | **yes** | no | no |
| `shadowgraph_backup` | no | **yes** | no | yes |
| `shadowgraph_restore` | no | **yes** | no | yes |

Six of these are worth stating plainly, because a reader would otherwise guess wrong:

- `shadowgraph_context` and `shadowgraph_review` **are not read-only**. Both evaluate reopen rules
  and persist review signals, which is why the server saves after them.
- **Only the eleven pure reads are idempotent.** Every other tool commits a new durable revision on
  each successful call, even when the domain result is a no-op: re-acknowledging a signal, setting
  the state a decision already has, repeating a supersession, remembering identical text, applying an
  evidence key that was already counted, or re-verifying the same attestation all leave the domain
  alone and still advance the store's revision. That revision is the concurrency token other writers
  compare and the one `shadowgraph_redact` reports, so a repeat is not without effect on the
  environment even when the visible result is unchanged.
- `shadowgraph_ack_review` is **destructive**: it rewrites a signal's `status` and `acknowledgedAt`
  in place and appends nothing to the journal, so the previous acknowledgement cannot be recovered
  and a journal rebuild does not reconstruct it. A repeat replaces the timestamp again.
- `shadowgraph_backup` is destructive with respect to the *filesystem*: it overwrites an existing
  file at `destination` without warning, including one it wrote itself a moment earlier.
- `shadowgraph_verify_fact` is **open-world**: the caller chooses `evidencePath` and the server reads
  that file, exactly as `shadowgraph_backup` and `shadowgraph_restore` read and write caller-chosen
  paths. The path must resolve inside the verifier-configured evidence root, which bounds the reach
  but does not make it a closed domain.
- `shadowgraph_link` is **not** idempotent for a second reason beyond the revision: every call mints
  a new relation id, so repeating one duplicates the relationship. There is no unlink tool.

### Output schemas, and two deliberate omissions

25 of the 27 full-mode tools (26 of 28 with a verifier configured, 11 of 12 in compact mode) declare
an `outputSchema` and return `structuredContent` that conforms to it. Two do not:

| Tool | Why no output schema |
| --- | --- |
| `shadowgraph_review` | Returns a bare JSON array of due decisions. |
| `shadowgraph_review_signals` | Returns a bare JSON array of review signals. |

`structuredContent` must be a JSON **object** for 2025-06-18 and 2025-11-25 clients, and the official
TypeScript SDK additionally requires `outputSchema.type === "object"`. Wrapping either result would
be a change to what the tool returns, not a change to how it is described, so both keep their shape,
declare no schema, emit no structured content in any tier, and carry the return shape in their
description instead. `test/mcp-tool-metadata.test.js` and `test/mcp-tool-conformance.test.js` both
assert this exact pair, so an output schema cannot be added to one without the omission list being
updated deliberately.

The schemas are written to be portable and, more importantly, to be **satisfiable by data imported
from an older storage schema**. Advertising an output schema is a promise: a client that validates
structured results raises an exception when the promise is broken, so a schema that over-specifies
turns a successful read of legacy data into a user-visible failure. `required` therefore lists only
the keys a handler builds on every call, and `test/mcp-tool-metadata.test.js` validates every read
tool's schema against a store imported from schema 3.

### Advertised size, and where the detail went

A tool description is read alongside every other tool's, so its cost is paid on every listing. Each
one is capped at 350 characters and carries only what changes a caller's choice: what the tool does,
which sibling to use instead, and what it persists, destroys, or does on a retry. Field rules live in
the input-schema property descriptions, result shapes in the output schemas, and everything longer in
this document. `npm run size:mcp` (`scripts/mcp-wire-size.mjs`) reproduces the table below, and
`test/mcp-tool-metadata.test.js` enforces per-tool, aggregate, and per-tier budgets.

All figures are UTF-8 bytes of `JSON.stringify(result.tools)`, one boundary throughout; the JSON-RPC
envelope adds a constant 44 bytes. "Before" is this branch prior to the rewrite; "base" is the last
release before any of this metadata existed, when a tool object carried only `name`, `description`,
and `inputSchema`.

| Mode and tier | Base | Before | Now |
| --- | ---: | ---: | ---: |
| Full 27, bare | 17,839 | 52,215 | **41,680** |
| Full 27, annotated | n/a | 55,043 | **44,514** |
| Full 27, structured | n/a | 166,376 | **155,847** |
| Compact 12, bare | 12,310 | 33,454 | **28,254** |
| Compact 12, structured | n/a | 95,553 | **90,356** |
| Description text, 27 tools | 3,712 chars | 18,429 chars | **8,515 chars** |

Output schemas account for 111,308 of the 155,847 bytes in the full structured tier, and they were
not touched. An output schema is a promise a validating client enforces, so trimming one to reduce a
number would trade a real guarantee for a smaller figure. The reduction above comes from the
descriptions and from the input-schema property text that several tools share.

### Per-tool notes

Detail that used to sit in a description, kept here because it is worth having somewhere:

- `shadowgraph_search`, `shadowgraph_retrieve`, `shadowgraph_recall`, and `shadowgraph_journal` all
  return `{ items, page: { offset, limit, total, hasMore }, completeness }`, and `completeness` always
  declares what was omitted. The searchable content fields are listed in each tool's `query` property.
- `shadowgraph_context` returns five named collections, each with its own `returned`, `total`,
  `hasMore`, and `omitted` under `completeness.collections`, so truncation is attributable.
- `shadowgraph_record_fact` rejects `verificationStatus` of `verified` or `expired`: verification is
  not self-assertable and expiry belongs to `shadowgraph_maintain`. Writes for one key must arrive in
  non-decreasing `validFrom` order.
- `shadowgraph_record_outcome` appends a journal entry on every call, even when the outcome is
  identical, and a `failed` outcome makes the decision due for review.
- `shadowgraph_update_status` rejects an illegal move before any record, event, journal, or durable
  change. The legal moves are listed in its `status` property. Over MCP the failure arrives as
  `Tool execution failed`: only allowlisted domain messages cross that boundary, and the exact
  transition text is available through the library and HTTP surfaces, where
  [the API reference](api-reference.md) lists it.
- `shadowgraph_supersede` requires both decisions to exist, to differ, to share a project, and not to
  be already superseded or archived.
- `shadowgraph_maintain` returns `{ at, staleDecisionIds, agedDecisionIds, reviewSignals, due }`,
  where `agedDecisionIds` is a compatibility alias. Expired facts are journalled rather than listed.
- `shadowgraph_rebuild` returns `rebuildable:false` with a reason rather than presenting a partial
  projection as trustworthy; `skipped` and `legacy` explain every entry that was not folded.
- `shadowgraph_backup` resolves `destination` on the server, not on the caller's machine, and expects
  the storage backend's own extension: `.json` for JSON stores, `.db` for SQLite.
- `shadowgraph_restore` fails with a stable `issueCode` and lists retained rollback artifacts when
  cleanup could not be confirmed; if rollback itself cannot be confirmed the server refuses further
  work until it is restarted.
- `shadowgraph_verify_fact` takes only `factId` and `evidencePath`. Verifier identity, key,
  signature, method, and target status all come from the server's configuration, never from the call.

### Glama inspection profile

Glama inspects this server in **full mode**, advertising all 27 tools. Compact mode is not used for
inspection: the published `glama.json` schema accepts only `maintainers`, so there is no supported
way to declare the compact environment variable or to disclose in the generated configuration that
the listing was produced from a reduced surface. Advertising 12 tools while the server offers 27
would understate what the server does, so the tool-count penalty is accepted instead.

Glama's generated container does not talk to this server directly. It runs `mcp-proxy@6.4.3` in front
of `node ./src/cli.js mcp` and scans over HTTP, so what the proxy requests, what this server
negotiates with it, and whether the tool list survives that hop are properties of the pair. None of
them can be established by pointing a different client at the server, which is why they have their
own gate rather than a note.

`npm run check:glama`, also run by `npm run check:mcp`, starts that exact pinned proxy through `npx`
with no dependency added to the package, binds it to the loopback interface only, and puts a
transparent stdio recorder between the proxy and `node src/cli.js mcp`, the command that container
runs. It then behaves as the scanner does,
over streamable HTTP, and asserts the recording and the HTTP replies against each other:

- the proxy sends exactly one `initialize`, from `clientInfo.name` `mcp-proxy`, requesting
  `protocolVersion: "2025-11-25"`;
- this server negotiates `2025-11-25` with it, asserted by equality, so a silent fall-back to an
  older revision fails the gate instead of quietly hiding metadata from Glama;
- the `tools/list` the scanner receives over HTTP is exactly 27 tools, each with four boolean
  annotations, and an object-rooted `outputSchema` on every tool except the two documented omissions;
- that list is deep-equal to the one the server wrote to stdio, so the proxy forwarded it without
  dropping or rewriting a member. The comparison is deep rather than byte-for-byte because the
  proxy rebuilds each tool through its bundled SDK schema, which may reorder keys.

Because that SDK compiles every advertised output schema while listing, a schema it cannot compile
fails the gate rather than passing quietly. The gate also prints the revision the proxy negotiated
with the scanner over HTTP; that value is a property of the proxy's SDK, not of this server.

Measured on 2026-09-03: `requested=2025-11-25 negotiated=2025-11-25 http=2025-11-25 tools=27
annotated=27 outputSchemas=25 forwarded=deep-equal`.

**Residual risk.** Only the pinned proxy is under test. Glama's own scanner client, the revision it
declares to the proxy, and how it renders what it receives are not reproduced here. The proxy version
is pinned in Glama's configuration, outside this repository, so when Glama moves to a newer one the
constants in `scripts/check-glama-proxy.mjs` have to be re-checked against it.

### Optional backlog, recorded rather than fixed

None of these are defects in the current release, and none were changed to improve a score:

- no `shadowgraph_unlink`: a relationship is removed only by purging its project;
- no apply counterpart to `shadowgraph_repair_plan`;
- `shadowgraph_review` and `shadowgraph_review_signals` return bare arrays rather than the
  `{ items, page, completeness }` envelope every other read path uses, which is also what prevents an
  output schema;
- naming is mixed (bare verbs, `verb_object`, noun phrases, one abbreviation), and renaming a tool
  is a breaking change for every existing client configuration.

## 5. Strict official Inspector and pinned Glama proxy gates

Run:

```bash
npm run check:mcp
```

That runs two scripts, both against pinned versions, and both fail loudly rather than skipping when
they cannot run.

`scripts/check-mcp.mjs` invokes pinned official `@modelcontextprotocol/inspector@2.4.0` twice with `tools/list --strict --format json`. It fails when:

- Inspector exits non-zero;
- Inspector writes any strict schema finding to stderr;
- Full mode is not exactly 27 tools without a verifier;
- Compact mode is not exactly 12 tools;
- any advertised tool is missing one of the four boolean annotations;
- any tool other than the two documented omissions is missing an object-rooted `outputSchema`.

Measured on 2026-09-03, that Inspector requests `protocolVersion: "2025-11-25"`, which this server
implements and echoes, so the strict run exercises the structured tier by genuine negotiation.

`scripts/check-glama-proxy.mjs`, also runnable alone as `npm run check:glama`, starts pinned
`mcp-proxy@6.4.3` — the proxy in Glama's generated container — in front of `node src/cli.js mcp`, the
command that container runs, with a stdio recorder between them, and drives it over streamable HTTP as Glama's scanner would (§4). It
fails when:

- the proxy cannot be started, or does not serve on the loopback interface within two minutes;
- the proxy sends anything other than exactly one `initialize`, or requests a revision other than
  `2025-11-25`;
- this server negotiates anything other than `2025-11-25` with it;
- the `tools/list` received over HTTP is not exactly 27 tools with the annotation and output-schema
  coverage above;
- that list is not deep-equal to the one the server wrote to stdio.

The CI matrix runs both gates on Node 24 on both Ubuntu and Windows. `test/check-glama-proxy.test.js`
covers the gate's own recorder, event-stream parser, and assertions offline, including that each
assertion rejects the failure it exists to catch. Unit/integration tests separately prove the
configured-verifier full count is 28 and compact remains 12.

## 6. Primary sources consulted

- Modern/legacy/dual-era negotiation and `-32022`: <https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>
- Mandatory modern discovery: <https://modelcontextprotocol.io/specification/2026-07-28/server/discover>
- Tools and tool-error contracts: <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
- Resources and resource-not-found errors: <https://modelcontextprotocol.io/specification/2026-07-28/server/resources>
- Prompts: <https://modelcontextprotocol.io/specification/2026-07-28/server/prompts>
- Official modern JSON Schema: <https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.json>
- Official legacy JSON Schema: <https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2024-11-05/schema.json>
- Tool annotations (added in this revision): <https://modelcontextprotocol.io/specification/2025-03-26/server/tools>
- Output schemas and structured content (added in this revision): <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- Official Inspector: <https://github.com/modelcontextprotocol/inspector>

## 7. Verification boundary

Automated raw-stdio tests prove exact dual-era payloads and errors, prove what each negotiated revision advertises and returns, prove batch receiving and its revision boundary, and exercise every tool that declares an output schema against a real store so the advertised schema is checked against the result the tool actually returns. The official Inspector proves strict tool-schema portability, exact full/compact counts, and that a real client using the official SDK accepts the annotations and output schemas on this machine. The pinned Glama proxy gate proves what that proxy requests, what this server negotiates with it, and that the tool list reaches an HTTP scanner unchanged; it does not exercise Glama’s own scanner. This does not by itself measure every third-party host, network transport, latency, answer quality, or future protocol revision.
