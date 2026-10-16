import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { CLI, SYNTHETIC_MODEL, buildCopilotTaskArguments } from './config.mjs';
import { TASK_CAPS, insistTask, taskKeys } from './task-boundary.mjs';
import { createNativeProtocolFixture } from './provider.mjs';
import { taskSeedFiles, taskSkillBody, taskProtocolSteps, nativeMessageText, extractWirePrompt } from './task-protocol.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const key = 'synthetic-offline-copilot-canary-not-a-secret';
const chunks = []; let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  insistTask(inputBytes <= TASK_CAPS.payloadBytes, 'TASK_LIMIT');
  chunks.push(chunk);
}
const serialized = Buffer.concat(chunks);
const payload = JSON.parse(serialized.toString('utf8'));
taskKeys(payload, ['executionId', 'prompt', 'skill', 'inputs', 'artifactTargets', 'mock']);
const seeds = taskSeedFiles(payload);
const steps = taskProtocolSteps(payload);
insistTask(steps.length + 1 <= TASK_CAPS.requests, 'TASK_LIMIT');
const env = {
  PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/eval',
  COPILOT_HOME: '/client-config/copilot', XDG_CACHE_HOME: '/opt/copilot-cache/.cache',
  XDG_CONFIG_HOME: '/client-config/xdg', XDG_DATA_HOME: '/client-config/data',
  XDG_STATE_HOME: '/client-config/state', TMPDIR: '/scratch',
  COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: key, COPILOT_MODEL: SYNTHETIC_MODEL
};
const version = spawnSync(CLI, ['--version'], { env, encoding: 'utf8', timeout: 20000 });
insistTask(version.status === 0 && /^GitHub Copilot CLI 1\.0\.92\./.test(version.stdout), 'TASK_RUNTIME_DRIFT');
insistTask(process.versions.node === '22.22.1', 'TASK_RUNTIME_DRIFT');
const directories = new Set(['/workspace', '/home/eval']);
function materialize(filename, content, executable = false) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  for (let directory = path.dirname(filename); ['/workspace', '/home/eval'].some(root =>
    directory === root || directory.startsWith(`${root}/`)); directory = path.dirname(directory)) directories.add(directory);
  fs.writeFileSync(filename, content, { flag: 'wx', mode: executable ? 0o555 : 0o444 });
}
for (const file of seeds) materialize(file.target, file.content, file.executable);
const sentinel = `OFFLINE_PRIVATE_GUARD_${randomUUID()}`;
const guards = [
  ['/home/eval/.boundary/private-credential.txt', sentinel],
  ['/workspace/.boundary/readonly.txt', 'protected\n'],
  ['/scratch/task-sentinel.txt', `OFFLINE_SCRATCH_GUARD_${randomUUID()}`],
  ['/client-config/protected.json', '{"value":"protected"}\n']
];
for (const [filename, content] of guards) materialize(filename, content);
fs.symlinkSync('/home/eval/.boundary/private-credential.txt', '/workspace/.boundary/escape.txt');
const allowedFiles = new Set([...seeds.map(file => file.target), ...guards.map(([filename]) => filename),
  '/workspace/.boundary/escape.txt', ...payload.mock.artifacts.map(file => `/workspace/${file.path}`)]);
for (const target of payload.artifactTargets) {
  const filename = `/workspace/${target}`;
  insistTask(!fs.existsSync(filename), 'TASK_SEED_OUTPUT_COLLISION');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  for (let directory = path.dirname(filename); directory === '/workspace' || directory.startsWith('/workspace/');
    directory = path.dirname(directory)) directories.add(directory);
}
for (const directory of directories) fs.chmodSync(directory, 0o555);
for (const artifact of payload.mock.artifacts) fs.chmodSync(path.dirname(`/workspace/${artifact.path}`), 0o700);
const before = seeds.map(file => ({ path: file.target, bytes: Buffer.byteLength(file.content),
  sha256: hash(fs.readFileSync(file.target)), readonly: (fs.statSync(file.target).mode & 0o222) === 0 }));
const requests = [], toolResponses = new Map();
let discoveryWire = null;
const skillBody = taskSkillBody(payload);
const provider = await createNativeProtocolFixture({
  callPrefix: 'task_call', finalText: 'OFFLINE_TASK_COMPLETE',
  maxRequests: TASK_CAPS.requests, maxRequestBytes: TASK_CAPS.requestBytes,
  onRequest: ({ body, tools, raw, turn, path: requestPath }) => {
    const prompt = turn === 0 ? extractWirePrompt(body) : null;
    const messages = body.messages.map(message => nativeMessageText(message.content) ?? '').join('\n');
    if (turn === 0) {
      const systems = body.messages.filter(message => message.role === 'system')
        .map(message => nativeMessageText(message.content) ?? '');
      const catalogs = systems.flatMap((text, messageIndex) =>
        [...text.matchAll(/<available_skills>[\s\S]*?<\/available_skills>/g)]
          .map(match => ({ text: match[0], messageIndex })));
      const boundedCatalogs = catalogs.filter(catalog => Buffer.byteLength(catalog.text) <= 32768);
      const skillSchema = tools.find(tool => tool.name === 'skill') ?? null;
      discoveryWire = {
        requestHash: hash(raw), systemMessageHashes: systems.map(text => hash(text)),
        catalogSourceRole: 'system', catalogCount: catalogs.length,
        catalogMarkerCount: systems.reduce((count, text) =>
          count + [...text.matchAll(/<\/?available_skills(?=[\s>])/g)].length, 0),
        catalogs: boundedCatalogs.map(catalog => catalog.text),
        catalogSystemMessageIndices: boundedCatalogs.map(catalog => catalog.messageIndex),
        skillSchema: skillSchema && Buffer.byteLength(JSON.stringify(skillSchema)) <= 32768 ? skillSchema : null
      };
    }
    const toolResults = [];
    for (const message of body.messages.filter(message => message.role === 'tool')) {
      const text = nativeMessageText(message.content);
      const id = message.tool_call_id;
      if (text === null || typeof id !== 'string') continue;
      const step = steps.find((_, index) => id === `task_call_${index}`);
      const seed = step?.kind === 'file-read' ? seeds.find(file => file.target === step.args.path) : null;
      const result = { toolCallId: id, sha256: hash(text), bytes: Buffer.byteLength(text),
        ...(seed ? { fullContentSeen: text.includes(seed.content) } : {}) };
      toolResults.push(result);
      if (!toolResponses.has(id)) toolResponses.set(id, { ...result, requestIndex: turn, text });
    }
    requests.push({
      index: turn, path: requestPath, sha256: hash(raw), bytes: raw.length,
      model: body.model, stream: body.stream, tools: tools.map(tool => tool.name),
      schemasHash: hash(JSON.stringify(tools)), toolResults,
      skillBodySeen: skillBody.length > 0 && messages.includes(skillBody),
      ...(turn === 0 ? { prompt: prompt ? { sha256: hash(prompt.text), bytes: Buffer.byteLength(prompt.text),
        userMessageHash: hash(prompt.userText), wrapper: prompt.wrapper } : null,
        seedTextInitiallySeen: seeds.filter(file => file.content.trim() && messages.includes(file.content.trim()))
          .map(file => file.target) } : {})
    });
  },
  next: ({ turn }) => steps[turn]
});
env.COPILOT_PROVIDER_BASE_URL = 'http://127.0.0.1:8765/v1';
const started = performance.now();
const child = spawn(CLI, buildCopilotTaskArguments(payload), { cwd: '/workspace', env,
  stdio: ['ignore', 'pipe', 'pipe'] });
const output = { stdout: [], stderr: [] };
let total = 0, outputLimited = false;
for (const channel of ['stdout', 'stderr']) child[channel].on('data', chunk => {
  total += chunk.length;
  if (total > TASK_CAPS.nativeOutputBytes) { outputLimited = true; child.kill('SIGKILL'); return; }
  output[channel].push(chunk);
});
const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
const nativeElapsedMs = performance.now() - started;
await provider.close();
const stdout = Buffer.concat(output.stdout).toString('utf8');
const stderr = Buffer.concat(output.stderr).toString('utf8');
const after = seeds.map(file => ({ path: file.target, sha256: hash(fs.readFileSync(file.target)),
  bytes: fs.statSync(file.target).size, readonly: (fs.statSync(file.target).mode & 0o222) === 0 }));
const artifacts = payload.artifactTargets.map(target => {
  const filename = `/workspace/${target}`;
  if (!fs.existsSync(filename)) return { path: target, state: 'missing' };
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > TASK_CAPS.artifactBytes) {
    return { path: target, state: 'error' };
  }
  const bytes = fs.readFileSync(filename);
  return { path: target, state: 'present', bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') };
});
const unauthorizedFiles = [];
function auditDirectory(directory) {
  for (const name of fs.readdirSync(directory)) {
    const filename = `${directory}/${name}`;
    const stat = fs.lstatSync(filename);
    if (stat.isDirectory()) auditDirectory(filename);
    else if (!allowedFiles.has(filename)) unauthorizedFiles.push(filename);
  }
}
auditDirectory('/workspace'); auditDirectory('/home/eval');
for (const step of steps.filter(step => step.kind === 'boundary-denial' && step.tool === 'create')) {
  if (fs.existsSync(step.args.path) && !unauthorizedFiles.includes(step.args.path)) unauthorizedFiles.push(step.args.path);
}
const guardUnchanged = guards.every(([filename, content]) => fs.readFileSync(filename).equals(Buffer.from(content)));
const agentOutput = stdout + [...toolResponses.values()].map(result => result.text).join('\n');
const leakDetected = [key, sentinel, guards[2][1]].some(value => agentOutput.includes(value));
console.log(JSON.stringify({
  transport: 'offline-mock', client: 'copilot', clientVersion: '1.0.92',
  nodeVersion: process.versions.node, executionId: payload.executionId,
  payloadHash: hash(serialized), freshWorkspace: true, nativeSessionFresh: true,
  exitCode, stdout, stderrHash: hash(stderr), nativeElapsedMs, outputLimited,
  provider: { calls: provider.calls, errors: provider.errors, requests, discoveryWire,
    toolResponses: [...toolResponses.values()].map(({ text, ...record }) => record) },
  artifacts, seedIntegrity: { before, after, guardUnchanged, unauthorizedFiles, leakDetected }
}));
