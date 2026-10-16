import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hashContent, readJson, validateDocument } from '../harness/index.mjs';
import { CLIENT_VERSIONS, destroyWorkspace } from '../harness/isolation/index.mjs';
import { captureArtifacts, gradeChecks, readCapturedArtifact } from '../harness/checks/index.mjs';
import { executeOfflineCaseMatrix, persistOfflineCaseMatrix, prepareOfflineCaseMatrix } from '../harness/task-execution.mjs';
import { nativeMatrixFixture as fixture } from './helpers.mjs';

const workRoot = fileURLToPath(new URL('../.work', import.meta.url));

test('preparation binds current exported bytes and three independent tasks per comparison arm', t => {
  const options = fixture(t);
  const prepared = prepareOfflineCaseMatrix(options);
  assert.equal(prepared.tasks.length, 6);
  assert.equal(prepared.profilePinsApplied, false);
  assert.notEqual(prepared.snapshots.candidate.snapshotId, prepared.snapshots.baseline.snapshotId);
  assert.equal(prepared.timeoutSeconds, options.profile.limits.seconds);
  for (const arm of ['candidate', 'baseline']) {
    const tasks = prepared.tasks.filter(payload => payload.task.arm === arm);
    assert.deepEqual(tasks.map(payload => payload.task.repeat), [1, 2, 3]);
    assert.ok(tasks.every(payload => payload.task.invocationId === prepared.invocationId));
    assert.ok(tasks.every(payload => payload.skill.files[0].content.includes(`${arm} skill bytes`)));
    assert.ok(tasks.every(payload => payload.skill.files.every(file => file.path !== 'unrelated.txt')));
  }
  assert.notEqual(prepared.tasks[0].skill.files[0].content, prepared.tasks[1].skill.files[0].content);
  prepared.tasks[0].skill.files[0].content.fill(0);
  assert.equal(prepared.tasks[1].skill.files[0].content.includes('candidate skill bytes'), true);
});

test('private provided dependencies are hash-bound but excluded from every native input', t => {
  const options = fixture(t, { privateContext: true });
  const prepared = prepareOfflineCaseMatrix(options);
  for (const payload of prepared.tasks) {
    assert.deepEqual(payload.inputs.map(file => file.path), ['docs/guide.txt']);
    assert.ok(payload.inputs.every(file => !file.content.includes('PRIVATE-GRADER-DATA')));
    assert.ok(payload.skill.files.every(file => !file.content.includes('PRIVATE-GRADER-DATA')));
  }
  const oldHash = prepared.tasks[0].task.fixtureHash;
  fs.writeFileSync(path.join(path.dirname(options.suiteFile), 'private.txt'), 'Changed private grading fixture');
  assert.notEqual(prepareOfflineCaseMatrix(options).tasks[0].task.fixtureHash, oldHash);
});

test('case preparation preserves literal CRLF, LF and missing final newline bytes', t => {
  const options = fixture(t);
  const hashes = new Set();
  for (const text of ['first\r\nsecond\r\n', 'first\nsecond\n', 'first\r\nsecond']) {
    const content = Buffer.from(text);
    fs.writeFileSync(path.join(path.dirname(options.suiteFile), 'guide.txt'), content);
    const prepared = prepareOfflineCaseMatrix(options);
    for (const payload of prepared.tasks) {
      assert.deepEqual(payload.inputs[0].content, content);
      assert.equal(hashContent(payload.inputs[0].content), hashContent(content));
    }
    hashes.add(prepared.tasks[0].task.fixtureHash);
  }
  assert.equal(hashes.size, 3);
});

test('no-skill diagnostic never receives target bytes or a scripted target load', t => {
  const options = fixture(t);
  options.selection.arms = ['candidate', 'baseline', 'no-skill'];
  const prepared = prepareOfflineCaseMatrix(options);
  assert.equal(prepared.tasks.length, 9);
  const controls = prepared.tasks.filter(payload => payload.task.arm === 'no-skill');
  assert.ok(controls.every(payload => payload.skill.files.length === 0 && payload.mock.loadSkill === false));
  assert.ok(controls.every(payload => payload.prompt === prepared.tasks[0].prompt));
});

test('all selected cases require explicit independent scenarios; none are generated from grading data', t => {
  const options = fixture(t);
  for (const scenarios of [undefined, [], [{ ...options.mockScenarios[0], caseId: 'unknown' }],
    [{ ...options.mockScenarios[0], rubric: 'forbidden' }]]) {
    assert.throws(() => prepareOfflineCaseMatrix({ ...options, mockScenarios: scenarios }));
  }
  assert.throws(() => prepareOfflineCaseMatrix({
    ...options, selection: { cases: ['explicit', 'implicit'], clients: ['copilot'] }
  }), /one explicit mock scenario/);
  options.mockScenarios[0].loadSkill = false;
  assert.ok(prepareOfflineCaseMatrix(options).tasks.every(payload => payload.mock.loadSkill === false));
});

test('native versions, offline auth, public runner and time caps fail before source dispatch', t => {
  const options = fixture(t);
  for (const mutate of [
    profile => { profile.auth = 'native-client-auth'; },
    profile => { profile.runner = 'unsupported-private-runner'; },
    profile => { profile.clients.copilot.version = 'test-only'; },
    profile => { profile.limits.seconds = 301; },
    profile => { profile.limits.concurrency = 5; }
  ]) {
    const profile = structuredClone(options.profile);
    mutate(profile);
    assert.throws(() => prepareOfflineCaseMatrix({ ...options, profile }));
  }
});

test('tampered exports, missing selected skill and ambiguous relative paths cannot become native inputs', t => {
  const options = fixture(t);
  for (const skillPath of ['../escape', '.', 'skills\\..\\example-skill', 'skills\\missing', 'skills\\\\example-skill']) {
    assert.throws(() => prepareOfflineCaseMatrix({ ...options, skillPath }));
  }
  fs.writeFileSync(path.join(options.candidateExport, 'skills', 'example-skill', 'SKILL.md'), 'tampered');
  assert.throws(() => prepareOfflineCaseMatrix(options), /mismatch/);
});

test('undeclared, duplicated, escaped and oversized mock artifacts are rejected, not silently rewritten', t => {
  const options = fixture(t);
  for (const artifacts of [
    [{ path: '../escape', content: 'invalid' }],
    [{ path: 'other.txt', content: 'undeclared' }],
    [{ path: 'plan.txt', content: 'first' }, { path: 'plan.txt', content: 'second' }],
    [{ path: 'plan.txt', content: 'value', expected: 'hidden grading field' }],
    [{ path: 'plan.txt', content: 'x'.repeat(1024 * 1024 + 1) }]
  ]) {
    assert.throws(() => prepareOfflineCaseMatrix({ ...options,
      mockScenarios: [{ caseId: 'explicit', loadSkill: true, artifacts }] }));
  }
});

function injectedClient(t, transform = receipt => receipt) {
  let count = 0;
  const roots = [];
  t.after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })));
  const loadClient = async client => ({
    async runOfflineTask(payload) {
      count++;
      const root = path.join(workRoot, `capture-tests-${randomUUID()}`);
      fs.mkdirSync(root);
      roots.push(root);
      for (const artifact of payload.mock.artifacts) {
        fs.writeFileSync(path.join(root, artifact.path), artifact.content);
      }
      const capture = captureArtifacts({ artifactRoot: root, checks: payload.checks });
      const loaded = payload.mock.loadSkill;
      const receipt = {
        client, clientVersion: CLIENT_VERSIONS[client], executionId: randomUUID(), task: { ...payload.task },
        promptHash: hashContent(payload.prompt), image: `sha256:${'b'.repeat(64)}`,
        ...(client === 'opencode' ? {
          promptEnvelope: 'opencode-1.14.28-stdin-newline', wireMessageHash: hashContent(`\n${payload.prompt}`)
        } : {}),
        status: 'completed', transport: 'offline-mock', offlineEvidenceOnly: true,
        authenticationVerified: false, liveAccepted: false,
        trigger: {
          loaded, evidence: [{ kind: loaded ? 'skill-load' : 'discovery-audit',
            skill: payload.skill.id, ref: 'injected-test-event' }]
        },
        capture, checks: gradeChecks({ checks: payload.checks, capture }).checks,
        usage: Object.fromEntries(['inputTokens', 'outputTokens', 'elapsedMs', 'usd', 'credits']
          .map(name => [name, { value: null, provenance: 'unavailable' }]))
      };
      return transform(receipt, payload, count, root);
    }
  });
  return { loadClient, count: () => count };
}

test('public SDK case scheduling grades original trusted captures without claiming live or approved baseline', async t => {
  const options = fixture(t);
  const client = injectedClient(t);
  const { report, captures } = await executeOfflineCaseMatrix(options, client);
  assert.equal(client.count(), 6);
  assert.equal(report.completedTaskCount, 6);
  assert.equal(report.diagnosticsPassed, true, JSON.stringify(report.failures));
  assert.equal(report.evidenceSource, 'injected-test-callbacks');
  assert.equal(report.contractMatrixComplete, false);
  assert.equal(report.profilePinsApplied, false);
  assert.equal(report.liveAccepted, false);
  assert.equal(report.authenticationVerified, false);
  assert.equal(report.baselineApproved, false);
  assert.equal(report.qualityEvaluated, false);
  assert.throws(() => validateDocument('results', report));
  assert.equal(readCapturedArtifact(captures[0].capture, 'plan.txt').toString(), 'Independent public mock output');
});

test('OpenCode requires exact native prompt framing evidence and retains it in persisted results', async t => {
  for (const [transform, passed] of [
    [receipt => receipt, true],
    [receipt => { delete receipt.promptEnvelope; return receipt; }, false],
    [receipt => { receipt.promptEnvelope = 'unverified-envelope'; return receipt; }, false],
    [receipt => { receipt.wireMessageHash = hashContent('Changed native wire'); return receipt; }, false]
  ]) {
    const options = fixture(t);
    options.selection.clients = ['opencode'];
    const client = injectedClient(t, transform);
    const matrix = await executeOfflineCaseMatrix(options, client);
    assert.equal(client.count(), 6);
    assert.equal(matrix.report.diagnosticsPassed, passed, JSON.stringify(matrix.report.failures));
    if (!passed) {
      assert.equal(matrix.report.completedTaskCount, 0);
      assert.ok(matrix.report.failures.every(failure => /exact observed wire hash/.test(failure.message)));
      continue;
    }
    const stored = persistOfflineCaseMatrix(matrix);
    t.after(() => destroyWorkspace(stored.workspace));
    for (const reference of stored.manifest.executions) {
      const evidence = readJson(path.join(stored.workspace.directory, reference.evidenceFile));
      assert.equal(evidence.native.promptEnvelope, 'opencode-1.14.28-stdin-newline');
      assert.equal(evidence.native.wireMessageHash, hashContent(`\n${readJson(options.suiteFile).cases[0].prompt}`));
    }
  }
});

test('optional no-skill controls remain empty through SDK scheduling and host grading', async t => {
  const options = fixture(t);
  options.selection.arms = ['candidate', 'baseline', 'no-skill'];
  const controls = [];
  const client = injectedClient(t, (receipt, payload) => {
    if (payload.task.arm === 'no-skill') controls.push(payload);
    return receipt;
  });
  const { report } = await executeOfflineCaseMatrix(options, client);
  assert.equal(client.count(), 9);
  assert.equal(report.completedTaskCount, 9);
  assert.equal(report.diagnosticsPassed, true, JSON.stringify(report.failures));
  assert.equal(controls.length, 3);
  assert.ok(controls.every(payload => payload.skill.files.length === 0 && payload.mock.loadSkill === false));
  assert.ok(report.executions.filter(execution => execution.task.arm === 'no-skill')
    .every(execution => execution.discovery.status === 'passed' && execution.discovery.loaded === false));
});

test('all fresh planned slots still execute after missing native receipts; incomplete results fail diagnostics', async t => {
  const options = fixture(t);
  const client = injectedClient(t, (receipt, payload, count) => {
    if (count === 1) throw new Error('Synthetic native execution failure');
    return receipt;
  });
  const { report } = await executeOfflineCaseMatrix(options, client);
  assert.equal(client.count(), 6);
  assert.equal(report.attemptedTaskCount, 6);
  assert.equal(report.completedTaskCount, 5);
  assert.equal(report.diagnosticsPassed, false);
  assert.equal(report.executions[0].executionId, null);
  assert.equal(report.executions[0].usage, null);
  assert.match(report.failures[0].message, /Synthetic native execution failure/);
});

test('missing discovery, mismatched grader claims and non-authentic captures cannot pass', async t => {
  for (const transform of [
    receipt => { receipt.trigger.evidence = []; return receipt; },
    receipt => { receipt.checks = []; return receipt; },
    receipt => { receipt.capture = Object.freeze({}); return receipt; },
    receipt => { delete receipt.usage.credits; return receipt; },
    receipt => { receipt.usage.usd = { value: null, provenance: 'client-reported' }; return receipt; }
  ]) {
    const options = fixture(t);
    const client = injectedClient(t, transform);
    const { report } = await executeOfflineCaseMatrix(options, client);
    assert.equal(client.count(), 6);
    assert.equal(report.diagnosticsPassed, false);
    assert.ok(report.failures.length > 0);
  }
});

test('a reused capture handle is a freshness failure even with distinct native execution IDs', async t => {
  const options = fixture(t);
  let cached;
  const client = injectedClient(t, receipt => {
    cached ??= receipt.capture;
    receipt.capture = cached;
    return receipt;
  });
  const { report } = await executeOfflineCaseMatrix(options, client);
  assert.equal(client.count(), 6);
  assert.equal(report.diagnosticsPassed, false);
  assert.ok(report.failures.some(failure => /capture was reused/.test(failure.message)));
});

test('receipt metadata cannot override host-computed failed discovery', async t => {
  const options = fixture(t);
  const client = injectedClient(t, receipt => {
    receipt.trigger.status = 'passed';
    receipt.trigger.evidence = [];
    return receipt;
  });
  const { report } = await executeOfflineCaseMatrix(options, client);
  assert.equal(client.count(), 6);
  assert.equal(report.diagnosticsPassed, false);
  assert.ok(report.executions.every(execution => execution.discovery.status === 'failed'));
});

test('offline persistence retains exact captured bytes and per-slot failures after source removal', async t => {
  const options = fixture(t);
  options.mockScenarios[0].artifacts[0].content = 'Exact captured bytes\r\n\u0000tail';
  const client = injectedClient(t, (receipt, payload, count, root) => {
    fs.rmSync(root, { recursive: true, force: true });
    return receipt;
  });
  const matrix = await executeOfflineCaseMatrix(options, client);
  const persisted = persistOfflineCaseMatrix(matrix);
  t.after(() => destroyWorkspace(persisted.workspace));
  const manifest = readJson(persisted.reportFile);
  assert.equal(manifest.kind, 'offline-native-case-matrix');
  assert.equal(manifest.evidenceSource, 'injected-test-callbacks');
  assert.equal(manifest.contractMatrixComplete, false);
  assert.equal(manifest.executions.length, 6);
  for (const reference of manifest.executions) {
    assert.equal(reference.failure, null);
    assert.equal(reference.error, null);
    const evidence = readJson(path.join(persisted.workspace.directory, reference.evidenceFile));
    assert.deepEqual(evidence.task, reference.task);
    assert.deepEqual(evidence.failures, []);
    const bytes = Buffer.from(evidence.artifacts[0].base64, 'base64');
    assert.equal(bytes.toString(), options.mockScenarios[0].artifacts[0].content);
    assert.equal(hashContent(bytes), evidence.artifacts[0].sha256);
    assert.equal(evidence.checkEvidence.captureId, evidence.capture.captureId);
  }
});

test('incomplete slots persist as failures without artifacts or manufactured successful captures', async t => {
  const options = fixture(t);
  const client = injectedClient(t, (receipt, payload, count) => {
    if (count === 1) throw new Error('Recorded infrastructure failure');
    return receipt;
  });
  const matrix = await executeOfflineCaseMatrix(options, client);
  const persisted = persistOfflineCaseMatrix(matrix);
  t.after(() => destroyWorkspace(persisted.workspace));
  assert.equal(persisted.manifest.diagnosticsPassed, false);
  assert.equal(persisted.manifest.failureCount, 1);
  const reference = persisted.manifest.executions[0];
  assert.equal(reference.failure.class, 'infrastructure');
  assert.match(reference.failure.message, /Recorded infrastructure failure/);
  assert.equal(reference.error.message, 'Recorded infrastructure failure');
  const evidence = readJson(path.join(persisted.workspace.directory, reference.evidenceFile));
  assert.equal(evidence.executionId, null);
  assert.equal(evidence.capture, null);
  assert.deepEqual(evidence.artifacts, []);
  assert.match(evidence.failures[0].message, /Recorded infrastructure failure/);
});

test('persistence rejects substituted captures and live-shaped reports before retaining evidence', async t => {
  const options = fixture(t);
  const client = injectedClient(t);
  const matrix = await executeOfflineCaseMatrix(options, client);
  assert.throws(() => persistOfflineCaseMatrix({
    ...matrix, report: { ...matrix.report, liveAccepted: true }
  }), /offline diagnostic/);
  assert.throws(() => persistOfflineCaseMatrix({ ...matrix, captures: [] }), /original trusted capture/);
});

test('run-offline CLI requires explicit offline profiles, exports and public scenarios before native dispatch', t => {
  const options = fixture(t);
  const directory = path.dirname(options.suiteFile);
  const filename = path.join(directory, 'profile.json');
  const scenarios = path.join(directory, 'scenarios.json');
  fs.writeFileSync(filename, JSON.stringify(options.profile));
  fs.writeFileSync(scenarios, JSON.stringify([]));
  const cli = fileURLToPath(new URL('../harness/cli.mjs', import.meta.url));
  const args = ['run-offline', '--suite', options.suiteFile, '--profile', filename,
    '--skill-path', options.skillPath, '--candidate-export', options.candidateExport,
    '--baseline-export', options.baselineExport, '--mock-scenarios', scenarios,
    '--cases', 'explicit', '--clients', 'copilot'];
  const missing = spawnSync(process.execPath, [cli, 'run-offline'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--suite is required/);
  const invalid = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /one explicit mock scenario/);
  options.profile.auth = 'native-client-auth';
  fs.writeFileSync(filename, JSON.stringify(options.profile));
  const live = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(live.status, 1);
  assert.match(live.stderr, /auth none-offline/);
  const unrelated = spawnSync(process.execPath, [cli, ...args, '--timeout-seconds', '180'], { encoding: 'utf8' });
  assert.equal(unrelated.status, 1);
  assert.match(unrelated.stderr, /not valid for run-offline/);
});

for (const matrix of [
  { name: 'actual native case matrix', flag: 'EVAL_NATIVE_CASE_MATRIX', clients: ['claude-code', 'opencode', 'copilot'] },
  { name: 'actual Claude native case matrix', flag: 'EVAL_NATIVE_CLAUDE_CASE_MATRIX', clients: ['claude-code'] }
]) test(`${matrix.name} persists three fresh repeats per arm and client through the CLI`, {
  skip: process.env[matrix.flag] !== '1'
}, t => {
  const options = fixture(t);
  options.selection.clients = matrix.clients;
  const expectedCount = matrix.clients.length * 6;
  options.profile.limits.seconds = 180;
  const directory = path.dirname(options.suiteFile);
  const profile = path.join(directory, 'profile.json');
  const scenarios = path.join(directory, 'scenarios.json');
  fs.writeFileSync(profile, JSON.stringify(options.profile));
  fs.writeFileSync(scenarios, JSON.stringify(options.mockScenarios));
  const cli = fileURLToPath(new URL('../harness/cli.mjs', import.meta.url));
  const output = spawnSync(process.execPath, [cli, 'run-offline',
    '--suite', options.suiteFile, '--profile', profile, '--skill-path', options.skillPath,
    '--candidate-export', options.candidateExport, '--baseline-export', options.baselineExport,
    '--mock-scenarios', scenarios, '--cases', 'explicit', '--clients', options.selection.clients.join(',')
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  let manifest;
  let verified = false;
  if (output.stdout.trim()) {
    manifest = JSON.parse(output.stdout);
    t.after(() => {
      if (!verified) {
        t.diagnostic(`Retained native matrix ${manifest.invocationId}: ${manifest.evidence.reportFile}`);
        return;
      }
      const evidence = manifest.evidence.directory;
      const marker = readJson(path.join(evidence, '.owner.json'));
      assert.equal(path.dirname(evidence), workRoot);
      assert.equal(fs.realpathSync(evidence), evidence);
      assert.equal(path.basename(evidence), `isolation-${marker.id}`);
      assert.equal(marker.task.invocationId, manifest.invocationId);
      fs.rmSync(evidence, { recursive: true, force: true });
    });
  }
  assert.equal(output.status, 0, output.stderr || output.stdout);
  assert.equal(manifest.evidenceSource, 'actual-native-offline-task-callbacks');
  assert.equal(manifest.plannedTaskCount, expectedCount);
  assert.equal(manifest.attemptedTaskCount, expectedCount);
  assert.equal(manifest.completedTaskCount, expectedCount);
  assert.equal(manifest.diagnosticsPassed, true);
  assert.equal(manifest.contractMatrixComplete, false);
  assert.equal(manifest.authenticationVerified, false);
  assert.equal(manifest.liveAccepted, false);
  assert.equal(manifest.baselineApproved, false);
  assert.equal(new Set(manifest.executions.map(execution => execution.executionId)).size, expectedCount);
  const { evidence: locations, ...stored } = manifest;
  assert.deepEqual(readJson(locations.reportFile), stored);
  for (const client of options.selection.clients) for (const arm of ['candidate', 'baseline']) {
    const references = manifest.executions.filter(execution => execution.task.client === client && execution.task.arm === arm);
    assert.deepEqual(references.map(execution => execution.task.repeat), [1, 2, 3]);
    for (const reference of references) {
      const evidence = readJson(path.join(manifest.evidence.directory, reference.evidenceFile));
      assert.equal(evidence.native.client, client);
      assert.equal(evidence.native.clientVersion, CLIENT_VERSIONS[client]);
      const prompt = readJson(options.suiteFile).cases[0].prompt;
      assert.equal(evidence.native.promptHash, hashContent(prompt));
      if (client === 'opencode') {
        assert.equal(evidence.native.promptEnvelope, 'opencode-1.14.28-stdin-newline');
        assert.equal(evidence.native.wireMessageHash, hashContent(`\n${prompt}`));
      }
      assert.equal(evidence.discovery.status, 'passed');
      assert.ok(evidence.checks.every(check => check.status === 'passed'));
      assert.ok(Number.isFinite(evidence.usage.elapsedMs.value) && evidence.usage.elapsedMs.value >= 0);
      assert.notEqual(evidence.usage.elapsedMs.provenance, 'unavailable');
      for (const metric of ['inputTokens', 'outputTokens', 'usd', 'credits']) {
        assert.deepEqual(evidence.usage[metric], { value: null, provenance: 'unavailable' });
      }
      const bytes = Buffer.from(evidence.artifacts[0].base64, 'base64');
      assert.equal(bytes.toString(), options.mockScenarios[0].artifacts[0].content);
      assert.equal(hashContent(bytes), evidence.artifacts[0].sha256);
    }
  }
  verified = true;
});
