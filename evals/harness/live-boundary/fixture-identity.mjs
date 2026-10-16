import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

export const FIXTURE_HOSTS = Object.freeze([
  'egress-fixture.test', 'private-fixture.test', 'rebind-fixture.test', 'unresolved-fixture.test'
]);

function der(tag, ...parts) {
  const content = Buffer.concat(parts);
  let length;
  if (content.length < 128) length = Buffer.from([content.length]);
  else {
    const hex = content.length.toString(16).padStart(Math.ceil(content.length.toString(16).length / 2) * 2, '0');
    const bytes = Buffer.from(hex, 'hex');
    length = Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, content]);
}
const sequence = (...parts) => der(0x30, ...parts);
function oid(text) {
  const numbers = text.split('.').map(Number);
  const bytes = [numbers[0] * 40 + numbers[1]];
  for (const number of numbers.slice(2)) {
    const value = [number & 127];
    let remaining = Math.floor(number / 128);
    while (remaining) { value.unshift((remaining & 127) | 128); remaining = Math.floor(remaining / 128); }
    bytes.push(...value);
  }
  return der(0x06, Buffer.from(bytes));
}
function pem(type, bytes) {
  return `-----BEGIN ${type}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${type}-----\n`;
}

export function createFixtureIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = sequence(oid('1.2.840.10045.4.3.2'));
  const name = sequence(der(0x31, sequence(oid('2.5.4.3'),
    der(0x0c, Buffer.from('Skill Eval Local Fixture Only Test Issuer')))));
  const extension = (id, value) => sequence(oid(id), der(0x04, value));
  const serial = randomBytes(16);
  serial[0] |= 0x80;
  const body = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.concat([Buffer.from([0]), serial])),
    algorithm, name,
    sequence(der(0x17, Buffer.from('260101000000Z')), der(0x17, Buffer.from('360101000000Z'))),
    name, publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(
      extension('2.5.29.17', sequence(der(0x82, Buffer.from(FIXTURE_HOSTS[0])))),
      extension('2.5.29.19', sequence(der(0x01, Buffer.from([0xff])))),
      extension('2.5.29.37', sequence(oid('1.3.6.1.5.5.7.3.1')))
    ))
  );
  const certificate = sequence(body, algorithm, der(0x03, Buffer.from([0]), sign('sha256', body, privateKey)));
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    certificate: pem('CERTIFICATE', certificate),
    certificateHash: createHash('sha256').update(certificate).digest('hex')
  };
}
