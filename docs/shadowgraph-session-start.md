# New Session Startup Prompt

You are starting a focused ShadowGraph architecture and product-engineering session. Read these files first:

1. `docs/shadowgraph-next-session-brief.md`
2. `docs/shadowgraph-vision-scope.md`
3. `docs/shadowgraph-product-manager-current.md`
4. `docs/shadowgraph-security-and-safety.md`
5. `docs/shadowgraph-redesign-proposal.md`
6. `docs/shadowgraph-benchmark-plan.md`

Mission: improve or redesign ShadowGraph as a full-fidelity, local-first, decision-memory system. Do not blindly preserve the current implementation and do not copy competitors. Preserve the product principles, verify assumptions, and use tests/benchmarks before removing behavior.

First actions:

- inspect current git status and latest commit;
- inspect package scripts and existing tests;
- inspect current MCP schemas and storage exports;
- review public competitor documentation only as research, not as implementation authority;
- write a short architecture decision record before code changes;
- propose a migration and benchmark plan before removing or replacing a core model.

Hard constraints:

- no npm publishing;
- no secrets in files or output;
- no silent lossy summaries;
- no fabricated events or outcomes;
- full storage remains inspectable and portable;
- project isolation and restart persistence are mandatory;
- run full tests/check/audit/diff checks before merge.
