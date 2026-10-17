// Runs every suite in parallel (separate processes) with per-suite concurrency.
// usage: node local/run-all.mjs [--concurrency 4] [--runs 3] [--approve-sessions N]
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadLatest, renderMarkdown } from './summary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: { concurrency: { type: 'string', default: '4' }, runs: { type: 'string', default: '3' }, 'approve-sessions': { type: 'string' }, suites: { type: 'string' } },
});
const casesRoot = join(here, 'cases');
const only = values.suites?.split(',');
const suites = readdirSync(casesRoot).filter((s) => (!only || only.includes(s)) && existsSync(join(casesRoot, s)) && readdirSync(join(casesRoot, s)).some((f) => f.endsWith('.json')));
const runs = Number(values.runs);
const perSuite = (s) => readdirSync(join(casesRoot, s)).filter((f) => f.endsWith('.json')).length * runs * 2;
const total = suites.reduce((n, s) => n + perSuite(s), 0);
if (Number(values['approve-sessions']) !== total) {
  console.log(`approval gate: this starts ${total} live session(s) across ${suites.length} suites; pass --approve-sessions ${total} to proceed`);
  process.exit(1);
}

const results = await Promise.all(suites.map((s) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(here, 'cli.mjs'), 'run', '--suite', s, '--runs', String(runs), '--concurrency', values.concurrency, '--approve-sessions', String(perSuite(s))], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', () => {
    try { resolve({ suite: s, diffs: err.split(/\r?\n/).filter((l) => l.startsWith('diff ')), ...JSON.parse(out.slice(out.indexOf('{'))) }); } catch { resolve({ suite: s, status: 'error', out: out.slice(-300) }); }
  });
})));
let cost = 0;
for (const r of results) {
  cost += r.costUsd ?? 0;
  console.log(`${r.suite}: ${r.status} score=${r.overallScore?.toFixed?.(2)} cost=$${r.costUsd?.toFixed?.(2)}`);
  for (const c of r.cases ?? []) console.log(`  ${c.id}: with=${c.withScore?.toFixed(2)} without=${c.withoutScore?.toFixed(2)} delta=${c.delta?.toFixed(2)} [${c.verdict}]${c.invalidRuns ? ` (${c.invalidRuns} invalid run(s) excluded)` : ''}`);
}
for (const r of results) for (const d of r.diffs ?? []) console.log(`vs previous ${r.suite} ${d.slice(5)}`);
const resultsDir = join(here, '..', '.work', 'results');
mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, 'summary.md'), renderMarkdown(suites.map((s) => loadLatest(resultsDir, s)).filter(Boolean)));
console.log(`total cost ~$${cost.toFixed(2)}`);
