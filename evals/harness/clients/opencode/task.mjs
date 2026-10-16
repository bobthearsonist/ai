import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { captureArtifacts, gradeChecks, validateChecks } from '../../checks/index.mjs';
import { BASE_IMAGE, CLIENT_VERSION, OWNER_LABEL } from './index.mjs';
import { auditTaskExecution } from './task-audit.mjs';
import {
  TASK_CAPS, OfflineTaskError, freeze, insist, nativePayload, prepareTaskSpec, record, sha256
} from './task-spec.mjs';
import { buildPinnedRuntimeImage, cleanupOwnedWorkspace, createOwnedWorkspace, docker, noLinks } from './runtime-image.mjs';

const seenSessions = new Set();
let active = 0;
const slots = [];

export function prepareOfflineTask(options) {
  record(options, ['task', 'prompt', 'skill', 'inputs', 'checks', 'mock', 'timeoutMs'],
    ['task', 'prompt', 'skill', 'checks', 'mock']);
  insist(Array.isArray(options.checks) && options.checks.length > 0 && options.checks.length <= TASK_CAPS.checks,
    'A bounded nonempty host-only check declaration list is required');
  const declarations = validateChecks(options.checks);
  insist(Buffer.byteLength(JSON.stringify(declarations)) <= TASK_CAPS.checkBytes, 'Private host check byte cap exceeded');
  const targets = [...new Set(declarations.filter(check => check.type.startsWith('artifact-')).map(check => check.target))];
  const spec = prepareTaskSpec(options, targets);
  const boundedPayload = nativePayload(spec, '00000000-0000-0000-0000-000000000000', spec.timeoutMs);
  insist(Buffer.byteLength(JSON.stringify(boundedPayload)) <= 2 * 1024 * 1024, 'Native payload byte cap exceeded before launch');
  return { declarations, spec };
}

export function taskDockerArguments({ image, state }) {
  insist(/^sha256:[a-f0-9]{64}$/.test(image) && /^[a-f0-9-]{36}$/.test(state.executionId) &&
    state.name === `skill-eval-opencode-task-${state.executionId}`, 'Invalid owned immutable task identity');
  return ['create', '--pull', 'never', '--platform', 'linux/amd64', '--name', state.name,
    '--label', `${OWNER_LABEL}=${state.executionId}`, '--network', 'none', '--read-only', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', '128',
    '--memory', '768m', '--memory-swap', '768m', '--cpus', '1', '--ipc', 'none',
    // Native SQLite WAL files exceed artifact caps; selected artifact bytes are capped independently.
    '--ulimit', 'nofile=256:256', '--ulimit', 'fsize=16777216:16777216',
    '--log-driver', 'none', '--stop-timeout', '1', '--workdir', '/work',
    '--tmpfs', '/work:rw,noexec,nosuid,nodev,uid=1000,gid=1000,size=256m',
    '--env', 'PATH=/usr/local/bin:/usr/bin:/bin',
    '--entrypoint', 'node', image, '-e', 'setInterval(() => {}, 60000)'];
}

async function inspectContainer(state, deadline) {
  const [container] = JSON.parse((await docker(state, ['inspect', state.name], { deadline })).stdout);
  insist(container?.Config?.Labels?.[OWNER_LABEL] === state.executionId,
    'Owned task container label mismatch', 'OWNERSHIP_MISMATCH');
  return container;
}

function confinement(container, image) {
  const host = container.HostConfig;
  insist(container.Image === image && host.NetworkMode === 'none' && host.ReadonlyRootfs &&
    container.Config.User === '1000:1000' && host.Privileged === false &&
    host.CapDrop.some(cap => ['ALL', 'CAP_ALL'].includes(cap)) && host.SecurityOpt.includes('no-new-privileges=true') &&
    host.PidsLimit === 128 && host.Memory === 805306368 && host.MemorySwap === 805306368 &&
    host.NanoCpus === 1000000000 && host.LogConfig.Type === 'none' && host.IpcMode === 'none' &&
    host.Ulimits.length === 2 &&
    host.Ulimits.some(limit => limit.Name === 'nofile' && limit.Soft === 256 && limit.Hard === 256) &&
    host.Ulimits.some(limit => limit.Name === 'fsize' && limit.Soft === 16777216 && limit.Hard === 16777216) &&
    !container.Mounts.some(mount => mount.Type === 'bind' || mount.Type === 'volume') &&
    Object.keys(host.Tmpfs).length === 1 && typeof host.Tmpfs['/work'] === 'string' &&
    ['rw', 'noexec', 'nosuid', 'nodev', 'uid=1000', 'gid=1000', 'size=256m']
      .every(option => host.Tmpfs['/work'].split(',').includes(option)),
  'Observed native task confinement differs from fixed policy', 'TOOL_BOUNDARY_FAILED');
  return { containerId: container.Id, actualImageId: container.Image, network: host.NetworkMode,
    rootfsReadOnly: true, user: container.Config.User, capDrop: host.CapDrop, securityOpt: host.SecurityOpt,
    memoryBytes: host.Memory, pidsLimit: host.PidsLimit, nanoCpus: host.NanoCpus,
    tmpfs: host.Tmpfs, ulimits: host.Ulimits, hostMounts: [], logging: host.LogConfig.Type };
}

async function acquire(deadline) {
  insist(deadline > Date.now(), 'Offline task deadline exceeded', 'TIMEOUT');
  if (active < 4) { active++; return; }
  await new Promise((resolve, reject) => {
    const entry = { resolve: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => {
      const index = slots.indexOf(entry);
      if (index >= 0) slots.splice(index, 1);
      reject(new OfflineTaskError('Offline task queue deadline exceeded', 'TIMEOUT'));
    }, deadline - Date.now());
    slots.push(entry);
  });
}

function release() {
  const next = slots.shift();
  if (next) next.resolve();
  else active--;
}

export async function runOfflineTask(options) {
  const start = performance.now();
  const prepared = prepareOfflineTask(options);
  const { spec, declarations } = prepared;
  const deadline = Date.now() + spec.timeoutMs;
  await acquire(deadline);
  let state;
  let receipt;
  let failure;
  try {
    const executionId = randomUUID();
    state = createOwnedWorkspace(executionId, spec.task);
    const { server, dependency, metadata, image } = await buildPinnedRuntimeImage(state, { deadline });
    await docker(state, taskDockerArguments({ image, state }), { deadline });
    const created = await inspectContainer(state, deadline);
    const isolation = confinement(created, image);
    await docker(state, ['start', state.name], { deadline });
    const running = await inspectContainer(state, deadline);
    insist(running.State.Running && !running.State.OOMKilled, 'Native task container did not become ready', 'NATIVE_EXECUTION_INCOMPLETE');
    const remaining = deadline - Date.now();
    insist(remaining >= 1000, 'Offline task deadline exceeded before native execution', 'TIMEOUT');
    const payload = JSON.stringify(nativePayload(spec, executionId, remaining));
    insist(Buffer.byteLength(payload) <= 2 * 1024 * 1024, 'Native payload byte cap exceeded');
    const result = await docker(state, ['exec', '-i', state.name, 'node', '/opt/fixture/task-runtime.mjs'],
      { deadline, input: payload });
    let observed;
    try { observed = JSON.parse(result.stdout); }
    catch { throw new OfflineTaskError('Missing or malformed native task receipt', 'NATIVE_EXECUTION_INCOMPLETE'); }
    insist(observed.protocol === 1 && observed.executionId === executionId && observed.clientVersion === CLIENT_VERSION &&
      JSON.stringify(observed.task) === JSON.stringify(spec.task) && observed.versions?.node === '22.22.1' &&
      Number.isFinite(observed.native?.elapsedMs) && observed.native.elapsedMs >= 0 &&
      observed.freshWorkspace === true && observed.freshHome === true,
    'Incomplete native task coordinates/runtime evidence', 'NATIVE_EXECUTION_INCOMPLETE');
    const audit = auditTaskExecution({ spec, ...observed });
    insist(!seenSessions.has(audit.audit.sessionId), 'Reused native session identity', 'NATIVE_EXECUTION_INCOMPLETE');
    seenSessions.add(audit.audit.sessionId);
    await docker(state, ['pause', state.name], { deadline });
    const paused = await inspectContainer(state, deadline);
    confinement(paused, image);
    insist(paused.State.Running && paused.State.Paused && !paused.State.OOMKilled,
      'Native disk capture could not freeze the completed workspace', 'NATIVE_EXECUTION_INCOMPLETE');
    // Docker cp cannot read this tmpfs. The native process group is gone; only the fixed filesystem reader runs.
    await docker(state, ['unpause', state.name], { deadline });
    const readbackResult = await docker(state, ['exec', '-i', state.name, 'node', '/opt/fixture/task-capture.mjs'],
      { deadline, input: JSON.stringify({ protocol: 1, executionId, inventory: observed.inventory }) });
    let readback;
    try { readback = JSON.parse(readbackResult.stdout); }
    catch { throw new OfflineTaskError('Malformed trusted disk readback', 'ARTIFACT_CAPTURE_FAILED'); }
    insist(readback.protocol === 1 && readback.executionId === executionId &&
      readback.source === 'trusted-native-filesystem' && Array.isArray(readback.artifacts) &&
      readback.artifacts.length === observed.inventory.length,
    'Incomplete trusted disk readback', 'ARTIFACT_CAPTURE_FAILED');
    await docker(state, ['pause', state.name], { deadline });
    const artifactRoot = path.join(state.directory, 'artifacts');
    let totalArtifactBytes = 0;
    for (const [index, entry] of observed.inventory.entries()) {
      const actual = readback.artifacts[index];
      insist(actual?.target === entry.target && actual.state === entry.state,
        'Trusted disk readback target mismatch', 'ARTIFACT_CAPTURE_FAILED');
      if (entry.state !== 'present') continue;
      insist(typeof actual.base64 === 'string', 'Trusted disk readback bytes absent', 'ARTIFACT_CAPTURE_FAILED');
      const bytes = Buffer.from(actual.base64, 'base64');
      totalArtifactBytes += bytes.length;
      insist(bytes.toString('base64') === actual.base64 && bytes.length === entry.bytes &&
        bytes.length <= TASK_CAPS.artifactBytes && totalArtifactBytes <= TASK_CAPS.totalArtifactBytes &&
        actual.bytes === entry.bytes && actual.sha256 === entry.sha256 && sha256(bytes) === entry.sha256,
      'Trusted disk readback integrity mismatch', 'ARTIFACT_CAPTURE_FAILED');
      const filename = path.join(artifactRoot, ...entry.target.split('/'));
      noLinks(filename);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
      const stat = fs.lstatSync(filename);
      insist(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === entry.bytes &&
        sha256(fs.readFileSync(filename)) === entry.sha256, 'Trusted native disk readback integrity mismatch', 'ARTIFACT_CAPTURE_FAILED');
    }
    const capture = captureArtifacts({ artifactRoot, checks: declarations });
    const graded = gradeChecks({ checks: declarations, capture });
    receipt = {
      client: 'opencode', clientVersion: observed.clientVersion, executionId, task: spec.task,
      promptHash: audit.promptHash, image, transport: 'offline-mock', offlineEvidenceOnly: true,
      wireMessageHash: audit.wireMessageHash, promptEnvelope: audit.promptEnvelope,
      authenticationVerified: false, liveAccepted: false, status: 'completed', fresh: true,
      runtime: { clientVersion: observed.clientVersion, image, baseImage: BASE_IMAGE,
        publicDependencyImage: dependency.Id, publicDependencyManifestDigest: dependency.Descriptor?.digest ?? null,
        manifestDigest: metadata.Descriptor?.digest ?? null, dockerEngine: server.Version,
        nodeVersion: observed.versions.node, ripgrep: observed.versions.ripgrep,
        os: metadata.Os, architecture: metadata.Architecture, auth: 'synthetic-canary-only',
        authenticationVerified: false },
      trigger: audit.trigger, audit: audit.audit, denials: audit.denials, network: audit.network, isolation,
      artifacts: capture.artifacts, capture, checks: graded.checks, checkEvidence: graded.evidence,
      artifactReadback: { source: readback.source, transport: 'owned-docker-exec-filesystem-reader',
        files: observed.inventory, verified: true },
      nativeElapsedMs: observed.native.elapsedMs,
      nativeDiagnostics: { stderrBytes: observed.native.stderrBytes, stderrHash: observed.native.stderrHash },
      artifactWritesVerified: spec.mock.artifacts.length > 0,
      liveBlockers: ['Native live authentication has not been verified',
        'Live credential/tool and approved service-egress containment have not been independently accepted',
        'Offline receipts do not constitute v2 live acceptance or baseline approval']
    };
  } catch (error) {
    failure = error instanceof OfflineTaskError ? error :
      new OfflineTaskError('Offline task infrastructure failed', 'NATIVE_EXECUTION_INCOMPLETE');
  } finally {
    try {
      if (state) {
        const result = await cleanupOwnedWorkspace(state);
        if (receipt) receipt.cleanup = result;
      }
    } catch (error) { failure = error; }
    release();
  }
  if (failure) throw failure;
  const elapsedMs = performance.now() - start;
  return freeze({ ...receipt, elapsedMs,
    usage: {
      inputTokens: { value: null, provenance: 'unavailable' },
      outputTokens: { value: null, provenance: 'unavailable' },
      elapsedMs: { value: elapsedMs, provenance: 'supervised-host-monotonic-clock-including-build-and-cleanup' },
      usd: { value: null, provenance: 'unavailable' },
      credits: { value: null, provenance: 'unavailable' }
    } });
}
