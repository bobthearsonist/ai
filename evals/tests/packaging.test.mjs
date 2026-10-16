import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { CONTRACT_VERSION, hashContent, snapshotIdentity } from '../harness/index.mjs';
import { inspectPackagingSource, validatePackaging, extractFrontmatter, createPackagingExport, cleanupPackaging, generatePackaging } from '../harness/packaging/index.mjs';
import { readZipEntries } from '../harness/packaging/zip.mjs';

const evalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profiseeRepo = process.env.PROFISEE_PACKAGING_REPO || path.resolve(evalRoot, '..', '..', 'profisee-ai');
const fixtureFile = process.env.PROFISEE_PACKAGING_FIXTURE || path.join(profiseeRepo, 'evals', 'packaging', 'fixtures.json');
const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
assert.equal(fixture.synthetic, true);

function write(root, name, bytes) {
  const filename = path.join(root, ...name.split('/'));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries, compressed = false) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name);
    const content = Buffer.from(value);
    const payload = compressed ? deflateRawSync(content) : content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(compressed ? 8 : 0, 10);
    central.writeUInt32LE(crc32(content), 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, filename);
    offset += local.length + filename.length + payload.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function setup(t) {
  const root = path.join(evalRoot, 'harness', 'packaging', '.work', `test-${randomUUID()}`);
  const sourceDirectory = path.join(root, 'source');
  const generatedDirectory = path.join(root, 'generated');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceFiles = {
    ...fixture.sourceFiles,
    'scripts/build-plugins.sh': Object.entries(fixture.constants).map(([key, value]) => `${key}="${value}"`).join('\n') + '\n',
    'scripts/build-desktop.sh': '# synthetic fixture; not executable generator evidence\n',
    'evals/packaging/answer-key.txt': 'synthetic private answer key\n',
    'evals/packaging/results.json': '{"synthetic":true}\n'
  };
  for (const [name, bytes] of Object.entries(sourceFiles)) write(sourceDirectory, name, bytes);
  const snapshot = {
    contractVersion: CONTRACT_VERSION, snapshotId: '',
    source: { repo: sourceDirectory, commit: 'a'.repeat(40), mode: 'working-tree', dirtyPaths: [], deletedPaths: [] },
    files: Object.entries(sourceFiles).sort(([a], [b]) => a.localeCompare(b)).map(([name, content]) => ({
      path: name, sha256: hashContent(content), bytes: Buffer.byteLength(content), origin: 'tracked', executable: false
    }))
  };
  snapshot.snapshotId = snapshotIdentity(snapshot);
  write(sourceDirectory, 'snapshot.json', JSON.stringify(snapshot));
  const marketplace = {
    $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
    name: fixture.constants.MARKETPLACE_NAME,
    description: fixture.constants.MARKETPLACE_DESCRIPTION,
    owner: { name: 'Profisee' },
    plugins: []
  };
  for (const [name, plugin] of Object.entries(fixture.expectedPlugins)) {
    for (const [destination, source] of Object.entries(plugin.files)) write(generatedDirectory, `plugins/${name}/${destination}`, sourceFiles[source]);
    write(generatedDirectory, `plugins/${name}/.claude-plugin/plugin.json`, JSON.stringify({
      $schema: 'https://anthropic.com/claude-code/plugin.schema.json',
      name, version: fixture.constants.PLUGIN_VERSION, author: { name: 'Profisee' },
      repository: fixture.constants.REPO_URL, license: 'UNLICENSED', description: plugin.description
    }));
    marketplace.plugins.push({ name, description: plugin.description, source: `./plugins/${name}` });
  }
  marketplace.plugins.sort((a, b) => a.name.localeCompare(b.name));
  write(generatedDirectory, '.claude-plugin/marketplace.json', JSON.stringify(marketplace));
  for (const [name, files] of Object.entries(fixture.expectedDesktop)) {
    write(generatedDirectory, `desktop-bundles/${name}`, zip(Object.entries(files).map(([destination, source]) => [destination, sourceFiles[source]]), true));
  }
  return { sourceDirectory, generatedDirectory, snapshot, sourceFiles };
}

test('independent synthetic answer key validates every delivery channel', t => {
  const context = setup(t);
  const report = validatePackaging(context);
  assert.deepEqual(report.failures, []);
  assert.equal(report.passed, true);
  assert.deepEqual(report.counts, { plugins: 5, desktopBundles: 1, mappedFiles: 11 });
  assert.deepEqual(report.skippedSkills, ['skipped']);
});

test('mapping accounts for resources, root MCP promotion, gateway removal and agent renaming', t => {
  const source = inspectPackagingSource(setup(t));
  assert(source.mapping.some(row => row.source.endsWith('detail.txt') && row.transformation === 'copy'));
  assert(source.mapping.some(row => row.plugin === 'sample' && row.destination === '.mcp.json' && row.transformation === 'promote-root-mcp'));
  assert(source.mapping.some(row => row.plugin === 'sample-gateway' && row.destination === null && row.transformation === 'gateway-remove-root-mcp'));
  assert(source.mapping.some(row => row.source === 'agents/fallback/AGENT.md' && row.destination === 'agents/fallback.md'));
});

const mutations = [
  ['missing copied resource', context => fs.unlinkSync(path.join(context.generatedDirectory, 'plugins', 'sample', 'skills', 'sample', 'references', 'detail.txt')), /Missing plugin payload/],
  ['changed resource bytes', context => write(context.generatedDirectory, 'plugins/sample/skills/sample/references/detail.txt', 'wrong bytes'), /Changed plugin payload/],
  ['leaked evaluation fixture', context => write(context.generatedDirectory, 'plugins/sample/evals/fixture.json', '{}'), /Evaluation data leaked/],
  ['leaked private bytes under innocent name', context => write(context.generatedDirectory, 'plugins/sample/skills/sample/references/detail.txt', context.sourceFiles['evals/packaging/answer-key.txt']), /Changed plugin payload/],
  ['gateway root MCP leak', context => write(context.generatedDirectory, 'plugins/sample-gateway/.mcp.json', '{}'), /Gateway MCP config present/],
  ['MCP not promoted', context => {
    fs.unlinkSync(path.join(context.generatedDirectory, 'plugins', 'sample', '.mcp.json'));
    write(context.generatedDirectory, 'plugins/sample/skills/sample/.mcp.json', context.sourceFiles['skills/sample/.mcp.json']);
  }, /Missing plugin payload/],
  ['wrong renamed agent', context => write(context.generatedDirectory, 'plugins/helper/agents/helper.md', 'wrong agent'), /Changed plugin payload/],
  ['manifest mismatch', context => write(context.generatedDirectory, 'plugins/helper/.claude-plugin/plugin.json', '{"name":"wrong"}'), /Plugin manifest mismatch/],
  ['missing manifest', context => fs.unlinkSync(path.join(context.generatedDirectory, 'plugins', 'plain', '.claude-plugin', 'plugin.json')), /Missing plugin manifest/],
  ['wrong marketplace reference', context => {
    const filename = path.join(context.generatedDirectory, '.claude-plugin', 'marketplace.json');
    const document = JSON.parse(fs.readFileSync(filename));
    document.plugins[0].source = '../outside';
    fs.writeFileSync(filename, JSON.stringify(document));
  }, /Marketplace references/],
  ['extra plugin directory', context => fs.mkdirSync(path.join(context.generatedDirectory, 'plugins', 'leaked-empty')), /Unexpected plugin directory/],
  ['missing Desktop resource', context => write(context.generatedDirectory, 'desktop-bundles/sample.zip', zip([
    ['sample/SKILL.md', context.sourceFiles['skills/sample/SKILL.md']]
  ])), /Missing Desktop/],
  ['Desktop eval data', context => {
    const entries = Object.entries(fixture.expectedDesktop['sample.zip']).map(([destination, source]) => [destination, context.sourceFiles[source]]);
    entries.push(['sample/evals/results.json', '{}']);
    write(context.generatedDirectory, 'desktop-bundles/sample.zip', zip(entries));
  }, /Evaluation data leaked/],
  ['unexpected Desktop artifact', context => write(context.generatedDirectory, 'desktop-bundles/results.json', '{}'), /Unexpected Desktop artifact/],
  ['marketplace eval data', context => write(context.generatedDirectory, '.claude-plugin/results.json', '{}'), /Unexpected marketplace artifact/],
  ['source modified after snapshot', context => write(context.sourceDirectory, 'skills/sample/SKILL.md', 'changed'), /Snapshot file mismatch/]
];
for (const [name, mutate, expected] of mutations) test(`mutation rejects ${name}`, t => {
  const context = setup(t);
  mutate(context);
  const report = validatePackaging(context);
  assert.equal(report.passed, false);
  assert(report.failures.some(message => expected.test(message)), report.failures.join('\n'));
});

test('evaluation data in source skill is rejected even if a generator would copy it', t => {
  const context = setup(t);
  const name = 'skills/sample/evals/answer-key.json';
  const bytes = '{}';
  write(context.sourceDirectory, name, bytes);
  context.snapshot.files.push({ path: name, sha256: hashContent(bytes), bytes: 2, origin: 'untracked', executable: false });
  context.snapshot.snapshotId = snapshotIdentity(context.snapshot);
  assert.match(validatePackaging(context).failures.join('\n'), /Evaluation data in source delivery tree/);
});

test('colliding agent and skill plugin names fail instead of accepting generator overwrite', t => {
  const context = setup(t);
  const name = 'agents/sample.md';
  const bytes = '---\nname: sample\n---\nCollision.\n';
  write(context.sourceDirectory, name, bytes);
  context.snapshot.files.push({ path: name, sha256: hashContent(bytes), bytes: Buffer.byteLength(bytes), origin: 'untracked', executable: false });
  context.snapshot.snapshotId = snapshotIdentity(context.snapshot);
  assert.match(validatePackaging(context).failures.join('\n'), /name collision/);
});

test('ZIP reader rejects traversal, duplicate entries, invalid CRC and truncation', () => {
  assert.throws(() => readZipEntries(zip([['../escape', 'bad']])), /unsafe path/);
  assert.throws(() => readZipEntries(zip([['sample/a', 'one'], ['sample/a', 'two']])), /duplicate entry/);
  const broken = zip([['sample/a', 'data']]);
  broken[30 + Buffer.byteLength('sample/a')] ^= 1;
  assert.throws(() => readZipEntries(broken), /CRC mismatch/);
  assert.throws(() => readZipEntries(broken.subarray(0, 10)), /missing end record/);
});

test('frontmatter follows block scalars, quotes and documented fallback behavior', () => {
  assert.equal(extractFrontmatter('---\ndescription: "quoted"\n---\n', 'description'), 'quoted');
  assert.equal(extractFrontmatter('---\ndescription: |-\n  first\n  second\nother: end\n---\n', 'description'), 'first second');
  assert.equal(extractFrontmatter('---\ndescription: >\n  unfinished\n', 'description'), '');
  assert.equal(extractFrontmatter('No frontmatter\n', 'name'), '');
});

test('generation and cleanup reject arbitrary directories without an owned handle', () => {
  assert.throws(() => generatePackaging({ sourceDirectory: profiseeRepo }), /owned/);
  assert.throws(() => cleanupPackaging({ directory: profiseeRepo }), /owned/);
});

test('CLI rejects unknown flags without invoking any generator', () => {
  assert.throws(() => execFileSync(process.execPath, [
    path.join(evalRoot, 'harness', 'packaging', 'cli.mjs'), 'check', '--repo', profiseeRepo, '--keep', 'yes'
  ], { stdio: 'pipe' }), error => error.status === 1 && /Unknown/.test(error.stderr.toString()));
});

test('static CLI succeeds without generator tools and exits nonzero for missing resources', t => {
  const context = setup(t);
  const args = [path.join(evalRoot, 'harness', 'packaging', 'cli.mjs'), 'validate',
    '--source', context.sourceDirectory, '--generated', context.generatedDirectory];
  const report = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
  assert.equal(report.passed, true);
  fs.unlinkSync(path.join(context.generatedDirectory, 'plugins', 'sample', 'skills', 'sample', 'references', 'detail.txt'));
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }),
    error => error.status === 1 && JSON.parse(error.stdout.toString()).passed === false);
});

test('real read-only export selects tracked current bytes and excludes unrelated untracked source', {
  skip: !fs.existsSync(path.join(profiseeRepo, '.git'))
}, () => {
  const statusArgs = ['-C', profiseeRepo, 'status', '--porcelain', '--untracked-files=all', '--',
    'skills', 'agents', 'scripts', 'plugins', '.claude-plugin', 'desktop-bundles', 'docs'];
  const statusBefore = execFileSync('git', statusArgs, { encoding: 'utf8' });
  const handle = createPackagingExport({ repo: profiseeRepo });
  try {
    assert(handle.snapshot.files.some(record => record.path === 'scripts/build-plugins.sh'));
    assert(handle.snapshot.files.every(record => record.origin === 'tracked'));
    assert(!handle.snapshot.files.some(record => record.path.startsWith('evals/') || record.path.startsWith('docs/')));
    for (const record of handle.snapshot.files) {
      assert.equal(record.sha256, hashContent(fs.readFileSync(path.join(profiseeRepo, ...record.path.split('/')))));
    }
  } finally { cleanupPackaging(handle); }
  assert.equal(execFileSync('git', statusArgs, { encoding: 'utf8' }), statusBefore);
});

test('packaging export includes tracked dirty bytes and only explicitly selected untracked resources', {
  skip: !fs.existsSync(path.join(profiseeRepo, '.git'))
}, t => {
  const root = path.join(evalRoot, 'harness', 'packaging', '.work', `test-${randomUUID()}`);
  fs.mkdirSync(root, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  const commit = execFileSync('git', ['-C', profiseeRepo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const objectPath = execFileSync('git', ['-C', profiseeRepo, 'rev-parse', '--git-path', 'objects'], { encoding: 'utf8' }).trim();
  write(root, '.git/objects/info/alternates', `${path.resolve(profiseeRepo, objectPath).replaceAll('\\', '/')}\n`);
  write(root, '.git/HEAD', `${commit}\n`);
  git('read-tree', commit);
  // Only materialize the reviewed selection; the borrowed commit remains read-only.
  const selected = execFileSync('git', ['-C', profiseeRepo, 'ls-files', '-z', '--',
    'skills', 'agents', 'scripts/build-plugins.sh', 'scripts/build-desktop.sh'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const name of selected) write(root, name, fs.readFileSync(path.join(profiseeRepo, ...name.split('/'))));
  const dirtySkill = selected.find(name => name.endsWith('/SKILL.md'));
  const dirtyBytes = fs.readFileSync(path.join(root, ...dirtySkill.split('/')), 'utf8') + '\nSynthetic dirty edit.\n';
  write(root, dirtySkill, dirtyBytes);
  const selectedResource = `${path.posix.dirname(dirtySkill)}/references/selected-synthetic.txt`;
  write(root, selectedResource, 'explicitly selected synthetic resource\n');
  write(root, `${path.posix.dirname(dirtySkill)}/unselected.txt`, 'must not export\n');
  write(root, 'skills/unselected-synthetic/SKILL.md', 'must not export\n');
  write(root, 'docs/unrelated.txt', 'must not export\n');
  const handle = createPackagingExport({ repo: root, untrackedPaths: [selectedResource] });
  try {
    assert(handle.snapshot.source.dirtyPaths.includes(dirtySkill));
    assert.equal(handle.snapshot.files.find(record => record.path === dirtySkill).sha256, hashContent(dirtyBytes));
    assert.deepEqual(handle.snapshot.files.filter(record => record.origin === 'untracked').map(record => record.path), [selectedResource]);
    assert(!handle.snapshot.files.some(record => record.path.includes('unselected') || record.path.startsWith('docs/')));
    assert.equal(fs.readFileSync(path.join(root, ...dirtySkill.split('/')), 'utf8'), dirtyBytes);
  } finally { cleanupPackaging(handle); }
});

test('actual existing generators pass, then real payload/archive mutations fail offline', {
  skip: process.env.PROFISEE_PACKAGING_GENERATE !== '1'
}, () => {
  const handle = createPackagingExport({ repo: profiseeRepo });
  try {
    generatePackaging(handle, { runtime: 'docker', image: process.env.PROFISEE_PACKAGING_IMAGE || 'profisee-evals-packaging:local' });
    assert.deepEqual(validatePackaging(handle).failures, []);
    const source = inspectPackagingSource(handle);
    const resource = source.mapping.find(row => row.transformation === 'copy' && !row.destination.endsWith('SKILL.md'));
    assert(resource, 'Real repository must have at least one bundled resource');
    const filename = path.join(handle.sourceDirectory, 'plugins', resource.plugin, ...resource.destination.split('/'));
    const original = fs.readFileSync(filename);
    fs.unlinkSync(filename);
    assert.match(validatePackaging(handle).failures.join('\n'), /Missing plugin payload/);
    fs.writeFileSync(filename, original);
    const leaked = `plugins/${resource.plugin}/evals/results.json`;
    write(handle.sourceDirectory, leaked, '{"syntheticPrivate":true}');
    assert.match(validatePackaging(handle).failures.join('\n'), /Evaluation data leaked/);
    fs.unlinkSync(path.join(handle.sourceDirectory, ...leaked.split('/')));
    fs.rmdirSync(path.join(handle.sourceDirectory, 'plugins', resource.plugin, 'evals'));
    const archive = [...source.archives.keys()][0];
    const archivePath = path.join(handle.sourceDirectory, 'desktop-bundles', archive);
    const originalArchive = fs.readFileSync(archivePath);
    const entries = [...readZipEntries(originalArchive)];
    entries.push([`${archive.slice(0, -4)}/evals/answer-key.json`, Buffer.from('{}')]);
    fs.writeFileSync(archivePath, zip(entries, true));
    assert.match(validatePackaging(handle).failures.join('\n'), /Evaluation data leaked/);
    fs.writeFileSync(archivePath, originalArchive);
    assert.equal(validatePackaging(handle).passed, true);
  } finally { cleanupPackaging(handle); }
});
