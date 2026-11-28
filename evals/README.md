# Skill evals (local, ACP)

Repository-owned cases for the shared [ai-evals engine](https://github.com/bobthearsonist/ai-evals). The development dependency pins the engine by commit; no engine implementation is duplicated here. Claude and Copilot use only ACP. OpenCode remains unsupported.

See [repository evaluation notes](../docs/skill-evaluations.md).
The [AI Guild onboarding page](docs/ai-guild-evals.html) explains the workflow,
current evidence and limitations; [Teams draft](docs/ai-guild-teams-blurb.md).

### Engine dependency

The current engine pin is `5334b851734fa94c308293bb9e85e4e1ed3a6626`.
It provides shared semantic assertion-table actions, aggregate 50/50 scoring,
direct suite judge scoring and parallel ACP sessions (up to `--concurrency`,
each reading the current Claude sign-in); no engine implementation is
duplicated here.

`package.json` pins `@bobthearsonist/ai-evals` to a commit on the engine's
repository, which provides multi-runner selection, Gherkin authoring, shared v2
assertions, ACP transport and separately approved AI judging. To pick up a newer
engine, update the commit in `package.json` and run `npm install`. To test
unreleased engine changes, temporarily point it at a local checkout
(`file:../../ai-evals`) and restore the pin before committing.

Native profiles use temporary homes, read-only tool lists, empty ambient MCP
configuration and a controlled workspace containing the selected skill only
in the with-skill arm. Claude refuses machine-managed settings; version or model
mismatches fail before prompting. Bounded Claude ACP candidate and judge
smokes have completed (see below); cross-client live acceptance remains pending.
Native/plugin-eval/SDK
execution and replay implementations have been deleted, with no transport
selector or fallback. Validation and dry-run planning
remain available without a live runtime.
For example, with both repositories under `C:\Repositories`:

```powershell
Set-Location C:\Repositories\ai\evals
npm ci --ignore-scripts
npm test
node local\cli.mjs validate --suite ai-repo-management
node local\cli.mjs run --suite ai-repo-management --dry-run
node local\cli.mjs run-all --dry-run
node local\cli.mjs preflight --client claude --model MODEL_ID
```

### AGENTS.md suite

`local/cases/agents-md` evaluates the repository's `AGENTS.md` (which every
client loads, `~/.claude/CLAUDE.md` included) as an engine *instructions suite*:
no skill is staged, the with arm gets `AGENTS.md` as the workspace project
instruction file, and the without arm gets either nothing or an earlier
version. Each case targets one rule a model without the file would plausibly
break, so a `lift` verdict is evidence the file itself does the work.

```sh
npm run eval:agents-md -- validate
npm run eval:agents-md -- run --dry-run                    # with vs no instructions
npm run eval:agents-md -- run --baseline HEAD --dry-run    # working tree vs last commit
npm run eval:agents-md -- run --baseline HEAD --model sonnet --approve-sessions 30
```

`--model` must be a name the pinned Claude ACP adapter advertises (`sonnet`,
`opus`, `haiku`, `fable`); a full ID such as `claude-sonnet-5-5` is refused
because the adapter cannot confirm it. Local runs sign in with your existing
Claude Code login (the macOS Keychain or `~/.claude/.credentials.json`); no
token needs exporting.

`--baseline REF` writes `AGENTS.md` at that commit to
`.work/baseline/AGENTS-<sha>.md` and passes it as `--baseline-instruction-file`.
Use it before and after editing a rule: add the case first, confirm it shows no
lift against the current file, then edit `AGENTS.md` and confirm the lift.
Claude only for now; scenario tags keep the shared grammar but add no
skill-trigger check.

**In GitHub Actions** (`.github/workflows/agents-md-evals.yml`), the suite runs
on pull requests to `main` and after pushes to `main`, whenever `AGENTS.md`,
`evals/` or the workflow changes; otherwise the job passes without running
anything. A pull request compares its `AGENTS.md` with the base branch's; a
push compares with the commit before it. `local/gate.mjs` then fails the job
when `shouldBlock` finds a `regression` verdict, an invalid run or an
unmeasured case, and writes the per-case table to the job summary. The run
archive is kept as the `agents-md-evals` artifact for 30 days. The job signs in
with the `CLAUDE_CODE_OAUTH_TOKEN` repository secret (from
`claude setup-token`), which fork pull requests never receive, so live evals
are skipped for them. Each run is 30 sessions on that token's Claude plan.

### Gherkin suites

All 11 cases across the two repository-owned suites, `agents-md` and
`ai-repo-management`, are authored in `.feature` files. Suites for skills that
live in the private `ai-private` repository are kept there, beside those skills.
Features compile to the engine's schema-v2 policy contract.
The per-case `*.samples.json` files hold offline pass/fail examples; samples are never sent
to the model. These JSON files are sample data, not test definitions.
JSON case definitions and schema-v1 case compatibility have been removed.
JSON config, sample sidecars and ACP archive formats remain supported.

Recorded-policy replay uses an ACP run's snapshot; applying current policy to
an ACP archive requires explicit `--policy current --suite NAME`
and writes a separate assessment. Native archives are no longer supported.

AI judging is a separate `judge` command with an explicit runtime, model,
recorded Gherkin criteria and exact session approval. It never contributes to deterministic
scores. Both clients use only ACP and refuse native runtimes whose
required isolation cannot be established. Transport success alone is not
evidence of skill/MCP isolation.

### Semantic judge adoption and opt-in scoring

`And the AI judge verifies:` tables use the shared `id`, `action`, and
`expectation` columns to compile each semantic requirement as an independent
criterion. Two positive Gherkin scenarios carry them: repository-change
delivery (`edit-through-link`) and the memory-store write rule
(`memory-store-direct-write`). Identifiers, negative controls, skill activation
and disclosure patterns remain deterministic. Existing regex proxies are
retained for historical comparison, **not treated as a semantic verdict**.
Semantic judgments contribute to separate combined scores, not deterministic history.

Selection was informed by a prior evaluation investigation: correct answers failed on paraphrases
such as "shouldn't postpone" versus "don't block", "quietly" versus "silent",
and reasons outside a 150-character window. The rubrics accept equivalent
reasoning throughout the answer rather than expanding patterns to fit saved
outputs. Rubrics are authored criteria, not measured
judge accuracy, and existing regex samples do not establish semantic accuracy.

For an ACP archive from one of these suites, plan eligible assessments without
inference (replace `<run>` and `MODEL_ID`):

```powershell
npx --no-install ai-evals judge .work\local-runs\<run> --client claude --model MODEL_ID --dry-run
npx --no-install ai-evals report .work\local-runs\<run> --answer
```

The archived Gherkin policy selects semantic case IDs; other answers are explicitly
skipped. A bounded candidate smoke with one Claude `haiku` judge session per
judged case, run on 2026-10-23, exercised the archive-to-judge path: every
assessment passed strict schema and exact-quote validation and was stored
separately with input and rubric hashes, with no retries.

Per-check regrading of that archive showed that most `below_threshold`
results came from `skill-trigger`: `edit-through-link` and several other
cases answered without invoking the skill. Those are genuine trigger misses,
so a semantic pass on such a run reflects the base model, not skill content.
`report RUN_DIR` prints per-check results and Skill calls directly.

Tooling that redacts secrets in its display can silently rewrite what you
think a prompt says. Check the bytes of a case file, not the rendered view,
before authoring a rubric or sample from it.

This bounded run verifies the exercised Claude/Haiku archive-to-judge path,
not judge accuracy, calibration, general skill quality, or cross-provider
equivalence. The built-in judge profile is Claude-only; unsupported runtimes
and active machine-managed policy fail closed.

The top-level engine [JUDGE_PROMPT.md](https://github.com/bobthearsonist/ai-evals/blob/main/JUDGE_PROMPT.md)
is the actual packaged runtime prompt. It requires an independent verdict for
each criterion, accepts equivalent reasoning, and treats partial satisfaction
as failure. Pass/fail evidence must quote the captured answer exactly.

### Semantic scoring

The engine's [semantic scoring procedure](https://github.com/bobthearsonist/ai-evals#semantic-scoring)
is canonical. `judge RUN_DIR --client claude --model MODEL_ID` uses recorded
suite assertions and writes a separate combined score automatically: 50%
existing deterministic score and 50% whole-answer semantic verdict. All
semantic criteria must pass; criterion results remain diagnostic, independent
of row count. No labeled-answer acceptance artifact is required.

Use `--dry-run` first and approve the exact live session count separately.
Missing, invalid, abstaining, duplicate or mismatched assessments make affected
scores null. Prompt, policy, answer, runtime, model and settings provenance are
still checked. Original deterministic results and history never change.
The standalone `--rubric` compatibility path remains assessment-only.
Scoring measures the recorded assertions; it does not establish judge accuracy.

Historical measurements and frozen inputs remain in the [historical evidence archive](calibration/). They are not prerequisites for current scoring.

### Installed dependency

```powershell
npm ci --ignore-scripts
npm test
node local/cli.mjs preflight --client claude --model MODEL_ID
node local/cli.mjs run --suite ai-repo-management --model MODEL_ID --dry-run
node local/run-all.mjs
```

Run these commands from `evals`. `evals.json` resolves cases, skill roots and outputs relative to this directory; the thin wrappers supply its absolute path, so they also work when invoked from elsewhere. `cli.mjs` defaults to the `ai-repo-management` suite except for `run-all`, which discovers all suites unless explicitly narrowed, and
`judge`, which reads the archived policy without injecting a suite. `run-all` prints the required session approval before any live execution. Preflight checks existing credentials without inference or login; it does not prove provider access. A live run requires a separately approved explicit model and exact session count.

Suites live in `local/cases/<skill>/*.feature`, with offline samples in
`*.samples.json`; fixtures and `.work` artifacts remain here. Tests validate
all 11 case IDs, require Gherkin definitions and check every offline sample
against the selected engine. Engine tests live in `ai-evals`.
Current results are labelled `acp-non-hermetic`; historical native results are
unsupported. Historical local run archives and one-off probe scripts have been
deleted; fresh runs and assessments require separate explicit approval.
