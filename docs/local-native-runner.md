
## Fixtures

A case with `fixtures: true` gets `cases/<suite>/fixtures` copied into its eval `resources` dir and exposed read-only via `add_dirs`. Answers are graded on the reply text; no Write/Bash is granted. Skills are searched in `--skill-root` / `EVAL_SKILL_ROOT` (semicolon list).

## Speed

`cli.mjs run --concurrency N` (1-8, default 1) sets agent runs in flight. `node evals/local/run-all.mjs --concurrency 4 --approve-sessions 96` runs every suite in parallel processes. One 18-session suite takes ~42s at `--concurrency 6`.

## Case quality

- Cases may carry `samples: { pass: [], fail: [] }`; a unit test requires the graders to classify them as declared. Write samples from the skill's contract, never from live output.
- Runs with no final result (session ended after the skill loaded) are excluded from scores and counted as `invalidRuns`.
- `purpose: guard` cases (e.g. god-object) are expected to show no lift; they catch regressions, not value.
