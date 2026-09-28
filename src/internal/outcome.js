// Plan v1.4.4 §9.4, §14.5 (PR-24): whether an attempt failed, and an outcome
// from an observed exit status. Pure: no graph state, no transport.

// failed | not_failed | undetermined. A declared resultClass decides. A captured
// attempt -- one carrying a captureRef or outcome evidence -- with no class
// (absent or null) is undetermined: its prose is never read, it is never a
// failure to avoid, and it is never implied to have succeeded. Every other
// attempt is classified as it always was: a legacy null class is not a
// failure, and with no class the wording heuristic decides, unchanged, so no
// stored attempt changes meaning.
export function attemptOutcome(attempt) {
  if (attempt.resultClass != null) return attempt.resultClass === 'failed' ? 'failed' : 'not_failed';
  if (attempt.captureRef != null || attempt.outcomeEvidence != null) return 'undetermined';
  if (attempt.resultClass === null) return 'not_failed';
  return /fail|regression|error/i.test(attempt.result) ? 'failed' : 'not_failed';
}

// An integer exit status is observed: 0 succeeded, anything else failed.
// Anything else is absent, with no resultClass: never 'inconclusive' and never
// a fourth class. P6's capture writer is the first caller; its source contract
// reports a status it cannot trust (grep and diff exit 1) as missing.
export function outcomeFromExitStatus(exitStatus, source) {
  if (Number.isSafeInteger(exitStatus)) return { resultClass: exitStatus === 0 ? 'succeeded' : 'failed', outcomeEvidence: { state: 'observed', source, exitStatus } };
  return { outcomeEvidence: { state: 'absent', source } };
}
