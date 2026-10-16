import { spawnSync } from 'node:child_process';
const bin = '/opt/fixture/node_modules/.bin/copilot';
for (const args of [['--version'], ['--help'], ['help', 'providers'], ['help', 'permissions']]) {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 20000, env: { ...process.env, XDG_CACHE_HOME: '/opt/copilot-cache/.cache' } });
  console.log(JSON.stringify({ args, status: r.status, stdout: r.stdout, stderr: r.stderr }));
}
