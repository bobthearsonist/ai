import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { captureArtifacts, gradeChecks, validateChecks } from '../../checks/index.mjs';
import { hashObject } from '../../index.mjs';
import { CLI_VERSION, NODE_VERSION, BASE_IMAGE } from './policy.mjs';
import {
  TASK_PROTOCOL, TASK_CAPS, OfflineTaskError, insist, exactKeys, freeze,
  validateCoordinates, textBytes, prepareFiles, validateSkill,
  publicFixturePath, validatePaths, prepareMock, taskTmpfs, sha256
} from './task-policy.mjs';
import { assessTaskExecution, verifyCapturedReadback } from './task-evidence.mjs';
import { runOwnedDocker as dockerCommand } from './docker.mjs';
import { buildPinnedNativeImage } from './image.mjs';

export { OfflineTaskError, TASK_CAPS } from './task-policy.mjs';
const directory = fileURLToPath(new URL('.', import.meta.url));
const OWNER_LABEL = 'ai.skill-eval.claude-owner';
const payloadCap = TASK_CAPS.sourceBytes + TASK_CAPS.mockBytes + TASK_CAPS.promptBytes;

/** Snapshot public bytes synchronously; check declarations never enter the native payload. */
export function prepareOfflineTask(options) {
  exactKeys(options, ['task', 'prompt', 'skill', 'inputs', 'checks', 'mock', 'timeoutMs'], 'offline task option');
  const task = validateCoordinates(options.task);
  insist(typeof options.prompt === 'string' && options.prompt.trim(), 'A nonempty caller prompt is required');
  const prompt = textBytes(options.prompt, TASK_CAPS.promptBytes, 'Prompt').text;
  const timeoutMs = options.timeoutMs ?? 180000;
  insist(Number.isInteger(timeoutMs) && timeoutMs >= TASK_CAPS.minTimeoutMs &&
    timeoutMs <= TASK_CAPS.maxTimeoutMs, 'Bounded task timeout must be 1000..300000 ms');
  insist(Array.isArray(options.checks) && options.checks.length <= TASK_CAPS.checks, 'Bounded hard-check declarations required');
  const checks = validateChecks(options.checks);
  insist(Buffer.byteLength(JSON.stringify(checks)) <= TASK_CAPS.checkBytes, 'Host-only check declaration byte cap exceeded');
  const targets = [...new Set(checks.filter(check => check.type.startsWith('artifact-'))
    .map(check => publicFixturePath(check.target)))];
  insist(targets.length <= TASK_CAPS.outputs, 'Declared artifact target count cap exceeded');
  const skill = validateSkill(options.skill, task.arm);
  const inputs = prepareFiles(options.inputs ?? []);
  const sources = [
    ...skill.files.map(file => ({ ...file, kind: 'skill', absolute: `/workspace/.claude/skills/${skill.id}/${file.path}` })),
    ...inputs.map(file => ({ ...file, kind: 'input',
      absolute: `${file.mountRoot === 'home' ? '/home/node' : '/workspace'}/${file.path}` }))
  ];
  insist(sources.length <= TASK_CAPS.files && sources.reduce((sum, source) => sum + source.bytes, 0) <= TASK_CAPS.sourceBytes,
    'Source file count or aggregate byte cap exceeded');
  validatePaths(sources, targets);
  taskTmpfs(sources, targets);
  const mock = prepareMock(options.mock, targets);
  return { task, prompt, skillId: skill.id, sources, targets, mock, checks, timeoutMs };
}

export function nativeTaskPayload(prepared, executionId) {
  const payload = {
    protocol: TASK_PROTOCOL, executionId, task: prepared.task, timeoutMs: prepared.timeoutMs,
    prompt: prepared.prompt, skillId: prepared.skillId, targets: prepared.targets,
    sources: prepared.sources.map(({ path: target, absolute, kind, mountRoot, bytes, sha256, executable }) =>
      ({ path: target, absolute, kind, mountRoot, bytes, sha256, executable })),
    mock: prepared.mock
  };
  insist(Buffer.byteLength(JSON.stringify(payload)) <= payloadCap, 'Serialized public native task input cap exceeded');
  return freeze(payload);
}

export function offlineTaskUsage(elapsedMs) {
  insist(Number.isFinite(elapsedMs) && elapsedMs >= 0,
    'Trusted elapsed time must be finite nonnegative milliseconds', 'OFFLINE_TASK_METRIC_FAILED');
  const unavailable = { value: null, provenance: 'unavailable' };
  return freeze({
    inputTokens: { ...unavailable }, outputTokens: { ...unavailable },
    elapsedMs: { value: elapsedMs, provenance: 'trusted-host-monotonic-build-native-capture-cleanup' },
    usd: { ...unavailable }, credits: { ...unavailable }
  });
}

function assertNoLinks(filename) {
  let current = path.resolve(filename);
  for (;;) {
    if (fs.existsSync(current)) insist(!fs.lstatSync(current).isSymbolicLink(),
      'Symlink/reparse point in owned task path', 'OFFLINE_TASK_OWNERSHIP_FAILED');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function successful(result, phase, executionId) {
  insist(result.code === 0 && !result.timedOut && !result.outputLimited,
    `Offline native task ${phase} failed (${result.timedOut ? 'timeout' : result.outputLimited ? 'output-limit' : result.code})`,
    result.timedOut ? 'OFFLINE_TASK_TIMEOUT' : result.outputLimited ? 'OFFLINE_TASK_OUTPUT_LIMIT' : 'OFFLINE_TASK_INFRASTRUCTURE',
    { executionId, phase, evidence: { code: result.code, signal: result.signal ?? null,
      error: result.error ?? null, stderr: result.stderr.slice(-2000) } });
  return result.stdout;
}

function inspected(result, phase, executionId) {
  const values = JSON.parse(successful(result, phase, executionId));
  insist(Array.isArray(values) && values.length === 1, `Invalid task Docker ${phase}`,
    'OFFLINE_TASK_INFRASTRUCTURE', { executionId, phase });
  return values[0];
}

function stageSources(prepared, runDirectory) {
  const mounts = [];
  const skillRoot = path.join(runDirectory, 'seeds', 'skill');
  for (const [index, source] of prepared.sources.entries()) {
    const filename = source.kind === 'skill'
      ? path.join(skillRoot, ...source.path.split('/'))
      : path.join(runDirectory, 'seeds', 'inputs', `${index}.seed`);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, source.content, { flag: 'wx', mode: source.executable ? 0o555 : 0o444 });
    assertNoLinks(filename);
    insist(sha256(fs.readFileSync(filename)) === source.sha256, 'Owned task seed byte integrity failure',
      'OFFLINE_TASK_OWNERSHIP_FAILED');
    if (source.kind === 'input') mounts.push({ source: filename, destination: source.absolute });
  }
  if (prepared.sources.some(source => source.kind === 'skill')) {
    mounts.push({ source: skillRoot, destination: `/workspace/.claude/skills/${prepared.skillId}` });
  }
  return mounts;
}

function runtimeDockerArgs({ executionId, name, image, mounts, tmpfs }) {
  return ['run', '--interactive', '--name', name, '--label', `${OWNER_LABEL}=${executionId}`,
    '--network', 'none', '--read-only', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '768m', '--cpus', '1', '--pids-limit', '64', '--log-driver', 'none',
    ...Object.entries(tmpfs).flatMap(([target, size]) => ['--tmpfs', `${target}:rw,noexec,nosuid,size=${size},uid=1000,gid=1000`]),
    ...mounts.flatMap(mount => ['--mount',
      `type=bind,source=${mount.source},target=${mount.destination},readonly,bind-recursive=disabled`]),
    '--entrypoint', 'node', image, '/opt/client/task-runtime.mjs'];
}

function verifyBoundary(container, mounts, tmpfs, image, executionId) {
  const host = container.HostConfig;
  insist(container.Config.Labels?.[OWNER_LABEL] === executionId && container.Image === image &&
    host.NetworkMode === 'none' && host.ReadonlyRootfs && container.Config.User === '1000:1000' &&
    !host.Binds?.length && !host.Privileged && !host.PidMode && host.IpcMode !== 'host' &&
    host.PidsLimit === 64 && host.Memory === 768 * 1024 * 1024 && host.NanoCpus === 1000000000 &&
    host.CapDrop.includes('ALL') && host.SecurityOpt.includes('no-new-privileges') &&
    host.LogConfig.Type === 'none' && container.Mounts.length === mounts.length &&
    container.Mounts.every(mount => mount.Type === 'bind' && mount.RW === false &&
      mounts.some(submitted => submitted.destination === mount.Destination)),
  'Actual native task boundary differs from the pinned offline specification',
  'OFFLINE_TASK_BOUNDARY_FAILED', { executionId });
  insist(Object.keys(host.Tmpfs).length === Object.keys(tmpfs).length &&
    Object.entries(tmpfs).every(([target, size]) =>
      ['rw', 'noexec', 'nosuid', `size=${size}`, 'uid=1000', 'gid=1000']
        .every(option => host.Tmpfs[target]?.split(',').includes(option))),
  'Actual native task scratch boundary differs', 'OFFLINE_TASK_BOUNDARY_FAILED', { executionId });
  return freeze({ network: 'none', readOnly: true, user: container.Config.User,
    memory: host.Memory, pids: host.PidsLimit, nanoCpus: host.NanoCpus,
    capDrop: host.CapDrop, securityOpt: host.SecurityOpt, logging: host.LogConfig.Type,
    tmpfs: host.Tmpfs, sourceMounts: container.Mounts.map(mount => ({
      destination: mount.Destination, readOnly: !mount.RW, type: mount.Type
    })) });
}

async function cleanupOwned({ docker, name, tag, image, executionId, runDirectory }) {
  const failures = [];
  for (const [kind, reference] of [['container', name], ['image', tag]]) {
    const result = await docker([kind, 'inspect', reference]);
    if (result.code !== 0) {
      if (!/No such (?:object|container|image)/i.test(result.stderr)) failures.push(`${kind} absence unverified: ${result.stderr.slice(-500)}`);
      continue;
    }
    const resource = inspected(result, `cleanup ${kind} inspect`, executionId);
    if (resource.Config.Labels?.[OWNER_LABEL] !== executionId || (kind === 'image' && image && resource.Id !== image)) {
      failures.push(`${kind} ownership mismatch`);
      continue;
    }
    const removed = await docker(kind === 'container' ? ['container', 'rm', '--force', resource.Id] : ['image', 'rm', tag]);
    if (removed.code !== 0 || (await docker([kind, 'inspect', reference])).code === 0 ||
      (await docker([kind, 'inspect', resource.Id])).code === 0) failures.push(`${kind} removal unverified`);
  }
  assertNoLinks(runDirectory);
  const marker = JSON.parse(fs.readFileSync(path.join(runDirectory, '.owner.json'), 'utf8'));
  insist(marker.executionId === executionId, 'Refusing cleanup of a foreign task workspace', 'OFFLINE_TASK_OWNERSHIP_FAILED');
  fs.rmSync(runDirectory, { recursive: true, force: true });
  if (fs.existsSync(runDirectory)) failures.push('Owned host task directory still exists');
  insist(failures.length === 0, `Owned native task cleanup failed: ${failures.join('; ')}`,
    'OFFLINE_TASK_CLEANUP_FAILED', { executionId });
  return freeze({ scoped: true, containersRemoved: true, imageTagRemoved: true,
    hostConfigRemoved: true, sourceSeedsRemoved: true, artifactReadbackRemoved: true });
}

async function launchTask(prepared, executionId, payload) {
  const start = performance.now();
  const runDirectory = path.join(directory, '.runs', `task-${executionId}`);
  const config = path.join(runDirectory, 'docker-config');
  const name = `skill-eval-claude-task-${executionId}`;
  const tag = name;
  assertNoLinks(runDirectory);
  fs.mkdirSync(runDirectory, { recursive: true });
  fs.writeFileSync(path.join(runDirectory, '.owner.json'), JSON.stringify({ executionId, task: prepared.task }), { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(config);
  const docker = (args, options = {}) => dockerCommand(args, { config, ...options });
  let image = null, receipt, primaryError, cleanup;
  try {
    const { spec, engineVersion } = await buildPinnedNativeImage({ docker, owner: executionId, tag,
      timeoutMs: TASK_CAPS.buildTimeoutMs, requireResult: successful });
    image = spec.Id;
    const mounts = stageSources(prepared, runDirectory);
    const tmpfs = taskTmpfs(prepared.sources, prepared.targets);
    const output = await docker(runtimeDockerArgs({ executionId, name, image, mounts, tmpfs }),
      { timeoutMs: prepared.timeoutMs, input: JSON.stringify(payload) });
    const container = inspected(await docker(['container', 'inspect', name]), 'container inspect', executionId);
    const boundary = verifyBoundary(container, mounts, tmpfs, image, executionId);
    const raw = JSON.parse(successful(output, 'native runtime', executionId));
    const assessed = assessTaskExecution(raw, prepared, executionId);
    const artifactRoot = path.join(runDirectory, 'artifact-readback');
    fs.mkdirSync(artifactRoot);
    for (const artifact of raw.artifacts.filter(artifact => artifact.state === 'present')) {
      const filename = path.join(artifactRoot, ...artifact.target.split('/'));
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, Buffer.from(artifact.base64, 'base64'), { flag: 'wx', mode: 0o444 });
    }
    const capture = captureArtifacts({ artifactRoot, checks: prepared.checks });
    verifyCapturedReadback(capture, raw.artifacts, executionId);
    const graded = gradeChecks({ checks: prepared.checks, capture });
    const rawCapture = freeze({
      protocol: TASK_PROTOCOL, executionId, image, transport: 'offline-mock',
      offlineEvidenceOnly: true, authenticationVerified: false, liveAccepted: false,
      nativeSessionId: assessed.nativeSessionId,
      prompt: assessed.promptCapture,
      firstRequest: raw.firstRequest, wire: raw.wire, events: assessed.events,
      sourceState: raw.sourceState, sourceEvidence: assessed.sourceEvidence,
      artifactEvidence: assessed.artifactEvidence, denialEvidence: assessed.denialEvidence,
      stderr: raw.stderr
    });
    const captureHash = hashObject(rawCapture);
    const evidence = [{ kind: 'discovery-audit', skill: prepared.skillId,
      ref: `claude-task:sha256:${captureHash}:discovery` }];
    for (const toolUseId of assessed.trigger.toolUseIds) evidence.push({
      kind: 'skill-load', skill: prepared.skillId, ref: `claude-task:sha256:${captureHash}:${toolUseId}`
    });
    receipt = {
      client: 'claude-code', clientVersion: CLI_VERSION, executionId, task: prepared.task,
      image, imageSpec: { id: image, repoDigests: spec.RepoDigests, baseImage: BASE_IMAGE,
        nodeVersion: NODE_VERSION, engineVersion, os: spec.Os, architecture: spec.Architecture },
      promptHash: assessed.promptHash, status: 'completed',
      transport: 'offline-mock', offlineEvidenceOnly: true,
      authenticationVerified: false, liveAccepted: false,
      runtime: { clientVersion: CLI_VERSION, actualVersion: raw.version, image, nodeVersion: NODE_VERSION,
        engineVersion, auth: 'none-offline', authenticationVerified: false, isolationEvidence: captureHash },
      trigger: { ...assessed.trigger, evidence },
      artifacts: capture.artifacts, capture, checks: graded.checks, checkEvidence: graded.evidence,
      rawCapture, rawCaptureHash: captureHash, completion: assessed.completion,
      workspace: { fresh: true, cwd: '/workspace', home: '/home/node',
        nativeSessionId: assessed.nativeSessionId, containerId: container.Id },
      boundary, safety: { denialPassed: true, sourceBytesUnchanged: true, sourceMountsReadOnly: true,
        rawCanaryObserved: false, toolSurfacePassed: true },
      mock: { classification: 'scripted-local-inference-fixture-not-a-grader-or-actual-model-behavior',
        requests: raw.requests, reportedUsage: assessed.events.at(-1)?.usage ?? null }
    };
  } catch (error) {
    primaryError = error instanceof OfflineTaskError ? error :
      new OfflineTaskError(error.message, 'OFFLINE_TASK_INFRASTRUCTURE', { executionId });
  }
  try {
    cleanup = await cleanupOwned({ docker, name, tag, image, executionId, runDirectory });
  } catch (error) {
    const cleanupError = error instanceof OfflineTaskError ? error :
      new OfflineTaskError(error.message, 'OFFLINE_TASK_CLEANUP_FAILED', { executionId });
    if (primaryError) {
      primaryError.cleanupError = { code: cleanupError.code, message: cleanupError.message };
      throw primaryError;
    }
    throw cleanupError;
  }
  if (primaryError) { primaryError.cleanup = cleanup; throw primaryError; }
  const elapsedMs = performance.now() - start;
  return freeze({
    ...receipt, cleanup, elapsedMs,
    usage: offlineTaskUsage(elapsedMs)
  });
}

/**
 * Validate and snapshot synchronously, then execute exactly one fresh actual native
 * session. This receipt is offline evidence, never v2 live acceptance.
 */
export function runOfflineTask(options) {
  const prepared = prepareOfflineTask(options);
  const executionId = randomUUID();
  const payload = nativeTaskPayload(prepared, executionId);
  return launchTask(prepared, executionId, payload);
}
