// Internal one-shot supervisor, forked over private IPC. Bootstrap carries only
// content-free identity/path; a later request authorizes the host after its
// running marker is durable. Parent death before that request is provably inert.
import { runBounded } from '../extractor.js';
import { isAbsolute } from 'node:path';
import { repositoryOf, writeJsonAtomically } from './owner-files.js';
const [invocationId, settlement] = process.argv.slice(2);
const controller = new AbortController(); let running = false, ending = false;
const validated = (async () => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invocationId ?? '')
    || typeof settlement !== 'string' || !isAbsolute(settlement) || await repositoryOf(settlement)) throw new Error('invalid_supervisor_bootstrap');
})();
const proof = localChildStopped => writeJsonAtomically(settlement, { version: 1, invocationId, localChildStopped });
async function settleUnused() {
  if (ending) return; ending = true; clearTimeout(startup);
  try { await validated; await proof(true); } catch { /* Missing proof remains fail closed. */ }
  if (process.connected) process.disconnect();
  process.exit(0);
}
const abort = () => { controller.abort(); if (!running) void settleUnused(); };
const startup = setTimeout(abort, 10000);
process.on('disconnect', abort); process.on('SIGTERM', abort); process.on('SIGINT', abort);
process.on('message', async message => {
  if (message?.abort) { abort(); return; }
  if (running || ending || !message?.request || message.invocationId !== invocationId || message.settlement !== settlement) return;
  running = true; clearTimeout(startup);
  let result;
  try {
    await validated;
    result = await runBounded({ ...message.request, signal: controller.signal });
    await proof(result.localChildStopped === true);
  } catch { result = { code: null, failure: 'supervisor_unavailable', processStarted: true, localChildStopped: false, outputBytes: 0, stdout: '', stderr: '' }; }
  if (process.connected) process.send({ invocationId, result }, () => { if (process.connected) process.disconnect(); });
});
void validated.then(() => {
  if (process.connected && !controller.signal.aborted) process.send({ ready: true }); else abort();
}, abort);
