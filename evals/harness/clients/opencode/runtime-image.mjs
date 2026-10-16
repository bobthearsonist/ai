import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BASE_IMAGE, BINARY, CLIENT_VERSION, OWNER_LABEL } from './constants.mjs';
import { OfflineTaskError, freeze, insist, record, sha256 } from './case-spec.mjs';

const workRoot = fileURLToPath(new URL('../../../.work/', import.meta.url));
const context = fileURLToPath(new URL('.', import.meta.url));
const handles = new WeakMap();
const nativeFiles = Object.freeze([
  'constants.mjs', 'case-spec.mjs', 'task-policy.mjs', 'native-events.mjs',
  'native-spec.mjs', 'native-evidence.mjs', 'native-session.mjs', 'task-files.mjs', 'task-capture.mjs'
]);
const offlineFiles = Object.freeze([
  ...nativeFiles, 'index.mjs', 'scripted-protocol.mjs', 'task-spec.mjs', 'task-audit.mjs', 'task-runtime.mjs'
]);
const publicVersions = Object.freeze({
  'opencode-ai': CLIENT_VERSION, 'opencode-linux-x64': CLIENT_VERSION, '@vscode/ripgrep-linux-x64': '1.18.0'
});

export function noLinks(filename) {
  let current = path.resolve(filename);
  while (true) {
    if (fs.existsSync(current)) insist(!fs.lstatSync(current).isSymbolicLink(), 'Symlink/reparse point in owned workspace', 'OWNERSHIP_MISMATCH');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function createOwnedWorkspace(executionId, task = null, purpose = 'offline-task') {
  insist(/^[a-f0-9-]{36}$/.test(executionId) && ['offline-task', 'native-runtime-image'].includes(purpose),
    'Invalid owned runtime workspace identity');
  noLinks(workRoot);
  fs.mkdirSync(workRoot, { recursive: true });
  const directory = path.join(workRoot, `opencode-task-${executionId}`);
  fs.mkdirSync(directory);
  try {
    fs.writeFileSync(path.join(directory, '.owner.json'), JSON.stringify({ executionId, task, purpose }),
      { flag: 'wx', mode: 0o600 });
    for (const child of ['artifacts', 'docker-config', 'home', 'appdata', 'scratch', 'public-deps', 'runtime-build']) {
      fs.mkdirSync(path.join(directory, child));
    }
    const plugins = process.platform === 'win32'
      ? 'C:\\Program Files\\Docker\\Docker\\resources\\cli-plugins'
      : '/usr/local/lib/docker/cli-plugins';
    fs.writeFileSync(path.join(directory, 'docker-config', 'config.json'),
      JSON.stringify({ cliPluginsExtraDirs: [plugins] }), { flag: 'wx', mode: 0o600 });
    return { directory, executionId, purpose, tag: `skill-eval-opencode-task:${executionId}`,
      dependencyTag: `skill-eval-opencode-public-deps:${executionId}`,
      name: `skill-eval-opencode-task-${executionId}` };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function assertOwned(state) {
  noLinks(state.directory);
  const marker = JSON.parse(fs.readFileSync(path.join(state.directory, '.owner.json'), 'utf8'));
  insist(marker.executionId === state.executionId && marker.purpose === state.purpose,
    'Owned workspace marker mismatch', 'OWNERSHIP_MISMATCH');
}

function dockerExecutable() {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe']
    : ['/usr/bin/docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker'];
  const executable = candidates.find(filename => fs.existsSync(filename) && fs.statSync(filename).isFile());
  insist(executable, 'Trusted installed Docker executable unavailable; no PATH search or installation attempted', 'DOCKER_UNAVAILABLE');
  return executable;
}

function dockerEnvironment(state, executable) {
  const home = path.join(state.directory, 'home');
  const env = {
    DOCKER_CONFIG: path.join(state.directory, 'docker-config'),
    BUILDX_CONFIG: path.join(state.directory, 'docker-config', 'buildx'),
    DOCKER_BUILDKIT: '1', BUILDX_BUILDER: 'default',
    DOCKER_HOST: process.platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock',
    HOME: home, USERPROFILE: home,
    APPDATA: path.join(state.directory, 'appdata'), LOCALAPPDATA: path.join(state.directory, 'appdata'),
    TMP: path.join(state.directory, 'scratch'), TEMP: path.join(state.directory, 'scratch'),
    PATH: process.platform === 'win32'
      ? `${path.dirname(executable)};C:\\Windows\\System32;C:\\Windows`
      : `${path.dirname(executable)}:/usr/bin:/bin`
  };
  if (process.platform === 'win32') {
    env.SystemRoot = 'C:\\Windows';
    env.WINDIR = 'C:\\Windows';
    env.OS = 'Windows_NT';
  }
  return env;
}

export function docker(state, args, { deadline, input, acceptFailure = false } = {}) {
  assertOwned(state);
  const executable = dockerExecutable();
  const remaining = (deadline ?? Date.now() + 10000) - Date.now();
  insist(remaining > 0, 'Native runtime deadline exceeded', 'TIMEOUT');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: state.directory, env: dockerEnvironment(state, executable),
      windowsHide: true, shell: false, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let settled = false;
    let bytes = 0;
    const output = { stdout: [], stderr: [] };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        child.stdin?.destroy();
        child.unref();
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(() => finish(new OfflineTaskError('Native runtime deadline exceeded', 'TIMEOUT')), remaining);
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) finish(new OfflineTaskError('Docker command output byte cap exceeded', 'OUTPUT_LIMIT'));
      else output[stream].push(chunk);
    });
    child.on('error', () => finish(new OfflineTaskError('Docker executable failed', 'DOCKER_UNAVAILABLE')));
    child.on('close', exitCode => {
      if (settled) return;
      const stdout = Buffer.concat(output.stdout).toString('utf8');
      const stderr = Buffer.concat(output.stderr).toString('utf8');
      if (exitCode !== 0 && !acceptFailure) {
        finish(new OfflineTaskError(`Docker ${args[0]} failed (${exitCode}): ${stderr.slice(0, 1000)}`, 'DOCKER_FAILURE'));
      } else finish(null, { exitCode, stdout, stderr });
    });
    if (input !== undefined) {
      child.stdin.on('error', () => finish(new OfflineTaskError('Native payload delivery failed', 'DOCKER_FAILURE')));
      child.stdin.end(input);
    }
  });
}

export function nativeRuntimeBuildPlan({ purpose, executionId, dependencyTag, tag }) {
  insist(['offline-task', 'native-runtime-image'].includes(purpose) &&
    /^[a-f0-9-]{36}$/.test(executionId) && dependencyTag === `skill-eval-opencode-public-deps:${executionId}` &&
    tag === `skill-eval-opencode-task:${executionId}`, 'Invalid pinned runtime build identity');
  return freeze({
    publicFiles: ['Dockerfile', 'package.json', 'package-lock.json'],
    helperFiles: [...(purpose === 'offline-task' ? offlineFiles : nativeFiles)],
    dockerfile: purpose === 'offline-task' ? 'Dockerfile.task' : 'Dockerfile.native',
    publicArguments: ['build', '--quiet', '--target', 'install', '--network', 'default', '--pull=false',
      '--platform', 'linux/amd64', '--label', `${OWNER_LABEL}=${executionId}`, '-t', dependencyTag],
    helperArguments: ['build', '--quiet', '--network', 'none', '--pull=false', '--platform', 'linux/amd64',
      '--build-arg', `CLIENT_IMAGE=${dependencyTag}`, '--label', `${OWNER_LABEL}=${executionId}`, '-t', tag]
  });
}

function publicManifestHash(directory) {
  for (const filename of ['Dockerfile', 'package.json', 'package-lock.json']) {
    noLinks(path.join(directory, filename));
    const stat = fs.lstatSync(path.join(directory, filename));
    insist(stat.isFile() && stat.nlink === 1 && stat.size <= 1024 * 1024,
      'Unsafe public pinned build manifest', 'RUNTIME_DRIFT');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(directory, 'package-lock.json'));
  const lock = JSON.parse(bytes.toString('utf8'));
  insist(manifest.dependencies && lock.packages?.['']?.dependencies &&
    Object.keys(manifest.dependencies).length === Object.keys(publicVersions).length &&
    Object.keys(lock.packages[''].dependencies).length === Object.keys(publicVersions).length &&
    Object.entries(publicVersions).every(([name, version]) => manifest.dependencies[name] === version &&
      lock.packages[''].dependencies[name] === version &&
      lock.packages[`node_modules/${name}`]?.version === version &&
      typeof lock.packages[`node_modules/${name}`]?.integrity === 'string' &&
      lock.packages[`node_modules/${name}`]?.resolved?.startsWith(`https://registry.npmjs.org/${name}/`)),
  'Public native dependency pins drifted', 'RUNTIME_DRIFT');
  return sha256(bytes);
}

export async function buildPinnedRuntimeImage(state, { deadline }) {
  publicManifestHash(context);
  const server = JSON.parse((await docker(state, ['version', '--format', '{{json .Server}}'], { deadline })).stdout);
  insist(server.Version === '29.7.2' && server.Os === 'linux' && server.Arch === 'amd64',
    'Pinned Docker engine/platform drift', 'RUNTIME_DRIFT');
  const [base] = JSON.parse((await docker(state, ['image', 'inspect', BASE_IMAGE], { deadline })).stdout);
  insist(base?.RepoDigests?.includes(BASE_IMAGE) && base.Os === 'linux' && base.Architecture === 'amd64',
    'Pinned cached base image unavailable or drifted', 'RUNTIME_DRIFT');
  const plan = nativeRuntimeBuildPlan(state);
  const publicContext = path.join(state.directory, 'public-deps');
  for (const filename of plan.publicFiles) fs.copyFileSync(path.join(context, filename), path.join(publicContext, filename));
  const manifestHash = publicManifestHash(publicContext);
  // Only pinned public manifests enter this restore stage; no caller or helper bytes are attached.
  await docker(state, [...plan.publicArguments, publicContext], { deadline });
  const [dependency] = JSON.parse((await docker(state, ['image', 'inspect', state.dependencyTag], { deadline })).stdout);
  insist(dependency?.Config?.Labels?.[OWNER_LABEL] === state.executionId && /^sha256:[a-f0-9]{64}$/.test(dependency.Id) &&
    dependency.Os === 'linux' && dependency.Architecture === 'amd64',
  'Public dependency image ownership/platform mismatch', 'RUNTIME_DRIFT');
  state.dependencyImage = dependency.Id;
  const runtimeContext = path.join(state.directory, 'runtime-build');
  for (const filename of plan.helperFiles) {
    noLinks(path.join(context, filename));
    fs.copyFileSync(path.join(context, filename), path.join(runtimeContext, filename));
  }
  noLinks(path.join(context, plan.dockerfile));
  fs.copyFileSync(path.join(context, plan.dockerfile), path.join(runtimeContext, 'Dockerfile'));
  await docker(state, [...plan.helperArguments, runtimeContext], { deadline });
  const [dependencyAfterBuild] = JSON.parse((await docker(state, ['image', 'inspect', state.dependencyTag], { deadline })).stdout);
  insist(dependencyAfterBuild?.Id === dependency.Id, 'Owned dependency tag changed during runtime build', 'RUNTIME_DRIFT');
  const [metadata] = JSON.parse((await docker(state, ['image', 'inspect', state.tag], { deadline })).stdout);
  insist(metadata?.Config?.Labels?.[OWNER_LABEL] === state.executionId && /^sha256:[a-f0-9]{64}$/.test(metadata.Id) &&
    metadata.Os === 'linux' && metadata.Architecture === 'amd64' && metadata.Config.User === '1000:1000' &&
    metadata.Config.WorkingDir === '/opt/fixture', 'Built task image ownership/platform/layout mismatch', 'RUNTIME_DRIFT');
  state.image = metadata.Id;
  return { server, dependency, metadata, image: metadata.Id, publicManifestHash: manifestHash };
}

async function removeOwnedResource(state, kind, name) {
  const inspectArgs = kind === 'image' ? ['image', 'inspect', name] : ['inspect', name];
  const before = await docker(state, inspectArgs, { acceptFailure: true });
  if (before.exitCode !== 0) {
    insist(/No such (?:object|container|image)/i.test(before.stderr), 'Cannot prove owned resource absence', 'CLEANUP_FAILED');
    return;
  }
  const [resource] = JSON.parse(before.stdout);
  insist(resource?.Config?.Labels?.[OWNER_LABEL] === state.executionId,
    'Refusing cleanup of a non-owned Docker resource', 'OWNERSHIP_MISMATCH');
  const expectedImage = name === state.tag ? state.image : name === state.dependencyTag ? state.dependencyImage : null;
  insist(kind !== 'image' || !expectedImage || resource.Id === expectedImage,
    'Refusing cleanup of a retargeted owned image', 'OWNERSHIP_MISMATCH');
  await docker(state, kind === 'image' ? ['image', 'rm', resource.Id] : ['rm', '--force', name]);
  const after = await docker(state, inspectArgs, { acceptFailure: true });
  insist(after.exitCode !== 0 && /No such (?:object|container|image)/i.test(after.stderr),
    'Owned Docker resource cleanup incomplete', 'CLEANUP_FAILED');
}

export async function cleanupOwnedWorkspace(state) {
  try {
    if (state.purpose === 'offline-task') await removeOwnedResource(state, 'container', state.name);
    await removeOwnedResource(state, 'image', state.tag);
    await removeOwnedResource(state, 'image', state.dependencyTag);
    assertOwned(state);
    fs.rmSync(state.directory, { recursive: true, force: true });
    insist(!fs.existsSync(state.directory), 'Owned workspace cleanup incomplete', 'CLEANUP_FAILED');
    return { ...(state.purpose === 'offline-task' ? { container: 'removed' } : {}),
      image: 'removed', publicDependencyImage: 'removed', workspace: 'removed',
      owner: state.executionId, verified: true };
  } catch {
    throw new OfflineTaskError(`Owned runtime cleanup could not be verified; retained workspace: ${state.directory}`, 'CLEANUP_FAILED');
  }
}

export async function prepareNativeRuntimeImage(options = {}) {
  record(options, ['timeoutMs'], []);
  const timeoutMs = options.timeoutMs ?? 180000;
  insist(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 300000, 'Invalid native image preparation deadline');
  const executionId = randomUUID();
  const state = createOwnedWorkspace(executionId, null, 'native-runtime-image');
  try {
    const built = await buildPinnedRuntimeImage(state, { deadline: Date.now() + timeoutMs });
    const handle = freeze({ id: executionId, client: 'opencode' });
    const description = freeze({
      id: executionId, client: 'opencode', clientVersion: CLIENT_VERSION,
      clientVersionProvenance: 'pinned-public-package-lock-and-build-version-command',
      image: built.image, imageProvenance: 'owned-docker-image-inspect',
      baseImage: BASE_IMAGE, publicDependencyImage: built.dependency.Id,
      manifestDigest: built.metadata.Descriptor?.digest ?? null, dockerEngine: built.server.Version,
      os: built.metadata.Os, architecture: built.metadata.Architecture,
      user: built.metadata.Config.User, workdir: built.metadata.Config.WorkingDir,
      binary: BINARY, node: '/usr/local/bin/node', ripgrep: '/usr/local/bin/rg',
      helperPaths: { files: '/opt/fixture/task-files.mjs', session: '/opt/fixture/native-session.mjs',
        capture: '/opt/fixture/task-capture.mjs' },
      publicManifestHash: built.publicManifestHash,
      caseFree: true, mockFree: true, status: 'prepared',
      authenticationVerified: false, containmentVerified: false, liveAccepted: false
    });
    handles.set(handle, { state, description, released: false, cleanup: null, cleanupPromise: null });
    return handle;
  } catch (error) {
    await cleanupOwnedWorkspace(state);
    throw error;
  }
}

function originalHandle(handle) {
  const owned = handles.get(handle);
  insist(owned, 'The original process-owned native image handle is required', 'OWNERSHIP_MISMATCH');
  return owned;
}

export function describeNativeRuntimeImage(handle) {
  const owned = originalHandle(handle);
  return freeze({ ...owned.description, status: owned.released ? 'released' : 'prepared',
    cleanup: owned.cleanup });
}

export function assertNativeRuntimeImage(handle, options = {}) {
  record(options, ['client', 'clientVersion', 'image'], []);
  const owned = originalHandle(handle);
  insist(!owned.released && (options.client ?? 'opencode') === 'opencode' &&
    (options.clientVersion ?? CLIENT_VERSION) === CLIENT_VERSION &&
    (options.image ?? owned.description.image) === owned.description.image,
  'Original native image is released or differs from the requested immutable pin', 'OWNERSHIP_MISMATCH');
  return describeNativeRuntimeImage(handle);
}

export async function cleanupNativeRuntimeImage(handle) {
  const owned = originalHandle(handle);
  if (owned.released) return owned.cleanup;
  if (owned.cleanupPromise) return owned.cleanupPromise;
  owned.cleanupPromise = (async () => {
    const cleanup = await cleanupOwnedWorkspace(owned.state);
    owned.cleanup = freeze(cleanup);
    owned.released = true;
    return owned.cleanup;
  })();
  try { return await owned.cleanupPromise; }
  finally { owned.cleanupPromise = null; }
}
