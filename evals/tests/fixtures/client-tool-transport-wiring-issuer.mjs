import fs from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { describeTransportIdentity } from '../../harness/tool-worker/identity.mjs';
import {
  coordinates, declarations, exact, hashJson, limits, sha256, FLAGS, TOOL_PROTOCOL, ToolWorkerError
} from '../../harness/tool-worker/worker.mjs';

const shimSource = fs.readFileSync(new URL('../../harness/tool-worker/mcp-shim.mjs', import.meta.url), 'utf8');
const workerSource = fs.readFileSync(new URL('../../harness/tool-worker/worker.mjs', import.meta.url), 'utf8');
function freeze(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// This private registry substitutes Docker issuance for client wiring tests only.
// It cannot issue authority in the real tool-worker module or establish native evidence.
export function createWiringOnlyIssuer() {
  const registry = { tasks: new WeakMap(), workers: new WeakMap(), leases: new WeakMap(), bindings: new WeakMap() };
  const stateFor = tuple => registry.workers.get(tuple.worker);
  return {
    issue(payload, overrides = {}) {
      const taskCoordinates = coordinates(Object.fromEntries(
        ['invocationId', 'caseId', 'client', 'arm', 'repeat'].map(key => [key, payload.task[key]])));
      const caps = limits();
      const normalized = filename => filename.replaceAll('\\', '/');
      const selected = declarations([
        ...payload.skill.files.map(file => ({
          path: `skills/${payload.skill.id}/${normalized(file.path)}`, content: file.content
        })),
        ...(payload.inputs ?? []).map(file => ({ path: `inputs/${normalized(file.path)}`, content: file.content }))
      ], payload.artifactTargets.map(target => `artifacts/${normalized(target)}`), caps);
      const taskHash = hashJson(taskCoordinates);
      const sourceHash = overrides.sourceHash ?? hashJson(selected.files.map(({ path, bytes, sha256 }) =>
        ({ path, bytes, sha256 })));
      const task = freeze({ kind: 'tool-worker-task', coordinates: taskCoordinates });
      const worker = freeze({ kind: 'tool-worker', protocol: TOOL_PROTOCOL });
      const lease = freeze({ kind: 'tool-worker-transport-lease', protocol: TOOL_PROTOCOL });
      const deadline = Date.now() + caps.timeoutMs;
      const transportPolicy = {
        deadlineUnixMs: deadline, requests: caps.requests, requestBytes: caps.requestBytes,
        totalRequestBytes: caps.totalRequestBytes, outputBytes: caps.outputBytes
      };
      const binding = freeze({
        kind: 'tool-worker-transport-binding', protocol: TOOL_PROTOCOL, taskHash, sourceHash,
        workerProgramHash: overrides.workerProgramHash ?? sha256(workerSource),
        shimHash: overrides.shimHash ?? sha256(shimSource),
        transportMount: { type: 'volume', source: `eval-tool-socket-${randomUUID()}`,
          target: '/tool-rpc', readOnly: true, noCopy: true },
        socketPath: '/tool-rpc/worker.sock', supplementalGid: 21000, transportPolicy,
        supportedIdentityLayouts: [{ uid: 1000, gid: 1000 }, { uid: 10001, gid: 10001 }],
        stdioCommand: ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'TMPDIR=/scratch',
          'LANG=C.UTF-8', '/usr/local/bin/node', '--input-type=module', '--eval', shimSource,
          '--', '--eval-tool-mcp-shim', randomBytes(32).toString('hex'), JSON.stringify(transportPolicy)],
        ...FLAGS
      });
      const state = { task, taskHash, taskCoordinates, sourceHash, selected, caps, deadline,
        lifecycle: 'ready', lease, binding, runController: new AbortController() };
      registry.tasks.set(task, { coordinates: taskCoordinates, hash: taskHash });
      registry.workers.set(worker, state);
      registry.leases.set(lease, { state, task, worker });
      registry.bindings.set(binding, { state, lease });
      return { task, worker, lease, binding };
    },
    describe(tuple) {
      exact(tuple, ['task', 'worker', 'lease', 'binding']);
      return describeTransportIdentity(registry, tuple);
    },
    cancel(tuple) {
      const state = stateFor(tuple);
      state.runController.abort();
      state.terminalError = new ToolWorkerError('CANCELLED');
    },
    close(tuple) { stateFor(tuple).lifecycle = 'closed'; },
    expire(tuple) { stateFor(tuple).deadline = Date.now() - 1; },
    closing(tuple) { stateFor(tuple).cleanupPromise = Promise.resolve(); },
    abort(tuple) { stateFor(tuple).runController.abort(); }
  };
}
