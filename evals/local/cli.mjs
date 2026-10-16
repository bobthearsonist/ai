#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getRunner } from './contract.mjs';
import { compileClaudePlugin, loadSuite } from './compile-claude.mjs';
import { createClaudeRunner } from './claude-plugin-eval.mjs';
import { registerStubs } from './stubs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    client: { type: 'string', default: 'claude' },
    suite: { type: 'string', default: 'git-commit-style' },
    runs: { type: 'string' },
    case: { type: 'string' },
    'approve-sessions': { type: 'string' },
    'max-cost-usd': { type: 'string', default: '5' },
    exe: { type: 'string' },
    'skill-root': { type: 'string' },
  },
});

const SKILL_ROOT = values['skill-root'] ?? process.env.EVAL_SKILL_ROOT ?? join(here, '..', '..', '..', 'ai-private', 'skills');
const command = positionals[0];
createClaudeRunner(values.exe ? { exe: values.exe } : {});
registerStubs();
const runner = getRunner(values.client);

if (command === 'preflight') {
  const r = await runner.preflight({});
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}

if (command !== 'smoke' && command !== 'run') {
  console.error('usage: cli.mjs <preflight|smoke|run> [--client claude] [--suite git-commit-style] [--approve-sessions N]');
  process.exit(64);
}

const cases = loadSuite(join(here, 'cases', values.suite));
const smoke = command === 'smoke';
const caseId = smoke ? (values.case ?? cases[0].id) : values.case;
const runs = smoke ? 1 : Number(values.runs ?? 3);
const ablation = smoke ? 'none' : 'with-without';
const planned = runner.plannedSessions({ caseCount: caseId ? 1 : cases.length, runs, ablation });
const approved = Number(values['approve-sessions'] ?? 0);

if (!runner.capabilities.implemented) {
  console.error(`${runner.id}: not implemented`);
  process.exit(3);
}
const pre = await runner.preflight({});
if (!pre.ok) {
  console.error(`preflight failed:\n- ${pre.problems.join('\n- ')}`);
  process.exit(1);
}
if (!(approved >= planned && planned > 0)) {
  console.error(`approval gate: this run starts ${planned} live session(s); pass --approve-sessions ${planned} to proceed`);
  process.exit(4);
}

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve(here, '..', '.work', 'local-runs', `${ts}-${command}`);
mkdirSync(outDir, { recursive: true });
const { pluginRoot, skillHash, canaryToken } = compileClaudePlugin({
  outDir, skillName: values.suite, skillSourceDir: join(SKILL_ROOT, values.suite), cases,
});
const result = await runner.run(cases, { pluginRoot, outputDir: join(outDir, 'eval-output'), runs, ablation, maxCostUsd: Number(values['max-cost-usd']), caseId });
const normalized = { ...result, skillSha256: skillHash, canaryToken, command, runs, ablation, plannedSessions: planned };
writeFileSync(join(outDir, 'normalized.json'), JSON.stringify(normalized, null, 2));
console.log(JSON.stringify(normalized, null, 2));
process.exit(['passed', 'below_threshold'].includes(result.status) ? 0 : 2);
