import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeClients } from '../harness/client-probes.mjs';

const versions = { 'claude-code': '2.1.291', opencode: '1.14.28', copilot: '1.0.92' };
const cli = fileURLToPath(new URL('../harness/cli.mjs', import.meta.url));

test('only selected actual adapter APIs are dispatched; reports cannot become live quality evidence', async () => {
  const calls = [];
  const loadClient = async client => ({
    runOfflineProbe({ timeoutMs, artifactTargets }) {
      calls.push({ client, timeoutMs });
      assert.deepEqual(artifactTargets, ['answer.md', 'message.txt']);
      return { client, clientVersion: versions[client], transport: 'offline-mock', pilotWritesVerified: true };
    }
  });
  const first = await probeClients({ clients: ['opencode', 'copilot'], timeoutSeconds: 42 }, { loadClient });
  const second = await probeClients({ clients: ['opencode'], timeoutSeconds: 42 }, { loadClient });
  assert.deepEqual(calls, [
    { client: 'opencode', timeoutMs: 42_000 }, { client: 'copilot', timeoutMs: 42_000 },
    { client: 'opencode', timeoutMs: 42_000 }
  ]);
  assert.notEqual(first.invocationId, second.invocationId);
  assert.deepEqual(first.clients, ['opencode', 'copilot']);
  assert.equal(first.liveAccepted, false);
  assert.equal(first.qualityEvaluated, false);
  assert.equal(first.baselineApproved, false);
  assert.equal(first.offlineEvidenceOnly, true);
});

test('empty, unknown, duplicate clients and invalid limits fail before loading or Docker execution', async () => {
  const loadClient = () => assert.fail('must not load a client');
  for (const clients of [[], ['unknown'], ['copilot', 'copilot'], 'copilot', [null]]) {
    await assert.rejects(probeClients({ clients }, { loadClient }), /selection/);
  }
  for (const timeoutSeconds of [0, -1, 0.5, Infinity, NaN, '180', 3601]) {
    await assert.rejects(probeClients({ clients: ['opencode'], timeoutSeconds }, { loadClient }), /timeout/);
  }
});

test('missing, errored, version-drifted and live-shaped adapters fail explicitly', async () => {
  const inputs = [
    {}, { runOfflineProbe() { throw new Error('fixture denial failed'); } },
    { runOfflineProbe() { return { client: 'opencode', clientVersion: 'other' }; } },
    { runOfflineProbe() { return { client: 'copilot', clientVersion: versions.copilot }; } },
    { runOfflineProbe() { return { client: 'opencode', clientVersion: versions.opencode }; } },
    { runOfflineProbe() { return { client: 'opencode', clientVersion: versions.opencode, pilotWritesVerified: true, liveAccepted: true }; } },
    { runOfflineProbe() { return { client: 'opencode', clientVersion: versions.opencode, pilotWritesVerified: true, qualityEvaluated: true }; } },
    { runOfflineProbe() { return { client: 'opencode', clientVersion: versions.opencode, pilotWritesVerified: true, passed: false }; } },
    { runOfflineProbe() { return { client: 'opencode', clientVersion: versions.opencode, pilotWritesVerified: true, status: 'timeout' }; } },
    { runOfflineProbe() { return { client: 'opencode', clientVersion: versions.opencode, pilotWritesVerified: true, error: 'failed denial' }; } },
    ...[
      { accepted: false }, { modelQualityEvidence: true }, { offlineEvidenceOnly: false },
      { transport: 'direct-provider' }, { status: 'aborted' }, { status: 'partial' },
      { status: 'failed' }, { status: 'unsupported' }
    ].map(fields => ({
      runOfflineProbe() {
        return { client: 'opencode', clientVersion: versions.opencode, pilotWritesVerified: true, ...fields };
      }
    })),
    { runOfflineProbe() { return null; } }
  ];
  for (const adapter of inputs) {
    await assert.rejects(probeClients({ clients: ['opencode'] }, { loadClient: async () => adapter }), /opencode offline probe failed/);
  }
});

test('shared CLI documents offline probes and rejects invalid input before adapter execution', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /probe-clients/);
  for (const args of [
    ['probe-clients', '--clients', 'unknown'],
    ['probe-clients', '--clients', 'copilot,copilot'],
    ['probe-clients', '--timeout-seconds', '1.2'],
    ['probe-clients', '--timeout-seconds', '0'],
    ['probe-clients', '--profile', 'a-live-profile.json']
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).passed, false);
  }
});

test('run validates supplied suite, profile and matrix before reporting the missing adapter', () => {
  const suite = fileURLToPath(new URL('./fixtures/example/suite.json', import.meta.url));
  const profile = fileURLToPath(new URL('./fixtures/profile.json', import.meta.url));
  const cases = [
    { args: ['--suite', suite], message: /--profile is required/ },
    { args: ['--profile', profile], message: /--suite is required/ },
    { args: ['--suite', suite, '--profile', profile, '--cases', 'unknown'], message: /Unknown case/ },
    { args: ['--suite', suite, '--profile', profile, '--clients', 'unknown'], message: /Unsupported client/ },
    { args: ['--suite', suite, '--profile', profile, '--cases', 'explicit', '--clients', 'copilot'],
      message: /No real execution adapter.*6 fresh sessions/ }
  ];
  for (const { args, message } of cases) {
    const result = spawnSync(process.execPath, [cli, 'run', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(JSON.parse(result.stderr).failures[0].message, message);
  }
});
