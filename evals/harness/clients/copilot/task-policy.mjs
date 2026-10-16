import { randomUUID } from 'node:crypto';
import { validateChecks } from '../../checks/index.mjs';
import {
  TASK_CAPS, insistTask, taskKeys, taskPath, protectedTaskPath, taskContextDocument,
  claimTaskPath, taskText, freezeTask
} from './task-boundary.mjs';
import { taskProtocolSteps } from './task-protocol.mjs';
import { validateTaskSkillDocument } from './task-skill.mjs';
export { validateTaskSkillDocument } from './task-skill.mjs';

const payloads = new WeakSet();
const token = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);

/** Validate everything before Docker, materialization, or native client loading. */
export function prepareOfflineTask(options) {
  taskKeys(options, ['task', 'prompt', 'skill', 'inputs', 'checks', 'mock', 'timeoutMs'],
    ['task', 'prompt', 'skill', 'checks', 'mock']);
  const { task, skill, mock } = options;
  const inputs = options.inputs === undefined ? [] : options.inputs;
  const timeoutMs = options.timeoutMs === undefined ? 180000 : options.timeoutMs;
  taskKeys(task, ['invocationId', 'caseId', 'client', 'arm', 'repeat', 'fixtureHash']);
  insistTask(token(task.invocationId) && token(task.caseId) && task.client === 'copilot' &&
    ['candidate', 'baseline', 'no-skill'].includes(task.arm) && [1, 2, 3].includes(task.repeat) &&
    typeof task.fixtureHash === 'string' && /^[a-f0-9]{64}$/i.test(task.fixtureHash), 'TASK_COORDINATES_INVALID');
  insistTask(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= TASK_CAPS.timeoutMs, 'TASK_LIMIT');
  insistTask(typeof options.prompt === 'string', 'TASK_INPUT_INVALID');
  const prompt = taskText(options.prompt, TASK_CAPS.promptBytes, { nonempty: true }).text;
  taskKeys(skill, ['id', 'files']);
  insistTask(typeof skill.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id) &&
    skill.id.length <= 100 && Array.isArray(skill.files) && Array.isArray(inputs) &&
    inputs.length + skill.files.length <= TASK_CAPS.files, 'TASK_INPUT_INVALID');
  insistTask(task.arm === 'no-skill' ? skill.files.length === 0 : skill.files.length > 0,
    'TASK_SKILL_INVALID', 'Only the no-skill arm may omit skill files');
  const paths = new Set();
  let seedBytes = 0;
  const prepareFiles = (files, isSkill) => files.map(file => {
    taskKeys(file, isSkill ? ['path', 'content', 'executable'] : ['path', 'content', 'executable', 'mountRoot'],
      ['path', 'content']);
    insistTask(file.executable === undefined || typeof file.executable === 'boolean', 'TASK_INPUT_INVALID');
    const relative = taskPath(file.path);
    insistTask(!protectedTaskPath(relative), 'TASK_PRIVATE_OR_CONFIG_INPUT',
      'Private grading, auth, instruction and client configuration files are not agent fixtures');
    insistTask(!taskContextDocument(relative) || file.executable !== true, 'TASK_EXECUTABLE_CONTEXT_DOCUMENT',
      'Explicit instruction/layout documents are read-only non-executable fixture data');
    const mountRoot = isSkill || file.mountRoot === undefined ? 'workspace' : file.mountRoot;
    insistTask(['workspace', 'home'].includes(mountRoot), 'TASK_INPUT_INVALID');
    if (mountRoot === 'home' && relative.startsWith('AI/')) {
      insistTask(!protectedTaskPath(relative.slice(3)), 'TASK_PRIVATE_OR_CONFIG_INPUT',
        'Automatic client control-plane files cannot be seeded inside the authorized HOME/AI fixture root');
    }
    const target = isSkill ? `.github/skills/${skill.id}/${relative}` : relative;
    claimTaskPath(paths, mountRoot, target);
    const { text, bytes } = taskText(file.content, TASK_CAPS.fileBytes);
    seedBytes += bytes.length;
    insistTask(seedBytes <= TASK_CAPS.inputBytes, 'TASK_LIMIT');
    return { path: relative, content: text, executable: file.executable === true, mountRoot };
  });
  const skillFiles = prepareFiles(skill.files, true);
  const agentInputs = prepareFiles(inputs, false);
  if (skillFiles.length) {
    const document = skillFiles.find(file => file.path === 'SKILL.md');
    insistTask(document, 'TASK_SKILL_INVALID', 'The root file must be named exactly SKILL.md');
    validateTaskSkillDocument(document, skill.id);
  }
  insistTask(Array.isArray(options.checks) &&
    options.checks.length <= TASK_CAPS.checks &&
    Buffer.byteLength(JSON.stringify(options.checks)) <= TASK_CAPS.declarationBytes, 'TASK_LIMIT');
  const checks = validateChecks(options.checks);
  const aliases = new Map();
  const artifactTargets = [];
  for (const check of checks) {
    if (!check.type.startsWith('artifact-')) continue;
    const target = taskPath(check.target);
    insistTask(!protectedTaskPath(target, { output: true }), 'TASK_PROTECTED_OUTPUT');
    const alias = target.toLowerCase();
    insistTask(!aliases.has(alias) || aliases.get(alias) === check.target, 'TASK_PATH_COLLISION');
    if (!aliases.has(alias)) {
      claimTaskPath(paths, 'workspace', target);
      aliases.set(alias, check.target);
      artifactTargets.push(target);
    }
  }
  insistTask(artifactTargets.length <= TASK_CAPS.artifacts, 'TASK_LIMIT');
  taskKeys(mock, ['loadSkill', 'artifacts']);
  insistTask(typeof mock.loadSkill === 'boolean' && Array.isArray(mock.artifacts) &&
    mock.artifacts.length <= TASK_CAPS.artifacts &&
    (!mock.loadSkill || skillFiles.length > 0), 'TASK_MOCK_INVALID',
  'An explicit scripted local inference fixture is required; no-skill cannot request a skill load');
  const selected = new Set();
  let outputBytes = 0;
  const artifacts = mock.artifacts.map(artifact => {
    taskKeys(artifact, ['path', 'content']);
    insistTask(typeof artifact.content === 'string', 'TASK_MOCK_INVALID');
    const target = taskPath(artifact.path);
    insistTask(artifactTargets.includes(target) && !selected.has(target.toLowerCase()), 'TASK_MOCK_INVALID',
      'Scripted writes must select distinct declared artifact targets');
    selected.add(target.toLowerCase());
    const { text, bytes } = taskText(artifact.content, TASK_CAPS.artifactBytes);
    outputBytes += bytes.length;
    insistTask(outputBytes <= TASK_CAPS.outputBytes, 'TASK_LIMIT');
    return { path: target, content: text };
  });
  const payload = freezeTask({
    executionId: randomUUID(), prompt, skill: { id: skill.id, files: skillFiles },
    inputs: agentInputs, artifactTargets, mock: { loadSkill: mock.loadSkill, artifacts }
  });
  insistTask(Buffer.byteLength(JSON.stringify(payload)) <= TASK_CAPS.payloadBytes, 'TASK_LIMIT');
  insistTask(taskProtocolSteps(payload).length + 1 <= TASK_CAPS.requests, 'TASK_LIMIT');
  payloads.add(payload);
  return Object.freeze({ task: freezeTask({ ...task }), checks, timeoutMs, payload });
}

export function assertTaskPayload(payload) {
  insistTask(payloads.has(payload), 'TASK_PAYLOAD_UNTRUSTED');
  insistTask(payload.inputs.filter(file => file.mountRoot === 'home').every(file =>
    file.path.startsWith('AI/') && file.path.split('/').length >= 2),
    'TASK_HOME_NATIVE_AUDIT_UNSUPPORTED',
    'Only nested HOME/AI fixture files can be considered; root-level or other HOME roots are unsupported');
}
