import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCopilotNativeArguments } from '../harness/clients/copilot/config.mjs';
import {
  NATIVE_TOOL_TRANSPORT_SETTINGS, NATIVE_WORKER_TOOL_NAMES, nativeWorkerAvailableTools
} from '../harness/clients/copilot/native-tool-transport.mjs';

const mcpConfig = { command: '/usr/bin/env', args: ['-i'], env: {} };
const payload = (skill, transport) => ({
  prompt: 'task', skill: { id: 'a-skill', files: skill ? [{ path: 'SKILL.md' }] : [] }, inputs: [],
  ...(transport ? { nativeToolTransport: { mcpConfig } } : {})
});
const build = (...args) => buildCopilotNativeArguments(payload(...args), { model: 'm', artifactTargets: [] });
const after = (argv, flag) => {
  const rest = argv.slice(argv.indexOf(flag) + 1);
  const end = rest.findIndex(value => value.startsWith('--'));
  return end < 0 ? rest : rest.slice(0, end);
};

test('worker tool plan is exactly the fixed source-qualified tools and sterile flags', () => {
  const argv = build(true, true);
  assert.deepEqual(after(argv, '--available-tools'), nativeWorkerAvailableTools(true));
  assert.deepEqual(after(argv, '--available-tools'), ['builtin:skill',
    ...NATIVE_WORKER_TOOL_NAMES.map(name => `mcp:eval_tools-${name}`)]);
  assert.deepEqual(after(argv, '--allow-tool'), ['skill', ...NATIVE_WORKER_TOOL_NAMES.map(name => `eval_tools(${name})`)]);
  assert.deepEqual(after(argv, '--deny-tool'), ['shell', 'url', 'read', 'write']);
  assert.deepEqual(JSON.parse(after(argv, '--additional-mcp-config')[0]), { mcpServers: { eval_tools: mcpConfig } });
  for (const flag of ['--disable-builtin-mcps', '--no-custom-instructions', '--no-ask-user']) assert.ok(argv.includes(flag));
  assert.ok(!argv.some(value => /^--(?:allow-all|yolo|add-dir|bare)/.test(value)));
  assert.deepEqual(NATIVE_TOOL_TRANSPORT_SETTINGS, { disableAllHooks: true, ide: { autoConnect: false } });
});

test('no-skill worker plan omits the Skill tool and default plan has no MCP surface', () => {
  const argv = build(false, true);
  assert.deepEqual(after(argv, '--available-tools'), nativeWorkerAvailableTools(false));
  assert.ok(!after(argv, '--allow-tool').includes('skill'));
  const plain = build(true, false);
  assert.ok(!plain.includes('--additional-mcp-config'));
  assert.ok(!plain.join(' ').includes('eval_tools'));
  assert.deepEqual(after(plain, '--available-tools'), ['skill', 'view']);
});