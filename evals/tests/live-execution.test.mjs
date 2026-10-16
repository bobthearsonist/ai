import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hashContent, hashObject, readJson } from '../harness/index.mjs';
import {
  authorizeLiveEvaluation, describeLiveEvaluation, prepareLiveEvaluation, readLiveTaskRequest, releaseLiveEvaluation
} from '../harness/live-execution.mjs';
import { nativeMatrixFixture } from './helpers.mjs';

function fixture(t, options) {
  const { mockScenarios, ...source } = nativeMatrixFixture(t, options);
  source.profile.auth = 'native-client-auth';
  for (const [client, pin] of Object.entries(source.profile.clients)) {
    pin.model = 'native-default';
    pin.endpoint = {
      'claude-code': 'https://api.anthropic.com',
      copilot: 'https://api.githubcopilot.com',
      opencode: 'https://api.githubcopilot.com'
    }[client];
    pin.settings = {};
  }
  return source;
}

function baselineFor(options) {
  const snapshot = readJson(path.join(options.baselineExport, 'snapshot.json'));
  return {
    contractVersion: 2, snapshotId: snapshot.snapshotId, profileHash: hashObject(options.profile),
    provenance: { kind: 'bootstrap', reference: 'Explicit synthetic test baseline, not a release' },
    approval: { approved: true, by: 'test-human', at: '2026-10-07T12:00:00Z', snapshotId: snapshot.snapshotId }
  };
}

function prepare(t, options) {
  const prepared = prepareLiveEvaluation(options);
  t.after(() => releaseLiveEvaluation(prepared.handle));
  return prepared;
}

function authorizationFor(report) {
  return {
    contractVersion: 2, kind: 'native-account-consumption-authorization',
    target: structuredClone(report.authorizationTarget),
    approval: {
      approved: true, by: 'test-human',
      at: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    },
    consumption: Object.fromEntries(report.selection.clients.map(client => [client, {
      account: `test-${client}`, unit: 'provider-requests', maximum: 100,
      sessions: report.taskSessionCount / report.selection.clients.length
    }]))
  };
}

test('live preparation binds exact fresh coordinates and source identities without granting execution authority', t => {
  const options = fixture(t);
  options.selection.clients = ['claude-code', 'opencode', 'copilot'];
  const { handle, report } = prepare(t, options);
  assert.equal(report.taskSessionCount, 18);
  assert.equal(report.executed, false);
  for (const field of [
    'authenticationVerified', 'credentialToolBoundaryVerified', 'serviceEgressVerified',
    'limitsVerified', 'accountConsumptionAuthorized', 'liveAccepted', 'baselineApproved'
  ]) assert.equal(report[field], false);
  assert.equal(report.profileHash, hashObject(options.profile));
  assert.equal(report.authorizationTarget.planHash, report.planHash);
  assert.equal(report.authorizationTarget.taskSessionCount, 18);
  for (const client of options.selection.clients) for (const arm of ['candidate', 'baseline']) {
    const tasks = Array.from({ length: 18 }, (_, index) => readLiveTaskRequest(handle, index))
      .filter(request => request.task.client === client && request.task.arm === arm);
    assert.deepEqual(tasks.map(request => request.task.repeat), [1, 2, 3]);
    assert.ok(tasks.every(request => request.task.invocationId === report.invocationId));
    assert.ok(tasks.every(request => !Object.hasOwn(request, 'mock')));
  }
});

test('private dependencies remain hash-bound and never enter source mounts or public approval descriptions', t => {
  const options = fixture(t, { privateContext: true });
  const prepared = prepare(t, options);
  const request = readLiveTaskRequest(prepared.handle, 0);
  assert.equal(request.inputs.some(input => input.path === 'private.txt'), false);
  assert.equal(JSON.stringify(prepared.report).includes('PRIVATE-GRADER-DATA'), false);
  fs.writeFileSync(path.join(path.dirname(options.suiteFile), 'private.txt'), 'Changed private grading data');
  const changed = prepare(t, { ...options, invocationId: prepared.report.invocationId });
  assert.notEqual(changed.report.planHash, prepared.report.planHash);
  assert.notEqual(readLiveTaskRequest(changed.handle, 0).task.fixtureHash, request.task.fixtureHash);
});

test('per-client native image pins change exact source approvals and are not inferred from a shared base image', t => {
  const options = fixture(t);
  const original = prepare(t, options);
  const pinned = structuredClone(options);
  pinned.profile.clients.copilot.runtimeImage = {
    kind: 'local-oci', manifestDigest: `sha256:${'a'.repeat(64)}`, configDigest: `sha256:${'b'.repeat(64)}`
  };
  pinned.invocationId = original.report.invocationId;
  const changed = prepare(t, pinned);
  assert.notEqual(changed.report.planHash, original.report.planHash);
  assert.notEqual(changed.report.profileHash, original.report.profileHash);
  assert.deepEqual(changed.report.requestedRoutes.copilot.runtimeImage, pinned.profile.clients.copilot.runtimeImage);
  assert.equal(changed.report.liveAccepted, false);
  assert.throws(() => authorizeLiveEvaluation(changed.handle, authorizationFor(original.report)),
    error => error.code === 'LIVE_AUTHORIZATION_BINDING_MISMATCH');
  pinned.baseline = baselineFor(options);
  assert.throws(() => prepareLiveEvaluation(pinned), error => error.code === 'BASELINE_BINDING_MISMATCH');
});

test('live plans preserve exact source bytes and defend internal state from caller mutations', t => {
  const options = fixture(t);
  const original = fs.readFileSync(path.join(path.dirname(options.suiteFile), 'guide.txt'));
  assert.ok(original.includes(Buffer.from('\r\n')));
  const prepared = prepare(t, options);
  const request = readLiveTaskRequest(prepared.handle, 0);
  assert.deepEqual(request.inputs[0].content, original);
  request.inputs[0].content.fill(0);
  request.skill.files[0].content.fill(0);
  request.checks[0].expected = false;
  prepared.report.authorizationTarget.profileHash = 'b'.repeat(64);
  options.profile.clients.copilot.model = 'caller-mutated-model';
  assert.deepEqual(readLiveTaskRequest(prepared.handle, 0).inputs[0].content, original);
  assert.equal(readLiveTaskRequest(prepared.handle, 0).checks[0].expected, true);
  assert.equal(describeLiveEvaluation(prepared.handle).profileHash, prepared.report.profileHash);
  assert.equal(describeLiveEvaluation(prepared.handle).requestedRoutes.copilot.model, 'native-default');
  assert.notEqual(hashContent(readLiveTaskRequest(prepared.handle, 0).skill.files[0].content), hashContent(request.skill.files[0].content));
});

test('optional no-skill tasks retain context but receive no target bytes or scripted answers', t => {
  const options = fixture(t);
  options.selection.arms = ['candidate', 'baseline', 'no-skill'];
  const { handle, report } = prepare(t, options);
  assert.equal(report.taskSessionCount, 9);
  const controls = Array.from({ length: 9 }, (_, index) => readLiveTaskRequest(handle, index))
    .filter(request => request.task.arm === 'no-skill');
  assert.equal(controls.length, 3);
  assert.ok(controls.every(request => request.skill.files.length === 0 && request.inputs.length > 0));
  assert.ok(controls.every(request => !Object.hasOwn(request, 'mock')));
});

test('only explicit exact bootstrap baseline approval can satisfy the preparation binding', t => {
  const options = fixture(t);
  options.baseline = baselineFor(options);
  const { report } = prepare(t, options);
  assert.equal(report.baselineApproved, true);
  assert.equal(report.liveAccepted, false);
  assert.equal(report.accountConsumptionAuthorized, false);
  assert.ok(!report.blockers.some(blocker => /bootstrap baseline/.test(blocker)));
  for (const mutate of [
    baseline => { baseline.snapshotId = 'b'.repeat(64); },
    baseline => { baseline.approval.snapshotId = 'b'.repeat(64); },
    baseline => { baseline.profileHash = 'b'.repeat(64); },
    baseline => { baseline.approval.approved = false; },
    baseline => { baseline.provenance.kind = 'released'; }
  ]) {
    const changed = structuredClone(options.baseline);
    mutate(changed);
    assert.throws(() => prepareLiveEvaluation({ ...options, baseline: changed }));
  }
});

test('mock fixtures, native auth booleans, credentials and unknown control inputs are rejected before execution', t => {
  const options = fixture(t);
  for (const field of ['mockScenarios', 'authenticated', 'credentialFile', 'boundaryVerified', 'authorization']) {
    assert.throws(() => prepareLiveEvaluation({ ...options, [field]: true }), /explicit source options/);
  }
  assert.throws(() => prepareLiveEvaluation({ ...options, selection: { ...options.selection, retries: 1 } }), /selectors/);
  for (const mutate of [
    profile => { profile.auth = 'none-offline'; },
    profile => { profile.runner = 'agent-skill-eval'; },
    profile => { profile.clients.copilot.version = 'unverified-version'; },
    profile => { profile.image = 'node:latest'; },
    profile => { profile.clients.copilot.settings = { env: { GITHUB_TOKEN: 'DO-NOT-ECHO-SECRET' } }; },
    profile => { profile.limits.seconds = 301; },
    profile => { profile.limits.turns = 129; },
    profile => { profile.limits.tokens = 1_000_001; },
    profile => { profile.limits.concurrency = 5; }
  ]) {
    const profile = structuredClone(options.profile);
    mutate(profile);
    assert.throws(() => prepareLiveEvaluation({ ...options, profile }), error => {
      assert.equal(error.message.includes('DO-NOT-ECHO-SECRET'), false);
      return true;
    });
  }
});

test('unsupported trace and manual graders fail preparation before any native or account execution', t => {
  const options = fixture(t);
  const suite = readJson(options.suiteFile);
  const selected = suite.cases.find(item => item.id === 'explicit');
  for (const type of ['trace-event', 'manual-evidence']) {
    selected.hardChecks = [{ id: 'unsupported', class: 'safety', type, target: 'native-events', expected: true }];
    fs.writeFileSync(options.suiteFile, JSON.stringify(suite));
    assert.throws(() => prepareLiveEvaluation(options), error => {
      assert.equal(error.code, 'UNSUPPORTED_LIVE_CHECK');
      assert.match(error.message, /adapters are not installed/);
      return true;
    });
  }
});

test('native origins reject credentials, paths, local/IP destinations, non-HTTPS and malformed identifiers', t => {
  const options = fixture(t);
  for (const endpoint of [
    'not-a-url', 'http://api.githubcopilot.com', 'https://127.0.0.1', 'https://[::1]',
    'https://localhost', 'https://service.internal', 'https://service.invalid',
    'https://user:DO-NOT-ECHO-SECRET@api.githubcopilot.com', 'https://api.githubcopilot.com:8443',
    'https://api.githubcopilot.com/v1', 'https://api.githubcopilot.com/?key=DO-NOT-ECHO-SECRET'
  ]) {
    const profile = structuredClone(options.profile);
    profile.clients.copilot.endpoint = endpoint;
    assert.throws(() => prepareLiveEvaluation({ ...options, profile }), error => {
      assert.equal(error.code, 'INVALID_NATIVE_ENDPOINT');
      assert.equal(error.message.includes('DO-NOT-ECHO-SECRET'), false);
      return true;
    });
  }
  options.profile.clients.copilot.model = '--unreviewed-native-option';
  assert.throws(() => prepareLiveEvaluation(options), /native model identifier/);
});

test('source changes and reused or forged preparation handles cannot authorize another task', t => {
  const options = fixture(t);
  const prepared = prepareLiveEvaluation(options);
  assert.ok(Object.isFrozen(prepared.handle));
  assert.throws(() => readLiveTaskRequest(structuredClone(prepared.handle), 0), /Unknown or released/);
  for (const index of [-1, 0.5, prepared.report.taskSessionCount]) {
    assert.throws(() => readLiveTaskRequest(prepared.handle, index), /planned native task index/);
  }
  fs.appendFileSync(path.join(options.candidateExport, 'skills', 'example-skill', 'SKILL.md'), 'Changed source');
  assert.throws(() => prepareLiveEvaluation(options), /Snapshot file mismatch/);
  releaseLiveEvaluation(prepared.handle);
  assert.throws(() => describeLiveEvaluation(prepared.handle), /Unknown or released/);
  assert.throws(() => releaseLiveEvaluation(prepared.handle), /Unknown or released/);
});

test('an exact human account record binds ceilings but cannot grant runtime, authentication or live authority', t => {
  const { handle, report } = prepare(t, fixture(t));
  const record = authorizationFor(report);
  const bound = authorizeLiveEvaluation(handle, record);
  assert.equal(bound.accountConsumptionAuthorized, true);
  assert.equal(bound.accountAuthorization.consumptionEnforcementVerified, false);
  for (const field of [
    'executed', 'authenticationVerified', 'credentialToolBoundaryVerified',
    'serviceEgressVerified', 'limitsVerified', 'liveAccepted', 'baselineApproved'
  ]) assert.equal(bound[field], false);
  assert.ok(!bound.blockers.some(blocker => /Explicit authorization/.test(blocker)));
  assert.ok(bound.blockers.some(blocker => /native turn\/token/.test(blocker)));
  record.consumption.copilot.maximum = 9000;
  record.target.planHash = 'b'.repeat(64);
  bound.accountAuthorization.consumption.copilot.maximum = 8000;
  assert.equal(describeLiveEvaluation(handle).accountAuthorization.consumption.copilot.maximum, 100);
  assert.throws(() => authorizeLiveEvaluation(handle, authorizationFor(report)), /already has/);
});

test('account authorization rejects altered plan, route, limits, source and session bindings', t => {
  const { handle, report } = prepare(t, fixture(t));
  for (const change of [
    record => { record.target.planHash = 'b'.repeat(64); },
    record => { record.target.invocationId = 'another-invocation'; },
    record => { record.target.snapshotIds.baseline = 'b'.repeat(64); },
    record => { record.target.requestedLimits.tokens++; },
    record => { record.target.requestedRoutes.copilot.model = 'different-model'; },
    record => { record.target.selection.cases = ['negative']; },
    record => { record.consumption.copilot.sessions++; }
  ]) {
    const record = authorizationFor(report);
    change(record);
    assert.throws(() => authorizeLiveEvaluation(handle, record));
    assert.equal(describeLiveEvaluation(handle).accountConsumptionAuthorized, false);
  }
});

test('account approvals require complete finite native units without secret or unknown fields', t => {
  const { handle, report } = prepare(t, fixture(t));
  for (const change of [
    record => { record.approval.approved = false; },
    record => { record.approval.by = ' '; },
    record => { record.consumption.copilot.maximum = 0; },
    record => { record.consumption.copilot.maximum = Infinity; },
    record => { record.consumption.copilot.maximum = 0.5; },
    record => { record.consumption.copilot.unit = 'invented-credits'; },
    record => { record.consumption.copilot.account = '******private-service'; },
    record => { record.consumption.copilot.token = 'DO-NOT-ECHO-SECRET'; },
    record => { record.consumption.opencode = { ...record.consumption.copilot }; },
    record => { record.credentials = 'DO-NOT-ECHO-SECRET'; }
  ]) {
    const record = authorizationFor(report);
    change(record);
    assert.throws(() => authorizeLiveEvaluation(handle, record), error => {
      assert.equal(error.message.includes('DO-NOT-ECHO-SECRET'), false);
      return true;
    });
  }
  const usd = authorizationFor(report);
  usd.consumption.copilot.unit = 'usd';
  usd.consumption.copilot.maximum = 0.5;
  assert.equal(authorizeLiveEvaluation(handle, usd).accountConsumptionAuthorized, true);
});

test('account approval expiry is enforced on every description and rejects invalid or future dates', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-08T17:00:00Z') });
  const { handle, report } = prepare(t, fixture(t));
  for (const change of [
    record => { record.approval.at = '2026-02-31T17:00:00Z'; },
    record => { record.approval.at = '2026-10-08T17:00:01Z'; },
    record => { record.approval.expiresAt = '2026-10-08T17:00:00Z'; },
    record => { record.approval.expiresAt = '2026-10-10T17:00:00Z'; },
    record => { record.approval.at = '2026-10-08T13:00:00-04:00'; }
  ]) {
    const record = authorizationFor(report);
    change(record);
    assert.throws(() => authorizeLiveEvaluation(handle, record));
  }
  assert.equal(authorizeLiveEvaluation(handle, authorizationFor(report)).accountConsumptionAuthorized, true);
  t.mock.timers.tick(60_000);
  const expired = describeLiveEvaluation(handle);
  assert.equal(expired.accountConsumptionAuthorized, false);
  assert.equal(expired.accountAuthorization.expired, true);
  assert.ok(expired.blockers.some(blocker => /has expired/.test(blocker)));
  assert.equal(expired.liveAccepted, false);
});

test('copied or released preparations cannot receive an account approval', t => {
  const { handle, report } = prepareLiveEvaluation(fixture(t));
  const record = authorizationFor(report);
  assert.throws(() => authorizeLiveEvaluation(structuredClone(handle), record), /Unknown or released/);
  releaseLiveEvaluation(handle);
  assert.throws(() => authorizeLiveEvaluation(handle, record), /Unknown or released/);
});

test('prepare-live CLI emits exact approval bindings, never authentication or live acceptance', t => {
  const options = fixture(t);
  const profileFile = path.join(path.dirname(options.suiteFile), 'native-profile.json');
  fs.writeFileSync(profileFile, JSON.stringify(options.profile));
  const cli = fileURLToPath(new URL('../harness/cli.mjs', import.meta.url));
  const invocationId = 'explicit-cli-preparation';
  const args = ['prepare-live', '--suite', options.suiteFile, '--profile', profileFile,
    '--skill-path', options.skillPath, '--candidate-export', options.candidateExport,
    '--baseline-export', options.baselineExport, '--cases', 'explicit', '--clients', 'copilot',
    '--invocation-id', invocationId];
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const expected = prepare(t, { ...options, invocationId }).report;
  assert.deepEqual(report, expected);
  assert.equal(report.executed, false);
  assert.equal(report.authenticationVerified, false);
  assert.equal(report.liveAccepted, false);
  const invalid = spawnSync(process.execPath, [cli, ...args, '--mock-scenarios', profileFile], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /not valid for prepare-live/);
  const baselineFile = path.join(path.dirname(options.suiteFile), 'baseline.json');
  fs.writeFileSync(baselineFile, JSON.stringify(baselineFor(options)));
  const approved = spawnSync(process.execPath, [cli, ...args, '--baseline', baselineFile], { encoding: 'utf8' });
  assert.equal(approved.status, 0, approved.stderr);
  const bound = JSON.parse(approved.stdout);
  assert.equal(bound.baselineApproved, true);
  assert.equal(bound.liveAccepted, false);
  assert.equal(bound.accountConsumptionAuthorized, false);
  const authorizationFile = path.join(path.dirname(options.suiteFile), 'authorization.json');
  fs.writeFileSync(authorizationFile, JSON.stringify(authorizationFor(expected)));
  const authorized = spawnSync(process.execPath, [cli, ...args, '--authorization', authorizationFile], { encoding: 'utf8' });
  assert.equal(authorized.status, 0, authorized.stderr);
  const declared = JSON.parse(authorized.stdout);
  assert.equal(declared.accountConsumptionAuthorized, true);
  assert.equal(declared.accountAuthorization.consumptionEnforcementVerified, false);
  assert.equal(declared.authenticationVerified, false);
  assert.equal(declared.limitsVerified, false);
  assert.equal(declared.liveAccepted, false);
});
