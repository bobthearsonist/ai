import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

// Resolves where cases, skills and outputs live. Precedence: CLI flag > config file > engine defaults.
// Config paths are relative to the config file so a repo's evals/ folder is self-contained.
export function resolveConfig({ configPath, flags = {}, engineRoot }) {
  let cfg = {};
  let base = engineRoot;
  if (configPath) {
    const p = resolve(configPath);
    if (!existsSync(p)) throw new Error(`config not found: ${p}`);
    cfg = JSON.parse(readFileSync(p, 'utf8'));
    base = dirname(p);
  }
  const abs = (v, from = base) => (isAbsolute(v) ? v : resolve(from, v));
  const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(';')).filter(Boolean);
  const skillsRoots = list(flags.skillRoot ?? (cfg.skillsRoots ? undefined : process.env.EVAL_SKILL_ROOT) ?? cfg.skillsRoots).map((r) => abs(r, flags.skillRoot ? process.cwd() : base));
  return {
    casesDir: flags.casesDir ? abs(flags.casesDir, process.cwd()) : configPath ? abs(cfg.casesDir ?? 'cases') : resolve(engineRoot, 'local', 'cases'),
    skillsRoots: skillsRoots.length ? skillsRoots : [resolve(engineRoot, '..', 'skills'), resolve(engineRoot, '..', '..', 'ai-private', 'skills')],
    outputDir: flags.outputDir ? abs(flags.outputDir, process.cwd()) : abs(cfg.outputDir ?? '.work/local-runs', configPath ? base : engineRoot),
    resultsDir: flags.resultsDir ? abs(flags.resultsDir, process.cwd()) : abs(cfg.resultsDir ?? '.work/results', configPath ? base : engineRoot),
    suites: cfg.suites ?? {},
  };
}

// A suite id may map to a differently named skill and cases folder; default is identity.
export function suiteSettings(config, suite) {
  const s = config.suites[suite] ?? {};
  return { skill: s.skill ?? suite, casesFolder: s.cases ?? suite };
}
