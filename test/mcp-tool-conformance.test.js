// End-to-end conformance for the MCP tool metadata: what the server advertises
// has to match what it actually returns, and a session negotiated at 2024-11-05
// has to keep the tool members and the serialized result it always had.
//
// Advertising an output schema is a promise: a client that validates structured
// results throws when the promise is broken, turning a successful read into a
// user-visible failure. So every tool that declares one is exercised against a
// real store and its structured content is validated here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFactAttestation } from '../src/verification.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const LEGACY_PROTOCOL = '2024-11-05';
const MODERN_PROTOCOL = '2026-07-28';
// Every revision `initialize` can negotiate, and the wire members each one
// defines. Expectations are looked up by the revision the server RETURNED, never
// by the one a test asked for.
const NEGOTIABLE_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const WIRE_BY_NEGOTIATED = {
  '2024-11-05': { toolKeys: ['name', 'description', 'inputSchema'], structured: false },
  '2025-03-26': { toolKeys: ['name', 'description', 'inputSchema', 'annotations'], structured: false },
  '2025-06-18': { toolKeys: ['name', 'description', 'inputSchema', 'annotations', 'outputSchema'], structured: true },
  '2025-11-25': { toolKeys: ['name', 'description', 'inputSchema', 'annotations', 'outputSchema'], structured: true }
};
const OMITTED_OUTPUT_SCHEMA = ['shadowgraph_review', 'shadowgraph_review_signals'];

function modernParams(values = {}) {
  return {
    ...values,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
      'io.modelcontextprotocol/clientInfo': { name: 'shadowgraph-conformance', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {}
    }
  };
}

async function startMcp(t, extraEnv = {}) {
  const directory = await scratchDirectory(t, 'shadowgraph-conformance-');
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: join(directory, 'data.json'), ...extraEnv },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  // Registered after the directory is taken, so it runs before the removal the
  // helper appends: the child must be gone before its store is taken away, or it
  // writes into a directory that is being removed underneath it.
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  t.after(stop);
  let buffer = '';
  const pending = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      pending.shift()?.resolve(JSON.parse(line));
    }
  });
  child.on('error', (error) => pending.shift()?.reject(error));
  let nextId = 1;
  const rpc = {
    directory,
    call(method, params, timeoutMs = 15000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
        pending.push({
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); }
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    async initialize(protocolVersion) {
      const response = await rpc.call('initialize', {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'shadowgraph-conformance', version: '1.0.0' }
      });
      // The server answers with a revision it actually implements. Callers use
      // the RETURNED value to decide what the rest of the session may contain.
      const negotiated = response.result.protocolVersion;
      assert.ok(NEGOTIABLE_PROTOCOLS.includes(negotiated), `initialize returned an unimplemented revision: ${negotiated}`);
      return negotiated;
    },
    async listTools(params = {}) {
      const response = await rpc.call('tools/list', params);
      assert.equal(response.error, undefined, `tools/list failed: ${JSON.stringify(response.error)}`);
      return response.result;
    }
  };
  return rpc;
}

// The same dependency-free JSON Schema subset validator the metadata test uses.
// It is duplicated rather than shared because every file under test/ is executed
// as a test file by `npm test`.
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function validate(schema, value, path = '$', errors = []) {
  const fail = (message) => errors.push(`${path}: ${message}`);
  if (schema.type !== undefined) {
    const matches = {
      object: isObject(value),
      array: Array.isArray(value),
      string: typeof value === 'string',
      number: typeof value === 'number' && Number.isFinite(value),
      integer: Number.isInteger(value),
      boolean: typeof value === 'boolean',
      null: value === null
    }[schema.type];
    if (!matches) { fail(`expected ${schema.type}`); return errors; }
  }
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) fail(`value not in enum ${JSON.stringify(schema.enum)}`);
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) fail(`value is not ${JSON.stringify(schema.const)}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`above maximum ${schema.maximum}`);
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing required property ${key}`);
    for (const [key, subschema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validate(subschema, value[key], `${path}.${key}`, errors);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`, errors));
  }
  if (schema.anyOf && !schema.anyOf.some((branch) => validate(branch, value, path, []).length === 0)) fail('no anyOf branch matched');
  return errors;
}

// Calls one tool, then checks the whole advertised contract for that call.
function conformingCaller(rpc, schemas, exercised) {
  return async function callTool(name, args = {}) {
    const response = await rpc.call('tools/call', { name, arguments: args });
    assert.equal(response.error, undefined, `${name} failed: ${JSON.stringify(response.error)}`);
    const result = response.result;
    const schema = schemas.get(name);
    if (schema) {
      assert.deepEqual(Object.keys(result), ['content', 'structuredContent'], `${name} must return structured content alongside the serialized text`);
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, `${name} text and structured content must agree`);
      const errors = validate(schema, result.structuredContent);
      assert.deepEqual(errors, [], `${name} structured content violates its advertised output schema: ${errors.join('; ')}`);
    } else {
      assert.deepEqual(Object.keys(result), ['content'], `${name} declares no output schema, so it must not emit structured content`);
    }
    assert.equal(result.content[0].type, 'text');
    exercised.add(name);
    return JSON.parse(result.content[0].text);
  };
}

test('every advertised output schema accepts the result its own tool really returns', async (t) => {
  const rpc = await startMcp(t);
  await rpc.initialize('2025-06-18');
  const listed = await rpc.listTools({});
  assert.equal(listed.tools.length, 27);

  const schemas = new Map();
  for (const tool of listed.tools) {
    if (OMITTED_OUTPUT_SCHEMA.includes(tool.name)) {
      assert.equal(Object.hasOwn(tool, 'outputSchema'), false, `${tool.name} must not advertise an output schema`);
      assert.deepEqual(Object.keys(tool), ['name', 'description', 'inputSchema', 'annotations']);
      continue;
    }
    assert.deepEqual(Object.keys(tool), ['name', 'description', 'inputSchema', 'annotations', 'outputSchema']);
    assert.equal(tool.outputSchema.type, 'object');
    schemas.set(tool.name, tool.outputSchema);
  }
  assert.equal(schemas.size, 25);

  const exercised = new Set();
  const callTool = conformingCaller(rpc, schemas, exercised);
  const project = 'conformance';

  const decisionA = await callTool('shadowgraph_record_decision', {
    project,
    title: 'Adopt single-user deployment',
    chosen: 'single-user',
    goal: 'ship the preview',
    confidence: 0.4,
    assumptions: ['the deployment stays single-user'],
    evidence: ['a hallway conversation', { source: 'benchmark', detail: 'local run', sourceClass: 'tool_observed' }],
    alternatives: [{ label: 'multi-user', reasonRejected: 'too much work now', reopenWhen: [{ key: 'deployment', operator: 'equals', value: 'multi-user' }] }],
    idempotencyKey: 'decision-a',
    sourceClass: 'agent_claimed',
    actor: 'conformance-test'
  });
  const decisionB = await callTool('shadowgraph_record_decision', { project, title: 'Adopt multi-user deployment', chosen: 'multi-user' });

  // A retry with the same idempotency key returns the first decision.
  const retried = await callTool('shadowgraph_record_decision', { project, title: 'Adopt single-user deployment', chosen: 'single-user', idempotencyKey: 'decision-a' });
  assert.equal(retried.id, decisionA.id);

  await callTool('shadowgraph_record_fact', { project, key: 'deployment', value: 'multi-user', sourceClass: 'tool_observed', confidence: 0.9 });

  const due = await callTool('shadowgraph_review', { project });
  assert.equal(Array.isArray(due), true, 'shadowgraph_review returns a bare array');
  assert.equal(due.some((item) => item.decisionId === decisionA.id), true);

  const signals = await callTool('shadowgraph_review_signals', { project, status: 'open' });
  assert.equal(Array.isArray(signals), true, 'shadowgraph_review_signals returns a bare array');
  assert.ok(signals.length >= 1);
  const acknowledged = await callTool('shadowgraph_ack_review', { id: signals[0].id });
  assert.equal(acknowledged.status, 'acknowledged');

  await callTool('shadowgraph_record_attempt', { project, solution: 'rolled out to everyone', result: 'failed during rollout', reason: 'no migration path', environment: 'node 24' });

  const added = await callTool('shadowgraph_remember', { project, scope: { userId: 'alice' }, memoryType: 'preference', key: 'hotel-style', text: 'Prefers quiet boutique hotels' });
  assert.equal(added.operation, 'ADD');
  const unchanged = await callTool('shadowgraph_remember', { project, scope: { userId: 'alice' }, memoryType: 'preference', key: 'hotel-style', text: 'Prefers quiet boutique hotels' });
  assert.equal(unchanged.operation, 'NOOP');
  const planned = await callTool('shadowgraph_remember', {
    project,
    scope: { userId: 'alice' },
    operations: [
      { action: 'ADD', memoryType: 'note', key: 'trip-note', text: 'Tokyo in spring' },
      { action: 'NOOP', memoryType: 'note', key: 'absent-note' },
      { action: 'DELETE', memoryType: 'note', key: 'trip-note' }
    ]
  });
  assert.deepEqual(planned.results.map((item) => item.operation), ['ADD', 'NOOP', 'DELETE']);
  assert.equal(planned.results[1].memory, null);

  await callTool('shadowgraph_recall', { project, scope: { userId: 'alice' }, query: 'hotels', preferRecent: true, limit: 5 });
  await callTool('shadowgraph_search', { project, query: 'rollout' });
  await callTool('shadowgraph_context', { project });
  await callTool('shadowgraph_link', { from: decisionA.id, to: decisionB.id, relation: 'informs' });
  await callTool('shadowgraph_traverse', { id: decisionA.id, depth: 2, direction: 'both' });
  // Retrieved after the link so a one-hop graph neighbour is really present.
  const retrieved = await callTool('shadowgraph_retrieve', { project, query: '' });
  assert.equal(retrieved.completeness.includesGraphNeighbours, true);

  await callTool('shadowgraph_update_status', { decisionId: decisionB.id, status: 'planned' });
  await callTool('shadowgraph_record_outcome', { decisionId: decisionB.id, outcome: { status: 'successful', sourceClass: 'tool_observed', lessons: ['migration first'] } });
  await callTool('shadowgraph_confidence_evidence', { decisionId: decisionB.id, reason: 'a second successful rollout', key: 'evidence-1', supports: true });
  const superseded = await callTool('shadowgraph_supersede', { decisionId: decisionA.id, replacementId: decisionB.id });
  assert.equal(superseded.previous.status, 'superseded');

  await callTool('shadowgraph_maintain', {});
  const validated = await callTool('shadowgraph_validate', {});
  assert.equal(validated.valid, true, `store must stay valid: ${JSON.stringify(validated.issues)}`);
  const journal = await callTool('shadowgraph_journal', { project, limit: 5 });
  assert.equal(journal.page.hasMore, true, 'a small limit must report that more entries exist');
  await callTool('shadowgraph_rebuild', {});
  await callTool('shadowgraph_purge_preview', { project });
  await callTool('shadowgraph_repair_plan', {});
  await callTool('shadowgraph_redact', { project });

  const destination = join(rpc.directory, 'backups', 'snapshot.json');
  const backup = await callTool('shadowgraph_backup', { destination });
  assert.equal(backup.destination, destination);
  const restored = await callTool('shadowgraph_restore', { source: destination });
  assert.equal(restored.source, destination);
  const purged = await callTool('shadowgraph_purge', { project, mode: 'logical' });
  assert.equal(purged.mode, 'logical');

  // Nothing may be left untested: a tool that advertises a schema but is never
  // exercised here is an unverified promise.
  const advertised = listed.tools.map((tool) => tool.name);
  const missing = advertised.filter((name) => !exercised.has(name));
  assert.deepEqual(missing, [], `these advertised tools were never exercised: ${missing.join(', ')}`);
});

test('a legacy tool-execution failure stays a protocol error and carries no structured content', async (t) => {
  const rpc = await startMcp(t);
  await rpc.initialize('2025-11-25');
  const failed = await rpc.call('tools/call', { name: 'shadowgraph_update_status', arguments: { decisionId: 'missing', status: 'planned' } });
  assert.equal(failed.result, undefined);
  assert.equal(failed.error.code, -32000);
  assert.match(failed.error.message, /Decision not found/u);
});

test('the verifier build advertises and satisfies the verification tool contract', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-conformance-verifier-');
  const evidenceRoot = join(directory, 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const keys = generateKeyPairSync('ed25519');
  const configPath = join(directory, 'verifier.json');
  await writeFile(configPath, JSON.stringify({
    allowedEvidenceRoot: evidenceRoot,
    trustedVerifiers: { approver: keys.publicKey.export({ type: 'spki', format: 'pem' }) }
  }), 'utf8');

  const rpc = await startMcp(t, { SHADOWGRAPH_VERIFIER_CONFIG: configPath });
  await rpc.initialize('2025-11-25');
  const listed = await rpc.listTools({});
  assert.equal(listed.tools.length, 28);
  const verifyTool = listed.tools.find((tool) => tool.name === 'shadowgraph_verify_fact');
  assert.ok(verifyTool, 'the verification tool must be advertised when a verifier is configured');
  assert.deepEqual(verifyTool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.equal(verifyTool.outputSchema.type, 'object');

  const schemas = new Map(listed.tools.filter((tool) => tool.outputSchema).map((tool) => [tool.name, tool.outputSchema]));
  const callTool = conformingCaller(rpc, schemas, new Set());
  const fact = await callTool('shadowgraph_record_fact', { project: 'app', key: 'release', value: 'ready' });
  const evidencePath = join(evidenceRoot, 'signed.json');
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({
    fact,
    verifierIdentity: 'approver',
    evidenceReference: 'ticket:MCP-1',
    verifiedAt: '2026-08-27T00:00:00.000Z',
    privateKey: keys.privateKey
  })), 'utf8');

  const verified = await callTool('shadowgraph_verify_fact', { factId: fact.id, evidencePath });
  assert.equal(verified.operation, 'VERIFIED');
  assert.equal(verified.fact.verificationStatus, 'verified');
  const repeated = await callTool('shadowgraph_verify_fact', { factId: fact.id, evidencePath });
  assert.equal(repeated.operation, 'NOOP');
});

test('initialize negotiates a revision, and the wire shape follows the one it RETURNED', async (t) => {
  // Requested values, and the revision this server answers with. Anything it has
  // not implemented is answered with the latest revision it has, so an unknown
  // or future value can never select metadata by itself.
  const cases = [
    ['2024-11-05', '2024-11-05'],
    ['2025-03-26', '2025-03-26'],
    ['2025-06-18', '2025-06-18'],
    ['2025-11-25', '2025-11-25'],
    ['2026-07-28', '2025-11-25'],
    ['2099-01-01', '2025-11-25'],
    ['not-a-revision', '2025-11-25'],
    ['2025-3-26', '2025-11-25']
  ];
  for (const [requested, expected] of cases) {
    const rpc = await startMcp(t);
    const negotiated = await rpc.initialize(requested);
    assert.equal(negotiated, expected, `requested ${requested}`);
    // Everything below is derived from `negotiated`, never from `requested`.
    const wire = WIRE_BY_NEGOTIATED[negotiated];
    assert.ok(wire, `no expectation recorded for negotiated revision ${negotiated}`);
    const listed = await rpc.listTools({});
    assert.equal(listed.tools.length, 27, `requested ${requested}`);
    const validateTool = listed.tools.find((tool) => tool.name === 'shadowgraph_validate');
    assert.deepEqual(Object.keys(validateTool), wire.toolKeys, `negotiated ${negotiated} tool members`);
    // A tool that declares no output schema never gains that member, at any tier.
    const reviewTool = listed.tools.find((tool) => tool.name === 'shadowgraph_review');
    assert.deepEqual(
      Object.keys(reviewTool),
      wire.toolKeys.filter((key) => key !== 'outputSchema'),
      `negotiated ${negotiated} members of a tool with no output schema`
    );
    if (wire.toolKeys.includes('annotations')) {
      assert.deepEqual(validateTool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    }
    const called = await rpc.call('tools/call', { name: 'shadowgraph_validate', arguments: {} });
    assert.deepEqual(
      Object.keys(called.result),
      wire.structured ? ['content', 'structuredContent'] : ['content'],
      `negotiated ${negotiated} result members`
    );
    assert.equal(Object.hasOwn(called.result, 'resultType'), false, 'a handshake result never gains modern members');
    const reviewed = await rpc.call('tools/call', { name: 'shadowgraph_review', arguments: {} });
    assert.deepEqual(Object.keys(reviewed.result), ['content'], 'a bare-array tool never emits structured content');
  }
});

test('a malformed protocolVersion is invalid params and leaves the session untouched', async (t) => {
  for (const [label, params] of [
    ['omitted', { capabilities: {} }],
    ['empty', { protocolVersion: '', capabilities: {} }],
    ['numeric', { protocolVersion: 42, capabilities: {} }]
  ]) {
    const rpc = await startMcp(t);
    const rejected = await rpc.call('initialize', params);
    assert.equal(rejected.result, undefined, label);
    assert.equal(rejected.error.code, -32602, label);
    // Rejected: the session never negotiated, so it stays at the fail-closed tier.
    const listed = await rpc.listTools({});
    const validateTool = listed.tools.find((tool) => tool.name === 'shadowgraph_validate');
    assert.deepEqual(Object.keys(validateTool), ['name', 'description', 'inputSchema'], label);
  }
});

test('a later initialize renegotiates, in both directions', async (t) => {
  const rpc = await startMcp(t);
  const first = await rpc.initialize('2025-11-25');
  assert.equal(first, '2025-11-25');
  const structured = await rpc.listTools({});
  assert.deepEqual(Object.keys(structured.tools.find((tool) => tool.name === 'shadowgraph_validate')), WIRE_BY_NEGOTIATED['2025-11-25'].toolKeys);

  const second = await rpc.initialize(LEGACY_PROTOCOL);
  assert.equal(second, LEGACY_PROTOCOL);
  const bare = await rpc.listTools({});
  assert.deepEqual(Object.keys(bare.tools.find((tool) => tool.name === 'shadowgraph_validate')), WIRE_BY_NEGOTIATED[LEGACY_PROTOCOL].toolKeys);
  const called = await rpc.call('tools/call', { name: 'shadowgraph_validate', arguments: {} });
  assert.deepEqual(Object.keys(called.result), ['content'], 'renegotiating down also drops structured content');

  const third = await rpc.initialize('2025-03-26');
  assert.equal(third, '2025-03-26');
  const annotated = await rpc.listTools({});
  assert.deepEqual(Object.keys(annotated.tools.find((tool) => tool.name === 'shadowgraph_validate')), WIRE_BY_NEGOTIATED['2025-03-26'].toolKeys);

  // A rejected handshake must not disturb the tier the session already has.
  const rejected = await rpc.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: null });
  assert.equal(rejected.error.code, -32602);
  const unchanged = await rpc.listTools({});
  assert.deepEqual(Object.keys(unchanged.tools.find((tool) => tool.name === 'shadowgraph_validate')), WIRE_BY_NEGOTIATED['2025-03-26'].toolKeys);
});

test('a session that never initializes keeps the pre-2025 wire shape, in full and compact mode', async (t) => {
  for (const [mode, expectedCount] of [['0', 27], ['1', 12]]) {
    const rpc = await startMcp(t, { SHADOWGRAPH_MCP_COMPACT: mode });
    const listed = await rpc.listTools({});
    assert.equal(listed.tools.length, expectedCount, `compact=${mode}`);
    for (const tool of listed.tools) {
      assert.deepEqual(Object.keys(tool), ['name', 'description', 'inputSchema'], `${tool.name} with compact=${mode}`);
    }
    const called = await rpc.call('tools/call', { name: 'shadowgraph_validate', arguments: {} });
    assert.deepEqual(Object.keys(called.result), ['content']);
  }
});

test('modern requests receive the full metadata regardless of any handshake', async (t) => {
  const rpc = await startMcp(t);
  const listed = await rpc.call('tools/list', modernParams());
  assert.equal(listed.result.tools.length, 27);
  assert.equal(listed.result.resultType, 'complete');
  const validateTool = listed.result.tools.find((tool) => tool.name === 'shadowgraph_validate');
  assert.deepEqual(Object.keys(validateTool), ['name', 'description', 'inputSchema', 'annotations', 'outputSchema']);

  const called = await rpc.call('tools/call', modernParams({ name: 'shadowgraph_validate', arguments: {} }));
  assert.equal(called.result.isError, false);
  assert.equal(called.result.resultType, 'complete');
  assert.deepEqual(JSON.parse(called.result.content[0].text), called.result.structuredContent);

  // A modern tool-execution failure is a result, not a protocol error, and it
  // carries no structured content to validate.
  const failed = await rpc.call('tools/call', modernParams({ name: 'shadowgraph_update_status', arguments: { decisionId: 'missing', status: 'planned' } }));
  assert.equal(failed.result.isError, true);
  assert.equal(Object.hasOwn(failed.result, 'structuredContent'), false);

  // A modern request does not change what a later legacy request receives.
  const legacyListed = await rpc.listTools({});
  const legacyValidate = legacyListed.tools.find((tool) => tool.name === 'shadowgraph_validate');
  assert.deepEqual(Object.keys(legacyValidate), ['name', 'description', 'inputSchema']);
});

test('tools/list is deterministic within a session and across processes', async (t) => {
  const first = await startMcp(t);
  await first.initialize('2025-11-25');
  const one = await first.listTools({});
  const two = await first.listTools({});
  assert.equal(JSON.stringify(one), JSON.stringify(two), 'repeated tools/list must be byte-identical');

  const second = await startMcp(t);
  await second.initialize('2025-11-25');
  const other = await second.listTools({});
  assert.equal(JSON.stringify(one), JSON.stringify(other), 'two processes with the same configuration must advertise identical bytes');

  for (const tool of one.tools) {
    assert.equal(tool.description.includes('\r'), false, `${tool.name} description must not carry a carriage return`);
  }
});
