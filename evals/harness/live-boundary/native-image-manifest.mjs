import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import zlib from 'node:zlib';
import { CLIENT_VERSIONS } from '../isolation/index.mjs';
import {
  addAbortListener, deepFreeze, isAborted, removeAbortListener
} from './errors.mjs';
import {
  assertActiveNativeImageAuthority, captureNativeImageAuthority, validateNativeImageMetadata
} from './native-image.mjs';
import { runBoundedProcess, sanitizedDockerEnvironment } from './supervision.mjs';

const ownedRoot = fileURLToPath(new URL('.owned/', import.meta.url));
const observations = new WeakMap();
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const OCI_TAR = 'application/vnd.oci.image.layer.v1.tar';
const OCI_GZIP = `${OCI_TAR}+gzip`;
const OCI_ZSTD = `${OCI_TAR}+zstd`;
const DOCKER_INDEX = 'application/vnd.docker.distribution.manifest.list.v2+json';
const DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const DOCKER_CONFIG = 'application/vnd.docker.container.image.v1+json';
const dockerLayers = Object.freeze({
  'application/vnd.docker.image.rootfs.diff.tar': OCI_TAR,
  'application/vnd.docker.image.rootfs.diff.tar.gzip': OCI_GZIP
});
const layerCodecs = Object.freeze({
  [OCI_TAR]: 'tar', [OCI_GZIP]: 'gzip', [OCI_ZSTD]: 'zstd',
  'application/vnd.docker.image.rootfs.diff.tar': 'tar',
  'application/vnd.docker.image.rootfs.diff.tar.gzip': 'gzip'
});
const issuerNames = Object.freeze({
  'claude-code': 'claude-code.prepareNativeImage',
  copilot: 'copilot.buildNativeImage',
  opencode: 'opencode.prepareNativeRuntimeImage'
});

export const NATIVE_IMAGE_MANIFEST_LIMITS = Object.freeze({
  timeoutMs: 120000, maxOutputBytes: 131072, maxArchiveBytes: 1073741824,
  maxUncompressedLayerBytes: 2147483648, maxArchiveEntries: 512, maxLayers: 128,
  maxJSONBytes: 1048576, maxZstdWindowBytes: 134217728, processStopTimeoutMs: 1500
});

const messages = Object.freeze({
  INVALID_ARGUMENT: 'Invalid explicit bounded native image manifest arguments',
  INVALID_HANDLE: 'An original process-owned manifest observation is required',
  NATIVE_IMAGE_UNTRUSTED: 'An original active image handle from the exact native client owner is required',
  OBSERVATION_RELEASED: 'The original manifest observation has been released',
  OWNERSHIP_MISMATCH: 'Original image binding or exact owned export filesystem identity differs',
  RUNTIME_DRIFT: 'The freshly inspected native image differs from its required layout',
  CONFIG_MISMATCH: 'The freshly inspected native image configuration differs',
  IMAGE_DRIFT: 'The immutable image or its root filesystem changed during observation',
  IMAGE_ID_TYPE_UNVERIFIED: 'Fresh Docker metadata does not establish an unambiguous image ID type',
  IMAGE_ID_TYPE_UNSUPPORTED: 'The freshly inspected original Docker target type is unsupported',
  IMAGE_TARGET_MISMATCH: 'The original fresh Docker descriptor differs from the exact exported target blob',
  CONFIG_FACTS_MISMATCH: 'Decoded image config facts differ from fresh original Docker inspection',
  DOCKER_UNAVAILABLE: 'The installed local Docker executable is unavailable',
  DOCKER_FAILURE: 'The bounded local Docker inspection or export failed',
  OUTPUT_LIMIT: 'Docker diagnostic or inspection output exceeded its finite byte bound',
  ARCHIVE_LIMIT: 'The exported archive exceeded its finite byte or entry bound',
  ARCHIVE_UNSUPPORTED: 'The Docker export archive shape or manifest selection is unsupported',
  ARCHIVE_INVALID: 'The Docker export is not a complete supported tar archive',
  ARCHIVE_WRITE_FAILED: 'Writing the exact owned bounded archive failed',
  JSON_LIMIT: 'An exported JSON control blob exceeded its finite byte bound',
  BLOB_DIGEST_MISMATCH: 'An OCI blob filename does not match its actual SHA-256 bytes',
  MANIFEST_DIGEST_MISMATCH: 'The exported manifest descriptor differs from its actual blob',
  CONFIG_DIGEST_MISMATCH: 'The exported config blob differs from its descriptor or verified config-typed Docker ID',
  LAYER_DIGEST_MISMATCH: 'An exported layer descriptor differs from its actual blob',
  LAYER_MEDIA_MISMATCH: 'An exported layer does not have its declared complete tar, gzip-tar or Zstandard-tar media identity',
  LAYER_MEDIA_UNSUPPORTED: 'The exported layer media type is unsupported',
  LAYER_CODEC_UNAVAILABLE: 'The installed Node runtime cannot provide the required bounded layer decoder',
  LAYER_DIFF_ID_MISMATCH: 'An actual uncompressed layer digest differs from config or fresh Docker inspection',
  LAYER_LIMIT: 'Actual uncompressed layer bytes exceeded their finite aggregate bound',
  LAYER_WINDOW_LIMIT: 'The declared Zstandard decoder window exceeded its finite memory bound',
  TIMEOUT: 'The finite manifest observation deadline expired',
  CANCELLED: 'The manifest observation was cancelled',
  PROCESS_STOP_UNVERIFIED: 'Termination of an owned Docker export helper was not verified',
  CLEANUP_FAILED: 'Exact owned export cleanup could not be verified',
  INTERNAL_FAILURE: 'Native image manifest observation failed closed'
});

export class NativeImageManifestError extends Error {
  constructor(code = 'INTERNAL_FAILURE') {
    const stable = Object.hasOwn(messages, code) ? code : 'INTERNAL_FAILURE';
    super(messages[stable]);
    this.name = 'NativeImageManifestError';
    this.classification = 'infrastructure';
    this.code = stable;
  }
}

function insist(condition, code) {
  if (!condition) throw new NativeImageManifestError(code);
}

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const originalSignalReason = state => state.controller.signal.reason instanceof NativeImageManifestError
  ? state.controller.signal.reason : new NativeImageManifestError('CANCELLED');

function explicitOptions(options, allowed, required = []) {
  insist(options && !types.isProxy(options) && Object.getPrototypeOf(options) === Object.prototype &&
    Reflect.ownKeys(options).every(key => typeof key === 'string' && allowed.includes(key)) &&
    Object.values(Object.getOwnPropertyDescriptors(options)).every(item => Object.hasOwn(item, 'value')) &&
    required.every(key => Object.hasOwn(options, key)), 'INVALID_ARGUMENT');
}

function observationOptions(options) {
  explicitOptions(options, [
    'client', 'imageHandle', 'timeoutMs', 'signal', 'maxOutputBytes',
    'maxArchiveBytes', 'maxUncompressedLayerBytes'
  ], ['client', 'imageHandle']);
  insist(typeof options.client === 'string' && Object.hasOwn(issuerNames, options.client) && options.imageHandle &&
    typeof options.imageHandle === 'object' && !types.isProxy(options.imageHandle) &&
    (options.signal === undefined || options.signal instanceof AbortSignal && !types.isProxy(options.signal)),
  'INVALID_ARGUMENT');
  isAborted(options.signal);
  const bounded = {
    timeoutMs: options.timeoutMs ?? NATIVE_IMAGE_MANIFEST_LIMITS.timeoutMs,
    maxOutputBytes: options.maxOutputBytes ?? NATIVE_IMAGE_MANIFEST_LIMITS.maxOutputBytes,
    maxArchiveBytes: options.maxArchiveBytes ?? NATIVE_IMAGE_MANIFEST_LIMITS.maxArchiveBytes,
    maxUncompressedLayerBytes: options.maxUncompressedLayerBytes ??
      NATIVE_IMAGE_MANIFEST_LIMITS.maxUncompressedLayerBytes
  };
  for (const [key, minimum, maximum] of [
    ['timeoutMs', 1000, 300000], ['maxOutputBytes', 1, 262144],
    ['maxArchiveBytes', 1024, 2147483648], ['maxUncompressedLayerBytes', 1024, 4294967296]
  ]) insist(Number.isSafeInteger(bounded[key]) && bounded[key] >= minimum && bounded[key] <= maximum,
    'INVALID_ARGUMENT');
  return { ...bounded, client: options.client, imageHandle: options.imageHandle, signal: options.signal };
}

function lifetime(state) {
  if (isAborted(state.controller.signal)) throw originalSignalReason(state);
  insist(Date.now() < state.deadline, 'TIMEOUT');
}

function noLinks(filename) {
  let current = path.resolve(filename);
  for (;;) {
    if (fs.existsSync(current)) insist(!fs.lstatSync(current).isSymbolicLink(), 'OWNERSHIP_MISMATCH');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function rememberPath(state, relative, kind, content) {
  const filename = path.join(state.directory, relative);
  noLinks(filename);
  if (kind === 'directory') fs.mkdirSync(filename, { mode: 0o700 });
  else fs.writeFileSync(filename, content, { flag: 'wx', mode: 0o600 });
  const stat = fs.lstatSync(filename);
  state.paths.set(relative, { kind, dev: stat.dev, ino: stat.ino,
    ...(kind === 'file' ? { bytes: stat.size, digest: hash(content) } : {}) });
}

function createWorkspace(state) {
  noLinks(ownedRoot);
  fs.mkdirSync(ownedRoot, { recursive: true });
  state.directory = path.join(ownedRoot, `manifest-${state.id}`);
  fs.mkdirSync(state.directory, { mode: 0o700 });
  const stat = fs.lstatSync(state.directory);
  state.directoryIdentity = { dev: stat.dev, ino: stat.ino };
  rememberPath(state, '.manifest-owner.json', 'file',
    JSON.stringify({ id: state.id, purpose: 'native-image-manifest', nonce: randomUUID() }));
  for (const relative of ['docker-config', 'home', 'appdata', 'scratch']) {
    rememberPath(state, relative, 'directory');
  }
  rememberPath(state, path.join('docker-config', 'config.json'), 'file', '{}');
  state.configDirectory = path.join(state.directory, 'docker-config');
  state.archiveFilename = path.join(state.directory, 'archive.tar');
}

function assertWorkspace(state) {
  noLinks(state.directory);
  const root = fs.lstatSync(state.directory);
  insist(root.isDirectory() && root.dev === state.directoryIdentity.dev &&
    root.ino === state.directoryIdentity.ino, 'OWNERSHIP_MISMATCH');
  const actual = new Set();
  function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      const filename = path.join(directory, name);
      const relative = path.relative(state.directory, filename);
      const expected = state.paths.get(relative);
      const stat = fs.lstatSync(filename);
      insist(expected && !stat.isSymbolicLink() && stat.dev === expected.dev && stat.ino === expected.ino &&
        (expected.kind === 'directory' ? stat.isDirectory() : stat.isFile() && stat.nlink === 1 &&
          stat.size === (relative === 'archive.tar' ? state.archiveBytes : expected.bytes)),
      'OWNERSHIP_MISMATCH');
      actual.add(relative);
      if (expected.kind === 'directory') walk(filename);
      else if (relative !== 'archive.tar') insist(hash(fs.readFileSync(filename)) === expected.digest,
        'OWNERSHIP_MISMATCH');
    }
  }
  walk(state.directory);
  insist(actual.size === state.paths.size, 'OWNERSHIP_MISMATCH');
}

function cleanupWorkspace(state) {
  if (!state.directoryIdentity) return null;
  insist(state.helpersClosed && state.streamsClosed, 'PROCESS_STOP_UNVERIFIED');
  assertWorkspace(state);
  for (const [relative, entry] of [...state.paths].reverse()) {
    const filename = path.join(state.directory, relative);
    if (entry.kind === 'directory') fs.rmdirSync(filename);
    else fs.unlinkSync(filename);
  }
  fs.rmdirSync(state.directory);
  insist(!fs.existsSync(state.directory), 'CLEANUP_FAILED');
  return deepFreeze({
    exportId: state.id, archiveRemoved: true, dockerConfigRemoved: true, workspaceRemoved: true,
    helperProcessesClosed: true, containersCreated: 0, nativeImageRemoved: false, cleanupVerified: true
  });
}

function dockerCoordinates(state) {
  const candidates = process.platform === 'win32'
    ? ['C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe']
    : ['/usr/bin/docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker'];
  const executable = candidates.find(filename => fs.existsSync(filename) && fs.statSync(filename).isFile()) ??
    candidates[0];
  const env = sanitizedDockerEnvironment(state.configDirectory);
  delete env.Path;
  env.PATH = process.platform === 'win32'
    ? `${path.dirname(executable)};C:\\Windows\\System32;C:\\Windows`
    : `${path.dirname(executable)}:/usr/bin:/bin`;
  if (process.platform === 'win32') {
    env.SystemRoot = 'C:\\Windows';
    env.WINDIR = 'C:\\Windows';
    delete env.SYSTEMROOT;
    delete env.COMSPEC;
  }
  Object.assign(env, {
    HOME: path.join(state.directory, 'home'), USERPROFILE: path.join(state.directory, 'home'),
    APPDATA: path.join(state.directory, 'appdata'), LOCALAPPDATA: path.join(state.directory, 'appdata'),
    TMP: path.join(state.directory, 'scratch'), TEMP: path.join(state.directory, 'scratch'),
    TMPDIR: path.join(state.directory, 'scratch')
  });
  return { executable, env };
}

function dockerImageIdentity(image) {
  const requireField = (condition, field, code = 'IMAGE_ID_TYPE_UNVERIFIED') => {
    if (condition) return;
    const error = new NativeImageManifestError(code);
    error.imageIdentityField = field;
    throw error;
  };
  const descriptor = image.Descriptor;
  if (descriptor !== undefined && descriptor !== null) {
    requireField(descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor), 'Descriptor');
    requireField(descriptor.digest === image.Id && digestPattern.test(descriptor.digest), 'Descriptor.digest');
    requireField(Number.isSafeInteger(descriptor.size) && descriptor.size > 0 &&
      descriptor.size <= NATIVE_IMAGE_MANIFEST_LIMITS.maxJSONBytes, 'Descriptor.size');
    requireField(descriptor.urls === undefined && descriptor.data === undefined, 'Descriptor.urls/data');
    requireField(![OCI_INDEX, DOCKER_INDEX].includes(descriptor.mediaType),
      'Descriptor.mediaType', 'IMAGE_ID_TYPE_UNSUPPORTED');
    requireField([OCI_MANIFEST, DOCKER_MANIFEST, OCI_CONFIG, DOCKER_CONFIG].includes(descriptor.mediaType),
      'Descriptor.mediaType');
    return deepFreeze({
      imageId: image.Id,
      imageIdType: [OCI_MANIFEST, DOCKER_MANIFEST].includes(descriptor.mediaType)
        ? 'docker-image-manifest-id' : 'docker-image-config-id',
      provenance: 'fresh-docker-image-inspect-descriptor',
      descriptor: { mediaType: descriptor.mediaType, digest: descriptor.digest, size: descriptor.size },
      legacyGraphDriver: null
    });
  }
  // A missing descriptor alone does not establish legacy config-ID semantics.
  const graphDriver = image.GraphDriver?.Name;
  requireField(['overlay2', 'aufs', 'btrfs', 'zfs', 'vfs', 'devicemapper', 'fuse-overlayfs'].includes(graphDriver),
    'Descriptor/GraphDriver.Name');
  return deepFreeze({
    imageId: image.Id, imageIdType: 'docker-image-config-id',
    provenance: 'fresh-docker-image-inspect-legacy-graphdriver',
    descriptor: null, legacyGraphDriver: graphDriver
  });
}

async function inspectImage(state, binding) {
  lifetime(state);
  assertWorkspace(state);
  const result = await runBoundedProcess(state.executable, [
    '--config', state.configDirectory, 'image', 'inspect', binding.imageId
  ], {
    cwd: state.directory, env: state.env, deadline: state.deadline,
    signal: state.controller.signal, maxOutputBytes: state.options.maxOutputBytes
  });
  lifetime(state);
  let image;
  try {
    const values = JSON.parse(result.stdout);
    insist(Array.isArray(values) && values.length === 1, 'IMAGE_DRIFT');
    [image] = values;
  } catch (error) {
    if (error instanceof NativeImageManifestError) throw error;
    throw new NativeImageManifestError('IMAGE_DRIFT');
  }
  const metadata = validateNativeImageMetadata(binding, image);
  insist(image.RootFS?.Type === 'layers' && Array.isArray(image.RootFS.Layers) &&
    image.RootFS.Layers.length <= NATIVE_IMAGE_MANIFEST_LIMITS.maxLayers &&
    image.RootFS.Layers.every(value => digestPattern.test(value)), 'IMAGE_DRIFT');
  return { image, metadata, identity: dockerImageIdentity(image) };
}

function saveArchive(state, imageId) {
  lifetime(state);
  assertWorkspace(state);
  const fd = fs.openSync(state.archiveFilename, 'wx', 0o600);
  // Windows fd/path stat device IDs differ; compare pathname snapshots consistently.
  let stat;
  try {
    stat = fs.lstatSync(state.archiveFilename);
    insist(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
      stat.ino === fs.fstatSync(fd).ino, 'OWNERSHIP_MISMATCH');
  } catch (error) { fs.closeSync(fd); throw error; }
  state.paths.set('archive.tar', { kind: 'file', dev: stat.dev, ino: stat.ino });
  const archiveHash = createHash('sha256');
  return new Promise((resolve, reject) => {
    let child, failure, settled = false, diagnostics = 0, stopTimer;
    const closeFile = () => fs.closeSync(fd);
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(stopTimer);
      removeAbortListener(state.controller.signal, abort);
      try { closeFile(); } catch { error ??= new NativeImageManifestError('ARCHIVE_WRITE_FAILED'); }
      if (error) reject(error);
      else resolve({ bytes: state.archiveBytes, digest: `sha256:${archiveHash.digest('hex')}` });
    };
    const fail = code => {
      if (settled || failure) return;
      failure = new NativeImageManifestError(code);
      try { child.kill('SIGKILL'); } catch {}
      stopTimer = setTimeout(() => finish(new NativeImageManifestError('PROCESS_STOP_UNVERIFIED')),
        NATIVE_IMAGE_MANIFEST_LIMITS.processStopTimeoutMs);
    };
    const abort = () => fail(originalSignalReason(state).code);
    try {
      child = spawn(state.executable, [
        '--config', state.configDirectory, 'image', 'save', imageId
      ], {
        cwd: state.directory, env: state.env, shell: false, windowsHide: true, detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      state.helpersClosed = false;
    } catch { finish(new NativeImageManifestError('DOCKER_UNAVAILABLE')); return; }
    addAbortListener(state.controller.signal, abort);
    child.stdout.on('data', chunk => {
      if (failure || settled) return;
      if (state.archiveBytes + chunk.length > state.options.maxArchiveBytes) { fail('ARCHIVE_LIMIT'); return; }
      try {
        lifetime(state);
        let offset = 0;
        while (offset < chunk.length) {
          const written = fs.writeSync(fd, chunk, offset, chunk.length - offset);
          insist(written > 0, 'ARCHIVE_WRITE_FAILED');
          archiveHash.update(chunk.subarray(offset, offset + written));
          offset += written;
          state.archiveBytes += written;
        }
      } catch (error) { fail(error instanceof NativeImageManifestError ? error.code : 'ARCHIVE_WRITE_FAILED'); }
    });
    child.stderr.on('data', chunk => {
      diagnostics += chunk.length;
      if (diagnostics > state.options.maxOutputBytes) fail('OUTPUT_LIMIT');
    });
    child.stdout.once('error', () => fail('DOCKER_FAILURE'));
    child.stderr.once('error', () => fail('DOCKER_FAILURE'));
    child.once('error', () => fail('DOCKER_UNAVAILABLE'));
    child.once('close', (exitCode, processSignal) => {
      state.helpersClosed = true;
      finish(failure ?? (exitCode !== 0 || processSignal ? new NativeImageManifestError('DOCKER_FAILURE') : null));
    });
    if (isAborted(state.controller.signal)) abort();
  });
}

function octal(field) {
  const text = field.toString('ascii').replace(/\0.*$/s, '').trim();
  insist(/^[0-7]+$/.test(text), 'ARCHIVE_INVALID');
  const value = Number.parseInt(text, 8);
  insist(Number.isSafeInteger(value) && value >= 0, 'ARCHIVE_INVALID');
  return value;
}

function tarHeader(header) {
  let checksum = 0;
  for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
  insist(octal(header.subarray(148, 156)) === checksum &&
    ['ustar\0', 'ustar '].includes(header.subarray(257, 263).toString('ascii')), 'ARCHIVE_INVALID');
  return { size: octal(header.subarray(124, 136)), type: String.fromCharCode(header[156]) };
}

function archiveName(header, type) {
  const field = (start, end) => header.subarray(start, end).toString('utf8').split('\0')[0];
  const prefix = field(345, 500), name = field(0, 100);
  const joined = `${prefix ? `${prefix}/` : ''}${name}`;
  const canonical = type === '5' && joined.endsWith('/') ? joined.slice(0, -1) : joined;
  insist(canonical.length > 0 && canonical.length <= 240 && /^[a-zA-Z0-9._/-]+$/.test(canonical) &&
    canonical.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)),
  'ARCHIVE_UNSUPPORTED');
  return canonical;
}

function readExactly(state, fd, offset, length) {
  lifetime(state);
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = fs.readSync(fd, buffer, read, length - read, offset + read);
    insist(count > 0, 'ARCHIVE_INVALID');
    read += count;
  }
  return buffer;
}

async function scanArchive(state, expectedDigest) {
  assertWorkspace(state);
  insist(state.archiveBytes >= 1024 && state.archiveBytes % 512 === 0, 'ARCHIVE_INVALID');
  const fd = fs.openSync(state.archiveFilename, 'r');
  const archiveHash = createHash('sha256'), entries = new Map();
  let offset = 0, chunks = 0, zeroBlocks = 0;
  try {
    while (offset < state.archiveBytes) {
      const header = readExactly(state, fd, offset, 512);
      archiveHash.update(header);
      offset += 512;
      if (header.every(value => value === 0)) {
        zeroBlocks++;
        if (++chunks % 16 === 0) await yieldTurn();
        continue;
      }
      insist(zeroBlocks === 0, 'ARCHIVE_INVALID');
      const { size, type } = tarHeader(header);
      insist(['\0', '0', '5'].includes(type), 'ARCHIVE_UNSUPPORTED');
      const name = archiveName(header, type), padded = Math.ceil(size / 512) * 512;
      insist(!entries.has(name) && entries.size < NATIVE_IMAGE_MANIFEST_LIMITS.maxArchiveEntries &&
        offset + padded <= state.archiveBytes && (type !== '5' || size === 0), 'ARCHIVE_LIMIT');
      const entry = { name, size, offset, type, digest: null }, contentHash = createHash('sha256');
      let consumed = 0;
      while (consumed < padded) {
        const length = Math.min(65536, padded - consumed);
        const bytes = readExactly(state, fd, offset + consumed, length);
        archiveHash.update(bytes);
        const contentLength = Math.max(0, Math.min(length, size - consumed));
        contentHash.update(bytes.subarray(0, contentLength));
        insist(bytes.subarray(contentLength).every(value => value === 0), 'ARCHIVE_INVALID');
        consumed += length;
        if (++chunks % 16 === 0) await yieldTurn();
      }
      offset += padded;
      entry.digest = `sha256:${contentHash.digest('hex')}`;
      if (/^blobs\/sha256\/[a-f0-9]{64}$/.test(name)) {
        insist(entry.digest === `sha256:${name.slice('blobs/sha256/'.length)}`, 'BLOB_DIGEST_MISMATCH');
      }
      entries.set(name, entry);
      if (++chunks % 16 === 0) await yieldTurn();
    }
    insist(zeroBlocks >= 2 && `sha256:${archiveHash.digest('hex')}` === expectedDigest, 'ARCHIVE_INVALID');
    return entries;
  } finally { fs.closeSync(fd); }
}

function jsonEntry(state, entries, name) {
  const entry = entries.get(name);
  insist(entry && ['0', '\0'].includes(entry.type), 'ARCHIVE_UNSUPPORTED');
  insist(entry.size > 0 && entry.size <= NATIVE_IMAGE_MANIFEST_LIMITS.maxJSONBytes, 'JSON_LIMIT');
  const fd = fs.openSync(state.archiveFilename, 'r');
  try {
    const bytes = readExactly(state, fd, entry.offset, entry.size);
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return { value: JSON.parse(text), text, entry };
    }
    catch { throw new NativeImageManifestError('ARCHIVE_UNSUPPORTED'); }
  } finally { fs.closeSync(fd); }
}

function descriptorEntry(entries, descriptor, code) {
  insist(descriptor && typeof descriptor === 'object' && digestPattern.test(descriptor.digest) &&
    Number.isSafeInteger(descriptor.size) && descriptor.size > 0 &&
    descriptor.urls === undefined && descriptor.data === undefined, code);
  const entry = entries.get(`blobs/sha256/${descriptor.digest.slice(7)}`);
  insist(entry && ['0', '\0'].includes(entry.type) &&
    entry.size === descriptor.size && entry.digest === descriptor.digest, code);
  return entry;
}

function canonicalFacts(value) {
  if (Array.isArray(value)) return value.map(canonicalFacts);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalFacts(value[key])]));
  }
  return value;
}

function configFacts(config) {
  insist(config && typeof config === 'object' && !Array.isArray(config) &&
    (config.Env === undefined || config.Env === null || Array.isArray(config.Env)), 'CONFIG_FACTS_MISMATCH');
  return canonicalFacts({
    User: config.User ?? '', WorkingDir: config.WorkingDir ?? '',
    Entrypoint: config.Entrypoint ?? [], Cmd: config.Cmd ?? [], Env: [...(config.Env ?? [])].sort(),
    Labels: config.Labels ?? {}, Volumes: config.Volumes ?? {}, ExposedPorts: config.ExposedPorts ?? {},
    OnBuild: config.OnBuild ?? [], Healthcheck: config.Healthcheck ?? null,
    StopSignal: config.StopSignal ?? '', Shell: config.Shell ?? [], ArgsEscaped: config.ArgsEscaped ?? false
  });
}

function assertConfigFacts(config, image) {
  insist(config?.os === image.Os && config.architecture === image.Architecture &&
    (config.variant ?? '') === (image.Variant ?? ''), 'CONFIG_FACTS_MISMATCH');
  insist(JSON.stringify(configFacts(config.config)) === JSON.stringify(configFacts(image.Config)),
    'CONFIG_FACTS_MISMATCH');
  insist(
    config.rootfs?.type === 'layers' && Array.isArray(config.rootfs.diff_ids) &&
    JSON.stringify(config.rootfs.diff_ids) === JSON.stringify(image.RootFS.Layers), 'LAYER_DIFF_ID_MISMATCH');
}

function assertImageTarget(identity, sourceManifest, sourceConfig) {
  if (identity.imageIdType === 'docker-image-config-id') {
    insist(sourceConfig.digest === identity.imageId, 'CONFIG_DIGEST_MISMATCH');
  } else {
    insist(sourceManifest && sourceManifest.digest === identity.imageId, 'IMAGE_TARGET_MISMATCH');
  }
  if (identity.descriptor) {
    const actual = identity.imageIdType === 'docker-image-config-id' ? sourceConfig : sourceManifest;
    insist(actual && JSON.stringify(actual) === JSON.stringify(identity.descriptor), 'IMAGE_TARGET_MISMATCH');
  }
}

function manifestFromArchive(state, entries, image, identity) {
  let manifest, manifestJSON, sourceManifestDigest = null, sourceManifestMediaType = null;
  let configEntry, layerEntries, provenance, archiveFormat, sourceManifest = null, sourceConfig;
  if (entries.has('oci-layout') || entries.has('index.json')) {
    insist(jsonEntry(state, entries, 'oci-layout').value?.imageLayoutVersion === '1.0.0',
      'ARCHIVE_UNSUPPORTED');
    for (const entry of entries.values()) insist(
      ['oci-layout', 'index.json', 'manifest.json', 'blobs', 'blobs/sha256'].includes(entry.name) ||
      /^blobs\/sha256\/[a-f0-9]{64}$/.test(entry.name), 'ARCHIVE_UNSUPPORTED');
    let index = jsonEntry(state, entries, 'index.json').value;
    for (let depth = 0; ; depth++) {
      insist(depth < 4 && index?.schemaVersion === 2 &&
        (index.mediaType === undefined || [OCI_INDEX, DOCKER_INDEX].includes(index.mediaType)) &&
        Array.isArray(index.manifests) && index.manifests.length === 1 &&
        index.subject === undefined && index.artifactType === undefined, 'ARCHIVE_UNSUPPORTED');
      const descriptor = index.manifests[0];
      insist(!descriptor.platform || descriptor.platform.os === 'linux' &&
        descriptor.platform.architecture === 'amd64' && !descriptor.platform.variant, 'ARCHIVE_UNSUPPORTED');
      const entry = descriptorEntry(entries, descriptor, 'MANIFEST_DIGEST_MISMATCH');
      const parsed = jsonEntry(state, entries, entry.name);
      insist(parsed.value && (parsed.value.mediaType === undefined || parsed.value.mediaType === descriptor.mediaType),
        'MANIFEST_DIGEST_MISMATCH');
      if ([OCI_INDEX, DOCKER_INDEX].includes(descriptor.mediaType)) { index = parsed.value; continue; }
      insist([OCI_MANIFEST, DOCKER_MANIFEST].includes(descriptor.mediaType) &&
        parsed.value.schemaVersion === 2 && parsed.value.subject === undefined &&
        parsed.value.artifactType === undefined, 'ARCHIVE_UNSUPPORTED');
      sourceManifestDigest = entry.digest;
      sourceManifestMediaType = descriptor.mediaType;
      sourceManifest = { mediaType: descriptor.mediaType, digest: entry.digest, size: entry.size };
      manifest = parsed.value;
      manifestJSON = parsed.text;
      break;
    }
    insist(manifest.config?.mediaType === (sourceManifestMediaType === OCI_MANIFEST ? OCI_CONFIG : DOCKER_CONFIG),
      'ARCHIVE_UNSUPPORTED');
    configEntry = descriptorEntry(entries, manifest.config, 'CONFIG_DIGEST_MISMATCH');
    sourceConfig = { mediaType: manifest.config.mediaType, digest: configEntry.digest, size: configEntry.size };
    insist(Array.isArray(manifest.layers) && manifest.layers.length <= NATIVE_IMAGE_MANIFEST_LIMITS.maxLayers,
      'ARCHIVE_UNSUPPORTED');
    layerEntries = manifest.layers.map(layer => descriptorEntry(entries, layer, 'LAYER_DIGEST_MISMATCH'));
    if (entries.has('manifest.json')) {
      const compatibility = jsonEntry(state, entries, 'manifest.json').value;
      insist(Array.isArray(compatibility) && compatibility.length === 1 &&
        compatibility[0].Config === configEntry.name &&
        JSON.stringify(compatibility[0].Layers) === JSON.stringify(layerEntries.map(entry => entry.name)),
      'ARCHIVE_UNSUPPORTED');
    }
    archiveFormat = 'oci-layout';
    provenance = sourceManifestMediaType === OCI_MANIFEST
      ? 'local-oci-layout-exported-by-docker-image-save'
      : 'local-oci-manifest-derived-from-docker-save-docker-v2-manifest';
  } else {
    insist(identity.imageIdType === 'docker-image-config-id', 'IMAGE_TARGET_MISMATCH');
    const saved = jsonEntry(state, entries, 'manifest.json').value;
    insist(Array.isArray(saved) && saved.length === 1 &&
      /^[a-f0-9]{64}\.json$/.test(saved[0]?.Config) && Array.isArray(saved[0].Layers) &&
      saved[0].Layers.length <= NATIVE_IMAGE_MANIFEST_LIMITS.maxLayers &&
      saved[0].Layers.every(name => typeof name === 'string' && /^[a-f0-9]{64}\/layer\.tar$/.test(name)),
    'ARCHIVE_UNSUPPORTED');
    configEntry = entries.get(saved[0].Config);
    insist(configEntry && ['0', '\0'].includes(configEntry.type) &&
      configEntry.name === `${image.Id.slice(7)}.json`, 'CONFIG_DIGEST_MISMATCH');
    layerEntries = saved[0].Layers.map(name => {
      const entry = entries.get(name);
      insist(entry && ['0', '\0'].includes(entry.type) && entry.size > 0, 'LAYER_DIGEST_MISMATCH');
      return entry;
    });
    const layerDirectories = new Set(layerEntries.map(entry => entry.name.split('/')[0]));
    for (const entry of entries.values()) {
      const parts = entry.name.split('/');
      insist(['manifest.json', 'repositories', configEntry.name].includes(entry.name) ||
        layerDirectories.has(parts[0]) && (parts.length === 1 && entry.type === '5' ||
          parts.length === 2 && ['layer.tar', 'VERSION', 'json'].includes(parts[1])), 'ARCHIVE_UNSUPPORTED');
      if (parts[1] === 'json' || entry.name === 'repositories') jsonEntry(state, entries, entry.name);
      if (parts[1] === 'VERSION') insist(entry.size <= 16, 'ARCHIVE_UNSUPPORTED');
    }
    manifest = { schemaVersion: 2, mediaType: OCI_MANIFEST,
      config: { mediaType: OCI_CONFIG, digest: configEntry.digest, size: configEntry.size },
      layers: layerEntries.map(entry => ({ mediaType: OCI_TAR, digest: entry.digest, size: entry.size })) };
    manifestJSON = JSON.stringify(manifest);
    sourceConfig = { mediaType: OCI_CONFIG, digest: configEntry.digest, size: configEntry.size };
    archiveFormat = 'docker-save-v1';
    provenance = 'local-oci-manifest-derived-from-docker-save-layer-tars';
  }
  assertImageTarget(identity, sourceManifest, sourceConfig);
  const config = jsonEntry(state, entries, configEntry.name).value;
  assertConfigFacts(config, image);
  const diffIds = config.rootfs.diff_ids;
  insist(layerEntries.length === diffIds.length, 'LAYER_DIFF_ID_MISMATCH');
  state.artifactDiagnostic = deepFreeze({
    classification: 'rejected-local-image-artifact/not-observation',
    observedAt: new Date().toISOString(), client: state.options.client,
    imageId: image.Id, imageIdType: identity.imageIdType, dockerDescriptor: identity.descriptor,
    provenance, archive: { format: archiveFormat, ...state.archive },
    manifestDigest: sourceManifestMediaType === DOCKER_MANIFEST ? null : hash(Buffer.from(manifestJSON)),
    manifestMediaType: sourceManifestMediaType === DOCKER_MANIFEST ? null : OCI_MANIFEST,
    sourceManifestDigest, sourceManifestMediaType,
    configDigest: configEntry.digest, configSizeBytes: configEntry.size,
    sourceConfigMediaType: sourceConfig.mediaType,
    layers: manifest.layers.map((layer, index) => ({
      mediaType: layer.mediaType, digest: layerEntries[index].digest, size: layerEntries[index].size,
      declaredDiffId: diffIds[index]
    })),
    imageTargetVerified: true, configFactsVerified: true, layerBlobDigestsVerified: true,
    layerMediaVerified: false, layerDiffIdsVerified: false, originalObservationIssued: false,
    registryManifestVerified: false, authenticationVerified: false, liveAccepted: false
  });
  for (const [index, layer] of manifest.layers.entries()) {
    if (!Object.hasOwn(layerCodecs, layer.mediaType)) {
      const error = new NativeImageManifestError('LAYER_MEDIA_UNSUPPORTED');
      error.layerIndex = index;
      error.layerMediaType = layer.mediaType;
      throw error;
    }
  }
  if (sourceManifestMediaType === DOCKER_MANIFEST) {
    manifest = { schemaVersion: 2, mediaType: OCI_MANIFEST,
      config: { mediaType: OCI_CONFIG, digest: configEntry.digest, size: configEntry.size },
      layers: manifest.layers.map(layer => ({
        mediaType: Object.hasOwn(dockerLayers, layer.mediaType) ? dockerLayers[layer.mediaType] : layer.mediaType,
        digest: layer.digest, size: layer.size
      })) };
    manifestJSON = JSON.stringify(manifest);
    state.artifactDiagnostic = deepFreeze({ ...state.artifactDiagnostic,
      manifestDigest: hash(Buffer.from(manifestJSON)), manifestMediaType: OCI_MANIFEST });
  }
  return { manifest, manifestJSON, manifestDigest: hash(Buffer.from(manifestJSON)),
    configDigest: configEntry.digest, layerEntries, diffIds, provenance, archiveFormat,
    sourceManifestDigest, sourceManifestMediaType, sourceManifest, sourceConfig, config };
}

class LayerTar {
  constructor() { this.header = Buffer.alloc(512); this.position = 0; this.body = 0; this.zeros = 0; }

  update(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.body) {
        const length = Math.min(this.body, bytes.length - offset);
        this.body -= length;
        offset += length;
        continue;
      }
      const length = Math.min(512 - this.position, bytes.length - offset);
      bytes.copy(this.header, this.position, offset, offset + length);
      this.position += length;
      offset += length;
      if (this.position !== 512) continue;
      this.position = 0;
      if (this.header.every(value => value === 0)) { this.zeros++; continue; }
      insist(this.zeros === 0, 'LAYER_MEDIA_MISMATCH');
      const { size, type } = tarHeader(this.header);
      insist(['\0', '0', '1', '2', '3', '4', '5', '6', '7', 'x', 'g', 'L', 'K'].includes(type),
        'LAYER_MEDIA_MISMATCH');
      this.body = Math.ceil(size / 512) * 512;
    }
  }

  finish() { insist(this.position === 0 && this.body === 0 && this.zeros >= 2, 'LAYER_MEDIA_MISMATCH'); }
}

class ZstdFrames {
  constructor() {
    this.header = Buffer.alloc(18);
    this.phase = 'magic';
    this.position = 0;
    this.need = 4;
    this.body = 0;
    this.frames = 0;
    this.knownSizes = true;
    this.declaredBytes = 0;
  }

  next(phase, need) { this.phase = phase; this.need = need; this.position = 0; }

  endFrame() {
    this.frames++;
    this.next('magic', 4);
  }

  afterBlock() {
    if (!this.lastBlock) this.next('block', 3);
    else if (this.checksum) this.next('checksum', 4);
    else this.endFrame();
  }

  frameHeader() {
    const descriptor = this.header[0], single = Boolean(descriptor & 32);
    let offset = 1;
    let window;
    if (!single) {
      const encoded = this.header[offset++], base = 2 ** (10 + (encoded >> 3));
      window = base + base / 8 * (encoded & 7);
    }
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
    if (dictionaryBytes) {
      insist(this.header.readUIntLE(offset, dictionaryBytes) === 0, 'LAYER_MEDIA_UNSUPPORTED');
      offset += dictionaryBytes;
    }
    const sizeBytes = [single ? 1 : 0, 2, 4, 8][descriptor >> 6];
    if (sizeBytes) {
      const size = sizeBytes === 8 ? Number(this.header.readBigUInt64LE(offset))
        : this.header.readUIntLE(offset, sizeBytes) + (sizeBytes === 2 ? 256 : 0);
      insist(Number.isSafeInteger(size) && size >= 0, 'LAYER_MEDIA_MISMATCH');
      if (single) window = size;
      this.declaredBytes += size;
      insist(Number.isSafeInteger(this.declaredBytes), 'LAYER_MEDIA_MISMATCH');
    } else this.knownSizes = false;
    insist(window <= NATIVE_IMAGE_MANIFEST_LIMITS.maxZstdWindowBytes, 'LAYER_WINDOW_LIMIT');
    this.next('block', 3);
  }

  update(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.phase === 'body') {
        const length = Math.min(this.body, bytes.length - offset);
        this.body -= length;
        offset += length;
        if (!this.body) this.afterBlock();
        continue;
      }
      const length = Math.min(this.need - this.position, bytes.length - offset);
      bytes.copy(this.header, this.position, offset, offset + length);
      this.position += length;
      offset += length;
      if (this.position !== this.need) continue;
      if (this.phase === 'magic') {
        // Native decoding can silently accept a truncated or extra frame.
        insist(this.frames === 0, 'LAYER_MEDIA_UNSUPPORTED');
        insist(this.header.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])),
          'LAYER_MEDIA_MISMATCH');
        this.next('descriptor', 1);
      } else if (this.phase === 'descriptor') {
        const descriptor = this.header[0], single = Boolean(descriptor & 32);
        insist((descriptor & 24) === 0, 'LAYER_MEDIA_MISMATCH');
        this.checksum = Boolean(descriptor & 4);
        this.phase = 'header';
        this.need = 1 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] +
          [single ? 1 : 0, 2, 4, 8][descriptor >> 6];
        if (this.position === this.need) this.frameHeader();
      } else if (this.phase === 'header') this.frameHeader();
      else if (this.phase === 'checksum') this.endFrame();
      else {
        const encoded = this.header.readUIntLE(0, 3), type = encoded >> 1 & 3, size = encoded >> 3;
        insist(type !== 3 && size <= 131072, 'LAYER_MEDIA_MISMATCH');
        this.lastBlock = Boolean(encoded & 1);
        this.body = type === 1 ? 1 : size;
        this.phase = 'body';
        if (!this.body) this.afterBlock();
      }
    }
  }

  finish(uncompressedBytes) {
    insist(this.frames > 0 && this.phase === 'magic' && this.position === 0 &&
      (!this.knownSizes || this.declaredBytes === uncompressedBytes), 'LAYER_MEDIA_MISMATCH');
  }
}

async function verifyLayer(state, entry, descriptor, diffId) {
  lifetime(state);
  assertWorkspace(state);
  const fd = fs.openSync(state.archiveFilename, 'r');
  let prefix;
  try { prefix = readExactly(state, fd, entry.offset, Math.min(4, entry.size)); }
  finally { fs.closeSync(fd); }
  const codec = layerCodecs[descriptor.mediaType];
  insist(codec, 'LAYER_MEDIA_UNSUPPORTED');
  const gzip = prefix.subarray(0, 3).equals(Buffer.from([0x1f, 0x8b, 0x08]));
  const zstd = prefix.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  insist(codec === 'gzip' ? gzip : codec === 'zstd' ? zstd : !gzip && !zstd, 'LAYER_MEDIA_MISMATCH');
  if (codec === 'zstd') insist(typeof zlib.createZstdDecompress === 'function' &&
    Number.isInteger(zlib.constants.ZSTD_d_windowLogMax), 'LAYER_CODEC_UNAVAILABLE');
  const tar = new LayerTar(), uncompressedHash = createHash('sha256');
  const compressedHash = createHash('sha256');
  const frames = codec === 'zstd' ? new ZstdFrames() : null;
  const uncompressedStart = state.uncompressedBytes;
  let compressedBytes = 0;
  const source = fs.createReadStream(state.archiveFilename, {
    start: entry.offset, end: entry.offset + entry.size - 1, highWaterMark: 65536
  });
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      try {
        lifetime(state);
        state.uncompressedBytes += chunk.length;
        insist(state.uncompressedBytes <= state.options.maxUncompressedLayerBytes, 'LAYER_LIMIT');
        tar.update(chunk);
        uncompressedHash.update(chunk);
        callback();
      } catch (error) { callback(error); }
    }
  });
  const stored = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        lifetime(state);
        compressedBytes += chunk.length;
        insist(compressedBytes <= descriptor.size, 'LAYER_DIGEST_MISMATCH');
        compressedHash.update(chunk);
        frames?.update(chunk);
        callback(null, chunk);
      } catch (error) { callback(error); }
    }
  });
  state.streamsClosed = false;
  try {
    const decoder = codec === 'gzip' ? zlib.createGunzip({ chunkSize: 65536 })
      : codec === 'zstd' ? zlib.createZstdDecompress({
        chunkSize: 65536, params: { [zlib.constants.ZSTD_d_windowLogMax]: 27 }
      }) : null;
    await pipeline(...[source, stored, ...(decoder ? [decoder] : []), sink], { signal: state.controller.signal });
    insist(compressedBytes === descriptor.size &&
      `sha256:${compressedHash.digest('hex')}` === descriptor.digest, 'LAYER_DIGEST_MISMATCH');
    frames?.finish(state.uncompressedBytes - uncompressedStart);
    tar.finish();
    insist(`sha256:${uncompressedHash.digest('hex')}` === diffId, 'LAYER_DIFF_ID_MISMATCH');
  } catch (error) {
    if (isAborted(state.controller.signal)) throw originalSignalReason(state);
    if (error instanceof NativeImageManifestError && error.code !== 'ARCHIVE_INVALID') throw error;
    throw new NativeImageManifestError('LAYER_MEDIA_MISMATCH');
  } finally { state.streamsClosed = source.closed; }
}

export async function observeNativeImageManifest(options) {
  insist(arguments.length === 1, 'INVALID_ARGUMENT');
  const selected = observationOptions(options);
  insist(!isAborted(selected.signal), 'CANCELLED');
  const binding = await captureNativeImageAuthority(selected.client, selected.imageHandle)
    .catch(() => { throw new NativeImageManifestError('NATIVE_IMAGE_UNTRUSTED'); });
  const state = {
    id: randomUUID(), options: selected, deadline: Date.now() + selected.timeoutMs,
    controller: new AbortController(), paths: new Map(), archiveBytes: 0,
    uncompressedBytes: 0, helpersClosed: true, streamsClosed: true
  };
  const abort = () => state.controller.abort(new NativeImageManifestError('CANCELLED'));
  addAbortListener(selected.signal, abort);
  const timer = setTimeout(() => state.controller.abort(new NativeImageManifestError('TIMEOUT')),
    selected.timeoutMs);
  if (isAborted(selected.signal)) abort();
  let description, failure, cleanup;
  try {
    lifetime(state);
    createWorkspace(state);
    const coordinates = dockerCoordinates(state);
    state.executable = coordinates.executable;
    state.env = coordinates.env;
    const before = await inspectImage(state, binding);
    await assertActiveNativeImageAuthority(binding);
    const archive = await saveArchive(state, binding.imageId);
    state.archive = archive;
    const entries = await scanArchive(state, archive.digest);
    const exported = manifestFromArchive(state, entries, before.image, before.identity);
    for (let index = 0; index < exported.layerEntries.length; index++) {
      try {
        await verifyLayer(state, exported.layerEntries[index], exported.manifest.layers[index], exported.diffIds[index]);
      } catch (error) {
        error.layerIndex = index;
        error.layerMediaType = state.artifactDiagnostic.layers[index].mediaType;
        throw error;
      }
    }
    const after = await inspectImage(state, binding);
    insist(JSON.stringify(before.image.RootFS.Layers) === JSON.stringify(after.image.RootFS.Layers) &&
      JSON.stringify(before.identity) === JSON.stringify(after.identity), 'IMAGE_DRIFT');
    assertImageTarget(after.identity, exported.sourceManifest, exported.sourceConfig);
    assertConfigFacts(exported.config, after.image);
    await assertActiveNativeImageAuthority(binding);
    lifetime(state);
    description = {
      observationId: state.id, client: binding.client, clientVersion: CLIENT_VERSIONS[binding.client],
      observedAt: new Date().toISOString(), classification: 'local-image-manifest-observation/not-registry-proof',
      provenance: exported.provenance, registryManifestVerified: false,
      authenticationVerified: false, liveAccepted: false,
      originalImageAuthority: { issuer: issuerNames[binding.client], owner: binding.owner,
        client: binding.client, clientVersion: CLIENT_VERSIONS[binding.client], imageId: binding.imageId,
        imageIdType: after.identity.imageIdType },
      imageId: binding.imageId, imageIdType: after.identity.imageIdType,
      dockerImageId: binding.imageId, dockerImageIdType: after.identity.imageIdType,
      dockerImageIdProvenance: after.identity.provenance, dockerDescriptor: after.identity.descriptor,
      legacyGraphDriver: after.identity.legacyGraphDriver, dockerRootFSDiffIds: [...after.image.RootFS.Layers],
      imageIdentityVerified: true, manifestTargetVerified: after.identity.imageIdType === 'docker-image-manifest-id',
      configDigest: exported.configDigest, manifestDigest: exported.manifestDigest,
      configDigestType: 'oci-image-config-digest', configMediaType: OCI_CONFIG,
      configSizeBytes: exported.sourceConfig.size, sourceConfigMediaType: exported.sourceConfig.mediaType,
      configFactsVerified: true, layerBlobDigestsVerified: true, layerMediaVerified: true, layerDiffIdsVerified: true,
      manifestDigestType: 'local-oci-image-manifest-digest',
      manifestMediaType: OCI_MANIFEST, manifestSizeBytes: Buffer.byteLength(exported.manifestJSON),
      manifestJSON: exported.manifestJSON, manifest: exported.manifest,
      sourceManifestDigest: exported.sourceManifestDigest,
      sourceManifestMediaType: exported.sourceManifestMediaType,
      layers: exported.manifest.layers.map((layer, index) => ({ ...layer, diffId: exported.diffIds[index] })),
      sourceLayerMediaTypes: state.artifactDiagnostic.layers.map(layer => layer.mediaType),
      archive: { format: exported.archiveFormat, bytes: archive.bytes, digest: archive.digest },
      uncompressedLayerBytes: state.uncompressedBytes, imageInspection: after.metadata,
      bounds: { timeoutMs: selected.timeoutMs, maxOutputBytes: selected.maxOutputBytes,
        maxArchiveBytes: selected.maxArchiveBytes, maxUncompressedLayerBytes: selected.maxUncompressedLayerBytes,
        maxArchiveEntries: NATIVE_IMAGE_MANIFEST_LIMITS.maxArchiveEntries,
        maxLayers: NATIVE_IMAGE_MANIFEST_LIMITS.maxLayers, maxJSONBytes: NATIVE_IMAGE_MANIFEST_LIMITS.maxJSONBytes,
        maxZstdWindowBytes: NATIVE_IMAGE_MANIFEST_LIMITS.maxZstdWindowBytes }
    };
  } catch (error) {
    failure = isAborted(state.controller.signal) && error.code !== 'PROCESS_STOP_UNVERIFIED'
      ? originalSignalReason(state)
      : error instanceof NativeImageManifestError ? error : new NativeImageManifestError(error?.code);
    if (failure.code === 'PROCESS_STOP_UNVERIFIED') state.helpersClosed = false;
    if (state.artifactDiagnostic) failure.rejectedArtifact = state.artifactDiagnostic;
  } finally {
    clearTimeout(timer);
    removeAbortListener(selected.signal, abort);
    try { cleanup = cleanupWorkspace(state); }
    catch (error) {
      failure ??= new NativeImageManifestError('CLEANUP_FAILED');
      failure.cleanupErrorCode = error instanceof NativeImageManifestError ? error.code : 'CLEANUP_FAILED';
      failure.cleanupVerified = false;
      failure.retainedDirectory = state.directory;
    }
  }
  if (failure) {
    if (cleanup) { failure.cleanup = cleanup; failure.cleanupVerified = true; }
    throw failure;
  }
  const handle = Object.freeze(Object.assign(Object.create(null), {
    id: state.id, kind: 'process-owned-native-image-manifest-observation'
  }));
  observations.set(handle, { binding, released: false, description: deepFreeze({ ...description, cleanup }) });
  return handle;
}

function ownedObservation(handle) {
  const state = observations.get(handle);
  insist(state, 'INVALID_HANDLE');
  return state;
}

export function describeNativeImageManifestObservation(handle) {
  insist(arguments.length === 1, 'INVALID_ARGUMENT');
  const state = ownedObservation(handle);
  return deepFreeze({ ...state.description, status: state.released ? 'released' : 'observed',
    originalImageHandleRetained: !state.released });
}

export async function assertNativeImageManifestObservation(handle, options) {
  insist(arguments.length === 2, 'INVALID_ARGUMENT');
  explicitOptions(options, ['client', 'imageHandle'], ['client', 'imageHandle']);
  const state = ownedObservation(handle);
  insist(!state.released, 'OBSERVATION_RELEASED');
  insist(options.client === state.binding.client && options.imageHandle === state.binding.handle,
    'OWNERSHIP_MISMATCH');
  await assertActiveNativeImageAuthority(state.binding)
    .catch(() => { throw new NativeImageManifestError('NATIVE_IMAGE_UNTRUSTED'); });
  insist(!state.released, 'OBSERVATION_RELEASED');
  return describeNativeImageManifestObservation(handle);
}

export async function releaseNativeImageManifestObservation(handle) {
  insist(arguments.length === 1, 'INVALID_ARGUMENT');
  const state = ownedObservation(handle);
  state.released = true;
  state.binding = null;
  return deepFreeze({ observationId: handle.id, released: true, ...state.description.cleanup });
}
