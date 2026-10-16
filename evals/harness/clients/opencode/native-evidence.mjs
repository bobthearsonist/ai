import path from 'node:path';
import { CLIENT_VERSION, PROMPT_ENVELOPE } from './constants.mjs';
import { TASK_CAPS, decodeCaseFiles, freeze, insist, record, seedPaths, sha256 } from './case-spec.mjs';
import { parseNativeEvents } from './native-events.mjs';
import { assertOriginalNativeTaskSpecification, nativeModelSelection, prepareNativeTaskSpecification } from './native-spec.mjs';
import {
  NATIVE_SESSION_FORMAT, SESSION_CAPS, canonicalNativeJSON, nativeIdentity, nativeTokenCounters, projectPinnedSessionExport
} from './native-session.mjs';

function validateSpecification(spec) {
  assertOriginalNativeTaskSpecification(spec);
  insist(spec?.format === 'opencode-native-task-specification-v1', 'The native task specification is required');
  const decoded = decodeCaseFiles(spec.materialization);
  const expected = prepareNativeTaskSpecification({
    task: spec.materialization.task, prompt: spec.materialization.prompt, ...decoded,
    artifactTargets: spec.materialization.artifactTargets, timeoutMs: spec.materialization.timeoutMs
  }, { model: spec.model.selector, limits: spec.limits.requested,
    authRoot: spec.auth.intendedDataRoot, proxyURL: spec.network.intendedProxyURL });
  insist(canonicalNativeJSON(spec) === canonicalNativeJSON(expected),
    'Native specification integrity mismatch', 'NATIVE_SPECIFICATION_INVALID');
  return expected;
}

function parseJSON(value, label) {
  insist(typeof value === 'string' && Buffer.byteLength(value) <= SESSION_CAPS.bytes,
    `${label} must be bounded native JSON`, 'NATIVE_SESSION_METADATA_INVALID');
  try { return JSON.parse(value); }
  catch { insist(false, `${label} is malformed`, 'NATIVE_SESSION_METADATA_INVALID'); }
}

function sessionEvidence(snapshot, parsed, spec) {
  record(snapshot, ['format', 'source', 'clientVersion', 'session', 'messages']);
  insist(snapshot.format === NATIVE_SESSION_FORMAT && snapshot.clientVersion === CLIENT_VERSION &&
    ['readonly-native-session-sqlite', 'native-session-export-format'].includes(snapshot.source) &&
    snapshot.session?.id === parsed.sessionId && snapshot.session.version === CLIENT_VERSION &&
    snapshot.session.directory === spec.cwd && snapshot.session.parentId === null &&
    Array.isArray(snapshot.messages) && snapshot.messages.length <= SESSION_CAPS.messages,
  'Native session snapshot does not bind to the actual native trace', 'NATIVE_SESSION_METADATA_INVALID');
  const ids = new Set();
  const parts = new Map();
  let partCount = 0;
  for (const message of snapshot.messages) {
    record(message, ['id', 'role', 'model', 'parentId', 'createdAt', 'completedAt', 'tokens', 'estimatedCost', 'finish', 'parts']);
    insist(nativeIdentity(message.id, 'msg') && !ids.has(message.id) && ['user', 'assistant'].includes(message.role) &&
      Array.isArray(message.parts) && Number.isFinite(message.createdAt) && message.createdAt >= 0,
    'Malformed native session projection', 'NATIVE_SESSION_METADATA_INVALID');
    ids.add(message.id);
    const selected = nativeModelSelection({ providerID: message.model?.providerID, modelID: message.model?.modelID });
    insist(selected.selector === message.model.selector, 'Malformed native session model metadata', 'NATIVE_SESSION_METADATA_INVALID');
    if (message.role === 'assistant') {
      nativeTokenCounters(message.tokens);
      insist(nativeIdentity(message.parentId, 'msg') && Number.isFinite(message.completedAt) &&
        message.completedAt >= message.createdAt && Number.isFinite(message.estimatedCost) && message.estimatedCost >= 0 &&
        ['stop', 'tool-calls'].includes(message.finish), 'Incomplete native assistant projection', 'NATIVE_SESSION_METADATA_INVALID');
    }
    for (const part of message.parts) {
      partCount++;
      insist(partCount <= SESSION_CAPS.parts && nativeIdentity(part.id, 'prt') && !parts.has(part.id) &&
        typeof part.type === 'string' && /^[a-f0-9]{64}$/.test(part.hash),
      'Malformed or duplicated native part projection', 'NATIVE_SESSION_METADATA_INVALID');
      parts.set(part.id, { ...part, messageId: message.id });
    }
  }
  const users = snapshot.messages.filter(message => message.role === 'user');
  const assistants = snapshot.messages.filter(message => message.role === 'assistant');
  const traceMessageIds = new Set(parsed.events.map(event => event.part.messageID));
  insist(users.length === 1 && assistants.length === traceMessageIds.size &&
    assistants.every(message => traceMessageIds.has(message.id) && message.parentId === users[0].id) &&
    assistants.every(message => message.model.selector === assistants[0].model.selector),
  'Mixed, continued, or incomplete native model/session metadata', 'NATIVE_SESSION_METADATA_INVALID');
  for (const event of parsed.events) {
    const stored = parts.get(event.part.id);
    insist(stored?.messageId === event.part.messageID && stored.type === event.part.type &&
      stored.hash === sha256(canonicalNativeJSON(event.part)),
    'Native event does not match the captured native session part', 'NATIVE_SESSION_METADATA_INVALID');
  }
  const inputs = users[0].parts.filter(part => part.type === 'text' && part.inputText &&
    part.inputText.synthetic === false && part.inputText.ignored === false);
  insist(inputs.length === 1, 'A unique native stored caller input is required', 'NATIVE_SESSION_METADATA_INVALID');
  const input = inputs[0].inputText;
  let observedInput = null;
  if (input.redacted !== true) {
    insist(input.nativeHash === spec.stdin.framedInputHash && input.callerSpanHash === spec.stdin.submittedHash &&
      input.envelope === PROMPT_ENVELOPE && input.bytes === spec.stdin.bytes + 1,
    'Native stored caller input was absent or rewritten', 'NATIVE_SESSION_METADATA_INVALID');
    observedInput = { hash: input.callerSpanHash, messageHash: input.nativeHash, envelope: input.envelope };
  }
  return {
    observedModel: assistants[0].model, observedInput, source: snapshot.source,
    hash: sha256(canonicalNativeJSON(snapshot)), messageCount: snapshot.messages.length, partCount,
    userModel: users[0].model
  };
}

function catalogEvidence(json, spec) {
  if (json == null) return null;
  const catalog = parseJSON(json, 'Native skill catalog');
  insist(Array.isArray(catalog) && catalog.length <= TASK_CAPS.files,
    'Unsupported native Skill.Info catalog format', 'NATIVE_CATALOG_INVALID');
  const names = new Set();
  const projected = catalog.map(skill => {
    record(skill, ['name', 'description', 'location', 'content']);
    insist(typeof skill.name === 'string' && !names.has(skill.name) && typeof skill.description === 'string' &&
      skill.description.trim() && Buffer.byteLength(skill.description) <= TASK_CAPS.promptBytes &&
      skill.name === spec.skill.id && skill.location === `${spec.layout.skills}/${spec.skill.id}/SKILL.md` &&
      typeof skill.content === 'string' && skill.content.trim() === spec.skill.body,
    'Native skill catalog escaped the explicit selected source', 'NATIVE_CATALOG_INVALID');
    names.add(skill.name);
    return { name: skill.name, location: skill.location, descriptionHash: sha256(skill.description),
      contentHash: sha256(skill.content.trim()) };
  });
  insist(spec.task.arm === 'no-skill' ? projected.length === 0 : projected.length === 1,
    'Native selected/no-skill catalog is incomplete', 'NATIVE_CATALOG_INVALID');
  return { skills: projected, hash: sha256(json), provenance: 'broker-captured-native-Skill.Info-format' };
}

function diskEvidence(disk, spec) {
  if (disk == null) return null;
  record(disk, ['format', 'task', 'seeds', 'inventory']);
  const expected = seedPaths(spec.materialization);
  insist(disk.format === 'opencode-native-disk-evidence-v1' &&
    canonicalNativeJSON(disk.task) === canonicalNativeJSON(spec.task) &&
    Array.isArray(disk.seeds) && disk.seeds.length === expected.length &&
    disk.seeds.every((seed, index) => {
      record(seed, ['path', 'sha256', 'bytes', 'readOnly', 'unchanged']);
      return seed.path === expected[index].filePath && seed.sha256 === expected[index].sha256 &&
        seed.bytes === expected[index].bytes && seed.readOnly === true && seed.unchanged === true;
    }),
  'Native readonly seed evidence is incomplete', 'NATIVE_DISK_EVIDENCE_INVALID');
  let total = 0;
  insist(Array.isArray(disk.inventory) && disk.inventory.length === spec.artifactTargets.length &&
    disk.inventory.every((entry, index) => {
      record(entry, entry.state === 'missing' ? ['target', 'state'] :
        ['target', 'state', 'regularFile', 'bytes', 'sha256']);
      if (entry.target !== spec.artifactTargets[index]) return false;
      if (entry.state === 'missing') return true;
      total += entry.bytes;
      return entry.state === 'present' && entry.regularFile === true && Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 && entry.bytes <= TASK_CAPS.artifactBytes && /^[a-f0-9]{64}$/.test(entry.sha256);
    }) && total <= TASK_CAPS.totalArtifactBytes,
  'Native selected-file disk inventory is incomplete', 'NATIVE_DISK_EVIDENCE_INVALID');
  return { seeds: disk.seeds, inventory: disk.inventory, hash: sha256(canonicalNativeJSON(disk)) };
}

function resolvedToolPath(value, cwd) {
  insist(typeof value === 'string' && value.length <= 1024 && !value.includes('\0') && !value.includes('\\'),
    'Unsupported native tool path', 'NATIVE_TOOL_BOUNDARY_UNVERIFIED');
  return path.posix.resolve(cwd, value);
}

export function parseNativeTaskEvidence(input) {
  record(input, ['spec', 'nativeResult', 'sessionJSON', 'sessionSnapshot', 'skillCatalogJSON', 'diskEvidence', 'capture'],
    ['spec', 'nativeResult']);
  const spec = validateSpecification(input.spec);
  const result = input.nativeResult;
  record(result, ['stdout', 'exitCode', 'timedOut', 'cancelled', 'clientVersion', 'elapsedMs'],
    ['stdout', 'exitCode']);
  insist(['timedOut', 'cancelled'].every(key => !Object.hasOwn(result, key) || typeof result[key] === 'boolean'),
    'Native execution state flags must be boolean');
  insist(!Object.hasOwn(result, 'clientVersion') || result.clientVersion === CLIENT_VERSION,
    'Observed native client version drift', 'RUNTIME_DRIFT');
  let parsed;
  try {
    insist(typeof result.stdout === 'string' && Buffer.byteLength(result.stdout) <= spec.limits.supervisor.stdoutBytes,
      'Native output exceeded the requested supervisor/parser byte cap');
    parsed = parseNativeEvents(result.stdout, { ...result, allowToolErrors: true });
  }
  catch { insist(false, 'Incomplete or malformed actual native JSON execution', 'NATIVE_EXECUTION_INCOMPLETE'); }
  insist(nativeIdentity(parsed.sessionId, 'ses'), 'Unsupported native session identity', 'NATIVE_EXECUTION_INCOMPLETE');
  const readPaths = new Set(spec.seeds.map(seed => seed.filePath));
  const outputs = new Set(spec.artifactTargets.map(target => `${spec.cwd}/${target}`));
  const allowedTools = ['skill', 'read', 'write', 'edit', 'multiedit', 'apply_patch'];
  const loads = [];
  const attempted = [];
  for (const tool of parsed.tools) {
    if (tool.tool === 'skill') attempted.push(tool);
    if (tool.state.status !== 'completed') continue;
    insist(allowedTools.includes(tool.tool), 'An undeclared native tool completed', 'NATIVE_TOOL_BOUNDARY_FAILED');
    if (tool.tool === 'read') {
      insist(readPaths.has(resolvedToolPath(tool.state.input.filePath, spec.cwd)),
        'An undeclared native Read completed', 'NATIVE_TOOL_BOUNDARY_FAILED');
    } else if (['write', 'edit', 'multiedit'].includes(tool.tool)) {
      insist(outputs.has(resolvedToolPath(tool.state.input.filePath, spec.cwd)),
        'An undeclared native output write completed', 'NATIVE_TOOL_BOUNDARY_FAILED');
    } else if (tool.tool === 'apply_patch') {
      insist(false, 'Native apply_patch path audit is unsupported', 'NATIVE_TOOL_BOUNDARY_UNVERIFIED');
    } else {
      const state = tool.state;
      insist(spec.skill.body !== null && state.input.name === spec.skill.id &&
        state.output.startsWith(`<skill_content name="${spec.skill.id}">`) && state.output.endsWith('</skill_content>') &&
        state.output.includes(spec.skill.body) && state.metadata?.name === spec.skill.id &&
        state.metadata.dir === `${spec.layout.skills}/${spec.skill.id}` && state.metadata.truncated === false &&
        state.title === `Loaded skill: ${spec.skill.id}`,
      'Missing genuine native target skill load metadata/content', 'NATIVE_TOOL_BOUNDARY_FAILED');
      loads.push(tool);
    }
  }
  insist(!(input.sessionJSON != null && input.sessionSnapshot != null), 'Only one native session observation is supported');
  const snapshot = input.sessionJSON != null ? projectPinnedSessionExport(parseJSON(input.sessionJSON, 'Native session export')) :
    input.sessionSnapshot ?? null;
  const session = snapshot ? sessionEvidence(snapshot, parsed, spec) : null;
  const catalog = catalogEvidence(input.skillCatalogJSON, spec);
  const disk = diskEvidence(input.diskEvidence, spec);
  const elapsedMs = result.elapsedMs ?? null;
  insist(elapsedMs === null || Number.isFinite(elapsedMs) && elapsedMs >= 0,
    'Native elapsed time must be actually measured or unavailable');
  const finishes = parsed.events.filter(event => event.type === 'step_finish');
  const counters = finishes.map(event => event.part.tokens == null ? null : nativeTokenCounters(event.part.tokens));
  const estimatedCost = finishes.every(event => Number.isFinite(event.part.cost) && event.part.cost >= 0)
    ? finishes.reduce((sum, event) => sum + event.part.cost, 0) : null;
  insist(estimatedCost === null || Number.isFinite(estimatedCost), 'Native cost estimate overflow');
  const blockers = [
    ...spec.blockers,
    ...(!session ? ['missing-native-session-model-and-input-observation'] : []),
    ...(session && !session.observedInput ? ['native-user-input-redacted-or-unavailable'] : []),
    ...(!catalog ? ['missing-native-skill-catalog-observation'] : []),
    'native-advertised-tools-config-mcp-and-plugin-catalog-unavailable',
    'encrypted-provider-wire-not-observed',
    ...(!disk ? ['missing-native-readonly-seed-and-selected-disk-evidence'] : [])
  ];
  const eventsHash = sha256(result.stdout);
  const evidence = loads.map(tool => ({ kind: 'skill-load', skill: spec.skill.id,
    ref: `opencode-native-event:sha256:${sha256(canonicalNativeJSON(tool))}` }));
  const metric = (value, provenance) => ({ value, provenance: value === null ? 'unavailable' : provenance });
  const receipt = {
    client: 'opencode', clientVersion: result.clientVersion ?? (session ? CLIENT_VERSION : null),
    task: spec.task, status: 'completed', sessionId: parsed.sessionId,
    model: {
      requested: spec.model.modelID, requestedProvider: spec.model.providerID,
      observed: session?.observedModel.modelID ?? null, provider: session?.observedModel.providerID ?? null,
      requestedSelector: spec.model.selector, observedSelector: session?.observedModel.selector ?? null,
      nativeRequestedSelector: session?.userModel.selector ?? null,
      provenance: session ? 'native-session-assistant-model-metadata-not-vendor-attestation' : 'unavailable'
    },
    prompt: {
      submittedHash: spec.stdin.submittedHash, submittedEnvelope: spec.stdin.envelope,
      nativeObservedHash: session?.observedInput?.hash ?? null,
      nativeMessageHash: session?.observedInput?.messageHash ?? null,
      envelope: session?.observedInput?.envelope ?? null,
      provenance: session?.observedInput ? 'native-persisted-user-text-not-provider-wire' : 'unavailable',
      wireMessageHash: null, providerWireObserved: false
    },
    catalog: {
      complete: false, skills: catalog?.skills ?? null, tools: null, config: null, mcp: null, plugins: null,
      skillCatalogHash: catalog?.hash ?? null, skillsProvenance: catalog?.provenance ?? 'unavailable',
      usedTools: [...new Set(parsed.tools.map(tool => tool.tool))],
      usedToolsProvenance: 'native-tool-events-not-advertised-tool-registry'
    },
    trigger: { loaded: loads.length > 0, evidence, attempted: attempted.length > 0,
      failedCalls: attempted.filter(tool => tool.state.status === 'error').length,
      absenceVerified: false, provenance: 'native-completed-skill-events-no-prose' },
    usage: {
      inputTokens: metric(parsed.usage?.inputTokens ?? null, 'native-cli-step-finish-client-reported'),
      outputTokens: metric(parsed.usage?.outputTokens ?? null, 'native-cli-step-finish-client-reported'),
      elapsedMs: metric(elapsedMs, 'broker-supervised-native-wall-clock'),
      usd: metric(null, 'unavailable'), credits: metric(null, 'unavailable')
    },
    nativeTrace: { complete: true, sessionId: parsed.sessionId, eventsHash,
      toolCallCount: parsed.tools.length, stepCount: finishes.length,
      tokens: counters,
      estimatedCost, estimatedCostProvenance: estimatedCost === null ? 'unavailable' : 'native-client-estimate-not-billing',
      observedUsedToolScopes: 'only-completed-events-checked-no-containment-proof',
      sessionSnapshotHash: session?.hash ?? null, sessionSource: session?.source ?? 'unavailable' },
    audit: { complete: false, nativeTraceComplete: true, providerWireObserved: false,
      sessionMetadataObserved: session !== null, diskEvidence: disk },
    blockers: [...new Set(blockers)],
    authenticationVerified: false, containmentVerified: false, liveAccepted: false
  };
  // Capture authority remains the shared host WeakMap; this projection never grades or clones the handle.
  if (Object.hasOwn(input, 'capture')) receipt.capture = input.capture;
  return freeze(receipt);
}
