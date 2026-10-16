import { createHash } from 'node:crypto';
import { parseCopilotEvents } from './parser.mjs';
import { assertNativeTaskSpecification } from './native-spec.mjs';
import { taskSeedFiles, taskSkillBody } from './task-protocol.mjs';
import { TASK_CAPS, taskKeys, insistTask, freezeTask } from './task-boundary.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest('hex');
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const counter = value => Number.isSafeInteger(value) && value >= 0;
const metric = (value, provenance) => ({ value: nonnegative(value) ? value : null,
  provenance: nonnegative(value) ? provenance : 'unavailable' });
const artifactBytes = new WeakMap();

export function readNativeTaskArtifact(observation, target) {
  const bytes = artifactBytes.get(observation);
  insistTask(bytes, 'NATIVE_OBSERVATION_UNTRUSTED');
  const content = bytes.get(target);
  return content === undefined ? null : Buffer.from(content);
}

function nativeUsage(usage, terminal, elapsedMs) {
  const root = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : null;
  const models = root?.modelMetrics && typeof root.modelMetrics === 'object' &&
    !Array.isArray(root.modelMetrics) ? Object.entries(root.modelMetrics) : [];
  const tokens = {};
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const values = models.map(([, record]) => record?.usage?.[key]);
    const total = values.length && values.every(counter) ? values.reduce((sum, value) => sum + value, 0) : null;
    tokens[key] = metric(counter(total) ? total : null, `copilot-native-usage-file:modelMetrics.usage.${key}`);
  }
  const elapsed = elapsedMs === undefined ? terminal.usage.sessionDurationMs : elapsedMs;
  return {
    metrics: {
      inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens,
      elapsedMs: metric(elapsed, elapsedMs === undefined
        ? 'copilot-native-jsonl:result.usage.sessionDurationMs' : 'broker-supervised-native-wall-clock'),
      usd: metric(null, 'unavailable'), credits: metric(null, 'unavailable')
    },
    native: {
      currentModel: typeof root?.currentModel === 'string' ? root.currentModel : null,
      tokens, totalNanoAiu: { ...metric(counter(root?.totalNanoAiu) ? root.totalNanoAiu : null,
        'copilot-native-usage-file:totalNanoAiu'), unit: 'nanoAIU' },
      premiumRequests: metric(counter(terminal.usage.premiumRequests) ? terminal.usage.premiumRequests : null,
        'copilot-native-jsonl:result.usage.premiumRequests'),
      totalPremiumRequestCost: { ...metric(nonnegative(root?.totalPremiumRequestCost) ? root.totalPremiumRequestCost : null,
        'copilot-native-usage-file:totalPremiumRequestCost/native-not-usd'), unit: 'native-premium-request-cost' },
      modelRequests: models.map(([model, record]) => ({
        model, count: metric(counter(record?.requests?.count) ? record.requests.count : null,
          'copilot-native-usage-file:modelMetrics.requests.count')
      })),
      usageFileHash: root ? hash(root) : null, providerWireObserved: false
    }
  };
}

/** Native observations only; this parser cannot authenticate or admit execution. */
export function parseNativeTaskEvidence(options) {
  taskKeys(options, ['specification', 'stdout', 'exitCode', 'usage', 'elapsedMs', 'submittedStdin',
    'filesystemEvidence', 'image'], ['specification', 'stdout', 'exitCode']);
  const { specification, stdout, exitCode, usage, elapsedMs, submittedStdin, filesystemEvidence, image } = options;
  assertNativeTaskSpecification(specification);
  insistTask(!Object.hasOwn(specification, 'toolTransport'), 'NATIVE_TOOL_TRANSPORT_OBSERVER_UNSUPPORTED',
    'The filesystem observer cannot verify worker artifacts, native MCP startup, the transported tool catalog, or selected Skill loading');
  insistTask(typeof stdout === 'string' && Buffer.byteLength(stdout) <= specification.limits.nativeOutputBytes &&
    Number.isInteger(exitCode), 'NATIVE_OBSERVATION_INVALID');
  insistTask(elapsedMs === undefined || nonnegative(elapsedMs), 'NATIVE_OBSERVATION_INVALID');
  insistTask(image === undefined || typeof image === 'string' && /^sha256:[a-f0-9]{64}$/.test(image),
    'NATIVE_OBSERVATION_INVALID');
  if (usage !== undefined && usage !== null) {
    insistTask(typeof usage === 'object' && !Array.isArray(usage), 'NATIVE_USAGE_RECORD_INVALID');
    try { insistTask(Buffer.byteLength(JSON.stringify(usage)) <= 65536, 'NATIVE_USAGE_RECORD_INVALID'); }
    catch { insistTask(false, 'NATIVE_USAGE_RECORD_INVALID'); }
  }
  let events;
  try { events = parseCopilotEvents(stdout); }
  catch { insistTask(false, 'NATIVE_JSONL_INVALID', 'Unknown, malformed, partial or unpaired native JSONL is not accepted'); }
  const terminal = events.at(-1);
  insistTask(exitCode === terminal.exitCode, 'NATIVE_EXIT_MISMATCH');
  const blockers = [];
  const add = code => { if (!blockers.includes(code)) blockers.push(code); };
  const envelope = specification.envelope;
  const seeds = taskSeedFiles(envelope);
  const users = events.filter(event => event.type === 'user.message');
  const promptRecorded = users.length === 1 && users[0].data.content === envelope.prompt;
  if (!promptRecorded) add('NATIVE_PROMPT_NOT_RECORDED');
  if (submittedStdin !== undefined) {
    taskKeys(submittedStdin, ['sha256', 'bytes'], ['sha256', 'bytes']);
    insistTask(submittedStdin.sha256 === specification.stdinHash &&
      submittedStdin.bytes === specification.stdinBytes, 'NATIVE_STDIN_MISMATCH');
  }
  const audits = events.filter(event => event.type === 'session.skills_loaded');
  const completeDiscovery = audits.length > 0 && audits.every(event => Array.isArray(event.data.skills) &&
    event.data.skills.every(skill => skill && typeof skill.name === 'string' && typeof skill.path === 'string' &&
      typeof skill.enabled === 'boolean' && ['project', 'builtin'].includes(skill.source) &&
      (skill.source !== 'builtin' ||
        skill.path.startsWith('/opt/copilot-cache/.cache/copilot/pkg/linux-x64/1.0.92/builtin/'))) &&
    new Set(event.data.skills.map(skill => skill.name)).size === event.data.skills.length);
  if (!completeDiscovery) add('NATIVE_DISCOVERY_AUDIT_INCOMPLETE');
  const skillPath = `/workspace/.github/skills/${envelope.skill.id}/SKILL.md`;
  const project = completeDiscovery ? audits.flatMap(event => event.data.skills.filter(skill => skill.source === 'project')) : [];
  const discoveryMatches = completeDiscovery && (envelope.skill.files.length
    ? project.length === audits.length && project.every(skill => skill.name === envelope.skill.id &&
      skill.path === skillPath && skill.enabled === true) : project.length === 0);
  if (completeDiscovery && !discoveryMatches) add('NATIVE_DISCOVERY_MISMATCH');
  const starts = events.filter(event => event.type === 'tool.execution_start');
  const completed = new Map(events.filter(event => event.type === 'tool.execution_complete')
    .map(event => [event.data.toolCallId, event]));
  const allowed = ['skill', 'view', ...(envelope.artifactTargets.length ? ['create', 'edit'] : [])];
  const reads = [], writes = [], loads = [], denials = [], violations = [], tools = [];
  for (const start of starts) {
    const complete = completed.get(start.data.toolCallId);
    const { toolName, arguments: args, toolCallId } = start.data;
    const data = complete.data;
    const evidence = { toolCallId, tool: toolName, path: typeof args.path === 'string' ? args.path : null,
      success: data.success, startHash: hash(start), completionHash: hash(complete) };
    tools.push(evidence);
    if (!data.success) {
      if (data.error.code === 'denied' || data.error.code === 'failure' &&
        data.error.message === `Tool '${toolName}' does not exist.`) denials.push(evidence);
      continue;
    }
    if (!allowed.includes(toolName)) violations.push(evidence);
    else if (toolName === 'skill') {
      const genuine = args.skill === envelope.skill.id && envelope.skill.files.length > 0 &&
        data.result.content === `Skill "${envelope.skill.id}" loaded successfully. Follow the instructions in the skill context.` &&
        data.toolTelemetry?.properties?.skillSource === 'project' &&
        data.toolTelemetry?.properties?.found === 'true';
      if (!genuine) violations.push(evidence);
      else loads.push({ ...evidence, skill: envelope.skill.id,
        nativeContentLength: counter(data.toolTelemetry?.metrics?.skillContentLength)
          ? data.toolTelemetry.metrics.skillContentLength : null });
    } else if (toolName === 'view') {
      const seed = seeds.find(file => file.target === args.path);
      const selectedOutput = envelope.artifactTargets.some(target => args.path === `/workspace/${target}`);
      if (!seed && !selectedOutput) violations.push(evidence);
      if (seed) reads.push({ ...evidence, fullContentRecorded: data.result.content.includes(seed.content),
        bytes: Buffer.byteLength(seed.content), sha256: hash(seed.content),
        provenance: 'copilot-native-jsonl:tool.execution_complete.result.content/not-provider-wire' });
    } else {
      if (!envelope.artifactTargets.some(target => args.path === `/workspace/${target}`)) violations.push(evidence);
      else writes.push(evidence);
    }
  }
  if (violations.length) add('NATIVE_TOOL_BOUNDARY_VIOLATION');
  const declaredBody = taskSkillBody(envelope);
  const loaded = discoveryMatches && loads.length > 0 && loads.every(load =>
    load.nativeContentLength === declaredBody.length);
  if (loads.length && !loaded) add('NATIVE_SKILL_LOAD_NOT_BOUND');
  const dispatches = events.filter(event => ['model.call_start', 'model.call_final_result'].includes(event.type))
    .map(event => ({ model: typeof event.data.model === 'string' && event.data.model.trim() ? event.data.model : null,
      source: `copilot-native-jsonl:${event.type}.data.model`, eventHash: hash(event),
      isByok: typeof event.data.isByok === 'boolean' ? event.data.isByok : null }));
  const observedModels = [...new Set(dispatches.map(dispatch => dispatch.model).filter(Boolean))];
  const modelMatches = observedModels.length > 0 && dispatches.every(dispatch => dispatch.model === specification.model);
  if (!modelMatches) add('NATIVE_DISPATCH_MODEL_UNBOUND');
  if (dispatches.some(dispatch => dispatch.isByok === true)) add('NATIVE_PROVIDER_MODE_MISMATCH');
  const measuredUsage = nativeUsage(usage, terminal, elapsedMs);
  if (measuredUsage.native.currentModel && measuredUsage.native.currentModel !== specification.model ||
    measuredUsage.native.modelRequests.some(model => model.model !== specification.model)) add('NATIVE_USAGE_MODEL_MISMATCH');
  let filesystem = null;
  const capturedBytes = new Map();
  if (filesystemEvidence !== undefined) {
    taskKeys(filesystemEvidence, ['before', 'after', 'artifacts', 'unauthorizedFiles']);
    const intact = [filesystemEvidence.before, filesystemEvidence.after].every(manifest =>
      Array.isArray(manifest) && manifest.length === seeds.length && seeds.every(seed => manifest.some(file =>
        file.path === seed.target && file.sha256 === hash(seed.content) &&
        file.bytes === Buffer.byteLength(seed.content) && file.readonly === true)));
    const artifacts = filesystemEvidence.artifacts;
    insistTask(Array.isArray(artifacts) && artifacts.length === envelope.artifactTargets.length &&
      new Set(artifacts.map(artifact => artifact.path)).size === artifacts.length &&
      artifacts.every(artifact => artifact && envelope.artifactTargets.includes(artifact.path) &&
        ['present', 'missing', 'error'].includes(artifact.state)) &&
      Array.isArray(filesystemEvidence.unauthorizedFiles), 'NATIVE_FILESYSTEM_RECORD_INVALID');
    let totalArtifactBytes = 0;
    const verifiedArtifacts = artifacts.map(artifact => {
      if (artifact.state !== 'present') return { path: artifact.path, state: artifact.state, bytesVerified: false };
      insistTask(typeof artifact.base64 === 'string' && counter(artifact.bytes) && artifact.bytes <= TASK_CAPS.artifactBytes,
        'NATIVE_ARTIFACT_RECORD_INVALID');
      const bytes = Buffer.from(artifact.base64, 'base64');
      totalArtifactBytes += bytes.length;
      insistTask(bytes.toString('base64') === artifact.base64 && bytes.length === artifact.bytes &&
        hash(bytes) === artifact.sha256 && totalArtifactBytes <= TASK_CAPS.outputBytes, 'NATIVE_ARTIFACT_RECORD_INVALID');
      capturedBytes.set(artifact.path, Buffer.from(bytes));
      return { path: artifact.path, state: artifact.state, bytes: bytes.length, sha256: hash(bytes),
        bytesVerified: true, nativeWriteRecorded: writes.some(write => write.path === `/workspace/${artifact.path}`) };
    });
    filesystem = { readonlySeedsUnchanged: intact, unauthorizedFiles: [...filesystemEvidence.unauthorizedFiles],
      artifacts: verifiedArtifacts, provenance: 'provided-native-filesystem-readback/broker-binding-required' };
    if (!intact || filesystem.unauthorizedFiles.length) add('NATIVE_FILESYSTEM_BOUNDARY_CHANGED');
    if (verifiedArtifacts.some(artifact => artifact.state === 'error' ||
      artifact.state === 'present' && !artifact.nativeWriteRecorded)) add('NATIVE_ARTIFACT_NOT_BOUND');
  } else add('NATIVE_FILESYSTEM_AUDIT_UNAVAILABLE');
  const configuration = events.filter(event => event.type === 'session.info').map(event => ({
    infoType: typeof event.data.infoType === 'string' ? event.data.infoType : null,
    eventHash: hash(event),
    disabledTools: typeof event.data.message === 'string' && /^Disabled tools: [a-z_]+(?:, [a-z_]+)*$/.test(event.data.message)
      ? event.data.message.slice('Disabled tools: '.length).split(', ') : null
  }));
  const mcps = events.filter(event => event.type === 'session.mcp_servers_loaded');
  const servers = mcps.flatMap(event => Array.isArray(event.data.servers) ? event.data.servers : []);
  if (servers.some(server => !server || typeof server.name !== 'string' || server.status !== 'disabled')) {
    add('NATIVE_MCP_STATE_NOT_DISABLED');
  }
  const errors = events.filter(event => ['session.error', 'model.call_failure'].includes(event.type))
    .map(event => ({ type: event.type, eventHash: hash(event) }));
  const nativeStatus = exitCode === 0 && errors.length === 0 ? 'completed' : 'failed';
  const finalResults = dispatches.filter(dispatch => dispatch.isByok !== null);
  const provider = finalResults.length && finalResults.every(dispatch => dispatch.isByok === false)
    ? 'native-account-client-reported' : finalResults.some(dispatch => dispatch.isByok === true) ? 'byok-client-reported' : null;
  const observation = freezeTask({
    client: 'copilot', clientVersion: specification.clientVersion,
    executionId: specification.executionId, task: specification.task, image: image ?? null,
    runtime: {
      expectedClientVersion: specification.clientVersion, observedClientVersion: null,
      versionProvenance: 'specification-pin/not-observed-by-jsonl-parser',
      imageProvenance: image === undefined ? 'unavailable' : 'provided-broker-image/broker-binding-required'
    },
    observationOnly: true, authenticationVerified: false, liveAccepted: false, qualityEvaluated: false,
    completion: { status: nativeStatus, exitCode, sessionId: typeof terminal.sessionId === 'string' ? terminal.sessionId : null, errors },
    submittedStdin: { sha256: specification.stdinHash, bytes: specification.stdinBytes,
      observed: submittedStdin !== undefined, provenance: submittedStdin === undefined
        ? specification.stdinProvenance : 'provided-bootstrap-stdin-readback/broker-binding-required/not-provider-wire' },
    prompt: { recorded: promptRecorded, submittedHash: specification.submittedPrompt.sha256,
      nativeObservedHash: users.length === 1 && typeof users[0].data.content === 'string' ? hash(users[0].data.content) : null,
      sha256: users.length === 1 && typeof users[0].data.content === 'string' ? hash(users[0].data.content) : null,
      submittedSha256: specification.submittedPrompt.sha256,
      nativeEventHash: users.length === 1 ? hash(users[0]) : null,
      provenance: 'copilot-native-jsonl:user.message.data.content/not-provider-wire', providerWireHash: null },
    model: { requested: specification.model,
      observed: modelMatches ? observedModels[0] : observedModels.length === 1 ? observedModels[0] : null,
      observedModels, provider, matches: modelMatches,
      dispatches, provenance: 'client-recorded-dispatch/not-decrypted-provider-response', providerWireVerified: false },
    trigger: { loaded, discovered: discoveryMatches && project.length > 0, auditComplete: completeDiscovery && discoveryMatches,
      discoveryAudit: audits.map(event => ({ ...event, data: { skills: event.data.skills } })),
      auditSource: completeDiscovery ? 'copilot-native-jsonl:session.skills_loaded' : 'unavailable',
      nativeLoads: loads, evidence: [
        ...audits.map(event => ({ kind: 'discovery-audit', skill: envelope.skill.id,
          ref: `copilot-native-jsonl:sha256:${hash(event)}` })),
        ...loads.map(load => ({ kind: 'skill-load', skill: envelope.skill.id,
          ref: `copilot-native-jsonl:sha256:${load.completionHash}` }))
      ], providerWireContextVerified: false, homeAuditLiveVerified: false },
    catalog: {
      complete: completeDiscovery && discoveryMatches,
      skills: completeDiscovery ? audits.map(event => structuredClone(event.data.skills)) : null,
      tools: { observedNames: [...new Set(starts.map(event => event.data.toolName))], available: null, complete: false },
      config: { events: configuration, complete: false },
      mcp: { servers: servers.map(server => ({ name: typeof server?.name === 'string' ? server.name : null,
        status: typeof server?.status === 'string' ? server.status : null })),
      eventHashes: mcps.map(hash), complete: mcps.length > 0 && mcps.every(event =>
        Array.isArray(event.data.servers) && event.data.servers.every(server =>
          server && typeof server.name === 'string' && typeof server.status === 'string')) },
      hooks: null, plugins: null, providerWireCatalogObserved: false
    },
    tools: { evidence: tools, reads, writes, denials, violations, pairedComplete: true,
      nativeModelCalls: events.filter(event => event.type === 'model.call_start').length },
    filesystem, usage: measuredUsage.metrics, nativeUsage: measuredUsage.native,
    traceHash: hash(stdout), blockers, nativeHardLimits: specification.nativeHardLimits
  });
  artifactBytes.set(observation, capturedBytes);
  return observation;
}
