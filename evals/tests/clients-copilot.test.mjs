import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  VERSION, BASE_IMAGE, CANARY, buildCopilotArguments, parseCopilotEvents, normalizeCopilotOutcome,
  assessDenials, assessArtifacts, requireLiveProfile, runOfflineProbe,
  buildOfflineImage, runOfflineContainer, cleanupOfflineImage
} from '../harness/clients/copilot/index.mjs';
const fixtures = JSON.parse(fs.readFileSync(new URL('../harness/clients/copilot/fixtures.json', import.meta.url)));
const outcome = mode => normalizeCopilotOutcome(fixtures[mode]);
const encode = events => events.map(e => JSON.stringify(e)).join('\n') + '\n';

test('exact pinned offline argument policy with opt-in native artifact writes', () => {
  assert.equal(VERSION, '1.0.92');
  assert.match(BASE_IMAGE, /@sha256:[a-f0-9]{64}$/);
  const readOnly = buildCopilotArguments();
  assert.ok(readOnly.includes('write'));
  assert.ok(!readOnly.includes('create'));
  const scoped = buildCopilotArguments({ artifactTargets: ['answer.md', 'message.txt'] });
  assert.ok(scoped.includes('create') && scoped.includes('edit'));
  assert.ok(scoped.includes('write(/workspace/answer.md)') && scoped.includes('write(/workspace/message.txt)'));
  assert.ok(!scoped.some(a => /--allow-all|--yolo/.test(a)));
  assert.ok(scoped.includes('--disallow-temp-dir') && scoped.includes('--disable-builtin-mcps'));
});

test('artifact grants reject traversal, absolute paths, duplicates and unapproved files', () => {
  for (const artifactTargets of [['../answer.md'], ['/workspace/answer.md'], ['fixture.txt'],
    ['answer.md', 'answer.md'], ['ANSWER.md'], 'answer.md', ['answer.md', 'message.txt', 'third.md']]) {
    assert.throws(() => buildCopilotArguments({ artifactTargets }));
  }
  assert.throws(() => buildCopilotArguments({ prompt: 'x'.repeat(4097) }));
});

test('recorded actual discovery plus successful native Skill and Read normalize', () => {
  const r = outcome('candidate');
  assert.equal(r.transport, 'offline-mock/not-live');
  assert.equal(r.trigger.loaded, true);
  assert.equal(r.fixtureRead.succeeded, true);
  assert.equal(r.completion.status, 'completed');
  assert.equal(r.completion.text, 'OFFLINE_FIXTURE_COMPLETE');
  assert.equal(r.modelQualityEvidence, false);
  assert.equal(r.liveSupported, false);
  assert.ok(fixtures.candidate.provider.requestShapes.some(r => r.skillContextSeen));
});

test('fresh recorded no-skill control has no project trigger but does native Read', () => {
  const r = outcome('control');
  assert.equal(r.trigger.discovered, false);
  assert.equal(r.trigger.loaded, false);
  assert.equal(r.fixtureRead.succeeded, true);
  assert.equal(fixtures.control.freshWorkspace, true);
  assert.equal(fixtures.control.skillPresent, false);
});

test('requested, failed or merely advertised Skill never qualifies as successful load', () => {
  const events = parseCopilotEvents(fixtures.candidate.stdout);
  const result = events.find(e => e.type === 'tool.execution_complete' && e.data.toolCallId === 'fixture_call_0');
  result.data.success = false;
  result.data.error = { code: 'denied', message: 'denied' };
  const r = normalizeCopilotOutcome({ ...fixtures.candidate, stdout: encode(events) });
  assert.equal(r.trigger.loaded, false);
  assert.equal(r.completion.status, 'error');
});

test('strict parser rejects malformed, partial, duplicate, unknown and mismatched output', () => {
  const events = parseCopilotEvents(fixtures.candidate.stdout);
  for (const stdout of ['', '{', fixtures.candidate.stdout + 'junk', encode(events.slice(0, -1)),
    encode([...events, events.at(-1)]), encode([{ type: 'invented', data: {} }, ...events]),
    encode(events.filter(e => !(e.type === 'tool.execution_complete' && e.data.toolCallId === 'fixture_call_0'))),
    encode([events.find(e => e.type === 'tool.execution_complete'), ...events])]) {
    assert.throws(() => parseCopilotEvents(stdout), e => e.code === 'COPILOT_PARSE_ERROR');
  }
  assert.throws(() => normalizeCopilotOutcome({ ...fixtures.candidate, exitCode: 1 }));
});

test('tokens, USD, AI credits and premium requests remain distinct; unavailable stays null', () => {
  const r = outcome('candidate');
  assert.equal(r.usage.usd, null);
  assert.equal(r.usage.aiCredits, 0);
  assert.equal(r.usage.premiumRequests, 0);
  assert.equal(r.usage.tokens.inputTokens, 100);
  const missing = normalizeCopilotOutcome({ ...fixtures.candidate, usage: null });
  assert.equal(missing.usage.tokens, null);
  assert.equal(missing.usage.aiCredits, null);
  const invalid = structuredClone(fixtures.candidate);
  invalid.usage.totalNanoAiu = -1;
  invalid.usage.modelMetrics['offline-fixture-model'].usage.inputTokens = -1;
  assert.equal(normalizeCopilotOutcome(invalid).usage.tokens, null);
});

test('actual proc/private/home/temp/symlink/shell/network/write denials are mandatory', () => {
  const actual = fixtures.attacks;
  assert.equal(assessDenials(actual, outcome('attacks')).accepted, true);
  assert.equal(assessDenials({ ...actual, leakDetected: true }, outcome('attacks')).accepted, false);
  assert.equal(assessDenials({ ...actual, agentWroteFile: true }, outcome('attacks')).accepted, false);
  assert.equal(assessDenials({ ...actual, provider: { ...actual.provider, calls: actual.provider.calls.slice(1) } }, outcome('attacks')).accepted, false);
});

test('actual native creation verifies artifact bytes; stdout completion is insufficient', () => {
  const actual = fixtures['candidate-write'];
  assert.equal(assessArtifacts(actual, outcome('candidate-write')).accepted, true);
  assert.equal(assessArtifacts(fixtures['control-write'], outcome('control-write')).accepted, true);
  assert.equal(assessArtifacts({ ...actual, artifacts: {} }, outcome('candidate-write')).accepted, false);
  assert.equal(assessArtifacts({ ...actual, artifacts: { 'answer.md': 'wrong', 'message.txt': 'wrong' } }, outcome('candidate-write')).accepted, false);
});

test('scoped native writes reject protected fixtures, HOME, config and allowed-target symlink', () => {
  const r = assessDenials(fixtures['attacks-write'], outcome('attacks-write'));
  assert.equal(r.accepted, true);
  assert.equal(r.evidence.length, 14);
  assert.ok(r.evidence.some(e => e.path === '/workspace/fixture.txt' && e.denied));
  assert.ok(r.evidence.some(e => e.path === '/client-config/protected.json' && e.denied));
  assert.ok(r.evidence.some(e => e.path === '/workspace/answer.md' && e.denied));
});

test('actual local authentication and tool failures cannot become passing completion', () => {
  const auth = outcome('auth-error');
  assert.equal(auth.completion.status, 'error');
  assert.equal(auth.completion.exitCode, 1);
  assert.ok(auth.completion.errors.some(e => e.errorType === 'authentication' && e.statusCode === 401));
  const tool = outcome('tool-error');
  assert.equal(tool.completion.status, 'error');
  assert.ok(tool.completion.errors.length > 0);
});

test('recordings contain synthetic-only provenance and no canary/header leakage', () => {
  assert.ok(!JSON.stringify(fixtures).includes(CANARY));
  for (const r of Object.values(fixtures)) {
    assert.equal(r.transport, 'offline-mock/not-live');
    assert.equal(r.nodeVersion, '22.22.1');
    assert.equal(r.leakDetected, false);
    assert.equal(r.agentWroteFile, false);
    assert.ok(r.provider.requestShapes.every(s => s.path === '/v1/chat/completions' && s.model === 'offline-fixture-model'));
  }
});

test('live path remains unconditionally blocked; probe validates targets before Docker', async () => {
  assert.throws(requireLiveProfile, e => e.code === 'LIVE_BOUNDARY_UNVERIFIED');
  await assert.rejects(runOfflineProbe({ artifactTargets: ['fixture.txt'] }));
  await assert.rejects(runOfflineProbe({ timeoutMs: 0 }));
  await assert.rejects(runOfflineContainer({ image: 'sha256:' + 'a'.repeat(64), id: 'forged' }), e => e.code === 'OWNERSHIP');
  await assert.rejects(cleanupOfflineImage({ image: 'sha256:' + 'a'.repeat(64), id: 'forged' }), e => e.code === 'OWNERSHIP');
});

const docker = process.env.EVAL_CLIENT_COPILOT_DOCKER === '1';
test('actual Docker CLI discovery/control/native writes and denials accepted', { skip: !docker, timeout: 360000 }, async t => {
  const report = await runOfflineProbe({ timeoutMs: 300000, artifactTargets: ['answer.md', 'message.txt'] });
  assert.equal(report.clientVersion, '1.0.92');
  assert.equal(report.transport, 'offline-mock/not-live');
  assert.equal(report.pilotWritesVerified, true);
  assert.equal(report.liveAccepted, false);
  assert.equal(report.qualityEvaluated, false);
  assert.equal(report.artifactProfile.denial.accepted, true);
  assert.match(report.image, /^sha256:[a-f0-9]{64}$/);
  assert.equal(report.freshWorkspaces, 6);
  t.diagnostic(JSON.stringify({ image: report.image, version: report.clientVersion, pilotWritesVerified: report.pilotWritesVerified,
    cleanup: report.cleanup, readDenials: report.denial.evidence.length, writeDenials: report.artifactProfile.denial.evidence.length }));
});

test('actual Docker local auth/tool errors, timeout and cancellation clean owned resources', { skip: !docker, timeout: 180000 }, async () => {
  const owned = await buildOfflineImage();
  try {
    for (const mode of ['auth-error', 'tool-error']) {
      const output = await runOfflineContainer(owned, { mode, seconds: 60 });
      assert.equal(normalizeCopilotOutcome({ ...JSON.parse(output.stdout), image: owned.image }).completion.status, 'error');
    }
    await assert.rejects(runOfflineContainer(owned, { mode: 'hang', seconds: 5 }), e => e.code === 'TIMEOUT');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await assert.rejects(runOfflineContainer(owned, { mode: 'hang', seconds: 60, signal: controller.signal }), e => e.code === 'CANCELLED');
    } finally { clearTimeout(timer); }
  } finally { await cleanupOfflineImage(owned); }
});
