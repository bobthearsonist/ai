import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import zlib, { gzipSync, gunzipSync, zstdCompressSync, constants as zlibConstants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  prepareNativeImage, describeNativeImage, cleanupNativeImage
} from '../harness/clients/claude-code/image.mjs';
import {
  buildNativeImage as prepareCopilotImage, cleanupNativeImage as cleanupCopilotImage
} from '../harness/clients/copilot/index.mjs';
import { NATIVE_CANDIDATE_PROFILES } from '../harness/live-boundary/native-image.mjs';
import {
  observeNativeImageManifest, describeNativeImageManifestObservation,
  assertNativeImageManifestObservation, releaseNativeImageManifestObservation,
  NativeImageManifestError, NATIVE_IMAGE_MANIFEST_LIMITS
} from '../harness/live-boundary/native-image-manifest.mjs';

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const OCI_TAR = 'application/vnd.oci.image.layer.v1.tar';
const OCI_GZIP = `${OCI_TAR}+gzip`;
const OCI_ZSTD = `${OCI_TAR}+zstd`;
const DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const DOCKER_CONFIG = 'application/vnd.docker.container.image.v1+json';
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const code = expected => error => error instanceof NativeImageManifestError && error.code === expected;
const json = value => Buffer.from(JSON.stringify(value));
const zeroes = length => Buffer.alloc(length);
const blobName = bytes => `blobs/sha256/${hash(bytes).slice(7)}`;

function tarHeader(name, size, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'ascii');
  header.write('0000600\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

function tar(entries, trailer = zeroes(1024)) {
  return Buffer.concat([...entries.flatMap(({ name, bytes = zeroes(0), type = '0' }) => [
    tarHeader(name, bytes.length, type), bytes, zeroes((512 - bytes.length % 512) % 512)
  ]), trailer]);
}

function imageFixture(client, owner) {
  const profile = NATIVE_CANDIDATE_PROFILES[client];
  const rawLayers = [
    tar([{ name: 'usr/share/public-base.txt', bytes: Buffer.from('Unit orchestration double: public base\n') }]),
    tar([{ name: 'opt/client/public-install.txt', bytes: Buffer.from(`Unit orchestration double: ${client}\n`) }])
  ];
  const config = {
    created: '2026-10-09T13:07:33Z', architecture: 'amd64', os: 'linux',
    config: {
      User: profile.imageUser, WorkingDir: profile.imageWorkdir, Entrypoint: [...profile.imageEntrypoint],
      Cmd: null, Labels: { [profile.imageOwnerLabel]: owner },
      Env: ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'NODE_VERSION=22.22.1', 'YARN_VERSION=1.22.22']
    },
    rootfs: { type: 'layers', diff_ids: rawLayers.map(hash) },
    history: [{ created_by: 'unit-base' }, { created_by: 'unit-install' }]
  };
  const configBytes = json(config), imageId = hash(configBytes);
  return {
    client, owner, imageId, configDigest: imageId, config, configBytes, rawLayers,
    metadata: {
      Id: imageId, Os: 'linux', Architecture: 'amd64', Config: structuredClone(config.config),
      RootFS: { Type: 'layers', Layers: [...config.rootfs.diff_ids] },
      GraphDriver: { Name: 'overlay2', Data: {} },
      RepoDigests: [`unit-only-repository@${imageId}`]
    }
  };
}

function ociArchive(record, mutate = () => {}, { dockerV2 = false } = {}) {
  const fixture = {
    configBytes: record.configBytes,
    layers: [record.rawLayers[0], gzipSync(record.rawLayers[1])],
    mediaTypes: dockerV2
      ? ['application/vnd.docker.image.rootfs.diff.tar', 'application/vnd.docker.image.rootfs.diff.tar.gzip']
      : [OCI_TAR, OCI_GZIP],
    extraEntries: [], indexMutate: () => {}, manifestMutate: () => {},
    manifestEncode: json, archiveMutate: entries => entries
  };
  mutate(fixture);
  const manifest = {
    schemaVersion: 2, mediaType: dockerV2 ? DOCKER_MANIFEST : OCI_MANIFEST,
    config: { mediaType: dockerV2 ? DOCKER_CONFIG : OCI_CONFIG,
      digest: hash(fixture.configBytes), size: fixture.configBytes.length },
    layers: fixture.layers.map((bytes, index) => ({
      mediaType: fixture.mediaTypes[index], digest: hash(bytes), size: bytes.length
    }))
  };
  fixture.manifestMutate(manifest);
  const manifestBytes = fixture.manifestEncode(manifest);
  const index = { schemaVersion: 2, mediaType: OCI_INDEX, manifests: [{
    mediaType: manifest.mediaType, digest: hash(manifestBytes), size: manifestBytes.length,
    platform: { architecture: 'amd64', os: 'linux' }
  }] };
  fixture.indexMutate(index);
  let entries = [
    { name: 'blobs/', type: '5' }, { name: 'blobs/sha256/', type: '5' },
    { name: 'oci-layout', bytes: json({ imageLayoutVersion: '1.0.0' }) },
    { name: 'index.json', bytes: json(index) },
    { name: 'manifest.json', bytes: json([{
      Config: blobName(fixture.configBytes), RepoTags: ['synthetic:unit-only'],
      Layers: fixture.layers.map(blobName)
    }]) },
    { name: blobName(manifestBytes), bytes: manifestBytes },
    { name: blobName(fixture.configBytes), bytes: fixture.configBytes },
    ...fixture.layers.map(bytes => ({ name: blobName(bytes), bytes })),
    ...fixture.extraEntries
  ];
  entries = fixture.archiveMutate(entries);
  return { bytes: tar(entries), manifest, manifestBytes, manifestDigest: hash(manifestBytes), index, entries };
}

function legacyArchive(record) {
  const directories = record.rawLayers.map(bytes => hash(bytes).slice(7));
  return tar([
    { name: `${record.imageId.slice(7)}.json`, bytes: record.configBytes },
    { name: 'manifest.json', bytes: json([{
      Config: `${record.imageId.slice(7)}.json`, RepoTags: ['synthetic:unit-only'],
      Layers: directories.map(directory => `${directory}/layer.tar`)
    }]) },
    { name: 'repositories', bytes: json({ synthetic: { 'unit-only': directories.at(-1) } }) },
    ...directories.flatMap((directory, index) => [
      { name: `${directory}/`, type: '5' }, { name: `${directory}/VERSION`, bytes: Buffer.from('1.0') },
      { name: `${directory}/json`, bytes: json({ id: directory }) },
      { name: `${directory}/layer.tar`, bytes: record.rawLayers[index] }
    ])
  ]);
}

// These doubles replace Docker process orchestration, not native/model execution or admission.
function processDouble(backend, command, argv, options) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.closed = false;
  child.kill = signal => {
    backend.kills.push({ command, argv, signal });
    if (!backend.ignoreKill) queueMicrotask(() => close(null, signal));
    return true;
  };
  const close = (exitCode = 0, signal = null) => {
    if (child.closed) return;
    child.closed = true;
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode, signal);
  };
  backend.children.push(child);
  backend.calls.push({ command, argv: [...argv], options });
  const args = argv.slice(argv.findIndex(value => ['version', 'build', 'image'].includes(value)));
  const output = (stdout, stderr = '', exitCode = 0) => {
    if (child.closed) return;
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    close(exitCode);
  };
  setImmediate(() => {
    try {
      if (args[0] === 'version') { output('29.7.2\n'); return; }
      if (args[0] === 'build') {
        const label = args[args.indexOf('--label') + 1];
        const [labelName, owner] = label.split('=');
        const client = labelName === 'ai.skill-eval.claude-owner' ? 'claude-code' : 'copilot';
        const tag = args[args.indexOf(client === 'claude-code' ? '--tag' : '-t') + 1];
        const record = imageFixture(client, owner);
        if (backend.imageIdKind === 'manifest') {
          const exported = ociArchive(record, backend.nativeArchiveMutate, { dockerV2: backend.dockerV2 === true });
          record.imageId = exported.manifestDigest;
          record.metadata.Id = record.imageId;
          record.metadata.Descriptor = {
            mediaType: exported.manifest.mediaType, digest: record.imageId, size: exported.manifestBytes.length
          };
          delete record.metadata.GraphDriver;
        } else if (backend.imageIdKind === 'config-descriptor') {
          record.metadata.Descriptor = { mediaType: OCI_CONFIG, digest: record.imageId, size: record.configBytes.length };
          delete record.metadata.GraphDriver;
        }
        backend.records.set(record.imageId, record);
        backend.tags.set(tag, record.imageId);
        output(`${record.imageId}\n`);
        return;
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        const ref = args[2], imageId = backend.tags.get(ref) ?? ref, record = backend.records.get(imageId);
        if (!record) { output('', `Error response from daemon: No such image: ${ref}`, 1); return; }
        const metadata = structuredClone(record.metadata);
        if (ref === imageId) {
          backend.immutableInspections++;
          backend.mutateInspection?.(metadata, backend.immutableInspections);
        }
        output(json([metadata]));
        return;
      }
      if (args[0] === 'image' && args[1] === 'save') {
        const record = backend.records.get(args[2]);
        assert.ok(record, 'The orchestration double accepts only its constructed immutable image');
        backend.saveStarted?.(record, child, close);
        if (backend.hangSave) return;
        const bytes = backend.archive(record);
        backend.lastArchive = bytes;
        if (backend.saveStderr) child.stderr.write(backend.saveStderr);
        if (!child.closed) {
          for (let offset = 0; offset < bytes.length && !child.closed; offset += 4096) {
            child.stdout.write(bytes.subarray(offset, offset + 4096));
          }
        }
        backend.saveFinished?.(record, options);
        close();
        return;
      }
      if (args[0] === 'image' && args[1] === 'rm') {
        const ref = args[2], imageId = backend.tags.get(ref) ?? ref;
        backend.records.delete(imageId);
        for (const [tag, value] of backend.tags) if (value === imageId) backend.tags.delete(tag);
        output('unit-only image removed\n');
        return;
      }
      throw new Error(`Unexpected orchestration-double command ${args.join(' ')}`);
    } catch (error) {
      backend.errors.push(error);
      output('', 'Unit-only Docker process orchestration failed', 1);
    }
  });
  return child;
}

async function withDouble(t, callback) {
  const backend = {
    records: new Map(), tags: new Map(), calls: [], kills: [], children: [], errors: [],
    immutableInspections: 0
  };
  backend.archive = record => ociArchive(record, backend.nativeArchiveMutate, { dockerV2: backend.dockerV2 === true }).bytes;
  const originalSpawn = childProcess.spawn;
  const replacement = t.mock.method(childProcess, 'spawn', (...args) => processDouble(backend, ...args));
  syncBuiltinESMExports();
  const images = [], observations = [];
  const context = {
    backend,
    async image(client = 'claude-code') {
      const handle = await (client === 'claude-code' ? prepareNativeImage : prepareCopilotImage)({ timeoutMs: 10000 });
      images.push({ client, handle });
      return handle;
    },
    async observe(imageHandle, options = {}) {
      const handle = await observeNativeImageManifest({ client: 'claude-code', imageHandle, ...options });
      observations.push(handle);
      return handle;
    }
  };
  try {
    await callback(context);
    assert.deepEqual(backend.errors, []);
  } finally {
    for (const handle of observations) await releaseNativeImageManifestObservation(handle);
    backend.ignoreKill = false;
    for (const child of backend.children) if (!child.closed) child.kill('SIGKILL');
    await new Promise(resolve => setImmediate(resolve));
    const exactWorkspaces = new Set(backend.calls.filter(call =>
      call.options.cwd && /^manifest-[a-f0-9-]{36}$/.test(path.basename(call.options.cwd)))
      .map(call => call.options.cwd));
    for (const directory of exactWorkspaces) if (fs.existsSync(directory)) recoverExactDoubleWorkspace(directory);
    for (const { client, handle } of images.reverse()) {
      await (client === 'claude-code' ? cleanupNativeImage : cleanupCopilotImage)(handle);
    }
    replacement.mock.restore();
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
}

async function cleanedRejection(promise, expected) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, expected);
    assert.equal(error.cleanupVerified, true);
    assert.equal(error.cleanup.workspaceRemoved, true);
    assert.equal(error.cleanup.helperProcessesClosed, true);
    assert.equal(fs.existsSync(path.join(
      fileURLToPath(new URL('../harness/live-boundary/.owned/', import.meta.url)),
      `manifest-${error.cleanup.exportId}`)), false);
    return error instanceof NativeImageManifestError;
  });
}

function recoverExactDoubleWorkspace(directory) {
  const marker = JSON.parse(fs.readFileSync(path.join(directory, '.manifest-owner.json'), 'utf8'));
  assert.equal(path.basename(directory), `manifest-${marker.id}`);
  assert.equal(marker.purpose, 'native-image-manifest');
  assert.deepEqual(fs.readdirSync(directory).sort(),
    ['.manifest-owner.json', 'appdata', 'archive.tar', 'docker-config', 'home', 'scratch']);
  for (const name of ['appdata', 'home', 'scratch']) {
    assert.deepEqual(fs.readdirSync(path.join(directory, name)), []);
    fs.rmdirSync(path.join(directory, name));
  }
  fs.unlinkSync(path.join(directory, 'archive.tar'));
  fs.unlinkSync(path.join(directory, 'docker-config', 'config.json'));
  fs.rmdirSync(path.join(directory, 'docker-config'));
  fs.unlinkSync(path.join(directory, '.manifest-owner.json'));
  fs.rmdirSync(directory);
}

test('orchestration-double only: strict options cannot import identities, callbacks, credentials or profile overrides', async t => {
  await withDouble(t, async ({ backend }) => {
    const base = { client: 'claude-code', imageHandle: Object.freeze({}) };
    for (const changed of [
      { client: 'unknown' }, { imageHandle: 'synthetic:unit-only' }, { imageHandle: null },
      { imageHandle: new Proxy({}, {}) }, { timeoutMs: 999 }, { timeoutMs: 300001 },
      { maxOutputBytes: 0 }, { maxOutputBytes: 262145 }, { maxArchiveBytes: 1023 },
      { maxArchiveBytes: 2147483649 }, { maxUncompressedLayerBytes: 1023 },
      { maxUncompressedLayerBytes: 4294967297 }, { signal: {} }, { registryManifestVerified: true },
      { imageId: `sha256:${'a'.repeat(64)}` }, { manifestDigest: `sha256:${'a'.repeat(64)}` },
      { archivePath: 'caller.tar' }, { env: {} }, { authRoot: 'personal-home' },
      { runProcess: () => true }, { observe: () => true }
    ]) await assert.rejects(observeNativeImageManifest({ ...base, ...changed }), code('INVALID_ARGUMENT'));
    for (const value of [
      new Proxy(base, {}), { ...base, [Symbol('proof')]: true },
      Object.defineProperty({ imageHandle: {} }, 'client', { get() { throw new Error('never read'); } })
    ]) await assert.rejects(observeNativeImageManifest(value), code('INVALID_ARGUMENT'));
    await assert.rejects(observeNativeImageManifest(base, {}), code('INVALID_ARGUMENT'));
    assert.equal(backend.calls.length, 0);
  });
});

test('orchestration-double only: original image handles are required; clones, receipts and cross-client handles never bind', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const original = await image(), copilot = await image('copilot');
    for (const fake of [{ ...original }, structuredClone(original), JSON.parse(JSON.stringify(original)),
      { ...describeNativeImage(original) }, { client: 'claude-code', image: original.image }]) {
      await assert.rejects(observe(fake), code('NATIVE_IMAGE_UNTRUSTED'));
    }
    await assert.rejects(observe(copilot), code('NATIVE_IMAGE_UNTRUSTED'));
    await assert.rejects(observe(original, { client: 'copilot' }), code('NATIVE_IMAGE_UNTRUSTED'));
    assert.equal(backend.calls.some(call => call.argv.includes('save')), false);
    const observer = await observeNativeImageManifest({ client: 'copilot', imageHandle: copilot });
    try {
      const description = await assertNativeImageManifestObservation(observer, { client: 'copilot', imageHandle: copilot });
      assert.equal(description.imageInspection.imageUser, '10001:10001');
      assert.equal(description.originalImageAuthority.issuer, 'copilot.buildNativeImage');
      await assert.rejects(assertNativeImageManifestObservation(observer,
        { client: 'claude-code', imageHandle: original }), code('OWNERSHIP_MISMATCH'));
    } finally { await releaseNativeImageManifestObservation(observer); }
  });
});

test('orchestration-double only: native OCI export preserves manifest bytes but never proves a registry manifest', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const imageHandle = await image(), observation = await observe(imageHandle);
    const result = describeNativeImageManifestObservation(observation);
    const record = backend.records.get(imageHandle.image), expected = ociArchive(record);
    assert.equal(result.provenance, 'local-oci-layout-exported-by-docker-image-save');
    assert.equal(result.classification, 'local-image-manifest-observation/not-registry-proof');
    assert.equal(result.registryManifestVerified, false);
    assert.equal(result.authenticationVerified, false);
    assert.equal(result.liveAccepted, false);
    assert.equal(result.dockerImageIdType, 'docker-image-config-id');
    assert.equal(result.manifestDigestType, 'local-oci-image-manifest-digest');
    assert.equal(result.configDigest, imageHandle.image);
    assert.equal(result.dockerImageId, imageHandle.image);
    assert.equal(result.manifestDigest, expected.manifestDigest);
    assert.equal(result.sourceManifestDigest, expected.manifestDigest);
    assert.notEqual(result.manifestDigest, result.dockerImageId);
    assert.equal(hash(Buffer.from(result.manifestJSON)), result.manifestDigest);
    assert.deepEqual(JSON.parse(result.manifestJSON), result.manifest);
    assert.equal(result.archive.digest, hash(backend.lastArchive));
    assert.equal(result.layers[0].digest, result.layers[0].diffId);
    assert.notEqual(result.layers[1].digest, result.layers[1].diffId);
    assert.ok(Object.isFrozen(result.manifest.layers));
    assert.equal(result.originalImageAuthority.owner, imageHandle.preparationId);
    assert.equal(result.originalImageAuthority.issuer, 'claude-code.prepareNativeImage');
    assert.equal(result.cleanup.cleanupVerified, true);
    assert.equal(result.cleanup.containersCreated, 0);
    assert.equal(result.cleanup.nativeImageRemoved, false);
    assert.equal(result.imageInspection.imageUser, 'node');
    assert.equal((await assertNativeImageManifestObservation(observation, {
      client: 'claude-code', imageHandle
    })).manifestDigest, result.manifestDigest);
  });
});

test('orchestration-double only: legacy Docker save derives a distinct local OCI manifest through the owning Docker process', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.archive = legacyArchive;
    const imageHandle = await image(), observation = await observe(imageHandle);
    const result = describeNativeImageManifestObservation(observation);
    assert.equal(result.archive.format, 'docker-save-v1');
    assert.equal(result.provenance, 'local-oci-manifest-derived-from-docker-save-layer-tars');
    assert.equal(result.sourceManifestDigest, null);
    assert.equal(result.registryManifestVerified, false);
    assert.equal(result.manifest.config.digest, result.dockerImageId);
    assert.notEqual(result.manifestDigest, result.dockerImageId);
    assert.ok(result.layers.every(layer => layer.digest === layer.diffId && layer.mediaType === OCI_TAR));
    const save = backend.calls.find(call => call.argv.includes('save'));
    assert.deepEqual(save.argv.slice(2), ['image', 'save', imageHandle.image]);
    assert.equal(path.isAbsolute(save.command), true);
    assert.equal(save.options.shell, false);
    assert.deepEqual(save.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(save.options.env.HOME, path.join(save.options.cwd, 'home'));
    assert.equal(save.options.env.USERPROFILE, save.options.env.HOME);
    assert.equal(save.options.env.DOCKER_CONFIG, path.join(save.options.cwd, 'docker-config'));
    for (const key of ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'HTTPS_PROXY',
      'HTTP_PROXY', 'ALL_PROXY', 'NODE_OPTIONS', 'DOCKER_CONTEXT', 'DOCKER_AUTH_CONFIG']) {
      assert.equal(Object.hasOwn(save.options.env, key), false);
    }
    assert.equal(fs.existsSync(save.options.cwd), false);
    assert.equal(backend.calls.some(call => call.argv.some(arg => ['run', 'create', 'prune', 'login'].includes(arg))), false);
  });
});

test('orchestration-double only: Docker v2 manifest conversion does not equate source and derived OCI digests', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.archive = record => ociArchive(record, undefined, { dockerV2: true }).bytes;
    const observation = await observe(await image());
    const result = describeNativeImageManifestObservation(observation);
    assert.equal(result.provenance, 'local-oci-manifest-derived-from-docker-save-docker-v2-manifest');
    assert.equal(result.sourceManifestMediaType, DOCKER_MANIFEST);
    assert.equal(result.manifestMediaType, OCI_MANIFEST);
    assert.notEqual(result.sourceManifestDigest, result.manifestDigest);
    assert.notEqual(result.configDigest, result.manifestDigest);
    assert.equal(result.registryManifestVerified, false);
  });
});

test('orchestration-double only: OCI layout index mediaType may be omitted without fabricating registry provenance', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.archive = record => ociArchive(record, fixture => {
      fixture.indexMutate = index => { delete index.mediaType; };
    }).bytes;
    assert.equal(describeNativeImageManifestObservation(await observe(await image())).registryManifestVerified, false);
  });
});

test('orchestration-double only: original observation identity and exact original image binding survive neither clone nor substitution', async t => {
  await withDouble(t, async ({ image, observe }) => {
    const original = await image(), other = await image(), observation = await observe(original);
    for (const fake of [{ ...observation }, structuredClone(observation), JSON.parse(JSON.stringify(observation)),
      describeNativeImageManifestObservation(observation), new Proxy(observation, {})]) {
      assert.throws(() => describeNativeImageManifestObservation(fake), code('INVALID_HANDLE'));
      await assert.rejects(assertNativeImageManifestObservation(fake,
        { client: 'claude-code', imageHandle: original }), code('INVALID_HANDLE'));
      await assert.rejects(releaseNativeImageManifestObservation(fake), code('INVALID_HANDLE'));
    }
    for (const imageHandle of [{ ...original }, other]) await assert.rejects(
      assertNativeImageManifestObservation(observation, { client: 'claude-code', imageHandle }),
      code('OWNERSHIP_MISMATCH'));
    await assert.rejects(assertNativeImageManifestObservation(observation,
      { client: 'claude-code', imageHandle: original, registryManifestVerified: true }), code('INVALID_ARGUMENT'));
    const cleanup = await releaseNativeImageManifestObservation(observation);
    assert.deepEqual(await releaseNativeImageManifestObservation(observation), cleanup);
    assert.equal(cleanup.nativeImageRemoved, false);
    assert.equal(describeNativeImage(original).image, original.image);
    assert.equal(describeNativeImageManifestObservation(observation).originalImageHandleRetained, false);
    assert.equal(describeNativeImageManifestObservation(observation).status, 'released');
    await assert.rejects(assertNativeImageManifestObservation(observation,
      { client: 'claude-code', imageHandle: original }), code('OBSERVATION_RELEASED'));
  });
});

test('orchestration-double only: config bytes must match the fresh immutable Docker CONFIG ID, not a manifest ID', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.archive = record => ociArchive(record, fixture => {
      const config = JSON.parse(fixture.configBytes);
      config.created = 'changed-config-bytes';
      fixture.configBytes = json(config);
    }).bytes;
    await cleanedRejection(observe(await image()), 'CONFIG_DIGEST_MISMATCH');
  });
});

test('orchestration-double only: typed-ID native manifest target binds raw descriptor bytes, not a fabricated config ID', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    const original = await image();
    const observer = await observe(original), result = await assertNativeImageManifestObservation(observer, {
      client: 'claude-code', imageHandle: original
    });
    const record = backend.records.get(original.image);
    assert.equal(result.imageId, original.image);
    assert.equal(result.imageIdType, 'docker-image-manifest-id');
    assert.equal(result.dockerImageIdType, result.imageIdType);
    assert.equal(result.dockerImageIdProvenance, 'fresh-docker-image-inspect-descriptor');
    assert.equal(result.configDigest, record.configDigest);
    assert.notEqual(result.configDigest, result.imageId);
    assert.equal(result.sourceManifestDigest, result.imageId);
    assert.equal(result.manifestDigest, result.imageId);
    assert.deepEqual(result.dockerDescriptor, record.metadata.Descriptor);
    assert.deepEqual(result.dockerRootFSDiffIds, record.metadata.RootFS.Layers);
    assert.equal(result.configMediaType, OCI_CONFIG);
    assert.equal(result.configSizeBytes, record.configBytes.length);
    assert.equal(result.configFactsVerified, true);
    assert.equal(result.imageIdentityVerified, true);
    assert.equal(result.manifestTargetVerified, true);
    assert.equal(result.layerBlobDigestsVerified, true);
    assert.equal(result.layerMediaVerified, true);
    assert.equal(result.layerDiffIdsVerified, true);
    assert.equal(result.registryManifestVerified, false);
    assert.equal(result.authenticationVerified, false);
    assert.equal(result.liveAccepted, false);
    assert.equal(result.cleanup.cleanupVerified, true);
    assert.ok(Object.isFrozen(result.dockerDescriptor));
  });
});

test('orchestration-double only: typed-ID config descriptors and known legacy backends retain strict config equality', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    for (const kind of ['config', 'config-descriptor']) {
      backend.imageIdKind = kind;
      const original = await image(), result = describeNativeImageManifestObservation(await observe(original));
      assert.equal(result.imageIdType, 'docker-image-config-id');
      assert.equal(result.configDigest, original.image);
      assert.equal(result.manifestTargetVerified, false);
      assert.equal(result.legacyGraphDriver, kind === 'config' ? 'overlay2' : null);
      assert.equal(result.dockerDescriptor?.mediaType ?? null, kind === 'config' ? null : OCI_CONFIG);
      backend.archive = record => ociArchive(record, fixture => {
        const config = JSON.parse(fixture.configBytes);
        config.created = 'config-ID-drift';
        fixture.configBytes = json(config);
      }).bytes;
      await cleanedRejection(observe(original), 'CONFIG_DIGEST_MISMATCH');
      backend.archive = record => ociArchive(record).bytes;
    }
  });
});

test('orchestration-double only: typed-ID original capability binding freshly rechecks issuer activity after an async wait', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    const original = await image(), observation = await observe(original);
    const other = await image(), copilot = await image('copilot');
    for (const wrongObservation of [structuredClone(observation), { ...observation }]) {
      await assert.rejects(assertNativeImageManifestObservation(wrongObservation,
        { client: 'claude-code', imageHandle: original }), code('INVALID_HANDLE'));
    }
    for (const [client, imageHandle] of [
      ['claude-code', { ...original }], ['claude-code', other], ['copilot', copilot]
    ]) await assert.rejects(assertNativeImageManifestObservation(observation, { client, imageHandle }),
      code('OWNERSHIP_MISMATCH'));
    await assert.rejects(observe({ ...original }), code('NATIVE_IMAGE_UNTRUSTED'));
    await assert.rejects(observe(copilot), code('NATIVE_IMAGE_UNTRUSTED'));
    await new Promise(resolve => setImmediate(resolve));
    const active = await assertNativeImageManifestObservation(observation,
      { client: 'claude-code', imageHandle: original });
    assert.equal(active.client, 'claude-code');
    assert.equal(active.imageId, original.image);
    assert.equal(active.originalImageAuthority.owner, original.preparationId);
    await cleanupNativeImage(original);
    await assert.rejects(assertNativeImageManifestObservation(observation,
      { client: 'claude-code', imageHandle: original }), code('NATIVE_IMAGE_UNTRUSTED'));
    assert.equal(describeNativeImageManifestObservation(observation).imageId, active.imageId);

    const second = await observe(other);
    const pending = assertNativeImageManifestObservation(second, { client: 'claude-code', imageHandle: other });
    await releaseNativeImageManifestObservation(second);
    await assert.rejects(pending, code('OBSERVATION_RELEASED'));
  });
});

test('orchestration-double only: typed-ID Docker v2 targets verify the original source, never the reconstructed OCI digest', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    backend.dockerV2 = true;
    const original = await image(), result = describeNativeImageManifestObservation(await observe(original));
    assert.equal(result.dockerDescriptor.mediaType, DOCKER_MANIFEST);
    assert.equal(result.dockerDescriptor.digest, original.image);
    assert.equal(result.sourceManifestDigest, original.image);
    assert.notEqual(result.manifestDigest, original.image);
    assert.equal(result.manifestMediaType, OCI_MANIFEST);
    assert.equal(result.sourceConfigMediaType, DOCKER_CONFIG);
    assert.equal(result.configMediaType, OCI_CONFIG);
    assert.equal(result.manifestTargetVerified, true);
    assert.equal(result.registryManifestVerified, false);
  });
});

test('orchestration-double only: typed-ID exact raw target digest, media type and size cannot be replaced by semantic equality', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    const original = await image();
    for (const changed of ['digest', 'rawEncoding', 'mediaType', 'size']) {
      backend.mutateInspection = metadata => {
        if (changed === 'mediaType') metadata.Descriptor.mediaType = DOCKER_MANIFEST;
        if (changed === 'size') metadata.Descriptor.size++;
      };
      backend.archive = record => ociArchive(record, fixture => {
        if (changed === 'digest') fixture.manifestMutate = manifest => {
          manifest.annotations = { 'unit-only': 'same-config-and-layers-but-different-raw-manifest' };
        };
        if (changed === 'rawEncoding') fixture.manifestEncode = manifest => Buffer.from(JSON.stringify(manifest, null, 2));
      }).bytes;
      await cleanedRejection(observe(original), 'IMAGE_TARGET_MISMATCH');
    }
  });
});

test('orchestration-double only: typed-ID missing, unknown, conflicting or indexed typing denies before export', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    const original = await image();
    for (const [change, expected] of [
      [metadata => { delete metadata.Descriptor; }, 'IMAGE_ID_TYPE_UNVERIFIED'],
      [metadata => { delete metadata.Descriptor; metadata.GraphDriver = { Name: 'overlayfs' }; },
        'IMAGE_ID_TYPE_UNVERIFIED'],
      [metadata => { delete metadata.Descriptor.mediaType; }, 'IMAGE_ID_TYPE_UNVERIFIED'],
      [metadata => { delete metadata.Descriptor.size; }, 'IMAGE_ID_TYPE_UNVERIFIED'],
      [metadata => { metadata.Descriptor.mediaType = 'caller-claimed-config-id'; }, 'IMAGE_ID_TYPE_UNVERIFIED'],
      [metadata => { metadata.Descriptor.digest = `sha256:${'a'.repeat(64)}`; }, 'IMAGE_ID_TYPE_UNVERIFIED'],
      [metadata => { metadata.Descriptor.mediaType = OCI_INDEX; }, 'IMAGE_ID_TYPE_UNSUPPORTED']
    ]) {
      backend.mutateInspection = change;
      const count = backend.calls.filter(call => call.argv.includes('save')).length;
      await cleanedRejection(observe(original), expected);
      assert.equal(backend.calls.filter(call => call.argv.includes('save')).length, count);
    }
    backend.mutateInspection = metadata => { metadata.Descriptor.mediaType = OCI_CONFIG; };
    await cleanedRejection(observe(original), 'CONFIG_DIGEST_MISMATCH');
  });
});

test('orchestration-double only: typed-ID absent config typing is not inferred solely from config hash equality', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const original = await image();
    backend.mutateInspection = metadata => { delete metadata.GraphDriver; };
    await cleanedRejection(observe(original), 'IMAGE_ID_TYPE_UNVERIFIED');
  });
});

test('orchestration-double only: typed-ID manifest config digest, size and media descriptors verify actual config bytes', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    for (const [change, expected] of [
      [manifest => { manifest.config.digest = `sha256:${'a'.repeat(64)}`; }, 'CONFIG_DIGEST_MISMATCH'],
      [manifest => { manifest.config.size++; }, 'CONFIG_DIGEST_MISMATCH'],
      [manifest => { manifest.config.mediaType = DOCKER_CONFIG; }, 'ARCHIVE_UNSUPPORTED']
    ]) {
      backend.nativeArchiveMutate = fixture => { fixture.manifestMutate = change; };
      await cleanedRejection(observe(await image()), expected);
    }
  });
});

test('orchestration-double only: typed-ID raw config and RootFS facts cannot disagree with their fresh original image', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    for (const [change, expected] of [
      [config => { config.architecture = 'arm64'; }, 'CONFIG_FACTS_MISMATCH'],
      [config => { config.config.Labels['unit-only-unobserved-label'] = 'extra'; }, 'CONFIG_FACTS_MISMATCH'],
      [config => { config.rootfs.diff_ids.reverse(); }, 'LAYER_DIFF_ID_MISMATCH']
    ]) {
      backend.nativeArchiveMutate = fixture => {
        const config = JSON.parse(fixture.configBytes);
        change(config);
        fixture.configBytes = json(config);
      };
      await cleanedRejection(observe(await image()), expected);
    }
  });
});

test('orchestration-double only: typed-ID decoded config facts must match fresh Docker facts, not only its RootFS', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    const original = await image();
    for (const change of [
      metadata => { metadata.Config.Labels['unit-only-extra-fresh-label'] = 'not-in-exported-config'; },
      metadata => { metadata.Config.ArgsEscaped = true; }
    ]) {
      backend.mutateInspection = change;
      await cleanedRejection(observe(original), 'CONFIG_FACTS_MISMATCH');
    }
    backend.mutateInspection = metadata => { metadata.RootFS.Layers[0] = `sha256:${'a'.repeat(64)}`; };
    await cleanedRejection(observe(original), 'LAYER_DIFF_ID_MISMATCH');
  });
});

test('orchestration-double only: typed-ID fresh descriptor and config facts are rechecked after all layer validation', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    const original = await image();
    for (const [change, expected] of [
      [metadata => { metadata.Descriptor.size++; }, 'IMAGE_DRIFT'],
      [metadata => { metadata.Descriptor.mediaType = DOCKER_MANIFEST; }, 'IMAGE_DRIFT'],
      [metadata => { metadata.Config.Labels['unit-only-post-export'] = 'changed'; }, 'CONFIG_FACTS_MISMATCH']
    ]) {
      backend.immutableInspections = 0;
      backend.mutateInspection = (metadata, count) => { if (count === 2) change(metadata); };
      await cleanedRejection(observe(original), expected);
    }
  });
});

test('orchestration-double only: typed-ID targets still require actual layer blob sizes, media, ordered DiffIDs and inflation bounds', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    for (const [change, expected] of [
      [fixture => { fixture.manifestMutate = manifest => { manifest.layers[0].size++; }; }, 'LAYER_DIGEST_MISMATCH'],
      [fixture => { fixture.mediaTypes[0] = OCI_GZIP; }, 'LAYER_MEDIA_MISMATCH'],
      [fixture => { fixture.layers.reverse(); fixture.mediaTypes.reverse(); }, 'LAYER_DIFF_ID_MISMATCH'],
      [fixture => { fixture.layers[1] = Buffer.from(fixture.layers[1]);
        fixture.layers[1][fixture.layers[1].length - 1] ^= 1; }, 'LAYER_MEDIA_MISMATCH']
    ]) {
      backend.nativeArchiveMutate = change;
      await cleanedRejection(observe(await image()), expected);
    }
    backend.nativeArchiveMutate = undefined;
    await cleanedRejection(observe(await image(), { maxUncompressedLayerBytes: 3072 }), 'LAYER_LIMIT');
  });
});

test('orchestration-double only: manifest descriptor digest and byte size drift fail explicitly', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const original = await image();
    for (const change of [
      index => { index.manifests[0].digest = `sha256:${'a'.repeat(64)}`; },
      index => { index.manifests[0].size++; }
    ]) {
      backend.archive = record => ociArchive(record, fixture => { fixture.indexMutate = change; }).bytes;
      await cleanedRejection(observe(original), 'MANIFEST_DIGEST_MISMATCH');
    }
  });
});

test('orchestration-double only: actual OCI blob bytes must hash to their content-addressed filenames', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.archive = record => ociArchive(record, fixture => {
      fixture.archiveMutate = entries => {
        const layer = entries.at(-1);
        layer.bytes = Buffer.from(layer.bytes);
        layer.bytes[layer.bytes.length - 1] ^= 1;
        return entries;
      };
    }).bytes;
    await cleanedRejection(observe(await image()), 'BLOB_DIGEST_MISMATCH');
  });
});

test('orchestration-double only: layer descriptor digests and byte sizes cannot drift from actual exported blobs', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const original = await image();
    for (const change of [
      manifest => { manifest.layers[0].digest = `sha256:${'a'.repeat(64)}`; },
      manifest => { manifest.layers[1].size++; }
    ]) {
      backend.archive = record => ociArchive(record, fixture => { fixture.manifestMutate = change; }).bytes;
      await cleanedRejection(observe(original), 'LAYER_DIGEST_MISMATCH');
    }
  });
});

test('orchestration-double only: uncompressed layer DiffIDs must match config and fresh ordered Docker RootFS layers', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const original = await image();
    backend.mutateInspection = metadata => { metadata.RootFS.Layers[0] = `sha256:${'a'.repeat(64)}`; };
    await cleanedRejection(observe(original), 'LAYER_DIFF_ID_MISMATCH');
    backend.mutateInspection = null;
    backend.archive = record => ociArchive(record, fixture => {
      fixture.layers.reverse();
      fixture.mediaTypes.reverse();
    }).bytes;
    await cleanedRejection(observe(original), 'LAYER_DIFF_ID_MISMATCH');
  });
});

test('orchestration-double only: media labels must describe actual gzip or uncompressed valid tar bytes', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const original = await image();
    for (const change of [
      fixture => { fixture.mediaTypes[1] = OCI_TAR; },
      fixture => { fixture.mediaTypes[0] = OCI_GZIP; },
      fixture => { fixture.layers[0] = Buffer.from('not a tar layer'); },
      fixture => { fixture.layers[1] = Buffer.from(fixture.layers[1]);
        fixture.layers[1][fixture.layers[1].length - 1] ^= 1; }
    ]) {
      backend.archive = record => ociArchive(record, change).bytes;
      await cleanedRejection(observe(original), 'LAYER_MEDIA_MISMATCH');
    }
  });
});

test('orchestration-double only: unsupported layer compression fails rather than relabeling unknown media as tar', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.archive = record => ociArchive(record, fixture => {
      fixture.mediaTypes[0] = `${OCI_TAR}+brotli`;
    }).bytes;
    await cleanedRejection(observe(await image()), 'LAYER_MEDIA_UNSUPPORTED');
  });
});

test('orchestration-double only: media-codec OCI manifests retain actual Docker tar/gzip descriptors and exact raw target identity', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    backend.nativeArchiveMutate = fixture => {
      fixture.mediaTypes = ['application/vnd.docker.image.rootfs.diff.tar',
        'application/vnd.docker.image.rootfs.diff.tar.gzip'];
    };
    const original = await image(), result = describeNativeImageManifestObservation(await observe(original));
    assert.equal(result.manifestDigest, original.image);
    assert.equal(result.sourceManifestMediaType, OCI_MANIFEST);
    assert.equal(result.provenance, 'local-oci-layout-exported-by-docker-image-save');
    assert.deepEqual(result.sourceLayerMediaTypes, ['application/vnd.docker.image.rootfs.diff.tar',
      'application/vnd.docker.image.rootfs.diff.tar.gzip']);
    assert.deepEqual(result.layers.map(layer => layer.mediaType), result.sourceLayerMediaTypes);
    assert.equal(result.layerMediaVerified, true);
    assert.equal(result.layerDiffIdsVerified, true);
    assert.equal(result.registryManifestVerified, false);
  });
});

test('orchestration-double only: media-codec denied artifacts retain actual typed hashes and media, never original observation authority', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    const unsupported = `${OCI_TAR}+brotli`;
    backend.nativeArchiveMutate = fixture => { fixture.mediaTypes[1] = unsupported; };
    const original = await image(), record = backend.records.get(original.image);
    await assert.rejects(observe(original), error => {
      assert.equal(error.code, 'LAYER_MEDIA_UNSUPPORTED');
      assert.equal(error.layerIndex, 1);
      assert.equal(error.layerMediaType, unsupported);
      const rejected = error.rejectedArtifact;
      assert.equal(rejected.imageId, original.image);
      assert.equal(rejected.imageIdType, 'docker-image-manifest-id');
      assert.equal(rejected.manifestDigest, original.image);
      assert.equal(rejected.sourceManifestDigest, original.image);
      assert.equal(rejected.configDigest, record.configDigest);
      assert.equal(rejected.layers[1].mediaType, unsupported);
      assert.equal(rejected.layers[1].digest, hash(gzipSync(record.rawLayers[1])));
      assert.equal(rejected.layerBlobDigestsVerified, true);
      assert.equal(rejected.layerMediaVerified, false);
      assert.equal(rejected.layerDiffIdsVerified, false);
      assert.equal(rejected.originalObservationIssued, false);
      assert.equal(rejected.registryManifestVerified, false);
      assert.equal(rejected.authenticationVerified, false);
      assert.equal(rejected.liveAccepted, false);
      assert.equal(error.cleanupVerified, true);
      assert.ok(Object.isFrozen(rejected.layers));
      assert.throws(() => describeNativeImageManifestObservation(rejected), code('INVALID_HANDLE'));
      return error instanceof NativeImageManifestError;
    });
  });
});

function zstdFixture(fixture) {
  fixture.layers[1] = zstdCompressSync(gunzipSync(fixture.layers[1]), {
    params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 }
  });
  fixture.mediaTypes[1] = OCI_ZSTD;
}

test('orchestration-double only: media-codec native Zstandard verifies stored bytes, bounded tar output and fresh original DiffIDs', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    backend.nativeArchiveMutate = zstdFixture;
    const original = await image(), record = backend.records.get(original.image);
    const result = describeNativeImageManifestObservation(await observe(original));
    assert.equal(result.manifestDigest, original.image);
    assert.equal(result.layers[1].mediaType, OCI_ZSTD);
    assert.equal(result.layers[1].diffId, hash(record.rawLayers[1]));
    assert.notEqual(result.layers[1].digest, result.layers[1].diffId);
    assert.equal(result.layers[1].digest, result.manifest.layers[1].digest);
    assert.equal(result.bounds.maxZstdWindowBytes, 134217728);
    assert.equal(result.layerBlobDigestsVerified, true);
    assert.equal(result.layerMediaVerified, true);
    assert.equal(result.layerDiffIdsVerified, true);
    assert.equal(result.registryManifestVerified, false);
  });
});

test('orchestration-double only: media-codec Zstandard framing, checksum, tar media and exact DiffID cannot drift', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    for (const [change, expected] of [
      [fixture => { fixture.layers[1] = Buffer.from('not a standard Zstandard frame'); }, 'LAYER_MEDIA_MISMATCH'],
      [fixture => { fixture.layers[1] = fixture.layers[1].subarray(0, -4); }, 'LAYER_MEDIA_MISMATCH'],
      [fixture => { fixture.layers[1] = Buffer.from(fixture.layers[1]);
        fixture.layers[1][fixture.layers[1].length - 1] ^= 1; }, 'LAYER_MEDIA_MISMATCH'],
      [fixture => { fixture.layers[1] = zstdCompressSync(Buffer.from('not an uncompressed tar layer')); },
        'LAYER_MEDIA_MISMATCH'],
      [fixture => { const different = Buffer.from(zlib.zstdDecompressSync(fixture.layers[1]));
        different[600] ^= 1; fixture.layers[1] = zstdCompressSync(different); }, 'LAYER_DIFF_ID_MISMATCH']
    ]) {
      backend.nativeArchiveMutate = fixture => { zstdFixture(fixture); change(fixture); };
      await cleanedRejection(observe(await image()), expected);
    }
  });
});

test('orchestration-double only: media-codec Zstandard inflation shares the finite aggregate byte bound', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    backend.nativeArchiveMutate = zstdFixture;
    await cleanedRejection(observe(await image(), { maxUncompressedLayerBytes: 3072 }), 'LAYER_LIMIT');
  });
});

test('orchestration-double only: media-codec Zstandard denies concatenated frames and bounds header-declared windows', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    backend.nativeArchiveMutate = fixture => {
      const raw = gunzipSync(fixture.layers[1]);
      fixture.layers[1] = Buffer.concat([zstdCompressSync(raw.subarray(0, 1024)),
        zstdCompressSync(raw.subarray(1024))]);
      fixture.mediaTypes[1] = OCI_ZSTD;
    };
    await cleanedRejection(observe(await image()), 'LAYER_MEDIA_UNSUPPORTED');
    backend.nativeArchiveMutate = fixture => {
      fixture.mediaTypes[1] = OCI_ZSTD;
      fixture.layers[1] = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xa0, 1, 0, 0, 8, 1, 0, 0]);
    };
    await cleanedRejection(observe(await image()), 'LAYER_WINDOW_LIMIT');
  });
});

test('orchestration-double only: media-codec absent bounded Zstandard support denies without launching another process', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.imageIdKind = 'manifest';
    backend.nativeArchiveMutate = zstdFixture;
    const original = await image();
    const decoderProperty = Object.getOwnPropertyDescriptor(zlib, 'createZstdDecompress');
    Object.defineProperty(zlib, 'createZstdDecompress', { ...decoderProperty, value: undefined });
    try {
      await cleanedRejection(observe(original), 'LAYER_CODEC_UNAVAILABLE');
      assert.ok(backend.calls.every(call => !call.argv.includes('zstd')));
    } finally { Object.defineProperty(zlib, 'createZstdDecompress', decoderProperty); }
  });
});

test('orchestration-double only: fresh immutable inspection rechecks image ownership and root filesystem after export', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const original = await image();
    for (const [change, expected] of [
      [metadata => { metadata.Id = `sha256:${'b'.repeat(64)}`; }, 'OWNERSHIP_MISMATCH'],
      [metadata => { metadata.Config.Labels = {}; }, 'OWNERSHIP_MISMATCH'],
      [metadata => { metadata.RootFS.Layers[0] = `sha256:${'b'.repeat(64)}`; }, 'IMAGE_DRIFT']
    ]) {
      backend.immutableInspections = 0;
      backend.mutateInspection = (metadata, count) => { if (count === 2) change(metadata); };
      await cleanedRejection(observe(original), expected);
    }
  });
});

test('orchestration-double only: inspection stdout and export stderr have finite independent output bounds', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const original = await image();
    await cleanedRejection(observe(original, { maxOutputBytes: 256 }), 'OUTPUT_LIMIT');
    backend.saveStderr = Buffer.alloc(NATIVE_IMAGE_MANIFEST_LIMITS.maxOutputBytes + 1, 'x');
    await cleanedRejection(observe(original), 'OUTPUT_LIMIT');
    assert.ok(backend.kills.length >= 2);
  });
});

test('orchestration-double only: archive byte caps stop before writing over the exact owned bound', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    await cleanedRejection(observe(await image(), { maxArchiveBytes: 4096 }), 'ARCHIVE_LIMIT');
    assert.equal(backend.kills.at(-1).signal, 'SIGKILL');
  });
});

test('orchestration-double only: aggregate uncompressed layer bytes are capped, including gzip inflation', async t => {
  await withDouble(t, async ({ image, observe }) => {
    await cleanedRejection(observe(await image(), { maxUncompressedLayerBytes: 3072 }), 'LAYER_LIMIT');
  });
});

test('orchestration-double only: cancellation never publishes an observation and waits for verified export helper cleanup', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const original = await image(), cancelled = new AbortController();
    cancelled.abort();
    const before = backend.calls.length;
    await assert.rejects(observe(original, { signal: cancelled.signal }), code('CANCELLED'));
    assert.equal(backend.calls.length, before);
    const controller = new AbortController();
    backend.hangSave = true;
    backend.saveStarted = (_record, child) => {
      child.stdout.write(Buffer.alloc(512));
      setImmediate(() => controller.abort());
    };
    await cleanedRejection(observe(original, { signal: controller.signal }), 'CANCELLED');
    assert.equal(backend.children.at(-1).closed, true);
  });
});

test('orchestration-double only: a duration timeout terminates the helper before exact export cleanup', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.hangSave = true;
    await cleanedRejection(observe(await image(), { timeoutMs: 1000 }), 'TIMEOUT');
    assert.equal(backend.children.at(-1).closed, true);
  });
});

test('orchestration-double only: cancellation is supervised while scanning a zero-padded archive, not just during export', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const controller = new AbortController();
    backend.archive = () => Buffer.alloc(65536);
    backend.saveFinished = () => setImmediate(() => controller.abort());
    await cleanedRejection(observe(await image(), { signal: controller.signal }), 'CANCELLED');
  });
});

test('orchestration-double only: unverified process termination is explicit and cannot claim cleanup', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    backend.hangSave = true;
    backend.ignoreKill = true;
    let retained;
    try {
      await assert.rejects(observe(await image(), { timeoutMs: 1000 }), error => {
        assert.equal(error.code, 'PROCESS_STOP_UNVERIFIED');
        assert.equal(error.cleanupVerified, false);
        assert.equal(error.cleanupErrorCode, 'PROCESS_STOP_UNVERIFIED');
        retained = error.retainedDirectory;
        assert.equal(fs.existsSync(retained), true);
        return true;
      });
    } finally {
      backend.ignoreKill = false;
      for (const child of backend.children) if (!child.closed) child.kill('SIGKILL');
      await new Promise(resolve => setImmediate(resolve));
      if (retained) recoverExactDoubleWorkspace(retained);
    }
  });
});

test('orchestration-double only: ownership drift preserves the exact conflicting export path, never a broad sweep', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    let retained;
    backend.saveFinished = (_record, options) => {
      const filename = path.join(options.cwd, '.manifest-owner.json');
      const marker = JSON.parse(fs.readFileSync(filename));
      marker.nonce = randomUUID();
      fs.writeFileSync(filename, JSON.stringify(marker));
    };
    try {
      await assert.rejects(observe(await image()), error => {
        assert.equal(error.code, 'OWNERSHIP_MISMATCH');
        assert.equal(error.cleanupVerified, false);
        retained = error.retainedDirectory;
        assert.equal(fs.existsSync(path.join(retained, 'archive.tar')), true);
        return true;
      });
    } finally { if (retained) recoverExactDoubleWorkspace(retained); }
  });
});

test('orchestration-double only: ambiguous, incomplete, unsafe or unexpected archive shapes fail explicitly', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const original = await image();
    for (const [archive, expected] of [
      [record => ociArchive(record, fixture => {
        fixture.indexMutate = index => { index.manifests.push({ ...index.manifests[0] }); };
      }).bytes, 'ARCHIVE_UNSUPPORTED'],
      [record => ociArchive(record, fixture => {
        fixture.indexMutate = index => { index.manifests[0].platform.architecture = 'arm64'; };
      }).bytes, 'ARCHIVE_UNSUPPORTED'],
      [record => ociArchive(record, fixture => {
        fixture.archiveMutate = entries => entries.filter(entry => entry.name !== 'oci-layout');
      }).bytes, 'ARCHIVE_UNSUPPORTED'],
      [record => ociArchive(record, fixture => {
        fixture.extraEntries.push({ name: 'unexpected-export.txt', bytes: Buffer.from('not supported') });
      }).bytes, 'ARCHIVE_UNSUPPORTED'],
      [record => ociArchive(record, fixture => {
        fixture.extraEntries.push({ name: '../not-owned', bytes: Buffer.from('not extracted') });
      }).bytes, 'ARCHIVE_UNSUPPORTED'],
      [record => ociArchive(record, fixture => {
        fixture.extraEntries.push({ name: 'blobs/sha256/symlink', type: '2' });
      }).bytes, 'ARCHIVE_UNSUPPORTED'],
      [record => ociArchive(record).bytes.subarray(0, -512), 'ARCHIVE_INVALID'],
      [() => Buffer.from('not an export archive'), 'ARCHIVE_INVALID'],
      [record => {
        const bytes = Buffer.from(ociArchive(record).bytes);
        bytes[148] ^= 1;
        return bytes;
      }, 'ARCHIVE_INVALID']
    ]) {
      backend.archive = archive;
      await cleanedRejection(observe(original), expected);
    }
  });
});

test('orchestration-double only: JSON byte and archive entry limits remain finite even below the archive byte cap', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const original = await image();
    backend.archive = record => ociArchive(record, fixture => {
      fixture.archiveMutate = entries => entries.map(entry => entry.name === 'index.json'
        ? { ...entry, bytes: Buffer.alloc(NATIVE_IMAGE_MANIFEST_LIMITS.maxJSONBytes + 1, ' ') } : entry);
    }).bytes;
    await cleanedRejection(observe(original), 'JSON_LIMIT');
    backend.archive = record => ociArchive(record, fixture => {
      for (let index = 0; index < NATIVE_IMAGE_MANIFEST_LIMITS.maxArchiveEntries; index++) {
        fixture.extraEntries.push({ name: `extra-${index}`, bytes: Buffer.from('x') });
      }
    }).bytes;
    await cleanedRejection(observe(original), 'ARCHIVE_LIMIT');
  });
});

test('orchestration-double only: describe is historical while assert requires the still-active original image owner', async t => {
  await withDouble(t, async ({ backend, image, observe }) => {
    const original = await image(), observation = await observe(original);
    const before = describeNativeImageManifestObservation(observation);
    await cleanupNativeImage(original);
    await assert.rejects(assertNativeImageManifestObservation(observation,
      { client: 'claude-code', imageHandle: original }), code('NATIVE_IMAGE_UNTRUSTED'));
    assert.equal(describeNativeImageManifestObservation(observation).manifestDigest, before.manifestDigest);
    assert.equal(backend.records.size, 0);
  });
});

test('REAL credential-free original Claude image manifest export observation and exact cleanup', {
  skip: process.env.EVAL_NATIVE_IMAGE_MANIFEST_DOCKER !== '1', timeout: 660000
}, async () => {
  let imageHandle, observation, imageCleanup, observationCleanup, evidence, failure;
  try {
    imageHandle = await prepareNativeImage({ timeoutMs: 300000 });
    observation = await observeNativeImageManifest({
      client: 'claude-code', imageHandle, timeoutMs: 300000
    });
    const description = await assertNativeImageManifestObservation(observation, {
      client: 'claude-code', imageHandle
    });
    assert.equal(description.clientVersion, '2.1.291');
    assert.equal(description.imageId, describeNativeImage(imageHandle).image);
    if (description.imageIdType === 'docker-image-config-id') {
      assert.equal(description.configDigest, description.imageId);
    } else {
      assert.equal(description.imageIdType, 'docker-image-manifest-id');
      assert.equal(description.sourceManifestDigest, description.imageId);
      assert.equal(description.dockerDescriptor.digest, description.imageId);
      assert.equal(description.dockerDescriptor.mediaType, description.sourceManifestMediaType);
      assert.equal(description.manifestTargetVerified, true);
    }
    assert.notEqual(description.manifestDigest, description.configDigest);
    assert.equal(description.manifest.config.digest, description.configDigest);
    assert.equal(description.manifest.config.size, description.configSizeBytes);
    assert.equal(hash(Buffer.from(description.manifestJSON)), description.manifestDigest);
    assert.equal(description.imageIdentityVerified, true);
    assert.equal(description.configFactsVerified, true);
    assert.equal(description.layerBlobDigestsVerified, true);
    assert.equal(description.layerMediaVerified, true);
    assert.equal(description.layerDiffIdsVerified, true);
    assert.deepEqual(description.layers.map(layer => layer.diffId), description.dockerRootFSDiffIds);
    assert.equal(description.registryManifestVerified, false);
    assert.equal(description.authenticationVerified, false);
    assert.equal(description.liveAccepted, false);
    assert.equal(description.cleanup.cleanupVerified, true);
    assert.ok(description.layers.length > 0);
    evidence = {
      outcome: 'observed/local-artifact-only', originalObservationIssued: true,
      client: description.client, clientVersion: description.clientVersion,
      observationId: description.observationId, imageOwner: description.originalImageAuthority.owner,
      observedAt: description.observedAt, classification: description.classification,
      provenance: description.provenance, archiveFormat: description.archive.format,
      imageId: description.imageId, imageIdType: description.imageIdType,
      dockerImageIdProvenance: description.dockerImageIdProvenance, dockerDescriptor: description.dockerDescriptor,
      configDigest: description.configDigest, configMediaType: description.configMediaType,
      configSizeBytes: description.configSizeBytes, manifestDigest: description.manifestDigest,
      manifestMediaType: description.manifestMediaType, manifestSizeBytes: description.manifestSizeBytes,
      sourceManifestDigest: description.sourceManifestDigest, archiveDigest: description.archive.digest,
      archiveBytes: description.archive.bytes, layers: description.layers.length,
      uncompressedLayerBytes: description.uncompressedLayerBytes,
      configFactsVerified: true, layerBlobDigestsVerified: true, layerMediaVerified: true, layerDiffIdsVerified: true,
      sourceLayerMediaTypes: description.sourceLayerMediaTypes,
      layerEvidence: description.layers.map(layer => ({
        mediaType: layer.mediaType, digest: layer.digest, size: layer.size, diffId: layer.diffId
      })),
      registryManifestVerified: false, authenticationVerified: false, liveAccepted: false,
      exportCleanup: description.cleanup
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      if (observation) observationCleanup = await releaseNativeImageManifestObservation(observation);
    } finally {
      if (imageHandle) imageCleanup = await cleanupNativeImage(imageHandle);
    }
  }
  if (failure) {
    console.log(`NATIVE_IMAGE_MANIFEST_ACTUAL_FAILURE ${JSON.stringify({
      code: failure.code, imageIdentityField: failure.imageIdentityField,
      layerIndex: failure.layerIndex, layerMediaType: failure.layerMediaType,
      rejectedArtifact: failure.rejectedArtifact,
      originalObservationIssued: Boolean(observation), exportCleanup: failure.cleanup,
      cleanupVerified: failure.cleanupVerified, observationCleanup, imageCleanup
    })}`);
    throw failure;
  }
  assert.equal(imageCleanup.imageRemoved, true);
  assert.equal(imageCleanup.hostConfigRemoved, true);
  assert.ok(observation, 'The real scenario must genuinely issue an original observation');
  assert.equal(observationCleanup.cleanupVerified, true);
  assert.equal(describeNativeImageManifestObservation(observation).status, 'released');
  await assert.rejects(assertNativeImageManifestObservation(observation,
    { client: 'claude-code', imageHandle }), code('OBSERVATION_RELEASED'));
  console.log(`NATIVE_IMAGE_MANIFEST_ACTUAL_EVIDENCE ${JSON.stringify({
    ...evidence, observationCleanup, imageCleanup
  })}`);
});
