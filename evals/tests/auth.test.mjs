import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import {
  AuthError, prepareAuthProfile, describeAuthProfile, planAuthCommands,
  inspectAuthRuntime, requireAuthenticatedProfile, cleanupAuthProfile
} from '../harness/auth/index.mjs';
import { CLIENT_VERSIONS } from '../harness/isolation/index.mjs';
import { fileURLToPath } from 'node:url';
import { prepareLiveEvaluation, releaseLiveEvaluation } from '../harness/live-execution.mjs';
import { nativeMatrixFixture } from './helpers.mjs';
import {
  prepareNativeAuthCustody, describeNativeAuthCustody, assertNativeAuthCustody,
  requireNativeAuthenticatedCustody, releaseNativeAuthCustody
} from '../harness/auth/custody.mjs';

const clients = ['claude-code', 'copilot', 'opencode'];
const secret = 'synthetic-secret-do-not-report-9e1f27';
const executable = process.execPath;
const expected = {
  'claude-code': { login: ['auth', 'login'], status: ['auth', 'status'] },
  copilot: { login: ['login'], status: [] },
  opencode: { login: ['auth', 'login'], status: ['auth', 'list'] }
};

function profile(client, fn) {
  const handle = prepareAuthProfile({ client });
  try { return fn(handle); } finally { cleanupAuthProfile(handle); }
}

function spawnMock(fn, body) {
  const replacement = mock.method(childProcess, 'spawnSync', fn);
  syncBuiltinESMExports();
  try { return body(); } finally { replacement.mock.restore(); syncBuiltinESMExports(); }
}

function code(expectedCode) {
  return error => error instanceof AuthError && error.code === expectedCode &&
    !error.message.includes(secret);
}

function custodyEvaluation(t, client = 'copilot') {
  const { mockScenarios, ...source } = nativeMatrixFixture(t);
  source.selection.clients = [client];
  source.profile.auth = 'native-client-auth';
  for (const [name, pin] of Object.entries(source.profile.clients)) {
    pin.model = 'native-default';
    pin.endpoint = name === 'claude-code' ? 'https://api.anthropic.com' : 'https://api.githubcopilot.com';
    pin.settings = {};
  }
  const prepared = prepareLiveEvaluation(source);
  let released = false;
  const release = () => {
    if (!released) { releaseLiveEvaluation(prepared.handle); released = true; }
  };
  t.after(release);
  return { ...prepared, source, release };
}

test('native auth custody binds original evaluation and never exposes private profile storage', t => {
  spawnMock(() => { throw new Error('Unexpected login/status/native/network execution'); }, () => {
    for (const client of clients) {
      const evaluation = custodyEvaluation(t, client);
      const custody = prepareNativeAuthCustody({ client, evaluation: evaluation.handle });
      try {
        assert.deepEqual(Object.keys(custody).sort(), ['client', 'id']);
        const description = assertNativeAuthCustody(custody, { client, evaluation: evaluation.handle });
        assert.equal(description.phase, 'prepared-unverified');
        assert.equal(description.binding.planHash, evaluation.report.planHash);
        assert.equal(description.binding.profileHash, evaluation.report.profileHash);
        assert.equal(description.binding.clientVersion, CLIENT_VERSIONS[client]);
        assert.equal(description.binding.requestedImage, evaluation.report.requestedImage);
        assert.equal(description.binding.model, 'native-default');
        assert.equal(description.binding.taskSessionCount, 6);
        for (const field of ['nativeRuntimeVerified', 'authenticationVerified', 'nativeLoginExecuted', 'nativeStatusObserved', 'credentialsImported',
          'credentialStorageVerified', 'refreshVerified', 'rootRuntimeAccessVerified', 'evaluationToolAccessVerified',
          'candidateAttachmentSupported', 'liveAccepted']) assert.equal(description[field], false);
        const serialized = JSON.stringify(description);
        for (const name of ['directory', 'paths', 'env', 'authRoot', 'token']) {
          assert.equal(serialized.includes(`"${name}"`), false);
        }
        assert.equal(serialized.includes('.work'), false);
        assert.equal(serialized.includes('.owner.json'), false);
        assert.throws(() => requireNativeAuthenticatedCustody(custody, { client, evaluation: evaluation.handle }),
          code('AUTHENTICATION_UNVERIFIED'));
      } finally { releaseNativeAuthCustody(custody); }
    }
  });
});

test('native custody rejects proof booleans, imports, callbacks, accessors and evaluation copies', t => {
  const evaluation = custodyEvaluation(t);
  for (const name of ['authenticated', 'authRoot', 'credentials', 'profile', 'observe', 'authorization', 'boundary']) {
    assert.throws(() => prepareNativeAuthCustody({ client: 'copilot', evaluation: evaluation.handle, [name]: secret }),
      code('INVALID_CUSTODY_OPTIONS'));
  }
  const getter = { evaluation: evaluation.handle };
  Object.defineProperty(getter, 'client', { enumerable: true, get() { throw new Error(secret); } });
  assert.throws(() => prepareNativeAuthCustody(getter), code('INVALID_CUSTODY_OPTIONS'));
  assert.throws(() => prepareNativeAuthCustody(new Proxy({}, {})), code('INVALID_CUSTODY_OPTIONS'));
  assert.throws(() => prepareNativeAuthCustody({ client: 'copilot', evaluation: { ...evaluation.handle } }),
    code('INVALID_AUTH_EVALUATION'));
  assert.throws(() => prepareNativeAuthCustody({ client: 'opencode', evaluation: evaluation.handle }),
    code('AUTH_BINDING_MISMATCH'));
});

test('custody requires the exact original evaluation/client and survives caller report mutation', t => {
  const evaluation = custodyEvaluation(t);
  const duplicate = prepareLiveEvaluation(evaluation.source);
  const custody = prepareNativeAuthCustody({ client: 'copilot', evaluation: evaluation.handle });
  try {
    evaluation.report.planHash = 'b'.repeat(64);
    assert.notEqual(describeNativeAuthCustody(custody).binding.planHash, evaluation.report.planHash);
    assert.throws(() => assertNativeAuthCustody(custody, { client: 'copilot', evaluation: duplicate.handle }),
      code('AUTH_BINDING_MISMATCH'));
    assert.throws(() => assertNativeAuthCustody(custody, { client: 'opencode', evaluation: evaluation.handle }),
      code('AUTH_BINDING_MISMATCH'));
    assert.throws(() => describeNativeAuthCustody({ ...custody }), code('INVALID_AUTH_CUSTODY'));
    assert.throws(() => releaseNativeAuthCustody({ ...custody }), code('INVALID_AUTH_CUSTODY'));
  } finally { releaseNativeAuthCustody(custody); releaseLiveEvaluation(duplicate.handle); }
  assert.throws(() => describeNativeAuthCustody(custody), code('INVALID_AUTH_CUSTODY'));
  assert.throws(() => releaseNativeAuthCustody(custody), code('INVALID_AUTH_CUSTODY'));
});

test('custody admits no unobserved imported storage and cleanup remains independent of evaluation release', t => {
  const evaluation = custodyEvaluation(t);
  const root = fileURLToPath(new URL('../harness/auth/.work/', import.meta.url));
  const before = new Set(fs.readdirSync(root));
  const custody = prepareNativeAuthCustody({ client: 'copilot', evaluation: evaluation.handle });
  const added = fs.readdirSync(root).filter(name => !before.has(name));
  assert.equal(added.length, 1);
  const directory = path.join(root, added[0]);
  const filename = path.join(directory, 'copilot', 'config.json');
  try {
    fs.writeFileSync(filename, JSON.stringify({ token: secret }));
    assert.throws(() => describeNativeAuthCustody(custody), code('AUTH_STORAGE_UNVERIFIED'));
    assert.throws(() => requireNativeAuthenticatedCustody(custody, { client: 'copilot', evaluation: evaluation.handle }),
      code('AUTH_STORAGE_UNVERIFIED'));
    fs.unlinkSync(filename);
    evaluation.release();
    assert.throws(() => describeNativeAuthCustody(custody), code('INVALID_AUTH_EVALUATION'));
    releaseNativeAuthCustody(custody);
    assert.equal(fs.existsSync(directory), false);
  } finally {
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
    if (fs.existsSync(directory)) releaseNativeAuthCustody(custody);
  }
});

test('custody rejects linked storage and preserves an unrelated owner during release', t => {
  const evaluation = custodyEvaluation(t);
  const root = fileURLToPath(new URL('../harness/auth/.work/', import.meta.url));
  const before = new Set(fs.readdirSync(root));
  const custody = prepareNativeAuthCustody({ client: 'copilot', evaluation: evaluation.handle });
  const directory = path.join(root, fs.readdirSync(root).find(name => !before.has(name)));
  const other = prepareAuthProfile({ client: 'opencode' });
  const linked = path.join(directory, 'copilot');
  const sentinel = path.join(describeAuthProfile(other).paths.workspace, 'sentinel.txt');
  fs.writeFileSync(sentinel, secret);
  fs.rmdirSync(linked);
  try {
    fs.symlinkSync(other.directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => describeNativeAuthCustody(custody), code('OWNERSHIP'));
    assert.throws(() => releaseNativeAuthCustody(custody), code('OWNERSHIP'));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), secret);
  } finally {
    fs.unlinkSync(linked);
    fs.mkdirSync(linked);
    releaseNativeAuthCustody(custody);
    cleanupAuthProfile(other);
  }
});

test('all profiles are empty owned UUID children with no caller-selected root', () => {
  const handles = clients.map(client => prepareAuthProfile({ client }));
  try {
    assert.equal(new Set(handles.map(h => h.directory)).size, 3);
    for (const handle of handles) {
      const description = describeAuthProfile(handle);
      assert.match(path.basename(handle.directory), /^auth-[a-f0-9-]{36}$/);
      assert.equal(path.basename(path.dirname(handle.directory)), '.work');
      assert.equal(path.basename(path.dirname(path.dirname(handle.directory))), 'auth');
      assert.equal(description.version, 2);
      assert.equal(description.repeats, 3);
      assert.equal(description.clientVersion, CLIENT_VERSIONS[handle.client]);
      assert.equal(description.configured, true);
      for (const field of ['authenticationVerified', 'authenticated', 'liveAccepted', 'liveSupported', 'credentialsRead', 'loginExecuted']) {
        assert.equal(description[field], false);
      }
      assert.equal(description.runtime, null);
      for (const directory of Object.values(description.paths)) assert.deepEqual(fs.readdirSync(directory), []);
      assert.equal(fs.readdirSync(handle.directory).length, Object.keys(description.paths).length + 1);
      assert.ok(description.blockers.some(item => item.includes('environment-only')));
      assert.ok(Object.isFrozen(handle));
    }
  } finally { for (const handle of handles) cleanupAuthProfile(handle); }
});

test('preparation and plans never execute a client or copy ambient configuration', () => {
  const ambient = {
    HOME: secret, USERPROFILE: secret, APPDATA: secret, PATH: secret,
    ANTHROPIC_API_KEY: secret, ANTHROPIC_BASE_URL: secret, CLAUDE_CODE_OAUTH_TOKEN: secret,
    COPILOT_GITHUB_TOKEN: secret, COPILOT_PROVIDER_API_KEY: secret, GH_TOKEN: secret,
    GITHUB_TOKEN: secret, OPENAI_API_KEY: secret, OPENCODE_CONFIG: secret,
    OPENCODE_CONFIG_CONTENT: secret, OPENCODE_AUTH_CONTENT: secret, OPENCODE_DB: secret,
    OPENCODE_TEST_HOME: secret, NODE_OPTIONS: secret, HTTPS_PROXY: secret,
    COPILOT_CUSTOM_INSTRUCTIONS_DIRS: secret, CLAUDE_CONFIG_DIR: secret
  };
  const previous = Object.fromEntries(Object.keys(ambient).map(key => [key, process.env[key]]));
  Object.assign(process.env, ambient);
  try {
    spawnMock(() => { throw new Error('Unexpected native execution'); }, () => {
      for (const client of clients) profile(client, handle => {
        const description = describeAuthProfile(handle);
        const plans = planAuthCommands(handle);
        assert.equal(JSON.stringify({ description, plans }).includes(secret), false);
        for (const key of ['PATH', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
          'COPILOT_GITHUB_TOKEN', 'COPILOT_PROVIDER_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY',
          'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_TEST_HOME',
          'NODE_OPTIONS', 'HTTPS_PROXY', 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS']) {
          assert.equal(Object.hasOwn(description.env, key), false);
        }
        assert.equal(description.env.HOME, description.paths.home);
        assert.equal(description.env.USERPROFILE, description.paths.home);
        assert.equal(description.env.COPILOT_HOME, description.paths.copilot);
        assert.equal(description.env.CLAUDE_CONFIG_DIR, description.paths.claude);
        assert.equal(description.env.GH_CONFIG_DIR, description.paths.gh);
        assert.equal(description.env.XDG_DATA_HOME, description.paths.data);
        if (client === 'opencode') {
          assert.equal(description.env.OPENCODE_DB, path.join(description.paths.state, 'opencode-native.db'));
        } else {
          assert.equal(Object.hasOwn(description.env, 'OPENCODE_DB'), false);
        }
        for (const directory of Object.values(description.paths)) assert.deepEqual(fs.readdirSync(directory), []);
      });
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('OpenCode keeps native auth data and session database in distinct original owned profiles', () => {
  const handles = [];
  try {
    for (let index = 0; index < 2; index++) handles.push(prepareAuthProfile({ client: 'opencode' }));
    spawnMock(() => { throw new Error('Unexpected native auth or provider execution'); }, () => {
      const databases = [];
      for (const handle of handles) {
        const description = describeAuthProfile(handle);
        const plans = planAuthCommands(handle);
        const database = path.join(description.paths.state, 'opencode-native.db');
        databases.push(database);
        for (const env of [description.env, plans.login.env, plans.status.env]) {
          assert.equal(env.XDG_DATA_HOME, description.paths.data);
          assert.equal(env.OPENCODE_DB, database);
          assert.equal(path.isAbsolute(env.OPENCODE_DB), true);
          assert.equal(Object.hasOwn(env, 'OPENCODE_AUTH_CONTENT'), false);
          assert.equal(Object.isFrozen(env), true);
        }
        assert.equal(path.dirname(database), description.paths.state);
        assert.notEqual(description.paths.state, description.paths.data);
        assert.equal(fs.existsSync(database), false);
        assert.deepEqual(fs.readdirSync(description.paths.data), []);
        assert.deepEqual(fs.readdirSync(description.paths.state), []);
        assert.equal(description.authenticationVerified, false);
        assert.equal(description.liveAccepted, false);
        assert.throws(() => requireAuthenticatedProfile(handle), code('AUTHENTICATION_UNVERIFIED'));
      }
      assert.equal(new Set(databases).size, 2);
    });
  } finally { for (const handle of handles) cleanupAuthProfile(handle); }
});

test('native login/status plans retain normal permissions and explicit operator control', () => {
  for (const client of clients) profile(client, handle => {
    const unresolved = planAuthCommands(handle);
    assert.equal(unresolved.login.requiresExecutableResolution, true);
    const plans = planAuthCommands(handle, { executable });
    assert.deepEqual(plans.login.args, expected[client].login);
    assert.deepEqual(plans.status.args, expected[client].status);
    assert.equal(plans.status.interactiveInput, client === 'copilot' ? '/user' : undefined);
    for (const command of [plans.login, plans.status]) {
      assert.equal(command.cwd, describeAuthProfile(handle).paths.workspace);
      assert.equal(command.executable, executable);
      assert.equal(command.executeAutomatically, false);
      assert.equal(command.requiresOperator, true);
      assert.equal(command.runtimeVerified, false);
      assert.equal(command.requiresCredentialStoreIsolation, true);
      assert.equal(command.requiresExecutableResolution, false);
      assert.ok(Object.isFrozen(command.args));
      assert.equal(/allow-all|bypass|skip-permissions|with-token|setup-token|--prompt|--auto/.test(command.args.join(' ')), false);
    }
  });
});

test('unsupported clients and caller env/root/auth assertions fail without echoing values', () => {
  assert.throws(() => prepareAuthProfile({ client: secret }), code('UNSUPPORTED_CLIENT'));
  for (const extra of ['root', 'env', 'credentials', 'authenticated', 'platform']) {
    assert.throws(() => prepareAuthProfile({ client: 'copilot', [extra]: secret }), code('INVALID_OPTIONS'));
  }
  assert.throws(() => prepareAuthProfile(null), code('INVALID_OPTIONS'));
  profile('copilot', handle => {
    assert.throws(() => planAuthCommands(handle, { env: { GH_TOKEN: secret } }), code('INVALID_OPTIONS'));
    assert.throws(() => planAuthCommands(handle, { executable: secret }), code('EXECUTABLE_REQUIRED'));
    assert.throws(() => planAuthCommands(handle, { executable: path.join(handle.directory, 'launch.cmd') }), code('EXECUTABLE_REQUIRED'));
  });
});

test('environment configuration, help evidence and credential-file existence never prove auth', () => {
  profile('claude-code', handle => {
    const filename = path.join(describeAuthProfile(handle).paths.claude, '.credentials.json');
    fs.writeFileSync(filename, JSON.stringify({ token: secret }));
    const description = describeAuthProfile(handle);
    assert.equal(description.authenticationVerified, false);
    assert.equal(description.authenticated, false);
    assert.equal(description.liveAccepted, false);
    assert.equal(JSON.stringify(description).includes(secret), false);
    assert.throws(() => requireAuthenticatedProfile(handle), code('AUTHENTICATION_UNVERIFIED'));
    assert.throws(() => inspectAuthRuntime(handle, { executable }), code('PROFILE_NOT_EMPTY'));
  });
});

test('help inspection invokes only fixed version/help commands in the pristine owned profile', () => {
  for (const client of clients) profile(client, handle => {
    const calls = [];
    spawnMock((file, args, options) => {
      calls.push(args);
      assert.equal(file, executable);
      const description = describeAuthProfile(handle);
      assert.equal(options.cwd, description.paths.workspace);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 15000);
      assert.equal(options.maxBuffer, 256 * 1024);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(Object.hasOwn(options.env, 'PATH'), false);
      assert.equal(Object.hasOwn(options.env, 'OPENCODE_AUTH_CONTENT'), false);
      if (client === 'opencode') {
        assert.equal(options.env.OPENCODE_DB, path.join(description.paths.state, 'opencode-native.db'));
        assert.equal(options.env.XDG_DATA_HOME, description.paths.data);
      } else {
        assert.equal(Object.hasOwn(options.env, 'OPENCODE_DB'), false);
      }
      assert.ok(args.includes('--version') || args.includes('--help') || args[0] === 'help');
      return { status: 0, stdout: args[0] === '--version' ? CLIENT_VERSIONS[client] :
        `auth login status list /user COPILOT_HOME ${secret}`, stderr: '' };
    }, () => {
      const runtime = inspectAuthRuntime(handle, { executable });
      assert.equal(runtime.version, CLIENT_VERSIONS[client]);
      assert.equal(runtime.help.length, 4);
      assert.equal(runtime.authenticationVerified, false);
      assert.equal(runtime.liveAccepted, false);
      assert.equal(JSON.stringify(runtime).includes(secret), false);
      for (const item of runtime.help) assert.match(item.sha256, /^[a-f0-9]{64}$/);
      assert.equal(planAuthCommands(handle, { executable }).login.runtimeVerified, true);
      assert.throws(() => requireAuthenticatedProfile(handle), code('AUTHENTICATION_UNVERIFIED'));
      assert.equal(describeAuthProfile(handle).liveAccepted, false);
    });
    assert.equal(calls.length, 5);
  });
});

test('native version drift, failed execution, missing commands and secret output fail closed', () => {
  for (const [result, failure] of [
    [{ status: 0, stdout: '99.99.99', stderr: secret }, 'RUNTIME_DRIFT'],
    [{ status: 0, stdout: '2.1.291-beta', stderr: secret }, 'RUNTIME_DRIFT'],
    [{ status: 0, stdout: `2.1.291-${secret}`, stderr: secret }, 'RUNTIME_DRIFT'],
    [{ status: 1, stdout: secret, stderr: secret }, 'HELP_FAILED'],
    [{ status: null, error: new Error(secret), stderr: secret }, 'HELP_FAILED']
  ]) profile('claude-code', handle => {
    spawnMock(() => result, () => {
      assert.throws(() => inspectAuthRuntime(handle, { executable }), code(failure));
      assert.equal(describeAuthProfile(handle).runtime, null);
    });

  });
  profile('opencode', handle => {
    spawnMock((file, args) => ({ status: 0, stdout: args[0] === '--version' ? '1.14.28' : secret }), () => {
      assert.throws(() => inspectAuthRuntime(handle, { executable }), code('UNSUPPORTED_HELP'));
    });
  });
});

test('forged, modified marker and destroyed handles cannot inspect, plan or clean', () => {
  const handle = prepareAuthProfile({ client: 'copilot' });
  for (const operation of [describeAuthProfile, planAuthCommands, cleanupAuthProfile]) {
    assert.throws(() => operation({ ...handle }), code('OWNERSHIP'));
  }
  const filename = path.join(handle.directory, '.owner.json');
  const original = fs.readFileSync(filename);
  fs.writeFileSync(filename, 'tampered');
  assert.throws(() => cleanupAuthProfile(handle), code('OWNERSHIP'));
  fs.writeFileSync(filename, original);
  cleanupAuthProfile(handle);
  assert.equal(fs.existsSync(handle.directory), false);
  assert.throws(() => describeAuthProfile(handle), code('OWNERSHIP'));
  assert.throws(() => cleanupAuthProfile(handle), code('OWNERSHIP'));
});

test('a failed repeat help inspection invalidates earlier runtime evidence', () => {
  profile('claude-code', handle => {
    spawnMock((file, args) => ({ status: 0, stdout: args[0] === '--version' ? '2.1.291' : 'auth login status' }), () => {
      inspectAuthRuntime(handle, { executable });
      assert.equal(planAuthCommands(handle, { executable }).login.runtimeVerified, true);
    });
    spawnMock(() => ({ status: 1, stdout: secret }), () => {
      assert.throws(() => inspectAuthRuntime(handle, { executable }), code('HELP_FAILED'));
    });
    assert.equal(planAuthCommands(handle, { executable }).login.runtimeVerified, false);
    assert.equal(describeAuthProfile(handle).runtime, null);
  });
});

test('persisted help evidence honestly separates observed pins from the Copilot blocker', () => {
  const evidence = JSON.parse(fs.readFileSync(new URL('../harness/auth/help-evidence.json', import.meta.url), 'utf8'));
  assert.equal(evidence.authenticationVerified, false);
  assert.equal(evidence.liveAccepted, false);
  for (const client of ['claude-code', 'opencode']) {
    assert.equal(evidence.clients[client].version, CLIENT_VERSIONS[client]);
    assert.match(evidence.clients[client].versionHash, /^[a-f0-9]{64}$/);
    assert.equal(evidence.clients[client].help.length, 4);
    for (const item of evidence.clients[client].help) assert.match(item.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(evidence.clients.copilot.runtimeVerified, false);
  assert.equal(evidence.clients.copilot.requiredVersion, CLIENT_VERSIONS.copilot);
  assert.ok(evidence.clients.copilot.blocker);
  assert.equal(Object.hasOwn(evidence.clients.copilot, 'help'), false);
});

test('junction protection preserves unrelated profile and refuses cleanup through links', () => {
  const handle = prepareAuthProfile({ client: 'copilot' });
  const other = prepareAuthProfile({ client: 'opencode' });
  const workspace = describeAuthProfile(handle).paths.workspace;
  const sentinel = path.join(describeAuthProfile(other).paths.workspace, 'sentinel.txt');
  fs.writeFileSync(sentinel, secret);
  fs.rmdirSync(workspace);
  try {
    fs.symlinkSync(other.directory, workspace, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => describeAuthProfile(handle), code('OWNERSHIP'));
    assert.throws(() => cleanupAuthProfile(handle), code('OWNERSHIP'));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), secret);
  } finally {
    if (fs.lstatSync(workspace).isSymbolicLink()) fs.unlinkSync(workspace);
    fs.mkdirSync(workspace);
    cleanupAuthProfile(handle);
    cleanupAuthProfile(other);
  }
});

test('nested links and hardlinked marker cannot be traversed or deleted by cleanup', () => {
  const handle = prepareAuthProfile({ client: 'claude-code' });
  const other = prepareAuthProfile({ client: 'opencode' });
  const home = describeAuthProfile(handle).paths.home;
  const link = path.join(home, 'external');
  try {
    fs.symlinkSync(other.directory, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => cleanupAuthProfile(handle), code('OWNERSHIP'));
    fs.unlinkSync(link);
    const marker = path.join(handle.directory, '.owner.json');
    fs.linkSync(marker, path.join(home, 'marker-link'));
    assert.throws(() => describeAuthProfile(handle), code('OWNERSHIP'));
    fs.unlinkSync(path.join(home, 'marker-link'));
  } finally {
    cleanupAuthProfile(handle);
    cleanupAuthProfile(other);
  }
});

test('missing owned directories and nonempty help profiles fail before spawn', () => {
  profile('opencode', handle => {
    const workspace = describeAuthProfile(handle).paths.workspace;
    fs.rmdirSync(workspace);
    assert.throws(() => planAuthCommands(handle), code('OWNERSHIP'));
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), secret);
    spawnMock(() => { throw new Error('Unexpected native execution'); }, () => {
      assert.throws(() => inspectAuthRuntime(handle, { executable }), code('PROFILE_NOT_EMPTY'));
    });
  });

  test('preparation rolls back its partial profile after a filesystem failure', () => {
    const original = fs.mkdirSync;
    let directory;
    const replacement = mock.method(fs, 'mkdirSync', (filename, options) => {
      if (/^auth-[a-f0-9-]{36}$/.test(path.basename(filename))) directory = filename;
      if (directory && filename === path.join(directory, 'config')) throw new Error(secret);
      return original(filename, options);
    });
    try {
      assert.throws(() => prepareAuthProfile({ client: 'copilot' }), code('PREPARATION_FAILED'));
      assert.ok(directory);
      assert.equal(fs.existsSync(directory), false);
    } finally { replacement.mock.restore(); }
  });
});
