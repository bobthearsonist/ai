import fs from 'node:fs';
import { FIXTURE_HOSTS } from './fixture-identity.mjs';
import { addressKey, routingPolicy } from './policy.mjs';
import { insist } from './errors.mjs';
import { resolveComplete, startRelay } from './relay-core.mjs';

process.on('uncaughtException', () => { process.stderr.write('Fixture relay infrastructure failure\n'); process.exit(70); });
process.on('unhandledRejection', () => { process.stderr.write('Fixture relay infrastructure failure\n'); process.exit(70); });

try {
  const config = JSON.parse(fs.readFileSync('/boundary/config.json', 'utf8'));
  const expected = addressKey(config.fixtureAddress);
  const relay = await startRelay({
    ...config, policy: routingPolicy(FIXTURE_HOSTS, 'local-fixture-issuer-only'),
    stateFile: '/scratch/relay-state.json',
    resolve: (host, signal) => resolveComplete(host, signal, [`${config.fixtureAddress}:5353`]),
    authorizeAddress(address) {
      insist(addressKey(address) === expected, 'DNS_NONPUBLIC');
      return expected;
    }
  });
  const stop = () => { void relay.close().then(() => process.exit(0), () => process.exit(70)); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  setTimeout(stop, Math.max(1, config.expiresAt - Date.now()));
} catch {
  process.stderr.write('Fixture relay infrastructure failure\n');
  process.exitCode = 70;
}
