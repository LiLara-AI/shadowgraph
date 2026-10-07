// A bounded child supervisor survives a worker's death long enough to stop
// its own child and write content-free settlement proof. It is never a daemon.
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { workerFenceFile, settlementFile } from './extraction-state.js';
import { writeJsonAtomically } from './owner-files.js';
export async function runSupervised(request, { env, activationId }) {
  const invocationId = randomUUID();
  return new Promise(resolve => {
    let child, done = false, response = null, started = false, terminalTimer;
    const failed = () => ({ code: null, failure: 'supervisor_unavailable', processStarted: started, localChildStopped: false, outputBytes: 0, stdout: '', stderr: '' });
    const finish = result => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(terminalTimer); request.signal?.removeEventListener('abort', abort);
      if (child?.connected) child.disconnect(); child?.unref(); resolve(result);
    };
    const abort = () => {
      if (done) return;
      if (child?.connected) child.send({ abort: true }, () => {});
      terminalTimer ??= setTimeout(() => finish(failed()), 2000);
    };
    const timer = setTimeout(abort, Math.min(Math.max(request.timeoutMs ?? 10000, 1), 120000) + 3000);
    if (request.signal?.aborted) { finish({ ...failed(), failure: 'aborted', localChildStopped: true }); return; }
    request.signal?.addEventListener('abort', abort, { once: true });
    try {
      child = fork(new URL('./extraction-child.js', import.meta.url), [invocationId, settlementFile(env)], { cwd: request.cwd, env: request.env, execArgv: [], detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('error', () => finish(failed()));
      child.once('exit', () => finish(response ?? failed()));
      child.on('message', message => {
        if (done) return;
        if (message?.ready === true && !started) {
          started = true;
          void (async () => {
            // Persist identity BEFORE the supervisor receives permission/input.
            await writeJsonAtomically(workerFenceFile(env), { version: 1, state: 'running', activationId, pid: process.pid, supervisorPid: child.pid, invocationId, at: new Date().toISOString() });
            if (done || request.signal?.aborted) { abort(); return; }
            const { executable, args, cwd, env: childEnv, input, timeoutMs, maxOutputBytes } = request;
            child.send({ invocationId, settlement: settlementFile(env), request: { executable, args, cwd, env: childEnv, input, timeoutMs, maxOutputBytes } }, error => { if (error) abort(); });
          })().catch(abort);
        } else if (message?.invocationId === invocationId && message.result) response = message.result;
      });
    } catch { finish(failed()); }
  });
}
