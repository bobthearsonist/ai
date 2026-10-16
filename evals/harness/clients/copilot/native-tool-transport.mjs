import { createHash } from 'node:crypto';
import { TASK_CAPS, taskKeys, taskText, insistTask, freezeTask } from './task-boundary.mjs';

const shimHash = 'ef3defc38eaf80b12a58de664a43c30cbcf4507ea26d627d66635219d0085198';
const argumentsPrefix = [
  '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'TMPDIR=/scratch', 'LANG=C.UTF-8',
  '/usr/local/bin/node', '--input-type=module', '--eval'
];
export const NATIVE_TOOL_TRANSPORT_SETTINGS = freezeTask({
  disableAllHooks: true, ide: { autoConnect: false }
});
export const NATIVE_WORKER_TOOL_NAMES = Object.freeze([
  'eval_read_public', 'eval_write_artifact', 'eval_read_artifact'
]);

export function nativeWorkerAvailableTools(hasSkill) {
  return [...(hasSkill ? ['builtin:skill'] : []),
    ...NATIVE_WORKER_TOOL_NAMES.map(name => `mcp:eval_tools-${name}`)];
}

export function nativeWorkerPrompt(prompt, transport, skill) {
  const guidance = [
    'The task uses the isolated eval_tools MCP server for all model file operations.',
    ...(skill.files.length ? [
      `Load ${skill.id} with the genuine native skill tool. Its local selected Skill files are readonly discovery seeds only.`
    ] : []),
    'Read public files only with eval_read_public({path}), using these exact declared worker paths:',
    ...transport.publicFiles.map(file => `- ${file.path}`),
    'Write outputs only with eval_write_artifact({path,contentBase64}); read outputs only with eval_read_artifact({path}).',
    'Original requested target -> exact worker artifact path:',
    ...transport.artifactMap.map(file => `- ${file.target} -> ${file.workerPath}`),
    'Do not write local workspace artifacts or use shell, view, create, edit, search, delegation, or other MCP tools.',
    'Undeclared paths, path aliases, and absolute paths are not permitted.'
  ].join('\n');
  return taskText(`${prompt}\n\n${guidance}`, TASK_CAPS.promptBytes, { nonempty: true }).text;
}

/** The serialized runtime plan is not a task/worker/lease/binding identity. */
export function nativeWorkerRuntimePlan(transport) {
  return freezeTask({
    protocol: transport.protocol, serverName: transport.serverName,
    deadlineUnixMs: transport.deadlineUnixMs, mcpConfig: transport.mcpConfig
  });
}

export function validateNativeWorkerRuntimePlan(plan) {
  taskKeys(plan, ['protocol', 'serverName', 'deadlineUnixMs', 'mcpConfig']);
  insistTask(plan.protocol === 'eval-filesystem-tools@1' && plan.serverName === 'eval_tools' &&
    Number.isSafeInteger(plan.deadlineUnixMs) && plan.deadlineUnixMs > 0,
  'NATIVE_TOOL_TRANSPORT_CONFIG_INVALID');
  const config = plan.mcpConfig;
  taskKeys(config, ['command', 'args', 'env']);
  taskKeys(config.env, [], []);
  const args = config.args;
  insistTask(config.command === '/usr/bin/env' && Array.isArray(args) && args.length === 12 &&
    args.every(value => typeof value === 'string') &&
    argumentsPrefix.every((value, index) => args[index] === value) &&
    createHash('sha256').update(args[7]).digest('hex') === shimHash &&
    args[8] === '--' && args[9] === '--eval-tool-mcp-shim' &&
    /^[a-f0-9]{64}$/.test(args[10]), 'NATIVE_TOOL_TRANSPORT_CONFIG_INVALID');
  let policy;
  try { policy = JSON.parse(args[11]); } catch { insistTask(false, 'NATIVE_TOOL_TRANSPORT_CONFIG_INVALID'); }
  insistTask(policy && !Array.isArray(policy) && policy.deadlineUnixMs === plan.deadlineUnixMs &&
    JSON.stringify(policy) === args[11], 'NATIVE_TOOL_TRANSPORT_CONFIG_INVALID');
  return plan;
}
