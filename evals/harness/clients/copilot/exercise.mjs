import fs from 'node:fs';
import { buildOfflineImage, runOfflineContainer, cleanupOfflineImage, normalizeCopilotOutcome, assessDenials, assessArtifacts, runOfflineProbe } from './index.mjs';
if (process.argv[2] === 'accepted') {
  const report = await runOfflineProbe({ timeoutMs: 300000, artifactTargets: ['answer.md', 'message.txt'] });
  fs.writeFileSync(new URL('./evidence.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log({ client: report.client, version: report.clientVersion, image: report.image,
    pilotWritesVerified: report.pilotWritesVerified, positive: report.positive.trigger,
    denials: report.artifactProfile.denial.evidence.length, cleanup: report.cleanup });
  process.exit(0);
}
const owned = await buildOfflineImage();
try {
  if (process.argv[2] === 'record') {
    const fixtures = {};
    for (const mode of ['candidate', 'control', 'attacks', 'candidate-write', 'control-write', 'attacks-write', 'auth-error', 'tool-error']) {
      const output = await runOfflineContainer(owned, { mode, seconds: 120,
        artifactTargets: mode.endsWith('-write') ? ['answer.md', 'message.txt'] : [] });
      const record = JSON.parse(output.stdout);
      fixtures[mode] = { ...record, image: output.image };
      fs.writeFileSync(new URL('./fixtures.json', import.meta.url), JSON.stringify(fixtures, null, 2) + '\n');
      const normalized = normalizeCopilotOutcome(fixtures[mode]);
      console.log({ mode, status: normalized.completion.status, trigger: normalized.trigger.loaded,
        denials: mode.startsWith('attacks') ? assessDenials(record, normalized).accepted : undefined,
        artifacts: mode.endsWith('-write') && !mode.startsWith('attacks') ? assessArtifacts(record, normalized).accepted : undefined });
    }
    fs.writeFileSync(new URL('./fixtures.json', import.meta.url), JSON.stringify(fixtures, null, 2) + '\n');
  } else {
  const mode = process.argv[2] ?? 'probe';
  const output = await runOfflineContainer(owned, { mode, seconds: 120, artifactTargets: mode.endsWith('-write') ? ['answer.md', 'message.txt'] : [] });
  fs.writeFileSync(new URL('./observed.json', import.meta.url), JSON.stringify(output, null, 2));
  if ((process.argv[2] ?? 'probe') === 'probe') {
    const rows = output.stdout.trim().split('\n').map(JSON.parse);
    console.log(rows.map(row => ({ args: row.args, status: row.status, version: row.args[0] === '--version' ? row.stdout : undefined })));
  } else {
    const row = JSON.parse(output.stdout);
    console.log({ mode: row.mode, exitCode: row.exitCode, calls: row.provider.calls,
      results: row.provider.toolResults, leakDetected: row.leakDetected, agentWroteFile: row.agentWroteFile });
  }
  }
} finally { await cleanupOfflineImage(owned); }
