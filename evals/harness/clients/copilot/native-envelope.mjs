import {
  TASK_CAPS, taskKeys, taskPath, taskText, protectedTaskPath, taskContextDocument,
  claimTaskPath, insistTask
} from './task-boundary.mjs';
import { nativeBrokerOptions } from './native-options.mjs';
import { validateTaskSkillDocument } from './task-skill.mjs';
import { validateNativeWorkerRuntimePlan } from './native-tool-transport.mjs';

export function validateNativeTaskEnvelope(envelope) {
  taskKeys(envelope, ['executionId', 'prompt', 'skill', 'inputs', 'artifactTargets', 'model',
    'authRoot', 'proxyURL', 'limits', 'nativeToolTransport'],
  ['executionId', 'prompt', 'skill', 'inputs', 'artifactTargets', 'model', 'authRoot', 'proxyURL', 'limits']);
  insistTask(typeof envelope.executionId === 'string' && /^[a-f0-9-]{36}$/.test(envelope.executionId) &&
    typeof envelope.prompt === 'string', 'NATIVE_ENVELOPE_INVALID');
  taskText(envelope.prompt, TASK_CAPS.promptBytes, { nonempty: true });
  const broker = nativeBrokerOptions({
    model: envelope.model, authRoot: envelope.authRoot, proxyURL: envelope.proxyURL, limits: envelope.limits
  });
  taskKeys(envelope.skill, ['id', 'files']);
  insistTask(typeof envelope.skill.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(envelope.skill.id) &&
    envelope.skill.id.length <= 100 && Array.isArray(envelope.skill.files) && Array.isArray(envelope.inputs) &&
    envelope.skill.files.length + envelope.inputs.length <= TASK_CAPS.files &&
    Array.isArray(envelope.artifactTargets) && envelope.artifactTargets.length <= TASK_CAPS.artifacts,
  'NATIVE_ENVELOPE_INVALID');
  const paths = new Set();
  let total = 0;
  for (const [source, isSkill] of [[envelope.skill.files, true], [envelope.inputs, false]]) {
    for (const file of source) {
      taskKeys(file, ['path', 'content', 'executable', 'mountRoot']);
      const relative = taskPath(file.path);
      insistTask(relative === file.path && typeof file.content === 'string' &&
        typeof file.executable === 'boolean' &&
        (isSkill ? file.mountRoot === 'workspace' : ['workspace', 'home'].includes(file.mountRoot)),
      'NATIVE_ENVELOPE_INVALID');
      insistTask(!protectedTaskPath(relative) &&
        !(file.mountRoot === 'home' && relative.startsWith('AI/') && protectedTaskPath(relative.slice(3))),
      'TASK_PRIVATE_OR_CONFIG_INPUT');
      insistTask(file.mountRoot !== 'home' || relative.startsWith('AI/'), 'TASK_HOME_NATIVE_AUDIT_UNSUPPORTED');
      insistTask(!taskContextDocument(relative) || !file.executable, 'TASK_EXECUTABLE_CONTEXT_DOCUMENT');
      const { bytes } = taskText(file.content, TASK_CAPS.fileBytes);
      total += bytes.length;
      insistTask(total <= TASK_CAPS.inputBytes, 'TASK_LIMIT');
      claimTaskPath(paths, file.mountRoot, isSkill ? `.github/skills/${envelope.skill.id}/${relative}` : relative);
    }
  }
  if (envelope.skill.files.length) {
    const document = envelope.skill.files.find(file => file.path === 'SKILL.md');
    insistTask(document, 'TASK_SKILL_INVALID');
    validateTaskSkillDocument(document, envelope.skill.id);
  }
  for (const target of envelope.artifactTargets) {
    const relative = taskPath(target);
    insistTask(relative === target && !protectedTaskPath(relative, { output: true }), 'TASK_PROTECTED_OUTPUT');
    claimTaskPath(paths, 'workspace', relative);
  }
  if (Object.hasOwn(envelope, 'nativeToolTransport')) {
    validateNativeWorkerRuntimePlan(envelope.nativeToolTransport);
    insistTask(envelope.inputs.length === 0 && envelope.artifactTargets.length === 0,
      'NATIVE_TOOL_TRANSPORT_LOCAL_FILES_UNSUPPORTED');
    insistTask(!envelope.skill.files.some(file => /!\s*`/.test(file.content)),
      'NATIVE_TOOL_TRANSPORT_SKILL_SHELL_UNSUPPORTED');
  }
  return broker;
}
