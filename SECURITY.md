# Security policy

## Supported versions

ShadowGraph 0.40.0 is a **Technical Preview / Early Access** release, installed from GitHub and not published to npm. Only the current `main` branch is supported; there are no patched older versions. Do not treat a Technical Preview build as a production security boundary.

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

The dashboard is served by the same local API at `/dashboard` and connects only to that same origin. Its static HTML is available without the API token so a user can enter one, but data endpoints still return `401` until the token is supplied. The password field keeps the token in page memory only; it is not written to cookies, local storage, or ShadowGraph storage. Reloading/closing the page clears it.

Do not expose the API directly to the public internet. A public deployment requires a separate threat model plus TLS, authentication, authorization, rate limiting, request logging/redaction, secure secret distribution, and operational monitoring.

## Data and deletion boundaries

Do not store secrets, API keys, credentials, or sensitive conversation transcripts unless your local storage, backup, retention, and access policy explicitly permits it. MCP clients launch ShadowGraph as a local subprocess; configure only environment variables that process should receive.

Logical project purge removes live canonical content while retaining a payload-free, non-identifying audit skeleton: purged `entityId` and `idempotencyKey` values are removed, and the purge marker contains counts but no raw entity-ID list. Replay derives project deletion structurally. Explicit hard purge physically removes matching journal entries and is irreversible; its surviving marker keeps sequence numbers only as gap evidence, never purged entity IDs. Both modes erase purged IDs from live exports and JSON/SQLite persisted state. Neither mode can discover or delete external Markdown exports, Git history, cloud-synced copies, backups, or removable-media copies. Delete and verify those external copies separately.

Remote embedding endpoints are disabled unless explicitly allowed. Enabling them sends memory/query text outside the machine; review the endpoint's retention and privacy terms first.

Benchmark adapters are treated as bounded subprocesses: they run without a shell, inherit only an explicit minimal runtime allowlist, and receive any additional environment through their adapter entry. The harness replaces configured LLM/embedding credentials, endpoint userinfo, and credential-valued adapter fields with `[REDACTED]` before retaining adapter output, logs, command metadata, or failure evidence. Keep credentials out of command arguments even though recorded metadata is sanitized, because operating-system process inspection is outside the harness's artifact boundary.

An independent security review remains a release gate. `npm audit`, unit tests, and the package smoke test are useful controls but are not substitutes for that review.
