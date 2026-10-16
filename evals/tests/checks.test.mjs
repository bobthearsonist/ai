import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ContractError, hashContent, loadSuite, resolveContained } from '../harness/index.mjs';
import { captureArtifacts, executeChecks, gradeChecks, readCapturedArtifact, validateChecks } from '../harness/checks/index.mjs';

const toolRoot = fileURLToPath(new URL('..', import.meta.url));
const repositories = path.resolve(toolRoot, '../..');
const workRoot = path.join(toolRoot, '.work');

function workspace(t) {
  fs.mkdirSync(workRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(workRoot, 'checks-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function check(type, expected, target = 'answer.md', id = type) {
  return { id, class: 'correctness', type, target, expected };
}

test('positive and negative existence/content expectations use captured bytes', t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'answer.md'), 'Welcome café\n');
  const declarations = [
    check('artifact-exists', true),
    check('artifact-exists', false, 'absent.md', 'absent'),
    check('artifact-contains', 'café'),
    check('artifact-not-contains', 'git push'),
    check('artifact-exists', false, 'answer.md', 'unexpected-file'),
    check('artifact-contains', 'welcome', 'answer.md', 'case-sensitive'),
    check('artifact-not-contains', 'Welcome', 'answer.md', 'forbidden')
  ];
  const result = executeChecks({ artifactRoot: root, checks: declarations });
  assert.deepEqual(result.checks.map(item => item.status), ['passed', 'passed', 'passed', 'passed', 'failed', 'failed', 'failed']);
  for (const outcome of result.checks) {
    const record = result.evidence.records.find(record => record.ref === outcome.evidence);
    assert.ok(record);
    assert.equal(record.status, outcome.status);
    assert.match(outcome.evidence, /^artifact-check:sha256:[a-f0-9]{64}$/);
  }
  assert.equal(result.evidence.records[0].artifact.sha256, hashContent(Buffer.from('Welcome café\n')));
  assert.ok(Object.isFrozen(result.evidence.records[0].artifact));
});

test('missing content cannot pass a negative check; expected existing file fails', t => {
  const root = workspace(t);
  const result = executeChecks({ artifactRoot: root, checks: [
    check('artifact-exists', true), check('artifact-contains', 'good'), check('artifact-not-contains', 'bad')
  ] });
  assert.deepEqual(result.checks.map(item => item.status), ['failed', 'error', 'error']);
});

test('capture survives file and returned byte mutations; forged/corrupt captures fail', t => {
  const root = workspace(t);
  const filename = path.join(root, 'answer.md');
  fs.writeFileSync(filename, 'known good');
  const declarations = [check('artifact-contains', 'known good')];
  const capture = captureArtifacts({ artifactRoot: root, checks: declarations });
  const bytes = readCapturedArtifact(capture, 'answer.md');
  bytes.fill(0);
  fs.writeFileSync(filename, 'known broken');
  fs.unlinkSync(filename);
  assert.equal(readCapturedArtifact(capture, 'answer.md').toString(), 'known good');
  assert.equal(gradeChecks({ checks: declarations, capture }).checks[0].status, 'passed');
  assert.throws(() => { capture.artifacts[0].sha256 = '0'.repeat(64); }, TypeError);
  const corrupt = structuredClone(capture);
  corrupt.artifacts[0].sha256 = '0'.repeat(64);
  assert.throws(() => gradeChecks({ checks: declarations, capture: corrupt }), ContractError);
  assert.throws(() => gradeChecks({ checks: declarations, capture: JSON.parse(JSON.stringify(capture)) }), ContractError);
  assert.throws(() => gradeChecks({ checks: [check('artifact-contains', 'broken')], capture }), /Declarations differ/);
  declarations[0].expected = 'broken';
  assert.equal(readCapturedArtifact(capture, 'answer.md').toString(), 'known good');
});

test('capture identity is deterministic and bound to declarations and bytes', t => {
  const root = workspace(t);
  const checks = [check('artifact-contains', 'good')];
  fs.writeFileSync(path.join(root, 'answer.md'), 'good');
  const first = captureArtifacts({ artifactRoot: root, checks });
  assert.equal(first.captureId, captureArtifacts({ artifactRoot: root, checks }).captureId);
  fs.writeFileSync(path.join(root, 'answer.md'), 'bad');
  assert.notEqual(first.captureId, captureArtifacts({ artifactRoot: root, checks }).captureId);
  assert.notEqual(first.captureId, captureArtifacts({ artifactRoot: root, checks: [check('artifact-not-contains', 'good')] }).captureId);
});

test('declarations reject duplicates, unknown types, bad classes/types and nonfinite values', () => {
  const good = check('artifact-exists', true);
  for (const declarations of [
    null, [good, good], [{ ...good, type: 'execute-script' }], [{ ...good, class: 'quality' }],
    [{ ...good, expected: 1 }], [check('artifact-contains', false)], [check('artifact-not-contains', '')],
    [{ ...good, passed: true }], [check('trace-event', NaN)], [check('manual-evidence', Infinity)],
    [check('trace-event', -Infinity)], [check('trace-event', { passed: true })]
  ]) assert.throws(() => validateChecks(declarations), ContractError);
  assert.ok(Object.isFrozen(validateChecks([good])[0]));
});

test('reject traversal, roots and platform-ambiguous targets before capture', t => {
  const root = workspace(t);
  for (const target of [
    '.', '..', '..\\answer.md', 'sub\\..\\answer.md', '/answer.md', '\\answer.md',
    'C:\\answer.md', 'C:answer.md', '\\\\host\\share\\answer.md', 'answer.md:stream',
    'NUL', 'con.txt', 'CONIN$', 'CONOUT$', 'LPT1', 'COM¹.log', 'answer.md.', 'answer.md ', 'sub\\\\answer.md',
    'sub/./answer.md', 'answer\0.md', 'answer?.md', 'sub/'
  ]) assert.throws(() => captureArtifacts({ artifactRoot: root, checks: [check('artifact-exists', false, target)] }), ContractError, target);
  assert.throws(() => validateChecks([
    check('artifact-exists', true, 'Answer.md', 'one'),
    check('artifact-contains', 'x', 'answer.md', 'two')
  ]), /alias/);
});

test('directories and non-directory ancestors error even when absence is expected', t => {
  const root = workspace(t);
  fs.mkdirSync(path.join(root, 'directory'));
  fs.writeFileSync(path.join(root, 'file'), 'x');
  const result = executeChecks({ artifactRoot: root, checks: [
    check('artifact-exists', false, 'directory', 'directory'),
    check('artifact-not-contains', 'x', 'file\\child', 'non-directory')
  ] });
  assert.deepEqual(result.checks.map(item => item.status), ['error', 'error']);
});

test('escaping, contained and dangling directory symlinks fail closed', t => {
  const root = workspace(t);
  const outside = workspace(t);
  fs.mkdirSync(path.join(root, 'inside'));
  fs.writeFileSync(path.join(root, 'inside', 'answer.md'), 'good');
  fs.writeFileSync(path.join(outside, 'answer.md'), 'good');
  for (const [name, destination] of [
    ['escape', outside], ['contained', path.join(root, 'inside')], ['dangling', path.join(root, 'missing')]
  ]) fs.symlinkSync(destination, path.join(root, name), process.platform === 'win32' ? 'junction' : 'dir');
  const result = executeChecks({ artifactRoot: root, checks: ['escape', 'contained', 'dangling'].map(name =>
    check('artifact-exists', false, `${name}\\answer.md`, name)
  ) });
  assert.deepEqual(result.checks.map(item => item.status), ['error', 'error', 'error']);
});

test('unreadable artifacts do not pass content checks', t => {
  const root = workspace(t);
  const filename = path.join(root, 'answer.md');
  fs.writeFileSync(filename, 'good');
  const original = fs.openSync;
  t.mock.method(fs, 'openSync', (name, ...args) => {
    if (name === filename) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
    return original(name, ...args);
  });
  const result = executeChecks({ artifactRoot: root, checks: [check('artifact-not-contains', 'bad')] });
  assert.equal(result.checks[0].status, 'error');
  assert.match(result.evidence.records[0].reason, /EACCES/);
});

test('capture-time mutation errors and unexpected programming errors propagate', t => {
  const root = workspace(t);
  const filename = path.join(root, 'answer.md');
  fs.writeFileSync(filename, 'good');
  const original = fs.readFileSync;
  const mock = t.mock.method(fs, 'readFileSync', (name, ...args) => {
    const bytes = original(name, ...args);
    if (typeof name === 'number') fs.writeFileSync(filename, 'broken-longer');
    return bytes;
  });
  assert.equal(executeChecks({ artifactRoot: root, checks: [check('artifact-not-contains', 'bad')] }).checks[0].status, 'error');
  mock.mock.restore();
  t.mock.method(fs, 'openSync', () => { throw new TypeError('unexpected bug'); });
  assert.throws(() => executeChecks({ artifactRoot: root, checks: [check('artifact-exists', false)] }), /unexpected bug/);
});

test('trace and manual success claims explicitly error without trusted adapters', t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'trace.json'), '{"passed":true,"event":"success"}');
  const result = executeChecks({ artifactRoot: root, checks: [
    check('trace-event', 'success', 'trace.json'),
    check('manual-evidence', true, 'candidate says passed')
  ] });
  assert.deepEqual(result.checks.map(item => item.status), ['error', 'error']);
  assert.ok(result.evidence.records.every(record => /no accepted trusted/.test(record.reason)));
});

for (const [repo, id] of [['ai', 'ai-repo-management'], ['ai-private', 'git-commit-style'], ['profisee-ai', 'windows-powershell-patterns']]) {
  const loaded = loadSuite(path.join(repositories, repo, 'evals', 'suites', id, 'suite.json'));
  const examples = JSON.parse(fs.readFileSync(resolveContained(loaded.root, 'fixtures\\specimens.json'), 'utf8'));
  for (const item of loaded.suite.cases) {
    test(`${id}/${item.id}: actual declared good/broken specimens discriminate`, t => {
      const root = workspace(t);
      const targets = [...new Set(item.hardChecks.map(check => check.target))];
      assert.equal(targets.length, 1);
      const filename = path.join(root, ...targets[0].split(/[/\\]/));
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, examples[item.id].good);
      const good = executeChecks({ artifactRoot: root, checks: item.hardChecks });
      assert.ok(good.checks.every(check => check.status === 'passed'));
      fs.writeFileSync(filename, examples[item.id].broken);
      const broken = executeChecks({ artifactRoot: root, checks: item.hardChecks });
      assert.ok(broken.checks.some(outcome => outcome.status === 'failed' && outcome.class === 'correctness' &&
        item.hardChecks.find(check => check.id === outcome.id).type !== 'artifact-exists'));
      assert.notEqual(good.evidence.captureId, broken.evidence.captureId);
    });
  }
}
