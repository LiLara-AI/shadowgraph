// Plan v1.4.4 PR-18 (§13.4; AC-060; PC-01, PC-17; AC-026): every field reachable on
// the default discovery and context path is classified on two axes by
// tools/default-path-register.js. Paths come from three sources: the
// shadowgraph_context output schema with its descriptions; runtime payloads of
// six scenarios (mixed triggered and partial, partial only, no facts, a grant
// with readProvenance, unresolved scope, and records imported from a legacy or
// newer writer); and the transports, walked whole: MCP initialize, tools/list,
// tools/call, resources/read and /list, prompts/list and /get, HTTP and the CLI.
// A path the register does not classify fails the build. Set
// SHADOWGRAPH_AC060_TABLE=<file> to write the classification table as AC-060
// evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { buildToolCatalog } from '../src/mcp-tools.js';
import { createShadowGraphServer } from '../src/server.js';
import { createJsonFileStore } from '../src/storage.js';
import { privilegedIssueAccess, privilegedSnapshot } from '../src/internal/snapshot.js';
import {
  ADVICE, ADVICE_LEXICON, CONTENT_CLASSES, METADATA_CLASSES, REGISTER, RETIRED_NAMES, VARIANCE_METADATA_CLASSES,
  adviceWordsInNames, advisoryNamesIn, classificationTable, classify, isProse, mergePaths, schemaPaths, valuePaths
} from '../tools/default-path-register.js';

const NOW = '2026-01-01T00:00:00.000Z';
const mcpPath = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// One store that serves all six scenarios.
function scenarioGraph() {
  const graph = createShadowGraph({ now: () => NOW });
  const replaced = graph.addDecision({ project: 'p', title: 'old cache', chosen: 'none' });
  const cache = graph.addDecision({
    project: 'p', title: 'cache', goal: 'fast reads', chosen: 'redis', assumptions: ['traffic stays'],
    evidence: [{ source: 'runbook', sourceClass: 'measured', detail: 'p99 measured' }], reviewAfter: '2027-01-01T00:00:00.000Z',
    alternatives: [{ label: 'memcached', reasonRejected: 'operational cost', reopenWhen: [{ key: 'latency', operator: 'greater_than', value: 10, unit: 'ms' }, { key: 'region', operator: 'equals', value: 'eu' }] }]
  });
  graph.supersedeDecision({ project: 'p', decisionId: replaced.id, replacementId: cache.id });
  graph.addFact({ project: 'p', key: 'latency', value: '5ms', sourceClass: 'tool_observed' });
  graph.addFact({ project: 'p', key: 'latency', value: '30ms', sourceClass: 'tool_observed' });
  graph.addFact({ project: 'p', key: 'retired', value: 1, validFrom: '2025-01-01T00:00:00.000Z', expiresAt: '2025-06-01T00:00:00.000Z' });
  graph.addAttempt({ project: 'p', solution: 'bulk backfill', result: 'failed: quota', resultClass: 'failed', reason: 'quota', environment: 'prod', relatedTo: cache.id, reusableWhen: [{ key: 'quota', operator: 'gte', value: 600 }] });
  graph.addFact({ project: 'p', key: 'quota', value: 1200 });
  graph.setOutcome(cache.id, { status: 'failed', sourceClass: 'tool_observed' }, { project: 'p' });
  graph.addDecision({ project: 'p', title: 'lag', chosen: 'a', alternatives: [{ label: 'b', reopenWhen: [{ key: 'lagProfile', operator: 'contains', value: 'spike' }] }] });
  graph.addFact({ project: 'p', key: 'lagProfile', value: ['spike'], validFrom: '2025-12-01T00:00:00.000Z' });
  const captured = graph.addAttempt({ project: 'p', solution: 'deploy script', result: 'exit 1', resultClass: 'failed' });
  const snapshot = privilegedSnapshot(graph);
  // An attempt as capture stores it (P6): a captureRef and observed outcome evidence.
  for (const entity of [...snapshot.records, ...snapshot.journal.map((entry) => entry.payload)].filter((item) => item?.id === captured.id)) {
    Object.assign(entity, {
      captureRef: 'capture:register', outcomeEvidence: { state: 'observed', source: 'exit_status', exitStatus: 1 },
      // Claims as the extractor (P7) will store them: one of each accepted class.
      claims: [
        { text: 'the deploy failed', class: 'quoted', sourceRef: 'capture:register', span: { start: 0, end: 17 }, checks: { quantifier: 'consistent', polarity: 'consistent', actor: 'consistent', time: 'consistent', scope: 'consistent', modality: 'consistent' }, verifierVersion: 'claim-verifier-v1' },
        { text: 'the deploy did not finish', class: 'entailed', rule: 'contraction-expansion-v1', sourceRef: 'capture:register', verifierVersion: 'claim-verifier-v1' },
        { text: 'the job stopped', class: 'ambiguous', readings: ['the job stopped', 'the job stopped in staging'], sourceRef: 'capture:register', verifierVersion: 'claim-verifier-v1' }
      ]
    });
  }
  // Two equally applicable facts that disagree, as review-safety-regressions builds them.
  const lag = snapshot.facts.find((fact) => fact.key === 'lagProfile');
  snapshot.facts.push({ ...lag, id: 'fact:contested', value: ['calm'], erasureToken: 'tok_contested' });
  const store = createShadowGraph({ now: () => NOW });
  store.importData(snapshot);
  store.maintain({ project: 'p' });
  store.addDecision({ project: 'partial', title: 'region', chosen: 'us', alternatives: [{ label: 'eu', reopenWhen: [{ key: 'region', operator: 'equals', value: 'eu' }] }] });
  store.addDecision({ project: 'bare', title: 'plain', chosen: 'x' });
  // PR-26: a project-wide memory and a recorded success rank as relevant history.
  store.remember({ project: 'p', memoryType: 'procedure', key: 'cache warmup', text: 'warm the cache before a deploy', tags: ['ops'], metadata: { owner: 'platform' } });
  store.addAttempt({ project: 'p', solution: 'cache prefill', result: 'hit rate 0.97', resultClass: 'succeeded' });
  // A decision whose line cannot carry its title within the ceiling.
  store.addDecision({ project: 'p', title: `cache sizing ${'budget '.repeat(80)}`, chosen: 'fixed' });
  store.addDecision({ project: 'q', title: 'wider', chosen: 'y' });
  const grant = privilegedIssueAccess(store, { type: 'grant', scope: { projects: ['q'] }, surfaces: ['cli', 'http', 'mcp'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'register fixture' }).entry;
  return { graph: store, grant };
}

// A store a legacy or newer writer left, imported as such: status 'active',
// keys this build never writes, a legacy verified fact, and an attested fact
// with no verifier configured.
const LEGACY_IMPORT = Object.freeze({
  records: [
    { id: 'legacy-decision', kind: 'decision', project: 'legacy', title: 'legacy choice', chosen: 'x', status: 'active', rationale: 'kept from the old tool', tags: ['old'] },
    { id: 'future-decision', kind: 'decision', project: 'legacy', schemaVersion: 99, title: 'future choice', chosen: 'y', status: 'proposed', nextStep: 'a newer writer field' },
    { id: 'legacy-attempt', kind: 'attempt', project: 'legacy', solution: 'try', result: 'failed badly', resultClass: 'failed', hint: 'free text' }
  ],
  facts: [
    { id: 'legacy-fact', key: 'k', value: { actor: 'caller data' }, project: 'legacy', source: 'human-confirmed', verificationStatus: 'verified', status: 'superseded', validTo: '2025-01-01T00:00:00.000Z', note: 'free text' },
    { id: 'attested-fact', key: 'j', value: 2, project: 'legacy', sourceClass: 'tool_observed', status: 'expired', verification: { method: 'signed', attestation: 'x' } }
  ]
});
function legacyGraph() {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData(structuredClone(LEGACY_IMPORT));
  return graph;
}

function scenarioViews({ graph, grant }) {
  return {
    mixed: graph.context({ project: 'p' }),
    partial: graph.context({ project: 'partial' }),
    bare: graph.context({ project: 'bare' }),
    grant: graph.context({ project: 'p', accessId: grant.accessId }),
    unresolved: graph.context({}),
    // PR-26: the relevant block, as full records, as lines, as the working-set
    // fallback, under a grant, and over a store a legacy writer left.
    relevant: graph.context({ project: 'p', query: 'cache deploy backfill lag latency quota' }),
    relevantCompact: graph.context({ project: 'p', query: 'cache deploy backfill lag latency quota', compact: true, asOf: NOW }),
    fallback: graph.context({ project: 'p', query: 'zebra' }),
    grantRelevant: graph.context({ project: 'p', accessId: grant.accessId, query: 'wider', compact: true }),
    legacy: legacyGraph().context({ project: 'legacy', query: 'zebra' })
  };
}

async function startMcp(t, directory, file, clockFile) {
  const child = spawn(process.execPath, [mcpPath], {
    cwd: directory, stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json', SHADOWGRAPH_MCP_COMPACT: '0', SHADOWGRAPH_EMBEDDING_URL: '', SHADOWGRAPH_VERIFIER_CONFIG: '', NODE_ENV: 'test', SHADOWGRAPH_TEST_CLOCK_FILE: clockFile }
  });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  const pending = new Map();
  let buffer = '', nextId = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines.filter((item) => item.trim())) { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  return (method, params) => new Promise((done) => { const id = ++nextId; pending.set(id, done); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); })
    .then((message) => { assert.equal(message.error, undefined, `${method}: ${JSON.stringify(message.error)}`); return message.result; });
}

// Every path of the default discovery and context path, with its payloads.
async function enumerate(t) {
  const fixture = scenarioGraph();
  const views = scenarioViews(fixture);
  const tool = buildToolCatalog().find((item) => item.name === 'shadowgraph_context');
  const maps = [schemaPaths(tool.outputSchema)];
  for (const [name, view] of Object.entries(views)) maps.push(valuePaths(view, '', name));

  const directory = await scratchDirectory(t, 'default-path-register-');
  const file = join(directory, 'store.json');
  const clockFile = join(directory, 'clock.txt');
  await writeFile(clockFile, NOW, 'utf8');
  await createJsonFileStore(file).save(privilegedSnapshot(fixture.graph));
  // A confirmed binding, so the resource resolves a project and carries a payload.
  await mkdir(join(directory, '.shadowgraph'));
  await writeFile(join(directory, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(directory), project: 'p', confirmed: true }));

  const rpc = await startMcp(t, directory, file, clockFile);
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'register', version: '1.0.0' } });
  maps.push(valuePaths(initialized, 'initialize:', 'mcp initialize'));
  // Modern discovery (2026-07-28) is served per request and carries the instructions.
  const modern = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } };
  maps.push(valuePaths(await rpc('server/discover', modern), 'discover:', 'mcp server/discover'));
  const { inputSchema, outputSchema, ...listed } = (await rpc('tools/list', {})).tools.find((item) => item.name === 'shadowgraph_context');
  assert.deepEqual(outputSchema, tool.outputSchema, 'the advertised output schema is the one enumerated above');
  maps.push(valuePaths(listed, 'tool:', 'mcp tools/list'), valuePaths({ outputSchema: null }, 'tool:', 'mcp tools/list'));
  maps.push(schemaPaths(inputSchema, 'tool:inputSchema.', 'mcp tools/list'));
  const { structuredContent, ...wrapper } = await rpc('tools/call', { name: 'shadowgraph_context', arguments: { project: 'p' } });
  maps.push(valuePaths((await rpc('tools/call', { name: 'shadowgraph_context', arguments: { project: 'p', query: 'cache deploy', compact: true } })).structuredContent, '', 'mcp tools/call'));
  maps.push(valuePaths(wrapper, 'mcp:', 'mcp tools/call'), valuePaths({ structuredContent: null }, 'mcp:', 'mcp tools/call'));
  maps.push(valuePaths(structuredContent, '', 'mcp tools/call'));
  // The same calls under 2026-07-28, whose results add their own members.
  const modernCall = (method, params) => rpc(method, { ...params, ...modern });
  const { tools: modernTools, ...toolList } = await modernCall('tools/list', {});
  maps.push(valuePaths(toolList, 'tool-list:', 'mcp 2026-07-28'));
  const { inputSchema: modernInput, outputSchema: modernOutput, ...modernListed } = modernTools.find((item) => item.name === 'shadowgraph_context');
  assert.deepEqual(modernOutput, tool.outputSchema);
  maps.push(valuePaths(modernListed, 'tool:', 'mcp 2026-07-28'), schemaPaths(modernInput, 'tool:inputSchema.', 'mcp 2026-07-28'));
  const { structuredContent: modernPayload, ...modernWrapper } = await modernCall('tools/call', { name: 'shadowgraph_context', arguments: { project: 'p' } });
  assert.deepEqual(JSON.parse(modernWrapper.content[0].text), modernPayload);
  maps.push(valuePaths(modernWrapper, 'mcp:', 'mcp 2026-07-28'), valuePaths(modernPayload, '', 'mcp 2026-07-28'));
  maps.push(valuePaths(await modernCall('resources/read', { uri: 'shadowgraph://context' }), 'resource:', 'mcp 2026-07-28'));
  maps.push(valuePaths(await modernCall('resources/list', {}), 'resource-list:', 'mcp 2026-07-28'));
  const modernPrompts = await modernCall('prompts/list', {});
  maps.push(valuePaths(modernPrompts, 'prompt-list:', 'mcp 2026-07-28'));
  for (const { name } of modernPrompts.prompts) maps.push(valuePaths(await modernCall('prompts/get', { name }), 'prompt:', 'mcp 2026-07-28'));
  const resource = await rpc('resources/read', { uri: 'shadowgraph://context' });
  maps.push(valuePaths(resource, 'resource:', 'mcp resources/read'));
  const resourcePayload = JSON.parse(resource.contents[0].text);
  maps.push(valuePaths(resourcePayload, '', 'mcp resources/read'));
  maps.push(valuePaths(await rpc('resources/list', {}), 'resource-list:', 'mcp resources/list'));
  const prompts = await rpc('prompts/list', {});
  maps.push(valuePaths(prompts, 'prompt-list:', 'mcp prompts/list'));
  for (const { name } of prompts.prompts) maps.push(valuePaths(await rpc('prompts/get', { name }), 'prompt:', 'mcp prompts/get'));

  const app = await createShadowGraphServer({ file, storage: 'json', cwd: directory, apiToken: '', now: () => NOW });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise((done) => app.server.close(done)));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'p' }) });
  const body = await response.json();
  maps.push(valuePaths({ body: null }, 'http:', 'http'), valuePaths(body, '', 'http'));
  // PR-26: HTTP passes the relevance inputs through.
  const relevantBody = await (await fetch(`http://127.0.0.1:${app.server.address().port}/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'p', query: 'cache deploy', compact: true }) })).json();
  assert.equal(relevantBody.relevant.items[0].tier, 'T1');
  maps.push(valuePaths(relevantBody, '', 'http'));

  const cli = spawnSync(process.execPath, [cliPath, 'context', JSON.stringify({ project: 'p' })], { cwd: directory, encoding: 'utf8', env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' } });
  assert.equal(cli.status, 0, cli.stderr);
  const stdout = JSON.parse(cli.stdout);
  maps.push(valuePaths({ stdout: null }, 'cli:', 'cli'), valuePaths(stdout, '', 'cli'));
  // PR-26: so does the CLI.
  const relevantCli = spawnSync(process.execPath, [cliPath, 'context', JSON.stringify({ project: 'p', query: 'cache deploy', compact: true })], { cwd: directory, encoding: 'utf8', env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' } });
  assert.equal(relevantCli.status, 0, relevantCli.stderr);
  const relevantStdout = JSON.parse(relevantCli.stdout);
  assert.equal(relevantStdout.relevant.items[0].tier, 'T1');
  maps.push(valuePaths(relevantStdout, '', 'cli'));

  return { paths: mergePaths(...maps), views, wrapper, structuredContent, resource, resourcePayload, body, stdout };
}

let enumerated;
const paths = async (t) => (enumerated ??= await enumerate(t));

test('the register uses only the AC-060 labels and the recorded interface variance', () => {
  for (const item of REGISTER) {
    assert.ok(item.content !== null || item.metadata !== null, `${item.pattern} carries no class`);
    if (item.content !== null) assert.ok(CONTENT_CLASSES.includes(item.content), `${item.pattern}: ${item.content}`);
    if (item.metadata !== null) assert.ok([...METADATA_CLASSES, ...VARIANCE_METADATA_CLASSES].includes(item.metadata), `${item.pattern}: ${item.metadata}`);
  }
  assert.equal(new Set(REGISTER.map((item) => item.pattern)).size, REGISTER.length, 'no pattern is registered twice');
});

// PR-24: a claim's words are extracted statements; everything else about it,
// its checks included, is how the verifier related them to their source.
test('claim fields keep their classes wherever a claim sits', () => {
  for (const collection of ['failedAttempts', 'activeDecisions', 'staleAssumptions']) {
    const at = (field) => { const item = classify(`${collection}[].claims[].${field}`); return [item.content, item.metadata]; };
    assert.deepEqual(at('text'), ['extracted statement', null], collection);
    assert.deepEqual(at('readings[]'), ['extracted statement', null], collection);
    assert.deepEqual(at('sourceRef'), [null, 'provenance'], collection);
    assert.deepEqual(at('span.start'), [null, 'provenance'], collection);
    for (const field of ['class', 'verifierVersion', 'rule', 'checks.actor', 'checks.polarity']) assert.deepEqual(at(field), [null, 'verification state'], `${collection} ${field}`);
  }
});

test('the generator reaches deep paths on every source, and an unregistered key is caught', async (t) => {
  const { paths: found, views } = await paths(t);
  for (const path of [
    'firedConditions[].violatedConditions[].evidence.factId', 'firedConditions[].affectedAlternatives[]', 'completeness.scope.grant.accessId',
    'conditionDiagnostics[].conditions[].conflictingEvidence[].factId', 'readProvenance.scope.projects[]',
    'reusableAttempts[].satisfiedConditions[].evidence.value', 'activeDecisions[].alternatives[].reopenWhen[].operator',
    'activeDecisions[].confidence.history[].reason', 'staleAssumptions[].validityPolicy.effectiveExpirationBoundary',
    'staleAssumptions[].legacyVerificationStatus', 'staleAssumptions[].verificationUntrustedReason', 'activeDecisions[].rationale',
    'belowConfidenceThreshold[].threshold', 'firedConditions#description', 'notice.replacement.mcp',
    'tool:description', 'tool:inputSchema.project#description', 'mcp:content[].text', 'mcp:structuredContent',
    'resource:contents[].uri', 'resource-list:resources[].description', 'discover:instructions',
    'prompt-list:prompts[].description', 'prompt:messages[].content.text', 'http:body', 'cli:stdout',
    'relevant.limitation.detail', 'relevant.items[].line.expansion.scope.grantId', 'relevant.items[].line.polarity.span[].text',
    'relevant.items[].record.text', 'relevant.items[].record.metadata.owner', 'relevant.items[].record.rationale', 'relevant.scope.grant.accessId'
  ]) assert.ok(found.has(path), `the generator missed ${path}`);
  const planted = valuePaths({ ...views.mixed, zzUnregistered: { nested: 1 } }, '', 'planted');
  const unclassified = [...planted.keys()].filter((path) => classify(path) === null);
  assert.deepEqual(unclassified, ['zzUnregistered', 'zzUnregistered.nested']);
});

test('every default-path field is classified on at least one axis', async (t) => {
  const { paths: found } = await paths(t);
  const unclassified = [...found.keys()].filter((path) => classify(path) === null);
  assert.deepEqual(unclassified, [], `unclassified default-path fields:\n  ${unclassified.join('\n  ')}`);
  if (process.env.SHADOWGRAPH_AC060_TABLE) await writeFile(process.env.SHADOWGRAPH_AC060_TABLE, `${classificationTable(found)}\n`, 'utf8');
});

test('every register entry classifies at least one enumerated field', async (t) => {
  const { paths: found } = await paths(t);
  const used = new Set([...found.keys()].map((path) => classify(path)?.pattern));
  const dead = REGISTER.map((item) => item.pattern).filter((pattern) => !used.has(pattern));
  assert.deepEqual(dead, [], `register entries that classify nothing:\n  ${dead.join('\n  ')}`);
});

// A pass-through entry classifies fields a legacy or newer writer left on a
// stored record. A field this build writes must be registered on its own.
test('only imported records reach a pass-through entry', async (t) => {
  const { paths: found } = await paths(t);
  const passed = [...found].filter(([path]) => classify(path)?.passThrough);
  assert.ok(passed.some(([path]) => path === 'activeDecisions[].rationale'), 'the legacy scenario exercises pass-through');
  const fromThisBuild = passed.filter(([, { sources }]) => [...sources].some((source) => source !== 'legacy')).map(([path]) => path);
  assert.deepEqual(fromThisBuild, [], 'a field this build writes fell through to a pass-through entry');
  // Import and migration also write fields; a pass-through key must be one the
  // imported store itself carried.
  const imported = new Set([...LEGACY_IMPORT.records, ...LEGACY_IMPORT.facts].flatMap(Object.keys));
  // The key is the segment after the pass-through entry's own prefix.
  const keyOf = (path) => path.slice(classify(path).pattern.length - '.*.**'.length + 1).split(/[.[]/)[0];
  const invented = [...new Set(passed.map(([path]) => keyOf(path)))].filter((key) => !imported.has(key));
  assert.deepEqual(invented, [], 'a field this build writes on import fell through to a pass-through entry');
});

// The advisory text PR-18 pinned and PR-19 retired, verbatim. None of it may
// come back to the default path, whatever class it would be given.
const RETIRED_ADVICE_TEXTS = Object.freeze([
  'Decisions currently due for reconsideration.',
  'One decision whose rejected alternatives are due for reconsideration.',
  'The decision to reconsider.',
  'Labels of the alternatives to look at again',
  'Pass this to shadowgraph_ack_review to acknowledge this review.',
  'Questions for the low-confidence decisions in this project.',
  'Worth reconsidering, not authorised to retry.',
  'It may be worth reconsidering',
  'Conditions under which the attempt is worth repeating.',
  'Decisions in a current, actionable state',
  'Use context/retrieve before consequential work',
  'Use ShadowGraph before, during, and after consequential work.',
  'Before consequential work call context and retrieve.',
  'Review open signals before continuing.',
  'never present a stored claim as confirmed',
  'What evidence could change the decision:'
]);

// PC-01(a) and AC-026: no advice on the default channel. PR-18 pinned the
// inventory; PR-19 reworded or removed every item, keeping the facts inside it.
// The register no longer classifies anything as advice, so the guards are the
// retired texts, the retired names and the wording tripwires.
test('nothing on the default channel is advice, and no retired name returns', async (t) => {
  const { paths: found } = await paths(t);
  const advice = [...found.keys()].filter((path) => classify(path)?.content === ADVICE);
  assert.deepEqual(advice, []);
  assert.deepEqual([...new Set([...found.keys()].flatMap(advisoryNamesIn))], []);
  const retired = [...found.keys()].filter((path) => RETIRED_NAMES.some((name) => path.replace(/^[a-z-]+:/, '').split(/[.#[\]]/).includes(name)));
  assert.deepEqual(retired, [], 'a retired advisory name is back on the default path');
  const prose = [...found].filter(([path]) => path.includes('#description') || classify(path)?.generated).flatMap(([, { prose: samples }]) => [...samples]);
  assert.deepEqual(prose.filter((text) => RETIRED_NAMES.some((name) => text.includes(name))), [], 'default-path prose names a retired key');
  const everyString = [...found.values()].flatMap(({ prose: samples }) => [...samples]);
  assert.deepEqual(everyString.filter((text) => RETIRED_ADVICE_TEXTS.some((retired) => text.includes(retired))), [], 'retired advice is back on the default path');
});

test('no key name reads as an instruction', async (t) => {
  const { paths: found } = await paths(t);
  assert.deepEqual([...new Set([...found.keys()].flatMap(adviceWordsInNames))], []);
});

test('generated prose outside the advice class carries no advice wording', async (t) => {
  const { paths: found } = await paths(t);
  const failures = [];
  for (const [path, { prose }] of found) {
    const classified = classify(path);
    if (!classified?.generated || classified.content === ADVICE) continue;
    for (const text of prose) for (const pattern of ADVICE_LEXICON) if (pattern.test(text)) failures.push(`${path}: ${text}`);
  }
  assert.deepEqual(failures, []);
});

// VAR-04: a metadata-only class, interface included, covers keys and
// identifiers. Every prose value carries a content class, so a metadata-only
// value holds no whitespace at all, save two identifiers that contain a space.
// The two carriers of the serialized payload are proven to be exactly the
// classified payload.
test('every prose value carries a content class, and payload carriers are exact', async (t) => {
  const { paths: found, wrapper, structuredContent, resource, resourcePayload, body, stdout, views } = await paths(t);
  assert.deepEqual(JSON.parse(wrapper.content[0].text), structuredContent);
  assert.deepEqual(JSON.parse(resource.contents[0].text), resourcePayload);
  for (const payload of [structuredContent, resourcePayload, body, stdout]) assert.deepEqual(Object.keys(payload).sort(), Object.keys(views.mixed).sort());
  const carriers = new Set(['mcp:content[].text', 'resource:contents[].text']);
  const spacedIdentifiers = new Set(['notice.replacement.http', 'resource-list:resources[].name']);
  const prose = [];
  for (const [path, { prose: samples }] of found) {
    if (classify(path)?.content !== null || carriers.has(path)) continue;
    for (const text of samples) if (spacedIdentifiers.has(path) ? isProse(text) : /\s/.test(text)) prose.push(`${path}: ${text}`);
  }
  assert.deepEqual(prose, [], 'a prose value carries only a metadata class');
});
