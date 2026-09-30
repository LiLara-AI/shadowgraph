// Automatic capture's enrolment and store (plan v1.4.4 §12, §21.3, §22.6.1;
// OD-3; programme plan revision 6 PR-36a). Capture is off until the owner turns
// it on with `activate capture`, which records the private store it writes, the
// origin its captures carry, the projects it covers (all of them unless the
// owner narrows it) and its frozen admission limits. Reads are never affected.
import { lstat, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { activationFile } from './delivery.js';
import { canonicalPath } from './internal/owner-files.js';
import { usableOriginId } from './scope.js';

// Conservative admission limits, frozen until measured figures replace them
// through a gate (§22.6.3). Crossing one refuses new items; it is never raised
// to clear the condition, and nothing accepted is evicted (§22.6.1). Every
// capture rewrites the whole store, so the store's ceiling is kept where a
// burst of writes still fits the hook's deadline (PR-36 design review D-2).
// Before extraction exists (AG-3) the queue only grows, so capture_limited is
// the expected state once it fills: declared, never cleared by raising it.
export const CAPTURE_LIMITS = Object.freeze({ maxStoreBytes: 16 * 1024 * 1024, maxQueueDepth: 2000, maxItemBytes: 64 * 1024, maxItemsPerSession: 1000 });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const projectNames = (value) => Array.isArray(value) && value.every((name) => typeof name === 'string' && name.trim() && name === name.trim()) && new Set(value).size === value.length;

// What is wrong with a capture record's coverage, or null: all projects less
// those excluded, or only those named (§21.4 enrolment; OD-3).
export function coverageIssue(coverage) {
  if (!isObject(coverage)) return 'coverage is an object';
  if (coverage.projects === 'all') return projectNames(coverage.exclude) ? null : 'coverage.exclude names distinct projects';
  if (coverage.projects === 'only') return projectNames(coverage.include) && coverage.include.length > 0 ? null : 'coverage.include names at least one project, each once';
  return 'coverage.projects is all or only';
}

// What is wrong with a capture record's limits, or null.
export const limitsIssue = (limits) => (isObject(limits) && Object.keys(CAPTURE_LIMITS).every((name) => Number.isSafeInteger(limits[name]) && limits[name] > 0) ? null : `limits name ${Object.keys(CAPTURE_LIMITS).join(', ')}, each a positive integer`);

// The git repository a store path lies in, or null (§21.3, VAR-14): any
// directory above it holding a `.git` entry (a repository, or a worktree's
// pointer file), or a `.git` directory itself, walked from the path as the
// file system resolves it now, so a link or junction placed since activation
// is followed. No subprocess, so the hook can ask it on every event. A working
// tree whose git directory lies elsewhere (`core.worktree`, as dotfiles set-ups
// use) leaves no trace on this path and is not detected: a declared limit.
export async function storeRepository(file) {
  for (let directory = dirname(await canonicalPath(file)); ; directory = dirname(directory)) {
    if (basename(directory) === '.git') return directory;
    // Only an entry that is not there is absent; any other answer (access
    // denied, a path too long) counts as one, so the check fails closed.
    if (await lstat(join(directory, '.git')).then(() => true, (error) => !['ENOENT', 'ENOTDIR'].includes(error.code))) return directory;
    if (dirname(directory) === directory) return null;
  }
}

// The active capture record, or null: inert unless the record says capture is
// active for an absolute store of a supported kind, with its origin, coverage
// and limits well formed. The record must be a regular file, as for delivery.
export async function activeCapture(env = process.env) {
  const file = activationFile(env);
  if (!file) return null;
  try {
    if (!(await lstat(file)).isFile()) return null;
    const capture = JSON.parse(await readFile(file, 'utf8'))?.capabilities?.capture;
    if (capture?.state !== 'active' || typeof capture.store?.file !== 'string' || !isAbsolute(capture.store.file) || !['json', 'sqlite'].includes(capture.store.storage)) return null;
    if (usableOriginId(capture.originId) !== capture.originId || coverageIssue(capture.coverage) || limitsIssue(capture.limits)) return null;
    return capture;
  } catch {
    return null;
  }
}
