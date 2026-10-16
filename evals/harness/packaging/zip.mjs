import { inflateRawSync } from 'node:zlib';

function requireZip(condition, message) {
  if (!condition) throw new Error(`Invalid Desktop ZIP: ${message}`);
}

export function deliveryPath(value) {
  requireZip(typeof value === 'string' && value.length > 0 && !value.includes('\\') &&
    !value.includes('\0') && !value.startsWith('/') && !/^[a-z]:/i.test(value), `unsafe path ${value}`);
  const parts = value.replace(/\/$/, '').split('/');
  requireZip(parts.every(part => part && part !== '.' && part !== '..'), `unsafe path ${value}`);
  return value;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Read the central directory rather than extracting untrusted archive paths.
export function readZipEntries(bytes) {
  requireZip(Buffer.isBuffer(bytes) && bytes.length >= 22, 'missing end record');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  requireZip(end >= 0, 'missing end record');
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  requireZip(bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0 &&
    bytes.readUInt16LE(end + 8) === count, 'multi-disk archive');
  requireZip(count !== 0xffff && centralSize !== 0xffffffff && centralOffset !== 0xffffffff, 'ZIP64 unsupported');
  requireZip(centralOffset + centralSize === end, 'central directory bounds');
  const entries = new Map();
  let cursor = centralOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    requireZip(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'central entry');
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const attrs = bytes.readUInt32LE(cursor + 38);
    const local = bytes.readUInt32LE(cursor + 42);
    requireZip(cursor + 46 + nameLength + extraLength + commentLength <= end, 'entry bounds');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = deliveryPath(rawName.toString('utf8'));
    requireZip(Buffer.from(name).equals(rawName), 'non-UTF8 name unsupported');
    requireZip(!entries.has(name), `duplicate entry ${name}`);
    requireZip(!(flags & 1) && [0, 8].includes(method), `encrypted/unsupported entry ${name}`);
    requireZip(((attrs >>> 16) & 0xf000) !== 0xa000, `symlink ${name}`);
    requireZip(size <= 64 * 1024 * 1024 && (total += size) <= 256 * 1024 * 1024, 'uncompressed size limit');
    requireZip(local + 30 <= centralOffset && bytes.readUInt32LE(local) === 0x04034b50, 'local header');
    requireZip(bytes.readUInt16LE(local + 6) === flags && bytes.readUInt16LE(local + 8) === method, 'header mismatch');
    const localNameLength = bytes.readUInt16LE(local + 26);
    const dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    requireZip(bytes.subarray(local + 30, local + 30 + localNameLength).equals(rawName), 'local name mismatch');
    requireZip(dataStart + compressed <= centralOffset, 'compressed data bounds');
    const data = bytes.subarray(dataStart, dataStart + compressed);
    const content = method === 0 ? data : inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 });
    requireZip(content.length === size && crc32(content) === crc, `size/CRC mismatch ${name}`);
    requireZip(!name.endsWith('/') || size === 0, `nonempty directory ${name}`);
    entries.set(name, content);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  requireZip(cursor === end, 'extra central data');
  return entries;
}
