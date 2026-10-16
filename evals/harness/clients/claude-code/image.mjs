import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CLI_VERSION, NODE_VERSION, BASE_IMAGE } from './policy.mjs';
import { TASK_CAPS, OfflineTaskError, exactKeys, insist, freeze } from './task-policy.mjs';
import { runOwnedDocker } from './docker.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
export const IMAGE_OWNER_LABEL = 'ai.skill-eval.claude-owner';
export const ENGINE_VERSION = '29.7.2';

function successful(result, phase, preparationId) {
  insist(result.code === 0 && !result.timedOut && !result.outputLimited && !result.cancelled,
    `Pinned native image ${phase} failed`,
    result.cancelled ? 'NATIVE_IMAGE_CANCELLED' : result.timedOut ? 'NATIVE_IMAGE_TIMEOUT' :
      result.outputLimited ? 'NATIVE_IMAGE_OUTPUT_LIMIT' : 'NATIVE_IMAGE_PREPARATION_FAILED',
    { preparationId, phase, evidence: { code: result.code, signal: result.signal ?? null,
      error: result.error ?? null, stderr: result.stderr.slice(-2000) } });
  return result.stdout;
}

export async function buildPinnedNativeImage({ docker, owner, tag, timeoutMs, signal, requireResult = successful }) {
  insist(typeof docker === 'function' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner) &&
    [`skill-eval-claude-${owner}`, `skill-eval-claude-task-${owner}`,
      `skill-eval-claude-native-image-${owner}`].includes(tag) &&
    Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000,
  'Invalid internal pinned image build coordinates', 'NATIVE_IMAGE_PREPARATION_FAILED');
  const engineVersion = requireResult(await docker(['version', '--format', '{{.Server.Version}}']),
    'engine', owner).trim();
  insist(engineVersion === ENGINE_VERSION, 'Pinned task Docker engine drift', 'OFFLINE_TASK_RUNTIME_DRIFT',
    { executionId: owner, preparationId: owner });
  requireResult(await docker(['build', '--quiet', '--label', `${IMAGE_OWNER_LABEL}=${owner}`, '--tag', tag, directory],
    { timeoutMs, signal }), 'build', owner);
  const inspected = JSON.parse(requireResult(await docker(['image', 'inspect', tag]), 'image inspect', owner));
  insist(Array.isArray(inspected) && inspected.length === 1, 'Invalid pinned image inspection',
    'NATIVE_IMAGE_PREPARATION_FAILED', { preparationId: owner });
  const spec = inspected[0];
  insist(!signal?.aborted, 'Native image preparation cancelled', 'NATIVE_IMAGE_CANCELLED',
    { preparationId: owner, phase: 'image inspect' });
  insist(spec.Config?.Labels?.[IMAGE_OWNER_LABEL] === owner && /^sha256:[a-f0-9]{64}$/.test(spec.Id) &&
    spec.Os === 'linux' && spec.Architecture === 'amd64',
  'Owned task image identity/platform mismatch', 'OFFLINE_TASK_RUNTIME_DRIFT',
  { executionId: owner, preparationId: owner });
  return { spec, engineVersion, image: spec.Id,
    imageSpec: freeze({ id: spec.Id, repoDigests: spec.RepoDigests ?? [], baseImage: BASE_IMAGE,
      nodeVersion: NODE_VERSION, engineVersion, os: spec.Os, architecture: spec.Architecture }) };
}

function noLinks(filename) {
  let current = path.resolve(filename);
  for (;;) {
    insist(!fs.existsSync(current) || !fs.lstatSync(current).isSymbolicLink(),
      'Symlink/reparse point in owned image preparation path', 'NATIVE_IMAGE_OWNERSHIP_FAILED');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

// Injectable only inside this module's tests; the public factory has no command/endpoint override.
export function createNativeImageManager(runDocker = runOwnedDocker) {
  const handles = new WeakMap();

  async function remove(state) {
    const result = await state.docker(['image', 'inspect', state.tag]);
    if (result.code === 0) {
      const records = JSON.parse(successful(result, 'cleanup inspect', state.id));
      insist(records.length === 1 && records[0].Config?.Labels?.[IMAGE_OWNER_LABEL] === state.id &&
        (!state.image || records[0].Id === state.image),
      'Refusing cleanup of a foreign native image', 'NATIVE_IMAGE_OWNERSHIP_FAILED', { preparationId: state.id });
      successful(await state.docker(['image', 'rm', state.tag]), 'cleanup removal', state.id);
      for (const ref of [state.tag, records[0].Id]) {
        const absent = await state.docker(['image', 'inspect', ref]);
        insist(absent.code !== 0 && /No such (?:object|image)/i.test(absent.stderr) &&
          !absent.timedOut && !absent.outputLimited && !absent.cancelled && !absent.error,
        'Native image absence is unverified', 'NATIVE_IMAGE_CLEANUP_FAILED', { preparationId: state.id });
      }
    } else {
      insist(/No such (?:object|image)/i.test(result.stderr) && !result.timedOut && !result.outputLimited &&
        !result.cancelled && !result.error,
        'Native image cleanup inspection failed', 'NATIVE_IMAGE_CLEANUP_FAILED', { preparationId: state.id });
    }
    noLinks(state.runDirectory);
    const marker = JSON.parse(fs.readFileSync(path.join(state.runDirectory, '.owner.json'), 'utf8'));
    insist(marker.preparationId === state.id, 'Refusing cleanup of a foreign image workspace',
      'NATIVE_IMAGE_OWNERSHIP_FAILED', { preparationId: state.id });
    fs.rmSync(state.runDirectory, { recursive: true, force: true });
    insist(!fs.existsSync(state.runDirectory), 'Native image workspace remains', 'NATIVE_IMAGE_CLEANUP_FAILED');
    return freeze({ preparationId: state.id, scoped: true, imageRemoved: true, hostConfigRemoved: true });
  }

  function prepareNativeImage(options = {}) {
    exactKeys(options, ['timeoutMs', 'signal'], 'native image preparation option');
    const timeoutMs = options.timeoutMs ?? TASK_CAPS.buildTimeoutMs;
    insist(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= TASK_CAPS.buildTimeoutMs,
      'Native image build timeout must be 1000..300000 ms', 'NATIVE_IMAGE_PREPARATION_FAILED');
    insist(options.signal === undefined || options.signal instanceof AbortSignal, 'Invalid image cancellation signal');
    insist(!options.signal?.aborted, 'Native image preparation cancelled', 'NATIVE_IMAGE_CANCELLED');
    return (async () => {
      const id = randomUUID(), tag = `skill-eval-claude-native-image-${id}`;
      const runDirectory = path.join(directory, '.runs', `native-image-${id}`);
      const config = path.join(runDirectory, 'docker-config');
      noLinks(runDirectory);
      fs.mkdirSync(config, { recursive: true });
      fs.writeFileSync(path.join(runDirectory, '.owner.json'), JSON.stringify({ preparationId: id }),
        { flag: 'wx', mode: 0o600 });
      const state = { id, tag, runDirectory, image: null,
        docker: (args, options = {}) => runDocker(args, { config, ...options }), cleanup: null, releasing: null };
      try {
        const built = await buildPinnedNativeImage({ docker: state.docker, owner: id, tag, timeoutMs, signal: options.signal });
        state.image = built.image;
        const handle = freeze({ preparationId: id, client: 'claude-code', clientVersion: CLI_VERSION,
          image: built.image, imageSpec: built.imageSpec, caseIndependent: true,
          executable: '/opt/client/node_modules/.bin/claude',
          source: 'public-pinned-native-image-build', authenticationVerified: false, liveAccepted: false });
        handles.set(handle, state);
        return handle;
      } catch (error) {
        const failure = error instanceof OfflineTaskError ? error :
          new OfflineTaskError(error.message, 'NATIVE_IMAGE_PREPARATION_FAILED', { preparationId: id });
        try { failure.cleanup = await remove(state); } catch (cleanupError) {
          failure.cleanupError = { code: cleanupError.code, message: cleanupError.message };
        }
        throw failure;
      }
    })();
  }

  function cleanupNativeImage(handle) {
    const state = handles.get(handle);
    insist(state, 'Original owned native image handle required', 'NATIVE_IMAGE_OWNERSHIP_FAILED');
    if (state.cleanup) return Promise.resolve(state.cleanup);
    if (state.releasing) return state.releasing;
    state.releasing = remove(state).then(cleanup => { state.cleanup = cleanup; return cleanup; })
      .finally(() => { state.releasing = null; });
    return state.releasing;
  }
  function describeNativeImage(handle) {
    const state = handles.get(handle);
    insist(state && !state.cleanup && !state.releasing, 'Original active native image handle required',
      'NATIVE_IMAGE_OWNERSHIP_FAILED');
    return handle;
  }
  return { prepareNativeImage, cleanupNativeImage, describeNativeImage };
}

const manager = createNativeImageManager();
export const prepareNativeImage = manager.prepareNativeImage;
export const cleanupNativeImage = manager.cleanupNativeImage;
export const describeNativeImage = manager.describeNativeImage;
