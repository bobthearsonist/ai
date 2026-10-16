import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  prepareNativeEgressCandidate, attachEgressCandidate, assertNativeEgressCandidate,
  inspectNativeEgressCandidate, describeEgressCandidate, startEgressBoundary,
  stopEgressCandidate, stopEgressBoundary
} from '../harness/live-boundary/index.mjs';
import { captureNativeToolTransport, assertFreshNativeToolTransport } from '../harness/live-boundary/tool-transport.mjs';
import { NATIVE_CANDIDATE_PROFILES } from '../harness/live-boundary/native-image.mjs';
import { deepFreeze, EgressBoundaryError } from '../harness/live-boundary/errors.mjs';
import { createPublicPolicy } from '../harness/live-boundary/policy.mjs';
import {
  OFFLINE_NODE_IMAGE, OFFLINE_NODE_VERSION, DOCKER_ENGINE_VERSION, CLIENT_VERSIONS
} from '../harness/isolation/index.mjs';
import { TOOL_CAPS, TOOL_PROTOCOL, ToolWorkerError, coordinates, hashJson } from '../harness/tool-worker/worker.mjs';
import { describeTransportIdentity, originalTransportState } from '../harness/tool-worker/identity.mjs';

export { ToolWorkerError };
const registry = { tasks: new WeakMap(), workers: new WeakMap(), leases: new WeakMap(), bindings: new WeakMap() };
const images = new WeakMap();
const imageMetadata = new Map();
const backends = [];
const events = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const baseImageId = `sha256:${'a'.repeat(64)}`;
const baseEnvironment = [
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  `NODE_VERSION=${OFFLINE_NODE_VERSION}`, 'YARN_VERSION=1.22.22'
];
const resolverHash = hash('nameserver 127.0.0.1\noptions attempts:1 timeout:1 ndots:0\n');
const codes = [
  'HOST_DENIED', 'CONNECT_METHOD', 'CONNECT_AUTHORITY', 'TLS_SNI_MISMATCH', 'TLS_SNI_REQUIRED',
  'TLS_ECH_UNSUPPORTED', 'TLS_FRAMING', 'TLS_PIPELINED', 'TLS_TRUNCATED', 'TLS_OVERSIZE',
  'CONNECT_PIPELINED', 'DNS_NONPUBLIC', 'DNS_UNRESOLVED', 'CONNECT_HEADERS',
  'CONNECT_TRUNCATED', 'DNS_REBINDING', 'PEER_MISMATCH', 'CONNECT_OVERSIZE', 'UPSTREAM_UNAVAILABLE'
];

function issueTransport(client, { deadline = Date.now() + 60000, corruptShim = false, sameTask } = {}) {
  const taskCoordinates = coordinates(sameTask ?? {
    invocationId: randomUUID(), caseId: 'transport-lifecycle-unit', client, arm: 'candidate', repeat: 1
  });
  const task = deepFreeze({ kind: 'tool-worker-task', coordinates: taskCoordinates });
  const worker = Object.freeze({ kind: 'tool-worker', protocol: TOOL_PROTOCOL });
  const lease = Object.freeze({ kind: 'tool-worker-transport-lease', protocol: TOOL_PROTOCOL });
  const sourceHash = hashJson([]);
  const policy = {
    deadlineUnixMs: deadline, requests: TOOL_CAPS.requests, requestBytes: TOOL_CAPS.requestBytes,
    totalRequestBytes: TOOL_CAPS.totalRequestBytes, outputBytes: TOOL_CAPS.outputBytes
  };
  const shim = fs.readFileSync(new URL('../harness/tool-worker/mcp-shim.mjs', import.meta.url), 'utf8');
  const binding = deepFreeze({
    kind: 'tool-worker-transport-binding', protocol: TOOL_PROTOCOL, taskHash: hashJson(taskCoordinates), sourceHash,
    workerProgramHash: '119405c7a0960654109e48b0c6f6b40250899e620cd0bde979595fb7dc67acbb',
    shimHash: hash(shim),
    transportMount: { type: 'volume', source: `eval-tool-socket-${randomUUID()}`,
      target: '/tool-rpc', readOnly: true, noCopy: true },
    socketPath: '/tool-rpc/worker.sock', supplementalGid: 21000, transportPolicy: policy,
    supportedIdentityLayouts: [{ uid: 1000, gid: 1000 }, { uid: 10001, gid: 10001 }],
    stdioCommand: ['/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'TMPDIR=/scratch',
      'LANG=C.UTF-8', '/usr/local/bin/node', '--input-type=module', '--eval',
      corruptShim ? `${shim}\n` : shim, '--', '--eval-tool-mcp-shim', 'b'.repeat(64), JSON.stringify(policy)],
    evidenceScope: 'worker-filesystem-only', authenticationVerified: false, nativeDiscoveryVerified: false, liveAccepted: false
  });
  const state = {
    task, taskHash: binding.taskHash, sourceHash, taskCoordinates, lifecycle: 'ready',
    caps: TOOL_CAPS, deadline, binding, lease, selected: { files: [], targets: ['artifacts/report.txt'] },
    runController: new AbortController(), terminalError: null, cleanupPromise: null, freshCount: 0, freshHook: null
  };
  registry.tasks.set(task, { hash: binding.taskHash });
  registry.workers.set(worker, state);
  registry.leases.set(lease, { state, task, worker });
  registry.bindings.set(binding, { state, lease });
  return { tuple: { task, worker, lease, binding }, state };
}

export function describeToolWorkerTransportBinding(tuple) {
  return describeTransportIdentity(registry, tuple);
}

export async function assertToolWorkerTransportBinding(tuple) {
  assert.equal(Object.hasOwn(tuple, 'signal'), false);
  const state = originalTransportState(registry, tuple);
  describeToolWorkerTransportBinding(tuple);
  events.push('worker-fresh');
  state.freshCount++;
  await state.freshHook?.(state.freshCount);
  describeToolWorkerTransportBinding(tuple);
  return {
    taskHash: state.taskHash, sourceHash: state.sourceHash, transportBindingHash: hashJson(state.binding),
    deadlineUnixMs: state.deadline, nativeConsumptionSupported: false, evidenceScope: 'worker-filesystem-only',
    authenticationVerified: false, nativeDiscoveryVerified: false, liveAccepted: false
  };
}

function issueImage(client) {
  const profile = NATIVE_CANDIDATE_PROFILES[client];
  const owner = randomUUID(), image = `sha256:${hash(owner)}`;
  const handle = Object.freeze({ kind: 'unit-original-client-image' });
  images.set(handle, {
    client, owner, active: true, description: {
      client, clientVersion: CLIENT_VERSIONS[client], image, id: owner,
      preparationId: owner, invocationId: owner, status: 'prepared',
      executable: profile.executable, binary: profile.executable, user: profile.user, workdir: profile.imageWorkdir
    }
  });
  const metadata = {
    Id: image, Os: 'linux', Architecture: 'amd64',
    Config: {
      User: profile.imageUser, WorkingDir: profile.imageWorkdir, Entrypoint: profile.imageEntrypoint, Cmd: null,
      Labels: { [profile.imageOwnerLabel]: owner }, Env: [...baseEnvironment]
    }
  };
  if (client === 'opencode') metadata.Config.Env.push(
    'HOME=/work/home', 'XDG_CONFIG_HOME=/work/config', 'XDG_CACHE_HOME=/work/cache',
    'XDG_DATA_HOME=/work/data', 'XDG_STATE_HOME=/work/state', 'OPENCODE_DISABLE_MODELS_FETCH=1',
    'OPENCODE_DISABLE_AUTOUPDATE=1', 'OPENCODE_DISABLE_LSP_DOWNLOAD=1',
    'OPENCODE_DISABLE_CLAUDE_CODE=1', 'OPENCODE_DISABLE_EXTERNAL_SKILLS=1'
  );
  imageMetadata.set(image, metadata);
  return handle;
}

export function describeUnitNativeImage(handle) {
  const state = images.get(handle);
  if (!state?.active) throw new Error('unit original image required');
  return state.description;
}

export function assertUnitNativeImage(handle, options) {
  const state = images.get(handle);
  if (!state?.active || state.client !== options.client) throw new Error('unit original image required');
}

const result = value => ({ exitCode: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });

// Only the VM loader substitutes these ports. No fixture executes Docker or a native executable.
export class UnitDockerControl {
  constructor(directory, deadline, signal) {
    this.directory = directory; this.deadline = deadline; this.signal = signal;
    this.configDirectory = path.join(directory, 'docker-config');
    this.services = new Set(); this.networks = new Map(); this.containers = new Map();
    this.commands = []; this.afterNativeCreate = null; this.socketMutation = null; this.denyConsumerRemoval = false;
    backends.push(this);
  }
  id() { return hash(randomUUID()); }
  find(values, identity) { return [...values.values()].find(item => item.Id === identity || item.Name === identity || item.Name === `/${identity}`); }
  missing(kind, identity) { return { exitCode: 1, stdout: '', stderr: `Error: No such ${kind}: ${identity}\n` }; }
  config(container) {
    const mount = container.HostConfig.Mounts.find(item => item.Target === '/boundary');
    return JSON.parse(fs.readFileSync(path.join(mount.Source, 'config.json'), 'utf8'));
  }
  async command(args, options = {}) {
    this.commands.push([...args]);
    const signal = Object.hasOwn(options, 'signal') ? options.signal : this.signal;
    if (signal?.aborted) throw new EgressBoundaryError('CANCELLED');
    if (args[0] === 'version') return result({ Version: DOCKER_ENGINE_VERSION, Os: 'linux', Arch: 'amd64' });
    if (args[0] === 'image') return result([args[2] === OFFLINE_NODE_IMAGE ? {
      Id: baseImageId, Os: 'linux', Architecture: 'amd64', RepoDigests: [OFFLINE_NODE_IMAGE], Config: { Env: baseEnvironment }
    } : imageMetadata.get(args[2])]);
    if (args[0] === 'network') {
      if (args[1] === 'create') {
        const labels = {}, options = {};
        for (let index = 0; index < args.length; index++) {
          if (args[index] === '--label' || args[index] === '--opt') {
            const [key, value] = args[index + 1].split('=');
            (args[index] === '--label' ? labels : options)[key] = value;
          }
        }
        const network = {
          Id: this.id(), Name: args.at(-1), Labels: labels, Options: options, Driver: 'bridge',
          Scope: 'local', Internal: args.includes('--internal'), EnableIPv6: false, Containers: {},
          IPAM: { Config: [{ Subnet: `172.28.${this.networks.size}.0/24` }] }
        };
        this.networks.set(network.Id, network);
        return result(network.Id);
      }
      if (args[1] === 'connect') {
        const container = this.find(this.containers, args.at(-1));
        const network = this.find(this.networks, args.at(-2));
        container.NetworkSettings.Networks[network.Name] = { NetworkID: network.Id };
        return result('');
      }
      const network = this.find(this.networks, args[2]);
      if (!network) return this.missing('network', args[2]);
      if (args[1] === 'rm') { this.networks.delete(network.Id); return result(network.Id); }
      network.Containers = Object.fromEntries([...this.containers.values()]
        .filter(item => Object.values(item.NetworkSettings.Networks).some(value => value.NetworkID === network.Id))
        .map(item => [item.Id, { Name: item.Name.slice(1) }]));
      return result([network]);
    }
    if (args[0] === 'create') {
      const get = name => args[args.indexOf(name) + 1];
      const many = name => args.flatMap((item, index) => item === name ? [args[index + 1]] : []);
      const labels = Object.fromEntries(many('--label').map(item => item.split('=')));
      const entrypoint = args.indexOf('--entrypoint'), image = args[entrypoint + 2];
      const env = new Map((imageMetadata.get(image)?.Config.Env ?? baseEnvironment).map(item => [item.split('=')[0], item]));
      for (const item of many('--env')) env.set(item.split('=')[0], item);
      const network = this.find(this.networks, get('--network'));
      const mounts = many('--mount').map(item => {
        const fields = Object.fromEntries(item.split(',').map(part => {
          const split = part.indexOf('='); return split < 0 ? [part, true] : [part.slice(0, split), part.slice(split + 1)];
        }));
        return {
          Type: fields.type, Source: fields.source, Target: fields.target, ReadOnly: fields.readonly === true,
          ...(fields.type === 'bind' ? { BindOptions: { NonRecursive: fields['bind-recursive'] === 'disabled' } }
            : { VolumeOptions: { NoCopy: fields['volume-nocopy'] === true } })
        };
      });
      const container = {
        Id: this.id(), Name: `/${get('--name')}`, Image: image === OFFLINE_NODE_IMAGE ? baseImageId : image,
        Config: { User: get('--user'), Env: [...env.values()], WorkingDir: get('--workdir'),
          Entrypoint: [get('--entrypoint')], Cmd: args.slice(entrypoint + 3), Labels: labels },
        State: { Running: false, Status: 'created' }, NetworkSettings: { Networks: { [network.Name]: { NetworkID: '' } } },
        Mounts: mounts.map(item => ({ Type: item.Type, Destination: item.Target, RW: !item.ReadOnly,
          ...(item.Type === 'volume' ? { Name: item.Source } : {}) })),
        HostConfig: {
          ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null,
          SecurityOpt: ['no-new-privileges=true'], Memory: get('--memory') === '768m' ? 805306368 : 268435456,
          MemorySwap: get('--memory-swap') === '768m' ? 805306368 : 268435456,
          PidsLimit: Number(get('--pids-limit')), NanoCpus: 1000000000, LogConfig: { Type: 'none' },
          IpcMode: 'none', PidMode: '', UTSMode: '', RestartPolicy: { Name: 'no' }, Mounts: mounts,
          GroupAdd: many('--group-add'), Dns: many('--dns'),
          Tmpfs: Object.fromEntries(many('--tmpfs').map(item => [item.slice(0, item.indexOf(':')), item.slice(item.indexOf(':') + 1)])),
          Sysctls: Object.fromEntries(many('--sysctl').map(item => item.split('=')))
        }
      };
      this.containers.set(container.Id, container);
      if (labels['ai.skill-eval.egress.role'] === 'native-candidate') {
        this.native = container; this.nativeCreateArguments = [...args]; events.push('consumer-create');
        await this.afterNativeCreate?.();
      }
      return result(container.Id);
    }
    const identity = args[0] === 'container' ? args[2] : args.at(-1);
    const container = this.find(this.containers, identity);
    if (args[0] === 'container') return container ? result([container]) : this.missing('container', identity);
    if (args[0] === 'stop') {
      assert.ok(container);
      container.State = { Running: false, Status: 'exited' };
      if (container === this.native) events.push('consumer-stop');
      return result(container.Id);
    }
    if (args[0] === 'rm') {
      assert.ok(container);
      assert.equal(container.State.Running, false);
      if (container === this.native && this.denyConsumerRemoval) throw new Error('unit removal blocked');
      this.containers.delete(container.Id);
      if (container === this.native) events.push('consumer-rm');
      return result(container.Id);
    }
    if (args[0] === 'exec') {
      const target = this.find(this.containers, args[1]), config = this.config(target);
      const kernel = { owner: config.owner, candidateId: config.candidateId ?? null, nodeVersion: OFFLINE_NODE_VERSION,
        defaultRoutes: 0, ipv6Disabled: true, nameservers: ['127.0.0.1'], resolverHash, ready: true };
      if (args.some(item => item.includes('relay-state.json'))) return result({
        owner: config.owner, issuer: config.issuer ?? 'public-exact-dns-tls-443',
        policyHash: createPublicPolicy(config.hosts).policyHash, nodeVersion: OFFLINE_NODE_VERSION,
        ready: true, accepted: 0, denied: Object.fromEntries(codes.map(code => [code, 1])), approvedHosts: {}
      });
      if (args.includes('--probe')) return result({
        owner: config.owner, nodeVersion: OFFLINE_NODE_VERSION, issuer: 'public-exact-dns-tls-443',
        denied: Object.fromEntries(codes.map(code => [code, true])), allowed: null
      });
      if (args.includes('/boundary/native-runtime-probe.mjs')) {
        const native = config.native, [uid, gid] = native.user.split(':').map(Number);
        return result({
          owner: config.owner, candidateId: config.candidateId, client: native.client,
          clientVersion: native.clientVersion, packageVersion: native.clientVersion,
          versionText: native.client === 'claude-code' ? `${native.clientVersion} (Claude Code)`
            : native.client === 'copilot' ? `GitHub Copilot CLI ${native.clientVersion}.unit` : native.clientVersion,
          nodeVersion: OFFLINE_NODE_VERSION, uid, gid, executable: native.executable,
          resolvedExecutable: `${native.executableRoot}unit-binary`, executableHash: 'd'.repeat(64),
          cwd: native.workdir, directories: native.directories.map(item => ({ path: item, uid, gid, writable: true })),
          immutableDirectories: native.immutableDirectories,
          commands: ['--version', '--help'].map(flag => ({
            argv: [...(native.client === 'copilot' ? ['--no-auto-update'] : []), flag],
            exitCode: 0, signal: null, stdoutBytes: 10, stderrBytes: 0, stdoutHash: 'e'.repeat(64), stderrHash: 'f'.repeat(64)
          }))
        });
      }
      if (args.includes('/boundary/native-tool-transport-probe.mjs')) {
        const [uid, gid] = target.Config.User.split(':').map(Number);
        const value = {
          ...kernel, deadlineUnixMs: config.toolTransport.deadlineUnixMs, uid, gid,
          supplementaryGroups: [gid, 21000],
          directory: { path: '/tool-rpc', type: 'directory', uid: 10002, gid: 21000, mode: 0o710 },
          socket: { path: '/tool-rpc/worker.sock', type: 'socket', uid: 10002, gid: 21000, mode: 0o660 }, connected: false
        };
        this.socketMutation?.(value);
        return result(value);
      }
      return result(kernel);
    }
    throw new Error('unexpected unit Docker command');
  }
  attach(name) {
    const container = this.find(this.containers, name);
    container.State = { Running: true, Status: 'running' };
    for (const [name, network] of Object.entries(container.NetworkSettings.Networks)) {
      network.NetworkID = this.find(this.networks, name).Id;
    }
    const service = { name, closed: false, stopping: false };
    this.services.add(service);
    return service;
  }
  assertServices() { for (const service of this.services) assert.equal(service.closed, false); }
  async closeAttachment(name) {
    const service = [...this.services].find(item => item.name === name);
    assert.ok(service); this.services.delete(service); return 1;
  }
  async closeAttachments() { const count = this.services.size; this.services.clear(); return count; }
}

export async function runUnitRegressions() {
  let regressions = 0;
  const rejects = (operation, code) => assert.rejects(operation, error => error.code === code);
  const throws = (operation, code) => assert.throws(operation, error => error.code === code);
  const scopes = [];
  async function scope(client = 'claude-code', withTransport = true, beforePreparation, workerOptions) {
    const controller = new AbortController();
    const boundary = await startEgressBoundary({
      hosts: ['unit-transport.example.com'], timeoutSeconds: 120, mode: 'egress-only', signal: controller.signal
    });
    const original = issueTransport(client, workerOptions), imageHandle = issueImage(client);
    const selected = {
      boundary, original, initialTuple: { ...original.tuple }, imageHandle, client, controller,
      backend: backends.at(-1), candidate: null
    };
    scopes.push(selected);
    beforePreparation?.(selected);
    selected.candidate = await prepareNativeEgressCandidate(boundary, {
      client, imageHandle, ...(withTransport ? { toolTransport: original.tuple } : {})
    });
    return selected;
  }
  async function closeWorker(selected) {
    assert.equal(selected.backend.containers.has(selected.backend.native?.Id), false);
    selected.original.state.lifecycle = 'closed'; events.push('worker-close');
  }
  try {
    for (const client of Object.keys(NATIVE_CANDIDATE_PROFILES)) {
      const selected = await scope(client);
      const { candidate, boundary, imageHandle, original, backend } = selected;
      const plan = describeEgressCandidate(candidate).toolTransport;
      assert.equal(plan.planningOnly, true); assert.equal(plan.attachmentVerified, false);
      assert.equal(Object.hasOwn(plan, 'binding'), false);
      for (const secret of [original.tuple.binding.transportMount.source, original.tuple.binding.stdioCommand[8],
        original.tuple.binding.stdioCommand[11]]) assert.equal(JSON.stringify(plan).includes(secret), false);
      await attachEgressCandidate(candidate);
      const attached = describeEgressCandidate(candidate);
      assert.equal(attached.user, NATIVE_CANDIDATE_PROFILES[client].user);
      assert.equal(attached.toolTransport.attachmentVerified, true);
      assert.equal(attached.toolTransport.observation.connected, false);
      assert.equal(attached.toolTransport.observation.shimExecuted, false);
      assert.equal(attached.effectiveDeadlineUnixMs, original.state.deadline);
      const mount = backend.native.HostConfig.Mounts.find(item => item.Type === 'volume');
      assert.equal(mount.Source, original.tuple.binding.transportMount.source);
      assert.equal(mount.ReadOnly, true); assert.equal(mount.VolumeOptions.NoCopy, true);
      assert.equal(backend.native.HostConfig.GroupAdd.join(','), '21000');
      assert.equal(backend.config(backend.native).toolTransport.deadlineUnixMs, original.state.deadline);
      assert.equal(backend.config(backend.native).expiresAt, original.state.deadline);
      const before = original.state.freshCount;
      await assertNativeEgressCandidate(candidate, { boundary, client, imageHandle, toolTransport: original.tuple });
      assert.equal(original.state.freshCount, before + 2);
      await inspectNativeEgressCandidate(candidate);
      assert.equal(original.state.freshCount, before + 4);
      for (const field of ['nativeAdmissionSupported', 'nativeConsumptionSupported', 'consumerSupervisionSupported',
        'nativeDiscoveryVerified', 'skillDiscoveryVerified', 'authenticationVerified', 'liveAccepted']) {
        assert.equal(describeEgressCandidate(candidate).toolTransport[field], false);
      }
      for (const changed of [
        { ...original.tuple, task: { ...original.tuple.task } },
        { ...original.tuple, worker: { ...original.tuple.worker } },
        { ...original.tuple, lease: { ...original.tuple.lease } },
        { ...original.tuple, binding: structuredClone(original.tuple.binding) },
        issueTransport(client).tuple,
        issueTransport(client, { sameTask: original.tuple.task.coordinates }).tuple
      ]) await rejects(assertNativeEgressCandidate(candidate, {
        boundary, client, imageHandle, toolTransport: changed
      }), 'TOOL_TRANSPORT_SCOPE_MISMATCH');
      await rejects(assertNativeEgressCandidate(candidate, { boundary, client, imageHandle }),
        'TOOL_TRANSPORT_SCOPE_MISMATCH');
      assert.equal(describeEgressCandidate(candidate).status, 'attached');
      const cleanup = await stopEgressCandidate(candidate);
      assert.equal(cleanup.toolTransportConsumer.exactConsumerAbsent, true);
      assert.equal(cleanup.toolTransportConsumer.workerVolumeRemoved, false);
      assert.equal(cleanup.toolTransportConsumer.workerContainerRemoved, false);
      assert.equal(cleanup.containerIds.includes(backend.native.Id), true);
      assert.equal(cleanup.helperProcessesClosed, 3);
      assert.equal(backend.commands.some(args => args[0] === 'volume'), false);
      assert.equal(describeEgressCandidate(candidate).toolTransport.attachmentVerified, false);
      await closeWorker(selected);
      assert.ok(events.lastIndexOf('consumer-rm') < events.lastIndexOf('worker-close'));
      assert.equal((await stopEgressCandidate(candidate)), cleanup);
      regressions += 3;
    }

    const old = await scope('copilot', false);
    await attachEgressCandidate(old.candidate);
    await assertNativeEgressCandidate(old.candidate, { boundary: old.boundary, client: old.client, imageHandle: old.imageHandle });
    assert.equal(Object.hasOwn(describeEgressCandidate(old.candidate), 'toolTransport'), false);
    assert.equal(old.backend.native.HostConfig.Mounts.some(item => item.Type === 'volume'), false);
    assert.equal(old.backend.native.HostConfig.GroupAdd.length, 0);
    assert.equal(Object.hasOwn(await stopEgressCandidate(old.candidate), 'toolTransportConsumer'), false);
    regressions++;

    const current = issueTransport('claude-code');
    const captured = captureNativeToolTransport(current.tuple, 'claude-code');
    for (const key of ['task', 'worker', 'lease', 'binding']) {
      throws(() => captureNativeToolTransport({ ...current.tuple, [key]: { ...current.tuple[key] } }, 'claude-code'),
        'TOOL_TRANSPORT_UNTRUSTED');
    }
    throws(() => captureNativeToolTransport(current.tuple, 'copilot'), 'TOOL_TRANSPORT_SCOPE_MISMATCH');
    throws(() => captureNativeToolTransport(issueTransport('claude-code', { corruptShim: true }).tuple, 'claude-code'),
      'TOOL_TRANSPORT_PIN_MISMATCH');
    current.state.freshHook = () => { current.state.terminalError = new ToolWorkerError('CANCELLED'); };
    await rejects(assertFreshNativeToolTransport(captured), 'TOOL_TRANSPORT_CANCELLED');
    const failedCleanup = issueTransport('claude-code');
    const beforeFailure = captureNativeToolTransport(failedCleanup.tuple, 'claude-code');
    failedCleanup.state.freshHook = () => {
      failedCleanup.state.terminalError = new ToolWorkerError('TIMEOUT');
      throw new ToolWorkerError('CLEANUP_FAILED');
    };
    await rejects(assertFreshNativeToolTransport(beforeFailure), 'TOOL_TRANSPORT_EXPIRED');
    throws(() => captureNativeToolTransport(issueTransport('claude-code', { deadline: Date.now() - 1 }).tuple,
      'claude-code'), 'TOOL_TRANSPORT_EXPIRED');
    regressions++;

    const mutable = await scope('claude-code', true, selected => {
      selected.original.state.freshHook = () => {
        selected.original.tuple.binding = { ...selected.original.tuple.binding };
        selected.original.state.freshHook = null;
      };
    });
    await attachEgressCandidate(mutable.candidate);
    await assertNativeEgressCandidate(mutable.candidate, {
      boundary: mutable.boundary, client: mutable.client, imageHandle: mutable.imageHandle, toolTransport: mutable.initialTuple
    });
    await rejects(assertNativeEgressCandidate(mutable.candidate, {
      boundary: mutable.boundary, client: mutable.client, imageHandle: mutable.imageHandle, toolTransport: mutable.original.tuple
    }), 'TOOL_TRANSPORT_SCOPE_MISMATCH');
    await stopEgressCandidate(mutable.candidate); regressions++;

    const closed = await scope();
    closed.original.state.lifecycle = 'closed';
    await rejects(attachEgressCandidate(closed.candidate), 'TOOL_TRANSPORT_CLOSED');
    assert.equal(closed.backend.containers.size, 0); regressions++;

    const expired = await scope();
    expired.original.state.terminalError = new ToolWorkerError('TIMEOUT');
    await rejects(attachEgressCandidate(expired.candidate), 'TOOL_TRANSPORT_EXPIRED');
    assert.equal(expired.backend.containers.size, 0); regressions++;

    const timed = await scope('claude-code', true, undefined, { deadline: Date.now() + 1000 });
    await attachEgressCandidate(timed.candidate);
    await new Promise(resolve => setTimeout(resolve, Math.max(1, timed.original.state.deadline - Date.now() + 25)));
    const timedCleanup = await stopEgressCandidate(timed.candidate);
    assert.equal(timedCleanup.toolTransportConsumer.exactConsumerAbsent, true);
    assert.equal(timed.backend.containers.size, 0);
    assert.equal(timed.original.state.runController.signal.aborted, false); regressions++;

    const postCreate = await scope();
    postCreate.backend.afterNativeCreate = () => { postCreate.original.state.terminalError = new ToolWorkerError('TIMEOUT'); };
    await rejects(attachEgressCandidate(postCreate.candidate), 'TOOL_TRANSPORT_EXPIRED');
    assert.equal(postCreate.backend.containers.size, 0);
    assert.ok(events.lastIndexOf('consumer-rm') > events.lastIndexOf('consumer-create')); regressions++;

    const socketFailure = await scope();
    socketFailure.backend.socketMutation = value => { value.socket.mode = 0o666; };
    await rejects(attachEgressCandidate(socketFailure.candidate), 'TOOL_TRANSPORT_SOCKET_MISMATCH');
    assert.equal(socketFailure.backend.containers.size, 0); regressions++;

    const cancelled = await scope();
    let release, reached;
    const arrived = new Promise(resolve => { reached = resolve; });
    cancelled.backend.afterNativeCreate = () => new Promise(resolve => { release = resolve; reached(); });
    const attachment = attachEgressCandidate(cancelled.candidate);
    await arrived;
    const stopping = stopEgressCandidate(cancelled.candidate);
    release();
    await rejects(attachment, 'CANCELLED');
    assert.equal((await stopping).toolTransportConsumer.exactConsumerAbsent, true);
    assert.equal(cancelled.original.state.lifecycle, 'ready');
    await closeWorker(cancelled); regressions++;

    const assertionStop = await scope();
    await attachEgressCandidate(assertionStop.candidate);
    let resumeAssertion, assertionReached;
    const assertionArrived = new Promise(resolve => { assertionReached = resolve; });
    assertionStop.original.state.freshHook = () => new Promise(resolve => {
      resumeAssertion = resolve; assertionReached();
    });
    const asserting = assertNativeEgressCandidate(assertionStop.candidate, {
      boundary: assertionStop.boundary, client: assertionStop.client,
      imageHandle: assertionStop.imageHandle, toolTransport: assertionStop.original.tuple
    });
    await assertionArrived;
    const assertionCleanup = stopEgressCandidate(assertionStop.candidate);
    resumeAssertion();
    await rejects(asserting, 'CANCELLED');
    assert.equal((await assertionCleanup).toolTransportConsumer.exactConsumerAbsent, true);
    assert.equal(assertionStop.original.state.runController.signal.aborted, false); regressions++;

    const inspectionFailure = await scope();
    await attachEgressCandidate(inspectionFailure.candidate);
    const failAt = inspectionFailure.original.state.freshCount + 2;
    inspectionFailure.original.state.freshHook = count => {
      if (count === failAt) inspectionFailure.original.state.terminalError = new ToolWorkerError('CANCELLED');
    };
    await rejects(inspectNativeEgressCandidate(inspectionFailure.candidate), 'TOOL_TRANSPORT_CANCELLED');
    assert.equal(inspectionFailure.backend.containers.size, 0); regressions++;

    const releasedImage = await scope();
    await attachEgressCandidate(releasedImage.candidate);
    images.get(releasedImage.imageHandle).active = false;
    await rejects(assertNativeEgressCandidate(releasedImage.candidate, {
      boundary: releasedImage.boundary, client: releasedImage.client,
      imageHandle: releasedImage.imageHandle, toolTransport: releasedImage.original.tuple
    }), 'NATIVE_IMAGE_UNTRUSTED');
    assert.equal(releasedImage.backend.containers.size, 0); regressions++;

    const recovery = await scope();
    recovery.backend.afterNativeCreate = () => { recovery.original.state.terminalError = new ToolWorkerError('TIMEOUT'); };
    recovery.backend.denyConsumerRemoval = true;
    await assert.rejects(attachEgressCandidate(recovery.candidate), error => {
      assert.equal(error.code, 'CLEANUP_FAILED'); assert.equal(error.recoveryHandle, recovery.boundary);
      assert.equal(error.failureCode, 'TOOL_TRANSPORT_EXPIRED');
      assert.equal(error.cleanupVerified, false); return true;
    });
    assert.equal(recovery.backend.containers.has(recovery.backend.native.Id), true);
    recovery.backend.denyConsumerRemoval = false;
    assert.equal((await stopEgressCandidate(recovery.candidate)).toolTransportConsumer.exactConsumerAbsent, true);
    await closeWorker(recovery); regressions++;

    return { classification: 'unit-wiring-only-not-kernel-or-native-evidence', regressions, actualDockerCommands: 0 };
  } finally {
    for (const selected of scopes) {
      selected.backend.denyConsumerRemoval = false;
      await stopEgressBoundary(selected.boundary);
    }
  }
}
