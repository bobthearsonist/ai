import { spawn } from 'node:child_process';
import { EgressBoundaryError, insist } from './errors.mjs';

export function runBoundedProcess(command, args, {
  cwd, env, deadline, signal, maxOutputBytes = 131072, allowFailure = false
}) {
  insist(Number.isFinite(deadline) && Number.isInteger(maxOutputBytes) &&
    maxOutputBytes > 0 && maxOutputBytes <= 262144, 'INVALID_ARGUMENT');
  if (signal?.aborted) return Promise.reject(new EgressBoundaryError('CANCELLED'));
  if (deadline <= Date.now()) return Promise.reject(new EgressBoundaryError('TIMEOUT'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env, shell: false, windowsHide: true, detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const output = { stdout: [], stderr: [] };
    let bytes = 0;
    let failure;
    let finished = false;
    let killTimer;
    function fail(code) {
      if (finished || failure) return;
      failure = new EgressBoundaryError(code);
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill('SIGKILL');
      killTimer = setTimeout(() => {
        if (finished) return;
        finished = true;
        reject(new EgressBoundaryError('PROCESS_STOP_UNVERIFIED'));
      }, 1500);
    }
    const abort = () => fail('CANCELLED');
    const timer = setTimeout(() => fail('TIMEOUT'), Math.max(1, deadline - Date.now()));
    signal?.addEventListener('abort', abort, { once: true });
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) fail('OUTPUT_LIMIT');
        else if (!failure) output[stream].push(chunk);
      });
    }
    child.once('error', () => {
      failure ??= new EgressBoundaryError('DOCKER_UNAVAILABLE');
    });
    child.once('close', (exitCode, processSignal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (finished) return;
      finished = true;
      if (failure) reject(failure);
      else if ((exitCode !== 0 || processSignal) && !allowFailure) reject(new EgressBoundaryError('DOCKER_FAILURE'));
      else resolve({
        exitCode, processSignal,
        stdout: Buffer.concat(output.stdout).toString('utf8'),
        stderr: Buffer.concat(output.stderr).toString('utf8')
      });
    });
    if (signal?.aborted) abort();
  });
}

export function sanitizedDockerEnvironment(configDirectory) {
  const env = {
    DOCKER_CONFIG: configDirectory,
    DOCKER_HOST: process.platform === 'win32'
      ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock',
    DOCKER_CLI_HINTS: 'false'
  };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function retryStartingExec(result, container) {
  const match = /^Error response from daemon: container ([a-f0-9]{64}) is not running$/i.exec(result.stderr.trim());
  return result.exitCode === 1 && match?.[1] === container?.Id &&
    ['created', 'running'].includes(container?.State?.Status);
}

export class DockerControl {
  constructor(directory, deadline, signal) {
    this.directory = directory;
    this.configDirectory = `${directory}${process.platform === 'win32' ? '\\' : '/'}docker-config`;
    this.env = sanitizedDockerEnvironment(this.configDirectory);
    this.deadline = deadline;
    this.signal = signal;
    this.services = new Set();
  }

  command(args, options = {}) {
    return runBoundedProcess('docker', ['--config', this.configDirectory, ...args], {
      cwd: this.directory, env: this.env, deadline: this.deadline, signal: this.signal, ...options
    });
  }

  attach(name) {
    insist(/^skill-egress-[a-f0-9-]{36}-(?:relay|candidate|fixture|native-[a-f0-9-]{36})$/.test(name),
      'OWNERSHIP_MISMATCH');
    const child = spawn('docker', ['--config', this.configDirectory, 'start', '--attach', name], {
      cwd: this.directory, env: this.env, shell: false, windowsHide: true,
      detached: false, stdio: ['ignore', 'pipe', 'pipe']
    });
    let bytes = 0;
    const service = { name, child, closed: false, stopping: false, failure: null, outputControl: null };
    const controls = new Set([
      'CONFIGURATION', 'TLS_CONTEXT', 'TLS_LISTEN', 'TCP_LISTEN', 'DNS_LISTEN', 'READY',
      'PERMISSION', 'ADDRESS_IN_USE'
    ]);
    let diagnostic = '';
    service.completion = new Promise(resolve => {
      child.once('error', () => { service.failure = new EgressBoundaryError('DOCKER_UNAVAILABLE'); });
      child.once('close', code => {
        service.closed = true;
        if (!service.stopping) service.failure ??= new EgressBoundaryError(code === 0 ? 'TIMEOUT' : 'DOCKER_FAILURE');
        resolve();
      });
    });
    for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= 4096) {
        diagnostic += chunk.toString('utf8');
        const match = /Local fixture infrastructure failure: ([A-Z_]+)(?: ([A-Z_]+))?/.exec(diagnostic);
        if (match && controls.has(match[1]) && (!match[2] || controls.has(match[2]))) {
          service.outputControl = [match[1], match[2]].filter(Boolean).join(':');
        }
      }
      if (bytes > 4096) {
        service.failure = new EgressBoundaryError('OUTPUT_LIMIT');
        child.kill('SIGKILL');
      }
    });
    this.services.add(service);
    return service;
  }

  assertServices() {
    for (const service of this.services) {
      if (service.failure) throw service.failure;
      insist(!service.closed, 'DOCKER_FAILURE');
    }
  }

  async closeAttachment(name) {
    const service = [...this.services].find(item => item.name === name);
    insist(service, 'OWNERSHIP_MISMATCH');
    service.stopping = true;
    if (!service.closed) service.child.kill('SIGKILL');
    let timer;
    try {
      await Promise.race([
        service.completion,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new EgressBoundaryError('PROCESS_STOP_UNVERIFIED')), 2000);
        })
      ]);
    } finally { clearTimeout(timer); }
    insist(service.closed, 'PROCESS_STOP_UNVERIFIED');
    this.services.delete(service);
    return 1;
  }

  async closeAttachments() {
    const services = [...this.services];
    for (const service of services) {
      service.stopping = true;
      if (!service.closed) service.child.kill('SIGKILL');
    }
    let timer;
    try {
      await Promise.race([
        Promise.all(services.map(service => service.completion)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new EgressBoundaryError('PROCESS_STOP_UNVERIFIED')), 2000);
        })
      ]);
    } finally { clearTimeout(timer); }
    insist(services.every(service => service.closed), 'PROCESS_STOP_UNVERIFIED');
    for (const service of services) this.services.delete(service);
    return services.length;
  }
}
