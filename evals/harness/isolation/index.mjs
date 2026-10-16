import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError, hashContent, hashObject, resolveContained, validateDocument } from '../index.mjs';

export const OFFLINE_NODE_IMAGE = 'node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d';
export const OFFLINE_NODE_VERSION = '22.22.1';
export const DOCKER_ENGINE_VERSION = '29.7.2';
export const CLIENT_VERSIONS = Object.freeze({ 'claude-code': '2.1.291', copilot: '1.0.92', opencode: '1.14.28' });
export const CLIENT_ENV_ALLOWLIST = Object.freeze({
  'claude-code': Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']),
  copilot: Object.freeze(['COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_TYPE', 'COPILOT_MODEL']),
  opencode: Object.freeze(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])
});
const workRoot = fileURLToPath(new URL('../../.work/', import.meta.url));
const handles = new WeakMap();
const leases = new WeakSet();
const LABEL = 'ai.skill-eval.isolation';
const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 256;
const MAX_CONCURRENCY = 4;
const BLOCKER = 'Live execution blocked: no verified direct-endpoint egress restriction and credential/tool boundary. Docker networking or secret environment injection alone is insufficient.';
const BOOTSTRAP = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
for (const [source, target] of [
  ['/eval/inputs', '/workspace'], ['/eval/home-seed', '/home/eval'], ['/eval/config', '/client-config']
]) fs.cpSync(source, target, { recursive: true, dereference: false });
const result = spawnSync(process.argv[1], process.argv.slice(2), { stdio: 'inherit', env: process.env });
if (result.error) { console.error('Isolated executable unavailable'); process.exit(127); }
process.exit(result.status === null ? 1 : result.status);
`;

export class IsolationError extends ContractError {
  constructor(message, code = 'ISOLATION_BLOCKED') {
    super(message);
    this.name = 'IsolationError';
    this.code = code;
  }
}

function insist(condition, message, code) {
  if (!condition) throw new IsolationError(message, code);
}

function plain(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function identifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(value);
}

function safeRelative(value) {
  insist(typeof value === 'string' && value.length > 0 && !/[,:=\0\r\n]/.test(value), 'Invalid owned relative path');
  const parts = value.replaceAll('\\', '/').split('/');
  insist(parts.every(part => part && part !== '.' && part !== '..' && !part.endsWith('.') &&
    !part.endsWith(' ') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
  'Path traversal or ambiguous owned path');
  return parts;
}

function assertNoLinks(filename) {
  let current = path.resolve(filename);
  while (true) {
    if (fs.existsSync(current)) insist(!fs.lstatSync(current).isSymbolicLink(), 'Symlink/reparse-point in owned path');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function owned(handle) {
  const state = handles.get(handle);
  insist(state && !state.deleted, 'Unknown or destroyed workspace handle');
  assertNoLinks(state.directory);
  const marker = JSON.parse(fs.readFileSync(path.join(state.directory, '.owner.json'), 'utf8'));
  insist(marker.id === state.id, 'Owned workspace marker mismatch');
  return state;
}

export function validateIsolationProfile(profile, { mode = 'offline' } = {}) {
  validateDocument('profile', profile);
  insist(mode === 'offline' || mode === 'live', 'Unknown isolation mode');
  insist(profile.limits.seconds <= 300 && profile.limits.concurrency <= MAX_CONCURRENCY,
    'Isolation caps: seconds <= 300, concurrency <= 4');
  insist(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*@sha256:[a-f0-9]{64}$/.test(profile.image),
    'An exact image digest pin is required');
  // No caller-supplied boolean, network name, or endpoint list constitutes an egress verifier.
  insist(mode !== 'live', BLOCKER, 'LIVE_BOUNDARY_UNVERIFIED');
  insist(profile.auth === 'none-offline', 'Offline execution requires auth none-offline');
  return Object.freeze({
    mode, profileHash: hashObject(profile), image: profile.image,
    network: 'none', authenticationVerified: false,
    turnTokenEnforcement: 'not-applicable-offline-probe',
    liveBlocker: BLOCKER
  });
}

export function assessClientCapabilities({ client, version, help }) {
  insist(Object.hasOwn(CLIENT_VERSIONS, client), 'Unsupported client');
  insist(version === CLIENT_VERSIONS[client], 'Actual client version differs from pin', 'RUNTIME_DRIFT');
  insist(typeof help === 'string' && help.length <= MAX_BYTES, 'Bounded actual help output required');
  const flags = {
    'claude-code': ['--bare', '--restricted', '--permission-mode', '--permission-prompts',
      '--strict-mcp-config', '--tools', '--allowedTools', '--disallowedTools'],
    copilot: ['--available-tools', '--excluded-tools', '--deny-tool', '--disallow-temp-dir',
      '--no-custom-instructions', '--disable-builtin-mcps', '--no-auto-update', '--no-ask-user', '--secret-env-vars'],
    opencode: []
  }[client];
  const missing = flags.filter(flag => !new RegExp(`${flag}(?=[\\s,=\\[<]|$)`).test(help));
  return {
    client, actualVersion: version, helpHash: hashContent(help), missing,
    flagSurfaceVerified: missing.length === 0 && client !== 'opencode',
    toolPolicy: ['skill', 'fixture-read'],
    liveSupported: false,
    blockers: [BLOCKER, ...(client === 'opencode' ? ['Permission configuration behavior must be verified in the pinned runtime; --help is insufficient.'] : []),
      ...(missing.length ? ['Required flags absent from supplied actual help.'] : [])]
  };
}

export function buildClientEnvironment({ client, values = {}, profile, mode = 'offline' }) {
  validateIsolationProfile(profile, { mode });
  insist(Object.hasOwn(CLIENT_ENV_ALLOWLIST, client) && plain(values), 'Unsupported client environment');
  // Inspect names only; never interpolate rejected values into an error.
  for (const key of Object.keys(values)) {
    insist(CLIENT_ENV_ALLOWLIST[client].includes(key), 'Environment key is not on the client allowlist');
    insist(!/(KEY|TOKEN|SECRET|PASSWORD)/i.test(key), 'Credentials are prohibited in the offline profile');
    insist(typeof values[key] === 'string' && values[key].length <= 2048 && !/[\0\r\n]/.test(values[key]), 'Invalid environment value');
    if (/(URL)$/.test(key)) {
      const endpoint = new URL(values[key]);
      insist(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password, 'Direct endpoint must not carry URL credentials');
    }
    if (key === 'COPILOT_PROVIDER_TYPE') insist(['anthropic', 'openai', 'azure'].includes(values[key]), 'Unsupported direct provider type');
  }
  return { ...values, HOME: '/home/eval', XDG_CONFIG_HOME: '/client-config/xdg-config',
    XDG_CACHE_HOME: '/client-config/xdg-cache', XDG_DATA_HOME: '/client-config/xdg-data',
    XDG_STATE_HOME: '/client-config/xdg-state', COPILOT_HOME: '/client-config/copilot',
    CLAUDE_CONFIG_DIR: '/client-config/claude' };
}

export function redact(value, secrets = []) {
  insist(Array.isArray(secrets) && secrets.every(secret => typeof secret === 'string' && secret.length > 0),
    'Redaction requires explicit nonempty secret strings');
  function text(input) {
    let result = input;
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      for (const encoded of new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')])) {
        result = result.split(encoded).join('[REDACTED]');
      }
    }
    return result
      .replace(/(Bearer\s+)[^\s"',]+/gi, '$1[REDACTED]')
      .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
      .replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/gi, 'https://[REDACTED]@');
  }
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    text(key), /^(?:authorization|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)$|(?:^|[_-])(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)(?:$|[_-])/i.test(key)
      ? '[REDACTED]' : redact(item, secrets)
  ]));
  return value;
}

export function materializeAgentContext(loaded) {
  insist(loaded?.suite?.context && typeof loaded.root === 'string', 'A loaded semantic suite is required');
  return loaded.suite.context.dependencies
    .filter(item => item.visibility === 'agent' && item.availability === 'provided')
    .map(item => ({
      path: item.mount, mountRoot: item.mountRoot ?? 'workspace',
      content: fs.readFileSync(resolveContained(loaded.root, item.path)), executable: false
    }));
}

export function createWorkspace({ task, inputs = [], config = [] }) {
  insist(plain(task) && identifier(task.client) && Object.hasOwn(CLIENT_VERSIONS, task.client) &&
    ['candidate', 'baseline', 'no-skill'].includes(task.arm) &&
    [1, 2, 3].includes(task.repeat) && identifier(task.caseId) && identifier(task.invocationId),
  'Explicit invocation/case/client/arm/repeat coordinates required');
  insist(Array.isArray(inputs) && Array.isArray(config) && inputs.length + config.length <= MAX_FILES, 'Input file cap exceeded');
  let total = 0;
  const prepared = [inputs, config].map(files => {
    const seen = new Set();
    return files.map(file => {
      insist(plain(file) && Object.keys(file).every(key => ['path', 'content', 'executable', 'mountRoot'].includes(key)), 'Only explicit file bytes may be materialized');
      const parts = safeRelative(file.path);
      const mountRoot = file.mountRoot ?? 'workspace';
      insist(['workspace', 'home'].includes(mountRoot), 'Unknown fixture mount root');
      insist(files !== config || mountRoot === 'workspace', 'Config seeds cannot target fixture HOME');
      insist(!parts.some(part => /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|auth\.json|\.credentials\.json|credentials(?:\..*)?|id_rsa|id_ed25519|hosts\.json)$/i.test(part)),
        'Auth/credential files are prohibited in readable seeds');
      insist(mountRoot !== 'home' || !parts.some(part => ['.claude', '.copilot', '.config', '.local'].includes(part.toLowerCase())),
        'Fixture HOME cannot contain client configuration stores');
      const key = `${mountRoot}/${parts.join('/').toLowerCase()}`;
      insist(![...seen].some(existing => existing === key || existing.startsWith(`${key}/`) || key.startsWith(`${existing}/`)),
        'Duplicate/colliding case-insensitive input path');
      seen.add(key);
      insist(typeof file.content === 'string' || Buffer.isBuffer(file.content), 'Input must be synthetic or selected exported bytes, never a host directory');
      const content = Buffer.from(file.content);
      total += content.length;
      insist(total <= MAX_BYTES, 'Input byte cap exceeded');
      return { parts, mountRoot, content, executable: file.executable === true };
    });
  });
  assertNoLinks(workRoot);
  fs.mkdirSync(workRoot, { recursive: true });
  const id = randomUUID();
  const directory = path.join(workRoot, `isolation-${id}`);
  fs.mkdirSync(directory);
  const state = { id, directory, deleted: false, active: 0, containers: new Set(), seeds: new Map() };
  try {
    fs.writeFileSync(path.join(directory, '.owner.json'), JSON.stringify({ id, task }), { flag: 'wx', mode: 0o600 });
    for (const subdir of ['inputs', 'home', 'config', 'docker-config', 'evidence']) fs.mkdirSync(path.join(directory, subdir));
    for (const [index, files] of prepared.entries()) {
      for (const file of files) {
        const target = path.join(directory, index === 0 ? (file.mountRoot === 'home' ? 'home' : 'inputs') : 'config', ...file.parts);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, { flag: 'wx', mode: file.executable ? 0o555 : 0o444 });
        state.seeds.set(path.relative(directory, target), { hash: hashContent(file.content), bytes: file.content.length });
      }
    }
    const handle = Object.freeze({ id, directory, task: Object.freeze({ ...task }) });
    handles.set(handle, state);
    return handle;
  } catch {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new IsolationError('Failed materializing owned input files');
  }
}

export function destroyWorkspace(handle) {
  const state = owned(handle);
  insist(state.active === 0, 'Cannot clean an active workspace');
  insist(state.containers.size === 0, 'Cannot delete workspace until owned container cleanup is verified', 'CLEANUP_FAILED');
  fs.rmSync(state.directory, { recursive: true, force: true });
  state.deleted = true;
}

export function writeEvidence(handle, evidence, { secrets = [], name = 'isolation.json' } = {}) {
  const state = owned(handle);
  const parts = safeRelative(name);
  const output = JSON.stringify(redact(evidence, secrets), null, 2);
  insist(Buffer.byteLength(output) <= MAX_BYTES, 'Evidence byte cap exceeded');
  const filename = path.join(state.directory, 'evidence', ...parts);
  assertNoLinks(filename);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, output, { flag: 'wx', mode: 0o600 });
  return filename;
}

class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.queue = []; }
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(new IsolationError('Execution cancelled', 'CANCELLED'));
    if (this.active < this.limit) { this.active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      entry.abort = () => {
        this.queue.splice(this.queue.indexOf(entry), 1);
        reject(new IsolationError('Execution cancelled while queued', 'CANCELLED'));
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) { next.signal?.removeEventListener('abort', next.abort); next.resolve(); }
    else this.active--;
  }
}
const globalSlots = new Semaphore(MAX_CONCURRENCY);

function dockerEnvironment(state) {
  const env = { DOCKER_CONFIG: path.join(state.directory, 'docker-config'),
    DOCKER_HOST: process.platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function docker(state, args, { deadline = Date.now() + 10000, signal, acceptFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new IsolationError('Execution cancelled', 'CANCELLED')); return; }
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(new IsolationError('Execution deadline exceeded', 'TIMEOUT')); return; }
    const child = spawn('docker', args, { cwd: state.directory, env: dockerEnvironment(state),
      windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let bytes = 0;
    const output = { stdout: [], stderr: [] };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        // SIGTERM on Windows Docker attach can leave the CLI waiting on the
        // container. Do not make the deadline depend on its close event.
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(error);
      } else resolve(result);
    };
    const stop = code => finish(new IsolationError(`Bounded Docker execution failed: ${code}`, code));
    const timer = setTimeout(() => stop('TIMEOUT'), remaining);
    const abort = () => stop('CANCELLED');
    signal?.addEventListener('abort', abort, { once: true });
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BYTES) stop('OUTPUT_LIMIT');
      else output[stream].push(chunk);
    });
    child.on('error', () => stop('DOCKER_UNAVAILABLE'));
    child.on('close', code => {
      if (settled) return;
      const stdout = redact(Buffer.concat(output.stdout).toString('utf8'));
      const stderr = redact(Buffer.concat(output.stderr).toString('utf8'));
      if (code !== 0 && !acceptFailure) finish(new IsolationError(`Docker command failed (${code}): ${stderr.slice(0, 1000)}`, 'DOCKER_FAILURE'));
      else finish(null, { exitCode: code, stdout, stderr });
    });
  });
}

export function buildDockerArguments({ profile, workspace, command, containerName }) {
  validateIsolationProfile(profile);
  const state = owned(workspace);
  insist(/^skill-eval-[a-f0-9-]+$/.test(containerName), 'Invalid owned container name');
  insist(Array.isArray(command) && command.length > 0 && command.length <= 32 &&
    command.every(item => typeof item === 'string' && item.length <= 65536 && !item.includes('\0')),
  'A bounded executable/argument vector is required');
  for (const subdir of ['inputs', 'home', 'config', 'docker-config']) {
    const root = path.join(state.directory, subdir);
    assertNoLinks(root);
    const observed = new Set();
    const scan = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        insist(!entry.isSymbolicLink(), 'Symlink in owned seed');
        if (entry.isDirectory()) scan(target);
        else {
          insist(entry.isFile(), 'Only regular seed files may be mounted');
          const relative = path.relative(state.directory, target);
          const expected = state.seeds.get(relative);
          const stat = fs.statSync(target);
          insist(expected && stat.nlink === 1 && stat.size === expected.bytes && stat.size <= MAX_BYTES,
            'Seed content changed or an undeclared/hardlinked file was added');
          insist(expected.hash === hashContent(fs.readFileSync(target)), 'Seed content changed');
          observed.add(relative);
        }
      }
    };
    scan(root);
    insist([...state.seeds.keys()].filter(relative => relative.startsWith(`${subdir}${path.sep}`)).every(relative => observed.has(relative)),
      'Selected seed file was removed');
  }
  insist(!/[,\r\n]/.test(state.directory), 'Docker bind path cannot contain commas or newlines');
  const args = ['create', '--pull', 'never', '--name', containerName, '--label', `${LABEL}=${state.id}`,
    '--platform', 'linux/amd64', '--network', 'none', '--read-only', '--user', '10001:10001',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--init', '--memory', '256m',
    '--memory-swap', '256m', '--cpus', '1', '--pids-limit', '64',
    '--ulimit', 'nofile=256:256', '--ulimit', 'fsize=1048576:1048576', '--ipc', 'none',
    '--log-driver', 'none', '--stop-timeout', '1', '--workdir', '/workspace',
    '--tmpfs', '/workspace:rw,noexec,nosuid,nodev,size=16m,mode=700,uid=10001,gid=10001',
    '--tmpfs', '/home/eval:rw,noexec,nosuid,nodev,size=16m,mode=700,uid=10001,gid=10001',
    '--tmpfs', '/client-config:rw,noexec,nosuid,nodev,size=16m,mode=700,uid=10001,gid=10001',
    '--tmpfs', '/scratch:rw,noexec,nosuid,nodev,size=16m,mode=700,uid=10001,gid=10001'];
  const env = {
    HOME: '/home/eval', XDG_CONFIG_HOME: '/client-config/xdg-config', XDG_DATA_HOME: '/client-config/xdg-data',
    XDG_CACHE_HOME: '/client-config/xdg-cache', XDG_STATE_HOME: '/client-config/xdg-state',
    COPILOT_HOME: '/client-config/copilot', CLAUDE_CONFIG_DIR: '/client-config/claude', TMPDIR: '/scratch'
  };
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
  for (const [source, destination] of [['inputs', '/eval/inputs'], ['home', '/eval/home-seed'], ['config', '/eval/config']]) {
    args.push('--mount', `type=bind,source=${path.join(state.directory, source)},target=${destination},readonly,bind-recursive=disabled`);
  }
  args.push('--entrypoint', 'node', profile.image, '-e', BOOTSTRAP, '--', ...command);
  return args;
}

async function inspectContainer(state, name, options) {
  const result = await docker(state, ['inspect', name], options);
  const [container] = JSON.parse(result.stdout);
  insist(container?.Config?.Labels?.[LABEL] === state.id, 'Refusing access to a non-owned container', 'OWNERSHIP_MISMATCH');
  return container;
}

async function removeContainer(state, name) {
  const inspection = await docker(state, ['inspect', name], { acceptFailure: true });
  if (inspection.exitCode !== 0) {
    insist(/No such (object|container)/i.test(inspection.stderr), 'Cannot prove container cleanup', 'CLEANUP_FAILED');
    return;
  }
  const [container] = JSON.parse(inspection.stdout);
  insist(container?.Config?.Labels?.[LABEL] === state.id, 'Refusing cleanup of a non-owned container', 'OWNERSHIP_MISMATCH');
  await docker(state, ['rm', '--force', name]);
  const check = await docker(state, ['inspect', name], { acceptFailure: true });
  insist(check.exitCode !== 0 && /No such (object|container)/i.test(check.stderr), 'Owned container still exists', 'CLEANUP_FAILED');
}

function confinementEvidence(container, state) {
  const host = container.HostConfig;
  insist(host.NetworkMode === 'none' && host.ReadonlyRootfs && container.Config.User === '10001:10001' &&
    host.CapDrop.some(cap => ['ALL', 'CAP_ALL'].includes(cap)) &&
    host.SecurityOpt.includes('no-new-privileges=true') && host.Privileged === false &&
    host.Memory === 268435456 && host.MemorySwap === 268435456 && host.PidsLimit === 64 &&
    host.NanoCpus === 1000000000 && host.LogConfig.Type === 'none',
  'Observed Docker confinement differs from requested policy');
  const mounts = container.Mounts.filter(mount => mount.Type === 'bind');
  insist(mounts.length === 3 && mounts.every(mount => !mount.RW &&
    ['/eval/inputs', '/eval/home-seed', '/eval/config'].includes(mount.Destination)) &&
    Object.keys(host.Tmpfs).sort().join(',') === '/client-config,/home/eval,/scratch,/workspace' &&
    Object.values(host.Tmpfs).every(options => ['rw', 'noexec', 'nosuid', 'nodev', 'size=16m', 'mode=700', 'uid=10001', 'gid=10001'].every(option => options.split(',').includes(option))),
  'Unexpected or writable host mount');
  // Docker Desktop translates the host bind source into its VM path; destinations and
  // the exact submitted sources are retained separately rather than inventing equivalence.
  return {
    owner: state.id, containerId: container.Id, actualImageId: container.Image,
    network: host.NetworkMode, rootfsReadOnly: host.ReadonlyRootfs, user: container.Config.User,
    capDrop: host.CapDrop, securityOpt: host.SecurityOpt, memoryBytes: host.Memory,
    pidsLimit: host.PidsLimit, nanoCpus: host.NanoCpus,
    bindMounts: mounts.map(mount => ({ destination: mount.Destination, readOnly: !mount.RW })),
    tmpfs: host.Tmpfs, logging: host.LogConfig.Type,
    exitCode: container.State.ExitCode, oomKilled: container.State.OOMKilled
  };
}

async function executeContainer(state, workspace, profile, command, options) {
  const name = `skill-eval-${randomUUID()}`;
  state.containers.add(name);
  let result;
  let error;
  try {
    await docker(state, buildDockerArguments({ profile, workspace, command, containerName: name }), options);
    const container = await inspectContainer(state, name, options);
    const evidence = confinementEvidence(container, state);
    const output = await docker(state, ['start', '--attach', name], { ...options, acceptFailure: true });
    const completed = await inspectContainer(state, name, options);
    result = { ...output, evidence: { ...evidence, exitCode: completed.State.ExitCode, oomKilled: completed.State.OOMKilled } };
    insist(!completed.State.Running && !completed.State.OOMKilled, 'Incomplete or OOM-killed execution', 'EXECUTION_INCOMPLETE');
  } catch (caught) { error = caught; }
  try { await removeContainer(state, name); state.containers.delete(name); }
  catch (cleanup) { throw new IsolationError(`Owned container cleanup failed; workspace retained for recovery. ${cleanup.code ?? 'CLEANUP_FAILED'}`, 'CLEANUP_FAILED'); }
  if (error) throw error;
  return result;
}

export async function recoverOwnedContainers(workspace) {
  const state = owned(workspace);
  insist(state.active === 0, 'Cannot recover an active workspace');
  const names = [...state.containers];
  for (const name of names) {
    await removeContainer(state, name);
    state.containers.delete(name);
  }
  return { owner: state.id, removed: names };
}

export function createExecutor(profile, { mode = 'offline' } = {}) {
  const validated = validateIsolationProfile(profile, { mode });
  const pinned = structuredClone(profile);
  const slots = new Semaphore(profile.limits.concurrency);
  return Object.freeze({
    profileHash: validated.profileHash,
    async run({ workspace, command, runtime, signal }) {
      const state = owned(workspace);
      insist(!leases.has(workspace), 'Each task workspace can execute only once; create a fresh workspace');
      insist(plain(runtime) && ['offline-probe', 'client'].includes(runtime.kind) &&
        identifier(runtime.executable) && /^\d+\.\d+\.\d+$/.test(runtime.version), 'Exact observed-runtime version pin required');
      if (runtime.kind === 'client') insist(runtime.version === pinned.clients[workspace.task.client]?.version,
        'Client runtime pin differs from contract profile');
      insist(Array.isArray(command) && command[0] === runtime.executable, 'Command executable must match the runtime being verified');
      leases.add(workspace);
      state.active++;
      let localAcquired = false;
      let globalAcquired = false;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      let deadlineExpired = false;
      const deadline = Date.now() + pinned.limits.seconds * 1000;
      const timer = setTimeout(() => { deadlineExpired = true; controller.abort(); }, pinned.limits.seconds * 1000);
      const started = Date.now();
      try {
        await slots.acquire(controller.signal); localAcquired = true;
        await globalSlots.acquire(controller.signal); globalAcquired = true;
        const options = { deadline, signal: controller.signal };
        const server = JSON.parse((await docker(state, ['version', '--format', '{{json .Server}}'], options)).stdout);
        insist(server.Version === DOCKER_ENGINE_VERSION && server.Os === 'linux' && server.Arch === 'amd64',
          'Actual Docker engine/platform differs from the verified pin', 'RUNTIME_DRIFT');
        const [image] = JSON.parse((await docker(state, ['image', 'inspect', pinned.image], options)).stdout);
        insist(image.RepoDigests.includes(pinned.image) && image.Os === 'linux' && image.Architecture === 'amd64',
          'Actual cached image differs from requested image/platform', 'RUNTIME_DRIFT');
        const probe = await executeContainer(state, workspace, pinned, [runtime.executable, '--version'], options);
        insist(probe.exitCode === 0, 'In-container runtime version probe failed', 'RUNTIME_DRIFT');
        const matches = [...probe.stdout.matchAll(/(?:^|\s)v?(\d+\.\d+\.\d+)(?=\s|$)/g)].map(match => match[1]);
        insist(matches.length === 1 && matches[0] === runtime.version, 'Actual in-container runtime version differs from pin', 'RUNTIME_DRIFT');
        const execution = await executeContainer(state, workspace, pinned, command, options);
        return {
          executionId: randomUUID(), status: execution.exitCode === 0 ? 'completed' : 'error',
          exitCode: execution.exitCode, stdout: execution.stdout, stderr: execution.stderr,
          elapsedMs: Date.now() - started,
          runtime: { kind: runtime.kind, executable: runtime.executable, actualVersion: matches[0],
            clientVersion: runtime.kind === 'client' ? matches[0] : null,
            image: pinned.image, actualImageId: image.Id, engineVersion: server.Version,
            os: image.Os, architecture: image.Architecture, auth: 'none-offline', authenticationVerified: false },
          isolation: { ...execution.evidence, profileHash: validated.profileHash,
            submittedBindSources: ['inputs', 'home', 'config'].map(subdir => path.join(state.directory, subdir)),
            cleanup: 'verified-owned-containers-removed', workspaceCleanup: 'caller-owned',
            liveSupported: false, liveBlocker: BLOCKER }
        };
      } catch (error) {
        if (deadlineExpired && error.code === 'CANCELLED') throw new IsolationError('Execution deadline exceeded', 'TIMEOUT');
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (globalAcquired) globalSlots.release();
        if (localAcquired) slots.release();
        state.active--;
      }
    }
  });
}

export function assertClientRuntimeEvidence(result, profile, client) {
  insist(result?.runtime?.kind === 'client' && result.runtime.clientVersion === profile.clients[client]?.version,
    'Offline Node probes are not actual client execution evidence');
  insist(result.runtime.authenticationVerified === true, 'No authenticated client execution was verified');
  return result.runtime;
}
