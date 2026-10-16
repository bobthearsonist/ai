import { createHash } from 'node:crypto';
import { validateDocument } from '../index.mjs';

const CLIENTS = ['claude-code', 'copilot', 'opencode'];
const ARMS = ['candidate', 'baseline', 'no-skill'];
const VERSIONS = { 'claude-code': '2.1.291', copilot: '1.0.92', opencode: '1.14.28' };

export class TaskMatrixError extends Error {
  constructor(message) { super(message); this.name = 'TaskMatrixError'; }
}

export class TaskReceiptError extends Error {
  constructor(message) { super(message); this.name = 'TaskReceiptError'; }
}

function requireThat(condition, message) {
  if (!condition) throw new TaskMatrixError(message);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function text(value) { return typeof value === 'string' && value.trim().length > 0; }

function freezeData(value) {
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const item of Object.values(value)) freezeData(item);
    Object.freeze(value);
  }
  return value;
}

function relative(value) {
  if (!text(value) || /^[\\/]|^[a-z]:/i.test(value) || /[\x00-\x1f]/.test(value)) return false;
  return value.replaceAll('\\', '/').split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function files(value, label, { nonempty = false, buffers = false, mountRoots = false } = {}) {
  requireThat(Array.isArray(value) && (!nonempty || value.length > 0), `${label} must be an array${nonempty ? ' with files' : ''}`);
  const paths = new Set();
  for (const file of value) {
    requireThat(plain(file) && relative(file.path) &&
      (typeof file.content === 'string' || (buffers && Buffer.isBuffer(file.content))) &&
      (file.executable === undefined || typeof file.executable === 'boolean'), `Invalid ${label} file`);
    requireThat(Object.keys(file).every(key => ['path', 'content', 'executable', ...(mountRoots ? ['mountRoot'] : [])].includes(key)),
      `Unknown ${label} file field`);
    requireThat(!mountRoots || file.mountRoot === undefined || ['home', 'workspace'].includes(file.mountRoot),
      `Invalid ${label} mount root`);
    const normalized = `${file.mountRoot ?? 'workspace'}:${file.path.replaceAll('\\', '/').toLowerCase()}`;
    requireThat(!paths.has(normalized), `Duplicate ${label} file path`);
    requireThat([...paths].every(existing => !existing.startsWith(`${normalized}/`) && !normalized.startsWith(`${existing}/`)),
      `Overlapping ${label} file paths`);
    paths.add(normalized);
  }
}

export function prepareTaskMatrix(tasks, timeoutSeconds, { native = false } = {}) {
  requireThat(Number.isSafeInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 300,
    'Offline task matrix timeout must be an integer from 1 through 300 seconds');
  requireThat(Array.isArray(tasks) && tasks.length > 0 && tasks.length <= 512,
    'Offline task matrix requires 1 through 512 prepared tasks');
  const coordinates = new Set();
  const cases = new Set(), clients = new Set(), arms = new Set();
  const caseFixtures = new Map();
  let invocationId;
  for (const payload of tasks) {
    requireThat(plain(payload) && plain(payload.task), 'Prepared native task payload required');
    requireThat(Object.keys(payload).every(key => (native
      ? ['task', 'prompt', 'skill', 'inputs', 'checks']
      : ['task', 'prompt', 'skill', 'inputs', 'checks', 'mock', 'timeoutMs']).includes(key)),
      'Unknown prepared native task payload field');
    const task = payload.task;
    requireThat(text(task.invocationId) && text(task.caseId) && CLIENTS.includes(task.client) &&
      ARMS.includes(task.arm) && Number.isInteger(task.repeat) && task.repeat >= 1 && task.repeat <= 3 &&
      typeof task.fixtureHash === 'string' && /^[a-f0-9]{64}$/.test(task.fixtureHash),
    'Invalid native task coordinates or fixture hash');
    requireThat(Object.keys(task).every(key =>
      ['invocationId', 'caseId', 'client', 'arm', 'repeat', 'fixtureHash'].includes(key)), 'Unknown native task coordinate field');
    invocationId ??= task.invocationId;
    requireThat(task.invocationId === invocationId, 'Mixed batch invocation IDs');
    const coordinate = JSON.stringify([task.caseId, task.client, task.arm, task.repeat]);
    requireThat(!coordinates.has(coordinate), 'Duplicate native task coordinates');
    coordinates.add(coordinate);
    requireThat(!caseFixtures.has(task.caseId) || caseFixtures.get(task.caseId) === task.fixtureHash,
      'Incompatible fixture hashes within one case');
    caseFixtures.set(task.caseId, task.fixtureHash);
    cases.add(task.caseId); clients.add(task.client); arms.add(task.arm);
    requireThat(text(payload.prompt), 'Native task prompt required');
    requireThat(plain(payload.skill) && text(payload.skill.id), 'Native task skill required');
    requireThat(Object.keys(payload.skill).every(key => ['id', 'files'].includes(key)), 'Unknown native task skill field');
    files(payload.skill.files, 'skill', { nonempty: task.arm !== 'no-skill', buffers: true });
    files(payload.inputs ?? [], 'input', { buffers: true, mountRoots: true });
    requireThat(Array.isArray(payload.checks) && payload.checks.length > 0 &&
      payload.checks.every(check => plain(check) && text(check.id)), 'Native task checks required');
    requireThat(new Set(payload.checks.map(check => check.id)).size === payload.checks.length, 'Duplicate native task check IDs');
    for (const check of payload.checks) {
      try { validateDocument('check', check); }
      catch (error) { throw new TaskMatrixError(error.message); }
    }
    if (!native) {
      requireThat(plain(payload.mock) && typeof payload.mock.loadSkill === 'boolean', 'Explicit offline task mock required');
      requireThat(Object.keys(payload.mock).every(key => ['loadSkill', 'artifacts'].includes(key)), 'Unknown offline task mock field');
      files(payload.mock.artifacts, 'mock artifact');
      requireThat(task.arm !== 'no-skill' || payload.mock.loadSkill === false, 'No-skill task cannot request skill loading');
      requireThat(payload.timeoutMs === undefined || payload.timeoutMs === timeoutSeconds * 1000,
        'Prepared task timeoutMs must match batch timeoutSeconds');
    }
  }
  requireThat(arms.has('candidate') && arms.has('baseline'), 'Candidate and baseline task arms required');
  for (const caseId of cases) for (const client of clients) for (const arm of arms) {
    for (let repeat = 1; repeat <= 3; repeat++) {
      requireThat(coordinates.has(JSON.stringify([caseId, client, arm, repeat])),
        `Missing native task slot: ${caseId}/${client}/${arm}/${repeat}`);
    }
  }
  let prepared;
  try { prepared = structuredClone(tasks); }
  catch { throw new TaskMatrixError('Prepared native task payload must be cloneable data'); }
  for (const [index, payload] of prepared.entries()) {
    payload.inputs ??= [];
    for (const key of ['inputs', 'skill']) {
      const originals = key === 'inputs' ? tasks[index].inputs ?? [] : tasks[index].skill.files;
      const copies = key === 'inputs' ? payload.inputs : payload.skill.files;
      for (const [fileIndex, file] of originals.entries()) {
        if (Buffer.isBuffer(file.content)) copies[fileIndex].content = Buffer.from(file.content);
      }
    }
    payload.timeoutMs = timeoutSeconds * 1000;
    freezeData(payload);
  }
  return { invocationId, tasks: prepared, selection: { cases: [...cases], clients: [...clients], arms: [...arms] } };
}

export function validateTaskReceipt(receipt, payload, executionIds) {
  const fail = message => { throw new TaskReceiptError(message); };
  if (!plain(receipt)) fail('Native callback returned no receipt object');
  if (!text(receipt.executionId)) fail('Native receipt missing execution ID');
  if (executionIds.has(receipt.executionId)) fail('Duplicate native execution ID');
  executionIds.add(receipt.executionId);
  if (receipt.client !== payload.task.client || receipt.clientVersion !== VERSIONS[payload.task.client] ||
      receipt.transport !== 'offline-mock' || receipt.offlineEvidenceOnly !== true ||
      receipt.authenticationVerified !== false || receipt.liveAccepted !== false ||
      receipt.status !== 'completed') fail('Incompatible or incomplete native offline receipt');
  if (!plain(receipt.task) || Object.keys(receipt.task).length !== Object.keys(payload.task).length ||
      !Object.entries(payload.task).every(([key, value]) => receipt.task[key] === value)) {
    fail('Native receipt task coordinates mismatch');
  }
  const promptHash = createHash('sha256').update(payload.prompt).digest('hex');
  if (receipt.promptHash !== promptHash) fail('Native receipt prompt hash mismatch');
  if (typeof receipt.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(receipt.image)) {
    fail('Native receipt missing immutable image identity');
  }
  if (!plain(receipt.trigger) || typeof receipt.trigger.loaded !== 'boolean' ||
      !Array.isArray(receipt.trigger.evidence) ||
      !receipt.trigger.evidence.every(entry => plain(entry) &&
        ['skill-load', 'discovery-audit'].includes(entry.kind) && text(entry.skill) && text(entry.ref))) {
    fail('Native receipt missing structured trigger capture');
  }
  if (!plain(receipt.capture) || !Object.isFrozen(receipt.capture)) {
    fail('Native receipt missing immutable artifact capture');
  }
  if (!Array.isArray(receipt.checks) || !receipt.checks.every(check => plain(check) && text(check.id) &&
      ['passed', 'failed', 'error', 'skipped'].includes(check.status))) {
    fail('Native receipt missing host check outcomes');
  }
  if (receipt.qualityEvaluated === true || receipt.baselineApproved === true ||
      receipt.contractMatrixComplete === true) fail('Native receipt contains unsupported live/evaluation claims');
}

export function describeTaskFailure(error) {
  let name = 'Error', message = 'Non-serializable native callback failure', code, failureClass;
  try { if (typeof error?.name === 'string') name = error.name; } catch {}
  try { message = typeof error?.message === 'string' ? error.message : String(error); } catch {}
  try { if (typeof error?.code === 'string') code = error.code; } catch {}
  try { if (typeof error?.failureClass === 'string') failureClass = error.failureClass; } catch {}
  return {
    name, message, ...(code === undefined ? {} : { code }),
    ...(failureClass === undefined ? {} : { failureClass })
  };
}
