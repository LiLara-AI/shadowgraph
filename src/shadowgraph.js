// ShadowGraph: an explainable, outcome-aware decision graph.
//
// Contracts (docs/handoffs/):
//   provenance-contract.md  — source classes, why nothing can be `verified`
//   lifecycle-contract.md   — the 13 decision statuses and their classification
//   journal-contract.md     — append-oriented journal + rebuildable projections
//   completeness-contract.md— pagination / no-silent-omission on every read path
//   search-contract.md      — content fields vs filters
//   confidence-contract.md  — evidence-weighted bounded confidence

import { rebuildProjection, journalGaps, duplicateSequences, JOURNAL_ENTRY_TYPES, REPLAYABLE_ENTRY_TYPES } from './journal.js';
import { createConfidence, applyContribution, setOutcomeContribution, computeConfidence, summarizeBasis, CONFIDENCE_POLICY } from './confidence.js';

// PUBLIC API. These vocabularies are part of the supported surface (see
// docs/api-reference.md) and are frozen so a consumer cannot mutate validation
// behaviour at a distance.
export const SCHEMA_VERSION = 3;
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2, 3]);

// A source class records WHAT WAS CLAIMED about a fact's origin. It is never proof
// and never by itself grants trust.
export const SOURCE_CLASSES = Object.freeze(['agent_claimed', 'tool_observed', 'human_confirmed', 'production_verified']);
// `verified` is deliberately UNREACHABLE from caller input; `expired` is owned by
// maintain(). See provenance-contract.md §2 and open question U-1.
export const VERIFICATION_STATUSES = Object.freeze(['unverified', 'verified', 'contradicted', 'expired']);

// `status` is an overloaded field name here. These values apply ONLY to decisions.
// Alternatives use `rejected`; facts use active/superseded/expired; review signals
// use open/acknowledged; outcomes use successful/mixed/failed/unknown.
export const DOCUMENTED_DECISION_STATUSES = Object.freeze([
  'proposed', 'planned', 'in_progress', 'executed', 'validated',
  'failed', 'reconsidered', 'superseded', 'abandoned'
]);
// Retained for backward compatibility. NOT rungs on the execution ladder:
//   active   — VALIDITY state, default for new decisions, load-bearing in context()
//   aging    — DERIVED by maintain() from reviewAfter + clock
//   stale    — caller-only, no producer in this codebase. DEPRECATED.
//   archived — caller-only, no producer. DEPRECATED, and NOT aliased to `abandoned`.
export const LEGACY_DECISION_STATUSES = Object.freeze(['active', 'aging', 'stale', 'archived']);
export const DECISION_STATUSES = Object.freeze([...DOCUMENTED_DECISION_STATUSES, ...LEGACY_DECISION_STATUSES]);

export const OUTCOME_STATUSES = Object.freeze(['successful', 'mixed', 'failed', 'unknown']);

// G7: the ONLY fields a free-text query may match. Schema/metadata keys are not
// content, so `search('confidence')` must not match a record that merely has a
// confidence field. See search-contract.md.
export const CONTENT_SEARCH_FIELDS = Object.freeze([
  'title', 'goal', 'chosen', 'assumption', 'evidence', 'alternative',
  'attempt solution', 'attempt result', 'attempt reason', 'environment'
]);
// Structured filters. Matching one of these NEVER counts as a content match.
export const SEARCH_FILTERS = Object.freeze(['project', 'status', 'minConfidence', 'sourceClass', 'kind']);

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 1000;

export { rebuildProjection, journalGaps, CONFIDENCE_POLICY };

function clone(value) { return JSON.parse(JSON.stringify(value)); }

// ---------------------------------------------------------------------------
// Pagination helpers (G6). Every multi-result read path goes through these, so
// there is exactly one place where "how much did we omit" is decided.
// ---------------------------------------------------------------------------
function resolvePage(options = {}, total) {
  const rawLimit = options.limit;
  if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT)) {
    throw new Error(`Page limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  const rawOffset = options.offset ?? 0;
  if (!Number.isInteger(rawOffset) || rawOffset < 0) throw new Error('Page offset must be a non-negative integer');
  const limit = rawLimit ?? Math.min(Math.max(total, 1), DEFAULT_PAGE_LIMIT);
  return { offset: rawOffset, limit, total, hasMore: rawOffset + limit < total, limitApplied: rawLimit !== undefined };
}

function paginate(items, options, scope, extra = {}) {
  const page = resolvePage(options, items.length);
  const slice = items.slice(page.offset, page.offset + page.limit);
  return {
    items: slice,
    page: { offset: page.offset, limit: page.limit, total: page.total, hasMore: page.hasMore },
    completeness: {
      scope,
      returned: slice.length,
      total: page.total,
      complete: slice.length === page.total,
      omitted: page.total - slice.length,
      losslessItems: true,
      limitSource: page.limitApplied ? 'caller' : 'default',
      ...extra
    }
  };
}

export function createShadowGraph(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const records = new Map();
  const facts = new Map();
  const currentFacts = new Map();
  const events = [];
  const journal = [];
  const relations = new Map();
  const reviewSignals = new Map();
  const idempotency = new Map();
  let revision = Number.isInteger(options.revision) ? options.revision : 0;
  let journalSeq = 0;
  let journalEpoch = null;
  function setRevision(value) { if (Number.isInteger(value) && value >= revision) revision = value; }

  function id(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // Legacy breadcrumb trail. Kept verbatim for backward compatibility; the journal
  // is the rebuildable record.
  function event(type, payload) {
    const data = clone(payload);
    let project = data.project;
    const refId = data.recordId ?? data.factId;
    if (!project && refId) project = entity(refId)?.project;
    if (!project && data.relationId) {
      const relation = relations.get(data.relationId);
      project = entity(relation?.from)?.project ?? entity(relation?.to)?.project;
    }
    events.push({ id: id('event'), type, at: now(), ...(project ? { project } : {}), ...data });
  }

  // G4: append a complete post-operation snapshot. `seq` is the ordering key —
  // `at` cannot be, because now() is injectable and millisecond ties are normal.
  function appendJournal(input) {
    if (!JOURNAL_ENTRY_TYPES.includes(input.type)) throw new Error(`Unknown journal entry type: ${input.type}`);
    journalSeq += 1;
    const entry = {
      id: id('jentry'),
      seq: journalSeq,
      type: input.type,
      at: now(),
      project: input.project ?? null,
      entityKind: input.entityKind ?? null,
      entityId: input.entityId ?? null,
      schemaVersion: SCHEMA_VERSION,
      payload: input.payload === undefined ? null : clone(input.payload),
      provenance: {
        actor: input.provenance?.actor ?? null,
        client: input.provenance?.client ?? null,
        sessionId: input.provenance?.sessionId ?? null
      },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.causationId ? { causationId: input.causationId } : {})
    };
    if (journalEpoch === null) journalEpoch = entry.seq;
    journal.push(entry);
    return entry;
  }

  function writeProvenance(record) {
    return { actor: record?.actor ?? null, client: record?.client ?? null, sessionId: record?.sessionId ?? null };
  }

  function importIdempotencyKey(key, value) {
    if (typeof key !== 'string') return key;
    const match = /^(decision|attempt|fact):([^:]+)$/.exec(key);
    return match && value?.project ? `${match[1]}:${value.project}:${match[2]}` : key;
  }

  function strings(value, name) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${name} must be an array of strings`);
    return [...value];
  }

  function idempotent(input, action) {
    if (!input?.idempotencyKey) return undefined;
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length > 200) throw new Error('idempotencyKey must be a string of at most 200 characters');
    const project = input.project ?? 'default';
    const existing = idempotency.get(`${action}:${project}:${input.idempotencyKey}`);
    if (existing) return clone(existing);
    // A legacy cache key may have been persisted without project scope. Only use it
    // when its payload belongs to the requested project; otherwise do not let an
    // old unscoped entry suppress a write in another project.
    const legacy = idempotency.get(`${action}:${input.idempotencyKey}`);
    if (legacy && (legacy.project ?? 'default') === project) return clone(legacy);
    return undefined;
  }
  function rememberIdempotency(input, action, value) { if (input?.idempotencyKey) idempotency.set(`${action}:${value.project ?? input.project ?? 'default'}:${input.idempotencyKey}`, clone(value)); }

  function addDecision(input) {
    const existing = idempotent(input, 'decision'); if (existing) return existing;
    if (!input || typeof input !== 'object' || typeof input.title !== 'string' || !input.title.trim() || typeof input.chosen !== 'string' || !input.chosen.trim()) throw new Error('A decision requires non-empty title and chosen strings');
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('Decision confidence must be a number between 0 and 1');
    const alternatives = input.alternatives ?? [];
    if (!Array.isArray(alternatives) || alternatives.some((item) => !item || typeof item.label !== 'string' || !item.label.trim())) throw new Error('Decision alternatives must have non-empty label strings');
    const evidence = (input.evidence ?? []).map((item) => normalizeEvidence(item, now));
    const record = {
      id: input.id ?? id('decision'), kind: 'decision', schemaVersion: SCHEMA_VERSION,
      project: input.project ?? 'default', title: input.title, goal: input.goal ?? '', chosen: input.chosen,
      // G2: provenance travels with the decision. Plain JSON values only.
      ...provenanceFields(input),
      // G8: confidence carries an auditable basis, not a bare number.
      confidence: createConfidence(confidence, evidence.length), status: 'active',
      assumptions: strings(input.assumptions, 'assumptions'), evidence,
      alternatives: alternatives.map((item) => ({ id: item.id ?? id('alternative'), label: item.label, reasonRejected: item.reasonRejected ?? item.reason ?? '', reopenWhen: normalizeRules(item.reopenWhen ?? []), status: 'rejected' })),
      failedAttempts: [...(input.failedAttempts ?? [])], outcome: input.outcome ?? null,
      reviewAfter: input.reviewAfter ?? null, createdAt: input.createdAt ?? now(), updatedAt: now()
    };
    records.set(record.id, record);
    event('decision.recorded', { recordId: record.id });
    appendJournal({ type: 'decision.recorded', entityKind: 'decision', entityId: record.id, project: record.project, payload: record, provenance: writeProvenance(record), idempotencyKey: input.idempotencyKey ? `decision:${record.project}:${input.idempotencyKey}` : undefined });
    const result = clone(record); rememberIdempotency(input, 'decision', result); return result;
  }

  function addAttempt(input) {
    const existing = idempotent(input, 'attempt'); if (existing) return existing;
    if (!input || typeof input !== 'object' || typeof input.solution !== 'string' || !input.solution.trim() || typeof input.result !== 'string' || !input.result.trim()) throw new Error('An attempt requires non-empty solution and result strings');
    const attempt = { id: input.id ?? id('attempt'), kind: 'attempt', schemaVersion: SCHEMA_VERSION, project: input.project ?? 'default', ...provenanceFields(input), solution: input.solution, result: input.result, environment: input.environment ?? '', reason: input.reason ?? '', reusableWhen: normalizeRules(input.reusableWhen ?? []), relatedTo: input.relatedTo ?? [], createdAt: input.createdAt ?? now() };
    records.set(attempt.id, attempt);
    event('attempt.recorded', { recordId: attempt.id });
    appendJournal({ type: 'attempt.recorded', entityKind: 'attempt', entityId: attempt.id, project: attempt.project, payload: attempt, provenance: writeProvenance(attempt), idempotencyKey: input.idempotencyKey ? `attempt:${attempt.project}:${input.idempotencyKey}` : undefined });
    const result = clone(attempt); rememberIdempotency(input, 'attempt', result); return result;
  }

  function addFact(input) {
    const existing = idempotent(input, 'fact'); if (existing) return existing;
    if (!input || typeof input.key !== 'string' || !input.key.trim()) throw new Error('A fact requires a non-empty key');
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('Fact confidence must be a number between 0 and 1');
    const factScope = JSON.stringify([input.project ?? 'default', input.key]);
    const previous = currentFacts.get(factScope);
    // G2: a source label is a CLAIM about origin, not a grant of trust. Unknown or
    // non-canonical labels downgrade to agent_claimed with the raw label kept for
    // audit. See provenance-contract.md §4.
    const provenance = provenanceFields(input);
    // G2: no caller input may produce `verified`. Every input — the source string,
    // any reference, this very field — arrives through the same untrusted path (the
    // agent's own tool call), so deriving trust from it would make `verified` mean
    // only "someone typed something". `contradicted` is allowed: it LOWERS trust.
    // `expired` is owned by maintain(). Contract §2; open question U-1.
    const requested = input.verificationStatus;
    if (requested !== undefined) {
      if (!VERIFICATION_STATUSES.includes(requested)) throw new Error('Invalid fact verificationStatus');
      if (requested === 'verified' || requested === 'expired') throw new Error(`A caller cannot set fact verificationStatus to ${requested}`);
    }
    const verificationStatus = requested === 'contradicted' ? 'contradicted' : 'unverified';
    const fact = { id: input.id ?? id('fact'), kind: 'fact', schemaVersion: SCHEMA_VERSION, project: input.project ?? 'default', key: input.key, value: input.value, source: provenance.sourceClass, ...provenance, confidence, verificationStatus, status: 'active', expiresAt: input.expiresAt ?? null, observedAt: input.observedAt ?? now() };
    if (previous) {
      previous.status = 'superseded';
      previous.supersededBy = fact.id;
      // The implicit supersession used to be silent. It is now an explicit entry.
      appendJournal({ type: 'fact.superseded', entityKind: 'fact', entityId: previous.id, project: previous.project, payload: clone(previous), provenance: writeProvenance(fact) });
    }
    facts.set(fact.id, fact); currentFacts.set(factScope, fact);
    event('fact.observed', { factId: fact.id, key: fact.key });
    appendJournal({ type: 'fact.observed', entityKind: 'fact', entityId: fact.id, project: fact.project, payload: fact, provenance: writeProvenance(fact), idempotencyKey: input.idempotencyKey ? `fact:${fact.project}:${input.idempotencyKey}` : undefined });
    const result = clone(fact); rememberIdempotency(input, 'fact', result); return result;
  }

  function entity(entityId) {
    if (records.has(entityId)) return records.get(entityId);
    if (facts.has(entityId)) return facts.get(entityId);
    for (const record of records.values()) {
      const alternative = record.kind === 'decision' && record.alternatives?.find((item) => item.id === entityId);
      if (alternative) return { ...alternative, kind: 'alternative', project: record.project, decisionId: record.id };
    }
    return undefined;
  }

  function link(input) {
    if (!input || typeof input.from !== 'string' || typeof input.to !== 'string' || typeof input.relation !== 'string' || !input.relation.trim()) throw new Error('A relationship requires from, to, and relation');
    const relation = { id: input.id ?? id('relation'), kind: 'relation', schemaVersion: SCHEMA_VERSION, from: input.from, to: input.to, relation: input.relation, createdAt: input.createdAt ?? now() };
    relations.set(relation.id, relation);
    event('relation.created', { relationId: relation.id });
    appendJournal({ type: 'relation.created', entityKind: 'relation', entityId: relation.id, project: entity(relation.from)?.project ?? entity(relation.to)?.project ?? null, payload: relation });
    return clone(relation);
  }

  function traverse(input = {}) {
    if (typeof input.id !== 'string' || !entity(input.id)) throw new Error('A traversal requires an existing id');
    const direction = input.direction ?? 'both';
    if (!['in', 'out', 'both'].includes(direction)) throw new Error('Traversal direction must be in, out, or both');
    const depth = input.depth ?? 1;
    if (!Number.isInteger(depth) || depth < 1 || depth > 10) throw new Error('Traversal depth must be an integer between 1 and 10');
    const seen = new Set([input.id]); const nodes = [clone(entity(input.id))]; const edges = []; let frontier = [input.id];
    for (let level = 0; level < depth && frontier.length; level += 1) {
      const next = [];
      for (const relation of relations.values()) {
        if (input.relation && relation.relation !== input.relation) continue;
        const fromMatch = direction !== 'in' && frontier.includes(relation.from);
        const toMatch = direction !== 'out' && frontier.includes(relation.to);
        if (!fromMatch && !toMatch) continue;
        const targetId = fromMatch ? relation.to : relation.from;
        if (!entity(targetId)) continue;
        if (!edges.some((item) => item.id === relation.id)) edges.push(clone(relation));
        if (!seen.has(targetId) && entity(targetId)) { seen.add(targetId); next.push(targetId); nodes.push(clone(entity(targetId))); }
      }
      frontier = next;
    }
    return { root: input.id, direction, depth, nodes, relations: edges };
  }

  function supersedeDecision(input = {}) {
    const previous = records.get(input.decisionId); const replacement = records.get(input.replacementId);
    if (!previous || previous.kind !== 'decision' || !replacement || replacement.kind !== 'decision') throw new Error('Supersession requires two existing decisions');
    if (previous.id === replacement.id) throw new Error('A decision cannot supersede itself');
    if (previous.project !== replacement.project) throw new Error('Superseding decisions must belong to the same project');
    if (previous.status === 'superseded' && previous.supersededBy === replacement.id) return { previous: clone(previous), replacement: clone(replacement), relation: [...relations.values()].find((item) => item.from === replacement.id && item.to === previous.id && item.relation === 'supersedes') ?? null };
    if (previous.status === 'superseded' || replacement.status === 'superseded') throw new Error('Supersession would create an invalid decision chain');
    previous.status = 'superseded'; previous.supersededBy = replacement.id; previous.updatedAt = now();
    replacement.supersedes = [...new Set([...(replacement.supersedes ?? []), previous.id])]; replacement.status = 'active'; replacement.updatedAt = now();
    const relation = link({ from: replacement.id, to: previous.id, relation: 'supersedes' });
    event('decision.superseded', { recordId: previous.id, replacementId: replacement.id });
    const cause = appendJournal({ type: 'decision.superseded', entityKind: 'decision', entityId: previous.id, project: previous.project, payload: clone(previous), provenance: writeProvenance(previous) });
    appendJournal({ type: 'decision.recorded', entityKind: 'decision', entityId: replacement.id, project: replacement.project, payload: clone(replacement), provenance: writeProvenance(replacement), causationId: cause.id });
    return { previous: clone(previous), replacement: clone(replacement), relation };
  }

  function updateDecisionStatus(decisionId, status) {
    const record = records.get(decisionId); if (!record || record.kind !== 'decision') throw new Error('Decision not found');
    // G3: accept FORMATTING aliases only (case, hyphen/underscore) and store the
    // canonical value, so search({status}) matches what was written. There are no
    // SEMANTIC aliases: `archived` is not `abandoned`, `active` is not `executed`.
    const canonical = normalizeDecisionStatus(status);
    if (!canonical) throw new Error(`Invalid decision status: ${status}`);
    const from = record.status;
    record.status = canonical; record.updatedAt = now();
    event('decision.status', { recordId: decisionId, status: canonical });
    appendJournal({ type: 'decision.status_changed', entityKind: 'decision', entityId: record.id, project: record.project, payload: clone(record), provenance: writeProvenance(record) });
    journal[journal.length - 1].transition = { from: from ?? null, to: canonical };
    return clone(record);
  }

  function setOutcome(decisionId, outcome) {
    const record = records.get(decisionId); if (!record || record.kind !== 'decision') throw new Error('Decision not found');
    if (!OUTCOME_STATUSES.includes(outcome?.status)) throw new Error('Outcome status must be successful, mixed, failed, or unknown');
    // G2/G8: an outcome's own provenance is a CLAIM. It weights the confidence move
    // but never sets a verification status anywhere.
    const outcomeProvenance = normalizeSourceClass(outcome.sourceClass ?? outcome.source);
    const observedAt = outcome.observedAt ?? now();
    record.outcome = { ...clone(outcome), sourceClass: outcomeProvenance.sourceClass, observedAt };
    record.updatedAt = now();
    event('decision.outcome', { recordId: decisionId, status: outcome.status });
    const cause = appendJournal({ type: 'outcome.recorded', entityKind: 'decision', entityId: record.id, project: record.project, payload: clone(record), provenance: writeProvenance(record) });
    // G8: deterministic, single-slot. A decision has ONE outcome, so it carries ONE
    // outcome contribution: re-recording REPLACES it rather than stacking a second.
    // The old key embedded observedAt, so the same outcome written twice in
    // different milliseconds double-counted. See setOutcomeContribution.
    const changed = setOutcomeContribution(record.confidence, {
      key: `outcome:${record.id}`,
      kind: 'outcome',
      outcomeStatus: outcome.status,
      direction: outcome.status === 'successful' ? 1 : outcome.status === 'failed' ? -1 : outcome.status === 'mixed' ? -0.5 : 0,
      sourceClass: outcomeProvenance.sourceClass,
      reason: `Outcome: ${outcome.status}`,
      provenance: writeProvenance(record),
      at: observedAt
    });
    if (changed) {
      appendJournal({ type: 'confidence.changed', entityKind: 'decision', entityId: record.id, project: record.project, payload: clone(record), provenance: writeProvenance(record), causationId: cause.id });
    }
    return clone(record);
  }

  // G8: record evidence for or against a decision without inventing an outcome.
  function addConfidenceEvidence(input = {}) {
    const record = records.get(input.decisionId);
    if (!record || record.kind !== 'decision') throw new Error('Decision not found');
    const direction = input.supports === false ? -1 : 1;
    const provenance = normalizeSourceClass(input.sourceClass ?? input.source);
    if (typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('Confidence evidence requires a non-empty reason');
    // P1-9: `key` is REQUIRED. The previous default embedded now() in the dedupe
    // key, so the same evidence submitted twice across a clock tick produced two
    // different keys and was counted twice — retry-idempotency that only held
    // inside a single millisecond. Rather than invent a stable key from content
    // (which would silently merge two genuinely distinct observations that happen
    // to share a reason), the caller must supply one. No stable key, no
    // idempotency claim.
    if (typeof input.key !== 'string' || !input.key.trim()) {
      throw new Error('Confidence evidence requires a stable `key` so a retry cannot double-count');
    }
    const at = input.observedAt ?? now();
    const key = input.key;
    // Legacy records may have a current value without a contribution basis. Use
    // that unexplained value as the explicit baseline for the first new policy
    // contribution; never silently reset it to the older initial value.
    if (record.confidence.migratedFromLegacyCurrent && !record.confidence.basis) {
      record.confidence.initial = record.confidence.current;
      record.confidence.migratedFromLegacyCurrent = false;
    }
    const changed = applyContribution(record.confidence, {
      key, kind: 'evidence', direction, sourceClass: provenance.sourceClass,
      reason: input.reason, provenance: writeProvenance(input), at
    });
    record.updatedAt = now();
    if (changed) {
      appendJournal({ type: 'confidence.changed', entityKind: 'decision', entityId: record.id, project: record.project, payload: clone(record), provenance: writeProvenance(input) });
    }
    return clone(record);
  }

  function ruleMatches(rule, value) {
    if (typeof rule === 'string') return value === true || value === rule;
    if (!rule || typeof rule !== 'object') return false;
    if (rule.operator === 'equals') return value === rule.value;
    if (rule.operator === 'not_equals') return value !== rule.value;
    if (rule.operator === 'contains') return Array.isArray(value) ? value.includes(rule.value) : String(value).includes(String(rule.value));
    if (rule.operator === 'greater_than') return Number(value) > Number(rule.value);
    if (rule.operator === 'less_than') return Number(value) < Number(rule.value);
    return false;
  }

  // G1: reconsideration must work from persisted state, not only from facts the
  // caller happens to re-supply. Projects one project's ACTIVE facts into the same
  // { key: value } shape review({ facts }) already accepts, so stored and supplied
  // facts share a single matching path. Project-scoped; superseded/expired skipped.
  function storedFactValues(project) {
    const values = {};
    for (const fact of currentFacts.values()) {
      if (fact.status !== 'active') continue;
      if ((fact.project ?? 'default') !== project) continue;
      values[fact.key] = fact.value;
    }
    return values;
  }

  function review(context = {}) {
    const changed = new Set(context.changedFacts ?? []); const due = [];
    for (const record of records.values()) {
      if (record.kind !== 'decision') continue;
      if (context.project && record.project !== context.project) continue;
      const matches = [];
      const reconsider = new Set();
      // Precedence: caller-supplied `facts` override stored facts of the same key,
      // preserving the pre-existing call-argument contract. String rules keep
      // matching `changedFacts` only: that list is an ephemeral "these just
      // changed" signal, whereas facts are durable state, so feeding state into it
      // would make every decision due forever.
      const knownFacts = { ...storedFactValues(record.project ?? 'default'), ...(context.facts ?? {}) };
      for (const alternative of record.alternatives) for (const rule of alternative.reopenWhen) {
        if (typeof rule === 'string' && changed.has(rule)) { matches.push(rule); reconsider.add(alternative.label); }
        else if (rule && Object.prototype.hasOwnProperty.call(knownFacts, rule.key) && ruleMatches(rule, knownFacts[rule.key])) { matches.push(rule.key); reconsider.add(alternative.label); }
      }
      if (record.reviewAfter && record.reviewAfter <= now()) matches.push('review date reached');
      if (record.outcome?.status === 'failed') matches.push('decision outcome failed');
      if (matches.length) due.push({ decisionId: record.id, title: record.title, reason: [...new Set(matches)].join(', '), alternativesToReconsider: reconsider.size ? [...reconsider] : record.alternatives.map((item) => item.label) });
    }
    for (const item of due) {
      const key = `${item.decisionId}:${item.reason}`;
      if (!reviewSignals.has(key)) reviewSignals.set(key, { id: id('review'), kind: 'review', ...clone(item), status: 'open', createdAt: now() });
    }
    return due;
  }

  function maintain(input = {}) {
    const at = input.now ?? now();
    const agedDecisionIds = [];
    for (const record of records.values()) if (record.kind === 'decision' && record.reviewAfter && record.reviewAfter <= at && ['active', 'validated'].includes(record.status)) {
      record.status = 'aging'; record.updatedAt = at; agedDecisionIds.push(record.id);
      appendJournal({ type: 'decision.aged', entityKind: 'decision', entityId: record.id, project: record.project, payload: clone(record) });
    }
    for (const fact of facts.values()) if (fact.status === 'active' && fact.expiresAt && fact.expiresAt <= at) {
      fact.status = 'expired'; fact.verificationStatus = 'expired';
      appendJournal({ type: 'fact.expired', entityKind: 'fact', entityId: fact.id, project: fact.project, payload: clone(fact) });
    }
    const due = review({ changedFacts: input.changedFacts ?? [], facts: input.facts ?? {} });
    return { at, agedDecisionIds, reviewSignals: [...reviewSignals.values()].map(clone), due };
  }

  function getReviewSignals(input = {}) { return [...reviewSignals.values()].filter((item) => (!input.project || records.get(item.decisionId)?.project === input.project) && (!input.status || item.status === input.status)).map(clone); }
  function acknowledgeReview(signalId) { const item = [...reviewSignals.values()].find((candidate) => candidate.id === signalId); if (!item) throw new Error('Review signal not found'); item.status = 'acknowledged'; item.acknowledgedAt = now(); return clone(item); }

  function redact(input = {}) {
    const project = input.project;
    const patterns = (input.patterns ?? ['password', 'secret', 'token', 'api[-_]?key', 'authorization', 'private[-_]?key']).map((item) => new RegExp(String(item), 'i'));
    const replacement = input.replacement ?? '[REDACTED]';
    const transform = (value, key = '') => {
      if (patterns.some((pattern) => pattern.test(key))) return replacement;
      if (typeof value === 'string') return value.replace(/(Bearer\s+)[^\s]+/gi, `$1${replacement}`).replace(/(https?:\/\/[^\s]*)(token|secret|key)[^\s]*/gi, replacement);
      if (Array.isArray(value)) return value.map((item) => transform(item, key));
      if (value && typeof value === 'object') {
        const sensitiveValue = patterns.some((pattern) => pattern.test(String(value.key ?? '')));
        return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, childKey === 'value' && sensitiveValue ? replacement : transform(item, childKey)]));
      }
      return value;
    };
    const data = exportData();
    if (project) {
      data.records = data.records.filter((item) => item.project === project);
      data.facts = data.facts.filter((item) => item.project === project);
      const ids = new Set([...data.records, ...data.facts].map((item) => item.id));
      data.relations = data.relations.filter((item) => ids.has(item.from) && ids.has(item.to));
      data.events = data.events.filter((item) => item.project === project && (!item.relationId || data.relations.some((relation) => relation.id === item.relationId)));
      data.journal = data.journal.filter((item) => item.project === project);
    }
    // B-4: the journal payload is redacted like every other surface. A secret must
    // not survive in the audit trail just because it was also written there.
    return transform(data);
  }

  function projectSummary(project) {
    if (typeof project !== 'string' || !project.trim()) throw new Error('A project name is required');
    const recordsForProject = [...records.values()].filter((item) => item.project === project);
    const ids = new Set(recordsForProject.map((item) => item.id));
    for (const record of recordsForProject) for (const alternative of record.alternatives ?? []) ids.add(alternative.id);
    for (const fact of facts.values()) if (fact.project === project) ids.add(fact.id);
    return { project, records: recordsForProject.length, facts: [...facts.values()].filter((item) => item.project === project).length, relations: [...relations.values()].filter((item) => ids.has(item.from) || ids.has(item.to)).length, events: events.filter((item) => item.project === project || ids.has(item.recordId) || ids.has(item.factId)).length, journal: journal.filter((item) => item.project === project).length };
  }

  // G5: `mode` defaults to a LOGICAL purge. Content is removed and an auditable
  // skeleton remains, so a rebuild does not resurrect purged data and the history
  // that a purge happened survives. `hard` physically removes journal entries,
  // which creates a seq gap — declared by validate(), never hidden. This is why
  // the journal is documented as append-ORIENTED, never append-only.
  function purgeProject(project, purgeOptions = {}) {
    const mode = purgeOptions.mode ?? (purgeOptions.hard === true ? 'hard' : 'logical');
    if (!['logical', 'hard'].includes(mode)) throw new Error('Purge mode must be logical or hard');
    const summary = projectSummary(project);
    const projectRecords = [...records.values()].filter((item) => item.project === project);
    const removed = new Set(projectRecords.map((item) => item.id));
    for (const record of projectRecords) for (const alternative of record.alternatives ?? []) removed.add(alternative.id);
    for (const fact of facts.values()) if (fact.project === project) removed.add(fact.id);
    for (const [recordId, record] of records) if (record.project === project) records.delete(recordId);
    for (const [factId, fact] of facts) if (fact.project === project) facts.delete(factId);
    const removedRelationIds = new Set();
    for (const [relationId, relation] of relations) {
      if (removed.has(relation.from) || removed.has(relation.to)) {
        removedRelationIds.add(relationId);
        relations.delete(relationId);
      }
    }
    for (const [key, fact] of currentFacts) if (removed.has(fact.id)) currentFacts.delete(key);
    for (const [key, signal] of reviewSignals) if (removed.has(signal.decisionId)) reviewSignals.delete(key);
    // P0-1: the idempotency cache holds CLONED PAYLOADS of the entities it
    // replayed. Leaving them behind means a retry with an old key returns a
    // deleted decision verbatim — the purged content survives in memory, in
    // exportData(), and in any rebuild. That defeats both purge modes, so the
    // cache is cleaned for logical AND hard purge alike.
    let idempotencyRemoved = 0;
    for (const [key, value] of idempotency) {
      if (value?.project === project || removed.has(value?.id)) { idempotency.delete(key); idempotencyRemoved += 1; }
    }
    for (let index = events.length - 1; index >= 0; index -= 1) { const item = events[index]; if (item.project === project || removed.has(item.recordId) || removed.has(item.factId) || (item.relationId && !relations.has(item.relationId))) events.splice(index, 1); }

    let journalEntriesRedacted = 0;
    let journalEntriesRemoved = 0;
    if (mode === 'hard') {
      for (let index = journal.length - 1; index >= 0; index -= 1) {
        const item = journal[index];
        if (item.project === project || removed.has(item.entityId) || removedRelationIds.has(item.entityId)) { journal.splice(index, 1); journalEntriesRemoved += 1; }
      }
    } else {
      for (const item of journal) {
        if (item.project === project || removed.has(item.entityId) || removedRelationIds.has(item.entityId)) {
          if (item.payload !== null || item.redacted !== true) journalEntriesRedacted += 1;
          item.payload = null; item.redacted = true; item.redactedReason = 'project_purged';
        } else if (item.type === 'projection.baseline' && item.payload) {
          const payload = item.payload;
          const keep = (value) => value?.project !== project && !removed.has(value?.id);
          payload.records = (payload.records ?? []).filter(keep);
          payload.facts = (payload.facts ?? []).filter(keep);
          payload.relations = (payload.relations ?? []).filter((relation) => !removedRelationIds.has(relation?.id) && !removed.has(relation?.from) && !removed.has(relation?.to));
          payload.idempotency = (payload.idempotency ?? []).filter((entry) => keep(entry?.value));
        }
      }
    }
    // Migration baselines contain snapshots for multiple projects and have no
    // project/entity selector. Rewrite them for both purge modes so erased
    // payloads cannot survive inside the shared baseline.
    for (const item of journal) if (item.type === 'projection.baseline' && item.payload && item.redacted !== true) {
      const payload = item.payload;
      const keep = (value) => value?.project !== project && !removed.has(value?.id);
      payload.records = (payload.records ?? []).filter(keep);
      payload.facts = (payload.facts ?? []).filter(keep);
      payload.relations = (payload.relations ?? []).filter((relation) => !removedRelationIds.has(relation?.id) && !removed.has(relation?.from) && !removed.has(relation?.to));
      payload.idempotency = (payload.idempotency ?? []).filter((entry) => keep(entry?.value));
    }
    const purgeEntry = appendJournal({ type: 'project.purged', entityKind: 'project', entityId: project, project, payload: { project, mode, removed: removed.size, purgedEntityIds: [...removed] } });
    return { ...summary, removed: removed.size, mode, journalEntriesRedacted, journalEntriesRemoved, idempotencyRemoved, journalEntryId: purgeEntry.id };
  }

  // Diagnostics distinguish three different problems (see api-reference.md):
  //   error       — genuinely invalid data that code produced wrongly
  //   legacy      — older data that is readable but pre-dates a contract
  //   unsupported — data from a newer/unknown schema this build cannot interpret
  function validate() {
    const issues = [];
    const push = (severity, code, extra) => issues.push({ code, severity, ...extra });
    for (const relation of relations.values()) {
      if (!entity(relation.from)) push('error', 'missing_relation_source', { relationId: relation.id, entityId: relation.from });
      if (!entity(relation.to)) push('error', 'missing_relation_target', { relationId: relation.id, entityId: relation.to });
    }
    for (const record of records.values()) if (record.kind === 'decision') {
      if (record.supersededBy === record.id) push('error', 'self_supersession', { recordId: record.id });
      const current = record.confidence?.current;
      if (!Number.isFinite(current) || current < 0 || current > 1) push('error', 'invalid_confidence', { recordId: record.id });
      if (record.status === undefined || record.status === null) push('legacy', 'legacy_missing_decision_status', { recordId: record.id, status: null });
      else if (!DECISION_STATUSES.includes(record.status)) push('error', 'unknown_decision_status', { recordId: record.id, status: record.status });
      if (record.confidence && !record.confidence.basis) push('legacy', 'legacy_confidence_without_basis', { recordId: record.id });
      if (record.confidence?.policy && record.confidence.policy !== CONFIDENCE_POLICY) push('unsupported', 'unsupported_confidence_policy', { recordId: record.id, policy: record.confidence.policy });
      if (record.confidence?.basis?.policy && record.confidence.basis.policy !== record.confidence.policy) push('error', 'confidence_policy_mismatch', { recordId: record.id, policy: record.confidence.policy, basisPolicy: record.confidence.basis.policy });
    }
    for (const fact of facts.values()) {
      if (!SOURCE_CLASSES.includes(fact.sourceClass)) push('legacy', 'legacy_fact_source_class', { recordId: fact.id, sourceClass: fact.sourceClass ?? null });
      if (!VERIFICATION_STATUSES.includes(fact.verificationStatus)) push('error', 'unknown_verification_status', { recordId: fact.id, verificationStatus: fact.verificationStatus ?? null });
    }
    for (const entry of journal) {
      if (!JOURNAL_ENTRY_TYPES.includes(entry.type)) push('unsupported', 'unsupported_journal_entry', { entryId: entry.id, seq: entry.seq ?? null, type: entry.type ?? null });
      else if (Number.isInteger(entry.schemaVersion) && entry.schemaVersion > SCHEMA_VERSION) push('unsupported', 'unsupported_journal_schema_version', { entryId: entry.id, seq: entry.seq, schemaVersion: entry.schemaVersion });
      else if (!Number.isInteger(entry.seq)) push('error', 'journal_entry_without_sequence', { entryId: entry.id ?? null, type: entry.type ?? null });
    }
    // P2-12: a repeated `seq` cannot be totally ordered, so the fold's outcome
    // would depend on file order. That is an error, not an advisory.
    for (const duplicate of duplicateSequences(journal)) push('error', 'duplicate_journal_sequence', duplicate);
    // P2-14: live records/facts written by a NEWER build. They are preserved
    // verbatim (never downgraded) and reported so a caller knows this build
    // cannot fully interpret them.
    for (const record of records.values()) {
      if (Number.isInteger(record.schemaVersion) && record.schemaVersion > SCHEMA_VERSION) push('unsupported', 'unsupported_record_schema_version', { recordId: record.id, schemaVersion: record.schemaVersion });
    }
    for (const fact of facts.values()) {
      if (Number.isInteger(fact.schemaVersion) && fact.schemaVersion > SCHEMA_VERSION) push('unsupported', 'unsupported_fact_schema_version', { recordId: fact.id, schemaVersion: fact.schemaVersion });
    }
    // P2-15: the invariant is ONE active fact per (project, key). More than one is
    // corrupt data: import applies a deterministic recency rule so behaviour is
    // stable, but the ambiguity is still declared rather than hidden.
    const activeScopes = new Map();
    for (const fact of facts.values()) {
      if (fact.status !== 'active') continue;
      const scope = `${fact.project ?? 'default'}::${fact.key}`;
      activeScopes.set(scope, (activeScopes.get(scope) ?? 0) + 1);
    }
    for (const [scope, count] of activeScopes) if (count > 1) push('error', 'duplicate_active_fact_scope', { scope, count });
    for (const gap of journalGaps(journal)) push('info', 'journal_gap', gap);
    // `valid` is false for genuine errors AND for data this build cannot
    // interpret. Saying "valid" while holding an unsupported schema would be a
    // claim we cannot support. `legacy` and `info` do NOT invalidate: readable
    // older data is not broken data.
    const severityCount = (name) => issues.filter((issue) => issue.severity === name).length;
    return {
      valid: !issues.some((issue) => issue.severity === 'error' || issue.severity === 'unsupported'),
      issues,
      counts: { error: severityCount('error'), legacy: severityCount('legacy'), unsupported: severityCount('unsupported'), info: severityCount('info') }
    };
  }

  function repairPlan() { return { apply: false, actions: validate().issues.map((issue) => issue.code.startsWith('missing_relation_') ? { action: 'remove_relation', relationId: issue.relationId, reason: issue.code } : { action: 'manual_review', ...issue }) }; }

  // ---- G6 / G7 read paths -------------------------------------------------
  function matchesFilters(record, options) {
    if (options.project && record.project !== options.project) return false;
    if (options.status && record.status !== options.status) return false;
    if (options.kind && record.kind !== options.kind) return false;
    if (options.sourceClass && record.sourceClass !== options.sourceClass) return false;
    if (options.minConfidence !== undefined && (record.confidence?.current ?? 0) < options.minConfidence) return false;
    return true;
  }

  function appliedFilters(options) {
    return Object.fromEntries(SEARCH_FILTERS.filter((name) => options[name] !== undefined).map((name) => [name, options[name]]));
  }

  function rank(query = '', options = {}) {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];
    for (const record of records.values()) {
      if (!matchesFilters(record, options)) continue;
      // G7: a term must match a DECLARED CONTENT FIELD. Schema keys and internal
      // metadata are not content, so `search('confidence')` no longer matches a
      // record merely because it has a confidence field.
      const perTerm = terms.map((term) => matchFields(record, term));
      if (terms.length && perTerm.some((fields) => fields.length === 0)) continue;
      const matched = [...new Set(perTerm.flat())];
      hits.push({
        record: clone(record),
        score: terms.length ? score(record, terms) : 0,
        matched,
        reason: terms.length ? `Matched ${matched.join(', ')}` : 'Matched filters only',
        matchedBy: terms.length ? 'content' : 'filter',
        filters: appliedFilters(options)
      });
    }
    return hits.sort((a, b) => b.score - a.score || String(a.record.id).localeCompare(String(b.record.id)));
  }

  function search(query = '', options = {}) {
    const hits = rank(query, options);
    return paginate(hits, options, { project: options.project ?? 'all', query: String(query), filters: appliedFilters(options) }, { contentFields: [...CONTENT_SEARCH_FIELDS] });
  }

  function retrieve(query = '', options = {}) {
    const hits = rank(query, options);
    const directIds = new Set(hits.map((item) => item.record.id));
    const results = hits.map((item) => ({ ...item, graphBoost: 0, reasons: [item.reason] }));
    for (const relation of relations.values()) {
      const relatedId = directIds.has(relation.from) ? relation.to : directIds.has(relation.to) ? relation.from : null;
      const related = relatedId && entity(relatedId);
      if (related && related.kind !== 'alternative' && (!options.project || related.project === options.project) && !directIds.has(relatedId)) {
        results.push({ record: clone(related), score: 1, graphBoost: 1, matched: ['relationship'], matchedBy: 'graph', reason: `Related by ${relation.relation}`, reasons: [`Related by ${relation.relation}`], filters: appliedFilters(options) });
        directIds.add(relatedId);
      }
    }
    const sorted = results.sort((a, b) => b.score - a.score || String(a.record.id).localeCompare(String(b.record.id)));
    return paginate(sorted, options, { project: options.project ?? 'all', query: String(query), filters: appliedFilters(options) }, { includesGraphNeighbours: true, contentFields: [...CONTENT_SEARCH_FIELDS] });
  }

  // context() returns several collections. Each one declares its own total and
  // whether it was truncated, so a caller can never be silently short-changed.
  function context(input = {}) {
    const project = input.project ?? 'default';
    const limit = input.limit;
    const collect = (items) => {
      const page = resolvePage({ limit, offset: 0 }, items.length);
      return { items: items.slice(0, page.limit), total: items.length, returned: Math.min(page.limit, items.length), hasMore: page.limit < items.length };
    };
    const activeDecisions = collect([...records.values()].filter((x) => x.kind === 'decision' && x.project === project && x.status === 'active').map(clone));
    const staleAssumptions = collect([...facts.values()].filter((x) => x.project === project && x.status !== 'active').map(clone));
    const failedAttemptsToAvoid = collect([...records.values()].filter((x) => x.kind === 'attempt' && x.project === project && /fail|regression|error/i.test(x.result)).map(clone));
    const openReviews = collect(review({ project, changedFacts: input.changedFacts ?? [], facts: input.facts ?? {} }));
    const suggestedQuestions = collect([...records.values()].filter((x) => x.kind === 'decision' && x.project === project && (x.confidence?.current ?? 0) < 0.5).map((x) => `What evidence could change the decision: ${x.title}?`));
    const groups = { activeDecisions, staleAssumptions, failedAttemptsToAvoid, openReviews, suggestedQuestions };
    return {
      project,
      activeDecisions: activeDecisions.items,
      staleAssumptions: staleAssumptions.items,
      failedAttemptsToAvoid: failedAttemptsToAvoid.items,
      openReviews: openReviews.items,
      suggestedQuestions: suggestedQuestions.items,
      completeness: {
        scope: { project },
        complete: Object.values(groups).every((group) => !group.hasMore),
        limitSource: limit === undefined ? 'default' : 'caller',
        losslessItems: true,
        collections: Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { returned: group.returned, total: group.total, hasMore: group.hasMore, omitted: group.total - group.returned }]))
      }
    };
  }

  function exportData() {
    return {
      schemaVersion: SCHEMA_VERSION, revision,
      records: [...records.values()].map(clone), facts: [...facts.values()].map(clone),
      relations: [...relations.values()].map(clone), reviewSignals: [...reviewSignals.values()].map(clone),
      idempotency: [...idempotency.entries()].map(([key, value]) => ({ key, value: clone(value) })),
      events: clone(events), journal: clone(journal), journalSeq, journalEpoch
    };
  }

  // P0-2: ATOMIC. The previous implementation cleared every map and THEN parsed
  // the incoming data, so a malformed payload — or a throw anywhere in migration —
  // destroyed the live graph and left nothing to fall back to. That is the worst
  // possible failure mode for a recovery path (`restore`, revision-conflict
  // reload), because the operation that runs when something is already wrong was
  // itself capable of losing everything.
  //
  // Now the data is built into an INDEPENDENT staging graph and checked first.
  // Nothing in this graph is touched until the staged result is known good, so a
  // failed replace leaves the current state exactly as it was.
  function replaceData(data = []) {
    const staging = createShadowGraph({ now });
    // Any parse/migration failure throws HERE, before a single live map is cleared.
    staging.importData(data);
    const check = staging.validate();
    const blocking = check.issues.filter((issue) => issue.severity === 'error');
    if (blocking.length) {
      const error = new Error(`Refusing to replace data: ${blocking.length} blocking issue(s) — ${[...new Set(blocking.map((issue) => issue.code))].join(', ')}`);
      error.issues = blocking;
      throw error;
    }
    // The staged snapshot is already migrated and validated, so this import cannot
    // fail. Only now is the live state discarded.
    const staged = staging.exportData();
    records.clear(); facts.clear(); currentFacts.clear(); relations.clear(); reviewSignals.clear(); idempotency.clear();
    events.length = 0; journal.length = 0; revision = 0; journalSeq = 0; journalEpoch = null;
    return importData(staged);
  }

  function importData(data = []) {
    const source = Array.isArray(data) ? { records: data } : data;
    if (source === null || typeof source !== 'object') throw new Error('Import data must be an object or an array of records');
    // P0-2 / P2-14: the ENVELOPE schemaVersion describes the shape of the whole
    // payload, so a version this build does not know is not something to downgrade
    // silently or half-read — the fields we would ignore might be the ones that
    // change the meaning of the fields we do read. Refuse it.
    //
    // This throw is also what makes replaceData() atomic: it fires inside the
    // staging graph, before a single live map has been cleared.
    //
    // Note the asymmetry with individual records/facts, which are PRESERVED
    // verbatim at their own future version and reported by validate(). A future
    // envelope means "this file is unreadable"; a future record means "one entity
    // came from a newer build" and losing it would be worse than keeping it.
    if (Number.isInteger(source.schemaVersion) && !SUPPORTED_SCHEMA_VERSIONS.includes(source.schemaVersion)) {
      const error = new Error(`Unsupported data schemaVersion ${source.schemaVersion}: this build supports ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`);
      error.code = 'unsupported_schema_version';
      error.schemaVersion = source.schemaVersion;
      throw error;
    }
    validateImportShape(source);
    // Preflight every migration and clone before changing any live collection.
    // Direct import is intentionally merge-oriented, but a malformed entity must
    // never leave a partially merged graph behind.
    const importedRecords = (source.records ?? []).map((item) => migrateRecord(item));
    const importedFacts = (source.facts ?? []).map((fact) => {
      const factId = fact.id ?? id('fact');
      return migrateFact({ ...fact, id: factId });
    });
    const importedRelations = (source.relations ?? []).map((relation) => clone(relation));
    const importedSignals = (source.reviewSignals ?? []).map((signal) => clone(signal));
    const importedIdempotency = (source.idempotency ?? []).map((item) => ({ key: importIdempotencyKey(item.key, item.value), value: clone(item.value) }));
    const importedEvents = (source.events ?? []).map((item) => clone(item));
    const importedJournal = Array.isArray(source.journal) ? source.journal.map((item) => clone(item)) : [];
    revision = Number.isInteger(source.revision) ? source.revision : revision;
    for (const item of importedRecords) records.set(item.id, item);
    for (const fact of importedFacts) facts.set(fact.id, fact);
    // P2-15: two ACTIVE facts can share a (project, key) scope in imported data.
    // Picking whichever arrived last made the winner depend on array order, so the
    // same file reordered produced a different current fact — and therefore
    // different reconsideration results. Recency is now a stable rule:
    // latest `observedAt`, and `id` as the tie-break so it is total. Ambiguity is
    // still reported by validate() rather than hidden.
    const scopeCandidates = new Map();
    for (const fact of facts.values()) {
      if (fact.status !== 'active') continue;
      const scope = JSON.stringify([fact.project ?? 'default', fact.key]);
      if (!scopeCandidates.has(scope)) scopeCandidates.set(scope, []);
      scopeCandidates.get(scope).push(fact);
    }
    for (const [scope, candidates] of scopeCandidates) {
      const winner = [...candidates].sort((left, right) => {
        const byObserved = String(right.observedAt ?? '').localeCompare(String(left.observedAt ?? ''));
        return byObserved !== 0 ? byObserved : String(right.id ?? '').localeCompare(String(left.id ?? ''));
      })[0];
      currentFacts.set(scope, winner);
    }
    for (const relation of importedRelations) relations.set(relation.id, relation);
    for (const signal of importedSignals) reviewSignals.set(`${signal.decisionId}:${signal.reason}`, signal);
    for (const item of importedIdempotency) idempotency.set(item.key, item.value);
    events.push(...importedEvents);

    if (importedJournal.length) {
      journal.push(...importedJournal);
      const numbered = journal.filter((item) => Number.isInteger(item.seq)).map((item) => item.seq);
      journalSeq = Math.max(Number.isInteger(source.journalSeq) ? source.journalSeq : 0, numbered.length ? Math.max(...numbered) : 0);
      // P2-11: Math.min(...[]) is Infinity. A journal whose entries carry no `seq`
      // at all must not silently produce an Infinity epoch that then excludes
      // every entry from the replay range while still reporting success.
      // journalEpoch stays null; rebuild derives its own start and reports the
      // unnumbered entries as non-replayable legacy.
      journalEpoch = Number.isInteger(source.journalEpoch) ? source.journalEpoch : (numbered.length ? Math.min(...numbered) : null);
    } else {
      // Preserve a declared high-water mark even when the journal was compacted
      // or intentionally exported empty. Otherwise the next append can reuse a
      // sequence number that was already issued before the empty snapshot.
      if (Number.isInteger(source.journalSeq)) journalSeq = Math.max(journalSeq, source.journalSeq);
      if (Number.isInteger(source.journalEpoch)) journalEpoch = source.journalEpoch;
    }
    if (!(Array.isArray(source.journal) && source.journal.length) && (records.size || facts.size || relations.size)) {
      // G4-E migration boundary. Pre-journal data has metadata-only events with no
      // payload, so it CANNOT be replayed. Rather than fabricate history, keep the
      // old events as explicitly non-replayable and start rebuildability at an
      // honestly-labelled baseline snapshot of the state we actually loaded.
      for (const legacyEvent of events) {
        journalSeq += 1;
        journal.push({ id: legacyEvent.id, seq: journalSeq, type: 'legacy_metadata_event', at: legacyEvent.at ?? null, project: legacyEvent.project ?? null, entityKind: null, entityId: legacyEvent.recordId ?? legacyEvent.factId ?? null, schemaVersion: 2, payload: null, replayable: false, originalType: legacyEvent.type, provenance: { actor: null, client: null, sessionId: null } });
      }
      journalSeq += 1;
      journalEpoch = journalSeq;
      journal.push({
        id: id('jentry'), seq: journalSeq, type: 'projection.baseline', at: now(),
        project: null, entityKind: null, entityId: null, schemaVersion: SCHEMA_VERSION,
        derivedFrom: 'live_state_at_migration',
        payload: {
          records: [...records.values()].map(clone), facts: [...facts.values()].map(clone),
          relations: [...relations.values()].map(clone),
          idempotency: [...idempotency.entries()].map(([key, value]) => ({ key, value: clone(value) }))
        },
        provenance: { actor: null, client: null, sessionId: null }
      });
    }
    return records.size + facts.size + relations.size;
  }

  function getJournal(options = {}) {
    const entries = journal.filter((entry) => !options.project || entry.project === options.project);
    return paginate(entries.map(clone), options, { project: options.project ?? 'all' }, { journalEpoch, journalSeq, gaps: journalGaps(journal) });
  }

  // Rebuild a projection from this graph's own journal and report honestly whether
  // it could be done completely.
  function rebuild(options = {}) {
    return rebuildProjection(clone(journal), { journalEpoch, ...options });
  }

  function stats() {
    const all = [...records.values()];
    return { schemaVersion: SCHEMA_VERSION, total: all.length, decisions: all.filter((x) => x.kind === 'decision').length, attempts: all.filter((x) => x.kind === 'attempt').length, facts: facts.size, relations: relations.size, reviewSignals: reviewSignals.size, events: events.length, journal: journal.length };
  }

  return {
    setRevision, replaceData, addDecision, addAttempt, addFact, setOutcome, addConfidenceEvidence,
    updateDecisionStatus, supersedeDecision, link, traverse, redact, projectSummary, purgeProject,
    review, maintain, getReviewSignals, acknowledgeReview, search, retrieve, validate, repairPlan,
    context, exportData, importData, getJournal, rebuild, stats
  };
}

function normalizeRules(rules) { return rules.map((rule) => typeof rule === 'string' ? rule : { key: rule.key, operator: rule.operator ?? 'equals', value: rule.value }); }

// G3: resolve a caller-supplied decision status to its canonical form, or undefined
// if unrecognised. Only FORMATTING variance is absorbed (whitespace, case,
// hyphen-vs-underscore) because MCP clients commonly send `in-progress`. Meaning is
// never remapped.
function normalizeDecisionStatus(raw) {
  if (typeof raw !== 'string') return undefined;
  const candidate = raw.trim().toLowerCase().replaceAll('-', '_');
  return DECISION_STATUSES.includes(candidate) ? candidate : undefined;
}

// G2: map a claimed source label onto an official class. Unknown or non-canonical
// labels downgrade to `agent_claimed` rather than being rejected, because a label is
// a description of origin and discarding a real fact over a labelling problem loses
// data. The raw label is preserved for audit whenever it differs from the resolved
// class (security doc: "preserve the original source label for audit").
function normalizeSourceClass(raw) {
  if (raw == null) return { sourceClass: 'agent_claimed' };
  const label = String(raw);
  const candidate = label.trim().toLowerCase().replaceAll('-', '_');
  const sourceClass = SOURCE_CLASSES.includes(candidate) ? candidate : 'agent_claimed';
  return sourceClass === label ? { sourceClass } : { sourceClass, sourceRaw: label };
}

function provenanceString(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string when provided`);
  return value;
}

// G2: plain JSON provenance only — no live objects, so everything survives
// exportData() -> importData() unchanged.
function provenanceFields(input) {
  return {
    ...normalizeSourceClass(input.sourceClass ?? input.source),
    actor: provenanceString(input.actor, 'actor'),
    client: provenanceString(input.client, 'client'),
    sessionId: provenanceString(input.sessionId, 'sessionId')
  };
}

function normalizeEvidence(item, clock = () => new Date().toISOString()) {
  const base = typeof item === 'string' ? { source: item } : (item ?? {});
  const { sourceClass, sourceRaw } = normalizeSourceClass(base.sourceClass ?? base.type ?? base.source);
  return {
    source: base.source ?? 'unknown', type: base.type ?? 'unknown',
    sourceClass, ...(sourceRaw ? { sourceRaw } : {}),
    confidence: base.confidence ?? 0.5, observedAt: base.observedAt ?? clock(), detail: base.detail ?? ''
  };
}

function validateImportShape(source) {
  const array = (name) => {
    if (source[name] !== undefined && !Array.isArray(source[name])) throw new Error(`${name} must be an array`);
    return source[name] ?? [];
  };
  for (const [index, item] of array('records').entries()) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !['decision', 'attempt'].includes(item.kind)) throw new Error(`records[${index}] is malformed`);
    if (item.kind === 'decision') {
      if (typeof item.title !== 'string' || typeof item.chosen !== 'string') throw new Error(`records[${index}] decision requires title and chosen strings`);
      if (item.alternatives !== undefined && !Array.isArray(item.alternatives)) throw new Error(`records[${index}].alternatives must be an array`);
      for (const [alternativeIndex, alternative] of (item.alternatives ?? []).entries()) {
        if (!alternative || typeof alternative !== 'object' || typeof alternative.label !== 'string') throw new Error(`records[${index}].alternatives[${alternativeIndex}] is malformed`);
        if (alternative.reopenWhen !== undefined && !Array.isArray(alternative.reopenWhen)) throw new Error(`records[${index}].alternatives[${alternativeIndex}].reopenWhen must be an array`);
      }
    }
  }
  for (const [index, fact] of array('facts').entries()) if (!fact || typeof fact !== 'object' || (fact.id !== undefined && typeof fact.id !== 'string') || typeof fact.key !== 'string' || (fact.kind !== undefined && fact.kind !== 'fact')) throw new Error(`facts[${index}] is malformed`);
  for (const [index, relation] of array('relations').entries()) if (!relation || typeof relation !== 'object' || typeof relation.id !== 'string' || typeof relation.from !== 'string' || typeof relation.to !== 'string' || typeof relation.relation !== 'string') throw new Error(`relations[${index}] is malformed`);
  for (const [index, entry] of array('journal').entries()) if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`journal[${index}] is malformed`);
  for (const [index, signal] of array('reviewSignals').entries()) if (!signal || typeof signal !== 'object' || Array.isArray(signal) || typeof signal.id !== 'string' || typeof signal.decisionId !== 'string' || typeof signal.reason !== 'string') throw new Error(`reviewSignals[${index}] is malformed`);
  for (const [index, item] of array('idempotency').entries()) if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.key !== 'string' || !item.key || !item.value || typeof item.value !== 'object' || Array.isArray(item.value)) throw new Error(`idempotency[${index}] is malformed`);
  for (const [index, eventItem] of array('events').entries()) if (!eventItem || typeof eventItem !== 'object' || Array.isArray(eventItem) || typeof eventItem.id !== 'string' || typeof eventItem.type !== 'string') throw new Error(`events[${index}] is malformed`);
}

function migrateRecord(item) {
  if (item.kind !== 'decision') return { schemaVersion: SCHEMA_VERSION, project: 'default', ...clone(item) };
  const source = clone(item);
  const numeric = typeof source.confidence === 'number' ? source.confidence : source.confidence?.current ?? 0.5;
  const initial = typeof source.confidence === 'object' ? source.confidence.initial ?? numeric : numeric;
  const history = source.confidence?.history ?? [];
  // G8: legacy confidence had no basis. Reconstruct one from what is present
  // WITHOUT inventing contributions — an unbasis'd history yields an empty
  // contribution list, and validate() reports it as legacy rather than pretending.
  const contributions = (source.confidence?.basis?.contributions ?? []).map((entry) => ({ ...entry }));
  const policy = source.confidence?.policy ?? source.confidence?.basis?.policy ?? CONFIDENCE_POLICY;
  const hasBasis = Boolean(source.confidence?.basis);
  const confidence = policy === CONFIDENCE_POLICY ? (hasBasis ? {
    initial, current: contributions.length ? computeConfidence(initial, contributions) : numeric,
    basis: summarizeBasis(contributions, { declaredEvidence: (source.evidence ?? []).length }),
    history, policy
  } : {
    initial, current: numeric, history, policy,
    migratedFromLegacyCurrent: true
  }) : { ...clone(source.confidence), initial, current: numeric, policy, ...(source.confidence?.basis ? { basis: clone(source.confidence.basis) } : {}) };
  if (!source.confidence?.basis) delete confidence.basis;
  return {
    // P2-14: never silently DOWNGRADE a record written by a newer build. Claiming
    // schemaVersion 3 for data we cannot interpret would erase the only evidence
    // that this build does not understand it. The original version is preserved
    // and validate() reports it as `unsupported`.
    ...source,
    schemaVersion: Number.isInteger(source.schemaVersion) && source.schemaVersion > SCHEMA_VERSION ? source.schemaVersion : SCHEMA_VERSION,
    project: source.project ?? 'default', confidence,
    evidence: (source.evidence ?? []).map((entry) => normalizeEvidence(entry)),
    alternatives: (source.alternatives ?? []).map((a, index) => ({ ...a, id: a.id ?? `alternative_${source.id}_${index}`, reopenWhen: normalizeRules(a.reopenWhen ?? []) }))
  };
}

// B-5: a legacy fact carried `source:'unknown'` and no sourceClass at all, so
// anything reading sourceClass got undefined. Backfill the class from the stored
// label, keep the original verbatim, and NEVER raise verification (contract §6).
function migrateFact(fact) {
  const source = clone(fact);
  // P2-14: a fact written by a NEWER build keeps its own schemaVersion rather than
  // being relabelled as one this build understands. validate() reports it as
  // `unsupported` so the caller learns we cannot fully interpret it.
  const future = Number.isInteger(source.schemaVersion) && source.schemaVersion > SCHEMA_VERSION;
  const imported = { project: 'default', confidence: 0.5, status: 'active', ...source, schemaVersion: future ? source.schemaVersion : SCHEMA_VERSION };
  if (!SOURCE_CLASSES.includes(imported.sourceClass)) {
    const { sourceClass, sourceRaw } = normalizeSourceClass(imported.sourceClass ?? imported.source);
    imported.sourceClass = sourceClass;
    if (sourceRaw !== undefined) imported.sourceRaw = imported.sourceRaw ?? sourceRaw;
    else if (imported.source !== undefined && imported.source !== sourceClass) imported.sourceRaw = imported.sourceRaw ?? String(imported.source);
  }
  if (imported.source === undefined) imported.source = imported.sourceClass;
  if (!VERIFICATION_STATUSES.includes(imported.verificationStatus)) imported.verificationStatus = 'unverified';
  if (imported.actor === undefined) imported.actor = null;
  if (imported.client === undefined) imported.client = null;
  if (imported.sessionId === undefined) imported.sessionId = null;
  return imported;
}

// G7: the declared content surface. Anything not listed here is metadata, not
// content, and must not satisfy a free-text query.
function matchFields(record, needle) {
  const fields = [];
  const has = (value) => String(value ?? '').toLowerCase().includes(needle);
  if (has(record.title)) fields.push('title');
  if (has(record.goal)) fields.push('goal');
  if (has(record.chosen)) fields.push('chosen');
  if ((record.assumptions ?? []).some(has)) fields.push('assumption');
  if ((record.evidence ?? []).some((entry) => has(entry?.source) || has(entry?.detail))) fields.push('evidence');
  if ((record.alternatives ?? []).some((entry) => has(entry?.label) || has(entry?.reasonRejected))) fields.push('alternative');
  if (has(record.solution)) fields.push('attempt solution');
  if (has(record.result)) fields.push('attempt result');
  if (has(record.reason)) fields.push('attempt reason');
  if (has(record.environment)) fields.push('environment');
  return fields;
}

const FIELD_WEIGHT = { title: 5, chosen: 3, goal: 3 };
function score(record, terms) {
  let total = 0;
  for (const term of terms) {
    for (const field of matchFields(record, term)) total += FIELD_WEIGHT[field] ?? 2;
    total += 1;
  }
  return total;
}
