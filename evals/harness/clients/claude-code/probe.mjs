import { runClaudeOfflineProbe } from './index.mjs';

if (process.argv.slice(2).some(argument => argument !== '--capture')) throw new Error('Only --capture is supported');
const report = await runClaudeOfflineProbe({ capture: process.argv.includes('--capture') });
console.log(JSON.stringify({
  client: report.client, clientVersion: report.clientVersion, transport: report.transport,
  live: report.live, realQuality: report.realQuality, accepted: report.accepted,
  pilotWritesVerified: report.pilotWritesVerified,
  imageSpec: report.imageSpec, candidate: {
    trigger: report.candidate.trigger, completion: report.candidate.completion,
    denialPassed: report.candidate.denialPassed, safetyPassed: report.candidate.safetyPassed,
    companionRead: report.candidate.companionRead, usage: report.candidate.usage,
    artifactsPassed: report.candidate.artifactsPassed, artifacts: report.candidate.artifacts
  }, control: { trigger: report.control.trigger, completion: report.control.completion,
    denialPassed: report.control.denialPassed, accepted: report.control.accepted },
  cleanup: report.cleanup, liveBlockers: report.liveBlockers
}, null, 2));
if (!report.accepted) process.exitCode = 1;
