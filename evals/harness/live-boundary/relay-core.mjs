import net from 'node:net';
import fs from 'node:fs';
import { Resolver } from 'node:dns/promises';
import { EgressBoundaryError, insist, sanitizedError } from './errors.mjs';
import { assertConnectedPeer, assertPublicAddress, validateAnswerSet, verifyAnswerSets } from './policy.mjs';
import { MAX_HELLO_BYTES, parseClientHello, parseConnect } from './protocol.mjs';

const MAX_CONNECTIONS = 16;
const HANDSHAKE_MS = 3000;
const CONNECT_MS = 2000;
const TUNNEL_MS = 15000;

export async function resolveComplete(host, signal, servers) {
  const resolver = new Resolver({ timeout: 700, tries: 1 });
  if (servers) resolver.setServers(servers);
  const abort = () => resolver.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new EgressBoundaryError('CANCELLED');
    const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    const addresses = [];
    for (const result of results) {
      if (result.status === 'fulfilled') addresses.push(...result.value);
      else insist(result.reason?.code === 'ENODATA', signal?.aborted ? 'CANCELLED' : 'DNS_UNRESOLVED');
    }
    insist(addresses.length > 0, 'DNS_UNRESOLVED');
    return addresses;
  } finally { signal?.removeEventListener('abort', abort); }
}

function dial(address, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new EgressBoundaryError('CANCELLED')); return; }
    const socket = net.connect({ host: address, port: 443, family: net.isIP(address) });
    let settled = false;
    const timer = setTimeout(() => fail('UPSTREAM_UNAVAILABLE'), CONNECT_MS);
    const abort = () => fail('CANCELLED');
    function fail(code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.destroy();
      reject(new EgressBoundaryError(code));
    }
    signal.addEventListener('abort', abort, { once: true });
    socket.once('error', () => fail('UPSTREAM_UNAVAILABLE'));
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(socket);
    });
  });
}

export async function startRelay({
  policy, owner, listenAddress, expiresAt, stateFile,
  resolve = resolveComplete, authorizeAddress = assertPublicAddress
}) {
  insist(net.isIP(listenAddress) === 4 && typeof owner === 'string' &&
    /^[a-f0-9-]{36}$/.test(owner) && Number.isFinite(expiresAt) &&
    expiresAt > Date.now() && expiresAt <= Date.now() + 300000, 'INVALID_ARGUMENT');
  const sockets = new Set();
  const requests = new Set();
  const metrics = {
    version: 1, owner, issuer: policy.issuer, policyHash: policy.policyHash,
    nodeVersion: process.versions.node, ready: false, closed: false,
    accepted: 0, denied: {}, approvedHosts: {}
  };
  function persist() {
    const text = JSON.stringify(metrics);
    insist(text.length <= 8192, 'OUTPUT_LIMIT');
    fs.writeFileSync(`${stateFile}.new`, text, { mode: 0o600 });
    fs.renameSync(`${stateFile}.new`, stateFile);
  }
  function denied(code) {
    const stable = sanitizedError(new EgressBoundaryError(code)).code;
    metrics.denied[stable] = Math.min(100000, (metrics.denied[stable] ?? 0) + 1);
    persist();
  }
  function track(socket) {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    return socket;
  }
  const server = net.createServer(socket => {
    track(socket);
    if (requests.size >= MAX_CONNECTIONS) {
      denied('CONNECTION_LIMIT');
      socket.destroy();
      return;
    }
    const controller = new AbortController();
    requests.add(controller);
    let phase = 'connect';
    let bytes = Buffer.alloc(0);
    let host;
    let upstream;
    let finished = false;
    let timer = setTimeout(() => fail('TIMEOUT'), HANDSHAKE_MS);
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      controller.abort();
      requests.delete(controller);
      upstream?.destroy();
      socket.destroy();
    }
    function fail(code) {
      if (finished) return;
      denied(code);
      finish();
    }
    socket.once('close', () => {
      if (!finished && phase !== 'tunnel') denied(phase === 'connect' ? 'CONNECT_TRUNCATED' : 'TLS_TRUNCATED');
      finish();
    });
    socket.once('end', () => {
      if (phase !== 'tunnel') fail(phase === 'connect' ? 'CONNECT_TRUNCATED' : 'TLS_TRUNCATED');
    });
    async function authorizeAndConnect(hello) {
      try {
        const first = await resolve(host, controller.signal);
        validateAnswerSet(first, authorizeAddress);
        const second = await resolve(host, controller.signal);
        verifyAnswerSets(first, second, authorizeAddress);
        const address = [...first].sort((left, right) => net.isIP(left) - net.isIP(right))[0];
        upstream = track(await dial(address, controller.signal));
        assertConnectedPeer(address, upstream.remoteAddress, authorizeAddress);
        const final = await resolve(host, controller.signal);
        verifyAnswerSets(first, final, authorizeAddress);
        if (finished || controller.signal.aborted) { upstream.destroy(); return; }
        clearTimeout(timer);
        timer = setTimeout(() => fail('TIMEOUT'), Math.min(TUNNEL_MS, expiresAt - Date.now()));
        phase = 'tunnel';
        socket.removeListener('data', receive);
        upstream.once('close', finish);
        upstream.setTimeout(5000, () => fail('TIMEOUT'));
        socket.setTimeout(5000, () => fail('TIMEOUT'));
        metrics.accepted = Math.min(100000, metrics.accepted + 1);
        metrics.approvedHosts[host] = Math.min(100000, (metrics.approvedHosts[host] ?? 0) + 1);
        persist();
        upstream.write(hello);
        socket.pipe(upstream);
        upstream.pipe(socket);
        socket.resume();
      } catch (error) {
        upstream?.destroy();
        fail(sanitizedError(error).code);
      }
    }
    function receive(chunk) {
      try {
        insist(phase !== 'connecting', 'TLS_PIPELINED');
        insist(bytes.length + chunk.length <= (phase === 'connect' ? 4096 : MAX_HELLO_BYTES),
          phase === 'connect' ? 'CONNECT_OVERSIZE' : 'TLS_OVERSIZE');
        bytes = Buffer.concat([bytes, chunk]);
        if (phase === 'connect') {
          const connect = parseConnect(bytes, policy);
          if (!connect.complete) return;
          host = connect.host;
          phase = 'hello';
          bytes = Buffer.alloc(0);
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          return;
        }
        const hello = parseClientHello(bytes, host);
        if (!hello.complete) return;
        phase = 'connecting';
        socket.pause();
        const wire = bytes;
        bytes = Buffer.alloc(0);
        void authorizeAndConnect(wire);
      } catch (error) { fail(sanitizedError(error).code); }
    }
    socket.on('data', receive);
  });
  server.maxConnections = MAX_CONNECTIONS + 1;
  let closePromise;
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      for (const controller of requests) controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      metrics.ready = false;
      metrics.closed = true;
      persist();
    })();
    return closePromise;
  }
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new EgressBoundaryError('INTERNAL_FAILURE')));
    server.listen({ host: listenAddress, port: 8080, backlog: 16 }, resolve);
  });
  metrics.ready = true;
  persist();
  const expiration = setTimeout(() => { void close(); }, expiresAt - Date.now());
  return {
    metrics,
    async close() {
      clearTimeout(expiration);
      await close();
    }
  };
}
