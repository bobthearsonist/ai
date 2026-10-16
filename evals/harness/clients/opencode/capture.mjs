import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runOfflineProbe, TRANSPORT } from './index.mjs';

if (process.env.EVAL_CLIENT_OPENCODE_DOCKER !== '1') throw new Error('Set EVAL_CLIENT_OPENCODE_DOCKER=1 for the owned Docker probe');
const result = runOfflineProbe();
const directory = fileURLToPath(new URL('fixtures/', import.meta.url));
fs.mkdirSync(directory, { recursive: true });
for (const [scenario, execution] of Object.entries(result.scenarios)) {
  if (!['positive', 'negative', 'attacks'].includes(scenario)) throw new Error('Unknown captured scenario');
  if (/synthetic-opencode-canary|OUT_OF_SCOPE_SENTINEL/.test(execution.stdout)) throw new Error('Sensitive fixture disclosure');
  fs.writeFileSync(new URL(`fixtures/${scenario}.jsonl`, import.meta.url), execution.stdout);
}
fs.writeFileSync(new URL('fixtures/probe-input.json', import.meta.url), JSON.stringify({
  requests: result.requests, network: result.network, writeAbsent: result.denials.writeAbsent,
  artifactTargets: result.artifactTargets, artifacts: result.artifacts, protectedFiles: result.denials.protectedFiles
}, null, 2) + '\n');
const evidence = {
  transport: TRANSPORT, capturedAt: new Date().toISOString(), client: result.client,
  clientVersion: result.clientVersion, image: result.image, manifestDigest: result.manifestDigest,
  baseImage: result.baseImage, dockerEngine: result.dockerEngine, versions: result.versions,
  owner: result.owner, cleanup: result.cleanup, accepted: result.accepted, liveAccepted: false,
  modelQualityEvidence: false, trigger: result.trigger, usage: result.usage, completion: result.completion,
  negative: result.negative.trigger, denials: result.denials.evidence.map(e => ({ tool: e.tool, input: e.input, outcome: e.outcome })),
  artifactTargets: result.artifactTargets, artifacts: result.artifacts, artifactWritesVerified: result.artifactWritesVerified,
  pilotWritesVerified: result.pilotWritesVerified,
  protectedFiles: result.denials.protectedFiles,
  network: result.network, cliHelp: result.cliHelp, skillPath: result.skillPath,
  freshWorkspacePerScenario: result.freshWorkspacePerScenario, freshHomePerScenario: result.freshHomePerScenario,
  authentication: result.authentication, liveBlockers: result.liveBlockers,
  sanitization: 'No HTTP headers/auth config stored; event and tool-result fields are actual CLI output from synthetic files only.'
};
fs.writeFileSync(new URL('evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ accepted: evidence.accepted, pilotWritesVerified: evidence.pilotWritesVerified,
  artifactTargets: evidence.artifactTargets, image: evidence.image, versions: evidence.versions,
  trigger: evidence.trigger, negative: evidence.negative, denials: evidence.denials, network: evidence.network,
  cleanup: evidence.cleanup, transport: TRANSPORT }));
