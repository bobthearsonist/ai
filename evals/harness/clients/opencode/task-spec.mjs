import {
  TASK_CAPS, PROJECT, FIXTURE_HOME, SKILL_ROOT, PRIVATE_CANARY_PATH, SENTINEL_PATH,
  decodeCaseFiles, freeze, insist, prepareCaseSpec, readablePath, record, seedPaths
} from './case-spec.mjs';

export {
  TASK_CAPS, PROJECT, FIXTURE_HOME, SKILL_ROOT, PRIVATE_CANARY_PATH, SENTINEL_PATH, SENTINEL,
  OfflineTaskError, freeze, insist, record, relativePath, sha256, taskMarkers, seedPaths
} from './case-spec.mjs';

export function prepareTaskSpec(options, targets) {
  const common = prepareCaseSpec(options, targets);
  const { mock } = options;
  record(mock, ['loadSkill', 'artifacts']);
  insist(typeof mock.loadSkill === 'boolean' && Array.isArray(mock.artifacts) &&
    mock.artifacts.length <= TASK_CAPS.targets, 'Explicit scripted local inference fixture required');
  const artifactPaths = new Set();
  let artifactBytes = 0;
  const artifacts = mock.artifacts.map(artifact => {
    record(artifact, ['path', 'content']);
    const filename = readablePath(artifact.path);
    insist(common.artifactTargets.includes(filename), 'Mock artifacts must target an exact declared output');
    insist(!artifactPaths.has(filename.toLowerCase()), 'Duplicate/colliding mock artifact');
    artifactPaths.add(filename.toLowerCase());
    insist(typeof artifact.content === 'string' && Buffer.byteLength(artifact.content) <= TASK_CAPS.artifactBytes,
      'Mock artifact content must be a bounded explicit string');
    artifactBytes += Buffer.byteLength(artifact.content);
    insist(artifactBytes <= TASK_CAPS.totalArtifactBytes, 'Aggregate mock artifact byte cap exceeded');
    return { path: filename, content: artifact.content };
  });
  const spec = { ...common, mock: { loadSkill: mock.loadSkill, artifacts } };
  insist(taskCalls(spec).length <= TASK_CAPS.calls, 'Scripted native call cap exceeded');
  return freeze(spec);
}

export function taskCalls(spec) {
  const calls = [];
  const add = (tool, input, expectation, kind) => calls.push({ tool, input, expectation, kind });
  if (spec.mock.loadSkill) add('skill', { name: spec.skill.id },
    spec.skill.files.length ? 'completed' : 'not-found', 'target-skill');
  for (const file of seedPaths(spec)) {
    if (file.kind === 'fixture' || spec.mock.loadSkill) {
      add('read', { filePath: file.filePath, limit: 20000 }, 'completed', 'seed-read');
    }
  }
  for (const artifact of spec.mock.artifacts) {
    add('write', { filePath: `${PROJECT}/${artifact.path}`, content: artifact.content }, 'completed', 'artifact-create');
  }
  for (const filename of ['/proc/self/environ', PRIVATE_CANARY_PATH, SENTINEL_PATH]) {
    add('read', { filePath: filename }, 'denied', 'protected-read');
  }
  add('bash', { command: 'printf attack', description: 'Synthetic task boundary denial' }, 'unavailable', 'protected-tool');
  add('webfetch', { url: 'https://example.invalid/', format: 'text' }, 'unavailable', 'protected-tool');
  const protectedWrites = new Set([
    `${PROJECT}/attacker.txt`, `${FIXTURE_HOME}/attacker.txt`, '/work/config/opencode/opencode.json',
    PRIVATE_CANARY_PATH, SENTINEL_PATH, `${SKILL_ROOT}/${spec.skill.id}/SKILL.md`,
    ...seedPaths(spec).map(file => file.filePath),
    ...['answer.md', 'message.txt'].filter(target => !spec.artifactTargets.includes(target)).map(target => `${PROJECT}/${target}`)
  ]);
  for (const filename of protectedWrites) add('write', { filePath: filename, content: 'attack' }, 'denied', 'protected-write');
  return calls;
}

export function buildTaskArguments(spec, executionId) {
  insist(/^[a-f0-9-]{36}$/.test(executionId), 'Invalid trusted execution ID');
  return ['run', '--pure', '--format', 'json', '--model', 'offline-fixture/synthetic',
    '--title', `Owned offline task ${executionId}`];
}

export function buildTaskEnvironment(config) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: FIXTURE_HOME,
    XDG_CONFIG_HOME: '/work/config', XDG_CACHE_HOME: '/work/cache',
    XDG_DATA_HOME: '/work/data', XDG_STATE_HOME: '/work/state', TMPDIR: '/work/scratch',
    LANG: 'C.UTF-8', CI: '1', NO_COLOR: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config), SYNTHETIC_AUTH_CANARY: 'synthetic-opencode-canary',
    OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1'
  };
}

export function nativePayload(spec, executionId, timeoutMs) {
  return { protocol: 1, executionId, task: spec.task, prompt: spec.prompt,
    skill: { id: spec.skill.id, files: spec.skill.files }, inputs: spec.inputs,
    artifactTargets: spec.artifactTargets, mock: spec.mock, timeoutMs };
}

export function validateNativePayload(payload) {
  record(payload, ['protocol', 'executionId', 'task', 'prompt', 'skill', 'inputs', 'artifactTargets', 'mock', 'timeoutMs']);
  insist(payload.protocol === 1 && /^[a-f0-9-]{36}$/.test(payload.executionId), 'Invalid native task protocol');
  return prepareTaskSpec({ task: payload.task, prompt: payload.prompt, ...decodeCaseFiles(payload),
    mock: payload.mock, timeoutMs: payload.timeoutMs }, payload.artifactTargets);
}
