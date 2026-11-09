import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';

function snapshot(label) {
  const graph = createShadowGraph({ now: () => '2026-09-26T00:00:00.000Z' });
  for (const project of ['alpha', 'beta']) graph.addDecision({ project, title: `${label}-${project}`, chosen: label });
  return { ...privilegedSnapshot(graph), futureCollection: { retained: label } };
}

async function pair(t, backend, factory = {}) {
  const directory = await scratchDirectory(t, 'pr12-validator-');
  const source = join(directory, `source.${backend === 'sqlite' ? 'db' : 'json'}`);
  const backup = join(directory, `backup.${backend === 'sqlite' ? 'db' : 'json'}`);
  const destination = join(directory, `destination.${backend === 'sqlite' ? 'db' : 'json'}`);
  const payload = snapshot('BACKUP');
  validateRestorePayload(payload);
  if (backend === 'sqlite') {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import('node:sqlite')); }
    catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return null; }
    const original = await createSqliteStore(source);
    await original.save(payload); await original.backup(backup); original.close();
    const target = await createSqliteStore(destination, factory);
    t.after(() => target.close());
    await target.save(snapshot('DESTINATION'));
    return { backup, destination, load: () => target.load(), restore: options => target.restore(backup, options), corrupt() {
      const db = new DatabaseSync(backup);
      try {
        const row = db.prepare('SELECT id,payload FROM shadowgraph_entities ORDER BY rowid LIMIT 1').get();
        const record = JSON.parse(row.payload); record.title = 'LIVE-ONLY-TAMPER';
        db.prepare('UPDATE shadowgraph_entities SET payload=? WHERE id=?').run(JSON.stringify(record), row.id);
      } finally { db.close(); }
    } };
  }
  await writeFile(source, JSON.stringify(payload)); await backupFile(source, backup);
  await writeFile(destination, JSON.stringify(snapshot('DESTINATION')));
  return { backup, destination, load: async () => JSON.parse(await readFile(destination)), restore: options => restoreFile(backup, destination, options), async corrupt() {
    const damaged = JSON.parse(await readFile(backup)); damaged.records[0].title = 'LIVE-ONLY-TAMPER'; await writeFile(backup, JSON.stringify(damaged));
  } };
}

test('F39: a permissive SQLite factory validator cannot disable mandatory full-backup journal parity', async t => {
  const fixture = await pair(t, 'sqlite', { restoreValidator: payload => payload }); if (!fixture) return;
  await fixture.corrupt();
  const before = await fixture.load(); const backup = await readFile(fixture.backup);
  await assert.rejects(fixture.restore({ validate: payload => payload }), /journal projection does not match live records/);
  assert.deepEqual(await fixture.load(), before);
  assert.deepEqual(await readFile(fixture.backup), backup);
});

for (const backend of ['json', 'sqlite']) {
  test(`${backend}: additional validator mutation cannot change installed or activated memory`, async t => {
    const fixture = await pair(t, backend); if (!fixture) return;
    let activated; const sourceBytes = await readFile(fixture.backup);
    await fixture.restore({ validate(payload) {
      payload.records[0].title = 'CALLBACK-TAMPER';
      payload.access = { lineageId: 'forged', entries: [{ accessId: 'forged', type: 'grant', state: 'active' }] };
      return payload;
    }, afterReplace(payload) { activated = structuredClone(payload); } });
    const installed = await fixture.load();
    assert.equal(installed.records[0].title, 'BACKUP-alpha');
    assert.equal(Object.hasOwn(installed, 'access'), false);
    assert.deepEqual(activated, installed);
    assert.deepEqual(await readFile(fixture.backup), sourceBytes);
    assert.doesNotThrow(() => validateRestorePayload(installed));
  });
  test(`${backend}: rejecting additional validator leaves the complete destination unchanged`, async t => {
    const fixture = await pair(t, backend); if (!fixture) return;
    const before = await fixture.load();
    await assert.rejects(fixture.restore({ validate() { throw new Error('additional policy refused'); } }), /additional policy refused/);
    assert.deepEqual(await fixture.load(), before);
  });
  test(`${backend}: permissive additional validator cannot admit a corrupt actual backup`, async t => {
    const fixture = await pair(t, backend); if (!fixture) return;
    await fixture.corrupt(); const before = await fixture.load();
    await assert.rejects(fixture.restore({ validate: payload => payload }), /journal projection does not match live records/);
    assert.deepEqual(await fixture.load(), before);
  });
  test(`${backend}: asynchronously rejected additional validation preserves destination and skips activation`, async t => {
    const fixture = await pair(t, backend); if (!fixture) return;
    const before = await fixture.load(); const sourceBytes = await readFile(fixture.backup); let activated = false;
    await assert.rejects(fixture.restore({ async validate(payload) { payload.records.length = 0; throw new Error('async policy refused'); }, afterReplace() { activated = true; } }), /async policy refused/);
    assert.equal(activated, false); assert.deepEqual(await fixture.load(), before); assert.deepEqual(await readFile(fixture.backup), sourceBytes);
  });
  test(`${backend}: additional validator return value cannot substitute a different valid full store`, async t => {
    const fixture = await pair(t, backend); if (!fixture) return;
    const alternate = snapshot('SUBSTITUTED'); validateRestorePayload(alternate);
    await fixture.restore({ validate: () => alternate });
    assert.equal((await fixture.load()).records[0].title, 'BACKUP-alpha');
  });
}

test('F39: SQLite factory and operation validators receive independent copies at every validation phase', async t => {
  let factoryCalls = 0, operationCalls = 0, activated;
  const fixture = await pair(t, 'sqlite', { restoreValidator(payload) { factoryCalls += 1; payload.records[0].title = 'FACTORY-TAMPER'; payload.futureCollection.retained = 'FACTORY-TAMPER'; return snapshot('FACTORY-REPLACEMENT'); } }); if (!fixture) return;
  await fixture.restore({ validate(payload) { operationCalls += 1; assert.equal(payload.records[0].title, 'BACKUP-alpha'); assert.equal(payload.futureCollection.retained, 'BACKUP'); payload.records[0].title = 'OPERATION-TAMPER'; }, afterReplace(payload) { activated = structuredClone(payload); } });
  assert.equal(factoryCalls, 3); assert.equal(operationCalls, 3); assert.deepEqual(activated, await fixture.load()); assert.equal(activated.records[0].title, 'BACKUP-alpha');
});

test('F39: SQLite factory refusal on installed replacement verifies rollback before reporting failure', async t => {
  let calls = 0, activated = false;
  const fixture = await pair(t, 'sqlite', { restoreValidator() { calls += 1; if (calls === 3) throw new Error('replacement policy refused'); } }); if (!fixture) return;
  const before = await fixture.load(), sourceBytes = await readFile(fixture.backup);
  await assert.rejects(fixture.restore({ afterReplace() { activated = true; } }), error => error.code === 'sqlite_restore_rolled_back' && /replacement policy refused/.test(error.message));
  assert.equal(calls, 3); assert.equal(activated, false); assert.deepEqual(await fixture.load(), before); assert.deepEqual(await readFile(fixture.backup), sourceBytes);
});
