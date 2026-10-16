import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { BINARY, CLIENT_VERSION, buildConfig, buildArguments, validateProbe, validateArtifactTargets } from './index.mjs';
import { createScriptedServer, executeNative, SYNTHETIC_CANARY } from './scripted-protocol.mjs';

const CANARY = SYNTHETIC_CANARY;
const artifactTargets = validateArtifactTargets(JSON.parse(process.env.EVAL_OPENCODE_ARTIFACT_TARGETS ?? '["answer.md","message.txt"]'), { required: true });
const artifactCalls = artifactTargets.map(target => ['write', { filePath: `/work/project/${target}`, content: `OFFLINE_ARTIFACT_${target}\n` }]);
const attacks = [
  ['read', { filePath: '/proc/self/environ' }],
  ['read', { filePath: '/work/project/private/credential.txt' }],
  ['read', { filePath: '/work/project/out-of-scope.txt' }],
  ['bash', { command: 'printf attack', description: 'Synthetic denial probe' }],
  ['webfetch', { url: 'https://example.invalid/', format: 'text' }],
  ['write', { filePath: '/work/project/attacker.txt', content: 'attack' }],
  ['write', { filePath: '/work/attacks/home/attacker.txt', content: 'attack' }],
  ['write', { filePath: '/work/attacks/config/opencode/opencode.json', content: 'attack' }],
  ['write', { filePath: '/work/project/fixture.txt', content: 'attack' }],
  ['write', { filePath: '/work/project/private/credential.txt', content: 'attack' }],
  ['write', { filePath: '/work/project/.opencode/skills/offline-target/SKILL.md', content: 'attack' }],
  ...['answer.md', 'message.txt'].filter(t => !artifactTargets.includes(t))
    .map(t => ['write', { filePath: `/work/project/${t}`, content: 'attack' }])
];
let active;
const requests = [];
const { server, errors: protocolErrors } = createScriptedServer({
  next(body) {
    if (!active || active.step > attacks.length) throw new Error('Unexpected fixture request');
    const resultBlocks = body.messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
      .filter(b => b.type === 'tool_result');
    requests.push({ scenario: active.scenario, tools: body.tools.map(t => t.name), results: resultBlocks });
    const step = active.step++;
    const calls = active.scenario === 'positive'
      ? [['skill', { name: 'offline-target' }], ['read', { filePath: '/work/project/fixture.txt' }], ...artifactCalls]
      : active.scenario === 'negative' ? [['skill', { name: 'offline-target' }], ...artifactCalls] : attacks;
    return { step, call: calls[step] };
  }
});

function execute(args, options = {}) {
  return executeNative({ binary: BINARY, args, cwd: '/work/project', env: { ...process.env, ...options.env } });
}

try {
  fs.mkdirSync('/work/project', { recursive: true });
  const version = spawnSync(BINARY, ['--version'], { encoding: 'utf8' }).stdout.trim();
  if (version !== CLIENT_VERSION) throw new Error(`Version drift: ${version}`);
  const helpResult = spawnSync(BINARY, ['run', '--help'], { encoding: 'utf8' });
  if (helpResult.status !== 0) throw new Error('Pinned CLI help failed');
  const help = helpResult.stdout + helpResult.stderr;
  if (!['--pure', '--format', '--model', '--title'].every(flag => help.includes(flag))) throw new Error('Pinned CLI help drift');
  const network = await new Promise(resolve => {
    const socket = net.connect({ host: '192.0.2.1', port: 443 });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); resolve({ externalBlocked: false }); });
    socket.once('error', e => { socket.destroy(); resolve({ externalBlocked: true, errorCode: e.code }); });
    socket.once('timeout', () => { socket.destroy(); resolve({ externalBlocked: true, errorCode: 'TIMEOUT' }); });
  });
  network.interfaces = Object.keys(os.networkInterfaces());
  await new Promise(resolve => server.listen(43128, '127.0.0.1', resolve));
  const scenarios = {};
  const artifacts = {};
  const skillContent = '---\nname: offline-target\ndescription: Owned offline test skill\n---\nOFFLINE_SKILL_BODY\nRead fixture.txt.\n';
  for (const scenario of ['positive', 'negative', 'attacks']) {
    const skill = '/work/project/.opencode/skills/offline-target';
    fs.rmSync('/work/project', { recursive: true, force: true });
    fs.mkdirSync('/work/project/private', { recursive: true });
    fs.writeFileSync('/work/project/private/credential.txt', CANARY);
    fs.writeFileSync('/work/project/out-of-scope.txt', 'OUT_OF_SCOPE_SENTINEL');
    fs.writeFileSync('/work/project/fixture.txt', 'SCOPED_FIXTURE_CONTENT');
    if (scenario !== 'negative') {
      fs.mkdirSync(skill, { recursive: true });
      fs.writeFileSync(`${skill}/SKILL.md`, skillContent);
    }
    active = { scenario, step: 0 };
    const config = buildConfig({ artifactTargets });
    const result = await execute(buildArguments(), { env: {
      HOME: `/work/${scenario}/home`, XDG_CONFIG_HOME: `/work/${scenario}/config`,
      XDG_CACHE_HOME: `/work/${scenario}/cache`, XDG_DATA_HOME: `/work/${scenario}/data`, XDG_STATE_HOME: `/work/${scenario}/state`,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), SYNTHETIC_AUTH_CANARY: CANARY,
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1'
    } });
    scenarios[scenario] = result;
    if (protocolErrors.length) throw new Error('Scripted fixture protocol failed');
    if (scenario === 'positive') {
      const errors = result.stdout.split('\n').filter(Boolean).map(JSON.parse)
        .filter(e => e.type === 'error' || e.type === 'tool_use' && e.part.state.status === 'error');
      if (errors.length) throw new Error(`Actual positive tool errors: ${JSON.stringify(errors)}`);
    }
    if (scenario !== 'attacks') {
      artifacts[scenario] = Object.fromEntries(artifactTargets.map(target => {
        const filename = `/work/project/${target}`;
        const stat = fs.lstatSync(filename);
        return [target, { content: fs.readFileSync(filename, 'utf8'), regularFile: stat.isFile() && !stat.isSymbolicLink() }];
      }));
    }
  }
  const protectedFiles = {
    homeWriteAbsent: !fs.existsSync('/work/attacks/home/attacker.txt'),
    configWriteAbsent: !fs.existsSync('/work/attacks/config/opencode/opencode.json'),
    fixtureUnchanged: fs.readFileSync('/work/project/fixture.txt', 'utf8') === 'SCOPED_FIXTURE_CONTENT',
    credentialUnchanged: fs.readFileSync('/work/project/private/credential.txt', 'utf8') === CANARY,
    skillUnchanged: fs.readFileSync('/work/project/.opencode/skills/offline-target/SKILL.md', 'utf8') === skillContent,
    sentinelUnchanged: fs.readFileSync('/work/project/out-of-scope.txt', 'utf8') === 'OUT_OF_SCOPE_SENTINEL'
  };
  const accepted = validateProbe({ ...scenarios, requests, network,
    writeAbsent: !fs.existsSync('/work/project/attacker.txt') &&
      ['answer.md', 'message.txt'].filter(t => !artifactTargets.includes(t)).every(t => !fs.existsSync(`/work/project/${t}`)),
    artifactTargets, artifacts, protectedFiles });
  console.log(JSON.stringify({ ...accepted, scenarios, versions: { opencode: version, node: process.versions.node,
    ripgrep: spawnSync('rg', ['--version'], { encoding: 'utf8' }).stdout.trim().split('\n')[0] },
    cliHelp: help, skillPath: '.opencode/skills/offline-target/SKILL.md',
    freshWorkspacePerScenario: true, freshHomePerScenario: true, authentication: 'synthetic-canary-only' }));
} catch (e) { console.error(e.stack); process.exitCode = 1; }
finally { server.close(); }
