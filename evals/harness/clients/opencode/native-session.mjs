import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_VERSION, NATIVE_SESSION_DATABASE, PROMPT_ENVELOPE } from './constants.mjs';
import { PROJECT, TASK_CAPS, freeze, insist, record, sha256 } from './case-spec.mjs';
import { nativeModelSelection } from './native-spec.mjs';

export const NATIVE_SESSION_FORMAT = 'opencode-native-session-snapshot-v1';
export const SESSION_CAPS = Object.freeze({ messages: 512, parts: 8192, bytes: TASK_CAPS.wireBytes, databaseBytes: 16 * 1024 * 1024 });

export function canonicalNativeJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalNativeJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalNativeJSON(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function nativeIdentity(value, prefix) {
  return typeof value === 'string' && new RegExp(`^${prefix}_[a-zA-Z0-9_-]{1,100}$`).test(value);
}

function plain(value) {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function counter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function nativeTokenCounters(tokens) {
  insist(plain(tokens) && [tokens.input, tokens.output, tokens.reasoning,
    tokens.cache?.read, tokens.cache?.write].every(counter) &&
    (tokens.total == null || counter(tokens.total)), 'Malformed native session token counters', 'NATIVE_SESSION_METADATA_INVALID');
  return { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning,
    total: tokens.total ?? null, cache: { read: tokens.cache.read, write: tokens.cache.write } };
}

function inputText(part) {
  insist(typeof part.text === 'string', 'Missing native user text', 'NATIVE_SESSION_METADATA_INVALID');
  const redacted = /^\[redacted:text:prt_[a-zA-Z0-9_-]+\]$/.test(part.text);
  return {
    nativeHash: redacted ? null : sha256(part.text),
    callerSpanHash: !redacted && part.text.startsWith('\n') ? sha256(part.text.slice(1)) : null,
    envelope: !redacted && part.text.startsWith('\n') ? PROMPT_ENVELOPE : null,
    bytes: redacted ? null : Buffer.byteLength(part.text),
    synthetic: part.synthetic === true, ignored: part.ignored === true,
    redacted
  };
}

export function projectPinnedSessionExport(data, { source = 'native-session-export-format' } = {}) {
  record(data, ['info', 'messages']);
  insist(plain(data.info) && nativeIdentity(data.info.id, 'ses') && data.info.version === CLIENT_VERSION &&
    data.info.directory === PROJECT && !data.info.parentID && Array.isArray(data.messages) &&
    data.messages.length > 0 && data.messages.length <= SESSION_CAPS.messages,
  'Native session coordinates/version/directory are missing or unsupported', 'NATIVE_SESSION_METADATA_INVALID');
  let parts = 0;
  const messageIds = new Set();
  const partIds = new Set();
  const messages = data.messages.map(message => {
    record(message, ['info', 'parts']);
    const info = message.info;
    insist(plain(info) && nativeIdentity(info.id, 'msg') && info.sessionID === data.info.id &&
      !messageIds.has(info.id) && ['user', 'assistant'].includes(info.role) && Array.isArray(message.parts) &&
      plain(info.time) && Number.isFinite(info.time.created) && info.time.created >= 0,
    'Malformed or duplicated native session message', 'NATIVE_SESSION_METADATA_INVALID');
    messageIds.add(info.id);
    parts += message.parts.length;
    insist(parts <= SESSION_CAPS.parts, 'Native session part cap exceeded', 'NATIVE_SESSION_METADATA_INVALID');
    const projectedParts = message.parts.map(part => {
      insist(plain(part) && nativeIdentity(part.id, 'prt') && part.sessionID === data.info.id &&
        part.messageID === info.id && !partIds.has(part.id) && typeof part.type === 'string',
      'Malformed or duplicated native session part', 'NATIVE_SESSION_METADATA_INVALID');
      partIds.add(part.id);
      return { id: part.id, type: part.type, hash: sha256(canonicalNativeJSON(part)),
        ...(info.role === 'user' && part.type === 'text' ? { inputText: inputText(part) } : {}) };
    });
    const selected = nativeModelSelection(info.role === 'user' ?
      { providerID: info.model?.providerID, modelID: info.model?.modelID } :
      { providerID: info.providerID, modelID: info.modelID });
    if (info.role === 'assistant') {
      insist(nativeIdentity(info.parentID, 'msg') && !info.error &&
        Number.isFinite(info.time.completed) && info.time.completed >= info.time.created &&
        Number.isFinite(info.cost) && info.cost >= 0 && typeof info.finish === 'string',
      'Incomplete or failed native assistant message', 'NATIVE_SESSION_METADATA_INVALID');
    }
    return {
      id: info.id, role: info.role, model: selected,
      parentId: info.role === 'assistant' ? info.parentID : null,
      createdAt: info.time.created, completedAt: info.time.completed ?? null,
      tokens: info.role === 'assistant' ? nativeTokenCounters(info.tokens) : null,
      estimatedCost: info.role === 'assistant' ? info.cost : null,
      finish: info.role === 'assistant' ? info.finish : null,
      parts: projectedParts
    };
  });
  const snapshot = {
    format: NATIVE_SESSION_FORMAT, source, clientVersion: CLIENT_VERSION,
    session: { id: data.info.id, version: data.info.version, directory: data.info.directory, parentId: null },
    messages
  };
  insist(Buffer.byteLength(JSON.stringify(snapshot)) <= SESSION_CAPS.bytes, 'Projected native session byte cap exceeded',
    'NATIVE_SESSION_METADATA_INVALID');
  return freeze(snapshot);
}

function inspectDatabase(filename) {
  let current = path.parse(filename).root;
  let stat;
  for (const segment of filename.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    stat = fs.lstatSync(current);
    insist(!stat.isSymbolicLink() && (current === filename ? stat.isFile() && stat.nlink === 1 : stat.isDirectory()),
      'Unsafe native session database path', 'NATIVE_SESSION_METADATA_INVALID');
  }
  insist(stat.size <= SESSION_CAPS.databaseBytes, 'Native session database byte cap exceeded', 'NATIVE_SESSION_METADATA_INVALID');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (!fs.existsSync(`${filename}${suffix}`)) continue;
    const sidecar = fs.lstatSync(`${filename}${suffix}`);
    insist(sidecar.isFile() && !sidecar.isSymbolicLink() && sidecar.nlink === 1 &&
      sidecar.size <= SESSION_CAPS.databaseBytes, 'Unsafe native session database sidecar', 'NATIVE_SESSION_METADATA_INVALID');
  }
  return stat;
}

export async function readNativeSessionSnapshot({ sessionId }, { databasePath = NATIVE_SESSION_DATABASE } = {}) {
  insist(nativeIdentity(sessionId, 'ses') && typeof databasePath === 'string' &&
    path.basename(databasePath) === 'opencode-native.db', 'Invalid fixed native session reader request', 'NATIVE_SESSION_METADATA_INVALID');
  const filename = path.resolve(databasePath);
  const before = inspectDatabase(filename);
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { insist(false, 'Pinned native Node SQLite reader unavailable', 'NATIVE_SESSION_METADATA_UNAVAILABLE'); }
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON; BEGIN');
    const session = database.prepare('SELECT id, version, directory, parent_id FROM session WHERE id = ?').get(sessionId);
    insist(session, 'Native session not present in owned state', 'NATIVE_SESSION_METADATA_UNAVAILABLE');
    const rows = database.prepare('SELECT id, session_id, data FROM message WHERE session_id = ? ORDER BY time_created, id LIMIT ?')
      .all(sessionId, SESSION_CAPS.messages + 1);
    const partRows = database.prepare('SELECT id, message_id, session_id, data FROM part WHERE session_id = ? ORDER BY time_created, id LIMIT ?')
      .all(sessionId, SESSION_CAPS.parts + 1);
    insist(rows.length <= SESSION_CAPS.messages && partRows.length <= SESSION_CAPS.parts,
      'Native session database row cap exceeded', 'NATIVE_SESSION_METADATA_INVALID');
    let bytes = 0;
    const decode = row => {
      insist(typeof row.data === 'string', 'Malformed native session database record', 'NATIVE_SESSION_METADATA_INVALID');
      bytes += Buffer.byteLength(row.data);
      insist(bytes <= SESSION_CAPS.bytes, 'Native session database record byte cap exceeded', 'NATIVE_SESSION_METADATA_INVALID');
      return JSON.parse(row.data);
    };
    const byMessage = new Map(rows.map(row => [row.id, {
      info: { ...decode(row), id: row.id, sessionID: row.session_id }, parts: []
    }]));
    for (const row of partRows) {
      insist(byMessage.has(row.message_id), 'Orphan native session part', 'NATIVE_SESSION_METADATA_INVALID');
      byMessage.get(row.message_id).parts.push({ ...decode(row), id: row.id, messageID: row.message_id, sessionID: row.session_id });
    }
    const snapshot = projectPinnedSessionExport({
      info: { id: session.id, version: session.version, directory: session.directory, parentID: session.parent_id },
      messages: [...byMessage.values()]
    }, { source: 'readonly-native-session-sqlite' });
    database.exec('COMMIT');
    const after = inspectDatabase(filename);
    insist(before.ino === after.ino && before.size === after.size &&
      (process.platform === 'win32' || before.dev === after.dev) &&
      before.mtimeMs === after.mtimeMs, 'Native session database changed during capture', 'NATIVE_SESSION_METADATA_INVALID');
    return snapshot;
  } catch (error) {
    if (error?.code?.startsWith('NATIVE_SESSION_')) throw error;
    insist(false, 'Native session database schema or records are unsupported', 'NATIVE_SESSION_METADATA_UNAVAILABLE');
  } finally { database.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      insist(bytes <= 1024, 'Native session reader input cap exceeded');
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    record(input, ['sessionId']);
    console.log(JSON.stringify(await readNativeSessionSnapshot(input)));
  } catch (error) {
    console.error(JSON.stringify({ error: { code: error.code ?? 'NATIVE_SESSION_METADATA_UNAVAILABLE',
      message: 'Bounded native session metadata capture unavailable' } }));
    process.exitCode = 1;
  }
}
