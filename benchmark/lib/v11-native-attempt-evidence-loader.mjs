import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const SAFE_PROBE_REPORT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Read evidence reports only from the evidence record's own directory. Invalid
 * names intentionally yield no entry; the native evidence verifier then emits a
 * specific fail-closed finding for the associated recovery policy tuple.
 */
export async function loadNativeAttemptProbeReports({ evidencePath, evidence } = {}) {
  const reports = new Map();
  if (typeof evidencePath !== 'string' || !isPlainRecord(evidence) || !Array.isArray(evidence.entries)) {
    return reports;
  }
  let canonicalRoot;
  try {
    const evidenceStat = await lstat(evidencePath);
    const lexicalRoot = path.dirname(path.resolve(evidencePath));
    const rootStat = await lstat(lexicalRoot);
    if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink()
      || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return reports;
    }
    canonicalRoot = await realpath(lexicalRoot);
    const canonicalEvidence = await realpath(evidencePath);
    if (path.dirname(canonicalEvidence) !== canonicalRoot) return reports;
  } catch {
    return reports;
  }
  const names = new Set(
    evidence.entries
      .map((entry) => (isPlainRecord(entry) ? entry.probeReport : null))
      .filter((name) => typeof name === 'string' && SAFE_PROBE_REPORT.test(name) && !name.includes('..'))
  );
  for (const name of names) {
    const candidate = path.resolve(canonicalRoot, name);
    if (path.dirname(candidate) !== canonicalRoot) continue;
    try {
      const before = await lstat(candidate);
      if (!before.isFile() || before.isSymbolicLink()) continue;
      const canonicalCandidate = await realpath(candidate);
      if (path.dirname(canonicalCandidate) !== canonicalRoot) continue;
      const bytes = await readFile(canonicalCandidate);
      const after = await lstat(candidate);
      if (!after.isFile() || after.isSymbolicLink()
        || before.dev !== after.dev || before.ino !== after.ino) continue;
      reports.set(name, bytes);
    } catch {
      // Missing, unreadable, raced, or non-canonical files are fail-closed.
    }
  }
  return reports;
}
