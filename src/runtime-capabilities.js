// Node 22 emits this on stderr before otherwise clean JSON CLI output. Keep
// every other warning intact; this is the node:sqlite import boundary.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  if (type === 'ExperimentalWarning' && warning === 'SQLite is an experimental feature and might change at any time') return;
  return emitWarning.call(this, warning, ...args);
};

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
