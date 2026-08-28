import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NODE_SQLITE_MINIMUM_VERSION,
  NODE_SQLITE_NOT_APPLICABLE_REASON,
  getRuntimeCapabilities
} from '../src/runtime-capabilities.js';

test('runtime capability helper detects node:sqlite and gives unavailable runtimes a neutral Node 22.5+ reason', async () => {
  let importAvailable = false;
  try {
    const sqlite = await import('node:sqlite');
    importAvailable = typeof sqlite.DatabaseSync === 'function';
  } catch {
    importAvailable = false;
  }

  const capabilities = await getRuntimeCapabilities();
  assert.equal(NODE_SQLITE_MINIMUM_VERSION, '22.5.0');
  assert.equal(
    NODE_SQLITE_NOT_APPLICABLE_REASON,
    'SQLite not measured: requires Node 22.5+ with node:sqlite.'
  );
  assert.equal(capabilities.nodeSqlite.available, importAvailable);
  assert.equal(capabilities.nodeSqlite.status, importAvailable ? 'AVAILABLE' : 'NOT_APPLICABLE');
  assert.equal(
    capabilities.nodeSqlite.reason,
    importAvailable ? null : NODE_SQLITE_NOT_APPLICABLE_REASON
  );

  if (process.versions.node.split('.')[0] === '20') {
    assert.equal(capabilities.nodeSqlite.available, false);
    assert.equal(capabilities.nodeSqlite.reason, NODE_SQLITE_NOT_APPLICABLE_REASON);
  }
});
