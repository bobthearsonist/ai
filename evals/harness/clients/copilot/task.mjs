import fs from 'node:fs';
import path from 'node:path';
import { captureArtifacts, gradeChecks } from '../../checks/index.mjs';
import { buildOfflineImage, runOfflineContainer, cleanupOfflineImage, BASE_IMAGE } from './index.mjs';
import { prepareOfflineTask, assertTaskPayload } from './task-policy.mjs';
import { verifyOfflineTaskRecord } from './task-parser.mjs';
import { CopilotTaskError, freezeTask } from './task-boundary.mjs';

/**
 * One fresh, actual native CLI task against an explicit local scripted inference
 * fixture. Private checks stay here; only public file bytes/targets go to Docker.
 */
export async function runOfflineTask(options) {
  const prepared = prepareOfflineTask(options);
  assertTaskPayload(prepared.payload);
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), prepared.timeoutMs);
  let owned, receipt;
  try {
    owned = await buildOfflineImage({ timeoutMs: prepared.timeoutMs, signal: controller.signal });
    const remaining = prepared.timeoutMs - (performance.now() - start);
    if (remaining <= 0) throw new CopilotTaskError('TASK_TIMEOUT');
    const output = await runOfflineContainer(owned, {
      mode: 'task', seconds: remaining / 1000, signal: controller.signal, payload: prepared.payload
    });
    if (output.exitCode !== 0) throw new CopilotTaskError('TASK_NATIVE_INFRASTRUCTURE_FAILED',
      'The pinned native container did not produce a completed task record');
    let record;
    try { record = JSON.parse(output.stdout); }
    catch { throw new CopilotTaskError('TASK_NATIVE_RECORD_INVALID'); }
    const verified = verifyOfflineTaskRecord(record, prepared);
    const artifactRoot = path.join(owned.directory, 'task-capture');
    fs.mkdirSync(artifactRoot, { mode: 0o700 });
    for (const [target, bytes] of verified.bytes) {
      const filename = path.join(artifactRoot, ...target.split('/'));
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o400 });
    }
    const capture = captureArtifacts({ artifactRoot, checks: prepared.checks });
    const grade = gradeChecks({ checks: prepared.checks, capture });
    receipt = {
      client: 'copilot', clientVersion: record.clientVersion,
      executionId: prepared.payload.executionId, task: prepared.task,
      promptHash: verified.promptHash, image: output.image, status: 'completed',
      transport: 'offline-mock', offlineEvidenceOnly: true,
      authenticationVerified: false, liveAccepted: false, qualityEvaluated: false,
      trigger: verified.trigger, capture, checks: grade.checks,
      evidence: { native: verified.native, checks: grade.evidence },
      runtime: {
        clientVersion: record.clientVersion, image: output.image, baseImage: BASE_IMAGE,
        nodeVersion: record.nodeVersion, engineVersion: output.engine, network: output.network,
        auth: 'none-offline', nativeSessionFresh: true, nativeInteractionId: verified.nativeInteractionId,
        model: 'offline-fixture-model', nativeElapsedMs: record.nativeElapsedMs
      },
      usage: {
        inputTokens: { value: null, provenance: 'unavailable' },
        outputTokens: { value: null, provenance: 'unavailable' },
        elapsedMs: { value: null, provenance: 'supervised-native-task-wall-clock including build, capture, grading and owned cleanup' },
        usd: { value: null, provenance: 'unavailable' },
        credits: { value: null, provenance: 'unavailable' }
      },
      cleanup: 'verified-owned-container-image-and-host-capture-removed'
    };
  } catch (error) {
    if (['CLEANUP_FAILED', 'OWNERSHIP'].includes(error.code)) {
      throw new CopilotTaskError(error.code, 'Owned native cleanup or provenance could not be verified');
    }
    if (controller.signal.aborted || error.code === 'TIMEOUT') throw new CopilotTaskError('TASK_TIMEOUT');
    if (error instanceof CopilotTaskError) throw error;
    throw new CopilotTaskError(error.code ?? 'TASK_INFRASTRUCTURE_FAILED',
      `Offline Copilot infrastructure failed (${error.code ?? 'unclassified'})`);
  } finally {
    clearTimeout(timer);
    if (owned) await cleanupOfflineImage(owned);
  }
  receipt.usage.elapsedMs.value = performance.now() - start;
  return freezeTask(receipt);
}
