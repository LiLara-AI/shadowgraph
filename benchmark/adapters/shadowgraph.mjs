import {
  validateAdapterRequest
} from '../lib/adapter-protocol.mjs';
import {
  AdapterHostError,
  adapterEnvelope,
  classifyHostError,
  emptyOperations,
  failedEnvelope,
  measureStateLeaf,
  poisonStateLeaf,
  requireStateLeaf,
  resetStateLeaf,
  withMcpSession
} from '../lib/node-adapter-host.mjs';
import { canonicalJson, recordContentSha256 } from '../lib/v11-contract.mjs';

const ENCODING_PREFIX = 'shadowgraph-benchmark-record:v1:';
const PAGE_LIMIT = 1000;
const MAX_PAGES = 10_000;
const ARM_FOR_MODE = Object.freeze({
  full: 'shadowgraph-full',
  compact: 'shadowgraph-compact'
});

function unavailableStorage(reason) {
  return {
    status: 'NOT_AVAILABLE',
    bytes: null,
    scope: 'ShadowGraph product state leaf',
    method: null,
    reason,
    blockedClaims: ['storage bytes', 'persistence verification', 'isolation verification']
  };
}

function encodeContent(content) {
  return `${ENCODING_PREFIX}${Buffer.from(canonicalJson(content), 'utf8').toString('base64url')}`;
}

function decodeContent(value) {
  if (typeof value !== 'string' || !value.startsWith(ENCODING_PREFIX)) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Native record does not contain benchmark-owned encoded content');
  }
  const encoded = value.slice(ENCODING_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Native benchmark record encoding is malformed');
  }
  let content;
  let serialized;
  try {
    serialized = Buffer.from(encoded, 'base64url').toString('utf8');
    content = JSON.parse(serialized);
  } catch (error) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Native benchmark record content is malformed', { cause: error });
  }
  if (canonicalJson(content) !== serialized || encodeContent(content) !== value) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Native benchmark record content is not canonical');
  }
  return content;
}

function assertNativePage(result, { project, kind, offset }) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || !Array.isArray(result.items) || !result.page || !result.completeness) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph search returned an invalid page');
  }
  const { page, completeness } = result;
  if (!Number.isSafeInteger(page.offset) || page.offset !== offset
    || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > PAGE_LIMIT
    || !Number.isSafeInteger(page.total) || page.total < 0
    || typeof page.hasMore !== 'boolean'
    || completeness.losslessItems !== true
    || completeness.total !== page.total
    || completeness.returned !== result.items.length) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph search completeness evidence is invalid');
  }
  for (const item of result.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || !item.record || item.record.project !== project || item.record.kind !== kind) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph search crossed the exact project or kind boundary');
    }
  }
}

async function searchAll(client, { project, kind, query = '' }, operations, counterField) {
  const records = [];
  const seen = new Set();
  let offset = 0;
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    operations[counterField] += 1;
    operations.mcpToolCalls += 1;
    const page = await client.callTool('shadowgraph_search', {
      query,
      project,
      kind,
      offset,
      limit: PAGE_LIMIT
    });
    assertNativePage(page, { project, kind, offset });
    for (const item of page.items) {
      const id = item.record.id;
      if (typeof id !== 'string' || !id || seen.has(id)) {
        throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph search returned a duplicate or invalid native id');
      }
      seen.add(id);
      records.push(item.record);
    }
    if (!page.page.hasMore) {
      if (records.length !== page.page.total) {
        throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph search ended before its declared total');
      }
      return records;
    }
    if (page.items.length === 0) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph search pagination made no progress');
    }
    offset += page.items.length;
  }
  throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph search exceeded the bounded page count');
}

function nativeKind(recordType) {
  if (recordType === 'decision') return 'decision';
  if (recordType === 'failed_attempt') return 'attempt';
  throw new AdapterHostError('CONTRACT_FAILURE', 'Unsupported benchmark record type');
}

function decodeNativeRecord(record) {
  if (record.kind === 'decision') {
    return { id: record.id, type: 'decision', content: decodeContent(record.goal) };
  }
  if (record.kind === 'attempt') {
    return { id: record.id, type: 'failed_attempt', content: decodeContent(record.reason) };
  }
  throw new AdapterHostError('CONTRACT_FAILURE', 'Unsupported native ShadowGraph record kind');
}

function exactScenarioRecord(record, scenarioId) {
  return record.kind === 'decision'
    ? record.title === scenarioId
    : record.environment === scenarioId;
}

function decisionArguments(request) {
  const { record } = request.payload;
  const content = record.content;
  const alternatives = content.recalledAlternativeIds.map((label, index) => ({
    id: `${record.id}:alternative:${index}`,
    label: label.trim() || `remembered-alternative-${index}`,
    reasonRejected: content.recalledRejectionReasonIds[index] ?? ''
  }));
  return {
    id: record.id,
    title: request.scenarioId,
    chosen: content.recommendation.trim() || content.choiceId?.trim() || 'recorded-benchmark-decision',
    project: request.namespace.projectId,
    goal: encodeContent(content),
    alternatives
  };
}

function attemptArguments(request) {
  const { record } = request.payload;
  return {
    id: record.id,
    solution: record.content.approachId,
    result: 'failed',
    project: request.namespace.projectId,
    reason: encodeContent(record.content),
    environment: request.scenarioId
  };
}

async function retrieveOperation(client, request, operations) {
  const nativeRecords = [];
  for (const kind of ['decision', 'attempt']) {
    const records = await searchAll(client, {
      project: request.namespace.projectId,
      kind,
      query: request.scenarioId
    }, operations, 'memoryReadOperations');
    nativeRecords.push(...records.filter((record) => exactScenarioRecord(record, request.scenarioId)));
  }
  return nativeRecords
    .map(decodeNativeRecord)
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function persistOperation(client, request, operations) {
  operations.memoryWriteOperations += 1;
  operations.mcpToolCalls += 1;
  const tool = request.payload.record.type === 'decision'
    ? 'shadowgraph_record_decision'
    : 'shadowgraph_record_attempt';
  const args = request.payload.record.type === 'decision'
    ? decisionArguments(request)
    : attemptArguments(request);
  const recorded = await client.callTool(tool, args, {
    ambiguousOnInvalidResponse: true,
    commitRisk: true
  });
  if (!recorded || recorded.id !== request.payload.record.id || recorded.kind !== nativeKind(request.payload.record.type)) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph persist response did not identify the exact native record', {
      ambiguous: true
    });
  }
}

async function recordsForReference(client, project, reference, operations) {
  return searchAll(client, {
    project,
    kind: nativeKind(reference.type),
    query: ''
  }, operations, 'persistenceVerificationOperations');
}

function safelyDecodedHash(record) {
  return recordContentSha256(decodeNativeRecord(record).content);
}

async function verifyOperation(client, request, operations) {
  const expected = request.payload.expectedRecord;
  const primaryRecords = await recordsForReference(
    client,
    request.namespace.projectId,
    expected,
    operations
  );
  const idMatches = primaryRecords.filter(({ id }) => id === expected.id);
  const observedContentSha256 = idMatches.length === 1 ? safelyDecodedHash(idMatches[0]) : null;
  const persistenceEvidence = {
    verified: idMatches.length === 1 && observedContentSha256 === expected.contentSha256,
    expectedRecord: expected,
    matchedRecordIds: idMatches.map(({ id }) => id),
    observedContentSha256,
    namespaceRef: request.namespaceRef
  };

  let isolationEvidence = null;
  if (request.payload.alternateNamespace !== null) {
    const absent = request.payload.expectedAbsentRecord;
    const alternateRecords = await recordsForReference(
      client,
      request.payload.alternateNamespace.projectId,
      absent,
      operations
    );
    let matchingContentCount = 0;
    for (const record of alternateRecords) {
      if (safelyDecodedHash(record) === absent.contentSha256) matchingContentCount += 1;
    }
    isolationEvidence = {
      verified: alternateRecords.every(({ id }) => id !== absent.id) && matchingContentCount === 0,
      expectedAbsentRecord: absent,
      alternateNamespaceRef: request.payload.alternateNamespaceRef,
      matchingRecordIdCount: alternateRecords.filter(({ id }) => id === absent.id).length,
      matchingContentCount
    };
  }
  return { persistenceEvidence, isolationEvidence };
}

function assertSupportedNamespace(request) {
  if (typeof request.namespace.projectId !== 'string' || !request.namespace.projectId.trim()) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph benchmark adapter requires a native project namespace');
  }
  if (request.namespace.userId !== null) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph benchmark adapter does not support user namespaces');
  }
  if (request.payload.alternateNamespace?.userId !== null
    && request.payload.alternateNamespace?.userId !== undefined) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph benchmark adapter does not support alternate user namespaces');
  }
  if (request.payload.alternateNamespace !== null && request.payload.alternateNamespace !== undefined
    && (typeof request.payload.alternateNamespace.projectId !== 'string'
      || !request.payload.alternateNamespace.projectId.trim())) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph isolation requires an alternate native project namespace');
  }
}

function assertConfiguredMode(request, mode) {
  if (!Object.hasOwn(ARM_FOR_MODE, mode)) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph benchmark adapter requires an explicit full or compact mode');
  }
  if (request.armId !== ARM_FOR_MODE[mode]) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'ShadowGraph benchmark arm does not match the configured MCP mode');
  }
}

async function storageAfter(paths) {
  try {
    return await measureStateLeaf(paths.leaf);
  } catch {
    return unavailableStorage('Product state size could not be measured after the operation');
  }
}

export function createShadowGraphAdapter({
  stateRoot,
  backend = 'json',
  mode,
  timeoutMs,
  mcpEntry
} = {}) {
  async function execute(request, { signal } = {}) {
    validateAdapterRequest(request);
    try {
      assertConfiguredMode(request, mode);
      assertSupportedNamespace(request);
    } catch (error) {
      return failedEnvelope(
        request,
        error,
        unavailableStorage('No product state leaf was opened for the rejected namespace')
      );
    }
    if (signal?.aborted) {
      return failedEnvelope(
        request,
        new AdapterHostError('OPERATOR_INTERRUPTION', 'Adapter operation was interrupted'),
        unavailableStorage('No product state leaf was opened for the interrupted operation')
      );
    }

    let paths;
    const operations = emptyOperations();
    try {
      paths = request.operation === 'reset'
        ? await resetStateLeaf({ stateRoot, backend, request })
        : await requireStateLeaf({ stateRoot, backend, request });
      if (request.operation === 'reset') {
        return adapterEnvelope(request, {
          operations,
          storage: await measureStateLeaf(paths.leaf)
        });
      }

      let result = { nativeContext: [], persistenceEvidence: null, isolationEvidence: null };
      try {
        await withMcpSession({
          file: paths.file,
          storage: backend,
          compact: mode === 'compact',
          signal,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(mcpEntry === undefined ? {} : { entryPath: mcpEntry })
        }, async (client) => {
          if (request.operation === 'retrieve') {
            result = { ...result, nativeContext: await retrieveOperation(client, request, operations) };
          } else if (request.operation === 'persist') {
            await persistOperation(client, request, operations);
          } else if (request.operation === 'verify') {
            result = { ...result, ...await verifyOperation(client, request, operations) };
          }
        });
      } catch (error) {
        if (request.operation === 'persist' && error?.ambiguous === true) {
          try {
            await poisonStateLeaf(paths);
          } catch {
            // The host sets an in-memory latch before durable marking; retain the original commit-risk failure.
          }
        }
        throw error;
      }

      const storage = await measureStateLeaf(paths.leaf);
      if (request.operation === 'verify') {
        const successful = result.persistenceEvidence?.verified === true
          && (result.isolationEvidence === null || result.isolationEvidence.verified === true);
        if (!successful) {
          return adapterEnvelope(request, {
            status: 'FAILED',
            result,
            failure: { cause: 'OPERATION_FAILED', message: 'Native persistence or isolation verification failed' },
            operations,
            storage
          });
        }
      }
      return adapterEnvelope(request, { result, operations, storage });
    } catch (error) {
      const classified = classifyHostError(error, { signal, ambiguous: error?.ambiguous === true });
      const storage = paths
        ? await storageAfter(paths)
        : unavailableStorage('No product state leaf was available for measurement');
      return failedEnvelope(request, classified, storage, operations);
    }
  }

  return Object.freeze({ execute });
}

export function createShadowGraphFullAdapter(options = {}) {
  return createShadowGraphAdapter({ ...options, mode: 'full' });
}

export function createShadowGraphCompactAdapter(options = {}) {
  return createShadowGraphAdapter({ ...options, mode: 'compact' });
}

const configuredAdapter = createShadowGraphAdapter({
  stateRoot: process.env.SHADOWGRAPH_BENCHMARK_STATE_ROOT,
  backend: process.env.SHADOWGRAPH_BENCHMARK_STORAGE ?? 'json',
  mode: process.env.SHADOWGRAPH_BENCHMARK_MODE
});

export const execute = configuredAdapter.execute;
export default configuredAdapter;
