import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLIENT_STATUS, makeRunResult, registerRunner } from './contract.mjs';

const MIN_VERSION = [2, 1, 269];

export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return m ? m.slice(1, 4).map(Number) : null;
}

export function versionAtLeast(v, min = MIN_VERSION) {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

export function plannedSessions({ caseCount, runs, ablation }) {
  return caseCount * runs * (ablation === 'with-without' ? 2 : 1);
}

export function buildArgs({ pluginRoot, outputDir, runs, ablation, maxCostUsd, caseId, concurrency = 1 }) {
  const args = ['plugin', 'eval', pluginRoot, '--runs', String(runs), '-j', String(concurrency), '--ablation', ablation,
    '--max-cost-usd', String(maxCostUsd), '--no-publish', '--keep-temp', '--trust-plugin',
    '--output-dir', outputDir, '--json', join(outputDir, 'stdout.json')];
  if (caseId) args.push('--case', caseId);
  return args;
}

export function normalizeAggregate(agg) {
  const cases = (agg.cases ?? []).map((c) => {
    const a = c.aggregates ?? {};
    const mean = (runs) => (runs?.length ? runs.reduce((s, r) => s + (r.score ?? 0), 0) / runs.length : null);
    const sum = (...arms) => {
      const costs = arms.flatMap((r) => r ?? []).map((r) => r.costUsd).filter((x) => typeof x === 'number');
      return costs.length ? costs.reduce((s, x) => s + x, 0) : null;
    };
    const withScore = mean(c.arms?.with) ?? a.score ?? null;
    const withoutScore = mean(c.arms?.without) ?? a.baselineScore ?? a.withoutScore ?? null;
    return {
      id: c.id ?? c.name ?? c.case ?? 'unknown',
      withScore,
      withoutScore,
      delta: a.delta ?? (withScore != null && withoutScore != null ? withScore - withoutScore : null),
      partial: Boolean(c.partial),
      partialReason: c.partialReason ?? null,
      costUsd: sum(c.arms?.with, c.arms?.without),
    };
  });
  return { cases, overallScore: agg.aggregates?.overallScore ?? null, costUsd: agg.costUsd ?? null, claudeVersion: agg.claudeVersion ?? null, partial: Boolean(agg.partial) };
}

export function createClaudeRunner({ exe = 'claude' } = {}) {
  const run = (args) => spawnSync(exe, args, { encoding: 'utf8', shell: false, windowsHide: true });
  return registerRunner({
    id: 'claude',
    capabilities: { hermetic: false, skillTrace: true, usageObservable: true, hardLimits: false, implemented: true },
    async preflight() {
      const problems = [];
      const v = run(['--version']);
      if (v.error || v.status !== 0) return { ok: false, problems: [`claude not runnable: ${v.error?.message ?? v.stderr}`] };
      const ver = parseVersion(v.stdout);
      if (!ver || !versionAtLeast(ver)) problems.push(`claude ${v.stdout.trim()} < ${MIN_VERSION.join('.')}`);
      for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
        if (process.env[k]) problems.push(`${k} is set; run would bill API instead of subscription`);
      }
      return { ok: problems.length === 0, version: v.stdout.trim(), problems };
    },
    plannedSessions,
    async run(suite, { pluginRoot, outputDir, runs, ablation, maxCostUsd = 5, caseId, concurrency = 1 }) {
      const proc = run(buildArgs({ pluginRoot, outputDir, runs, ablation, maxCostUsd, caseId, concurrency }));
      const base = { client: 'claude', outputDir, caveats: ['subscription login used; not hermetic', 'cost is a list-price estimate'] };
      if (proc.error) return makeRunResult({ ...base, status: CLIENT_STATUS.ERROR, caveats: [...base.caveats, proc.error.message] });
      const aggPath = findAggregate(outputDir);
      if (!aggPath) {
        const auth = proc.status === 2 || /auth/i.test(`${proc.stderr}${proc.stdout}`);
        return makeRunResult({ ...base, status: auth ? CLIENT_STATUS.AUTH_FAILED : CLIENT_STATUS.ERROR, caveats: [...base.caveats, `no aggregate-result.json; exit ${proc.status}; ${String(proc.stderr).slice(0, 500)}`] });
      }
      const n = normalizeAggregate(JSON.parse(readFileSync(aggPath, 'utf8')));
      const status = proc.status === 0 ? CLIENT_STATUS.PASSED : proc.status === 2 ? CLIENT_STATUS.PARTIAL : CLIENT_STATUS.BELOW_THRESHOLD;
      return makeRunResult({
        ...base, status, clientVersion: n.claudeVersion, overallScore: n.overallScore, costUsd: n.costUsd,
        cases: n.cases, sessions: plannedSessions({ caseCount: caseId ? 1 : suite.length, runs, ablation }),
      });
    },
  });
}

function findAggregate(dir) {
  if (!existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === 'aggregate-result.json') return p;
    }
  }
  return null;
}
