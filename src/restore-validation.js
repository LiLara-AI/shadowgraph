import { createShadowGraph } from './shadowgraph.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function collectionIdentity(item) {
  return String(item?.id ?? item?.key ?? JSON.stringify(stable(item)));
}

function canonicalCollection(items = []) {
  return JSON.stringify([...items].sort((left, right) => collectionIdentity(left).localeCompare(collectionIdentity(right))).map(stable));
}

export function validateRestorePayload(payload, options = {}) {
  const staging = createShadowGraph(options);
  staging.importData(payload);
  const validation = staging.validate();
  const blocking = validation.issues.filter((issue) => issue.severity === 'error' || issue.severity === 'unsupported');
  if (blocking.length) {
    const codes = [...new Set(blocking.map((issue) => issue.code))].join(', ');
    throw new Error(`Refusing to restore data: ${blocking.length} blocking issue(s) — ${codes}`);
  }

  const rebuild = staging.rebuild();
  const corruptSkipped = rebuild.skipped;
  if (corruptSkipped.length) {
    const reasons = [...new Set(corruptSkipped.map((entry) => entry.why))].join(', ');
    throw new Error(`Refusing to restore data: journal rebuild contains ${corruptSkipped.length} corrupt or unsupported entry/entries — ${reasons}`);
  }
  if (!rebuild.rebuildable && rebuild.reason === 'journal epoch is outside the available sequence range') {
    throw new Error(`Refusing to restore data: ${rebuild.reason}`);
  }

  const live = staging.exportData();
  for (const key of ['records', 'facts', 'relations', 'idempotency']) {
    if (canonicalCollection(live[key]) !== canonicalCollection(rebuild.projection[key])) {
      throw new Error(`Refusing to restore data: journal projection does not match live ${key}`);
    }
  }
  return payload;
}
