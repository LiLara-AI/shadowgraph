# ShadowGraph — MCP Compatibility Status

**Last verified:** 2026-08-27 against official MCP specification/schema sources and `@modelcontextprotocol/inspector@2.4.0`.
**Implemented revisions:** legacy `2024-11-05` and modern `2026-07-28` (dual-era stdio server).

## 1. Honest compatibility statement

ShadowGraph implements both eras in the current specification's terms:

- **Legacy:** `initialize` negotiates `2024-11-05`; subsequent result shapes remain compatible with that revision.
- **Modern:** requests carrying the required `io.modelcontextprotocol/*` `_meta` fields use stateless `2026-07-28` semantics. `server/discover` is implemented and advertises both supported revisions.
- An unsupported modern per-request version returns `-32022` with exact `supported` and `requested` data.

An `initialize` request selects legacy semantics; it never causes the server to falsely echo modern support through the removed handshake. Modern clients select modern semantics with per-request metadata.

## 2. Implemented methods

Both eras cover the implemented primitives:

- `server/discover` (modern, mandatory);
- `initialize` and `notifications/initialized` (legacy);
- `tools/list` and `tools/call`;
- `resources/list` and `resources/read`;
- `prompts/list` and `prompts/get`;
- client notifications, defined strictly as valid JSON-RPC requests with an absent `id`, which execute normally but never receive success or error responses;
- JSON-RPC parse, invalid-request, invalid-params, method-not-found, unsupported-version, and tool errors.

An explicit `"id": null` is still a request and receives a correlated `id:null` response. Parse errors also receive `id:null`; they are not valid notifications. This suppression rule applies to every method, including successful no-id `initialize`, `tools/list`, and mutating `tools/call` messages—not only method names under `notifications/*`.

Modern complete results include `resultType: 'complete'` and server identity metadata. Modern cacheable lists/resources include explicit `ttlMs` and `cacheScope`. Modern tool execution failures are returned as `isError: true`; malformed calls and unknown tools remain protocol errors. Legacy result shapes do not gain modern required fields.

## 3. Tool modes and verifier boundary

| Mode | Verifier | Advertised tools |
| --- | --- | ---: |
| Full | not configured | 27 |
| Full | configured | 28 (`shadowgraph_verify_fact` is added) |
| Compact | either | 12 |

`SHADOWGRAPH_MCP_COMPACT=1` must be passed to the server process, not merely assumed from the Inspector launch shell. The automated gate uses Inspector's server environment option and verifies the returned list count.

## 4. Strict official Inspector gate

Run:

```bash
npm run check:mcp
```

`scripts/check-mcp.mjs` invokes pinned official `@modelcontextprotocol/inspector@2.4.0` twice with `tools/list --strict --format json`. It fails when:

- Inspector exits non-zero;
- Inspector writes any strict schema finding to stderr;
- Full mode is not exactly 27 tools without a verifier;
- Compact mode is not exactly 12 tools.

The CI matrix runs this gate on Node 24 on both Ubuntu and Windows. Unit/integration tests separately prove the configured-verifier full count is 28 and compact remains 12.

## 5. Primary sources consulted

- Modern/legacy/dual-era negotiation and `-32022`: <https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>
- Mandatory modern discovery: <https://modelcontextprotocol.io/specification/2026-07-28/server/discover>
- Tools and tool-error contracts: <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
- Resources and resource-not-found errors: <https://modelcontextprotocol.io/specification/2026-07-28/server/resources>
- Prompts: <https://modelcontextprotocol.io/specification/2026-07-28/server/prompts>
- Official modern JSON Schema: <https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.json>
- Official legacy JSON Schema: <https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2024-11-05/schema.json>
- Official Inspector: <https://github.com/modelcontextprotocol/inspector>

## 6. Verification boundary

Automated raw-stdio tests prove exact dual-era payloads and errors. The official Inspector proves strict tool-schema portability and exact full/compact counts on this machine. This does not by itself measure every third-party host, network transport, latency, answer quality, or future protocol revision.
