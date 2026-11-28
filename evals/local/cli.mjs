#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

const hasOption = (name) => process.argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
if (!hasOption('--config')) {
  process.argv.push('--config', fileURLToPath(new URL('../evals.json', import.meta.url)));
}
if (!['run-all', 'judge'].includes(process.argv[2]) && !hasOption('--suite')) {
  process.argv.push('--suite', 'ai-repo-management');
}
await import('@bobthearsonist/ai-evals/cli');
