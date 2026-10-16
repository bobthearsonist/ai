import path from 'node:path';
import {
  canonicalJson, hashContent
} from './index.mjs';
import {
  assessLiveTaskAdmission, describeLiveEvaluation, LiveEvaluationError, readLiveTaskRequest
} from './live-execution.mjs';
import { createWorkspace, destroyWorkspace, writeEvidence } from './isolation/index.mjs';

const attemptedEvaluations = new WeakSet();
const matrices = new WeakMap();

function insist(condition, message, code) {
  if (!condition) throw new LiveEvaluationError(message, code);
}

function sourceError(error) {
  return {
    name: error?.name === 'LiveEvaluationError' ? error.name : 'NativeSchedulingError',
    code: error?.name === 'LiveEvaluationError' ? error.code : 'NATIVE_SCHEDULING_FAILED',
    message: error?.name === 'LiveEvaluationError' ? error.message : 'Pinned host scheduling failed before native execution',
    messageHash: hashContent(String(error?.message ?? error))
  };
}

export async function executeLiveCaseMatrix(handle, options = {}) {
  insist(options !== null && typeof options === 'object' && !Array.isArray(options) &&
    Object.getPrototypeOf(options) === Object.prototype &&
    Object.keys(options).every(key => key === 'signal') &&
    (options.signal === undefined || options.signal instanceof AbortSignal),
  'Live dispatch accepts only an optional host AbortSignal, not executors, credentials or admission assertions',
  'INVALID_LIVE_DISPATCH_OPTIONS');
  const prepared = describeLiveEvaluation(handle);
  insist(!attemptedEvaluations.has(handle), 'This original evaluation has already entered dispatch',
    'LIVE_EVALUATION_ALREADY_ATTEMPTED');
  const tasks = Array.from({ length: prepared.taskSessionCount }, (_, index) => readLiveTaskRequest(handle, index));
  const indexes = new Map(tasks.map((payload, index) => [canonicalJson(payload.task), index]));
  insist(indexes.size === tasks.length, 'Native dispatch requires unique planned coordinates', 'DUPLICATE_LIVE_TASK');
  attemptedEvaluations.add(handle);
  const admissions = new Map();
  const callbackFailures = new Map();
  let ledger = null;
  let schedulingError = null;
  try {
    const { runNativeTaskMatrix } = await import('./runner/index.mjs');
    ledger = await runNativeTaskMatrix({
      tasks, timeoutSeconds: prepared.requestedLimits.seconds, signal: options.signal,
      invokeNativeTask: async (payload, { attemptId }) => {
        try {
          const index = indexes.get(canonicalJson(payload.task));
          insist(index !== undefined, 'The SDK callback is not a planned native task', 'LIVE_TASK_BINDING_MISMATCH');
          const admission = assessLiveTaskAdmission(handle, index);
          admissions.set(attemptId, admission);
          insist(admission.ready, 'Native task dispatch is blocked by its measured admission requirements',
            'LIVE_NATIVE_ADMISSION_BLOCKED');
          throw new LiveEvaluationError('An admitted native task executor is not installed', 'NATIVE_EXECUTOR_UNAVAILABLE');
        } catch (error) {
          callbackFailures.set(attemptId, sourceError(error));
          throw error;
        }
      }
    });
    insist(ledger.kind === 'native-task-scheduling-ledger' &&
      ledger.invocationId === prepared.invocationId &&
      ledger.plannedTaskCount === tasks.length && ledger.recordedTaskCount === tasks.length &&
      ledger.evidenceSource === 'explicit-host-task-callbacks' &&
      ledger.authenticationVerified === false && ledger.liveAccepted === false &&
      ledger.baselineApproved === false && ledger.contractMatrixComplete === false &&
      ledger.qualityEvaluated === false &&
      canonicalJson(ledger.selection) === canonicalJson(prepared.selection) &&
      Array.isArray(ledger.attempts) && ledger.attempts.length === tasks.length &&
      new Set(ledger.attempts.map(attempt => attempt.attemptId)).size === tasks.length &&
      Number.isInteger(ledger.attemptedTaskCount) &&
      ledger.attemptedTaskCount === ledger.attempts.reduce((total, attempt) => total + attempt.callbackCount, 0),
    'The pinned SDK returned incompatible host scheduling evidence', 'LIVE_SCHEDULING_EVIDENCE_MISMATCH');
  } catch (error) {
    schedulingError = sourceError(error);
  } finally {
    for (const payload of tasks) {
      for (const file of [...payload.inputs, ...payload.skill.files]) file.content.fill(0);
    }
  }
  const executions = tasks.map((payload, index) => {
    const attempt = schedulingError ? null : ledger.attempts[index];
    const matching = attempt && canonicalJson(attempt.task) === canonicalJson(payload.task) &&
      [0, 1].includes(attempt.callbackCount) && attempt.status !== 'completed' &&
      /^[a-f0-9]{64}$/.test(attempt.sourceAudit?.payloadSha256) &&
      Number.isSafeInteger(attempt.sourceAudit?.payloadMetadataBytes) && attempt.sourceAudit.payloadMetadataBytes > 0;
    const admission = matching ? admissions.get(attempt.attemptId) : null;
    const callbackFailure = matching ? callbackFailures.get(attempt.attemptId) : null;
    const cancelled = matching && attempt.status === 'cancelled' && attempt.callbackCount === 0;
    const failures = schedulingError
      ? [{ class: 'infrastructure', ...schedulingError }]
      : admission
        ? structuredClone(admission.failures)
        : callbackFailure
          ? [{ class: 'infrastructure', ...callbackFailure }]
        : [{
          class: 'infrastructure',
          code: cancelled ? 'CANCELLED_BEFORE_NATIVE_DISPATCH' : 'LIVE_SCHEDULING_EVIDENCE_MISMATCH',
          message: cancelled ? 'Scheduling was cancelled before native dispatch' : 'A blocked host callback has no compatible admission evidence'
        }];
    return {
      attemptId: matching ? attempt.attemptId : null,
      task: { ...payload.task },
      snapshotId: payload.task.arm === 'no-skill' ? null : prepared.snapshotIds[payload.task.arm],
      status: cancelled ? 'cancelled' : admission ? 'blocked' : 'infrastructure-error',
      dispatched: false, executionId: null,
      model: { requested: prepared.requestedRoutes[payload.task.client].model, observed: null },
      discovery: { status: 'missing', loaded: null, evidence: [] },
      checks: payload.checks.map(check => ({ id: check.id, class: check.class, status: 'error', evidence: null })),
      capture: null, usage: null,
      hostScheduling: matching ? {
        callbackCount: attempt.callbackCount, status: attempt.status,
        elapsedMs: attempt.elapsedMs ?? null,
        sourceAudit: structuredClone(attempt.sourceAudit),
        error: attempt.error ? structuredClone(attempt.error) : null,
        callbackFailure: callbackFailure ? structuredClone(callbackFailure) : null
      } : null,
      admission: admission ? structuredClone(admission) : null,
      failures
    };
  });
  const report = {
    kind: 'native-live-dispatch-diagnostics', contractVersion: 2,
    invocationId: prepared.invocationId, suiteId: prepared.suiteId,
    createdAt: new Date().toISOString(), selection: prepared.selection,
    planHash: prepared.planHash, profileHash: prepared.profileHash, snapshotIds: prepared.snapshotIds,
    evidenceSource: 'host-admission-gates/not-native-task-execution',
    executed: false, authenticationVerified: false, credentialToolBoundaryVerified: false,
    serviceEgressVerified: false, limitsVerified: false, consumptionEnforcementVerified: false,
    liveAccepted: false, contractMatrixComplete: false, baselineCompared: false,
    baselineApproved: prepared.baselineApproved,
    plannedTaskCount: tasks.length, recordedTaskCount: executions.length,
    hostCallbackCount: schedulingError ? admissions.size : ledger.attemptedTaskCount,
    attemptedTaskCount: 0, nativeDispatchedTaskCount: 0, completedTaskCount: 0,
    blockedTaskCount: executions.filter(execution => execution.status === 'blocked').length,
    cancelledTaskCount: executions.filter(execution => execution.status === 'cancelled').length,
    schedulingError, provenance: schedulingError ? null : structuredClone(ledger.provenance),
    exitCode: 1, executions,
    failureCount: executions.reduce((total, execution) => total + execution.failures.length, 0)
  };
  const matrix = Object.freeze({ report: structuredClone(report) });
  matrices.set(matrix, { report, persisted: false });
  return matrix;
}

export function persistLiveCaseMatrix(matrix) {
  const state = matrices.get(matrix);
  insist(state && !state.persisted, 'An original, not-yet-persisted live dispatch matrix is required',
    'INVALID_LIVE_DISPATCH_MATRIX');
  const { report } = state;
  const workspace = createWorkspace({ task: report.executions[0].task });
  try {
    const references = report.executions.map((execution, index) => {
      const evidenceFile = writeEvidence(workspace, execution, {
        name: `executions/${String(index + 1).padStart(4, '0')}.json`
      });
      return {
        attemptId: execution.attemptId, task: { ...execution.task },
        executionId: null, status: execution.status, dispatched: false,
        failureCount: execution.failures.length, failure: execution.failures[0],
        evidenceFile: path.relative(workspace.directory, evidenceFile)
      };
    });
    const { executions, ...summary } = report;
    const manifest = { ...structuredClone(summary), formatVersion: 1, executions: references };
    const reportFile = writeEvidence(workspace, manifest, { name: 'matrix.json' });
    state.persisted = true;
    return { workspace, reportFile, manifest };
  } catch (error) {
    try { destroyWorkspace(workspace); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Live dispatch evidence write and owned cleanup failed'); }
    throw error;
  }
}
