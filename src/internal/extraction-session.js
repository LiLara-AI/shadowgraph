// Count journal entries belonging to one captured session, including records
// derived from it. No counter in a restored payload grants additional calls.
export function sessionJournalEntries(journal, item) {
  return journal.filter(entry => {
    const payload = entry.payload;
    return payload?.originId === item.originId && (payload?.source?.sessionId ?? payload?.sessionId) === item.source.sessionId;
  }).length;
}
export const WORKER_REASONS = Object.freeze(['input_bytes', 'session_journal', 'drain_items', 'drain_calls', 'window_calls',
  'drain_time', 'drain_stopped', 'worker_usage_unavailable', 'worker_clock_invalid', 'worker_budgets_invalid', 'executor_blocked', 'unknown_terminal', 'provider_refusal']);
export const workerReason = reason => WORKER_REASONS.includes(reason) ? reason : 'executor_blocked';
