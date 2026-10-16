import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTRACT_VERSION, POLICY, evaluateResults, hashObject, normalizeRun, planRuns, runEvaluation, validateDocument, validateSnapshot
} from '../harness/index.mjs';
import { loaded, makeResults, profile } from './helpers.mjs';

test('three fresh deterministic repeats satisfy compatible approved baseline', () => {
  const report = evaluateResults(loaded, makeResults());
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.exitCode, 0);
  assert.equal(report.contractVersion, 2);
  assert.deepEqual(report.policy, { repeats: 3 });
  assert.equal(report.groups[0].comparison.status, 'non-regressed');
  assert.equal(report.groups[0].arms.candidate.repeats.length, 3);
  assert.deepEqual(report.groups[0].arms.candidate.counts, {
    executions: { completed: 3, incomplete: 0, missing: 0 },
    discovery: { passed: 3, failed: 0, missing: 0 },
    checks: { passed: 3, failed: 0, error: 0, skipped: 0, missing: 0 }
  });
  assert.equal(Object.hasOwn(report.groups[0], 'means'), false);
  assert.deepEqual(loaded.caseContracts.explicit, { fixtureHash: loaded.caseContracts.explicit.fixtureHash });
});

test('deterministic reports do not replace missing usage with zero', () => {
  const results = makeResults();
  results.runs[0].checks[0].status = 'failed';
  const report = evaluateResults(loaded, results);
  assert.equal(report.passed, false);
  assert.equal(report.exitCode, 1);
  assert.equal(report.groups[0].arms.candidate.counts.checks.failed, 1);
  assert.deepEqual(report.groups[0].comparison.checks[0].regressedRepeats, [1]);
  const normalized = normalizeRun(results.runs[0]);
  assert.equal(normalized.usage.usd.value, null);
  assert.equal(normalized.usage.credits.value, 0.5);
});

test('all three clients and explicit/implicit/negative cases are separate gate groups', () => {
  const results = makeResults({ selection: {} });
  const report = evaluateResults(loaded, results);
  assert.equal(results.runs.length, 54);
  assert.equal(report.groups.length, 9);
  assert.equal(report.passed, true, JSON.stringify(report));
});

test('no-skill diagnostic does not require positive triggering', () => {
  const results = makeResults({ selection: { cases: ['explicit'], clients: ['copilot'], arms: ['candidate', 'baseline', 'no-skill'] } });
  results.runs.filter(run => run.arm === 'no-skill').forEach(run => { run.trigger = { loaded: false, evidence: [] }; });
  assert.equal(evaluateResults(loaded, results).passed, true);
});

test('no-skill control cannot contain target-skill loading', () => {
  const results = makeResults({ selection: { cases: ['explicit'], clients: ['copilot'], arms: ['candidate', 'baseline', 'no-skill'] } });
  results.runs.find(run => run.arm === 'no-skill').trigger.loaded = true;
  assert.equal(evaluateResults(loaded, results).passed, false);
});

const mutations = {
  'correctness failure': [results => { results.runs[0].checks[0].status = 'failed'; }, 'correctness'],
  'safety failure': [results => {
    results.selection.cases = ['implicit'];
    for (const run of results.runs) {
      run.caseId = 'implicit';
      Object.assign(run, loaded.caseContracts.implicit);
      run.checks = [{ id: 'safe-plan', class: 'safety', status: run.arm === 'candidate' ? 'failed' : 'passed', evidence: 'check.json' }];
    }
  }, 'safety'],
  'discovery failure': [results => { results.runs[0].trigger.loaded = false; }, 'discovery'],
  'self-reported trigger without trace': [results => { results.runs[0].trigger.evidence = []; }, 'discovery'],
  'wrong skill evidence': [results => { results.runs[0].trigger.evidence[0].skill = 'wrong-skill'; }, 'discovery'],
  'regression failure': [results => { results.runs[0].checks[0].status = 'failed'; }, 'regression'],
  'execution error with useful checks': [results => { results.runs[0].status = 'error'; results.runs[0].error = 'auth unavailable'; }, 'infrastructure'],
  'timeout': [results => { results.runs[0].status = 'timeout'; }, 'infrastructure'],
  'cancelled': [results => { results.runs[0].status = 'cancelled'; }, 'infrastructure'],
  'skipped execution': [results => { results.runs[0].status = 'skipped'; }, 'infrastructure'],
  'missing repeat': [results => { results.runs.pop(); }, 'infrastructure'],
  'duplicate repeat': [results => { results.runs.push(structuredClone(results.runs[0])); }, 'infrastructure'],
  'duplicate execution ID': [results => { results.runs[1].runId = results.runs[0].runId; }, 'infrastructure'],
  'cached result': [results => { results.runs[0].fresh = false; }, 'infrastructure'],
  'stale invocation': [results => { results.runs[0].invocationId = 'prior-invocation'; }, 'infrastructure'],
  'v1 scored result schema': [results => { results.contractVersion = 1; }, 'infrastructure'],
  'unknown required result schema': [results => { results.contractVersion = 3; }, 'infrastructure'],
  'unknown required check': [results => { results.runs[0].checks[0].id = 'unknown'; }, 'infrastructure'],
  'missing hard check': [results => { results.runs[0].checks = []; }, 'infrastructure'],
  'duplicate hard check': [results => { results.runs[0].checks.push(structuredClone(results.runs[0].checks[0])); }, 'infrastructure'],
  'misclassified check': [results => { results.runs[0].checks[0].class = 'safety'; }, 'infrastructure'],
  'skipped required check': [results => { results.runs[0].checks[0].status = 'skipped'; }, 'infrastructure'],
  'early exit profile': [results => { results.profile.earlyExit = true; }, 'infrastructure'],
  'cache profile': [results => { results.profile.cache = true; }, 'infrastructure'],
  'unknown client': [results => { results.selection.clients = ['unsupported']; }, 'infrastructure'],
  'empty selected cases': [results => { results.selection.cases = []; }, 'infrastructure'],
  'empty selected clients': [results => { results.selection.clients = []; }, 'infrastructure'],
  'missing baseline arm': [results => { results.selection.arms = ['candidate', 'no-skill']; }, 'infrastructure'],
  'invalid snapshot hash': [results => { results.snapshots.candidate.files[0].sha256 = 'b'.repeat(64); }, 'infrastructure'],
  'unapproved baseline': [results => { results.baseline.approval.approved = false; }, 'infrastructure'],
  'wrong approval snapshot': [results => { results.baseline.approval.snapshotId = 'b'.repeat(64); }, 'regression'],
  'wrong baseline snapshot': [results => { results.baseline.snapshotId = 'b'.repeat(64); }, 'regression'],
  'wrong approved profile': [results => { results.baseline.profileHash = 'b'.repeat(64); }, 'regression'],
  'wrong fixture': [results => { results.runs[0].fixtureHash = 'b'.repeat(64); }, 'infrastructure'],
  'obsolete rubric hash': [results => { results.runs[0].rubricHash = 'b'.repeat(64); }, 'infrastructure'],
  'wrong runtime': [results => { results.runs[0].runtime.clientVersion = 'drifted'; }, 'infrastructure'],
  'wrong auth route': [results => { results.runs[0].runtime.auth = 'unapproved-route'; }, 'infrastructure'],
  'wrong image': [results => { results.runs[0].runtime.image = 'unpinned-image'; }, 'infrastructure'],
  'wrong requested model': [results => { results.runs[0].model.requested = 'other-model'; }, 'infrastructure'],
  'unknown observed model': [results => { results.runs[0].model.observed = null; }, 'infrastructure'],
  'blank observed model': [results => { results.runs[0].model.observed = ' '; }, 'infrastructure'],
  'different observed model': [results => { results.runs[0].model.observed = 'other-model'; }, 'regression'],
  'missing usage provenance': [results => { results.runs[0].usage.usd.provenance = 'client-reported'; }, 'infrastructure']
};
for (const [name, [mutate, failureClass]] of Object.entries(mutations)) test(name, () => {
  const results = makeResults();
  mutate(results);
  const report = evaluateResults(loaded, results);
  assert.equal(report.passed, false, name);
  assert.equal(report.exitCode, 1, name);
  assert.ok(report.failures.some(failure => failure.class === failureClass), JSON.stringify(report));
});

test('uniformly unknown observed models are diagnostic data, not a compatible comparison', () => {
  const results = makeResults();
  for (const run of results.runs) run.model.observed = null;
  assert.equal(normalizeRun(results.runs[0]).model.observed, null);
  const report = evaluateResults(loaded, results);
  assert.equal(report.passed, false);
  assert.equal(report.groups[0].comparison.status, 'incompatible');
  assert.equal(report.failures.filter(failure => /Missing observed native model/.test(failure.message)).length, 6);
});

test('two invocations reject reused execution IDs and accept fresh IDs', () => {
  const first = makeResults();
  const previousRunIds = first.runs.map(run => run.runId);
  const repeated = evaluateResults(loaded, first, { previousRunIds });
  assert.equal(repeated.passed, false);
  const fresh = makeResults({ invocationId: 'fresh-invocation' });
  assert.equal(evaluateResults(loaded, fresh, { previousRunIds }).passed, true);
});

test('negative cases reject contradictory actual skill load evidence', () => {
  const results = makeResults({ selection: { cases: ['negative'], clients: ['copilot'] } });
  results.runs[0].trigger.evidence.push({ kind: 'skill-load', skill: loaded.suite.skill, ref: 'trace#load' });
  assert.equal(evaluateResults(loaded, results).passed, false);
});

test('released and bootstrap provenance are distinct and approval is required for both', () => {
  const results = makeResults();
  results.baseline.provenance = { kind: 'released', reference: 'verified release artifact test-only' };
  assert.equal(evaluateResults(loaded, results).passed, true);
  delete results.baseline.approval;
  assert.equal(evaluateResults(loaded, results).passed, false);
});

test('dry-run enumerates required sessions without executing', () => {
  const plan = planRuns(loaded, profile);
  assert.equal(plan.taskSessionCount, 54);
  assert.deepEqual(Object.keys(plan.tasks[0]).sort(), ['arm', 'caseId', 'client', 'fixtureHash', 'repeat']);
  assert.throws(() => planRuns(loaded, profile, { cases: [] }), /Empty/);
  assert.throws(() => planRuns(loaded, profile, { cases: ['unknown'] }), /Unknown/);
  assert.throws(() => planRuns(loaded, profile, { clients: ['copilot', 'copilot'] }), /Duplicate/);
  assert.throws(() => runEvaluation(), /No real execution adapter/);
});

test('canonical object hashes are insensitive to property order', () => {
  assert.equal(hashObject({ a: 1, b: 2 }), hashObject({ b: 2, a: 1 }));
});

test('suite schema rejects empty cases, unknown checks, old rubrics and clients', () => {
  for (const mutate of [
    suite => { suite.cases = []; },
    suite => { suite.cases[0].hardChecks[0].type = 'infer-from-prose'; },
    suite => { suite.cases[0].rubric = true; },
    suite => { suite.clients = ['github-copilot']; }
  ]) {
    const suite = structuredClone(loaded.suite);
    mutate(suite);
    assert.throws(() => validateDocument('suite', suite));
  }
  assert.throws(() => validateSnapshot({}));
});

test('version 1 suites, profiles, snapshots and baseline records fail closed', () => {
  const results = makeResults();
  for (const [kind, value] of [
    ['suite', loaded.suite], ['profile', profile], ['snapshot', results.snapshots.candidate], ['baseline', results.baseline]
  ]) {
    assert.throws(() => validateDocument(kind, { ...structuredClone(value), contractVersion: 1 }), /Invalid/);
  }
  assert.equal(CONTRACT_VERSION, 2);
  assert.deepEqual(POLICY, { repeats: 3 });
});

test('native client auth and vendor service pins need no API judge profile', () => {
  assert.equal(Object.hasOwn(profile, 'judge'), false);
  const results = makeResults();
  results.profile.auth = 'normal-native-login';
  for (const client of Object.keys(results.profile.clients)) results.profile.clients[client].endpoint = 'native-vendor-service';
  const profileHash = hashObject(results.profile);
  results.baseline.profileHash = profileHash;
  for (const run of results.runs) {
    run.profileHash = profileHash;
    run.runtime.auth = results.profile.auth;
  }
  assert.equal(evaluateResults(loaded, results).passed, true);
});

test('per-client local OCI pins bind distinct manifest and config identities without replacing legacy profiles', () => {
  const results = makeResults({ selection: { cases: ['explicit'], clients: ['claude-code', 'copilot', 'opencode'] } });
  results.profile.auth = 'native-client-auth';
  for (const [index, client] of ['claude-code', 'copilot', 'opencode'].entries()) {
    results.profile.clients[client].runtimeImage = {
      kind: 'local-oci',
      manifestDigest: `sha256:${String(index * 2 + 1).repeat(64)}`,
      configDigest: `sha256:${String(index * 2 + 2).repeat(64)}`
    };
  }
  const profileHash = hashObject(results.profile);
  results.baseline.profileHash = profileHash;
  for (const run of results.runs) {
    run.profileHash = profileHash;
    run.runtime.auth = results.profile.auth;
    run.runtime.runtimeImage = structuredClone(results.profile.clients[run.client].runtimeImage);
    run.runtime.image = run.runtime.runtimeImage.configDigest;
  }
  assert.equal(evaluateResults(loaded, results).passed, true);
  for (const mutate of [
    run => { delete run.runtime.runtimeImage; },
    run => { run.runtime.image = results.profile.image; },
    run => { run.runtime.runtimeImage.manifestDigest = run.runtime.runtimeImage.configDigest; },
    run => { run.runtime.runtimeImage.configDigest = `sha256:${'f'.repeat(64)}`; },
    run => { run.runtime.runtimeImage = structuredClone(results.profile.clients.opencode.runtimeImage); }
  ]) {
    const changed = structuredClone(results);
    mutate(changed.runs.find(run => run.client === 'copilot' && run.arm === 'baseline'));
    const report = evaluateResults(loaded, changed);
    assert.equal(report.passed, false);
    assert.equal(report.groups.find(group => group.client === 'copilot').comparison.status, 'incompatible');
  }
  const unrequested = makeResults();
  unrequested.runs[0].runtime.runtimeImage = structuredClone(results.profile.clients.copilot.runtimeImage);
  assert.equal(evaluateResults(loaded, unrequested).passed, false);
});

test('native local OCI pin schemas reject missing, malformed, registry and offline assertions', () => {
  const nativeProfile = structuredClone(profile);
  nativeProfile.auth = 'native-client-auth';
  const pin = { kind: 'local-oci', manifestDigest: `sha256:${'a'.repeat(64)}`, configDigest: `sha256:${'b'.repeat(64)}` };
  nativeProfile.clients.copilot.runtimeImage = pin;
  assert.equal(validateDocument('profile', nativeProfile), nativeProfile);
  for (const mutate of [
    value => { delete value.kind; },
    value => { delete value.manifestDigest; },
    value => { value.manifestDigest = `sha256:${'A'.repeat(64)}`; },
    value => { value.configDigest = 'sha256:short'; },
    value => { value.kind = 'registry'; },
    value => { value.registryManifestVerified = true; }
  ]) {
    const changed = structuredClone(nativeProfile);
    mutate(changed.clients.copilot.runtimeImage);
    assert.throws(() => validateDocument('profile', changed), /Invalid profile/);
  }
  const offlineProfile = structuredClone(nativeProfile);
  offlineProfile.auth = 'none-offline';
  assert.throws(() => validateDocument('profile', offlineProfile), /Invalid profile/);
});

test('old score/judge fields and AI grade injection are rejected, never ignored', () => {
  for (const mutate of [
    results => { results.profile.judge = { model: 'ai-judge', endpoint: 'https://judge.invalid', rubricProtocol: 'v1' }; },
    results => { results.runs[0].quality = { status: 'graded', score: 1, method: 'continuous-rubric', judge: 'ai', evidence: 'judge.json' }; },
    results => { results.runs[0].score = 1; },
    results => { results.runs[0].judge = 'ai'; },
    results => { results.runs[0].aiGrade = 'passed'; },
    results => { results.runs[0].checks[0].score = 1; },
    results => { results.runs[0].checks[0].status = 'graded'; },
    results => { results.qualityThreshold = 0.8; },
    results => { results.means = { candidate: 1 }; },
    results => { results.passRate = 1; }
  ]) {
    const results = makeResults();
    mutate(results);
    assert.equal(evaluateResults(loaded, results).passed, false);
  }
  const suite = structuredClone(loaded.suite);
  suite.cases[0].rubric = { id: 'old', version: '1', path: 'rubric.txt' };
  assert.throws(() => validateDocument('suite', suite), /Invalid suite/);
});

test('every candidate repeat independently requires discovery and every correctness/safety check', () => {
  for (const caseId of ['explicit', 'implicit', 'negative']) for (const repeat of [1, 2, 3]) for (const field of ['check', 'discovery']) {
    const results = makeResults({ selection: { cases: [caseId], clients: ['copilot'] } });
    const run = results.runs.find(run => run.arm === 'candidate' && run.repeat === repeat);
    if (field === 'check') run.checks[0].status = 'failed';
    else run.trigger.evidence = [];
    const report = evaluateResults(loaded, results);
    assert.equal(report.passed, false, `${caseId}/${repeat}/${field}`);
    const outcome = report.groups[0].arms.candidate.repeats[repeat - 1];
    assert.equal(field === 'check' ? outcome.checks[0].status : outcome.discovery.status, 'failed');
  }
});

test('baseline failed checks record behavior but never relax candidate requirements', () => {
  const results = makeResults();
  for (const run of results.runs.filter(run => run.arm === 'baseline')) run.checks[0].status = 'failed';
  const report = evaluateResults(loaded, results);
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.groups[0].arms.baseline.counts.checks.failed, 3);
  assert.deepEqual(report.groups[0].comparison.checks[0].baseline, ['failed', 'failed', 'failed']);
  results.runs.find(run => run.arm === 'candidate' && run.repeat === 2).checks[0].status = 'failed';
  assert.equal(evaluateResults(loaded, results).passed, false);
});

test('baseline incomplete checks and executions block each repeat, even with passing candidate', () => {
  for (const repeat of [1, 2, 3]) for (const mutation of ['missing', 'error', 'skipped', 'execution-error', 'execution-skipped']) {
    const results = makeResults();
    const run = results.runs.find(run => run.arm === 'baseline' && run.repeat === repeat);
    if (mutation === 'missing') run.checks = [];
    else if (mutation.startsWith('execution-')) run.status = mutation.slice('execution-'.length);
    else run.checks[0].status = mutation;
    const report = evaluateResults(loaded, results);
    assert.equal(report.passed, false, `${repeat}/${mutation}`);
    assert.equal(report.groups[0].comparison.status, 'incomplete');
  }
});

test('baseline runtime, fixture and snapshot bindings must exactly match', () => {
  for (const mutate of [
    run => { run.profileHash = 'b'.repeat(64); },
    run => { run.fixtureHash = 'b'.repeat(64); },
    run => { run.snapshotId = 'b'.repeat(64); },
    run => { run.runtime.auth = 'other-native-account'; },
    run => { run.runtime.clientVersion = 'other-client'; },
    run => { run.runtime.image = 'other-image'; },
    run => { run.model.requested = 'other-requested-model'; },
    run => { run.model.observed = 'other-observed-model'; }
  ]) {
    const results = makeResults();
    mutate(results.runs.find(run => run.arm === 'baseline'));
    const report = evaluateResults(loaded, results);
    assert.equal(report.passed, false);
    assert.equal(report.groups[0].comparison.status, 'incompatible');
  }
});

test('no-skill diagnostic is never an approved baseline and rejects contamination on every repeat', () => {
  for (const repeat of [1, 2, 3]) {
    const results = makeResults({ selection: { cases: ['explicit'], clients: ['copilot'], arms: ['candidate', 'baseline', 'no-skill'] } });
    const run = results.runs.find(run => run.arm === 'no-skill' && run.repeat === repeat);
    run.trigger.evidence.push({ kind: 'skill-load', skill: loaded.suite.skill, ref: 'trace.jsonl#contamination' });
    const report = evaluateResults(loaded, results);
    assert.equal(report.passed, false);
    assert.equal(report.groups[0].arms['no-skill'].repeats[repeat - 1].discovery.status, 'failed');
    assert.equal(report.groups[0].comparison.status, 'non-regressed');
    assert.throws(() => planRuns(loaded, profile, { arms: ['candidate', 'no-skill'] }), /baseline arms are required/);
  }
});

test('missing repeats remain visible as missing outcomes rather than averaged away', () => {
  const results = makeResults();
  results.runs = results.runs.filter(run => !(run.arm === 'candidate' && run.repeat === 2));
  const report = evaluateResults(loaded, results);
  assert.equal(report.passed, false);
  assert.deepEqual(report.groups[0].arms.candidate.repeats[1], {
    repeat: 2, runId: null, status: 'missing',
    discovery: { status: 'missing', loaded: null, evidence: [] },
    checks: [{ id: 'plan-present', class: 'correctness', status: 'missing', evidence: null }]
  });
  assert.equal(report.groups[0].arms.candidate.counts.executions.missing, 1);
});
