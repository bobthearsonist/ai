import { createHash } from 'node:crypto';
import { buildRuntimeArguments } from './policy.mjs';

export const TASK_PROTOCOL = 'claude-offline-task@1';
export const TASK_CAPS = Object.freeze({
  files: 32, fileBytes: 16384, sourceBytes: 131072, promptBytes: 16384,
  outputs: 8, artifactBytes: 16384, mockBytes: 65536, directories: 128,
  checks: 128, checkBytes: 262144, pathBytes: 240, pathDepth: 8,
  requests: 96, requestBytes: 2097152, wireBytes: 16777216,
  eventBytes: 1048576, dockerOutputBytes: 4194304,
  buildTimeoutMs: 300000, minTimeoutMs: 1000, maxTimeoutMs: 300000
});
export const BUILTIN_SKILLS = Object.freeze([
  'deep-research', 'dataviz', 'update-config', 'verify', 'debug', 'code-review',
  'simplify', 'batch', 'fewer-permission-prompts', 'doctor', 'loop', 'claude-api',
  'workflow-authoring', 'run', 'run-skill-generator', 'plugin-authoring'
]);
const reservedSkills = new Set([...BUILTIN_SKILLS,
  'agents', 'auto-mode-setup', 'autocompact', 'clear', 'color', 'compact', 'config',
  'output-style', 'context', 'effort', 'fast', 'focus', 'heapdump', 'help', 'init',
  'mcp', 'model', 'reload-plugins', 'reload-skills', 'rename', 'security-review',
  'usage', 'insights', 'recap', 'goal', 'list-agents', 'team-onboarding'
]);
export const BOUNDARY_FILES = Object.freeze([
  '/workspace/private-sentinel.txt', '/workspace/fixtures/escape.txt',
  '/workspace/fixtures/forbidden.txt', '/workspace/not-selected.md'
]);
const stores = new Set([
  '.claude', '.copilot', '.opencode', '.config', '.local', '.git', '.github',
  '.vscode', '.docker', '.ssh', '.aws', '.azure', '.kube', '.cache', 'private', 'judge', 'grader'
]);
const rootControlFiles = new Set([
  'opencode.json', 'opencode.jsonc', 'mcp.json', 'copilot-config.json', 'cline_mcp_settings.json'
]);
const credential = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|\.gitconfig|\.claude\.json|\.mcp\.json|auth\.json|\.credentials\.json|credentials(?:\..*)?|id_rsa|id_ed25519|hosts\.json)$/i;

export class OfflineTaskError extends Error {
  constructor(message, code = 'INVALID_OFFLINE_TASK', details = {}) {
    super(message);
    this.name = 'OfflineTaskError';
    this.code = code;
    this.failureClass = 'infrastructure';
    Object.assign(this, details);
  }
}

export function insist(condition, message, code, details) {
  if (!condition) throw new OfflineTaskError(message, code, details);
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const plain = value => value !== null && typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype;

export function exactKeys(value, allowed, label) {
  insist(plain(value) && Object.keys(value).every(key => allowed.includes(key)),
    `Only explicit ${label} fields are supported`);
}

export function freeze(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function relativeTarget(value) {
  insist(typeof value === 'string' && Buffer.byteLength(value) <= TASK_CAPS.pathBytes,
    'A bounded relative file path is required');
  const parts = value.replaceAll('\\', '/').split('/');
  insist(parts.length <= TASK_CAPS.pathDepth && parts.every(part =>
    part && part !== '.' && part !== '..' && !/[<>:"|?*,=()[\]{}\x00-\x1f\x7f]/.test(part) &&
    !/[. ]$/.test(part) &&
    !/^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)),
  'Escaped, ambiguous, or permission-pattern file path');
  return parts.join('/');
}

export function publicFixturePath(value) {
  const target = relativeTarget(value);
  insist(!target.split('/').some(part => stores.has(part.toLowerCase()) || credential.test(part)) &&
    !rootControlFiles.has(target.toLowerCase()) &&
    !/^(?:AGENTS|CLAUDE)\.md$/i.test(target),
  'Private, credential, instruction, or client-config fixture path is prohibited');
  return target;
}

export function validateCoordinates(task) {
  exactKeys(task, ['invocationId', 'caseId', 'client', 'arm', 'repeat', 'fixtureHash'], 'task');
  const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
  insist(identifier(task.invocationId) && identifier(task.caseId) && task.client === 'claude-code' &&
    ['candidate', 'baseline', 'no-skill'].includes(task.arm) && [1, 2, 3].includes(task.repeat) &&
    typeof task.fixtureHash === 'string' && /^[a-f0-9]{64}$/i.test(task.fixtureHash),
  'Explicit Claude invocation/case/arm/repeat/64hex fixture coordinates required');
  return freeze({ ...task });
}

export function textBytes(content, cap, label) {
  insist(typeof content === 'string' || Buffer.isBuffer(content), `${label} must be explicit string or Buffer bytes`);
  const bytes = Buffer.from(content);
  const text = bytes.toString('utf8');
  insist(bytes.length <= cap, `${label} byte cap exceeded`);
  insist(!text.includes('\0') && Buffer.from(text).equals(bytes) &&
    (typeof content !== 'string' || text === content),
    'This native task profile supports lossless UTF-8 text files only');
  return { bytes, text };
}

export function prepareFiles(files, { skill = false } = {}) {
  insist(Array.isArray(files) && files.length <= TASK_CAPS.files, 'Source file count cap exceeded');
  return files.map(file => {
    exactKeys(file, skill ? ['path', 'content', 'executable'] : ['path', 'content', 'executable', 'mountRoot'], 'file-byte');
    const target = skill ? relativeTarget(file.path) : publicFixturePath(file.path);
    insist(!target.split('/').some(part => credential.test(part) || ['private', 'judge', 'grader'].includes(part.toLowerCase())),
      'Private or credential source files are prohibited');
    const mountRoot = skill ? 'workspace' : file.mountRoot ?? 'workspace';
    insist(['workspace', 'home'].includes(mountRoot), 'Unknown fixture mount root');
    insist(file.executable === undefined || typeof file.executable === 'boolean', 'Executable must be a boolean');
    const { bytes, text } = textBytes(file.content, TASK_CAPS.fileBytes, 'Source file');
    const lines = text.split('\n');
    insist(lines.length <= 512 && lines.every(line => line.length <= 1600),
      'Source text exceeds the bounded complete native Read profile');
    return { path: target, mountRoot, content: bytes, text, executable: file.executable === true,
      sha256: sha256(bytes), bytes: bytes.length };
  });
}

export function validateSkill(skill, arm) {
  exactKeys(skill, ['id', 'files'], 'skill');
  insist(typeof skill.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id) &&
    skill.id.length <= 64 && !reservedSkills.has(skill.id),
  'A non-builtin portable native skill identifier is required');
  const files = prepareFiles(skill.files, { skill: true });
  if (arm === 'no-skill') insist(files.length === 0, 'No-skill tasks must not install skill files');
  else {
    const main = files.find(file => file.path === 'SKILL.md');
    insist(main, 'Candidate/baseline requires a genuine root SKILL.md');
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(main.text);
    insist(frontmatter && frontmatter[2].trim(), 'Genuine SKILL.md requires frontmatter and a nonempty body');
    const names = frontmatter[1].match(/^name:[ \t]*(.+)$/gm) ?? [];
    const name = names[0]?.replace(/^name:[ \t]*/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
    const descriptions = [...frontmatter[1].matchAll(/^description:[ \t]*(.*)$/gm)];
    const description = descriptions[0]?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    const blockDescription = /^[>|][+-]?$/.test(description ?? '') &&
      /^[ \t]+\S/m.test(frontmatter[1].slice((descriptions[0]?.index ?? 0) + descriptions[0]?.[0].length));
    insist(names.length === 1 && name === skill.id && descriptions.length === 1 &&
      description && (!/^[>|]/.test(description) || blockDescription),
    'SKILL.md must declare its exact name and a nonempty description');
    insist(!/^(?:allowed-tools|hooks|context|agent):/m.test(frontmatter[1]),
      'This profile does not support skill-scoped permission grants, hooks, or forked subagents');
  }
  return { id: skill.id, files };
}

/** Check both leaf collisions and case aliases of shared directory components. */
export function validatePaths(sources, targets) {
  const aliases = new Map();
  const leaves = [];
  for (const item of [...sources.map(source => ({ path: source.absolute, source: true })),
    ...targets.map(target => ({ path: `/workspace/${target}`, source: false })),
    ...BOUNDARY_FILES.map(filename => ({ path: filename, source: true }))]) {
    const key = item.path.toLowerCase();
    insist(!leaves.some(existing => existing === key || existing.startsWith(`${key}/`) || key.startsWith(`${existing}/`)),
      'Duplicate or colliding input/output/reserved file path');
    leaves.push(key);
    const parts = item.path.split('/');
    for (let index = 2; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const alias = prefix.toLowerCase();
      insist(!aliases.has(alias) || aliases.get(alias) === prefix, 'Ambiguous case-insensitive directory or target alias');
      aliases.set(alias, prefix);
    }
  }
}

export function prepareMock(mock, targets) {
  exactKeys(mock, ['loadSkill', 'artifacts'], 'scripted local inference mock');
  insist(typeof mock.loadSkill === 'boolean' && Array.isArray(mock.artifacts) &&
    mock.artifacts.length <= TASK_CAPS.outputs, 'Explicit bounded scripted mock required');
  const seen = new Set();
  let bytes = 0;
  const artifacts = mock.artifacts.map(artifact => {
    exactKeys(artifact, ['path', 'content'], 'mock artifact');
    const target = publicFixturePath(artifact.path);
    insist(targets.includes(target) && !seen.has(target.toLowerCase()),
      'Mock artifact must select a unique declared artifact target without aliases');
    seen.add(target.toLowerCase());
    insist(typeof artifact.content === 'string', 'Mock artifact content must be an explicit string');
    const prepared = textBytes(artifact.content, TASK_CAPS.artifactBytes, 'Mock artifact');
    bytes += prepared.bytes.length;
    insist(bytes <= TASK_CAPS.mockBytes, 'Mock artifact aggregate byte cap exceeded');
    return { path: target, content: prepared.text };
  });
  return freeze({ loadSkill: mock.loadSkill, artifacts });
}

export function taskRuntimeArguments(help, { skillId, targets, prompt }) {
  const args = buildRuntimeArguments(help);
  args[args.indexOf('--tools') + 1] = targets.length ? 'Skill,Read,Write' : 'Skill,Read';
  args[args.indexOf('--allowedTools') + 1] = `Skill(${skillId})`;
  args[args.indexOf('--disallowedTools') + 1] = targets.length
    ? 'Bash,Edit,WebFetch,WebSearch' : 'Bash,Write,Edit,WebFetch,WebSearch';
  args.pop();
  return [...args, '--', prompt];
}

export function taskTmpfs(sources, targets) {
  const result = {
    '/workspace': '16m', '/home/node': '16m', '/probe': '4m', '/private': '4m', '/scratch': '32m'
  };
  for (const filename of [
    ...sources.filter(source => source.kind === 'input').map(source => source.absolute),
    ...targets.map(target => `/workspace/${target}`)
  ]) {
    const parts = filename.split('/');
    const rootDepth = filename.startsWith('/home/node/') ? 3 : 2;
    for (let index = rootDepth + 1; index < parts.length; index++) {
      result[parts.slice(0, index).join('/')] = '1m';
    }
  }
  insist(Object.keys(result).length <= TASK_CAPS.directories, 'Owned directory scaffold cap exceeded');
  return freeze(result);
}

export function taskSettings({ skillId, sources, targets }) {
  return {
    disableAllHooks: true, autoMemoryEnabled: false,
    permissions: {
      defaultMode: 'dontAsk',
      allow: [`Skill(${skillId})`, ...sources.map(source => `Read(/${source.absolute})`),
        ...targets.map(target => `Edit(//workspace/${target})`)],
      deny: [
        'Read(//proc/**)', 'Read(//private/**)', 'Read(//opt/**)', 'Read(//probe/**)',
        'Read(//etc/**)', 'Read(//scratch/**)', 'Read(//workspace/.env*)',
        'Read(//home/node/.claude/**)', 'Read(//home/node/.claude.json)',
        'Read(//workspace/.claude/settings*.json)', 'Read(//workspace/private-sentinel.txt)',
        'Edit(//workspace/.claude/**)', 'Edit(//home/node/.claude/**)',
        'Edit(//home/node/.claude.json)', 'Edit(//private/**)', 'Edit(//probe/**)',
        'Edit(//scratch/**)', ...sources.map(source => `Edit(/${source.absolute})`),
        'Bash', ...(targets.length ? [] : ['Write']), 'Edit', 'WebFetch', 'WebSearch'
      ],
      disableBypassPermissionsMode: 'disable', disableAutoMode: 'disable'
    }
  };
}

export function taskAttacks(sources, skillId) {
  return [
    { name: 'Read', input: { file_path: '/proc/self/environ' } },
    { name: 'Read', input: { file_path: '/private/credentials' } },
    { name: 'Read', input: { file_path: '/workspace/../private/credentials' } },
    { name: 'Read', input: { file_path: '/workspace/private-sentinel.txt' } },
    { name: 'Read', input: { file_path: '/workspace/fixtures/escape.txt' } },
    { name: 'Read', input: { file_path: '/probe/settings.json' } },
    { name: 'Read', input: { file_path: '/home/node/.claude.json' } },
    { name: 'Bash', input: { command: 'cat /private/credentials' } },
    { name: 'WebFetch', input: { url: 'https://example.invalid', prompt: 'Fetch' } },
    ...['/workspace/fixtures/forbidden.txt', '/workspace/not-selected.md',
      '/home/node/.claude/forbidden.json', '/workspace/.claude/settings.json',
      `/workspace/.claude/skills/${skillId}/SKILL.md`, '/private/credentials', '/probe/forbidden.json',
      ...sources.map(source => source.absolute)].filter((filename, index, all) => all.indexOf(filename) === index)
      .map(filename => ({ name: 'Write', input: { file_path: filename, content: 'SYNTHETIC_FORBIDDEN_TASK_WRITE' } })),
    { name: 'Edit', input: { file_path: sources[0]?.absolute ?? '/workspace/private-sentinel.txt',
      old_string: 'synthetic', new_string: 'forbidden' } }
  ];
}
