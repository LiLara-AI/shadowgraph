// ShadowGraph v0.2: an explainable, outcome-aware decision graph.

export const SCHEMA_VERSION = 2;

export function createShadowGraph(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const records = new Map();
  const facts = new Map();
  const currentFacts = new Map();
  const events = [];
  const relations = new Map();

  function id(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  function event(type, payload) {
    events.push({ id: id('event'), type, at: now(), ...clone(payload) });
  }
  function strings(value, name) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${name} must be an array of strings`);
    return [...value];
  }

  function addDecision(input) {
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
    records.set(record.id, record); event('decision.recorded', { recordId: record.id }); return clone(record);
  }

  function addAttempt(input) {
    if (!input || typeof input !== 'object' || typeof input.solution !== 'string' || !input.solution.trim() || typeof input.result !== 'string' || !input.result.trim()) throw new Error('An attempt requires non-empty solution and result strings');
    const attempt = { id: input.id ?? id('attempt'), kind: 'attempt', schemaVersion: SCHEMA_VERSION, project: input.project ?? 'default', solution: input.solution, result: input.result, environment: input.environment ?? '', reason: input.reason ?? '', reusableWhen: normalizeRules(input.reusableWhen ?? []), relatedTo: input.relatedTo ?? [], createdAt: input.createdAt ?? now() };
    records.set(attempt.id, attempt); event('attempt.recorded', { recordId: attempt.id }); return clone(attempt);
  }

  function addFact(input) {
    if (!input || typeof input.key !== 'string' || !input.key.trim()) throw new Error('A fact requires a non-empty key');
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('Fact confidence must be a number between 0 and 1');
    const factScope = JSON.stringify([input.project ?? 'default', input.key]);
    const previous = currentFacts.get(factScope);
    if (previous) previous.status = 'superseded';
    const fact = { id: input.id ?? id('fact'), kind: 'fact', schemaVersion: SCHEMA_VERSION, project: input.project ?? 'default', key: input.key, value: input.value, source: input.source ?? 'model_inferred', confidence, status: 'active', observedAt: input.observedAt ?? now() };
    facts.set(fact.id, fact); currentFacts.set(factScope, fact); event('fact.observed', { factId: fact.id, key: fact.key }); return clone(fact);
  }

  function link(input) {
    if (!input || typeof input.from !== 'string' || typeof input.to !== 'string' || typeof input.relation !== 'string') throw new Error('A relationship requires from, to, and relation');
    const relation = { id: id('relation'), kind: 'relation', schemaVersion: SCHEMA_VERSION, from: input.from, to: input.to, relation: input.relation, createdAt: now() };
    relations.set(relation.id, relation);
    events.push({ id: id('event'), type: 'relation.created', at: now(), relationId: relation.id });
    return clone(relation);
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
    return due;
  }

  function search(query = '', options = {}) {
    const needle = String(query).toLowerCase();
    return [...records.values()].filter((record) => (!options.project || record.project === options.project) && (!options.status || record.status === options.status) && (!options.minConfidence || (record.confidence?.current ?? 0) >= options.minConfidence) && JSON.stringify(record).toLowerCase().includes(needle)).map((record) => ({ record: clone(record), score: score(record, needle), matched: matchFields(record, needle), reason: `Matched ${matchFields(record, needle).join(', ') || 'record content'}` })).sort((a, b) => b.score - a.score);
  }
  function context(input = {}) {
    const project = input.project ?? 'default';
    return { project, activeDecisions: [...records.values()].filter((x) => x.kind === 'decision' && x.project === project && x.status === 'active').map(clone), staleAssumptions: [...facts.values()].filter((x) => x.project === project && x.status !== 'active').map(clone), failedAttemptsToAvoid: [...records.values()].filter((x) => x.kind === 'attempt' && x.project === project && /fail|regression|error/i.test(x.result)).map(clone), openReviews: review({ changedFacts: input.changedFacts ?? [], facts: input.facts ?? {} }).filter((x) => records.get(x.decisionId)?.project === project), suggestedQuestions: [...records.values()].filter((x) => x.kind === 'decision' && x.project === project && x.confidence.current < 0.5).map((x) => `What evidence could change the decision: ${x.title}?`) };
  }
  function exportData() { return { schemaVersion: SCHEMA_VERSION, records: [...records.values()].map(clone), facts: [...facts.values()].map(clone), relations: [...relations.values()].map(clone), events: clone(events) }; }
  function importData(data = []) { const source = Array.isArray(data) ? { records: data } : data; for (const item of source.records ?? []) { if (!item || typeof item.id !== 'string' || !['decision', 'attempt'].includes(item.kind)) continue; records.set(item.id, migrateRecord(item)); } for (const fact of source.facts ?? []) { if (!fact || typeof fact.key !== 'string') continue; const imported = { schemaVersion: SCHEMA_VERSION, project: 'default', source: 'unknown', confidence: 0.5, status: 'active', ...clone(fact) }; facts.set(imported.id ?? id('fact'), imported); if (imported.status === 'active') currentFacts.set(JSON.stringify([imported.project ?? 'default', imported.key]), imported); } for (const relation of source.relations ?? []) { if (relation?.id && relation.from && relation.to && relation.relation) relations.set(relation.id, clone(relation)); } events.push(...(source.events ?? []).filter((item) => item && typeof item.id === 'string').map(clone)); return records.size + facts.size + relations.size; }
  function stats() { const all = [...records.values()]; return { schemaVersion: SCHEMA_VERSION, total: all.length, decisions: all.filter((x) => x.kind === 'decision').length, attempts: all.filter((x) => x.kind === 'attempt').length, facts: facts.size, relations: relations.size, events: events.length }; }
  return { addDecision, addAttempt, addFact, setOutcome, updateDecisionStatus, link, review, search, context, exportData, importData, stats };
}

function normalizeRules(rules) { return rules.map((rule) => typeof rule === 'string' ? rule : { key: rule.key, operator: rule.operator ?? 'equals', value: rule.value }); }
function normalizeEvidence(item, clock = () => new Date().toISOString()) { return typeof item === 'string' ? { source: item, type: 'unknown', confidence: 0.5, observedAt: clock() } : { source: item.source ?? 'unknown', type: item.type ?? 'unknown', confidence: item.confidence ?? 0.5, observedAt: item.observedAt ?? clock(), detail: item.detail ?? '' }; }
function migrateRecord(item) { if (item.kind !== 'decision') return { schemaVersion: SCHEMA_VERSION, project: 'default', ...clone(item) }; const confidence = typeof item.confidence === 'number' ? item.confidence : item.confidence?.current ?? 0.5; return { ...clone(item), schemaVersion: SCHEMA_VERSION, project: item.project ?? 'default', confidence: { initial: confidence, current: confidence, history: item.confidence?.history ?? [] }, alternatives: (item.alternatives ?? []).map((a) => ({ ...a, id: a.id ?? `alternative_${Date.now()}`, reopenWhen: normalizeRules(a.reopenWhen ?? []) })) }; }
function matchFields(record, needle) { const fields = []; if (String(record.title ?? '').toLowerCase().includes(needle)) fields.push('title'); if (String(record.goal ?? '').toLowerCase().includes(needle)) fields.push('goal'); if (String(record.chosen ?? '').toLowerCase().includes(needle)) fields.push('chosen'); if ((record.assumptions ?? []).some((x) => String(x).toLowerCase().includes(needle))) fields.push('assumption'); if ((record.evidence ?? []).some((x) => JSON.stringify(x).toLowerCase().includes(needle))) fields.push('evidence'); if ((record.alternatives ?? []).some((x) => JSON.stringify(x).toLowerCase().includes(needle))) fields.push('alternative'); if (String(record.result ?? '').toLowerCase().includes(needle)) fields.push('attempt result'); if (String(record.reason ?? '').toLowerCase().includes(needle)) fields.push('attempt reason'); return fields; }
function score(record, needle) { return matchFields(record, needle).reduce((sum, field) => sum + (field === 'title' ? 5 : field === 'chosen' || field === 'goal' ? 3 : 2), 0); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
