import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ContractError, CONTRACT_VERSION, POLICY, hashContent } from '../index.mjs';
import { CLIENT_VERSIONS } from '../isolation/index.mjs';

const root = fileURLToPath(new URL('.work/', import.meta.url));
const handles = new WeakMap();
const commands = Object.freeze({
  'claude-code': { executable: 'claude', login: ['auth', 'login'], status: ['auth', 'status'],
    help: [['--help'], ['auth', '--help'], ['auth', 'login', '--help'], ['auth', 'status', '--help']] },
  copilot: { executable: 'copilot', login: ['login'], status: [], interactiveInput: '/user',
    help: [['--help'], ['login', '--help'], ['help', 'commands'], ['help', 'environment']] },
  opencode: { executable: 'opencode', login: ['auth', 'login'], status: ['auth', 'list'],
    help: [['--help'], ['auth', '--help'], ['auth', 'login', '--help'], ['auth', 'list', '--help']] }
});
const limitations = Object.freeze({
  'claude-code': [
    'CLAUDE_CONFIG_DIR separates ordinary settings and claude.ai login, not all authentication stores.',
    'Claude Console no-key Anthropic profiles may be stored outside CLAUDE_CONFIG_DIR; do not log into Console on a shared OS account.',
    'HOME redirection is not Windows Credential Manager/keychain isolation or managed-policy isolation.'
  ],
  copilot: [
    'COPILOT_HOME redirects files, not the OS keychain service copilot-cli (Windows Credential Manager).',
    'Copilot may fall back to gh auth token. An empty GH_CONFIG_DIR and no inherited PATH reduce discovery, but do not isolate the OS keychain.',
    'No pinned noninteractive authentication-status subcommand is assumed; /user requires an interactive native session, which may initialize network services.'
  ],
  opencode: [
    'Use native auth login provider selection and a supported account OAuth method; not every provider offers account login.',
    'XDG_DATA_HOME redirects the native auth.json file; auth list lists stored providers, not credential validity or model entitlement.',
    'OPENCODE_DB separates native session state from the auth data root, not credentials from in-process tools.',
    'Native provider settings, plugins, organization/managed configuration and filesystem discovery require separate containment validation.'
  ]
});
const commonBlockers = Object.freeze([
  'No actual native login or authentication verification has occurred.',
  'This host profile is preparation, not a sandbox: ancestor project configuration, OS credentials and managed settings are not proven isolated.',
  'Live direct-endpoint egress, credential-access/tool boundaries and bounded native consumption remain unverified.',
  'Explicit native-account spend authorization and exact human baseline approval have not been captured.',
  'Offline scripted probes and environment-only configuration cannot unlock live execution.'
]);

export class AuthError extends ContractError {
  constructor(code, message) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

function check(condition, code, message) {
  if (!condition) throw new AuthError(code, message);
}

function options(value, keys) {
  check(value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).every(key => keys.includes(key)), 'INVALID_OPTIONS', 'Unsupported auth preparation options');
}

function plainPath(filename) {
  let cursor = path.resolve(filename);
  while (true) {
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      check(error.code === 'ENOENT', 'OWNERSHIP', 'Cannot verify owned auth path');
    }
    if (stat) {
      check(stat.isDirectory() && !stat.isSymbolicLink(), 'OWNERSHIP', 'Linked or non-directory auth ancestor');
      check(fs.realpathSync(cursor).toLowerCase() === cursor.toLowerCase(),
        'OWNERSHIP', 'Redirected auth ancestor');
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}

function owned(handle) {
  const state = handles.get(handle);
  check(state && !state.deleted, 'OWNERSHIP', 'Unknown or destroyed auth profile');
  plainPath(state.directory);
  const filename = path.join(state.directory, '.owner.json');
  let stat;
  try { stat = fs.lstatSync(filename); } catch {
    throw new AuthError('OWNERSHIP', 'Missing auth ownership marker');
  }
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
    stat.size === Buffer.byteLength(state.marker), 'OWNERSHIP', 'Invalid auth ownership marker');
  check(fs.readFileSync(filename, 'utf8') === state.marker, 'OWNERSHIP', 'Auth ownership marker mismatch');
  for (const directory of Object.values(state.paths)) {
    plainPath(directory);
    check(fs.existsSync(directory), 'OWNERSHIP', 'Missing owned auth directory');
  }
  return state;
}

function scan(state, { pristine = false } = {}) {
  let entries = 0;
  function walk(directory, depth) {
    check(depth <= 16, 'OWNERSHIP', 'Auth tree depth exceeded');
    for (const name of fs.readdirSync(directory)) {
      check(++entries <= 2048, 'OWNERSHIP', 'Auth tree entry limit exceeded');
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename);
      check(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile() && stat.nlink === 1),
        'OWNERSHIP', 'Linked or unsupported auth entry');
      if (stat.isDirectory()) {
        plainPath(filename);
        if (pristine) check(Object.values(state.paths).includes(filename), 'PROFILE_NOT_EMPTY', 'Help inspection requires a pristine prepared profile');
        walk(filename, depth + 1);
      } else if (pristine) {
        check(filename === path.join(state.directory, '.owner.json'), 'PROFILE_NOT_EMPTY', 'Help inspection requires a pristine prepared profile');
      }
    }
  }
  walk(state.directory, 0);
}

function environment(paths, client) {
  // Deliberately no ambient PATH: it could discover gh or shell hooks outside this profile.
  const env = { HOME: paths.home, USERPROFILE: paths.home, APPDATA: paths.appdata,
    LOCALAPPDATA: paths.localappdata, XDG_CONFIG_HOME: paths.config,
    XDG_CACHE_HOME: paths.cache, XDG_DATA_HOME: paths.data, XDG_STATE_HOME: paths.state,
    CLAUDE_CONFIG_DIR: paths.claude, COPILOT_HOME: paths.copilot,
    GH_CONFIG_DIR: paths.gh, TMPDIR: paths.scratch, TMP: paths.scratch, TEMP: paths.scratch };
  if (client === 'opencode') env.OPENCODE_DB = path.join(paths.state, 'opencode-native.db');
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'WINDIR']) {
      const value = process.env[key];
      if (typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value)) env[key] = value;
    }
    env.HOMEDRIVE = path.parse(paths.home).root.replace(/[\\/]$/, '');
    env.HOMEPATH = paths.home.slice(env.HOMEDRIVE.length);
  }
  return Object.freeze(env);
}

export function prepareAuthProfile(input) {
  options(input, ['client']);
  check(typeof input.client === 'string' && Object.hasOwn(commands, input.client),
    'UNSUPPORTED_CLIENT', 'Unsupported native auth client');
  plainPath(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const directory = path.join(root, `auth-${id}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const marker = JSON.stringify({ id, client: input.client, version: CONTRACT_VERSION, purpose: 'native-auth-preparation' });
  const paths = Object.freeze(Object.fromEntries(
    ['home', 'workspace', 'appdata', 'localappdata', 'config', 'cache', 'data', 'state',
      'claude', 'copilot', 'gh', 'scratch'].map(name => [name, path.join(directory, name)])));
  const state = { id, directory, client: input.client, paths, marker, deleted: false, runtime: null };
  try {
    fs.writeFileSync(path.join(directory, '.owner.json'), marker, { flag: 'wx', mode: 0o600 });
    for (const child of Object.values(paths)) fs.mkdirSync(child, { mode: 0o700 });
    const handle = Object.freeze({ id, directory, client: input.client });
    handles.set(handle, state);
    return handle;
  } catch {
    try {
      plainPath(directory);
      scan(state, { pristine: true });
      fs.rmSync(directory, { recursive: true, force: false });
    } catch {
      throw new AuthError('PREPARATION_CLEANUP_FAILED',
        'Auth preparation failed and safe owned cleanup could not be verified');
    }
    throw new AuthError('PREPARATION_FAILED', 'Auth profile preparation failed; partial owned profile removed');
  }
}

export function describeAuthProfile(handle) {
  const state = owned(handle);
  scan(state);
  return Object.freeze({
    version: CONTRACT_VERSION, repeats: POLICY.repeats, client: state.client,
    clientVersion: CLIENT_VERSIONS[state.client], id: state.id, directory: state.directory,
    paths: state.paths, env: environment(state.paths, state.client), configured: true,
    authenticationVerified: false, authenticated: false, liveAccepted: false, liveSupported: false,
    credentialsRead: false, loginExecuted: false, runtime: state.runtime,
    blockers: Object.freeze([...commonBlockers, ...limitations[state.client]])
  });
}

function executablePath(executable) {
  check(typeof executable === 'string' && path.isAbsolute(executable) &&
    !/[\0\r\n]/.test(executable) && !/\.(?:cmd|bat|ps1|js|mjs)$/i.test(executable),
  'EXECUTABLE_REQUIRED', 'Explicit absolute native executable required; shell wrappers are not supported');
  // Windows app execution aliases need not be ordinary files visible to stat.
  // Availability and the required pin are checked only by help inspection.
  return executable;
}

export function planAuthCommands(handle, input = {}) {
  options(input, ['executable']);
  const state = owned(handle);
  scan(state);
  const spec = commands[state.client];
  const executable = input.executable === undefined ? spec.executable : executablePath(input.executable);
  const resolved = input.executable !== undefined;
  const plan = (kind, args, interactiveInput) => Object.freeze({
    kind, executable, args: Object.freeze([...args]), cwd: state.paths.workspace,
    env: environment(state.paths, state.client), ...(interactiveInput ? { interactiveInput } : {}),
    executeAutomatically: false, requiresOperator: true, requiresExecutableResolution: !resolved,
    runtimeVerified: state.runtime?.executable === executable,
    requiresCredentialStoreIsolation: true
  });
  return Object.freeze({
    client: state.client, authenticationVerified: false, liveAccepted: false,
    login: plan('native-login', spec.login),
    status: plan(state.client === 'copilot' ? 'interactive-account-inspection' : 'native-status', spec.status, spec.interactiveInput),
    blockers: describeAuthProfile(handle).blockers
  });
}

export function inspectAuthRuntime(handle, input) {
  options(input, ['executable']);
  const state = owned(handle);
  scan(state, { pristine: true });
  state.runtime = null;
  const executable = executablePath(input.executable);
  function run(args) {
    const result = spawnSync(executable, args, {
      cwd: state.paths.workspace, env: environment(state.paths, state.client), shell: false,
      windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    check(!result.error && result.status === 0, 'HELP_FAILED',
      'Pinned native version/help inspection failed; output intentionally discarded');
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  }
  const version = run(['--version']);
  const observedVersion = version.match(/(?:^|[^\d.])(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)(?=[^\d.]|$)/)?.[1];
  check(observedVersion === CLIENT_VERSIONS[state.client],
    'RUNTIME_DRIFT', 'Installed native auth client differs from the required pin');
  const spec = commands[state.client];
  const help = spec.help.map(args => ({ args, text: run(args) }));
  const all = help.map(item => item.text).join('\n');
  const required = state.client === 'copilot' ? ['login', '/user', 'COPILOT_HOME'] :
    state.client === 'opencode' ? ['auth', 'login', 'list'] : ['auth', 'login', 'status'];
  check(required.every(word => all.includes(word)), 'UNSUPPORTED_HELP', 'Required native auth commands absent from installed help');
  // Return hashes and fixed command identities only, never captured help/error/credential text.
  state.runtime = Object.freeze({
    client: state.client, version: CLIENT_VERSIONS[state.client], executable,
    versionHash: hashContent(version), help: Object.freeze(help.map(item => Object.freeze({
      args: Object.freeze([...item.args]), sha256: hashContent(item.text)
    }))), authenticationVerified: false, liveAccepted: false
  });
  return state.runtime;
}

export function requireAuthenticatedProfile(handle) {
  owned(handle);
  throw new AuthError('AUTHENTICATION_UNVERIFIED',
    'Configured native profile is not authentication proof and cannot authorize live execution');
}

export function cleanupAuthProfile(handle) {
  const state = owned(handle);
  scan(state);
  fs.rmSync(state.directory, { recursive: true, force: false });
  state.deleted = true;
}
