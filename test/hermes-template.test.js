import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShadowGraphServer } from '../src/server.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// The published Hermes wrapper (integrations/hermes-agent.py) is a caller of the
// HTTP API. Every helper names the project it works in -- by default the real
// project "default", like its record helpers always have -- so its by-id
// changes are not id-only writes the server refuses, and project=None never
// means "every project".
const template = fileURLToPath(new URL('../integrations/hermes-agent.py', import.meta.url));
const python = (process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'])
  .find((command) => /^Python 3\./.test(spawnSync(command, ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? ''));

test('every Hermes helper takes a project and sends it', async () => {
  const source = (await readFile(template, 'utf8')).replace(/\r\n/g, '\n');
  const helpers = [...source.matchAll(/^def (shadowgraph_\w+)\(([\s\S]*?)\):\n([\s\S]*?)(?=^def |(?![\s\S]))/gm)];
  assert.equal(helpers.length, 11);
  for (const [, name, parameters, body] of helpers) {
    assert.match(parameters, /\bproject="default"/, `${name} defaults to the real project "default"`);
    assert.match(body, /"project": project|(?:params|payload)\["project"\] = project/, `${name} sends its project`);
  }
});

// A driver that loads the template itself, points it at a test server and
// records what each helper actually sent and what the server answered.
const DRIVER = String.raw`
import importlib.util, json, sys, urllib.error
spec = importlib.util.spec_from_file_location("hermes_agent", sys.argv[1])
hermes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hermes)
hermes.BASE_URL = sys.argv[2]
sent, send = [], hermes._request
def recording(method, path, payload=None):
    sent.append({"method": method, "path": path, "payload": payload})
    try:
        return {"status": 200, "body": send(method, path, payload)}
    except urllib.error.HTTPError as error:
        return {"status": error.code, "body": json.loads(error.read().decode("utf-8"))}
hermes._request = recording
def call(name, *args, **kwargs):
    try:
        return getattr(hermes, name)(*args, **kwargs)
    except TypeError as error:
        return {"status": None, "error": "TypeError: " + str(error)}
decision = call("shadowgraph_record_decision", "Template decision", "sqlite")["body"]
alpha = call("shadowgraph_record_decision", "Alpha template decision", "postgres", project="alpha")["body"]
results = {
    "decision": decision,
    "outcome": call("shadowgraph_record_outcome", decision["id"], "successful"),
    "status": call("shadowgraph_update_status", decision["id"], "planned"),
    "evidence": call("shadowgraph_confidence_evidence", decision["id"], "template-key", "template reason"),
    "search": call("shadowgraph_search", "Template"),
    "retrieve": call("shadowgraph_retrieve", "Template"),
    "maintain": call("shadowgraph_maintain"),
    "alphaStatus": call("shadowgraph_update_status", alpha["id"], "planned", project="alpha"),
    "wrongProjectOutcome": call("shadowgraph_record_outcome", alpha["id"], "failed", project="default"),
    "unscopedOutcome": call("shadowgraph_record_outcome", decision["id"], "failed", project=None),
    "unscopedSearch": call("shadowgraph_search", "Template", project=None),
    "unscopedMaintain": call("shadowgraph_maintain", project=None),
}
print(json.dumps({"results": results, "sent": sent}))
`;

test('the Hermes template runs against the HTTP API inside the project it names', { skip: python ? false : 'no Python 3 interpreter on PATH' }, async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-hermes-template-');
  const app = await createShadowGraphServer({ file: join(directory, 'data.json'), storage: 'json', apiToken: '' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  // Asynchronous, so the in-process server can answer while Python waits.
  const run = await new Promise((resolve) => {
    const child = spawn(python, ['-B', '-c', DRIVER, template, base]);
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  assert.equal(run.status, 0, run.stderr);
  const { results, sent } = JSON.parse(run.stdout);
  const payloadOf = (path) => sent.filter((request) => request.path === path).map((request) => request.payload);

  // By-id changes carry the project they are made in.
  assert.deepEqual(payloadOf('/outcomes').map((payload) => payload.project), ['default', 'default', undefined]);
  assert.equal(Object.hasOwn(payloadOf('/outcomes')[2], 'project'), false, 'project=None sends no project');
  assert.deepEqual(payloadOf('/status').map((payload) => payload.project), ['default', 'alpha']);
  assert.deepEqual(payloadOf('/confidence-evidence').map((payload) => payload.project), ['default']);
  assert.equal(results.outcome.status, 200, JSON.stringify(results.outcome));
  assert.equal(results.outcome.body.outcome.status, 'successful');
  assert.equal(results.status.status, 200, JSON.stringify(results.status));
  assert.equal(results.status.body.status, 'planned');
  assert.equal(results.evidence.status, 200, JSON.stringify(results.evidence));
  assert.equal(results.evidence.body.id, results.decision.id);
  assert.equal(results.alphaStatus.status, 200, JSON.stringify(results.alphaStatus));

  // Reads and maintenance stay in the named project.
  assert.ok(sent.some((request) => request.path.startsWith('/search?') && request.path.includes('project=default')));
  assert.deepEqual(results.search.body.items.map((item) => item.record.id), [results.decision.id]);
  assert.deepEqual(results.retrieve.body.items.map((item) => item.record.id), [results.decision.id]);
  assert.equal(results.maintain.status, 200);
  assert.equal(results.maintain.body.completeness.scope.project, 'default');

  // Another project's id is answered as a missing one, and no project means no scope.
  assert.notEqual(results.wrongProjectOutcome.status, 200);
  assert.match(JSON.stringify(results.wrongProjectOutcome.body), /not found/i);
  assert.equal(results.unscopedOutcome.status, 400);
  assert.equal(results.unscopedOutcome.body.code, 'write_scope_unresolved');
  assert.deepEqual(results.unscopedSearch.body.items, []);
  assert.equal(results.unscopedSearch.body.completeness.complete, false);
  assert.equal(results.unscopedMaintain.body.completeness.complete, false);
});
