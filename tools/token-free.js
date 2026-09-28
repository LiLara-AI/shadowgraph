// Test support (plan rev6 §3.2): an entity's erasureToken is internal and
// random. A public result never carries one, and two independent runs never
// assign the same one, so a test that compares either with privileged state
// compares it without the token.
export function tokenFree(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => (key === 'erasureToken' ? undefined : item)));
}

// The public form of one stored record: without its token and, for an attempt
// an earlier build stored with no cause, with the cause every public result
// shows for it (PR-23): legacy free text if it has a reason, else not recorded.
export function publicForm(record) {
  const value = tokenFree(record);
  if (value?.kind !== 'attempt' || value.causalClaim !== undefined) return value;
  const given = typeof value.reason === 'string' ? value.reason.trim() !== '' : value.reason != null;
  return { ...value, causalClaim: { state: given ? 'legacy_freetext' : 'not_recorded' } };
}
