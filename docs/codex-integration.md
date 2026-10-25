# Codex terminal integration

This optional adapter observes work launched with `shadowgraph-codex run`. It does
not observe the Codex desktop app or unrelated CLI sessions. Each turn launches
Codex CLI in ephemeral mode; the wrapper retains the current conversation in
memory and supplies fresh scoped ShadowGraph context before each new turn.
Completed host answers are displayed without waiting for extraction. Durable
captures are processed in the background while the next work task can proceed.
There is no delivery inside an already running model turn. No historical Codex
session is imported.

The supported extraction configuration is Codex CLI 0.161.0, its existing signed-in
ChatGPT subscription, and explicit model `gpt-6.1-sol`. API keys, provider overrides
and foreign Codex profiles are refused. There is no Claude or paid API fallback.
The CLI selection is recorded; its JSON stream does not independently identify
the responding model. Source, binary or account changes require setup again.

The executor is obtainable from the official `@openai/codex` npm distribution;
this integration does not depend on a privately supplied binary. The tested
version is available as `@openai/codex@0.161.0`. Install it into a dedicated
directory with `npm install --prefix <executor-directory> @openai/codex@0.161.0`
and select the native `codex.exe` under its Windows platform package's `vendor`
directory, rather than the npm command shim. Check `--version` and `login status`.
Use the ordinary Codex sign-in flow if needed; never copy authentication files.
See the [official CLI installation guide](https://developers.openai.com/codex/cli).
Availability, the exact binary hash and the supported account route are checked
again during setup. Other CLI versions need a newly validated adapter profile.

Install the v0.42.2 Technical Preview from its GitHub Release tarball:

```powershell
npm install --global https://github.com/LiLara-AI/shadowgraph/releases/download/v0.42.2/shadowgraph-unified-plugin-0.42.2.tgz
```

The release includes SHA-256 checksums. The [README quick start](../README.md#quick-start-windows-codex)
includes complete PowerShell 7 commands for executor discovery, enrollment and launch.
The package remains `private: true` and unpublished to the npm registry. For a local
non-global installation use `npm install --prefix <application-directory> <downloaded-tarball>`
and its `node_modules/.bin/shadowgraph-codex.cmd` launcher.

After installing the package, save a private setup JSON containing `executable`
(the absolute native Codex executable) and `projects` (objects with `project` and
absolute `cwd`). Run `shadowgraph-codex setup --config <file> --home <private-dir>`.
For ordinary command-executing work, replace the paths in this example:

```json
{
  "executable": "<absolute native Codex executable>",
  "hostMode": "workspace",
  "projects": [{ "project": "demo", "cwd": "<absolute project directory>" }]
}
```

Persistent setup requires the owner at a terminal. Test setup under the operating
system temporary directory follows the existing scratch policy. Setup backs up
prior configuration and preserves memory and usage. Keep the private directory
outside source repositories. The integration never edits the ordinary Claude or
Codex configuration, authentication or existing activation.

Set `hostMode` to `text` for text-only work with tool capabilities disabled and a
read-only sandbox. The default `workspace` mode retains the host's execution
policy and workspace sandbox. On Windows it explicitly selects the supported
`unelevated` restricted-token backend, because ignoring user configuration would
otherwise omit that backend selection. Managed policy and execution rules remain
enforced, approval is `never`, and there is no unsandboxed fallback. A host policy
rejection still stops the session. See the
[official Windows sandbox guide](https://learn.chatgpt.com/docs/windows/windows-sandbox).

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

Ordinary interactive sessions have no demonstration turn/call/deadline ceiling.
Optional `--max-turns`, `--max-calls` (1–100), and `--deadline-ms` (up to one hour)
set explicit acceptance-batch bounds. Each host turn still has a 120-second
process limit. One host and one extraction invocation can run concurrently;
extraction remains serial, with four items/calls and 240 seconds per drain,
twelve reserved calls per rolling hour, and the existing bounded retry policy.
These background ceilings do not terminate otherwise-permitted foreground work.
Reservations, outcomes and timings are private under `runs`; unknown usage is not zero.

Memory delay or failure reports pending/degraded state when that state changes.
It does not withhold a completed answer or prevent another task. The private
outbox durably accepts completed turns before acknowledging capture, then replays
them into the store using stable source identities. Store interruptions and a
crash between commit and receipt removal do not create duplicate captures.
If the outbox cannot be written, capture is explicitly not acknowledged.
Pending work retries automatically while the wrapper is open (normally after a
60-second cooldown), and on the next ordinary launch. No memory command is needed.
This does not bypass account, workspace, setup or permission failures. An unresolved
host child prevents another host invocation; an unresolved memory child holds
extraction while independently supervised foreground work can continue. Its
original identity is retained until matching settlement proof permits recovery.

End-of-input gives memory five seconds to settle, then stops the bounded worker
and leaves uncommitted work pending. `--settle-ms 0..240000` changes that grace,
without delaying already displayed answers. Ctrl+C stops immediately with bounded
cleanup. A one-shot supervisor terminates its local child if the wrapper dies;
unconfirmed settlement remains a visible hold, never fabricated completion.
`pause` stops the configured integration; `resume` restores its scope. Nothing
continues as an unattended permanent daemon after the wrapper closes.

`status` also reports eligible pending captures, held unknown/foreign provenance,
failed/blocked items and extracted items; provider availability is not inferred
from configuration. `inspect --query <text>` reads the current scoped memory with
compact expansion handles. Save a handle as JSON and use `expand --handle <file>`
for the full record. Both run from the enrolled workspace and recheck current
sharing; an old handle cannot restore revoked access. These inspection commands
are optional owner controls, not prerequisites for automatic delivery.

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

An ordinary user correction may automatically supersede a relevant earlier
decision from the same bound setup and project. The model must identify the
earlier exact choice and quote the correction; the local writer checks that the
candidate has not changed. The relationship is explicitly model-proposed.
Both source messages and the historical decision remain inspectable. Old compact
handles report a changed revision, current corrections take delivery priority,
and answer copies dependent on a superseded source are withheld from future
reads. An unrelated new task or an assistant assertion is not authorized to
correct an earlier decision. Ambiguous or unsupported proposals retain their
source rather than acquiring verified authority. For an incorrect interpretation,
give an ordinary explicit correction in the enrolled wrapper and inspect the result;
the kernel's explicit decision supersession controls remain available to the owner.

Uninstall: pause the integration, close its sessions, and remove the package's
launcher. Private stores and evidence are retained; deletion is a separate owner
action. Existing Claude installation and public release v0.42.0 are unchanged.

Coverage measured locally on Windows x64: installed Codex workspace host and extractor,
an actual failing parser test, agent repair and unchanged passing test; automatic
recovery after a real extraction timeout; and a fresh tab-parser task using the
specific earlier empty-field constraint before its first command. The new workspace
contained only the new starter/check, with prior source files archived outside it.
Source events, stored records, delivered context and behavior have separate receipts.
Observed command exit results remain distinct from the agent's inferred cause.

Accepted text evidence also covers English and one mixed Arabic/English episode,
fresh sessions and per-turn task changes, source-attributed reuse, sharing
off/on/exclusion/revocation and unrelated task suppression. Affected correction and
sharing checks were rerun after the changes. Retrieval uses lexical and graph signals; semantic
embeddings were unavailable in the measured episodes. Different wording succeeded
in those cases but arbitrary paraphrase recall is not established. Full expansion
uses current permissions; there is no implicit semantic sharing authorization.

Not established: Codex desktop UI observation, a fresh Claude Desktop chain, general bilingual accuracy,
mid-turn delivery, every native tool event, or a fair native-memory comparison.
Memory is eventually available: the next task can run before new experience is
processed, and bounded quotas can leave a backlog. Retrieval never waits for the
backlog to drain. The release evidence reports answer visibility, memory delay
and all known usage, including failed/unknown calls; this is not a savings claim.
