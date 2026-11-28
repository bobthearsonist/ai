import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateCase, gradeSample } from '@bobthearsonist/ai-evals/contract';
import { loadSuite } from '@bobthearsonist/ai-evals/suite';
import { resolveConfig } from '@bobthearsonist/ai-evals/config';
import { planJudgeRequests } from '@bobthearsonist/ai-evals/judge';
import { archivePolicy } from '@bobthearsonist/ai-evals/policy';

const root = resolve(import.meta.dirname, '..');
const configPath = join(root, 'evals.json');
const config = resolveConfig({ configPath });
const suites = readdirSync(config.casesDir);
const expectedCases = {
  'agents-md': ['ai-config-commit-type', 'comment-no-ticket', 'memory-store-direct-write', 'negative-control', 'worktree-flat-sibling'],
  'ai-repo-management': ['confusable-commit-draft', 'edit-through-link', 'explicit-registration', 'implicit-missing-discovery', 'negative-greeting', 'private-remote-placement'],
};
const expectedJudgeCriteria = {
  'edit-through-link': ['semantic-expectations', 'shared-branch', 'client-sync', 'no-generated-copy'],
  'memory-store-direct-write': ['semantic-expectations', 'no-direct-write'],
};
const run = (file, args = []) => spawnSync(process.execPath, [join(root, 'local', file), ...args], {
  encoding: 'utf8',
  cwd: resolve(root, '..'),
});

test('every repository-owned suite validates and has a negative control', () => {
  assert.ok(suites.length >= 2);
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
  assert.deepEqual(freeformIds, []);
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


// Uses the instructions suite because it stages no skill: skills/ is synced per
// machine and absent from a fresh clone such as a CI runner.
test('wrapper resolves repository config from a foreign working directory', () => {
  const result = run('cli.mjs', ['run', '--suite', 'agents-md', '--exe', process.execPath]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--approve-sessions 30/);
});


test('judge wrapper uses the archived policy without injecting a suite', () => {
  const archive = mkdtempSync(join(tmpdir(), 'ai-judge-wrapper-'));
  try {
    const cases = loadSuite(join(config.casesDir, 'ai-repo-management'));
    archivePolicy(archive, cases, {});
    writeFileSync(join(archive, 'normalized.json'), JSON.stringify({ transport: 'acp', client: 'claude' }));
    const directory = join(archive, 'traces', 'edit-through-link');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'with-1.jsonl');
    writeFileSync(path, JSON.stringify({
      type: 'ai-evals.acp', schemaVersion: 1,
      transcript: { finalText: 'Edit the canonical source on a branch, then run sync.', complete: true, toolCalls: [], raw: '' },
    }));
    writeFileSync(`${path}.receipt.json`, JSON.stringify({ valid: true, exitCode: 0 }));
    const result = run('cli.mjs', ['judge', archive, '--client', 'claude', '--model', 'haiku', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).plannedSessions, 1);
  } finally {
    rmSync(archive, { recursive: true, force: true, maxRetries: 3 });
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
  const result = run('run-all.mjs', [`--config=${configPath}`, '--suites', 'ai-repo-management']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /36 live session\(s\) across 1 suites/);
  const help = run('cli.mjs', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /ai-evals/);
});
