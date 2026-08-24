import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { createStorage } from './storage.js';
import { createShadowGraph } from './shadowgraph.js';
import { backupFile, restoreFile } from './backup.js';

const MAX_BODY_BYTES = 1024 * 1024;

export async function createShadowGraphServer(options = {}) {
  const store = options.store ?? await createStorage({ type: options.storage ?? process.env.SHADOWGRAPH_STORAGE, file: options.file ?? process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json' });
  const graph = createShadowGraph(options);
  graph.importData(await store.load());
  const dashboardRoot = new URL('../dashboard/', import.meta.url);
  const apiToken = options.apiToken ?? process.env.SHADOWGRAPH_API_TOKEN;
  if (apiToken && apiToken.length < 16) throw new Error('SHADOWGRAPH_API_TOKEN must be at least 16 characters');

  let persistQueue = Promise.resolve();
  function persist() {
    const operation = persistQueue.then(async () => { const snapshot = graph.exportData(); const revision = await store.save(snapshot); graph.setRevision(revision); }).catch(async (error) => { if (/revision conflict/i.test(error.message)) graph.replaceData(await store.load()); throw error; });
    persistQueue = operation.catch(() => {});
    return operation;
  }

  async function handle(path, method, body) {
    if (method === 'GET' && path === '/health') return { ok: true, name: 'shadowgraph', version: '0.30.0' };
    if (method === 'GET' && path === '/dashboard') return { dashboard: dashboardRoot.href };
    if (method === 'GET' && path === '/stats') return graph.stats();
    if (method === 'GET' && path === '/records') return graph.exportData();
    if (method === 'GET' && path === '/search') return graph.search(body?.q ?? '', body ?? {});
    if (method === 'POST' && path === '/context') return graph.context(body ?? {});
    if (method === 'POST' && path === '/facts') { const value = graph.addFact(body); await persist(); return value; }
    if (method === 'POST' && path === '/outcomes') { const value = graph.setOutcome(body.decisionId, body.outcome); await persist(); return value; }
    if (method === 'POST' && path === '/status') { const value = graph.updateDecisionStatus(body.decisionId, body.status); await persist(); return value; }
    if (method === 'POST' && path === '/relationships') { const value = graph.link(body); await persist(); return value; }
    if (method === 'POST' && path === '/traverse') return graph.traverse(body ?? {});
    if (method === 'POST' && path === '/redact') return graph.redact(body ?? {});
    if (method === 'POST' && path === '/supersede') { const value = graph.supersedeDecision(body); await persist(); return value; }
    if (method === 'POST' && path === '/projects/purge-preview') return graph.projectSummary(body?.project);
    if (method === 'DELETE' && path === '/projects') { const value = graph.purgeProject(body?.project); await persist(); return value; }
    if (method === 'POST' && path === '/decisions') {
      const value = graph.addDecision(body);
      await persist();
      return value;
    }
    if (method === 'POST' && path === '/attempts') {
      const value = graph.addAttempt(body);
      await persist();
      return value;
    }
    if (method === 'POST' && path === '/review') { const value = graph.review(body ?? {}); await persist(); return value; }
    if (method === 'POST' && path === '/maintain') { const value = graph.maintain(body ?? {}); await persist(); return value; }
    if (method === 'GET' && path === '/review-signals') return graph.getReviewSignals(body ?? {});
    if (method === 'POST' && path === '/review-signals/ack') { const value = graph.acknowledgeReview(body?.id); await persist(); return value; }
    if (method === 'POST' && path === '/retrieve') return graph.retrieve(body?.query ?? '', body ?? {});
    if (method === 'GET' && path === '/validate') return graph.validate();
    if (method === 'POST' && path === '/repair-plan') return graph.repairPlan();
    if (method === 'POST' && path === '/backup') return backupFile(options.file ?? process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json', body?.destination, { store });
    if (method === 'POST' && path === '/restore') { const value = store.restore ? await store.restore(body?.source) : await restoreFile(body?.source, options.file ?? process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json', { storage: options.storage ?? process.env.SHADOWGRAPH_STORAGE }); graph.replaceData(await store.load()); return value; }
    return { error: 'not_found' };
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const origin = request.headers.origin;
      const authorization = request.headers.authorization ?? '';
      const expected = Buffer.from(`Bearer ${apiToken ?? ''}`);
      const provided = Buffer.from(authorization);
      const authenticated = !apiToken || (provided.length === expected.length && timingSafeEqual(provided, expected));
      if (!authenticated) {
        response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'authentication required' }));
        return;
      }
      if (origin && !origin.startsWith('http://127.0.0.1:') && !/^http:\/\/localhost(?::\d+)?$/.test(origin)) {
        response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'origin not allowed' }));
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
      const body = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
      const result = await handle(url.pathname, request.method, body);
      const status = result.error ? 404 : 200;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(result));
    } catch (error) {
      const status = error.message === 'Decision not found' ? 404 : 400;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: error.message === 'Decision not found' ? 'decision not found' : 'invalid request' }));
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
