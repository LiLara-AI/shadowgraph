// Canonical fact-expiration policy shared by verification, migration,
// maintenance, and journal validation. The signed policy is considered first so
// a later caller-modified field can never extend an attested validity window.

export function isValidIsoInstant(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const [zoneHour, zoneMinute] = zone.slice(1).split(':').map(Number);
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return true;
}

export function earliestValidIsoInstant(...values) {
  let earliest = null;
  for (const value of values.flat()) {
    if (!isValidIsoInstant(value)) continue;
    if (earliest === null || Date.parse(value) < Date.parse(earliest)) earliest = value;
  }
  return earliest;
}

function sameInstant(left, right) {
  if (left == null && right == null) return true;
  return isValidIsoInstant(left) && isValidIsoInstant(right) && Date.parse(left) === Date.parse(right);
}

export function factValidityPolicyIssue(fact, options = {}) {
  const policy = fact?.validityPolicy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return options.required ? 'Fact validityPolicy is required' : null;
  }
  const allowed = new Set(['declaredExpiresAt', 'declaredValidTo', 'effectiveExpirationBoundary']);
  const unknown = Object.keys(policy).find((name) => !allowed.has(name));
  if (unknown) return `Fact validityPolicy contains unknown field ${unknown}`;
  for (const name of allowed) {
    if (policy[name] !== null && !isValidIsoInstant(policy[name])) return `Fact validityPolicy.${name} must be a valid timestamp or null`;
  }
  const expected = earliestValidIsoInstant(policy.declaredExpiresAt, policy.declaredValidTo);
  if (!sameInstant(policy.effectiveExpirationBoundary, expected)) return 'Fact validityPolicy effective expiration boundary is inconsistent';
  if (!sameInstant(fact?.expiresAt ?? null, policy.declaredExpiresAt)) return 'Fact declared expiresAt does not match its validityPolicy';
  const currentValidTo = fact?.temporal?.validTo ?? fact?.validTo ?? null;
  if (currentValidTo !== null && !isValidIsoInstant(currentValidTo)) return 'Fact current validTo must be a valid timestamp or null';
  const currentBoundary = earliestValidIsoInstant(fact?.expiresAt ?? null, currentValidTo);
  if (policy.effectiveExpirationBoundary && (!currentBoundary || Date.parse(currentBoundary) > Date.parse(policy.effectiveExpirationBoundary))) {
    return 'Fact validity extends beyond its effective expiration boundary';
  }
  return null;
}

export function effectiveFactExpirationBoundary(fact) {
  const policy = fact?.validityPolicy && typeof fact.validityPolicy === 'object' && !Array.isArray(fact.validityPolicy)
    ? fact.validityPolicy
    : {};
  return earliestValidIsoInstant(
    policy.effectiveExpirationBoundary,
    policy.declaredExpiresAt,
    fact?.expiresAt,
    policy.declaredValidTo,
    fact?.temporal?.validTo,
    fact?.validTo
  );
}
