import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  assertToolWorkerTransportBinding, describeToolWorkerTransportBinding, ToolWorkerError
} from '../tool-worker/index.mjs';
import { deepFreeze, EgressBoundaryError, insist } from './errors.mjs';

const protocol = 'eval-filesystem-tools@1';
const workerProgramHash = '119405c7a0960654109e48b0c6f6b40250899e620cd0bde979595fb7dc67acbb';
const shimHash = 'ef3defc38eaf80b12a58de664a43c30cbcf4507ea26d627d66635219d0085198';
const socketDirectory = '/tool-rpc';
const socketPath = '/tool-rpc/worker.sock';
const supplementalGid = 21000;
const primaryUsers = Object.freeze({ 'claude-code': '1000:1000', copilot: '10001:10001', opencode: '1000:1000' });
const tupleKeys = Object.freeze(['task', 'worker', 'lease', 'binding']);
const digest = value => createHash('sha256').update(value).digest('hex');

function originalTuple(value) {
  insist(value && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === tupleKeys.length && tupleKeys.every(key =>
      Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')),
  'INVALID_ARGUMENT');
  const tuple = Object.fromEntries(tupleKeys.map(key => [key, value[key]]));
  insist(tupleKeys.every(key => tuple[key] !== null && typeof tuple[key] === 'object' &&
    !types.isProxy(tuple[key])), 'INVALID_ARGUMENT');
  return Object.freeze(tuple);
}

function transportFailure(error) {
  if (error instanceof EgressBoundaryError) return error;
  if (!(error instanceof ToolWorkerError)) return new EgressBoundaryError('TOOL_TRANSPORT_UNVERIFIED');
  const code = error.code === 'TIMEOUT' ? 'TOOL_TRANSPORT_EXPIRED'
    : error.code === 'CANCELLED' ? 'TOOL_TRANSPORT_CANCELLED'
      : ['WORKER_CLOSED', 'WORKER_NOT_READY', 'WORKER_CLOSING', 'WORKER_NOT_RUNNING',
        'CLEANUP_FAILED'].includes(error.code) ? 'TOOL_TRANSPORT_CLOSED'
        : ['ORIGINAL_TASK_REQUIRED', 'ORIGINAL_WORKER_SCOPE_REQUIRED',
          'ORIGINAL_TRANSPORT_LEASE_REQUIRED', 'ORIGINAL_TRANSPORT_BINDING_REQUIRED'].includes(error.code)
          ? 'TOOL_TRANSPORT_UNTRUSTED' : 'TOOL_TRANSPORT_UNVERIFIED';
  return new EgressBoundaryError(code);
}

function identity(tuple, client) {
  let description;
  try { description = describeToolWorkerTransportBinding(tuple); }
  catch (error) { throw transportFailure(error); }
  insist(description.task?.client === client && primaryUsers[client], 'TOOL_TRANSPORT_SCOPE_MISMATCH');
  insist(Number.isSafeInteger(description.deadlineUnixMs) && Date.now() < description.deadlineUnixMs,
    'TOOL_TRANSPORT_EXPIRED');
  const binding = tuple.binding;
  const policy = {
    deadlineUnixMs: description.deadlineUnixMs, requests: description.limits.requests,
    requestBytes: description.limits.requestBytes, totalRequestBytes: description.limits.totalRequestBytes,
    outputBytes: description.limits.outputBytes
  };
  insist(description.kind === 'tool-worker-transport-description' && description.protocol === protocol &&
    description.binding === binding && Object.isFrozen(binding) &&
    binding.kind === 'tool-worker-transport-binding' && binding.protocol === protocol &&
    binding.taskHash === description.taskHash && binding.sourceHash === description.sourceHash &&
    digest(JSON.stringify(description.task)) === description.taskHash &&
    digest(JSON.stringify(binding)) === description.transportBindingHash &&
    description.workerProgramHash === workerProgramHash && binding.workerProgramHash === workerProgramHash &&
    description.shimHash === shimHash && binding.shimHash === shimHash &&
    description.planningOnly === true && description.verification === 'cached-original-identity-only' &&
    description.freshKernelVerification === false && description.nativeAdmissionSupported === false &&
    description.evidenceScope === 'worker-filesystem-only' &&
    description.authenticationVerified === false && description.nativeDiscoveryVerified === false &&
    description.liveAccepted === false &&
    binding.evidenceScope === 'worker-filesystem-only' && binding.authenticationVerified === false &&
    binding.nativeDiscoveryVerified === false && binding.liveAccepted === false &&
    JSON.stringify(binding.transportPolicy) === JSON.stringify(policy) &&
    Object.isFrozen(binding.transportPolicy) && Object.isFrozen(binding.transportMount) &&
    binding.socketPath === socketPath && binding.supplementalGid === supplementalGid &&
    JSON.stringify(binding.supportedIdentityLayouts) === '[{"uid":1000,"gid":1000},{"uid":10001,"gid":10001}]' &&
    binding.transportMount.type === 'volume' && binding.transportMount.target === socketDirectory &&
    binding.transportMount.readOnly === true && binding.transportMount.noCopy === true &&
    /^eval-tool-socket-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(binding.transportMount.source),
  'TOOL_TRANSPORT_PIN_MISMATCH');
  const argv = binding.stdioCommand;
  insist(Object.isFrozen(argv) && argv.length === 13 &&
    JSON.stringify(argv.slice(0, 8)) === JSON.stringify([
      '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'TMPDIR=/scratch',
      'LANG=C.UTF-8', '/usr/local/bin/node', '--input-type=module', '--eval'
    ]) && typeof argv[8] === 'string' && digest(argv[8]) === shimHash &&
    argv[9] === '--' && argv[10] === '--eval-tool-mcp-shim' &&
    /^[a-f0-9]{64}$/.test(argv[11]) && argv[12] === JSON.stringify(binding.transportPolicy),
  'TOOL_TRANSPORT_PIN_MISMATCH');
  return description;
}

export function captureNativeToolTransport(value, client) {
  const tuple = originalTuple(value);
  const description = identity(tuple, client);
  return Object.freeze({
    tuple, client, deadline: description.deadlineUnixMs,
    taskHash: description.taskHash, sourceHash: description.sourceHash,
    transportBindingHash: description.transportBindingHash,
    plan: deepFreeze({
      protocol, task: { ...description.task }, taskHash: description.taskHash, sourceHash: description.sourceHash,
      publicFiles: description.publicFiles.map(item => ({ ...item })), artifactTargets: [...description.artifactTargets],
      limits: { ...description.limits }, deadlineUnixMs: description.deadlineUnixMs,
      transportBindingHash: description.transportBindingHash, workerProgramHash, shimHash,
      plannedAttachment: {
        type: 'volume', volumeSourceHash: digest(tuple.binding.transportMount.source),
        target: socketDirectory, readOnly: true, noCopy: true, socketPath, supplementalGid,
        primaryUser: primaryUsers[client]
      }
    })
  });
}

export function assertNativeToolTransportIdentity(transport) {
  const description = identity(transport.tuple, transport.client);
  insist(description.taskHash === transport.taskHash && description.sourceHash === transport.sourceHash &&
    description.transportBindingHash === transport.transportBindingHash && description.deadlineUnixMs === transport.deadline,
  'TOOL_TRANSPORT_SCOPE_MISMATCH');
  return description;
}

export function assertSameNativeToolTransport(transport, value) {
  const tuple = originalTuple(value);
  insist(tupleKeys.every(key => tuple[key] === transport.tuple[key]), 'TOOL_TRANSPORT_SCOPE_MISMATCH');
}

export async function assertFreshNativeToolTransport(transport) {
  assertNativeToolTransportIdentity(transport);
  let observed;
  // A boundary abort must not close the borrowed worker before its consumer is removed.
  try { observed = await assertToolWorkerTransportBinding(transport.tuple); }
  catch (error) {
    try { assertNativeToolTransportIdentity(transport); }
    catch (current) { throw current; }
    throw transportFailure(error);
  }
  assertNativeToolTransportIdentity(transport);
  insist(observed.taskHash === transport.taskHash && observed.sourceHash === transport.sourceHash &&
    observed.transportBindingHash === transport.transportBindingHash && observed.deadlineUnixMs === transport.deadline &&
    observed.nativeConsumptionSupported === false && observed.authenticationVerified === false &&
    observed.nativeDiscoveryVerified === false && observed.liveAccepted === false &&
    observed.evidenceScope === 'worker-filesystem-only', 'TOOL_TRANSPORT_UNVERIFIED');
  return new Date().toISOString();
}

export function nativeToolTransportDockerArguments(transport) {
  assertNativeToolTransportIdentity(transport);
  return [
    '--group-add', String(supplementalGid), '--mount',
    `type=volume,source=${transport.tuple.binding.transportMount.source},target=${socketDirectory},readonly,volume-nocopy`
  ];
}

export function nativeToolTransportExpectation(transport) {
  assertNativeToolTransportIdentity(transport);
  return Object.freeze({
    mount: transport.tuple.binding.transportMount, supplementalGid, primaryUser: primaryUsers[transport.client]
  });
}

// These parsers issue no authority; runtime expectations come only from the retained original tuple.
export function measureNativeToolTransportMount(container, expected) {
  const mount = expected.mount;
  const actual = container.Mounts?.filter(item => item.Type === 'volume') ?? [];
  const requested = container.HostConfig?.Mounts?.filter(item => item.Type === 'volume') ?? [];
  insist(mount.type === 'volume' && mount.target === socketDirectory && mount.readOnly === true &&
    mount.noCopy === true && expected.supplementalGid === supplementalGid &&
    ['1000:1000', '10001:10001'].includes(expected.primaryUser) &&
    container.Config?.User === expected.primaryUser &&
    JSON.stringify(container.HostConfig.GroupAdd) === JSON.stringify([String(supplementalGid)]) &&
    (container.HostConfig.Binds ?? []).length === 0 &&
    actual.length === 1 && actual[0].Name === mount.source &&
    actual[0].Destination === mount.target && actual[0].RW === false &&
    requested.length === 1 && requested[0].Source === mount.source && requested[0].Target === mount.target &&
    requested[0].ReadOnly === true && requested[0].VolumeOptions?.NoCopy === true,
  'TOOL_TRANSPORT_MOUNT_MISMATCH');
  return deepFreeze({
    type: 'volume', volumeSourceHash: digest(mount.source), target: socketDirectory,
    readOnly: true, noCopy: true, socketPath, supplementalGid, primaryUser: expected.primaryUser
  });
}

export function validateNativeToolSocketObservation(transport, candidate, value) {
  const [uid, gid] = primaryUsers[transport.client].split(':').map(Number);
  insist(value?.owner === candidate.boundaryState.owner && value.candidateId === candidate.id &&
    value.deadlineUnixMs === transport.deadline && value.uid === uid && value.gid === gid &&
    Array.isArray(value.supplementaryGroups) && value.supplementaryGroups.includes(supplementalGid) &&
    value.supplementaryGroups.every(group => [gid, supplementalGid].includes(group)) &&
    value.directory?.path === socketDirectory && value.directory.type === 'directory' &&
    value.directory.uid === 10002 && value.directory.gid === supplementalGid && value.directory.mode === 0o710 &&
    value.socket?.path === socketPath && value.socket.type === 'socket' && value.socket.uid === 10002 &&
    value.socket.gid === supplementalGid && value.socket.mode === 0o660 && value.connected === false,
  'TOOL_TRANSPORT_SOCKET_MISMATCH');
  return deepFreeze(value);
}

export function describeNativeToolTransport(transport, observation, active) {
  const verified = active && observation !== null;
  return deepFreeze({
    kind: 'original-native-tool-worker-socket-attachment', ...transport.plan,
    originalAuthorityRetained: true, authorityTransfer: false, planningOnly: !verified,
    attachmentVerified: verified, freshKernelVerification: verified,
    verification: verified ? 'timestamped-kernel-socket-composition-only' : 'cached-original-identity-only',
    evidenceScope: 'kernel-socket-composition-only', nativeAdmissionSupported: false,
    nativeConsumptionSupported: false, consumerSupervisionSupported: false,
    nativeDiscoveryVerified: false, skillDiscoveryVerified: false, authenticationVerified: false,
    liveAccepted: false, observation: verified ? observation : null,
    cleanupOrder: 'remove-exact-native-consumer-before-caller-closes-original-worker'
  });
}
