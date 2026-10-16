import { createHash, randomUUID } from 'node:crypto';
import { CLI, buildCopilotNativeArguments } from './config.mjs';
import { BASE_IMAGE, VERSION } from './index.mjs';
import { validateTaskSkillDocument } from './task-skill.mjs';
import { nativeBrokerOptions, nativeEnvironment } from './native-options.mjs';
import { prepareNativeToolTransport } from '../claude-code/tool-transport.mjs';
import {
  NATIVE_TOOL_TRANSPORT_SETTINGS, nativeWorkerAvailableTools, nativeWorkerPrompt, nativeWorkerRuntimePlan
} from './native-tool-transport.mjs';
import {
  TASK_CAPS, taskKeys, taskPath, taskText, taskContextDocument, protectedTaskPath,
  claimTaskPath, insistTask, freezeTask
} from './task-boundary.mjs';

const specifications = new WeakSet();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const coordinate = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);

/** Pure planning only: no image build, credentials, account admission or execution. */
export function prepareNativeTaskSpecification(payload, options) {
  taskKeys(payload, ['task', 'prompt', 'skill', 'inputs', 'artifactTargets'],
    ['task', 'prompt', 'skill']);
  const broker = nativeBrokerOptions(options);
  const { task, skill } = payload;
  taskKeys(task, ['invocationId', 'caseId', 'client', 'arm', 'repeat', 'fixtureHash']);
  insistTask(coordinate(task.invocationId) && coordinate(task.caseId) && task.client === 'copilot' &&
    ['candidate', 'baseline', 'no-skill'].includes(task.arm) && [1, 2, 3].includes(task.repeat) &&
    typeof task.fixtureHash === 'string' && /^[a-f0-9]{64}$/i.test(task.fixtureHash), 'TASK_COORDINATES_INVALID');
  insistTask(typeof payload.prompt === 'string', 'TASK_INPUT_INVALID');
  const prompt = taskText(payload.prompt, TASK_CAPS.promptBytes, { nonempty: true }).text;
  const inputs = payload.inputs === undefined ? [] : payload.inputs;
  const targets = payload.artifactTargets === undefined ? [] : payload.artifactTargets;
  taskKeys(skill, ['id', 'files']);
  insistTask(typeof skill.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id) &&
    skill.id.length <= 100 && Array.isArray(skill.files) && Array.isArray(inputs) &&
    skill.files.length + inputs.length <= TASK_CAPS.files &&
    Array.isArray(targets) && targets.length <= TASK_CAPS.artifacts, 'TASK_INPUT_INVALID');
  insistTask(task.arm === 'no-skill' ? skill.files.length === 0 : skill.files.length > 0, 'TASK_SKILL_INVALID');
  let total = 0;
  const paths = new Set();
  const files = (source, isSkill) => source.map(file => {
    taskKeys(file, isSkill ? ['path', 'content', 'executable'] : ['path', 'content', 'executable', 'mountRoot'],
      ['path', 'content']);
    const relative = taskPath(file.path);
    const mountRoot = isSkill || file.mountRoot === undefined ? 'workspace' : file.mountRoot;
    insistTask(['workspace', 'home'].includes(mountRoot), 'TASK_INPUT_INVALID');
    insistTask(!protectedTaskPath(relative) &&
      !(mountRoot === 'home' && relative.startsWith('AI/') && protectedTaskPath(relative.slice(3))),
    'TASK_PRIVATE_OR_CONFIG_INPUT');
    insistTask(mountRoot !== 'home' || relative.startsWith('AI/'), 'TASK_HOME_NATIVE_AUDIT_UNSUPPORTED');
    insistTask(file.executable === undefined || typeof file.executable === 'boolean', 'TASK_INPUT_INVALID');
    insistTask(!taskContextDocument(relative) || file.executable !== true, 'TASK_EXECUTABLE_CONTEXT_DOCUMENT');
    claimTaskPath(paths, mountRoot, isSkill ? `.github/skills/${skill.id}/${relative}` : relative);
    const { text, bytes } = taskText(file.content, TASK_CAPS.fileBytes);
    total += bytes.length;
    insistTask(total <= TASK_CAPS.inputBytes, 'TASK_LIMIT');
    return { path: relative, content: text, executable: file.executable === true, mountRoot };
  });
  const skillFiles = files(skill.files, true);
  const agentInputs = files(inputs, false);
  if (skillFiles.length) {
    const document = skillFiles.find(file => file.path === 'SKILL.md');
    insistTask(document, 'TASK_SKILL_INVALID');
    validateTaskSkillDocument(document, skill.id);
  }
  const artifactTargets = targets.map(target => {
    const relative = taskPath(target);
    insistTask(!protectedTaskPath(relative, { output: true }), 'TASK_PROTECTED_OUTPUT');
    claimTaskPath(paths, 'workspace', relative);
    return relative;
  });
  let transport = null;
  if (Object.hasOwn(options, 'toolTransport')) {
    transport = prepareNativeToolTransport(options.toolTransport, {
      task,
      publicFiles: [
        ...skillFiles.map(file => ({ path: `skills/${skill.id}/${file.path}`,
          bytes: Buffer.byteLength(file.content), sha256: hash(file.content) })),
        ...agentInputs.map(file => ({ path: `inputs/${file.path}`,
          bytes: Buffer.byteLength(file.content), sha256: hash(file.content) }))
      ],
      artifactTargets
    });
    insistTask(!skillFiles.some(file => /!\s*`/.test(file.content)),
      'NATIVE_TOOL_TRANSPORT_SKILL_SHELL_UNSUPPORTED',
      'Inline Skill shell expansion is not part of the isolated worker file-tool route');
  }
  const { model, authRoot, proxyURL } = broker;
  const nativePrompt = transport ? nativeWorkerPrompt(prompt, transport, { id: skill.id, files: skillFiles }) : prompt;
  const envelope = freezeTask({
    executionId: randomUUID(), prompt: nativePrompt, skill: { id: skill.id, files: skillFiles },
    inputs: transport ? [] : agentInputs, artifactTargets: transport ? [] : artifactTargets,
    model, authRoot, proxyURL, limits: broker.limits,
    ...(transport ? { nativeToolTransport: nativeWorkerRuntimePlan(transport) } : {})
  });
  const stdin = JSON.stringify(envelope);
  insistTask(Buffer.byteLength(stdin) <= TASK_CAPS.payloadBytes, 'TASK_LIMIT');
  const env = nativeEnvironment(broker);
  if (transport) env.COPILOT_PLUGIN_DIR_ONLY = 'true';
  const specification = freezeTask({
    kind: 'copilot-native-task-specification', planningOnly: true,
    client: 'copilot', clientVersion: VERSION, baseImage: BASE_IMAGE,
    executionId: envelope.executionId, task: { ...task }, model,
    executable: CLI, entrypoint: ['node', '/opt/fixture/native-runtime.mjs'], cwd: '/workspace',
    argv: buildCopilotNativeArguments(envelope, { model, artifactTargets: envelope.artifactTargets }), env,
    stdin, stdinHash: hash(stdin), stdinBytes: Buffer.byteLength(stdin),
    stdinProvenance: 'submitted-bootstrap-stdin/not-provider-wire',
    submittedPrompt: { sha256: hash(prompt), bytes: Buffer.byteLength(prompt),
      provenance: 'specification-prompt/not-native-observation' },
    ...(transport ? {
      nativePrompt: { sha256: hash(nativePrompt), bytes: Buffer.byteLength(nativePrompt),
        provenance: 'generated-worker-path-guidance/not-native-observation' },
      toolTransport: {
        ...transport,
        nativeConfig: {
          settings: NATIVE_TOOL_TRANSPORT_SETTINGS,
          availableTools: nativeWorkerAvailableTools(skillFiles.length > 0),
          localInputsStaged: false, localArtifactsCaptured: false,
          readOnlySkillRoot: skillFiles.length ? `/workspace/.github/skills/${skill.id}` : null,
          managedPolicyCompatibilityVerified: false
        }
      },
      nativeAdmissionSupported: false
    } : {}),
    envelope, limits: envelope.limits,
    nativeHardLimits: { turns: null, totalTokens: null, accountSpend: null, provenance: 'unsupported-not-applied' },
    requirements: {
      brokerAuthenticatedCustody: true, brokerControlledCandidateAttachment: true,
      isolatedNativeOAuthStore: true, sanitizedControlPlane: true,
      nativeProxyCompatibilityVerified: false, linuxOAuthStoreVerified: false,
      completeNativeDiscoveryRequired: true,
      homeDiscoveryWithoutProviderWireVerified: false,
      ...(transport ? {
        sterileNativeConfigRequired: true, nativeManagedPolicyCompatibilityVerified: false,
        nativeToolTransportDiscoveryVerified: false, nativeToolTransportObserverSupported: false,
        toolWorkerHostCaptureRequired: true
      } : {})
    },
    authenticationVerified: false, liveAccepted: false, qualityEvaluated: false
  });
  specifications.add(specification);
  return specification;
}

export function assertNativeTaskSpecification(specification) {
  insistTask(specifications.has(specification), 'NATIVE_SPECIFICATION_UNTRUSTED');
}
