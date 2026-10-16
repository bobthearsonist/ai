import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CONTRACT_VERSION, hashObject } from '../harness/index.mjs';
import { createPackagingExport, generatePackaging, validatePackaging, cleanupPackaging } from '../harness/packaging/index.mjs';
import { NATIVE_VERSION, NATIVE_NORMALIZATION, NATIVE_EXECUTION, NATIVE_LIMITS, loadNativeSuite, inspectNativeRuntime,
  nativeBaselineBinding, createNativeOverlays, verifyNativeOverlays, prepareNativeReview,
  planNativeCommands, normalizeNativeResult, cleanupNativeOverlays } from '../harness/native/index.mjs';

const evalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = process.env.PROFISEE_NATIVE_REPO ?? path.resolve(evalRoot, '..', '..', 'profisee-ai');
const suiteDirectory = path.join(repo, 'evals', 'plugins', 'windows-powershell-patterns');
const executable = process.env.PROFISEE_NATIVE_EXECUTABLE ??
  path.join(process.env.USERPROFILE, '.local', 'share', 'claude', 'versions', NATIVE_VERSION);
const profile = Object.freeze({ model: 'claude-sonnet-4-6',
  provider: 'native-client-auth', mockMode: 'record' });
let packaging;
let runtime;
let syntheticBaselineApproval;

before(async () => {
  runtime = inspectNativeRuntime({ executable });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      packaging = createPackagingExport({ repo });
      break;
    } catch (error) {
      // Windows file scanners can briefly hold the export directory's rename.
      if (error.code !== 'EPERM' || error.syscall !== 'rename' || attempt === 2) throw error;
      await delay(500);
    }
  }
  try {
    generatePackaging(packaging, { runtime: 'docker', image: 'profisee-evals-packaging:local' });
    assert.equal(validatePackaging(packaging).passed, true);
    // Synthetic attestation for API tests only; not an operator-approved baseline.
    syntheticBaselineApproval = { bindingHash: hashObject(nativeBaselineBinding({ packaging })),
      approved: true, reviewType: 'human', reviewer: 'synthetic-test-only',
      reviewedAt: '2026-10-07T18:00:00Z' };
  } catch (error) {
    cleanupPackaging(packaging);
    packaging = undefined;
    throw error;
  }
});
after(() => { if (packaging) cleanupPackaging(packaging); });

function pair(t) {
  const handle = createNativeOverlays({ candidate: packaging, baseline: packaging,
    baselineApproval: syntheticBaselineApproval, suiteDirectory });
  t.after(() => cleanupNativeOverlays(handle));
  return handle;
}

function copiedSuite(t) {
  const directory = path.join(evalRoot, 'harness', 'native', '.work', `synthetic-suite-${randomUUID()}`);
  fs.cpSync(suiteDirectory, directory, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('pinned actual CLI help verifies supported flags without model calls', () => {
  assert.equal(runtime.version, '2.1.291');
  assert.match(runtime.executableHash, /^[a-f0-9]{64}$/);
  assert.match(runtime.evalHelpHash, /^[a-f0-9]{64}$/);
});

test('source-owned suite contains bounded native text cases, hard discovery checks and fixed mock only', () => {
  const loaded = loadNativeSuite({ directory: suiteDirectory });
  assert.equal(loaded.suite.synthetic, true);
  assert.equal(loaded.suite.version, 1);
  assert.deepEqual(loaded.suite.cases, ['text-discovery', 'bundled-resource']);
  assert.equal(NATIVE_LIMITS.repeats, 3);
});

test('real generators materialize separate equivalent overlays without canonical writes', t => {
  const handle = pair(t);
  assert.notEqual(handle.arms.candidate.pluginDirectory, handle.arms.baseline.pluginDirectory);
  assert.equal(handle.arms.candidate.overlayHash, handle.arms.baseline.overlayHash);
  assert.equal(handle.arms.candidate.pluginHash, handle.baselineBinding.pluginHash);
  assert.equal(verifyNativeOverlays(handle), true);
  for (const arm of Object.values(handle.arms)) {
    assert.equal(fs.readFileSync(path.join(arm.pluginDirectory, 'skills', 'windows-powershell-patterns', 'SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(packaging.sourceDirectory, 'skills', 'windows-powershell-patterns', 'SKILL.md'), 'utf8'));
    assert.ok(fs.existsSync(path.join(arm.pluginDirectory, 'evals', 'mocks', 'native-text-fixture', 'explain.md')));
    assert.ok(!fs.existsSync(path.join(arm.pluginDirectory, '.mcp.json')));
  }
});

test('missing/stale baseline approvals cannot become a no-plugin baseline', () => {
  for (const value of [undefined, { ...syntheticBaselineApproval, bindingHash: '0'.repeat(64) },
    { ...syntheticBaselineApproval, approved: false }]) {
    assert.throws(() => createNativeOverlays({ candidate: packaging, baseline: packaging,
      baselineApproval: value, suiteDirectory }), /approval/);
  }
});

test('packaging artifact missing-resource and leaked-fixture mutations fail before overlay copying', () => {
  const pluginRoot = path.join(packaging.sourceDirectory, 'plugins', 'windows-powershell-patterns');
  const resource = path.join(pluginRoot, 'skills', 'windows-powershell-patterns', 'SKILL.md');
  const bytes = fs.readFileSync(resource);
  fs.unlinkSync(resource);
  try {
    assert.throws(() => nativeBaselineBinding({ packaging }), /Packaging preflight failed/);
  } finally { fs.writeFileSync(resource, bytes); }
  const leaked = path.join(pluginRoot, 'leaked-answer-key.txt');
  fs.writeFileSync(leaked, 'honest synthetic fixture');
  try {
    assert.throws(() => nativeBaselineBinding({ packaging }), /Packaging preflight failed/);
  } finally { fs.unlinkSync(leaked); }
});

test('overlay changed resources, leaked fixtures and settings cannot pass preflight', t => {
  const handle = pair(t);
  const resource = path.join(handle.arms.candidate.pluginDirectory, 'skills', 'windows-powershell-patterns', 'SKILL.md');
  const bytes = fs.readFileSync(resource);
  fs.unlinkSync(resource);
  assert.throws(() => verifyNativeOverlays(handle), /Changed native/);
  fs.writeFileSync(resource, bytes);
  const leak = path.join(handle.arms.candidate.pluginDirectory, 'answer-key.txt');
  fs.writeFileSync(leak, 'synthetic');
  assert.throws(() => verifyNativeOverlays(handle), /leaked fixture/);
  fs.unlinkSync(leak);
  const emptyLeak = path.join(handle.arms.candidate.pluginDirectory, 'leaked-fixtures');
  fs.mkdirSync(emptyLeak);
  assert.throws(() => verifyNativeOverlays(handle), /Changed native/);
  fs.rmdirSync(emptyLeak);
  fs.writeFileSync(handle.arms.candidate.settingsPath, '{"mcpServers":{"unsafe":{"url":"https://example.invalid"}}}');
  assert.throws(() => prepareNativeReview({ overlays: handle, runtime, profile }), /Changed native/);
});

test('exact trust approval binds plugin baseline suite settings mocks profile runtime and limits', t => {
  const handle = pair(t);
  const prepared = prepareNativeReview({ overlays: handle, runtime, profile });
  assert.equal(prepared.review.version, CONTRACT_VERSION);
  for (const field of ['suiteHash', 'settingsHash', 'profileHash', 'mockMcpHash', 'limitsHash', 'baselineApprovalHash']) {
    assert.match(prepared.review[field], /^[a-f0-9]{64}$/);
  }
  assert.throws(() => planNativeCommands({ overlays: handle, runtime, profile }), /trust approval/);
  const syntheticTrustApproval = { bindingHash: prepared.bindingHash, approved: true,
    reviewType: 'human', reviewer: 'synthetic-test-only', reviewedAt: '2026-10-07T18:00:00Z' };
  assert.equal(NATIVE_EXECUTION.supported, false);
  assert.equal(NATIVE_EXECUTION.reason, 'native evaluator may use AI grading; deterministic delivery preflight only');
  assert.throws(() => planNativeCommands({ overlays: handle, runtime, profile, trustApproval: syntheticTrustApproval }),
    /Native execution unsupported: native evaluator may use AI grading; deterministic delivery preflight only/);
  assert.throws(() => planNativeCommands({ overlays: handle, runtime,
    profile: { ...profile, model: 'claude-opus-4-6' }, trustApproval: syntheticTrustApproval }), /trust approval/);
  assert.throws(() => planNativeCommands({ overlays: pair(t), runtime, profile,
    trustApproval: syntheticTrustApproval }), /trust approval/);
  assert.throws(() => prepareNativeReview({ overlays: handle, runtime: { ...runtime }, profile }), /offline pinned/);
});

test('profiles reject old AI judges live URLs/gateways real MCP unknown settings and aliases', t => {
  const handle = pair(t);
  for (const invalid of [
    { ...profile, model: 'sonnet' }, { ...profile, model: 'https://example.invalid' },
    { ...profile, mockMode: 'off' }, { ...profile, provider: 'gateway' },
    { ...profile, provider: 'operator-approved-direct' },
    { ...profile, judgeModel: 'claude-haiku-4-5-20251001' },
    { ...profile, judge: { model: 'claude-haiku-4-5-20251001' } },
    { ...profile, criteria: ['helpful'] }, { ...profile, expectedScore: 1 },
    { ...profile, mcpServers: {} }, { ...profile, limits: { repeats: 1 } }
  ]) {
    assert.throws(() => prepareNativeReview({ overlays: handle, runtime, profile: invalid }));
    assert.throws(() => planNativeCommands({ overlays: handle, runtime, profile: invalid,
      trustApproval: { approved: true } }));
  }
});

test('valid trust and caller-supplied execution switches cannot escape deterministic-only preflight', t => {
  const handle = pair(t);
  const prepared = prepareNativeReview({ overlays: handle, runtime, profile });
  const trustApproval = { bindingHash: prepared.bindingHash, approved: true,
    reviewType: 'human', reviewer: 'synthetic-test-only', reviewedAt: '2026-10-07T18:00:00Z' };
  assert.ok(Object.isFrozen(NATIVE_EXECUTION));
  assert.throws(() => { NATIVE_EXECUTION.supported = true; }, TypeError);
  for (const extra of [
    {}, { deterministicOnly: true }, { execute: true, allowAiGrading: true },
    { args: ['--trust-plugin', '--judge-model', 'claude-haiku-4-5-20251001'] },
    { graderTypes: ['regex', 'tool_used'], commands: [] }
  ]) {
    assert.throws(() => planNativeCommands({ overlays: handle, runtime, profile, trustApproval, ...extra }),
      /Native execution unsupported: native evaluator may use AI grading; deterministic delivery preflight only/);
  }
  assert.equal(verifyNativeOverlays(handle), true);
});

test('native suite rejects AI criteria score expectations shell scaffolds agent mocks and traversal', t => {
  const directory = copiedSuite(t);
  const filename = path.join(directory, 'text-discovery', 'case.yaml');
  const original = fs.readFileSync(filename);
  const document = JSON.parse(original);
  for (const mutation of [
    { ...document, context: { scaffold_script: 'setup.sh' } },
    { ...document, execution: { ...document.execution, max_turns: 200 } },
    { ...document, execution: { ...document.execution, allowed_tools: ['Bash'] } },
    { ...document, criteria: ['usefulness'] },
    { ...document, rubric: [{ criterion: 'helpfulness', weight: 1 }] },
    { ...document, expectedScore: 1 },
    { ...document, graders: document.graders.map(g => ({ ...g, type: 'unknown' })) },
    { ...document, graders: document.graders.map(g => ({ ...g, type: 'llm', criteria: 'helpful' })) },
    { ...document, graders: document.graders.map(g => ({ ...g, type: 'rubric', criteria: ['correct'] })) },
    { ...document, graders: document.graders.map(g => ({ ...g, type: 'regex', criteria: ['correct'] })) }
  ]) {
    fs.writeFileSync(filename, JSON.stringify(mutation));
    assert.throws(() => loadNativeSuite({ directory }));
  }
  fs.writeFileSync(filename, original);
  assert.equal(JSON.parse(original).schema_version, '1.1');
  const suiteFile = path.join(directory, 'suite.json');
  const suiteBytes = fs.readFileSync(suiteFile);
  const suite = JSON.parse(suiteBytes);
  for (const mutation of [
    { ...suite, judgeModel: 'claude-haiku-4-5-20251001' },
    { ...suite, criteria: ['helpful'] },
    { ...suite, profile: { ...profile, judgeModel: 'claude-haiku-4-5-20251001' } },
    { ...suite, quality: { expectedScore: 1 } }
  ]) {
    fs.writeFileSync(suiteFile, JSON.stringify(mutation));
    assert.throws(() => loadNativeSuite({ directory }), /suite fields/);
  }
  fs.writeFileSync(suiteFile, suiteBytes);
  const mock = path.join(directory, 'mocks', 'native-text-fixture', 'explain.md');
  fs.writeFileSync(mock, '---\ntype: agent\n---\nContact https://example.invalid');
  assert.throws(() => loadNativeSuite({ directory }), /mock definition/);
  assert.throws(() => loadNativeSuite({ directory: path.join(directory, '..', 'absent') }));
});

test('native suite and ownership guard reject symlinks and forged cleanup handles', t => {
  const handle = pair(t);
  assert.throws(() => cleanupNativeOverlays({ ...handle }), /exact owned/);
  assert.throws(() => verifyNativeOverlays({ ...handle }), /owned/);
  const directory = copiedSuite(t);
  const link = path.join(directory, 'linked-case');
  fs.symlinkSync(path.join(directory, 'text-discovery'), link, 'junction');
  assert.throws(() => loadNativeSuite({ directory }), /symlink/i);
  fs.unlinkSync(link);
});

test('honest synthetic native documents are universally blocked: no guessed successful parser', () => {
  assert.equal(NATIVE_NORMALIZATION.supported, false);
  // Synthetic examples of documented summary fields, NOT captured native output.
  for (const synthetic of [
    { schemaVersion: 1, partial: false, aggregates: { overallScore: 1 }, cases: [] },
    { schemaVersion: 1, partial: true, partialReason: 'cost_ceiling' },
    { schemaVersion: 99, cases: [{ arms: { with: [{ error: null, aborted: null, skippedPaidGraders: false }] } }] },
    { schemaVersion: 1, cases: [{ arms: { with: [{ error: 'timeout', score: 1 }] } }] }
  ]) assert.throws(() => normalizeNativeResult(synthetic), /normalization unsupported/);
});
