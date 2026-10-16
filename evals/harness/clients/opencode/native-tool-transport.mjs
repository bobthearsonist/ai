import { prepareNativeToolTransport } from '../claude-code/tool-transport.mjs';
import { freeze } from './case-spec.mjs';

const SERVER = 'eval_tools';
// OpenCode 1.14.28 registers MCP tools as sanitize(server) + '_' + sanitize(tool).
export const NATIVE_TOOL_IDS = Object.freeze(
  ['eval_read_public', 'eval_write_artifact', 'eval_read_artifact'].map(name => `${SERVER}_${name}`));

export const NATIVE_TOOL_OBSERVATIONS = Object.freeze([
  'effective-config-mcp-keys-equal-eval_tools-only',
  'no-wellknown-auth-entry-and-no-active-account-organization-or-managed-config-source',
  'no-agent-level-permission-or-tool-override-from-any-late-source',
  'native-tool-catalog-equals-skill-plus-three-eval_tools-ids',
  'actual-skill-tool-result-and-eval_tools-calls-observed'
]);

/** Validates the original tuple and derives the only native config that can carry it. */
export function planOpenCodeToolTransport(tuple, common) {
  const transport = prepareNativeToolTransport(tuple, {
    task: common.task,
    publicFiles: [
      ...common.skill.files.map(file => ({ path: `skills/${common.skill.id}/${file.path}`,
        bytes: file.bytes, sha256: file.sha256 })),
      ...common.inputs.map(file => ({ path: `inputs/${file.path}`, bytes: file.bytes, sha256: file.sha256 }))
    ],
    artifactTargets: common.artifactTargets
  });
  const permission = {
    '*': 'deny',
    ...(common.skill.files.length ? { skill: { '*': 'deny', [common.skill.id]: 'allow' } } : {}),
    ...Object.fromEntries(NATIVE_TOOL_IDS.map(id => [id, 'allow']))
  };
  const mcp = {
    [SERVER]: { type: 'local', command: [transport.mcpConfig.command, ...transport.mcpConfig.args],
      environment: {}, enabled: true }
  };
  // OPENCODE_PERMISSION is merged by the pinned loader after account/organization/managed sources, but
  // agent-level overrides from those sources are not suppressed; hence the required observations.
  return freeze({
    protocol: transport.protocol, serverName: SERVER, planningOnly: true,
    task: transport.task, taskHash: transport.taskHash, sourceHash: transport.sourceHash,
    transportBindingHash: transport.transportBindingHash, workerProgramHash: transport.workerProgramHash,
    shimHash: transport.shimHash, deadlineUnixMs: transport.deadlineUnixMs, limits: transport.limits,
    publicFiles: transport.publicFiles, artifactMap: transport.artifactMap,
    nativeToolIds: [...NATIVE_TOOL_IDS], skillTool: common.skill.files.length ? common.skill.id : null,
    mcp, permission, env: { OPENCODE_PERMISSION: JSON.stringify(permission), OPENCODE_DISABLE_PROJECT_CONFIG: '1' },
    requiredObservations: [...NATIVE_TOOL_OBSERVATIONS],
    evidenceScope: transport.evidenceScope, verification: transport.verification,
    nativeAdmissionSupported: false, nativeDiscoveryVerified: false, authenticationVerified: false,
    freshKernelVerification: false, liveAccepted: false
  });
}