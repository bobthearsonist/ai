import Ajv from 'ajv';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolRoot = fileURLToPath(new URL('..', import.meta.url));
const schema = JSON.parse(fs.readFileSync(new URL('../schemas/contract.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: true, strictNumbers: true, allowUnionTypes: true });
ajv.addSchema(schema);
const validators = new Map();
export const CLIENTS = Object.freeze(['claude-code', 'opencode', 'copilot']);
export const CONTRACT_VERSION = 2;
export const POLICY = Object.freeze({ repeats: 3 });

export class ContractError extends Error {
  constructor(message, failureClass = 'infrastructure') {
    super(message);
    this.name = 'ContractError';
    this.failureClass = failureClass;
  }
}

function requireThat(condition, message, failureClass) {
  if (!condition) throw new ContractError(message, failureClass);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  requireThat(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)), 'Cannot hash undefined/nonfinite values');
  return JSON.stringify(value);
}

export function hashContent(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hashObject(value) {
  return hashContent(canonicalJson(value));
}

export function validateDocument(kind, document) {
  requireThat(Object.hasOwn(schema.definitions, kind), `Unknown schema: ${kind}`);
  if (!validators.has(kind)) validators.set(kind, ajv.compile({ $ref: `${schema.$id}#/definitions/${kind}` }));
  const validate = validators.get(kind);
  requireThat(validate(document), `Invalid ${kind}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
  return document;
}

export function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { throw new ContractError(`Cannot read JSON ${filename}: ${error.message}`); }
}

function unique(values, label) {
  requireThat(new Set(values).size === values.length, `Duplicate ${label}`);
}

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function relativePath(filename) {
  validateDocument('path', filename);
  requireThat(!filename.includes('\0'), 'NUL in path');
  const normalized = path.posix.normalize(filename.replaceAll('\\', '/'));
  requireThat(normalized !== '.', 'Expected non-root relative path');
  return normalized;
}

export function resolveContained(root, relative) {
  const normalized = relativePath(relative);
  const realRoot = fs.realpathSync(root);
  const filename = path.resolve(realRoot, ...normalized.split('/'));
  requireThat(inside(realRoot, filename), `Path escapes root: ${relative}`);
  const real = fs.realpathSync(filename);
  requireThat(inside(realRoot, real), `Symlink escapes root: ${relative}`);
  requireThat(fs.statSync(real).isFile(), `Expected file: ${relative}`);
  return real;
}

export function loadSuite(filename) {
  const absolute = path.resolve(filename);
  requireThat(!absolute.split(path.sep).includes('skills'), 'Suites must be outside distributed skills');
  const real = resolveContained(path.dirname(absolute), path.basename(absolute));
  requireThat(!real.split(path.sep).includes('skills'), 'Suite symlink points inside distributed skills');
  const suite = validateDocument('suite', readJson(real));
  unique(suite.cases.map(item => item.id), 'case IDs');
  unique(suite.context.dependencies.map(item => item.id), 'dependency IDs');
  const root = path.dirname(absolute);
  const files = [];
  const mounts = [];
  for (const dependency of suite.context.dependencies) {
    if (dependency.availability === 'provided') {
      requireThat(dependency.path && dependency.mount, `Provided dependency ${dependency.id} requires path and mount`);
      dependency.mountRoot ??= 'workspace';
      dependency.mount = relativePath(dependency.mount);
      const destination = dependency.mount.toLowerCase();
      const namespace = `${dependency.visibility}:${dependency.mountRoot}`;
      requireThat(!mounts.some(mount => mount.namespace === namespace &&
        (mount.destination === destination || mount.destination.startsWith(`${destination}/`) || destination.startsWith(`${mount.destination}/`))
      ), `Dependency mount collision: ${dependency.id} in ${namespace}`);
      mounts.push({ namespace, destination });
      const bytes = fs.readFileSync(resolveContained(root, dependency.path));
      files.push({ id: dependency.id, path: dependency.path, sha256: hashContent(bytes) });
    } else {
      requireThat(!dependency.path && !dependency.mount && !dependency.mountRoot, `Unavailable dependency ${dependency.id} must not declare a mount or mountRoot`);
    }
  }
  const fixtureHash = hashObject({ context: suite.context, files });
  const caseContracts = {};
  for (const item of suite.cases) {
    unique(item.hardChecks.map(check => check.id), `check IDs in ${item.id}`);
    for (const check of item.hardChecks) {
      if (check.type.startsWith('artifact-')) relativePath(check.target);
      requireThat(check.type !== 'artifact-exists' || typeof check.expected === 'boolean', 'artifact-exists expects a boolean');
      requireThat(!['artifact-contains', 'artifact-not-contains'].includes(check.type) || typeof check.expected === 'string', 'Artifact content checks expect a string');
    }
    caseContracts[item.id] = {
      fixtureHash: hashObject({ fixtureHash, prompt: item.prompt, expectation: item.expectation, hardChecks: item.hardChecks })
    };
  }
  return { suite, root, fixtureHash, caseContracts };
}

export function discoverSuites(repo) {
  const directory = path.join(path.resolve(repo), 'evals', 'suites');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(directory, entry.name, 'suite.json'))
    .filter(filename => fs.existsSync(filename))
    .map(filename => resolveContained(repo, path.relative(repo, filename))).sort();
}

export function planRuns(loaded, profile, options = {}) {
  validateDocument('profile', profile);
  const selection = {
    cases: options.cases ?? loaded.suite.cases.map(item => item.id),
    clients: options.clients ?? loaded.suite.clients,
    arms: options.arms ?? ['candidate', 'baseline']
  };
  requireThat(Array.isArray(selection.cases) && selection.cases.length > 0, 'Empty case selection');
  requireThat(Array.isArray(selection.clients) && selection.clients.length > 0, 'Empty client selection');
  requireThat(Array.isArray(selection.arms) && selection.arms.includes('candidate') && selection.arms.includes('baseline'), 'Candidate and baseline arms are required');
  for (const key of ['cases', 'clients', 'arms']) unique(selection[key], `selected ${key}`);
  for (const id of selection.cases) requireThat(loaded.suite.cases.some(item => item.id === id), `Unknown case: ${id}`);
  for (const client of selection.clients) {
    requireThat(loaded.suite.clients.includes(client) && CLIENTS.includes(client), `Unsupported client: ${client}`);
    requireThat(profile.clients[client], `Profile missing client: ${client}`);
  }
  for (const arm of selection.arms) requireThat(['candidate', 'baseline', 'no-skill'].includes(arm), `Unsupported arm: ${arm}`);
  const tasks = [];
  for (const caseId of selection.cases) for (const client of selection.clients) for (const arm of selection.arms) {
    for (let repeat = 1; repeat <= POLICY.repeats; repeat++) tasks.push({ caseId, client, arm, repeat, ...loaded.caseContracts[caseId] });
  }
  return { selection, profileHash: hashObject(profile), taskSessionCount: tasks.length, tasks };
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

export function snapshotIdentity(snapshot) {
  return hashObject({ commit: snapshot.source.commit, deletedPaths: snapshot.source.deletedPaths, files: snapshot.files });
}

export function validateSnapshot(snapshot, directory) {
  validateDocument('snapshot', snapshot);
  unique(snapshot.files.map(file => relativePath(file.path)), 'snapshot paths');
  requireThat(snapshot.source.deletedPaths.every(deleted => !snapshot.files.some(file => relativePath(file.path) === relativePath(deleted))), 'Deleted file present in snapshot');
  requireThat(snapshotIdentity(snapshot) === snapshot.snapshotId, 'Snapshot content identity mismatch');
  if (directory) for (const file of snapshot.files) {
    const bytes = fs.readFileSync(resolveContained(directory, file.path));
    requireThat(bytes.length === file.bytes && hashContent(bytes) === file.sha256, `Snapshot file mismatch: ${file.path}`);
  }
  return snapshot;
}

export function exportCandidate({ repo, trackedPaths, untrackedPaths = [], workRoot = path.join(toolRoot, '.work') }) {
  repo = fs.realpathSync(path.resolve(repo));
  requireThat(Array.isArray(trackedPaths) && trackedPaths.length > 0, 'Explicit tracked path selection required');
  trackedPaths = trackedPaths.map(relativePath);
  untrackedPaths = untrackedPaths.map(relativePath);
  unique(untrackedPaths, 'untracked paths');
  const approvedRoots = [path.join(toolRoot, '.work'), path.join(repo, 'evals', '.work')].map(root => path.resolve(root));
  workRoot = path.resolve(workRoot);
  requireThat(approvedRoots.includes(workRoot), 'Work root must be tool or approved source repo evals/.work');
  requireThat(!fs.existsSync(workRoot) || fs.realpathSync(workRoot) === workRoot, 'Work root must not be a symlink');
  fs.mkdirSync(workRoot, { recursive: true });
  requireThat(fs.realpathSync(workRoot) === workRoot, 'Work root ancestors must not redirect through symlinks');
  const selected = [...new Set([
    ...git(repo, ['ls-files', '-z', '--', ...trackedPaths]).split('\0').filter(Boolean),
    ...git(repo, ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...trackedPaths]).split('\0').filter(Boolean)
  ])];
  const allTracked = new Set([
    ...git(repo, ['ls-files', '-z']).split('\0').filter(Boolean),
    ...git(repo, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean)
  ]);
  const indexModes = new Map(git(repo, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(entry => {
    const match = /^([0-7]{6}) [a-f0-9]+ ([0-3])\t([\s\S]+)$/.exec(entry);
    requireThat(match?.[2] === '0', 'Unmerged source index is not an approved candidate snapshot');
    return [match[3], match[1]];
  }));
  requireThat(selected.length > 0 || untrackedPaths.length > 0, 'Empty source selection');
  for (const filename of untrackedPaths) requireThat(!allTracked.has(filename), `Not untracked: ${filename}`);
  const dirty = new Set([
    ...git(repo, ['diff', '--name-only', '-z', 'HEAD', '--', ...trackedPaths]).split('\0').filter(Boolean),
    ...selected.filter(filename => !fs.existsSync(path.join(repo, ...filename.split('/'))))
  ]);
  const records = [];
  const deletedPaths = [];
  const payload = [];
  for (const filename of [...new Set([...selected, ...untrackedPaths])].sort()) {
    const candidate = path.join(repo, ...filename.split('/'));
    if (allTracked.has(filename) && !fs.existsSync(candidate) && !fs.lstatSync(candidate, { throwIfNoEntry: false })) {
      deletedPaths.push(filename);
      continue;
    }
    const bytes = fs.readFileSync(resolveContained(repo, filename));
    requireThat(filename !== 'snapshot.json', 'snapshot.json is reserved for the export manifest');
    const executable = process.platform === 'win32' && indexModes.has(filename)
      ? indexModes.get(filename) === '100755'
      : Boolean(fs.statSync(candidate).mode & 0o111);
    records.push({
      path: filename, sha256: hashContent(bytes), bytes: bytes.length,
      origin: allTracked.has(filename) ? 'tracked' : 'untracked', executable
    });
    payload.push({ filename, bytes, mode: executable ? 0o755 : 0o644 });
  }
  const snapshot = {
    contractVersion: CONTRACT_VERSION, snapshotId: '',
    source: { repo, commit: git(repo, ['rev-parse', 'HEAD']).trim(), mode: 'working-tree', dirtyPaths: [...dirty].sort(), deletedPaths },
    files: records
  };
  snapshot.snapshotId = snapshotIdentity(snapshot);
  validateSnapshot(snapshot);
  const directory = path.join(workRoot, `export-${randomUUID()}`);
  fs.mkdirSync(directory);
  try {
    for (const { filename, bytes, mode } of payload) {
      const destination = path.join(directory, ...filename.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { mode });
    }
    fs.writeFileSync(path.join(directory, 'snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
    validateSnapshot(snapshot, directory);
    return { directory, snapshot };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function validateUsageMetrics(usage) {
  const names = Object.keys(schema.definitions.run.properties.usage.properties);
  requireThat(usage !== null && typeof usage === 'object' && !Array.isArray(usage) &&
    Object.keys(usage).length === names.length && names.every(name => Object.hasOwn(usage, name)),
  'Exactly the declared usage metrics are required');
  for (const [name, metric] of Object.entries(usage)) {
    validateDocument('metric', metric);
    requireThat(metric.value === null || Number.isFinite(metric.value), `${name} must be finite or unknown null`);
    requireThat(metric.value !== null || metric.provenance === 'unavailable', `Unknown ${name} requires unavailable provenance`);
    requireThat(metric.value === null || metric.provenance !== 'unavailable', `Measured ${name} needs provenance`);
  }
  return structuredClone(usage);
}

export function normalizeRun(raw) {
  validateDocument('run', raw);
  validateUsageMetrics(raw.usage);
  return structuredClone(raw);
}

function runtimeImageMatches(runtime, pin, legacyImage) {
  if (pin.runtimeImage === undefined) return runtime.image === legacyImage && runtime.runtimeImage === undefined;
  return runtime.image === pin.runtimeImage.configDigest && runtime.runtimeImage !== undefined &&
    canonicalJson(runtime.runtimeImage) === canonicalJson(pin.runtimeImage);
}

function discoveryOutcome(run, item, skill) {
  if (!run) return { status: 'missing', loaded: null, evidence: [] };
  const loaded = run.arm !== 'no-skill' && item.expectation !== 'negative';
  const skillLoad = run.trigger.evidence.some(entry => entry.kind === 'skill-load' && entry.skill === skill);
  const audit = run.trigger.evidence.some(entry => entry.kind === 'discovery-audit' && entry.skill === skill);
  const passed = run.trigger.loaded === loaded &&
    (run.arm === 'no-skill' ? !skillLoad : loaded ? skillLoad : audit && !skillLoad);
  return { status: passed ? 'passed' : 'failed', ...structuredClone(run.trigger) };
}

export function evaluateResults(loaded, results, { previousRunIds = [] } = {}) {
  const failures = [];
  const groups = [];
  const fail = (failureClass, message, runId = null) => failures.push({ class: failureClass, message, runId });
  try {
    validateDocument('results', results);
    requireThat(results.suiteId === loaded.suite.id, 'Result suite identity mismatch');
    const plan = planRuns(loaded, results.profile, results.selection);
    const profileHash = plan.profileHash;
    validateSnapshot(results.snapshots.candidate);
    validateSnapshot(results.snapshots.baseline);
    requireThat(results.baseline.snapshotId === results.snapshots.baseline.snapshotId, 'Baseline snapshot mismatch', 'regression');
    requireThat(results.baseline.approval.snapshotId === results.baseline.snapshotId, 'Approval does not identify exact baseline', 'regression');
    requireThat(results.baseline.profileHash === profileHash, 'Baseline profile incompatible', 'regression');
    requireThat(Number.isFinite(Date.parse(results.baseline.approval.at)), 'Invalid baseline approval date', 'regression');
    const seen = new Set(previousRunIds);
    const slots = new Map();
    const expected = new Set(plan.tasks.map(task => `${task.caseId}|${task.client}|${task.arm}|${task.repeat}`));
    for (const raw of results.runs) {
      const run = normalizeRun(raw);
      const slot = `${run.caseId}|${run.client}|${run.arm}|${run.repeat}`;
      if (seen.has(run.runId)) fail('infrastructure', 'Duplicate or cached run ID', run.runId);
      seen.add(run.runId);
      if (!expected.has(slot)) fail('infrastructure', `Unexpected run slot ${slot}`, run.runId);
      if (slots.has(slot)) fail('infrastructure', `Duplicate repeat ${slot}`, run.runId);
      slots.set(slot, run);
      if (!run.fresh || run.invocationId !== results.invocationId) fail('infrastructure', 'Run is stale or belongs to another invocation', run.runId);
      if (run.status !== 'completed' || run.error !== null) fail('infrastructure', `Incomplete execution: ${run.status}`, run.runId);
      const pin = results.profile.clients[run.client];
      if (!pin) { fail('infrastructure', 'Missing runtime pin', run.runId); continue; }
      if (run.profileHash !== profileHash || run.runtime.clientVersion !== pin.version ||
          !runtimeImageMatches(run.runtime, pin, results.profile.image) || run.runtime.auth !== results.profile.auth ||
          run.model.requested !== pin.model) {
        fail('infrastructure', 'Incompatible model/auth/runtime/profile', run.runId);
      }
      if (typeof run.model.observed !== 'string' || !run.model.observed.trim()) {
        fail('infrastructure', 'Missing observed native model identity', run.runId);
      }
      const identity = loaded.caseContracts[run.caseId];
      if (!identity) continue;
      if (run.fixtureHash !== identity.fixtureHash) fail('infrastructure', 'Fixture identity mismatch', run.runId);
      const snapshotId = run.arm === 'no-skill' ? null : results.snapshots[run.arm].snapshotId;
      if (run.snapshotId !== snapshotId) fail('infrastructure', 'Arm snapshot identity mismatch', run.runId);
      const item = loaded.suite.cases.find(item => item.id === run.caseId);
      const checkIds = new Set();
      for (const check of run.checks) {
        if (checkIds.has(check.id)) fail('infrastructure', 'Duplicate hard check', run.runId);
        checkIds.add(check.id);
        const declaration = item.hardChecks.find(required => required.id === check.id);
        if (!declaration || declaration.class !== check.class) fail('infrastructure', 'Unknown/misclassified hard check', run.runId);
        if (check.status === 'error' || check.status === 'skipped') fail('infrastructure', 'Required check incomplete', run.runId);
        if (run.arm === 'candidate' && check.status === 'failed') fail(check.class, `Hard check failed: ${check.id}`, run.runId);
      }
      for (const check of item.hardChecks) if (!checkIds.has(check.id)) fail('infrastructure', `Missing hard check ${check.id}`, run.runId);
      if (run.arm === 'no-skill') {
        if (run.trigger.loaded !== false || run.trigger.evidence.some(entry => entry.kind === 'skill-load' && entry.skill === loaded.suite.skill)) {
          fail('discovery', 'No-skill control is contaminated or lacks a known unloaded state', run.runId);
        }
      } else {
        const shouldLoad = item.expectation !== 'negative';
        const kind = shouldLoad ? 'skill-load' : 'discovery-audit';
        const evidence = run.trigger.evidence.some(entry => entry.kind === kind && entry.skill === loaded.suite.skill);
        if (run.trigger.loaded !== shouldLoad || !evidence) fail('discovery', 'Trigger expectation lacks matching actual load/audit evidence', run.runId);
        if (!shouldLoad && run.trigger.evidence.some(entry => entry.kind === 'skill-load' && entry.skill === loaded.suite.skill)) fail('discovery', 'Contradictory negative load evidence', run.runId);
      }
    }
    for (const slot of expected) if (!slots.has(slot)) fail('infrastructure', `Missing repeat ${slot}`);
    for (const caseId of plan.selection.cases) for (const client of plan.selection.clients) {
      const item = loaded.suite.cases.find(item => item.id === caseId);
      const arms = {};
      for (const arm of plan.selection.arms) {
        const counts = {
          executions: { completed: 0, incomplete: 0, missing: 0 },
          discovery: { passed: 0, failed: 0, missing: 0 },
          checks: { passed: 0, failed: 0, error: 0, skipped: 0, missing: 0 }
        };
        const repeats = Array.from({ length: POLICY.repeats }, (_, index) => {
          const repeat = index + 1;
          const run = slots.get(`${caseId}|${client}|${arm}|${repeat}`);
          counts.executions[!run ? 'missing' : run.status === 'completed' && run.error === null ? 'completed' : 'incomplete']++;
          const discovery = discoveryOutcome(run, item, loaded.suite.skill);
          counts.discovery[discovery.status]++;
          const checks = item.hardChecks.map(declaration => {
            const check = run?.checks.find(check => check.id === declaration.id);
            const outcome = check ?? { id: declaration.id, class: declaration.class, status: 'missing', evidence: null };
            counts.checks[outcome.status]++;
            return structuredClone(outcome);
          });
          return { repeat, runId: run?.runId ?? null, status: run?.status ?? 'missing', discovery, checks };
        });
        arms[arm] = { repeats, counts };
      }
      const candidateRuns = arms.candidate.repeats.map(({ repeat }) => slots.get(`${caseId}|${client}|candidate|${repeat}`));
      const baselineRuns = arms.baseline.repeats.map(({ repeat }) => slots.get(`${caseId}|${client}|baseline|${repeat}`));
      const observed = [...candidateRuns, ...baselineRuns].filter(Boolean).map(run => run.model.observed);
      const observedModelsPresent = observed.every(model => typeof model === 'string' && model.trim());
      const sameObservedModel = observedModelsPresent && new Set(observed).size <= 1;
      if (observedModelsPresent && !sameObservedModel) fail('regression', `Observed model mismatch for ${caseId}/${client}`);
      const pin = results.profile.clients[client];
      const compatible = sameObservedModel && [...candidateRuns, ...baselineRuns].filter(Boolean).every(run =>
        run.profileHash === profileHash && run.fixtureHash === loaded.caseContracts[caseId].fixtureHash &&
        run.snapshotId === results.snapshots[run.arm].snapshotId && run.model.requested === pin.model &&
        run.runtime.clientVersion === pin.version && runtimeImageMatches(run.runtime, pin, results.profile.image) &&
        run.runtime.auth === results.profile.auth);
      const complete = [...candidateRuns, ...baselineRuns].every(run =>
        run?.status === 'completed' && run.error === null && run.checks.length === item.hardChecks.length &&
        item.hardChecks.every(required => run.checks.some(check =>
          check.id === required.id && check.class === required.class && ['passed', 'failed'].includes(check.status))));
      if (!complete) fail('regression', `Incomplete comparison for ${caseId}/${client}`);
      const checks = item.hardChecks.map(required => {
        const outcomes = arm => arms[arm].repeats.map(run => run.checks.find(check => check.id === required.id).status);
        const candidate = outcomes('candidate');
        const baseline = outcomes('baseline');
        const regressedRepeats = baseline.flatMap((status, index) => status === 'passed' && candidate[index] === 'failed' ? [index + 1] : []);
        if (regressedRepeats.length) fail('regression', `Required check regressed: ${required.id} for ${caseId}/${client}, repeats ${regressedRepeats.join(',')}`);
        return { id: required.id, class: required.class, candidate, baseline, regressedRepeats };
      });
      const comparison = {
        status: !compatible ? 'incompatible' : !complete ? 'incomplete' : checks.some(check => check.regressedRepeats.length) ? 'regressed' : 'non-regressed',
        checks
      };
      groups.push({ caseId, client, arms, comparison });
    }
  } catch (error) {
    fail(error.failureClass ?? 'infrastructure', error.message);
  }
  return { contractVersion: CONTRACT_VERSION, passed: failures.length === 0, exitCode: failures.length ? 1 : 0, policy: POLICY, groups, failures };
}

export function runEvaluation(loaded, profile, selection = {}) {
  const plan = loaded === undefined && profile === undefined
    ? null : planRuns(loaded, profile, selection);
  const selected = plan ? ` Selected matrix: ${plan.taskSessionCount} fresh sessions.` : '';
  throw new ContractError(`No real execution adapter is installed. run is blocked; dry-run is planning only.${selected}`);
}
