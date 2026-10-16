import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLIENTS, CONTRACT_VERSION, hashContent, loadSuite, planRuns, readJson, validateDocument } from '../../harness/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const framework = path.resolve(here, '../../..');
const repositories = path.dirname(framework);
const profile = readJson(path.join(framework, 'evals', 'tests', 'fixtures', 'profile.json'));
const pilots = [
  { repo: framework, id: 'ai-repo-management' },
  { repo: path.join(repositories, 'ai-private'), id: 'git-commit-style' },
  { repo: path.join(repositories, 'profisee-ai'), id: 'windows-powershell-patterns' }
];
const canonicalDistractors = {
  'git-commit-style': path.join(repositories, 'ai-private', 'skills', 'git-commit-style', 'SKILL.md'),
  'windows-powershell-patterns': path.join(repositories, 'profisee-ai', 'skills', 'windows-powershell-patterns', 'SKILL.md')
};

// Deterministic artifact specimens only, not an execution adapter or trace parser.
function failingChecks(checks, artifacts) {
  return checks.filter(check => {
    const content = artifacts[check.target];
    if (check.type === 'artifact-exists') return (content !== undefined) !== check.expected;
    if (content === undefined) return true;
    if (check.type === 'artifact-contains') return !content.includes(check.expected);
    if (check.type === 'artifact-not-contains') return content.includes(check.expected);
    throw new Error(`Unsupported deterministic check: ${check.type}`);
  });
}

for (const pilot of pilots) {
  const filename = path.join(pilot.repo, 'evals', 'suites', pilot.id, 'suite.json');
  const loaded = loadSuite(filename);
  const { suite, root } = loaded;
  const exampleFile = path.join(root, 'fixtures', 'specimens.json');
  const examples = readJson(exampleFile);

  test(`${pilot.id}: real source and explicit three-client discovery coverage`, () => {
    assert.equal(suite.id, pilot.id);
    assert.equal(CONTRACT_VERSION, 2);
    assert.equal(suite.contractVersion, CONTRACT_VERSION);
    assert.equal(suite.skill, pilot.id);
    assert.deepEqual(suite.clients, [...CLIENTS]);
    assert.equal(suite.cases.length, 4);
    assert.deepEqual(suite.cases.map(item => item.expectation), ['explicit', 'implicit', 'negative', 'negative']);
    assert.match(suite.cases[0].prompt, new RegExp(`Use ${pilot.id}`));
    assert.ok(!suite.cases[1].prompt.includes(pilot.id), 'Implicit case must not name its target');
    const source = fs.readFileSync(path.join(pilot.repo, 'skills', pilot.id, 'SKILL.md'), 'utf8');
    assert.ok(source.includes(`name: ${pilot.id}`));
    assert.ok(suite.context.dependencies.some(item => item.kind === 'distractor-skill' && item.visibility === 'agent'));
    for (const item of suite.context.dependencies.filter(item => item.kind === 'distractor-skill')) {
      const bytes = fs.readFileSync(path.join(root, item.path), 'utf8');
      const name = /^name: (.+)$/m.exec(bytes)?.[1];
      assert.ok(canonicalDistractors[name], `Distractor must be an approved real source skill: ${name}`);
      assert.equal(bytes.replaceAll('\r\n', '\n'), fs.readFileSync(canonicalDistractors[name], 'utf8').replaceAll('\r\n', '\n'));
    }
  });

  test(`${pilot.id}: deterministic fixture hashes and test-only specimen separation`, () => {
    assert.deepEqual(Object.keys(examples).sort(), suite.cases.map(item => item.id).sort());
    assert.ok(!suite.context.dependencies.some(item => item.visibility === 'judge'),
      'These pilots have no runtime grader-private dependencies');
    for (const item of suite.cases) {
      assert.deepEqual(Object.keys(loaded.caseContracts[item.id]), ['fixtureHash']);
      assert.match(loaded.caseContracts[item.id].fixtureHash, /^[a-f0-9]{64}$/);
      for (const dependency of suite.context.dependencies.filter(dep => dep.availability === 'provided' && dep.visibility === 'agent')) {
        const input = fs.readFileSync(path.join(root, dependency.path));
        assert.notEqual(path.resolve(root, dependency.path), exampleFile);
        assert.notEqual(hashContent(input), hashContent(fs.readFileSync(exampleFile)));
        assert.ok(!dependency.mount.replaceAll('\\', '/').startsWith('judge/'));
      }
    }
  });

  test(`${pilot.id}: 72 default and 108 diagnostic tasks, every case/client/arm/repeat enumerated`, () => {
    const plan = planRuns(loaded, profile);
    assert.equal(plan.taskSessionCount, 72);
    assert.deepEqual(plan.selection.arms, ['candidate', 'baseline']);
    for (const item of suite.cases) {
      for (const client of CLIENTS) {
        for (const arm of plan.selection.arms) {
          assert.deepEqual(plan.tasks.filter(task => task.caseId === item.id && task.client === client && task.arm === arm).map(task => task.repeat), [1, 2, 3]);
        }
      }
    }
    for (const client of CLIENTS) assert.equal(planRuns(loaded, profile, { clients: [client] }).taskSessionCount, 24);
    assert.equal(planRuns(loaded, profile, { arms: ['candidate', 'baseline', 'no-skill'] }).taskSessionCount, 108);
    assert.throws(() => planRuns(loaded, profile, { clients: ['unsupported'] }));
    assert.throws(() => planRuns(loaded, profile, { arms: ['candidate'] }));
    const badCase = structuredClone(suite);
    badCase.cases[0].expectation = 'prose-self-report';
    assert.throws(() => validateDocument('suite', badCase));
  });

  for (const item of suite.cases) {
    test(`${pilot.id}/${item.id}: good passes; substantive broken artifact fails correctness`, () => {
      const targets = [...new Set(item.hardChecks.map(check => check.target))];
      assert.equal(targets.length, 1);
      const example = examples[item.id];
      assert.equal(typeof example.good, 'string');
      assert.equal(typeof example.broken, 'string');
      assert.deepEqual(Object.keys(example).sort(), ['broken', 'good']);
      assert.ok(example.good.length && example.broken.length);
      const [target] = targets;
      assert.deepEqual(failingChecks(item.hardChecks, { [target]: example.good }), []);
      const failures = failingChecks(item.hardChecks, { [target]: example.broken });
      assert.ok(failures.some(check => check.class === 'correctness' && check.type !== 'artifact-exists'),
        'Broken artifact must discriminate substantive correctness, not just absence');
      assert.ok(failingChecks(item.hardChecks, {}).some(check => check.id === item.hardChecks[0].id));
    });
  }
}

test('source pilots: exactly three suites, 12 artifact pairs and 216 planned sessions', () => {
  assert.equal(pilots.length, 3);
  let caseCount = 0;
  let sessionCount = 0;
  for (const pilot of pilots) {
    const loaded = loadSuite(path.join(pilot.repo, 'evals', 'suites', pilot.id, 'suite.json'));
    caseCount += loaded.suite.cases.length;
    sessionCount += planRuns(loaded, profile).taskSessionCount;
  }
  assert.equal(caseCount, 12);
  assert.equal(sessionCount, 216);
});

test('ai-repo-management: all home prerequisites use explicit home root and synthetic registries', () => {
  const { suite, root } = loadSuite(path.join(here, 'suite.json'));
  const home = suite.context.dependencies.filter(item => item.kind === 'home-layout');
  assert.equal(home.length, 9);
  assert.ok(home.every(item => item.mountRoot === 'home'));
  assert.ok(home.every(item => !item.mount.replaceAll('\\', '/').startsWith('home/')));
  const registry = fs.readFileSync(path.join(root, 'fixtures', 'home', 'AI', 'local.yaml'), 'utf8');
  assert.match(registry, /path: ~\/Repositories\/ai-private/);
  assert.match(registry, /skills: \[\]/);
  assert.ok(!registry.includes('C:\\Users\\'));
  for (const relative of ['README.md', 'local.yaml', 'local.yaml.example', 'external-skills.yaml', 'docs\\collections.md', 'docs\\skills-agents-architecture.md']) {
    assert.ok(home.some(item => item.mount.replaceAll('/', '\\') === `AI\\${relative}`));
  }
});
