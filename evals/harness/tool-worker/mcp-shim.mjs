import net from 'node:net';
import { createHash } from 'node:crypto';

const PROTOCOL = 'eval-filesystem-tools@1';
const SOCKET = '/tool-rpc/worker.sock';
const MAX_RECORD = 32768;
export const MCP_VERSIONS = Object.freeze(['2024-11-05', '2025-03-26', '2025-06-18']);
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export const MCP_TOOLS = freeze([
  {
    name: 'eval_read_public', description: 'Read one declared public skill or input file. Not native Skill loading.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } },
      required: ['path'], additionalProperties: false }
  },
  {
    name: 'eval_write_artifact', description: 'Write bytes to one declared artifact target.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, contentBase64: { type: 'string' } },
      required: ['path', 'contentBase64'], additionalProperties: false }
  },
  {
    name: 'eval_read_artifact', description: 'Read actual worker disk bytes from one declared artifact target.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } },
      required: ['path'], additionalProperties: false }
  }
]);
class ShimFault extends Error {
  constructor(code) { super(code); this.code = code; }
}
class InvalidParams extends Error {}
const plain = value => value !== null && typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype;
function fields(value, allowed, required = []) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' ||
      !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) ||
      required.some(key => !Object.hasOwn(value, key))) throw new InvalidParams();
}
function text(value, max, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.length) || Buffer.byteLength(value) > max ||
      /[\x00-\x1f\x7f]/.test(value)) throw new InvalidParams();
}
function inertObject(value, depth = 0, budget = { entries: 0 }) {
  if (!plain(value) || depth > 4 || Object.keys(value).length > 16) throw new InvalidParams();
  fields(value, Object.keys(value));
  for (const [key, item] of Object.entries(value)) {
    text(key, 128);
    if (++budget.entries > 64) throw new InvalidParams();
    inertValue(item, depth + 1, budget);
  }
}
function inertValue(value, depth = 0, budget = { entries: 0 }) {
  if (plain(value)) inertObject(value, depth, budget);
  else if (Array.isArray(value)) {
    if (depth > 4 || value.length > 16) throw new InvalidParams();
    for (const item of value) {
      if (++budget.entries > 64) throw new InvalidParams();
      inertValue(item, depth + 1, budget);
    }
  } else primitive(value);
}
function primitive(value) {
  if (typeof value === 'string') text(value, 1024, true);
  else if (value !== null && typeof value !== 'boolean' &&
    !(typeof value === 'number' && Number.isFinite(value))) throw new InvalidParams();
}
function markers(value, names) {
  fields(value, names);
  for (const item of Object.values(value)) inertObject(item);
}
function capabilities(value) {
  fields(value, ['roots', 'sampling', 'elicitation', 'tasks', 'experimental']);
  if (Buffer.byteLength(JSON.stringify(value)) > 4096) throw new InvalidParams();
  if (value.roots !== undefined) {
    fields(value.roots, ['listChanged']);
    if (value.roots.listChanged !== undefined && typeof value.roots.listChanged !== 'boolean') {
      throw new InvalidParams();
    }
  }
  if (value.sampling !== undefined) markers(value.sampling, ['context', 'tools']);
  if (value.elicitation !== undefined) markers(value.elicitation, ['form', 'url']);
  if (value.experimental !== undefined) {
    fields(value.experimental, Object.keys(value.experimental ?? {}));
    if (Object.keys(value.experimental).length > 16) throw new InvalidParams();
    for (const [name, item] of Object.entries(value.experimental)) { text(name, 128); inertValue(item); }
  }
  if (value.tasks !== undefined) {
    fields(value.tasks, ['list', 'cancel', 'requests']);
    for (const key of ['list', 'cancel']) if (value.tasks[key] !== undefined) inertObject(value.tasks[key]);
    if (value.tasks.requests !== undefined) {
      fields(value.tasks.requests, ['sampling', 'elicitation']);
      if (value.tasks.requests.sampling !== undefined) markers(value.tasks.requests.sampling, ['createMessage']);
      if (value.tasks.requests.elicitation !== undefined) markers(value.tasks.requests.elicitation, ['create']);
    }
  }
}
function metadataUri(value, icon = false) {
  text(value, 2048);
  let uri;
  try { uri = new URL(value); } catch { throw new InvalidParams(); }
  if (uri.username || uri.password || !(['http:', 'https:'].includes(uri.protocol) ||
      (icon && uri.protocol === 'data:' && /^data:image\/[a-zA-Z0-9.+-]+[;,]/.test(value)))) {
    throw new InvalidParams();
  }
}
function implementation(value) {
  fields(value, ['name', 'version', 'title', 'icons', 'websiteUrl', 'description'], ['name', 'version']);
  text(value.name, 128);
  text(value.version, 128);
  if (value.title !== undefined) text(value.title, 256);
  if (value.description !== undefined) text(value.description, 1024);
  if (value.websiteUrl !== undefined) metadataUri(value.websiteUrl);
  if (value.icons !== undefined) {
    if (!Array.isArray(value.icons) || value.icons.length > 4) throw new InvalidParams();
    for (const icon of value.icons) {
      fields(icon, ['src', 'mimeType', 'sizes', 'theme'], ['src']);
      metadataUri(icon.src, true);
      if (icon.mimeType !== undefined) {
        text(icon.mimeType, 128);
        if (!/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(icon.mimeType)) throw new InvalidParams();
      }
      if (icon.sizes !== undefined && (!Array.isArray(icon.sizes) || icon.sizes.length > 8 ||
          icon.sizes.some(size => typeof size !== 'string' ||
            !/^(?:any|[1-9][0-9]{0,4}x[1-9][0-9]{0,4})$/.test(size)))) throw new InvalidParams();
      if (icon.theme !== undefined && !['light', 'dark'].includes(icon.theme)) throw new InvalidParams();
    }
  }
}
export function initializeVersion(params) {
  fields(params, ['protocolVersion', 'capabilities', 'clientInfo'],
    ['protocolVersion', 'capabilities', 'clientInfo']);
  if (Buffer.byteLength(JSON.stringify(params)) > 8192 ||
      typeof params.protocolVersion !== 'string' ||
      !/^20[0-9]{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/.test(params.protocolVersion)) {
    throw new InvalidParams();
  }
  capabilities(params.capabilities);
  implementation(params.clientInfo);
  const parsed = Date.parse(`${params.protocolVersion}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== params.protocolVersion) {
    throw new InvalidParams();
  }
  // Client metadata is validated and discarded, never forwarded, fetched, rendered or activated.
  return MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS.at(-1);
}
export function transportPolicy(value) {
  const maxima = { requests: 64, requestBytes: 32768, totalRequestBytes: 262144, outputBytes: 524288 };
  try { fields(value, ['deadlineUnixMs', ...Object.keys(maxima)], ['deadlineUnixMs', ...Object.keys(maxima)]); }
  catch { throw new ShimFault('INVALID_TRANSPORT_POLICY'); }
  if (!Number.isSafeInteger(value.deadlineUnixMs) ||
      value.deadlineUnixMs > Date.now() + 60000) throw new ShimFault('INVALID_TRANSPORT_POLICY');
  for (const [key, max] of Object.entries(maxima)) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > max) {
      throw new ShimFault('INVALID_TRANSPORT_POLICY');
    }
  }
  return Object.freeze({ ...value });
}
const validId = id => (typeof id === 'string' && Buffer.byteLength(id) <= 64) || Number.isSafeInteger(id);
const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const rejection = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export class McpProtocol {
  constructor({ scope, policy, requestWorker }) {
    if (!/^[a-f0-9]{64}$/.test(scope ?? '')) throw new ShimFault('INVALID_TRANSPORT_SCOPE');
    this.scope = scope;
    this.policy = transportPolicy(policy);
    this.requestWorker = requestWorker;
    this.initialized = false;
    this.messages = 0;
    this.toolRequests = 0;
    this.requestBytes = 0;
    this.completed = new Set();
    this.activeId = undefined;
  }
  active() {
    if (Date.now() >= this.policy.deadlineUnixMs) throw new ShimFault('TIMEOUT');
  }
  count() {
    this.active();
    if (++this.messages > this.policy.requests + 8) throw new ShimFault('REQUEST_COUNT_LIMIT');
  }
  cancel(record) {
    this.count();
    try {
      fields(record, ['jsonrpc', 'method', 'params'], ['jsonrpc', 'method', 'params']);
      fields(record.params, ['requestId', 'reason'], ['requestId']);
      if (record.jsonrpc !== '2.0' || record.method !== 'notifications/cancelled' ||
          !this.initialized || !validId(record.params.requestId)) throw new InvalidParams();
      if (record.params.reason !== undefined) text(record.params.reason, 256, true);
      if (record.params.requestId === this.activeId) return true;
      if (this.completed.has(record.params.requestId)) return false;
    } catch { throw new ShimFault('INVALID_CANCELLATION'); }
    throw new ShimFault('CANCELLATION_SCOPE_MISMATCH');
  }
  async dispatch(record) {
    this.count();
    const id = validId(record?.id) ? record.id : null;
    try {
      fields(record, ['jsonrpc', 'id', 'method', 'params'], ['jsonrpc', 'method']);
      if (record.jsonrpc !== '2.0' || typeof record.method !== 'string') throw new InvalidParams();
    } catch {
      return rejection(id, -32600, 'Invalid request fields');
    }
    if (!Object.hasOwn(record, 'id')) {
      if (record.method !== 'notifications/initialized' || !this.initialized) {
        throw new ShimFault('UNSUPPORTED_NOTIFICATION');
      }
      try { if (record.params !== undefined) fields(record.params, []); }
      catch { throw new ShimFault('INVALID_NOTIFICATION_FIELDS'); }
      return undefined;
    }
    if (id === null) return rejection(null, -32600, 'Invalid request ID');
    if (record.method === 'initialize') {
      if (this.initialized) return rejection(id, -32600, 'Already initialized');
      try {
        const version = initializeVersion(record.params);
        this.initialized = true;
        return result(id, {
          protocolVersion: version, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'eval-filesystem-worker', version: '1.0.0' }
        });
      } catch (error) {
        if (!(error instanceof InvalidParams)) throw error;
        return rejection(id, -32602, 'Invalid initialize parameters');
      }
    }
    if (record.method === 'ping') {
      try { if (record.params !== undefined) fields(record.params, []); }
      catch { return rejection(id, -32602, 'Invalid ping parameters'); }
      return result(id, {});
    }
    if (!this.initialized) return rejection(id, -32000, 'Initialize required');
    if (record.method === 'tools/list') {
      try { if (record.params !== undefined) fields(record.params, []); }
      catch { return rejection(id, -32602, 'No list overrides'); }
      return result(id, { tools: MCP_TOOLS });
    }
    if (record.method !== 'tools/call') return rejection(id, -32601, 'Unsupported method');
    let index;
    try {
      fields(record.params, ['name', 'arguments'], ['name', 'arguments']);
      text(record.params.name, 64);
      index = MCP_TOOLS.findIndex(tool => tool.name === record.params.name);
      if (index < 0) return rejection(id, -32601, 'Unknown tool');
      fields(record.params.arguments, index === 1 ? ['path', 'contentBase64'] : ['path'],
        index === 1 ? ['path', 'contentBase64'] : ['path']);
      if (typeof record.params.arguments.path !== 'string' ||
          (index === 1 && typeof record.params.arguments.contentBase64 !== 'string')) throw new InvalidParams();
    } catch { return rejection(id, -32602, 'Exact tool arguments required'); }
    const request = { op: ['read-public', 'write-artifact', 'read-artifact'][index], ...record.params.arguments };
    const bytes = Buffer.byteLength(JSON.stringify(request));
    this.requestBytes += bytes;
    if (++this.toolRequests > this.policy.requests) throw new ShimFault('REQUEST_COUNT_LIMIT');
    if (bytes > this.policy.requestBytes || this.requestBytes > this.policy.totalRequestBytes) {
      throw new ShimFault('REQUEST_LIMIT');
    }
    this.activeId = id;
    try {
      const response = await this.requestWorker(request);
      this.active();
      this.completed.add(id);
      return result(id, { content: [{ type: 'text', text: JSON.stringify(response) }], isError: !response.ok });
    } finally { this.activeId = undefined; }
  }
}

export function serveMcp({ input, output, scope, policy, connectSocket, signal }) {
  const selected = transportPolicy(policy);
  let socket, awaiting, connectReject, operationTimer, stopTimer;
  let socketClose = Promise.resolve();
  let socketClosed = true;
  let connected = false;
  let pending = Buffer.alloc(0), rpcPending = Buffer.alloc(0);
  let sequence = 0, inputBytes = 0, outputBytes = 0, rpcBytes = 0;
  let stopping = false, finished = false;
  let chain = Promise.resolve();
  let complete;
  const closed = new Promise(resolve => { complete = resolve; });
  const protocol = new McpProtocol({ scope, policy: selected, requestWorker: request });
  const abort = () => stop('CANCELLED');
  const deadlineTimer = setTimeout(() => stop('TIMEOUT'),
    Math.max(1, selected.deadlineUnixMs - Date.now()));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  function stop(code = 'EOF') {
    if (stopping) return closed;
    stopping = true;
    clearTimeout(deadlineTimer);
    clearTimeout(operationTimer);
    signal?.removeEventListener('abort', abort);
    input.removeListener('data', receive);
    input.destroy();
    const failure = new ShimFault(code);
    connectReject?.(failure);
    awaiting?.reject(failure);
    awaiting = undefined;
    socket?.destroy();
    stopTimer = setTimeout(() => finish('TRANSPORT_STOP_UNVERIFIED'), 2000);
    socketClose.then(() => finish(code));
    return closed;
  }
  function finish(code) {
    if (finished) return;
    finished = true;
    clearTimeout(stopTimer);
    output.end();
    complete({ code, socketClosed, inputBytes, outputBytes, requests: protocol.toolRequests });
  }
  function send(record) {
    if (stopping || record === undefined) return;
    const line = `${JSON.stringify(record)}\n`;
    outputBytes += Buffer.byteLength(line);
    if (outputBytes > selected.outputBytes) { stop('OUTPUT_LIMIT'); return; }
    output.write(line, error => { if (error) stop('TRANSPORT_FAILURE'); });
    if (output.writableLength > Math.min(selected.outputBytes, MAX_RECORD * 2)) stop('OUTPUT_BACKPRESSURE');
  }
  async function connect() {
    if (socket) {
      if (!connected || socket.destroyed) throw new ShimFault('TRANSPORT_CLOSED');
      return;
    }
    await new Promise((resolve, reject) => {
      connectReject = reject;
      socket = connectSocket();
      socketClosed = false;
      socketClose = new Promise(done => socket.once('close', () => { socketClosed = true; done(); }));
      socket.once('connect', () => { connected = true; connectReject = undefined; resolve(); });
      socket.on('error', () => stop(Date.now() >= selected.deadlineUnixMs ? 'TIMEOUT' : 'TRANSPORT_FAILURE'));
      socket.once('close', () => {
        if (!stopping) stop(Date.now() >= selected.deadlineUnixMs ? 'TIMEOUT' : 'TRANSPORT_CLOSED');
      });
      socket.on('data', chunk => {
        if (stopping) return;
        rpcBytes += chunk.length;
        if (rpcBytes > selected.outputBytes) { stop('OUTPUT_LIMIT'); return; }
        rpcPending = Buffer.concat([rpcPending, chunk]);
        const end = rpcPending.indexOf(10);
        if (end < 0) { if (rpcPending.length > MAX_RECORD) stop('RESPONSE_LIMIT'); return; }
        if (end > MAX_RECORD || rpcPending.length !== end + 1 || !awaiting) {
          stop('INVALID_RESPONSE'); return;
        }
        try {
          const bytes = rpcPending.subarray(0, end);
          if (bytes.includes(13) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new ShimFault('INVALID_RESPONSE');
          const value = JSON.parse(bytes.toString('utf8'));
          if (value.protocol !== PROTOCOL || value.scope !== scope || value.sequence !== sequence ||
              typeof value.ok !== 'boolean' || value.authenticationVerified !== false ||
              value.nativeDiscoveryVerified !== false || value.liveAccepted !== false) {
            throw new ShimFault('INVALID_RESPONSE');
          }
          rpcPending = Buffer.alloc(0);
          const current = awaiting;
          awaiting = undefined;
          current.resolve(value);
        } catch { stop('INVALID_RESPONSE'); }
      });
    });
  }
  async function request(value) {
    protocol.active();
    operationTimer = setTimeout(() => stop(Date.now() >= selected.deadlineUnixMs ? 'TIMEOUT' : 'OPERATION_TIMEOUT'),
      Math.max(1, Math.min(10000, selected.deadlineUnixMs - Date.now())));
    try {
      await connect();
      if (stopping) throw new ShimFault('TRANSPORT_CLOSED');
      const line = `${JSON.stringify({ protocol: PROTOCOL, scope, sequence: ++sequence, request: value })}\n`;
      if (Buffer.byteLength(line) > selected.requestBytes + 1024) throw new ShimFault('REQUEST_LIMIT');
      return await new Promise((resolve, reject) => {
        awaiting = { resolve, reject };
        socket.write(line, error => { if (error) stop('TRANSPORT_FAILURE'); });
      });
    } finally { clearTimeout(operationTimer); }
  }
  function receive(chunk) {
    if (stopping) return;
    inputBytes += chunk.length;
    if (inputBytes > selected.totalRequestBytes) { stop('REQUEST_LIMIT'); return; }
    pending = Buffer.concat([pending, chunk]);
    while (!stopping) {
      const end = pending.indexOf(10);
      const frameCap = Math.min(MAX_RECORD, selected.requestBytes);
      if (end < 0) { if (pending.length > frameCap) stop('REQUEST_LIMIT'); break; }
      if (end > frameCap) { stop('REQUEST_LIMIT'); break; }
      const bytes = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      try {
        if (!bytes.length || bytes.includes(13) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) {
          throw new ShimFault('INVALID_WIRE');
        }
        const record = JSON.parse(bytes.toString('utf8'));
        if (record?.method === 'notifications/cancelled') {
          if (protocol.cancel(record)) stop('CANCELLED');
        } else chain = chain.then(async () => {
          if (!stopping) send(await protocol.dispatch(record));
        }).catch(error => stop(error.code ?? 'PROTOCOL_FAILURE'));
      } catch (error) { stop(error.code ?? 'INVALID_WIRE'); }
    }
  }
  input.on('data', receive);
  input.once('error', () => stop('TRANSPORT_FAILURE'));
  output.once('error', () => stop('TRANSPORT_FAILURE'));
  input.once('end', () => {
    if (pending.length) { stop('TRUNCATED_WIRE'); return; }
    if (protocol.activeId !== undefined) { stop('BROKER_DISCONNECTED'); return; }
    chain.then(() => stop('EOF')).catch(error => stop(error.code ?? 'PROTOCOL_FAILURE'));
  });
  return { closed, stop, protocol };
}

if (process.argv[1] === '--eval-tool-mcp-shim') {
  let shim;
  const cancel = () => shim.stop('CANCELLED');
  function exit(code) {
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
    if (code === 'EOF') { process.exit(0); return; }
    const hash = createHash('sha256').update(`${PROTOCOL}:${code}`).digest('hex');
    process.stderr.write(`TOOL_MCP_SHIM_FAILURE:${code}:${hash}\n`, () => process.exit(70));
  }
  try {
    if (typeof process.argv[3] !== 'string' || Buffer.byteLength(process.argv[3]) > 1024) {
      throw new ShimFault('INVALID_TRANSPORT_POLICY');
    }
    shim = serveMcp({
      input: process.stdin, output: process.stdout, scope: process.argv[2],
      policy: JSON.parse(process.argv[3]), connectSocket: () => net.createConnection(SOCKET)
    });
    process.once('SIGTERM', cancel);
    process.once('SIGINT', cancel);
    shim.closed.then(outcome => exit(outcome.code));
  } catch (error) { exit(error.code ?? 'INVALID_TRANSPORT_POLICY'); }
}
