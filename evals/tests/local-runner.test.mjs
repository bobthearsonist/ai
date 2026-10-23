import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateCase, gradeSample } from '@bobthearsonist/ai-evals/contract';
import { loadSuite } from '@bobthearsonist/ai-evals/suite';
import { resolveConfig } from '@bobthearsonist/ai-evals/config';
import { planJudgeRequests } from '@bobthearsonist/ai-evals/judge';

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

test('advisory semantic rubrics cover only selected positive cases', () => {
  const rubrics = JSON.parse(readFileSync(join(root, 'judge-rubrics.json'), 'utf8'));
  const selected = [
    'edit-through-link', 'god-object', 'before-after', 'score-god-class',
    'incremental', 'pain-gate', 'api-key-config', 'command-review', 'public-repo-pii',
  ];
  assert.deepEqual(Object.keys(rubrics).toSorted(), selected.toSorted());
  const cases = suites.flatMap((suite) => loadSuite(join(config.casesDir, suite)));
  for (const [id, rubric] of Object.entries(rubrics)) {
    const matches = cases.filter((c) => c.id === id);
    assert.equal(matches.length, 1, `${id} must identify one authored case`);
    assert.equal(matches[0].shouldTrigger, true, `${id} must not be a negative control`);
    assert.equal(typeof rubric, 'string');
    assert.match(rubric, /Pass only if/);
    assert.match(rubric, /Fail if/);
    assert.match(rubric, /abstain/);
    assert.match(rubric, /exact answer quotes/);
  }
  const answers = cases.map((c) => ({
    caseId: c.id, arm: 'with', repetition: 1, text: c.samples.pass[0],
    valid: true, complete: true,
  }));
  const plan = planJudgeRequests({ answers, rubric: rubrics });
  assert.equal(plan.plannedSessions, selected.length);
  assert.equal(plan.skipped.length, cases.length - selected.length);
  for (const request of plan.requests) assert.equal(request.rubric, rubrics[request.answer.caseId]);
});

test('wrapper resolves repository config from a foreign working directory', () => {
  const result = run('cli.mjs', ['run', '--exe', process.execPath]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--approve-sessions 18/);
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
