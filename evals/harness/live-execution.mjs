import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import {
  canonicalJson, ContractError, hashContent, hashObject, loadSuite, planRuns, validateDocument
} from './index.mjs';
import { captureArtifacts, gradeChecks, validateChecks } from './checks/index.mjs';
import { CLIENT_VERSIONS, createWorkspace, destroyWorkspace } from './isolation/index.mjs';
import { captureCaseSources, copyCaseFiles } from './task-execution.mjs';
import { assertNativeAuthCustody } from './auth/custody.mjs';
import {
  assertEgressCandidate, assertNativeEgressCandidate, describeEgressBoundary, inspectNativeEgressCandidate
} from './live-boundary/index.mjs';
import { createPublicPolicy } from './live-boundary/policy.mjs';
import { prepareNativeTaskSpecification as prepareClaudeTask } from './clients/claude-code/index.mjs';
import { prepareNativeTaskSpecification as prepareCopilotTask } from './clients/copilot/index.mjs';
import { prepareNativeTaskSpecification as prepareOpenCodeTask } from './clients/opencode/index.mjs';
import {
  assertToolWorkerTransportBinding, captureToolWorkerArtifacts, closeToolWorker, describeToolWorkerTransportBinding,
  issueToolTask, leaseToolWorkerTransport, prepareToolWorker, resolveToolWorkerTransportLease,
  startToolWorker, TOOL_CAPS, ToolWorkerError
} from './tool-worker/index.mjs';

const handles = new WeakMap();
const nativeSpecifications = new WeakMap();
const liveToolWorkers = new WeakMap();
const nativeBuilders = Object.freeze({
  'claude-code': prepareClaudeTask, copilot: prepareCopilotTask, opencode: prepareOpenCodeTask
});
const MAX_MATRIX_BYTES = 64 * 1024 * 1024;
const OPTIONS = new Set([
  'suiteFile', 'profile', 'selection', 'skillPath', 'candidateExport', 'baselineExport',
  'baseline', 'invocationId'
]);

export class LiveEvaluationError extends ContractError {
  constructor(message, code = 'LIVE_EVALUATION_BLOCKED', failureClass = 'infrastructure') {
    super(message, failureClass);
    this.name = 'LiveEvaluationError';
    this.code = code;
  }
}

function insist(condition, message, code, failureClass) {
  if (!condition) throw new LiveEvaluationError(message, code, failureClass);
}

function requestedRoute(pin) {
  insist(/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/.test(pin.model),
    'A bounded explicit native model identifier is required', 'INVALID_NATIVE_MODEL');
  let endpoint;
  try { endpoint = new URL(pin.endpoint); }
  catch { throw new LiveEvaluationError('A direct HTTPS native service origin is required', 'INVALID_NATIVE_ENDPOINT'); }
  insist(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password &&
    !endpoint.search && !endpoint.hash && endpoint.pathname === '/' &&
    (!endpoint.port || endpoint.port === '443') && !isIP(endpoint.hostname) &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(endpoint.hostname) &&
    !/(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(endpoint.hostname),
  'Native service origins cannot contain credentials, IP/private aliases, paths or non-HTTPS ports', 'INVALID_NATIVE_ENDPOINT');
  insist(Object.getPrototypeOf(pin.settings) === Object.prototype && Object.keys(pin.settings).length === 0,
    'Unverified native client settings overrides are not supported', 'UNVERIFIED_NATIVE_SETTINGS');
  return {
    clientVersion: pin.version, model: pin.model, endpoint: endpoint.origin,
    ...(pin.runtimeImage === undefined ? {} : { runtimeImage: structuredClone(pin.runtimeImage) })
  };
}

function owned(handle) {
  const state = handles.get(handle);
  insist(state && !state.released, 'Unknown or released live preparation handle', 'INVALID_LIVE_HANDLE');
  return state;
}

function copyRequest(request) {
  return {
    task: { ...request.task }, prompt: request.prompt,
    skill: { id: request.skill.id, files: copyCaseFiles(request.skill.files) },
    inputs: copyCaseFiles(request.inputs), checks: structuredClone(request.checks)
  };
}

function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function approvalTime(value) {
  insist(typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value),
  'Authorization timestamps must be canonical UTC dates', 'INVALID_LIVE_AUTHORIZATION');
  const time = Date.parse(value);
  insist(Number.isFinite(time) && new Date(time).toISOString() ===
    (value.endsWith('.000Z') || /\.\d{3}Z$/.test(value) ? value : value.replace('Z', '.000Z')),
  'Authorization timestamps must identify real UTC dates', 'INVALID_LIVE_AUTHORIZATION');
  return time;
}

function authorizationActive(state) {
  return state.authorization !== null && Date.now() < state.authorization.expiresAt;
}

export function prepareLiveEvaluation(options) {
  insist(options !== null && typeof options === 'object' && !Array.isArray(options) &&
    Object.getPrototypeOf(options) === Object.prototype && Object.keys(options).every(key => OPTIONS.has(key)),
  'Live preparation requires explicit source options; mock, credential and boundary assertions are not inputs', 'INVALID_LIVE_OPTIONS');
  const {
    suiteFile, profile, selection = {}, skillPath, candidateExport, baselineExport,
    baseline, invocationId = randomUUID()
  } = options;
  insist(typeof invocationId === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(invocationId),
    'A bounded current invocation identifier is required', 'INVALID_LIVE_INVOCATION');
  const capturedProfile = structuredClone(profile);
  validateDocument('profile', capturedProfile);
  insist(selection !== null && typeof selection === 'object' && !Array.isArray(selection) &&
    Object.getPrototypeOf(selection) === Object.prototype &&
    Object.keys(selection).every(key => ['cases', 'clients', 'arms'].includes(key)),
  'Only explicit case, client and comparison-arm selectors are supported', 'INVALID_LIVE_SELECTION');
  insist(capturedProfile.auth === 'native-client-auth',
    'Live preparation requires the normal native client authentication route', 'INVALID_LIVE_AUTH_ROUTE');
  insist(capturedProfile.runner === '@vercel/agent-eval@2.4.1',
    'The implemented pinned public SDK route is required', 'UNSUPPORTED_LIVE_RUNNER');
  insist(capturedProfile.limits.seconds <= 300 && capturedProfile.limits.concurrency <= 4 &&
    capturedProfile.limits.turns <= 128 && capturedProfile.limits.tokens <= 1_000_000,
  'Live preparation caps: seconds <= 300, concurrency <= 4, turns <= 128, tokens <= 1000000', 'LIVE_LIMIT_CAP');
  insist(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*@sha256:[a-f0-9]{64}$/.test(capturedProfile.image),
    'An exact native runtime image digest is required', 'INVALID_LIVE_IMAGE');
  const loaded = loadSuite(suiteFile);
  const scheduled = planRuns(loaded, capturedProfile, selection);
  insist(scheduled.tasks.length <= 512, 'Live native task matrix cap exceeded', 'LIVE_MATRIX_CAP');
  const routes = Object.fromEntries(scheduled.selection.clients.map(client => {
    const pin = capturedProfile.clients[client];
    insist(pin.version === CLIENT_VERSIONS[client],
      'Requested native client version differs from the implemented pin', 'NATIVE_RUNTIME_DRIFT');
    return [client, requestedRoute(pin)];
  }));
  const cases = new Map(scheduled.selection.cases.map(id => {
    const item = loaded.suite.cases.find(item => item.id === id);
    const checks = validateChecks(item.hardChecks);
    insist(checks.every(check => check.type.startsWith('artifact-')),
      'Live native tasks require implemented deterministic artifact graders; trace and manual adapters are not installed',
      'UNSUPPORTED_LIVE_CHECK');
    insist(!item.prompt.includes('\0') && Buffer.byteLength(item.prompt) <= 65536,
      'Native task prompt byte cap exceeded', 'LIVE_PROMPT_CAP');
    return [id, item];
  }));
  const { inputs, arms } = captureCaseSources(loaded, { skillPath, candidateExport, baselineExport });
  let approvedBaseline = null;
  if (baseline !== undefined) {
    approvedBaseline = structuredClone(baseline);
    validateDocument('baseline', approvedBaseline);
    insist(approvedBaseline.snapshotId === arms.baseline.snapshot.snapshotId &&
      approvedBaseline.approval.snapshotId === arms.baseline.snapshot.snapshotId &&
      approvedBaseline.profileHash === scheduled.profileHash,
    'Baseline approval does not bind the current exported snapshot and profile', 'BASELINE_BINDING_MISMATCH', 'regression');
    insist(approvedBaseline.provenance.kind === 'bootstrap',
      'Released baseline provenance requires an implemented release verifier; a declared reference is not proof', 'RELEASE_PROVENANCE_UNVERIFIED');
  }
  const inputBytes = inputs.reduce((total, file) => total + file.content.length, 0);
  const armBytes = Object.fromEntries(Object.entries(arms).map(([arm, source]) => [
    arm, source.files.reduce((total, file) => total + file.content.length, 0)
  ]));
  const matrixBytes = scheduled.tasks.reduce((total, task) =>
    total + inputBytes + (task.arm === 'no-skill' ? 0 : armBytes[task.arm]) +
    Buffer.byteLength(cases.get(task.caseId).prompt), 0);
  insist(matrixBytes <= MAX_MATRIX_BYTES, 'Live native matrix source byte cap exceeded', 'LIVE_MATRIX_BYTE_CAP');
  const tasks = scheduled.tasks.map(coordinates => {
    const item = cases.get(coordinates.caseId);
    return {
      task: { invocationId, ...coordinates }, prompt: item.prompt,
      skill: { id: loaded.suite.skill, files: coordinates.arm === 'no-skill' ? [] : copyCaseFiles(arms[coordinates.arm].files) },
      inputs: copyCaseFiles(inputs), checks: structuredClone(item.hardChecks)
    };
  });
  const identity = {
    invocationId, suiteId: loaded.suite.id, skill: loaded.suite.skill,
    selection: structuredClone(scheduled.selection), profileHash: scheduled.profileHash,
    snapshotIds: { candidate: arms.candidate.snapshot.snapshotId, baseline: arms.baseline.snapshot.snapshotId },
    caseContracts: Object.fromEntries([...cases].map(([id, item]) => [
      id, { ...loaded.caseContracts[id], promptHash: hashContent(item.prompt), expectation: item.expectation }
    ])),
    requestedRoutes: routes, requestedImage: capturedProfile.image,
    requestedLimits: structuredClone(capturedProfile.limits), taskSessionCount: tasks.length
  };
  const planHash = hashObject(identity);
  const report = {
    kind: 'native-live-evaluation-preparation', contractVersion: 2,
    ...identity, planHash, sourceBytesAcrossTasks: matrixBytes,
    prepared: true, executed: false, authenticationVerified: false,
    credentialToolBoundaryVerified: false, serviceEgressVerified: false,
    limitsVerified: false, accountConsumptionAuthorized: false, liveAccepted: false,
    baselineApproved: approvedBaseline !== null,
    baselineApprovalTarget: {
      snapshotId: identity.snapshotIds.baseline, profileHash: identity.profileHash, provenanceKind: 'bootstrap'
    },
    authorizationTarget: {
      invocationId, planHash, taskSessionCount: tasks.length,
      profileHash: identity.profileHash, snapshotIds: identity.snapshotIds,
      selection: identity.selection, requestedLimits: identity.requestedLimits,
      requestedRoutes: identity.requestedRoutes
    },
    blockers: [
      ...(approvedBaseline ? [] : ['An explicit human-approved exact bootstrap baseline is required']),
      'Accepted isolated native authentication is required',
      'Measured credential/tool and native-service egress boundaries are required',
      'Actual native turn/token/time/concurrency limit enforcement is required',
      'Explicit authorization for this exact account-consuming invocation is required'
    ]
  };
  const handle = Object.freeze({ invocationId, planHash, taskSessionCount: tasks.length });
  handles.set(handle, {
    released: false, report, profile: capturedProfile, loaded,
    snapshots: { candidate: arms.candidate.snapshot, baseline: arms.baseline.snapshot },
    baseline: approvedBaseline, authorization: null, tasks, nativeSpecifications: new Set(),
    toolWorkers: new Set()
  });
  return { handle, report: structuredClone(report) };
}

export function describeLiveEvaluation(handle) {
  const state = owned(handle);
  const report = structuredClone(state.report);
  report.accountConsumptionAuthorized = authorizationActive(state);
  if (state.authorization !== null) {
    report.accountAuthorization = {
      approval: structuredClone(state.authorization.record.approval),
      consumption: structuredClone(state.authorization.record.consumption),
      expired: !report.accountConsumptionAuthorized,
      consumptionEnforcementVerified: false
    };
    if (report.accountConsumptionAuthorized) {
      report.blockers = report.blockers.filter(blocker =>
        blocker !== 'Explicit authorization for this exact account-consuming invocation is required');
    } else {
      report.blockers.push('Account-consumption authorization has expired');
    }
  }
  return report;
}

export function authorizeLiveEvaluation(handle, authorization) {
  const state = owned(handle);
  insist(state.authorization === null, 'This preparation already has an account authorization',
    'LIVE_AUTHORIZATION_ALREADY_BOUND');
  insist(exactFields(authorization, ['contractVersion', 'kind', 'target', 'approval', 'consumption']),
    'An explicit native account-consumption approval record is required', 'INVALID_LIVE_AUTHORIZATION');
  const record = structuredClone(authorization);
  insist(
    record.contractVersion === 2 && record.kind === 'native-account-consumption-authorization',
  'An explicit native account-consumption approval record is required', 'INVALID_LIVE_AUTHORIZATION');
  insist(canonicalJson(record.target) === canonicalJson(state.report.authorizationTarget),
    'Account authorization does not bind this exact invocation, sources, routes and requested limits',
    'LIVE_AUTHORIZATION_BINDING_MISMATCH');
  insist(exactFields(record.approval, ['approved', 'by', 'at', 'expiresAt']) &&
    record.approval.approved === true && typeof record.approval.by === 'string' &&
    record.approval.by.trim().length > 0 && record.approval.by.length <= 200,
  'An explicit named human approval and expiry are required', 'INVALID_LIVE_AUTHORIZATION');
  const approvedAt = approvalTime(record.approval.at);
  const expiresAt = approvalTime(record.approval.expiresAt);
  const now = Date.now();
  insist(approvedAt <= now && expiresAt > now && expiresAt > approvedAt &&
    expiresAt - approvedAt <= 24 * 60 * 60 * 1000,
  'Account authorization must be current and expire within 24 hours of approval', 'EXPIRED_LIVE_AUTHORIZATION');
  const clients = state.report.selection.clients;
  insist(exactFields(record.consumption, clients),
    'Exactly the selected native clients require explicit account-consumption ceilings', 'INVALID_LIVE_AUTHORIZATION');
  for (const client of clients) {
    const allowance = record.consumption[client];
    const sessions = state.tasks.filter(request => request.task.client === client).length;
    insist(exactFields(allowance, ['account', 'unit', 'maximum', 'sessions']) &&
      typeof allowance.account === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(allowance.account) &&
      ['usd', 'native-nano-aiu', 'provider-requests'].includes(allowance.unit) &&
      typeof allowance.maximum === 'number' && Number.isFinite(allowance.maximum) && allowance.maximum > 0 &&
      (allowance.unit === 'usd' || Number.isSafeInteger(allowance.maximum)) &&
      Number.isSafeInteger(allowance.sessions) && allowance.sessions === sessions,
    'Each account ceiling requires a nonsecret label, finite native units and the exact planned session count',
    'INVALID_LIVE_AUTHORIZATION');
    insist(allowance.unit !== 'native-nano-aiu' || client === 'copilot',
      'Native nano-AIU ceilings apply only to Copilot observations', 'INVALID_LIVE_AUTHORIZATION');
  }
  state.authorization = { record, expiresAt };
  return describeLiveEvaluation(handle);
}

export function readLiveTaskRequest(handle, index) {
  const state = owned(handle);
  insist(Number.isInteger(index) && index >= 0 && index < state.tasks.length,
    'A planned native task index is required', 'INVALID_LIVE_TASK_INDEX');
  return copyRequest(state.tasks[index]);
}

function nativeArtifactTargets(request) {
  return [...new Set(request.checks.map(check => check.target.replaceAll('\\', '/')))];
}

function toolCoordinates(task) {
  return Object.fromEntries(['invocationId', 'caseId', 'client', 'arm', 'repeat']
    .map(field => [field, task[field]]));
}

function orderedPublicFiles(files) {
  return [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function liveToolState(worker) {
  const state = liveToolWorkers.get(worker);
  insist(state && state.phase !== 'closed', 'An original host-prepared tool worker is required',
    'INVALID_LIVE_TOOL_WORKER');
  return state;
}

function liveToolScope(state) {
  const evaluation = owned(state.evaluation);
  insist(evaluation.toolWorkers.has(state.worker) &&
    canonicalJson(evaluation.tasks[state.index]?.task) === canonicalJson(state.coordinates),
  'The tool worker does not bind this original evaluation task', 'LIVE_TOOL_SCOPE_MISMATCH');
  return evaluation;
}

function toolPreparationReport(state) {
  return {
    kind: 'native-live-tool-worker-preparation', contractVersion: 2,
    task: { ...state.coordinates }, taskIndex: state.index,
    publicFiles: structuredClone(state.publicFiles), artifactTargets: [...state.artifactTargets],
    limits: structuredClone(state.limits),
    prepared: true, started: false, nativeAdmissionSupported: false,
    authenticationVerified: false, nativeDiscoveryVerified: false, liveAccepted: false
  };
}

export function prepareLiveNativeToolWorker(handle, index, options = {}) {
  const evaluation = owned(handle);
  insist(options !== null && typeof options === 'object' && !Array.isArray(options) &&
    Object.getPrototypeOf(options) === Object.prototype &&
    Object.keys(options).every(key => key === 'limits') &&
    (options.limits === undefined || (options.limits !== null &&
      Object.getPrototypeOf(options.limits) === Object.prototype)),
  'Tool preparation accepts only optional bounded worker limits', 'INVALID_LIVE_TOOL_OPTIONS');
  const request = readLiveTaskRequest(handle, index);
  const timeoutMs = Math.min(TOOL_CAPS.timeoutMs, evaluation.profile.limits.seconds * 1000);
  if (options.limits && Object.hasOwn(options.limits, 'timeoutMs')) {
    insist(Number.isSafeInteger(options.limits.timeoutMs) && options.limits.timeoutMs > 0 &&
      options.limits.timeoutMs <= timeoutMs,
    'The tool deadline cannot exceed its worker cap or captured native timeout', 'LIVE_TOOL_LIMIT_CAP');
  }
  const limits = { timeoutMs, ...options.limits };
  const publicFiles = [
    ...request.skill.files.map(file => ({
      path: `skills/${request.skill.id}/${file.path.replaceAll('\\', '/')}`, content: file.content
    })),
    ...request.inputs.map(file => ({
      path: `inputs/${file.path.replaceAll('\\', '/')}`, content: file.content
    }))
  ];
  const state = {
    evaluation: handle, index, coordinates: { ...request.task },
    task: null, worker: null, phase: 'prepared', transport: null, transportHashes: null,
    closePromise: null, cleanup: null, captureAttempted: false, limits,
    publicFiles: orderedPublicFiles(publicFiles.map(file => ({
      path: file.path, bytes: file.content.length, sha256: hashContent(file.content)
    }))),
    artifactTargets: nativeArtifactTargets(request).map(target => `artifacts/${target}`).sort()
  };
  const retain = worker => {
    state.worker = worker;
    liveToolWorkers.set(worker, state);
    evaluation.toolWorkers.add(worker);
  };
  try {
    state.task = issueToolTask(toolCoordinates(request.task));
    const worker = prepareToolWorker({ task: state.task, publicFiles, artifactTargets: state.artifactTargets, limits });
    retain(worker);
    return { worker, report: toolPreparationReport(state) };
  } catch (error) {
    if (error instanceof ToolWorkerError && error.code === 'PREPARATION_CLEANUP_FAILED' && error.worker) {
      retain(error.worker);
    }
    throw error;
  } finally {
    for (const file of [...request.skill.files, ...request.inputs]) file.content.fill(0);
  }
}

async function closeLiveToolState(state) {
  if (state.phase === 'closed') return structuredClone(state.cleanup);
  if (state.closePromise) return state.closePromise;
  state.closePromise = (async () => {
    const cleanup = await closeToolWorker({ task: state.task, worker: state.worker });
    state.cleanup = structuredClone(cleanup);
    state.phase = 'closed';
    liveToolWorkers.delete(state.worker);
    handles.get(state.evaluation)?.toolWorkers.delete(state.worker);
    return structuredClone(cleanup);
  })();
  try { return await state.closePromise; }
  finally { state.closePromise = null; }
}

export async function releaseLiveNativeToolWorker(worker) {
  return closeLiveToolState(liveToolState(worker));
}

function toolTransportDescription(state, transport) {
  liveToolScope(state);
  const description = describeToolWorkerTransportBinding(transport);
  insist(description.binding === transport.binding &&
    canonicalJson(description.task) === canonicalJson(toolCoordinates(state.coordinates)) &&
    canonicalJson(orderedPublicFiles(description.publicFiles)) === canonicalJson(state.publicFiles) &&
    canonicalJson([...description.artifactTargets].sort()) === canonicalJson(state.artifactTargets) &&
    description.planningOnly === true && description.freshKernelVerification === false &&
    description.nativeAdmissionSupported === false &&
    ['taskHash', 'sourceHash', 'transportBindingHash', 'workerProgramHash', 'shimHash']
      .every(field => /^[a-f0-9]{64}$/.test(description[field])),
  'The original worker transport does not bind the captured public files and targets',
  'LIVE_TOOL_TRANSPORT_BINDING_MISMATCH');
  if (state.transportHashes) {
    insist(Object.entries(state.transportHashes).every(([field, value]) => description[field] === value),
      'The original tool transport identity has changed', 'LIVE_TOOL_TRANSPORT_CHANGED');
  }
  return {
    kind: 'native-live-tool-transport-description', contractVersion: 2,
    task: { ...state.coordinates }, taskIndex: state.index,
    taskHash: description.taskHash, sourceHash: description.sourceHash,
    transportBindingHash: description.transportBindingHash,
    workerProgramHash: description.workerProgramHash, shimHash: description.shimHash,
    publicFiles: structuredClone(description.publicFiles), artifactTargets: [...description.artifactTargets],
    limits: structuredClone(description.limits), deadlineUnixMs: description.deadlineUnixMs,
    planningOnly: true, verification: 'cached-original-identity-only',
    freshWorkerKernelVerification: false, nativeConsumerVerified: false,
    nativeAdmissionSupported: false, authenticationVerified: false,
    nativeDiscoveryVerified: false, liveAccepted: false
  };
}

function liveToolTransport(transport) {
  insist(exactFields(transport, ['task', 'worker', 'lease', 'binding']),
    'An original host-issued tool transport tuple is required', 'INVALID_LIVE_TOOL_TRANSPORT');
  const state = liveToolState(transport.worker);
  insist(state.phase === 'transport-ready' && state.transport === transport && transport.task === state.task,
    'An original ready host-issued tool transport tuple is required', 'INVALID_LIVE_TOOL_TRANSPORT');
  return state;
}

export function describeLiveNativeToolTransport(transport) {
  return toolTransportDescription(liveToolTransport(transport), transport);
}

function toolActionOptions(options) {
  insist(options !== null && typeof options === 'object' && !Array.isArray(options) &&
    Object.getPrototypeOf(options) === Object.prototype &&
    Object.keys(options).every(key => key === 'signal') &&
    (options.signal === undefined || options.signal instanceof AbortSignal),
  'Tool actions accept only an optional host AbortSignal', 'INVALID_LIVE_TOOL_OPTIONS');
}

export async function startLiveNativeToolWorker(worker, options = {}) {
  toolActionOptions(options);
  const state = liveToolState(worker);
  liveToolScope(state);
  insist(state.phase === 'prepared', 'This original tool worker has already entered startup',
    'LIVE_TOOL_WORKER_ALREADY_STARTED');
  state.phase = 'starting';
  const action = { task: state.task, worker, signal: options.signal };
  try {
    await startToolWorker(action);
    liveToolScope(state);
    const lease = await leaseToolWorkerTransport(action);
    liveToolScope(state);
    const binding = await resolveToolWorkerTransportLease({ ...action, lease });
    await assertToolWorkerTransportBinding({ ...action, lease, binding });
    const transport = Object.freeze({ task: state.task, worker, lease, binding });
    const report = toolTransportDescription(state, transport);
    state.transportHashes = Object.fromEntries([
      'taskHash', 'sourceHash', 'transportBindingHash', 'workerProgramHash', 'shimHash'
    ].map(field => [field, report[field]]));
    state.transport = transport;
    state.phase = 'transport-ready';
    return { toolTransport: transport, report };
  } catch (error) {
    try { await closeLiveToolState(state); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Tool transport startup and exact owned cleanup failed');
    }
    throw error;
  }
}

export async function inspectLiveNativeToolTransport(transport, options = {}) {
  toolActionOptions(options);
  describeLiveNativeToolTransport(transport);
  await assertToolWorkerTransportBinding({ ...transport, signal: options.signal });
  return {
    ...describeLiveNativeToolTransport(transport),
    kind: 'native-live-tool-worker-kernel-observation',
    verification: 'fresh-original-worker-kernel-only', freshWorkerKernelVerification: true
  };
}

function verifiedToolArtifacts(state, description, captured) {
  insist(exactFields(captured, [
    'task', 'taskHash', 'sourceHash', 'artifacts', 'missing', 'captureHash',
    'evidenceScope', 'authenticationVerified', 'liveAccepted', 'nativeDiscoveryVerified'
  ]) && exactFields(captured.task, ['invocationId', 'caseId', 'client', 'arm', 'repeat']) &&
    canonicalJson(captured.task) === canonicalJson(toolCoordinates(state.coordinates)) &&
    captured.taskHash === description.taskHash && captured.sourceHash === description.sourceHash &&
    Array.isArray(captured.artifacts) && Array.isArray(captured.missing) &&
    /^[a-f0-9]{64}$/.test(captured.captureHash) &&
    captured.evidenceScope === 'worker-filesystem-only' && captured.authenticationVerified === false &&
    captured.nativeDiscoveryVerified === false && captured.liveAccepted === false,
  'Worker artifact capture does not bind the original task and source', 'LIVE_TOOL_ARTIFACT_BINDING_MISMATCH');
  const limit = description.limits.artifactBytes;
  insist(Number.isSafeInteger(limit) && limit > 0 && limit <= TOOL_CAPS.artifactBytes,
    'A bounded original worker artifact limit is required', 'LIVE_TOOL_ARTIFACT_LIMIT_UNVERIFIED');
  const targets = new Set(state.artifactTargets);
  const seen = new Set();
  let total = 0;
  for (const artifact of captured.artifacts) {
    insist(exactFields(artifact, ['path', 'bytes', 'sha256', 'content']) &&
      targets.has(artifact.path) && !seen.has(artifact.path) &&
      Buffer.isBuffer(artifact.content) && Number.isSafeInteger(artifact.bytes) &&
      artifact.bytes >= 0 && artifact.content.length === artifact.bytes &&
      hashContent(artifact.content) === artifact.sha256,
    'Worker artifacts must contain exact declared paths and verified bytes', 'LIVE_TOOL_ARTIFACT_INTEGRITY_MISMATCH');
    seen.add(artifact.path);
    total += artifact.bytes;
    insist(total <= limit, 'Worker artifact byte cap exceeded', 'LIVE_TOOL_ARTIFACT_LIMIT_CAP');
  }
  for (const target of captured.missing) {
    insist(typeof target === 'string' && targets.has(target) && !seen.has(target),
      'Missing worker artifacts must be distinct declared targets', 'LIVE_TOOL_ARTIFACT_INTEGRITY_MISMATCH');
    seen.add(target);
  }
  insist(seen.size === targets.size,
    'Worker artifact capture must account for every declared target', 'LIVE_TOOL_ARTIFACT_INTEGRITY_MISMATCH');
  const captureHash = hashContent(JSON.stringify({
    taskHash: captured.taskHash,
    artifacts: captured.artifacts.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    missing: captured.missing
  }));
  insist(captureHash === captured.captureHash,
    'Worker artifact capture hash does not match its ordered metadata', 'LIVE_TOOL_ARTIFACT_INTEGRITY_MISMATCH');
}

function captureToolArtifactBytes(state, captured) {
  const workspace = createWorkspace({ task: state.coordinates });
  let result;
  let failure;
  let failed = false;
  try {
    const artifactRoot = path.join(workspace.directory, 'artifacts');
    fs.mkdirSync(artifactRoot);
    for (const artifact of captured.artifacts) {
      const target = artifact.path.slice('artifacts/'.length);
      const filename = path.join(artifactRoot, ...target.split('/'));
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, artifact.content, { flag: 'wx', mode: 0o600 });
    }
    const checks = liveToolScope(state).tasks[state.index].checks;
    const capture = captureArtifacts({ artifactRoot, checks });
    const expected = new Map(captured.artifacts.map(({ path, bytes, sha256 }) => [
      path.slice('artifacts/'.length), { bytes, sha256 }
    ]));
    for (const target of captured.missing) expected.set(target.slice('artifacts/'.length), null);
    const observed = new Set();
    for (const artifact of capture.artifacts) {
      const target = artifact.target.replaceAll('\\', '/');
      const original = expected.get(target);
      insist(expected.has(target) && (original === null
        ? artifact.state === 'missing'
        : artifact.state === 'present' && artifact.bytes === original.bytes && artifact.sha256 === original.sha256),
      'Host staging does not retain the exact verified worker artifacts', 'LIVE_TOOL_ARTIFACT_STAGING_CHANGED');
      observed.add(target);
    }
    insist(observed.size === expected.size,
      'Host staging must retain every declared worker target', 'LIVE_TOOL_ARTIFACT_STAGING_CHANGED');
    const grading = gradeChecks({ checks, capture });
    result = { capture, grading };
  } catch (error) {
    failure = error;
    failed = true;
  }
  try { destroyWorkspace(workspace); }
  catch (cleanupError) {
    const error = failed
      ? new AggregateError([failure, cleanupError], 'Host artifact capture and exact owned cleanup failed')
      : new LiveEvaluationError('Host artifact cleanup failed', 'LIVE_TOOL_ARTIFACT_CLEANUP_FAILED');
    error.workspace = workspace;
    if (!failed) error.cause = cleanupError;
    throw error;
  }
  if (failed) throw failure;
  return result;
}

export async function captureLiveNativeToolArtifacts(transport, options = {}) {
  toolActionOptions(options);
  const state = liveToolTransport(transport);
  const description = describeLiveNativeToolTransport(transport);
  insist(!state.captureAttempted, 'This original worker has already entered artifact capture',
    'LIVE_TOOL_CAPTURE_ALREADY_ATTEMPTED');
  state.captureAttempted = true;
  await inspectLiveNativeToolTransport(transport, options);
  const captured = await captureToolWorkerArtifacts({
    task: transport.task, worker: transport.worker, signal: options.signal
  });
  let retained;
  try {
    verifiedToolArtifacts(state, description, captured);
    retained = {
      ...captured, task: { ...captured.task }, missing: [...captured.missing],
      artifacts: captured.artifacts.map(artifact => ({ ...artifact, content: Buffer.from(artifact.content) }))
    };
    await inspectLiveNativeToolTransport(transport, options);
    const { capture, grading } = captureToolArtifactBytes(state, retained);
    describeLiveNativeToolTransport(transport);
    return {
      capture, grading,
      report: {
        kind: 'native-live-tool-artifact-capture', contractVersion: 2,
        task: { ...state.coordinates }, taskIndex: state.index,
        taskHash: description.taskHash, sourceHash: description.sourceHash,
        transportBindingHash: description.transportBindingHash,
        workerCaptureHash: retained.captureHash,
        captureId: capture.captureId, declarationsHash: capture.declarationsHash,
        artifactCount: retained.artifacts.length,
        missingTargets: retained.missing.map(target => target.slice('artifacts/'.length)),
        evidenceScope: 'worker-filesystem-only', hostChecksEvaluated: true,
        nativeConsumerVerified: false, nativeRuntimeVerified: false,
        authenticationVerified: false, nativeDiscoveryVerified: false,
        consumptionEnforcementVerified: false, liveAccepted: false
      }
    };
  } finally {
    for (const result of [captured, retained]) {
      if (Array.isArray(result?.artifacts)) {
        for (const artifact of result.artifacts) {
          if (Buffer.isBuffer(artifact?.content)) artifact.content.fill(0);
        }
      }
    }
  }
}

export function assessLiveTaskAdmission(handle, index) {
  const state = owned(handle);
  insist(Number.isInteger(index) && index >= 0 && index < state.tasks.length,
    'A planned native task index is required', 'INVALID_LIVE_TASK_INDEX');
  const report = describeLiveEvaluation(handle);
  const task = { ...state.tasks[index].task };
  const failures = [];
  const fail = (code, message) => failures.push({ class: 'infrastructure', code, message });
  if (!report.baselineApproved) {
    fail('BASELINE_APPROVAL_REQUIRED', 'An explicit human-approved exact baseline is required');
  }
  if (!report.accountConsumptionAuthorized) {
    fail('ACCOUNT_AUTHORIZATION_REQUIRED', 'Current authorization for this exact account-consuming invocation is required');
  }
  fail('NATIVE_TASK_RUNTIME_UNVERIFIED', 'An original runtime inspection bound to this task is required');
  fail('NATIVE_IMAGE_PIN_UNVERIFIED', 'The exact requested native image manifest has not been verified');
  fail('NATIVE_AUTH_CUSTODY_UNAVAILABLE', 'Accepted isolated native authenticated custody is not implemented');
  fail('CREDENTIAL_TOOL_BOUNDARY_UNVERIFIED', 'Independent credential/tool separation has not been established');
  fail('NATIVE_SERVICE_EGRESS_UNVERIFIED', 'Authenticated native provider/proxy compatibility has not been measured');
  fail('NATIVE_HARD_POLICY_UNSUPPORTED', 'The pinned clients do not establish hard aggregate-token, account-charge and all-request guarantees');
  fail('NATIVE_TASK_SUPERVISION_UNVERIFIED', 'Applied native task deadline, output and concurrency supervision has not been established');
  return {
    kind: 'native-live-task-admission', contractVersion: 2,
    task, planHash: report.planHash, profileHash: report.profileHash,
    baselineApproved: report.baselineApproved,
    accountConsumptionAuthorized: report.accountConsumptionAuthorized,
    ready: false, executed: false, liveAccepted: false,
    observedModel: null, observedUsage: null,
    failures
  };
}

function nativePlanningBindings(handle, state, client, options, index) {
  const { boundary, candidate, custody } = options;
  const auth = assertNativeAuthCustody(custody, { evaluation: handle, client });
  const network = describeEgressBoundary(boundary);
  const container = assertEgressCandidate(candidate, { boundary, client });
  insist(network.fixtureOnly === false && container.fixtureOnly === false,
    'Fixture-only boundaries cannot prepare a native live task', 'FIXTURE_NATIVE_BOUNDARY');
  insist(network.status === 'active' && Date.parse(network.expiresAt) > Date.now() &&
    container.boundaryStatus === 'active' && container.expiresAt === network.expiresAt &&
    container.boundaryOwner === network.owner &&
    ['preparing', 'attached'].includes(container.status),
  'An active, unexpired original boundary and usable candidate are required', 'INACTIVE_NATIVE_BOUNDARY');
  const hosts = [...new Set(Object.values(state.report.requestedRoutes)
    .map(route => new URL(route.endpoint).hostname))];
  insist(network.policyHash === createPublicPolicy(hosts).policyHash,
    'The boundary policy does not bind the exact selected native service origins', 'NATIVE_POLICY_BINDING_MISMATCH');
  const authRoot = container.nativeAuthRootLocator?.containerPath;
  insist(typeof authRoot === 'string' && typeof container.proxyURL === 'string',
    'Owned candidate planning locators are required', 'MISSING_NATIVE_PLAN_LOCATORS');
  const bindings = {
    boundary: { owner: network.owner, policyHash: network.policyHash, expiresAt: network.expiresAt },
    candidate: { id: container.id, client, status: container.status, proxyURL: container.proxyURL, authRoot },
    custody: { id: auth.id, bindingHash: auth.bindingHash, phase: auth.phase }
  };
  if (Object.hasOwn(options, 'toolTransport')) {
    const tools = liveToolTransport(options.toolTransport);
    insist(tools.evaluation === handle && tools.index === index,
      'The tool transport must bind this exact original evaluation task', 'LIVE_TOOL_SCOPE_MISMATCH');
    const transport = describeLiveNativeToolTransport(options.toolTransport);
    const fields = ['taskHash', 'sourceHash', 'transportBindingHash'];
    insist(container.toolTransport &&
      fields.every(field => container.toolTransport[field] === transport[field]),
    'The candidate must bind the same original tool transport as this native task',
    'LIVE_TOOL_CANDIDATE_BINDING_MISMATCH');
    bindings.candidate.toolTransport = Object.fromEntries(fields.map(field => [field, transport[field]]));
    bindings.toolTransport = transport;
  } else {
    insist(!Object.hasOwn(container, 'toolTransport'),
      'A tool-attached candidate requires its exact original host tool transport',
      'LIVE_TOOL_CANDIDATE_BINDING_MISMATCH');
  }
  return bindings;
}

export function prepareLiveNativeTask(handle, index, options) {
  const state = owned(handle);
  insist(exactFields(options, ['boundary', 'candidate', 'custody']) ||
    exactFields(options, ['boundary', 'candidate', 'custody', 'toolTransport']),
  'Native planning requires original boundary, candidate and custody handles with optional original tool transport',
  'INVALID_NATIVE_PLAN_OPTIONS');
  const request = readLiveTaskRequest(handle, index);
  const client = request.task.client;
  const bindings = nativePlanningBindings(handle, state, client, options, index);
  const artifactTargets = nativeArtifactTargets(request);
  const specification = nativeBuilders[client]({
    task: request.task, prompt: request.prompt, skill: request.skill, inputs: request.inputs, artifactTargets
  }, {
    model: state.report.requestedRoutes[client].model,
    limits: {
      timeoutMs: state.profile.limits.seconds * 1000,
      ...(client === 'claude-code' ? { maxTurns: state.profile.limits.turns } : {})
    },
    authRoot: bindings.candidate.authRoot, proxyURL: bindings.candidate.proxyURL,
    ...(Object.hasOwn(options, 'toolTransport') ? { toolTransport: options.toolTransport } : {})
  });
  const report = {
    kind: 'native-live-task-preparation', contractVersion: 2,
    invocationId: state.report.invocationId, planHash: state.report.planHash,
    profileHash: state.report.profileHash, taskIndex: index, task: { ...request.task },
    specificationHash: hashObject(specification), bindings,
    requestedModel: state.report.requestedRoutes[client].model,
    requestedServiceOrigin: state.report.requestedRoutes[client].endpoint,
    requestedImage: state.report.requestedImage,
    requestedRuntimeImage: state.report.requestedRoutes[client].runtimeImage ?? null,
    requestedLimits: structuredClone(state.report.requestedLimits),
    artifactTargets, toolTransportPrepared: Object.hasOwn(options, 'toolTransport'),
    prepared: true, executed: false, executionAuthorized: false,
    nativeRuntimeVerified: false, nativeImageAttached: false, authenticationVerified: false,
    credentialToolBoundaryVerified: false, serviceEgressVerified: false,
    limitsVerified: false, consumptionEnforcementVerified: false, liveAccepted: false,
    blockers: [
      'The original native image, executable and compatible UID/layout have not been freshly inspected for this task specification',
      'Intended auth-root and proxy locators are not authenticated custody or verified native connectivity',
      'Native hard turn/token and account-consumption enforcement remain unverified',
      'Preparation cannot authorize execution or supply observed model, prompt, catalog or usage evidence'
    ]
  };
  nativeSpecifications.set(specification, {
    evaluation: handle, index, options: { ...options }, report
  });
  state.nativeSpecifications.add(specification);
  return { specification, report: structuredClone(report) };
}

export function describeLiveNativeTask(specification) {
  const prepared = nativeSpecifications.get(specification);
  insist(prepared, 'Unknown or released native task specification', 'INVALID_NATIVE_TASK_SPECIFICATION');
  const state = owned(prepared.evaluation);
  insist(hashObject(specification) === prepared.report.specificationHash,
    'The original native task specification has changed', 'NATIVE_TASK_SPECIFICATION_CHANGED');
  const bindings = nativePlanningBindings(
    prepared.evaluation, state, state.tasks[prepared.index].task.client, prepared.options, prepared.index
  );
  return { ...structuredClone(prepared.report), bindings };
}

export async function inspectLiveNativeTaskRuntime(specification, options) {
  insist(exactFields(options, ['imageHandle']) || exactFields(options, ['imageHandle', 'manifestObservation']),
    'Native runtime inspection requires an original client image handle and optional original manifest observation',
    'INVALID_NATIVE_RUNTIME_OPTIONS');
  const prepared = nativeSpecifications.get(specification);
  insist(prepared, 'Unknown or released native task specification', 'INVALID_NATIVE_TASK_SPECIFICATION');
  const { boundary, candidate } = prepared.options;
  const client = prepared.report.task.client;
  describeLiveNativeTask(specification);
  const manifestApi = Object.hasOwn(options, 'manifestObservation')
    ? await import('./live-boundary/native-image-manifest.mjs') : null;
  if (manifestApi) {
    await manifestApi.assertNativeImageManifestObservation(options.manifestObservation,
      { client, imageHandle: options.imageHandle });
  }
  if (prepared.options.toolTransport) {
    await inspectLiveNativeToolTransport(prepared.options.toolTransport);
  }
  const candidateAssertion = {
    boundary, client, imageHandle: options.imageHandle,
    ...(prepared.options.toolTransport ? { toolTransport: prepared.options.toolTransport } : {})
  };
  await assertNativeEgressCandidate(candidate, candidateAssertion);
  describeLiveNativeTask(specification);
  const startedAt = Date.now();
  const observed = await inspectNativeEgressCandidate(candidate);
  await assertNativeEgressCandidate(candidate, candidateAssertion);
  if (manifestApi) {
    await manifestApi.assertNativeImageManifestObservation(options.manifestObservation,
      { client, imageHandle: options.imageHandle });
  }
  if (prepared.options.toolTransport) {
    await inspectLiveNativeToolTransport(prepared.options.toolTransport);
  }
  const report = describeLiveNativeTask(specification);
  const manifest = manifestApi
    ? manifestApi.describeNativeImageManifestObservation(options.manifestObservation) : null;
  const native = observed.nativeRuntime;
  const measuredAt = Date.parse(observed.observed?.measuredAt);
  const executable = client === 'opencode' ? specification.binary : specification.executable;
  const nativeUserId = client === 'copilot' ? 10001 : 1000;
  insist(observed.id === report.bindings.candidate.id &&
    observed.boundaryOwner === report.bindings.boundary.owner && observed.client === client &&
    observed.status === 'attached' && observed.networkAttachmentVerified === true &&
    observed.nativeRuntimeVerified === true && native?.client === client &&
    native.candidateId === observed.id && native.owner === observed.boundaryOwner &&
    native.clientVersion === CLIENT_VERSIONS[client] &&
    native.packageVersion === CLIENT_VERSIONS[client] &&
    native.nodeVersion === '22.22.1' && native.uid === nativeUserId && native.gid === nativeUserId &&
    native.executable === executable && native.cwd === specification.cwd &&
    typeof native.resolvedExecutable === 'string' && native.resolvedExecutable.startsWith('/opt/') &&
    /^[a-f0-9]{64}$/.test(native.executableHash) &&
    /^sha256:[a-f0-9]{64}$/.test(observed.image) &&
    observed.imageAuthority?.imageId === observed.image &&
    observed.observed?.policyHash === report.bindings.boundary.policyHash &&
    Number.isFinite(measuredAt) && measuredAt >= startedAt && measuredAt <= Date.now(),
  'Fresh native image, executable, UID/layout and policy observations are required', 'NATIVE_RUNTIME_OBSERVATION_MISMATCH');
  insist(manifest === null || (manifest.client === client && manifest.clientVersion === native.clientVersion &&
    manifest.imageId === observed.image && manifest.dockerImageId === observed.image &&
    /^sha256:[a-f0-9]{64}$/.test(manifest.manifestDigest) &&
    /^sha256:[a-f0-9]{64}$/.test(manifest.configDigest) && manifest.registryManifestVerified === false),
  'The original manifest observation must bind the freshly inspected native client image',
  'NATIVE_IMAGE_MANIFEST_BINDING_MISMATCH');
  const imageMatchesProfile = manifest === null || report.requestedRuntimeImage === null ? null :
    report.requestedRuntimeImage.manifestDigest === manifest.manifestDigest &&
    report.requestedRuntimeImage.configDigest === manifest.configDigest;
  const requestedImageVerified = imageMatchesProfile === true;
  return {
    ...report, kind: 'native-live-task-runtime-observation',
    nativeRuntimeVerified: true, nativeImageAttached: true,
    imageMatchesProfile, requestedImageVerified,
    runtimeObservation: {
      classification: 'credential-free-native-version-help-attachment-only',
      measuredAt: observed.observed.measuredAt, nativeVersionMeasuredAt: native.measuredAt,
      candidateId: native.candidateId, imageId: observed.image,
      client: native.client, clientVersion: native.clientVersion, packageVersion: native.packageVersion,
      nodeVersion: native.nodeVersion, uid: native.uid, gid: native.gid, cwd: native.cwd,
      executable: native.executable, resolvedExecutable: native.resolvedExecutable,
      executableHash: native.executableHash,
      provenance: 'fresh-original-native-candidate-inspection-with-retained-client-image-authority'
    },
    runtimeManifestObservation: manifest === null ? null : {
      client: manifest.client, clientVersion: manifest.clientVersion,
      dockerImageId: manifest.dockerImageId, dockerImageIdType: manifest.dockerImageIdType,
      manifestDigest: manifest.manifestDigest, manifestDigestType: manifest.manifestDigestType,
      configDigest: manifest.configDigest, provenance: manifest.provenance,
      registryManifestVerified: false
    },
    observedModel: null, observedUsage: null,
    blockers: [
      ...report.blockers.filter(blocker =>
        blocker !== 'The original native image, executable and compatible UID/layout have not been freshly inspected for this task specification'),
      ...(requestedImageVerified ? [] : [manifest === null
        ? 'The requested OCI manifest digest is unverified; Docker image ID text alone is not manifest authority'
        : report.requestedRuntimeImage === null
          ? 'An exact per-client local-OCI manifest/config pin is required to compare the observed native image'
          : 'The original native image manifest/config does not match the captured per-client pin']),
      'Runtime inspection observes version/help only; it is not authenticated native task execution'
    ]
  };
}

export function releaseLiveEvaluation(handle) {
  const state = owned(handle);
  insist(state.toolWorkers.size === 0, 'Release owned tool workers before releasing this evaluation',
    'LIVE_TOOL_WORKER_CLEANUP_REQUIRED');
  for (const specification of state.nativeSpecifications) nativeSpecifications.delete(specification);
  state.nativeSpecifications.clear();
  for (const task of state.tasks) for (const file of [...task.inputs, ...task.skill.files]) file.content.fill(0);
  state.tasks.length = 0;
  state.authorization = null;
  state.released = true;
  handles.delete(handle);
}
