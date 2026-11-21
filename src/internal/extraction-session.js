// A tool call is captured as evidence, never sent to the model (owner decision
// D2, 2026-11-21): the worker sets it aside by code (extraction-worker.js).
export const isToolCall = item => ['PostToolUse', 'PostToolUseFailure'].includes(item?.source?.event);
// The conversation captures of one captured session: one per `capture.recorded`
// entry of that origin and session whose item is not a tool call (owner decision
// D3, 2026-11-21). Tool calls, state changes and derived records do not count.
// No counter in a restored payload grants additional calls.
export function sessionConversationCaptures(journal, item) {
  return journal.filter(entry => entry.type === 'capture.recorded' && entry.payload?.originId === item.originId
    && entry.payload.source?.sessionId === item.source.sessionId && !isToolCall(entry.payload)).length;
}
export const WORKER_REASONS = Object.freeze(['input_bytes', 'session_journal', 'drain_items', 'drain_calls', 'window_calls',
  'drain_time', 'drain_stopped', 'worker_usage_unavailable', 'worker_clock_invalid', 'worker_budgets_invalid', 'executor_blocked', 'unknown_terminal', 'provider_refusal']);
export const workerReason = reason => WORKER_REASONS.includes(reason) ? reason : 'executor_blocked';
