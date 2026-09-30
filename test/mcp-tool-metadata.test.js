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
import { privilegedIssueAccess, privilegedSnapshot } from '../src/internal/snapshot.js';

// --- expected inventory ----------------------------------------------------
const FULL_TOOL_NAMES = [
  'shadowgraph_record_decision',
  'shadowgraph_record_attempt',
  'shadowgraph_review',
  'shadowgraph_search',
  'shadowgraph_context',
  'shadowgraph_review_context',
  'shadowgraph_remember',
  'shadowgraph_recall',
  'shadowgraph_record_fact',
  'shadowgraph_record_outcome',
  'shadowgraph_confidence_evidence',
  'shadowgraph_update_status',
  'shadowgraph_link',
  'shadowgraph_traverse',
  'shadowgraph_expand',
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
  'shadowgraph_restore',
  'shadowgraph_reconsider',
  'shadowgraph_request_wider_access',
  'shadowgraph_revoke_grant',
  'shadowgraph_discard_access',
  'shadowgraph_bind',
  'shadowgraph_attribute'
];
const COMPACT_EXPECTED = [
  'shadowgraph_record_decision',
  'shadowgraph_record_attempt',
  'shadowgraph_review',
  'shadowgraph_search',
  'shadowgraph_context',
  // Plan v1.4.4 PR-16: shadowgraph_context became the default-path read, and the
  // evaluate-and-persist behaviour a compact client relied on moved here.
  'shadowgraph_review_context',
  'shadowgraph_remember',
  'shadowgraph_recall',
  'shadowgraph_record_fact',
  'shadowgraph_record_outcome',
  // Plan v1.4.4 PR-27: a line the default read delivers names shadowgraph_expand,
  // so a compact client can call it.
  'shadowgraph_expand',
  'shadowgraph_maintain',
  'shadowgraph_retrieve',
  'shadowgraph_validate',
  // Promoted into compact on 2026-09-14. A compact client could see reviews
  // through shadowgraph_context but had no advertised route to acknowledge one,
  // so signals accumulated with no way to clear them.
  'shadowgraph_ack_review',
  'shadowgraph_reconsider'
];
// The exact set src/mcp.js used to spell out inline as a name list. A tool that
// writes but is missing here would silently stop being saved.
const PERSISTING_EXPECTED = [
  'shadowgraph_ack_review',
  'shadowgraph_attribute',
  'shadowgraph_backup',
  'shadowgraph_bind',
  'shadowgraph_confidence_evidence',
  'shadowgraph_discard_access',
  'shadowgraph_link',
  'shadowgraph_maintain',
  'shadowgraph_purge',
  'shadowgraph_reconsider',
  'shadowgraph_record_attempt',
  'shadowgraph_record_decision',
  'shadowgraph_record_fact',
  'shadowgraph_record_outcome',
  'shadowgraph_remember',
  'shadowgraph_request_wider_access',
  'shadowgraph_review',
  'shadowgraph_review_context',
  'shadowgraph_revoke_grant',
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
// Grant-capable reads declare their conditional audit write even though their
// ordinary own-scope calls remain pure. Restore commits through its backend.
const ANNOTATIONS_EXPECTED = {
  shadowgraph_bind: [false, true, false, true],
  shadowgraph_attribute: [false, false, false, false],
  shadowgraph_record_decision: [false, false, false, false],
  shadowgraph_record_attempt: [false, false, false, false],
  shadowgraph_review: [false, false, false, false],
  shadowgraph_search: [false, false, false, false],
  shadowgraph_context: [false, false, false, false],
  shadowgraph_review_context: [false, false, false, false],
  shadowgraph_remember: [false, false, false, false],
  shadowgraph_recall: [false, false, false, false],
  shadowgraph_record_fact: [false, false, false, false],
  shadowgraph_record_outcome: [false, false, false, false],
  shadowgraph_confidence_evidence: [false, false, false, false],
  shadowgraph_update_status: [false, false, false, false],
  shadowgraph_link: [false, false, false, false],
  shadowgraph_traverse: [false, false, false, false],
  shadowgraph_expand: [false, false, false, false],
  shadowgraph_supersede: [false, false, false, false],
  shadowgraph_redact: [false, false, false, false],
  shadowgraph_purge: [false, true, false, false],
  shadowgraph_maintain: [false, false, false, false],
  shadowgraph_retrieve: [false, false, false, false],
  shadowgraph_validate: [false, false, false, false],
  shadowgraph_journal: [false, false, false, false],
  shadowgraph_rebuild: [false, false, false, false],
  shadowgraph_review_signals: [false, false, false, false],
  shadowgraph_purge_preview: [true, false, true, false],
  shadowgraph_ack_review: [false, true, false, false],
  shadowgraph_repair_plan: [false, false, false, false],
  shadowgraph_backup: [false, true, false, true],
  shadowgraph_restore: [false, true, false, true],
  shadowgraph_reconsider: [false, false, false, false],
  shadowgraph_request_wider_access: [false, false, false, false],
  shadowgraph_revoke_grant: [false, false, false, false],
  shadowgraph_discard_access: [false, false, false, false],
  shadowgraph_verify_fact: [false, false, false, true]
};
// Overlapping tools must name the siblings a model would otherwise confuse them
// with, so routing is decidable from the description alone.
const ROUTING_EXPECTED = {
  shadowgraph_bind: ['shadowgraph_attribute'],
  shadowgraph_attribute: ['shadowgraph_bind'],
  shadowgraph_request_wider_access: ['shadowgraph_revoke_grant'],
  shadowgraph_revoke_grant: ['shadowgraph_request_wider_access'],
  shadowgraph_discard_access: ['shadowgraph_request_wider_access'],
  shadowgraph_search: ['shadowgraph_retrieve', 'shadowgraph_recall', 'shadowgraph_context', 'shadowgraph_traverse'],
  shadowgraph_retrieve: ['shadowgraph_search', 'shadowgraph_recall', 'shadowgraph_traverse', 'shadowgraph_context'],
  shadowgraph_recall: ['shadowgraph_search', 'shadowgraph_retrieve', 'shadowgraph_remember'],
  shadowgraph_context: ['shadowgraph_search', 'shadowgraph_retrieve', 'shadowgraph_recall', 'shadowgraph_review_context'],
  shadowgraph_review_context: ['shadowgraph_context', 'shadowgraph_review'],
  shadowgraph_traverse: ['shadowgraph_search', 'shadowgraph_recall', 'shadowgraph_retrieve'],
  shadowgraph_expand: ['shadowgraph_context', 'shadowgraph_traverse'],
  shadowgraph_review: ['shadowgraph_review_signals', 'shadowgraph_ack_review', 'shadowgraph_maintain'],
  shadowgraph_reconsider: ['shadowgraph_review', 'shadowgraph_ack_review'],
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
  shadowgraph_bind: { required: ['type', 'project', 'reason'], enums: { type: ['worktree', 'shared_repository'] } },
  shadowgraph_attribute: { required: ['targetProject', 'reason'], enums: {} },
  shadowgraph_request_wider_access: { required: ['scope', 'surfaces', 'expiresAt', 'reason'], enums: {} },
  shadowgraph_revoke_grant: { required: ['accessId'], enums: {} },
  shadowgraph_discard_access: { required: ['accessId'], enums: {} },
  shadowgraph_record_decision: { required: ['title', 'chosen'], enums: {} },
  shadowgraph_record_attempt: { required: ['solution', 'result'], enums: {} },
  shadowgraph_review: { required: null, enums: {} },
  shadowgraph_search: { required: null, enums: { kind: ['decision', 'attempt'] } },
  shadowgraph_context: { required: null, enums: {} },
  shadowgraph_review_context: { required: null, enums: {} },
  shadowgraph_remember: { required: null, enums: {} },
  shadowgraph_recall: { required: null, enums: {} },
  shadowgraph_record_fact: { required: ['key'], enums: { verificationStatus: ['unverified', 'contradicted'] } },
  shadowgraph_record_outcome: { required: ['decisionId', 'outcome'], enums: {} },
  shadowgraph_confidence_evidence: { required: ['decisionId', 'reason', 'key'], enums: {} },
  shadowgraph_update_status: { required: ['decisionId', 'status'], enums: {} },
  shadowgraph_link: { required: ['from', 'to', 'relation'], enums: {} },
  shadowgraph_traverse: { required: ['id'], enums: { direction: ['in', 'out', 'both'] } },
  shadowgraph_expand: { required: ['recordId', 'digest'], enums: {} },
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
  shadowgraph_reconsider: { required: null, enums: {} },
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
  assert.equal(fullCatalog.length, 35);
  assert.deepEqual(verifierCatalog.map((entry) => entry.name), [...FULL_TOOL_NAMES, 'shadowgraph_verify_fact']);
  assert.equal(verifierCatalog.length, 36);

  const compact = selectTools(fullCatalog, { compact: true });
  assert.deepEqual(compact.map((entry) => entry.name), COMPACT_EXPECTED);
  assert.equal(compact.length, 16);
  assert.deepEqual([...COMPACT_TOOL_NAMES], COMPACT_EXPECTED);

  // The optional verification tool is a full-mode capability only.
  const compactWithVerifier = selectTools(verifierCatalog, { compact: true });
  assert.deepEqual(compactWithVerifier.map((entry) => entry.name), COMPACT_EXPECTED);

  assert.equal(new Set(verifierCatalog.map((entry) => entry.name)).size, 36);
  for (const entry of verifierCatalog) assert.match(entry.name, /^shadowgraph_[a-z_]+$/u);
});

test('every tool carries the four behavioural annotations its handler actually justifies', () => {
  assert.equal(Object.keys(ANNOTATIONS_EXPECTED).length, 36);
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

test('persistence is declared for ordinary writes and conditional grant audit writes', () => {
  const persisting = verifierCatalog.filter((entry) => entry.persists).map((entry) => entry.name).sort();
  assert.deepEqual(persisting, PERSISTING_EXPECTED);
  assert.equal(persisting.length, 22);
  const grantReads = ['shadowgraph_context', 'shadowgraph_expand', 'shadowgraph_journal', 'shadowgraph_maintain', 'shadowgraph_rebuild', 'shadowgraph_recall', 'shadowgraph_reconsider', 'shadowgraph_redact', 'shadowgraph_repair_plan', 'shadowgraph_retrieve', 'shadowgraph_review', 'shadowgraph_review_context', 'shadowgraph_review_signals', 'shadowgraph_search', 'shadowgraph_traverse', 'shadowgraph_validate'];
  assert.deepEqual(verifierCatalog.filter((entry) => entry.persistsWithAccess).map((entry) => entry.name).sort(), grantReads);
  for (const entry of verifierCatalog) {
    // shadowgraph_restore writes, but its storage backend commits the
    // replacement itself, so src/mcp.js must not save again afterwards.
    const expected = !entry.annotations.readOnlyHint && entry.name !== 'shadowgraph_restore';
    assert.equal(entry.persists || entry.persistsWithAccess === true, expected, `${entry.name} persistence flags must agree with readOnlyHint`);
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
  assert.deepEqual(openWorld, ['shadowgraph_backup', 'shadowgraph_bind', 'shadowgraph_recall', 'shadowgraph_remember', 'shadowgraph_restore', 'shadowgraph_verify_fact']);

  const withoutEmbedding = buildToolCatalog({ verifier: true, embeddingConfigured: false });
  const closedWorld = withoutEmbedding.filter((entry) => entry.annotations.openWorldHint).map((entry) => entry.name).sort();
  assert.deepEqual(closedWorld, ['shadowgraph_backup', 'shadowgraph_bind', 'shadowgraph_restore', 'shadowgraph_verify_fact']);

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
// `compact` was raised from 4300 to 4450 on 2026-09-14, once and deliberately,
// because compact gained a 13th tool: shadowgraph_ack_review was promoted so a
// compact client could close the review loop it could already see. Measured, not
// estimated: the compact total went 3,997 -> 4,338 characters, the whole
// difference being that tool's own 341-character description, which is itself
// under the 350 per-description cap.
//
// Raised again to 4750 on 2026-09-20, for the 14th compact tool,
// shadowgraph_reconsider. Measured the same way: compact went 4,338 -> 4,684
// characters, the whole difference being that tool's own 346-character
// description, itself under the per-description cap. `full` (8,861) and
// `verifier` (9,210) both grew by the same 346 and still sit under their
// existing budgets, so neither was moved.
//
// Raised again on 2026-09-28 for plan v1.4.4 PR-16, which split the default-path
// read (shadowgraph_context) from explicit evaluate-and-persist
// (shadowgraph_review_context, the 34th full and 15th compact tool). Measured with
// `npm run size:mcp`: full 9,267, verifier 9,616, compact 4,186 characters. The
// growth is the new tool's own description plus context's rewritten effects text;
// compact still sits under its existing budget, so it was not moved.
//
// Raised again on 2026-09-29 for plan v1.4.4 PR-27, which adds shadowgraph_expand
// (the 35th full and 16th compact tool) and names relevance in the context
// description. Measured the same way: full 9,695, verifier 10,044, compact 4,614
// characters. Full and verifier are re-set with the same ~2.5% headroom; compact
// still sits under its budget, so it was not moved.
const DESCRIPTION_TOTALS = {
  full: 9900,
  verifier: 10250,
  compact: 4750
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
  shadowgraph_review: /items, completeness/u,
  shadowgraph_review_signals: /items, completeness/u
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
// The `structured` budgets were raised once, deliberately, when review conditions
// began reporting the evidence behind a verdict and reusableWhen started being
// evaluated. Measured with `node scripts/mcp-wire-size.mjs`:
//
//   full structured     156,333 -> 172,527  (+16,194, +10.4%)
//   compact structured   90,842 -> 107,036  (+16,194, +17.8%)
//   full bare            42,166 ->  42,465  (+299)
//   full annotated       45,000 ->  45,299  (+299)
//
// The structured cost is `evaluatedConditionSchema` inlined at five sites --
// violatedConditions, conditionDiagnostics and reusableAttempts on
// `shadowgraph_context`, plus violatedConditions and diagnostics on
// `shadowgraph_maintain` -- because this catalog forbids $ref, so a shared shape
// cannot be shared on the wire. The +299 on the lower tiers is the new
// `resultClass` input property and a reworded `result` description.
//
// Only a client that negotiates the structured tier pays the large part, and
// what it buys is a review signal that names the operator, the expected and
// observed values and the fact the verdict came from, instead of a
// comma-separated list of keys. Budgets keep roughly 2% headroom so the guard
// still catches unplanned growth.
//
// Re-measured on 2026-09-20 for shadowgraph_reconsider, the 28th full and 14th
// compact tool. Measured, not estimated -- `npm run size:mcp`:
//
//   withoutVerifier.full        bare 43,711  annotated 46,651  structured 187,359
//   withoutVerifier.compact     bare 30,958  annotated 32,433  structured 123,799
//   withVerifier.full           bare 44,627  annotated 47,672  structured 191,674
//   withVerifier.compact        bare 30,958  annotated 32,433  structured 123,799
//
// Compact pays the largest relative increase because the new tool is advertised
// there, and its structured cost is again evaluatedConditionSchema inlined --
// four more sites, for triggeredRules, groundedConditions, rulesNotEvaluated and
// contestedConditions -- since this catalog forbids . What a structured
// client buys for it is a reconsideration that states which conditions fired,
// which did not, and which could not be evaluated, rather than a bare due list.
// Budgets below keep roughly 2% headroom, as before.
const WIRE_BUDGETS = {
  // PR12 adds five planned tools, grant inputs, effective grant fields and
  // bounded read provenance. Exact measurement and transition accounting:
  // docs/contracts/access-transports.md. These engineering wire ceilings do
  // not change campaign, benchmark or audit-operation performance thresholds.
  // PR13: explicit scope inputs, creation-ID refusal and truthful restore/read
  // contracts. Measured bare/annotated/structured: full 54921/58409/239685,
  // verifier full 56069/59662/244232, compact 34848/36331/151693.
  // Retain ~2% headroom where needed; compact structured ceiling is unchanged.
  // PR-16 (plan v1.4.4 §13.2): shadowgraph_context became the default-path read
  // and shadowgraph_review_context carries evaluate-and-persist with the same
  // working set, so that output schema is now advertised twice -- this catalog
  // forbids $ref, so it cannot be shared on the wire, and it is not shrunk to
  // clear a budget. Measured with `npm run size:mcp` on 2026-09-28,
  // bare/annotated/structured: full 56294/59888/269148, verifier full
  // 57442/61141/273695, compact 36221/37810/181156. Roughly 2% headroom.
  // PR-23 documents an attempt's causalClaim in its output schema. Measured on
  // 2026-09-28: full 56362/59956/271044, verifier full 57510/61209/275591,
  // compact 36289/37878/183052; every ceiling unchanged. PR-24 rewords the
  // result-class descriptions and counts undetermined attempts: full
  // 56406/60000/271688, verifier full 57554/61253/276235, compact
  // 36333/37922/183696; every ceiling unchanged.
  // PR-26 (plan v1.4.4 §17.2) adds shadowgraph_context's relevance inputs
  // (query, focalId, asOf, compact) and its relevant block: head, T1 line and
  // T2 record schemas. Measured on 2026-09-29: full 57152/60746/283848,
  // verifier full 58300/61999/288395, compact 37079/38668/195856. The ceilings
  // this planned addition exceeds are re-set with ~2% headroom (recorded
  // variance, PR-12/13/16 precedent); the four it leaves inside are unchanged.
  // PR-27 adds shadowgraph_expand to both modes, with its output schema.
  // Measured on 2026-09-29: full 58789/62489/298375, verifier full
  // 59937/63742/302922, compact 38716/40411/210383. Every tier grew past its
  // ceiling, and each is re-set with ~2% headroom (recorded variance).
  // PR-28 adds semantic.indexed to the recall signals and PR-29 the relevant
  // block's temporal evidence. Measured on 2026-09-29: full 58793/62493/301024,
  // verifier full 59941/63746/305571, compact 38720/40415/212682; every ceiling
  // unchanged. The PR-26 corrective rewords the relevant head's lexical signal
  // (content words). Measured on 2026-09-30: full 58793/62493/301123, verifier
  // full 59941/63746/305670, compact 38720/40415/212781; every ceiling unchanged.
  // PR-36b (plan v1.4.4 §24.1, M-9) declares the capture status every
  // completeness-bearing read carries: an optional capture block in the read
  // coverage schema, inlined at every read's output schema since this catalog
  // forbids $ref, and the relevance head's processing fields. Its wording was
  // cut to the shortest meaningful first; the structure is the guarantee and is
  // not shrunk. Measured on 2026-09-30, with the declared gaps: full
  // 58793/62493/322851, verifier full 59941/63746/327398, compact
  // 38720/40415/227653. The four structured ceilings (three values) are re-set
  // with ~2% headroom (recorded variance, PR-12/13/16/26/27 precedent); the
  // eight bare and annotated ceilings are unchanged.
  'withoutVerifier.full': { bare: 59_900, annotated: 63_700, structured: 329_400 },
  'withoutVerifier.compact': { bare: 39_500, annotated: 41_200, structured: 232_300 },
  'withVerifier.full': { bare: 61_100, annotated: 65_000, structured: 334_000 },
  'withVerifier.compact': { bare: 39_500, annotated: 41_200, structured: 232_300 }
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
  assert.equal(Object.keys(ROUTING_EXPECTED).length, 36);
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
  assert.equal(Object.keys(INPUT_CONSTRAINTS_EXPECTED).length, 36);
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

test('output schemas are declared for every tool, including the two scope-coverage envelopes', () => {
  const withoutSchema = verifierCatalog.filter((entry) => !entry.outputSchema).map((entry) => entry.name).sort();
  assert.deepEqual(withoutSchema, []);
  assert.deepEqual(Object.keys(OUTPUT_SCHEMA_OMISSIONS).sort(), withoutSchema);
  for (const [name, reason] of Object.entries(OUTPUT_SCHEMA_OMISSIONS)) {
    assert.ok(reason.length >= 40, `${name} omission must be explained`);
    // The description carries the return shape when no schema can.
    assert.match(byName.get(name).description, /items, completeness/u);
  }
  assert.equal(verifierCatalog.filter((entry) => entry.outputSchema).length, 36);
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
  const { outputSchema: omitted, ...unstructured } = byName.get('shadowgraph_review'); // generic formatter fallback, no real tool omits it

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
  // The same schema-3 data, optionally stored under one explicit project.
  const legacyData = (project) => {
    const owned = (item) => (project === undefined ? item : { ...item, project });
    return {
      schemaVersion: 3,
      records: [
        owned({
          id: 'legacy-decision-1',
          kind: 'decision',
          title: 'Ship the legacy build',
          chosen: 'ship',
          status: 'active',
          confidence: 0.7,
          assumptions: ['the deployment stays single-user'],
          evidence: ['a hallway conversation'],
          alternatives: [{ label: 'wait', reasonRejected: 'too slow', reopenWhen: [{ key: 'deployment', value: 'multi-user' }] }]
        }),
        owned({ id: 'legacy-attempt-1', kind: 'attempt', solution: 'tried the old path', result: 'failed during build' })
      ],
      facts: [owned({ id: 'legacy-fact-1', key: 'deployment', value: 'single-user', source: 'human-confirmed', verificationStatus: 'verified' })],
      relations: [{ id: 'legacy-relation-1', from: 'legacy-decision-1', to: 'legacy-fact-1', relation: 'depends_on' }],
      reviewSignals: [],
      idempotency: [],
      events: [],
      journal: []
    };
  };
  const graph = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
  graph.importData(legacyData());
  // The core reads return only what a selected project owns (plan v1.4.4
  // PR-08), and legacy data stored with no project belongs to none. So they
  // read the same legacy shapes imported under an explicit legacy project,
  // which the import keeps (WS-11 mapping i).
  const owned = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
  owned.importData(legacyData('legacy-app'));
  const read = { project: 'legacy-app' };
  const [searched, retrieved, recalled, context] = [owned.search('', read), owned.retrieve('', read), owned.recall('', read), owned.context(read)];
  assert.deepEqual(searched.items.map((item) => item.record.id), ['legacy-attempt-1', 'legacy-decision-1'], 'the core reads do read the legacy records');
  assert.equal(retrieved.items.some((item) => item.record.id === 'legacy-fact-1' && item.matchedBy === 'graph'), true);
  assert.equal(recalled.items.length, 3);
  assert.deepEqual([context.activeDecisions.length, context.failedAttempts.length], [1, 1]);
  const traversed = owned.traverse({ id: 'legacy-decision-1', ...read });
  assert.deepEqual(traversed.nodes.map((node) => node.id), ['legacy-decision-1', 'legacy-fact-1'], 'traverse reads the legacy records too');

  const checks = [
    ['shadowgraph_search', searched],
    ['shadowgraph_retrieve', retrieved],
    ['shadowgraph_recall', recalled],
    ['shadowgraph_context', context],
    ['shadowgraph_traverse', traversed],
    ['shadowgraph_journal', graph.getJournal({})],
    ['shadowgraph_rebuild', graph.rebuild()],
    ['shadowgraph_redact', graph.redact()],
    ['shadowgraph_validate', graph.validate()],
    ['shadowgraph_repair_plan', graph.repairPlan()],
    ['shadowgraph_purge_preview', graph.projectSummary('default')],
    ['shadowgraph_maintain', graph.maintain({})],
    ['shadowgraph_journal', owned.getJournal(read)],
    ['shadowgraph_rebuild', owned.rebuild(read)],
    ['shadowgraph_redact', owned.redact(read)],
    ['shadowgraph_validate', owned.validate(read)],
    ['shadowgraph_repair_plan', owned.repairPlan(read)],
    ['shadowgraph_maintain', owned.maintain(read)]
  ];
  for (const [name, value] of checks) {
    assertValid(byName.get(name).outputSchema, value, `${name} over schema-3 data`);
  }
  // The legacy verified fact is preserved rather than elevated or rejected.
  const [fact] = privilegedSnapshot(graph).facts;
  assert.equal(fact.verificationStatus, 'unverified');
  assert.equal(fact.legacyVerificationStatus, 'verified');
});

// Plan v1.4.4 PR-26: only the default read advertises the relevance inputs, and
// every shape its relevant block takes -- lines and full records of every kind,
// a kind-less legacy fact, a page, the fallback, a grant, no project -- matches
// the advertised output schema.
test('the default read advertises relevance, and every shape of its relevant block matches its schema', () => {
  const tool = byName.get('shadowgraph_context');
  assert.deepEqual(['query', 'focalId', 'asOf', 'compact'].map((name) => tool.inputSchema.properties[name]?.type), ['string', 'string', 'string', 'boolean']);
  assert.equal(byName.get('shadowgraph_review_context').inputSchema.properties.query, undefined);
  const relevantSchema = tool.outputSchema.properties.relevant;
  assert.deepEqual(relevantSchema.required, ['scope', 'relevance', 'fallback', 'byKind', 'total', 'returned', 'omitted', 'hasMore', 'complete', 'limitSource', 'limitation', 'temporal', 'lines', 'processing', 'expansion', 'items']);
  // PR-29: every item carries its temporal evidence.
  assert.deepEqual(relevantSchema.properties.items.items.properties.temporalEvidence.required, ['recordedAt', 'eventTime', 'currentState']);
  assert.ok(relevantSchema.properties.items.items.required.includes('temporalEvidence'));
  assert.deepEqual(relevantSchema.properties.byKind.required, ['decision', 'attempt', 'memory', 'fact']);
  assert.deepEqual(relevantSchema.properties.lines.items.required, ['recordId', 'claimClass', 'requiresExpansion']);
  for (const field of ['polarity', 'scope', 'preconditions', 'status', 'provenance', 'boundRevision', 'decisiveOmitted', 'requiresExpansion', 'expansion']) {
    assert.ok(relevantSchema.properties.items.items.properties.line.required.includes(field), `a line always carries ${field}`);
  }
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.importData({ facts: [{ id: 'legacy-fact', key: 'region', value: 'eu', project: 'alpha', status: 'superseded', validTo: '2025-01-01T00:00:00.000Z' }] });
  graph.addDecision({ project: 'alpha', title: 'region rollout', chosen: 'eu first', alternatives: [{ label: 'us first', reasonRejected: 'latency' }] });
  graph.addDecision({ project: 'alpha', title: `region sizing ${'budget '.repeat(80)}`, chosen: 'fixed' });
  graph.addFact({ project: 'alpha', key: 'region_count', value: 3 });
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'region note', text: 'regions are never cheap' });
  graph.addAttempt({ project: 'alpha', solution: 'region failover drill', result: 'failed: dns', resultClass: 'failed', reason: 'ttl too long' });
  graph.addDecision({ project: 'beta', title: 'region beta', chosen: 'b' });
  const grant = privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'schema fixture' }).entry;
  const reads = [
    { project: 'alpha', query: 'region' },
    { project: 'alpha', query: 'region', compact: true },
    { project: 'alpha', query: 'region', compact: true, asOf: '2024-06-01T00:00:00.000Z' },
    { project: 'alpha', query: 'region', compact: true, limit: 1 },
    { project: 'alpha', query: 'zebra', compact: true },
    { project: 'alpha', accessId: grant.accessId, query: 'region', compact: true },
    { query: 'region' },
    { project: 'alpha', focalId: 'missing' }
  ];
  const shapes = new Set();
  for (const [index, input] of reads.entries()) {
    const value = JSON.parse(JSON.stringify(graph.context(input)));
    assertValid(tool.outputSchema, value, `shadowgraph_context relevance read ${index}`);
    for (const item of value.relevant.items) shapes.add(`${item.tier}:${String(item.tier === 'T1' ? item.line.kind : item.record.kind)}`);
  }
  for (const shape of ['T1:decision', 'T1:attempt', 'T1:memory', 'T1:fact', 'T1:null', 'T2:decision', 'T2:attempt']) assert.ok(shapes.has(shape), `no relevance read delivered ${shape}`);
});

// Plan v1.4.4 PR-27: every shape an expansion takes -- current with resolved,
// unresolved and uninvestigated counterparts, revision_changed, purged,
// unavailable, under a grant -- matches the advertised output schema.
test('every shape of an expansion matches its advertised schema', () => {
  const schema = byName.get('shadowgraph_expand').outputSchema;
  const input = byName.get('shadowgraph_expand').inputSchema;
  assert.deepEqual([input.required, input.properties.maxExpansions.minimum, input.properties.maxExpansions.maximum], [['recordId', 'digest'], 0, 50]);
  assert.deepEqual(schema.required, ['recordId', 'status', 'revisionChanged', 'boundRevision', 'currentRevision', 'record', 'investigation', 'completeness']);
  assert.deepEqual(schema.properties.status.enum, ['current', 'revision_changed', 'purged', 'unavailable']);
  assert.equal(input.properties.maxExpansions.type, 'integer');
  const investigation = schema.properties.investigation.anyOf.find((branch) => branch.type === 'object');
  assert.deepEqual(investigation.required, ['budget', 'total', 'omitted', 'unreachableLinks', 'pairs', 'limitation']);
  assert.deepEqual(investigation.properties.budget.properties.outcome.enum, ['within_budget', 'exhausted']);
  const pairSchema = investigation.properties.pairs.items;
  assert.deepEqual(pairSchema.properties.basis.items.enum, ['explicit_supersession', 'different_times', 'same_value']);
  assert.deepEqual(pairSchema.properties.state.enum, ['resolved', 'unresolved', 'uninvestigated']);
  assert.deepEqual(schema.properties.completeness.properties.limitation.properties.reason.enum, ['purged', 'unavailable', 'store_unavailable']);
  let clock = '2026-03-01T00:00:00.000Z';
  const graph = createShadowGraph({ now: () => clock });
  graph.importData({ facts: [
    { id: 'fact-eu', kind: 'fact', project: 'alpha', key: 'region', value: 'eu', status: 'active', validFrom: '2025-01-01T00:00:00.000Z' },
    { id: 'fact-us', kind: 'fact', project: 'alpha', key: 'region', value: 'us', status: 'active', validFrom: '2025-01-01T00:00:00.000Z' }
  ] });
  // Distinct stored event times resolve the pair (PR-29: without them only the recording order would).
  graph.addFact({ project: 'alpha', key: 'latency', value: '5ms', validFrom: '2025-01-01T00:00:00.000Z' });
  graph.addFact({ project: 'alpha', key: 'latency', value: '30ms', validFrom: '2025-06-01T00:00:00.000Z' });
  const decision = graph.addDecision({ project: 'alpha', title: 'region rollout', chosen: 'eu first' });
  graph.addDecision({ project: 'beta', title: 'region beta', chosen: 'b' });
  const grant = privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'schema fixture' }).entry;
  const handles = (input) => graph.context({ query: 'region latency', compact: true, ...input }).relevant.items
    .map(({ line }) => { const { operation, scope, ...handle } = line.expansion; return { ...handle, project: scope.project, ...(scope.grantId ? { grantId: scope.grantId } : {}) }; });
  const own = handles({ project: 'alpha' });
  const reads = [...own, ...own.map((handle) => ({ ...handle, maxExpansions: 0 })), ...handles({ project: 'alpha', accessId: grant.accessId }), { ...own[0], recordId: 'decision:missing' }];
  graph.setOutcome(decision.id, { status: 'failed', sourceClass: 'tool_observed' }, { project: 'alpha' });
  reads.push(own.find((handle) => handle.recordId === decision.id));
  const statuses = new Set();
  const states = new Set();
  for (const [index, input] of reads.entries()) {
    const value = JSON.parse(JSON.stringify(graph.expand(input)));
    assertValid(schema, value, `shadowgraph_expand read ${index}`);
    statuses.add(value.status);
    for (const pair of value.investigation?.pairs ?? []) states.add(pair.state);
  }
  clock = '2026-03-02T00:00:00.000Z';
  graph.purgeProject('alpha', { mode: 'logical' });
  const purged = JSON.parse(JSON.stringify(graph.expand(own[0])));
  assertValid(schema, purged, 'shadowgraph_expand after a purge');
  statuses.add(purged.status);
  assert.deepEqual([...statuses].sort(), ['current', 'purged', 'revision_changed', 'unavailable']);
  assert.deepEqual([...states].sort(), ['resolved', 'uninvestigated', 'unresolved']);
});

// Plan v1.4.4 PR-19: belowConfidenceThreshold reports a decision of any status,
// so it carries what a legacy or lenient writer stored -- no status, a status
// this build does not recognise, a non-numeric confidence -- as a copy.
test('the default read accepts below-threshold decisions a legacy writer left', () => {
  const graph = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
  graph.importData({ records: [
    { id: 'no-status', kind: 'decision', project: 'legacy-app', title: 'No status', chosen: 'a', confidence: 0.1 },
    { id: 'null-status', kind: 'decision', project: 'legacy-app', title: 'Null status', chosen: 'a', status: null, confidence: 0.1 },
    { id: 'odd-status', kind: 'decision', project: 'legacy-app', title: 'Odd status', chosen: 'a', status: { v: 'x' }, confidence: 0.1 },
    { id: 'text-confidence', kind: 'decision', project: 'legacy-app', title: 'Text confidence', chosen: 'a', status: 'proposed', confidence: { current: '0.3' } }
  ] });
  const view = graph.context({ project: 'legacy-app' });
  assert.deepEqual(view.belowConfidenceThreshold.map((item) => item.decisionId).sort(), ['no-status', 'null-status', 'odd-status', 'text-confidence']);
  assertValid(byName.get('shadowgraph_context').outputSchema, JSON.parse(JSON.stringify(view)), 'shadowgraph_context over lenient legacy data');
  view.belowConfidenceThreshold.find((item) => item.decisionId === 'odd-status').status.v = 'changed';
  assert.deepEqual(privilegedSnapshot(graph).records.find((record) => record.id === 'odd-status').status, { v: 'x' }, 'a returned value is a copy');
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
