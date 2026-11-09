# Integrated experience lifecycle

ShadowGraph supplies usable experience at a read boundary. It does not choose an action, execute a workflow or decide whether an owner's work may continue. Delivery, capture and extraction are separate capabilities, inert until their required activation. A source checkout passing tests does not update an installed runtime.

## Capture and extraction

Capture records eligible redacted material only in the enrolled external capture store. Project-owned reads stay inside the resolved project. An origin identifies unattributed ownership; project-owned records sharing that origin do not become origin-owned. Existing manual stores are neither migrated nor combined automatically.

Capture admission and hook deadlines bound producer work. Extraction runs separately from delivery and capture, under its own lease, generation and frozen usage limits. A result commits only after rechecking ownership, claim identity, generation and eligibility. Failed, cancelled and stale invocations do not invent successful receipts or refund reserved usage. Synthetic executors in the test suite establish engineering behavior only; actual provider and host evidence is specific to the approved installed configuration.

## Correction and reprocessing

An owner correction updates current experience and invalidates dependent views. The next applicable delivery uses the current eligible version. A changed processor can make a capture reprocessable; this does not enqueue it. Reprocessing requires an explicit authorized request and retained eligible raw material. Its successful commit supersedes prior extraction output while preserving owner corrections. A completion from an old claim remains stale after a new generation or settled reprocessing.

The delivery cap, redaction and project boundary also apply after correction. Measured installed-host correction-to-delivery latency is evidence for the tested host and trigger, not a universal latency promise or proof that a model consumed the corrected record.

## Retention and deletion

Eligible uncited raw expires under the configured policy, including clearly identified raw associated with quarantine. Expiry never releases quarantine and does not discard accepted experience or required cited evidence merely because its raw capture aged. Possibly-purged legacy material remains hidden and owner-releasable rather than automatically deleted because it is quarantined. Expired raw may no longer support re-extraction.

Pending-item deletion, exact project purge and exact unattributed-origin purge use the existing durable deletion boundary. Canonical data, controlled source copies, retry values, replay material and project/origin-owned auxiliary data are reconciled together. When a retained experience loses a source, availability changes without inventing a new verification result. Unsupported mixed-source cleanup or an applicable restore containing unbound raw refuses before installing unsafe material.

Markdown pruning is explicit. It removes only an unchanged tracked projection in the selected project whose canonical record is absent. Edited, untracked, unsafe linked and other-project files remain protected. The synchronization path refuses stale or held projections when their tracking or invalidated/held identity remains known. A detached copy whose identity and tracking history are absent cannot always be recognized as stale.

See the [data lifecycle map](../data-lifecycle.md) for all twelve locations and their retained-copy limits. Backups and interrupted-restore recovery files can retain material later purged or expired from the active store. This documented limitation is not a claim of complete physical erasure, and expiry or purge does not authorize deleting those files.

## Restore, restart and rollback

The frozen restore primitive is wrapped by deletion-aware classification, commit-bound recovery and pure read suppression. Reads do not finish pending purge/restore records. Supported writes resolve pending work through its recorded inputs; interrupted token assignment reuses reserved tokens. Restore cannot revive revoked authority or refund extraction usage.

Logical purge preserves replayable skeletons. Hard purge removes journal positions and deliberately reports an incomplete contiguous rebuild. Restore accepts those gaps only when the purge ledger proves every missing position and the surviving projection exactly matches the stored records, facts, relations and retry mappings. A successful restore is not a claim that erased history can be reconstructed.

Journal-less merges compare retry values against their validated current entities, so a legitimate lifecycle change does not make an unrelated overwrite fail. Index-only memory refreshes preserve identity and version, update each retry alias, and journal each alias through the existing complete-snapshot format. Retry identity and content corruption still refuse; these corrections introduce no new on-disk entry shape.

A schema number or preservation of unknown fields does not establish safe operation by an older reader. Completed-output preservation, pending-read enforcement, restore recovery and active extraction have separate compatibility floors. Consult the [compatibility limits](../data-lifecycle.md#compatibility-and-rollback) before any rollback. Disable extraction and establish child settlement before changing a supported runtime; retain current activation and budget protections. Do not restore old activation bytes or reconnect an incompatible reader to newer state.

Deactivation disables capability state before cleanup and reports cleanup completion separately. Managed-hook uninstall preserves unrelated settings. Neither action is a request to erase experience, backup files or recovery material.

## Verification boundary

The integrated regression sequence covers capture, synthetic extraction, the real delivery code path, correction, authorized reprocessing, stale-result rejection, pending deletion, retention, explicit Markdown cleanup, purge, backup/restore, restart/rebuild, deactivation and hook uninstall on JSON and SQLite. Dedicated regression matrices cover concurrent claims, generation invalidation, budget reservations, interrupted restore and child settlement. Fixture activation is not real-host approval.

Known limits include pattern-based redaction, bounded capture coverage and same-turn delivery gaps, conservative claim verification, one pinned delivery store, and platform/version-specific extraction support. Engineering regression results do not establish independent acceptance or actual-host activation. No release or publication follows from these test results.
