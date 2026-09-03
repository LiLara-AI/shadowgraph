// Behavioural evidence for the four tool annotations.
//
// Annotations are a public claim about what a tool does to its environment, and
// a hand-maintained table drifts from the handlers it describes. So this file
// drives the real stdio server, calls every advertised tool twice with identical
// arguments, records what actually changed — the durable revision, the journal,
// stored entities, timestamps, and files outside the store — and DERIVES the
// four hints from those observations. The catalog then has to match.
//
// The clock is injected from a file so a repeat call can be made to happen at a
// different instant and a refreshed timestamp is visible rather than inferred.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFactAttestation } from '../src/verification.js';

const STRUCTURED_PROTOCOL = '2025-11-25';
const PROJECT = 'effects';
const T0 = '2030-01-01T00:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

async function startMcp(t, extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-effects-'));
  const storeDirectory = join(directory, 'store');
  await mkdir(storeDirectory, { recursive: true });
  const file = join(storeDirectory, 'data.json');
  const clockFile = join(directory, 'clock.txt');
  await writeFile(clockFile, T0, 'utf8');
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SHADOWGRAPH_FILE: file,
      SHADOWGRAPH_STORAGE: 'json',
      // Emptied rather than inherited: a developer's own embedding endpoint
      // would change openWorldHint for two tools and make the run unreproducible.
      SHADOWGRAPH_EMBEDDING_URL: '',
      SHADOWGRAPH_MCP_COMPACT: '0',
      NODE_ENV: 'test',
      SHADOWGRAPH_TEST_CLOCK_FILE: clockFile,
      ...extraEnv
    },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  let buffer = '';
  const pending = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) pending.shift()?.resolve(JSON.parse(line));
    }
  });
  child.on('error', (error) => pending.shift()?.reject(error));

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await rm(directory, { recursive: true, force: true });
  }
  t.after(stop);

  let nextId = 1;
  const rpc = {
    directory,
    storeDirectory,
    file,
    call(method, params, timeoutMs = 20_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
        pending.push({
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); }
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    async initialize() {
      const response = await rpc.call('initialize', {
        protocolVersion: STRUCTURED_PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'shadowgraph-effects', version: '1.0.0' }
      });
      assert.equal(response.result.protocolVersion, STRUCTURED_PROTOCOL, 'annotations are only advertised from 2025-03-26 onward');
      return response.result.protocolVersion;
    },
    async listTools() {
      const response = await rpc.call('tools/list', {});
      assert.equal(response.error, undefined, `tools/list failed: ${JSON.stringify(response.error)}`);
      return response.result.tools;
    },
    // A successful call, with the tool's own JSON result already parsed.
    async ok(name, args = {}) {
      const response = await rpc.call('tools/call', { name, arguments: args });
      assert.equal(response.error, undefined, `${name} failed: ${JSON.stringify(response.error)}`);
      return JSON.parse(response.result.content[0].text);
    },
    async fails(name, args = {}) {
      const response = await rpc.call('tools/call', { name, arguments: args });
      assert.equal(response.result, undefined, `${name} unexpectedly succeeded`);
      return response.error;
    },
    setClock(iso) { return writeFile(clockFile, iso, 'utf8'); }
  };
  return rpc;
}

async function readStore(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Nothing has been persisted yet: revision 0 with no entities.
    return { revision: 0, records: [], facts: [], relations: [], reviewSignals: [] };
  }
}

// Every file under a root, as paths relative to it, so a write anywhere in the
// server's reach is visible rather than taken on trust.
async function listFiles(root) {
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path).split(sep).join('/'));
    }
  };
  await walk(root);
  return found.sort();
}

// Everything observable about the server's environment at one instant: the
// durable revision, the journal high-water mark, the stored entities by id, and
// every file in the temporary tree the server can reach, not only the store.
async function snapshot(rpc) {
  const durable = await readStore(rpc.file);
  const journal = await rpc.ok('shadowgraph_journal', { limit: 1 });
  const entities = new Map();
  for (const entity of [...durable.records ?? [], ...durable.facts ?? [], ...durable.relations ?? [], ...durable.reviewSignals ?? []]) {
    entities.set(entity.id, JSON.stringify(entity));
  }
  return {
    revision: durable.revision ?? 0,
    journalSeq: journal.completeness.journalSeq,
    serialized: JSON.stringify(durable),
    files: await listFiles(rpc.directory),
    entities,
    durable
  };
}

function effects(before, after) {
  const removed = [...before.entities.keys()].filter((id) => !after.entities.has(id));
  const changedExisting = [...before.entities]
    .filter(([id, serialized]) => after.entities.has(id) && after.entities.get(id) !== serialized)
    .map(([id]) => id);
  return {
    revisionDelta: after.revision - before.revision,
    journalDelta: after.journalSeq - before.journalSeq,
    storeChanged: before.serialized !== after.serialized,
    newFiles: after.files.filter((name) => !before.files.includes(name)),
    // A new file outside the store directory is a write into the open world,
    // observed rather than declared by the scenario.
    newFilesOutsideStore: after.files.filter((name) => !before.files.includes(name) && !name.startsWith('store/')),
    removed,
    changedExisting,
    // An entity that already existed was rewritten with nothing appended to the
    // journal, so the previous value cannot be reconstructed from the audit
    // trail. That is an overwrite, not an addition.
    unjournalledOverwrite: changedExisting.length > 0 && after.journalSeq === before.journalSeq
  };
}

// The whole point of this file: the four hints, computed from what happened.
function deriveAnnotations({ first, repeat, external }) {
  return {
    // Nothing durable moved and no file was written.
    readOnlyHint: first.revisionDelta === 0 && !first.storeChanged && first.newFiles.length === 0 && !external.write,
    // State was removed, rewritten without an audit trail, or a file outside the
    // store was replaced.
    destructiveHint: first.removed.length > 0 || first.unjournalledOverwrite || external.overwrite,
    // "Calling the tool repeatedly with the same arguments has no additional
    // effect on its environment": the durable revision is part of that
    // environment, since it is the concurrency token other writers compare.
    idempotentHint: repeat.revisionDelta === 0 && !repeat.storeChanged && !external.overwrite,
    // A path outside the store, chosen by the caller, was written — observed from
    // the files that appeared — or read, which a scenario has to state because a
    // read leaves no trace, and which it proves by the result of the call.
    openWorldHint: first.newFilesOutsideStore.length > 0 || external.read
  };
}

// Reads and overwrites of a pre-existing external file cannot be seen by diffing
// the tree, so a scenario states them — and every scenario that does also proves
// them from the call's own result. Writes are not here: they are observed.
const NO_EXTERNAL = { read: false, overwrite: false };

function observer(rpc, observed) {
  // Calls one tool twice with identical arguments and records what each call did.
  return async function observe(name, args = {}, { between } = {}) {
    const before = await snapshot(rpc);
    const firstResult = await rpc.ok(name, args);
    const middle = await snapshot(rpc);
    if (between) await between();
    const repeatResult = await rpc.ok(name, args);
    const after = await snapshot(rpc);
    const record = {
      name,
      first: effects(before, middle),
      repeat: effects(middle, after),
      firstResult,
      repeatResult,
      external: { ...NO_EXTERNAL }
    };
    observed.set(name, record);
    return record;
  };
}

test('every advertised tool annotation matches the effects the server actually has', async (t) => {
  const rpc = await startMcp(t);
  await rpc.initialize();
  const observed = new Map();
  const observe = observer(rpc, observed);

  // --- writes that mint new entities -------------------------------------
  const decision = await observe('shadowgraph_record_decision', {
    id: 'effects-decision', project: PROJECT, title: 'Choose a store', chosen: 'sqlite',
    idempotencyKey: 'effects-decision-key',
    alternatives: [{ label: 'postgres', reasonRejected: 'operational cost', reopenWhen: [{ key: 'deployment', operator: 'equals', value: 'multi-user' }] }]
  });
  assert.equal(decision.first.journalDelta, 1, 'recording a decision appends one journal entry');
  assert.equal(decision.firstResult.id, decision.repeatResult.id, 'the retry key must return the first decision');
  assert.equal(decision.repeat.journalDelta, 0, 'a keyed retry writes no second decision');
  assert.equal(decision.repeat.revisionDelta, 1, 'yet the retry still commits a durable revision');

  await observe('shadowgraph_record_attempt', {
    project: PROJECT, solution: 'tried the in-memory store', result: 'failed under restart',
    idempotencyKey: 'effects-attempt-key'
  });

  const fact = await observe('shadowgraph_record_fact', { project: PROJECT, key: 'deployment', value: 'multi-user', sourceClass: 'tool_observed' });
  assert.notEqual(fact.firstResult.id, fact.repeatResult.id, 'a repeated observation supersedes rather than overwriting');

  // A fact that maintenance can expire later, under the injected clock.
  await rpc.ok('shadowgraph_record_fact', { project: PROJECT, key: 'expiring', value: 'soon', expiresAt: at(60) });

  // --- reopen evaluation, which persists signals --------------------------
  const review = await observe('shadowgraph_review', { project: PROJECT });
  assert.equal(review.firstResult.length, 1, 'the changed fact must make the decision due');
  assert.equal(review.first.journalDelta, 0, 'review signals are persisted but not journalled');
  assert.equal(review.repeat.changedExisting.length, 0, 'signals dedupe by decision and reason');
  assert.equal(review.repeat.revisionDelta, 1, 'a repeat that changes no signal still commits a revision');

  await observe('shadowgraph_context', { project: PROJECT });
  await observe('shadowgraph_remember', {
    project: PROJECT, memoryType: 'preference', key: 'store-style', text: 'prefers embedded databases',
    scope: { userId: 'alice' }
  });
  assert.equal(observed.get('shadowgraph_remember').repeatResult.operation, 'NOOP', 'identical content must reconcile to a NOOP');

  // --- pure reads ---------------------------------------------------------
  for (const [name, args] of [
    ['shadowgraph_search', { project: PROJECT, query: 'store' }],
    ['shadowgraph_retrieve', { project: PROJECT, query: 'store' }],
    ['shadowgraph_recall', { project: PROJECT, query: 'store' }],
    ['shadowgraph_traverse', { id: 'effects-decision' }],
    ['shadowgraph_validate', {}],
    ['shadowgraph_journal', { limit: 5 }],
    ['shadowgraph_rebuild', {}],
    ['shadowgraph_review_signals', { project: PROJECT }],
    ['shadowgraph_purge_preview', { project: PROJECT }],
    ['shadowgraph_repair_plan', {}],
    ['shadowgraph_redact', { project: PROJECT }]
  ]) {
    const read = await observe(name, args);
    assert.equal(read.first.revisionDelta, 0, `${name} must not commit a revision`);
    assert.equal(read.first.storeChanged, false, `${name} must leave the store byte-identical`);
  }
  // The durable revision is visible on the wire through exactly one tool, which
  // is what makes "a repeat still commits a revision" a client-observable claim.
  const redacted = observed.get('shadowgraph_redact').firstResult;
  const durableNow = await readStore(rpc.file);
  assert.equal(redacted.revision, durableNow.revision, 'redact reports the durable revision');

  // --- lifecycle writes ---------------------------------------------------
  const status = await observe('shadowgraph_update_status', { decisionId: 'effects-decision', status: 'planned' });
  assert.equal(status.first.journalDelta, 1);
  assert.equal(status.repeat.journalDelta, 0, 'setting the state a decision already has writes nothing');
  assert.equal(status.repeat.revisionDelta, 1, 'yet it still commits a durable revision');

  const outcome = await observe(
    'shadowgraph_record_outcome',
    { decisionId: 'effects-decision', outcome: { status: 'successful', sourceClass: 'tool_observed' } },
    { between: () => rpc.setClock(at(1)) }
  );
  assert.notEqual(outcome.firstResult.outcome.observedAt, outcome.repeatResult.outcome.observedAt, 're-recording an outcome restamps it');

  const evidence = await observe(
    'shadowgraph_confidence_evidence',
    { decisionId: 'effects-decision', reason: 'benchmark held', key: 'effects-evidence', supports: true },
    { between: () => rpc.setClock(at(2)) }
  );
  assert.equal(evidence.repeat.journalDelta, 0, 'a duplicate evidence key contributes nothing');
  assert.deepEqual(evidence.repeat.changedExisting, ['effects-decision'], 'but the decision is still rewritten');
  assert.notEqual(evidence.firstResult.updatedAt, evidence.repeatResult.updatedAt, 'because updatedAt is restamped');

  await rpc.ok('shadowgraph_record_decision', { id: 'effects-replacement', project: PROJECT, title: 'Replacement', chosen: 'duckdb' });
  const link = await observe('shadowgraph_link', { from: 'effects-decision', to: 'effects-replacement', relation: 'informs' });
  assert.notEqual(link.firstResult.id, link.repeatResult.id, 'every link mints a new relation id');

  // --- acknowledging a review signal: an unjournalled in-place overwrite ---
  const [signal] = await rpc.ok('shadowgraph_review_signals', { project: PROJECT, status: 'open' });
  assert.ok(signal, 'a review signal must exist to acknowledge');
  const acknowledged = await observe('shadowgraph_ack_review', { id: signal.id }, { between: () => rpc.setClock(at(3)) });
  assert.deepEqual(acknowledged.first.changedExisting, [signal.id], 'the stored signal is rewritten in place');
  assert.equal(acknowledged.first.journalDelta, 0, 'and nothing is appended to the journal');
  assert.equal(acknowledged.firstResult.status, 'acknowledged');
  assert.notEqual(acknowledged.firstResult.acknowledgedAt, acknowledged.repeatResult.acknowledgedAt, 'a repeat restamps acknowledgedAt');
  assert.equal(acknowledged.repeat.journalDelta, 0, 'still without a journal entry');

  const superseded = await observe('shadowgraph_supersede', { decisionId: 'effects-decision', replacementId: 'effects-replacement' });
  assert.ok(superseded.first.journalDelta >= 1, 'supersession is journalled');
  assert.equal(superseded.repeat.journalDelta, 0, 'repeating it writes nothing');
  assert.equal(superseded.repeat.revisionDelta, 1, 'yet it still commits a durable revision');

  // --- clock-driven maintenance -------------------------------------------
  await rpc.setClock(at(180));
  const maintained = await observe('shadowgraph_maintain', { });
  assert.ok(maintained.first.journalDelta >= 1, 'the expiring fact must be expired');
  assert.equal(maintained.repeat.journalDelta, 0, 'a second run at the same instant finds nothing to do');

  // --- filesystem: backup, then restore -----------------------------------
  const destination = join(rpc.directory, 'external', 'snapshot.json');
  const backup = await observe('shadowgraph_backup', { destination });
  const afterFirstBackup = observed.get('shadowgraph_backup').firstResult;
  assert.equal(afterFirstBackup.destination, destination);
  // Proven, not assumed: the second call replaced the file it had just written.
  const backupBytes = [];
  backupBytes.push(await readFile(destination, 'utf8'));
  await rpc.ok('shadowgraph_backup', { destination });
  backupBytes.push(await readFile(destination, 'utf8'));
  assert.notEqual(backupBytes[0], backupBytes[1], 'a repeated backup overwrites the destination with new content');
  assert.deepEqual(backup.first.newFilesOutsideStore, ['external/snapshot.json'], 'the snapshot is written outside the store');
  backup.external = { read: false, overwrite: true };

  // Something for the restore to discard, so removal is observable.
  await rpc.ok('shadowgraph_record_decision', { id: 'effects-after-backup', project: PROJECT, title: 'Recorded after the snapshot', chosen: 'temporary' });
  const restored = await observe('shadowgraph_restore', { source: destination });
  assert.ok(restored.first.removed.includes('effects-after-backup'), 'restoring discards everything recorded after the snapshot');
  assert.ok(restored.first.revisionDelta > 0, 'a restore installs a strictly greater revision');
  assert.ok(restored.repeat.revisionDelta > 0, 'and does so again on a repeat');
  // Restoring rewrites the store through the storage backend rather than a
  // caller-named external file; what makes it open-world is the source it read,
  // proven by the store now matching that file's contents.
  assert.deepEqual(restored.first.newFilesOutsideStore, [], 'a restore writes no file outside the store');
  restored.external = { read: true, overwrite: false };

  // --- removal ------------------------------------------------------------
  const purged = await observe('shadowgraph_purge', { project: PROJECT, mode: 'logical' });
  assert.ok(purged.first.removed.length > 0, 'a purge removes stored entities');
  assert.equal(purged.repeat.journalDelta, 1, 'a second purge still records that it happened');

  // --- the assertion this file exists for ---------------------------------
  const tools = await rpc.listTools();
  assert.equal(tools.length, 27);
  const missing = tools.map((tool) => tool.name).filter((name) => !observed.has(name));
  assert.deepEqual(missing, [], `these advertised tools were never observed: ${missing.join(', ')}`);

  const mismatches = [];
  for (const tool of tools) {
    const derived = deriveAnnotations(observed.get(tool.name));
    try {
      assert.deepEqual(tool.annotations, derived);
    } catch {
      mismatches.push(`${tool.name}: advertised ${JSON.stringify(tool.annotations)} but observed ${JSON.stringify(derived)}`);
    }
  }
  assert.deepEqual(mismatches, [], `annotations must equal the observed behaviour:\n  ${mismatches.join('\n  ')}`);

  // Cross-check from the wire alone: which tools commit a durable revision.
  const committing = [...observed].filter(([, record]) => record.first.revisionDelta > 0).map(([name]) => name).sort();
  assert.deepEqual(committing, [
    'shadowgraph_ack_review',
    'shadowgraph_backup',
    'shadowgraph_confidence_evidence',
    'shadowgraph_context',
    'shadowgraph_link',
    'shadowgraph_maintain',
    'shadowgraph_purge',
    'shadowgraph_record_attempt',
    'shadowgraph_record_decision',
    'shadowgraph_record_fact',
    'shadowgraph_record_outcome',
    'shadowgraph_remember',
    'shadowgraph_restore',
    'shadowgraph_review',
    'shadowgraph_supersede',
    'shadowgraph_update_status'
  ]);
  const readOnly = [...observed].filter(([, record]) => record.first.revisionDelta === 0).map(([name]) => name).sort();
  assert.deepEqual(readOnly, [
    'shadowgraph_journal',
    'shadowgraph_purge_preview',
    'shadowgraph_rebuild',
    'shadowgraph_recall',
    'shadowgraph_redact',
    'shadowgraph_repair_plan',
    'shadowgraph_retrieve',
    'shadowgraph_review_signals',
    'shadowgraph_search',
    'shadowgraph_traverse',
    'shadowgraph_validate'
  ], 'exactly these eleven tools commit nothing');
  // No tool may write outside the store unless it is one of the three that say so.
  const wroteOutside = [...observed].filter(([, record]) => record.first.newFilesOutsideStore.length > 0).map(([name]) => name).sort();
  assert.deepEqual(wroteOutside, ['shadowgraph_backup'], 'only backup writes a file of its own outside the store');
});

test('the verification tool reads a caller-selected path, inside the configured root only', async (t) => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'shadowgraph-effects-verifier-'));
  t.after(() => rm(configDirectory, { recursive: true, force: true }));
  const evidenceRoot = join(configDirectory, 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const keys = generateKeyPairSync('ed25519');
  const configPath = join(configDirectory, 'verifier.json');
  await writeFile(configPath, JSON.stringify({
    allowedEvidenceRoot: evidenceRoot,
    trustedVerifiers: { approver: keys.publicKey.export({ type: 'spki', format: 'pem' }) }
  }), 'utf8');

  const rpc = await startMcp(t, { SHADOWGRAPH_VERIFIER_CONFIG: configPath });
  await rpc.initialize();
  const observed = new Map();
  const observe = observer(rpc, observed);

  const fact = await rpc.ok('shadowgraph_record_fact', { project: PROJECT, key: 'release', value: 'ready' });
  const attestation = JSON.stringify(createFactAttestation({
    fact,
    verifierIdentity: 'approver',
    evidenceReference: 'ticket:MCP-1',
    verifiedAt: at(5),
    privateKey: keys.privateKey
  }));
  const insidePath = join(evidenceRoot, 'signed.json');
  const outsidePath = join(configDirectory, 'outside.json');
  await writeFile(insidePath, attestation, 'utf8');
  await writeFile(outsidePath, attestation, 'utf8');

  // The same bytes outside the configured root are refused, and nothing moves.
  const before = await snapshot(rpc);
  const refused = await rpc.fails('shadowgraph_verify_fact', { factId: fact.id, evidencePath: outsidePath });
  assert.equal(refused.code, -32000);
  const afterRefusal = await snapshot(rpc);
  assert.equal(afterRefusal.revision, before.revision, 'a refused verification commits nothing');
  assert.equal(afterRefusal.journalSeq, before.journalSeq);

  const verified = await observe('shadowgraph_verify_fact', { factId: fact.id, evidencePath: insidePath });
  assert.equal(verified.firstResult.operation, 'VERIFIED');
  assert.equal(verified.firstResult.fact.verificationStatus, 'verified');
  assert.equal(verified.repeatResult.operation, 'NOOP', 'the same attestation again changes nothing in the domain');
  assert.equal(verified.repeat.journalDelta, 0);
  assert.equal(verified.repeat.revisionDelta, 1, 'yet it still commits a durable revision');
  // Reading a caller-selected path from the server filesystem is the open world.
  assert.deepEqual(verified.first.newFilesOutsideStore, [], 'verification writes no file');
  verified.external = { read: true, overwrite: false };

  const tools = await rpc.listTools();
  assert.equal(tools.length, 28);
  const verifyTool = tools.find((tool) => tool.name === 'shadowgraph_verify_fact');
  assert.deepEqual(verifyTool.annotations, deriveAnnotations(verified), 'verify_fact annotations must equal the observed behaviour');
});
