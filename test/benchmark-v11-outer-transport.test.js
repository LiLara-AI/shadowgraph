// The join between the outer decision model and the provider meter.
//
// Both halves already existed and were tested: `requestOuterDecision` knows how
// to ask a chat model for one decision, and the meter knows how to mint a
// single-use endpoint and record what crossed it. This module is the wire
// between them, and every defect it can carry is a quiet one - the run still
// completes, the ledger still looks full, and the numbers are wrong.
//
// Three of those quiet defects are what this suite exists to catch.
//
// A hoisted endpoint. The meter attributes a request by the route it arrived
// on, so binding once at construction files every outer call in the run under
// whichever unit happened to build the transport. Nothing fails; the ledger
// names the wrong arm.
//
// A dropped caller signal. `requestOuterDecision` builds its own AbortController
// from `config.timeoutMs` and hands that signal to `fetchImpl`; it has no
// parameter for the caller's. If the runner's per-unit watchdog signal is not
// composed in here it reaches nothing, and the watchdog marks the unit failed on
// its deadline while the request keeps running against the provider - a leaked
// socket and a call the run never accounts for.
//
// A leaked namespace or credential. The runner hands the transport a namespace
// and the meter holds the API key; either one arriving at the outer model would
// tell it which project the arm is storing under, or reach past the boundary
// that is supposed to be measuring it.
//
// Everything here runs on plain fakes. The module takes an injected
// `requestDecision` and `fetchImpl` and a `meter` object, so no test needs a
// socket, and two of them drive the real `requestOuterDecision` to prove the
// shapes this module builds are the shapes it validates.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STANDARD_DECISION_RESPONSE_SCHEMA,
  requestOuterDecision
} from '../benchmark/lib/outer-model.mjs';
import {
  OuterTransportError,
  createMeteredOuterTransport
} from '../benchmark/lib/v11-outer-transport.mjs';

const SEEDS = Object.freeze([11, 22, 33]);

const CORRELATION_FIELDS = Object.freeze([
  'armId',
  'attemptId',
  'phase',
  'repetition',
  'requestClass',
  'runId',
  'scenarioId'
]);

const CONFIG_FIELDS = Object.freeze([
  'apiKey',
  'endpoint',
  'maxOutputTokens',
  'model',
  'seed',
  'temperature',
  'timeoutMs'
]);

const DECISION = Object.freeze({
  decisionId: 'decision-outer-transport-1',
  choiceId: 'option-z',
  recalledAlternativeIds: ['option-a'],
  recalledRejectionReasonIds: ['reason-a'],
  constraintIdsAddressed: ['constraint-a'],
  evidenceIdsCited: ['evidence-a'],
  riskIdsRecognized: ['risk-a'],
  reviewTriggerIds: ['trigger-a'],
  changedFactDetected: null,
  changedFactId: null,
  recommendation: 'Use the reversible migration.',
  failedAttemptIdsAvoided: [],
  failedAttemptReasonIdsCited: [],
  memoryProjectId: 'project-a',
  memoryUserId: null
});

// Deliberately unmistakable strings: the leak assertions look for these inside
// a JSON dump, so they must not collide with anything else in the fixtures.
const NAMESPACE = Object.freeze({
  projectId: 'namespace-project-must-not-leak',
  userId: 'namespace-user-must-not-leak'
});

function correlationFor(overrides = {}) {
  return {
    runId: 'run-outer-transport',
    attemptId: 'attempt-1',
    armId: 'shadowgraph-full',
    scenarioId: 'S01_DATABASE',
    repetition: 0,
    phase: 'A',
    requestClass: 'outer_decision_llm',
    ...overrides
  };
}

function outerRequest() {
  return {
    system: 'Return one JSON object only.',
    prompt: 'Use the supplied decision inputs.',
    responseSchema: { ...STANDARD_DECISION_RESPONSE_SCHEMA }
  };
}

function providerResponse() {
  return new Response(JSON.stringify({
    id: 'chatcmpl-outer-transport-1',
    object: 'chat.completion',
    created: 1,
    model: 'provider-reported-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: JSON.stringify(DECISION) },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// A meter double that mints a distinct route per binding, the way the real one
// does, and keeps every object it was handed so the binding can be inspected.
function meterDouble() {
  const bound = [];
  const endpoints = [];
  return {
    bound,
    endpoints,
    bindEndpoint(correlation) {
      bound.push(correlation);
      const endpoint = `http://127.0.0.1:7777/provider-meter/v1/route-${bound.length}`;
      endpoints.push(endpoint);
      return endpoint;
    }
  };
}

function transport({ meter = meterDouble(), onRequest = null, onFetch = null, ...options } = {}) {
  const decisions = [];
  const fetches = [];
  const requestOuter = createMeteredOuterTransport({
    meter,
    model: 'frozen-model',
    seeds: SEEDS,
    temperature: 0,
    maxOutputTokens: 900,
    timeoutMs: 5_000,
    requestDecision: async (input) => {
      decisions.push(input);
      if (onRequest !== null) return await onRequest(input);
      return { decision: `decision-${decisions.length}` };
    },
    fetchImpl: async (url, init) => {
      fetches.push({ url, init });
      if (onFetch !== null) return await onFetch(url, init);
      return providerResponse();
    },
    ...options
  });
  return { requestOuter, meter, decisions, fetches };
}

function validOptions(overrides = {}) {
  return {
    meter: meterDouble(),
    model: 'frozen-model',
    seeds: SEEDS,
    temperature: 0,
    maxOutputTokens: 900,
    timeoutMs: 5_000,
    requestDecision: async () => ({ decision: 'unused' }),
    fetchImpl: async () => providerResponse(),
    ...overrides
  };
}

test('construction refuses each missing or invalid option, and names the one it refused', () => {
  // The positive case first: without it the table below would pass just as
  // happily against a constructor that refused everything.
  assert.equal(typeof createMeteredOuterTransport(validOptions()), 'function');

  const cases = [
    ['meter', { meter: undefined }, /provider meter/u],
    ['meter', { meter: null }, /provider meter/u],
    ['meter', { meter: {} }, /provider meter/u],
    ['meter', { meter: { bindEndpoint: 'http://127.0.0.1:7777/v1' } }, /provider meter/u],
    ['meter', { meter: () => 'http://127.0.0.1:7777/v1' }, /provider meter/u],
    ['model', { model: undefined }, /pinned model id/u],
    ['model', { model: '' }, /pinned model id/u],
    ['model', { model: 42 }, /pinned model id/u],
    ['seeds', { seeds: undefined }, /frozen seed list/u],
    ['seeds', { seeds: [] }, /frozen seed list/u],
    ['seeds', { seeds: 11 }, /frozen seed list/u],
    ['seeds', { seeds: [11, 1.5] }, /frozen seed list/u],
    ['seeds', { seeds: [11, '22'] }, /frozen seed list/u],
    ['seeds', { seeds: [Number.MAX_SAFE_INTEGER + 1] }, /frozen seed list/u],
    ['temperature', { temperature: undefined }, /frozen temperature/u],
    ['temperature', { temperature: -0.1 }, /frozen temperature/u],
    ['temperature', { temperature: Number.NaN }, /frozen temperature/u],
    ['temperature', { temperature: Number.POSITIVE_INFINITY }, /frozen temperature/u],
    ['temperature', { temperature: '0' }, /frozen temperature/u],
    ['maxOutputTokens', { maxOutputTokens: undefined }, /positive maxOutputTokens/u],
    ['maxOutputTokens', { maxOutputTokens: 0 }, /positive maxOutputTokens/u],
    ['maxOutputTokens', { maxOutputTokens: -1 }, /positive maxOutputTokens/u],
    ['maxOutputTokens', { maxOutputTokens: 900.5 }, /positive maxOutputTokens/u],
    ['timeoutMs', { timeoutMs: undefined }, /positive timeoutMs/u],
    ['timeoutMs', { timeoutMs: 0 }, /positive timeoutMs/u],
    ['timeoutMs', { timeoutMs: -5_000 }, /positive timeoutMs/u],
    ['timeoutMs', { timeoutMs: Number.NaN }, /positive timeoutMs/u],
    ['requestDecision', { requestDecision: undefined }, /outer decision requester/u],
    ['requestDecision', { requestDecision: {} }, /outer decision requester/u],
    ['fetchImpl', { fetchImpl: null }, /requires fetch/u],
    ['fetchImpl', { fetchImpl: 'fetch' }, /requires fetch/u]
  ];

  for (const [label, override, message] of cases) {
    assert.throws(
      () => createMeteredOuterTransport(validOptions(override)),
      (error) => {
        assert.ok(error instanceof OuterTransportError, `${label}: must be an OuterTransportError`);
        assert.match(error.message, message);
        return true;
      },
      `${label} ${JSON.stringify(override[label] ?? null)} must be refused by name`
    );
  }
});

test('every call binds its own endpoint, and the config carries the one bound for that call', async () => {
  // The reason this matters more than it looks: the meter attributes a request
  // to a unit by the route it arrived on. An endpoint hoisted to construction
  // would file every outer call in the run under whichever unit built it, and
  // the ledger would be complete, internally consistent, and about the wrong
  // arm. So a second call must bind a second time and must use what it bound.
  const { requestOuter, meter, decisions } = transport();

  await requestOuter({ correlation: correlationFor({ attemptId: 'attempt-1' }), request: outerRequest() });
  await requestOuter({ correlation: correlationFor({ attemptId: 'attempt-2' }), request: outerRequest() });

  assert.equal(meter.bound.length, 2, 'each outer request must mint its own capability');
  assert.equal(meter.endpoints[0] === meter.endpoints[1], false);
  assert.equal(decisions[0].config.endpoint, meter.endpoints[0]);
  assert.equal(decisions[1].config.endpoint, meter.endpoints[1], 'the second call must not reuse the first route');
  assert.deepEqual(meter.bound.map(({ attemptId }) => attemptId), ['attempt-1', 'attempt-2']);
});

test('exactly the seven correlation fields are bound, even when the caller carries more', async () => {
  // The runner's correlation grows over time. Anything extra that reached
  // bindEndpoint would be minted into a route the real meter then refuses, and
  // anything missing would bind a route attributed to the wrong unit - so the
  // bound object is asserted whole, not field by field.
  const correlation = correlationFor({
    repetition: 1,
    namespace: NAMESPACE,
    unitId: 'unit-17',
    apiKey: 'caller-supplied-key',
    deadlineAt: 1_700_000_000_000
  });
  const { requestOuter, meter } = transport();

  await requestOuter({ correlation, request: outerRequest() });

  assert.deepEqual(Object.keys(meter.bound[0]).sort(), [...CORRELATION_FIELDS]);
  assert.deepEqual(meter.bound[0], {
    runId: 'run-outer-transport',
    attemptId: 'attempt-1',
    armId: 'shadowgraph-full',
    scenarioId: 'S01_DATABASE',
    repetition: 1,
    phase: 'A',
    requestClass: 'outer_decision_llm'
  });
  // Copied, not handed over: a binding that shared the caller's object would
  // change underneath the meter when the runner reused the correlation.
  assert.notEqual(meter.bound[0], correlation);
});

test('the seed is the one pinned to the correlation repetition in the frozen list', async () => {
  const { requestOuter, decisions } = transport();

  for (const repetition of [0, 1, 2]) {
    await requestOuter({ correlation: correlationFor({ repetition }), request: outerRequest() });
  }

  assert.deepEqual(decisions.map(({ config }) => config.seed), [11, 22, 33]);
  // The repetition the plan used is the index the seed comes from; a transport
  // that took the seed from a counter of its own would drift from the plan on a
  // resumed or reordered run while still looking deterministic.
  assert.deepEqual(decisions.map(({ config }) => config.model), ['frozen-model', 'frozen-model', 'frozen-model']);
});

test('a repetition with no pinned seed is refused instead of falling back to a seed', async () => {
  const { requestOuter, meter, decisions } = transport();

  for (const repetition of [3, -1, 1.5, null]) {
    await assert.rejects(
      requestOuter({ correlation: correlationFor({ repetition }), request: outerRequest() }),
      (error) => {
        assert.ok(error instanceof OuterTransportError);
        assert.match(error.message, /no frozen seed is pinned for repetition/u);
        return true;
      },
      `repetition ${JSON.stringify(repetition)} must be refused rather than defaulted`
    );
  }

  // Refused before anything was minted or sent: a default of seeds[0] would
  // have produced a real, plausible-looking decision under an unplanned seed,
  // and a route bound before the check would leave the meter holding a
  // capability no request will ever arrive on.
  assert.equal(meter.bound.length, 0);
  assert.equal(decisions.length, 0);
});

test('an outer request with no correlation is refused before anything is bound', async () => {
  const { requestOuter, meter, decisions } = transport();

  for (const input of [undefined, {}, { correlation: null }, { correlation: 'run-1' }]) {
    await assert.rejects(
      requestOuter(input),
      (error) => {
        assert.ok(error instanceof OuterTransportError);
        assert.match(error.message, /requires its correlation/u);
        return true;
      },
      `${JSON.stringify(input ?? null)} must be refused`
    );
  }
  assert.equal(meter.bound.length, 0);
  assert.equal(decisions.length, 0);
});

test('the namespace the runner passes reaches neither the decision requester nor fetch', async () => {
  // The outer model must not learn which project or user the arm stores under -
  // that is the arm's business and knowing it would let the decision be shaped
  // by it. A transport that forwarded its whole input (`{ ...input, config }`)
  // would leak it silently, which is why this looks at the serialized arguments
  // rather than at a named field.
  const { requestOuter, decisions, fetches } = transport({
    onRequest: async (input) => {
      await input.fetchImpl('http://127.0.0.1:7777/provider-meter/v1/route-1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'frozen-model' })
      });
      return { decision: 'done' };
    }
  });

  await requestOuter({
    correlation: correlationFor(),
    request: outerRequest(),
    namespace: NAMESPACE
  });

  const seenByRequester = JSON.stringify(decisions[0]);
  const seenByFetch = JSON.stringify(fetches[0]);
  // Control: prove the haystacks are real, so the absence assertions below are
  // not passing against an empty or undefined string.
  assert.match(seenByRequester, /run-outer-transport/u);
  assert.match(seenByFetch, /route-1/u);

  for (const leaked of Object.values(NAMESPACE)) {
    assert.equal(seenByRequester.includes(leaked), false, `${leaked} must not reach the decision requester`);
    assert.equal(seenByFetch.includes(leaked), false, `${leaked} must not reach fetch`);
  }
  assert.equal(Object.hasOwn(decisions[0], 'namespace'), false);
  assert.deepEqual(Object.keys(decisions[0]).sort(), ['config', 'correlation', 'fetchImpl', 'request']);
});

test('the config carries a null apiKey and nothing else the constructor was handed', async () => {
  // The meter is the credential boundary: it holds whatever the upstream needs
  // and adds it on the way out. An outer request that carried its own key would
  // be reaching past the thing that is supposed to be measuring it, so the
  // config is asserted whole - an extra field is as much a defect as a wrong one.
  const { requestOuter, meter, decisions } = transport({
    apiKey: 'constructor-supplied-key-must-not-be-forwarded',
    endpoint: 'http://127.0.0.1:9999/v1'
  });

  await requestOuter({ correlation: correlationFor({ repetition: 2 }), request: outerRequest() });

  assert.deepEqual(Object.keys(decisions[0].config).sort(), [...CONFIG_FIELDS]);
  assert.deepEqual(decisions[0].config, {
    endpoint: meter.endpoints[0],
    apiKey: null,
    model: 'frozen-model',
    seed: 33,
    temperature: 0,
    maxOutputTokens: 900,
    timeoutMs: 5_000
  });
  assert.equal(
    JSON.stringify(decisions[0]).includes('constructor-supplied-key-must-not-be-forwarded'),
    false,
    'an unknown constructor option must not be spread into the config'
  );
});

test('aborting the caller signal aborts the signal fetch received', async () => {
  // The property this whole module exists for. `requestOuterDecision` builds its
  // own AbortController from config.timeoutMs and passes that signal to
  // fetchImpl; it has no parameter for the caller's. Without the composition
  // here, the runner's per-unit watchdog would fire, mark the unit failed, and
  // leave the request running against the provider - a leaked socket and a
  // provider call the run never accounts for.
  const inner = new AbortController();
  const watchdog = new AbortController();
  const { requestOuter, fetches } = transport({
    onRequest: async (input) => {
      await input.fetchImpl('http://127.0.0.1:7777/provider-meter/v1/route-1/chat/completions', {
        method: 'POST',
        signal: inner.signal
      });
      return { decision: 'done' };
    }
  });

  await requestOuter({
    correlation: correlationFor(),
    request: outerRequest(),
    signal: watchdog.signal
  });

  const received = fetches[0].init.signal;
  assert.ok(received instanceof AbortSignal);
  assert.equal(received.aborted, false, 'nothing has fired yet');
  assert.notEqual(received, inner.signal, 'the inner signal alone cannot carry the caller deadline');

  watchdog.abort(new Error('the unit watchdog fired'));

  assert.equal(received.aborted, true, "the caller's abort must reach the socket");
  assert.equal(received.reason.message, 'the unit watchdog fired');
  assert.equal(inner.signal.aborted, false, 'composition is one-way: the inner deadline is untouched');
});

test("the request's own deadline still aborts the signal fetch received", async () => {
  // The mirror of the test above. A composition that replaced the inner signal
  // with the caller's would pass that one and silently disarm the per-request
  // timeout, so both directions have to be checked.
  const inner = new AbortController();
  const watchdog = new AbortController();
  const { requestOuter, fetches } = transport({
    onRequest: async (input) => {
      await input.fetchImpl('http://127.0.0.1:7777/provider-meter/v1/route-1/chat/completions', {
        signal: inner.signal
      });
      return { decision: 'done' };
    }
  });

  await requestOuter({
    correlation: correlationFor(),
    request: outerRequest(),
    signal: watchdog.signal
  });

  const received = fetches[0].init.signal;
  inner.abort(new Error('the request timeout fired'));

  assert.equal(received.aborted, true, 'the inner deadline must still reach the socket');
  assert.equal(received.reason.message, 'the request timeout fired');
  assert.equal(watchdog.signal.aborted, false);
});

test('a caller signal that already aborted arrives at fetch already aborted', async () => {
  // The unit watchdog can fire while an earlier phase is still unwinding, so the
  // next request starts with a dead signal. Composition happens per call, so it
  // must observe that rather than starting the request as if nothing had fired.
  const watchdog = new AbortController();
  watchdog.abort(new Error('the unit watchdog fired before this request started'));
  const { requestOuter, fetches } = transport({
    onRequest: async (input) => {
      await input.fetchImpl('http://127.0.0.1:7777/provider-meter/v1/route-1/chat/completions', {
        signal: new AbortController().signal
      });
      return { decision: 'done' };
    }
  });

  await requestOuter({
    correlation: correlationFor(),
    request: outerRequest(),
    signal: watchdog.signal
  });

  assert.equal(fetches[0].init.signal.aborted, true);
  assert.equal(
    fetches[0].init.signal.reason.message,
    'the unit watchdog fired before this request started'
  );
});

test('with no caller signal the inner signal is passed through unchanged', async () => {
  // Not every caller has a watchdog. The composition must degrade to the inner
  // signal itself: `AbortSignal.any([inner, undefined])` throws a TypeError, and
  // a wrapper that swallowed that would hand fetch no signal at all and disarm
  // the per-request timeout for every call that arrived without a watchdog.
  const inner = new AbortController();
  const { requestOuter, fetches } = transport({
    onRequest: async (input) => {
      await input.fetchImpl('http://127.0.0.1:7777/provider-meter/v1/route-1/chat/completions', {
        signal: inner.signal
      });
      return { decision: 'done' };
    }
  });

  await requestOuter({ correlation: correlationFor(), request: outerRequest() });

  assert.equal(fetches[0].init.signal, inner.signal, 'nothing to compose means nothing to wrap');
  inner.abort(new Error('the request timeout fired'));
  assert.equal(fetches[0].init.signal.aborted, true);
});

test("with no inner signal the caller's signal is the one fetch receives", async () => {
  // A requester that called fetch with no init at all must still be cancellable;
  // reading `init.signal` rather than `init?.signal` would throw here instead.
  const watchdog = new AbortController();
  const { requestOuter, fetches } = transport({
    onRequest: async (input) => {
      await input.fetchImpl('http://127.0.0.1:7777/provider-meter/v1/route-1/chat/completions');
      return { decision: 'done' };
    }
  });

  await requestOuter({
    correlation: correlationFor(),
    request: outerRequest(),
    signal: watchdog.signal
  });

  assert.deepEqual(Object.keys(fetches[0].init), ['signal']);
  assert.equal(fetches[0].init.signal, watchdog.signal);
});

test('the wrapped fetch forwards the url and every other init field unchanged', async () => {
  // The wrapper exists only to add a signal. A rebuild that passed just
  // `{ signal }` would drop the method, headers and body and turn every outer
  // call into a GET the provider answers with an error the run then reports as
  // a model failure.
  const sent = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shadowgraph-phase': 'A' },
    body: JSON.stringify({ model: 'frozen-model', seed: 11 }),
    keepalive: false
  };
  const { requestOuter, fetches } = transport({
    onRequest: async (input) => {
      await input.fetchImpl('http://127.0.0.1:7777/provider-meter/v1/route-1/chat/completions', {
        ...sent,
        signal: new AbortController().signal
      });
      return { decision: 'done' };
    }
  });

  await requestOuter({ correlation: correlationFor(), request: outerRequest() });

  assert.equal(fetches[0].url, 'http://127.0.0.1:7777/provider-meter/v1/route-1/chat/completions');
  const { signal, ...forwarded } = fetches[0].init;
  assert.deepEqual(forwarded, sent);
  assert.ok(signal instanceof AbortSignal);
});

test('the real outer decision requester accepts what this transport hands it', async () => {
  // The fakes above assert the shape this module builds; only the real requester
  // asserts that shape is the one it validates. It refuses an endpoint with a
  // query string, a correlation with an extra key, a temperature above two - so
  // a transport whose config drifted would fail here and nowhere else until a
  // live run. No socket is involved: fetch is a double returning one canned
  // provider payload.
  const { requestOuter, meter, fetches } = transport({ requestDecision: requestOuterDecision });

  const result = await requestOuter({
    correlation: correlationFor({ repetition: 1 }),
    request: outerRequest(),
    namespace: NAMESPACE
  });

  assert.deepEqual(result.decision, DECISION);
  assert.equal(result.requestCount, 1);
  assert.equal(result.correlation.requestClass, 'outer_decision_llm');
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, `${meter.endpoints[0]}/chat/completions`);
  assert.equal(JSON.parse(fetches[0].init.body).seed, 22, 'the pinned seed must reach the provider body');
  // apiKey: null is not decoration - it is what keeps the credential inside the
  // meter. A key in the config would be minted into this header.
  assert.equal(Object.hasOwn(fetches[0].init.headers, 'authorization'), false);
  assert.equal(JSON.stringify(fetches[0]).includes(NAMESPACE.projectId), false);
});

test('the unit watchdog cancels a request already in flight through the real requester', async () => {
  // The end-to-end of the signal bridge. timeoutMs is set far beyond the test so
  // the request's own deadline cannot rescue it: if the caller's signal did not
  // reach the socket, this would sit here until the inner timeout fired and the
  // race below would report it still pending.
  let fetchEntered;
  const entered = new Promise((resolve) => { fetchEntered = resolve; });
  const { requestOuter, fetches } = transport({
    requestDecision: requestOuterDecision,
    timeoutMs: 600_000,
    onFetch: async (_url, init) => {
      fetchEntered();
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    }
  });

  const watchdog = new AbortController();
  const pending = requestOuter({
    correlation: correlationFor(),
    request: outerRequest(),
    signal: watchdog.signal
  });
  await entered;
  watchdog.abort(new Error('the unit watchdog fired'));

  const outcome = await Promise.race([
    pending.then(() => 'resolved', (error) => error.message),
    new Promise((resolve) => { setTimeout(() => resolve('still-pending'), 250); })
  ]);

  assert.equal(outcome, 'the unit watchdog fired');
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].init.signal.aborted, true);
});
