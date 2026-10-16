import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION } from '../harness/index.mjs';
import {
  OFFLINE_NODE_IMAGE, OFFLINE_NODE_VERSION, DOCKER_ENGINE_VERSION, CLIENT_VERSIONS,
  validateIsolationProfile, assessClientCapabilities, buildClientEnvironment, redact,
  materializeAgentContext, createWorkspace, destroyWorkspace, writeEvidence, buildDockerArguments,
  createExecutor, assertClientRuntimeEvidence, recoverOwnedContainers
} from '../harness/isolation/index.mjs';

function profile(overrides = {}) {
  return {
    contractVersion: CONTRACT_VERSION, id: 'synthetic-offline-isolation', runner: 'isolation-primitives@0.1.0',
    image: OFFLINE_NODE_IMAGE,
    clients: Object.fromEntries(Object.entries(CLIENT_VERSIONS).map(([client, version]) => [
      client, { version, model: 'offline-no-model', endpoint: 'https://provider.invalid', settings: { tools: ['skill', 'fixture-read'] } }
    ])),
    auth: 'none-offline', limits: { turns: 1, tokens: 1, seconds: 30, concurrency: 1 },
    earlyExit: false, cache: false, ...overrides
  };
}
function task(overrides = {}) {
  return { invocationId: randomUUID(), caseId: 'synthetic-probe', client: 'claude-code', arm: 'candidate', repeat: 1, ...overrides };
}
function workspace(t, options = {}) {
  const handle = createWorkspace({ task: task(), ...options });
  t.after(async () => {
    await recoverOwnedContainers(handle);
    destroyWorkspace(handle);
    assert.equal(fs.existsSync(handle.directory), false);
  });
  return handle;
}
const runtime = { kind: 'offline-probe', executable: 'node', version: OFFLINE_NODE_VERSION };
const dockerTest = { skip: process.env.EVAL_ISOLATION_DOCKER !== '1', timeout: 120000 };
function run(executor, handle, script, options = {}) {
  return executor.run({ workspace: handle, command: ['node', '-e', script], runtime, ...options });
}
function errorCode(code) { return error => error?.code === code; }

test('offline profile verifies semantic contract and finite isolation caps', () => {
  const validation = validateIsolationProfile(profile());
  assert.equal(validation.network, 'none');
  assert.equal(validation.authenticationVerified, false);
  assert.match(validation.liveBlocker, /egress restriction/);
  assert.throws(() => validateIsolationProfile(profile({ limits: { turns: 1, tokens: 1, seconds: 301, concurrency: 1 } })), /caps/);
  assert.throws(() => validateIsolationProfile(profile({ limits: { turns: 1, tokens: 1, seconds: 30, concurrency: 5 } })), /caps/);
  assert.throws(() => validateIsolationProfile(profile({ image: 'node:22-slim' })), /image|profile/i);
  assert.throws(() => validateIsolationProfile(profile({ earlyExit: true })), /profile/i);
  assert.throws(() => validateIsolationProfile(profile({ auth: 'direct-provider' })), /none-offline/);
});

test('all live profiles fail closed before credentials or forged boundary claims', () => {
  const live = profile({ auth: 'direct-provider',
    clients: { ...profile().clients, copilot: { ...profile().clients.copilot,
      settings: { egressVerified: true, network: 'bridge', tools: ['skill', 'fixture-read'] } } } });
  assert.throws(() => createExecutor(live, { mode: 'live' }), errorCode('LIVE_BOUNDARY_UNVERIFIED'));
  const values = new Proxy({}, { ownKeys() { throw new Error('Credentials accessed too soon'); } });
  assert.throws(() => buildClientEnvironment({ client: 'copilot', values, profile: live, mode: 'live' }), errorCode('LIVE_BOUNDARY_UNVERIFIED'));
});

test('environment allowlist excludes arbitrary tooling, secret values and host inheritance', () => {
  const env = buildClientEnvironment({ client: 'copilot', profile: profile(), values: { COPILOT_MODEL: 'model-pin', COPILOT_PROVIDER_TYPE: 'anthropic' } });
  assert.equal(env.COPILOT_HOME, '/client-config/copilot');
  assert.equal(env.HOME, '/home/eval');
  assert.equal(env.PATH, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.throws(() => buildClientEnvironment({ client: 'copilot', profile: profile(), values: { NODE_OPTIONS: '--require attacker' } }), /allowlist/);
  const secret = 'synthetic-super-secret-value';
  assert.throws(() => buildClientEnvironment({ client: 'copilot', profile: profile(), values: { COPILOT_PROVIDER_API_KEY: secret } }),
    error => /Credentials/.test(error.message) && !error.message.includes(secret));
  assert.throws(() => buildClientEnvironment({ client: 'copilot', profile: profile(), values: { COPILOT_PROVIDER_TYPE: 'gateway' } }), /provider/);
  assert.throws(() => buildClientEnvironment({ client: 'claude-code', profile: profile(), values: { ANTHROPIC_BASE_URL: 'https://user:password@example.invalid' } }), /URL credentials/);
});

test('capability evidence pins versions, exact flag surfaces, and never treats help as live acceptance', () => {
  const evidence = assessClientCapabilities({
    client: 'claude-code', version: CLIENT_VERSIONS['claude-code'],
    help: '--bare --restricted --permission-mode --permission-prompts --strict-mcp-config --tools --allowedTools --disallowedTools'
  });
  assert.equal(evidence.flagSurfaceVerified, true);
  assert.equal(evidence.liveSupported, false);
  assert.deepEqual(evidence.toolPolicy, ['skill', 'fixture-read']);
  assert.equal(evidence.helpHash.length, 64);
  assert.equal(assessClientCapabilities({ client: 'copilot', version: CLIENT_VERSIONS.copilot, help: '--available-tools-wrong' }).missing.includes('--available-tools'), true);
  assert.equal(assessClientCapabilities({ client: 'opencode', version: CLIENT_VERSIONS.opencode, help: '--help' }).flagSurfaceVerified, false);
  assert.throws(() => assessClientCapabilities({ client: 'copilot', version: '1.0.93', help: '--help' }), errorCode('RUNTIME_DRIFT'));
});

test('workspaces are fresh per invocation/client/arm/repeat and cleanup preserves siblings', () => {
  const first = createWorkspace({ task: task() });
  const second = createWorkspace({ task: task({ client: 'copilot', arm: 'baseline', repeat: 2 }) });
  try {
    assert.notEqual(first.directory, second.directory);
    assert.deepEqual(fs.readdirSync(path.join(first.directory, 'docker-config')), []);
    assert.throws(() => destroyWorkspace({ ...first }), /Unknown/);
    destroyWorkspace(first);
    assert.equal(fs.existsSync(second.directory), true);
    assert.throws(() => destroyWorkspace(first), /destroyed/);
  } finally {
    if (fs.existsSync(first.directory)) destroyWorkspace(first);
    destroyWorkspace(second);
  }
});

test('materialization rejects traversal, absolute paths, collisions, auth stores and directory copying', () => {
  for (const invalid of ['..\\escape', '\\absolute', 'C:\\home', 'a\\..\\b', 'a\\', 'NUL.txt', 'a.\\b']) {
    assert.throws(() => createWorkspace({ task: task(), inputs: [{ path: invalid, content: 'bad' }] }), /path/i);
  }
  assert.throws(() => createWorkspace({ task: task(), inputs: [{ path: 'a', content: 'a' }, { path: 'A\\b', content: 'b' }] }), /colliding/);
  assert.throws(() => createWorkspace({ task: task(), inputs: [{ path: 'a', source: 'C:\\Users' }] }), /explicit/);
  assert.throws(() => createWorkspace({ task: task(), inputs: [{ path: '.claude\\settings.json', mountRoot: 'home', content: '{}' }] }), /configuration stores/);
  assert.throws(() => createWorkspace({ task: task(), inputs: [{ path: 'auth.json', mountRoot: 'home', content: '{}' }] }), /credential/);
  assert.throws(() => createWorkspace({ task: task(), config: [{ path: 'settings.json', mountRoot: 'home', content: '{}' }] }), /Config seeds/);
  assert.throws(() => createWorkspace({ task: task(), inputs: [{ path: 'huge', content: Buffer.alloc(1024 * 1024 + 1) }] }), /byte cap/);
});

test('mountRoot routes HOME separately; literal home prefix has no magic meaning', t => {
  const handle = workspace(t, { inputs: [
    { path: 'AI\\README.md', mountRoot: 'home', content: 'synthetic home' },
    { path: 'home\\AI\\README.md', content: 'ordinary workspace path' },
    { path: 'AI\\README.md', mountRoot: 'workspace', content: 'workspace namespace' }
  ], config: [{ path: 'claude\\settings.json', content: '{"synthetic":true}' }] });
  assert.equal(fs.readFileSync(path.join(handle.directory, 'home', 'AI', 'README.md'), 'utf8'), 'synthetic home');
  assert.equal(fs.readFileSync(path.join(handle.directory, 'inputs', 'home', 'AI', 'README.md'), 'utf8'), 'ordinary workspace path');
  assert.equal(fs.readFileSync(path.join(handle.directory, 'inputs', 'AI', 'README.md'), 'utf8'), 'workspace namespace');
  assert.equal(fs.existsSync(path.join(handle.directory, 'home', '.claude')), false);
});

test('agent context excludes judge dependencies and honors explicit roots', t => {
  const source = workspace(t, { inputs: [
    { path: 'public.txt', content: 'agent document' }, { path: 'judge.txt', content: 'judge answer key' }
  ] });
  const loaded = { root: path.join(source.directory, 'inputs'), suite: { context: { dependencies: [
    { visibility: 'agent', availability: 'provided', path: 'public.txt', mount: 'AI\\README.md', mountRoot: 'home' },
    { visibility: 'agent', availability: 'unavailable' },
    { visibility: 'judge', availability: 'provided', path: 'judge.txt', mount: 'answer.txt' }
  ] } } };
  const inputs = materializeAgentContext(loaded);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].mountRoot, 'home');
  assert.equal(inputs[0].content.toString(), 'agent document');
  loaded.suite.context.dependencies[0].path = '..\\judge.txt';
  assert.throws(() => materializeAgentContext(loaded), /path|traversal/i);
});

test('owned seed mutation into a symlink/junction is rejected before Docker', t => {
  const handle = workspace(t);
  const unrelated = workspace(t, { inputs: [{ path: 'sentinel.txt', content: 'do-not-mount' }] });
  fs.symlinkSync(path.join(unrelated.directory, 'inputs'), path.join(handle.directory, 'inputs', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildDockerArguments({ profile: profile(), workspace: handle,
    command: ['node', '--version'], containerName: `skill-eval-${randomUUID()}` }), /Symlink/);
  assert.equal(fs.readFileSync(path.join(unrelated.directory, 'inputs', 'sentinel.txt'), 'utf8'), 'do-not-mount');
});

test('seed content, undeclared files and hardlinks cannot broaden selected inputs', t => {
  const handle = workspace(t, { inputs: [{ path: 'fixture.txt', content: 'original' }] });
  const filename = path.join(handle.directory, 'inputs', 'fixture.txt');
  fs.chmodSync(filename, 0o600);
  fs.writeFileSync(filename, 'tampered');
  const args = () => buildDockerArguments({ profile: profile(), workspace: handle,
    command: ['node', '--version'], containerName: `skill-eval-${randomUUID()}` });
  assert.throws(args, /Seed content changed/);
  fs.writeFileSync(filename, 'original');
  const added = path.join(handle.directory, 'inputs', 'added.txt');
  fs.writeFileSync(added, 'undeclared');
  assert.throws(args, /undeclared/);
  fs.unlinkSync(added);
  fs.linkSync(filename, added);
  assert.throws(args, /hardlinked/);
});

test('Docker argv fixes confinement with no shell, arbitrary mounts, logs, or pull', t => {
  const handle = workspace(t);
  const args = buildDockerArguments({ profile: profile(), workspace: handle, command: ['node', '--version'], containerName: `skill-eval-${randomUUID()}` });
  const joined = args.join(' ');
  for (const required of ['--pull never', '--network none', '--read-only', '--user 10001:10001', '--cap-drop ALL',
    'no-new-privileges=true', '--pids-limit 64', '--log-driver none', '--platform linux/amd64', '--entrypoint node']) {
    assert.ok(joined.includes(required), required);
  }
  assert.equal(args.filter(arg => arg === '--mount').length, 3);
  assert.equal(args.filter(arg => arg === '--tmpfs').length, 4);
  assert.equal(joined.includes('docker.sock'), false);
  assert.equal(joined.includes('--privileged'), false);
  assert.equal(joined.includes('--env-file'), false);
  assert.equal(args.includes(OFFLINE_NODE_IMAGE), true);
});

test('redaction happens before evidence persistence including keys, URL credentials and explicit encodings', t => {
  const handle = workspace(t);
  const secret = 'synthetic/secret+value';
  const evidence = {
    stdout: `Bearer ${secret} ${encodeURIComponent(secret)} ${Buffer.from(secret).toString('base64')}`,
    nested: { ANTHROPIC_API_KEY: secret, output: 'password=unlisted-value https://user:pass@example.invalid' }
  };
  const filename = writeEvidence(handle, evidence, { secrets: [secret], name: 'run\\evidence.json' });
  const bytes = fs.readFileSync(filename, 'utf8');
  for (const forbidden of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), 'unlisted-value', 'user:pass']) {
    assert.equal(bytes.includes(forbidden), false);
  }
  assert.match(bytes, /\[REDACTED\]/);
  assert.throws(() => writeEvidence(handle, evidence, { name: '..\\escape.json' }), /traversal/);
  assert.throws(() => writeEvidence(handle, evidence, { secrets: [secret], name: 'run\\evidence.json' }), /EEXIST/);
  assert.deepEqual(redact({ secret: 'never-persist' }), { secret: '[REDACTED]' });
  assert.deepEqual(redact({ inputTokens: 42, outputTokens: 12, tokenLimit: 100 }), { inputTokens: 42, outputTokens: 12, tokenLimit: 100 });
});

test('offline probe cannot be normalized as authenticated client evidence', () => {
  assert.throws(() => assertClientRuntimeEvidence({ runtime: { kind: 'offline-probe', clientVersion: null } }, profile(), 'claude-code'), /Offline Node/);
  assert.throws(() => assertClientRuntimeEvidence({ runtime: { kind: 'client', clientVersion: CLIENT_VERSIONS['claude-code'], authenticationVerified: false } }, profile(), 'claude-code'), /authenticated/);
});

test('pre-cancelled execution performs no Docker work and consumes only its own lease', async t => {
  const handle = workspace(t);
  const controller = new AbortController();
  controller.abort();
  const executor = createExecutor(profile());
  await assert.rejects(run(executor, handle, 'console.log("must not run")', { signal: controller.signal }), errorCode('CANCELLED'));
  await assert.rejects(run(executor, handle, 'console.log("must not reuse")'), /only once/);
  assert.deepEqual(await recoverOwnedContainers(handle), { owner: handle.id, removed: [] });
});

test('real Docker smoke: sentinels, credential-store prohibition, offline egress and read-only confinement', dockerTest, async t => {
  const sentinel = 'HOST_SENTINEL_MUST_NOT_LEAK';
  const previous = process.env.EVAL_SYNTHETIC_SECRET;
  process.env.EVAL_SYNTHETIC_SECRET = sentinel;
  t.after(() => { if (previous === undefined) delete process.env.EVAL_SYNTHETIC_SECRET; else process.env.EVAL_SYNTHETIC_SECRET = previous; });
  const outside = workspace(t, { inputs: [
    { path: 'host-sentinel.txt', content: sentinel },
    { path: '.claude\\skills\\sentinel\\SKILL.md', content: sentinel }
  ] });
  const handle = workspace(t, { inputs: [
    { path: 'fixture.txt', content: 'selected synthetic fixture' },
    { path: 'AI\\README.md', mountRoot: 'home', content: 'isolated synthetic HOME' }
  ], config: [{ path: 'claude\\settings.json', content: '{"marker":"synthetic-config"}' }] });
  const script = `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
assert.equal(process.getuid(), 10001);
assert.equal(process.env.HOME, '/home/eval');
assert.equal(process.env.CLAUDE_CONFIG_DIR, '/client-config/claude');
assert.equal(fs.readFileSync('/home/eval/AI/README.md', 'utf8'), 'isolated synthetic HOME');
assert.match(fs.readFileSync('/client-config/claude/settings.json', 'utf8'), /synthetic-config/);
assert.equal(fs.readFileSync('/workspace/fixture.txt', 'utf8'), 'selected synthetic fixture');
assert.equal(fs.existsSync('/home/eval/.claude'), false);
for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'COPILOT_PROVIDER_API_KEY', 'GITHUB_TOKEN', 'HOST_SENTINEL', 'EVAL_SYNTHETIC_SECRET']) {
  assert.equal(process.env[name], undefined);
}
for (const filename of ['/root/.claude/.credentials.json', '/root/.config/opencode/auth.json',
  '/root/.copilot', '/var/run/docker.sock', '/host', ${JSON.stringify(path.join(outside.directory, 'inputs', 'host-sentinel.txt'))}]) {
  assert.equal(fs.existsSync(filename), false, filename);
}
assert.throws(() => fs.writeFileSync('/eval/inputs/fixture.txt', 'tampered'), /EROFS|EACCES/);
assert.throws(() => fs.writeFileSync('/etc/escaped', 'tampered'), /EROFS|EACCES/);
assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /CapEff:\\s+0+\\s/);
assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /NoNewPrivs:\\s+1/);
assert.deepEqual(Object.keys(os.networkInterfaces()), ['lo']);
const targets = ['1.1.1.1', '169.254.169.254', '192.0.2.1', '127.0.0.1'];
Promise.all(targets.map(host => new Promise((resolve, reject) => {
  const socket = net.connect({host, port: 443});
  socket.setTimeout(500);
  socket.on('connect', () => { socket.destroy(); reject(new Error('Prohibited egress succeeded')); });
  socket.on('error', () => resolve());
  socket.on('timeout', () => { socket.destroy(); resolve(); });
}))).then(() => console.log(JSON.stringify({prohibitedTargetsBlocked:targets.length, sentinelAbsent:true}))).catch(error => { console.error(error); process.exitCode = 1; });
`;
  const result = await run(createExecutor(profile()), handle, script);
  assert.equal(result.status, 'completed', result.stderr);
  assert.equal(result.runtime.actualVersion, OFFLINE_NODE_VERSION);
  assert.equal(result.runtime.engineVersion, DOCKER_ENGINE_VERSION);
  assert.equal(result.runtime.clientVersion, null);
  assert.equal(result.runtime.authenticationVerified, false);
  assert.equal(result.isolation.network, 'none');
  assert.equal(result.isolation.bindMounts.length, 3);
  assert.ok(result.isolation.bindMounts.every(mount => mount.readOnly));
  assert.equal(result.isolation.cleanup, 'verified-owned-containers-removed');
  assert.deepEqual(JSON.parse(result.stdout), { prohibitedTargetsBlocked: 4, sentinelAbsent: true });
  writeEvidence(handle, result);
});

test('real Docker repeat: fresh workspace/HOME/config between clients and arms', dockerTest, async t => {
  const executor = createExecutor(profile());
  const a = workspace(t, { task: task() });
  const b = workspace(t, { task: task({ client: 'copilot', arm: 'baseline', repeat: 2 }) });
  const first = await run(executor, a, `const fs=require('node:fs'); for (const p of ['/home/eval/prior','/workspace/prior','/client-config/prior']) fs.writeFileSync(p,'sentinel'); console.log('first');`);
  const second = await run(executor, b, `const fs=require('node:fs'); const assert=require('node:assert/strict'); for (const p of ['/home/eval/prior','/workspace/prior','/client-config/prior']) assert.equal(fs.existsSync(p),false); console.log('fresh');`);
  assert.equal(first.status, 'completed', first.stderr);
  assert.equal(second.status, 'completed', second.stderr);
  assert.notEqual(first.executionId, second.executionId);
  assert.notEqual(first.isolation.containerId, second.isolation.containerId);
  assert.equal(second.stdout.trim(), 'fresh');
});

test('real Docker runtime drift is rejected before task command and cleans owned containers', dockerTest, async t => {
  const handle = workspace(t);
  await assert.rejects(run(createExecutor(profile()), handle, `console.log('must not execute')`,
    { runtime: { ...runtime, version: '22.15.1' } }), errorCode('RUNTIME_DRIFT'));
  assert.deepEqual((await recoverOwnedContainers(handle)).removed, []);
});

test('real Docker output cap kills and removes the owned container', dockerTest, async t => {
  const handle = workspace(t);
  await assert.rejects(run(createExecutor(profile()), handle, `process.stdout.write('x'.repeat(2*1024*1024)); setInterval(()=>{},1000);`), errorCode('OUTPUT_LIMIT'));
  assert.deepEqual((await recoverOwnedContainers(handle)).removed, []);
});

test('real Docker timeout is bounded and scoped cleanup preserves an unrelated workspace', dockerTest, async t => {
  const survivor = workspace(t, { inputs: [{ path: 'keep.txt', content: 'keep' }] });
  const handle = workspace(t);
  const began = Date.now();
  await assert.rejects(run(createExecutor(profile({ limits: { turns: 1, tokens: 1, seconds: 5, concurrency: 1 } })),
    handle, 'setInterval(()=>{},1000)'), errorCode('TIMEOUT'));
  assert.ok(Date.now() - began < 30000);
  assert.equal(fs.readFileSync(path.join(survivor.directory, 'inputs', 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual((await recoverOwnedContainers(handle)).removed, []);
});

test('real Docker cancellation during execution removes owned container and releases active handle', dockerTest, async t => {
  const handle = workspace(t);
  const controller = new AbortController();
  const result = run(createExecutor(profile()), handle, 'setInterval(()=>{},1000)', { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 3000);
  assert.throws(() => destroyWorkspace(handle), /active/);
  try { await assert.rejects(result, errorCode('CANCELLED')); }
  finally { clearTimeout(timer); }
  assert.deepEqual((await recoverOwnedContainers(handle)).removed, []);
});

test('real Docker concurrency cap serializes tasks; queue cancellation stays scoped', dockerTest, async t => {
  const executor = createExecutor(profile());
  const a = workspace(t);
  const b = workspace(t, { task: task({ repeat: 2 }) });
  const c = workspace(t, { task: task({ repeat: 3 }) });
  const wait = `const start=Date.now(); setTimeout(()=>console.log(JSON.stringify({start,end:Date.now()})),800);`;
  const first = run(executor, a, wait);
  const second = run(executor, b, wait);
  const controller = new AbortController();
  const third = run(executor, c, wait, { signal: controller.signal });
  const cancelled = assert.rejects(third, errorCode('CANCELLED'));
  controller.abort();
  const [one, two] = await Promise.all([first, second]);
  await cancelled;
  assert.equal(one.status, 'completed', one.stderr);
  assert.equal(two.status, 'completed', two.stderr);
  assert.ok(JSON.parse(two.stdout).start >= JSON.parse(one.stdout).end);
});

test('real Docker cancelling one owner does not remove another owner container', dockerTest, async t => {
  const survivor = workspace(t);
  const cancelled = workspace(t);
  const controller = new AbortController();
  const first = run(createExecutor(profile()), survivor, `setTimeout(()=>console.log('survived-owned-cleanup'),4000)`);
  const second = run(createExecutor(profile()), cancelled, 'setInterval(()=>{},1000)', { signal: controller.signal });
  const rejection = assert.rejects(second, errorCode('CANCELLED'));
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const completed = await first;
    await rejection;
    assert.equal(completed.status, 'completed', completed.stderr);
    assert.equal(completed.stdout.trim(), 'survived-owned-cleanup');
  } finally { clearTimeout(timer); }
});
