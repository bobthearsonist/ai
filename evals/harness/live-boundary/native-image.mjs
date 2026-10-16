import { CLIENT_VERSIONS, OFFLINE_NODE_VERSION } from '../isolation/index.mjs';
import { describeNativeImage as describeClaudeImage } from '../clients/claude-code/image.mjs';
import { describeNativeImage as describeCopilotImage } from '../clients/copilot/index.mjs';
import { assertNativeRuntimeImage, describeNativeRuntimeImage } from '../clients/opencode/runtime-image.mjs';
import { CANDIDATE_PROFILES, inspectCandidateSeed } from './candidate-seed.mjs';
import { deepFreeze, EgressBoundaryError, insist } from './errors.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const sha256 = /^[a-f0-9]{64}$/;
const baseEnvironment = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  NODE_VERSION: OFFLINE_NODE_VERSION, YARN_VERSION: '1.22.22'
});
const openCodeEnvironment = Object.freeze({
  HOME: '/work/home', XDG_CONFIG_HOME: '/work/config', XDG_CACHE_HOME: '/work/cache',
  XDG_DATA_HOME: '/work/data', XDG_STATE_HOME: '/work/state',
  OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_LSP_DOWNLOAD: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: '1'
});

export const NATIVE_CANDIDATE_PROFILES = deepFreeze({
  'claude-code': {
    ...CANDIDATE_PROFILES['claude-code'], runtime: '/candidate-runtime',
    user: '1000:1000', initialWorkdir: '/workspace', pidsLimit: 64,
    executable: '/opt/client/node_modules/.bin/claude',
    executableRoot: '/opt/client/node_modules/', package: '/opt/client/node_modules/@anthropic-ai/claude-code/package.json',
    imageUser: 'node', imageWorkdir: '/opt/client',
    imageEntrypoint: ['node', '/opt/client/runtime.mjs'], imageOwnerLabel: 'ai.skill-eval.claude-owner',
    directories: ['/workspace', '/home/node', '/home/node/.claude', '/scratch'],
    immutableDirectories: ['/opt/client/node_modules'],
    helpFlags: ['--help', '--version', '--print', '--permission-mode'],
    environment: {
      ...CANDIDATE_PROFILES['claude-code'].environment,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1'
    }
  },
  copilot: {
    ...CANDIDATE_PROFILES.copilot, runtime: '/candidate-runtime',
    user: '10001:10001', initialWorkdir: '/workspace', pidsLimit: 96,
    executable: '/opt/fixture/node_modules/.bin/copilot',
    executableRoot: '/opt/fixture/node_modules/', package: '/opt/fixture/node_modules/@github/copilot/package.json',
    imageUser: '10001:10001', imageWorkdir: '/workspace',
    imageEntrypoint: ['node', '/opt/fixture/probe.mjs'], imageOwnerLabel: 'ai.skill-eval.copilot',
    directories: ['/workspace', '/home/eval', '/client-config/copilot', '/client-config/xdg',
      '/client-config/data', '/client-config/state', '/scratch'],
    immutableDirectories: ['/opt/fixture/node_modules', '/opt/copilot-cache/.cache'],
    helpFlags: ['--help', '--version', '--no-auto-update', '--available-tools'],
    environment: {
      ...CANDIDATE_PROFILES.copilot.environment,
      XDG_CONFIG_HOME: '/client-config/xdg', XDG_DATA_HOME: '/client-config/data',
      XDG_STATE_HOME: '/client-config/state', XDG_CACHE_HOME: '/opt/copilot-cache/.cache'
    }
  },
  opencode: {
    ...CANDIDATE_PROFILES.opencode, runtime: '/candidate-runtime',
    user: '1000:1000', initialWorkdir: '/opt/fixture', pidsLimit: 64,
    executable: '/opt/client/node_modules/opencode-linux-x64/bin/opencode',
    executableRoot: '/opt/client/node_modules/', package: '/opt/client/node_modules/opencode-linux-x64/package.json',
    imageUser: '1000:1000', imageWorkdir: '/opt/fixture',
    imageEntrypoint: ['/opt/client/node_modules/opencode-linux-x64/bin/opencode'],
    imageOwnerLabel: 'ai.skill-eval.opencode-offline',
    directories: ['/work/project', '/work/home', '/work/config', '/work/data/opencode',
      '/work/cache', '/work/state', '/work/scratch', '/scratch'],
    immutableDirectories: ['/opt/client/node_modules', '/opt/fixture'],
    helpFlags: ['--help', '--version'],
    environment: {
      ...CANDIDATE_PROFILES.opencode.environment, ...openCodeEnvironment,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1'
    }
  }
});

export async function captureNativeImageAuthority(client, handle) {
  insist(Object.hasOwn(NATIVE_CANDIDATE_PROFILES, client), 'INVALID_ARGUMENT');
  let description;
  try {
    if (client === 'claude-code') description = describeClaudeImage(handle);
    else if (client === 'copilot') description = describeCopilotImage(handle);
    else {
      assertNativeRuntimeImage(handle, { client, clientVersion: CLIENT_VERSIONS[client] });
      description = describeNativeRuntimeImage(handle);
      insist(description.status === 'prepared', 'NATIVE_IMAGE_UNTRUSTED');
    }
  } catch { throw new EgressBoundaryError('NATIVE_IMAGE_UNTRUSTED'); }
  const owner = client === 'claude-code' ? description.preparationId
    : client === 'copilot' ? description.invocationId : description.id;
  const profile = NATIVE_CANDIDATE_PROFILES[client];
  insist(description.client === client && description.clientVersion === CLIENT_VERSIONS[client] &&
    uuid.test(owner) && imageId.test(description.image) &&
    (client !== 'claude-code' || description.executable === profile.executable) &&
    (client !== 'opencode' || description.binary === profile.executable &&
      description.user === profile.user && description.workdir === profile.imageWorkdir),
  'NATIVE_IMAGE_UNTRUSTED');
  return Object.freeze({ client, handle, owner, imageId: description.image, profile });
}

export async function assertActiveNativeImageAuthority(binding) {
  const current = await captureNativeImageAuthority(binding.client, binding.handle);
  insist(current.owner === binding.owner && current.imageId === binding.imageId, 'NATIVE_IMAGE_UNTRUSTED');
}

// Pure validators support wiring tests; they do not issue candidate or image authority.
export function validateNativeImageMetadata(binding, image) {
  const profile = NATIVE_CANDIDATE_PROFILES[binding.client];
  insist(profile && image?.Id === binding.imageId &&
    image.Config?.Labels?.[profile.imageOwnerLabel] === binding.owner, 'OWNERSHIP_MISMATCH');
  insist(imageId.test(image.Id) && image.Os === 'linux' && image.Architecture === 'amd64' &&
    image.Config.User === profile.imageUser && image.Config.WorkingDir === profile.imageWorkdir &&
    JSON.stringify(image.Config.Entrypoint) === JSON.stringify(profile.imageEntrypoint) &&
    (image.Config.Cmd == null || image.Config.Cmd.length === 0) &&
    Object.keys(image.Config.Volumes ?? {}).length === 0 &&
    Object.keys(image.Config.ExposedPorts ?? {}).length === 0 &&
    (image.Config.OnBuild ?? []).length === 0 && image.Config.Healthcheck == null, 'RUNTIME_DRIFT');
  const expected = {
    ...baseEnvironment, ...(binding.client === 'opencode' ? openCodeEnvironment : {})
  };
  const env = Object.entries(expected).map(([key, value]) => `${key}=${value}`).sort();
  insist(Array.isArray(image.Config.Env) &&
    JSON.stringify([...image.Config.Env].sort()) === JSON.stringify(env), 'CONFIG_MISMATCH');
  return deepFreeze({
    inspectedAt: new Date().toISOString(), id: image.Id, owner: binding.owner,
    ownerLabel: profile.imageOwnerLabel, os: image.Os, architecture: image.Architecture,
    imageUser: image.Config.User, imageWorkdir: image.Config.WorkingDir,
    imageEntrypoint: [...image.Config.Entrypoint], environment: [...image.Config.Env]
  });
}

export function assertNativeCandidateSeed(seed, deadline) {
  const observed = inspectCandidateSeed(seed, deadline);
  for (const relative of [...observed.manifest.keys(), ...observed.directories]) {
    const parts = relative.replaceAll('\\', '/').split('/');
    if (parts.length === 1) continue;
    // The native executable stays in its immutable image, never a staged overlay.
    insist(parts[0] !== 'runtime' && !parts.slice(1).some(part =>
      /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.copilot|\.claude\.json|\.credentials(?:\..*)?|\.netrc|\.npmrc|auth(?:\.json)?|credentials?(?:\..*)?|tokens?(?:\..*)?|secrets?(?:\..*)?|private|judge|grading|expected|reports?|baselines?|node_modules)$/i.test(part)),
    'NATIVE_SEED_INVALID');
  }
  return observed;
}

export function validateNativeRuntimeObservation(binding, runtime) {
  const profile = NATIVE_CANDIDATE_PROFILES[binding.client];
  const [uid, gid] = profile.user.split(':').map(Number);
  const versionMatches = typeof runtime?.versionText === 'string' &&
    (binding.client === 'claude-code' ? runtime.versionText === `${CLIENT_VERSIONS[binding.client]} (Claude Code)`
      : binding.client === 'opencode' ? runtime.versionText === CLIENT_VERSIONS[binding.client]
        : new RegExp(`^GitHub Copilot CLI ${CLIENT_VERSIONS[binding.client].replaceAll('.', '\\.')}\\.[a-zA-Z0-9._-]*(?:\\r?\\n|$)`).test(runtime.versionText));
  insist(runtime?.client === binding.client && runtime.clientVersion === CLIENT_VERSIONS[binding.client] &&
    versionMatches && runtime.nodeVersion === OFFLINE_NODE_VERSION && runtime.uid === uid && runtime.gid === gid &&
    runtime.executable === profile.executable && typeof runtime.resolvedExecutable === 'string' &&
    runtime.resolvedExecutable.startsWith(profile.executableRoot) &&
    !runtime.resolvedExecutable.slice(profile.executableRoot.length).split('/').includes('..') &&
    sha256.test(runtime.executableHash) && runtime.packageVersion === CLIENT_VERSIONS[binding.client] &&
    runtime.cwd === profile.workdir &&
    JSON.stringify(runtime.directories?.map(item => item.path)) === JSON.stringify(profile.directories) &&
    runtime.directories.every(item => item.uid === uid && item.gid === gid && item.writable === true) &&
    JSON.stringify(runtime.immutableDirectories) === JSON.stringify(profile.immutableDirectories) &&
    Array.isArray(runtime.commands) && runtime.commands.length === 2 &&
    runtime.commands.every((item, index) =>
      JSON.stringify(item.argv) === JSON.stringify([
        ...(binding.client === 'copilot' ? ['--no-auto-update'] : []), index === 0 ? '--version' : '--help'
      ]) && item.exitCode === 0 && item.signal === null &&
      Number.isSafeInteger(item.stdoutBytes) && item.stdoutBytes >= 0 && item.stdoutBytes <= 131072 &&
      Number.isSafeInteger(item.stderrBytes) && item.stderrBytes >= 0 &&
      (index === 0 ? item.stdoutBytes > 0 : item.stdoutBytes + item.stderrBytes > 0) &&
      item.stdoutBytes + item.stderrBytes <= 131072 && sha256.test(item.stdoutHash) && sha256.test(item.stderrHash)),
  'RUNTIME_DRIFT');
  return deepFreeze(runtime);
}
