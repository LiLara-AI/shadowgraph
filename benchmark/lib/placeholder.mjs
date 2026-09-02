// Values that record the absence of an observation rather than an observation.
//
// This lives in its own module because four lock builders need it and a
// duplicated list is the defect it exists to prevent: two copies that can
// disagree about what counts as evidence. The v1.1 locks had it, the
// implementation lock did not, and `unknown` sailed through the one that was
// missing it - the same "fixed here, still open next door" shape independent
// review has now found three times in this work.
//
// It is a denylist and cannot be complete. A version string is not otherwise
// checkable, so anything unlisted is taken at face value. It refuses the
// spellings that mean "we did not look", not every value that might be wrong.
//
// It is also deliberately NOT exhaustive in the other direction. `none` was
// removed after review found `benchmark/competitors.lock.json` recording
// `"version": "none"` for the no-memory control arm - a true answer, committed,
// and the repository's own convention. A guard that refuses a real observation
// is worse than the hole it closes, so where a token is genuinely ambiguous
// between "absent" and "we did not look", it is left out.

const PLACEHOLDER_VALUES = new Set([
  '-', '?', '.', 'empty', 'missing', 'n/a', 'n.a', 'na', 'nan', 'nil',
  'null', 'pending', 'tbd', 'to do', 'todo', 'unavailable', 'undefined',
  'unknown', 'unset', 'unspecified', '[object object]',
  'not applicable', 'not available', 'not captured', 'not known',
  'not measured', 'not recorded', 'not set'
]);

/**
 * Fold the spellings of one placeholder together before comparing.
 *
 * `N / A`, `N.A.` and `???` are the same answer typed three ways, and matching
 * the exact string missed all three. This never changes what a lock records: it
 * exists only inside the predicate below.
 *
 * The trailing-period strip uses a lookbehind so it cannot consume a string
 * that is entirely punctuation. Without it, `...` reduced to the empty string
 * and was accepted, while `---` and `???` were refused - and the `.` entry
 * above was unreachable. Independent review found that asymmetry.
 */
function normalizePlaceholder(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/\s*([/.])\s*/gu, '$1')
    .replace(/(?<=[^.])\.+$/u, '')
    .replace(/^[-?.]+$/u, (run) => (new Set(run).size === 1 ? run[0] : run));
}

/** True when the value states that nothing was observed. */
export function isPlaceholder(value) {
  return PLACEHOLDER_VALUES.has(normalizePlaceholder(value));
}
