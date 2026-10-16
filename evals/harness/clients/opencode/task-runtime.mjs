import net from 'node:net';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { BINARY, CLIENT_VERSION } from './index.mjs';
import { createScriptedServer, executeNative } from './scripted-protocol.mjs';
import { auditTaskExecution, buildTaskConfig, observeProviderRequest } from './task-audit.mjs';
import { materializeTaskFiles, collectTaskDiskEvidence } from './task-files.mjs';
import {
  PROJECT, TASK_CAPS,
  buildTaskArguments, buildTaskEnvironment, insist, sha256, taskCalls, taskMarkers, validateNativePayload
} from './task-spec.mjs';

async function readPayload() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    insist(bytes <= 2 * 1024 * 1024, 'Native payload byte cap exceeded');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function networkEvidence() {
  const network = await new Promise(resolve => {
    const socket = net.connect({ host: '192.0.2.1', port: 443 });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve({ externalBlocked: false }); });
    socket.once('error', error => { socket.destroy(); resolve({ externalBlocked: true, errorCode: error.code }); });
    socket.once('timeout', () => { socket.destroy(); resolve({ externalBlocked: true, errorCode: 'TIMEOUT' }); });
  });
  return { ...network, interfaces: Object.keys(os.networkInterfaces()) };
}

let server;
try {
  const payload = await readPayload();
  const spec = validateNativePayload(payload);
  const markers = taskMarkers(payload.executionId);
  materializeTaskFiles(spec, markers);
  const config = buildTaskConfig(spec);
  const env = buildTaskEnvironment(config);
  const versionResult = spawnSync(BINARY, ['--version'], { encoding: 'utf8', env, timeout: 10000, maxBuffer: 128 * 1024 });
  insist(!versionResult.error && versionResult.status === 0 && versionResult.stdout.trim() === CLIENT_VERSION &&
    process.versions.node === '22.22.1', 'Pinned native runtime drift', 'RUNTIME_DRIFT');
  const rg = spawnSync('/usr/local/bin/rg', ['--version'], { encoding: 'utf8', env, timeout: 10000, maxBuffer: 128 * 1024 });
  insist(rg.status === 0 && rg.stdout.startsWith('ripgrep 15.0.0 '), 'Pinned native ripgrep drift', 'RUNTIME_DRIFT');
  const calls = taskCalls(spec);
  const requests = [];
  let discovery;
  const fixture = createScriptedServer({ maxRequestBytes: TASK_CAPS.wireBytes, next(body) {
    const step = requests.length;
    const observed = observeProviderRequest(body, spec, step, payload.executionId);
    requests.push(observed.request);
    if (step === 0) discovery = observed.discovery;
    const call = calls[step];
    return { step, call: call ? [call.tool, call.input] : null, completionText: 'OFFLINE_TASK_COMPLETE' };
  } });
  server = fixture.server;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(43128, '127.0.0.1', resolve);
  });
  const network = await networkEvidence();
  const start = Date.now();
  const native = await executeNative({ binary: BINARY, args: buildTaskArguments(spec, payload.executionId),
    cwd: PROJECT, env, input: spec.prompt, timeoutMs: spec.timeoutMs });
  const elapsedMs = Date.now() - start;
  insist(fixture.errors.length === 0,
    `Scripted native protocol failed: ${[...new Set(fixture.errors)].join('; ')}`, 'AUDIT_INCOMPLETE');
  const disk = collectTaskDiskEvidence(spec, markers);
  auditTaskExecution({ executionId: payload.executionId, spec, native, requests, discovery, network, ...disk });
  console.log(JSON.stringify({
    protocol: 1, executionId: payload.executionId, task: spec.task, clientVersion: versionResult.stdout.trim(),
    versions: { node: process.versions.node, ripgrep: rg.stdout.trim().split('\n')[0] },
    native: { stdout: native.stdout, exitCode: native.exitCode, elapsedMs,
      stderrBytes: Buffer.byteLength(native.stderr), stderrHash: sha256(native.stderr) },
    requests, discovery, network, ...disk, freshWorkspace: true, freshHome: true
  }));
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code ?? 'NATIVE_EXECUTION_INCOMPLETE',
    message: error instanceof SyntaxError ? 'Malformed native payload' : error.message } }));
  process.exitCode = 1;
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
