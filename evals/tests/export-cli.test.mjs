import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  discoverSuites, evaluateResults, exportCandidate, loadSuite, readJson, validateSnapshot
} from '../harness/index.mjs';
import { loaded, makeResults, profileFile, suiteFile } from './helpers.mjs';

const toolRoot = fileURLToPath(new URL('..', import.meta.url));
const mainRepo = path.dirname(toolRoot);
const workRoot = path.join(toolRoot, '.work');
const cliFile = path.join(toolRoot, 'harness', 'cli.mjs');
fs.mkdirSync(workRoot, { recursive: true });

function ownedFixture(t) {
  const directory = path.join(workRoot, `tests-${randomUUID()}`);
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function sourceFixture(t) {
  const directory = ownedFixture(t);
  const repo = path.join(directory, 'source');
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'core.autocrlf', 'false');
  // Reuse an existing read-only commit object; tests create no commits or shared refs.
  const commit = git(mainRepo, 'rev-parse', 'HEAD');
  const objects = path.resolve(mainRepo, git(mainRepo, 'rev-parse', '--git-path', 'objects'));
  fs.mkdirSync(path.join(repo, '.git', 'objects', 'info'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'objects', 'info', 'alternates'), `${objects.replaceAll('\\', '/')}\n`);
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), `${commit}\n`);
  git(repo, 'read-tree', commit);
  fs.writeFileSync(path.join(repo, 'README.md'), 'intended tracked dirty content\n');
  fs.writeFileSync(path.join(repo, 'selected.txt'), 'explicit selected untracked fixture\n');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'must never export this\n');
  return { directory, repo, commit };
}

test('export includes working-tree changes and explicit untracked only; preserves source', t => {
  const { repo, commit } = sourceFixture(t);
  const before = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  const { directory, snapshot } = exportCandidate({ repo, trackedPaths: ['README.md'], untrackedPaths: ['selected.txt'] });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(snapshot.contractVersion, 2);
  assert.equal(snapshot.source.commit, commit);
  assert.deepEqual(snapshot.source.dirtyPaths, ['README.md']);
  assert.deepEqual(snapshot.files.map(file => file.path), ['README.md', 'selected.txt']);
  assert.equal(snapshot.files[1].origin, 'untracked');
  assert.equal(fs.readFileSync(path.join(directory, 'README.md'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(directory, 'unrelated.txt')), false);
  assert.deepEqual(readJson(path.join(directory, 'snapshot.json')), snapshot);
  validateSnapshot(snapshot, directory);
  fs.writeFileSync(path.join(directory, 'README.md'), 'tampered');
  assert.throws(() => validateSnapshot(snapshot, directory), /mismatch/);
});

test('export records intended tracked deletion rather than restoring HEAD', t => {
  const { repo } = sourceFixture(t);
  const { directory, snapshot } = exportCandidate({ repo, trackedPaths: ['README.md', 'CONTRIBUTING.md'] });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.ok(snapshot.source.deletedPaths.includes('CONTRIBUTING.md'));
  assert.equal(fs.existsSync(path.join(directory, 'CONTRIBUTING.md')), false);
});

test('export records staged deletions missing from the current index', t => {
  const { repo } = sourceFixture(t);
  git(repo, 'update-index', '--force-remove', 'CONTRIBUTING.md');
  const { directory, snapshot } = exportCandidate({ repo, trackedPaths: ['README.md', 'CONTRIBUTING.md'] });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.ok(snapshot.source.deletedPaths.includes('CONTRIBUTING.md'));
});

test('separate approved source repos export to uniquely owned roots', t => {
  const { repo } = sourceFixture(t);
  const root = path.join(repo, 'evals', '.work');
  const first = exportCandidate({ repo, trackedPaths: ['README.md'], workRoot: root });
  const second = exportCandidate({ repo, trackedPaths: ['README.md'], workRoot: root });
  assert.notEqual(first.directory, second.directory);
  assert.equal(first.snapshot.snapshotId, second.snapshot.snapshotId);
});

test('Windows export preserves tracked Git executable identity', { skip: process.platform !== 'win32' }, t => {
  const { repo } = sourceFixture(t);
  git(repo, 'update-index', '--chmod=+x', 'README.md');
  const { directory, snapshot } = exportCandidate({ repo, trackedPaths: ['README.md'] });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.equal(snapshot.files[0].executable, true);
});

test('escaping symlink/junction and path traversal fail closed', t => {
  const { directory, repo } = sourceFixture(t);
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'synthetic outside content');
  fs.symlinkSync(outside, path.join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => exportCandidate({ repo, trackedPaths: ['README.md'], untrackedPaths: ['linked/secret.txt'] }), /Symlink escapes/);
  assert.throws(() => exportCandidate({ repo, trackedPaths: ['../outside'] }), /Invalid path/);
  assert.throws(() => exportCandidate({ repo, trackedPaths: ['README.md'], workRoot: outside }), /Work root/);
});

test('symlinked work-root ancestors fail closed', t => {
  const { directory, repo } = sourceFixture(t);
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(repo, 'evals'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => exportCandidate({ repo, trackedPaths: ['README.md'], workRoot: path.join(repo, 'evals', '.work') }), /ancestors/);
});

test('empty selection, tracked-as-untracked and missing dependencies fail', t => {
  const { repo } = sourceFixture(t);
  assert.throws(() => exportCandidate({ repo, trackedPaths: [] }), /Explicit tracked/);
  assert.throws(() => exportCandidate({ repo, trackedPaths: ['missing-path'] }), /Empty source/);
  assert.throws(() => exportCandidate({ repo, trackedPaths: ['README.md'], untrackedPaths: ['README.md'] }), /Not untracked/);
  assert.throws(() => exportCandidate({ repo, trackedPaths: ['README.md'], untrackedPaths: ['missing.txt'] }));
});

function copySuite(t, mutate = () => {}) {
  const directory = ownedFixture(t);
  const suite = structuredClone(loaded.suite);
  mutate(suite);
  fs.writeFileSync(path.join(directory, 'suite.json'), JSON.stringify(suite));
  fs.copyFileSync(path.join(path.dirname(suiteFile), 'guide.txt'), path.join(directory, 'guide.txt'));
  return { directory, filename: path.join(directory, 'suite.json') };
}

test('suite loader rejects duplicate IDs, unavailable mounts, missing files and removed rubrics', t => {
  for (const mutate of [
    suite => suite.cases.push(structuredClone(suite.cases[0])),
    suite => suite.context.dependencies.push(structuredClone(suite.context.dependencies[0])),
    suite => { suite.context.dependencies[1].path = 'guide.txt'; },
    suite => { suite.context.dependencies[0].path = 'missing.txt'; },
    suite => { suite.cases[0].rubric = { id: 'obsolete', version: '1', path: 'guide.txt' }; },
    suite => { suite.cases[0].hardChecks[0].target = '../escape'; }
  ]) {
    const { filename } = copySuite(t, mutate);
    assert.throws(() => loadSuite(filename));
  }
});

test('omitted mountRoot defaults to workspace and hashes like explicit workspace', t => {
  const omitted = copySuite(t, suite => { delete suite.context.dependencies[0].mountRoot; });
  const explicit = copySuite(t, suite => { suite.context.dependencies[0].mountRoot = 'workspace'; });
  const first = loadSuite(omitted.filename);
  const second = loadSuite(explicit.filename);
  assert.equal(first.suite.context.dependencies[0].mountRoot, 'workspace');
  assert.equal(first.fixtureHash, second.fixtureHash);
  assert.deepEqual(first.caseContracts, second.caseContracts);
});

test('home mountRoot changes context identity and is explicit, never a magic prefix', t => {
  const home = copySuite(t, suite => {
    suite.context.dependencies[0].mountRoot = 'home';
    suite.context.dependencies[0].mount = 'AI\\docs\\guide.txt';
  });
  const prefix = copySuite(t, suite => {
    delete suite.context.dependencies[0].mountRoot;
    suite.context.dependencies[0].mount = 'home\\AI\\docs\\guide.txt';
  });
  const first = loadSuite(home.filename);
  const second = loadSuite(prefix.filename);
  assert.equal(first.suite.context.dependencies[0].mountRoot, 'home');
  assert.equal(first.suite.context.dependencies[0].mount, 'AI/docs/guide.txt');
  assert.equal(second.suite.context.dependencies[0].mountRoot, 'workspace');
  assert.equal(second.suite.context.dependencies[0].mount, 'home/AI/docs/guide.txt');
  assert.notEqual(first.fixtureHash, second.fixtureHash);
  assert.notEqual(first.caseContracts.explicit.fixtureHash, second.caseContracts.explicit.fixtureHash);
  assert.equal(evaluateResults(first, makeResults()).passed, false);
});

test('changing only mountRoot changes context and per-case hashes', t => {
  const home = copySuite(t, suite => { suite.context.dependencies[0].mountRoot = 'home'; });
  const changed = loadSuite(home.filename);
  assert.notEqual(changed.fixtureHash, loaded.fixtureHash);
  assert.notEqual(changed.caseContracts.explicit.fixtureHash, loaded.caseContracts.explicit.fixtureHash);
});

test('mount collisions are scoped to explicit root and agent/judge visibility', t => {
  const fixture = copySuite(t, suite => {
    const dependency = suite.context.dependencies[0];
    dependency.mountRoot = 'workspace';
    suite.context.dependencies.push({ ...dependency, id: 'home-guide', mountRoot: 'home' });
    suite.context.dependencies.push({ ...dependency, id: 'judge-guide', visibility: 'judge' });
  });
  const result = loadSuite(fixture.filename);
  assert.equal(result.suite.context.dependencies.filter(dependency => dependency.availability === 'provided').length, 3);
});

test('normalized duplicate and ancestor file mounts collide within each root', t => {
  for (const mountRoot of ['home', 'workspace']) for (const mount of ['docs/guide.txt', 'docs\\guide.txt', 'DOCS/GUIDE.TXT', 'docs/./guide.txt', 'docs', 'docs/guide.txt/child']) {
    const fixture = copySuite(t, suite => {
      suite.context.dependencies[0].mountRoot = mountRoot;
      suite.context.dependencies.push({ ...suite.context.dependencies[0], id: 'collision', mount });
    });
    assert.throws(() => loadSuite(fixture.filename), /mount collision/);
  }
});

test('each mountRoot rejects traversal, absolute mounts and root-directory targets', t => {
  for (const mountRoot of ['home', 'workspace']) for (const mount of ['../escape', '..\\escape', 'docs\\..\\escape', 'C:\\absolute', '/absolute', '\\\\server\\share', '.']) {
    const fixture = copySuite(t, suite => {
      Object.assign(suite.context.dependencies[0], { mountRoot, mount });
    });
    assert.throws(() => loadSuite(fixture.filename));
  }
});

test('unknown mountRoot and unavailable mountRoot declarations fail closed', t => {
  for (const mutate of [
    suite => { suite.context.dependencies[0].mountRoot = 'developer-home'; },
    suite => { suite.context.dependencies[1].mountRoot = 'home'; }
  ]) {
    const fixture = copySuite(t, mutate);
    assert.throws(() => loadSuite(fixture.filename), /mountRoot|Invalid suite/);
  }
});

test('context or required check changes invalidate previous comparison', t => {
  const { directory, filename } = copySuite(t);
  assert.equal(evaluateResults(loadSuite(filename), makeResults()).passed, true);
  fs.writeFileSync(path.join(directory, 'guide.txt'), 'changed context');
  assert.equal(evaluateResults(loadSuite(filename), makeResults()).passed, false);
  fs.copyFileSync(path.join(path.dirname(suiteFile), 'guide.txt'), path.join(directory, 'guide.txt'));
  const suite = readJson(filename);
  suite.cases[0].hardChecks[0].expected = false;
  fs.writeFileSync(filename, JSON.stringify(suite));
  assert.equal(evaluateResults(loadSuite(filename), makeResults()).passed, false);
});

test('discovery finds only repository-owned evals/suites, not skill payloads', t => {
  const directory = ownedFixture(t);
  fs.mkdirSync(path.join(directory, 'evals', 'suites', 'example'), { recursive: true });
  fs.copyFileSync(suiteFile, path.join(directory, 'evals', 'suites', 'example', 'suite.json'));
  fs.mkdirSync(path.join(directory, 'skills', 'bad'), { recursive: true });
  fs.copyFileSync(suiteFile, path.join(directory, 'skills', 'bad', 'suite.json'));
  assert.equal(discoverSuites(directory).length, 1);
  assert.throws(() => loadSuite(path.join(directory, 'skills', 'bad', 'suite.json')), /outside distributed skills/);
});

function cli(...args) {
  return spawnSync(process.execPath, [cliFile, ...args], { encoding: 'utf8' });
}

test('CLI validate and dry-run succeed offline and enumerate all three clients', () => {
  const valid = cli('validate', '--suite', suiteFile, '--profile', profileFile);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).valid, true);
  const plan = cli('dry-run', '--suite', suiteFile, '--profile', profileFile);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).taskSessionCount, 54);
  assert.equal(JSON.parse(plan.stdout).executed, false);
});

test('CLI reports deterministic outcomes and each failed gate exits nonzero', t => {
  const directory = ownedFixture(t);
  const filename = path.join(directory, 'results.json');
  const fixtures = [
    [() => {}, 0],
    [results => { results.runs[0].checks[0].status = 'failed'; }, 1],
    [results => { results.runs[0].trigger.loaded = false; }, 1],
    [results => { results.runs[0].quality = { score: 1 }; }, 1],
    [results => { results.contractVersion = 1; }, 1],
    [results => { results.profile.judge = { model: 'old-ai-judge' }; }, 1],
    [results => { results.runs.find(run => run.arm === 'baseline').checks[0].status = 'skipped'; }, 1],
    [results => { results.runs[0].status = 'error'; }, 1],
    [results => { results.baseline.approval.approved = false; }, 1]
  ];
  for (const [mutate, expected] of fixtures) {
    const results = makeResults();
    mutate(results);
    fs.writeFileSync(filename, JSON.stringify(results));
    const output = cli('report', '--suite', suiteFile, '--results', filename);
    assert.equal(output.status, expected, output.stderr || output.stdout);
    if (expected === 0) {
      const report = JSON.parse(output.stdout);
      assert.equal(report.contractVersion, 2);
      assert.equal(report.groups[0].arms.candidate.counts.checks.passed, 3);
      assert.equal(report.groups[0].comparison.status, 'non-regressed');
      assert.equal(Object.hasOwn(report.groups[0], 'means'), false);
    }
  }
  const output = cli('report', '--suite', suiteFile, '--results', filename, '--previous', filename);
  assert.equal(output.status, 1);
});

test('CLI export preserves explicitly selected source and run fails explicitly', t => {
  const { repo } = sourceFixture(t);
  const output = cli('export', '--repo', repo, '--tracked', 'README.md', '--untracked', 'selected.txt', '--work-root', path.join(repo, 'evals', '.work'));
  assert.equal(output.status, 0, output.stderr);
  const exported = JSON.parse(output.stdout);
  assert.equal(exported.snapshot.files.length, 2);
  const execution = cli('run');
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /No real execution adapter/);
});

test('CLI malformed/empty selections and missing schemas cannot look successful', t => {
  const directory = ownedFixture(t);
  for (const args of [
    ['validate', '--repo', directory],
    ['dry-run', '--suite', suiteFile, '--profile', profileFile, '--cases', ','],
    ['dry-run', '--suite', suiteFile, '--profile', profileFile, '--clients', 'unsupported'],
    ['report', '--suite', suiteFile, '--results', 'missing.json'],
    ['validate', '--suite', suiteFile, '--unknown', 'x'],
    ['validate', '--suite', suiteFile, '--suite', suiteFile]
  ]) assert.equal(cli(...args).status, 1);
});
