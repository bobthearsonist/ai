# Repository-owned skill evaluations

The shared engine lives in [ai-evals](https://github.com/bobthearsonist/ai-evals);
`evals/package.json` pins its immutable Git revision. Run `npm ci` in `evals`
before using the local wrappers. Cases, fixtures and `.work` outputs stay here.

All 22 repository-owned cases now use Gherkin. The current dependency pin
cannot parse them: use the unreleased engine checkout as described in the
[evals README](../evals/README.md#unreleased-engine-checkout). The development
engine routes Claude and Copilot exclusively through ACP; native candidate profiles refuse
execution until required skill/MCP isolation can be verified. Historical native
smoke results are not acceptance evidence for ACP. Native execution and replay
code is deleted; old archives remain unchanged but cannot be regraded by the
development engine.

## Fixtures

A scenario with `Given the suite fixtures are available` uses the suite's
`fixtures` directory; `{{fixtures}}` in the prompt resolves to its staged path.
The runner must enforce its advertised filesystem/tool capabilities before
execution. Skills are searched in `--skill-root` / `EVAL_SKILL_ROOT`
(semicolon list).

## Speed

`cli.mjs run --concurrency N` (1-8, default 1) sets sessions in flight.
The limit is global: suite/runner pairs are serial, not parallel processes.
Use `--dry-run` to inspect all planned sessions without launching a client.

## Case quality

- Every Gherkin case has a `*.samples.json` sidecar with `caseId`, `pass` and
  `fail`; a unit test requires the graders to classify them as declared.
  Samples are never sent to the model. Write them from the skill's contract,
  never from live output.
- Runs with no final result (session ended after the skill loaded) are excluded from scores and counted as `invalidRuns`.
- Guard cases (e.g. the comment above the god-object scenario) are expected to
  show no lift; they catch regressions, not value.

## Results, traces and verdicts

- Each case gets a `verdict` from per-run separation, not the mean alone: `lift` (every with-run beats every without-run), `regression` (reverse), `same` (|mean delta| < 0.05), `inconclusive` (overlap, typical at 3 runs), `unmeasured`. Prefer verdicts to `below_threshold`, which is uninformative because the pass threshold is 1.0.
- ACP evidence is archived under `.work/local-runs/<run>` for deterministic replay.
- Each `run` appends `.work/results/acp/<suite>/<timestamp>.json` and updates `latest.json` in that suite directory; changes versus the previous latest print as `diff ...` lines. `run-all.mjs` also writes `.work/results/summary.md`. Native history is not overwritten or compared with ACP results.

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

Run: `npx --no-install ai-evals run --config evals/evals.json --suite my-suite --approve-sessions N`
(or `ai-evals run-all --config ...`) with an engine version that supports these
suites. `suites` is optional; without it a suite id equals both its cases
folder and its skill name, and `run-all` discovers folders under `casesDir`.
Author `.feature` scenarios using the engine's controlled vocabulary; they
compile to v2 checks. JSON v1/v2 loading remains for compatibility, not as the
repository's authoring format. Add `evals/.work/` and `node_modules/` to the
consuming repo's `.gitignore`.
