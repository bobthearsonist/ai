#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

if (!process.argv.some((arg) => arg === '--config' || arg.startsWith('--config='))) {
  process.argv.push('--config', fileURLToPath(new URL('../evals.json', import.meta.url)));
}
await import('@bobthearsonist/ai-evals/run-all');
