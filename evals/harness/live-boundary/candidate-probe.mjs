import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Duplex } from 'node:stream';
import { fixtureHello } from './fixture-hello.mjs';

const config = JSON.parse(fs.readFileSync('/boundary/config.json', 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function runtimeFacts() {
  const routes = fs.readFileSync('/proc/net/route', 'utf8');
  if (routes.length > 8192) throw new Error('fixture');
  const defaultRoutes = routes.trim().split('\n').slice(1)
    .filter(line => line.trim().split(/\s+/)[1] === '00000000').length;
  const resolver = fs.readFileSync('/etc/resolv.conf', 'utf8');
  if (resolver.length > 512) throw new Error('fixture');
  return {
    owner: config.owner, candidateId: config.candidateId ?? null,
    nodeVersion: process.versions.node, ready: true, defaultRoutes,
    resolverHash: hash(Buffer.from(resolver)),
    nameservers: resolver.split('\n').filter(line => line.startsWith('nameserver ')).map(line => line.slice(11)),
    ipv6Disabled: fs.readFileSync('/proc/sys/net/ipv6/conf/all/disable_ipv6', 'utf8').trim() === '1'
  };
}

function tcpDenied(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    let finished = false;
    const timer = setTimeout(() => finish(true), 650);
    function finish(denied) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(denied);
    }
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
  });
}

async function dnsDenied(server) {
  const resolver = new Resolver({ timeout: 600, tries: 1 });
  resolver.setServers([server]);
  const timer = setTimeout(() => resolver.cancel(), 1000);
  try {
    const answers = await resolver.resolve4('example.com');
    return answers.length === 0;
  } catch { return true; } finally { clearTimeout(timer); resolver.cancel(); }
}

function fixtureDNSDenied() {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4');
    const labels = 'egress-fixture.test'.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]));
    const header = Buffer.alloc(12);
    randomBytes(2).copy(header);
    header.writeUInt16BE(0x100, 2);
    header.writeUInt16BE(1, 4);
    const query = Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
    let finished = false;
    const timer = setTimeout(() => finish(true), 650);
    function finish(denied) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      resolve(denied);
    }
    socket.once('message', () => finish(false));
    socket.once('error', () => finish(true));
    socket.send(query, 5353, config.fixtureAddress);
  });
}

function connectRequest(host, port = 443) {
  return `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`;
}

function rejected(request, hello, truncate = false) {
  return new Promise(resolve => {
    const socket = net.connect(config.proxyPort, config.proxyAddress);
    let response = Buffer.alloc(0);
    let switched = false;
    let finished = false;
    const timer = setTimeout(() => finish(false), 4200);
    function finish(denied) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(denied);
    }
    socket.on('error', () => finish(true));
    socket.once('close', () => finish(true));
    socket.once('connect', () => socket.write(request));
    socket.on('data', chunk => {
      if (switched) { finish(false); return; }
      response = Buffer.concat([response, chunk]);
      if (response.length > 512) { finish(false); return; }
      if (response.indexOf('\r\n\r\n') < 0) return;
      if (!response.equals(Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n')) || !hello) {
        finish(false);
        return;
      }
      switched = true;
      if (truncate) socket.end(hello);
      else socket.write(hello);
    });
  });
}

async function allowedTLS() {
  const raw = net.connect(config.proxyPort, config.proxyAddress);
  raw.on('error', () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { raw.destroy(); reject(new Error('fixture')); }, 3000);
    let response = Buffer.alloc(0);
    const receive = chunk => {
      response = Buffer.concat([response, chunk]);
      if (response.length > 512) { raw.destroy(); clearTimeout(timer); reject(new Error('fixture')); return; }
      if (response.indexOf('\r\n\r\n') < 0) return;
      clearTimeout(timer);
      raw.removeListener('data', receive);
      if (response.equals(Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n'))) resolve();
      else { raw.destroy(); reject(new Error('fixture')); }
    };
    raw.once('connect', () => raw.write(connectRequest('egress-fixture.test')));
    raw.once('error', () => { clearTimeout(timer); reject(new Error('fixture')); });
    raw.on('data', receive);
  });
  const outgoing = createHash('sha256');
  const incoming = createHash('sha256');
  let outgoingBytes = 0;
  let incomingBytes = 0;
  const wire = new Duplex({
    read() { raw.resume(); },
    write(chunk, encoding, callback) {
      outgoing.update(chunk);
      outgoingBytes += chunk.length;
      raw.write(chunk, callback);
    },
    final(callback) { raw.end(callback); },
    destroy(error, callback) { raw.destroy(); callback(error); }
  });
  raw.on('data', chunk => {
    incoming.update(chunk);
    incomingBytes += chunk.length;
    if (!wire.push(chunk)) raw.pause();
  });
  raw.once('end', () => wire.push(null));
  raw.once('close', () => { if (!wire.destroyed) wire.destroy(); });
  wire.on('error', () => {});
  const connection = tls.connect({
    socket: wire, servername: 'egress-fixture.test', rejectUnauthorized: true,
    ca: fs.readFileSync('/boundary/fixture-cert.pem'),
    minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3'
  });
  const payload = Buffer.from('skill-eval-local-fixture-only\n');
  const echo = [];
  let echoBytes = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { connection.destroy(); reject(new Error('fixture')); }, 6000);
    connection.once('secureConnect', () => connection.write(payload));
    connection.on('data', chunk => {
      echoBytes += chunk.length;
      if (echoBytes > 4096) { connection.destroy(); return; }
      echo.push(chunk);
    });
    connection.once('error', () => { clearTimeout(timer); reject(new Error('fixture')); });
    connection.once('close', () => {
      clearTimeout(timer);
      if (Buffer.concat(echo).equals(payload)) resolve();
      else reject(new Error('fixture'));
    });
  });
  return {
    verifiedCertificate: true, echoHash: hash(Buffer.concat(echo)),
    outgoingHash: outgoing.digest('hex'), incomingHash: incoming.digest('hex'),
    outgoingBytes, incomingBytes
  };
}

async function probe() {
  const denial = {};
  denial.rawOutside = await tcpDenied(config.fixtureAddress ?? '198.51.100.1', 443);
  denial.rawDocumentationIP = await tcpDenied('198.51.100.1', 443);
  denial.metadataRoute = await tcpDenied('169.254.169.254', 80);
  denial.relayOtherPort = await tcpDenied(config.proxyAddress, 53);
  denial.configuredDNS = await dnsDenied('127.0.0.1');
  denial.dockerEmbeddedDNS = await dnsDenied('127.0.0.11');
  denial.rawOutsideDNS = await dnsDenied('1.1.1.1');
  if (config.fixtureAddress) denial.fixtureOutsideDNS = await fixtureDNSDenied();
  denial.http = await rejected('GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n');
  denial.badHost = await rejected(connectRequest('unknown-fixture.test'));
  denial.ipAuthority = await rejected(connectRequest('127.0.0.1'));
  denial.port = await rejected(connectRequest(config.hosts[0], 80));
  denial.badSNI = await rejected(connectRequest(config.hosts[0]), fixtureHello('mismatch.example.com'));
  denial.missingSNI = await rejected(connectRequest(config.hosts[0]), fixtureHello(config.hosts[0], { omitSNI: true }));
  denial.ech = await rejected(connectRequest(config.hosts[0]), fixtureHello(config.hosts[0], { ech: true }));
  denial.plaintextTunnel = await rejected(connectRequest(config.hosts[0]), Buffer.from('GET / HTTP/1.1\r\n\r\n'));
  const hello = fixtureHello(config.hosts[0]);
  denial.pipelinedHello = await rejected(connectRequest(config.hosts[0]), Buffer.concat([hello, hello]));
  denial.truncatedHello = await rejected(connectRequest(config.hosts[0]), hello.subarray(0, 12), true);
  denial.oversizeHello = await rejected(connectRequest(config.hosts[0]), Buffer.from([22, 3, 1, 0, 4, 1, 1, 0, 0]));
  denial.pipelinedConnect = await rejected(connectRequest(config.hosts[0]) + connectRequest(config.hosts[0]));
  let allowed = null;
  if (config.fixtureAddress) {
    denial.privateDNS = await rejected(connectRequest('private-fixture.test'), fixtureHello('private-fixture.test'));
    denial.rebindingDNS = await rejected(connectRequest('rebind-fixture.test'), fixtureHello('rebind-fixture.test'));
    denial.unknownDNS = await rejected(connectRequest('unresolved-fixture.test'), fixtureHello('unresolved-fixture.test'));
    allowed = await allowedTLS();
  }
  return {
    owner: config.owner, candidateId: config.candidateId ?? null, nodeVersion: process.versions.node,
    issuer: config.fixtureAddress ? 'local-fixture-issuer-only' : 'public-exact-dns-tls-443',
    denied: denial, allowed
  };
}

try {
  if (process.argv[2] === '--idle') {
    for (const directory of config.profile?.directories ?? []) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync('/scratch/candidate-state.json', JSON.stringify(runtimeFacts()));
    setTimeout(() => process.exit(0), Math.max(1, config.expiresAt - Date.now()));
  } else if (process.argv[2] === '--inspect') {
    process.stdout.write(JSON.stringify(runtimeFacts()));
  } else if (process.argv[2] === '--probe') {
    process.stdout.write(JSON.stringify(await probe()));
  } else process.exitCode = 70;
} catch {
  process.stderr.write('Boundary probe infrastructure failure\n');
  process.exitCode = 70;
}
