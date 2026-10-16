import { canonicalHost } from './policy.mjs';
import { insist } from './errors.mjs';

export const MAX_CONNECT_BYTES = 4096;
export const MAX_HELLO_BYTES = 32768;
export const MAX_HELLO_RECORDS = 8;
const incomplete = Object.freeze({ complete: false });

export function parseConnect(bytes, policy) {
  insist(Buffer.isBuffer(bytes), 'CONNECT_HEADERS');
  insist(bytes.length <= MAX_CONNECT_BYTES, 'CONNECT_OVERSIZE');
  const end = bytes.indexOf('\r\n\r\n');
  if (end < 0) return incomplete;
  insist(end + 4 === bytes.length, 'CONNECT_PIPELINED');
  insist([...bytes].every(byte => byte === 13 || byte === 10 || (byte >= 32 && byte <= 126)),
    'CONNECT_HEADERS');
  const lines = bytes.subarray(0, end).toString('ascii').split('\r\n');
  const request = lines.shift();
  insist(request.startsWith('CONNECT '), 'CONNECT_METHOD');
  const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.1$/.exec(request);
  insist(match, 'CONNECT_AUTHORITY');
  let host;
  try { host = canonicalHost(match[1]); } catch { insist(false, 'CONNECT_AUTHORITY'); }
  insist(policy?.hosts?.includes(host) && policy.port === 443, 'HOST_DENIED');
  insist(lines.length >= 1 && lines.length <= 8, 'CONNECT_HEADERS');
  const headers = new Map();
  for (const line of lines) {
    const header = /^([A-Za-z-]+):[ \t]*([\x20-\x7e]*)$/.exec(line);
    insist(header && header[2].length <= 512, 'CONNECT_HEADERS');
    const name = header[1].toLowerCase();
    const value = header[2];
    insist(!headers.has(name) && ['host', 'proxy-connection', 'connection', 'user-agent'].includes(name),
      'CONNECT_HEADERS');
    if (name === 'host') insist(value === `${host}:443`, 'CONNECT_HEADERS');
    if (name === 'proxy-connection' || name === 'connection') {
      insist(value.toLowerCase() === 'keep-alive', 'CONNECT_HEADERS');
    }
    headers.set(name, value);
  }
  insist(headers.has('host'), 'CONNECT_HEADERS');
  return Object.freeze({ complete: true, host });
}

function parseHelloBody(body, expectedHost) {
  let offset = 0;
  function take(count) {
    insist(Number.isInteger(count) && count >= 0 && offset + count <= body.length, 'TLS_CLIENT_HELLO');
    const value = body.subarray(offset, offset + count);
    offset += count;
    return value;
  }
  function byte() { return take(1)[0]; }
  function word() { return take(2).readUInt16BE(0); }
  insist(word() === 0x0303, 'TLS_CLIENT_HELLO');
  take(32);
  const session = byte();
  insist(session <= 32, 'TLS_CLIENT_HELLO');
  take(session);
  const cipherLength = word();
  insist(cipherLength >= 2 && cipherLength % 2 === 0, 'TLS_CLIENT_HELLO');
  take(cipherLength);
  insist(byte() === 1 && byte() === 0, 'TLS_CLIENT_HELLO');
  const extensionLength = word();
  insist(offset + extensionLength === body.length, 'TLS_CLIENT_HELLO');
  const seen = new Set();
  let serverName;
  while (offset < body.length) {
    const type = word();
    const length = word();
    insist(!seen.has(type), 'TLS_CLIENT_HELLO');
    seen.add(type);
    const extension = take(length);
    insist(type !== 0xfe0d && type !== 0xffce, 'TLS_ECH_UNSUPPORTED');
    if (type === 0) {
      insist(extension.length >= 5 && extension.readUInt16BE(0) === extension.length - 2 &&
        extension[2] === 0 && extension.readUInt16BE(3) === extension.length - 5,
      'TLS_SNI_REQUIRED');
      const name = extension.subarray(5);
      insist(name.length > 0 && [...name].every(value => value >= 33 && value <= 126), 'TLS_SNI_REQUIRED');
      try { serverName = canonicalHost(name.toString('ascii')); } catch { insist(false, 'TLS_SNI_REQUIRED'); }
    }
    if (type === 43) {
      insist(extension.length >= 3 && extension[0] === extension.length - 1 &&
        extension[0] % 2 === 0, 'TLS_CLIENT_HELLO');
      let supported = false;
      for (let index = 1; index < extension.length; index += 2) {
        if ([0x0303, 0x0304].includes(extension.readUInt16BE(index))) supported = true;
      }
      insist(supported, 'TLS_CLIENT_HELLO');
    }
  }
  insist(serverName, 'TLS_SNI_REQUIRED');
  insist(serverName === expectedHost, 'TLS_SNI_MISMATCH');
  return serverName;
}

export function parseClientHello(bytes, expectedHost) {
  insist(Buffer.isBuffer(bytes), 'TLS_FRAMING');
  insist(bytes.length <= MAX_HELLO_BYTES, 'TLS_OVERSIZE');
  let offset = 0;
  let records = 0;
  let length = 0;
  let target;
  const parts = [];
  while (offset < bytes.length) {
    if (bytes.length - offset < 5) return incomplete;
    insist(++records <= MAX_HELLO_RECORDS, 'TLS_OVERSIZE');
    insist(bytes[offset] === 22 && bytes[offset + 1] === 3 &&
      [1, 3].includes(bytes[offset + 2]), 'TLS_FRAMING');
    const recordLength = bytes.readUInt16BE(offset + 3);
    insist(recordLength >= 1 && recordLength <= 16384, 'TLS_FRAMING');
    if (bytes.length - offset - 5 < recordLength) return incomplete;
    parts.push(bytes.subarray(offset + 5, offset + 5 + recordLength));
    length += recordLength;
    offset += 5 + recordLength;
    const handshake = Buffer.concat(parts, length);
    if (handshake.length >= 4 && target === undefined) {
      insist(handshake[0] === 1, 'TLS_CLIENT_HELLO');
      target = 4 + handshake.readUIntBE(1, 3);
      insist(target >= 45 && target <= MAX_HELLO_BYTES - 5, 'TLS_OVERSIZE');
    }
    if (target !== undefined && length >= target) {
      insist(length === target && offset === bytes.length, 'TLS_PIPELINED');
      const host = parseHelloBody(handshake.subarray(4), expectedHost);
      return Object.freeze({ complete: true, host, records, bytes: offset });
    }
  }
  return incomplete;
}
