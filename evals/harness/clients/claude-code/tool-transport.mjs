import { createHash } from 'node:crypto';
import {
  describeToolWorkerTransportBinding, ToolWorkerError
} from '../../tool-worker/index.mjs';
import { MCP_TOOLS } from '../../tool-worker/mcp-shim.mjs';
import { freeze } from './task-policy.mjs';

export const TOOL_WORKER_LIFETIME_MS = 60000;
const hash = value => createHash('sha256').update(value).digest('hex');
const hashJSON = value => hash(JSON.stringify(value));
const coordinates = ['invocationId', 'caseId', 'client', 'arm', 'repeat'];
const workerHash = '119405c7a0960654109e48b0c6f6b40250899e620cd0bde979595fb7dc67acbb';
const shimHash = 'ef3defc38eaf80b12a58de664a43c30cbcf4507ea26d627d66635219d0085198';
const commandPrefix = [
  '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'TMPDIR=/scratch',
  'LANG=C.UTF-8', '/usr/local/bin/node', '--input-type=module', '--eval'
];
const flags = {
  planningOnly: true, verification: 'cached-original-identity-only',
  freshKernelVerification: false, nativeAdmissionSupported: false,
  evidenceScope: 'worker-filesystem-only', authenticationVerified: false,
  nativeDiscoveryVerified: false, liveAccepted: false
};

function insist(condition, code) {
  if (!condition) throw new ToolWorkerError(code);
}

/** Shared client planning only; the broker separately rechecks the original tuple asynchronously. */
export function prepareNativeToolTransport(tuple, { task, publicFiles, artifactTargets }) {
  const description = describeToolWorkerTransportBinding(tuple);
  const expectedTask = Object.fromEntries(coordinates.map(key => [key, task[key]]));
  insist(description.kind === 'tool-worker-transport-description' &&
    description.protocol === 'eval-filesystem-tools@1' &&
    Object.entries(flags).every(([key, value]) => description[key] === value),
  'NATIVE_TOOL_TRANSPORT_DESCRIPTION_INVALID');
  insist(coordinates.every(key => description.task[key] === expectedTask[key]) &&
    Object.keys(description.task).length === coordinates.length &&
    description.taskHash === hashJSON(expectedTask), 'NATIVE_TOOL_TRANSPORT_TASK_MISMATCH');
  insist(JSON.stringify(description.publicFiles) === JSON.stringify(publicFiles) &&
    description.sourceHash === hashJSON(publicFiles), 'NATIVE_TOOL_TRANSPORT_SOURCE_MISMATCH');
  const workerTargets = artifactTargets.map(target => `artifacts/${target}`);
  insist(JSON.stringify(description.artifactTargets) === JSON.stringify(workerTargets),
    'NATIVE_TOOL_TRANSPORT_TARGET_MISMATCH');
  const binding = description.binding;
  const command = binding.stdioCommand;
  insist(binding === tuple.binding && Object.isFrozen(binding) &&
    binding.kind === 'tool-worker-transport-binding' && binding.protocol === description.protocol &&
    description.transportBindingHash === hashJSON(binding) &&
    description.workerProgramHash === workerHash && binding.workerProgramHash === workerHash &&
    description.shimHash === shimHash && binding.shimHash === shimHash &&
    binding.taskHash === description.taskHash && binding.sourceHash === description.sourceHash &&
    Array.isArray(command) && command.length === 13 &&
    commandPrefix.every((value, index) => command[index] === value) &&
    typeof command[8] === 'string' && hash(command[8]) === shimHash &&
    command[9] === '--' && command[10] === '--eval-tool-mcp-shim' &&
    typeof command[11] === 'string' && /^[a-f0-9]{64}$/.test(command[11]) &&
    command[12] === JSON.stringify(binding.transportPolicy) &&
    binding.transportPolicy.deadlineUnixMs === description.deadlineUnixMs &&
    binding.socketPath === '/tool-rpc/worker.sock' && binding.supplementalGid === 21000 &&
    JSON.stringify(binding.supportedIdentityLayouts) ===
      JSON.stringify([{ uid: 1000, gid: 1000 }, { uid: 10001, gid: 10001 }]) &&
    binding.transportMount.type === 'volume' &&
    /^eval-tool-socket-[a-f0-9-]{36}$/.test(binding.transportMount.source) &&
    binding.transportMount.target === '/tool-rpc' && binding.transportMount.readOnly === true &&
    binding.transportMount.noCopy === true, 'NATIVE_TOOL_TRANSPORT_BINDING_INVALID');
  return freeze({
    ...description, serverName: 'eval_tools',
    mcpConfig: { command: command[0], args: command.slice(1), env: {} },
    tools: MCP_TOOLS,
    artifactMap: artifactTargets.map((target, index) => ({ target, workerPath: workerTargets[index] }))
  });
}

/** Settings for the planned native consumer; managed policy sits above these and is not verified absent. */
export function toolTransportSettings({ skillId, hasSkill, serverName }) {
  const mcp = MCP_TOOLS.map(tool => `mcp__${serverName}__${tool.name}`);
  return {
    disableAllHooks: true, autoMemoryEnabled: false,
    permissions: {
      defaultMode: 'dontAsk',
      allow: [...(hasSkill ? [`Skill(${skillId})`] : []), ...mcp],
      deny: ['Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'],
      disableBypassPermissionsMode: 'disable', disableAutoMode: 'disable'
    }
  };
}
