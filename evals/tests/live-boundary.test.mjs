import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, X509Certificate } from 'node:crypto';
import {
  assertEgressCandidate, attachEgressCandidate, describeEgressBoundary, describeEgressCandidate,
  EgressBoundaryError, inspectEgressCandidate, prepareEgressCandidate, runLocalEgressBoundaryLab,
  startEgressBoundary, stopEgressBoundary, stopEgressCandidate
} from '../harness/live-boundary/index.mjs';
import {
  addressKey, assertConnectedPeer, assertPublicAddress, canonicalHost,
  createPublicPolicy, verifyAnswerSets
} from '../harness/live-boundary/policy.mjs';
import {
  MAX_CONNECT_BYTES, MAX_HELLO_BYTES, parseClientHello, parseConnect
} from '../harness/live-boundary/protocol.mjs';
import { createFixtureIdentity, FIXTURE_HOSTS } from '../harness/live-boundary/fixture-identity.mjs';
import { fixtureHello } from '../harness/live-boundary/fixture-hello.mjs';
import {
  CANDIDATE_LABEL, INTERNAL_OPTIONS, ISSUER_LABEL, OWNER_LABEL, ROLE_LABEL, isExactResourceAbsence, measureConfinement,
  observedNetworkIds, validateAttachmentGraph, validateOwnedContainer, validateOwnedNetwork
} from '../harness/live-boundary/ownership.mjs';
import { retryStartingExec, runBoundedProcess, sanitizedDockerEnvironment } from '../harness/live-boundary/supervision.mjs';
import {
  CANDIDATE_PROFILES, assertCandidateSeedIdentity, createCandidateSeed, destroyCandidateSeed,
  inspectCandidateSeed, sealCandidateSeed
} from '../harness/live-boundary/candidate-seed.mjs';

const moduleRoot = fileURLToPath(new URL('../harness/live-boundary/', import.meta.url));
const policy = createPublicPolicy(['api.example.com']);
const request = host => Buffer.from(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
const code = expected => error => error instanceof EgressBoundaryError &&
  error.classification === 'infrastructure' && error.code === expected;

test('exact policy is canonical, bounded, sorted, frozen and content hashed', () => {
  const first = createPublicPolicy(['service.example.com', 'api.example.com']);
  const second = createPublicPolicy(['api.example.com', 'service.example.com']);
  assert.deepEqual(first.hosts, ['api.example.com', 'service.example.com']);
  assert.equal(first.policyHash, second.policyHash);
  assert.equal(first.policyHash.length, 64);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.hosts));
  assert.throws(() => createPublicPolicy([]), code('INVALID_POLICY'));
  assert.throws(() => createPublicPolicy(Array(33).fill('api.example.com')), code('INVALID_POLICY'));
  assert.throws(() => createPublicPolicy(['api.example.com', 'api.example.com']), code('INVALID_POLICY'));
  assert.throws(() => createPublicPolicy(new Array(1)), code('INVALID_POLICY'));
  assert.throws(() => createPublicPolicy(new Proxy(['api.example.com'], {})), code('INVALID_POLICY'));
  assert.throws(() => createPublicPolicy(Object.defineProperty(['api.example.com'], '0', {
    get() { throw new Error('secret-array-getter'); }
  })), code('INVALID_POLICY'));
});

test('policy rejects IP aliases, userinfo, URLs, wildcard, Unicode and ambiguous names without echo', () => {
  for (const host of [
    '127.0.0.1', '127.1', '0x7f000001', '2130706433', '[::1]', 'api.example.com.',
    'API.example.com', '*.example.com', 'https://api.example.com', 'secret@api.example.com',
    'api.example.com:443', 'a..example.com', '-a.example.com', 'a-.example.com',
    'xn--secret.example.com', 'é.example.com', 'api.example.com\nsecret', 'api\\example.com',
    'service.local', 'service.internal', 'egress-fixture.test', 'service.invalid',
    `a${'b'.repeat(63)}.example.com`
  ]) {
    assert.throws(() => createPublicPolicy([host]), error =>
      code('INVALID_HOST')(error) && !error.message.includes(host));
  }
  assert.equal(canonicalHost('service-1.example.com'), 'service-1.example.com');
});

test('every public DNS answer must be global, including mapped and special IPv6 ranges', () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '100.127.255.254', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '172.31.255.1', '192.168.1.1', '192.0.0.1', '192.0.2.1', '192.88.99.1',
    '198.18.1.1', '198.19.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '168.63.129.16', '::', '::1', '::ffff:8.8.8.8', 'fe80::1', 'fc00::1', 'ff02::1',
    '64:ff9b::808:808', '2001::1', '2001:2::1', '2001:db8::1', '2002:7f00:1::1',
    '3fff::1', 'fe80::1%eth0', '127.1', '008.008.008.008'
  ]) assert.throws(() => assertPublicAddress(address), code('DNS_NONPUBLIC'));
  assert.equal(assertPublicAddress('8.8.8.8'), '4:8.8.8.8');
  assert.equal(assertPublicAddress('2606:4700:4700::1111'), addressKey('2606:4700:4700::1111'));
});

test('DNS checks reject mixed private answers, set rebinding and numeric peer mismatch', () => {
  assert.deepEqual(verifyAnswerSets(['8.8.8.8', '1.1.1.1'], ['1.1.1.1', '8.8.8.8']),
    ['4:1.1.1.1', '4:8.8.8.8']);
  assert.throws(() => verifyAnswerSets(['8.8.8.8', '127.0.0.1'], ['8.8.8.8']), code('DNS_NONPUBLIC'));
  assert.throws(() => verifyAnswerSets(['8.8.8.8'], ['1.1.1.1']), code('DNS_REBINDING'));
  assert.throws(() => verifyAnswerSets([], []), code('DNS_UNRESOLVED'));
  assert.throws(() => verifyAnswerSets(Array(17).fill('8.8.8.8'), ['8.8.8.8']), code('DNS_UNRESOLVED'));
  assert.throws(() => assertConnectedPeer('8.8.8.8', '1.1.1.1'), code('PEER_MISMATCH'));
  assert.throws(() => assertConnectedPeer('8.8.8.8', '::ffff:8.8.8.8'), code('DNS_NONPUBLIC'));
  assertConnectedPeer('2606:4700::1111', '2606:4700:0:0:0:0:0:1111');
});

test('CONNECT parsing waits for bounded complete framing and accepts only the supported form', () => {
  const bytes = request('api.example.com');
  for (let index = 0; index < bytes.length; index++) assert.equal(parseConnect(bytes.subarray(0, index), policy).complete, false);
  assert.deepEqual(parseConnect(bytes, policy), { complete: true, host: 'api.example.com' });
  const keepAlive = Buffer.from('CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\nProxy-Connection: Keep-Alive\r\nUser-Agent: fixture-only\r\n\r\n');
  assert.equal(parseConnect(keepAlive, policy).complete, true);
});

test('CONNECT rejects methods, ports, alternate authorities and hosts', () => {
  for (const [text, expected] of [
    ['GET http://api.example.com/ HTTP/1.1\r\nHost: api.example.com\r\n\r\n', 'CONNECT_METHOD'],
    ['CONNECT api.example.com:80 HTTP/1.1\r\nHost: api.example.com:80\r\n\r\n', 'CONNECT_AUTHORITY'],
    ['CONNECT api.example.com:0443 HTTP/1.1\r\nHost: api.example.com:0443\r\n\r\n', 'CONNECT_AUTHORITY'],
    ['CONNECT https://api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n', 'CONNECT_AUTHORITY'],
    ['CONNECT secret@api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n', 'CONNECT_AUTHORITY'],
    ['CONNECT 127.1:443 HTTP/1.1\r\nHost: 127.1:443\r\n\r\n', 'CONNECT_AUTHORITY'],
    ['CONNECT api.example.com:443 HTTP/1.0\r\nHost: api.example.com:443\r\n\r\n', 'CONNECT_AUTHORITY'],
    [request('unapproved.example.com').toString(), 'HOST_DENIED']
  ]) assert.throws(() => parseConnect(Buffer.from(text), policy), code(expected));
});

test('CONNECT rejects credential/body headers, duplicates, header ambiguity and pipelining', () => {
  for (const headers of [
    'Host: api.example.com:443\r\nHost: api.example.com:443',
    'Host: other.example.com:443',
    'Host: api.example.com:443\r\nContent-Length: 0',
    'Host: api.example.com:443\r\nTransfer-Encoding: chunked',
    'Host: api.example.com:443\r\nProxy-Authorization: secret-fixture',
    ' Host: api.example.com:443',
    'Host: api.example.com:443\r\nConnection: upgrade',
    'Host: api.example.com:443\r\nX-Unknown: ignored',
    `Host: api.example.com:443\r\nUser-Agent: ${'a'.repeat(513)}`
  ]) assert.throws(() => parseConnect(Buffer.from(`CONNECT api.example.com:443 HTTP/1.1\r\n${headers}\r\n\r\n`), policy),
    error => code('CONNECT_HEADERS')(error) && !error.message.includes('secret-fixture'));
  assert.throws(() => parseConnect(Buffer.concat([request('api.example.com'), Buffer.from('extra')]), policy), code('CONNECT_PIPELINED'));
  assert.throws(() => parseConnect(Buffer.alloc(MAX_CONNECT_BYTES + 1), policy), code('CONNECT_OVERSIZE'));
});

test('ClientHello parser consumes exact canonical SNI and every TCP partial prefix', () => {
  const hello = fixtureHello('api.example.com');
  for (let index = 0; index < hello.length; index++) {
    assert.equal(parseClientHello(hello.subarray(0, index), 'api.example.com').complete, false);
  }
  const parsed = parseClientHello(hello, 'api.example.com');
  assert.equal(parsed.complete, true);
  assert.equal(parsed.host, 'api.example.com');
  assert.equal(parsed.records, 1);
});

test('bounded ClientHello fragmentation over records is supported without discarding bytes', () => {
  const hello = fixtureHello('api.example.com').subarray(5);
  const chunks = [hello.subarray(0, 2), hello.subarray(2, 17), hello.subarray(17)];
  const wire = Buffer.concat(chunks.map(chunk => {
    const header = Buffer.from([22, 3, 1, 0, 0]);
    header.writeUInt16BE(chunk.length, 3);
    return Buffer.concat([header, chunk]);
  }));
  assert.equal(parseClientHello(wire, 'api.example.com').records, 3);
  for (let index = 0; index < wire.length; index++) {
    assert.equal(parseClientHello(wire.subarray(0, index), 'api.example.com').complete, false);
  }
});

test('SNI mismatch, absent SNI and ECH never produce a verified classification', () => {
  assert.throws(() => parseClientHello(fixtureHello('other.example.com'), 'api.example.com'), code('TLS_SNI_MISMATCH'));
  assert.throws(() => parseClientHello(fixtureHello('api.example.com', { omitSNI: true }), 'api.example.com'), code('TLS_SNI_REQUIRED'));
  assert.throws(() => parseClientHello(fixtureHello('api.example.com', { ech: true }), 'api.example.com'), code('TLS_ECH_UNSUPPORTED'));
  assert.throws(() => parseClientHello(fixtureHello('API.example.com'), 'api.example.com'), code('TLS_SNI_REQUIRED'));
  assert.throws(() => parseClientHello(fixtureHello('127.0.0.1'), 'api.example.com'), code('TLS_SNI_REQUIRED'));
});

test('ClientHello rejects malformed, oversized, additional and pipelined framing', () => {
  const hello = fixtureHello('api.example.com');
  assert.throws(() => parseClientHello(Buffer.concat([hello, hello]), 'api.example.com'), code('TLS_PIPELINED'));
  assert.throws(() => parseClientHello(Buffer.concat([hello, Buffer.from([0])]), 'api.example.com'), code('TLS_PIPELINED'));
  assert.throws(() => parseClientHello(Buffer.alloc(MAX_HELLO_BYTES + 1), 'api.example.com'), code('TLS_OVERSIZE'));
  assert.throws(() => parseClientHello(Buffer.from([22, 3, 1, 0, 4, 1, 1, 0, 0]), 'api.example.com'), code('TLS_OVERSIZE'));
  for (const prefix of [
    [23, 3, 3, 0, 1, 0], [22, 3, 2, 0, 1, 0], [22, 3, 1, 0, 0], [22, 3, 1, 0x40, 1]
  ]) assert.throws(() => parseClientHello(Buffer.from(prefix), 'api.example.com'), code('TLS_FRAMING'));
  const notHello = Buffer.from(hello); notHello[5] = 2;
  assert.throws(() => parseClientHello(notHello, 'api.example.com'), code('TLS_CLIENT_HELLO'));
});

test('duplicate TLS extensions and malformed length vectors are rejected', () => {
  const hello = fixtureHello('api.example.com');
  const duplicate = Buffer.concat([hello, hello.subarray(52)]);
  duplicate.writeUInt16BE(duplicate.length - 5, 3);
  duplicate.writeUIntBE(duplicate.length - 9, 6, 3);
  duplicate.writeUInt16BE(duplicate.length - 52, 50);
  assert.throws(() => parseClientHello(duplicate, 'api.example.com'), code('TLS_CLIENT_HELLO'));
  const malformed = Buffer.from(hello); malformed.writeUInt16BE(1, 44);
  assert.throws(() => parseClientHello(malformed, 'api.example.com'), code('TLS_CLIENT_HELLO'));
  const fragments = Buffer.concat(Array.from({ length: 9 }, (_, index) => {
    const chunk = hello.subarray(5).subarray(index * 8, index === 8 ? undefined : (index + 1) * 8);
    const header = Buffer.from([22, 3, 1, 0, chunk.length]);
    return Buffer.concat([header, chunk]);
  }));
  assert.throws(() => parseClientHello(fragments, 'api.example.com'), code('TLS_OVERSIZE'));
});

test('public arguments are synchronous, explicit and fail closed before Docker or any fixture override', () => {
  const args = { hosts: ['api.example.com'], timeoutSeconds: 30, mode: 'egress-only' };
  for (const change of [
    { timeoutSeconds: 0 }, { timeoutSeconds: 301 }, { timeoutSeconds: 1.5 },
    { mode: undefined }, { mode: 'fixture' }, { image: 'node:latest' },
    { fixture: true }, { fixtureAddress: '127.0.0.1' }, { egressVerified: true },
    { signal: {} }, { preparedHome: 'personal' }
  ]) assert.throws(() => startEgressBoundary({ ...args, ...change }), code('INVALID_ARGUMENT'));
  assert.throws(() => startEgressBoundary({ ...args, [Symbol('fixture')]: true }), code('INVALID_ARGUMENT'));
  assert.throws(() => startEgressBoundary(new Proxy(args, {})), code('INVALID_ARGUMENT'));
  assert.throws(() => startEgressBoundary(Object.defineProperty({ ...args }, 'fixture', { value: true })),
    code('INVALID_ARGUMENT'));
  assert.throws(() => startEgressBoundary({ ...args, mode: 'live' }), code('LIVE_BOUNDARY_UNVERIFIED'));
  assert.throws(() => startEgressBoundary({ ...args, hosts: [FIXTURE_HOSTS[0]] }), code('INVALID_HOST'));
  assert.throws(() => startEgressBoundary(Object.defineProperty({ ...args }, 'hosts', {
    get() { throw new Error('secret-getter'); }
  })), error => code('INVALID_ARGUMENT')(error) && !error.message.includes('secret-getter'));
  assert.throws(() => runLocalEgressBoundaryLab({ timeoutSeconds: 30, hosts: ['api.example.com'] }), code('INVALID_ARGUMENT'));
  const native = new AbortController().signal;
  Object.defineProperty(native, 'aborted', { get() { throw new Error('secret-abort-getter'); } });
  assert.throws(() => startEgressBoundary({ ...args, mode: 'live', signal: native }), code('LIVE_BOUNDARY_UNVERIFIED'));
  assert.throws(() => startEgressBoundary({ ...args, signal: new Proxy(new AbortController().signal, {}) }),
    code('INVALID_ARGUMENT'));
});

test('process-owned handle API rejects cloned receipts, booleans and external names synchronously', () => {
  for (const value of [
    undefined, null, true, Object.freeze({ owner: randomUUID(), kind: 'process-owned-egress-boundary' }),
    { egressVerified: true, networkId: 'external', fixtureOnly: false }
  ]) {
    assert.throws(() => describeEgressBoundary(value), code('INVALID_HANDLE'));
    assert.throws(() => stopEgressBoundary(value), code('INVALID_HANDLE'));
  }
});

test('candidate attachment rejects caller IDs, image handles, credentials, callbacks and forged originals before Docker', () => {
  const boundary = Object.freeze({ owner: randomUUID(), kind: 'process-owned-egress-boundary' });
  const candidate = Object.freeze({ id: randomUUID(), kind: 'process-owned-egress-candidate' });
  for (const value of [undefined, null, true, candidate, boundary, new Proxy(candidate, {}), JSON.stringify(candidate)]) {
    assert.throws(() => prepareEgressCandidate(value, { client: 'opencode' }), code('INVALID_HANDLE'));
    assert.throws(() => describeEgressCandidate(value), code('INVALID_HANDLE'));
    assert.throws(() => attachEgressCandidate(value), code('INVALID_HANDLE'));
    assert.throws(() => inspectEgressCandidate(value), code('INVALID_HANDLE'));
    assert.throws(() => stopEgressCandidate(value), code('INVALID_HANDLE'));
    assert.throws(() => assertEgressCandidate(value, { boundary, client: 'opencode' }), code('INVALID_HANDLE'));
  }
  const options = { client: 'opencode' };
  for (const change of [
    { client: 'unknown' }, { client: undefined }, { image: 'node:latest' },
    { imageHandle: Object.freeze({ image: 'caller-tag' }) }, { containerId: 'external' },
    { nativeRuntimeVerified: true }, { credentialProfile: 'personal' }, { authRoot: 'personal' },
    { proof: () => true }, { proxyURL: 'http://caller' }, { mode: 'live' }, { fixture: true }
  ]) assert.throws(() => prepareEgressCandidate(boundary, { ...options, ...change }), code('INVALID_ARGUMENT'));
  assert.throws(() => prepareEgressCandidate(boundary, new Proxy(options, {})), code('INVALID_ARGUMENT'));
  assert.throws(() => prepareEgressCandidate(boundary, { ...options, [Symbol('receipt')]: true }), code('INVALID_ARGUMENT'));
  assert.throws(() => prepareEgressCandidate(boundary, Object.defineProperty({}, 'client', {
    get() { throw new Error('fixture-secret-getter'); }
  })), code('INVALID_ARGUMENT'));
  assert.throws(() => prepareEgressCandidate(boundary, {
    client: { toString() { throw new Error('fixture-secret-coercion'); } }
  }), code('INVALID_ARGUMENT'));
  assert.throws(() => assertEgressCandidate(candidate, { boundary, client: 'opencode', verified: true }),
    code('INVALID_ARGUMENT'));
  for (const fn of [describeEgressCandidate, attachEgressCandidate, inspectEgressCandidate, stopEgressCandidate]) {
    assert.throws(() => fn(candidate, { fixture: true }), code('INVALID_ARGUMENT'));
  }
});

test('candidate staging is originally issued, bounded, sealed, marker-bound and cleanup-idempotent', () => {
  const seed = createCandidateSeed(randomUUID(), 'opencode');
  const filename = path.join(seed.directory, 'runtime', 'public-placeholder.txt');
  const marker = path.join(seed.directory, '.candidate-owner.json');
  const originalMarker = fs.readFileSync(marker);
  try {
    assert.ok(Object.isFrozen(seed));
    assertCandidateSeedIdentity(seed);
    for (const fake of [{ ...seed }, Object.freeze({ ...seed }), new Proxy(seed, {}), true, null]) {
      assert.throws(() => inspectCandidateSeed(fake, Date.now() + 1000), code('INVALID_HANDLE'));
      assert.throws(() => destroyCandidateSeed(fake, Date.now() + 1000), code('INVALID_HANDLE'));
    }
    assert.throws(() => inspectCandidateSeed(seed, Date.now() - 1), code('TIMEOUT'));
    fs.writeFileSync(filename, 'public-only fixture\n', { flag: 'wx', mode: 0o444 });
    const sealed = sealCandidateSeed(seed, Date.now() + 10000);
    assert.equal(sealed.fileCount, 1);
    assert.equal(sealed.bytes, Buffer.byteLength('public-only fixture\n'));
    assert.equal(sealed.aggregateHash.length, 64);
    assert.ok(Object.isFrozen(sealed));
    assert.throws(() => sealCandidateSeed(seed, Date.now() + 10000), code('CANDIDATE_STATE'));
    fs.chmodSync(filename, 0o600);
    fs.writeFileSync(filename, 'changed-public-file\n');
    assert.throws(() => inspectCandidateSeed(seed, Date.now() + 10000), code('OWNERSHIP_MISMATCH'));
    assert.throws(() => destroyCandidateSeed(seed, Date.now() + 10000), code('OWNERSHIP_MISMATCH'));
    fs.writeFileSync(filename, 'public-only fixture\n');
    fs.chmodSync(marker, 0o600);
    fs.writeFileSync(marker, '{}');
    assert.throws(() => assertCandidateSeedIdentity(seed), code('OWNERSHIP_MISMATCH'));
    fs.writeFileSync(marker, originalMarker);
    assertCandidateSeedIdentity(seed);
  } finally { destroyCandidateSeed(seed, Date.now() + 10000); }
  destroyCandidateSeed(seed, Date.now() + 10000);
  assert.equal(fs.existsSync(seed.directory), false);
});

test('candidate staging rejects area-root links, hardlinks and oversized directory depth', () => {
  const seed = createCandidateSeed(randomUUID(), 'claude-code');
  const runtime = path.join(seed.directory, 'runtime');
  const settings = path.join(seed.directory, 'settings');
  const link = path.join(runtime, 'hardlinked-public-file.txt');
  const target = path.join(settings, 'public-file.txt');
  try {
    fs.rmdirSync(runtime);
    fs.symlinkSync(settings, runtime, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => inspectCandidateSeed(seed, Date.now() + 10000), code('CANDIDATE_SEED_INVALID'));
    fs.unlinkSync(runtime);
    fs.mkdirSync(runtime);
    fs.writeFileSync(target, 'public fixture');
    fs.linkSync(target, link);
    assert.throws(() => inspectCandidateSeed(seed, Date.now() + 10000), code('CANDIDATE_SEED_INVALID'));
    fs.unlinkSync(link);
    const tooDeep = path.join(runtime, ...Array(17).fill('level'));
    fs.mkdirSync(tooDeep, { recursive: true });
    assert.throws(() => inspectCandidateSeed(seed, Date.now() + 10000), code('CANDIDATE_SEED_INVALID'));
    fs.rmSync(path.join(runtime, 'level'), { recursive: true, force: false });
  } finally {
    if (fs.lstatSync(runtime).isSymbolicLink()) {
      fs.unlinkSync(runtime);
      fs.mkdirSync(runtime);
    }
    if (fs.existsSync(link)) fs.unlinkSync(link);
    if (fs.existsSync(path.join(runtime, 'level'))) fs.rmSync(path.join(runtime, 'level'), { recursive: true, force: false });
    destroyCandidateSeed(seed, Date.now() + 10000);
  }
});

test('candidate profiles have fixed empty state roots, never a caller auth lease or native runtime assertion', () => {
  assert.ok(Object.isFrozen(CANDIDATE_PROFILES));
  assert.deepEqual(Object.keys(CANDIDATE_PROFILES).sort(), ['claude-code', 'copilot', 'opencode']);
  assert.equal(CANDIDATE_PROFILES['claude-code'].nativeStateRoot, '/home/node/.claude');
  assert.equal(CANDIDATE_PROFILES.copilot.nativeStateRoot, '/client-config/copilot');
  assert.equal(CANDIDATE_PROFILES.opencode.nativeStateRoot, '/work/data/opencode');
  assert.equal(CANDIDATE_PROFILES.opencode.workdir, '/work/project');
  assert.throws(() => createCandidateSeed('caller-owned-tag', 'opencode'), code('INVALID_ARGUMENT'));
  assert.throws(() => createCandidateSeed(randomUUID(), 'unknown'), code('INVALID_ARGUMENT'));
});

function ownedFixture() {
  const owner = randomUUID();
  const inside = '1'.repeat(64);
  const outside = '2'.repeat(64);
  const expected = {
    owner, issuer: 'public-exact-dns-tls-443', role: 'candidate',
    id: '3'.repeat(64), name: `skill-egress-${owner}-candidate`,
    networkIds: [inside], imageId: `sha256:${'a'.repeat(64)}`,
    env: ['NODE_VERSION=22.22.1', 'HOME=/nonexistent'],
    mounts: [{ source: 'owned-source', destination: '/boundary' }]
  };
  const container = {
    Id: expected.id, Name: `/${expected.name}`, Image: expected.imageId,
    State: { Running: true },
    Config: {
      User: '10001:10001', Env: expected.env,
      Labels: { [OWNER_LABEL]: owner, [ROLE_LABEL]: 'candidate', [ISSUER_LABEL]: expected.issuer }
    },
    NetworkSettings: { Networks: { inside: { NetworkID: inside } } },
    Mounts: [{ Type: 'bind', Destination: '/boundary', RW: false }],
    HostConfig: {
      ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null,
      SecurityOpt: ['no-new-privileges=true'], Memory: 268435456, MemorySwap: 268435456,
      PidsLimit: 64, NanoCpus: 1000000000, LogConfig: { Type: 'none' }, IpcMode: 'none',
      PidMode: '', UTSMode: '', RestartPolicy: { Name: 'no' }, Dns: ['127.0.0.1'],
      Sysctls: { 'net.ipv6.conf.all.disable_ipv6': '1', 'net.ipv6.conf.default.disable_ipv6': '1' },
      Tmpfs: { '/scratch': 'rw,noexec,nosuid,nodev,size=16m,mode=700,uid=10001,gid=10001' },
      Mounts: [{ Type: 'bind', Source: 'owned-source', Target: '/boundary', ReadOnly: true, BindOptions: { NonRecursive: true } }]
    }
  };
  const networkExpected = {
    owner, issuer: expected.issuer, role: 'inside', id: inside,
    name: `skill-egress-${owner}-inside`, internal: true
  };
  const network = {
    Id: inside, Name: networkExpected.name, Internal: true, EnableIPv6: false, Scope: 'local', Driver: 'bridge',
    Labels: { [OWNER_LABEL]: owner, [ROLE_LABEL]: 'inside', [ISSUER_LABEL]: expected.issuer },
    Options: INTERNAL_OPTIONS, Containers: { [expected.id]: {} }
  };
  return { owner, inside, outside, expected, container, networkExpected, network };
}

test('ownership validation requires exact UUID labels, captured ID, name, issuer and network identities', () => {
  const fixture = ownedFixture();
  validateOwnedContainer(fixture.container, fixture.expected);
  validateOwnedNetwork(fixture.network, fixture.networkExpected);
  for (const mutation of [
    object => { object.Id = '4'.repeat(64); },
    object => { object.Name = '/unrelated'; },
    object => { object.Config.Labels[OWNER_LABEL] = randomUUID(); },
    object => { object.Config.Labels[ISSUER_LABEL] = 'local-fixture-issuer-only'; },
    object => { object.NetworkSettings.Networks.external = { NetworkID: fixture.outside }; }
  ]) {
    const value = structuredClone(fixture.container); mutation(value);
    assert.throws(() => validateOwnedContainer(value, fixture.expected), code('OWNERSHIP_MISMATCH'));
  }
});

test('external attachments, even with a copied ownership label, are refused before cleanup', () => {
  const fixture = ownedFixture();
  validateAttachmentGraph([fixture.network], [fixture.container], [fixture.expected]);
  const network = structuredClone(fixture.network);
  network.Containers['f'.repeat(64)] = { Name: 'external', Labels: { [OWNER_LABEL]: fixture.owner } };
  assert.throws(() => validateAttachmentGraph([network], [fixture.container], [fixture.expected]), code('OWNERSHIP_MISMATCH'));
  network.Containers = {};
  assert.throws(() => validateAttachmentGraph([network], [fixture.container], [fixture.expected]), code('OWNERSHIP_MISMATCH'));
});

test('unstarted container cleanup maps blank network IDs only to exact owned network names', () => {
  const fixture = ownedFixture();
  const value = structuredClone(fixture.container);
  value.State = { Status: 'created', Running: false };
  value.NetworkSettings.Networks = { [fixture.networkExpected.name]: { NetworkID: '' } };
  assert.deepEqual(observedNetworkIds(value, [fixture.networkExpected]), [fixture.inside]);
  value.NetworkSettings.Networks = { external: { NetworkID: '' } };
  assert.throws(() => observedNetworkIds(value, [fixture.networkExpected]), code('OWNERSHIP_MISMATCH'));
  value.NetworkSettings.Networks = { [fixture.networkExpected.name]: { NetworkID: '' } };
  value.State.Running = true;
  assert.throws(() => observedNetworkIds(value, [fixture.networkExpected]), code('OWNERSHIP_MISMATCH'));
});

test('absence evidence requires the exact owned identity and the observed Docker missing-resource forms', () => {
  const expected = { kind: 'network', id: '1'.repeat(64), name: `skill-egress-${randomUUID()}-inside` };
  assert.equal(isExactResourceAbsence({
    exitCode: 1, stderr: `Error response from daemon: network ${expected.id} not found\n`
  }, expected), true);
  assert.equal(isExactResourceAbsence({ exitCode: 1, stderr: `Error: No such network: ${expected.name}\n` }, expected), true);
  for (const result of [
    { exitCode: 1, stderr: 'Error: No such network: external' },
    { exitCode: 1, stderr: `Error response from daemon: network ${expected.id} not found\nunrelated error` },
    { exitCode: 1, stderr: `Permission denied: ${expected.id}` },
    { exitCode: 2, stderr: `Error: No such network: ${expected.id}` },
    { exitCode: 0, stderr: `Error: No such network: ${expected.id}` }
  ]) assert.equal(isExactResourceAbsence(result, expected), false);
});

test('observed confinement, not a policy or tag, must match mounts, limits, DNS and privilege controls', () => {
  const fixture = ownedFixture();
  assert.equal(measureConfinement(fixture.container, fixture.expected).logging, 'none');
  for (const mutation of [
    object => { object.HostConfig.Privileged = true; },
    object => { object.HostConfig.ReadonlyRootfs = false; },
    object => { object.HostConfig.Dns = ['8.8.8.8']; },
    object => { object.HostConfig.CapAdd = ['NET_ADMIN']; },
    object => { object.HostConfig.LogConfig.Type = 'json-file'; },
    object => { object.Config.Env.push('PERSONAL_TOKEN=secret-fixture'); },
    object => { object.HostConfig.Mounts[0].Source = 'personal-home'; },
    object => { object.HostConfig.PortBindings = { '8080/tcp': [{}] }; },
    object => { object.HostConfig.PidsLimit = 0; }
  ]) {
    const value = structuredClone(fixture.container); mutation(value);
    assert.throws(() => measureConfinement(value, fixture.expected), error =>
      code('CONFIG_MISMATCH')(error) && !error.message.includes('secret-fixture'));
  }
  const network = structuredClone(fixture.network); network.Internal = false;
  assert.throws(() => validateOwnedNetwork(network, fixture.networkExpected), code('NETWORK_MISMATCH'));
});

test('native-labelled slots require the exact candidate UUID, fixed DNS and exact typed tmpfs policy', () => {
  const fixture = ownedFixture();
  fixture.expected.role = 'native-candidate';
  fixture.expected.candidateId = randomUUID();
  fixture.expected.tmpfs = {
    '/scratch': 'rw,noexec,nosuid,nodev,size=16m,mode=700,uid=10001,gid=10001',
    '/work': 'rw,noexec,nosuid,nodev,size=256m,mode=700,uid=10001,gid=10001'
  };
  fixture.container.Config.Labels[ROLE_LABEL] = 'native-candidate';
  fixture.container.Config.Labels[CANDIDATE_LABEL] = fixture.expected.candidateId;
  fixture.container.HostConfig.Tmpfs = { ...fixture.expected.tmpfs };
  const measured = measureConfinement(fixture.container, fixture.expected);
  assert.equal(measured.tmpfs['/work'], fixture.expected.tmpfs['/work']);
  for (const mutation of [
    object => { object.HostConfig.Tmpfs['/work'] = 'rw,exec,size=1g'; },
    object => { object.HostConfig.Tmpfs['/unrelated'] = fixture.expected.tmpfs['/scratch']; },
    object => { object.HostConfig.Dns = ['127.0.0.11']; }
  ]) {
    const value = structuredClone(fixture.container); mutation(value);
    assert.throws(() => measureConfinement(value, fixture.expected), code('CONFIG_MISMATCH'));
  }
  const value = structuredClone(fixture.container);
  value.Config.Labels[CANDIDATE_LABEL] = randomUUID();
  assert.throws(() => measureConfinement(value, fixture.expected), code('OWNERSHIP_MISMATCH'));
});

test('Docker environment fixes a local engine and owned config, never inheriting credentials or context', () => {
  const env = sanitizedDockerEnvironment('owned-config');
  assert.equal(env.DOCKER_CONFIG, 'owned-config');
  assert.equal(env.DOCKER_CONTEXT, undefined);
  assert.equal(env.DOCKER_AUTH_CONFIG, undefined);
  assert.equal(env.HOME, undefined);
  assert.equal(env.USERPROFILE, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.ok(env.DOCKER_HOST.startsWith(process.platform === 'win32' ? 'npipe:' : 'unix:'));
});

test('readiness retries only the exact Docker start/exec race, including transition to running', () => {
  const id = '1'.repeat(64);
  const result = { exitCode: 1, stderr: `Error response from daemon: container ${id} is not running\n` };
  for (const status of ['created', 'running']) {
    assert.equal(retryStartingExec(result, { Id: id, State: { Status: status } }), true);
  }
  assert.equal(retryStartingExec(result, { Id: id, State: { Status: 'exited' } }), false);
  assert.equal(retryStartingExec(result, { Id: '2'.repeat(64), State: { Status: 'running' } }), false);
  assert.equal(retryStartingExec({ ...result, stderr: 'Unclassified infrastructure failure' },
    { Id: id, State: { Status: 'running' } }), false);
  assert.equal(retryStartingExec({ exitCode: 1, stderr: 'Unclassified infrastructure failure' }, null), false);
});

test('finite helpers classify timeout and cancellation and wait for exact child termination', async () => {
  const options = { cwd: moduleRoot, env: {}, deadline: Date.now() + 100, maxOutputBytes: 1024 };
  await assert.rejects(runBoundedProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], options), code('TIMEOUT'));
  const controller = new AbortController();
  const operation = runBoundedProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], {
    ...options, deadline: Date.now() + 3000, signal: controller.signal
  });
  controller.abort();
  await assert.rejects(operation, code('CANCELLED'));
  await assert.rejects(runBoundedProcess(process.execPath, ['-e', 'process.exit(0)'], {
    ...options, deadline: Date.now() + 1000, signal: controller.signal
  }), code('CANCELLED'));
  await assert.rejects(startEgressBoundary({
    hosts: ['api.example.com'], timeoutSeconds: 30, mode: 'egress-only', signal: controller.signal
  }), code('CANCELLED'));
});

test('helper failure and output caps never echo attacker wire bytes or stderr secrets', async () => {
  const options = { cwd: moduleRoot, env: {}, deadline: Date.now() + 3000, maxOutputBytes: 128 };
  await assert.rejects(runBoundedProcess(process.execPath,
    ['-e', 'process.stderr.write("fixture-secret");process.exit(2)'], options),
  error => code('DOCKER_FAILURE')(error) && !error.message.includes('fixture-secret'));
  await assert.rejects(runBoundedProcess(process.execPath,
    ['-e', 'process.stdout.write("fixture-secret".repeat(10000));setTimeout(()=>{},10000)'], options),
  error => code('OUTPUT_LIMIT')(error) && !error.message.includes('fixture-secret'));
  await assert.rejects(runBoundedProcess(path.join(moduleRoot, 'nonexistent-owned-executable'), [], options),
    code('DOCKER_UNAVAILABLE'));
});

test('fixture test identity is ephemeral, explicitly test-only and cannot enter public policy', () => {
  const identity = createFixtureIdentity();
  const cert = new X509Certificate(identity.certificate);
  assert.equal(cert.checkHost(FIXTURE_HOSTS[0]), FIXTURE_HOSTS[0]);
  assert.match(cert.subject, /Local Fixture Only Test Issuer/);
  assert.equal(identity.certificateHash.length, 64);
  assert.throws(() => createPublicPolicy(FIXTURE_HOSTS), code('INVALID_HOST'));
});

test('ONE opt-in real local Docker lab measures enforcement and encrypted byte passthrough, then exact cleanup', {
  skip: process.env.EVAL_LIVE_BOUNDARY_DOCKER !== '1', timeout: 240000
}, async () => {
  const report = await runLocalEgressBoundaryLab({ timeoutSeconds: 180 });
  assert.equal(report.classification, 'measured-local-fixture-egress-only');
  assert.equal(report.networkIsolationVerified, true);
  assert.equal(report.fixtureOnly, true);
  assert.equal(report.publicServiceEgressVerified, false);
  assert.equal(report.credentialIsolationVerified, false);
  assert.equal(report.authenticationVerified, false);
  assert.equal(report.liveAccepted, false);
  assert.equal(report.nativeRuntimeVerified, false);
  assert.equal(report.nativeLimitsVerified, false);
  assert.equal(report.providerQuotaVerified, false);
  assert.equal(report.billingVerified, false);
  assert.equal(report.fixtureProof.encryptedBytePassthrough, true);
  assert.ok(Object.values(report.observed.negativeProbes).every(value => value === true));
  assert.equal(report.observed.candidateRuntime.defaultRoutes, 0);
  assert.deepEqual(report.observed.candidateRuntime.nameservers, ['127.0.0.1']);
  assert.equal(report.observed.engine.version, '29.7.2');
  assert.equal(report.observed.nodeVersion, '22.22.1');
  assert.equal(report.cleanup.exactContainersAbsent, true);
  assert.equal(report.cleanup.exactNetworksAbsent, true);
  assert.equal(report.cleanup.directoryRemoved, true);
  assert.equal(report.cleanup.helperProcessesClosed, 4);
  assert.equal(report.cleanup.containerIds.length, 4);
  assert.equal(report.cleanup.networkIds.length, 2);
  assert.deepEqual(report.cleanup.candidateSeedsRemoved, [report.candidate.id]);
  assert.equal(report.candidate.networkAttachmentVerified, true);
  assert.equal(report.candidate.fixtureOnly, true);
  assert.equal(report.candidate.nativeRuntimeVerified, false);
  assert.equal(report.candidate.authenticationVerified, false);
  assert.equal(report.candidate.liveAccepted, false);
  assert.equal(report.candidate.observed.runtime.defaultRoutes, 0);
  assert.equal(report.candidate.observed.container.role, 'native-candidate');
  assert.equal(report.candidate.cloneRejected, true);
  assert.equal(report.candidate.bindingRejected, true);
  assert.equal(report.candidate.repeatPrepareRejected, true);
  assert.equal(report.candidate.stopped, true);
  assert.equal(report.candidate.stagingRemoved, true);
  assert.equal(fs.existsSync(path.join(moduleRoot, '.owned', report.owner)), false);
  assert.equal(fs.existsSync(path.join(moduleRoot, '.owned', report.candidate.id)), false);
  assert.throws(() => describeEgressBoundary(JSON.parse(JSON.stringify(report))), code('INVALID_HANDLE'));
  fs.writeFileSync(path.join(moduleRoot, 'lab-evidence.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
});
