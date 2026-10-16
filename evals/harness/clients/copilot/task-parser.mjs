import { hashContent, hashObject } from '../../index.mjs';
import { parseCopilotEvents } from './parser.mjs';
import { TASK_CAPS, CopilotTaskError, insistTask, freezeTask } from './task-boundary.mjs';
import { taskSeedFiles, taskProtocolSteps } from './task-protocol.mjs';
import { nativeWireDiscovery } from './task-discovery.mjs';

/** Host-only verification of native trace, wire observations and filesystem readback. */
export function verifyOfflineTaskRecord(record, prepared) {
  const payload = prepared.payload;
  insistTask(record?.transport === 'offline-mock' && record.client === 'copilot' &&
    record.clientVersion === '1.0.92' && record.nodeVersion === '22.22.1' &&
    record.executionId === payload.executionId && record.payloadHash === hashContent(JSON.stringify(payload)) &&
    record.freshWorkspace === true && record.nativeSessionFresh === true && record.outputLimited === false,
  'TASK_NATIVE_RECORD_INVALID');
  const events = parseCopilotEvents(record.stdout);
  insistTask(record.exitCode === 0 && events.at(-1).exitCode === 0 &&
    !events.some(event => ['session.error', 'model.call_failure'].includes(event.type)) &&
    events.some(event => event.type === 'assistant.message' && event.data.content === 'OFFLINE_TASK_COMPLETE' &&
      Array.isArray(event.data.toolRequests) && event.data.toolRequests.length === 0),
  'TASK_NATIVE_INCOMPLETE', 'The actual native session must complete without infrastructure/model errors');
  const requests = record.provider?.requests;
  const steps = taskProtocolSteps(payload);
  const allowedTools = ['skill', 'view', ...(payload.mock.artifacts.length ? ['create', 'edit'] : [])].sort();
  insistTask(Array.isArray(requests) && requests.length === steps.length + 1 &&
    requests.every((request, index) => request.index === index && request.path === '/v1/chat/completions' &&
      request.model === 'offline-fixture-model' && request.stream === true &&
      /^[a-f0-9]{64}$/.test(request.sha256) && request.bytes > 0 && request.bytes <= TASK_CAPS.requestBytes &&
      Array.isArray(request.tools) && request.tools.slice().sort().join(',') === allowedTools.join(',')) &&
    Array.isArray(record.provider.errors) && record.provider.errors.length === 0, 'TASK_PROTOCOL_INCOMPLETE');
  const userMessages = events.filter(event => event.type === 'user.message');
  const promptHash = requests[0].prompt?.sha256;
  insistTask(userMessages.length === 1 && userMessages[0].data.content === payload.prompt &&
    promptHash === hashContent(payload.prompt) && requests[0].prompt.bytes === Buffer.byteLength(payload.prompt) &&
    requests[0].prompt.userMessageHash === hashContent(userMessages[0].data.transformedContent ?? payload.prompt),
  'TASK_PROMPT_NOT_OBSERVED', 'The prompt must match actual native user and provider-request captures');
  const audits = events.filter(event => event.type === 'session.skills_loaded');
  const eventAuditComplete = audits.length > 0 && audits.every(event => Array.isArray(event.data.skills) &&
    event.data.skills.every(skill => typeof skill.name === 'string' && typeof skill.path === 'string' &&
      typeof skill.enabled === 'boolean' &&
      (skill.source === 'project' || skill.source === 'builtin' &&
        skill.path.startsWith('/opt/copilot-cache/.cache/copilot/pkg/linux-x64/1.0.92/builtin/'))));
  const wireDiscovery = nativeWireDiscovery(record.provider.discoveryWire, requests[0]);
  const auditComplete = eventAuditComplete || audits.length === 0 && wireDiscovery !== null;
  const starts = events.filter(event => event.type === 'tool.execution_start');
  const completes = events.filter(event => event.type === 'tool.execution_complete');
  const calls = record.provider.calls;
  insistTask(Array.isArray(calls) && starts.length === steps.length && completes.length === steps.length &&
    calls.length === steps.length, 'TASK_PROTOCOL_INCOMPLETE');
  const nativeEvidence = [], denials = [], reads = [], creations = [];
  for (const [index, step] of steps.entries()) {
    const id = `task_call_${index}`;
    const start = starts.find(event => event.data.toolCallId === id);
    const complete = completes.find(event => event.data.toolCallId === id);
    const call = calls[index];
    insistTask(start && complete && call?.id === id && call.name === step.tool &&
      start.data.toolName === step.tool && hashObject(call.arguments) === hashObject(step.args) &&
      hashObject(start.data.arguments) === hashObject(step.args), 'TASK_NATIVE_TOOL_MISMATCH');
    const result = complete.data;
    const response = record.provider.toolResponses?.find(item => item.toolCallId === id);
    insistTask(response && response.requestIndex === index + 1 &&
      requests[index + 1].toolResults.some(item => item.toolCallId === id && item.sha256 === response.sha256),
    'TASK_TOOL_RESULT_NOT_OBSERVED');
    const evidence = {
      toolCallId: id, tool: step.tool, kind: step.kind, path: step.args.path ?? null,
      success: result.success, startHash: hashObject(start), completionHash: hashObject(complete),
      providerRequestHash: requests[index + 1].sha256, wireResultHash: response.sha256
    };
    if (step.kind === 'boundary-denial') {
      const unavailable = ['bash', 'web_fetch'].includes(step.tool) ||
        ['create', 'edit'].includes(step.tool) && !payload.mock.artifacts.length;
      insistTask(result.success === false && (unavailable
        ? result.error?.code === 'failure' && result.error.message === `Tool '${step.tool}' does not exist.`
        : result.error?.code === 'denied'), 'TASK_BOUNDARY_FAILED');
      denials.push({ ...evidence, denied: true, errorCode: result.error.code });
    } else {
      if (result.success !== true) {
        const error = new CopilotTaskError('TASK_NATIVE_TOOL_FAILED', 'A requested native Skill/Read/create failed');
        error.evidence = freezeTask({ toolCallId: id, tool: step.tool, path: step.args.path ?? null,
          errorCode: result.error?.code ?? null, completionHash: hashObject(complete) });
        throw error;
      }
      if (step.kind === 'file-read') {
        const seed = taskSeedFiles(payload).find(file => file.target === step.args.path);
        insistTask(response.fullContentSeen === true && result.result.content.includes(seed.content),
          'TASK_INPUT_NOT_OBSERVED', 'Full supplied text bytes must reach the native tool and actual provider request');
        reads.push({ ...evidence, bytes: Buffer.byteLength(seed.content),
          sha256: hashContent(seed.content), fullContentSeen: true });
      }
      if (step.kind === 'artifact-create') creations.push(evidence);
    }
    nativeEvidence.push(evidence);
  }
  const integrity = record.seedIntegrity;
  const seeds = taskSeedFiles(payload);
  insistTask(integrity?.guardUnchanged === true && integrity.leakDetected === false &&
    Array.isArray(integrity.unauthorizedFiles) && integrity.unauthorizedFiles.length === 0 &&
    integrity.before?.length === seeds.length && integrity.after?.length === seeds.length &&
    seeds.every(seed => [integrity.before, integrity.after].every(manifest => manifest.some(file =>
      file.path === seed.target && file.bytes === Buffer.byteLength(seed.content) &&
      file.sha256 === hashContent(seed.content) && file.readonly === true))), 'TASK_SEED_OR_BOUNDARY_CHANGED');
  insistTask(Array.isArray(record.artifacts) && record.artifacts.length === payload.artifactTargets.length &&
    new Set(record.artifacts.map(file => file.path)).size === record.artifacts.length &&
    record.artifacts.every(file => payload.artifactTargets.includes(file.path) &&
      ['present', 'missing'].includes(file.state)), 'TASK_ARTIFACT_READBACK_INVALID');
  const bytes = new Map();
  for (const artifact of record.artifacts.filter(file => file.state === 'present')) {
    insistTask(typeof artifact.base64 === 'string' && Number.isSafeInteger(artifact.bytes) &&
      artifact.bytes >= 0 && artifact.bytes <= TASK_CAPS.artifactBytes, 'TASK_ARTIFACT_READBACK_INVALID');
    const content = Buffer.from(artifact.base64, 'base64');
    const mock = payload.mock.artifacts.find(file => file.path === artifact.path);
    const creation = creations.find(event => event.path === `/workspace/${artifact.path}`);
    insistTask(mock && creation && content.toString('base64') === artifact.base64 &&
      content.length === artifact.bytes && hashContent(content) === artifact.sha256 &&
      content.equals(Buffer.from(mock.content)), 'TASK_NATIVE_ARTIFACT_UNVERIFIED',
    'Both successful native creation and exact filesystem bytes are required');
    bytes.set(artifact.path, content);
  }
  insistTask(payload.mock.artifacts.every(artifact => bytes.has(artifact.path)), 'TASK_NATIVE_ARTIFACT_UNVERIFIED');
  if (!auditComplete) {
    const error = new CopilotTaskError('TASK_AUDIT_INCOMPLETE', 'A complete actual native skill discovery audit is required');
    error.evidence = freezeTask({
      traceHash: hashContent(record.stdout), auditEvents: audits.length,
      skills: audits.flatMap(event => Array.isArray(event.data.skills) ? event.data.skills.map(skill => ({
        name: skill.name ?? null, source: skill.source ?? null, path: skill.path ?? null, enabled: skill.enabled ?? null
      })) : []),
      nativeDiscoveryWire: record.provider.discoveryWire ?? null,
      nativeToolAudit: { tools: nativeEvidence, reads, creations, denials,
        readonlySeedsUnchanged: true, guardUnchanged: true, unauthorizedFiles: [], leakDetected: false }
    });
    throw error;
  }
  const project = eventAuditComplete
    ? audits.flatMap(event => event.data.skills.filter(skill => skill.source === 'project'))
    : wireDiscovery.skills.filter(skill => skill.source === 'project');
  const skillPath = `/workspace/.github/skills/${payload.skill.id}/SKILL.md`;
  insistTask(payload.skill.files.length
    ? project.length === (eventAuditComplete ? audits.length : 1) && project.every(skill => skill.name === payload.skill.id &&
      (!eventAuditComplete || skill.enabled === true && skill.path === skillPath))
    : project.length === 0, 'TASK_DISCOVERY_MISMATCH');
  const loads = starts.filter(event => event.data.toolName === 'skill' && event.data.arguments.skill === payload.skill.id)
    .map(start => ({ start, complete: completes.find(event => event.data.toolCallId === start.data.toolCallId) }));
  const loaded = project.length > 0 && loads.some(({ start, complete }) =>
    complete.data.success === true &&
    complete.data.toolTelemetry?.properties?.skillSource === 'project' &&
    complete.data.toolTelemetry?.properties?.found === 'true' &&
    complete.data.result.content === `Skill "${payload.skill.id}" loaded successfully. Follow the instructions in the skill context.` &&
    requests[Number(start.data.toolCallId.split('_').at(-1)) + 1].skillBodySeen === true);
  insistTask(!loads.length || loaded, 'TASK_SKILL_CONTEXT_NOT_OBSERVED');
  const evidence = audits.map(event => ({
    kind: 'discovery-audit', skill: payload.skill.id, ref: `copilot-discovery:sha256:${hashObject(event)}`
  }));
  if (!eventAuditComplete) evidence.push({
    kind: 'discovery-audit', skill: payload.skill.id,
    ref: `copilot-native-system-catalog:sha256:${hashObject(wireDiscovery)}`
  });
  if (loaded) for (const { start, complete } of loads) evidence.push({
    kind: 'skill-load', skill: payload.skill.id,
    ref: `copilot-skill-load:sha256:${hashObject({ start, complete,
      request: requests[Number(start.data.toolCallId.split('_').at(-1)) + 1].sha256 })}`
  });
  return {
    promptHash, bytes,
    trigger: freezeTask({ loaded, evidence, auditComplete: true, discovered: project.length > 0,
      auditSource: eventAuditComplete ? 'native-session.skills_loaded' : wireDiscovery.source,
      discoveryAudit: structuredClone(audits), wireDiscoveryAudit: wireDiscovery,
      nativeLoads: loads.map(({ start, complete }) => ({
        toolCallId: start.data.toolCallId, startHash: hashObject(start), completionHash: hashObject(complete),
        success: complete.data.success
      })) }),
    native: freezeTask({
      traceHash: hashContent(record.stdout), requests: structuredClone(requests), tools: nativeEvidence, reads,
      artifacts: record.artifacts.map(({ base64, ...artifact }) => artifact),
      boundary: { accepted: true, denials, readonlySeedsUnchanged: true, guardUnchanged: true,
        unauthorizedFiles: [], leakDetected: false }
    }),
    nativeInteractionId: userMessages[0].data.interactionId ?? null
  };
}
