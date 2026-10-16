import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  parseClaudeEvents, assessOfflineProbe, runClaudeOfflineProbe, runOfflineProbe,
  buildOfflineDockerArguments, buildRuntimeArguments, offlineSettings
} from '../harness/clients/claude-code/index.mjs';

const fixture = name => JSON.parse(fs.readFileSync(new URL(
  `../harness/clients/claude-code/fixtures/${name}.actual.json`, import.meta.url), 'utf8'));
const candidate = fixture('candidate');
const control = fixture('no-skill');
const events = () => candidate.stdout.trimEnd().split('\n').map(JSON.parse);
const jsonl = items => `${items.map(item => JSON.stringify(item)).join('\n')}\n`;

test('observed real CLI success requires discovery and actual successful Skill result', () => {
  const parsed = assessOfflineProbe(candidate);
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.transport, 'offline-mock');
  assert.equal(parsed.live, false);
  assert.equal(parsed.realQuality, false);
  assert.equal(parsed.trigger.loaded, true);
  assert.equal(parsed.companionRead, true);
  assert.equal(parsed.artifactsPassed, true);
  assert.equal(parsed.artifacts.length, 2);
  assert.ok(parsed.artifacts.every(artifact => artifact.created));
  assert.equal(parsed.completion.status, 'success');
  assert.equal(parsed.usage.status, 'unavailable');
  assert.equal(parsed.usage.inputTokens, null);
  assert.equal(parsed.usage.costUsd, null);
  assert.ok(parsed.usage.mockReported.input_tokens > 0);
  assert.ok(parsed.events.some(event => event.tool_use_result?.success === true));
  assert.match(candidate.image, /^sha256:[a-f0-9]{64}$/);
  assert.equal(candidate.boundary.network, 'none');
  assert.deepEqual(candidate.boundary.mounts, []);
});

test('fresh no-skill control requests skill but actual Unknown skill is not a trigger', () => {
  const parsed = assessOfflineProbe(control);
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.trigger.requested, true);
  assert.equal(parsed.trigger.loaded, false);
  assert.equal(parsed.companionRead, true);
  assert.notEqual(candidate.workspace.containerId, control.workspace.containerId);
  assert.notEqual(parseClaudeEvents(candidate.stdout).init.session_id, parsed.init.session_id);
});

test('prose, requested-only tools, errors and missing discovery never count as loading', () => {
  for (const change of [
    items => { items.find(event => event.type === 'system' && event.subtype === 'init').skills = []; },
    items => { delete items.find(event => event.tool_use_result?.success === true).tool_use_result; },
    items => {
      const result = items.find(event => event.tool_use_result?.success === true);
      result.message.content[0].is_error = true;
      result.tool_use_result.success = false;
    },
    items => { items.find(event => event.tool_use_result?.success === true).tool_use_result.commandName = 'other-skill'; }
  ]) {
    const changed = events();
    change(changed);
    const raw = { ...candidate, stdout: jsonl(changed) };
    assert.equal(assessOfflineProbe(raw).trigger.loaded, false);
    assert.equal(assessOfflineProbe(raw).accepted, false);
  }
  const requested = events().slice(0, 3);
  assert.equal(parseClaudeEvents(jsonl(requested)).trigger.loaded, false);
  assert.equal(parseClaudeEvents(jsonl(requested)).completion.status, 'partial');
});

test('actual bare and restricted attempts remain rejected compatibility evidence', () => {
  for (const name of ['bare-disabled', 'restricted-undiscovered']) {
    const raw = fixture(name);
    const parsed = parseClaudeEvents(raw.stdout);
    assert.equal(parsed.completion.status, 'success');
    assert.equal(parsed.trigger.loaded, false);
    assert.equal(parsed.trigger.requested, true);
    assert.ok(parsed.events.some(event => event.type === 'user' &&
      event.message.content.some(block => block.type === 'tool_result' && block.is_error === true &&
        block.tool_use_id === parsed.trigger.toolUseId)));
  }
});

test('every actual attack must be a genuine client denial and failed boundary is rejected', () => {
  const parsed = assessOfflineProbe(candidate);
  assert.equal(parsed.denialEvidence.length, 13);
  assert.ok(parsed.denialEvidence.every(item => item.denied));
  for (const attack of parsed.denialEvidence) {
    const changed = events();
    const result = changed.find(event => event.type === 'user' &&
      event.message.content.some(block => block.tool_use_id === attack.toolUseId));
    result.message.content[0].is_error = false;
    result.message.content[0].content = 'Succeeded';
    assert.equal(assessOfflineProbe({ ...candidate, stdout: jsonl(changed) }).accepted, false);
  }
  const failed = assessOfflineProbe(fixture('boundary-failure'));
  assert.equal(failed.trigger.loaded, true);
  assert.equal(failed.completion.status, 'success');
  assert.equal(failed.canaryLeaked, true);
  assert.equal(failed.accepted, false);
  for (const override of [{ rawCanaryObserved: true }, { fixtureChanged: true },
    { forbiddenWriteExists: true }, { wire: [] }]) {
    assert.equal(assessOfflineProbe({ ...candidate, ...override }).accepted, false);
  }
});

test('parser distinguishes interrupted/partial/error from complete success without fabricated usage', () => {
  assert.equal(parseClaudeEvents(candidate.stdout, { timedOut: true }).completion.status, 'timeout');
  assert.equal(parseClaudeEvents(candidate.stdout, { cancelled: true }).completion.status, 'cancelled');
  assert.equal(parseClaudeEvents(candidate.stdout, { outputLimited: true }).completion.status, 'output-limit');
  assert.equal(parseClaudeEvents(candidate.stdout, { exitCode: 1 }).completion.status, 'error');
  const partial = events().slice(0, -1);
  const parsed = parseClaudeEvents(jsonl(partial));
  assert.equal(parsed.completion.status, 'partial');
  assert.equal(parsed.usage.inputTokens, null);
  assert.equal(parsed.usage.mockReported, null);
});

test('observed actual HTTP400 error has subtype success but is_error wins; retry timeout stays incomplete', () => {
  const raw = fixture('provider-error-candidate');
  const parsed = assessOfflineProbe(raw);
  assert.equal(parsed.completion.status, 'error');
  assert.equal(parsed.completion.parseError, null);
  assert.equal(parsed.terminal.subtype, 'success');
  assert.equal(parsed.terminal.is_error, true);
  assert.equal(parsed.terminal.api_error_status, 400);
  assert.equal(parsed.accepted, false);
  assert.equal(parsed.usage.inputTokens, null);
  const retry = fixture('provider-retry-timeout-candidate');
  const timed = assessOfflineProbe(retry);
  assert.equal(timed.completion.status, 'timeout');
  assert.equal(timed.completion.parseError, null);
  assert.equal(timed.completion.terminal, false);
  assert.ok(timed.events.some(event => event.subtype === 'api_retry'));
  assert.equal(timed.accepted, false);
});

test('malformed JSONL, drift, unknown events and orphan/duplicate results fail closed', () => {
  assert.equal(parseClaudeEvents(`${candidate.stdout}{`).completion.status, 'malformed');
  assert.equal(parseClaudeEvents('[]\n').completion.status, 'malformed');
  assert.equal(parseClaudeEvents(`${candidate.stdout}\n`).completion.status, 'malformed');
  for (const change of [
    items => { items[1].claude_code_version = '2.1.292'; },
    items => { items[2].session_id = 'foreign'; },
    items => { items[0].subtype = 'unknown-system'; },
    items => { items[3].message.content[0].tool_use_id = 'orphan'; },
    items => { items.push(items.at(-1)); },
    items => { items.splice(4, 0, items[3]); },
    items => { items[2].message.content[0].input = null; }
  ]) {
    const changed = events();
    change(changed);
    const parsed = parseClaudeEvents(jsonl(changed));
    assert.equal(parsed.completion.status, 'malformed');
    assert.equal(parsed.trigger.loaded, false);
    assert.equal(parsed.denialPassed, false);
  }
  assert.throws(() => assessOfflineProbe({ ...candidate, transport: 'live' }), /envelope/);
});

test('exact observed help drives strict runtime arguments and verified absolute deny rules', () => {
  const args = buildRuntimeArguments(candidate.help, { artifactTargets: candidate.artifactTargets });
  assert.deepEqual(args, candidate.args);
  assert.ok(args.includes('dontAsk'));
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(args[args.indexOf('--tools') + 1], 'Skill,Read,Write');
  assert.ok(!args.includes('--bare'));
  assert.ok(!args.includes('--restricted'));
  assert.ok(!args.includes('--max-turns'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.throws(() => buildRuntimeArguments('--help'), /required/);
  assert.throws(() => buildRuntimeArguments(candidate.help.replaceAll('--permission-prompts', '--wrong')), /required/);
  assert.ok(offlineSettings().permissions.deny.includes('Read(//workspace/private-sentinel.txt)'));
  assert.ok(offlineSettings().permissions.deny.includes('Read(//proc/**)'));
  assert.equal(offlineSettings().disableAllHooks, true);
  assert.equal(buildRuntimeArguments(candidate.help)[args.indexOf('--tools') + 1], 'Skill,Read');
  const scoped = offlineSettings({ artifactTargets: ['answer.md', 'message.txt'] });
  assert.ok(scoped.permissions.allow.includes('Edit(//workspace/answer.md)'));
  assert.ok(scoped.permissions.allow.includes('Edit(//workspace/message.txt)'));
  assert.ok(!scoped.permissions.allow.includes('Write'));
  assert.ok(scoped.permissions.deny.includes('Edit(//workspace/fixtures/**)'));
  for (const artifactTargets of [['../escape.md'], ['/home/node/stolen'], ['other.md'], ['answer.md', 'answer.md']]) {
    assert.throws(() => offlineSettings({ artifactTargets }), /strict artifact/);
    assert.throws(() => buildRuntimeArguments(candidate.help, { artifactTargets }), /strict artifact/);
  }
});

test('native artifact writes require paired successful client creation and actual on-disk content', () => {
  for (const target of candidate.artifactTargets) {
    const changed = events();
    const result = changed.find(event => event.tool_use_result?.type === 'create' &&
      event.tool_use_result.filePath === `/workspace/${target}`);
    result.tool_use_result.type = 'update';
    assert.equal(assessOfflineProbe({ ...candidate, stdout: jsonl(changed) }).accepted, false);
    const raw = structuredClone(candidate);
    raw.artifactWrites.find(artifact => artifact.path === `/workspace/${target}`).content = null;
    assert.equal(assessOfflineProbe(raw).accepted, false);
  }
  assert.equal(typeof runOfflineProbe, 'function');
});

test('Docker builder cannot weaken network, mount, auth, ownership or resource restrictions', () => {
  const owner = randomUUID();
  const input = { owner, name: `skill-eval-claude-${owner}-candidate`, image: candidate.image, arm: 'candidate' };
  const args = buildOfflineDockerArguments(input);
  assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('--read-only'));
  assert.equal(args[args.indexOf('--user') + 1], '1000:1000');
  assert.equal(args[args.indexOf('--memory') + 1], '768m');
  assert.equal(args[args.indexOf('--pids-limit') + 1], '64');
  assert.ok(!args.includes('--mount') && !args.includes('-v') && !args.includes('--env') && !args.includes('--privileged'));
  for (const override of [{ image: 'node:latest' }, { name: 'foreign-container' },
    { owner: 'foreign' }, { arm: 'baseline' }, { providerScenario: 'live' }]) {
    assert.throws(() => buildOfflineDockerArguments({ ...input, ...override }), /Invalid owned/);
  }
});

test('cancelled and invalid probes fail before touching Docker or host config', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runClaudeOfflineProbe({ signal: controller.signal }), error => error.code === 'CANCELLED');
  for (const timeoutMs of [180000, 300000]) {
    await assert.rejects(runClaudeOfflineProbe({ timeoutMs, signal: controller.signal }),
      error => error.code === 'CANCELLED');
  }
  await assert.rejects(runClaudeOfflineProbe({ timeoutMs: 999 }), /Bounded/);
  await assert.rejects(runClaudeOfflineProbe({ timeoutMs: 300001 }), /Bounded/);
  await assert.rejects(runClaudeOfflineProbe({ providerScenario: 'live' }), /Bounded/);
  await assert.rejects(runClaudeOfflineProbe({ signal: {} }), /Bounded/);
  await assert.rejects(runOfflineProbe({ artifactTargets: [] }), /requires at least one/);
  await assert.rejects(runOfflineProbe({ artifactTargets: ['../unsafe'] }), /strict artifact/);
});

test('opt-in actual Docker CLI discovery, control, denial and cleanup', {
  skip: process.env.EVAL_CLIENT_CLAUDE_DOCKER !== '1', timeout: 600000
}, async () => {
  const report = await runOfflineProbe({ timeoutMs: 180000, artifactTargets: ['answer.md', 'message.txt'] });
  assert.equal(report.accepted, true);
  assert.equal(report.pilotWritesVerified, true);
  assert.equal(report.liveAccepted, false);
  assert.equal(report.qualityEvaluated, false);
  assert.equal(report.candidate.trigger.loaded, true);
  assert.equal(report.control.trigger.loaded, false);
  assert.equal(report.candidate.safetyPassed, true);
  assert.equal(report.control.safetyPassed, true);
  assert.equal(report.candidate.artifactsPassed, true);
  assert.equal(report.control.artifactsPassed, true);
  assert.equal(report.imageSpec.nodeVersion, '22.22.1');
  assert.equal(report.imageSpec.engineVersion, '29.7.2');
  assert.equal(report.candidate.actualClientVersion, '2.1.291 (Claude Code)');
  assert.equal(report.cleanup.containersRemoved, true);
  assert.equal(report.cleanup.imageTagRemoved, true);
  assert.equal(report.cleanup.hostConfigRemoved, true);
});

test('opt-in offline runtime timeout cleans up its exact owned resources', {
  skip: process.env.EVAL_CLIENT_CLAUDE_DOCKER !== '1', timeout: 600000
}, async () => {
  await assert.rejects(runClaudeOfflineProbe({ providerScenario: 'stall', timeoutMs: 1500 }),
    error => error.code === 'TIMEOUT');
});

test('opt-in offline cancellation cleans up its exact owned resources', {
  skip: process.env.EVAL_CLIENT_CLAUDE_DOCKER !== '1', timeout: 600000
}, async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    await assert.rejects(runClaudeOfflineProbe({ providerScenario: 'stall', signal: controller.signal }),
      error => error.code === 'CANCELLED');
  } finally {
    clearTimeout(timer);
  }
});
