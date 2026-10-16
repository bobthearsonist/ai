export function fixtureHello(host, { omitSNI = false, ech = false } = {}) {
  const name = Buffer.from(host, 'ascii');
  const sni = Buffer.alloc(9 + name.length);
  sni.writeUInt16BE(0, 0);
  sni.writeUInt16BE(5 + name.length, 2);
  sni.writeUInt16BE(3 + name.length, 4);
  sni[6] = 0;
  sni.writeUInt16BE(name.length, 7);
  name.copy(sni, 9);
  const extensions = Buffer.concat([
    ...(omitSNI ? [] : [sni]),
    ...(ech ? [Buffer.from([0xfe, 0x0d, 0, 1, 0])] : [])
  ]);
  const extensionLength = Buffer.alloc(2);
  extensionLength.writeUInt16BE(extensions.length);
  const body = Buffer.concat([
    Buffer.from([3, 3]), Buffer.alloc(32, 1), Buffer.from([0, 0, 2, 0x13, 1, 1, 0]),
    extensionLength, extensions
  ]);
  const handshake = Buffer.alloc(4);
  handshake[0] = 1;
  handshake.writeUIntBE(body.length, 1, 3);
  const record = Buffer.alloc(5);
  record[0] = 22; record[1] = 3; record[2] = 1;
  record.writeUInt16BE(handshake.length + body.length, 3);
  return Buffer.concat([record, handshake, body]);
}
