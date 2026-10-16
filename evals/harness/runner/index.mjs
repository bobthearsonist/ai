import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { probeClients } from '../client-probes.mjs';
import { prepareTaskMatrix, validateTaskReceipt, describeTaskFailure, TaskMatrixError, TaskReceiptError } from './tasks.mjs';
export { TaskMatrixError, TaskReceiptError } from './tasks.mjs';
import { prepareNativeMatrix, runNativeLedger, NativeLedgerError } from './native.mjs';
export { NativeLedgerError, NATIVE_LEDGER_LIMITS } from './native.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const SDK_VERSION = '2.4.1';
const SDK_INTEGRITY = 'sha512-cn9m8IiuupbSrTbRsT8ofKhb+j7ppyJ/mAIO0O91FQQfFweGd1Ovowu6rUhXuMDXvMj/uPIYZgeX67tYvnIHGQ==';
const BRIDGE = 'local-skill-eval/offline-callback-v1';
const MODEL = 'offline-probe-only/not-a-model';
const NATIVE_MODEL = 'explicit-host-task-callback/not-a-model';
const sourceHashes = Object.freeze({
  'dist/index.js': '26d60f34d262d465d8f42ff9aa201172ccd19e079f0ceb0e6accf6b0b4dc913f',
  'dist/lib/runner.js': '4a3f03f573ea428b8f858c390d45a4c558506e52f5ba72300365c5c900a8e786',
  'dist/lib/results.js': 'a33b3f14b702043f59c22d42656f96ebfce687054e5c105a142942b5751e838d',
  'dist/lib/agents/index.js': 'fbeb3f541d92b61c7c5cc94bc7d577e82eff9e3f6cf67bbb1afe33707b1e8469',
  'dist/lib/agents/registry.js': 'e37c9ca8165cca5411c6b9620e5b7dcd31566c65af6d4f4daf49e7292805dd6b',
  'dist/lib/agents/plugin/contract.js': '50153be9bb53a36278e42c7c73e70e4c12f044726890e2eb49894da515aba99a'
});
const pending = new Map();
const taskLoaders = {
  'claude-code': () => import('../clients/claude-code/index.mjs'),
  copilot: () => import('../clients/copilot/index.mjs'),
  opencode: () => import('../clients/opencode/index.mjs')
};
let sdkPromise;
let registeredBridge;

export function getSdkProvenance() {
  const packagePath = fileURLToPath(import.meta.resolve('@vercel/agent-eval/package.json'));
  const installed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
  const entry = lock.packages['node_modules/@vercel/agent-eval'];
  if (installed.name !== '@vercel/agent-eval' || installed.version !== SDK_VERSION ||
      installed.exports?.['.']?.default !== './dist/index.js' ||
      manifest.dependencies?.['@vercel/agent-eval'] !== SDK_VERSION ||
      entry?.version !== SDK_VERSION ||
      entry.resolved !== 'https://registry.npmjs.org/@vercel/agent-eval/-/agent-eval-2.4.1.tgz' ||
      entry.integrity !== SDK_INTEGRITY) {
    throw new Error('Pinned public SDK package/lock provenance mismatch');
  }
  for (const [filename, expected] of Object.entries(sourceHashes)) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(path.dirname(packagePath), filename))).digest('hex');
    if (actual !== expected) throw new Error(`Pinned SDK callback source mismatch: ${filename}`);
  }
  return {
    package: '@vercel/agent-eval', version: SDK_VERSION,
    resolved: entry.resolved, integrity: entry.integrity,
    publicApis: ['registerAgent', 'runSingleEval'],
    sourceHashes: { ...sourceHashes },
    retries: 0, sdkSandboxCreated: false, sdkJudgeInvoked: false
  };
}

async function loadSdk() {
  const provenance = getSdkProvenance();
  sdkPromise ??= import('@vercel/agent-eval');
  const sdk = await sdkPromise;
  if (!registeredBridge) {
    if (sdk.listAgents().includes(BRIDGE)) throw new Error('Offline SDK registry name already occupied');
    const unsupported = () => { throw new Error('SDK sandbox/auth orchestration is not supported by the offline callback bridge'); };
    const definition = Object.freeze({
      name: BRIDGE, displayName: 'Local deterministic offline callback',
      defaultModel: MODEL, o11yAgentName: 'offline-callback', runnerPath: fileURLToPath(import.meta.url),
      requiresWebResearch: false, supportsCrossAgentJudge: false,
      getApiKeyEnvVar: unsupported, install: unsupported, configFiles: unsupported, authEnv: unsupported
    });
    registeredBridge = {
      name: BRIDGE, displayName: definition.displayName, definition,
      getApiKeyEnvVar: unsupported, getDefaultModel: () => MODEL,
      async run(fixturePath, options) {
        const task = pending.get(options.agentOptions?.executionId);
        if (!task || task.calls !== 0 || fixturePath !== directory ||
            options.model !== (task.invokeNativeTask ? NATIVE_MODEL : MODEL) || options.apiKey !== '' || options.validation !== 'none' ||
            options.sandbox !== 'docker' || options.judge !== undefined ||
            options.prompt !== (task.payload?.prompt ?? 'Run the existing deterministic offline client probe.') ||
            options.timeout !== task.timeoutSeconds * 1000) {
          throw new Error('Unissued, repeated or incompatible offline SDK callback');
        }
        task.calls++;
        const started = performance.now();
        if (task.invokeNativeTask) {
          task.receipt = await task.invokeNativeTask(task.payload, {
            attemptId: options.agentOptions.executionId, signal: task.signal
          });
          return {
            success: true, duration: performance.now() - started,
            output: 'Explicit host task callback returned; no native authentication or acceptance established'
          };
        }
        if (task.payload) {
          const adapter = await (task.loadClient ?? (client => taskLoaders[client]()))(task.client);
          if (typeof adapter?.runOfflineTask !== 'function') throw new Error('Native offline task adapter not implemented');
          task.receipt = await adapter.runOfflineTask(task.payload);
          return {
            success: true, duration: performance.now() - started,
            output: 'Native offline callback returned; not semantic acceptance'
          };
        }
        task.report = await probeClients({
          clients: [task.client], timeoutSeconds: task.timeoutSeconds
        }, task.loadClient ? { loadClient: task.loadClient } : {});
        return {
          success: true, duration: performance.now() - started,
          output: 'Deterministic offline client probe validated',
          transcript: JSON.stringify(task.report),
          testResult: { success: true, output: 'Offline adapter invariants validated; not a live skill evaluation' }
        };
      }
    };
    sdk.registerAgent(registeredBridge);
  }
  if (sdk.getAgent(BRIDGE) !== registeredBridge) throw new Error('Offline SDK registry identity mismatch');
  return { sdk, provenance };
}

// This is callback-route evidence, not the three-repeat case/client/arm matrix.
export async function runOfflineSdkProbes({ clients = ['claude-code', 'copilot', 'opencode'], timeoutSeconds = 180 } = {}, {
  loadClient
} = {}) {
  if (!Array.isArray(clients) || clients.length === 0 || new Set(clients).size !== clients.length ||
      !clients.every(client => ['claude-code', 'copilot', 'opencode'].includes(client))) {
    throw new Error('Offline SDK proof requires unique supported clients');
  }
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
    throw new Error('Offline SDK proof timeout must be an integer from 1 through 300 seconds');
  }
  if (loadClient !== undefined && typeof loadClient !== 'function') throw new Error('Invalid test client loader');
  const { sdk, provenance } = await loadSdk();
  const invocationId = randomUUID();
  const runs = [];
  for (const client of [...clients]) {
    const executionId = randomUUID();
    const task = { client, timeoutSeconds, loadClient, calls: 0, report: undefined };
    pending.set(executionId, task);
    try {
      const data = await sdk.runSingleEval({
        name: `offline-${client}`, path: directory, prompt: 'Run the existing deterministic offline client probe.', isModule: true
      }, {
        agent: BRIDGE, model: MODEL, timeout: timeoutSeconds, apiKey: '',
        validation: 'none', sandbox: 'docker', agentOptions: { executionId }
      });
      if (task.calls !== 1 || !task.report || data.result.status !== 'passed' ||
          data.transcript !== JSON.stringify(task.report) ||
          !Number.isFinite(data.result.duration) || data.result.duration < 0) {
        throw new Error('SDK callback execution/result correspondence mismatch');
      }
      runs.push({ executionId, client, callbackCount: task.calls, sdkResult: data.result, report: task.report });
    } finally {
      pending.delete(executionId);
    }
  }
  return {
    invocationId, createdAt: new Date().toISOString(), provenance,
    evidenceSource: loadClient ? 'injected-test-callbacks' : 'actual-native-offline-probes',
    transport: 'offline-mock', offlineEvidenceOnly: true,
    liveAccepted: false, authenticationVerified: false, baselineApproved: false,
    qualityEvaluated: false, contractMatrixComplete: false, runs
  };
}

export function requireLiveRunner() {
  throw new Error('Live runner unavailable: explicit native auth, isolation, trusted v2 captures and approved baseline integration remain required');
}

export async function runOfflineTaskMatrix({ tasks, timeoutSeconds = 180 } = {}, { loadClient } = {}) {
  const prepared = prepareTaskMatrix(tasks, timeoutSeconds);
  if (loadClient !== undefined && typeof loadClient !== 'function') throw new TaskMatrixError('Invalid test client loader');
  const { sdk, provenance } = await loadSdk();
  const attempts = [];
  const executionIds = new Set();
  for (const payload of prepared.tasks) {
    const attemptId = randomUUID();
    const context = { client: payload.task.client, timeoutSeconds, loadClient, payload, calls: 0 };
    const row = { attemptId, task: payload.task, callbackCount: 0, status: 'incomplete' };
    pending.set(attemptId, context);
    try {
      const sdkData = await sdk.runSingleEval({
        name: `offline-task-${payload.task.caseId}`, path: directory, prompt: payload.prompt, isModule: true
      }, {
        agent: BRIDGE, model: MODEL, timeout: timeoutSeconds, apiKey: '',
        validation: 'none', sandbox: 'docker', agentOptions: { executionId: attemptId }
      });
      row.sdkResult = sdkData.result;
      if (context.calls !== 1 || sdkData.result.status !== 'passed' ||
          !Number.isFinite(sdkData.result.duration) || sdkData.result.duration < 0) {
        throw new TaskReceiptError('SDK task callback/result correspondence mismatch');
      }

      validateTaskReceipt(context.receipt, payload, executionIds);
      row.status = 'completed';
    } catch (error) {
      const failure = describeTaskFailure(error);
      row.status = error instanceof TaskReceiptError ? 'incomplete' :
        failure.name === 'TimeoutError' || ['TIMEOUT', 'ETIMEDOUT'].includes(failure.code) ||
          failure.failureClass === 'timeout' ? 'timeout' : 'error';
      row.error = failure;
    } finally {
      row.callbackCount = context.calls;
      if (context.receipt !== undefined) row.receipt = context.receipt;
      pending.delete(attemptId);
      attempts.push(row);
    }
  }
  return {
    invocationId: prepared.invocationId, createdAt: new Date().toISOString(), provenance,
    evidenceSource: loadClient ? 'injected-test-callbacks' : 'actual-native-offline-task-callbacks',
    transport: 'offline-mock', offlineEvidenceOnly: true,
    liveAccepted: false, authenticationVerified: false, baselineApproved: false,
    qualityEvaluated: false, contractMatrixComplete: false,
    selection: prepared.selection, plannedTaskCount: prepared.tasks.length, attemptedTaskCount: attempts.length,
    allReceiptsCompleted: attempts.every(row => row.status === 'completed'), attempts
  };
}

export async function runNativeTaskMatrix(options = {}) {
  const prepared = prepareNativeMatrix(options);
  let loaded;
  try { loaded = await loadSdk(); }
  catch { throw new NativeLedgerError('SDK_UNAVAILABLE'); }
  return runNativeLedger(prepared, loaded.provenance, async (payload, signal, attemptId) => {
    const context = {
      client: payload.task.client, timeoutSeconds: prepared.timeoutSeconds,
      payload, calls: 0, invokeNativeTask: prepared.invokeNativeTask, signal
    };
    pending.set(attemptId, context);
    let sdkResult, failed = false, failureCode = 'CALLBACK_ERROR';
    try {
      if (loaded.sdk.getAgent(BRIDGE) !== registeredBridge) throw new NativeLedgerError('SDK_CORRESPONDENCE');
      const data = await loaded.sdk.runSingleEval({
        name: 'explicit-host-task-callback', path: directory, prompt: payload.prompt, isModule: true
      }, {
        agent: BRIDGE, model: NATIVE_MODEL, timeout: prepared.timeoutSeconds, apiKey: '',
        validation: 'none', sandbox: 'docker', agentOptions: { executionId: attemptId }
      });
      sdkResult = data.result;
    } catch (failure) {
      failed = true;
      if (context.calls === 0) failureCode = 'SDK_CORRESPONDENCE';
      else {
        try {
          if (failure?.name === 'TimeoutError' || ['TIMEOUT', 'ETIMEDOUT'].includes(failure?.code)) failureCode = 'TIMEOUT';
          else if (failure?.name === 'AbortError' || failure?.code === 'CANCELLED') failureCode = 'CANCELLED';
        } catch {}
      }
    } finally { pending.delete(attemptId); }
    return { callbackCount: context.calls, receipt: context.receipt, sdkResult, failed, failureCode };
  });
}
