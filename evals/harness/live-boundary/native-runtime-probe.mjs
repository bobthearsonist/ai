import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const config = JSON.parse(fs.readFileSync('/boundary/config.json', 'utf8'));
const native = config.native;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let phase = 'CONFIGURATION';
const requireFact = (value, name) => { if (!value) { phase = name; throw new Error('native-probe'); } };

function executableHash(filename) {
  const stat = fs.statSync(filename);
  requireFact(stat.isFile() && stat.size > 0 && stat.size <= 512 * 1024 * 1024, 'EXECUTABLE');
  const fd = fs.openSync(filename, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.alloc(65536);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      requireFact(Date.now() < config.expiresAt, 'TIMEOUT');
      digest.update(buffer.subarray(0, count));
    }
  } finally { fs.closeSync(fd); }
  return digest.digest('hex');
}

async function command(argv) {
  requireFact(Date.now() < config.expiresAt, 'TIMEOUT');
  return new Promise((resolve, reject) => {
    const child = spawn(native.executable, argv, {
      cwd: native.workdir, env: process.env, shell: false, detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = { stdout: [], stderr: [] };
    let bytes = 0, failure, killTimer;
    const fail = reason => {
      if (failure) return;
      failure = reason;
      child.kill('SIGKILL');
      killTimer = setTimeout(() => { phase = 'PROCESS_STOP'; reject(new Error('native-probe')); }, 1500);
    };
    const timer = setTimeout(() => fail('TIMEOUT'), Math.min(20000, config.expiresAt - Date.now()));
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 131072) fail('OUTPUT_LIMIT');
      else if (!failure) output[stream].push(chunk);
    });
    child.once('error', () => { failure = 'EXECUTABLE'; });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (failure || exitCode !== 0 || signal) {
        phase = failure ?? 'CLI_EXIT';
        reject(new Error('native-probe'));
      } else resolve({ argv, exitCode, signal, stdout: Buffer.concat(output.stdout),
        stderr: Buffer.concat(output.stderr) });
    });
  });
}

try {
  requireFact(process.argv[2] === '--inspect' && native && native.commands === 'version-help-only',
    'CONFIGURATION');
  const [uid, gid] = native.user.split(':').map(Number);
  requireFact(process.getuid() === uid && process.getgid() === gid, 'UID');
  phase = 'EXECUTABLE';
  const resolvedExecutable = fs.realpathSync(native.executable);
  requireFact(resolvedExecutable.startsWith(native.executableRoot), 'EXECUTABLE');
  fs.accessSync(native.executable, fs.constants.X_OK);
  const packageVersion = JSON.parse(fs.readFileSync(native.package, 'utf8')).version;
  requireFact(packageVersion === native.clientVersion, 'CLI_VERSION');
  phase = 'LAYOUT';
  const directories = native.directories.map(filename => {
    const stat = fs.statSync(filename);
    requireFact(stat.isDirectory() && stat.uid === uid && stat.gid === gid, 'LAYOUT');
    fs.accessSync(filename, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return { path: filename, uid: stat.uid, gid: stat.gid, writable: true };
  });
  for (const filename of native.immutableDirectories) {
    requireFact(fs.statSync(filename).isDirectory(), 'LAYOUT');
    fs.accessSync(filename, fs.constants.R_OK | fs.constants.X_OK);
  }
  process.chdir(native.workdir);
  const version = await command([...(native.client === 'copilot' ? ['--no-auto-update'] : []), '--version']);
  const versionText = version.stdout.toString('utf8').trim();
  requireFact(native.client === 'claude-code' ? versionText === `${native.clientVersion} (Claude Code)`
    : native.client === 'opencode' ? versionText === native.clientVersion
      : new RegExp(`^GitHub Copilot CLI ${native.clientVersion.replaceAll('.', '\\.')}\\.[a-zA-Z0-9._-]*(?:\\r?\\n|$)`).test(versionText),
  'CLI_VERSION');
  const help = await command([...(native.client === 'copilot' ? ['--no-auto-update'] : []), '--help']);
  const helpText = help.stdout.toString('utf8') + help.stderr.toString('utf8');
  requireFact(helpText.trim() && native.helpFlags.every(flag => helpText.includes(flag)), 'CLI_HELP');
  requireFact(Date.now() < config.expiresAt, 'TIMEOUT');
  process.stdout.write(JSON.stringify({
    owner: config.owner, candidateId: config.candidateId,
    client: native.client, clientVersion: native.clientVersion, packageVersion,
    nodeVersion: process.versions.node, uid: process.getuid(), gid: process.getgid(),
    versionText,
    executable: native.executable, resolvedExecutable, executableHash: executableHash(resolvedExecutable),
    cwd: process.cwd(), directories,
    immutableDirectories: native.immutableDirectories,
    measuredAt: new Date().toISOString(),
    commands: [version, help].map(({ argv, exitCode, signal, stdout, stderr }) => ({
      argv, exitCode, signal, stdoutBytes: stdout.length, stderrBytes: stderr.length,
      stdoutHash: hash(stdout), stderrHash: hash(stderr)
    }))
  }));
} catch {
  process.stderr.write(`Native attachment infrastructure failure: ${phase}\n`);
  process.exitCode = 70;
}
