import test from 'node:test';
import assert from 'node:assert/strict';
import * as journal from '../src/journal.js';

const {
  JOURNAL_TYPE_ENTITY_KIND,
  REPLAYABLE_ENTRY_TYPES,
  hardPurgeGapLedgerReport,
  journalBaselinePlacementIssues,
  journalFactLifecycleIssues,
  rebuildProjection
} = journal;

const NOW = '2026-08-28T00:00:00.000Z';
const PROJECT = 'pure-rebuild-canonicality';
const VICTIM = Object.freeze({
  id: 'pure-rebuild-victim',
  kind: 'decision',
  schemaVersion: 5,
  project: PROJECT,
  title: 'Preserve this projection',
  chosen: 'keep',
  status: 'proposed',
  alternatives: [],
  confidence: 0.5
});
const NULL_PROVENANCE = Object.freeze({ actor: null, client: null, sessionId: null });
const STABLE_WHY = 'noncanonical_schema5_purge_artifact';
const STABLE_REASON = 'journal contains noncanonical schema-5 purge artifacts';

function seedEntry(schemaVersion = 5) {
  const payload = { ...VICTIM, schemaVersion };
  return {
    id: `seed-${schemaVersion}`,
    seq: 1,
    type: 'decision.recorded',
    at: NOW,
    project: PROJECT,
    entityKind: 'decision',
    entityId: payload.id,
    schemaVersion,
    payload,
    idempotencyKey: `decision:${PROJECT}:retry`,
    provenance: { ...NULL_PROVENANCE }
  };
}

function canonicalSkeleton(type, seq = 2) {
  return {
    id: `canonical-${type}-${seq}`,
    seq,
    type,
    at: NOW,
    project: PROJECT,
    entityKind: JOURNAL_TYPE_ENTITY_KIND[type] ?? null,
    entityId: null,
    schemaVersion: 5,
    payload: null,
    redacted: true,
    redactedReason: 'project_purged',
    provenance: { ...NULL_PROVENANCE }
  };
}

function assertSeedProjection(report, label) {
  assert.equal(report.rebuildable, false, `${label}: invalid artifact must block a complete rebuild claim`);
  assert.equal(report.reason, STABLE_REASON, `${label}: stable rebuild reason`);
  assert.equal(report.applied, 1, `${label}: invalid artifact must not be folded`);
  assert.deepEqual(report.projection.records, [VICTIM], `${label}: invalid artifact must not delete or rewrite the entity`);
  assert.deepEqual(report.projection.idempotency, [{
    key: `decision:${PROJECT}:retry`,
    value: VICTIM
  }], `${label}: invalid artifact must not delete or rewrite idempotency`);
  assert.equal(report.skipped.length, 1, `${label}: exactly the invalid artifact is skipped`);
  assert.equal(report.skipped[0].why, STABLE_WHY, `${label}: stable skip code`);
  assert.equal(report.skipped[0].seq, 2, `${label}: skipped sequence is attributable`);
}

const MALFORMED_SKELETON_VARIANTS = Object.freeze([
  {
    name: 'payload_null_redacted_omitted',
    detail: /purge skeleton must set redacted true/,
    mutate(entry) {
      entry.entityId = VICTIM.id;
      delete entry.redacted;
      delete entry.redactedReason;
    }
  },
  {
    name: 'payload_null_redacted_false',
    detail: /purge skeleton must set redacted true/,
    mutate(entry) {
      entry.entityId = VICTIM.id;
      entry.redacted = false;
      delete entry.redactedReason;
    }
  },
  {
    name: 'purge_reason_redacted_omitted',
    detail: /purge skeleton must set redacted true/,
    mutate(entry) {
      entry.entityId = VICTIM.id;
      entry.payload = { ...VICTIM, title: 'forged overwrite' };
      entry.idempotencyKey = `decision:${PROJECT}:forged`;
      delete entry.redacted;
    }
  },
  {
    name: 'purge_reason_redacted_false',
    detail: /purge skeleton must set redacted true/,
    mutate(entry) {
      entry.entityId = VICTIM.id;
      entry.payload = { ...VICTIM, title: 'forged overwrite' };
      entry.idempotencyKey = `decision:${PROJECT}:forged`;
      entry.redacted = false;
    }
  },
  {
    name: 'redacted_true_missing_reason',
    detail: /noncanonical redactedReason/,
    mutate(entry) { delete entry.redactedReason; }
  },
  {
    name: 'redacted_true_legacy_reason',
    detail: /noncanonical redactedReason/,
    mutate(entry) { entry.redactedReason = 'legacy_project_purged'; }
  },
  {
    name: 'redacted_true_non_null_identity',
    detail: /erase entityId and payload/,
    mutate(entry) { entry.entityId = VICTIM.id; }
  },
  {
    name: 'redacted_true_non_null_payload',
    detail: /erase entityId and payload/,
    mutate(entry) { entry.payload = { ...VICTIM, title: 'must not be folded' }; }
  },
  {
    name: 'redacted_true_missing_provenance',
    detail: /erase provenance identity/,
    mutate(entry) { delete entry.provenance; }
  },
  {
    name: 'redacted_true_identifying_provenance',
    detail: /erase provenance identity/,
    mutate(entry) { entry.provenance = { actor: 'private-actor', client: null, sessionId: null }; }
  },
  {
    name: 'replayable_false',
    detail: /marked_non_replayable/,
    mutate(entry) { entry.replayable = false; }
  },
  {
    name: 'forbidden_identity_field',
    detail: /forbidden identity field requestId/,
    mutate(entry) { entry.requestId = 'private-request'; }
  },
  {
    name: 'forbidden_unknown_field',
    detail: /forbidden identity field secretContext/,
    mutate(entry) { entry.secretContext = 'private-context'; }
  }
]);

test('pure rebuild rejects every malformed schema-5 purge-skeleton variant for every replayable type without mutation', () => {
  let exercised = 0;
  for (const type of REPLAYABLE_ENTRY_TYPES) {
    for (const variant of MALFORMED_SKELETON_VARIANTS) {
      const malformed = canonicalSkeleton(type);
      malformed.id = `malformed-${type}-${variant.name}`;
      variant.mutate(malformed);
      const label = `${type}/${variant.name}`;
      const report = rebuildProjection([seedEntry(), malformed], { journalEpoch: 1 });
      assertSeedProjection(report, label);
      assert.match(report.skipped[0].detail, variant.detail, `${label}: validator identifies the violated canonical rule`);
      exercised += 1;
    }
  }
  assert.equal(exercised, REPLAYABLE_ENTRY_TYPES.length * MALFORMED_SKELETON_VARIANTS.length);
});

test('pure rebuild accepts canonical schema-5 purge skeletons only for known replayable types', () => {
  for (const type of REPLAYABLE_ENTRY_TYPES) {
    const report = rebuildProjection([canonicalSkeleton(type, 1)], { journalEpoch: 1 });
    assert.equal(report.rebuildable, true, `${type}: canonical skeleton remains readable`);
    assert.equal(report.reason, null, `${type}: no false diagnostic`);
    assert.equal(report.applied, 1, `${type}: canonical tombstone is folded`);
    assert.deepEqual(report.skipped, [], `${type}: canonical tombstone is not skipped`);
    assert.deepEqual(report.projection.records, [], `${type}: a null-identity skeleton invents no entity`);
    assert.deepEqual(report.projection.idempotency, [], `${type}: a null-identity skeleton invents no idempotency`);
  }

  const unknown = canonicalSkeleton('unknown.replayable', 1);
  const unknownReport = rebuildProjection([unknown], { journalEpoch: 1 });
  assert.equal(unknownReport.rebuildable, false);
  assert.equal(unknownReport.applied, 0);
  assert.equal(unknownReport.skipped[0].why, 'unknown_entry_type');
});

test('legacy_metadata_event remains the narrow payload-null non-replayable compatibility type', () => {
  const legacy = {
    id: 'legacy-audit-only',
    seq: 1,
    type: 'legacy_metadata_event',
    at: NOW,
    project: null,
    entityKind: null,
    entityId: 'legacy-audit-identity',
    schemaVersion: 5,
    payload: null,
    replayable: false,
    originalType: 'decision.recorded',
    provenance: { actor: 'legacy-actor', client: null, sessionId: null }
  };
  const report = rebuildProjection([legacy]);
  assert.equal(report.rebuildable, true);
  assert.equal(report.applied, 0);
  assert.deepEqual(report.skipped, []);
  assert.deepEqual(report.legacy, [{ id: legacy.id, type: legacy.type, why: 'non_replayable_type' }]);
  assert.deepEqual(report.projection.records, []);
  assert.deepEqual(report.projection.idempotency, []);
});

test('pure rebuild validates schema-5 purge markers before structural deletion', () => {
  const canonicalMarker = {
    id: 'canonical-marker',
    seq: 2,
    type: 'project.purged',
    at: NOW,
    project: PROJECT,
    entityKind: 'project',
    entityId: null,
    schemaVersion: 5,
    payload: { project: PROJECT, mode: 'logical', removed: 1, removedJournalSequences: [] },
    provenance: { ...NULL_PROVENANCE }
  };
  const accepted = rebuildProjection([seedEntry(), canonicalMarker], { journalEpoch: 1 });
  assert.equal(accepted.rebuildable, true);
  assert.equal(accepted.applied, 2);
  assert.deepEqual(accepted.projection.records, []);
  assert.deepEqual(accepted.projection.idempotency, []);

  const invalidMarkers = [
    ['non_null_entity_id', (entry) => { entry.entityId = PROJECT; }, /erase entityId/],
    ['identifying_provenance', (entry) => { entry.provenance.actor = 'private-actor'; }, /erase provenance identity/],
    ['forbidden_envelope_field', (entry) => { entry.requestId = 'private-request'; }, /forbidden identity field requestId/],
    ['forbidden_payload_field', (entry) => { entry.payload.purgedEntityIds = [VICTIM.id]; }, /forbidden payload field purgedEntityIds/]
  ];
  for (const [name, mutate, detail] of invalidMarkers) {
    const marker = structuredClone(canonicalMarker);
    marker.id = `invalid-marker-${name}`;
    mutate(marker);
    const report = rebuildProjection([seedEntry(), marker], { journalEpoch: 1 });
    assertSeedProjection(report, `project.purged/${name}`);
    assert.match(report.skipped[0].detail, detail);
  }
});

test('schema-5 purge validation is shared by lifecycle, baseline, and hard-gap diagnostics', () => {
  const fact = {
    id: 'fact-lifecycle', kind: 'fact', schemaVersion: 5, project: PROJECT,
    status: 'active', verificationStatus: 'unverified'
  };
  const observed = {
    id: 'fact-observed', seq: 1, type: 'fact.observed', at: NOW, project: PROJECT,
    entityKind: 'fact', entityId: fact.id, schemaVersion: 5, payload: fact,
    provenance: { ...NULL_PROVENANCE }
  };
  const invalidProjectPurge = {
    id: 'invalid-project-purge', seq: 2, type: 'project.purged', at: NOW, project: PROJECT,
    entityKind: 'project', entityId: null, schemaVersion: 5,
    payload: { project: PROJECT, mode: 'logical', removed: 1 },
    redactedReason: 'project_purged',
    provenance: { ...NULL_PROVENANCE }
  };
  const verified = {
    ...observed,
    id: 'fact-verified', seq: 3, type: 'fact.verified',
    payload: { ...fact, verificationStatus: 'verified', verification: { method: 'test' } }
  };
  assert.deepEqual(
    journalFactLifecycleIssues([observed, invalidProjectPurge, verified], { journalEpoch: 1 }),
    [],
    'an invalid purge artifact cannot erase lifecycle state used by later diagnostics'
  );

  const invalidTombstone = canonicalSkeleton('decision.recorded', 2);
  invalidTombstone.entityId = VICTIM.id;
  invalidTombstone.redacted = false;
  delete invalidTombstone.redactedReason;
  const added = { ...VICTIM, id: 'migration-added' };
  const migrationBaseline = {
    id: 'migration-extension', seq: 3, type: 'projection.baseline', at: NOW,
    project: null, entityKind: null, entityId: null, schemaVersion: 5,
    derivedFrom: 'live_state_at_migration',
    payload: { records: [VICTIM, added], facts: [], relations: [], idempotency: [] },
    provenance: { ...NULL_PROVENANCE }
  };
  assert.deepEqual(
    journalBaselinePlacementIssues([seedEntry(), invalidTombstone, migrationBaseline], { journalEpoch: 1 }),
    [],
    'an invalid tombstone cannot manufacture a resurrection finding in baseline diagnostics'
  );

  const invalidHardMarker = {
    ...invalidProjectPurge,
    seq: 3,
    payload: { project: PROJECT, mode: 'hard', removed: 1, removedJournalSequences: [2] }
  };
  const gapReport = hardPurgeGapLedgerReport([seedEntry(), invalidHardMarker], { journalEpoch: 1 });
  assert.equal(gapReport.valid, false, 'an invalid purge marker cannot authorize a hard-purge gap');
  assert.ok(gapReport.issues.some((issue) => issue.code === 'unexplained_journal_gap'));
});

test('schemas 1-4 raw purge artifacts and canonical schema-5 hard-gap ledgers retain compatibility', () => {
  for (const schemaVersion of [1, 2, 3, 4]) {
    const rawMarker = {
      id: `legacy-marker-${schemaVersion}`,
      seq: 2,
      type: 'project.purged',
      at: NOW,
      project: 'legacy-command-scope',
      entityKind: 'project',
      entityId: 'legacy-command-scope',
      schemaVersion,
      payload: {
        project: 'legacy-command-scope', mode: 'logical', removed: 1,
        purgedEntityIds: [VICTIM.id]
      },
      provenance: { actor: 'legacy-actor', client: 'legacy-client', sessionId: 'legacy-session' }
    };
    const markerReport = rebuildProjection([seedEntry(schemaVersion), rawMarker], { journalEpoch: 1 });
    assert.equal(markerReport.rebuildable, true, `schema ${schemaVersion}: raw marker remains readable`);
    assert.equal(markerReport.applied, 2);
    assert.deepEqual(markerReport.projection.records, []);
    assert.deepEqual(markerReport.projection.idempotency, []);

    const rawTombstone = {
      ...seedEntry(schemaVersion),
      id: `legacy-tombstone-${schemaVersion}`,
      seq: 2,
      payload: null
    };
    const tombstoneReport = rebuildProjection([seedEntry(schemaVersion), rawTombstone], { journalEpoch: 1 });
    assert.equal(tombstoneReport.rebuildable, true, `schema ${schemaVersion}: legacy payload-null tombstone remains readable`);
    assert.equal(tombstoneReport.applied, 2);
    assert.deepEqual(tombstoneReport.projection.records, []);
    assert.deepEqual(tombstoneReport.projection.idempotency, []);
  }

  const hardMarker = {
    id: 'canonical-hard-marker', seq: 3, type: 'project.purged', at: NOW,
    project: PROJECT, entityKind: 'project', entityId: null, schemaVersion: 5,
    payload: { project: PROJECT, mode: 'hard', removed: 1, removedJournalSequences: [2] },
    provenance: { ...NULL_PROVENANCE }
  };
  const ledger = hardPurgeGapLedgerReport([seedEntry(), hardMarker], { journalEpoch: 1 });
  assert.equal(ledger.valid, true);
  assert.equal(ledger.claims, 1);
  const rebuild = rebuildProjection([seedEntry(), hardMarker], { journalEpoch: 1 });
  assert.equal(rebuild.rebuildable, false, 'hard purge remains an explicitly declared physical journal gap');
  assert.equal(rebuild.reason, 'journal contains unexplained sequence gaps inside the replay range');
  assert.deepEqual(rebuild.projection.records, []);
  assert.deepEqual(rebuild.projection.idempotency, []);
});

test('journal exports the canonical schema-5 purge-artifact validator for graph-layer reuse', () => {
  assert.equal(typeof journal.schema5PurgeArtifactIssue, 'function');
  const canonical = canonicalSkeleton('decision.recorded', 1);
  assert.equal(journal.schema5PurgeArtifactIssue(canonical), null);
  const malformed = { ...canonical, redacted: false };
  assert.match(journal.schema5PurgeArtifactIssue(malformed), /redacted true/);

  const currentEnvelopeEntry = { ...canonical };
  delete currentEnvelopeEntry.schemaVersion;
  assert.equal(journal.schema5PurgeArtifactIssue(currentEnvelopeEntry, 5), null);
});
