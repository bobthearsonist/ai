import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  issueToolTask, prepareToolWorker, startToolWorker, requestToolWorker,
  inspectToolWorker, captureToolWorkerArtifacts, closeToolWorker, leaseToolWorkerTransport,
  resolveToolWorkerTransportLease, assertToolWorkerTransportBinding, TOOL_WORKER_IMAGE
} from './index.mjs';
import { FLAGS, ToolWorkerError, insist, sha256, hashJson } from './worker.mjs';
import { exactResourceAbsence } from './ownership.mjs';
import { runBoundedProcess, sanitizedDockerEnvironment } from '../live-boundary/supervision.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWNER = 'ai.skill-eval.tool-worker.experiment';
const peers = new WeakMap();
const publicSkill = '---\nname: synthetic-worker\ndescription: Public tool-worker experiment only.\n---\nRead inputs/public.txt and write artifacts/report.txt. This is not native Skill proof.\n';
const publicInput = 'Synthetic public input for a new isolated filesystem experiment.\n';
const artifact = 'Synthetic artifact produced through the owned worker socket.\n';

function peerProgram(binding, canary, identity, negativeOnly, attacks) {
  if (negativeOnly) return `
import net from 'node:net';
const socket = net.createConnection('/tool-rpc/worker.sock');
const timer = setTimeout(() => { socket.destroy(); process.exitCode = 70; }, 3000);
socket.once('connect', () => { clearTimeout(timer); socket.destroy(); console.log(JSON.stringify({scope:'kernel-socket-permissions',outcome:'UNEXPECTED_CONNECTION',uid:process.getuid(),gid:process.getgid(),groups:process.getgroups()})); process.exitCode=70; });
socket.once('error', error => { clearTimeout(timer); console.log(JSON.stringify({scope:'kernel-socket-permissions',outcome:error.code,uid:process.getuid(),gid:process.getgid(),groups:process.getgroups()})); if(error.code!=='EACCES') process.exitCode=70; });
`;
  return `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const insist = (value, code) => { if(!value) throw new Error(code); };
const canary = process.env.SYNTHETIC_CREDENTIAL_CANARY;
insist(canary && process.getuid() === ${identity.uid} && process.getgid() === ${identity.gid}, 'IDENTITY_OR_CANARY');
fs.writeFileSync('/synthetic-credentials/credential-canary.txt', canary, {flag:'wx',mode:0o600});
const procEnvironment = fs.readFileSync('/proc/self/environ');
insist(procEnvironment.includes(Buffer.from('SYNTHETIC_CREDENTIAL_CANARY='+canary)), 'SYNTHETIC_ENV_NOT_OBSERVED');
const namespaces = Object.fromEntries(['pid','mnt','user','net','ipc'].map(kind => [kind,hash(fs.readlinkSync('/proc/self/ns/'+kind))]));
const kernelDenials = [];
for (const [label, fn] of [
 ['socket-volume-listing', () => fs.readdirSync('/tool-rpc')],
 ['socket-volume-write', () => fs.writeFileSync('/tool-rpc/peer-file.txt','synthetic',{flag:'wx'})],
 ['worker-workspace-visibility', () => fs.lstatSync('/workspace/data/inputs/public.txt')]
]) {
 try { fn(); throw new Error('UNEXPECTED_FILESYSTEM_ACCESS'); }
 catch(error) { insist(['EACCES','EROFS','ENOENT'].includes(error.code),label); kernelDenials.push({scope:'peer-kernel-filesystem',label,outcome:error.code}); }
}
const command = ${JSON.stringify(binding.stdioCommand)};
const child = spawn(command[0],command.slice(1),{env:{},shell:false,stdio:['pipe','pipe','pipe']});
let buffer = Buffer.alloc(0), pending, total = 0, stderr = 0, closed = false;
let rejectExit, resolveExit;
const exit = new Promise((resolve,reject)=>{resolveExit=resolve;rejectExit=reject;});
child.on('error',()=>rejectExit(new Error('SHIM_PROCESS')));
child.stderr.on('data', chunk=>{stderr+=chunk.length;});
child.stdout.on('data',chunk=>{
 total+=chunk.length; insist(total<=524288,'PEER_OUTPUT_LIMIT'); buffer=Buffer.concat([buffer,chunk]);
 const newline=buffer.indexOf(10); if(newline<0) {insist(buffer.length<=32768,'PEER_RECORD_LIMIT');return;}
 insist(pending && newline<=32768 && buffer.length===newline+1,'PEER_RESPONSE_SEQUENCE');
 const record=JSON.parse(buffer.subarray(0,newline).toString('utf8')); buffer=Buffer.alloc(0);
 const current=pending;pending=undefined;current.resolve(record);
});
child.once('close',code=>{closed=true;if(code===0&&stderr===0&&!pending)resolveExit();else{pending?.reject(new Error('SHIM_FAILURE'));rejectExit(new Error('SHIM_FAILURE'));}});
let id=0;
const rpc=(method,params)=>new Promise((resolve,reject)=>{insist(!pending,'PEER_BUSY');pending={resolve,reject};child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:++id,method,...(params===undefined?{}:{params})})+'\\n');});
const call=async(name,args)=>{
 const response=await rpc('tools/call',{name,arguments:args});
 if(response.error)return {shimError:response.error.code};
 insist(response.result?.content?.length===1,'SHIM_CONTENT');
 return JSON.parse(response.result.content[0].text);
};
const timer=setTimeout(()=>{child.kill('SIGKILL');rejectExit(new Error('PEER_TIMEOUT'));},20000);
try {
 const initialized=await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'synthetic-node-peer',version:'1'}});
 insist(initialized.result?.serverInfo?.name==='eval-filesystem-worker','MCP_INITIALIZE');
 const listed=await rpc('tools/list');
 insist(listed.result?.tools?.map(tool=>tool.name).join(',')==='eval_read_public,eval_write_artifact,eval_read_artifact','MCP_TOOL_LIST');
 const skill=await call('eval_read_public',{path:'skills/synthetic-worker/SKILL.md'});
 const input=await call('eval_read_public',{path:'inputs/public.txt'});
 insist(skill.ok&&skill.result.sha256===${JSON.stringify(sha256(publicSkill))},'PUBLIC_SKILL_READ');
 insist(input.ok&&input.result.sha256===${JSON.stringify(sha256(publicInput))},'PUBLIC_INPUT_READ');
 const write=await call('eval_write_artifact',{path:'artifacts/report.txt',contentBase64:${JSON.stringify(Buffer.from(artifact).toString('base64'))}});
 const readback=await call('eval_read_artifact',{path:'artifacts/report.txt'});
 insist(write.ok&&readback.ok&&readback.result.sha256===${JSON.stringify(sha256(artifact))},'DISK_WRITE_READBACK');
 const denials=[];
 for(const attack of ${JSON.stringify(attacks)}) {
  const result=await call(attack.name,attack.arguments);
  const outcome=result.shimError ?? result.code;
  insist(result.shimError || result.ok===false,'ATTACK_NOT_DENIED');
  denials.push({label:attack.label,scope:result.shimError?'fixed-mcp-shim-schema':'actual-worker-tool-protocol',outcome,
   ...(result.diagnosticHash?{diagnosticHash:result.diagnosticHash}:{})});
 }
 child.stdin.end();await exit;clearTimeout(timer);
 console.log(JSON.stringify({
  scope:'credential-free-node-peer-only',kernel:{uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),namespaces,environmentNames:Object.keys(process.env).sort()},
  canary:{fileHash:hash(fs.readFileSync('/synthetic-credentials/credential-canary.txt')),environmentHash:hash(canary),procEnvironmentObserved:true},
  positives:[{operation:'public-skill-bytes-read',sha256:skill.result.sha256},{operation:'public-input-bytes-read',sha256:input.result.sha256},{operation:'artifact-write-and-on-disk-readback',sha256:readback.result.sha256}],
  kernelDenials,denials,
  authenticationVerified:false,nativeDiscoveryVerified:false,liveAccepted:false
 }));
} finally {clearTimeout(timer);if(!closed)child.kill('SIGKILL');}
`;
}
function attacks() {
  const read = (label, filename) => ({ label, name: 'eval_read_public', arguments: { path: filename } });
  return [
    read('traversal', 'inputs/../outside.txt'), read('absolute-host', '/etc/passwd'),
    read('windows-host', 'C:\\synthetic-credentials\\credential-canary.txt'),
    read('undeclared-public', 'inputs/not-selected.txt'), read('case-alias', 'inputs/Public.txt'),
    read('private-grading-namespace', 'inputs/private/expected.txt'),
    read('credential-namespace', 'inputs/credentials.json'),
    read('peer-synthetic-credential-file', '/synthetic-credentials/credential-canary.txt'),
    read('proc-environment', '/proc/self/environ'), read('foreign-proc-root', '/proc/1/root/synthetic-credentials/credential-canary.txt'),
    read('docker-socket', '/var/run/docker.sock'), read('home-import', '/home/node/.config/auth.json'),
    read('config-namespace', 'inputs/.config/opencode.json'), read('client-config-file', 'inputs/settings.json'),
    { label: 'undeclared-target', name: 'eval_write_artifact',
      arguments: { path: 'artifacts/not-selected.txt', contentBase64: 'eA==' } },
    { label: 'public-source-write', name: 'eval_write_artifact',
      arguments: { path: 'inputs/public.txt', contentBase64: 'eA==' } },
    { label: 'artifact-traversal', name: 'eval_write_artifact',
      arguments: { path: 'artifacts/../inputs/public.txt', contentBase64: 'eA==' } },
    { label: 'symlink-import', name: 'eval_write_artifact',
      arguments: { path: 'artifacts/report.txt', contentBase64: '', symlink: '/synthetic-credentials' } },
    { label: 'hardlink-import', name: 'eval_write_artifact',
      arguments: { path: 'artifacts/report.txt', contentBase64: '', hardlink: '/synthetic-credentials/credential-canary.txt' } },
    { label: 'private-expected-metadata', name: 'eval_read_public',
      arguments: { path: 'inputs/public.txt', expected: 'synthetic-private-answer-never-sent-to-worker' } },
    { label: 'environment-override', name: 'eval_read_public',
      arguments: { path: 'inputs/public.txt', env: { SYNTHETIC_CREDENTIAL_CANARY: 'synthetic' } } },
    { label: 'shell-tool', name: 'eval_shell', arguments: { path: 'inputs/public.txt' } }
  ];
}
function originalPeer(handle) {
  const state = peers.get(handle);
  insist(state && !state.closed && fs.readFileSync(state.marker).equals(state.markerBytes),
    'ORIGINAL_EXPERIMENT_PEER_REQUIRED');
  for (const filename of [state.directory, state.marker, state.configDirectory]) {
    const stat = fs.lstatSync(filename);
    insist(!stat.isSymbolicLink() && (stat.isDirectory() || (stat.isFile() && stat.nlink === 1)),
      'EXPERIMENT_OWNERSHIP_CHANGED');
  }
  insist(fs.readdirSync(state.configDirectory).length === 0, 'EXPERIMENT_CONFIG_IMPORT');
  return state;
}
async function dockerPeer(handle, args, cleanup = false) {
  const state = originalPeer(handle);
  return runBoundedProcess('docker', ['--config', state.configDirectory, ...args], {
    cwd: state.directory, env: sanitizedDockerEnvironment(state.configDirectory),
    deadline: cleanup ? Date.now() + 15000 : state.deadline,
    maxOutputBytes: 131072, allowFailure: cleanup
  });
}
function inspectPeerIdentity(state, container) {
  insist(container.Id === state.id && container.Name === `/${state.name}` &&
    container.Config?.Labels?.[OWNER] === state.nonce, 'EXPERIMENT_CONTAINER_OWNERSHIP');
}
async function cleanupPeer(handle) {
  const state = originalPeer(handle);
  const inspected = await dockerPeer(handle, ['inspect', state.id ?? state.name], true);
  let removed = false;
  if (inspected.exitCode === 0) {
    const [container] = JSON.parse(inspected.stdout);
    state.id ??= container.Id;
    inspectPeerIdentity(state, container);
    const result = await dockerPeer(handle, ['rm', '--force', state.id], true);
    insist(result.exitCode === 0, 'EXPERIMENT_PEER_CLEANUP');
    const absence = await dockerPeer(handle, ['inspect', state.id], true);
    insist(exactResourceAbsence(absence, 'container', state.id), 'EXPERIMENT_PEER_CLEANUP');
    removed = true;
  } else {
    insist(exactResourceAbsence(inspected, 'container', state.id ?? state.name), 'EXPERIMENT_PEER_CLEANUP');
  }
  originalPeer(handle);
  fs.rmSync(state.directory, { recursive: true, force: false });
  insist(!fs.existsSync(state.directory), 'EXPERIMENT_DIRECTORY_CLEANUP');
  state.closed = true;
  return { exactOwnedPeerRemoved: removed, ownedDirectoryRemoved: true };
}
async function runPeer(original, identity, { negativeOnly = false, attackList = [] } = {}) {
  await assertToolWorkerTransportBinding(original);
  const binding = original.binding;
  const nonce = randomUUID();
  const directory = path.join(HERE, '.owned', `peer-${nonce}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  const state = {
    nonce, directory, marker: path.join(directory, '.owner.json'),
    configDirectory: path.join(directory, 'docker-config'), name: `eval-tool-peer-${nonce}`,
    id: null, deadline: Date.now() + 25000, closed: false,
    markerBytes: Buffer.from(JSON.stringify({ nonce, taskHash: binding.taskHash, bindingHash: hashJson(binding) }))
  };
  fs.writeFileSync(state.marker, state.markerBytes, { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(state.configDirectory);
  const handle = Object.freeze({ kind: 'synthetic-tool-peer' });
  peers.set(handle, state);
  const canary = `SYNTHETIC-EXTERNAL-CREDENTIAL-${randomBytes(16).toString('hex')}`;
  const program = peerProgram(binding, canary, identity, negativeOnly, attackList);
  let report;
  let failure;
  try {
    await assertToolWorkerTransportBinding(original);
    const args = [
      'create', '--pull', 'never', '--platform', 'linux/amd64', '--name', state.name,
      '--label', `${OWNER}=${nonce}`, '--network', 'none', '--read-only', '--user', `${identity.uid}:${identity.gid}`,
      ...(!negativeOnly ? ['--group-add', `${binding.supplementalGid}`] : []),
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--init',
      '--memory', '128m', '--memory-swap', '128m', '--cpus', '1', '--pids-limit', '32', '--ipc', 'none',
      '--log-driver', 'none', '--restart', 'no', '--stop-timeout', '1',
      '--tmpfs', `/scratch:rw,noexec,nosuid,nodev,size=1m,mode=700,uid=${identity.uid},gid=${identity.gid}`,
      '--tmpfs', `/synthetic-credentials:rw,noexec,nosuid,nodev,size=64k,mode=700,uid=${identity.uid},gid=${identity.gid}`,
      '--mount', `type=volume,source=${binding.transportMount.source},target=/tool-rpc,readonly,volume-nocopy`,
      '--entrypoint', '/usr/bin/env', TOOL_WORKER_IMAGE,
      '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'TMPDIR=/scratch', 'LANG=C.UTF-8',
      ...(!negativeOnly ? [`SYNTHETIC_CREDENTIAL_CANARY=${canary}`] : []),
      '/usr/local/bin/node', '--input-type=module', '--eval', program
    ];
    const creation = await dockerPeer(handle, args);
    insist(/^[a-f0-9]{64}$/.test(creation.stdout.trim()), 'EXPERIMENT_CONTAINER_ID');
    state.id = creation.stdout.trim();
    const [container] = JSON.parse((await dockerPeer(handle, ['inspect', state.id])).stdout);
    inspectPeerIdentity(state, container);
    insist(container.Config.User === `${identity.uid}:${identity.gid}` &&
      container.HostConfig.NetworkMode === 'none' && container.HostConfig.ReadonlyRootfs &&
      !container.HostConfig.PidMode && container.HostConfig.Mounts?.length === 1 &&
      container.Mounts?.length === 1 && container.Mounts[0].Type === 'volume' &&
      container.Mounts[0].Name === binding.transportMount.source && container.Mounts[0].RW === false &&
      container.HostConfig.Mounts[0].VolumeOptions?.NoCopy === true, 'EXPERIMENT_PEER_CONFINEMENT');
    await assertToolWorkerTransportBinding(original);
    const execution = await dockerPeer(handle, ['start', '--attach', state.id]);
    const [finished] = JSON.parse((await dockerPeer(handle, ['inspect', state.id])).stdout);
    inspectPeerIdentity(state, finished);
    insist(!finished.State.Running && !finished.State.OOMKilled && finished.State.ExitCode === 0 &&
      execution.stderr === '', 'EXPERIMENT_PEER_EXECUTION');
    report = JSON.parse(execution.stdout);
    if (negativeOnly) insist(report.outcome === 'EACCES', 'EXPERIMENT_PERMISSION_DENIAL');
    else {
      insist(report.kernel.uid === identity.uid && report.kernel.gid === identity.gid &&
        report.kernel.groups.includes(binding.supplementalGid) &&
        report.canary.fileHash === sha256(canary) && report.canary.environmentHash === sha256(canary),
      'EXPERIMENT_PEER_DIAGNOSTICS');
    }
  } catch (error) { failure = error; }
  const cleanup = await cleanupPeer(handle);
  if (failure) throw new ToolWorkerError(failure.code ?? 'EXPERIMENT_PEER_FAILED', { cleanup });
  return { ...report, cleanup };
}

export async function runToolWorkerExperiment() {
  const task = issueToolTask({
    invocationId: `worker-${randomUUID()}`, caseId: 'new-synthetic-worker-custody',
    client: 'claude-code', arm: 'candidate', repeat: 1
  });
  const worker = prepareToolWorker({
    task, publicFiles: [{ path: 'skills/synthetic-worker/SKILL.md', content: publicSkill },
      { path: 'inputs/public.txt', content: publicInput }], artifactTargets: ['artifacts/report.txt']
  });
  const evidence = {
    experiment: 'new-credential-free-socket-worker', startedAt: new Date().toISOString(),
    scope: 'actual-Docker-worker-and-synthetic-Node-peers-not-native-client-auth-or-Skill',
    ...FLAGS
  };
  let failure;
  try {
    evidence.initialWorker = await startToolWorker({ task, worker });
    const lease = await leaseToolWorkerTransport({ task, worker });
    const binding = await resolveToolWorkerTransportLease({ task, worker, lease });
    const original = { task, worker, lease, binding };
    evidence.originalAuthorityDenials = [];
    for (const [label, options] of [
      ['copied-worker', { task, worker: { ...worker }, lease, binding }],
      ['copied-task', { task: { ...task }, worker, lease, binding }],
      ['copied-lease', { task, worker, lease: { ...lease }, binding }],
      ['copied-binding', { task, worker, lease, binding: { ...binding } }],
      ['cross-task', { task: issueToolTask({ ...task.coordinates }), worker, lease, binding }]
    ]) {
      try {
        await assertToolWorkerTransportBinding(options);
        throw new ToolWorkerError('FORGED_AUTHORITY_ACCEPTED');
      } catch (error) {
        insist(['ORIGINAL_WORKER_SCOPE_REQUIRED', 'ORIGINAL_TASK_REQUIRED',
          'ORIGINAL_TRANSPORT_LEASE_REQUIRED', 'ORIGINAL_TRANSPORT_BINDING_REQUIRED'].includes(error.code),
        'FORGED_AUTHORITY_ACCEPTED');
        evidence.originalAuthorityDenials.push({ label, scope: 'host-original-handle-authority', code: error.code });
      }
    }
    evidence.socketPermissionDenial = await runPeer(original, { uid: 1000, gid: 1000 }, { negativeOnly: true });
    evidence.peers = [];
    evidence.peers.push(await runPeer(original, { uid: 1000, gid: 1000 }, { attackList: attacks() }));
    evidence.peers.push(await runPeer(original, { uid: 10001, gid: 10001 }));
    const read = await requestToolWorker({ task, worker,
      request: { op: 'read-artifact', path: 'artifacts/report.txt' } });
    insist(read.ok && read.result.sha256 === sha256(artifact), 'HOST_ARTIFACT_READBACK');
    const capture = await captureToolWorkerArtifacts({ task, worker });
    insist(capture.artifacts.length === 1 && capture.artifacts[0].content.equals(Buffer.from(artifact)),
      'HOST_ARTIFACT_CAPTURE');
    evidence.capture = {
      captureHash: capture.captureHash, artifacts: capture.artifacts.map(({ content, ...item }) => item),
      missing: capture.missing, actualDiskBytesRead: true, gradingPerformed: false
    };
    evidence.finalWorker = await inspectToolWorker({ task, worker });
    evidence.kernelComparison = evidence.peers.map(peer => ({
      peerUid: peer.kernel.uid, peerGid: peer.kernel.gid,
      pidNamespaceSeparated: peer.kernel.namespaces.pid !== evidence.finalWorker.kernel.namespaces.pid,
      mountNamespaceSeparated: peer.kernel.namespaces.mnt !== evidence.finalWorker.kernel.namespaces.mnt,
      networkNamespaceSeparated: peer.kernel.namespaces.net !== evidence.finalWorker.kernel.namespaces.net,
      userNamespaceSeparated: peer.kernel.namespaces.user !== evidence.finalWorker.kernel.namespaces.user,
      distinctUnprivilegedUid: peer.kernel.uid !== evidence.finalWorker.kernel.uid,
      workerDidNotInheritSyntheticCanaryEnvironment: !evidence.finalWorker.kernel.environmentNames.includes('SYNTHETIC_CREDENTIAL_CANARY'),
      workerSyntheticCredentialPathOutcome: evidence.finalWorker.kernel.checks['/synthetic-credentials/credential-canary.txt']
    }));
    insist(evidence.kernelComparison.every(item => item.pidNamespaceSeparated && item.mountNamespaceSeparated &&
      item.networkNamespaceSeparated && item.distinctUnprivilegedUid &&
      item.workerDidNotInheritSyntheticCanaryEnvironment && item.workerSyntheticCredentialPathOutcome === 'ENOENT'),
    'EXPERIMENT_KERNEL_SEPARATION');
    evidence.status = 'completed-worker-only-experiment';
  } catch (error) {
    failure = error;
    evidence.status = 'explicit-worker-experiment-error';
    evidence.error = { code: error.code ?? 'EXPERIMENT_FAILED', diagnosticHash: error.diagnosticHash ?? hashJson({ code: error.code }) };
  } finally {
    try { evidence.cleanup = await closeToolWorker({ task, worker }); }
    catch (error) {
      evidence.cleanupError = { code: error.code, causeCode: error.causeCode };
      failure = error;
      evidence.status = 'explicit-cleanup-error';
    }
  }
  evidence.finishedAt = new Date().toISOString();
  evidence.remainingBlockers = [
    'Native original candidate/builders must consume and recheck the original transport lease/binding, not copied mount/command fields.',
    'Native built-in arbitrary file/shell tools and ambient MCP/configuration must be disabled; only this explicit fixed MCP stdio shim may be enabled.',
    'Native issuer must verify the selected candidate actual UID/GID (1000 or10001), preserve it, and add supplemental GID21000; this module does not verify a caller identity assertion.',
    'Native consumer lifetime/removal must be joined to worker cancellation before exact socket-volume cleanup.',
    'No native client/catalog/model/auth/Skill event was observed. MCP public-byte reading is not native Skill loading.',
    'Docker daemon-default user namespaces may be shared; distinct UID and PID/mount namespaces are measured separately.'
  ];
  evidence.evidenceHash = hashJson(evidence);
  const filename = path.join(HERE, `experiment-evidence-${Date.now()}-${randomUUID()}.json`);
  fs.writeFileSync(filename, JSON.stringify(evidence, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ evidence: filename, evidenceHash: evidence.evidenceHash,
    status: evidence.status, error: evidence.error, cleanup: evidence.cleanup,
    peerIdentities: evidence.kernelComparison, ...FLAGS }, null, 2));
  if (failure) throw failure;
  return evidence;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runToolWorkerExperiment().catch(error => {
    console.error(`Tool worker experiment failed explicitly: ${error.code ?? 'EXPERIMENT_FAILED'}`);
    process.exitCode = 1;
  });
}
