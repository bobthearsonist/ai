import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { prepareTaskMatrix } from './tasks.mjs';

export const NATIVE_LEDGER_LIMITS = Object.freeze({
  tasks: 512, timeoutSeconds: 300, filesPerTask: 64, fileBytes: 65536,
  promptBytes: 65536, checksPerTask: 128, checkBytes: 65536,
  payloadBytes: 1048576, batchPayloadBytes: 8388608,
  receiptBytes: 1048576, batchReceiptBytes: 8388608,
  receiptNodes: 16384, receiptDepth: 16
});

const messages = Object.freeze({
  TASK_MATRIX_INVALID: 'Native scheduling task matrix rejected',
  CALLBACK_REQUIRED: 'Explicit host task callback required',
  SIGNAL_INVALID: 'Native scheduling AbortSignal rejected',
  SDK_UNAVAILABLE: 'Pinned public SDK scheduling preflight failed',
  CALLBACK_ERROR: 'Host task callback failed',
  CANCELLED: 'Native scheduling cancelled',
  TIMEOUT: 'Host task callback exceeded cooperative deadline',
  RECEIPT_INVALID: 'Host task callback returned incomplete receipt evidence',
  RECEIPT_LIMIT: 'Host task callback receipt exceeded evidence limits',
  DUPLICATE_EXECUTION_ID: 'Host task callback reused a reported execution ID',
  RECEIPT_MUTATED: 'Host task callback receipt changed during scheduling',
  PAYLOAD_MUTATED: 'Host task callback changed prepared input bytes',
  SDK_CORRESPONDENCE: 'SDK callback count or result correspondence failed'
});

export class NativeLedgerError extends Error {
  constructor(code) {
    const knownCode = Object.hasOwn(messages, code) ? code : 'CALLBACK_ERROR';
    super(messages[knownCode]);
    this.name = 'NativeLedgerError';
    this.code = knownCode;
  }
}

const fail = code => { throw new NativeLedgerError(code); };
const plain = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = value => typeof value === 'string' && value.trim().length > 0;
const bytes = value => Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);

function rejectSeed(file) {
  const components = file.path.replaceAll('\\', '/').toLowerCase().split('/');
  const first = components[0];
  if (components.some(component => /[:]/.test(component) || /[. ]$/.test(component) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(component))) fail('TASK_MATRIX_INVALID');
  if (['.git', '.claude', '.claude.json', '.claude-plugin', '.github', '.copilot', '.opencode', '.vscode', '.ssh', '.aws', '.azure', '.kube', '.config',
    '.gitconfig', '.npmrc', '.netrc', '.env', '.mcp.json', 'mcp.json', 'agents.md', 'claude.md', 'gemini.md',
    'opencode.json', 'opencode.jsonc'].includes(first)) fail('TASK_MATRIX_INVALID');
  if (/^\.env(?:\.|$)/.test(first)) fail('TASK_MATRIX_INVALID');
  if (components.some(component => ['.git', '.ssh', '.aws', '.azure', '.kube'].includes(component))) {
    fail('TASK_MATRIX_INVALID');
  }
}

export function prepareNativeMatrix(options = {}) {
  if (!plain(options) || !Object.keys(options).every(key => ['tasks', 'timeoutSeconds', 'invokeNativeTask', 'signal'].includes(key))) {
    fail('TASK_MATRIX_INVALID');
  }
  const { tasks, timeoutSeconds = 180, invokeNativeTask, signal } = options;
  if (typeof invokeNativeTask !== 'function') fail('CALLBACK_REQUIRED');
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('SIGNAL_INVALID');
  let totalBytes = 0;
  try {
    if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > NATIVE_LEDGER_LIMITS.tasks) fail('TASK_MATRIX_INVALID');
    for (const payload of tasks) {
      inspectData(payload, { maxBytes: NATIVE_LEDGER_LIMITS.payloadBytes, requireEnumerable: true });
      if (!plain(payload) || typeof payload.prompt !== 'string' || !plain(payload.skill) ||
          !Array.isArray(payload.skill.files) || !Array.isArray(payload.inputs ?? []) ||
          !Array.isArray(payload.checks) || payload.checks.length > NATIVE_LEDGER_LIMITS.checksPerTask) {
        fail('TASK_MATRIX_INVALID');
      }
      const files = [...payload.skill.files, ...(payload.inputs ?? [])];
      if (files.length > NATIVE_LEDGER_LIMITS.filesPerTask || bytes(payload.prompt) > NATIVE_LEDGER_LIMITS.promptBytes) {
        fail('TASK_MATRIX_INVALID');
      }
      let payloadBytes = bytes(payload.prompt) +
        Buffer.byteLength(JSON.stringify({ task: payload.task, skillId: payload.skill.id }));
      for (const file of files) {
        if (!plain(file) || typeof file.path !== 'string' ||
            !(typeof file.content === 'string' || Buffer.isBuffer(file.content)) ||
            bytes(file.content) > NATIVE_LEDGER_LIMITS.fileBytes) fail('TASK_MATRIX_INVALID');
        rejectSeed(file);
        payloadBytes += bytes(file.content) + Buffer.byteLength(file.path);
      }
      for (const file of payload.skill.files) {
        const content = Buffer.isBuffer(file.content) ? file.content.toString('utf8') : file.content;
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
        if (frontmatter && /^\s*(?:allowed-tools|hooks|context|agent)\s*:/im.test(frontmatter[1])) fail('TASK_MATRIX_INVALID');
      }
      const checkBytes = Buffer.byteLength(JSON.stringify(payload.checks));
      if (checkBytes > NATIVE_LEDGER_LIMITS.checkBytes) fail('TASK_MATRIX_INVALID');
      payloadBytes += checkBytes;
      if (payloadBytes > NATIVE_LEDGER_LIMITS.payloadBytes) fail('TASK_MATRIX_INVALID');
      totalBytes += payloadBytes;
      if (totalBytes > NATIVE_LEDGER_LIMITS.batchPayloadBytes) fail('TASK_MATRIX_INVALID');
    }
    const prepared = prepareTaskMatrix(tasks, timeoutSeconds, { native: true });
    const payloadAudits = prepared.tasks.map(payload => inspectData(payload));
    if (payloadAudits.reduce((sum, audit) => sum + audit.metadataBytes, 0) > NATIVE_LEDGER_LIMITS.batchPayloadBytes) {
      fail('TASK_MATRIX_INVALID');
    }
    return { ...prepared, payloadAudits, timeoutSeconds, invokeNativeTask, signal };
  } catch (error) {
    if (error instanceof NativeLedgerError && error.code === 'TASK_MATRIX_INVALID') throw error;
    fail('TASK_MATRIX_INVALID');
  }
}

// Hash bounded data descriptors without invoking getters or copying receipt handles.
function inspectData(root, { maxBytes = NATIVE_LEDGER_LIMITS.receiptBytes, requireEnumerable = false } = {}) {
  const hash = createHash('sha256');
  let metadataBytes = 0, nodes = 0;
  const ancestors = new Set();
  function append(value) {
    const size = Buffer.byteLength(value);
    metadataBytes += size;
    if (metadataBytes > maxBytes) fail('RECEIPT_LIMIT');
    hash.update(value);
  }
  function visit(value, depth) {
    if (++nodes > NATIVE_LEDGER_LIMITS.receiptNodes || depth > NATIVE_LEDGER_LIMITS.receiptDepth) fail('RECEIPT_LIMIT');
    if (value === null || ['string', 'boolean', 'number', 'undefined'].includes(typeof value)) {
      if (typeof value === 'number' && !Number.isFinite(value)) fail('RECEIPT_INVALID');
      if (typeof value === 'string' && Buffer.byteLength(value) > maxBytes - metadataBytes) fail('RECEIPT_LIMIT');
      append(`${typeof value}:${JSON.stringify(value)};`);
      return;
    }
    if (Buffer.isBuffer(value)) {
      metadataBytes += value.length;
      if (metadataBytes > maxBytes) fail('RECEIPT_LIMIT');
      append(`buffer:${value.length}:`); hash.update(value); return;
    }
    if ((!plain(value) && !Array.isArray(value)) || ancestors.has(value)) fail('RECEIPT_INVALID');
    ancestors.add(value);
    append(Array.isArray(value) ? 'array{' : Object.getPrototypeOf(value) === null ? 'null-object{' : 'object{');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || !Object.hasOwn(descriptors[key], 'value')) fail('RECEIPT_INVALID');
      if (requireEnumerable && !descriptors[key].enumerable && !(Array.isArray(value) && key === 'length')) {
        fail('RECEIPT_INVALID');
      }
      append(`${JSON.stringify(key)}:`);
      append(`${Number(descriptors[key].enumerable)}${Number(descriptors[key].writable)}${Number(descriptors[key].configurable)};`);
      visit(descriptors[key].value, depth + 1);
    }
    append('};');
    ancestors.delete(value);
  }
  visit(root, 0);
  return { sha256: hash.digest('hex'), metadataBytes };
}

function inspectReceipt(receipt) {
  try { return inspectData(receipt); }
  catch (error) {
    if (error instanceof NativeLedgerError) throw error;
    fail('RECEIPT_INVALID');
  }
}

function validateReceipt(receipt, payload, executionIds) {
  if (!plain(receipt)) fail('RECEIPT_INVALID');
  if (!text(receipt.executionId)) fail('RECEIPT_INVALID');
  if (executionIds.has(receipt.executionId)) fail('DUPLICATE_EXECUTION_ID');
  executionIds.add(receipt.executionId);
  if (receipt.client !== payload.task.client || receipt.status !== 'completed' ||
      !plain(receipt.task) || Object.keys(receipt.task).length !== Object.keys(payload.task).length ||
      !Object.entries(payload.task).every(([key, value]) => receipt.task[key] === value) ||
      receipt.promptHash !== createHash('sha256').update(payload.prompt).digest('hex') ||
      !plain(receipt.capture) || !Object.isFrozen(receipt.capture)) fail('RECEIPT_INVALID');
  if ((receipt.clientVersion !== undefined && !text(receipt.clientVersion)) ||
      (receipt.image !== undefined && !/^sha256:[a-f0-9]{64}$/.test(receipt.image))) fail('RECEIPT_INVALID');
}

function errorEvidence(code) {
  const error = new NativeLedgerError(code);
  return { name: error.name, code: error.code, message: error.message };
}

export async function runNativeLedger(prepared, provenance, runSlot) {
  const attempts = [], audits = [];
  const executionIds = new Set();
  let receiptBytes = 0;
  for (const [index, payload] of prepared.tasks.entries()) {
    const attemptId = randomUUID();
    const row = {
      attemptId, task: payload.task, callbackCount: 0, status: 'incomplete',
      sourceAudit: { payloadSha256: prepared.payloadAudits[index].sha256, payloadMetadataBytes: prepared.payloadAudits[index].metadataBytes }
    };
    if (prepared.signal?.aborted) {
      row.status = 'cancelled'; row.error = errorEvidence('CANCELLED'); attempts.push(row); continue;
    }
    const controller = new AbortController();
    let cancelled = false, deadlineExceeded = false;
    const cancel = () => { cancelled = true; controller.abort(new NativeLedgerError('CANCELLED')); };
    prepared.signal?.addEventListener('abort', cancel, { once: true });
    if (prepared.signal?.aborted) cancel();
    const started = performance.now();
    const timer = setTimeout(() => {
      deadlineExceeded = true; controller.abort(new NativeLedgerError('TIMEOUT'));
    }, prepared.timeoutSeconds * 1000);
    let result;
    const before = prepared.payloadAudits[index].sha256;
    try {
      if (cancelled) { row.status = 'cancelled'; row.error = errorEvidence('CANCELLED'); continue; }
      result = await runSlot(payload, controller.signal, attemptId);
      row.callbackCount = result.callbackCount;
      if (result.sdkResult) row.sdkResult = {
        status: result.sdkResult.status === 'passed' ? 'passed' : 'failed',
        duration: Number.isFinite(result.sdkResult.duration) ? result.sdkResult.duration : null
      };
      row.elapsedMs = performance.now() - started;
      deadlineExceeded ||= row.elapsedMs >= prepared.timeoutSeconds * 1000;
      let receiptError;
      if (result.receipt !== undefined) {
        try {
          const audit = inspectReceipt(result.receipt);
          receiptBytes += audit.metadataBytes;
          if (receiptBytes > NATIVE_LEDGER_LIMITS.batchReceiptBytes) fail('RECEIPT_LIMIT');
          row.receipt = result.receipt;
          row.receiptAudit = {
            ...audit, captureIdentityRetained: plain(result.receipt?.capture) && Object.isFrozen(result.receipt.capture),
            mutationDetected: false
          };
          audits.push({ row, receipt: result.receipt, capture: result.receipt?.capture, audit });
          validateReceipt(result.receipt, payload, executionIds);
        } catch (error) {
          receiptError = error instanceof NativeLedgerError ? error.code : 'RECEIPT_INVALID';
          if (receiptError === 'RECEIPT_LIMIT') row.receiptOmitted = true;
        }
      } else receiptError = 'RECEIPT_INVALID';
      if (cancelled) { row.status = 'cancelled'; row.error = errorEvidence('CANCELLED'); }
      else if (deadlineExceeded) { row.status = 'timeout'; row.error = errorEvidence('TIMEOUT'); }
      else if (before !== inspectData(payload).sha256) {
        row.status = 'incomplete'; row.error = errorEvidence('PAYLOAD_MUTATED');
      } else if (result.failed) {
        row.status = result.failureCode === 'TIMEOUT' ? 'timeout' :
          result.failureCode === 'CANCELLED' ? 'cancelled' : 'error';
        row.error = errorEvidence(result.failureCode);
      } else if (row.callbackCount !== 1 || result.sdkResult?.status !== 'passed' ||
          !Number.isFinite(result.sdkResult.duration) || result.sdkResult.duration < 0) {
        row.status = 'incomplete'; row.error = errorEvidence('SDK_CORRESPONDENCE');
      } else if (receiptError) {
        row.status = 'incomplete'; row.error = errorEvidence(receiptError);
      } else row.status = 'completed';
    } catch (error) {
      row.status = cancelled ? 'cancelled' : deadlineExceeded ? 'timeout' : 'incomplete';
      row.error = errorEvidence(cancelled ? 'CANCELLED' : deadlineExceeded ? 'TIMEOUT' :
        error instanceof NativeLedgerError ? error.code : 'RECEIPT_INVALID');
    } finally {
      clearTimeout(timer);
      prepared.signal?.removeEventListener('abort', cancel);
      if (deadlineExceeded && !controller.signal.aborted) controller.abort(new NativeLedgerError('TIMEOUT'));
      attempts.push(row);
    }
  }
  let retainedReceiptBytes = 0;
  for (const entry of audits) {
    try {
      const current = inspectReceipt(entry.receipt);
      retainedReceiptBytes += current.metadataBytes;
      if (retainedReceiptBytes > NATIVE_LEDGER_LIMITS.batchReceiptBytes) fail('RECEIPT_LIMIT');
      if (current.sha256 !== entry.audit.sha256 || entry.receipt?.capture !== entry.capture) {
        fail('RECEIPT_MUTATED');
      }
    } catch (error) {
      entry.row.receiptAudit.mutationDetected = true;
      if (entry.row.status === 'completed') {
        entry.row.status = 'incomplete'; entry.row.error = errorEvidence('RECEIPT_MUTATED');
      } else entry.row.receiptMutationError = errorEvidence('RECEIPT_MUTATED');
      if (error instanceof NativeLedgerError && error.code === 'RECEIPT_LIMIT') {
        delete entry.row.receipt; entry.row.receiptOmitted = true;
      }
    }
  }
  const counts = Object.fromEntries(['completed', 'error', 'timeout', 'cancelled', 'incomplete']
    .map(status => [status, attempts.filter(row => row.status === status).length]));
  return {
    kind: 'native-task-scheduling-ledger', ledgerId: randomUUID(),
    invocationId: prepared.invocationId, createdAt: new Date().toISOString(), provenance,
    evidenceSource: 'explicit-host-task-callbacks', authenticationVerified: false,
    liveAccepted: false, baselineApproved: false, qualityEvaluated: false, contractMatrixComplete: false,
    selection: prepared.selection, plannedTaskCount: prepared.tasks.length,
    recordedTaskCount: attempts.length, attemptedTaskCount: attempts.filter(row => row.callbackCount > 0).length,
    allReceiptsCompleted: counts.completed === prepared.tasks.length, counts, attempts
  };
}
