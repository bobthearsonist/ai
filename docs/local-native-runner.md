
## Fixtures

A case with `fixtures: true` gets `cases/<suite>/fixtures` copied into its eval `resources` dir and exposed read-only via `add_dirs`. Answers are graded on the reply text; no Write/Bash is granted. Skills are searched in `--skill-root` / `EVAL_SKILL_ROOT` (semicolon list).

## Speed

`cli.mjs run --concurrency N` (1-8, default 1) sets agent runs in flight. `node evals/local/run-all.mjs --concurrency 4 --approve-sessions 96` runs every suite in parallel processes. One 18-session suite takes ~42s at `--concurrency 6`.

## Case quality

- Cases may carry `samples: { pass: [], fail: [] }`; a unit test requires the graders to classify them as declared. Write samples from the skill's contract, never from live output.
- Runs with no final result (session ended after the skill loaded) are excluded from scores and counted as `invalidRuns`.
- `purpose: guard` cases (e.g. god-object) are expected to show no lift; they catch regressions, not value.

## Results, traces and verdicts

- Each case gets a `verdict` from per-run separation, not the mean alone: `lift` (every with-run beats every without-run), `regression` (reverse), `same` (|mean delta| < 0.05), `inconclusive` (overlap, typical at 3 runs), `unmeasured`. Prefer verdicts to `below_threshold`, which is uninformative because the pass threshold is 1.0.
- Per-run traces are copied to `.work/local-runs/<run>/traces/<case>/<arm>-<n>.jsonl` and the `claude-eval-*` temp dir is removed.
- Each `run` appends `.work/results/<suite>/<timestamp>.json` and updates `latest.json`; changes versus the previous latest print as `diff ...` lines. `run-all.mjs` also writes `.work/results/summary.md`.

## Using the harness from another repo

The engine lives in `ai/evals`; each repo owns its cases. Put `evals/evals.json` in the consuming repo (paths resolve relative to this file; CLI flags `--cases-dir`, `--skill-root`, `--output-dir`, `--results-dir` override it):

```json
{
  "casesDir": "cases",
  "skillsRoots": ["../skills"],
  "outputDir": ".work/local-runs",
  "resultsDir": ".work/results",
  "suites": { "my-suite": { "skill": "my-skill", "cases": "my-suite" } }
}
```

Run: `node <path-to-ai>/evals/local/cli.mjs run --config evals/evals.json --suite my-suite --approve-sessions N` (or `run-all.mjs --config ...`). `suites` is optional; without it a suite id equals both its cases folder and its skill name, and `run-all` discovers folders under `casesDir`. Case files may carry `"schemaVersion": 1`; other versions are rejected. Add `.work/` to the consuming repo's `.gitignore`.
