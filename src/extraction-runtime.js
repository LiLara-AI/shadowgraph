// One-shot owner CLI worker. Hooks spawn this path, never import its executor.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createExtractor } from './extractor.js';
import { activeCapture } from './capture-hook.js';
import { readStoreForDelivery } from './delivery.js';
import { pinnedRuntime } from './host-hooks.js';
import { createShadowGraph } from './shadowgraph.js';
import { accessContext, discoverWorkspace } from './internal/access-transport.js';
import { canonicalPath, repositoryOf } from './internal/owner-files.js';
import { activeExtraction, workerFence, workerSettlement, recordWorkerSettlement } from './internal/extraction-state.js';
import { runExtractionDrain } from './internal/extraction-worker.js';
import { awaitWorkerStep } from './internal/extraction-policy.js';
import { FROZEN_WORKER_BUDGETS } from './internal/extraction-budget.js';

const covered = (capture, project) => capture.coverage.projects === 'only' ? capture.coverage.include.includes(project) : !capture.coverage.exclude.includes(project);
const blocked = blockedReason => ({ status: 'blocked', blockedReason, completed: 0 });
export async function runActivatedExtraction({ env = process.env, project, originId, automatic = false, cwd = process.cwd(), signal, now,
  runtimeDirectory = dirname(dirname(fileURLToPath(import.meta.url))), executorFactory = createExtractor } = {}) {
  const activation = await activeExtraction(env);
  if (!activation) return { status: 'inactive', completed: 0 };
  if (await canonicalPath(runtimeDirectory) !== activation.runtime.path) return blocked('runtime_mismatch');
  if ((project !== undefined && (typeof project !== 'string' || !project.trim())) || (originId !== undefined && (typeof originId !== 'string' || !originId.trim()))
    || (project !== undefined && originId !== undefined) || (automatic && (project !== undefined || originId !== undefined))) return blocked('capture_scope_required');
  const capture = await activeCapture(env);
  if (!capture) return blocked('capture_inactive');
  if (await repositoryOf(activation.store.file)) return blocked('capture_store_inside_repository');
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const deadline = setTimeout(abort, FROZEN_WORKER_BUDGETS.wallMs);
  let monitor, checking = false;
  const guard = async () => !controller.signal.aborted && isDeepStrictEqual(await activeExtraction(env), activation) && isDeepStrictEqual(await activeCapture(env), capture);
  try {
    return await (await workerFence(env)).run(async () => {
      if (!await guard()) return blocked('drain_stopped');
      if (await workerSettlement(env) !== 'clear') return blocked('worker_settlement_unconfirmed');
      const pinned = await awaitWorkerStep(() => pinnedRuntime(runtimeDirectory), controller.signal);
      if (!pinned.extraction || pinned.commit !== activation.runtime.commit || pinned.tree !== activation.runtime.tree || pinned.tarballSha256 !== activation.runtime.tarballSha256) return blocked('runtime_mismatch');
      monitor = setInterval(() => {
        if (checking) return;
        checking = true;
        void guard().then(ok => { if (!ok) abort(); }, abort).finally(() => { checking = false; });
      }, 100);
      const read = await awaitWorkerStep(() => readStoreForDelivery(activation.store), controller.signal);
      if (!read.payload || read.unavailable) return blocked('store_unavailable');
      let scopes;
      if (automatic) {
        const projects = [];
        for (const item of read.payload.records ?? []) if (item?.kind === 'capture' && ['pending', 'processing'].includes(item.state)
          && item.attribution === 'project' && covered(capture, item.project) && !projects.includes(item.project)) projects.push(item.project);
        scopes = projects.map(project => ({ project }));
      } else {
        if (project === undefined && originId === undefined) {
          const graph = createShadowGraph(); graph.importData(read.payload);
          const workspace = await awaitWorkerStep(() => discoverWorkspace(cwd), controller.signal);
          project = accessContext(graph, {}, 'cli', workspace, { confirmedByStore: true }).binding?.project;
          if (!project) return blocked('capture_scope_required');
        }
        scopes = [{ ...(project !== undefined ? { project } : { originId }) }];
      }
      const executor = executorFactory({ executable: activation.executor.executable, env, expectedReceipt: activation.executor, supervision: { env, activationId: activation.activationId } });
      const running = new Set(); let result, began = false, uncertain = false;
      try {
        result = await runExtractionDrain({ type: activation.store.storage, file: activation.store.file, env, scopes,
          budgets: FROZEN_WORKER_BUDGETS, guard, now, signal: controller.signal, lockTimeoutMs: 1000,
          executor: { extract: request => {
            const pending = Promise.resolve().then(async () => {
              await recordWorkerSettlement(env, 'preparing', activation.activationId); began = true;
              if (!await guard() || request.signal.aborted) return { status: 'blocked', blockedReason: 'drain_stopped' };
              const response = await executor.extract(request);
              if (response?.receipt?.localChildStopped === false) uncertain = true;
              return response;
            }); running.add(pending);
            void pending.then(() => running.delete(pending), () => running.delete(pending)); return pending;
          } } });
      } finally {
        abort(); // The lifetime fence includes bounded child settlement.
        if (running.size) {
          let timer;
          await Promise.race([Promise.allSettled([...running]), new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
          clearTimeout(timer);
        }
        uncertain ||= running.size > 0 || executor.localChildStopped === false;
        if (began) await recordWorkerSettlement(env, uncertain ? 'unconfirmed' : 'stopped', activation.activationId);
      }
      return uncertain ? { ...result, cleanup: { status: 'deferred', reason: 'executor_settlement_unconfirmed' } } : result;
    });
  } catch { return blocked(controller.signal.aborted ? 'drain_stopped' : 'worker_unavailable'); }
  finally { clearTimeout(deadline); clearInterval(monitor); signal?.removeEventListener('abort', abort); }
}
