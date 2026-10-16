import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

const childFlag = 'EVAL_NATIVE_BRIDGE_UNIT_CHILD';
const hosts = ['api.anthropic.com', 'api.githubcopilot.com'];
const nativeUserIds = { 'claude-code': 1000, copilot: 10001, opencode: 1000 };

if (process.env[childFlag] !== '1') {
  test('native preparation bridge units use boundary doubles without Docker, login or inference', () => {
    const env = { ...process.env, [childFlag]: '1' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      '--experimental-test-module-mocks', '--test', '--test-reporter=tap', fileURLToPath(import.meta.url)
    ], {
      encoding: 'utf8', timeout: 30_000, env
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /# tests 16\b/);
    assert.match(result.stdout, /# pass 16\b/);
    assert.match(result.stdout, /# fail 0/);
  });
} else {
  const boundaries = new WeakMap();
  const candidates = new WeakMap();
  const manifests = new WeakMap();
  const describeBoundary = handle => {
    assert.ok(boundaries.has(handle), 'Original unit boundary required');
    return structuredClone(boundaries.get(handle));
  };
  const assertCandidate = (handle, { boundary, client }) => {
    const state = candidates.get(handle);
    assert.ok(state, 'Original unit candidate required');
    assert.equal(state.boundary, boundary, 'Exact unit boundary binding required');
    assert.equal(state.description.client, client, 'Exact unit client binding required');
    return structuredClone(state.description);
  };
  const assertNativeCandidate = async (handle, options) => {
    const description = assertCandidate(handle, options);
    const state = candidates.get(handle);
    assert.ok(state.imageHandle, 'Unit native image authority required');
    assert.equal(state.imageHandle, options.imageHandle, 'Original unit native image handle required');
    return description;
  };
  const inspectNativeCandidate = async handle => {
    const state = candidates.get(handle);
    assert.ok(state?.imageHandle, 'Unit native image authority required');
    state.inspectionCount = (state.inspectionCount ?? 0) + 1;
    if (state.beforeInspect) await state.beforeInspect();
    if (!state.staleMeasurement) state.description.observed.measuredAt = new Date().toISOString();
    return structuredClone(state.description);
  };
  const forbidden = () => { throw new Error('Boundary execution is forbidden in bridge units'); };
  const boundaryModule = new URL('../harness/live-boundary/index.mjs', import.meta.url);
  mock.module(boundaryModule, {
    cache: true,
    namedExports: {
      describeEgressBoundary: describeBoundary, assertEgressCandidate: assertCandidate,
      assertNativeEgressCandidate: assertNativeCandidate, inspectNativeEgressCandidate: inspectNativeCandidate,
      startEgressBoundary: forbidden, stopEgressBoundary: forbidden,
      prepareEgressCandidate: forbidden, describeEgressCandidate: forbidden,
      attachEgressCandidate: forbidden, inspectEgressCandidate: forbidden, stopEgressCandidate: forbidden
    }
  });
  const manifestModule = new URL('../harness/live-boundary/native-image-manifest.mjs', import.meta.url);
  mock.module(manifestModule, {
    cache: true,
    namedExports: {
      assertNativeImageManifestObservation: async (handle, { client, imageHandle }) => {
        const state = manifests.get(handle);
        assert.ok(state?.active, 'Original active unit manifest observation required');
        assert.equal(state.client, client, 'Exact unit manifest client required');
        assert.equal(state.imageHandle, imageHandle, 'Original unit manifest image handle required');
        state.assertions++;
        if (state.beforeAssert) await state.beforeAssert();
      },
      describeNativeImageManifestObservation: handle => {
        const state = manifests.get(handle);
        assert.ok(state, 'Original unit manifest observation required');
        return structuredClone(state.description);
      }
    }
  });
  const mockedBoundary = await import(boundaryModule.href);
  assert.equal(mockedBoundary.describeEgressBoundary, describeBoundary);
  assert.equal(mockedBoundary.assertEgressCandidate, assertCandidate);
  const { hashObject, readJson } = await import('../harness/index.mjs');
  const { createPublicPolicy } = await import('../harness/live-boundary/policy.mjs');
  const { nativeMatrixFixture } = await import('./helpers.mjs');
  const {
    describeLiveEvaluation, describeLiveNativeTask, prepareLiveEvaluation,
    prepareLiveNativeTask, inspectLiveNativeTaskRuntime, readLiveTaskRequest, releaseLiveEvaluation
  } = await import('../harness/live-execution.mjs');
  const { prepareNativeAuthCustody, releaseNativeAuthCustody } = await import('../harness/auth/custody.mjs');

  function preparation(t, { noSkill = false, nativePins = false } = {}) {
    const { mockScenarios, ...options } = nativeMatrixFixture(t, { privateContext: true });
    options.selection.clients = ['claude-code', 'copilot', 'opencode'];
    if (noSkill) options.selection.arms = ['candidate', 'baseline', 'no-skill'];
    options.profile.auth = 'native-client-auth';
    for (const [client, pin] of Object.entries(options.profile.clients)) {
      pin.model = {
        'claude-code': 'claude-sonnet-4-6', copilot: 'gpt-4.1', opencode: 'github-copilot/gpt-4.1'
      }[client];
      pin.endpoint = client === 'claude-code' ? 'https://api.anthropic.com' : 'https://api.githubcopilot.com';
      pin.settings = {};
      if (nativePins) pin.runtimeImage = {
        kind: 'local-oci', manifestDigest: `sha256:${'c'.repeat(64)}`, configDigest: `sha256:${'b'.repeat(64)}`
      };
    }
    const suite = readJson(options.suiteFile);
    suite.cases.find(item => item.id === 'explicit').hardChecks.push({
      id: 'private-answer', class: 'correctness', type: 'artifact-contains',
      target: 'plan.txt', expected: 'HOST-ANSWER-KEY-NOT-FOR-THE-MODEL'
    });
    fs.writeFileSync(options.suiteFile, JSON.stringify(suite));
    const prepared = { ...prepareLiveEvaluation(options), active: true, options };
    t.after(() => {
      if (prepared.active) releaseLiveEvaluation(prepared.handle);
    });
    return prepared;
  }

  const activeCustodies = new Set();
  function releaseCustody(custody) {
    releaseNativeAuthCustody(custody);
    activeCustodies.delete(custody);
  }

  function binding(t, prepared, client) {
    const boundary = Object.freeze({ owner: randomUUID(), kind: 'unit-boundary-double' });
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    boundaries.set(boundary, {
      owner: boundary.owner, fixtureOnly: false, status: 'active', expiresAt,
      policyHash: createPublicPolicy(hosts).policyHash
    });
    const candidate = Object.freeze({ id: randomUUID(), kind: 'unit-candidate-double' });
    candidates.set(candidate, {
      boundary, description: {
        id: candidate.id, client, boundaryOwner: boundary.owner, fixtureOnly: false,
        status: 'preparing', boundaryStatus: 'active', expiresAt,
        proxyURL: 'http://172.30.0.2:8080',
        nativeAuthRootLocator: { containerPath: {
          'claude-code': '/home/node/.claude', copilot: '/client-config/copilot', opencode: '/work/data'
        }[client] }
      }
    });
    const custody = prepareNativeAuthCustody({ client, evaluation: prepared.handle });
    activeCustodies.add(custody);
    t.after(() => {
      if (activeCustodies.has(custody)) releaseCustody(custody);
    });
    return { boundary, candidate, custody };
  }

  function taskIndex(prepared, client, arm = 'candidate') {
    for (let index = 0; index < prepared.report.taskSessionCount; index++) {
      const task = readLiveTaskRequest(prepared.handle, index).task;
      if (task.client === client && task.arm === arm) return index;
    }
    throw new Error('Missing unit task');
  }

  function runtimeBinding(t, prepared, client) {
    const originals = binding(t, prepared, client);
    const { specification } = prepareLiveNativeTask(prepared.handle, taskIndex(prepared, client), originals);
    const imageHandle = Object.freeze({ id: randomUUID(), client, kind: 'unit-native-image-double' });
    const state = candidates.get(originals.candidate);
    state.imageHandle = imageHandle;
    const image = prepared.report.requestedRoutes[client].runtimeImage?.manifestDigest ??
      `sha256:${prepared.report.requestedImage.split('@sha256:')[1]}`;
    Object.assign(state.description, {
      status: 'attached', image, imageAuthority: { imageId: image },
      networkAttachmentVerified: true, nativeRuntimeVerified: true,
      observed: { measuredAt: new Date().toISOString(), policyHash: boundaries.get(originals.boundary).policyHash },
      nativeRuntime: {
        owner: originals.boundary.owner, candidateId: originals.candidate.id,
        client, clientVersion: prepared.report.requestedRoutes[client].clientVersion,
        packageVersion: prepared.report.requestedRoutes[client].clientVersion, nodeVersion: '22.22.1',
        uid: nativeUserIds[client], gid: nativeUserIds[client], cwd: specification.cwd,
        executable: client === 'opencode' ? specification.binary : specification.executable,
        resolvedExecutable: '/opt/client/unit-only-native-executable', executableHash: 'a'.repeat(64),
        measuredAt: new Date().toISOString()
      }
    });
    return { ...originals, imageHandle, specification, state };
  }

  function manifestBinding(runtime) {
    const handle = Object.freeze({ id: randomUUID(), kind: 'unit-manifest-observation-double' });
    const { client, clientVersion } = runtime.state.description.nativeRuntime;
    const state = {
      active: true, client, imageHandle: runtime.imageHandle, assertions: 0,
      description: {
        client, clientVersion, imageId: runtime.state.description.image,
        dockerImageId: runtime.state.description.image, dockerImageIdType: 'unit-only-manifest-id-type',
        manifestDigest: runtime.state.description.image, manifestDigestType: 'unit-only-manifest-digest-type',
        configDigest: `sha256:${'b'.repeat(64)}`, registryManifestVerified: false,
        provenance: 'local-oci-layout-exported-by-docker-image-save',
        archive: { location: 'PRIVATE-IMAGE-ARCHIVE-LOCATOR' }, manifestJSON: 'PRIVATE-IMAGE-CONFIG-BYTES'
      }
    };
    manifests.set(handle, state);
    return { handle, state };
  }

  test('all three real pure builders receive captured coordinates, model, timeout and target-only grading scope', t => {
    const prepared = preparation(t);
    for (const client of prepared.report.selection.clients) {
      const index = taskIndex(prepared, client);
      const originals = binding(t, prepared, client);
      const { specification, report } = prepareLiveNativeTask(prepared.handle, index, originals);
      assert.deepEqual(specification.task, readLiveTaskRequest(prepared.handle, index).task);
      assert.equal(report.specificationHash, hashObject(specification));
      assert.equal(report.requestedModel, prepared.options.profile.clients[client].model);
      const nativeModel = client === 'claude-code' ? specification.model.requested :
        client === 'opencode' ? specification.model.selector : specification.model;
      assert.equal(nativeModel, prepared.options.profile.clients[client].model);
      const timeoutMs = client === 'opencode' ? specification.limits.supervisor.timeoutMs :
        specification.limits.timeoutMs;
      assert.equal(timeoutMs, prepared.options.profile.limits.seconds * 1000);
      if (client === 'claude-code') {
        assert.equal(specification.limits.maxTurns, prepared.options.profile.limits.turns);
        assert.equal(specification.argv[specification.argv.indexOf('--max-turns') + 1],
          String(prepared.options.profile.limits.turns));
        assert.equal(specification.limits.nativeTurnLimitApplied, false);
      }
      assert.deepEqual(report.requestedLimits, prepared.options.profile.limits);
      assert.deepEqual(report.artifactTargets, ['plan.txt']);
      assert.equal(report.bindings.candidate.authRoot, candidates.get(originals.candidate).description.nativeAuthRootLocator.containerPath);
      assert.equal(report.bindings.candidate.proxyURL, 'http://172.30.0.2:8080');
      const serialized = JSON.stringify(specification);
      assert.equal(serialized.includes('HOST-ANSWER-KEY-NOT-FOR-THE-MODEL'), false);
      assert.equal(serialized.includes('PRIVATE-GRADER-DATA'), false);
      assert.equal(serialized.includes('Independent public mock output'), false);
      assert.equal(serialized.includes('Must not enter native skill context'), false);
      for (const field of [
        'executed', 'executionAuthorized', 'nativeRuntimeVerified', 'nativeImageAttached',
        'authenticationVerified', 'credentialToolBoundaryVerified', 'serviceEgressVerified',
        'limitsVerified', 'consumptionEnforcementVerified', 'liveAccepted'
      ]) assert.equal(report[field], false);
      report.bindings.candidate.authRoot = '/caller-mutation';
      report.requestedLimits.tokens = 1;
      const described = describeLiveNativeTask(specification);
      assert.notEqual(described.bindings.candidate.authRoot, '/caller-mutation');
      assert.equal(described.requestedLimits.tokens, prepared.options.profile.limits.tokens);
      assert.equal(describeLiveEvaluation(prepared.handle).executed, false);
    }
  });

  test('runtime observation wiring binds all three original native images without granting task or profile authority', async t => {
    const prepared = preparation(t);
    for (const client of prepared.report.selection.clients) {
      const runtime = runtimeBinding(t, prepared, client);
      const report = await inspectLiveNativeTaskRuntime(runtime.specification, { imageHandle: runtime.imageHandle });
      assert.equal(report.kind, 'native-live-task-runtime-observation');
      assert.equal(report.nativeRuntimeVerified, true);
      assert.equal(report.nativeImageAttached, true);
      assert.equal(report.imageMatchesProfile, null);
      assert.equal(report.requestedImageVerified, false);
      assert.equal(report.runtimeObservation.client, client);
      assert.equal(report.runtimeObservation.uid, nativeUserIds[client]);
      assert.equal(report.runtimeObservation.gid, nativeUserIds[client]);
      assert.equal(report.runtimeObservation.executableHash, 'a'.repeat(64));
      assert.equal(report.observedModel, null);
      assert.equal(report.observedUsage, null);
      for (const field of [
        'executed', 'executionAuthorized', 'authenticationVerified', 'credentialToolBoundaryVerified',
        'serviceEgressVerified', 'limitsVerified', 'consumptionEnforcementVerified', 'liveAccepted'
      ]) assert.equal(report[field], false);
      assert.equal(JSON.stringify(report).includes('HOST-ANSWER-KEY-NOT-FOR-THE-MODEL'), false);
      assert.equal(JSON.stringify(report).includes('PRIVATE-GRADER-DATA'), false);
      report.runtimeObservation.imageId = 'caller-mutation';
      assert.notEqual((await inspectLiveNativeTaskRuntime(runtime.specification,
        { imageHandle: runtime.imageHandle })).runtimeObservation.imageId, 'caller-mutation');
      for (const field of ['uid', 'gid']) {
        runtime.state.description.nativeRuntime[field] = client === 'copilot' ? 1000 : 10001;
        await assert.rejects(inspectLiveNativeTaskRuntime(runtime.specification,
          { imageHandle: runtime.imageHandle }), error => error.code === 'NATIVE_RUNTIME_OBSERVATION_MISMATCH');
        runtime.state.description.nativeRuntime[field] = nativeUserIds[client];
      }
      assert.equal(describeLiveNativeTask(runtime.specification).nativeRuntimeVerified, false);
      assert.equal(describeLiveEvaluation(prepared.handle).executed, false);
    }
  });

  test('native runtime wiring rejects copied specifications, images, alternate inputs and Node-only candidates', async t => {
    const prepared = preparation(t);
    const runtime = runtimeBinding(t, prepared, 'copilot');
    await assert.rejects(inspectLiveNativeTaskRuntime(structuredClone(runtime.specification),
      { imageHandle: runtime.imageHandle }), error => error.code === 'INVALID_NATIVE_TASK_SPECIFICATION');
    await assert.rejects(inspectLiveNativeTaskRuntime(runtime.specification,
      { imageHandle: structuredClone(runtime.imageHandle) }));
    for (const options of [{}, { imageHandle: runtime.imageHandle, authenticated: true },
      { imageHandle: runtime.imageHandle, executor: () => true }]) {
      await assert.rejects(inspectLiveNativeTaskRuntime(runtime.specification, options),
        error => error.code === 'INVALID_NATIVE_RUNTIME_OPTIONS');
    }
    const nodeOnly = binding(t, prepared, 'copilot');
    const { specification } = prepareLiveNativeTask(prepared.handle, taskIndex(prepared, 'copilot'), nodeOnly);
    await assert.rejects(inspectLiveNativeTaskRuntime(specification, { imageHandle: runtime.imageHandle }));
    const other = runtimeBinding(t, prepared, 'opencode');
    await assert.rejects(inspectLiveNativeTaskRuntime(runtime.specification, { imageHandle: other.imageHandle }));
  });

  test('original manifest wiring verifies all three explicit image pins without granting live authority', async t => {
    const prepared = preparation(t, { nativePins: true });
    for (const client of prepared.report.selection.clients) {
      const runtime = runtimeBinding(t, prepared, client);
      const manifest = manifestBinding(runtime);
      const options = { imageHandle: runtime.imageHandle, manifestObservation: manifest.handle };
      const report = await inspectLiveNativeTaskRuntime(runtime.specification, options);
      assert.equal(manifest.state.assertions, 2);
      assert.equal(report.nativeRuntimeVerified, true);
      assert.equal(report.imageMatchesProfile, true);
      assert.equal(report.requestedImageVerified, true);
      assert.equal(report.runtimeManifestObservation.configDigest, prepared.options.profile.clients[client].runtimeImage.configDigest);
      assert.equal(report.runtimeManifestObservation.manifestDigest, prepared.options.profile.clients[client].runtimeImage.manifestDigest);
      assert.equal(report.runtimeManifestObservation.registryManifestVerified, false);
      assert.equal(report.observedModel, null);
      assert.equal(report.observedUsage, null);
      for (const field of [
        'executed', 'executionAuthorized', 'authenticationVerified', 'credentialToolBoundaryVerified',
        'serviceEgressVerified', 'limitsVerified', 'consumptionEnforcementVerified', 'liveAccepted'
      ]) assert.equal(report[field], false);
      for (const privateValue of ['PRIVATE-IMAGE-ARCHIVE-LOCATOR', 'PRIVATE-IMAGE-CONFIG-BYTES', 'HOST-ANSWER-KEY-NOT-FOR-THE-MODEL'])
        assert.equal(JSON.stringify(report).includes(privateValue), false);
      report.runtimeManifestObservation.manifestDigest = `sha256:${'d'.repeat(64)}`;
      const fresh = await inspectLiveNativeTaskRuntime(runtime.specification, options);
      assert.equal(fresh.runtimeManifestObservation.manifestDigest, prepared.options.profile.clients[client].runtimeImage.manifestDigest);
      assert.equal(describeLiveNativeTask(runtime.specification).nativeRuntimeVerified, false);
      assert.equal(describeLiveEvaluation(prepared.handle).executed, false);
    }
  });

  test('manifest observations cannot infer missing native pins and either digest mismatch remains explicit', async t => {
    const unpinned = preparation(t);
    const runtime = runtimeBinding(t, unpinned, 'copilot');
    const manifest = manifestBinding(runtime);
    const report = await inspectLiveNativeTaskRuntime(runtime.specification, {
      imageHandle: runtime.imageHandle, manifestObservation: manifest.handle
    });
    assert.equal(report.imageMatchesProfile, null);
    assert.equal(report.requestedImageVerified, false);
    assert.ok(report.blockers.some(blocker => /exact per-client local-OCI manifest\/config pin/.test(blocker)));
    const pinned = preparation(t, { nativePins: true });
    const pinnedRuntime = runtimeBinding(t, pinned, 'copilot');
    for (const field of ['manifestDigest', 'configDigest']) {
      const mismatched = manifestBinding(pinnedRuntime);
      mismatched.state.description[field] = `sha256:${'e'.repeat(64)}`;
      const mismatch = await inspectLiveNativeTaskRuntime(pinnedRuntime.specification, {
        imageHandle: pinnedRuntime.imageHandle, manifestObservation: mismatched.handle
      });
      assert.equal(mismatch.imageMatchesProfile, false);
      assert.equal(mismatch.requestedImageVerified, false);
      assert.ok(mismatch.blockers.some(blocker => /does not match the captured per-client pin/.test(blocker)));
      assert.equal(mismatch.executionAuthorized, false);
    }
  });

  test('copied, cross-client, cross-image and mismatched manifest observations are rejected', async t => {
    const prepared = preparation(t, { nativePins: true });
    const runtime = runtimeBinding(t, prepared, 'copilot');
    const manifest = manifestBinding(runtime);
    for (const invalid of [structuredClone(manifest.handle), true, undefined, 'manifest.json']) {
      await assert.rejects(inspectLiveNativeTaskRuntime(runtime.specification, {
        imageHandle: runtime.imageHandle, manifestObservation: invalid
      }), /Original active unit manifest observation required/);
    }
    const otherClient = manifestBinding(runtimeBinding(t, prepared, 'opencode'));
    await assert.rejects(inspectLiveNativeTaskRuntime(runtime.specification, {
      imageHandle: runtime.imageHandle, manifestObservation: otherClient.handle
    }), /Exact unit manifest client required/);
    const otherImage = manifestBinding(runtimeBinding(t, prepared, 'copilot'));
    await assert.rejects(inspectLiveNativeTaskRuntime(runtime.specification, {
      imageHandle: runtime.imageHandle, manifestObservation: otherImage.handle
    }), /Original unit manifest image handle required/);
    for (const field of ['imageId', 'dockerImageId', 'clientVersion']) {
      const mismatched = manifestBinding(runtime);
      mismatched.state.description[field] = 'unit-wrong-binding';
      await assert.rejects(inspectLiveNativeTaskRuntime(runtime.specification, {
        imageHandle: runtime.imageHandle, manifestObservation: mismatched.handle
      }), error => error.code === 'NATIVE_IMAGE_MANIFEST_BINDING_MISMATCH');
    }
  });

  test('manifest authority is rechecked after asynchronous native inspection', async t => {
    for (const stage of ['inspection', 'manifest-assertion']) {
      const prepared = preparation(t, { nativePins: true });
      const runtime = runtimeBinding(t, prepared, 'copilot');
      const manifest = manifestBinding(runtime);
      if (stage === 'inspection') {
        runtime.state.beforeInspect = async () => { manifest.state.active = false; };
      } else {
        manifest.state.beforeAssert = async () => {
          releaseLiveEvaluation(prepared.handle);
          prepared.active = false;
        };
      }
      await assert.rejects(inspectLiveNativeTaskRuntime(runtime.specification, {
        imageHandle: runtime.imageHandle, manifestObservation: manifest.handle
      }), error => stage === 'inspection'
        ? /Original active unit manifest observation required/.test(error.message)
        : error.code === 'INVALID_NATIVE_TASK_SPECIFICATION');
      assert.equal(manifest.state.assertions, 1);
      if (stage === 'manifest-assertion') assert.equal(runtime.state.inspectionCount ?? 0, 0);
    }
  });

  test('native runtime drift and stale observations fail; equal digest text is not OCI manifest authority', async t => {
    const prepared = preparation(t);
    const runtime = runtimeBinding(t, prepared, 'copilot');
    const original = structuredClone(runtime.state.description);
    for (const mutate of [
      description => { description.nativeRuntime.clientVersion = 'unverified'; },
      description => { description.nativeRuntime.packageVersion = 'unverified'; },
      description => { description.nativeRuntime.nodeVersion = 'unverified'; },
      description => { description.nativeRuntime.uid = 1000; },
      description => { description.nativeRuntime.gid = 0; },
      description => { description.nativeRuntime.cwd = '/alternate'; },
      description => { description.nativeRuntime.executable = '/alternate'; },
      description => { description.nativeRuntime.executableHash = 'unverified'; },
      description => { description.nativeRuntime.candidateId = randomUUID(); },
      description => { description.nativeRuntime.owner = randomUUID(); },
      description => { description.networkAttachmentVerified = false; },
      description => { description.nativeRuntimeVerified = false; },
      description => { description.imageAuthority.imageId = `sha256:${'b'.repeat(64)}`; },
      description => { description.observed.policyHash = 'b'.repeat(64); }
    ]) {
      runtime.state.description = structuredClone(original);
      mutate(runtime.state.description);
      await assert.rejects(inspectLiveNativeTaskRuntime(runtime.specification,
        { imageHandle: runtime.imageHandle }), error => error.code === 'NATIVE_RUNTIME_OBSERVATION_MISMATCH');
    }
    runtime.state.description = structuredClone(original);
    runtime.state.staleMeasurement = true;
    runtime.state.description.observed.measuredAt = new Date(Date.now() - 1000).toISOString();
    await assert.rejects(inspectLiveNativeTaskRuntime(runtime.specification,
      { imageHandle: runtime.imageHandle }), error => error.code === 'NATIVE_RUNTIME_OBSERVATION_MISMATCH');
    runtime.state.staleMeasurement = false;
    runtime.state.description.image = `sha256:${'b'.repeat(64)}`;
    runtime.state.description.imageAuthority.imageId = runtime.state.description.image;
    const report = await inspectLiveNativeTaskRuntime(runtime.specification, { imageHandle: runtime.imageHandle });
    assert.equal(report.nativeRuntimeVerified, true);
    assert.equal(report.imageMatchesProfile, null);
    assert.equal(report.requestedImageVerified, false);
    assert.ok(report.blockers.some(blocker => /Docker image ID text alone is not manifest authority/.test(blocker)));
    assert.equal(report.executionAuthorized, false);
    assert.equal(report.liveAccepted, false);
  });

  test('native runtime inspection rechecks lifecycle after asynchronous work', async t => {
    for (const release of ['boundary', 'evaluation', 'custody']) {
      const prepared = preparation(t);
      const runtime = runtimeBinding(t, prepared, 'copilot');
      runtime.state.beforeInspect = async () => {
        if (release === 'boundary') boundaries.get(runtime.boundary).status = 'stopped';
        if (release === 'evaluation') { releaseLiveEvaluation(prepared.handle); prepared.active = false; }
        if (release === 'custody') releaseCustody(runtime.custody);
      };
      await assert.rejects(inspectLiveNativeTaskRuntime(runtime.specification, { imageHandle: runtime.imageHandle }),
        error => error.code === {
          boundary: 'INACTIVE_NATIVE_BOUNDARY', evaluation: 'INVALID_NATIVE_TASK_SPECIFICATION',
          custody: 'INVALID_AUTH_CUSTODY'
        }[release]);
    }
  });

  test('all three no-skill specifications retain context without any candidate or baseline skill bytes', t => {
    const prepared = preparation(t, { noSkill: true });
    for (const client of prepared.report.selection.clients) {
      const index = taskIndex(prepared, client, 'no-skill');
      const originals = binding(t, prepared, client);
      const { specification, report } = prepareLiveNativeTask(prepared.handle, index, originals);
      assert.equal(report.task.arm, 'no-skill');
      const serialized = JSON.stringify(specification);
      assert.equal(serialized.includes('candidate skill bytes'), false);
      assert.equal(serialized.includes('baseline skill bytes'), false);
      assert.equal(serialized.includes('Selected supporting skill file'), false);
      assert.equal(serialized.includes('PRIVATE-GRADER-DATA'), false);
      assert.ok(readLiveTaskRequest(prepared.handle, index).inputs.length > 0);
      assert.equal(report.liveAccepted, false);
    }
  });

  test('unknown options, cloned evaluation, invalid indexes and copied specifications fail closed', t => {
    const prepared = preparation(t);
    const index = taskIndex(prepared, 'copilot');
    const originals = binding(t, prepared, 'copilot');
    for (const field of ['authenticated', 'executor', 'model', 'checks', 'credentialFile', 'proxyURL']) {
      assert.throws(() => prepareLiveNativeTask(prepared.handle, index, { ...originals, [field]: 'DO-NOT-ECHO-SECRET' }),
        error => error.code === 'INVALID_NATIVE_PLAN_OPTIONS' && !error.message.includes('DO-NOT-ECHO-SECRET'));
    }
    assert.throws(() => prepareLiveNativeTask(structuredClone(prepared.handle), index, originals));
    for (const invalid of [-1, 0.5, prepared.report.taskSessionCount]) {
      assert.throws(() => prepareLiveNativeTask(prepared.handle, invalid, originals),
        error => error.code === 'INVALID_LIVE_TASK_INDEX');
    }
    const { specification } = prepareLiveNativeTask(prepared.handle, index, originals);
    assert.throws(() => describeLiveNativeTask(structuredClone(specification)),
      error => error.code === 'INVALID_NATIVE_TASK_SPECIFICATION');
  });

  test('copied or cross-client boundary, candidate and custody bindings cannot prepare another slot', t => {
    const prepared = preparation(t);
    const index = taskIndex(prepared, 'copilot');
    const originals = binding(t, prepared, 'copilot');
    for (const field of ['boundary', 'candidate', 'custody']) {
      assert.throws(() => prepareLiveNativeTask(prepared.handle, index, {
        ...originals, [field]: structuredClone(originals[field])
      }));
    }
    const other = binding(t, prepared, 'opencode');
    for (const field of ['boundary', 'candidate', 'custody']) {
      assert.throws(() => prepareLiveNativeTask(prepared.handle, index, { ...originals, [field]: other[field] }));
    }
    const another = preparation(t);
    assert.throws(() => prepareLiveNativeTask(another.handle, index, originals));
  });

  test('fixture-only, expired, stopped or transitional boundary plans never reach a native builder', t => {
    const prepared = preparation(t);
    const index = taskIndex(prepared, 'copilot');
    const originals = binding(t, prepared, 'copilot');
    const boundary = boundaries.get(originals.boundary);
    const candidate = candidates.get(originals.candidate).description;
    const savedBoundary = structuredClone(boundary);
    const savedCandidate = structuredClone(candidate);
    for (const [change, code] of [
      [() => { boundary.fixtureOnly = true; }, 'FIXTURE_NATIVE_BOUNDARY'],
      [() => { candidate.fixtureOnly = true; }, 'FIXTURE_NATIVE_BOUNDARY'],
      ...[
        () => { boundary.status = 'stopped'; },
        () => { boundary.expiresAt = new Date(Date.now() - 1).toISOString(); },
        () => { candidate.boundaryStatus = 'closing'; },
        () => { candidate.boundaryOwner = randomUUID(); },
        () => { candidate.expiresAt = new Date(Date.now() + 1000).toISOString(); },
        ...['attaching', 'failed', 'stopped'].map(status => () => { candidate.status = status; })
      ].map(change => [change, 'INACTIVE_NATIVE_BOUNDARY'])
    ]) {
      Object.assign(boundary, savedBoundary);
      Object.assign(candidate, structuredClone(savedCandidate));
      change();
      assert.throws(() => prepareLiveNativeTask(prepared.handle, index, originals),
        error => error.code === code);
    }
  });

  test('service policy mismatch and missing native locators are explicit planning errors', t => {
    const prepared = preparation(t);
    const index = taskIndex(prepared, 'copilot');
    const originals = binding(t, prepared, 'copilot');
    const boundary = boundaries.get(originals.boundary);
    boundary.policyHash = createPublicPolicy(['api.githubcopilot.com']).policyHash;
    assert.throws(() => prepareLiveNativeTask(prepared.handle, index, originals),
      error => error.code === 'NATIVE_POLICY_BINDING_MISMATCH');
    boundary.policyHash = createPublicPolicy(hosts).policyHash;
    const candidate = candidates.get(originals.candidate).description;
    delete candidate.nativeAuthRootLocator;
    assert.throws(() => prepareLiveNativeTask(prepared.handle, index, originals),
      error => error.code === 'MISSING_NATIVE_PLAN_LOCATORS');
  });

  test('describing a preparation rechecks custody and boundary lifecycle; evaluation release invalidates it', t => {
    const prepared = preparation(t);
    const index = taskIndex(prepared, 'copilot');
    const originals = binding(t, prepared, 'copilot');
    const { specification } = prepareLiveNativeTask(prepared.handle, index, originals);
    const boundary = boundaries.get(originals.boundary);
    boundary.status = 'stopped';
    assert.throws(() => describeLiveNativeTask(specification),
      error => error.code === 'INACTIVE_NATIVE_BOUNDARY');
    boundary.status = 'active';
    releaseLiveEvaluation(prepared.handle);
    prepared.active = false;
    assert.throws(() => describeLiveNativeTask(specification),
      error => error.code === 'INVALID_NATIVE_TASK_SPECIFICATION');
  });

  test('released original custody invalidates preparation even while its evaluation and boundary remain active', t => {
    const prepared = preparation(t);
    const index = taskIndex(prepared, 'copilot');
    const originals = binding(t, prepared, 'copilot');
    const { specification } = prepareLiveNativeTask(prepared.handle, index, originals);
    releaseCustody(originals.custody);
    assert.throws(() => describeLiveNativeTask(specification),
      error => error.code === 'INVALID_AUTH_CUSTODY');
    assert.throws(() => prepareLiveNativeTask(prepared.handle, index, originals),
      error => error.code === 'INVALID_AUTH_CUSTODY');
  });
}
