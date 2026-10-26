#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

const hasOption = (name) => process.argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
if (!hasOption('--config')) {
  process.argv.push('--config', fileURLToPath(new URL('../evals.json', import.meta.url)));
}
if (!['run-all', 'calibrate'].includes(process.argv[2]) && !hasOption('--suite')) {
  process.argv.push('--suite', 'git-commit-style');
}
await import('@bobthearsonist/ai-evals/cli');
