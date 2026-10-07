// Request scope: which project does this call operate on? (plan v1.4.4 §10.2)
//
// Pure: no clock, no filesystem. A scope is resolved per call and never
// persisted. Only two signals select a project -- an explicit `project`
// argument, then a confirmed binding the caller has already read -- and nothing
// is inferred. There is no global default: the literal "default" is an
// ordinary project name, never a fallback.
//
// An origin id is an opaque local identifier for one capture origin (§10.3).
// Absent, null, blank or non-string values are not identities, and two of them
// never match each other, so callers with neither a project nor an origin share
// no bucket at all.
import { randomUUID } from 'node:crypto';

export const REQUEST_STATES = Object.freeze(['project_selected', 'project_unresolved']);

export function usableOriginId(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function sameOrigin(left, right) {
  const origin = usableOriginId(left);
  return origin !== null && origin === usableOriginId(right);
}

export function mintOriginId() {
  return `origin_${randomUUID()}`;
}

// Data stored in the literal "default" before schema 6, or stored with no
// project at all, belongs to no project anyone can name (owner decision OD-1)
// -- not even the real project called "default".
export function isLegacyOwned(entity) {
  if (entity?.attribution === 'legacy_ambiguous' || entity?.attribution === 'legacy_unattributed') return true;
  return entity?.attribution === undefined && (entity?.project ?? 'default') === 'default';
}

const nonEmptyString = (value) => typeof value === 'string' && Boolean(value.trim());

export function resolveScope(context = {}) {
  const { project, binding, originId } = context ?? {};
  const origin = usableOriginId(originId);
  if (project !== undefined && project !== null) {
    if (!nonEmptyString(project)) throw new Error('project must be a non-empty string');
    return Object.freeze({ state: 'project_selected', project, source: 'argument', originId: origin });
  }
  // A binding is honoured only when it was explicitly confirmed. Anything else
  // selects nothing, which is the safe direction.
  if (binding?.confirmed === true && nonEmptyString(binding.project)) {
    return Object.freeze({ state: 'project_selected', project: binding.project, source: 'binding', originId: origin });
  }
  return Object.freeze({ state: 'project_unresolved', project: null, source: null, originId: origin });
}
