import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createServer } from 'node:http';
import { startProviderMeter } from '../benchmark/lib/provider-meter.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createCampaignBudget, openCampaignBudget } from '../benchmark/lib/v11-campaign-budget.mjs';

const policy = {
  campaignId: 'offline-only', implementationLockHash: 'a'.repeat(64),
  maxRequests: 2, maxSessions: 2, maxRecoveryAttempts: 1,
  deadline: '2099-01-01T00:00:00.000Z',
  limits: { outer_decision_llm: 1, internal_memory_llm: 1, embedding: 1 }
};

test('campaign reservations survive fresh sessions and count in-flight calls without refunds', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-budget-'), 'campaign');
  await createCampaignBudget(root, policy);
  const first = await openCampaignBudget(root, policy);
  await assert.rejects(openCampaignBudget(root, policy), /locked/);
  await first.beginSession('probe-1');
  const results = await Promise.all([first.reserve('embedding'), first.reserve('embedding')]);
  assert.deepEqual(results, [true, false]);
  await first.close();
  const next = await openCampaignBudget(root, policy);
  await next.beginSession('fresh-run');
  assert.equal(await next.reserve('outer_decision_llm'), true);
  assert.equal(await next.reserve('internal_memory_llm'), false);
  await assert.rejects(next.beginSession('another-run'), /session/);
  await next.close();
});

test('campaign identity cannot be recreated or limits raised on reopen', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-identity-'), 'campaign');
  await createCampaignBudget(root, policy);
  await assert.rejects(createCampaignBudget(root, policy));
  await assert.rejects(openCampaignBudget(root, { ...policy, maxRequests: 100 }), /policy/);
});

test('campaign policy refuses a different official implementation identity before opening its ledger', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-lock-'), 'campaign');
  await createCampaignBudget(root, policy);
  await assert.rejects(openCampaignBudget(root, policy, { implementationLockHash: 'b'.repeat(64) }), /implementation lock/i);
});

test('meter denies dispatch when a shared campaign reservation is exhausted', async (t) => {
  const dir = await scratchDirectory(t, 'campaign-meter-');
  let received = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    received += 1; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'fixture', usage: { total_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const meter = await startProviderMeter({ listenerUrl: 'http://127.0.0.1:0',
    upstreamBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, upstreamAuthorization: null,
    ledgerPath: path.join(dir, 'provider.ndjson'), upstreamTimeoutMs: 1000 }, {
    campaignReserve: async () => false
  });
  t.after(() => meter.close());
  const endpoint = meter.bindEndpoint({ runId: 'fixture', attemptId: 'fixture-1', armId: 'no-memory',
    scenarioId: 'fixture', repetition: 0, phase: 'A', requestClass: 'outer_decision_llm' });
  const response = await fetch(`${endpoint}/chat/completions`, { method: 'POST', body: '{"model":"fixture"}' });
  await response.text();
  assert.equal(response.status, 403);
  assert.equal(received, 0);
});

test('recovery authorization is exhausted durably without refunding prior reservations', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-recovery-'), 'campaign');
  const bounded = { ...policy, maxSessions: 4 };
  await createCampaignBudget(root, bounded);
  const first = await openCampaignBudget(root, bounded);
  await first.beginSession('initial');
  assert.equal(await first.reserve('embedding'), true);
  await first.beginSession('recovery-1', { recovery: true });
  await first.close();
  const next = await openCampaignBudget(root, bounded);
  try {
    await assert.rejects(next.beginSession('recovery-2', { recovery: true }), /recovery/i);
    await next.beginSession('separate-probe');
    assert.equal(await next.reserve('embedding'), false);
  } finally { await next.close(); }
});

test('CLI refuses incomplete campaign configuration before creating run resources', async (t) => {
  const dir = await scratchDirectory(t, 'campaign-cli-');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../benchmark/cli.mjs', import.meta.url));
  for (const command of ['v11-preflight', 'v11-run']) {
    let result;
    try {
      result = await promisify(execFile)(process.execPath, [cli, command,
        '--campaign-root', path.join(dir, 'campaign'), '--out', path.join(dir, 'out')]);
    } catch (error) { result = error; }
    assert.equal(result.code, 1);
    assert.match(result.stderr, /campaign-policy.*campaign-root|campaign-root.*campaign-policy/);
  }
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(dir), []);
});

test('CLI rejects a complete but invalid campaign policy rather than ignoring it', async (t) => {
  const dir = await scratchDirectory(t, 'campaign-cli-invalid-');
  const policyPath = path.join(dir, 'policy.json');
  await writeFile(policyPath, '{}\n');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../benchmark/cli.mjs', import.meta.url));
  for (const command of ['v11-preflight', 'v11-run']) {
    let result;
    try {
      result = await promisify(execFile)(process.execPath, [cli, command,
        '--campaign-policy', policyPath, '--campaign-root', path.join(dir, 'campaign')]);
    } catch (error) { result = error; }
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid campaign policy/);
  }
});

test('campaign dates reject normalized impossible instants before creating evidence', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-calendar-'), 'campaign');
  await assert.rejects(createCampaignBudget(root, { ...policy, deadline: '2099-02-30T00:00:00.000Z' }), /Invalid campaign policy/);
});

test('expired campaign refuses reservations before dispatch', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-expiry-'), 'campaign');
  const expired = { ...policy, deadline: '2000-01-01T00:00:00.000Z' };
  await createCampaignBudget(root, expired);
  const ledger = await openCampaignBudget(root, expired);
  await assert.rejects(ledger.beginSession('run'), /expired/);
  assert.equal(await ledger.reserve('embedding'), false);
  await ledger.close();
});
