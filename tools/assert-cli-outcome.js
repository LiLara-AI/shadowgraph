import assert from 'node:assert/strict';

// Test-only boundary: keep complete raw process observations for diagnostics.
export function assertCliOutcomeEqual(actual, expected) {
  const comparable = outcome => ({
    ...outcome,
    // Only this exact runtime-warning header has a nondeterministic PID.
    // Keep the warning body, line endings, stdout and application diagnostics.
    stderr: outcome.stderr.replace(/^\(node:\d+\)(?= ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?$)/gm, '(node:<PID>)')
  });
  try {
    assert.deepEqual(comparable(actual), comparable(expected));
  } catch (error) {
    error.message += `\nRaw CLI outcomes: ${JSON.stringify({ actual, expected })}`;
    throw error;
  }
}
