import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashContent, hashObject, readJson } from '../harness/index.mjs';
import { gradeChecks, readCapturedArtifact } from '../harness/checks/index.mjs';

const childFlag = 'EVAL_LIVE_TOOL_WORKER_UNIT_CHILD';
const clients = ['claude-code', 'copilot', 'opencode'];

async function fixture(t, api, { noSkill = false, seconds } = {}) {
  const { nativeMatrixFixture } = await import('./helpers.mjs');
  const { mockScenarios, ...options } = nativeMatrixFixture(t, { privateContext: true });
  options.invocationId = randomUUID();
  options.selection.clients = clients;
  if (noSkill) options.selection.arms = ['candidate', 'baseline', 'no-skill'];
  options.profile.auth = 'native-client-auth';
  if (seconds !== undefined) options.profile.limits.seconds = seconds;
  for (const [client, pin] of Object.entries(options.profile.clients)) {
    pin.model = {
      'claude-code': 'claude-sonnet-4-6', copilot: 'gpt-4.1', opencode: 'github-copilot/gpt-4.1'
    }[client];
    pin.endpoint = client === 'claude-code' ? 'https://api.anthropic.com' : 'https://api.githubcopilot.com';
    pin.settings = {};
  }
  const suite = readJson(options.suiteFile);
  suite.cases.find(item => item.id === 'explicit').hardChecks.push({
    id: 'host-private-answer', class: 'correctness', type: 'artifact-contains',
    target: 'plan.txt', expected: 'HOST-ANSWER-KEY-NOT-FOR-THE-MODEL'
  });
  fs.writeFileSync(options.suiteFile, JSON.stringify(suite));
  const prepared = api.prepareLiveEvaluation(options);
  const workers = new Set();
  let released = false;
  t.after(async () => {
    const failures = [];
    for (const worker of workers) {
      try { await api.releaseLiveNativeToolWorker(worker); }
      catch (error) { failures.push(error); }
    }
    if (!released && !failures.length) {
      try { api.releaseLiveEvaluation(prepared.handle); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Host tool fixture cleanup failed');
  });
  return {
    ...prepared, options, workers,
    index(client, arm = 'candidate') {
      const index = Array.from({ length: prepared.report.taskSessionCount }, (_, index) => index)
        .find(index => {
          const task = api.readLiveTaskRequest(prepared.handle, index).task;
          return task.client === client && task.arm === arm;
        });
      assert.notEqual(index, undefined);
      return index;
    },
    prepare(index, options) {
      const result = api.prepareLiveNativeToolWorker(prepared.handle, index, options);
      workers.add(result.worker);
      return result;
    },
    async close(worker) {
      const result = await api.releaseLiveNativeToolWorker(worker);
      workers.delete(worker);
      return result;
    },
    release() {
      api.releaseLiveEvaluation(prepared.handle);
      released = true;
    }
  };
}

if (process.env[childFlag] !== '1') {
  const api = await import('../harness/live-execution.mjs');

  test('host preparation maps every client and arm to captured public paths, never private checks', async t => {
    const prepared = await fixture(t, api, { noSkill: true });
    for (const client of clients) for (const arm of ['candidate', 'baseline', 'no-skill']) {
      const index = prepared.index(client, arm);
      const request = api.readLiveTaskRequest(prepared.handle, index);
      const { worker, report } = prepared.prepare(index);
      const expected = [
        ...request.skill.files.map(file => ({
          path: `skills/${request.skill.id}/${file.path.replaceAll('\\', '/')}`,
          bytes: file.content.length, sha256: hashContent(file.content)
        })),
        ...request.inputs.map(file => ({
          path: `inputs/${file.path.replaceAll('\\', '/')}`,
          bytes: file.content.length, sha256: hashContent(file.content)
        }))
      ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      assert.deepEqual(report.publicFiles, expected);
      assert.deepEqual(report.artifactTargets, ['artifacts/plan.txt']);
      assert.deepEqual(report.task, request.task);
      assert.equal(report.taskIndex, index);
      for (const field of ['started', 'nativeAdmissionSupported', 'authenticationVerified',
        'nativeDiscoveryVerified', 'liveAccepted']) assert.equal(report[field], false);
      for (const value of ['PRIVATE-GRADER-DATA', 'HOST-ANSWER-KEY-NOT-FOR-THE-MODEL',
        'candidate skill bytes', 'baseline skill bytes']) {
        assert.equal(JSON.stringify(report).includes(value), false);
      }
      assert.equal(report.publicFiles.some(file => file.path.startsWith('skills/')), arm !== 'no-skill');
      assert.equal((await prepared.close(worker)).exactOwnedCleanup, true);
    }
  });

  test('public preparation copies do not change the captured source bytes or private plan', async t => {
    const prepared = await fixture(t, api);
    const index = prepared.index('copilot');
    const original = api.readLiveTaskRequest(prepared.handle, index);
    assert.ok(original.inputs[0].content.includes(Buffer.from('\r\n')));
    const { worker, report } = prepared.prepare(index);
    report.publicFiles[0].sha256 = 'caller-mutation';
    report.artifactTargets[0] = 'artifacts/caller-mutation';
    const retained = api.readLiveTaskRequest(prepared.handle, index);
    assert.deepEqual(retained.inputs[0].content, original.inputs[0].content);
    assert.deepEqual(retained.skill.files[0].content, original.skill.files[0].content);
    assert.equal(retained.checks.at(-1).expected, 'HOST-ANSWER-KEY-NOT-FOR-THE-MODEL');
    assert.equal(api.describeLiveEvaluation(prepared.handle).liveAccepted, false);
    await prepared.close(worker);
  });

  test('worker timeouts are bounded by both the captured profile and the worker cap', async t => {
    const prepared = await fixture(t, api, { seconds: 1 });
    const index = prepared.index('copilot');
    for (const timeoutMs of [0, -1, 1001, '1', NaN, Infinity, 0.5, undefined]) {
      assert.throws(() => prepared.prepare(index, { limits: { timeoutMs } }),
        error => error.code === 'LIVE_TOOL_LIMIT_CAP');
    }
    const { worker, report } = prepared.prepare(index, { limits: { timeoutMs: 500 } });
    assert.equal(report.limits.timeoutMs, 500);
    await prepared.close(worker);
  });

  test('invalid options, copied evaluations and invalid task indexes fail before worker ownership', async t => {
    const prepared = await fixture(t, api);
    const index = prepared.index('copilot');
    for (const options of [null, [], { publicFiles: [] }, { authenticated: true },
      { limits: null }, { limits: [] }, { limits: 'invalid' }]) {
      assert.throws(() => api.prepareLiveNativeToolWorker(prepared.handle, index, options),
        error => error.code === 'INVALID_LIVE_TOOL_OPTIONS');
    }
    assert.throws(() => api.prepareLiveNativeToolWorker({ ...prepared.handle }, index),
      error => error.code === 'INVALID_LIVE_HANDLE');
    for (const index of [-1, 0.5, prepared.report.taskSessionCount]) {
      assert.throws(() => api.prepareLiveNativeToolWorker(prepared.handle, index),
        error => error.code === 'INVALID_LIVE_TASK_INDEX');
    }
    prepared.release();
  });

  test('invalid worker fields and source caps cannot reserve a slot or bypass worker validation', async t => {
    const { TOOL_CAPS } = await import('../harness/tool-worker/index.mjs');
    assert.equal(TOOL_CAPS.artifactBytes, 131_072);
    const prepared = await fixture(t, api);
    const index = prepared.index('copilot');
    for (const limits of [
      { commands: true }, { outputBytes: 0 }, { fileBytes: '16384' }, { sourceBytes: 1 }
    ]) {
      assert.throws(() => prepared.prepare(index, { limits }), error => {
        assert.equal(error.message.includes('HOST-ANSWER-KEY-NOT-FOR-THE-MODEL'), false);
        return true;
      });
    }
    const { worker } = prepared.prepare(index);
    assert.equal((await prepared.close(worker)).exactOwnedCleanup, true);
    prepared.release();
  });

  test('evaluation release cannot orphan an owned worker; worker cleanup requires its original handle', async t => {
    const prepared = await fixture(t, api);
    const { worker } = prepared.prepare(prepared.index('copilot'));
    assert.throws(() => prepared.release(), error => error.code === 'LIVE_TOOL_WORKER_CLEANUP_REQUIRED');
    await assert.rejects(api.releaseLiveNativeToolWorker({ ...worker }),
      error => error.code === 'INVALID_LIVE_TOOL_WORKER');
    assert.equal((await prepared.close(worker)).exactOwnedCleanup, true);
    await assert.rejects(api.releaseLiveNativeToolWorker(worker),
      error => error.code === 'INVALID_LIVE_TOOL_WORKER');
    prepared.release();
  });

  test('host transport lifecycle wiring uses explicit doubles, never Docker, native clients or authentication', () => {
    const env = { ...process.env, [childFlag]: '1' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', '--test', '--test-reporter=tap', fileURLToPath(import.meta.url)
    ], { encoding: 'utf8', timeout: 30_000, env });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /# tests 20\b/);
    assert.match(result.stdout, /# pass 20\b/);
    assert.match(result.stdout, /# fail 0/);
  });
} else {
  const tasks = new WeakSet();
  const workers = new WeakMap();
  const boundaries = new WeakMap();
  const candidates = new WeakMap();
  const custodies = new WeakMap();
  const builderCalls = [];
  const preparedCalls = [];
  let prepareFailure = false;

  class UnitToolWorkerError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'ToolWorkerError';
      this.code = code;
    }
  }

  const originalWorker = ({ task, worker }) => {
    const state = workers.get(worker);
    assert.ok(tasks.has(task) && state?.task === task, 'Original unit task/worker required');
    return state;
  };
  const originalTransport = tuple => {
    const state = originalWorker(tuple);
    assert.equal(state.phase, 'active', 'Active unit worker required');
    assert.ok(Date.now() < state.deadlineUnixMs, 'Unexpired unit worker required');
    assert.equal(tuple.lease, state.lease, 'Original unit lease required');
    assert.equal(tuple.binding, state.binding, 'Original unit binding required');
    return state;
  };
  const describeTransport = tuple => {
    const state = originalTransport(tuple);
    return {
      kind: 'tool-worker-transport-description', protocol: 'unit-tool-protocol',
      task: { ...state.task.coordinates }, taskHash: state.taskHash, sourceHash: state.sourceHash,
      publicFiles: structuredClone(state.publicFiles), artifactTargets: [...state.artifactTargets],
      limits: { ...state.limits }, deadlineUnixMs: state.deadlineUnixMs, binding: state.binding,
      transportBindingHash: hashObject(state.binding), workerProgramHash: 'a'.repeat(64),
      shimHash: 'b'.repeat(64), planningOnly: true, verification: 'cached-original-identity-only',
      freshKernelVerification: false, nativeAdmissionSupported: false,
      evidenceScope: 'worker-filesystem-only', authenticationVerified: false,
      nativeDiscoveryVerified: false, liveAccepted: false
    };
  };
  const workerModule = new URL('../harness/tool-worker/index.mjs', import.meta.url);
  mock.module(workerModule, {
    cache: true,
    namedExports: {
      TOOL_CAPS: Object.freeze({ timeoutMs: 60_000, artifactBytes: 131_072 }), ToolWorkerError: UnitToolWorkerError,
      issueToolTask(coordinates) {
        const task = Object.freeze({ kind: 'unit-tool-task', coordinates: Object.freeze({ ...coordinates }) });
        tasks.add(task);
        return task;
      },
      prepareToolWorker(options) {
        const { task, publicFiles, artifactTargets, limits } = options;
        assert.ok(tasks.has(task));
        for (const file of publicFiles) assert.deepEqual(Object.keys(file).sort(), ['content', 'path']);
        const files = publicFiles.map(file => ({
          path: file.path, bytes: file.content.length, sha256: hashContent(file.content)
        }));
        const worker = Object.freeze({ kind: 'unit-tool-worker', protocol: 'unit-tool-protocol' });
        workers.set(worker, {
          task, phase: 'prepared', publicFiles: files, artifactTargets: [...artifactTargets],
          limits: { artifactBytes: 131_072, ...limits }, taskHash: hashObject(task.coordinates),
          sourceHash: hashObject({ files, artifactTargets }), actions: [], closeCount: 0,
          lease: null, binding: null
        });
        preparedCalls.push({ task, worker, files, artifactTargets: [...artifactTargets] });
        if (prepareFailure) {
          const error = new UnitToolWorkerError('Unit transactional rollback failed', 'PREPARATION_CLEANUP_FAILED');
          error.worker = worker;
          throw error;
        }
        return worker;
      },
      async startToolWorker(tuple) {
        const state = originalWorker(tuple);
        state.actions.push('start');
        state.phase = 'active';
        state.deadlineUnixMs = Date.now() + state.limits.timeoutMs;
        if (tuple.signal?.aborted || state.fail === 'start') throw new Error('Unit startup failed');
        return { unitOnly: true };
      },
      async leaseToolWorkerTransport(tuple) {
        const state = originalWorker(tuple);
        state.actions.push('lease');
        assert.equal(state.lease, null);
        state.lease = Object.freeze({ kind: 'unit-tool-lease', protocol: 'unit-tool-protocol' });
        state.binding = Object.freeze({ kind: 'unit-tool-binding', taskHash: state.taskHash, sourceHash: state.sourceHash });
        return state.lease;
      },
      async resolveToolWorkerTransportLease(tuple) {
        const state = originalWorker(tuple);
        state.actions.push('resolve');
        assert.equal(tuple.lease, state.lease);
        if (state.fail === 'resolve') throw new Error('Unit transport resolution failed');
        return state.binding;
      },
      async assertToolWorkerTransportBinding(tuple) {
        const state = originalTransport(tuple);
        state.actions.push('assert');
        if (state.beforeAssert) await state.beforeAssert();
        if (state.fail === 'assert') throw new Error('Unit kernel assertion failed');
        return { unitOnly: true, nativeAdmissionSupported: false };
      },
      describeToolWorkerTransportBinding: describeTransport,
      async captureToolWorkerArtifacts(tuple) {
        const state = originalWorker(tuple);
        assert.equal(state.phase, 'active', 'Active unit worker required');
        assert.ok(Date.now() < state.deadlineUnixMs, 'Unexpired unit worker required');
        assert.equal(tuple.signal?.aborted ?? false, false);
        state.actions.push('capture');
        if (state.fail === 'capture') throw new Error('Unit artifact capture failed');
        const artifacts = (state.artifacts ?? []).map(({ path, content }) => {
          const bytes = Buffer.from(content);
          return { path, content: bytes, bytes: bytes.length, sha256: hashContent(bytes) };
        });
        const missing = state.artifactTargets.filter(target => !artifacts.some(artifact => artifact.path === target));
        const captured = {
          task: { ...state.task.coordinates }, taskHash: state.taskHash, sourceHash: state.sourceHash,
          artifacts, missing,
          captureHash: hashContent(JSON.stringify({
            taskHash: state.taskHash,
            artifacts: artifacts.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
            missing
          })),
          evidenceScope: 'worker-filesystem-only', authenticationVerified: false,
          nativeDiscoveryVerified: false, liveAccepted: false
        };
        state.issuedCapture = captured;
        if (state.mutateCapture) state.mutateCapture(captured);
        if (state.afterCapture) await state.afterCapture();
        return captured;
      },
      async closeToolWorker(tuple) {
        const state = originalWorker(tuple);
        state.actions.push('close');
        state.closeCount++;
        if (state.failCleanup) throw new Error('Unit owned cleanup failed');
        state.phase = 'closed';
        return { exactOwnedCleanup: true, unitOnly: true };
      }
    }
  });
  const mockedWorker = await import(workerModule.href);
  assert.equal(mockedWorker.describeToolWorkerTransportBinding, describeTransport);

  for (const client of clients) {
    mock.module(new URL(`../harness/clients/${client}/index.mjs`, import.meta.url), {
      cache: true,
      namedExports: {
        prepareNativeTaskSpecification(payload, options) {
          builderCalls.push({ client, payload, options });
          return Object.freeze({
            task: { ...payload.task }, model: options.model, cwd: '/unit-native-cwd',
            executable: '/opt/unit-only-native-builder', binary: '/opt/unit-only-native-builder',
            toolTransportConfigured: Object.hasOwn(options, 'toolTransport')
          });
        }
      }
    });
  }
  const { createPublicPolicy } = await import('../harness/live-boundary/policy.mjs');
  const forbidden = () => { throw new Error('Native/Docker execution is forbidden in host transport units'); };
  mock.module(new URL('../harness/live-boundary/index.mjs', import.meta.url), {
    cache: true,
    namedExports: {
      describeEgressBoundary(handle) {
        assert.ok(boundaries.has(handle));
        return structuredClone(boundaries.get(handle));
      },
      assertEgressCandidate(handle, { boundary, client }) {
        const state = candidates.get(handle);
        assert.ok(state && state.boundary === boundary && state.description.client === client);
        return structuredClone(state.description);
      },
      assertNativeEgressCandidate: forbidden, inspectNativeEgressCandidate: forbidden
    }
  });
  mock.module(new URL('../harness/auth/custody.mjs', import.meta.url), {
    cache: true,
    namedExports: {
      assertNativeAuthCustody(handle, { evaluation, client }) {
        const state = custodies.get(handle);
        assert.ok(state && state.evaluation === evaluation && state.client === client);
        return { id: handle.id, bindingHash: 'c'.repeat(64), phase: 'prepared-unverified' };
      }
    }
  });
  const api = await import('../harness/live-execution.mjs');

  function nativeBindings(prepared, client, toolTransport) {
    const boundary = Object.freeze({ owner: randomUUID(), kind: 'unit-boundary' });
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    boundaries.set(boundary, {
      owner: boundary.owner, fixtureOnly: false, status: 'active', expiresAt,
      policyHash: createPublicPolicy(['api.anthropic.com', 'api.githubcopilot.com']).policyHash
    });
    const candidate = Object.freeze({ id: randomUUID(), kind: 'unit-candidate' });
    candidates.set(candidate, {
      boundary, description: {
        id: candidate.id, client, boundaryOwner: boundary.owner, fixtureOnly: false,
        status: 'preparing', boundaryStatus: 'active', expiresAt, proxyURL: 'http://172.30.0.2:8080',
        nativeAuthRootLocator: { containerPath: '/unit-empty-auth' },
        ...(toolTransport ? {
          toolTransport: Object.fromEntries(['taskHash', 'sourceHash', 'transportBindingHash']
            .map(field => [field, describeTransport(toolTransport)[field]]))
        } : {})
      }
    });
    const custody = Object.freeze({ id: randomUUID(), kind: 'unit-custody' });
    custodies.set(custody, { evaluation: prepared.handle, client });
    return { boundary, candidate, custody, toolTransport };
  }

  test('startup retains the original tuple and enforces single issuance before any native execution', async t => {
    const prepared = await fixture(t, api);
    const { worker } = prepared.prepare(prepared.index('copilot'));
    const { toolTransport, report } = await api.startLiveNativeToolWorker(worker);
    assert.ok(Object.isFrozen(toolTransport));
    assert.equal(toolTransport.worker, worker);
    assert.deepEqual(workers.get(worker).actions, ['start', 'lease', 'resolve', 'assert']);
    assert.equal(report.freshWorkerKernelVerification, false);
    assert.equal(report.nativeConsumerVerified, false);
    assert.equal(report.liveAccepted, false);
    await assert.rejects(api.startLiveNativeToolWorker(worker),
      error => error.code === 'LIVE_TOOL_WORKER_ALREADY_STARTED');
    assert.equal(workers.get(worker).closeCount, 0);
  });

  test('host planning forwards only the exact scoped original tuple and never checks or answers', async t => {
    const prepared = await fixture(t, api);
    for (const client of clients) {
      const index = prepared.index(client);
      const { worker } = prepared.prepare(index);
      const { toolTransport } = await api.startLiveNativeToolWorker(worker);
      const { specification, report } = api.prepareLiveNativeTask(prepared.handle, index,
        nativeBindings(prepared, client, toolTransport));
      const call = builderCalls.at(-1);
      assert.equal(call.client, client);
      assert.equal(call.options.toolTransport, toolTransport);
      assert.deepEqual(Object.keys(call.payload).sort(), ['artifactTargets', 'inputs', 'prompt', 'skill', 'task']);
      assert.deepEqual(call.payload.artifactTargets, ['plan.txt']);
      assert.equal(report.toolTransportPrepared, true);
      assert.equal(report.bindings.toolTransport.sourceHash, workers.get(worker).sourceHash);
      assert.equal(specification.toolTransportConfigured, true);
      for (const value of ['HOST-ANSWER-KEY-NOT-FOR-THE-MODEL', 'PRIVATE-GRADER-DATA']) {
        assert.equal(JSON.stringify(call.payload).includes(value), false);
        assert.equal(JSON.stringify(report).includes(value), false);
      }
      assert.equal(api.describeLiveNativeTask(specification).liveAccepted, false);
    }
    assert.ok(preparedCalls.every(call => call.files.every(file => !Object.hasOwn(file, 'content'))));
  });

  test('copied tuples and original transports from different slots or evaluations cannot be adopted', async t => {
    const prepared = await fixture(t, api);
    const index = prepared.index('copilot');
    const { worker } = prepared.prepare(index);
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    for (const value of [{ ...toolTransport }, structuredClone(toolTransport), undefined, true]) {
      assert.throws(() => api.describeLiveNativeToolTransport(value));
    }
    assert.throws(() => api.prepareLiveNativeTask(prepared.handle, prepared.index('copilot', 'baseline'),
      nativeBindings(prepared, 'copilot', toolTransport)), error => error.code === 'LIVE_TOOL_SCOPE_MISMATCH');
    const other = await fixture(t, api);
    assert.throws(() => api.prepareLiveNativeTask(other.handle, other.index('copilot'),
      nativeBindings(other, 'copilot', toolTransport)), error => error.code === 'LIVE_TOOL_SCOPE_MISMATCH');
  });

  test('fresh worker assertions remain kernel-only and copied descriptions cannot mutate original scope', async t => {
    const prepared = await fixture(t, api);
    const { worker } = prepared.prepare(prepared.index('copilot'));
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    const report = await api.inspectLiveNativeToolTransport(toolTransport);
    assert.equal(report.freshWorkerKernelVerification, true);
    for (const field of ['nativeConsumerVerified', 'nativeAdmissionSupported', 'authenticationVerified',
      'nativeDiscoveryVerified', 'liveAccepted']) assert.equal(report[field], false);
    report.publicFiles[0].sha256 = 'caller-mutation';
    report.sourceHash = 'caller-mutation';
    assert.notEqual(api.describeLiveNativeToolTransport(toolTransport).sourceHash, 'caller-mutation');
    assert.notEqual(api.describeLiveNativeToolTransport(toolTransport).publicFiles[0].sha256, 'caller-mutation');
    assert.equal(workers.get(worker).actions.filter(action => action === 'assert').length, 2);
  });

  test('metadata, target and immutable identity drift are explicit errors', async t => {
    const prepared = await fixture(t, api);
    const { worker } = prepared.prepare(prepared.index('copilot'));
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    const state = workers.get(worker);
    const originals = structuredClone({
      publicFiles: state.publicFiles, artifactTargets: state.artifactTargets, sourceHash: state.sourceHash
    });
    for (const mutate of [
      () => { state.publicFiles[0].sha256 = 'd'.repeat(64); },
      () => { state.artifactTargets = ['artifacts/foreign.txt']; },
      () => { state.sourceHash = 'e'.repeat(64); }
    ]) {
      Object.assign(state, structuredClone(originals));
      mutate();
      assert.throws(() => api.describeLiveNativeToolTransport(toolTransport),
        error => ['LIVE_TOOL_TRANSPORT_BINDING_MISMATCH', 'LIVE_TOOL_TRANSPORT_CHANGED'].includes(error.code));
    }
    Object.assign(state, originals);
  });

  test('expired and revoked original workers invalidate transport and dependent native specifications', async t => {
    const prepared = await fixture(t, api);
    const index = prepared.index('copilot');
    const { worker } = prepared.prepare(index);
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    const { specification } = api.prepareLiveNativeTask(prepared.handle, index,
      nativeBindings(prepared, 'copilot', toolTransport));
    workers.get(worker).deadlineUnixMs = Date.now() - 1;
    assert.throws(() => api.describeLiveNativeToolTransport(toolTransport), /Unexpired/);
    assert.throws(() => api.describeLiveNativeTask(specification), /Unexpired/);
    await prepared.close(worker);
    assert.throws(() => api.describeLiveNativeToolTransport(toolTransport),
      error => error.code === 'INVALID_LIVE_TOOL_WORKER');
    assert.throws(() => api.describeLiveNativeTask(specification),
      error => error.code === 'INVALID_LIVE_TOOL_WORKER');
  });

  test('startup and cancellation failures await exact owned cleanup before returning errors', async t => {
    for (const failure of ['start', 'resolve', 'assert', 'cancel']) {
      const prepared = await fixture(t, api);
      const { worker } = prepared.prepare(prepared.index('copilot'));
      const state = workers.get(worker);
      state.fail = failure;
      const controller = new AbortController();
      if (failure === 'cancel') controller.abort();
      await assert.rejects(api.startLiveNativeToolWorker(worker, { signal: controller.signal }), /Unit/);
      assert.equal(state.phase, 'closed');
      assert.equal(state.closeCount, 1);
      prepared.workers.delete(worker);
      prepared.release();
    }
  });

  test('failed cleanup retains original recovery ownership instead of releasing the evaluation', async t => {
    const prepared = await fixture(t, api);
    const { worker } = prepared.prepare(prepared.index('copilot'));
    const state = workers.get(worker);
    state.fail = 'start';
    state.failCleanup = true;
    await assert.rejects(api.startLiveNativeToolWorker(worker), error =>
      error instanceof AggregateError && error.errors.length === 2);
    assert.throws(() => prepared.release(), error => error.code === 'LIVE_TOOL_WORKER_CLEANUP_REQUIRED');
    state.failCleanup = false;
    assert.equal((await prepared.close(worker)).exactOwnedCleanup, true);
    prepared.release();
  });

  test('transactional preparation failure preserves the issued original worker for host recovery', async t => {
    const prepared = await fixture(t, api);
    let error;
    prepareFailure = true;
    try { prepared.prepare(prepared.index('copilot')); }
    catch (failure) { error = failure; }
    finally { prepareFailure = false; }
    assert.ok(error instanceof UnitToolWorkerError);
    assert.equal(error.code, 'PREPARATION_CLEANUP_FAILED');
    assert.throws(() => prepared.release(), failure => failure.code === 'LIVE_TOOL_WORKER_CLEANUP_REQUIRED');
    assert.equal((await api.releaseLiveNativeToolWorker(error.worker)).exactOwnedCleanup, true);
    prepared.release();
  });

  test('asynchronous inspections recheck original worker lifecycle and action options', async t => {
    const prepared = await fixture(t, api);
    const { worker } = prepared.prepare(prepared.index('copilot'));
    for (const options of [{ authenticated: true }, { executor: forbidden }, { signal: true }]) {
      await assert.rejects(api.startLiveNativeToolWorker(worker, options),
        error => error.code === 'INVALID_LIVE_TOOL_OPTIONS');
    }
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    workers.get(worker).beforeAssert = async () => { workers.get(worker).phase = 'closed'; };
    await assert.rejects(api.inspectLiveNativeToolTransport(toolTransport), /Active unit worker/);
    assert.equal(api.describeLiveEvaluation(prepared.handle).liveAccepted, false);
  });

  test('worker bytes become original host captures and private checks without native authority', async t => {
    const prepared = await fixture(t, api);
    const index = prepared.index('copilot');
    const request = api.readLiveTaskRequest(prepared.handle, index);
    const { worker } = prepared.prepare(index);
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    const content = Buffer.from('Independent public mock output\r\nHOST-ANSWER-KEY-NOT-FOR-THE-MODEL\r\n');
    workers.get(worker).artifacts = [{ path: 'artifacts/plan.txt', content }];
    const { capture, grading, report } = await api.captureLiveNativeToolArtifacts(toolTransport);
    assert.deepEqual(readCapturedArtifact(capture, 'plan.txt'), content);
    assert.deepEqual(grading, gradeChecks({ checks: request.checks, capture }));
    assert.equal(grading.checks.every(check => check.status === 'passed'), true);
    assert.equal(report.captureId, capture.captureId);
    assert.equal(report.declarationsHash, capture.declarationsHash);
    assert.equal(report.hostChecksEvaluated, true);
    assert.equal(report.artifactCount, 1);
    assert.deepEqual(report.missingTargets, []);
    for (const field of ['nativeConsumerVerified', 'nativeRuntimeVerified', 'authenticationVerified',
      'nativeDiscoveryVerified', 'consumptionEnforcementVerified', 'liveAccepted']) {
      assert.equal(report[field], false);
    }
    for (const value of ['HOST-ANSWER-KEY-NOT-FOR-THE-MODEL', 'PRIVATE-GRADER-DATA']) {
      assert.equal(JSON.stringify(report).includes(value), false);
    }
    content.fill(0);
    assert.notEqual(readCapturedArtifact(capture, 'plan.txt')[0], 0);
    assert.equal(workers.get(worker).issuedCapture.artifacts[0].content.every(byte => byte === 0), true);
    assert.throws(() => gradeChecks({ checks: request.checks, capture: structuredClone(capture) }),
      /original trusted in-process/);
  });

  test('missing worker artifacts remain missing host evidence, never success-shaped output', async t => {
    const prepared = await fixture(t, api);
    const index = prepared.index('copilot');
    const existence = api.readLiveTaskRequest(prepared.handle, index).checks
      .find(check => check.type === 'artifact-exists');
    assert.ok(existence);
    assert.equal(existence.expected, true);
    const { worker } = prepared.prepare(index);
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    const { capture, grading, report } = await api.captureLiveNativeToolArtifacts(toolTransport);
    assert.deepEqual(capture.artifacts, [{ target: 'plan.txt', state: 'missing' }]);
    assert.equal(grading.checks.find(check => check.id === existence.id).status, 'failed');
    assert.equal(grading.checks.find(check => check.id === 'host-private-answer').status, 'error');
    assert.deepEqual(report.missingTargets, ['plan.txt']);
    assert.equal(report.liveAccepted, false);
  });

  test('artifact capture binds content, metadata, declared targets and narrowed byte caps', async t => {
    for (const mutate of [
      captured => { captured.task.arm = 'baseline'; },
      captured => { captured.taskHash = 'c'.repeat(64); },
      captured => { captured.sourceHash = 'd'.repeat(64); },
      captured => { captured.liveAccepted = true; },
      captured => { captured.nativeDiscoveryVerified = true; },
      captured => { captured.authenticationVerified = true; },
      captured => { captured.evidenceScope = 'native-client'; },
      captured => { captured.captureHash = 'e'.repeat(64); },
      captured => { captured.artifacts[0].content[0] ^= 1; },
      captured => { captured.artifacts[0].bytes++; },
      captured => { captured.artifacts[0].path = 'artifacts/foreign.txt'; },
      captured => { captured.artifacts.push(captured.artifacts[0]); },
      captured => { captured.missing.push('artifacts/plan.txt'); },
      captured => { captured.artifacts = []; captured.missing = []; },
      captured => { captured.artifacts[0].extra = true; }
    ]) {
      const prepared = await fixture(t, api);
      const { worker } = prepared.prepare(prepared.index('copilot'));
      const { toolTransport } = await api.startLiveNativeToolWorker(worker);
      const state = workers.get(worker);
      state.artifacts = [{ path: 'artifacts/plan.txt', content: Buffer.from('unit bytes') }];
      state.mutateCapture = mutate;
      await assert.rejects(api.captureLiveNativeToolArtifacts(toolTransport),
        error => ['LIVE_TOOL_ARTIFACT_BINDING_MISMATCH', 'LIVE_TOOL_ARTIFACT_INTEGRITY_MISMATCH'].includes(error.code));
      assert.equal(state.actions.filter(action => action === 'capture').length, 1);
      await assert.rejects(api.captureLiveNativeToolArtifacts(toolTransport),
        error => error.code === 'LIVE_TOOL_CAPTURE_ALREADY_ATTEMPTED');
    }
    const prepared = await fixture(t, api);
    const { worker } = prepared.prepare(prepared.index('copilot'));
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    const state = workers.get(worker);
    state.limits.artifactBytes = 1;
    state.artifacts = [{ path: 'artifacts/plan.txt', content: Buffer.from('two') }];
    await assert.rejects(api.captureLiveNativeToolArtifacts(toolTransport),
      error => error.code === 'LIVE_TOOL_ARTIFACT_LIMIT_CAP');
  });

  test('artifact capture rejects copied tuples and forbids concurrent or repeated attempts', async t => {
    const prepared = await fixture(t, api);
    const { worker } = prepared.prepare(prepared.index('copilot'));
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    const state = workers.get(worker);
    for (const tuple of [{ ...toolTransport }, structuredClone(toolTransport), undefined]) {
      await assert.rejects(api.captureLiveNativeToolArtifacts(tuple));
    }
    for (const options of [{ capture: true }, { executor: forbidden }, { signal: true }]) {
      await assert.rejects(api.captureLiveNativeToolArtifacts(toolTransport, options),
        error => error.code === 'INVALID_LIVE_TOOL_OPTIONS');
    }
    assert.equal(state.actions.includes('capture'), false);
    const capturing = api.captureLiveNativeToolArtifacts(toolTransport);
    await assert.rejects(api.captureLiveNativeToolArtifacts(toolTransport),
      error => error.code === 'LIVE_TOOL_CAPTURE_ALREADY_ATTEMPTED');
    await capturing;
    assert.equal(state.actions.filter(action => action === 'capture').length, 1);
  });

  test('artifact capture failure and expiry do not issue host grading or retry the worker', async t => {
    for (const failure of ['capture', 'expired-after-capture', 'cancel']) {
      const prepared = await fixture(t, api);
      const { worker } = prepared.prepare(prepared.index('copilot'));
      const { toolTransport } = await api.startLiveNativeToolWorker(worker);
      const state = workers.get(worker);
      const controller = new AbortController();
      if (failure === 'capture') state.fail = 'capture';
      if (failure === 'expired-after-capture') state.afterCapture = async () => {
        state.deadlineUnixMs = Date.now() - 1;
      };
      if (failure === 'cancel') state.beforeAssert = async () => { controller.abort(); };
      await assert.rejects(api.captureLiveNativeToolArtifacts(toolTransport, { signal: controller.signal }));
      assert.equal(state.actions.filter(action => action === 'capture').length, failure === 'cancel' ? 0 : 1);
      assert.equal(api.describeLiveEvaluation(prepared.handle).liveAccepted, false);
    }
  });

  test('failed host artifact cleanup retains only original owned workspace recovery authority', async t => {
    const prepared = await fixture(t, api);
    const { worker } = prepared.prepare(prepared.index('copilot'));
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    const originalRemove = fs.rmSync;
    let failedDirectory;
    const remove = mock.method(fs, 'rmSync', (directory, options) => {
      if (typeof directory === 'string' && /[\\/]isolation-[a-f0-9-]+$/.test(directory)) {
        failedDirectory = directory;
        throw new Error('Unit host cleanup failure');
      }
      return originalRemove(directory, options);
    });
    let failure;
    try { await api.captureLiveNativeToolArtifacts(toolTransport); }
    catch (error) { failure = error; }
    finally { remove.mock.restore(); }
    assert.equal(failure.code, 'LIVE_TOOL_ARTIFACT_CLEANUP_FAILED');
    assert.equal(failure.workspace.directory, failedDirectory);
    assert.ok(fs.existsSync(failedDirectory));
    const { destroyWorkspace } = await import('../harness/isolation/index.mjs');
    assert.throws(() => destroyWorkspace({ ...failure.workspace }), /Unknown or destroyed/);
    destroyWorkspace(failure.workspace);
    assert.equal(fs.existsSync(failedDirectory), false);
    await assert.rejects(api.captureLiveNativeToolArtifacts(toolTransport),
      error => error.code === 'LIVE_TOOL_CAPTURE_ALREADY_ATTEMPTED');
  });

  test('owned copies resist decoded buffer mutation and reject changed host files', async t => {
    for (const mutation of ['after-verification', 'during-staging']) {
      const prepared = await fixture(t, api);
      const { worker } = prepared.prepare(prepared.index('copilot'));
      const { toolTransport } = await api.startLiveNativeToolWorker(worker);
      const state = workers.get(worker);
      state.artifacts = [{ path: 'artifacts/plan.txt', content: Buffer.from('original unit bytes') }];
      if (mutation === 'after-verification') state.beforeAssert = async () => {
        if (state.issuedCapture) state.issuedCapture.artifacts[0].content[0] ^= 1;
      };
      const originalWrite = fs.writeFileSync;
      const write = mutation === 'during-staging' ? mock.method(fs, 'writeFileSync', (filename, content, options) => {
        if (typeof filename === 'string' && /[\\/]isolation-[a-f0-9-]+[\\/]artifacts[\\/]plan\.txt$/.test(filename)) {
          return originalWrite(filename, Buffer.from('changed host bytes'), options);
        }
        return originalWrite(filename, content, options);
      }) : null;
      try {
        if (mutation === 'after-verification') {
          const { capture, report } = await api.captureLiveNativeToolArtifacts(toolTransport);
          assert.deepEqual(readCapturedArtifact(capture, 'plan.txt'), state.artifacts[0].content);
          assert.equal(report.workerCaptureHash, state.issuedCapture.captureHash);
          assert.equal(report.liveAccepted, false);
        } else {
          await assert.rejects(api.captureLiveNativeToolArtifacts(toolTransport),
            error => error.code === 'LIVE_TOOL_ARTIFACT_STAGING_CHANGED');
        }
      } finally {
        write?.mock.restore();
      }
      assert.equal(state.issuedCapture.artifacts[0].content.every(byte => byte === 0), true);
    }
  });

  test('host capture and cleanup failures are both surfaced with original workspace recovery', async t => {
    const prepared = await fixture(t, api);
    const { worker } = prepared.prepare(prepared.index('copilot'));
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    workers.get(worker).artifacts = [{ path: 'artifacts/plan.txt', content: Buffer.from('unit bytes') }];
    const originalWrite = fs.writeFileSync;
    const originalRemove = fs.rmSync;
    const write = mock.method(fs, 'writeFileSync', (filename, content, options) => {
      if (typeof filename === 'string' && /[\\/]isolation-[a-f0-9-]+[\\/]artifacts[\\/]plan\.txt$/.test(filename)) {
        throw new Error('Unit host staging failure');
      }
      return originalWrite(filename, content, options);
    });
    const remove = mock.method(fs, 'rmSync', (directory, options) => {
      if (typeof directory === 'string' && /[\\/]isolation-[a-f0-9-]+$/.test(directory)) {
        throw new Error('Unit host cleanup failure');
      }
      return originalRemove(directory, options);
    });
    let failure;
    try { await api.captureLiveNativeToolArtifacts(toolTransport); }
    catch (error) { failure = error; }
    finally {
      write.mock.restore();
      remove.mock.restore();
    }
    assert.ok(failure instanceof AggregateError);
    assert.equal(failure.errors.length, 2);
    assert.match(failure.errors[0].message, /Unit host staging failure/);
    assert.match(failure.errors[1].message, /Unit host cleanup failure/);
    const { destroyWorkspace } = await import('../harness/isolation/index.mjs');
    destroyWorkspace(failure.workspace);
    assert.equal(fs.existsSync(failure.workspace.directory), false);
  });

  test('pure planning rejects absent or mismatched candidate transport before invoking builders', async t => {
    const prepared = await fixture(t, api);
    const index = prepared.index('copilot');
    const { worker } = prepared.prepare(index);
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    const options = nativeBindings(prepared, 'copilot', toolTransport);
    const description = candidates.get(options.candidate).description;
    const original = { ...description.toolTransport };
    const before = builderCalls.length;
    for (const field of ['taskHash', 'sourceHash', 'transportBindingHash']) {
      description.toolTransport = { ...original, [field]: 'f'.repeat(64) };
      assert.throws(() => api.prepareLiveNativeTask(prepared.handle, index, options),
        error => error.code === 'LIVE_TOOL_CANDIDATE_BINDING_MISMATCH');
    }
    delete description.toolTransport;
    assert.throws(() => api.prepareLiveNativeTask(prepared.handle, index, options),
      error => error.code === 'LIVE_TOOL_CANDIDATE_BINDING_MISMATCH');
    assert.equal(builderCalls.length, before);
    description.toolTransport = original;
    const { report } = api.prepareLiveNativeTask(prepared.handle, index, options);
    assert.deepEqual(report.bindings.candidate.toolTransport, original);
  });

  test('pure planning cannot omit transport from an already tool-attached candidate', async t => {
    const prepared = await fixture(t, api);
    const index = prepared.index('copilot');
    const { worker } = prepared.prepare(index);
    const { toolTransport } = await api.startLiveNativeToolWorker(worker);
    const { boundary, candidate, custody } = nativeBindings(prepared, 'copilot', toolTransport);
    const before = builderCalls.length;
    assert.throws(() => api.prepareLiveNativeTask(prepared.handle, index, { boundary, candidate, custody }),
      error => error.code === 'LIVE_TOOL_CANDIDATE_BINDING_MISMATCH');
    assert.equal(builderCalls.length, before);
    delete candidates.get(candidate).description.toolTransport;
    const { report } = api.prepareLiveNativeTask(prepared.handle, index, { boundary, candidate, custody });
    assert.equal(report.toolTransportPrepared, false);
    assert.equal(Object.hasOwn(report.bindings.candidate, 'toolTransport'), false);
  });
}
