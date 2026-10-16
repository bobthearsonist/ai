import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ToolWorkerError } from '../harness/tool-worker/worker.mjs';
import { createWiringOnlyIssuer } from './fixtures/client-tool-transport-wiring-issuer.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const payloadFor = () => ({
  task: { invocationId: 'claude-transport-unit', caseId: 'worker-path-case', client: 'claude-code',
    arm: 'candidate', repeat: 1, fixtureHash: 'c'.repeat(64) },
  prompt: 'Use selected-transport-skill to write reports\\result.txt from the declared note.',
  skill: { id: 'selected-transport-skill', files: [
    { path: 'SKILL.md', content:
      '---\nname: selected-transport-skill\ndescription: Use declared public notes\n---\nLoad the public companion.\n' },
    { path: 'references\\guide.txt', content: Buffer.from('PUBLIC_SELECTED_SKILL_BYTES\r\n') }
  ] },
  inputs: [{ path: 'notes\\input.txt', content: Buffer.from('PUBLIC_WORKER_INPUT_BYTES\r\n') }],
  artifactTargets: ['reports\\result.txt']
});
const options = { model: 'claude-sonnet-4-6', authRoot: '/home/node/.claude', proxyURL: 'http://127.0.0.1:8080' };

test('Claude sterile MCP planning (wiring doubles only; not native, MCP or Skill evidence)', async t => {
  // Explicit module double over the pure identity guard; the issuer is a wiring-only fixture.
  const issuer = createWiringOnlyIssuer();
  t.mock.module('../harness/tool-worker/index.mjs', {
    namedExports: { ToolWorkerError, describeToolWorkerTransportBinding: tuple => issuer.describe(tuple) }
  });
  const { prepareNativeTaskSpecification, parseNativeTaskEvidence } =
    await import('../harness/clients/claude-code/native.mjs');
  const arg = (spec, name) => spec.argv[spec.argv.indexOf(name) + 1];
  const prepare = (payload, tuple, extra = {}) =>
    prepareNativeTaskSpecification(payload, { ...options, toolTransport: tuple, ...extra });

  await t.test('default specification is unchanged and has no transport fields', () => {
    const spec = prepareNativeTaskSpecification(payloadFor(), options);
    assert.equal(arg(spec, '--tools'), 'Skill,Read,Write');
    assert.equal(arg(spec, '--mcp-config'), '{"mcpServers":{}}');
    assert.equal(spec.limits.timeoutMs, 180000);
    assert.equal(Object.hasOwn(spec, 'toolTransport'), false);
    assert.equal(Object.hasOwn(spec, 'nativeToolPolicy'), false);
  });

  await t.test('plans exactly Skill plus three fixed MCP tools with unverified managed policy', () => {
    const payload = payloadFor(), tuple = issuer.issue(payload);
    const spec = prepare(payload, tuple);
    const names = ['eval_read_public', 'eval_write_artifact', 'eval_read_artifact'].map(n => `mcp__eval_tools__${n}`);
    assert.equal(arg(spec, '--tools'), 'Skill');
    assert.equal(arg(spec, '--allowedTools'), ['Skill(selected-transport-skill)', ...names].join(','));
    assert.equal(arg(spec, '--disallowedTools'), 'Bash,Read,Write,Edit,NotebookEdit,WebFetch,WebSearch');
    assert.equal(arg(spec, '--setting-sources'), 'project');
    assert.ok(spec.argv.includes('--strict-mcp-config'));
    assert.ok(!spec.argv.includes('--bare') && !spec.argv.includes('--restricted'));
    assert.deepEqual(JSON.parse(arg(spec, '--mcp-config')), { mcpServers: { eval_tools: {
      command: tuple.binding.stdioCommand[0], args: tuple.binding.stdioCommand.slice(1), env: {} } } });
    assert.deepEqual(spec.settings.permissions.allow, ['Skill(selected-transport-skill)', ...names]);
    assert.equal(spec.settings.disableAllHooks, true);
    assert.equal(spec.toolTransport.binding, tuple.binding);
    assert.equal(spec.stdin.text, payload.prompt);
    assert.equal(spec.nativeToolPolicy.managedPolicyVerified, false);
    assert.ok(spec.nativeToolPolicy.admissionBlockers.includes('managed-policy-absence-unverified'));
    for (const key of ['nativeAdmissionSupported', 'nativeRuntimeAdmitted', 'credentialBoundaryVerified',
      'nativeDiscoveryVerified']) assert.equal(spec.nativeToolPolicy[key], false);
    assert.equal(spec.authenticationVerified, false);
    assert.equal(spec.liveAccepted, false);
    assert.equal(spec.planningOnly, true);
    assert.equal(spec.limits.timeoutMs, 60000);
    assert.deepEqual(spec.targets, []);
    assert.deepEqual(spec.sourceFiles.map(file => file.kind), ['skill', 'skill']);
    const encoded = JSON.stringify(spec);
    assert.ok(!encoded.includes('PUBLIC_WORKER_INPUT_BYTES') && !encoded.includes('"lease"') && !encoded.includes('"worker":'));
    assert.equal(spec.sourceFiles[1].sha256, hash('PUBLIC_SELECTED_SKILL_BYTES\r\n'));
    assert.throws(() => parseNativeTaskEvidence({ specification: spec }), { code: 'NATIVE_TOOL_TRANSPORT_OBSERVER_UNSUPPORTED' });
  });

  await t.test('no-skill arm exposes no builtin tool and only MCP tools', () => {
    const payload = payloadFor();
    payload.task.arm = 'no-skill'; payload.skill.files = []; payload.artifactTargets = [];
    const spec = prepare(payload, issuer.issue(payload));
    assert.equal(arg(spec, '--tools'), '');
    assert.ok(!arg(spec, '--allowedTools').includes('Skill'));
  });

  await t.test('timeout above the fixed worker lifetime is rejected', () => {
    const payload = payloadFor();
    assert.throws(() => prepare(payload, issuer.issue(payload), { limits: { timeoutMs: 60001 } }),
      { code: 'NATIVE_SPEC_INVALID' });
  });

  await t.test('copies, mismatches, expiry and substituted config fail without fallback', () => {
    const payload = payloadFor(), tuple = issuer.issue(payload);
    for (const copied of [structuredClone(tuple), { ...tuple, binding: { ...tuple.binding } }])
      assert.throws(() => prepare(payload, copied), error => /ORIGINAL_.*REQUIRED/.test(error.code));
    assert.throws(() => prepare(payload, issuer.issue({ ...payload, task: { ...payload.task, repeat: 2 } })),
      { code: 'NATIVE_TOOL_TRANSPORT_TASK_MISMATCH' });
    assert.throws(() => prepare(payload, issuer.issue(payload, { sourceHash: '0'.repeat(64) })),
      { code: 'NATIVE_TOOL_TRANSPORT_SOURCE_MISMATCH' });
    assert.throws(() => prepare(payload, issuer.issue({ ...payload, artifactTargets: ['other/result.txt'] })),
      { code: 'NATIVE_TOOL_TRANSPORT_TARGET_MISMATCH' });
    assert.throws(() => prepare(payload, issuer.issue(payload, { shimHash: '0'.repeat(64) })),
      { code: 'NATIVE_TOOL_TRANSPORT_BINDING_INVALID' });
    const expired = issuer.issue(payload);
    issuer.expire(expired);
    assert.throws(() => prepare(payload, expired), { code: 'TIMEOUT' });
    for (const extra of [{ command: ['caller'] }, { env: { PRIVATE_KEY: 'x' } }, { path: 'C:\\private' }])
      assert.throws(() => prepare(payload, { ...tuple, ...extra }));
    assert.throws(() => prepare({ ...payload, checks: 'HOST_ONLY_PRIVATE_BYTES' }, tuple));
  });
});
