import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateCase, gradeSample } from '@bobthearsonist/ai-evals/contract';
import { loadSuite } from '@bobthearsonist/ai-evals/compile-claude';
import { resolveConfig } from '@bobthearsonist/ai-evals/config';

const root = resolve(import.meta.dirname, '..');
const configPath = join(root, 'evals.json');
const config = resolveConfig({ configPath });
const suites = readdirSync(config.casesDir);
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

test('wrapper resolves repository config from a foreign working directory', () => {
  const result = run('cli.mjs', ['run', '--exe', process.execPath]);
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /--approve-sessions 18/);
});

test('both all-suite entrypoints discover repository cases without live calls', () => {
  const total = suites.reduce((n, suite) => n + loadSuite(join(config.casesDir, suite)).length * 3 * 2, 0);
  for (const [file, args] of [['run-all.mjs', []], ['cli.mjs', ['run-all']]]) {
    const result = run(file, args);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.includes(`${total} live session(s) across ${suites.length} suites`), result.stdout);
  }
});

test('wrapper preserves custom configs, suite selection and help', () => {
  const result = run('run-all.mjs', [`--config=${configPath}`, '--suites', 'git-commit-style']);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /18 live session\(s\) across 1 suites/);
  const help = run('cli.mjs', ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /ai-evals/);
});
