// Conservative retry policy. The caller reserves usage before EVERY attempt,
// including a retry and an attempt whose outcome is subsequently unknown.
import { setTimeout as delay } from 'node:timers/promises';

const blocked = reason => ({ status: 'blocked', blockedReason: reason });
// The call ran, and the executor's own checks refused what came back: the
// stream was not one result, the turn count was not verified, or the session's
// own account did not show the confined session. That is this output's fault,
// not the route's, so the item is asked once more, as an invalid answer is, and
// the checks apply again. A capture's later items wait behind it in order, so
// leaving it to the next session's trigger left a whole session unextracted.
const REFUSED_OUTPUT = new Set(['unrecognised_response', 'turn_limit_unverified', 'runtime_confinement_unverified']);
const unstarted = receipt => receipt?.invocationStarted === false && receipt.processStarted === false
  && receipt.outputBytes === 0 && receipt.zeroUsage === true;

// A late read/guard may finish, but never regains permission to start work.
// onLate closes a store handle obtained after the caller has already stopped.
export function awaitWorkerStep(start, signal, onLate) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('drain_stopped'), { code: 'drain_stopped' }));
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { if (settled) return; settled = true; reject(Object.assign(new Error('drain_stopped'), { code: 'drain_stopped' })); };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal?.aborted) throw Object.assign(new Error('drain_stopped'), { code: 'drain_stopped' }); return start(); }).then(value => {
      signal?.removeEventListener('abort', abort);
      if (settled) { try { onLate?.(value); } catch { /* the caller already received an unavailable result */ } return; }
      settled = true; resolve(value);
    }, error => { signal?.removeEventListener('abort', abort); if (!settled) { settled = true; reject(error); } });
  });
}

export async function invokeWithRetry({ request, invoke, reserve, correct, signal, sleep = ms => delay(ms, undefined, { signal }) }) {
  let current = structuredClone(request);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) return blocked('drain_stopped');
    try { await reserve(); } catch (error) { return blocked(error.code ?? 'worker_usage_unavailable'); }
    if (signal?.aborted) return blocked('drain_stopped');
    let response;
    let abort;
    try {
      response = await Promise.race([invoke(structuredClone(current)), new Promise((_, reject) => {
        abort = () => reject(new Error('drain_stopped'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } catch { return blocked(signal?.aborted ? 'drain_stopped' : 'unknown_terminal'); }
    finally { if (abort) signal?.removeEventListener('abort', abort); }
    if (signal?.aborted) return blocked('drain_stopped');
    if (response?.status === 'success') return response;
    if (response?.status === 'blocked') { if (attempt || !REFUSED_OUTPUT.has(response.blockedReason)) return response; }
    else if (response?.status === 'schema_invalid') { if (attempt) return response; }
    else if (response?.status === 'transport_error' && unstarted(response.receipt)) {
      if (attempt) return blocked('transport_error');
    } else if (response?.status === 'malformed_invocation' && unstarted(response.receipt) && !attempt && correct) {
      let next;
      try { next = await correct(structuredClone(current)); } catch { return blocked('malformed_invocation'); }
      if (!next || JSON.stringify(next) === JSON.stringify(current)) return blocked('malformed_invocation');
      current = structuredClone(next);
    } else return blocked('unknown_terminal');
    if (signal?.aborted) return blocked('drain_stopped');
    try { await sleep(1000); } catch { return blocked('drain_stopped'); }
  }
  return blocked('unknown_terminal');
}
