import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { OFFLINE_NODE_IMAGE, OFFLINE_NODE_VERSION, DOCKER_ENGINE_VERSION, CLIENT_VERSIONS } from '../isolation/index.mjs';
import {
  addAbortListener, deepFreeze, EgressBoundaryError, errorCodes, insist, isAborted,
  removeAbortListener, sanitizedError
} from './errors.mjs';
import { createPublicPolicy, routingPolicy } from './policy.mjs';
import { createFixtureIdentity, FIXTURE_HOSTS } from './fixture-identity.mjs';
import { DockerControl, retryStartingExec } from './supervision.mjs';
import {
  CANDIDATE_LABEL, INTERNAL_OPTIONS, ISSUER_LABEL, OWNER_LABEL, ROLE_LABEL, isExactResourceAbsence, measureConfinement,
  observedNetworkIds, validateAttachmentGraph, validateOwnedContainerIdentity, validateOwnedNetwork
} from './ownership.mjs';
import {
  CANDIDATE_PROFILES, assertCandidateSeedIdentity, createCandidateSeed, destroyCandidateSeed,
  inspectCandidateSeed, sealCandidateSeed
} from './candidate-seed.mjs';
import {
  assertActiveNativeImageAuthority, assertNativeCandidateSeed, captureNativeImageAuthority,
  validateNativeImageMetadata, validateNativeRuntimeObservation
} from './native-image.mjs';
import {
  assertFreshNativeToolTransport, assertNativeToolTransportIdentity, assertSameNativeToolTransport,
  captureNativeToolTransport, describeNativeToolTransport, nativeToolTransportDockerArguments,
  nativeToolTransportExpectation, measureNativeToolTransportMount, validateNativeToolSocketObservation
} from './tool-transport.mjs';

export { EgressBoundaryError } from './errors.mjs';

const moduleRoot = fileURLToPath(new URL('.', import.meta.url));
const ownedRoot = path.join(moduleRoot, '.owned');
const handles = new WeakMap();
const candidateHandles = new WeakMap();
const fixtureIssuer = Symbol('local-fixture-issuer-only');
const resolverText = 'nameserver 127.0.0.1\noptions attempts:1 timeout:1 ndots:0\n';
const sourceFiles = Object.freeze({
  relay: ['errors.mjs', 'policy.mjs', 'protocol.mjs', 'relay-core.mjs', 'relay.mjs'],
  candidate: ['candidate-probe.mjs', 'fixture-hello.mjs'],
  fixture: ['fixture-service.mjs', 'fixture-identity.mjs']
});
const digest = value => createHash('sha256').update(value).digest('hex');
const idPattern = /^[a-f0-9]{64}$/;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function assertLifetime(state) {
  insist(Date.now() < state.deadline, 'TIMEOUT');
  insist(!isAborted(state.controller.signal), 'CANCELLED');
}

function explicitOptions(options, keys) {
  insist(options && !types.isProxy(options) && Object.getPrototypeOf(options) === Object.prototype &&
    Reflect.ownKeys(options).every(key => typeof key === 'string' && keys.includes(key)) &&
    Object.values(Object.getOwnPropertyDescriptors(options)).every(item => Object.hasOwn(item, 'value')),
  'INVALID_ARGUMENT');
  insist(Number.isInteger(options.timeoutSeconds) && options.timeoutSeconds >= 5 &&
    options.timeoutSeconds <= 300 &&
    (options.signal === undefined || (options.signal instanceof AbortSignal && !types.isProxy(options.signal))),
  'INVALID_ARGUMENT');
  isAborted(options.signal);
}

function assertNoLinks(filename) {
  let current = path.resolve(filename);
  while (true) {
    if (fs.existsSync(current)) insist(!fs.lstatSync(current).isSymbolicLink(), 'OWNERSHIP_MISMATCH');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function seed(state, relative, content) {
  const filename = path.join(state.directory, relative);
  assertNoLinks(filename);
  const bytes = Buffer.from(content);
  insist(bytes.length <= 131072 && !state.manifest.has(relative), 'INVALID_ARGUMENT');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o444 });
  state.manifest.set(relative, { bytes: bytes.length, hash: digest(bytes) });
}

function assertDirectory(state) {
  try {
    assertNoLinks(state.directory);
    const marker = path.join(state.directory, '.owner.json');
    insist(fs.existsSync(marker) && digest(fs.readFileSync(marker)) === state.markerHash, 'OWNERSHIP_MISMATCH');
  } catch { throw new EgressBoundaryError('OWNERSHIP_MISMATCH'); }
}

function assertSeeds(state) {
  assertDirectory(state);
  const observed = new Set();
  function walk(directory, depth) {
    insist(depth <= 4, 'OWNERSHIP_MISMATCH');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      insist(!entry.isSymbolicLink(), 'OWNERSHIP_MISMATCH');
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target, depth + 1);
      else {
        const relative = path.relative(state.directory, target);
        const expected = state.manifest.get(relative);
        const stat = fs.lstatSync(target);
        insist(entry.isFile() && stat.nlink === 1 && expected && stat.size === expected.bytes &&
          digest(fs.readFileSync(target)) === expected.hash, 'OWNERSHIP_MISMATCH');
        observed.add(relative);
      }
    }
  }
  walk(state.directory, 0);
  insist(observed.size === state.manifest.size, 'OWNERSHIP_MISMATCH');
}

function owned(handle) {
  const state = handles.get(handle);
  insist(state, 'INVALID_HANDLE');
  if (state.status !== 'stopped') assertDirectory(state);
  return state;
}

function ownedCandidate(handle, inspectSeed = true) {
  const candidate = candidateHandles.get(handle);
  insist(candidate, 'INVALID_HANDLE');
  owned(candidate.boundaryHandle);
  if (inspectSeed) assertCandidateSeedIdentity(candidate.seed);
  return candidate;
}

function candidateOperation(state) {
  const candidate = state.nativeCandidate;
  if (candidate?.status === 'preparing-image') return candidate.preparationPromise;
  if (candidate?.status === 'attaching') return candidate.attachmentPromise;
  if (candidate?.status === 'inspecting') return candidate.inspectionPromise;
  if (candidate?.status === 'asserting-transport') return candidate.assertionPromise;
  return null;
}

function candidateProfile(candidate) {
  return candidate.nativeImage?.profile ?? CANDIDATE_PROFILES[candidate.client];
}

async function verifyCandidateToolTransport(candidate) {
  if (!candidate.toolTransport) return null;
  assertNativeToolTransportIdentity(candidate.toolTransport);
  assertLifetime(candidate.boundaryState);
  const verifiedAt = await assertFreshNativeToolTransport(candidate.toolTransport);
  assertLifetime(candidate.boundaryState);
  return verifiedAt;
}

function transportInvalidation(error) {
  return error instanceof EgressBoundaryError &&
    (error.code.startsWith('TOOL_TRANSPORT_') || ['TIMEOUT', 'CANCELLED'].includes(error.code));
}

async function failTransportCandidate(candidate, error) {
  if (candidate.boundaryState.status !== 'stopped') candidate.status = 'failed';
  candidate.observation = null;
  candidate.nativeObservation = null;
  candidate.toolTransportObservation = null;
  const failure = candidate.transportExpired ? new EgressBoundaryError('TOOL_TRANSPORT_EXPIRED') : sanitizedError(error);
  try { await stopState(candidate.boundaryState); } catch (cleanup) {
    const result = sanitizedError(cleanup);
    result.failureCode = failure.code;
    result.recoveryHandle = candidate.boundaryHandle;
    result.cleanupVerified = false;
    throw result;
  }
  throw failure;
}

function retainCandidateToolTransport(candidate, transport) {
  candidate.toolTransport = transport;
  candidate.toolTransportObservation = null;
  const state = candidate.boundaryState;
  candidate.transportExpiration = setTimeout(() => {
    candidate.transportExpired = true;
    state.controller.abort();
    if (state.status === 'active' && !candidateOperation(state)) {
      void stopState(state).catch(error => { state.cleanupFailureCode = sanitizedError(error).code; });
    }
  }, Math.max(1, transport.deadline - Date.now()));
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch { throw new EgressBoundaryError('DOCKER_FAILURE'); }
}

async function inspection(state, resource, cleanup = false) {
  const options = cleanup ? { deadline: state.cleanupDeadline, signal: undefined, allowFailure: true }
    : { allowFailure: true };
  const args = resource.kind === 'network' ? ['network', 'inspect', resource.id ?? resource.name]
    : ['container', 'inspect', resource.id ?? resource.name];
  const result = await state.docker.command(args, options);
  if (result.exitCode !== 0) {
    insist(isExactResourceAbsence(result, resource), cleanup ? 'CLEANUP_FAILED' : 'DOCKER_FAILURE');
    return null;
  }
  const [value] = parseJSON(result.stdout);
  insist(value && idPattern.test(value.Id), 'DOCKER_FAILURE');
  resource.id ??= value.Id;
  if (resource.kind === 'network') validateOwnedNetwork(value, resource);
  else validateOwnedContainerIdentity(value, resource);
  return value;
}

function labels(state, role) {
  return ['--label', `${OWNER_LABEL}=${state.owner}`, '--label', `${ROLE_LABEL}=${role}`,
    '--label', `${ISSUER_LABEL}=${state.issuer}`];
}

function resource(state, kind, role, extra = {}) {
  const item = {
    kind, role, name: `skill-egress-${state.owner}-${role}`, id: null,
    owner: state.owner, issuer: state.issuer, ...extra
  };
  state.resources.push(item);
  return item;
}

async function network(state, role, internal) {
  const item = resource(state, 'network', role, { internal });
  const args = ['network', 'create', '--driver', 'bridge', '--ipv6=false', ...labels(state, role)];
  if (internal) {
    args.push('--internal');
    for (const [key, value] of Object.entries(INTERNAL_OPTIONS)) args.push('--opt', `${key}=${value}`);
  }
  const result = await state.docker.command([...args, item.name]);
  insist(idPattern.test(result.stdout.trim()), 'DOCKER_FAILURE');
  item.id = result.stdout.trim();
  const observed = await inspection(state, item);
  const configurations = observed.IPAM?.Config;
  insist(configurations?.length === 1 && /^\d+\.\d+\.\d+\.\d+\/(?:1[6-9]|2[0-8])$/.test(configurations[0].Subnet),
    'NETWORK_MISMATCH');
  item.subnet = configurations[0].Subnet;
  return item;
}

function networkAddress(network, offset) {
  const bytes = network.subnet.split('/')[0].split('.').map(Number);
  const value = bytes.reduce((sum, byte) => sum * 256 + byte, 0) + offset;
  return [24, 16, 8, 0].map(bits => Math.floor(value / 2 ** bits) % 256).join('.');
}

async function container(state, role, attachedNetwork, address, entrypoint, extraNetworks = []) {
  assertSeeds(state);
  const mounts = [{ source: path.join(state.directory, role), destination: '/boundary' }];
  if (role === 'candidate') mounts.push({
    source: path.join(state.directory, 'resolv.conf'), destination: '/etc/resolv.conf'
  });
  const env = new Map(state.imageEnv.map(item => [item.split('=')[0], item]));
  for (const item of ['HOME=/nonexistent', 'TMPDIR=/scratch', 'NODE_OPTIONS=']) env.set(item.split('=')[0], item);
  const item = resource(state, 'container', role, {
    imageId: state.imageId, mounts, env: [...env.values()],
    networkIds: [attachedNetwork.id], requestedNetworkIds: [attachedNetwork.id, ...extraNetworks.map(item => item.id)]
  });
  const args = [
    'create', '--pull', 'never', '--platform', 'linux/amd64', '--name', item.name, ...labels(state, role),
    '--network', attachedNetwork.id, '--ip', address, '--read-only', '--user', '10001:10001',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--init',
    '--memory', '256m', '--memory-swap', '256m', '--cpus', '1', '--pids-limit', '64',
    '--ulimit', 'nofile=256:256', '--ipc', 'none', '--log-driver', 'none',
    '--restart', 'no', '--stop-timeout', '1', '--workdir', '/boundary',
    '--tmpfs', '/scratch:rw,noexec,nosuid,nodev,size=16m,mode=700,uid=10001,gid=10001'
  ];
  if (role === 'candidate') args.push('--dns', '127.0.0.1', '--dns-search', '.',
    '--dns-option', 'attempts:1', '--dns-option', 'timeout:1',
    '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1', '--sysctl', 'net.ipv6.conf.default.disable_ipv6=1');
  for (const value of ['HOME=/nonexistent', 'TMPDIR=/scratch', 'NODE_OPTIONS=']) args.push('--env', value);
  for (const mount of mounts) {
    insist(!/[,\r\n]/.test(mount.source), 'OWNERSHIP_MISMATCH');
    args.push('--mount', `type=bind,source=${mount.source},target=${mount.destination},readonly,bind-recursive=disabled`);
  }
  args.push('--entrypoint', 'node', OFFLINE_NODE_IMAGE, `/boundary/${entrypoint}`);
  if (role === 'candidate') args.push('--idle');
  const result = await state.docker.command(args);
  insist(idPattern.test(result.stdout.trim()), 'DOCKER_FAILURE');
  item.id = result.stdout.trim();
  await inspection(state, item);
  return item;
}

async function runtimeState(state, item, filename, allowStarting = false) {
  const expression = `const fs=require('node:fs'); const p=${JSON.stringify(`/scratch/${filename}`)}; if(!fs.existsSync(p))process.exit(3); const s=fs.readFileSync(p); if(s.length>8192)process.exit(4); process.stdout.write(s);`;
  const result = await state.docker.command(['exec', item.id, 'node', '-e', expression], {
    deadline: Math.min(state.deadline, Date.now() + 4000), allowFailure: true, maxOutputBytes: 16384
  });
  if (result.exitCode === 3) return null;
  if (allowStarting && result.exitCode === 1 && /(?:is not running|not running)/i.test(result.stderr)) {
    const value = await inspection(state, item);
    if (retryStartingExec(result, value)) return null;
  }
  if (result.exitCode !== 0) {
    const observed = await inspection(state, item);
    const error = new EgressBoundaryError('MEASUREMENT_FAILED');
    error.runtime = {
      role: item.role, execExitCode: result.exitCode, containerStatus: observed?.State?.Status,
      containerExitCode: observed?.State?.ExitCode,
      helperControl: [...state.docker.services].find(service => service.name === item.name)?.outputControl ?? null,
      execClassification: /SyntaxError/.test(result.stderr) ? 'JAVASCRIPT_SYNTAX'
        : /EACCES/.test(result.stderr) ? 'PERMISSION'
          : /(?:is not running|not running)/i.test(result.stderr) ? 'NOT_RUNNING' : 'UNCLASSIFIED'
    };
    throw error;
  }
  const value = parseJSON(result.stdout);
  insist(value.owner === state.owner && value.nodeVersion === OFFLINE_NODE_VERSION, 'RUNTIME_DRIFT');
  return value;
}

async function ready(state, item, filename) {
  while (Date.now() < state.deadline) {
    state.docker.assertServices();
    const value = await runtimeState(state, item, filename, true);
    if (value?.ready) return value;
    await sleep(100);
  }
  throw new EgressBoundaryError('TIMEOUT');
}

function relayFacts(state, value) {
  insist(value.issuer === state.issuer && value.policyHash === state.policy.policyHash &&
    Number.isInteger(value.accepted) && value.accepted >= 0 &&
    Object.entries(value.denied ?? {}).every(([code, count]) =>
      errorCodes.includes(code) && Number.isInteger(count) && count >= 0) &&
    Object.keys(value.approvedHosts ?? {}).every(host => state.policy.hosts.includes(host)), 'MEASUREMENT_FAILED');
  return {
    owner: value.owner, issuer: value.issuer, policyHash: value.policyHash,
    nodeVersion: value.nodeVersion, ready: value.ready === true,
    accepted: value.accepted, denied: value.denied, approvedHosts: value.approvedHosts
  };
}

async function observeTopology(state) {
  const networks = [];
  const containers = [];
  for (const item of state.resources) {
    const value = await inspection(state, item);
    if (item.retired) {
      insist(value === null, 'OWNERSHIP_MISMATCH');
      continue;
    }
    insist(value, 'MEASUREMENT_FAILED');
    (item.kind === 'network' ? networks : containers).push(value);
  }
  const expected = state.resources.filter(item => item.kind === 'container' && !item.retired);
  validateAttachmentGraph(networks, containers, expected);
  const confinement = containers.map(value => measureConfinement(value, expected.find(item => item.id === value.Id)));
  return { networks, containers, expected, confinement };
}

async function measure(state) {
  const { networks, confinement } = await observeTopology(state);
  const runtime = await ready(state, state.candidate, 'candidate-state.json');
  insist(runtime.defaultRoutes === 0 && runtime.ipv6Disabled === true &&
    JSON.stringify(runtime.nameservers) === '["127.0.0.1"]' &&
    runtime.resolverHash === digest(resolverText), 'MEASUREMENT_FAILED');
  const relay = relayFacts(state, await ready(state, state.relay, 'relay-state.json'));
  const result = await state.docker.command(['exec', state.candidate.id, 'node', '/boundary/candidate-probe.mjs', '--probe'],
    { maxOutputBytes: 16384 });
  const probes = parseJSON(result.stdout);
  insist(probes.owner === state.owner && probes.nodeVersion === OFFLINE_NODE_VERSION &&
    (!state.nativeCandidate || probes.candidateId === state.nativeCandidate.id) &&
    probes.issuer === state.issuer && Object.keys(probes.denied ?? {}).length >= 19 &&
    Object.values(probes.denied).every(value => value === true), 'MEASUREMENT_FAILED');
  const completed = relayFacts(state, await runtimeState(state, state.relay, 'relay-state.json'));
  for (const code of ['HOST_DENIED', 'CONNECT_METHOD', 'CONNECT_AUTHORITY', 'TLS_SNI_MISMATCH',
    'TLS_SNI_REQUIRED', 'TLS_ECH_UNSUPPORTED', 'TLS_FRAMING', 'TLS_PIPELINED', 'TLS_TRUNCATED', 'TLS_OVERSIZE',
    'CONNECT_PIPELINED']) {
    insist(completed.denied[code] >= 1, 'MEASUREMENT_FAILED');
  }
  if (state.fixture) {
    insist(completed.accepted === relay.accepted + 1 && completed.denied.DNS_NONPUBLIC >= 2 &&
      completed.denied.DNS_UNRESOLVED >= 1 && probes.allowed?.verifiedCertificate === true, 'MEASUREMENT_FAILED');
    let fixture;
    for (let attempt = 0; attempt < 20; attempt++) {
      fixture = await runtimeState(state, state.fixture, 'fixture-state.json');
      if (fixture.sessions?.some(session => session.closed)) break;
      await sleep(100);
    }
    const session = fixture.sessions?.find(session => session.closed &&
      session.incomingHash === probes.allowed.outgoingHash && session.outgoingHash === probes.allowed.incomingHash &&
      session.incomingBytes === probes.allowed.outgoingBytes && session.outgoingBytes === probes.allowed.incomingBytes);
    insist(session && fixture.issuer === 'local-fixture-issuer-only' && fixture.dnsQueries >= 6,
      'MEASUREMENT_FAILED');
    state.fixtureProof = {
      issuer: 'local-fixture-issuer-only', certificateHash: state.certificateHash,
      encryptedBytePassthrough: true, incomingHash: session.incomingHash, outgoingHash: session.outgoingHash,
      incomingBytes: session.incomingBytes, outgoingBytes: session.outgoingBytes, dnsQueries: fixture.dnsQueries
    };
  } else insist(completed.accepted === 0 && probes.allowed === null, 'MEASUREMENT_FAILED');
  state.observed = {
    measuredAt: new Date().toISOString(), engine: state.engine, nodeVersion: OFFLINE_NODE_VERSION,
    image: OFFLINE_NODE_IMAGE, imageId: state.imageId,
    networks: networks.map(value => ({
      id: value.Id, internal: value.Internal, driver: value.Driver, ipv6: value.EnableIPv6,
      subnet: value.IPAM.Config[0].Subnet, gatewayMode: value.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] ?? 'nat',
      containerIds: Object.keys(value.Containers ?? {}).sort()
    })),
    containers: confinement,
    candidateRuntime: {
      defaultRoutes: runtime.defaultRoutes, nameservers: runtime.nameservers,
      resolverHash: runtime.resolverHash, ipv6Disabled: runtime.ipv6Disabled
    },
    relay: completed, negativeProbes: probes.denied
  };
  state.measured = true;
}

async function quiesce(state) {
  for (const service of state.docker.services) service.stopping = true;
  for (const item of state.resources.filter(item => item.kind === 'container')) {
    try {
      const value = await inspection(state, item, true);
      if (value?.State?.Running) {
        await state.docker.command(['stop', '--time', '1', item.id], {
          deadline: state.cleanupDeadline, signal: undefined
        });
      }
    } catch {
      state.quiescenceUnverified = true;
    }
  }
}

function stopState(state) {
  if (state.status === 'stopped') return Promise.resolve(state.cleanup);
  if (state.cleanupPromise) return state.cleanupPromise;
  state.status = 'closing';
  clearTimeout(state.expiration);
  clearTimeout(state.nativeCandidate?.transportExpiration);
  removeAbortListener(state.externalSignal, state.externalAbort);
  state.controller.abort();
  state.cleanupDeadline = Date.now() + 30000;
  state.quiescenceUnverified = false;
  state.cleanupPromise = (async () => {
    try {
      assertDirectory(state);
      if (state.nativeCandidate) inspectCandidateSeed(state.nativeCandidate.seed, state.cleanupDeadline);
      const networks = [];
      const containers = [];
      for (const item of state.resources) {
        const value = await inspection(state, item, true);
        if (!value) continue;
        (item.kind === 'network' ? networks : containers).push(value);
        if (item.kind === 'container' && !state.setupComplete) {
          const connected = observedNetworkIds(value, state.resources.filter(item => item.kind === 'network'));
          insist(connected.every(id => item.requestedNetworkIds.includes(id)), 'OWNERSHIP_MISMATCH');
          item.networkIds = connected;
        }
      }
      const expected = state.resources.filter(item => item.kind === 'container' &&
        containers.some(container => container.Id === item.id));
      for (const value of networks) {
        for (const id of Object.keys(value.Containers ?? {})) {
          insist(expected.some(item => item.id === id && item.networkIds.includes(value.Id)), 'OWNERSHIP_MISMATCH');
        }
      }
      for (const value of containers) {
        const item = expected.find(item => item.id === value.Id);
        const ids = observedNetworkIds(value, state.resources.filter(item => item.kind === 'network')).sort();
        insist(JSON.stringify(ids) === JSON.stringify([...item.networkIds].sort()), 'OWNERSHIP_MISMATCH');
      }
      for (const service of state.docker.services) service.stopping = true;
      await quiesce(state);
      insist(!state.quiescenceUnverified, 'CLEANUP_FAILED');
      for (const item of expected) {
        const value = await inspection(state, item, true);
        insist(!value?.State?.Running, 'CLEANUP_FAILED');
        if (value) await state.docker.command(['rm', item.id], {
          deadline: state.cleanupDeadline, signal: undefined
        });
      }
      state.helpersClosed = (state.helpersClosed ?? 0) + await state.docker.closeAttachments();
      for (const item of state.resources.filter(item => item.kind === 'network')) {
        const value = await inspection(state, item, true);
        if (!value) continue;
        insist(Object.keys(value.Containers ?? {}).length === 0, 'OWNERSHIP_MISMATCH');
        await state.docker.command(['network', 'rm', item.id], {
          deadline: state.cleanupDeadline, signal: undefined
        });
      }
      for (const item of state.resources) insist(await inspection(state, item, true) === null, 'CLEANUP_FAILED');
      if (state.nativeCandidate) {
        destroyCandidateSeed(state.nativeCandidate.seed, state.cleanupDeadline);
        state.nativeCandidate.status = 'stopped';
      }
      assertSeeds(state);
      for (const relative of state.manifest.keys()) fs.chmodSync(path.join(state.directory, relative), 0o600);
      fs.rmSync(state.directory, { recursive: true, force: false });
      insist(!fs.existsSync(state.directory), 'CLEANUP_FAILED');
      state.cleanup = deepFreeze({
        owner: state.owner, classification: 'exact-owned-egress-cleanup',
        containerIds: state.resources.filter(item => item.kind === 'container' && item.id).map(item => item.id),
        networkIds: state.resources.filter(item => item.kind === 'network' && item.id).map(item => item.id),
        exactContainersAbsent: true, exactNetworksAbsent: true, directoryRemoved: true,
        candidateSeedsRemoved: state.nativeCandidate ? [state.nativeCandidate.id] : [],
        helperProcessesClosed: state.helpersClosed, cleanupVerified: true,
        ...(state.nativeCandidate?.toolTransport ? {
          toolTransportConsumer: {
            candidateId: state.nativeCandidate.id, containerId: state.nativeCandidate.resource?.id ?? null,
            transportBindingHash: state.nativeCandidate.toolTransport.transportBindingHash,
            exactConsumerAbsent: true, workerContainerRemoved: false, workerVolumeRemoved: false,
            originalAuthorityRetained: true,
            requiredCleanupOrder: 'remove-exact-native-consumer-before-caller-closes-original-worker'
          }
        } : {})
      });
      state.status = 'stopped';
      return state.cleanup;
    } catch (error) {
      await quiesce(state);
      let failure = sanitizedError(error);
      try {
        state.helpersClosed = (state.helpersClosed ?? 0) + await state.docker.closeAttachments();
      } catch (closing) { failure = sanitizedError(closing); }
      state.status = 'cleanup-failed';
      state.cleanupFailureCode = failure.code;
      state.cleanupPromise = null;
      throw new EgressBoundaryError(
        state.cleanupFailureCode === 'OWNERSHIP_MISMATCH' ? 'OWNERSHIP_MISMATCH' : 'CLEANUP_FAILED'
      );
    }
  })();
  return state.cleanupPromise;
}

async function startOwned(policy, timeoutSeconds, signal, issuer) {
  if (isAborted(signal)) throw new EgressBoundaryError('CANCELLED');
  assertNoLinks(ownedRoot);
  fs.mkdirSync(ownedRoot, { recursive: true });
  const owner = randomUUID();
  const directory = path.join(ownedRoot, owner);
  fs.mkdirSync(directory, { mode: 0o700 });
  const controller = new AbortController();
  const deadline = Date.now() + timeoutSeconds * 1000;
  const isFixture = issuer === fixtureIssuer;
  const state = {
    owner, directory, controller, deadline, policy, issuer: policy.issuer,
    manifest: new Map(), resources: [], status: 'starting', measured: false,
    setupComplete: false, externalSignal: signal, phase: 'owned-filesystem'
  };
  state.docker = new DockerControl(directory, deadline, controller.signal);
  seed(state, '.owner.json', JSON.stringify({ owner, nonce: randomUUID(), version: 1 }));
  state.markerHash = state.manifest.get('.owner.json').hash;
  const handle = Object.freeze(Object.assign(Object.create(null), {
    owner, kind: 'process-owned-egress-boundary'
  }));
  handles.set(handle, state);
  state.externalAbort = () => {
    controller.abort();
    if (state.status === 'active' && !candidateOperation(state)) {
      void stopState(state).catch(error => { state.cleanupFailureCode = sanitizedError(error).code; });
    }
  };
  try {
    seed(state, path.join('docker-config', 'config.json'), '{"auths":{},"credsStore":"","credHelpers":{}}\n');
    addAbortListener(signal, state.externalAbort);
    state.expiration = setTimeout(() => {
      state.expired = true;
      controller.abort();
      if (state.status === 'active' && !candidateOperation(state)) {
        void stopState(state).catch(error => { state.cleanupFailureCode = sanitizedError(error).code; });
      }
    }, timeoutSeconds * 1000);
    if (isAborted(signal)) controller.abort();
    state.phase = 'local-engine';
    const version = parseJSON((await state.docker.command(['version', '--format', '{{json .Server}}'])).stdout);
    insist(version.Version === DOCKER_ENGINE_VERSION && version.Os === 'linux' && version.Arch === 'amd64', 'RUNTIME_DRIFT');
    state.engine = { version: version.Version, os: version.Os, architecture: version.Arch };
    const imageResult = await state.docker.command(['image', 'inspect', OFFLINE_NODE_IMAGE], { allowFailure: true });
    insist(imageResult.exitCode === 0, 'IMAGE_UNAVAILABLE');
    const [image] = parseJSON(imageResult.stdout);
    insist(image?.RepoDigests?.includes(OFFLINE_NODE_IMAGE) && image.Os === 'linux' &&
      image.Architecture === 'amd64' && /^sha256:[a-f0-9]{64}$/.test(image.Id) &&
      image.Config?.Env?.includes(`NODE_VERSION=${OFFLINE_NODE_VERSION}`) &&
      image.Config.Env.every(item => /^(?:PATH|NODE_VERSION|YARN_VERSION)=/.test(item)), 'RUNTIME_DRIFT');
    state.imageId = image.Id;
    state.imageEnv = image.Config.Env;
    state.phase = 'owned-networks';
    state.inside = await network(state, 'inside', true);
    state.outside = await network(state, 'outside', false);
    state.proxyAddress = networkAddress(state.inside, 2);
    const fixtureAddress = networkAddress(state.outside, 2);
    for (const role of ['relay', 'candidate', ...(isFixture ? ['fixture'] : [])]) {
      const files = [...sourceFiles[role]];
      if (role === 'relay' && isFixture) {
        files.splice(files.indexOf('relay.mjs'), 1, 'relay-fixture.mjs', 'fixture-identity.mjs');
      }
      for (const file of files) {
        const source = path.join(moduleRoot, file);
        assertNoLinks(source);
        const stat = fs.lstatSync(source);
        insist(stat.isFile() && stat.nlink === 1 && stat.size <= 131072, 'OWNERSHIP_MISMATCH');
        seed(state, path.join(role, file), fs.readFileSync(source));
      }
    }
    seed(state, 'resolv.conf', resolverText);
    const shared = { owner, expiresAt: deadline };
    seed(state, path.join('relay', 'config.json'), JSON.stringify({
      ...shared, hosts: policy.hosts, listenAddress: state.proxyAddress,
      ...(isFixture ? { fixtureAddress } : {})
    }));
    seed(state, path.join('candidate', 'config.json'), JSON.stringify({
      ...shared, hosts: policy.hosts, proxyAddress: state.proxyAddress, proxyPort: 8080,
      ...(isFixture ? { fixtureAddress } : {})
    }));
    if (isFixture) {
      const identity = createFixtureIdentity();
      state.certificateHash = identity.certificateHash;
      seed(state, path.join('fixture', 'fixture-key.pem'), identity.key);
      seed(state, path.join('fixture', 'fixture-cert.pem'), identity.certificate);
      seed(state, path.join('candidate', 'fixture-cert.pem'), identity.certificate);
      seed(state, path.join('fixture', 'config.json'), JSON.stringify({ ...shared, fixtureAddress }));
      state.fixture = await container(state, 'fixture', state.outside, fixtureAddress, 'fixture-service.mjs');
    }
    state.phase = 'owned-relay';
    state.relay = await container(state, 'relay', state.outside, networkAddress(state.outside, 3),
      isFixture ? 'relay-fixture.mjs' : 'relay.mjs', [state.inside]);
    await state.docker.command(['network', 'connect', '--ip', state.proxyAddress, state.inside.id, state.relay.id]);
    state.relay.networkIds.push(state.inside.id);
    state.phase = 'owned-candidate';
    state.candidate = await container(state, 'candidate', state.inside, networkAddress(state.inside, 3), 'candidate-probe.mjs');
    assertSeeds(state);
    if (state.fixture) {
      state.phase = 'fixture-readiness';
      state.docker.attach(state.fixture.name);
      await ready(state, state.fixture, 'fixture-state.json');
    }
    state.phase = 'relay-readiness';
    state.docker.attach(state.relay.name);
    await ready(state, state.relay, 'relay-state.json');
    state.phase = 'candidate-readiness';
    state.docker.attach(state.candidate.name);
    await ready(state, state.candidate, 'candidate-state.json');
    state.phase = 'deterministic-measurement';
    await measure(state);
    assertLifetime(state);
    state.setupComplete = true;
    state.status = 'active';
    return handle;
  } catch (error) {
    const failure = state.expired ? new EgressBoundaryError('TIMEOUT') : sanitizedError(error);
    failure.phase = state.phase;
    try { await stopState(state); } catch (cleanup) {
      const result = sanitizedError(cleanup);
      result.phase = state.phase;
      result.failureCode = failure.code;
      result.recoveryHandle = handle;
      result.cleanupVerified = false;
      throw result;
    }
    throw failure;
  }
}

export function startEgressBoundary(options) {
  let policy;
  try {
    explicitOptions(options, ['hosts', 'timeoutSeconds', 'mode', 'signal']);
    insist(options.mode === 'egress-only' || options.mode === 'live', 'INVALID_ARGUMENT');
    policy = createPublicPolicy(options.hosts);
    insist(options.mode !== 'live', 'LIVE_BOUNDARY_UNVERIFIED');
  } catch (error) { throw sanitizedError(error); }
  return startOwned(policy, options.timeoutSeconds, options.signal).catch(error => { throw sanitizedError(error); });
}

export function describeEgressBoundary(handle) {
  try {
    const state = owned(handle);
    return deepFreeze({
    version: 1, owner: state.owner, status: state.status, policyHash: state.policy.policyHash,
    classification: !state.measured ? 'unmeasured-egress-setup'
      : state.issuer === 'local-fixture-issuer-only'
        ? 'measured-local-fixture-egress-only' : 'measured-network-controls-public-service-unverified',
    enforcementScope: 'service-network-egress-only', fixtureOnly: state.issuer === 'local-fixture-issuer-only',
    evidenceValidity: 'timestamped-probe-observation-not-ongoing-or-native-client-attestation',
    networkIsolationVerified: state.measured, publicServiceEgressVerified: false,
    credentialIsolationVerified: false, authenticationVerified: false,
    toolIsolationVerified: false, authorizationVerified: false, liveAccepted: false,
    nativeRuntimeVerified: false, nativeLimitsVerified: false, providerQuotaVerified: false, billingVerified: false,
    proxyURL: state.proxyAddress ? `http://${state.proxyAddress}:8080` : null,
    expiresAt: new Date(state.deadline).toISOString(),
    client: state.inside && state.candidate ? {
      networkId: state.inside.id, probeContainerId: state.candidate.id,
      candidateId: state.nativeCandidate?.id ?? null,
      dns: ['127.0.0.1'], resolverHash: digest(resolverText),
      dockerNetworkAndDNSArguments: [
        '--network', state.inside.id, '--dns', '127.0.0.1', '--dns-search', '.',
        '--dns-option', 'attempts:1', '--dns-option', 'timeout:1',
        '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1', '--sysctl', 'net.ipv6.conf.default.disable_ipv6=1',
        '--mount', `type=bind,source=${path.join(state.directory, 'resolv.conf')},target=/etc/resolv.conf,readonly,bind-recursive=disabled`
      ],
      verifiedSubject: state.nativeCandidate?.status === 'attached'
        ? 'exact-owned-candidate-network-only' : 'owned-node-boundary-probe-only',
      otherContainerAdmission: 'unverified-and-not-authorized'
    } : null,
    observed: state.observed ?? null,
    ...(state.fixtureProof ? { fixtureProof: state.fixtureProof } : {}),
    ...(state.cleanup ? { cleanup: state.cleanup } : {}),
    ...(state.cleanupFailureCode ? { cleanupFailureCode: state.cleanupFailureCode } : {})
    });
  } catch (error) { throw sanitizedError(error); }
}

export function stopEgressBoundary(handle) {
  try {
    const state = owned(handle);
    const pending = candidateOperation(state);
    if (pending) {
      state.controller.abort();
      return pending.then(
        () => stopState(state), () => stopState(state)
      ).catch(error => { throw sanitizedError(error); });
    }
    return stopState(state).catch(error => { throw sanitizedError(error); });
  } catch (error) { throw sanitizedError(error); }
}

function issueCandidate(state, boundaryHandle, client, nativeImage = null) {
  const seed = createCandidateSeed(state.owner, client);
  const handle = Object.freeze(Object.assign(Object.create(null), {
    id: seed.id, kind: 'process-owned-egress-candidate'
  }));
  const candidate = {
    id: seed.id, client, expectedClientVersion: CLIENT_VERSIONS[client],
    boundaryHandle, boundaryState: state, seed, nativeImage,
    status: nativeImage ? 'preparing-image' : 'preparing', observation: null, nativeObservation: null
  };
  candidateHandles.set(handle, candidate);
  state.nativeCandidate = candidate;
  return { handle, candidate };
}

export function prepareEgressCandidate(boundaryHandle, options, ...extra) {
  try {
    insist(extra.length === 0 && options && !types.isProxy(options) && Object.getPrototypeOf(options) === Object.prototype &&
      Reflect.ownKeys(options).length === 1 && Object.hasOwn(options, 'client') &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(options, 'client'), 'value') &&
      typeof options.client === 'string' &&
      Object.hasOwn(CLIENT_VERSIONS, options.client), 'INVALID_ARGUMENT');
    const state = owned(boundaryHandle);
    insist(state.status === 'active' && state.measured && !state.nativeCandidate, 'CANDIDATE_STATE');
    assertLifetime(state);
    return issueCandidate(state, boundaryHandle, options.client).handle;
  } catch (error) { throw sanitizedError(error); }
}

async function observeNativeImage(candidate) {
  const state = candidate.boundaryState;
  assertLifetime(state);
  await assertActiveNativeImageAuthority(candidate.nativeImage);
  const result = await state.docker.command(['image', 'inspect', candidate.nativeImage.imageId], {
    allowFailure: true
  });
  insist(result.exitCode === 0, 'IMAGE_UNAVAILABLE');
  const records = parseJSON(result.stdout);
  insist(Array.isArray(records) && records.length === 1, 'DOCKER_FAILURE');
  const observation = validateNativeImageMetadata(candidate.nativeImage, records[0]);
  await assertActiveNativeImageAuthority(candidate.nativeImage);
  assertLifetime(state);
  return observation;
}

export async function prepareNativeEgressCandidate(boundaryHandle, options, ...extra) {
  try {
    insist(extra.length === 0 && options && !types.isProxy(options) &&
      Object.getPrototypeOf(options) === Object.prototype &&
      Reflect.ownKeys(options).length === (Object.hasOwn(options, 'toolTransport') ? 3 : 2) &&
      Reflect.ownKeys(options).every(key => ['client', 'imageHandle', 'toolTransport'].includes(key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')) &&
      ['client', 'imageHandle'].every(key => Object.hasOwn(options, key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')) &&
      typeof options.client === 'string' && Object.hasOwn(CLIENT_VERSIONS, options.client) &&
      options.imageHandle !== null && typeof options.imageHandle === 'object' &&
      !types.isProxy(options.imageHandle), 'INVALID_ARGUMENT');
    const { client, imageHandle } = options;
    const transportValue = options.toolTransport;
    const hasTransport = Object.hasOwn(options, 'toolTransport');
    const state = owned(boundaryHandle);
    insist(state.status === 'active' && state.measured && !state.nativeCandidate, 'CANDIDATE_STATE');
    assertLifetime(state);
    const toolTransport = hasTransport ? captureNativeToolTransport(transportValue, client) : null;
    if (toolTransport) await assertFreshNativeToolTransport(toolTransport);
    const nativeImage = await captureNativeImageAuthority(client, imageHandle);
    assertLifetime(state);
    if (toolTransport) assertNativeToolTransportIdentity(toolTransport);
    insist(state.status === 'active' && !state.nativeCandidate, 'CANDIDATE_STATE');
    const { handle, candidate } = issueCandidate(state, boundaryHandle, client, nativeImage);
    if (toolTransport) retainCandidateToolTransport(candidate, toolTransport);
    candidate.preparationPromise = (async () => {
      try {
        candidate.nativeImagePreparation = await observeNativeImage(candidate);
        if (toolTransport) await verifyCandidateToolTransport(candidate);
        candidate.status = 'preparing';
        return handle;
      } catch (error) {
        if (candidate.toolTransport) return failTransportCandidate(candidate, error);
        candidate.status = 'failed';
        const failure = sanitizedError(error);
        try { await stopState(state); } catch (cleanup) {
          const result = sanitizedError(cleanup);
          result.recoveryHandle = boundaryHandle;
          result.cleanupVerified = false;
          throw result;
        }
        throw failure;
      }
    })();
    return await candidate.preparationPromise;
  } catch (error) { throw sanitizedError(error); }
}

export function assertEgressCandidate(handle, options, ...extra) {
  try {
    insist(extra.length === 0 && options && !types.isProxy(options) && Object.getPrototypeOf(options) === Object.prototype &&
      Reflect.ownKeys(options).length === 2 &&
      ['boundary', 'client'].every(key => Object.hasOwn(options, key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')), 'INVALID_ARGUMENT');
    const candidate = ownedCandidate(handle);
    insist(candidate.boundaryHandle === options.boundary && candidate.client === options.client, 'OWNERSHIP_MISMATCH');
    owned(options.boundary);
    return describeEgressCandidate(handle);
  } catch (error) { throw sanitizedError(error); }
}

export function describeEgressCandidate(handle, ...extra) {
  try {
    insist(extra.length === 0, 'INVALID_ARGUMENT');
    const candidate = ownedCandidate(handle);
    const state = candidate.boundaryState;
    const profile = candidateProfile(candidate);
    const native = candidate.nativeImage !== null;
    const nativeVerified = native && state.status === 'active' && candidate.status === 'attached' &&
      candidate.nativeObservation !== null;
    return deepFreeze({
      version: 1, id: candidate.id, boundaryOwner: state.owner, client: candidate.client,
      expectedClientVersion: candidate.expectedClientVersion, status: candidate.status,
      boundaryStatus: state.status,
      classification: native ? 'owned-native-candidate-version-help-only-no-live-admission'
        : state.issuer === 'local-fixture-issuer-only'
          ? 'fixture-only-owned-candidate-network' : 'owned-candidate-network-only-no-live-admission',
      fixtureOnly: state.issuer === 'local-fixture-issuer-only',
      evidenceValidity: native ? 'timestamped-native-version-help-and-network-observation-not-live-admission'
        : 'timestamped-owned-candidate-network-observation-not-native-client-attestation',
      networkAttachmentVerified: state.status === 'active' && candidate.status === 'attached' &&
        candidate.observation !== null,
      nativeRuntimeVerified: nativeVerified, nativeLimitsVerified: false, providerQuotaVerified: false, billingVerified: false,
      publicServiceEgressVerified: false,
      credentialIsolationVerified: false, authenticationVerified: false, toolIsolationVerified: false,
      authorizationVerified: false, liveAccepted: false,
      containerId: candidate.resource?.id ?? null, networkId: state.inside.id,
      image: native ? candidate.nativeImage.imageId : OFFLINE_NODE_IMAGE, nodeVersion: OFFLINE_NODE_VERSION,
      ...(native ? {
        imageAuthority: {
          client: candidate.client, owner: candidate.nativeImage.owner,
          imageId: candidate.nativeImage.imageId, provenance: 'retained-original-client-owned-image-handle',
          authorityTransfer: false
        },
        imagePreparation: candidate.nativeImagePreparation ?? null,
        nativeRuntime: candidate.nativeObservation,
        observedModel: null, observedUsage: null,
        nativeCommandScope: 'version-help-only-no-login-status-model-account-or-task-dispatch'
      } : {}),
      proxyURL: `http://${state.proxyAddress}:8080`,
      expiresAt: new Date(candidate.toolTransport ? Math.min(state.deadline, candidate.toolTransport.deadline)
        : state.deadline).toISOString(),
      staging: {
        writable: candidate.status === 'preparing',
        runtime: path.join(candidate.seed.directory, 'runtime'),
        inputs: path.join(candidate.seed.directory, 'inputs'),
        settings: path.join(candidate.seed.directory, 'settings')
      },
      mounts: { runtime: profile.runtime, inputs: '/candidate-inputs', settings: profile.settings },
      workdir: profile.workdir, home: profile.home, nativeStateRoot: profile.nativeStateRoot,
      initialWorkdir: profile.initialWorkdir ?? '/boundary',
      nativeAuthRootLocator: {
        containerPath: candidate.client === 'opencode' ? profile.environment.XDG_DATA_HOME : profile.nativeStateRoot,
        authority: 'intended-configuration-path-only-no-custody-or-mount-permission'
      },
      nativeStateAuthority: 'empty-candidate-tmpfs-not-credential-custody-or-auth-mount-authority',
      user: profile.user ?? '10001:10001', writableRoots: [...new Set([...profile.writableRoots, '/scratch'])],
      dockerConfigDirectory: state.docker.configDirectory,
      profileEnvironment: { ...profile.environment },
      proxyEnvironment: {
        HTTP_PROXY: `http://${state.proxyAddress}:8080`, HTTPS_PROXY: `http://${state.proxyAddress}:8080`,
        ALL_PROXY: `http://${state.proxyAddress}:8080`,
        http_proxy: `http://${state.proxyAddress}:8080`, https_proxy: `http://${state.proxyAddress}:8080`,
        all_proxy: `http://${state.proxyAddress}:8080`, NO_PROXY: '', no_proxy: ''
      },
      seed: candidate.seedEvidence ?? null, observed: candidate.observation,
      ...(candidate.toolTransport ? {
        toolTransport: describeNativeToolTransport(candidate.toolTransport, candidate.toolTransportObservation,
          state.status === 'active' && candidate.status === 'attached'),
        effectiveDeadlineUnixMs: Math.min(state.deadline, candidate.toolTransport.deadline)
      } : {}),
      ...(state.cleanup ? { cleanup: state.cleanup } : {})
    });
  } catch (error) { throw sanitizedError(error); }
}

async function createCandidateContainer(candidate) {
  const state = candidate.boundaryState;
  const profile = candidateProfile(candidate);
  const native = candidate.nativeImage !== null;
  const user = profile.user ?? '10001:10001';
  const [uid, gid] = user.split(':');
  const controllerDirectory = `candidate-${candidate.id}`;
  assertSeeds(state);
  for (const file of [...sourceFiles.candidate, ...(state.fixture ? ['fixture-cert.pem'] : [])]) {
    seed(state, path.join(controllerDirectory, file),
      fs.readFileSync(path.join(state.directory, 'candidate', file)));
  }
  if (native) {
    const source = path.join(moduleRoot, 'native-runtime-probe.mjs');
    assertNoLinks(source);
    const stat = fs.lstatSync(source);
    insist(stat.isFile() && stat.nlink === 1, 'OWNERSHIP_MISMATCH');
    seed(state, path.join(controllerDirectory, 'native-runtime-probe.mjs'), fs.readFileSync(source));
  }
  if (candidate.toolTransport) {
    const source = path.join(moduleRoot, 'native-tool-transport-probe.mjs');
    assertNoLinks(source);
    const stat = fs.lstatSync(source);
    insist(stat.isFile() && stat.nlink === 1 && stat.size <= 8192, 'OWNERSHIP_MISMATCH');
    seed(state, path.join(controllerDirectory, 'native-tool-transport-probe.mjs'), fs.readFileSync(source));
  }
  const previousConfig = parseJSON(fs.readFileSync(path.join(state.directory, 'candidate', 'config.json'), 'utf8'));
  seed(state, path.join(controllerDirectory, 'config.json'), JSON.stringify({
    ...previousConfig, candidateId: candidate.id,
    ...(candidate.toolTransport ? {
      expiresAt: Math.min(state.deadline, candidate.toolTransport.deadline),
      toolTransport: { deadlineUnixMs: candidate.toolTransport.deadline }
    } : {}),
    profile: {
      directories: native ? profile.directories
        : [...new Set([profile.workdir, profile.nativeStateRoot, ...Object.values(profile.environment)])]
    },
    ...(native ? { native: {
      client: candidate.client, clientVersion: candidate.expectedClientVersion,
      executable: profile.executable, executableRoot: profile.executableRoot, package: profile.package,
      workdir: profile.workdir, user, directories: profile.directories,
      immutableDirectories: profile.immutableDirectories, helpFlags: profile.helpFlags,
      commands: 'version-help-only'
    } } : {})
  }));
  const proxyURL = `http://${state.proxyAddress}:8080`;
  const environment = {
    ...profile.environment, NODE_OPTIONS: '',
    ...(native ? { PATH: '/usr/local/bin:/usr/bin:/bin', CI: '1', NO_COLOR: '1', LANG: 'C.UTF-8' } : {}),
    HTTP_PROXY: proxyURL, HTTPS_PROXY: proxyURL, ALL_PROXY: proxyURL,
    http_proxy: proxyURL, https_proxy: proxyURL, all_proxy: proxyURL, NO_PROXY: '', no_proxy: ''
  };
  const imageEnvironment = native ? candidate.nativeImagePreparation.environment : state.imageEnv;
  const env = new Map(imageEnvironment.map(item => [item.split('=')[0], item]));
  for (const [key, value] of Object.entries(environment)) env.set(key, `${key}=${value}`);
  const mounts = [
    { source: path.join(state.directory, controllerDirectory), destination: '/boundary' },
    { source: path.join(state.directory, 'resolv.conf'), destination: '/etc/resolv.conf' },
    { source: path.join(candidate.seed.directory, 'runtime'), destination: profile.runtime },
    { source: path.join(candidate.seed.directory, 'inputs'), destination: '/candidate-inputs' },
    { source: path.join(candidate.seed.directory, 'settings'), destination: profile.settings }
  ];
  const tmpfs = Object.fromEntries([...new Set([...profile.writableRoots, '/scratch'])].map(target => [
    target, `rw,noexec,nosuid,nodev,size=${target === '/work' || native && target === '/workspace' ? '256m' : '16m'},mode=700,uid=${uid},gid=${gid}`
  ]));
  const item = resource(state, 'container', 'native-candidate', {
    name: `skill-egress-${state.owner}-native-${candidate.id}`, candidateId: candidate.id,
    imageId: native ? candidate.nativeImage.imageId : state.imageId, mounts, tmpfs, env: [...env.values()],
    ...(native ? {
      user, memoryBytes: 805306368, pidsLimit: profile.pidsLimit,
      nativeLayout: { workdir: profile.initialWorkdir, entrypoint: ['/usr/local/bin/node'],
        command: ['/boundary/candidate-probe.mjs', '--idle'] }
    } : {}),
    networkIds: [state.inside.id], requestedNetworkIds: [state.inside.id]
  });
  if (candidate.toolTransport) item.toolTransport = nativeToolTransportExpectation(candidate.toolTransport);
  candidate.resource = item;
  assertSeeds(state);
  inspectCandidateSeed(candidate.seed, state.deadline);
  const args = [
    'create', '--pull', 'never', '--platform', 'linux/amd64', '--name', item.name,
    ...labels(state, item.role), '--label', `${CANDIDATE_LABEL}=${candidate.id}`,
    '--network', state.inside.id, '--ip', networkAddress(state.inside, 3),
    '--read-only', '--user', user, '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges=true', '--init',
    '--memory', native ? '768m' : '256m', '--memory-swap', native ? '768m' : '256m',
    '--cpus', '1', '--pids-limit', String(profile.pidsLimit ?? 64), '--ulimit', 'nofile=256:256', '--ipc', 'none',
    '--log-driver', 'none', '--restart', 'no', '--stop-timeout', '1',
    '--workdir', profile.initialWorkdir ?? '/boundary',
    '--dns', '127.0.0.1', '--dns-search', '.', '--dns-option', 'attempts:1', '--dns-option', 'timeout:1',
    '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1', '--sysctl', 'net.ipv6.conf.default.disable_ipv6=1'
  ];
  for (const [target, options] of Object.entries(tmpfs)) args.push('--tmpfs', `${target}:${options}`);
  for (const [key, value] of Object.entries(environment)) args.push('--env', `${key}=${value}`);
  for (const mount of mounts) {
    insist(!/[,\r\n]/.test(mount.source), 'OWNERSHIP_MISMATCH');
    args.push('--mount', `type=bind,source=${mount.source},target=${mount.destination},readonly,bind-recursive=disabled`);
  }
  if (candidate.toolTransport) args.push(...nativeToolTransportDockerArguments(candidate.toolTransport));
  args.push('--entrypoint', native ? '/usr/local/bin/node' : 'node',
    native ? candidate.nativeImage.imageId : OFFLINE_NODE_IMAGE, '/boundary/candidate-probe.mjs', '--idle');
  if (candidate.toolTransport) await verifyCandidateToolTransport(candidate);
  const result = await state.docker.command(args);
  insist(idPattern.test(result.stdout.trim()), 'DOCKER_FAILURE');
  item.id = result.stdout.trim();
  const observed = await inspection(state, item);
  if (candidate.toolTransport) {
    measureNativeToolTransportMount(observed, item.toolTransport);
    await verifyCandidateToolTransport(candidate);
  }
  return item;
}

async function measureNativeCandidate(candidate) {
  const state = candidate.boundaryState;
  if (candidate.toolTransport) assertNativeToolTransportIdentity(candidate.toolTransport);
  assertLifetime(state);
  assertSeeds(state);
  state.docker.assertServices();
  const workerVerifiedBefore = candidate.toolTransport ? await verifyCandidateToolTransport(candidate) : null;
  const image = await observeNativeImage(candidate);
  const { networks, confinement } = await observeTopology(state);
  assertNativeCandidateSeed(candidate.seed, state.deadline);
  const kernel = parseJSON((await state.docker.command([
    'exec', candidate.resource.id, '/usr/local/bin/node', '/boundary/candidate-probe.mjs', '--inspect'
  ], { maxOutputBytes: 8192 })).stdout);
  insist(kernel.owner === state.owner && kernel.candidateId === candidate.id &&
    kernel.nodeVersion === OFFLINE_NODE_VERSION && kernel.defaultRoutes === 0 &&
    kernel.ipv6Disabled === true && JSON.stringify(kernel.nameservers) === '["127.0.0.1"]' &&
    kernel.resolverHash === digest(resolverText), 'MEASUREMENT_FAILED');
  const result = await state.docker.command([
    'exec', candidate.resource.id, '/usr/local/bin/node', '/boundary/native-runtime-probe.mjs', '--inspect'
  ], { allowFailure: true, maxOutputBytes: 16384 });
  if (result.exitCode !== 0) {
    const phase = /^Native attachment infrastructure failure: (CONFIGURATION|UID|EXECUTABLE|LAYOUT|CLI_VERSION|CLI_HELP|CLI_EXIT|TIMEOUT|OUTPUT_LIMIT|PROCESS_STOP)$/.exec(result.stderr.trim())?.[1];
    const error = new EgressBoundaryError(phase === 'TIMEOUT' ? 'TIMEOUT'
      : phase === 'OUTPUT_LIMIT' ? 'OUTPUT_LIMIT' : phase === 'PROCESS_STOP' ? 'PROCESS_STOP_UNVERIFIED' : 'RUNTIME_DRIFT');
    error.nativeRuntimePhase = phase ?? 'UNCLASSIFIED';
    throw error;
  }
  const runtime = validateNativeRuntimeObservation(candidate.nativeImage, parseJSON(result.stdout));
  insist(runtime.owner === state.owner && runtime.candidateId === candidate.id, 'OWNERSHIP_MISMATCH');
  if (candidate.nativeObservation) {
    insist(runtime.resolvedExecutable === candidate.nativeObservation.resolvedExecutable &&
      runtime.executableHash === candidate.nativeObservation.executableHash, 'RUNTIME_DRIFT');
  }
  let socketObservation = null;
  if (candidate.toolTransport) {
    const socketResult = await state.docker.command([
      'exec', candidate.resource.id, '/usr/local/bin/node', '/boundary/native-tool-transport-probe.mjs', '--inspect'
    ], {
      allowFailure: true, maxOutputBytes: 8192,
      deadline: Math.min(state.deadline, candidate.toolTransport.deadline)
    });
    insist(socketResult.exitCode === 0, 'TOOL_TRANSPORT_SOCKET_MISMATCH');
    const socket = parseJSON(socketResult.stdout);
    insist(socket.nodeVersion === OFFLINE_NODE_VERSION, 'RUNTIME_DRIFT');
    socketObservation = validateNativeToolSocketObservation(candidate.toolTransport, candidate, socket);
  }
  await assertActiveNativeImageAuthority(candidate.nativeImage);
  if (candidate.toolTransport) {
    const workerVerifiedAfter = await verifyCandidateToolTransport(candidate);
    candidate.toolTransportObservation = deepFreeze({
      measuredAt: new Date().toISOString(), workerVerifiedBefore, workerVerifiedAfter,
      containerId: candidate.resource.id,
      mount: confinement.find(item => item.id === candidate.resource.id).toolTransport,
      socket: socketObservation, connected: false, shimExecuted: false,
      consumerSupervisionSupported: false, nativeDiscoveryVerified: false,
      skillDiscoveryVerified: false, authenticationVerified: false, liveAccepted: false
    });
  }
  assertSeeds(state);
  assertLifetime(state);
  candidate.nativeObservation = deepFreeze({
    ...runtime, image,
    supervision: {
      inheritedExpiresAt: new Date(candidate.toolTransport ? Math.min(state.deadline, candidate.toolTransport.deadline)
        : state.deadline).toISOString(),
      commandTimeoutMs: 20000, commandOutputBytes: 131072,
      cancellation: 'boundary-abort-stops-exact-owned-container-and-helper-processes'
    },
    observedModel: null, observedUsage: null, authenticationVerified: false, liveAccepted: false
  });
  candidate.observation = deepFreeze({
    measuredAt: new Date().toISOString(), policyHash: state.policy.policyHash,
    nodeVersion: runtime.nodeVersion,
    container: confinement.find(item => item.id === candidate.resource.id),
    networks: networks.map(item => ({
      id: item.Id, internal: item.Internal, driver: item.Driver, ipv6: item.EnableIPv6,
      containerIds: Object.keys(item.Containers ?? {}).sort()
    })),
    runtime: {
      defaultRoutes: kernel.defaultRoutes, nameservers: kernel.nameservers,
      resolverHash: kernel.resolverHash, ipv6Disabled: kernel.ipv6Disabled
    },
    nativeRuntime: candidate.nativeObservation,
    ...(candidate.toolTransport ? { toolTransport: candidate.toolTransportObservation } : {}),
    negativeProbes: state.observed.negativeProbes,
    negativeProbesMeasuredAt: state.observed.measuredAt,
    negativeProbeSubject: 'original-measured-node-boundary-probe-not-replayed-on-native-client'
  });
}

export function attachEgressCandidate(handle, ...extra) {
  let candidate;
  try {
    insist(extra.length === 0, 'INVALID_ARGUMENT');
    candidate = ownedCandidate(handle);
    insist(candidate.status === 'preparing' && candidate.boundaryState.status === 'active', 'CANDIDATE_STATE');
    if (candidate.toolTransport) assertNativeToolTransportIdentity(candidate.toolTransport);
    assertLifetime(candidate.boundaryState);
    if (candidate.nativeImage) assertNativeCandidateSeed(candidate.seed, candidate.boundaryState.deadline);
    candidate.seedEvidence = sealCandidateSeed(candidate.seed, candidate.boundaryState.deadline);
    candidate.status = 'attaching';
  } catch (error) {
    if (candidate?.toolTransport && transportInvalidation(error)) return failTransportCandidate(candidate, error);
    throw sanitizedError(error);
  }
  candidate.attachmentPromise = (async () => {
    const state = candidate.boundaryState;
    try {
      if (candidate.toolTransport) await verifyCandidateToolTransport(candidate);
      if (candidate.nativeImage) await observeNativeImage(candidate);
      await observeTopology(state);
      const probe = state.candidate;
      const service = [...state.docker.services].find(item => item.name === probe.name);
      insist(service, 'OWNERSHIP_MISMATCH');
      service.stopping = true;
      await state.docker.command(['stop', '--time', '1', probe.id]);
      const stopped = await inspection(state, probe);
      insist(stopped && !stopped.State.Running, 'MEASUREMENT_FAILED');
      await state.docker.command(['rm', probe.id]);
      insist(await inspection(state, probe) === null, 'CLEANUP_FAILED');
      probe.retired = true;
      state.helpersClosed = (state.helpersClosed ?? 0) + await state.docker.closeAttachment(probe.name);
      state.candidate = await createCandidateContainer(candidate);
      state.docker.attach(state.candidate.name);
      await ready(state, state.candidate, 'candidate-state.json');
      if (candidate.nativeImage) await measureNativeCandidate(candidate);
      else await measure(state);
      assertLifetime(state);
      candidate.status = 'attached';
      if (!candidate.nativeImage) candidate.observation = deepFreeze({
        measuredAt: state.observed.measuredAt, nodeVersion: OFFLINE_NODE_VERSION,
        container: state.observed.containers.find(item => item.id === candidate.resource.id),
        networks: state.observed.networks, runtime: state.observed.candidateRuntime,
        negativeProbes: state.observed.negativeProbes, policyHash: state.policy.policyHash
      });
      return handle;
    } catch (error) {
      if (candidate.toolTransport) return failTransportCandidate(candidate, error);
      candidate.status = 'failed';
      candidate.nativeObservation = null;
      candidate.observation = null;
      const failure = sanitizedError(error);
      try { await stopState(state); } catch (cleanup) {
        const result = sanitizedError(cleanup);
        result.recoveryHandle = candidate.boundaryHandle;
        result.cleanupVerified = false;
        throw result;
      }
      throw failure;
    }
  })();
  return candidate.attachmentPromise;
}

export function inspectEgressCandidate(handle, ...extra) {
  let candidate;
  try {
    insist(extra.length === 0, 'INVALID_ARGUMENT');
    candidate = ownedCandidate(handle);
    insist(candidate.status === 'attached' && candidate.boundaryState.status === 'active', 'CANDIDATE_STATE');
    if (candidate.toolTransport) assertNativeToolTransportIdentity(candidate.toolTransport);
    assertLifetime(candidate.boundaryState);
    if (candidate.nativeImage) candidate.status = 'inspecting';
  } catch (error) {
    if (candidate?.toolTransport && transportInvalidation(error)) return failTransportCandidate(candidate, error);
    throw sanitizedError(error);
  }
  const operation = (async () => {
    const state = candidate.boundaryState;
    if (candidate.nativeImage) {
      await measureNativeCandidate(candidate);
      candidate.status = 'attached';
      return describeEgressCandidate(handle);
    }
    const { networks, confinement } = await observeTopology(state);
    inspectCandidateSeed(candidate.seed, state.deadline);
    const result = await state.docker.command([
      'exec', candidate.resource.id, 'node', '/boundary/candidate-probe.mjs', '--inspect'
    ], { maxOutputBytes: 8192 });
    const runtime = parseJSON(result.stdout);
    assertLifetime(state);
    insist(runtime.owner === state.owner && runtime.candidateId === candidate.id &&
      runtime.nodeVersion === OFFLINE_NODE_VERSION && runtime.defaultRoutes === 0 &&
      runtime.ipv6Disabled === true && JSON.stringify(runtime.nameservers) === '["127.0.0.1"]' &&
      runtime.resolverHash === digest(resolverText), 'MEASUREMENT_FAILED');
    candidate.observation = deepFreeze({
      measuredAt: new Date().toISOString(), policyHash: state.policy.policyHash,
      nodeVersion: runtime.nodeVersion,
      container: confinement.find(item => item.id === candidate.resource.id),
      networks: networks.map(item => ({
        id: item.Id, internal: item.Internal, driver: item.Driver, ipv6: item.EnableIPv6,
        containerIds: Object.keys(item.Containers ?? {}).sort()
      })),
      runtime: {
        defaultRoutes: runtime.defaultRoutes, nameservers: runtime.nameservers,
        resolverHash: runtime.resolverHash, ipv6Disabled: runtime.ipv6Disabled
      },
      negativeProbes: state.observed.negativeProbes,
      negativeProbesMeasuredAt: state.observed.measuredAt
    });
    return describeEgressCandidate(handle);
  })().catch(async error => {
    if (candidate.toolTransport) return failTransportCandidate(candidate, error);
    if (candidate.boundaryState.status !== 'stopped') candidate.status = 'failed';
    candidate.observation = null;
    candidate.nativeObservation = null;
    const failure = sanitizedError(error);
    try { await stopState(candidate.boundaryState); } catch (cleanup) {
      const result = sanitizedError(cleanup);
      result.recoveryHandle = candidate.boundaryHandle;
      result.cleanupVerified = false;
      throw result;
    }
    throw failure;
  });
  if (candidate.nativeImage) candidate.inspectionPromise = operation;
  return operation;
}

export function inspectNativeEgressCandidate(handle, ...extra) {
  try {
    insist(extra.length === 0, 'INVALID_ARGUMENT');
    insist(ownedCandidate(handle).nativeImage, 'NATIVE_IMAGE_UNTRUSTED');
    return inspectEgressCandidate(handle);
  } catch (error) { throw sanitizedError(error); }
}

export async function assertNativeEgressCandidate(handle, options, ...extra) {
  let candidate;
  try {
    insist(extra.length === 0 && options && !types.isProxy(options) &&
      Object.getPrototypeOf(options) === Object.prototype &&
      Reflect.ownKeys(options).length === (Object.hasOwn(options, 'toolTransport') ? 4 : 3) &&
      Reflect.ownKeys(options).every(key => ['boundary', 'client', 'imageHandle', 'toolTransport'].includes(key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')) &&
      ['boundary', 'client', 'imageHandle'].every(key => Object.hasOwn(options, key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')), 'INVALID_ARGUMENT');
    candidate = ownedCandidate(handle);
    insist(candidate.nativeImage && candidate.boundaryHandle === options.boundary &&
      candidate.client === options.client && candidate.nativeImage.handle === options.imageHandle,
    'OWNERSHIP_MISMATCH');
    insist(candidate.status === 'attached' && candidate.boundaryState.status === 'active' &&
      candidate.nativeObservation !== null, 'CANDIDATE_STATE');
    insist(Object.hasOwn(options, 'toolTransport') === Boolean(candidate.toolTransport),
      'TOOL_TRANSPORT_SCOPE_MISMATCH');
    if (candidate.toolTransport) {
      assertSameNativeToolTransport(candidate.toolTransport, options.toolTransport);
      candidate.status = 'asserting-transport';
      candidate.assertionPromise = (async () => {
        try {
          await verifyCandidateToolTransport(candidate);
          await assertActiveNativeImageAuthority(candidate.nativeImage);
          await verifyCandidateToolTransport(candidate);
          insist(candidate.boundaryState.status === 'active', 'CANDIDATE_STATE');
          candidate.status = 'attached';
          return describeEgressCandidate(handle);
        } catch (error) { return failTransportCandidate(candidate, error); }
      })();
      return await candidate.assertionPromise;
    }
    await assertActiveNativeImageAuthority(candidate.nativeImage);
    assertLifetime(candidate.boundaryState);
    insist(candidate.status === 'attached' && candidate.boundaryState.status === 'active', 'CANDIDATE_STATE');
    return describeEgressCandidate(handle);
  } catch (error) { throw sanitizedError(error); }
}

export function stopEgressCandidate(handle, ...extra) {
  try {
    insist(extra.length === 0, 'INVALID_ARGUMENT');
    const candidate = ownedCandidate(handle, false);
    return stopEgressBoundary(candidate.boundaryHandle);
  } catch (error) { throw sanitizedError(error); }
}

export function runLocalEgressBoundaryLab(options) {
  try { explicitOptions(options, ['timeoutSeconds', 'signal']); } catch (error) { throw sanitizedError(error); }
  return (async () => {
    const handle = await startOwned(routingPolicy(FIXTURE_HOSTS, 'local-fixture-issuer-only'),
      options.timeoutSeconds, options.signal, fixtureIssuer);
    try {
      const candidate = prepareEgressCandidate(handle, { client: 'opencode' });
      const prepared = describeEgressCandidate(candidate);
      let cloneRejected = false;
      let bindingRejected = false;
      let repeatPrepareRejected = false;
      try { describeEgressCandidate({ ...candidate }); } catch (error) {
        cloneRejected = error instanceof EgressBoundaryError && error.code === 'INVALID_HANDLE';
      }
      try { assertEgressCandidate(candidate, { boundary: handle, client: 'copilot' }); } catch (error) {
        bindingRejected = error instanceof EgressBoundaryError && error.code === 'OWNERSHIP_MISMATCH';
      }
      try { prepareEgressCandidate(handle, { client: 'opencode' }); } catch (error) {
        repeatPrepareRejected = error instanceof EgressBoundaryError && error.code === 'CANDIDATE_STATE';
      }
      insist(cloneRejected && bindingRejected && repeatPrepareRejected, 'MEASUREMENT_FAILED');
      fs.writeFileSync(path.join(prepared.staging.runtime, 'network-only-public-placeholder.txt'),
        'fixture-only: no native executable, credentials, account or admission\n', { flag: 'wx', mode: 0o444 });
      fs.writeFileSync(path.join(prepared.staging.settings, 'fixture.json'),
        '{"fixtureOnly":true,"nativeExecution":false}\n', { flag: 'wx', mode: 0o444 });
      await attachEgressCandidate(candidate);
      const verified = await inspectEgressCandidate(candidate);
      assertEgressCandidate(candidate, { boundary: handle, client: 'opencode' });
      const report = describeEgressBoundary(handle);
      const cleanup = await stopEgressCandidate(candidate);
      const stopped = describeEgressCandidate(candidate);
      return deepFreeze({
        ...report, status: 'stopped', historicalFixtureEvidenceOnly: true, cleanup,
        candidate: {
          id: verified.id, client: verified.client, expectedClientVersion: verified.expectedClientVersion,
          classification: verified.classification, fixtureOnly: true,
          networkAttachmentVerified: verified.networkAttachmentVerified,
          nativeRuntimeVerified: false, authenticationVerified: false, liveAccepted: false,
          containerId: verified.containerId, image: verified.image, nodeVersion: verified.nodeVersion,
          user: verified.user, writableRoots: verified.writableRoots, mounts: verified.mounts,
          seed: verified.seed, observed: verified.observed,
          cloneRejected, bindingRejected, repeatPrepareRejected,
          stopped: stopped.status === 'stopped' && !stopped.networkAttachmentVerified,
          stagingRemoved: Object.values(prepared.staging).filter(value => typeof value === 'string')
            .every(value => !fs.existsSync(value))
        }
      });
    } catch (error) {
      await stopEgressBoundary(handle);
      throw sanitizedError(error);
    }
  })().catch(error => { throw sanitizedError(error); });
}
