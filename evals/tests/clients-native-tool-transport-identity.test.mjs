import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  issueToolTask, prepareToolWorker, closeToolWorker
} from '../harness/tool-worker/index.mjs';
import { prepareNativeTaskSpecification as claude } from '../harness/clients/claude-code/native.mjs';
import { prepareNativeTaskSpecification as copilot } from '../harness/clients/copilot/native-spec.mjs';
import { prepareNativeTaskSpecification as opencode } from '../harness/clients/opencode/native-spec.mjs';

test('real prepared worker identities reject unissued transport leases without Docker or native evidence', async () => {
  for (const [client, prepare, options] of [
    ['claude-code', claude, { model: 'claude-sonnet-4-6', authRoot: '/home/node/.claude',
      proxyURL: 'http://127.0.0.1:8080' }],
    ['copilot', copilot, { model: 'gpt-5.4', authRoot: '/client-config/copilot',
      proxyURL: 'http://127.0.0.1:8080' }],
    ['opencode', opencode, { model: 'openai/gpt-5.4' }]
  ]) {
    const task = issueToolTask({ invocationId: randomUUID(), caseId: 'prepared-identity',
      client, arm: 'no-skill', repeat: 1 });
    const worker = prepareToolWorker({ task, publicFiles: [{ path: 'inputs/note.txt', content: 'Public note' }],
      artifactTargets: ['artifacts/result.txt'] });
    try {
      const payload = { task: { ...task.coordinates, fixtureHash: 'a'.repeat(64) }, prompt: 'Write the declared result.',
        skill: { id: 'identity-only-skill', files: [] }, inputs: [{ path: 'note.txt', content: 'Public note' }],
        artifactTargets: ['result.txt'] };
      const tuple = { task, worker, lease: Object.freeze({ kind: 'tool-worker-transport-lease' }),
        binding: Object.freeze({ kind: 'tool-worker-transport-binding' }) };
      assert.throws(() => prepare(payload, { ...options, toolTransport: tuple }),
        { code: 'ORIGINAL_TRANSPORT_LEASE_REQUIRED' });
      assert.throws(() => prepare(payload, { ...options, toolTransport: structuredClone(tuple) }),
        { code: 'ORIGINAL_TASK_REQUIRED' });
      assert.throws(() => prepare(payload, { ...options, toolTransport: { ...tuple, worker: { ...worker } } }),
        { code: 'ORIGINAL_WORKER_SCOPE_REQUIRED' });
      assert.throws(() => prepare(payload, { ...options, toolTransport: { ...tuple, command: ['caller'] } }),
        { code: 'INVALID_FIELDS' });
    } finally {
      const cleanup = await closeToolWorker({ task, worker });
      assert.equal(cleanup.ownedDirectoryRemoved, true);
      assert.equal(cleanup.exactOwnedCleanup, true);
      assert.equal(cleanup.authenticationVerified, false);
      assert.equal(cleanup.liveAccepted, false);
    }
  }
});
