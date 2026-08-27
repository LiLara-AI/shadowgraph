// Explainable hybrid retrieval for ShadowGraph.
//
// Embeddings are a derived index, never canonical truth. The caller gets an
// explicit availability report for every signal so lexical fallback can never be
// misrepresented as semantic search.

const SIGNALS = Object.freeze(['lexical', 'semantic', 'graph', 'temporal']);
const DEFAULT_WEIGHTS = Object.freeze({ lexical: 1, semantic: 1, graph: 0.8, temporal: 0.4 });
const RRF_K = 60;

function tokenize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function primitives(value, output = []) {
  if (value === null || value === undefined) return output;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') output.push(String(value));
  else if (Array.isArray(value)) for (const item of value) primitives(item, output);
  else if (typeof value === 'object') for (const item of Object.values(value)) primitives(item, output);
  return output;
}

function searchableText(record) {
  if (record.kind === 'memory') return [record.key, record.text, ...(record.tags ?? []), ...primitives(record.metadata)].join(' ');
  if (record.kind === 'fact') return [record.key, ...primitives(record.value)].join(' ');
  if (record.kind === 'decision') {
    return [
      record.title, record.goal, record.chosen, ...(record.assumptions ?? []),
      ...(record.evidence ?? []).flatMap((item) => [item?.source, item?.detail]),
      ...(record.alternatives ?? []).flatMap((item) => [item?.label, item?.reasonRejected])
    ].join(' ');
  }
  if (record.kind === 'attempt') return [record.solution, record.result, record.reason, record.environment].join(' ');
  return '';
}

function normalizedScope(scope = {}) {
  return {
    userId: scope?.userId ?? null,
    agentId: scope?.agentId ?? null,
    runId: scope?.runId ?? null
  };
}

function sameScope(left, right) {
  const a = normalizedScope(left);
  const b = normalizedScope(right);
  return a.userId === b.userId && a.agentId === b.agentId && a.runId === b.runId;
}

function temporalOf(record) {
  if (record.temporal) return record.temporal;
  if (record.kind === 'fact') {
    return {
      validFrom: record.validFrom ?? record.observedAt ?? null,
      validTo: record.validTo ?? null,
      recordedAt: record.recordedAt ?? record.observedAt ?? null,
      invalidatedAt: record.invalidatedAt ?? null
    };
  }
  return null;
}

function validAt(record, asOf) {
  const temporal = temporalOf(record);
  if (!temporal) return true;
  const point = Date.parse(asOf);
  if (!Number.isFinite(point)) return false;
  const from = temporal.validFrom;
  const to = temporal.validTo;
  if (from && Date.parse(from) > point) return false;
  if (to && Date.parse(to) <= point) return false;
  return true;
}

function visible(record, options) {
  if (options.project && record.project !== options.project) return false;
  if (record.kind === 'memory') {
    // Omitted scope means the explicit project-wide (all-null) scope. Never let a
    // transport that forgot user/agent/run identity turn that omission into an
    // all-scopes read.
    if (!sameScope(record.scope, options.scope ?? {})) return false;
    if (options.memoryType && record.memoryType !== options.memoryType) return false;
    const pointInTime = options.asOf ?? options.currentAt ?? null;
    return pointInTime ? validAt(record, pointInTime) : record.status === 'active';
  }
  if (record.kind === 'fact') {
    const pointInTime = options.asOf ?? options.currentAt ?? null;
    return pointInTime ? validAt(record, pointInTime) : record.status === 'active';
  }
  if (options.kind && record.kind !== options.kind) return false;
  return true;
}

function lexicalRanking(candidates, query) {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length) return { list: [], raw: new Map(), terms: [] };
  const documents = candidates.map((record) => ({ record, tokens: tokenize(searchableText(record)) }));
  const averageLength = documents.reduce((sum, item) => sum + item.tokens.length, 0) / Math.max(documents.length, 1);
  const raw = new Map();
  const k1 = 1.2;
  const b = 0.75;
  for (const term of queryTerms) {
    const documentFrequency = documents.filter((item) => item.tokens.includes(term)).length;
    if (!documentFrequency) continue;
    const idf = Math.log(1 + ((documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5)));
    for (const item of documents) {
      const frequency = item.tokens.filter((token) => token === term).length;
      if (!frequency) continue;
      const normalization = frequency + k1 * (1 - b + b * (item.tokens.length / Math.max(averageLength, 1)));
      raw.set(item.record.id, (raw.get(item.record.id) ?? 0) + idf * ((frequency * (k1 + 1)) / normalization));
    }
  }
  const list = [...raw.entries()].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]))).map(([id]) => id);
  return { list, raw, terms: queryTerms };
}

function vectorValues(value) {
  const values = Array.isArray(value) ? value : value?.values;
  if (!Array.isArray(values) || values.length === 0 || values.some((item) => typeof item !== 'number' || !Number.isFinite(item))) return null;
  return values;
}

function embeddingDescriptor(value) {
  const values = vectorValues(value);
  if (!values) return null;
  const model = Array.isArray(value) ? null : (value?.model ?? null);
  return { model, values };
}

function cosine(left, right) {
  if (!left || !right || left.length !== right.length) return null;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function semanticRanking(candidates, queryEmbedding) {
  const query = embeddingDescriptor(queryEmbedding);
  const raw = new Map();
  if (!query) return { list: [], raw, available: false, reason: 'A finite non-empty queryEmbedding is required' };
  for (const record of candidates) {
    const stored = embeddingDescriptor(record.embedding);
    if (!stored || stored.model !== query.model) continue;
    const similarity = cosine(query.values, stored.values);
    if (similarity !== null) raw.set(record.id, similarity);
  }
  if (!raw.size) return { list: [], raw, available: false, reason: 'No stored embedding matches the query model and dimension' };
  const list = [...raw.entries()].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]))).map(([id]) => id);
  return { list, raw, available: true, reason: null };
}

function relationVisible(relation, asOf) {
  if (!asOf) return relation.status !== 'invalidated';
  return validAt(relation, asOf);
}

function graphRanking(candidates, relations, focalId, asOf, maxDepth = 3) {
  const raw = new Map();
  if (typeof focalId !== 'string' || !focalId) return { list: [], raw, available: false, reason: 'focalId is required' };
  const candidateIds = new Set(candidates.map((record) => record.id));
  const edges = relations.filter((relation) => relationVisible(relation, asOf));
  const seen = new Set([focalId]);
  let frontier = [focalId];
  for (let distance = 1; distance <= maxDepth && frontier.length; distance += 1) {
    const next = [];
    for (const relation of edges) {
      const neighbour = frontier.includes(relation.from) ? relation.to : frontier.includes(relation.to) ? relation.from : null;
      if (!neighbour || seen.has(neighbour)) continue;
      seen.add(neighbour);
      next.push(neighbour);
      if (candidateIds.has(neighbour) && neighbour !== focalId) raw.set(neighbour, distance);
    }
    frontier = next;
  }
  const list = [...raw.entries()].sort((left, right) => left[1] - right[1] || String(left[0]).localeCompare(String(right[0]))).map(([id]) => id);
  return { list, raw, available: list.length > 0, reason: list.length ? null : 'No candidate is reachable from focalId' };
}

function temporalRanking(candidates, enabled) {
  const raw = new Map();
  if (!enabled) return { list: [], raw, available: false, reason: 'Set asOf or preferRecent to enable temporal ranking' };
  for (const record of candidates) {
    const temporal = temporalOf(record);
    const value = temporal?.validFrom ?? temporal?.recordedAt;
    if (value) raw.set(record.id, String(value));
  }
  const list = [...raw.entries()].sort((left, right) => Date.parse(right[1]) - Date.parse(left[1]) || String(left[0]).localeCompare(String(right[0]))).map(([id]) => id);
  return { list, raw, available: true, reason: null };
}

function ranks(list) {
  return new Map(list.map((id, index) => [id, index + 1]));
}

export function hybridSearch(snapshot, query = '', options = {}) {
  const records = [...(snapshot.records ?? []), ...(snapshot.facts ?? [])].filter((record) => visible(record, options));
  const byId = new Map(records.map((record) => [record.id, record]));
  const lexical = lexicalRanking(records, query);
  const semantic = semanticRanking(records, options.queryEmbedding);
  const graph = graphRanking(records, snapshot.relations ?? [], options.focalId, options.asOf ?? options.currentAt, options.graphDepth ?? 3);
  const temporal = temporalRanking(records, Boolean(options.asOf || options.preferRecent));
  const lists = { lexical, semantic, graph, temporal };
  const rankMaps = Object.fromEntries(SIGNALS.map((name) => [name, ranks(lists[name].list)]));
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights ?? {}) };
  const ids = new Set(SIGNALS.flatMap((name) => lists[name].list));

  // An empty query is a useful scoped listing operation. It is declared as such,
  // not disguised as a content match.
  if (!tokenize(query).length && !vectorValues(options.queryEmbedding) && !options.focalId) {
    for (const record of records) ids.add(record.id);
  }

  const items = [...ids].map((id) => {
    const record = byId.get(id);
    const hitRanks = {};
    const rawScores = {};
    const reasons = [];
    let score = 0;
    for (const name of SIGNALS) {
      const rank = rankMaps[name].get(id) ?? null;
      hitRanks[name] = rank;
      rawScores[name] = lists[name].raw.get(id) ?? null;
      if (rank !== null) {
        score += (weights[name] ?? 0) / (RRF_K + rank);
        reasons.push(`${name} rank ${rank}`);
      }
    }
    return { record, score, ranks: hitRanks, scores: rawScores, reasons };
  }).filter((item) => item.record).sort((left, right) => right.score - left.score || String(left.record.id).localeCompare(String(right.record.id)));

  return {
    items,
    signals: {
      lexical: { available: lexical.terms.length > 0, matched: lexical.list.length, terms: lexical.terms },
      semantic: { available: semantic.available, matched: semantic.list.length, reason: semantic.reason },
      graph: { available: graph.available, matched: graph.list.length, reason: graph.reason },
      temporal: { available: temporal.available, matched: temporal.list.length, reason: temporal.reason, asOf: options.asOf ?? null }
    },
    ranking: { strategy: 'weighted_rrf', k: RRF_K, weights }
  };
}
