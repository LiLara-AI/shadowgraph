// One bounded item. No production trigger until PR41 and approved AG3.
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { createStorage } from '../storage.js';
import { createShadowGraph } from '../shadowgraph.js';
import { EXTRACTION_MODEL } from '../extractor.js';
import { isValidIsoInstant } from '../fact-validity.js';
import { repositoryOf } from './owner-files.js';
import { attachDeletionView, readLedger, storeIo } from './deletion-knowledge.js';
import { claimAuthorityInvalid, effectiveGeneration } from './capture-generation.js';
import { captureRawExpired } from './capture-retention.js';
import { privilegedClaimCapture, privilegedCompleteExtraction, privilegedExtractionStatus, privilegedLiveSnapshot, privilegedSettleExtraction, privilegedSnapshot } from './snapshot.js';
import { EXTRACTION_SCHEMA, OUTPUT_SCHEMA_VERSION, PROMPT_VERSION, extractionPrompt, extractionText, prepareExtraction } from './extraction-output.js';
import { FROZEN_WORKER_BUDGETS, withWorkerBudget } from './extraction-budget.js';
import { invokeWithRetry, awaitWorkerStep } from './extraction-policy.js';
import { sessionJournalEntries, workerReason } from './extraction-session.js';
import { registerInvocation } from './extraction-identity.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const refusal = code => { throw Object.assign(new Error(`Extraction refused (${code})`), { code }); };
const clock = options => { const at = (options.now ?? (() => new Date().toISOString()))(); if (!isValidIsoInstant(at)) refusal('capture_clock_invalid'); return at; };
const owns = (item, options) => options.project ? item.attribution === 'project' && item.project === options.project
  : item.attribution === 'unattributed' && item.originId === options.originId;
const raw = (payload, item) => (payload.captureContent ?? []).find(entry => entry.contentRef === item.contentRef)?.text;

async function fenced(options, action) {
  const check = () => { if (options.signal?.aborted) refusal('drain_stopped'); };
  check();
  if (!isAbsolute(options.file) || await repositoryOf(options.file)) refusal('capture_store_inside_repository');
  if (!(typeof options.project === 'string' && options.project.trim()) && !(typeof options.originId === 'string' && options.originId.trim())) refusal('capture_scope_required');
  const store = await awaitWorkerStep(() => (options.openStore ?? createStorage)(options), options.signal, late => late.close());
  try {
    check();
    const io = storeIo(store);
    return await io.run(async ({ read, commit }) => {
      check();
      const payload = await read(); if (!payload) return { status: 'idle' };
      check();
      await attachDeletionView(payload, io.file, { env: io.env, pending: 'refuse' });
      const at = clock(options), ledger = await readLedger(io.file);
      check();
      const graph = createShadowGraph({ now: () => at }); graph.importData(payload);
      return action({ payload, graph, ledger, at, commit: async next => {
        if (options.guard && !await awaitWorkerStep(options.guard, options.signal)) refusal('drain_stopped');
        check(); return commit(next);
      } });
    });
  } finally { store.close(); }
}

export async function claimCapture(options) {
  return fenced(options, async ({ graph, ledger, at, commit }) => {
    const live = privilegedLiveSnapshot(graph);
    const queue = live.records.filter(item => item.kind === 'capture' && owns(item, options)
      && ['pending', 'processing'].includes(item.state) && !item.cancelRequested
      && !captureRawExpired(item, ledger?.retentionOverrides ?? [], at));
    // Journal order survives wall-clock reversal. Imported/baselined work with
    // no unique creation witness cannot be ordered by inventing a timestamp or
    // occurrence-ordinal substitute; leave it untouched and fail closed.
    const order = new Map(), wanted = new Set(queue.map(item => item.id));
    for (const entry of live.journal ?? []) if (entry.type === 'capture.recorded' && wanted.has(entry.entityId)) {
      if (order.has(entry.entityId) || !Number.isSafeInteger(entry.seq) || entry.seq <= 0) refusal('capture_order_unavailable');
      order.set(entry.entityId, entry.seq);
    }
    if (queue.some(item => !order.has(item.id)) || new Set(order.values()).size !== order.size) refusal('capture_order_unavailable');
    queue.sort((a, b) => order.get(a.id) - order.get(b.id));
    const sessions = new Set();
    for (const item of queue) {
      // Pending alone is not an owner reprocessing request. Require the
      // explicit local request and its journal witness before any invocation.
      if (item.reprocessRequest !== undefined) {
        const request = item.reprocessRequest;
        if (!request || Object.keys(request).sort().join(',') !== 'actor,at,id,surface'
          || request.actor !== 'owner' || request.surface !== 'cli' || typeof request.id !== 'string' || !request.id
          || !isValidIsoInstant(request.at) || !live.journal.some(entry => entry.type === 'capture.state_changed'
            && entry.entityId === item.id && entry.payload?.state === 'pending' && entry.payload.lease === null
            && ['id', 'at', 'actor', 'surface'].every(key => entry.payload.reprocessRequest?.[key] === request[key]))) {
          refusal('capture_reprocessing_unsupported');
        }
      }
      const session = JSON.stringify([item.originId, item.source.sessionId]);
      if (sessions.has(session)) continue; sessions.add(session);
      if (item.state === 'processing' && Date.parse(item.lease?.leaseExpiresAt) > Date.parse(at)) continue;
      const source = raw(live, item); if (typeof source !== 'string') continue;
      const text = extractionText(source); if (!text.trim()) continue;
      const leaseMs = options.leaseMs ?? 180000;
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 300000) refusal('capture_lease_invalid');
      const lease = { leaseId: randomUUID(), ownerId: options.ownerId ?? `worker-${process.pid}`, ownerBootId: options.ownerBootId ?? randomUUID(),
        leaseExpiresAt: new Date(Date.parse(at) + leaseMs).toISOString(), ...(options.accessId ? { accessId: options.accessId } : {}) };
      const selected = { ...item, lease };
      if (claimAuthorityInvalid(selected, live, at)) continue;
      const generation = effectiveGeneration(selected, ledger, live, at);
      options.beforeClaim?.({ inputBytes: Buffer.byteLength(extractionPrompt(item, text)), journalEntries: sessionJournalEntries(live.journal, item) + 2 });
      const claimed = privilegedClaimCapture(graph, { id: item.id, project: options.project, originId: options.originId, lease });
      if (!claimed) continue;
      await commit(privilegedSnapshot(graph));
      const token = item.erasureToken;
      return { status: 'claimed', id: item.id, token, leaseId: lease.leaseId, lease: structuredClone(lease), generation, rawHash: digest(text), text,
        item: claimed, promptVersion: PROMPT_VERSION, schemaVersion: OUTPUT_SCHEMA_VERSION, model: EXTRACTION_MODEL };
    }
    return { status: 'idle' };
  });
}

export async function commitCapture(options, claim, response) {
  return fenced(options, async ({ graph, ledger, at, commit }) => {
    const live = privilegedLiveSnapshot(graph), item = live.records.find(value => value.kind === 'capture' && value.id === claim.id);
    const settle = async reason => {
      const result = privilegedSettleExtraction(graph, { id: claim.id, leaseId: claim.leaseId, reason, attemptCount: options.attemptCount, blockedReason: response?.blockedReason });
      await commit(privilegedSnapshot(graph)); return result;
    };
    if (!item || !owns(item, options) || item.state !== 'processing' || item.cancelRequested || item.lease?.leaseId !== claim.leaseId
      || item.erasureToken !== claim.token || ['leaseId', 'ownerId', 'ownerBootId', 'leaseExpiresAt', 'accessId'].some(key => item.lease[key] !== claim.lease?.[key])
      || Date.parse(item.lease.leaseExpiresAt) <= Date.parse(at) || captureRawExpired(item, ledger?.retentionOverrides ?? [], at)
      || claimAuthorityInvalid(item, live, at) || effectiveGeneration(item, ledger, live, at) !== claim.generation
      || typeof raw(live, item) !== 'string' || digest(extractionText(raw(live, item))) !== claim.rawHash) return settle('superseded_result');
    if (response?.status !== 'success') return settle(response?.status === 'worker_blocked' ? 'worker_blocked' : response?.status === 'schema_invalid' ? 'schema_invalid' : response?.status === 'blocked' ? 'executor_blocked' : 'executor_failed');
    if (response.receipt?.invocationStarted !== true || response.receipt.model !== EXTRACTION_MODEL) return settle('executor_failed');
    let prepared;
    try { prepared = prepareExtraction(item, extractionText(raw(live, item)), response.value); }
    catch (error) { if (error.code !== 'extraction_schema_invalid') throw error; return settle('schema_invalid'); }
    const key = digest(JSON.stringify([item.id, claim.generation, PROMPT_VERSION, OUTPUT_SCHEMA_VERSION, EXTRACTION_MODEL]));
    // A receipt contains declared method/configuration and numeric usage only.
    const receipt = { promptVersion: PROMPT_VERSION, schemaVersion: OUTPUT_SCHEMA_VERSION, model: EXTRACTION_MODEL,
      at, generation: claim.generation, invocationStarted: response.receipt?.invocationStarted === true,
      usage: Object.fromEntries(Object.entries(response.receipt?.usage ?? {}).filter(([name, value]) => ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'].includes(name) && Number.isSafeInteger(value) && value >= 0)) };
    let result;
    try { result = privilegedCompleteExtraction(graph, { id: item.id, leaseId: claim.leaseId, prepared, key, receipt, attemptCount: options.attemptCount, journalCeiling: options.journalCeiling }); }
    catch (error) { if (error.code !== 'session_journal') throw error; response = { blockedReason: 'session_journal' }; return settle('worker_blocked'); }
    await commit(privilegedSnapshot(graph));
    return result;
  });
}

export async function runExtractionItem(options) {
  const claim = await claimCapture(options); if (claim.status !== 'claimed') return claim;
  let response;
  try { response = await options.executor.invoke({ prompt: extractionPrompt(claim.item, claim.text), schema: EXTRACTION_SCHEMA }); }
  catch { response = { status: 'failed' }; }
  return commitCapture(options, claim, response);
}

async function claimIsCurrent(options, claim) {
  return fenced(options, ({ graph, ledger, at }) => {
    const live = privilegedLiveSnapshot(graph), item = live.records.find(value => value.id === claim.id && value.kind === 'capture');
    return Boolean(item && owns(item, options) && item.state === 'processing' && !item.cancelRequested && item.erasureToken === claim.token
      && ['leaseId', 'ownerId', 'ownerBootId', 'leaseExpiresAt', 'accessId'].every(key => item.lease?.[key] === claim.lease[key])
      && Date.parse(item.lease.leaseExpiresAt) > Date.parse(at) && !claimAuthorityInvalid(item, live, at)
      && !captureRawExpired(item, ledger?.retentionOverrides ?? [], at) && effectiveGeneration(item, ledger, live, at) === claim.generation
      && typeof raw(live, item) === 'string' && digest(extractionText(raw(live, item))) === claim.rawHash);
  });
}

async function recordWorkerStatus(options, reason) {
  return fenced(options, async ({ graph, commit }) => {
    if (!privilegedExtractionStatus(graph, { project: options.project, originId: options.originId, reason })) return false;
    await commit(privilegedSnapshot(graph)); return true;
  });
}

// Internal bounded drain. PR41 supplies activation/deactivation checks and the
// production trigger; synthetic callers here never imply real-host approval.
export async function runExtractionDrain(options) {
  const controller = new AbortController(), budgets = options.budgets ?? FROZEN_WORKER_BUDGETS;
  const stop = () => controller.abort(); options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const timer = setTimeout(stop, Number.isSafeInteger(budgets.wallMs) && budgets.wallMs > 0 ? Math.min(budgets.wallMs, FROZEN_WORKER_BUDGETS.wallMs) : 1);
  const signal = controller.signal;
  const scopes = options.scopes ?? [{ project: options.project, originId: options.originId }];
  let scopeIndex = 0;
  const selectScope = () => { const scope = scopes[scopeIndex]; options = { ...options, project: scope?.project, originId: scope?.originId }; };
  selectScope();
  let completed = 0, claimed = null, attempts = 0;
  const blocked = async reason => {
    reason = workerReason(reason);
    const cleanup = { ...options, guard: undefined, signal: AbortSignal.timeout(1000), lockTimeoutMs: Math.min(options.lockTimeoutMs ?? 1000, 1000) };
    if (claimed) {
      await commitCapture({ ...cleanup, attemptCount: attempts }, claimed, { status: 'worker_blocked', blockedReason: reason });
      claimed = null;
    }
    const storeReceiptWritten = await recordWorkerStatus(cleanup, reason);
    return { status: 'blocked', blockedReason: reason, completed, storeReceiptWritten };
  };
  try {
    if (!Array.isArray(scopes) || scopes.some(scope => !scope || Boolean(scope.project) === Boolean(scope.originId)
      || (scope.project !== undefined && (typeof scope.project !== 'string' || !scope.project.trim()))
      || (scope.originId !== undefined && (typeof scope.originId !== 'string' || !scope.originId.trim())))) refusal('capture_scope_required');
    if (!scopes.length) return { status: 'idle', completed: 0 };
    return await withWorkerBudget({ ...options, now: () => Date.parse(clock(options)), signal }, async budget => {
      for (;;) {
        budget.check(); if (options.guard && !await awaitWorkerStep(options.guard, signal)) return blocked('drain_stopped'); budget.check();
        claimed = await claimCapture({ ...options, signal, leaseMs: 300000, beforeClaim: input => budget.admit(input) });
        if (claimed.status !== 'claimed') {
          claimed = null;
          const storeReceiptWritten = await recordWorkerStatus({ ...options, signal }, null);
          if (++scopeIndex < scopes.length) { selectScope(); continue; }
          return { status: 'idle', completed, storeReceiptWritten };
        }
        attempts = 0;
        const correlationToken = `sgcorr_${randomUUID()}`;
        const response = await invokeWithRetry({ request: { prompt: extractionPrompt(claimed.item, claimed.text), schema: EXTRACTION_SCHEMA }, signal, sleep: options.sleep,
          reserve: () => budget.reserve(), invoke: async request => {
            budget.check();
            if (options.guard && !await awaitWorkerStep(options.guard, signal) || !await claimIsCurrent({ ...options, signal }, claimed)) return { status: 'blocked', blockedReason: 'drain_stopped' };
            budget.check();
            const identity = { invocationId: randomUUID(), correlationToken, leaseId: claimed.leaseId, from: clock(options), to: claimed.lease.leaseExpiresAt };
            await registerInvocation(identity, { env: options.env, now: () => Date.parse(clock(options)) });
            budget.check();
            if (options.guard && !await awaitWorkerStep(options.guard, signal)) return { status: 'blocked', blockedReason: 'drain_stopped' };
            budget.check(); attempts += 1;
            return options.executor.extract({ ...request, signal, identity });
          } });
        if (response.status === 'blocked') return blocked(response.blockedReason);
        budget.check(); if (options.guard && !await awaitWorkerStep(options.guard, signal)) return blocked('drain_stopped'); budget.check();
        const result = await commitCapture({ ...options, signal, attemptCount: attempts, journalCeiling: budget.budgets.journalEntriesPerSession }, claimed, response);
        claimed = null;
        if (result.status === 'worker_blocked') return blocked('session_journal');
        if (result.status === 'committed') completed += 1;
      }
    });
  } catch (error) {
    if (signal.aborted) {
      try { return await blocked('drain_stopped'); } catch { return { status: 'blocked', blockedReason: 'drain_stopped', completed, storeReceiptWritten: false }; }
    }
    if (['input_bytes', 'session_journal', 'drain_items', 'drain_calls', 'window_calls', 'drain_time', 'drain_stopped', 'worker_usage_unavailable', 'worker_clock_invalid', 'worker_budgets_invalid'].includes(error.code)) {
      try { return await blocked(error.code); } catch { /* failed medium cannot hold a receipt */ }
    }
    return { status: 'unavailable', reason: 'worker_or_store_unavailable', completed, storeReceiptWritten: false };
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); }
}
