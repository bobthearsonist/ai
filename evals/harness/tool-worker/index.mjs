import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { OFFLINE_NODE_IMAGE, OFFLINE_NODE_VERSION } from '../isolation/index.mjs';
import { runBoundedProcess, sanitizedDockerEnvironment } from '../live-boundary/supervision.mjs';
import { attachSupervised } from './supervision.mjs';
import { exactResourceAbsence } from './ownership.mjs';
import { originalTransportState, describeTransportIdentity } from './identity.mjs';
import {
  TOOL_PROTOCOL, TOOL_CAPS, WORKER_UID, SOCKET_GID, SOCKET_DIRECTORY, SOCKET_PATH,
  FLAGS, ToolWorkerError, insist, exact, coordinates, limits, declarations, modelRequest, sha256, hashJson
} from './worker.mjs';

export { TOOL_PROTOCOL, TOOL_CAPS, ToolWorkerError };
export const TOOL_WORKER_IMAGE = OFFLINE_NODE_IMAGE;
export const TOOL_WORKER_NODE_VERSION = OFFLINE_NODE_VERSION;
const ROOT = fileURLToPath(new URL('.owned/', import.meta.url));
const LABEL = 'ai.skill-eval.tool-worker.owner';
const ISSUER_LABEL = 'ai.skill-eval.tool-worker.issuer';
const TASK_LABEL = 'ai.skill-eval.tool-worker.task';
const issuer = randomUUID();
const tasks = new WeakMap();
const workers = new WeakMap();
const leases = new WeakMap();
const bindings = new WeakMap();
const identityRegistry = { tasks, workers, leases, bindings };
const active = new Set();
const TMPFS = Object.freeze({
  '/workspace': `rw,noexec,nosuid,nodev,size=2m,mode=700,uid=${WORKER_UID},gid=${WORKER_UID}`,
  '/scratch': `rw,noexec,nosuid,nodev,size=1m,mode=700,uid=${WORKER_UID},gid=${WORKER_UID}`
});
const SOCKET_OPTIONS = Object.freeze({
  type: 'tmpfs', device: 'tmpfs',
  o: `size=64k,uid=${WORKER_UID},gid=${SOCKET_GID},mode=0710,noexec,nosuid,nodev`
});
const PROCESS_ENV = Object.freeze(['PATH=/usr/local/bin:/usr/bin:/bin', 'TMPDIR=/scratch', 'LANG=C.UTF-8']);
const IMAGE_ENV_NAMES = ['NODE_VERSION', 'PATH', 'YARN_VERSION'];

function freeze(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function noHostLinks(filename) {
  let cursor = path.resolve(filename);
  while (true) {
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      insist(!stat.isSymbolicLink(), 'OWNERSHIP_PATH_LINK');
      if (!stat.isDirectory()) insist(stat.isFile() && stat.nlink === 1, 'OWNERSHIP_PATH_LINK');
      const actual = fs.realpathSync(cursor);
      insist(process.platform === 'win32' ? actual.toLowerCase() === cursor.toLowerCase() :
        actual === cursor, 'OWNERSHIP_PATH_REDIRECT');
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
function trustedSource(name) {
  const filename = fileURLToPath(new URL(name, import.meta.url));
  noHostLinks(filename);
  const stat = fs.lstatSync(filename);
  insist(stat.isFile() && stat.nlink === 1 && stat.size <= 24000, 'TRUSTED_SOURCE_INVALID');
  const bytes = fs.readFileSync(filename);
  insist(Buffer.from(bytes.toString('utf8')).equals(bytes), 'TRUSTED_SOURCE_INVALID');
  return bytes.toString('utf8');
}
const workerSource = trustedSource('worker.mjs');
const shimSource = trustedSource('mcp-shim.mjs');
const workerProgramHash = sha256(workerSource);
const shimHash = sha256(shimSource);

export function issueToolTask(value) {
  const task = coordinates(value);
  const handle = freeze({ kind: 'tool-worker-task', coordinates: task });
  tasks.set(handle, { coordinates: task, hash: hashJson(task), issued: false });
  return handle;
}
function originalTask(handle) {
  const state = tasks.get(handle);
  insist(state, 'ORIGINAL_TASK_REQUIRED');
  return state;
}
function owned(task, worker, { closed = false } = {}) {
  const taskState = originalTask(task);
  const state = workers.get(worker);
  insist(state && state.task === task && state.taskHash === taskState.hash, 'ORIGINAL_WORKER_SCOPE_REQUIRED');
  if (state.lifecycle === 'closed') {
    if (!closed) throw new ToolWorkerError(state.terminalError?.code ?? 'WORKER_CLOSED', { cleanup: state.cleanup });
    insist(state.cleanup?.ownedDirectoryRemoved === true, 'WORKER_CLOSED');
    return state;
  }
  if (state.lifecycle === 'preparation-failed') {
    assertAllocatedDirectory(state);
    return state;
  }
  noHostLinks(state.directory);
  const stat = fs.lstatSync(state.marker);
  insist(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    stat.size === state.markerBytes.length, 'OWNERSHIP_MARKER_CHANGED');
  insist(fs.readFileSync(state.marker).equals(state.markerBytes), 'OWNERSHIP_MARKER_CHANGED');
  insist(fs.readdirSync(state.configDirectory).length === 0, 'DOCKER_CONFIG_IMPORT_DENIED');
  return state;
}
function assertAllocatedDirectory(state) {
  insist(state.directoryAllocated === true, 'OWNERSHIP_ALLOCATION_UNVERIFIED');
  noHostLinks(state.directory);
  const stat = fs.lstatSync(state.directory);
  insist(stat.isDirectory() && (!state.directoryIdentity ||
    (stat.dev === state.directoryIdentity.dev && stat.ino === state.directoryIdentity.ino)),
  'OWNERSHIP_ALLOCATION_CHANGED');
}
function rollbackPreparation(state) {
  assertAllocatedDirectory(state);
  fs.rmSync(state.directory, { recursive: true, force: false });
  insist(!fs.existsSync(state.directory), 'DIRECTORY_CLEANUP_UNVERIFIED');
  state.lifecycle = 'closed';
  active.delete(state);
  state.cleanup = freeze({
    containerRemoved: false, volumeRemoved: false, ownedDirectoryRemoved: true,
    attachment: { forced: false, processClosed: true, outputBytes: 0 },
    exactOwnedCleanup: true, ...FLAGS
  });
  return state.cleanup;
}
function signalValue(signal) {
  insist(signal === undefined || signal instanceof AbortSignal, 'INVALID_SIGNAL');
}
export function prepareToolWorker(options) {
  exact(options, ['task', 'publicFiles', 'artifactTargets', 'limits'],
    ['task', 'publicFiles', 'artifactTargets']);
  const taskState = originalTask(options.task);
  insist(!taskState.issued, 'TASK_WORKER_ALREADY_ISSUED');
  insist(active.size < 4, 'WORKER_COUNT_LIMIT');
  const caps = limits(options.limits);
  const selected = declarations(options.publicFiles, options.artifactTargets, caps);
  const sourceHash = hashJson(selected.files.map(({ path: name, bytes, sha256: hash }) =>
    ({ path: name, bytes, sha256: hash })));
  noHostLinks(ROOT);
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  const directory = path.join(ROOT, `worker-${nonce}`);
  const state = {
    task: options.task, taskHash: taskState.hash, taskCoordinates: taskState.coordinates,
    sourceHash, nonce, scope: randomBytes(32).toString('hex'), directory,
    marker: path.join(directory, '.owner.json'), configDirectory: path.join(directory, 'docker-config'),
    lifecycle: 'preparing', caps, selected, containerName: `eval-tool-worker-${nonce}`,
    volumeName: `eval-tool-socket-${nonce}`, containerId: null, volumeCreated: false,
    sequence: 0, adminRequests: 0, modelRequests: 0, requestBytes: 0,
    controlCommands: 0, controlOutputBytes: 0, controlActive: null, attachment: null,
    runController: null, terminalError: null, cleanupError: null, cleanup: null, cleanupPromise: null,
    lease: null, binding: null, lastDiagnostics: null, directoryAllocated: false, directoryIdentity: null
  };
  state.markerBytes = Buffer.from(JSON.stringify({
    protocol: TOOL_PROTOCOL, issuer, nonce, taskHash: state.taskHash, sourceHash
  }));
  const handle = freeze({ kind: 'tool-worker', protocol: TOOL_PROTOCOL });
  state.handle = handle;
  workers.set(handle, state);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    state.directoryAllocated = true;
    const stat = fs.lstatSync(directory);
    state.directoryIdentity = { dev: stat.dev, ino: stat.ino };
    active.add(state);
    fs.writeFileSync(state.marker, state.markerBytes, { flag: 'wx', mode: 0o600 });
    fs.mkdirSync(state.configDirectory, { mode: 0o700 });
    state.lifecycle = 'prepared';
    taskState.issued = true;
    return handle;
  } catch (failure) {
    if (!state.directoryAllocated) {
      workers.delete(handle);
      throw new ToolWorkerError('OWNED_PREPARATION_FAILED', { causeCode: failure.code ?? 'FILESYSTEM_FAILURE' });
    }
    state.lifecycle = 'preparation-failed';
    let cleanup;
    try {
      cleanup = rollbackPreparation(state);
    } catch (error) {
      taskState.issued = true;
      active.add(state);
      throw new ToolWorkerError('PREPARATION_CLEANUP_FAILED', {
        causeCode: failure.code ?? 'FILESYSTEM_FAILURE', cleanupCauseCode: error.code ?? 'FILESYSTEM_FAILURE',
        taskHash: state.taskHash, worker: handle
      });
    }
    throw new ToolWorkerError('OWNED_PREPARATION_FAILED', {
      causeCode: failure.code ?? 'FILESYSTEM_FAILURE', cleanup
    });
  }
}
function labels(state) {
  return { [LABEL]: state.nonce, [ISSUER_LABEL]: issuer, [TASK_LABEL]: state.taskHash };
}
function labelArguments(state) {
  return Object.entries(labels(state)).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}
function expectedCommand(state) {
  return ['-i', ...PROCESS_ENV, '/usr/local/bin/node', '--input-type=module', '--eval',
    workerSource, '--', '--eval-tool-worker', state.scope];
}
function workerArguments(state) {
  return [
    'create', '--pull', 'never', '--platform', 'linux/amd64', '--name', state.containerName,
    ...labelArguments(state), '--network', 'none', '--read-only', '--user', `${WORKER_UID}:${WORKER_UID}`,
    '--group-add', `${SOCKET_GID}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--init', '--memory', '128m', '--memory-swap', '128m', '--cpus', '1', '--pids-limit', '32',
    '--ulimit', 'nofile=64:64', '--ulimit', 'fsize=16384:16384', '--ipc', 'none',
    '--log-driver', 'none', '--restart', 'no', '--stop-timeout', '1', '--workdir', '/workspace',
    '--interactive', ...Object.entries(TMPFS).flatMap(([target, options]) => ['--tmpfs', `${target}:${options}`]),
    '--mount', `type=volume,source=${state.volumeName},target=${SOCKET_DIRECTORY},volume-nocopy`,
    '--entrypoint', '/usr/bin/env', TOOL_WORKER_IMAGE, ...expectedCommand(state)
  ];
}
async function command(state, args, { cleanup = false, allowFailure = false, deadline } = {}) {
  owned(state.task, state.handle, { closed: cleanup });
  if (!cleanup) {
    insist(state.lifecycle !== 'closing' && state.lifecycle !== 'cleanup-failed', 'WORKER_CLOSING');
    insist(++state.controlCommands <= 256, 'CONTROL_COUNT_LIMIT');
  }
  const operation = runBoundedProcess('docker', ['--config', state.configDirectory, ...args], {
    cwd: state.directory, env: sanitizedDockerEnvironment(state.configDirectory),
    deadline: deadline ?? state.deadline, signal: cleanup ? undefined : state.runController?.signal,
    maxOutputBytes: 131072, allowFailure
  });
  state.controlActive = operation;
  try {
    const result = await operation;
    if (!cleanup) {
      state.controlOutputBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      insist(state.controlOutputBytes <= 4194304, 'CONTROL_OUTPUT_LIMIT');
    }
    return result;
  } catch (error) {
    throw error instanceof ToolWorkerError ? error : new ToolWorkerError(error.code ?? 'DOCKER_FAILURE');
  } finally {
    if (state.controlActive === operation) state.controlActive = null;
  }
}
function parseOne(result) {
  try {
    const value = JSON.parse(result.stdout);
    insist(Array.isArray(value) && value.length === 1, 'INVALID_DOCKER_DIAGNOSTIC');
    return value[0];
  } catch (error) {
    throw error instanceof ToolWorkerError ? error : new ToolWorkerError('INVALID_DOCKER_DIAGNOSTIC');
  }
}
function exactAbsence(result, kind, identity) {
  return exactResourceAbsence(result, kind, identity);
}
function validateIdentity(state, container, { unregistered = false } = {}) {
  insist(container && /^[a-f0-9]{64}$/.test(container.Id) &&
    (unregistered || container.Id === state.containerId) &&
    container.Name === `/${state.containerName}` &&
    Object.entries(labels(state)).every(([key, value]) => container.Config?.Labels?.[key] === value),
  'CONTAINER_OWNERSHIP_MISMATCH');
}
function validateConfinement(state, container) {
  validateIdentity(state, container);
  const config = container.Config;
  const host = container.HostConfig;
  insist(container.Image === state.imageId && config.User === `${WORKER_UID}:${WORKER_UID}` &&
    config.WorkingDir === '/workspace' &&
    JSON.stringify(config.Entrypoint) === '["/usr/bin/env"]' &&
    JSON.stringify(config.Cmd) === JSON.stringify(expectedCommand(state)), 'WORKER_PROGRAM_MISMATCH');
  insist(config.Env.every(item => IMAGE_ENV_NAMES.includes(item.split('=')[0])) &&
    config.Env.some(item => item === `NODE_VERSION=${TOOL_WORKER_NODE_VERSION}`), 'WORKER_ENVIRONMENT_MISMATCH');
  insist(host.NetworkMode === 'none' && host.ReadonlyRootfs === true && host.Privileged === false &&
    host.CapDrop?.length === 1 && ['ALL', 'CAP_ALL'].includes(host.CapDrop[0]) &&
    host.CapAdd === null && host.SecurityOpt?.length === 1 &&
    host.SecurityOpt[0] === 'no-new-privileges=true' && host.GroupAdd?.join(',') === `${SOCKET_GID}` &&
    host.Memory === 134217728 && host.MemorySwap === 134217728 &&
    host.PidsLimit === 32 && host.NanoCpus === 1000000000 && host.LogConfig?.Type === 'none' &&
    host.IpcMode === 'none' && !host.PidMode && !host.UTSMode &&
    !host.UsernsMode && host.RestartPolicy?.Name === 'no' && host.Init === true &&
    Object.keys(host.PortBindings ?? {}).length === 0 &&
    (host.Devices ?? []).length === 0 && (host.DeviceRequests ?? []).length === 0 &&
    (host.Binds ?? []).length === 0 && (host.VolumesFrom ?? []).length === 0 &&
    (host.ExtraHosts ?? []).length === 0 && (host.Links ?? []).length === 0, 'CONFINEMENT_MISMATCH');
  insist(JSON.stringify(Object.keys(host.Tmpfs ?? {}).sort()) ===
    JSON.stringify(Object.keys(TMPFS).sort()) &&
    Object.entries(TMPFS).every(([target, options]) => host.Tmpfs[target]?.split(',').sort().join(',') ===
      options.split(',').sort().join(',')), 'WORKSPACE_MOUNT_MISMATCH');
  insist(container.Mounts?.length === 1 && container.Mounts[0].Type === 'volume' &&
    container.Mounts[0].Name === state.volumeName &&
    container.Mounts[0].Destination === SOCKET_DIRECTORY && container.Mounts[0].RW === true &&
    host.Mounts?.length === 1 && host.Mounts[0].Type === 'volume' &&
    host.Mounts[0].Source === state.volumeName && host.Mounts[0].Target === SOCKET_DIRECTORY &&
    // Docker omits the false ReadOnly field; the actual volume RW flag is checked above.
    (host.Mounts[0].ReadOnly === undefined || host.Mounts[0].ReadOnly === false) &&
    host.Mounts[0].VolumeOptions?.NoCopy === true,
  'SOCKET_MOUNT_MISMATCH');
  return {
    network: 'none', rootfsReadOnly: true, uid: WORKER_UID, gid: WORKER_UID,
    supplementalGid: SOCKET_GID, pidMode: 'private-default', userNamespaceMode: 'daemon-default',
    capDrop: ['ALL'], noNewPrivileges: true, bindMounts: [],
    socketVolumeOnly: true, tmpfs: TMPFS, logging: 'none', memoryBytes: 134217728, pidsLimit: 32
  };
}
async function inspectVolume(state, options) {
  const volume = parseOne(await command(state, ['volume', 'inspect', state.volumeName], options));
  insist(volume.Name === state.volumeName && volume.Driver === 'local' && volume.Scope === 'local' &&
    Object.entries(labels(state)).every(([key, value]) => volume.Labels?.[key] === value) &&
    JSON.stringify(Object.keys(volume.Options ?? {}).sort()) === JSON.stringify(Object.keys(SOCKET_OPTIONS).sort()) &&
    Object.entries(SOCKET_OPTIONS).every(([key, value]) => volume.Options[key] === value),
  'VOLUME_OWNERSHIP_MISMATCH');
  return volume;
}
async function inspectContainer(state, options) {
  const container = parseOne(await command(state, ['inspect', state.containerId ?? state.containerName], options));
  validateIdentity(state, container, { unregistered: state.containerId === null });
  return container;
}
async function recheck(state) {
  owned(state.task, state.handle);
  insist(state.lifecycle === 'ready', 'WORKER_NOT_READY');
  if (state.terminalError) throw state.terminalError;
  insist(Date.now() < state.deadline, 'TIMEOUT');
  state.attachment.assertRunning();
  await inspectVolume(state);
  const container = await inspectContainer(state);
  const confinement = validateConfinement(state, container);
  insist(container.State?.Running === true && container.State.OOMKilled === false, 'WORKER_NOT_RUNNING');
  return confinement;
}
async function cleanupResources(state) {
  owned(state.task, state.handle);
  state.lifecycle = 'closing';
  clearTimeout(state.deadlineTimer);
  state.externalSignal?.removeEventListener('abort', state.externalAbort);
  state.runController?.abort();
  if (state.controlActive) {
    try { await state.controlActive; }
    catch (error) { state.interruptedControlCode = error.code ?? 'DOCKER_FAILURE'; }
  }
  const deadline = Date.now() + 15000;
  let attachmentResult = { processClosed: true, forced: false, outputBytes: 0 };
  let processError;
  if (state.attachment) {
    try { attachmentResult = await state.attachment.stop(); }
    catch (error) { processError = error; }
  }
  const identifier = state.containerId ?? state.containerName;
  const before = await command(state, ['inspect', identifier], { cleanup: true, allowFailure: true, deadline });
  let containerRemoved = false;
  if (before.exitCode === 0) {
    const container = parseOne(before);
    const registered = state.containerId !== null;
    validateIdentity(state, container, { unregistered: !registered });
    state.containerId = container.Id;
    if (!registered) validateConfinement(state, container);
    await command(state, ['rm', '--force', container.Id], { cleanup: true, deadline });
    const after = await command(state, ['inspect', container.Id], { cleanup: true, allowFailure: true, deadline });
    insist(exactAbsence(after, 'container', container.Id), 'CONTAINER_CLEANUP_UNVERIFIED');
    containerRemoved = true;
  } else insist(exactAbsence(before, 'container', identifier), 'CONTAINER_CLEANUP_UNVERIFIED');
  const volumeBefore = await command(state, ['volume', 'inspect', state.volumeName],
    { cleanup: true, allowFailure: true, deadline });
  let volumeRemoved = false;
  if (volumeBefore.exitCode === 0) {
    await inspectVolume(state, { cleanup: true, deadline });
    await command(state, ['volume', 'rm', state.volumeName], { cleanup: true, deadline });
    const after = await command(state, ['volume', 'inspect', state.volumeName],
      { cleanup: true, allowFailure: true, deadline });
    insist(exactAbsence(after, 'volume', state.volumeName), 'VOLUME_CLEANUP_UNVERIFIED');
    volumeRemoved = true;
  } else insist(exactAbsence(volumeBefore, 'volume', state.volumeName), 'VOLUME_CLEANUP_UNVERIFIED');
  if (processError) throw processError;
  owned(state.task, state.handle);
  fs.rmSync(state.directory, { recursive: true, force: false });
  insist(!fs.existsSync(state.directory), 'DIRECTORY_CLEANUP_UNVERIFIED');
  state.lifecycle = 'closed';
  active.delete(state);
  state.cleanup = freeze({
    containerRemoved, volumeRemoved, ownedDirectoryRemoved: true,
    attachment: attachmentResult, exactOwnedCleanup: true, ...FLAGS
  });
  return state.cleanup;
}
function beginCleanup(state, error) {
  state.terminalError ??= error ?? new ToolWorkerError('WORKER_CLOSED');
  if (!state.cleanupPromise) {
    state.cleanupPromise = cleanupResources(state).catch(failure => {
      state.lifecycle = 'cleanup-failed';
      state.cleanupError = new ToolWorkerError('CLEANUP_FAILED', {
        causeCode: failure.code ?? 'FILESYSTEM_FAILURE', taskHash: state.taskHash
      });
      throw state.cleanupError;
    });
    // Event-triggered supervision retains a failed cleanup for the next original-handle action.
    state.cleanupPromise.catch(failure => { state.cleanupError = failure; });
  }
  return state.cleanupPromise;
}
function diagnostic(state, result, confinement) {
  insist(result.taskHash === state.taskHash && result.sourceHash === state.sourceHash &&
    result.deadlineUnixMs === state.deadline &&
    result.kernel.runtimeVersion === TOOL_WORKER_NODE_VERSION &&
    result.kernel.uid === WORKER_UID && result.kernel.gid === WORKER_UID &&
    result.kernel.supplementaryGroups.includes(SOCKET_GID) &&
    JSON.stringify(result.kernel.environmentNames) === '["LANG","PATH","TMPDIR"]' &&
    result.kernel.interfaces.join(',') === 'lo' &&
    result.kernel.procStatus.CapEff === '0000000000000000' &&
    result.kernel.procStatus.NoNewPrivs === '1', 'KERNEL_DIAGNOSTIC_MISMATCH');
  const report = {
    protocol: TOOL_PROTOCOL, task: state.taskCoordinates, taskHash: state.taskHash,
    sourceHash: state.sourceHash, workerProgramHash, shimHash, deadlineUnixMs: state.deadline,
    runtimeVersion: result.kernel.runtimeVersion, publicFiles: state.selected.files.map(item =>
      ({ path: item.path, bytes: item.bytes, sha256: item.sha256 })),
    artifactTargets: [...state.selected.targets], limits: state.caps,
    confinement, kernel: result.kernel, stats: result.stats ?? {
      requests: 0, requestBytes: 0, outputBytes: 0, writtenBytes: 0
    }, events: result.events ?? [], ...FLAGS
  };
  report.diagnosticHash = hashJson(report);
  state.lastDiagnostics = freeze(report);
  return state.lastDiagnostics;
}
export async function startToolWorker(options) {
  exact(options, ['task', 'worker', 'signal'], ['task', 'worker']);
  const state = owned(options.task, options.worker);
  signalValue(options.signal);
  insist(state.lifecycle === 'prepared', 'WORKER_ALREADY_STARTED');
  if (options.signal?.aborted) {
    const cleanup = await closeToolWorker({ task: options.task, worker: options.worker });
    throw new ToolWorkerError('CANCELLED', { taskHash: state.taskHash, cleanup });
  }
  state.lifecycle = 'starting';
  state.deadline = Date.now() + state.caps.timeoutMs;
  state.runController = new AbortController();
  state.externalSignal = options.signal;
  state.externalAbort = () => beginCleanup(state, new ToolWorkerError('CANCELLED'));
  options.signal?.addEventListener('abort', state.externalAbort, { once: true });
  state.deadlineTimer = setTimeout(() => beginCleanup(state, new ToolWorkerError('TIMEOUT')),
    state.caps.timeoutMs);
  try {
    if (options.signal?.aborted) throw new ToolWorkerError('CANCELLED');
    const serverResult = await command(state, ['version', '--format', '{{json .Server}}']);
    let server;
    try { server = JSON.parse(serverResult.stdout); }
    catch { throw new ToolWorkerError('INVALID_DOCKER_DIAGNOSTIC'); }
    insist(server.Os === 'linux' && server.Arch === 'amd64', 'UNSUPPORTED_DOCKER_PLATFORM');
    state.engineVersion = server.Version;
    const image = parseOne(await command(state, ['image', 'inspect', TOOL_WORKER_IMAGE]));
    insist(image.Os === 'linux' && image.Architecture === 'amd64' &&
      image.RepoDigests?.includes(TOOL_WORKER_IMAGE) &&
      image.Config.Env.every(item => IMAGE_ENV_NAMES.includes(item.split('=')[0])) &&
      image.Config.Env.includes(`NODE_VERSION=${TOOL_WORKER_NODE_VERSION}`), 'PUBLIC_NODE_PIN_MISMATCH');
    state.imageId = image.Id;
    await command(state, ['volume', 'create', '--driver', 'local', ...labelArguments(state),
      ...Object.entries(SOCKET_OPTIONS).flatMap(([key, value]) => ['--opt', `${key}=${value}`]), state.volumeName]);
    state.volumeCreated = true;
    await inspectVolume(state);
    const creation = await command(state, workerArguments(state));
    insist(/^[a-f0-9]{64}$/.test(creation.stdout.trim()), 'INVALID_CONTAINER_ID');
    state.containerId = creation.stdout.trim();
    const container = await inspectContainer(state);
    const confinement = validateConfinement(state, container);
    state.attachment = attachSupervised('docker',
      ['--config', state.configDirectory, 'start', '--attach', '--interactive', state.containerId], {
        cwd: state.directory, env: sanitizedDockerEnvironment(state.configDirectory),
        deadline: state.deadline, signal: state.runController.signal,
        outputBytes: state.caps.outputBytes, scope: state.scope,
        onFailure: error => beginCleanup(state, error)
      });
    const ready = await state.attachment.exchange({
      protocol: TOOL_PROTOCOL, kind: 'initialize', scope: state.scope,
      task: state.taskCoordinates, publicFiles: state.selected.files.map(item =>
        ({ path: item.path, contentBase64: item.content.toString('base64') })),
      artifactTargets: state.selected.targets, limits: state.caps, deadlineUnixMs: state.deadline
    }, 0);
    insist(ready.ok === true, 'WORKER_INITIALIZATION_FAILED');
    state.lifecycle = 'ready';
    await recheck(state);
    return diagnostic(state, ready.result, confinement);
  } catch (error) {
    const failure = state.terminalError ?? (error instanceof ToolWorkerError ? error :
      new ToolWorkerError(error.code ?? 'WORKER_START_FAILED'));
    const cleanup = await beginCleanup(state, failure);
    throw new ToolWorkerError(failure.code, { taskHash: state.taskHash, cleanup });
  }
}
async function action(options, callback, required = ['task', 'worker']) {
  exact(options, required.includes('request') ? ['task', 'worker', 'request', 'signal'] :
    ['task', 'worker', 'signal'], required);
  const state = owned(options.task, options.worker);
  signalValue(options.signal);
  insist(state.lifecycle === 'ready', 'WORKER_NOT_READY');
  insist(!state.busy, 'WORKER_BUSY');
  state.busy = true;
  const abort = () => beginCleanup(state, new ToolWorkerError('CANCELLED'));
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) throw new ToolWorkerError('CANCELLED');
    const confinement = await recheck(state);
    return await callback(state, confinement);
  } catch (error) {
    const failure = state.terminalError ?? (error instanceof ToolWorkerError ? error :
      new ToolWorkerError(error.code ?? 'WORKER_ACTION_FAILED'));
    const cleanup = await beginCleanup(state, failure);
    throw new ToolWorkerError(failure.code, { taskHash: state.taskHash, cleanup });
  } finally {
    state.busy = false;
    options.signal?.removeEventListener('abort', abort);
  }
}
async function exchange(state, kind, request) {
  insist(++state.adminRequests <= 96, 'CONTROL_COUNT_LIMIT');
  const envelope = { protocol: TOOL_PROTOCOL, scope: state.scope, sequence: ++state.sequence, kind };
  if (request !== undefined) envelope.request = request;
  return state.attachment.exchange(envelope, state.sequence);
}
export async function requestToolWorker(options) {
  exact(options, ['task', 'worker', 'request', 'signal'], ['task', 'worker', 'request']);
  const state = owned(options.task, options.worker);
  const request = modelRequest(options.request, state.caps);
  const snapshot = JSON.parse(JSON.stringify(request));
  return action({ ...options, request: snapshot }, async current => {
    insist(++current.modelRequests <= current.caps.requests, 'REQUEST_COUNT_LIMIT');
    current.requestBytes += Buffer.byteLength(JSON.stringify(snapshot));
    insist(current.requestBytes <= current.caps.totalRequestBytes, 'REQUEST_LIMIT');
    return exchange(current, 'model', snapshot);
  }, ['task', 'worker', 'request']);
}
export async function inspectToolWorker(options) {
  return action(options, async (state, confinement) => {
    const response = await exchange(state, 'diagnostics');
    insist(response.ok === true, 'WORKER_DIAGNOSTICS_FAILED');
    return diagnostic(state, response.result, confinement);
  });
}
export async function captureToolWorkerArtifacts(options) {
  return action(options, async state => {
    const response = await exchange(state, 'capture');
    insist(response.ok === true, 'ARTIFACT_CAPTURE_FAILED');
    let bytes = 0;
    const result = response.result;
    insist(Array.isArray(result.artifacts) && Array.isArray(result.missing) &&
      result.artifacts.length + result.missing.length === state.selected.targets.length,
    'ARTIFACT_CAPTURE_INVALID');
    const seen = new Set();
    const artifacts = result.artifacts.map(item => {
      exact(item, ['path', 'bytes', 'sha256', 'contentBase64']);
      insist(state.selected.targets.includes(item.path) && !seen.has(item.path), 'ARTIFACT_CAPTURE_INVALID');
      seen.add(item.path);
      const content = Buffer.from(item.contentBase64, 'base64');
      bytes += content.length;
      insist(content.length === item.bytes && content.length <= state.caps.fileBytes &&
        sha256(content) === item.sha256 && content.toString('base64') === item.contentBase64 &&
        bytes <= state.caps.artifactBytes, 'ARTIFACT_CAPTURE_INVALID');
      return { path: item.path, bytes: content.length, sha256: item.sha256, content };
    });
    for (const name of result.missing) {
      insist(state.selected.targets.includes(name) && !seen.has(name), 'ARTIFACT_CAPTURE_INVALID');
      seen.add(name);
    }
    return {
      task: state.taskCoordinates, taskHash: state.taskHash, sourceHash: state.sourceHash,
      artifacts, missing: [...result.missing],
      captureHash: hashJson({ taskHash: state.taskHash, artifacts: artifacts.map(({ content, ...item }) => item),
        missing: result.missing }), ...FLAGS
    };
  });
}
export async function leaseToolWorkerTransport(options) {
  exact(options, ['task', 'worker', 'signal'], ['task', 'worker']);
  return action(options, async state => {
    insist(!state.lease, 'TRANSPORT_ALREADY_LEASED');
    const lease = freeze({ kind: 'tool-worker-transport-lease', protocol: TOOL_PROTOCOL });
    leases.set(lease, { state, task: options.task, worker: options.worker });
    state.lease = lease;
    return lease;
  });
}
function originalLease(options) {
  owned(options.task, options.worker);
  return originalTransportState(identityRegistry, options, { requireBinding: false });
}
export async function resolveToolWorkerTransportLease(options) {
  exact(options, ['task', 'worker', 'lease', 'signal'], ['task', 'worker', 'lease']);
  const state = originalLease(options);
  return action({ task: options.task, worker: options.worker, signal: options.signal }, async () => {
    if (!state.binding) {
      const transportPolicy = {
        deadlineUnixMs: state.deadline, requests: state.caps.requests,
        requestBytes: state.caps.requestBytes, totalRequestBytes: state.caps.totalRequestBytes,
        outputBytes: state.caps.outputBytes
      };
      state.binding = freeze({
        kind: 'tool-worker-transport-binding', protocol: TOOL_PROTOCOL,
        taskHash: state.taskHash, sourceHash: state.sourceHash, workerProgramHash, shimHash,
        transportMount: { type: 'volume', source: state.volumeName,
          target: SOCKET_DIRECTORY, readOnly: true, noCopy: true },
        socketPath: SOCKET_PATH, supplementalGid: SOCKET_GID, transportPolicy,
        supportedIdentityLayouts: [{ uid: 1000, gid: 1000 }, { uid: 10001, gid: 10001 }],
        stdioCommand: ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'TMPDIR=/scratch',
          'LANG=C.UTF-8', '/usr/local/bin/node', '--input-type=module', '--eval', shimSource,
          '--', '--eval-tool-mcp-shim', state.scope, JSON.stringify(transportPolicy)],
        ...FLAGS
      });
      bindings.set(state.binding, { state, lease: options.lease });
    }
    return state.binding;
  });
}
export async function assertToolWorkerTransportBinding(options) {
  exact(options, ['task', 'worker', 'lease', 'binding', 'signal'],
    ['task', 'worker', 'lease', 'binding']);
  owned(options.task, options.worker);
  const state = originalTransportState(identityRegistry, options);
  return action({ task: options.task, worker: options.worker, signal: options.signal }, async () => ({
    taskHash: state.taskHash, sourceHash: state.sourceHash, transportBindingHash: hashJson(state.binding),
    deadlineUnixMs: state.deadline, nativeConsumptionSupported: false, ...FLAGS
  }));
}
export function describeToolWorkerTransportBinding(options) {
  exact(options, ['task', 'worker', 'lease', 'binding']);
  return describeTransportIdentity(identityRegistry, options);
}
export async function closeToolWorker(options) {
  exact(options, ['task', 'worker']);
  const state = owned(options.task, options.worker, { closed: true });
  if (state.lifecycle === 'closed') return state.cleanup;
  if (state.lifecycle === 'preparation-failed') return rollbackPreparation(state);
  if (state.lifecycle === 'prepared') {
    owned(options.task, options.worker);
    fs.rmSync(state.directory, { recursive: true, force: false });
    insist(!fs.existsSync(state.directory), 'DIRECTORY_CLEANUP_UNVERIFIED');
    state.lifecycle = 'closed';
    active.delete(state);
    state.cleanup = freeze({
      containerRemoved: false, volumeRemoved: false, ownedDirectoryRemoved: true,
      attachment: { forced: false, processClosed: true, outputBytes: 0 }, exactOwnedCleanup: true, ...FLAGS
    });
    return state.cleanup;
  }
  if (state.lifecycle === 'cleanup-failed') state.cleanupPromise = null;
  return beginCleanup(state);
}
