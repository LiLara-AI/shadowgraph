# Codex terminal integration

This optional adapter observes work launched with `shadowgraph-codex run`. It does
not observe the Codex desktop app or unrelated CLI sessions. Each turn launches
Codex CLI in ephemeral mode; the wrapper retains the current conversation in
memory and supplies fresh scoped ShadowGraph context before each new turn.
Capture and bounded extraction finish before the next turn. There is no delivery
inside an already running model turn. No historical Codex session is imported.

The supported extraction configuration is Codex CLI 0.161.0, its existing signed-in
ChatGPT subscription, and explicit model `gpt-6.1-sol`. API keys, provider overrides
and foreign Codex profiles are refused. There is no Claude or paid API fallback.
The CLI selection is recorded; its JSON stream does not independently identify
the responding model. Source, binary or account changes require setup again.

After installing the package, save a private setup JSON containing `executable`
(the absolute native Codex executable) and `projects` (objects with `project` and
absolute `cwd`). Run `shadowgraph-codex setup --config <file> --home <private-dir>`.
Persistent setup requires the owner at a terminal. Test setup under the operating
system temporary directory follows the existing scratch policy. Setup backs up
prior configuration and preserves memory and usage. Keep the private directory
outside source repositories. The integration never edits the ordinary Claude or
Codex configuration, authentication or existing activation.

Set `hostMode` to `text` for text-only work with tool capabilities disabled and a
read-only sandbox. The default `workspace` mode retains the host's execution
policy and workspace sandbox; a policy rejection stops the session before
extraction. It never retries using a less restrictive permission mode. The first
local workspace episode was stopped because the native host rejected its shell
command. Text-only evidence does not prove command execution support.

Capture defaults to all enrolled workspaces. Optional `capture` configuration is
`{"mode":"only","include":["project-name"],"exclude":[]}`. Capture coverage is
independent of read sharing. A new setup holds older pending captures because
their setup provenance differs; it never silently relabels or deletes them.

From an enrolled workspace run `shadowgraph-codex run --home <private-dir>` and
enter ordinary task prompts, one line per turn, or use `--prompt <text>`. No
remember/search/extract command is required. The current implementation captures
user text, final assistant messages and native command-execution events. Other
tool-event coverage must be checked before claiming it. Extraction children are
separate from the observed host stream, so they cannot recapture themselves.

Default session bounds: four user turns, twelve total host/extraction calls,
one call at a time and fifteen minutes. Lower them with `--max-turns`,
`--max-calls`, and `--deadline-ms`. The existing extraction worker also retains
its per-drain and rolling usage ceilings. A failed host or extraction gate ends
the session. Usage reservations, outcomes and timings are private under `runs`.
Unknown usage is not zero. Ctrl+C stops the session; `pause` stops future work,
and `resume` resumes the configured scope. `status` shows configuration.

Reads default to the current project. Use `share --mode selected --projects a,b`
to permit relevant records from that chosen set, or `share --mode all-permitted`
to select all currently enrolled projects. `--exclude a` removes projects from
that set. This is explicit project selection, not a semantic permission detector.
New projects require setup; they are not silently added to an existing grant.
Grants expire after thirty days. `share --mode project` revokes wider sharing.
Grant checks use the existing kernel on every retrieval; no delivery cache is
used. Changing sharing clears the wrapper's conversation before the next turn.
Previously displayed information cannot be erased from a person's knowledge.

Answers and tool observations produced with delivered memory retain dependencies
on those source records. They are not independent corroboration. Every future
read, including project-local reads and public exports, checks those dependencies
against current access. A revoked, missing or cyclic source cannot be made readable
by copying the answer into another project. Capture still stores the original
user prompt separately, without attaching the wrapper's supplied context.

Reusable experience stays in its source project with evidence, conditions and
uncertainty. Wider access does not make a lesson a universal fact. A changed
condition can justify a new attempt; missing conditions remain unknown rather
than erasing relevant past outcomes. Capture consent never grants wider reads.

For ordinary multi-sentence material, Codex can propose a structured interpretation
using exact source quotations. Each such record is explicitly model-proposed and
unverified, and includes the entire source context; only that full quotation is
checked by the existing deterministic verifier. Field roles and relationships
are not presented as independently verified facts. Compact delivery discloses
this limitation and includes context or requires full expansion.

Uninstall: pause the integration, close its sessions, and remove the package's
launcher. Private stores and evidence are retained; deletion is a separate owner
action. Existing Claude installation and public release v0.42.0 are unchanged.

Current implementation tests use fake host/model seams where stated. Real-host
acceptance and precise language/tool coverage belong in the final release report;
this document does not claim those checks have already passed.
