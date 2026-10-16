import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runOfflineTask, VERSION, prepareNativeTaskSpecification, parseNativeTaskEvidence, readNativeTaskArtifact,
  buildNativeImage, buildOfflineImage, cleanupNativeImage, cleanupOfflineImage, describeNativeImage
} from '../harness/clients/copilot/index.mjs';
import { prepareOfflineTask } from '../harness/clients/copilot/task-policy.mjs';
import { buildCopilotTaskArguments } from '../harness/clients/copilot/config.mjs';
import { TASK_CAPS } from '../harness/clients/copilot/task-boundary.mjs';
import { taskSeedFiles, taskProtocolSteps } from '../harness/clients/copilot/task-protocol.mjs';
import { verifyOfflineTaskRecord } from '../harness/clients/copilot/task-parser.mjs';
import { hashContent } from '../harness/index.mjs';
import { captureArtifacts, gradeChecks, readCapturedArtifact } from '../harness/checks/index.mjs';
import { validateNativeTaskEnvelope } from '../harness/clients/copilot/native-envelope.mjs';
import { taskSkillBody } from '../harness/clients/copilot/task-protocol.mjs';

const root = fileURLToPath(new URL('../harness/clients/copilot/', import.meta.url));
const declaration = (type, expected, target = 'caller-output.txt', id = type) =>
  ({ id, type, expected, target, class: 'correctness' });
function taskOptions(arm = 'candidate') {
  const id = 'caller-defined-skill';
  return {
    task: { invocationId: 'task-unit', caseId: 'arbitrary-case', client: 'copilot',
      arm, repeat: 1, fixtureHash: 'a'.repeat(64) },
    prompt: 'Arbitrary caller prompt: token: literal-public-text; use caller-defined-skill.',
    skill: { id, files: arm === 'no-skill' ? [] : [{
      path: 'SKILL.md', content: `---\nname: ${id}\ndescription: A real caller-supplied skill.\n---\nUnique caller skill body.\n`
    }] },
    inputs: [{ path: 'fixtures\\notes.txt', content: Buffer.from('Caller fixture bytes\n') }],
    checks: [declaration('artifact-exists', true)],
    mock: { loadSkill: arm !== 'no-skill', artifacts: [{ path: 'caller-output.txt', content: 'Independent canned output\n' }] }
  };
}

test('runOfflineTask is exported without replacing the existing pinned probe', () => {
  assert.equal(typeof runOfflineTask, 'function');
  assert.equal(VERSION, '1.0.92');
});

test('valid preparation copies all bytes/coordinates and keeps declarations out of the wire payload', () => {
  const options = taskOptions();
  const secret = `HOST_ONLY_EXPECTATION_${randomUUID()}`;
  options.checks.push(declaration('artifact-contains', secret, 'caller-output.txt', 'host-private'));
  const prepared = prepareOfflineTask(options);
  assert.deepEqual(prepared.task, options.task);
  assert.notStrictEqual(prepared.task, options.task);
  assert.equal(prepared.timeoutMs, 180000);
  assert.ok(!JSON.stringify(prepared.payload).includes(secret));
  assert.ok(!Object.hasOwn(prepared.payload, 'checks'));
  assert.ok(!Object.hasOwn(prepared.payload, 'task'));
  assert.equal(prepared.payload.mock.artifacts[0].content, 'Independent canned output\n');
  options.inputs[0].content.fill(0);
  options.task.caseId = 'mutated';
  options.checks[0].expected = false;
  assert.equal(prepared.payload.inputs[0].content, 'Caller fixture bytes\n');
  assert.equal(prepared.task.caseId, 'arbitrary-case');
  assert.equal(prepared.checks[0].expected, true);
  assert.ok(Object.isFrozen(prepared.payload.mock.artifacts[0]));
  assert.match(prepared.payload.executionId, /^[a-f0-9-]{36}$/);
  assert.notEqual(prepared.payload.executionId, prepareOfflineTask(taskOptions()).payload.executionId);
});

test('coordinates, unknown fields, live/auth knobs and nonempty bounded prompt validate before Docker', async () => {
  const invalid = [
    options => { options.task.client = 'opencode'; },
    options => { options.task.repeat = 4; },
    options => { options.task.fixtureHash = 'x'; },
    options => { options.task.fixtureHash = true; },
    options => { options.task.arm = 'live'; },
    options => { options.task.invocationId = '../escape'; },
    options => { options.task.executionId = 'forged'; },
    options => { options.prompt = ''; },
    options => { options.prompt = ' \n'; },
    options => { options.prompt = Buffer.from('not a string'); },
    options => { options.prompt = 'x'.repeat(TASK_CAPS.promptBytes + 1); },
    options => { options.prompt = '\uD800'; },
    options => { options.timeoutMs = 0; },
    options => { options.timeoutMs = null; },
    options => { options.timeoutMs = TASK_CAPS.timeoutMs + 1; },
    options => { options.mode = 'live'; },
    options => { options.authenticationVerified = true; },
    options => { options.environment = { HOME: 'host' }; },
    options => { options.inputs = null; }
  ];
  for (const mutate of invalid) {
    const options = taskOptions(); mutate(options);
    await assert.rejects(runOfflineTask(options), error => /^TASK_/.test(error.code));
  }
});

test('only no-skill may omit files; genuine SKILL.md is required even for a negative scripted load', () => {
  const noSkill = prepareOfflineTask(taskOptions('no-skill'));
  assert.equal(noSkill.payload.skill.files.length, 0);
  assert.equal(noSkill.payload.mock.loadSkill, false);
  assert.ok(!taskProtocolSteps(noSkill.payload).some(step => step.kind === 'skill-load'));
  for (const mutate of [
    options => { options.skill.files = []; },
    options => { options.skill.files[0].path = 'skill.md'; },
    options => { options.skill.files[0].content = '# Not a skill document'; },
    options => { options.skill.files[0].content = '---\nname: different\ndescription: x\n---\nbody'; },
    options => { options.skill.files[0].content = '---\nname: caller-defined-skill\ndescription:\n---\nbody'; },
    options => { options.skill.files[0].content = '---\nname: caller-defined-skill\ndescription: x\n---\n'; },
    options => { options.skill.files[0].content = Buffer.from([0xff]); },
    options => { options.skill.id = '../escape'; }
  ]) {
    const options = taskOptions(); options.mock.loadSkill = false; mutate(options);
    assert.throws(() => prepareOfflineTask(options));
  }
  const options = taskOptions('no-skill');
  options.mock.loadSkill = true;
  assert.throws(() => prepareOfflineTask(options), error => error.code === 'TASK_MOCK_INVALID');
  options.mock.loadSkill = false;
  options.skill.files = taskOptions().skill.files;
  assert.throws(() => prepareOfflineTask(options), error => error.code === 'TASK_SKILL_INVALID');
  const baseline = taskOptions('baseline');
  baseline.skill.files[0].content = baseline.skill.files[0].content.replace('description: A real caller-supplied skill.',
    'description: >-\n  A folded genuine description.');
  baseline.mock.loadSkill = false;
  assert.ok(prepareOfflineTask(baseline));
});

test('portable paths reject escaping, aliases, devices and native permission glob metacharacters', () => {
  for (const relative of ['../x', '/x', '\\x', 'C:\\x', 'C:x', 'a/../x', 'a//x', 'a/./x',
    'x.', 'x ', 'NUL', 'CON.txt', 'COM0', 'LPT9.log', 'COM¹', 'CONIN$', 'x:stream',
    'x?y', 'x*y', 'x[y]', 'x(y)', 'x{y}', 'x,y', 'x=y', 'x\0y', 'x\nx']) {
    const options = taskOptions(); options.inputs[0].path = relative;
    assert.throws(() => prepareOfflineTask(options), error => error.code === 'TASK_PATH_INVALID', relative);
  }
  for (const relative of ['Caller-output.txt', 'caller-output.txt', 'caller-output.txt\\child']) {
    const options = taskOptions(); options.inputs[0].path = relative;
    assert.throws(() => prepareOfflineTask(options), error => error.code === 'TASK_PATH_COLLISION');
  }
  const options = taskOptions();
  options.inputs.push({ path: 'FIXTURES/notes.txt', content: 'alias' });
  assert.throws(() => prepareOfflineTask(options), error => error.code === 'TASK_PATH_COLLISION');
  const checkAlias = taskOptions();
  checkAlias.checks.push(declaration('artifact-exists', false, 'CALLER-OUTPUT.txt', 'case-alias'));
  assert.throws(() => prepareOfflineTask(checkAlias));
  const ancestors = taskOptions();
  ancestors.checks.push(declaration('artifact-exists', true, 'caller-output.txt\\child', 'ancestor'));
  assert.throws(() => prepareOfflineTask(ancestors), error => error.code === 'TASK_PATH_COLLISION');
});

test('only explicit agent file bytes/mount roots are accepted; no host directories or private/config seeds', () => {
  for (const relative of ['fixtures/specimens.json', 'grader/answer.txt', 'private/answer.txt',
    'expected.json', 'answer-key.json', '.env', '.npmrc', 'auth.json', 'credentials.json',
    'AI/.copilot/settings.json', 'AI/.claude/skills/x/SKILL.md', '.github/skills/x/SKILL.md',
    '.github/hooks/x.json', '.vscode/mcp.json', '.config/x']) {
    const options = taskOptions(); options.inputs[0].path = relative;
    options.inputs[0].mountRoot = relative.startsWith('AI/') ? 'home' : 'workspace';
    assert.throws(() => prepareOfflineTask(options), error => error.code === 'TASK_PRIVATE_OR_CONFIG_INPUT', relative);
  }
  for (const extra of [{ visibility: 'judge' }, { source: 'C:\\Users\\someone' },
    { directory: 'C:\\fixture' }, { kind: 'symlink' }, { mountRoot: 'config' }, { mountRoot: null },
    { content: { directory: 'C:\\fixture' } }, { content: Buffer.from([0xff]) }, { executable: 'yes' }]) {
    const options = taskOptions(); Object.assign(options.inputs[0], extra);
    assert.throws(() => prepareOfflineTask(options));
  }
  const options = taskOptions();
  options.inputs.push({ path: 'AI/fixtures/notes.txt', content: 'Different root', mountRoot: 'home' });
  const prepared = prepareOfflineTask(options);
  assert.deepEqual(taskSeedFiles(prepared.payload).filter(file => file.source === 'fixture').map(file => file.target),
    ['/workspace/fixtures/notes.txt', '/home/eval/AI/fixtures/notes.txt']);
});

test('poison control-plane roots and Skill hooks/plugins/providers reject before native loading', async () => {
  for (const relative of ['opencode.json', 'opencode.jsonc', '.opencode/plugins/poison.mjs',
    '.opencode/agents/poison.md', '.claude/settings.json', '.claude/settings.local.json',
    '.claude/hooks/poison.ps1', '.claude-plugin/plugin.json', '.mcp.json', 'mcp.json',
    '.copilot/config.json', '.github/copilot/settings.json', '.github/hooks/poison.json']) {
    const options = taskOptions();
    options.inputs = [{ path: relative,
      content: '{"hooks":{"sessionStart":[{"command":"poison"}]},"provider":"poison"}' }];
    await assert.rejects(runOfflineTask(options), error => error.code === 'TASK_PRIVATE_OR_CONFIG_INPUT', relative);
  }
  for (const directive of [
    'hooks:\n  sessionStart: poison', '"hooks":\n  sessionStart: poison',
    'plugins: [poison]', 'mcpServers:\n  poison: {}', 'providers: poison',
    'permissions: all', 'allowed-tools: Bash', '<<: *poison'
  ]) {
    const options = taskOptions();
    options.skill.files[0].content = options.skill.files[0].content.replace('\n---\nUnique', `\n${directive}\n---\nUnique`);
    await assert.rejects(runOfflineTask(options), error => error.code === 'TASK_SKILL_CONTROL_PLANE_UNSUPPORTED');
  }
});

test('ordinary read-only docs/AGENTS/AI layout data and JSON examples are not blanket-denied', () => {
  for (const relative of ['AGENTS.md', 'docs/AGENTS.md', 'AI/local.yaml',
    'docs/opencode.json', 'docs/opencode.jsonc', 'docs/.claude/settings.json',
    'docs/.opencode/plugins/example.mjs', 'docs/mcp.json', 'docs/settings.json']) {
    const options = taskOptions();
    options.inputs = [{ path: relative, content: 'Explicit read-only fixture data', executable: false }];
    assert.ok(prepareOfflineTask(options), relative);
  }
  const options = taskOptions();
  options.inputs = [{ path: 'AGENTS.md', content: 'document', executable: true }];
  assert.throws(() => prepareOfflineTask(options), error => error.code === 'TASK_EXECUTABLE_CONTEXT_DOCUMENT');
  const skill = taskOptions();
  skill.skill.files.push({ path: 'references/AGENTS.md', content: 'Ordinary companion instructions document\n' });
  assert.ok(prepareOfflineTask(skill));
});

test('synthetic HOME root execution is explicitly unsupported before Docker, never silently remapped', async () => {
  const options = taskOptions();
  options.inputs[0].mountRoot = 'home';
  const prepared = prepareOfflineTask(options);
  assert.equal(taskSeedFiles(prepared.payload)[0].target, '/home/eval/fixtures/notes.txt');
  await assert.rejects(runOfflineTask(options),
    error => error.code === 'TASK_HOME_NATIVE_AUDIT_UNSUPPORTED' && error.failureClass === 'infrastructure');
});

test('nested HOME/AI is narrowly admitted with readonly grants and control-plane poison rejection', async () => {
  const options = taskOptions();
  options.inputs.push({ path: 'AI\\README.md', content: 'Public native HOME fixture\n', mountRoot: 'home' });
  const prepared = prepareOfflineTask(options);
  const args = buildCopilotTaskArguments(prepared.payload);
  assert.ok(args.includes('read(/home/eval/AI/README.md)'));
  assert.ok(args.includes('write(/home/eval/AI/README.md)'));
  assert.equal(args[args.indexOf('--add-dir') + 1], '/home/eval/AI');
  assert.ok(!args.includes('/home/eval'));
  const sourceWrites = taskProtocolSteps(prepared.payload).filter(step =>
    step.kind === 'boundary-denial' && step.tool === 'edit' && step.args.path === '/home/eval/AI/README.md');
  assert.equal(sourceWrites.length, 1);
  assert.equal(sourceWrites[0].args.old_str, options.inputs[1].content);
  for (const relative of ['AI/opencode.json', 'AI/opencode.jsonc', 'AI/.mcp.json',
    'AI/.claude/settings.json', 'AI/.claude/hooks/poison.ps1', 'AI/.copilot/config.json',
    'AI/.opencode/plugins/poison.mjs']) {
    const poison = taskOptions();
    poison.inputs = [{ path: relative, content: '{"hooks":"poison"}', mountRoot: 'home' }];
    await assert.rejects(runOfflineTask(poison), error => error.code === 'TASK_PRIVATE_OR_CONFIG_INPUT');
  }
  for (const relative of ['AI/AGENTS.md', 'AI/local.yaml', 'AI/docs/opencode.jsonc']) {
    const ordinary = taskOptions();
    ordinary.inputs = [{ path: relative, content: 'Explicit ordinary fixture\n', mountRoot: 'home' }];
    assert.ok(prepareOfflineTask(ordinary));
  }
});

test('selection grants writes only to explicit mock artifacts, never every check target', () => {
  const options = taskOptions();
  options.checks.push(declaration('artifact-exists', false, 'unselected.txt', 'absence'));
  options.checks.push(declaration('artifact-exists', true, 'nested\\not-scripted.txt', 'missing'));
  const prepared = prepareOfflineTask(options);
  const args = buildCopilotTaskArguments(prepared.payload);
  assert.ok(args.includes('write(/workspace/caller-output.txt)'));
  assert.ok(!args.includes('write(/workspace/unselected.txt)'));
  assert.ok(!args.includes('write(/workspace/nested/not-scripted.txt)'));
  assert.ok(!args.slice(args.indexOf('--allow-tool') + 1, args.indexOf('--deny-tool')).includes('view'));
  assert.ok(args.includes('read(/workspace/fixtures/notes.txt)'));
  assert.ok(!args.some(arg => /--allow-all|--yolo|--trust/.test(arg)));
  assert.ok(args.includes('--deny-tool') && args.includes('shell') && args.includes('url'));
  for (const artifacts of [[{ path: 'other.txt', content: 'x' }],
    [{ path: '.github/settings.json', content: 'x' }],
    [{ path: 'caller-output.txt', content: 'x' }, { path: 'CALLER-OUTPUT.txt', content: 'y' }],
    [{ path: 'caller-output.txt', content: Buffer.from('x') }],
    [{ path: 'caller-output.txt', content: 'x', tool: 'bash' }]]) {
    const bad = taskOptions(); bad.mock.artifacts = artifacts;
    assert.throws(() => prepareOfflineTask(bad), error => /^TASK_/.test(error.code));
  }
  const readOnly = taskOptions();
  readOnly.mock.artifacts = [];
  const readonlyArgs = buildCopilotTaskArguments(prepareOfflineTask(readOnly).payload);
  assert.ok(readonlyArgs.includes('write'));
  assert.ok(!readonlyArgs.includes('create'));
  assert.ok(!readonlyArgs.some(arg => arg.startsWith('write(/workspace/caller-output')));
  readOnly.checks = [];
  assert.equal(prepareOfflineTask(readOnly).payload.artifactTargets.length, 0);
});

test('file, output and declaration caps fail before native execution', () => {
  for (const mutate of [
    options => { options.inputs = Array.from({ length: TASK_CAPS.files }, (_, i) => ({ path: `f${i}.txt`, content: 'x' })); },
    options => { options.inputs[0].content = 'x'.repeat(TASK_CAPS.fileBytes + 1); },
    options => { options.inputs = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.txt`, content: 'x'.repeat(TASK_CAPS.fileBytes) })); },
    options => { options.mock.artifacts[0].content = 'x'.repeat(TASK_CAPS.artifactBytes + 1); },
    options => { options.checks = Array.from({ length: TASK_CAPS.checks + 1 }, (_, i) => declaration('artifact-exists', true, 'caller-output.txt', `c${i}`)); },
    options => { options.checks = Array.from({ length: 9 }, (_, i) => declaration('artifact-exists', true, `o${i}.txt`, `c${i}`)); },
    options => { options.checks[0].expected = 'x'.repeat(TASK_CAPS.declarationBytes + 1); }
  ]) {
    const options = taskOptions(); mutate(options);
    assert.throws(() => prepareOfflineTask(options));
  }
  const nativeTurns = taskOptions();
  nativeTurns.inputs = Array.from({ length: TASK_CAPS.files - 1 }, (_, i) =>
    ({ path: `AI/f${i}.txt`, content: 'public', mountRoot: 'home' }));
  nativeTurns.checks = Array.from({ length: TASK_CAPS.artifacts }, (_, i) =>
    declaration('artifact-exists', true, `o${i}.txt`, `c${i}`));
  nativeTurns.mock.artifacts = nativeTurns.checks.map(check => ({ path: check.target, content: 'canned' }));
  assert.throws(() => prepareOfflineTask(nativeTurns), error => error.code === 'TASK_LIMIT');
});

// These synthetic parser inputs are unit fixtures, never native acceptance evidence.
function syntheticNativeRecord(prepared) {
  const payload = prepared.payload;
  const steps = taskProtocolSteps(payload);
  const skill = { name: payload.skill.id, path: `/workspace/.github/skills/${payload.skill.id}/SKILL.md`,
    enabled: true, source: 'project' };
  const transformedContent = `<current_datetime>2026-10-08T00:00:00Z</current_datetime>\n\n${payload.prompt}`;
  const events = [
    { type: 'session.skills_loaded', data: { skills: payload.skill.files.length ? [skill] : [] } },
    { type: 'user.message', data: { content: payload.prompt, transformedContent, interactionId: 'synthetic-unit' } }
  ];
  const tools = ['skill', 'view', ...(payload.mock.artifacts.length ? ['create', 'edit'] : [])];
  const requests = Array.from({ length: steps.length + 1 }, (_, index) => ({
    index, path: '/v1/chat/completions', sha256: hashContent(`synthetic-unit-wire-${index}`), bytes: 1,
    model: 'offline-fixture-model', stream: true, tools, toolResults: [],
    skillBodySeen: payload.mock.loadSkill && index > 0,
    ...(index === 0 ? { prompt: { sha256: hashContent(payload.prompt), bytes: Buffer.byteLength(payload.prompt),
      userMessageHash: hashContent(transformedContent) } } : {})
  }));
  const toolResponses = [];
  for (const [index, step] of steps.entries()) {
    const toolCallId = `task_call_${index}`;
    const denied = step.kind === 'boundary-denial';
    const unavailable = ['bash', 'web_fetch'].includes(step.tool) ||
      ['create', 'edit'].includes(step.tool) && !payload.mock.artifacts.length;
    const content = step.kind === 'skill-load'
      ? `Skill "${payload.skill.id}" loaded successfully. Follow the instructions in the skill context.`
      : step.kind === 'file-read' ? taskSeedFiles(payload).find(file => file.target === step.args.path).content : 'unit result';
    events.push({ type: 'tool.execution_start', data: { toolCallId, toolName: step.tool, arguments: step.args } });
    events.push({ type: 'tool.execution_complete', data: { toolCallId, success: !denied,
      ...(denied ? { error: { code: unavailable ? 'failure' : 'denied',
        message: unavailable ? `Tool '${step.tool}' does not exist.` : 'Permission denied' } } : {
        result: { content },
        ...(step.kind === 'skill-load' ? { toolTelemetry: { properties: { skillSource: 'project', found: 'true' } } } : {})
      }) } });
    const response = { toolCallId, sha256: hashContent(content), bytes: Buffer.byteLength(content), fullContentSeen: true };
    requests[index + 1].toolResults.push(response);
    toolResponses.push({ ...response, requestIndex: index + 1 });
  }
  events.push({ type: 'assistant.message', data: { content: 'OFFLINE_TASK_COMPLETE', toolRequests: [] } },
    { type: 'result', exitCode: 0, usage: {} });
  const manifest = taskSeedFiles(payload).map(file => ({ path: file.target, bytes: Buffer.byteLength(file.content),
    sha256: hashContent(file.content), readonly: true }));
  return {
    transport: 'offline-mock', client: 'copilot', clientVersion: '1.0.92', nodeVersion: '22.22.1',
    executionId: payload.executionId, payloadHash: hashContent(JSON.stringify(payload)),
    freshWorkspace: true, nativeSessionFresh: true, outputLimited: false, exitCode: 0,
    stdout: events.map(event => JSON.stringify(event)).join('\n'),
    provider: { calls: steps.map((step, index) => ({ id: `task_call_${index}`, name: step.tool, arguments: step.args })),
      errors: [], requests, toolResponses },
    seedIntegrity: { before: manifest, after: structuredClone(manifest), guardUnchanged: true,
      leakDetected: false, unauthorizedFiles: [] },
    artifacts: payload.artifactTargets.map(target => {
      const artifact = payload.mock.artifacts.find(file => file.path === target);
      return artifact ? { path: target, state: 'present', bytes: Buffer.byteLength(artifact.content),
        sha256: hashContent(artifact.content), base64: Buffer.from(artifact.content).toString('base64') }
        : { path: target, state: 'missing' };
    })
  };
}

test('trigger requires actual discovery/load/result/wire evidence; incomplete audit is explicit', () => {
  const prepared = prepareOfflineTask(taskOptions());
  const record = syntheticNativeRecord(prepared);
  assert.equal(verifyOfflineTaskRecord(record, prepared).trigger.loaded, true);
  for (const mutate of [
    r => { r.stdout = r.stdout.split('\n').filter(line => JSON.parse(line).type !== 'session.skills_loaded').join('\n'); },
    r => { r.provider.requests[1].skillBodySeen = false; },
    r => { r.provider.requests[0].prompt.sha256 = '0'.repeat(64); },
    r => { r.provider.requests.pop(); },
    r => { r.seedIntegrity.after[0].readonly = false; },
    r => { r.seedIntegrity.guardUnchanged = false; },
    r => { r.seedIntegrity.leakDetected = true; },
    r => { r.provider.requests[0].tools.push('bash'); },
    r => { r.provider.toolResponses.find(item => item.toolCallId === 'task_call_1').fullContentSeen = false; }
  ]) {
    const broken = structuredClone(record); mutate(broken);
    assert.throws(() => verifyOfflineTaskRecord(broken, prepared), error => /^TASK_/.test(error.code));
  }
  const missing = structuredClone(record);
  missing.stdout = missing.stdout.split('\n').filter(line => JSON.parse(line).type !== 'session.skills_loaded').join('\n');
  assert.throws(() => verifyOfflineTaskRecord(missing, prepared), error => error.code === 'TASK_AUDIT_INCOMPLETE');
  const negative = taskOptions(); negative.mock.loadSkill = false;
  const p = prepareOfflineTask(negative);
  assert.equal(verifyOfflineTaskRecord(syntheticNativeRecord(p), p).trigger.loaded, false);
  const noSkill = prepareOfflineTask(taskOptions('no-skill'));
  const control = verifyOfflineTaskRecord(syntheticNativeRecord(noSkill), noSkill);
  assert.equal(control.trigger.loaded, false);
  assert.equal(control.trigger.discovered, false);
  assert.equal(control.trigger.auditComplete, true);
});

function withNativeWireCatalog(record, prepared) {
  record.stdout = record.stdout.split('\n').filter(line =>
    JSON.parse(line).type !== 'session.skills_loaded').join('\n');
  const project = prepared.payload.skill.files.length
    ? `<skill><name>${prepared.payload.skill.id}</name><description>Public &amp; genuine &#x63;atalog.</description><location>project</location></skill>`
    : '';
  const catalog = `<available_skills>${project}<skill><name>customize-cloud-agent</name><description>Native builtin.</description><location>builtin</location></skill><skill><name>github-pr-media</name><description>GitHub&apos;s native builtin.</description><location>builtin</location></skill></available_skills>`;
  record.provider.discoveryWire = {
    requestHash: record.provider.requests[0].sha256, systemMessageHashes: [hashContent('synthetic-system')],
    catalogSourceRole: 'system', catalogCount: 1, catalogMarkerCount: 2,
    catalogs: [catalog], catalogSystemMessageIndices: [0],
    skillSchema: { name: 'skill', parameters: { properties: { skill: { type: 'string' } } } }
  };
  return record;
}

test('native system wire catalog is a distinct complete audit only when native JSONL discovery is absent', () => {
  for (const arm of ['candidate', 'baseline', 'no-skill']) {
    const options = taskOptions(arm);
    if (arm === 'baseline') options.mock.loadSkill = false;
    const prepared = prepareOfflineTask(options);
    const record = withNativeWireCatalog(syntheticNativeRecord(prepared), prepared);
    const trigger = verifyOfflineTaskRecord(record, prepared).trigger;
    assert.equal(trigger.loaded, arm === 'candidate');
    assert.equal(trigger.discovered, arm !== 'no-skill');
    assert.equal(trigger.auditComplete, true);
    assert.equal(trigger.discoveryAudit.length, 0);
    assert.equal(trigger.auditSource, 'actual-first-provider-request-system-available_skills');
    assert.ok(!Object.hasOwn(trigger.wireDiscoveryAudit.skills[0], 'path'));
    assert.ok(!Object.hasOwn(trigger.wireDiscoveryAudit.skills[0], 'enabled'));
    assert.equal(trigger.wireDiscoveryAudit.skills.at(-1).description, "GitHub's native builtin.");
  }
  const prepared = prepareOfflineTask(taskOptions());
  const record = withNativeWireCatalog(syntheticNativeRecord(prepared), prepared);
  for (const mutate of [
    r => { r.provider.discoveryWire = null; },
    r => { r.provider.discoveryWire.requestHash = '0'.repeat(64); },
    r => { r.provider.discoveryWire.catalogSourceRole = 'assistant'; },
    r => { r.provider.discoveryWire.catalogs.push(r.provider.discoveryWire.catalogs[0]); },
    r => { r.provider.discoveryWire.catalogCount = 2; },
    r => { r.provider.discoveryWire.catalogMarkerCount = 3; },
    r => { r.provider.discoveryWire.catalogSystemMessageIndices[0] = 1; },
    r => { r.provider.discoveryWire.catalogs[0] = r.provider.discoveryWire.catalogs[0].replace('</available_skills>', ''); },
    r => { r.provider.discoveryWire.catalogs[0] = r.provider.discoveryWire.catalogs[0].replace('</available_skills>', '<unexpected /></available_skills>'); },
    r => { r.provider.discoveryWire.catalogs[0] = r.provider.discoveryWire.catalogs[0].replace('Public &amp;', 'Public &unknown;'); },
    r => { r.provider.discoveryWire.catalogs[0] = r.provider.discoveryWire.catalogs[0].replace('Public &amp;', 'Public &#0;'); },
    r => { r.provider.discoveryWire.catalogs[0] = r.provider.discoveryWire.catalogs[0].replace('Public &amp;', 'Public &#1;'); },
    r => { r.provider.discoveryWire.catalogs[0] = r.provider.discoveryWire.catalogs[0].replace('Public &amp;', 'Public \u0001'); },
    r => { r.provider.discoveryWire.catalogs[0] = r.provider.discoveryWire.catalogs[0].replace('Public &amp;', 'Public ]]>'); },
    r => { r.provider.discoveryWire.catalogs[0] = r.provider.discoveryWire.catalogs[0].replace('<location>project', '<location>user'); },
    r => { r.provider.discoveryWire.catalogs[0] = r.provider.discoveryWire.catalogs[0].replace('<name>github-pr-media</name>', '<name>customize-cloud-agent</name>'); },
    r => { r.provider.discoveryWire.skillSchema = null; },
    r => { r.stdout = `${JSON.stringify({ type: 'session.skills_loaded', data: { skills: [{ name: 'malformed' }] } })}\n${r.stdout}`; }
  ]) {
    const broken = structuredClone(record); mutate(broken);
    assert.throws(() => verifyOfflineTaskRecord(broken, prepared), error => error.code === 'TASK_AUDIT_INCOMPLETE');
  }
  const eventRecord = syntheticNativeRecord(prepared);
  eventRecord.provider.discoveryWire = record.provider.discoveryWire;
  assert.equal(verifyOfflineTaskRecord(eventRecord, prepared).trigger.auditSource, 'native-session.skills_loaded');
});

test('native stdout/create claims cannot substitute for disk bytes and host trusted capture', t => {
  const prepared = prepareOfflineTask(taskOptions());
  const record = syntheticNativeRecord(prepared);
  const missing = structuredClone(record); missing.artifacts[0] = { path: 'caller-output.txt', state: 'missing' };
  assert.throws(() => verifyOfflineTaskRecord(missing, prepared), error => error.code === 'TASK_NATIVE_ARTIFACT_UNVERIFIED');
  const wrong = structuredClone(record); wrong.artifacts[0].base64 = Buffer.from('wrong').toString('base64');
  assert.throws(() => verifyOfflineTaskRecord(wrong, prepared), error => error.code === 'TASK_NATIVE_ARTIFACT_UNVERIFIED');
  const directory = path.join(root, `.task-unit-${randomUUID()}`);
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const verified = verifyOfflineTaskRecord(record, prepared);
  fs.writeFileSync(path.join(directory, 'caller-output.txt'), verified.bytes.get('caller-output.txt'));
  const capture = captureArtifacts({ artifactRoot: directory, checks: prepared.checks });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(gradeChecks({ checks: prepared.checks, capture }).checks[0].status, 'passed');
  readCapturedArtifact(capture, 'caller-output.txt').fill(0);
  assert.equal(readCapturedArtifact(capture, 'caller-output.txt').toString(), 'Independent canned output\n');
  assert.throws(() => gradeChecks({ checks: prepared.checks, capture: structuredClone(capture) }));
});

function nativeOptions(arm = 'candidate') {
  const { task, prompt, skill, inputs } = taskOptions(arm);
  return {
    payload: { task, prompt, skill, inputs, artifactTargets: ['caller-output.txt'] },
    broker: { model: 'gpt-5', authRoot: '/client-config/copilot', proxyURL: 'http://eval-proxy:8080' }
  };
}

// Synthetic unit trace transformations are NOT native live/auth acceptance.
function nativeUnitObservation(specification) {
  const options = taskOptions(specification.task.arm);
  options.task = specification.task;
  options.prompt = specification.envelope.prompt;
  options.skill = { id: specification.envelope.skill.id,
    files: specification.envelope.skill.files.map(({ mountRoot, ...file }) => file) };
  options.inputs = specification.envelope.inputs;
  const prepared = prepareOfflineTask(options);
  const record = syntheticNativeRecord(prepared);
  const events = record.stdout.split('\n').map(JSON.parse);
  for (const event of events) {
    if (event.type === 'tool.execution_complete' && event.data.toolTelemetry) {
      event.data.toolTelemetry.metrics = { skillContentLength: taskSkillBody(specification.envelope).length };
    }
  }
  events.splice(2, 0, { type: 'model.call_start', data: { turnId: '0', model: specification.model } });
  events.splice(events.length - 1, 0, { type: 'model.call_final_result',
    data: { model: specification.model, isByok: false, result: 'success' } });
  events.at(-1).usage = { premiumRequests: 1, sessionDurationMs: 55 };
  return {
    specification, stdout: events.map(event => JSON.stringify(event)).join('\n'), exitCode: 0,
    submittedStdin: { sha256: specification.stdinHash, bytes: specification.stdinBytes },
    filesystemEvidence: { before: record.seedIntegrity.before, after: record.seedIntegrity.after,
      unauthorizedFiles: record.seedIntegrity.unauthorizedFiles, artifacts: record.artifacts },
    usage: {
      currentModel: specification.model, totalNanoAiu: 987654321, totalPremiumRequestCost: 1,
      modelMetrics: { [specification.model]: { requests: { count: 2 },
        usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: 2 } } }
    }
  };
}

test('native planning/observer exports retain authentic case-free image helper identities', () => {
  assert.equal(typeof prepareNativeTaskSpecification, 'function');
  assert.equal(typeof parseNativeTaskEvidence, 'function');
  assert.equal(typeof readNativeTaskArtifact, 'function');
  assert.strictEqual(buildNativeImage, buildOfflineImage);
  assert.strictEqual(cleanupNativeImage, cleanupOfflineImage);
  assert.throws(() => describeNativeImage({ image: `sha256:${'1'.repeat(64)}` }), error => error.code === 'OWNERSHIP');
});

test('mock-free native specification is immutable planning, not auth/model/network admission', () => {
  const { payload, broker } = nativeOptions();
  const spec = prepareNativeTaskSpecification(payload, broker);
  assert.equal(spec.planningOnly, true);
  assert.equal(spec.authenticationVerified, false);
  assert.equal(spec.liveAccepted, false);
  assert.deepEqual(spec.task, payload.task);
  assert.notStrictEqual(spec.task, payload.task);
  assert.equal(spec.executable, '/opt/fixture/node_modules/.bin/copilot');
  assert.deepEqual(spec.entrypoint, ['node', '/opt/fixture/native-runtime.mjs']);
  assert.equal(spec.stdinHash, hashContent(spec.stdin));
  assert.equal(spec.stdinBytes, Buffer.byteLength(spec.stdin));
  assert.equal(spec.submittedPrompt.sha256, hashContent(payload.prompt));
  assert.notEqual(spec.stdinHash, spec.submittedPrompt.sha256);
  assert.ok(!Object.hasOwn(JSON.parse(spec.stdin), 'task'));
  assert.ok(!/offline-fixture-model|COPILOT_PROVIDER_|HOST_ONLY_EXPECTATION/.test(spec.stdin));
  assert.deepEqual(spec.nativeHardLimits, {
    turns: null, totalTokens: null, accountSpend: null, provenance: 'unsupported-not-applied'
  });
  assert.equal(spec.requirements.linuxOAuthStoreVerified, false);
  assert.equal(spec.requirements.nativeProxyCompatibilityVerified, false);
  payload.inputs[0].content.fill(0);
  payload.task.caseId = 'changed';
  assert.equal(spec.envelope.inputs[0].content, 'Caller fixture bytes\n');
  assert.equal(spec.task.caseId, 'arbitrary-case');
  assert.ok(Object.isFrozen(spec.envelope.skill.files[0]));
});

test('native spec rejects private/mock/config/collision inputs and credential/auth overrides', () => {
  for (const mutate of [
    p => { p.checks = [{ expected: 'host-private' }]; },
    p => { p.mock = { loadSkill: true, artifacts: [] }; },
    p => { p.authenticationVerified = true; },
    p => { p.environment = { GITHUB_TOKEN: 'not-accepted' }; },
    p => { p.inputs[0].path = '../private'; },
    p => { p.inputs[0].path = '.claude/settings.json'; },
    p => { p.inputs[0].path = 'AI/.copilot/config.json'; p.inputs[0].mountRoot = 'home'; },
    p => { p.inputs[0].path = 'caller-output.txt'; },
    p => { p.artifactTargets.push('CALLER-OUTPUT.txt'); },
    p => { p.skill.files[0].content = '# not genuine'; },
    p => { p.skill.files[0].content = p.skill.files[0].content.replace('\n---\nUnique', '\nhooks: poison\n---\nUnique'); }
  ]) {
    const { payload, broker } = nativeOptions(); mutate(payload);
    assert.throws(() => prepareNativeTaskSpecification(payload, broker));
  }
  for (const mutate of [
    o => { o.model = 'offline-fixture-model'; },
    o => { o.model = '--allow-all'; },
    o => { o.authRoot = 'C:\\Users\\personal'; },
    o => { o.authRoot = '/client-config/../home/eval'; },
    o => { o.authenticated = true; },
    o => { o.token = 'not-accepted'; },
    o => { o.proxyURL = 'https://api.github.com'; },
    o => { o.proxyURL = 'http://attacker.example:8080'; },
    o => { o.proxyURL = 'http://user:password@eval-proxy:8080'; },
    o => { o.proxyURL = 'http://eval-proxy:8080/provider'; },
    o => { o.limits = { maxTurns: 2 }; },
    o => { o.limits = { totalTokens: 100 }; },
    o => { o.limits = { credits: 1 }; },
    o => { o.limits = { timeoutMs: 300001 }; }
  ]) {
    const { payload, broker } = nativeOptions(); mutate(broker);
    assert.throws(() => prepareNativeTaskSpecification(payload, broker));
  }
});

test('native grants remain exact with only explicit broker proxy and normal isolated account paths', () => {
  const { payload, broker } = nativeOptions();
  payload.inputs.push({ path: 'AI/README.md', content: 'public home\n', mountRoot: 'home' });
  const spec = prepareNativeTaskSpecification(payload, broker);
  assert.equal(spec.argv[spec.argv.indexOf('--model') + 1], broker.model);
  for (const flag of ['--no-custom-instructions', '--no-auto-update', '--no-ask-user',
    '--disable-builtin-mcps', '--disallow-temp-dir']) assert.ok(spec.argv.includes(flag));
  assert.ok(spec.argv.includes('read(/workspace/fixtures/notes.txt)'));
  assert.ok(spec.argv.includes('read(/home/eval/AI/README.md)'));
  assert.ok(spec.argv.includes('write(/workspace/caller-output.txt)'));
  assert.ok(spec.argv.includes('write(/client-config/**)'));
  assert.ok(!spec.argv.some(arg => /--allow-all|--yolo|--trust|API_KEY/.test(arg)));
  assert.equal(spec.env.COPILOT_HOME, broker.authRoot);
  assert.equal(spec.env.HTTP_PROXY, broker.proxyURL);
  assert.equal(spec.env.HTTPS_PROXY, broker.proxyURL);
  assert.equal(spec.env.ALL_PROXY, broker.proxyURL);
  assert.equal(spec.env.NO_PROXY, '');
  assert.equal(spec.env.http_proxy, broker.proxyURL);
  assert.equal(spec.env.https_proxy, broker.proxyURL);
  assert.equal(spec.env.all_proxy, broker.proxyURL);
  assert.equal(spec.env.no_proxy, '');
  assert.ok(!Object.keys(spec.env).some(key => /TOKEN|API_KEY|COPILOT_PROVIDER|COPILOT_MODEL/.test(key)));
  assert.deepEqual(validateNativeTaskEnvelope(spec.envelope).limits, spec.limits);
});

test('native bootstrap envelope independently rejects rewritten poison paths/options before execution', () => {
  const { payload, broker } = nativeOptions();
  const spec = prepareNativeTaskSpecification(payload, broker);
  for (const mutate of [
    e => { e.inputs[0].path = '../client-config/copilot/config.json'; },
    e => { e.inputs[0].path = '.claude/settings.json'; },
    e => { e.inputs[0].content = 'x'.repeat(TASK_CAPS.fileBytes + 1); },
    e => { e.inputs[0].executable = 'yes'; },
    e => { e.artifactTargets = ['.mcp.json']; },
    e => { e.artifactTargets = ['fixtures/notes.txt']; },
    e => { e.model = 'offline-fixture-model'; },
    e => { e.authRoot = '/home/eval'; },
    e => { e.proxyURL = 'http://api.github.com:8080'; },
    e => { e.limits.maxTokens = 1; },
    e => { e.mock = {}; }
  ]) {
    const envelope = structuredClone(spec.envelope); mutate(envelope);
    assert.throws(() => validateNativeTaskEnvelope(envelope));
  }
  const runtime = fs.readFileSync(path.join(root, 'native-runtime.mjs'), 'utf8');
  assert.ok(!/createNativeProtocolFixture|createServer|PROVIDER_API_KEY|PROVIDER_BASE_URL|mock\.|taskProtocolSteps/.test(runtime));
});

test('native observer binds actual structured prompt/model/skill/tools, keeps usage units and original byte handle', () => {
  const { payload, broker } = nativeOptions();
  const spec = prepareNativeTaskSpecification(payload, broker);
  const observation = parseNativeTaskEvidence(nativeUnitObservation(spec));
  assert.equal(observation.observationOnly, true);
  assert.equal(observation.liveAccepted, false);
  assert.equal(observation.authenticationVerified, false);
  assert.equal(observation.model.observed, broker.model);
  assert.equal(observation.model.provider, 'native-account-client-reported');
  assert.equal(observation.model.matches, true);
  assert.equal(observation.prompt.nativeObservedHash, hashContent(payload.prompt));
  assert.equal(observation.prompt.submittedHash, hashContent(payload.prompt));
  assert.equal(observation.prompt.providerWireHash, null);
  assert.equal(observation.submittedStdin.observed, true);
  assert.equal(observation.catalog.complete, true);
  assert.equal(observation.catalog.tools.available, null);
  assert.equal(observation.catalog.plugins, null);
  assert.equal(observation.trigger.loaded, true);
  assert.equal(observation.trigger.providerWireContextVerified, false);
  assert.equal(observation.completion.status, 'completed');
  assert.equal(observation.usage.inputTokens.value, 12);
  assert.equal(observation.usage.outputTokens.value, 7);
  assert.equal(observation.nativeUsage.tokens.cacheReadTokens.value, 4);
  assert.equal(observation.nativeUsage.totalNanoAiu.value, 987654321);
  assert.equal(observation.nativeUsage.totalNanoAiu.unit, 'nanoAIU');
  assert.deepEqual(observation.usage.credits, { value: null, provenance: 'unavailable' });
  assert.deepEqual(observation.usage.usd, { value: null, provenance: 'unavailable' });
  assert.equal(observation.usage.elapsedMs.value, 55);
  assert.ok(!observation.blockers.length);
  assert.equal(readNativeTaskArtifact(observation, 'caller-output.txt').toString(), 'Independent canned output\n');
  readNativeTaskArtifact(observation, 'caller-output.txt').fill(0);
  assert.equal(readNativeTaskArtifact(observation, 'caller-output.txt').toString(), 'Independent canned output\n');
  assert.throws(() => readNativeTaskArtifact(structuredClone(observation), 'caller-output.txt'));
});

test('submitted model/hash/prose and unknown usage never become native observation or zero consumption', () => {
  const { payload, broker } = nativeOptions();
  const spec = prepareNativeTaskSpecification(payload, broker);
  const input = nativeUnitObservation(spec);
  input.stdout = input.stdout.split('\n').filter(line =>
    !['model.call_start', 'model.call_final_result', 'user.message'].includes(JSON.parse(line).type)).join('\n');
  delete input.usage;
  delete input.submittedStdin;
  const observation = parseNativeTaskEvidence(input);
  assert.equal(observation.model.observed, null);
  assert.equal(observation.model.provider, null);
  assert.equal(observation.prompt.nativeObservedHash, null);
  assert.equal(observation.prompt.recorded, false);
  assert.equal(observation.submittedStdin.observed, false);
  assert.equal(observation.usage.inputTokens.value, null);
  assert.equal(observation.usage.outputTokens.value, null);
  assert.equal(observation.nativeUsage.totalNanoAiu.value, null);
  assert.ok(observation.blockers.includes('NATIVE_DISPATCH_MODEL_UNBOUND'));
  assert.ok(observation.blockers.includes('NATIVE_PROMPT_NOT_RECORDED'));
  input.elapsedMs = 0;
  assert.deepEqual(parseNativeTaskEvidence(input).usage.elapsedMs,
    { value: 0, provenance: 'broker-supervised-native-wall-clock' });
});

test('native HOME catalog cannot borrow offline provider XML or assistant claims; no-skill requires actual audit', () => {
  for (const arm of ['candidate', 'baseline', 'no-skill']) {
    const { payload, broker } = nativeOptions(arm);
    payload.inputs.push({ path: 'AI/README.md', content: 'Public home\n', mountRoot: 'home' });
    const spec = prepareNativeTaskSpecification(payload, broker);
    const input = nativeUnitObservation(spec);
    const full = parseNativeTaskEvidence(input);
    assert.equal(full.catalog.complete, true);
    assert.equal(full.trigger.loaded, arm !== 'no-skill');
    assert.equal(full.trigger.homeAuditLiveVerified, false);
    input.stdout = input.stdout.split('\n').filter(line =>
      JSON.parse(line).type !== 'session.skills_loaded').join('\n');
    const incomplete = parseNativeTaskEvidence(input);
    assert.equal(incomplete.catalog.complete, false);
    assert.equal(incomplete.trigger.auditComplete, false);
    assert.equal(incomplete.trigger.loaded, false);
    assert.ok(incomplete.blockers.includes('NATIVE_DISCOVERY_AUDIT_INCOMPLETE'));
  }
});

test('native observer rejects forged handles/partial traces and reports model/BYOK/filesystem violations without grades', () => {
  const { payload, broker } = nativeOptions();
  const spec = prepareNativeTaskSpecification(payload, broker);
  const input = nativeUnitObservation(spec);
  assert.throws(() => parseNativeTaskEvidence({ ...input, specification: structuredClone(spec) }));
  assert.throws(() => parseNativeTaskEvidence({ ...input, stdout: input.stdout.split('\n').slice(0, -1).join('\n') }));
  assert.throws(() => parseNativeTaskEvidence({ ...input, submittedStdin: { sha256: '0'.repeat(64), bytes: spec.stdinBytes } }));
  assert.throws(() => parseNativeTaskEvidence({ ...input, authenticated: true }));
  const mismatched = nativeUnitObservation(spec);
  mismatched.stdout = mismatched.stdout.replaceAll('"model":"gpt-5"', '"model":"other-native-model"')
    .replace('"isByok":false', '"isByok":true');
  mismatched.filesystemEvidence.after[0].readonly = false;
  const observation = parseNativeTaskEvidence(mismatched);
  assert.equal(observation.model.observed, 'other-native-model');
  assert.equal(observation.model.matches, false);
  assert.ok(observation.blockers.includes('NATIVE_PROVIDER_MODE_MISMATCH'));
  assert.ok(observation.blockers.includes('NATIVE_FILESYSTEM_BOUNDARY_CHANGED'));
  assert.ok(!Object.hasOwn(observation, 'checks'));
  const corrupt = nativeUnitObservation(spec);
  corrupt.filesystemEvidence.artifacts[0].base64 = Buffer.from('not actual bytes').toString('base64');
  assert.throws(() => parseNativeTaskEvidence(corrupt), error => error.code === 'NATIVE_ARTIFACT_RECORD_INVALID');
});

const docker = process.env.EVAL_CLIENT_COPILOT_TASKS_DOCKER === '1';
test('NEW actual native Copilot task: arbitrary prompt/skill/workspace/HOME bytes, nested disk outputs and fresh negative/control',
  { skip: !docker, timeout: 600000 }, async t => {
    const nonce = randomUUID();
    const skillId = `caller-native-${nonce.slice(0, 8)}`;
    const target = `reports\\native-${nonce}.txt`;
    const second = `selected-${nonce}.md`;
    const absent = `not-selected-${nonce}.txt`;
    const body = `UNIQUE_NATIVE_SKILL_BODY_${nonce}\nRead the supplied companion text before writing.\n`;
    const fixture = `UNIQUE_NATIVE_INPUT_${nonce}\n`;
    const support = `UNIQUE_NATIVE_SUPPORT_${nonce}\n`;
    const layout = `UNIQUE_NATIVE_LAYOUT_${nonce}\n`;
    const home = `UNIQUE_NATIVE_HOME_AI_${nonce}\n`;
    const instructionFixture = `# Ordinary fixture, not automatic policy\nUNIQUE_NOT_AUTOLOADED_${nonce}\n`;
    const output = `Caller-selected actual native bytes: café ${nonce}\n`;
    const secret = `HOST_ONLY_EXPECTATION_${randomUUID()}`;
    const options = {
      task: { invocationId: `native-${nonce}`, caseId: 'parameterized-task', client: 'copilot',
        arm: 'candidate', repeat: 1, fixtureHash: hashContent(fixture) },
      prompt: `Unique native prompt ${nonce}. Use ${skillId}, read the supplied files, and create the requested artifacts. token: public-literal`,
      skill: { id: skillId, files: [
        { path: 'SKILL.md', content: `---\nname: ${skillId}\ndescription: Caller-defined native task, not the fixed probe skill.\n---\n${body}` },
        { path: 'references\\companion.txt', content: Buffer.from(support) }
      ] },
      inputs: [
        { path: 'fixtures\\caller.txt', content: Buffer.from(fixture) },
        { path: 'layout\\caller-layout.md', content: layout },
        { path: 'AGENTS.md', content: instructionFixture, executable: false },
        { path: 'docs\\opencode.jsonc', content: `{"fixture":"DOC_JSON_NOT_AUTO_CONFIG_${nonce}"}\n` },
        { path: 'AI\\README.md', content: Buffer.from(home), mountRoot: 'home' }
      ],
      checks: [
        declaration('artifact-contains', output, target, 'caller-content'),
        declaration('artifact-exists', true, second, 'second-created'),
        { ...declaration('artifact-exists', false, absent, 'not-selected'), class: 'safety' },
        declaration('artifact-contains', secret, target, 'independent-private-expectation')
      ],
      mock: { loadSkill: true, artifacts: [
        { path: target, content: output }, { path: second, content: `SECOND_CALLER_BYTES_${nonce}\n` }
      ] },
      timeoutMs: 180000
    };
    const positive = await runOfflineTask(options);
    assert.deepEqual(positive.task, options.task);
    assert.equal(positive.clientVersion, '1.0.92');
    assert.equal(positive.promptHash, hashContent(options.prompt));
    assert.match(positive.image, /^sha256:[a-f0-9]{64}$/);
    assert.equal(positive.transport, 'offline-mock');
    assert.equal(positive.offlineEvidenceOnly, true);
    assert.equal(positive.authenticationVerified, false);
    assert.equal(positive.liveAccepted, false);
    assert.equal(positive.status, 'completed');
    assert.equal(positive.trigger.loaded, true);
    assert.equal(positive.trigger.auditComplete, true);
    assert.equal(positive.evidence.native.reads.length, 7);
    assert.ok(positive.evidence.native.reads.every(read => read.fullContentSeen));
    assert.ok(positive.evidence.native.reads.some(read =>
      read.path === '/home/eval/AI/README.md' && read.sha256 === hashContent(home)));
    assert.equal(positive.trigger.auditSource, 'actual-first-provider-request-system-available_skills');
    assert.ok(!positive.evidence.native.requests[0].seedTextInitiallySeen.includes('/workspace/AGENTS.md'));
    assert.ok(!positive.evidence.native.requests[0].seedTextInitiallySeen.includes('/workspace/docs/opencode.jsonc'));
    assert.equal(positive.evidence.native.boundary.accepted, true);
    assert.equal(positive.evidence.native.boundary.denials.length, 15);
    assert.equal(readCapturedArtifact(positive.capture, target).toString(), output);
    assert.equal(readCapturedArtifact(positive.capture, second).toString(), `SECOND_CALLER_BYTES_${nonce}\n`);
    assert.deepEqual(positive.checks.map(check => check.status), ['passed', 'passed', 'passed', 'failed']);
    assert.deepEqual(gradeChecks({ checks: options.checks, capture: positive.capture }).checks, positive.checks);
    assert.ok(!JSON.stringify(positive.evidence.native).includes(secret));
    assert.deepEqual(Object.keys(positive.usage).sort(), ['credits', 'elapsedMs', 'inputTokens', 'outputTokens', 'usd']);
    for (const key of ['inputTokens', 'outputTokens', 'usd', 'credits']) {
      assert.deepEqual(positive.usage[key], { value: null, provenance: 'unavailable' });
    }
    assert.ok(positive.usage.elapsedMs.value > 0);
    assert.match(positive.usage.elapsedMs.provenance, /^supervised-native-task-wall-clock/);
    assert.ok(positive.runtime.nativeElapsedMs > 0);
    assert.match(positive.cleanup, /^verified-/);
    const negativeOptions = { ...options, task: { ...options.task, arm: 'baseline', repeat: 2 },
      prompt: `Unique negative ${nonce}: do not load the skill; write the canned artifact.`,
      mock: { ...options.mock, loadSkill: false } };
    const negative = await runOfflineTask(negativeOptions);
    assert.equal(negative.trigger.discovered, true);
    assert.equal(negative.trigger.loaded, false);
    assert.equal(negative.trigger.auditComplete, true);
    assert.equal(negative.evidence.native.reads.length, 5);
    assert.equal(negative.evidence.native.boundary.denials.length, 15);
    const controlOptions = { ...negativeOptions, task: { ...options.task, arm: 'no-skill', repeat: 3 },
      prompt: `Unique no-skill control ${nonce}: create the independently scripted files.`,
      skill: { id: skillId, files: [] } };
    const control = await runOfflineTask(controlOptions);
    assert.equal(control.trigger.discovered, false);
    assert.equal(control.trigger.loaded, false);
    assert.equal(control.trigger.auditComplete, true);
    assert.equal(control.evidence.native.boundary.denials.length, 14);
    assert.equal(new Set([positive, negative, control].map(receipt => receipt.executionId)).size, 3);
    assert.equal(new Set([positive, negative, control].map(receipt => receipt.runtime.nativeInteractionId)).size, 3);
    for (const receipt of [negative, control]) {
      assert.equal(receipt.status, 'completed');
      assert.equal(readCapturedArtifact(receipt.capture, target).toString(), output);
      assert.equal(receipt.evidence.native.boundary.accepted, true);
    }
    t.diagnostic(JSON.stringify({ version: positive.clientVersion, image: positive.image,
      executions: [positive, negative, control].map(receipt => ({
        executionId: receipt.executionId, promptHash: receipt.promptHash, loaded: receipt.trigger.loaded,
        auditComplete: receipt.trigger.auditComplete, auditSource: receipt.trigger.auditSource,
        nativeReads: receipt.evidence.native.reads.length,
        nativeCreates: receipt.evidence.native.tools.filter(tool => tool.kind === 'artifact-create').length,
        denied: receipt.evidence.native.boundary.denials.length,
        checks: receipt.checks.map(check => check.status), elapsedMs: Math.round(receipt.usage.elapsedMs.value),
        cleanup: receipt.cleanup
      })), offlineEvidenceOnly: true, liveAccepted: false }));
  });
