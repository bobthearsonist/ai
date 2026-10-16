import { parseClaudeEvents } from './parser.mjs';
import { CLI_VERSION, NODE_VERSION } from './policy.mjs';
import {
  TASK_PROTOCOL, BUILTIN_SKILLS, insist, sha256, publicFixturePath, taskRuntimeArguments, taskAttacks
} from './task-policy.mjs';

const text = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(block => typeof block === 'string' ? block : block.text ?? '').join('\n') : '';
const identity = call => JSON.stringify({ name: call.name, input: call.input });

function readPresentation(source) {
  const crlfPairs = (source.text.match(/\r\n/g) ?? []).length;
  // Claude 2.1.291 Read joins CRLF source lines with LF without changing disk bytes.
  const displayed = source.text.replaceAll('\r\n', '\n');
  const lines = displayed.split('\n');
  const numbered = lines.map((line, index) => `${index + 1}\t${line}`).join('\n');
  return { crlfPairs, displayed, lines, numbered };
}

function nativeReadMatches(source, nativeResult, nativeToolResult, toolUseId, view) {
  const file = nativeResult?.file;
  return nativeResult?.type === 'text' && file?.filePath === source.absolute &&
    file.content === view.displayed && file.startLine === 1 &&
    file.numLines === view.lines.length && file.totalLines === view.lines.length &&
    nativeToolResult?.type === 'tool_result' && nativeToolResult.tool_use_id === toolUseId &&
    nativeToolResult.is_error !== true && nativeToolResult.content === view.numbered;
}

export function auditNativeReadResult({ source, nativeResult, nativeToolResult, toolUseId, executionId }) {
  const view = readPresentation(source);
  insist(nativeReadMatches(source, nativeResult, nativeToolResult, toolUseId, view),
    'Complete source bytes were not observed in the pinned native Read result',
    'NATIVE_SOURCE_UNSUPPORTED', { executionId, path: source.absolute, toolUseId });
  return {
    path: source.absolute, toolUseId, suppliedHash: source.sha256,
    nativeContentHash: sha256(nativeResult.file.content), source: 'native-Read-result-only',
    complete: true, providerWireObserved: false,
    presentation: { lineEndings: view.crlfPairs ? 'crlf-to-lf' : 'identity', crlfPairs: view.crlfPairs,
      suppliedBytes: source.bytes, nativeContentBytes: Buffer.byteLength(view.displayed),
      lineCount: view.lines.length, numbering: 'one-based-tab' }
  };
}

export function auditNativeSourceRead({ source, nativeResult, nativeToolResult, wireResult, toolUseId, executionId }) {
  const { crlfPairs, displayed, lines, numbered } = readPresentation(source);
  // Pinned Read preserves every line; provider framing removes the final empty-line tab.
  const wireNumbered = displayed.endsWith('\n') ? numbered.slice(0, -1) : numbered;
  const notice = typeof wireResult?.content === 'string'
    ? wireResult.content.match(/\n\n<system-reminder>\n<total_tokens>(0|[1-9]\d{0,15}) tokens left<\/total_tokens>\n<\/system-reminder>$/)
    : null;
  const file = nativeResult?.file;
  insist(nativeReadMatches(source, nativeResult, nativeToolResult, toolUseId,
    { displayed, lines, numbered }) &&
    wireResult?.type === 'tool_result' && wireResult.tool_use_id === toolUseId &&
    wireResult.is_error !== true && notice && Number.isSafeInteger(Number(notice[1])) &&
    wireResult.content === wireNumbered + notice[0],
  'Complete source file bytes were not observed in native Read and provider capture',
  'OFFLINE_TASK_SOURCE_UNSUPPORTED', { executionId, evidence: {
    path: source.absolute, toolUseId, suppliedBytes: source.bytes, suppliedHash: source.sha256,
    nativeResult: nativeResult ?? null,
    nativeToolResult: nativeToolResult
      ? Object.fromEntries(Object.entries(nativeToolResult).filter(([key]) => key !== 'event')) : null,
    wireResult: wireResult ?? null
  } });
  return {
    path: source.absolute, toolUseId, suppliedHash: source.sha256,
    nativeContentHash: sha256(file.content), wireResultHash: sha256(JSON.stringify(wireResult)),
    source: 'actual-native-Read-and-provider-request', complete: true,
    presentation: {
      lineEndings: crlfPairs ? 'crlf-to-lf' : 'identity', crlfPairs,
      suppliedBytes: source.bytes, nativeContentBytes: Buffer.byteLength(displayed),
      lineCount: lines.length, numbering: 'one-based-tab',
      providerFinalEmptyLineTabRemoved: displayed.endsWith('\n'),
      providerSuffix: 'pinned-native-total-tokens-reminder'
    }
  };
}

export function verifyCapturedReadback(capture, artifacts, executionId) {
  insist(capture.artifacts.length === artifacts.length && capture.artifacts.every(artifact => {
    const disk = artifacts.find(entry => entry.target === publicFixturePath(artifact.target));
    return disk && artifact.state === disk.state &&
      (disk.state !== 'present' || artifact.bytes === disk.bytes && artifact.sha256 === disk.sha256);
  }), 'Host trusted capture differs from verified native disk readback',
  'OFFLINE_TASK_CAPTURE_FAILED', { executionId });
}

export function assessTaskExecution(raw, prepared, executionId) {
  const failure = (condition, message, code = 'OFFLINE_TASK_NATIVE_FAILED', evidence = {}) =>
    insist(condition, message, code, { executionId, evidence });
  failure(raw?.protocol === TASK_PROTOCOL && raw.executionId === executionId &&
    raw.transport === 'offline-mock' && raw.offlineEvidenceOnly === true &&
    raw.authenticationVerified === false && raw.liveAccepted === false &&
    raw.version === `${CLI_VERSION} (Claude Code)` && raw.nodeVersion === NODE_VERSION &&
    typeof raw.stdout === 'string' && raw.exit && (Number.isInteger(raw.exit.code) || raw.exit.code === null) &&
    typeof raw.timedOut === 'boolean' && typeof raw.outputLimited === 'boolean' &&
    Array.isArray(raw.wire) && Array.isArray(raw.artifacts) && Array.isArray(raw.sourceState),
  'Invalid actual native task envelope');
  failure(JSON.stringify(raw.args) === JSON.stringify(taskRuntimeArguments(raw.help, {
    skillId: prepared.skillId, targets: prepared.targets, prompt: prepared.prompt
  })), 'Actual native task command differs from the strict policy');
  const parsed = parseClaudeEvents(raw.stdout, {
    exitCode: raw.exit?.code, timedOut: raw.timedOut, outputLimited: raw.outputLimited
  });
  const incomplete = { completion: parsed.completion,
    trigger: { loaded: null, evidence: [], auditComplete: false },
    stderr: typeof raw.stderr === 'string' ? raw.stderr.slice(-2000) : null,
    protocolError: raw.protocolError ?? null };
  failure(parsed.completion.status === 'success' && !raw.protocolError,
    'Native task failed or has an incomplete pinned event audit',
    raw.timedOut ? 'OFFLINE_TASK_TIMEOUT' : raw.outputLimited ? 'OFFLINE_TASK_OUTPUT_LIMIT' :
      'OFFLINE_TASK_AUDIT_INCOMPLETE', incomplete);
  failure(!parsed.events.some(event => event.subtype === 'api_retry'),
    'Native retries are not accepted as a completed scripted task', 'OFFLINE_TASK_AUDIT_INCOMPLETE', incomplete);

  const calls = new Map(), results = new Map();
  for (const event of parsed.events) {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') calls.set(block.id, { ...block, event });
      if (block.type === 'tool_result') results.set(block.tool_use_id, { ...block, event });
    }
  }
  const reads = prepared.sources.filter(source => source.kind === 'input' || prepared.mock.loadSkill);
  const attacks = taskAttacks(prepared.sources, prepared.skillId);
  const script = [
    ...(prepared.mock.loadSkill ? [{ name: 'Skill', input: { skill: prepared.skillId } }] : []),
    ...reads.map(source => ({ name: 'Read', input: { file_path: source.absolute } })),
    ...prepared.mock.artifacts.map(artifact => ({ name: 'Write',
      input: { file_path: `/workspace/${artifact.path}`, content: artifact.content } })),
    ...attacks
  ];
  failure(calls.size === script.length && raw.scriptedCalls === script.length &&
    raw.requests === script.length + 1 && raw.wire.length === raw.requests &&
    [...calls.values()].every((call, index) => call.id === `toolu_task_${index}` &&
      identity(call) === identity(script[index])),
  'Actual native tool loop did not complete the explicit scripted protocol', 'OFFLINE_TASK_AUDIT_INCOMPLETE', incomplete);
  const wireResults = new Map(raw.wire.flatMap(request => request.toolResults)
    .map(result => [result.tool_use_id, result]));
  failure([...results.keys()].every(id => wireResults.has(id)),
    'Native tool results are missing from provider-request capture', 'OFFLINE_TASK_AUDIT_INCOMPLETE', incomplete);

  const expectedTools = prepared.targets.length ? ['Read', 'Skill', 'Write'] : ['Read', 'Skill'];
  const toolSet = tools => Array.isArray(tools) && tools.length === expectedTools.length &&
    expectedTools.every(tool => tools.includes(tool));
  failure(parsed.init.cwd === '/workspace' && toolSet(parsed.init.tools) &&
    Array.isArray(parsed.init.mcp_servers) && parsed.init.mcp_servers.length === 0 &&
    parsed.init.skills.every(skill => skill === prepared.skillId || BUILTIN_SKILLS.includes(skill)) &&
    raw.wire.every(request => toolSet(request.tools) && /^[a-f0-9]{64}$/.test(request.requestHash)),
  'Native task tool/config/skill surface differs from the isolated profile', 'OFFLINE_TASK_BOUNDARY_FAILED');

  const first = raw.firstRequest;
  const promptMessages = first?.messages?.filter(message => message.role === 'user') ?? [];
  const promptBlock = promptMessages.flatMap(message => typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : Array.isArray(message.content) ? message.content : [])
    .find(block => block.type === 'text' && block.text === prepared.prompt);
  failure(promptBlock, 'Exact caller prompt was not observed in the actual native provider request',
    'OFFLINE_TASK_WIRE_MISMATCH');
  const promptHash = sha256(Buffer.from(promptBlock.text, 'utf8'));

  const denialEvidence = attacks.map(attack => {
    const call = [...calls.values()].find(item => identity(item) === identity(attack));
    const result = results.get(call?.id);
    const reason = text(result?.content);
    return { name: attack.name, input: attack.input, toolUseId: call?.id ?? null,
      denied: result?.is_error === true &&
        /denied by your permission settings|No such tool available:|permission.*denied|not allowed/i.test(reason),
      reason };
  });
  failure(denialEvidence.every(denial => denial.denied) && raw.rawCanaryObserved === false &&
    raw.boundaryCanariesUnchanged === true && Array.isArray(raw.forbiddenFilesCreated) &&
    raw.forbiddenFilesCreated.length === 0,
  'Native task protected read/write boundary failed', 'OFFLINE_TASK_BOUNDARY_FAILED', {
    denialEvidence, rawCanaryObserved: raw.rawCanaryObserved, forbiddenFilesCreated: raw.forbiddenFilesCreated
  });
  failure(raw.sourceState.length === prepared.sources.length && prepared.sources.every(source =>
    raw.sourceState.some(observed => observed.path === source.absolute && observed.bytes === source.bytes &&
      observed.sha256 === source.sha256 && observed.unchanged === true)),
  'Explicit read-only native source bytes changed', 'OFFLINE_TASK_BOUNDARY_FAILED');

  const sourceEvidence = reads.map(source => {
    const call = [...calls.values()].find(item => item.name === 'Read' && item.input.file_path === source.absolute);
    const result = results.get(call?.id);
    const wireResult = wireResults.get(call?.id);
    return auditNativeSourceRead({ source, nativeResult: result?.event.tool_use_result,
      nativeToolResult: result, wireResult, toolUseId: call?.id ?? null, executionId });
  });

  failure(raw.artifacts.length === prepared.targets.length && prepared.targets.every(target =>
    raw.artifacts.filter(artifact => artifact.target === target).length === 1),
  'Native disk readback does not match declared artifact targets');
  const artifactEvidence = raw.artifacts.map(artifact => {
    failure(['present', 'missing'].includes(artifact.state), 'Native artifact disk readback failed',
      'OFFLINE_TASK_CAPTURE_FAILED', { artifact });
    const mock = prepared.mock.artifacts.find(item => item.path === artifact.target);
    if (!mock) {
      failure(artifact.state === 'missing', 'An unscripted artifact appeared on native disk', 'OFFLINE_TASK_BOUNDARY_FAILED');
      return { target: artifact.target, state: 'missing' };
    }
    const filename = `/workspace/${artifact.target}`;
    const call = [...calls.values()].find(item => item.name === 'Write' && item.input.file_path === filename &&
      item.input.content === mock.content);
    const result = results.get(call?.id);
    const native = result?.event.tool_use_result;
    const bytes = typeof artifact.base64 === 'string' ? Buffer.from(artifact.base64, 'base64') : null;
    failure(artifact.state === 'present' && bytes && bytes.length === artifact.bytes &&
      sha256(bytes) === artifact.sha256 && bytes.equals(Buffer.from(mock.content)) &&
      result?.is_error !== true && native?.type === 'create' &&
      native.filePath === filename && native.content === mock.content,
    'Artifact requires both genuine native Write creation and matching filesystem bytes',
    'OFFLINE_TASK_CAPTURE_FAILED', { target: artifact.target, toolUseId: call?.id ?? null,
      nativeResult: native ?? null, disk: { state: artifact.state, bytes: artifact.bytes, sha256: artifact.sha256 } });
    return { target: artifact.target, state: 'present', bytes: artifact.bytes, sha256: artifact.sha256,
      toolUseId: call.id, source: 'actual-native-Write-and-filesystem-readback' };
  });

  const skillCalls = [...calls.values()].filter(call => call.name === 'Skill' && call.input.skill === prepared.skillId);
  const loadCalls = skillCalls.filter(call => {
    const result = results.get(call.id);
    return result?.is_error !== true && result?.event.tool_use_result?.success === true &&
      result.event.tool_use_result.commandName === prepared.skillId &&
      text(result.content) === `Launching skill: ${prepared.skillId}`;
  });
  const discovered = parsed.init.skills.includes(prepared.skillId);
  failure(loadCalls.length === 0 || discovered, 'Native skill load has no corresponding discovery record',
    'OFFLINE_TASK_AUDIT_INCOMPLETE', incomplete);
  const trigger = {
    loaded: loadCalls.length > 0, evidence: [],
    skillId: prepared.skillId, requested: skillCalls.length > 0, discovered,
    auditComplete: true, source: 'actual-native-tool-result-and-complete-event-audit',
    toolUseIds: loadCalls.map(call => call.id)
  };
  return { promptHash, promptCapture: { text: promptBlock.text, hash: promptHash,
    requestHash: raw.wire[0].requestHash, source: 'actual-native-provider-request' },
    trigger, completion: parsed.completion, nativeSessionId: parsed.init.session_id,
    events: parsed.events, sourceEvidence, artifactEvidence, denialEvidence };
}
