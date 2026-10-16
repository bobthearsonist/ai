import fs from 'node:fs';
import { createPublicPolicy } from './policy.mjs';
import { startRelay } from './relay-core.mjs';

process.on('uncaughtException', () => { process.stderr.write('Egress relay infrastructure failure\n'); process.exit(70); });
process.on('unhandledRejection', () => { process.stderr.write('Egress relay infrastructure failure\n'); process.exit(70); });

let relay;
try {
  const config = JSON.parse(fs.readFileSync('/boundary/config.json', 'utf8'));
  relay = await startRelay({
    ...config, policy: createPublicPolicy(config.hosts), stateFile: '/scratch/relay-state.json'
  });
  const stop = () => { void relay.close().then(() => process.exit(0), () => process.exit(70)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  setTimeout(stop, Math.max(1, config.expiresAt - Date.now()));
} catch {
  process.stderr.write('Egress relay infrastructure failure\n');
  process.exitCode = 70;
}
