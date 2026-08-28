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
