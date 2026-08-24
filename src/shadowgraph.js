// ShadowGraph: an explainable, outcome-aware decision graph.

export const SCHEMA_VERSION = 2;

export function createShadowGraph(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const records = new Map();
  const facts = new Map();
  const currentFacts = new Map();
  const events = [];
  const relations = new Map();
  const reviewSignals = new Map();
  const idempotency = new Map();
  let revision = Number.isInteger(options.revision) ? options.revision : 0;
  function setRevision(value) { if (Number.isInteger(value) && value >= revision) revision = value; }

  function id(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
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
  function strings(value, name) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${name} must be an array of strings`);
    return [...value];
  }

  function idempotent(input, action) {
    if (!input?.idempotencyKey) return undefined;
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length > 200) throw new Error('idempotencyKey must be a string of at most 200 characters');
    const existing = idempotency.get(`${action}:${input.idempotencyKey}`);
    if (existing) return clone(existing);
    return undefined;
  }
  function rememberIdempotency(input, action, value) { if (input?.idempotencyKey) idempotency.set(`${action}:${input.idempotencyKey}`, clone(value)); }
  function addDecision(input) {
    const existing = idempotent(input, 'decision'); if (existing) return existing;
    if (!input || typeof input !== 'object' || typeof input.title !== 'string' || !input.title.trim() || typeof input.chosen !== 'string' || !input.chosen.trim()) throw new Error('A decision requires non-empty title and chosen strings');
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('Decision confidence must be a number between 0 and 1');
    const alternatives = input.alternatives ?? [];
    if (!Array.isArray(alternatives) || alternatives.some((item) => !item || typeof item.label !== 'string' || !item.label.trim())) throw new Error('Decision alternatives must have non-empty label strings');
    const record = {
      id: input.id ?? id('decision'), kind: 'decision', schemaVersion: SCHEMA_VERSION,
      project: input.project ?? 'default', title: input.title, goal: input.goal ?? '', chosen: input.chosen,
      confidence: { initial: confidence, current: confidence, history: [] }, status: 'active',
      assumptions: strings(input.assumptions, 'assumptions'), evidence: (input.evidence ?? []).map((item) => normalizeEvidence(item, now)),
      alternatives: alternatives.map((item) => ({ id: item.id ?? id('alternative'), label: item.label, reasonRejected: item.reasonRejected ?? '', reopenWhen: normalizeRules(item.reopenWhen ?? []), status: 'rejected' })),
      failedAttempts: [...(input.failedAttempts ?? [])], outcome: input.outcome ?? null,
      reviewAfter: input.reviewAfter ?? null, createdAt: input.createdAt ?? now(), updatedAt: now()
    };
    records.set(record.id, record); event('decision.recorded', { recordId: record.id }); const result = clone(record); rememberIdempotency(input, 'decision', result); return result;
  }

  function addAttempt(input) {
    const existing = idempotent(input, 'attempt'); if (existing) return existing;
    if (!input || typeof input !== 'object' || typeof input.solution !== 'string' || !input.solution.trim() || typeof input.result !== 'string' || !input.result.trim()) throw new Error('An attempt requires non-empty solution and result strings');
    const attempt = { id: input.id ?? id('attempt'), kind: 'attempt', schemaVersion: SCHEMA_VERSION, project: input.project ?? 'default', solution: input.solution, result: input.result, environment: input.environment ?? '', reason: input.reason ?? '', reusableWhen: normalizeRules(input.reusableWhen ?? []), relatedTo: input.relatedTo ?? [], createdAt: input.createdAt ?? now() };
    records.set(attempt.id, attempt); event('attempt.recorded', { recordId: attempt.id }); const result = clone(attempt); rememberIdempotency(input, 'attempt', result); return result;
  }

  function addFact(input) {
    const existing = idempotent(input, 'fact'); if (existing) return existing;
    if (!input || typeof input.key !== 'string' || !input.key.trim()) throw new Error('A fact requires a non-empty key');
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('Fact confidence must be a number between 0 and 1');
    const factScope = JSON.stringify([input.project ?? 'default', input.key]);
    const previous = currentFacts.get(factScope);
    if (previous) previous.status = 'superseded';
    const verificationStatus = input.verificationStatus ?? (input.source === 'human_confirmed' || input.source === 'tool_observed' ? 'verified' : 'unverified');
    if (!['unverified', 'verified', 'contradicted', 'expired'].includes(verificationStatus)) throw new Error('Invalid fact verificationStatus');
    const fact = { id: input.id ?? id('fact'), kind: 'fact', schemaVersion: SCHEMA_VERSION, project: input.project ?? 'default', key: input.key, value: input.value, source: input.source ?? 'model_inferred', confidence, verificationStatus, status: 'active', expiresAt: input.expiresAt ?? null, observedAt: input.observedAt ?? now() };
    facts.set(fact.id, fact); currentFacts.set(factScope, fact); event('fact.observed', { factId: fact.id, key: fact.key }); const result = clone(fact); rememberIdempotency(input, 'fact', result); return result;
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
    return { previous: clone(previous), replacement: clone(replacement), relation };
  }
  function updateDecisionStatus(decisionId, status) {
    const allowed = ['proposed', 'active', 'aging', 'stale', 'validated', 'failed', 'superseded', 'archived'];
    const record = records.get(decisionId); if (!record || record.kind !== 'decision') throw new Error('Decision not found');
    if (!allowed.includes(status)) throw new Error(`Invalid decision status: ${status}`);
    record.status = status; record.updatedAt = now(); event('decision.status', { recordId: decisionId, status }); return clone(record);
  }

  function setOutcome(decisionId, outcome) {
    const record = records.get(decisionId); if (!record || record.kind !== 'decision') throw new Error('Decision not found');
    if (!['successful', 'mixed', 'failed', 'unknown'].includes(outcome?.status)) throw new Error('Outcome status must be successful, mixed, failed, or unknown');
    record.outcome = { ...clone(outcome), observedAt: outcome.observedAt ?? now() }; record.updatedAt = now();
    const delta = outcome.status === 'successful' ? 0.1 : outcome.status === 'failed' ? -0.2 : 0;
    record.confidence.current = Math.max(0, Math.min(1, record.confidence.current + delta));
    record.confidence.history.push({ delta, reason: `Outcome: ${outcome.status}`, at: now() }); event('decision.outcome', { recordId: decisionId, status: outcome.status }); return clone(record);
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
  function review(context = {}) {
    const changed = new Set(context.changedFacts ?? []); const due = [];
    for (const record of records.values()) {
      if (record.kind !== 'decision') continue;
      const matches = [];
      const reconsider = new Set();
      for (const alternative of record.alternatives) for (const rule of alternative.reopenWhen) {
        if (typeof rule === 'string' && changed.has(rule)) { matches.push(rule); reconsider.add(alternative.label); }
        else if (rule && Object.prototype.hasOwnProperty.call(context.facts ?? {}, rule.key) && ruleMatches(rule, context.facts[rule.key])) { matches.push(rule.key); reconsider.add(alternative.label); }
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
    for (const record of records.values()) if (record.kind === 'decision' && record.reviewAfter && record.reviewAfter <= at && ['active', 'validated'].includes(record.status)) { record.status = 'aging'; record.updatedAt = at; agedDecisionIds.push(record.id); }
    for (const fact of facts.values()) if (fact.status === 'active' && fact.expiresAt && fact.expiresAt <= at) { fact.status = 'expired'; fact.verificationStatus = 'expired'; }
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
    if (project) { data.records = data.records.filter((item) => item.project === project); data.facts = data.facts.filter((item) => item.project === project); const ids = new Set([...data.records, ...data.facts].map((item) => item.id)); data.relations = data.relations.filter((item) => ids.has(item.from) && ids.has(item.to)); data.events = data.events.filter((item) => item.project === project && (!item.relationId || data.relations.some((relation) => relation.id === item.relationId))); }
    return transform(data);
  }
  function projectSummary(project) {
    if (typeof project !== 'string' || !project.trim()) throw new Error('A project name is required');
    const recordsForProject = [...records.values()].filter((item) => item.project === project);
    const ids = new Set(recordsForProject.map((item) => item.id));
    for (const record of recordsForProject) for (const alternative of record.alternatives ?? []) ids.add(alternative.id);
    for (const fact of facts.values()) if (fact.project === project) ids.add(fact.id);
    return { project, records: recordsForProject.length, facts: [...facts.values()].filter((item) => item.project === project).length, relations: [...relations.values()].filter((item) => ids.has(item.from) || ids.has(item.to)).length, events: events.filter((item) => item.project === project || ids.has(item.recordId) || ids.has(item.factId)).length };
  }
  function purgeProject(project) {
    const summary = projectSummary(project);
    const projectRecords = [...records.values()].filter((item) => item.project === project);
    const removed = new Set(projectRecords.map((item) => item.id));
    for (const record of projectRecords) for (const alternative of record.alternatives ?? []) removed.add(alternative.id);
    for (const fact of facts.values()) if (fact.project === project) removed.add(fact.id);
    for (const [recordId, record] of records) if (record.project === project) records.delete(recordId);
    for (const [factId, fact] of facts) if (fact.project === project) facts.delete(factId);
    for (const [relationId, relation] of relations) if (removed.has(relation.from) || removed.has(relation.to)) relations.delete(relationId);
    for (const [key, fact] of currentFacts) if (removed.has(fact.id)) currentFacts.delete(key);
    for (let index = events.length - 1; index >= 0; index -= 1) { const item = events[index]; if (item.project === project || removed.has(item.recordId) || removed.has(item.factId) || (item.relationId && !relations.has(item.relationId))) events.splice(index, 1); }
    return { ...summary, removed: removed.size };
  }
  function validate() {
    const issues = [];
    for (const relation of relations.values()) { if (!entity(relation.from)) issues.push({ code: 'missing_relation_source', relationId: relation.id, entityId: relation.from }); if (!entity(relation.to)) issues.push({ code: 'missing_relation_target', relationId: relation.id, entityId: relation.to }); }
    for (const record of records.values()) if (record.kind === 'decision') { if (record.supersededBy === record.id) issues.push({ code: 'self_supersession', recordId: record.id }); if (record.confidence.current < 0 || record.confidence.current > 1) issues.push({ code: 'invalid_confidence', recordId: record.id }); }
    return { valid: issues.length === 0, issues };
  }
  function repairPlan() { return { apply: false, actions: validate().issues.map((issue) => issue.code.startsWith('missing_relation_') ? { action: 'remove_relation', relationId: issue.relationId, reason: issue.code } : { action: 'manual_review', ...issue }) }; }
  function retrieve(query = '', options = {}) {
    const direct = search(query, options);
    const results = direct.map((item) => ({ ...item, graphBoost: 0, reasons: [item.reason] }));
    const directIds = new Set(results.map((item) => item.record.id));
    for (const relation of relations.values()) { const relatedId = directIds.has(relation.from) ? relation.to : directIds.has(relation.to) ? relation.from : null; const related = relatedId && entity(relatedId); if (related && related.kind !== 'alternative' && (!options.project || related.project === options.project) && !directIds.has(relatedId)) results.push({ record: clone(related), score: 1, graphBoost: 1, matched: ['relationship'], reasons: [`Related by ${relation.relation}`] }); }
    return results.sort((a, b) => b.score - a.score);
  }
  function search(query = '', options = {}) {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    return [...records.values()].filter((record) => (!options.project || record.project === options.project) && (!options.status || record.status === options.status) && (options.minConfidence === undefined || (record.confidence?.current ?? 0) >= options.minConfidence) && terms.every((term) => JSON.stringify(record).toLowerCase().includes(term))).map((record) => { const matched = [...new Set(terms.flatMap((term) => matchFields(record, term)))]; return { record: clone(record), score: score(record, terms.join(' ')) + terms.length, matched, reason: `Matched ${matched.join(', ') || 'record content'}` }; }).sort((a, b) => b.score - a.score);
  }
  function context(input = {}) {
    const project = input.project ?? 'default';
    return { project, activeDecisions: [...records.values()].filter((x) => x.kind === 'decision' && x.project === project && x.status === 'active').map(clone), staleAssumptions: [...facts.values()].filter((x) => x.project === project && x.status !== 'active').map(clone), failedAttemptsToAvoid: [...records.values()].filter((x) => x.kind === 'attempt' && x.project === project && /fail|regression|error/i.test(x.result)).map(clone), openReviews: review({ changedFacts: input.changedFacts ?? [], facts: input.facts ?? {} }).filter((x) => records.get(x.decisionId)?.project === project), suggestedQuestions: [...records.values()].filter((x) => x.kind === 'decision' && x.project === project && x.confidence.current < 0.5).map((x) => `What evidence could change the decision: ${x.title}?`) };
  }
  function exportData() { return { schemaVersion: SCHEMA_VERSION, revision, records: [...records.values()].map(clone), facts: [...facts.values()].map(clone), relations: [...relations.values()].map(clone), reviewSignals: [...reviewSignals.values()].map(clone), idempotency: [...idempotency.entries()].map(([key, value]) => ({ key, value: clone(value) })), events: clone(events) }; }
  function replaceData(data = []) { records.clear(); facts.clear(); currentFacts.clear(); relations.clear(); reviewSignals.clear(); idempotency.clear(); events.length = 0; revision = 0; return importData(data); }
  function importData(data = []) { const source = Array.isArray(data) ? { records: data } : data; revision = Number.isInteger(source.revision) ? source.revision : revision; for (const item of source.records ?? []) { if (!item || typeof item.id !== 'string' || !['decision', 'attempt'].includes(item.kind)) continue; records.set(item.id, migrateRecord(item)); } for (const fact of source.facts ?? []) { if (!fact || typeof fact.key !== 'string') continue; const imported = { schemaVersion: SCHEMA_VERSION, project: 'default', source: 'unknown', confidence: 0.5, status: 'active', ...clone(fact) }; facts.set(imported.id ?? id('fact'), imported); if (imported.status === 'active') currentFacts.set(JSON.stringify([imported.project ?? 'default', imported.key]), imported); } for (const relation of source.relations ?? []) { if (relation?.id && relation.from && relation.to && relation.relation) relations.set(relation.id, clone(relation)); } for (const signal of source.reviewSignals ?? []) if (signal?.id) reviewSignals.set(`${signal.decisionId}:${signal.reason}`, clone(signal)); for (const item of source.idempotency ?? []) if (item?.key) idempotency.set(item.key, clone(item.value)); events.push(...(source.events ?? []).filter((item) => item && typeof item.id === 'string').map(clone)); return records.size + facts.size + relations.size; }
  function stats() { const all = [...records.values()]; return { schemaVersion: SCHEMA_VERSION, total: all.length, decisions: all.filter((x) => x.kind === 'decision').length, attempts: all.filter((x) => x.kind === 'attempt').length, facts: facts.size, relations: relations.size, reviewSignals: reviewSignals.size, events: events.length }; }
  return { setRevision, replaceData, addDecision, addAttempt, addFact, setOutcome, updateDecisionStatus, supersedeDecision, link, traverse, redact, projectSummary, purgeProject, review, maintain, getReviewSignals, acknowledgeReview, search, retrieve, validate, repairPlan, context, exportData, importData, stats };
}

function normalizeRules(rules) { return rules.map((rule) => typeof rule === 'string' ? rule : { key: rule.key, operator: rule.operator ?? 'equals', value: rule.value }); }
function normalizeEvidence(item, clock = () => new Date().toISOString()) { return typeof item === 'string' ? { source: item, type: 'unknown', confidence: 0.5, observedAt: clock() } : { source: item.source ?? 'unknown', type: item.type ?? 'unknown', confidence: item.confidence ?? 0.5, observedAt: item.observedAt ?? clock(), detail: item.detail ?? '' }; }
function migrateRecord(item) { if (item.kind !== 'decision') return { schemaVersion: SCHEMA_VERSION, project: 'default', ...clone(item) }; const source = clone(item); const confidence = typeof source.confidence === 'number' ? source.confidence : source.confidence?.current ?? 0.5; return { ...source, schemaVersion: SCHEMA_VERSION, project: source.project ?? 'default', confidence: { initial: typeof source.confidence === 'object' ? source.confidence.initial ?? confidence : confidence, current: confidence, history: source.confidence?.history ?? [] }, alternatives: (source.alternatives ?? []).map((a, index) => ({ ...a, id: a.id ?? `alternative_${source.id}_${index}`, reopenWhen: normalizeRules(a.reopenWhen ?? []) })) }; }
function matchFields(record, needle) { const fields = []; if (String(record.title ?? '').toLowerCase().includes(needle)) fields.push('title'); if (String(record.goal ?? '').toLowerCase().includes(needle)) fields.push('goal'); if (String(record.chosen ?? '').toLowerCase().includes(needle)) fields.push('chosen'); if ((record.assumptions ?? []).some((x) => String(x).toLowerCase().includes(needle))) fields.push('assumption'); if ((record.evidence ?? []).some((x) => JSON.stringify(x).toLowerCase().includes(needle))) fields.push('evidence'); if ((record.alternatives ?? []).some((x) => JSON.stringify(x).toLowerCase().includes(needle))) fields.push('alternative'); if (String(record.result ?? '').toLowerCase().includes(needle)) fields.push('attempt result'); if (String(record.reason ?? '').toLowerCase().includes(needle)) fields.push('attempt reason'); return fields; }
function score(record, needle) { return matchFields(record, needle).reduce((sum, field) => sum + (field === 'title' ? 5 : field === 'chosen' || field === 'goal' ? 3 : 2), 0); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
