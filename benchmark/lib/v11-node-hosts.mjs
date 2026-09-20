// Runtime hosts for the arms that execute in this process tree.
//
// `createV11AdapterExecutor` routes each arm to `hosts[descriptor.kind]`, and
// two of the three kinds the registry assigns are local: the `control` arm,
// which holds no state, and the two `node-mcp` arms, which drive this
// repository's own MCP server. Both adapters already exist and are tested. What
// did not exist was this - the binding that hands them over keyed by runtime
// kind, without which a preflight can say READY and a run still has nowhere to
// send an arm.
//
// The binding is small, and that is the point: everything it could get wrong is
// a silent wrong answer rather than a crash. An arm attached to the wrong
// runtime, or an MCP arm attached to the wrong mode, would produce a complete
// run whose numbers describe a configuration nobody chose. So each host refuses
// a descriptor it does not recognise instead of doing something reasonable with
// it.
//
// `shadowgraph-full` and `shadowgraph-compact` deserve the specific attention
// they get here. They are the same product behind different tool surfaces and
// they differ by one descriptor field, so a binding that shared one adapter
// between them would measure one configuration twice and report it as two.

import path from 'node:path';

import { execute as executeNoMemory } from '../adapters/no-memory.mjs';
import { createShadowGraphAdapter } from '../adapters/shadowgraph.mjs';

/** The arm the control runtime may execute, and nothing else. */
export const CONTROL_ARM_ID = 'no-memory';

/** The MCP modes the registry can name, bound to the arm each belongs to. */
export const MCP_ARM_MODES = Object.freeze({
  'shadowgraph-full': 'full',
  'shadowgraph-compact': 'compact'
});

export class NodeHostError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NodeHostError';
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function requireDescriptor(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object' || !isNonEmptyString(descriptor.armId)) {
    throw new NodeHostError('a runtime host requires an arm descriptor');
  }
  return descriptor;
}

/**
 * Bind the local runtimes to the adapters that implement them.
 *
 * `stateRoot` is shared across the MCP arms deliberately. The state leaf a
 * request resolves to already includes the arm id, so two arms cannot collide
 * inside one root, and giving each arm its own root would put the same fact in
 * two places.
 */
export function createV11NodeHosts(options = {}) {
  const { stateRoot, backend = 'json', timeoutMs, mcpEntry } = options;

  if (!isNonEmptyString(stateRoot) || !path.isAbsolute(stateRoot)) {
    throw new NodeHostError('a mandatory absolute benchmark state root is required');
  }
  const resolvedRoot = path.resolve(stateRoot);
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    throw new NodeHostError('the benchmark state root must not be a filesystem root');
  }
  if (!['json', 'sqlite'].includes(backend)) {
    throw new NodeHostError('the ShadowGraph storage backend must be json or sqlite');
  }
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new NodeHostError('the adapter timeout must be a positive integer of milliseconds');
  }
  if (mcpEntry !== undefined && (!isNonEmptyString(mcpEntry) || !path.isAbsolute(mcpEntry))) {
    throw new NodeHostError('the MCP entry point must be an absolute path');
  }

  function controlHost(descriptor) {
    if (requireDescriptor(descriptor).armId !== CONTROL_ARM_ID) {
      throw new NodeHostError(
        `the control runtime executes only ${CONTROL_ARM_ID}, not ${descriptor.armId}`
      );
    }
    return executeNoMemory;
  }

  function mcpHost(descriptor) {
    const armId = requireDescriptor(descriptor).armId;
    const expected = MCP_ARM_MODES[armId];
    if (expected === undefined) {
      throw new NodeHostError(`the MCP runtime executes no arm named ${armId}`);
    }
    // The descriptor carries the mode and the arm, and they have to agree. A
    // descriptor whose mode contradicts its arm is a registry defect, and
    // resolving it here by preferring one field would hide it.
    if (descriptor.mode !== expected) {
      throw new NodeHostError(
        `arm ${armId} must be bound to MCP mode ${expected}, not ${JSON.stringify(descriptor.mode ?? null)}`
      );
    }
    return createShadowGraphAdapter({
      stateRoot: resolvedRoot,
      backend,
      mode: expected,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(mcpEntry === undefined ? {} : { mcpEntry })
    }).execute;
  }

  return Object.freeze({ control: controlHost, 'node-mcp': mcpHost });
}
