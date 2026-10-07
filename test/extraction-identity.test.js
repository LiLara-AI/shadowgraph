import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCaptureSource } from '../src/internal/capture-source.js';
const from = '2026-10-04T00:00:00.000Z', to = '2026-10-04T00:05:00.000Z';
const invocation = { invocationId: 'dedicated-worker-session', leaseId: 'own-lease', from, to };
const event = { event: 'Stop', sessionId: invocation.invocationId, prompt: 'Synthetic observation.' };
const captured = { selfEvent: false, sourceIdentity: 'unattributed_observer' };

test('worker identity: only a recorded invocation within its lease window is S3', () => {
  const context = { workerInvocations: [invocation], observedAt: from };
  assert.deepEqual(classifyCaptureSource(event, context), { selfEvent: true, signal: 'S-3' });
  for (const observedAt of ['2026-10-03T23:59:59.999Z', to, undefined, 'invalid']) {
    assert.deepEqual(classifyCaptureSource(event, { ...context, observedAt }), captured);
  }
  for (const row of [{ ...invocation, leaseId: '' }, { ...invocation, to: from }, { ...invocation, invocationId: 'other' }, null]) {
    assert.deepEqual(classifyCaptureSource(event, { ...context, workerInvocations: [row] }), captured);
  }
});
test('worker identity: legacy session lists and user-session tool matches cannot exclude user work', () => {
  assert.deepEqual(classifyCaptureSource(event, { workerSessionIds: [event.sessionId], observedAt: from }), captured);
  assert.deepEqual(classifyCaptureSource({ ...event, sessionId: 'user-session', toolCallId: invocation.invocationId }, { workerInvocations: [invocation], observedAt: from }), captured);
  assert.deepEqual(classifyCaptureSource(event, { workerInvocations: 'dedicated-worker-session', observedAt: from }), captured);
});

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
const identityModule = () => import('../src/internal/extraction-identity.js');
async function setup(t) {
  const root = await scratchDirectory(t);
  const options = { env: { SHADOWGRAPH_HOME: root }, now: () => Date.parse(from) };
  const row = { invocationId: randomUUID(), leaseId: randomUUID(), correlationToken: `sgcorr_${randomUUID()}`, from, to };
  return { root, options, row, api: await identityModule() };
}
test('identity registry: durable content-free registration precedes attributable events', async t => {
  const f = await setup(t), { registerInvocation, readInvocationContext, identityFile } = f.api;
  assert.deepEqual((await readInvocationContext(f.options)).workerInvocations, []);
  await registerInvocation(f.row, f.options);
  const context = await readInvocationContext(f.options);
  assert.deepEqual(context.workerInvocations, [f.row]);
  assert.deepEqual(classifyCaptureSource({ ...event, sessionId: f.row.invocationId }, context), { selfEvent: true, signal: 'S-3' });
  assert.deepEqual(classifyCaptureSource({ ...event, sessionId: 'user', prompt: f.row.correlationToken }, context), { selfEvent: true, signal: 'S-2' });
  const stored = JSON.parse(await readFile(identityFile(f.options.env)));
  assert.deepEqual(Object.keys(stored).sort(), ['invocations', 'version']);
  assert.deepEqual(Object.keys(stored.invocations[0]).sort(), ['correlationToken', 'from', 'invocationId', 'leaseId', 'to']);
  await assert.rejects(registerInvocation(f.row, f.options), { code: 'worker_identity_duplicate' });
  const later = { ...f.options, now: () => Date.parse(to) };
  assert.deepEqual((await readInvocationContext(later)).workerInvocations, []);
  assert.deepEqual((await readInvocationContext(later)).correlationTokens, []);
  const next = { ...f.row, invocationId: randomUUID(), from: to, to: '2026-10-04T00:10:00.000Z' };
  await registerInvocation(next, later);
  assert.deepEqual(JSON.parse(await readFile(identityFile(f.options.env))).invocations, [next]);
});
test('identity registry: corrupt or aliased evidence cannot suppress capture or admit an invocation', async t => {
  const f = await setup(t), { registerInvocation, readInvocationContext, identityFile } = f.api;
  const file = identityFile(f.options.env);
  for (const content of ['{}', JSON.stringify({ version: 1, invocations: [{ ...f.row, prompt: 'must never persist' }] }), 'x'.repeat(65537)]) {
    await writeFile(file, content);
    const context = await readInvocationContext(f.options);
    assert.equal(context.available, false);
    assert.deepEqual(classifyCaptureSource({ ...event, sessionId: f.row.invocationId }, context), captured);
    await assert.rejects(registerInvocation(f.row, f.options), { code: 'worker_identity_unavailable' });
    assert.equal(await readFile(file, 'utf8'), content);
  }
  await writeFile(file, JSON.stringify({ version: 1, invocations: [] }));
  await link(file, join(f.root, 'alias'));
  await assert.rejects(registerInvocation(f.row, f.options), { code: 'worker_identity_unavailable' });
  assert.equal((await readInvocationContext(f.options)).available, false);
});
test('identity registry: invalid windows, identifiers and excess live rows are refused', async t => {
  const f = await setup(t), { registerInvocation, identityFile } = f.api;
  for (const row of [{ ...f.row, to: from }, { ...f.row, to: '2026-10-04T00:05:00.001Z' }, { ...f.row, from: '2026-10-04T00:00:00.001Z' }, { ...f.row, invocationId: 'arbitrary-session' }, { ...f.row, correlationToken: 'raw material' }]) {
    await assert.rejects(registerInvocation(row, f.options), { code: 'worker_identity_invalid' });
  }
  const invocations = Array.from({ length: 128 }, () => ({ ...f.row, invocationId: randomUUID() }));
  await writeFile(identityFile(f.options.env), JSON.stringify({ version: 1, invocations }));
  await assert.rejects(registerInvocation(f.row, f.options), { code: 'worker_identity_full' });
  assert.equal(JSON.parse(await readFile(identityFile(f.options.env))).invocations.length, 128);
});
