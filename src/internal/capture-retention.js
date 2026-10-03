// OD-2 semantic reader floor. Pure policy: no deletion, ledger writes or
// quarantine changes. The lifecycle writer owns physical expiry separately.
import { isValidIsoInstant } from '../fact-validity.js';
import { CAPTURE_KIND, CAPTURE_SCHEMA_VERSION, captureItemIssue } from './capture.js';

export const RAW_RETENTION_DAYS = 7;
export const RAW_EXPIRED = 'raw_expired';
const DAY = 86_400_000;
const MAX_INSTANT = 8_640_000_000_000_000;

// Recorded deadlines/skeletons need destination-aware lifecycle reconciliation
// at restore, even when no project override is present.
export const hasCaptureRetentionState = (payload) => Array.isArray(payload?.records) && payload.records.some((item) => item?.kind === CAPTURE_KIND && (item.expiresAt != null || item.blockedReason === RAW_EXPIRED));

export function retentionOverridesIssue(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return 'retentionOverrides';
  const projects = new Set();
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return `retentionOverrides[${index}]`;
    if (typeof entry.project !== 'string' || !entry.project.trim() || projects.has(entry.project)) return `retentionOverrides[${index}].project`;
    if (!Number.isSafeInteger(entry.days) || entry.days <= 0) return `retentionOverrides[${index}].days`;
    projects.add(entry.project);
  }
  return null;
}

// A shorter current policy applies to existing raw. A recorded deadline is
// never extended by a later override. Unknown/future material is not declared
// eligible raw merely because it happens to have a timestamp.
export function effectiveCaptureExpiry(item, overrides = []) {
  if (item?.kind !== CAPTURE_KIND || item.schemaVersion !== CAPTURE_SCHEMA_VERSION || captureItemIssue(item) !== null) return null;
  const days = item.attribution === 'project' ? overrides.find((entry) => entry.project === item.project)?.days ?? RAW_RETENTION_DAYS : RAW_RETENTION_DAYS;
  const policy = Math.min(MAX_INSTANT, Date.parse(item.createdAt) + days * DAY);
  return new Date(Math.min(policy, item.expiresAt === null ? MAX_INSTANT : Date.parse(item.expiresAt))).toISOString();
}

export function captureRawExpired(item, overrides, instant) {
  if (!isValidIsoInstant(instant)) throw Object.assign(new Error('Capture retention requires a valid clock instant'), { code: 'capture_clock_invalid' });
  const expiry = effectiveCaptureExpiry(item, overrides);
  return expiry !== null && (item.blockedReason === RAW_EXPIRED || Date.parse(expiry) <= Date.parse(instant));
}
