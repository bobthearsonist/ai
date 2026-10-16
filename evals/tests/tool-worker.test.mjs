import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  issueToolTask, prepareToolWorker, startToolWorker, requestToolWorker, inspectToolWorker,
  captureToolWorkerArtifacts, closeToolWorker, leaseToolWorkerTransport,
  resolveToolWorkerTransportLease, assertToolWorkerTransportBinding, describeToolWorkerTransportBinding,
  TOOL_PROTOCOL, TOOL_CAPS, ToolWorkerError
} from '../harness/tool-worker/index.mjs';
import {
  FilesystemSession, declarations, limits, modelRequest, portablePath, sha256, hashJson,
  taskSocketAcceptor, lineReader
} from '../harness/tool-worker/worker.mjs';
import { attachSupervised } from '../harness/tool-worker/supervision.mjs';
import { exactResourceAbsence } from '../harness/tool-worker/ownership.mjs';
import { McpProtocol, MCP_VERSIONS, serveMcp, transportPolicy } from '../harness/tool-worker/mcp-shim.mjs';
import { describeTransportIdentity } from '../harness/tool-worker/identity.mjs';

const ROOT = fileURLToPath(new URL('../harness/tool-worker/.test-owned/', import.meta.url));
const errorCode = code => error => error?.code === code;
function coords(extra = {}) {
  return { invocationId: randomUUID(), caseId: 'worker-synthetic', client: 'claude-code',
    arm: 'candidate', repeat: 1, ...extra };
}
function prepared(t, extra = {}) {
  const task = issueToolTask(coords());
  const worker = prepareToolWorker({
    task, publicFiles: [{ path: 'skills/pilot/SKILL.md', content: 'public skill' },
      { path: 'inputs/public.txt', content: 'public input' }],
    artifactTargets: ['artifacts/report.txt'], ...extra
  });
  t.after(() => closeToolWorker({ task, worker }));
  return { task, worker };
}
function session(t, extra = {}) {
  fs.mkdirSync(ROOT, { recursive: true });
  const directory = path.join(ROOT, randomUUID());
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: false }));
  return new FilesystemSession({
    root: path.join(directory, 'workspace'), task: coords(),
    publicFiles: [{ path: 'skills/pilot/SKILL.md', contentBase64: Buffer.from('public skill').toString('base64') },
      { path: 'inputs/public.txt', contentBase64: Buffer.from('public input').toString('base64') }],
    artifactTargets: ['artifacts/report.txt'], caps: limits(), ...extra
  });
}
const readPublic = name => ({ op: 'read-public', path: name });
const writeArtifact = text => ({ op: 'write-artifact', path: 'artifacts/report.txt',
  contentBase64: Buffer.from(text).toString('base64') });

test('worker API exports an exact filesystem protocol and permanently false native evidence flags', async t => {
  const handles = prepared(t);
  assert.deepEqual(handles.worker, { kind: 'tool-worker', protocol: TOOL_PROTOCOL });
  assert.equal(handles.worker.directory, undefined);
  assert.equal(handles.worker.pid, undefined);
  assert.equal(handles.worker.containerId, undefined);
  assert.equal(Object.isFrozen(handles.worker), true);
  const clean = await closeToolWorker(handles);
  assert.equal(clean.exactOwnedCleanup, true);
  for (const name of ['authenticationVerified', 'nativeDiscoveryVerified', 'liveAccepted']) {
    assert.equal(clean[name], false);
  }
});

test('original task coordinates are immutable, copied handles and same-coordinate cross-task objects have no authority',
  async t => {
    const source = coords();
    const task = issueToolTask(source);
    source.caseId = 'changed';
    assert.equal(task.coordinates.caseId, 'worker-synthetic');
    const worker = prepareToolWorker({ task, publicFiles: [], artifactTargets: [] });
    t.after(() => closeToolWorker({ task, worker }));
    const other = issueToolTask({ ...task.coordinates });
    for (const forged of [{ ...worker }, JSON.parse(JSON.stringify(worker)),
      structuredClone(worker), { kind: worker.kind, id: randomUUID() }]) {
      await assert.rejects(closeToolWorker({ task, worker: forged }), errorCode('ORIGINAL_WORKER_SCOPE_REQUIRED'));
    }
    await assert.rejects(closeToolWorker({ task: other, worker }), errorCode('ORIGINAL_WORKER_SCOPE_REQUIRED'));
    await assert.rejects(closeToolWorker({ task: { ...task }, worker }), errorCode('ORIGINAL_TASK_REQUIRED'));
    assert.throws(() => prepareToolWorker({ task, publicFiles: [], artifactTargets: [] }),
      errorCode('TASK_WORKER_ALREADY_ISSUED'));
  });

test('lifecycle prevents requests, leases and inspection before start and after exact prepared cleanup', async t => {
  const original = prepared(t);
  for (const operation of [inspectToolWorker(original), captureToolWorkerArtifacts(original),
    leaseToolWorkerTransport(original), requestToolWorker({ ...original, request: readPublic('inputs/public.txt') })]) {
    await assert.rejects(operation, errorCode('WORKER_NOT_READY'));
  }
  await closeToolWorker(original);
  await assert.rejects(startToolWorker(original), errorCode('WORKER_CLOSED'));
  await assert.rejects(resolveToolWorkerTransportLease({ ...original,
    lease: { kind: 'tool-worker-transport-lease', protocol: TOOL_PROTOCOL } }), errorCode('WORKER_CLOSED'));
});

test('strict inputs exclude private grading/auth/config/environment/image/assertion metadata without echoing values',
  async t => {
    const task = issueToolTask(coords());
    const secret = 'SYNTHETIC_NOT_A_REAL_CREDENTIAL';
    for (const field of ['checks', 'expected', 'credentials', 'authenticationVerified', 'liveAccepted',
      'nativeDiscoveryVerified', 'env', 'url', 'image', 'imageId', 'pid', 'directory', 'containerName', 'tags']) {
      assert.throws(() => prepareToolWorker({
        task, publicFiles: [], artifactTargets: [], [field]: secret
      }), error => error.code === 'INVALID_FIELDS' && !error.message.includes(secret));
    }
    for (const field of ['source', 'directory', 'mountRoot', 'executable', 'symlink', 'hardlink', 'expected', 'checks']) {
      assert.throws(() => prepareToolWorker({
        task, publicFiles: [{ path: 'inputs/public.txt', content: 'public', [field]: secret }],
        artifactTargets: []
      }), errorCode('INVALID_FIELDS'));
    }
    assert.throws(() => issueToolTask(coords({ fixtureHash: 'a'.repeat(64) })), errorCode('INVALID_FIELDS'));
    const accessor = { path: 'inputs/public.txt' };
    Object.defineProperty(accessor, 'content', { enumerable: true, get() { throw new Error(secret); } });
    assert.throws(() => declarations([accessor], [], limits()), errorCode('INVALID_FIELDS'));
    const original = prepared(t);
    await assert.rejects(requestToolWorker({ ...original, request: {
      ...readPublic('inputs/public.txt'), expected: secret
    } }), errorCode('INVALID_FIELDS'));
    await assert.rejects(assertToolWorkerTransportBinding({ ...original,
      lease: {}, binding: { mount: secret } }), errorCode('ORIGINAL_TRANSPORT_LEASE_REQUIRED'));
  });

test('portable paths reject traversal, absolute roots, aliases, reserved devices and private/config/proc/socket namespaces',
  () => {
    for (const value of ['../escape', 'inputs/../escape', 'inputs//a', 'inputs/a/./b', '/etc/passwd',
      'C:\\Users\\anything', 'inputs\\public.txt', 'inputs/a.', 'inputs/a ', 'inputs/NUL.txt',
      'Inputs/a', 'inputs/a%2fb', 'inputs/a:b', 'inputs/a?b', 'inputs/é.txt', 'inputs/.env',
      'inputs/private/answer.txt', 'inputs/judge/key.txt', 'inputs/expected.txt',
      'inputs/checks.json', 'inputs/.claude/settings.json', 'inputs/config/a', 'inputs/mcp.json',
      'inputs/AGENTS.md', 'inputs/CLAUDE.md', 'inputs/proc/self/environ', 'inputs/docker.sock',
      'inputs/auth.json', 'inputs/credentials.txt', 'artifacts/.config/opencode.json']) {
      assert.throws(() => portablePath(value, ['inputs', 'skills', 'artifacts']), errorCode('INVALID_PATH'), value);
    }
    assert.throws(() => declarations([{ path: 'inputs/a/x', content: 'x' },
      { path: 'inputs/A/y', content: 'y' }], [], limits()), errorCode('PATH_ALIAS'));
    assert.throws(() => declarations([{ path: 'inputs/a', content: 'x' },
      { path: 'inputs/a/b', content: 'y' }], [], limits()), errorCode('PATH_COLLISION'));
    assert.throws(() => declarations([], ['artifacts/a', 'artifacts/a'], limits()),
      errorCode('PATH_COLLISION'));
  });

test('selected bytes are copied, sources/targets are distinct, and the protocol has no code/shell/plugin/eval execution',
  () => {
    const content = Buffer.from('copied');
    const selected = declarations([{ path: 'skills/pilot/resource.mjs', content }], ['artifacts/report.txt'], limits());
    content.fill(0);
    assert.equal(selected.files[0].content.toString(), 'copied');
    assert.throws(() => declarations([], ['inputs/public.txt'], limits()), errorCode('INVALID_PATH'));
    assert.throws(() => declarations([{ path: 'artifacts/report.txt', content: 'bad' }], [], limits()),
      errorCode('INVALID_PATH'));
    for (const op of ['shell', 'eval', 'exec', 'plugin', 'config', 'link', 'diagnostics', 'capture']) {
      assert.throws(() => modelRequest({ op, path: 'inputs/public.txt' }, limits()), errorCode('UNKNOWN_TOOL'));
    }
    assert.throws(() => modelRequest({ op: 'write-artifact', path: 'artifacts/report.txt',
      contentBase64: 'Zg=' }, limits()), errorCode('INVALID_CONTENT'));
    assert.throws(() => modelRequest({ op: 'read-public', path: 'inputs/public.txt', contentBase64: '' }, limits()),
      errorCode('INVALID_FIELDS'));
  });

test('public read and declared write/readback use actual on-disk bytes; capture does not grade or assert Skill discovery', t => {
  const worker = session(t);
  const read = worker.execute(readPublic('skills/pilot/SKILL.md'));
  assert.equal(read.ok, true);
  assert.equal(Buffer.from(read.result.contentBase64, 'base64').toString(), 'public skill');
  assert.equal(read.nativeDiscoveryVerified, false);
  const write = worker.execute(writeArtifact('output bytes'));
  assert.equal(write.ok, true);
  assert.equal(write.result.sha256, sha256('output bytes'));
  fs.writeFileSync(worker.filename('artifacts/report.txt'), 'actual disk bytes');
  const captured = worker.capture();
  assert.equal(Buffer.from(captured.artifacts[0].contentBase64, 'base64').toString(), 'actual disk bytes');
  assert.equal(captured.artifacts[0].sha256, sha256('actual disk bytes'));
  assert.equal(captured.artifacts[0].expected, undefined);
  assert.equal(captured.authenticationVerified, false);
  assert.equal(worker.events.length, 2);
});

test('undeclared public reads, target writes, source modification and missing artifacts have explicit outcomes', t => {
  const worker = session(t);
  assert.equal(worker.execute(readPublic('inputs/not-selected.txt')).code, 'UNDECLARED_PUBLIC');
  assert.equal(worker.execute({ ...writeArtifact('bad'), path: 'artifacts/undeclared.txt' }).code,
    'UNDECLARED_ARTIFACT');
  assert.equal(worker.execute({ op: 'read-artifact', path: 'artifacts/report.txt' }).code, 'ARTIFACT_MISSING');
  fs.chmodSync(worker.filename('inputs/public.txt'), 0o600);
  fs.writeFileSync(worker.filename('inputs/public.txt'), 'tampered');
  assert.equal(worker.execute(readPublic('inputs/public.txt')).code, 'PUBLIC_CHANGED');
  const captured = worker.capture();
  assert.deepEqual(captured.missing, ['artifacts/report.txt']);
});

test('actual hardlinks and directory symlinks/junctions in local protocol fixtures are rejected, not imported', t => {
  const worker = session(t);
  const source = path.join(path.dirname(worker.root), 'outside.txt');
  fs.writeFileSync(source, 'outside public synthetic bytes');
  fs.linkSync(source, worker.filename('artifacts/report.txt'));
  assert.equal(worker.execute({ op: 'read-artifact', path: 'artifacts/report.txt' }).code, 'LINK_OR_FILE_LIMIT');
  assert.equal(worker.execute(writeArtifact('overwrite')).code, 'LINK_DENIED');
  fs.unlinkSync(worker.filename('artifacts/report.txt'));
  fs.rmdirSync(path.join(worker.root, 'artifacts'));
  const outside = path.join(path.dirname(worker.root), 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'report.txt'), 'synthetic');
  fs.symlinkSync(outside, path.join(worker.root, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(worker.execute({ op: 'read-artifact', path: 'artifacts/report.txt' }).code, 'LINK_DENIED');
  assert.equal(worker.execute(writeArtifact('overwrite')).code, 'LINK_DENIED');
});

test('file/source/target counts, byte limits, exact downward-only quotas and artifact write budgets are bounded', t => {
  assert.throws(() => limits({ requests: TOOL_CAPS.requests + 1 }), errorCode('INVALID_LIMITS'));
  assert.throws(() => limits({ unknown: 1 }), errorCode('INVALID_FIELDS'));
  assert.throws(() => declarations([{ path: 'inputs/a', content: 'abc' }], [], limits({ fileBytes: 2 })),
    errorCode('FILE_LIMIT'));
  assert.throws(() => declarations([{ path: 'inputs/a', content: 'abc' },
    { path: 'inputs/b', content: 'def' }], [], limits({ sourceBytes: 5 })), errorCode('SOURCE_LIMIT'));
  assert.throws(() => declarations([{ path: 'inputs/a', content: '' },
    { path: 'inputs/b', content: '' }], [], limits({ files: 1 })), errorCode('FILE_COUNT_LIMIT'));
  assert.throws(() => declarations([], ['artifacts/a', 'artifacts/b'], limits({ targets: 1 })),
    errorCode('FILE_COUNT_LIMIT'));
  const worker = session(t, { caps: limits({ artifactBytes: 3 }) });
  assert.equal(worker.execute(writeArtifact('abc')).ok, true);
  assert.equal(worker.execute(writeArtifact('x')).code, 'ARTIFACT_LIMIT');
});

test('request count, request bytes, total bytes, output budget and deadline denials are explicit', async t => {
  const counted = session(t, { caps: limits({ requests: 1 }) });
  assert.equal(counted.execute(readPublic('inputs/public.txt')).ok, true);
  assert.throws(() => counted.execute(readPublic('inputs/public.txt')), errorCode('REQUEST_COUNT_LIMIT'));
  const requestLimited = session(t, { caps: limits({ requestBytes: 1 }) });
  assert.throws(() => requestLimited.execute(readPublic('inputs/public.txt')), errorCode('REQUEST_LIMIT'));
  const totalLimited = session(t, { caps: limits({ totalRequestBytes: 70 }) });
  assert.equal(totalLimited.execute(readPublic('inputs/public.txt')).ok, true);
  assert.throws(() => totalLimited.execute(readPublic('inputs/public.txt')), errorCode('REQUEST_LIMIT'));
  const outputLimited = session(t, { caps: limits({ outputBytes: 1 }) });
  assert.throws(() => outputLimited.execute(readPublic('inputs/public.txt')), errorCode('OUTPUT_LIMIT'));
  const deadline = session(t, { caps: limits({ timeoutMs: 10 }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.throws(() => deadline.execute(readPublic('inputs/public.txt')), errorCode('TIMEOUT'));
});

function supervisedFixture(t, { signal, script = 'setInterval(() => {}, 1000)', ms = 1000, cap = 4096 } = {}) {
  let observed;
  const failed = new Promise(resolve => { observed = resolve; });
  const attachment = attachSupervised(process.execPath, ['-e', script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {},
    deadline: Date.now() + ms, signal, outputBytes: cap, scope: 'a'.repeat(64),
    onFailure: observed
  });
  t.after(() => attachment.stop());
  return { attachment, failed };
}
test('deadline and cancellation force-kill the owned attached process and await exact process closure', async t => {
  const deadline = supervisedFixture(t, { ms: 100 });
  assert.equal((await deadline.failed).code, 'TIMEOUT');
  assert.equal((await deadline.attachment.stop()).processClosed, true);
  const controller = new AbortController();
  const cancellation = supervisedFixture(t, { signal: controller.signal });
  controller.abort();
  assert.equal((await cancellation.failed).code, 'CANCELLED');
  const cleanup = await cancellation.attachment.stop();
  assert.equal(cleanup.forced, true);
  assert.equal(cleanup.processClosed, true);
});
test('actual subprocess stdout caps stop an uncooperative producer, without treating this as Docker/native proof', async t => {
  const fixture = supervisedFixture(t, {
    script: "process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000)", cap: 64
  });
  assert.equal((await fixture.failed).code, 'OUTPUT_LIMIT');
  assert.equal((await fixture.attachment.stop()).processClosed, true);
});
test('already cancelled start performs only original prepared cleanup, not Docker or authentication', async t => {
  const original = prepared(t);
  const controller = new AbortController();
  controller.abort();
  // Prepared cleanup is a resource-free path; cancelled starts must not consult Docker.
  await assert.rejects(startToolWorker({ ...original, signal: controller.signal }), errorCode('CANCELLED'));
  const cleanup = await closeToolWorker(original);
  assert.equal(cleanup.ownedDirectoryRemoved, true);
});
test('Docker absence checks accept actual lowercase diagnostics but never wrong identities, codes or arbitrary failures', () => {
  const identity = 'a'.repeat(64);
  assert.equal(exactResourceAbsence({
    exitCode: 1, stdout: '[]\n', stderr: `error: no such object: ${identity}\n`
  }, 'container', identity), true);
  assert.equal(exactResourceAbsence({
    exitCode: 1, stdout: '[]\n',
    stderr: 'Error response from daemon: get eval-tool-socket-test: no such volume\n'
  }, 'volume', 'eval-tool-socket-test'), true);
  for (const result of [
    { exitCode: 0, stdout: '', stderr: `Error: No such object: ${identity}` },
    { exitCode: 1, stdout: '[{"Id":"foreign"}]', stderr: `Error: No such object: ${identity}` },
    { exitCode: 1, stdout: '[]', stderr: 'error: no such object: foreign' },
    { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' },
    { exitCode: 1, stdout: '', stderr: `Error: No such object: ${identity}\npermission denied` }
  ]) assert.equal(exactResourceAbsence(result, 'container', identity), false);
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function mcpPolicy(ms = 3000, extra = {}) {
  return { deadlineUnixMs: Date.now() + ms, requests: 64, requestBytes: 32768,
    totalRequestBytes: 262144, outputBytes: 524288, ...extra };
}
function initialization(extra = {}) {
  return {
    protocolVersion: '2025-06-18',
    capabilities: {
      roots: { listChanged: true }, sampling: { context: {}, tools: {} },
      elicitation: { form: {}, url: {} },
      tasks: { list: {}, cancel: {}, requests: { sampling: { createMessage: {} }, elicitation: { create: {} } } },
      experimental: {
        'example.invalid/inert': { values: ['metadata', true, 1, null] },
        scalarAdvertisement: true, arrayAdvertisement: [null, ['inert', { number: 1 }]]
      }
    },
    clientInfo: {
      name: 'Synthetic Native Client (MCP conformance)', version: '1.2.3+test',
      title: '合成 • SYNTHETIC_METADATA_NOT_FORWARDED',
      description: 'Inert implementation metadata; not a native client.',
      websiteUrl: 'https://metadata.invalid/client',
      icons: [{ src: 'data:image/svg+xml;base64,PHN2Zy8+', mimeType: 'image/svg+xml',
        sizes: ['48x48', 'any'], theme: 'light' }]
    },
    ...extra
  };
}
function protocolFixture(extra = {}) {
  let workerCalls = 0;
  const protocol = new McpProtocol({
    scope: 'a'.repeat(64), policy: mcpPolicy(),
    requestWorker: async () => { workerCalls++; throw new Error('Undeclared worker call'); }, ...extra
  });
  let id = 0;
  return { protocol, call: (method, params, fields = {}) =>
    protocol.dispatch({ jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }), ...fields }),
  get workerCalls() { return workerCalls; } };
}
test('MCP initialize accepts bounded standard nonempty capabilities and implementation metadata inertly', async () => {
  const fixture = protocolFixture();
  const initialized = await fixture.call('initialize', initialization());
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(initialized.result.serverInfo, { name: 'eval-filesystem-worker', version: '1.0.0' });
  assert.equal(JSON.stringify(initialized).includes('SYNTHETIC_METADATA_NOT_FORWARDED'), false);
  assert.equal(fixture.protocol.clientInfo, undefined);
  assert.equal(fixture.protocol.capabilities, undefined);
  assert.deepEqual((await fixture.call('ping')).result, {});
  assert.equal(fixture.workerCalls, 0);
});
test('MCP negotiates only explicit supported versions, including an explicit older-version response to a newer offer', async () => {
  for (const version of MCP_VERSIONS) {
    const fixture = protocolFixture();
    assert.equal((await fixture.call('initialize', initialization({ protocolVersion: version }))).result.protocolVersion,
      version);
  }
  const newer = protocolFixture();
  assert.equal((await newer.call('initialize', initialization({ protocolVersion: '2025-11-25' }))).result.protocolVersion,
    '2025-06-18');
  for (const version of ['latest', '2025-13-01', '2025-02-31', null, 2025]) {
    const fixture = protocolFixture();
    const response = await fixture.call('initialize', initialization({ protocolVersion: version }));
    assert.equal(response.error.code, -32602);
    assert.equal(response.result, undefined);
  }
});
test('MCP metadata/capability shapes and sizes reject unknown action fields without echoing raw metadata', async () => {
  const invalid = [
    { capabilities: { roots: { listChanged: 'yes' } } },
    { capabilities: { roots: { roots: ['file:///private'] } } },
    { capabilities: { sampling: { shell: {} } } },
    { capabilities: { tasks: { requests: { tools: { call: {} } } } } },
    { capabilities: { undeclaredFeature: {} } },
    { capabilities: { experimental: { extension: { text: 'x'.repeat(4097) } } } },
    { capabilities: { experimental: { extension: { a: { b: { c: { d: { e: {} } } } } } } } },
    { clientInfo: { name: 'name', version: 'version', env: { SYNTHETIC_METADATA_NOT_FORWARDED: 'secret' } } },
    { clientInfo: { name: 'x'.repeat(129), version: '1' } },
    { clientInfo: { name: 'name', version: '1', icons: Array.from({ length: 5 }, () => ({ src: 'https://icons.invalid/a' })) } },
    { clientInfo: { name: 'name', version: '1', icons: [{ src: 'file:///private/icon.png' }] } },
    { clientInfo: { name: 'name', version: '1', websiteUrl: 'https://user:password@metadata.invalid' } },
    { action: 'execute' }, { env: {} }, { _meta: { private: 'not-supported' } }
  ];
  for (const override of invalid) {
    const fixture = protocolFixture();
    const response = await fixture.call('initialize', initialization(override));
    assert.equal(response.error.code, -32602);
    assert.equal(response.result, undefined);
    assert.equal(JSON.stringify(response).includes('SYNTHETIC_METADATA_NOT_FORWARDED'), false);
    assert.equal(fixture.workerCalls, 0);
  }
});
test('advertised client features never enable roots/sampling/elicitation/tasks or loose method/action success', async () => {
  const fixture = protocolFixture();
  await fixture.call('initialize', initialization());
  for (const method of ['roots/list', 'sampling/createMessage', 'elicitation/create', 'tasks/list', 'tasks/cancel',
    'resources/read', 'prompts/list', 'logging/setLevel', 'shell', 'unknown/method']) {
    assert.equal((await fixture.call(method, {})).error.code, -32601);
  }
  assert.equal((await fixture.call('tools/call', {
    name: 'eval_read_public', arguments: { path: 'inputs/public.txt' }, task: { ttl: 1000 }
  })).error.code, -32602);
  assert.equal((await fixture.call('tools/list', { action: 'refresh' })).error.code, -32602);
  assert.equal((await fixture.call('tools/list', undefined, { action: 'execute' })).error.code, -32600);
  await assert.rejects(fixture.protocol.dispatch({
    jsonrpc: '2.0', method: 'notifications/roots/list_changed'
  }), errorCode('UNSUPPORTED_NOTIFICATION'));
  assert.equal(fixture.workerCalls, 0);
});

async function mcpPipeFixture(t, { lifetimeMs = 3000, shimDelayMs = 0, withhold = false, policyExtra = {} } = {}) {
  fs.mkdirSync(ROOT, { recursive: true });
  const nonce = randomUUID();
  const directory = path.join(ROOT, `mcp-${nonce}`);
  fs.mkdirSync(directory);
  const policy = mcpPolicy(lifetimeMs, policyExtra);
  const scope = 'b'.repeat(64);
  const worker = new FilesystemSession({
    root: path.join(directory, 'workspace'), task: coords(),
    publicFiles: [{ path: 'inputs/public.txt', contentBase64: Buffer.from('public input').toString('base64') }],
    artifactTargets: ['artifacts/report.txt'], caps: limits({ timeoutMs: lifetimeMs }),
    deadline: policy.deadlineUnixMs
  });
  const address = process.platform === 'win32'
    ? String.raw`\\.\pipe\eval-worker-mcp-test-${nonce}` : path.join(directory, 'rpc.sock');
  const sockets = new Set();
  const envelopes = [];
  let connections = 0, shim, serverClose, observedRequest;
  const firstRequest = new Promise(resolve => { observedRequest = resolve; });
  const server = net.createServer(taskSocketAcceptor(worker, (record, socket) => {
    assert.equal(record.protocol, TOOL_PROTOCOL);
    assert.equal(record.scope, scope);
    envelopes.push(record);
    observedRequest(record);
    if (withhold) return;
    const response = worker.execute(record.request);
    socket.write(`${JSON.stringify({ protocol: TOOL_PROTOCOL, scope, sequence: record.sequence, ...response })}\n`);
  }, () => {
    for (const socket of sockets) socket.destroy();
  }, sockets));
  function closeServer() {
    serverClose ??= new Promise((resolve, reject) => server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve();
    }));
    return serverClose;
  }
  const waiting = new Map();
  const input = new PassThrough(), output = new PassThrough();
  let id = 0;
  t.after(async () => {
    const socketClosures = [...sockets].map(socket =>
      new Promise(resolve => socket.once('close', resolve)));
    await shim?.stop('EOF');
    for (const socket of sockets) socket.destroy();
    await Promise.all(socketClosures);
    await closeServer();
    assert.equal(sockets.size, 0);
    fs.rmSync(directory, { recursive: true, force: false });
    assert.equal(fs.existsSync(directory), false);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
  if (shimDelayMs) await pause(shimDelayMs);
  shim = serveMcp({
    input, output, scope, policy,
    connectSocket: () => { connections++; return net.createConnection(address); }
  });
  lineReader(output, () => 32768, record => {
    const pending = waiting.get(record.id);
    assert.ok(pending);
    waiting.delete(record.id);
    pending.resolve(record);
  }, error => { for (const value of waiting.values()) value.reject(error); waiting.clear(); });
  shim.closed.then(outcome => {
    for (const value of waiting.values()) value.reject(new ToolWorkerError(outcome.code));
    waiting.clear();
  });
  return {
    shim, input, output, worker, policy, envelopes, firstRequest, sockets, address,
    get connections() { return connections; },
    rpc(method, params) {
      const requestId = ++id;
      const response = new Promise((resolve, reject) => waiting.set(requestId, { resolve, reject }));
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method,
        ...(params === undefined ? {} : { params }) })}\n`);
      response.requestId = requestId;
      return response;
    }
  };
}
const publicTool = { name: 'eval_read_public', arguments: { path: 'inputs/public.txt' } };
test('actual local MCP connection survives >10 seconds idle and reuses the original task socket (not native proof)',
  { timeout: 20000 }, async t => {
    const fixture = await mcpPipeFixture(t, { lifetimeMs: 15000 });
    await fixture.rpc('initialize', initialization());
    const first = await fixture.rpc('tools/call', publicTool);
    assert.equal(JSON.parse(first.result.content[0].text).ok, true);
    const originalDeadline = fixture.worker.deadline;
    assert.throws(() => { fixture.worker.deadline = Date.now() + 60000; }, TypeError);
    await pause(10500);
    const second = await fixture.rpc('tools/call', publicTool);
    const bytes = JSON.parse(second.result.content[0].text);
    assert.equal(bytes.ok, true);
    assert.equal(bytes.authenticationVerified, false);
    assert.equal(bytes.nativeDiscoveryVerified, false);
    assert.equal(bytes.liveAccepted, false);
    assert.equal(fixture.connections, 1);
    assert.equal(fixture.worker.deadline, originalDeadline);
    assert.equal(fixture.policy.deadlineUnixMs, originalDeadline);
    assert.equal(JSON.stringify(fixture.envelopes).includes('SYNTHETIC_METADATA_NOT_FORWARDED'), false);
  });
test('idle/ping/activity never extends the original deadline; actual local socket cleanup is awaited', async t => {
  const fixture = await mcpPipeFixture(t, { lifetimeMs: 900 });
  await fixture.rpc('initialize', initialization());
  await fixture.rpc('tools/call', publicTool);
  await pause(Math.max(0, fixture.policy.deadlineUnixMs - Date.now() - 150));
  assert.deepEqual((await fixture.rpc('ping')).result, {});
  const outcome = await fixture.shim.closed;
  assert.equal(outcome.code, 'TIMEOUT');
  assert.equal(outcome.socketClosed, true);
  assert.ok(Date.now() >= fixture.policy.deadlineUnixMs);
  assert.ok(Date.now() < fixture.policy.deadlineUnixMs + 1000);
});
test('starting the shim late uses only remaining original lifetime, not a fresh transport timeout', async t => {
  const fixture = await mcpPipeFixture(t, { lifetimeMs: 700, shimDelayMs: 300 });
  await fixture.rpc('initialize', initialization());
  await fixture.rpc('tools/call', publicTool);
  const outcome = await fixture.shim.closed;
  assert.equal(outcome.code, 'TIMEOUT');
  assert.equal(outcome.socketClosed, true);
  assert.ok(Date.now() < fixture.policy.deadlineUnixMs + 250);
});
test('standard cancellation of the original active request closes and awaits the actual local socket', async t => {
  const fixture = await mcpPipeFixture(t, { withhold: true });
  await fixture.rpc('initialize', initialization());
  const request = fixture.rpc('tools/call', publicTool);
  const rejected = assert.rejects(request, errorCode('CANCELLED'));
  await fixture.firstRequest;
  fixture.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled',
    params: { requestId: request.requestId, reason: 'synthetic cancellation' } })}\n`);
  const outcome = await fixture.shim.closed;
  await rejected;
  assert.equal(outcome.code, 'CANCELLED');
  assert.equal(outcome.socketClosed, true);
});
test('an active local request is forcibly disconnected at the original deadline, not a renewed operation timeout', async t => {
  const fixture = await mcpPipeFixture(t, { lifetimeMs: 500, withhold: true });
  await fixture.rpc('initialize', initialization());
  const rejection = assert.rejects(fixture.rpc('tools/call', publicTool), errorCode('TIMEOUT'));
  await fixture.firstRequest;
  const outcome = await fixture.shim.closed;
  await rejection;
  assert.equal(outcome.code, 'TIMEOUT');
  assert.equal(outcome.socketClosed, true);
});
test('already-aborted MCP lifetime stops without connecting or importing caller transport controls', async () => {
  const controller = new AbortController();
  controller.abort();
  const input = new PassThrough(), output = new PassThrough();
  const shim = serveMcp({ input, output, scope: 'c'.repeat(64), policy: mcpPolicy(),
    signal: controller.signal, connectSocket: () => { throw new Error('Unexpected connection'); } });
  assert.equal((await shim.closed).code, 'CANCELLED');
  assert.equal(input.destroyed, true);
});
test('an original task socket cannot be renewed by a replacement connection after the first shim closes', async t => {
  const fixture = await mcpPipeFixture(t);
  await fixture.rpc('initialize', initialization());
  await fixture.rpc('tools/call', publicTool);
  const remoteClosures = [...fixture.sockets].map(socket => new Promise(resolve => socket.once('close', resolve)));
  await fixture.shim.stop('EOF');
  await Promise.all(remoteClosures);
  const replacement = net.createConnection(fixture.address);
  const closed = new Promise(resolve => replacement.once('close', resolve));
  let replacementError;
  replacement.on('error', error => { replacementError = error.code; });
  await closed;
  assert.ok(replacementError === undefined || ['ECONNRESET', 'EPIPE'].includes(replacementError));
  assert.equal(replacement.destroyed, true);
  assert.equal(fixture.worker.stats.requests, 1);
});
test('MCP uses original request/output caps, rejects policy overrides and does not reset budgets per call', async t => {
  assert.throws(() => transportPolicy({ ...mcpPolicy(), deadline: Date.now() + 1000 }),
    errorCode('INVALID_TRANSPORT_POLICY'));
  assert.throws(() => transportPolicy(mcpPolicy(70000)), errorCode('INVALID_TRANSPORT_POLICY'));
  const requests = await mcpPipeFixture(t, { policyExtra: { requests: 1 } });
  await requests.rpc('initialize', initialization());
  await requests.rpc('tools/call', publicTool);
  await assert.rejects(requests.rpc('tools/call', publicTool), errorCode('REQUEST_COUNT_LIMIT'));
  assert.equal((await requests.shim.closed).socketClosed, true);
  const output = await mcpPipeFixture(t, { policyExtra: { outputBytes: 300 } });
  await output.rpc('initialize', initialization());
  await assert.rejects(output.rpc('tools/list'), errorCode('OUTPUT_LIMIT'));
  assert.equal((await output.shim.closed).socketClosed, true);
  const ingress = await mcpPipeFixture(t, { policyExtra: { requestBytes: 100 } });
  await assert.rejects(ingress.rpc('initialize', initialization()), errorCode('REQUEST_LIMIT'));
  assert.equal((await ingress.shim.closed).socketClosed, true);
  const total = await mcpPipeFixture(t, { policyExtra: { totalRequestBytes: 100 } });
  await assert.rejects(total.rpc('initialize', initialization()), errorCode('REQUEST_LIMIT'));
  assert.equal((await total.shim.closed).socketClosed, true);
});

function identityFixture(registry = { tasks: new WeakMap(), workers: new WeakMap(),
  leases: new WeakMap(), bindings: new WeakMap() }) {
  const coordinates = Object.freeze(coords());
  const task = Object.freeze({ kind: 'unit-task', coordinates });
  const worker = Object.freeze({ kind: 'unit-worker' });
  const lease = Object.freeze({ kind: 'unit-lease' });
  const transport = Object.freeze({ type: 'volume', source: 'unit-owned-volume', target: '/tool-rpc',
    readOnly: true, noCopy: true });
  const binding = Object.freeze({ kind: 'unit-binding', workerProgramHash: 'a'.repeat(64),
    shimHash: 'b'.repeat(64), transportMount: transport, stdioCommand: Object.freeze(['fixed-unit-code']) });
  const state = {
    task, taskHash: hashJson(coordinates), taskCoordinates: coordinates, sourceHash: 'c'.repeat(64),
    selected: { files: [{ path: 'inputs/public.txt', bytes: 6, sha256: sha256('public'), content: Buffer.from('public') }],
      targets: ['artifacts/report.txt'] }, caps: limits(), lifecycle: 'ready', deadline: Date.now() + 3000,
    lease, binding, cleanupPromise: null, terminalError: null, runController: new AbortController()
  };
  registry.tasks.set(task, { hash: state.taskHash });
  registry.workers.set(worker, state);
  registry.leases.set(lease, { state, task, worker });
  registry.bindings.set(binding, { state, lease });
  return { registry, tuple: { task, worker, lease, binding }, state };
}
test('synchronous cached original identity rejects clones/crossbindings/revocation/expiry without claiming kernel admission', t => {
  const first = identityFixture();
  const second = identityFixture(first.registry);
  const describe = tuple => describeTransportIdentity(first.registry, tuple);
  for (const [field, code] of [['task', 'ORIGINAL_TASK_REQUIRED'], ['worker', 'ORIGINAL_WORKER_SCOPE_REQUIRED'],
    ['lease', 'ORIGINAL_TRANSPORT_LEASE_REQUIRED'], ['binding', 'ORIGINAL_TRANSPORT_BINDING_REQUIRED']]) {
    assert.throws(() => describe({ ...first.tuple, [field]: { ...first.tuple[field] } }), errorCode(code));
  }
  assert.throws(() => describe({ ...first.tuple, binding: second.tuple.binding }),
    errorCode('ORIGINAL_TRANSPORT_BINDING_REQUIRED'));
  assert.throws(() => describe({ ...first.tuple, task: second.tuple.task }), errorCode('ORIGINAL_WORKER_SCOPE_REQUIRED'));
  first.state.deadline = Date.now() - 1;
  assert.throws(() => describe(first.tuple), errorCode('TIMEOUT'));
  first.state.deadline = Date.now() + 3000;
  first.state.lifecycle = 'closing';
  assert.throws(() => describe(first.tuple), errorCode('WORKER_NOT_READY'));
  first.state.lifecycle = 'closed';
  assert.throws(() => describe(first.tuple), errorCode('WORKER_NOT_READY'));
  first.state.lifecycle = 'ready';
  first.state.cleanupPromise = Promise.resolve();
  assert.throws(() => describe(first.tuple), errorCode('WORKER_NOT_READY'));
  first.state.cleanupPromise = null;
  first.state.terminalError = new ToolWorkerError('CANCELLED');
  assert.throws(() => describe(first.tuple), errorCode('CANCELLED'));
  first.state.terminalError = null;
  first.state.runController.abort();
  assert.throws(() => describe(first.tuple), errorCode('WORKER_NOT_READY'));
  const original = prepared(t);
  const read = t.mock.method(fs, 'readFileSync', () => { throw new Error('Unexpected planning IO'); });
  assert.throws(() => describeToolWorkerTransportBinding({ ...original, lease: {}, binding: {} }),
    errorCode('ORIGINAL_TRANSPORT_LEASE_REQUIRED'));
  assert.equal(read.mock.callCount(), 0);
  read.mock.restore();
});
test('cached planning descriptions copy metadata and targets but retain only the original immutable transport reference', () => {
  const fixture = identityFixture();
  const first = describeTransportIdentity(fixture.registry, fixture.tuple);
  assert.equal(first.binding, fixture.tuple.binding);
  assert.equal(first.planningOnly, true);
  assert.equal(first.freshKernelVerification, false);
  assert.equal(first.nativeAdmissionSupported, false);
  for (const key of ['authenticationVerified', 'nativeDiscoveryVerified', 'liveAccepted']) assert.equal(first[key], false);
  assert.deepEqual(Object.keys(first.publicFiles[0]).sort(), ['bytes', 'path', 'sha256']);
  assert.equal(first.directory, undefined);
  first.task.caseId = 'modified';
  first.publicFiles[0].path = 'inputs/modified.txt';
  first.artifactTargets[0] = 'artifacts/modified.txt';
  first.limits.requests = 1;
  const next = describeTransportIdentity(fixture.registry, fixture.tuple);
  assert.equal(next.task.caseId, fixture.state.taskCoordinates.caseId);
  assert.equal(next.publicFiles[0].path, 'inputs/public.txt');
  assert.equal(next.artifactTargets[0], 'artifacts/report.txt');
  assert.equal(next.limits.requests, 64);
  assert.equal(next.transportBindingHash, first.transportBindingHash);
  assert.throws(() => { next.binding.transportMount.source = 'caller-volume'; }, TypeError);
});
test('prepare transaction rolls back every tested post-allocation phase, including a partial marker write', async t => {
  const root = fileURLToPath(new URL('../harness/tool-worker/.owned/', import.meta.url));
  const before = fs.readdirSync(root).sort();
  const originalWrite = fs.writeFileSync, originalMkdir = fs.mkdirSync, originalStat = fs.lstatSync;
  for (const phase of ['marker', 'config', 'allocation-stat']) {
    let injected = false;
    const fail = () => { injected = true; throw Object.assign(new Error('Synthetic IO failure'), { code: 'EIO' }); };
    const isNonce = filename => typeof filename === 'string' && filename.startsWith(path.join(root, 'worker-'));
    const write = t.mock.method(fs, 'writeFileSync', (filename, bytes, options) => {
      if (!injected && phase === 'marker' && isNonce(filename) && filename.endsWith('.owner.json')) {
        originalWrite(filename, bytes.subarray(0, 3), options);
        fail();
      }
      return originalWrite(filename, bytes, options);
    });
    const mkdir = t.mock.method(fs, 'mkdirSync', (filename, options) => {
      if (!injected && phase === 'config' && isNonce(filename) && filename.endsWith('docker-config')) fail();
      return originalMkdir(filename, options);
    });
    const stat = t.mock.method(fs, 'lstatSync', filename => {
      if (!injected && phase === 'allocation-stat' && isNonce(filename)) fail();
      return originalStat(filename);
    });
    const task = issueToolTask(coords());
    assert.throws(() => prepareToolWorker({ task, publicFiles: [], artifactTargets: [] }),
      error => error.code === 'OWNED_PREPARATION_FAILED' && error.cleanup.ownedDirectoryRemoved === true);
    write.mock.restore(); mkdir.mock.restore(); stat.mock.restore();
    assert.equal(injected, true);
    assert.deepEqual(fs.readdirSync(root).sort(), before);
    const retried = prepareToolWorker({ task, publicFiles: [], artifactTargets: [] });
    assert.equal((await closeToolWorker({ task, worker: retried })).ownedDirectoryRemoved, true);
  }
});
test('failed preparation rollback returns an issued original recovery handle, never a stranded caller path or serialized authority',
  async t => {
    const task = issueToolTask(coords());
    const originalWrite = fs.writeFileSync;
    const write = t.mock.method(fs, 'writeFileSync', (filename, bytes, options) => {
      if (typeof filename === 'string' && filename.endsWith('.owner.json') && filename.includes(`${path.sep}.owned${path.sep}`)) {
        throw Object.assign(new Error('Synthetic write failure'), { code: 'EIO' });
      }
      return originalWrite(filename, bytes, options);
    });
    const remove = t.mock.method(fs, 'rmSync', () => {
      throw Object.assign(new Error('Synthetic rollback failure'), { code: 'EACCES' });
    });
    let error;
    try { prepareToolWorker({ task, publicFiles: [], artifactTargets: [] }); }
    catch (failure) { error = failure; }
    write.mock.restore(); remove.mock.restore();
    assert.equal(error.code, 'PREPARATION_CLEANUP_FAILED');
    assert.equal(error.worker.kind, 'tool-worker');
    assert.equal(error.worker.directory, undefined);
    await assert.rejects(closeToolWorker({ task, worker: { ...error.worker } }), errorCode('ORIGINAL_WORKER_SCOPE_REQUIRED'));
    const cleanup = await closeToolWorker({ task, worker: error.worker });
    assert.equal(cleanup.ownedDirectoryRemoved, true);
    assert.equal(cleanup.exactOwnedCleanup, true);
    assert.equal(cleanup.authenticationVerified, false);
  });
