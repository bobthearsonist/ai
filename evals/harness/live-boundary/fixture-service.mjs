import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { FIXTURE_HOSTS } from './fixture-identity.mjs';

let stage = 'CONFIGURATION';
function infrastructureFailure(error) {
  const detail = error?.code === 'EACCES' ? ' PERMISSION' : error?.code === 'EADDRINUSE' ? ' ADDRESS_IN_USE' : '';
  process.stderr.write(`Local fixture infrastructure failure: ${stage}${detail}\n`);
  process.exit(70);
}
process.on('uncaughtException', infrastructureFailure);
process.on('unhandledRejection', infrastructureFailure);

const config = JSON.parse(fs.readFileSync('/boundary/config.json', 'utf8'));
const sessions = [];
const sockets = new Set();
const status = {
  version: 1, owner: config.owner, issuer: 'local-fixture-issuer-only',
  nodeVersion: process.versions.node, ready: false, dnsQueries: 0, sessions,
  unprivilegedPortStart: Number(fs.readFileSync('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8').trim())
};
function persist() {
  fs.writeFileSync('/scratch/fixture-state.json.new', JSON.stringify(status), { mode: 0o600 });
  fs.renameSync('/scratch/fixture-state.json.new', '/scratch/fixture-state.json');
}
function track(socket) {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket));
  return socket;
}
stage = 'TLS_CONTEXT';
const echo = tls.createServer({
  key: fs.readFileSync('/boundary/fixture-key.pem'),
  cert: fs.readFileSync('/boundary/fixture-cert.pem'),
  minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3'
}, socket => {
  track(socket);
  let bytes = 0;
  socket.setTimeout(3000, () => socket.destroy());
  socket.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 4096) socket.destroy();
    else socket.end(chunk);
  });
});
echo.on('tlsClientError', () => {});
stage = 'TLS_LISTEN';
await new Promise(resolve => echo.listen(8443, '127.0.0.1', resolve));
const server = net.createServer(raw => {
  track(raw);
  if (sessions.length >= 16) { raw.destroy(); return; }
  const inner = track(net.connect(8443, '127.0.0.1'));
  const incoming = createHash('sha256');
  const outgoing = createHash('sha256');
  const record = { incomingBytes: 0, outgoingBytes: 0, closed: false };
  sessions.push(record);
  raw.on('data', chunk => { incoming.update(chunk); record.incomingBytes += chunk.length; });
  inner.on('data', chunk => { outgoing.update(chunk); record.outgoingBytes += chunk.length; });
  raw.setTimeout(5000, () => raw.destroy());
  raw.pipe(inner);
  inner.pipe(raw);
  raw.once('close', () => {
    inner.destroy();
    record.closed = true;
    record.incomingHash = incoming.digest('hex');
    record.outgoingHash = outgoing.digest('hex');
    persist();
  });
});
stage = 'TCP_LISTEN';
await new Promise(resolve => server.listen(443, '0.0.0.0', resolve));

let rebind = 0;
const dns = dgram.createSocket('udp4');
dns.on('error', () => {});
dns.on('message', (query, remote) => {
  if (query.length < 17 || query.length > 512 || query.readUInt16BE(4) !== 1) return;
  let offset = 12;
  const labels = [];
  while (offset < query.length && query[offset] !== 0) {
    const count = query[offset++];
    if (count > 63 || offset + count > query.length) return;
    labels.push(query.subarray(offset, offset + count).toString('ascii'));
    offset += count;
  }
  if (offset + 5 > query.length) return;
  offset++;
  const type = query.readUInt16BE(offset);
  const end = offset + 4;
  const host = labels.join('.');
  if (host === 'rebind-fixture.test' && type === 1) rebind++;
  const answer = host === 'private-fixture.test' ? '127.0.0.1'
    : host === 'rebind-fixture.test' && rebind > 1 ? '1.1.1.1' : config.fixtureAddress;
  const known = FIXTURE_HOSTS.includes(host) && host !== 'unresolved-fixture.test';
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(known ? 0x8180 : 0x8183, 2);
  header.writeUInt16BE(1, 4);
  const parts = [header, query.subarray(12, end)];
  if (known && type === 1) {
    header.writeUInt16BE(1, 6);
    parts.push(Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4]),
      Buffer.from(answer.split('.').map(Number)));
  }
  status.dnsQueries = Math.min(100000, status.dnsQueries + 1);
  dns.send(Buffer.concat(parts), remote.port, remote.address);
  persist();
});
stage = 'DNS_LISTEN';
await new Promise(resolve => dns.bind(5353, '0.0.0.0', resolve));
stage = 'READY';
status.ready = true;
persist();
function stop() {
  for (const socket of sockets) socket.destroy();
  dns.close();
  server.close();
  echo.close();
  status.ready = false;
  persist();
  setTimeout(() => process.exit(0), 50);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
setTimeout(stop, Math.max(1, config.expiresAt - Date.now()));
