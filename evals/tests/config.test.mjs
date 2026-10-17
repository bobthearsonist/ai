import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveConfig, suiteSettings } from '../local/config.mjs';
import { validateCase } from '../local/contract.mjs';

const engineRoot = resolve(import.meta.dirname, '..');

test('defaults keep the in-repo layout', () => {
  const c = resolveConfig({ engineRoot });
  assert.equal(c.casesDir, join(engineRoot, 'local', 'cases'));
  assert.equal(c.outputDir, join(engineRoot, '.work', 'local-runs'));
  assert.equal(c.resultsDir, join(engineRoot, '.work', 'results'));
  assert.equal(c.skillsRoots[0], resolve(engineRoot, '..', 'skills'));
});

test('config paths resolve relative to the config file and flags override them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  mkdirSync(join(dir, 'evals'));
  const p = join(dir, 'evals', 'evals.json');
  writeFileSync(p, JSON.stringify({ casesDir: 'cases', skillsRoots: ['../skills'], suites: { a: { skill: 'real-skill', cases: 'a-cases' } } }));
  const c = resolveConfig({ configPath: p, engineRoot });
  assert.equal(c.casesDir, join(dir, 'evals', 'cases'));
  assert.deepEqual(c.skillsRoots, [join(dir, 'skills')]);
  assert.equal(c.outputDir, join(dir, 'evals', '.work', 'local-runs'));
  assert.deepEqual(suiteSettings(c, 'a'), { skill: 'real-skill', casesFolder: 'a-cases' });
  assert.deepEqual(suiteSettings(c, 'b'), { skill: 'b', casesFolder: 'b' });
  const o = resolveConfig({ configPath: p, engineRoot, flags: { outputDir: join(dir, 'out') } });
  assert.equal(o.outputDir, join(dir, 'out'));
  assert.throws(() => resolveConfig({ configPath: join(dir, 'missing.json'), engineRoot }));
});

test('schemaVersion is optional but must be supported', () => {
  const ok = { id: 'x', prompt: 'p', shouldTrigger: false, checks: [{ type: 'regex', pattern: 'a' }] };
  assert.deepEqual(validateCase(ok), []);
  assert.deepEqual(validateCase({ ...ok, schemaVersion: 1 }), []);
  assert.ok(validateCase({ ...ok, schemaVersion: 2 }).length > 0);
});
