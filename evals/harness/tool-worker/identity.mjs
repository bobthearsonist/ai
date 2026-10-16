import { ToolWorkerError, insist, hashJson, FLAGS, TOOL_PROTOCOL } from './worker.mjs';

export function originalTransportState(registry, tuple, { requireBinding = true } = {}) {
  const task = registry.tasks.get(tuple.task);
  insist(task, 'ORIGINAL_TASK_REQUIRED');
  const state = registry.workers.get(tuple.worker);
  insist(state && state.task === tuple.task && state.taskHash === task.hash, 'ORIGINAL_WORKER_SCOPE_REQUIRED');
  const lease = registry.leases.get(tuple.lease);
  insist(lease?.state === state && lease.task === tuple.task && lease.worker === tuple.worker &&
    state.lease === tuple.lease, 'ORIGINAL_TRANSPORT_LEASE_REQUIRED');
  if (requireBinding) {
    const binding = registry.bindings.get(tuple.binding);
    insist(binding?.state === state && binding.lease === tuple.lease && state.binding === tuple.binding,
      'ORIGINAL_TRANSPORT_BINDING_REQUIRED');
  }
  return state;
}

export function describeTransportIdentity(registry, tuple) {
  const state = originalTransportState(registry, tuple);
  if (state.terminalError) throw new ToolWorkerError(state.terminalError.code ?? 'WORKER_CLOSED');
  insist(state.lifecycle === 'ready' && !state.cleanupPromise &&
    !state.runController?.signal.aborted, 'WORKER_NOT_READY');
  insist(Number.isSafeInteger(state.deadline) && Date.now() < state.deadline, 'TIMEOUT');
  return {
    kind: 'tool-worker-transport-description', protocol: TOOL_PROTOCOL,
    task: { ...state.taskCoordinates }, taskHash: state.taskHash, sourceHash: state.sourceHash,
    publicFiles: state.selected.files.map(item => ({ path: item.path, bytes: item.bytes, sha256: item.sha256 })),
    artifactTargets: [...state.selected.targets], limits: { ...state.caps },
    deadlineUnixMs: state.deadline, binding: tuple.binding,
    transportBindingHash: hashJson(tuple.binding), workerProgramHash: tuple.binding.workerProgramHash,
    shimHash: tuple.binding.shimHash, planningOnly: true, verification: 'cached-original-identity-only',
    freshKernelVerification: false, nativeAdmissionSupported: false, ...FLAGS
  };
}
