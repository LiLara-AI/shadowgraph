export const NODE_SQLITE_MINIMUM_VERSION = '22.5.0';
export const NODE_SQLITE_NOT_APPLICABLE_REASON =
  'SQLite not measured: requires Node 22.5+ with node:sqlite.';

let nodeSqliteCapabilityPromise;

async function detectNodeSqlite() {
  try {
    const sqlite = await import('node:sqlite');
    if (typeof sqlite.DatabaseSync === 'function') {
      return Object.freeze({ available: true, status: 'AVAILABLE', reason: null });
    }
  } catch {
    // The capability result below is the supported fallback for runtimes without node:sqlite.
  }
  return Object.freeze({
    available: false,
    status: 'NOT_APPLICABLE',
    reason: NODE_SQLITE_NOT_APPLICABLE_REASON
  });
}

export async function getRuntimeCapabilities() {
  nodeSqliteCapabilityPromise ??= detectNodeSqlite();
  return Object.freeze({ nodeSqlite: await nodeSqliteCapabilityPromise });
}
