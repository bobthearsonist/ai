import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { cleanupAuthProfile } from '../harness/auth/index.mjs';
import { prepareNativeAuthProfiles } from '../harness/native-auth-profiles.mjs';

const cli = fileURLToPath(new URL('../harness/cli.mjs', import.meta.url));
const authRoot = fileURLToPath(new URL('../harness/auth/.work', import.meta.url));

test('selected profiles prepare native command plans without logging in or inheriting credentials', t => {
  const { report, handles } = prepareNativeAuthProfiles({ clients: ['copilot', 'claude-code', 'opencode'] });
  t.after(() => handles.toReversed().forEach(cleanupAuthProfile));
  assert.deepEqual(report.clients, ['copilot', 'claude-code', 'opencode']);
  assert.equal(report.mode, 'preparation-only');
  for (const field of ['authenticationVerified', 'liveAccepted', 'loginExecuted']) assert.equal(report[field], false);
  assert.equal(new Set(handles.map(handle => handle.directory)).size, 3);
  for (const { profile, commands } of report.profiles) {
    assert.equal(fs.existsSync(profile.directory), true);
    assert.equal(profile.authenticationVerified, false);
    assert.equal(profile.credentialsRead, false);
    assert.equal(profile.loginExecuted, false);
    assert.equal(profile.liveAccepted, false);
    assert.equal(profile.runtime, null);
    for (const command of [commands.login, commands.status]) {
      assert.equal(command.executeAutomatically, false);
      assert.equal(command.requiresOperator, true);
      assert.equal(command.requiresCredentialStoreIsolation, true);
      assert.equal(command.runtimeVerified, false);
      assert.equal(Object.hasOwn(command.env, 'PATH'), false);
      assert.equal(Object.keys(command.env).some(key => /TOKEN|API_KEY|SECRET|PASSWORD/.test(key)), false);
      assert.equal(command.env.HOME, profile.paths.home);
    }
  }
});

test('invalid selections fail before preparing any profile', () => {
  const prepare = () => assert.fail('must not prepare a profile');
  for (const clients of [[], ['unknown'], ['copilot', 'copilot'], 'copilot', [null]]) {
    assert.throws(() => prepareNativeAuthProfiles({ clients }, { prepare }), /selection/);
  }
  assert.throws(() => prepareNativeAuthProfiles({ clients: ['copilot'] }, { cleanup: null }), /functions/);
});

test('a failed batch cleans every created profile in reverse order without executing commands', () => {
  const cleaned = [];
  const handles = [];
  const operations = {
    prepare({ client }) { const handle = { client }; handles.push(handle); return handle; },
    describe(handle) {
      if (handle.client === 'opencode') throw new Error('synthetic preparation failure');
      return { client: handle.client };
    },
    plan: () => ({ loginExecuted: false }),
    cleanup(handle) { cleaned.push(handle); }
  };
  assert.throws(() => prepareNativeAuthProfiles({ clients: ['copilot', 'opencode'] }, operations),
    /synthetic preparation failure/);
  assert.deepEqual(cleaned, handles.toReversed());
});

test('cleanup failures remain explicit and cannot hide the original batch failure', () => {
  const original = new Error('synthetic plan failure');
  const cleanupFailure = new Error('synthetic ownership mismatch');
  let cleanupCount = 0;
  assert.throws(() => prepareNativeAuthProfiles({ clients: ['copilot'] }, {
    prepare: () => ({}), describe: () => ({}), plan: () => { throw original; },
    cleanup: () => { cleanupCount++; throw cleanupFailure; }
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, cleanupFailure]);
    assert.match(error.message, /synthetic plan failure.*synthetic ownership mismatch/);
    return true;
  });
  assert.equal(cleanupCount, 1);
});

test('CLI exposes preparation and SDK probes, rejecting invalid input before work', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /prepare-auth/);
  assert.match(help.stdout, /probe-runner/);
  for (const args of [
    ['prepare-auth', '--clients', 'unknown'],
    ['prepare-auth', '--clients', 'copilot,copilot'],
    ['prepare-auth', '--timeout-seconds', '180'],
    ['prepare-auth', '--profile', 'personal-profile.json'],
    ['probe-runner', '--clients', 'unknown'],
    ['probe-runner', '--clients', 'copilot,copilot'],
    ['probe-runner', '--timeout-seconds', '1.2'],
    ['probe-runner', '--timeout-seconds', '301'],
    ['probe-runner', '--profile', 'personal-profile.json']
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).passed, false);
  }
});

test('CLI retains only empty owned profiles and plans, never authentication evidence', t => {
  const before = new Set(fs.existsSync(authRoot) ? fs.readdirSync(authRoot) : []);
  const execution = spawnSync(process.execPath, [cli, 'prepare-auth', '--clients', 'copilot'], { encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  const report = JSON.parse(execution.stdout);
  assert.equal(report.profiles.length, 1);
  const profile = report.profiles[0].profile;
  t.after(() => {
    const directory = profile.directory;
    const name = `auth-${profile.id}`;
    assert.match(profile.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.equal(path.dirname(directory), path.resolve(authRoot));
    assert.equal(path.basename(directory), name);
    assert.equal(before.has(name), false);
    for (let current = directory; ; current = path.dirname(current)) {
      assert.equal(fs.lstatSync(current).isSymbolicLink(), false);
      if (path.dirname(current) === current) break;
    }
    const marker = path.join(directory, '.owner.json');
    const stat = fs.lstatSync(marker);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1);
    assert.equal(fs.readFileSync(marker, 'utf8'), JSON.stringify({
      id: profile.id, client: 'copilot', version: 2, purpose: 'native-auth-preparation'
    }));
    const children = ['home', 'workspace', 'appdata', 'localappdata', 'config', 'cache',
      'data', 'state', 'claude', 'copilot', 'gh', 'scratch'];
    assert.deepEqual(fs.readdirSync(directory).sort(), ['.owner.json', ...children].sort());
    for (const child of children) {
      const filename = path.join(directory, child);
      assert.equal(fs.lstatSync(filename).isDirectory(), true);
      assert.equal(fs.lstatSync(filename).isSymbolicLink(), false);
      assert.deepEqual(fs.readdirSync(filename), []);
    }
    fs.rmSync(directory, { recursive: true });
  });
  assert.equal(report.mode, 'preparation-only');
  assert.equal(report.loginExecuted, false);
  assert.equal(report.authenticationVerified, false);
  assert.equal(report.liveAccepted, false);
  assert.deepEqual(report.clients, ['copilot']);
  assert.deepEqual(report.profiles[0].commands.login.args, ['login']);
  assert.equal(report.profiles[0].commands.status.interactiveInput, '/user');
  assert.equal(report.profiles[0].commands.login.runtimeVerified, false);
});
