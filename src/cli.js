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
import { VERSION } from './version.js';

const [command, ...rest] = process.argv.slice(2);
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

async function runOneShot() {
  assertStorageType();
  const initializedBeforeOpen = await exists(file);
  const restoreValidator = createRestoreValidator();
  const store = await createStorage({ type: storageType, file, restoreValidator });
  try {
    const graph = createShadowGraph();
    graph.importData(await store.load());

    if (command === 'setup') {
      if (!initializedBeforeOpen) {
        const revision = await store.save(graph.exportData());
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
      if (!initializedBeforeOpen) {
        throw new Error(`Storage is not initialized at ${file}. Run \`shadowgraph setup\` first.`);
      }
      await access(file, fsConstants.R_OK | fsConstants.W_OK);
      const validation = graph.validate();
      const mcpPath = fileURLToPath(new URL('./mcp.js', import.meta.url));
      await access(mcpPath, fsConstants.R_OK);
      const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
      const nodeSupported = nodeMajor >= 20;
      const graphValid = validation.valid === true;
      return {
        ok: nodeSupported && graphValid,
        command: 'doctor',
        version: VERSION,
        node: { version: process.versions.node, supported: nodeSupported, requirement: '>=20' },
        storage: { type: storageType, path: file, initialized: true, readable: true, writable: true },
        graph: { valid: graphValid, issues: validation.issues?.length ?? 0 },
        mcp: { available: true, recommendedMode: 'compact', fullMode: 'Set SHADOWGRAPH_MCP_COMPACT=0 or remove it.' }
      };
    }

    let result;
    if (command === 'stats') result = graph.stats();
    else if (command === 'list') result = graph.exportData();
    else if (command === 'search') { const query = parse(input || '{}'); result = graph.search(query.query ?? '', query); }
    else if (command === 'context') { result = graph.context(parse(input || '{}')); await store.save(graph.exportData()); }
    else if (command === 'remember') { const value = parse(input); result = Array.isArray(value.operations) ? graph.applyMemoryPlan(value) : graph.remember(value); await store.save(graph.exportData()); }
    else if (command === 'recall') { const value = parse(input || '{}'); result = graph.recall(value.query ?? '', value); }
    else if (command === 'markdown-sync') {
      const value = parse(input);
      const persist = value.mode === 'pull' && value.dryRun !== true ? async (data) => store.save(data) : undefined;
      const loadPersisted = persist ? async () => store.load() : undefined;
      result = await syncMarkdownWorkspace({ graph, ...value, ...(persist ? { persist, loadPersisted } : {}) });
    }
    else if (command === 'review') { result = graph.review(parse(input || '{}')); await store.save(graph.exportData()); }
    else if (command === 'fact') { result = graph.addFact(parse(input)); await store.save(graph.exportData()); }
    else if (command === 'outcome') { const value = parse(input); result = graph.setOutcome(value.decisionId, value.outcome); await store.save(graph.exportData()); }
    else if (command === 'status') { const value = parse(input); result = graph.updateDecisionStatus(value.decisionId, value.status); await store.save(graph.exportData()); }
    else if (command === 'link') { result = graph.link(parse(input)); await store.save(graph.exportData()); }
    else if (command === 'traverse') result = graph.traverse(parse(input));
    else if (command === 'redact') result = graph.redact(parse(input));
    else if (command === 'supersede') { result = graph.supersedeDecision(parse(input)); await store.save(graph.exportData()); }
    else if (command === 'purge-preview') result = graph.projectSummary(parse(input).project);
    else if (command === 'purge') { const value = parse(input); result = graph.purgeProject(value.project, { mode: value.mode }); await store.save(graph.exportData()); }
    else if (command === 'confidence-evidence') { result = graph.addConfidenceEvidence(parse(input)); await store.save(graph.exportData()); }
    else if (command === 'journal') result = graph.getJournal(parse(input || '{}'));
    else if (command === 'rebuild') result = graph.rebuild(parse(input || '{}'));
    else if (command === 'maintain') { result = graph.maintain(parse(input || '{}')); await store.save(graph.exportData()); }
    else if (command === 'signals') result = graph.getReviewSignals(parse(input || '{}'));
    else if (command === 'ack') { result = graph.acknowledgeReview(parse(input).id); await store.save(graph.exportData()); }
    else if (command === 'retrieve') { const value = parse(input || '{}'); result = graph.retrieve(value.query ?? '', value); }
    else if (command === 'validate') result = graph.validate();
    else if (command === 'repair-plan') result = graph.repairPlan();
    else if (command === 'backup') result = await backupFile(file, input || `${file}.backup`, { store });
    else if (command === 'restore') result = store.restore
      ? await store.restore(input, { validate: restoreValidator, afterReplace: (payload) => graph.replaceData(payload) })
      : await restoreFile(input, file, { storage: storageType, validate: restoreValidator, afterReplace: (payload) => graph.replaceData(payload) });
    else if (command === 'decision') { result = graph.addDecision(parse(input)); await store.save(graph.exportData()); }
    else if (command === 'attempt') { result = graph.addAttempt(parse(input)); await store.save(graph.exportData()); }
    else {
      throw new Error('Usage: shadowgraph <setup|doctor|serve|mcp|stats|list|search|retrieve|recall|remember|markdown-sync|context|review|maintain|signals|ack|validate|repair-plan|backup|restore|decision|attempt|fact|outcome|status|link|traverse|redact|supersede|purge-preview|purge> [JSON/path]');
    }
    return result;
  } finally {
    store.close?.();
  }
}

try {
  if (command === 'mcp') await startMcp();
  else if (command === 'serve') await startHttp();
  else {
    const result = await runOneShot();
    if (result !== null && result !== undefined) console.log(JSON.stringify(result, null, 2));
    if (command === 'doctor' && result?.ok !== true) process.exitCode = 1;
  }
} catch (error) {
  console.error(`ShadowGraph ${command || 'command'} failed: ${error.message}`);
  process.exitCode = 1;
}
