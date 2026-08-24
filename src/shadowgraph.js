// ShadowGraph: one unified memory for decisions, rejected alternatives, assumptions,
// evidence, failed attempts, and conditions that should reopen old choices.

export function createShadowGraph(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const records = new Map();

  function id(prefix = 'record') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function addDecision(input) {
    if (!input || typeof input !== 'object' || typeof input.title !== 'string' || !input.title.trim() || typeof input.chosen !== 'string' || !input.chosen.trim()) {
      throw new Error('A decision requires non-empty title and chosen strings');
    }
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
      throw new Error('Decision confidence must be a number between 0 and 1');
    }
    const alternatives = input.alternatives ?? [];
    if (!Array.isArray(alternatives) || alternatives.some((item) => !item || typeof item.label !== 'string' || !item.label.trim())) {
      throw new Error('Decision alternatives must have non-empty label strings');
    }
    const record = {
      id: input.id ?? id('decision'),
      kind: 'decision',
      title: input.title,
      goal: input.goal ?? '',
      chosen: input.chosen,
      confidence,
      status: 'active',
      assumptions: [...(input.assumptions ?? [])],
      evidence: [...(input.evidence ?? [])],
      alternatives: (input.alternatives ?? []).map((alternative) => ({
        label: alternative.label,
        reasonRejected: alternative.reasonRejected ?? '',
        reopenWhen: [...(alternative.reopenWhen ?? [])],
        status: 'rejected'
      })),
      failedAttempts: [...(input.failedAttempts ?? [])],
      reviewAfter: input.reviewAfter ?? null,
      createdAt: input.createdAt ?? now(),
      updatedAt: now()
    };
    records.set(record.id, record);
    return clone(record);
  }

  function addAttempt(input) {
    if (!input || typeof input !== 'object' || typeof input.solution !== 'string' || !input.solution.trim() || typeof input.result !== 'string' || !input.result.trim()) {
      throw new Error('An attempt requires non-empty solution and result strings');
    }
    const attempt = {
      id: input.id ?? id('attempt'),
      kind: 'attempt',
      solution: input.solution,
      result: input.result,
      environment: input.environment ?? '',
      reason: input.reason ?? '',
      reusableWhen: [...(input.reusableWhen ?? [])],
      createdAt: input.createdAt ?? now()
    };
    records.set(attempt.id, attempt);
    return clone(attempt);
  }

  function review(context = {}) {
    const changed = new Set(context.changedFacts ?? []);
    const due = [];
    for (const record of records.values()) {
      if (record.kind !== 'decision') continue;
      const triggers = record.alternatives.flatMap((item) => item.reopenWhen);
      const matched = triggers.filter((trigger) => changed.has(trigger));
      if (matched.length || (record.reviewAfter && record.reviewAfter <= now())) {
        due.push({
          decisionId: record.id,
          title: record.title,
          reason: matched.length ? `Changed condition: ${matched.join(', ')}` : 'Review date reached',
          alternativesToReconsider: record.alternatives.map((item) => item.label)
        });
      }
    }
    return due;
  }

  function search(query = '') {
    const needle = query.toLowerCase();
    return [...records.values()]
      .filter((record) => JSON.stringify(record).toLowerCase().includes(needle))
      .map(clone);
  }

  function exportData() {
    return [...records.values()].map(clone);
  }

  function importData(items = []) {
    for (const item of items) records.set(item.id, clone(item));
    return records.size;
  }

  function stats() {
    const all = [...records.values()];
    return {
      total: all.length,
      decisions: all.filter((item) => item.kind === 'decision').length,
      attempts: all.filter((item) => item.kind === 'attempt').length
    };
  }

  return { addDecision, addAttempt, review, search, exportData, importData, stats };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
