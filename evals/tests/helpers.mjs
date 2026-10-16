import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION, hashContent, hashObject, loadSuite, planRuns, readJson, snapshotIdentity } from '../harness/index.mjs';
import { CLIENT_VERSIONS } from '../harness/isolation/index.mjs';

export const suiteFile = fileURLToPath(new URL('./fixtures/example/suite.json', import.meta.url));
export const profileFile = fileURLToPath(new URL('./fixtures/profile.json', import.meta.url));
export const loaded = loadSuite(suiteFile);
export const profile = readJson(profileFile);
const exampleRun = readJson(fileURLToPath(new URL('./fixtures/normalized-run.json', import.meta.url)));

export function nativeMatrixFixture(t, { privateContext = false } = {}) {
  const workRoot = fileURLToPath(new URL('../.work/', import.meta.url));
  fs.mkdirSync(workRoot, { recursive: true });
  const directory = path.join(workRoot, `task-tests-${randomUUID()}`);
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const suite = readJson(suiteFile);
  fs.copyFileSync(path.join(path.dirname(suiteFile), 'guide.txt'), path.join(directory, 'guide.txt'));
  if (privateContext) {
    fs.writeFileSync(path.join(directory, 'private.txt'), 'PRIVATE-GRADER-DATA');
    suite.context.dependencies.push({
      id: 'private-key', kind: 'fixture', availability: 'provided', visibility: 'judge',
      path: 'private.txt', mount: 'private.txt'
    });
  }
  fs.writeFileSync(path.join(directory, 'suite.json'), JSON.stringify(suite));
  for (const arm of ['candidate', 'baseline']) {
    const root = path.join(directory, arm);
    fs.mkdirSync(path.join(root, 'skills', 'example-skill', 'references'), { recursive: true });
    const contents = {
      'skills/example-skill/SKILL.md': `---\nname: example-skill\ndescription: Explicit native mock fixture.\n---\n${arm} skill bytes\n`,
      'skills/example-skill/references/guide.txt': 'Selected supporting skill file\n',
      'unrelated.txt': 'Must not enter native skill context\n'
    };
    const snapshot = {
      contractVersion: CONTRACT_VERSION, snapshotId: '',
      source: { repo: directory, commit: 'a'.repeat(40), mode: 'working-tree', dirtyPaths: [], deletedPaths: [] },
      files: Object.entries(contents).map(([filename, text]) => {
        const content = Buffer.from(text);
        fs.writeFileSync(path.join(root, ...filename.split('/')), content);
        return { path: filename, bytes: content.length, sha256: hashContent(content), origin: 'tracked', executable: false };
      })
    };
    snapshot.snapshotId = snapshotIdentity(snapshot);
    fs.writeFileSync(path.join(root, 'snapshot.json'), JSON.stringify(snapshot));
  }
  const profile = readJson(profileFile);
  profile.runner = '@vercel/agent-eval@2.4.1';
  profile.auth = 'none-offline';
  for (const client of Object.keys(profile.clients)) profile.clients[client].version = CLIENT_VERSIONS[client];
  return {
    suiteFile: path.join(directory, 'suite.json'), profile, selection: { cases: ['explicit'], clients: ['copilot'] },
    skillPath: 'skills\\example-skill',
    candidateExport: path.join(directory, 'candidate'), baselineExport: path.join(directory, 'baseline'),
    mockScenarios: [{ caseId: 'explicit', loadSkill: true, artifacts: [{ path: 'plan.txt', content: 'Independent public mock output' }] }]
  };
}

export function makeResults({ selection = { cases: ['explicit'], clients: ['copilot'] }, invocationId = 'test-invocation' } = {}) {
  const plan = planRuns(loaded, profile, selection);
  const snapshots = {};
  for (const arm of ['candidate', 'baseline']) {
    const bytes = Buffer.from(`${arm} synthetic skill content`);
    const snapshot = {
      contractVersion: CONTRACT_VERSION, snapshotId: '',
      source: { repo: 'synthetic-approved-repo', commit: 'a'.repeat(40), mode: 'working-tree', dirtyPaths: [], deletedPaths: [] },
      files: [{ path: 'skills/example-skill/SKILL.md', sha256: hashContent(bytes), bytes: bytes.length, origin: 'tracked', executable: false }]
    };
    snapshot.snapshotId = snapshotIdentity(snapshot);
    snapshots[arm] = snapshot;
  }
  const runs = plan.tasks.map(task => {
    const item = loaded.suite.cases.find(item => item.id === task.caseId);
    const positive = item.expectation !== 'negative';
    return {
      ...structuredClone(exampleRun), ...task,
      runId: `${invocationId}-${task.caseId}-${task.client}-${task.arm}-${task.repeat}`,
      invocationId, snapshotId: task.arm === 'no-skill' ? null : snapshots[task.arm].snapshotId,
      profileHash: plan.profileHash,
      model: { requested: profile.clients[task.client].model, observed: 'synthetic-test-model' },
      trigger: {
        loaded: task.arm === 'no-skill' ? false : positive,
        evidence: task.arm === 'no-skill' ? [] : [{ kind: positive ? 'skill-load' : 'discovery-audit', skill: loaded.suite.skill, ref: 'trace.jsonl#event-1' }]
      },
      checks: item.hardChecks.map(check => ({ id: check.id, class: check.class, status: 'passed', evidence: 'checks.json#check-1' }))
    };
  });
  return {
    contractVersion: CONTRACT_VERSION, invocationId, suiteId: loaded.suite.id, profile: structuredClone(profile),
    selection: plan.selection, snapshots,
    baseline: {
      contractVersion: CONTRACT_VERSION, snapshotId: snapshots.baseline.snapshotId, profileHash: hashObject(profile),
      provenance: { kind: 'bootstrap', reference: 'Synthetic human-approved test snapshot; not a release' },
      approval: { approved: true, by: 'test-human', at: '2026-10-07T12:00:00Z', snapshotId: snapshots.baseline.snapshotId }
    },
    runs
  };
}
