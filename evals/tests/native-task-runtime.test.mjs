import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeLiveEvaluation, inspectLiveNativeTaskRuntime, prepareLiveEvaluation,
  prepareLiveNativeTask, releaseLiveEvaluation
} from '../harness/live-execution.mjs';
import { prepareNativeAuthCustody, releaseNativeAuthCustody } from '../harness/auth/custody.mjs';
import {
  attachEgressCandidate, prepareNativeEgressCandidate, startEgressBoundary, stopEgressBoundary
} from '../harness/live-boundary/index.mjs';
import {
  prepareNativeImage, cleanupNativeImage
} from '../harness/clients/claude-code/index.mjs';
import {
  buildNativeImage, cleanupNativeImage as cleanupCopilotImage
} from '../harness/clients/copilot/index.mjs';
import {
  prepareNativeRuntimeImage, cleanupNativeRuntimeImage
} from '../harness/clients/opencode/index.mjs';
import { nativeMatrixFixture } from './helpers.mjs';

const enabled = process.env.SKILL_EVAL_NATIVE_RUNTIME_INTEGRATION === '1';
const clients = {
  'claude-code': {
    prepareImage: prepareNativeImage, cleanupImage: cleanupNativeImage,
    model: 'claude-sonnet-4-6', endpoint: 'https://api.anthropic.com'
  },
  copilot: {
    prepareImage: buildNativeImage, cleanupImage: cleanupCopilotImage,
    model: 'gpt-4.1', endpoint: 'https://api.githubcopilot.com'
  },
  opencode: {
    prepareImage: prepareNativeRuntimeImage, cleanupImage: cleanupNativeRuntimeImage,
    model: 'github-copilot/gpt-4.1', endpoint: 'https://api.githubcopilot.com'
  }
};

for (const [client, adapter] of Object.entries(clients)) {
  test(`original ${client} runtime inspection is version/help-only, not native task admission`,
    { skip: !enabled, timeout: 600_000 }, async t => {
      let imageHandle, boundary, custody, evaluation;
      t.after(async () => {
        const failures = [];
        if (boundary) {
          try {
            const cleanup = await stopEgressBoundary(boundary);
            assert.equal(cleanup.cleanupVerified, true);
          } catch (error) { failures.push(error); }
        }
        if (imageHandle) {
          try { await adapter.cleanupImage(imageHandle); } catch (error) { failures.push(error); }
        }
        if (custody) {
          try { releaseNativeAuthCustody(custody); } catch (error) { failures.push(error); }
        }
        if (evaluation) {
          try { releaseLiveEvaluation(evaluation); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, 'Original native runtime test cleanup failed');
      });
      const { mockScenarios, ...options } = nativeMatrixFixture(t, { privateContext: true });
      options.selection.clients = [client];
      options.profile.auth = 'native-client-auth';
      options.profile.limits.seconds = 180;
      Object.assign(options.profile.clients[client], {
        model: adapter.model, endpoint: adapter.endpoint, settings: {}
      });
      const prepared = prepareLiveEvaluation(options);
      evaluation = prepared.handle;
      custody = prepareNativeAuthCustody({ client, evaluation });
      imageHandle = await adapter.prepareImage();
      boundary = await startEgressBoundary({
        hosts: [new URL(adapter.endpoint).hostname], timeoutSeconds: 180, mode: 'egress-only'
      });
      const candidate = await prepareNativeEgressCandidate(boundary, { client, imageHandle });
      await attachEgressCandidate(candidate);
      const { specification } = prepareLiveNativeTask(evaluation, 0, { boundary, candidate, custody });
      const report = await inspectLiveNativeTaskRuntime(specification, { imageHandle });
      const nativeUserId = client === 'copilot' ? 10001 : 1000;
      assert.equal(report.nativeRuntimeVerified, true);
      assert.equal(report.nativeImageAttached, true);
      assert.equal(report.runtimeObservation.client, client);
      assert.equal(report.runtimeObservation.clientVersion, prepared.report.requestedRoutes[client].clientVersion);
      assert.equal(report.runtimeObservation.uid, nativeUserId);
      assert.equal(report.runtimeObservation.gid, nativeUserId);
      assert.match(report.runtimeObservation.imageId, /^sha256:[a-f0-9]{64}$/);
      assert.equal(report.imageMatchesProfile, null);
      assert.equal(report.requestedImageVerified, false);
      assert.equal(report.observedModel, null);
      assert.equal(report.observedUsage, null);
      for (const field of [
        'executed', 'executionAuthorized', 'authenticationVerified', 'credentialToolBoundaryVerified',
        'serviceEgressVerified', 'limitsVerified', 'consumptionEnforcementVerified', 'liveAccepted'
      ]) assert.equal(report[field], false);
      assert.equal(describeLiveEvaluation(evaluation).executed, false);
      assert.equal(JSON.stringify(report).includes('PRIVATE-GRADER-DATA'), false);
      await assert.rejects(inspectLiveNativeTaskRuntime(specification,
        { imageHandle: { ...imageHandle } }));
      t.diagnostic(JSON.stringify({
        classification: 'actual-original-native-runtime-version-help-only',
        client, runtimeObservation: report.runtimeObservation,
        authenticationVerified: false, liveAccepted: false
      }));
    });
}
