// v1.1 arm registry.
//
// One place binds an arm id to the runtime that executes it and to the native
// isolation that runtime actually provides. Both halves matter: a runtime that
// is not pinned cannot support a reproducibility claim, and an isolation
// capability that is asserted rather than observed cannot support an
// applicability claim.
//
// Native isolation is recorded from what each product exposes, not from what
// the methodology declares. Where the two disagree the registry reports it
// instead of resolving it, because changing a declared applicability entry is a
// methodology decision and not something a lookup table may decide.
//
// Isolation is never manufactured. If a product has no user-scoped record API,
// this registry will not synthesise one by folding a user id into the project
// scope - that would report isolation the product does not have.

import { PYTHON_ADAPTER_SPECS } from './python-adapter-executor.mjs';

/** The seven frozen arms, in their frozen order. */
export const V11_ARM_IDS = Object.freeze([
  'no-memory',
  'shadowgraph-full',
  'shadowgraph-compact',
  'mem0-oss',
  'graphiti',
  'basic-memory',
  'cognee'
]);

/** How an arm is executed. */
export const RUNTIME_KINDS = Object.freeze(['control', 'node-mcp', 'python-container']);

/**
 * Observed native isolation per arm.
 *
 * `userNamespace` is null when the product exposes no user-scoped record API at
 * this pinned version. `userNamespacePrecondition` names configuration that must
 * be pinned before a present capability may be used.
 *
 * Sources: the shipped adapters for the Node arms and Mem0, and the recorded
 * introspection under benchmark/evidence for Graphiti and Cognee.
 */
export const NATIVE_ISOLATION = Object.freeze({
  'no-memory': Object.freeze({
    projectNamespace: null,
    userNamespace: null,
    userNamespacePrecondition: null,
    note: 'control arm holds no records, so neither namespace applies'
  }),
  'shadowgraph-full': Object.freeze({
    projectNamespace: 'project',
    userNamespace: null,
    userNamespacePrecondition: null,
    note: 'decision records carry a native project scope and no user scope'
  }),
  'shadowgraph-compact': Object.freeze({
    projectNamespace: 'project',
    userNamespace: null,
    userNamespacePrecondition: null,
    note: 'decision records carry a native project scope and no user scope'
  }),
  'mem0-oss': Object.freeze({
    projectNamespace: 'agent_id',
    userNamespace: 'user_id',
    userNamespacePrecondition: null,
    note: 'agent_id and user_id are independent native scopes on every operation'
  }),
  graphiti: Object.freeze({
    projectNamespace: 'group_id',
    userNamespace: null,
    userNamespacePrecondition: null,
    note: 'no method or node model accepts a user scope; group_id is the only scope'
  }),
  'basic-memory': Object.freeze({
    projectNamespace: 'project',
    userNamespace: null,
    userNamespacePrecondition: null,
    note: 'project namespaces exist as a product feature; no user namespace does'
  }),
  cognee: Object.freeze({
    projectNamespace: 'dataset',
    userNamespace: 'user',
    userNamespacePrecondition: 'pinned backend access-control configuration',
    note: 'a native user ACL exists and is programmatically assignable'
  })
});

/**
 * The single exclusion rule: an arm is excluded from ISOLATION_USER unless its
 * declared user isolation is SUPPORTED. Exported so every count path uses this
 * predicate rather than its own spelling of it.
 */
export function isExcludedFromUserIsolation(declaredArm) {
  return declaredArm?.userIsolation?.status !== 'SUPPORTED';
}

/** Findings the registry can raise about a declared applicability matrix. */
export const APPLICABILITY_FINDING_CODES = Object.freeze([
  'DECLARED_ISOLATION_UNAVAILABLE',
  'DECLARED_ISOLATION_PRECONDITION_UNMET',
  'UNDECLARED_ISOLATION_AVAILABLE',
  'UNKNOWN_ARM',
  'MISSING_ARM'
]);

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegistryError';
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function runtimeKindFor(armId, lockEntry) {
  if (armId === 'no-memory') return 'control';
  if (lockEntry.type === 'local-checkout') return 'node-mcp';
  if (lockEntry.type === 'pypi') return 'python-container';
  throw new RegistryError(`arm ${armId} has an unsupported lock type`);
}

/**
 * Build the registry from the competitor lock.
 *
 * The lock is the authority on which version of each arm runs. Every frozen arm
 * must appear in it, no extra arm may, and every Python arm must agree with the
 * executor spec that governs its packages and provider request classes - a
 * disagreement there means the lock and the harness would meter different
 * software.
 */
export function createV11Registry(options) {
  if (!isPlainObject(options)) throw new RegistryError('registry options must be an object');
  const { competitorLock, containerImage } = options;
  if (!isPlainObject(competitorLock) || !isPlainObject(competitorLock.arms)) {
    throw new RegistryError('competitor lock must declare an arms object');
  }
  if (typeof containerImage !== 'string' || !containerImage.includes('@sha256:')) {
    throw new RegistryError('registry requires a digest-pinned container image');
  }

  const lockedArmIds = Object.keys(competitorLock.arms);
  for (const armId of lockedArmIds) {
    if (!V11_ARM_IDS.includes(armId)) {
      throw new RegistryError(`competitor lock declares an arm outside the frozen set: ${armId}`);
    }
  }

  const descriptors = new Map();
  for (const armId of V11_ARM_IDS) {
    const lockEntry = competitorLock.arms[armId];
    if (!isPlainObject(lockEntry)) {
      throw new RegistryError(`competitor lock is missing frozen arm ${armId}`);
    }
    const kind = runtimeKindFor(armId, lockEntry);
    const spec = PYTHON_ADAPTER_SPECS[armId] ?? null;

    if (kind === 'python-container') {
      if (spec === null) {
        throw new RegistryError(`arm ${armId} has no Python adapter spec`);
      }
      // The lock and the executor spec must agree on the pinned version, or the
      // harness would meter software the lock does not describe.
      const specVersion = spec.packages[lockEntry.package];
      if (specVersion !== lockEntry.version) {
        throw new RegistryError(
          `arm ${armId} version disagrees between the competitor lock and its adapter spec`
        );
      }
    } else if (spec !== null) {
      throw new RegistryError(`arm ${armId} must not carry a Python adapter spec`);
    }

    descriptors.set(armId, Object.freeze({
      armId,
      kind,
      lockType: lockEntry.type,
      version: lockEntry.version ?? null,
      mode: lockEntry.mode ?? null,
      packages: spec === null ? Object.freeze({}) : spec.packages,
      requestClasses: spec === null ? Object.freeze([]) : spec.requestClasses,
      containerImage: kind === 'python-container' ? containerImage : null,
      requiredService: lockEntry.requiredService ?? null,
      isolation: NATIVE_ISOLATION[armId]
    }));
  }

  function descriptorFor(armId) {
    const descriptor = descriptors.get(armId);
    if (descriptor === undefined) throw new RegistryError(`unknown arm: ${armId}`);
    return descriptor;
  }

  /**
   * Compare a declared applicability matrix against observed native isolation.
   *
   * Returns findings; it does not rewrite the matrix. A declared entry that the
   * product cannot support is a methodology problem, and a capability the
   * product has but the matrix omits is an adapter problem. Naming which is
   * which is the whole point of this check.
   */
  function verifyApplicability(declared, satisfiedPreconditions = []) {
    if (!isPlainObject(declared)) throw new RegistryError('declared applicability must be an object');
    const satisfied = new Set(satisfiedPreconditions);
    const findings = [];

    for (const armId of Object.keys(declared)) {
      if (!V11_ARM_IDS.includes(armId)) {
        findings.push({ code: 'UNKNOWN_ARM', armId });
      }
    }

    for (const armId of V11_ARM_IDS) {
      const entry = declared[armId];
      if (!isPlainObject(entry) || !isPlainObject(entry.userIsolation)) {
        findings.push({ code: 'MISSING_ARM', armId });
        continue;
      }
      const isolation = NATIVE_ISOLATION[armId];
      const declaredSupported = entry.userIsolation.status === 'SUPPORTED';

      if (declaredSupported && isolation.userNamespace === null) {
        findings.push({
          code: 'DECLARED_ISOLATION_UNAVAILABLE',
          armId,
          declared: 'SUPPORTED',
          observed: 'no native user namespace',
          note: isolation.note
        });
        continue;
      }
      if (declaredSupported
        && isolation.userNamespacePrecondition !== null
        && !satisfied.has(isolation.userNamespacePrecondition)) {
        findings.push({
          code: 'DECLARED_ISOLATION_PRECONDITION_UNMET',
          armId,
          precondition: isolation.userNamespacePrecondition
        });
        continue;
      }
      if (!declaredSupported && isolation.userNamespace !== null) {
        findings.push({
          code: 'UNDECLARED_ISOLATION_AVAILABLE',
          armId,
          observed: isolation.userNamespace
        });
      }
    }

    return Object.freeze({
      status: findings.length === 0 ? 'CONSISTENT' : 'INCONSISTENT',
      findings: Object.freeze(findings)
    });
  }

  /**
   * Count the units a matrix implies, so expected counts are derived from the
   * matrix in force rather than restated as literals.
   */
  function expectedCounts({ scenarios, repetitions, phases, declared }) {
    if (!Number.isSafeInteger(scenarios) || scenarios <= 0) {
      throw new RegistryError('scenarios must be a positive safe integer');
    }
    if (!Number.isSafeInteger(repetitions) || repetitions <= 0) {
      throw new RegistryError('repetitions must be a positive safe integer');
    }
    if (!Array.isArray(phases) || phases.length === 0) {
      throw new RegistryError('phases must be a non-empty array');
    }
    if (!isPlainObject(declared)) throw new RegistryError('declared applicability must be an object');

    const perArm = scenarios * repetitions;
    const totalUnits = perArm * phases.length * V11_ARM_IDS.length;
    const excludedArms = V11_ARM_IDS.filter((armId) => (
      isExcludedFromUserIsolation(declared[armId])
    ));
    const excludedUnits = phases.includes('ISOLATION_USER') ? excludedArms.length * perArm : 0;
    const measuredUnits = totalUnits - excludedUnits;
    const resetUnits = phases.includes('RESET') ? V11_ARM_IDS.length * perArm : 0;
    return Object.freeze({
      totalUnits,
      excludedUnits,
      measuredUnits,
      resetUnits,
      outerDecisionCalls: measuredUnits - resetUnits
    });
  }

  return Object.freeze({
    armIds: V11_ARM_IDS,
    descriptorFor,
    descriptors: Object.freeze([...descriptors.values()]),
    verifyApplicability,
    expectedCounts
  });
}
