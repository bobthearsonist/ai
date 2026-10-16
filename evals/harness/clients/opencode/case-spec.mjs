import { createHash } from 'node:crypto';

export const TASK_CAPS = Object.freeze({
  files: 64, seedBytes: 1024 * 1024, fileBytes: 16 * 1024, promptBytes: 64 * 1024,
  checks: 128, checkBytes: 1024 * 1024, targets: 16, artifactBytes: 64 * 1024, totalArtifactBytes: 256 * 1024,
  pathChars: 160, calls: 160, wireBytes: 2 * 1024 * 1024, timeoutMs: 300000
});
export const PROJECT = '/work/project';
export const FIXTURE_HOME = '/work/home';
export const SKILL_ROOT = `${PROJECT}/.opencode/skills`;
export const PRIVATE_CANARY_PATH = `${PROJECT}/private/credential.txt`;
export const SENTINEL_PATH = `${PROJECT}/out-of-scope.txt`;
export const SENTINEL = 'OUT_OF_SCOPE_SENTINEL';

export class OfflineTaskError extends Error {
  constructor(message, code = 'INVALID_TASK') {
    super(message);
    this.name = 'OfflineTaskError';
    this.code = code;
    this.failureClass = 'infrastructure';
  }
}

export function insist(condition, message, code) {
  if (!condition) throw new OfflineTaskError(message, code);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function taskMarkers(executionId) {
  insist(/^[a-f0-9-]{36}$/.test(executionId), 'Invalid trusted task marker identity');
  return { canary: `synthetic-opencode-task-canary-${executionId}`, sentinel: `${SENTINEL}_${executionId}` };
}

export function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function record(value, allowed, required = allowed) {
  insist(value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)),
  'Only the documented explicit data fields are supported');
}

export function relativePath(value) {
  insist(typeof value === 'string' && value.length > 0 && value.length <= TASK_CAPS.pathChars,
    'Invalid bounded relative path');
  const parts = value.split(/[/\\]/);
  insist(parts.every(part => /^[a-zA-Z0-9._ -]+$/.test(part) && part !== '.' && part !== '..' &&
    !/[. ]$/.test(part) &&
    !/^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)),
  'Escaped, aliased, nonportable, or glob-bearing path');
  return parts.join('/');
}

export function readablePath(value, { skill = false } = {}) {
  const normalized = relativePath(value);
  const parts = normalized.toLowerCase().split('/');
  const stores = ['.git', '.opencode', '.claude', '.copilot', '.config', '.local', '.cache', '.agents', '.github',
    '.ssh', '.aws', '.azure', '.gnupg', '.npm'];
  insist(!stores.includes(parts[0]) &&
    (skill || parts.length !== 1 || !/^(?:opencode\.jsonc?|\.?mcp\.jsonc?|\.gitconfig)$/.test(parts[0])),
  'Automatic client configuration, hook, plugin, or discovery stores are prohibited');
  insist(!parts.some(part =>
    /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|auth\.json|\.credentials\.json|credentials(?:\..*)?|id_rsa|id_ed25519|hosts\.json)$/i.test(part)),
  'Credential files are prohibited');
  insist(!parts.some(part => ['private', '.private', 'judge', '.judge', 'grader', '.grader', 'checks', 'specimens'].includes(part)) &&
    !parts.some(part => /^(?:specimens\.json|answer[-_]keys?(?:\..*)?|private[-_]checks?(?:\..*)?)$/.test(part)),
  'Private grading inputs are prohibited');
  insist(!['attacker.txt', 'out-of-scope.txt'].includes(parts[0]), 'Reserved protected task path');
  insist(skill || parts[0] !== '.offline-task', 'Reserved task infrastructure path');
  return normalized;
}

function identifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
}

function pathRegistry() {
  const files = new Set();
  const spelling = new Map();
  return (root, filename) => {
    const key = `${root}/${filename}`;
    const folded = key.toLowerCase();
    const pieces = key.split('/');
    for (let i = 1; i <= pieces.length; i++) {
      const prefix = pieces.slice(0, i).join('/');
      const alias = prefix.toLowerCase();
      insist(!spelling.has(alias) || spelling.get(alias) === prefix, 'Case-insensitive directory/path alias');
      spelling.set(alias, prefix);
    }
    insist(![...files].some(other => other !== folded &&
      (other.startsWith(`${folded}/`) || folded.startsWith(`${other}/`))),
    'Seed/output or file/ancestor path collision');
    insist(!files.has(folded), 'Duplicate or seed/output path collision');
    files.add(folded);
  };
}

function skillBody(bytes, id) {
  const document = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
  insist(match, 'A genuine SKILL.md with frontmatter is required');
  const names = [...match[1].matchAll(/^name:\s*([^\r\n]+)$/gm)];
  const descriptions = [...match[1].matchAll(/^description:\s*([^\r\n]+)$/gm)];
  insist(names.length === 1 && descriptions.length === 1, 'SKILL.md requires one name and description');
  const scalar = names[0][1].trim().replace(/^(['"])(.*)\1$/, '$2');
  insist(scalar === id, 'SKILL.md name must match the explicit skill ID');
  const description = descriptions[0][1].trim();
  insist(!['', '""', "''", 'null', '~'].includes(description) &&
    (!/^[|>][-+]?/.test(description) || /^\s+\S/m.test(match[1])),
  'SKILL.md description must be nonempty');
  const body = document.slice(match[0].length).trim();
  insist(body.length > 0, 'SKILL.md requires nonempty native skill content');
  return body;
}

export function prepareCaseSpec({ task, prompt, skill, inputs = [], timeoutMs = 180000 }, targets) {
  record(task, ['invocationId', 'caseId', 'client', 'arm', 'repeat', 'fixtureHash']);
  insist(identifier(task.invocationId) && identifier(task.caseId) && task.client === 'opencode' &&
    ['candidate', 'baseline', 'no-skill'].includes(task.arm) && [1, 2, 3].includes(task.repeat) &&
    typeof task.fixtureHash === 'string' && /^[a-f0-9]{64}$/.test(task.fixtureHash),
  'Explicit bounded OpenCode task coordinates and fixture hash are required');
  insist(typeof prompt === 'string' && /\S/.test(prompt) && !prompt.includes('\0') &&
    Buffer.byteLength(prompt) <= TASK_CAPS.promptBytes && Buffer.from(prompt).toString('utf8') === prompt,
  'A bounded nonempty losslessly UTF-8 prompt is required');
  insist(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= TASK_CAPS.timeoutMs, 'Task timeout must be 1000–300000 ms');
  record(skill, ['id', 'files']);
  insist(identifier(skill.id) && skill.id.length <= 64, 'Invalid bounded skill ID');
  relativePath(skill.id);
  insist(Array.isArray(skill.files) && Array.isArray(inputs) &&
    skill.files.length + inputs.length <= TASK_CAPS.files, 'Explicit seed file cap exceeded');
  insist(task.arm === 'no-skill' ? skill.files.length === 0 : skill.files.length > 0,
    'Only no-skill tasks may have empty skill files; no-skill must not seed a skill');
  insist(Array.isArray(targets) && targets.length <= TASK_CAPS.targets, 'Declared artifact target cap exceeded');
  const reserve = pathRegistry();
  let totalBytes = 0;
  const prepareFile = (file, isSkill) => {
    record(file, isSkill ? ['path', 'content', 'executable'] : ['path', 'content', 'executable', 'mountRoot'], ['path', 'content']);
    const filename = readablePath(file.path, { skill: isSkill });
    insist(!Object.hasOwn(file, 'executable') || typeof file.executable === 'boolean', 'executable must be boolean');
    insist(file.executable !== true || !/\.(?:md|jsonc?|ya?ml)$/i.test(filename),
      'Explicit documentation/configuration data fixtures must be non-executable');
    insist(typeof file.content === 'string' || Buffer.isBuffer(file.content), 'Only explicit string/Buffer bytes are accepted, never host imports');
    const root = isSkill ? 'workspace' : file.mountRoot ?? 'workspace';
    insist(['workspace', 'home'].includes(root), 'Only workspace/home agent fixture roots are supported');
    const bytes = Buffer.from(file.content);
    insist(bytes.length <= TASK_CAPS.fileBytes, 'Individual seed file byte cap exceeded');
    totalBytes += bytes.length;
    insist(totalBytes <= TASK_CAPS.seedBytes, 'Aggregate seed byte cap exceeded');
    reserve(root, isSkill ? `.opencode/skills/${skill.id}/${filename}` : filename);
    return { path: filename, base64: bytes.toString('base64'), bytes: bytes.length, sha256: sha256(bytes),
      executable: file.executable === true, ...(isSkill ? {} : { mountRoot: root }) };
  };
  const files = skill.files.map(file => prepareFile(file, true));
  const fixtures = inputs.map(file => prepareFile(file, false));
  const document = files.find(file => file.path === 'SKILL.md');
  insist(task.arm === 'no-skill' || document, 'The skill root requires exactly named SKILL.md');
  const body = document ? skillBody(Buffer.from(document.base64, 'base64'), skill.id) : null;
  const artifactTargets = targets.map(target => {
    const filename = readablePath(target);
    reserve('workspace', filename);
    return filename;
  });
  return freeze({ task: { ...task }, prompt, skill: { id: skill.id, files, body }, inputs: fixtures,
    artifactTargets, timeoutMs });
}

export function seedPaths(spec) {
  return [
    ...spec.skill.files.map(file => ({ ...file, filePath: `${SKILL_ROOT}/${spec.skill.id}/${file.path}`, kind: 'skill' })),
    ...spec.inputs.map(file => ({ ...file, filePath: `${file.mountRoot === 'home' ? FIXTURE_HOME : PROJECT}/${file.path}`, kind: 'fixture' }))
  ];
}

export function decodeCaseFiles(payload) {
  record(payload.skill, ['id', 'files']);
  const decode = (file, isSkill) => {
    record(file, ['path', 'base64', 'bytes', 'sha256', 'executable', ...(isSkill ? [] : ['mountRoot'])]);
    insist(typeof file.base64 === 'string' && Number.isSafeInteger(file.bytes) &&
      file.bytes >= 0 && file.bytes <= TASK_CAPS.fileBytes, 'Invalid serialized seed bytes');
    const content = Buffer.from(file.base64, 'base64');
    insist(content.toString('base64') === file.base64 && content.length === file.bytes &&
      sha256(content) === file.sha256, 'Serialized seed integrity mismatch');
    return { path: file.path, content, executable: file.executable, ...(isSkill ? {} : { mountRoot: file.mountRoot }) };
  };
  insist(Array.isArray(payload.skill.files) && Array.isArray(payload.inputs), 'Invalid serialized file list');
  return { skill: { id: payload.skill.id, files: payload.skill.files.map(file => decode(file, true)) },
    inputs: payload.inputs.map(file => decode(file, false)) };
}
