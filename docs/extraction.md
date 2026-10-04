# Extraction activation and operation

Extraction is a one-shot owner CLI worker. Capture requests it after an eligible Stop or SessionEnd by spawning a detached, unreferenced process with ignored standard streams. Capture never waits for a model call. Delivery, MCP and HTTP do not invoke or activate extraction. There is no extraction listener or daemon. Detached survival on a particular host must be measured; if it is not verified, use explicit `shadowgraph extract` and narrow the automation claim.

## Activate only after the extraction gate

Prepare and verify the exact packed runtime before requesting approval. A real runtime replacement, activation and first real model call require the owner's explicit gate approval. The command records evidence, the exact shared runtime/store, the resolved executor configuration, frozen budgets and a new activation identity:

```text
shadowgraph activate extraction --evidence <receipt> --store <private-store> --runtime <pinned-runtime> --executable <absolute-Claude-executable> --no-overage-confirmed true
```

The owner must confirm subscription-only operation with no overage on every activation. Outside synthetic scratch locations the terminal also asks for confirmation of the exact configuration. There is no API-key, proxy, alternate-provider or paid fallback. The executor is pinned to its supported host/configuration profile and model. It repeats the restriction and subscription checks before each invocation and refuses a changed executable/configuration. Activation checks do not invoke the model. Capture must already be active for the same private store/runtime; an active delivery capability must match too. Live capture continues to require JSON; the internal worker and lifecycle safety are tested on JSON and SQLite, which is not a claim that live SQLite capture has been enabled.

`shadowgraph extract --project <project>` or `--origin <origin>` is an explicit scoped drain. With neither argument, a workspace binding confirmed in the store is required. Read grants do not authorize extraction writes. Automatic drains consider covered project queues in the activated store; all scopes share one per-drain budget and the same per-user usage window. An excluded project or unattributed origin can only be selected explicitly by the owner. A manual-store environment override never replaces the activated destination.

## Budgets and status

The fixed ceilings are 65,536 input prompt bytes per item, four items and four calls per drain, 240 seconds of work, twelve calls per rolling hour, one retry with one second backoff, and 128 journal entries per captured session. Capture admission limits remain unchanged. Shutdown additionally allows bounded child termination and lease/status cleanup; filesystem latency is not a hard real-time guarantee. The usage file persists reservations outside memory stores and backups. Crashes and ambiguous results do not refund calls, and reactivation does not reset usage.

Capture inspection, normal read completeness and delivery expose the existing pending/processing/error fields. `extractionAvailable` is a fresh projection of configured extraction for the exact store and covered project, with no outstanding worker error or unsettled execution. It is false for a busy or unconfirmed execution, inactive/malformed configuration, another store, or a library graph without a host availability projection. The delivery `extraction` label reports active configuration separately. These reads do not probe model/service health, consume quota, start extraction, write operational state or grant access. Availability is never serialized into memory or restored from a backup. Historical errors remain visible until a successful worker status write clears them.

## Deactivate, uninstall and recover

```text
shadowgraph deactivate extraction
shadowgraph uninstall-hooks
```

Activation and deactivation serialize their final record changes under one short shared fence. Confirmation and host checks happen before taking that fence; activation rechecks the approved record inside it. Concurrent changes cannot overwrite another capability's deactivation or history. Deactivation persists the disabled state first. The worker checks it during a call, between items and before commit, terminates its local child, discards late output and leaves uncommitted items pending. An atomic commit already started cannot be undone by later cancellation. Cleanup waits for the worker lifetime fence, including child settlement. Uninstall also disables extraction when no hook entries remain. Neither operation claims to cancel a remote model request or erase provider bookkeeping.

A locked or unreadable store cannot re-enable extraction. Cleanup reports `deferred` when it cannot prove local settlement. Each host process has a bounded one-shot supervisor connected through private IPC. The supervisor validates its content-free identity and settlement path before reporting ready, and receives the host request only after the running marker is durable. If the worker dies before that request, it records proof that no host child started. If the worker dies during the request, the supervisor stops its own host child and writes content-free settlement proof. `extraction-worker` records the invocation identity and state; only matching proof permits automatic recovery after the usage fence and item lease expire. Raw prompts and output are not written to these operational files. An absent, mismatched or unconfirmed settlement remains blocked and cleanup reports deferred; preserve that evidence and reconcile the particular execution before restarting. The supervisor is detached so it can finish cleanup after its parent exits; it does not remain as a daemon. Cancellation allows up to two seconds for supervisor settlement in addition to bounded lease/status cleanup. Do not kill an unrelated process based on a stale PID or delete memory/control files to clear the condition.

## Source identity and compatibility

Before each invocation the worker registers a fresh dedicated session UUID, lease ID/window and an opaque correlation token in `extraction-invocations.json`. The registry is bounded to 128 rows and 64 KiB and stores no captured material. The session ID is passed through the supported host switch; the correlation token is passed in controlled invocation arguments and remains unchanged for an identical-prompt retry. Capture excludes S3 only for that dedicated invocation during its lease window. A user-session tool ID match or historical session list is insufficient. Missing or malformed attribution preserves user capture; an unavailable registry blocks a new model invocation. The restriction profile still disables child hooks and session persistence; actual host semantics require gate evidence.

The PR41 activation/trigger runtime requires the PR40 worker-budget floor and the generation and retention floors already documented. Earlier readers may preserve unknown metadata but do not enforce these operational semantics. Concurrent activation-record writers must all use the PR41 shared-record fence; do not run older activation/deactivation commands concurrently with this build. Before rollback, deactivate extraction, confirm cleanup and drain/reconcile outstanding leases. Never run an older worker against active extraction. Delivery/capture runtime changes must preserve exact shared-store/runtime checks. Prepare and approve the real re-pin before executing it.

Eligible uncited raw expires under retention even when quarantined. Expiry does not release quarantine or remove accepted experience and required cited evidence. Expired raw cannot be re-extracted. Backups and interrupted-restore recovery files may retain material removed from the active store; this is a documented activation limitation, not complete physical erasure. These commands do not delete those copies or modify the protected restore primitives.
