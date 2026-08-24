// Relational SQLite backend for ShadowGraph v0.30. Requires Node 22.5+ node:sqlite.
import { mkdir, unlink, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nextRevision, assertRevision } from './revision-store.js';

const EMPTY = { schemaVersion: 2, revision: 0, records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [] };

export async function createSqliteStore(filePath) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { throw new Error('SQLite storage requires Node 22.5+ with node:sqlite; use JSON storage on Node 20'); }
  let db = new DatabaseSync(filePath);
  db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS shadowgraph_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shadowgraph_entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, project TEXT, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shadowgraph_relations (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, created_at TEXT, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shadowgraph_reviews (id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shadowgraph_idempotency (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shadowgraph_events (id TEXT PRIMARY KEY, project TEXT, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shadowgraph_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);`);

  function exportFrom(database) {
    const readMeta = (key, fallback = '0') => database.prepare('SELECT value FROM shadowgraph_meta WHERE key = ?').get(key)?.value ?? fallback;
    const result = { schemaVersion: Number(readMeta('schemaVersion', '2')), revision: Number(readMeta('revision', '0')), records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [] };
    for (const row of database.prepare('SELECT kind, payload FROM shadowgraph_entities ORDER BY rowid').all()) { const item = JSON.parse(row.payload); (item.kind === 'fact' ? result.facts : result.records).push(item); }
    for (const row of database.prepare('SELECT payload FROM shadowgraph_relations ORDER BY rowid').all()) result.relations.push(JSON.parse(row.payload));
    for (const row of database.prepare('SELECT payload FROM shadowgraph_reviews ORDER BY rowid').all()) result.reviewSignals.push(JSON.parse(row.payload));
    for (const row of database.prepare('SELECT key, payload FROM shadowgraph_idempotency ORDER BY rowid').all()) result.idempotency.push({ key: row.key, value: JSON.parse(row.payload) });
    for (const row of database.prepare('SELECT payload FROM shadowgraph_events ORDER BY rowid').all()) result.events.push(JSON.parse(row.payload));
    return result;
  }
  function replaceRelational(data) {
    db.exec('DELETE FROM shadowgraph_entities; DELETE FROM shadowgraph_relations; DELETE FROM shadowgraph_reviews; DELETE FROM shadowgraph_idempotency; DELETE FROM shadowgraph_events; DELETE FROM shadowgraph_meta;');
    db.prepare('INSERT INTO shadowgraph_meta (key,value) VALUES (?,?)').run('schemaVersion', String(data.schemaVersion ?? 2));
    db.prepare('INSERT INTO shadowgraph_meta (key,value) VALUES (?,?)').run('revision', String(data.revision ?? 0));
    const entity = db.prepare('INSERT INTO shadowgraph_entities (id,kind,project,payload) VALUES (?,?,?,?)');
    for (const item of [...(data.records ?? []), ...(data.facts ?? [])]) entity.run(item.id, item.kind, item.project ?? 'default', JSON.stringify(item));
    const relation = db.prepare('INSERT INTO shadowgraph_relations (id,source_id,target_id,relation,created_at,payload) VALUES (?,?,?,?,?,?)');
    for (const item of data.relations ?? []) relation.run(item.id, item.from, item.to, item.relation, item.createdAt ?? null, JSON.stringify(item));
    const review = db.prepare('INSERT INTO shadowgraph_reviews (id,decision_id,status,payload) VALUES (?,?,?,?)');
    for (const item of data.reviewSignals ?? []) review.run(item.id, item.decisionId, item.status ?? 'open', JSON.stringify(item));
    const idem = db.prepare('INSERT INTO shadowgraph_idempotency (key,payload) VALUES (?,?)');
    for (const item of data.idempotency ?? []) idem.run(item.key, JSON.stringify(item.value));
    const event = db.prepare('INSERT INTO shadowgraph_events (id,project,payload) VALUES (?,?,?)');
    for (const item of data.events ?? []) event.run(item.id, item.project ?? null, JSON.stringify(item));
  }
  function migrateLegacyPayload() {
    const legacy = db.prepare("SELECT payload FROM shadowgraph_state WHERE id = 1").get();
    if (!legacy) return;
    db.exec('BEGIN IMMEDIATE');
    try { replaceRelational(JSON.parse(legacy.payload)); db.exec('DROP TABLE shadowgraph_state; COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  migrateLegacyPayload();
  return {
    async load() { return exportFrom(db); },
    async save(data) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = exportFrom(db);
        assertRevision(current, data?.expectedRevision ?? data?.revision);
        const payload = nextRevision(Array.isArray(data) ? { ...EMPTY, records: data } : { ...data, revision: current.revision, expectedRevision: undefined });
        replaceRelational(payload); db.exec('COMMIT'); return payload.revision;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async restore(source) {
      const temporary = join(dirname(filePath), `.${filePath.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.restore`);
      try {
        const { copyFile } = await import('node:fs/promises');
        await copyFile(source, temporary);
        const check = new DatabaseSync(temporary);
        try { exportFrom(check); } finally { check.close(); }
        db.close();
        try { await rename(temporary, filePath); }
        catch (error) { db = new DatabaseSync(filePath); db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;'); throw error; }
        db = new DatabaseSync(filePath); db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;'); return { source, destination: filePath };
      } finally { await unlink(temporary).catch(() => {}); }
    },
    async backup(destination) {
      await mkdir(dirname(destination), { recursive: true });
      const temporary = join(dirname(destination), `.${destination.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.tmp`);
      try {
        const escaped = String(temporary).replaceAll("'", "''");
        db.exec(`VACUUM INTO '${escaped}'`);
        await rename(temporary, destination);
        return { source: filePath, destination };
      } finally { await unlink(temporary).catch(() => {}); }
    },
    close() { db.close(); }
  };
}
