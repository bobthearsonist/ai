import fs from 'node:fs';
import path from 'node:path';
import { ContractError, hashContent, hashObject, resolveContained, validateDocument } from '../index.mjs';

const captures = new WeakMap();
const ioErrors = new Set(['EACCES', 'EPERM', 'EIO', 'ENOENT', 'ENOTDIR', 'ELOOP', 'EMFILE', 'ENFILE', 'EBUSY']);

function requireThat(condition, message) {
  if (!condition) throw new ContractError(message);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function artifactTarget(target) {
  const segments = target.split(/[/\\]/);
  requireThat(segments.every(segment =>
    segment.length > 0 && segment !== '.' && segment !== '..' &&
    !/[<>:"|?*\x00-\x1f\x7f]/.test(segment) && !/[. ]$/.test(segment) &&
    !/^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(segment)
  ), `Ambiguous or non-relative artifact target: ${target}`);
  return segments.join('/');
}

/** Validate a whole declaration list before any filesystem access. */
export function validateChecks(checks) {
  requireThat(Array.isArray(checks), 'Checks must be an array');
  const ids = new Set();
  const targets = new Map();
  const copy = checks.map(check => {
    validateDocument('check', check);
    requireThat(!ids.has(check.id), `Duplicate check ID: ${check.id}`);
    ids.add(check.id);
    requireThat(typeof check.expected !== 'number' || Number.isFinite(check.expected), 'Expected must be finite');
    if (check.type.startsWith('artifact-')) {
      const target = artifactTarget(check.target);
      const alias = target.toLowerCase();
      requireThat(!targets.has(alias) || targets.get(alias) === check.target, `Ambiguous target alias: ${check.target}`);
      targets.set(alias, check.target);
      if (check.type === 'artifact-exists') {
        requireThat(typeof check.expected === 'boolean', 'artifact-exists expects a boolean');
      } else {
        requireThat(typeof check.expected === 'string' && check.expected.length > 0,
          'Artifact content checks expect a nonempty literal string');
      }
    }
    return { ...check };
  });
  return freeze(copy);
}

function inspectTarget(root, target) {
  let filename = root;
  const segments = artifactTarget(target).split('/');
  for (let index = 0; index < segments.length; index++) {
    filename = path.join(filename, segments[index]);
    let stat;
    try { stat = fs.lstatSync(filename, { bigint: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return { state: 'missing' };
      throw error;
    }
    requireThat(!stat.isSymbolicLink(), `Symlink artifact target is unsupported: ${target}`);
    requireThat(index === segments.length - 1 ? stat.isFile() : stat.isDirectory(),
      `Nonfile or nondirectory artifact target: ${target}`);
  }
  return { state: 'present', filename: resolveContained(root, target) };
}

function sameFile(first, second, pathname = false) {
  // Windows pathname stat can report dev=0 while descriptor stat reports the volume ID.
  const keys = pathname && process.platform === 'win32'
    ? ['ino', 'size', 'mtimeNs', 'ctimeNs']
    : ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
  return keys.every(key => first[key] === second[key]);
}

function captureTarget(root, target) {
  try {
    const inspected = inspectTarget(root, target);
    if (inspected.state === 'missing') return { target, state: 'missing' };
    const fd = fs.openSync(inspected.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      requireThat(before.isFile(), `Expected regular file: ${target}`);
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd, { bigint: true });
      const current = inspectTarget(root, target);
      requireThat(current.state === 'present' && sameFile(before, after) &&
        sameFile(after, fs.statSync(current.filename, { bigint: true }), true) &&
        BigInt(bytes.length) === after.size, `Artifact changed during capture: ${target}`);
      return { target, state: 'present', sha256: hashContent(bytes), bytes: bytes.length, base64: bytes.toString('base64') };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (!(error instanceof ContractError) && !ioErrors.has(error.code)) throw error;
    return { target, state: 'error', reason: error instanceof ContractError ? error.message : `Artifact read failed (${error.code}): ${target}` };
  }
}

function checkedBytes(entry) {
  const bytes = Buffer.from(entry.base64, 'base64');
  requireThat(bytes.length === entry.bytes && hashContent(bytes) === entry.sha256, `Captured artifact integrity mismatch: ${entry.target}`);
  return bytes;
}

function getCapture(capture) {
  requireThat(captures.has(capture), 'Expected an original trusted in-process artifact capture');
  return captures.get(capture);
}

/**
 * Capture only declared artifacts. The public handle contains no mutable byte storage;
 * private base64 strings retain exact bytes independently of later filesystem changes.
 */
export function captureArtifacts({ artifactRoot, checks }) {
  const declarations = validateChecks(checks);
  const root = fs.realpathSync(artifactRoot);
  requireThat(fs.statSync(root).isDirectory(), 'Artifact root must be a directory');
  const entries = new Map();
  for (const check of declarations) {
    if (check.type.startsWith('artifact-') && !entries.has(check.target)) {
      entries.set(check.target, freeze(captureTarget(root, check.target)));
    }
  }
  const artifacts = [...entries.values()].map(({ base64, ...record }) => record);
  const declarationsHash = hashObject(declarations);
  const captureId = hashObject({ declarationsHash, artifacts });
  const handle = freeze({ captureId, declarationsHash, artifacts });
  captures.set(handle, { declarations, entries });
  return handle;
}

/** Return a fresh byte copy, never the storage used by grading. */
export function readCapturedArtifact(capture, target) {
  const entry = getCapture(capture).entries.get(target);
  requireThat(entry?.state === 'present', `No captured file: ${target}`);
  return checkedBytes(entry);
}

export function gradeChecks({ checks, capture }) {
  const declarations = validateChecks(checks);
  const stored = getCapture(capture);
  requireThat(hashObject(declarations) === capture.declarationsHash, 'Declarations differ from captured checks');
  const evidence = [];
  const outcomes = stored.declarations.map(check => {
    let status;
    let reason;
    const entry = stored.entries.get(check.target);
    if (!check.type.startsWith('artifact-')) {
      status = 'error';
      reason = `Unsupported ${check.type}: no accepted trusted event or manual attestation adapter`;
    } else if (entry.state === 'error') {
      status = 'error';
      reason = entry.reason;
    } else if (entry.state === 'missing' && check.type !== 'artifact-exists') {
      status = 'error';
      reason = 'Content cannot be checked without captured file bytes';
    } else if (check.type === 'artifact-exists') {
      if (entry.state === 'present') checkedBytes(entry);
      status = (entry.state === 'present') === check.expected ? 'passed' : 'failed';
    } else {
      const contains = checkedBytes(entry).includes(Buffer.from(check.expected, 'utf8'));
      status = (check.type === 'artifact-contains' ? contains : !contains) ? 'passed' : 'failed';
    }
    const record = {
      captureId: capture.captureId, declarationsHash: capture.declarationsHash,
      checkId: check.id, target: check.target, status,
      ...(check.type.startsWith('artifact-') ? { artifact: capture.artifacts.find(artifact => artifact.target === check.target) } : {}),
      ...(reason ? { reason } : {})
    };
    const ref = `artifact-check:sha256:${hashObject(record)}`;
    evidence.push({ ref, ...record });
    return { id: check.id, class: check.class, status, evidence: ref };
  });
  return freeze({ checks: outcomes, evidence: { captureId: capture.captureId, records: evidence } });
}

export function executeChecks({ artifactRoot, checks }) {
  const capture = captureArtifacts({ artifactRoot, checks });
  return gradeChecks({ checks, capture });
}
