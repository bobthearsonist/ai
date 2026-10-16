import { TASK_CAPS, insistTask, taskPath } from './task-boundary.mjs';
import { nativeWorkerAvailableTools, NATIVE_WORKER_TOOL_NAMES } from './native-tool-transport.mjs';

export const CLI = '/opt/fixture/node_modules/.bin/copilot';
export const SYNTHETIC_MODEL = 'offline-fixture-model';
export const SKILL_ID = 'offline-fixture-skill';
export function buildCopilotArguments({ prompt = 'Use offline-fixture-skill and read fixture.txt. Return OFFLINE_FIXTURE_COMPLETE.', artifactTargets = [] } = {}) {
  if (typeof prompt !== 'string' || prompt.length > 4096) throw new Error('Bounded fixture prompt required');
  if (!Array.isArray(artifactTargets) || artifactTargets.length > 2 || new Set(artifactTargets).size !== artifactTargets.length ||
      artifactTargets.some(p => !['answer.md', 'message.txt'].includes(p))) throw new Error('Only explicit pilot artifact filenames are supported');
  const nativeWrites = artifactTargets.length ? ['create', 'edit'] : [];
  return ['-p', prompt, '--output-format', 'json', '--model', SYNTHETIC_MODEL,
    '--usage-output-file', '/client-config/usage.json', '--no-custom-instructions',
    '--no-auto-update', '--no-ask-user', '--disable-builtin-mcps', '--disallow-temp-dir',
    '--available-tools', 'skill', 'view', ...nativeWrites, '--allow-tool', 'skill', 'view',
    ...artifactTargets.map(p => `write(/workspace/${p})`),
    '--deny-tool', 'shell', 'url', ...(artifactTargets.length ? [] : ['write']),
    '--secret-env-vars', 'COPILOT_PROVIDER_API_KEY'];
}

export function buildCopilotTaskArguments(payload) {
  return [...buildCopilotNativeArguments(payload, {
    model: SYNTHETIC_MODEL, artifactTargets: payload.mock.artifacts.map(file => file.path)
  }), '--secret-env-vars', 'COPILOT_PROVIDER_API_KEY'];
}

export function buildCopilotNativeArguments(payload, { model, artifactTargets }) {
  insistTask(typeof payload.prompt === 'string' && payload.prompt.trim() &&
    Buffer.byteLength(payload.prompt) <= TASK_CAPS.promptBytes, 'TASK_INPUT_INVALID');
  if (payload.nativeToolTransport) {
    return ['-p', payload.prompt, '--output-format', 'json', '--model', model,
      '--usage-output-file', '/client-config/usage.json', '--no-custom-instructions',
      '--no-auto-update', '--no-ask-user', '--disable-builtin-mcps', '--disallow-temp-dir',
      '--additional-mcp-config', JSON.stringify({
        mcpServers: { eval_tools: payload.nativeToolTransport.mcpConfig }
      }),
      '--available-tools', ...nativeWorkerAvailableTools(payload.skill.files.length > 0),
      '--allow-tool', ...(payload.skill.files.length ? ['skill'] : []),
      ...NATIVE_WORKER_TOOL_NAMES.map(name => `eval_tools(${name})`),
      '--deny-tool', 'shell', 'url', 'read', 'write'];
  }
  const targets = artifactTargets.map(target => taskPath(target));
  const reads = [
    ...payload.inputs.map(file => `${file.mountRoot === 'home' ? '/home/eval' : '/workspace'}/${taskPath(file.path)}`),
    ...payload.skill.files.map(file => `/workspace/.github/skills/${payload.skill.id}/${taskPath(file.path)}`)
  ];
  return ['-p', payload.prompt, '--output-format', 'json', '--model', model,
    '--usage-output-file', '/client-config/usage.json', '--no-custom-instructions',
    '--no-auto-update', '--no-ask-user', '--disable-builtin-mcps', '--disallow-temp-dir',
    ...(payload.inputs.some(file => file.mountRoot === 'home') ? ['--add-dir', '/home/eval/AI'] : []),
    '--available-tools', 'skill', 'view', ...(targets.length ? ['create', 'edit'] : []),
    '--allow-tool', 'skill', ...reads.map(filename => `read(${filename})`),
    ...targets.map(target => `write(/workspace/${target})`),
    '--deny-tool', 'shell', 'url', ...(targets.length ? [] : ['write']),
    'read(/proc/**)', 'read(/client-config/**)', 'read(/scratch/**)',
    'read(/home/eval/.boundary/**)', 'read(/workspace/.boundary/**)',
    'write(/home/eval/**)', 'write(/client-config/**)', 'write(/scratch/**)',
    'write(/workspace/.github/**)', 'write(/workspace/.boundary/**)',
    ...reads.map(filename => `write(${filename})`)];
}
