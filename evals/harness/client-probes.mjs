import { randomUUID } from 'node:crypto';
import { CLIENTS, ContractError } from './index.mjs';

const VERSIONS = Object.freeze({
  'claude-code': '2.1.291', opencode: '1.14.28', copilot: '1.0.92'
});
const LOADERS = {
  'claude-code': () => import('./clients/claude-code/index.mjs'),
  opencode: () => import('./clients/opencode/index.mjs'),
  copilot: () => import('./clients/copilot/index.mjs')
};

export async function probeClients({ clients = CLIENTS, timeoutSeconds = 180 } = {}, {
  loadClient = client => LOADERS[client]()
} = {}) {
  if (!Array.isArray(clients) || clients.length === 0 ||
      new Set(clients).size !== clients.length || !clients.every(client => CLIENTS.includes(client))) {
    throw new ContractError('Offline probes require a nonempty unique supported client selection');
  }
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new ContractError('Offline probe timeout must be an integer from 1 through 3600 seconds');
  }
  if (typeof loadClient !== 'function') throw new ContractError('Offline probe module loader required');
  const reports = [];
  for (const client of [...clients]) {
    try {
      const adapter = await loadClient(client);
      if (typeof adapter?.runOfflineProbe !== 'function') {
        throw new ContractError('Actual offline probe adapter is not implemented');
      }
      const report = await adapter.runOfflineProbe({
        timeoutMs: timeoutSeconds * 1000, artifactTargets: ['answer.md', 'message.txt']
      });
      if (!report || typeof report !== 'object' || Array.isArray(report) ||
          report.client !== client || report.clientVersion !== VERSIONS[client] ||
          report.pilotWritesVerified !== true ||
          report.liveAccepted === true || report.qualityEvaluated === true ||
          report.modelQualityEvidence === true || report.offlineEvidenceOnly === false ||
          report.accepted === false || report.passed === false || report.error ||
          (report.transport !== undefined &&
            !['offline-mock', 'offline-mock/not-live'].includes(report.transport)) ||
          ['error', 'timeout', 'cancelled', 'skipped', 'aborted', 'partial', 'failed', 'unsupported'].includes(report.status)) {
        throw new ContractError('Offline adapter returned incompatible or live-shaped evidence');
      }
      reports.push(JSON.parse(JSON.stringify(report)));
    } catch (error) {
      throw new ContractError(`${client} offline probe failed: ${error.message}`, error.failureClass ?? 'infrastructure');
    }
  }
  return {
    invocationId: randomUUID(), createdAt: new Date().toISOString(),
    transport: 'offline-mock', offlineEvidenceOnly: true, liveAccepted: false,
    qualityEvaluated: false, baselineApproved: false, clients: [...clients], reports
  };
}
