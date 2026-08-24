// Optional v0.2 SQLite backend. Requires a Node runtime exposing node:sqlite (22.5+).
export async function createSqliteStore(filePath) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error('SQLite storage requires Node 22.5+ with node:sqlite; use JSON storage on Node 20');
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS shadowgraph_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)');
  return {
    async load() {
      const mode = db.prepare('PRAGMA journal_mode').get();
      if (String(mode?.journal_mode).toLowerCase() !== 'wal') throw new Error('ShadowGraph SQLite storage requires WAL mode');
      const row = db.prepare('SELECT payload FROM shadowgraph_state WHERE id = 1').get();
      try { return row ? JSON.parse(row.payload) : { schemaVersion: 2, records: [], facts: [], events: [] }; }
      catch { throw new Error('ShadowGraph SQLite storage contains invalid data'); }
    },
    async save(data) {
      const payload = Array.isArray(data) ? { schemaVersion: 2, records: data, facts: [], events: [] } : data;
      db.prepare('INSERT INTO shadowgraph_state (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload').run(JSON.stringify(payload));
    },
    close() { db.close(); }
  };
}
