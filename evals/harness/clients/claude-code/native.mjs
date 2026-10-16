import { isIP } from 'node:net';
import { CLI_VERSION, NODE_VERSION, BASE_IMAGE } from './policy.mjs';
import {
  TASK_CAPS, BUILTIN_SKILLS, exactKeys, insist, freeze, sha256, validateCoordinates,
  validateSkill, prepareFiles, textBytes, publicFixturePath, validatePaths, taskTmpfs, taskSettings
} from './task-policy.mjs';
import { parseClaudeEvents } from './parser.mjs';
import { readCapturedArtifact } from '../../checks/index.mjs';
import { auditNativeReadResult } from './task-evidence.mjs';
import { prepareNativeToolTransport, toolTransportSettings, TOOL_WORKER_LIFETIME_MS } from './tool-transport.mjs';

const specs = new WeakMap();
const BUILTIN_PLUGINS = Object.freeze([
  { name: 'cc-plugin-agents-md', path: 'builtin', source: 'cc-plugin-agents-md@builtin' },
  { name: 'cc-plugin-plugin-authoring', path: 'builtin', source: 'cc-plugin-plugin-authoring@builtin' }
]);
const unavailable = () => ({ value: null, provenance: 'unavailable' });
const digest = value => sha256(JSON.stringify(value));
const fullModel = value => typeof value === 'string' && value.length <= 120 &&
  /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const nativeLabel = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(value) ? value : null;
const imageId = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const apiKeySources = new Set(['none', 'ANTHROPIC_API_KEY', 'oauthToken', 'apiKeyHelper']);

function localProxy(value) {
  insist(typeof value === 'string' && value.length <= 256, 'Explicit bounded broker proxy URL required',
    'NATIVE_SPEC_INVALID');
  let url;
  try { url = new URL(value); } catch { insist(false, 'Invalid broker proxy URL', 'NATIVE_SPEC_INVALID'); }
  const host = url.hostname;
  const parts = host.split('.').map(Number);
  const ipv4 = isIP(host) === 4 && (parts[0] === 10 || parts[0] === 127 ||
    parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  const internalName = isIP(host) === 0 && /^[a-z][a-z0-9-]{0,62}$/.test(host);
  insist(url.protocol === 'http:' && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash && count(Number(url.port)) &&
    Number(url.port) >= 1 && Number(url.port) <= 65535 && (ipv4 || internalName),
  'Only an explicit credential-free local CONNECT proxy is supported', 'NATIVE_SPEC_INVALID');
  return url.origin;
}

/** Pure planning: no image, auth profile, network, model or consumption is admitted. */
export function prepareNativeTaskSpecification(payload, options) {
  exactKeys(payload, ['task', 'prompt', 'skill', 'inputs', 'artifactTargets', 'targets'], 'native task payload');
  exactKeys(options, ['model', 'limits', 'authRoot', 'proxyURL', 'toolTransport'], 'native task specification option');
  const task = validateCoordinates(payload.task);
  insist(typeof payload.prompt === 'string' && payload.prompt.trim(), 'Nonempty native caller prompt required',
    'NATIVE_SPEC_INVALID');
  const prompt = textBytes(payload.prompt, TASK_CAPS.promptBytes, 'Native prompt').text;
  insist(fullModel(options.model), 'Explicit full native Claude model ID required', 'NATIVE_SPEC_INVALID');
  insist(options.authRoot === '/home/node/.claude',
    'authRoot is only the unbound container config target /home/node/.claude, never a host store',
    'NATIVE_SPEC_INVALID');
  const proxyURL = localProxy(options.proxyURL);
  const limits = options.limits === undefined ? {} : options.limits;
  insist(limits !== null && typeof limits === 'object' && !Array.isArray(limits),
    'Native limits must be an explicit object', 'NATIVE_SPEC_INVALID');
  const unsupported = Object.keys(limits).filter(key =>
    !['timeoutMs', 'nativeOutputBytes', 'maxBudgetUsd', 'maxTurns'].includes(key));
  insist(unsupported.length === 0, `Unsupported native limits: ${unsupported.join(',')}`,
    'NATIVE_LIMIT_UNSUPPORTED');
  exactKeys(limits, ['timeoutMs', 'nativeOutputBytes', 'maxBudgetUsd', 'maxTurns'], 'native limits');
  const timeoutMs = limits.timeoutMs ?? (Object.hasOwn(options, 'toolTransport') ? TOOL_WORKER_LIFETIME_MS : 180000);
  insist(Number.isInteger(timeoutMs) && timeoutMs >= TASK_CAPS.minTimeoutMs && timeoutMs <= TASK_CAPS.maxTimeoutMs,
    'Host-owned native timeout must be 1000..300000 ms', 'NATIVE_SPEC_INVALID');
  const outputBytes = limits.nativeOutputBytes === undefined ? TASK_CAPS.eventBytes : limits.nativeOutputBytes;
  insist(Number.isInteger(outputBytes) && outputBytes >= 1024 && outputBytes <= TASK_CAPS.eventBytes,
    'Host-owned native output bound must be 1024..1048576 bytes', 'NATIVE_SPEC_INVALID');
  insist(limits.maxBudgetUsd === undefined || typeof limits.maxBudgetUsd === 'number' &&
    Number.isFinite(limits.maxBudgetUsd) && limits.maxBudgetUsd > 0 && limits.maxBudgetUsd <= 100,
  'Optional native list-price budget must be finite and 0..100 USD', 'NATIVE_SPEC_INVALID');
  insist(limits.maxTurns === undefined || Number.isSafeInteger(limits.maxTurns) &&
    limits.maxTurns >= 1 && limits.maxTurns <= 128,
  'Optional native main-loop turn bound must be a safe integer from 1 to 128', 'NATIVE_SPEC_INVALID');
  const skill = validateSkill(payload.skill, task.arm);
  const sources = [
    ...skill.files.map(file => ({ ...file, kind: 'skill', absolute: `/workspace/.claude/skills/${skill.id}/${file.path}` })),
    ...prepareFiles(payload.inputs ?? []).map(file => ({ ...file, kind: 'input',
      absolute: `${file.mountRoot === 'home' ? '/home/node' : '/workspace'}/${file.path}` }))
  ];
  insist(sources.length <= TASK_CAPS.files &&
    sources.reduce((sum, source) => sum + source.bytes, 0) <= TASK_CAPS.sourceBytes,
  'Native source file count/byte cap exceeded', 'NATIVE_SPEC_INVALID');
  insist(!(Object.hasOwn(payload, 'artifactTargets') && Object.hasOwn(payload, 'targets')),
    'Use only artifactTargets or its targets alias, never both', 'NATIVE_SPEC_INVALID');
  const artifactTargets = Object.hasOwn(payload, 'artifactTargets') ? payload.artifactTargets : payload.targets;
  insist(Array.isArray(artifactTargets) && artifactTargets.length <= TASK_CAPS.outputs,
    'Explicit native artifact target strings required', 'NATIVE_SPEC_INVALID');
  const targets = artifactTargets.map(publicFixturePath);
  validatePaths(sources, targets);
  const transport = Object.hasOwn(options, 'toolTransport')
    ? prepareNativeToolTransport(options.toolTransport, {
      task,
      publicFiles: sources.map(source => ({
        path: source.kind === 'skill' ? `skills/${skill.id}/${source.path}` : `inputs/${source.path}`,
        bytes: source.bytes, sha256: source.sha256
      })),
      artifactTargets: targets
    }) : null;
  // Worker-served inputs and artifacts are never staged or written by the native consumer.
  const planSources = transport ? sources.filter(source => source.kind === 'skill') : sources;
  const planTargets = transport ? [] : targets;
  if (transport) {
    insist(timeoutMs <= TOOL_WORKER_LIFETIME_MS,
      'Native timeout cannot exceed the fixed 60000 ms tool-worker lifetime', 'NATIVE_SPEC_INVALID');
  }
  const hasSkill = skill.files.length > 0;
  const settings = transport
    ? toolTransportSettings({ skillId: skill.id, hasSkill, serverName: transport.serverName })
    : taskSettings({ skillId: skill.id, sources, targets });
  const mcpToolNames = transport ? transport.tools.map(tool => `mcp__${transport.serverName}__${tool.name}`) : [];
  const argv = ['--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'text',
    '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    ...(transport ? [
      '--tools', hasSkill ? 'Skill' : '',
      '--allowedTools', [...(hasSkill ? [`Skill(${skill.id})`] : []), ...mcpToolNames].join(','),
      '--disallowedTools', 'Bash,Read,Write,Edit,NotebookEdit,WebFetch,WebSearch'
    ] : [
      '--tools', targets.length ? 'Skill,Read,Write' : 'Skill,Read',
      '--allowedTools', `Skill(${skill.id})`,
      '--disallowedTools', targets.length ? 'Bash,Edit,WebFetch,WebSearch' : 'Bash,Write,Edit,WebFetch,WebSearch'
    ]),
    '--settings', '/probe/settings.json', '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config',
    transport ? JSON.stringify({ mcpServers: { [transport.serverName]: transport.mcpConfig } }) : '{"mcpServers":{}}',
    '--no-session-persistence', '--model', options.model,
    ...(limits.maxTurns === undefined ? [] : ['--max-turns', String(limits.maxTurns)]),
    ...(limits.maxBudgetUsd === undefined ? [] : ['--max-budget-usd', String(limits.maxBudgetUsd)])];
  const body = {
    protocol: 'claude-native-task-specification@1', client: 'claude-code', task, skillId: skill.id,
    executable: '/opt/client/node_modules/.bin/claude', entrypoint: ['/opt/client/node_modules/.bin/claude'],
    cwd: '/workspace', argv,
    stdin: { format: 'text', text: prompt, bytes: Buffer.byteLength(prompt), sha256: sha256(prompt),
      provenance: 'planned-input-only' },
    model: { requested: options.model, observed: null, admitted: false },
    environment: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/node', TMPDIR: '/scratch',
      CLAUDE_CONFIG_DIR: options.authRoot, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1', HTTP_PROXY: proxyURL, HTTPS_PROXY: proxyURL, ALL_PROXY: proxyURL,
      http_proxy: proxyURL, https_proxy: proxyURL, all_proxy: proxyURL, NO_PROXY: '', no_proxy: '' },
    settings, policyHash: digest(settings),
    sourceFiles: planSources.map(({ path, absolute, text, bytes, sha256, executable, kind, mountRoot }) =>
      ({ path, target: absolute, content: text, bytes, sha256, executable, kind, mountRoot, readOnly: true })),
    targets: planTargets,
    ...(transport ? { toolTransport: transport } : {}),
    mountRoles: [
      ...(skill.files.length ? [{ role: 'skill-root', target: `/workspace/.claude/skills/${skill.id}`, readOnly: true }] : []),
      ...planSources.filter(source => source.kind === 'input').map(source =>
        ({ role: 'explicit-fixture', target: source.absolute, readOnly: true })),
      ...(transport ? [{ role: 'tool-worker-socket', target: transport.binding.transportMount.target,
        source: transport.binding.transportMount.source, readOnly: true, noCopy: true,
        socketPath: transport.binding.socketPath, supplementalGid: transport.binding.supplementalGid }] : []),
      { role: 'trusted-policy-file', target: '/probe/settings.json', readOnly: true, content: JSON.stringify(settings) },
      { role: 'broker-native-auth-profile', target: options.authRoot, binding: 'unbound',
        access: 'native-storage-and-refresh-unverified', modelToolRead: 'denied', modelToolWrite: 'denied' }
    ],
    tmpfs: taskTmpfs(planSources, planTargets),
    imageRequirements: { clientVersion: CLI_VERSION, nodeVersion: NODE_VERSION, baseImage: BASE_IMAGE,
      os: 'linux', architecture: 'amd64' },
    runtimeConstraints: { readOnlyRootfs: true, user: '1000:1000', dropCapabilities: ['ALL'],
      noNewPrivileges: true, memoryBytes: 768 * 1024 * 1024, cpus: 1, pids: 64,
      network: 'original-broker-CONNECT-boundary-required', externalPlugins: 'none',
      allowedNativeBuiltinPlugins: BUILTIN_PLUGINS, authStorageVerified: false, proxyCompatibilityVerified: false },
    limits: { timeoutMs, timeoutSource: 'trusted-host-supervision-required',
      outputBytes, artifactBytes: TASK_CAPS.artifactBytes,
      maxBudgetUsd: limits.maxBudgetUsd ?? null, budgetSource: limits.maxBudgetUsd === undefined ? 'not-requested' :
        'native-max-budget-usd-list-price-guard-only',
      maxTurns: limits.maxTurns ?? null, nativeTurnHardcap: 'supported-scoped-not-applied',
      nativeTurnScope: 'main-agent-tool-use-turns-not-all-provider-requests', nativeTurnLimitApplied: false,
      nativeTotalTokenHardcap: 'unsupported', prespendCapVerified: false },
    ...(transport ? { nativeToolPolicy: {
      serverName: transport.serverName, builtinTools: hasSkill ? ['Skill'] : [],
      allowedMcpTools: mcpToolNames, managedPolicyVerified: false,
      admissionBlockers: ['managed-policy-absence-unverified', 'native-mcp-consumption-unverified',
        'native-skill-loading-unverified', 'worker-capture-observer-unsupported'],
      promptTransformed: false, nativeAdmissionSupported: false, nativeRuntimeAdmitted: false,
      credentialBoundaryVerified: false, nativeDiscoveryVerified: false
    } } : {}),
    authenticationVerified: false, liveAccepted: false, planningOnly: true
  };
  const specification = freeze({ ...body, specificationHash: digest(body) });
  specs.set(specification, { task, prompt, sources: planSources, targets: planTargets, toolTransport: !!transport, skillId: skill.id, model: options.model,
    settings, outputBytes, maxTurns: limits.maxTurns ?? null, specificationHash: specification.specificationHash });
  return specification;
}

export function describeNativeTaskSpecification(specification) {
  insist(specs.has(specification), 'Original native specification handle required', 'NATIVE_SPEC_UNTRUSTED');
  return specification;
}

function knownPlugins(plugins) {
  return Array.isArray(plugins) && plugins.length === BUILTIN_PLUGINS.length &&
    plugins.every(plugin => BUILTIN_PLUGINS.some(expected =>
    plugin?.name === expected.name && plugin.path === expected.path && plugin.source === expected.source)) &&
    new Set(plugins.map(plugin => plugin.name)).size === plugins.length;
}

/** Deterministic process observations only; caller/native assertions never establish admission. */
export function parseNativeTaskEvidence(input) {
  exactKeys(input, ['specification', 'executionId', 'jsonl', 'exit', 'submittedInput',
    'sourceState', 'capture', 'elapsedMs', 'runtime'], 'native observation input');
  const prepared = specs.get(input.specification);
  insist(prepared, 'Original native specification handle required', 'NATIVE_SPEC_UNTRUSTED');
  insist(!prepared.toolTransport,
    'Native MCP tool-transport observation is not implemented; worker-filesystem capture and MCP/Skill evidence remain unproven',
    'NATIVE_TOOL_TRANSPORT_OBSERVER_UNSUPPORTED');
  insist(typeof input.executionId === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.executionId),
  'Trusted launcher execution UUID required', 'NATIVE_OBSERVATION_INVALID');
  exactKeys(input.exit, ['code', 'signal', 'timedOut', 'cancelled', 'outputLimited'], 'native process exit');
  insist(Number.isInteger(input.exit.code) || input.exit.code === null, 'Explicit native process exit code required');
  for (const key of ['timedOut', 'cancelled', 'outputLimited']) insist(typeof input.exit[key] === 'boolean',
    `Explicit native ${key} state required`, 'NATIVE_OBSERVATION_INVALID');
  insist(input.exit.signal === undefined || input.exit.signal === null ||
    typeof input.exit.signal === 'string' && /^[A-Z0-9]{1,32}$/.test(input.exit.signal),
  'Invalid native exit signal', 'NATIVE_OBSERVATION_INVALID');
  insist(typeof input.jsonl === 'string' && Buffer.byteLength(input.jsonl) <= prepared.outputBytes,
    'Bounded native JSONL required', 'NATIVE_OBSERVATION_INVALID');
  const parsed = parseClaudeEvents(input.jsonl, { exitCode: input.exit.code, timedOut: input.exit.timedOut,
    cancelled: input.exit.cancelled, outputLimited: input.exit.outputLimited });
  const issues = [];
  const issue = (condition, code) => { if (!condition) issues.push(code); return !!condition; };
  const init = parsed.init, terminal = parsed.terminal;
  const reportedTurns = count(terminal?.num_turns) ? terminal.num_turns : null;
  const turnLimitReached = terminal?.subtype === 'error_max_turns';
  if (prepared.maxTurns !== null) {
    issue(reportedTurns !== null, 'native-scoped-turn-count-unavailable');
    issue(reportedTurns === null || reportedTurns <= prepared.maxTurns, 'native-scoped-turn-limit-exceeded');
    issue(!turnLimitReached || reportedTurns === prepared.maxTurns, 'native-scoped-turn-limit-result-mismatch');
  } else {
    issue(!turnLimitReached, 'unexpected-native-turn-limit-result');
  }
  const envelopeComplete = issue(parsed.completion.status === 'success', 'native-envelope-incomplete') &&
    issue(!parsed.events.some(event => event.subtype === 'api_retry'), 'native-retry-observed');
  const wantedTools = prepared.targets.length ? ['Read', 'Skill', 'Write'] : ['Read', 'Skill'];
  const catalogComplete = issue(!!init && init.cwd === '/workspace' &&
    Array.isArray(init.tools) && init.tools.length === wantedTools.length &&
    wantedTools.every(tool => init.tools.includes(tool)) && Array.isArray(init.skills) &&
    init.skills.every(skill => skill === prepared.skillId || BUILTIN_SKILLS.includes(skill)) &&
    Array.isArray(init.mcp_servers) && init.mcp_servers.length === 0 &&
    knownPlugins(init.plugins) && init.permissionMode === 'dontAsk',
  'native-catalog-or-policy-surface-incomplete');
  const calls = new Map(), results = new Map();
  for (const event of parsed.events) for (const block of event.message?.content ?? []) {
    if (block.type === 'tool_use') calls.set(block.id, { ...block, event });
    if (block.type === 'tool_result') results.set(block.tool_use_id, { ...block, event });
  }
  issue([...calls.values()].every(call => results.get(call.id)?.is_error === true ||
    wantedTools.includes(call.name) && (call.name !== 'Skill' || call.input.skill === prepared.skillId)),
  'successful-tool-outside-explicit-grants');
  const skillCalls = [...calls.values()].filter(call => call.name === 'Skill' && call.input.skill === prepared.skillId);
  const loadedCalls = skillCalls.filter(call => {
    const result = results.get(call.id);
    return result?.is_error !== true && result?.event.tool_use_result?.success === true &&
      result.event.tool_use_result.commandName === prepared.skillId &&
      result.content === `Launching skill: ${prepared.skillId}`;
  });
  const loadAudited = envelopeComplete && catalogComplete;
  const loaded = loadAudited ? loadedCalls.length > 0 : null;
  issue(!loadedCalls.length || init?.skills?.includes(prepared.skillId), 'native-load-without-discovery');
  const responses = parsed.events.filter(event => event.type === 'assistant');
  const observedModels = [...new Set(responses.map(event => event.message?.model).filter(fullModel))];
  const observedModel = observedModels.length === 1 && responses.every(event => fullModel(event.message?.model))
    ? observedModels[0] : null;
  issue(observedModel !== null, 'native-response-model-missing-or-conflicting');
  issue(init?.model === prepared.model && observedModel === prepared.model, 'native-model-pin-mismatch');
  const modelUsage = terminal?.modelUsage;
  const perModel = modelUsage && typeof modelUsage === 'object' && !Array.isArray(modelUsage)
    ? Object.entries(modelUsage).filter(([model]) => fullModel(model)).map(([model, record]) => ({
      model, canonicalModel: fullModel(record?.canonicalModel) ? record.canonicalModel : null,
      provider: nativeLabel(record?.provider), costBasis: nativeLabel(record?.costBasis),
      inputTokens: count(record?.inputTokens) ? record.inputTokens : null,
      outputTokens: count(record?.outputTokens) ? record.outputTokens : null,
      cacheReadInputTokens: count(record?.cacheReadInputTokens) ? record.cacheReadInputTokens : null,
      cacheCreationInputTokens: count(record?.cacheCreationInputTokens) ? record.cacheCreationInputTokens : null,
      estimatedCostUsd: typeof record?.costUSD === 'number' && Number.isFinite(record.costUSD) &&
        record.costUSD >= 0 ? record.costUSD : null, source: 'native-result.modelUsage'
    })) : [];
  const provider = perModel.find(record => record.model === observedModel)?.provider ?? null;
  issue(provider !== null && provider.trim().length > 0, 'native-provider-metadata-unavailable');
  let submittedHash = null, submittedBytes = null;
  if (input.submittedInput !== undefined) {
    exactKeys(input.submittedInput, ['sha256', 'bytes'], 'trusted launcher submitted input record');
    if (issue(input.submittedInput.sha256 === input.specification.stdin.sha256 &&
      input.submittedInput.bytes === input.specification.stdin.bytes, 'submitted-input-mismatch')) {
      submittedHash = input.submittedInput.sha256; submittedBytes = input.submittedInput.bytes;
    }
  } else issues.push('submitted-input-unobserved');
  const promptEvents = parsed.events.filter(event => event.type === 'user' && !event.tool_use_result &&
    event.message.content.length === 1 && event.message.content[0].type === 'text' &&
    event.message.content[0].text === prepared.prompt);
  const sourceState = input.sourceState;
  const sourceIntegrity = issue(Array.isArray(sourceState) && sourceState.length === prepared.sources.length &&
    prepared.sources.every(source => sourceState.filter(entry => entry && entry.path === source.absolute &&
      entry.bytes === source.bytes && entry.sha256 === source.sha256 && entry.unchanged === true).length === 1),
  'source-filesystem-integrity-unobserved-or-mismatched');
  const readEvidence = [];
  for (const call of [...calls.values()].filter(call => call.name === 'Read')) {
    const result = results.get(call.id);
    if (result?.is_error === true) continue;
    const source = prepared.sources.find(source => source.absolute === call.input.file_path);
    if (!issue(!!source, 'successful-read-outside-declared-sources')) continue;
    try {
      readEvidence.push(auditNativeReadResult({ source, nativeResult: result?.event.tool_use_result,
        nativeToolResult: result, toolUseId: call.id, executionId: input.executionId }));
    } catch { issues.push('native-source-read-incomplete'); }
  }
  let capture = input.capture ?? null;
  const artifactEvidence = [];
  if (capture) {
    // Missing-target errors occur only after the shared reader validates its private capture handle.
    const identityTarget = '__native_capture_identity__';
    try { readCapturedArtifact(capture, identityTarget); } catch (error) {
      insist(error.message === `No captured file: ${identityTarget}`,
        'Original host artifact capture handle required', 'NATIVE_CAPTURE_UNTRUSTED');
    }
    insist(capture.artifacts?.length === prepared.targets.length && prepared.targets.every(target =>
      capture.artifacts.filter(artifact => publicFixturePath(artifact.target) === target).length === 1),
    'Capture does not match native declared targets', 'NATIVE_CAPTURE_UNTRUSTED');
    for (const target of prepared.targets) {
      const record = capture.artifacts.find(artifact => publicFixturePath(artifact.target) === target);
      const bytes = record.state === 'present' ? readCapturedArtifact(capture, record.target) : null;
      const writes = [...calls.values()].filter(call => call.name === 'Write' &&
        call.input.file_path === `/workspace/${target}` && results.get(call.id)?.is_error !== true);
      const last = writes.at(-1), result = last && results.get(last.id);
      const native = result?.event.tool_use_result;
      const present = record.state === 'present';
      const proved = present ? Buffer.isBuffer(bytes) && bytes.length <= TASK_CAPS.artifactBytes &&
        last && typeof last.input.content === 'string' && bytes.equals(Buffer.from(last.input.content)) &&
        ['create', 'update'].includes(native?.type) && native.filePath === `/workspace/${target}` &&
        native.content === last.input.content : record.state === 'missing' && !last;
      issue(proved, 'native-write-and-host-capture-mismatch');
      artifactEvidence.push({ target, state: record.state, bytes: record.bytes ?? null,
        sha256: record.sha256 ?? null, toolUseId: last?.id ?? null, complete: !!proved,
        source: 'native-Write-result-and-original-host-capture' });
    }
  } else issues.push('host-artifact-capture-unavailable');
  for (const call of calls.values()) {
    if (call.name === 'Write' && results.get(call.id)?.is_error !== true) {
      if (!prepared.targets.some(target => call.input.file_path === `/workspace/${target}`)) {
        issues.push('successful-write-outside-declared-targets');
      }
    }
  }
  const usageMetric = key => count(terminal?.usage?.[key])
    ? { value: terminal.usage[key], provenance: 'native-result.usage-not-provider-billing-verification' } : unavailable();
  const elapsed = typeof input.elapsedMs === 'number' && Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0
    ? { value: input.elapsedMs, provenance: 'trusted-broker-monotonic-wall-clock' } : unavailable();
  issue(elapsed.value !== null, 'host-elapsed-time-unobserved');
  const nativeUsage = terminal?.usage;
  issue(count(nativeUsage?.input_tokens) && count(nativeUsage?.output_tokens), 'native-usage-unavailable');
  if (input.runtime !== undefined) exactKeys(input.runtime, ['image', 'nodeVersion', 'argv', 'policyHash'], 'broker runtime record');
  const runtime = input.runtime ?? {};
  issue(imageId(runtime.image) &&
    runtime.nodeVersion === NODE_VERSION && JSON.stringify(runtime.argv) === JSON.stringify(input.specification.argv) &&
    runtime.policyHash === input.specification.policyHash, 'broker-runtime-pins-or-policy-record-unavailable');
  const denialEvidence = [...calls.values()].map(call => ({ call, result: results.get(call.id) }))
    .filter(({ result }) => result?.is_error === true).map(({ call, result }) => ({
      tool: call.name, toolUseId: call.id, source: 'native-tool-result',
      permissionDenied: typeof result.content === 'string' &&
        /denied by your permission settings|No such tool available:|permission.*denied|not allowed/i.test(result.content)
    }));
  const pluginCatalog = Array.isArray(init?.plugins) ? init.plugins.map(plugin => {
    const known = BUILTIN_PLUGINS.find(expected => plugin?.name === expected.name &&
      plugin.path === expected.path && plugin.source === expected.source);
    return known ? { ...known } : { approved: false, recordHash: digest(plugin) };
  }) : null;
  const mcpCatalog = Array.isArray(init?.mcp_servers) ? init.mcp_servers.map(server =>
    ({ approved: false, recordHash: digest(server) })) : null;
  return freeze({
    protocol: 'claude-native-task-observation@1', client: 'claude-code',
    clientVersion: init?.claude_code_version ?? null, executionId: input.executionId, task: prepared.task,
    specificationHash: prepared.specificationHash,
    status: parsed.completion.status === 'success' ? issues.length ? 'incomplete' : 'completed' : parsed.completion.status,
    completion: { status: parsed.completion.status, terminal: parsed.completion.terminal,
      exitCode: parsed.completion.exitCode, parseError: parsed.completion.parseError,
      limit: {
        kind: turnLimitReached ? 'max-turns' : terminal?.subtype === 'error_max_budget_usd' ? 'max-budget-usd' : null,
        requestedMaxTurns: prepared.maxTurns, reportedTurns,
        scope: 'native-main-agent-tool-use-turns-not-all-provider-requests',
        provenance: reportedTurns === null ? 'unavailable' : 'native-result.num_turns',
        enforcementVerified: false
      } },
    issues: [...new Set(issues)],
    model: { requested: prepared.model, selected: fullModel(init?.model) ? init.model : null,
      observed: observedModel, provider, observedModels, perModel,
      source: observedModel ? 'native-assistant.message.model' : 'unavailable',
      selectionSource: init?.model ? 'native-system-init.model' : 'unavailable' },
    prompt: { submittedHash, submittedBytes,
      submittedSource: submittedHash ? 'trusted-launcher-stdin-record' : 'unavailable',
      plannedHash: input.specification.stdin.sha256,
      nativeObservedHash: promptEvents.length ? sha256(promptEvents[0].message.content[0].text) : null,
      nativeObservedSource: promptEvents.length ? 'native-user-message-envelope' : 'unavailable',
      nativeEnvelopes: promptEvents.map(event => ({ uuid: event.uuid, sessionId: event.session_id, type: event.type })),
      providerWireObserved: false },
    catalog: { complete: catalogComplete, source: init ? 'native-system-init' : 'unavailable',
      scope: 'native-init-enumerated-skill-tool-MCP-plugin-catalog-only',
      skills: init?.skills?.filter(skill => skill === prepared.skillId || BUILTIN_SKILLS.includes(skill)) ?? null,
      tools: init?.tools?.filter(tool => wantedTools.includes(tool)) ?? null, mcp: mcpCatalog,
      plugins: pluginCatalog,
      config: { cwd: init?.cwd === '/workspace' ? init.cwd : null,
        permissionMode: init?.permissionMode === 'dontAsk' ? init.permissionMode : null,
        complete: false, source: 'native-init-config-summary-only',
        apiKeySource: apiKeySources.has(init?.apiKeySource) ? init.apiKeySource : null,
        hooksObservation: 'not-reported',
        instructionObservation: 'not-reported', requestedPolicyHash: input.specification.policyHash } },
    trigger: { loaded, auditComplete: loadAudited, evidence: [
      ...(catalogComplete ? [{ kind: 'native-discovery-catalog', ref: init.uuid, skill: prepared.skillId }] : []),
      ...loadedCalls.map(call => ({ kind: 'native-skill-load', ref: call.id, skill: prepared.skillId,
        resultRef: results.get(call.id).event.uuid }))
    ] },
    sourceAudit: { complete: envelopeComplete && sourceIntegrity && !issues.includes('native-source-read-incomplete') &&
        !issues.includes('successful-read-outside-declared-sources'),
      source: 'trusted-broker-filesystem-integrity-and-native-Read-results',
      readEvidence, declaredSourceCount: prepared.sources.length,
      observedAllDeclaredSources: prepared.sources.every(source => readEvidence.some(read => read.path === source.absolute)),
      providerWireObserved: false },
    artifacts: capture?.artifacts ?? null, artifactEvidence, capture,
    usage: { inputTokens: usageMetric('input_tokens'), outputTokens: usageMetric('output_tokens'),
      elapsedMs: elapsed, usd: unavailable(), credits: unavailable() },
    costEstimate: { value: typeof terminal?.total_cost_usd === 'number' &&
      Number.isFinite(terminal.total_cost_usd) && terminal.total_cost_usd >= 0 ? terminal.total_cost_usd : null,
      provenance: typeof terminal?.total_cost_usd === 'number' && Number.isFinite(terminal.total_cost_usd) &&
        terminal.total_cost_usd >= 0 ? 'native-client-list-price-estimate-not-invoice' : 'unavailable' },
    runtime: { image: imageId(runtime.image) ? runtime.image : null,
      nodeVersion: runtime.nodeVersion === NODE_VERSION ? runtime.nodeVersion : null,
      clientVersion: init?.claude_code_version ?? null, nativeSessionId: init?.session_id ?? null,
      source: 'native-init-and-trusted-broker-record-not-admission' },
    nativeEnvelope: { sha256: sha256(input.jsonl), records: parsed.events.length },
    denialEvidence, denialCoverage: 'observed-results-only-not-offline-attack-coverage',
    authenticationVerified: false, containmentVerified: false, liveAccepted: false,
    authority: 'deterministic-native-process-observation-only'
  });
}
