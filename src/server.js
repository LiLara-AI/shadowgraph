import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createStorage } from './storage.js';
import { createShadowGraph } from './shadowgraph.js';
import { backupFile, restoreFile } from './backup.js';
import { VERSION, NAME } from './version.js';
import { createRestoreValidator } from './restore-validation.js';

const MAX_BODY_BYTES = 1024 * 1024;

// P1-4: a GET query string is all strings. Passing `limit: "2"` straight into the
// core meant `Number.isInteger('2')` was false, so a perfectly valid request
// failed — or worse, a filter like minConfidence silently compared a string.
// Typed parameters are coerced HERE, at the transport boundary, and a value that
// is not coercible is a 400 rather than a confusing core error.
const INTEGER_PARAMS = ['limit', 'offset', 'depth'];
const NUMBER_PARAMS = ['minConfidence'];
const BOOLEAN_PARAMS = ['requireFullHistory', 'hard'];
const RESTORE_BLOCKED_MUTATIONS = new Set([
  '/facts', '/memories', '/outcomes', '/status', '/relationships', '/supersede', '/decisions', '/attempts',
  '/context', '/review', '/maintain', '/review-signals/ack', '/confidence-evidence', '/projects', '/restore'
]);
const UNCONFIRMED_RECOVERY_CODES = new Set(['json_restore_recovery_unconfirmed', 'sqlite_restore_recovery_unconfirmed']);

function parseLoopbackAuthority(authority) {
  if (typeof authority !== 'string') return null;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([1-9]\d{0,4}))?$/u.exec(authority);
  if (!match) return null;
  const port = match[2] === undefined ? 80 : Number(match[2]);
  if (port > 65_535) return null;
  return { hostname: match[1], port };
}

function isAllowedLocalOrigin(origin, localPort) {
  if (typeof origin !== 'string' || !origin.startsWith('http://')) return false;
  return parseLoopbackAuthority(origin.slice('http://'.length))?.port === localPort;
}

function isAllowedLocalHost(host, localPort) {
  return parseLoopbackAuthority(host)?.port === localPort;
}

function rejectForbidden(response) {
  response.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: 'forbidden' }));
}

function coerceQuery(params) {
  const parsed = { ...params };
  for (const key of INTEGER_PARAMS) {
    if (parsed[key] === undefined || typeof parsed[key] !== 'string') continue;
    if (!/^-?\d+$/.test(parsed[key].trim())) throw new Error(`Query parameter ${key} must be an integer`);
    parsed[key] = Number.parseInt(parsed[key], 10);
  }
  for (const key of NUMBER_PARAMS) {
    if (parsed[key] === undefined || typeof parsed[key] !== 'string') continue;
    const value = Number(parsed[key]);
    if (!Number.isFinite(value)) throw new Error(`Query parameter ${key} must be a number`);
    parsed[key] = value;
  }
  for (const key of BOOLEAN_PARAMS) {
    if (parsed[key] === undefined || typeof parsed[key] !== 'string') continue;
    const raw = parsed[key].trim().toLowerCase();
    if (!['true', 'false', '1', '0'].includes(raw)) throw new Error(`Query parameter ${key} must be true or false`);
    parsed[key] = raw === 'true' || raw === '1';
  }
  return parsed;
}

export async function createShadowGraphServer(options = {}) {
  const restoreValidator = createRestoreValidator(options);
  const store = options.store ?? await createStorage({ type: options.storage ?? process.env.SHADOWGRAPH_STORAGE, file: options.file ?? process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json', restoreValidator });
  const graph = createShadowGraph(options);
  graph.importData(await store.load());
  const dashboardRoot = new URL('../dashboard/', import.meta.url);
  const dashboardHtml = await readFile(new URL('index.html', dashboardRoot), 'utf8');
  const apiToken = options.apiToken ?? process.env.SHADOWGRAPH_API_TOKEN;
  if (apiToken && apiToken.length < 16) throw new Error('SHADOWGRAPH_API_TOKEN must be at least 16 characters');

  let restoreInProgress = false;
  let persistenceUnavailable = null;
  function latchPersistenceUnavailable(error) {
    if (UNCONFIRMED_RECOVERY_CODES.has(error.code)) persistenceUnavailable = error;
  }
  let persistQueue = Promise.resolve();
  function queuePersistence(operation, onError) {
    const queued = persistQueue.then(operation).catch(async (error) => {
      if (onError) return onError(error);
      throw error;
    });
    persistQueue = queued.catch(() => {});
    return queued;
  }
  function persist() {
    return queuePersistence(
      async () => { const snapshot = graph.exportData(); const revision = await store.save(snapshot); graph.setRevision(revision); },
      async (error) => { if (/revision conflict/i.test(error.message)) graph.replaceData(await store.load()); throw error; }
    );
  }
  function mutateAndPersist(operation) {
    return queuePersistence(async () => {
      const before = graph.exportData();
      try {
        const value = await operation();
        const revision = await store.save(graph.exportData());
        graph.setRevision(revision);
        return value;
      } catch (error) {
        try { graph.replaceData(await store.load()); }
        catch { graph.replaceData(before); }
        throw error;
      }
    });
  }

  async function handle(path, method, body) {
    if (persistenceUnavailable) {
      if (method === 'GET' && path === '/health') return {
        ok: false, name: NAME, version: VERSION, status: 'degraded',
        detail: 'persistent storage unavailable; restart required',
        recoveryCode: persistenceUnavailable.code,
        retainedArtifacts: [...(persistenceUnavailable.retainedArtifacts ?? [])],
        ...(persistenceUnavailable.unknownArtifacts ? { unknownArtifacts: structuredClone(persistenceUnavailable.unknownArtifacts) } : {})
      };
      const unavailable = new Error('Persistent storage unavailable after unconfirmed restore recovery; restart required');
      unavailable.code = 'persistence_unavailable';
      unavailable.recoveryCode = persistenceUnavailable.code;
      unavailable.retainedArtifacts = [...(persistenceUnavailable.retainedArtifacts ?? [])];
      if (persistenceUnavailable.unknownArtifacts) unavailable.unknownArtifacts = structuredClone(persistenceUnavailable.unknownArtifacts);
      throw unavailable;
    }
    if (restoreInProgress && RESTORE_BLOCKED_MUTATIONS.has(path) && (method === 'POST' || method === 'DELETE')) {
      throw new Error('SQLite restore is in progress; write rejected before mutation');
    }
    // P1-3: version comes from package.json via src/version.js — one source only.
    if (method === 'GET' && path === '/health') return { ok: true, name: NAME, version: VERSION };
    if (method === 'GET' && path === '/dashboard') return { dashboard: dashboardRoot.href };
    if (method === 'GET' && path === '/stats') return graph.stats();
    if (method === 'GET' && path === '/records') return graph.exportData();
    if (method === 'GET' && path === '/search') return graph.search(body?.q ?? body?.query ?? '', body ?? {});
    if (method === 'POST' && path === '/context') return mutateAndPersist(() => graph.context(body ?? {}));
    if (method === 'POST' && path === '/memories') return mutateAndPersist(() => Array.isArray(body?.operations) ? graph.applyMemoryPlan(body) : graph.remember(body));
    if (method === 'POST' && path === '/recall') return graph.recall(body?.query ?? '', body ?? {});
    if (method === 'POST' && path === '/facts') return mutateAndPersist(() => graph.addFact(body));
    if (method === 'POST' && path === '/outcomes') return mutateAndPersist(() => graph.setOutcome(body.decisionId, body.outcome));
    if (method === 'POST' && path === '/status') return mutateAndPersist(() => graph.updateDecisionStatus(body.decisionId, body.status));
    if (method === 'POST' && path === '/relationships') return mutateAndPersist(() => graph.link(body));
    if (method === 'POST' && path === '/traverse') return graph.traverse(body ?? {});
    if (method === 'POST' && path === '/redact') return graph.redact(body ?? {});
    if (method === 'POST' && path === '/supersede') return mutateAndPersist(() => graph.supersedeDecision(body));
    if (method === 'POST' && path === '/projects/purge-preview') return graph.projectSummary(body?.project);
    // G5: logical/tombstone purge is the default. `mode: 'hard'` must be asked for
    // explicitly and physically removes journal entries.
    if (method === 'DELETE' && path === '/projects') return mutateAndPersist(() => graph.purgeProject(body?.project, { mode: body?.mode }));
    if (method === 'POST' && path === '/confidence-evidence') return mutateAndPersist(() => graph.addConfidenceEvidence(body ?? {}));
    if (method === 'GET' && path === '/journal') return graph.getJournal(body ?? {});
    if (method === 'POST' && path === '/rebuild') return graph.rebuild(body ?? {});
    if (method === 'POST' && path === '/decisions') return mutateAndPersist(() => graph.addDecision(body));
    if (method === 'POST' && path === '/attempts') return mutateAndPersist(() => graph.addAttempt(body));
    if (method === 'POST' && path === '/review') return mutateAndPersist(() => graph.review(body ?? {}));
    if (method === 'POST' && path === '/maintain') return mutateAndPersist(() => graph.maintain(body ?? {}));
    if (method === 'GET' && path === '/review-signals') return graph.getReviewSignals(body ?? {});
    if (method === 'POST' && path === '/review-signals/ack') return mutateAndPersist(() => graph.acknowledgeReview(body?.id));
    if (method === 'POST' && path === '/retrieve') return graph.retrieve(body?.query ?? '', body ?? {});
    if (method === 'GET' && path === '/validate') return graph.validate();
    if (method === 'POST' && path === '/repair-plan') return graph.repairPlan();
    if (method === 'POST' && path === '/backup') return backupFile(options.file ?? process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json', body?.destination, { store });
    if (method === 'POST' && path === '/restore') {
      restoreInProgress = true;
      try {
        return await queuePersistence(async () => {
          try {
            if (store.restore) {
              try { await stat(body?.source); }
              catch (error) { if (error.code === 'ENOENT') throw new Error('Restore source does not exist'); throw error; }
              let activated = false;
              const value = await store.restore(body?.source, {
                validate: restoreValidator,
                afterReplace(payload) { graph.replaceData(payload); activated = true; }
              });
              if (!activated) graph.replaceData(await store.load());
              return value;
            }
            const destination = options.file ?? process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json';
            return await restoreFile(body?.source, destination, {
              storage: options.storage ?? process.env.SHADOWGRAPH_STORAGE,
              validate: restoreValidator,
              restoreFs: options.restoreFs,
              restoreFault: options.restoreFault,
              afterReplace: (payload) => graph.replaceData(payload)
            });
          } catch (error) {
            // Latch while this restore still owns the persistence queue. A later
            // queued operation must not observe an unlatched failure window.
            latchPersistenceUnavailable(error);
            throw error;
          }
        });
      } catch (error) {
        latchPersistenceUnavailable(error);
        if (['json_restore_rolled_back', 'sqlite_restore_rolled_back'].includes(error.code)) graph.replaceData(await store.load());
        throw error;
      } finally {
        restoreInProgress = false;
      }
    }
    return { error: 'not_found' };
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (!isAllowedLocalHost(request.headers.host, request.socket.localPort)) {
        rejectForbidden(response);
        return;
      }
      const origin = request.headers.origin;
      if (origin !== undefined && !isAllowedLocalOrigin(origin, request.socket.localPort)) {
        rejectForbidden(response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/dashboard') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
        });
        response.end(dashboardHtml);
        return;
      }
      const authorization = request.headers.authorization ?? '';
      const expected = Buffer.from(`Bearer ${apiToken ?? ''}`);
      const provided = Buffer.from(authorization);
      const authenticated = !apiToken || (provided.length === expected.length && timingSafeEqual(provided, expected));
      if (!authenticated) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'authentication required' }));
        return;
      }
      const chunks = [];
      let bodyBytes = 0;
      for await (const chunk of request) {
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
          response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'request body too large' }));
          return;
        }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      // P1-4: a JSON body is already typed; a query string is not, so only the
      // query path is coerced. An uncoercible value raises before it reaches the
      // core, so the caller gets a specific 400 instead of a vague core error.
      const body = raw ? JSON.parse(raw) : coerceQuery(Object.fromEntries(url.searchParams));
      const result = await handle(url.pathname, request.method, body);
      const status = result.error ? 404 : 200;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(result));
    } catch (error) {
      // Report WHAT was wrong. A blanket 'invalid request' hid parameter and
      // validation errors that the caller could otherwise fix.
      const notFound = error.message === 'Decision not found';
      const recoveryUnconfirmed = UNCONFIRMED_RECOVERY_CODES.has(error.code);
      const storageUnavailable = error.code === 'persistence_unavailable';
      const status = storageUnavailable ? 503 : recoveryUnconfirmed ? 500 : notFound ? 404 : 400;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({
        error: notFound ? 'decision not found' : error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.recoveryCode ? { recoveryCode: error.recoveryCode } : {}),
        ...(error.retainedArtifacts ? { retainedArtifacts: error.retainedArtifacts } : {}),
        ...(error.unknownArtifacts ? { unknownArtifacts: error.unknownArtifacts } : {}),
        ...(error.artifactCleanup ? { artifactCleanup: error.artifactCleanup } : {})
      }));
    }
  });

  return { server, graph, persist };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8787);
  const file = process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json';
  const app = await createShadowGraphServer({ file });
  app.server.listen(port, '127.0.0.1', () => console.log(`ShadowGraph listening on http://127.0.0.1:${port}`));
}
