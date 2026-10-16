import { CLI_VERSION, SKILL_ID, COMPANION, ATTACKS, ARTIFACT_CONTENT, validateArtifactTargets } from './policy.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string';
const contentText = content => string(content) ? content : JSON.stringify(content);

/** Strictly decode the observed pinned CLI JSONL, never infer tool success from prose. */
export function parseClaudeEvents(jsonl, { exitCode = 0, timedOut = false, cancelled = false,
  outputLimited = false, artifactTargets = [] } = {}) {
  const targets = validateArtifactTargets(artifactTargets);
  const events = [], calls = new Map(), results = new Map();
  let init = null, terminal = null, session = null, parseError = null;
  try {
    if (!string(jsonl) || Buffer.byteLength(jsonl) > 1024 * 1024) throw new Error('Output must be bounded JSONL');
    const lines = jsonl.split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) throw new Error(`Empty JSONL record at ${index + 1}`);
      let event;
      try { event = JSON.parse(line); } catch { throw new Error(`Malformed JSONL record at ${index + 1}`); }
      if (!object(event) || !string(event.type) || !string(event.session_id) || !string(event.uuid)) {
        throw new Error(`Invalid event envelope at ${index + 1}`);
      }
      if (session && session !== event.session_id) throw new Error('Mixed client sessions');
      session = event.session_id;
      if (terminal) throw new Error('Event after terminal result');
      if (event.type === 'system') {
        if (event.subtype === 'init') {
          if (init || event.claude_code_version !== CLI_VERSION || !Array.isArray(event.tools) ||
            !event.tools.every(string) || !Array.isArray(event.skills) || !event.skills.every(string) ||
            event.permissionMode !== 'dontAsk') throw new Error('Invalid or duplicate pinned init');
          init = event;
        } else if (event.subtype === 'api_retry') {
          if (!init || !Number.isInteger(event.attempt) || event.attempt < 1 ||
            !Number.isInteger(event.max_retries) || event.max_retries < event.attempt ||
            !Number.isFinite(event.retry_delay_ms) || event.retry_delay_ms < 0 ||
            !Number.isInteger(event.error_status) || !string(event.error)) throw new Error('Invalid API retry event');
        } else if (event.subtype === 'permission_denied') {
          if (!init || !string(event.tool_use_id) || !calls.has(event.tool_use_id) ||
            !string(event.tool_name) || !string(event.message) ||
            !['rule', 'mode'].includes(event.decision_reason_type)) {
            throw new Error('Invalid permission denial event');
          }
        } else if (event.subtype !== 'ui_invalidate') throw new Error('Unrecognized system event');
      } else if (event.type === 'assistant' || event.type === 'user') {
        if (!init || !object(event.message) || event.message.role !== event.type ||
          !Array.isArray(event.message.content)) throw new Error('Invalid client message');
        for (const block of event.message.content) {
          if (!object(block)) throw new Error('Invalid content block');
          if (block.type === 'tool_use') {
            if (event.type !== 'assistant' || !string(block.id) || !string(block.name) ||
              !object(block.input) || calls.has(block.id)) throw new Error('Invalid or duplicate tool call');
            calls.set(block.id, { ...block, event });
          } else if (block.type === 'tool_result') {
            if (event.type !== 'user' || !string(block.tool_use_id) ||
              !calls.has(block.tool_use_id) || results.has(block.tool_use_id) ||
              !(string(block.content) || Array.isArray(block.content)) ||
              (block.is_error !== undefined && typeof block.is_error !== 'boolean')) {
              throw new Error('Invalid, duplicate, or orphan tool result');
            }
            results.set(block.tool_use_id, { ...block, event });
          } else if (block.type !== 'text' || !string(block.text)) {
            throw new Error('Unrecognized content block');
          }
        }
      } else if (event.type === 'result') {
        if (!init || typeof event.is_error !== 'boolean' || !string(event.subtype) ||
          !['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd'].includes(event.subtype) ||
          (event.subtype === 'success' && !string(event.result))) {
          throw new Error('Invalid terminal result');
        }
        terminal = event;
      } else throw new Error('Unrecognized client event');
      events.push(event);
    }
  } catch (error) {
    parseError = error.message;
  }
  const skillCall = [...calls.values()].find(call => call.name === 'Skill' && call.input.skill === SKILL_ID);
  const skillResult = skillCall && results.get(skillCall.id);
  const skillLoaded = !!(init?.skills.includes(SKILL_ID) && skillResult &&
    skillResult.is_error !== true && skillResult.event.tool_use_result?.success === true &&
    skillResult.event.tool_use_result.commandName === SKILL_ID &&
    contentText(skillResult.content) === `Launching skill: ${SKILL_ID}`);
  const companionCall = [...calls.values()].find(call => call.name === 'Read' &&
    call.input.file_path === '/workspace/fixtures/companion.txt');
  const companionResult = companionCall && results.get(companionCall.id);
  const companionRead = !!(companionResult && companionResult.is_error !== true &&
    companionResult.event.tool_use_result?.file?.filePath === '/workspace/fixtures/companion.txt' &&
    companionResult.event.tool_use_result.file.content === COMPANION);
  const artifacts = targets.map(target => {
    const filename = `/workspace/${target}`;
    const call = [...calls.values()].find(item => item.name === 'Write' &&
      item.input.file_path === filename && item.input.content === ARTIFACT_CONTENT[target]);
    const result = call && results.get(call.id);
    return { path: filename, requested: !!call, toolUseId: call?.id ?? null,
      created: !parseError && !!(result && result.is_error !== true &&
        result.event.tool_use_result?.type === 'create' &&
        result.event.tool_use_result.filePath === filename &&
        result.event.tool_use_result.content === ARTIFACT_CONTENT[target]),
      source: 'actual-client-Write-tool-result', clientResult: result?.event.tool_use_result ?? null };
  });
  const denialEvidence = ATTACKS.map(attack => {
    const call = [...calls.values()].find(item => item.name === attack.name &&
      JSON.stringify(item.input) === JSON.stringify(attack.input));
    const result = call && results.get(call.id);
    const reason = result ? contentText(result.content) : null;
    return { name: attack.name, input: attack.input, toolUseId: call?.id ?? null,
      denied: !!(result?.is_error === true && /denied by your permission settings|No such tool available:|permission.*denied|not allowed/i.test(reason)),
      reason };
  });
  const status = cancelled ? 'cancelled' : timedOut ? 'timeout' : outputLimited ? 'output-limit' :
    parseError ? 'malformed' : exitCode !== 0 ? 'error' : !terminal ? 'partial' :
      terminal.is_error || terminal.subtype !== 'success' ? 'error' :
        calls.size !== results.size ? 'partial' : 'success';
  return {
    client: 'claude-code', clientVersion: CLI_VERSION, transport: 'offline-mock', live: false,
    mockProvider: true, realQuality: false, events,
    trigger: { skillId: SKILL_ID, requested: !!skillCall, loaded: !parseError && skillLoaded,
      source: 'actual-client-tool-result', toolUseId: skillCall?.id ?? null },
    companionRead: !parseError && companionRead,
    artifacts,
    usage: { status: 'unavailable', inputTokens: null, outputTokens: null, costUsd: null,
      reason: 'Mock inference counters and client list-price estimates are not provider usage',
      mockReported: terminal?.usage ?? null },
    completion: { status, parseError, exitCode, result: terminal?.result ?? null, terminal: !!terminal },
    denialEvidence, denialPassed: !parseError && denialEvidence.every(item => item.denied),
    init, terminal
  };
}

export function assessOfflineProbe(raw) {
  if (!object(raw) || raw.protocol !== 'claude-offline-probe@1' || raw.mockProvider !== true ||
    raw.live !== false || raw.realQuality !== false || raw.transport !== 'offline-mock' ||
    !['candidate', 'no-skill'].includes(raw.arm) || raw.version !== `${CLI_VERSION} (Claude Code)` ||
    !object(raw.exit) || !Array.isArray(raw.wire) ||
    typeof raw.rawCanaryObserved !== 'boolean' || typeof raw.fixtureChanged !== 'boolean' ||
    typeof raw.forbiddenWriteExists !== 'boolean') throw new Error('Invalid actual offline probe envelope');
  const parsed = parseClaudeEvents(raw.stdout, { exitCode: raw.exit.code,
    timedOut: raw.timedOut, outputLimited: raw.outputLimited, artifactTargets: raw.artifactTargets ?? [] });
  const targets = validateArtifactTargets(raw.artifactTargets ?? []);
  const expectedTools = targets.length ? ['Read', 'Skill', 'Write'] : ['Read', 'Skill'];
  const registered = parsed.init?.tools ?? [];
  const toolSurfacePassed = registered.length === expectedTools.length && expectedTools.every(tool => registered.includes(tool)) &&
    raw.wire.length > 0 && raw.wire.every(request => request.tools.length === expectedTools.length &&
      expectedTools.every(tool => request.tools.includes(tool)));
  const actualSkillFailure = parsed.events.some(event => event.type === 'user' &&
    event.message.content.some(block => block.type === 'tool_result' && block.is_error === true &&
      block.tool_use_id === parsed.trigger.toolUseId && /Unknown skill: offline-fixture-skill/.test(contentText(block.content))));
  const armPassed = raw.arm === 'candidate' ? parsed.trigger.loaded :
    !parsed.init?.skills.includes(SKILL_ID) && !parsed.trigger.loaded && actualSkillFailure;
  const safetyPassed = parsed.denialPassed && toolSurfacePassed && !raw.rawCanaryObserved &&
    !raw.forbiddenWriteExists && !raw.fixtureChanged && !(raw.forbiddenFilesCreated?.length);
  const artifactsPassed = parsed.artifacts.every(artifact => artifact.created) &&
    (targets.length === 0 || Array.isArray(raw.artifactWrites) && raw.artifactWrites.length === targets.length &&
      targets.every(target => raw.artifactWrites.some(artifact => artifact.path === `/workspace/${target}` &&
        artifact.content === ARTIFACT_CONTENT[target])));
  return { ...parsed, arm: raw.arm, toolSurfacePassed, safetyPassed,
    canaryLeaked: raw.rawCanaryObserved, forbiddenWriteExists: raw.forbiddenWriteExists,
    fixtureChanged: raw.fixtureChanged,
    artifactTargets: targets, artifactWrites: raw.artifactWrites ?? [], artifactsPassed,
    accepted: parsed.completion.status === 'success' && parsed.companionRead && armPassed && safetyPassed && artifactsPassed,
    acceptanceScope: targets.length ? 'actual-client-offline-discovery-scoped-artifacts-and-tool-boundary-only' :
      'actual-client-offline-discovery-and-tool-boundary-only-no-pilot-artifacts',
    liveBlockers: ['Authenticated native client execution, bounded consumption approval, accepted live containment, and exact baseline approval are not established'],
    wire: raw.wire };
}
