import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { exportCandidate, hashContent, readJson, validateSnapshot, canonicalJson } from '../index.mjs';
import { deliveryPath, readZipEntries } from './zip.mjs';

const ownedRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '.work');
const handles = new WeakSet();
export const PACKAGING_TRACKED_PATHS = Object.freeze([
  'skills', 'agents', 'scripts/build-plugins.sh', 'scripts/build-desktop.sh'
]);

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function relativeFile(root, name) {
  deliveryPath(name);
  const filename = path.join(root, ...name.split('/'));
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(filename);
  requireThat(real === realRoot || real.startsWith(`${realRoot}${path.sep}`), `Escaping payload path ${name}`);
  return filename;
}

function inventory(root, prefix = '') {
  const files = new Map();
  const directories = new Set();
  if (!fs.existsSync(root)) return { files, directories };
  function visit(directory, relative) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${item.name}` : item.name;
      deliveryPath(name);
      const filename = path.join(directory, item.name);
      requireThat(!item.isSymbolicLink(), `Delivery symlink ${prefix}${name}`);
      if (item.isDirectory()) { directories.add(name); visit(filename, name); }
      else {
        requireThat(item.isFile(), `Unsupported delivery entry ${prefix}${name}`);
        files.set(name, fs.readFileSync(filename));
      }
    }
  }
  requireThat(!fs.lstatSync(root).isSymbolicLink(), `Delivery root symlink ${root}`);
  visit(root, '');
  return { files, directories };
}

function evalLeak(name) {
  return name.split('/').some(part => /^(evals?|\.work|fixtures?|answer[-_]keys?|results?(?:\.jsonl?|\.ndjson)?)$/i.test(part));
}

export function extractFrontmatter(text, field) {
  let active = false;
  let collecting = false;
  let result = '';
  for (const line of text.split('\n')) {
    if (/^---\s*$/.test(line)) {
      if (active) return collecting ? result : '';
      active = true;
      continue;
    }
    if (!active) continue;
    if (collecting) {
      if (/^\S/.test(line)) return result;
      const value = line.replace(/^\s+/, '');
      result += (result === '' ? '' : ' ') + value;
      continue;
    }
    const match = new RegExp(`^${field}\\s*:\\s*`).exec(line);
    if (!match) continue;
    const value = line.slice(match[0].length);
    if (/^[|>][+-]?\s*$/.test(value)) { collecting = true; continue; }
    return value.replace(/^["']|["']\s*$/g, '');
  }
  // awk only flushes a block scalar at a new key or closing fence.
  return '';
}

function shortDescription(value) {
  const normalized = value.replace(/[ \t\r\n\v\f]+/g, ' ').trim();
  const chars = Array.from(normalized);
  return chars.length <= 200 ? normalized : `${chars.slice(0, 197).join('')}...`;
}

function scriptConstant(text, name) {
  const match = new RegExp(`^${name}="([^"]*)"$`, 'm').exec(text);
  requireThat(match, `Unsupported generator: missing constant ${name}`);
  return match[1];
}

function parentDirectories(names) {
  const directories = new Set();
  for (const name of names) {
    const parts = name.split('/');
    while (parts.length > 1) { parts.pop(); directories.add(parts.join('/')); }
  }
  return directories;
}

export function inspectPackagingSource({ sourceDirectory, snapshot = readJson(path.join(sourceDirectory, 'snapshot.json')) }) {
  validateSnapshot(snapshot, sourceDirectory);
  const records = new Map(snapshot.files.map(file => [file.path, file]));
  const bytes = name => {
    requireThat(records.has(name), `Source not in export manifest: ${name}`);
    return fs.readFileSync(relativeFile(sourceDirectory, name));
  };
  const script = bytes('scripts/build-plugins.sh').toString('utf8');
  bytes('scripts/build-desktop.sh');
  const constants = Object.fromEntries(['REPO_URL', 'PLUGIN_VERSION', 'MARKETPLACE_NAME', 'MARKETPLACE_DESCRIPTION']
    .map(name => [name, scriptConstant(script, name)]));
  const plugins = new Map();
  const archives = new Map();
  const mapping = [];
  const skippedSkills = [];
  function addPlugin(name, description, payload, kind) {
    requireThat(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name), `Unsafe plugin name ${JSON.stringify(name)}`);
    requireThat(!plugins.has(name), `Source plugin name collision: ${name}`);
    const manifest = {
      $schema: 'https://anthropic.com/claude-code/plugin.schema.json',
      name, version: constants.PLUGIN_VERSION, author: { name: 'Profisee' },
      repository: constants.REPO_URL, license: 'UNLICENSED', description
    };
    plugins.set(name, { name, description, kind, manifest, payload });
  }
  const skillNames = [...new Set([...records.keys()].filter(name => /^skills\/[^/]+\//.test(name))
    .map(name => name.split('/')[1]))].sort();
  for (const name of skillNames) {
    const prefix = `skills/${name}/`;
    if (!records.has(`${prefix}SKILL.md`)) { skippedSkills.push(name); continue; }
    const description = shortDescription(extractFrontmatter(bytes(`${prefix}SKILL.md`).toString('utf8'), 'description') || `${name} skill`);
    const hasMcp = records.has(`${prefix}.mcp.json`);
    const archive = new Map();
    for (const source of records.keys()) if (source.startsWith(prefix)) {
      requireThat(!evalLeak(source), `Evaluation data in source delivery tree: ${source}`);
      archive.set(`${name}/${source.slice(prefix.length)}`, bytes(source));
    }
    archives.set(`${name}.zip`, archive);
    for (const gateway of hasMcp ? [false, true] : [false]) {
      const plugin = `${name}${gateway ? '-gateway' : ''}`;
      const payload = new Map();
      for (const source of records.keys()) if (source.startsWith(prefix)) {
        const resource = source.slice(prefix.length);
        if (resource === '.mcp.json' && gateway) {
          mapping.push({ source, plugin, destination: null, transformation: 'gateway-remove-root-mcp' });
          continue;
        }
        const destination = resource === '.mcp.json' ? '.mcp.json' : `skills/${name}/${resource}`;
        payload.set(destination, bytes(source));
        mapping.push({ source, plugin, destination, transformation: resource === '.mcp.json' ? 'promote-root-mcp' : 'copy' });
      }
      const desc = gateway ? shortDescription(`Gateway variant of ${name} -- the skill only, no bundled MCP server. Use when the server already reaches Claude through an MCP gateway. ${description}`) : description;
      addPlugin(plugin, desc, payload, gateway ? 'gateway' : 'skill');
    }
  }
  for (const source of [...records.keys()].filter(name => name.startsWith('agents/') && name.endsWith('.md')).sort()) {
    requireThat(!evalLeak(source), `Evaluation data in agent source: ${source}`);
    const text = bytes(source).toString('utf8');
    const basename = path.posix.basename(source, '.md');
    const name = extractFrontmatter(text, 'name') ||
      (basename.toUpperCase() === 'AGENT' ? path.posix.basename(path.posix.dirname(source)) : basename);
    const description = shortDescription(extractFrontmatter(text, 'description') || `${name} agent`);
    const destination = `agents/${name}.md`;
    addPlugin(name, description, new Map([[destination, bytes(source)]]), 'agent');
    mapping.push({ source, plugin: name, destination, transformation: 'copy-rename-agent' });
  }
  requireThat(plugins.size > 0, 'Empty packaging source selection');
  const marketplace = {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name: constants.MARKETPLACE_NAME, description: constants.MARKETPLACE_DESCRIPTION,
    owner: { name: 'Profisee' },
    plugins: [...plugins.values()].map(({ name, description }) => ({ name, description, source: `./plugins/${name}` }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  };
  return {
    snapshotId: snapshot.snapshotId, plugins, archives, marketplace, mapping, skippedSkills,
    generators: ['scripts/build-plugins.sh', 'scripts/build-desktop.sh'].map(name => ({ path: name, sha256: records.get(name).sha256 }))
  };
}

function compareFiles(expected, actual, label, fail) {
  for (const [name, bytes] of expected) {
    if (!actual.has(name)) fail(`Missing ${label}: ${name}`);
    else if (!bytes.equals(actual.get(name))) fail(`Changed ${label}: ${name}`);
  }
  for (const name of actual.keys()) {
    if (evalLeak(name)) fail(`Evaluation data leaked into ${label}: ${name}`);
    if (!expected.has(name)) fail(`Unexpected ${label}: ${name}`);
  }
}

export function validatePackaging({ sourceDirectory, generatedDirectory = sourceDirectory, snapshot }) {
  const failures = [];
  const fail = message => failures.push(message);
  let source;
  try {
    source = inspectPackagingSource({ sourceDirectory, snapshot });
    const output = inventory(path.join(generatedDirectory, 'plugins'));
    const expected = new Map();
    for (const plugin of source.plugins.values()) {
      for (const [name, bytes] of plugin.payload) expected.set(`${plugin.name}/${name}`, bytes);
      const manifestPath = `${plugin.name}/.claude-plugin/plugin.json`;
      const manifest = output.files.get(manifestPath);
      requireThat(manifest, `Missing plugin manifest: ${manifestPath}`);
      if (canonicalJson(JSON.parse(manifest.toString('utf8'))) !== canonicalJson(plugin.manifest)) fail(`Plugin manifest mismatch: ${plugin.name}`);
      expected.set(manifestPath, manifest);
      if (plugin.kind === 'gateway') {
        for (const name of output.files.keys()) if (name.startsWith(`${plugin.name}/`) && path.posix.basename(name) === '.mcp.json') fail(`Gateway MCP config present: ${name}`);
      }
    }
    compareFiles(expected, output.files, 'plugin payload', fail);
    const expectedDirs = parentDirectories(expected.keys());
    for (const name of output.directories) if (!expectedDirs.has(name)) fail(`Unexpected plugin directory: ${name}`);
    const metadata = inventory(path.join(generatedDirectory, '.claude-plugin'));
    for (const name of metadata.files.keys()) if (name !== 'marketplace.json') fail(`Unexpected marketplace artifact: ${name}`);
    for (const name of metadata.directories) fail(`Unexpected marketplace directory: ${name}`);
    const marketplace = readJson(relativeFile(generatedDirectory, '.claude-plugin/marketplace.json'));
    if (canonicalJson(marketplace) !== canonicalJson(source.marketplace)) fail('Marketplace references/metadata mismatch');
    const bundles = inventory(path.join(generatedDirectory, 'desktop-bundles'));
    for (const [name, expectedEntries] of source.archives) {
      if (!bundles.files.has(name)) { fail(`Missing Desktop bundle: ${name}`); continue; }
      try {
        const entries = readZipEntries(bundles.files.get(name));
        const files = new Map([...entries].filter(([entry]) => !entry.endsWith('/')));
        compareFiles(expectedEntries, files, `Desktop ${name}`, fail);
        const dirs = parentDirectories(expectedEntries.keys());
        for (const entry of entries.keys()) if (entry.endsWith('/') && !dirs.has(entry.slice(0, -1))) fail(`Unexpected Desktop directory: ${entry}`);
      } catch (error) { fail(`${name}: ${error.message}`); }
    }
    for (const name of bundles.files.keys()) if (!source.archives.has(name)) fail(`Unexpected Desktop artifact: ${name}`);
    for (const name of bundles.directories) fail(`Unexpected Desktop output directory: ${name}`);
  } catch (error) { fail(error.message); }
  return {
    packagingVersion: 1, passed: failures.length === 0, exitCode: failures.length ? 1 : 0,
    snapshotId: source?.snapshotId ?? null,
    counts: source ? { plugins: source.plugins.size, desktopBundles: source.archives.size, mappedFiles: source.mapping.length } : null,
    generators: source?.generators ?? [], skippedSkills: source?.skippedSkills ?? [], failures
  };
}

export function createPackagingExport({ repo, untrackedPaths = [] }) {
  requireThat(untrackedPaths.every(name => /^(skills|agents)\//.test(name.replaceAll('\\', '/'))),
    'Explicit untracked packaging inputs must be source files under skills or agents');
  fs.mkdirSync(ownedRoot, { recursive: true });
  requireThat(fs.realpathSync(ownedRoot) === path.resolve(ownedRoot), 'Packaging work root must not redirect through symlinks');
  const directory = path.join(ownedRoot, `packaging-${randomUUID()}`);
  fs.mkdirSync(directory);
  let exported;
  try {
    exported = exportCandidate({ repo, trackedPaths: [...PACKAGING_TRACKED_PATHS], untrackedPaths });
    const sourceDirectory = path.join(directory, 'source');
    fs.renameSync(exported.directory, sourceDirectory);
    const handle = Object.freeze({ directory, sourceDirectory, snapshot: exported.snapshot });
    handles.add(handle);
    inspectPackagingSource(handle);
    return handle;
  } catch (error) {
    if (exported && fs.existsSync(exported.directory)) fs.rmSync(exported.directory, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function generatePackaging(handle, { image = 'profisee-evals-packaging:local', runtime = 'docker', bash = 'bash' } = {}) {
  requireThat(handles.has(handle), 'Generation requires an owned createPackagingExport handle');
  requireThat(!fs.existsSync(path.join(handle.sourceDirectory, '.git')), 'Generation cannot run in a checkout');
  validateSnapshot(handle.snapshot, handle.sourceDirectory);
  const scratch = path.join(handle.sourceDirectory, '.generator-temp');
  fs.mkdirSync(scratch, { recursive: true });
  const command = 'bash scripts/build-plugins.sh && bash scripts/build-desktop.sh';
  const options = { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] };
  let runtimeIdentity;
  if (runtime === 'docker') {
    const id = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], options).trim();
    requireThat(/^sha256:[a-f0-9]{64}$/.test(id), 'Invalid packaging image identity');
    runtimeIdentity = { runtime, image: id };
    const container = `profisee-${path.basename(handle.directory)}`;
    try {
      execFileSync('docker', ['run', '--name', container, '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '2',
        '--mount', `type=bind,source=${handle.sourceDirectory},target=/work`,
        '--workdir', '/work', '--env', 'TMPDIR=/work/.generator-temp', '--env', 'LC_ALL=C.UTF-8',
        id, 'bash', '-c', command], options);
    } finally {
      // Killing a timed-out Docker CLI does not necessarily stop its container.
      const removed = spawnSync('docker', ['rm', '--force', container], { ...options, timeout: 30000 });
      requireThat(removed.status === 0 || /No such container/i.test(removed.stderr ?? ''),
        `Cannot stop owned packaging container ${container}: ${removed.stderr ?? removed.error}`);
    }
  } else {
    requireThat(runtime === 'bash', 'Supported packaging runtimes: docker, bash');
    runtimeIdentity = { runtime, bash };
    execFileSync(bash, ['-c', command], {
      ...options, cwd: handle.sourceDirectory,
      env: { ...process.env, TMPDIR: scratch.replaceAll('\\', '/'), LC_ALL: 'C.UTF-8' }
    });
  }
  validateSnapshot(handle.snapshot, handle.sourceDirectory);
  fs.rmSync(scratch, { recursive: true, force: true });
  return runtimeIdentity;
}

export function cleanupPackaging(handle) {
  requireThat(handles.has(handle), 'Cleanup requires the exact owned packaging handle');
  requireThat(path.dirname(handle.directory) === ownedRoot && /^packaging-[a-f0-9-]+$/.test(path.basename(handle.directory)), 'Invalid owned packaging directory');
  fs.rmSync(handle.directory, { recursive: true, force: true });
  handles.delete(handle);
}

export function checkPackaging(options) {
  const handle = createPackagingExport(options);
  try {
    const runtime = generatePackaging(handle, options);
    const report = validatePackaging(handle);
    return { ...report, runtime, source: handle.snapshot.source, files: handle.snapshot.files };
  } finally { cleanupPackaging(handle); }
}
