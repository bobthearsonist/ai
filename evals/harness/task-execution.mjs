import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  canonicalJson, ContractError, hashContent, hashObject, loadSuite, planRuns, readJson,
  resolveContained, validateDocument, validateSnapshot, validateUsageMetrics
} from './index.mjs';
import { gradeChecks, readCapturedArtifact, validateChecks } from './checks/index.mjs';
import { CLIENT_VERSIONS, createWorkspace, destroyWorkspace, writeEvidence } from './isolation/index.mjs';

const RUNNER = '@vercel/agent-eval@2.4.1';
const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 256;

function insist(condition, message) {
  if (!condition) throw new ContractError(message);
}

function relativeRoot(value) {
  validateDocument('path', value);
  const parts = value.split(/[/\\]/);
  insist(parts.every(part => part && part !== '.' && part !== '..'), 'An unambiguous relative skill path is required');
  return parts.join('/');
}

function captureContext(loaded) {
  const manifest = [];
  const inputs = [];
  for (const item of loaded.suite.context.dependencies) {
    if (item.availability !== 'provided') continue;
    const content = fs.readFileSync(resolveContained(loaded.root, item.path));
    manifest.push({ id: item.id, path: item.path, sha256: hashContent(content) });
    if (item.visibility === 'agent') {
      inputs.push({ path: item.mount, mountRoot: item.mountRoot, content, executable: false });
    }
  }
  insist(hashObject({ context: loaded.suite.context, files: manifest }) === loaded.fixtureHash,
    'Context changed while preparing native tasks');
  return inputs;
}

function captureSkill(directory, skillPath) {
  insist(typeof directory === 'string' && path.isAbsolute(directory), 'An absolute source export directory is required');
  const snapshot = readJson(resolveContained(directory, 'snapshot.json'));
  validateSnapshot(snapshot, directory);
  const prefix = `${skillPath}/`;
  const files = snapshot.files
    .filter(file => file.path.replaceAll('\\', '/').startsWith(prefix))
    .map(file => {
      const content = fs.readFileSync(resolveContained(directory, file.path));
      insist(content.length === file.bytes && hashContent(content) === file.sha256,
        `Snapshot changed while capturing skill file: ${file.path}`);
      return { path: file.path.replaceAll('\\', '/').slice(prefix.length), content, executable: file.executable };
    });
  insist(files.some(file => file.path === 'SKILL.md'), 'Selected export does not contain the requested skill SKILL.md');
  return { snapshot, files };
}

function scenariosFor(cases, scenarios) {
  insist(Array.isArray(scenarios) && scenarios.length === cases.length,
    'Exactly one explicit mock scenario per selected case is required');
  const selected = new Map(cases.map(item => [item.id, item]));
  const result = new Map();
  for (const scenario of scenarios) {
    insist(scenario && typeof scenario === 'object' && !Array.isArray(scenario) &&
      Object.keys(scenario).every(key => ['caseId', 'loadSkill', 'artifacts'].includes(key)),
    'Invalid mock scenario fields');
    const item = selected.get(scenario.caseId);
    insist(item && !result.has(scenario.caseId), 'Unknown or duplicate mock scenario case');
    insist(typeof scenario.loadSkill === 'boolean' && Array.isArray(scenario.artifacts),
      'Mock scenarios require explicit loadSkill and artifacts');
    const declarations = validateChecks(item.hardChecks);
    const targets = new Set(declarations.filter(check => check.type.startsWith('artifact-'))
      .map(check => check.target.replaceAll('\\', '/')));
    const seen = new Set();
    let bytes = 0;
    const artifacts = scenario.artifacts.map(artifact => {
      insist(artifact && typeof artifact === 'object' && !Array.isArray(artifact) &&
        Object.keys(artifact).every(key => ['path', 'content'].includes(key)) &&
        typeof artifact.path === 'string' && typeof artifact.content === 'string',
      'Mock artifacts require only explicit path and string content');
      validateChecks([{ id: 'mock-target', class: 'correctness', type: 'artifact-exists',
        target: artifact.path, expected: true }]);
      const target = artifact.path.replaceAll('\\', '/');
      insist(targets.has(target) && !seen.has(target.toLowerCase()),
        'Mock artifact is undeclared, duplicated or aliased');
      seen.add(target.toLowerCase());
      bytes += Buffer.byteLength(artifact.content);
      insist(bytes <= MAX_BYTES, 'Mock artifact byte cap exceeded');
      return { path: artifact.path, content: artifact.content };
    });
    result.set(scenario.caseId, { loadSkill: scenario.loadSkill, artifacts });
  }
  return result;
}

export function copyCaseFiles(files) {
  return files.map(file => ({ ...file, content: Buffer.from(file.content) }));
}

export function captureCaseSources(loaded, { skillPath, candidateExport, baselineExport }) {
  const selectedPath = relativeRoot(skillPath);
  const inputs = captureContext(loaded);
  const arms = {
    candidate: captureSkill(candidateExport, selectedPath),
    baseline: captureSkill(baselineExport, selectedPath)
  };
  for (const arm of Object.values(arms)) {
    insist(inputs.length + arm.files.length <= MAX_FILES &&
      [...inputs, ...arm.files].reduce((total, file) => total + file.content.length, 0) <= MAX_BYTES,
    'Native task input file or byte cap exceeded');
  }
  return { inputs, arms };
}

export function prepareOfflineCaseMatrix({
  suiteFile, profile, selection = {}, skillPath, candidateExport, baselineExport,
  mockScenarios, invocationId = randomUUID()
}) {
  insist(typeof invocationId === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(invocationId),
    'A bounded invocation identifier is required');
  const capturedProfile = structuredClone(profile);
  validateDocument('profile', capturedProfile);
  insist(capturedProfile.auth === 'none-offline', 'Native mock tasks require auth none-offline');
  insist(capturedProfile.runner === RUNNER, 'The pinned public local SDK runner is required');
  insist(capturedProfile.limits.seconds <= 300 && capturedProfile.limits.concurrency <= 4,
    'Offline native task limits require seconds <= 300 and concurrency <= 4');
  const loaded = loadSuite(suiteFile);
  const plan = planRuns(loaded, capturedProfile, selection);
  for (const client of plan.selection.clients) {
    insist(capturedProfile.clients[client].version === CLIENT_VERSIONS[client],
      `Offline native task client version differs from pin: ${client}`);
  }
  insist(plan.tasks.length <= 512, 'Offline native task matrix cap exceeded');
  const cases = plan.selection.cases.map(id => loaded.suite.cases.find(item => item.id === id));
  const scenarios = scenariosFor(cases, mockScenarios);
  const { inputs, arms } = captureCaseSources(loaded, { skillPath, candidateExport, baselineExport });
  const tasks = plan.tasks.map(coordinates => {
    const item = cases.find(item => item.id === coordinates.caseId);
    const scenario = scenarios.get(item.id);
    return {
      task: { invocationId, ...coordinates },
      prompt: item.prompt,
      skill: { id: loaded.suite.skill, files: coordinates.arm === 'no-skill' ? [] : copyCaseFiles(arms[coordinates.arm].files) },
      inputs: copyCaseFiles(inputs), checks: structuredClone(item.hardChecks),
      mock: { ...structuredClone(scenario), loadSkill: coordinates.arm === 'no-skill' ? false : scenario.loadSkill }
    };
  });
  return {
    invocationId, suiteId: loaded.suite.id, skill: loaded.suite.skill,
    selection: structuredClone(plan.selection), profileHash: plan.profileHash,
    expectations: Object.fromEntries(cases.map(item => [item.id, item.expectation])),
    timeoutSeconds: capturedProfile.limits.seconds,
    profilePinsApplied: false,
    snapshots: { candidate: arms.candidate.snapshot, baseline: arms.baseline.snapshot },
    tasks
  };
}

function discovery(receipt, payload, expectation) {
  const trigger = receipt.trigger;
  const load = trigger.evidence.some(item => item.kind === 'skill-load' && item.skill === payload.skill.id);
  const audit = trigger.evidence.some(item => item.kind === 'discovery-audit' && item.skill === payload.skill.id);
  const expected = payload.task.arm !== 'no-skill' && expectation !== 'negative';
  const passed = trigger.loaded === expected &&
    (payload.task.arm === 'no-skill' ? !load : expected ? load : audit && !load);
  return { ...structuredClone(trigger), status: passed ? 'passed' : 'failed' };
}

export async function executeOfflineCaseMatrix(options, { loadClient } = {}) {
  const prepared = prepareOfflineCaseMatrix(options);
  const { runOfflineTaskMatrix } = await import('./runner/index.mjs');
  const batch = await runOfflineTaskMatrix({
    tasks: prepared.tasks, timeoutSeconds: prepared.timeoutSeconds
  }, loadClient === undefined ? {} : { loadClient });
  insist(batch.invocationId === prepared.invocationId &&
    batch.plannedTaskCount === prepared.tasks.length && batch.attemptedTaskCount === prepared.tasks.length &&
    Array.isArray(batch.attempts) && batch.attempts.length === prepared.tasks.length &&
    canonicalJson(batch.selection) === canonicalJson(prepared.selection) &&
    batch.transport === 'offline-mock' && batch.offlineEvidenceOnly === true &&
    batch.liveAccepted === false && batch.authenticationVerified === false &&
    batch.baselineApproved === false && batch.qualityEvaluated === false && batch.contractMatrixComplete === false &&
    batch.evidenceSource === (loadClient === undefined ? 'actual-native-offline-task-callbacks' : 'injected-test-callbacks'),
  'Offline SDK matrix returned incompatible execution provenance');
  const executions = [];
  const captures = [];
  const failures = [];
  const seenCaptures = new WeakSet();
  for (let index = 0; index < prepared.tasks.length; index++) {
    const payload = prepared.tasks[index];
    const attempt = batch.attempts[index];
    const slotFailures = [];
    const fail = (failureClass, message) => slotFailures.push({ class: failureClass, message });
    const execution = {
      attemptId: attempt.attemptId, task: structuredClone(payload.task),
      snapshotId: payload.task.arm === 'no-skill' ? null : prepared.snapshots[payload.task.arm].snapshotId,
      status: attempt.status, executionId: null,
      discovery: { status: 'missing', loaded: null, evidence: [] },
      checks: payload.checks.map(check => ({ id: check.id, class: check.class, status: 'error', evidence: null })),
      capture: null, usage: null, error: attempt.error ?? null
    };
    if (attempt.status !== 'completed') {
      fail('infrastructure', `Native task ${attempt.status}: ${attempt.error?.message ?? 'No completed native receipt'}`);
    } else {
      try {
        insist(canonicalJson(attempt.task) === canonicalJson(payload.task), 'SDK task coordinates changed');
        insist(attempt.callbackCount === 1, 'Native task requires exactly one SDK callback');
        const receipt = attempt.receipt;
        if (payload.task.client === 'opencode') {
          insist(receipt.promptEnvelope === 'opencode-1.14.28-stdin-newline' &&
            receipt.wireMessageHash === hashContent(`\n${payload.prompt}`),
          'Pinned OpenCode task requires its audited stdin-newline envelope and exact observed wire hash');
        }
        const graded = gradeChecks({ checks: payload.checks, capture: receipt.capture });
        insist(!seenCaptures.has(receipt.capture), 'A trusted artifact capture was reused across native tasks');
        seenCaptures.add(receipt.capture);
        insist(canonicalJson(graded.checks) === canonicalJson(receipt.checks), 'Native check outcomes differ from trusted captured artifacts');
        execution.usage = validateUsageMetrics(receipt.usage);
        execution.executionId = receipt.executionId;
        execution.capture = receipt.capture;
        execution.checkEvidence = graded.evidence;
        execution.native = {
          client: receipt.client, clientVersion: receipt.clientVersion,
          promptHash: receipt.promptHash, image: receipt.image,
          ...(receipt.wireMessageHash === undefined ? {} : { wireMessageHash: receipt.wireMessageHash }),
          ...(receipt.promptEnvelope === undefined ? {} : { promptEnvelope: receipt.promptEnvelope })
        };
        execution.checks = graded.checks;
        execution.discovery = discovery(receipt, payload, prepared.expectations[payload.task.caseId]);
        captures.push({ attemptId: attempt.attemptId, executionId: receipt.executionId, capture: receipt.capture });
        if (execution.discovery.status !== 'passed') fail('discovery', 'Actual native skill load/audit does not satisfy the case expectation');
        for (const check of graded.checks) {
          if (check.status === 'error' || check.status === 'skipped') fail('infrastructure', `Required check incomplete: ${check.id}`);
          else if (check.status === 'failed' && payload.task.arm === 'candidate') fail(check.class, `Required check failed: ${check.id}`);
        }
      } catch (error) {
        execution.status = 'incomplete';
        execution.error = { name: error.name, message: error.message };
        fail(error.failureClass ?? 'infrastructure', error.message);
      }
    }
    execution.failures = slotFailures;
    executions.push(execution);
    failures.push(...slotFailures.map(failure => ({ ...failure, attemptId: attempt.attemptId, task: structuredClone(payload.task) })));
  }
  const report = {
    invocationId: prepared.invocationId, createdAt: batch.createdAt,
    suiteId: prepared.suiteId, selection: prepared.selection, profileHash: prepared.profileHash,
    profilePinsApplied: false, transport: 'offline-mock', evidenceSource: batch.evidenceSource,
    offlineEvidenceOnly: true, authenticationVerified: false, liveAccepted: false,
    baselineApproved: false, qualityEvaluated: false, contractMatrixComplete: false,
    limits: { secondsPerTask: prepared.timeoutSeconds, concurrency: 1, turnTokenLimitsApplied: false },
    provenance: batch.provenance,
    plannedTaskCount: prepared.tasks.length, attemptedTaskCount: batch.attemptedTaskCount,
    completedTaskCount: executions.filter(execution => execution.status === 'completed').length,
    diagnosticsPassed: failures.length === 0, exitCode: failures.length ? 1 : 0,
    executions, failures
  };
  return { report, captures };
}

export function persistOfflineCaseMatrix({ report, captures }) {
  insist(report?.offlineEvidenceOnly === true && report.transport === 'offline-mock' &&
    report.authenticationVerified === false && report.liveAccepted === false &&
    report.baselineApproved === false && report.contractMatrixComplete === false &&
    report.profilePinsApplied === false &&
    ['actual-native-offline-task-callbacks', 'injected-test-callbacks'].includes(report.evidenceSource),
  'Only explicit offline diagnostic matrices can be persisted');
  insist(Array.isArray(report.executions) && report.executions.length > 0 &&
    report.executions.length === report.plannedTaskCount &&
    report.executions.length === report.attemptedTaskCount && Array.isArray(captures),
  'A complete attempted matrix is required for persistence');
  const originals = new Map(captures.map(item => [item.attemptId, item]));
  insist(originals.size === captures.length, 'Duplicate capture attempt identity');
  const workspace = createWorkspace({ task: report.executions[0].task });
  try {
    const references = report.executions.map((execution, index) => {
      const original = originals.get(execution.attemptId);
      insist(execution.capture === null ? !original :
        original?.capture === execution.capture && original.executionId === execution.executionId,
      'Persisted execution must retain its original trusted capture');
      const artifacts = execution.capture?.artifacts.map(artifact => ({
        ...artifact,
        ...(artifact.state === 'present'
          ? { base64: readCapturedArtifact(execution.capture, artifact.target).toString('base64') } : {})
      })) ?? [];
      const evidenceFile = writeEvidence(workspace, { ...execution, artifacts }, {
        name: `executions/${String(index + 1).padStart(4, '0')}.json`
      });
      return {
        attemptId: execution.attemptId, executionId: execution.executionId, task: execution.task,
        status: execution.status, failureCount: execution.failures.length,
        failure: execution.failures[0] ?? null, error: execution.error,
        evidenceFile: path.relative(workspace.directory, evidenceFile)
      };
    });
    const { executions, failures, ...summary } = report;
    const manifest = {
      kind: 'offline-native-case-matrix', formatVersion: 1, ...summary,
      failureCount: failures.length, executions: references
    };
    const reportFile = writeEvidence(workspace, manifest, { name: 'matrix.json' });
    return { workspace, reportFile, manifest };
  } catch (error) {
    destroyWorkspace(workspace);
    throw error;
  }
}
