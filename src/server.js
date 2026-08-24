import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createStorage } from './storage.js';
import { createShadowGraph } from './shadowgraph.js';

const MAX_BODY_BYTES = 1024 * 1024;

export async function createShadowGraphServer(options = {}) {
  const store = options.store ?? await createStorage({ type: options.storage ?? process.env.SHADOWGRAPH_STORAGE, file: options.file ?? process.env.SHADOWGRAPH_FILE ?? './.shadowgraph/data.json' });
  const graph = createShadowGraph(options);
  graph.importData(await store.load());

  async function persist() {
    await store.save(graph.exportData());
  }

  async function handle(path, method, body) {
    if (method === 'GET' && path === '/health') return { ok: true, name: 'shadowgraph' };
    if (method === 'GET' && path === '/stats') return graph.stats();
    if (method === 'GET' && path === '/records') return graph.exportData();
    if (method === 'GET' && path === '/search') return graph.search(body?.q ?? '', body ?? {});
    if (method === 'POST' && path === '/context') return graph.context(body ?? {});
    if (method === 'POST' && path === '/facts') { const value = graph.addFact(body); await persist(); return value; }
    if (method === 'POST' && path === '/outcomes') { const value = graph.setOutcome(body.decisionId, body.outcome); await persist(); return value; }
    if (method === 'POST' && path === '/status') { const value = graph.updateDecisionStatus(body.decisionId, body.status); await persist(); return value; }
    if (method === 'POST' && path === '/relationships') { const value = graph.link(body); await persist(); return value; }
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
    if (method === 'POST' && path === '/review') return graph.review(body ?? {});
    return { error: 'not_found' };
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const origin = request.headers.origin;
      if (origin && !origin.startsWith('http://127.0.0.1:') && origin !== 'http://localhost') {
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
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'invalid request' }));
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
