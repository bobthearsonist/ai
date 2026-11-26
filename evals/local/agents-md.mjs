#!/usr/bin/env node
// Runs the agents-md instructions suite against the working-tree AGENTS.md.
// Without --baseline the without arm has no instruction file ("does the file
// help at all"); --baseline REF stages AGENTS.md as of a git ref instead
// ("does this edit help"). All other arguments pass through to the engine.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalsDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = join(evalsDir, '..');
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'run';

const at = args.findIndex((arg) => arg === '--baseline' || arg.startsWith('--baseline='));
if (at !== -1) {
  const [flag] = args.splice(at, 1);
  const ref = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : args.splice(at, 1)[0];
  if (!ref || ref.startsWith('-')) throw new Error('--baseline requires a git ref, e.g. --baseline HEAD');
  const sha = execFileSync('git', ['-C', repoDir, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  const content = execFileSync('git', ['-C', repoDir, 'show', `${sha}:AGENTS.md`]);
  // Named by commit so archived runs keep pointing at what they compared against.
  const file = join(evalsDir, '.work', 'baseline', `AGENTS-${sha.slice(0, 12)}.md`);
  mkdirSync(join(evalsDir, '.work', 'baseline'), { recursive: true });
  writeFileSync(file, content);
  args.push('--baseline-instruction-file', file);
}

process.argv = [process.argv[0], process.argv[1], command, '--suite', 'agents-md', '--config', join(evalsDir, 'evals.json'), ...args];
await import('@bobthearsonist/ai-evals/cli');
