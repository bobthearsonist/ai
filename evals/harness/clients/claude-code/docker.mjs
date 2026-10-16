import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TASK_CAPS } from './task-policy.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));

export function runOwnedDocker(args, { config, timeoutMs = 15000, input, signal } = {}) {
  return new Promise(resolve => {
    const host = process.platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock';
    const child = spawn('docker', ['--config', config, '--host', host, ...args], {
      cwd: directory, stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
    });
    let stdout = '', stderr = '', bytes = 0, timedOut = false, outputLimited = false, cancelled = false, settled = false;
    const kill = () => child.kill('SIGKILL');
    const cancel = () => { cancelled = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const collect = stream => chunk => {
      bytes += chunk.length;
      if (bytes > TASK_CAPS.dockerOutputBytes) { outputLimited = true; kill(); return; }
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve({ ...result, stdout, stderr, timedOut, outputLimited, cancelled });
    };
    child.on('error', error => finish({ code: null, error: error.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') finish({ code: null, error: error.message }); });
    child.stdin.end(input);
  });
}
