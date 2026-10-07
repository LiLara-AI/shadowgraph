// Fresh, read-only configuration projection. It never probes the host or
// promises model/service health. A stored error additionally makes it unavailable.
import { activeCapture } from '../capture-hook.js';
import { activeExtraction, workerSettlement } from './extraction-state.js';
import { storeIo } from './deletion-knowledge.js';
import { canonicalPath } from './owner-files.js';
export async function readExtractionAvailability({ file, storage = 'json', env = process.env, store } = {}) {
  const unavailable = Object.assign(() => false, { active: false });
  try {
    if (store) { const io = storeIo(store); file = io.file; env = io.env ?? env; }
    const extraction = await activeExtraction(env);
    if (!extraction || typeof file !== 'string' || await canonicalPath(file) !== extraction.store.file || storage !== extraction.store.storage) return unavailable;
    const capture = await activeCapture(env);
    if (!capture) return unavailable;
    const ready = await workerSettlement(env) === 'clear';
    return Object.assign(scope => ready && scope.state === 'project_selected'
      ? capture.coverage.projects === 'only' ? capture.coverage.include.includes(scope.project) : !capture.coverage.exclude.includes(scope.project)
      : false, { active: true });
  } catch { return unavailable; }
}
