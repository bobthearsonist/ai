import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildConfig, buildArguments, dockerRunArguments, parseEvents, validateProbe, runOfflineProbe, TRANSPORT
} from '../harness/clients/opencode/index.mjs';

const root = new URL('../harness/clients/opencode/fixtures/', import.meta.url);
const stream = name => fs.readFileSync(new URL(`${name}.jsonl`, root), 'utf8');
const change = (name, fn) => {
  const events = stream(name).trim().split('\n').map(JSON.parse);
  fn(events);
  return events.map(e => JSON.stringify(e)).join('\n');
};
const capture = JSON.parse(fs.readFileSync(new URL('probe-input.json', root), 'utf8'));
const input = () => ({
  positive: { stdout: stream('positive'), exitCode: 0 },
  negative: { stdout: stream('negative'), exitCode: 0 },
  attacks: { stdout: stream('attacks'), exitCode: 0 },
  ...structuredClone(capture)
});

test('config and arguments expose only synthetic direct loopback inference', () => {
  const config = buildConfig();
  assert.deepEqual(config.enabled_providers, ['offline-fixture']);
  assert.equal(config.provider['offline-fixture'].npm, '@ai-sdk/anthropic');
  assert.equal(config.provider['offline-fixture'].options.baseURL, 'http://127.0.0.1:43128/v1');
  assert.equal(config.permission['*'], 'deny');
  assert.deepEqual(config.permission.read, { '*': 'deny', '/work/project/fixture.txt': 'allow' });
  assert.deepEqual(config.permission.skill, { '*': 'deny', 'offline-target': 'allow' });
  assert.deepEqual(config.permission.edit, { '*': 'deny' });
  const writeConfig = buildConfig({ artifactTargets: ['message.txt'] });
  assert.deepEqual(writeConfig.permission.edit, { '*': 'deny', 'work/project/message.txt': 'allow' });
  assert.deepEqual(writeConfig.permission.read, config.permission.read);
  for (const artifactTargets of [['*'], ['../answer.md'], ['/work/project/answer.md'], ['fixture.txt'], ['answer.md', 'answer.md'], 'answer.md']) {
    assert.throws(() => buildConfig({ artifactTargets }));
  }
  assert.throws(() => runOfflineProbe({ artifactTargets: [] }));
  assert.deepEqual(config.mcp, {});
  assert.deepEqual(config.plugin, []);
  assert.deepEqual(config.instructions, []);
  assert.equal(config.share, 'disabled');
  assert.equal(config.autoupdate, false);
  assert.ok(buildArguments().includes('--pure'));
  assert.ok(!buildArguments().includes('--dangerously-skip-permissions'));
  assert.throws(() => buildConfig({ baseURL: 'https://api.anthropic.com/v1' }));
});

test('container arguments enforce immutable identity, no network/mounts and bounded nonroot execution', () => {
  const args = dockerRunArguments({ image: `sha256:${'a'.repeat(64)}`, name: 'owned-probe', owner: 'ab12' });
  for (const flag of ['--read-only', '--network', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpus']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.equal(args[args.indexOf('--user') + 1], '1000:1000');
  assert.ok(!args.some(s => s.includes('docker.sock') || s === '--mount' || s === '-v'));
  assert.throws(() => dockerRunArguments({ image: 'latest', name: 'x', owner: 'ab12' }));
});

test('captured actual successful skill tool result is the trigger, not prose/request', () => {
  const result = parseEvents(stream('positive'));
  assert.equal(result.transport, TRANSPORT);
  assert.equal(result.clientVersion, '1.14.28');
  assert.equal(result.trigger.loaded, true);
  assert.equal(result.trigger.failedCalls, 0);
  assert.equal(result.modelQualityEvidence, false);
  assert.deepEqual(result.usage, { inputTokens: 50, outputTokens: 5, source: 'synthetic-inference-fixture' });
  assert.equal(parseEvents(stream('negative'), { allowToolErrors: true }).trigger.loaded, false);
  assert.throws(() => parseEvents(stream('negative')), /Failed tool call/);
  const prose = change('positive', es => {
    for (const e of es) if (e.type === 'tool_use' && e.part.tool === 'skill') e.part.state.output = 'I loaded a skill.';
  });
  assert.equal(parseEvents(prose).trigger.loaded, false);
});

test('strict parser rejects malformed, incomplete, auth/tool errors and process failures', () => {
  for (const text of ['', '{', '{}', 'null', stream('positive') + '\n{}']) assert.throws(() => parseEvents(text));
  for (const options of [{ exitCode: 1 }, { exitCode: null }, { cancelled: true }, { timedOut: true }]) {
    assert.throws(() => parseEvents(stream('positive'), options));
  }
  assert.throws(() => parseEvents('{"type":"error","error":{"message":"401 authentication failed"}}'), /error event/);
  const mutations = [
    es => es.pop(),
    es => { es.at(-1).part.reason = 'length'; },
    es => { es.at(-1).part.tokens.input = -1; },
    es => { es.find(e => e.type === 'tool_use').part.state.status = 'running'; },
    es => { delete es.find(e => e.type === 'tool_use').part.state.output; },
    es => { es.find(e => e.type === 'tool_use').part.sessionID = 'mixed'; },
    es => { es.find(e => e.type === 'tool_use').part.messageID = 'mixed'; },
    es => { es.at(-1).type = 'unknown'; },
    es => { es.push(es.at(-1)); },
    es => { es.find(e => e.type === 'text').part.text = ''; }
  ];
  for (const mutate of mutations) assert.throws(() => parseEvents(change('positive', mutate)));
});

test('missing usage is explicitly unavailable, never invented as zero', () => {
  const text = change('positive', es => { for (const e of es) delete e.part.tokens; });
  assert.equal(parseEvents(text).usage, null);
});

test('actual denial feedback and fresh no-skill control gate acceptance', () => {
  const result = validateProbe(input());
  assert.equal(result.accepted, true);
  assert.equal(result.liveAccepted, false);
  assert.equal(result.denials.verified, true);
  assert.equal(result.artifactWritesVerified, true);
  assert.equal(result.pilotWritesVerified, true);
  assert.equal(result.artifacts.positive['answer.md'].content, 'OFFLINE_ARTIFACT_answer.md\n');
  assert.equal(result.artifacts.negative['message.txt'].content, 'OFFLINE_ARTIFACT_message.txt\n');
  assert.equal(result.negative.trigger.failedCalls, 1);
  assert.deepEqual(result.denials.evidence.map(e => e.outcome), [
    'permission-denied', 'permission-denied', 'permission-denied', 'unavailable', 'unavailable',
    'permission-denied', 'permission-denied', 'permission-denied', 'permission-denied', 'permission-denied', 'permission-denied'
  ]);
  const edits = [
    i => { i.writeAbsent = false; },
    i => { i.artifacts.positive['answer.md'].content = ''; },
    i => { delete i.artifacts.negative['message.txt']; },
    i => { i.artifacts.positive['message.txt'].regularFile = false; },
    i => { i.protectedFiles.fixtureUnchanged = false; },
    i => { delete i.protectedFiles.homeWriteAbsent; },
    i => { i.network.externalBlocked = false; },
    i => { i.requests.pop(); },
    i => { i.requests.at(-1).results[0].is_error = false; },
    i => { i.requests.at(-1).results[0].content = 'synthetic-opencode-canary'; },
    i => { i.negative.stdout = i.positive.stdout; },
    i => {
      i.attacks.stdout = change('attacks', es => {
        es.find(e => e.type === 'tool_use').part.state.error = 'Authentication failed';
      });
    },
    i => {
      i.attacks.stdout = change('attacks', es => {
        const state = es.find(e => e.type === 'tool_use').part.state;
        state.status = 'completed'; state.output = 'disclosed'; delete state.error;
      });
    }
  ];
  for (const edit of edits) { const i = input(); edit(i); assert.throws(() => validateProbe(i)); }
});

test('opt-in actual pinned Docker client probe', {
  skip: process.env.EVAL_CLIENT_OPENCODE_DOCKER !== '1',
  timeout: 480000
}, () => {
  const result = runOfflineProbe();
  assert.equal(result.accepted, true);
  assert.equal(result.clientVersion, '1.14.28');
  assert.equal(result.trigger.loaded, true);
  assert.equal(result.denials.verified, true);
  assert.equal(result.artifactWritesVerified, true);
  assert.equal(result.pilotWritesVerified, true);
  assert.match(result.image, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.transport, TRANSPORT);
  assert.equal(result.modelQualityEvidence, false);
  assert.equal(result.cleanup.container, 'removed');
  assert.equal(result.cleanup.image, 'removed');
  const selected = runOfflineProbe({ artifactTargets: ['message.txt'] });
  assert.equal(selected.artifactWritesVerified, true);
  assert.equal(selected.pilotWritesVerified, true);
  assert.deepEqual(selected.artifactTargets, ['message.txt']);
  assert.equal(selected.artifacts.positive['answer.md'], undefined);
  assert.equal(selected.denials.evidence.at(-1).input.filePath, '/work/project/answer.md');
  assert.equal(selected.denials.evidence.at(-1).outcome, 'permission-denied');
});
