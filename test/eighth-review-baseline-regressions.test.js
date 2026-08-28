import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreFile } from '../src/backup.js';
import { rebuildProjection } from '../src/journal.js';

const INVALID_BASELINE_PLACEMENT_CODE = 'invalid_projection_baseline_placement';
import { createRestoreValidator, validateRestorePayload } from '../src/restore-validation.js';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';
import { createFactAttestation, createLocalEvidenceVerifier } from '../src/verification.js';

const NOW = '2026-08-27T12:00:00.000Z';
const EXPIRES_AT = '2026-09-30T00:00:00.000Z';

async function verifierFixture(directory) {
  const keys = generateKeyPairSync('ed25519');
  const evidenceRoot = join(directory, 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const verifier = createLocalEvidenceVerifier({
    allowedEvidenceRoot: evidenceRoot,
    trustedVerifiers: { approver: keys.publicKey }
  });
  const configPath = join(directory, 'verifier.json');
  await writeFile(configPath, JSON.stringify({
    allowedEvidenceRoot: evidenceRoot,
    trustedVerifiers: { approver: keys.publicKey.export({ type: 'spki', format: 'pem' }) }
  }), 'utf8');
  return { keys, evidenceRoot, verifier, configPath };
}

async function signedMidstreamBaselineAttack(directory, fixture, terminal, suffix = terminal) {
  const clock = { value: NOW };
  const graph = createShadowGraph({ verifier: fixture.verifier, now: () => clock.value });
  const decision = graph.addDecision({
    id: `ds-p1-006-decision-${suffix}`,
    project: 'ds-p1-006',
    title: `DS-P1-006 ${terminal} relation host`,
    chosen: 'preserve lifecycle'
  });
  const fact = graph.addFact({
    id: `ds-p1-006-fact-${suffix}`,
    project: 'ds-p1-006',
    key: `signed-${suffix}`,
    value: { signed: true, terminal },
    expiresAt: EXPIRES_AT,
    idempotencyKey: `retry-${suffix}`
  });
  graph.link({
    id: `ds-p1-006-relation-${suffix}`,
    from: decision.id,
    to: fact.id,
    relation: 'depends_on'
  });
  const evidencePath = join(fixture.evidenceRoot, `${fact.id}.json`);
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({
    fact,
    verifierIdentity: 'approver',
    evidenceReference: `ticket:${fact.id}`,
    verifiedAt: '2026-08-27T12:05:00.000Z',
    privateKey: fixture.keys.privateKey
  })), 'utf8');
  await graph.verifyFact({ factId: fact.id, evidencePath });
  const copiedActive = graph.exportData();
  const copiedFact = structuredClone(copiedActive.facts.find((item) => item.id === fact.id));
  assert.equal(copiedFact.verificationStatus, 'verified');

  if (terminal === 'expired') {
    clock.value = '2026-10-01T00:00:00.000Z';
    graph.maintain({ now: clock.value });
  } else {
    graph.addFact({
      id: `ds-p1-006-replacement-${suffix}`,
      project: fact.project,
      key: fact.key,
      value: { replacement: true },
      validFrom: '2026-09-01T00:00:00.000Z',
      observedAt: '2026-09-01T00:00:00.000Z',
      recordedAt: '2026-09-01T00:00:00.000Z'
    });
  }

  const terminalPayload = graph.exportData();
  const terminalFact = terminalPayload.facts.find((item) => item.id === fact.id);
  assert.equal(terminalFact.status, terminal);
  assert.deepEqual(terminalFact.verification, copiedFact.verification, 'the genuine copied signature survives the terminal transition');
  const legitimateTerminalPayload = structuredClone(terminalPayload);

  const baseline = {
    id: `ds-p1-006-forged-baseline-${suffix}`,
    seq: Math.max(...terminalPayload.journal.map((entry) => entry.seq)) + 1,
    type: 'projection.baseline',
    at: '2026-10-02T00:00:00.000Z',
    project: null,
    entityKind: null,
    entityId: null,
    schemaVersion: 5,
    derivedFrom: 'live_state_at_migration',
    payload: {
      records: structuredClone(copiedActive.records),
      facts: structuredClone(copiedActive.facts),
      relations: structuredClone(copiedActive.relations),
      idempotency: structuredClone(copiedActive.idempotency)
    },
    provenance: { actor: null, client: null, sessionId: null }
  };
  terminalPayload.journal.push(baseline);
  terminalPayload.journalSeq = baseline.seq;
  terminalPayload.records = structuredClone(baseline.payload.records);
  terminalPayload.facts = structuredClone(baseline.payload.facts);
  terminalPayload.relations = structuredClone(baseline.payload.relations);
  terminalPayload.idempotency = structuredClone(baseline.payload.idempotency);
  return { payload: terminalPayload, legitimateTerminalPayload, factId: fact.id, relationId: `ds-p1-006-relation-${suffix}` };
}

function assertPlacementError(action, label) {
  assert.throws(action, (error) => {
    assert.equal(error.code, INVALID_BASELINE_PLACEMENT_CODE, `${label}: stable error code`);
    assert.match(error.message, /projection baseline placement/i, `${label}: explicit diagnostic`);
    return true;
  });
}

function assertIncompleteBaselineReport(payload, label) {
  const report = rebuildProjection(payload.journal, { journalEpoch: payload.journalEpoch });
  assert.equal(report.rebuildable, false, `${label}: rebuild must be incomplete`);
  assert.equal(report.reason, 'journal contains invalid projection baseline placement');
  assert.ok(report.skipped.some((entry) => entry.why === INVALID_BASELINE_PLACEMENT_CODE), `${label}: stable issue code`);
  return report;
}

function baselineOnlyPayload(schemaVersion = 5, suffix = String(schemaVersion)) {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData({
    schemaVersion,
    records: [{
      id: `ds-p1-006-migrated-${suffix}`,
      kind: 'decision',
      schemaVersion,
      project: 'ds-p1-006-migration',
      title: `Schema ${schemaVersion} migration baseline`,
      chosen: 'preserve',
      status: schemaVersion < 5 ? 'active' : 'proposed',
      alternatives: [],
      confidence: 0.5
    }]
  });
  return graph.exportData();
}

function placementVariants() {
  const duplicate = baselineOnlyPayload(5, 'duplicate');
  const duplicateEntry = structuredClone(duplicate.journal[0]);
  duplicateEntry.id += '-duplicate';
  duplicateEntry.seq += 1;
  duplicate.journal.push(duplicateEntry);
  duplicate.journalSeq = duplicateEntry.seq;

  const midstreamGraph = createShadowGraph({ now: () => NOW });
  midstreamGraph.addDecision({ id: 'ds-p1-006-midstream-existing', title: 'Existing', chosen: 'keep' });
  const midstream = midstreamGraph.exportData();
  const midstreamEntry = structuredClone(baselineOnlyPayload(5, 'midstream').journal[0]);
  midstreamEntry.id = 'ds-p1-006-midstream-baseline';
  midstreamEntry.seq = 2;
  delete midstreamEntry.derivedFrom;
  midstream.journal.push(midstreamEntry);
  midstream.journalSeq = 2;
  midstream.records.push(...structuredClone(midstreamEntry.payload.records));

  const rewind = baselineOnlyPayload(5, 'rewind');
  rewind.journalEpoch = rewind.journal[0].seq + 1;

  const wrongEpoch = baselineOnlyPayload(5, 'wrong-epoch');
  wrongEpoch.journal[0].seq = 2;
  wrongEpoch.journalSeq = 2;
  wrongEpoch.journalEpoch = 1;

  return [
    ['duplicate', duplicate],
    ['midstream', midstream],
    ['rewind', rewind],
    ['wrong epoch', wrongEpoch]
  ];
}

async function writePayload(path, payload) {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function oldPayload(suffix) {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({ id: `ds-p1-006-old-${suffix}`, project: 'old', title: `OLD ${suffix}`, chosen: 'preserve' });
  return graph.exportData();
}

function runCli(file, source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', 'restore', source], {
      cwd: process.cwd(),
      env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startMcp(file, verifierConfig) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SHADOWGRAPH_FILE: file,
      SHADOWGRAPH_STORAGE: 'json',
      ...(verifierConfig ? { SHADOWGRAPH_VERIFIER_CONFIG: verifierConfig } : {})
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop();
    for (const line of lines.filter((candidate) => candidate.trim())) {
      const response = JSON.parse(line);
      const waiter = pending.get(JSON.stringify(response.id));
      if (!waiter) continue;
      pending.delete(JSON.stringify(response.id));
      waiter.resolve(response);
    }
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited with ${code}: ${stderr}`));
    pending.clear();
  });
  return {
    call(request) {
      return new Promise((resolve, reject) => {
        const key = JSON.stringify(request.id);
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`MCP timeout: ${stderr}`));
        }, 10_000);
        pending.set(key, {
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); }
        });
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };
}

test('DS-P1-006 eighth review: matching-live midstream baselines cannot resurrect expired or superseded signed facts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-eighth-review-core-'));
  const fixture = await verifierFixture(directory);

  for (const terminal of ['expired', 'superseded']) {
    const attack = await signedMidstreamBaselineAttack(directory, fixture, terminal);
    const report = assertIncompleteBaselineReport(attack.payload, terminal);
    assert.ok(report.skipped.some((entry) => entry.placement === 'after_terminal'), `${terminal}: baseline-after-terminal is explicit`);
    const rebuiltFact = report.projection.facts.find((fact) => fact.id === attack.factId);
    assert.notDeepEqual(
      { status: rebuiltFact?.status, verificationStatus: rebuiltFact?.verificationStatus },
      { status: 'active', verificationStatus: 'verified' },
      `${terminal}: incomplete rebuild cannot expose an active verified resurrection`
    );
    assert.equal(rebuiltFact?.status, terminal, `${terminal}: the prior terminal lifecycle remains authoritative`);
    assert.equal(report.projection.relations.some((relation) => relation.id === attack.relationId), true, `${terminal}: relation is covered by the forged matching-live snapshot`);
    assert.equal(report.projection.idempotency.some((entry) => entry.value.id === attack.factId), true, `${terminal}: idempotency cache is covered by the forged matching-live snapshot`);

    for (const verifier of [fixture.verifier, null]) {
      const label = `${terminal}/${verifier ? 'verifier' : 'no-verifier'}`;
      const target = createShadowGraph({ verifier, now: () => NOW });
      const before = target.exportData();
      assertPlacementError(() => target.importData(attack.payload), `${label} import`);
      assert.deepEqual(target.exportData(), before, `${label}: failed merge import is atomic`);

      const replacement = createShadowGraph({ verifier, now: () => NOW });
      replacement.addDecision({ id: `ds-p1-006-replace-old-${terminal}-${verifier ? 'v' : 'nv'}`, title: 'OLD', chosen: 'preserve' });
      const replacementBefore = replacement.exportData();
      assertPlacementError(() => replacement.replaceData(attack.payload), `${label} replace`);
      assert.deepEqual(replacement.exportData(), replacementBefore, `${label}: failed replacement is atomic`);

      assertPlacementError(
        () => createRestoreValidator({ verifier, now: () => NOW })(attack.payload),
        `${label} restore validation`
      );
    }
  }
});

test('DS-P1-006 eighth review: duplicate, midstream, rewind, and wrong-epoch baselines share one fail-closed contract', () => {
  const expectedPlacement = new Map([
    ['duplicate', 'duplicate'],
    ['midstream', 'midstream'],
    ['rewind', 'rewind'],
    ['wrong epoch', 'wrong_epoch']
  ]);
  for (const [label, payload] of placementVariants()) {
    const report = assertIncompleteBaselineReport(payload, label);
    assert.ok(report.skipped.some((entry) => entry.placement === expectedPlacement.get(label)), `${label}: classified placement`);

    const target = createShadowGraph({ now: () => NOW });
    const before = target.exportData();
    assertPlacementError(() => target.importData(payload), `${label} import`);
    assert.deepEqual(target.exportData(), before, `${label}: import destination unchanged`);

    const replacement = createShadowGraph({ now: () => NOW });
    replacement.addDecision({ id: `ds-p1-006-${label.replaceAll(' ', '-')}-old`, title: 'OLD', chosen: 'preserve' });
    const replacementBefore = replacement.exportData();
    assertPlacementError(() => replacement.replaceData(payload), `${label} replace`);
    assert.deepEqual(replacement.exportData(), replacementBefore, `${label}: replace destination unchanged`);

    assertPlacementError(() => validateRestorePayload(payload, { now: () => NOW }), `${label} restore payload`);
  }
});

test('DS-P1-006 eighth review: schema 1-5 and baseline-only migrations remain canonical across repeated rebuild and restart', () => {
  for (const schemaVersion of [1, 2, 3, 4, 5]) {
    let payload = baselineOnlyPayload(schemaVersion);
    for (let restart = 0; restart < 3; restart += 1) {
      const baselines = payload.journal.filter((entry) => entry.type === 'projection.baseline' && entry.replayable !== false);
      assert.equal(baselines.length, 1, `schema ${schemaVersion} restart ${restart}: one baseline`);
      assert.equal(payload.journalEpoch, baselines[0].seq, `schema ${schemaVersion} restart ${restart}: baseline owns epoch`);
      assert.equal(
        payload.journal.filter((entry) => entry.replayable !== false && entry.type !== 'legacy_metadata_event').sort((a, b) => a.seq - b.seq)[0].id,
        baselines[0].id,
        `schema ${schemaVersion} restart ${restart}: baseline is first replayable entry`
      );
      assert.doesNotThrow(() => validateRestorePayload(payload, { now: () => NOW }));
      const graph = createShadowGraph({ now: () => NOW });
      graph.importData(payload);
      const report = graph.rebuild();
      assert.equal(report.rebuildable, true, `schema ${schemaVersion} restart ${restart}: rebuildable`);
      assert.deepEqual(report.projection.records, graph.exportData().records, `schema ${schemaVersion} restart ${restart}: projection parity`);
      payload = graph.exportData();
    }
  }
});

test('DS-P1-006 eighth review: baseline-only signed snapshots preserve verifier downgrade rules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-eighth-review-baseline-only-signed-'));
  const fixture = await verifierFixture(directory);
  const active = await signedMidstreamBaselineAttack(directory, fixture, 'expired', 'baseline-only-source');
  const copied = active.payload.journal.at(-1).payload;
  const baselineOnly = {
    schemaVersion: 5,
    revision: 0,
    records: structuredClone(copied.records),
    facts: structuredClone(copied.facts),
    relations: structuredClone(copied.relations),
    reviewSignals: [],
    idempotency: structuredClone(copied.idempotency),
    events: [],
    journal: [{
      id: 'ds-p1-006-baseline-only-signed',
      seq: 17,
      type: 'projection.baseline',
      at: NOW,
      project: null,
      entityKind: null,
      entityId: null,
      schemaVersion: 5,
      derivedFrom: 'live_state_at_migration',
      payload: structuredClone(copied),
      provenance: { actor: null, client: null, sessionId: null }
    }],
    journalSeq: 17,
    journalEpoch: 17
  };

  const configured = createShadowGraph({ verifier: fixture.verifier, now: () => NOW });
  configured.importData(baselineOnly);
  assert.equal(configured.exportData().facts[0].verificationStatus, 'verified');
  assert.equal(configured.rebuild().projection.facts[0].verificationStatus, 'verified');

  const unconfigured = createShadowGraph({ now: () => NOW });
  unconfigured.importData(baselineOnly);
  assert.equal(unconfigured.exportData().facts[0].verificationStatus, 'unverified');
  assert.equal(unconfigured.exportData().facts[0].verificationUntrustedReason, 'verifier_not_configured');
  assert.equal(unconfigured.rebuild().projection.facts[0].verificationStatus, 'unverified');
});

test('DS-P1-006 eighth review: a monotonic migration extension preserves the signed terminal lifecycle and original replay epoch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-eighth-review-migration-extension-'));
  const fixture = await verifierFixture(directory);
  for (const terminal of ['expired', 'superseded']) {
    const source = await signedMidstreamBaselineAttack(directory, fixture, terminal, `migration-extension-${terminal}`);
    const graph = createShadowGraph({ verifier: fixture.verifier, now: () => NOW });
    graph.importData(source.legitimateTerminalPayload);
    const originalEpoch = graph.exportData().journalEpoch;
    const originalFirstSequence = Math.min(...graph.exportData().journal.filter((entry) => entry.replayable !== false).map((entry) => entry.seq));

    graph.importData({
      schemaVersion: 3,
      records: [{
        id: `ds-p1-006-extension-record-${terminal}`,
        kind: 'decision',
        schemaVersion: 3,
        project: 'ds-p1-006-extension',
        title: `Legacy extension after ${terminal}`,
        chosen: 'preserve terminal history',
        status: 'active',
        alternatives: [],
        confidence: 0.5
      }]
    });

    const exported = graph.exportData();
    assert.equal(exported.journalEpoch, originalEpoch, `${terminal}: migration cannot advance the replay boundary`);
    const report = graph.rebuild();
    assert.equal(report.rebuildable, true, `${terminal}: the proven extension remains rebuildable`);
    assert.equal(report.replayedFrom, originalFirstSequence, `${terminal}: prior replay history remains in range`);
    assert.equal(report.projection.facts.find((fact) => fact.id === source.factId).status, terminal);
    assert.equal(report.projection.records.some((record) => record.id === `ds-p1-006-extension-record-${terminal}`), true);
  }
});

test('DS-P1-006 journal-less merge appends typed decision, attempt, fact, relation, and idempotency snapshots', () => {
  const graph = createShadowGraph({ now: () => NOW });
  const decision = graph.addDecision({
    id: 'ds-p1-006-merge-decision', project: 'ds-p1-006-merge',
    title: 'Old private decision', chosen: 'preserve', idempotencyKey: 'move-retry'
  });
  const retryTarget = graph.addDecision({
    id: 'ds-p1-006-retry-target', project: 'ds-p1-006-merge',
    title: 'Retry target', chosen: 'canonical'
  });
  const attempt = graph.addAttempt({
    id: 'ds-p1-006-merge-attempt', project: 'ds-p1-006-merge',
    solution: 'old private attempt', result: 'failed'
  });
  const fact = graph.addFact({
    id: 'ds-p1-006-merge-fact', project: 'ds-p1-006-merge', key: 'mode',
    value: 'old-private-fact', idempotencyKey: 'fact-retry'
  });
  const relation = graph.link({
    id: 'ds-p1-006-merge-relation', from: decision.id, to: fact.id,
    relation: 'depends_on'
  });
  const replacementSource = createShadowGraph({ now: () => '2026-09-01T00:00:00.000Z' });
  const replacement = replacementSource.addFact({
    id: 'ds-p1-006-merge-fact-next', project: 'ds-p1-006-merge', key: 'mode',
    value: 'safe-current-fact', validFrom: '2026-09-01T00:00:00.000Z'
  });
  const before = graph.exportData();

  graph.importData({
    schemaVersion: 5,
    records: [
      { ...decision, title: 'Sanitized decision', updatedAt: '2026-09-01T00:00:00.000Z' },
      { ...attempt, solution: 'sanitized attempt', result: 'succeeded' }
    ],
    facts: [
      {
        ...fact,
        value: 'sanitized-terminal-fact',
        status: 'superseded',
        supersededBy: replacement.id,
        temporal: {
          ...fact.temporal,
          validTo: '2026-09-01T00:00:00.000Z',
          invalidatedAt: '2026-09-01T00:00:00.000Z'
        }
      },
      replacement
    ],
    relations: [{
      ...relation,
      temporal: { ...relation.temporal, validTo: '2026-09-02T00:00:00.000Z' }
    }],
    idempotency: [{ key: 'decision:ds-p1-006-merge:move-retry', value: retryTarget }]
  });

  const after = graph.exportData();
  assert.equal(after.journalEpoch, before.journalEpoch, 'merge preserves the original replay epoch');
  assert.deepEqual(after.journal.slice(0, before.journal.length), before.journal, 'old journal entries remain byte-for-byte values');
  const appended = after.journal.slice(before.journal.length);
  assert.deepEqual(appended.map((entry) => entry.type), [
    'decision.recorded', 'attempt.recorded', 'fact.superseded',
    'fact.observed', 'relation.created', 'decision.recorded'
  ]);
  assert.equal(appended.some((entry) => entry.type === 'projection.baseline'), false);
  assert.equal(appended.find((entry) => entry.type === 'fact.superseded').idempotencyKey, 'fact:ds-p1-006-merge:fact-retry');
  assert.equal(appended.at(-1).idempotencyKey, 'decision:ds-p1-006-merge:move-retry');
  assert.deepEqual(appended.map((entry) => entry.seq), [6, 7, 8, 9, 10, 11]);

  const report = graph.rebuild();
  assert.equal(report.rebuildable, true, report.reason);
  const liveById = new Map([...after.records, ...after.facts, ...after.relations].map((item) => [item.id, item]));
  const rebuiltById = new Map([...report.projection.records, ...report.projection.facts, ...report.projection.relations].map((item) => [item.id, item]));
  assert.deepEqual(rebuiltById, liveById);
  assert.deepEqual(report.projection.idempotency, after.idempotency);
  assert.equal(JSON.stringify(report.projection).includes('old private decision'), false);
  assert.equal(JSON.stringify(report.projection).includes('old private attempt'), false);
  assert.equal(JSON.stringify(report.projection).includes('old-private-fact'), false);
});

test('DS-P1-006 journal-less multi-memory overwrite uses recorded, superseded, and invalidated snapshots', () => {
  const graph = createShadowGraph({ now: () => NOW });
  const active = graph.remember({
    id: 'ds-p1-006-memory-active', project: 'ds-p1-006-memory', memoryType: 'profile',
    key: 'active', text: 'old-active-private', idempotencyKey: 'active-retry'
  }).memory;
  const superseded = graph.remember({
    id: 'ds-p1-006-memory-superseded', project: 'ds-p1-006-memory', memoryType: 'note',
    key: 'superseded', text: 'old-superseded-private'
  }).memory;
  const invalidated = graph.remember({
    id: 'ds-p1-006-memory-invalidated', project: 'ds-p1-006-memory', memoryType: 'goal',
    key: 'invalidated', text: 'old-invalidated-private'
  }).memory;
  const before = graph.exportData();

  graph.importData({
    schemaVersion: 5,
    records: [
      { ...active, text: 'sanitized-active', updatedAt: '2026-09-01T00:00:00.000Z' },
      {
        ...superseded, text: 'sanitized-superseded', status: 'superseded',
        supersededBy: 'ds-p1-006-memory-active',
        temporal: { ...superseded.temporal, validTo: '2026-09-01T00:00:00.000Z', invalidatedAt: '2026-09-01T00:00:00.000Z' }
      },
      {
        ...invalidated, text: 'sanitized-invalidated', status: 'invalidated',
        temporal: { ...invalidated.temporal, validTo: '2026-09-01T00:00:00.000Z', invalidatedAt: '2026-09-01T00:00:00.000Z' }
      }
    ]
  });

  const after = graph.exportData();
  const appended = after.journal.slice(before.journal.length);
  assert.deepEqual(appended.map((entry) => entry.type), [
    'memory.recorded', 'memory.superseded', 'memory.invalidated'
  ]);
  assert.equal(appended[0].idempotencyKey, 'memory:ds-p1-006-memory:[null,null,null,"profile","active"]:active-retry');
  assert.equal(after.journalEpoch, before.journalEpoch);
  assert.deepEqual(after.journal.slice(0, before.journal.length), before.journal);

  const report = graph.rebuild();
  assert.equal(report.rebuildable, true, report.reason);
  assert.deepEqual(
    new Map(report.projection.records.map((item) => [item.id, item])),
    new Map(after.records.map((item) => [item.id, item]))
  );
  assert.deepEqual(report.projection.idempotency, after.idempotency);
  assert.equal(/old-(?:active|superseded|invalidated)-private/.test(JSON.stringify(report.projection)), false);
});

test('DS-P1-006 journal-less merge rejects terminal verified fact resurrection atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ds-p1-006-journal-less-resurrection-'));
  const fixture = await verifierFixture(directory);
  for (const terminal of ['expired', 'superseded']) {
    const attack = await signedMidstreamBaselineAttack(directory, fixture, terminal, `journal-less-${terminal}`);
    const graph = createShadowGraph({ verifier: fixture.verifier, now: () => NOW });
    graph.importData(attack.legitimateTerminalPayload);
    const before = graph.exportData();
    const resurrected = attack.payload.facts.find((fact) => fact.id === attack.factId);
    assert.equal(resurrected.status, 'active');
    assert.equal(resurrected.verificationStatus, 'verified');

    assert.throws(
      () => graph.importData({ schemaVersion: 5, facts: [resurrected] }),
      /terminal (?:expired|superseded) fact cannot transition back|fact lifecycle is non-monotonic/i,
      terminal
    );
    assert.deepEqual(graph.exportData(), before, `${terminal}: failed merge leaves every live collection and journal byte-for-byte values`);
  }
});

test('DS-P1-006 journal-less merge preflights sequence overflow and snapshot postconditions before mutation', () => {
  const overflow = createShadowGraph({ now: () => NOW });
  const overflowDecision = overflow.addDecision({
    id: 'ds-p1-006-overflow-decision', project: 'ds-p1-006-overflow',
    title: 'Overflow original', chosen: 'preserve'
  });
  overflow.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER });
  const overflowBefore = overflow.exportData();
  assert.throws(
    () => overflow.importData({
      schemaVersion: 5,
      records: [{ ...overflowDecision, title: 'Must not land' }]
    }),
    /journal sequence overflow/i
  );
  assert.deepEqual(overflow.exportData(), overflowBefore);

  const postcondition = createShadowGraph({ now: () => NOW });
  const decision = postcondition.addDecision({
    id: 'ds-p1-006-postcondition-decision', project: 'ds-p1-006-postcondition',
    title: 'Postcondition original', chosen: 'preserve'
  });
  const fact = postcondition.addFact({
    id: 'ds-p1-006-postcondition-fact', project: 'ds-p1-006-postcondition',
    key: 'expiry', value: 'active'
  });
  const postconditionBefore = postcondition.exportData();
  assert.throws(
    () => postcondition.importData({
      schemaVersion: 4,
      records: [{ ...decision, schemaVersion: 4, title: 'Must also not land' }],
      facts: [{
        ...fact,
        schemaVersion: 4,
        status: 'expired',
        verificationStatus: 'expired',
        expiresAt: null,
        temporal: { ...fact.temporal, validTo: null, invalidatedAt: null }
      }]
    }),
    /fact\.expired postcondition failed|effective expiration/i
  );
  assert.deepEqual(postcondition.exportData(), postconditionBefore);
});

test('DS-P1-006 journal-less overwrite survives JSON and SQLite restart with rebuild parity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-ds-p1-006-journal-less-restart-'));
  const graph = createShadowGraph({ now: () => NOW });
  const memory = graph.remember({
    id: 'ds-p1-006-restart-memory', project: 'ds-p1-006-restart',
    memoryType: 'profile', key: 'secret', text: 'restart-old-private',
    idempotencyKey: 'restart-retry'
  }).memory;
  graph.importData({
    schemaVersion: 5,
    records: [{
      ...memory,
      text: 'restart-sanitized',
      status: 'invalidated',
      temporal: {
        ...memory.temporal,
        validTo: '2026-09-01T00:00:00.000Z',
        invalidatedAt: '2026-09-01T00:00:00.000Z'
      }
    }]
  });
  const merged = graph.exportData();
  assert.deepEqual(merged.journal.map((entry) => entry.type), ['memory.recorded', 'memory.invalidated']);

  for (const backend of ['json', 'sqlite']) {
    const path = join(directory, backend === 'json' ? 'state.json' : 'state.db');
    let store;
    try {
      store = backend === 'json' ? createJsonFileStore(path) : await createSqliteStore(path);
    } catch (error) {
      if (/requires Node/.test(error.message)) {
        assert.fail(`SQLite restart coverage unavailable: ${error.message}`);
      }
      throw error;
    }
    await store.save(merged);
    store.close();

    store = backend === 'json' ? createJsonFileStore(path) : await createSqliteStore(path);
    const durable = await store.load();
    store.close();
    assert.deepEqual(durable.journal, merged.journal, `${backend}: exact prebuilt journal entries persist`);

    const restarted = createShadowGraph({ now: () => NOW });
    restarted.importData(durable);
    const report = restarted.rebuild();
    const exported = restarted.exportData();
    assert.equal(report.rebuildable, true, `${backend}: ${report.reason}`);
    assert.deepEqual(report.projection.records, exported.records, `${backend}: records rebuild exactly`);
    assert.deepEqual(report.projection.idempotency, exported.idempotency, `${backend}: idempotency rebuilds exactly`);
    assert.equal(JSON.stringify(exported.records).includes('restart-old-private'), false, `${backend}: old private text stays out of live state`);
    assert.equal(JSON.stringify(report.projection).includes('restart-old-private'), false, `${backend}: old private text stays out of rebuild`);
  }
});

test('DS-P1-006 eighth review: hard-purge leading gaps and sequence ledgers remain valid without a baseline', () => {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({ id: 'ds-p1-006-hard-gone', project: 'gone', title: 'Gone', chosen: 'erase' });
  graph.addDecision({ id: 'ds-p1-006-hard-kept', project: 'kept', title: 'Kept', chosen: 'preserve' });
  graph.purgeProject('gone', { mode: 'hard' });
  const payload = graph.exportData();
  assert.equal(payload.journal.some((entry) => entry.type === 'projection.baseline'), false);
  assert.ok(payload.journal[0].seq > payload.journalEpoch, 'hard purge leaves an explicit leading gap');
  assert.deepEqual(payload.journal.find((entry) => entry.type === 'project.purged').payload.removedJournalSequences, [1]);
  assert.doesNotThrow(() => validateRestorePayload(payload, { now: () => NOW }));
  const restarted = createShadowGraph({ now: () => NOW });
  assert.doesNotThrow(() => restarted.importData(payload));
  assert.deepEqual(restarted.exportData().records.map((record) => record.id), ['ds-p1-006-hard-kept']);
});

test('DS-P1-006 eighth review: JSON and SQLite restore reject both terminal resurrection snapshots atomically', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-eighth-review-restore-'));
  const fixture = await verifierFixture(directory);

  for (const terminal of ['expired', 'superseded']) {
    const { payload } = await signedMidstreamBaselineAttack(directory, fixture, terminal, `restore-${terminal}`);
    const sourceJson = join(directory, `${terminal}-source.json`);
    const destinationJson = join(directory, `${terminal}-live.json`);
    await writePayload(sourceJson, payload);
    const jsonStore = createJsonFileStore(destinationJson);
    await jsonStore.save(oldPayload(`json-${terminal}`));
    jsonStore.close();
    const jsonBefore = await readFile(destinationJson);
    await assert.rejects(restoreFile(sourceJson, destinationJson), (error) => {
      assert.equal(error.code, INVALID_BASELINE_PLACEMENT_CODE);
      return true;
    });
    assert.deepEqual(await readFile(destinationJson), jsonBefore, `${terminal}: JSON destination bytes unchanged`);

    const sourceSqlite = join(directory, `${terminal}-source.db`);
    const destinationSqlite = join(directory, `${terminal}-live.db`);
    let sourceStore;
    let destinationStore;
    try {
      sourceStore = await createSqliteStore(sourceSqlite);
      destinationStore = await createSqliteStore(destinationSqlite);
    } catch (error) {
      if (/requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }
    await sourceStore.save(payload);
    await destinationStore.save(oldPayload(`sqlite-${terminal}`));
    sourceStore.close();
    const sqliteBefore = await destinationStore.load();
    await assert.rejects(destinationStore.restore(sourceSqlite), (error) => {
      assert.equal(error.code, INVALID_BASELINE_PLACEMENT_CODE);
      return true;
    });
    assert.deepEqual(await destinationStore.load(), sqliteBefore, `${terminal}: SQLite destination unchanged`);
    destinationStore.close();
  }
});

test('DS-P1-006 eighth review: CLI, HTTP, and MCP restore reject the same baseline code and preserve destinations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-eighth-review-interfaces-'));
  const fixture = await verifierFixture(directory);
  const { payload } = await signedMidstreamBaselineAttack(directory, fixture, 'expired', 'interfaces');
  const source = join(directory, 'attack.json');
  await writePayload(source, payload);

  const cliDestination = join(directory, 'cli.json');
  await writePayload(cliDestination, oldPayload('cli'));
  const cliBefore = await readFile(cliDestination);
  const cli = await runCli(cliDestination, source);
  assert.equal(cli.code, 1);
  assert.match(cli.stderr, new RegExp(INVALID_BASELINE_PLACEMENT_CODE));
  assert.deepEqual(await readFile(cliDestination), cliBefore);

  const httpDestination = join(directory, 'http.json');
  await writePayload(httpDestination, oldPayload('http'));
  const httpBefore = await readFile(httpDestination);
  const app = await createShadowGraphServer({ file: httpDestination, verifier: fixture.verifier, now: () => NOW });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source })
    });
    const failure = await response.json();
    assert.equal(response.status, 400);
    assert.equal(failure.code, INVALID_BASELINE_PLACEMENT_CODE);
    assert.deepEqual(await readFile(httpDestination), httpBefore);
    const records = await (await fetch(`http://127.0.0.1:${app.server.address().port}/records`)).json();
    assert.deepEqual(records.records.map((record) => record.id), ['ds-p1-006-old-http']);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }

  const mcpDestination = join(directory, 'mcp.json');
  await writePayload(mcpDestination, oldPayload('mcp'));
  const mcpBefore = await readFile(mcpDestination);
  const rpc = startMcp(mcpDestination, fixture.configPath);
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const response = await rpc.call({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'shadowgraph_restore', arguments: { source } }
  });
  assert.ok(response.error);
  assert.equal(response.error.data?.issueCode ?? response.error.data?.code, INVALID_BASELINE_PLACEMENT_CODE);
  assert.match(response.error.message, /projection baseline placement/i);
  assert.deepEqual(await readFile(mcpDestination), mcpBefore);
  const search = await rpc.call({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'shadowgraph_search', arguments: { project: 'old', query: 'OLD mcp' } }
  });
  assert.equal(search.error, undefined, search.error?.message);
  assert.equal(JSON.parse(search.result.content[0].text).page.total, 1);
});
