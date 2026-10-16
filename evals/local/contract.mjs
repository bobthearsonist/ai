// Client-neutral contract for local native eval runners.
// Adapters declare capabilities honestly; results are always labelled non-hermetic.

export const RESULT_LABEL = 'native-authenticated-non-hermetic';

export const CLIENT_STATUS = Object.freeze({
  PASSED: 'passed',
  BELOW_THRESHOLD: 'below_threshold',
  PARTIAL: 'partial',
  AUTH_FAILED: 'auth_failed',
  ERROR: 'error',
  NOT_IMPLEMENTED: 'not_implemented',
});

export function makeRunResult(partial = {}) {
  return {
    client: 'unknown',
    label: RESULT_LABEL,
    status: CLIENT_STATUS.ERROR,
    clientVersion: null,
    sessions: 0,
    overallScore: null,
    costUsd: null,
    cases: [],
    canaryTouched: false,
    caveats: [],
    outputDir: null,
    ...partial,
  };
}

const registry = new Map();

// A runner provides: id, capabilities {hermetic,skillTrace,usageObservable,hardLimits,implemented},
// preflight(ctx), plannedSessions(suite, opts), run(suite, opts) -> RunResult.
export function registerRunner(runner) {
  if (!runner?.id || typeof runner.run !== 'function' || typeof runner.preflight !== 'function') {
    throw new TypeError('runner must define id, preflight() and run()');
  }
  if (!runner.capabilities || runner.capabilities.hermetic !== false) {
    throw new TypeError(`runner ${runner.id} must declare capabilities.hermetic === false`);
  }
  registry.set(runner.id, runner);
  return runner;
}

export function getRunner(id) {
  const runner = registry.get(id);
  if (!runner) throw new Error(`unknown client "${id}"; registered: ${[...registry.keys()].join(', ')}`);
  return runner;
}

export function listRunners() {
  return [...registry.values()];
}

// Neutral suite case shared by every adapter.
export function validateCase(c) {
  const problems = [];
  if (!c || typeof c !== 'object') return ['case must be an object'];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id ?? '')) problems.push('id must be kebab-case');
  if (typeof c.prompt !== 'string' || !c.prompt.trim()) problems.push('prompt required');
  if (typeof c.shouldTrigger !== 'boolean') problems.push('shouldTrigger must be boolean');
  if (!Array.isArray(c.checks) || c.checks.length === 0) problems.push('checks must be a non-empty array');
  for (const k of c.checks ?? []) {
    if (!['regex', 'not_regex', 'file_exists', 'tool_order'].includes(k.type)) problems.push(`unsupported check type ${k.type}`);
    if (['regex', 'not_regex'].includes(k.type) && typeof k.pattern !== 'string') problems.push('check needs pattern');
    if (k.type === 'file_exists' && typeof k.path !== 'string') problems.push('file_exists needs path');
    if (k.type === 'tool_order' && (typeof k.before !== 'string' || typeof k.after !== 'string')) problems.push('tool_order needs before and after');
  }
  return problems;
}
