import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';

// End-to-end through the real MCP server in compact mode, not the core API,
// because the gap being closed was specifically that the compact SURFACE had no
// acknowledgement route. A core-level test would have passed all along and
// proved nothing.

function client(file) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    env: { ...process.env, SHADOWGRAPH_MCP_COMPACT: '1', SHADOWGRAPH_FILE: file },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  let nextId = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId += 1;
    pending.set(id, resolve);
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timed out: ${method}`)); }, 10_000);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const message = await send('tools/call', { name, arguments: args });
    assert.ok(!message.error, `${name} failed: ${JSON.stringify(message.error)}`);
    return JSON.parse(message.result.content[0].text);
  };
  return { child, send, call, stop: () => child.kill() };
}

// Two independent decisions, so "the acknowledgement held" and "a new breach
// still surfaces" can be asserted without one interfering with the other.
//
// A signal is identified by (decisionId, reason). Adding a second breach to the
// SAME decision changes its reason, which is a different -- broader -- signal,
// so that case would not test suppression at all. It is covered separately
// below.
const latencyDecision = {
  project: 'p',
  title: 'Serve reads from the local replica',
  chosen: 'local-replica',
  alternatives: [{
    label: 'primary-only',
    reasonRejected: 'replica latency was acceptable',
    reopenWhen: [{ key: 'replicaLagMs', operator: 'greater_than', value: 500, unit: 'ms' }]
  }]
};
const regionDecision = {
  project: 'p',
  title: 'Pin the write primary to us-east',
  chosen: 'us-east-primary',
  alternatives: [{
    label: 'multi-region-writes',
    reasonRejected: 'single-region writes were sufficient',
    reopenWhen: [{ key: 'region', operator: 'equals', value: 'eu-west' }]
  }]
};

test('compact can list a review, acknowledge it, keep that across restart, and still see a new breach', async (t) => {
  const dir = await scratchDirectory(t, 'shadowgraph-compact-ack-');
  const file = join(dir, 'data.json');

  // --- the surface actually offers both halves of the loop ----------------
  const first = client(file);
  t.after(() => first.stop());
  const listed = await first.send('tools/list', {});
  const names = listed.result.tools.map((tool) => tool.name);
  assert.equal(names.length, 13);
  assert.ok(names.includes('shadowgraph_context'), 'listing route');
  assert.ok(names.includes('shadowgraph_ack_review'), 'acknowledgement route');

  await first.call('shadowgraph_record_decision', latencyDecision);
  await first.call('shadowgraph_record_decision', regionDecision);
  await first.call('shadowgraph_record_fact', { project: 'p', key: 'replicaLagMs', value: '900ms', sourceClass: 'measured' });

  // --- list: context carries the identifier the ack tool needs ------------
  const view = await first.call('shadowgraph_context', { project: 'p' });
  assert.equal(view.openReviews.length, 1);
  const [review] = view.openReviews;
  assert.ok(review.reviewSignalId, 'the id is reachable from the compact listing route');
  assert.equal(review.reviewSignalStatus, 'open');
  assert.equal(review.violatedConditions[0].key, 'replicaLagMs');

  // --- acknowledge --------------------------------------------------------
  const acknowledged = await first.call('shadowgraph_ack_review', { id: review.reviewSignalId });
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(acknowledged.id, review.reviewSignalId);
  first.stop();

  // --- restart: the acknowledgement survives ------------------------------
  const second = client(file);
  t.after(() => second.stop());
  const afterRestart = await second.call('shadowgraph_context', { project: 'p' });
  const sameReview = afterRestart.openReviews.find((item) => item.reviewSignalId === review.reviewSignalId);
  assert.ok(sameReview, 'the same signal is still identified after restart');
  assert.equal(sameReview.reviewSignalStatus, 'acknowledged', 'the acknowledgement persisted across a restart');

  // --- a genuinely new applicable breach is NOT suppressed ----------------
  await second.call('shadowgraph_record_fact', { project: 'p', key: 'region', value: 'eu-west', sourceClass: 'human' });
  const afterNewBreach = await second.call('shadowgraph_context', { project: 'p' });
  const fresh = afterNewBreach.openReviews.filter((item) => item.reviewSignalStatus === 'open');
  assert.equal(fresh.length, 1, 'the new breach raises its own open signal');
  assert.notEqual(fresh[0].reviewSignalId, review.reviewSignalId, 'and it is a different signal, not the acknowledged one reopened');
  assert.match(fresh[0].reason, /region/);

  // The earlier acknowledgement was not disturbed by the new breach.
  const stillAcknowledged = afterNewBreach.openReviews.find((item) => item.reviewSignalId === review.reviewSignalId);
  assert.ok(stillAcknowledged, 'the acknowledged review is still listed');
  assert.equal(stillAcknowledged.reviewSignalStatus, 'acknowledged');

  // --- and the loop can be closed again -----------------------------------
  const secondAck = await second.call('shadowgraph_ack_review', { id: fresh[0].reviewSignalId });
  assert.equal(secondAck.status, 'acknowledged');
  const settled = await second.call('shadowgraph_context', { project: 'p' });
  assert.equal(settled.openReviews.filter((item) => item.reviewSignalStatus === 'open').length, 0, 'nothing is left unacknowledged');
});

test('acknowledging one breach does not mute a broader breach on the same decision', async (t) => {
  const dir = await scratchDirectory(t, 'shadowgraph-compact-broaden-');
  const file = join(dir, 'data.json');
  const mcp = client(file);
  t.after(() => mcp.stop());

  // One decision, two conditions. A signal is keyed by (decisionId, reason), so
  // when the second condition also fires the reason broadens and that is a
  // different signal -- an acknowledgement of the narrow breach must not cover it.
  await mcp.call('shadowgraph_record_decision', {
    project: 'p',
    title: 'Serve reads from the local replica',
    chosen: 'local-replica',
    alternatives: [{
      label: 'primary-only',
      reasonRejected: 'replica latency was acceptable',
      reopenWhen: [
        { key: 'replicaLagMs', operator: 'greater_than', value: 500, unit: 'ms' },
        { key: 'region', operator: 'equals', value: 'eu-west' }
      ]
    }]
  });
  await mcp.call('shadowgraph_record_fact', { project: 'p', key: 'replicaLagMs', value: '900ms', sourceClass: 'measured' });

  const narrow = (await mcp.call('shadowgraph_context', { project: 'p' })).openReviews[0];
  assert.equal(narrow.reason, 'replicaLagMs');
  await mcp.call('shadowgraph_ack_review', { id: narrow.reviewSignalId });

  await mcp.call('shadowgraph_record_fact', { project: 'p', key: 'region', value: 'eu-west', sourceClass: 'human' });
  const broadened = (await mcp.call('shadowgraph_context', { project: 'p' })).openReviews;
  assert.equal(broadened.length, 1);
  assert.equal(broadened[0].reason, 'replicaLagMs, region', 'the reason broadened');
  assert.notEqual(broadened[0].reviewSignalId, narrow.reviewSignalId);
  assert.equal(broadened[0].reviewSignalStatus, 'open', 'so it is unacknowledged and visible');
  assert.equal(broadened[0].violatedConditions.length, 2);
});
