import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deepFreeze, insist } from './errors.mjs';

const root = fileURLToPath(new URL('.owned/', import.meta.url));
const MAX_FILES = 4096;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const areas = Object.freeze(['runtime', 'inputs', 'settings']);
const seeds = new WeakMap();

export const CANDIDATE_PROFILES = deepFreeze({
  'claude-code': {
    runtime: '/opt/client', settings: '/probe', workdir: '/workspace',
    home: '/home/node', nativeStateRoot: '/home/node/.claude',
    writableRoots: ['/workspace', '/home/node', '/scratch'],
    environment: { HOME: '/home/node', CLAUDE_CONFIG_DIR: '/home/node/.claude', TMPDIR: '/scratch' }
  },
  copilot: {
    runtime: '/opt/fixture', settings: '/candidate-settings', workdir: '/workspace',
    home: '/home/eval', nativeStateRoot: '/client-config/copilot',
    writableRoots: ['/workspace', '/home/eval', '/client-config', '/scratch'],
    environment: {
      HOME: '/home/eval', COPILOT_HOME: '/client-config/copilot', TMPDIR: '/scratch',
      XDG_CONFIG_HOME: '/client-config/xdg-config', XDG_DATA_HOME: '/client-config/xdg-data',
      XDG_CACHE_HOME: '/client-config/xdg-cache', XDG_STATE_HOME: '/client-config/xdg-state'
    }
  },
  opencode: {
    runtime: '/opt/client', settings: '/candidate-settings', workdir: '/work/project',
    home: '/work/home', nativeStateRoot: '/work/data/opencode',
    writableRoots: ['/work'],
    environment: {
      HOME: '/work/home', XDG_CONFIG_HOME: '/work/config', XDG_DATA_HOME: '/work/data',
      XDG_CACHE_HOME: '/work/cache', XDG_STATE_HOME: '/work/state', TMPDIR: '/work/scratch'
    }
  }
});

function noLinks(filename) {
  let current = path.resolve(filename);
  while (true) {
    if (fs.existsSync(current)) insist(!fs.lstatSync(current).isSymbolicLink(), 'OWNERSHIP_MISMATCH');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function hashFile(filename, deadline) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filename, 'r');
  const bytes = Buffer.alloc(65536);
  try {
    let count;
    while ((count = fs.readSync(fd, bytes, 0, bytes.length, null)) > 0) {
      insist(Date.now() < deadline, 'TIMEOUT');
      hash.update(bytes.subarray(0, count));
    }
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function safeName(name) {
  insist(name.length >= 1 && name.length <= 255 && !/[\\/:=\x00-\x1f\x7f]/.test(name) &&
    name !== '.' && name !== '..' && !/[. ]$/.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name), 'CANDIDATE_SEED_INVALID');
}

export function createCandidateSeed(boundaryOwner, client) {
  insist(typeof boundaryOwner === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(boundaryOwner) &&
    typeof client === 'string' && Object.hasOwn(CANDIDATE_PROFILES, client), 'INVALID_ARGUMENT');
  const id = randomUUID();
  noLinks(root);
  fs.mkdirSync(root, { recursive: true });
  const directory = path.join(root, id);
  fs.mkdirSync(directory, { mode: 0o700 });
  const marker = JSON.stringify({ version: 1, id, boundaryOwner, client, nonce: randomUUID() });
  const markerFile = path.join(directory, '.candidate-owner.json');
  try {
    fs.writeFileSync(markerFile, marker, { flag: 'wx', mode: 0o444 });
    for (const area of areas) fs.mkdirSync(path.join(directory, area), { mode: 0o755 });
  } catch (error) {
    noLinks(directory);
    if (fs.existsSync(markerFile)) {
      const stat = fs.lstatSync(markerFile);
      insist(stat.isFile() && stat.nlink === 1 && stat.size <= 512 &&
        hashFile(markerFile, Date.now() + 10000) === createHash('sha256').update(marker).digest('hex'),
        'OWNERSHIP_MISMATCH');
      insist(fs.readdirSync(directory).every(name => name === '.candidate-owner.json' || areas.includes(name)),
        'OWNERSHIP_MISMATCH');
      for (const area of areas) {
        const target = path.join(directory, area);
        if (!fs.existsSync(target)) continue;
        const areaStat = fs.lstatSync(target);
        insist(areaStat.isDirectory() && !areaStat.isSymbolicLink() &&
          fs.readdirSync(target).length === 0, 'OWNERSHIP_MISMATCH');
        fs.rmdirSync(target);
      }
      fs.chmodSync(markerFile, 0o600);
      fs.unlinkSync(markerFile);
    }
    insist(fs.readdirSync(directory).length === 0, 'OWNERSHIP_MISMATCH');
    fs.rmdirSync(directory);
    throw error;
  }
  const state = {
    id, directory, markerHash: createHash('sha256').update(marker).digest('hex'),
    manifest: null, directories: null, destroyed: false
  };
  const handle = Object.freeze(Object.assign(Object.create(null), { id, directory }));
  seeds.set(handle, state);
  return handle;
}

function ownedSeed(handle) {
  const state = seeds.get(handle);
  insist(state, 'INVALID_HANDLE');
  return state;
}

export function assertCandidateSeedIdentity(handle) {
  const seed = ownedSeed(handle);
  if (seed.destroyed) {
    insist(!fs.existsSync(seed.directory), 'OWNERSHIP_MISMATCH');
    return;
  }
  noLinks(seed.directory);
  const markerFile = path.join(seed.directory, '.candidate-owner.json');
  const markerStat = fs.lstatSync(markerFile);
  insist(markerStat.isFile() && markerStat.nlink === 1 && markerStat.size <= 512 &&
    hashFile(markerFile, Date.now() + 10000) === seed.markerHash, 'OWNERSHIP_MISMATCH');
}

export function inspectCandidateSeed(handle, deadline) {
  const seed = ownedSeed(handle);
  assertCandidateSeedIdentity(handle);
  if (seed.destroyed) return null;
  insist(Number.isFinite(deadline) && Date.now() < deadline, 'TIMEOUT');
  const manifest = new Map();
  const directories = new Set(areas);
  let total = 0;
  function walk(directory, depth) {
    insist(depth <= 16 && Date.now() < deadline, depth > 16 ? 'CANDIDATE_SEED_INVALID' : 'TIMEOUT');
    const directoryStat = fs.lstatSync(directory);
    insist(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), 'CANDIDATE_SEED_INVALID');
    const stream = fs.opendirSync(directory);
    try {
      let entry;
      while ((entry = stream.readSync()) !== null) {
        safeName(entry.name);
        const filename = path.join(directory, entry.name);
        const relative = path.relative(seed.directory, filename);
        insist(relative.length <= 1024 && !entry.isSymbolicLink(), 'CANDIDATE_SEED_INVALID');
        if (entry.isDirectory()) {
          directories.add(relative);
          insist(directories.size <= MAX_FILES, 'CANDIDATE_SEED_INVALID');
          walk(filename, depth + 1);
        } else {
          const stat = fs.lstatSync(filename);
          insist(entry.isFile() && stat.nlink === 1 && stat.size <= MAX_FILE_BYTES, 'CANDIDATE_SEED_INVALID');
          total += stat.size;
          insist(total <= MAX_TOTAL_BYTES && manifest.size < MAX_FILES, 'CANDIDATE_SEED_INVALID');
          manifest.set(relative, { bytes: stat.size, hash: hashFile(filename, deadline) });
        }
      }
    } finally { stream.closeSync(); }
  }
  insist(fs.readdirSync(seed.directory).sort().join(',') === [...areas, '.candidate-owner.json'].sort().join(','),
    'CANDIDATE_SEED_INVALID');
  for (const area of areas) walk(path.join(seed.directory, area), 0);
  if (seed.manifest) {
    insist(JSON.stringify([...manifest.entries()].sort()) === JSON.stringify([...seed.manifest.entries()].sort()) &&
      JSON.stringify([...directories].sort()) === JSON.stringify([...seed.directories].sort()), 'OWNERSHIP_MISMATCH');
  }
  const hash = createHash('sha256').update(JSON.stringify([...manifest.entries()].sort())).digest('hex');
  return { manifest, directories, fileCount: manifest.size, bytes: total, aggregateHash: hash };
}

export function sealCandidateSeed(handle, deadline) {
  const seed = ownedSeed(handle);
  insist(!seed.destroyed && seed.manifest === null, 'CANDIDATE_STATE');
  const observed = inspectCandidateSeed(handle, deadline);
  seed.manifest = observed.manifest;
  seed.directories = observed.directories;
  return deepFreeze({ fileCount: observed.fileCount, bytes: observed.bytes, aggregateHash: observed.aggregateHash });
}

export function destroyCandidateSeed(handle, deadline) {
  const seed = ownedSeed(handle);
  const observed = inspectCandidateSeed(handle, deadline);
  if (seed.destroyed) return;
  for (const relative of observed.manifest.keys()) fs.chmodSync(path.join(seed.directory, relative), 0o600);
  fs.chmodSync(path.join(seed.directory, '.candidate-owner.json'), 0o600);
  fs.rmSync(seed.directory, { recursive: true, force: false });
  insist(!fs.existsSync(seed.directory), 'CLEANUP_FAILED');
  seed.destroyed = true;
}
