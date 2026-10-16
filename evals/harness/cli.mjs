#!/usr/bin/env node
import {
  ContractError, discoverSuites, evaluateResults, exportCandidate, loadSuite,
  planRuns, readJson, runEvaluation, validateDocument
} from './index.mjs';
import { probeClients } from './client-probes.mjs';

const HELP = `Deterministic local skill evaluation tooling (live execution is not accepted yet)
  validate --suite <suite.json> [--profile <profile.json>]
  validate --repo <source-repo>
  dry-run --suite <suite.json> --profile <profile.json> [--cases id,id] [--clients claude-code,opencode,copilot] [--arms candidate,baseline,no-skill]
  export --repo <source-repo> --tracked <relative-path> [--tracked <path>] [--untracked <file>] [--work-root <repo/evals/.work>]
  report --suite <suite.json> --results <results.json> [--previous <prior-results.json>]
  probe-clients [--clients claude-code,opencode,copilot] [--timeout-seconds 180]
  probe-runner [--clients claude-code,opencode,copilot] [--timeout-seconds 180]
  run-offline --suite <suite.json> --profile <offline-profile.json> --skill-path <relative-skill-directory> --candidate-export <export-directory> --baseline-export <export-directory> --mock-scenarios <scenarios.json> [--cases id,id] [--clients claude-code,opencode,copilot] [--arms candidate,baseline,no-skill]
  prepare-live --suite <suite.json> --profile <native-profile.json> --skill-path <relative-skill-directory> --candidate-export <export-directory> --baseline-export <export-directory> [--baseline <approval.json>] [--authorization <approval.json>] [--invocation-id <id>] [--cases id,id] [--clients claude-code,opencode,copilot] [--arms candidate,baseline,no-skill]
  run-live --suite <suite.json> --profile <native-profile.json> --skill-path <relative-skill-directory> --candidate-export <export-directory> --baseline-export <export-directory> [--baseline <approval.json>] [--authorization <approval.json>] [--invocation-id <id>] [--cases id,id] [--clients claude-code,opencode,copilot] [--arms candidate,baseline,no-skill] (persists admission failures; native dispatch remains blocked)
  prepare-auth [--clients claude-code,opencode,copilot]
  run (fails explicitly: real execution adapter is not installed)
All outputs are JSON on stdout. Invalid inputs and failed gates exit nonzero.`;

function parse(args) {
  const options = {};
  const allowed = new Set(['suite', 'profile', 'repo', 'cases', 'clients', 'arms', 'tracked', 'untracked', 'work-root', 'results', 'previous', 'timeout-seconds',
    'skill-path', 'candidate-export', 'baseline-export', 'mock-scenarios', 'baseline', 'authorization', 'invocation-id']);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, '');
    if (!args[index]?.startsWith('--') || !allowed.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new ContractError(`Invalid option: ${args[index]}`);
    }
    if (['tracked', 'untracked'].includes(key)) (options[key] ??= []).push(args[index + 1]);
    else {
      if (Object.hasOwn(options, key)) throw new ContractError(`Duplicate option: ${key}`);
      options[key] = args[index + 1];
    }
  }
  return options;
}

function required(options, key) {
  if (!options[key]) throw new ContractError(`--${key} is required`);
  return options[key];
}

function selection(options) {
  return Object.fromEntries(['cases', 'clients', 'arms'].filter(key => options[key] !== undefined).map(key => [key, options[key].split(',')]));
}

function timeoutSeconds(options) {
  if (options['timeout-seconds'] !== undefined && !/^[1-9]\d*$/.test(options['timeout-seconds'])) {
    throw new ContractError('--timeout-seconds must be a positive integer');
  }
  return options['timeout-seconds'] === undefined ? undefined : Number(options['timeout-seconds']);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') console.log(HELP);
  else {
    const options = parse(args);
    const commandOptions = {
      validate: ['suite', 'repo', 'profile', 'cases', 'clients', 'arms'],
      'dry-run': ['suite', 'profile', 'cases', 'clients', 'arms'],
      export: ['repo', 'tracked', 'untracked', 'work-root'],
      report: ['suite', 'results', 'previous'],
      'probe-clients': ['clients', 'timeout-seconds'],
      'probe-runner': ['clients', 'timeout-seconds'],
      'run-offline': ['suite', 'profile', 'skill-path', 'candidate-export', 'baseline-export', 'mock-scenarios', 'cases', 'clients', 'arms'],
      'prepare-live': ['suite', 'profile', 'skill-path', 'candidate-export', 'baseline-export', 'baseline', 'authorization', 'invocation-id', 'cases', 'clients', 'arms'],
      'run-live': ['suite', 'profile', 'skill-path', 'candidate-export', 'baseline-export', 'baseline', 'authorization', 'invocation-id', 'cases', 'clients', 'arms'],
      'prepare-auth': ['clients'],
      run: ['suite', 'profile', 'cases', 'clients', 'arms']
    };
    if (!commandOptions[command]) throw new ContractError(`Unknown command: ${command}`);
    for (const key of Object.keys(options)) {
      if (!commandOptions[command].includes(key)) throw new ContractError(`--${key} is not valid for ${command}`);
    }
    let output;
    if (command === 'validate') {
      const filenames = options.suite ? [options.suite] : discoverSuites(required(options, 'repo'));
      if (!filenames.length) throw new ContractError('No suites discovered; empty validation is not success');
      const suites = filenames.map(filename => {
        const loaded = loadSuite(filename);
        if (options.profile) planRuns(loaded, readJson(options.profile), selection(options));
        return { id: loaded.suite.id, filename, fixtureHash: loaded.fixtureHash, caseContracts: loaded.caseContracts };
      });
      if (new Set(suites.map(suite => suite.id)).size !== suites.length) throw new ContractError('Duplicate suite IDs');
      output = { valid: true, suites };
    } else if (command === 'dry-run') {
      output = { executed: false, ...planRuns(loadSuite(required(options, 'suite')), readJson(required(options, 'profile')), selection(options)) };
    } else if (command === 'export') {
      output = exportCandidate({
        repo: required(options, 'repo'), trackedPaths: required(options, 'tracked'),
        untrackedPaths: options.untracked, workRoot: options['work-root']
      });
    } else if (command === 'report') {
      const previous = options.previous ? validateDocument('results', readJson(options.previous)).runs.map(run => run.runId) : [];
      output = evaluateResults(loadSuite(required(options, 'suite')), readJson(required(options, 'results')), { previousRunIds: previous });
      process.exitCode = output.exitCode;
    } else if (command === 'probe-clients') {
      output = await probeClients({
        clients: options.clients?.split(','),
        timeoutSeconds: timeoutSeconds(options)
      });
    } else if (command === 'probe-runner') {
      const timeout = timeoutSeconds(options);
      const { runOfflineSdkProbes } = await import('./runner/index.mjs');
      output = await runOfflineSdkProbes({
        clients: options.clients?.split(','), timeoutSeconds: timeout
      });
    } else if (command === 'prepare-auth') {
      const { prepareNativeAuthProfiles } = await import('./native-auth-profiles.mjs');
      output = prepareNativeAuthProfiles({ clients: options.clients?.split(',') }).report;
    } else if (command === 'run-offline') {
      const { executeOfflineCaseMatrix, persistOfflineCaseMatrix } = await import('./task-execution.mjs');
      const matrix = await executeOfflineCaseMatrix({
        suiteFile: required(options, 'suite'), profile: readJson(required(options, 'profile')),
        skillPath: required(options, 'skill-path'),
        candidateExport: required(options, 'candidate-export'), baselineExport: required(options, 'baseline-export'),
        mockScenarios: readJson(required(options, 'mock-scenarios')), selection: selection(options)
      });
      const persisted = persistOfflineCaseMatrix(matrix);
      output = { ...persisted.manifest, evidence: { directory: persisted.workspace.directory, reportFile: persisted.reportFile } };
      process.exitCode = matrix.report.exitCode;
    } else if (command === 'prepare-live' || command === 'run-live') {
      const { authorizeLiveEvaluation, prepareLiveEvaluation, releaseLiveEvaluation } = await import('./live-execution.mjs');
      const prepared = prepareLiveEvaluation({
        suiteFile: required(options, 'suite'), profile: readJson(required(options, 'profile')),
        skillPath: required(options, 'skill-path'),
        candidateExport: required(options, 'candidate-export'), baselineExport: required(options, 'baseline-export'),
        selection: selection(options),
        ...(options.baseline === undefined ? {} : { baseline: readJson(options.baseline) }),
        ...(options['invocation-id'] === undefined ? {} : { invocationId: options['invocation-id'] })
      });
      try {
        if (options.authorization !== undefined) {
          authorizeLiveEvaluation(prepared.handle, readJson(options.authorization));
        }
        if (command === 'prepare-live') {
          const { describeLiveEvaluation } = await import('./live-execution.mjs');
          output = describeLiveEvaluation(prepared.handle);
        } else {
          const { executeLiveCaseMatrix, persistLiveCaseMatrix } = await import('./live-case-execution.mjs');
          const matrix = await executeLiveCaseMatrix(prepared.handle);
          const persisted = persistLiveCaseMatrix(matrix);
          output = { ...persisted.manifest, evidence: { directory: persisted.workspace.directory, reportFile: persisted.reportFile } };
          process.exitCode = persisted.manifest.exitCode;
        }
      } finally {
        releaseLiveEvaluation(prepared.handle);
      }
    } else if (command === 'run') {
      output = Object.keys(options).length === 0 ? runEvaluation() : runEvaluation(
        loadSuite(required(options, 'suite')), readJson(required(options, 'profile')), selection(options)
      );
    }
    else throw new ContractError(`Unknown command: ${command}`);
    console.log(JSON.stringify(output, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ passed: false, failures: [{ class: error.failureClass ?? 'infrastructure', message: error.message }] }));
  process.exitCode = 1;
}
