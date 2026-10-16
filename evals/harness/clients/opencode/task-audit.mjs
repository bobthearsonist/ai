import { buildConfig, parseEvents } from './index.mjs';
import { buildRestrictedTaskConfig } from './task-policy.mjs';
import {
  SKILL_ROOT, TASK_CAPS, freeze, insist, seedPaths, sha256, taskCalls, taskMarkers
} from './task-spec.mjs';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildTaskConfig(spec) {
  return { ...buildConfig(), ...buildRestrictedTaskConfig(spec) };
}

export function observeProviderRequest(body, spec, step, executionId = '00000000-0000-0000-0000-000000000000') {
  const markers = taskMarkers(executionId);
  insist(Array.isArray(body.messages) && Array.isArray(body.tools), 'Missing native provider request audit', 'AUDIT_INCOMPLETE');
  const userText = body.messages.filter(message => message.role === 'user')
    .flatMap(message => typeof message.content === 'string' ? [message.content] :
      Array.isArray(message.content) ? message.content.filter(block => block.type === 'text').map(block => block.text) : []);
  const prompt = userText.filter(text => text === `\n${spec.prompt}`);
  const variants = new Map([
    [sha256(`"${spec.prompt.replaceAll('"', '\\"')}"\n`), 'quoted-positional-argument'],
    [sha256(`${spec.prompt}\n`), 'trailing-newline'],
    [sha256(spec.prompt.replace(/\s+/g, ' ')), 'whitespace-collapsed']
  ]);
  const wireShapes = userText.filter(text => typeof text === 'string').map(text => ({
    bytes: Buffer.byteLength(text), sha256: sha256(text), containsCaller: text.includes(spec.prompt),
    knownShape: variants.get(sha256(text)) ?? null
  }));
  insist(prompt.length === 1,
    `Native wire prompt was absent, duplicated, or rewritten; text-block-shapes=${JSON.stringify(wireShapes)}`,
    'WIRE_PROMPT_MISMATCH');
  const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result');
  insist(results.length === step && step <= taskCalls(spec).length, 'Unexpected native request or hidden retry', 'AUDIT_INCOMPLETE');
  const tools = body.tools.map(tool => tool.name);
  const allowed = ['skill', 'read', 'write', 'edit', 'multiedit', 'apply_patch'];
  insist(tools.every(tool => allowed.includes(tool)) && new Set(tools).size === tools.length,
    'Unexpected native provider tool surface', 'TOOL_BOUNDARY_FAILED');
  const description = body.tools.find(tool => tool.name === 'skill')?.description ?? null;
  insist(description === null || typeof description === 'string' && Buffer.byteLength(description) <= TASK_CAPS.promptBytes,
    'Missing or oversized native discovery description', 'AUDIT_INCOMPLETE');
  const feedback = results.map(result => {
    insist(typeof result.tool_use_id === 'string' && typeof result.content === 'string',
      'Unsupported native tool feedback format', 'AUDIT_INCOMPLETE');
    insist(!result.content.includes(markers.canary) && !result.content.includes(markers.sentinel),
      'Protected synthetic content reached inference', 'TOOL_BOUNDARY_FAILED');
    return { callId: result.tool_use_id, isError: result.is_error === true, contentHash: sha256(result.content) };
  });
  return {
    request: { sequence: step, promptHash: sha256(prompt[0].slice(1)),
      wireMessageHash: sha256(prompt[0]), promptEnvelope: 'opencode-1.14.28-stdin-newline', tools, feedback },
    discovery: { available: tools.includes('skill'), description,
      descriptionHash: description === null ? null : sha256(description) }
  };
}

export function auditTaskExecution({ executionId, spec, native, requests, discovery, network, seeds, inventory }) {
  insist(native && typeof native.stdout === 'string' && Number.isInteger(native.exitCode),
    'Missing actual native execution audit', 'NATIVE_EXECUTION_INCOMPLETE');
  let parsed;
  try { parsed = parseEvents(native.stdout, { exitCode: native.exitCode, allowToolErrors: true }); }
  catch (error) {
    const errors = native.stdout.split(/\r?\n/).flatMap(line => {
      try {
        const event = JSON.parse(line);
        if (event.type !== 'error') return [];
        const knownNames = ['UnknownError', 'APIError', 'MessageAbortedError', 'ProviderAuthError', 'ModelNotFoundError'];
        const name = knownNames.includes(event.error?.name) ? event.error.name : 'unknown';
        const message = typeof event.error?.data?.message === 'string' ? event.error.data.message : '';
        const category = message.includes('disk I/O error') ? 'native-disk-io-error' : 'native-error';
        return [{ name, category, messageBytes: Buffer.byteLength(message), messageHash: sha256(message) }];
      } catch { return []; }
    });
    insist(false, `Incomplete or malformed actual native execution: ${error.message}; requests=${requests?.length ?? 0}; errors=${JSON.stringify(errors)}`,
      'NATIVE_EXECUTION_INCOMPLETE');
  }
  const markers = taskMarkers(executionId);
  const calls = taskCalls(spec);
  insist(parsed.tools.length === calls.length && parsed.completion.text === 'OFFLINE_TASK_COMPLETE',
    'Missing actual native tool calls or terminal completion', 'NATIVE_EXECUTION_INCOMPLETE');
  insist(Array.isArray(requests) && requests.length === calls.length + 1 &&
    discovery && Object.hasOwn(discovery, 'descriptionHash') && typeof discovery.available === 'boolean',
  'Missing full actual provider/discovery audit', 'AUDIT_INCOMPLETE');
  const promptHash = sha256(spec.prompt);
  const feedback = requests.at(-1).feedback;
  insist(requests.every((request, index) => request.sequence === index && request.promptHash === promptHash &&
    request.wireMessageHash === sha256(`\n${spec.prompt}`) &&
    request.promptEnvelope === 'opencode-1.14.28-stdin-newline' &&
    Array.isArray(request.feedback) && request.feedback.length === index && Array.isArray(request.tools) &&
    request.tools.every(tool => ['skill', 'read', 'write', 'edit', 'multiedit', 'apply_patch'].includes(tool)) &&
    request.feedback.every((result, i) => canonical(result) === canonical(feedback[i]))),
  'Incomplete, inconsistent, or retried provider feedback', 'AUDIT_INCOMPLETE');
  const denials = [];
  const loaded = [];
  const skillDir = `${SKILL_ROOT}/${spec.skill.id}`;
  for (const [index, expected] of calls.entries()) {
    const actual = parsed.tools[index];
    insist(actual.tool === expected.tool && actual.callID === `fixture_call_${index}` &&
      canonical(actual.state.input) === canonical(expected.input),
    'Unexpected actual native tool identity/input', 'NATIVE_EXECUTION_INCOMPLETE');
    const state = actual.state;
    const result = feedback[index];
    insist(result?.callId === actual.callID && result.isError === (state.status === 'error') &&
      result.contentHash === sha256(state.status === 'error' ? state.error : state.output),
    'Actual tool event does not match observed provider feedback', 'AUDIT_INCOMPLETE');
    if (expected.expectation === 'completed') {
      insist(state.status === 'completed', `Native ${expected.kind} failed`, 'NATIVE_TOOL_FAILURE');
      if (expected.kind === 'seed-read') {
        insist(state.metadata?.truncated === false && state.output.includes(`<path>${expected.input.filePath}</path>`),
          'Incomplete native seed read', 'NATIVE_TOOL_FAILURE');
      }
      if (expected.kind === 'artifact-create') {
        insist(state.metadata?.exists === false && state.metadata?.filepath === expected.input.filePath,
          'Native artifact was not created from an absent target', 'NATIVE_TOOL_FAILURE');
      }
    } else {
      const categories = typeof state.error === 'string' ? [
        'not found', 'rule which prevents', 'unavailable tool', 'ENOENT', 'EACCES', 'EPERM', 'permission denied'
      ].filter(category => state.error.toLowerCase().includes(category.toLowerCase())) : [];
      const unavailable = typeof state.error === 'string' && /unavailable tool/.test(state.error) &&
        requests.every(request => !request.tools.includes(actual.tool));
      insist(state.status === 'error' && typeof state.error === 'string' &&
        (expected.expectation === 'not-found' ? /Skill .*not found/i.test(state.error) :
          expected.expectation === 'denied' ? state.error.includes('rule which prevents') || unavailable : unavailable),
      `Protected native denial or no-skill control failed: call=${index}; kind=${expected.kind}; expected=${expected.expectation}; actual=${state.status}; categories=${JSON.stringify(categories)}`,
      'TOOL_BOUNDARY_FAILED');
      denials.push({ kind: expected.kind, tool: actual.tool, input: state.input,
        outcome: unavailable ? 'unavailable' : expected.expectation,
        eventHash: sha256(canonical(actual)), feedbackHash: result.contentHash });
    }
    if (actual.tool === 'skill' && state.status === 'completed' && state.input.name === spec.skill.id) {
      insist(typeof spec.skill.body === 'string' && state.output.startsWith(`<skill_content name="${spec.skill.id}">`) &&
        state.output.endsWith('</skill_content>') && state.output.includes(spec.skill.body) &&
        state.metadata?.name === spec.skill.id && state.metadata?.dir === skillDir &&
        state.metadata?.truncated === false && state.title === `Loaded skill: ${spec.skill.id}`,
      'Missing genuine native target skill load result', 'AUDIT_INCOMPLETE');
      loaded.push(actual);
    }
  }
  insist(!native.stdout.includes(markers.canary) && !native.stdout.includes(markers.sentinel),
    'Protected synthetic content reached native events', 'TOOL_BOUNDARY_FAILED');
  insist(network?.externalBlocked === true && Array.isArray(network.interfaces) &&
    network.interfaces.length === 1 && network.interfaces[0] === 'lo',
  'Offline network evidence incomplete', 'TOOL_BOUNDARY_FAILED');
  const expectedSeeds = seedPaths(spec);
  insist(Array.isArray(seeds) && seeds.length === expectedSeeds.length &&
    seeds.every((seed, i) => seed.path === expectedSeeds[i].filePath && seed.sha256 === expectedSeeds[i].sha256 &&
      seed.bytes === expectedSeeds[i].bytes && seed.readOnly === true && seed.unchanged === true),
  'Read-only seed integrity proof incomplete', 'TOOL_BOUNDARY_FAILED');
  insist(Array.isArray(inventory) && inventory.length === spec.artifactTargets.length &&
    inventory.every((entry, i) => entry.target === spec.artifactTargets[i] &&
      (entry.state === 'missing' || entry.state === 'present' && entry.regularFile === true &&
        Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= TASK_CAPS.artifactBytes &&
        /^[a-f0-9]{64}$/.test(entry.sha256))),
  'Native artifact disk inventory incomplete', 'NATIVE_EXECUTION_INCOMPLETE');
  for (const artifact of spec.mock.artifacts) {
    const entry = inventory.find(item => item.target === artifact.path);
    insist(entry?.state === 'present' && entry.bytes === Buffer.byteLength(artifact.content) &&
      entry.sha256 === sha256(artifact.content), 'Native artifact disk bytes differ from explicit fixture', 'NATIVE_TOOL_FAILURE');
  }
  const sessionId = parsed.events[0].sessionID;
  const eventsHash = sha256(native.stdout);
  const auditHash = sha256(canonical({ executionId, sessionId, eventsHash, requests, discovery, seeds, inventory, denials }));
  const evidence = loaded.map(tool => ({ kind: 'skill-load', skill: spec.skill.id,
    ref: `opencode-task-event:sha256:${sha256(canonical(tool))}` }));
  evidence.push({ kind: 'discovery-audit', skill: spec.skill.id, ref: `opencode-task-audit:sha256:${auditHash}` });
  return freeze({
    promptHash: requests[0].promptHash,
    wireMessageHash: requests[0].wireMessageHash, promptEnvelope: requests[0].promptEnvelope,
    trigger: { loaded: loaded.length > 0, evidence, attempted: parsed.tools.some(tool => tool.tool === 'skill'),
      failedCalls: parsed.tools.filter(tool => tool.tool === 'skill' && tool.state.status === 'error').length },
    audit: { complete: true, executionId, sessionId, eventsHash, auditHash, events: parsed.events,
      requests, discovery, toolCallCount: calls.length, providerRequestCount: requests.length, seeds, inventory },
    denials: { verified: true, evidence: denials }, network
  });
}
