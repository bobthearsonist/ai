import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOfflineSdkProbes } from './index.mjs';

const report = await runOfflineSdkProbes();
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '.proof');
fs.mkdirSync(directory, { recursive: true });
const filename = path.join(directory, `${report.invocationId}.json`);
fs.writeFileSync(filename, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({
  evidenceFile: filename, invocationId: report.invocationId,
  sdk: report.provenance.package, version: report.provenance.version,
  evidenceSource: report.evidenceSource, liveAccepted: report.liveAccepted,
  contractMatrixComplete: report.contractMatrixComplete,
  runs: report.runs.map(run => ({
    client: run.client, executionId: run.executionId, callbackCount: run.callbackCount,
    sdkStatus: run.sdkResult.status, clientVersion: run.report.reports[0].clientVersion,
    pilotWritesVerified: run.report.reports[0].pilotWritesVerified
  }))
}, null, 2));
