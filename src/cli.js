#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createStorage } from './storage.js';
import { createShadowGraph } from './shadowgraph.js';
import { backupFile, restoreFile } from './backup.js';
import { createRestoreValidator } from './restore-validation.js';
import { syncMarkdownWorkspace } from './markdown-workspace.js';
import { downgradeStore, migrateStore } from './schema-conversion.js';
import { getRuntimeCapabilities } from './runtime-capabilities.js';
import { VERSION } from './version.js';
import { privilegedSnapshot } from './internal/snapshot.js';
import * as privileged from './internal/snapshot.js';
import { accessContext, bindWorkspaceProject, currentAccessOperation, discoverWorkspace, hasAccessReference } from './internal/access-transport.js';
import { confirmOwnerAction, ownerAnswer } from './internal/owner-confirmation.js';
import { changeHookSettings, defaultSettingsPath } from './host-hooks.js';

const [requestedCommand, ...arguments_] = process.argv.slice(2);
let command = ({ grant: 'issue-access', delegate: 'delegate-access' })[requestedCommand] ?? requestedCommand;
let rest = arguments_;
if (requestedCommand === 'access' && ['discard', 'revoke', 'status'].includes(rest[0])) {
  command = ({ discard: 'discard-access', revoke: 'revoke-access', status: 'access-status' })[rest[0]];
  rest = rest[0] === 'status' ? rest.slice(1) : [JSON.stringify({ accessId: rest[1] })];
} else if (['issue-access', 'delegate-access'].includes(command) && rest[0] === '--request' && rest.length === 2) {
  rest = [JSON.stringify({ requestId: rest[1] })];
}
const input = rest.join(' ');
const storageType = process.env.SHADOWGRAPH_STORAGE ?? 'json';
const file = resolve(process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json');

function assertStorageType() {
  if (!['json', 'sqlite'].includes(storageType)) {
    throw new Error(`Unsupported SHADOWGRAPH_STORAGE "${storageType}". Use "json" or "sqlite".`);
  }
}

function parse(value) {
  try { return JSON.parse(value); } catch { throw new Error('Expected a JSON argument'); }
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function startMcp() {
  assertStorageType();
  await import('./mcp.js');
}

async function startHttp() {
  assertStorageType();
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 through 65535');
  const { createShadowGraphServer } = await import('./server.js');
  const app = await createShadowGraphServer({ file, storage: storageType });
  app.server.listen(port, '127.0.0.1', () => {
    const address = app.server.address();
    console.log(`ShadowGraph listening on http://127.0.0.1:${address.port}`);
  });
}

// Host delivery (PR-30, plan v1.4.4 §18.4) has its own exit path: it never
// reaches the generic error below, never writes to stderr, never sets an exit
// code, and opens no store for writing. A reader that has gone away (EPIPE) is
// not an error of the hook's.
async function deliverFromHook() {
  try {
    process.removeAllListeners('warning');
    for (const stream of [process.stdout, process.stdin]) stream.on('error', () => {});
    const { readHookInput, runDeliver } = await import('./delivery.js');
    await runDeliver({ args: rest, readInput: () => readHookInput(), file, storage: storageType, write: (text) => process.stdout.write(text) });
  } catch {}
}

// The Claude Code hook block (plan rev6 PR-31) is written into one settings
// file, the user's by default, and opens no store; the owner confirms every
// change at a terminal, a scratch file apart (src/host-hooks.js).
async function changeHooks() {
  const at = rest.indexOf('--settings');
  const named = at >= 0 ? rest[at + 1] : undefined;
  if (rest.length !== (at >= 0 ? 2 : 0) || (at >= 0 && (!named || named.startsWith('-')))) throw new Error(`Usage: shadowgraph ${command} [--settings <path>]`);
  return changeHookSettings(named ?? defaultSettingsPath(), command === 'install-hooks' ? 'install' : 'uninstall');
}

async function runOneShot() {
  assertStorageType();
  const initializedBeforeOpen = await exists(file);
  if (command === 'doctor' && storageType === 'sqlite') {
    const { nodeSqlite } = await getRuntimeCapabilities();
    if (!nodeSqlite.available) throw new Error(nodeSqlite.reason);
  }
  if (command === 'doctor' && !initializedBeforeOpen) {
    throw new Error(`Storage is not initialized at ${file}. Run \`shadowgraph setup\` first.`);
  }
  const restoreValidator = createRestoreValidator();
  const store = await createStorage({ type: storageType, file, restoreValidator });
  try {
    const graph = createShadowGraph();
    graph.importData(await store.load());
    const workspace = await discoverWorkspace();
    const prepared = (value = {}) => accessContext(graph, value, 'cli', workspace);
    const refuseIssuance = async (reason, error, value = {}) => {
      await currentAccessOperation(graph, store, () => privileged.privilegedAccessRefusal(graph, { requestId: value.requestId, surface: 'cli', reason }));
      throw error;
    };

    if (['request-access', 'issue-access', 'delegate-access', 'revoke-access', 'discard-access', 'access-status', 'bind', 'attribute'].includes(command)) {
      let value;
      try { value = parse(input || '{}'); }
      catch (error) {
        if (['issue-access', 'delegate-access'].includes(command)) return await refuseIssuance('grant_bounds_invalid', error);
        throw error;
      }
      if (['issue-access', 'delegate-access'].includes(command) && (!value || typeof value !== 'object' || Array.isArray(value))) {
        return await refuseIssuance('grant_bounds_invalid', new Error('Issuance requires a JSON object'));
      }
      if (command === 'access-status') return privileged.privilegedAccessInspection(graph);
      if (command === 'bind') {
        if (typeof value.project !== 'string' || !value.project.trim()) throw new Error('bind requires a non-empty project');
        process.stdout.write(`Worktree mapping: ${workspace.worktreeRoot}\nShared repository mapping: ${workspace.commonDir ?? '(not a Git repository)'}\n`);
        const choice = await ownerAnswer('Select worktree or shared_repository: ');
        if (!['worktree', 'shared_repository'].includes(choice) || (choice === 'shared_repository' && !workspace.commonDir)) throw new Error('binding_requires_owner_confirmation');
        const binding = { type: choice, path: choice === 'worktree' ? workspace.worktreeRoot : workspace.commonDir, project: value.project, reason: value.reason, surface: 'cli' };
        if (!await confirmOwnerAction('Confirm project binding', binding)) throw new Error('binding_requires_owner_confirmation');
        return await bindWorkspaceProject(graph, store, workspace, binding);
      }
      if (command === 'attribute') {
        const attribution = { ...value, surface: 'cli' };
        if (!await confirmOwnerAction('Confirm explicit attribution', attribution)) throw new Error('attribution_requires_owner_confirmation');
        return await currentAccessOperation(graph, store, () => graph.attribute(attribution));
      }
      if (command === 'request-access') return await currentAccessOperation(graph, store, () => graph.requestAccess(prepared(value)));
      if (command === 'revoke-access') return await currentAccessOperation(graph, store, () => graph.revokeAccess(prepared(value)));
      if (command === 'discard-access') return await currentAccessOperation(graph, store, () => graph.discardAccess(prepared(value)));
      const type = command === 'delegate-access' ? 'delegation' : 'grant';
      // A delegation may issue a grant only. The kernel rechecks all limits and
      // consumes its issuance budget in the same saved payload as the witness.
      if (type === 'grant' && value.delegationId) {
        const result = await currentAccessOperation(graph, store, () => graph.issueAccess(prepared({ ...value, type })));
        if (!result.ok) process.exitCode = 1;
        return result;
      }
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        const result = await currentAccessOperation(graph, store, () => graph.issueAccess(prepared({ ...value, type, delegationId: undefined })));
        process.exitCode = 1;
        return result;
      }
      const { normalizeAccessScope, normalizeSurfaces } = await import('./access.js');
      const request = value.requestId ? privileged.privilegedAccessInspection(graph).access?.entries?.find((entry) => entry.accessId === value.requestId && entry.type === 'request') : null;
      if (value.requestId && !request) return await refuseIssuance('access_request_not_available', new Error('Access request not found'), value);
      let scope, surfaces;
      try { scope = normalizeAccessScope(value.scope ?? request?.scope); surfaces = normalizeSurfaces(value.surfaces ?? request?.surfaces); }
      catch (error) { return await refuseIssuance('grant_bounds_invalid', error, value); }
      const resolved = {
        type, scope, surfaces,
        expiresAt: value.expiresAt ?? request?.expiresAt, reason: value.reason ?? request?.reason,
        ...(value.requestId ? { requestId: value.requestId } : {}),
        ...(value.idempotencyKey ? { idempotencyKey: value.idempotencyKey } : {}),
        ...(type === 'delegation' ? { issuanceLimit: value.issuanceLimit } : {})
      };
      if (!Number.isFinite(Date.parse(resolved.expiresAt)) || Date.parse(resolved.expiresAt) <= Date.now()) return await refuseIssuance('grant_bounds_invalid', new Error('A future expiresAt is required'), value);
      if (type === 'delegation' && (!Number.isSafeInteger(resolved.issuanceLimit) || resolved.issuanceLimit < 1)) return await refuseIssuance('delegation_budget_invalid', new Error('issuanceLimit must be a positive safe integer'), value);
      if (!await confirmOwnerAction(`Issue ${type}`, resolved)) {
        const result = await currentAccessOperation(graph, store, () => graph.issueAccess(prepared(resolved)));
        process.exitCode = 1;
        return result;
      }
      const result = await currentAccessOperation(graph, store, () => privileged.privilegedIssueAccess(graph, prepared(resolved)));
      if (!result.ok) process.exitCode = 1;
      return result;
    }

    const readCommands = {
      stats: (value) => graph.stats(value), list: (value) => graph.exportData(value), search: (value) => graph.search(value.query ?? '', value),
      retrieve: (value) => graph.retrieve(value.query ?? '', value), recall: (value) => graph.recall(value.query ?? '', value),
      context: (value) => graph.context(value), 'review-context': (value) => graph.reviewContext(value),
      review: (value) => graph.review(value), reconsider: (value) => graph.reconsider(value),
      maintain: (value) => graph.maintain(value), traverse: (value) => graph.traverse(value), redact: (value) => graph.redact(value),
      journal: (value) => graph.getJournal(value), rebuild: (value) => graph.rebuild(value), signals: (value) => graph.getReviewSignals(value),
      validate: (value) => graph.validate(value), 'repair-plan': (value) => graph.repairPlan(value)
    };
    if (readCommands[command]) {
      const value = parse(input || '{}');
      if (hasAccessReference(value)) return await currentAccessOperation(graph, store, () => readCommands[command](prepared(value)));
      // Existing owner-scope evaluation writes remain unchanged. Ordinary reads
      // do not gain a save merely because grant-bearing calls are audited.
      const result = readCommands[command](prepared(value));
      // context is the default-path read and saves nothing (plan v1.4.4 §13.2);
      // review-context carries the evaluate-and-persist behaviour it used to have.
      if (['review-context', 'review', 'reconsider', 'maintain'].includes(command)) await store.save(privilegedSnapshot(graph));
      return result;
    }

    if (command === 'setup') {
      if (!initializedBeforeOpen) {
        const revision = await store.save(privilegedSnapshot(graph));
        graph.setRevision(revision);
      }
      return {
        ok: true,
        command: 'setup',
        created: !initializedBeforeOpen,
        storage: { type: storageType, path: file },
        next: 'Run `shadowgraph doctor`, then `shadowgraph remember <JSON>`.'
      };
    }

    if (command === 'doctor') {
      await access(file, fsConstants.R_OK | fsConstants.W_OK);
      const validation = graph.validate();
      const storageDiagnostics = await store.validate?.();
      const mcpPath = fileURLToPath(new URL('./mcp.js', import.meta.url));
      await access(mcpPath, fsConstants.R_OK);
      const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
      const nodeSupported = nodeMajor >= 20;
      const graphValid = validation.valid === true;
      return {
        ok: nodeSupported && graphValid && storageDiagnostics?.valid !== false,
        command: 'doctor',
        version: VERSION,
        node: { version: process.versions.node, supported: nodeSupported, requirement: '>=20' },
        storage: { type: storageType, path: file, initialized: true, readable: true, writable: true,
          ...(storageDiagnostics?.issues?.length ? { diagnostics: storageDiagnostics } : {}) },
        graph: { valid: graphValid, issues: validation.issues?.length ?? 0, completeness: validation.completeness, limitation: validation.limitation },
        mcp: { available: true, recommendedMode: 'compact', fullMode: 'Set SHADOWGRAPH_MCP_COMPACT=0 or remove it.' }
      };
    }

    let result;
    if (command === 'stats') result = graph.stats();
    else if (command === 'list') result = graph.exportData(parse(input || '{}'));
    else if (command === 'search') { const query = parse(input || '{}'); result = graph.search(query.query ?? '', query); }
    else if (command === 'remember') { const value = prepared(parse(input)); result = Array.isArray(value.operations) ? graph.applyMemoryPlan(value) : graph.remember(value); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'recall') { const value = parse(input || '{}'); result = graph.recall(value.query ?? '', value); }
    else if (command === 'markdown-sync') {
      const value = parse(input);
      const persist = value.mode === 'pull' && value.dryRun !== true ? async (data) => store.save(data) : undefined;
      const loadPersisted = persist ? async () => store.load() : undefined;
      result = await syncMarkdownWorkspace({ graph, ...value, ...(persist ? { persist, loadPersisted } : {}) });
    }
    else if (command === 'review') { result = graph.review(parse(input || '{}')); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'reconsider') { result = graph.reconsider(parse(input || '{}')); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'fact') { result = graph.addFact(prepared(parse(input))); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'outcome') { const value = prepared(parse(input)); result = graph.setOutcome(value.decisionId, value.outcome, value); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'status') { const value = prepared(parse(input)); result = graph.updateDecisionStatus(value.decisionId, value.status, value); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'link') { result = graph.link(prepared(parse(input))); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'traverse') result = graph.traverse(parse(input));
    else if (command === 'redact') result = graph.redact(parse(input));
    else if (command === 'supersede') { result = graph.supersedeDecision(prepared(parse(input))); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'purge-preview') result = graph.projectSummary(parse(input).project);
    else if (command === 'purge') { const value = parse(input); result = graph.purgeProject(value.project, { mode: value.mode }); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'confidence-evidence') { result = graph.addConfidenceEvidence(prepared(parse(input))); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'journal') result = graph.getJournal(parse(input || '{}'));
    else if (command === 'rebuild') result = graph.rebuild(parse(input || '{}'));
    else if (command === 'maintain') { result = graph.maintain(parse(input || '{}')); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'signals') result = graph.getReviewSignals(parse(input || '{}'));
    else if (command === 'ack') { const value = prepared(parse(input)); result = graph.acknowledgeReview(value.id, value); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'retrieve') { const value = parse(input || '{}'); result = graph.retrieve(value.query ?? '', value); }
    else if (command === 'validate') result = graph.validate();
    else if (command === 'repair-plan') result = graph.repairPlan();
    else if (command === 'backup') result = await backupFile(file, input || `${file}.backup`, { store });
    else if (command === 'restore') {
      // `--memory-only` excludes authority collections; ordinary restore keeps
      // the destination-bound narrowing rules (R16 / PR12).
      const memoryOnly = rest.includes('--memory-only');
      const source = rest.filter((argument) => argument !== '--memory-only').join(' ');
      result = store.restore
        ? await store.restore(source, { memoryOnly, validate: restoreValidator, afterReplace: (payload) => graph.replaceData(payload) })
        : await restoreFile(source, file, { memoryOnly, storage: storageType, validate: restoreValidator, afterReplace: (payload) => graph.replaceData(payload) });
    }
    else if (command === 'migrate' || command === 'downgrade') {
      // Both write a verified preservation copy of the store first (plan v1.4.4
      // §19.3.2); the default sits beside the store.
      const value = parse(input || '{}');
      const preservationCopy = value.preservationCopy ?? `${file}.preservation-${Date.now()}${storageType === 'sqlite' ? '.db' : '.json'}`;
      result = command === 'migrate'
        ? await migrateStore({ graph, store, file, storageType, batchSize: value.batchSize, preservationCopy })
        : await downgradeStore({ graph, store, file, storageType, output: value.output, preservationCopy, toSchemaVersion: value.toSchemaVersion });
    }
    else if (command === 'decision') { result = graph.addDecision(prepared(parse(input))); await store.save(privilegedSnapshot(graph)); }
    else if (command === 'attempt') { result = graph.addAttempt(prepared(parse(input))); await store.save(privilegedSnapshot(graph)); }
    else {
      throw new Error('Usage: shadowgraph <setup|doctor|serve|mcp|stats|list|search|retrieve|recall|remember|markdown-sync|context|review-context|deliver|install-hooks|uninstall-hooks|review|reconsider|maintain|signals|ack|validate|repair-plan|backup|restore|migrate|downgrade|decision|attempt|fact|outcome|status|link|traverse|redact|supersede|purge-preview|purge|request-access|issue-access|delegate-access|revoke-access|discard-access|access-status|bind|attribute> [JSON/path] (restore <path> [--memory-only]; install-hooks and uninstall-hooks [--settings <path>]). Writes require project or originId (or confirmed workspace binding). Creation IDs are generated: omit id, retain returned IDs, and use idempotencyKey for retries. Reference IDs remain supported.');
    }
    return result;
  } finally {
    store.close?.();
  }
}

try {
  if (command === 'mcp') await startMcp();
  else if (command === 'serve') await startHttp();
  else if (command === 'deliver') await deliverFromHook();
  else if (command === 'install-hooks' || command === 'uninstall-hooks') console.log(JSON.stringify(await changeHooks(), null, 2));
  else {
    const result = await runOneShot();
    if (result !== null && result !== undefined) console.log(JSON.stringify(result, null, 2));
    if (command === 'doctor' && result?.ok !== true) process.exitCode = 1;
  }
} catch (error) {
  console.error(`ShadowGraph ${command || 'command'} failed: ${error.message}`);
  process.exitCode = 1;
}
