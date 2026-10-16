import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { CLI, buildCopilotNativeArguments } from './config.mjs';
import { TASK_CAPS, taskPath, insistTask } from './task-boundary.mjs';
import { taskSeedFiles } from './task-protocol.mjs';
import { validateNativeTaskEnvelope } from './native-envelope.mjs';
import { nativeEnvironment } from './native-options.mjs';
import { NATIVE_TOOL_TRANSPORT_SETTINGS } from './native-tool-transport.mjs';

// Only an admitted outer broker may create/attach this candidate. This helper
// cannot authenticate, select a credential source or authorize network access.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  insistTask(size <= TASK_CAPS.payloadBytes, 'TASK_LIMIT');
  chunks.push(chunk);
}
const submitted = Buffer.concat(chunks);
const envelope = JSON.parse(submitted.toString('utf8'));
const env = nativeEnvironment(validateNativeTaskEnvelope(envelope));
if (envelope.nativeToolTransport) {
  insistTask(Date.now() < envelope.nativeToolTransport.deadlineUnixMs, 'NATIVE_TOOL_TRANSPORT_EXPIRED');
  env.COPILOT_PLUGIN_DIR_ONLY = 'true';
  fs.mkdirSync(envelope.authRoot, { recursive: true });
  insistTask(fs.lstatSync(envelope.authRoot).isDirectory() &&
    !fs.lstatSync(envelope.authRoot).isSymbolicLink(), 'NATIVE_TOOL_TRANSPORT_CONFIG_ROOT_NOT_STERILE');
  for (const name of [
    'settings.json', 'mcp-config.json', 'lsp-config.json', 'providers.json',
    'skills', 'agents', 'hooks', 'extensions', 'installed-plugins', 'plugin-data', 'ide'
  ]) {
    let present = true;
    try { fs.lstatSync(path.join(envelope.authRoot, name)); }
    catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
    insistTask(!present, 'NATIVE_TOOL_TRANSPORT_CONFIG_ROOT_NOT_STERILE');
  }
  fs.writeFileSync(path.join(envelope.authRoot, 'settings.json'),
    JSON.stringify(NATIVE_TOOL_TRANSPORT_SETTINGS), { flag: 'wx', mode: 0o444 });
}
const version = spawnSync(CLI, ['--version'], { env, encoding: 'utf8', timeout: 20000 });
insistTask(version.status === 0 && /^GitHub Copilot CLI 1\.0\.92\./.test(version.stdout) &&
  process.versions.node === '22.22.1', 'NATIVE_RUNTIME_DRIFT');
const seeds = taskSeedFiles(envelope);
const directories = new Set(['/workspace', '/home/eval']);
for (const seed of seeds) {
  fs.mkdirSync(path.dirname(seed.target), { recursive: true });
  fs.writeFileSync(seed.target, seed.content, { flag: 'wx', mode: seed.executable ? 0o555 : 0o444 });
  for (let directory = path.dirname(seed.target);
    directory === '/workspace' || directory.startsWith('/workspace/') ||
    directory === '/home/eval' || directory.startsWith('/home/eval/'); directory = path.dirname(directory)) {
    directories.add(directory);
  }
}
for (const target of envelope.artifactTargets) {
  const filename = `/workspace/${taskPath(target)}`;
  insistTask(!fs.existsSync(filename), 'TASK_SEED_OUTPUT_COLLISION');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  for (let directory = path.dirname(filename); directory === '/workspace' || directory.startsWith('/workspace/');
    directory = path.dirname(directory)) directories.add(directory);
}
for (const directory of directories) fs.chmodSync(directory, 0o555);
for (const target of envelope.artifactTargets) fs.chmodSync(path.dirname(`/workspace/${target}`), 0o700);
const manifest = () => seeds.map(seed => {
  const stat = fs.lstatSync(seed.target);
  return { path: seed.target, bytes: stat.size, sha256: hash(fs.readFileSync(seed.target)),
    readonly: stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o222) === 0 };
});
const before = manifest();
const start = performance.now();
const timeoutMs = envelope.nativeToolTransport
  ? Math.min(envelope.limits.timeoutMs, envelope.nativeToolTransport.deadlineUnixMs - Date.now())
  : envelope.limits.timeoutMs;
insistTask(timeoutMs > 0, 'NATIVE_TOOL_TRANSPORT_EXPIRED');
const child = spawn(CLI, buildCopilotNativeArguments(envelope, {
  model: envelope.model, artifactTargets: envelope.artifactTargets
}), { cwd: '/workspace', env, stdio: ['ignore', 'pipe', 'pipe'] });
const output = { stdout: [], stderr: [] };
let outputBytes = 0, outputLimited = false, timedOut = false;
const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
for (const channel of ['stdout', 'stderr']) child[channel].on('data', chunk => {
  outputBytes += chunk.length;
  if (outputBytes > envelope.limits.nativeOutputBytes) { outputLimited = true; child.kill('SIGKILL'); }
  else output[channel].push(chunk);
});
const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
clearTimeout(timer);
const stdout = Buffer.concat(output.stdout).toString('utf8');
const after = manifest();
let artifactBytes = 0;
const artifacts = envelope.artifactTargets.map(target => {
  const filename = `/workspace/${target}`;
  if (!fs.existsSync(filename)) return { path: target, state: 'missing' };
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > TASK_CAPS.artifactBytes ||
    artifactBytes + stat.size > TASK_CAPS.outputBytes) {
    return { path: target, state: 'error' };
  }
  const bytes = fs.readFileSync(filename);
  artifactBytes += bytes.length;
  return { path: target, state: 'present', bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') };
});
const allowed = new Set([...seeds.map(seed => seed.target),
  ...envelope.artifactTargets.map(target => `/workspace/${target}`)]);
const unauthorizedFiles = [];
function audit(directory) {
  for (const name of fs.readdirSync(directory)) {
    const filename = `${directory}/${name}`;
    const stat = fs.lstatSync(filename);
    if (stat.isDirectory()) audit(filename);
    else if (!allowed.has(filename)) unauthorizedFiles.push(filename);
  }
}
audit('/workspace'); audit('/home/eval');
let usage = null;
const usagePath = '/client-config/usage.json';
if (fs.existsSync(usagePath)) {
  const stat = fs.lstatSync(usagePath);
  if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536) {
    try { usage = JSON.parse(fs.readFileSync(usagePath, 'utf8')); } catch { /* Missing usage stays unavailable. */ }
  }
}
console.log(JSON.stringify({
  source: 'copilot-native-task-bootstrap', client: 'copilot', clientVersion: '1.0.92',
  nodeVersion: process.versions.node, executionId: envelope.executionId,
  submittedStdin: { sha256: hash(submitted), bytes: submitted.length },
  stdout, stderrHash: hash(Buffer.concat(output.stderr)), exitCode, elapsedMs: performance.now() - start,
  outputLimited, timedOut, usage,
  filesystemEvidence: { before, after, artifacts, unauthorizedFiles },
  ...(envelope.nativeToolTransport ? {
    toolTransportPlanningOnly: true, workerArtifactsCaptured: false,
    nativeToolTransportDiscoveryVerified: false, nativeSkillVerified: false
  } : {}),
  authenticationVerified: false, liveAccepted: false
}));
