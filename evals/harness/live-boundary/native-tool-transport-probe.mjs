import fs from 'node:fs';

try {
  const config = JSON.parse(fs.readFileSync('/boundary/config.json', 'utf8'));
  const transport = config.toolTransport;
  if (process.argv.length !== 3 || process.argv[2] !== '--inspect' ||
    !transport || !Number.isSafeInteger(transport.deadlineUnixMs) ||
    Date.now() >= Math.min(config.expiresAt, transport.deadlineUnixMs)) throw new Error('socket-probe');
  const directory = fs.lstatSync('/tool-rpc');
  const socket = fs.lstatSync('/tool-rpc/worker.sock');
  if (directory.isSymbolicLink() || !directory.isDirectory() ||
    socket.isSymbolicLink() || !socket.isSocket() ||
    fs.realpathSync('/tool-rpc') !== '/tool-rpc' ||
    fs.readdirSync('/tool-rpc').join(',') !== 'worker.sock') throw new Error('socket-probe');
  process.stdout.write(JSON.stringify({
    owner: config.owner, candidateId: config.candidateId, nodeVersion: process.versions.node,
    deadlineUnixMs: transport.deadlineUnixMs, uid: process.getuid(), gid: process.getgid(),
    supplementaryGroups: process.getgroups(),
    directory: { path: '/tool-rpc', type: 'directory', uid: directory.uid, gid: directory.gid, mode: directory.mode & 0o7777 },
    socket: { path: '/tool-rpc/worker.sock', type: 'socket', uid: socket.uid, gid: socket.gid, mode: socket.mode & 0o7777 },
    connected: false
  }));
} catch {
  process.stderr.write('Native socket attachment infrastructure failure\n');
  process.exitCode = 70;
}
