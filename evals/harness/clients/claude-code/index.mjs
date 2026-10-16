import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessOfflineProbe } from './parser.mjs';
import { CLI_VERSION, NODE_VERSION, BASE_IMAGE, validateArtifactTargets } from './policy.mjs';
import { buildPinnedNativeImage } from './image.mjs';
export { parseClaudeEvents, assessOfflineProbe } from './parser.mjs';
export { buildRuntimeArguments, offlineSettings, validateArtifactTargets, CLI_VERSION, NODE_VERSION, BASE_IMAGE } from './policy.mjs';
export { runOfflineTask, OfflineTaskError, TASK_CAPS } from './task.mjs';
export { prepareNativeImage, describeNativeImage, cleanupNativeImage } from './image.mjs';
export { prepareNativeTaskSpecification, describeNativeTaskSpecification, parseNativeTaskEvidence } from './native.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const OWNER_LABEL = 'ai.skill-eval.claude-owner';
const MAX_BYTES = 2 * 1024 * 1024;

export function buildOfflineDockerArguments({ owner, name, image, arm, providerScenario = 'normal', artifactTargets = [] }) {
  const targets = validateArtifactTargets(artifactTargets);
  if (!/^[a-f0-9-]{36}$/.test(owner) || name !== `skill-eval-claude-${owner}-${arm}` ||
    !/^sha256:[a-f0-9]{64}$/.test(image) || !['candidate', 'no-skill'].includes(arm) ||
    !['normal', 'provider-error', 'stall'].includes(providerScenario)) {
    throw new Error('Invalid owned offline Docker arguments');
  }
  return ['run', '--name', name, '--label', `${OWNER_LABEL}=${owner}`,
    '--network', 'none', '--read-only', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '768m', '--cpus', '1', '--pids-limit', '64',
    '--tmpfs', '/workspace:rw,noexec,nosuid,size=16m,uid=1000,gid=1000',
    '--tmpfs', '/home/node:rw,noexec,nosuid,size=16m,uid=1000,gid=1000',
    '--tmpfs', '/probe:rw,noexec,nosuid,size=4m,uid=1000,gid=1000',
    '--tmpfs', '/private:rw,noexec,nosuid,size=4m,uid=1000,gid=1000',
    '--tmpfs', '/scratch:rw,noexec,nosuid,size=32m,uid=1000,gid=1000',
    image, arm, providerScenario, JSON.stringify(targets)];
}

function execute(args, { timeoutMs, signal, config }) {
  return new Promise(resolve => {
    const host = process.platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock';
    const child = spawn('docker', ['--config', config, '--host', host, ...args], {
      cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
    });
    let stdout = '', stderr = '', timedOut = false, cancelled = false, outputLimited = false;
    let bytes = 0, settled = false;
    const kill = () => child.kill('SIGKILL');
    const cancel = () => { cancelled = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    if (signal?.aborted) cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    function collect(stream, chunk) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) { outputLimited = true; kill(); return; }
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
    }
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve({ ...result, stdout, stderr, timedOut, cancelled, outputLimited });
    }
    child.on('error', error => finish({ code: null, error: error.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

function requireSuccess(result, phase) {
  if (result.code !== 0 || result.timedOut || result.cancelled || result.outputLimited) {
    const error = new Error(`Offline Claude ${phase} failed (${result.cancelled ? 'cancelled' :
      result.timedOut ? 'timeout' : result.outputLimited ? 'output-limit' : result.code}): ${result.stderr.slice(-2000)}`);
    error.code = result.cancelled ? 'CANCELLED' : result.timedOut ? 'TIMEOUT' : 'OFFLINE_PROBE_FAILED';
    throw error;
  }
  return result.stdout;
}

function inspectJson(result, phase) {
  const parsed = JSON.parse(requireSuccess(result, phase));
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error(`Invalid Docker ${phase}`);
  return parsed[0];
}

/** Builds and runs only the synthetic offline client probe; this never opens a live execution route. */
export async function runClaudeOfflineProbe({ timeoutMs = 120000, buildTimeoutMs = 300000,
  signal, capture = false, providerScenario = 'normal', artifactTargets = ['answer.md', 'message.txt'] } = {}) {
  const targets = validateArtifactTargets(artifactTargets);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000 ||
    !Number.isInteger(buildTimeoutMs) || buildTimeoutMs < 1000 || buildTimeoutMs > 600000 ||
    typeof capture !== 'boolean' || (signal !== undefined && !(signal instanceof AbortSignal)) ||
    !['normal', 'provider-error', 'stall'].includes(providerScenario)) {
    throw new Error('Bounded offline probe options required');
  }
  if (signal?.aborted) { const error = new Error('Offline probe cancelled'); error.code = 'CANCELLED'; throw error; }
  const owner = randomUUID(), tag = `skill-eval-claude-${owner}`;
  const runDirectory = path.join(directory, '.runs', owner), config = path.join(runDirectory, 'docker-config');
  fs.mkdirSync(config, { recursive: true });
  const docker = (args, options = {}) => execute(args, { timeoutMs: 15000, config, ...options });
  const containers = [];
  let image = null, report, cleanupFailed = false;
  try {
    const { spec, engineVersion } = await buildPinnedNativeImage({ docker, owner, tag,
      timeoutMs: buildTimeoutMs, signal, requireResult: requireSuccess });
    image = spec.Id;
    const arms = {};
    for (const arm of ['candidate', 'no-skill']) {
      const name = `skill-eval-claude-${owner}-${arm}`;
      containers.push(name);
      const output = await docker(buildOfflineDockerArguments({ owner, name, image, arm, providerScenario,
        artifactTargets: targets }), { timeoutMs, signal });
      const container = inspectJson(await docker(['container', 'inspect', name]), 'container inspect');
      const host = container.HostConfig;
      if (container.Config.Labels?.[OWNER_LABEL] !== owner || container.Image !== image ||
        host.NetworkMode !== 'none' || !host.ReadonlyRootfs || container.Config.User !== '1000:1000' ||
        host.Binds?.length || container.Mounts.length || host.Privileged || host.PidMode || host.IpcMode === 'host' ||
        host.PidsLimit !== 64 || host.Memory !== 768 * 1024 * 1024 ||
        !host.CapDrop.includes('ALL') || !host.SecurityOpt.includes('no-new-privileges')) {
        throw new Error('Actual container boundary differs from offline specification');
      }
      const raw = JSON.parse(requireSuccess(output, arm));
      if (raw.nodeVersion !== NODE_VERSION) throw new Error('Actual Node runtime drift');
      const parsed = assessOfflineProbe(raw);
      arms[arm] = { ...parsed, image, nodeVersion: raw.nodeVersion, actualClientVersion: raw.version,
        workspace: { cwd: '/workspace', home: '/home/node', fresh: true, containerId: container.Id },
        boundary: { network: host.NetworkMode, readOnly: host.ReadonlyRootfs, user: container.Config.User,
          mounts: container.Mounts, memory: host.Memory, pids: host.PidsLimit, capDrop: host.CapDrop,
          securityOpt: host.SecurityOpt, tmpfs: host.Tmpfs }, raw };
    }
    report = { client: 'claude-code', clientVersion: CLI_VERSION, transport: 'offline-mock', live: false, providerScenario,
      mockProvider: true, realQuality: false, accepted: arms.candidate.accepted && arms['no-skill'].accepted,
      pilotWritesVerified: targets.length > 0 && arms.candidate.accepted && arms['no-skill'].accepted &&
        arms.candidate.artifactsPassed && arms['no-skill'].artifactsPassed,
      requestedArtifactTargets: targets, liveAccepted: false, qualityEvaluated: false,
      image, imageSpec: { id: image, repoDigests: spec.RepoDigests, baseImage: BASE_IMAGE,
        os: spec.Os, architecture: spec.Architecture, nodeVersion: NODE_VERSION, engineVersion },
      candidate: arms.candidate, control: arms['no-skill'],
      liveBlockers: arms.candidate.liveBlockers };
  } finally {
    for (const name of containers) {
      const inspected = await docker(['container', 'inspect', name]);
      if (inspected.code !== 0) continue;
      const container = inspectJson(inspected, 'cleanup container inspect');
      if (container.Config.Labels?.[OWNER_LABEL] !== owner) { cleanupFailed = true; continue; }
      const removed = await docker(['container', 'rm', '--force', container.Id]);
      if (removed.code !== 0 || (await docker(['container', 'inspect', container.Id])).code === 0) cleanupFailed = true;
    }
    const imageInspection = await docker(['image', 'inspect', tag]);
    if (imageInspection.code === 0) {
      const spec = inspectJson(imageInspection, 'cleanup image inspect');
      if (spec.Config.Labels?.[OWNER_LABEL] !== owner || (image && spec.Id !== image)) cleanupFailed = true;
      else if ((await docker(['image', 'rm', tag])).code !== 0 ||
        (await docker(['image', 'inspect', tag])).code === 0 ||
        (await docker(['image', 'inspect', spec.Id])).code === 0) cleanupFailed = true;
    }
    fs.rmSync(runDirectory, { recursive: true, force: true });
    if (fs.existsSync(runDirectory)) cleanupFailed = true;
    if (cleanupFailed) throw new Error('Offline owned-resource cleanup failed');
  }
  report.cleanup = { scoped: true, containersRemoved: true, imageTagRemoved: true, hostConfigRemoved: true };
  if (capture) {
    const destination = path.join(directory, 'fixtures');
    fs.mkdirSync(destination, { recursive: true });
    for (const [arm, value] of [['candidate', report.candidate], ['no-skill', report.control]]) {
      const prefix = providerScenario === 'normal' ? arm : `${providerScenario}-${arm}`;
      fs.writeFileSync(path.join(destination, `${prefix}.actual.json`), `${JSON.stringify({
        ...value.raw, image: report.image, imageSpec: report.imageSpec, boundary: value.boundary,
        workspace: value.workspace, cleanup: report.cleanup
      }, null, 2)}\n`);
      fs.writeFileSync(path.join(destination, `${prefix}.actual.jsonl`), value.raw.stdout);
    }
  }
  return report;
}

export async function runOfflineProbe({ timeoutMs = 120000, artifactTargets = ['answer.md', 'message.txt'] } = {}) {
  const targets = validateArtifactTargets(artifactTargets);
  if (targets.length === 0) throw new Error('Pilot offline probe requires at least one strict artifact target');
  const report = await runClaudeOfflineProbe({ timeoutMs, artifactTargets: targets });
  if (!report.accepted || !report.pilotWritesVerified || !report.candidate.artifactsPassed || !report.control.artifactsPassed) {
    const error = new Error('Actual Claude offline discovery/control/artifact/denial checks failed');
    error.code = 'OFFLINE_PROBE_NOT_ACCEPTED';
    error.report = report;
    throw error;
  }
  return report;
}
