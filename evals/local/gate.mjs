#!/usr/bin/env node
// Merge gate for the agents-md suite. Reads the newest run archive, prints a
// per-case table (also to the GitHub job summary when available) and exits 1
// when shouldBlock says the candidate AGENTS.md is worse than its baseline.
// In a baseline run the "with" arm is the candidate and "without" the baseline.
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runsDir = fileURLToPath(new URL('../.work/local-runs', import.meta.url));

// Decides whether a run blocks the merge. `regression` is the engine's strict
// verdict: every candidate run scored below every baseline run, so it is rarely
// caused by noise at 3 runs per arm. Invalid runs block because a case that
// could not be measured cannot vouch for the change.
export function shouldBlock(cases) {
  const reasons = [];
  if (!cases.length) reasons.push('no cases were measured');
  for (const c of cases) {
    if (c.invalidRuns) reasons.push(`${c.id}: ${c.invalidRuns} invalid run(s)`);
    if (c.verdict === 'regression') reasons.push(`${c.id}: regression (${fmt(c.withScore)} vs ${fmt(c.withoutScore)})`);
    if (c.verdict === 'unmeasured') reasons.push(`${c.id}: unmeasured`);
  }
  return reasons;
}

const fmt = (score) => (typeof score === 'number' ? score.toFixed(2) : '-');

function latestRun() {
  if (!existsSync(runsDir)) throw new Error(`no run archives in ${runsDir}`);
  const runs = readdirSync(runsDir).filter((name) => /-agents-md-.*-run$/.test(name)).sort();
  if (!runs.length) throw new Error('no agents-md run archive found');
  return join(runsDir, runs.at(-1));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = process.argv[2] ?? latestRun();
  const normalized = JSON.parse(readFileSync(join(run, 'normalized.json'), 'utf8'));
  const cases = normalized.cases ?? [];
  const label = normalized.baselineInstructionSha256 ? 'baseline' : 'no AGENTS.md';
  const lines = [
    `### AGENTS.md evals (${normalized.sessions ?? 0} sessions, candidate vs ${label})`,
    '',
    '| Case | Candidate | Baseline | Verdict |',
    '|---|---|---|---|',
    ...cases.map((c) => `| ${c.id} | ${fmt(c.withScore)} | ${fmt(c.withoutScore)} | ${c.verdict}${c.invalidRuns ? ` (${c.invalidRuns} invalid)` : ''} |`),
  ];
  const reasons = shouldBlock(cases);
  lines.push('', reasons.length ? `**Blocked:** ${reasons.join('; ')}` : '**Passed:** no case got worse.');
  const text = lines.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  process.exit(reasons.length ? 1 : 0);
}
