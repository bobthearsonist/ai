export function parseNativeEvents(stdout, { exitCode = 0, timedOut = false, cancelled = false, allowToolErrors = false } = {}) {
  if (typeof allowToolErrors !== 'boolean') throw new Error('Invalid parser options');
  if (timedOut || cancelled || exitCode !== 0) throw new Error('OpenCode execution failed, cancelled, or timed out');
  if (typeof stdout !== 'string' || !stdout.trim() || Buffer.byteLength(stdout) > 2 * 1024 * 1024) throw new Error('Missing or oversized events');
  let events;
  try { events = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)); }
  catch { throw new Error('Malformed JSON event stream'); }
  const kinds = ['step_start', 'step_finish', 'tool_use', 'text', 'error'];
  if (events.some(e => !e || typeof e !== 'object' || !kinds.includes(e.type) ||
    e.type !== 'error' && (!e.part || typeof e.part !== 'object' || Array.isArray(e.part)))) {
    throw new Error('Malformed event shape');
  }
  if (events.some(e => e.type === 'error')) throw new Error('OpenCode error event');
  let open = false;
  let stopped = false;
  let messageID;
  let stepTools = 0;
  const sessions = new Set();
  const calls = new Set();
  for (const e of events) {
    if (typeof e.sessionID !== 'string' || !e.sessionID || typeof e.part.sessionID !== 'string' ||
      e.sessionID !== e.part.sessionID || typeof e.part.messageID !== 'string') throw new Error('Missing event identity');
    sessions.add(e.sessionID);
    if (stopped) throw new Error('Events after completion');
    if (e.type === 'step_start') {
      if (open) throw new Error('Overlapping steps');
      open = true;
      messageID = e.part.messageID;
      stepTools = 0;
    } else if (e.type === 'step_finish') {
      if (!open || !['stop', 'tool-calls'].includes(e.part.reason)) throw new Error('Invalid step completion');
      if (e.part.reason === 'tool-calls' && !stepTools || e.part.reason === 'stop' && stepTools) throw new Error('Missing tool step completion');
      open = false;
      stopped = e.part.reason === 'stop';
    } else if (!open) throw new Error('Event outside step');
    if (e.part.messageID !== messageID) throw new Error('Mixed-message step');
    if (e.part.type !== { step_start: 'step-start', step_finish: 'step-finish', tool_use: 'tool', text: 'text' }[e.type]) throw new Error('Malformed part type');
    if (e.type === 'tool_use') {
      stepTools++;
      if (typeof e.part.tool !== 'string' || typeof e.part.callID !== 'string' || calls.has(e.part.callID)) throw new Error('Invalid tool identity');
      calls.add(e.part.callID);
      const state = e.part.state;
      if (!state || !state.input || typeof state.input !== 'object' ||
        state.status === 'completed' && typeof state.output !== 'string' ||
        state.status === 'error' && (typeof state.error !== 'string' || !state.error)) throw new Error('Malformed tool result');
    }
    if (e.type === 'text' && typeof e.part.text !== 'string') throw new Error('Malformed text');
  }
  if (sessions.size !== 1 || open || !stopped) throw new Error('Incomplete or mixed-session stream');
  const tools = events.filter(e => e.type === 'tool_use').map(e => e.part);
  if (tools.some(p => !p.state || !['completed', 'error'].includes(p.state.status))) throw new Error('Incomplete tool event');
  if (!allowToolErrors && tools.some(p => p.state.status === 'error')) throw new Error('Failed tool call');
  const finish = events.filter(e => e.type === 'step_finish').at(-1)?.part;
  if (!finish || finish.reason !== 'stop' || !events.some(e => e.type === 'step_start')) throw new Error('Incomplete completion');
  const text = events.filter(e => e.type === 'text').map(e => e.part.text).join('\n');
  if (!text.trim()) throw new Error('Missing completion text');
  const finishes = events.filter(e => e.type === 'step_finish');
  for (const e of finishes) {
    if (e.part.tokens != null && ![e.part.tokens.input, e.part.tokens.output].every(n => Number.isSafeInteger(n) && n >= 0)) {
      throw new Error('Malformed usage');
    }
  }
  const usage = finishes.every(e => e.part.tokens != null) ? {
    inputTokens: finishes.reduce((sum, e) => sum + e.part.tokens.input, 0),
    outputTokens: finishes.reduce((sum, e) => sum + e.part.tokens.output, 0)
  } : null;
  if (usage && ![usage.inputTokens, usage.outputTokens].every(Number.isSafeInteger)) throw new Error('Usage counter overflow');
  return { events, tools, usage, sessionId: events[0].sessionID, completion: { completed: true, text } };
}
