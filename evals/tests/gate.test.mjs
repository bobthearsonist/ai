import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlock } from '../local/gate.mjs';

const ok = (id, verdict = 'same') => ({ id, verdict, withScore: 1, withoutScore: 1, invalidRuns: 0 });

test('gate passes when no case got worse', () => {
  assert.deepEqual(shouldBlock([ok('a'), ok('b', 'lift'), ok('c', 'inconclusive')]), []);
});

test('gate blocks regressions, invalid runs, unmeasured cases and empty runs', () => {
  assert.deepEqual(shouldBlock([]), ['no cases were measured']);
  const reasons = shouldBlock([
    { id: 'worse', verdict: 'regression', withScore: 0.5, withoutScore: 1, invalidRuns: 0 },
    { id: 'broken', verdict: 'unmeasured', withScore: null, withoutScore: null, invalidRuns: 2 },
  ]);
  assert.deepEqual(reasons, ['worse: regression (0.50 vs 1.00)', 'broken: 2 invalid run(s)', 'broken: unmeasured']);
});
