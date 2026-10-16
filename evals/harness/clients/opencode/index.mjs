import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BASE_IMAGE, BINARY, CLIENT_VERSION, OWNER_LABEL, TRANSPORT } from './constants.mjs';
import { parseNativeEvents } from './native-events.mjs';

export { CLIENT_VERSION, BASE_IMAGE, OWNER_LABEL, TRANSPORT, BINARY } from './constants.mjs';
export { prepareNativeTaskSpecification } from './native-spec.mjs';
export { parseNativeTaskEvidence } from './native-evidence.mjs';

export async function prepareNativeRuntimeImage(options) {
  return (await import('./runtime-image.mjs')).prepareNativeRuntimeImage(options);
}

export async function describeNativeRuntimeImage(handle) {
  return (await import('./runtime-image.mjs')).describeNativeRuntimeImage(handle);
}

export async function assertNativeRuntimeImage(handle, options) {
  return (await import('./runtime-image.mjs')).assertNativeRuntimeImage(handle, options);
}

export async function cleanupNativeRuntimeImage(handle) {
  return (await import('./runtime-image.mjs')).cleanupNativeRuntimeImage(handle);
}

export async function runOfflineTask(options) {
  const task = await import('./task.mjs');
  return task.runOfflineTask(options);
}

export function validateArtifactTargets(targets, { required = false } = {}) {
  if (!Array.isArray(targets) || targets.length > 2 || required && !targets.length ||
    targets.some(t => !['answer.md', 'message.txt'].includes(t)) || new Set(targets).size !== targets.length) {
    throw new Error('Artifact targets must be unique explicit answer.md/message.txt basenames');
  }
  return [...targets];
}

export function buildConfig({ baseURL = 'http://127.0.0.1:43128/v1', artifactTargets = [] } = {}) {
  if (baseURL !== 'http://127.0.0.1:43128/v1') throw new Error('Only the owned loopback fixture is supported');
  const targets = validateArtifactTargets(artifactTargets);
  return {
    autoupdate: false, share: 'disabled', plugin: [], mcp: {}, instructions: [],
    enabled_providers: ['offline-fixture'],
    model: 'offline-fixture/synthetic', small_model: 'offline-fixture/synthetic',
    provider: {
      'offline-fixture': {
        npm: '@ai-sdk/anthropic', name: 'Offline scripted inference',
        options: { baseURL, apiKey: 'synthetic-opencode-canary', timeout: 10000 },
        models: { synthetic: { name: 'Synthetic; not quality evidence', limit: { context: 32000, output: 1024 } } }
      }
    },
    permission: {
      '*': 'deny',
      skill: { '*': 'deny', 'offline-target': 'allow' },
      read: { '*': 'deny', '/work/project/fixture.txt': 'allow' },
      // The pinned non-Git workspace uses "/" as worktree; native Write matches worktree-relative paths.
      edit: { '*': 'deny', ...Object.fromEntries(targets.map(t => [`work/project/${t}`, 'allow'])) },
      external_directory: 'deny'
    }
  };
}

export function buildArguments() {
  return ['run', '--pure', '--format', 'json', '--model', 'offline-fixture/synthetic',
    '--title', 'Owned offline fixture', 'Exercise the offline fixture tools.'];
}

export function parseEvents(stdout, { exitCode = 0, timedOut = false, cancelled = false, allowToolErrors = false } = {}) {
  const parsed = parseNativeEvents(stdout, { exitCode, timedOut, cancelled, allowToolErrors });
  const { events, tools, completion } = parsed;
  const usage = parsed.usage ? { ...parsed.usage, source: 'synthetic-inference-fixture' } : null;
  const loaded = tools.filter(p => p.tool === 'skill' && p.state.status === 'completed' &&
    p.state.input?.name === 'offline-target' && p.state.output?.includes('OFFLINE_SKILL_BODY'));
  return {
    client: 'opencode', clientVersion: CLIENT_VERSION, transport: TRANSPORT, events,
    trigger: { attempted: tools.some(p => p.tool === 'skill'), loaded: loaded.length > 0,
      failedCalls: tools.filter(p => p.tool === 'skill' && p.state.status === 'error').length },
    tools, usage, completion, modelQualityEvidence: false
  };
}

export function validateProbe({ positive, negative, attacks, requests, writeAbsent, network, artifactTargets, artifacts, protectedFiles }) {
  const targets = validateArtifactTargets(artifactTargets, { required: true });
  const happy = parseEvents(positive.stdout, positive);
  const control = parseEvents(negative.stdout, { ...negative, allowToolErrors: true });
  const denied = parseEvents(attacks.stdout, { ...attacks, allowToolErrors: true });
  if (!happy.trigger.loaded || happy.tools.length !== 2 + targets.length ||
    !happy.tools.some(p => p.tool === 'read' && p.state.status === 'completed' &&
      p.state.input.filePath === '/work/project/fixture.txt' && p.state.output.includes('SCOPED_FIXTURE_CONTENT'))) throw new Error('Missing actual skill/read success');
  if (control.trigger.loaded || control.tools.length !== 1 + targets.length || control.tools[0].tool !== 'skill' ||
    control.tools[0].state.status !== 'error' || !control.tools[0].state.error.includes('not found')) throw new Error('No-skill control failed');
  for (const [scenario, parsed] of [['positive', happy], ['negative', control]]) {
    for (const target of targets) {
      const content = `OFFLINE_ARTIFACT_${target}\n`;
      if (!parsed.tools.some(p => p.tool === 'write' && p.state.status === 'completed' &&
        p.state.input.filePath === `/work/project/${target}` && p.state.input.content === content) ||
        artifacts?.[scenario]?.[target]?.content !== content || artifacts[scenario][target].regularFile !== true) {
        throw new Error(`Missing actual native artifact write: ${scenario}/${target}`);
      }
    }
    if (parsed.tools.some(p => p.state.status === 'error' && p.tool !== 'skill')) throw new Error('Artifact tool failed');
  }
  const expected = [
    ['read', 'filePath', '/proc/self/environ'], ['read', 'filePath', '/work/project/private/credential.txt'],
    ['read', 'filePath', '/work/project/out-of-scope.txt'], ['bash', 'command', 'printf attack'],
    ['webfetch', 'url', 'https://example.invalid/'], ['write', 'filePath', '/work/project/attacker.txt'],
    ['write', 'filePath', '/work/attacks/home/attacker.txt'],
    ['write', 'filePath', '/work/attacks/config/opencode/opencode.json'],
    ['write', 'filePath', '/work/project/fixture.txt'],
    ['write', 'filePath', '/work/project/private/credential.txt'],
    ['write', 'filePath', '/work/project/.opencode/skills/offline-target/SKILL.md'],
    ...['answer.md', 'message.txt'].filter(t => !targets.includes(t)).map(t => ['write', 'filePath', `/work/project/${t}`])
  ];
  if (denied.tools.length !== expected.length) throw new Error('Missing denial attempts');
  const evidence = expected.map(([tool, key, value], i) => {
    const p = denied.tools[i];
    if (p.tool !== tool || p.state.input[key] !== value || p.state.status !== 'error' ||
      !/rule which prevents|unavailable tool/.test(p.state.error) ||
      tool === 'write' && !p.state.error.includes('rule which prevents')) throw new Error(`Denial failed: ${tool}`);
    return { tool, input: p.state.input, status: p.state.status,
      outcome: p.state.error.includes('unavailable tool') ? 'unavailable' : 'permission-denied', error: p.state.error };
  });
  const counts = { positive: 2 + targets.length, negative: 1 + targets.length, attacks: expected.length };
  if (!Array.isArray(requests) || requests.length !== Object.values(counts).reduce((n, count) => n + count + 1, 0) ||
    requests.some(r => !Array.isArray(r.tools) || !['skill', 'read', 'write'].every(t => r.tools.includes(t)) ||
      r.tools.some(t => !['skill', 'read', 'write', 'edit', 'multiedit', 'apply_patch'].includes(t)))) throw new Error('Unexpected provider/tool surface');
  const exposed = requests.flatMap(r => r.results);
  if (JSON.stringify(exposed).includes('synthetic-opencode-canary') || JSON.stringify(exposed).includes('OUT_OF_SCOPE_SENTINEL')) throw new Error('Credential/sentinel disclosure');
  for (const [scenario, count] of Object.entries(counts)) {
    const results = requests.filter(r => r.scenario === scenario).at(-1)?.results;
    if (!Array.isArray(results) || results.length !== count) throw new Error('Missing real tool feedback to provider');
    if (scenario === 'attacks' && results.some(r => r.is_error !== true) ||
      scenario === 'negative' && (results[0].is_error !== true || results.slice(1).some(r => r.is_error === true)) ||
      scenario === 'positive' && results.some(r => r.is_error === true)) throw new Error('Missing real tool feedback status');
  }
  const protectedKeys = ['homeWriteAbsent', 'configWriteAbsent', 'fixtureUnchanged', 'credentialUnchanged', 'skillUnchanged', 'sentinelUnchanged'];
  if (!writeAbsent || !protectedFiles || Object.keys(protectedFiles).length !== protectedKeys.length ||
    protectedKeys.some(key => protectedFiles[key] !== true) ||
    network?.externalBlocked !== true || network?.interfaces?.some(n => n !== 'lo')) throw new Error('Containment evidence failed');
  return {
    client: 'opencode', clientVersion: CLIENT_VERSION, transport: TRANSPORT, accepted: true,
    events: happy.events, trigger: happy.trigger, usage: happy.usage, completion: happy.completion,
    modelQualityEvidence: false, positive: happy, negative: control,
    artifactTargets: targets, artifacts, artifactWritesVerified: true, pilotWritesVerified: true,
    denials: { verified: true, evidence, events: denied.events, writeAbsent, protectedFiles, credentialDisclosed: false },
    network, requests, liveAccepted: false,
    liveBlockers: ['No real provider credentials or paid-smoke consent', 'No exact baseline approval',
      'Live direct-endpoint egress/credential verifier remains blocked']
  };
}

export function dockerRunArguments({ image, name, owner, artifactTargets = ['answer.md', 'message.txt'] }) {
  const targets = validateArtifactTargets(artifactTargets, { required: true });
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !/^[a-z0-9-]+$/.test(name) || !/^[a-f0-9-]+$/.test(owner)) {
    throw new Error('Invalid owned Docker identity');
  }
  return ['run', '--rm', '--name', name, '--label', `${OWNER_LABEL}=${owner}`,
    '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '768m', '--cpus', '1',
    '--tmpfs', '/work:rw,nosuid,nodev,uid=1000,gid=1000,size=256m',
    '--env', `EVAL_OPENCODE_ARTIFACT_TARGETS=${JSON.stringify(targets)}`,
    image];
}

export function runOfflineProbe({ docker = 'docker', timeoutMs = 180000, artifactTargets = ['answer.md', 'message.txt'] } = {}) {
  const targets = validateArtifactTargets(artifactTargets, { required: true });
  if (docker !== 'docker' || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Invalid probe options');
  const owner = randomUUID();
  const tag = `skill-eval-opencode:${owner}`;
  const name = `skill-eval-opencode-${owner}`;
  const context = fileURLToPath(new URL('.', import.meta.url));
  const run = (args, timeout = timeoutMs) => {
    const r = spawnSync(docker, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error(`Docker command failed: ${r.error?.code ?? r.status}\n${r.stderr ?? ''}`);
    return r.stdout;
  };
  let image;
  let manifestDigest;
  try {
    const engine = run(['version', '--format', '{{.Server.Version}}']).trim();
    if (engine !== '29.7.2') throw new Error('Docker engine drift');
    run(['build', '--pull=false', '--label', `${OWNER_LABEL}=${owner}`, '-t', tag, context], 300000);
    const metadata = JSON.parse(run(['image', 'inspect', tag]))[0];
    if (metadata.Config.Labels[OWNER_LABEL] !== owner) throw new Error('Image ownership mismatch');
    image = metadata.Id;
    const descriptor = JSON.parse(run(['image', 'inspect', tag]))[0].Descriptor;
    manifestDigest = descriptor?.digest ?? null;
    const result = JSON.parse(run(dockerRunArguments({ image, name, owner, artifactTargets: targets })));
    validateProbe({ ...result.scenarios, requests: result.requests, network: result.network, writeAbsent: result.denials?.writeAbsent,
      artifactTargets: targets, artifacts: result.artifacts, protectedFiles: result.denials?.protectedFiles });
    if (!result.accepted || result.pilotWritesVerified !== true || result.transport !== TRANSPORT || result.clientVersion !== CLIENT_VERSION ||
      result.versions?.node !== '22.22.1' || !result.freshHomePerScenario || !result.freshWorkspacePerScenario) throw new Error('Offline probe did not pass');
    return { ...result, image, manifestDigest, baseImage: BASE_IMAGE, dockerEngine: engine, owner,
      cleanup: { container: 'removed', image: 'removed' } };
  } finally {
    const c = spawnSync(docker, ['inspect', name], { encoding: 'utf8' });
    if (c.status === 0 && JSON.parse(c.stdout)[0]?.Config?.Labels?.[OWNER_LABEL] === owner) run(['rm', '-f', name]);
    const i = spawnSync(docker, ['image', 'inspect', tag], { encoding: 'utf8' });
    if (i.status === 0 && JSON.parse(i.stdout)[0]?.Config?.Labels?.[OWNER_LABEL] === owner) run(['image', 'rm', tag]);
  }
}
