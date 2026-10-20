# Repository-owned skill evaluations

The shared engine lives in [ai-evals](https://github.com/bobthearsonist/ai-evals);
`evals/package.json` pins its immutable Git revision. Run `npm ci` in `evals`
before using the local wrappers. Cases, fixtures and `.work` outputs stay here.

## Fixtures

A case with `fixtures: true` gets `cases/<suite>/fixtures` copied into its eval `resources` dir and exposed read-only via `add_dirs`. Answers are graded on the reply text; no Write/Bash is granted. Skills are searched in `--skill-root` / `EVAL_SKILL_ROOT` (semicolon list).

## Speed

`cli.mjs run --concurrency N` (1-8, default 1) sets agent runs in flight. `node evals/local/run-all.mjs --concurrency 4` prints the approval count needed to run every suite in parallel processes. One 18-session suite takes ~42s at `--concurrency 6`.

## Case quality

- Cases may carry `samples: { pass: [], fail: [] }`; a unit test requires the graders to classify them as declared. Write samples from the skill's contract, never from live output.
- Runs with no final result (session ended after the skill loaded) are excluded from scores and counted as `invalidRuns`.
- `purpose: guard` cases (e.g. god-object) are expected to show no lift; they catch regressions, not value.

## Results, traces and verdicts

- Each case gets a `verdict` from per-run separation, not the mean alone: `lift` (every with-run beats every without-run), `regression` (reverse), `same` (|mean delta| < 0.05), `inconclusive` (overlap, typical at 3 runs), `unmeasured`. Prefer verdicts to `below_threshold`, which is uninformative because the pass threshold is 1.0.
- Per-run traces are copied to `.work/local-runs/<run>/traces/<case>/<arm>-<n>.jsonl` and the `claude-eval-*` temp dir is removed.
- Each `run` appends `.work/results/<suite>/<timestamp>.json` and updates `latest.json`; changes versus the previous latest print as `diff ...` lines. `run-all.mjs` also writes `.work/results/summary.md`.

## Using the harness from another repo

Install the public `@bobthearsonist/ai-evals` Git dependency over HTTPS in the consuming repo (see the engine README), then put `evals/evals.json` alongside that repo's cases. Paths resolve relative to this file; CLI flags `--cases-dir`, `--skill-root`, `--output-dir`, `--results-dir` override it:

```json
{
  "casesDir": "cases",
  "skillsRoots": ["../skills"],
  "outputDir": ".work/local-runs",
  "resultsDir": ".work/results",
  "suites": { "my-suite": { "skill": "my-skill", "cases": "my-suite" } }
}
```

Run: `npx --no-install ai-evals run --config evals/evals.json --suite my-suite --approve-sessions N` (or `ai-evals run-all --config ...`). `suites` is optional; without it a suite id equals both its cases folder and its skill name, and `run-all` discovers folders under `casesDir`. Case files may carry `"schemaVersion": 1`; other versions are rejected. Add `evals/.work/` and `node_modules/` to the consuming repo's `.gitignore`.
