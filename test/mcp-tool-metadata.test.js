// Fail-closed contract tests for the MCP tool metadata catalog.
//
// Every expectation here is a literal written out in this file rather than
// derived from src/mcp-tools.js, so a change to the catalog has to be restated
// here to pass. That is the point: tool metadata is a public contract for
// agents, and it should not be possible to silently rename a tool, drop a
// property description, weaken an annotation, or add an output schema that
// legacy data cannot satisfy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_PROTOCOL_VERSIONS,
  COMPACT_TOOL_NAMES,
  LEGACY_PROTOCOL_VERSIONS,
  METADATA_TIER,
  OUTPUT_SCHEMA_OMISSIONS,
  buildToolCatalog,
  metadataTierForProtocolVersion,
  negotiateLegacyProtocolVersion,
  projectTool,
  selectTools,
  toolResult
} from '../src/mcp-tools.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { measureAll } from '../scripts/mcp-wire-size.mjs';

// --- expected inventory ----------------------------------------------------
const FULL_TOOL_NAMES = [
  'shadowgraph_record_decision',
  'shadowgraph_record_attempt',
  'shadowgraph_review',
  'shadowgraph_search',
  'shadowgraph_context',
  'shadowgraph_remember',
  'shadowgraph_recall',
  'shadowgraph_record_fact',
  'shadowgraph_record_outcome',
  'shadowgraph_confidence_evidence',
  'shadowgraph_update_status',
  'shadowgraph_link',
  'shadowgraph_traverse',
  'shadowgraph_supersede',
  'shadowgraph_redact',
  'shadowgraph_purge',
  'shadowgraph_maintain',
  'shadowgraph_retrieve',
  'shadowgraph_validate',
  'shadowgraph_journal',
  'shadowgraph_rebuild',
  'shadowgraph_review_signals',
  'shadowgraph_purge_preview',
  'shadowgraph_ack_review',
  'shadowgraph_repair_plan',
  'shadowgraph_backup',
  'shadowgraph_restore'
];
const COMPACT_EXPECTED = [
  'shadowgraph_record_decision',
  'shadowgraph_record_attempt',
  'shadowgraph_review',
  'shadowgraph_search',
  'shadowgraph_context',
  'shadowgraph_remember',
  'shadowgraph_recall',
  'shadowgraph_record_fact',
  'shadowgraph_record_outcome',
  'shadowgraph_maintain',
  'shadowgraph_retrieve',
  'shadowgraph_validate'
];
// The exact set src/mcp.js used to spell out inline as a name list. A tool that
// writes but is missing here would silently stop being saved.
const PERSISTING_EXPECTED = [
  'shadowgraph_ack_review',
  'shadowgraph_backup',
  'shadowgraph_confidence_evidence',
  'shadowgraph_context',
  'shadowgraph_link',
  'shadowgraph_maintain',
  'shadowgraph_purge',
  'shadowgraph_record_attempt',
  'shadowgraph_record_decision',
  'shadowgraph_record_fact',
  'shadowgraph_record_outcome',
  'shadowgraph_remember',
  'shadowgraph_review',
  'shadowgraph_supersede',
  'shadowgraph_update_status',
  'shadowgraph_verify_fact'
];
// [readOnlyHint, destructiveHint, idempotentHint, openWorldHint], derived from
// what each handler actually does and proven against the running server by
// test/mcp-tool-effects.test.js. openWorldHint for recall and remember is
// asserted separately because it depends on whether an embedding endpoint was
// configured.
//
// Only the eleven pure reads are idempotent: every other tool commits a new
// durable revision on each successful call, even when the domain result is a
// no-op, and that revision is the concurrency token other writers compare.
const ANNOTATIONS_EXPECTED = {
  shadowgraph_record_decision: [false, false, false, false],
  shadowgraph_record_attempt: [false, false, false, false],
  shadowgraph_review: [false, false, false, false],
  shadowgraph_search: [true, false, true, false],
  shadowgraph_context: [false, false, false, false],
  shadowgraph_remember: [false, false, false, false],
  shadowgraph_recall: [true, false, true, false],
  shadowgraph_record_fact: [false, false, false, false],
  shadowgraph_record_outcome: [false, false, false, false],
  shadowgraph_confidence_evidence: [false, false, false, false],
  shadowgraph_update_status: [false, false, false, false],
  shadowgraph_link: [false, false, false, false],
  shadowgraph_traverse: [true, false, true, false],
  shadowgraph_supersede: [false, false, false, false],
  shadowgraph_redact: [true, false, true, false],
  shadowgraph_purge: [false, true, false, false],
  shadowgraph_maintain: [false, false, false, false],
  shadowgraph_retrieve: [true, false, true, false],
  shadowgraph_validate: [true, false, true, false],
  shadowgraph_journal: [true, false, true, false],
  shadowgraph_rebuild: [true, false, true, false],
  shadowgraph_review_signals: [true, false, true, false],
  shadowgraph_purge_preview: [true, false, true, false],
  shadowgraph_ack_review: [false, true, false, false],
  shadowgraph_repair_plan: [true, false, true, false],
  shadowgraph_backup: [false, true, false, true],
  shadowgraph_restore: [false, true, false, true],
  shadowgraph_verify_fact: [false, false, false, true]
};
// Overlapping tools must name the siblings a model would otherwise confuse them
// with, so routing is decidable from the description alone.
const ROUTING_EXPECTED = {
  shadowgraph_search: ['shadowgraph_retrieve', 'shadowgraph_recall', 'shadowgraph_context', 'shadowgraph_traverse'],
  shadowgraph_retrieve: ['shadowgraph_search', 'shadowgraph_recall', 'shadowgraph_traverse', 'shadowgraph_context'],
  shadowgraph_recall: ['shadowgraph_search', 'shadowgraph_retrieve', 'shadowgraph_remember'],
  shadowgraph_context: ['shadowgraph_search', 'shadowgraph_retrieve', 'shadowgraph_recall', 'shadowgraph_review'],
  shadowgraph_traverse: ['shadowgraph_search', 'shadowgraph_recall', 'shadowgraph_retrieve'],
  shadowgraph_review: ['shadowgraph_review_signals', 'shadowgraph_ack_review', 'shadowgraph_maintain'],
  shadowgraph_review_signals: ['shadowgraph_review', 'shadowgraph_ack_review'],
  shadowgraph_ack_review: ['shadowgraph_review_signals', 'shadowgraph_review', 'shadowgraph_update_status', 'shadowgraph_supersede'],
  shadowgraph_maintain: ['shadowgraph_review', 'shadowgraph_validate', 'shadowgraph_update_status'],
  shadowgraph_purge: ['shadowgraph_purge_preview', 'shadowgraph_redact', 'shadowgraph_backup'],
  shadowgraph_purge_preview: ['shadowgraph_purge'],
  shadowgraph_backup: ['shadowgraph_purge', 'shadowgraph_restore', 'shadowgraph_redact'],
  shadowgraph_restore: ['shadowgraph_purge', 'shadowgraph_backup'],
  shadowgraph_redact: ['shadowgraph_backup', 'shadowgraph_purge'],
  shadowgraph_validate: ['shadowgraph_repair_plan', 'shadowgraph_rebuild'],
  shadowgraph_repair_plan: ['shadowgraph_validate'],
  shadowgraph_journal: ['shadowgraph_rebuild', 'shadowgraph_validate', 'shadowgraph_search'],
  shadowgraph_rebuild: ['shadowgraph_journal', 'shadowgraph_validate'],
  shadowgraph_link: ['shadowgraph_traverse', 'shadowgraph_supersede'],
  shadowgraph_supersede: ['shadowgraph_update_status', 'shadowgraph_link'],
  shadowgraph_update_status: ['shadowgraph_supersede', 'shadowgraph_maintain', 'shadowgraph_record_outcome'],
  shadowgraph_record_decision: ['shadowgraph_record_attempt', 'shadowgraph_record_fact', 'shadowgraph_remember'],
  shadowgraph_record_attempt: ['shadowgraph_record_decision', 'shadowgraph_record_outcome'],
  shadowgraph_record_fact: ['shadowgraph_remember'],
  shadowgraph_record_outcome: ['shadowgraph_confidence_evidence', 'shadowgraph_update_status'],
  shadowgraph_confidence_evidence: ['shadowgraph_record_outcome', 'shadowgraph_record_fact'],
  shadowgraph_remember: ['shadowgraph_record_decision', 'shadowgraph_record_fact', 'shadowgraph_recall'],
  shadowgraph_verify_fact: ['shadowgraph_record_fact']
};
// Constraints that existed before descriptions were written, pinned so a
// documentation pass cannot quietly change what a host will accept.
const INPUT_CONSTRAINTS_EXPECTED = {
  shadowgraph_record_decision: { required: ['title', 'chosen'], enums: {} },
  shadowgraph_record_attempt: { required: ['solution', 'result'], enums: {} },
  shadowgraph_review: { required: null, enums: {} },
  shadowgraph_search: { required: null, enums: { kind: ['decision', 'attempt'] } },
  shadowgraph_context: { required: null, enums: {} },
  shadowgraph_remember: { required: null, enums: {} },
  shadowgraph_recall: { required: null, enums: {} },
  shadowgraph_record_fact: { required: ['key'], enums: { verificationStatus: ['unverified', 'contradicted'] } },
  shadowgraph_record_outcome: { required: ['decisionId', 'outcome'], enums: {} },
  shadowgraph_confidence_evidence: { required: ['decisionId', 'reason', 'key'], enums: {} },
  shadowgraph_update_status: { required: ['decisionId', 'status'], enums: {} },
  shadowgraph_link: { required: ['from', 'to', 'relation'], enums: {} },
  shadowgraph_traverse: { required: ['id'], enums: { direction: ['in', 'out', 'both'] } },
  shadowgraph_supersede: { required: ['decisionId', 'replacementId'], enums: {} },
  shadowgraph_redact: { required: null, enums: {} },
  shadowgraph_purge: { required: ['project'], enums: { mode: ['logical', 'hard'] } },
  shadowgraph_maintain: { required: null, enums: {} },
  shadowgraph_retrieve: { required: null, enums: { kind: ['decision', 'attempt'] } },
  shadowgraph_validate: { required: null, enums: {} },
  shadowgraph_journal: { required: null, enums: {} },
  shadowgraph_rebuild: { required: null, enums: {} },
  shadowgraph_review_signals: { required: null, enums: { status: ['open', 'acknowledged'] } },
  shadowgraph_purge_preview: { required: ['project'], enums: {} },
  shadowgraph_ack_review: { required: ['id'], enums: {} },
  shadowgraph_repair_plan: { required: null, enums: {} },
  shadowgraph_backup: { required: ['destination'], enums: {} },
  shadowgraph_restore: { required: ['source'], enums: {} },
  shadowgraph_verify_fact: { required: ['factId', 'evidencePath'], enums: {} }
};

const fullCatalog = buildToolCatalog();
const verifierCatalog = buildToolCatalog({ verifier: true });
const byName = new Map(verifierCatalog.map((entry) => [entry.name, entry]));

// --- a JSON Schema subset validator ---------------------------------------
// Deliberately small and dependency-free. It covers exactly the keywords the
// output schemas are allowed to use, which is also asserted below, so a schema
// this validator cannot interpret is a test failure rather than a silent pass.
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
    if (!matches) { fail(`expected ${schema.type}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`); return errors; }
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

function assertValid(schema, value, label) {
  const errors = validate(schema, value);
  assert.deepEqual(errors, [], `${label} does not conform to its output schema: ${errors.join('; ')}`);
}

// --- schema walkers --------------------------------------------------------
function walkProperties(node, visit, path = 'schema', depth = 0) {
  if (!isObject(node) || depth > 20) return;
  for (const [name, property] of Object.entries(node.properties ?? {})) {
    visit(name, property, `${path}.properties.${name}`);
    walkProperties(property, visit, `${path}.properties.${name}`, depth + 1);
  }
  if (isObject(node.items)) walkProperties(node.items, visit, `${path}.items`, depth + 1);
  for (const [index, branch] of [...(node.anyOf ?? []), ...(node.oneOf ?? [])].entries()) {
    walkProperties(branch, visit, `${path}.branch[${index}]`, depth + 1);
  }
  for (const [name, definition] of Object.entries(node.$defs ?? {})) walkProperties(definition, visit, `${path}.$defs.${name}`, depth + 1);
}

function walkNodes(node, visit, path = 'schema', depth = 0) {
  if (!isObject(node) || depth > 20) return;
  visit(node, path);
  for (const [name, property] of Object.entries(node.properties ?? {})) walkNodes(property, visit, `${path}.properties.${name}`, depth + 1);
  if (isObject(node.items)) walkNodes(node.items, visit, `${path}.items`, depth + 1);
  for (const [index, branch] of [...(node.anyOf ?? []), ...(node.oneOf ?? [])].entries()) walkNodes(branch, visit, `${path}.branch[${index}]`, depth + 1);
}

test('the catalog advertises exactly the documented full, compact, and verifier inventories', () => {
  assert.deepEqual(fullCatalog.map((entry) => entry.name), FULL_TOOL_NAMES);
  assert.equal(fullCatalog.length, 27);
  assert.deepEqual(verifierCatalog.map((entry) => entry.name), [...FULL_TOOL_NAMES, 'shadowgraph_verify_fact']);
  assert.equal(verifierCatalog.length, 28);

  const compact = selectTools(fullCatalog, { compact: true });
  assert.deepEqual(compact.map((entry) => entry.name), COMPACT_EXPECTED);
  assert.equal(compact.length, 12);
  assert.deepEqual([...COMPACT_TOOL_NAMES], COMPACT_EXPECTED);

  // The optional verification tool is a full-mode capability only.
  const compactWithVerifier = selectTools(verifierCatalog, { compact: true });
  assert.deepEqual(compactWithVerifier.map((entry) => entry.name), COMPACT_EXPECTED);

  assert.equal(new Set(verifierCatalog.map((entry) => entry.name)).size, 28);
  for (const entry of verifierCatalog) assert.match(entry.name, /^shadowgraph_[a-z_]+$/u);
});

test('every tool carries the four behavioural annotations its handler actually justifies', () => {
  assert.equal(Object.keys(ANNOTATIONS_EXPECTED).length, 28);
  for (const entry of verifierCatalog) {
    const expected = ANNOTATIONS_EXPECTED[entry.name];
    assert.ok(expected, `${entry.name} has no expected annotation row`);
    assert.deepEqual(Object.keys(entry.annotations).sort(), ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'], `${entry.name} annotation keys`);
    for (const value of Object.values(entry.annotations)) assert.equal(typeof value, 'boolean', `${entry.name} annotations must all be booleans`);
    assert.deepEqual(
      [entry.annotations.readOnlyHint, entry.annotations.destructiveHint, entry.annotations.idempotentHint, entry.annotations.openWorldHint],
      expected,
      `${entry.name} annotations`
    );
  }
});

test('a read-only tool never persists, and every other writing tool does except restore', () => {
  const persisting = verifierCatalog.filter((entry) => entry.persists).map((entry) => entry.name).sort();
  assert.deepEqual(persisting, PERSISTING_EXPECTED);
  assert.equal(persisting.length, 16);
  for (const entry of verifierCatalog) {
    // shadowgraph_restore writes, but its storage backend commits the
    // replacement itself, so src/mcp.js must not save again afterwards.
    const expected = !entry.annotations.readOnlyHint && entry.name !== 'shadowgraph_restore';
    assert.equal(entry.persists, expected, `${entry.name} persists flag must agree with readOnlyHint`);
    if (entry.annotations.readOnlyHint) {
      assert.equal(entry.annotations.destructiveHint, false, `${entry.name} cannot be both read-only and destructive`);
      assert.equal(entry.annotations.idempotentHint, true, `${entry.name} is read-only, so repeating it changes nothing`);
    } else {
      // Every writing tool, and restore, commits a durable revision per call.
      assert.equal(entry.annotations.idempotentHint, false, `${entry.name} commits a revision on every call, so it is not idempotent`);
    }
  }
});

test('recall and remember declare an open world only when an embedding endpoint is configured', () => {
  const withEmbedding = buildToolCatalog({ verifier: true, embeddingConfigured: true });
  const openWorld = withEmbedding.filter((entry) => entry.annotations.openWorldHint).map((entry) => entry.name).sort();
  assert.deepEqual(openWorld, ['shadowgraph_backup', 'shadowgraph_recall', 'shadowgraph_remember', 'shadowgraph_restore', 'shadowgraph_verify_fact']);

  const withoutEmbedding = buildToolCatalog({ verifier: true, embeddingConfigured: false });
  const closedWorld = withoutEmbedding.filter((entry) => entry.annotations.openWorldHint).map((entry) => entry.name).sort();
  assert.deepEqual(closedWorld, ['shadowgraph_backup', 'shadowgraph_restore', 'shadowgraph_verify_fact']);

  // Only the annotation moves: the advertised text stays the same either way, so
  // one description cannot contradict the other deployment.
  for (const [index, entry] of withEmbedding.entries()) {
    assert.equal(entry.description, withoutEmbedding[index].description, `${entry.name} description must not depend on configuration`);
  }
});

// A description is read by an agent alongside every other tool's, so its cost
// is paid on every listing. These are ceilings and disclosure rules: what a
// description must not exceed, and what a caller would be misled by if it were
// left out. There is deliberately no minimum length and no required wording,
// because padding a clause to clear a floor makes a description worse.
const DESCRIPTION_CAP = 350;
const DESCRIPTION_TOTALS = {
  full: 9100,
  verifier: 9400,
  compact: 4300
};
// A tool whose result a caller could destroy something with has to say so in
// its own words. The check is on meaning, not on a keyword: each of these must
// name what it removes, overwrites, or replaces.
const DISCLOSURE_EXPECTED = {
  shadowgraph_purge: /delete|remove/iu,
  shadowgraph_backup: /overwrit/iu,
  shadowgraph_restore: /replace/iu,
  shadowgraph_ack_review: /overwrit/iu,
  shadowgraph_link: /duplicat/iu,
  shadowgraph_review: /bare JSON array/u,
  shadowgraph_review_signals: /bare JSON array/u
};

test('every description is composed, single-line, and within its budget', () => {
  for (const entry of verifierCatalog) {
    const { does, route, effects, returns } = entry.describe;
    assert.equal(entry.description, [does, route, effects, returns].filter(Boolean).join(' '), `${entry.name} description must be its composed parts`);
    assert.ok(does, `${entry.name} must open with an action clause`);
    assert.ok(route, `${entry.name} must say which sibling to use instead`);
    assert.ok(
      entry.description.length <= DESCRIPTION_CAP,
      `${entry.name} description is ${entry.description.length} characters, over the ${DESCRIPTION_CAP} cap; move detail into a property or output schema`
    );
    assert.equal(entry.description.includes('\r'), false, `${entry.name} description must not contain a carriage return`);
    assert.equal(entry.description.includes('\n'), false, `${entry.name} description must not contain a newline`);
    assert.equal(entry.description.includes('  '), false, `${entry.name} description must not contain a double space`);
    assert.equal(entry.description.trim(), entry.description, `${entry.name} description must not be padded`);
    // A tool that writes has to disclose what it does, including on a retry.
    if (!entry.annotations.readOnlyHint) {
      assert.ok(effects, `${entry.name} writes, so it must disclose its side effects`);
    }
    const disclosure = DISCLOSURE_EXPECTED[entry.name];
    if (disclosure) {
      assert.match(entry.description, disclosure, `${entry.name} must disclose this in its description`);
    }
  }
});

const total = (entries) => entries.reduce((sum, entry) => sum + entry.description.length, 0);

test('the advertised description text stays within its aggregate budget', () => {
  const totals = {
    full: total(fullCatalog),
    verifier: total(verifierCatalog),
    compact: total(selectTools(fullCatalog, { compact: true }))
  };
  for (const [mode, budget] of Object.entries(DESCRIPTION_TOTALS)) {
    assert.ok(
      totals[mode] <= budget,
      `${mode} descriptions total ${totals[mode]} characters, over the ${budget} budget`
    );
  }
  // Guard the other direction too: a rewrite that collapsed descriptions into
  // near-nothing would pass every ceiling above while making the tools unusable.
  assert.ok(totals.full > 4000, `full descriptions total only ${totals.full} characters`);
});


// What `tools/list` actually puts on the wire, at one boundary: the UTF-8 byte
// length of JSON.stringify(result.tools). Budgets are ceilings set about six per
// cent above the measured size, so an accidental return to paragraph-length
// descriptions fails here rather than being noticed by a user paying for the
// context. Output schemas are excluded from the pressure on purpose: they are
// truthful promises about results, and shrinking one to clear a budget would
// trade a real guarantee for a smaller number.
const WIRE_BUDGETS = {
  'withoutVerifier.full': { bare: 44_500, annotated: 47_500, structured: 165_500 },
  'withoutVerifier.compact': { bare: 30_000, annotated: 31_500, structured: 96_000 },
  'withVerifier.full': { bare: 45_500, annotated: 48_500, structured: 170_000 },
  'withVerifier.compact': { bare: 30_000, annotated: 31_500, structured: 96_000 }
};

test('the advertised tool list stays within its wire-size budget, at every tier', () => {
  const report = measureAll();
  for (const [path, budgets] of Object.entries(WIRE_BUDGETS)) {
    const [build, mode] = path.split('.');
    const measured = report[build][mode];
    for (const [tier, budget] of Object.entries(budgets)) {
      const { total } = measured.tiers[tier];
      assert.ok(total <= budget, `${path} ${tier} tools/list is ${total} bytes, over the ${budget} budget`);
    }
    // Each tier adds members to the one below it and never removes any.
    assert.ok(measured.tiers.annotated.total > measured.tiers.bare.total, `${path} annotated must exceed bare`);
    assert.ok(measured.tiers.structured.total > measured.tiers.annotated.total, `${path} structured must exceed annotated`);
  }
  // The compact surface is the one an agent loads by default, so its full
  // structured listing must stay well under the full mode's.
  assert.ok(report.withoutVerifier.compact.tiers.structured.total < report.withoutVerifier.full.tiers.structured.total);
});

test('overlapping tools route to their siblings by name, and every named sibling exists', () => {
  const known = new Set(verifierCatalog.map((entry) => entry.name));
  assert.equal(Object.keys(ROUTING_EXPECTED).length, 28);
  for (const entry of verifierCatalog) {
    const siblings = ROUTING_EXPECTED[entry.name];
    assert.ok(siblings, `${entry.name} has no expected routing row`);
    for (const sibling of siblings) {
      assert.ok(known.has(sibling), `${entry.name} routes to unknown tool ${sibling}`);
      assert.notEqual(sibling, entry.name, `${entry.name} cannot route to itself`);
      assert.ok(entry.description.includes(sibling), `${entry.name} must name ${sibling} so an agent can choose between them`);
    }
    for (const mentioned of entry.description.match(/shadowgraph_[a-z_]+/gu) ?? []) {
      assert.ok(known.has(mentioned), `${entry.name} mentions unknown tool ${mentioned}`);
    }
  }
});

test('every input property, at every nesting level, carries a meaningful description', () => {
  for (const entry of verifierCatalog) {
    let count = 0;
    walkProperties(entry.inputSchema, (name, property, path) => {
      count += 1;
      const description = property.description;
      assert.equal(typeof description, 'string', `${entry.name} ${path} has no description`);
      assert.ok(description.trim().length >= 15, `${entry.name} ${path} description is too short to be meaningful`);
      assert.notEqual(description.trim().toLowerCase(), name.toLowerCase(), `${entry.name} ${path} description merely repeats the property name`);
      assert.equal(description.includes('\r') || description.includes('\n'), false, `${entry.name} ${path} description must be single-line`);
      assert.equal(description.includes('  '), false, `${entry.name} ${path} description must not contain a double space`);
    });
    const topLevel = Object.keys(entry.inputSchema.properties ?? {}).length;
    assert.ok(count >= topLevel, `${entry.name} property walk must cover at least its top-level properties`);
  }
});

test('input schemas keep the constraints they had before descriptions were written', () => {
  assert.equal(Object.keys(INPUT_CONSTRAINTS_EXPECTED).length, 28);
  for (const entry of verifierCatalog) {
    const expected = INPUT_CONSTRAINTS_EXPECTED[entry.name];
    assert.ok(expected, `${entry.name} has no expected constraint row`);
    assert.equal(entry.inputSchema.type, 'object', `${entry.name} inputSchema root must be an object`);
    assert.deepEqual(entry.inputSchema.required ?? null, expected.required, `${entry.name} required list`);
    for (const [property, values] of Object.entries(expected.enums)) {
      assert.deepEqual(entry.inputSchema.properties[property].enum, values, `${entry.name}.${property} enum`);
    }
    // Portability: strict MCP clients reject array-valued `type` unions.
    walkNodes(entry.inputSchema, (node, path) => {
      assert.equal(Array.isArray(node.type), false, `${entry.name} ${path} uses an array-valued type`);
    });
  }
  // Only shadowgraph_verify_fact closes its argument object, and it must stay closed.
  assert.equal(byName.get('shadowgraph_verify_fact').inputSchema.additionalProperties, false);
});

test('output schemas are declared for every tool that returns an object, and deliberately omitted for the two that do not', () => {
  const withoutSchema = verifierCatalog.filter((entry) => !entry.outputSchema).map((entry) => entry.name).sort();
  assert.deepEqual(withoutSchema, ['shadowgraph_review', 'shadowgraph_review_signals']);
  assert.deepEqual(Object.keys(OUTPUT_SCHEMA_OMISSIONS).sort(), withoutSchema);
  for (const [name, reason] of Object.entries(OUTPUT_SCHEMA_OMISSIONS)) {
    assert.ok(reason.length >= 40, `${name} omission must be explained`);
    // The description carries the return shape when no schema can.
    assert.match(byName.get(name).description, /bare JSON array/u);
  }
  assert.equal(verifierCatalog.filter((entry) => entry.outputSchema).length, 26);
});

test('every output schema is portable: object-rooted, single-typed, and free of references', () => {
  const ALLOWED = new Set(['type', 'description', 'required', 'properties', 'items', 'enum', 'const', 'anyOf', 'minimum', 'maximum', 'minItems']);
  for (const entry of verifierCatalog) {
    if (!entry.outputSchema) continue;
    // structuredContent must be an object for 2025-06-18 clients, and the
    // TypeScript SDK requires this literal type at the root.
    assert.equal(entry.outputSchema.type, 'object', `${entry.name} outputSchema root must be type object`);
    walkNodes(entry.outputSchema, (node, path) => {
      const label = `${entry.name} ${path}`;
      for (const keyword of Object.keys(node)) {
        assert.ok(ALLOWED.has(keyword), `${label} uses unsupported keyword ${keyword}`);
      }
      assert.equal(Array.isArray(node.type), false, `${label} uses an array-valued type`);
      if (node.type !== undefined) assert.equal(typeof node.type, 'string', `${label} type must be a single string`);
      const validating = ['type', 'anyOf', 'enum', 'const'].some((keyword) => Object.hasOwn(node, keyword));
      assert.ok(validating, `${label} has no validating keyword`);
      if (node.properties || node.required) assert.equal(node.type, 'object', `${label} declares object keywords without type object`);
      if (node.items || node.minItems !== undefined) assert.equal(node.type, 'array', `${label} declares array keywords without type array`);
      if (node.minimum !== undefined || node.maximum !== undefined) {
        assert.ok(['number', 'integer'].includes(node.type), `${label} declares a numeric bound without a numeric type`);
      }
      for (const key of node.required ?? []) {
        assert.ok(Object.hasOwn(node.properties ?? {}, key), `${label} requires undeclared property ${key}`);
      }
    });
    walkProperties(entry.outputSchema, (name, property, path) => {
      assert.equal(typeof property.description, 'string', `${entry.name} outputSchema ${path} has no description`);
      assert.ok(property.description.trim().length >= 10, `${entry.name} outputSchema ${path} description is too short`);
    });
  }
});

test('the implemented handshake revisions are declared, newest first, and frozen', () => {
  assert.deepEqual([...LEGACY_PROTOCOL_VERSIONS], ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
  assert.equal(Object.isFrozen(LEGACY_PROTOCOL_VERSIONS), true);
  // Batching was required by 2025-03-26 and removed by 2025-06-18, so it is one
  // revision, not a range.
  assert.deepEqual([...BATCH_PROTOCOL_VERSIONS], ['2025-03-26']);
  assert.equal(Object.isFrozen(BATCH_PROTOCOL_VERSIONS), true);
  for (const version of BATCH_PROTOCOL_VERSIONS) {
    assert.ok(LEGACY_PROTOCOL_VERSIONS.includes(version), `${version} must be an implemented revision`);
  }
});

test('negotiation echoes an implemented revision and otherwise answers with the latest', () => {
  for (const version of LEGACY_PROTOCOL_VERSIONS) {
    assert.equal(negotiateLegacyProtocolVersion(version), version, `${version} is implemented and must be echoed`);
  }
  // Everything else is a revision this server has not implemented, whatever it
  // looks like: older, newer, per-request-only, or malformed.
  const fallback = LEGACY_PROTOCOL_VERSIONS[0];
  for (const requested of [
    '2024-10-07', '2025-03-25', '2025-06-17', '2025-3-26', '2026-07-28', '2099-01-01',
    'garbage', ' 2025-11-25', '2025-11-25 ', '', undefined, null, 20251125, {}, ['2025-11-25']
  ]) {
    assert.equal(negotiateLegacyProtocolVersion(requested), fallback, `requested ${JSON.stringify(requested)}`);
  }
});

test('metadata tiers follow the revision the server negotiated', () => {
  const cases = [
    ['2024-11-05', METADATA_TIER.BARE],
    ['2025-03-26', METADATA_TIER.ANNOTATED],
    ['2025-06-18', METADATA_TIER.STRUCTURED],
    ['2025-11-25', METADATA_TIER.STRUCTURED]
  ];
  for (const [negotiated, expected] of cases) {
    assert.equal(metadataTierForProtocolVersion(negotiated), expected, `negotiated ${negotiated}`);
  }
  // Every implemented revision needs an explicit tier: adding one to the list
  // without deciding what it advertises must fail here rather than silently
  // fall through to BARE.
  const tiered = new Set(cases.map(([version]) => version));
  for (const version of LEGACY_PROTOCOL_VERSIONS) {
    assert.ok(tiered.has(version), `${version} is implemented but has no declared tier`);
  }
  // A session that has not negotiated, or a per-request-only revision, is BARE.
  for (const absent of [undefined, null, '', '2026-07-28', '2099-01-01']) {
    assert.equal(metadataTierForProtocolVersion(absent), METADATA_TIER.BARE, `negotiated ${String(absent)}`);
  }
  // The headline change: a requested revision cannot select metadata on its own.
  // It selects a negotiated revision first, and the tier follows that.
  for (const requested of ['2026-07-28', '2099-01-01', 'not-a-revision']) {
    const negotiated = negotiateLegacyProtocolVersion(requested);
    assert.equal(negotiated, '2025-11-25', `requested ${requested}`);
    assert.equal(metadataTierForProtocolVersion(negotiated), METADATA_TIER.STRUCTURED, `requested ${requested}`);
  }
});

test('projected tools and results carry exactly the members each tier defines', () => {
  const structured = byName.get('shadowgraph_validate');
  const unstructured = byName.get('shadowgraph_review');

  assert.deepEqual(Object.keys(projectTool(structured, METADATA_TIER.BARE)), ['name', 'description', 'inputSchema']);
  assert.deepEqual(Object.keys(projectTool(structured, METADATA_TIER.ANNOTATED)), ['name', 'description', 'inputSchema', 'annotations']);
  assert.deepEqual(Object.keys(projectTool(structured, METADATA_TIER.STRUCTURED)), ['name', 'description', 'inputSchema', 'annotations', 'outputSchema']);
  assert.deepEqual(Object.keys(projectTool(unstructured, METADATA_TIER.STRUCTURED)), ['name', 'description', 'inputSchema', 'annotations']);

  // The serialized text block is identical in every tier, so a session
  // negotiated at 2024-11-05 keeps the `content` member, carrying the same text,
  // that it had before structured content existed.
  const value = { valid: true, issues: [], counts: { error: 0, legacy: 0, unsupported: 0, info: 0 } };
  const bare = toolResult(structured, value, METADATA_TIER.BARE);
  const annotated = toolResult(structured, value, METADATA_TIER.ANNOTATED);
  const full = toolResult(structured, value, METADATA_TIER.STRUCTURED);
  assert.deepEqual(Object.keys(bare), ['content']);
  assert.deepEqual(Object.keys(annotated), ['content']);
  assert.deepEqual(Object.keys(full), ['content', 'structuredContent']);
  assert.deepEqual(bare.content, full.content);
  assert.deepEqual(full.structuredContent, value);
  assert.deepEqual(JSON.parse(full.content[0].text), full.structuredContent);
  // A tool with no output schema never emits structured content, at any tier.
  assert.deepEqual(Object.keys(toolResult(unstructured, [], METADATA_TIER.STRUCTURED)), ['content']);
});

test('output schemas accept data imported from an older storage schema', () => {
  // Over-specifying an output schema is worse than omitting one: a client that
  // validates would turn a successful read of legacy data into an exception.
  const graph = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
  graph.importData({
    schemaVersion: 3,
    records: [
      {
        id: 'legacy-decision-1',
        kind: 'decision',
        title: 'Ship the legacy build',
        chosen: 'ship',
        status: 'active',
        confidence: 0.7,
        assumptions: ['the deployment stays single-user'],
        evidence: ['a hallway conversation'],
        alternatives: [{ label: 'wait', reasonRejected: 'too slow', reopenWhen: [{ key: 'deployment', value: 'multi-user' }] }]
      },
      { id: 'legacy-attempt-1', kind: 'attempt', solution: 'tried the old path', result: 'failed during build' }
    ],
    facts: [{ id: 'legacy-fact-1', key: 'deployment', value: 'single-user', source: 'human-confirmed', verificationStatus: 'verified' }],
    relations: [{ id: 'legacy-relation-1', from: 'legacy-decision-1', to: 'legacy-fact-1', relation: 'depends_on' }],
    reviewSignals: [],
    idempotency: [],
    events: [],
    journal: []
  });

  const checks = [
    ['shadowgraph_search', graph.search('')],
    ['shadowgraph_retrieve', graph.retrieve('')],
    ['shadowgraph_recall', graph.recall('')],
    ['shadowgraph_context', graph.context({})],
    ['shadowgraph_traverse', graph.traverse({ id: 'legacy-decision-1' })],
    ['shadowgraph_journal', graph.getJournal({})],
    ['shadowgraph_rebuild', graph.rebuild()],
    ['shadowgraph_redact', graph.redact()],
    ['shadowgraph_validate', graph.validate()],
    ['shadowgraph_repair_plan', graph.repairPlan()],
    ['shadowgraph_purge_preview', graph.projectSummary('default')],
    ['shadowgraph_maintain', graph.maintain({})]
  ];
  for (const [name, value] of checks) {
    assertValid(byName.get(name).outputSchema, value, `${name} over schema-3 data`);
  }
  // The legacy verified fact is preserved rather than elevated or rejected.
  const [fact] = graph.exportData().facts;
  assert.equal(fact.verificationStatus, 'unverified');
  assert.equal(fact.legacyVerificationStatus, 'verified');
});

test('the subset validator this file relies on actually rejects bad data', () => {
  const schema = {
    type: 'object',
    required: ['a'],
    properties: {
      a: { type: 'string' },
      b: { type: 'integer', minimum: 0 },
      c: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      d: { type: 'array', items: { type: 'string' } },
      e: { type: 'string', enum: ['x', 'y'] },
      f: { type: 'boolean', const: false }
    }
  };
  assert.deepEqual(validate(schema, { a: 'ok', b: 1, c: null, d: ['s'], e: 'x', f: false }), []);
  assert.equal(validate(schema, {}).length, 1);
  assert.equal(validate(schema, { a: 1 }).length, 1);
  assert.equal(validate(schema, { a: 'ok', b: -1 }).length, 1);
  assert.equal(validate(schema, { a: 'ok', b: 1.5 }).length, 1);
  assert.equal(validate(schema, { a: 'ok', c: 7 }).length, 1);
  assert.equal(validate(schema, { a: 'ok', d: [1] }).length, 1);
  assert.equal(validate(schema, { a: 'ok', e: 'z' }).length, 1);
  assert.equal(validate(schema, { a: 'ok', f: true }).length, 1);
  assert.equal(validate({ type: 'object' }, []).length, 1);
});
