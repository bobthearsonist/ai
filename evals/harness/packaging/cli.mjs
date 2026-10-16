import { checkPackaging, validatePackaging } from './index.mjs';

function parseArguments(argv) {
  const [command, ...args] = argv;
  if (!['check', 'validate'].includes(command)) throw new Error('Use check --repo <repo> [--untracked <file>] [--runtime docker|bash] [--image <image>] or validate --source <export> --generated <output>');
  const options = { untrackedPaths: [] };
  const names = { repo: 'repo', source: 'sourceDirectory', generated: 'generatedDirectory', runtime: 'runtime', image: 'image', bash: 'bash' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const value = args[i + 1];
    if (!args[i]?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Missing option value: ${args[i]}`);
    if (key === 'untracked') options.untrackedPaths.push(value);
    else if (names[key] && options[names[key]] === undefined) options[names[key]] = value;
    else throw new Error(`Unknown/duplicate option: ${args[i]}`);
  }
  const allowed = command === 'check' ? ['repo', 'runtime', 'image', 'bash', 'untrackedPaths'] : ['sourceDirectory', 'generatedDirectory', 'untrackedPaths'];
  if (Object.keys(options).some(key => !allowed.includes(key)) || (command === 'validate' && options.untrackedPaths.length)) throw new Error('Option not applicable to command');
  if (!(command === 'check' ? options.repo : options.sourceDirectory && options.generatedDirectory)) throw new Error('Missing required source/repo/output path');
  return { command, options };
}

try {
  const { command, options } = parseArguments(process.argv.slice(2));
  const report = command === 'check' ? checkPackaging(options) : validatePackaging(options);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
} catch (error) {
  console.error(JSON.stringify({ packagingVersion: 1, passed: false, exitCode: 1, failures: [error.message] }));
  process.exitCode = 1;
}
