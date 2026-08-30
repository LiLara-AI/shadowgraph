# ShadowGraph — decision-memory demo

One worked example, run four ways. It shows the thing ShadowGraph exists for: a decision that
carries its own rejection reasons and reopens itself when the world changes.

Every command and response on this page was executed against ShadowGraph 0.40.0. Identifiers and
timestamps will differ in your run; nothing else will.

## The story

An agent is building a small checkout service.

1. It chooses **SQLite** and rejects **PostgreSQL**, because the deployment is single-user and local.
2. It records that rejection with a rule: *reopen this if `deployment` ever becomes `multi-user`.*
3. Sessions end. Processes restart. The conversation is long gone.
4. The deployment becomes multi-user.
5. ShadowGraph surfaces the old decision and names PostgreSQL as the alternative to reconsider —
   without anyone remembering that the rule existed.

A chat transcript would have kept step 1 as prose, lost step 2 entirely, and had nothing to say at
step 5.

## Shell quoting

Each command takes one JSON argument. Use the row for your shell:

| Shell | Form |
| --- | --- |
| bash / zsh / Git Bash | `shadowgraph review '{"project":"checkout-service"}'` |
| Windows PowerShell | `shadowgraph review '{\"project\":\"checkout-service\"}'` |
| Windows `cmd.exe` | `shadowgraph review "{\"project\":\"checkout-service\"}"` |

The examples below use the bash form. All three were tested.

---

## 1. CLI

Each command is a separate process that reopens the store from disk, so every step after the first
is a genuine restart.

### Set up

```bash
mkdir shadowgraph-demo
cd shadowgraph-demo
shadowgraph setup
shadowgraph doctor
```

```json
{
  "ok": true,
  "command": "doctor",
  "version": "0.40.0",
  "node": { "version": "24.18.0", "supported": true, "requirement": ">=20" },
  "storage": { "type": "json", "path": "...", "initialized": true, "readable": true, "writable": true },
  "graph": { "valid": true, "issues": 0 },
  "mcp": { "available": true, "recommendedMode": "compact", "fullMode": "Set SHADOWGRAPH_MCP_COMPACT=0 or remove it." }
}
```

### Record the decision and why the alternative lost

```bash
shadowgraph decision '{"project":"checkout-service","title":"Choose the datastore","chosen":"SQLite","confidence":0.8,"alternatives":[{"label":"PostgreSQL","reasonRejected":"Single-user local deployment does not justify running a server","reopenWhen":[{"key":"deployment","operator":"equals","value":"multi-user"}]}]}'
```

The stored alternative keeps all three parts — what was rejected, why, and what would change the
answer:

```json
"alternatives": [
  {
    "id": "alternative_1788079304730_z7t7r4",
    "label": "PostgreSQL",
    "reasonRejected": "Single-user local deployment does not justify running a server",
    "reopenWhen": [{ "key": "deployment", "operator": "equals", "value": "multi-user" }],
    "status": "rejected"
  }
]
```

### Record the fact the decision depends on

```bash
shadowgraph fact '{"project":"checkout-service","key":"deployment","value":"single-user","sourceClass":"human_confirmed","confidence":1}'
```

`sourceClass` records **what was claimed** about where an observation came from, not proof of it.
Ordinary input can never produce `verified`.

### Record a failed attempt, so it is not repeated

```bash
shadowgraph attempt '{"project":"checkout-service","solution":"One SQLite file per user","result":"Cross-user reporting became impossible","reason":"No shared transactional view"}'
```

### Nothing to reconsider yet

```bash
shadowgraph review '{"project":"checkout-service"}'
```

```json
[]
```

The rule is stored and the fact does not match it. This is the quiet state — no noise.

### The world changes

```bash
shadowgraph fact '{"project":"checkout-service","key":"deployment","value":"multi-user","sourceClass":"human_confirmed","confidence":1}'
```

The previous fact is not overwritten. It is superseded, keeping its own validity interval, so the
history of what was true when remains inspectable.

### Restart, then ask

Note what is *not* in this command: the fact that changed. `review` reads stored project state.

```bash
shadowgraph review '{"project":"checkout-service"}'
```

```json
[
  {
    "decisionId": "decision_1788079304730_yjawcg",
    "title": "Choose the datastore",
    "reason": "deployment",
    "alternativesToReconsider": ["PostgreSQL"]
  }
]
```

### Review signals persist, and can be acknowledged

```bash
shadowgraph signals '{}'
```

```json
[
  {
    "id": "review_1788079327576_q1wmw5",
    "kind": "review",
    "decisionId": "decision_1788079304730_yjawcg",
    "title": "Choose the datastore",
    "reason": "deployment",
    "alternativesToReconsider": ["PostgreSQL"],
    "status": "open",
    "createdAt": "2026-08-30T08:42:07.576Z"
  }
]
```

```bash
shadowgraph ack '{"id":"review_1788079327576_q1wmw5"}'
```

```json
{ "status": "acknowledged", "acknowledgedAt": "2026-08-30T08:46:59.143Z", "...": "..." }
```

### Close the loop with an outcome

```bash
shadowgraph outcome '{"decisionId":"decision_1788079304730_yjawcg","outcome":{"status":"mixed","lessons":["Fine for one user, wrong once reporting spans users"]}}'
```

Outcomes are `successful`, `mixed`, `failed`, or `unknown`, and each applies one evidence-weighted
contribution to the decision's confidence history rather than overwriting a number.

---

## 2. MCP

The same story through the stdio MCP server in compact mode, which advertises 12 workflow tools.

```bash
SHADOWGRAPH_MCP_COMPACT=1 shadowgraph mcp
```

An agent calls, in order:

| Step | Tool | Arguments |
| --- | --- | --- |
| Load context first | `shadowgraph_context` | `{"project":"checkout-service"}` |
| Record the decision | `shadowgraph_record_decision` | project, title, chosen, confidence, alternatives with `reasonRejected` + `reopenWhen` |
| Record the fact | `shadowgraph_record_fact` | `{"project":"checkout-service","key":"deployment","value":"single-user","sourceClass":"human_confirmed","confidence":1}` |
| Record what failed | `shadowgraph_record_attempt` | solution, result, reason |
| Later, the changed fact | `shadowgraph_record_fact` | same key, `"value":"multi-user"` |
| Ask what to revisit | `shadowgraph_review` | `{"project":"checkout-service"}` |

`shadowgraph_review` returns exactly the CLI payload:

```json
[
  {
    "decisionId": "decision_1788079560852_g3b79y",
    "title": "Choose the datastore",
    "reason": "deployment",
    "alternativesToReconsider": ["PostgreSQL"]
  }
]
```

Compact mode changes only which tools are advertised. The full relational graph, memories, facts,
alternatives, and outcomes are stored unchanged, and full mode (27 tools) exposes the rest of the
surface. See [MCP compatibility](mcp-compatibility.md).

A copy-ready agent policy is in [`integrations/agent-policy.md`](../integrations/agent-policy.md).
The short version:

> Before a consequential task, load ShadowGraph context for the project and search relevant
> decisions and failed attempts. Record decisions with assumptions, evidence, and rejected
> alternatives. Record outcomes after implementation. Treat every fact as a hypothesis unless it
> carries a verifier-checked signed attestation.

---

## 3. HTTP API

```bash
shadowgraph serve
```

```bash
curl -s -X POST http://127.0.0.1:8787/decisions \
  -H 'content-type: application/json' \
  -d '{"project":"checkout-service","title":"Choose the datastore","chosen":"SQLite","confidence":0.8,"alternatives":[{"label":"PostgreSQL","reasonRejected":"Single-user local deployment does not justify running a server","reopenWhen":[{"key":"deployment","operator":"equals","value":"multi-user"}]}]}'

curl -s -X POST http://127.0.0.1:8787/facts \
  -H 'content-type: application/json' \
  -d '{"project":"checkout-service","key":"deployment","value":"multi-user","sourceClass":"human_confirmed","confidence":1}'

curl -s -X POST http://127.0.0.1:8787/review \
  -H 'content-type: application/json' \
  -d '{"project":"checkout-service"}'
```

```json
[{"decisionId":"decision_1788079574685_u1fnj3","title":"Choose the datastore","reason":"deployment","alternativesToReconsider":["PostgreSQL"]}]
```

Signals persist and are readable separately:

```bash
curl -s http://127.0.0.1:8787/review-signals
```

```json
[{"id":"review_1788079575127_sk0rtb","kind":"review","decisionId":"decision_1788079574685_u1fnj3","title":"Choose the datastore","reason":"deployment","alternativesToReconsider":["PostgreSQL"],"status":"open","createdAt":"2026-08-30T08:46:15.127Z"}]
```

The server binds to `127.0.0.1` only. For shared local use set `SHADOWGRAPH_API_TOKEN` and send
`Authorization: Bearer <token>` with every request.

---

## 4. JavaScript

This version makes the restart explicit: one process writes and saves, a second process loads and
reviews.

**Process 1 — decide and persist:**

```js
import { createStorage } from 'shadowgraph-unified-plugin/storage';
import { createShadowGraph } from 'shadowgraph-unified-plugin';

const store = await createStorage({ type: 'json', file: './.shadowgraph/data.json' });
const graph = createShadowGraph();
graph.importData(await store.load());

graph.addDecision({
  project: 'checkout-service',
  title: 'Choose the datastore',
  chosen: 'SQLite',
  confidence: 0.8,
  alternatives: [{
    label: 'PostgreSQL',
    reasonRejected: 'Single-user local deployment does not justify running a server',
    reopenWhen: [{ key: 'deployment', operator: 'equals', value: 'multi-user' }]
  }]
});

graph.addAttempt({
  project: 'checkout-service',
  solution: 'One SQLite file per user',
  result: 'Cross-user reporting became impossible',
  reason: 'No shared transactional view'
});

graph.addFact({
  project: 'checkout-service',
  key: 'deployment',
  value: 'multi-user',
  sourceClass: 'human_confirmed',
  confidence: 1
});

await store.save(graph.exportData());
store.close?.();
```

**Process 2 — a cold start that knows nothing:**

```js
import { createStorage } from 'shadowgraph-unified-plugin/storage';
import { createShadowGraph } from 'shadowgraph-unified-plugin';

const store = await createStorage({ type: 'json', file: './.shadowgraph/data.json' });
const graph = createShadowGraph();
graph.importData(await store.load());

console.log(graph.review({ project: 'checkout-service' }));
// [ { decisionId: 'decision_...', title: 'Choose the datastore',
//     reason: 'deployment', alternativesToReconsider: [ 'PostgreSQL' ] } ]

const priorAttempts = graph.search('SQLite file per user', { project: 'checkout-service' });
console.log(priorAttempts.items[0].record.result);
// 'Cross-user reporting became impossible'
store.close?.();
```

Running from a clone instead of a dependency? Import `./src/shadowgraph.js` and `./src/storage.js`
directly.

---

## What this demonstrates

| Capability | Where it shows up above |
| --- | --- |
| Decision memory | The decision keeps `chosen`, `confidence`, and its alternatives |
| Rejected alternatives with reasons | `reasonRejected` survives every restart |
| Reconsideration | `review` reopens PostgreSQL from stored state, with no hint from the caller |
| Changed facts | The superseded fact keeps its validity interval instead of being overwritten |
| Failed-attempt memory | The per-user-file attempt is searchable later |
| Provenance | `sourceClass: human_confirmed` is a recorded claim, never proof |
| Outcomes and confidence | A `mixed` outcome contributes to confidence history |
| Local-first | Every step is one local file; no account, no network |

## Next

- [README quick start](../README.md#quick-start--5-minutes)
- [API reference](api-reference.md) — full argument shapes for every surface
- [Unified memory guide](unified-memory.md) — `remember` / `recall`, scoping, and temporal recall
- [Vision and principles](vision-and-principles.md) — what ShadowGraph deliberately will not do
