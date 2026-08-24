export class RevisionConflictError extends Error {
  constructor(expected, actual) { super(`ShadowGraph revision conflict: expected ${expected}, found ${actual}`); this.name = 'RevisionConflictError'; this.expected = expected; this.actual = actual; }
}

export function currentRevision(payload) { return Number.isInteger(payload?.revision) ? payload.revision : 0; }

export function nextRevision(payload) { return { ...payload, revision: currentRevision(payload) + 1 }; }

export function assertRevision(payload, expected) {
  const actual = currentRevision(payload);
  if (expected !== undefined && expected !== actual) throw new RevisionConflictError(expected, actual);
  return actual;
}
