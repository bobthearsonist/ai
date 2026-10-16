import { BASE_IMAGE, BINARY, CLIENT_VERSION, NATIVE_SESSION_DATABASE, PROMPT_ENVELOPE } from './constants.mjs';
import {
  FIXTURE_HOME, PROJECT, SKILL_ROOT, TASK_CAPS, decodeCaseFiles, freeze, insist, prepareCaseSpec, record, seedPaths, sha256
} from './case-spec.mjs';
import { buildRestrictedTaskConfig } from './task-policy.mjs';
import { planOpenCodeToolTransport } from './native-tool-transport.mjs';

const issuedSpecifications = new WeakSet();

export function assertOriginalNativeTaskSpecification(spec) {
  insist(issuedSpecifications.has(spec), 'The original prepared native specification is required', 'NATIVE_SPECIFICATION_INVALID');
  return spec;
}

export function nativeModelSelection(value) {
  let providerID;
  let modelID;
  if (typeof value === 'string') {
    const separator = value.indexOf('/');
    providerID = value.slice(0, separator);
    modelID = value.slice(separator + 1);
    insist(separator > 0, 'Native model selection requires provider/model');
  } else {
    record(value, ['providerID', 'modelID']);
    ({ providerID, modelID } = value);
  }
  insist(typeof providerID === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(providerID) &&
    providerID !== 'offline-fixture' && typeof modelID === 'string' && modelID.length <= 200 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/.test(modelID) &&
    !modelID.split('/').some(part => !part || part === '.' || part === '..') && modelID !== 'synthetic',
  'A bounded explicit native provider/model, not a synthetic fixture, is required');
  return freeze({ providerID, modelID, selector: `${providerID}/${modelID}` });
}

function dataRoot(value) {
  if (value == null) return null;
  insist(typeof value === 'string' && value.length <= TASK_CAPS.pathChars &&
    /^\/work\/(?:data|auth)(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/.test(value) &&
    !value.split('/').some(part => part === '.' || part === '..'),
  'authRoot is only an intended owned container data location, never a host directory or credential value');
  return value;
}

function proxy(value) {
  if (value == null) return null;
  insist(typeof value === 'string' && value.length <= 400, 'Invalid bounded local CONNECT proxy URL');
  let url;
  try { url = new URL(value); }
  catch { insist(false, 'Invalid local CONNECT proxy URL'); }
  const host = url.hostname;
  const localAddress = /^127(?:\.\d{1,3}){3}$/.test(host) || /^10(?:\.\d{1,3}){3}$/.test(host) ||
    /^192\.168(?:\.\d{1,3}){2}$/.test(host) || /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host);
  const ownedName = /^(?:skill-eval|eval)-[a-z0-9][a-z0-9-]{0,90}$/.test(host);
  insist(url.protocol === 'http:' && !url.username && !url.password && !url.search && !url.hash &&
    url.pathname === '/' && url.port && Number(url.port) >= 1 && Number(url.port) <= 65535 &&
    (localAddress || ownedName || host === 'localhost'),
  'Only a credential-free explicit local/owned CONNECT endpoint is a native proxy plan');
  return url.origin;
}

function limitsPlan(value, timeoutMs) {
  const requested = value ?? {};
  const integerFields = ['maxTurns', 'maxTokens', 'maxInputTokens', 'maxOutputTokens'];
  const currencyFields = ['maxUsd', 'maxCredits'];
  record(requested, ['timeoutMs', 'nativeOutputBytes', ...integerFields, ...currencyFields], []);
  for (const key of integerFields) {
    insist(!Object.hasOwn(requested, key) || Number.isSafeInteger(requested[key]) && requested[key] >= 0,
      'Native turn/token requests must be nonnegative safe integers');
  }
  for (const key of currencyFields) {
    insist(!Object.hasOwn(requested, key) || Number.isFinite(requested[key]) && requested[key] >= 0,
      'Native billing limit requests must be finite nonnegative numbers');
  }
  insist(!Object.hasOwn(requested, 'timeoutMs') || Number.isInteger(requested.timeoutMs) &&
    requested.timeoutMs >= 1000 && requested.timeoutMs <= TASK_CAPS.timeoutMs, 'Invalid supervisor timeout request');
  insist(!Object.hasOwn(requested, 'nativeOutputBytes') || Number.isSafeInteger(requested.nativeOutputBytes) &&
    requested.nativeOutputBytes > 0 && requested.nativeOutputBytes <= TASK_CAPS.wireBytes,
  'Native output byte request must fit the bounded supervisor/parser cap');
  const effectiveTimeout = Math.min(timeoutMs, requested.timeoutMs ?? timeoutMs);
  return {
    requested: { ...requested },
    supervisor: { timeoutMs: effectiveTimeout, stdoutBytes: requested.nativeOutputBytes ?? TASK_CAPS.wireBytes,
      stderrBytes: 128 * 1024,
      artifactBytes: TASK_CAPS.artifactBytes, totalArtifactBytes: TASK_CAPS.totalArtifactBytes,
      provenance: 'fixed-supervisor-plan-not-executed' },
    native: { turns: null, totalTokens: null, inputTokens: null, outputTokens: null, usd: null, credits: null,
      provenance: 'unverified-unsupported-by-retained-native-run-interface' },
    unsupported: [...integerFields, ...currencyFields].filter(key => Object.hasOwn(requested, key))
  };
}

export function prepareNativeTaskSpecification(payload, options) {
  record(payload, ['task', 'prompt', 'skill', 'inputs', 'artifactTargets', 'timeoutMs'],
    ['task', 'prompt', 'skill', 'artifactTargets']);
  record(options, ['model', 'limits', 'authRoot', 'proxyURL', 'toolTransport'], ['model']);
  const common = prepareCaseSpec(payload, payload.artifactTargets);
  const model = nativeModelSelection(options.model);
  const authRoot = dataRoot(options.authRoot);
  const proxyURL = proxy(options.proxyURL);
  const limits = limitsPlan(options.limits, common.timeoutMs);
  const transport = Object.hasOwn(options, 'toolTransport')
    ? planOpenCodeToolTransport(options.toolTransport, common) : null;
  const baseConfig = buildRestrictedTaskConfig(common);
  const config = {
    ...baseConfig,
    ...(transport ? { mcp: transport.mcp, permission: transport.permission } : {}),
    enabled_providers: [model.providerID], model: model.selector, small_model: model.selector
  };  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: FIXTURE_HOME,
    XDG_CONFIG_HOME: '/work/config', XDG_CACHE_HOME: '/work/cache',
    XDG_DATA_HOME: authRoot ?? '/work/data', XDG_STATE_HOME: '/work/state', TMPDIR: '/work/scratch',
    LANG: 'C.UTF-8', CI: '1', NO_COLOR: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DB: NATIVE_SESSION_DATABASE,
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '0', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    ...(transport ? transport.env : {}),
    ...(proxyURL ? { HTTP_PROXY: proxyURL, HTTPS_PROXY: proxyURL, ALL_PROXY: proxyURL,
      http_proxy: proxyURL, https_proxy: proxyURL, all_proxy: proxyURL, NO_PROXY: '', no_proxy: '' } : {})
  };
  const materialization = {
    task: common.task, prompt: common.prompt, skill: { id: common.skill.id, files: common.skill.files },
    inputs: common.inputs, artifactTargets: common.artifactTargets, timeoutMs: limits.supervisor.timeoutMs
  };
  insist(Buffer.byteLength(JSON.stringify(materialization)) <= TASK_CAPS.wireBytes, 'Native seed manifest byte cap exceeded');
  const blockers = [
    'native-account-authentication-and-owned-auth-state-attachment-unverified',
    'native-first-party-auth-plugin-and-pure-mode-compatibility-unverified',
    'native-proxy-support-and-candidate-egress-attachment-unverified',
    'native-runtime-image-and-uid1000-candidate-attachment-unverified',
    'native-account-quotas-total-usage-and-billing-coverage-unverified',
    'native-provider-retry-policy-and-request-count-unverified',
    'native-complete-catalog-config-mcp-and-plugin-observation-required',
    ...(transport ? ['native-late-account-wellknown-managed-config-absence-unverified',
      'native-effective-mcp-catalog-and-agent-permission-observation-required'] : []),
    ...limits.unsupported.map(key => `native-hard-limit-unsupported:${key}`)
  ];
  const spec = freeze({
    format: 'opencode-native-task-specification-v1', client: 'opencode', clientVersion: CLIENT_VERSION,
    task: common.task, model, binary: BINARY, cwd: PROJECT,
    args: ['run', '--pure', '--format', 'json', '--model', model.selector, '--title', 'Owned native evaluation task'],
    stdin: { encoding: 'utf8', text: common.prompt, bytes: Buffer.byteLength(common.prompt),
      submittedHash: sha256(common.prompt), envelope: PROMPT_ENVELOPE,
      envelopeProvenance: 'pinned-public-run-source-and-retained-offline-proof-not-provider-wire',
      framedInputHash: sha256(`\n${common.prompt}`), observedWireHash: null },
    config, env, materialization,
    seeds: seedPaths(common).map(seed => ({ ...seed, mode: seed.executable ? 0o555 : 0o444 })),
    skill: common.skill, artifactTargets: common.artifactTargets,
    layout: { initialWorkdir: '/opt/fixture', project: PROJECT, home: FIXTURE_HOME, skills: SKILL_ROOT, config: '/work/config',
      cache: '/work/cache', data: authRoot ?? '/work/data', state: '/work/state', scratch: '/work/scratch',
      sessionDatabase: NATIVE_SESSION_DATABASE, user: '1000:1000',
      rootfs: 'readonly', tmpfs: '/work:rw,noexec,nosuid,nodev,uid=1000,gid=1000,size=256m' },
    runtimePins: { clientVersion: CLIENT_VERSION, baseImage: BASE_IMAGE, nodeVersion: '22.22.1',
      dockerEngine: '29.7.2', platform: 'linux/amd64' },
    helperPaths: { files: '/opt/fixture/task-files.mjs', session: '/opt/fixture/native-session.mjs',
      capture: '/opt/fixture/task-capture.mjs' },
    auth: { intendedDataRoot: authRoot, credentialValuesAccepted: false,
      authenticationVerified: false, storageLayoutVerified: false, attachmentVerified: false },
    network: { intendedProxyURL: proxyURL, endpointReplacement: false, proxySupportVerified: false,
      attachmentVerified: false, containmentVerified: false },
    plugins: { external: 'disabled-by-pure', firstParty: 'native-pinned-internal-auth-plugins-retained',
      observed: null, compatibilityVerified: false },
    ...(transport ? { toolTransport: transport } : {}),
    limits, blockers, status: 'prepared',
    authenticationVerified: false, containmentVerified: false, liveAccepted: false
  });
  issuedSpecifications.add(spec);
  return spec;
}

export function validateNativeSeedManifest(payload) {
  record(payload, ['task', 'prompt', 'skill', 'inputs', 'artifactTargets', 'timeoutMs']);
  return prepareCaseSpec({ task: payload.task, prompt: payload.prompt, ...decodeCaseFiles(payload),
    timeoutMs: payload.timeoutMs }, payload.artifactTargets);
}
