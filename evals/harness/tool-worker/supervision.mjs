import { spawn } from 'node:child_process';
import { ToolWorkerError, insist, lineReader, TOOL_PROTOCOL } from './worker.mjs';

export function attachSupervised(command, args, { cwd, env, deadline, signal, outputBytes, scope, onFailure }) {
  insist(Number.isFinite(deadline) && deadline > Date.now() &&
    Number.isSafeInteger(outputBytes) && outputBytes > 0, 'TIMEOUT_OR_INVALID_LIMIT');
  if (signal?.aborted) throw new ToolWorkerError('CANCELLED');
  const child = spawn(command, args, {
    cwd, env, shell: false, windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe']
  });
  let closed = false;
  let closing = false;
  let failure;
  let bytes = 0;
  let awaiting;
  let settleClose;
  const completion = new Promise(resolve => { settleClose = resolve; });
  function fail(code) {
    if (failure || closing) return;
    failure = new ToolWorkerError(code);
    awaiting?.reject(failure);
    awaiting = undefined;
    child.kill('SIGKILL');
    onFailure(failure);
  }
  const abort = () => fail('CANCELLED');
  const timer = setTimeout(() => fail('TIMEOUT'), Math.max(1, deadline - Date.now()));
  signal?.addEventListener('abort', abort, { once: true });
  child.once('error', () => fail('PROCESS_UNAVAILABLE'));
  child.once('close', (code, processSignal) => {
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (!closing) fail(code === 0 && !processSignal ? 'UNEXPECTED_PROCESS_EXIT' : 'PROCESS_FAILURE');
    settleClose();
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > outputBytes) fail('OUTPUT_LIMIT');
  });
  child.stderr.on('data', () => fail('WORKER_STDERR'));
  lineReader(child.stdout, () => Math.min(outputBytes, 262144), record => {
    insist(awaiting && record.protocol === TOOL_PROTOCOL && record.scope === scope &&
      record.sequence === awaiting.sequence && typeof record.ok === 'boolean' &&
      record.authenticationVerified === false && record.liveAccepted === false &&
      record.nativeDiscoveryVerified === false, 'INVALID_WORKER_RESPONSE');
    const pending = awaiting;
    awaiting = undefined;
    pending.resolve(record);
  }, error => fail(error.code));
  return {
    assertRunning() {
      if (failure) throw failure;
      insist(!closed && !closing && Date.now() < deadline, 'WORKER_NOT_RUNNING');
    },
    exchange(record, sequence) {
      this.assertRunning();
      insist(!awaiting, 'WORKER_BUSY');
      const result = new Promise((resolve, reject) => { awaiting = { sequence, resolve, reject }; });
      const line = `${JSON.stringify(record)}\n`;
      child.stdin.write(line, error => { if (error) fail('TRANSPORT_FAILURE'); });
      return result;
    },
    async stop() {
      closing = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      awaiting?.reject(failure ?? new ToolWorkerError('WORKER_CLOSED'));
      awaiting = undefined;
      if (!closed) child.kill('SIGKILL');
      let stopTimer;
      try {
        await Promise.race([
          completion,
          new Promise((_, reject) => {
            stopTimer = setTimeout(() => reject(new ToolWorkerError('PROCESS_STOP_UNVERIFIED')), 2000);
          })
        ]);
      } finally { clearTimeout(stopTimer); }
      insist(closed, 'PROCESS_STOP_UNVERIFIED');
      return { forced: true, processClosed: true, outputBytes: bytes };
    },
    get outputBytes() { return bytes; },
    get closed() { return closed; }
  };
}
