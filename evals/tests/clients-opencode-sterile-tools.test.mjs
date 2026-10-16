import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolWorkerError } from '../harness/tool-worker/worker.mjs';
import { createWiringOnlyIssuer } from './fixtures/client-tool-transport-wiring-issuer.mjs';

const payload = (arm = 'candidate') => ({
  task: { invocationId: 'oc-sterile', caseId: 'case', client: 'opencode', arm, repeat: 1, fixtureHash: 'c'.repeat(64) },
  prompt: 'Use selected-skill to write reports\\result.txt from the declared note.',
  skill: { id: 'selected-skill', files: arm === 'no-skill' ? [] : [
    { path: 'SKILL.md', content: '---\nname: selected-skill\ndescription: Use notes\n---\nLoad the companion.\n' },
    { path: 'references\\guide.txt', content: Buffer.from('PUBLIC_SKILL\r\n') }] },
  inputs: [{ path: 'notes\\input.txt', content: Buffer.from('PUBLIC_INPUT\r\n') }],
  artifactTargets: ['reports\\result.txt']
});
const options = { model: 'openai/gpt-5.4', authRoot: '/work/auth/native', proxyURL: 'http://127.0.0.1:8080' };

test('OpenCode plans the original fixed MCP command under a deny-by-default native policy (no execution)', async t => {
  const issuer = createWiringOnlyIssuer();
  t.mock.module('../harness/tool-worker/index.mjs', {
    namedExports: { ToolWorkerError, describeToolWorkerTransportBinding: tuple => issuer.describe(tuple) }
  });
  const { prepareNativeTaskSpecification } = await import('../harness/clients/opencode/native-spec.mjs');

  await t.test('default without toolTransport is unchanged', () => {
    const p = payload();
    const spec = prepareNativeTaskSpecification(p, options);
    assert.equal(Object.hasOwn(spec, 'toolTransport'), false);
    assert.deepEqual(spec.config.mcp, {});
    assert.equal(spec.config.permission.read['/work/project/notes/input.txt'], 'allow');
    assert.equal(spec.env.OPENCODE_PERMISSION, undefined);
    assert.equal(spec.env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined);
  });

  await t.test('exact tool/config plan, original prompt and all admission flags', () => {
    const p = payload(), tuple = issuer.issue(p);
    const base = prepareNativeTaskSpecification(payload(), options);
    const spec = prepareNativeTaskSpecification(p, { ...options, toolTransport: tuple });
    const plan = spec.toolTransport;
    const command = tuple.binding.stdioCommand;
    assert.deepEqual(spec.config.mcp, { eval_tools: { type: 'local', command, environment: {}, enabled: true } });
    assert.deepEqual(Object.keys(spec.config.mcp), ['eval_tools']);
    const ids = ['eval_tools_eval_read_public', 'eval_tools_eval_write_artifact', 'eval_tools_eval_read_artifact'];
    assert.deepEqual(plan.nativeToolIds, ids);
    assert.deepEqual(spec.config.permission, {
      '*': 'deny', skill: { '*': 'deny', 'selected-skill': 'allow' }, ...Object.fromEntries(ids.map(id => [id, 'allow']))
    });
    assert.equal(spec.env.OPENCODE_PERMISSION, JSON.stringify(spec.config.permission));
    assert.equal(spec.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
    assert.deepEqual(spec.config.plugin, []);
    assert.deepEqual(spec.config.instructions, []);
    assert.deepEqual(plan.artifactMap, [{ target: 'reports/result.txt', workerPath: 'artifacts/reports/result.txt' }]);
    assert.deepEqual(plan.publicFiles.map(f => f.path), [
      'skills/selected-skill/SKILL.md', 'skills/selected-skill/references/guide.txt', 'inputs/notes/input.txt']);
    assert.deepEqual(spec.stdin, base.stdin);
    assert.deepEqual(spec.args, base.args);
    assert.deepEqual(spec.materialization, base.materialization);
    assert.deepEqual(spec.seeds, base.seeds);
    for (const flag of ['nativeAdmissionSupported', 'nativeDiscoveryVerified', 'authenticationVerified',
      'freshKernelVerification', 'liveAccepted']) assert.equal(plan[flag], false);
    assert.equal(plan.planningOnly, true);
    assert.equal(spec.authenticationVerified, false);
    assert.equal(spec.containmentVerified, false);
    assert.equal(spec.liveAccepted, false);
    assert.ok(spec.blockers.includes('native-late-account-wellknown-managed-config-absence-unverified'));
    assert.ok(plan.requiredObservations.length >= 5);
    const encoded = JSON.stringify(spec);
    assert.ok(!encoded.includes('PUBLIC_INPUT') && !encoded.includes('"worker":') && !encoded.includes('"lease":'));
    assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.toolTransport.mcp.eval_tools.command));
  });

  await t.test('no-skill keeps no skill permission and only the three tools', () => {
    const p = payload('no-skill'), spec = prepareNativeTaskSpecification(p,
      { ...options, toolTransport: issuer.issue(p) });
    assert.equal(Object.hasOwn(spec.config.permission, 'skill'), false);
    assert.equal(spec.toolTransport.skillTool, null);
  });

  await t.test('copies, foreign coordinates, source/target drift and terminal originals fail without fallback', () => {
    const p = payload(), tuple = issuer.issue(p), other = issuer.issue(p);
    for (const copied of [{ ...tuple }, JSON.parse(JSON.stringify(tuple)), { ...tuple, binding: other.binding },
      { ...tuple, worker: other.worker }, { ...tuple, binding: { ...tuple.binding } }]) {
      if (copied.worker === tuple.worker && copied.binding === tuple.binding && copied.lease === tuple.lease &&
        copied.task === tuple.task) continue;
      assert.throws(() => prepareNativeTaskSpecification(p, { ...options, toolTransport: copied }),
        error => /ORIGINAL_.*REQUIRED/.test(error.code));
    }
    assert.throws(() => prepareNativeTaskSpecification(p, { ...options,
      toolTransport: issuer.issue({ ...p, task: { ...p.task, repeat: 2 } }) }), { code: 'NATIVE_TOOL_TRANSPORT_TASK_MISMATCH' });
    assert.throws(() => prepareNativeTaskSpecification(p, { ...options,
      toolTransport: issuer.issue(p, { sourceHash: '0'.repeat(64) }) }), { code: 'NATIVE_TOOL_TRANSPORT_SOURCE_MISMATCH' });
    assert.throws(() => prepareNativeTaskSpecification(p, { ...options,
      toolTransport: issuer.issue({ ...p, artifactTargets: ['other.txt'] }) }), { code: 'NATIVE_TOOL_TRANSPORT_TARGET_MISMATCH' });
    assert.throws(() => prepareNativeTaskSpecification(p, { ...options,
      toolTransport: issuer.issue(p, { shimHash: '0'.repeat(64) }) }), { code: 'NATIVE_TOOL_TRANSPORT_BINDING_INVALID' });
    for (const [action, code] of [['close', 'WORKER_NOT_READY'], ['cancel', 'CANCELLED'], ['expire', 'TIMEOUT']]) {
      const q = payload(), tuple2 = issuer.issue(q);
      issuer[action](tuple2);
      assert.throws(() => prepareNativeTaskSpecification(q, { ...options, toolTransport: tuple2 }), { code });
    }
    for (const key of ['checks', 'credentials', 'expected']) {
      assert.throws(() => prepareNativeTaskSpecification({ ...p, [key]: 'HOST_ONLY_SECRET' },
        { ...options, toolTransport: tuple }), error => !error.message.includes('HOST_ONLY_SECRET'));
    }
    assert.throws(() => prepareNativeTaskSpecification(p, { ...options, toolTransport: undefined }));
    assert.throws(() => prepareNativeTaskSpecification(p, { ...options, toolTransport: { ...tuple, command: ['x'] } }));
  });
});