import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeWithRetry } from '../src/internal/extraction-policy.js';

const request = { prompt: 'synthetic material', schema: { type: 'object', properties: {}, required: [], additionalProperties: false } };
const success = { status: 'success', value: {}, receipt: { invocationStarted: true } };
async function run(responses, extra = {}) {
  const calls = [], delays = [], reservations = [];
  const result = await invokeWithRetry({ request, invoke: async arg => { calls.push(arg); return responses.shift(); },
    reserve: async () => { reservations.push(calls.length); }, sleep: async ms => delays.push(ms), ...extra });
  return { result, calls, delays, reservations };
}
test('retry: schema-invalid gets one identical request, then fails; empty valid output is never quality-retried', async () => {
  for (const terminal of [success, { status: 'schema_invalid' }]) {
    const f = await run([{ status: 'schema_invalid' }, terminal, success]);
    assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0], f.calls[1]);
    assert.equal(f.result.status, terminal.status); assert.equal(f.reservations.length, 2);
  }
  assert.equal((await run([success, success])).calls.length, 1);
});
test('retry: authentication, limits and ambiguous terminals are never retried', async () => {
  for (const response of [{ status: 'blocked', blockedReason: 'rate_limit' }, { status: 'blocked', blockedReason: 'auth' },
    { status: 'unknown' }, { status: 'transport_error' }, { status: 'transport_error', receipt: { processStarted: true, outputBytes: 0 } }]) {
    const f = await run([response, success]); assert.equal(f.calls.length, 1); assert.equal(f.result.status, 'blocked');
  }
});
test('retry: positively unstarted transport gets one backed-off retry, never a chain across error classes', async () => {
  const response = { status: 'transport_error', receipt: { processStarted: false, invocationStarted: false, outputBytes: 0, zeroUsage: true } };
  const f = await run([response, success]); assert.equal(f.calls.length, 2); assert.deepEqual(f.delays, [1000]);
  const mixed = await run([response, { status: 'schema_invalid' }, success]); assert.equal(mixed.calls.length, 2); assert.equal(mixed.result.status, 'schema_invalid');
  for (const changed of [{ invocationStarted: true }, { processStarted: true }, { outputBytes: 1 }, { zeroUsage: false }, { zeroUsage: undefined }]) {
    const refused = await run([{ ...response, receipt: { ...response.receipt, ...changed } }, success]);
    assert.equal(refused.calls.length, 1); assert.equal(refused.result.status, 'blocked');
  }
});
test('retry: malformed correction is proven unstarted and actually changes the request once', async () => {
  const malformed = { status: 'malformed_invocation', receipt: { invocationStarted: false, processStarted: false, outputBytes: 0, zeroUsage: true } };
  const fixed = { ...request, prompt: 'structurally corrected synthetic material' };
  const good = await run([malformed, success], { correct: async () => fixed });
  assert.equal(good.calls.length, 2); assert.deepEqual(good.calls[1], fixed);
  for (const extra of [{}, { correct: async () => request }]) {
    const f = await run([malformed, success], extra); assert.equal(f.calls.length, 1); assert.equal(f.result.status, 'blocked');
  }
  const ambiguous = await run([{ ...malformed, receipt: { invocationStarted: false } }, success], { correct: async () => fixed });
  assert.equal(ambiguous.calls.length, 1);
});
test('retry: reservations precede every invocation and refusal never invokes; exceptions block', async () => {
  let invoked = false;
  const f = await run([success], { reserve: async () => { throw Object.assign(new Error('budget'), { code: 'window_calls' }); }, invoke: async () => { invoked = true; } });
  assert.equal(invoked, false); assert.equal(f.result.blockedReason, 'window_calls');
  assert.equal((await run([], { invoke: async () => { throw new Error('unrecognised'); } })).result.status, 'blocked');
});
test('retry: cancellation after await suppresses retries and late result', async () => {
  const controller = new AbortController();
  const f = await run([], { signal: controller.signal, invoke: async () => { controller.abort(); return success; } });
  assert.equal(f.result.blockedReason, 'drain_stopped');
  const before = await run([success], { signal: controller.signal }); assert.equal(before.calls.length, 0);
});
