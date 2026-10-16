import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../../isolation/index.mjs';
import { normalizeCopilotOutcome, assessDenials, assessArtifacts } from './parser.mjs';
import { buildCopilotArguments } from './config.mjs';
import { assertTaskPayload } from './task-policy.mjs';
export { buildCopilotArguments } from './config.mjs';
export { parseCopilotEvents, normalizeCopilotOutcome, assessDenials, assessArtifacts } from './parser.mjs';
export { runOfflineTask } from './task.mjs';
export { prepareNativeTaskSpecification } from './native-spec.mjs';
export { parseNativeTaskEvidence, readNativeTaskArtifact } from './native-parser.mjs';
export { buildOfflineImage as buildNativeImage, cleanupOfflineImage as cleanupNativeImage };

export const VERSION = '1.0.92';
export const BASE_IMAGE = 'node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d';
export const CANARY = 'synthetic-offline-copilot-canary-not-a-secret';
const root = path.dirname(fileURLToPath(import.meta.url));
const label = 'ai.skill-eval.copilot';
const handles = new WeakSet();
export class CopilotError extends Error {
  constructor(code, message = code) { super(message); this.code = code; this.failureClass = 'infrastructure'; }
}

export function describeNativeImage(owned) {
  if (!handles.has(owned)) throw new CopilotError('OWNERSHIP');
  return Object.freeze({
    client: 'copilot', clientVersion: VERSION, image: owned.image, baseImage: BASE_IMAGE,
    invocationId: owned.id, provenance: 'original-owned-inspected-image-handle',
    authenticationVerified: false, liveAccepted: false
  });
}

function command(args, { seconds = 30, signal, env, input, rawCapture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true, env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let bytes = 0, done = false;
    const chunks = { stdout: [], stderr: [] };
    const finish = (error, result) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); child.unref(); reject(error); }
      else resolve(result);
    };
    const abort = () => finish(new CopilotError('CANCELLED'));
    const timer = setTimeout(() => finish(new CopilotError('TIMEOUT')), seconds * 1000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (input) {
      child.stdin.on('error', () => finish(new CopilotError('DOCKER_INPUT_FAILED')));
      child.stdin.end(input);
    }
    for (const key of ['stdout', 'stderr']) child[key].on('data', b => {
      bytes += b.length;
      if (bytes > 1024 * 1024) finish(new CopilotError('OUTPUT_LIMIT'));
      else chunks[key].push(b);
    });
    child.on('error', () => finish(new CopilotError('DOCKER_UNAVAILABLE')));
    child.on('close', exitCode => {
      const stdout = Buffer.concat(chunks.stdout).toString(), stderr = Buffer.concat(chunks.stderr).toString();
      finish(null, { exitCode,
        stdout: rawCapture ? stdout : redact(stdout, [CANARY]),
        stderr: rawCapture ? stderr : redact(stderr, [CANARY]) });
    });
  });
}

export async function buildOfflineImage({ timeoutMs = 300000, signal } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new CopilotError('LIMIT');
  const id = randomUUID();
  const directory = path.join(root, `.owned-${id}`);
  fs.mkdirSync(directory);
  const env = dockerEnv(directory);
  const tag = `skill-eval-copilot-${id}`;
  try {
    const result = await command(['build', '--pull=false', '--label', `${label}=${id}`, '-t', tag, root], { seconds: timeoutMs / 1000, env, signal });
    if (result.exitCode) throw new CopilotError('BUILD_FAILED', result.stderr.slice(-1000));
    const inspected = await command(['image', 'inspect', tag], { env });
    const [image] = JSON.parse(inspected.stdout);
    if (image.Config.Labels?.[label] !== id || image.Os !== 'linux' || image.Architecture !== 'amd64') throw new CopilotError('OWNERSHIP');
    const handle = Object.freeze({ id, image: image.Id, tag, directory, env: Object.freeze(env) });
    handles.add(handle);
    return handle;
  } catch (e) {
    const check = await command(['image', 'inspect', tag], { env });
    if (check.exitCode === 0) {
      const [image] = JSON.parse(check.stdout);
      if (image.Config.Labels?.[label] !== id) throw new CopilotError('OWNERSHIP');
      const removed = await command(['image', 'rm', tag], { env });
      const absent = await command(['image', 'inspect', image.Id], { env });
      if (removed.exitCode || absent.exitCode === 0 || !/No such/i.test(absent.stderr)) {
        throw new CopilotError('CLEANUP_FAILED');
      }
    } else if (!/No such/i.test(check.stderr)) throw new CopilotError('CLEANUP_FAILED');
    fs.rmSync(directory, { recursive: true, force: true });
    throw e;
  }
}

function dockerEnv(directory) {
  const env = { DOCKER_CONFIG: directory, DOCKER_HOST: process.platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

export async function runOfflineContainer(owned, { mode = 'probe', seconds = 60, signal, artifactTargets = [], payload } = {}) {
  if (mode === 'task') assertTaskPayload(payload);
  else buildCopilotArguments({ artifactTargets });
  if (!handles.has(owned)) throw new CopilotError('OWNERSHIP');
  if (!['probe', 'task', 'candidate', 'control', 'attacks', 'candidate-write', 'control-write', 'attacks-write', 'auth-error', 'tool-error', 'hang'].includes(mode)) throw new CopilotError('MODE');
  if (!(seconds > 0 && seconds <= (mode === 'task' ? 300 : 180))) throw new CopilotError('LIMIT');
  if (signal?.aborted) throw new CopilotError('CANCELLED');
  const name = `skill-eval-copilot-${randomUUID()}`;
  const args = ['create', '--pull', 'never', ...(mode === 'task' ? ['--interactive'] : []),
    '--name', name, '--label', `${label}=${owned.id}`,
    '--network', 'none', '--read-only', '--user', '10001:10001', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges=true', '--init', '--memory', '768m', '--memory-swap', '768m',
    '--cpus', '1', '--pids-limit', '96', '--ulimit', 'nofile=256:256', '--ulimit', 'fsize=2097152:2097152',
    '--ipc', 'none', '--log-driver', 'none', '--workdir', '/workspace',
    '--tmpfs', '/workspace:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700',
    '--tmpfs', '/home/eval:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=700',
    '--tmpfs', '/client-config:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001,mode=700',
    '--tmpfs', '/scratch:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001,mode=700',
    '--env', 'HOME=/home/eval', '--env', 'COPILOT_HOME=/client-config/copilot',
    '--env', 'TMPDIR=/scratch', '--entrypoint', 'node', owned.image,
    `/opt/fixture/${mode === 'probe' ? 'probe' : mode === 'task' ? 'task-runtime' : 'runtime'}.mjs`,
    ...(mode === 'task' ? [] : [mode, JSON.stringify(artifactTargets)])];
  let created = false;
  try {
    const version = await command(['version', '--format', '{{json .Server}}'], { env: owned.env });
    const server = JSON.parse(version.stdout);
    if (server.Version !== '29.7.2' || server.Os !== 'linux' || server.Arch !== 'amd64') throw new CopilotError('ENGINE_DRIFT');
    created = true;
    const creation = await command(args, { env: owned.env });
    if (creation.exitCode) throw new CopilotError('CREATE_FAILED', creation.stderr);
    const inspected = await command(['inspect', name], { env: owned.env });
    const [container] = JSON.parse(inspected.stdout);
    const h = container.HostConfig;
    if (container.Config.Labels?.[label] !== owned.id || container.Image !== owned.image ||
        h.NetworkMode !== 'none' || !h.ReadonlyRootfs || container.Config.User !== '10001:10001' ||
        container.Mounts.some(m => m.Type === 'bind') || h.Privileged || h.Memory !== 805306368 ||
        h.MemorySwap !== 805306368 || h.PidsLimit !== 96 || h.NanoCpus !== 1000000000 ||
        h.LogConfig.Type !== 'none' || h.IpcMode !== 'none' ||
        Object.keys(h.Tmpfs).sort().join(',') !== '/client-config,/home/eval,/scratch,/workspace' ||
        Object.values(h.Tmpfs).some(v => !['rw', 'noexec', 'nosuid', 'nodev', 'uid=10001', 'gid=10001', 'mode=700'].every(f => v.split(',').includes(f))) ||
        !h.CapDrop.some(c => ['ALL', 'CAP_ALL'].includes(c)) || !h.SecurityOpt.includes('no-new-privileges=true')) {
      throw new CopilotError('CONFINEMENT');
    }
    const output = await command(['start', '--attach', ...(mode === 'task' ? ['--interactive'] : []), name],
      { env: owned.env, seconds, signal,
        ...(mode === 'task' ? { input: Buffer.from(JSON.stringify(payload)), rawCapture: true } : {}) });
    return { ...output, image: owned.image, engine: '29.7.2', network: 'none', cleanup: 'verified', name };
  } finally {
    if (created) {
      const check = await command(['inspect', name], { env: owned.env });
      if (check.exitCode !== 0) {
        if (!/No such/i.test(check.stderr)) throw new CopilotError('CLEANUP_FAILED');
      } else {
        const [c] = JSON.parse(check.stdout);
        if (c.Config.Labels?.[label] !== owned.id) throw new CopilotError('OWNERSHIP');
        const removed = await command(['rm', '--force', name], { env: owned.env });
        const absent = await command(['inspect', name], { env: owned.env });
        if (removed.exitCode || absent.exitCode === 0 || !/No such/i.test(absent.stderr)) throw new CopilotError('CLEANUP_FAILED', JSON.stringify({ removed, absent }));
      }
    }
  }
}

export async function cleanupOfflineImage(owned) {
  if (!handles.has(owned)) throw new CopilotError('OWNERSHIP');
  const check = await command(['image', 'inspect', owned.tag], { env: owned.env });
  const [image] = JSON.parse(check.stdout);
  if (image.Config.Labels?.[label] !== owned.id || image.Id !== owned.image) throw new CopilotError('OWNERSHIP');
  const removed = await command(['image', 'rm', owned.tag], { env: owned.env });
  if (removed.exitCode) throw new CopilotError('CLEANUP_FAILED', removed.stderr);
  const absent = await command(['image', 'inspect', owned.image], { env: owned.env });
  if (absent.exitCode === 0 || !/No such/i.test(absent.stderr)) throw new CopilotError('CLEANUP_FAILED');
  fs.rmSync(owned.directory, { recursive: true, force: true });
  handles.delete(owned);
}

export function requireLiveProfile() {
  throw new CopilotError('LIVE_BOUNDARY_UNVERIFIED', 'Live execution requires verified direct-provider egress/tool containment, explicit paid consent, narrow credentials and exact approved baseline. Offline fixture evidence does not unlock it.');
}

export async function runOfflineProbe({ timeoutMs = 300000, artifactTargets = ['answer.md', 'message.txt'] } = {}) {
  buildCopilotArguments({ artifactTargets });
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new CopilotError('LIMIT');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let owned;
  try {
    owned = await buildOfflineImage({ timeoutMs, signal: controller.signal });
    const probe = await runOfflineContainer(owned, { mode: 'probe', seconds: 120, signal: controller.signal });
    if (probe.exitCode !== 0) throw new CopilotError('RUNTIME_PROBE_FAILED');
    const capabilities = probe.stdout.trim().split('\n').map(JSON.parse);
    if (capabilities.length !== 4 || capabilities.some(c => c.status !== 0) ||
      !/^GitHub Copilot CLI 1\.0\.92\./.test(capabilities[0].stdout)) throw new CopilotError('RUNTIME_DRIFT');
    const help = capabilities[1].stdout, providers = capabilities[2].stdout;
    for (const flag of ['--output-format', '--usage-output-file', '--available-tools', '--deny-tool',
      '--disallow-temp-dir', '--no-custom-instructions', '--no-auto-update', '--no-ask-user',
      '--disable-builtin-mcps', '--secret-env-vars']) {
      if (!help.includes(flag)) throw new CopilotError('CAPABILITY_MISSING');
    }
    if (!providers.includes('COPILOT_PROVIDER_BASE_URL') || !providers.includes('GitHub authentication is not required')) throw new CopilotError('BYOK_UNAVAILABLE');
    const records = {};
    for (const mode of ['candidate', 'control', 'attacks', ...(artifactTargets.length ? ['candidate-write', 'control-write', 'attacks-write'] : [])]) {
      const output = await runOfflineContainer(owned, { mode, seconds: 120, signal: controller.signal,
        artifactTargets: mode.endsWith('-write') ? artifactTargets : [] });
      if (output.exitCode !== 0) throw new CopilotError('RUNTIME_FAILED', output.stderr.slice(0, 1000));
      const record = JSON.parse(output.stdout);
      if (record.transport !== 'offline-mock/not-live' || record.clientVersion !== VERSION ||
          record.nodeVersion !== '22.22.1' || !record.freshWorkspace) throw new CopilotError('RUNTIME_DRIFT');
      records[mode] = { record, outcome: normalizeCopilotOutcome({ ...record, image: owned.image }), container: output };
    }
    const { candidate, control, attacks } = records;
    const denial = assessDenials(attacks.record, attacks.outcome);
    if (!candidate.outcome.trigger.loaded || !candidate.outcome.fixtureRead.succeeded ||
      candidate.outcome.completion.status !== 'completed' ||
      !candidate.record.provider.requestShapes.some(r => r.skillContextSeen)) throw new CopilotError('TRIGGER_NOT_VERIFIED');
    if (control.outcome.trigger.discovered || control.outcome.trigger.loaded ||
      control.record.skillPresent || !control.outcome.fixtureRead.succeeded ||
      control.outcome.completion.status !== 'completed') throw new CopilotError('CONTROL_FAILED');
    if (!denial.accepted) throw new CopilotError('DENIAL_FAILED', JSON.stringify(denial));
    const writePositive = records['candidate-write'], writeControl = records['control-write'], writeAttacks = records['attacks-write'];
    const artifacts = writePositive ? assessArtifacts(writePositive.record, writePositive.outcome) : null;
    const writeDenial = writeAttacks ? assessDenials(writeAttacks.record, writeAttacks.outcome) : null;
    if (artifactTargets.length && (!artifacts.accepted || !assessArtifacts(writeControl.record, writeControl.outcome).accepted ||
      !writePositive.outcome.trigger.loaded || writePositive.outcome.completion.status !== 'completed' ||
      writeControl.outcome.trigger.discovered || writeControl.outcome.trigger.loaded ||
      writeControl.outcome.completion.status !== 'completed')) throw new CopilotError('ARTIFACT_FAILED');
    if (artifactTargets.length && !writeDenial.accepted) throw new CopilotError('WRITE_DENIAL_FAILED', JSON.stringify(writeDenial));
    for (const item of Object.values(records)) {
      if (item.record.leakDetected || item.record.agentWroteFile ||
        item.record.provider.requestShapes.some(r => r.toolSchemas.some(t => !['view', 'skill',
          ...(item.record.artifactTargets.length ? ['create', 'edit'] : [])].includes(t.name)))) throw new CopilotError('TOOL_BOUNDARY_FAILED');
    }
    return {
      client: 'copilot', clientVersion: VERSION, transport: 'offline-mock/not-live',
      image: owned.image, baseImage: BASE_IMAGE, nodeVersion: '22.22.1', engineVersion: '29.7.2',
      model: 'offline-fixture-model', liveAccepted: false, qualityEvaluated: false,
      accepted: true, capabilities, positive: candidate.outcome, control: control.outcome,
      denial, pilotWritesVerified: artifactTargets.length > 0,
      artifactTargets, artifactProfile: writePositive ? { positive: writePositive.outcome, control: writeControl.outcome, artifacts, denial: writeDenial } : null,
      freshWorkspaces: Object.keys(records).length, network: 'none', cleanup: 'verified-owned-containers-and-image-tag-removed'
    };
  } catch (e) {
    if (controller.signal.aborted && e.code === 'CANCELLED') throw new CopilotError('TIMEOUT');
    throw e;
  } finally {
    clearTimeout(timer);
    if (owned) await cleanupOfflineImage(owned);
  }
}
