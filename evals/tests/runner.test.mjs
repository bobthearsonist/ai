import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import {
  getSdkProvenance, runOfflineSdkProbes, requireLiveRunner,
  runOfflineTaskMatrix, TaskMatrixError, TaskReceiptError,
  runNativeTaskMatrix, NativeLedgerError, NATIVE_LEDGER_LIMITS
} from '../harness/runner/index.mjs';

const versions = { 'claude-code': '2.1.291', copilot: '1.0.92', opencode: '1.14.28' };
const validReport = client => ({
  client, clientVersion: versions[client], pilotWritesVerified: true,
  offlineEvidenceOnly: true, transport: 'offline-mock', liveAccepted: false,
  qualityEvaluated: false
});

test('published pinned SDK provenance and public exports are verified', () => {
  const provenance = getSdkProvenance();
  assert.equal(provenance.version, '2.4.1');
  assert.deepEqual(provenance.publicApis, ['registerAgent', 'runSingleEval']);
  assert.equal(Object.keys(provenance.sourceHashes).length, 6);
  assert.match(provenance.integrity, /^sha512-/);
  assert.equal(provenance.retries, 0);
});

test('actual public SDK invokes all three deterministic callbacks exactly once', async () => {
  const calls = [];
  const report = await runOfflineSdkProbes({ timeoutSeconds: 123 }, {
    loadClient: async client => ({
      runOfflineProbe(options) {
        calls.push(client);
        assert.deepEqual(options, { timeoutMs: 123000, artifactTargets: ['answer.md', 'message.txt'] });
        return validReport(client);
      }
    })
  });
  assert.deepEqual(calls, ['claude-code', 'copilot', 'opencode']);
  assert.equal(report.evidenceSource, 'injected-test-callbacks');
  assert.equal(report.contractMatrixComplete, false);
  assert.equal(report.liveAccepted, false);
  assert.equal(report.authenticationVerified, false);
  assert.equal(report.baselineApproved, false);
  assert.equal(new Set(report.runs.map(run => run.executionId)).size, 3);
  for (const run of report.runs) {
    assert.equal(run.callbackCount, 1);
    assert.equal(run.sdkResult.status, 'passed');
    assert.equal(run.report.reports[0].client, run.client);
  }
});

test('fresh invocations cannot reuse execution identities', async () => {
  const options = { clients: ['copilot'] };
  const dependencies = { loadClient: client => ({ runOfflineProbe: () => validReport(client) }) };
  const first = await runOfflineSdkProbes(options, dependencies);
  const second = await runOfflineSdkProbes(options, dependencies);
  assert.notEqual(first.invocationId, second.invocationId);
  assert.notEqual(first.runs[0].executionId, second.runs[0].executionId);
});

test('fast callback failure is not retried, and later clients are not launched', async () => {
  let count = 0;
  await assert.rejects(runOfflineSdkProbes({}, {
    loadClient: () => ({
      runOfflineProbe() { count++; throw new Error('fixture 429 or fast infrastructure failure'); }
    })
  }), /fixture 429/);
  assert.equal(count, 1);
});

test('live-shaped, mismatched or incomplete callback reports fail closed', async () => {
  for (const patch of [
    { clientVersion: 'unpinned' }, { pilotWritesVerified: false }, { liveAccepted: true },
    { qualityEvaluated: true }, { transport: 'live' }, { status: 'timeout' }, { error: 'denial failed' }
  ]) {
    await assert.rejects(runOfflineSdkProbes({ clients: ['copilot'] }, {
      loadClient: client => ({ runOfflineProbe: () => ({ ...validReport(client), ...patch }) })
    }), /incompatible or live-shaped evidence/);
  }
  await assert.rejects(runOfflineSdkProbes({ clients: ['copilot'] }, { loadClient: () => ({}) }), /not implemented/);
});

test('invalid selections/limits cannot reach a callback', async () => {
  const loadClient = () => { throw new Error('must not load'); };
  for (const options of [
    { clients: [] }, { clients: ['copilot', 'copilot'] }, { clients: ['unknown'] },
    { timeoutSeconds: 0 }, { timeoutSeconds: 301 }, { timeoutSeconds: 1.5 }
  ]) await assert.rejects(runOfflineSdkProbes(options, { loadClient }), /unique supported|timeout/);
  assert.throws(requireLiveRunner, /Live runner unavailable/);
});

test('the SDK bridge rejects unissued direct callbacks and registry replacement', async () => {
  const require = createRequire(new URL('../harness/runner/index.mjs', import.meta.url));
  const sdk = await import(pathToFileURL(require.resolve('@vercel/agent-eval')).href);
  const name = 'local-skill-eval/offline-callback-v1';
  const original = sdk.getAgent(name);
  await assert.rejects(original.run('', { agentOptions: { executionId: 'not-issued' } }), /Unissued/);
  sdk.registerAgent({ ...original, run() { throw new Error('replacement must not execute'); } });
  try {
    await assert.rejects(runOfflineSdkProbes({ clients: ['copilot'] }), /registry identity mismatch/);
  } finally {
    sdk.registerAgent(original);
  }
});

test('actual native offline probes traverse the published SDK callback route', {
  skip: process.env.EVAL_RUNNER_NATIVE_OFFLINE !== '1',
  timeout: 1200000
}, async () => {
  const report = await runOfflineSdkProbes({ timeoutSeconds: 180 });
  assert.equal(report.evidenceSource, 'actual-native-offline-probes');
  assert.equal(report.runs.length, 3);
  assert.equal(report.liveAccepted, false);
  assert.ok(report.runs.every(run => run.callbackCount === 1 && run.report.reports[0].pilotWritesVerified));
});

function taskPayloads({ clients = ['copilot'], cases = ['example'], arms = ['candidate', 'baseline'] } = {}) {
  const invocationId = randomUUID();
  return cases.flatMap(caseId => clients.flatMap(client => arms.flatMap(arm =>
    [1, 2, 3].map(repeat => ({
      task: { invocationId, caseId, client, arm, repeat, fixtureHash: 'a'.repeat(64) },
      prompt: `Caller-owned task ${caseId}`,
      skill: { id: 'fixture-skill', files: [{ path: 'SKILL.md', content: 'Explicit fixture skill bytes' }] },
      inputs: [{ path: 'input.txt', content: Buffer.from('Explicit caller input'), mountRoot: 'home' }],
      checks: [{ id: 'artifact', class: 'correctness', type: 'artifact-contains', target: 'answer.md', expected: 'expected-only-in-check' }],
      mock: { loadSkill: arm !== 'no-skill', artifacts: [{ path: 'answer.md', content: 'independent-scripted-output' }] }
    }))
  )));
}

function taskReceipt(payload, executionId = randomUUID()) {
  return {
    client: payload.task.client, clientVersion: versions[payload.task.client],
    executionId, task: { ...payload.task },
    promptHash: createHash('sha256').update(payload.prompt).digest('hex'),
    image: `sha256:${'b'.repeat(64)}`,
    transport: 'offline-mock', offlineEvidenceOnly: true,
    authenticationVerified: false, liveAccepted: false, status: 'completed',
    trigger: { loaded: false, evidence: [{ kind: 'discovery-audit', skill: payload.skill.id, ref: 'trusted-test-audit' }] },
    capture: Object.freeze({ fixtureHandle: randomUUID() }),
    checks: [{ id: 'artifact', status: 'failed' }]
  };
}

test('task matrix executes exact three-repeat Cartesian matrix without grading and retains raw receipts', async () => {
  const tasks = taskPayloads({ clients: ['claude-code', 'copilot', 'opencode'], cases: ['one', 'two'], arms: ['candidate', 'baseline', 'no-skill'] });
  const receipts = [], handles = new WeakMap();
  let active = 0, maximumActive = 0;
  const result = await runOfflineTaskMatrix({ tasks, timeoutSeconds: 123 }, {
    loadClient: client => ({
      async runOfflineTask(payload) {
        active++; maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        assert.equal(payload.task.client, client);
        assert.equal(payload.timeoutMs, 123000);
        assert.ok(Buffer.isBuffer(payload.inputs[0].content));
        assert.equal(payload.mock.artifacts[0].content, 'independent-scripted-output');
        assert.notEqual(payload.mock.artifacts[0].content, payload.checks[0].expected);
        const receipt = taskReceipt(payload);
        handles.set(receipt.capture, 'trusted-test-receipt');
        receipts.push(receipt); active--;
        return receipt;
      }
    })
  });
  assert.equal(result.attemptedTaskCount, 54);
  assert.equal(maximumActive, 1);
  assert.equal(result.invocationId, tasks[0].task.invocationId);
  assert.equal(result.evidenceSource, 'injected-test-callbacks');
  assert.equal(result.allReceiptsCompleted, true);
  assert.equal(result.contractMatrixComplete, false);
  assert.equal(new Set(result.attempts.map(row => row.attemptId)).size, 54);
  for (const [index, row] of result.attempts.entries()) {
    assert.equal(row.status, 'completed');
    assert.equal(row.callbackCount, 1);
    assert.equal(row.receipt, receipts[index]);
    assert.equal(handles.get(row.receipt.capture), 'trusted-test-receipt');
    assert.equal(row.receipt.checks[0].status, 'failed');
  }
});

test('task matrix continues every slot after adapter errors, timeouts and incomplete receipts', async () => {
  let calls = 0;
  const result = await runOfflineTaskMatrix({ tasks: taskPayloads() }, {
    loadClient: () => ({
      runOfflineTask(payload) {
        calls++;
        if (calls === 1) throw new Error('fast 429 infrastructure failure');
        if (calls === 2) { const error = new Error('timed out'); error.code = 'TIMEOUT'; throw error; }
        if (calls === 3) return null;
        return taskReceipt(payload);
      }
    })
  });
  assert.equal(calls, 6);
  assert.deepEqual(result.attempts.map(row => row.status), ['error', 'timeout', 'incomplete', 'completed', 'completed', 'completed']);
  assert.equal(result.allReceiptsCompleted, false);
  assert.equal(result.attempts[0].error.message, 'fast 429 infrastructure failure');
  assert.equal(result.attempts[1].error.code, 'TIMEOUT');
  assert.equal(result.attempts[2].receipt, null);
  assert.equal(result.attempts[2].error.name, 'TaskReceiptError');
  assert.ok(!Object.hasOwn(result.attempts[0], 'receipt'));
  assert.ok(!Object.hasOwn(result.attempts[0], 'sdkResult'));
  assert.equal(new Set(result.attempts.map(row => row.attemptId)).size, 6);
});

test('task matrix records duplicate native IDs and inconsistent provenance without manufacturing replacements', async () => {
  const executionId = randomUUID();
  let calls = 0;
  const result = await runOfflineTaskMatrix({ tasks: taskPayloads() }, {
    loadClient: () => ({
      runOfflineTask(payload) {
        const receipt = taskReceipt(payload, calls++ < 2 ? executionId : randomUUID());
        if (calls === 3) receipt.liveAccepted = true;
        if (calls === 4) receipt.task.repeat = 2;
        if (calls === 5) receipt.promptHash = 'c'.repeat(64);
        if (calls === 6) delete receipt.executionId;
        return receipt;
      }
    })
  });
  assert.equal(result.attempts[0].status, 'completed');
  assert.ok(result.attempts.slice(1).every(row => row.status === 'incomplete'));
  assert.match(result.attempts[1].error.message, /Duplicate native execution/);
  assert.equal(result.attempts[1].receipt.executionId, executionId);
  assert.ok(!Object.hasOwn(result.attempts[5].receipt, 'executionId'));
});

test('task matrix prevalidates every slot before SDK or client loading', async () => {
  let calls = 0;
  const dependencies = { loadClient: () => { calls++; throw new Error('must not load'); } };
  const invalid = [
    [], Array(513).fill(taskPayloads()[0]), taskPayloads().slice(0, 5),
    taskPayloads({ arms: ['candidate'] }),
    taskPayloads({ clients: ['copilot', 'opencode'] }).filter(payload => !(payload.task.client === 'opencode' && payload.task.arm === 'baseline'))
  ];
  for (const change of [
    payload => { payload.task.repeat = 4; },
    payload => { payload.task.client = 'unknown'; },
    payload => { payload.task.invocationId = randomUUID(); },
    payload => { payload.task.fixtureHash = 'not-a-hash'; },
    payload => { payload.skill.files[0].path = '..\\unsafe'; },
    payload => { payload.inputs[0].mountRoot = 'host'; },
    payload => { payload.mock = undefined; },
    payload => { payload.checks[0].type = 'AI-judge'; },
    payload => { payload.timeoutMs = 999; }
  ]) {
    const tasks = taskPayloads();
    change(tasks[tasks.length - 1]);
    invalid.push(tasks);
  }
  const duplicate = taskPayloads();
  duplicate[5] = duplicate[4];
  invalid.push(duplicate);
  const missingCrossPair = [
    ...taskPayloads({ clients: ['copilot'], cases: ['one'] }),
    ...taskPayloads({ clients: ['opencode'], cases: ['two'] })
  ];
  for (const payload of missingCrossPair) payload.task.invocationId = missingCrossPair[0].task.invocationId;
  invalid.push(missingCrossPair);
  for (const tasks of invalid) {
    await assert.rejects(runOfflineTaskMatrix({ tasks }, dependencies), TaskMatrixError);
  }
  for (const timeoutSeconds of [0, 301, 1.5]) {
    await assert.rejects(runOfflineTaskMatrix({ tasks: taskPayloads(), timeoutSeconds }, dependencies), TaskMatrixError);
  }
  assert.equal(calls, 0);
});

test('missing task adapters are explicit per-slot failures and all slots remain attempted', async () => {
  const result = await runOfflineTaskMatrix({ tasks: taskPayloads() }, { loadClient: () => ({}) });
  assert.equal(result.attemptedTaskCount, 6);
  assert.ok(result.attempts.every(row => row.status === 'error' && row.callbackCount === 1 &&
    /not implemented/.test(row.error.message) && !Object.hasOwn(row, 'receipt')));
  assert.ok(TaskReceiptError.prototype instanceof Error);
});

test('no-skill slots admit an explicitly empty skill file list without weakening required arms', async () => {
  const tasks = taskPayloads({ arms: ['candidate', 'baseline', 'no-skill'] });
  for (const payload of tasks) if (payload.task.arm === 'no-skill') payload.skill.files = [];
  const result = await runOfflineTaskMatrix({ tasks }, {
    loadClient: () => ({ runOfflineTask: payload => taskReceipt(payload) })
  });
  assert.equal(result.allReceiptsCompleted, true);
  tasks[0].skill.files = [];
  await assert.rejects(runOfflineTaskMatrix({ tasks }), TaskMatrixError);
});

test('task matrix honors timeout boundaries and bounded registry reuse at maximum complete matrix size', async () => {
  const require = createRequire(new URL('../harness/runner/index.mjs', import.meta.url));
  const sdk = await import(pathToFileURL(require.resolve('@vercel/agent-eval')).href);
  const names = sdk.listAgents();
  for (const timeoutSeconds of [1, 300]) {
    const tasks = taskPayloads({ cases: timeoutSeconds === 300 ? Array.from({ length: 85 }, (_, index) => `case-${index}`) : ['one'] });
    const result = await runOfflineTaskMatrix({ tasks, timeoutSeconds }, {
      loadClient: () => ({
        runOfflineTask(payload) {
          assert.equal(payload.timeoutMs, timeoutSeconds * 1000);
          return taskReceipt(payload);
        }
      })
    });
    assert.equal(result.attemptedTaskCount, tasks.length);
    assert.equal(result.allReceiptsCompleted, true);
  }
  assert.deepEqual(sdk.listAgents(), names);
});

test('non-Error callback failures cannot interrupt later matrix slots', async () => {
  let calls = 0;
  const result = await runOfflineTaskMatrix({ tasks: taskPayloads() }, {
    loadClient: () => ({
      runOfflineTask(payload) {
        calls++;
        if (calls === 1) throw Object.create(null);
        if (calls === 2) throw 'explicit string failure';
        return taskReceipt(payload);
      }
    })
  });
  assert.equal(calls, 6);
  assert.equal(result.attempts[0].error.message, 'Non-serializable native callback failure');
  assert.equal(result.attempts[1].error.message, 'explicit string failure');
  assert.equal(result.attempts[5].status, 'completed');
});

function nativePayloads(options) {
  return taskPayloads(options).map(({ mock, ...payload }) => payload);
}

test('native ledger uses exact matrix and original captures without upgrading explicit callbacks', async () => {
  const tasks = nativePayloads({ clients: ['claude-code', 'copilot', 'opencode'] });
  const receipts = [], handles = new WeakMap();
  let active = 0;
  const ledger = await runNativeTaskMatrix({
    tasks,
    invokeNativeTask: async (payload, context) => {
      assert.ok(context.signal instanceof AbortSignal);
      assert.equal(context.signal.aborted, false);
      assert.match(context.attemptId, /^[a-f0-9-]{36}$/);
      assert.equal(payload.timeoutMs, 180000);
      assert.ok(!Object.hasOwn(payload, 'mock'));
      assert.equal(active++, 0);
      await Promise.resolve();
      const receipt = taskReceipt(payload);
      receipt.transport = 'caller-claimed-native-service';
      receipt.authenticationVerified = true;
      receipt.liveAccepted = true;
      receipt.extraMetadata = { nativeWireHash: 'd'.repeat(64) };
      handles.set(receipt.capture, 'original-capture');
      receipts.push(receipt); active--;
      return receipt;
    }
  });
  assert.equal(ledger.kind, 'native-task-scheduling-ledger');
  assert.equal(ledger.evidenceSource, 'explicit-host-task-callbacks');
  assert.equal(ledger.invocationId, tasks[0].task.invocationId);
  assert.equal(ledger.plannedTaskCount, 18);
  assert.equal(ledger.recordedTaskCount, 18);
  assert.equal(ledger.attemptedTaskCount, 18);
  assert.deepEqual(ledger.counts, { completed: 18, error: 0, timeout: 0, cancelled: 0, incomplete: 0 });
  for (const key of ['authenticationVerified', 'liveAccepted', 'baselineApproved', 'qualityEvaluated', 'contractMatrixComplete']) {
    assert.equal(ledger[key], false);
  }
  for (const [index, row] of ledger.attempts.entries()) {
    assert.equal(row.receipt, receipts[index]);
    assert.equal(handles.get(row.receipt.capture), 'original-capture');
    assert.equal(row.receipt.extraMetadata, receipts[index].extraMetadata);
    assert.equal(row.callbackCount, 1);
    assert.match(row.sourceAudit.payloadSha256, /^[a-f0-9]{64}$/);
    assert.match(row.receiptAudit.sha256, /^[a-f0-9]{64}$/);
  }
});

test('native ledger sanitizes every failure and attempts all slots without echoing callback secrets', async () => {
  let calls = 0;
  const ledger = await runNativeTaskMatrix({
    tasks: nativePayloads(),
    invokeNativeTask() {
      calls++;
      const failure = calls === 2 ? undefined : new Error('caller-secret-token-and-private-prompt');
      if (calls === 3) failure.code = 'ETIMEDOUT';
      if (calls === 4) failure.name = 'AbortError';
      throw failure;
    }
  });
  assert.equal(calls, 6);
  assert.deepEqual(ledger.attempts.map(row => row.status), ['error', 'error', 'timeout', 'cancelled', 'error', 'error']);
  assert.ok(!JSON.stringify(ledger).includes('caller-secret'));
  assert.ok(ledger.attempts.every(row => row.callbackCount === 1 && !Object.hasOwn(row, 'receipt')));
  assert.equal(new Set(ledger.attempts.map(row => row.attemptId)).size, 6);
});

test('native ledger rejects missing/duplicate/mutated receipts and input-byte mutation while preserving identity', async () => {
  const tasks = nativePayloads(), receipts = [];
  let calls = 0;
  const executionId = randomUUID();
  const ledger = await runNativeTaskMatrix({
    tasks,
    invokeNativeTask(payload) {
      calls++;
      if (calls === 2) receipts[0].promptHash = 'e'.repeat(64);
      if (calls === 3) payload.inputs[0].content[0] = 0;
      if (calls === 5) return undefined;
      const receipt = taskReceipt(payload, calls === 1 || calls === 4 ? executionId : randomUUID());
      receipts.push(receipt);
      return receipt;
    }
  });
  assert.deepEqual(ledger.attempts.map(row => row.status), ['incomplete', 'completed', 'incomplete', 'incomplete', 'incomplete', 'completed']);
  assert.equal(ledger.attempts[0].error.code, 'RECEIPT_MUTATED');
  assert.equal(ledger.attempts[0].receipt, receipts[0]);
  assert.equal(ledger.attempts[2].error.code, 'PAYLOAD_MUTATED');
  assert.equal(ledger.attempts[3].error.code, 'DUPLICATE_EXECUTION_ID');
  assert.equal(ledger.attempts[4].error.code, 'RECEIPT_INVALID');
  assert.equal(tasks[2].inputs[0].content.toString(), 'Explicit caller input');
});

test('native ledger prevalidates no-mock/control-plane/caps and rejects unknown options before SDK admission', async () => {
  let calls = 0;
  const invokeNativeTask = () => { calls++; throw new Error('must not execute'); };
  const modifications = [
    payload => { payload.mock = { loadSkill: true, artifacts: [] }; },
    payload => { payload.apiKey = 'caller-secret'; },
    payload => { payload.inputs[0].path = '.claude\\settings.json'; },
    payload => { payload.inputs[0].path = '.github\\copilot-instructions.md'; },
    payload => { payload.inputs[0].path = '.env.local'; },
    payload => { payload.inputs[0].path = '.claude.\\settings.json'; },
    payload => { payload.inputs[0].path = 'file.txt:stream'; },
    payload => { payload.inputs[0].path = '..\\outside'; },
    payload => { payload.skill.files[0].content = '---\nname: fixture\nhooks: {}\n---\nPolicy'; },
    payload => { payload.prompt = 'x'.repeat(NATIVE_LEDGER_LIMITS.promptBytes + 1); },
    payload => { payload.inputs[0].content = Buffer.alloc(NATIVE_LEDGER_LIMITS.fileBytes + 1); },
    payload => { payload.inputs = Array.from({ length: 65 }, (_, index) => ({ path: `file${index}`, content: '' })); },
    payload => { payload.checks = Array.from({ length: 129 }, (_, index) => ({ ...payload.checks[0], id: `check${index}` })); },
    payload => { payload.task.repeat = 4; }
  ];
  for (const modify of modifications) {
    const tasks = nativePayloads();
    modify(tasks[5]);
    await assert.rejects(runNativeTaskMatrix({ tasks, invokeNativeTask }), {
      name: 'NativeLedgerError', code: 'TASK_MATRIX_INVALID', message: 'Native scheduling task matrix rejected'
    });
  }
  await assert.rejects(runNativeTaskMatrix({ tasks: nativePayloads().slice(1), invokeNativeTask }), NativeLedgerError);
  await assert.rejects(runNativeTaskMatrix({ tasks: nativePayloads(), invokeNativeTask, apiKey: 'secret' }), NativeLedgerError);
  await assert.rejects(runNativeTaskMatrix({ tasks: nativePayloads() }), { code: 'CALLBACK_REQUIRED' });
  await assert.rejects(runNativeTaskMatrix({ tasks: nativePayloads(), invokeNativeTask, signal: {} }), { code: 'SIGNAL_INVALID' });
  assert.equal(calls, 0);
});

test('native ledger bounds visible receipt metadata and never invokes receipt getters', async () => {
  let calls = 0, getters = 0;
  const ledger = await runNativeTaskMatrix({
    tasks: nativePayloads(),
    invokeNativeTask(payload) {
      const receipt = taskReceipt(payload);
      if (++calls === 1) receipt.extra = 'secret'.repeat(NATIVE_LEDGER_LIMITS.receiptBytes);
      if (calls === 2) Object.defineProperty(receipt, 'extra', { get() { getters++; throw new Error('secret'); }, enumerable: true });
      return receipt;
    }
  });
  assert.equal(getters, 0);
  assert.equal(ledger.attempts[0].error.code, 'RECEIPT_LIMIT');
  assert.equal(ledger.attempts[0].receiptOmitted, true);
  assert.ok(!Object.hasOwn(ledger.attempts[0], 'receipt'));
  assert.equal(ledger.attempts[1].error.code, 'RECEIPT_INVALID');
  assert.equal(ledger.counts.completed, 4);
});

test('native ledger relays abort, awaits callback settlement and records every remaining cancelled slot', async () => {
  const controller = new AbortController();
  let calls = 0, settled = false;
  const ledger = await runNativeTaskMatrix({
    tasks: nativePayloads(), signal: controller.signal,
    async invokeNativeTask(payload, { signal }) {
      calls++;
      await new Promise(resolve => {
        signal.addEventListener('abort', () => {
          assert.ok(!String(signal.reason).includes('caller-secret'));
          setTimeout(() => { settled = true; resolve(); }, 10);
        }, { once: true });
        controller.abort('caller-secret-abort-reason');
      });
      return taskReceipt(payload);
    }
  });
  assert.equal(settled, true);
  assert.equal(calls, 1);
  assert.equal(ledger.recordedTaskCount, 6);
  assert.equal(ledger.attemptedTaskCount, 1);
  assert.equal(ledger.counts.cancelled, 6);
  assert.deepEqual(ledger.attempts.map(row => row.callbackCount), [1, 0, 0, 0, 0, 0]);
});

test('native ledger cooperative timeout cannot turn a late receipt into a completed run or overlap slots', async () => {
  let calls = 0, active = false, deadlineObserved = false;
  const ledger = await runNativeTaskMatrix({
    tasks: nativePayloads(), timeoutSeconds: 1,
    async invokeNativeTask(payload, { signal }) {
      assert.equal(active, false);
      active = true;
      if (++calls === 1) {
        await new Promise(resolve => signal.addEventListener('abort', () => {
          deadlineObserved = true;
          setTimeout(resolve, 20);
        }, { once: true }));
      }
      active = false;
      return taskReceipt(payload);
    }
  });
  assert.equal(deadlineObserved, true);
  assert.equal(calls, 6);
  assert.equal(ledger.attempts[0].status, 'timeout');
  assert.equal(ledger.attempts[0].error.code, 'TIMEOUT');
  assert.equal(ledger.attempts[0].receipt.status, 'completed');
  assert.equal(ledger.counts.completed, 5);
  assert.equal(ledger.allReceiptsCompleted, false);
});

test('native ledger pre-aborted batches record all slots without invoking a callback', async () => {
  const controller = new AbortController();
  controller.abort('private-reason');
  const ledger = await runNativeTaskMatrix({
    tasks: nativePayloads(), signal: controller.signal,
    invokeNativeTask() { throw new Error('must not invoke'); }
  });
  assert.equal(ledger.counts.cancelled, 6);
  assert.equal(ledger.attemptedTaskCount, 0);
  assert.equal(ledger.recordedTaskCount, 6);
  assert.ok(ledger.attempts.every(row => row.callbackCount === 0 && !Object.hasOwn(row, 'receipt')));
  assert.ok(!JSON.stringify(ledger).includes('private-reason'));
});
