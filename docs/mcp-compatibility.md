# ShadowGraph — MCP Compatibility Status

**Last verified:** 2026-08-25 against primary sources.
**What this server implements:** protocol version **`2024-11-05`**, declared in `src/mcp.js` as `PROTOCOL_VERSION`.

---

## 1. Honest statement of compatibility

ShadowGraph implements the **`2024-11-05`** MCP revision. That is a **Legacy-era** server by the current specification's own vocabulary.

**This project does not claim support for `2026-07-28` or any later revision.** No client interoperability testing has been performed against a modern-era client, so claiming compatibility would be unverifiable.

## 2. Verified protocol facts (primary sources, accessed 2026-08-25)

| Fact | Source |
| --- | --- |
| The current protocol version is **`2026-07-28`** | `https://modelcontextprotocol.io/docs/learn/versioning` |
| `2026-07-28` **removes** the `initialize` / `notifications/initialized` handshake — *"There is no negotiation handshake."* | `https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning` |
| Modern-era servers **MUST** implement `server/discover` | same |
| `2026-07-28` is a **stable release**, tagged 28 Jul 2026 | `https://github.com/modelcontextprotocol/modelcontextprotocol/releases` |
| The spec defines **Modern / Legacy / Dual-era** categories and specifies legacy interoperability | `.../basic/versioning` |

The current revision is therefore **four** revisions ahead of what this server implements.

## 3. What this server does, precisely

| Method | Behaviour |
| --- | --- |
| `initialize` | Replies with `protocolVersion: '2024-11-05'`, capabilities, and `serverInfo`. This is the legacy handshake the modern spec removed. |
| `notifications/initialized` | Accepted. |
| `tools/list` | Returns the full tool list. |
| `tools/call` | Dispatches to the core. |
| `server/discover` | **Answered**, returning protocol version, `serverInfo`, capabilities, and the tool list in one response. |

`server/discover` is answered as a courtesy so that a modern-era client probing this server receives a truthful description of what it is — rather than a silent failure or a misleading claim of modernity. **Answering the method is not the same as being a modern-era server**, and this document is the authoritative statement of that distinction.

## 4. Deliberately not done in this release

Migrating to `2026-07-28` is recorded as **scheduled maintenance, not breakage**, because the specification explicitly specifies legacy interoperability and defines a Dual-era category. Doing it properly requires stateless per-request capability negotiation, removing handshake state, and — critically — **client interoperability testing that has not been performed**.

Deferred with reasons (ADR-0003):

- **Protocol migration to `2026-07-28`** — needs interop testing against real modern-era clients. Impact: a modern-era client that refuses legacy servers cannot connect. Workaround: use a client that supports legacy or dual era. Verification that this is not silently broken: `test/interfaces.test.js` and `test/compact-mcp.test.js` exercise the implemented handshake end to end.
- **Deferred tool loading / code execution** — out of scope (ADR-0003). These are client-side techniques; the server-side contribution is precise tool names and descriptions, which the tool-search mechanism matches against.

## 5. Unverified

- **X-1** — whether any MCP client still accepts `2024-11-05` from this server in practice. Not tested against a live third-party client.
- **X-6** — the normative content of the backward-compatibility section. The section is confirmed to exist and to specify legacy interop; its full normative requirements were not read line by line.

Neither is claimed as verified anywhere in this repository.
