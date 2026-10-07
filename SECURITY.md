# Security policy

## Supported versions

The latest release is the 0.41.0 **Technical Preview / Early Access** (tag `v0.41.0`); `main` carries the development build `0.42.0-dev.0`. ShadowGraph is installed from GitHub and not published to npm. Security fixes land on `main`; the `v0.41.0` tag is not patched, and there are no patched older versions. Do not treat a Technical Preview build as a production security boundary.

## Security review status

An **AI-assisted independent security review** of the Technical Preview candidate was completed with
a **PASS** result.

| Field | Value |
| --- | --- |
| Reviewer | Antigravity Assistant (Gemini 3.7 Flash) |
| Date | 2026-08-30 |
| Commit reviewed | `4a5e0761f2c0924ad8417ead39e1c5a596445daf` |
| Tree reviewed | `62c1918e42abf2059cbfab782d4be2cd8b461f83` |
| Result | PASS — no release-blocking vulnerabilities, no unresolved findings |

That review covered commit `4a5e076`, before the `v0.41.0` tag. **Nothing added since has had an
independent security review**, including project scoping, access grants, deletion records and
purge-aware restore, schema 6 and 7 migration and `downgrade`, the Claude Code hooks, automatic
capture, transcript reading and extraction. The PASS above describes that commit only.

Scope covered: `src/` runtime modules, JSON and SQLite storage, the HTTP server, MCP tools, the CLI,
verification and security boundaries, packaging and tarball contents, secret and credential
exposure, personal and local path exposure, database/backup/temp artifacts, internal-documentation
exposure, the test suite, the dependency audit, the clean-install smoke test, and GitHub Actions CI
verification.

Verified during the review: `npm test` 1204/1204 pass; `npm audit --omit=dev` reported 0
vulnerabilities; `npm run check:package` passed with `private: true`; `npm run smoke:package`,
`npm run check`, `npm run check:mcp`, and `npm run check:integrations` all passed; GitHub Actions was
green across Ubuntu and Windows on Node 20/22/24; and no secrets, tokens, credentials, personal
email addresses, real local paths, databases, backups, or internal handover documents were found in
`main` or in the packaged tarball.

> **No human third-party security audit has been performed.** This was an AI-assisted review. It is
> a useful control, not an equivalent substitute for a human expert audit or a penetration test.
> Treat it accordingly when deciding what data to trust ShadowGraph with, and do not treat a
> Technical Preview build as a production security boundary.

Separately, npm publication remains closed. It is gated on an actual preregistered comparative
measurement and explicit maintainer authorization, neither of which is complete — see
[`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md).

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Report it privately through GitHub's
[private vulnerability reporting](https://github.com/LiLara-AI/shadowgraph/security/advisories/new)
— the **Report a vulnerability** button on the repository's Security tab. This channel is enabled and
is the only supported way to reach the maintainer privately.

Include the affected commit, reproduction steps, impact, and whether the report may be acknowledged
publicly. Expect an initial acknowledgement within 7 days. ShadowGraph is a single-maintainer
Technical Preview project: there is no paid support, no guaranteed patch SLA, and no bug bounty.

## Local threat model

ShadowGraph is local-first. The HTTP API binds to `127.0.0.1` by default and rejects non-local browser origins. For shared local connections, set `SHADOWGRAPH_API_TOKEN` to a random value of at least 16 characters; clients must send `Authorization: Bearer <token>`. Treat any local process that can read the token, storage files, backups, or the listening port as trusted.

**Full-mode MCP and the HTTP API are owner surfaces.** They back up to a path the caller names, restore from one and purge projects, and full-mode MCP also binds a workspace to a project and reassigns records between projects (`shadowgraph_bind`, `shadowgraph_attribute`), which the CLI does only after the owner confirms at a terminal. A store copy written to a path the caller names can replace any file your account can write, including another tool's JSON configuration such as Claude Code's settings or an MCP configuration file. As destinations, ShadowGraph refuses only its own control files: deletion records, the deletion registry, the activation record and the extraction state files, with their locks. It finds the last three beside the registry of the `SHADOWGRAPH_HOME` the writing process sees, so run the MCP server and the HTTP API with the same home as the hooks. Give an agent compact MCP mode, which has none of these tools, and set `SHADOWGRAPH_API_TOKEN` when other local processes should not drive the API.

**Workspace bindings.** The hooks honour a workspace's project binding only when the store has also recorded it. CLI, MCP and HTTP calls made in a workspace also honour the binding file `.shadowgraph/project-binding.json` as written, when it names that workspace's exact path; a repository you clone could ship one, so pass `project` explicitly in a workspace you do not trust.

**Owner confirmation prevents accidents; it does not authenticate.** CLI owner actions -- issuing or delegating access, `bind`, `attribute`, activation and hook installation -- proceed only when stdin and stdout are terminals and the operator types `confirm`. A process that runs commands as you can drive a pseudo-terminal and answer that prompt. The prompt keeps an agent from taking these actions by accident; it is not a boundary against a process that already runs commands with your account.

**Hooks, capture, extraction and delivery.** All four are inert until the owner turns each one on.
- **Capture** writes your prompts, tool calls with their input and output, and the assistant's text from Claude Code sessions into a private local store. Redaction is pattern-based: it covers common credential forms but misses others (for example a password given only in prose, or a token shape it does not know), so captured material can hold secrets.
- **Extraction** sends eligible captured material off the machine to the first-party Claude subscription route, to turn it into records. It runs only on Windows with Claude Code 2.1.288.
- **Delivery** puts stored records into the model's context at session start and on each prompt. They are framed as data, but they are text the model reads; a record extracted from untrusted tool output (a fetched page, a file in a cloned repository) can carry instructions into later sessions. Records extracted from tool output are labelled `tool_observed` and `unverified`.
- Delivered records become part of Claude Code's session transcript, which ShadowGraph cannot remove.

The dashboard is served by the same local API at `/dashboard` and connects only to that same origin. Its static HTML is available without the API token so a user can enter one, but data endpoints still return `401` until the token is supplied. The password field keeps the token in page memory only; it is not written to cookies, local storage, or ShadowGraph storage. Reloading/closing the page clears it.

Do not expose the API directly to the public internet. A public deployment requires a separate threat model plus TLS, authentication, authorization, rate limiting, request logging/redaction, secure secret distribution, and operational monitoring.

## Data and deletion boundaries

Do not store secrets, API keys, credentials, or sensitive conversation transcripts unless your local storage, backup, retention, and access policy explicitly permits it. Once active, capture stores conversation material automatically; activate it only where that policy allows it. MCP clients launch ShadowGraph as a local subprocess; configure only environment variables that process should receive.

Logical project purge removes live canonical content while retaining a payload-free, non-identifying audit skeleton: purged `entityId` and `idempotencyKey` values are removed, and the purge marker contains counts but no raw entity-ID list. Replay derives project deletion structurally. Explicit hard purge physically removes matching journal entries and is irreversible; its surviving marker keeps sequence numbers only as gap evidence, never purged entity IDs. Both modes erase purged IDs from live exports and JSON/SQLite persisted state. Neither mode can discover or delete external Markdown exports, Git history, cloud-synced copies, backups, or removable-media copies. Delete and verify those external copies separately.

Remote embedding endpoints are disabled unless explicitly allowed. Enabling them sends memory/query text outside the machine; review the endpoint's retention and privacy terms first.

Benchmark adapters are treated as bounded subprocesses: they run without a shell, inherit only an explicit minimal runtime allowlist, and receive any additional environment through their adapter entry. The harness replaces configured LLM/embedding credentials, endpoint userinfo, and credential-valued adapter fields with `[REDACTED]` before retaining adapter output, logs, command metadata, or failure evidence. Keep credentials out of command arguments even though recorded metadata is sanitized, because operating-system process inspection is outside the harness's artifact boundary.

`npm audit`, unit tests, and the package smoke test are useful controls, but none of them — nor the
AI-assisted review recorded above — substitutes for a human expert security audit. That audit has
not been performed.
