import { createShadowGraph } from './shadowgraph.js';

export function validateRestorePayload(payload, options = {}) {
  const staging = createShadowGraph(options);
  staging.importData(payload);
  const validation = staging.validate();
  const blocking = validation.issues.filter((issue) => issue.severity === 'error' || issue.severity === 'unsupported');
  if (blocking.length) {
    const codes = [...new Set(blocking.map((issue) => issue.code))].join(', ');
    throw new Error(`Refusing to restore data: ${blocking.length} blocking issue(s) — ${codes}`);
  }
  return payload;
}
