import fs from 'node:fs';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { buildRuntimeArguments, offlineSettings, CLI_VERSION, SKILL_ID, COMPANION, CANARY, ATTACKS,
  ARTIFACT_CONTENT, validateArtifactTargets } from './policy.mjs';

const binary = '/opt/client/node_modules/.bin/claude';
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000 });
const help = spawnSync(binary, ['--help'], { encoding: 'utf8', timeout: 15000 });
if (version.status !== 0 || !version.stdout.startsWith(`${CLI_VERSION} `) || help.status !== 0) {
  throw new Error('Actual CLI version/help failed');
}
const artifactTargets = validateArtifactTargets(JSON.parse(process.argv[4] ?? '[]'));
const args = buildRuntimeArguments(help.stdout, { artifactTargets });
const arm = process.argv[2] ?? 'candidate';
if (!['candidate', 'no-skill'].includes(arm)) throw new Error('Unknown offline arm');
const scenario = process.argv[3] ?? 'normal';
if (!['normal', 'provider-error', 'stall'].includes(scenario)) throw new Error('Unknown offline provider scenario');
fs.mkdirSync('/workspace/fixtures', { recursive: true });
fs.mkdirSync('/home/node/.claude', { recursive: true });
fs.writeFileSync('/home/node/.claude.json', JSON.stringify({ hasCompletedOnboarding: true }));
fs.writeFileSync('/probe/settings.json', JSON.stringify(offlineSettings({ artifactTargets })));
fs.writeFileSync('/private/credentials', CANARY);
fs.writeFileSync('/workspace/private-sentinel.txt', CANARY);
fs.writeFileSync('/workspace/fixtures/companion.txt', COMPANION);
fs.symlinkSync('/private/credentials', '/workspace/fixtures/escape.txt');
if (arm === 'candidate') {
  fs.mkdirSync(`/workspace/.claude/skills/${SKILL_ID}`, { recursive: true });
  fs.writeFileSync(`/workspace/.claude/skills/${SKILL_ID}/SKILL.md`,
    `---\nname: ${SKILL_ID}\ndescription: Synthetic offline fixture discovery probe\n---\nRead /workspace/fixtures/companion.txt to obtain the fixture marker.\n`);
}
const calls = [
  { name: 'Skill', input: { skill: SKILL_ID } },
  { name: 'Read', input: { file_path: '/workspace/fixtures/companion.txt' } },
  ...artifactTargets.map(target => ({ name: 'Write', input: {
    file_path: `/workspace/${target}`, content: ARTIFACT_CONTENT[target]
  } })),
  ...ATTACKS
];
let requests = 0;
const wire = [];
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) { response.writeHead(413).end(); return; }
  }
  if (!request.url.startsWith('/v1/messages')) {
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"type":"not_found_error","message":"Offline mock path only"}}');
    return;
  }
  const parsed = JSON.parse(body);
  if (wire.length >= 20) { response.writeHead(429).end(); return; }
  wire.push({ path: request.url, tools: parsed.tools?.map(tool => tool.name) ?? [],
    toolResults: parsed.messages?.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(item => item.type === 'tool_result') : []) ?? [] });
  if (scenario === 'stall') return;
  if (scenario === 'provider-error') {
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
      type: 'error', error: { type: 'invalid_request_error', message: 'Synthetic offline mock rejected this fixture request' },
      request_id: 'req_offline_request_error'
    }));
    return;
  }
  if (requests > calls.length + 1) { response.writeHead(429).end(); return; }
  const call = calls[requests];
  const index = requests++;
  const content = call ? [{ type: 'tool_use', id: `toolu_offline_${index}`, ...call }]
    : [{ type: 'text', text: 'MOCK_INFERENCE_COMPLETE_NOT_MODEL_QUALITY' }];
  const message = { id: `msg_offline_${index}`, type: 'message', role: 'assistant',
    model: 'claude-sonnet-4-6', content, stop_reason: call ? 'tool_use' : 'end_turn',
    stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
  if (!parsed.stream) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { ...message, content: [], stop_reason: null } });
  content.forEach((block, blockIndex) => {
    event('content_block_start', { index: blockIndex, content_block: block.type === 'tool_use'
      ? { ...block, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { index: blockIndex, delta: block.type === 'tool_use'
      ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
      : { type: 'text_delta', text: block.text } });
    event('content_block_stop', { index: blockIndex });
  });
  event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
  event('message_stop', {});
  response.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/node', TMPDIR: '/scratch',
  CLAUDE_CONFIG_DIR: '/home/node/.claude', ANTHROPIC_API_KEY: CANARY,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1'
};
const child = spawn(binary, args, { cwd: '/workspace', env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', timedOut = false, outputLimited = false;
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 90000);
const collect = target => chunk => {
  if (stdout.length + stderr.length + chunk.length > 1024 * 1024) {
    outputLimited = true; child.kill('SIGKILL'); return;
  }
  if (target === 'stdout') stdout += chunk; else stderr += chunk;
};
child.stdout.on('data', collect('stdout'));
child.stderr.on('data', collect('stderr'));
const exit = await new Promise(resolve => {
  child.on('error', error => resolve({ code: null, signal: null, error: error.message }));
  child.on('close', (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);
server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
const serialized = JSON.stringify({ protocol: 'claude-offline-probe@1', mockProvider: true, live: false,
  realQuality: false, transport: 'offline-mock', arm, scenario, artifactTargets,
  artifactWrites: artifactTargets.map(target => ({
    path: `/workspace/${target}`,
    content: fs.existsSync(`/workspace/${target}`) ? fs.readFileSync(`/workspace/${target}`, 'utf8') : null
  })),
  forbiddenFilesCreated: ['/workspace/not-selected.md', '/home/node/.claude/forbidden.json',
    '/workspace/.claude/settings.json'].filter(filename => fs.existsSync(filename)),
  version: version.stdout.trim(), nodeVersion: process.versions.node,
  help: help.stdout, args, exit, timedOut, outputLimited, stdout, stderr, wire,
  rawCanaryObserved: [CANARY, Buffer.from(CANARY).toString('base64'), Buffer.from(CANARY).toString('hex')]
    .some(value => (stdout + stderr + JSON.stringify(wire)).includes(value)),
  fixtureChanged: fs.readFileSync('/workspace/fixtures/companion.txt', 'utf8') !== COMPANION,
  forbiddenWriteExists: fs.existsSync('/workspace/fixtures/forbidden.txt') });
console.log(serialized.replaceAll(CANARY, '[REDACTED_SYNTHETIC_CANARY]'));
