import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  captureNativeToolTransport, measureNativeToolTransportMount, validateNativeToolSocketObservation
} from '../harness/live-boundary/tool-transport.mjs';
import { EgressBoundaryError } from '../harness/live-boundary/index.mjs';
import { deepFreeze } from '../harness/live-boundary/errors.mjs';
import {
  CANDIDATE_LABEL, ISSUER_LABEL, OWNER_LABEL, ROLE_LABEL, measureConfinement
} from '../harness/live-boundary/ownership.mjs';
import { NATIVE_CANDIDATE_PROFILES } from '../harness/live-boundary/native-image.mjs';
import { issueToolTask } from '../harness/tool-worker/index.mjs';

const code = expected => error => error instanceof EgressBoundaryError && error.code === expected;
const root = fileURLToPath(new URL('../', import.meta.url));

test('wiring-only: optional tuple accepts no Docker IDs, descriptors, accessors, proxies, commands or caller proofs', () => {
  const fake = Object.freeze({ kind: 'not-original' });
  const tuple = { task: fake, worker: fake, lease: fake, binding: fake };
  for (const value of [null, undefined, [], 'external', new Proxy(tuple, {}), { ...tuple, volume: 'external' },
    { ...tuple, env: {} }, { ...tuple, group: 21000 }, { ...tuple, command: [] }, { ...tuple, proof: () => true },
    { ...tuple, [Symbol('proof')]: true }, { ...tuple, worker: 'external' },
    { ...tuple, binding: new Proxy(fake, {}) },
    Object.defineProperty({ ...tuple }, 'binding', { get() { throw new Error('must not execute'); } })]) {
    assert.throws(() => captureNativeToolTransport(value, 'copilot'), code('INVALID_ARGUMENT'));
  }
  assert.throws(() => captureNativeToolTransport(tuple, 'copilot'), code('TOOL_TRANSPORT_UNTRUSTED'));
  const task = issueToolTask({
    invocationId: randomUUID(), caseId: 'transport-interface-unit', client: 'copilot', arm: 'candidate', repeat: 1
  });
  assert.throws(() => captureNativeToolTransport({ ...tuple, task }, 'copilot'), code('TOOL_TRANSPORT_UNTRUSTED'));
});

function confinementFixture(client) {
  const profile = NATIVE_CANDIDATE_PROFILES[client];
  const id = 'a'.repeat(64), network = 'b'.repeat(64), owner = randomUUID(), candidateId = randomUUID();
  const transport = deepFreeze({
    mount: { type: 'volume', source: `eval-tool-socket-${randomUUID()}`, target: '/tool-rpc', readOnly: true, noCopy: true },
    supplementalGid: 21000, primaryUser: profile.user
  });
  const expected = {
    id, name: `skill-egress-${owner}-native-${candidateId}`, owner, candidateId,
    role: 'native-candidate', issuer: 'public-exact-dns-tls-443',
    imageId: `sha256:${'c'.repeat(64)}`, user: profile.user, memoryBytes: 805306368, pidsLimit: profile.pidsLimit,
    networkIds: [network], env: ['HOME=/empty-native-home'],
    mounts: [{ source: 'C:\\owned\\public-only', destination: '/candidate-inputs' }],
    tmpfs: { '/scratch': `rw,noexec,nosuid,nodev,size=16m,mode=700,uid=${profile.user.split(':')[0]},gid=${profile.user.split(':')[1]}` },
    nativeLayout: { workdir: profile.initialWorkdir, entrypoint: ['/usr/local/bin/node'],
      command: ['/boundary/candidate-probe.mjs', '--idle'] }, toolTransport: transport
  };
  const container = {
    Id: id, Name: `/${expected.name}`, Image: expected.imageId, State: { Running: true },
    Config: {
      User: expected.user, Env: expected.env, WorkingDir: expected.nativeLayout.workdir,
      Entrypoint: expected.nativeLayout.entrypoint, Cmd: expected.nativeLayout.command,
      Labels: { [OWNER_LABEL]: owner, [ROLE_LABEL]: expected.role, [ISSUER_LABEL]: expected.issuer,
        [CANDIDATE_LABEL]: candidateId }
    },
    NetworkSettings: { Networks: { inside: { NetworkID: network } } },
    Mounts: [
      { Type: 'bind', Destination: '/candidate-inputs', RW: false },
      { Type: 'volume', Name: transport.mount.source, Destination: '/tool-rpc', RW: false }
    ],
    HostConfig: {
      ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null,
      SecurityOpt: ['no-new-privileges=true'], Memory: expected.memoryBytes, MemorySwap: expected.memoryBytes,
      PidsLimit: profile.pidsLimit, NanoCpus: 1000000000, LogConfig: { Type: 'none' },
      IpcMode: 'none', PidMode: '', UTSMode: '', RestartPolicy: { Name: 'no' }, Dns: ['127.0.0.1'],
      Tmpfs: expected.tmpfs, GroupAdd: ['21000'],
      Mounts: [
        { Type: 'bind', Source: expected.mounts[0].source, Target: '/candidate-inputs',
          ReadOnly: true, BindOptions: { NonRecursive: true } },
        { Type: 'volume', Source: transport.mount.source, Target: '/tool-rpc',
          ReadOnly: true, VolumeOptions: { NoCopy: true } }
      ],
      Sysctls: { 'net.ipv6.conf.all.disable_ipv6': '1', 'net.ipv6.conf.default.disable_ipv6': '1' }
    }
  };
  return { expected, container };
}

test('wiring-only: original socket-only RO/no-copy volume and GID preserve each exact native primary identity', () => {
  for (const client of Object.keys(NATIVE_CANDIDATE_PROFILES)) {
    const { expected, container } = confinementFixture(client);
    const result = measureConfinement(container, expected);
    assert.equal(result.user, client === 'copilot' ? '10001:10001' : '1000:1000');
    assert.equal(result.toolTransport.primaryUser, result.user);
    assert.equal(result.toolTransport.supplementalGid, 21000);
    assert.equal(result.toolTransport.volumeSourceHash.length, 64);
    assert.equal(JSON.stringify(result).includes(expected.toolTransport.mount.source), false);
    for (const mutate of [
      value => { value.Mounts[1].Type = 'bind'; },
      value => { value.Mounts[1].Name = `eval-tool-socket-${randomUUID()}`; },
      value => { value.Mounts[1].Destination = '/other'; },
      value => { value.Mounts[1].RW = true; },
      value => { value.HostConfig.Mounts[1].Source = 'external-volume'; },
      value => { value.HostConfig.Mounts[1].Target = '/other'; },
      value => { value.HostConfig.Mounts[1].ReadOnly = false; },
      value => { delete value.HostConfig.Mounts[1].ReadOnly; },
      value => { value.HostConfig.Mounts[1].VolumeOptions.NoCopy = false; },
      value => { value.HostConfig.GroupAdd = ['1000']; },
      value => { value.HostConfig.GroupAdd.push('21001'); },
      value => { value.HostConfig.Binds = ['foreign:/foreign']; },
      value => { value.Mounts.push({ Type: 'volume', Name: 'external-volume', Destination: '/foreign', RW: false }); }
    ]) {
      const changed = structuredClone(container); mutate(changed);
      assert.throws(() => measureNativeToolTransportMount(changed, expected.toolTransport),
        code('TOOL_TRANSPORT_MOUNT_MISMATCH'));
    }
    for (const mutate of [
      value => { value.Config.User = client === 'copilot' ? '1000:1000' : '10001:10001'; },
      value => { value.Mounts[0].RW = true; },
      value => { value.HostConfig.Mounts[0].Source = 'C:\\foreign\\credentials'; },
      value => { value.Config.Env.push('PERSONAL_TOKEN=synthetic-not-credential'); },
      value => { value.HostConfig.ReadonlyRootfs = false; }
    ]) {
      const changed = structuredClone(container); mutate(changed);
      assert.throws(() => measureConfinement(changed, expected), code('CONFIG_MISMATCH'));
    }
  }
});

test('wiring-only: no-transport confinement keeps its old report and bind-only contract', () => {
  const { expected, container } = confinementFixture('copilot');
  delete expected.toolTransport;
  container.Mounts.pop();
  container.HostConfig.Mounts.pop();
  delete container.HostConfig.GroupAdd;
  const result = measureConfinement(container, expected);
  assert.equal(Object.hasOwn(result, 'toolTransport'), false);
  assert.equal(result.mounts.length, 1);
});

test('wiring-only: consumer socket parser rejects file substitution, wrong owners, groups, permissions and a consumed connection', () => {
  for (const client of Object.keys(NATIVE_CANDIDATE_PROFILES)) {
    const [uid, gid] = NATIVE_CANDIDATE_PROFILES[client].user.split(':').map(Number);
    const transport = { client, deadline: Date.now() + 60000 };
    const candidate = { id: randomUUID(), boundaryState: { owner: randomUUID() } };
    const socket = {
      owner: candidate.boundaryState.owner, candidateId: candidate.id, deadlineUnixMs: transport.deadline,
      uid, gid, supplementaryGroups: [gid, 21000],
      directory: { path: '/tool-rpc', type: 'directory', uid: 10002, gid: 21000, mode: 0o710 },
      socket: { path: '/tool-rpc/worker.sock', type: 'socket', uid: 10002, gid: 21000, mode: 0o660 }, connected: false
    };
    assert.equal(validateNativeToolSocketObservation(transport, candidate, socket).connected, false);
    for (const mutate of [
      value => { value.deadlineUnixMs++; }, value => { value.uid = 0; },
      value => { value.gid = 0; }, value => { value.supplementaryGroups = [gid]; },
      value => { value.supplementaryGroups.push(0); }, value => { value.socket.type = 'file'; },
      value => { value.socket.path = '/tool-rpc/foreign.sock'; }, value => { value.socket.uid = uid; },
      value => { value.socket.gid = gid; }, value => { value.socket.mode = 0o666; },
      value => { value.directory.mode = 0o770; }, value => { value.connected = true; }
    ]) {
      const changed = structuredClone(socket); mutate(changed);
      assert.throws(() => validateNativeToolSocketObservation(transport, candidate, changed),
        code('TOOL_TRANSPORT_SOCKET_MISMATCH'));
    }
  }
});

test('wiring-only: isolated VM originals exercise optional authority, freshness, lifetime and exact cleanup ordering (no Docker)', () => {
  const fixtures = new URL('./live-boundary-native-transport.fixtures.mjs', import.meta.url).href;
  const boundary = new URL('../harness/live-boundary/', import.meta.url).href;
  const worker = new URL('../harness/tool-worker/index.mjs', import.meta.url).href;
  const source = `
    import fs from 'node:fs';
    import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
    const fixtures = ${JSON.stringify(fixtures)};
    const context = createContext({
      process, Buffer, console, URL, AbortController, AbortSignal, EventTarget,
      setTimeout, clearTimeout, setInterval, clearInterval, structuredClone
    });
    const sources = new Map([
      [${JSON.stringify(`${boundary}supervision.mjs`)},
        'export { UnitDockerControl as DockerControl } from ' + JSON.stringify(fixtures) +
        '; export const retryStartingExec = () => false;'],
      [${JSON.stringify(worker)},
        'export { assertToolWorkerTransportBinding, describeToolWorkerTransportBinding, ToolWorkerError } from ' +
        JSON.stringify(fixtures) + ';'],
      [${JSON.stringify(new URL('../harness/clients/claude-code/image.mjs', import.meta.url).href)},
        'export { describeUnitNativeImage as describeNativeImage } from ' + JSON.stringify(fixtures) + ';'],
      [${JSON.stringify(new URL('../harness/clients/copilot/index.mjs', import.meta.url).href)},
        'export { describeUnitNativeImage as describeNativeImage } from ' + JSON.stringify(fixtures) + ';'],
      [${JSON.stringify(new URL('../harness/clients/opencode/runtime-image.mjs', import.meta.url).href)},
        'export { describeUnitNativeImage as describeNativeRuntimeImage, assertUnitNativeImage as assertNativeRuntimeImage } from ' +
        JSON.stringify(fixtures) + ';']
    ]);
    const cache = new Map();
    async function load(specifier, parent = fixtures) {
      const external = specifier.startsWith('node:') ||
        !specifier.startsWith('.') && !specifier.startsWith('file:');
      const url = external ? specifier : new URL(specifier, parent).href;
      if (cache.has(url)) return cache.get(url);
      if (external) {
        const namespace = await import(url);
        const module = new SyntheticModule(Object.keys(namespace), function () {
          for (const key of Object.keys(namespace)) this.setExport(key, namespace[key]);
        }, { context, identifier: url });
        cache.set(url, module);
        return module;
      }
      const module = new SourceTextModule(sources.get(url) ?? fs.readFileSync(new URL(url), 'utf8'), {
        context, identifier: url, initializeImportMeta(meta) { meta.url = url; }
      });
      cache.set(url, module);
      return module;
    }
    const module = await load(fixtures);
    await module.link((specifier, parent) => load(specifier, parent.identifier));
    await module.evaluate();
    const result = await module.namespace.runUnitRegressions();
    console.log(JSON.stringify(result));
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '--eval', source], {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 131072, windowsHide: true, shell: false
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.classification, 'unit-wiring-only-not-kernel-or-native-evidence');
  assert.equal(report.regressions, 22);
  assert.equal(report.actualDockerCommands, 0);
});
