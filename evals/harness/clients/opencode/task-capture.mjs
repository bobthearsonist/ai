import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT, TASK_CAPS, insist, record, relativePath, sha256 } from './case-spec.mjs';

export function captureNativeFiles(payload, { artifactRoot = PROJECT } = {}) {
  record(payload, ['protocol', 'executionId', 'inventory']);
  insist(payload.protocol === 1 && /^[a-f0-9-]{36}$/.test(payload.executionId) &&
    Array.isArray(payload.inventory) && payload.inventory.length <= TASK_CAPS.targets,
  'Invalid trusted disk readback manifest', 'ARTIFACT_CAPTURE_FAILED');
  const root = path.resolve(artifactRoot);
  const targets = new Set();
  let totalBytes = 0;
  const artifacts = payload.inventory.map(entry => {
    record(entry, entry.state === 'present'
      ? ['target', 'state', 'regularFile', 'bytes', 'sha256'] : ['target', 'state']);
    const target = relativePath(entry.target);
    insist(target === entry.target && !targets.has(target.toLowerCase()) &&
      ['present', 'missing'].includes(entry.state), 'Invalid disk readback target', 'ARTIFACT_CAPTURE_FAILED');
    targets.add(target.toLowerCase());
    const filename = path.join(root, ...target.split('/'));
    let current = path.parse(filename).root;
    let stat;
    for (const part of filename.slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      try { stat = fs.lstatSync(current); }
      catch (error) {
        if (error.code === 'ENOENT' && entry.state === 'missing') return { target, state: 'missing' };
        throw error;
      }
      insist(!stat.isSymbolicLink() && (current === filename
        ? stat.isFile() && stat.nlink === 1 : stat.isDirectory()),
      'Unsafe disk readback path', 'ARTIFACT_CAPTURE_FAILED');
    }
    insist(entry.state === 'present' && entry.regularFile === true && Number.isSafeInteger(entry.bytes) &&
      entry.bytes >= 0 && entry.bytes <= TASK_CAPS.artifactBytes && stat.size === entry.bytes &&
      /^[a-f0-9]{64}$/.test(entry.sha256), 'Disk readback inventory mismatch', 'ARTIFACT_CAPTURE_FAILED');
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let bytes;
    try {
      const opened = fs.fstatSync(fd);
      // Windows lstat reports dev=0 while fstat reports the volume; Linux readback binds both device and inode.
      insist(opened.isFile() && opened.nlink === 1 && opened.ino === stat.ino &&
        (process.platform === 'win32' || opened.dev === stat.dev) &&
        opened.size === entry.bytes, 'Disk readback file changed', 'ARTIFACT_CAPTURE_FAILED');
      bytes = fs.readFileSync(fd);
      insist(bytes.length === entry.bytes && sha256(bytes) === entry.sha256,
        'Disk readback bytes changed', 'ARTIFACT_CAPTURE_FAILED');
      fs.fchmodSync(fd, 0o444);
    } finally { fs.closeSync(fd); }
    totalBytes += bytes.length;
    insist(totalBytes <= TASK_CAPS.totalArtifactBytes, 'Combined disk readback byte cap exceeded', 'ARTIFACT_CAPTURE_FAILED');
    return { target, state: 'present', bytes: bytes.length, sha256: sha256(bytes), base64: bytes.toString('base64') };
  });
  return { protocol: 1, executionId: payload.executionId, source: 'trusted-native-filesystem', artifacts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      insist(bytes <= 16 * 1024, 'Disk readback manifest byte cap exceeded', 'ARTIFACT_CAPTURE_FAILED');
      chunks.push(chunk);
    }
    console.log(JSON.stringify(captureNativeFiles(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
  } catch {
    console.error(JSON.stringify({ error: { code: 'ARTIFACT_CAPTURE_FAILED',
      message: 'Trusted selected-file disk readback failed' } }));
    process.exitCode = 1;
  }
}
