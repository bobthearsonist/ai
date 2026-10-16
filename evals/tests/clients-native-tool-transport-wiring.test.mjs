import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ToolWorkerError } from '../harness/tool-worker/worker.mjs';
import { MCP_TOOLS } from '../harness/tool-worker/mcp-shim.mjs';
import { createWiringOnlyIssuer } from './fixtures/client-tool-transport-wiring-issuer.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clients = ['claude-code', 'copilot', 'opencode'];
const payloadFor = client => ({
  task: { invocationId: 'native-transport-unit', caseId: 'worker-path-case', client,
    arm: 'candidate', repeat: 1, fixtureHash: 'c'.repeat(64) },
  prompt: 'Use selected-transport-skill to write reports\\result.txt from the declared note.',
  skill: { id: 'selected-transport-skill', files: [
    { path: 'SKILL.md', content:
      '---\nname: selected-transport-skill\ndescription: Use declared public notes\n---\nLoad the public companion before writing the target.\n' },
    { path: 'references\\guide.txt', content: Buffer.from('PUBLIC_SELECTED_SKILL_BYTES\r\n') }
  ] },
  inputs: [{ path: 'notes\\input.txt', content: Buffer.from('PUBLIC_WORKER_INPUT_BYTES\r\n') }],
  artifactTargets: ['reports\\result.txt']
});
const optionsFor = client => client === 'claude-code'
  ? { model: 'claude-sonnet-4-6', authRoot: '/home/node/.claude', proxyURL: 'http://127.0.0.1:8080' }
  : client === 'copilot'
    ? { model: 'gpt-5.4', authRoot: '/client-config/copilot', proxyURL: 'http://127.0.0.1:8080' }
    : { model: 'openai/gpt-5.4', authRoot: '/work/auth/native', proxyURL: 'http://127.0.0.1:8080' };

test('optional native transport wiring only: mock Docker issuance is not native/MCP/Skill acceptance', async t => {
  const issuer = createWiringOnlyIssuer();
  let descriptions = 0;
  t.mock.module('../harness/tool-worker/index.mjs', {
    namedExports: {
      ToolWorkerError,
      describeToolWorkerTransportBinding: tuple => { descriptions++; return issuer.describe(tuple); }
    }
  });
  const claude = await import('../harness/clients/claude-code/native.mjs');
  const copilot = await import('../harness/clients/copilot/native-spec.mjs');
  const opencode = await import('../harness/clients/opencode/native-spec.mjs');
  const { prepareNativeToolTransport } = await import('../harness/clients/claude-code/tool-transport.mjs');
  const { validateNativeTaskEnvelope } = await import('../harness/clients/copilot/native-envelope.mjs');
  const { parseNativeTaskEvidence } = await import('../harness/clients/copilot/native-parser.mjs');
  const builders = { 'claude-code': claude.prepareNativeTaskSpecification,
    copilot: copilot.prepareNativeTaskSpecification, opencode: opencode.prepareNativeTaskSpecification };
  const prepare = (client, payload, tuple) => builders[client](payload,
    { ...optionsFor(client), toolTransport: tuple });

  await t.test('absent transport keeps native prompts, tools, source staging and old observers unchanged', () => {
    const before = descriptions;
    for (const client of clients) {
      const payload = payloadFor(client);
      const spec = builders[client](payload, optionsFor(client));
      assert.equal(Object.hasOwn(spec, 'toolTransport'), false);
      assert.equal(spec.authenticationVerified, false);
      assert.equal(spec.liveAccepted, false);
      if (client === 'claude-code') {
        assert.equal(spec.stdin.text, payload.prompt);
        assert.equal(spec.argv[spec.argv.indexOf('--tools') + 1], 'Skill,Read,Write');
        assert.equal(spec.argv[spec.argv.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
        assert.equal(spec.argv[spec.argv.indexOf('--setting-sources') + 1], 'project');
        assert.equal(spec.sourceFiles.filter(file => file.kind === 'input').length, 1);
        assert.equal(claude.describeNativeTaskSpecification(spec), spec);
      } else if (client === 'copilot') {
        assert.equal(spec.envelope.prompt, payload.prompt);
        assert.ok(spec.argv.includes('view') && spec.argv.includes('create'));
        assert.doesNotThrow(() => copilot.assertNativeTaskSpecification(spec));
      } else {
        assert.equal(spec.stdin.text, payload.prompt);
        assert.deepEqual(spec.config.mcp, {});
        assert.equal(spec.config.permission.read['/work/project/notes/input.txt'], 'allow');
        assert.doesNotThrow(() => opencode.assertOriginalNativeTaskSpecification(spec));
      }
    }
    assert.equal(descriptions, before);
  });

  await t.test('client-local validation describes only the exact original fixed shim and three worker tools', () => {
    const payload = payloadFor('claude-code');
    const tuple = issuer.issue(payload);
    const original = issuer.describe(tuple);
    const transport = prepareNativeToolTransport(tuple, {
      task: payload.task, publicFiles: original.publicFiles, artifactTargets: ['reports/result.txt']
    });
    assert.equal(transport.binding, tuple.binding);
    assert.equal(transport.serverName, 'eval_tools');
    assert.deepEqual(transport.mcpConfig, {
      command: tuple.binding.stdioCommand[0], args: tuple.binding.stdioCommand.slice(1), env: {}
    });
    assert.deepEqual(transport.tools, MCP_TOOLS);
    assert.ok(transport.tools.every(tool => tool.inputSchema.additionalProperties === false));
    assert.deepEqual(transport.artifactMap, [{ target: 'reports/result.txt', workerPath: 'artifacts/reports/result.txt' }]);
    assert.deepEqual(transport.publicFiles.map(file => file.path), [
      'skills/selected-transport-skill/SKILL.md',
      'skills/selected-transport-skill/references/guide.txt', 'inputs/notes/input.txt'
    ]);
    const encoded = JSON.stringify(transport);
    assert.ok(!encoded.includes('PUBLIC_WORKER_INPUT_BYTES') && !encoded.includes('PUBLIC_SELECTED_SKILL_BYTES'));
    assert.ok(!encoded.includes('"worker":') && !encoded.includes('"lease":'));
    assert.deepEqual(Object.keys(transport.mcpConfig), ['command', 'args', 'env']);
    assert.ok(!Object.hasOwn(transport, 'transportMount') && !Object.hasOwn(transport, 'shimSource'));
    for (const key of ['authenticationVerified', 'nativeDiscoveryVerified', 'freshKernelVerification',
      'nativeAdmissionSupported', 'liveAccepted']) assert.equal(transport[key], false);
    assert.equal(transport.evidenceScope, 'worker-filesystem-only');
    assert.equal(transport.verification, 'cached-original-identity-only');
    assert.equal(transport.planningOnly, true);
    assert.equal(transport.deadlineUnixMs, tuple.binding.transportPolicy.deadlineUnixMs);
    assert.deepEqual(transport.limits, original.limits);
    assert.ok(Object.isFrozen(transport) && Object.isFrozen(transport.mcpConfig.args) &&
      Object.isFrozen(transport.mcpConfig.env));
    payload.inputs[0].content.fill(0);
    assert.equal(transport.publicFiles.at(-1).sha256, hash('PUBLIC_WORKER_INPUT_BYTES\r\n'));
  });

  await t.test('Claude and OpenCode plan the worker tools without native admission', () => {
    for (const client of ['claude-code', 'opencode']) {
      const payload = payloadFor(client);
      const spec = prepare(client, payload, issuer.issue(payload));
      assert.equal(spec.toolTransport.planningOnly, true);
      assert.equal(spec.toolTransport.nativeAdmissionSupported, false);
      const after = builders[client](payload, optionsFor(client));
      assert.equal(Object.hasOwn(after, 'toolTransport'), false);
    }
  });

  await t.test('Copilot plans the original MCP command, exact source-qualified tools and worker-only files without native acceptance', () => {
    const payload = payloadFor('copilot'), tuple = issuer.issue(payload);
    const spec = prepare('copilot', payload, tuple);
    const transport = spec.toolTransport;
    assert.equal(transport.binding, tuple.binding);
    assert.equal(transport.serverName, 'eval_tools');
    assert.deepEqual(transport.mcpConfig, {
      command: tuple.binding.stdioCommand[0], args: tuple.binding.stdioCommand.slice(1), env: {}
    });
    const config = JSON.parse(spec.argv[spec.argv.indexOf('--additional-mcp-config') + 1]);
    assert.deepEqual(config, { mcpServers: { eval_tools: transport.mcpConfig } });
    const available = ['builtin:skill', 'mcp:eval_tools-eval_read_public',
      'mcp:eval_tools-eval_write_artifact', 'mcp:eval_tools-eval_read_artifact'];
    assert.deepEqual(spec.argv.slice(spec.argv.indexOf('--available-tools') + 1,
      spec.argv.indexOf('--allow-tool')), available);
    assert.deepEqual(transport.nativeConfig.availableTools, available);
    assert.deepEqual(spec.argv.slice(spec.argv.indexOf('--allow-tool') + 1,
      spec.argv.indexOf('--deny-tool')), ['skill', 'eval_tools(eval_read_public)',
      'eval_tools(eval_write_artifact)', 'eval_tools(eval_read_artifact)']);
    assert.deepEqual(spec.argv.slice(spec.argv.indexOf('--deny-tool') + 1), ['shell', 'url', 'read', 'write']);
    assert.equal(spec.env.COPILOT_PLUGIN_DIR_ONLY, 'true');
    assert.equal(spec.env.COPILOT_HOME, optionsFor('copilot').authRoot);
    assert.deepEqual(transport.nativeConfig.settings, { disableAllHooks: true, ide: { autoConnect: false } });
    assert.ok(spec.argv.includes('--disable-builtin-mcps') && spec.argv.includes('--no-custom-instructions'));
    assert.ok(!spec.argv.some(value => /^--(?:allow-all|bare)/.test(value)));
    assert.deepEqual(spec.envelope.inputs, []);
    assert.deepEqual(spec.envelope.artifactTargets, []);
    assert.equal(spec.envelope.skill.files.length, payload.skill.files.length);
    assert.equal(spec.envelope.nativeToolTransport.deadlineUnixMs, transport.deadlineUnixMs);
    assert.deepEqual(transport.artifactMap, [{ target: 'reports/result.txt', workerPath: 'artifacts/reports/result.txt' }]);
    assert.ok(spec.envelope.prompt.startsWith(payload.prompt));
    assert.ok(spec.envelope.prompt.includes('inputs/notes/input.txt') &&
      spec.envelope.prompt.includes('reports/result.txt -> artifacts/reports/result.txt'));
    assert.deepEqual(spec.submittedPrompt, {
      sha256: hash(payload.prompt), bytes: Buffer.byteLength(payload.prompt),
      provenance: 'specification-prompt/not-native-observation'
    });
    assert.deepEqual(spec.nativePrompt, {
      sha256: hash(spec.envelope.prompt), bytes: Buffer.byteLength(spec.envelope.prompt),
      provenance: 'generated-worker-path-guidance/not-native-observation'
    });
    assert.notEqual(spec.nativePrompt.sha256, spec.submittedPrompt.sha256);
    assert.ok(!spec.stdin.includes('PUBLIC_WORKER_INPUT_BYTES'));
    assert.ok(!JSON.stringify(transport).includes('PUBLIC_SELECTED_SKILL_BYTES'));
    assert.equal(spec.nativeAdmissionSupported, false);
    assert.equal(spec.authenticationVerified, false);
    assert.equal(spec.liveAccepted, false);
    assert.equal(transport.nativeConfig.managedPolicyCompatibilityVerified, false);
    assert.equal(spec.requirements.nativeToolTransportObserverSupported, false);
    assert.equal(spec.requirements.toolWorkerHostCaptureRequired, true);
    assert.deepEqual(spec.nativeHardLimits, {
      turns: null, totalTokens: null, accountSpend: null, provenance: 'unsupported-not-applied'
    });
    assert.doesNotThrow(() => validateNativeTaskEnvelope(JSON.parse(spec.stdin)));
    assert.doesNotThrow(() => copilot.assertNativeTaskSpecification(spec));
    assert.throws(() => copilot.assertNativeTaskSpecification({ ...spec }), { code: 'NATIVE_SPECIFICATION_UNTRUSTED' });
    assert.throws(() => parseNativeTaskEvidence({ specification: spec, stdout: '', exitCode: 0,
      filesystemEvidence: { before: [], after: [], artifacts: [], unauthorizedFiles: [] } }),
    { code: 'NATIVE_TOOL_TRANSPORT_OBSERVER_UNSUPPORTED' });
    assert.ok(Object.isFrozen(spec) && Object.isFrozen(transport) && Object.isFrozen(transport.mcpConfig.args));
    payload.inputs[0].content.fill(0);
    assert.equal(transport.publicFiles.at(-1).sha256, hash('PUBLIC_WORKER_INPUT_BYTES\r\n'));
  });

  await t.test('Copilot runtime plans reject substituted commands, env, shim, policy and consumer-local files', () => {
    const payload = payloadFor('copilot'), spec = prepare('copilot', payload, issuer.issue(payload));
    const changed = mutate => {
      const envelope = JSON.parse(spec.stdin);
      mutate(envelope);
      assert.throws(() => validateNativeTaskEnvelope(envelope));
    };
    changed(envelope => { envelope.nativeToolTransport.mcpConfig.command = '/usr/bin/bash'; });
    changed(envelope => { envelope.nativeToolTransport.mcpConfig.env.PRIVATE_KEY = 'HOST_ONLY_PRIVATE_BYTES'; });
    changed(envelope => { envelope.nativeToolTransport.mcpConfig.args[7] = 'caller program'; });
    changed(envelope => { envelope.nativeToolTransport.mcpConfig.args[10] = 'caller nonce'; });
    changed(envelope => { envelope.nativeToolTransport.mcpConfig.args[11] = '{}'; });
    changed(envelope => { envelope.nativeToolTransport.deadlineUnixMs++; });
    changed(envelope => { envelope.nativeToolTransport.worker = {}; });
    changed(envelope => { envelope.nativeToolTransport.serverName = 'caller'; });
    changed(envelope => { envelope.artifactTargets = ['reports/result.txt']; });
    changed(envelope => { envelope.inputs = [{
      path: 'notes/input.txt', content: 'consumer bytes', executable: false, mountRoot: 'workspace'
    }]; });
  });

  await t.test('Copilot denies inline Skill shell expansion and oversized generated prompts rather than falling back', () => {
    const payload = payloadFor('copilot');
    payload.skill.files[0].content += '\n!`cat /client-config/config.json`\n';
    assert.throws(() => prepare('copilot', payload, issuer.issue(payload)),
      { code: 'NATIVE_TOOL_TRANSPORT_SKILL_SHELL_UNSUPPORTED' });
    const large = payloadFor('copilot');
    large.prompt = 'P'.repeat(16384);
    assert.throws(() => prepare('copilot', large, issuer.issue(large)), { code: 'TASK_LIMIT' });
  });

  await t.test('inner value copies, serialization and cross-original handles never substitute authority', () => {
    for (const client of clients) {
      const payload = payloadFor(client), tuple = issuer.issue(payload), other = issuer.issue(payload);
      const copies = [
        JSON.parse(JSON.stringify(tuple)), structuredClone(tuple),
        ...['task', 'worker', 'lease', 'binding'].map(key => ({ ...tuple, [key]: { ...tuple[key] } })),
        { ...tuple, task: other.task }, { ...tuple, worker: other.worker },
        { ...tuple, lease: other.lease }, { ...tuple, binding: other.binding }
      ];
      for (const copied of copies) assert.throws(() => prepare(client, payload, copied),
        error => /ORIGINAL_.*REQUIRED/.test(error.code), `${client} copied/cross-original tuple`);
      if (client === 'copilot') {
        assert.equal(prepare(client, payload, { ...tuple }).toolTransport.binding, tuple.binding);
      } else assert.equal(prepare(client, payload, { ...tuple }).toolTransport.planningOnly, true);
    }
  });

  await t.test('every original coordinate, source metadata/hash/order and target must match the payload', () => {
    for (const client of clients) {
      const payload = payloadFor(client);
      for (const [key, value] of [
        ['invocationId', 'other-invocation'], ['caseId', 'other-case'],
        ['client', client === 'copilot' ? 'opencode' : 'copilot'], ['arm', 'baseline'], ['repeat', 2]
      ]) {
        const scope = { ...payload, task: { ...payload.task, [key]: value } };
        assert.throws(() => prepare(client, payload, issuer.issue(scope)),
          { code: 'NATIVE_TOOL_TRANSPORT_TASK_MISMATCH' });
      }
      assert.throws(() => prepare(client, payload, issuer.issue(payload, { sourceHash: '0'.repeat(64) })),
        { code: 'NATIVE_TOOL_TRANSPORT_SOURCE_MISMATCH' });
      const changed = { ...payload, inputs: [{ ...payload.inputs[0], content: 'DIFFERENT_PUBLIC_BYTES' }] };
      assert.throws(() => prepare(client, payload, issuer.issue(changed)), { code: 'NATIVE_TOOL_TRANSPORT_SOURCE_MISMATCH' });
      const renamed = { ...payload, inputs: [{ ...payload.inputs[0], path: 'notes/renamed.txt' }] };
      assert.throws(() => prepare(client, payload, issuer.issue(renamed)), { code: 'NATIVE_TOOL_TRANSPORT_SOURCE_MISMATCH' });
      const reordered = { ...payload, skill: { ...payload.skill, files: [...payload.skill.files].reverse() } };
      assert.throws(() => prepare(client, payload, issuer.issue(reordered)), { code: 'NATIVE_TOOL_TRANSPORT_SOURCE_MISMATCH' });
      assert.throws(() => prepare(client, payload, issuer.issue({ ...payload, artifactTargets: ['other/result.txt'] })),
        { code: 'NATIVE_TOOL_TRANSPORT_TARGET_MISMATCH' });
      for (const key of ['workerProgramHash', 'shimHash']) assert.throws(() =>
        prepare(client, payload, issuer.issue(payload, { [key]: '0'.repeat(64) })),
      { code: 'NATIVE_TOOL_TRANSPORT_BINDING_INVALID' });
    }
  });

  await t.test('closed, cancelled, closing and expired original tuples fail before any configuration fallback', () => {
    for (const client of clients) {
      for (const [action, code] of [
        ['close', 'WORKER_NOT_READY'], ['cancel', 'CANCELLED'],
        ['closing', 'WORKER_NOT_READY'], ['abort', 'WORKER_NOT_READY'], ['expire', 'TIMEOUT']
      ]) {
        const payload = payloadFor(client), tuple = issuer.issue(payload);
        issuer[action](tuple);
        assert.throws(() => prepare(client, payload, tuple), { code });
      }
    }
  });

  await t.test('no-skill, empty targets, private declarations and substituted config remain explicit', () => {
    for (const client of clients) {
      const empty = payloadFor(client);
      empty.task.arm = 'no-skill';
      empty.skill.files = [];
      empty.artifactTargets = [];
      if (client === 'copilot') {
        const spec = prepare(client, empty, issuer.issue(empty));
        assert.deepEqual(spec.toolTransport.nativeConfig.availableTools, [
          'mcp:eval_tools-eval_read_public', 'mcp:eval_tools-eval_write_artifact', 'mcp:eval_tools-eval_read_artifact'
        ]);
        assert.equal(spec.toolTransport.nativeConfig.readOnlySkillRoot, null);
        assert.deepEqual(spec.toolTransport.artifactMap, []);
        assert.ok(!spec.argv.includes('skill'));
      } else {
        const spec = prepare(client, empty, issuer.issue(empty));
        assert.equal(spec.toolTransport.planningOnly, true);
        assert.equal(spec.toolTransport.nativeAdmissionSupported, false);
      }
      const source = payloadFor(client), tuple = issuer.issue(source);
      for (const key of ['checks', 'privateKeys', 'credentials', 'expected']) {
        const secret = `HOST_ONLY_PRIVATE_${key}_BYTES`;
        assert.throws(() => prepare(client, { ...source, [key]: secret }, tuple),
          error => !error.message.includes(secret));
      }
      for (const extra of [{ command: ['caller'] }, { env: { PRIVATE_KEY: 'caller' } },
        { path: 'C:\\private' }, { publicFiles: [] }, { artifactTargets: [] }]) {
        assert.throws(() => prepare(client, source, { ...tuple, ...extra }));
      }
      assert.throws(() => prepare(client, source, undefined));
    }
  });
});
