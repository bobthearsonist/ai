import { SKILL_ID } from './config.mjs';
const types = new Set(['session.skills_loaded', 'session.info', 'session.mcp_servers_loaded',
  'session.tools_updated', 'user.message', 'assistant.turn_start', 'model.call_start',
  'assistant.tool_call_delta', 'model.call_finished', 'assistant.message', 'tool.execution_start',
  'model.call_final_result', 'tool.execution_complete', 'assistant.turn_end',
  'assistant.message_start', 'assistant.message_delta', 'assistant.idle', 'session.error',
  'assistant.usage', 'session.usage_info', 'session.warning', 'model.call_failure']);
const fail = message => { const error = new Error(message); error.code = 'COPILOT_PARSE_ERROR'; throw error; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function parseCopilotEvents(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 1024 * 1024 || !stdout.trim()) fail('Bounded nonempty JSONL required');
  const lines = stdout.trim().split(/\r?\n/);
  const events = lines.map(line => {
    let event;
    try { event = JSON.parse(line); } catch { fail('Malformed JSONL event'); }
    if (!object(event) || typeof event.type !== 'string') fail('Invalid event envelope');
    if (event.type === 'result') {
      if (!Number.isInteger(event.exitCode) || !object(event.usage)) fail('Invalid terminal result');
    } else if (!types.has(event.type) || !object(event.data)) fail('Unknown or invalid event shape');
    return event;
  });
  const terminal = events.filter(e => e.type === 'result');
  if (terminal.length !== 1 || events.at(-1).type !== 'result') fail('Missing, duplicate or nonterminal result');
  const starts = new Map(), completed = new Set();
  for (const e of events) {
    if (e.type === 'tool.execution_start') {
      const d = e.data;
      if (typeof d.toolCallId !== 'string' || typeof d.toolName !== 'string' || !object(d.arguments) || starts.has(d.toolCallId)) fail('Invalid or duplicate tool start');
      starts.set(d.toolCallId, d);
    }
    if (e.type === 'tool.execution_complete') {
      const d = e.data;
      if (!starts.has(d.toolCallId) || completed.has(d.toolCallId) || typeof d.success !== 'boolean') fail('Unmatched or invalid tool result');
      if (d.success ? !object(d.result) || typeof d.result.content !== 'string' : !object(d.error) || typeof d.error.message !== 'string') fail('Invalid tool result payload');
      completed.add(d.toolCallId);
    }
  }
  if (completed.size !== starts.size) fail('Partial tool loop');
  return events;
}

export function normalizeCopilotOutcome({ stdout, exitCode, usage = null, image = null, expectedSkill = SKILL_ID }) {
  const events = parseCopilotEvents(stdout);
  const terminal = events.at(-1);
  if (!Number.isInteger(exitCode) || exitCode !== terminal.exitCode) fail('Process and terminal exit mismatch');
  const starts = new Map(events.filter(e => e.type === 'tool.execution_start').map(e => [e.data.toolCallId, e.data]));
  const tools = events.filter(e => e.type === 'tool.execution_complete').map(e => ({ ...e.data, ...starts.get(e.data.toolCallId) }));
  const discovered = events.some(e => e.type === 'session.skills_loaded' &&
    Array.isArray(e.data.skills) && e.data.skills.some(s => s.name === expectedSkill && s.enabled === true &&
      s.source === 'project' && s.path === `/workspace/.github/skills/${expectedSkill}/SKILL.md`));
  const load = tools.find(t => t.toolName === 'skill' && t.arguments.skill === expectedSkill &&
    t.success === true && t.result.content === `Skill "${expectedSkill}" loaded successfully. Follow the instructions in the skill context.`);
  const read = tools.find(t => t.toolName === 'view' && t.arguments.path === '/workspace/fixture.txt' &&
    t.success === true && t.result.content.includes('SYNTHETIC_FIXTURE_READ_OK'));
  const errors = [...events.filter(e => ['session.error', 'model.call_failure'].includes(e.type)).map(e => e.data),
    ...tools.filter(t => !t.success).map(t => ({ toolCallId: t.toolCallId, ...t.error }))];
  const messages = events.filter(e => e.type === 'assistant.message' &&
    typeof e.data.content === 'string' && Array.isArray(e.data.toolRequests) && e.data.toolRequests.length === 0);
  const finalText = messages.at(-1)?.data.content ?? null;
  let tokens = null;
  if (object(usage?.modelMetrics)) {
    const values = Object.values(usage.modelMetrics).map(m => m.usage);
    if (values.length && values.every(u => object(u) && ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].every(k => number(u[k]) !== null))) {
      tokens = Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(k => [k, values.reduce((sum, u) => sum + u[k], 0)]));
    }
  }
  const status = exitCode === 0 && errors.length === 0 && finalText ? 'completed' : 'error';
  return {
    client: 'copilot', clientVersion: '1.0.92', transport: 'offline-mock/not-live',
    image, events, modelQualityEvidence: false,
    trigger: { discovered, loaded: discovered && !!load, toolCallId: load?.toolCallId ?? null },
    fixtureRead: { succeeded: !!read, toolCallId: read?.toolCallId ?? null },
    usage: { tokens, usd: null, aiCredits: number(usage?.totalNanoAiu) === null ? null : usage.totalNanoAiu / 1e9,
      premiumRequests: number(terminal.usage.premiumRequests), source: usage ? 'actual-client-usage-file/synthetic-provider' : 'unavailable' },
    completion: { status, exitCode, text: finalText, errors }, liveSupported: false
  };
}

export function assessDenials(record, normalized) {
  const calls = record.provider?.calls ?? [];
  const results = normalized.events.filter(e => e.type === 'tool.execution_complete');
  const schemas = record.provider?.requestShapes?.flatMap(r => r.toolSchemas.map(t => t.name)) ?? [];
  const writing = record.artifactTargets?.length > 0;
  const expected = [
    ['view', '/proc/self/environ'], ['view', '/home/eval/private-credential.txt'],
    ['view', '/home/eval/out-of-scope.txt'], ['view', '/scratch/temp-sentinel.txt'],
    ['view', '/workspace/escape.txt'], ['bash', null], ['web_fetch', null],
    ['create', '/workspace/agent-write.txt'], ['edit', '/workspace/fixture.txt']
  ];
  if (writing) expected.push(['create', '/workspace/unapproved.md'], ['create', '/home/eval/agent-write.txt'],
    ['create', '/client-config/agent-write.txt'], ['edit', '/client-config/protected.json'], ['edit', `/workspace/${record.artifactTargets[0]}`]);
  const evidence = expected.map(([name, readPath]) => {
    const call = calls.find(c => c.name === name && (!readPath || c.arguments.path === readPath));
    const result = results.find(e => e.data.toolCallId === call?.id)?.data;
    const denied = result?.success === false && (name === 'view' || (writing && ['create', 'edit'].includes(name)) ? result.error?.code === 'denied' :
      result.error?.code === 'failure' && result.error.message === `Tool '${name}' does not exist.`);
    return { tool: name, path: readPath, toolCallId: call?.id ?? null, denied,
      error: result?.error ?? null };
  });
  return { accepted: evidence.every(e => e.denied) && record.leakDetected === false &&
    record.agentWroteFile === false && schemas.length > 0 && schemas.every(n => ['skill', 'view', ...(writing ? ['create', 'edit'] : [])].includes(n)) &&
    !calls.some(c => c.unexpectedPath), evidence, transport: 'offline-mock/not-live' };
}

export function assessArtifacts(record, normalized) {
  const targets = record.artifactTargets ?? [];
  const starts = new Map(normalized.events.filter(e => e.type === 'tool.execution_start').map(e => [e.data.toolCallId, e.data]));
  const results = normalized.events.filter(e => e.type === 'tool.execution_complete');
  const evidence = targets.map(target => {
    const result = results.find(e => starts.get(e.data.toolCallId)?.toolName === 'create' &&
      starts.get(e.data.toolCallId)?.arguments.path === `/workspace/${target}` && e.data.success === true);
    return { path: target, created: !!result, bytesVerified: record.artifacts?.[target] === `SYNTHETIC_NATIVE_ARTIFACT_${target}\n`,
      toolCallId: result?.data.toolCallId ?? null };
  });
  return { accepted: targets.length > 0 && evidence.every(e => e.created && e.bytesVerified), evidence };
}
