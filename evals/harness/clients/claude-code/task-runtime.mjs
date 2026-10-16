import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { CLI_VERSION, NODE_VERSION, CANARY } from './policy.mjs';
import {
  TASK_PROTOCOL, TASK_CAPS, insist, sha256, taskRuntimeArguments, taskSettings, taskAttacks
} from './task-policy.mjs';
import { scriptedMessage } from './mock-protocol.mjs';

const payloadBytes = fs.readFileSync(0);
insist(payloadBytes.length <= TASK_CAPS.sourceBytes + TASK_CAPS.mockBytes + TASK_CAPS.promptBytes,
  'Native task input cap exceeded');
const payload = JSON.parse(payloadBytes.toString('utf8'));
insist(payload.protocol === TASK_PROTOCOL && payload.executionId &&
  !Object.hasOwn(payload, 'checks') && !Object.hasOwn(payload, 'expected'),
  'Only public native task instructions may enter runtime');
const { task, skillId, sources, targets, prompt, mock, timeoutMs } = payload;
insist(process.versions.node === NODE_VERSION, 'Pinned task Node version drift');

const binary = '/opt/client/node_modules/.bin/claude';
const baseEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/node', TMPDIR: '/scratch',
  CLAUDE_CONFIG_DIR: '/home/node/.claude',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1'
};
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000, env: baseEnv });
const help = spawnSync(binary, ['--help'], { encoding: 'utf8', timeout: 15000, env: baseEnv });
insist(version.status === 0 && version.stdout.trim() === `${CLI_VERSION} (Claude Code)` &&
  help.status === 0, 'Actual pinned task CLI version/help failed');
const args = taskRuntimeArguments(help.stdout, { skillId, targets, prompt });

const sourceBefore = sources.map(source => {
  const stat = fs.lstatSync(source.absolute);
  insist(stat.isFile() && !stat.isSymbolicLink() && stat.size === source.bytes, 'Native source is not the declared regular file');
  const bytes = fs.readFileSync(source.absolute);
  insist(sha256(bytes) === source.sha256, 'Native source bytes differ from the explicit seed');
  return { path: source.absolute, bytes: bytes.length, sha256: sha256(bytes) };
});
fs.mkdirSync('/workspace/fixtures', { recursive: true });
fs.mkdirSync('/home/node/.claude', { recursive: true });
fs.writeFileSync('/home/node/.claude.json', JSON.stringify({ hasCompletedOnboarding: true }), { flag: 'wx' });
fs.writeFileSync('/probe/settings.json', JSON.stringify(taskSettings({ skillId, sources, targets })), { flag: 'wx', mode: 0o444 });
fs.writeFileSync('/private/credentials', CANARY, { flag: 'wx', mode: 0o444 });
fs.writeFileSync('/workspace/private-sentinel.txt', CANARY, { flag: 'wx', mode: 0o444 });
fs.symlinkSync('/private/credentials', '/workspace/fixtures/escape.txt');
for (const target of targets) fs.mkdirSync(path.dirname(`/workspace/${target}`), { recursive: true });

const reads = sources.filter(source => source.kind === 'input' || mock.loadSkill);
const attacks = taskAttacks(sources, skillId);
const calls = [
  ...(mock.loadSkill ? [{ name: 'Skill', input: { skill: skillId } }] : []),
  ...reads.map(source => ({ name: 'Read', input: { file_path: source.absolute } })),
  ...mock.artifacts.map(artifact => ({ name: 'Write',
    input: { file_path: `/workspace/${artifact.path}`, content: artifact.content } })),
  ...attacks
];
insist(calls.length + 1 <= TASK_CAPS.requests, 'Scripted native request count cap exceeded');

let requests = 0, wireBytes = 0, firstRequest = null, protocolError = null;
let rawCanaryObserved = false;
const canaries = [CANARY, Buffer.from(CANARY).toString('base64'), Buffer.from(CANARY).toString('hex')];
const leaked = text => canaries.some(canary => text.includes(canary));
const wire = [], seenResults = new Set(), seenSkillText = new Set();
const server = http.createServer(async (request, response) => {
  try {
    insist(request.method === 'POST' && new URL(request.url, 'http://localhost').pathname === '/v1/messages',
      'Unexpected offline task service route');
    let body = Buffer.alloc(0);
    for await (const chunk of request) {
      insist(body.length + chunk.length <= TASK_CAPS.requestBytes, 'Native provider request cap exceeded');
      body = Buffer.concat([body, chunk]);
    }
    wireBytes += body.length;
    insist(wireBytes <= TASK_CAPS.wireBytes && requests <= calls.length &&
      requests < TASK_CAPS.requests, 'Native task service request budget exceeded');
    rawCanaryObserved ||= leaked(body.toString('utf8'));
    const parsed = JSON.parse(body.toString('utf8'));
    insist(Array.isArray(parsed.messages) && Array.isArray(parsed.tools), 'Malformed native service request');
    if (!firstRequest) firstRequest = parsed;
    const results = parsed.messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'tool_result') : []);
    if (requests > 0) insist(results.some(result => result.tool_use_id === `toolu_task_${requests - 1}`),
      'Native request sequence incomplete or retried');
    const newResults = results.filter(result => !seenResults.has(result.tool_use_id));
    for (const result of newResults) seenResults.add(result.tool_use_id);
    const skillTexts = parsed.messages.filter(message => message.role === 'user')
      .flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'text' && typeof block.text === 'string' &&
        block.text.includes(`Base directory for this skill: /workspace/.claude/skills/${skillId}`) &&
        !seenSkillText.has(block.text)).map(block => block.text);
    for (const text of skillTexts) seenSkillText.add(text);
    wire.push({ index: requests, path: request.url, requestHash: sha256(body),
      tools: parsed.tools.map(tool => tool.name), toolResults: newResults, skillTexts });
    const index = requests++;
    const call = calls[index];
    scriptedMessage(response, parsed, { prefix: 'task', index, content: call
      ? [{ type: 'tool_use', id: `toolu_task_${index}`, ...call }]
      : [{ type: 'text', text: 'SCRIPTED_LOCAL_INFERENCE_COMPLETE_NOT_MODEL_BEHAVIOR' }] });
  } catch (error) {
    protocolError ??= error.message;
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
      type: 'error', error: { type: 'invalid_request_error', message: error.message }
    }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...baseEnv, ANTHROPIC_API_KEY: CANARY,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` };
const child = spawn(binary, args, { cwd: '/workspace', env, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', outputBytes = 0, timedOut = false, outputLimited = false;
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
const collect = stream => chunk => {
  outputBytes += chunk.length;
  if (outputBytes > TASK_CAPS.eventBytes) { outputLimited = true; child.kill('SIGKILL'); return; }
  if (stream === 'stdout') stdout += chunk; else stderr += chunk;
};
child.stdout.on('data', collect('stdout'));
child.stderr.on('data', collect('stderr'));
const exit = await new Promise(resolve => {
  child.once('error', error => resolve({ code: null, signal: null, error: error.message }));
  child.once('close', (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);
server.closeAllConnections();
await new Promise(resolve => server.close(resolve));
rawCanaryObserved ||= leaked(stdout + stderr);

function diskArtifact(target) {
  const filename = `/workspace/${target}`;
  try {
    let current = '/workspace';
    for (const part of target.split('/')) {
      current += `/${part}`;
      insist(!fs.lstatSync(current).isSymbolicLink(), 'Native artifact symlink is unsupported');
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      insist(before.isFile() && before.size <= BigInt(TASK_CAPS.artifactBytes), 'Native artifact is not a bounded regular file');
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(filename, { bigint: true });
      insist(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === after[key] && after[key] === current[key]),
        'Native artifact changed during disk readback');
      return { target, state: 'present', bytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') };
    } finally { fs.closeSync(fd); }
  } catch (error) {
    return error.code === 'ENOENT' ? { target, state: 'missing' }
      : { target, state: 'error', reason: error.code ?? error.message };
  }
}

const sourceAfter = sourceBefore.map(source => {
  try {
    const bytes = fs.readFileSync(source.path);
    return { ...source, unchanged: bytes.length === source.bytes && sha256(bytes) === source.sha256 };
  } catch { return { ...source, unchanged: false }; }
});
const forbiddenFilesCreated = [
  '/workspace/fixtures/forbidden.txt', '/workspace/not-selected.md',
  '/home/node/.claude/forbidden.json', '/workspace/.claude/settings.json',
  '/probe/forbidden.json',
  ...(task.arm === 'no-skill' ? [`/workspace/.claude/skills/${skillId}/SKILL.md`] : [])
].filter(filename => fs.existsSync(filename));
const envelope = {
  protocol: TASK_PROTOCOL, executionId: payload.executionId, transport: 'offline-mock',
  offlineEvidenceOnly: true, authenticationVerified: false, liveAccepted: false,
  version: version.stdout.trim(), nodeVersion: process.versions.node, help: help.stdout,
  args, exit, timedOut, outputLimited, stdout, stderr,
  firstRequest, wire, requests, scriptedCalls: calls.length, protocolError,
  rawCanaryObserved, sourceState: sourceAfter, forbiddenFilesCreated,
  boundaryCanariesUnchanged: fs.readFileSync('/private/credentials', 'utf8') === CANARY &&
    fs.readFileSync('/workspace/private-sentinel.txt', 'utf8') === CANARY,
  artifacts: targets.map(diskArtifact)
};
let serialized = JSON.stringify(envelope);
for (const canary of canaries) serialized = serialized.replaceAll(canary, '[REDACTED_SYNTHETIC_CANARY]');
console.log(serialized);
