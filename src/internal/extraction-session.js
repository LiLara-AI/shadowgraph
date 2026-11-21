// A tool call is captured as evidence, never sent to the model (owner decision
// D2, 2026-11-21): the worker sets it aside by code (extraction-worker.js).
export const isToolCall = item => ['PostToolUse', 'PostToolUseFailure'].includes(item?.source?.event);
// What one captured session has cost against its ceiling: each conversation
// capture (a creation entry of that origin and session whose item is
// not a tool call; owner decision D3, 2026-11-21) counts once, or as many times
// as it has been sent to the model, so an item sent again and again still uses
// the session up. Tool calls and derived records do not count. Read from the
// journal: no counter in a payload that carries its journal grants more calls.
export function sessionConversationCaptures(journal, item) {
  const sent = new Map();
  for (const { type, payload } of journal) {
    if (payload?.kind !== 'capture' || payload.originId !== item.originId || payload.source?.sessionId !== item.source.sessionId || isToolCall(payload)) continue;
    if (type === 'capture.recorded') sent.set(payload.id, Math.max(sent.get(payload.id) ?? 1, 1));
    else if (sent.has(payload.id) && Number.isSafeInteger(payload.attempts)) sent.set(payload.id, Math.max(sent.get(payload.id), payload.attempts));
  }
  return [...sent.values()].reduce((sum, count) => sum + count, 0);
}
export const WORKER_REASONS = Object.freeze(['input_bytes', 'session_journal', 'drain_items', 'drain_calls', 'window_calls',
  'drain_time', 'drain_stopped', 'worker_usage_unavailable', 'worker_clock_invalid', 'worker_budgets_invalid', 'executor_blocked', 'unknown_terminal', 'provider_refusal']);
export const workerReason = reason => WORKER_REASONS.includes(reason) ? reason : 'executor_blocked';
