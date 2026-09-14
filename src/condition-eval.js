// Deterministic three-valued evaluation of structured decision rules
// (`alternatives[].reopenWhen`, `attempts[].reusableWhen`).
//
// Why three-valued: the previous evaluator returned a bare boolean, so an
// unknown operator, a non-numeric value, and a unit it could not read all
// collapsed to `false` -- indistinguishable from "this condition was checked
// and the decision is fine". A condition we cannot evaluate is not a condition
// that passed, and saying so is the whole point of this module.
//
// No eval, no expression parsing, no model, no I/O. Every verdict is a
// comparison between a stored rule and a stored fact value.

import { isValidIsoInstant } from './fact-validity.js';

// Operators recognised at write time. Legacy set first, additions after.
export const RULE_OPERATORS = Object.freeze([
  'equals', 'not_equals', 'contains',
  'greater_than', 'less_than',
  'gte', 'lte', 'between',
  'in', 'not_in'
]);

const ORDERED_OPERATORS = Object.freeze(new Set(['greater_than', 'less_than', 'gte', 'lte']));

// Unit conversion is an explicit whitelist, keyed by dimension. A unit outside
// this table is never guessed at -- it yields `unknown`. Deliberately small:
// `m` is omitted because it reads as both minute and metre, and byte units are
// omitted because kB is 1000 under one convention and 1024 under another.
// Inventing a convention here would be the silent guess this module exists to
// prevent.
const UNITS = Object.freeze({
  ms: ['duration', 1],
  s: ['duration', 1000],
  sec: ['duration', 1000],
  min: ['duration', 60_000],
  h: ['duration', 3_600_000],
  hr: ['duration', 3_600_000],
  d: ['duration', 86_400_000],
  '%': ['percent', 1],
  pct: ['percent', 1]
});

export function isSupportedOperator(operator) {
  return RULE_OPERATORS.includes(operator);
}

export function isSupportedUnit(unit) {
  return Object.hasOwn(UNITS, unit);
}

/**
 * Why this rule has nothing usable to compare against, or null when it does.
 *
 * Every operator needs an operand. An ABSENT one is not the same as
 * `value: null`: null is a legitimate thing to compare against and JSON
 * preserves it, whereas an absent property is a rule that never says what it
 * compares to. Falsy operands -- `0`, `false`, `''` -- are real operands, so
 * this tests presence, never truthiness.
 *
 * Shared with the review-signal coverage code, so a rule is judged incomplete
 * by one definition rather than two that can drift apart.
 */
export function ruleOperandIssue(rule) {
  const operator = rule?.operator ?? 'equals';
  if (!rule || typeof rule !== 'object' || !Object.hasOwn(rule, 'value') || rule.value === undefined) {
    return `Operator ${operator} has no value to compare against`;
  }
  if (operator === 'in' || operator === 'not_in') {
    if (!Array.isArray(rule.value)) return `Operator ${operator} requires an array of allowed values`;
  }
  if (operator === 'between') {
    if (!Array.isArray(rule.value) || rule.value.length !== 2) return 'Operator between requires a two-element [low, high] range';
    if (rule.value[0] === undefined || rule.value[1] === undefined) return 'Operator between requires both bounds';
  }
  return null;
}

const QUANTITY = /^\s*(-?\d+(?:\.\d+)?)\s*([A-Za-z%]*)\s*$/;

// A finite number, optionally carrying a recognised unit suffix. Returns null
// for anything we refuse to interpret -- including a well-formed number with an
// unrecognised unit, which is the `"250 widgets" > 200` case that used to read
// as a confident false.
function parseQuantity(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? { value: raw, unit: null } : null;
  if (typeof raw !== 'string') return null;
  const match = QUANTITY.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2] ? match[2].toLowerCase() : null;
  if (unit && !Object.hasOwn(UNITS, unit)) return null;
  return { value, unit };
}

// Convert one quantity to the comparison base, given the unit the RULE declared.
//
// The contract, stated so it is not mistaken for inference: a bare number is
// taken to be expressed in the rule's declared unit -- that is the rule stating
// the unit of comparison. What is never done is the reverse: assuming an
// unannotated rule means milliseconds, or silently comparing a value that
// carries a unit against a rule that declares none.
function toComparable(quantity, declaredUnit) {
  if (!declaredUnit) return quantity.unit ? null : quantity.value;
  const declared = UNITS[declaredUnit];
  if (!declared) return null;
  if (!quantity.unit) return quantity.value * declared[1];
  const actual = UNITS[quantity.unit];
  if (!actual || actual[0] !== declared[0]) return null;
  return quantity.value * actual[1];
}

function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return String(value);
}

// Both sides must be valid ISO-8601 instants. No prose date parsing, ever.
function temporalPair(actual, expected) {
  if (!isValidIsoInstant(actual) || !isValidIsoInstant(expected)) return null;
  return [Date.parse(actual), Date.parse(expected)];
}

// Resolve an ordered comparison to two comparable numbers: temporal first, then
// numeric-with-units. Returns a reason on refusal so a caller can report WHY a
// condition is unknown, not merely that it is.
function comparablePair(actual, expected, unit) {
  const temporal = temporalPair(actual, expected);
  if (temporal) return { pair: temporal };
  if (isValidIsoInstant(actual) !== isValidIsoInstant(expected)) {
    return { reason: 'One side is a timestamp and the other is not' };
  }
  const left = parseQuantity(actual);
  if (!left) return { reason: `Observed value is not a finite number in a recognised unit: ${describe(actual)}` };
  const right = parseQuantity(expected);
  if (!right) return { reason: `Rule value is not a finite number in a recognised unit: ${describe(expected)}` };
  const leftBase = toComparable(left, unit);
  if (leftBase === null) return { reason: `Observed value unit is not comparable to the rule unit ${unit ?? '(none)'}` };
  const rightBase = toComparable(right, unit);
  if (rightBase === null) return { reason: `Rule value unit is not comparable to the rule unit ${unit ?? '(none)'}` };
  return { pair: [leftBase, rightBase] };
}

const verdictOf = (satisfied) => (satisfied ? 'true' : 'false');

/**
 * Evaluate one rule against one observed value.
 *
 * @returns {{verdict: 'true'|'false'|'unknown', operator: string|null, key: string|null,
 *            expected: unknown, actual: unknown, unit: string|null, reason: string}}
 *
 * `true`    the condition is satisfied -- the decision should be reviewed.
 * `false`   the condition is genuinely not satisfied.
 * `unknown` the condition could not be evaluated from the evidence available.
 *           This is NOT a pass. Callers must surface it, never discard it.
 */
export function evaluateRule(rule, value) {
  if (typeof rule === 'string') {
    // Legacy token form, preserved verbatim from the previous evaluator.
    // review() matches these against changedFacts and does not reach here.
    return {
      verdict: verdictOf(value === true || value === rule),
      operator: 'token', key: null, expected: rule, actual: value, unit: null,
      reason: 'Legacy token rule'
    };
  }
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return {
      verdict: 'unknown', operator: null, key: null, expected: undefined, actual: value, unit: null,
      reason: 'Rule is not a structured object'
    };
  }

  const operator = rule.operator ?? 'equals';
  const unit = rule.unit ?? null;
  const base = { operator, key: rule.key ?? null, expected: rule.value, actual: value, unit };

  if (!isSupportedOperator(operator)) {
    // Previously this returned false, so a typo'd operator meant the condition
    // could never fire and nothing ever said so.
    return { ...base, verdict: 'unknown', reason: `Unsupported operator ${describe(operator)}` };
  }
  if (unit !== null && !isSupportedUnit(unit)) {
    return { ...base, verdict: 'unknown', reason: `Unsupported unit ${describe(unit)}` };
  }

  // A rule that never states its operand cannot be evaluated, and in particular
  // is not satisfied. Previously only the ordered, range and set operators
  // noticed: `equals` and `contains` compared against `undefined` and returned a
  // confident `false`, and `not_equals` returned `true` -- because `500 !==
  // undefined` -- so a rule that said nothing read as a genuine breach.
  const operandIssue = ruleOperandIssue(rule);
  if (operandIssue) return { ...base, verdict: 'unknown', reason: operandIssue };

  // Equality and containment are total over any value and keep their legacy
  // semantics exactly, including the String() coercion inside `contains`.
  //
  // Note the asymmetry, because it is easy to miss: these three never consult
  // `unit`. Only the ordered operators and `between` convert. So
  // {operator:'equals', value:5000, unit:'ms'} against an observed "5s" is
  // `false`, not `true` and not `unknown`, even though the two are the same
  // quantity. A unit on an equality rule is inert. That is the legacy contract
  // held deliberately -- equality here means "the stored value is this value",
  // not "these measure the same thing" -- but use an ordered operator or
  // `between` when you mean the latter.
  if (operator === 'equals') return { ...base, verdict: verdictOf(value === rule.value), reason: 'Strict equality' };
  if (operator === 'not_equals') return { ...base, verdict: verdictOf(value !== rule.value), reason: 'Strict inequality' };
  if (operator === 'contains') {
    const satisfied = Array.isArray(value) ? value.includes(rule.value) : String(value).includes(String(rule.value));
    return { ...base, verdict: verdictOf(satisfied), reason: Array.isArray(value) ? 'Array membership' : 'Substring containment' };
  }

  // The shape guards these two and `between` used to carry inline now live in
  // ruleOperandIssue() above, which runs first and returns the same reasons.
  if (operator === 'in' || operator === 'not_in') {
    const member = rule.value.includes(value);
    return { ...base, verdict: verdictOf(operator === 'in' ? member : !member), reason: 'Categorical set membership' };
  }

  if (operator === 'between') {
    const low = comparablePair(value, rule.value[0], unit);
    if (low.reason) return { ...base, verdict: 'unknown', reason: low.reason };
    const high = comparablePair(value, rule.value[1], unit);
    if (high.reason) return { ...base, verdict: 'unknown', reason: high.reason };
    // Bounds are INCLUSIVE at both ends. Stated here because a range contract
    // that leaves this to the reader produces off-by-one review misses.
    const satisfied = low.pair[0] >= low.pair[1] && high.pair[0] <= high.pair[1];
    return { ...base, verdict: verdictOf(satisfied), reason: 'Inclusive range [low, high]' };
  }

  if (ORDERED_OPERATORS.has(operator)) {
    const resolved = comparablePair(value, rule.value, unit);
    if (resolved.reason) {
      // Previously Number("250ms") produced NaN, and every comparison against
      // NaN is false, so an unreadable value silently meant "no review needed".
      return { ...base, verdict: 'unknown', reason: resolved.reason };
    }
    const [actual, expected] = resolved.pair;
    const satisfied = operator === 'greater_than' ? actual > expected
      : operator === 'less_than' ? actual < expected
        : operator === 'gte' ? actual >= expected
          : actual <= expected;
    return { ...base, verdict: verdictOf(satisfied), reason: `Ordered comparison ${operator}` };
  }

  return { ...base, verdict: 'unknown', reason: `Operator ${describe(operator)} has no evaluation path` };
}
