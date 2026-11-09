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

export const SYMBOLIC_OPERATOR_ALIASES = Object.freeze({
  '>=': 'gte',
  '<=': 'lte',
  '==': 'equals',
  '===': 'equals',
  '=': 'equals',
  '!=': 'not_equals',
  '!==': 'not_equals',
  '<>': 'not_equals',
  '>': 'greater_than',
  '<': 'less_than'
});

const COMPACT_OPERATOR_SYMBOLS = Object.freeze({
  equals: '==',
  not_equals: '!=',
  greater_than: '>',
  less_than: '<',
  gte: '>=',
  lte: '<='
});

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

export function normalizeOperator(operator) {
  if (typeof operator !== 'string') return operator;
  const trimmed = operator.trim();
  return Object.hasOwn(SYMBOLIC_OPERATOR_ALIASES, trimmed) ? SYMBOLIC_OPERATOR_ALIASES[trimmed] : trimmed;
}

export function isSupportedOperator(operator) {
  return RULE_OPERATORS.includes(normalizeOperator(operator));
}

export function isSupportedUnit(unit) {
  return Object.hasOwn(UNITS, unit);
}

function deepEqual(a, b) {
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

function valuesConflict(a, b) {
  return !deepEqual(a, b);
}

export function resolveRuleAliases(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return { key: undefined, value: undefined, hasValue: false };
  }
  const hasKey = Object.hasOwn(rule, 'key') && rule.key !== undefined;
  const hasTarget = Object.hasOwn(rule, 'target') && rule.target !== undefined;
  if (hasKey && hasTarget && valuesConflict(rule.key, rule.target)) {
    throw new Error('Conflicting condition aliases: key and target must not conflict');
  }
  const hasValue = Object.hasOwn(rule, 'value') && rule.value !== undefined;
  const hasExpected = Object.hasOwn(rule, 'expected') && rule.expected !== undefined;
  if (hasValue && hasExpected && valuesConflict(rule.value, rule.expected)) {
    throw new Error('Conflicting condition aliases: value and expected must not conflict');
  }
  const key = hasKey ? rule.key : (hasTarget ? rule.target : undefined);
  const value = hasValue ? rule.value : (hasExpected ? rule.expected : undefined);
  const hasResolvedValue = hasValue || hasExpected;
  return { key, value, hasValue: hasResolvedValue };
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
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    return 'Rule is not a structured object';
  }
  const { value, hasValue } = resolveRuleAliases(rule);
  const operator = normalizeOperator(rule?.operator ?? 'equals');
  if (!hasValue || value === undefined) {
    return `Operator ${operator} has no value to compare against`;
  }
  if (operator === 'in' || operator === 'not_in') {
    if (!Array.isArray(value)) return `Operator ${operator} requires an array of allowed values`;
  }
  if (operator === 'between') {
    if (!Array.isArray(value) || value.length !== 2) return 'Operator between requires a two-element [low, high] range';
    if (value[0] === undefined || value[1] === undefined) return 'Operator between requires both bounds';
  }
  return null;
}

const QUANTITY = /^\s*(-?\d+(?:\.\d+)?)\s*([A-Za-z%]*)\s*$/;
const SYMBOLIC_CONDITION_RE = /^\s*([A-Za-z0-9_.:/-]+)\s*(>=|<=|===|!==|==|!=|<>|=|>|<)\s*(.+?)\s*$/;

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

export function parseConditionString(raw) {
  if (typeof raw !== 'string') return null;
  const match = SYMBOLIC_CONDITION_RE.exec(raw);
  if (!match) return null;
  const key = match[1].trim();
  const operator = normalizeOperator(match[2]);
  const rhs = match[3].trim();
  if (!key || !rhs) return null;
  if (rhs === 'true') return { key, operator, value: true };
  if (rhs === 'false') return { key, operator, value: false };
  if (rhs === 'null') return { key, operator, value: null };
  const quantity = parseQuantity(rhs);
  if (quantity) {
    return quantity.unit
      ? { key, operator, value: quantity.value, unit: quantity.unit }
      : { key, operator, value: quantity.value };
  }
  if ((rhs.startsWith('"') && rhs.endsWith('"')) || (rhs.startsWith("'") && rhs.endsWith("'"))) {
    return { key, operator, value: rhs.slice(1, -1) };
  }
  return { key, operator, value: rhs };
}

export function formatRuleCompact(rule) {
  if (typeof rule === 'string') return rule.trim();
  if (!rule || typeof rule !== 'object') return String(rule ?? '');
  const { key, value } = resolveRuleAliases(rule);
  const op = normalizeOperator(rule.operator ?? 'equals');
  const sym = COMPACT_OPERATOR_SYMBOLS[op] ?? op;
  const val = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
  const unit = rule.unit ? String(rule.unit) : '';
  return `${key ?? ''} ${sym} ${val}${unit}`.trim();
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

  const { key: resolvedKey, value: resolvedExpected } = resolveRuleAliases(rule);
  const operator = normalizeOperator(rule.operator ?? 'equals');
  const unit = rule.unit ?? null;
  const base = { operator, key: resolvedKey ?? null, expected: resolvedExpected, actual: value, unit };

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
  if (operator === 'equals') return { ...base, verdict: verdictOf(value === resolvedExpected), reason: 'Strict equality' };
  if (operator === 'not_equals') return { ...base, verdict: verdictOf(value !== resolvedExpected), reason: 'Strict inequality' };
  if (operator === 'contains') {
    const satisfied = Array.isArray(value) ? value.includes(resolvedExpected) : String(value).includes(String(resolvedExpected));
    return { ...base, verdict: verdictOf(satisfied), reason: Array.isArray(value) ? 'Array membership' : 'Substring containment' };
  }

  // The shape guards these two and `between` used to carry inline now live in
  // ruleOperandIssue() above, which runs first and returns the same reasons.
  if (operator === 'in' || operator === 'not_in') {
    const member = resolvedExpected.includes(value);
    return { ...base, verdict: verdictOf(operator === 'in' ? member : !member), reason: 'Categorical set membership' };
  }

  if (operator === 'between') {
    const low = comparablePair(value, resolvedExpected[0], unit);
    if (low.reason) return { ...base, verdict: 'unknown', reason: low.reason };
    const high = comparablePair(value, resolvedExpected[1], unit);
    if (high.reason) return { ...base, verdict: 'unknown', reason: high.reason };
    // Bounds are INCLUSIVE at both ends. Stated here because a range contract
    // that leaves this to the reader produces off-by-one review misses.
    const satisfied = low.pair[0] >= low.pair[1] && high.pair[0] <= high.pair[1];
    return { ...base, verdict: verdictOf(satisfied), reason: 'Inclusive range [low, high]' };
  }

  if (ORDERED_OPERATORS.has(operator)) {
    const resolved = comparablePair(value, resolvedExpected, unit);
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
