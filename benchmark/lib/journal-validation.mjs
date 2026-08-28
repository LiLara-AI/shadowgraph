import {
  NODE_SQLITE_MINIMUM_VERSION,
  NODE_SQLITE_NOT_APPLICABLE_REASON
} from '../../src/runtime-capabilities.js';

function isStableSupportedNodeBeforeSqlite(nodeVersion) {
  if (typeof nodeVersion !== 'string') return false;
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(nodeVersion);
  if (!match) return false;
  const version = match.slice(1).map(Number);
  const minimum = NODE_SQLITE_MINIMUM_VERSION.split('.').map(Number);
  if (version[0] < 20) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] !== minimum[index]) return version[index] < minimum[index];
  }
  return false;
}

export function validateJournalBenchmark(output) {
  const errors = [];
  if (output?.schemaVersion !== 2) errors.push('schemaVersion must be 2');
  if (!Array.isArray(output?.requestedSizes) || !Array.isArray(output?.results)) errors.push('requestedSizes and results must be arrays');
  const results = Array.isArray(output?.results) ? output.results : [];
  const requestedSizes = Array.isArray(output?.requestedSizes) ? output.requestedSizes : [];
  if (results.length !== requestedSizes.length) errors.push('every requested size must have exactly one result');
  for (const requested of requestedSizes) {
    const matches = results.filter((result) => result.requestedEntries === requested);
    if (matches.length !== 1) {
      errors.push(`requested size ${requested} has ${matches.length} results`);
      continue;
    }
    const result = matches[0];
    if (result.status !== 'MEASURED') {
      errors.push(`requested size ${requested} is ${result.status ?? 'missing status'}`);
      continue;
    }
    if (result.actualEntries !== requested) errors.push(`requested size ${requested} produced ${result.actualEntries} entries`);
    if (result.validation?.requestedCountSatisfied !== true) errors.push(`requested size ${requested} did not validate its count`);
    if (result.validation?.rebuildEquivalent !== true) errors.push(`requested size ${requested} rebuild was not equivalent`);
    for (const backendName of ['json', 'sqlite']) {
      const backend = result.backends?.[backendName];
      if (backendName === 'sqlite' && backend?.status === 'NOT_APPLICABLE') {
        if (!isStableSupportedNodeBeforeSqlite(output?.environment?.node)) {
          errors.push(`sqlite at ${requested} may be NOT_APPLICABLE only on stable supported Node versions before ${NODE_SQLITE_MINIMUM_VERSION}`);
        }
        if (backend.reason !== NODE_SQLITE_NOT_APPLICABLE_REASON) errors.push(`sqlite at ${requested} has an invalid NOT_APPLICABLE reason`);
        continue;
      }
      if (backend?.status !== 'MEASURED') {
        errors.push(`${backendName} at ${requested} was not measured`);
        continue;
      }
      if (backend.actualEntries !== result.actualEntries) errors.push(`${backendName} at ${requested} changed the journal count`);
      if (backend.roundTripEquivalent !== true) errors.push(`${backendName} at ${requested} did not round-trip equivalently`);
    }
  }
  return {
    valid: errors.length === 0,
    requestedSizeCount: requestedSizes.length,
    measuredSizeCount: results.filter((result) => result.status === 'MEASURED').length,
    errors
  };
}
