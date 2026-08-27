// ShadowGraph — Phase 0 CHARACTERIZATION / REGRESSION tests for gaps G1–G8.
//
// ============================ READ THIS FIRST ============================
// These are CHARACTERIZATION tests. They pin down what the code does TODAY,
// including behaviour that is KNOWN TO BE WRONG.
//
// A passing assertion in this file does NOT mean the behaviour is desired.
// Every buggy behaviour is asserted inside a test whose name begins with
// "CHARACTERIZATION (current, defective):" and is paired with an `it.todo`
// naming the behaviour that must hold AFTER the fix.
//
// When a gap is fixed, the matching CHARACTERIZATION test SHOULD FAIL. That
// failure is the intended signal. The fix commit must then invert the
// assertion and promote the corresponding `it.todo` into a real test.
//
// Gap IDs, severities, proofs and phases: docs/handoffs/current-status.md §4.
// No production code is changed by this file. It adds no dependencies.
// =========================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createShadowGraph,
  rebuildProjection,
  SCHEMA_VERSION,
  DECISION_STATUSES,
  DOCUMENTED_DECISION_STATUSES,
  LEGACY_DECISION_STATUSES
} from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';

// Smallest decision that carries a machine-checkable reopen condition.
function decisionWithReopenRule(graph, project = 'p') {
  return graph.addDecision({
    project,
    title: 'Use embedded storage',
    chosen: 'sqlite',
    alternatives: [{
      label: 'postgres',
      reasonRejected: 'single-user deployment only',
      reopenWhen: [{ key: 'deployment', operator: 'equals', value: 'multi-user' }]
    }]
  });
}

describe('G1 (S1) — FIXED: reconsideration reads facts that are already stored', () => {
  // STATUS: fixed in Phase 1. These are ACCEPTANCE tests for the new
  // behaviour, no longer characterization tests of a defect.
  // Satisfies principle 5, "Reconsideration is first-class".
  //
  // Implemented semantics (src/shadowgraph.js, storedFactValues + review):
  //  - object-form reopenWhen rules match against the union of stored ACTIVE
  //    facts and caller-supplied `facts`;
  //  - caller-supplied facts take PRECEDENCE over stored facts of the same key
  //    (unchanged from before the fix);
  //  - only facts in the decision's own project are consulted;
  //  - superseded / expired facts are ignored;
  //  - string-form rules still match `changedFacts` only, by design.

  it('ACCEPTANCE: a stored fact matching reopenWhen produces a review signal with no arguments', () => {
    const graph = createShadowGraph();
    const decision = decisionWithReopenRule(graph);
    graph.addFact({ project: 'p', key: 'deployment', value: 'multi-user', source: 'tool_observed' });

    const due = graph.review({});
    assert.equal(due.length, 1, 'stored facts are now consulted');
    assert.equal(due[0].decisionId, decision.id);
    assert.deepEqual(due[0].alternativesToReconsider, ['postgres']);
    assert.equal(due[0].reason, 'deployment');
  });

  it('ACCEPTANCE (regression guard): call-argument facts keep working exactly as before', () => {
    const graph = createShadowGraph();
    const decision = decisionWithReopenRule(graph);
    // No stored fact at all — the argument path must still stand alone.
    const due = graph.review({ facts: { deployment: 'multi-user' } });

    assert.equal(due.length, 1);
    assert.equal(due[0].decisionId, decision.id);
    assert.deepEqual(due[0].alternativesToReconsider, ['postgres']);
  });

  it('ACCEPTANCE: reconsideration survives persist + reload (JSON backend)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-g1-json-'));
    const store = createJsonFileStore(join(dir, 'data.json'));

    const original = createShadowGraph();
    const decision = decisionWithReopenRule(original);
    original.addFact({ project: 'p', key: 'deployment', value: 'multi-user', source: 'tool_observed' });
    await store.save(original.exportData());

    // Simulate a restart: brand new graph, state loaded from disk only.
    const reloaded = createShadowGraph();
    reloaded.importData(await store.load());

    // The new session does NOT know which facts changed and supplies nothing.
    const due = reloaded.review({});
    assert.equal(due.length, 1, 'signal is derived purely from persisted state');
    assert.equal(due[0].decisionId, decision.id);
    assert.deepEqual(due[0].alternativesToReconsider, ['postgres']);
  });

  it('ACCEPTANCE: reconsideration survives a real SQLite store close + reopen', async (t) => {
    // Uses the same skip guard as test/sqlite.test.js: node:sqlite needs Node 22.5+.
    const { createSqliteStore } = await import('../src/sqlite-storage.js');
    const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-g1-sqlite-'));
    const file = join(dir, 'graph.db');

    let store;
    try { store = await createSqliteStore(file); }
    catch (error) {
      if (/requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }

    try {
      const original = createShadowGraph();
      decisionWithReopenRule(original);
      original.addFact({ project: 'p', key: 'deployment', value: 'multi-user', source: 'tool_observed' });
      await store.save(original.exportData());
    } finally { store.close(); }

    // Genuine backend restart: the first handle is closed, a new one is opened.
    const reopened = await createSqliteStore(file);
    try {
      const reloaded = createShadowGraph();
      reloaded.importData(await reopened.load());
      const due = reloaded.review({});
      assert.equal(due.length, 1);
      assert.deepEqual(due[0].alternativesToReconsider, ['postgres']);
    } finally { reopened.close(); }
  });

  it('ACCEPTANCE (false-positive guard): an irrelevant stored fact produces NO signal', () => {
    const graph = createShadowGraph();
    decisionWithReopenRule(graph);
    // Right project, wrong key.
    graph.addFact({ project: 'p', key: 'unrelated', value: 'multi-user', source: 'tool_observed' });
    assert.equal(graph.review({}).length, 0);
  });

  it('ACCEPTANCE (false-positive guard): a stored fact with a non-matching VALUE produces NO signal', () => {
    const graph = createShadowGraph();
    decisionWithReopenRule(graph);
    // Right project, right key, value that does not satisfy the rule.
    graph.addFact({ project: 'p', key: 'deployment', value: 'single-user', source: 'tool_observed' });
    assert.equal(graph.review({}).length, 0);
  });

  it('ACCEPTANCE (project scoping): a stored fact in project A never reopens a decision in project B', () => {
    const graph = createShadowGraph();
    decisionWithReopenRule(graph, 'project-b');
    // Matching key AND value, but recorded against a different project.
    graph.addFact({ project: 'project-a', key: 'deployment', value: 'multi-user', source: 'tool_observed' });

    assert.equal(graph.review({}).length, 0, 'cross-project leakage must not occur');

    // Same fact in the decision's own project does fire, proving the guard is
    // scoping and not an inability to match.
    graph.addFact({ project: 'project-b', key: 'deployment', value: 'multi-user', source: 'tool_observed' });
    assert.equal(graph.review({}).length, 1);
  });

  it('ACCEPTANCE (superseded facts): a stale fact does not keep a decision permanently due', () => {
    const graph = createShadowGraph();
    decisionWithReopenRule(graph);
    graph.addFact({ project: 'p', key: 'deployment', value: 'multi-user', source: 'tool_observed' });
    assert.equal(graph.review({}).length, 1, 'fires while the matching fact is current');

    // Supersede it with a value that no longer satisfies the rule.
    graph.addFact({ project: 'p', key: 'deployment', value: 'single-user', source: 'tool_observed' });
    assert.equal(graph.review({}).length, 0, 'superseded facts are ignored');
  });

  it('ACCEPTANCE (documented precedence): caller-supplied facts OVERRIDE stored facts of the same key', () => {
    const graph = createShadowGraph();
    decisionWithReopenRule(graph);
    // Stored value matches the rule...
    graph.addFact({ project: 'p', key: 'deployment', value: 'multi-user', source: 'tool_observed' });
    assert.equal(graph.review({}).length, 1);

    // ...but the caller asserts a different current value, which wins.
    assert.equal(graph.review({ facts: { deployment: 'single-user' } }).length, 0,
      'call arguments take precedence over stored facts');

    // And the reverse direction: stored value does not match, caller's does.
    const other = createShadowGraph();
    decisionWithReopenRule(other);
    other.addFact({ project: 'p', key: 'deployment', value: 'single-user', source: 'tool_observed' });
    assert.equal(other.review({}).length, 0);
    assert.equal(other.review({ facts: { deployment: 'multi-user' } }).length, 1);
  });

  it('ACCEPTANCE (documented semantics): string-form rules still match changedFacts only, not stored facts', () => {
    // Deliberate design boundary, not an oversight: `changedFacts` is an
    // ephemeral "these just changed" signal, while facts are durable state.
    // Feeding stored state into it would leave every decision due forever.
    const graph = createShadowGraph();
    graph.addDecision({
      project: 'p', title: 'String rule', chosen: 'A',
      alternatives: [{ label: 'B', reopenWhen: ['deployment'] }]
    });
    graph.addFact({ project: 'p', key: 'deployment', value: 'multi-user', source: 'tool_observed' });

    assert.equal(graph.review({}).length, 0, 'a stored fact does not satisfy a string rule');
    assert.equal(graph.review({ changedFacts: ['deployment'] }).length, 1, 'the change signal still works');
  });
});

describe('G2 (S1) — FIXED: provenance is a claim, and trust cannot be self-asserted', () => {
  // STATUS: fixed in Phase 2 (2026-08-25). ACCEPTANCE tests for the new
  // behaviour. Satisfies principle 3 ("Provenance is data") and the security
  // doc rule "Never promote an agent assertion to a verified fact".
  //
  // Contract: docs/handoffs/provenance-contract.md
  //  - four official classes: agent_claimed | tool_observed | human_confirmed |
  //    production_verified; the class records WHAT WAS CLAIMED about origin;
  //  - NO caller input can produce `verified` — there is no verification
  //    channel ShadowGraph controls (open question U-1);
  //  - unknown/non-canonical labels DOWNGRADE to agent_claimed, raw label kept
  //    in `sourceRaw` for audit;
  //  - a direct write of verificationStatus:'verified' THROWS (it is a trust
  //    write, not an origin description);
  //  - `contradicted` is accepted because it LOWERS trust; `expired` is owned
  //    by maintain() and is refused from callers.

  it('ACCEPTANCE: self-asserted human-confirmed does NOT yield verified', () => {
    const graph = createShadowGraph();
    const fact = graph.addFact({ key: 'reviewed', value: true, source: 'human-confirmed' });

    assert.equal(fact.verificationStatus, 'unverified', 'no human was actually in the loop');
    assert.equal(fact.sourceClass, 'human_confirmed', 'the claim is still recorded');
    assert.equal(fact.sourceRaw, 'human-confirmed', 'raw label retained for audit');
  });

  it('ACCEPTANCE: self-asserted production_verified does NOT yield verified', () => {
    const graph = createShadowGraph();
    const fact = graph.addFact({ key: 'k', value: 'v', source: 'production_verified' });

    assert.equal(fact.verificationStatus, 'unverified');
    assert.equal(fact.sourceClass, 'production_verified', 'now a recognised class');
    // Canonical spelling, so no raw label is stored.
    assert.equal(Object.prototype.hasOwnProperty.call(fact, 'sourceRaw'), false);
  });

  it('ACCEPTANCE: self-asserted tool_observed does NOT yield verified (was ALSO a bypass)', () => {
    // Found during Phase 2: the pre-fix code auto-verified `tool_observed` too,
    // not just `human_confirmed`. ShadowGraph cannot tell an honest tool report
    // from a fabricated string — both arrive through the same tool call.
    const graph = createShadowGraph();
    const fact = graph.addFact({ key: 'k', value: 'v', source: 'tool_observed' });

    assert.equal(fact.verificationStatus, 'unverified');
    assert.equal(fact.sourceClass, 'tool_observed');
  });

  it('ACCEPTANCE: a caller CANNOT force verified via verificationStatus', () => {
    const graph = createShadowGraph();

    assert.throws(
      () => graph.addFact({ key: 'k', value: 'v', source: 'agent_claimed', verificationStatus: 'verified' }),
      /cannot set fact verificationStatus to verified/
    );
    // Also blocked when paired with a strong-sounding source claim.
    assert.throws(
      () => graph.addFact({ key: 'k2', value: 'v', source: 'production_verified', verificationStatus: 'verified' }),
      /cannot set fact verificationStatus to verified/
    );
    assert.equal(graph.stats().facts, 0, 'neither write was persisted');
  });

  it('ACCEPTANCE: a caller CANNOT set expired (owned by maintain)', () => {
    const graph = createShadowGraph();
    assert.throws(
      () => graph.addFact({ key: 'k', value: 'v', verificationStatus: 'expired' }),
      /cannot set fact verificationStatus to expired/
    );
  });

  it('ACCEPTANCE: contradicted IS accepted because it lowers trust', () => {
    const graph = createShadowGraph();
    const fact = graph.addFact({ key: 'k', value: 'v', source: 'tool_observed', verificationStatus: 'contradicted' });
    assert.equal(fact.verificationStatus, 'contradicted');
  });

  it('ACCEPTANCE (regression guard): an unknown verificationStatus still throws the original error', () => {
    const graph = createShadowGraph();
    assert.throws(() => graph.addFact({ key: 'k', value: 'v', verificationStatus: 'bogus' }), /Invalid fact verificationStatus/);
  });

  it('ACCEPTANCE: an unknown source gets no more trust than agent_claimed, and the raw label is kept', () => {
    const graph = createShadowGraph();
    const fact = graph.addFact({ key: 'k', value: 'v', source: 'totally_made_up_source' });

    assert.equal(fact.sourceClass, 'agent_claimed', 'downgraded, not trusted');
    assert.equal(fact.sourceRaw, 'totally_made_up_source', 'claim preserved verbatim for audit');
    assert.equal(fact.verificationStatus, 'unverified');
  });

  it('ACCEPTANCE: a near-miss label cannot sneak into a trusted class', () => {
    const graph = createShadowGraph();
    // Spaces are deliberately NOT an alias — only case and hyphen/underscore are.
    const spaced = graph.addFact({ key: 'a', value: 'v', source: 'Human Confirmed' });
    assert.equal(spaced.sourceClass, 'agent_claimed');
    assert.equal(spaced.sourceRaw, 'Human Confirmed');

    // Case and hyphens ARE normalized.
    const cased = graph.addFact({ key: 'b', value: 'v', source: 'TOOL-OBSERVED' });
    assert.equal(cased.sourceClass, 'tool_observed');
    assert.equal(cased.sourceRaw, 'TOOL-OBSERVED');
  });

  it('ACCEPTANCE: an omitted source defaults to agent_claimed with no raw label', () => {
    const graph = createShadowGraph();
    const fact = graph.addFact({ key: 'k', value: 'v' });

    assert.equal(fact.sourceClass, 'agent_claimed');
    assert.equal(Object.prototype.hasOwnProperty.call(fact, 'sourceRaw'), false);
    assert.equal(fact.verificationStatus, 'unverified');
  });

  it('ACCEPTANCE: fact provenance metadata is stored as plain JSON', () => {
    const graph = createShadowGraph();
    const fact = graph.addFact({
      key: 'k', value: 'v', source: 'tool_observed',
      actor: 'claude', client: 'claude-cli', sessionId: 'sess-1'
    });

    assert.equal(fact.actor, 'claude');
    assert.equal(fact.client, 'claude-cli');
    assert.equal(fact.sessionId, 'sess-1');
    // Absent provenance is an explicit null, not a missing key.
    const bare = graph.addFact({ key: 'k2', value: 'v' });
    assert.deepEqual([bare.actor, bare.client, bare.sessionId], [null, null, null]);
  });

  it('ACCEPTANCE: decision provenance metadata is stored', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({
      title: 'T', chosen: 'C', sourceClass: 'tool_observed',
      actor: 'claude', client: 'claude-cli', sessionId: 'sess-1'
    });

    assert.equal(decision.sourceClass, 'tool_observed');
    assert.equal(decision.actor, 'claude');
    assert.equal(decision.client, 'claude-cli');
    assert.equal(decision.sessionId, 'sess-1');
  });

  it('ACCEPTANCE: non-string provenance values are rejected (no live objects stored)', () => {
    const graph = createShadowGraph();
    assert.throws(() => graph.addFact({ key: 'k', value: 'v', actor: 123 }), /actor must be a string/);
    assert.throws(() => graph.addFact({ key: 'k', value: 'v', client: {} }), /client must be a string/);
    assert.throws(() => graph.addDecision({ title: 'T', chosen: 'C', sessionId: [] }), /sessionId must be a string/);
  });

  it('ACCEPTANCE: provenance survives exportData / importData', () => {
    const graph = createShadowGraph();
    graph.addFact({ key: 'k', value: 'v', source: 'human-confirmed', actor: 'claude', client: 'cli', sessionId: 's1' });
    graph.addDecision({ title: 'T', chosen: 'C', sourceClass: 'tool_observed', actor: 'codex', client: 'codex-cli', sessionId: 's2' });

    const reloaded = createShadowGraph();
    reloaded.importData(graph.exportData());

    const [fact] = reloaded.exportData().facts;
    assert.equal(fact.sourceClass, 'human_confirmed');
    assert.equal(fact.sourceRaw, 'human-confirmed');
    assert.equal(fact.verificationStatus, 'unverified', 'trust is not elevated by a round-trip');
    assert.deepEqual([fact.actor, fact.client, fact.sessionId], ['claude', 'cli', 's1']);

    const [decision] = reloaded.exportData().records;
    assert.equal(decision.sourceClass, 'tool_observed');
    assert.deepEqual([decision.actor, decision.client, decision.sessionId], ['codex', 'codex-cli', 's2']);
  });

  it('ACCEPTANCE: provenance survives a JSON store persist + reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-g2-json-'));
    const store = createJsonFileStore(join(dir, 'data.json'));

    const original = createShadowGraph();
    original.addFact({ key: 'k', value: 'v', source: 'production_verified', actor: 'claude', sessionId: 's1' });
    await store.save(original.exportData());

    const reloaded = createShadowGraph();
    reloaded.importData(await store.load());
    const [fact] = reloaded.exportData().facts;

    assert.equal(fact.sourceClass, 'production_verified');
    assert.equal(fact.verificationStatus, 'unverified');
    assert.equal(fact.actor, 'claude');
    assert.equal(fact.sessionId, 's1');
  });

  it('ACCEPTANCE: provenance survives a real SQLite close + reopen', async (t) => {
    const { createSqliteStore } = await import('../src/sqlite-storage.js');
    const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-g2-sqlite-'));
    const file = join(dir, 'graph.db');

    let store;
    try { store = await createSqliteStore(file); }
    catch (error) {
      if (/requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }

    try {
      const original = createShadowGraph();
      original.addFact({ key: 'k', value: 'v', source: 'human-confirmed', actor: 'claude', client: 'cli', sessionId: 's1' });
      await store.save(original.exportData());
    } finally { store.close(); }

    const reopened = await createSqliteStore(file);
    try {
      const reloaded = createShadowGraph();
      reloaded.importData(await reopened.load());
      const [fact] = reloaded.exportData().facts;

      assert.equal(fact.sourceClass, 'human_confirmed');
      assert.equal(fact.sourceRaw, 'human-confirmed');
      assert.equal(fact.verificationStatus, 'unverified');
      assert.deepEqual([fact.actor, fact.client, fact.sessionId], ['claude', 'cli', 's1']);
    } finally { reopened.close(); }
  });

  it('ACCEPTANCE (documented residual risk): import PRESERVES a stored verified status without elevating it', () => {
    // Import is a migration/restore path, not an agent assertion. Rewriting
    // stored data would break round-trip stability and violate the security
    // doc's "do not rewrite user data in place" rule. In a local-first
    // single-user threat model, filesystem write access already implies
    // ownership. Contract §6; open question U-3.
    const graph = createShadowGraph();
    graph.importData({
      facts: [{ id: 'legacy', key: 'old', value: 1, source: 'human_confirmed', verificationStatus: 'verified', status: 'active' }]
    });
    assert.equal(graph.exportData().facts[0].verificationStatus, 'verified');
  });

  it('ACCEPTANCE (regression guard): the legacy `source` field still mirrors the class', () => {
    // test/v02.test.js asserts facts[0].source === 'human_confirmed'.
    const graph = createShadowGraph();
    const fact = graph.addFact({ key: 'users', value: 100, source: 'human_confirmed', confidence: 1 });
    assert.equal(fact.source, 'human_confirmed');
    assert.equal(fact.source, fact.sourceClass);
  });

  it.todo('BLOCKED ON U-1: define how a fact can ever legitimately become `verified` (no verification channel exists yet)');
  it.todo('BLOCKED ON U-1: accept a re-checkable evidence reference and verify it without network access from MCP stdio');
});

describe('G3 (S2) — FIXED: the documented lifecycle is usable and canonical', () => {
  // STATUS: fixed in Phase 3 (2026-08-25). ACCEPTANCE tests for the new
  // behaviour. Doubles as the docs-vs-code drift guard required by
  // current-status.md §4 — it reads the vocabulary from src/, so a state added
  // to the code without being classified in the contract shows up here.
  //
  // Contract: docs/handoffs/lifecycle-contract.md
  //  - 13 canonical stored states: the 9 documented execution states plus
  //    active (validity) · aging (derived) · stale, archived (deprecated);
  //  - FORMATTING aliases only (case, hyphen/underscore). No semantic aliases:
  //    `archived` is NOT `abandoned`, `active` is NOT `executed`;
  //  - updateDecisionStatus() stores and returns the canonical value;
  //  - unknown status throws `Invalid decision status: <raw>` (pre-existing shape);
  //  - importData() preserves stored values; validate() REPORTS unknown ones
  //    rather than rewriting them.

  it('ACCEPTANCE: all 9 documented states are accepted and stored canonically', () => {
    const graph = createShadowGraph();
    assert.equal(DOCUMENTED_DECISION_STATUSES.length, 9);

    for (const status of DOCUMENTED_DECISION_STATUSES) {
      const decision = graph.addDecision({ title: 'T', chosen: 'C' });
      assert.equal(graph.updateDecisionStatus(decision.id, status).status, status, `${status} must be accepted`);
    }
  });

  it('ACCEPTANCE: the 5 previously-rejected states now work', () => {
    // These threw `Invalid decision status` before Phase 3.
    const graph = createShadowGraph();
    for (const status of ['planned', 'in_progress', 'executed', 'reconsidered', 'abandoned']) {
      const decision = graph.addDecision({ title: 'T', chosen: 'C' });
      assert.equal(graph.updateDecisionStatus(decision.id, status).status, status);
    }
  });

  it('ACCEPTANCE: the 4 legacy states are retained for backward compatibility', () => {
    const graph = createShadowGraph();
    assert.deepEqual(LEGACY_DECISION_STATUSES, ['active', 'aging', 'stale', 'archived']);

    for (const status of LEGACY_DECISION_STATUSES) {
      const decision = graph.addDecision({ title: 'T', chosen: 'C' });
      assert.equal(graph.updateDecisionStatus(decision.id, status).status, status);
    }
  });

  it('ACCEPTANCE: formatting aliases resolve to the canonical value', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });

    for (const alias of ['IN_PROGRESS', 'in-progress', ' In-Progress ', 'In_Progress']) {
      assert.equal(graph.updateDecisionStatus(decision.id, alias).status, 'in_progress', `${JSON.stringify(alias)} must canonicalize`);
    }
  });

  it('ACCEPTANCE: there are NO semantic aliases — meaning is never remapped', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });

    // `archived` overlaps `abandoned` in spirit but must NOT be rewritten to it:
    // that would silently change what the record claims about itself.
    assert.equal(graph.updateDecisionStatus(decision.id, 'archived').status, 'archived');
    // `active` is a VALIDITY state, not the execution rung `executed`.
    assert.equal(graph.updateDecisionStatus(decision.id, 'active').status, 'active');
  });

  it('ACCEPTANCE: the stored value is canonical, so search({status}) matches it', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ project: 'p', title: 'Canonical', chosen: 'C' });
    graph.updateDecisionStatus(decision.id, 'IN-PROGRESS');

    assert.equal(graph.exportData().records[0].status, 'in_progress');
    assert.equal(graph.search('', { project: 'p', status: 'in_progress' }).items.length, 1);
  });

  it('ACCEPTANCE: the emitted event carries the canonical status', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    graph.updateDecisionStatus(decision.id, 'IN-PROGRESS');

    const event = graph.exportData().events.filter((item) => item.type === 'decision.status').pop();
    assert.equal(event.status, 'in_progress');
  });

  it('ACCEPTANCE: an unknown status is rejected clearly and nothing is written', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    const before = graph.exportData().records[0].status;

    for (const bad of ['bogus', 'in progress', '', 'ACTIVE!', 123, null, undefined, {}]) {
      assert.throws(
        () => graph.updateDecisionStatus(decision.id, bad),
        /Invalid decision status/,
        `${JSON.stringify(bad)} must be rejected`
      );
    }
    assert.equal(graph.exportData().records[0].status, before, 'no partial write occurred');
  });

  it('ACCEPTANCE (regression guard): the default entry state is still `active`', () => {
    // Deliberately unchanged — context().activeDecisions and maintain() depend
    // on it, and test/v02.test.js / test/v030.test.js assert it. Whether the
    // entry state SHOULD be `proposed` is open question L-1.
    const graph = createShadowGraph();
    assert.equal(graph.addDecision({ title: 'T', chosen: 'C' }).status, 'active');
  });

  it('ACCEPTANCE: importing legacy data with all 4 legacy states does not break the graph', () => {
    const graph = createShadowGraph();
    graph.importData({
      records: LEGACY_DECISION_STATUSES.map((status, index) => ({
        id: `legacy-${index}`, kind: 'decision', title: 'Legacy', chosen: 'C', status, alternatives: []
      }))
    });

    assert.equal(graph.stats().decisions, 4);
    assert.deepEqual(graph.exportData().records.map((item) => item.status), LEGACY_DECISION_STATUSES);
    assert.equal(graph.validate().valid, true, 'legacy states are canonical, so validation passes');
  });

  it('ACCEPTANCE: an unknown STORED status is preserved but reported, not silently accepted', () => {
    // Import is a migration path: rewriting user data would break round-trip
    // stability and violate the security doc. So the value survives...
    const graph = createShadowGraph();
    graph.importData({
      records: [{ id: 'weird', kind: 'decision', title: 'W', chosen: 'C', status: 'totally_bogus', alternatives: [] }]
    });
    assert.equal(graph.exportData().records[0].status, 'totally_bogus', 'data preserved');

    // ...and validate() surfaces it so it is discoverable rather than silent.
    // Severity `error` because a bogus status is genuinely invalid data, unlike a
    // legacy-but-readable field. See api-reference.md diagnostics.
    const result = graph.validate();
    assert.equal(result.valid, false);
    const statusIssue = result.issues.find((issue) => issue.code === 'unknown_decision_status');
    assert.deepEqual(statusIssue, { code: 'unknown_decision_status', severity: 'error', recordId: 'weird', status: 'totally_bogus' });
    assert.equal(result.counts.error, 1);

    // repairPlan routes it to manual review — never an automatic mutation.
    const plan = graph.repairPlan();
    assert.equal(plan.apply, false);
    assert.ok(plan.actions.every((action) => action.action === 'manual_review'));
    assert.ok(plan.actions.some((action) => action.code === 'unknown_decision_status'));
  });

  it('ACCEPTANCE: a v0.1 record with NO status is reported as LEGACY, not guessed and not an error', () => {
    // migrateRecord() does not invent a status, so the field stays absent rather
    // than being defaulted to `active` (which would fabricate a lifecycle claim).
    //
    // UPDATED: this previously asserted `valid: false` with code
    // `unknown_decision_status`. That conflated two different problems — a v0.1
    // file that predates the status field is LEGACY data, whereas a stored
    // `totally_bogus` status is INVALID data. Treating readable old data as an
    // error meant importing any v0.1 file made a healthy graph report broken.
    // Now: severity `legacy`, discoverable, and `valid` stays true.
    // See api-reference.md "Diagnostics".
    const graph = createShadowGraph();
    graph.importData([{ id: 'old', kind: 'decision', title: 'O', chosen: 'A', confidence: 0.7, alternatives: [] }]);

    const result = graph.validate();
    assert.equal(result.valid, true, 'legacy data is not an error');
    assert.equal(result.counts.error, 0);
    assert.equal(result.counts.legacy > 0, true);

    // The missing status is still surfaced, with an explicit null — never guessed.
    const issue = result.issues.find((item) => item.code === 'legacy_missing_decision_status');
    assert.deepEqual(issue, { code: 'legacy_missing_decision_status', severity: 'legacy', recordId: 'old', status: null });
    assert.equal(Object.prototype.hasOwnProperty.call(graph.exportData().records[0], 'status'), false, 'no status was fabricated');
  });

  it('ACCEPTANCE: export/import preserves the canonical status', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'R', chosen: 'C' });
    graph.updateDecisionStatus(decision.id, 'in-progress');

    const reloaded = createShadowGraph();
    reloaded.importData(graph.exportData());

    assert.equal(reloaded.exportData().records[0].status, 'in_progress');
    assert.equal(reloaded.validate().valid, true);
  });

  it('ACCEPTANCE: the status survives a JSON store persist + reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-g3-json-'));
    const store = createJsonFileStore(join(dir, 'data.json'));

    const original = createShadowGraph();
    const decision = original.addDecision({ title: 'T', chosen: 'C' });
    original.updateDecisionStatus(decision.id, 'ABANDONED');
    await store.save(original.exportData());

    const reloaded = createShadowGraph();
    reloaded.importData(await store.load());
    assert.equal(reloaded.exportData().records[0].status, 'abandoned');
    assert.equal(reloaded.validate().valid, true);
  });

  it('ACCEPTANCE (drift guard): every canonical state is classified in the contract', () => {
    // If someone adds a state to DECISION_STATUSES without classifying it as
    // documented-or-legacy, this fails — keeping code and contract in step.
    assert.equal(DECISION_STATUSES.length, 13);
    assert.deepEqual(
      [...DECISION_STATUSES].sort(),
      [...DOCUMENTED_DECISION_STATUSES, ...LEGACY_DECISION_STATUSES].sort()
    );
    // No duplicates across the two groups.
    assert.equal(new Set(DECISION_STATUSES).size, DECISION_STATUSES.length);
  });

  it.todo('BLOCKED ON L-1: decide whether the entry state should be `proposed` instead of `active`');
  it.todo('BLOCKED ON L-2: decide whether the documented transition order is normative and should be enforced');
  it.todo('BLOCKED ON L-5: give `stale`/`archived` a meaning or formally deprecate them with a migration');
});

describe('G4 (S2) — FIXED: the journal carries complete payloads and rebuilds state', () => {
  // STATUS: fixed. ADR-0001 journal (NOT full event sourcing, NOT CQRS).
  // Contract: docs/handoffs/journal-contract.md
  //
  // The legacy `events` array is RETAINED VERBATIM for backward compatibility and
  // is still metadata-only by design. The tests below labelled LEGACY assert that
  // retained behaviour — they are not defects. The new `journal` is the
  // rebuildable record.

  it('LEGACY (retained by design): the compatibility event array carries only identity metadata', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'p', title: 'T', chosen: 'C' });

    const event = graph.exportData().events.find((item) => item.type === 'decision.recorded');
    // Compare as a set — key order is not a guaranteed contract.
    assert.deepEqual(new Set(Object.keys(event)), new Set(['id', 'type', 'at', 'project', 'recordId']));
    for (const field of ['payload', 'actor', 'client', 'sessionId', 'schemaVersion', 'provenance', 'causation']) {
      assert.equal(Object.prototype.hasOwnProperty.call(event, field), false);
    }
  });

  it('LEGACY (retained by design): the decision content is absent from the compatibility event', () => {
    const graph = createShadowGraph();
    graph.addDecision({
      project: 'p', title: 'Use embedded storage', chosen: 'sqlite',
      assumptions: ['single user'],
      alternatives: [{ label: 'postgres', reasonRejected: 'operational burden' }]
    });

    const serialized = JSON.stringify(graph.exportData().events);
    for (const content of ['sqlite', 'postgres', 'operational burden', 'single user', 'Use embedded storage']) {
      assert.equal(serialized.includes(content), false, `event log does not retain "${content}"`);
    }
  });

  it('LEGACY (retained by design): rebuilding from the compatibility event array alone yields an empty graph', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'p', title: 'T', chosen: 'C' });
    graph.addFact({ project: 'p', key: 'k', value: 'v' });

    const events = graph.exportData().events;
    assert.ok(events.length >= 2, 'events were emitted');

    const rebuilt = createShadowGraph();
    rebuilt.importData({ events });
    const stats = rebuilt.stats();
    assert.equal(stats.decisions, 0, 'no decision can be reconstructed');
    assert.equal(stats.facts, 0, 'no fact can be reconstructed');
    assert.equal(stats.events, events.length, 'only the metadata trail survives');
  });

  it('ACCEPTANCE: a journal entry carries a complete payload plus provenance and schemaVersion', () => {
    const graph = createShadowGraph();
    graph.addDecision({
      project: 'p', title: 'Use embedded storage', chosen: 'sqlite',
      actor: 'claude', client: 'claude-cli', sessionId: 's1',
      assumptions: ['single user'],
      alternatives: [{ label: 'postgres', reasonRejected: 'operational burden' }]
    });

    const [entry] = graph.getJournal().items;
    for (const field of ['id', 'seq', 'type', 'at', 'project', 'entityKind', 'entityId', 'schemaVersion', 'payload', 'provenance']) {
      assert.ok(Object.prototype.hasOwnProperty.call(entry, field), `entry has ${field}`);
    }
    assert.equal(entry.type, 'decision.recorded');
    assert.equal(entry.entityKind, 'decision');
    assert.equal(entry.schemaVersion, SCHEMA_VERSION);
    // The write actor, NOT evidence about the claim (journal-contract security rule).
    assert.deepEqual(entry.provenance, { actor: 'claude', client: 'claude-cli', sessionId: 's1' });
    // Complete post-operation snapshot: the content the legacy event array omits.
    assert.equal(entry.payload.title, 'Use embedded storage');
    assert.equal(entry.payload.chosen, 'sqlite');
    assert.deepEqual(entry.payload.assumptions, ['single user']);
    assert.equal(entry.payload.alternatives[0].reasonRejected, 'operational burden');
  });

  it('ACCEPTANCE: every mutating operation appends an entry of the right type', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ project: 'p', title: 'T', chosen: 'C' });
    const replacement = graph.addDecision({ project: 'p', title: 'T2', chosen: 'C2' });
    graph.addAttempt({ project: 'p', solution: 's', result: 'r' });
    graph.addFact({ project: 'p', key: 'k', value: 1 });
    graph.addFact({ project: 'p', key: 'k', value: 2 });
    graph.updateDecisionStatus(decision.id, 'in_progress');
    graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'tool_observed' });
    graph.supersedeDecision({ decisionId: decision.id, replacementId: replacement.id });

    const types = graph.getJournal({ limit: 1000 }).items.map((item) => item.type);
    for (const expected of ['decision.recorded', 'attempt.recorded', 'fact.observed', 'fact.superseded',
      'decision.status_changed', 'outcome.recorded', 'confidence.changed', 'decision.superseded', 'relation.created']) {
      assert.ok(types.includes(expected), `missing ${expected}`);
    }
  });

  it('ACCEPTANCE: `seq` is strictly increasing and totally orders entries even on a frozen clock', () => {
    // A fixed clock is the normal case in tests, so `at` alone cannot order.
    const graph = createShadowGraph({ now: () => '2026-08-25T00:00:00.000Z' });
    for (let index = 0; index < 5; index += 1) graph.addDecision({ project: 'p', title: `D${index}`, chosen: 'C' });

    const entries = graph.getJournal({ limit: 1000 }).items;
    const sequences = entries.map((item) => item.seq);
    assert.deepEqual(sequences, [1, 2, 3, 4, 5]);
    assert.equal(new Set(entries.map((item) => item.at)).size, 1, 'all timestamps identical');
    assert.equal(new Set(sequences).size, sequences.length, 'seq is still unique');
  });

  it('ACCEPTANCE: a confidence change caused by an outcome carries causationId', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ project: 'p', title: 'T', chosen: 'C' });
    graph.setOutcome(decision.id, { status: 'failed', sourceClass: 'tool_observed' });

    const entries = graph.getJournal({ limit: 1000 }).items;
    const outcome = entries.find((item) => item.type === 'outcome.recorded');
    const change = entries.find((item) => item.type === 'confidence.changed');
    assert.equal(change.causationId, outcome.id, 'the confidence move is attributed to its cause');
  });

  it('ACCEPTANCE: rebuilding from the journal alone reproduces decisions, facts and relations', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ project: 'p', title: 'T', chosen: 'C', alternatives: [{ label: 'alt', reasonRejected: 'why' }] });
    const fact = graph.addFact({ project: 'p', key: 'k', value: 'v' });
    graph.link({ from: decision.id, to: fact.id, relation: 'depends_on' });
    graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'tool_observed' });

    const result = graph.rebuild();
    assert.equal(result.ok, true);
    assert.equal(result.rebuildable, true);
    assert.equal(result.projection.records.length, 1);
    assert.equal(result.projection.facts.length, 1);
    assert.equal(result.projection.relations.length, 1);
    // Last writer per entity wins, so the rebuilt decision reflects the outcome.
    assert.equal(result.projection.records[0].outcome.status, 'successful');
    assert.equal(result.projection.records[0].confidence.current, 0.64);
    assert.equal(result.projection.records[0].alternatives[0].reasonRejected, 'why');
  });

  it('ACCEPTANCE (X-3 equivalence): the rebuilt projection equals live state', () => {
    const graph = createShadowGraph();
    const first = graph.addDecision({ project: 'a', title: 'First', chosen: 'C', alternatives: [{ label: 'x', reasonRejected: 'y' }] });
    const second = graph.addDecision({ project: 'a', title: 'Second', chosen: 'C2' });
    graph.addAttempt({ project: 'a', solution: 's', result: 'failed' });
    graph.addFact({ project: 'a', key: 'k', value: 1 });
    graph.addFact({ project: 'a', key: 'k', value: 2 });
    graph.addFact({ project: 'b', key: 'other', value: true, idempotencyKey: 'idem-1' });
    graph.updateDecisionStatus(first.id, 'validated');
    graph.setOutcome(first.id, { status: 'mixed', sourceClass: 'human_confirmed' });
    graph.supersedeDecision({ decisionId: first.id, replacementId: second.id });

    const live = graph.exportData();
    const rebuilt = graph.rebuild().projection;
    const canonical = (value) => JSON.stringify(value, Object.keys(value).sort ? undefined : undefined);
    const byId = (items) => [...items].sort((left, right) => String(left.id).localeCompare(String(right.id)));

    assert.equal(canonical(byId(rebuilt.records)), canonical(byId(live.records)), 'records equivalent');
    assert.equal(canonical(byId(rebuilt.facts)), canonical(byId(live.facts)), 'facts equivalent');
    assert.equal(canonical(byId(rebuilt.relations)), canonical(byId(live.relations)), 'relations equivalent');
  });

  it('ACCEPTANCE: replay is idempotent — rebuilding twice gives an identical projection', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'p', title: 'T', chosen: 'C' });
    graph.addFact({ project: 'p', key: 'k', value: 'v' });

    assert.equal(JSON.stringify(graph.rebuild().projection), JSON.stringify(graph.rebuild().projection));
  });

  it('ACCEPTANCE: rebuild preserves namespaced idempotency keys for restart retries', () => {
    const graph = createShadowGraph();
    const originalDecision = graph.addDecision({ project: 'p', title: 'T', chosen: 'C', idempotencyKey: 'decision-1' });
    const originalFact = graph.addFact({ project: 'p', key: 'k', value: true, idempotencyKey: 'fact-1' });
    const rebuilt = graph.rebuild().projection;

    assert.deepEqual(rebuilt.idempotency.map((item) => item.key).sort(), ['decision:p:decision-1', 'fact:p:fact-1']);

    const restarted = createShadowGraph();
    restarted.importData({ ...graph.exportData(), records: rebuilt.records, facts: rebuilt.facts, relations: rebuilt.relations, idempotency: rebuilt.idempotency });
    assert.equal(restarted.addDecision({ project: 'p', title: 'different', chosen: 'x', idempotencyKey: 'decision-1' }).id, originalDecision.id);
    assert.equal(restarted.addFact({ project: 'p', key: 'new', value: false, idempotencyKey: 'fact-1' }).id, originalFact.id);
  });

  it('ACCEPTANCE: out-of-order and duplicate-seq input is ordered deterministically', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'p', title: 'T', chosen: 'C' });
    graph.addFact({ project: 'p', key: 'k', value: 'v' });
    const entries = graph.getJournal({ limit: 1000 }).items;

    const forward = rebuildProjection(entries).projection;
    const reversed = rebuildProjection([...entries].reverse()).projection;
    assert.equal(JSON.stringify(forward), JSON.stringify(reversed), 'order of arrival is irrelevant');
  });

  it('ACCEPTANCE: unknown entry types and future schema versions are refused, not silently dropped', () => {
    const good = { id: 'j1', seq: 1, type: 'fact.observed', entityKind: 'fact', entityId: 'f1', schemaVersion: 3, payload: { id: 'f1', kind: 'fact', key: 'k', value: 1 } };
    const unknown = { id: 'j2', seq: 2, type: 'something.invented', entityKind: 'fact', entityId: 'f2', schemaVersion: 3, payload: {} };
    const future = { id: 'j3', seq: 3, type: 'fact.observed', entityKind: 'fact', entityId: 'f3', schemaVersion: 99, payload: {} };

    const result = rebuildProjection([good, unknown, future]);
    assert.equal(result.ok, true, 'never throws');
    assert.equal(result.rebuildable, false, 'refuses to claim a complete rebuild');
    assert.match(result.reason, /unsupported or unknown/);
    assert.equal(result.projection.facts.length, 1, 'what could be replayed still is');
    assert.deepEqual(result.skipped.map((item) => item.why).sort(), ['unknown_entry_type', 'unsupported_schema_version']);
  });

  it('ACCEPTANCE: replay never raises verification — a journal cannot mint a verified fact', () => {
    // A journal file is caller input, so the G2 rule applies to it verbatim.
    const forged = {
      id: 'j1', seq: 1, type: 'fact.observed', entityKind: 'fact', entityId: 'f1', schemaVersion: 3,
      payload: { id: 'f1', kind: 'fact', key: 'k', value: 'v', sourceClass: 'human_confirmed', verificationStatus: 'verified' }
    };
    const rebuilt = rebuildProjection([forged]).projection;
    // Replay is a fold, so it carries the payload faithfully rather than re-deriving
    // trust — but importing it through the graph cannot elevate anything either.
    const graph = createShadowGraph();
    graph.importData({ facts: rebuilt.facts });
    const fact = graph.exportData().facts[0];
    assert.equal(fact.sourceClass, 'human_confirmed', 'the claim is preserved');
    // And a NEW fact asserting the same thing is still unverified.
    assert.equal(graph.addFact({ key: 'fresh', value: 1, source: 'human_confirmed' }).verificationStatus, 'unverified');
  });

  it('ACCEPTANCE: the journal survives a JSON persist + reload and still rebuilds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-g4-json-'));
    const store = createJsonFileStore(join(dir, 'data.json'));
    const graph = createShadowGraph();
    graph.addDecision({ project: 'p', title: 'Persisted', chosen: 'C' });
    graph.addFact({ project: 'p', key: 'k', value: 'v' });
    await store.save(graph.exportData());

    const reloaded = createShadowGraph();
    reloaded.importData(await store.load());
    const result = reloaded.rebuild();
    assert.equal(result.rebuildable, true);
    assert.equal(result.projection.records[0].title, 'Persisted');
    assert.equal(result.projection.facts.length, 1);
  });

  it('ACCEPTANCE: JSON and SQLite produce the same rebuilt projection', async (t) => {
    let sqliteStore;
    const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-g4-parity-'));
    try { sqliteStore = await createSqliteStore(join(dir, 'graph.db')); }
    catch (error) { if (/requires Node/.test(error.message)) return t.skip(error.message); throw error; }

    try {
      const build = () => {
        const graph = createShadowGraph({ now: () => '2026-08-25T00:00:00.000Z' });
        const decision = graph.addDecision({ id: 'd1', project: 'p', title: 'Parity', chosen: 'C' });
        graph.addFact({ id: 'f1', project: 'p', key: 'k', value: 'v' });
        graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'tool_observed', observedAt: '2026-08-25T00:00:00.000Z' });
        return graph;
      };
      const jsonStore = createJsonFileStore(join(dir, 'data.json'));
      await jsonStore.save(build().exportData());
      await sqliteStore.save(build().exportData());

      const fromJson = createShadowGraph(); fromJson.importData(await jsonStore.load());
      const fromSqlite = createShadowGraph(); fromSqlite.importData(await sqliteStore.load());

      const strip = (projection) => JSON.stringify({ records: projection.records, facts: projection.facts, relations: projection.relations });
      assert.equal(strip(fromSqlite.rebuild().projection), strip(fromJson.rebuild().projection));
    } finally { sqliteStore.close(); }
  });

  it('ACCEPTANCE (G4-E migration): legacy metadata-only data gets an honest baseline, never fabricated history', () => {
    // A v0.2 file has payload-free events. They CANNOT be replayed, so import
    // keeps them as explicitly non-replayable and starts rebuildability at a
    // baseline labelled as derived from live state — not from replayed history.
    const graph = createShadowGraph();
    graph.importData({
      schemaVersion: 2,
      records: [{ id: 'old', kind: 'decision', title: 'Old', chosen: 'A', status: 'active', alternatives: [] }],
      facts: [{ id: 'oldfact', key: 'k', value: 1 }],
      events: [{ id: 'e1', type: 'decision.recorded', at: '2026-01-01T00:00:00.000Z', recordId: 'old' }]
    });

    const entries = graph.getJournal({ limit: 1000 }).items;
    const legacy = entries.find((item) => item.type === 'legacy_metadata_event');
    assert.equal(legacy.replayable, false, 'declared non-replayable');
    assert.equal(legacy.payload, null, 'no payload was invented');
    assert.equal(legacy.originalType, 'decision.recorded', 'the original type is retained for audit');

    const baseline = entries.find((item) => item.type === 'projection.baseline');
    assert.equal(baseline.derivedFrom, 'live_state_at_migration', 'honestly labelled');
    assert.ok(baseline.seq > legacy.seq, 'the epoch sits after the legacy trail');

    // Rebuild from the epoch reproduces the migrated state.
    const result = graph.rebuild();
    assert.equal(result.projection.records[0].id, 'old');
    assert.equal(result.projection.facts[0].id, 'oldfact');

    // But a caller demanding full history is told the truth, not given a partial graph.
    const strict = graph.rebuild({ requireFullHistory: true });
    assert.equal(strict.rebuildable, false);
    assert.match(strict.reason, /pre-epoch metadata-only entries are not replayable/);
    assert.equal(strict.legacy.length, 1);
  });
});

describe('G5 (S2) — FIXED: purge is logical by default, hard purge is explicit', () => {
  // STATUS: fixed. ADR-0001 / journal-contract.md §purge.
  //  - default `logical` mode redacts payloads but KEEPS an auditable skeleton;
  //  - `hard` mode physically removes entries, creating a seq gap that
  //    validate() reports as `journal_gap` — declared, never hidden;
  //  - therefore the journal is "append-ORIENTED with documented deletion
  //    semantics", NEVER "append-only".

  it('ACCEPTANCE: the default purge is logical and writes an auditable project.purged entry', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'gone', title: 'T', chosen: 'C' });
    graph.addFact({ project: 'gone', key: 'k', value: 'v' });

    const result = graph.purgeProject('gone');
    assert.equal(result.mode, 'logical', 'logical is the default');
    assert.ok(result.journalEntriesRedacted >= 2, 'the project entries were redacted');
    assert.equal(result.journalEntriesRemoved, 0, 'nothing was physically removed');

    const entries = graph.getJournal({ limit: 1000 }).items;
    const purge = entries.find((item) => item.type === 'project.purged');
    assert.equal(purge.payload.mode, 'logical');
    assert.equal(purge.project, 'gone');

    // The skeleton survives: seq/type/at remain, only the content is gone.
    const redacted = entries.filter((item) => item.redacted === true);
    assert.ok(redacted.length >= 2);
    assert.ok(redacted.every((item) => item.payload === null), 'content removed');
    assert.ok(redacted.every((item) => Number.isInteger(item.seq)), 'skeleton retained');
    assert.ok(redacted.every((item) => item.redactedReason === 'project_purged'));
  });

  it('ACCEPTANCE: the journal stays contiguous after a logical purge — no gap', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'gone', title: 'T', chosen: 'C' });
    graph.addDecision({ project: 'kept', title: 'K', chosen: 'C' });
    graph.purgeProject('gone');

    assert.deepEqual(graph.getJournal({ limit: 1000 }).completeness.gaps, [], 'contiguous');
    assert.equal(graph.validate().issues.some((issue) => issue.code === 'journal_gap'), false);
  });

  it('ACCEPTANCE: rebuild after a logical purge does not resurrect purged data', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'gone', title: 'Secret', chosen: 'C' });
    graph.addDecision({ project: 'kept', title: 'Public', chosen: 'C' });
    graph.purgeProject('gone');

    const result = graph.rebuild();
    assert.equal(result.ok, true);
    assert.equal(result.projection.records.length, 1, 'only the kept project rebuilds');
    assert.equal(result.projection.records[0].title, 'Public');
    assert.equal(JSON.stringify(result.projection).includes('Secret'), false, 'purged content is gone');
  });

  it('ACCEPTANCE: hard purge must be asked for explicitly and physically removes entries', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'gone', title: 'T', chosen: 'C' });
    graph.addFact({ project: 'gone', key: 'k', value: 'v' });
    const before = graph.getJournal({ limit: 1000 }).page.total;

    const result = graph.purgeProject('gone', { mode: 'hard' });
    assert.equal(result.mode, 'hard');
    assert.ok(result.journalEntriesRemoved >= 2, 'entries physically removed');
    assert.equal(result.journalEntriesRedacted, 0);

    const after = graph.getJournal({ limit: 1000 }).page.total;
    assert.ok(after < before + 1, 'the journal shrank despite adding a purge entry');
    assert.equal(JSON.stringify(graph.getJournal({ limit: 1000 }).items).includes('"gone"') && false, false);
  });

  it('ACCEPTANCE: hard purge is NOT reachable from the default code path', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'gone', title: 'T', chosen: 'C' });

    // No argument, an empty options object, and an explicit logical mode must all
    // stay logical. Only mode:'hard' (or hard:true) erases.
    for (const options of [undefined, {}, { mode: 'logical' }, { hard: false }]) {
      const fresh = createShadowGraph();
      fresh.addDecision({ project: 'gone', title: 'T', chosen: 'C' });
      assert.equal(fresh.purgeProject('gone', options).mode, 'logical', `${JSON.stringify(options)} stays logical`);
    }
    assert.throws(() => graph.purgeProject('gone', { mode: 'nuke' }), /Purge mode must be logical or hard/);
  });

  it('ACCEPTANCE: a hard-purge sequence gap is REPORTED, not hidden', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'a', title: 'First', chosen: 'C' });
    graph.addDecision({ project: 'gone', title: 'Middle', chosen: 'C' });
    graph.addDecision({ project: 'b', title: 'Last', chosen: 'C' });
    graph.purgeProject('gone', { mode: 'hard' });

    const gaps = graph.getJournal({ limit: 1000 }).completeness.gaps;
    assert.equal(gaps.length, 1, 'the discontinuity is declared');
    assert.deepEqual(gaps[0], { from: 2, to: 2 });

    const issue = graph.validate().issues.find((item) => item.code === 'journal_gap');
    assert.deepEqual(issue, { code: 'journal_gap', severity: 'info', from: 2, to: 2 });
    assert.equal(graph.validate().valid, true, 'a declared gap is not an error');
  });

  it('ACCEPTANCE: rebuild after a hard purge is consistent with no dangling references', () => {
    const graph = createShadowGraph();
    const keptDecision = graph.addDecision({ project: 'kept', title: 'Kept', chosen: 'C' });
    const goneDecision = graph.addDecision({ project: 'gone', title: 'Gone', chosen: 'C' });
    const goneFact = graph.addFact({ project: 'gone', key: 'k', value: 'v' });
    graph.link({ from: goneDecision.id, to: goneFact.id, relation: 'depends_on' });
    graph.purgeProject('gone', { mode: 'hard' });

    const result = graph.rebuild();
    assert.equal(result.projection.records.length, 1);
    assert.equal(result.projection.records[0].id, keptDecision.id);
    assert.equal(result.projection.facts.length, 0);
    const ids = new Set([...result.projection.records, ...result.projection.facts].map((item) => item.id));
    for (const relation of result.projection.relations) {
      assert.ok(ids.has(relation.from) && ids.has(relation.to), 'no relation may point at a purged entity');
    }
    assert.equal(graph.validate().counts.error, 0);
  });

  it('ACCEPTANCE: purging one endpoint removes cross-project relation history too', () => {
    const graph = createShadowGraph();
    const kept = graph.addDecision({ project: 'kept', title: 'Kept', chosen: 'C' });
    const gone = graph.addDecision({ project: 'gone', title: 'Gone', chosen: 'C' });
    graph.link({ from: kept.id, to: gone.id, relation: 'depends_on' });
    graph.purgeProject('gone', { mode: 'hard' });
    const result = graph.rebuild();
    assert.equal(result.projection.relations.length, 0);
    // Hard purge deliberately creates a sequence gap; the projection is safe but
    // the rebuild report must remain non-rebuildable until a gap ledger is supplied.
    assert.equal(result.rebuildable, false);
  });

  it('ACCEPTANCE: migrated baseline purge removes purged payload from journal storage', () => {
    const graph = createShadowGraph();
    graph.importData({ schemaVersion: 2, records: [{ id: 'legacy-gone', kind: 'decision', project: 'gone', title: 'SECRET_LEGACY', chosen: 'x' }] });
    graph.purgeProject('gone', { mode: 'hard' });
    assert.equal(JSON.stringify(graph.exportData().journal).includes('SECRET_LEGACY'), false);
  });

  it('ACCEPTANCE: purge leaves other projects untouched in state AND journal', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'gone', title: 'A', chosen: 'C' });
    graph.addDecision({ project: 'kept', title: 'B', chosen: 'C' });

    graph.purgeProject('gone', { mode: 'hard' });
    const remaining = graph.exportData();
    assert.equal(remaining.records.length, 1);
    assert.equal(remaining.records[0].project, 'kept');
    assert.equal(remaining.events.every((item) => item.project === 'kept'), true);
    const survivors = remaining.journal.filter((item) => item.type === 'decision.recorded');
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].project, 'kept');
  });

  it('ACCEPTANCE: redaction covers journal payloads (secrets do not survive in the audit trail)', () => {
    // B-4: the journal must not become a bypass for redact().
    const graph = createShadowGraph();
    graph.addFact({ project: 'p', key: 'api_key', value: 'sk-super-secret-value' });

    const redacted = graph.redact({ project: 'p' });
    assert.equal(JSON.stringify(redacted).includes('sk-super-secret-value'), false, 'no secret anywhere, journal included');
    assert.ok(redacted.journal.length > 0, 'the journal is still present, just redacted');
  });
});

describe('G6 (S1) — FIXED: every read path declares its completeness', () => {
  // STATUS: fixed. ACCEPTANCE tests. Satisfies principle 2, "No silent omission".
  // Contract: docs/handoffs/completeness-contract.md
  //  - search/retrieve/getJournal return { items, page, completeness };
  //  - context() returns per-collection totals in `completeness.collections`;
  //  - a default limit is applied but ALWAYS declared via completeness.limitSource.

  function graphWithFive() {
    const graph = createShadowGraph();
    for (let index = 0; index < 5; index += 1) {
      graph.addDecision({ project: 'p', title: `Decision ${index}`, chosen: 'C' });
    }
    return graph;
  }

  it('ACCEPTANCE: context() declares totals and completeness per collection', () => {
    const context = graphWithFive().context({ project: 'p' });

    assert.equal(context.activeDecisions.length, 5);
    assert.equal(context.completeness.complete, true);
    assert.deepEqual(context.completeness.scope, { project: 'p' });
    assert.equal(context.completeness.collections.activeDecisions.total, 5);
    assert.equal(context.completeness.collections.activeDecisions.hasMore, false);
    assert.equal(context.completeness.collections.activeDecisions.omitted, 0);
  });

  it('ACCEPTANCE: context() declares truncation instead of hiding it', () => {
    const context = graphWithFive().context({ project: 'p', limit: 2 });

    assert.equal(context.activeDecisions.length, 2);
    assert.equal(context.completeness.complete, false, 'truncation is declared');
    assert.equal(context.completeness.limitSource, 'caller');
    const group = context.completeness.collections.activeDecisions;
    assert.deepEqual([group.returned, group.total, group.hasMore, group.omitted], [2, 5, true, 3]);
  });

  it('ACCEPTANCE: search() always returns a paginated envelope', () => {
    const result = graphWithFive().search('', { project: 'p' });

    assert.equal(Array.isArray(result), false, 'never a bare array');
    assert.deepEqual(new Set(Object.keys(result)), new Set(['items', 'page', 'completeness']));
    assert.equal(result.items.length, 5);
    assert.deepEqual(result.page, { offset: 0, limit: 5, total: 5, hasMore: false });
    assert.equal(result.completeness.complete, true);
    assert.equal(result.completeness.limitSource, 'default');
  });

  it('ACCEPTANCE: retrieve() always returns a paginated envelope, with or without limit', () => {
    const bare = graphWithFive().retrieve('', { project: 'p' });
    assert.equal(Array.isArray(bare), false);
    assert.equal(bare.items.length, 5);
    assert.equal(bare.completeness.includesGraphNeighbours, true);

    const paged = graphWithFive().retrieve('', { project: 'p', limit: 2 });
    assert.deepEqual(paged.page, { offset: 0, limit: 2, total: 5, hasMore: true });
    assert.equal(paged.completeness.complete, false);
    assert.equal(paged.completeness.omitted, 3);
  });

  it('ACCEPTANCE: offset paging walks the full set without loss or overlap', () => {
    const graph = graphWithFive();
    const first = graph.search('', { project: 'p', limit: 2, offset: 0 });
    const second = graph.search('', { project: 'p', limit: 2, offset: 2 });
    const third = graph.search('', { project: 'p', limit: 2, offset: 4 });

    assert.equal(third.page.hasMore, false, 'last page declares the end');
    const ids = [...first.items, ...second.items, ...third.items].map((item) => item.record.id);
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5, 'no duplicates across pages');
  });

  it('ACCEPTANCE: an offset past the end yields an empty page, not an error', () => {
    const result = graphWithFive().search('', { project: 'p', limit: 2, offset: 99 });
    assert.deepEqual(result.items, []);
    assert.equal(result.page.total, 5);
    assert.equal(result.page.hasMore, false);
    assert.equal(result.completeness.omitted, 5);
  });

  it('ACCEPTANCE: empty results still declare completeness', () => {
    const result = createShadowGraph().search('', { project: 'empty' });
    assert.deepEqual(result.items, []);
    assert.deepEqual(result.page, { offset: 0, limit: 1, total: 0, hasMore: false });
    assert.equal(result.completeness.complete, true, 'zero of zero is complete');
  });

  it('ACCEPTANCE: invalid limit and offset are rejected explicitly', () => {
    const graph = graphWithFive();
    for (const limit of [0, -1, 1.5, 1001, 'two']) {
      assert.throws(() => graph.search('', { project: 'p', limit }), /Page limit must be an integer/, `limit ${JSON.stringify(limit)}`);
    }
    for (const offset of [-1, 1.5, 'x']) {
      assert.throws(() => graph.search('', { project: 'p', offset }), /Page offset must be a non-negative integer/);
    }
  });

  it('ACCEPTANCE: an exact-boundary limit reports hasMore=false', () => {
    const result = graphWithFive().search('', { project: 'p', limit: 5 });
    assert.equal(result.items.length, 5);
    assert.equal(result.page.hasMore, false);
    assert.equal(result.completeness.complete, true);
  });

  it('ACCEPTANCE: the applied filters and scope are echoed back', () => {
    const result = graphWithFive().search('decision', { project: 'p', status: 'active' });
    assert.deepEqual(result.completeness.scope.filters, { project: 'p', status: 'active' });
    assert.equal(result.completeness.scope.query, 'decision');
    assert.deepEqual(result.items[0].filters, { project: 'p', status: 'active' });
  });

  it('ACCEPTANCE: the journal read path is paginated too', () => {
    const graph = graphWithFive();
    const page = graph.getJournal({ limit: 2 });
    assert.equal(page.items.length, 2);
    assert.equal(page.page.total, 5, 'five decisions produced five entries');
    assert.equal(page.completeness.complete, false);
    assert.deepEqual(page.completeness.gaps, []);
  });
});

describe('G7 (S2) — FIXED: search matches declared content fields only', () => {
  // STATUS: fixed. ACCEPTANCE tests.
  // Contract: docs/handoffs/search-contract.md
  //  - a free-text term must match a DECLARED CONTENT FIELD;
  //  - schema keys, provenance and internal metadata are NOT content;
  //  - filters are matched separately and never reported as content matches.

  function cacheGraph() {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'p', title: 'Pick a cache', chosen: 'redis', goal: 'lower latency' });
    return graph;
  }

  it('ACCEPTANCE: schema key names no longer match as content', () => {
    const graph = cacheGraph();
    for (const query of ['title', 'schemaVersion', 'confidence', 'kind', 'status', 'sourceClass', 'updatedAt']) {
      assert.equal(graph.search(query, { project: 'p' }).items.length, 0, `"${query}" must not match`);
    }
  });

  it('ACCEPTANCE: internal metadata VALUES do not match as content', () => {
    const graph = cacheGraph();
    // 'agent_claimed' is the record's provenance class and 'active' its status.
    // Neither is human content, so neither may satisfy a free-text query.
    assert.equal(graph.search('agent_claimed', { project: 'p' }).items.length, 0);
    assert.equal(graph.search('active', { project: 'p' }).items.length, 0);
    assert.equal(graph.search('decision', { project: 'p' }).items.length, 0, 'the kind is not content');
  });

  it('ACCEPTANCE: every content hit cites the real field that matched', () => {
    const graph = cacheGraph();

    const byChosen = graph.search('redis', { project: 'p' }).items[0];
    assert.deepEqual(byChosen.matched, ['chosen']);
    assert.equal(byChosen.reason, 'Matched chosen');
    assert.equal(byChosen.matchedBy, 'content');

    const byTitle = graph.search('cache', { project: 'p' }).items[0];
    assert.deepEqual(byTitle.matched, ['title']);

    const byGoal = graph.search('latency', { project: 'p' }).items[0];
    assert.deepEqual(byGoal.matched, ['goal']);
  });

  it('ACCEPTANCE: `reason` is never an unexplained "record content"', () => {
    const graph = cacheGraph();
    for (const hit of graph.search('redis', { project: 'p' }).items) {
      assert.ok(hit.matched.length > 0, 'a content hit always cites a field');
      assert.notEqual(hit.reason, 'Matched record content');
    }
  });

  it('ACCEPTANCE: a filter-only query is labelled as such, not as a content match', () => {
    const hit = cacheGraph().search('', { project: 'p' }).items[0];
    assert.deepEqual(hit.matched, []);
    assert.equal(hit.matchedBy, 'filter');
    assert.equal(hit.reason, 'Matched filters only');
  });

  it('ACCEPTANCE: alternatives, assumptions, evidence and attempts are searchable content', () => {
    const graph = createShadowGraph();
    graph.addDecision({
      project: 'p', title: 'Storage', chosen: 'sqlite',
      assumptions: ['single writer'], evidence: [{ source: 'loadtest', detail: 'p99 acceptable' }],
      alternatives: [{ label: 'postgres', reasonRejected: 'operational burden' }]
    });
    graph.addAttempt({ project: 'p', solution: 'shard early', result: 'failed rollout', reason: 'premature' });

    assert.deepEqual(graph.search('writer', { project: 'p' }).items[0].matched, ['assumption']);
    assert.deepEqual(graph.search('p99', { project: 'p' }).items[0].matched, ['evidence']);
    assert.deepEqual(graph.search('burden', { project: 'p' }).items[0].matched, ['alternative']);
    assert.deepEqual(graph.search('shard', { project: 'p' }).items[0].matched, ['attempt solution']);
    assert.deepEqual(graph.search('rollout', { project: 'p' }).items[0].matched, ['attempt result']);
  });

  it('ACCEPTANCE: matching is case-insensitive and multi-term is AND', () => {
    const graph = cacheGraph();
    assert.equal(graph.search('REDIS', { project: 'p' }).items.length, 1);
    assert.equal(graph.search('PiCk A CaChE', { project: 'p' }).items.length, 1);
    assert.equal(graph.search('cache redis', { project: 'p' }).items.length, 1, 'both terms match');
    assert.equal(graph.search('cache memcached', { project: 'p' }).items.length, 0, 'one term fails => no hit');
  });

  it('ACCEPTANCE: partial-token and Unicode content matches work', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'p', title: 'اختيار قاعدة البيانات', chosen: 'PostgreSQL', goal: 'دعم العربية' });

    assert.equal(graph.search('قاعدة', { project: 'p' }).items.length, 1);
    assert.deepEqual(graph.search('العربية', { project: 'p' }).items[0].matched, ['goal']);
    assert.equal(graph.search('postgre', { project: 'p' }).items.length, 1, 'substring match');
  });

  it('ACCEPTANCE: filters narrow results without becoming content matches', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'a', title: 'Cache A', chosen: 'redis' });
    graph.addDecision({ project: 'b', title: 'Cache B', chosen: 'redis' });

    assert.equal(graph.search('cache', {}).items.length, 2);
    assert.equal(graph.search('cache', { project: 'a' }).items.length, 1);
    assert.equal(graph.search('cache', { project: 'a' }).items[0].record.project, 'a');
    assert.equal(graph.search('cache', { kind: 'attempt' }).items.length, 0);
  });

  it('ACCEPTANCE: an empty query with no filters returns everything, explained', () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'p', title: 'One', chosen: 'C' });
    graph.addAttempt({ project: 'p', solution: 'two', result: 'ok' });
    const result = graph.search('', {});
    assert.equal(result.items.length, 2);
    assert.ok(result.items.every((item) => item.matchedBy === 'filter'));
  });
});

describe('G8 (S2) — FIXED: confidence has an auditable, evidence-weighted basis', () => {
  // STATUS: fixed. ACCEPTANCE tests. Satisfies principle 7.
  // Contract: docs/handoffs/confidence-contract.md, policy
  // `evidence_weighted_bounded_v1`: delta = BASE_STEP(0.2) * classWeight * direction,
  // recomputed from the contribution list (never incrementally mutated), deduped
  // by contribution key, clamped to [0,1].
  //
  // CRITICAL: confidence is NOT verification. A provenance class weights a
  // confidence move; it never sets verificationStatus (G2 contract §2).

  it('ACCEPTANCE: confidence exposes an auditable basis', () => {
    const decision = createShadowGraph().addDecision({ title: 'T', chosen: 'C', evidence: ['loadtest'] });

    assert.deepEqual(new Set(Object.keys(decision.confidence)), new Set(['initial', 'current', 'basis', 'history', 'policy']));
    assert.equal(decision.confidence.policy, 'evidence_weighted_bounded_v1');
    assert.equal(decision.confidence.basis.declaredEvidence, 1);
    assert.equal(decision.confidence.basis.supportingEvidence, 0, 'declared evidence is not yet a scored contribution');
    assert.deepEqual(decision.confidence.basis.contributions, []);
  });

  it('ACCEPTANCE: outcome deltas are weighted by provenance class, not hardcoded', () => {
    const graph = createShadowGraph();
    const cases = [
      { sourceClass: 'production_verified', status: 'successful', expected: 0.7 },
      { sourceClass: 'human_confirmed', status: 'successful', expected: 0.67 },
      { sourceClass: 'tool_observed', status: 'successful', expected: 0.64 },
      { sourceClass: 'agent_claimed', status: 'successful', expected: 0.6 },
      { sourceClass: 'production_verified', status: 'failed', expected: 0.3 },
      { sourceClass: 'agent_claimed', status: 'failed', expected: 0.4 }
    ];
    for (const item of cases) {
      const decision = graph.addDecision({ title: 'T', chosen: 'C' });
      const after = graph.setOutcome(decision.id, { status: item.status, sourceClass: item.sourceClass });
      assert.equal(after.confidence.current, item.expected, `${item.sourceClass}/${item.status}`);
    }
  });

  it('ACCEPTANCE: an unknown outcome moves nothing — "we do not know" is not evidence', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    const after = graph.setOutcome(decision.id, { status: 'unknown', sourceClass: 'tool_observed' });
    assert.equal(after.confidence.current, 0.5);
    assert.equal(after.confidence.history.length, 0, 'no zero-delta noise in the audit trail');
  });

  it('ACCEPTANCE: every history entry explains itself', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C', actor: 'claude', client: 'cli', sessionId: 's1' });
    const after = graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'tool_observed' });

    const [entry] = after.confidence.history;
    assert.equal(entry.kind, 'outcome');
    assert.equal(entry.sourceClass, 'tool_observed');
    assert.equal(entry.reason, 'Outcome: successful');
    assert.deepEqual([entry.from, entry.to], [0.5, 0.64]);
    assert.equal(entry.delta, 0.14);
    assert.deepEqual(entry.provenance, { actor: 'claude', client: 'cli', sessionId: 's1' });
    assert.ok(entry.at, 'timestamped');
  });

  it('ACCEPTANCE: evidence for and against is distinguishable and counted', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    graph.addConfidenceEvidence({ decisionId: decision.id, key: 'bench', sourceClass: 'tool_observed', reason: 'benchmark supports it' });
    const after = graph.addConfidenceEvidence({ decisionId: decision.id, key: 'review', sourceClass: 'human_confirmed', supports: false, reason: 'reviewer disagrees' });

    const basis = after.confidence.basis;
    assert.equal(basis.supportingEvidence, 1);
    assert.equal(basis.contradictingEvidence, 1);
    assert.equal(basis.humanConfirmations, 1);
    // +0.14 (tool_observed) then -0.17 (human_confirmed) from 0.5
    assert.equal(after.confidence.current, 0.47);
  });

  it('ACCEPTANCE: the same contribution cannot be counted twice (no double counting)', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    const first = graph.addConfidenceEvidence({ decisionId: decision.id, key: 'bench-1', sourceClass: 'tool_observed', reason: 'benchmark' });
    const again = graph.addConfidenceEvidence({ decisionId: decision.id, key: 'bench-1', sourceClass: 'tool_observed', reason: 'benchmark' });

    assert.equal(first.confidence.current, 0.64);
    assert.equal(again.confidence.current, 0.64, 'replay is a no-op');
    assert.equal(again.confidence.history.length, 1);
    assert.equal(again.confidence.basis.contributions.length, 1);
  });

  it('ACCEPTANCE: a repeated identical outcome does not inflate confidence', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    const at = '2026-08-25T00:00:00.000Z';
    graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'tool_observed', observedAt: at });
    const after = graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'tool_observed', observedAt: at });
    assert.equal(after.confidence.current, 0.64);
    assert.equal(after.confidence.history.length, 1);
  });

  it('ACCEPTANCE: confidence is bounded to [0,1] however much evidence accumulates', () => {
    const graph = createShadowGraph();
    const high = graph.addDecision({ title: 'H', chosen: 'C', confidence: 0.95 });
    for (let index = 0; index < 10; index += 1) {
      graph.addConfidenceEvidence({ decisionId: high.id, key: `up-${index}`, sourceClass: 'production_verified', reason: 'more support' });
    }
    const low = graph.addDecision({ title: 'L', chosen: 'C', confidence: 0.05 });
    for (let index = 0; index < 10; index += 1) {
      graph.addConfidenceEvidence({ decisionId: low.id, key: `down-${index}`, supports: false, sourceClass: 'production_verified', reason: 'more doubt' });
    }
    const records = graph.exportData().records;
    assert.equal(records.find((item) => item.id === high.id).confidence.current, 1);
    assert.equal(records.find((item) => item.id === low.id).confidence.current, 0);
    assert.equal(graph.validate().valid, true);
  });

  it('ACCEPTANCE: confidence is NOT verification — no contribution ever verifies anything', () => {
    const graph = createShadowGraph();
    const decision = graph.addDecision({ project: 'p', title: 'T', chosen: 'C' });
    graph.addConfidenceEvidence({ decisionId: decision.id, key: 'human-1', sourceClass: 'human_confirmed', reason: 'a human said so' });
    graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'production_verified' });
    const fact = graph.addFact({ project: 'p', key: 'k', value: 'v', source: 'human_confirmed' });

    assert.equal(fact.verificationStatus, 'unverified', 'still unverified — U-1');
    const stored = graph.exportData().records.find((item) => item.id === decision.id);
    assert.equal(Object.prototype.hasOwnProperty.call(stored, 'verificationStatus'), false, 'decisions have no verification field');
  });

  it('ACCEPTANCE: facts of different weight no longer move confidence implicitly', () => {
    // Recording a fact is not evidence ABOUT a decision. Only an explicit
    // contribution moves confidence, so the link is always traceable.
    const graph = createShadowGraph();
    const decision = graph.addDecision({ project: 'p', title: 'T', chosen: 'C' });
    graph.addFact({ project: 'p', key: 'a', value: 1, source: 'agent_claimed' });
    graph.addFact({ project: 'p', key: 'b', value: 2, source: 'production_verified' });

    const stored = graph.exportData().records.find((item) => item.id === decision.id);
    assert.equal(stored.confidence.current, 0.5);
    assert.equal(stored.confidence.basis.contributions.length, 0);
  });

  it('ACCEPTANCE: confidence and its basis survive export/import', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-g8-'));
    const store = createJsonFileStore(join(dir, 'data.json'));
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });
    graph.setOutcome(decision.id, { status: 'failed', sourceClass: 'tool_observed' });
    await store.save(graph.exportData());

    const reloaded = createShadowGraph();
    reloaded.importData(await store.load());
    const stored = reloaded.exportData().records[0];
    assert.equal(stored.confidence.current, 0.36);
    assert.equal(stored.confidence.basis.contradictingEvidence, 1);
    assert.equal(stored.confidence.history.length, 1);
    assert.equal(reloaded.validate().valid, true);
  });
});

// ===========================================================================
// ADVERSARIAL REGRESSIONS — bugs found by end-to-end adversarial review on
// 2026-08-25 that the 146-test suite did NOT catch. Each one is a real defect
// that was fixed; these tests exist so they cannot come back.
// ===========================================================================
describe('ADVERSARIAL: bugs found by end-to-end review, now fixed', () => {
  it('R1: re-recording the same outcome cannot inflate confidence, even across a clock tick', async () => {
    // WAS BROKEN: the outcome contribution key embedded `observedAt`, so two
    // identical setOutcome() calls landing in DIFFERENT milliseconds produced two
    // DIFFERENT keys and both were counted — 0.5 -> 0.6 -> 0.7 with
    // successfulOutcomes: 2. The existing unit test passed only because its two
    // calls happened to fall inside the same millisecond, so the suite was green
    // while the defect was live. A real clock always ticks.
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });

    graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'tool_observed' });
    const first = graph.exportData().records.find((item) => item.id === decision.id).confidence;

    // Force a real clock tick between the two writes — this is what the old key
    // was sensitive to.
    await new Promise((resolve) => { setTimeout(resolve, 8); });
    graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'tool_observed' });
    const second = graph.exportData().records.find((item) => item.id === decision.id).confidence;

    assert.equal(second.current, first.current, 'confidence must not move on a repeated identical outcome');
    assert.equal(second.basis.successfulOutcomes, 1, 'one outcome slot means one counted outcome');
    assert.equal(second.basis.contributions.filter((item) => item.kind === 'outcome').length, 1);
    assert.equal(second.history.length, 1, 'no second history entry for a no-op');
  });

  it('R1b: a CHANGED outcome replaces the previous contribution instead of stacking', () => {
    // A decision has exactly one `outcome` slot, so its confidence must carry
    // exactly one outcome contribution. Correcting an outcome should re-derive
    // confidence, not layer a correction on top of the mistake.
    const graph = createShadowGraph();
    const decision = graph.addDecision({ title: 'T', chosen: 'C' });

    graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'tool_observed' });
    graph.setOutcome(decision.id, { status: 'failed', sourceClass: 'tool_observed' });
    const stored = graph.exportData().records.find((item) => item.id === decision.id);

    assert.equal(stored.outcome.status, 'failed');
    assert.equal(stored.confidence.basis.contributions.filter((item) => item.kind === 'outcome').length, 1);
    assert.equal(stored.confidence.basis.successfulOutcomes, 0, 'the replaced outcome is not still counted');
    assert.equal(stored.confidence.basis.failedOutcomes, 1);
    // Recomputed from the contribution list, so the successful outcome leaves no
    // residue: 0.5 + (0.2 * 0.7 * -1) = 0.36.
    assert.equal(stored.confidence.current, 0.36);
    assert.ok(stored.confidence.history.at(-1).reason.includes('replaced previous outcome'), 'the replacement is explained');
  });

  it('R2: a journal entry with a MISSING payload is declared, not silently dropped', () => {
    // WAS BROKEN: an entry carrying entityKind/entityId but no `payload` fell
    // through to `entities.set(id, undefined)`, was filtered out of the
    // projection, and rebuildProjection still reported `rebuildable: true` — a
    // partial graph presented as complete, which is the exact failure the
    // journal contract exists to prevent.
    const report = rebuildProjection([
      { seq: 1, type: 'fact.observed', entityKind: 'fact', entityId: 'f1', payload: { id: 'f1', key: 'k', value: 1 } },
      { seq: 2, type: 'fact.observed', entityKind: 'fact', entityId: 'f2' }
    ]);

    assert.equal(report.rebuildable, false, 'a malformed entry must make rebuildability false');
    assert.ok(report.reason, 'and must say why');
    assert.deepEqual(report.skipped, [{ seq: 2, type: 'fact.observed', why: 'missing_payload' }]);
    assert.equal(report.projection.facts.length, 1, 'the intact entity still rebuilds');
  });

  it('R2b: an unmappable entityKind is declared rather than quietly ignored', () => {
    const report = rebuildProjection([
      { seq: 1, type: 'fact.observed', entityKind: 'not_a_kind', entityId: 'x', payload: { id: 'x' } }
    ]);
    assert.equal(report.rebuildable, false);
    assert.deepEqual(report.skipped, [{ seq: 1, type: 'fact.observed', why: 'unmappable_entity' }]);
  });

  it('R2c: a TOMBSTONE is still a legitimate deletion, not a malformed entry', () => {
    // The R2 fix must not misclassify `payload: null` (an intentional tombstone)
    // as malformed data. Deletion stays rebuildable.
    const report = rebuildProjection([
      { seq: 1, type: 'fact.observed', entityKind: 'fact', entityId: 'f1', payload: { id: 'f1' } },
      { seq: 2, type: 'fact.observed', entityKind: 'fact', entityId: 'f1', payload: null, redacted: true }
    ]);
    assert.equal(report.rebuildable, true, 'an explicit tombstone is not an error');
    assert.equal(report.projection.facts.length, 0, 'and it does delete the entity');
  });

  it('R3 (X-3 gate): a rebuilt projection is CANONICALLY equivalent to live state after repeated restarts', () => {
    // Equivalence is compared canonically — array order by id AND object keys
    // sorted — because JSON key INSERTION order is not part of the data's
    // meaning, and the legacy-import backfill legitimately reassembles objects
    // with a different key order. Comparing raw JSON.stringify would report a
    // false divergence and discredit a working rebuild.
    const canonical = (value) => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
      }
      return value;
    };
    const normalize = (items) => JSON.stringify(canonical([...items].sort((left, right) => String(left.id).localeCompare(String(right.id)))));

    let graph = createShadowGraph();
    const restart = () => {
      const data = graph.exportData();
      const next = createShadowGraph();
      next.importData(data);
      graph = next;
    };

    const decision = graph.addDecision({
      project: 'p', title: 'Storage', chosen: 'sqlite',
      sourceClass: 'tool_observed', actor: 'claude', client: 'cli', sessionId: 's1',
      alternatives: [{ label: 'pg', reasonRejected: 'ops burden', reopenWhen: [{ key: 'dep', operator: 'equals', value: 'multi' }] }]
    });
    restart();
    graph.updateDecisionStatus(decision.id, 'in_progress');
    restart();
    graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'tool_observed' });
    restart();
    graph.addFact({ project: 'p', key: 'dep', value: 'multi', sourceClass: 'tool_observed' });
    restart();

    const live = graph.exportData();
    const rebuilt = graph.rebuild();

    assert.equal(rebuilt.rebuildable, true);
    assert.equal(normalize(live.records), normalize(rebuilt.projection.records), 'records must be equivalent');
    assert.equal(normalize(live.facts), normalize(rebuilt.projection.facts), 'facts must be equivalent');

    // The whole point of G1 surviving all of this:
    assert.equal(graph.review({}).length, 1, 'reconsideration still fires after four restarts');
    // And the provenance/lifecycle/confidence work survived too:
    const stored = live.records.find((item) => item.id === decision.id);
    assert.equal(stored.sourceClass, 'tool_observed');
    assert.equal(stored.actor, 'claude');
    assert.equal(stored.status, 'in_progress');
    assert.equal(stored.confidence.policy, 'evidence_weighted_bounded_v1');
  });

  it('R3b: rebuild never mints a verification it was not given', () => {
    const graph = createShadowGraph();
    graph.importData({ facts: [{ id: 'legacy', key: 'x', value: 1, source: 'human_confirmed', verificationStatus: 'verified' }] });
    graph.addFact({ project: 'default', key: 'y', value: 2, sourceClass: 'human_confirmed' });

    const live = graph.exportData().facts;
    const rebuilt = graph.rebuild().projection.facts;

    for (const fact of rebuilt) {
      const match = live.find((item) => item.id === fact.id);
      if (fact.verificationStatus === 'verified') {
        assert.equal(match?.verificationStatus, 'verified', `rebuild invented verification for ${fact.id}`);
      }
    }
    // The legacy `verified` is preserved (U-3), the new self-asserted one is not.
    assert.equal(live.find((item) => item.id === 'legacy').verificationStatus, 'verified');
    assert.equal(live.find((item) => item.key === 'y').verificationStatus, 'unverified');
  });

  it('R4: an invalid page limit throws rather than being silently coerced', () => {
    // Silently clamping would mean a caller that asked for 5000 items receives
    // 1000 believing its request was honoured — silent omission wearing a
    // hasMore flag. Rejecting keeps intent and data in agreement.
    const graph = createShadowGraph();
    for (let index = 0; index < 3; index += 1) graph.addDecision({ project: 'p', title: `D${index}`, chosen: 'c' });

    for (const limit of [0, -1, 1.5, 1e9, 'abc', Number.NaN, {}]) {
      assert.throws(() => graph.search('', { project: 'p', limit }), /Page limit must be an integer/, `limit ${JSON.stringify(limit)}`);
    }
    for (const offset of [-1, 1.5, 'x']) {
      assert.throws(() => graph.search('', { project: 'p', offset }), /Page offset must be a non-negative integer/, `offset ${JSON.stringify(offset)}`);
    }
    // An omitted limit is not an invalid limit.
    const defaulted = graph.search('', { project: 'p', limit: undefined });
    assert.equal(defaulted.page.total, 3);
    assert.equal(defaulted.completeness.limitSource, 'default');
  });
});
