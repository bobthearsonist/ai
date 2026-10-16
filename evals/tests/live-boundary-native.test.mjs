import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertNativeEgressCandidate, attachEgressCandidate, describeEgressBoundary, describeEgressCandidate,
  EgressBoundaryError, inspectNativeEgressCandidate, prepareNativeEgressCandidate,
  startEgressBoundary, stopEgressBoundary, stopEgressCandidate
} from '../harness/live-boundary/index.mjs';
import {
  assertNativeCandidateSeed, captureNativeImageAuthority, NATIVE_CANDIDATE_PROFILES,
  validateNativeImageMetadata, validateNativeRuntimeObservation
} from '../harness/live-boundary/native-image.mjs';
import { createCandidateSeed, destroyCandidateSeed } from '../harness/live-boundary/candidate-seed.mjs';
import { CLIENT_VERSIONS, OFFLINE_NODE_VERSION } from '../harness/isolation/index.mjs';
import {
  CANDIDATE_LABEL, ISSUER_LABEL, OWNER_LABEL, ROLE_LABEL, measureConfinement
} from '../harness/live-boundary/ownership.mjs';
import {
  prepareNativeImage as prepareClaudeImage, cleanupNativeImage as cleanupClaudeImage
} from '../harness/clients/claude-code/image.mjs';
import {
  buildNativeImage as prepareCopilotImage, cleanupNativeImage as cleanupCopilotImage
} from '../harness/clients/copilot/index.mjs';
import {
  prepareNativeRuntimeImage as prepareOpenCodeImage, cleanupNativeRuntimeImage as cleanupOpenCodeImage
} from '../harness/clients/opencode/runtime-image.mjs';

const boundaryRoot = fileURLToPath(new URL('../harness/live-boundary/', import.meta.url));
const code = expected => error => error instanceof EgressBoundaryError && error.code === expected;
const clients = Object.keys(CLIENT_VERSIONS);
const nativeReports = [];

test('wiring-only: native API rejects option/proof/DTO substitution without issuing authority or using Docker', async () => {
  const boundary = Object.freeze({ owner: randomUUID(), kind: 'process-owned-egress-boundary' });
  const candidate = Object.freeze({ id: randomUUID(), kind: 'process-owned-egress-candidate' });
  const imageHandle = Object.freeze({ image: `sha256:${'a'.repeat(64)}` });
  const options = { client: 'opencode', imageHandle };
  for (const changed of [
    { image: 'tag:latest' }, { imageId: imageHandle.image }, { containerId: 'external' },
    { proof: () => true }, { nativeRuntimeVerified: true }, { mode: 'live' },
    { authRoot: 'personal-home' }, { credentials: 'not-a-secret' },
    { timeoutSeconds: 300 }, { signal: new AbortController().signal }, { client: 'unknown' },
    { imageHandle: 'tag:latest' }, { imageHandle: null }, { imageHandle: new Proxy(imageHandle, {}) }
  ]) await assert.rejects(prepareNativeEgressCandidate(boundary, { ...options, ...changed }), code('INVALID_ARGUMENT'));
  for (const value of [new Proxy(options, {}), { ...options, [Symbol('proof')]: true },
    Object.defineProperty({ imageHandle }, 'client', { get() { throw new Error('never-read'); } })]) {
    await assert.rejects(prepareNativeEgressCandidate(boundary, value), code('INVALID_ARGUMENT'));
  }
  await assert.rejects(prepareNativeEgressCandidate(boundary, options, {}), code('INVALID_ARGUMENT'));
  await assert.rejects(prepareNativeEgressCandidate(boundary, options), code('INVALID_HANDLE'));
  await assert.rejects(assertNativeEgressCandidate(candidate, { boundary, client: 'opencode', imageHandle }),
    code('INVALID_HANDLE'));
  await assert.rejects(assertNativeEgressCandidate(candidate, {
    boundary, client: 'opencode', imageHandle, verified: true
  }), code('INVALID_ARGUMENT'));
  assert.throws(() => inspectNativeEgressCandidate(candidate), code('INVALID_HANDLE'));
  assert.throws(() => inspectNativeEgressCandidate(candidate, {}), code('INVALID_ARGUMENT'));
  assert.throws(() => startEgressBoundary({
    hosts: ['api.example.com'], timeoutSeconds: 30, mode: 'live'
  }), code('LIVE_BOUNDARY_UNVERIFIED'));
});

test('wiring-only: every native owner rejects strings, receipts, copied labels and cross-owner DTOs', async () => {
  for (const client of clients) {
    for (const value of [undefined, null, true, 'tag:latest', `sha256:${'a'.repeat(64)}`, {
      client, image: `sha256:${'a'.repeat(64)}`, clientVersion: CLIENT_VERSIONS[client],
      id: randomUUID(), preparationId: randomUUID(), invocationId: randomUUID()
    }]) await assert.rejects(captureNativeImageAuthority(client, value), code('NATIVE_IMAGE_UNTRUSTED'));
  }
});

function metadataFixture(client) {
  const profile = NATIVE_CANDIDATE_PROFILES[client];
  const binding = { client, owner: randomUUID(), imageId: `sha256:${'a'.repeat(64)}` };
  const image = {
    Id: binding.imageId, Os: 'linux', Architecture: 'amd64',
    Config: {
      User: profile.imageUser, WorkingDir: profile.imageWorkdir, Entrypoint: profile.imageEntrypoint, Cmd: null,
      Labels: { [profile.imageOwnerLabel]: binding.owner },
      Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        `NODE_VERSION=${OFFLINE_NODE_VERSION}`, 'YARN_VERSION=1.22.22',
        ...(client === 'opencode' ? [
          'HOME=/work/home', 'XDG_CONFIG_HOME=/work/config', 'XDG_CACHE_HOME=/work/cache',
          'XDG_DATA_HOME=/work/data', 'XDG_STATE_HOME=/work/state',
          'OPENCODE_DISABLE_MODELS_FETCH=1', 'OPENCODE_DISABLE_AUTOUPDATE=1',
          'OPENCODE_DISABLE_LSP_DOWNLOAD=1', 'OPENCODE_DISABLE_CLAUDE_CODE=1',
          'OPENCODE_DISABLE_EXTERNAL_SKILLS=1'
        ] : [])]
    }
  };
  return { binding, image };
}

test('wiring-only: metadata validators enforce immutable identity, client image layout and credential-free environment', () => {
  for (const client of clients) {
    const { binding, image } = metadataFixture(client);
    const inspected = validateNativeImageMetadata(binding, image);
    assert.equal(inspected.id, binding.imageId);
    assert.ok(Object.isFrozen(inspected));
    for (const mutation of [
      value => { value.Id = `sha256:${'b'.repeat(64)}`; },
      value => { value.Config.Labels = { [NATIVE_CANDIDATE_PROFILES[client].imageOwnerLabel]: randomUUID() }; }
    ]) {
      const changed = structuredClone(image); mutation(changed);
      assert.throws(() => validateNativeImageMetadata(binding, changed), code('OWNERSHIP_MISMATCH'));
    }
    for (const mutation of [
      value => { value.Config.User = '0:0'; },
      value => { value.Config.WorkingDir = '/external'; },
      value => { value.Config.Entrypoint = ['arbitrary']; },
      value => { value.Os = 'windows'; },
      value => { value.Config.Volumes = { '/personal': {} }; }
    ]) {
      const changed = structuredClone(image); mutation(changed);
      assert.throws(() => validateNativeImageMetadata(binding, changed), code('RUNTIME_DRIFT'));
    }
    const changed = structuredClone(image);
    changed.Config.Env.push('PERSONAL_TOKEN=not-a-secret');
    assert.throws(() => validateNativeImageMetadata(binding, changed), code('CONFIG_MISMATCH'));
  }
});

test('wiring-only: native staging rejects executable overlays and credential/private-grading paths', () => {
  const seed = createCandidateSeed(randomUUID(), 'opencode');
  let filename;
  try {
    for (const relative of [
      'runtime\\public.mjs', 'inputs\\auth.json', 'inputs\\.env', 'inputs\\.claude.json',
      'inputs\\expected\\answer.txt', 'inputs\\private\\canary.txt', 'settings\\credentials.json'
    ]) {
      filename = path.join(seed.directory, relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, 'public rejection sentinel', { flag: 'wx' });
      assert.throws(() => assertNativeCandidateSeed(seed, Date.now() + 10000), code('NATIVE_SEED_INVALID'));
      fs.unlinkSync(filename);
      const parent = path.dirname(filename);
      if (!['inputs', 'settings', 'runtime'].includes(path.basename(parent))) fs.rmdirSync(parent);
      filename = undefined;
    }
    fs.writeFileSync(path.join(seed.directory, 'inputs', 'selected-public-context.txt'), 'public task bytes');
    assert.equal(assertNativeCandidateSeed(seed, Date.now() + 10000).fileCount, 1);
  } finally {
    if (filename && fs.existsSync(filename)) fs.unlinkSync(filename);
    destroyCandidateSeed(seed, Date.now() + 10000);
  }
});

function runtimeFixture(client) {
  const { binding } = metadataFixture(client);
  const profile = NATIVE_CANDIDATE_PROFILES[client];
  const [uid, gid] = profile.user.split(':').map(Number);
  const runtime = {
    client, clientVersion: CLIENT_VERSIONS[client], packageVersion: CLIENT_VERSIONS[client],
    versionText: client === 'claude-code' ? `${CLIENT_VERSIONS[client]} (Claude Code)`
      : client === 'opencode' ? CLIENT_VERSIONS[client] : `GitHub Copilot CLI ${CLIENT_VERSIONS[client]}.test`,
    nodeVersion: OFFLINE_NODE_VERSION, uid, gid, executable: profile.executable,
    resolvedExecutable: `${profile.executableRoot}public-binary`, executableHash: 'a'.repeat(64),
    cwd: profile.workdir, directories: profile.directories.map(value => ({ path: value, uid, gid, writable: true })),
    immutableDirectories: profile.immutableDirectories,
    commands: ['--version', '--help'].map(flag => ({
      argv: [...(client === 'copilot' ? ['--no-auto-update'] : []), flag],
      exitCode: 0, signal: null, stdoutBytes: 100, stderrBytes: 0,
      stdoutHash: 'b'.repeat(64), stderrHash: 'c'.repeat(64)
    }))
  };
  return { binding, runtime };
}

test('wiring-only: runtime parser rejects planned-only versions, UID/layout mismatch and any non-help/version dispatch', () => {
  for (const client of clients) {
    const { binding, runtime } = runtimeFixture(client);
    validateNativeRuntimeObservation(binding, runtime);
    for (const mutation of [
      value => { value.clientVersion = 'unobserved'; },
      value => { value.versionText = 'requested-pin-not-observed'; },
      value => { value.packageVersion = 'wrong'; },
      value => { value.uid = 0; },
      value => { value.gid = 0; },
      value => { value.executable = '/candidate-runtime/substitute'; },
      value => { value.resolvedExecutable = '/scratch/substitute'; },
      value => { value.executableHash = null; },
      value => { value.cwd = '/other'; },
      value => { value.directories.pop(); },
      value => { value.commands[1].argv = ['auth', 'status']; },
      value => { value.commands[0].exitCode = 1; },
      value => { value.commands[1].stdoutBytes = 131073; }
    ]) {
      const changed = structuredClone(runtime); mutation(changed);
      assert.throws(() => validateNativeRuntimeObservation(binding, changed), code('RUNTIME_DRIFT'));
    }
  }
});

test('wiring-only: pinned empty Copilot version suffix and stderr native help are preserved without inventing usage', () => {
  const { binding, runtime } = runtimeFixture('copilot');
  runtime.versionText = 'GitHub Copilot CLI 1.0.92.';
  runtime.commands[1].stdoutBytes = 0;
  runtime.commands[1].stderrBytes = 100;
  assert.equal(validateNativeRuntimeObservation(binding, runtime).versionText, runtime.versionText);
  const changed = structuredClone(runtime);
  changed.versionText = 'GitHub Copilot CLI 1.0.920.';
  assert.throws(() => validateNativeRuntimeObservation(binding, changed), code('RUNTIME_DRIFT'));
});

test('wiring-only: native confinement requires measured UID, process bounds and immutable controller entrypoint', () => {
  const id = 'a'.repeat(64), network = 'b'.repeat(64), owner = randomUUID(), candidateId = randomUUID();
  const expected = {
    id, name: `skill-egress-${owner}-native-${candidateId}`, owner, candidateId,
    role: 'native-candidate', issuer: 'public-exact-dns-tls-443',
    imageId: `sha256:${'c'.repeat(64)}`, user: '1000:1000', memoryBytes: 805306368, pidsLimit: 64,
    networkIds: [network], env: ['HOME=/work/home'], mounts: [],
    tmpfs: { '/work': 'rw,noexec,nosuid,nodev,size=256m,mode=700,uid=1000,gid=1000' },
    nativeLayout: { workdir: '/opt/fixture', entrypoint: ['/usr/local/bin/node'],
      command: ['/boundary/candidate-probe.mjs', '--idle'] }
  };
  const container = {
    Id: id, Name: `/${expected.name}`, Image: expected.imageId, State: { Running: true },
    Config: {
      User: expected.user, Env: expected.env, WorkingDir: expected.nativeLayout.workdir,
      Entrypoint: expected.nativeLayout.entrypoint, Cmd: expected.nativeLayout.command,
      Labels: { [OWNER_LABEL]: owner, [ROLE_LABEL]: expected.role, [ISSUER_LABEL]: expected.issuer,
        [CANDIDATE_LABEL]: candidateId }
    },
    NetworkSettings: { Networks: { inside: { NetworkID: network } } }, Mounts: [],
    HostConfig: {
      ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: null,
      SecurityOpt: ['no-new-privileges=true'], Memory: expected.memoryBytes, MemorySwap: expected.memoryBytes,
      PidsLimit: 64, NanoCpus: 1000000000, LogConfig: { Type: 'none' }, IpcMode: 'none', PidMode: '', UTSMode: '',
      RestartPolicy: { Name: 'no' }, Dns: ['127.0.0.1'], Tmpfs: expected.tmpfs, Mounts: [],
      Sysctls: { 'net.ipv6.conf.all.disable_ipv6': '1', 'net.ipv6.conf.default.disable_ipv6': '1' }
    }
  };
  assert.equal(measureConfinement(container, expected).user, '1000:1000');
  for (const mutation of [
    value => { value.Config.User = '10001:10001'; },
    value => { value.Config.WorkingDir = '/boundary'; },
    value => { value.Config.Entrypoint = ['substitute']; },
    value => { value.Config.Cmd = ['/opt/fixture/task-runtime.mjs']; },
    value => { value.HostConfig.Memory = 268435456; },
    value => { value.HostConfig.Tmpfs['/work'] = 'rw,exec,uid=1000,gid=1000'; }
  ]) {
    const changed = structuredClone(container); mutation(changed);
    assert.throws(() => measureConfinement(changed, expected), code('CONFIG_MISMATCH'));
  }
});

const imageFactories = {
  'claude-code': [prepareClaudeImage, cleanupClaudeImage],
  copilot: [prepareCopilotImage, cleanupCopilotImage],
  opencode: [prepareOpenCodeImage, cleanupOpenCodeImage]
};

for (const client of clients) test(`REAL native attachment: ${client} original image, version/help, fresh inspection and scoped cleanup`, {
  skip: process.env.EVAL_NATIVE_ATTACHMENT_DOCKER !== '1', timeout: 420000
}, async () => {
  const [prepareImage, cleanupImage] = imageFactories[client];
  const controller = new AbortController();
  let imageHandle, boundary, candidate, cleanup;
  let report;
  try {
    imageHandle = await prepareImage({ timeoutMs: 300000 });
    const image = await captureNativeImageAuthority(client, imageHandle);
    boundary = await startEgressBoundary({
      hosts: ['attachment-check.example.com'], timeoutSeconds: 180, mode: 'egress-only',
      signal: controller.signal
    });
    for (const fake of [{ ...imageHandle }, Object.freeze({ ...imageHandle }), JSON.parse(JSON.stringify(imageHandle))]) {
      await assert.rejects(prepareNativeEgressCandidate(boundary, { client, imageHandle: fake }),
        code('NATIVE_IMAGE_UNTRUSTED'));
    }
    await assert.rejects(prepareNativeEgressCandidate(boundary, {
      client: clients[(clients.indexOf(client) + 1) % clients.length], imageHandle
    }), code('NATIVE_IMAGE_UNTRUSTED'));
    const preparationOptions = { client, imageHandle };
    const preparation = prepareNativeEgressCandidate(boundary, preparationOptions);
    preparationOptions.client = clients[(clients.indexOf(client) + 1) % clients.length];
    preparationOptions.imageHandle = { ...imageHandle };
    candidate = await preparation;
    const prepared = describeEgressCandidate(candidate);
    assert.equal(prepared.client, client);
    assert.equal(prepared.image, image.imageId);
    assert.equal(prepared.nativeRuntimeVerified, false);
    assert.equal(prepared.nativeRuntime, null);
    assert.equal(prepared.mounts.runtime, '/candidate-runtime');
    assert.equal(prepared.imagePreparation.id, image.imageId);
    await assert.rejects(assertNativeEgressCandidate(candidate, { boundary, client, imageHandle }),
      code('CANDIDATE_STATE'));
    assert.throws(() => describeEgressCandidate({ ...candidate }), code('INVALID_HANDLE'));
    await attachEgressCandidate(candidate);
    const bound = await assertNativeEgressCandidate(candidate, { boundary, client, imageHandle });
    assert.equal(bound.nativeRuntimeVerified, true);
    await assert.rejects(assertNativeEgressCandidate(candidate, { boundary, client, imageHandle: { ...imageHandle } }),
      code('OWNERSHIP_MISMATCH'));
    await assert.rejects(assertNativeEgressCandidate({ ...candidate }, { boundary, client, imageHandle }),
      code('INVALID_HANDLE'));
    const inspected = await inspectNativeEgressCandidate(candidate);
    assert.equal(inspected.nativeRuntimeVerified, true);
    assert.equal(inspected.networkAttachmentVerified, true);
    assert.equal(inspected.nativeRuntime.clientVersion, CLIENT_VERSIONS[client]);
    assert.equal(inspected.nativeRuntime.nodeVersion, OFFLINE_NODE_VERSION);
    assert.equal(inspected.nativeRuntime.image.id, image.imageId);
    assert.equal(inspected.nativeRuntime.executable, NATIVE_CANDIDATE_PROFILES[client].executable);
    assert.equal(inspected.user, NATIVE_CANDIDATE_PROFILES[client].user);
    assert.equal(inspected.observed.container.user, inspected.user);
    assert.equal(inspected.observed.container.imageId, image.imageId);
    assert.equal(inspected.observed.runtime.defaultRoutes, 0);
    assert.deepEqual(inspected.observed.runtime.nameservers, ['127.0.0.1']);
    assert.ok(inspected.nativeRuntime.commands.every(item => item.exitCode === 0));
    assert.equal(inspected.observed.negativeProbesMeasuredAt, describeEgressBoundary(boundary).observed.measuredAt);
    assert.equal(inspected.observed.negativeProbeSubject,
      'original-measured-node-boundary-probe-not-replayed-on-native-client');
    assert.equal(inspected.observedModel, null);
    assert.equal(inspected.observedUsage, null);
    for (const field of ['publicServiceEgressVerified', 'credentialIsolationVerified', 'authenticationVerified',
      'toolIsolationVerified', 'authorizationVerified', 'liveAccepted', 'nativeLimitsVerified',
      'providerQuotaVerified', 'billingVerified']) assert.equal(inspected[field], false);
    if (client === 'opencode') controller.abort();
    cleanup = await stopEgressCandidate(candidate);
    assert.equal(cleanup.cleanupVerified, true);
    assert.equal(cleanup.exactContainersAbsent, true);
    assert.equal(cleanup.exactNetworksAbsent, true);
    assert.equal(cleanup.directoryRemoved, true);
    assert.equal(cleanup.helperProcessesClosed, 3);
    assert.deepEqual(cleanup.candidateSeedsRemoved, [candidate.id]);
    assert.equal(describeEgressCandidate(candidate).nativeRuntimeVerified, false);
    await assert.rejects(assertNativeEgressCandidate(candidate, { boundary, client, imageHandle }),
      code('CANDIDATE_STATE'));
    report = { client, classification: 'credential-free-native-version-help-attachment-only',
      prepared, observed: inspected, cleanup };
  } catch (error) {
    console.error(JSON.stringify({ client, classification: 'native-attachment-check-failed',
      code: error.code ?? null, phase: error.phase ?? null,
      nativeRuntimePhase: error.nativeRuntimePhase ?? null,
      cleanupVerified: error.cleanupVerified ?? null }));
    throw error;
  } finally {
    if (candidate) cleanup = await stopEgressCandidate(candidate);
    else if (boundary) cleanup = await stopEgressBoundary(boundary);
    if (imageHandle) {
      const imageCleanup = await cleanupImage(imageHandle);
      await assert.rejects(captureNativeImageAuthority(client, imageHandle), code('NATIVE_IMAGE_UNTRUSTED'));
      if (report) report.imageCleanup = imageCleanup ?? { releasedByOwningHelper: true };
    }
  }
  nativeReports.push(report);
  const evidenceFile = path.join(boundaryRoot, 'native-attachment-evidence.json');
  // Retain other clients' historical observations, never reuse them as test/admission inputs.
  const history = fs.existsSync(evidenceFile) ? JSON.parse(fs.readFileSync(evidenceFile, 'utf8')).results : [];
  const results = [...history.filter(item => !nativeReports.some(current => current.client === item.client)),
    ...nativeReports];
  fs.writeFileSync(evidenceFile, `${JSON.stringify({
    classification: 'credential-free-native-attachment-not-authenticated-live-acceptance',
    measuredClients: results.map(item => item.client), results
  }, null, 2)}\n`, { mode: 0o600 });
});
