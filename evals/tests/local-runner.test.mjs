import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateCase, gradeSample } from '@bobthearsonist/ai-evals/contract';
import { loadSuite } from '@bobthearsonist/ai-evals/suite';
import { resolveConfig } from '@bobthearsonist/ai-evals/config';
import { judgePolicy, judgePolicySha256, planJudgeRequests } from '@bobthearsonist/ai-evals/judge';
import { planCalibration } from '@bobthearsonist/ai-evals/judge-calibration';
import { archivePolicy } from '@bobthearsonist/ai-evals/policy';

const root = resolve(import.meta.dirname, '..');
const configPath = join(root, 'evals.json');
const config = resolveConfig({ configPath });
const suites = readdirSync(config.casesDir);
const expectedCases = {
  'ai-repo-management': ['confusable-commit-draft', 'edit-through-link', 'explicit-registration', 'implicit-missing-discovery', 'negative-greeting', 'private-remote-placement'],
  'code-anti-patterns': ['god-object', 'negative-control', 'shotgun-surgery'],
  'complexity-scoring': ['before-after', 'negative-control', 'score-god-class'],
  'git-commit-style': ['explicit-positive', 'implicit-breaking', 'negative-control'],
  'pattern-principles': ['incremental', 'negative-control', 'pain-gate'],
  security: ['api-key-config', 'command-review', 'negative-control', 'public-repo-pii'],
};
const expectedJudgeCriteria = {
  'edit-through-link': ['semantic-expectations', 'shared-branch', 'client-sync', 'no-generated-copy'],
  'god-object': ['semantic-expectations', 'cohesive-responsibilities', 'responsibility-concentration'],
  'before-after': ['semantic-expectations', 'file-size-alone', 'four-dimension-composite'],
  'score-god-class': ['semantic-expectations', 'composite-score', 'stated-evidence', 'not-low-complexity'],
  incremental: ['semantic-expectations', 'pattern-problem-proof', 'no-blanket-rollout'],
  'pain-gate': ['semantic-expectations', 'no-demonstrated-pain', 'future-refactor', 'no-speculative-add', 'not-never-refactor'],
  'api-key-config': ['semantic-expectations', 'no-committed-key', 'local-env-safety', 'no-live-key-echo'],
  'command-review': ['semantic-expectations', 'safer-token-handling', 'no-unsafe-command', 'no-fabricated-credential'],
  'public-repo-pii': ['semantic-expectations', 'local-personal-path', 'no-public-real-path'],
};
const run = (file, args = []) => spawnSync(process.execPath, [join(root, 'local', file), ...args], {
  encoding: 'utf8',
  cwd: resolve(root, '..'),
});

test('every repository-owned suite validates and has a negative control', () => {
  assert.ok(suites.length >= 5);
  for (const suite of suites) {
    const cases = loadSuite(join(config.casesDir, suite));
    assert.ok(cases.length >= 3, suite);
    assert.ok(cases.some((c) => !c.shouldTrigger), `${suite} needs a negative control`);
    for (const c of cases) assert.deepEqual(validateCase(c), [], `${suite}/${c.id}`);
  }
});

test('all existing cases are authored in Gherkin with offline samples', () => {
  assert.deepEqual(suites.toSorted(), Object.keys(expectedCases).toSorted());
  for (const suite of suites) {
    const dir = join(config.casesDir, suite);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith('.json') && !name.endsWith('.samples.json')),
      [],
      `${suite} still has a JSON case definition`,
    );
    const cases = loadSuite(dir);
    assert.deepEqual(cases.map((c) => c.id).toSorted(), expectedCases[suite].toSorted(), suite);
    for (const c of cases) {
      assert.equal(c.schemaVersion, 2, `${suite}/${c.id}`);
      assert.ok(c.source.uri.endsWith('.feature'), `${suite}/${c.id}`);
      assert.ok(c.samples.pass.length > 0 && c.samples.fail.length > 0, `${suite}/${c.id}`);
    }
  }
});

test('graders classify each case hand-written samples as declared', () => {
  let checked = 0;
  for (const suite of suites) {
    for (const c of loadSuite(join(config.casesDir, suite))) {
      for (const text of c.samples?.pass ?? []) {
        const result = gradeSample(c, text);
        assert.ok(result.passed, `${suite}/${c.id} should pass: ${JSON.stringify(text)} failed ${result.failed}`);
        checked++;
      }
      for (const text of c.samples?.fail ?? []) {
        assert.ok(!gradeSample(c, text).passed, `${suite}/${c.id} should fail: ${JSON.stringify(text)}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 20);
});

test('Gherkin semantic criteria cover only selected positive cases', () => {
  const selected = Object.keys(expectedJudgeCriteria);
  assert.equal(existsSync(join(root, 'judge-rubrics.json')), false);
  const cases = suites.flatMap((suite) => loadSuite(join(config.casesDir, suite)));
  const freeformIds = suites.flatMap((suite) => {
    const dir = join(config.casesDir, suite);
    return readdirSync(dir).filter((name) => name.endsWith('.feature')).flatMap((name) => {
      const source = readFileSync(join(dir, name), 'utf8');
      return [...source.matchAll(/^\s*(?:Then|And) the AI judge confirms "([^"]+)":/gm)]
        .map(([, id]) => id);
    });
  });
  assert.deepEqual(freeformIds, ['four-dimension-composite']);
  const judged = cases.filter((c) => c.judgeCriteria?.length);
  assert.deepEqual(judged.map((c) => c.id).toSorted(), selected.toSorted());
  for (const { id, judgeCriteria } of judged) {
    const matches = cases.filter((c) => c.id === id);
    assert.equal(matches.length, 1, `${id} must identify one authored case`);
    assert.equal(matches[0].shouldTrigger, true, `${id} must not be a negative control`);
    assert.deepEqual(judgeCriteria.map(({ id: criterionId }) => criterionId), expectedJudgeCriteria[id]);
    assert.equal(new Set(judgeCriteria.map(({ id: criterionId }) => criterionId)).size, judgeCriteria.length);
    assert.ok(judgeCriteria.every(({ text }) => text.trim().length > 0));
  }
  const freeformCriteria = judged.flatMap(({ id, judgeCriteria }) => judgeCriteria
    .filter(({ id: criterionId }) => criterionId === 'four-dimension-composite')
    .map(() => `${id}/four-dimension-composite`));
  assert.deepEqual(freeformCriteria, ['before-after/four-dimension-composite']);
  assert.match(judged.find(({ id }) => id === 'before-after').judgeCriteria
    .find(({ id }) => id === 'four-dimension-composite').text, /uses or proposes.*four-dimension composite out of 20/i);
  const answers = cases.map((c) => ({
    caseId: c.id, arm: 'with', repetition: 1, text: c.samples.pass[0],
    valid: true, complete: true,
  }));
  const plan = planJudgeRequests({ answers, cases });
  assert.equal(plan.plannedSessions, selected.length);
  assert.equal(plan.skipped.length, cases.length - selected.length);
  for (const request of plan.requests) {
    assert.deepEqual(request.policy.criteria, judged.find((c) => c.id === request.answer.caseId).judgeCriteria);
  }
});

test('historical calibrated policies do not cover the current action-table policies', () => {
  const historical = JSON.parse(readFileSync(join(root, 'calibration', 'result-2026-10-27-haiku-v3.json'), 'utf8'));
  const currentCases = suites.flatMap((suite) => loadSuite(join(config.casesDir, suite)));
  assert.equal(historical.eligible, true);
  assert.equal(historical.kind, 'judge-calibration-summary');
  assert.equal(historical.scoringStatus, 'explicit-opt-in-for-five-exact-policies');
  assert.equal(historical.engineCommit, 'c697dfa3abac84263a013b64193544e4d5a2a93c');
  assert.equal(historical.policies.length, 5);
  assert.deepEqual(Object.fromEntries(historical.policies.map(({ caseId, policySha256 }) => [caseId, policySha256])), {
    'pain-gate': 'e63e2d9efe582b4147877f0adfbf15f9cba8e047cb7bb52b9055340ccd96ba12',
    incremental: '86562bf2e240db4ac535b86209688977d2cdc722f848cda552e4d0336b39c2c9',
    'god-object': '8c5a36987e8688e04c7663a441b82eeeda22fcbadec982cbe7ad08a2767169d4',
    'before-after': 'cabf99f6666499946ed3d957810aaa09e5458e62ad00bd845bfdb1a430c9716e',
    'score-god-class': '0f4cbacb2fd814f2e8ec324d6c8e1b99d1c3a45140f4caf6c21310a80df069e9',
  });
  const current = new Map(historical.policies.map(({ caseId }) => {
    const matches = currentCases.filter((c) => c.id === caseId);
    assert.equal(matches.length, 1, `current policy must resolve uniquely: ${caseId}`);
    return [caseId, judgePolicySha256(judgePolicy(matches[0]))];
  }));
  for (const { caseId, policySha256 } of historical.policies) {
    assert.ok(current.has(caseId), `current policy missing ${caseId}`);
    assert.notEqual(current.get(caseId), policySha256, `${caseId} must not inherit historical calibration`);
  }
});

test('wrapper resolves repository config from a foreign working directory', () => {
  const result = run('cli.mjs', ['run', '--exe', process.execPath]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--approve-sessions 18/);
});

test('calibration wrapper selects all labeled policies without a default suite', () => {
  const result = run('cli.mjs', [
    'calibrate', '--client', 'claude', '--model', 'haiku',
    '--labels', join(root, 'calibration', 'judge-labels.json'), '--dry-run',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).plannedSessions, 40);
});

test('judge wrapper uses the archived policy without injecting a suite', () => {
  const archive = mkdtempSync(join(tmpdir(), 'ai-judge-wrapper-'));
  try {
    const cases = loadSuite(join(config.casesDir, 'pattern-principles'));
    archivePolicy(archive, cases, {});
    writeFileSync(join(archive, 'normalized.json'), JSON.stringify({ transport: 'acp', client: 'claude' }));
    const directory = join(archive, 'traces', 'pain-gate');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'with-1.jsonl');
    writeFileSync(path, JSON.stringify({
      type: 'ai-evals.acp', schemaVersion: 1,
      transcript: { finalText: 'Keep the simple branches for now.', complete: true, toolCalls: [], raw: '' },
    }));
    writeFileSync(`${path}.receipt.json`, JSON.stringify({ valid: true, exitCode: 0 }));
    const result = run('cli.mjs', ['judge', archive, '--client', 'claude', '--model', 'haiku', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).plannedSessions, 1);
  } finally {
    rmSync(archive, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('fresh calibration labels are balanced and disjoint from regression answers', () => {
  const read = (name) => JSON.parse(readFileSync(join(root, 'calibration', name), 'utf8'));
  const regression = read('judge-labels.json');
  const holdouts = ['judge-labels-holdout.json', 'judge-labels-holdout-v3.json'].map(read);
  const cases = suites.flatMap((suite) => loadSuite(join(config.casesDir, suite)));
  const combined = { schemaVersion: 1, samples: [regression, ...holdouts].flatMap((set) => set.samples) };
  assert.equal(planCalibration({ cases, labels: combined }).length, 120);
  for (const holdout of holdouts) {
    assert.equal(holdout.samples.length, 40);
    const counts = new Map();
    for (const sample of holdout.samples) {
      const count = counts.get(sample.caseId) ?? { pass: 0, fail: 0 };
      count[sample.expected]++;
      counts.set(sample.caseId, count);
    }
    assert.equal(counts.size, 5);
    for (const count of counts.values()) assert.deepEqual(count, { pass: 4, fail: 4 });
  }
});

test('both all-suite entrypoints discover repository cases without live calls', () => {
  const total = suites.reduce((n, suite) => n + loadSuite(join(config.casesDir, suite)).length * 3 * 2, 0);
  for (const [file, args] of [['run-all.mjs', []], ['cli.mjs', ['run-all']]]) {
    const result = run(file, args);
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes(`${total} live session(s) across ${suites.length} suites`), result.stderr);
  }
});

test('wrapper preserves custom configs, suite selection and help', () => {
  const result = run('run-all.mjs', [`--config=${configPath}`, '--suites', 'git-commit-style']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /18 live session\(s\) across 1 suites/);
  const help = run('cli.mjs', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /ai-evals/);
});
