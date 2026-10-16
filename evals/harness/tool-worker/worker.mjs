import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const TOOL_PROTOCOL = 'eval-filesystem-tools@1';
export const TOOL_CAPS = Object.freeze({
  files: 32, targets: 8, fileBytes: 16384, sourceBytes: 131072,
  artifactBytes: 131072, requests: 64, requestBytes: 32768,
  totalRequestBytes: 262144, outputBytes: 524288, timeoutMs: 60000
});
export const WORKER_UID = 10002;
export const SOCKET_GID = 21000;
export const SOCKET_DIRECTORY = '/tool-rpc';
export const SOCKET_PATH = '/tool-rpc/worker.sock';
export const FLAGS = Object.freeze({
  evidenceScope: 'worker-filesystem-only',
  authenticationVerified: false, liveAccepted: false, nativeDiscoveryVerified: false
});
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const hashJson = value => sha256(JSON.stringify(value));

export class ToolWorkerError extends Error {
  constructor(code, details = {}) {
    super(`Tool worker: ${code}`);
    this.name = 'ToolWorkerError';
    this.code = code;
    this.failureClass = 'infrastructure';
    this.diagnosticHash = hashJson({ protocol: TOOL_PROTOCOL, code });
    Object.assign(this, details);
  }
}
export function insist(condition, code) {
  if (!condition) throw new ToolWorkerError(code);
}
export function exact(value, keys, required = keys) {
  insist(value !== null && typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype, 'INVALID_FIELDS');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  insist(Reflect.ownKeys(descriptors).every(key => typeof key === 'string' &&
    keys.includes(key) && Object.hasOwn(descriptors[key], 'value')) &&
    required.every(key => Object.hasOwn(descriptors, key)), 'INVALID_FIELDS');
  return value;
}
export function coordinates(value) {
  exact(value, ['invocationId', 'caseId', 'client', 'arm', 'repeat']);
  const identifier = text => typeof text === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(text);
  insist(identifier(value.invocationId) && identifier(value.caseId) &&
    ['claude-code', 'copilot', 'opencode'].includes(value.client) &&
    ['candidate', 'baseline', 'no-skill'].includes(value.arm) &&
    [1, 2, 3].includes(value.repeat), 'INVALID_COORDINATES');
  return Object.freeze({
    invocationId: value.invocationId, caseId: value.caseId,
    client: value.client, arm: value.arm, repeat: value.repeat
  });
}
export function limits(value = {}) {
  exact(value, Object.keys(TOOL_CAPS), []);
  for (const [key, number] of Object.entries(value)) {
    insist(Number.isSafeInteger(number) && number > 0 && number <= TOOL_CAPS[key], 'INVALID_LIMITS');
  }
  return Object.freeze({ ...TOOL_CAPS, ...value });
}
const reserved = /^(?:\.|private(?:[._-]|$)|judge(?:[._-]|$)|grad(?:er|ing)(?:[._-]|$)|checks?(?:[._-]|$)|expected(?:[._-]|$)|answer[-_]?key(?:[._-]|$)|credentials?(?:[._-]|$)|auth(?:[._-]|$)|secrets?(?:[._-]|$)|proof(?:[._-]|$)|home$|proc$|sys$|dev$|config$)/i;
const controls = /^(?:agents\.md|claude\.md|opencode\.jsonc?|mcp\.json|settings\.json|config\.json|copilot-config\.json|cline_mcp_settings\.json|hosts\.json|id_rsa|id_ed25519|docker\.sock)$/i;
export function portablePath(value, roots) {
  insist(typeof value === 'string' && Buffer.byteLength(value) <= 200, 'INVALID_PATH');
  const parts = value.split('/');
  insist(parts.length >= 2 && parts.length <= 8 && roots.includes(parts[0]) &&
    parts.every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,63}$/.test(part) &&
      !/[.]$/.test(part) && !reserved.test(part) && !controls.test(part) &&
      !/^(?:con|conin|conout|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)),
  'INVALID_PATH');
  return value;
}
function collisionPaths(paths) {
  const components = new Map();
  const leaves = [];
  for (const name of paths) {
    const parts = name.split('/');
    for (let count = 1; count <= parts.length; count++) {
      const item = parts.slice(0, count).join('/');
      const key = item.toLowerCase();
      insist(!components.has(key) || components.get(key) === item, 'PATH_ALIAS');
      components.set(key, item);
    }
    const key = name.toLowerCase();
    insist(!leaves.some(other => other === key || other.startsWith(`${key}/`) ||
      key.startsWith(`${other}/`)), 'PATH_COLLISION');
    leaves.push(key);
  }
}
export function decodeBytes(value, cap) {
  insist(typeof value === 'string' && value.length <= Math.ceil(cap / 3) * 4 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
  'INVALID_CONTENT');
  const bytes = Buffer.from(value, 'base64');
  insist(bytes.length <= cap && bytes.toString('base64') === value, 'FILE_LIMIT');
  return bytes;
}
export function declarations(publicFiles, artifactTargets, caps, { wire = false } = {}) {
  insist(Array.isArray(publicFiles) && publicFiles.length <= caps.files &&
    Array.isArray(artifactTargets) && artifactTargets.length <= caps.targets, 'FILE_COUNT_LIMIT');
  let total = 0;
  const files = publicFiles.map(item => {
    exact(item, ['path', wire ? 'contentBase64' : 'content']);
    const name = portablePath(item.path, ['skills', 'inputs']);
    let bytes;
    if (wire) bytes = decodeBytes(item.contentBase64, caps.fileBytes);
    else {
      insist(typeof item.content === 'string' || Buffer.isBuffer(item.content), 'INVALID_CONTENT');
      insist((typeof item.content === 'string' ? Buffer.byteLength(item.content) : item.content.length) <=
        caps.fileBytes, 'FILE_LIMIT');
      bytes = Buffer.from(item.content);
    }
    total += bytes.length;
    insist(total <= caps.sourceBytes, 'SOURCE_LIMIT');
    return { path: name, content: bytes, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const targets = artifactTargets.map(name => portablePath(name, ['artifacts']));
  collisionPaths([...files.map(item => item.path), ...targets]);
  return { files, targets, sourceBytes: total };
}
export function modelRequest(value, caps) {
  exact(value, ['op', 'path', 'contentBase64'], ['op', 'path']);
  insist(['read-public', 'write-artifact', 'read-artifact'].includes(value.op), 'UNKNOWN_TOOL');
  insist(Object.keys(value).length === (value.op === 'write-artifact' ? 3 : 2), 'INVALID_FIELDS');
  portablePath(value.path, value.op === 'read-public' ? ['skills', 'inputs'] : ['artifacts']);
  if (value.op === 'write-artifact') decodeBytes(value.contentBase64, caps.fileBytes);
  insist(Buffer.byteLength(JSON.stringify(value)) <= caps.requestBytes, 'REQUEST_LIMIT');
  return value;
}
function noLinks(filename, root) {
  let current = filename;
  insist(current === root || current.startsWith(`${root}${path.sep}`), 'PATH_ESCAPE');
  while (true) {
    const stat = fs.lstatSync(current);
    insist(!stat.isSymbolicLink() && (current === filename || stat.isDirectory()), 'LINK_DENIED');
    if (current === root) break;
    current = path.dirname(current);
  }
  insist(fs.realpathSync(filename) === filename, 'LINK_DENIED');
}
function readRegular(filename, root, cap) {
  noLinks(filename, root);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    insist(before.isFile() && before.nlink === 1 && before.size <= cap, 'LINK_OR_FILE_LIMIT');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      insist(read > 0, 'FILE_CHANGED');
      offset += read;
    }
    const after = fs.fstatSync(fd);
    insist(before.ino === after.ino && before.size === after.size &&
      before.mtimeMs === after.mtimeMs && after.nlink === 1, 'FILE_CHANGED');
    return bytes;
  } finally { fs.closeSync(fd); }
}
export class FilesystemSession {
  constructor({ root, task, publicFiles, artifactTargets, caps, deadline }) {
    this.root = path.resolve(root);
    this.task = coordinates(task);
    this.taskHash = hashJson(this.task);
    this.caps = limits(caps);
    const selected = declarations(publicFiles, artifactTargets, this.caps, { wire: true });
    this.files = new Map(selected.files.map(item => [item.path, item]));
    this.targets = selected.targets;
    this.stats = { requests: 0, requestBytes: 0, outputBytes: 0, writtenBytes: 0 };
    this.events = [];
    const now = Date.now();
    const originalDeadline = deadline ?? now + this.caps.timeoutMs;
    insist(Number.isSafeInteger(originalDeadline) && originalDeadline > now &&
      originalDeadline <= now + this.caps.timeoutMs, 'INVALID_DEADLINE');
    Object.defineProperty(this, 'deadline', { value: originalDeadline, enumerable: true });
    fs.mkdirSync(this.root, { recursive: false, mode: 0o700 });
    noLinks(this.root, this.root);
    for (const item of selected.files) {
      const filename = this.filename(item.path);
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filename, item.content, { flag: 'wx', mode: 0o400 });
    }
    for (const target of this.targets) {
      fs.mkdirSync(path.dirname(this.filename(target)), { recursive: true, mode: 0o700 });
    }
    const directories = new Set(selected.files.map(item => path.dirname(this.filename(item.path))));
    for (const directory of directories) fs.chmodSync(directory, 0o500);
    this.sourceHash = hashJson(selected.files.map(({ path: name, bytes, sha256: hash }) =>
      ({ path: name, bytes, sha256: hash })));
  }
  filename(name) { return path.join(this.root, ...name.split('/')); }
  assertActive() { insist(Date.now() < this.deadline, 'TIMEOUT'); }
  read(name, artifact) {
    if (artifact) insist(this.targets.includes(name), 'UNDECLARED_ARTIFACT');
    else insist(this.files.has(name), 'UNDECLARED_PUBLIC');
    const filename = this.filename(name);
    if (!fs.existsSync(filename)) throw new ToolWorkerError(artifact ? 'ARTIFACT_MISSING' : 'PUBLIC_MISSING');
    const bytes = readRegular(filename, this.root, this.caps.fileBytes);
    if (!artifact) insist(sha256(bytes) === this.files.get(name).sha256, 'PUBLIC_CHANGED');
    return { path: name, bytes: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString('base64') };
  }
  write(request) {
    insist(this.targets.includes(request.path), 'UNDECLARED_ARTIFACT');
    const bytes = decodeBytes(request.contentBase64, this.caps.fileBytes);
    insist(this.stats.writtenBytes + bytes.length <= this.caps.artifactBytes, 'ARTIFACT_LIMIT');
    const filename = this.filename(request.path);
    noLinks(path.dirname(filename), this.root);
    if (fs.existsSync(filename)) {
      noLinks(filename, this.root);
      const stat = fs.lstatSync(filename);
      insist(stat.isFile() && stat.nlink === 1, 'LINK_DENIED');
    }
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fs.fstatSync(fd);
      insist(stat.isFile() && stat.nlink === 1, 'LINK_DENIED');
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    this.stats.writtenBytes += bytes.length;
    return this.read(request.path, true);
  }
  execute(request) {
    this.assertActive();
    insist(++this.stats.requests <= this.caps.requests, 'REQUEST_COUNT_LIMIT');
    const requestBytes = Buffer.byteLength(JSON.stringify(request));
    this.stats.requestBytes += requestBytes;
    insist(requestBytes <= this.caps.requestBytes &&
      this.stats.requestBytes <= this.caps.totalRequestBytes, 'REQUEST_LIMIT');
    const requestHash = hashJson(request);
    let response;
    try {
      modelRequest(request, this.caps);
      const result = request.op === 'write-artifact' ? this.write(request) :
        this.read(request.path, request.op === 'read-artifact');
      response = { ok: true, result, ...FLAGS };
    } catch (error) {
      if (!(error instanceof ToolWorkerError)) throw new ToolWorkerError('FILESYSTEM_FAILURE');
      response = { ok: false, code: error.code, diagnosticHash: error.diagnosticHash, ...FLAGS };
    }
    this.stats.outputBytes += Buffer.byteLength(JSON.stringify(response));
    insist(this.stats.outputBytes <= this.caps.outputBytes, 'OUTPUT_LIMIT');
    this.events.push({ sequence: this.stats.requests, requestHash, responseHash: hashJson(response),
      outcome: response.ok ? 'FILESYSTEM_OPERATION_COMPLETE' : response.code });
    return response;
  }
  capture() {
    this.assertActive();
    const artifacts = [];
    const missing = [];
    for (const target of this.targets) {
      try { artifacts.push(this.read(target, true)); }
      catch (error) {
        if (error.code !== 'ARTIFACT_MISSING') throw error;
        missing.push(target);
      }
    }
    return { artifacts, missing, ...FLAGS };
  }
}
function observedKernel() {
  const namespaces = Object.fromEntries(['pid', 'mnt', 'user', 'net', 'ipc'].map(kind =>
    [kind, sha256(fs.readlinkSync(`/proc/self/ns/${kind}`))]));
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const fields = Object.fromEntries(['Uid', 'Gid', 'Groups', 'CapEff', 'NoNewPrivs', 'NSpid'].map(key =>
    [key, new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(status)?.[1].trim() ?? 'unavailable']));
  const checks = {};
  for (const filename of ['/var/run/docker.sock', '/run/docker.sock', '/root/.config',
    '/home/node/.config', '/synthetic-credentials/credential-canary.txt']) {
    try { fs.lstatSync(filename); checks[filename] = 'present'; }
    catch (error) {
      insist(['ENOENT', 'EACCES'].includes(error.code), 'DIAGNOSTIC_FAILURE');
      checks[filename] = error.code;
    }
  }
  try {
    fs.writeFileSync('/eval-worker-root-write-probe', 'synthetic', { flag: 'wx', mode: 0o600 });
    throw new ToolWorkerError('ROOT_WRITE_UNEXPECTEDLY_ALLOWED');
  } catch (error) {
    insist(error.code === 'EROFS' || error.code === 'EACCES', 'ROOT_WRITE_UNEXPECTEDLY_ALLOWED');
    checks.readOnlyRootWrite = error.code;
  }
  const entries = fs.readdirSync(SOCKET_DIRECTORY);
  insist(entries.length === 1 && entries[0] === 'worker.sock', 'SOCKET_VOLUME_CONTENT');
  const socket = fs.lstatSync(SOCKET_PATH);
  insist(socket.isSocket() && socket.nlink === 1 && socket.uid === WORKER_UID &&
    socket.gid === SOCKET_GID && (socket.mode & 0o777) === 0o660, 'SOCKET_PERMISSIONS');
  const socketDirectory = fs.lstatSync(SOCKET_DIRECTORY);
  insist(socketDirectory.isDirectory() && socketDirectory.uid === WORKER_UID &&
    socketDirectory.gid === SOCKET_GID && (socketDirectory.mode & 0o777) === 0o710,
  'SOCKET_PERMISSIONS');
  const mountinfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  const mounts = mountinfo.trim().split('\n').map(line => {
    const [left, right] = line.split(' - ');
    const fields = left.split(' ');
    return { target: fields[4], options: fields[5].split(','), filesystem: right.split(' ')[0] };
  }).filter(item => ['/', '/workspace', '/scratch', SOCKET_DIRECTORY].includes(item.target));
  insist(mounts.find(item => item.target === '/')?.options.includes('ro') &&
    mounts.find(item => item.target === SOCKET_DIRECTORY)?.filesystem === 'tmpfs' &&
    mounts.find(item => item.target === '/workspace')?.filesystem === 'tmpfs', 'KERNEL_MOUNT_MISMATCH');
  return {
    runtimeVersion: process.versions.node, uid: process.getuid(), gid: process.getgid(),
    supplementaryGroups: process.getgroups(), namespaces, procStatus: fields,
    environmentNames: Object.keys(process.env).sort(),
    interfaces: Object.keys(os.networkInterfaces()).sort(),
    checks, mounts, mountinfoHash: sha256(mountinfo),
    socket: { uid: socket.uid, gid: socket.gid, mode: '0660', directoryMode: '0710', entries: ['worker.sock'] }
  };
}
export function lineReader(stream, cap, onRecord, onFailure) {
  let pending = Buffer.alloc(0);
  let stopped = false;
  function fail(code) {
    if (stopped) return;
    stopped = true;
    onFailure(new ToolWorkerError(code));
  }
  stream.on('data', chunk => {
    if (stopped) return;
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      const newline = pending.indexOf(10);
      if (newline < 0) {
        if (pending.length > cap()) fail('REQUEST_LIMIT');
        break;
      }
      if (newline > cap()) { fail('REQUEST_LIMIT'); break; }
      const bytes = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      try {
        insist(bytes.length > 0 && !bytes.includes(13) &&
          Buffer.from(bytes.toString('utf8')).equals(bytes), 'INVALID_WIRE');
        onRecord(JSON.parse(bytes.toString('utf8')));
      } catch (error) {
        fail(error instanceof ToolWorkerError ? error.code : 'INVALID_WIRE');
        break;
      }
    }
  });
  stream.on('error', () => fail('TRANSPORT_FAILURE'));
  stream.on('end', () => { if (pending.length) fail('TRUNCATED_WIRE'); });
}
export function taskSocketAcceptor(session, dispatch, fatal, sockets = new Set()) {
  let accepted = false;
  return socket => {
    try {
      session.assertActive();
      if (accepted || sockets.size >= 1) { socket.destroy(); return; }
      accepted = true;
      sockets.add(socket);
      // Socket activity must not renew the broker's original absolute deadline.
      socket.setTimeout(0);
      const timer = setTimeout(() => fatal(new ToolWorkerError('TIMEOUT')),
        Math.max(1, session.deadline - Date.now()));
      let sequence = 0;
      lineReader(socket, () => TOOL_CAPS.requestBytes + 1024, input => {
        session.assertActive();
        insist(input.sequence === ++sequence, 'SEQUENCE_MISMATCH');
        dispatch(input, socket, false);
      }, fatal);
      socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });
    } catch (error) { socket.destroy(); fatal(error); }
  };
}
async function serve(scope) {
  insist(/^[a-f0-9]{64}$/.test(scope), 'INVALID_SCOPE');
  let session;
  let server;
  let timer;
  let totalOutput = 0;
  const sockets = new Set();
  const fatal = error => {
    process.stderr.write(`TOOL_WORKER_FAILURE:${error.code ?? 'INTERNAL_FAILURE'}\n`);
    for (const socket of sockets) socket.destroy();
    if (server) server.close();
    clearTimeout(timer);
    process.exitCode = 70;
    process.stdin.destroy();
    setTimeout(() => process.exit(70), 20);
  };
  const send = (stream, sequence, body) => {
    const line = `${JSON.stringify({ protocol: TOOL_PROTOCOL, scope, sequence, ...body })}\n`;
    totalOutput += Buffer.byteLength(line);
    insist(totalOutput <= (session?.caps.outputBytes ?? TOOL_CAPS.outputBytes), 'OUTPUT_LIMIT');
    stream.write(line);
    insist(stream.writableLength <= (session?.caps.outputBytes ?? TOOL_CAPS.outputBytes), 'OUTPUT_BACKPRESSURE');
  };
  const dispatch = (record, stream, admin) => {
    exact(record, ['protocol', 'scope', 'sequence', admin ? 'kind' : 'request',
      ...(admin ? ['request'] : [])], ['protocol', 'scope', 'sequence', admin ? 'kind' : 'request']);
    insist(record.protocol === TOOL_PROTOCOL && record.scope === scope &&
      Number.isSafeInteger(record.sequence) && record.sequence >= 1 &&
      record.sequence <= TOOL_CAPS.requests + 32, 'SCOPE_OR_SEQUENCE_MISMATCH');
    session.assertActive();
    if (!admin || record.kind === 'model') {
      insist(!admin || Object.hasOwn(record, 'request'), 'INVALID_FIELDS');
      send(stream, record.sequence, session.execute(record.request));
    } else {
      insist(Object.keys(record).length === 4, 'INVALID_FIELDS');
      if (record.kind === 'capture') send(stream, record.sequence, { ok: true, result: session.capture(), ...FLAGS });
      else if (record.kind === 'diagnostics') send(stream, record.sequence, {
        ok: true, result: { task: session.task, taskHash: session.taskHash,
          sourceHash: session.sourceHash, deadlineUnixMs: session.deadline,
          stats: { ...session.stats }, events: [...session.events],
          kernel: observedKernel() }, ...FLAGS
      });
      else throw new ToolWorkerError('UNKNOWN_ADMIN_OPERATION');
    }
  };
  lineReader(process.stdin, () => session ? TOOL_CAPS.requestBytes + 1024 : 262144, record => {
    if (session) { dispatch(record, process.stdout, true); return; }
    exact(record, ['protocol', 'kind', 'scope', 'task', 'publicFiles', 'artifactTargets', 'limits', 'deadlineUnixMs']);
    insist(record.protocol === TOOL_PROTOCOL && record.kind === 'initialize' &&
      record.scope === scope, 'SCOPE_MISMATCH');
    session = new FilesystemSession({
      root: '/workspace/data', task: record.task, publicFiles: record.publicFiles,
      artifactTargets: record.artifactTargets, caps: record.limits, deadline: record.deadlineUnixMs
    });
    timer = setTimeout(() => fatal(new ToolWorkerError('TIMEOUT')),
      Math.max(1, session.deadline - Date.now()));
    server = net.createServer(taskSocketAcceptor(session, dispatch, fatal, sockets));
    server.once('error', () => fatal(new ToolWorkerError('SOCKET_FAILURE')));
    server.listen(SOCKET_PATH, () => {
      try {
        fs.chownSync(SOCKET_PATH, WORKER_UID, SOCKET_GID);
        fs.chmodSync(SOCKET_PATH, 0o660);
        send(process.stdout, 0, { ok: true, result: {
          taskHash: session.taskHash, sourceHash: session.sourceHash, deadlineUnixMs: session.deadline,
          kernel: observedKernel()
        }, ...FLAGS });
      } catch (error) { fatal(error); }
    });
  }, fatal);
  process.stdin.once('end', () => fatal(new ToolWorkerError('BROKER_DISCONNECTED')));
}
if (process.argv[1] === '--eval-tool-worker') {
  serve(process.argv[2]).catch(error => {
    process.stderr.write(`TOOL_WORKER_FAILURE:${error.code ?? 'INTERNAL_FAILURE'}\n`);
    process.exitCode = 70;
  });
}
