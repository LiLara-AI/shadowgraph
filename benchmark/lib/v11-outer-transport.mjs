// The outer decision model, reached through the meter.
//
// `requestOuterDecision` knows how to ask a chat model for one decision and how
// to refuse an answer that is not one. The provider meter knows how to mint a
// single-use endpoint and record what crossed it. Nothing joined them: there was
// no production `requestOuter` anywhere in the tree, only the doubles the tests
// inject. This is the join, and it is deliberately thin - it adds no retry, no
// fallback and no interpretation of a response.
//
// Two things in it are load-bearing rather than plumbing.
//
// **A fresh capability per call.** The endpoint is bound inside the request, not
// once at construction. The meter attributes a request by the path it arrived
// on, so a hoisted endpoint would attribute every outer call in the run to
// whichever unit happened to build it - and the ledger would look complete while
// naming the wrong unit.
//
// **The signal has to be bridged by hand.** `requestOuterDecision` builds its
// own AbortController from `config.timeoutMs` and passes that signal to
// `fetchImpl`; it has no parameter for the caller's. The runner's per-unit
// watchdog signal therefore reaches the socket only if it is composed in here.
// Without this the watchdog would mark a unit failed on its deadline and leave
// the request running against the provider, which is both a leak and a call the
// run does not account for.
//
// `namespace` is dropped on the floor, and that is the point of naming it: the
// runner hands one over, and the outer model must never see which project or
// user the arm is storing under.

import { randomUUID } from 'node:crypto';

const CORRELATION_FIELDS = Object.freeze([
  'runId',
  'attemptId',
  'armId',
  'scenarioId',
  'repetition',
  'phase',
  'requestClass'
]);

export class OuterTransportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OuterTransportError';
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function composeSignals(inner, outer) {
  if (outer === undefined || outer === null) return inner;
  if (inner === undefined || inner === null) return outer;
  // Either deadline may fire first: the request's own timeout, or the unit
  // watchdog that owns the whole unit.
  return AbortSignal.any([inner, outer]);
}

/**
 * Build the `requestOuter` a real run uses.
 *
 * `seeds` is the frozen seed list, indexed by repetition. The runner does not
 * hand a seed to the transport - it hands the correlation, and the repetition
 * in that correlation is the same index the plan used - so deriving it here
 * keeps one seed per repetition without a second source for it.
 */
export function createMeteredOuterTransport(options = {}) {
  const {
    meter,
    model,
    seeds,
    temperature,
    maxOutputTokens,
    timeoutMs,
    requestDecision,
    fetchImpl = globalThis.fetch
  } = options;

  if (meter === null || typeof meter !== 'object' || typeof meter.bindPlannedEndpoint !== 'function') {
    throw new OuterTransportError('a metered outer transport requires a provider meter');
  }
  if (!isNonEmptyString(model)) {
    throw new OuterTransportError('a metered outer transport requires the pinned model id');
  }
  if (!Array.isArray(seeds) || seeds.length === 0
    || !seeds.every((seed) => Number.isSafeInteger(seed))) {
    throw new OuterTransportError('a metered outer transport requires the frozen seed list');
  }
  if (!Number.isFinite(temperature) || temperature < 0) {
    throw new OuterTransportError('a metered outer transport requires the frozen temperature');
  }
  for (const [label, value] of [['maxOutputTokens', maxOutputTokens], ['timeoutMs', timeoutMs]]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new OuterTransportError(`a metered outer transport requires a positive ${label}`);
    }
  }
  if (typeof requestDecision !== 'function') {
    throw new OuterTransportError('a metered outer transport requires the outer decision requester');
  }
  if (typeof fetchImpl !== 'function') {
    throw new OuterTransportError('a metered outer transport requires fetch');
  }

  return async function requestOuter(input) {
    const { correlation, request, signal } = input ?? {};
    if (correlation === null || typeof correlation !== 'object') {
      throw new OuterTransportError('an outer request requires its correlation');
    }
    const seed = seeds[correlation.repetition];
    if (!Number.isSafeInteger(seed)) {
      throw new OuterTransportError(
        `no frozen seed is pinned for repetition ${String(correlation.repetition)}`
      );
    }

    // Exactly the seven fields the meter binds on, copied rather than passed
    // through, so nothing the runner adds later is silently minted into a route.
    const bound = {};
    for (const field of CORRELATION_FIELDS) bound[field] = correlation[field];
    bound.rootOperation = 'outer-decision';
    const route = await meter.bindPlannedEndpoint({
      ...bound,
      rootInvocationId: randomUUID(),
      planSlot: 'outer-decision',
      identityMode: 'static'
    });
    if (route === null || typeof route !== 'object' || !isNonEmptyString(route.endpoint)) {
      throw new OuterTransportError('the provider meter returned an invalid planned endpoint');
    }
    const endpoint = route.endpoint;

    return await requestDecision({
      fetchImpl: (url, init) => fetchImpl(url, {
        ...init,
        signal: composeSignals(init?.signal, signal)
      }),
      config: {
        endpoint,
        // The meter is the credential boundary. It holds whatever the upstream
        // needs and adds it on the way out; nothing downstream of here carries
        // one, and an outer request that sent its own would be reaching past the
        // meter it is supposed to be measured by.
        apiKey: null,
        model,
        seed,
        temperature,
        maxOutputTokens,
        timeoutMs
      },
      correlation,
      request
    });
  };
}
