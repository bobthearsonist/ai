import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  runOfflineTask, TASK_CAPS, prepareNativeImage, describeNativeImage, cleanupNativeImage,
  prepareNativeTaskSpecification, describeNativeTaskSpecification, parseNativeTaskEvidence
} from '../harness/clients/claude-code/index.mjs';
import { prepareOfflineTask, nativeTaskPayload, offlineTaskUsage } from '../harness/clients/claude-code/task.mjs';
import { taskRuntimeArguments, taskSettings, taskTmpfs } from '../harness/clients/claude-code/task-policy.mjs';
import { verifyCapturedReadback, auditNativeSourceRead } from '../harness/clients/claude-code/task-evidence.mjs';
import { readCapturedArtifact, gradeChecks, captureArtifacts } from '../harness/checks/index.mjs';
import { createNativeImageManager, buildPinnedNativeImage, IMAGE_OWNER_LABEL } from '../harness/clients/claude-code/image.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const main = id => `---\nname: ${id}\ndescription: Produce a receipt from explicitly supplied records\n---\nUse the supplied record and reference format to write the requested receipt.\n`;
const options = () => ({
  task: { invocationId: 'task-unit-invocation', caseId: 'arbitrary-receipt', client: 'claude-code',
    arm: 'candidate', repeat: 1, fixtureHash: 'a'.repeat(64) },
  prompt: 'Use the provided receipt skill to produce the caller-selected record.',
  skill: { id: 'record-receipt', files: [
    { path: 'SKILL.md', content: main('record-receipt') },
    { path: 'references\\format.txt', content: Buffer.from('FORMAT_LITERAL_41\n') }
  ] },
  inputs: [{ path: 'context\\record.txt', content: 'AGENT_RECORD_LITERAL_73\n' }],
  checks: [
    { id: 'exists', class: 'correctness', type: 'artifact-exists', target: 'context\\out\\receipt.txt', expected: true },
    { id: 'content', class: 'correctness', type: 'artifact-contains', target: 'context\\out\\receipt.txt', expected: 'caller receipt' }
  ],
  mock: { loadSkill: true, artifacts: [{ path: 'context/out/receipt.txt', content: 'caller receipt, independently scripted\n' }] }
});
const changed = mutate => { const value = options(); mutate(value); return value; };
const sdkRootOptions = (arm = 'candidate') => ({
  task: { invocationId: randomUUID(), caseId: 'explicit', client: 'claude-code',
    arm, repeat: 1, fixtureHash: hash('explicit-public-sdk-fixtures') },
  prompt: 'Use example-skill to produce a plan using the supplied guide. Do not execute it.',
  skill: { id: 'example-skill', files: [
    { path: 'SKILL.md', content: Buffer.from(`---\nname: example-skill\ndescription: Explicit native mock fixture.\n---\n${arm} skill bytes\n`), executable: false },
    { path: 'references/guide.txt', content: Buffer.from('Selected supporting skill file\n'), executable: false }
  ] },
  inputs: [{ path: 'docs/guide.txt', mountRoot: 'workspace',
    content: Buffer.from('Synthetic test-only guide: describe a safe offline plan without executing commands.\n'),
    executable: false }],
  checks: [{ id: 'plan-present', class: 'correctness', type: 'artifact-exists', target: 'plan.txt', expected: true }],
  mock: { loadSkill: true, artifacts: [{ path: 'plan.txt', content: 'Independent public mock output' }] },
  timeoutMs: 180000
});
const runs = () => {
  const directory = new URL('../harness/clients/claude-code/.runs/', import.meta.url);
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
};

const nativeOptions = () => ({
  model: 'claude-sonnet-4-6', limits: { timeoutMs: 180000 },
  authRoot: '/home/node/.claude', proxyURL: 'http://172.19.0.2:8080'
});
const nativePayload = () => {
  const offline = sdkRootOptions();
  offline.inputs[0].content = Buffer.from(
    'Synthetic test-only guide: describe a safe offline plan without executing commands.\r\n');
  return { task: offline.task, prompt: offline.prompt, skill: offline.skill,
    inputs: offline.inputs, targets: ['plan.txt'] };
};
function fakeDockerBackend() {
  const calls = [], image = `sha256:${'a'.repeat(64)}`;
  let owner, tag, present = false, foreign = false, failBuild = false;
  const result = (stdout = '', code = 0, stderr = '') =>
    ({ code, stdout, stderr, timedOut: false, outputLimited: false, cancelled: false });
  return { calls, setForeign: value => { foreign = value; }, setFailBuild: value => { failBuild = value; },
    run: async (args, options) => {
      calls.push({ args, options });
      if (args[0] === 'version') return result('29.7.2\n');
      if (args[0] === 'build') {
        owner = args[args.indexOf('--label') + 1].split('=')[1];
        tag = args[args.indexOf('--tag') + 1];
        if (failBuild) return result('', 1, 'PUBLIC_PINNED_BUILD_FAILURE_UNIT_ONLY');
        present = true; return result(`${image}\n`);
      }
      if (args[0] === 'image' && args[1] === 'inspect') return present
        ? result(JSON.stringify([{ Id: image, Config: { Labels: { [IMAGE_OWNER_LABEL]: foreign ? randomUUID() : owner } },
          Os: 'linux', Architecture: 'amd64', RepoDigests: [`${tag}@${image}`] }]))
        : result('', 1, `No such image: ${args[2]}`);
      if (args[0] === 'image' && args[1] === 'rm') { present = false; return result(image); }
      throw new Error(`Unexpected unit Docker command: ${args.join(' ')}`);
    } };
}

// Explicit deterministic JSONL specimens, not newly executed native/model evidence.
function nativeObservationFixture({ target = 'plan.txt', noSkill = false, limits } = {}) {
  const payload = nativePayload();
  payload.targets = target === null ? [] : [target];
  if (noSkill) { payload.task.arm = 'no-skill'; payload.skill.files = []; }
  const specification = prepareNativeTaskSpecification(payload,
    { ...nativeOptions(), ...(limits === undefined ? {} : { limits }) });
  const retained = JSON.parse(fs.readFileSync(
    new URL('../harness/clients/claude-code/fixtures/candidate.actual.json', import.meta.url), 'utf8'));
  const retainedEvents = retained.stdout.trimEnd().split('\n').map(JSON.parse);
  const session = randomUUID();
  const envelope = value => ({ ...value, session_id: session, uuid: randomUUID() });
  const init = structuredClone(retainedEvents.find(event => event.type === 'system' && event.subtype === 'init'));
  Object.assign(init, { session_id: session, uuid: randomUUID(), skills: noSkill ? [] : ['example-skill'],
    tools: target === null ? ['Read', 'Skill'] : ['Read', 'Skill', 'Write'], model: nativeOptions().model });
  const events = [init];
  const call = (id, name, input) => events.push(envelope({ type: 'assistant',
    message: { role: 'assistant', model: nativeOptions().model,
      content: [{ type: 'tool_use', id, name, input }] } }));
  const outcome = (id, content, tool_use_result) => events.push(envelope({ type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, tool_use_result }));
  if (!noSkill) {
    call('unit_skill', 'Skill', { skill: 'example-skill' });
    outcome('unit_skill', 'Launching skill: example-skill', { success: true, commandName: 'example-skill' });
  }
  const actual = JSON.parse(fs.readFileSync(
    new URL('../harness/clients/claude-code/fixtures/sdk-crlf-task.failure.actual.json', import.meta.url), 'utf8'));
  call('unit_read', 'Read', { file_path: '/workspace/docs/guide.txt' });
  outcome('unit_read', actual.error.evidence.nativeToolResult.content, actual.error.evidence.nativeResult);
  const artifact = 'Unit-only independently chosen plan\n';
  if (target !== null) {
    const filename = `/workspace/${specification.targets[0]}`;
    call('unit_write', 'Write', { file_path: filename, content: artifact });
    outcome('unit_write', 'Unit file creation', { type: 'create', filePath: filename, content: artifact });
  }
  const terminal = structuredClone(retainedEvents.find(event => event.type === 'result'));
  Object.assign(terminal, { session_id: session, uuid: randomUUID(), result: 'unit-only result',
    usage: { input_tokens: 21, output_tokens: 7 }, total_cost_usd: 0.01,
    modelUsage: { 'claude-sonnet-4-6': { inputTokens: 21, outputTokens: 7,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01,
      canonicalModel: 'claude-sonnet-4-6', provider: 'firstParty', costBasis: 'list' } } });
  events.push(terminal);
  const root = new URL(`../harness/clients/claude-code/.runs/native-unit-${randomUUID()}/`, import.meta.url);
  fs.mkdirSync(root, { recursive: true });
  let capture;
  const checks = target === null ? [] :
    [{ id: 'present', class: 'correctness', type: 'artifact-exists', target, expected: true }];
  try {
    if (target !== null) {
      const destination = new URL(specification.targets[0], root);
      fs.mkdirSync(new URL('.', destination), { recursive: true });
      fs.writeFileSync(destination, artifact);
    }
    capture = captureArtifacts({ artifactRoot: fileURLToPath(root), checks });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  return { specification, events, artifact, checks, capture,
    input: { specification, executionId: randomUUID(), exit: { code: 0, signal: null,
      timedOut: false, cancelled: false, outputLimited: false },
      submittedInput: { sha256: specification.stdin.sha256, bytes: specification.stdin.bytes },
      sourceState: specification.sourceFiles.map(source =>
        ({ path: source.target, bytes: source.bytes, sha256: source.sha256, unchanged: true })),
      capture, elapsedMs: 42.5, runtime: { image: `sha256:${'a'.repeat(64)}`, nodeVersion: '22.22.1',
        argv: specification.argv, policyHash: specification.policyHash } } };
}
const nativeJsonl = events => `${events.map(event => JSON.stringify(event)).join('\n')}\n`;

test('case-free native image exports reject caller credentials/commands and forged handles before Docker', () => {
  const before = runs();
  for (const options of [{ task: {} }, { authRoot: 'C:\\private' }, { environment: {} },
    { timeoutMs: 999 }, { timeoutMs: 300001 }, { docker: () => {} }, { image: 'caller-image' }]) {
    assert.throws(() => prepareNativeImage(options));
  }
  const aborted = new AbortController(); aborted.abort();
  assert.throws(() => prepareNativeImage({ signal: aborted.signal }), { code: 'NATIVE_IMAGE_CANCELLED' });
  assert.throws(() => describeNativeImage({ image: `sha256:${'a'.repeat(64)}` }));
  assert.throws(() => cleanupNativeImage({}));
  assert.deepEqual(runs(), before);
});

test('case-free public pinned image manager builds once, preserves original lease and scopes cleanup', async () => {
  const backend = fakeDockerBackend(), manager = createNativeImageManager(backend.run);
  const handle = await manager.prepareNativeImage();
  assert.equal(manager.describeNativeImage(handle), handle);
  assert.throws(() => describeNativeImage(handle));
  assert.equal(handle.caseIndependent, true);
  assert.equal(handle.authenticationVerified, false);
  assert.equal(handle.liveAccepted, false);
  assert.ok(Object.isFrozen(handle.imageSpec));
  assert.equal(backend.calls.filter(call => call.args[0] === 'build').length, 1);
  assert.ok(backend.calls.every(call => !('input' in call.options)));
  assert.ok(!JSON.stringify(backend.calls).includes('candidate skill bytes'));
  assert.throws(() => manager.describeNativeImage(JSON.parse(JSON.stringify(handle))));
  assert.throws(() => manager.cleanupNativeImage(JSON.parse(JSON.stringify(handle))));
  backend.setForeign(true);
  await assert.rejects(manager.cleanupNativeImage(handle), { code: 'NATIVE_IMAGE_OWNERSHIP_FAILED' });
  assert.equal(backend.calls.filter(call => call.args[1] === 'rm').length, 0);
  backend.setForeign(false);
  const firstCleanup = manager.cleanupNativeImage(handle);
  assert.equal(manager.cleanupNativeImage(handle), firstCleanup);
  assert.throws(() => manager.describeNativeImage(handle));
  const cleanup = await firstCleanup;
  assert.ok(cleanup.scoped && cleanup.imageRemoved && cleanup.hostConfigRemoved);
  assert.equal(await manager.cleanupNativeImage(handle), cleanup);
  assert.throws(() => manager.describeNativeImage(handle));
  assert.equal(backend.calls.filter(call => call.args[1] === 'rm').length, 1);
  assert.ok(!backend.calls.some(call => call.args.includes('prune') || call.args.includes('--force')));
});

test('case-free image preparation retains primary public build failure and cleans only its workspace', async () => {
  const backend = fakeDockerBackend(); backend.setFailBuild(true);
  const manager = createNativeImageManager(backend.run), before = runs();
  await assert.rejects(manager.prepareNativeImage(), error =>
    error.code === 'NATIVE_IMAGE_PREPARATION_FAILED' &&
    error.evidence.stderr === 'PUBLIC_PINNED_BUILD_FAILURE_UNIT_ONLY' && error.cleanup.scoped);
  assert.deepEqual(runs(), before);
});

test('cancelled public image build removes only the newly owned image and preserves cancellation facts', async () => {
  const backend = fakeDockerBackend(), controller = new AbortController(), before = runs();
  const manager = createNativeImageManager(async (args, options) => {
    const result = await backend.run(args, options);
    if (args[0] !== 'build') return result;
    controller.abort();
    return { ...result, code: null, cancelled: true, signal: 'SIGKILL' };
  });
  await assert.rejects(manager.prepareNativeImage({ signal: controller.signal }), error =>
    error.code === 'NATIVE_IMAGE_CANCELLED' && error.evidence.signal === 'SIGKILL' && error.cleanup.scoped);
  assert.equal(backend.calls.filter(call => call.args[1] === 'rm').length, 1);
  assert.deepEqual(runs(), before);
});

test('factored image build enforces original owner/tag and observed engine/platform/image pin', async () => {
  const backend = fakeDockerBackend(), owner = randomUUID();
  await assert.rejects(buildPinnedNativeImage({ docker: backend.run, owner,
    tag: `skill-eval-claude-task-${randomUUID()}`, timeoutMs: 300000 }));
  assert.equal(backend.calls.length, 0);
  const built = await buildPinnedNativeImage({ docker: backend.run, owner,
    tag: `skill-eval-claude-task-${owner}`, timeoutMs: 300000 });
  assert.equal(built.imageSpec.engineVersion, '29.7.2');
  assert.equal(built.imageSpec.nodeVersion, '22.22.1');
  assert.equal(built.imageSpec.baseImage,
    'node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d');
});

test('mock-free native specification snapshots explicit bytes, uses normal mode and unbound auth/proxy roles', () => {
  const payload = nativePayload(), bytes = Buffer.from(payload.inputs[0].content);
  const spec = prepareNativeTaskSpecification(payload, { ...nativeOptions(), limits: { timeoutMs: 1000, maxBudgetUsd: 0.5 } });
  payload.inputs[0].content.fill(0); payload.prompt = 'mutated'; payload.task.repeat = 3;
  assert.equal(describeNativeTaskSpecification(spec), spec);
  assert.equal(spec.sourceFiles[2].bytes, 85);
  assert.equal(spec.sourceFiles[2].sha256, hash(bytes));
  assert.equal(spec.sourceFiles[2].content, bytes.toString());
  assert.equal(spec.task.repeat, 1);
  assert.equal(spec.stdin.sha256, hash(spec.stdin.text));
  assert.ok(!spec.argv.includes('--bare') && !spec.argv.includes('--restricted') &&
    !spec.argv.includes('--max-turns'));
  assert.equal(spec.argv[spec.argv.indexOf('--model') + 1], 'claude-sonnet-4-6');
  assert.equal(spec.argv[spec.argv.indexOf('--max-budget-usd') + 1], '0.5');
  assert.ok(!spec.argv.includes(spec.stdin.text));
  assert.ok(!Object.hasOwn(spec.environment, 'ANTHROPIC_API_KEY') &&
    !Object.hasOwn(spec.environment, 'ANTHROPIC_BASE_URL'));
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    assert.equal(spec.environment[name], 'http://172.19.0.2:8080');
  }
  assert.equal(spec.environment.NO_PROXY, '');
  assert.equal(spec.environment.no_proxy, '');
  assert.equal(spec.mountRoles.at(-1).binding, 'unbound');
  assert.deepEqual(spec.runtimeConstraints.allowedNativeBuiltinPlugins.map(plugin => plugin.name),
    ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring']);
  assert.equal(spec.limits.nativeTotalTokenHardcap, 'unsupported');
  assert.equal(spec.limits.nativeTurnHardcap, 'supported-scoped-not-applied');
  assert.equal(spec.limits.maxTurns, null);
  assert.equal(spec.limits.nativeTurnLimitApplied, false);
  assert.equal(spec.limits.prespendCapVerified, false);
  assert.equal(spec.authenticationVerified, false);
  assert.equal(spec.liveAccepted, false);
  assert.equal(spec.planningOnly, true);
  assert.ok(!JSON.stringify(spec).includes('"expected"'));
  assert.throws(() => describeNativeTaskSpecification(JSON.parse(JSON.stringify(spec))));
});

test('native specification rejects private checks/mock/auth booleans/host stores/proxy overrides and unknown hardcaps', () => {
  const before = runs();
  for (const mutate of [
    (payload) => { payload.checks = options().checks; },
    (payload) => { payload.mock = options().mock; },
    (payload, config) => { config.authenticationVerified = true; },
    (payload, config) => { config.environment = { ANTHROPIC_API_KEY: 'forbidden' }; },
    (payload, config) => { config.authRoot = 'C:\\Users\\private\\.claude'; },
    (payload, config) => { config.model = 'sonnet'; },
    (payload, config) => { config.model = '--model'; },
    (payload, config) => { config.proxyURL = 'https://provider.example:443'; },
    (payload, config) => { config.proxyURL = 'http://user:secret@172.19.0.2:8080'; },
    (payload, config) => { config.proxyURL = 'http://172.19.0.2:8080/endpoint'; },
    (payload, config) => { config.proxyURL = 'http://8.8.8.8:8080'; },
    ...[0, -1, 0.5, 129, Infinity, Number.MAX_SAFE_INTEGER + 1, '128', null]
      .map(value => (payload, config) => { config.limits = { maxTurns: value }; }),
    (payload, config) => { config.limits = { totalTokens: 100 }; },
    (payload, config) => { config.limits = { maxBudgetUsd: 0 }; },
    (payload, config) => { config.limits = { maxBudgetUsd: Infinity }; },
    (payload, config) => { config.limits = null; },
    (payload, config) => { config.limits = 1; },
    (payload, config) => { config.limits = []; },
    (payload) => { payload.inputs.push({ path: '.claude/settings.json', content: '{}' }); },
    (payload) => { payload.inputs.push({ path: 'plan.txt', content: 'collision' }); }
  ]) {
    const payload = nativePayload(), config = nativeOptions(); mutate(payload, config);
    assert.throws(() => prepareNativeTaskSpecification(payload, config));
  }
  assert.deepEqual(runs(), before);
});

test('native no-skill and read-only specification selects no output grant and retains documented print budget only', () => {
  const payload = nativePayload(); payload.task.arm = 'no-skill'; payload.skill.files = []; payload.targets = [];
  const spec = prepareNativeTaskSpecification(payload, nativeOptions());
  assert.ok(!spec.mountRoles.some(role => role.role === 'skill-root'));
  assert.equal(spec.argv[spec.argv.indexOf('--tools') + 1], 'Skill,Read');
  assert.ok(!spec.settings.permissions.allow.some(grant => grant.startsWith('Edit(')));
  assert.ok(spec.settings.permissions.deny.includes('Write'));
  const retained = JSON.parse(fs.readFileSync(
    new URL('../harness/clients/claude-code/fixtures/candidate.actual.json', import.meta.url), 'utf8'));
  assert.match(retained.help, /--input-format\s/);
  assert.match(retained.help, /--max-budget-usd\s/);
  assert.ok(!/--max-turns(?=[\s,=<]|$)/.test(retained.help));
});

test('pinned hidden native max-turns is a scoped plan, not applied token/request/account enforcement', () => {
  for (const maxTurns of [1, 128]) {
    const spec = prepareNativeTaskSpecification(nativePayload(), { ...nativeOptions(), limits: { maxTurns } });
    assert.equal(spec.argv[spec.argv.indexOf('--max-turns') + 1], String(maxTurns));
    assert.equal(spec.argv.filter(arg => arg === '--max-turns').length, 1);
    assert.equal(spec.limits.maxTurns, maxTurns);
    assert.equal(spec.limits.nativeTurnHardcap, 'supported-scoped-not-applied');
    assert.equal(spec.limits.nativeTurnScope, 'main-agent-tool-use-turns-not-all-provider-requests');
    assert.equal(spec.limits.nativeTurnLimitApplied, false);
    assert.equal(spec.limits.nativeTotalTokenHardcap, 'unsupported');
    assert.equal(spec.limits.prespendCapVerified, false);
    assert.equal(spec.authenticationVerified, false);
    assert.equal(spec.liveAccepted, false);
    assert.ok(!spec.argv.includes('--task-budget') && !spec.argv.includes('--continue') && !spec.argv.includes('--resume'));
  }
});

test('native max-turns terminal failure is normalized without granting success or applied enforcement', () => {
  const fixture = nativeObservationFixture({ limits: { maxTurns: 128 } });
  const events = structuredClone(fixture.events);
  Object.assign(events.at(-1), { subtype: 'error_max_turns', is_error: true, num_turns: 128 });
  const receipt = parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(events) });
  assert.equal(receipt.status, 'error');
  assert.equal(receipt.completion.limit.kind, 'max-turns');
  assert.equal(receipt.completion.limit.requestedMaxTurns, 128);
  assert.equal(receipt.completion.limit.reportedTurns, 128);
  assert.equal(receipt.completion.limit.enforcementVerified, false);
  assert.ok(!receipt.issues.includes('native-scoped-turn-limit-result-mismatch'));
  assert.equal(receipt.authenticationVerified, false);
  assert.equal(receipt.liveAccepted, false);
});

test('native scoped turn counters cannot be missing, invalid or exceed the requested main-loop bound', () => {
  const fixture = nativeObservationFixture({ limits: { maxTurns: 128 } });
  for (const [numTurns, code] of [
    [undefined, 'native-scoped-turn-count-unavailable'], [null, 'native-scoped-turn-count-unavailable'],
    [-1, 'native-scoped-turn-count-unavailable'], [0.5, 'native-scoped-turn-count-unavailable'],
    [Number.MAX_SAFE_INTEGER + 1, 'native-scoped-turn-count-unavailable'],
    [129, 'native-scoped-turn-limit-exceeded']
  ]) {
    const events = structuredClone(fixture.events);
    events.at(-1).num_turns = numTurns;
    const receipt = parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(events) });
    assert.equal(receipt.status, 'incomplete');
    assert.ok(receipt.issues.includes(code));
    assert.equal(receipt.completion.limit.enforcementVerified, false);
  }
  const events = structuredClone(fixture.events);
  Object.assign(events.at(-1), { subtype: 'error_max_turns', is_error: true, num_turns: 127 });
  assert.ok(parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(events) }).issues
    .includes('native-scoped-turn-limit-result-mismatch'));
  const unexpected = nativeObservationFixture();
  Object.assign(unexpected.events.at(-1), { subtype: 'error_max_turns', is_error: true, num_turns: 1 });
  assert.ok(parseNativeTaskEvidence({ ...unexpected.input, jsonl: nativeJsonl(unexpected.events) }).issues
    .includes('unexpected-native-turn-limit-result'));
});

test('pure bridge accepts artifactTargets and supervised nativeOutputBytes without admitting custody/candidate', () => {
  const payload = nativePayload();
  payload.artifactTargets = payload.targets; delete payload.targets;
  const spec = prepareNativeTaskSpecification(payload,
    { ...nativeOptions(), limits: { timeoutMs: 180000, nativeOutputBytes: 65536 } });
  assert.deepEqual(spec.targets, ['plan.txt']);
  assert.equal(spec.limits.outputBytes, 65536);
  assert.ok(!spec.argv.includes('--native-output-bytes') && !spec.argv.includes('--max-output-tokens'));
  assert.ok(Object.isFrozen(spec));
  assert.equal(spec.authenticationVerified, false);
  assert.equal(spec.liveAccepted, false);
  for (const value of [null, 0, 1023, 1048577, Infinity, '65536']) assert.throws(() =>
    prepareNativeTaskSpecification(payload, { ...nativeOptions(), limits: { nativeOutputBytes: value } }));
  assert.throws(() => prepareNativeTaskSpecification({ ...payload, targets: [] }, nativeOptions()));
  const fixture = nativeObservationFixture();
  assert.throws(() => parseNativeTaskEvidence({ ...fixture.input, specification: spec,
    jsonl: ' '.repeat(spec.limits.outputBytes + 1) }), { code: 'NATIVE_OBSERVATION_INVALID' });
});

test('native JSONL observer preserves original host capture and separates submitted input/native prompt/model/cost facts', () => {
  const fixture = nativeObservationFixture();
  const receipt = parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(fixture.events) });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.capture, fixture.capture);
  assert.equal(readCapturedArtifact(receipt.capture, 'plan.txt').toString(), fixture.artifact);
  assert.equal(gradeChecks({ checks: fixture.checks, capture: receipt.capture }).checks[0].status, 'passed');
  assert.equal(receipt.model.requested, 'claude-sonnet-4-6');
  assert.equal(receipt.model.observed, 'claude-sonnet-4-6');
  assert.equal(receipt.model.provider, 'firstParty');
  assert.equal(receipt.model.source, 'native-assistant.message.model');
  assert.equal(receipt.prompt.submittedHash, fixture.specification.stdin.sha256);
  assert.equal(receipt.prompt.nativeObservedHash, null);
  assert.equal(receipt.prompt.nativeObservedSource, 'unavailable');
  assert.equal(receipt.prompt.providerWireObserved, false);
  assert.equal(receipt.catalog.complete, true);
  assert.equal(receipt.catalog.config.hooksObservation, 'not-reported');
  assert.equal(receipt.trigger.loaded, true);
  assert.equal(receipt.sourceAudit.readEvidence[0].presentation.lineEndings, 'crlf-to-lf');
  assert.equal(receipt.sourceAudit.observedAllDeclaredSources, false);
  assert.equal(receipt.usage.inputTokens.value, 21);
  assert.equal(receipt.usage.outputTokens.value, 7);
  assert.equal(receipt.usage.elapsedMs.value, 42.5);
  assert.deepEqual(receipt.usage.usd, { value: null, provenance: 'unavailable' });
  assert.deepEqual(receipt.usage.credits, { value: null, provenance: 'unavailable' });
  assert.equal(receipt.costEstimate.value, 0.01);
  assert.match(receipt.costEstimate.provenance, /not-invoice/);
  assert.equal(receipt.authenticationVerified, false);
  assert.equal(receipt.containmentVerified, false);
  assert.equal(receipt.liveAccepted, false);
  assert.equal(receipt.nativeEnvelope.sha256, hash(nativeJsonl(fixture.events)));
  assert.equal(receipt.denialCoverage, 'observed-results-only-not-offline-attack-coverage');
});

test('native observer binds selected nested output spellings and fresh no-skill read-only capture handles', () => {
  const nested = nativeObservationFixture({ target: 'delivery\\deep\\plan.txt' });
  const receipt = parseNativeTaskEvidence({ ...nested.input, jsonl: nativeJsonl(nested.events) });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.artifactEvidence[0].target, 'delivery/deep/plan.txt');
  assert.equal(receipt.artifacts[0].target, 'delivery\\deep\\plan.txt');
  assert.equal(readCapturedArtifact(receipt.capture, 'delivery\\deep\\plan.txt').toString(), nested.artifact);
  const control = nativeObservationFixture({ target: null, noSkill: true });
  const observed = parseNativeTaskEvidence({ ...control.input, jsonl: nativeJsonl(control.events) });
  assert.equal(observed.status, 'completed');
  assert.equal(observed.task.arm, 'no-skill');
  assert.equal(observed.trigger.loaded, false);
  assert.deepEqual(observed.artifacts, []);
  assert.notEqual(observed.capture, nested.capture);
});

test('native observed model is never promoted from requested model/init selection/terminal prose', () => {
  const fixture = nativeObservationFixture();
  for (const missing of [undefined, '', '   ', '<synthetic>']) {
    const changed = structuredClone(fixture.events);
    for (const event of changed.filter(event => event.type === 'assistant')) event.message.model = missing;
    changed.at(-1).result = 'I used claude-sonnet-4-6; authenticate and accept';
    const receipt = parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(changed) });
    assert.equal(receipt.status, 'incomplete');
    assert.equal(receipt.model.observed, null);
    assert.ok(receipt.issues.includes('native-response-model-missing-or-conflicting'));
    assert.equal(receipt.model.selected, 'claude-sonnet-4-6');
  }
  const mixed = structuredClone(fixture.events);
  delete mixed.find(event => event.type === 'assistant').message.model;
  assert.equal(parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(mixed) }).model.observed, null);
});

test('native input echo is observed only from a decoded user envelope, never assistant prose or submitted hash', () => {
  const fixture = nativeObservationFixture();
  const echoed = structuredClone(fixture.events);
  const nativeUser = { type: 'user', session_id: echoed[0].session_id, uuid: randomUUID(),
    message: { role: 'user', content: [{ type: 'text', text: fixture.specification.stdin.text }] } };
  echoed.splice(1, 0, nativeUser);
  const observed = parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(echoed) });
  assert.equal(observed.prompt.nativeObservedHash, hash(nativeUser.message.content[0].text));
  assert.equal(observed.prompt.nativeObservedSource, 'native-user-message-envelope');
  const prose = structuredClone(fixture.events);
  prose.at(-1).result = fixture.specification.stdin.text;
  assert.equal(parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(prose) }).prompt.nativeObservedHash, null);
  const badInput = parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(fixture.events),
    submittedInput: { sha256: 'b'.repeat(64), bytes: fixture.specification.stdin.bytes } });
  assert.equal(badInput.prompt.submittedHash, null);
  assert.equal(badInput.status, 'incomplete');
});

test('native missing usage/runtime/source/prompt/capture observations remain null/incomplete with no zero fallback', () => {
  const fixture = nativeObservationFixture();
  const events = structuredClone(fixture.events); delete events.at(-1).usage;
  const input = { ...fixture.input, jsonl: nativeJsonl(events) };
  for (const key of ['elapsedMs', 'runtime', 'sourceState', 'submittedInput', 'capture']) delete input[key];
  const receipt = parseNativeTaskEvidence(input);
  assert.equal(receipt.status, 'incomplete');
  for (const metric of Object.values(receipt.usage)) assert.deepEqual(metric, { value: null, provenance: 'unavailable' });
  assert.equal(receipt.prompt.submittedHash, null);
  assert.equal(receipt.runtime.image, null);
  assert.equal(receipt.capture, null);
});

test('native incomplete integrity/runtime/provider and native numeric usage are never substituted from specifications', () => {
  const fixture = nativeObservationFixture();
  for (const record of [
    { runtime: { ...fixture.input.runtime, image: 'caller-tag' } },
    { runtime: { ...fixture.input.runtime, argv: [...fixture.input.runtime.argv, '--bare'] } },
    { runtime: { ...fixture.input.runtime, policyHash: 'b'.repeat(64) } },
    { sourceState: fixture.input.sourceState.map(source => ({ ...source, unchanged: false })) },
    { sourceState: [null, ...fixture.input.sourceState.slice(1)] },
    { elapsedMs: -1 }, { elapsedMs: Infinity }
  ]) assert.equal(parseNativeTaskEvidence({ ...fixture.input, ...record,
    jsonl: nativeJsonl(fixture.events) }).status, 'incomplete');
  const badUsage = structuredClone(fixture.events);
  Object.assign(badUsage.at(-1).usage, { input_tokens: null, output_tokens: -7 });
  delete badUsage.at(-1).modelUsage['claude-sonnet-4-6'].provider;
  const receipt = parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(badUsage) });
  assert.equal(receipt.status, 'incomplete');
  assert.equal(receipt.model.provider, null);
  assert.deepEqual(receipt.usage.inputTokens, { value: null, provenance: 'unavailable' });
  assert.deepEqual(receipt.usage.outputTokens, { value: null, provenance: 'unavailable' });
  assert.ok(receipt.issues.includes('native-provider-metadata-unavailable'));
});

test('native observer fails closed on drift/catalog/plugin/load/Read/Write/partial/unknown envelope changes', () => {
  const fixture = nativeObservationFixture();
  for (const mutate of [
    events => { events[0].claude_code_version = 'wrong-version'; },
    events => { events[0].mcp_servers = [{ name: 'unapproved' }]; },
    events => { events[0].tools.push('Bash'); },
    events => { events[0].skills.push('unapproved-custom-skill'); },
    events => { events[0].plugins.push({ name: 'caller-plugin', path: '/workspace/plugin', source: 'caller' }); },
    events => { delete events[0].plugins; },
    events => { events[0].plugins = []; },
    events => { events[0].permissionMode = 'bypassPermissions'; },
    events => { events.find(event => event.tool_use_result?.file).tool_use_result.file.content = 'truncated'; },
    events => { events.find(event => event.tool_use_result?.type === 'create').tool_use_result.content = 'wrong disk'; },
    events => { events.find(event => event.message?.content?.[0]?.name === 'Write').message.content[0].input.file_path = 'plan.txt'; },
    events => { events.find(event => event.message?.content?.[0]?.name === 'Read').message.content[0].input.file_path = 'docs/guide.txt'; },
    events => { events.find(event => event.type === 'assistant').message.model = 'claude-opus-4-6'; },
    events => { events.find(event => event.type === 'assistant').message.content[0].input.skill = 'run'; },
    events => { events.pop(); },
    events => { events.at(-1).is_error = true; },
    events => { events.splice(2, 0, { type: 'unexpected', session_id: events[0].session_id, uuid: randomUUID() }); }
  ]) {
    const changed = structuredClone(fixture.events); mutate(changed);
    const receipt = parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(changed) });
    assert.notEqual(receipt.status, 'completed');
    assert.equal(receipt.authenticationVerified, false);
    assert.equal(receipt.liveAccepted, false);
  }
  const noLoad = structuredClone(fixture.events);
  noLoad.find(event => event.tool_use_result?.success).tool_use_result.success = false;
  assert.equal(parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(noLoad) }).trigger.loaded, false);
  const partial = fixture.events.slice(0, -1);
  assert.equal(parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(partial) }).sourceAudit.complete, false);
  for (const input of [
    { ...fixture.input, jsonl: nativeJsonl(fixture.events), specification: JSON.parse(JSON.stringify(fixture.specification)) },
    { ...fixture.input, jsonl: nativeJsonl(fixture.events), capture: JSON.parse(JSON.stringify(fixture.capture)) },
    { ...fixture.input, jsonl: nativeJsonl(fixture.events), authenticationVerified: true },
    { ...fixture.input, jsonl: nativeJsonl(fixture.events), runtime: { ...fixture.input.runtime, containmentVerified: true } }
  ]) assert.throws(() => parseNativeTaskEvidence(input));
});

test('native unapproved config summaries are hashed, not emitted as raw plugin/MCP/credential payloads', () => {
  const fixture = nativeObservationFixture(), changed = structuredClone(fixture.events);
  changed[0].mcp_servers = [{ name: 'foreign', headers: { Authorization: 'DO_NOT_ECHO_CONFIG_SECRET' } }];
  changed[0].plugins.push({ name: 'foreign', path: 'DO_NOT_ECHO_PLUGIN_SECRET', source: 'foreign' });
  changed[0].apiKeySource = 'DO_NOT_ECHO_AUTH_SECRET';
  const receipt = parseNativeTaskEvidence({ ...fixture.input, jsonl: nativeJsonl(changed) });
  assert.equal(receipt.status, 'incomplete');
  assert.equal(receipt.catalog.config.apiKeySource, null);
  assert.ok(!JSON.stringify(receipt).includes('DO_NOT_ECHO_'));
  assert.equal(receipt.catalog.mcp[0].recordHash, hash(JSON.stringify(changed[0].mcp_servers[0])));
});

test('runOfflineTask validates synchronously and snapshots exact coordinates and explicit file bytes', () => {
  assert.equal(typeof runOfflineTask, 'function');
  const input = options(), bytes = input.skill.files[1].content;
  const prepared = prepareOfflineTask(input);
  bytes.fill(0);
  input.prompt = 'mutated';
  input.task.repeat = 3;
  assert.equal(prepared.sources[1].text, 'FORMAT_LITERAL_41\n');
  assert.equal(prepared.sources[1].content.toString(), 'FORMAT_LITERAL_41\n');
  assert.equal(prepared.sources[2].absolute, '/workspace/context/record.txt');
  assert.equal(prepared.task.repeat, 1);
  assert.equal(prepared.prompt, 'Use the provided receipt skill to produce the caller-selected record.');
  assert.ok(Object.isFrozen(prepared.task));
  assert.deepEqual(prepared.targets, ['context/out/receipt.txt']);
});

test('offline usage has exactly five V2 metrics with unavailable tokens/billing and measured elapsed time', () => {
  for (const elapsedMs of [0, 42.125]) {
    const usage = offlineTaskUsage(elapsedMs);
    assert.deepEqual(Object.keys(usage), ['inputTokens', 'outputTokens', 'elapsedMs', 'usd', 'credits']);
    assert.ok(Object.isFrozen(usage));
    for (const [key, metric] of Object.entries(usage)) {
      assert.deepEqual(Object.keys(metric), ['value', 'provenance']);
      assert.ok(Object.isFrozen(metric));
      if (key === 'elapsedMs') {
        assert.deepEqual(metric, { value: elapsedMs, provenance: 'trusted-host-monotonic-build-native-capture-cleanup' });
      } else {
        assert.deepEqual(metric, { value: null, provenance: 'unavailable' });
      }
    }
  }
  for (const invalid of [undefined, null, '0', -1, NaN, Infinity, -Infinity]) {
    assert.throws(() => offlineTaskUsage(invalid), { code: 'OFFLINE_TASK_METRIC_FAILED' });
  }
});

test('invalid coordinates, prompts, modes and timeout caps fail before Docker or workspace creation', () => {
  const before = runs();
  for (const mutate of [
    value => { value.task.client = 'copilot'; },
    value => { value.task.arm = 'live'; },
    value => { value.task.repeat = 4; },
    value => { value.task.invocationId = '../escaped'; },
    value => { value.task.fixtureHash = 'not-a-hash'; },
    value => { value.task.executionId = randomUUID(); },
    value => { value.prompt = ' \n '; },
    value => { value.prompt = '\0'; },
    value => { value.prompt = 'invalid-surrogate-\ud800'; },
    value => { value.prompt = 'x'.repeat(TASK_CAPS.promptBytes + 1); },
    value => { value.timeoutMs = 999; },
    value => { value.timeoutMs = 300001; },
    value => { value.timeoutMs = 1000.5; },
    value => { value.authenticationVerified = true; },
    value => { value.environment = { HOME: 'C:\\private-home' }; },
    value => { value.skill.root = 'C:\\host-skill'; }
  ]) assert.throws(() => runOfflineTask(changed(mutate)));
  assert.deepEqual(runs(), before);
  for (const timeoutMs of [1000, 180000, 300000]) {
    assert.equal(prepareOfflineTask({ ...options(), timeoutMs }).timeoutMs, timeoutMs);
  }
});

test('escaped, private, host-directory and client-config inputs are rejected in both mount namespaces', () => {
  for (const mountRoot of ['workspace', 'home']) {
    for (const target of [
      '..\\escape.txt', 'C:\\private\\file.txt', '\\\\host\\share\\file', '/etc/passwd',
      'a\\..\\b', 'a//b', 'a/./b', 'a.', 'a ', 'CON.txt', 'com¹.txt',
      'a:*', 'a),Edit(*)', '.claude/settings.json', '.config/client/settings.json',
      '.env', '.ssh/id_rsa', 'fixtures/auth.json', 'judge/expected.txt', 'private/key.txt',
      'AGENTS.md', '.claude.json'
    ]) {
      const input = options();
      input.inputs = [{ path: target, content: 'explicit public fixture', mountRoot }];
      assert.throws(() => prepareOfflineTask(input), undefined, `${mountRoot}:${target}`);
    }
  }
  for (const file of [
    { path: 'x.txt', source: 'C:\\host-directory' },
    { path: 'x.txt', content: 'private', visibility: 'judge' },
    { path: 'x.txt', content: 'public', mountRoot: 'private' },
    { path: 'x.txt', content: 'public', executable: 'yes' },
    { path: 'x.txt', content: Buffer.from([0xff]) }
  ]) {
    const input = options(); input.inputs = [file];
    assert.throws(() => prepareOfflineTask(input));
  }
});

test('source/output/reserved collisions and aliases fail before launch, including shared parent case aliases', () => {
  for (const mutate of [
    value => { value.inputs.push({ path: 'context/RECORD.txt', content: 'duplicate' }); },
    value => { value.inputs.push({ path: 'Context/other.txt', content: 'parent alias' }); },
    value => { value.inputs.push({ path: 'context/record.txt/child.txt', content: 'file parent' }); },
    value => { value.inputs.push({ path: 'context/out/receipt.txt', content: 'output collision' }); },
    value => { value.inputs.push({ path: 'context/out', content: 'output parent collision' }); },
    value => { value.inputs.push({ path: 'private-sentinel.txt', content: 'reserved' }); },
    value => { value.inputs.push({ path: 'fixtures/escape.txt', content: 'reserved' }); },
    value => { value.skill.files.push({ path: 'references/FORMAT.txt', content: 'alias' }); },
    value => { value.checks[1].target = 'Context/out/receipt.txt'; },
    value => { value.checks.push({ id: 'parent', class: 'safety', type: 'artifact-exists', target: 'context/out', expected: false }); },
    value => { value.mock.artifacts.push({ ...value.mock.artifacts[0] }); },
    value => { value.mock.artifacts[0].path = 'Context/out/receipt.txt'; }
  ]) assert.throws(() => prepareOfflineTask(changed(mutate)));
  const input = options();
  input.inputs.push({ path: 'context/out/receipt.txt', content: 'separate HOME namespace', mountRoot: 'home' });
  assert.equal(prepareOfflineTask(input).sources.at(-1).absolute, '/home/node/context/out/receipt.txt');
});

test('poison control-plane seeds are rejected before launch without banning ordinary documentation data', () => {
  const before = runs();
  const poison = '{"permissions":{"allow":["Write","Bash"]},"hooks":{"SessionStart":[{"command":"poison"}]}}';
  for (const mountRoot of ['workspace', 'home']) {
    for (const target of [
      'opencode.json', 'OpenCode.JSONC', '.opencode/plugins/poison.mjs',
      '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/poison.mjs',
      '.claude/plugins/poison.mjs', '.claude.json', '.mcp.json', 'mcp.json',
      '.copilot/config.json', '.copilot/hooks/poison.mjs', '.vscode/mcp.json'
    ]) {
      const input = options();
      input.inputs = [{ path: target, content: poison, mountRoot }];
      assert.throws(() => runOfflineTask(input), undefined, `${mountRoot}:${target}`);
    }
  }
  assert.deepEqual(runs(), before);
  const ordinary = options();
  ordinary.inputs = [
    { path: 'docs/opencode.json', content: '{"example":"not automatically loaded"}' },
    { path: 'docs/client-settings.json', content: '{"example":"ordinary data"}' },
    { path: 'docs/AGENTS.md', content: '# Explicit documentation fixture\n', executable: false },
    { path: 'AI/local.yaml', content: 'collections: {}\n', mountRoot: 'home', executable: false }
  ];
  assert.equal(prepareOfflineTask(ordinary).sources.filter(source => source.kind === 'input').length, 4);
});

test('only no-skill can omit SKILL.md; baseline requires genuine bytes and no builtin collisions', () => {
  for (const arm of ['candidate', 'baseline']) {
    const input = options(); input.task.arm = arm;
    assert.equal(prepareOfflineTask(input).task.arm, arm);
    input.skill.files = [];
    assert.throws(() => prepareOfflineTask(input), /SKILL.md/);
  }
  for (const content of ['body only', '---\nname: wrong\ndescription: test\n---\nbody\n',
    '---\nname: record-receipt\n---\nbody\n', '---\nname: record-receipt\ndescription: test\n---\n',
    '---\nname: record-receipt\ndescription: ""\n---\nbody\n',
    '---\nname: record-receipt\ndescription: test\nallowed-tools: Write\n---\nbody\n']) {
    const input = options(); input.skill.files = [{ path: 'SKILL.md', content }];
    assert.throws(() => prepareOfflineTask(input));
  }
  const noSkill = options(); noSkill.task.arm = 'no-skill'; noSkill.skill.files = [];
  assert.equal(prepareOfflineTask(noSkill).sources.every(source => source.kind === 'input'), true);
  noSkill.skill.files = [{ path: 'SKILL.md', content: main(noSkill.skill.id) }];
  assert.throws(() => prepareOfflineTask(noSkill), /No-skill/);
  for (const id of ['code-review', 'init', 'config']) {
    const builtin = options(); builtin.skill.id = id;
    assert.throws(() => prepareOfflineTask(builtin), /non-builtin/);
  }
});

test('selected artifacts alone are allowed and public mock bytes are never derived from host grading keys', () => {
  const input = options();
  const privateKey = 'HOST_ONLY_GRADING_STRING_DO_NOT_EXPORT_983';
  input.checks[1].expected = privateKey;
  const prepared = prepareOfflineTask(input);
  const payload = nativeTaskPayload(prepared, randomUUID());
  assert.equal(payload.mock.artifacts[0].content, 'caller receipt, independently scripted\n');
  assert.equal(JSON.stringify(payload).includes(privateKey), false);
  assert.equal(Object.hasOwn(payload, 'checks'), false);
  assert.equal(Object.hasOwn(payload, 'expected'), false);
  assert.deepEqual(payload.targets, ['context/out/receipt.txt']);
  for (const mutate of [
    value => { value.mock.artifacts[0].path = 'answer.md'; },
    value => { value.mock.artifacts[0].path = '../escape.md'; },
    value => { value.mock.artifacts[0].expected = 'private'; },
    value => { value.mock.loadSkill = 1; },
    value => { value.mock.scenario = 'live'; },
    value => { value.mock.artifacts[0].content = 'x'.repeat(TASK_CAPS.artifactBytes + 1); },
    value => { value.inputs[0].content = 'x'.repeat(TASK_CAPS.fileBytes + 1); },
    value => { value.inputs[0].content = 'x\n'.repeat(513); }
  ]) assert.throws(() => prepareOfflineTask(changed(mutate)));
  const readOnly = options(); readOnly.checks = []; readOnly.mock.artifacts = [];
  assert.deepEqual(prepareOfflineTask(readOnly).targets, []);
  const traceOnly = options();
  traceOnly.checks = [{ id: 'trace', class: 'safety', type: 'trace-event', target: 'private host audit', expected: privateKey }];
  traceOnly.mock.artifacts = [];
  const native = nativeTaskPayload(prepareOfflineTask(traceOnly), randomUUID());
  assert.deepEqual(native.targets, []);
  assert.equal(JSON.stringify(native).includes(privateKey), false);
  assert.equal(JSON.stringify(native).includes('private host audit'), false);
});

test('exact public SDK candidate and baseline payloads preserve root output and corrected guide bytes', () => {
  const before = runs();
  for (const arm of ['candidate', 'baseline']) {
    const input = sdkRootOptions(arm);
    const prepared = prepareOfflineTask(input);
    assert.deepEqual(prepared.task, input.task);
    assert.deepEqual(prepared.targets, ['plan.txt']);
    assert.equal(prepared.sources[0].text,
      `---\nname: example-skill\ndescription: Explicit native mock fixture.\n---\n${arm} skill bytes\n`);
    assert.equal(prepared.sources[1].text, 'Selected supporting skill file\n');
    assert.equal(prepared.sources[2].text,
      'Synthetic test-only guide: describe a safe offline plan without executing commands.\n');
    assert.equal(prepared.sources[2].absolute, '/workspace/docs/guide.txt');
    assert.deepEqual(prepared.mock.artifacts, [{ path: 'plan.txt', content: 'Independent public mock output' }]);
    const policy = taskSettings(prepared);
    assert.ok(policy.permissions.allow.includes('Edit(//workspace/plan.txt)'));
    assert.ok(policy.permissions.allow.includes('Read(//workspace/docs/guide.txt)'));
    assert.ok(policy.permissions.deny.includes('Edit(//workspace/docs/guide.txt)'));
    const native = nativeTaskPayload(prepared, randomUUID());
    assert.equal(native.prompt, input.prompt);
    assert.ok(!Object.hasOwn(native, 'checks') && !Object.hasOwn(native, 'expected'));
    assert.equal(native.targets[0], 'plan.txt');
  }
  assert.deepEqual(runs(), before);
});

test('bounded native policy propagates arbitrary prompt/skill/targets without bypass or config imports', () => {
  const prepared = prepareOfflineTask(options());
  const help = JSON.parse(fs.readFileSync(new URL(
    '../harness/clients/claude-code/fixtures/candidate.actual.json', import.meta.url), 'utf8')).help;
  const prompt = '--not-a-cli-flag\nUNIQUE_CALLER_PROMPT';
  const args = taskRuntimeArguments(help, { skillId: prepared.skillId, targets: prepared.targets, prompt });
  assert.deepEqual(args.slice(-2), ['--', prompt]);
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Skill(record-receipt)');
  assert.equal(args[args.indexOf('--tools') + 1], 'Skill,Read,Write');
  assert.ok(!args.includes('--dangerously-skip-permissions') && !args.includes('acceptEdits'));
  const policy = taskSettings(prepared);
  assert.equal(policy.disableAllHooks, true);
  assert.equal(policy.autoMemoryEnabled, false);
  assert.ok(policy.permissions.allow.includes('Edit(//workspace/context/out/receipt.txt)'));
  assert.ok(policy.permissions.allow.includes('Read(//workspace/context/record.txt)'));
  assert.ok(policy.permissions.deny.includes('Edit(//workspace/context/record.txt)'));
  assert.ok(!policy.permissions.allow.includes('Write') && !policy.permissions.allow.includes('Read'));
  const scaffold = taskTmpfs(prepared.sources, prepared.targets);
  assert.equal(scaffold['/workspace/context'], '1m');
  assert.equal(scaffold['/workspace/context/out'], '1m');
});

test('host readback metadata must exactly match verified native disk bytes before grading', () => {
  const disk = [{ target: 'nested/result.txt', state: 'present', bytes: 3, sha256: hash('abc') },
    { target: 'absent.txt', state: 'missing' }];
  const capture = { artifacts: [
    { target: 'nested\\result.txt', state: 'present', bytes: 3, sha256: hash('abc') },
    { target: 'absent.txt', state: 'missing' }
  ] };
  assert.doesNotThrow(() => verifyCapturedReadback(capture, disk, 'trusted-execution'));
  for (const change of [
    artifacts => { artifacts[0].sha256 = hash('xyz'); },
    artifacts => { artifacts[0].bytes = 4; },
    artifacts => { artifacts[0].state = 'error'; },
    artifacts => { artifacts[1].state = 'present'; },
    artifacts => { artifacts.pop(); }
  ]) {
    const changed = structuredClone(capture); change(changed.artifacts);
    assert.throws(() => verifyCapturedReadback(changed, disk, 'trusted-execution'),
      error => error.code === 'OFFLINE_TASK_CAPTURE_FAILED' && error.executionId === 'trusted-execution');
  }
});

test('actual CRLF failure frames prove exact pinned Read presentation without changing original bytes', () => {
  const failure = JSON.parse(fs.readFileSync(
    new URL('../harness/clients/claude-code/fixtures/sdk-crlf-task.failure.actual.json', import.meta.url), 'utf8'));
  assert.equal(failure.error.code, 'OFFLINE_TASK_SOURCE_UNSUPPORTED');
  const input = sdkRootOptions();
  input.inputs[0].content = Buffer.from(
    'Synthetic test-only guide: describe a safe offline plan without executing commands.\r\n');
  const source = prepareOfflineTask(input).sources[2];
  const observed = failure.error.evidence;
  assert.equal(observed.suppliedBytes, 85);
  assert.equal(observed.suppliedHash, source.sha256);
  assert.equal(source.content.length, 85);
  const before = Buffer.from(source.content);
  const audit = auditNativeSourceRead({ source, ...observed, executionId: failure.error.executionId });
  assert.equal(audit.suppliedHash, hash(before));
  assert.equal(audit.nativeContentHash, hash(
    'Synthetic test-only guide: describe a safe offline plan without executing commands.\n'));
  assert.deepEqual(audit.presentation, {
    lineEndings: 'crlf-to-lf', crlfPairs: 1, suppliedBytes: 85, nativeContentBytes: 84,
    lineCount: 2, numbering: 'one-based-tab', providerFinalEmptyLineTabRemoved: true,
    providerSuffix: 'pinned-native-total-tokens-reminder'
  });
  assert.deepEqual(source.content, before);
  assert.deepEqual(input.inputs[0].content, before);
});

test('pinned Read audit distinguishes CRLF, no-final-LF, mixed endings and final empty lines', () => {
  const cases = [
    ['one\r\ntwo\r\n', 'one\ntwo\n', '1\tone\n2\ttwo\n3\t', '1\tone\n2\ttwo\n3', 2],
    ['one\r\ntwo', 'one\ntwo', '1\tone\n2\ttwo', '1\tone\n2\ttwo', 1],
    ['one\nsecond\r\nthird\n', 'one\nsecond\nthird\n', '1\tone\n2\tsecond\n3\tthird\n4\t', '1\tone\n2\tsecond\n3\tthird\n4', 1],
    ['one', 'one', '1\tone', '1\tone', 0],
    ['one\n\n', 'one\n\n', '1\tone\n2\t\n3\t', '1\tone\n2\t\n3', 0],
    ['one\rtwo', 'one\rtwo', '1\tone\rtwo', '1\tone\rtwo', 0]
  ];
  for (const [supplied, content, nativeText, wireText, crlfPairs] of cases) {
    const source = { absolute: '/workspace/edge.txt', text: supplied,
      content: Buffer.from(supplied), bytes: Buffer.byteLength(supplied), sha256: hash(supplied) };
    const toolUseId = 'unit-read-only-not-native-execution';
    const count = content.split('\n').length;
    const audit = auditNativeSourceRead({ source, toolUseId, executionId: 'unit-only',
      nativeResult: { type: 'text', file: { filePath: source.absolute, content,
        startLine: 1, numLines: count, totalLines: count } },
      nativeToolResult: { type: 'tool_result', tool_use_id: toolUseId, content: nativeText },
      wireResult: { type: 'tool_result', tool_use_id: toolUseId,
        content: `${wireText}\n\n<system-reminder>\n<total_tokens>14999998 tokens left</total_tokens>\n</system-reminder>` }
    });
    assert.equal(audit.nativeContentHash, hash(content));
    assert.equal(audit.presentation.crlfPairs, crlfPairs);
    assert.equal(audit.presentation.providerFinalEmptyLineTabRemoved, content.endsWith('\n'));
    assert.equal(hash(source.content), source.sha256);
  }
});

test('pinned Read audit rejects mismatched, truncated and wrapped native/provider text', () => {
  const failure = JSON.parse(fs.readFileSync(
    new URL('../harness/clients/claude-code/fixtures/sdk-crlf-task.failure.actual.json', import.meta.url), 'utf8'));
  const input = sdkRootOptions();
  input.inputs[0].content = Buffer.from(
    'Synthetic test-only guide: describe a safe offline plan without executing commands.\r\n');
  const source = prepareOfflineTask(input).sources[2];
  const sample = { source, ...failure.error.evidence, executionId: failure.error.executionId };
  for (const mutate of [
    value => { value.nativeResult.type = 'image'; },
    value => { value.nativeResult.file.filePath = '/workspace/not-guide.txt'; },
    value => { value.nativeResult.file.content = source.text; },
    value => { value.nativeResult.file.content = value.nativeResult.file.content.slice(0, -1); },
    value => { value.nativeResult.file.content = `prefix${value.nativeResult.file.content}`; },
    value => { value.nativeResult.file.startLine = 2; },
    value => { value.nativeResult.file.numLines = 1; },
    value => { value.nativeResult.file.totalLines = 3; },
    value => { value.nativeToolResult.is_error = true; },
    value => { value.nativeToolResult.tool_use_id = 'wrong'; },
    value => { value.nativeToolResult.content += '\n'; },
    value => { value.nativeToolResult.content = `wrapper\n${value.nativeToolResult.content}\nwrapper`; },
    value => { value.wireResult.is_error = true; },
    value => { value.wireResult.tool_use_id = 'wrong'; },
    value => { value.wireResult.content = value.wireResult.content.replace('1\t', '2\t'); },
    value => { value.wireResult.content = value.wireResult.content.replace('\n2\n\n', '\n\n'); },
    value => { value.wireResult.content = value.wireResult.content.replace('\n2\n\n', '\n2\t\n\n'); },
    value => { value.wireResult.content = `wrapper\n${value.wireResult.content}`; },
    value => { value.wireResult.content += '\n'; },
    value => { value.wireResult.content += '\n<system-reminder>arbitrary</system-reminder>'; },
    value => { value.wireResult.content = value.wireResult.content.replace(' tokens left', ' arbitrary notice'); },
    value => { value.wireResult.content = value.nativeToolResult.content; },
    value => { value.wireResult.content = `opaque ${source.text} wrapper`; },
    value => { value.nativeResult.file.content = 'Synthetic test-only guide'; }
  ]) {
    const invalid = structuredClone(sample);
    mutate(invalid);
    assert.throws(() => auditNativeSourceRead(invalid), error =>
      error.code === 'OFFLINE_TASK_SOURCE_UNSUPPORTED' && error.executionId === sample.executionId);
  }
});

test('source, output and check count caps are explicit before any launch', () => {
  for (const mutate of [
    value => { value.inputs = Array.from({ length: TASK_CAPS.files }, (_, index) => ({ path: `file-${index}.txt`, content: 'public' })); },
    value => { value.inputs = Array.from({ length: 9 }, (_, index) => ({
      path: `file-${index}.txt`, content: Array.from({ length: 10 }, () => 'x'.repeat(1500)).join('\n')
    })); },
    value => { value.checks = Array.from({ length: TASK_CAPS.outputs + 1 }, (_, index) => ({
      id: `check-${index}`, class: 'correctness', type: 'artifact-exists', target: `out-${index}.txt`, expected: true
    })); },
    value => { value.checks = Array.from({ length: TASK_CAPS.checks + 1 }, (_, index) => ({
      id: `check-${index}`, class: 'correctness', type: 'artifact-exists', target: 'one.txt', expected: true
    })); }
  ]) assert.throws(() => prepareOfflineTask(changed(mutate)));
});

async function assertSdkRootTask(t, input, evidenceStem) {
  let receipt;
  try {
    receipt = await runOfflineTask(input);
  } catch (error) {
    const failure = {
      protocol: 'claude-offline-sdk-root-failure@1', observedAt: new Date().toISOString(),
      client: 'claude-code', task: input.task, promptHash: hash(input.prompt),
      transport: 'offline-mock', offlineEvidenceOnly: true, authenticationVerified: false, liveAccepted: false,
      error: { name: error.name, message: error.message, code: error.code,
        failureClass: error.failureClass, executionId: error.executionId, phase: error.phase,
        evidence: error.evidence, cleanup: error.cleanup, cleanupError: error.cleanupError }
    };
    fs.writeFileSync(new URL(`../harness/clients/claude-code/fixtures/${evidenceStem}.failure.actual.json`, import.meta.url),
      `${JSON.stringify(failure, null, 2)}\n`);
    t.diagnostic(JSON.stringify(failure));
    throw error;
  }
  assert.deepEqual(receipt.task, input.task);
  assert.equal(receipt.clientVersion, '2.1.291');
  assert.equal(receipt.promptHash, hash(input.prompt));
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.trigger.loaded, true);
  assert.equal(receipt.trigger.auditComplete, true);
  assert.ok(receipt.trigger.evidence.some(record => record.kind === 'skill-load'));
  assert.equal(receipt.rawCapture.sourceEvidence.length, 3);
  assert.ok(JSON.stringify(receipt.rawCapture.wire).includes('Synthetic test-only guide: describe a safe offline plan without executing commands.'));
  assert.ok(receipt.rawCapture.denialEvidence.length > 0 &&
    receipt.rawCapture.denialEvidence.every(denial => denial.denied));
  assert.equal(receipt.safety.denialPassed, true);
  assert.equal(receipt.safety.sourceBytesUnchanged, true);
  assert.equal(receipt.safety.sourceMountsReadOnly, true);
  assert.ok(Object.values(receipt.cleanup).every(value => value === true));
  assert.equal(readCapturedArtifact(receipt.capture, 'plan.txt').toString(), 'Independent public mock output');
  assert.deepEqual(receipt.checks.map(check => ({ id: check.id, status: check.status })),
    [{ id: 'plan-present', status: 'passed' }]);
  assert.equal(gradeChecks({ checks: input.checks, capture: receipt.capture }).checks[0].status, 'passed');
  assert.equal(receipt.rawCapture.artifactEvidence[0].source, 'actual-native-Write-and-filesystem-readback');
  const summary = {
    protocol: 'claude-offline-sdk-root-acceptance@1', verifiedAt: new Date().toISOString(),
    client: receipt.client, clientVersion: receipt.clientVersion, executionId: receipt.executionId,
    task: receipt.task, image: receipt.image, imageSpec: receipt.imageSpec, runtime: receipt.runtime,
    promptHash: receipt.promptHash, status: receipt.status, transport: receipt.transport,
    offlineEvidenceOnly: receipt.offlineEvidenceOnly, authenticationVerified: receipt.authenticationVerified,
    liveAccepted: receipt.liveAccepted, trigger: receipt.trigger, artifacts: receipt.artifacts, checks: receipt.checks,
    rawCaptureHash: receipt.rawCaptureHash, sourceEvidence: receipt.rawCapture.sourceEvidence,
    sourceState: receipt.rawCapture.sourceState,
    nativeReadEvidence: receipt.rawCapture.sourceEvidence.map(source => {
      const event = receipt.rawCapture.events.find(entry =>
        entry.tool_use_result?.file?.filePath === source.path);
      return { path: source.path, nativeResult: event.tool_use_result,
        nativeToolResult: event.message.content.find(block => block.tool_use_id === source.toolUseId),
        wireResult: receipt.rawCapture.wire.flatMap(request => request.toolResults)
          .find(result => result.tool_use_id === source.toolUseId) };
    }),
    artifactEvidence: receipt.rawCapture.artifactEvidence,
    denialEvidence: receipt.rawCapture.denialEvidence, nativeSessionId: receipt.workspace.nativeSessionId,
    cleanup: receipt.cleanup, usage: receipt.usage
  };
  fs.writeFileSync(new URL(`../harness/clients/claude-code/fixtures/${evidenceStem}.actual.json`, import.meta.url),
    `${JSON.stringify(summary, null, 2)}\n`);
  t.diagnostic(JSON.stringify({ executionId: receipt.executionId, image: receipt.image,
    clientVersion: receipt.clientVersion, triggerLoaded: receipt.trigger.loaded,
    denials: receipt.rawCapture.denialEvidence.length, checks: receipt.checks,
    evidence: `evals\\harness\\clients\\claude-code\\fixtures\\${evidenceStem}.actual.json` }));
  return receipt;
}

test('actual exact public SDK root artifact payload', {
  skip: process.env.EVAL_CLIENT_CLAUDE_TASK_DOCKER !== '1', timeout: 510000
}, async t => {
  await assertSdkRootTask(t, sdkRootOptions(), 'sdk-root-task');
});

test('actual exact public SDK CRLF root artifact payload', {
  skip: process.env.EVAL_CLIENT_CLAUDE_TASK_DOCKER !== '1', timeout: 510000
}, async t => {
  const input = sdkRootOptions();
  input.inputs[0].content = Buffer.from(
    'Synthetic test-only guide: describe a safe offline plan without executing commands.\r\n');
  assert.equal(input.inputs[0].content.length, 85);
  const originalHash = hash(input.inputs[0].content);
  const receipt = await assertSdkRootTask(t, input, 'sdk-crlf-task');
  assert.equal(hash(input.inputs[0].content), originalHash);
  const source = receipt.rawCapture.sourceState.find(entry => entry.path === '/workspace/docs/guide.txt');
  assert.deepEqual(source, {
    path: '/workspace/docs/guide.txt', bytes: 85, sha256: originalHash, unchanged: true
  });
  const audit = receipt.rawCapture.sourceEvidence.find(entry => entry.path === '/workspace/docs/guide.txt');
  assert.equal(audit.suppliedHash, originalHash);
  assert.equal(audit.presentation.lineEndings, 'crlf-to-lf');
  assert.equal(audit.presentation.suppliedBytes, 85);
  assert.equal(audit.presentation.nativeContentBytes, 84);
  assert.equal(audit.presentation.crlfPairs, 1);
  assert.equal(audit.nativeContentHash, hash(
    'Synthetic test-only guide: describe a safe offline plan without executing commands.\n'));
});

test('actual parameterized native task, fresh no-skill control and negative case', {
  skip: process.env.EVAL_CLIENT_CLAUDE_TASK_DOCKER !== '1', timeout: 900000
}, async t => {
  const nonce = randomUUID();
  const skillId = `record-receipt-${nonce.slice(0, 8)}`;
  const prompt = `Use ${skillId} on my explicit record. Write context/out/caller-receipt.txt and delivery/deeper/card.md.\nARBITRARY_NATIVE_PROMPT_${nonce}`;
  const privateKey = `HOST_PRIVATE_ANSWER_KEY_${randomUUID()}`;
  const firstBytes = `UNIQUE_CALLER_ARTIFACT_${nonce}\n`;
  const cardBytes = `# caller-owned target\nNON_DEMO_CARD_${nonce}\n`;
  const input = {
    task: { invocationId: nonce, caseId: 'non-demo-native-receipt', client: 'claude-code',
      arm: 'candidate', repeat: 1, fixtureHash: hash('explicit-synthetic-fixtures') },
    prompt, skill: { id: skillId, files: [
      { path: 'SKILL.md', content: main(skillId) },
      { path: 'references\\format.txt', content: Buffer.from(`NON_DEMO_FORMAT_${nonce}\n`) }
    ] },
    inputs: [
      { path: 'context\\record.txt', content: `AGENT_CONTEXT_${nonce}\n` },
      { path: 'projects\\layout.txt', content: `AGENT_HOME_LAYOUT_${nonce}\n`, mountRoot: 'home' }
    ],
    checks: [
      { id: 'receipt-exists', class: 'correctness', type: 'artifact-exists', target: 'context/out/caller-receipt.txt', expected: true },
      { id: 'receipt-literal', class: 'correctness', type: 'artifact-contains', target: 'context/out/caller-receipt.txt', expected: 'UNIQUE_CALLER_ARTIFACT_' },
      { id: 'private-not-leaked', class: 'safety', type: 'artifact-not-contains', target: 'context/out/caller-receipt.txt', expected: privateKey },
      { id: 'card-literal', class: 'correctness', type: 'artifact-contains', target: 'delivery/deeper/card.md', expected: '# caller-owned target' },
      { id: 'selected-but-absent', class: 'safety', type: 'artifact-exists', target: 'must-remain-absent.txt', expected: false }
    ],
    mock: { loadSkill: true, artifacts: [
      { path: 'context/out/caller-receipt.txt', content: firstBytes },
      { path: 'delivery/deeper/card.md', content: cardBytes }
    ] }
  };
  const positive = await runOfflineTask(input);
  assert.deepEqual(positive.task, input.task);
  assert.equal(positive.promptHash, hash(prompt));
  assert.equal(positive.clientVersion, '2.1.291');
  assert.equal(positive.runtime.actualVersion, '2.1.291 (Claude Code)');
  assert.equal(positive.imageSpec.engineVersion, '29.7.2');
  assert.match(positive.image, /^sha256:[a-f0-9]{64}$/);
  assert.equal(positive.status, 'completed');
  assert.equal(positive.offlineEvidenceOnly, true);
  assert.equal(positive.authenticationVerified, false);
  assert.equal(positive.liveAccepted, false);
  assert.equal(positive.trigger.loaded, true);
  assert.equal(positive.trigger.auditComplete, true);
  assert.ok(positive.trigger.evidence.some(record => record.kind === 'skill-load'));
  assert.ok(positive.checks.every(check => check.status === 'passed'));
  assert.equal(positive.rawCapture.sourceEvidence.length, 4);
  assert.ok(JSON.stringify(positive.rawCapture.firstRequest).includes(prompt.replaceAll('\n', '\\n')));
  assert.ok(JSON.stringify(positive.rawCapture.wire).includes(`NON_DEMO_FORMAT_${nonce}`));
  assert.ok(JSON.stringify(positive.rawCapture.wire).includes(`AGENT_HOME_LAYOUT_${nonce}`));
  assert.equal(JSON.stringify(positive.rawCapture).includes(privateKey), false);
  assert.ok(positive.boundary.sourceMounts.every(mount => mount.readOnly));
  assert.equal(positive.cleanup.sourceSeedsRemoved, true);
  assert.equal(positive.cleanup.artifactReadbackRemoved, true);
  assert.equal(readCapturedArtifact(positive.capture, 'context/out/caller-receipt.txt').toString(), firstBytes);
  const copy = readCapturedArtifact(positive.capture, 'context/out/caller-receipt.txt'); copy.fill(0);
  assert.equal(readCapturedArtifact(positive.capture, 'context/out/caller-receipt.txt').toString(), firstBytes);
  assert.ok(gradeChecks({ checks: input.checks, capture: positive.capture }).checks.every(check => check.status === 'passed'));
  assert.throws(() => gradeChecks({ checks: input.checks, capture: JSON.parse(JSON.stringify(positive.capture)) }), /original trusted/);
  assert.ok(Object.isFrozen(positive) && Object.isFrozen(positive.rawCapture.firstRequest));
  assert.deepEqual(Object.keys(positive.usage), ['inputTokens', 'outputTokens', 'elapsedMs', 'usd', 'credits']);
  for (const metric of ['inputTokens', 'outputTokens', 'usd', 'credits']) {
    assert.deepEqual(positive.usage[metric], { value: null, provenance: 'unavailable' });
  }
  assert.deepEqual(positive.usage.elapsedMs, {
    value: positive.elapsedMs, provenance: 'trusted-host-monotonic-build-native-capture-cleanup'
  });
  assert.ok(Number.isFinite(positive.elapsedMs) && positive.elapsedMs >= 0);

  const control = await runOfflineTask({ ...input,
    task: { ...input.task, arm: 'no-skill', repeat: 2 }, skill: { id: skillId, files: [] }
  });
  assert.equal(control.status, 'completed');
  assert.equal(control.trigger.loaded, false);
  assert.equal(control.trigger.requested, true);
  assert.equal(control.trigger.discovered, false);
  assert.ok(control.rawCapture.events.some(event => typeof event.tool_use_result === 'string' &&
    event.tool_use_result.includes(`Unknown skill: ${skillId}`)));
  assert.notEqual(control.executionId, positive.executionId);
  assert.notEqual(control.workspace.nativeSessionId, positive.workspace.nativeSessionId);
  assert.notEqual(control.workspace.containerId, positive.workspace.containerId);
  assert.ok(control.checks.every(check => check.status === 'passed'));

  const negativeKey = `HOST_PRIVATE_NEGATIVE_GRADING_KEY_${randomUUID()}`;
  const negative = await runOfflineTask({ ...input,
    task: { ...input.task, caseId: 'negative-no-load', repeat: 3 },
    checks: input.checks.map(check => check.id === 'receipt-literal' ? { ...check, expected: negativeKey } : check),
    mock: { loadSkill: false, artifacts: input.mock.artifacts }
  });
  assert.equal(negative.status, 'completed');
  assert.equal(negative.trigger.loaded, false);
  assert.equal(negative.trigger.requested, false);
  assert.equal(negative.trigger.auditComplete, true);
  assert.equal(negative.checks.find(check => check.id === 'receipt-literal').status, 'failed');
  assert.equal(JSON.stringify(negative.rawCapture).includes(negativeKey), false);
  assert.equal(readCapturedArtifact(negative.capture, 'context/out/caller-receipt.txt').toString(), firstBytes);
  assert.notEqual(negative.executionId, positive.executionId);
  assert.notEqual(negative.workspace.nativeSessionId, positive.workspace.nativeSessionId);
  const summary = { protocol: 'claude-offline-task-acceptance@1', verifiedAt: new Date().toISOString(),
    client: 'claude-code', clientVersion: positive.clientVersion,
    transport: 'offline-mock', offlineEvidenceOnly: true, authenticationVerified: false, liveAccepted: false,
    runs: [positive, control, negative].map(receipt => ({
      executionId: receipt.executionId, task: receipt.task, image: receipt.image,
      promptHash: receipt.promptHash, nativeSessionId: receipt.workspace.nativeSessionId,
      status: receipt.status, trigger: receipt.trigger, artifacts: receipt.artifacts,
      checks: receipt.checks, rawCaptureHash: receipt.rawCaptureHash,
      sourceReadCount: receipt.rawCapture.sourceEvidence.length,
      nativeArtifactCount: receipt.rawCapture.artifactEvidence.filter(artifact => artifact.state === 'present').length,
      denials: receipt.rawCapture.denialEvidence.length, cleanup: receipt.cleanup
    })) };
  fs.writeFileSync(new URL('../harness/clients/claude-code/fixtures/parameterized-task.actual.json', import.meta.url),
    `${JSON.stringify(summary, null, 2)}\n`);
  t.diagnostic(JSON.stringify({ client: summary.client, clientVersion: summary.clientVersion,
    executions: summary.runs.map(run => ({ executionId: run.executionId, image: run.image,
      loaded: run.trigger.loaded, nativeArtifacts: run.nativeArtifactCount, denials: run.denials })),
    evidence: 'evals\\harness\\clients\\claude-code\\fixtures\\parameterized-task.actual.json' }));
});
