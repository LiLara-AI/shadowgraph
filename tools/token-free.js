// Test support (plan rev6 §3.2): an entity's erasureToken is internal and
// random. A public result never carries one, and two independent runs never
// assign the same one, so a test that compares either with privileged state
// compares it without the token.
export function tokenFree(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => (key === 'erasureToken' ? undefined : item)));
}
