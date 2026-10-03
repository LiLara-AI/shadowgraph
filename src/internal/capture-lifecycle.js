// Owner CLI lifecycle only. No MCP/HTTP entry point and no manual-store
// fallback. Inspection is read-only; cancellation is terminal-confirmed.
import { readFile } from 'node:fs/promises';
import { createShadowGraph } from '../shadowgraph.js';
import { createStorage } from '../storage.js';
import { captureStoreForLifecycle, expireCaptureStore } from '../capture-hook.js';
import { accessContext, discoverWorkspace } from './access-transport.js';
import { confirmOwnerAction } from './owner-confirmation.js';
import { privilegedCancelCapture, privilegedDeleteCapture, privilegedInspectCapture, privilegedSnapshot } from './snapshot.js';
import { attachDeletionView, pendingUnsupported, readLedger, storeIo, writeLedger } from './deletion-knowledge.js';
import { RAW_RETENTION_DAYS, retentionOverridesIssue } from './capture-retention.js';

const USAGE = 'Usage: shadowgraph capture --hook | inspect [{"project": P, "id": ID}] | expire | cancel|delete {"project": P, "id": ID} | retention {"project": P, "days": N} (omit days to inspect)';
const fail = (code) => { throw Object.assign(new Error(`Capture lifecycle refused (${code})`), { code }); };

// Only the owner CLI reaches this control writer. Its caller has confirmed
// the exact project/window. There is no resolver and no payload save: the
// policy becomes effective at every reader as soon as the ledger commits.
export async function applyCaptureRetention(store, { project, days }, { expectedOverrides, beforeChange } = {}) {
  if (retentionOverridesIssue([{ project, days }])) fail('capture_retention_invalid');
  const io = storeIo(store);
  return io.run(async ({ read }) => {
    if ((await readLedger(io.file))?.pending.length) throw pendingUnsupported();
    const payload = await read();
    if (payload === null) fail('capture_cleanup_store_unavailable');
    await attachDeletionView(payload, io.file, { env: io.env, pending: 'refuse' });
    await beforeChange?.();
    const overrides = (await readLedger(io.file))?.retentionOverrides ?? [];
    if (expectedOverrides !== undefined && JSON.stringify(overrides) !== JSON.stringify(expectedOverrides)) fail('capture_retention_changed_while_confirming');
    if (overrides.find((entry) => entry.project === project)?.days === days) return { project, days, changed: false };
    await writeLedger(io.file, (next) => {
      const entries = next.retentionOverrides ?? [];
      next.retentionOverrides = entries.some((entry) => entry.project === project)
        ? entries.map((entry) => entry.project === project ? { ...entry, days } : entry)
        : [...entries, { project, days }];
    }, { env: io.env });
    return { project, days, changed: true, reExtraction: 'Expired raw cannot be used for later re-extraction. Longer retention does not extend an already recorded deadline.' };
  });
}

export async function captureLifecycle(verb, input = {}, { env = process.env, cwd = process.cwd() } = {}) {
  if (!['inspect', 'expire', 'cancel', 'delete', 'retention'].includes(verb) || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error(USAGE);
  const allowed = verb === 'expire' ? [] : verb === 'retention' ? ['project', 'days'] : ['project', 'originId', 'id'];
  if (Object.keys(input).some((key) => !allowed.includes(key)) || (['cancel', 'delete'].includes(verb) && (typeof input.id !== 'string' || !input.id.trim()))) throw new Error(USAGE);
  if (verb === 'expire') return expireCaptureStore({ env });
  const descriptor = await captureStoreForLifecycle(env);
  const workspace = await discoverWorkspace(cwd);
  const store = await createStorage({ type: descriptor.type, file: descriptor.file, env, mode: 0o600 });
  try {
    let selected, overrides;
    // A fenced no-op read refuses any pending deletion or restore and never
    // completes one, including while forming the owner's confirmation.
    await store.update(async (payload) => {
      const graph = createShadowGraph(); graph.importData(payload);
      selected = privilegedInspectCapture(graph, accessContext(graph, input, 'cli', workspace, { confirmedByStore: true }));
      if (verb === 'retention') overrides = (await readLedger(descriptor.file))?.retentionOverrides ?? [];
      return null;
    });
    if (verb === 'inspect') return selected;
    const unchangedActivation = async () => {
      if (await readFile(descriptor.record, 'utf8') !== descriptor.recordText) fail('capture_activation_changed_while_confirming');
    };
    if (verb === 'retention') {
      if (selected.scope.state !== 'project_selected') fail('capture_retention_project_required');
      const project = selected.scope.project;
      const previousDays = overrides.find((entry) => entry.project === project)?.days ?? RAW_RETENTION_DAYS;
      if (input.days === undefined) return { project, days: previousDays, defaultDays: RAW_RETENTION_DAYS };
      if (retentionOverridesIssue([{ project, days: input.days }])) fail('capture_retention_invalid');
      if (!(await confirmOwnerAction('Change capture raw retention', { store: descriptor.file, project, previousDays, days: input.days, effect: 'Eligible uncited raw, including quarantined raw, expires under this policy. Expired raw cannot be re-extracted. Longer retention never extends a recorded deadline.' }))) fail('owner_confirmation_required');
      return applyCaptureRetention(store, { project, days: input.days }, { expectedOverrides: overrides, beforeChange: unchangedActivation });
    }
    if (!(await confirmOwnerAction(verb === 'delete' ? 'Delete this captured work; earlier backups retain it' : 'Cancel this captured work', { store: descriptor.file, storage: descriptor.type, scope: selected.scope, items: selected.items }))) fail('owner_confirmation_required');
    let result;
    const change = async (payload) => {
      await unchangedActivation();
      const graph = createShadowGraph(); graph.importData(payload);
      const context = accessContext(graph, input, 'cli', workspace, { confirmedByStore: true });
      const current = privilegedInspectCapture(graph, context);
      if (JSON.stringify(current) !== JSON.stringify(selected)) fail('capture_item_changed_while_confirming');
      result = verb === 'delete' ? privilegedDeleteCapture(graph, context) : privilegedCancelCapture(graph, context);
      return verb === 'delete' || result.changed ? privilegedSnapshot(graph) : null;
    };
    if (verb === 'delete') {
      const io = storeIo(store);
      await io.run(async ({ read, commit }) => {
        const payload = await read();
        if (payload === null) fail('capture_cleanup_store_unavailable');
        await commit(await change(await attachDeletionView(payload, io.file, { env: io.env, pending: 'refuse' })));
      });
    } else await store.update(change);
    return result;
  } finally { store.close?.(); }
}
