import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CONTRACT_VERSION, ContractError, canonicalJson, hashContent, hashObject } from '../index.mjs';
import { validatePackaging, inspectPackagingSource } from '../packaging/index.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '.work');
const overlays = new WeakMap();
const runtimeHandles = new WeakSet();
export const NATIVE_VERSION = '2.1.291';
export const NATIVE_LIMITS = Object.freeze({ repeats: 3, maxTurns: 6, timeoutSeconds: 90, maxCostUsd: 5, wallTimeoutSeconds: 1800 });
export const NATIVE_NORMALIZATION = Object.freeze({
  supported: false,
  reason: 'Official documentation gives schemaVersion=1 and summary/error fields, but no complete pinned deterministic per-repeat evidence schema.'
});
export const NATIVE_EXECUTION = Object.freeze({
  supported: false,
  reason: 'native evaluator may use AI grading; deterministic delivery preflight only'
});
const settings = Object.freeze({ disableAllHooks: true });
const flags = ['--eval-dir', '--json', '--runs', '--model', '--ablation', '--concurrency',
  '--mocks', '--no-scaffold', '--no-publish', '--max-cost-usd', '--output-dir'];

function check(value, message) {
  if (!value) throw new ContractError(message);
}

function exactKeys(value, keys, label) {
  check(value && typeof value === 'object' && !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort()), `Invalid ${label} fields`);
}

function plainRoot(directory) {
  const absolute = path.resolve(directory);
  let cursor = absolute;
  while (true) {
    if (fs.existsSync(cursor)) check(!fs.lstatSync(cursor).isSymbolicLink(), `Symlink ancestor: ${cursor}`);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  check(fs.realpathSync(absolute).toLowerCase() === absolute.toLowerCase(), 'Redirected native root');
  return absolute;
}

function safeName(name) {
  check(typeof name === 'string' && name.length <= 240 && name.split('/').every(part =>
    /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'), `Unsafe native path: ${name}`);
}

function inventory(directory) {
  const absolute = plainRoot(directory);
  const files = new Map();
  files.directories = [];
  let total = 0;
  let entries = 0;
  function visit(current, prefix, depth) {
    check(depth <= 12, 'Native tree depth exceeded');
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      check(++entries <= 256, 'Native entry limit exceeded');
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      safeName(name);
      const filename = path.join(current, item.name);
      const stat = fs.lstatSync(filename);
      check(!stat.isSymbolicLink(), `Native symlink: ${name}`);
      if (stat.isDirectory()) {
        files.directories.push(name);
        visit(filename, name, depth + 1);
      }
      else {
        check(stat.isFile() && stat.size <= 128 * 1024, `Unsupported or oversized native file: ${name}`);
        total += stat.size;
        check(total <= 2 * 1024 * 1024, 'Native byte limit exceeded');
        files.set(name, fs.readFileSync(filename));
      }
    }
  }
  visit(absolute, '', 0);
  return files;
}

function identity(files) {
  return hashObject({ files: [...files].map(([name, bytes]) => ({ path: name, sha256: hashContent(bytes) })),
    directories: files.directories ?? [] });
}

function persist(directory, name, bytes) {
  safeName(name);
  const filename = path.join(directory, ...name.split('/'));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes, { flag: 'wx' });
}

/** Executes only version/help queries; never evaluates a plugin. */
export function inspectNativeRuntime({ executable }) {
  const real = path.resolve(executable);
  plainRoot(path.dirname(real));
  check(fs.lstatSync(real).isFile() && !fs.lstatSync(real).isSymbolicLink(), 'Expected regular native executable');
  const options = { encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  const executableHash = hashContent(fs.readFileSync(real));
  const version = execFileSync(real, ['--version'], options).trim();
  check(version === `${NATIVE_VERSION} (Claude Code)`, `Expected Claude ${NATIVE_VERSION}; observed ${version}`);
  const generalHelp = execFileSync(real, ['--help'], options);
  const evalHelp = execFileSync(real, ['plugin', 'eval', '--help'], options);
  check(flags.every(flag => evalHelp.includes(flag)) && generalHelp.includes('--settings'), 'Required native flags unavailable');
  check(executableHash === hashContent(fs.readFileSync(real)), 'Native executable changed during help capture');
  const handle = Object.freeze({ executable: real, version: NATIVE_VERSION, executableHash,
    generalHelpHash: hashContent(generalHelp), evalHelpHash: hashContent(evalHelp) });
  runtimeHandles.add(handle);
  return handle;
}

export function loadNativeSuite({ directory }) {
  const files = inventory(directory);
  check(files.has('suite.json'), 'Missing native suite.json');
  const suite = JSON.parse(files.get('suite.json'));
  exactKeys(suite, ['version', 'synthetic', 'plugin', 'cases', 'resources', 'mockServers', 'description'], 'suite');
  check(suite.version === 1 && suite.synthetic === true && suite.plugin === 'windows-powershell-patterns', 'Unsupported native suite');
  check(canonicalJson(suite.cases) === canonicalJson(['text-discovery', 'bundled-resource']) &&
    canonicalJson(suite.resources) === canonicalJson(['skills/windows-powershell-patterns/SKILL.md']) &&
    canonicalJson(suite.mockServers) === '["native-text-fixture"]', 'Unsupported cases/resources/mock servers');
  check(files.size === 4, 'Unexpected native suite data or fixtures');
  check(canonicalJson(files.directories) === canonicalJson([
    'bundled-resource', 'mocks', 'mocks/native-text-fixture', 'text-discovery'
  ]), 'Unexpected native suite directories');
  const mock = files.get('mocks/native-text-fixture/explain.md');
  check(mock?.toString('utf8').replaceAll('\r\n', '\n') ===
    '---\ntype: fixed\nexpect:\n  subject: [PowerShell]\n---\nSynthetic text-only fixture: cmdlets return objects. No service was contacted.\n',
  'Unknown/agent/live mock definition');
  for (const id of suite.cases) {
    const bytes = files.get(`${id}/case.yaml`);
    check(bytes, `Missing native case ${id}`);
    // JSON is a YAML 1.2 subset; restrict authored files to this unambiguous subset.
    const item = JSON.parse(bytes);
    exactKeys(item, ['schema_version', 'name', 'runs', 'execution', 'graders'], 'native case');
    exactKeys(item.execution, ['prompt', 'max_turns', 'timeout_seconds', 'allowed_tools'], 'native execution');
    check(item.schema_version === '1.1' && item.name === id && item.runs === 3 &&
      item.execution.max_turns === NATIVE_LIMITS.maxTurns && item.execution.timeout_seconds === NATIVE_LIMITS.timeoutSeconds,
    'Native run limits differ from pinned limits');
    check(canonicalJson(item.execution.allowed_tools) === canonicalJson(['Skill', 'Read', 'Glob', 'Grep']) &&
      typeof item.execution.prompt === 'string' && item.execution.prompt.length <= 4096, 'Unsafe native execution');
    check(Array.isArray(item.graders) && item.graders.length >= 4 && item.graders.length <= 8, 'Missing native hard checks');
    const names = new Set();
    for (const grader of item.graders) {
      check(!names.has(grader.name), 'Duplicate native grader');
      names.add(grader.name);
      if (grader.type === 'tool_used') {
        check(['Skill', 'Read', 'Bash', 'PowerShell'].includes(grader.tool), 'Unsupported native tool grader');
        if (['Bash', 'PowerShell'].includes(grader.tool)) {
          exactKeys(grader, ['name', 'type', 'tool', 'min', 'max'], 'denial grader');
          check(grader.min === 0 && grader.max === 0, 'Shell grader must deny execution');
        } else {
          exactKeys(grader, ['name', 'type', 'tool', 'input_match'], 'discovery grader');
          check(typeof grader.input_match === 'string' && grader.input_match.length <= 512, 'Invalid discovery pattern');
        }
      } else {
        check(grader.type === 'regex', 'AI or unknown native grader forbidden');
        exactKeys(grader, grader.flags ? ['name', 'type', 'pattern', 'flags', 'target'] :
          ['name', 'type', 'pattern', 'target'], 'text grader');
        check(grader.target === 'last_message' && typeof grader.pattern === 'string' && grader.pattern.length <= 512 &&
          (!grader.flags || grader.flags === 'i'), 'Unsupported native regex');
      }
    }
    check(item.graders.some(g => g.name === 'namespaced-discovery' && g.type === 'tool_used' && g.tool === 'Skill' &&
      g.input_match === '"skill"\\s*:\\s*"windows-powershell-patterns:windows-powershell-patterns"') &&
      item.graders.some(g => g.tool === 'Bash') && item.graders.some(g => g.tool === 'PowerShell') &&
      item.graders.some(g => g.type === 'regex'), 'Missing per-repeat discovery/hard checks');
  }
  return Object.freeze({ suite, directory: path.resolve(directory), suiteHash: identity(files) });
}

function packagingPlugin(packaging) {
  const report = validatePackaging(packaging);
  check(report.passed, `Packaging preflight failed: ${report.failures.join('; ')}`);
  const source = inspectPackagingSource(packaging);
  const expected = source.plugins.get('windows-powershell-patterns');
  check(expected?.kind === 'skill', 'Expected source-owned PowerShell skill plugin');
  const directory = path.join(packaging.generatedDirectory ?? packaging.sourceDirectory, 'plugins', expected.name);
  const files = inventory(directory);
  // This selected plugin has no MCP declaration, hooks, agents, or executable resources.
  check(files.size === 2 && files.has('.claude-plugin/plugin.json') &&
    files.has('skills/windows-powershell-patterns/SKILL.md') &&
    canonicalJson(files.directories) === canonicalJson([
      '.claude-plugin', 'skills', 'skills/windows-powershell-patterns'
    ]), 'Unexpected code/MCP/config/resource in native plugin');
  return { files, snapshotId: source.snapshotId, pluginHash: identity(files) };
}

function approval(value, bindingHash, label) {
  exactKeys(value, ['bindingHash', 'approved', 'reviewType', 'reviewer', 'reviewedAt'], label);
  check(value.bindingHash === bindingHash && value.approved === true && value.reviewType === 'human' &&
    typeof value.reviewer === 'string' && value.reviewer.trim().length > 0 &&
    typeof value.reviewedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.reviewedAt) &&
    Number.isFinite(Date.parse(value.reviewedAt)), `Missing/stale ${label}`);
}

/** Produces review input only, never an approval. */
export function nativeBaselineBinding({ packaging }) {
  const plugin = packagingPlugin(packaging);
  return Object.freeze({ snapshotId: plugin.snapshotId, pluginHash: plugin.pluginHash });
}

export function createNativeOverlays({ candidate, baseline, baselineApproval, suiteDirectory }) {
  const loaded = loadNativeSuite({ directory: suiteDirectory });
  const selected = { candidate: packagingPlugin(candidate), baseline: packagingPlugin(baseline) };
  const baselineBinding = { snapshotId: selected.baseline.snapshotId, pluginHash: selected.baseline.pluginHash };
  approval(baselineApproval, hashObject(baselineBinding), 'baseline approval');
  fs.mkdirSync(root, { recursive: true });
  plainRoot(root);
  const directory = path.join(root, `native-${randomUUID()}`);
  fs.mkdirSync(directory);
  try {
    const arms = {};
    const suiteFiles = inventory(loaded.directory);
    check(identity(suiteFiles) === loaded.suiteHash, 'Suite changed during materialization');
    for (const arm of ['candidate', 'baseline']) {
      const armRoot = path.join(directory, arm);
      const pluginDirectory = path.join(armRoot, 'plugin');
      for (const [name, bytes] of selected[arm].files) persist(pluginDirectory, name, bytes);
      for (const [name, bytes] of suiteFiles) if (name !== 'suite.json') persist(pluginDirectory, `evals/${name}`, bytes);
      persist(armRoot, 'settings.json', canonicalJson(settings));
      arms[arm] = Object.freeze({ pluginDirectory, settingsPath: path.join(armRoot, 'settings.json'),
        snapshotId: selected[arm].snapshotId, pluginHash: selected[arm].pluginHash,
        overlayHash: identity(inventory(pluginDirectory)) });
    }
    const handle = Object.freeze({ id: path.basename(directory), directory, arms: Object.freeze(arms),
      suiteHash: loaded.suiteHash, mockHash: identity(new Map([...suiteFiles].filter(([name]) => name.startsWith('mocks/')))),
        baselineBinding: Object.freeze(baselineBinding) });
    overlays.set(handle, { inventoryHash: identity(inventory(directory)), baselineApprovalHash: hashObject(baselineApproval) });
    return handle;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function verifyNativeOverlays(handle) {
  check(overlays.has(handle), 'Expected owned native overlay handle');
  check(identity(inventory(handle.directory)) === overlays.get(handle).inventoryHash, 'Changed native overlay/resource/config or leaked fixture');
  return true;
}

function profileIdentity(profile) {
  exactKeys(profile, ['model', 'provider', 'mockMode'], 'native profile');
  check(profile.provider === 'native-client-auth' && profile.mockMode === 'record', 'Non-native auth/real MCP profiles forbidden');
  check(typeof profile.model === 'string' && /^claude-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(profile.model) &&
    !/latest|https?|gateway/.test(profile.model), 'Model must be an explicit full ID, not an alias/URL');
  return hashObject(profile);
}

/** Binds preflight inputs and paths for independent human review; never grants trust. */
export function prepareNativeReview({ overlays: handle, runtime, profile }) {
  verifyNativeOverlays(handle);
  check(runtimeHandles.has(runtime), 'Runtime must come from offline pinned help verification');
  check(runtime.executableHash === hashContent(fs.readFileSync(runtime.executable)), 'Stale native runtime');
  const profileHash = profileIdentity(profile);
  const review = {
    version: CONTRACT_VERSION, id: handle.id, directory: handle.directory, arms: handle.arms,
    baselineBinding: handle.baselineBinding, baselineApprovalHash: overlays.get(handle).baselineApprovalHash,
    suiteHash: handle.suiteHash, settingsHash: hashObject(settings), profileHash,
    mockMcpHash: hashObject({ declarations: [], mocksHash: handle.mockHash, mode: 'record', allowRealServers: false }),
    limitsHash: hashObject(NATIVE_LIMITS), runtime, profile: { ...profile }, limits: NATIVE_LIMITS
  };
  return Object.freeze({ review, bindingHash: hashObject(review) });
}

/** No validated deterministic-only native invocation is available. */
export function planNativeCommands({ overlays: handle, runtime, profile, trustApproval }) {
  const prepared = prepareNativeReview({ overlays: handle, runtime, profile });
  approval(trustApproval, prepared.bindingHash, 'trust approval');
  throw new ContractError(`Native execution unsupported: ${NATIVE_EXECUTION.reason}`);
}

export function normalizeNativeResult() {
  throw new ContractError(`Native normalization unsupported: ${NATIVE_NORMALIZATION.reason}`);
}

export function cleanupNativeOverlays(handle) {
  check(overlays.has(handle), 'Cleanup requires exact owned native handle');
  plainRoot(root);
  check(path.dirname(handle.directory) === root && /^native-[a-f0-9-]+$/.test(handle.id) &&
    path.basename(handle.directory) === handle.id, 'Invalid native cleanup ownership');
  plainRoot(handle.directory);
  // Refuse cleanup through descendant links, even if the overlay was mutated.
  inventory(handle.directory);
  fs.rmSync(handle.directory, { recursive: true, force: true });
  overlays.delete(handle);
}
